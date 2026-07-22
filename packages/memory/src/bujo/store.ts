import { relative } from "node:path";

import type {
  MemoryBlock,
  MemoryCompletedTurn,
  MemoryCompletedTurnResult,
  MemoryStore,
  MemoryWriteResult,
} from "@mono-agent/agent-contracts";
import type { RecallHit } from "../store/index.js";
import { openMemoryDb, type MemoryDb, type MemoryRecord } from "../store/index.js";

import {
  appendAuditBullet,
  appendBullet,
  auditFilePath,
  dailyFilePath,
  normalizedContentHash,
  withJournalWriteLock,
} from "./daily.js";
import { parseDailyFile } from "./grammar.js";
import { serializeBullet } from "./grammar.js";
import { replaceDbCanonicalGraphProjectionWithParity } from "./graph.js";
import {
  assertCanonicalGraphRepairBaseParity,
  auditCanonicalIndexHealth,
} from "./rebuild.js";
import {
  REPLAY_PROJECTION_FILE,
  assertReplayProjectionMatchesDb,
  cleanupReplayProjectionTemporaryArtifacts,
  readReplayProjectionStrict,
  replayProjectionDbSnapshot,
} from "./replay-projection.js";
import { createIdFactory } from "./ids.js";
import type { LlmComplete } from "./llm.js";
import type { EmbeddingProvider } from "../search/index.js";
import { captureTurn, captureTurnStrict } from "./capture.js";
import {
  findRetainedCaptureIntent,
  listRetainedCaptureIntentKeys,
  removeRetainedCaptureIntent,
  replayCaptureIntent,
} from "./capture-outbox.js";
import {
  CompletedTurnIntakeManager,
  type CompletedTurnIntakeSnapshot,
} from "./capture-intake.js";
import { composeRecallBlock } from "./recall.js";
import { recoverDurableMutationState, withSerializedBujoMutation } from "./mutation-lock.js";
import {
  migrate as migrateFn,
  type MigrateResult,
} from "./migrate.js";
import { consolidateBujoMemory, type ConsolidateResult } from "./consolidate.js";
import { writeFutureLog } from "./projections.js";
import { listCanonicalFileNames, readCanonicalFileSnapshot } from "./path-safety.js";
import type { Bullet, BujoLogger, BujoOptions, BujoTier } from "./types.js";
import { BoundedBatchQueue, type BackgroundQueueSnapshot, type QueueJob } from "./queue.js";
import {
  BUJO_RUNTIME_SNAPSHOT_STALE_AFTER_MS,
  writeBujoRuntimeSnapshot,
  type BujoRuntimeCounters,
} from "./runtime-snapshot.js";
import {
  acquireMemoryWriterLease,
  assertSafeSqlitePathState,
  canonicalMemoryRoot,
  captureSafeSqlitePathState,
  readManagedIndexManifest,
  registerManagedRollbackRuntime,
  resolveActiveMemoryDbPath,
  type ManagedRollbackRuntimeLease,
  type MemoryWriterLease,
} from "./generations.js";

// Cap the recall query so an attachment turn's inlined document text (the user message can carry
// up to a few KB of extracted file content) cannot drown the FTS/embedding signal.
const MAX_RECALL_QUERY_CHARS = 4_000;
const JOURNAL_QUEUE_MAX_ITEMS = 256;
const JOURNAL_QUEUE_MAX_BYTES = 2 * 1024 * 1024;
const CAPTURE_QUEUE_MAX_ITEMS = 32;
const CAPTURE_QUEUE_MAX_BYTES = 1024 * 1024;
const JOURNAL_RETRY_DELAY_MS = 1_000;
const JOURNAL_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_BACKGROUND_DRAIN_TIMEOUT_MS = 10_000;
const RUNTIME_SNAPSHOT_COALESCE_MS = 25;
const RUNTIME_SNAPSHOT_HEARTBEAT_MS = Math.floor(BUJO_RUNTIME_SNAPSHOT_STALE_AFTER_MS / 3);
const JOURNAL_WRITE_CHAINS = new Map<string, Promise<void>>();

interface IndexJob extends QueueJob {
  readonly record: MemoryRecord;
}

interface CaptureJob extends QueueJob {
  readonly conversationId: string;
  readonly text: string;
}

interface AdmittedOperation {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
}

export interface BujoQueueSnapshot {
  readonly index?: BackgroundQueueSnapshot & {
    readonly remainingBacklog: number;
    readonly recoveryFilesRemaining: number;
    readonly recoveryPaused: boolean;
    /** Delay of the retry that is currently scheduled; zero when none is scheduled. */
    readonly retryDelayMs: number;
    /** Delay the following failure would schedule after the current retry. */
    readonly nextRetryDelayMs: number;
    /** Rows materialized by bounded missing-vector refill queries. */
    readonly recoveryRowsScanned: number;
    /** Missing-vector refill queries issued since startup. */
    readonly recoveryRefillQueries: number;
    readonly nextRetryAt?: string;
  };
  readonly capture?: BackgroundQueueSnapshot;
  /** Metadata-only durable completed-turn intake state. */
  readonly intake?: CompletedTurnIntakeSnapshot;
  readonly shutdown: {
    readonly drainTimeoutMs: number;
    readonly discarded: number;
    readonly timedOut: boolean;
  };
}

export class BujoMemoryStore implements MemoryStore {
  private readonly root: string;
  private readonly db: MemoryDb;
  private readonly writerLease: MemoryWriterLease | undefined;
  private rollbackRuntimeLease: ManagedRollbackRuntimeLease | undefined;
  private readonly readOnly: boolean;
  private readonly maxBytes: number;
  private readonly clock: () => Date;
  private readonly nextId: () => string;
  private readonly llm?: LlmComplete;
  private readonly _tier!: BujoTier;
  private readonly logger: BujoLogger;
  private readonly backgroundDrainTimeoutMs: number;
  private indexQueue?: BoundedBatchQueue<IndexJob>;
  private captureQueue?: BoundedBatchQueue<CaptureJob>;
  private completedTurnIntake?: CompletedTurnIntakeManager;
  private journalRecoveryPaused = false;
  private journalRecoveryFiles: string[] = [];
  private journalRecoveryCursor = 0;
  private journalRecoveryPromise: Promise<void> = Promise.resolve();
  private resolveJournalRecovery: (() => void) | undefined;
  private journalRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private journalRetryAttempt = 0;
  private currentJournalRetryDelayMs = 0;
  private nextJournalRetryAt: Date | undefined;
  private journalRecoveryRowsScanned = 0;
  private journalRecoveryRefillQueries = 0;
  private lastKnownMissingVectors = 0;
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private activeCaptureController: AbortController | undefined;
  private activeIndexController: AbortController | undefined;
  private readonly admittedOperations = new Set<AdmittedOperation>();
  private shutdownDiscarded = 0;
  private shutdownTimedOut = false;
  private readonly runtimeStartedAt = new Date().toISOString();
  private readonly runtimeCounters: {
    embeddingCalls: number;
    embeddingTexts: number;
    llmCalls: number;
    llmInputChars: number;
  } = { embeddingCalls: 0, embeddingTexts: 0, llmCalls: 0, llmInputChars: 0 };
  private runtimeSnapshotEnabled = false;
  private runtimeSnapshotTimer: ReturnType<typeof setTimeout> | undefined;
  private runtimeHeartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: BujoOptions) {
    const derivedTier = options.embeddings === undefined
      ? "lite"
      : options.llm === undefined
        ? "journal"
        : "bujo";
    let tier = options.tier ?? derivedTier;
    // Pure validation precedes every filesystem/lease side effect.
    assertTierPrerequisites(tier, options);
    if (options.allowFtsFallback === true && (
      options.readOnly !== true
      || options.embeddings !== undefined
      || options.dim !== undefined
      || options.llm !== undefined
    )) {
      throw new Error("memory-bujo: allowFtsFallback is only valid for an explicit read-only FTS store.");
    }
    if (options.dbPath !== undefined && options.readOnly !== true) {
      throw new Error("memory-bujo: dbPath may pin only a read-only snapshot; writable stores always use the managed active generation.");
    }
    const backgroundDrainTimeoutMs = options.backgroundDrainTimeoutMs ?? DEFAULT_BACKGROUND_DRAIN_TIMEOUT_MS;
    if (!Number.isInteger(backgroundDrainTimeoutMs) || backgroundDrainTimeoutMs <= 0) {
      throw new Error("memory-bujo: backgroundDrainTimeoutMs must be a positive integer.");
    }
    this.backgroundDrainTimeoutMs = backgroundDrainTimeoutMs;
    this.readOnly = options.readOnly === true;
    const writerLease = this.readOnly ? undefined : acquireMemoryWriterLease(options.root);
    this.writerLease = writerLease;
    this.root = writerLease?.root ?? canonicalMemoryRoot(options.root, true);
    this.maxBytes = options.maxBytes ?? 8_000;
    this.clock = options.clock ?? (() => new Date());
    this.nextId = createIdFactory({ clock: this.clock });
    this.logger = options.logger ?? { warn: () => {} };
    if (options.llm !== undefined) this.llm = this.instrumentLlm(options.llm);
    let opened: MemoryDb | undefined;
    try {
      if (!this.readOnly) cleanupReplayProjectionTemporaryArtifacts(this.root);
      const managed = readManagedIndexManifest(this.root);
      if (this.readOnly && options.tier === undefined && managed !== undefined) {
        tier = managed.active.tier;
        assertTierPrerequisites(tier, options);
      }
      this._tier = tier;
      if (!this.readOnly) {
        this.rollbackRuntimeLease = registerManagedRollbackRuntime(this.root, managed);
      }
      if (!this.readOnly && managed !== undefined && (
        managed.active.tier !== this._tier
        || managed.active.embeddingModel !== options.embeddings?.id
        || managed.active.dimension !== options.dim
      )) {
        throw new Error(
          `memory-bujo: active generation requires tier=${managed.active.tier}, `
          + `model=${managed.active.embeddingModel ?? "none"}, dim=${managed.active.dimension ?? "none"}; `
          + "run the safe memory rebuild for the configured identity.",
        );
      }
      const dbPath = options.dbPath ?? resolveActiveMemoryDbPath(this.root);
      const dbPathState = captureSafeSqlitePathState(this.root, dbPath, "memory database");
      opened = openMemoryDb({
        path: dbPath,
        ...(options.embeddings !== undefined && { embeddings: this.instrumentEmbeddings(options.embeddings) }),
        ...(options.dim !== undefined && { dim: options.dim }),
        ...(this.readOnly ? { readOnly: true } : {}),
        clock: this.clock,
      });
      assertSafeSqlitePathState(this.root, dbPath, dbPathState, "memory database");
      this.db = opened;
      if (this.readOnly && managed !== undefined && options.allowFtsFallback !== true) {
        const metadata = opened.indexMetadata();
        if (metadata === undefined
          || metadata.tier !== this._tier
          || metadata.embeddingModel !== options.embeddings?.id
          || metadata.dimension !== options.dim) {
          throw new Error(
            `memory-bujo: managed read-only generation requires tier=${metadata?.tier ?? "unknown"}, `
            + `model=${metadata?.embeddingModel ?? "none"}, dim=${metadata?.dimension ?? "none"}; `
            + "open it with the configured identity or request an explicit FTS fallback.",
          );
        }
      }
      if (this._tier !== "lite") this.db.assertEmbeddingIdentity();
      if (!this.readOnly && this._tier === "bujo") {
        const coverage = opened.validationSnapshot();
        if (coverage.vectors !== coverage.memories) {
          throw new Error(
            `memory-bujo: writable BuJo requires complete vector coverage; `
            + `active index has ${coverage.vectors}/${coverage.memories} vectors. `
            + "Stop the agent and run the safe memory rebuild before starting BuJo.",
          );
        }
      }
      if (this.readOnly) {
        if (this._tier === "bujo") {
          const replay = readReplayProjectionStrict(this.root);
          if (replay.state.kind === "missing") {
            throw new Error(
              `memory-bujo: read-only BuJo requires ${REPLAY_PROJECTION_FILE}; `
              + "unattested replay state is not exposed.",
            );
          }
          assertReplayProjectionMatchesDb(opened, replay.projection);
          if (auditCanonicalIndexHealth(this.root, "bujo", opened).status !== "match") {
            throw new Error(
              "memory-bujo: read-only BuJo requires exact canonical memory, graph, and replay parity; "
              + "run stopped-store rebuild before recall.",
            );
          }
        } else {
          const replay = replayProjectionDbSnapshot(opened);
          if (replay.terminals.length > 0 || replay.supersedes.length > 0 || replay.threads.length > 0) {
            throw new Error(`memory-bujo: read-only ${this._tier} rejects BuJo replay-owned lifecycle and edges.`);
          }
        }
      }
      if (!this.readOnly) {
        // Already-paid durable state predates any work this process could
        // accept. Recover it synchronously in protocol order, or fence a
        // mismatched/ambiguous state before queues and runtime writes exist.
        recoverDurableMutationState(
          this.root,
          opened,
          this._tier,
          assertCanonicalGraphRepairBaseParity,
        );
        if (this._tier === "bujo") {
          const replay = readReplayProjectionStrict(this.root);
          if (replay.state.kind === "missing") {
            throw new Error(
              `memory-bujo: ${REPLAY_PROJECTION_FILE} is missing; refusing to bless replay-owned SQLite state. `
              + "Stop the store and run safe rebuild for an empty legacy projection or explicit replay projection adoption.",
            );
          }
          assertReplayProjectionMatchesDb(opened, replay.projection);
          // Older runtimes could retire an intent after mirroring only its
          // touched graph rows. Heal that complete provider-free projection
          // before queues or runtime health become visible. This does not
          // establish Markdown/SQLite memory parity; strict canonical-index
          // health continues to audit that independent invariant.
          replaceDbCanonicalGraphProjectionWithParity(
            this.root,
            opened,
            assertCanonicalGraphRepairBaseParity,
          );
        } else {
          const replay = replayProjectionDbSnapshot(opened);
          if (replay.terminals.length > 0 || replay.supersedes.length > 0 || replay.threads.length > 0) {
            throw new Error(`memory-bujo: ${this._tier} rejects BuJo replay-owned lifecycle and edges.`);
          }
        }
      }
      if (!this.readOnly) this.initializeCompletedTurnIntake();
      if (!this.readOnly && this._tier === "journal") this.initializeJournalIndexing();
      if (!this.readOnly) this.initializeRuntimeSnapshot();
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try { this.completedTurnIntake?.abortForShutdown(false); } catch (closeError) { cleanupErrors.push(closeError); }
      try { opened?.close(); } catch (closeError) { cleanupErrors.push(closeError); }
      try { this.rollbackRuntimeLease?.release(); } catch (releaseError) { cleanupErrors.push(releaseError); }
      try { writerLease?.release(); } catch (releaseError) { cleanupErrors.push(releaseError); }
      throw withCleanupErrors(error, cleanupErrors, "memory-bujo initialization failed");
    }
  }

  /** The effective tier of this store (lite / journal / bujo). */
  tier(): BujoTier {
    return this._tier;
  }

  async load(conversationId: string, query?: string): Promise<MemoryBlock | undefined> {
    this.assertOpen("load");
    // Recall against what the user actually said. Legacy callers pass no query, so fall back to the
    // conversation id as a coarse seed; an explicit empty query carries no usable signal, so skip
    // recall rather than surface near-random hits.
    let recallQuery: string;
    if (query === undefined) {
      recallQuery = conversationId;
    } else {
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        return undefined;
      }
      recallQuery = trimmed.slice(0, MAX_RECALL_QUERY_CHARS);
    }
    return await this.runAdmittedOperation(async (abortSignal) => await composeRecallBlock(
      this.db,
      recallQuery,
      { topK: 8, maxBytes: this.maxBytes, trackAccess: !this.readOnly, abortSignal },
    ));
  }

  /** Query-based hybrid recall (text + score). Used by the MCP and any deliberate recall surface. */
  async recall(query: string, options: { topK?: number; trackAccess?: boolean } = {}): Promise<RecallHit[]> {
    this.assertOpen("recall");
    return await this.runAdmittedOperation(async (abortSignal) => await this.db.recall(query, {
      ...(options.topK !== undefined && { topK: options.topK }),
      ...(this.readOnly
        ? { trackAccess: false }
        : options.trackAccess === undefined ? {} : { trackAccess: options.trackAccess }),
      abortSignal,
    }));
  }

  /** Whether this strict tier may expose graph expansion to explicit MemoryRecall. */
  supportsGraphExpansion(): boolean {
    return this._tier === "bujo";
  }

  /** Deterministically expand already-fetched direct hits for explicit MemoryRecall only. */
  expandGraph(
    query: string,
    directHits: readonly RecallHit[],
    options: { readonly topK?: number } = {},
  ): RecallHit[] {
    this.assertOpen("expandGraph");
    const topK = Math.max(1, Math.min(options.topK ?? 8, 50));
    if (this._tier !== "bujo" || directHits.length === 0) return directHits.slice(0, topK);
    const seeds = directHits.slice(0, 3);
    const additions = this.db.expandEntityRelations(seeds.map((hit) => hit.record.id), {
      query,
      seedLimit: 3,
      maxAdditions: 5,
    });
    if (additions.length === 0) return directHits.slice(0, topK);
    const seedFloor = Math.min(...seeds.map((hit) => hit.score));
    const merged = new Map(directHits.map((hit) => [hit.record.id, hit]));
    for (const [index, record] of additions.entries()) {
      const score = Math.max(0, seedFloor * 0.95 - index * 1e-6);
      const existing = merged.get(record.id);
      // The raw cache is intentionally a 50-hit superset. A graph target may
      // already sit below the requested topK there; promote it instead of
      // treating presence in the superset as a reason to discard the path.
      if (existing === undefined || score > existing.score) merged.set(record.id, { record, score });
    }
    const sorted = [...merged.values()]
      .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
      .slice(0, topK);
    const bestGraphId = additions[0]?.id;
    if (bestGraphId !== undefined && !sorted.some((hit) => hit.record.id === bestGraphId)) {
      const graphHit = merged.get(bestGraphId);
      if (graphHit !== undefined) {
        sorted.splice(Math.max(0, sorted.length - 1), 1, graphHit);
        sorted.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
      }
    }
    return sorted;
  }

  /** Record served recall hits as telemetry without re-running retrieval. */
  recordAccess(ids: readonly string[]): void {
    this.assertOpen("recordAccess");
    if (this.readOnly) return;
    this.db.recordAccess(ids);
  }

  async appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult> {
    const run = async (abortSignal: AbortSignal): Promise<MemoryWriteResult> =>
      await this.appendHostSummaryAccepted(conversationId, summary, abortSignal);
    // BuJo's compact host audit is the always-on loss boundary, not curated
    // canonical/index state. It must remain off the provider-backed mutation
    // queue so a slow capture cannot delay successful-turn persistence.
    return this._tier === "bujo"
      ? await this.runAdmittedWrite("appendHostSummary", run)
      : await this.runAdmittedMutation("appendHostSummary", run);
  }

  /**
   * Admit one provider-completed turn at the durable run-id boundary. Provider
   * curation is explicitly downstream of this fsynced, idempotent publication.
   */
  async persistCompletedTurn(turn: MemoryCompletedTurn): Promise<MemoryCompletedTurnResult> {
    this.assertWritable("persistCompletedTurn");
    const intake = this.completedTurnIntake;
    if (intake === undefined) throw new Error("memory-bujo: completed-turn intake is unavailable.");
    const result = intake.admit(turn);
    // Admission has crossed the fsynced loss boundary. Publish its aggregate
    // state synchronously before returning; downstream transition chatter uses
    // the bounded coalescing path below.
    this.publishRuntimeSnapshotImmediately("running");
    return {
      id: result.id,
      runId: turn.runId,
      conversationId: turn.conversationId,
      source: result.source,
      bytesWritten: result.bytesWritten,
      admissionStatus: result.admissionStatus,
    };
  }

  /** Idempotently project a durable intake record into the tier's compact host summary. */
  private async appendCompletedTurnSummary(
    turn: MemoryCompletedTurn,
    intakeId: string,
    admittedAt: string,
    abortSignal: AbortSignal,
  ): Promise<void> {
    abortSignal.throwIfAborted();
    const now = new Date(admittedAt);
    // Admission already rejected reserved/control/format characters. Preserve
    // every remaining code point; only the host summary's documented layout
    // whitespace is projected to the one-line bullet grammar.
    const text = turn.summary.trim().replace(/[\t\r\n ]+/gu, " ");
    if (text.length === 0) throw new Error("memory-bujo: completed-turn summary normalizes to empty text.");
    const hash = normalizedContentHash(text);
    const bullet: Bullet = {
      id: `R-${intakeId}`,
      type: "note",
      status: "open",
      text,
      salience: 0.5,
      isInsight: false,
      createdAt: admittedAt,
      refs: [`run-sha256:${intakeId}`, `sha256:${hash}`],
    };
    const relativePath = this._tier === "bujo"
      ? relative(this.root, auditFilePath(this.root, now))
      : relative(this.root, dailyFilePath(this.root, now));
    await serializeJournalWrite(this.root, abortSignal, async () => await withJournalWriteLockRetry(
      this.root,
      this.db.busyTimeoutMs(),
      abortSignal,
      () => {
        abortSignal.throwIfAborted();
        const snapshot = readCanonicalFileSnapshot(this.root, relativePath, { allowMissing: true });
        const matches = snapshot === undefined
          ? []
          : parseDailyFile(snapshot.content).bullets.filter((candidate) => candidate.id === bullet.id);
        if (matches.length > 1) {
          throw new Error("memory-bujo: completed-turn canonical summary id is duplicated.");
        }
        if (matches.length === 1) {
          const existing = matches[0]!;
          if (existing.text !== bullet.text || existing.createdAt !== bullet.createdAt
            || existing.refs.join("\u0000") !== bullet.refs.join("\u0000")) {
            throw new Error("memory-bujo: completed-turn canonical summary conflicts with its run id.");
          }
        } else if (this._tier === "bujo") {
          appendAuditBullet(this.root, bullet, now);
        } else {
          appendBullet(this.root, bullet, now);
        }
        abortSignal.throwIfAborted();
        if (this._tier === "bujo") return;

        const recordId = this._tier === "journal" ? `J-${hash}` : bullet.id;
        const record: MemoryRecord = {
          id: recordId,
          type: bullet.type,
          status: bullet.status,
          text: bullet.text,
          salience: bullet.salience,
          isInsight: bullet.isInsight,
          createdAt: bullet.createdAt,
          accessCount: 0,
          tags: [],
          source: { session: turn.conversationId, file: relativePath },
        };
        if (this._tier === "journal") {
          const outcome = this.db.insertJournalLexical(record, hash);
          if (outcome.inserted || !this.db.hasVector(record.id)) this.enqueueIndex(record);
        } else {
          this.db.upsertLexical(record);
        }
      },
    ));
  }

  private async captureCompletedTurn(
    turn: MemoryCompletedTurn,
    intakeId: string,
    admittedAt: string,
    abortSignal: AbortSignal,
  ): Promise<"captured" | "summary_only"> {
    return await withSerializedBujoMutation({
      root: this.root,
      db: this.db,
      tier: this._tier,
      abortSignal,
      canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
    }, async () => {
      const retained = findRetainedCaptureIntent(this.root, intakeId);
      if (retained !== undefined) {
        replayCaptureIntent(this.root, retained, this.db, {
          retainIntent: true,
          canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
        });
        return "captured";
      }
      const text = turn.captureText;
      if (this._tier !== "bujo" || this.llm === undefined || text === undefined || text.trim().length === 0) {
        return "summary_only";
      }
      await captureTurnStrict(text, {
        db: this.db,
        root: this.root,
        llm: this.llm!,
        nextId: completedTurnCaptureIdFactory(intakeId),
        now: () => new Date(admittedAt),
        abortSignal,
        captureRetentionKey: intakeId,
        canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
      });
      return "captured";
    });
  }

  /** Run a direct write that was admitted before close() stopped new mutation. */
  private async appendHostSummaryAccepted(
    conversationId: string,
    summary: string,
    abortSignal: AbortSignal,
  ): Promise<MemoryWriteResult> {
    abortSignal.throwIfAborted();
    const now = this.clock();
    const text = summary.trim().replace(/\s+/gu, " ");
    const hash = normalizedContentHash(text);
    const bullet: Bullet = {
      id: this._tier === "journal" ? `J-${hash}` : this.nextId(),
      type: "note",
      status: "open",
      // Collapse whitespace/newlines to a single line: a bullet is one markdown line, and
      // serializeBullet rejects newlines. The harness emits multi-line summaries; P2's distiller
      // will split these into multiple atomic memories — for P1 we store one normalized line.
      text,
      salience: 0.5,
      isInsight: false,
      createdAt: now.toISOString(),
      refs: [`sha256:${hash}`],
    };
    if (this._tier === "bujo") {
      abortSignal.throwIfAborted();
      const path = auditFilePath(this.root, now);
      appendAuditBullet(this.root, bullet, now);
      return {
        conversationId,
        source: path,
        bytesWritten: Buffer.byteLength(`${serializeBullet(bullet)}\n`, "utf8"),
      };
    }
    const path = dailyFilePath(this.root, now);
    const record: MemoryRecord = {
      id: bullet.id,
      type: bullet.type,
      status: bullet.status,
      text: bullet.text,
      salience: bullet.salience,
      isInsight: bullet.isInsight,
      createdAt: bullet.createdAt,
      accessCount: 0,
      tags: [],
      source: { session: conversationId, file: relative(this.root, path) },
    };
    if (this._tier === "journal") {
      // Recovery is deliberately off the successful-turn path. Both new writes
      // and legacy backfill converge on J-<content-hash>, so whichever runs first
      // reserves the same canonical representation without waiting for history.
      return await serializeJournalWrite(this.root, abortSignal, async () => await withJournalWriteLockRetry(
        this.root,
        this.db.busyTimeoutMs(),
        abortSignal,
        () => {
          abortSignal.throwIfAborted();
          const reserved = this.db.contentHashRecord(hash);
          if (reserved !== undefined) {
            const existing = this.db.get(reserved.memoryId);
            if (existing !== undefined && !this.db.hasVector(existing.id)) this.enqueueIndex(existing);
            return { conversationId, source: path, bytesWritten: 0 };
          }
          appendBullet(this.root, bullet, now);
          const outcome = this.db.insertJournalLexical(record, hash);
          if (outcome.inserted) this.enqueueIndex(record);
          return {
            conversationId,
            source: path,
            bytesWritten: Buffer.byteLength(`${serializeBullet(bullet)}\n`, "utf8"),
          };
        },
      ));
    }

    abortSignal.throwIfAborted();
    appendBullet(this.root, bullet, now);
    this.db.upsertLexical(record);
    // bytesWritten reflects the bullet line actually appended to the daily file, not the raw summary.
    return { conversationId, source: path, bytesWritten: Buffer.byteLength(`${serializeBullet(bullet)}\n`, "utf8") };
  }

  /**
   * Run the monthly BuJo migration ritual: review aging open memories and apply LLM decisions
   * (promote / reschedule / cluster / forget). Also writes future-log.md.
   *
   * Returns `undefined` when no `llm` was configured (matches `capture()` pattern).
   */
  async migrate(): Promise<MigrateResult | undefined> {
    return await this.runAdmittedMutation("migrate", async (abortSignal) => {
      if (this.llm === undefined) return undefined;
      const m = await migrateFn({
        db: this.db,
        root: this.root,
        llm: this.llm,
        now: this.clock,
        abortSignal,
      });
      abortSignal.throwIfAborted();
      writeFutureLog(this.root, this.db, this.clock());
      return m;
    });
  }

  /**
   * Legacy opt-in best-effort capture for direct compatibility callers. The bundled harness uses
   * `persistCompletedTurn` for this store and never invokes this method. Allocate its queue only on
   * the first explicit call so an ordinary BuJo store does not carry a dormant background queue.
   * Captures run one-at-a-time; failures are logged without breaking the caller or the process.
   */
  scheduleCapture(conversationId: string, text: string): void {
    this.assertWritable("scheduleCapture");
    if (this._tier !== "bujo" || this.llm === undefined) return;
    this.initializeCaptureQueue();
    const outcome = this.captureQueue!.enqueue({
      key: `${conversationId}:${normalizedContentHash(text)}`,
      bytes: Buffer.byteLength(text, "utf8"),
      conversationId,
      text,
    });
    if (outcome === "dropped") {
      this.safeWarn("bujo capture queue is full; the compact raw host audit was preserved, but this turn was not curated.");
    }
  }

  /** Await all captures queued before this call (graceful shutdown / one-shot exit). */
  async flush(): Promise<void> {
    await this.journalRecoveryPromise;
    // Intake may enqueue Journal vectors, so its durable projection must run
    // before the index queue's drain barrier.
    await this.completedTurnIntake?.flush();
    await this.indexQueue?.flush();
    await this.captureQueue?.flush();
    if (!this.closing) this.publishRuntimeSnapshotImmediately("running");
  }

  queueSnapshot(): BujoQueueSnapshot {
    return {
      ...(this.indexQueue === undefined ? {} : {
        index: {
          ...this.indexQueue.snapshot(),
          remainingBacklog: this.remainingIndexBacklog(),
          recoveryFilesRemaining: Math.max(0, this.journalRecoveryFiles.length - this.journalRecoveryCursor),
          recoveryPaused: this.journalRecoveryPaused,
          retryDelayMs: this.currentJournalRetryDelayMs,
          nextRetryDelayMs: this.currentJournalRetryDelayMs === 0 ? 0 : retryDelayMs(this.journalRetryAttempt),
          recoveryRowsScanned: this.journalRecoveryRowsScanned,
          recoveryRefillQueries: this.journalRecoveryRefillQueries,
          ...(this.nextJournalRetryAt === undefined ? {} : { nextRetryAt: this.nextJournalRetryAt.toISOString() }),
        },
      }),
      ...(this.captureQueue === undefined ? {} : { capture: this.captureQueue.snapshot() }),
      ...(this.completedTurnIntake === undefined ? {} : { intake: this.completedTurnIntake.snapshot() }),
      shutdown: {
        drainTimeoutMs: this.backgroundDrainTimeoutMs,
        discarded: this.shutdownDiscarded,
        timedOut: this.shutdownTimedOut,
      },
    };
  }

  /**
   * Explicit legacy capture primitive for direct callers. It distills the turn text into atomic
   * candidate memories, reconciles them against the existing index, and extracts graph entities.
   * The bundled harness does not call this path; its `persistCompletedTurn` boundary drives strict,
   * idempotent capture instead. Returns `undefined` when no `llm` was configured.
   */
  async capture(
    conversationId: string,
    text: string,
    abortSignal?: AbortSignal,
  ): Promise<{ actions: number; entities: number } | undefined> {
    return await this.runAdmittedMutation(
      "capture",
      async (shutdownSignal) => await this.captureAccepted(conversationId, text, shutdownSignal),
      abortSignal,
    );
  }

  /** Run work that was admitted before shutdown stopped the capture queue. */
  private async captureAccepted(
    conversationId: string,
    text: string,
    abortSignal?: AbortSignal,
  ): Promise<{ actions: number; entities: number } | undefined> {
    if (this.llm === undefined) return undefined;
    return await withSerializedBujoMutation({
      root: this.root,
      db: this.db,
      tier: this._tier,
      ...(abortSignal === undefined ? {} : { abortSignal }),
      canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
    }, async () => {
      const res = await captureTurn(text, {
        db: this.db,
        root: this.root,
        llm: this.llm!,
        nextId: this.nextId,
        now: this.clock,
        ...(abortSignal === undefined ? {} : { abortSignal }),
        canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
      });
      return { actions: res.actions.length, entities: res.entities };
    });
  }

  /** Refresh derived projections and report duplicates without changing memory state. */
  async consolidate(): Promise<ConsolidateResult> {
    return await this.runAdmittedWrite("consolidate", async (abortSignal) => {
      abortSignal.throwIfAborted();
      return await consolidateBujoMemory({
        root: this.root,
        db: this.db,
        now: this.clock(),
      });
    });
  }

  close(): Promise<void> {
    // Bound shutdown: deterministic lexical/raw source already survived, so
    // queued semantic/curation work may be discarded rather than hanging stop.
    if (this.closePromise !== undefined) return this.closePromise;
    this.closing = true;
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    this.disableRuntimeTimers();
    if (this.journalRetryTimer !== undefined) clearTimeout(this.journalRetryTimer);
    // Scheduled/direct BuJo curation does not feed completed-turn admission,
    // so preserve the synchronous close boundary for this queue. Journal's
    // index queue intentionally remains open until intake has projected every
    // already-admitted turn.
    this.captureQueue?.stopAccepting();
    let primary: unknown;
    try {
      const drained = await waitForDrain(
        this.drainAcceptedWork(),
        this.backgroundDrainTimeoutMs,
      );
      if (!drained) {
        this.shutdownTimedOut = true;
        this.indexQueue?.stopAccepting();
        this.captureQueue?.stopAccepting();
        this.shutdownDiscarded += this.indexQueue?.discardQueued() ?? 0;
        this.shutdownDiscarded += this.captureQueue?.discardQueued() ?? 0;
        const timeoutReason = new Error("memory operation drain deadline exceeded");
        for (const operation of this.admittedOperations) operation.controller.abort(timeoutReason);
        this.activeIndexController?.abort(new Error("memory background drain deadline exceeded"));
        this.activeCaptureController?.abort(new Error("memory background drain deadline exceeded"));
        this.completedTurnIntake?.abortForShutdown(true);
        this.safeWarn(
          `memory operation/background drain exceeded ${this.backgroundDrainTimeoutMs}ms; pending work was abandoned before further canonical or SQLite access while durable source remains.`,
        );
      }
    } catch (error) {
      primary = error;
    } finally {
      const cleanupErrors: unknown[] = [];
      this.indexQueue?.stopAccepting();
      this.captureQueue?.stopAccepting();
      if (!this.shutdownTimedOut) this.completedTurnIntake?.finishShutdown();
      this.publishRuntimeSnapshot("closed");
      this.runtimeSnapshotEnabled = false;
      this.disableRuntimeTimers();
      try { this.db.close(); } catch (closeError) { cleanupErrors.push(closeError); }
      try { this.rollbackRuntimeLease?.release(); } catch (releaseError) { cleanupErrors.push(releaseError); }
      try { this.writerLease?.release(); } catch (releaseError) { cleanupErrors.push(releaseError); }
      this.closed = true;
      if (primary !== undefined || cleanupErrors.length > 0) {
        throw withCleanupErrors(primary, cleanupErrors, "memory-bujo close failed");
      }
    }
  }

  /** Drain admitted direct operations before freezing downstream queues. */
  private async drainAcceptedWork(): Promise<void> {
    await Promise.all([...this.admittedOperations].map(async (operation) => await operation.settled));
    // A completed-turn projection may enqueue a Journal vector. Freeze and
    // drain intake while the downstream queues still accept that work, then
    // close those queues only after all startup recovery has also enqueued.
    this.completedTurnIntake?.stopAccepting();
    await this.flush();
    this.indexQueue?.stopAccepting();
    this.captureQueue?.stopAccepting();
  }

  private initializeJournalIndexing(): void {
    this.indexQueue = new BoundedBatchQueue<IndexJob>({
      maxItems: JOURNAL_QUEUE_MAX_ITEMS,
      maxBytes: JOURNAL_QUEUE_MAX_BYTES,
      batchSize: 32,
      // Lexical rows are already durable. After one provider failure, defer
      // every queued vector job to the missing-vector recovery pass so one
      // outage attempt cannot amplify into eight sequential provider calls.
      discardQueuedOnError: true,
      process: async (jobs) => {
        const controller = new AbortController();
        this.activeIndexController = controller;
        try {
          await this.db.indexVectors(jobs.map((job) => job.record), {
            batchSize: 32,
            abortSignal: controller.signal,
          });
          this.journalRecoveryPaused = false;
          this.journalRetryAttempt = 0;
          this.currentJournalRetryDelayMs = 0;
          this.nextJournalRetryAt = undefined;
        } catch (error) {
          this.journalRecoveryPaused = true;
          this.scheduleJournalRetry();
          throw error;
        } finally {
          if (this.activeIndexController === controller) this.activeIndexController = undefined;
        }
      },
      onBatchSettled: () => {
        if (!this.journalRecoveryPaused) this.refillJournalQueue();
      },
      onError: (error) => this.safeWarn(`journal indexing failed: ${reasonOf(error)}`),
      onChange: () => this.scheduleRuntimeSnapshot(),
    });
    this.initializeJournalRecoveryCursor();
  }

  private initializeCaptureQueue(): void {
    if (this.captureQueue !== undefined) return;
    this.captureQueue = new BoundedBatchQueue<CaptureJob>({
      maxItems: CAPTURE_QUEUE_MAX_ITEMS,
      maxBytes: CAPTURE_QUEUE_MAX_BYTES,
      batchSize: 1,
      process: async (jobs) => {
        for (const job of jobs) {
          const controller = new AbortController();
          this.activeCaptureController = controller;
          try {
            await this.captureAccepted(job.conversationId, job.text, controller.signal);
          } finally {
            if (this.activeCaptureController === controller) this.activeCaptureController = undefined;
          }
        }
      },
      onError: (error) => this.safeWarn(`bujo capture failed: ${reasonOf(error)}`),
      onChange: () => this.scheduleRuntimeSnapshot(),
    });
  }

  private initializeCompletedTurnIntake(): void {
    this.completedTurnIntake = new CompletedTurnIntakeManager({
      root: this.root,
      clock: this.clock,
      writeSummary: async (turn, id, admittedAt, signal) => {
        await this.appendCompletedTurnSummary(turn, id, admittedAt, signal);
      },
      capture: async (turn, id, admittedAt, signal) => await this.captureCompletedTurn(
        turn,
        id,
        admittedAt,
        signal,
      ),
      afterResolved: async (id) => await withSerializedBujoMutation({
        root: this.root,
        db: this.db,
        tier: this._tier,
        canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
      }, async () => { removeRetainedCaptureIntent(this.root, id); }),
      cleanupResolved: (ids) => {
        const resolved = new Set(ids);
        for (const key of listRetainedCaptureIntentKeys(this.root)) {
          if (resolved.has(key)) removeRetainedCaptureIntent(this.root, key);
        }
      },
      onChange: (urgency) => {
        if (urgency === "urgent") this.publishRuntimeSnapshotImmediately("running");
        else this.scheduleRuntimeSnapshot();
      },
      warn: (message) => this.safeWarn(message),
    });
  }

  private instrumentEmbeddings(provider: EmbeddingProvider): EmbeddingProvider {
    return {
      id: provider.id,
      embed: async (texts) => {
        this.runtimeCounters.embeddingCalls += 1;
        this.runtimeCounters.embeddingTexts += texts.length;
        this.scheduleRuntimeSnapshot();
        return await provider.embed(texts);
      },
    };
  }

  private instrumentLlm(llm: LlmComplete): LlmComplete {
    return {
      id: llm.id,
      complete: async (prompt, options) => {
        this.runtimeCounters.llmCalls += 1;
        this.runtimeCounters.llmInputChars += prompt.length;
        this.scheduleRuntimeSnapshot();
        return await llm.complete(prompt, options);
      },
    };
  }

  private initializeRuntimeSnapshot(): void {
    this.runtimeSnapshotEnabled = true;
    this.publishRuntimeSnapshot("running");
    this.runtimeHeartbeatTimer = setInterval(() => this.publishRuntimeSnapshot("running"), RUNTIME_SNAPSHOT_HEARTBEAT_MS);
    this.runtimeHeartbeatTimer.unref?.();
  }

  private scheduleRuntimeSnapshot(): void {
    if (!this.runtimeSnapshotEnabled || this.closing || this.closed || this.runtimeSnapshotTimer !== undefined) return;
    this.runtimeSnapshotTimer = setTimeout(() => {
      this.runtimeSnapshotTimer = undefined;
      this.publishRuntimeSnapshot("running");
    }, RUNTIME_SNAPSHOT_COALESCE_MS);
    this.runtimeSnapshotTimer.unref?.();
  }

  private publishRuntimeSnapshotImmediately(state: "running" | "closed"): void {
    if (this.runtimeSnapshotTimer !== undefined) clearTimeout(this.runtimeSnapshotTimer);
    this.runtimeSnapshotTimer = undefined;
    this.publishRuntimeSnapshot(state);
  }

  private publishRuntimeSnapshot(state: "running" | "closed"): void {
    if (!this.runtimeSnapshotEnabled) return;
    try {
      writeBujoRuntimeSnapshot(this.root, {
        schemaVersion: 1,
        pid: process.pid,
        tier: this._tier,
        state,
        startedAt: this.runtimeStartedAt,
        updatedAt: new Date().toISOString(),
        queues: this.queueSnapshot(),
        counters: this.runtimeCounters as BujoRuntimeCounters,
      });
    } catch (error) {
      this.safeWarn(`memory runtime snapshot failed: ${reasonOf(error)}`);
    }
  }

  private disableRuntimeTimers(): void {
    if (this.runtimeSnapshotTimer !== undefined) clearTimeout(this.runtimeSnapshotTimer);
    if (this.runtimeHeartbeatTimer !== undefined) clearInterval(this.runtimeHeartbeatTimer);
    this.runtimeSnapshotTimer = undefined;
    this.runtimeHeartbeatTimer = undefined;
  }

  private enqueueIndex(record: MemoryRecord): void {
    const outcome = this.indexQueue?.enqueue({
      key: record.id,
      bytes: Buffer.byteLength(record.text, "utf8"),
      record,
    });
    if (outcome === "dropped") this.safeWarn("journal index queue is full; lexical memory is durable and semantic indexing remains backlogged.");
  }

  private refillJournalQueue(): void {
    if (this.closing || this.indexQueue === undefined || this.journalRecoveryPaused) return;
    const before = this.indexQueue.snapshot();
    const availableItems = before.capacity.items - before.queued - before.inFlight;
    const availableBytes = before.capacity.bytes - before.queuedBytes - before.inFlightBytes;
    if (availableItems <= 0 || availableBytes <= 0) return;
    this.journalRecoveryRefillQueries += 1;
    const records = this.db.recordsMissingVectors(availableItems, this.indexQueue.activeKeyList());
    this.journalRecoveryRowsScanned += records.length;
    for (const record of records) {
      // Internal recovery polling is not a duplicate user enqueue. Skip active
      // ids before calling enqueue so `coalesced` remains truthful and we avoid
      // repeatedly cycling queued records through queue accounting.
      if (this.indexQueue.hasKey(record.id)) continue;
      const snapshot = this.indexQueue.snapshot();
      const bytes = Buffer.byteLength(record.text, "utf8");
      if (
        snapshot.queued + snapshot.inFlight >= snapshot.capacity.items
        || snapshot.queuedBytes + snapshot.inFlightBytes + bytes > snapshot.capacity.bytes
      ) break;
      this.enqueueIndex(record);
    }
  }

  private initializeJournalRecoveryCursor(): void {
    this.journalRecoveryFiles = listCanonicalFileNames(this.root, "daily", {
      allowMissing: true,
      include: (file) => file.endsWith(".md"),
    });
    if (this.journalRecoveryFiles.length === 0) return;
    this.journalRecoveryPromise = new Promise<void>((resolve) => { this.resolveJournalRecovery = resolve; });
    setImmediate(() => this.scanNextJournalFile());
  }

  private scanNextJournalFile(): void {
    if (this.closing) {
      this.resolveJournalRecovery?.();
      this.resolveJournalRecovery = undefined;
      return;
    }
    const file = this.journalRecoveryFiles[this.journalRecoveryCursor];
    if (file === undefined) {
      this.resolveJournalRecovery?.();
      this.resolveJournalRecovery = undefined;
      this.refillJournalQueue();
      return;
    }
    try {
      const snapshot = readCanonicalFileSnapshot(this.root, `daily/${file}`);
      if (snapshot === undefined) throw new Error(`memory-bujo: canonical daily file "${file}" disappeared.`);
      const parsed = parseDailyFile(snapshot.content);
      for (const line of parsed.lines) {
        const bullet = line.bullet;
        if (bullet === undefined) continue;
        const hash = normalizedContentHash(bullet.text);
        const record: MemoryRecord = {
          // Journal's canonical index identity is content-derived. Legacy ids
          // remain untouched in Markdown but cannot create competing recall rows.
          id: `J-${hash}`,
          type: bullet.type,
          status: bullet.status,
          text: bullet.text,
          salience: bullet.salience,
          isInsight: bullet.isInsight,
          createdAt: bullet.createdAt,
          accessCount: 0,
          tags: [],
          source: { file: `daily/${file}`, line: line.lineNumber },
          ...(bullet.dueAt === undefined ? {} : { dueAt: bullet.dueAt }),
        };
        this.db.recoverJournalLexical(record, hash, bullet.id);
      }
    } catch (error) {
      this.safeWarn(`journal startup recovery skipped ${file}: ${reasonOf(error)}`);
    } finally {
      this.journalRecoveryCursor += 1;
      this.refillJournalQueue();
      setImmediate(() => this.scanNextJournalFile());
    }
  }

  private scheduleJournalRetry(): void {
    if (this.closing || this.journalRetryTimer !== undefined) return;
    const delay = retryDelayMs(this.journalRetryAttempt);
    this.currentJournalRetryDelayMs = delay;
    this.journalRetryAttempt += 1;
    this.nextJournalRetryAt = new Date(Date.now() + delay);
    this.journalRetryTimer = setTimeout(() => {
      this.journalRetryTimer = undefined;
      this.nextJournalRetryAt = undefined;
      this.currentJournalRetryDelayMs = 0;
      if (this.closing) return;
      this.journalRecoveryPaused = false;
      this.refillJournalQueue();
    }, delay);
    this.journalRetryTimer.unref?.();
  }

  private safeWarn(message: string): void {
    try {
      this.logger.warn(message);
    } catch {
      // A logger failure cannot poison memory queues or provider turns.
    }
  }

  private remainingIndexBacklog(): number {
    if (this.closed) return this.lastKnownMissingVectors;
    this.lastKnownMissingVectors = this.db.countMissingVectors();
    return this.lastKnownMissingVectors;
  }

  /**
   * Admit one direct async operation synchronously, then expose a store-owned
   * abort signal to every provider boundary before canonical or SQLite access.
   * close() takes a stable snapshot after setting `closing`, so no operation can
   * be missed by the drain barrier.
   */
  private async runAdmittedMutation<T>(
    operation: string,
    run: (abortSignal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    return await this.runAdmittedWrite(operation, async (abortSignal) => await withSerializedBujoMutation({
      root: this.root,
      db: this.db,
      tier: this._tier,
      abortSignal,
      canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
    }, async () => await run(abortSignal)), callerSignal);
  }

  private async runAdmittedWrite<T>(
    operation: string,
    run: (abortSignal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    this.assertWritable(operation);
    return await this.runAdmittedOperation(run, callerSignal);
  }

  private async runAdmittedOperation<T>(
    run: (abortSignal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const abortSignal = callerSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, callerSignal]);
    let markSettled!: () => void;
    const admitted: AdmittedOperation = {
      controller,
      settled: new Promise<void>((resolve) => { markSettled = resolve; }),
    };
    this.admittedOperations.add(admitted);
    try {
      abortSignal.throwIfAborted();
      return await run(abortSignal);
    } finally {
      this.admittedOperations.delete(admitted);
      markSettled();
    }
  }

  private assertWritable(operation: string): void {
    if (this.readOnly) throw new Error(`memory-bujo: read-only store rejects ${operation}.`);
    this.assertOpen(operation);
  }

  private assertOpen(operation: string): void {
    if (this.closing || this.closed) {
      throw new Error(`memory-bujo: closing or closed store rejects ${operation}.`);
    }
  }
}

export function createBujoMemoryStore(options: BujoOptions): BujoMemoryStore {
  return new BujoMemoryStore(options);
}

function assertTierPrerequisites(tier: BujoTier, options: BujoOptions): void {
  if (tier !== "lite" && tier !== "journal" && tier !== "bujo") {
    throw new Error(`memory-bujo: unsupported tier "${String(tier)}".`);
  }
  if (options.readOnly === true && options.allowFtsFallback === true) return;
  if (tier === "lite") {
    if (options.embeddings !== undefined || options.llm !== undefined || options.dim !== undefined) {
      throw new Error("memory-bujo: lite tier is lexical-only and rejects embeddings, dimensions, and capture LLMs.");
    }
    return;
  }
  if (options.embeddings === undefined || options.dim === undefined) {
    throw new Error(`memory-bujo: ${tier} tier requires embeddings and an explicit vector dimension.`);
  }
  if (tier === "journal") {
    if (options.llm !== undefined) {
      throw new Error("memory-bujo: journal tier rejects capture LLMs; select bujo for curated capture.");
    }
    return;
  }
  if (options.llm === undefined && options.readOnly !== true) {
    throw new Error("memory-bujo: bujo tier requires a capture LLM.");
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withCleanupErrors(primary: unknown, cleanup: readonly unknown[], message: string): unknown {
  if (cleanup.length === 0) return primary;
  return new AggregateError(primary === undefined ? cleanup : [primary, ...cleanup], message);
}

async function serializeJournalWrite<T>(
  root: string,
  abortSignal: AbortSignal,
  write: () => T | Promise<T>,
): Promise<T> {
  const prior = JOURNAL_WRITE_CHAINS.get(root) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = prior.then(() => mine);
  JOURNAL_WRITE_CHAINS.set(root, tail);
  await prior;
  try {
    abortSignal.throwIfAborted();
    return await write();
  } finally {
    release();
    if (JOURNAL_WRITE_CHAINS.get(root) === tail) JOURNAL_WRITE_CHAINS.delete(root);
  }
}

async function withJournalWriteLockRetry<T>(
  root: string,
  timeoutMs: number,
  abortSignal: AbortSignal,
  write: () => T,
): Promise<T> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    abortSignal.throwIfAborted();
    try {
      return withJournalWriteLock(root, write);
    } catch (error) {
      if (!/journal write lock is held/iu.test(reasonOf(error)) || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
      abortSignal.throwIfAborted();
    }
  }
}

function retryDelayMs(attempt: number): number {
  return Math.min(JOURNAL_RETRY_MAX_DELAY_MS, JOURNAL_RETRY_DELAY_MS * (2 ** Math.min(attempt, 10)));
}

/** Stable per-run ids make semantic ADD/SUPERSEDE replay converge after a post-commit crash. */
function completedTurnCaptureIdFactory(intakeId: string): () => string {
  let index = 0;
  return () => {
    const id = `C-${intakeId}-${String(index).padStart(2, "0")}`;
    index += 1;
    return id;
  };
}

async function waitForDrain(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
