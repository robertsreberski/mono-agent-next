import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { embed } from "@yarflam/potion-base-8m";
import GithubSlugger from "github-slugger";

import {
  assertUniqueDocumentLocations,
  closesMarkdownFence,
  findDocumentByLogicalPath,
  markdownLinks,
  normalizeRoute,
  parseMarkdownFence,
  safeDecode,
} from "../src/markdown-helpers.js";

const MODEL_DIMENSIONS = 256;
const MODEL_VERSION = "1.0.4";
const CHUNKER_VERSION = "markdown-blocks-v2";
const MAX_CHUNK_CHARACTERS = 1_200;
const MAX_OVERLAP_CHARACTERS = 200;
const DOCS_ORIGIN = "https://mono-agent-docs.vercel.app";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const buildPaths = parseBuildPaths(process.argv.slice(2));
const outputDirectory = buildPaths.outputDirectory;

const sources = await collectSources(buildPaths.docsRoot);
const sourceHash = createHash("sha256");
const documents = [];
const chunks = [];
for (const source of sources) {
  sourceHash.update(source.path).update("\0").update(source.markdown).update("\0");
  const { document, blocks } = parseDocument(source);
  documents.push(document);
  chunks.push(...chunkDocument(document, blocks));
}
assertUniqueIds("document", documents);
assertUniqueIds("chunk", chunks);
assertUniqueDocumentLocations(documents);
validateInternalLinks(documents);

const embeddings = [];
for (let offset = 0; offset < chunks.length; offset += 128) {
  const batch = chunks.slice(offset, offset + 128);
  const vectors = await embed(batch.map((chunk) => chunk.embeddingText));
  embeddings.push(...vectors);
}
if (embeddings.length !== chunks.length) {
  throw new Error(`Embedding count mismatch: chunks=${chunks.length}, embeddings=${embeddings.length}.`);
}

const embeddingBytes = Buffer.alloc(chunks.length * MODEL_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT);
for (let chunkIndex = 0; chunkIndex < embeddings.length; chunkIndex += 1) {
  const vector = embeddings[chunkIndex];
  if (!(vector instanceof Float32Array) || vector.length !== MODEL_DIMENSIONS) {
    throw new Error(`Embedding ${chunkIndex} must be a ${MODEL_DIMENSIONS}-dimension Float32Array.`);
  }
  for (let dimension = 0; dimension < MODEL_DIMENSIONS; dimension += 1) {
    const value = vector[dimension];
    if (!Number.isFinite(value)) {
      throw new Error(`Embedding ${chunkIndex}:${dimension} is not finite.`);
    }
    const byteOffset = ((chunkIndex * MODEL_DIMENSIONS) + dimension) * Float32Array.BYTES_PER_ELEMENT;
    embeddingBytes.writeFloatLE(value, byteOffset);
  }
}

const documentsBytes = Buffer.from(`${JSON.stringify(documents)}\n`, "utf8");
const chunksBytes = Buffer.from(`${JSON.stringify(chunks)}\n`, "utf8");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const documentsSha256 = sha256(documentsBytes);
const chunksSha256 = sha256(chunksBytes);
const embeddingsSha256 = sha256(embeddingBytes);
const manifest = {
  schema: "mono-agent.docs-corpus.v2",
  docsVersion: packageJson.version,
  sourceDigest: sourceHash.digest("hex"),
  corpusDigest: createHash("sha256")
    .update(documentsBytes)
    .update(chunksBytes)
    .update(embeddingBytes)
    .digest("hex"),
  chunkerVersion: CHUNKER_VERSION,
  documentCount: documents.length,
  chunkCount: chunks.length,
  model: {
    package: "@yarflam/potion-base-8m",
    version: MODEL_VERSION,
    id: "minishlab/potion-base-8M",
    dimensions: MODEL_DIMENSIONS,
  },
  artifacts: {
    documentsSha256,
    chunksSha256,
    embeddingsSha256,
    byteOrder: "little-endian",
  },
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(join(outputDirectory, "documents.json"), documentsBytes),
  writeFile(join(outputDirectory, "chunks.json"), chunksBytes),
  writeFile(join(outputDirectory, "embeddings.f32"), embeddingBytes),
  writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
]);
process.stderr.write(
  `Generated ${documents.length} documents and ${chunks.length} mono-agent documentation chunks (${manifest.corpusDigest.slice(0, 12)}).\n`,
);

async function collectSources(docsRoot) {
  const docsFiles = (await walkMarkdown(docsRoot))
    .filter((path) => {
      const firstSegment = relative(docsRoot, path).split(sep)[0];
      return firstSegment !== "skills" && firstSegment !== "superpowers";
    })
    .map((path) => ({ path, source: "docs" }));

  const records = [];
  for (const record of docsFiles.sort((left, right) => left.path.localeCompare(right.path))) {
    const markdown = await readFile(record.path, "utf8");
    const logicalPath = `docs/${toPosixPath(relative(docsRoot, record.path))}`;
    records.push({
      source: "docs",
      path: logicalPath,
      markdown,
      route: docsRoute(logicalPath),
      canonicalUrl: canonicalDocsUrl(logicalPath),
    });
  }
  return records;
}

function parseBuildPaths(args) {
  const result = {
    docsRoot: join(repositoryRoot, "docs"),
    outputDirectory: join(packageRoot, "dist", "corpus"),
  };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("Usage: generate-corpus.mjs [--docs-root <path>] [--output-directory <path>]");
    }
    if (flag === "--docs-root") result.docsRoot = resolve(value);
    else if (flag === "--output-directory") result.outputDirectory = resolve(value);
    else throw new Error(`Unknown generate-corpus option ${flag}.`);
  }
  return result;
}

async function walkMarkdown(root) {
  const paths = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      paths.push(...await walkMarkdown(path));
    } else if (entry.isFile() && [".md", ".mdx"].includes(extname(entry.name))) {
      paths.push(path);
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

function parseDocument(source) {
  const markdown = stripFrontmatter(source.markdown).replace(/\r\n?/gu, "\n").trim();
  const slugger = new GithubSlugger();
  const headingPath = [];
  const headings = [];
  const blocks = [];
  const units = [];
  let title;
  let currentAnchor;
  let blockStart;
  let blockHeadingPath = [];
  let blockAnchor;
  let fenceMarker;

  const flushBlock = (endOffset, kind = "block") => {
    if (blockStart === undefined) return;
    const raw = markdown.slice(blockStart, endOffset);
    const leading = raw.search(/\S/u);
    const trailing = raw.search(/\s*$/u);
    if (leading !== -1 && trailing > leading) {
      const startOffset = blockStart + leading;
      const adjustedEnd = blockStart + trailing;
      blocks.push({
        headingPath: [...blockHeadingPath],
        ...(blockAnchor === undefined ? {} : { anchor: blockAnchor }),
        text: markdown.slice(startOffset, adjustedEnd),
        startOffset,
        endOffset: adjustedEnd,
      });
      units.push({ kind, startOffset, endOffset: adjustedEnd });
    }
    blockStart = undefined;
  };

  for (const line of markdownLines(markdown)) {
    const fence = parseMarkdownFence(line.text);
    if (fenceMarker !== undefined) {
      if (fence !== undefined && closesMarkdownFence(fence, fenceMarker)) {
        flushBlock(line.endOffset, "fence");
        fenceMarker = undefined;
      }
      continue;
    }
    if (fence !== undefined) {
      flushBlock(line.startOffset);
      fenceMarker = fence.marker;
      blockStart = line.startOffset;
      blockHeadingPath = [...headingPath];
      blockAnchor = currentAnchor;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line.text);
    if (heading !== null) {
      flushBlock(line.startOffset);
      const level = heading[1].length;
      const text = heading[2].trim();
      const anchor = slugger.slug(headingText(text));
      if (level === 1 && title === undefined) title = headingText(text);
      if (level >= 2) {
        headingPath.length = level - 2;
        headingPath[level - 2] = headingText(text);
        currentAnchor = anchor;
      } else {
        headingPath.length = 0;
        currentAnchor = undefined;
      }
      headings.push({
        level,
        text: headingText(text),
        anchor,
        headingPath: [...headingPath],
        startOffset: line.startOffset,
        endOffset: markdown.length,
      });
      units.push({ kind: "heading", startOffset: line.startOffset, endOffset: line.endOffset });
      continue;
    }
    if (line.text.trim().length === 0) {
      flushBlock(line.startOffset);
    } else if (blockStart === undefined) {
      blockStart = line.startOffset;
      blockHeadingPath = [...headingPath];
      blockAnchor = currentAnchor;
    }
  }
  flushBlock(markdown.length, fenceMarker === undefined ? "block" : "fence");

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    heading.endOffset = next?.startOffset ?? markdown.length;
  }

  const document = {
    id: createHash("sha256").update(source.source).update("\0").update(source.path).digest("hex"),
    source: source.source,
    path: source.path,
    title: title ?? humanizeFilename(source.path),
    ...(source.route === undefined ? {} : { route: source.route }),
    ...(source.canonicalUrl === undefined ? {} : { canonicalUrl: source.canonicalUrl }),
    markdown,
    headings,
    units: units.sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset),
  };
  return { document, blocks };
}

function chunkDocument(document, blocks) {
  const chunks = [];
  let current;
  for (const block of blocks) {
    for (const segment of splitOversizedBlock(block)) {
      const headingKey = block.headingPath.join("\0");
      if (current === undefined || current.headingKey !== headingKey || joinedLength(current.parts, segment.text) > MAX_CHUNK_CHARACTERS) {
        if (current !== undefined) chunks.push(finalizeChunk(document, current));
        const overlap = current === undefined || current.headingKey !== headingKey
          ? ""
          : overlapTail(current.parts.join("\n\n"), segment.text.length);
        current = {
          headingKey,
          headingPath: block.headingPath,
          ...(block.anchor === undefined ? {} : { anchor: block.anchor }),
          parts: overlap.length === 0 ? [segment.text] : [overlap, segment.text],
          startOffset: segment.startOffset,
          endOffset: segment.endOffset,
        };
      } else {
        current.parts.push(segment.text);
        current.endOffset = segment.endOffset;
      }
    }
  }
  if (current !== undefined) chunks.push(finalizeChunk(document, current));
  return chunks;
}

function splitOversizedBlock(block) {
  if (block.text.length <= MAX_CHUNK_CHARACTERS) return [block];
  const lines = block.text.split("\n");
  const openingFence = parseMarkdownFence(lines[0] ?? "");
  const closingLine = openingFence === undefined ? undefined : lines.at(-1);
  const closingFence = closingLine === undefined ? undefined : parseMarkdownFence(closingLine);
  const hasClosingFence = openingFence !== undefined
    && closingFence !== undefined
    && closesMarkdownFence(closingFence, openingFence.marker);
  if (openingFence !== undefined && hasClosingFence) {
    const openingLine = lines[0];
    const bodyStart = block.startOffset + openingLine.length + 1;
    const body = lines.slice(1, -1).join("\n");
    const payloadLimit = Math.max(200, MAX_CHUNK_CHARACTERS - openingLine.length - closingLine.length - 2);
    return splitPlainText(body, bodyStart, payloadLimit).map((segment) => ({
      ...block,
      text: `${openingLine}\n${segment.text}\n${closingLine}`,
      startOffset: segment.startOffset,
      endOffset: segment.endOffset,
    }));
  }
  return splitPlainText(block.text, block.startOffset, MAX_CHUNK_CHARACTERS).map((segment) => ({ ...block, ...segment }));
}

function splitPlainText(text, baseOffset, limit) {
  const segments = [];
  let remaining = text;
  let consumed = 0;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const boundary = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const splitAt = boundary >= Math.floor(limit * 0.6) ? boundary : limit;
    const raw = remaining.slice(0, splitAt);
    const leading = raw.search(/\S/u);
    const trailing = raw.search(/\s*$/u);
    if (leading !== -1 && trailing > leading) {
      segments.push({
        text: raw.slice(leading, trailing),
        startOffset: baseOffset + consumed + leading,
        endOffset: baseOffset + consumed + trailing,
      });
    }
    remaining = remaining.slice(splitAt);
    consumed += splitAt;
  }
  const leading = remaining.search(/\S/u);
  const trailing = remaining.search(/\s*$/u);
  if (leading !== -1 && trailing > leading) {
    segments.push({
      text: remaining.slice(leading, trailing),
      startOffset: baseOffset + consumed + leading,
      endOffset: baseOffset + consumed + trailing,
    });
  }
  return segments;
}

function finalizeChunk(document, current) {
  const text = current.parts.join("\n\n");
  const id = createHash("sha256")
    .update(document.source).update("\0")
    .update(document.path).update("\0")
    .update(current.headingPath.join("\0")).update("\0")
    .update(text)
    .digest("hex");
  return {
    id,
    documentId: document.id,
    source: document.source,
    path: document.path,
    title: document.title,
    headingPath: current.headingPath,
    ...(current.anchor === undefined ? {} : { anchor: current.anchor }),
    ...(document.canonicalUrl === undefined ? {} : { canonicalUrl: document.canonicalUrl }),
    startOffset: current.startOffset,
    endOffset: current.endOffset,
    text,
    embeddingText: [document.title, current.headingPath.join(" > "), text].filter(Boolean).join("\n"),
  };
}

function validateInternalLinks(documents) {
  const maps = documentMaps(documents);
  let validated = 0;
  for (const document of documents) {
    for (const link of markdownLinks(document.markdown)) {
      const resolution = resolveLink(document, link.href, maps);
      if (resolution.kind === "broken") {
        throw new Error(`Broken internal documentation link in ${document.path}: ${link.href} (${resolution.reason}).`);
      }
      if (resolution.kind === "resolved") validated += 1;
    }
  }
  process.stderr.write(`Validated ${validated} internal documentation links.\n`);
}

function documentMaps(documents) {
  const byPath = new Map(documents.map((document) => [document.path, document]));
  const byRoute = new Map();
  for (const document of documents) {
    if (document.route !== undefined) {
      byRoute.set(normalizeRoute(document.route), document);
    }
  }
  return { byPath, byRoute };
}

function resolveLink(source, href, maps) {
  if (href.length === 0 || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("data:")) {
    return { kind: "external" };
  }
  const [rawPath, rawFragment = ""] = href.split("#", 2);
  const fragment = safeDecode(rawFragment);
  let target;

  if (rawPath.length === 0) {
    target = source;
  } else if (/^https?:\/\//u.test(rawPath)) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return { kind: "external" };
    }
    if (url.origin !== DOCS_ORIGIN) return { kind: "external" };
    target = maps.byRoute.get(normalizeRoute(url.pathname));
    if (target === undefined) return { kind: "broken", reason: `unknown docs route ${url.pathname}` };
  } else if (/^[a-z][a-z0-9+.-]*:/iu.test(rawPath)) {
    return { kind: "external" };
  } else if (rawPath.startsWith("/")) {
    target = maps.byRoute.get(normalizeRoute(rawPath));
    if (target === undefined) return { kind: "broken", reason: `unknown docs route ${rawPath}` };
  } else {
    const logicalPath = posix.normalize(posix.join(posix.dirname(source.path), safeDecode(rawPath)));
    target = findDocumentByLogicalPath(logicalPath, maps.byPath);
    if (target === undefined && source.source === "docs") {
      const base = new URL(source.route, `${DOCS_ORIGIN}/`);
      const resolved = new URL(rawPath, base);
      target = maps.byRoute.get(normalizeRoute(resolved.pathname));
    }
    if (target === undefined) {
      const remainsInsideCorpus = logicalPath.startsWith(`${source.source}/`);
      return remainsInsideCorpus
        ? { kind: "broken", reason: `unknown corpus path ${logicalPath}` }
        : { kind: "external" };
    }
  }

  if (fragment.length > 0 && !target.headings.some((heading) => heading.anchor === fragment)) {
    return { kind: "broken", reason: `unknown heading #${fragment} in ${target.path}` };
  }
  return { kind: "resolved", document: target, fragment };
}

function markdownLines(markdown) {
  const lines = [];
  let startOffset = 0;
  while (startOffset < markdown.length) {
    const newline = markdown.indexOf("\n", startOffset);
    const endOffset = newline === -1 ? markdown.length : newline + 1;
    lines.push({
      text: markdown.slice(startOffset, newline === -1 ? markdown.length : newline),
      startOffset,
      endOffset,
    });
    startOffset = endOffset;
  }
  return lines;
}

function headingText(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, "")
    .replace(/[`*_~]/gu, "")
    .trim();
}

function docsRoute(logicalPath) {
  let route = logicalPath.replace(/^docs\//u, "").replace(/\.(?:md|mdx)$/u, "");
  route = route.replace(/(?:^|\/)index$/u, "");
  return `/${route.length === 0 ? "" : `${route}/`}`;
}

function canonicalDocsUrl(logicalPath) {
  return `${DOCS_ORIGIN}${docsRoute(logicalPath)}`;
}

function joinedLength(parts, next) {
  return parts.reduce((sum, part) => sum + part.length, 0) + (parts.length * 2) + next.length;
}

function overlapTail(previous, nextLength) {
  const available = MAX_CHUNK_CHARACTERS - nextLength - 2;
  if (available < 40) return "";
  const tailLength = Math.min(MAX_OVERLAP_CHARACTERS, available, previous.length);
  const rawTail = previous.slice(-tailLength);
  const firstWhitespace = rawTail.search(/\s/u);
  return (firstWhitespace === -1 ? rawTail : rawTail.slice(firstWhitespace + 1)).trim();
}

function stripFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) return markdown;
  const end = markdown.indexOf("\n---\n", 4);
  return end === -1 ? markdown : markdown.slice(end + 5);
}

function humanizeFilename(path) {
  return basename(path, extname(path)).replace(/[-_]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function assertUniqueIds(kind, records) {
  const ids = new Set();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`Duplicate documentation ${kind} id ${record.id}.`);
    ids.add(record.id);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function toPosixPath(path) {
  return path.split(sep).join("/");
}
