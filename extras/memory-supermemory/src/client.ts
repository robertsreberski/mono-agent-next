/**
 * Thin REST client for Supermemory's Memory API. Two operations back the MemoryStore adapter:
 *   - ADD    `POST {base}/v3/documents`  (ingestion is async; the server returns `{ id, status }`)
 *   - SEARCH `POST {base}/v4/search`     (preferred; falls back to legacy `/v3/search`)
 *
 * Wire shapes are taken from the verified Supermemory API surface (sdk-ts api.md + docs). We use raw
 * `fetch` behind a tiny injectable seam ({@link SupermemoryFetch}) rather than the `supermemory` SDK:
 * the adapter only needs two endpoints, the wire format is fixed, and a raw client keeps the package
 * dependency-free and fully unit-testable without a network or the SDK.
 *
 * Self-host caveat: the self-hosted binary's quickstart documents only the v3 routes, so search tries
 * `/v4/search` first and transparently falls back to the legacy `/v3/search` (plural `containerTags`,
 * `score` instead of `similarity`, text under `content`/`chunks[].content`) on a 404. Both response
 * shapes are normalized into {@link SupermemoryHit}.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_SEARCH_MODE: SupermemorySearchMode = "hybrid";

export type SupermemorySearchMode = "memories" | "hybrid" | "documents";

/** A normalized, ranked memory hit (uniform across the v4 and legacy v3 response shapes). */
export interface SupermemoryHit {
  readonly id: string;
  readonly text: string;
  /** Relevance score in [0, 1]. */
  readonly score: number;
}

/** Flat metadata values only — Supermemory rejects nested objects. */
export type SupermemoryMetadataValue = string | number | boolean | readonly string[];

export interface SupermemoryAddParams {
  readonly content: string;
  /** Stable id enabling idempotent upsert/de-dup of re-emitted content. */
  readonly customId?: string;
  readonly metadata?: Readonly<Record<string, SupermemoryMetadataValue>>;
}

export interface SupermemorySearchParams {
  readonly query: string;
  /** Max hits (defaults to the client's configured `searchLimit`). */
  readonly limit?: number;
}

/** The capability the store depends on. Fakes implement this directly in unit tests. */
export interface SupermemoryClient {
  /** Add a document to the agent's container. Rejects on non-2xx so callers can degrade. */
  add(params: SupermemoryAddParams): Promise<void>;
  /** Search the agent's container. Rejects on transport failure so `load` can degrade to undefined. */
  search(params: SupermemorySearchParams): Promise<SupermemoryHit[]>;
}

/** Minimal response surface we use — keeps the injectable `fetch` seam trivial to stub in tests. */
export interface SupermemoryFetchResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type SupermemoryFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<SupermemoryFetchResponse>;

export interface SupermemoryHttpClientConfig {
  /** REST base URL — local OSS binary (e.g. http://127.0.0.1:6767) or hosted cloud. */
  readonly baseUrl: string;
  /** Bearer token. Omitted → no Authorization header (keyless local instances). */
  readonly apiKey?: string;
  /** Namespace tag scoping every add + search. */
  readonly containerTag: string;
  readonly timeoutMs?: number;
  readonly searchLimit?: number;
  readonly searchMode?: SupermemorySearchMode;
  /**
   * Minimum-similarity cutoff (0..1) applied SERVER-SIDE on v4 search. Unset (default) → no floor,
   * so recall returns the top ranked hits like the bujo backend. Set it only to deliberately drop
   * weak matches; a non-trivial floor on hybrid search can silently discard relevant memories.
   */
  readonly threshold?: number;
  readonly rerank?: boolean;
  /** Injectable transport (defaults to global fetch). */
  readonly fetch?: SupermemoryFetch;
}

const defaultFetch: SupermemoryFetch = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, json: () => res.json() as Promise<unknown> };
};

export function createSupermemoryHttpClient(config: SupermemoryHttpClientConfig): SupermemoryClient {
  const base = config.baseUrl.replace(/\/+$/u, "");
  const containerTag = config.containerTag;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const searchLimit = config.searchLimit ?? DEFAULT_SEARCH_LIMIT;
  const searchMode = config.searchMode ?? DEFAULT_SEARCH_MODE;
  const threshold = config.threshold;
  const rerank = config.rerank ?? false;
  const doFetch = config.fetch ?? defaultFetch;
  // Remember when an instance doesn't serve /v4 so we route straight to /v3 thereafter instead of
  // re-probing v4 (and paying its latency) on every subsequent search.
  let v4Available = true;

  async function request(path: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = await res.json().catch(() => undefined);
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async add(params: SupermemoryAddParams): Promise<void> {
      const { status } = await request("/v3/documents", {
        content: params.content,
        containerTag,
        ...(params.customId === undefined ? {} : { customId: params.customId }),
        ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
      });
      if (!ok(status)) {
        throw new Error(`supermemory add failed: HTTP ${status}`);
      }
    },

    async search(params: SupermemorySearchParams): Promise<SupermemoryHit[]> {
      const limit = params.limit ?? searchLimit;
      if (v4Available) {
        const v4 = await request("/v4/search", {
          q: params.query,
          containerTag,
          searchMode,
          limit,
          // Omit the floor unless explicitly configured — match bujo's "top-N, no minimum" recall.
          ...(threshold === undefined ? {} : { threshold }),
          rerank,
        });
        if (v4.status !== 404) {
          if (!ok(v4.status)) {
            throw new Error(`supermemory search failed: HTTP ${v4.status}`);
          }
          return normalizeHits(v4.json, "v4");
        }
        // This instance doesn't serve /v4 (self-hosted binary may only expose v3) — remember it.
        v4Available = false;
      }
      const v3 = await request("/v3/search", { q: params.query, containerTags: [containerTag], limit });
      if (!ok(v3.status)) {
        throw new Error(`supermemory v3 search failed: HTTP ${v3.status}`);
      }
      return normalizeHits(v3.json, "v3");
    },
  };
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pull the result array from either a `results` or `documents` envelope. */
function resultsOf(json: unknown): unknown[] {
  if (!isRecord(json)) {
    return [];
  }
  if (Array.isArray(json.results)) {
    return json.results;
  }
  if (Array.isArray(json.documents)) {
    return json.documents;
  }
  return [];
}

/**
 * Normalize a search response into ranked hits. v4 carries text under `memory`/`chunk` and the score
 * under `similarity`; legacy v3 carries text under `content`/`chunks[].content` and the score under
 * `score`. Malformed/empty rows are dropped rather than throwing.
 */
function normalizeHits(json: unknown, shape: "v4" | "v3"): SupermemoryHit[] {
  const hits: SupermemoryHit[] = [];
  for (const row of resultsOf(json)) {
    if (!isRecord(row)) {
      continue;
    }
    // v4 identifies hits as `id`; the legacy v3 route uses `documentId` (fall back to `id`).
    const idField = shape === "v4" ? row.id : row.documentId ?? row.id;
    const id = typeof idField === "string" ? idField : "";
    const text = shape === "v4" ? textV4(row) : textV3(row);
    if (text.trim().length === 0) {
      continue;
    }
    const rawScore = shape === "v4" ? row.similarity : row.score;
    const score = typeof rawScore === "number" && Number.isFinite(rawScore) ? rawScore : 0;
    hits.push({ id, text, score });
  }
  return hits;
}

function textV4(row: Record<string, unknown>): string {
  if (typeof row.memory === "string") {
    return row.memory;
  }
  if (typeof row.chunk === "string") {
    return row.chunk;
  }
  return "";
}

function textV3(row: Record<string, unknown>): string {
  if (typeof row.content === "string") {
    return row.content;
  }
  if (Array.isArray(row.chunks)) {
    const first = row.chunks.find((c) => isRecord(c) && typeof c.content === "string");
    if (isRecord(first) && typeof first.content === "string") {
      return first.content;
    }
  }
  return "";
}
