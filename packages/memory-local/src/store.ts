import { createHash, randomUUID } from "node:crypto";
import { readdir, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  Memory,
  MemoryCaptureRequest,
  MemoryForgetRequest,
  MemoryHost,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRecord,
  MemoryRuntimeCaptureGrant,
  ModuleHealth,
  ModuleHealthContext,
  ModuleStopContext,
} from "@mono-agent/module-sdk";
import { HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE } from "@mono-agent/module-sdk";

import {
  parseMemoryLocalConfig,
  type MemoryLocalConfig,
} from "./config.js";
import { MemoryLocalError } from "./errors.js";
import {
  canonicalJson,
  lexicalTerms,
  normalizeLexical,
  parseStoredMetadata,
  scoreLexical,
  validateMemoryRecord,
  type ValidatedMemoryRecord,
} from "./records.js";
import {
  createSecureFile,
  identity,
  inspectSecureFile,
  openSecureRoot,
  pathExists,
  readSecureFile,
  sameFileIdentity,
  verifySecureRoot,
  type FileIdentity,
  type SecureRoot,
} from "./security.js";

export const MEMORY_LOCAL_DATABASE_FILENAME = "memory.sqlite";
export const MEMORY_LOCAL_MARKER_FILENAME = ".first-run-memory-initializing";

const STORE_SCHEMA = "mono-agent.memory-local.v1";
const MARKER_MAX_BYTES = 16 * 1024;

export interface OpenMemoryLocalOptions {
  readonly config?: unknown;
  readonly configDirectory: string;
  readonly dataDirectory: string;
  readonly host?: MemoryHost;
}

interface StoreMarker {
  readonly state: "initialized";
  readonly storeId: string;
}

interface StoredRow {
  readonly id: string;
  readonly text: string;
  readonly created_at: string;
  readonly metadata_json: string;
  readonly normalized_text: string;
  readonly content_hash: string;
  readonly byte_size: number;
}

interface StoreState {
  readonly root: SecureRoot;
  readonly databasePath: string;
  readonly markerPath: string;
  readonly databaseIdentity: FileIdentity;
  readonly markerIdentity: FileIdentity;
  readonly marker: StoreMarker;
  readonly markerBytes: Uint8Array;
  readonly database: DatabaseSync;
}

export class MemoryLocal implements Memory {
  readonly capabilities = Object.freeze({ capture: true, forget: true });
  readonly directory: string;
  readonly config: MemoryLocalConfig;

  readonly #state: StoreState;
  readonly #runtimeCapture: MemoryRuntimeCaptureGrant | undefined;
  readonly #activeOperations = new Set<Promise<void>>();
  #writeTail: Promise<void> = Promise.resolve();
  #closed = false;
  #stopPromise: Promise<void> | undefined;

  private constructor(
    config: MemoryLocalConfig,
    state: StoreState,
    runtimeCapture: MemoryRuntimeCaptureGrant | undefined,
  ) {
    this.config = config;
    this.directory = state.root.path;
    this.#state = state;
    this.#runtimeCapture = runtimeCapture;
  }

  static async open(options: OpenMemoryLocalOptions): Promise<MemoryLocal> {
    const config = parseMemoryLocalConfig(options.config);
    const directory = config.directory === undefined
      ? resolve(options.dataDirectory)
      : isAbsolute(config.directory)
        ? resolve(config.directory)
        : resolve(options.configDirectory, config.directory);
    const runtimeCapture = resolveRuntimeCapture(config, options.host);
    const state = await openStore(directory);
    return new MemoryLocal(config, state, runtimeCapture);
  }

  async recall(request: MemoryRecallRequest): Promise<MemoryRecallResult> {
    const complete = this.#beginOperation();
    try {
      throwIfAborted(request.signal);
      const query = normalizeLexical(request.query);
      if (query.length === 0) throw new MemoryLocalError("invalid_record", "Memory recall query must not be empty.");
      if (Buffer.byteLength(query, "utf8") > this.config.limits.maxTextBytes) {
        throw new MemoryLocalError("invalid_record", "Memory recall query exceeds the configured text bound.");
      }
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > this.config.limits.maxRecallResults) {
        throw new MemoryLocalError(
          "invalid_record",
          `Memory recall limit must be from 1 through ${this.config.limits.maxRecallResults}.`,
        );
      }
      await this.#verifyStore();
      const rows = this.#state.database.prepare(
        "SELECT id, text, created_at, metadata_json, normalized_text, content_hash, byte_size FROM records LIMIT ?",
      ).all(this.config.limits.maxRecords) as unknown as StoredRow[];
      const terms = lexicalTerms(query);
      const scored = rows.flatMap((row) => {
        const record = decodeStoredRow(row, this.config);
        const metadata = record.metadata;
        const conversationMatches = request.conversationId !== undefined
          && metadata?.conversationId === request.conversationId;
        const score = scoreLexical(row.normalized_text, query, terms, conversationMatches);
        if (score === 0) return [];
        return [{ record, score }];
      });
      scored.sort((left, right) => right.score - left.score
        || right.record.createdAt.localeCompare(left.record.createdAt)
        || left.record.id.localeCompare(right.record.id));
      throwIfAborted(request.signal);
      await this.#verifyStore();
      return Object.freeze({ records: Object.freeze(scored.slice(0, request.limit).map(({ record }) => record)) });
    } finally {
      complete();
    }
  }

  async capture(request: MemoryCaptureRequest): Promise<void> {
    const complete = this.#beginOperation();
    try {
      throwIfAborted(request.signal);
      const source = validateMemoryRecord(request.record, this.config.limits).record;
      let records: readonly MemoryRecord[] = [source];
      if (this.config.capture.mode === "runtime") {
        const grant = this.#runtimeCapture;
        if (grant === undefined) {
          throw new MemoryLocalError("runtime_capture_unavailable", "Runtime-backed memory capture was not explicitly granted.");
        }
        let result;
        try {
          result = await grant.complete({
            instructions: "Extract durable standalone memory facts from the input. Do not invent facts. Return only the requested structured object.",
            input: source.text,
            responseSchema: runtimeCaptureResponseSchema(this.config.capture.maxRecords),
            maxOutputTokens: this.config.capture.maxOutputTokens,
            signal: request.signal,
          });
        } catch (error) {
          throwIfAborted(request.signal);
          throw new MemoryLocalError("runtime_capture_invalid", "Runtime-backed memory capture failed.", { cause: error });
        }
        records = validateRuntimeCaptureResult(result, source, this.config);
      }
      const validated = records.map((record) => validateMemoryRecord(record, this.config.limits));
      await this.#enqueueWrite(async () => {
        throwIfAborted(request.signal);
        await this.#verifyStore();
        insertRecords(this.#state.database, validated, this.config);
        await this.#verifyStore();
      });
    } finally {
      complete();
    }
  }

  async forget(request: MemoryForgetRequest): Promise<boolean> {
    const complete = this.#beginOperation();
    try {
      throwIfAborted(request.signal);
      validateRecordId(request.recordId);
      return await this.#enqueueWrite(async () => {
        throwIfAborted(request.signal);
        await this.#verifyStore();
        const result = this.#state.database.prepare("DELETE FROM records WHERE id = ?").run(request.recordId);
        await this.#verifyStore();
        return Number(result.changes) === 1;
      });
    } finally {
      complete();
    }
  }

  async health(context: ModuleHealthContext): Promise<ModuleHealth> {
    if (this.#closed) return health("unhealthy", "Memory store is closed.");
    try {
      throwIfAborted(context.signal);
      await this.#verifyStore();
      quickCheck(this.#state.database);
      return health("healthy", "Owner-private memory store is ready.");
    } catch {
      return health("unhealthy", "Memory store integrity could not be proven.");
    }
  }

  async stop(_context?: ModuleStopContext): Promise<void> {
    this.#stopPromise ??= this.#stopInternal();
    await this.#stopPromise;
  }

  async #stopInternal(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#activeOperations]);
    await this.#writeTail;
    this.#state.database.close();
    await this.#state.root.handle.close();
  }

  async #verifyStore(): Promise<void> {
    await verifySecureRoot(this.#state.root);
    const databaseIdentity = await inspectSecureFile(this.#state.databasePath);
    if (!sameFileIdentity(this.#state.databaseIdentity, databaseIdentity)) {
      throw new MemoryLocalError("unsafe_store", "Memory database identity changed after opening.");
    }
    const markerRead = await readSecureFile(this.#state.markerPath, MARKER_MAX_BYTES);
    if (!sameFileIdentity(this.#state.markerIdentity, markerRead.identity)) {
      throw new MemoryLocalError("unsafe_store", "Permanent memory marker identity changed after opening.");
    }
    const marker = parseMarker(markerRead.bytes);
    if (!Buffer.from(markerRead.bytes).equals(Buffer.from(this.#state.markerBytes))) {
      throw new MemoryLocalError("unsafe_store", "Permanent memory marker content changed after opening.");
    }
    assertInitializedMarkerBytes(markerRead.bytes, marker);
    try {
      quickCheck(this.#state.database);
      verifyDatabaseBinding(
        this.#state.database,
        marker,
        this.#state.databaseIdentity,
        this.#state.markerIdentity,
      );
    } catch (error) {
      if (error instanceof MemoryLocalError) throw error;
      throw new MemoryLocalError("corrupt_store", "Memory database integrity verification failed.", { cause: error });
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new MemoryLocalError("closed", "Memory store is closed.");
  }

  #beginOperation(): () => void {
    this.#assertOpen();
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolvePromise) => {
      resolveDone = resolvePromise;
    });
    this.#activeOperations.add(done);
    return () => {
      this.#activeOperations.delete(done);
      resolveDone?.();
    };
  }

  #enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writeTail.then(operation);
    this.#writeTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export async function openMemoryLocal(options: OpenMemoryLocalOptions): Promise<MemoryLocal> {
  return await MemoryLocal.open(options);
}

async function openStore(directory: string): Promise<StoreState> {
  const root = await openSecureRoot(directory);
  const databasePath = join(root.path, MEMORY_LOCAL_DATABASE_FILENAME);
  const markerPath = join(root.path, MEMORY_LOCAL_MARKER_FILENAME);
  const databaseExists = await pathExists(databasePath);
  const markerExists = await pathExists(markerPath);
  try {
    if (!databaseExists && !markerExists) {
      const entries = await readdir(root.path);
      if (entries.length !== 0) {
        throw new MemoryLocalError(
          "incomplete_initialization",
          "Memory directory is non-empty but has no permanent store identity.",
        );
      }
      return await initializeStore(root, databasePath, markerPath);
    }
    if (!databaseExists || !markerExists) {
      throw new MemoryLocalError(
        "incomplete_initialization",
        "Memory database and permanent marker must either both exist or both be absent.",
      );
    }
    return await openExistingStore(root, databasePath, markerPath);
  } catch (error) {
    await root.handle.close().catch(() => undefined);
    throw error;
  }
}

async function initializeStore(
  root: SecureRoot,
  databasePath: string,
  markerPath: string,
): Promise<StoreState> {
  const storeId = randomUUID();
  const markerHandle = await createSecureFile(markerPath);
  const markerIdentity = identity(await markerHandle.stat());
  let database: DatabaseSync | undefined;
  try {
    await writeMarkerState(markerHandle, "initializing", storeId);
    await root.handle.sync();
    const inFlightMarker = await readSecureFile(markerPath, MARKER_MAX_BYTES);
    assertMarkerBytes(inFlightMarker.bytes, "initializing", storeId);
    if (!sameFileIdentity(markerIdentity, inFlightMarker.identity)) {
      throw new MemoryLocalError("unsafe_store", "First-run marker identity changed during initialization.");
    }

    const databaseHandle = await createSecureFile(databasePath);
    try {
      await databaseHandle.sync();
    } finally {
      await databaseHandle.close();
    }
    const databaseIdentity = await inspectSecureFile(databasePath);
    database = new DatabaseSync(databasePath, { timeout: 0 });
    const openedDatabaseIdentity = await inspectSecureFile(databasePath);
    if (!sameFileIdentity(databaseIdentity, openedDatabaseIdentity)) {
      throw new MemoryLocalError("unsafe_store", "Memory database identity changed while SQLite opened it.");
    }
    configureDatabase(database);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(`
        CREATE TABLE metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT;
        CREATE TABLE records (
          id TEXT PRIMARY KEY NOT NULL,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          normalized_text TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          byte_size INTEGER NOT NULL CHECK (byte_size >= 0)
        ) STRICT;
        CREATE INDEX records_created_at ON records(created_at DESC, id ASC);
      `);
      database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)").run("schema", STORE_SCHEMA);
      database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)").run("store_id", storeId);
      database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)").run("database_device", databaseIdentity.device);
      database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)").run("database_inode", databaseIdentity.inode);
      database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)").run("marker_device", markerIdentity.device);
      database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)").run("marker_inode", markerIdentity.inode);
      database.exec("COMMIT");
    } catch (error) {
      rollback(database);
      throw error;
    }

    const marker = Object.freeze({ state: "initialized" as const, storeId });
    quickCheck(database);
    verifyDatabaseBinding(database, marker, databaseIdentity, markerIdentity);
    await root.handle.sync();
    await verifySecureRoot(root);
    const databaseBeforePublish = await inspectSecureFile(databasePath);
    const markerBeforePublish = await readSecureFile(markerPath, MARKER_MAX_BYTES);
    if (!sameFileIdentity(databaseIdentity, databaseBeforePublish)
      || !sameFileIdentity(markerIdentity, markerBeforePublish.identity)) {
      throw new MemoryLocalError("unsafe_store", "Memory store identity changed before first-run publication.");
    }
    assertMarkerBytes(markerBeforePublish.bytes, "initializing", storeId);
    if (!sameFileIdentity(markerIdentity, identity(await markerHandle.stat()))) {
      throw new MemoryLocalError("unsafe_store", "Pinned first-run marker descriptor changed before publication.");
    }

    await writeMarkerState(markerHandle, "initialized", storeId);
    await root.handle.sync();
    const markerRead = await readSecureFile(markerPath, MARKER_MAX_BYTES);
    if (!sameFileIdentity(markerIdentity, markerRead.identity)) {
      throw new MemoryLocalError("unsafe_store", "First-run marker identity changed during publication.");
    }
    assertInitializedMarkerBytes(markerRead.bytes, marker);
    return {
      root,
      databasePath,
      markerPath,
      databaseIdentity,
      markerIdentity,
      marker,
      markerBytes: Uint8Array.from(markerRead.bytes),
      database,
    };
  } catch (error) {
    database?.close();
    throw new MemoryLocalError(
      error instanceof MemoryLocalError ? error.code : "corrupt_store",
      error instanceof MemoryLocalError ? error.message : "Memory store initialization failed and was left for inspection.",
      { cause: error },
    );
  } finally {
    await markerHandle.close().catch(() => undefined);
  }
}

async function openExistingStore(
  root: SecureRoot,
  databasePath: string,
  markerPath: string,
): Promise<StoreState> {
  const databaseIdentity = await inspectSecureFile(databasePath);
  const markerRead = await readSecureFile(markerPath, MARKER_MAX_BYTES);
  const marker = parseMarker(markerRead.bytes);
  assertInitializedMarkerBytes(markerRead.bytes, marker);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { timeout: 0 });
    const openedDatabaseIdentity = await inspectSecureFile(databasePath);
    if (!sameFileIdentity(databaseIdentity, openedDatabaseIdentity)) {
      throw new MemoryLocalError("unsafe_store", "Memory database identity changed while SQLite opened it.");
    }
    configureDatabase(database);
    quickCheck(database);
    verifyDatabaseBinding(database, marker, databaseIdentity, markerRead.identity);
    await verifySecureRoot(root);
    const finalDatabase = await inspectSecureFile(databasePath);
    const finalMarker = await readSecureFile(markerPath, MARKER_MAX_BYTES);
    if (!sameFileIdentity(databaseIdentity, finalDatabase)
      || !sameFileIdentity(markerRead.identity, finalMarker.identity)) {
      throw new MemoryLocalError("unsafe_store", "Memory store identity changed during open.");
    }
    assertInitializedMarkerBytes(finalMarker.bytes, marker);
    return {
      root,
      databasePath,
      markerPath,
      databaseIdentity,
      markerIdentity: markerRead.identity,
      marker,
      markerBytes: Uint8Array.from(markerRead.bytes),
      database,
    };
  } catch (error) {
    database?.close();
    throw new MemoryLocalError(
      error instanceof MemoryLocalError ? error.code : "corrupt_store",
      error instanceof MemoryLocalError ? error.message : "Memory database is corrupt or incompatible; refusing to modify it.",
      { cause: error },
    );
  }
}

function configureDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 0;");
}

function quickCheck(database: DatabaseSync): void {
  const rows = database.prepare("PRAGMA quick_check(1)").all() as unknown as Record<string, unknown>[];
  if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
    throw new MemoryLocalError("corrupt_store", "SQLite quick_check did not return ok.");
  }
}

function verifyDatabaseBinding(
  database: DatabaseSync,
  marker: StoreMarker,
  databaseIdentity: FileIdentity,
  markerIdentity: FileIdentity,
): void {
  const rows = database.prepare("SELECT key, value FROM metadata").all() as unknown as { key: string; value: string }[];
  const metadata = new Map(rows.map((row) => [row.key, row.value]));
  if (metadata.size !== 6
    || metadata.get("schema") !== STORE_SCHEMA
    || metadata.get("store_id") !== marker.storeId
    || metadata.get("database_device") !== databaseIdentity.device
    || metadata.get("database_inode") !== databaseIdentity.inode
    || metadata.get("marker_device") !== markerIdentity.device
    || metadata.get("marker_inode") !== markerIdentity.inode) {
    throw new MemoryLocalError("corrupt_store", "Memory database identity metadata does not match the permanent marker.");
  }
}

function parseMarker(bytes: Uint8Array): StoreMarker {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new MemoryLocalError("corrupt_store", "Permanent first-run memory marker is not valid UTF-8.", { cause: error });
  }
  const match = /^(initializing|initialized):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\n$/u.exec(value);
  if (match === null) markerInvalid();
  if (match[1] === "initializing") {
    throw new MemoryLocalError(
      "incomplete_initialization",
      "Permanent first-run memory marker is still initializing; preserving it for operator inspection.",
    );
  }
  return Object.freeze({ state: "initialized", storeId: match[2]! });
}

function markerInvalid(): never {
  throw new MemoryLocalError("corrupt_store", "Permanent first-run memory marker has invalid exact bytes.");
}

function assertInitializedMarkerBytes(bytes: Uint8Array, marker: StoreMarker): void {
  assertMarkerBytes(bytes, "initialized", marker.storeId);
}

function assertMarkerBytes(
  bytes: Uint8Array,
  state: "initializing" | "initialized",
  storeId: string,
): void {
  const canonical = Buffer.from(`${state}:${storeId}\n`, "utf8");
  if (!Buffer.from(bytes).equals(canonical)) {
    throw new MemoryLocalError("corrupt_store", "Permanent first-run memory marker bytes are not canonical.");
  }
}

async function writeMarkerState(
  handle: FileHandle,
  state: "initializing" | "initialized",
  storeId: string,
): Promise<void> {
  const bytes = Buffer.from(`${state}:${storeId}\n`, "utf8");
  const result = await handle.write(bytes, 0, bytes.byteLength, 0);
  if (result.bytesWritten !== bytes.byteLength) {
    throw new MemoryLocalError("incomplete_initialization", "First-run marker write was incomplete.");
  }
  await handle.truncate(bytes.byteLength);
  await handle.sync();
}

function decodeStoredRow(row: StoredRow, config: MemoryLocalConfig): MemoryRecord {
  try {
    const metadata = parseStoredMetadata(row.metadata_json);
    const validated = validateMemoryRecord({
      id: row.id,
      text: row.text,
      createdAt: row.created_at,
      ...(metadata === undefined ? {} : { metadata }),
    }, config.limits);
    if (validated.normalizedText !== row.normalized_text
      || validated.contentHash !== row.content_hash
      || validated.byteSize !== row.byte_size) {
      throw new Error("stored derived fields do not match record content");
    }
    return validated.record;
  } catch (error) {
    throw new MemoryLocalError("corrupt_store", "Stored memory record is invalid or inconsistent.", { cause: error });
  }
}

function insertRecords(
  database: DatabaseSync,
  records: readonly ValidatedMemoryRecord[],
  config: MemoryLocalConfig,
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = database.prepare("SELECT content_hash FROM records WHERE id = ?");
    const insert = database.prepare(
      "INSERT INTO records(id, text, created_at, metadata_json, normalized_text, content_hash, byte_size) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const capacity = database.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes FROM records").get() as unknown as { count: number; bytes: number };
    let count = Number(capacity.count);
    let bytes = Number(capacity.bytes);
    const seen = new Map<string, string>();
    for (const item of records) {
      const repeated = seen.get(item.record.id);
      if (repeated !== undefined) {
        if (repeated === item.contentHash) continue;
        throw new MemoryLocalError("duplicate_record", `Capture returned conflicting duplicate id ${JSON.stringify(item.record.id)}.`);
      }
      seen.set(item.record.id, item.contentHash);
      const row = existing.get(item.record.id) as unknown as { content_hash: string } | undefined;
      if (row !== undefined) {
        if (row.content_hash === item.contentHash) continue;
        throw new MemoryLocalError("duplicate_record", `Memory id ${JSON.stringify(item.record.id)} already has different content.`);
      }
      count += 1;
      bytes += item.byteSize;
      if (count > config.limits.maxRecords || bytes > config.limits.maxTotalBytes) {
        throw new MemoryLocalError("capacity_exceeded", "Memory capacity would be exceeded; no records were captured.");
      }
      insert.run(
        item.record.id,
        item.record.text,
        item.record.createdAt,
        item.metadataJson,
        item.normalizedText,
        item.contentHash,
        item.byteSize,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function validateRuntimeCaptureResult(
  result: Awaited<ReturnType<MemoryRuntimeCaptureGrant["complete"]>>,
  source: MemoryRecord,
  config: MemoryLocalConfig,
): readonly MemoryRecord[] {
  if (result === null || typeof result !== "object" || Array.isArray(result)
    || typeof result.text !== "string") {
    throw new MemoryLocalError("runtime_capture_invalid", "Runtime capture returned an invalid result object.");
  }
  if (Buffer.byteLength(result.text, "utf8") > config.capture.maxOutputBytes) {
    throw new MemoryLocalError("runtime_capture_invalid", "Runtime capture exceeded its output byte bound.");
  }
  let output: unknown = result.structuredOutput;
  if (output === undefined) {
    try {
      output = JSON.parse(result.text) as unknown;
    } catch (error) {
      throw new MemoryLocalError("runtime_capture_invalid", "Runtime capture returned invalid JSON.", { cause: error });
    }
  }
  if (output === null || typeof output !== "object" || Array.isArray(output)
    || Object.getPrototypeOf(output) !== Object.prototype
    || Object.keys(output).length !== 1
    || !Array.isArray((output as Record<string, unknown>).records)) {
    throw new MemoryLocalError("runtime_capture_invalid", "Runtime capture returned an invalid structured object.");
  }
  const extracted = (output as { records: unknown[] }).records;
  if (extracted.length === 0 || extracted.length > config.capture.maxRecords) {
    throw new MemoryLocalError("runtime_capture_invalid", "Runtime capture returned an invalid record count.");
  }
  let serialized: string;
  try {
    serialized = canonicalJson(output as never);
  } catch (error) {
    throw new MemoryLocalError("runtime_capture_invalid", "Runtime capture returned non-JSON records.", { cause: error });
  }
  if (Buffer.byteLength(serialized, "utf8") > config.capture.maxOutputBytes) {
    throw new MemoryLocalError("runtime_capture_invalid", "Runtime capture exceeded its output byte bound.");
  }
  return Object.freeze(extracted.map((entry): MemoryRecord => {
    const rawText = entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>).text
      : undefined;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)
      || Object.getPrototypeOf(entry) !== Object.prototype
      || Object.keys(entry).length !== 1
      || typeof rawText !== "string") {
      throw new MemoryLocalError("runtime_capture_invalid", "Runtime capture returned an invalid extracted record.");
    }
    const text = rawText.trim();
    if (text.length === 0) {
      throw new MemoryLocalError("runtime_capture_invalid", "Runtime capture returned an empty extracted record.");
    }
    return Object.freeze({
      id: runtimeCaptureRecordId(source.id, text),
      text,
      createdAt: source.createdAt,
      ...(source.metadata === undefined ? {} : { metadata: source.metadata }),
    });
  }));
}

function runtimeCaptureRecordId(sourceId: string, text: string): string {
  const digest = createHash("sha256")
    .update(sourceId)
    .update("\0")
    .update(text)
    .digest("hex")
    .slice(0, 48);
  return `runtime:${digest}`;
}

function resolveRuntimeCapture(
  config: MemoryLocalConfig,
  host: MemoryHost | undefined,
): MemoryRuntimeCaptureGrant | undefined {
  if (config.capture.mode !== "runtime") return undefined;
  if (host?.grantedCapabilities.has(HOST_CAPABILITY_MEMORY_RUNTIME_CAPTURE) !== true) {
    throw new MemoryLocalError("runtime_capture_unavailable", "Runtime-backed capture requires an explicit host grant.");
  }
  const grant = host.runtimeCapture;
  if (grant === undefined || typeof grant !== "object" || grant === null || typeof grant.complete !== "function") {
    throw new MemoryLocalError("runtime_capture_unavailable", "Runtime-backed capture grant is missing or invalid.");
  }
  return grant;
}

function runtimeCaptureResponseSchema(maxRecords: number): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: "object",
    required: ["records"],
    additionalProperties: false,
    properties: Object.freeze({
      records: Object.freeze({
        type: "array",
        minItems: 1,
        maxItems: maxRecords,
        items: Object.freeze({
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: Object.freeze({ text: Object.freeze({ type: "string", minLength: 1 }) }),
        }),
      }),
    }),
  });
}

function validateRecordId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)) {
    throw new MemoryLocalError("invalid_record", "recordId has an invalid identifier.");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original database failure.
  }
}

function health(status: "healthy" | "unhealthy", summary: string): ModuleHealth {
  return Object.freeze({ status, checkedAt: new Date().toISOString(), summary });
}
