import { lstat, mkdir, opendir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join, normalize, resolve, sep } from "node:path";

import type { Raise } from "./guards.js";

/**
 * Shared, security-critical filesystem and validation helpers for the
 * observability artifact store. These guards are duplicated nowhere else;
 * every recorder/reader/registry module imports from here so the traversal
 * defenses stay identical.
 *
 * The node-free validation helpers and limit constants now live in
 * {@link ./guards.ts} and are re-exported here so every existing importer keeps
 * its current import surface while the node:fs/node:path helpers stay co-located
 * with the filesystem primitives.
 */

export {
  DEFAULT_MAX_RUNS,
  DEFAULT_MAX_EVENTS_PER_RUN,
  DEFAULT_MAX_STRING_BYTES,
  errorMessage,
  isErrno,
  isRecord,
  minInteger,
  positiveInteger,
  stringField,
} from "./guards.js";
export type { Raise, RaiseField } from "./guards.js";

/**
 * Collapse a candidate identifier into a path-safe artifact base name. Any
 * character outside `[a-z0-9._-]` is replaced so the result can never contain a
 * path separator; `safeJoin` still enforces containment as a second layer.
 */
export function safeArtifactName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "run";
}

/** Whether a run id satisfies the shared non-empty/path-containment guard. */
export function isSafeRunId(runId: unknown): runId is string {
  return typeof runId === "string"
    && runId.trim().length > 0
    && !runId.trim().includes("/")
    && !runId.trim().includes("\\")
    && !runId.trim().includes("..");
}

/**
 * Reject a run id that could traverse outside the artifact directory. Empty/
 * non-string ids raise via `raiseEmpty`; traversal-shaped ids raise via
 * `raiseTraversal`. The two callbacks let each package keep its distinct error
 * code/message surface (recorded-runs and trace-sources historically differed
 * on the empty-id code), while the guard logic stays identical.
 */
export function normalizeRunId(runId: string, raiseTraversal: Raise, raiseEmpty: Raise = raiseTraversal): string {
  if (typeof runId !== "string" || runId.trim().length === 0) {
    raiseEmpty("runId must be a non-empty string.");
  }
  const trimmed = runId.trim();
  if (!isSafeRunId(trimmed)) {
    raiseTraversal("runId cannot contain path separators or '..'.");
  }
  return trimmed;
}

/**
 * Resolve `fileName` under `root` and fail closed if the result escapes the
 * (normalized, separator-terminated) root. `raise` carries the package-specific
 * escape message ("escapes artifactDir" vs "escapes registryDir").
 */
export function safeJoin(root: string, fileName: string, raise: Raise): string {
  const normalizedRoot = normalize(resolve(root));
  const resolved = normalize(join(normalizedRoot, fileName));
  const safeRoot = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  if (!resolved.startsWith(safeRoot)) {
    raise("escape");
  }
  return resolved;
}

export const ORPHANED_ATOMIC_WRITE_TEMP_MIN_AGE_MS = 5 * 60 * 1000;
const MAX_ORPHANED_ATOMIC_WRITE_TEMP_ENTRIES_PER_SWEEP = 512;
const MAX_ORPHANED_ATOMIC_WRITE_TEMPS_PER_SWEEP = 128;

const ATOMIC_WRITE_TEMP_PATTERN = /^.+\.(?:events\.jsonl|summary\.json)\.[1-9]\d*\.[1-9]\d*\.tmp$/u;

interface SweepOrphanedAtomicWriteTempsOptions {
  readonly nowMs?: number;
  readonly entryNames?: readonly string[];
}

/**
 * Best-effort cleanup for stale temp files left by interrupted artifact writes.
 * Discovery and deletion are bounded, and every candidate failure is isolated.
 */
export async function sweepOrphanedAtomicWriteTemps(
  directory: string,
  options: SweepOrphanedAtomicWriteTempsOptions = {},
): Promise<number> {
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) return 0;

  const root = resolve(directory);
  const entryNames = options.entryNames ?? await discoverAtomicWriteTempEntries(root);
  const candidates = [...new Set(entryNames)]
    .filter((name) => basename(name) === name && ATOMIC_WRITE_TEMP_PATTERN.test(name))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .slice(0, MAX_ORPHANED_ATOMIC_WRITE_TEMPS_PER_SWEEP);

  let removed = 0;
  for (const name of candidates) {
    try {
      const candidate = safeJoin(root, name, (message) => {
        throw new Error(message);
      });
      const stats = await lstat(candidate);
      if (!stats.isFile() || !Number.isFinite(stats.mtimeMs)) continue;
      if (stats.mtimeMs >= nowMs - ORPHANED_ATOMIC_WRITE_TEMP_MIN_AGE_MS) continue;
      await unlink(candidate);
      removed += 1;
    } catch {
      // Cleanup is hygiene only; leave vanished or unreadable entries for a later pass.
    }
  }
  return removed;
}

async function discoverAtomicWriteTempEntries(directory: string): Promise<string[]> {
  const names: string[] = [];
  let handle: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    handle = await opendir(directory);
    for (let inspected = 0; inspected < MAX_ORPHANED_ATOMIC_WRITE_TEMP_ENTRIES_PER_SWEEP; inspected += 1) {
      const entry = await handle.read();
      if (entry === null) break;
      names.push(entry.name);
    }
  } catch {
    return names;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return names;
}

let atomicWriteSequence = 0;

/**
 * Write a serialized artifact atomically via a temp file + rename, so readers
 * (list/read) never observe a half-written file. The registry already did this;
 * the recorder now shares the same primitive for its summary + events files.
 * The temp name carries a per-process sequence (not a timestamp) so concurrent
 * writers in the same millisecond never collide on the temp path.
 */
export async function writeJsonAtomic(filePath: string, contents: string): Promise<void> {
  atomicWriteSequence += 1;
  const tempPath = `${filePath}.${process.pid}.${atomicWriteSequence}.tmp`;
  await writeFile(tempPath, contents, "utf8");
  await rename(tempPath, filePath);
}

export { mkdir };
