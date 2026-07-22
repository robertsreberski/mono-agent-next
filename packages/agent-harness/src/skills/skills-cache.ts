import { stat as fsStat } from "node:fs/promises";
import type { Stats } from "node:fs";

import { loadSelectedSkills, type LoadedSkillContext, type LoadSelectedSkillsInput } from "./skills.js";

/**
 * Underlying loader used to populate the cache. Defaults to {@link loadSelectedSkills};
 * injectable for tests to observe content reads.
 */
export type SkillsLoader = (input: LoadSelectedSkillsInput) => Promise<LoadedSkillContext>;

/**
 * Cheap stat used to validate cache freshness. Defaults to `node:fs/promises` stat;
 * injectable for tests.
 */
export type SkillsStat = (path: string) => Promise<Stats>;

export interface CreateSkillsCacheOptions {
  readonly loader?: SkillsLoader;
  readonly stat?: SkillsStat;
}

export interface SkillsCache {
  /**
   * Returns the previously-loaded context when the selection is unchanged and every
   * selected skill's source file is unchanged (validated via a cheap mtime stat).
   * Otherwise reloads from disk via the underlying loader.
   */
  loadSelectedSkillsCached(input: LoadSelectedSkillsInput): Promise<LoadedSkillContext>;
  /** Drops all memoized entries. */
  clear(): void;
}

interface CacheEntry {
  readonly result: LoadedSkillContext;
  readonly mtimes: ReadonlyMap<string, number>;
}

/**
 * Builds an mtime-invalidated cache around {@link loadSelectedSkills}. The result for a
 * given (skillsRoot, selected names, maxBytes) is memoized and returned without re-reading
 * skill file contents while every selected skill's source `SKILL.md` mtime is unchanged.
 */
export function createSkillsCache(options: CreateSkillsCacheOptions = {}): SkillsCache {
  const loader = options.loader ?? loadSelectedSkills;
  const stat = options.stat ?? fsStat;
  const entries = new Map<string, CacheEntry>();

  async function loadSelectedSkillsCached(input: LoadSelectedSkillsInput): Promise<LoadedSkillContext> {
    const key = cacheKey(input);
    const cached = entries.get(key);
    if (cached !== undefined && (await isFresh(cached, stat))) {
      return cached.result;
    }

    const result = await loader(input);
    entries.set(key, { result, mtimes: await readMtimes(result, stat) });
    return result;
  }

  return {
    loadSelectedSkillsCached,
    clear() {
      entries.clear();
    },
  };
}

function cacheKey(input: LoadSelectedSkillsInput): string {
  // Preserve selection ORDER: loadSelectedSkills returns instructions/loaded in
  // the order the caller listed names, so two different orders must NOT share a
  // cache entry (only the `index` field is sorted, independent of input order).
  const names = Array.isArray(input.names)
    ? input.names.map((name) => (typeof name === "string" ? name.toLowerCase() : String(name)))
    : [];
  return JSON.stringify({ skillsRoot: input.skillsRoot, names, maxBytes: input.maxBytes ?? null });
}

async function isFresh(entry: CacheEntry, stat: SkillsStat): Promise<boolean> {
  // A skill loaded without a recorded mtime means its stat failed during the
  // previous load (e.g. transient FS error). With nothing to validate against we
  // must NOT treat such an entry as fresh — reload so a real failure surfaces.
  // An entry that genuinely loaded zero skills has nothing to invalidate.
  if (entry.mtimes.size < entry.result.loaded.length) {
    return false;
  }
  for (const [mainFile, mtimeMs] of entry.mtimes) {
    let stats: Stats;
    try {
      stats = await stat(mainFile);
    } catch {
      return false;
    }
    if (stats.mtimeMs !== mtimeMs) {
      return false;
    }
  }
  return true;
}

async function readMtimes(result: LoadedSkillContext, stat: SkillsStat): Promise<ReadonlyMap<string, number>> {
  const mtimes = new Map<string, number>();
  for (const skill of result.loaded) {
    try {
      const stats = await stat(skill.mainFile);
      mtimes.set(skill.mainFile, stats.mtimeMs);
    } catch {
      // If the source file vanished between load and stat, record nothing so the next
      // call treats the entry as stale and reloads (which will surface the error).
    }
  }
  return mtimes;
}
