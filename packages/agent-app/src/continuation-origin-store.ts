import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertAgentContinuationOriginContext } from "@mono-agent/agent-contracts";

import {
  TERMINAL_CONTINUATION_STATES,
  canonicalContinuationJson,
  continuationDigest,
} from "./continuations.js";
import {
  assertOwnerOnlyRegularFile,
  readBoundedOwnerOnlyFile,
  readBoundedOwnerOnlyFileWithStats,
  syncDirectory,
} from "./continuation-store-fs.js";
import {
  assertRecordFitsV3,
  isMissing,
  isOriginContextGroupCommit,
} from "./continuation-store-policy.js";
import {
  MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES,
  MAX_CONTINUATION_ORIGIN_CONTEXT_STORE_BYTES,
  type ContinuationOriginContextGroupCommit,
  type ContinuationOriginContextReference,
  type DurableContinuationRecord,
} from "./continuation-store-types.js";

export function prepareOriginContextGroupCommit(
  records: Map<string, DurableContinuationRecord>,
  input: { readonly claimFingerprint: string; readonly activatedAt: string },
): ContinuationOriginContextGroupCommit | undefined {
  const seeds = [...records.values()].filter((record) => record.claimFingerprint === input.claimFingerprint);
  if (seeds.length === 0) return undefined;
  const seed = seeds[0] as DurableContinuationRecord;
  if (seed.originContextState === "detached_latest") return undefined;
  if (seed.historyBoundary === undefined) {
    throw new Error("A pinned continuation origin group must have an immutable history boundary.");
  }
  const candidates = [...records.values()].filter((record) =>
    record.originRunId === seed.originRunId
    && record.originConversationId === seed.originConversationId
    && record.historyBoundary === seed.historyBoundary
    && !TERMINAL_CONTINUATION_STATES.has(record.state));
  if (candidates.length === 0) return undefined;
  const digests = new Set<string>();
  for (const record of candidates) {
    if ((record.originContextState !== "pending" && record.originContextState !== "pinned")
      || record.originContextRef === undefined
      || record.originContextDigest !== record.originContextRef.digest
      || record.originContextBindingMac === undefined) {
      throw new Error("Continuation origin context was not durably prepared for activation.");
    }
    digests.add(record.originContextRef.digest);
  }
  if (digests.size !== 1) {
    throw new Error("Continuation origin claims were prepared with conflicting snapshots.");
  }
  if (candidates.every((record) => record.originContextState === "pinned")) return undefined;
  const snapshotDigest = [...digests][0];
  if (snapshotDigest === undefined) throw new Error("Continuation origin group has no snapshot digest.");
  const memberIds = candidates.map((record) => record.continuationId).sort();
  const groupIdentity = {
    originRunId: seed.originRunId,
    originConversationId: seed.originConversationId,
    historyBoundary: seed.historyBoundary,
  };
  return {
    schemaVersion: 1,
    groupKey: continuationDigest(
      `mono-agent-origin-context-group-v1\0${canonicalContinuationJson(groupIdentity)}`,
    ),
    ...groupIdentity,
    snapshotDigest,
    memberCount: memberIds.length,
    memberSetDigest: continuationDigest(
      `mono-agent-origin-context-members-v1\0${canonicalContinuationJson(memberIds)}`,
    ),
    activatedAt: input.activatedAt,
  };
}

export function applyOriginContextGroupCommit(
  records: Map<string, DurableContinuationRecord>,
  commit: ContinuationOriginContextGroupCommit,
): void {
  const candidates = [...records.values()].filter((record) =>
    record.originRunId === commit.originRunId
    && record.originConversationId === commit.originConversationId
    && record.historyBoundary === commit.historyBoundary
    && !TERMINAL_CONTINUATION_STATES.has(record.state));
  const memberIds = candidates.map((record) => record.continuationId).sort();
  const memberSetDigest = continuationDigest(
    `mono-agent-origin-context-members-v1\0${canonicalContinuationJson(memberIds)}`,
  );
  if (candidates.length !== commit.memberCount || memberSetDigest !== commit.memberSetDigest) {
    throw new Error("Continuation origin-context group commit member set does not match durable records.");
  }
  for (const record of candidates) {
    if ((record.originContextState !== "pending" && record.originContextState !== "pinned")
      || record.originContextRef?.digest !== commit.snapshotDigest
      || record.originContextDigest !== commit.snapshotDigest
      || record.originContextBindingMac === undefined) {
      throw new Error("Continuation origin-context group commit does not match its prepared records.");
    }
  }
  // Validate the complete projection before mutating any record. A durable
  // marker must never describe a state that cannot fit the v3 record format,
  // otherwise every restart would replay the same unmaterializable commit.
  for (const record of candidates) {
    const projected = structuredClone(record);
    applyOriginContextGroupProjection(projected, commit.activatedAt);
    assertRecordFitsV3(projected, "Continuation activated record");
  }
  for (const record of candidates) {
    applyOriginContextGroupProjection(record, commit.activatedAt);
  }
}

function applyOriginContextGroupProjection(record: DurableContinuationRecord, activatedAt: string): void {
  if (record.originContextState === "pinned") return;
  record.originContextState = "pinned";
  record.updatedAt = activatedAt;
  if (record.lastError?.code === "origin_context_pending") delete record.lastError;
  delete record.nextAttemptAt;
}

export async function applyOriginContextGroupCommits(
  directory: string,
  records: Map<string, DurableContinuationRecord>,
): Promise<readonly string[]> {
  const applied: string[] = [];
  let removedTemporary = false;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Continuation origin-context group temporary is not a regular file: ${path}`);
      }
      // Atomic marker writes are bounded and owner-only. Treat leftover
      // temporaries as cleanup-only evidence, but validate their filesystem
      // identity before deleting so a swapped, linked, or forged entry cannot
      // hide behind the recovery sweep.
      await readBoundedOwnerOnlyFile(path, 64 * 1024, "Continuation origin-context group temporary");
      await rm(path, { force: true });
      removedTemporary = true;
      continue;
    }
    if (!/^[a-f0-9]{64}\.json$/u.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Unexpected entry in continuation origin-context group directory: ${path}`);
    }
    const commit = await loadOriginContextGroupCommit(path);
    if (`${commit.groupKey}.json` !== entry.name) {
      throw new Error(`Continuation origin-context group filename does not match its key: ${path}`);
    }
    applyOriginContextGroupCommit(records, commit);
    applied.push(path);
  }
  if (removedTemporary) await syncDirectory(directory);
  return applied;
}

export async function cleanOriginContextGroupTemporaries(directory: string): Promise<void> {
  let removedTemporary = false;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!(entry.name.startsWith(".") && entry.name.endsWith(".tmp"))) continue;
    const path = join(directory, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Continuation origin-context group temporary is not a regular file: ${path}`);
    }
    await readBoundedOwnerOnlyFile(path, 64 * 1024, "Continuation origin-context group temporary");
    await rm(path, { force: true });
    removedTemporary = true;
  }
  if (removedTemporary) await syncDirectory(directory);
}

export async function loadOriginContextGroupCommit(path: string): Promise<ContinuationOriginContextGroupCommit> {
  const raw = await readBoundedOwnerOnlyFile(path, 64 * 1024, "Continuation origin-context group commit");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Continuation origin-context group commit contains invalid JSON: ${path}`, { cause: error });
  }
  if (!isOriginContextGroupCommit(value)) {
    throw new Error(`Continuation origin-context group commit has a malformed schema: ${path}`);
  }
  return value;
}

export async function removeOriginContextGroupCommits(
  directory: string,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;
  for (const path of paths) await rm(path, { force: true });
  await syncDirectory(directory);
}

export class OriginContextCorruptionError extends Error {}

export function originContextDigest(canonical: string): string {
  return continuationDigest(`mono-agent-origin-context-v1\0${canonical}`);
}

export async function readOriginContextCanonical(
  path: string,
  reference: ContinuationOriginContextReference,
): Promise<string> {
  let canonical: string;
  try {
    const loaded = await readBoundedOwnerOnlyFileWithStats(
      path,
      MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES,
      "Continuation origin context",
    );
    if (loaded.bytes !== reference.bytes) {
      throw new OriginContextCorruptionError("Continuation origin context size does not match its reference.");
    }
    canonical = loaded.text;
  } catch (error) {
    if (error instanceof OriginContextCorruptionError || isMissing(error)) throw error;
    throw new OriginContextCorruptionError(
      "Continuation origin context is not a safe owner-only file.",
      { cause: error },
    );
  }
  if (Buffer.byteLength(canonical, "utf8") !== reference.bytes
    || originContextDigest(canonical) !== reference.digest) {
    throw new OriginContextCorruptionError("Continuation origin context digest does not match its reference.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical) as unknown;
  } catch (error) {
    throw new OriginContextCorruptionError("Continuation origin context is not valid JSON.", { cause: error });
  }
  if (canonicalContinuationJson(parsed) !== canonical) {
    throw new OriginContextCorruptionError("Continuation origin context is not canonically encoded.");
  }
  try {
    assertAgentContinuationOriginContext(parsed);
  } catch (error) {
    throw new OriginContextCorruptionError("Continuation origin context has an invalid schema.", { cause: error });
  }
  if (parsed.messages.length !== reference.messageCount) {
    throw new OriginContextCorruptionError(
      "Continuation origin context message count does not match its reference.",
    );
  }
  return canonical;
}

export function referencedOriginContextDigests(
  records: Map<string, DurableContinuationRecord>,
): ReadonlySet<string> {
  return new Set([...records.values()].flatMap((record) =>
    record.originContextRef === undefined ? [] : [record.originContextRef.digest]));
}

export function releasePendingOriginPin(pins: Map<string, number>, digest: string): void {
  const count = pins.get(digest);
  if (count === undefined) return;
  if (count <= 1) pins.delete(digest);
  else pins.set(digest, count - 1);
}

export async function sweepOriginContextBlobs(
  directory: string,
  referenced: ReadonlySet<string>,
  pending: ReadonlySet<string>,
): Promise<void> {
  let changed = false;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) {
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        throw new Error(`Continuation origin-context temporary is not a regular file: ${path}`);
      }
      await rm(path, { force: true });
      changed = true;
      continue;
    }
    const match = /^([a-f0-9]{64})\.json$/u.exec(entry.name);
    if (match?.[1] !== undefined && !referenced.has(match[1]) && !pending.has(match[1])) {
      await rm(path, { force: true, recursive: true });
      changed = true;
      continue;
    }
    if (match?.[1] === undefined) {
      throw new Error(`Unexpected entry in continuation origin-context directory: ${path}`);
    }
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    try {
      await assertOwnerOnlyRegularFile(path, "Continuation origin context");
    } catch {
      continue;
    }
  }
  if (changed) await syncDirectory(directory);
}

export async function originContextStoreBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) continue;
    if (!/^[a-f0-9]{64}\.json$/u.test(entry.name)) {
      throw new Error(`Unexpected entry in continuation origin-context directory: ${join(directory, entry.name)}`);
    }
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const info = await lstat(join(directory, entry.name));
    total += info.size;
    if (total > MAX_CONTINUATION_ORIGIN_CONTEXT_STORE_BYTES) {
      throw new Error("Continuation origin context store exceeds its aggregate byte quota.");
    }
  }
  return total;
}
