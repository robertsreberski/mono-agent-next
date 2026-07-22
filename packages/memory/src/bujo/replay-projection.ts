import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";

import type {
  MemoryDb,
  ReplayProjectionDbReplacement,
  ReplayProjectionDbSnapshot,
} from "../store/db.js";
import {
  CANONICAL_FILE_MISSING,
  canonicalMemoryRootPath,
  listCanonicalFileNames,
  listCanonicalRootFileNames,
  readCanonicalFileSnapshot,
  removeCanonicalFile,
  writeCanonicalFileAtomic,
  type CanonicalFileExpectedState,
  type CanonicalFileIdentity,
} from "./path-safety.js";

export const REPLAY_PROJECTION_FILE = ".replay-projection-v1.json";
export const MAX_REPLAY_PROJECTION_BYTES = 32 * 1024 * 1024;
export const MAX_REPLAY_PROJECTION_ENTRIES = 131_072;
const MAX_REPLAY_PROJECTION_TEMPORARIES = 32;
const REPLAY_PROJECTION_TEMP_RE = /^\.\.replay-projection-v1\.json-[a-f0-9-]{36}\.tmp$/u;

export type ReplayProjectionAuthorityKind = "capture" | "migration" | "legacy-adoption";

interface ReplayProjectionAuthority {
  readonly authorityKind: ReplayProjectionAuthorityKind;
  readonly authorityId: string;
}

export interface ReplayProjectionTerminal extends ReplayProjectionAuthority {
  readonly id: string;
  readonly at: string;
}

export interface ReplayProjectionSupersede extends ReplayProjectionAuthority {
  readonly src: string;
  readonly dst: string;
  readonly at: string;
}

export interface ReplayProjectionThread extends ReplayProjectionAuthority {
  readonly src: string;
  readonly dst: string;
  readonly weight: number;
  readonly at: string;
}

export interface ReplayProjectionV1 {
  readonly schemaVersion: 1;
  readonly terminals: readonly ReplayProjectionTerminal[];
  readonly supersedes: readonly ReplayProjectionSupersede[];
  readonly threads: readonly ReplayProjectionThread[];
}

export interface ReplayProjectionDelta {
  readonly terminals?: readonly ReplayProjectionTerminal[];
  readonly supersedes?: readonly ReplayProjectionSupersede[];
  readonly threads?: readonly ReplayProjectionThread[];
}

export interface ReplayProjectionSubsetOptions {
  /**
   * Historical capture intents did not persist their thread timestamp. Their
   * already-applied SQLite edge may therefore carry a wall-clock timestamp.
   * The structural snapshot still proves that timestamp is exact and no
   * earlier than either endpoint; only these explicitly identified pairs may
   * ignore timestamp equality while the projection normalizes them.
   */
  readonly legacyThreadTimestampKeys?: ReadonlySet<string>;
}

export interface PendingReplayProjectionAuthority {
  readonly projection: ReplayProjectionV1;
  /** ADD owns the complete thread keyspace rooted at each source. */
  readonly ownedThreadSources: readonly string[];
  /** SUPERSEDE/forget own the complete lifecycle keyspace for each source. */
  readonly ownedLifecycleSources: readonly string[];
  /** Exact legacy ADD pairs whose old durable payload omitted a timestamp. */
  readonly legacyThreadTimestampKeys?: readonly string[];
}

export type ReplayProjectionFileState =
  | { readonly kind: "missing" }
  | { readonly kind: "present"; readonly identity: CanonicalFileIdentity };

export interface ReplayProjectionReadState {
  readonly projection: ReplayProjectionV1;
  readonly state: ReplayProjectionFileState;
}

export interface ReplayProjectionTemporaryAudit {
  readonly valid: boolean;
  readonly temporary: number;
  readonly digest: string;
}

export interface PreparedReplayProjectionPublication {
  readonly prior: ReplayProjectionReadState;
  readonly projection: ReplayProjectionV1;
  readonly expectedIdentity: CanonicalFileExpectedState;
  readonly changed: boolean;
}

const AUTHORITY_ID = /^[0-9a-f]{64}$/iu;
const INVALID_ID = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export function emptyReplayProjection(): ReplayProjectionV1 {
  return { schemaVersion: 1, terminals: [], supersedes: [], threads: [] };
}

/** Domain-separated SHA-256 of a strict, recursively key-sorted JSON value. */
export function replayProjectionAuthorityId(value: unknown): string {
  const encoded = JSON.stringify(canonicalAuthorityValue(value, new Set<object>()));
  if (Buffer.byteLength(encoded, "utf8") > MAX_REPLAY_PROJECTION_BYTES) {
    throw new Error("memory-replay-projection: authority input exceeds 32 MiB.");
  }
  return createHash("sha256")
    .update("mono-agent-memory-replay-authority-v1\0", "utf8")
    .update(encoded, "utf8")
    .digest("hex");
}

/** Parse exact canonical bytes; alternate keys, formatting, order, and duplicates fail closed. */
export function parseReplayProjectionStrict(raw: string): ReplayProjectionV1 {
  if (Buffer.byteLength(raw, "utf8") > MAX_REPLAY_PROJECTION_BYTES) {
    throw new Error("memory-replay-projection: sidecar exceeds 32 MiB.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("memory-replay-projection: sidecar is not valid JSON.");
  }
  const projection = normalizeProjection(parsed);
  if (serializeNormalizedProjection(projection) !== raw) {
    throw new Error("memory-replay-projection: sidecar is not in canonical serialized form.");
  }
  return projection;
}

export function serializeReplayProjection(projection: ReplayProjectionV1): string {
  return serializeNormalizedProjection(normalizeProjection(projection));
}

/** Missing is a valid, distinguishable empty authority; unsafe files never degrade to missing. */
export function readReplayProjectionStrict(root: string): ReplayProjectionReadState {
  const snapshot = readCanonicalFileSnapshot(root, REPLAY_PROJECTION_FILE, {
    allowMissing: true,
    maxBytes: MAX_REPLAY_PROJECTION_BYTES,
  });
  if (snapshot === undefined) return { projection: emptyReplayProjection(), state: { kind: "missing" } };
  if ((snapshot.identity.mode & 0o777) !== 0o600
    || snapshot.identity.nlink !== 1
    || (typeof process.getuid === "function" && snapshot.identity.uid !== process.getuid())) {
    throw new Error("memory-replay-projection: sidecar must be owner-only mode 0600.");
  }
  return {
    projection: parseReplayProjectionStrict(snapshot.content),
    state: { kind: "present", identity: snapshot.identity },
  };
}

/** Metadata-only inventory of abandoned atomic sidecar publications. */
export function auditReplayProjectionTemporaryArtifacts(root: string): ReplayProjectionTemporaryAudit {
  let names: string[] = [];
  try {
    names = listCanonicalRootFileNames(root, {
      allowMissing: true,
      include: (name) => REPLAY_PROJECTION_TEMP_RE.test(name),
    });
    const canonicalRoot = canonicalMemoryRootPath(root, false);
    let valid = names.length <= MAX_REPLAY_PROJECTION_TEMPORARIES;
    const observations = names.map((name) => {
      const stat = lstatSync(join(canonicalRoot, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_REPLAY_PROJECTION_BYTES
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
        valid = false;
      }
      return {
        name,
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        mode: stat.mode,
        nlink: stat.nlink,
        uid: stat.uid,
      };
    });
    return {
      valid,
      temporary: names.length,
      digest: replayProjectionAuthorityId({ kind: "replay-temporary-audit", observations }),
    };
  } catch {
    return {
      valid: false,
      temporary: Math.max(1, names.length),
      digest: createHash("sha256").update("invalid-replay-temporary-audit").digest("hex"),
    };
  }
}

/**
 * Remove only a bounded, fully pinned, owner-only replay temp inventory.
 * Callers must hold the root memory-writer lease, proving no legitimate
 * publication is live. Any unsafe member rejects the whole preflight before
 * the first removal.
 */
export function cleanupReplayProjectionTemporaryArtifacts(root: string): number {
  const names = listCanonicalRootFileNames(root, {
    allowMissing: true,
    include: (name) => REPLAY_PROJECTION_TEMP_RE.test(name),
  });
  if (names.length > MAX_REPLAY_PROJECTION_TEMPORARIES) {
    throw new Error("memory-replay-projection: abandoned temporary inventory exceeds the cleanup bound.");
  }
  const canonicalRoot = canonicalMemoryRootPath(root, false);
  const pinned = names.map((name) => {
    const stat = lstatSync(join(canonicalRoot, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_REPLAY_PROJECTION_BYTES
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("memory-replay-projection: abandoned temporary is not a safe owner-only file.");
    }
    return {
      name,
      identity: {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        mode: stat.mode,
        nlink: stat.nlink,
        uid: stat.uid,
      },
    };
  });
  for (const entry of pinned) removeCanonicalFile(root, entry.name, entry.identity);
  return pinned.length;
}

/** Idempotently create an empty authority without replacing a present projection. */
export function initializeReplayProjection(root: string): ReplayProjectionReadState {
  const current = readReplayProjectionStrict(root);
  if (current.state.kind === "present") return current;
  return publishPreparedReplayProjection(root, prepareReplayProjectionPublication(
    root,
    emptyReplayProjection(),
    { requireMissing: true },
  ));
}

/** Pure cumulative preflight for multiple durable authorities. */
export function mergeReplayProjection(
  base: ReplayProjectionV1,
  delta: ReplayProjectionDelta,
): ReplayProjectionV1 {
  const normalizedBase = normalizeProjection(base);
  const normalizedDelta = normalizeDelta(delta);
  const terminals = mergeExactEntries(
    normalizedBase.terminals,
    normalizedDelta.terminals,
    (entry) => entry.id,
    "terminal",
  );
  const supersedes = mergeExactEntries(
    normalizedBase.supersedes,
    normalizedDelta.supersedes,
    (entry) => entry.src,
    "supersede",
  );
  const threads = mergeExactEntries(
    normalizedBase.threads,
    normalizedDelta.threads,
    replayPairKey,
    "thread",
  );
  return normalizeProjection({ schemaVersion: 1, terminals, supersedes, threads });
}

/** Backward-compatible explicit name used by the durable replay integration. */
export const mergeReplayProjectionDelta = mergeReplayProjection;

export function assertProjectionContainsDelta(
  projection: ReplayProjectionV1,
  delta: ReplayProjectionDelta,
): void {
  const normalized = normalizeProjection(projection);
  const expected = normalizeDelta(delta);
  assertContainsExact(normalized.terminals, expected.terminals, (entry) => entry.id, "terminal");
  assertContainsExact(normalized.supersedes, expected.supersedes, (entry) => entry.src, "supersede");
  assertContainsExact(normalized.threads, expected.threads, replayPairKey, "thread");
}

export function prepareReplayProjectionDelta(
  root: string,
  delta: ReplayProjectionDelta,
): PreparedReplayProjectionPublication {
  const prior = readReplayProjectionStrict(root);
  return preparedPublication(prior, mergeReplayProjection(prior.projection, delta));
}

/** Full publication is intentionally restricted to first-time explicit initialization/adoption. */
export function prepareReplayProjectionPublication(
  root: string,
  projection: ReplayProjectionV1,
  _options: { readonly requireMissing: true },
): PreparedReplayProjectionPublication {
  const prior = readReplayProjectionStrict(root);
  if (prior.state.kind !== "missing") {
    throw new Error("memory-replay-projection: full publication requires a missing sidecar.");
  }
  return preparedPublication(prior, normalizeProjection(projection));
}

export function publishPreparedReplayProjection(
  root: string,
  prepared: PreparedReplayProjectionPublication,
): ReplayProjectionReadState {
  assertPreparedState(prepared);
  if (!prepared.changed) {
    const current = readReplayProjectionStrict(root);
    if (current.state.kind !== "present" || prepared.prior.state.kind !== "present"
      || !sameIdentity(current.state.identity, prepared.prior.state.identity)
      || serializeReplayProjection(current.projection) !== serializeReplayProjection(prepared.projection)) {
      throw new Error("memory-replay-projection: unchanged publication lost compare-and-swap.");
    }
    return current;
  }
  writeCanonicalFileAtomic(
    root,
    REPLAY_PROJECTION_FILE,
    serializeReplayProjection(prepared.projection),
    prepared.expectedIdentity,
  );
  const published = readReplayProjectionStrict(root);
  if (published.state.kind !== "present"
    || serializeReplayProjection(published.projection) !== serializeReplayProjection(prepared.projection)) {
    throw new Error("memory-replay-projection: published sidecar did not match prepared projection.");
  }
  return published;
}

export function prepareAndPublishReplayProjectionDelta(
  root: string,
  delta: ReplayProjectionDelta,
): ReplayProjectionReadState {
  return publishPreparedReplayProjection(root, prepareReplayProjectionDelta(root, delta));
}

export function replayProjectionDbSnapshot(db: MemoryDb): ReplayProjectionDbReplacement {
  const snapshot = readRawDbSnapshot(db);
  const terminals: Array<{ id: string; at: string }> = [];
  const supersedes: Array<{ src: string; dst: string; at: string }> = [];
  const threads: Array<{ src: string; dst: string; weight: number; at: string }> = [];
  for (const memory of snapshot.memories) {
    const fields = [memory.validTo, memory.supersededBy, memory.supersededAt];
    const present = fields.filter((value) => value !== undefined).length;
    if (present === 0) continue;
    if (memory.validTo !== undefined && memory.supersededBy === undefined && memory.supersededAt === undefined) {
      terminals.push({ id: memory.id, at: memory.validTo });
    } else if (present === 3 && memory.validTo === memory.supersededAt) {
      supersedes.push({ src: memory.id, dst: memory.supersededBy!, at: memory.supersededAt! });
    } else {
      throw new Error(`memory-replay-projection: partial DB lifecycle for "${memory.id}".`);
    }
  }
  for (const edge of snapshot.edges) {
    if (edge.kind === "thread") {
      threads.push({ src: edge.src, dst: edge.dst, weight: edge.weight, at: edge.createdAt });
    }
  }
  const authorityId = "0".repeat(64);
  const projection = normalizeProjection({
    schemaVersion: 1,
    terminals: terminals.map((entry) => ({ ...entry, authorityKind: "legacy-adoption", authorityId })),
    supersedes: supersedes.map((entry) => ({ ...entry, authorityKind: "legacy-adoption", authorityId })),
    threads: threads.map((entry) => ({ ...entry, authorityKind: "legacy-adoption", authorityId })),
  });
  assertProjectionMatchesSnapshot(snapshot, projection);
  return replayProjectionDbReplacement(projection);
}

/**
 * Missing-sidecar upgrade guard: every complete replay entry already present
 * in SQLite must be explained exactly by a still-durable projection. Expected
 * entries may be absent because a crash can precede their DB application.
 */
export function assertReplayDbStateSubsetOfProjection(
  db: MemoryDb,
  expectedProjection: ReplayProjectionV1,
  options: ReplayProjectionSubsetOptions = {},
): void {
  const actual = replayProjectionDbSnapshot(db);
  const expected = replayProjectionDbReplacement(expectedProjection);
  assertReplaySubset(
    actual.terminals,
    expected.terminals,
    (entry) => entry.id,
    (left, right) => left.id === right.id && left.at === right.at,
    "terminal",
  );
  assertReplaySubset(
    actual.supersedes,
    expected.supersedes,
    (entry) => entry.src,
    (left, right) => left.src === right.src && left.dst === right.dst && left.at === right.at,
    "supersede",
  );
  assertReplaySubset(
    actual.threads,
    expected.threads,
    replayPairKey,
    (left, right) => left.src === right.src && left.dst === right.dst
      && left.weight === right.weight
      && (left.at === right.at || options.legacyThreadTimestampKeys?.has(replayPairKey(left)) === true),
    "thread",
  );
}

/**
 * Partition one stopped DB into pending-owned replay authority and historical
 * residual. Pending entries may be absent before their DB phase, but an
 * already-present entry must match its durable authority exactly. Historical
 * residual receives one explicit legacy-adoption authority.
 */
export function composeAdoptedReplayProjection(
  db: MemoryDb,
  pending: PendingReplayProjectionAuthority,
  legacyAuthorityId: string,
): ReplayProjectionV1 {
  const normalizedPending = mergeReplayProjection(emptyReplayProjection(), {
    terminals: pending.projection.terminals,
    supersedes: pending.projection.supersedes,
    threads: pending.projection.threads,
  });
  const pendingDb = replayProjectionDbReplacement(normalizedPending);
  const actual = replayProjectionDbSnapshot(db);
  const ownedThreadSources = new Set(pending.ownedThreadSources);
  const ownedLifecycleSources = new Set(pending.ownedLifecycleSources);
  const legacyThreadKeys = new Set(pending.legacyThreadTimestampKeys ?? []);
  const expectedTerminals = new Map(pendingDb.terminals.map((entry) => [entry.id, entry]));
  const expectedSupersedes = new Map(pendingDb.supersedes.map((entry) => [entry.src, entry]));
  const expectedThreads = new Map(pendingDb.threads.map((entry) => [replayPairKey(entry), entry]));
  const pendingTerminalAuthority = new Map(normalizedPending.terminals.map((entry) => [entry.id, entry]));
  const pendingSupersedeAuthority = new Map(normalizedPending.supersedes.map((entry) => [entry.src, entry]));
  const pendingThreadAuthority = new Map(normalizedPending.threads.map((entry) => [replayPairKey(entry), entry]));

  for (const entry of pendingDb.terminals) {
    if (!ownedLifecycleSources.has(entry.id)) {
      throw new Error("memory-replay-projection: pending terminal is outside its owned lifecycle keyspace.");
    }
  }
  for (const entry of pendingDb.supersedes) {
    if (!ownedLifecycleSources.has(entry.src)) {
      throw new Error("memory-replay-projection: pending supersede is outside its owned lifecycle keyspace.");
    }
  }
  for (const entry of pendingDb.threads) {
    if (!ownedThreadSources.has(entry.src)) {
      throw new Error("memory-replay-projection: pending thread is outside its owned source keyspace.");
    }
  }
  if ([...legacyThreadKeys].some((key) => !expectedThreads.has(key))) {
    throw new Error("memory-replay-projection: legacy timestamp exception has no pending thread authority.");
  }

  const authorityId = normalizeAuthorityId(legacyAuthorityId);
  const residualTerminals: ReplayProjectionTerminal[] = [];
  const residualSupersedes: ReplayProjectionSupersede[] = [];
  const residualThreads: ReplayProjectionThread[] = [];
  const matchedPendingTerminals: ReplayProjectionTerminal[] = [];
  const matchedPendingSupersedes: ReplayProjectionSupersede[] = [];
  const matchedPendingThreads: ReplayProjectionThread[] = [];
  for (const entry of actual.terminals) {
    if (ownedLifecycleSources.has(entry.id)) {
      const expected = expectedTerminals.get(entry.id);
      if (expected === undefined || expected.at !== entry.at || expectedSupersedes.has(entry.id)) {
        throw new Error("memory-replay-projection: pending-owned lifecycle differs from durable authority.");
      }
      matchedPendingTerminals.push(pendingTerminalAuthority.get(entry.id)!);
      continue;
    }
    residualTerminals.push({ ...entry, authorityKind: "legacy-adoption", authorityId });
  }
  for (const entry of actual.supersedes) {
    if (ownedLifecycleSources.has(entry.src)) {
      const expected = expectedSupersedes.get(entry.src);
      if (expected === undefined || expected.dst !== entry.dst || expected.at !== entry.at
        || expectedTerminals.has(entry.src)) {
        throw new Error("memory-replay-projection: pending-owned lifecycle differs from durable authority.");
      }
      matchedPendingSupersedes.push(pendingSupersedeAuthority.get(entry.src)!);
      continue;
    }
    residualSupersedes.push({ ...entry, authorityKind: "legacy-adoption", authorityId });
  }
  for (const entry of actual.threads) {
    if (ownedThreadSources.has(entry.src)) {
      const key = replayPairKey(entry);
      const expected = expectedThreads.get(key);
      if (expected === undefined || expected.weight !== entry.weight
        || (expected.at !== entry.at && !legacyThreadKeys.has(key))) {
        throw new Error("memory-replay-projection: pending-owned thread differs from durable authority.");
      }
      // Old intents omitted their wall-clock edge timestamp. Bind the pending
      // authority's deterministic endpoint timestamp so normal recovery can
      // normalize the already-present edge in one total replacement.
      matchedPendingThreads.push(pendingThreadAuthority.get(key)!);
      continue;
    }
    residualThreads.push({ ...entry, authorityKind: "legacy-adoption", authorityId });
  }

  const matchedPending = mergeReplayProjection(emptyReplayProjection(), {
    terminals: matchedPendingTerminals,
    supersedes: matchedPendingSupersedes,
    threads: matchedPendingThreads,
  });
  // Validate the complete future H + P topology now even though missing P is
  // intentionally not published until its ordinary protocol reaches that
  // phase. This prevents adoption from deferring a cycle/fan-in/thread-limit
  // wedge to restart recovery.
  mergeReplayProjection(normalizedPending, {
    terminals: residualTerminals,
    supersedes: residualSupersedes,
    threads: residualThreads,
  });
  return mergeReplayProjection(matchedPending, {
    terminals: residualTerminals,
    supersedes: residualSupersedes,
    threads: residualThreads,
  });
}

/** Exact daily + graph + replay byte fingerprint used by durable source CAS. */
export function readBujoCanonicalSourceFingerprint(root: string): string {
  return readBujoSourceFingerprint(root, true);
}

/** Exact daily + graph byte fingerprint used to fence first sidecar publication. */
export function readBujoCanonicalBaseFingerprint(root: string): string {
  return readBujoSourceFingerprint(root, false);
}

function readBujoSourceFingerprint(root: string, includeReplay: boolean): string {
  const dailyNames = new Set(listCanonicalFileNames(root, "daily", {
    allowMissing: true,
    include: (name) => name.endsWith(".md"),
  }));
  const graphPresent = readCanonicalFileSnapshot(root, "graph.jsonl", { allowMissing: true }) !== undefined;
  const replayPresent = includeReplay && readReplayProjectionStrict(root).state.kind === "present";
  const paths = [
    ...listCanonicalRootFileNames(root, {
      include: (name) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(name) && !dailyNames.has(name),
    }),
    ...[...dailyNames].sort().map((name) => `daily/${name}`),
    ...(graphPresent ? ["graph.jsonl"] : []),
    ...(replayPresent ? [REPLAY_PROJECTION_FILE] : []),
  ];
  const hash = createHash("sha256");
  for (const path of paths) {
    const snapshot = readCanonicalFileSnapshot(root, path, {
      ...(path === REPLAY_PROJECTION_FILE ? { maxBytes: MAX_REPLAY_PROJECTION_BYTES } : {}),
    });
    if (snapshot === undefined) {
      throw new Error(`memory-replay-projection: canonical source "${path}" disappeared during fingerprinting.`);
    }
    const bytes = Buffer.from(snapshot.content, "utf8");
    hash.update(String(Buffer.byteLength(path)));
    hash.update("\0");
    hash.update(path);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function assertReplayProjectionMatchesDb(db: MemoryDb, projection: ReplayProjectionV1): void {
  assertProjectionMatchesSnapshot(readRawDbSnapshot(db), normalizeProjection(projection));
}

/** Explicit, structural-only adoption helper; callers must separately authorize first publication. */
export function legacyReplayProjectionFromDb(db: MemoryDb, authorityId: string): ReplayProjectionV1 {
  const normalizedAuthorityId = normalizeAuthorityId(authorityId);
  const snapshot = readRawDbSnapshot(db);
  const terminals: ReplayProjectionTerminal[] = [];
  const supersedes: ReplayProjectionSupersede[] = [];
  const threads: ReplayProjectionThread[] = [];
  for (const memory of snapshot.memories) {
    const present = [memory.validTo, memory.supersededBy, memory.supersededAt]
      .filter((value) => value !== undefined).length;
    if (present === 0) continue;
    if (memory.validTo !== undefined && memory.supersededBy === undefined && memory.supersededAt === undefined) {
      terminals.push({
        id: memory.id,
        at: memory.validTo,
        authorityKind: "legacy-adoption",
        authorityId: normalizedAuthorityId,
      });
      continue;
    }
    if (present !== 3 || memory.validTo !== memory.supersededAt) {
      throw new Error(`memory-replay-projection: partial legacy lifecycle for "${memory.id}".`);
    }
    supersedes.push({
      src: memory.id,
      dst: memory.supersededBy!,
      at: memory.supersededAt!,
      authorityKind: "legacy-adoption",
      authorityId: normalizedAuthorityId,
    });
  }
  for (const edge of snapshot.edges) {
    if (edge.kind === "thread") {
      threads.push({
        src: edge.src,
        dst: edge.dst,
        weight: edge.weight,
        at: edge.createdAt,
        authorityKind: "legacy-adoption",
        authorityId: normalizedAuthorityId,
      });
    }
  }
  const projection = normalizeProjection({ schemaVersion: 1, terminals, supersedes, threads });
  assertProjectionMatchesSnapshot(snapshot, projection);
  return projection;
}

export function replayProjectionDbReplacement(projection: ReplayProjectionV1): ReplayProjectionDbReplacement {
  const normalized = normalizeProjection(projection);
  return {
    terminals: normalized.terminals.map(({ id, at }) => ({ id, at })),
    supersedes: normalized.supersedes.map(({ src, dst, at }) => ({ src, dst, at })),
    threads: normalized.threads.map(({ src, dst, weight, at }) => ({ src, dst, weight, at })),
  };
}

function preparedPublication(
  prior: ReplayProjectionReadState,
  projection: ReplayProjectionV1,
): PreparedReplayProjectionPublication {
  return {
    prior,
    projection,
    expectedIdentity: prior.state.kind === "missing" ? CANONICAL_FILE_MISSING : prior.state.identity,
    changed: prior.state.kind === "missing"
      || serializeReplayProjection(prior.projection) !== serializeReplayProjection(projection),
  };
}

function assertPreparedState(prepared: PreparedReplayProjectionPublication): void {
  const prior = normalizeProjection(prepared.prior.projection);
  const projection = normalizeProjection(prepared.projection);
  if (prepared.prior.state.kind === "missing"
    && serializeReplayProjection(prior) !== serializeReplayProjection(emptyReplayProjection())) {
    throw new Error("memory-replay-projection: prepared missing state must carry an empty prior projection.");
  }
  const expectedChanged = prepared.prior.state.kind === "missing"
    || serializeReplayProjection(prior) !== serializeReplayProjection(projection);
  if (prepared.changed !== expectedChanged) {
    throw new Error("memory-replay-projection: prepared changed flag is inconsistent.");
  }
  if (prepared.prior.state.kind === "missing") {
    if (prepared.expectedIdentity !== CANONICAL_FILE_MISSING) {
      throw new Error("memory-replay-projection: prepared missing CAS state is inconsistent.");
    }
  } else if (prepared.expectedIdentity === CANONICAL_FILE_MISSING
    || !sameIdentity(prepared.expectedIdentity, prepared.prior.state.identity)) {
    throw new Error("memory-replay-projection: prepared present CAS state is inconsistent.");
  }
}

function normalizeProjection(value: unknown): ReplayProjectionV1 {
  if (!hasExactKeys(value, ["schemaVersion", "supersedes", "terminals", "threads"])
    || value.schemaVersion !== 1
    || !Array.isArray(value.terminals)
    || !Array.isArray(value.supersedes)
    || !Array.isArray(value.threads)) {
    throw new Error("memory-replay-projection: invalid v1 sidecar schema.");
  }
  const normalized = normalizeProjectionEntries(value.terminals, value.supersedes, value.threads);
  if (normalized.terminals.length !== value.terminals.length
    || normalized.supersedes.length !== value.supersedes.length
    || normalized.threads.length !== value.threads.length) {
    throw new Error("memory-replay-projection: sidecar entries must be unique.");
  }
  return normalized;
}

function normalizeDelta(value: ReplayProjectionDelta): Required<ReplayProjectionDelta> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("memory-replay-projection: invalid delta.");
  }
  const keys = Object.keys(value).sort();
  if (keys.some((key) => key !== "supersedes" && key !== "terminals" && key !== "threads")
    || (value.terminals !== undefined && !Array.isArray(value.terminals))
    || (value.supersedes !== undefined && !Array.isArray(value.supersedes))
    || (value.threads !== undefined && !Array.isArray(value.threads))) {
    throw new Error("memory-replay-projection: invalid delta schema.");
  }
  const normalized = normalizeProjectionEntries(
    value.terminals ?? [],
    value.supersedes ?? [],
    value.threads ?? [],
  );
  return {
    terminals: normalized.terminals,
    supersedes: normalized.supersedes,
    threads: normalized.threads,
  };
}

function normalizeProjectionEntries(
  rawTerminals: readonly unknown[],
  rawSupersedes: readonly unknown[],
  rawThreads: readonly unknown[],
): ReplayProjectionV1 {
  if (rawTerminals.length + rawSupersedes.length + rawThreads.length > MAX_REPLAY_PROJECTION_ENTRIES) {
    throw new Error("memory-replay-projection: sidecar exceeds 131072 entries.");
  }
  const terminals = collapseExactEntries(
    rawTerminals.map(normalizeTerminal),
    (entry) => entry.id,
    "terminal",
  ).sort((left, right) => left.id.localeCompare(right.id));
  const supersedes = collapseExactEntries(
    rawSupersedes.map(normalizeSupersede),
    (entry) => entry.src,
    "supersede",
  ).sort((left, right) => replayPairKey(left).localeCompare(replayPairKey(right)));
  const threads = collapseExactEntries(
    rawThreads.map(normalizeThread),
    replayPairKey,
    "thread",
  ).sort((left, right) => replayPairKey(left).localeCompare(replayPairKey(right)));

  const destinations = new Set<string>();
  const terminalsById = new Set(terminals.map((entry) => entry.id));
  const successors = new Map<string, string>();
  for (const entry of supersedes) {
    if (destinations.has(entry.dst)) {
      throw new Error(`memory-replay-projection: duplicate supersede destination "${entry.dst}".`);
    }
    destinations.add(entry.dst);
    if (terminalsById.has(entry.src)) {
      throw new Error("memory-replay-projection: terminal conflicts with supersede topology.");
    }
    successors.set(entry.src, entry.dst);
  }
  if (hasCycle(successors)) throw new Error("memory-replay-projection: supersede topology contains a cycle.");
  const threadCounts = new Map<string, number>();
  for (const thread of threads) {
    const count = (threadCounts.get(thread.src) ?? 0) + 1;
    if (count > 5) {
      throw new Error(`memory-replay-projection: thread source "${thread.src}" exceeds five edges.`);
    }
    threadCounts.set(thread.src, count);
  }
  return { schemaVersion: 1, terminals, supersedes, threads };
}

function normalizeTerminal(value: unknown): ReplayProjectionTerminal {
  if (!hasExactKeys(value, ["at", "authorityId", "authorityKind", "id"])) {
    throw new Error("memory-replay-projection: invalid terminal entry.");
  }
  return {
    id: normalizeId(value.id, "terminal id"),
    at: normalizeTimestamp(value.at, "terminal timestamp"),
    authorityKind: normalizeAuthorityKind(value.authorityKind),
    authorityId: normalizeAuthorityId(value.authorityId),
  };
}

function normalizeSupersede(value: unknown): ReplayProjectionSupersede {
  if (!hasExactKeys(value, ["at", "authorityId", "authorityKind", "dst", "src"])) {
    throw new Error("memory-replay-projection: invalid supersede entry.");
  }
  const src = normalizeId(value.src, "supersede source");
  const dst = normalizeId(value.dst, "supersede destination");
  if (src === dst) throw new Error("memory-replay-projection: supersede cannot be self-referential.");
  return {
    src,
    dst,
    at: normalizeTimestamp(value.at, "supersede timestamp"),
    authorityKind: normalizeAuthorityKind(value.authorityKind),
    authorityId: normalizeAuthorityId(value.authorityId),
  };
}

function normalizeThread(value: unknown): ReplayProjectionThread {
  if (!hasExactKeys(value, ["at", "authorityId", "authorityKind", "dst", "src", "weight"])) {
    throw new Error("memory-replay-projection: invalid thread entry.");
  }
  const src = normalizeId(value.src, "thread source");
  const dst = normalizeId(value.dst, "thread destination");
  if (src === dst || typeof value.weight !== "number" || !Number.isFinite(value.weight)
    || value.weight <= 0 || value.weight > 1) {
    throw new Error("memory-replay-projection: invalid thread topology or weight.");
  }
  return {
    src,
    dst,
    weight: value.weight,
    at: normalizeTimestamp(value.at, "thread timestamp"),
    authorityKind: normalizeAuthorityKind(value.authorityKind),
    authorityId: normalizeAuthorityId(value.authorityId),
  };
}

function assertProjectionMatchesSnapshot(snapshot: ReplayProjectionDbSnapshot, projection: ReplayProjectionV1): void {
  const terminalById = new Map(projection.terminals.map((entry) => [entry.id, entry]));
  const supersedeById = new Map(projection.supersedes.map((entry) => [entry.src, entry]));
  const memoryById = new Map(snapshot.memories.map((memory) => [memory.id, memory]));
  if (memoryById.size !== snapshot.memories.length) {
    throw new Error("memory-replay-projection: duplicate DB memory id.");
  }
  for (const memory of snapshot.memories) {
    const terminal = terminalById.get(memory.id);
    const supersede = supersedeById.get(memory.id);
    if (terminal !== undefined) {
      if (memory.status !== "dropped" || memory.validTo !== terminal.at
        || memory.supersededBy !== undefined || memory.supersededAt !== undefined
        || timestampMillis(terminal.at, true) < timestampMillis(memory.createdAt, false)) {
        throw new Error(`memory-replay-projection: DB terminal mismatch for "${memory.id}".`);
      }
    } else if (supersede !== undefined) {
      const destination = memoryById.get(supersede.dst);
      const destinationTerminal = terminalById.get(supersede.dst);
      const at = timestampMillis(supersede.at, true);
      if (memory.status !== "invalidated" || destination === undefined
        || (destination.status === "dropped" && destinationTerminal === undefined)
        || memory.validTo !== supersede.at || memory.supersededBy !== supersede.dst
        || memory.supersededAt !== supersede.at
        || at < timestampMillis(memory.createdAt, false)
        || at !== timestampMillis(destination.createdAt, false)
        || (destinationTerminal !== undefined
          && timestampMillis(destinationTerminal.at, true) < at)) {
        throw new Error(`memory-replay-projection: DB supersede mismatch for "${memory.id}".`);
      }
    } else if (memory.validTo !== undefined || memory.supersededBy !== undefined
      || memory.supersededAt !== undefined) {
      throw new Error(`memory-replay-projection: unattested DB lifecycle for "${memory.id}".`);
    }
  }
  if (terminalById.size !== projection.terminals.length || supersedeById.size !== projection.supersedes.length
    || [...terminalById.keys()].some((id) => !memoryById.has(id))) {
    throw new Error("memory-replay-projection: projection has an unknown lifecycle endpoint.");
  }
  for (const supersede of projection.supersedes) {
    if (!memoryById.has(supersede.src) || !memoryById.has(supersede.dst)) {
      throw new Error("memory-replay-projection: projection has an unknown supersede endpoint.");
    }
  }
  for (const thread of projection.threads) {
    if (!memoryById.has(thread.src) || !memoryById.has(thread.dst)) {
      throw new Error("memory-replay-projection: projection has an unknown thread endpoint.");
    }
  }

  const expectedThreads = new Map(projection.threads.map((entry) => [replayPairKey(entry), entry]));
  const expectedSupersedes = new Map(projection.supersedes.map((entry) => [replayPairKey(entry), entry]));
  const seenThreads = new Set<string>();
  const seenSupersedes = new Set<string>();
  for (const edge of snapshot.edges) {
    // Canonical graph projection owns both kinds. Replay authority is exact
    // only over lifecycle, supersedes, and thread edges.
    if (edge.kind === "supports" || edge.kind === "about") continue;
    const key = replayPairKey(edge);
    if (edge.kind === "thread") {
      const expected = expectedThreads.get(key);
      const source = memoryById.get(edge.src);
      const destination = memoryById.get(edge.dst);
      const at = timestampMillis(edge.createdAt, true);
      if (expected === undefined || seenThreads.has(key) || source === undefined || destination === undefined
        || edge.weight !== expected.weight || edge.createdAt !== expected.at
        || at < timestampMillis(source.createdAt, false)
        || at < timestampMillis(destination.createdAt, false)) {
        throw new Error(`memory-replay-projection: DB thread mismatch (${edge.src} -> ${edge.dst}).`);
      }
      seenThreads.add(key);
      continue;
    }
    if (edge.kind === "supersedes") {
      const expected = expectedSupersedes.get(key);
      if (expected === undefined || seenSupersedes.has(key)
        || edge.weight !== 1 || edge.createdAt !== expected.at) {
        throw new Error(`memory-replay-projection: DB supersede edge mismatch (${edge.src} -> ${edge.dst}).`);
      }
      seenSupersedes.add(key);
      continue;
    }
    throw new Error(`memory-replay-projection: unattested non-support edge kind "${edge.kind}".`);
  }
  if (seenThreads.size !== expectedThreads.size || seenSupersedes.size !== expectedSupersedes.size) {
    throw new Error("memory-replay-projection: DB replay edge inventory is incomplete.");
  }
}

function assertReplaySubset<T>(
  actual: readonly T[],
  expected: readonly T[],
  keyOf: (entry: T) => string,
  sameEntry: (actualEntry: T, expectedEntry: T) => boolean,
  label: string,
): void {
  const expectedByKey = new Map<string, T>();
  for (const entry of expected) {
    const key = keyOf(entry);
    if (expectedByKey.has(key)) {
      throw new Error(`memory-replay-projection: duplicate expected ${label} authority.`);
    }
    expectedByKey.set(key, entry);
  }
  for (const entry of actual) {
    const expectedEntry = expectedByKey.get(keyOf(entry));
    if (expectedEntry === undefined || !sameEntry(entry, expectedEntry)) {
      throw new Error(`memory-replay-projection: SQLite contains replay ${label} state not explained by durable authority.`);
    }
  }
}

function assertDbSnapshotShape(snapshot: ReplayProjectionDbSnapshot): void {
  if (snapshot === null || typeof snapshot !== "object" || !Array.isArray(snapshot.memories)
    || !Array.isArray(snapshot.edges)) {
    throw new Error("memory-replay-projection: invalid DB replay snapshot.");
  }
  for (const memory of snapshot.memories) {
    normalizeId(memory.id, "DB memory id");
    timestampMillis(memory.createdAt, false);
  }
  for (const edge of snapshot.edges) {
    normalizeId(edge.src, "DB edge source");
    normalizeId(edge.dst, "DB edge destination");
    if (!Number.isFinite(edge.weight)) throw new Error("memory-replay-projection: invalid DB edge weight.");
    timestampMillis(edge.createdAt, false);
  }
}

function readRawDbSnapshot(db: MemoryDb): ReplayProjectionDbSnapshot {
  const snapshot = db.replayProjectionSnapshot();
  assertDbSnapshotShape(snapshot);
  return snapshot;
}

function serializeNormalizedProjection(projection: ReplayProjectionV1): string {
  const serialized = `${JSON.stringify(projection)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_REPLAY_PROJECTION_BYTES) {
    throw new Error("memory-replay-projection: serialized sidecar exceeds 32 MiB.");
  }
  return serialized;
}

function normalizeId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || INVALID_ID.test(value)) {
    throw new Error(`memory-replay-projection: invalid ${label}.`);
  }
  return value;
}

function normalizeTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`memory-replay-projection: invalid ${label}.`);
  timestampMillis(value, true);
  return value;
}

function normalizeAuthorityKind(value: unknown): ReplayProjectionAuthorityKind {
  if (value !== "capture" && value !== "migration" && value !== "legacy-adoption") {
    throw new Error("memory-replay-projection: invalid authority kind.");
  }
  return value;
}

function normalizeAuthorityId(value: unknown): string {
  if (typeof value !== "string" || !AUTHORITY_ID.test(value)) {
    throw new Error("memory-replay-projection: authority id must be 64 hexadecimal characters.");
  }
  return value.toLowerCase();
}

function timestampMillis(value: string, exact: boolean): number {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || (exact && new Date(millis).toISOString() !== value)) {
    throw new Error("memory-replay-projection: invalid timestamp.");
  }
  return millis;
}

function mergeExactEntries<T>(
  base: readonly T[],
  delta: readonly T[],
  keyOf: (entry: T) => string,
  label: string,
): T[] {
  const merged = new Map(base.map((entry) => [keyOf(entry), entry]));
  for (const entry of delta) {
    const key = keyOf(entry);
    const current = merged.get(key);
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(entry)) {
      throw new Error(`memory-replay-projection: conflicting ${label} authority for "${key}".`);
    }
    merged.set(key, entry);
  }
  return [...merged.values()];
}

function collapseExactEntries<T>(
  values: readonly T[],
  keyOf: (entry: T) => string,
  label: string,
): T[] {
  return mergeExactEntries([], values, keyOf, label);
}

function assertContainsExact<T>(
  actual: readonly T[],
  expected: readonly T[],
  keyOf: (entry: T) => string,
  label: string,
): void {
  const inventory = new Map(actual.map((entry) => [keyOf(entry), JSON.stringify(entry)]));
  for (const entry of expected) {
    if (inventory.get(keyOf(entry)) !== JSON.stringify(entry)) {
      throw new Error(`memory-replay-projection: projection does not contain exact ${label} delta.`);
    }
  }
}

function replayPairKey(value: { readonly src: string; readonly dst: string }): string {
  return `${value.src}\0${value.dst}`;
}

function hasCycle(successors: ReadonlyMap<string, string>): boolean {
  const complete = new Set<string>();
  for (const start of successors.keys()) {
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

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function sameIdentity(left: CanonicalFileIdentity, right: CanonicalFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && left.mode === right.mode && left.nlink === right.nlink && left.uid === right.uid;
}

function canonicalAuthorityValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("memory-replay-projection: authority contains a non-finite number.");
    return value;
  }
  if (typeof value !== "object") {
    throw new Error("memory-replay-projection: authority must contain only JSON values.");
  }
  if (ancestors.has(value)) throw new Error("memory-replay-projection: authority contains a cycle.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalAuthorityValue(entry, ancestors));
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("memory-replay-projection: authority contains a non-plain object.");
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalAuthorityValue((value as Record<string, unknown>)[key], ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}
