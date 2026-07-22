import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DocsCorpusHeading {
  readonly level: number;
  readonly text: string;
  readonly anchor: string;
  readonly headingPath: readonly string[];
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface DocsCorpusUnit {
  readonly kind: "block" | "fence" | "heading";
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface DocsCorpusDocument {
  readonly id: string;
  readonly source: "composer" | "docs";
  readonly path: string;
  readonly title: string;
  readonly route?: string;
  readonly canonicalUrl?: string;
  readonly markdown: string;
  readonly headings: readonly DocsCorpusHeading[];
  readonly units: readonly DocsCorpusUnit[];
}

export interface DocsCorpusChunk {
  readonly id: string;
  readonly documentId: string;
  readonly source: "composer" | "docs";
  readonly path: string;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly anchor?: string;
  readonly canonicalUrl?: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
  readonly embeddingText: string;
}

export interface DocsCorpusManifest {
  readonly schema: "mono-agent.docs-corpus.v2";
  readonly docsVersion: string;
  readonly sourceDigest: string;
  readonly corpusDigest: string;
  readonly chunkerVersion: "markdown-blocks-v2";
  readonly documentCount: number;
  readonly chunkCount: number;
  readonly model: {
    readonly package: "@yarflam/potion-base-8m";
    readonly version: "1.0.4";
    readonly id: "minishlab/potion-base-8M";
    readonly dimensions: 256;
  };
  readonly artifacts: {
    readonly documentsSha256: string;
    readonly chunksSha256: string;
    readonly embeddingsSha256: string;
    readonly byteOrder: "little-endian";
  };
}

export interface DocsCorpus {
  readonly manifest: DocsCorpusManifest;
  readonly documents: readonly DocsCorpusDocument[];
  readonly chunks: readonly DocsCorpusChunk[];
  readonly embeddings: readonly Float32Array[];
  readonly documentsById: ReadonlyMap<string, DocsCorpusDocument>;
  readonly documentsByPath: ReadonlyMap<string, DocsCorpusDocument>;
  readonly documentsByRoute: ReadonlyMap<string, DocsCorpusDocument>;
  readonly chunksById: ReadonlyMap<string, DocsCorpusChunk>;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS_DIR = basename(moduleDirectory) === "src"
  ? join(moduleDirectory, "..", "dist", "corpus")
  : join(moduleDirectory, "corpus");

export async function loadDocsCorpus(corpusDir = DEFAULT_CORPUS_DIR): Promise<DocsCorpus> {
  const [manifestBytes, documentsBytes, chunksBytes, embeddingsBytes] = await Promise.all([
    readFile(join(corpusDir, "manifest.json")),
    readFile(join(corpusDir, "documents.json")),
    readFile(join(corpusDir, "chunks.json")),
    readFile(join(corpusDir, "embeddings.f32")),
  ]);
  const manifest = parseManifest(manifestBytes.toString("utf8"));
  assertChecksum("documents.json", documentsBytes, manifest.artifacts.documentsSha256);
  assertChecksum("chunks.json", chunksBytes, manifest.artifacts.chunksSha256);
  assertChecksum("embeddings.f32", embeddingsBytes, manifest.artifacts.embeddingsSha256);

  const calculatedCorpusDigest = createHash("sha256")
    .update(documentsBytes)
    .update(chunksBytes)
    .update(embeddingsBytes)
    .digest("hex");
  if (calculatedCorpusDigest !== manifest.corpusDigest) {
    throw new Error(`Documentation corpus digest mismatch: expected ${manifest.corpusDigest}, received ${calculatedCorpusDigest}.`);
  }

  const documents = parseDocuments(documentsBytes.toString("utf8"));
  const chunks = parseChunks(chunksBytes.toString("utf8"));
  if (documents.length !== manifest.documentCount) {
    throw new Error(`Documentation corpus document count mismatch: manifest=${manifest.documentCount}, documents=${documents.length}.`);
  }
  if (chunks.length !== manifest.chunkCount) {
    throw new Error(`Documentation corpus chunk count mismatch: manifest=${manifest.chunkCount}, chunks=${chunks.length}.`);
  }

  const expectedBytes = chunks.length * manifest.model.dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (embeddingsBytes.byteLength !== expectedBytes) {
    throw new Error(`Documentation embedding byte length mismatch: expected ${expectedBytes}, received ${embeddingsBytes.byteLength}.`);
  }
  const embeddings = chunks.map((_chunk, chunkIndex) => {
    const vector = new Float32Array(manifest.model.dimensions);
    const offset = chunkIndex * manifest.model.dimensions * Float32Array.BYTES_PER_ELEMENT;
    for (let dimension = 0; dimension < manifest.model.dimensions; dimension += 1) {
      const value = embeddingsBytes.readFloatLE(offset + (dimension * Float32Array.BYTES_PER_ELEMENT));
      if (!Number.isFinite(value)) {
        throw new Error(`Documentation embedding ${chunkIndex}:${dimension} is not finite.`);
      }
      vector[dimension] = value;
    }
    return vector;
  });

  const documentsById = uniqueMap(documents, (document) => document.id, "document id");
  const documentsByPath = uniqueMap(documents, (document) => document.path, "document path");
  const documentsByRoute = uniqueMap(
    documents.filter((document): document is DocsCorpusDocument & { readonly route: string } => document.route !== undefined),
    (document) => document.route,
    "document route",
  );
  const chunksById = uniqueMap(chunks, (chunk) => chunk.id, "chunk id");
  for (const chunk of chunks) {
    const document = documentsById.get(chunk.documentId);
    if (document === undefined) {
      throw new Error(`Documentation chunk ${chunk.id} refers to unknown document ${chunk.documentId}.`);
    }
    if (chunk.path !== document.path || chunk.source !== document.source || chunk.endOffset > document.markdown.length) {
      throw new Error(`Documentation chunk ${chunk.id} has invalid document provenance.`);
    }
  }
  return {
    manifest,
    documents,
    chunks,
    embeddings,
    documentsById,
    documentsByPath,
    documentsByRoute,
    chunksById,
  };
}

function assertChecksum(name: string, bytes: Uint8Array, expected: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`Documentation corpus ${name} checksum mismatch: expected ${expected}, received ${actual}.`);
  }
}

function parseManifest(raw: string): DocsCorpusManifest {
  const value = JSON.parse(raw) as unknown;
  if (!isObject(value)
    || value.schema !== "mono-agent.docs-corpus.v2"
    || typeof value.docsVersion !== "string"
    || !isSha256(value.sourceDigest)
    || !isSha256(value.corpusDigest)
    || value.chunkerVersion !== "markdown-blocks-v2"
    || !Number.isInteger(value.documentCount)
    || !Number.isInteger(value.chunkCount)
    || !isObject(value.model)
    || value.model.package !== "@yarflam/potion-base-8m"
    || value.model.version !== "1.0.4"
    || value.model.id !== "minishlab/potion-base-8M"
    || value.model.dimensions !== 256
    || !isObject(value.artifacts)
    || !isSha256(value.artifacts.documentsSha256)
    || !isSha256(value.artifacts.chunksSha256)
    || !isSha256(value.artifacts.embeddingsSha256)
    || value.artifacts.byteOrder !== "little-endian") {
    throw new Error("Documentation corpus manifest is invalid or unsupported.");
  }
  return value as unknown as DocsCorpusManifest;
}

function parseDocuments(raw: string): readonly DocsCorpusDocument[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) throw new Error("Documentation corpus documents.json must contain an array.");
  return value.map((candidate, index) => {
    if (!isObject(candidate)) throw new Error(`Documentation corpus document ${index} is invalid.`);
    const markdownLength = typeof candidate.markdown === "string" ? candidate.markdown.length : -1;
    if (!isSha256(candidate.id)
      || (candidate.source !== "composer" && candidate.source !== "docs")
      || typeof candidate.path !== "string"
      || typeof candidate.title !== "string"
      || (candidate.route !== undefined && typeof candidate.route !== "string")
      || (candidate.canonicalUrl !== undefined && typeof candidate.canonicalUrl !== "string")
      || markdownLength < 0
      || !Array.isArray(candidate.headings)
      || !candidate.headings.every((heading) => validHeading(heading, markdownLength))
      || !Array.isArray(candidate.units)
      || !candidate.units.every((unit) => validUnit(unit, markdownLength))) {
      throw new Error(`Documentation corpus document ${index} is invalid.`);
    }
    return candidate as unknown as DocsCorpusDocument;
  });
}

function parseChunks(raw: string): readonly DocsCorpusChunk[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) throw new Error("Documentation corpus chunks.json must contain an array.");
  return value.map((candidate, index) => {
    if (!isObject(candidate)
      || !isSha256(candidate.id)
      || !isSha256(candidate.documentId)
      || (candidate.source !== "composer" && candidate.source !== "docs")
      || typeof candidate.path !== "string"
      || typeof candidate.title !== "string"
      || !Array.isArray(candidate.headingPath)
      || !candidate.headingPath.every((part) => typeof part === "string")
      || (candidate.anchor !== undefined && typeof candidate.anchor !== "string")
      || (candidate.canonicalUrl !== undefined && typeof candidate.canonicalUrl !== "string")
      || !validOffsets(candidate.startOffset, candidate.endOffset, Number.MAX_SAFE_INTEGER)
      || typeof candidate.text !== "string"
      || typeof candidate.embeddingText !== "string") {
      throw new Error(`Documentation corpus chunk ${index} is invalid.`);
    }
    return candidate as unknown as DocsCorpusChunk;
  });
}

function validHeading(value: unknown, markdownLength: number): boolean {
  return isObject(value)
    && Number.isInteger(value.level)
    && Number(value.level) >= 1
    && Number(value.level) <= 6
    && typeof value.text === "string"
    && typeof value.anchor === "string"
    && Array.isArray(value.headingPath)
    && value.headingPath.every((part) => typeof part === "string")
    && validOffsets(value.startOffset, value.endOffset, markdownLength);
}

function validUnit(value: unknown, markdownLength: number): boolean {
  return isObject(value)
    && (value.kind === "block" || value.kind === "fence" || value.kind === "heading")
    && validOffsets(value.startOffset, value.endOffset, markdownLength);
}

function validOffsets(start: unknown, end: unknown, maximum: number): boolean {
  return Number.isInteger(start)
    && Number.isInteger(end)
    && Number(start) >= 0
    && Number(end) > Number(start)
    && Number(end) <= maximum;
}

function uniqueMap<T>(records: readonly T[], keyFor: (record: T) => string, kind: string): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const record of records) {
    const key = keyFor(record);
    if (result.has(key)) throw new Error(`Documentation corpus contains duplicate ${kind} ${key}.`);
    result.set(key, record);
  }
  return result;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
