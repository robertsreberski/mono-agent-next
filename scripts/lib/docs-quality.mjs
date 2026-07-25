// SPDX-License-Identifier: MIT
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { parse as parseYaml } from "yaml";

const GENERIC_LINK_LABELS = new Set([
  "click here",
  "here",
  "learn more",
  "link",
  "more",
  "read more",
  "this",
]);

const PACKAGE_ADJACENT_DOCS = new Set(["ARCHITECTURE.md", "MIGRATION.md"]);
const FIRST_PARTY_DOCUMENTATION_HOST = "mono-agent-docs.vercel.app";
const FIRST_PARTY_GITHUB_PATH = /^\/robertsreberski\/mono-agent\/(blob|tree)\/main\/(.+)$/u;
const OBSOLETE_DOCUMENTATION_HOSTS = new Map([
  ["mono-agent.dev", "mono-agent-docs.vercel.app"],
]);

export function collectPublicMarkdownFiles(root) {
  const files = [];
  walk(root, (absolutePath) => {
    const repositoryPath = toRepositoryPath(root, absolutePath);
    const fileName = basename(absolutePath);
    if (fileName === "README.md"
      || repositoryPath === "PACKAGES.md"
      || repositoryPath.startsWith("docs/") && extname(fileName) === ".md"
      || PACKAGE_ADJACENT_DOCS.has(fileName)
        && (repositoryPath.startsWith("packages/") || repositoryPath.startsWith("extras/"))) {
      files.push(repositoryPath);
    }
  });
  return files.sort(compareText);
}

export function findDocumentationErrors({ root, files = collectPublicMarkdownFiles(root) }) {
  const errors = [];
  const contents = new Map();

  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    contents.set(file, text);
    errors.push(...checkMarkdownDocument({ file, text }));
  }

  for (const [file, text] of contents) {
    errors.push(...checkLocalLinks({ root, file, text, contents }));
  }

  return errors;
}

export function checkMarkdownDocument({ file, text }) {
  const errors = [];
  const isCanonicalDoc = file.startsWith("docs/");
  const parsed = parseFrontmatter(text);
  let markdown = text;
  let lineOffset = 0;

  if (isCanonicalDoc) {
    if (parsed === undefined) {
      errors.push(`${file}:1 canonical docs must start with YAML frontmatter.`);
    } else {
      markdown = parsed.body;
      lineOffset = parsed.lineCount;
      try {
        const data = parseYaml(parsed.source);
        if (!isNonEmptyString(data?.title)) {
          errors.push(`${file}:1 frontmatter must include a non-empty title.`);
        }
        if (!isNonEmptyString(data?.description)) {
          errors.push(`${file}:1 frontmatter must include a non-empty description.`);
        }
      } catch (error) {
        errors.push(`${file}:1 invalid YAML frontmatter: ${reasonOf(error)}`);
      }
    }
  }

  const scan = scanMarkdown(markdown, lineOffset);
  const levelOneHeadings = scan.headings.filter((heading) => heading.level === 1);
  if (isCanonicalDoc) {
    for (const heading of levelOneHeadings) {
      errors.push(`${file}:${heading.line} canonical docs use the frontmatter title as the page H1; remove the Markdown H1.`);
    }
  } else if (levelOneHeadings.length !== 1) {
    errors.push(`${file}: expected exactly one H1, found ${levelOneHeadings.length}.`);
  }

  let previousHeadingLevel = isCanonicalDoc ? 1 : 0;
  for (const heading of scan.headings) {
    if (heading.level > previousHeadingLevel + 1) {
      errors.push(`${file}:${heading.line} heading level skips from H${previousHeadingLevel} to H${heading.level}.`);
    }
    previousHeadingLevel = heading.level;
  }

  for (const fence of scan.fences) {
    if (!fence.closed) {
      errors.push(`${file}:${fence.line} fenced code block is not closed.`);
    }
    if (!fence.language) {
      errors.push(`${file}:${fence.line} fenced code blocks must declare a language (use \`text\` for plain output).`);
    }
    if (fence.language === "mermaid" && !hasDiagramSummary(scan.lines, fence.localLine)) {
      errors.push(`${file}:${fence.line} Mermaid diagrams need a visible \`**Diagram summary:**\` immediately before the diagram.`);
    }
  }

  for (const link of scan.links) {
    const normalizedLabel = stripInlineMarkdown(link.label).trim().toLowerCase();
    if (link.image && normalizedLabel.length === 0) {
      errors.push(`${file}:${link.line} images must have meaningful alternative text.`);
    } else if (!link.image && (normalizedLabel.length === 0 || GENERIC_LINK_LABELS.has(normalizedLabel))) {
      errors.push(`${file}:${link.line} link text \`${link.label}\` is not descriptive.`);
    }
    const obsoleteHost = obsoleteDocumentationHost(link.destination);
    if (obsoleteHost !== undefined) {
      errors.push(`${file}:${link.line} documentation links must use \`${obsoleteHost.replacement}\`, not obsolete host \`${obsoleteHost.host}\`.`);
    }
  }
  for (const reference of scan.unresolvedReferences) {
    errors.push(`${file}:${reference.line} reference link \`${reference.id}\` has no definition.`);
  }
  if (scan.unclosedHtmlCommentLine !== undefined) {
    errors.push(`${file}:${scan.unclosedHtmlCommentLine} HTML comment is not closed.`);
  }

  errors.push(...findTableErrors(file, scan.lines, lineOffset));
  return errors;
}

function obsoleteDocumentationHost(destination) {
  try {
    const url = new URL(destination);
    const replacement = OBSOLETE_DOCUMENTATION_HOSTS.get(url.hostname);
    return replacement === undefined ? undefined : { host: url.hostname, replacement };
  } catch {
    return undefined;
  }
}

export function scanMarkdown(text, lineOffset = 0) {
  const lines = text.split(/\r?\n/u);
  const headings = [];
  const fences = [];
  const links = [];
  const referenceDefinitions = new Map();
  const referenceUses = [];
  let activeFence;
  const htmlCommentState = { active: false, startLine: undefined };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1 + lineOffset;
    if (activeFence !== undefined) {
      if (new RegExp(`^\\s*${escapeRegExp(activeFence.marker)}{${activeFence.length},}\\s*$`, "u").test(line)) {
        activeFence.fence.closed = true;
        activeFence = undefined;
      }
      continue;
    }

    const fenceMatch = /^\s*(`{3,}|~{3,})([^`]*)$/u.exec(line);
    if (fenceMatch !== null) {
      const info = fenceMatch[2].trim();
      const language = info.split(/\s+/u)[0]?.replace(/^\{\.?|\}$/gu, "").toLowerCase() ?? "";
      const fence = { line: lineNumber, localLine: index, language, closed: false };
      activeFence = { marker: fenceMatch[1][0], length: fenceMatch[1].length, fence };
      fences.push(fence);
      continue;
    }

    const visibleLine = stripHtmlComments(line, htmlCommentState, lineNumber);

    const headingMatch = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(visibleLine);
    if (headingMatch !== null) {
      headings.push({ level: headingMatch[1].length, text: headingMatch[2], line: lineNumber });
    }

    const definition = /^\s{0,3}\[([^\]]+)\]:\s*(<[^>]+>|\S+)/u.exec(visibleLine);
    if (definition !== null) {
      referenceDefinitions.set(normalizeReferenceId(definition[1]), definition[2].replace(/^<|>$/gu, ""));
    }
    for (const link of markdownLinks(visibleLine)) {
      links.push({ ...link, line: lineNumber });
    }
    for (const reference of markdownReferenceLinks(visibleLine)) {
      referenceUses.push({ ...reference, line: lineNumber });
    }
  }

  const unresolvedReferences = [];
  for (const reference of referenceUses) {
    const destination = referenceDefinitions.get(normalizeReferenceId(reference.id));
    if (destination === undefined) unresolvedReferences.push(reference);
    else links.push({ image: reference.image, label: reference.label, destination, line: reference.line });
  }

  return {
    lines,
    headings,
    fences,
    links,
    unresolvedReferences,
    unclosedHtmlCommentLine: htmlCommentState.active ? htmlCommentState.startLine : undefined,
  };
}

function checkLocalLinks({ root, file, text, contents }) {
  const errors = [];
  const parsed = frontmatterBody(text);
  const links = scanMarkdown(parsed.body, parsed.lineCount).links;
  for (const link of links) {
    const destination = decodeDestination(link.destination);
    if (destination === undefined) continue;
    const firstParty = firstPartyDestination(destination);
    if (firstParty === undefined && isExternalDestination(destination)) continue;

    const localDestination = firstParty?.kind === "docs" ? firstParty.destination : destination;
    const [rawPath, rawFragment] = firstParty?.kind === "repository"
      ? [firstParty.repositoryPath, firstParty.fragment]
      : splitOnce(localDestination, "#");
    const target = firstParty?.kind === "repository"
      ? resolveRepositoryTarget({ root, repositoryPath: rawPath })
      : resolveMarkdownTarget({ root, sourceFile: file, rawPath });
    if (target === undefined) {
      errors.push(`${file}:${link.line} local link target does not exist: ${link.destination}`);
      continue;
    }
    if (rawFragment.length === 0 || !target.endsWith(".md")) continue;
    if (firstParty?.kind === "repository" && /^L\d+(?:-L\d+)?$/iu.test(rawFragment)) continue;

    const targetText = contents.get(target) ?? readFileSync(join(root, target), "utf8");
    const anchors = markdownAnchors(targetText);
    const fragment = safeDecodeURIComponent(rawFragment).toLowerCase();
    if (!anchors.has(fragment)) {
      errors.push(`${file}:${link.line} heading fragment \`#${rawFragment}\` does not exist in ${target}.`);
    }
  }
  return errors;
}

function firstPartyDestination(destination) {
  try {
    const url = new URL(destination);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.hostname === FIRST_PARTY_DOCUMENTATION_HOST) {
      return { kind: "docs", destination: `${url.pathname}${url.search}${url.hash}` };
    }
    if (url.hostname !== "github.com") return undefined;
    const match = FIRST_PARTY_GITHUB_PATH.exec(url.pathname);
    if (match === null) return undefined;
    return {
      kind: "repository",
      repositoryPath: match[2],
      fragment: url.hash.replace(/^#/u, ""),
    };
  } catch {
    return undefined;
  }
}

function resolveRepositoryTarget({ root, repositoryPath }) {
  const withoutQuery = safeDecodeURIComponent(repositoryPath.split("?", 1)[0]).replace(/^\/+|\/+$/gu, "");
  if (withoutQuery.length === 0) return undefined;
  const candidate = resolve(root, withoutQuery);
  if (!isInsideRoot(root, candidate) || !existsSync(candidate)) return undefined;
  return toRepositoryPath(root, candidate);
}

function resolveMarkdownTarget({ root, sourceFile, rawPath }) {
  if (rawPath.length === 0) return sourceFile;
  const withoutQuery = safeDecodeURIComponent(rawPath.split("?", 1)[0]);
  const candidate = withoutQuery.startsWith("/")
    ? join(root, "docs", withoutQuery.replace(/^\/+|\/+$/gu, ""))
    : resolve(root, dirname(sourceFile), withoutQuery);
  if (!isInsideRoot(root, candidate)) return undefined;

  const candidateIsDirectory = existsSync(candidate) && statSync(candidate).isDirectory();
  const candidates = [];
  if (withoutQuery.endsWith("/") || candidateIsDirectory) {
    candidates.push(join(candidate, "index.md"), join(candidate, "README.md"));
  }
  if (extname(candidate).length === 0) {
    candidates.push(`${candidate}.md`, join(candidate, "index.md"), join(candidate, "README.md"));
  }
  if (withoutQuery === "/") candidates.push(join(root, "docs", "index.md"));
  for (const path of candidates) {
    if (existsSync(path) && statSync(path).isFile()) return toRepositoryPath(root, path);
  }
  if (candidateIsDirectory) return toRepositoryPath(root, candidate);
  if (existsSync(candidate) && statSync(candidate).isFile()) return toRepositoryPath(root, candidate);
  return undefined;
}

function markdownAnchors(text) {
  const anchors = new Set();
  const counts = new Map();
  const { headings } = scanMarkdown(frontmatterBody(text).body);
  for (const heading of headings) {
    const base = githubSlug(heading.text);
    const duplicateIndex = counts.get(base) ?? 0;
    counts.set(base, duplicateIndex + 1);
    anchors.add(duplicateIndex === 0 ? base : `${base}-${duplicateIndex}`);
  }
  for (const match of text.matchAll(/\b(?:id|name)=["']([^"']+)["']/gu)) {
    anchors.add(match[1].toLowerCase());
  }
  return anchors;
}

function githubSlug(value) {
  return value
    .toLowerCase()
    .replace(/<[^>]+>/gu, "")
    .replace(/[`*_~]/gu, "")
    .replace(/&[a-z0-9#]+;/gu, "")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s/gu, "-");
}

function findTableErrors(file, lines, lineOffset) {
  const errors = [];
  let activeFence;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index];
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch !== null) {
      if (activeFence === undefined) activeFence = fenceMatch[1][0];
      else if (activeFence === fenceMatch[1][0]) activeFence = undefined;
      continue;
    }
    if (activeFence !== undefined || !isTableRow(line) || index > 0 && isTableRow(lines[index - 1])) continue;
    if (!isTableSeparator(lines[index + 1])) {
      errors.push(`${file}:${index + 1 + lineOffset} Markdown tables need a header separator row.`);
    }
  }
  return errors;
}

function isTableRow(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && (trimmed.match(/\|/gu)?.length ?? 0) >= 3;
}

function isTableSeparator(line) {
  if (!isTableRow(line)) return false;
  return line.trim().slice(1, -1).split("|").every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell));
}

function hasDiagramSummary(lines, fenceLine) {
  for (let index = fenceLine - 1, checked = 0; index >= 0 && checked < 5; index -= 1) {
    const value = lines[index].trim();
    if (value.length === 0 || value.startsWith("<!--")) continue;
    checked += 1;
    if (value.includes("**Diagram summary:**")) return true;
    if (/^#{1,6}\s/u.test(value)) return false;
  }
  return false;
}

function markdownLinks(line) {
  const links = [];
  const codeRanges = inlineCodeRanges(line);
  const pattern = /(!?)\[([^\]]*)\]\((<[^>]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/gu;
  for (const match of line.matchAll(pattern)) {
    if (insideRange(match.index ?? 0, codeRanges)) continue;
    links.push({
      image: match[1] === "!",
      label: match[2],
      destination: match[3].replace(/^<|>$/gu, ""),
    });
  }
  return links;
}

function markdownReferenceLinks(line) {
  const links = [];
  const codeRanges = inlineCodeRanges(line);
  const pattern = /(!?)\[([^\]]*)\]\[([^\]]*)\]/gu;
  for (const match of line.matchAll(pattern)) {
    if (insideRange(match.index ?? 0, codeRanges)) continue;
    links.push({
      image: match[1] === "!",
      label: match[2],
      id: match[3].length > 0 ? match[3] : match[2],
    });
  }
  return links;
}

function stripHtmlComments(line, state, lineNumber) {
  let remaining = line;
  let visible = "";
  if (state.active) {
    const closing = remaining.indexOf("-->");
    if (closing === -1) return "";
    remaining = remaining.slice(closing + 3);
    state.active = false;
    state.startLine = undefined;
  }

  while (remaining.length > 0) {
    const opening = remaining.indexOf("<!--");
    if (opening === -1) return visible + remaining;
    visible += remaining.slice(0, opening);
    const closing = remaining.indexOf("-->", opening + 4);
    if (closing === -1) {
      state.active = true;
      state.startLine = lineNumber;
      return visible;
    }
    remaining = remaining.slice(closing + 3);
  }
  return visible;
}

function inlineCodeRanges(line) {
  const ranges = [];
  for (const match of line.matchAll(/(`+)[^`]*?\1/gu)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }
  return ranges;
}

function insideRange(index, ranges) {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function normalizeReferenceId(value) {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return undefined;
  const lines = text.split(/\r?\n/u);
  const closing = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closing === -1) return undefined;
  const closingIndex = closing + 1;
  return {
    source: lines.slice(1, closingIndex).join("\n"),
    body: lines.slice(closingIndex + 1).join("\n"),
    lineCount: closingIndex + 1,
  };
}

function frontmatterBody(text) {
  const parsed = parseFrontmatter(text);
  return parsed === undefined ? { body: text, lineCount: 0 } : parsed;
}

function decodeDestination(destination) {
  const trimmed = destination.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.replace(/&amp;/gu, "&");
}

function isExternalDestination(destination) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(destination);
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitOnce(value, separator) {
  const index = value.indexOf(separator);
  return index === -1 ? [value, ""] : [value.slice(0, index), value.slice(index + separator.length)];
}

function stripInlineMarkdown(value) {
  return value.replace(/[`*_~]/gu, "").replace(/<[^>]+>/gu, "");
}

function walk(path, visit) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === ".astro") continue;
    const absolutePath = join(path, entry.name);
    if (entry.isDirectory()) walk(absolutePath, visit);
    else if (entry.isFile()) visit(absolutePath);
  }
}

function isInsideRoot(root, path) {
  const repositoryPath = relative(root, path);
  return repositoryPath.length === 0 || !repositoryPath.startsWith(`..${sep}`) && repositoryPath !== "..";
}

function toRepositoryPath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function compareText(left, right) {
  return left.localeCompare(right, "en");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
