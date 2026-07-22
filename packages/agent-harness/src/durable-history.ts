import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

import type { HistoryMessage } from "./context/index.js";
import type {
  ConversationHistoryProviderSessionTurn,
  ConversationHistoryStore,
  PreparedHistoryAppend,
  ProviderSessionTurnCommitOptions,
} from "./types.js";

const LEGACY_STORE_VERSION = 1;
const STORE_VERSION = 2;
const DEFAULT_MAX_MESSAGES = 64;
const MAX_CONVERSATION_ID_BYTES = 4 * 1024;
const MAX_MESSAGE_CONTENT_BYTES = 64 * 1024;
const MAX_MESSAGE_ENVELOPE_BYTES = 16 * 1024;
// JSON may encode one content byte as a six-byte escape (for example, NUL).
const MAX_MESSAGE_SERIALIZED_BYTES = MAX_MESSAGE_CONTENT_BYTES * 6 + MAX_MESSAGE_ENVELOPE_BYTES;
const MAX_STORE_FILE_BYTES = DEFAULT_MAX_MESSAGES * MAX_MESSAGE_SERIALIZED_BYTES + 64 * 1024;
const MAX_APPEND_MESSAGES = DEFAULT_MAX_MESSAGES;
const DEFAULT_MAX_STORE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_CONVERSATIONS = 10_000;
const DEFAULT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1_000;
const HISTORY_FILE_SUFFIX = ".history.json";
const LOCKS_DIRECTORY = ".locks";
const ROOT_LOCK_FILE = "root.sqlite";
const CONVERSATION_LOCK_SHARDS = 16;
const CONVERSATION_SHARD_LOCK_PATTERN = /^conversation-shard-([a-f0-9]{2})\.sqlite$/u;
const TEMP_FILE_PATTERN = /^\.([a-f0-9]{64})\.([0-9]+)\.[a-f0-9]{24}\.tmp$/u;
const HISTORY_FILE_PATTERN = /^[a-f0-9]{64}\.history\.json$/u;
const LEGACY_CONVERSATION_LOCK_PATTERN = /^[a-f0-9]{64}\.sqlite$/u;
const ACTIVE_MARKER_PATTERN = /^([a-f0-9]{64})\.([0-9]+)\.([a-f0-9]{32})\.active$/u;
const DIRTY_FENCE_PATTERN = /^([a-f0-9]{64})\.dirty\.json$/u;
const DIRTY_FENCE_TEMP_PATTERN = /^\.([a-f0-9]{64})\.([0-9]+)\.([a-f0-9]{24})\.dirty\.tmp$/u;
const MAX_ACTIVE_MARKER_BYTES = 4 * 1024;
const MAX_DIRTY_FENCE_BYTES = 1024;
const MAX_RUN_ID_BYTES = 4 * 1024;

// Config reloads can briefly leave old and new harness instances alive in the
// same owner process. Module-level queues serialize both same-conversation
// read/modify/write work and root-wide retention accounting across instances.
const PROCESS_APPEND_QUEUES = new Map<string, Promise<void>>();
const PROCESS_ROOT_QUEUES = new Map<string, Promise<void>>();
const PROCESS_POST_COMMIT_FAILURES = new Map<string, { count: number; lastError?: string }>();

export interface DurableHistoryStoreOptions {
  /** Owner-only directory containing one content-addressed file per conversation. */
  readonly root: string;
  /** Retained messages per conversation. Defaults to, and may not exceed, 64. */
  readonly maxMessages?: number;
  /** Aggregate committed-history quota. Defaults to 256 MiB. */
  readonly maxStoreBytes?: number;
  /** Aggregate unpublished-stage quota. Defaults to `maxStoreBytes`. */
  readonly maxStagedBytes?: number;
  /** Maximum committed conversations. Defaults to 10,000. */
  readonly maxConversations?: number;
  /** Maximum inactive conversation-file age. Defaults to 365 days. */
  readonly maxAgeMs?: number;
  /** Injectable clock for deterministic retention and tests. */
  readonly now?: () => number;
  /**
   * Fail-closed removal of an exact provider-session id. When present, this
   * store may coordinate durable provider sessions across processes; every
   * epoch made unreachable is retired before the owning history mutation.
   */
  readonly retireProviderSession?: (providerSessionId: string) => Promise<void>;
}

export interface DurableHistoryStoreStats {
  readonly conversations: number;
  readonly bytes: number;
  readonly activePreparedAppends: number;
  readonly postCommitMaintenanceFailures: number;
  readonly lastPostCommitMaintenanceError?: string;
  readonly limits: {
    readonly maxMessages: number;
    readonly maxStoreBytes: number;
    readonly maxStagedBytes: number;
    readonly maxConversations: number;
    readonly maxAgeMs: number;
  };
}

interface ProviderSessionState {
  readonly epoch: string;
  readonly revision?: number;
  readonly dirtyRunId?: string;
}

interface HistoryFileV2 {
  readonly version: typeof STORE_VERSION;
  readonly conversationId: string;
  readonly messages: readonly HistoryMessage[];
  readonly providerSession: ProviderSessionState;
}

interface LoadedHistoryRecord {
  readonly sourceVersion: 0 | typeof LEGACY_STORE_VERSION | typeof STORE_VERSION;
  readonly conversationId: string;
  readonly messages: readonly HistoryMessage[];
  readonly providerSession?: ProviderSessionState;
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface ActiveStage {
  readonly conversationKey: string;
  readonly destinationName: string;
  readonly temporaryPath: string;
  readonly bytes: number;
}

interface ActiveMarker {
  readonly path: string;
  readonly conversationKey: string;
  readonly pid: number;
  readonly token: string;
}

interface DirtyFence {
  readonly path: string;
  readonly conversationKey: string;
  readonly epoch: string;
  readonly providerSessionId?: string;
  readonly revision: number;
  readonly runIdDigest: string;
  readonly mtimeMs?: number;
}

interface HeldConversation {
  readonly marker: ActiveMarker;
  readonly rootIdentity: DirectoryIdentity;
  release(): Promise<void>;
}

interface CrossProcessLock {
  release(): Promise<void>;
}

interface CommittedEntry {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Restart-durable conversation history with bounded, owner-only, atomic files.
 *
 * Conversation ids never become path components: their normalized exact value
 * is stored in the file while a SHA-256 digest selects the filename. Prepared
 * appends are fully validated and fsynced but remain invisible until commit's
 * atomic rename. SQLite-backed OS locks serialize same-conversation turns and
 * root retention across both store instances and independent processes.
 */
export class DurableConversationHistoryStore implements ConversationHistoryStore {
  readonly providerSessionRetirement: "fail-closed" | undefined;
  private readonly root: string;
  private readonly maxMessages: number;
  private readonly maxStoreBytes: number;
  private readonly maxStagedBytes: number;
  private readonly maxConversations: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly retireProviderSession: ((providerSessionId: string) => Promise<void>) | undefined;
  private rootReady: Promise<DirectoryIdentity> | undefined;
  private locksRootReady: Promise<DirectoryIdentity> | undefined;

  constructor(options: DurableHistoryStoreOptions) {
    if (typeof options?.root !== "string" || options.root.trim().length === 0) {
      throw new TypeError("root must be a non-empty absolute path.");
    }
    if (!isAbsolute(options.root)) {
      throw new TypeError("root must be an absolute path.");
    }
    const root = resolve(options.root);
    const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    if (!Number.isInteger(maxMessages) || maxMessages < 0 || maxMessages > DEFAULT_MAX_MESSAGES) {
      throw new TypeError(`maxMessages must be an integer between 0 and ${DEFAULT_MAX_MESSAGES}.`);
    }
    const maxStoreBytes = normalizeNonNegativeInteger(
      options.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES,
      "maxStoreBytes",
    );
    const maxStagedBytes = normalizeNonNegativeInteger(
      options.maxStagedBytes ?? maxStoreBytes,
      "maxStagedBytes",
    );
    const maxConversations = normalizeNonNegativeInteger(
      options.maxConversations ?? DEFAULT_MAX_CONVERSATIONS,
      "maxConversations",
    );
    const maxAgeMs = normalizeNonNegativeInteger(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS, "maxAgeMs");
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("now must be a function when present.");
    }
    if (options.retireProviderSession !== undefined && typeof options.retireProviderSession !== "function") {
      throw new TypeError("retireProviderSession must be a function when present.");
    }
    this.root = root;
    this.maxMessages = maxMessages;
    this.maxStoreBytes = maxStoreBytes;
    this.maxStagedBytes = maxStagedBytes;
    this.maxConversations = maxConversations;
    this.maxAgeMs = maxAgeMs;
    this.now = options.now ?? Date.now;
    this.retireProviderSession = options.retireProviderSession;
    this.providerSessionRetirement = options.retireProviderSession === undefined ? undefined : "fail-closed";
  }

  async load(conversationId: string): Promise<readonly HistoryMessage[]> {
    const normalizedId = normalizeConversationId(conversationId);
    const rootIdentity = await this.ensureRoot();
    const record = await this.readRecord(normalizedId, rootIdentity);
    const retained = this.maxMessages === 0 ? [] : record.messages.slice(-this.maxMessages);
    return retained.map(cloneMessage);
  }

  async append(conversationId: string, messages: readonly HistoryMessage[]): Promise<void> {
    const prepared = await this.prepareAppend(conversationId, messages);
    try {
      await prepared.commit();
    } catch (error) {
      await prepared.abort().catch(() => undefined);
      throw error;
    }
  }

  async reset(conversationId: string): Promise<void> {
    const normalizedId = normalizeConversationId(conversationId);
    const held = await this.acquireConversation(normalizedId);
    const rootIdentity = held.rootIdentity;
    let prepared: PreparedHistoryAppend;
    try {
      const existing = await this.readRecord(normalizedId, rootIdentity);
      const retirementFence = await this.prepareProviderRetirement(existing, rootIdentity);
      prepared = await this.prepareRecord({
        version: STORE_VERSION,
        conversationId: normalizedId,
        messages: [],
        providerSession: { epoch: createProviderSessionEpoch(), revision: 0 },
      }, held, rootIdentity, undefined, retirementFence);
    } catch (error) {
      await this.releaseConversation(held, rootIdentity).catch(() => undefined);
      throw error;
    }
    try {
      await prepared.commit();
    } catch (error) {
      await prepared.abort().catch(() => undefined);
      throw error;
    }
  }

  async prepareAppend(
    conversationId: string,
    messages: readonly HistoryMessage[],
  ): Promise<PreparedHistoryAppend> {
    const normalizedId = normalizeConversationId(conversationId);
    const admitted = validateAppendMessages(messages);
    const held = await this.acquireConversation(normalizedId);
    const rootIdentity = held.rootIdentity;
    try {
      const existing = await this.readRecord(normalizedId, rootIdentity);
      const retirementFence = await this.prepareProviderRetirement(existing, rootIdentity);
      const combined = [...existing.messages, ...admitted];
      const retained = this.maxMessages === 0 ? [] : combined.slice(-this.maxMessages);
      const record: HistoryFileV2 = {
        version: STORE_VERSION,
        conversationId: normalizedId,
        messages: retained,
        // Host-only history is not present in a provider transcript. Rotate on
        // every ordinary append so no old provider cache can be resumed.
        providerSession: { epoch: createProviderSessionEpoch(), revision: 0 },
      };
      return await this.prepareRecord(record, held, rootIdentity, undefined, retirementFence);
    } catch (error) {
      await this.releaseConversation(held, rootIdentity).catch(() => undefined);
      throw error;
    }
  }

  async beginProviderSessionTurn(
    conversationId: string,
    runId: string,
  ): Promise<ConversationHistoryProviderSessionTurn> {
    const normalizedId = normalizeConversationId(conversationId);
    const normalizedRunId = normalizeRunId(runId);
    const held = await this.acquireConversation(normalizedId);
    const rootIdentity = held.rootIdentity;
    let turnSettled = false;
    let prepared: PreparedHistoryAppend | undefined;
    let turnOperation = Promise.resolve();
    const serializeTurn = <T>(action: () => Promise<T>): Promise<T> => {
      const current = turnOperation.then(action, action);
      turnOperation = current.then(() => undefined, () => undefined);
      return current;
    };
    try {
      const existing = await this.readRecord(normalizedId, rootIdentity);
      const existingProvider = existing.sourceVersion === STORE_VERSION ? existing.providerSession : undefined;
      const conversationKey = historyKey(normalizedId);
      const locksIdentity = await this.ensureLocksRoot();
      let fence: DirtyFence;
      let epoch: string;
      let revision: number;
      const releaseRoot = await this.acquireRootTransaction(rootIdentity);
      try {
        const existingFence = await this.findDirtyFence(conversationKey, locksIdentity);
        const reusable = this.maxMessages > 0
          && existingFence === undefined
          && existingProvider !== undefined
          && existingProvider.dirtyRunId === undefined
          && existingProvider.revision !== undefined
          && existingProvider.revision < Number.MAX_SAFE_INTEGER;
        if (!reusable) {
          await this.retireProviderSessionIds([
            ...(existingProvider === undefined
              ? []
              : [deriveProviderSessionId(normalizedId, existingProvider.epoch)]),
            ...(existingFence === undefined
              ? []
              : [existingFence.providerSessionId ?? deriveProviderSessionId(normalizedId, existingFence.epoch)]),
          ]);
        }
        epoch = reusable ? existingProvider.epoch : createProviderSessionEpoch();
        revision = reusable ? existingProvider.revision as number : 0;
        const providerSessionId = deriveProviderSessionId(normalizedId, epoch);
        const projectedCleanRecord: HistoryFileV2 = {
          version: STORE_VERSION,
          conversationId: normalizedId,
          messages: this.maxMessages === 0 ? [] : existing.messages.slice(-this.maxMessages),
          providerSession: { epoch, revision: revision + 1 },
        };
        await this.validateRetentionReservation(rootIdentity, [this.projectRecord(projectedCleanRecord)]);
        await this.reserveDirtyFenceCapacity(conversationKey, rootIdentity, locksIdentity);
        fence = await this.publishDirtyFence({
          conversationKey,
          epoch,
          providerSessionId,
          revision,
          runIdDigest: digestRunId(normalizedRunId),
        }, locksIdentity);
      } finally {
        await releaseRoot();
      }
      const turnBaseRecord: HistoryFileV2 = {
        version: STORE_VERSION,
        conversationId: normalizedId,
        messages: existing.messages,
        providerSession: { epoch, revision },
      };
      const providerSessionId = deriveProviderSessionId(normalizedId, epoch);

      return {
        providerSessionId,
        providerSessionRevision: revision,
        prepareCommit: async (
          messages: readonly HistoryMessage[],
          options: ProviderSessionTurnCommitOptions,
        ): Promise<PreparedHistoryAppend> => await serializeTurn(async () => {
          if (turnSettled) throw new Error("Provider session turn is already settled.");
          if (prepared !== undefined) throw new Error("Provider session turn already has a prepared commit.");
          if (!isRecord(options) || typeof options.providerSessionSynced !== "boolean") {
            throw new TypeError("providerSessionSynced must be a boolean.");
          }
          const admitted = validateAppendMessages(messages);
          if (!options.providerSessionSynced) {
            // The harness normally invalidates a failed/unsynced live handle
            // first. Retire by exact durable id as a second fail-closed layer:
            // a cold/unknown registry entry must not strand its JSONL.
            await this.retireProviderSessionIds([providerSessionId]);
          }
          const combined = [...turnBaseRecord.messages, ...admitted];
          const retained = this.maxMessages === 0 ? [] : combined.slice(-this.maxMessages);
          const cleanRecord: HistoryFileV2 = {
            version: STORE_VERSION,
            conversationId: normalizedId,
            messages: retained,
            providerSession: {
              epoch: options.providerSessionSynced ? epoch : createProviderSessionEpoch(),
              revision: options.providerSessionSynced ? revision + 1 : 0,
            },
          };
          prepared = await this.prepareRecord(cleanRecord, held, rootIdentity, () => {
            turnSettled = true;
          }, fence);
          return prepared;
        }),
        abort: async (): Promise<void> => await serializeTurn(async () => {
          if (turnSettled) return;
          if (prepared !== undefined) {
            await prepared.abort();
            turnSettled = true;
            return;
          }
          await this.releaseConversation(held, rootIdentity);
          turnSettled = true;
        }),
      };
    } catch (error) {
      await this.releaseConversation(held, rootIdentity).catch(() => undefined);
      throw error;
    }
  }

  async stats(): Promise<DurableHistoryStoreStats> {
    const rootIdentity = await this.ensureRoot();
    const releaseRoot = await this.acquireRootTransaction(rootIdentity);
    try {
      const entries = await this.scanCommittedEntries(rootIdentity, false);
      const active = await this.scanActiveMarkers(true);
      const maintenance = PROCESS_POST_COMMIT_FAILURES.get(this.root);
      return {
        conversations: entries.length,
        bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
        activePreparedAppends: active.length,
        postCommitMaintenanceFailures: maintenance?.count ?? 0,
        ...(maintenance?.lastError === undefined
          ? {}
          : { lastPostCommitMaintenanceError: maintenance.lastError }),
        limits: {
          maxMessages: this.maxMessages,
          maxStoreBytes: this.maxStoreBytes,
          maxStagedBytes: this.maxStagedBytes,
          maxConversations: this.maxConversations,
          maxAgeMs: this.maxAgeMs,
        },
      };
    } finally {
      await releaseRoot();
    }
  }

  private async prepareRecord(
    record: HistoryFileV2,
    held: HeldConversation,
    rootIdentity: DirectoryIdentity,
    onSettled?: () => void,
    dirtyFence?: DirtyFence,
  ): Promise<PreparedHistoryAppend> {
    const projected = this.projectRecord(record);
    const releaseRoot = await this.acquireRootTransaction(rootIdentity);
    let stage: ActiveStage | undefined;
    try {
      await this.validateStagingReservation(rootIdentity, projected.bytes);
      // Write while the root transaction is held so another process cannot
      // pass the same staged-byte reservation before this temp becomes visible.
      stage = await this.writeStage(record, rootIdentity);
      await this.validateRetentionReservation(rootIdentity, [stage]);
      return this.createPreparedAppend(stage, rootIdentity, held, onSettled, dirtyFence);
    } catch (error) {
      if (stage !== undefined) {
        await rm(stage.temporaryPath, { force: true }).catch(() => undefined);
        await fsyncDirectory(this.root, rootIdentity).catch(() => undefined);
      }
      throw error;
    } finally {
      await releaseRoot();
    }
  }

  private projectRecord(record: HistoryFileV2): ActiveStage {
    const conversationKey = historyKey(record.conversationId);
    return {
      conversationKey,
      destinationName: `${conversationKey}${HISTORY_FILE_SUFFIX}`,
      temporaryPath: "",
      bytes: serializeHistoryFile(record).byteLength,
    };
  }

  private async findDirtyFence(
    conversationKey: string,
    locksIdentity: DirectoryIdentity,
  ): Promise<DirtyFence | undefined> {
    return (await this.scanDirtyFences(locksIdentity, true))
      .find((fence) => fence.conversationKey === conversationKey);
  }

  private async reserveDirtyFenceCapacity(
    conversationKey: string,
    rootIdentity: DirectoryIdentity,
    locksIdentity: DirectoryIdentity,
  ): Promise<void> {
    let fences = await this.scanDirtyFences(locksIdentity, true);
    const hasConversationFence = fences.some((fence) => fence.conversationKey === conversationKey);
    const targetCount = fences.length + (hasConversationFence ? 0 : 1);
    if (targetCount <= this.maxConversations) return;

    const committedKeys = new Set(
      (await this.scanCommittedEntries(rootIdentity, true))
        .map((entry) => entry.name.slice(0, -HISTORY_FILE_SUFFIX.length)),
    );
    const activeKeys = new Set((await this.scanActiveMarkers(true)).map((marker) => marker.conversationKey));
    const reclaimable = fences
      .filter((fence) => (
        fence.conversationKey !== conversationKey
        && !committedKeys.has(fence.conversationKey)
        && !activeKeys.has(fence.conversationKey)
      ))
      .sort((left, right) => (left.mtimeMs ?? 0) - (right.mtimeMs ?? 0)
        || left.conversationKey.localeCompare(right.conversationKey));
    let remaining = targetCount;
    let removed = false;
    for (const fence of reclaimable) {
      if (remaining <= this.maxConversations) break;
      if (this.retireProviderSession !== undefined) {
        // V2 fences carry the exact provider id. A legacy fence without one is
        // not reclaimable safely because its conversation id is intentionally
        // one-way hashed in the filename.
        if (fence.providerSessionId === undefined) continue;
        await this.retireProviderSessionIds([fence.providerSessionId]);
      }
      await rm(fence.path);
      removed = true;
      remaining -= 1;
    }
    if (removed) await fsyncDirectory(join(this.root, LOCKS_DIRECTORY), locksIdentity);
    if (remaining > this.maxConversations) {
      throw new Error(`Provider-session dirty fences exceed the ${this.maxConversations}-conversation quota.`);
    }
    fences = await this.scanDirtyFences(locksIdentity, false);
    if (fences.length + (fences.some((fence) => fence.conversationKey === conversationKey) ? 0 : 1)
      > this.maxConversations) {
      throw new Error(`Provider-session dirty fences exceed the ${this.maxConversations}-conversation quota.`);
    }
  }

  private async publishDirtyFence(
    value: Omit<DirtyFence, "path" | "mtimeMs">,
    locksIdentity: DirectoryIdentity,
  ): Promise<DirtyFence> {
    const locksRoot = join(this.root, LOCKS_DIRECTORY);
    const destination = join(locksRoot, `${value.conversationKey}.dirty.json`);
    const temporary = join(
      locksRoot,
      `.${value.conversationKey}.${process.pid}.${randomBytes(12).toString("hex")}.dirty.tmp`,
    );
    const bytes = serializeDirtyFence(value);
    let published = false;
    try {
      await writePreparedFile(temporary, bytes, locksRoot, locksIdentity);
      await rename(temporary, destination);
      published = true;
      await fsyncDirectory(locksRoot, locksIdentity);
      const info = await lstat(destination);
      assertSecureHistoryFile(info, destination);
      if (info.size !== bytes.byteLength) {
        throw new Error(`History dirty fence ${destination} was not written completely.`);
      }
      return { ...value, path: destination, mtimeMs: info.mtimeMs };
    } finally {
      if (!published) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async writeStage(record: HistoryFileV2, rootIdentity: DirectoryIdentity): Promise<ActiveStage> {
    const conversationKey = historyKey(record.conversationId);
    const bytes = serializeHistoryFile(record);
    const temporaryPath = join(
      this.root,
      `.${conversationKey}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
    );
    try {
      await writePreparedFile(temporaryPath, bytes, this.root, rootIdentity);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return {
      conversationKey,
      destinationName: `${conversationKey}${HISTORY_FILE_SUFFIX}`,
      temporaryPath,
      bytes: bytes.byteLength,
    };
  }

  private createPreparedAppend(
    stage: ActiveStage,
    rootIdentity: DirectoryIdentity,
    held: HeldConversation,
    onSettled?: () => void,
    dirtyFence?: DirtyFence,
  ): PreparedHistoryAppend {
    let state: "prepared" | "committed" | "aborted" = "prepared";
    let operation = Promise.resolve();
    const serialize = (action: () => Promise<void>): Promise<void> => {
      const current = operation.then(action, action);
      operation = current.catch(() => undefined);
      return current;
    };

    return {
      commit: async (): Promise<void> => await serialize(async () => {
        if (state === "committed") return;
        if (state === "aborted") throw new Error("Cannot commit an aborted history append.");
        let published = false;
        const releaseRoot = await this.acquireRootTransaction(rootIdentity);
        try {
          await assertDirectoryIdentity(this.root, rootIdentity);
          // Revalidate while holding the root transaction queue. Preparation
          // never evicts committed history, and another conversation may have
          // committed since this stage reserved its projected capacity.
          await this.validateRetentionReservation(rootIdentity, [stage]);
          await rename(stage.temporaryPath, join(this.root, stage.destinationName));
          published = true;
          state = "committed";

          // Rename is the semantic commit. Directory durability and defensive
          // verification happen afterwards, so their failure is observable in
          // stats but can never make callers retry an already-published turn.
          try {
            await fsyncDirectory(this.root, rootIdentity);
            // The canonical replacement is clean and directory-durable before
            // the crash fence is removed. If cleanup cannot be made durable,
            // restore the visible fence and record a diagnostic so the next
            // turn rotates instead of trusting ambiguous provider state.
            if (dirtyFence !== undefined) await this.removeDirtyFenceAfterCommit(dirtyFence);
            const committed = await lstat(join(this.root, stage.destinationName));
            assertSecureHistoryFile(committed, join(this.root, stage.destinationName));
            // Only prune older committed records after the replacement itself
            // has been durably published. Retention is maintenance, never part
            // of the caller-visible success boundary.
            await this.applyRetention(rootIdentity, stage);
            await assertDirectoryIdentity(this.root, rootIdentity);
          } catch (error) {
            recordPostCommitMaintenanceFailure(this.root, error);
          }
        } catch (error) {
          if (!published) throw error;
          recordPostCommitMaintenanceFailure(this.root, error);
        } finally {
          if (published) {
            await this.removeActiveMarker(held.marker).catch((error) => {
              recordPostCommitMaintenanceFailure(this.root, error);
            });
          }
          await releaseRoot();
          if (published) {
            await held.release();
            onSettled?.();
          }
        }
      }),
      abort: async (): Promise<void> => await serialize(async () => {
        if (state === "committed" || state === "aborted") return;
        const releaseRoot = await this.acquireRootTransaction(rootIdentity);
        state = "aborted";
        const cleanupErrors: unknown[] = [];
        try {
          try {
            await rm(stage.temporaryPath, { force: true });
            await fsyncDirectory(this.root, rootIdentity);
          } catch (error) {
            cleanupErrors.push(error);
          }
          // Marker removal is independent from stage removal. In particular,
          // a transient stage-unlink failure must not leave a live-PID marker
          // consuming retention and staging capacity until daemon restart.
          try {
            await this.removeActiveMarker(held.marker);
          } catch (error) {
            cleanupErrors.push(error);
          }
        } finally {
          try {
            await releaseRoot();
          } catch (error) {
            cleanupErrors.push(error);
          }
          try {
            await held.release();
          } catch (error) {
            cleanupErrors.push(error);
          }
          try {
            onSettled?.();
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (cleanupErrors.length === 1) throw cleanupErrors[0];
        if (cleanupErrors.length > 1) {
          throw new AggregateError(cleanupErrors, "Prepared history abort cleanup failed.");
        }
      }),
    };
  }

  private async removeDirtyFenceAfterCommit(fence: DirtyFence): Promise<void> {
    const locksIdentity = await this.ensureLocksRoot();
    const locksRoot = join(this.root, LOCKS_DIRECTORY);
    try {
      const current = await readDirtyFence(fence.path);
      if (
        current.conversationKey !== fence.conversationKey
        || current.epoch !== fence.epoch
        || current.providerSessionId !== fence.providerSessionId
        || current.revision !== fence.revision
        || current.runIdDigest !== fence.runIdDigest
      ) {
        throw new Error(`History dirty fence ${fence.path} changed before clean commit.`);
      }
      await rm(fence.path);
      await fsyncDirectory(locksRoot, locksIdentity);
    } catch (error) {
      // A failed unlink leaves the original fence. If unlink succeeded but its
      // directory fsync failed, atomically restore an equivalent visible fence
      // before returning committed success. A restoration failure is folded
      // into the diagnostic; the canonical record itself remains committed.
      try {
        await lstat(fence.path);
      } catch (statError) {
        if (isErrno(statError, "ENOENT")) {
          await this.publishDirtyFence({
            conversationKey: fence.conversationKey,
            epoch: fence.epoch,
            ...(fence.providerSessionId === undefined ? {} : { providerSessionId: fence.providerSessionId }),
            revision: fence.revision,
            runIdDigest: fence.runIdDigest,
          }, locksIdentity);
        } else {
          throw new AggregateError([error, statError], "Dirty-fence cleanup failed closed.");
        }
      }
      throw error;
    }
  }

  private async validateRetentionReservation(
    rootIdentity: DirectoryIdentity,
    projectedStages: readonly ActiveStage[],
  ): Promise<void> {
    const plan = await this.retentionPlan(rootIdentity, projectedStages);
    if (plan.minimumCount > this.maxConversations) {
      throw new Error(`Conversation history exceeds its ${this.maxConversations}-conversation quota.`);
    }
    if (plan.minimumBytes > this.maxStoreBytes) {
      throw new Error(`Conversation history exceeds its ${this.maxStoreBytes}-byte aggregate quota.`);
    }
  }

  private async validateStagingReservation(
    rootIdentity: DirectoryIdentity,
    plannedBytes: number,
  ): Promise<void> {
    const stagedBytes = await this.scanStagedBytes(rootIdentity);
    if (stagedBytes + plannedBytes > this.maxStagedBytes) {
      throw new Error(`Prepared conversation history exceeds its ${this.maxStagedBytes}-byte staging quota.`);
    }
  }

  private async applyRetention(rootIdentity: DirectoryIdentity, committedStage: ActiveStage): Promise<void> {
    // Other prepared appends protect any committed destination they will
    // replace, but their unpublished bytes/count are not charged to this
    // commit. Each stage revalidates and prunes for itself when it publishes.
    const plan = await this.retentionPlan(rootIdentity, [committedStage]);
    if (plan.minimumCount > this.maxConversations || plan.minimumBytes > this.maxStoreBytes) {
      throw new Error("Conversation history retention reservation changed after publication.");
    }
    let projectedBytes = plan.projectedBytes;
    let projectedCount = plan.projectedCount;
    const now = this.now();
    let removedAny = false;
    for (const entry of plan.candidates) {
      const expired = now - entry.mtimeMs > this.maxAgeMs;
      const overCount = projectedCount > this.maxConversations;
      const overBytes = projectedBytes > this.maxStoreBytes;
      if (!expired && !overCount && !overBytes) continue;
      const record = await this.readCommittedEntryRecord(entry, rootIdentity);
      const retirementFence = this.retireProviderSession === undefined
        ? undefined
        : await this.ensureRetirementFence(record, rootIdentity, await this.ensureLocksRoot());
      await this.retireProviderSessionIds(this.providerSessionIdsForRetirement(record, retirementFence));
      await rm(entry.path);
      await fsyncDirectory(this.root, rootIdentity);
      if (retirementFence !== undefined) await this.removeDirtyFenceAfterCommit(retirementFence);
      removedAny = true;
      projectedCount -= 1;
      projectedBytes -= entry.size;
    }
    if (removedAny) await assertDirectoryIdentity(this.root, rootIdentity);
  }

  private async retentionPlan(
    rootIdentity: DirectoryIdentity,
    projectedStages: readonly ActiveStage[],
  ): Promise<{
    readonly projectedBytes: number;
    readonly projectedCount: number;
    readonly minimumBytes: number;
    readonly minimumCount: number;
    readonly candidates: readonly CommittedEntry[];
  }> {
    const entries = await this.scanCommittedEntries(rootIdentity, true);
    const protectedNames = new Set(
      (await this.scanActiveMarkers(true)).map((marker) => `${marker.conversationKey}${HISTORY_FILE_SUFFIX}`),
    );
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    let projectedBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    let projectedCount = entries.length;
    for (const active of projectedStages) {
      const replaced = byName.get(active.destinationName);
      if (replaced === undefined) projectedCount += 1;
      else projectedBytes -= replaced.size;
      projectedBytes += active.bytes;
    }

    const candidates = entries
      .filter((entry) => !protectedNames.has(entry.name))
      .sort(compareRetentionEntries);
    const minimumBytes = projectedBytes - candidates.reduce((sum, entry) => sum + entry.size, 0);
    const minimumCount = projectedCount - candidates.length;
    // Establish feasibility before deleting anything. An append that cannot fit
    // even after every eligible record is removed must not destroy older
    // history merely to discover that fact.
    return { projectedBytes, projectedCount, minimumBytes, minimumCount, candidates };
  }

  private async scanStagedBytes(rootIdentity: DirectoryIdentity): Promise<number> {
    await assertDirectoryIdentity(this.root, rootIdentity);
    const activeConversationKeys = new Set(
      (await this.scanActiveMarkers(true)).map((marker) => marker.conversationKey),
    );
    let bytes = 0;
    let removed = false;
    for (const name of (await readdir(this.root)).sort()) {
      const match = TEMP_FILE_PATTERN.exec(name);
      if (match === null) continue;
      const path = join(this.root, name);
      const info = await lstat(path);
      assertSecureHistoryFile(info, path);
      if (info.size > MAX_STORE_FILE_BYTES) {
        throw new Error(`History temporary ${path} exceeds the ${MAX_STORE_FILE_BYTES}-byte limit.`);
      }
      // Every legitimate stage is created only after its active marker and
      // both are mutated under the root transaction. A stage without a marker
      // is therefore abandoned even when its filename PID is still live or
      // has been reused by a later process.
      if (!activeConversationKeys.has(match[1] as string)) {
        await rm(path);
        removed = true;
        continue;
      }
      bytes += info.size;
    }
    if (removed) await fsyncDirectory(this.root, rootIdentity);
    await assertDirectoryIdentity(this.root, rootIdentity);
    return bytes;
  }

  private async scanCommittedEntries(
    rootIdentity: DirectoryIdentity,
    cleanStaleTemps: boolean,
  ): Promise<CommittedEntry[]> {
    await assertDirectoryIdentity(this.root, rootIdentity);
    const names = (await readdir(this.root)).sort();
    const activeConversationKeys = new Set((await this.scanActiveMarkers(true)).map((marker) => marker.conversationKey));
    const entries: CommittedEntry[] = [];
    let removedTemp = false;
    for (const name of names) {
      const path = join(this.root, name);
      if (name === LOCKS_DIRECTORY) {
        const info = await lstat(path);
        assertSecureHistoryDirectory(info, path);
        continue;
      }
      if (HISTORY_FILE_PATTERN.test(name)) {
        const info = await lstat(path);
        assertSecureHistoryFile(info, path);
        if (info.size > MAX_STORE_FILE_BYTES) {
          throw new Error(`History file ${path} exceeds the ${MAX_STORE_FILE_BYTES}-byte limit.`);
        }
        entries.push({ name, path, size: info.size, mtimeMs: info.mtimeMs });
        continue;
      }
      const temporaryMatch = TEMP_FILE_PATTERN.exec(name);
      if (temporaryMatch !== null) {
        const info = await lstat(path);
        assertSecureHistoryFile(info, path);
        if (
          cleanStaleTemps
          && !activeConversationKeys.has(temporaryMatch[1] as string)
        ) {
          await rm(path);
          removedTemp = true;
        }
        continue;
      }
      throw new Error(`History root ${this.root} contains unsupported entry ${name}.`);
    }
    if (removedTemp) await fsyncDirectory(this.root, rootIdentity);
    await assertDirectoryIdentity(this.root, rootIdentity);
    return entries;
  }

  private async ensureRoot(): Promise<DirectoryIdentity> {
    this.rootReady ??= createAndVerifyRoot(this.root).catch((error) => {
      this.rootReady = undefined;
      throw error;
    });
    return await this.rootReady;
  }

  private async ensureLocksRoot(): Promise<DirectoryIdentity> {
    const locksRoot = join(this.root, LOCKS_DIRECTORY);
    this.locksRootReady ??= createAndVerifyLocksRoot(locksRoot).catch((error) => {
      this.locksRootReady = undefined;
      throw error;
    });
    return await this.locksRootReady;
  }

  private async acquireRootTransaction(rootIdentity: DirectoryIdentity): Promise<() => Promise<void>> {
    const releaseProcess = await acquireQueue(PROCESS_ROOT_QUEUES, this.root);
    try {
      await assertDirectoryIdentity(this.root, rootIdentity);
      const locksIdentity = await this.ensureLocksRoot();
      const lock = await acquireCrossProcessLock(join(this.root, LOCKS_DIRECTORY, ROOT_LOCK_FILE), locksIdentity);
      let released = false;
      return async (): Promise<void> => {
        if (released) return;
        released = true;
        try {
          await lock.release();
        } finally {
          releaseProcess();
        }
      };
    } catch (error) {
      releaseProcess();
      throw error;
    }
  }

  private async acquireConversation(
    conversationId: string,
  ): Promise<HeldConversation> {
    const conversationKey = historyKey(conversationId);
    const releaseProcess = await acquireQueue(PROCESS_APPEND_QUEUES, this.queueKey(conversationId));
    let shardLock: CrossProcessLock | undefined;
    let legacyLock: CrossProcessLock | undefined;
    let marker: ActiveMarker | undefined;
    let rootIdentity: DirectoryIdentity | undefined;
    try {
      rootIdentity = await this.ensureRoot();
      const locksIdentity = await this.ensureLocksRoot();
      shardLock = await acquireCrossProcessLock(
        join(this.root, LOCKS_DIRECTORY, conversationShardLockName(conversationKey)),
        locksIdentity,
      );
      // Never unlink old per-conversation lock files: another process may have
      // the old inode open. Acquiring a legacy lock when it already exists
      // safely serializes upgraded stores with in-flight/pre-upgrade owners,
      // while every new conversation uses only the fixed shard table.
      legacyLock = await acquireExistingCrossProcessLock(
        join(this.root, LOCKS_DIRECTORY, `${conversationKey}.sqlite`),
        locksIdentity,
      );
      const releaseRoot = await this.acquireRootTransaction(rootIdentity);
      try {
        await this.retireInactiveDirtyFences(rootIdentity, locksIdentity, conversationKey);
        marker = await this.createActiveMarker(conversationKey, locksIdentity);
      } finally {
        await releaseRoot();
      }
      let released = false;
      return {
        marker,
        rootIdentity,
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          try {
            await legacyLock?.release();
          } finally {
            try {
              await shardLock?.release();
            } finally {
              releaseProcess();
            }
          }
        },
      };
    } catch (error) {
      if (marker !== undefined && rootIdentity !== undefined) {
        const releaseRoot = await this.acquireRootTransaction(rootIdentity).catch(() => undefined);
        if (releaseRoot !== undefined) {
          try {
            await this.removeActiveMarker(marker).catch(() => undefined);
          } finally {
            await releaseRoot();
          }
        }
      }
      await legacyLock?.release().catch(() => undefined);
      await shardLock?.release().catch(() => undefined);
      releaseProcess();
      throw error;
    }
  }

  private async releaseConversation(held: HeldConversation, rootIdentity: DirectoryIdentity): Promise<void> {
    const releaseRoot = await this.acquireRootTransaction(rootIdentity);
    try {
      await this.removeActiveMarker(held.marker);
    } finally {
      await releaseRoot();
      await held.release();
    }
  }

  private async createActiveMarker(
    conversationKey: string,
    locksIdentity: DirectoryIdentity,
  ): Promise<ActiveMarker> {
    const token = randomBytes(16).toString("hex");
    const marker: ActiveMarker = {
      path: join(this.root, LOCKS_DIRECTORY, `${conversationKey}.${process.pid}.${token}.active`),
      conversationKey,
      pid: process.pid,
      token,
    };
    const body = Buffer.from(`${JSON.stringify({
      version: 1,
      conversationKey,
      pid: process.pid,
      token,
    })}\n`, "utf8");
    let handle;
    let complete = false;
    try {
      handle = await open(
        marker.path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
        0o600,
      );
      await handle.writeFile(body);
      await handle.chmod(0o600);
      await handle.sync();
      const info = await handle.stat();
      assertSecureHistoryFile(info, marker.path);
      if (info.size !== body.byteLength) throw new Error(`History active marker ${marker.path} was not written completely.`);
      complete = true;
    } finally {
      await handle?.close().catch(() => undefined);
      if (!complete) await rm(marker.path, { force: true }).catch(() => undefined);
    }
    try {
      await fsyncDirectory(join(this.root, LOCKS_DIRECTORY), locksIdentity);
      return marker;
    } catch (error) {
      await rm(marker.path, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async removeActiveMarker(marker: ActiveMarker): Promise<void> {
    const locksIdentity = await this.ensureLocksRoot();
    await rm(marker.path, { force: true });
    await fsyncDirectory(join(this.root, LOCKS_DIRECTORY), locksIdentity);
  }

  private async scanActiveMarkers(cleanDead: boolean): Promise<readonly ActiveMarker[]> {
    const locksRoot = join(this.root, LOCKS_DIRECTORY);
    const locksIdentity = await this.ensureLocksRoot();
    await assertDirectoryIdentity(locksRoot, locksIdentity);
    const markers: ActiveMarker[] = [];
    let removed = false;
    for (const name of (await readdir(locksRoot)).sort()) {
      if (
        name === ROOT_LOCK_FILE
        || LEGACY_CONVERSATION_LOCK_PATTERN.test(name)
        || isConversationShardLockName(name)
      ) {
        const path = join(locksRoot, name);
        assertSecureHistoryFile(await lstat(path), path);
        continue;
      }
      if (DIRTY_FENCE_PATTERN.test(name) || DIRTY_FENCE_TEMP_PATTERN.test(name)) {
        const path = join(locksRoot, name);
        const info = await lstat(path);
        assertSecureHistoryFile(info, path);
        if (info.size > MAX_DIRTY_FENCE_BYTES) {
          throw new Error(`History dirty fence ${path} is too large.`);
        }
        continue;
      }
      const match = ACTIVE_MARKER_PATTERN.exec(name);
      if (match === null) throw new Error(`History lock root ${locksRoot} contains unsupported entry ${name}.`);
      const path = join(locksRoot, name);
      const info = await lstat(path);
      assertSecureHistoryFile(info, path);
      if (info.size > MAX_ACTIVE_MARKER_BYTES) throw new Error(`History active marker ${path} is too large.`);
      const markerPid = Number.parseInt(match[2] as string, 10);
      // A crashed writer may leave a partial marker. The unique filename is
      // enough to safely reap it once its owner PID is no longer live.
      if (cleanDead && !isProcessAlive(markerPid)) {
        await rm(path);
        removed = true;
        continue;
      }
      const marker = await readActiveMarker(path);
      if (
        marker.conversationKey !== match[1]
        || marker.pid !== markerPid
        || marker.token !== match[3]
      ) {
        throw new Error(`History active marker ${path} does not match its filename.`);
      }
      markers.push(marker);
    }
    if (removed) await fsyncDirectory(locksRoot, locksIdentity);
    return markers;
  }

  private async scanDirtyFences(
    locksIdentity: DirectoryIdentity,
    cleanDeadTemps: boolean,
  ): Promise<readonly DirtyFence[]> {
    const locksRoot = join(this.root, LOCKS_DIRECTORY);
    await assertDirectoryIdentity(locksRoot, locksIdentity);
    const fences: DirtyFence[] = [];
    let removed = false;
    for (const name of (await readdir(locksRoot)).sort()) {
      const path = join(locksRoot, name);
      if (
        name === ROOT_LOCK_FILE
        || LEGACY_CONVERSATION_LOCK_PATTERN.test(name)
        || isConversationShardLockName(name)
        || ACTIVE_MARKER_PATTERN.test(name)
      ) {
        assertSecureHistoryFile(await lstat(path), path);
        continue;
      }
      const fenceMatch = DIRTY_FENCE_PATTERN.exec(name);
      if (fenceMatch !== null) {
        const info = await lstat(path);
        assertSecureHistoryFile(info, path);
        if (info.size > MAX_DIRTY_FENCE_BYTES) {
          throw new Error(`History dirty fence ${path} is too large.`);
        }
        const fence = await readDirtyFence(path);
        if (fence.conversationKey !== fenceMatch[1]) {
          throw new Error(`History dirty fence ${path} does not match its filename.`);
        }
        fences.push({ ...fence, mtimeMs: info.mtimeMs });
        continue;
      }
      const tempMatch = DIRTY_FENCE_TEMP_PATTERN.exec(name);
      if (tempMatch !== null) {
        const info = await lstat(path);
        assertSecureHistoryFile(info, path);
        if (info.size > MAX_DIRTY_FENCE_BYTES) {
          throw new Error(`History dirty fence temporary ${path} is too large.`);
        }
        const ownerPid = Number.parseInt(tempMatch[2] as string, 10);
        if (cleanDeadTemps && !isProcessAlive(ownerPid)) {
          await rm(path);
          removed = true;
        }
        continue;
      }
      throw new Error(`History lock root ${locksRoot} contains unsupported entry ${name}.`);
    }
    if (removed) await fsyncDirectory(locksRoot, locksIdentity);
    return fences;
  }

  private async retireInactiveDirtyFences(
    rootIdentity: DirectoryIdentity,
    locksIdentity: DirectoryIdentity,
    excludedConversationKey: string,
  ): Promise<void> {
    if (this.retireProviderSession === undefined) return;
    const activeKeys = new Set((await this.scanActiveMarkers(true)).map((marker) => marker.conversationKey));
    const fences = await this.scanDirtyFences(locksIdentity, true);
    const committedByName = new Map(
      (await this.scanCommittedEntries(rootIdentity, true)).map((entry) => [entry.name, entry]),
    );
    let removed = false;
    for (const fence of fences) {
      if (
        fence.conversationKey === excludedConversationKey
        || activeKeys.has(fence.conversationKey)
        || fence.providerSessionId === undefined
      ) {
        continue;
      }
      const committedEntry = committedByName.get(`${fence.conversationKey}${HISTORY_FILE_SUFFIX}`);
      const committedRecord = committedEntry === undefined
        ? undefined
        : await this.readCommittedEntryRecord(committedEntry, rootIdentity);
      const canonicalProvesCommit = committedRecord?.sourceVersion === STORE_VERSION
        && committedRecord.providerSession?.epoch === fence.epoch
        && committedRecord.providerSession.dirtyRunId === undefined
        && committedRecord.providerSession.revision === fence.revision + 1;
      // The fence is the crash-recovery journal: durable transcript deletion
      // happens first, then its directory entry is fsynced, and only then may
      // the fence disappear. A crash or error at any earlier point leaves the
      // idempotent journal visible for the next maintenance pass.
      // A canonical epoch at exactly revision+1 proves the history rename won
      // and only fence cleanup crashed; preserve that valid transcript.
      if (!canonicalProvesCommit) {
        await this.retireProviderSessionIds([fence.providerSessionId]);
        if (
          committedEntry !== undefined
          && committedRecord?.sourceVersion === STORE_VERSION
          && committedRecord.providerSession?.epoch === fence.epoch
        ) {
          await this.rotateCommittedProviderEpoch(committedEntry, committedRecord, rootIdentity);
        }
      }
      await rm(fence.path);
      removed = true;
    }
    if (removed) await fsyncDirectory(join(this.root, LOCKS_DIRECTORY), locksIdentity);
  }

  private async readRecord(conversationId: string, rootIdentity: DirectoryIdentity): Promise<LoadedHistoryRecord> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.readRecordOnce(conversationId, rootIdentity);
      } catch (error) {
        if (attempt < 2 && (error instanceof ConcurrentHistoryMutationError || isErrno(error, "ENOENT"))) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("History record could not be read atomically.");
  }

  private async readRecordOnce(conversationId: string, rootIdentity: DirectoryIdentity): Promise<LoadedHistoryRecord> {
    await assertDirectoryIdentity(this.root, rootIdentity);
    const path = this.recordPath(conversationId);
    let before: Stats;
    try {
      before = await lstat(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return { sourceVersion: 0, conversationId, messages: [] };
      }
      throw error;
    }
    assertSecureHistoryFile(before, path);
    if (before.size > MAX_STORE_FILE_BYTES) {
      throw new Error(`History file ${path} exceeds the ${MAX_STORE_FILE_BYTES}-byte limit.`);
    }

    let handle;
    try {
      handle = await open(path, fsConstants.O_RDONLY | noFollowFlag() | (fsConstants.O_NONBLOCK ?? 0));
      const opened = await handle.stat();
      assertSecureHistoryFile(opened, path);
      assertSameIdentity(before, opened, path);
      const bytes = await handle.readFile();
      if (bytes.byteLength > MAX_STORE_FILE_BYTES) {
        throw new Error(`History file ${path} exceeds the ${MAX_STORE_FILE_BYTES}-byte limit.`);
      }
      const after = await handle.stat();
      assertSameIdentity(opened, after, path);
      let record: LoadedHistoryRecord;
      try {
        record = parseHistoryFile(bytes, path);
      } catch (error) {
        if (error instanceof TruncatedHistoryRecordError) {
          // Atomic replacement means our own writes cannot publish a partial
          // record. If the filesystem nevertheless presents stable truncated
          // JSON, fail cold instead of poisoning every future turn. Keep the
          // unreadable file in place so the next locked append replaces it
          // atomically; a fresh provider epoch then prevents stale transcript
          // resume without guessing at data that can no longer be parsed.
          await assertDirectoryIdentity(this.root, rootIdentity);
          return { sourceVersion: 0, conversationId, messages: [] };
        }
        throw error;
      }
      if (record.conversationId !== conversationId) {
        throw new Error(`History file ${path} does not belong to the requested conversation.`);
      }
      await assertDirectoryIdentity(this.root, rootIdentity);
      return record;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async prepareProviderRetirement(
    record: LoadedHistoryRecord,
    rootIdentity: DirectoryIdentity,
  ): Promise<DirtyFence | undefined> {
    if (this.retireProviderSession === undefined) return undefined;
    const locksIdentity = await this.ensureLocksRoot();
    const releaseRoot = await this.acquireRootTransaction(rootIdentity);
    let fence: DirtyFence | undefined;
    try {
      fence = await this.ensureRetirementFence(record, rootIdentity, locksIdentity);
    } finally {
      await releaseRoot();
    }
    await this.retireProviderSessionIds(this.providerSessionIdsForRetirement(record, fence));
    return fence;
  }

  private async ensureRetirementFence(
    record: LoadedHistoryRecord,
    rootIdentity: DirectoryIdentity,
    locksIdentity: DirectoryIdentity,
  ): Promise<DirtyFence | undefined> {
    const conversationKey = historyKey(record.conversationId);
    const existing = await this.findDirtyFence(conversationKey, locksIdentity);
    if (existing !== undefined) return existing;
    if (record.sourceVersion !== STORE_VERSION || record.providerSession === undefined) return undefined;
    await this.reserveDirtyFenceCapacity(conversationKey, rootIdentity, locksIdentity);
    const providerSessionId = deriveProviderSessionId(record.conversationId, record.providerSession.epoch);
    return await this.publishDirtyFence({
      conversationKey,
      epoch: record.providerSession.epoch,
      providerSessionId,
      revision: record.providerSession.revision ?? 0,
      runIdDigest: digestRunId(`history-retirement-${randomBytes(16).toString("hex")}`),
    }, locksIdentity);
  }

  private providerSessionIdsForRetirement(
    record: LoadedHistoryRecord,
    fence?: DirtyFence,
  ): readonly string[] {
    return [
      ...(record.sourceVersion !== STORE_VERSION || record.providerSession === undefined
        ? []
        : [deriveProviderSessionId(record.conversationId, record.providerSession.epoch)]),
      ...(fence === undefined
        ? []
        : [fence.providerSessionId ?? deriveProviderSessionId(record.conversationId, fence.epoch)]),
    ];
  }

  private async readCommittedEntryRecord(
    entry: CommittedEntry,
    rootIdentity: DirectoryIdentity,
  ): Promise<LoadedHistoryRecord> {
    await assertDirectoryIdentity(this.root, rootIdentity);
    const before = await lstat(entry.path);
    assertSecureHistoryFile(before, entry.path);
    let handle;
    try {
      handle = await open(entry.path, fsConstants.O_RDONLY | noFollowFlag() | (fsConstants.O_NONBLOCK ?? 0));
      const opened = await handle.stat();
      assertSecureHistoryFile(opened, entry.path);
      assertSameIdentity(before, opened, entry.path);
      const bytes = await handle.readFile();
      if (bytes.byteLength > MAX_STORE_FILE_BYTES) {
        throw new Error(`History file ${entry.path} exceeds the ${MAX_STORE_FILE_BYTES}-byte limit.`);
      }
      const after = await handle.stat();
      assertSameIdentity(opened, after, entry.path);
      const record = parseHistoryFile(bytes, entry.path);
      if (`${historyKey(record.conversationId)}${HISTORY_FILE_SUFFIX}` !== entry.name) {
        throw new Error(`History file ${entry.path} does not match its conversation id.`);
      }
      return record;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async rotateCommittedProviderEpoch(
    entry: CommittedEntry,
    record: LoadedHistoryRecord,
    rootIdentity: DirectoryIdentity,
  ): Promise<void> {
    if (record.sourceVersion !== STORE_VERSION || record.providerSession === undefined) return;
    const rotated: HistoryFileV2 = {
      version: STORE_VERSION,
      conversationId: record.conversationId,
      messages: record.messages,
      providerSession: { epoch: createProviderSessionEpoch(), revision: 0 },
    };
    const stage = await this.writeStage(rotated, rootIdentity);
    let published = false;
    try {
      await rename(stage.temporaryPath, entry.path);
      published = true;
      await fsyncDirectory(this.root, rootIdentity);
    } finally {
      if (!published) await rm(stage.temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async retireProviderSessionIds(providerSessionIds: readonly string[]): Promise<void> {
    if (this.retireProviderSession === undefined) return;
    for (const providerSessionId of new Set(providerSessionIds)) {
      if (!/^[a-f0-9]{64}$/u.test(providerSessionId)) {
        throw new Error("History produced an invalid provider session id for retirement.");
      }
      await this.retireProviderSession(providerSessionId);
    }
  }

  private recordPath(conversationId: string): string {
    return join(this.root, `${historyKey(conversationId)}${HISTORY_FILE_SUFFIX}`);
  }

  private queueKey(conversationId: string): string {
    return `${this.root}\0${historyKey(conversationId)}`;
  }
}

export function createDurableHistoryStore(options: DurableHistoryStoreOptions): DurableConversationHistoryStore {
  return new DurableConversationHistoryStore(options);
}

function normalizeNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

async function acquireQueue(queues: Map<string, Promise<void>>, key: string): Promise<() => void> {
  const prior = queues.get(key) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    releaseGate = resolveGate;
  });
  const tail = prior.catch(() => undefined).then(async () => await gate);
  queues.set(key, tail);
  await prior.catch(() => undefined);
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    releaseGate();
    if (queues.get(key) === tail) queues.delete(key);
  };
}

function recordPostCommitMaintenanceFailure(root: string, error: unknown): void {
  const previous = PROCESS_POST_COMMIT_FAILURES.get(root);
  PROCESS_POST_COMMIT_FAILURES.set(root, {
    count: (previous?.count ?? 0) + 1,
    lastError: error instanceof Error ? error.message : String(error),
  });
}

function compareRetentionEntries(left: CommittedEntry, right: CommittedEntry): number {
  return left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name);
}

function normalizeConversationId(conversationId: string): string {
  if (typeof conversationId !== "string") throw new TypeError("conversationId must be a non-empty string.");
  const normalized = conversationId.trim();
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes === 0) throw new TypeError("conversationId must be a non-empty string.");
  if (bytes > MAX_CONVERSATION_ID_BYTES) {
    throw new TypeError(`conversationId must not exceed ${MAX_CONVERSATION_ID_BYTES} UTF-8 bytes.`);
  }
  if (normalized.includes("\0")) throw new TypeError("conversationId must not contain NUL bytes.");
  return normalized;
}

function normalizeRunId(runId: string): string {
  if (typeof runId !== "string") throw new TypeError("runId must be a non-empty string.");
  const normalized = runId.trim();
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes === 0) throw new TypeError("runId must be a non-empty string.");
  if (bytes > MAX_RUN_ID_BYTES) throw new TypeError(`runId must not exceed ${MAX_RUN_ID_BYTES} UTF-8 bytes.`);
  if (normalized.includes("\0")) throw new TypeError("runId must not contain NUL bytes.");
  return normalized;
}

function historyKey(conversationId: string): string {
  return createHash("sha256").update("mono-agent-history-v1\0").update(conversationId, "utf8").digest("hex");
}

function conversationShardLockName(conversationKey: string): string {
  const shard = Number.parseInt(conversationKey.slice(0, 8), 16) % CONVERSATION_LOCK_SHARDS;
  return `conversation-shard-${shard.toString(16).padStart(2, "0")}.sqlite`;
}

function isConversationShardLockName(name: string): boolean {
  const match = CONVERSATION_SHARD_LOCK_PATTERN.exec(name);
  return match !== null && Number.parseInt(match[1] as string, 16) < CONVERSATION_LOCK_SHARDS;
}

function createProviderSessionEpoch(): string {
  return randomBytes(32).toString("hex");
}

function digestRunId(runId: string): string {
  return createHash("sha256").update("mono-agent-provider-dirty-run-v1\0").update(runId, "utf8").digest("hex");
}

function deriveProviderSessionId(conversationId: string, epoch: string): string {
  return createHash("sha256")
    .update("mono-agent-provider-session-v2\0")
    .update(conversationId, "utf8")
    .update("\0")
    .update(epoch, "utf8")
    .digest("hex");
}

function validateAppendMessages(messages: readonly HistoryMessage[]): readonly HistoryMessage[] {
  if (!Array.isArray(messages)) throw new TypeError("messages must be an array.");
  if (messages.length > MAX_APPEND_MESSAGES) {
    throw new TypeError(`append accepts at most ${MAX_APPEND_MESSAGES} messages.`);
  }
  return Array.from(messages, (message) => validateAndCloneMessage(message));
}

function validateAndCloneMessage(value: HistoryMessage): HistoryMessage {
  if (!isRecord(value)) throw new TypeError("Each history message must be an object.");
  const allowed = new Set(["role", "content", "name", "timestamp", "runId", "idempotencyKey"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`History message contains unsupported field ${key}.`);
  }
  if (!(["system", "user", "assistant", "tool"] as const).includes(value.role)) {
    throw new TypeError("History message role is invalid.");
  }
  if (typeof value.content !== "string") throw new TypeError("History message content must be a string.");
  const contentBytes = Buffer.byteLength(value.content, "utf8");
  if (contentBytes > MAX_MESSAGE_CONTENT_BYTES) {
    throw new TypeError(`History message content must not exceed ${MAX_MESSAGE_CONTENT_BYTES} UTF-8 bytes.`);
  }
  const optional = ["name", "timestamp", "runId", "idempotencyKey"] as const;
  for (const field of optional) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && typeof fieldValue !== "string") {
      throw new TypeError(`History message ${field} must be a string when present.`);
    }
  }
  const clone = cloneMessage(value);
  const envelope = { ...clone, content: "" };
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_MESSAGE_ENVELOPE_BYTES) {
    throw new TypeError(`History message metadata must not exceed ${MAX_MESSAGE_ENVELOPE_BYTES} serialized UTF-8 bytes.`);
  }
  if (Buffer.byteLength(JSON.stringify(clone), "utf8") > MAX_MESSAGE_SERIALIZED_BYTES) {
    throw new TypeError("History message cannot be represented within its serialized safety limit.");
  }
  return clone;
}

function cloneMessage(message: HistoryMessage): HistoryMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
    ...(message.runId === undefined ? {} : { runId: message.runId }),
    ...(message.idempotencyKey === undefined ? {} : { idempotencyKey: message.idempotencyKey }),
  };
}

function serializeHistoryFile(record: HistoryFileV2): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (bytes.byteLength > MAX_STORE_FILE_BYTES) {
    throw new Error(`Serialized conversation history exceeds the ${MAX_STORE_FILE_BYTES}-byte limit.`);
  }
  return bytes;
}

function serializeDirtyFence(value: Omit<DirtyFence, "path" | "mtimeMs">): Buffer {
  if (!/^[a-f0-9]{64}$/u.test(value.conversationKey)) {
    throw new Error("History dirty fence has an invalid conversation key.");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.epoch)) {
    throw new Error("History dirty fence has an invalid provider epoch.");
  }
  if (value.providerSessionId !== undefined && !/^[a-f0-9]{64}$/u.test(value.providerSessionId)) {
    throw new Error("History dirty fence has an invalid provider session id.");
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error("History dirty fence has an invalid provider revision.");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.runIdDigest)) {
    throw new Error("History dirty fence has an invalid run digest.");
  }
  const bytes = Buffer.from(`${JSON.stringify({
    version: value.providerSessionId === undefined ? 1 : 2,
    conversationKey: value.conversationKey,
    epoch: value.epoch,
    ...(value.providerSessionId === undefined ? {} : { providerSessionId: value.providerSessionId }),
    revision: value.revision,
    runIdDigest: value.runIdDigest,
  })}\n`, "utf8");
  if (bytes.byteLength > MAX_DIRTY_FENCE_BYTES) {
    throw new Error(`History dirty fence exceeds the ${MAX_DIRTY_FENCE_BYTES}-byte limit.`);
  }
  return bytes;
}

async function writePreparedFile(
  temporary: string,
  bytes: Buffer,
  root: string,
  rootIdentity: DirectoryIdentity,
): Promise<void> {
  await assertDirectoryIdentity(root, rootIdentity);
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    const temporaryInfo = await handle.stat();
    assertSecureHistoryFile(temporaryInfo, temporary);
    if (temporaryInfo.size !== bytes.byteLength) {
      throw new Error(`History temporary ${temporary} was not written completely.`);
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await assertDirectoryIdentity(root, rootIdentity);
}

function parseHistoryFile(bytes: Buffer, path: string): LoadedHistoryRecord {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TruncatedHistoryRecordError(`History file ${path} is not valid JSON.`);
  }
  if (!isRecord(value)) throw new Error(`History file ${path} must contain an object.`);
  if (typeof value.conversationId !== "string" || !Array.isArray(value.messages)) {
    throw new Error(`History file ${path} has an unsupported schema.`);
  }
  const conversationId = normalizeConversationId(value.conversationId);
  if (conversationId !== value.conversationId) {
    throw new Error(`History file ${path} contains a non-canonical conversation id.`);
  }
  if (value.messages.length > DEFAULT_MAX_MESSAGES) {
    throw new Error(`History file ${path} exceeds the ${DEFAULT_MAX_MESSAGES}-message limit.`);
  }
  const messages = value.messages.map((message) => validateAndCloneMessage(message as HistoryMessage));
  const keys = Object.keys(value).sort().join(",");
  if (value.version === LEGACY_STORE_VERSION && keys === "conversationId,messages,version") {
    return { sourceVersion: LEGACY_STORE_VERSION, conversationId, messages };
  }
  if (
    value.version !== STORE_VERSION
    || keys !== "conversationId,messages,providerSession,version"
    || !isRecord(value.providerSession)
  ) {
    throw new Error(`History file ${path} has an unsupported schema.`);
  }
  const providerKeys = Object.keys(value.providerSession).sort().join(",");
  if (
    providerKeys !== "epoch"
    && providerKeys !== "dirtyRunId,epoch"
    && providerKeys !== "epoch,revision"
    && providerKeys !== "dirtyRunId,epoch,revision"
  ) {
    throw new Error(`History file ${path} has an unsupported provider session schema.`);
  }
  if (typeof value.providerSession.epoch !== "string" || !/^[a-f0-9]{64}$/u.test(value.providerSession.epoch)) {
    throw new Error(`History file ${path} has an invalid provider session epoch.`);
  }
  let revision: number | undefined;
  if (value.providerSession.revision !== undefined) {
    revision = value.providerSession.revision as number;
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error(`History file ${path} has an invalid provider session revision.`);
    }
  }
  let dirtyRunId: string | undefined;
  if (value.providerSession.dirtyRunId !== undefined) {
    dirtyRunId = normalizeRunId(value.providerSession.dirtyRunId as string);
    if (dirtyRunId !== value.providerSession.dirtyRunId) {
      throw new Error(`History file ${path} has a non-canonical dirty run id.`);
    }
  }
  return {
    sourceVersion: STORE_VERSION,
    conversationId,
    messages,
    providerSession: {
      epoch: value.providerSession.epoch,
      ...(revision === undefined ? {} : { revision }),
      ...(dirtyRunId === undefined ? {} : { dirtyRunId }),
    },
  };
}

class TruncatedHistoryRecordError extends Error {}

async function acquireCrossProcessLock(
  path: string,
  directoryIdentity: DirectoryIdentity,
): Promise<CrossProcessLock> {
  const directory = dirname(path);
  await ensureOwnerOnlyLockFile(path, directoryIdentity);
  for (;;) {
    await assertDirectoryIdentity(directory, directoryIdentity);
    assertSecureHistoryFile(await lstat(path), path);
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path);
      // MEMORY avoids world-umask-dependent journal sidecars while retaining
      // SQLite's kernel-backed cross-process RESERVED lock semantics.
      database.exec("PRAGMA journal_mode=MEMORY");
      database.exec("BEGIN IMMEDIATE");
      assertSecureHistoryFile(await lstat(path), path);
      let released = false;
      return {
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          try {
            database?.exec("ROLLBACK");
          } catch {
            // close() is the authoritative kernel-lock release after an
            // unexpected SQLite transaction-state error.
          }
          try {
            database?.close();
          } catch {
            // The connection is no longer reusable; never turn lock cleanup
            // into an ambiguous failure after a semantic history commit.
          }
          database = undefined;
        },
      };
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Closing a failed lock attempt is best-effort.
      }
      if (!isSqliteBusy(error)) throw error;
      // There is deliberately no age timeout: a live provider turn owns this
      // conversation until it settles. On process death SQLite's OS lock is
      // released automatically, while the durable dirty bit remains.
      await delay(8 + Math.floor(Math.random() * 17));
    }
  }
}

async function acquireExistingCrossProcessLock(
  path: string,
  directoryIdentity: DirectoryIdentity,
): Promise<CrossProcessLock | undefined> {
  try {
    const info = await lstat(path);
    assertSecureHistoryFile(info, path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  return await acquireCrossProcessLock(path, directoryIdentity);
}

async function ensureOwnerOnlyLockFile(
  path: string,
  directoryIdentity: DirectoryIdentity,
  syncCreatedDirectory = true,
): Promise<boolean> {
  const directory = dirname(path);
  await assertDirectoryIdentity(directory, directoryIdentity);
  let handle;
  let created = false;
  try {
    try {
      handle = await open(
        path,
        fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
        0o600,
      );
      created = true;
      await handle.chmod(0o600);
      await handle.sync();
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const info = await lstat(path);
  assertSecureHistoryFile(info, path);
  if (info.size > 64 * 1024) throw new Error(`History lock file ${path} is unexpectedly large.`);
  if (created && syncCreatedDirectory) await fsyncDirectory(directory, directoryIdentity);
  return created;
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && /database is locked|database is busy/iu.test(error.message);
}

async function readActiveMarker(path: string): Promise<ActiveMarker> {
  const before = await lstat(path);
  assertSecureHistoryFile(before, path);
  if (before.size > MAX_ACTIVE_MARKER_BYTES) throw new Error(`History active marker ${path} is too large.`);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollowFlag() | (fsConstants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    assertSecureHistoryFile(opened, path);
    assertSameIdentity(before, opened, path);
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_ACTIVE_MARKER_BYTES) throw new Error(`History active marker ${path} is too large.`);
    const after = await handle.stat();
    assertSameIdentity(opened, after, path);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`History active marker ${path} is not valid JSON.`);
    }
    if (
      !isRecord(value)
      || Object.keys(value).sort().join(",") !== "conversationKey,pid,token,version"
      || value.version !== 1
      || typeof value.conversationKey !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.conversationKey)
      || !Number.isSafeInteger(value.pid)
      || (value.pid as number) <= 0
      || typeof value.token !== "string"
      || !/^[a-f0-9]{32}$/u.test(value.token)
    ) {
      throw new Error(`History active marker ${path} has an unsupported schema.`);
    }
    return {
      path,
      conversationKey: value.conversationKey,
      pid: value.pid as number,
      token: value.token,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readDirtyFence(path: string): Promise<DirtyFence> {
  const before = await lstat(path);
  assertSecureHistoryFile(before, path);
  if (before.size > MAX_DIRTY_FENCE_BYTES) throw new Error(`History dirty fence ${path} is too large.`);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollowFlag() | (fsConstants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    assertSecureHistoryFile(opened, path);
    assertSameIdentity(before, opened, path);
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_DIRTY_FENCE_BYTES) throw new Error(`History dirty fence ${path} is too large.`);
    const after = await handle.stat();
    assertSameIdentity(opened, after, path);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`History dirty fence ${path} is not valid JSON.`);
    }
    const keys = isRecord(value) ? Object.keys(value).sort().join(",") : "";
    const legacy = isRecord(value)
      && value.version === 1
      && keys === "conversationKey,epoch,revision,runIdDigest,version";
    const current = isRecord(value)
      && value.version === 2
      && keys === "conversationKey,epoch,providerSessionId,revision,runIdDigest,version"
      && typeof value.providerSessionId === "string"
      && /^[a-f0-9]{64}$/u.test(value.providerSessionId);
    if (
      !isRecord(value)
      || (!legacy && !current)
      || typeof value.conversationKey !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.conversationKey)
      || typeof value.epoch !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.epoch)
      || !Number.isSafeInteger(value.revision)
      || (value.revision as number) < 0
      || typeof value.runIdDigest !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.runIdDigest)
    ) {
      throw new Error(`History dirty fence ${path} has an unsupported schema.`);
    }
    return {
      path,
      conversationKey: value.conversationKey,
      epoch: value.epoch,
      ...(current ? { providerSessionId: value.providerSessionId as string } : {}),
      revision: value.revision as number,
      runIdDigest: value.runIdDigest,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function createAndVerifyRoot(root: string): Promise<DirectoryIdentity> {
  await createDirectoryPathWithoutSymlinks(root);
  const info = await lstat(root);
  assertSecureHistoryDirectory(info, root);
  return { dev: info.dev, ino: info.ino };
}

async function createAndVerifyLocksRoot(root: string): Promise<DirectoryIdentity> {
  const identity = await createAndVerifyRoot(root);
  for (let shard = 0; shard < CONVERSATION_LOCK_SHARDS; shard += 1) {
    const name = `conversation-shard-${shard.toString(16).padStart(2, "0")}.sqlite`;
    await ensureOwnerOnlyLockFile(join(root, name), identity, false);
  }
  // One directory sync publishes the complete fixed table atomically enough
  // for every initializer, including a process that observed files another
  // concurrent initializer had created but not yet synced.
  await fsyncDirectory(root, identity);
  return identity;
}

async function createDirectoryPathWithoutSymlinks(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = join(current, segment);
    let created = false;
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
        created = true;
      } catch (mkdirError) {
        if (!isErrno(mkdirError, "EEXIST")) throw mkdirError;
      }
      if (created) {
        await chmod(current, 0o700);
        await fsyncParentDirectory(current);
      }
      info = await lstat(current);
    }
    // macOS exposes root-owned compatibility links such as /var -> /private/var.
    // Those are outside the caller's control; user-owned links anywhere in the
    // configured path remain fail-closed.
    if (info.isSymbolicLink()) {
      const uid = process.getuid?.();
      if (uid === undefined || info.uid !== 0 || uid === 0) {
        throw new Error(`History path component ${current} must not be a user-controlled symbolic link.`);
      }
      continue;
    }
    if (!info.isDirectory()) throw new Error(`History path component ${current} must be a directory.`);
  }
}

function assertSecureHistoryDirectory(info: Stats, path: string): void {
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`History root ${path} must be a non-symlink directory.`);
  }
  assertOwnedByCurrentUser(info, path);
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o700) {
    throw new Error(`History root ${path} must have owner-only mode 0700.`);
  }
}

function assertSecureHistoryFile(info: Stats, path: string): void {
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`History path ${path} must be a non-symlink regular file.`);
  }
  assertOwnedByCurrentUser(info, path);
  if (info.nlink !== 1) throw new Error(`History file ${path} must have exactly one hard link.`);
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
    throw new Error(`History file ${path} must have owner-only mode 0600.`);
  }
}

function assertOwnedByCurrentUser(info: Stats, path: string): void {
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) throw new Error(`History path ${path} must be owned by the current user.`);
}

async function assertDirectoryIdentity(path: string, expected: DirectoryIdentity): Promise<void> {
  const info = await lstat(path);
  assertSecureHistoryDirectory(info, path);
  if (info.dev !== expected.dev || info.ino !== expected.ino) {
    throw new Error(`History root ${path} changed while it was in use.`);
  }
}

function assertSameIdentity(before: Stats, after: Stats, path: string): void {
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new ConcurrentHistoryMutationError(`History file ${path} changed while it was being read.`);
  }
}

class ConcurrentHistoryMutationError extends Error {}

async function fsyncDirectory(path: string, expected: DirectoryIdentity): Promise<void> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | noFollowFlag());
    const info = await handle.stat();
    assertSecureHistoryDirectory(info, path);
    if (info.dev !== expected.dev || info.ino !== expected.ino) {
      throw new Error(`History root ${path} changed while it was in use.`);
    }
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function fsyncParentDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  let handle;
  try {
    handle = await open(parent, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | noFollowFlag());
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function noFollowFlag(): number {
  return fsConstants.O_NOFOLLOW ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
}
