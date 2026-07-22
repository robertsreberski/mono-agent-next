import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ChannelId } from "./channels.js";
import { channelIdForConversation } from "./proactive-notify.js";

/** A real conversation the agent has handled, recovered from run artifacts. */
export interface SeenConversation {
  /** The base (de-bucketed) conversationId to use as a `notify` destination. */
  readonly conversationId: string;
  readonly channelId: ChannelId;
  /** ISO timestamp of the most recent run on this conversation, if recorded. */
  readonly lastSeen?: string;
}

export interface ListSeenOptions {
  /** Cap on the number of (newest-first) summary files read. Default 2000. */
  readonly limit?: number;
}

export interface SeenNotifyDestinationCache {
  /** List destinations, sharing one fresh scan for repeated reads of the same directory. */
  list(artifactDir: string): Promise<readonly SeenConversation[]>;
  /** Fence any cached or in-flight result after a relevant artifact change. */
  invalidate(): void;
}

interface SeenNotifyDestinationCacheOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** Test seam for deterministic scan/race coverage. */
  readonly scan?: (artifactDir: string) => Promise<readonly SeenConversation[]>;
}

const DEFAULT_LIMIT = 2000;
const SUMMARY_SUFFIX = ".summary.json";
const ROLLOVER_BUCKET = /#\d{4}-\d{2}-\d{2}$/u;
/** Max summary files statted concurrently, to bound open fds and avoid EMFILE. */
const STAT_BATCH_SIZE = 64;
/** Short enough to discover other artifact-directory changes without rescanning every notify resolution. */
const SEEN_NOTIFY_DESTINATION_TTL_MS = 30_000;
/** Bound invalidation churn to one older scan plus one refresh per artifact directory. */
const MAX_IN_FLIGHT_SCANS_PER_DIRECTORY = 2;

interface ActiveSeenDestinationScan {
  readonly generation: number;
  readonly promise: Promise<readonly SeenConversation[]>;
}

/**
 * App-lifetime, one-directory cache for {@link listSeenNotifyDestinations}.
 *
 * The cache retains at most one completed value. Concurrent readers of the same
 * directory and generation share one scan; different directories may scan in
 * parallel while their transient map entries are removed on settlement. At
 * most two generations scan one directory concurrently, so repeated
 * invalidations cannot multiply the scanner's bounded stat batch without bound.
 * Invalidation is a generation fence: callers whose scan crossed a relevant
 * artifact change retry the current generation, while a stale scan can neither
 * populate the cache nor clear a newer generation's in-flight scan.
 */
export function createSeenNotifyDestinationCache(
  options: SeenNotifyDestinationCacheOptions = {},
): SeenNotifyDestinationCache {
  const ttlMs = options.ttlMs ?? SEEN_NOTIFY_DESTINATION_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("seen notify destination cache ttlMs must be a positive finite number.");
  }
  const now = options.now ?? (() => Date.now());
  const scan = options.scan ?? ((artifactDir: string) => listSeenNotifyDestinations(artifactDir));
  let generation = 0;
  let cached: {
    readonly artifactDir: string;
    readonly expiresAt: number;
    readonly destinations: readonly SeenConversation[];
  } | undefined;
  const inFlight = new Map<string, ActiveSeenDestinationScan[]>();
  let scanSequence = 0;

  return {
    async list(artifactDir: string): Promise<readonly SeenConversation[]> {
      for (;;) {
        const currentTime = now();
        if (cached !== undefined && cached.artifactDir === artifactDir && currentTime < cached.expiresAt) {
          return cached.destinations;
        }

        const currentGeneration = generation;
        let activeScan: ActiveSeenDestinationScan;
        const activeScans = inFlight.get(artifactDir) ?? [];
        const currentScan = activeScans.find((candidate) => candidate.generation === currentGeneration);
        if (currentScan !== undefined) {
          activeScan = currentScan;
        } else if (activeScans.length >= MAX_IN_FLIGHT_SCANS_PER_DIRECTORY) {
          // One older generation plus one refresh may still be draining. Wait
          // for a slot, then let every waiter join the single current-generation
          // scan created by the first caller that resumes.
          await Promise.race(activeScans.map(({ promise }) => promise.then(
            () => undefined,
            () => undefined,
          )));
          continue;
        } else {
          const sequence = ++scanSequence;
          let promise!: Promise<readonly SeenConversation[]>;
          promise = scan(artifactDir)
            .then((destinations) => {
              if (generation === currentGeneration && sequence === scanSequence) {
                cached = {
                  artifactDir,
                  expiresAt: now() + ttlMs,
                  destinations,
                };
              }
              return destinations;
            })
            .finally(() => {
              const scans = inFlight.get(artifactDir);
              if (scans === undefined) {
                return;
              }
              const remaining = scans.filter((candidate) => candidate.promise !== promise);
              if (remaining.length === 0) {
                inFlight.delete(artifactDir);
              } else if (remaining.length !== scans.length) {
                inFlight.set(artifactDir, remaining);
              }
            });
          activeScan = { generation: currentGeneration, promise };
          if (activeScans.length === 0) {
            inFlight.set(artifactDir, [activeScan]);
          } else {
            activeScans.push(activeScan);
          }
        }

        let destinations: readonly SeenConversation[];
        try {
          destinations = await activeScan.promise;
        } catch (error) {
          if (generation !== activeScan.generation) {
            // An invalidation made this failure obsolete. Join/retry the current
            // generation instead of leaking an error from stale filesystem work.
            continue;
          }
          throw error;
        }
        if (generation === activeScan.generation) {
          return destinations;
        }
        // A relevant run summary changed while this scan was in flight. Retry or
        // join the current generation so unique-destination delivery never acts
        // on a pre-invalidation candidate set.
      }
    },
    invalidate(): void {
      generation += 1;
      cached = undefined;
    },
  };
}

/**
 * Distinct Telegram/Slack conversationIds the agent has actually handled, read
 * from the run-artifact summaries in `artifactDir`. Other schemes (including
 * synthetic `cron:`/`webhook:` ids and WhatsApp) are dropped; daily-rollover
 * buckets are stripped to the base id (the form a `notify` destination uses) and
 * deduped to the most recent sighting. Sorted newest-first. A missing dir yields
 * an empty list.
 */
export async function listSeenNotifyDestinations(
  artifactDir: string,
  options: ListSeenOptions = {},
): Promise<readonly SeenConversation[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  let entries: string[];
  try {
    entries = await readdir(artifactDir);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      // Dir absent (agent never ran) → nothing seen yet.
      return [];
    }
    // Do not turn a transient permission/I/O failure into a cacheable empty
    // candidate set. The per-run resolver contains this failure and the next
    // notification gets an immediate retry instead of waiting for the TTL.
    throw error;
  }

  const summaries = entries.filter((name) => name.endsWith(SUMMARY_SUFFIX));
  // Summary filenames are conversationId-based with no embedded time ordering, so a
  // full stat pass is required to learn each file's mtime before we can take the
  // newest `limit`. We stat in bounded batches (not one big Promise.all over every
  // summary) to keep open file descriptors capped and avoid EMFILE/IO spikes on a
  // busy agent with thousands of artifacts.
  const withMtime: { name: string; mtimeMs: number }[] = [];
  for (let i = 0; i < summaries.length; i += STAT_BATCH_SIZE) {
    const batch = summaries.slice(i, i + STAT_BATCH_SIZE);
    const stated = await Promise.all(
      batch.map(async (name) => {
        try {
          return { name, mtimeMs: (await stat(join(artifactDir, name))).mtimeMs };
        } catch (error) {
          if (nodeErrorCode(error) === "ENOENT") {
            // Retention may remove a file between readdir and stat.
            return undefined;
          }
          throw error;
        }
      }),
    );
    withMtime.push(...stated.filter((entry): entry is { name: string; mtimeMs: number } => entry !== undefined));
  }
  // Newest files first, then cap, so a busy agent's scan stays bounded.
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const latest = new Map<string, SeenConversation>();
  for (const { name } of withMtime.slice(0, limit)) {
    const parsed = await readSummary(join(artifactDir, name));
    if (parsed === undefined) {
      continue;
    }
    const channelId = channelIdForConversation(parsed.conversationId);
    if (channelId !== "telegram" && channelId !== "slack") {
      continue; // synthetic or a push channel without native-notify support
    }
    const conversationId = parsed.conversationId.replace(ROLLOVER_BUCKET, "");
    const seen: SeenConversation = {
      conversationId,
      channelId,
      ...(parsed.lastSeen === undefined ? {} : { lastSeen: parsed.lastSeen }),
    };
    const prior = latest.get(conversationId);
    if (prior === undefined || isNewer(seen.lastSeen, prior.lastSeen)) {
      latest.set(conversationId, seen);
    }
  }

  return [...latest.values()].sort((a, b) => compareLastSeen(b.lastSeen, a.lastSeen));
}

async function readSummary(path: string): Promise<{ conversationId: string; lastSeen?: string } | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      // Retention may remove a file between stat and read.
      return undefined;
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null) {
    return undefined;
  }
  const record = json as Record<string, unknown>;
  const conversationId = record.conversationId;
  if (typeof conversationId !== "string" || conversationId.length === 0) {
    return undefined;
  }
  const lastSeen = firstString(record.endedAt, record.updatedAt, record.startedAt);
  return { conversationId, ...(lastSeen === undefined ? {} : { lastSeen }) };
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function isNewer(candidate: string | undefined, current: string | undefined): boolean {
  return compareLastSeen(candidate, current) > 0;
}

/** Compare ISO timestamps; a missing timestamp sorts oldest. */
function compareLastSeen(a: string | undefined, b: string | undefined): number {
  if (a === b) {
    return 0;
  }
  if (a === undefined) {
    return -1;
  }
  if (b === undefined) {
    return 1;
  }
  return a < b ? -1 : 1;
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
