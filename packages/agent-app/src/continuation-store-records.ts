import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalContinuationJson, continuationDigest } from "./continuations.js";
import {
  assertOwnerOnlyRegularFile,
  continuationPathExists,
  readBoundedOwnerOnlyFile,
  syncDirectory,
  writeJsonAtomic,
} from "./continuation-store-fs.js";
import {
  assertRecordFitsV3,
  isObject,
  isDurableGeneration,
  isRecord,
  isRecordTransaction,
  isStoreFile,
  normalizeLegacyContinuationRecords,
  requiredDate,
  requiredString,
} from "./continuation-store-policy.js";
import {
  CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
  MAX_LEGACY_STORE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_RECORD_BYTES,
  MAX_TRANSACTION_BYTES,
  type ContinuationRecordTransaction,
  type ContinuationStoreManifest,
  type ContinuationStoreStats,
  type DurableContinuationRecord,
} from "./continuation-store-types.js";

export async function loadLegacyStore(path: string): Promise<Map<string, DurableContinuationRecord>> {
  const raw = await readBoundedOwnerOnlyFile(path, MAX_LEGACY_STORE_BYTES, "Continuation legacy store");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Continuation store contains invalid JSON: ${path}`, { cause: error });
  }
  if (!isStoreFile(parsed)) {
    throw new Error(`Continuation store has an unsupported or malformed schema: ${path}`);
  }
  const records = new Map<string, DurableContinuationRecord>();
  for (const [id, record] of Object.entries(parsed.records)) {
    assertRecordFitsV3(record, "Continuation legacy record");
    records.set(id, record);
  }
  return records;
}

export async function loadRecordDirectory(
  path: string,
  ignoredEntries: ReadonlySet<string> = new Set(),
): Promise<Map<string, DurableContinuationRecord>> {
  const records = new Map<string, DurableContinuationRecord>();
  let removedTemporary = false;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const filePath = join(path, entry.name);
    if (ignoredEntries.has(entry.name)) {
      await assertOwnerOnlyRegularFile(filePath, "Continuation migration guard");
      continue;
    }
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Continuation temporary record is not a regular file: ${filePath}`);
      }
      await readBoundedOwnerOnlyFile(filePath, MAX_RECORD_BYTES, "Continuation temporary record");
      await rm(filePath, { force: true });
      removedTemporary = true;
      continue;
    }
    if (!entry.name.endsWith(".json")) {
      throw new Error(`Unexpected entry in continuation record directory: ${filePath}`);
    }
    await assertOwnerOnlyRegularFile(filePath, "Continuation record");
    const raw = await readBoundedOwnerOnlyFile(filePath, MAX_RECORD_BYTES, "Continuation record");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Continuation record contains invalid JSON: ${filePath}`, { cause: error });
    }
    if (!isObject(value) || !requiredString(value.continuationId) || !isRecord(value, value.continuationId)) {
      throw new Error(`Continuation record has a malformed schema: ${filePath}`);
    }
    const expectedName = continuationRecordFileName(value.continuationId);
    if (entry.name !== expectedName) {
      throw new Error(`Continuation record filename does not match its id: ${filePath}`);
    }
    if (records.has(value.continuationId)) {
      throw new Error(`Duplicate continuation record: ${value.continuationId}`);
    }
    records.set(value.continuationId, structuredClone(value) as DurableContinuationRecord);
  }
  if (removedTemporary) await syncDirectory(path);
  return records;
}

export function mergeMigrationRecords(
  target: Map<string, DurableContinuationRecord>,
  source: Map<string, DurableContinuationRecord>,
  label: string,
): void {
  normalizeLegacyContinuationRecords(target);
  normalizeLegacyContinuationRecords(source);
  for (const [id, record] of source) {
    const current = target.get(id);
    if (current === undefined) {
      target.set(id, structuredClone(record));
    } else if (canonicalContinuationJson(current) !== canonicalContinuationJson(record)) {
      throw new Error(`${label} continuation records conflict for id ${id}; refusing lossy migration.`);
    }
  }
}

export async function assertV3Manifest(path: string): Promise<ContinuationStoreManifest> {
  const raw = await readBoundedOwnerOnlyFile(path, MAX_MANIFEST_BYTES, "Continuation v3 manifest");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Continuation v3 manifest contains invalid JSON: ${path}`, { cause: error });
  }
  if (!isObject(value)
    || value.schemaVersion !== CONTINUATION_RECORD_STORE_SCHEMA_VERSION
    || !isDurableGeneration(value.generation)
    || !requiredDate(value.updatedAt)
    || (value.rollbackGuardRequired !== undefined && typeof value.rollbackGuardRequired !== "boolean")
    || !isObject(value.stats)) {
    throw new Error(`Continuation v3 manifest has a malformed schema: ${path}`);
  }
  return value as unknown as ContinuationStoreManifest;
}

export async function persistRecordChanges(
  recordsDir: string,
  transactionPath: string,
  before: Map<string, DurableContinuationRecord>,
  after: Map<string, DurableContinuationRecord>,
  beforeCommit?: () => Promise<void>,
): Promise<string | undefined> {
  const writes = [...after.values()].filter((record) => {
    const prior = before.get(record.continuationId);
    return prior === undefined || JSON.stringify(prior) !== JSON.stringify(record);
  }).map((record) => structuredClone(record));
  const deletes = [...before.keys()].filter((id) => !after.has(id));
  if (writes.length === 0 && deletes.length === 0) return undefined;
  const transactions = createTransactionBatches(writes, deletes);
  await beforeCommit?.();
  let generation: string | undefined;
  for (const transaction of transactions) {
    await writeJsonAtomic(transactionPath, transaction, true, MAX_TRANSACTION_BYTES);
    await applyRecordTransaction(recordsDir, transaction);
    await rm(transactionPath, { force: true });
    await syncDirectory(dirname(transactionPath));
    generation = transaction.generation;
  }
  return generation;
}

export async function recoverRecordTransaction(
  recordsDir: string,
  transactionPath: string,
  expectedSchemaVersion: 2 | typeof CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
): Promise<string | undefined> {
  if (!await continuationPathExists(transactionPath)) return undefined;
  const raw = await readBoundedOwnerOnlyFile(transactionPath, MAX_TRANSACTION_BYTES, "Continuation transaction");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Continuation transaction contains invalid JSON: ${transactionPath}`, { cause: error });
  }
  if (!isRecordTransaction(value, expectedSchemaVersion)) {
    throw new Error(`Continuation transaction has a malformed schema: ${transactionPath}`);
  }
  await applyRecordTransaction(recordsDir, value);
  await rm(transactionPath, { force: true });
  await syncDirectory(dirname(transactionPath));
  return value.generation;
}

async function applyRecordTransaction(
  recordsDir: string,
  transaction: ContinuationRecordTransaction,
): Promise<void> {
  for (const record of transaction.writes) {
    await writeJsonAtomic(
      join(recordsDir, continuationRecordFileName(record.continuationId)),
      record,
      false,
      MAX_RECORD_BYTES,
    );
  }
  for (const id of transaction.deletes) {
    await rm(join(recordsDir, continuationRecordFileName(id)), { force: true });
  }
  await syncDirectory(recordsDir);
}

export async function persistManifest(
  path: string,
  generation: string,
  stats: ContinuationStoreStats,
  now: Date,
  rollbackGuardRequired: boolean,
): Promise<void> {
  if (!isDurableGeneration(generation)) {
    throw new Error("Continuation manifest generation is empty or exceeds its safety limit.");
  }
  await writeJsonAtomic(path, {
    schemaVersion: CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
    generation,
    updatedAt: now.toISOString(),
    rollbackGuardRequired,
    stats,
  } satisfies ContinuationStoreManifest, true, MAX_MANIFEST_BYTES);
}

function createTransactionBatches(
  writes: readonly DurableContinuationRecord[],
  deletes: readonly string[],
): readonly ContinuationRecordTransaction[] {
  type Change =
    | { readonly kind: "write"; readonly record: DurableContinuationRecord }
    | { readonly kind: "delete"; readonly id: string };
  const batches: ContinuationRecordTransaction[] = [];
  const createdAt = new Date().toISOString();
  for (const record of writes) {
    assertRecordFitsV3(record);
  }
  const changes: Change[] = [
    ...writes.map((record): Change => ({ kind: "write", record: structuredClone(record) })),
    ...deletes.map((id): Change => ({ kind: "delete", id })),
  ];
  const makeTransaction = (entries: readonly Change[]): ContinuationRecordTransaction => ({
    schemaVersion: CONTINUATION_RECORD_STORE_SCHEMA_VERSION,
    generation: randomUUID(),
    createdAt,
    writes: entries.flatMap((entry) => entry.kind === "write" ? [entry.record] : []),
    deletes: entries.flatMap((entry) => entry.kind === "delete" ? [entry.id] : []),
  });
  const appendBounded = (entries: readonly Change[]): void => {
    if (entries.length === 0) return;
    const candidate = makeTransaction(entries);
    const bytes = Buffer.byteLength(`${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    if (bytes <= MAX_TRANSACTION_BYTES) {
      batches.push(candidate);
      return;
    }
    if (entries.length === 1) {
      const only = entries[0];
      throw new Error(only?.kind === "write"
        ? `Continuation record is too large for a bounded durable transaction: ${only.record.continuationId}`
        : `Continuation id is too large for a bounded durable transaction: ${only?.id ?? "unknown"}`);
    }
    const middle = Math.floor(entries.length / 2);
    appendBounded(entries.slice(0, middle));
    appendBounded(entries.slice(middle));
  };

  const targetBytes = Math.floor(MAX_TRANSACTION_BYTES / 2);
  let batch: Change[] = [];
  let estimatedBytes = 512;
  for (const change of changes) {
    const value = change.kind === "write" ? change.record : change.id;
    const estimate = Buffer.byteLength(JSON.stringify(value), "utf8") + 64;
    if (batch.length > 0 && estimatedBytes + estimate > targetBytes) {
      appendBounded(batch);
      batch = [];
      estimatedBytes = 512;
    }
    batch.push(change);
    estimatedBytes += estimate;
  }
  appendBounded(batch);
  return batches;
}

function continuationRecordFileName(id: string): string {
  return `${continuationDigest(id)}.json`;
}
