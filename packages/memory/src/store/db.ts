import { MemoryDbGraph } from "./db-graph.js";
import type { MemoryDbOptions } from "./types.js";

export { DEFAULT_EMBEDDING_BATCH_SIZE } from "./db-core.js";
export type {
  CanonicalGraphReplacement,
  CanonicalGraphReplacementSupport,
  ReplayProjectionDbReplacement,
  ReplayProjectionDbSnapshot,
} from "./db-projection-types.js";

/**
 * Public memory-store façade.
 *
 * Persistence, graph projection, and maintenance behavior live in cohesive
 * collaborators while this class preserves the established constructor and
 * inherited method surface.
 */
export class MemoryDb extends MemoryDbGraph {}

export function openMemoryDb(options: MemoryDbOptions): MemoryDb {
  return new MemoryDb(options);
}
