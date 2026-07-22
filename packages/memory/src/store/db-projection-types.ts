import type {
  EntityRecord,
  EntityRelationRecord,
  MemoryEntityAssociation,
  MemoryRecord,
} from "./types.js";

export interface CanonicalGraphReplacementSupport {
  readonly memoryId: string;
  readonly entityId: string;
  readonly collection: string;
  readonly weight: number;
  readonly createdAt: string;
}

export interface CanonicalGraphReplacement {
  readonly entities: readonly EntityRecord[];
  readonly relations: readonly EntityRelationRecord[];
  readonly associations: readonly MemoryEntityAssociation[];
  readonly supports: readonly CanonicalGraphReplacementSupport[];
}

/** Store-local shape used by the BuJo replay-projection authority. */
export interface ReplayProjectionDbReplacement {
  readonly terminals: readonly { readonly id: string; readonly at: string }[];
  readonly supersedes: readonly { readonly src: string; readonly dst: string; readonly at: string }[];
  readonly threads: readonly {
    readonly src: string;
    readonly dst: string;
    readonly weight: number;
    readonly at: string;
  }[];
}

export interface ReplayProjectionDbSnapshot {
  readonly memories: readonly {
    readonly id: string;
    readonly status: MemoryRecord["status"];
    readonly createdAt: string;
    readonly validTo?: string;
    readonly supersededBy?: string;
    readonly supersededAt?: string;
  }[];
  readonly edges: readonly {
    readonly src: string;
    readonly dst: string;
    readonly kind: "thread" | "about" | "supports" | "supersedes";
    readonly weight: number;
    readonly createdAt: string;
  }[];
}
