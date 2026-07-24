import { opendir } from "node:fs/promises";
import { join } from "node:path";

import type {
  JsonValue,
  ModuleCommand,
  ModuleDiagnostic,
  ModuleDiagnosticsContext,
  ModuleHealth,
  ModuleToolContribution,
  ModuleStopContext,
} from "@mono-agent/module-sdk";
import type {
  StateDeleteRequest,
  StateCompareAndSwapRequest,
  StateCompareAndSwapResult,
  StateListRequest,
  StateListResult,
  StateReadRequest,
  StateRecord,
  StateScanRequest,
  StateScanResult,
  StatePresenceListRequest,
  StatePresenceRecord,
  StatePresenceRemoveRequest,
  StatePresenceUpsertRequest,
  StateHostPresenceRequest,
  StateStore,
  StateTransactionCheck,
  StateTransactionDelete,
  StateTransactionPut,
  StateTransactionRequest,
  StateTransactionResult,
  StateWriteRequest,
  StateWriteResult,
} from "@mono-agent/module-sdk/internal";

import type { ResolvedStateLocalConfig } from "./config.js";
import { DEFAULT_ARTIFACT_RETENTION_DAYS } from "./config.js";
import {
  StateLocalArtifacts,
  type StateLocalArtifactHooks,
  type StateArtifactRef,
  type StateDeleteArtifactRequest,
  type StateListArtifactsRequest,
  type StateListArtifactsResult,
  type StatePutArtifactRequest,
  type StateReadArtifactRequest,
} from "./artifacts.js";
import { StateLocalError, throwIfAborted } from "./errors.js";
import {
  STATE_LOCAL_EXECUTION_OPERATIONS,
  StateLocalExecution,
} from "./execution.js";
import type { ExecutionMaintenanceResult } from "./execution-journal.js";
import {
  normalizeStateLocalMaintenanceRequest,
  stateLocalMaintenanceInputSchema,
  stateLocalMaintenanceRequestFromCommand,
  type StateLocalMaintenanceRequest,
  type StateLocalMaintenanceResult,
} from "./maintenance.js";
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
  type AtomicReplaceHooks,
  type FileIdentity,
  type LeaseHooks,
  type ProcessLease,
  verifySecureDirectoryIdentity,
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
  stateSnapshotByteLimit,
  toStateRecord,
  type StateSnapshot,
  type StoredRecord,
  validateExpectedVersion,
  presenceStorageKey,
  validateStateKey,
  validateStatePrefix,
} from "./snapshot.js";

const STATE_CURSOR_MAX_CODE_UNITS = 16_512;

const MARKER_FILE = ".mono-agent-state";
const LEASE_FILE = "lease.sqlite";
const MARKER_CONTENT = '{"kind":"mono-agent-state-local","schemaVersion":1}\n';
const SNAPSHOT_INDEX_KEY = "snapshot";
const PRESENCE_INDEX_PREFIX = "presence:";
const STATE_INDEX_MAX_ENTRIES = 1_024;
const STATE_TRANSACTION_MAX_ENTRIES = 1_000;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BUFFER_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset")?.get;
const TYPED_ARRAY_TAG_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag)?.get;

export interface StateLocalStoreHooks {
  readonly artifacts?: StateLocalArtifactHooks;
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
  readonly commands: readonly ModuleCommand[];
  readonly execution: StateLocalExecution;
  readonly toolContributions: readonly ModuleToolContribution[];
  private readonly config: ResolvedStateLocalConfig;
  private readonly rootIdentity: FileIdentity;
  private readonly lease: ProcessLease;
  private readonly artifacts: StateLocalArtifacts;
  private readonly clock: () => Date;
  private readonly snapshotHooks: AtomicReplaceHooks | undefined;
  private readonly snapshotByteLimit: number;
  private readonly presence: PresencePublisher | undefined;
  private snapshot: StateSnapshot;
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
    artifacts: StateLocalArtifacts,
    snapshot: StateSnapshot,
    snapshotByteLimit: number,
    options: StateLocalStoreOpenOptions,
  ) {
    this.root = config.root;
    this.snapshotPath = `${lease.path}.index`;
    this.config = config;
    this.rootIdentity = rootIdentity;
    this.lease = lease;
    this.artifacts = artifacts;
    this.snapshot = snapshot;
    this.snapshotByteLimit = snapshotByteLimit;
    this.clock = options.clock ?? (() => new Date());
    this.snapshotHooks = options.hooks?.snapshot;
    this.commands = Object.freeze([{
      name: "state-local:maintain",
      kind: "maintenance",
      description:
        "Prune expired ephemeral presence and retention-eligible unpublished artifact reservations.",
      inputSchema: stateLocalMaintenanceInputSchema,
      run: async (input, context): Promise<JsonValue> => {
        const result = await this.maintain(
          stateLocalMaintenanceRequestFromCommand(input, context.signal),
        );
        return maintenanceResultToJson(result);
      },
    }]);
    const discovery = config.discovery;
    this.presence = discovery === undefined
      ? undefined
      : new PresencePublisher({
          config: discovery,
          instanceId: options.instanceId,
          stateRoot: config.root,
          startedAt: canonicalNow(this.clock),
          clock: this.clock,
          index: lease,
          ...(options.hooks?.presence === undefined ? {} : { hooks: options.hooks.presence }),
        });
    this.execution = new StateLocalExecution(this, {
      clock: this.clock,
      releaseArtifact: (ref, signal) => this.runExclusive(signal, async () => {
        await this.guardPaths();
        return this.artifacts.releasePublished({ ref, signal });
      }),
    });
    this.toolContributions = this.execution.toolContributions;
  }

  static async open(
    config: ResolvedStateLocalConfig,
    options: StateLocalStoreOpenOptions,
  ): Promise<StateLocalStore> {
    throwIfAborted(options.signal);
    const secureRoot = await ensureSecureDirectory(config.root);
    const effectiveConfig: ResolvedStateLocalConfig = { ...config, root: secureRoot.path };
    const rootIdentity = secureRoot.identity;
    await prepareMarker(effectiveConfig.root);
    const lease = await acquireProcessLease(
      join(effectiveConfig.root, LEASE_FILE),
      options.hooks?.lease,
    );
    let artifacts: StateLocalArtifacts | undefined;
    try {
      throwIfAborted(options.signal);
      const snapshotByteLimit = stateSnapshotByteLimit(effectiveConfig);
      const indexedKeys = lease.listIndexKeys("", STATE_INDEX_MAX_ENTRIES);
      if (indexedKeys.some((key) =>
        key !== SNAPSHOT_INDEX_KEY && !key.startsWith(PRESENCE_INDEX_PREFIX))) {
        throw new StateLocalError(
          "STATE_CORRUPT",
          "The local state transactional index contains an unexpected entry.",
        );
      }
      const encodedSnapshot = lease.readIndex(SNAPSHOT_INDEX_KEY, snapshotByteLimit);
      let snapshot: StateSnapshot;
      if (encodedSnapshot === undefined) {
        snapshot = emptySnapshot();
        lease.writeIndex(
          SNAPSHOT_INDEX_KEY,
          serializeSnapshot(snapshot, snapshotByteLimit),
        );
        await lease.verify();
      } else {
        snapshot = parseSnapshot(encodedSnapshot, effectiveConfig);
      }
      const clock = options.clock ?? (() => new Date());
      artifacts = await StateLocalArtifacts.open(
        effectiveConfig.runs?.artifactsDirectory ?? join(effectiveConfig.root, "artifacts"),
        rootIdentity,
        options.signal,
        options.hooks?.artifacts,
        clock,
      );
      throwIfAborted(options.signal);
      return new StateLocalStore(
        effectiveConfig,
        rootIdentity,
        lease,
        artifacts,
        snapshot,
        snapshotByteLimit,
        options,
      );
    } catch (error) {
      await artifacts?.close();
      await lease.release();
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

  transaction(request: StateTransactionRequest): Promise<StateTransactionResult> {
    const normalized = normalizeTransactionRequest(
      request,
      this.config.maxRecordBytes,
      this.config.maxTotalBytes,
    );
    return this.runExclusive(normalized.signal, async () => {
      await this.guardPaths();

      const conflicts = [
        ...normalized.checks,
        ...normalized.puts,
        ...normalized.deletes,
      ].flatMap((operation) => {
        const existing = this.snapshot.records.get(operation.key);
        const matches = operation.expectedVersion === null
          ? existing === undefined
          : existing?.version === operation.expectedVersion;
        return matches
          ? []
          : [{
              key: operation.key,
              ...(existing === undefined ? {} : { currentVersion: existing.version }),
            }];
      });
      if (conflicts.length > 0) {
        return { status: "conflict" as const, conflicts };
      }

      const deleted = normalized.deletes
        .map((operation) => this.snapshot.records.get(operation.key))
        .filter((record): record is StoredRecord => record !== undefined);
      const mutationCount = normalized.puts.length + deleted.length;
      if (mutationCount === 0) {
        return { status: "applied", records: [], deletedKeys: [] };
      }
      if (this.snapshot.generation > Number.MAX_SAFE_INTEGER - mutationCount) {
        throw new StateLocalError(
          "STATE_LIMIT_EXCEEDED",
          "The local state version counter cannot accommodate this transaction.",
        );
      }

      const finalRecordCount = this.snapshot.records.size + normalized.puts
        .filter((operation) => !this.snapshot.records.has(operation.key)).length - deleted.length;
      if (finalRecordCount > this.config.maxRecords) {
        throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Local state has reached maxRecords.");
      }
      const putBytes = normalized.puts.reduce((total, operation) =>
        total + operation.value.byteLength, 0);
      const replacedBytes = normalized.puts.reduce((total, operation) =>
        total + (this.snapshot.records.get(operation.key)?.value.byteLength ?? 0), 0);
      const deletedBytes = deleted.reduce((total, record) => total + record.value.byteLength, 0);
      const totalBytes = this.snapshot.totalBytes - replacedBytes - deletedBytes + putBytes;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > this.config.maxTotalBytes) {
        throw new StateLocalError("STATE_LIMIT_EXCEEDED", "Local state has reached maxTotalBytes.");
      }

      const records = new Map(this.snapshot.records);
      const updatedAt = canonicalNow(this.clock);
      let generation = this.snapshot.generation;
      const appliedRecords: StateRecord[] = [];
      for (const operation of normalized.puts) {
        generation += 1;
        const stored: StoredRecord = {
          key: operation.key,
          value: operation.value,
          version: `v${generation}`,
          updatedAt,
        };
        records.set(operation.key, stored);
        appliedRecords.push(toStateRecord(stored));
      }
      const deletedKeys: string[] = [];
      for (const operation of normalized.deletes) {
        if (!records.delete(operation.key)) continue;
        generation += 1;
        deletedKeys.push(operation.key);
      }

      await this.commit({
        generation,
        listGeneration: nextListGeneration(this.snapshot),
        records,
        totalBytes,
      });
      return {
        status: "applied",
        records: appliedRecords,
        deletedKeys,
      };
    });
  }

  scan(request: StateScanRequest): Promise<StateScanResult> {
    const normalized = normalizeScanRequest(request);
    return this.runExclusive(normalized.signal, async () => {
      await this.guardPaths();
      const afterKey = decodeScanCursor(normalized.cursor, normalized.prefix);
      const matching = [...this.snapshot.records.values()]
        .filter((record) =>
          !isInternalStateKey(record.key) &&
          record.key.startsWith(normalized.prefix) &&
          (afterKey === undefined || record.key > afterKey))
        .sort(compareStoredRecords);
      const selected = matching.slice(0, normalized.limit);
      const cursor = matching.length > selected.length
        ? encodeScanCursor(normalized.prefix, selected[selected.length - 1]?.key)
        : undefined;
      return {
        records: selected.map(toStateRecord),
        ...(cursor === undefined ? {} : { cursor }),
      };
    });
  }

  putArtifact(request: StatePutArtifactRequest): Promise<StateArtifactRef> {
    return this.runExclusive(request.signal, async () => {
      await this.guardPaths();
      return this.artifacts.put(request);
    });
  }

  readArtifact(request: StateReadArtifactRequest): Promise<Uint8Array> {
    return this.runExclusive(request.signal, async () => {
      await this.guardPaths();
      return this.artifacts.read(request);
    });
  }

  deleteArtifact(request: StateDeleteArtifactRequest): Promise<boolean> {
    return this.runExclusive(request.signal, async () => {
      await this.guardPaths();
      return this.artifacts.delete(request);
    });
  }

  listArtifacts(request: StateListArtifactsRequest): Promise<StateListArtifactsResult> {
    return this.runExclusive(request.signal, async () => {
      await this.guardPaths();
      return this.artifacts.list(request);
    });
  }

  get artifactRetentionDays(): number {
    return this.config.runs?.retentionDays ?? DEFAULT_ARTIFACT_RETENTION_DAYS;
  }

  async maintain(request: StateLocalMaintenanceRequest): Promise<StateLocalMaintenanceResult> {
    const normalized = normalizeStateLocalMaintenanceRequest(request);
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
      throw new StateLocalError(
        "STATE_INVALID_CONFIG",
        "The local state clock returned an invalid date.",
      );
    }
    const checkedAt = now.toISOString();
    const artifactCutoffAt = new Date(
      now.valueOf() - this.artifactRetentionDays * 24 * 60 * 60_000,
    ).toISOString();
    const presenceResult = await this.runExclusive(normalized.signal, async () => {
      await this.guardPaths();
      const expired = [...this.snapshot.records.values()]
        .filter((record) => {
          if (!record.key.startsWith(INTERNAL_PRESENCE_PREFIX)) return false;
          return Date.parse(decodePresenceRecord(record.value, record.key).expiresAt) <= now.valueOf();
        })
        .sort((left, right) =>
          left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
      const selectedPresence = expired.slice(0, normalized.limit);
      let expiredPresenceRemoved = 0;
      if (!normalized.dryRun && selectedPresence.length > 0) {
        const records = new Map(this.snapshot.records);
        let totalBytes = this.snapshot.totalBytes;
        for (const record of selectedPresence) {
          if (!records.delete(record.key)) {
            throw new StateLocalError(
              "STATE_CORRUPT",
              "Expired presence disappeared during serialized maintenance.",
            );
          }
          totalBytes -= record.value.byteLength;
        }
        const next = nextVersion(this.snapshot);
        await this.commit({
          generation: next.generation,
          listGeneration: this.snapshot.listGeneration,
          records,
          totalBytes,
        });
        expiredPresenceRemoved = selectedPresence.length;
      }
      return {
        candidates: expired.length,
        removed: expiredPresenceRemoved,
        truncated: expired.length > selectedPresence.length,
      };
    });
    const executionResult = await this.execution.perform({
      operation: "maintenance.run",
      input: {
        cutoffAt: artifactCutoffAt,
        dryRun: normalized.dryRun,
        limit: Math.min(normalized.limit, 1_000),
      },
      signal: normalized.signal,
    }) as ExecutionMaintenanceResult;
    const artifactResult = await this.runExclusive(normalized.signal, async () => {
      await this.guardPaths();
      const artifactResult = await this.artifacts.maintain({
        cutoffAt: artifactCutoffAt,
        dryRun: normalized.dryRun,
        limit: normalized.limit,
        signal: normalized.signal,
      });
      return artifactResult;
    });
    return Object.freeze({
      checkedAt,
      artifactCutoffAt,
      dryRun: normalized.dryRun,
      expiredPresenceCandidates: presenceResult.candidates,
      expiredPresenceRemoved: presenceResult.removed,
      unpublishedArtifactCandidates: artifactResult.candidates,
      unpublishedArtifactRemoved: artifactResult.removed,
      reclaimedArtifactBytes: artifactResult.reclaimedBytes,
      terminalRunCandidates: executionResult.terminalRunCandidates,
      terminalRunsRemoved: executionResult.terminalRunsRemoved,
      runEventsRemoved: executionResult.runEventsRemoved,
      terminalAdmissionsRemoved: executionResult.terminalAdmissionsRemoved,
      terminalDeliveryCandidates: executionResult.terminalDeliveryCandidates,
      terminalDeliveriesRemoved: executionResult.terminalDeliveriesRemoved,
      staleSessionCandidates: executionResult.staleSessionCandidates,
      staleSessionsRemoved: executionResult.staleSessionsRemoved,
      publishedArtifactsReleased: executionResult.publishedArtifactsReleased,
      pendingRunRetentionCheckpoints: executionResult.pendingCheckpoints,
      truncated:
        presenceResult.truncated ||
        artifactResult.truncated ||
        executionResult.truncated,
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

  async diagnostics(
    context: ModuleDiagnosticsContext,
  ): Promise<readonly ModuleDiagnostic[]> {
    throwIfAborted(context.signal);
    if (this.closed || this.closing) {
      return Object.freeze([stateLocalDiagnostic(
        "state-local.closed",
        "error",
        "The selected local state store is closed and unavailable.",
        "Create a fresh selected state instance before running diagnostics again.",
      )]);
    }
    try {
      const health = await this.health({ signal: context.signal });
      throwIfAborted(context.signal);
      if (health.status !== "healthy") {
        return Object.freeze([stateLocalDiagnostic(
          health.status === "unhealthy"
            ? "state-local.integrity"
            : "state-local.unavailable",
          health.status === "unhealthy" ? "error" : "warning",
          health.status === "unhealthy"
            ? "Local state identity or integrity could not be proven."
            : "Local state is not currently available for verified operation.",
          "Keep the agent stopped; preserve state and artifacts together, then inspect from a verified copy.",
        )]);
      }
      const protocol = await this.execution.perform({
        operation: "protocol.describe",
        signal: context.signal,
      });
      throwIfAborted(context.signal);
      if (!isExpectedExecutionProtocol(protocol)) {
        return Object.freeze([stateLocalDiagnostic(
          "state-local.execution-protocol",
          "error",
          "The local state execution protocol identity is incompatible.",
          "Keep the agent stopped and use matching lockstep @mono-agent package versions.",
        )]);
      }
      return Object.freeze([stateLocalDiagnostic(
        "state-local.integrity",
        "info",
        "Owner-private local state identity, writer lease, and execution protocol v1 are verified.",
      )]);
    } catch {
      if (context.signal.aborted) throwIfAborted(context.signal);
      return Object.freeze([stateLocalDiagnostic(
        "state-local.integrity",
        "error",
        "Local state identity or integrity could not be proven.",
        "Keep the agent stopped; preserve state and artifacts together, then inspect from a verified copy.",
      )]);
    }
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
        const cleanup = [
          async () => this.presence?.close(),
          async () => this.artifacts.close(),
          async () => this.lease.release(),
        ];
        for (const close of cleanup) {
          try {
            await close();
          } catch (error) {
            if (failure === undefined) failure = error;
          }
        }
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
      await this.artifacts.verify();
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
    // Serialization and its exact startup/read bound are checked before the
    // uncertain durable-append region. A predictable capacity failure must not
    // poison an otherwise healthy store.
    const bytes = serializeSnapshot(draft, this.snapshotByteLimit);
    try {
      await this.snapshotHooks?.beforeRename?.(this.snapshotPath);
      await this.lease.verify();
      await this.snapshotHooks?.afterCheck?.(this.snapshotPath);
      this.lease.writeIndex(SNAPSHOT_INDEX_KEY, bytes);
      await this.snapshotHooks?.afterRename?.(this.snapshotPath);
      await this.lease.verify();
      this.snapshot = draft;
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
    for await (const entry of await opendir(root)) {
      throw new StateLocalError(
        "STATE_CORRUPT",
        `Refusing to claim non-empty state root containing ${entry.name}.`,
      );
    }
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

interface NormalizedTransactionCheck {
  readonly key: string;
  readonly expectedVersion: string | null;
}

interface NormalizedTransactionPut extends NormalizedTransactionCheck {
  readonly value: Buffer;
}

interface NormalizedTransactionRequest {
  readonly checks: readonly NormalizedTransactionCheck[];
  readonly puts: readonly NormalizedTransactionPut[];
  readonly deletes: readonly NormalizedTransactionCheck[];
  readonly signal: AbortSignal;
}

interface NormalizedScanRequest {
  readonly prefix: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly signal: AbortSignal;
}

function normalizeTransactionRequest(
  request: StateTransactionRequest,
  maxRecordBytes: number,
  maxTotalBytes: number,
): NormalizedTransactionRequest {
  const value = readOwnDataRecord(
    request,
    ["checks", "deletes", "puts", "signal"],
    ["checks", "deletes", "puts", "signal"],
    "State transaction",
  );
  const checkInputs = readDenseArray<StateTransactionCheck>(
    value.checks,
    STATE_TRANSACTION_MAX_ENTRIES,
    "State transaction checks",
  );
  const putInputs = readDenseArray<StateTransactionPut>(
    value.puts,
    STATE_TRANSACTION_MAX_ENTRIES,
    "State transaction puts",
  );
  const deleteInputs = readDenseArray<StateTransactionDelete>(
    value.deletes,
    STATE_TRANSACTION_MAX_ENTRIES,
    "State transaction deletes",
  );
  const total = checkInputs.length + putInputs.length + deleteInputs.length;
  if (total < 1 || total > STATE_TRANSACTION_MAX_ENTRIES) {
    throw new StateLocalError(
      "STATE_LIMIT_EXCEEDED",
      `State transactions must contain from 1 through ${STATE_TRANSACTION_MAX_ENTRIES} entries.`,
    );
  }

  const checks = checkInputs.map((operation, index) =>
    normalizeTransactionOperation(operation, "check", index));
  let putBytes = 0;
  const puts = putInputs.map((operation, index) => {
    const normalized = normalizeTransactionOperation(operation, "put", index);
    const data = readOwnDataRecord(
      operation,
      ["expectedVersion", "key", "value"],
      ["expectedVersion", "key", "value"],
      `State transaction put ${index}`,
    );
    const bytes = cloneTransactionBytes(data.value, normalized.key, maxRecordBytes);
    putBytes += bytes.byteLength;
    if (!Number.isSafeInteger(putBytes) || putBytes > maxTotalBytes) {
      throw new StateLocalError(
        "STATE_LIMIT_EXCEEDED",
        "State transaction put data exceeds maxTotalBytes.",
      );
    }
    return { ...normalized, value: bytes };
  });
  const deletes = deleteInputs.map((operation, index) =>
    normalizeTransactionOperation(operation, "delete", index));
  const keys = new Set<string>();
  for (const operation of [...checks, ...puts, ...deletes]) {
    if (keys.has(operation.key)) {
      throw new StateLocalError(
        "STATE_INVALID_CONFIG",
        `State transaction key ${operation.key} occurs more than once.`,
      );
    }
    keys.add(operation.key);
  }
  return {
    checks,
    puts,
    deletes,
    signal: readAbortSignal(value.signal, "State transaction signal"),
  };
}

function normalizeTransactionOperation(
  operation: StateTransactionCheck | StateTransactionPut | StateTransactionDelete,
  kind: "check" | "put" | "delete",
  index: number,
): NormalizedTransactionCheck {
  const keys = kind === "put"
    ? ["expectedVersion", "key", "value"]
    : ["expectedVersion", "key"];
  const value = readOwnDataRecord(
    operation,
    keys,
    keys,
    `State transaction ${kind} ${index}`,
  );
  const key = validateStateKey(value.key);
  const expectedVersion = value.expectedVersion === null
    ? null
    : validateExpectedVersion(value.expectedVersion);
  if (expectedVersion === undefined) {
    throw new StateLocalError(
      "STATE_VERSION_MISMATCH",
      `State transaction ${kind} ${index} must provide expectedVersion.`,
    );
  }
  return { key, expectedVersion };
}

function cloneTransactionBytes(
  value: unknown,
  key: string,
  maxRecordBytes: number,
): Buffer {
  try {
    if (
      TYPED_ARRAY_BUFFER_GETTER === undefined ||
      TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined ||
      TYPED_ARRAY_BYTE_OFFSET_GETTER === undefined ||
      TYPED_ARRAY_TAG_GETTER === undefined ||
      TYPED_ARRAY_TAG_GETTER.call(value) !== "Uint8Array"
    ) {
      throw new TypeError("Expected Uint8Array");
    }
    // Invoke the intrinsic accessors directly. Own/subclass accessors are
    // ignored, while a Proxy has no typed-array internal slot and is rejected.
    const beforeLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value) as unknown;
    const beforeOffset = TYPED_ARRAY_BYTE_OFFSET_GETTER.call(value) as unknown;
    const buffer = TYPED_ARRAY_BUFFER_GETTER.call(value) as unknown;
    if (
      !Number.isSafeInteger(beforeLength) ||
      (beforeLength as number) < 0 ||
      !Number.isSafeInteger(beforeOffset) ||
      (beforeOffset as number) < 0 ||
      (
        !(buffer instanceof ArrayBuffer) &&
        !(typeof SharedArrayBuffer === "function" && buffer instanceof SharedArrayBuffer)
      )
    ) {
      throw new TypeError("Invalid Uint8Array internals");
    }
    if ((beforeLength as number) > maxRecordBytes) {
      throw new StateLocalError(
        "STATE_LIMIT_EXCEEDED",
        `State record ${key} exceeds maxRecordBytes.`,
      );
    }
    const source = new Uint8Array(
      buffer as ArrayBufferLike,
      beforeOffset as number,
      beforeLength as number,
    );
    const bytes = Buffer.from(source);
    const afterLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value) as unknown;
    const afterOffset = TYPED_ARRAY_BYTE_OFFSET_GETTER.call(value) as unknown;
    const afterBuffer = TYPED_ARRAY_BUFFER_GETTER.call(value) as unknown;
    if (
      afterLength !== beforeLength ||
      afterOffset !== beforeOffset ||
      afterBuffer !== buffer ||
      bytes.byteLength !== beforeLength ||
      bytes.byteLength > maxRecordBytes
    ) {
      throw new StateLocalError(
        "STATE_INVALID_CONFIG",
        `State transaction byte data for ${key} changed while being copied.`,
      );
    }
    return bytes;
  } catch (error) {
    if (error instanceof StateLocalError) throw error;
    throw new StateLocalError(
      "STATE_INVALID_CONFIG",
      `State transaction value for ${key} must be byte data.`,
      error,
    );
  }
}

function normalizeScanRequest(request: StateScanRequest): NormalizedScanRequest {
  const value = readOwnDataRecord(
    request,
    ["limit", "prefix", "signal"],
    ["cursor", "limit", "prefix", "signal"],
    "State scan",
  );
  const prefix = validateStatePrefix(value.prefix);
  if (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 1_000) {
    throw new StateLocalError(
      "STATE_LIMIT_EXCEEDED",
      "State scan limit must be from 1 through 1000.",
    );
  }
  if (
    value.cursor !== undefined &&
    (
      typeof value.cursor !== "string"
      || value.cursor.length === 0
      || value.cursor.length > STATE_CURSOR_MAX_CODE_UNITS
    )
  ) {
    throw new StateLocalError("STATE_INVALID_CURSOR", "State scan cursor is invalid.");
  }
  return {
    prefix,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }),
    limit: value.limit as number,
    signal: readAbortSignal(value.signal, "State scan signal"),
  };
}

function readOwnDataRecord(
  value: unknown,
  required: readonly string[],
  allowed: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("Expected object");
    }
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value) as Readonly<
      Record<string, PropertyDescriptor>
    >;
  } catch (error) {
    throw new StateLocalError(
      "STATE_INVALID_CONFIG",
      `${label} must be a plain own-data object.`,
      error,
    );
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new StateLocalError(
      "STATE_INVALID_CONFIG",
      `${label} must be a plain own-data object.`,
    );
  }
  if (keys.some((key) => typeof key !== "string")) {
    throw new StateLocalError("STATE_INVALID_CONFIG", `${label} must not contain symbol fields.`);
  }
  const names = keys as readonly string[];
  if (
    required.some((key) => !names.includes(key)) ||
    names.some((key) => !allowed.includes(key))
  ) {
    throw new StateLocalError(
      "STATE_INVALID_CONFIG",
      `${label} contains unknown or missing fields.`,
    );
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    const descriptor = descriptors[name];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new StateLocalError(
        "STATE_INVALID_CONFIG",
        `${label} fields must be enumerable own data properties.`,
      );
    }
    result[name] = descriptor.value;
  }
  return result;
}

function readDenseArray<T>(
  value: unknown,
  maximum: number,
  label: string,
): readonly T[] {
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  let descriptors: Readonly<Record<string, PropertyDescriptor>>;
  try {
    if (!Array.isArray(value)) throw new TypeError("Expected array");
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value) as Readonly<
      Record<string, PropertyDescriptor>
    >;
  } catch (error) {
    throw new StateLocalError("STATE_INVALID_CONFIG", `${label} must be a dense array.`, error);
  }
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor !== undefined && "value" in lengthDescriptor
    ? lengthDescriptor.value as unknown
    : undefined;
  if (
    prototype !== Array.prototype ||
    !Number.isSafeInteger(length) ||
    (length as number) < 0 ||
    (length as number) > maximum
  ) {
    throw new StateLocalError(
      Number.isSafeInteger(length) && (length as number) > maximum
        ? "STATE_LIMIT_EXCEEDED"
        : "STATE_INVALID_CONFIG",
      `${label} must be a bounded dense array.`,
    );
  }
  const expectedKeys = new Set<PropertyKey>([
    ...Array.from({ length: length as number }, (_, index) => String(index)),
    "length",
  ]);
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key))) {
    throw new StateLocalError("STATE_INVALID_CONFIG", `${label} must be a dense own-data array.`);
  }
  const result: T[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new StateLocalError("STATE_INVALID_CONFIG", `${label} must be a dense own-data array.`);
    }
    result.push(descriptor.value as T);
  }
  return result;
}

function readAbortSignal(value: unknown, label: string): AbortSignal {
  try {
    if (!(value instanceof AbortSignal)) throw new TypeError("Expected AbortSignal");
  } catch (error) {
    throw new StateLocalError("STATE_INVALID_CONFIG", `${label} must be an AbortSignal.`, error);
  }
  return value;
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

function compareStoredRecords(left: StoredRecord, right: StoredRecord): number {
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
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
  if (
    typeof cursor !== "string"
    || cursor.length === 0
    || cursor.length > STATE_CURSOR_MAX_CODE_UNITS
  ) {
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

function encodeScanCursor(prefix: string, key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const cursor = Buffer.from(
    JSON.stringify({ v: 1, p: prefix, k: key }),
    "utf8",
  ).toString("base64url");
  if (cursor.length > STATE_CURSOR_MAX_CODE_UNITS) {
    throw new StateLocalError("STATE_LIMIT_EXCEEDED", "State scan cursor exceeds its byte bound.");
  }
  return cursor;
}

function decodeScanCursor(cursor: string | undefined, prefix: string): string | undefined {
  if (cursor === undefined) return undefined;
  let raw: unknown;
  try {
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new Error("Non-canonical cursor");
    raw = JSON.parse(decoded.toString("utf8")) as unknown;
  } catch (error) {
    throw new StateLocalError("STATE_INVALID_CURSOR", "State scan cursor is invalid.", error);
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Object.prototype ||
    Object.keys(raw).sort().join(",") !== "k,p,v" ||
    (raw as { v?: unknown }).v !== 1 ||
    (raw as { p?: unknown }).p !== prefix
  ) {
    throw new StateLocalError("STATE_INVALID_CURSOR", "State scan cursor does not match this query.");
  }
  try {
    const key = validateStateKey((raw as { k?: unknown }).k);
    if (!key.startsWith(prefix)) {
      throw new StateLocalError("STATE_INVALID_CURSOR", "State scan cursor does not match this prefix.");
    }
    return key;
  } catch (error) {
    throw new StateLocalError(
      "STATE_INVALID_CURSOR",
      "State scan cursor contains an invalid key.",
      error,
    );
  }
}

function maintenanceResultToJson(result: StateLocalMaintenanceResult): JsonValue {
  return {
    checkedAt: result.checkedAt,
    artifactCutoffAt: result.artifactCutoffAt,
    dryRun: result.dryRun,
    expiredPresenceCandidates: result.expiredPresenceCandidates,
    expiredPresenceRemoved: result.expiredPresenceRemoved,
    unpublishedArtifactCandidates: result.unpublishedArtifactCandidates,
    unpublishedArtifactRemoved: result.unpublishedArtifactRemoved,
    reclaimedArtifactBytes: result.reclaimedArtifactBytes,
    terminalRunCandidates: result.terminalRunCandidates,
    terminalRunsRemoved: result.terminalRunsRemoved,
    runEventsRemoved: result.runEventsRemoved,
    terminalAdmissionsRemoved: result.terminalAdmissionsRemoved,
    terminalDeliveryCandidates: result.terminalDeliveryCandidates,
    terminalDeliveriesRemoved: result.terminalDeliveriesRemoved,
    staleSessionCandidates: result.staleSessionCandidates,
    staleSessionsRemoved: result.staleSessionsRemoved,
    publishedArtifactsReleased: result.publishedArtifactsReleased,
    pendingRunRetentionCheckpoints: result.pendingRunRetentionCheckpoints,
    truncated: result.truncated,
  };
}

function stateLocalDiagnostic(
  code: string,
  severity: ModuleDiagnostic["severity"],
  message: string,
  hint?: string,
): ModuleDiagnostic {
  return Object.freeze({
    code,
    severity,
    message,
    ...(hint === undefined ? {} : { hint }),
  });
}

function isExpectedExecutionProtocol(value: unknown): boolean {
  try {
    if (
      value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    ) return false;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 3
      || !["protocol", "version", "operations"].every((key) => keys.includes(key))
    ) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const protocol = descriptors.protocol;
    const version = descriptors.version;
    const operationsDescriptor = descriptors.operations;
    if (
      protocol === undefined
      || !("value" in protocol)
      || protocol.value !== "mono-agent.state-execution"
      || version === undefined
      || !("value" in version)
      || version.value !== 1
      || operationsDescriptor === undefined
      || !("value" in operationsDescriptor)
      || !Array.isArray(operationsDescriptor.value)
      || Object.getPrototypeOf(operationsDescriptor.value) !== Array.prototype
    ) return false;
    const operations = operationsDescriptor.value as readonly unknown[];
    const operationKeys = Reflect.ownKeys(operations);
    if (
      operations.length !== STATE_LOCAL_EXECUTION_OPERATIONS.length
      || operationKeys.length !== operations.length + 1
      || operationKeys.some((key) =>
        key !== "length"
        && (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key)))
    ) return false;
    const operationDescriptors = Object.getOwnPropertyDescriptors(operations);
    return STATE_LOCAL_EXECUTION_OPERATIONS.every((operation, index) => {
      const descriptor = operationDescriptors[String(index)];
      return descriptor !== undefined
        && "value" in descriptor
        && descriptor.value === operation;
    });
  } catch {
    return false;
  }
}
