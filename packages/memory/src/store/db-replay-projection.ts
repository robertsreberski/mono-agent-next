import type {
  ReplayProjectionDbReplacement,
  ReplayProjectionDbSnapshot,
} from "./db-projection-types.js";

const MAX_REPLAY_PROJECTION_ENTRIES = 131_072;
const INVALID_REPLAY_PROJECTION_ID = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export function validateReplayProjectionReplacement(
  memories: ReplayProjectionDbSnapshot["memories"],
  projection: ReplayProjectionDbReplacement,
): ReplayProjectionDbReplacement {
  if (!isExactObjectKeys(projection, ["supersedes", "terminals", "threads"])
    || !Array.isArray(projection.terminals)
    || !Array.isArray(projection.supersedes)
    || !Array.isArray(projection.threads)
    || projection.terminals.length + projection.supersedes.length + projection.threads.length
      > MAX_REPLAY_PROJECTION_ENTRIES) {
    throw new Error("memory-store: invalid replay projection replacement.");
  }

  const terminals = projection.terminals.map((entry) => {
    if (!isExactObjectKeys(entry, ["at", "id"])) {
      throw new Error("memory-store: invalid replay terminal entry.");
    }
    assertReplayProjectionId(entry.id, "terminal id");
    assertExactReplayTimestamp(entry.at, "terminal timestamp");
    return { id: entry.id, at: entry.at };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const supersedes = projection.supersedes.map((entry) => {
    if (!isExactObjectKeys(entry, ["at", "dst", "src"])) {
      throw new Error("memory-store: invalid replay supersede entry.");
    }
    assertReplayProjectionId(entry.src, "supersede source");
    assertReplayProjectionId(entry.dst, "supersede destination");
    assertExactReplayTimestamp(entry.at, "supersede timestamp");
    if (entry.src === entry.dst) throw new Error("memory-store: replay supersede cannot be self-referential.");
    return { src: entry.src, dst: entry.dst, at: entry.at };
  }).sort((left, right) => replayPairKey(left).localeCompare(replayPairKey(right)));
  const threads = projection.threads.map((entry) => {
    if (!isExactObjectKeys(entry, ["at", "dst", "src", "weight"])) {
      throw new Error("memory-store: invalid replay thread entry.");
    }
    assertReplayProjectionId(entry.src, "thread source");
    assertReplayProjectionId(entry.dst, "thread destination");
    assertExactReplayTimestamp(entry.at, "thread timestamp");
    const weight = entry.weight;
    if (entry.src === entry.dst || typeof weight !== "number" || !Number.isFinite(weight)
      || weight <= 0 || weight > 1) {
      throw new Error("memory-store: invalid replay thread topology or weight.");
    }
    return { src: entry.src, dst: entry.dst, weight, at: entry.at };
  }).sort((left, right) => replayPairKey(left).localeCompare(replayPairKey(right)));

  assertUniqueReplayKeys(terminals, (entry) => entry.id, "terminal id");
  assertUniqueReplayKeys(supersedes, (entry) => entry.src, "supersede source");
  assertUniqueReplayKeys(supersedes, (entry) => entry.dst, "supersede destination");
  assertUniqueReplayKeys(threads, replayPairKey, "thread edge");

  const terminalById = new Map(terminals.map((entry) => [entry.id, entry]));
  for (const entry of supersedes) {
    if (terminalById.has(entry.src)) {
      throw new Error("memory-store: replay terminal conflicts with supersede topology.");
    }
  }
  if (hasReplaySupersedeCycle(new Map(supersedes.map((entry) => [entry.src, entry.dst])))) {
    throw new Error("memory-store: replay supersede topology contains a cycle.");
  }
  const threadCounts = new Map<string, number>();
  for (const thread of threads) {
    const count = (threadCounts.get(thread.src) ?? 0) + 1;
    if (count > 5) throw new Error(`memory-store: replay thread source "${thread.src}" exceeds five edges.`);
    threadCounts.set(thread.src, count);
  }

  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  for (const terminal of terminals) {
    const memory = memoryById.get(terminal.id);
    if (memory === undefined || memory.status !== "dropped"
      || exactTimestampMillis(terminal.at) < replayMemoryTimestamp(memory, "terminal")) {
      throw new Error(`memory-store: invalid replay terminal endpoint "${terminal.id}".`);
    }
  }
  for (const supersede of supersedes) {
    const source = memoryById.get(supersede.src);
    const destination = memoryById.get(supersede.dst);
    const destinationTerminal = terminalById.get(supersede.dst);
    const at = exactTimestampMillis(supersede.at);
    if (source === undefined || destination === undefined || source.status !== "invalidated"
      || (destination.status === "dropped" && destinationTerminal === undefined)
      || at < replayMemoryTimestamp(source, "supersede source")
      || at !== replayMemoryTimestamp(destination, "supersede destination")
      || (destinationTerminal !== undefined && exactTimestampMillis(destinationTerminal.at) < at)) {
      throw new Error(`memory-store: invalid replay supersede endpoints (${supersede.src} -> ${supersede.dst}).`);
    }
  }
  for (const thread of threads) {
    const source = memoryById.get(thread.src);
    const destination = memoryById.get(thread.dst);
    const at = exactTimestampMillis(thread.at);
    if (source === undefined || destination === undefined
      || at < replayMemoryTimestamp(source, "thread source")
      || at < replayMemoryTimestamp(destination, "thread destination")) {
      throw new Error(`memory-store: invalid replay thread endpoints (${thread.src} -> ${thread.dst}).`);
    }
  }
  return { terminals, supersedes, threads };
}

export function replayProjectionDbStateMatches(
  snapshot: ReplayProjectionDbSnapshot,
  expected: ReplayProjectionDbReplacement,
): boolean {
  const terminalById = new Map(expected.terminals.map((entry) => [entry.id, entry]));
  const supersedeById = new Map(expected.supersedes.map((entry) => [entry.src, entry]));
  for (const memory of snapshot.memories) {
    const terminal = terminalById.get(memory.id);
    const supersede = supersedeById.get(memory.id);
    if (terminal !== undefined) {
      if (memory.validTo !== terminal.at || memory.supersededBy !== undefined
        || memory.supersededAt !== undefined) return false;
    } else if (supersede !== undefined) {
      if (memory.validTo !== supersede.at || memory.supersededBy !== supersede.dst
        || memory.supersededAt !== supersede.at) return false;
    } else if (memory.validTo !== undefined || memory.supersededBy !== undefined
      || memory.supersededAt !== undefined) return false;
  }

  const actualEdges = snapshot.edges.filter((edge) => edge.kind === "thread" || edge.kind === "supersedes")
    .map((edge) => ({
      src: edge.src,
      dst: edge.dst,
      kind: edge.kind,
      weight: edge.weight,
      at: edge.createdAt,
    }))
    .sort((left, right) => `${left.kind}\0${replayPairKey(left)}`.localeCompare(`${right.kind}\0${replayPairKey(right)}`));
  const expectedEdges = [
    ...expected.supersedes.map((edge) => ({
      src: edge.src,
      dst: edge.dst,
      kind: "supersedes" as const,
      weight: 1,
      at: edge.at,
    })),
    ...expected.threads.map((edge) => ({
      src: edge.src,
      dst: edge.dst,
      kind: "thread" as const,
      weight: edge.weight,
      at: edge.at,
    })),
  ].sort((left, right) => `${left.kind}\0${replayPairKey(left)}`.localeCompare(`${right.kind}\0${replayPairKey(right)}`));
  return JSON.stringify(actualEdges) === JSON.stringify(expectedEdges);
}

function assertUniqueReplayKeys<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  label: string,
): void {
  const keys = new Set<string>();
  for (const value of values) {
    const key = keyOf(value);
    if (keys.has(key)) throw new Error(`memory-store: duplicate replay ${label} "${key}".`);
    keys.add(key);
  }
}

function assertReplayProjectionId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512
    || INVALID_REPLAY_PROJECTION_ID.test(value)) {
    throw new Error(`memory-store: invalid replay ${label}.`);
  }
}

function assertExactReplayTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`memory-store: invalid replay ${label}.`);
  exactTimestampMillis(value);
}

function exactTimestampMillis(value: string): number {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error("memory-store: replay timestamp must be an exact ISO timestamp.");
  }
  return millis;
}

function replayMemoryTimestamp(
  memory: ReplayProjectionDbSnapshot["memories"][number],
  label: string,
): number {
  const millis = Date.parse(memory.createdAt);
  if (!Number.isFinite(millis)) {
    throw new Error(`memory-store: replay ${label} has an invalid memory createdAt.`);
  }
  return millis;
}

function replayPairKey(value: { readonly src: string; readonly dst: string }): string {
  return `${value.src}\0${value.dst}`;
}

function hasReplaySupersedeCycle(successors: ReadonlyMap<string, string>): boolean {
  const complete = new Set<string>();
  for (const start of successors.keys()) {
    if (complete.has(start)) continue;
    const path = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined && !complete.has(current)) {
      if (path.has(current)) return true;
      path.add(current);
      current = successors.get(current);
    }
    for (const id of path) complete.add(id);
  }
  return false;
}

function isExactObjectKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
