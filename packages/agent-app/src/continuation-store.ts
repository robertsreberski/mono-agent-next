import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  assertAgentContinuationOriginContext,
  type AgentContinuationOriginContext,
} from "@mono-agent/agent-contracts";

import { canonicalContinuationJson } from "./continuations.js";
import {
  OriginContextCorruptionError,
  applyOriginContextGroupCommit,
  applyOriginContextGroupCommits,
  cleanOriginContextGroupTemporaries,
  loadOriginContextGroupCommit,
  originContextDigest,
  originContextStoreBytes,
  prepareOriginContextGroupCommit,
  readOriginContextCanonical,
  referencedOriginContextDigests,
  releasePendingOriginPin,
  removeOriginContextGroupCommits,
  sweepOriginContextBlobs,
} from "./continuation-origin-store.js";
import {
  continuationPathExists,
  ensureOwnerOnlyDirectory,
  readBoundedOwnerOnlyFile,
  syncDirectory,
  writeJsonAtomic,
  writeTextAtomic,
} from "./continuation-store-fs.js";
import {
  applyRetention,
  cloneRecord,
  cloneRecords,
  continuationStoreStats,
  isMissing,
  isOriginContextReference,
  normalizeLegacyContinuationRecords,
  replaceRecords,
  requiredDate,
  requiredString,
  resolveRetention,
} from "./continuation-store-policy.js";
import {
  assertV3Manifest,
  loadLegacyStore,
  loadRecordDirectory,
  mergeMigrationRecords,
  persistManifest,
  persistRecordChanges,
  recoverRecordTransaction,
} from "./continuation-store-records.js";
import {
  CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
  LEGACY_RECORDS_DIRECTORY,
  LEGACY_TRANSACTION_FILE,
  MANIFEST_FILE,
  MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES,
  MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGES,
  MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGE_BYTES,
  MAX_CONTINUATION_ORIGIN_CONTEXT_STORE_BYTES,
  ORIGIN_CONTEXT_GROUPS_DIRECTORY,
  ORIGIN_CONTEXTS_DIRECTORY,
  RECORDS_DIRECTORY,
  TRANSACTION_FILE,
  V2_ROLLBACK_GUARD,
  type ContinuationOriginContextGroupCommit,
  type ContinuationRetentionOptions,
  type ContinuationStore,
  type DurableContinuationRecord,
} from "./continuation-store-types.js";

const V2_ROLLBACK_GUARD_CONTENT =
  "This state directory uses continuation records v3. Older runtimes must not open records-v2.\n";

export {
  acquireContinuationStoreLock,
  loadOrCreateContinuationSecret,
} from "./continuation-store-fs.js";
export {
  CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
  CONTINUATION_STORE_SCHEMA_VERSION,
  MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES,
  MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGES,
  MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGE_BYTES,
  MAX_CONTINUATION_ORIGIN_CONTEXT_STORE_BYTES,
} from "./continuation-store-types.js";
export type {
  ContinuationLastError,
  ContinuationOriginContextPin,
  ContinuationOriginContextReference,
  ContinuationOriginContextState,
  ContinuationRetentionOptions,
  ContinuationStore,
  ContinuationStoreLock,
  ContinuationStoreStats,
  DurableContinuationRecord,
} from "./continuation-store-types.js";

export async function openContinuationStore(
  stateDir: string,
  options: {
    readonly retention?: ContinuationRetentionOptions;
    readonly now?: () => Date;
  } = {},
): Promise<ContinuationStore> {
  await ensureOwnerOnlyDirectory(stateDir);
  const recordsDir = join(stateDir, RECORDS_DIRECTORY);
  await ensureOwnerOnlyDirectory(recordsDir);
  const legacyRecordsDir = join(stateDir, LEGACY_RECORDS_DIRECTORY);
  const originContextsDir = join(stateDir, ORIGIN_CONTEXTS_DIRECTORY);
  await ensureOwnerOnlyDirectory(originContextsDir);
  const originContextGroupsDir = join(stateDir, ORIGIN_CONTEXT_GROUPS_DIRECTORY);
  await ensureOwnerOnlyDirectory(originContextGroupsDir);
  const transactionPath = join(stateDir, TRANSACTION_FILE);
  const manifestPath = join(stateDir, MANIFEST_FILE);
  const legacyPath = join(stateDir, "continuations-v1.json");
  const legacyManifestPath = join(stateDir, "continuation-store-v2.json");
  const legacyTransactionPath = join(stateDir, LEGACY_TRANSACTION_FILE);
  const rollbackGuardPath = join(legacyRecordsDir, V2_ROLLBACK_GUARD);
  const policy = resolveRetention(options.retention);
  const now = options.now ?? (() => new Date());

  const manifestExists = await continuationPathExists(manifestPath);
  const manifest = manifestExists ? await assertV3Manifest(manifestPath) : undefined;
  // Fieldless manifests were written by the eager-guard implementation, so
  // they remain permanently fenced. Only a new explicit false opens the one
  // clean rollback window for an empty store.
  const manifestRollbackGuardRequired = manifest === undefined
    ? false
    : manifest.rollbackGuardRequired ?? true;

  let legacyRecordsDirectoryExists = await continuationPathExists(legacyRecordsDir);
  if (legacyRecordsDirectoryExists) await ensureOwnerOnlyDirectory(legacyRecordsDir);
  const ensureLegacyRecordsDirectory = async (): Promise<void> => {
    if (legacyRecordsDirectoryExists) return;
    await ensureOwnerOnlyDirectory(legacyRecordsDir);
    await syncDirectory(stateDir);
    legacyRecordsDirectoryExists = true;
  };
  let rollbackGuardInstalled = legacyRecordsDirectoryExists
    ? await continuationPathExists(rollbackGuardPath)
    : false;
  let rollbackGuardValidated = false;
  const ensureV2RollbackGuard = async (): Promise<void> => {
    if (rollbackGuardValidated) return;
    await ensureLegacyRecordsDirectory();
    if (!rollbackGuardInstalled) {
      await writeTextAtomic(rollbackGuardPath, V2_ROLLBACK_GUARD_CONTENT, 4 * 1024);
      rollbackGuardInstalled = true;
    }
    const contents = await readBoundedOwnerOnlyFile(
      rollbackGuardPath,
      4 * 1024,
      "Continuation v2 rollback guard",
    );
    if (contents !== V2_ROLLBACK_GUARD_CONTENT) {
      throw new Error(`Continuation v2 rollback guard contents are invalid: ${rollbackGuardPath}`);
    }
    rollbackGuardValidated = true;
  };

  const isCommittedEntry = (entry: string): boolean => !(entry.startsWith(".") && entry.endsWith(".tmp"));
  const v3StateExists = await continuationPathExists(transactionPath)
    || (await readdir(recordsDir)).some(isCommittedEntry)
    || (await readdir(originContextGroupsDir)).some(isCommittedEntry);
  if (manifestRollbackGuardRequired) {
    if (!rollbackGuardInstalled) {
      throw new Error(`Continuation v2 rollback guard is missing from activated v3 state: ${rollbackGuardPath}`);
    }
    await ensureV2RollbackGuard();
  } else if (v3StateExists) {
    // Preserve recovery of an interrupted first v3 transaction or activation:
    // fence the legacy reader before inspecting or replaying that evidence.
    await ensureV2RollbackGuard();
  }

  const legacyStateExists = legacyRecordsDirectoryExists
    || await continuationPathExists(legacyPath)
    || await continuationPathExists(legacyManifestPath)
    || await continuationPathExists(legacyTransactionPath);
  const migrationRequired = legacyStateExists && !manifestRollbackGuardRequired;
  let migrationSource: Map<string, DurableContinuationRecord> | undefined;
  if (migrationRequired) {
    // A guard can already exist after an interrupted migration. Validate it
    // before touching state, but always finish any admitted v2 transaction:
    // the guard does not itself prove that v2 replay completed.
    if (rollbackGuardInstalled) await ensureV2RollbackGuard();
    if (await continuationPathExists(legacyTransactionPath)) {
      await ensureLegacyRecordsDirectory();
      await recoverRecordTransaction(legacyRecordsDir, legacyTransactionPath, 2);
    }
    migrationSource = legacyRecordsDirectoryExists
      ? await loadRecordDirectory(legacyRecordsDir, new Set([V2_ROLLBACK_GUARD]))
      : new Map();
    normalizeLegacyContinuationRecords(migrationSource);
    if (await continuationPathExists(legacyPath)) {
      const legacy = await loadLegacyStore(legacyPath);
      normalizeLegacyContinuationRecords(legacy);
      mergeMigrationRecords(migrationSource, legacy, "v1 and v2");
    }
  }
  const recoveredGeneration = await recoverRecordTransaction(
    recordsDir,
    transactionPath,
    CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
  );
  const records = await loadRecordDirectory(recordsDir);
  const beforeMigration = cloneRecords(records);
  normalizeLegacyContinuationRecords(records);
  if (migrationSource !== undefined) {
    mergeMigrationRecords(records, migrationSource, "v2 and v3");
  }

  // Migration has its own durable phase. While the manifest remains false,
  // legacy records are still authoritative and every partially materialized
  // v3 record must remain semantically identical to that normalized source.
  // Retention and activation are v3-only projections: publishing either one
  // before the manifest closes migration would make crash replay compare a
  // projected v3 record with its unprojected legacy source and reject it as a
  // lossy conflict.
  const migrationCompletionRequired = !manifestRollbackGuardRequired
    && (migrationSource !== undefined || v3StateExists || rollbackGuardInstalled);
  const projectionTime = now();
  if (migrationCompletionRequired) {
    // Validate the retention projection before closing migration. This is a
    // read-only draft: normalized legacy records remain the only durable v3
    // state until the manifest commits, but a growing compaction tombstone
    // cannot strand the store behind that completion fence. Activation markers
    // remain the later v3-only durable projection; their publisher preflights
    // exact membership and record bounds before creating the marker.
    const projectionDraft = cloneRecords(records);
    // Temporary marker debris is cleanup-only and therefore excluded from the
    // v3-evidence fence decision. Validate and clean it before publishing the
    // migration fence so an unsafe linked/oversized temporary cannot poison
    // every subsequent restart.
    await cleanOriginContextGroupTemporaries(originContextGroupsDir);
    applyRetention(projectionDraft, policy, projectionTime);
    // The preflight above is non-durable. Fence the v2 reader only after the
    // retention projection is known to be materializable, then publish
    // normalized records as their own migration phase.
    await ensureV2RollbackGuard();
  }
  const migrationGeneration = await persistRecordChanges(
    recordsDir,
    transactionPath,
    beforeMigration,
    records,
    ensureV2RollbackGuard,
  );
  let generation = migrationGeneration ?? recoveredGeneration ?? randomUUID();
  if (migrationCompletionRequired) {
    await persistManifest(
      manifestPath,
      generation,
      continuationStoreStats(records, policy),
      now(),
      true,
    );
  }

  const beforeProjections = cloneRecords(records);
  const committedOriginGroups = await applyOriginContextGroupCommits(originContextGroupsDir, records);
  applyRetention(records, policy, projectionTime);
  const projectionGeneration = await persistRecordChanges(
    recordsDir,
    transactionPath,
    beforeProjections,
    records,
    ensureV2RollbackGuard,
  );
  if (projectionGeneration !== undefined) generation = projectionGeneration;
  await persistManifest(
    manifestPath,
    generation,
    continuationStoreStats(records, policy),
    now(),
    rollbackGuardInstalled,
  );
  await removeOriginContextGroupCommits(originContextGroupsDir, committedOriginGroups);
  await sweepOriginContextBlobs(originContextsDir, referencedOriginContextDigests(records), new Set());

  let tail: Promise<void> = Promise.resolve();
  let originTail: Promise<void> = Promise.resolve();
  const pendingOriginPins = new Map<string, number>();
  let poisoned: unknown;

  async function withOriginLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = originTail;
    let release!: () => void;
    originTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async function locked<T>(
    operation: (current: Map<string, DurableContinuationRecord>) => T | Promise<T>,
  ): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    if (poisoned !== undefined) {
      release();
      throw new Error("Continuation store requires restart after a failed durable transaction.", { cause: poisoned });
    }
    const before = cloneRecords(records);
    const draft = cloneRecords(records);
    let result: T;
    try {
      result = await operation(draft);
    } catch (error) {
      release();
      throw error;
    }
    try {
      applyRetention(draft, policy, now());
      const committedGeneration = await persistRecordChanges(
        recordsDir,
        transactionPath,
        before,
        draft,
        ensureV2RollbackGuard,
      );
      if (committedGeneration !== undefined) generation = committedGeneration;
      replaceRecords(records, draft);
      await persistManifest(
        manifestPath,
        generation,
        continuationStoreStats(records, policy),
        now(),
        rollbackGuardInstalled,
      );
      await withOriginLock(async () => {
        await sweepOriginContextBlobs(
          originContextsDir,
          referencedOriginContextDigests(records),
          new Set(pendingOriginPins.keys()),
        );
      });
      return result;
    } catch (error) {
      try {
        const recovered = await recoverRecordTransaction(
          recordsDir,
          transactionPath,
          CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
        );
        if (recovered !== undefined) generation = recovered;
        replaceRecords(records, await loadRecordDirectory(recordsDir));
      } catch (recoveryError) {
        poisoned = new AggregateError(
          [error, recoveryError],
          "Continuation durable commit and recovery both failed.",
        );
        throw poisoned;
      }
      poisoned = error;
      throw error;
    } finally {
      release();
    }
  }

  async function activateOriginContextGroup(input: {
    readonly claimFingerprint: string;
    readonly activatedAt: string;
  }): Promise<void> {
    if (!requiredString(input.claimFingerprint) || !requiredDate(input.activatedAt)) {
      throw new Error("Continuation origin-context activation has an invalid claim or timestamp.");
    }
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    if (poisoned !== undefined) {
      release();
      throw new Error("Continuation store requires restart after a failed durable transaction.", { cause: poisoned });
    }
    const before = cloneRecords(records);
    const draft = cloneRecords(records);
    let commit: ContinuationOriginContextGroupCommit | undefined;
    let markerPath: string | undefined;
    let published = false;
    try {
      commit = prepareOriginContextGroupCommit(draft, input);
      if (commit === undefined) return;
      // Preflight the exact projection, including v3 record-size bounds,
      // before the durable marker becomes the recovery commit point.
      applyOriginContextGroupCommit(draft, commit);
      await ensureV2RollbackGuard();
      markerPath = join(originContextGroupsDir, `${commit.groupKey}.json`);
      if (await continuationPathExists(markerPath)) {
        const existing = await loadOriginContextGroupCommit(markerPath);
        if (canonicalContinuationJson(existing) !== canonicalContinuationJson(commit)) {
          throw new Error("Continuation origin-context group activation conflicts with an existing commit marker.");
        }
      } else {
        await writeJsonAtomic(markerPath, commit, true, 64 * 1024);
      }
      published = true;
      replaceRecords(records, draft);

      try {
        const committedGeneration = await persistRecordChanges(
          recordsDir,
          transactionPath,
          before,
          draft,
          ensureV2RollbackGuard,
        );
        if (committedGeneration !== undefined) generation = committedGeneration;
        await persistManifest(
          manifestPath,
          generation,
          continuationStoreStats(records, policy),
          now(),
          rollbackGuardInstalled,
        );
        await rm(markerPath, { force: true });
        await syncDirectory(originContextGroupsDir);
      } catch (materializationError) {
        try {
          const recovered = await recoverRecordTransaction(
            recordsDir,
            transactionPath,
            CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
          );
          if (recovered !== undefined) generation = recovered;
          const recoveredRecords = await loadRecordDirectory(recordsDir);
          normalizeLegacyContinuationRecords(recoveredRecords);
          applyOriginContextGroupCommit(recoveredRecords, commit);
          replaceRecords(records, recoveredRecords);
        } catch (recoveryError) {
          poisoned = new AggregateError(
            [materializationError, recoveryError],
            "Continuation origin-context activation committed but requires restart to recover.",
          );
        }
        poisoned ??= materializationError;
      }
      await withOriginLock(async () => {
        await sweepOriginContextBlobs(
          originContextsDir,
          referencedOriginContextDigests(records),
          new Set(pendingOriginPins.keys()),
        );
      });
    } catch (error) {
      if (!published) throw error;
      poisoned ??= error;
    } finally {
      release();
    }
  }

  return {
    path: manifestPath,
    async get(id) {
      await tail;
      return cloneRecord(records.get(id));
    },
    async list() {
      await tail;
      return [...records.values()].map((record) => cloneRecord(record) as DurableContinuationRecord);
    },
    async findClaim(input) {
      await tail;
      const found = [...records.values()].find((record) =>
        record.serverName === input.serverName
        && record.originRunId === input.originRunId
        && record.taskKey === input.taskKey,
      );
      return cloneRecord(found);
    },
    async stats() {
      await tail;
      return continuationStoreStats(records, policy);
    },
    async stageOriginContext(snapshot) {
      assertAgentContinuationOriginContext(snapshot);
      const canonical = canonicalContinuationJson(snapshot);
      const bytes = Buffer.byteLength(canonical, "utf8");
      if (snapshot.messages.length > MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGES) {
        throw new Error(
          `Continuation origin context exceeds its ${String(MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGES)} message limit.`,
        );
      }
      if (snapshot.messages.some((message) =>
        Buffer.byteLength(message.content, "utf8") > MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGE_BYTES)) {
        throw new Error(
          `Continuation origin context contains a message over its ${String(MAX_CONTINUATION_ORIGIN_CONTEXT_MESSAGE_BYTES)} byte limit.`,
        );
      }
      if (bytes > MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES) {
        throw new Error(
          `Continuation origin context exceeds its ${String(MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES)} byte limit.`,
        );
      }
      const digest = originContextDigest(canonical);
      const reference = {
        schemaVersion: 1,
        digest,
        bytes,
        messageCount: snapshot.messages.length,
      } as const;
      pendingOriginPins.set(digest, (pendingOriginPins.get(digest) ?? 0) + 1);
      try {
        await withOriginLock(async () => {
          const path = join(originContextsDir, `${digest}.json`);
          if (await continuationPathExists(path)) {
            const existing = await readOriginContextCanonical(path, reference);
            if (existing !== canonical) {
              throw new Error("Continuation origin context digest collision or content conflict.");
            }
            return;
          }
          const aggregate = await originContextStoreBytes(originContextsDir);
          if (aggregate + bytes > MAX_CONTINUATION_ORIGIN_CONTEXT_STORE_BYTES) {
            throw new Error(
              `Continuation origin context store exceeds its ${String(MAX_CONTINUATION_ORIGIN_CONTEXT_STORE_BYTES)} byte quota.`,
            );
          }
          await writeTextAtomic(path, canonical, MAX_CONTINUATION_ORIGIN_CONTEXT_BYTES);
        });
      } catch (error) {
        releasePendingOriginPin(pendingOriginPins, digest);
        throw error;
      }
      let released = false;
      return {
        reference,
        async release() {
          if (released) return;
          released = true;
          releasePendingOriginPin(pendingOriginPins, digest);
          await withOriginLock(async () => {
            await sweepOriginContextBlobs(
              originContextsDir,
              referencedOriginContextDigests(records),
              new Set(pendingOriginPins.keys()),
            );
          });
        },
      };
    },
    async loadOriginContext(reference) {
      if (!isOriginContextReference(reference)) return undefined;
      return await withOriginLock(async () => {
        const path = join(originContextsDir, `${reference.digest}.json`);
        try {
          const canonical = await readOriginContextCanonical(path, reference);
          return JSON.parse(canonical) as AgentContinuationOriginContext;
        } catch (error) {
          if (isMissing(error) || error instanceof SyntaxError || error instanceof OriginContextCorruptionError) {
            return undefined;
          }
          throw error;
        }
      });
    },
    activateOriginContextGroup,
    mutate: locked,
  };
}
