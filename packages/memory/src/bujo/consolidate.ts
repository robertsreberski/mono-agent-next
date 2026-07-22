import type { MemoryDb, MemoryRecord } from "../store/index.js";

import { writeEmptyFutureLog, writeIndex } from "./projections.js";

export interface ConsolidateDeps {
  readonly root: string;
  readonly db: MemoryDb;
  readonly now: Date;
}

export interface ConsolidateResult {
  readonly duplicateGroups: number;
}

/**
 * Projection-only compatibility maintenance.
 *
 * Duplicate groups are reported, never folded: canonical Bullet fields and
 * the rebuildable SQLite index remain untouched.
 */
export async function consolidateBujoMemory(deps: ConsolidateDeps): Promise<ConsolidateResult> {
  const liveRecords = deps.db.topSalient(Math.max(deps.db.count(), 1));
  const groups = groupByNormalizedText(liveRecords);
  const duplicateGroups = [...groups.values()].filter((group) => group.length > 1).length;

  writeIndex(deps.root, deps.db, deps.now);
  writeEmptyFutureLog(deps.root);
  return { duplicateGroups };
}

function groupByNormalizedText(records: readonly MemoryRecord[]): Map<string, MemoryRecord[]> {
  const groups = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    const key = normalizeFactText(record.text);
    if (key.length === 0) continue;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [record]);
    } else {
      existing.push(record);
    }
  }
  return groups;
}

function normalizeFactText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}
