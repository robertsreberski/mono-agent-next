import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  TaskState,
  type Message,
  type Part,
  type SendMessageRequest,
  type SendMessageResult,
  type StreamResponse,
  type Task,
} from "@a2a-js/sdk";
import {
  RequestMalformedError,
  type A2ARequestHandler,
  type ServerCallContext,
  type TaskStore,
} from "@a2a-js/sdk/server";

import { A2AProviderError } from "./errors.js";

export const A2A_IDEMPOTENCY_METADATA_KEY = "mono-agent.dev/a2a-idempotency/v1";
export const A2A_IDEMPOTENCY_SCHEMA_VERSION = 1;
export const A2A_IDEMPOTENCY_EXTENSION_URI = "https://mono-agent.dev/extensions/a2a-idempotency/v1";

const RECORD_SCHEMA_VERSION = 1;
const STORE_MANIFEST_SCHEMA_VERSION = 1;
const STORE_MANIFEST_FILE = "manifest.json";
const SLOTS_DIRECTORY = "slots";
const RECORD_FILE_PATTERN = /^[a-f0-9]{64}\.json$/u;
const SLOT_FILE_PATTERN = /^slot-([0-9]{1,7})\.json$/u;
const TEMPORARY_RECORD_FILE_PATTERN = /^\.[a-f0-9]{64}\.[a-f0-9-]+\.tmp$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/u;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_READ_ATTEMPTS = 20;
const ACTIVE_POLL_MS = 50;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MIN_RETENTION_MS = 60_000;
const MAX_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_RECORDS = 10_000;
const MAX_RECORDS_LIMIT = 1_000_000;
const ERROR_MARKER = "[mono-agent:a2a-idempotency]";

export interface A2AProviderIdempotencyOptions {
  /** Owner-only durable record directory. */
  readonly stateDir: string;
  /** Stable provider/principal identity; never derive it from URLs or secrets. */
  readonly namespace: string;
  /** Terminal receipt retention. Must exceed every caller retry horizon. */
  readonly retentionMs?: number;
  /** Hard admission capacity; exhaustion fails closed without eviction. */
  readonly maxRecords?: number;
}

export type A2AIdempotencyFailureKind =
  | "capacity_exhausted"
  | "conflict"
  | "in_doubt"
  | "invalid_key"
  | "result_expired"
  | "unsupported";

interface IdempotencyEnvelope {
  readonly schemaVersion: 1;
  readonly key: string;
}

interface ActiveRecord {
  readonly schemaVersion: 1;
  readonly keyHash: string;
  readonly fingerprint: string;
  readonly status: "active";
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly slot: number;
  readonly taskId?: string;
  readonly acceptedResult?: SendMessageResult;
}

interface CompletedRecord {
  readonly schemaVersion: 1;
  readonly keyHash: string;
  readonly fingerprint: string;
  readonly status: "completed";
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly slot: number;
  readonly taskId?: string;
  readonly result: SendMessageResult;
}

interface TombstoneRecord {
  readonly schemaVersion: 1;
  readonly keyHash: string;
  readonly fingerprint: string;
  readonly status: "tombstone";
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly tombstonedAtMs: number;
  readonly slot: number;
  readonly taskId?: string;
}

type IdempotencyRecord = ActiveRecord | CompletedRecord | TombstoneRecord;
type NewActiveRecord = Omit<ActiveRecord, "slot">;

interface IdempotencyStore {
  load(keyHash: string): Promise<IdempotencyRecord | undefined>;
  /** Atomically wins the first durable admission for one logical key. */
  createActive(record: NewActiveRecord): Promise<ActiveRecord | undefined>;
  save(record: IdempotencyRecord): Promise<void>;
}

interface FileIdempotencyStoreHooks {
  /** Deterministic test seam after the admission is durable but before it is published. */
  readonly beforeAdmissionPublish?: () => Promise<void>;
  /** Deterministic test seam after publication but before the staging link is removed. */
  readonly afterAdmissionPublish?: () => Promise<void>;
  /** Deterministic test seam after opening a canonical record but before pathname revalidation. */
  readonly afterRecordOpen?: (input: { readonly keyHash: string; readonly attempt: number }) => Promise<void>;
}

interface RuntimeRequest {
  readonly fingerprint: string;
  readonly accepted: Promise<SendMessageResult>;
  readonly terminal: Promise<SendMessageResult>;
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface PrivateDirectory {
  readonly path: string;
  readonly identity: DirectoryIdentity;
}

interface StartedRequest {
  readonly accepted: SendMessageResult;
  readonly terminal: Promise<SendMessageResult>;
}

export async function createIdempotentA2ARequestHandler(input: {
  readonly delegate: A2ARequestHandler;
  readonly taskStore: TaskStore;
  readonly options: A2AProviderIdempotencyOptions;
  readonly logger?: {
    warn?(message: string, metadata?: Record<string, unknown>): void;
    error?(message: string, metadata?: Record<string, unknown>): void;
  };
  /** @internal Deterministic filesystem scheduling hooks for adversarial tests. */
  readonly storeHooks?: FileIdempotencyStoreHooks;
}): Promise<A2ARequestHandler> {
  validateA2AProviderIdempotencyOptions(input.options);
  const retentionMs = normalizeRetentionMs(input.options.retentionMs);
  const maxRecords = normalizeMaxRecords(input.options.maxRecords);
  const providerScope = idempotencyNamespaceHash(input.options.namespace);
  const store = await FileIdempotencyStore.create(
    input.options.stateDir.trim(),
    retentionMs,
    maxRecords,
    providerScope,
    input.storeHooks,
  );
  return new IdempotentA2ARequestHandler(
    input.delegate,
    input.taskStore,
    store,
    providerScope,
    input.logger,
  );
}

export function validateA2AProviderIdempotencyOptions(
  options: A2AProviderIdempotencyOptions,
): void {
  if (typeof options.stateDir !== "string" || options.stateDir.trim().length === 0) {
    throw new A2AProviderError(
      "invalid_config",
      "A2A durable idempotency requires a non-empty idempotency.stateDir.",
      { field: "idempotency.stateDir" },
    );
  }
  idempotencyNamespaceHash(options.namespace);
  normalizeRetentionMs(options.retentionMs);
  normalizeMaxRecords(options.maxRecords);
}

export function guardUnsupportedA2AIdempotency(
  delegate: A2ARequestHandler,
): A2ARequestHandler {
  return new UnsupportedIdempotencyA2ARequestHandler(delegate);
}

export function normalizeA2AIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new A2AProviderError(
      "invalid_idempotency_key",
      "A2A idempotencyKey must be 1-200 ASCII letters, digits, or . _ : @ - and start with a letter or digit.",
      { field: "idempotencyKey" },
    );
  }
  return key;
}

export function a2aIdempotencyEnvelope(key: string): IdempotencyEnvelope {
  return {
    schemaVersion: A2A_IDEMPOTENCY_SCHEMA_VERSION,
    key: normalizeA2AIdempotencyKey(key),
  };
}

export function stableA2AMessageId(key: string): string {
  return `mono-idem-${sha256(normalizeA2AIdempotencyKey(key)).slice(0, 32)}`;
}

export function defaultA2AIdempotencyStateDir(cwd: string, namespace: string): string {
  const label = namespace.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48) || "a2a";
  const digest = sha256(namespace).slice(0, 12);
  return resolve(cwd, ".mono-agent", "a2a-idempotency", `${label}-${digest}`);
}

export function classifyA2AIdempotencyTransportError(reason: string): A2AIdempotencyFailureKind | undefined {
  if (!reason.includes(ERROR_MARKER)) {
    return undefined;
  }
  if (reason.includes(" idempotency_conflict ")) {
    return "conflict";
  }
  if (reason.includes(" idempotency_capacity_exhausted ")) {
    return "capacity_exhausted";
  }
  if (reason.includes(" idempotency_in_doubt ")) {
    return "in_doubt";
  }
  if (reason.includes(" invalid_idempotency_key ")) {
    return "invalid_key";
  }
  if (reason.includes(" idempotency_result_expired ")) {
    return "result_expired";
  }
  if (reason.includes(" idempotency_unsupported ")) {
    return "unsupported";
  }
  return undefined;
}

class DelegatingA2ARequestHandler implements A2ARequestHandler {
  constructor(protected readonly delegate: A2ARequestHandler) {}

  getAgentCard() {
    return this.delegate.getAgentCard();
  }

  getAuthenticatedExtendedAgentCard(
    params: Parameters<A2ARequestHandler["getAuthenticatedExtendedAgentCard"]>[0],
    context: ServerCallContext,
  ) {
    return this.delegate.getAuthenticatedExtendedAgentCard(params, context);
  }

  sendMessage(params: SendMessageRequest, context: ServerCallContext) {
    return this.delegate.sendMessage(params, context);
  }

  async *sendMessageStream(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    yield* this.delegate.sendMessageStream(params, context);
  }

  getTask(params: Parameters<A2ARequestHandler["getTask"]>[0], context: ServerCallContext) {
    return this.delegate.getTask(params, context);
  }

  cancelTask(params: Parameters<A2ARequestHandler["cancelTask"]>[0], context: ServerCallContext) {
    return this.delegate.cancelTask(params, context);
  }

  createTaskPushNotificationConfig(
    params: Parameters<A2ARequestHandler["createTaskPushNotificationConfig"]>[0],
    context: ServerCallContext,
  ) {
    return this.delegate.createTaskPushNotificationConfig(params, context);
  }

  getTaskPushNotificationConfig(
    params: Parameters<A2ARequestHandler["getTaskPushNotificationConfig"]>[0],
    context: ServerCallContext,
  ) {
    return this.delegate.getTaskPushNotificationConfig(params, context);
  }

  listTaskPushNotificationConfigs(
    params: Parameters<A2ARequestHandler["listTaskPushNotificationConfigs"]>[0],
    context: ServerCallContext,
  ) {
    return this.delegate.listTaskPushNotificationConfigs(params, context);
  }

  deleteTaskPushNotificationConfig(
    params: Parameters<A2ARequestHandler["deleteTaskPushNotificationConfig"]>[0],
    context: ServerCallContext,
  ) {
    return this.delegate.deleteTaskPushNotificationConfig(params, context);
  }

  resubscribe(params: Parameters<A2ARequestHandler["resubscribe"]>[0], context: ServerCallContext) {
    return this.delegate.resubscribe(params, context);
  }

  listTasks(params: Parameters<A2ARequestHandler["listTasks"]>[0], context: ServerCallContext) {
    return this.delegate.listTasks(params, context);
  }
}

class UnsupportedIdempotencyA2ARequestHandler extends DelegatingA2ARequestHandler {
  async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Message | Task> {
    rejectUnsupportedIdempotencyEnvelope(params);
    return await super.sendMessage(params, context);
  }

  async *sendMessageStream(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    rejectUnsupportedIdempotencyEnvelope(params);
    yield* super.sendMessageStream(params, context);
  }
}

class IdempotentA2ARequestHandler extends DelegatingA2ARequestHandler {
  private readonly activeRequests = new Map<string, RuntimeRequest>();
  private readonly liveImmediateTasks = new Set<string>();

  constructor(
    delegate: A2ARequestHandler,
    private readonly taskStore: TaskStore,
    private readonly store: IdempotencyStore,
    private readonly providerScope: string,
    private readonly logger?: {
      warn?(message: string, metadata?: Record<string, unknown>): void;
      error?(message: string, metadata?: Record<string, unknown>): void;
    },
  ) {
    super(delegate);
  }

  async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Message | Task> {
    const admission = this.admissionFor(params, context);
    if (admission === undefined) {
      return await this.delegate.sendMessage(params, context);
    }

    const running = this.activeRequests.get(admission.keyHash);
    if (running !== undefined) {
      assertSameFingerprint(running.fingerprint, admission.fingerprint);
      return await projectRuntimeResult(running, params.configuration);
    }

    const started = this.admitAndStart(admission, params, context);
    const accepted = started.then((value) => value.accepted);
    const terminal = started.then((value) => value.terminal);
    // Either projection may be unused by a particular caller. Attach an
    // observation handler without changing the promises returned to callers.
    void accepted.catch(() => undefined);
    void terminal.catch(() => undefined);
    const runtime: RuntimeRequest = {
      fingerprint: admission.fingerprint,
      accepted,
      terminal,
    };
    this.activeRequests.set(admission.keyHash, runtime);
    void terminal.then(() => {
      const current = this.activeRequests.get(admission.keyHash);
      if (current === runtime) {
        this.activeRequests.delete(admission.keyHash);
      }
    }, () => {
      const current = this.activeRequests.get(admission.keyHash);
      if (current === runtime) {
        this.activeRequests.delete(admission.keyHash);
      }
    });
    return await projectRuntimeResult(runtime, params.configuration);
  }

  async *sendMessageStream(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    if (this.admissionFor(params, context) === undefined) {
      yield* this.delegate.sendMessageStream(params, context);
      return;
    }

    // An idempotent stream intentionally converges through the blocking send
    // path. It yields the one authoritative task/message rather than replaying
    // transient deltas, which cannot be reconstructed durably after restart.
    const result = await this.sendMessage(params, context);
    yield "status" in result
      ? { payload: { $case: "task", value: result } }
      : { payload: { $case: "message", value: result } };
  }

  private admissionFor(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): { readonly keyHash: string; readonly fingerprint: string } | undefined {
    const envelope = readEnvelope(params.metadata?.[A2A_IDEMPOTENCY_METADATA_KEY]);
    if (envelope === undefined) {
      return undefined;
    }
    if (!context.requestedExtensions?.includes(A2A_IDEMPOTENCY_EXTENSION_URI)) {
      throw protocolIdempotencyError(
        "invalid_idempotency_key",
        `The ${A2A_IDEMPOTENCY_EXTENSION_URI} extension must be requested through the A2A-Extensions service parameter.`,
      );
    }
    context.addActivatedExtension(A2A_IDEMPOTENCY_EXTENSION_URI);
    const tenant = context.tenant ?? params.tenant ?? "";
    return {
      keyHash: sha256(canonicalJson({ providerScope: this.providerScope, key: envelope.key })),
      fingerprint: requestFingerprint(params, tenant, this.providerScope),
    };
  }

  private async admitAndStart(
    admission: { readonly keyHash: string; readonly fingerprint: string },
    params: SendMessageRequest,
    context: ServerCallContext,
  ): Promise<StartedRequest> {
    let existing = await this.store.load(admission.keyHash);
    if (existing !== undefined) {
      const result = this.resultFromExisting(existing, admission.fingerprint);
      return { accepted: result, terminal: Promise.resolve(result) };
    }

    const now = Date.now();
    const activeCandidate: NewActiveRecord = {
      schemaVersion: RECORD_SCHEMA_VERSION,
      keyHash: admission.keyHash,
      fingerprint: admission.fingerprint,
      status: "active",
      createdAtMs: now,
      updatedAtMs: now,
    };
    // This fsynced admission is deliberately before the responder/model call.
    const active = await this.store.createActive(activeCandidate);
    if (active === undefined) {
      // A second provider process may share this directory. The exclusive
      // record creation is the cross-process serialization boundary: the
      // loser reads and reuses/fails closed, never invokes the responder.
      existing = await this.store.load(admission.keyHash);
      if (existing === undefined) {
        throw storeError("A2A idempotency admission changed during exclusive creation; refusing execution.");
      }
      const result = this.resultFromExisting(existing, admission.fingerprint);
      return { accepted: result, terminal: Promise.resolve(result) };
    }

    const result = await this.delegate.sendMessage(asImmediateExecutionRequest(params), context);
    const taskId = taskIdFromResult(result);
    if (isNonTerminalTask(result)) {
      const accepted: ActiveRecord = {
        ...active,
        updatedAtMs: Date.now(),
        ...(taskId === undefined ? {} : { taskId }),
        acceptedResult: cloneResult(result),
      };
      await this.store.save(accepted);
      if (taskId !== undefined) {
        this.liveImmediateTasks.add(taskId);
        return {
          accepted: result,
          terminal: this.monitorImmediateTask(accepted, context),
        };
      }
      throw storeError("A2A immediate task did not include a task id; refusing an unmonitorable admission.");
    }

    await this.store.save({
      schemaVersion: RECORD_SCHEMA_VERSION,
      keyHash: active.keyHash,
      fingerprint: active.fingerprint,
      status: "completed",
      createdAtMs: active.createdAtMs,
      updatedAtMs: Date.now(),
      slot: active.slot,
      ...(taskId === undefined ? {} : { taskId }),
      result: cloneResult(result),
    });
    return { accepted: result, terminal: Promise.resolve(result) };
  }

  private resultFromExisting(record: IdempotencyRecord, fingerprint: string): SendMessageResult {
    assertSameFingerprint(record.fingerprint, fingerprint);
    if (record.status === "completed") {
      return cloneResult(record.result);
    }
    if (record.status === "tombstone") {
      throw protocolIdempotencyError(
        "idempotency_result_expired",
        "The durable terminal result was compacted after its retention horizon; the logical key remains permanently bound and will not be re-executed.",
      );
    }
    if (
      record.taskId !== undefined
      && record.acceptedResult !== undefined
      && this.liveImmediateTasks.has(record.taskId)
    ) {
      return cloneResult(record.acceptedResult);
    }
    throw protocolIdempotencyError(
      "idempotency_in_doubt",
      "This logical A2A dispatch was durably admitted, but its prior provider process did not record a terminal result. Refusing automatic re-execution.",
    );
  }

  private async monitorImmediateTask(record: ActiveRecord, context: ServerCallContext): Promise<SendMessageResult> {
    const taskId = record.taskId;
    if (taskId === undefined) {
      throw storeError("A2A active idempotency record is missing taskId.");
    }
    try {
      while (this.liveImmediateTasks.has(taskId)) {
        const task = await this.taskStore.load(taskId, context);
        if (task !== undefined && isTerminalState(task.status?.state)) {
          await this.store.save({
            schemaVersion: RECORD_SCHEMA_VERSION,
            keyHash: record.keyHash,
            fingerprint: record.fingerprint,
            status: "completed",
            createdAtMs: record.createdAtMs,
            updatedAtMs: Date.now(),
            slot: record.slot,
            taskId,
            result: cloneResult(task),
          });
          return task;
        }
        await unrefDelay(ACTIVE_POLL_MS);
      }
      throw storeError("A2A idempotent task monitoring ended before a terminal result was recorded.");
    } catch (error) {
      this.logger?.error?.("A2A idempotency monitor failed; the admission remains fail-closed.", {
        taskId,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.liveImmediateTasks.delete(taskId);
    }
  }
}

class FileIdempotencyStore implements IdempotencyStore {
  private constructor(
    private readonly stateDir: string,
    private readonly stateDirIdentity: DirectoryIdentity,
    private readonly retentionMs: number,
    private readonly maxRecords: number,
    private readonly providerScope: string,
    private readonly slotsDir: string,
    private readonly slotsDirIdentity: DirectoryIdentity,
    private readonly hooks: FileIdempotencyStoreHooks,
  ) {}

  static async create(
    inputPath: string,
    retentionMs: number,
    maxRecords: number,
    providerScope: string,
    hooks: FileIdempotencyStoreHooks = {},
  ): Promise<FileIdempotencyStore> {
    const stateDirectory = await ensurePrivateStateDir(resolve(inputPath));
    const slotsDirectory = await ensurePrivateStateDir(resolve(stateDirectory.path, SLOTS_DIRECTORY));
    const store = new FileIdempotencyStore(
      stateDirectory.path,
      stateDirectory.identity,
      retentionMs,
      maxRecords,
      providerScope,
      slotsDirectory.path,
      slotsDirectory.identity,
      hooks,
    );
    await store.ensureManifest();
    await store.pruneExpiredTerminalRecords();
    await store.reconcileOrphanSlots();
    return store;
  }

  async load(keyHash: string): Promise<IdempotencyRecord | undefined> {
    await this.assertDirectories();
    assertKeyHash(keyHash);
    const path = resolve(this.stateDir, `${keyHash}.json`);
    let raw: Buffer;
    try {
      raw = await secureReadPublishedRecord(path, this.stateDir, keyHash, this.hooks);
    } catch (error) {
      if (error instanceof RecordNotFoundError) {
        await this.assertDirectories();
        return undefined;
      }
      throw storeError("Failed to read A2A idempotency state.", error);
    }
    let record: IdempotencyRecord;
    try {
      record = parseRecord(JSON.parse(raw.toString("utf8")), keyHash);
    } catch (error) {
      throw storeError("A2A idempotency state is malformed; refusing automatic execution.", error);
    }
    await this.verifySlot(record.slot, keyHash);
    if (record.status === "completed" && isExpired(record, this.retentionMs)) {
      record = await this.compactExpiredRecord(record);
    }
    await this.assertDirectories();
    return record;
  }

  async save(record: IdempotencyRecord): Promise<void> {
    await this.assertDirectories();
    assertKeyHash(record.keyHash);
    await this.verifySlot(record.slot, record.keyHash);
    const destination = resolve(this.stateDir, `${record.keyHash}.json`);
    const temporary = resolve(this.stateDir, `.${record.keyHash}.${randomUUID()}.tmp`);
    const contents = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
    if (contents.byteLength > MAX_RECORD_BYTES) {
      throw storeError("A2A idempotency result exceeds the durable record limit.");
    }
    try {
      await assertReplaceableRecord(destination);
      const handle = await open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await handle.writeFile(contents);
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, destination);
      await fsyncDirectory(this.stateDir, this.stateDirIdentity);
      await this.assertDirectories();
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw storeError("Failed to persist A2A idempotency state.", error);
    }
  }

  async createActive(record: NewActiveRecord): Promise<ActiveRecord | undefined> {
    await this.assertDirectories();
    assertKeyHash(record.keyHash);
    const slot = await this.allocateSlot(record.keyHash);
    const admitted: ActiveRecord = { ...record, slot };
    const destination = resolve(this.stateDir, `${record.keyHash}.json`);
    const temporary = resolve(this.stateDir, `.${record.keyHash}.${randomUUID()}.tmp`);
    const contents = Buffer.from(`${canonicalJson(admitted)}\n`, "utf8");
    let handle;
    try {
      handle = await open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      throw storeError("Failed to stage the durable A2A idempotency admission.", error);
    }
    try {
      await handle.writeFile(contents);
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw storeError("Failed to persist the durable A2A idempotency admission.", error);
    }
    let published = false;
    try {
      await this.hooks.beforeAdmissionPublish?.();
      await this.assertDirectories();
      try {
        // A hard link is the portable no-clobber publication primitive: the
        // canonical name appears atomically and already references the fully
        // written, fsynced inode. Concurrent publishers cannot replace it.
        await link(temporary, destination);
        published = true;
      } catch (error) {
        if (!isErrno(error, "EEXIST")) {
          throw error;
        }
        // Persist the shared winner's directory entry before allowing this
        // process to observe and fail closed on its active admission.
        await fsyncDirectory(this.stateDir, this.stateDirIdentity);
        await this.assertDirectories();
        return undefined;
      }
      await this.hooks.afterAdmissionPublish?.();
      await unlink(temporary);
      await fsyncDirectory(this.stateDir, this.stateDirIdentity);
      await this.verifySlot(slot, record.keyHash);
      await this.assertDirectories();
      return admitted;
    } catch (error) {
      if (published) {
        // The canonical record is complete and may already be observed. Never
        // remove it after publication: retaining it is the fail-closed result.
        throw storeError("Failed to finalize the durable A2A idempotency admission.", error);
      }
      throw storeError("Failed to publish the durable A2A idempotency admission.", error);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async assertDirectories(): Promise<void> {
    try {
      await assertPrivateDirectoryIdentity(this.stateDir, this.stateDirIdentity);
      await assertPrivateDirectoryIdentity(this.slotsDir, this.slotsDirIdentity);
      // Re-check the parent after walking through it to the slots directory so
      // a pathname replacement cannot splice two independently valid roots.
      await assertPrivateDirectoryIdentity(this.stateDir, this.stateDirIdentity);
    } catch (error) {
      throw storeError("A2A idempotency store directory identity changed; refusing filesystem access.", error);
    }
  }

  private async ensureManifest(): Promise<void> {
    await this.assertDirectories();
    const path = resolve(this.stateDir, STORE_MANIFEST_FILE);
    const expected = {
      schemaVersion: STORE_MANIFEST_SCHEMA_VERSION,
      maxRecords: this.maxRecords,
      providerScope: this.providerScope,
    } as const;
    let handle;
    try {
      handle = await open(
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.writeFile(`${canonicalJson(expected)}\n`);
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      await fsyncDirectory(this.stateDir, this.stateDirIdentity);
      await this.assertDirectories();
      return;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (!isErrno(error, "EEXIST")) {
        throw storeError("Failed to create the A2A idempotency store manifest.", error);
      }
    }
    let parsed: unknown;
    let lastReadError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        parsed = JSON.parse((await secureReadPrivateFile(path, /^manifest\.json$/u)).toString("utf8"));
        lastReadError = undefined;
        break;
      } catch (error) {
        lastReadError = error;
        await delayWithRef(10);
      }
    }
    if (lastReadError !== undefined) {
      throw storeError("A2A idempotency store manifest is malformed.", lastReadError);
    }
    if (
      !isRecord(parsed)
      || parsed.schemaVersion !== expected.schemaVersion
      || parsed.maxRecords !== expected.maxRecords
      || parsed.providerScope !== expected.providerScope
      || !hasOnlyKeys(parsed, ["maxRecords", "providerScope", "schemaVersion"])
    ) {
      throw storeError("A2A idempotency store manifest does not match namespace or maxRecords; migrate explicitly instead of reusing it.");
    }
    await this.assertDirectories();
  }

  private async allocateSlot(keyHash: string): Promise<number> {
    await this.assertDirectories();
    // Reservations are permanent and allocated by deterministic linear probe.
    // Therefore the same key is either encountered before the first free slot,
    // or the first free slot is its one canonical reservation. No global slot
    // scan is needed on each dispatch, even at large configured capacities.
    const start = Number(BigInt(`0x${keyHash.slice(0, 13)}`) % BigInt(this.maxRecords));
    for (let offset = 0; offset < this.maxRecords; offset += 1) {
      const slot = (start + offset) % this.maxRecords;
      const path = resolve(this.slotsDir, slotFileName(slot));
      let handle;
      try {
        handle = await open(
          path,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
          0o600,
        );
      } catch (error) {
        if (isErrno(error, "EEXIST")) {
          const reservation = await this.readSlot(slot);
          if (reservation.keyHash === keyHash) {
            // A concurrent same-key allocator may have made the fully written
            // reservation visible before syncing its directory entry. Persist
            // that entry in this process before the shared admission can run.
            await fsyncDirectory(this.slotsDir, this.slotsDirIdentity);
            await this.assertDirectories();
            return slot;
          }
          continue;
        }
        throw storeError("Failed to reserve A2A idempotency capacity.", error);
      }
      try {
        await handle.writeFile(`${canonicalJson({ schemaVersion: 1, slot, keyHash, createdAtMs: Date.now() })}\n`);
        await handle.chmod(0o600);
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        throw storeError("Failed to persist A2A idempotency capacity reservation.", error);
      }
      await handle.close();
      await fsyncDirectory(this.slotsDir, this.slotsDirIdentity);
      await this.assertDirectories();
      return slot;
    }
    throw protocolIdempotencyError(
      "idempotency_capacity_exhausted",
      "The provider's durable idempotency admission capacity is exhausted; no active or conflict tombstone was evicted.",
    );
  }

  private async verifySlot(slot: number, keyHash: string): Promise<void> {
    await this.assertDirectories();
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= this.maxRecords) {
      throw storeError("A2A idempotency record references an invalid capacity slot.");
    }
    const parsed = await this.readSlot(slot);
    if (parsed.keyHash !== keyHash) {
      throw storeError("A2A idempotency capacity reservation does not match its record.");
    }
    await this.assertDirectories();
  }

  private async readSlot(slot: number): Promise<{ readonly keyHash: string; readonly createdAtMs: number }> {
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= this.maxRecords) {
      throw storeError("A2A idempotency capacity reservation references an invalid slot.");
    }
    const path = resolve(this.slotsDir, slotFileName(slot));
    let parsed: unknown;
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        parsed = JSON.parse((await secureReadPrivateFile(path, SLOT_FILE_PATTERN)).toString("utf8"));
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await delayWithRef(10);
      }
    }
    if (lastError !== undefined) {
      throw storeError("A2A idempotency capacity reservation is missing or malformed.", lastError);
    }
    if (
      !isRecord(parsed)
      || parsed.schemaVersion !== 1
      || parsed.slot !== slot
      || typeof parsed.keyHash !== "string"
      || !SHA256_PATTERN.test(parsed.keyHash)
      || typeof parsed.createdAtMs !== "number"
      || !Number.isSafeInteger(parsed.createdAtMs)
      || parsed.createdAtMs < 0
      || !hasOnlyKeys(parsed, ["createdAtMs", "keyHash", "schemaVersion", "slot"])
    ) {
      throw storeError("A2A idempotency capacity reservation does not match its record.");
    }
    return { keyHash: parsed.keyHash, createdAtMs: parsed.createdAtMs };
  }

  private async compactExpiredRecord(record: CompletedRecord): Promise<TombstoneRecord> {
    const tombstone: TombstoneRecord = {
      schemaVersion: RECORD_SCHEMA_VERSION,
      keyHash: record.keyHash,
      fingerprint: record.fingerprint,
      status: "tombstone",
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
      tombstonedAtMs: Date.now(),
      slot: record.slot,
      ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
    };
    // Keys and slots are never reused. Concurrent compactors can only replace
    // the canonical record with the same semantic tombstone, so there is no
    // successor admission for an expiry race to move or unlink.
    await this.save(tombstone);
    return tombstone;
  }

  private async pruneExpiredTerminalRecords(): Promise<void> {
    await this.assertDirectories();
    const entries = await readdir(this.stateDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === STORE_MANIFEST_FILE || entry.name === SLOTS_DIRECTORY) {
        continue;
      }
      if (!entry.isFile() || !RECORD_FILE_PATTERN.test(entry.name)) {
        // Atomic-write remnants are retained for operator inspection; they do
        // not count as admissions because capacity is held by slot files.
        if (TEMPORARY_RECORD_FILE_PATTERN.test(entry.name)) {
          continue;
        }
        throw storeError(`Unexpected entry in A2A idempotency stateDir: ${entry.name}`);
      }
      const keyHash = entry.name.slice(0, -".json".length);
      let record: IdempotencyRecord;
      try {
        record = parseRecord(
          JSON.parse((await secureReadPublishedRecord(
            resolve(this.stateDir, entry.name),
            this.stateDir,
            keyHash,
            this.hooks,
          )).toString("utf8")),
          keyHash,
        );
      } catch (error) {
        throw storeError("A2A idempotency state is malformed during startup scan.", error);
      }
      await this.verifySlot(record.slot, keyHash);
      if (record.status === "completed" && isExpired(record, this.retentionMs)) {
        await this.compactExpiredRecord(record);
      }
    }
    await this.assertDirectories();
  }

  private async reconcileOrphanSlots(): Promise<void> {
    await this.assertDirectories();
    const entries = await readdir(this.slotsDir, { withFileTypes: true });
    const slotsByKey = new Map<string, number>();
    for (const entry of entries) {
      const match = SLOT_FILE_PATTERN.exec(entry.name);
      if (!entry.isFile() || match === null) {
        if (/^\.slot-[0-9]{1,7}\.json\.[a-f0-9-]+\.released$/u.test(entry.name)) {
          continue;
        }
        throw storeError(`Unexpected entry in A2A idempotency slots directory: ${entry.name}`);
      }
      const slot = Number(match[1]);
      const parsed = await this.readSlot(slot);
      const priorSlot = slotsByKey.get(parsed.keyHash);
      if (priorSlot !== undefined && priorSlot !== slot) {
        throw storeError("A2A idempotency key has multiple capacity reservations; migrate explicitly instead of guessing which admission owns the key.");
      }
      slotsByKey.set(parsed.keyHash, slot);
    }
    for (const [keyHash, slot] of slotsByKey) {
      const record = await this.load(keyHash);
      if (record !== undefined && record.slot !== slot) {
        throw storeError("A2A idempotency capacity reservation does not match its record.");
      }
    }
    await this.assertDirectories();
  }
}

function readEnvelope(value: unknown): IdempotencyEnvelope | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw protocolIdempotencyError("invalid_idempotency_key", "The A2A idempotency metadata envelope must be an object.");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2
    || keys[0] !== "key"
    || keys[1] !== "schemaVersion"
    || value.schemaVersion !== A2A_IDEMPOTENCY_SCHEMA_VERSION
    || typeof value.key !== "string"
  ) {
    throw protocolIdempotencyError("invalid_idempotency_key", "The A2A idempotency metadata envelope is invalid.");
  }
  try {
    return a2aIdempotencyEnvelope(value.key);
  } catch {
    throw protocolIdempotencyError("invalid_idempotency_key", "The A2A idempotency key format is invalid.");
  }
}

function rejectUnsupportedIdempotencyEnvelope(params: SendMessageRequest): void {
  const envelope = readEnvelope(params.metadata?.[A2A_IDEMPOTENCY_METADATA_KEY]);
  if (envelope === undefined) {
    return;
  }
  throw protocolIdempotencyError(
    "idempotency_unsupported",
    "This A2A provider is not configured with durable logical-dispatch idempotency; refusing to ignore the reserved envelope.",
  );
}

function requestFingerprint(params: SendMessageRequest, tenant: string, providerScope: string): string {
  const message = params.message;
  const requestMetadata = { ...(params.metadata ?? {}) };
  delete requestMetadata[A2A_IDEMPOTENCY_METADATA_KEY];
  return sha256(canonicalJson({
    providerScope,
    tenant,
    message: message === undefined
      ? undefined
      : {
          contextId: message.contextId,
          taskId: message.taskId,
          role: message.role,
          parts: message.parts,
          metadata: message.metadata,
          extensions: message.extensions,
          referenceTaskIds: message.referenceTaskIds,
        },
    configuration: executionConfiguration(params.configuration),
    metadata: requestMetadata,
  }));
}

function withoutIdempotencyEnvelope(params: SendMessageRequest): SendMessageRequest {
  const metadata = { ...(params.metadata ?? {}) };
  delete metadata[A2A_IDEMPOTENCY_METADATA_KEY];
  return {
    ...params,
    metadata,
  };
}

function asImmediateExecutionRequest(params: SendMessageRequest): SendMessageRequest {
  const stripped = withoutIdempotencyEnvelope(params);
  return {
    ...stripped,
    configuration: {
      acceptedOutputModes: stripped.configuration?.acceptedOutputModes ?? ["text/plain"],
      taskPushNotificationConfig: stripped.configuration?.taskPushNotificationConfig,
      historyLength: undefined,
      returnImmediately: true,
    },
  };
}

function executionConfiguration(configuration: SendMessageRequest["configuration"]): unknown {
  return {
    acceptedOutputModes: configuration?.acceptedOutputModes ?? ["text/plain"],
    taskPushNotificationConfig: configuration?.taskPushNotificationConfig,
  };
}

async function projectRuntimeResult(
  runtime: RuntimeRequest,
  configuration: SendMessageRequest["configuration"],
): Promise<SendMessageResult> {
  const result = configuration?.returnImmediately === true
    ? await runtime.accepted
    : await runtime.terminal;
  return projectHistory(result, configuration?.historyLength);
}

function projectHistory(result: SendMessageResult, historyLength: number | undefined): SendMessageResult {
  const cloned = cloneResult(result);
  if (!("status" in cloned) || historyLength === undefined) {
    return cloned;
  }
  cloned.history = historyLength <= 0
    ? []
    : cloned.history.slice(-historyLength);
  return cloned;
}

function assertSameFingerprint(expected: string, actual: string): void {
  if (expected === actual) {
    return;
  }
  throw protocolIdempotencyError(
    "idempotency_conflict",
    "The A2A idempotency key is already bound to a different canonical request.",
  );
}

function protocolIdempotencyError(
  code: "idempotency_capacity_exhausted" | "idempotency_conflict" | "idempotency_in_doubt" | "idempotency_result_expired" | "idempotency_unsupported" | "invalid_idempotency_key",
  message: string,
): RequestMalformedError {
  return new RequestMalformedError(`${ERROR_MARKER} ${code} ${message}`);
}

function normalizeRetentionMs(value: number | undefined): number {
  const retentionMs = value ?? DEFAULT_RETENTION_MS;
  if (!Number.isSafeInteger(retentionMs) || retentionMs < MIN_RETENTION_MS || retentionMs > MAX_RETENTION_MS) {
    throw new A2AProviderError(
      "invalid_config",
      `A2A idempotency retentionMs must be an integer from ${MIN_RETENTION_MS} to ${MAX_RETENTION_MS}.`,
      { field: "idempotency.retentionMs" },
    );
  }
  return retentionMs;
}

function normalizeMaxRecords(value: number | undefined): number {
  const maxRecords = value ?? DEFAULT_MAX_RECORDS;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS_LIMIT) {
    throw new A2AProviderError(
      "invalid_config",
      `A2A idempotency maxRecords must be an integer from 1 to ${MAX_RECORDS_LIMIT}.`,
      { field: "idempotency.maxRecords" },
    );
  }
  return maxRecords;
}

function idempotencyNamespaceHash(value: string): string {
  const namespace = typeof value === "string" ? value.trim() : "";
  if (namespace.length === 0 || Buffer.byteLength(namespace, "utf8") > 512) {
    throw new A2AProviderError(
      "invalid_config",
      "A2A idempotency namespace must be non-empty and at most 512 UTF-8 bytes.",
      { field: "idempotency.namespace" },
    );
  }
  return sha256(namespace);
}

function isExpired(record: CompletedRecord, retentionMs: number): boolean {
  return Date.now() - record.updatedAtMs > retentionMs;
}

function taskIdFromResult(result: SendMessageResult): string | undefined {
  const id = "status" in result ? result.id : result.taskId;
  return id.trim().length === 0 ? undefined : id;
}

function isNonTerminalTask(result: SendMessageResult): result is Task {
  return "status" in result && !isTerminalState(result.status?.state);
}

function isTerminalState(state: TaskState | undefined): boolean {
  return state === TaskState.TASK_STATE_COMPLETED
    || state === TaskState.TASK_STATE_FAILED
    || state === TaskState.TASK_STATE_CANCELED
    || state === TaskState.TASK_STATE_REJECTED
    || state === TaskState.TASK_STATE_INPUT_REQUIRED
    || state === TaskState.TASK_STATE_AUTH_REQUIRED;
}

function cloneResult<T extends SendMessageResult>(value: T): T {
  return revivePersistedResult(value) as T;
}

function parseRecord(value: unknown, expectedKeyHash: string): IdempotencyRecord {
  if (!isRecord(value)) {
    throw new Error("record must be an object");
  }
  const schemaVersion = value.schemaVersion;
  const keyHash = value.keyHash;
  const fingerprint = value.fingerprint;
  const status = value.status;
  const createdAtMs = value.createdAtMs;
  const updatedAtMs = value.updatedAtMs;
  const slot = value.slot;
  if (
    schemaVersion !== RECORD_SCHEMA_VERSION
    || keyHash !== expectedKeyHash
    || typeof keyHash !== "string"
    || !SHA256_PATTERN.test(keyHash)
    || typeof fingerprint !== "string"
    || !SHA256_PATTERN.test(fingerprint)
    || (status !== "active" && status !== "completed" && status !== "tombstone")
    || typeof createdAtMs !== "number"
    || !Number.isSafeInteger(createdAtMs)
    || createdAtMs < 0
    || typeof updatedAtMs !== "number"
    || !Number.isSafeInteger(updatedAtMs)
    || updatedAtMs < 0
    || typeof slot !== "number"
    || !Number.isSafeInteger(slot)
    || slot < 0
    || (value.taskId !== undefined && (typeof value.taskId !== "string" || value.taskId.length === 0))
  ) {
    throw new Error("record fields are invalid");
  }
  if (status === "tombstone") {
    if (
      !hasOnlyKeys(value, [
        "createdAtMs", "fingerprint", "keyHash", "schemaVersion", "slot", "status",
        "taskId", "tombstonedAtMs", "updatedAtMs",
      ])
      || typeof value.tombstonedAtMs !== "number"
      || !Number.isSafeInteger(value.tombstonedAtMs)
      || value.tombstonedAtMs < 0
    ) {
      throw new Error("tombstone record is invalid");
    }
    return {
      schemaVersion,
      keyHash,
      fingerprint,
      status,
      createdAtMs,
      updatedAtMs,
      tombstonedAtMs: value.tombstonedAtMs,
      slot,
      ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
    };
  }
  if (status === "completed") {
    if (
      !hasOnlyKeys(value, [
        "createdAtMs", "fingerprint", "keyHash", "result", "schemaVersion",
        "slot", "status", "taskId", "updatedAtMs",
      ])
      || !isSendMessageResult(value.result)
      || !isTerminalPersistedResult(value.result)
      || !recordTaskIdMatchesResult(value.taskId, value.result)
    ) {
      throw new Error("completed record result is invalid");
    }
    return {
      schemaVersion,
      keyHash,
      fingerprint,
      status,
      createdAtMs,
      updatedAtMs,
      slot,
      ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
      result: revivePersistedResult(value.result),
    };
  }
  if (
    !hasOnlyKeys(value, [
      "acceptedResult", "createdAtMs", "fingerprint", "keyHash", "schemaVersion",
      "slot", "status", "taskId", "updatedAtMs",
    ])
    || (value.acceptedResult !== undefined && !isNonTerminalPersistedTask(value.acceptedResult))
    || ((value.taskId === undefined) !== (value.acceptedResult === undefined))
    || (value.acceptedResult !== undefined && !recordTaskIdMatchesResult(value.taskId, value.acceptedResult))
  ) {
    throw new Error("active record acceptedResult is invalid");
  }
  return {
    schemaVersion,
    keyHash,
    fingerprint,
    status,
    createdAtMs,
    updatedAtMs,
    slot,
    ...(value.taskId === undefined ? {} : { taskId: value.taskId }),
    ...(value.acceptedResult === undefined
      ? {}
      : { acceptedResult: revivePersistedResult(value.acceptedResult) }),
  };
}

function isSendMessageResult(value: unknown): value is SendMessageResult {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.messageId === "string"
    ? isPersistedMessage(value)
    : isPersistedTask(value);
}

function isTerminalPersistedResult(value: SendMessageResult): boolean {
  return !("status" in value) || isTerminalState(value.status?.state);
}

function isNonTerminalPersistedTask(value: unknown): value is Task {
  if (!isRecord(value) || !isPersistedTask(value)) {
    return false;
  }
  return !isTerminalState((value as unknown as Task).status?.state);
}

function recordTaskIdMatchesResult(
  recordTaskId: unknown,
  result: SendMessageResult,
): boolean {
  const resultTaskId = "status" in result ? result.id : result.taskId;
  const normalizedResultTaskId = resultTaskId.length === 0 ? undefined : resultTaskId;
  return recordTaskId === normalizedResultTaskId;
}

function isPersistedTask(value: Record<string, unknown>): boolean {
  return hasOnlyKeys(value, ["artifacts", "contextId", "history", "id", "metadata", "status"])
    && typeof value.id === "string"
    && value.id.length > 0
    && typeof value.contextId === "string"
    && Array.isArray(value.artifacts)
    && value.artifacts.every(isPersistedArtifact)
    && Array.isArray(value.history)
    && value.history.every((message) => isRecord(message) && isPersistedMessage(message))
    && (value.metadata === undefined || isRecord(value.metadata))
    && isPersistedStatus(value.status);
}

function isPersistedStatus(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ["message", "state", "timestamp"])
    && typeof value.state === "number"
    && Number.isInteger(value.state)
    && value.state >= 0
    && value.state <= 8
    && (value.message === undefined || (isRecord(value.message) && isPersistedMessage(value.message)))
    && (value.timestamp === undefined || typeof value.timestamp === "string");
}

function isPersistedMessage(value: Record<string, unknown>): boolean {
  return hasOnlyKeys(value, [
    "contextId",
    "extensions",
    "messageId",
    "metadata",
    "parts",
    "referenceTaskIds",
    "role",
    "taskId",
  ])
    && typeof value.messageId === "string"
    && value.messageId.length > 0
    && typeof value.contextId === "string"
    && typeof value.taskId === "string"
    && (value.role === 1 || value.role === 2)
    && Array.isArray(value.parts)
    && value.parts.every(isPersistedPart)
    && (value.metadata === undefined || isRecord(value.metadata))
    && isStringArray(value.extensions)
    && isStringArray(value.referenceTaskIds);
}

function isPersistedPart(value: unknown): boolean {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ["content", "filename", "mediaType", "metadata"])
    || typeof value.filename !== "string"
    || typeof value.mediaType !== "string"
    || (value.metadata !== undefined && !isRecord(value.metadata))
  ) {
    return false;
  }
  if (value.content === undefined) {
    return true;
  }
  if (!isRecord(value.content) || !hasOnlyKeys(value.content, ["$case", "value"])) {
    return false;
  }
  if (value.content.$case === "text" || value.content.$case === "url") {
    return typeof value.content.value === "string";
  }
  if (value.content.$case === "raw") {
    return typeof value.content.value === "string" && isCanonicalBase64(value.content.value);
  }
  return value.content.$case === "data"
    && (value.content.value === undefined || isJsonValue(value.content.value));
}

function isPersistedArtifact(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ["artifactId", "description", "extensions", "metadata", "name", "parts"])
    && typeof value.artifactId === "string"
    && value.artifactId.length > 0
    && typeof value.name === "string"
    && typeof value.description === "string"
    && Array.isArray(value.parts)
    && value.parts.every(isPersistedPart)
    && (value.metadata === undefined || isRecord(value.metadata))
    && isStringArray(value.extensions);
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isCanonicalBase64(value: string): boolean {
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

function revivePersistedResult(value: unknown): SendMessageResult {
  const result = structuredClone(value) as SendMessageResult;
  if ("status" in result) {
    for (const artifact of result.artifacts) {
      revivePersistedParts(artifact.parts);
    }
    for (const message of result.history) {
      revivePersistedParts(message.parts);
    }
    if (result.status?.message !== undefined) {
      revivePersistedParts(result.status.message.parts);
    }
  } else {
    revivePersistedParts(result.parts);
  }
  return result;
}

function revivePersistedParts(parts: Part[]): void {
  for (const part of parts) {
    const content = part.content as { $case: "raw"; value: Buffer | Uint8Array | string } | undefined;
    if (content?.$case !== "raw") {
      continue;
    }
    if (typeof content.value === "string") {
      content.value = Buffer.from(content.value, "base64");
    } else if (!Buffer.isBuffer(content.value)) {
      // Node's structuredClone preserves the bytes but returns Uint8Array,
      // while the A2A SDK contract requires raw Part values to remain Buffer.
      content.value = Buffer.from(content.value);
    }
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function slotFileName(slot: number): string {
  return `slot-${slot}.json`;
}

async function ensurePrivateStateDir(path: string): Promise<PrivateDirectory> {
  const absolute = resolve(path);
  try {
    const canonical = await realpath(absolute);
    const identity = await inspectPrivateDirectory(absolute, canonical);
    await fsyncDirectory(canonical, identity);
    return { path: canonical, identity };
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error instanceof A2AProviderError
        ? error
        : storeError("A2A idempotency stateDir must be an owner-only 0700 real directory.", error);
    }
  }

  const missing: string[] = [];
  let existing = absolute;
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw storeError("Failed to inspect the A2A idempotency directory chain.", error);
      }
      const parent = dirname(existing);
      if (parent === existing) {
        throw storeError("A2A idempotency stateDir has no existing directory ancestor.");
      }
      missing.unshift(basename(existing));
      existing = parent;
    }
  }

  let current: string;
  try {
    current = await realpath(existing);
    await inspectDirectory(current);
  } catch (error) {
    throw storeError("A2A idempotency stateDir ancestor must resolve to a real directory.", error);
  }

  for (const name of missing) {
    const parentIdentity = await inspectDirectory(current);
    const next = resolve(current, name);
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw storeError("Failed to create the A2A idempotency directory chain.", error);
      }
    }
    let nextIdentity: DirectoryIdentity;
    try {
      nextIdentity = await inspectPrivateDirectory(next, next);
      // Persist both the new directory contents/inode and the directory entry
      // that links it from its parent before creating the next component.
      await fsyncDirectory(next, nextIdentity);
      await fsyncDirectory(current, parentIdentity);
      await assertDirectoryIdentity(current, parentIdentity);
    } catch (error) {
      throw storeError("A2A idempotency directory creation was replaced or is not owner-only.", error);
    }
    current = next;
  }

  const identity = await inspectPrivateDirectory(current, current);
  await fsyncDirectory(current, identity);
  return { path: current, identity };
}

async function inspectPrivateDirectory(path: string, canonicalPath: string): Promise<DirectoryIdentity> {
  const identity = await inspectDirectory(path);
  const canonicalIdentity = path === canonicalPath
    ? identity
    : await inspectDirectory(canonicalPath);
  const details = await lstat(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    details.isSymbolicLink()
    || identity.dev !== canonicalIdentity.dev
    || identity.ino !== canonicalIdentity.ino
    || (details.mode & 0o777) !== 0o700
    || (uid !== undefined && details.uid !== uid)
  ) {
    throw storeError("A2A idempotency stateDir must be an owner-only 0700 real directory.");
  }
  return identity;
}

async function inspectDirectory(path: string): Promise<DirectoryIdentity> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    const named = await lstat(path);
    if (
      !opened.isDirectory()
      || !named.isDirectory()
      || named.isSymbolicLink()
      || opened.dev !== named.dev
      || opened.ino !== named.ino
    ) {
      throw new Error("directory identity is unsafe");
    }
    return { dev: opened.dev, ino: opened.ino };
  } finally {
    await handle.close();
  }
}

async function assertPrivateDirectoryIdentity(path: string, expected: DirectoryIdentity): Promise<void> {
  const actual = await inspectPrivateDirectory(path, path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error("directory identity changed");
  }
}

async function assertDirectoryIdentity(path: string, expected: DirectoryIdentity): Promise<void> {
  const actual = await inspectDirectory(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error("directory identity changed");
  }
}

async function secureReadPrivateFile(path: string, allowedName: RegExp): Promise<Buffer> {
  allowedName.lastIndex = 0;
  if (!allowedName.test(basename(path))) {
    throw new Error("invalid record path");
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const details = await handle.stat();
    const pathDetails = await stat(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !details.isFile()
      || details.nlink !== 1
      || (details.mode & 0o777) !== 0o600
      || details.dev !== pathDetails.dev
      || details.ino !== pathDetails.ino
      || details.size > MAX_RECORD_BYTES
      || (uid !== undefined && details.uid !== uid)
    ) {
      throw new Error("record identity or permissions are unsafe");
    }
    return await readFile(handle);
  } finally {
    await handle.close();
  }
}

class RecordPathChangedError extends Error {
  constructor() {
    super("A2A idempotency record pathname changed during a secure read.");
    this.name = "RecordPathChangedError";
  }
}

class RecordNotFoundError extends Error {
  constructor() {
    super("A2A idempotency record does not exist.");
    this.name = "RecordNotFoundError";
  }
}

async function secureReadPublishedRecord(
  path: string,
  stateDir: string,
  keyHash: string,
  hooks: FileIdempotencyStoreHooks = {},
): Promise<Buffer> {
  assertKeyHash(keyHash);
  if (basename(path) !== `${keyHash}.json`) {
    throw new Error("invalid record path");
  }
  let observedCanonical = false;
  let lastPathChange: RecordPathChangedError | undefined;
  for (let attempt = 1; attempt <= MAX_RECORD_READ_ATTEMPTS; attempt += 1) {
    let handle;
    try {
      handle = await open(
        path,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
      );
      observedCanonical = true;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw error;
      }
      if (!observedCanonical) {
        throw new RecordNotFoundError();
      }
      lastPathChange = new RecordPathChangedError();
      continue;
    }
    try {
      await hooks.afterRecordOpen?.({ keyHash, attempt });
      let details = await handle.stat();
      await assertCurrentRecordPath(path, details);
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      assertSafeOpenedRecord(details, uid);
      let validatedTemporaryLink = false;
      if (details.nlink !== 1) {
        if (details.nlink !== 2) {
          throw new Error("record identity or permissions are unsafe");
        }
        const expectedPrefix = `.${keyHash}.`;
        let matchingTemporaryLinks = 0;
        for (const entry of await readdir(stateDir, { withFileTypes: true })) {
          if (
            !entry.name.startsWith(expectedPrefix)
            || !TEMPORARY_RECORD_FILE_PATTERN.test(entry.name)
          ) {
            continue;
          }
          let candidate: Stats;
          try {
            candidate = await lstat(resolve(stateDir, entry.name));
          } catch (error) {
            if (isErrno(error, "ENOENT")) {
              continue;
            }
            throw error;
          }
          if (
            candidate.isFile()
            && !candidate.isSymbolicLink()
            && candidate.dev === details.dev
            && candidate.ino === details.ino
            && (candidate.mode & 0o777) === 0o600
            && (uid === undefined || candidate.uid === uid)
          ) {
            matchingTemporaryLinks += 1;
          }
        }
        // The publisher may unlink its staging name while the directory is
        // scanned. Re-read the opened inode before deciding whether its second
        // link is the one expected from atomic publication.
        details = await handle.stat();
        assertSafeOpenedRecord(details, uid);
        if (details.nlink !== 1 && (details.nlink !== 2 || matchingTemporaryLinks !== 1)) {
          throw new Error("record identity or permissions are unsafe");
        }
        validatedTemporaryLink = details.nlink === 2;
      }
      await assertCurrentRecordPath(path, details);
      const raw = await readFile(handle);
      const finalDetails = await handle.stat();
      assertSafeOpenedRecord(finalDetails, uid);
      if (
        finalDetails.dev !== details.dev
        || finalDetails.ino !== details.ino
        || finalDetails.size !== raw.byteLength
        || (finalDetails.nlink !== 1 && !(validatedTemporaryLink && finalDetails.nlink === 2))
      ) {
        throw new Error("record identity or permissions are unsafe");
      }
      await assertCurrentRecordPath(path, finalDetails);
      return raw;
    } catch (error) {
      if (!(error instanceof RecordPathChangedError)) {
        throw error;
      }
      lastPathChange = error;
    } finally {
      await handle.close();
    }
  }
  throw lastPathChange ?? new RecordPathChangedError();
}

function assertSafeOpenedRecord(details: Stats, uid: number | undefined): void {
  if (
    !details.isFile()
    || (details.mode & 0o777) !== 0o600
    || details.size > MAX_RECORD_BYTES
    || (uid !== undefined && details.uid !== uid)
  ) {
    throw new Error("record identity or permissions are unsafe");
  }
}

async function assertCurrentRecordPath(path: string, opened: Stats): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new RecordPathChangedError();
    }
    throw error;
  }
  if (!current.isFile() || current.isSymbolicLink()) {
    throw new Error("record identity or permissions are unsafe");
  }
  if (current.dev !== opened.dev || current.ino !== opened.ino) {
    throw new RecordPathChangedError();
  }
}

async function assertReplaceableRecord(path: string): Promise<void> {
  try {
    const details = await lstat(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !details.isFile()
      || details.isSymbolicLink()
      || details.nlink !== 1
      || (details.mode & 0o777) !== 0o600
      || (uid !== undefined && details.uid !== uid)
    ) {
      throw new Error("existing record is unsafe");
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
}

async function fsyncDirectory(path: string, expected?: DirectoryIdentity): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    if (expected !== undefined) {
      const details = await handle.stat();
      if (
        !details.isDirectory()
        || details.dev !== expected.dev
        || details.ino !== expected.ino
      ) {
        throw new Error("directory identity changed before fsync");
      }
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertKeyHash(keyHash: string): void {
  if (!SHA256_PATTERN.test(keyHash)) {
    throw storeError("A2A idempotency record key hash is invalid.");
  }
}

function storeError(message: string, cause?: unknown): A2AProviderError {
  return new A2AProviderError(
    "idempotency_store_error",
    message,
    cause === undefined
      ? {}
      : { reason: cause instanceof Error ? cause.message : String(cause) },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function unrefDelay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref();
  });
}

function delayWithRef(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}
