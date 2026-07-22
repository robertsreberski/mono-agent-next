import type { EmbeddingProvider } from "../search/index.js";

export type MemoryType = "task" | "event" | "note";

export const MEMORY_TYPES = ["task", "event", "note"] as const satisfies readonly MemoryType[];

export type MemoryStatus =
  | "open"
  | "done"
  | "scheduled"
  | "migrated"
  | "dropped"
  | "invalidated";

export const MEMORY_STATUSES = [
  "open",
  "done",
  "scheduled",
  "migrated",
  "dropped",
  "invalidated",
] as const satisfies readonly MemoryStatus[];

export interface MemorySource {
  readonly session?: string;
  readonly file?: string;
  readonly line?: number;
}

export interface MemoryRecord {
  readonly id: string;
  readonly type: MemoryType;
  readonly status: MemoryStatus;
  readonly text: string;
  readonly salience: number;
  readonly isInsight: boolean;
  readonly createdAt: string;
  readonly lastAccessedAt?: string;
  readonly accessCount: number;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly supersededBy?: string;
  readonly supersededAt?: string;
  readonly dueAt?: string;
  readonly tags: readonly string[];
  readonly collection?: string;
  readonly source: MemorySource;
  readonly embeddingModel?: string;
  readonly dim?: number;
}

/**
 * Edge kinds accepted by the store. The retired `about` kind remains in this
 * published type and the SQLite schema so existing indexes can be read and
 * normalized; no built-in production path emits it in v1.
 */
export type MemoryEdgeKind = "thread" | "about" | "supports" | "supersedes";

export interface RecallHit {
  readonly record: MemoryRecord;
  readonly score: number;
}

export interface SimilarHit {
  readonly record: MemoryRecord;
  readonly distance: number; // cosine distance from sqlite-vec (0 = identical)
}

export interface EntityRecord {
  readonly id: string;       // slug, e.g. "person:morgan"
  readonly name: string;
  readonly type?: string;    // person | project | org | concept | ...
  readonly summary?: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface EntityRelationRecord {
  readonly src: string;
  readonly dst: string;
  readonly relation: string;
  readonly createdAt: string;
}

export interface MemoryEntityAssociation {
  readonly memoryId: string;
  readonly entityId: string;
  /** `capture` is model-produced and candidate-specific; legacy matches are deterministic rebuild evidence. */
  readonly provenance: "capture" | "legacy-name-match";
  readonly createdAt: string;
}

/** Memory fields used by the deterministic legacy graph projection. */
export type CanonicalGraphMemoryRecord = Pick<MemoryRecord, "id" | "status" | "text" | "createdAt" | "collection">;

export interface CanonicalGraphSupportEdge {
  readonly src: string;
  readonly dst: string;
  readonly weight: number;
}

/** One transactionally consistent graph/parity snapshot from the rebuildable index. */
export interface CanonicalGraphSnapshot {
  readonly metadata?: IndexMetadata;
  readonly memories: readonly CanonicalGraphMemoryRecord[];
  readonly entities: readonly EntityRecord[];
  readonly relations: readonly EntityRelationRecord[];
  readonly associations: readonly MemoryEntityAssociation[];
  readonly supports: readonly CanonicalGraphSupportEdge[];
}

export interface ContentHashRecord {
  readonly contentHash: string;
  readonly memoryId: string;
  readonly sourceFile: string;
  readonly createdAt: string;
}

export interface IndexMetadata {
  readonly schemaVersion: number;
  readonly policyVersion: string;
  readonly tier: "lite" | "journal" | "bujo";
  readonly embeddingModel?: string;
  readonly dimension?: number;
  readonly sourceFingerprint: string;
  readonly generation: string;
  readonly createdAt: string;
  readonly skippedRawRecords?: number;
  readonly skippedUnstructuredRecords?: number;
  readonly skippedMissingIdentityRecords?: number;
  readonly missingIdentityLocations?: readonly string[];
  readonly skippedLegacySourceRecords?: number;
  readonly legacySourceLocations?: readonly string[];
  readonly skippedJournalDuplicateRecords?: number;
  readonly parsedSourceItems?: number;
  readonly derivedLegacyAssociations?: number;
}

export interface RecallWeights {
  readonly rrf: number;
  readonly recency: number;
  readonly salience: number;
  readonly insight: number;
}

export interface RecallOptions {
  readonly topK?: number;
  readonly candidates?: number;
  readonly expandHops?: number;
  readonly includeInvalid?: boolean;
  readonly trackAccess?: boolean;
  readonly now?: Date;
  /** Abort before any post-provider SQLite access. */
  readonly abortSignal?: AbortSignal;
}

export interface MemoryStoreStatsOptions {
  readonly topEntitiesLimit?: number;
}

export type MemoryCountByStatus = Readonly<Record<MemoryStatus, number>>;
export type MemoryCountByType = Readonly<Record<MemoryType, number>>;

export interface MemoryStoreStats {
  readonly totalMemories: number;
  readonly liveMemories: number;
  readonly countsByStatus: MemoryCountByStatus;
  readonly countsByType: MemoryCountByType;
  readonly latestCreatedMemory?: MemoryRecord;
  readonly latestAccessedMemory?: MemoryRecord;
  readonly topEntities: readonly EntityRecord[];
}

/** Aggregate-only store health. It intentionally carries no memory or entity content. */
export interface MemoryStoreAudit {
  readonly counts: {
    readonly total: number;
    readonly live: number;
    readonly entities: number;
      readonly entityRelations: number;
      readonly memoryEntityAssociations: number;
      readonly orphanedAssociations: number;
  };
  readonly duplicates: {
    readonly groups: number;
    readonly redundantRecords: number;
    readonly ratio: number;
  };
  readonly vectors: {
    readonly indexed: number;
    readonly liveIndexed: number;
    readonly liveCoverage: number;
  };
  readonly access: {
    readonly totalCount: number;
    readonly accessedMemories: number;
    readonly topOnePercentShare: number;
  };
}

export interface MemoryDbOptions {
  readonly path: string;
  readonly readOnly?: boolean;
  readonly embeddings?: EmbeddingProvider;
  readonly dim?: number;
  readonly k?: number;
  readonly weights?: Partial<RecallWeights>;
  readonly decayGamma?: number;
  readonly clock?: () => Date;
}

/** Default vector dimension used for the `memories_vec` table DDL when no `dim` is provided. */
export const DEFAULT_VEC_DIM = 768;

/**
 * Re-score weights. `rrf` scales the (small, ~1/k) fused rank score; the others
 * are added on top. These are independent scalars, NOT a distribution that sums to 1.
 */
export const DEFAULT_WEIGHTS: RecallWeights = {
  rrf: 1.0,
  // Access time is telemetry, never relevance. Keep the field for config/API
  // compatibility but make its effective default zero and do not feed it into
  // the scorer.
  recency: 0,
  // Relevance must dominate these deterministic tie-breakers.
  salience: 0.01,
  insight: 0.01,
};
export const DEFAULT_RRF_K = 60;
/** Retained for API compatibility; access-recency scoring is disabled. */
export const DEFAULT_DECAY_GAMMA = 0.995;
