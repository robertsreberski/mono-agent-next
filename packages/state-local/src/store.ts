import { join } from "node:path";

import type { ModuleHealth, ModuleStopContext } from "@mono-agent/module-sdk";
import type {
  StateDeleteRequest,
  StateCompareAndSwapRequest,
  StateCompareAndSwapResult,
  StateListRequest,
  StateListResult,
  StateReadRequest,
  StateRecord,
  StatePresenceListRequest,
  StatePresenceRecord,
  StatePresenceRemoveRequest,
  StatePresenceUpsertRequest,
  StateHostPresenceRequest,
  StateStore,
  StateWriteRequest,
  StateWriteResult,
} from "@mono-agent/module-sdk/internal";

import type { ResolvedStateLocalConfig } from "./config.js";
import { StateLocalError, throwIfAborted } from "./errors.js";
import {
  PresencePublisher,
  type StatePresenceDescriptor,
  type StatePresenceUpdate,
} from "./presence.js";
import {
  acquireProcessLease,
  createSecureFile,
  ensureSecureDirectory,
  inspectSecureFile,
  readSecureFile,
  replaceSecureFileAtomic,
  type AtomicReplaceHooks,
  type FileIdentity,
  type LeaseHooks,
  type ProcessLease,
  verifySecureDirectoryIdentity,
  verifySecureFileIdentity,
} from "./secure-fs.js";
import {
  emptySnapshot,
  decodePresenceRecord,
  encodePresenceRecord,
  INTERNAL_PRESENCE_PREFIX,
  isInternalStateKey,
  nextListGeneration,
  nextVersion,
  normalizePresenceRecord,
  parseSnapshot,
  serializeSnapshot,
  toStateRecord,
  type StateSnapshot,
  type StoredRecord,
  validateExpectedVersion,
  presenceStorageKey,
  validateStateKey,
  validateStatePrefix,
} from "./snapshot.js";

const SNAPSHOT_FILE = "records.json";
const MARKER_FILE = ".mono-agent-state";
const LEASE_FILE = "lease.sqlite";
const MARKER_CONTENT = '{"kind":"mono-agent-state-local","schemaVersion":1}\n';

export interface StateLocalStoreHooks {
  readonly lease?: LeaseHooks;
  readonly snapshot?: AtomicReplaceHooks;
  readonly presence?: AtomicReplaceHooks;
}

export interface StateLocalStoreOpenOptions {
  readonly instanceId: string;
  readonly signal: AbortSignal;
  readonly clock?: () => Date;
  readonly hooks?: StateLocalStoreHooks;
}

export class StateLocalStore implements StateStore {
  readonly root: string;
  readonly snapshotPath: string;
  private readonly config: ResolvedStateLocalConfig;
  private readonly rootIdentity: FileIdentity;
  private readonly lease: ProcessLease;
  private readonly clock: () => Date;
  private readonly snapshotHooks: AtomicReplaceHooks | undefined;
  private readonly presence: PresencePublisher | undefined;
  private snapshot: StateSnapshot;
  private snapshotIdentity: FileIdentity;
  private operation: Promise<void> = Promise.resolve();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private presenceUpdate: StatePresenceUpdate = { status: "ready" };
  private started = false;
  private closing = false;
  private closed = false;
  private poisoned: StateLocalError | undefined;

  private constructor(
    config: ResolvedStateLocalConfig,
    rootIdentity: FileIdentity,
    lease: ProcessLease,
    snapshot: StateSnapshot,
    snapshotIdentity: FileIdentity,
    options: StateLocalStoreOpenOptions,
  ) {
    this.root = config.root;
    this.snapshotPath = join(config.root, SNAPSHOT_FILE);
    this.config = config;
    this.rootIdentity = rootIdentity;
    this.lease = lease;
    this.snapshot = snapshot;
    this.snapshotIdentity = snapshotIdentity;
    this.clock = options.clock ?? (() => new Date());
    this.snapshotHooks = options.hooks?.snapshot;
    const discovery = config.discovery;
    this.presence = discovery === undefined
      ? undefined
      : new PresencePublisher({
          config: discovery,
          instanceId: options.instanceId,
          stateRoot: config.root,
          startedAt: canonicalNow(this.clock),
          clock: this.clock,
          ...(options.hooks?.presence === undefined ? {} : { hooks: options.hooks.presence }),
        });
  }

  static async open(
    config: ResolvedStateLocalConfig,
    options: StateLocalStoreOpenOptions,
  ): Promise<StateLocalStore> {
    throwIfAborted(options.signal);
    const secureRoot = await ensureSecureDirectory(config.root);
    const effectiveConfig: ResolvedStateLocalConfig = { ...config, root: secureRoot.path };
    const rootIdentity = secureRoot.identity;
    const lease = await acquireProcessLease(join(effectiveConfig.root, LEASE_FILE), options.hooks?.lease);
    try {
      throwIfAborted(options.signal);
      await prepareMarker(effectiveConfig.root);
      const snapshotPath = join(effectiveConfig.root, SNAPSHOT_FILE);
      let snapshotIdentity = await inspectSecureFile(snapshotPath);
      let snapshot: StateSnapshot;
      if (snapshotIdentity === undefined) {
        snapshot = emptySnapshot();
        snapshotIdentity = await replaceSecureFileAtomic(
          snapshotPath,
          serializeSnapshot(snapshot),
        );
      } else {
        const maximumSnapshotBytes = Math.min(
          2_147_483_647,
          effectiveConfig.maxTotalBytes * 2 + effectiveConfig.maxRecords * 256 + 4_096,
        );
        const loaded = await readSecureFile(snapshotPath, maximumSnapshotBytes);
        snapshotIdentity = loaded.identity;
        snapshot = parseSnapshot(loaded.bytes, effectiveConfig);
      }
      throwIfAborted(options.signal);
      return new StateLocalStore(
        effectiveConfig,
        rootIdentity,
        lease,
        snapshot,
        snapshotIdentity,
        options,
      );
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  async start(context: { readonly signal: AbortSignal }): Promise<void> {
    await this.runExclusive(context.signal, async () => {
      if (this.started) return;
      await this.guardPaths();
      if (this.presence !== undefined) {
        await this.presence.prepare();
        await this.presence.publish({ status: "starting" }, context.signal);
        this.presenceUpdate = { status: "ready" };
        await this.presence.publish(this.presenceUpdate, context.signal);
        this.heartbeat = setInterval(() => {
          void this.refreshPresence();
        }, this.config.discovery?.heartbeatMs);
        this.heartbeat.unref();
      }
      this.started = true;
    });
  }

  read(request: StateReadRequest): Promise<StateRecord | undefined> {
    return this.runExclusive(request.signal, async () => {
      await this.guardPaths();
      const key = validateStateKey(request.key);
      const found = this.snapshot.records.get(key);
      return found === undefined ? undefined : toStateRecord(found);
    });
  }

  write(request: StateWriteRequest): Promise<StateWriteResult> {
    return this.runExclusive(request.signal, async () => {
      await this.guardPaths();
      const key = validateStateKey(request.key);
      const expectedVersion = validateExpectedVersion(request.expectedVersion);
      const value = Buffer.from(request.value);
      if (value.byteLength > this.config.maxRecordBytes) {
        throw new StateLocalError(
          "STATE_LIMIT_EXCEEDED",
          `State record ${key} exceeds maxRecordBytes.`,
        );
      }
      const existing = this.snapshot.records.get(key);
      assertExpectedVersion(key, existing, expectedVersion);
      if (existing === undefined && this.snapshot.records.size >= this.config.maxRecords) {
        throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Local state has reached maxRecords.");
      }
      const totalBytes = this.snapshot.totalBytes - (existing?.value.byteLength ?? 0) + value.byteLength;
      if (totalBytes > this.config.maxTotalBytes) {
        throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Local state has reached maxTotalBytes.");
      }
      const next = nextVersion(this.snapshot);
      const updatedAt = canonicalNow(this.clock);
      const records = new Map(this.snapshot.records);
      records.set(key, { key, value, version: next.version, updatedAt });
      const draft: StateSnapshot = {
        generation: next.generation,
        listGeneration: nextListGeneration(this.snapshot),
        records,
        totalBytes,
      };
      await this.commit(draft);
      return { version: next.version, updatedAt };
    });
  }

  delete(request: StateDeleteRequest): Promise<boolean> {
    return this.runExclusive(request.signal, async () => {
      await this.guardPaths();
      const key = validateStateKey(request.key);
      const expectedVersion = validateExpectedVersion(request.expectedVersion);
      const existing = this.snapshot.records.get(key);
      assertExpectedVersion(key, existing, expectedVersion);
      if (existing === undefined) return false;
      const next = nextVersion(this.snapshot);
      const records = new Map(this.snapshot.records);
      records.delete(key);
      await this.commit({
        generation: next.generation,
        listGeneration: nextListGeneration(this.snapshot),
        records,
        totalBytes: this.snapshot.totalBytes - existing.value.byteLength,
      });
      return true;
    });
  }

  list(request: StateListRequest): Promise<StateListResult> {
    return this.runExclusive(request.signal, async () => {
      await this.guardPaths();
      const prefix = validateStatePrefix(request.prefix);
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) {
        throw new StateLocalError("STATE_LIMIT_EXCEEDED", "State list limit must be from 1 through 1000.");
      }
      const afterKey = decodeCursor(request.cursor, prefix, this.snapshot.listGeneration);
      const matching = [...this.snapshot.records.values()]
        .filter((record) =>
          !isInternalStateKey(record.key) &&
          record.key.startsWith(prefix) &&
          (afterKey === undefined || record.key > afterKey))
        .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
      const selected = matching.slice(0, request.limit);
      const cursor = matching.length > selected.length
        ? encodeCursor(prefix, selected[selected.length - 1]?.key, this.snapshot.listGeneration)
        : undefined;
      return {
        records: selected.map(toStateRecord),
        ...(cursor === undefined ? {} : { cursor }),
      };
    });
  }

  compareAndSwap(request: StateCompareAndSwapRequest): Promise<StateCompareAndSwapResult> {
    return this.runExclusive(request.signal, async () => {
      await this.guardPaths();
      const key = validateStateKey(request.key);
      const value = Buffer.from(request.value);
      if (value.byteLength > this.config.maxRecordBytes) {
        throw new StateLocalError("STATE_LIMIT_EXCEEDED", `State record ${key} exceeds maxRecordBytes.`);
      }
      const existing = this.snapshot.records.get(key);
      const expected = request.expectedVersion === null
        ? null
        : validateExpectedVersion(request.expectedVersion);
      const conflict = expected === null
        ? existing !== undefined
        : existing?.version !== expected;
      if (conflict) {
        return {
          status: "conflict" as const,
          ...(existing === undefined ? {} : { currentVersion: existing.version }),
        };
      }
      if (existing === undefined && this.snapshot.records.size >= this.config.maxRecords) {
        throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Local state has reached maxRecords.");
      }
      const totalBytes = this.snapshot.totalBytes - (existing?.value.byteLength ?? 0) + value.byteLength;
      if (totalBytes > this.config.maxTotalBytes) {
        throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Local state has reached maxTotalBytes.");
      }
      const next = nextVersion(this.snapshot);
      const updatedAt = canonicalNow(this.clock);
      const stored: StoredRecord = { key, value, version: next.version, updatedAt };
      const records = new Map(this.snapshot.records);
      records.set(key, stored);
      await this.commit({
        generation: next.generation,
        listGeneration: nextListGeneration(this.snapshot),
        records,
        totalBytes,
      });
      return { status: "applied", record: toStateRecord(stored) };
    });
  }

  upsertPresence(request: StatePresenceUpsertRequest): Promise<StatePresenceRecord> {
    return this.runExclusive(request.signal, async () => {
      await this.guardPaths();
      const presence = normalizePresenceRecord(request.presence);
      const key = presenceStorageKey(presence.presenceId);
      const value = encodePresenceRecord(presence);
      if (value.byteLength > this.config.maxRecordBytes) {
        throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Presence record exceeds maxRecordBytes.");
      }
      const existing = this.snapshot.records.get(key);
      if (existing === undefined && this.snapshot.records.size >= this.config.maxRecords) {
        throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Local state has reached maxRecords.");
      }
      const totalBytes = this.snapshot.totalBytes - (existing?.value.byteLength ?? 0) + value.byteLength;
      if (totalBytes > this.config.maxTotalBytes) {
        throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Local state has reached maxTotalBytes.");
      }
      const next = nextVersion(this.snapshot);
      const records = new Map(this.snapshot.records);
      records.set(key, {
        key,
        value,
        version: next.version,
        updatedAt: canonicalNow(this.clock),
      });
      await this.commit({
        generation: next.generation,
        listGeneration: this.snapshot.listGeneration,
        records,
        totalBytes,
      });
      return clonePresence(presence);
    });
  }

  removePresence(request: StatePresenceRemoveRequest): Promise<boolean> {
    return this.runExclusive(request.signal, async () => {
      await this.guardPaths();
      const key = presenceStorageKey(request.presenceId);
      const existing = this.snapshot.records.get(key);
      if (existing === undefined) return false;
      const presence = decodePresenceRecord(existing.value, key);
      if (presence.instanceId !== request.instanceId) return false;
      const next = nextVersion(this.snapshot);
      const records = new Map(this.snapshot.records);
      records.delete(key);
      await this.commit({
        generation: next.generation,
        listGeneration: this.snapshot.listGeneration,
        records,
        totalBytes: this.snapshot.totalBytes - existing.value.byteLength,
      });
      return true;
    });
  }

  listPresence(request: StatePresenceListRequest): Promise<readonly StatePresenceRecord[]> {
    return this.runExclusive(request.signal, async () => {
      await this.guardPaths();
      const now = this.clock().valueOf();
      if (!Number.isFinite(now)) {
        throw new StateLocalError("STATE_INVALID_CONFIG", "The local state clock returned an invalid date.");
      }
      const presence: StatePresenceRecord[] = [];
      for (const [key, record] of this.snapshot.records) {
        if (!key.startsWith(INTERNAL_PRESENCE_PREFIX)) continue;
        const decoded = decodePresenceRecord(record.value, key);
        if (request.agentId !== undefined && decoded.agentId !== request.agentId) continue;
        if (request.includeExpired !== true && Date.parse(decoded.expiresAt) <= now) continue;
        presence.push(clonePresence(decoded));
      }
      presence.sort((left, right) =>
        left.presenceId < right.presenceId ? -1 : left.presenceId > right.presenceId ? 1 : 0);
      return presence;
    });
  }

  publishPresence(
    update: StatePresenceUpdate,
    signal: AbortSignal,
  ): Promise<StatePresenceDescriptor> {
    return this.runExclusive(signal, async () => {
      await this.guardPaths();
      if (this.presence === undefined || !this.started) {
        throw new StateLocalError(
          "STATE_INVALID_CONFIG",
          "Presence publication requires discovery config and a started state module.",
        );
      }
      const descriptor = await this.presence.publish(update, signal);
      this.presenceUpdate = update;
      return descriptor;
    });
  }

  async publishHostPresence(request: StateHostPresenceRequest): Promise<void> {
    // Discovery is optional for a StateStore. Core may offer host presence to any
    // conforming store, so a local store without discovery configured must be a
    // truthful no-op rather than turning an otherwise valid agent into a startup
    // failure.
    if (this.presence === undefined) return;
    await this.publishPresence({
      status: request.status,
      ...(request.details === undefined ? {} : { details: request.details }),
    }, request.signal);
  }

  health(context: { readonly signal: AbortSignal }): Promise<ModuleHealth> {
    throwIfAborted(context.signal);
    return this.operation.then(async () => {
      if (this.closed || this.closing) {
        return {
          status: "unknown" as const,
          checkedAt: canonicalNow(this.clock),
          summary: "The local state store is closed.",
        };
      }
      if (this.poisoned !== undefined) {
        return {
          status: "unhealthy" as const,
          checkedAt: canonicalNow(this.clock),
          summary: this.poisoned.message,
        };
      }
      try {
        await this.guardPaths();
        return {
          status: "healthy",
          checkedAt: canonicalNow(this.clock),
          summary: "Local state is owner-private, consistent, and exclusively leased.",
          details: {
            records: [...this.snapshot.records.keys()].filter((key) => !isInternalStateKey(key)).length,
            presence: [...this.snapshot.records.keys()].filter((key) => isInternalStateKey(key)).length,
            bytes: this.snapshot.totalBytes,
            generation: this.snapshot.generation,
          },
        };
      } catch (error) {
        return {
          status: "unhealthy",
          checkedAt: canonicalNow(this.clock),
          summary: error instanceof Error ? error.message : "Local state health check failed.",
        };
      }
    });
  }

  async stop(context: ModuleStopContext): Promise<void> {
    if (this.closed) return;
    if (this.closing) {
      await this.operation;
      return;
    }
    this.closing = true;
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    let failure: unknown;
    const finalization = this.operation.then(async () => {
      try {
        if (this.started && this.presence !== undefined && !context.signal.aborted) {
          await this.presence.publish({ status: "stopping" }, context.signal);
          await this.presence.publish({ status: "stopped" }, context.signal);
        }
      } catch (error) {
        failure = error;
      } finally {
        this.started = false;
        this.closed = true;
        this.lease.release();
      }
    });
    this.operation = finalization.then(() => undefined, () => undefined);
    await finalization;
    if (failure !== undefined) throw failure;
  }

  close(signal: AbortSignal = new AbortController().signal): Promise<void> {
    return this.stop({ signal, reason: "shutdown" });
  }

  private async refreshPresence(): Promise<void> {
    if (this.closing || this.closed || this.presence === undefined) return;
    try {
      await this.runExclusive(new AbortController().signal, async () => {
        await this.guardPaths();
        await this.presence?.publish(this.presenceUpdate, new AbortController().signal);
      });
    } catch (error) {
      this.poisoned = new StateLocalError(
        "STATE_POISONED",
        "Presence heartbeat failed; local state is closed to further operations.",
        error,
      );
    }
  }

  private async guardPaths(): Promise<void> {
    if (this.poisoned !== undefined) throw this.poisoned;
    try {
      await verifySecureDirectoryIdentity(this.root, this.rootIdentity);
      await this.lease.verify();
      await verifySecureFileIdentity(this.snapshotPath, this.snapshotIdentity);
    } catch (error) {
      const failure = error instanceof StateLocalError
        ? error
        : new StateLocalError("STATE_PATH_CHANGED", "Local state identity verification failed.", error);
      this.poisoned = new StateLocalError(
        "STATE_POISONED",
        "Local state paths changed while the store was open; close and reopen before retrying.",
        failure,
      );
      throw failure;
    }
  }

  private async commit(draft: StateSnapshot): Promise<void> {
    try {
      const identity = await replaceSecureFileAtomic(
        this.snapshotPath,
        serializeSnapshot(draft),
        this.snapshotHooks,
      );
      this.snapshot = draft;
      this.snapshotIdentity = identity;
    } catch (error) {
      this.poisoned = new StateLocalError(
        "STATE_POISONED",
        "A local state commit did not complete safely; close and reopen before retrying.",
        error,
      );
      if (error instanceof StateLocalError) throw error;
      throw this.poisoned;
    }
  }

  private runExclusive<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (this.closed || this.closing) {
      return Promise.reject(new StateLocalError("STATE_CLOSED", "The local state store is closed."));
    }
    throwIfAborted(signal);
    const result = this.operation.then(async () => {
      throwIfAborted(signal);
      if (this.closed || this.closing) {
        throw new StateLocalError("STATE_CLOSED", "The local state store is closed.");
      }
      if (this.poisoned !== undefined) throw this.poisoned;
      return operation();
    });
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function prepareMarker(root: string): Promise<void> {
  const path = join(root, MARKER_FILE);
  const existing = await inspectSecureFile(path);
  if (existing === undefined) {
    await createSecureFile(path, Buffer.from(MARKER_CONTENT, "utf8"));
    return;
  }
  const loaded = await readSecureFile(path, 1_024);
  if (loaded.bytes.toString("utf8") !== MARKER_CONTENT) {
    throw new StateLocalError(
      "STATE_CORRUPT",
      "The local state ownership marker is invalid; refusing to overwrite this directory.",
    );
  }
}

function assertExpectedVersion(
  key: string,
  existing: StoredRecord | undefined,
  expectedVersion: string | undefined,
): void {
  if (expectedVersion !== undefined && existing?.version !== expectedVersion) {
    throw new StateLocalError(
      "STATE_VERSION_MISMATCH",
      `State record ${key} no longer matches expectedVersion.`,
    );
  }
}

function canonicalNow(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new StateLocalError("STATE_INVALID_CONFIG", "The local state clock returned an invalid date.");
  }
  return value.toISOString();
}

function clonePresence(presence: StatePresenceRecord): StatePresenceRecord {
  return normalizePresenceRecord(presence);
}

function encodeCursor(
  prefix: string,
  key: string | undefined,
  generation: number,
): string | undefined {
  if (key === undefined) return undefined;
  return Buffer.from(JSON.stringify({ v: 1, p: prefix, k: key, g: generation }), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string | undefined,
  prefix: string,
  generation: number,
): string | undefined {
  if (cursor === undefined) return undefined;
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 4_096) {
    throw new StateLocalError("STATE_INVALID_CURSOR", "State list cursor is invalid.");
  }
  let raw: unknown;
  try {
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new Error("Non-canonical cursor");
    raw = JSON.parse(decoded.toString("utf8")) as unknown;
  } catch (error) {
    throw new StateLocalError("STATE_INVALID_CURSOR", "State list cursor is invalid.", error);
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Object.prototype ||
    Object.keys(raw).sort().join(",") !== "g,k,p,v" ||
    (raw as { v?: unknown }).v !== 1 ||
    (raw as { p?: unknown }).p !== prefix ||
    (raw as { g?: unknown }).g !== generation
  ) {
    throw new StateLocalError("STATE_INVALID_CURSOR", "State list cursor does not match this query.");
  }
  try {
    const key = validateStateKey((raw as { k?: unknown }).k);
    if (!key.startsWith(prefix)) {
      throw new StateLocalError("STATE_INVALID_CURSOR", "State list cursor does not match this prefix.");
    }
    return key;
  } catch (error) {
    throw new StateLocalError("STATE_INVALID_CURSOR", "State list cursor contains an invalid key.", error);
  }
}
