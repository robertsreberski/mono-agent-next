// SPDX-License-Identifier: MIT
import { embed } from "@yarflam/potion-base-8m";

import { loadDocsCorpus } from "./corpus.js";
import type { DocsCorpus, DocsCorpusChunk } from "./corpus.js";
import { MonoAgentDocsReader } from "./reader.js";
import type {
  MonoAgentDocsErrorResult,
  MonoAgentDocsReadResult,
  MonoAgentDocsSearchAction,
  MonoAgentDocsSearchResult,
} from "./types.js";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 8;
const RRF_K = 60;
const SEMANTIC_WEIGHT = 0.65;
const LEXICAL_WEIGHT = 0.35;

interface LexicalDocument {
  readonly termFrequency: ReadonlyMap<string, number>;
  readonly length: number;
}

export class MonoAgentDocsSearchIndex {
  readonly #corpus: DocsCorpus;
  readonly #reader: MonoAgentDocsReader;
  readonly #lexicalDocuments: readonly LexicalDocument[];
  readonly #documentFrequency: ReadonlyMap<string, number>;
  readonly #averageDocumentLength: number;

  constructor(corpus: DocsCorpus) {
    this.#corpus = corpus;
    this.#reader = new MonoAgentDocsReader(corpus);
    this.#lexicalDocuments = corpus.chunks.map((chunk) => lexicalDocument(chunk.embeddingText));
    this.#documentFrequency = documentFrequency(this.#lexicalDocuments);
    this.#averageDocumentLength = this.#lexicalDocuments.reduce((sum, document) => sum + document.length, 0)
      / Math.max(1, this.#lexicalDocuments.length);
  }

  get manifest(): DocsCorpus["manifest"] {
    return this.#corpus.manifest;
  }

  getChunk(chunkId: string): DocsCorpusChunk | undefined {
    return this.#corpus.chunksById.get(chunkId);
  }

  read(target: string): MonoAgentDocsReadResult | MonoAgentDocsErrorResult {
    return this.#reader.read(target);
  }

  async search(input: Omit<MonoAgentDocsSearchAction, "action">): Promise<MonoAgentDocsSearchResult> {
    const query = input.query.trim();
    if (query.length < 3 || query.length > 500) {
      throw new Error("Documentation search query must contain between 3 and 500 characters.");
    }
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new Error(`Documentation search limit must be an integer between 1 and ${MAX_LIMIT}.`);
    }
    const [queryEmbedding] = await embed(query);
    if (queryEmbedding === undefined || queryEmbedding.length !== this.#corpus.manifest.model.dimensions) {
      throw new Error(`Documentation query embedding must have ${this.#corpus.manifest.model.dimensions} dimensions.`);
    }
    const candidateIndexes = this.#corpus.chunks
      .map((_chunk, index) => index);

    const semanticRanking = candidateIndexes
      .map((index) => ({ index, score: dotProduct(queryEmbedding, this.#corpus.embeddings[index]!) }))
      .sort(rankScores);
    const queryTerms = tokenize(query);
    const lexicalRanking = candidateIndexes
      .map((index) => ({ index, score: bm25Score(
        queryTerms,
        this.#lexicalDocuments[index]!,
        this.#documentFrequency,
        this.#lexicalDocuments.length,
        this.#averageDocumentLength,
      ) }))
      .sort(rankScores);

    const semanticRanks = ranksByIndex(semanticRanking);
    const lexicalRanks = ranksByIndex(lexicalRanking);
    const fused = candidateIndexes.map((index) => {
      const semanticRank = semanticRanks.get(index)!;
      const lexicalRank = lexicalRanks.get(index)!;
      return {
        index,
        score: (
          (SEMANTIC_WEIGHT / (RRF_K + semanticRank))
          + (LEXICAL_WEIGHT / (RRF_K + lexicalRank))
        ),
      };
    }).sort(rankScores);

    const results: MonoAgentDocsSearchResult["results"][number][] = [];
    const normalizedTexts = new Set<string>();
    const sections = new Set<string>();
    const hitsPerPath = new Map<string, number>();
    for (const { index } of fused) {
      const chunk = this.#corpus.chunks[index]!;
      const normalizedText = chunk.text.replace(/\s+/gu, " ").trim().toLowerCase();
      const section = `${chunk.documentId}:${chunk.anchor ?? "overview"}`;
      if (normalizedTexts.has(normalizedText) || sections.has(section) || (hitsPerPath.get(chunk.path) ?? 0) >= 2) {
        continue;
      }
      normalizedTexts.add(normalizedText);
      sections.add(section);
      hitsPerPath.set(chunk.path, (hitsPerPath.get(chunk.path) ?? 0) + 1);
      results.push(this.#reader.searchHit(chunk, results.length + 1));
      if (results.length >= limit) {
        break;
      }
    }

    return {
      schema: "mono-agent.docs.v2",
      action: "search",
      docsVersion: this.#corpus.manifest.docsVersion,
      corpusDigest: this.#corpus.manifest.corpusDigest,
      retrievalMode: "hybrid",
      query,
      results,
      navigation: {
        guidance: results.length === 0
          ? "No version-matched excerpt was found. Search again with a mono-agent package, config key, command, or capability name."
          : "Treat these excerpts as a map, not the complete answer. Read the best readTarget for a larger anchored window, then follow internalLinks or previous/next actions as needed.",
        nextActions: results.slice(0, 3).map((result) => ({
          kind: "read" as const,
          description: `Expand result ${result.rank} from ${result.path}.`,
          arguments: { action: "read" as const, target: result.readTarget },
        })),
      },
    };
  }
}

let defaultIndexPromise: Promise<MonoAgentDocsSearchIndex> | undefined;

export function loadDefaultDocsSearchIndex(): Promise<MonoAgentDocsSearchIndex> {
  defaultIndexPromise ??= loadDocsCorpus().then((corpus) => new MonoAgentDocsSearchIndex(corpus));
  return defaultIndexPromise;
}

function dotProduct(left: Float32Array, right: Float32Array): number {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += left[index]! * right[index]!;
  }
  return score;
}

function lexicalDocument(text: string): LexicalDocument {
  const terms = tokenize(text);
  const termFrequency = new Map<string, number>();
  for (const term of terms) {
    termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
  }
  return { termFrequency, length: terms.length };
}

function tokenize(text: string): readonly string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const rawTokens = normalized.match(/[@$a-z0-9_./:\[\]-]+/gu) ?? [];
  const tokens: string[] = [];
  for (const rawToken of rawTokens) {
    const token = rawToken.replace(/^[./:[\]-]+|[./:[\]-]+$/gu, "");
    if (token.length === 0) continue;
    tokens.push(token);
    for (const part of token.split(/[./:[\]_-]+/gu)) {
      if (part.length > 1 && part !== token) tokens.push(part);
    }
  }
  return tokens;
}

function documentFrequency(documents: readonly LexicalDocument[]): ReadonlyMap<string, number> {
  const frequencies = new Map<string, number>();
  for (const document of documents) {
    for (const term of document.termFrequency.keys()) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
  }
  return frequencies;
}

function bm25Score(
  queryTerms: readonly string[],
  document: LexicalDocument,
  frequencies: ReadonlyMap<string, number>,
  documentCount: number,
  averageDocumentLength: number,
): number {
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const term of new Set(queryTerms)) {
    const frequency = document.termFrequency.get(term) ?? 0;
    if (frequency === 0) continue;
    const containingDocuments = frequencies.get(term) ?? 0;
    const inverseDocumentFrequency = Math.log(
      1 + ((documentCount - containingDocuments + 0.5) / (containingDocuments + 0.5)),
    );
    const denominator = frequency + (k1 * (1 - b + (b * document.length / Math.max(1, averageDocumentLength))));
    score += inverseDocumentFrequency * ((frequency * (k1 + 1)) / denominator);
  }
  return score;
}

function ranksByIndex(ranking: readonly { readonly index: number }[]): ReadonlyMap<number, number> {
  return new Map(ranking.map((entry, rank) => [entry.index, rank + 1]));
}

function rankScores(
  left: { readonly index: number; readonly score: number },
  right: { readonly index: number; readonly score: number },
): number {
  return right.score - left.score || left.index - right.index;
}
