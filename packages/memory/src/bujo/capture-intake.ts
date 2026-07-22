import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

import type {
  MemoryCompletedTurn,
  MemoryCompletedTurnAdmissionStatus,
} from "@mono-agent/agent-contracts";

import { acquireMemoryWriterLease } from "./generations.js";
import { findRetainedCaptureIntent } from "./capture-outbox.js";
import {
  appendCanonicalFile,
  canonicalMemoryRootPath,
  listCanonicalFileNames,
  readCanonicalFileSnapshot,
  removeCanonicalFile,
  writeCanonicalFileAtomic,
  type CanonicalFileIdentity,
} from "./path-safety.js";
import { BUJO_RUNTIME_SNAPSHOT_STALE_AFTER_MS } from "./runtime-snapshot.js";

export const COMPLETED_TURN_INTAKE_SCHEMA_VERSION = 1;

const INTAKE_ROOT = ".capture-intake";
const INTAKE_SCHEMA_MARKER = ".capture-intake-v1";
const STATES = ["pending", "dead", "resolved"] as const;
const LEDGER_ROOT = "ledger";
const LEDGER_CATALOG_FILE = "ledger-v1.catalog";
const LEDGER_CATALOG_HEADER = "mono-agent-completed-turn-ledger-v1";
const LEDGER_CATALOG_TEMP_NAME = /^\.ledger-v1\.catalog-[a-f0-9-]{36}\.tmp$/u;
const LEDGER_SHARDS = Array.from({ length: 256 }, (_unused, index) => index.toString(16).padStart(2, "0"));
const FILE_NAME = /^[a-f0-9]{64}\.json$/u;
const ORPHAN_TEMP_NAME = /^\.[a-f0-9]{64}\.json-[a-f0-9-]{36}\.tmp$/u;
const LEDGER_FILE_NAME = /^[a-f0-9]{2}\.log$/u;
const LEDGER_ENTRY = /^([a-f0-9]{64})([a-f0-9]{64})\n$/u;
const LEDGER_ENTRY_BYTES = 129;
const LEDGER_CATALOG_LINE = /^([a-f0-9]{2}) ([0-9]{16}) ([a-f0-9]{64})$/u;
const LEDGER_CATALOG_MAX_BYTES = 32 * 1024;
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const ID = /^[a-f0-9]{64}$/u;
const SAFE_REASON = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_RUN_ID_BYTES = 1_024;
const MAX_CONVERSATION_ID_BYTES = 4_096;
const MAX_SUMMARY_BYTES = 64 * 1024;
const MAX_CAPTURE_TEXT_BYTES = 512 * 1024;
const MAX_RECORD_BYTES = 640 * 1024;
const DEFAULT_MAX_ACTIVE_RECORDS = 4_096;
const DEFAULT_MAX_ATTEMPTS = 16;
const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_RETRY_MAX_MS = 6 * 60 * 60_000;
const DEFAULT_RESOLVED_RETENTION = 4_096;
const MAX_FILES_PER_STATE = DEFAULT_MAX_ACTIVE_RECORDS + 1;

type IntakeState = (typeof STATES)[number];
type FailureCode = "model_output" | "provider" | "processing";
type ResolutionOutcome = "captured" | "summary_only" | "operator_resolved";

interface IntakePayload {
  readonly runId: string;
  readonly conversationId: string;
  readonly summary: string;
  readonly captureText?: string;
}

interface PendingRecord extends IntakePayload {
  readonly schemaVersion: typeof COMPLETED_TURN_INTAKE_SCHEMA_VERSION;
  readonly state: "pending";
  readonly id: string;
  readonly payloadHash: string;
  readonly admittedAt: string;
  readonly revision: number;
  readonly attempt: number;
  readonly nextAttemptAt: string;
  readonly summaryWritten: boolean;
  readonly lastError?: FailureCode;
}

interface DeadRecord extends IntakePayload {
  readonly schemaVersion: typeof COMPLETED_TURN_INTAKE_SCHEMA_VERSION;
  readonly state: "dead";
  readonly id: string;
  readonly payloadHash: string;
  readonly admittedAt: string;
  readonly revision: number;
  readonly attempt: number;
  readonly deadAt: string;
  readonly summaryWritten: boolean;
  readonly lastError: FailureCode;
}

interface ResolvedRecord {
  readonly schemaVersion: typeof COMPLETED_TURN_INTAKE_SCHEMA_VERSION;
  readonly state: "resolved";
  readonly id: string;
  readonly payloadHash: string;
  readonly admittedAt: string;
  readonly resolvedAt: string;
  readonly revision: number;
  readonly attempt: number;
  readonly outcome: ResolutionOutcome;
  readonly reason?: string;
}

type IntakeRecord = PendingRecord | DeadRecord | ResolvedRecord;

interface IntakeRuntimeCacheEntry {
  readonly state: IntakeState;
  readonly admittedAt: string;
  readonly nextAttemptAt?: string;
  readonly resolvedAt?: string;
}

interface LocatedRecord<T extends IntakeRecord = IntakeRecord> {
  readonly record: T;
  readonly relativePath: string;
  readonly identity: CanonicalFileIdentity;
  readonly bytes: number;
}

export interface CompletedTurnIntakeAdmission {
  readonly id: string;
  readonly source: string;
  readonly bytesWritten: number;
  readonly admissionStatus: MemoryCompletedTurnAdmissionStatus;
}

export interface CompletedTurnIntakeItem {
  readonly id: string;
  readonly state: IntakeState;
  readonly admittedAt: string;
  readonly attempt: number;
  readonly revision: number;
  readonly due: boolean;
  readonly lastError?: FailureCode;
}

export interface CompletedTurnIntakeSnapshot {
  readonly pending: number;
  readonly dead: number;
  readonly resolved: number;
  readonly due: number;
  /** Crash-window source/destination pairs that a writer can retire safely. */
  readonly transitioning: number;
  readonly retrying: number;
  readonly accepting: boolean;
  readonly shutdown: "running" | "drained" | "pending" | "timed_out";
}

export interface CompletedTurnIntakeInspection {
  readonly schemaVersion: typeof COMPLETED_TURN_INTAKE_SCHEMA_VERSION;
  readonly items: readonly CompletedTurnIntakeItem[];
  /** Valid atomic-write remnants. Their presence still requires recovery. */
  readonly temporary: number;
  readonly snapshot: Omit<CompletedTurnIntakeSnapshot, "accepting" | "shutdown" | "retrying">;
}

export interface CompletedTurnIntakeAudit {
  readonly valid: boolean;
  readonly inspection?: CompletedTurnIntakeInspection;
  /** Physical metadata remains available even when one record is malformed. */
  readonly counts: {
    readonly pending: number;
    readonly due: number;
    readonly dead: number;
    readonly temporary: number;
  };
  /** Metadata-only codes. Paths, payloads, model text, and provider errors are never exposed. */
  readonly issues: readonly ("invalid_layout" | "invalid_record" | "capacity_exceeded" | "state_conflict")[];
}

/** Internal-only, content-free stability metadata consumed by strict health. */
export interface CompletedTurnIntakePrivateHealthState {
  readonly oldestDueAt?: string;
  readonly digest: string;
}

/** Internal module contract; intentionally not exported from the package subpath. */
export interface CompletedTurnIntakeHealthAudit {
  readonly audit: CompletedTurnIntakeAudit;
  readonly privateState: CompletedTurnIntakePrivateHealthState;
}

export interface CompletedTurnIntakeManagerOptions {
  readonly root: string;
  readonly clock: () => Date;
  readonly writeSummary: (
    turn: MemoryCompletedTurn,
    id: string,
    admittedAt: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly capture: (
    turn: MemoryCompletedTurn,
    id: string,
    admittedAt: string,
    signal: AbortSignal,
  ) => Promise<"captured" | "summary_only">;
  /** Retire a run-owned semantic plan only after its resolved receipt is durable. */
  readonly afterResolved?: (id: string) => void | Promise<void>;
  /** Startup cleanup for receipts published before a crash interrupted plan retirement. */
  readonly cleanupResolved?: (ids: readonly string[]) => void;
  /** Content-free notification after intake runtime or durable metadata changes. */
  readonly onChange?: (urgency?: "urgent") => void;
  readonly warn?: (message: string) => void;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly maxActiveRecords?: number;
  readonly resolvedRetention?: number;
  /** Test-only crash seam after the run-derived summary is durable but before intake state advances. */
  readonly afterSummaryPersisted?: (id: string) => void;
  /** Test-only crash seam after a destination is durable but before its lower-revision source retires. */
  readonly beforeStateSourceRetirement?: (id: string, state: "dead" | "resolved") => void;
}

/**
 * Durable, idempotent completed-turn admission and serialized restartable processing.
 *
 * Admission performs no provider work. It returns only after a private pending
 * record and its containing directory entry have been fsynced. The worker is a
 * projection of that durable tree; it is deliberately unbounded in memory up
 * to the bounded on-disk record count and therefore cannot silently drop an
 * already-admitted turn under queue pressure.
 */
export class CompletedTurnIntakeManager {
  private readonly root: string;
  private readonly clock: () => Date;
  private readonly writeSummary: CompletedTurnIntakeManagerOptions["writeSummary"];
  private readonly capture: CompletedTurnIntakeManagerOptions["capture"];
  private readonly warn: (message: string) => void;
  private readonly afterResolved: ((id: string) => void | Promise<void>) | undefined;
  private readonly cleanupResolved: ((ids: readonly string[]) => void) | undefined;
  private readonly onChange: (urgency?: "urgent") => void;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxActiveRecords: number;
  private readonly resolvedRetention: number;
  private readonly afterSummaryPersisted: ((id: string) => void) | undefined;
  private readonly beforeStateSourceRetirement:
    ((id: string, state: "dead" | "resolved") => void) | undefined;
  private accepting = true;
  private stopped = false;
  private timedOut = false;
  private activeController: AbortController | undefined;
  private worker: Promise<void> | undefined;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly runtimeRecords = new Map<string, IntakeRuntimeCacheEntry>();
  private runtimeTransitioning = 0;

  constructor(options: CompletedTurnIntakeManagerOptions) {
    this.root = canonicalMemoryRootPath(options.root, true);
    this.clock = options.clock;
    this.writeSummary = options.writeSummary;
    this.capture = options.capture;
    this.warn = options.warn ?? (() => {});
    this.afterResolved = options.afterResolved;
    this.cleanupResolved = options.cleanupResolved;
    this.onChange = options.onChange ?? (() => {});
    this.maxAttempts = positiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, "maxAttempts");
    this.retryBaseMs = positiveInteger(options.retryBaseMs, DEFAULT_RETRY_BASE_MS, "retryBaseMs");
    this.retryMaxMs = positiveInteger(options.retryMaxMs, DEFAULT_RETRY_MAX_MS, "retryMaxMs");
    this.maxActiveRecords = positiveInteger(options.maxActiveRecords, DEFAULT_MAX_ACTIVE_RECORDS, "maxActiveRecords");
    this.resolvedRetention = positiveInteger(
      options.resolvedRetention,
      DEFAULT_RESOLVED_RETENTION,
      "resolvedRetention",
    );
    this.afterSummaryPersisted = options.afterSummaryPersisted;
    this.beforeStateSourceRetirement = options.beforeStateSourceRetirement;
    if (intakeLayoutExists(this.root)) {
      // Upgrade an older intake tree by adding the compact permanent ledger,
      // then seed it from every still-materialized record before accepting a
      // duplicate decision. Pruned pre-ledger receipts cannot be recovered,
      // but all post-upgrade admissions remain exact for the life of the root.
      ensureLayout(this.root, true);
      retireOrphanIntakeTemps(this.root);
      recoverStateConflicts(this.root);
      const materialized = logicalRecords(STATES.flatMap((state) => listRecords(this.root, state)));
      ensureLedgerEntries(this.root, materialized.located.map(({ record }) => ({
        id: record.id,
        payloadHash: record.payloadHash,
      })));
      this.seedRuntimeCache(materialized.located, materialized.transitioning);
      if (this.activeRuntimeRecordCount() > this.maxActiveRecords) {
        throw new Error("memory-bujo: completed-turn intake active-record capacity is exceeded.");
      }
      this.cleanupResolved?.(
        materialized.located.filter(({ record }) => record.state === "resolved").map(({ record }) => record.id),
      );
      this.scheduleWorker();
      this.notifyChange();
    } else if (readIntakeSchemaMarker(this.root) !== undefined) {
      throw new Error("memory-bujo: initialized completed-turn intake layout is missing.");
    }
  }

  /** Synchronously validate and durably publish one completed turn. */
  admit(turn: MemoryCompletedTurn): CompletedTurnIntakeAdmission {
    if (!this.accepting || this.stopped) {
      throw new Error("memory-bujo: completed-turn intake is closing or closed.");
    }
    const payload = validatePayload(turn);
    ensureLayout(this.root, true);
    const id = idFor(payload.runId);
    const payloadHash = hashPayload(payload);
    const existing = locateById(this.root, id);
    if (existing.length > 0) {
      if (existing.some(({ record }) => record.payloadHash !== payloadHash)) {
        throw new Error("memory-bujo: completed-turn run id conflicts with an already admitted payload.");
      }
      const preferred = preferredRecord(existing)!;
      ensureLedgerEntry(this.root, id, payloadHash);
      if (existing.length > 1) this.refreshRuntimeCacheFromDisk();
      else this.setRuntimeRecord(preferred.record);
      if (preferred.record.state === "pending") this.scheduleWorker();
      this.notifyChange();
      return {
        id,
        source: join(this.root, preferred.relativePath),
        bytesWritten: 0,
        admissionStatus: "duplicate",
      };
    }

    const ledger = lookupLedgerEntry(this.root, id);
    if (ledger !== undefined) {
      if (ledger.payloadHash !== payloadHash) {
        throw new Error("memory-bujo: completed-turn run id conflicts with the permanent admission ledger.");
      }
      this.notifyChange();
      return {
        id,
        source: join(this.root, ledger.relativePath),
        bytesWritten: 0,
        admissionStatus: "duplicate",
      };
    }

    if (this.activeRuntimeRecordCount() >= this.maxActiveRecords) {
      throw new Error("memory-bujo: completed-turn intake is full; admission was not published.");
    }
    const admittedAt = canonicalNow(this.clock);
    const record: PendingRecord = {
      schemaVersion: COMPLETED_TURN_INTAKE_SCHEMA_VERSION,
      state: "pending",
      id,
      payloadHash,
      runId: payload.runId,
      conversationId: payload.conversationId,
      summary: payload.summary,
      ...(payload.captureText === undefined ? {} : { captureText: payload.captureText }),
      admittedAt,
      revision: 0,
      attempt: 0,
      nextAttemptAt: admittedAt,
      summaryWritten: false,
    };
    let written: LocatedRecord<PendingRecord>;
    try {
      written = writeRecord(this.root, "pending", record) as LocatedRecord<PendingRecord>;
      this.setRuntimeRecord(written.record);
    } catch (error) {
      // A second process holding the same higher-level writer discipline can
      // still race at a restart boundary. Converge only when the safely-read
      // winner is the exact same payload; every other write fault propagates.
      const raced = locateById(this.root, id);
      if (raced.length === 0) throw error;
      if (raced.some(({ record: candidate }) => candidate.payloadHash !== payloadHash)) {
        throw new Error("memory-bujo: completed-turn run id conflicts with a concurrently admitted payload.");
      }
      const preferred = preferredRecord(raced)!;
      ensureLedgerEntry(this.root, id, payloadHash);
      this.refreshRuntimeCacheFromDisk();
      if (preferred.record.state === "pending") this.scheduleWorker();
      this.notifyChange();
      return {
        id,
        source: join(this.root, preferred.relativePath),
        bytesWritten: 0,
        admissionStatus: "duplicate",
      };
    }
    // Publish the content-free permanent admission commitment only after the
    // recoverable pending payload is durable. A crash between these writes is
    // repaired from the pending record on startup; a crash after this append
    // can never make the run id admissible again after rich receipt pruning.
    ensureLedgerEntry(this.root, id, payloadHash);
    this.notifyChange();
    this.scheduleWorker();
    return {
      id,
      source: join(this.root, written.relativePath),
      bytesWritten: written.bytes,
      admissionStatus: "admitted",
    };
  }

  /** Process all records due at the current clock and await the active attempt. */
  async flush(): Promise<void> {
    if (this.stopped) return;
    this.clearWakeTimer();
    this.startWorker();
    await this.worker;
  }

  stopAccepting(): void {
    this.accepting = false;
    this.clearWakeTimer();
    this.notifyChange();
  }

  abortForShutdown(timedOut: boolean): void {
    this.accepting = false;
    this.stopped = true;
    this.timedOut = timedOut;
    this.clearWakeTimer();
    this.activeController?.abort(new Error("completed-turn intake shutdown"));
    this.notifyChange();
  }

  finishShutdown(): void {
    this.accepting = false;
    this.stopped = true;
    this.clearWakeTimer();
    this.notifyChange();
  }

  snapshot(): CompletedTurnIntakeSnapshot {
    const nowMs = this.clock().getTime();
    let pending = 0;
    let dead = 0;
    let resolved = 0;
    let due = 0;
    for (const record of this.runtimeRecords.values()) {
      if (record.state === "pending") {
        pending += 1;
        if (record.nextAttemptAt !== undefined && Date.parse(record.nextAttemptAt) <= nowMs) due += 1;
      } else if (record.state === "dead") dead += 1;
      else resolved += 1;
    }
    return {
      pending,
      dead,
      resolved,
      due,
      transitioning: this.runtimeTransitioning,
      retrying: this.activeController === undefined ? 0 : 1,
      accepting: this.accepting && !this.stopped,
      shutdown: this.timedOut
        ? "timed_out"
        : !this.stopped
          ? "running"
          : pending > 0
            ? "pending"
            : "drained",
    };
  }

  private scheduleWorker(): void {
    if (this.stopped || this.worker !== undefined) return;
    setImmediate(() => this.startWorker()).unref?.();
  }

  private startWorker(): void {
    if (this.stopped || this.worker !== undefined) return;
    let workerFaulted = false;
    this.worker = this.runWorker().catch(() => {
      workerFaulted = true;
      safeWarn(this.warn, "completed-turn intake worker paused; durable state remains for restart or retry.");
    }).finally(() => {
      this.worker = undefined;
      if (!this.stopped && !workerFaulted) {
        try { this.scheduleNextWake(); } catch {
          safeWarn(this.warn, "completed-turn intake wake scheduling failed; durable state remains for restart.");
        }
      }
    });
  }

  private async runWorker(): Promise<void> {
    this.recoverRuntimeTransitionsIfNeeded();
    for (;;) {
      if (this.stopped) return;
      const dueId = this.nextPendingRuntimeId(true);
      if (dueId === undefined) return;
      let due: LocatedRecord<PendingRecord>;
      try {
        const located = readRecord(this.root, "pending", dueId);
        if (located.record.state !== "pending") throw new Error("memory-bujo: cached intake state is not pending.");
        due = located as LocatedRecord<PendingRecord>;
      } catch (error) {
        this.refreshRuntimeCacheAfterFault();
        this.notifyChange();
        throw error;
      }
      await this.processOne(due);
    }
  }

  private async processOne(initial: LocatedRecord<PendingRecord>): Promise<void> {
    const controller = new AbortController();
    this.activeController = controller;
    // An aged due record must never look abandoned after processing has
    // actually begun. Publish retrying=1 without the ordinary coalescing delay.
    const ageMs = this.clock().getTime() - Date.parse(initial.record.nextAttemptAt);
    this.notifyChange(ageMs >= BUJO_RUNTIME_SNAPSHOT_STALE_AFTER_MS ? "urgent" : undefined);
    let current = initial;
    try {
      const turn = payloadOf(current.record);
      if (!current.record.summaryWritten) {
        await this.writeSummary(turn, current.record.id, current.record.admittedAt, controller.signal);
        controller.signal.throwIfAborted();
        this.afterSummaryPersisted?.(current.record.id);
        const advanced: PendingRecord = { ...current.record, summaryWritten: true };
        current = replaceRecord(this.root, current, advanced);
        this.setRuntimeRecord(current.record);
        this.notifyChange();
      }
      const outcome = await this.capture(turn, current.record.id, current.record.admittedAt, controller.signal);
      controller.signal.throwIfAborted();
      const resolved = resolvePending(
        this.root,
        current,
        outcome,
        canonicalNow(this.clock),
        this.beforeStateSourceRetirement,
      );
      this.setRuntimeRecord(resolved.record);
      this.notifyChange();
      await this.afterResolved?.(current.record.id);
      this.recoverRuntimeTransitionsIfNeeded();
      const retired = pruneResolved(
        this.root,
        this.resolvedRetention,
        current.record.id,
        this.resolvedRuntimeInventory(),
      );
      for (const id of retired) this.runtimeRecords.delete(id);
      this.notifyChange();
    } catch (error) {
      if (controller.signal.aborted || this.stopped) return;
      let logical: LocatedRecord | undefined;
      try {
        logical = preferredRecord(locateById(this.root, current.record.id));
      } catch (refreshError) {
        this.refreshRuntimeCacheAfterFault();
        this.notifyChange();
        throw refreshError;
      }
      // A state transition publishes its higher revision before retiring the
      // source. If retirement itself failed, the destination already owns the
      // logical turn and the lower pending source must never be rewritten to
      // the same revision.
      if (logical === undefined || logical.record.state !== "pending") {
        this.refreshRuntimeCacheAfterFault();
        this.notifyChange();
        safeWarn(this.warn, "completed-turn intake transition published; deferred cleanup remains for startup.");
        throw error;
      }
      const latest = logical as LocatedRecord<PendingRecord>;
      this.setRuntimeRecord(latest.record);
      const attempt = latest.record.attempt + 1;
      const lastError = failureCode(error);
      if (attempt >= this.maxAttempts) {
        try {
          const dead = moveToDead(
            this.root,
            latest,
            attempt,
            lastError,
            canonicalNow(this.clock),
            this.beforeStateSourceRetirement,
          );
          this.setRuntimeRecord(dead.record);
        } catch (transitionError) {
          this.refreshRuntimeCacheAfterFault();
          this.notifyChange();
          throw transitionError;
        }
        this.notifyChange();
        safeWarn(this.warn, "completed-turn capture reached its retry limit; a durable dead letter remains.");
      } else {
        const now = this.clock();
        const nextAttemptAt = new Date(now.getTime() + retryDelay(
          attempt,
          this.retryBaseMs,
          this.retryMaxMs,
        )).toISOString();
        try {
          const pending = replaceRecord(this.root, latest, {
            ...latest.record,
            attempt,
            nextAttemptAt,
            lastError,
          });
          this.setRuntimeRecord(pending.record);
        } catch (transitionError) {
          this.refreshRuntimeCacheAfterFault();
          this.notifyChange();
          throw transitionError;
        }
        this.notifyChange();
        safeWarn(this.warn, "completed-turn capture failed; a durable retry is scheduled.");
      }
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
      this.notifyChange();
    }
  }

  private scheduleNextWake(): void {
    if (this.stopped) return;
    // Reconcile the timer from the current durable inventory every time. A new
    // turn can fail while a later retry already owns the wake, and that earlier
    // deadline must preempt the stale timer instead of waiting behind it.
    this.clearWakeTimer();
    const nextId = this.nextPendingRuntimeId(false);
    const next = nextId === undefined ? undefined : this.runtimeRecords.get(nextId);
    if (next?.nextAttemptAt === undefined) return;
    const delay = Math.max(0, Date.parse(next.nextAttemptAt) - this.clock().getTime());
    const handle = setTimeout(() => {
      // A cancelled callback that was already queued must never clear a newer
      // timer installed for an earlier deadline.
      if (this.wakeTimer !== handle) return;
      this.wakeTimer = undefined;
      this.startWorker();
    }, delay);
    this.wakeTimer = handle;
    this.wakeTimer.unref?.();
  }

  private clearWakeTimer(): void {
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
  }

  private seedRuntimeCache(records: readonly LocatedRecord[], transitioning: number): void {
    this.runtimeRecords.clear();
    for (const { record } of records) this.setRuntimeRecord(record);
    this.runtimeTransitioning = transitioning;
  }

  private setRuntimeRecord(record: IntakeRecord): void {
    this.runtimeRecords.set(record.id, {
      state: record.state,
      admittedAt: record.admittedAt,
      ...(record.state === "pending" ? { nextAttemptAt: record.nextAttemptAt } : {}),
      ...(record.state === "resolved" ? { resolvedAt: record.resolvedAt } : {}),
    });
  }

  private activeRuntimeRecordCount(): number {
    let active = 0;
    for (const record of this.runtimeRecords.values()) {
      if (record.state === "pending" || record.state === "dead") active += 1;
    }
    return active;
  }

  private nextPendingRuntimeId(dueOnly: boolean): string | undefined {
    const nowMs = this.clock().getTime();
    let selected: { readonly id: string; readonly record: IntakeRuntimeCacheEntry } | undefined;
    for (const [id, record] of this.runtimeRecords) {
      if (record.state !== "pending" || record.nextAttemptAt === undefined
        || (dueOnly && Date.parse(record.nextAttemptAt) > nowMs)) continue;
      if (selected === undefined
        || record.nextAttemptAt.localeCompare(selected.record.nextAttemptAt!) < 0
        || (record.nextAttemptAt === selected.record.nextAttemptAt
          && (record.admittedAt.localeCompare(selected.record.admittedAt) < 0
            || (record.admittedAt === selected.record.admittedAt && id.localeCompare(selected.id) < 0)))) {
        selected = { id, record };
      }
    }
    return selected?.id;
  }

  private resolvedRuntimeInventory(): readonly { readonly id: string; readonly resolvedAt: string }[] {
    return [...this.runtimeRecords].flatMap(([id, record]) => record.state === "resolved"
      && record.resolvedAt !== undefined ? [{ id, resolvedAt: record.resolvedAt }] : []);
  }

  private refreshRuntimeCacheFromDisk(): void {
    const internal = inspectCompletedTurnIntakeInternal(this.root, this.clock());
    this.seedRuntimeCache(internal.located, internal.inspection.snapshot.transitioning);
  }

  private refreshRuntimeCacheAfterFault(): void {
    try {
      this.refreshRuntimeCacheFromDisk();
    } catch {
      safeWarn(this.warn, "completed-turn intake runtime metadata refresh failed; durable state remains authoritative.");
    }
  }

  private recoverRuntimeTransitionsIfNeeded(): void {
    if (this.runtimeTransitioning === 0) return;
    try {
      recoverStateConflicts(this.root);
      this.refreshRuntimeCacheFromDisk();
    } catch (error) {
      this.refreshRuntimeCacheAfterFault();
      this.notifyChange();
      throw error;
    }
    this.notifyChange();
  }

  private notifyChange(urgency?: "urgent"): void {
    try {
      this.onChange(urgency);
    } catch {
      safeWarn(this.warn, "completed-turn intake state notification failed; durable state remains authoritative.");
    }
  }
}

/** Strict metadata-only inspection. Any unsafe/corrupt entry rejects the whole result. */
export function inspectCompletedTurnIntake(
  root: string,
  now = new Date(),
): CompletedTurnIntakeInspection {
  return inspectCompletedTurnIntakeInternal(root, now).inspection;
}

interface CompletedTurnIntakeInternalInspection {
  readonly inspection: CompletedTurnIntakeInspection;
  readonly privateState: CompletedTurnIntakePrivateHealthState;
  readonly located: readonly LocatedRecord[];
}

function inspectCompletedTurnIntakeInternal(
  root: string,
  now: Date,
): CompletedTurnIntakeInternalInspection {
  const canonicalRoot = canonicalMemoryRootPath(root, false);
  if (!intakeLayoutExists(canonicalRoot)) {
    if (readIntakeSchemaMarker(canonicalRoot) !== undefined) {
      throw new Error("memory-bujo: initialized completed-turn intake layout is missing.");
    }
    return {
      inspection: {
        schemaVersion: COMPLETED_TURN_INTAKE_SCHEMA_VERSION,
        items: [],
        temporary: 0,
        snapshot: { pending: 0, dead: 0, resolved: 0, due: 0, transitioning: 0 },
      },
      privateState: { digest: EMPTY_SHA256 },
      located: [],
    };
  }
  ensureLayout(canonicalRoot, false);
  const listed = STATES.map((state) => listRecordsWithTemporary(canonicalRoot, state));
  const physical = listed.flatMap((entry) => entry.records);
  const temporary = listed.reduce((sum, entry) => sum + entry.temporary, 0);
  const { located, transitioning } = logicalRecords(physical);
  const items = located.map(({ record }) => ({
    id: record.id,
    state: record.state,
    admittedAt: record.admittedAt,
    attempt: record.attempt,
    revision: record.revision,
    due: record.state === "pending" && Date.parse(record.nextAttemptAt) <= now.getTime(),
    ...(record.state === "resolved" ? {} : record.lastError === undefined ? {} : { lastError: record.lastError }),
  })).sort((left, right) => left.id.localeCompare(right.id) || left.state.localeCompare(right.state));
  const dueTimes = located.flatMap(({ record }) => record.state === "pending"
    && Date.parse(record.nextAttemptAt) <= now.getTime() ? [record.nextAttemptAt] : []);
  const digest = createHash("sha256").update(JSON.stringify(located.map(({ record }) => ({
    id: record.id,
    state: record.state,
    revision: record.revision,
    nextAttemptAt: record.state === "pending" ? record.nextAttemptAt : null,
  })).sort((left, right) => left.id.localeCompare(right.id)))).digest("hex");
  return {
    inspection: {
      schemaVersion: COMPLETED_TURN_INTAKE_SCHEMA_VERSION,
      items,
      temporary,
      snapshot: {
        pending: items.filter((item) => item.state === "pending").length,
        dead: items.filter((item) => item.state === "dead").length,
        resolved: items.filter((item) => item.state === "resolved").length,
        due: items.filter((item) => item.due).length,
        transitioning,
      },
    },
    privateState: {
      ...(dueTimes.length === 0 ? {} : { oldestDueAt: dueTimes.sort()[0]! }),
      digest,
    },
    located,
  };
}

function intakeLayoutExists(root: string): boolean {
  try {
    lstatSync(join(root, INTAKE_ROOT));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Non-throwing audit wrapper for health/CLI consumers. */
export function auditCompletedTurnIntake(root: string, now = new Date()): CompletedTurnIntakeAudit {
  return auditCompletedTurnIntakeHealthState(root, now).audit;
}

/** Strict health audit plus private content-free queue stability metadata. */
export function auditCompletedTurnIntakeHealthState(
  root: string,
  now = new Date(),
): CompletedTurnIntakeHealthAudit {
  try {
    const internal = inspectCompletedTurnIntakeInternal(root, now);
    const { inspection } = internal;
    const counts = countsFromInspection(inspection);
    if (inspection.temporary > 0) {
      return {
        audit: { valid: false, inspection, counts, issues: ["invalid_record"] },
        privateState: internal.privateState,
      };
    }
    if (inspection.snapshot.pending + inspection.snapshot.dead > DEFAULT_MAX_ACTIVE_RECORDS) {
      return {
        audit: { valid: false, inspection, counts, issues: ["capacity_exceeded"] },
        privateState: internal.privateState,
      };
    }
    if (intakeLayoutExists(canonicalMemoryRootPath(root, false))) {
      const canonicalRoot = canonicalMemoryRootPath(root, false);
      validateAdmissionLedger(canonicalRoot, internal.located);
    }
    return {
      audit: { valid: true, inspection, counts, issues: [] },
      privateState: internal.privateState,
    };
  } catch (error) {
    const message = reasonOf(error);
    const issue = /capacity|bounded file count/iu.test(message)
      ? "capacity_exceeded"
      : /conflict|multiple states/iu.test(message)
      ? "state_conflict"
      : /directory|layout/iu.test(message)
        ? "invalid_layout"
        : "invalid_record";
    const counts = physicalIntakeCounts(root);
    return {
      audit: { valid: false, counts, issues: [issue] },
      privateState: {
        digest: createHash("sha256").update(JSON.stringify({ invalid: issue, counts })).digest("hex"),
      },
    };
  }
}

function countsFromInspection(inspection: CompletedTurnIntakeInspection): CompletedTurnIntakeAudit["counts"] {
  return {
    pending: inspection.snapshot.pending,
    due: inspection.snapshot.due,
    dead: inspection.snapshot.dead,
    temporary: inspection.temporary,
  };
}

function physicalIntakeCounts(root: string): CompletedTurnIntakeAudit["counts"] {
  const counts = { pending: 0, due: 0, dead: 0, temporary: 0 };
  try {
    const canonicalRoot = canonicalMemoryRootPath(root, false);
    if (!intakeLayoutExists(canonicalRoot)) return counts;
    counts.temporary += listLedgerCatalogTempNames(canonicalRoot).length;
    for (const state of STATES) {
      for (const name of listStateNames(canonicalRoot, state)) {
        if (ORPHAN_TEMP_NAME.test(name)) counts.temporary += 1;
        else if (state === "pending") counts.pending += 1;
        else if (state === "dead") counts.dead += 1;
      }
    }
  } catch {
    // Unsafe directory metadata is itself an invalid audit. Keep the bounded
    // zero/partial inventory without exposing filesystem details.
  }
  return counts;
}

/** Retry selected dead letters (or make selected pending work due) while no store owns the root. */
export function retryCompletedTurnIntake(
  root: string,
  options: { readonly id?: string; readonly now?: Date } = {},
): { readonly retried: number } {
  if (options.id !== undefined) assertId(options.id);
  const lease = acquireMemoryWriterLease(root);
  try {
    ensureLayout(lease.root, true);
    retireOrphanIntakeTemps(lease.root);
    recoverStateConflicts(lease.root);
    ensureLedgerEntries(lease.root, logicalRecords(STATES.flatMap((state) => listRecords(lease.root, state))).located
      .map(({ record }) => ({ id: record.id, payloadHash: record.payloadHash })));
    const now = (options.now ?? new Date()).toISOString();
    let retried = 0;
    for (const located of listRecords(lease.root, "dead")) {
      if (located.record.state !== "dead" || (options.id !== undefined && located.record.id !== options.id)) continue;
      const pending: PendingRecord = {
        schemaVersion: COMPLETED_TURN_INTAKE_SCHEMA_VERSION,
        state: "pending",
        id: located.record.id,
        payloadHash: located.record.payloadHash,
        runId: located.record.runId,
        conversationId: located.record.conversationId,
        summary: located.record.summary,
        ...(located.record.captureText === undefined ? {} : { captureText: located.record.captureText }),
        admittedAt: located.record.admittedAt,
        revision: located.record.revision + 1,
        attempt: 0,
        nextAttemptAt: now,
        summaryWritten: located.record.summaryWritten,
      };
      moveRecord(lease.root, located, "pending", pending);
      retried += 1;
    }
    for (const located of listRecords(lease.root, "pending")) {
      if (located.record.state !== "pending" || (options.id !== undefined && located.record.id !== options.id)) continue;
      if (Date.parse(located.record.nextAttemptAt) <= Date.parse(now)) continue;
      replaceRecord(
        lease.root,
        located as LocatedRecord<PendingRecord>,
        { ...located.record, nextAttemptAt: now },
      );
      retried += 1;
    }
    return { retried };
  } finally {
    lease.release();
  }
}

/** Explicitly resolve pending/dead work without claiming that semantic capture completed. */
export function resolveCompletedTurnIntake(
  root: string,
  id: string,
  reason: string,
  now = new Date(),
): { readonly resolved: boolean } {
  assertId(id);
  if (!SAFE_REASON.test(reason)) throw new Error("memory-bujo: intake resolution reason must be a bounded slug.");
  const lease = acquireMemoryWriterLease(root);
  try {
    ensureLayout(lease.root, true);
    retireOrphanIntakeTemps(lease.root);
    recoverStateConflicts(lease.root);
    const source = preferredRecord(locateById(lease.root, id));
    if (source === undefined || source.record.state === "resolved") return { resolved: false };
    ensureLedgerEntry(lease.root, source.record.id, source.record.payloadHash);
    if (findRetainedCaptureIntent(lease.root, id) !== undefined) {
      throw new Error("memory-bujo: intake resolution requires retained semantic-plan recovery first.");
    }
    const receipt: ResolvedRecord = {
      schemaVersion: COMPLETED_TURN_INTAKE_SCHEMA_VERSION,
      state: "resolved",
      id,
      payloadHash: source.record.payloadHash,
      admittedAt: source.record.admittedAt,
      resolvedAt: now.toISOString(),
      revision: source.record.revision + 1,
      attempt: source.record.attempt,
      outcome: "operator_resolved",
      reason,
    };
    moveRecord(lease.root, source, "resolved", receipt);
    pruneResolved(lease.root, DEFAULT_RESOLVED_RETENTION, id);
    return { resolved: true };
  } finally {
    lease.release();
  }
}

function ensureLayout(root: string, create: boolean): void {
  const canonicalRoot = canonicalMemoryRootPath(root, create);
  const intakeRoot = ensureDirectory(canonicalRoot, join(canonicalRoot, INTAKE_ROOT), create, INTAKE_ROOT);
  for (const component of [...STATES, LEDGER_ROOT]) {
    ensureDirectory(intakeRoot, join(intakeRoot, component), create, `${INTAKE_ROOT}/${component}`);
  }
  if (create) retireOrphanLedgerCatalogTemps(canonicalRoot);
  assertIntakeRootEntries(canonicalRoot, false);
  ensureLedgerCatalog(canonicalRoot, create);
  assertIntakeRootEntries(canonicalRoot, true);
}

function assertIntakeRootEntries(root: string, requireLedgerCatalog: boolean): void {
  const path = join(root, INTAKE_ROOT);
  const before = lstatSync(path);
  assertSecureDirectory(before, INTAKE_ROOT);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    assertSameNode(before, fstatSync(fd));
    const names = readdirSync(path, { encoding: "utf8" }).sort();
    const base = [...STATES, LEDGER_ROOT].sort();
    const complete = [...base, LEDGER_CATALOG_FILE].sort();
    const expected = requireLedgerCatalog || names.includes(LEDGER_CATALOG_FILE) ? complete : base;
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
      throw new Error("memory-bujo: completed-turn intake root contains an unknown entry.");
    }
    assertSameNode(before, lstatSync(path));
  } finally {
    closeSync(fd);
  }
}

interface LedgerShardSnapshot {
  readonly relativePath: string;
  readonly content: string;
  readonly entries: ReadonlyMap<string, string>;
  readonly identity?: CanonicalFileIdentity;
}

interface LedgerCatalogEntry {
  readonly bytes: number;
  readonly hash: string;
}

interface LedgerCatalogSnapshot {
  readonly relativePath: string;
  readonly entries: ReadonlyMap<string, LedgerCatalogEntry>;
  readonly identity: CanonicalFileIdentity;
}

function retireOrphanLedgerCatalogTemps(root: string): void {
  for (const name of listLedgerCatalogTempNames(root)) {
    const relativePath = `${INTAKE_ROOT}/${name}`;
    const snapshot = readCanonicalFileSnapshot(root, relativePath, { maxBytes: LEDGER_CATALOG_MAX_BYTES });
    if (snapshot === undefined) throw new Error("memory-bujo: completed-turn ledger catalog temp disappeared.");
    assertSecureLedgerFile(snapshot.identity);
    removeCanonicalFile(root, relativePath, snapshot.identity);
  }
}

function listLedgerCatalogTempNames(root: string): string[] {
  const path = join(root, INTAKE_ROOT);
  const before = lstatSync(path);
  assertSecureDirectory(before, INTAKE_ROOT);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  let names: string[];
  try {
    assertSameNode(before, fstatSync(fd));
    names = readdirSync(path, { encoding: "utf8" }).filter((name) => LEDGER_CATALOG_TEMP_NAME.test(name));
    assertSameNode(before, lstatSync(path));
  } finally {
    closeSync(fd);
  }
  return names;
}

function ensureLedgerCatalog(root: string, create: boolean): LedgerCatalogSnapshot {
  const schemaMarker = readIntakeSchemaMarker(root);
  if (schemaMarker === undefined && !create) {
    throw new Error("memory-bujo: completed-turn intake schema marker is missing.");
  }

  let catalog = readLedgerCatalog(root, true);
  if (catalog === undefined) {
    if (!create) throw new Error("memory-bujo: completed-turn admission ledger catalog is missing.");
    if (schemaMarker !== undefined) {
      throw new Error("memory-bujo: initialized completed-turn intake lost its integrity catalog.");
    }
    const names = listCanonicalFileNames(root, `${INTAKE_ROOT}/${LEDGER_ROOT}`);
    if (names.some((name) => !LEDGER_FILE_NAME.test(name))) {
      throw new Error("memory-bujo: markerless completed-turn ledger contains an unknown entry.");
    }
    for (const name of names) {
      const shard = readLedgerShard(root, name.slice(0, 2), false, true);
      if (shard.content.length !== 0) {
        throw new Error("memory-bujo: nonempty completed-turn ledger is missing its integrity catalog.");
      }
    }
    const relativePath = `${INTAKE_ROOT}/${LEDGER_CATALOG_FILE}`;
    try {
      writeCanonicalFileAtomic(root, relativePath, serializeLedgerCatalog(emptyLedgerCatalog()));
    } catch (error) {
      const raced = readLedgerCatalog(root, true);
      if (raced === undefined) throw error;
      appendCanonicalFile(root, raced.relativePath, "", {
        expectedIdentity: raced.identity,
        syncParent: true,
      });
    }
    catalog = readLedgerCatalog(root, false)!;
  }
  if (schemaMarker === undefined) {
    if ([...catalog.entries.values()].some(({ bytes }) => bytes !== 0)) {
      throw new Error("memory-bujo: nonempty completed-turn catalog is missing its schema marker.");
    }
    for (const name of listCanonicalFileNames(root, `${INTAKE_ROOT}/${LEDGER_ROOT}`)) {
      if (readLedgerShard(root, name.slice(0, 2), false).content.length !== 0) {
        throw new Error("memory-bujo: nonempty completed-turn ledger is missing its schema marker.");
      }
    }
    try {
      appendCanonicalFile(root, INTAKE_SCHEMA_MARKER, "", { requireMissing: true });
    } catch (error) {
      const raced = readCanonicalFileSnapshot(root, INTAKE_SCHEMA_MARKER, { allowMissing: true });
      if (raced === undefined) throw error;
      assertSecureLedgerFile(raced.identity);
      if (raced.content.length !== 0) throw error;
      appendCanonicalFile(root, INTAKE_SCHEMA_MARKER, "", {
        expectedIdentity: raced.identity,
        syncParent: true,
      });
    }
  }
  validateLedgerInventory(root, catalog);
  return catalog;
}

function readIntakeSchemaMarker(root: string) {
  const snapshot = readCanonicalFileSnapshot(root, INTAKE_SCHEMA_MARKER, { allowMissing: true });
  if (snapshot === undefined) return undefined;
  assertSecureLedgerFile(snapshot.identity);
  if (snapshot.content.length !== 0) {
    throw new Error("memory-bujo: completed-turn intake schema marker is malformed.");
  }
  return snapshot;
}

function validateLedgerInventory(root: string, catalog: LedgerCatalogSnapshot): void {
  const names = listCanonicalFileNames(root, `${INTAKE_ROOT}/${LEDGER_ROOT}`);
  if (names.length > LEDGER_SHARDS.length || names.some((name) => !LEDGER_FILE_NAME.test(name))) {
    throw new Error("memory-bujo: completed-turn admission ledger layout is invalid.");
  }
  const present = new Set(names.map((name) => name.slice(0, 2)));
  for (const [shard, commitment] of catalog.entries) {
    if (commitment.bytes > 0 && !present.has(shard)) {
      throw new Error("memory-bujo: completed-turn admission ledger shard is missing.");
    }
  }
}

/** Full explicit audit with memory bounded to one shard plus current receipts. */
function validateAdmissionLedger(root: string, materialized: readonly LocatedRecord[]): void {
  const catalog = readLedgerCatalog(root, false)!;
  validateLedgerInventory(root, catalog);
  const expected = new Map(materialized.map(({ record }) => [record.id, record.payloadHash] as const));
  const names = listCanonicalFileNames(root, `${INTAKE_ROOT}/${LEDGER_ROOT}`);
  for (const name of names) {
    const shardName = name.slice(0, 2);
    const shard = reconcileLedgerShard(root, shardName, catalog, new Map(), false, false).shard;
    for (const [id, payloadHash] of shard.entries) {
      const commitment = expected.get(id);
      if (commitment !== undefined) {
        if (commitment !== payloadHash) {
          throw new Error("memory-bujo: completed-turn intake record conflicts with its permanent admission commitment.");
        }
        expected.delete(id);
      }
    }
  }
  if (expected.size > 0) {
    throw new Error("memory-bujo: completed-turn intake record is missing its permanent admission commitment.");
  }
}

function lookupLedgerEntry(
  root: string,
  id: string,
): { readonly payloadHash: string; readonly relativePath: string } | undefined {
  assertId(id);
  const catalog = readLedgerCatalog(root, false)!;
  const shard = reconcileLedgerShard(root, id.slice(0, 2), catalog, new Map(), false, false).shard;
  const payloadHash = shard.entries.get(id);
  return payloadHash === undefined ? undefined : { payloadHash, relativePath: shard.relativePath };
}

/**
 * Ensure one permanent id -> payload commitment. Rich resolved receipts remain
 * bounded, while this content-free ledger is append-only and exact.
 */
function ensureLedgerEntry(root: string, id: string, payloadHash: string): void {
  ensureLedgerEntries(root, [{ id, payloadHash }]);
}

function ensureLedgerEntries(
  root: string,
  commitments: readonly { readonly id: string; readonly payloadHash: string }[],
): void {
  const grouped = new Map<string, Map<string, string>>();
  for (const { id, payloadHash } of commitments) {
    assertId(id);
    assertId(payloadHash);
    const shard = id.slice(0, 2);
    const entries = grouped.get(shard) ?? new Map<string, string>();
    const existing = entries.get(id);
    if (existing !== undefined && existing !== payloadHash) {
      throw new Error("memory-bujo: completed-turn materialized records conflict before ledger recovery.");
    }
    entries.set(id, payloadHash);
    grouped.set(shard, entries);
  }

  for (const [shardName, expected] of grouped) {
    let published = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let catalog = readLedgerCatalog(root, false)!;
      const reconciled = reconcileLedgerShard(root, shardName, catalog, expected, true, true);
      catalog = reconciled.catalog;
      const shard = reconciled.shard;
      const missing: string[] = [];
      for (const [id, payloadHash] of expected) {
        const existing = shard.entries.get(id);
        if (existing !== undefined && existing !== payloadHash) {
          throw new Error("memory-bujo: completed-turn run id conflicts with the permanent admission ledger.");
        }
        if (existing === undefined) missing.push(`${id}${payloadHash}\n`);
      }
      if (missing.length === 0) {
        published = true;
        break;
      }
      try {
        appendCanonicalFile(root, shard.relativePath, missing.join(""), shard.identity === undefined
          ? { requireMissing: true }
          : { expectedIdentity: shard.identity });
      } catch (error) {
        // A concurrent writer may have created or extended this shard after
        // the safe snapshot. Re-read once; unsafe identities and corruption
        // are still rejected by the same validation path.
        if (attempt === 2) throw error;
        continue;
      }
      const verified = readLedgerShard(root, shardName, false);
      try {
        catalog = updateLedgerCatalog(root, catalog, shardName, verified.content);
      } catch (error) {
        if (attempt === 2) throw error;
        continue;
      }
      const committed = reconcileLedgerShard(root, shardName, catalog, new Map(), false, false).shard;
      if ([...expected].some(([id, payloadHash]) => committed.entries.get(id) !== payloadHash)) {
        throw new Error("memory-bujo: completed-turn admission ledger durability verification failed.");
      }
      published = true;
      break;
    }
    if (!published) {
      throw new Error("memory-bujo: completed-turn admission ledger could not publish stable commitments.");
    }
  }
}

function readLedgerShard(
  root: string,
  shard: string,
  repairPartial: boolean,
  allowMissing = false,
): LedgerShardSnapshot {
  if (!/^[a-f0-9]{2}$/u.test(shard)) {
    throw new Error("memory-bujo: completed-turn admission ledger shard is invalid.");
  }
  const relativePath = `${INTAKE_ROOT}/${LEDGER_ROOT}/${shard}.log`;
  let snapshot = readCanonicalFileSnapshot(root, relativePath, { allowMissing: true });
  if (snapshot === undefined) {
    if (allowMissing) return { relativePath, content: "", entries: new Map() };
    throw new Error("memory-bujo: completed-turn admission ledger shard is missing.");
  }
  assertSecureLedgerFile(snapshot.identity);

  const recoverableBytes = snapshot.content.length - (snapshot.content.length % LEDGER_ENTRY_BYTES);
  const trailing = snapshot.content.slice(recoverableBytes);
  if (trailing.length > 0) {
    const isRecoverablePrefix = trailing.length < LEDGER_ENTRY_BYTES
      && /^[a-f0-9]+$/u.test(trailing)
      && (trailing.length < 2 || trailing.slice(0, 2) === shard);
    if (!repairPartial || !isRecoverablePrefix) {
      throw new Error("memory-bujo: completed-turn admission ledger has a malformed trailing entry.");
    }
    writeCanonicalFileAtomic(root, relativePath, snapshot.content.slice(0, recoverableBytes), snapshot.identity);
    snapshot = readCanonicalFileSnapshot(root, relativePath);
    if (snapshot === undefined) {
      throw new Error("memory-bujo: completed-turn admission ledger disappeared during recovery.");
    }
    assertSecureLedgerFile(snapshot.identity);
  }

  const entries = new Map<string, string>();
  for (let offset = 0; offset < snapshot.content.length; offset += LEDGER_ENTRY_BYTES) {
    const raw = snapshot.content.slice(offset, offset + LEDGER_ENTRY_BYTES);
    const match = LEDGER_ENTRY.exec(raw);
    if (match === null || match[1]!.slice(0, 2) !== shard) {
      throw new Error("memory-bujo: completed-turn admission ledger contains a malformed entry.");
    }
    const existing = entries.get(match[1]!);
    if (existing !== undefined) {
      throw new Error("memory-bujo: completed-turn admission ledger contains a duplicate commitment.");
    }
    entries.set(match[1]!, match[2]!);
  }
  return { relativePath, content: snapshot.content, entries, identity: snapshot.identity };
}

function reconcileLedgerShard(
  root: string,
  shardName: string,
  catalog: LedgerCatalogSnapshot,
  recoverable: ReadonlyMap<string, string>,
  repairPartial: boolean,
  allowAheadRecovery: boolean,
): { readonly catalog: LedgerCatalogSnapshot; readonly shard: LedgerShardSnapshot } {
  const expected = catalog.entries.get(shardName);
  if (expected === undefined) throw new Error("memory-bujo: completed-turn ledger catalog shard is missing.");
  const shard = readLedgerShard(root, shardName, repairPartial, expected.bytes === 0);
  if (shard.content.length < expected.bytes) {
    throw new Error("memory-bujo: completed-turn admission ledger shard was truncated or replaced.");
  }
  const committedPrefix = shard.content.slice(0, expected.bytes);
  if (hashText(committedPrefix) !== expected.hash) {
    throw new Error("memory-bujo: completed-turn admission ledger shard integrity does not match its catalog.");
  }
  if (shard.content.length === expected.bytes) return { catalog, shard };
  if (!allowAheadRecovery) {
    throw new Error("memory-bujo: completed-turn admission ledger is ahead of its integrity catalog.");
  }
  const prefixEntries = parseLedgerEntries(committedPrefix, shardName);
  const suffix = shard.content.slice(expected.bytes);
  const suffixEntries = parseLedgerEntries(suffix, shardName);
  for (const [id, payloadHash] of suffixEntries) {
    if (prefixEntries.has(id) || recoverable.get(id) !== payloadHash) {
      throw new Error("memory-bujo: uncommitted ledger suffix has no exact materialized receipt.");
    }
  }
  if (shard.identity === undefined) {
    throw new Error("memory-bujo: uncommitted ledger suffix has no durable shard identity.");
  }
  // A prior append may have exposed complete page-cache bytes but failed its
  // fsync/final identity check. Pin and fsync that exact inode again before the
  // catalog makes those bytes part of the permanent high-water commitment.
  appendCanonicalFile(root, shard.relativePath, "", {
    expectedIdentity: shard.identity,
    syncParent: true,
  });
  const durable = readLedgerShard(root, shardName, false);
  if (durable.content !== shard.content) {
    throw new Error("memory-bujo: uncommitted ledger suffix changed before durability recovery.");
  }
  const updated = updateLedgerCatalog(root, catalog, shardName, durable.content);
  const committed = readLedgerShard(root, shardName, false);
  const updatedEntry = updated.entries.get(shardName)!;
  if (committed.content.length !== updatedEntry.bytes || hashText(committed.content) !== updatedEntry.hash) {
    throw new Error("memory-bujo: completed-turn ledger changed while its catalog recovery committed.");
  }
  return { catalog: updated, shard: committed };
}

function readLedgerCatalog(root: string, allowMissing: boolean): LedgerCatalogSnapshot | undefined {
  const relativePath = `${INTAKE_ROOT}/${LEDGER_CATALOG_FILE}`;
  const snapshot = readCanonicalFileSnapshot(root, relativePath, {
    allowMissing,
    maxBytes: LEDGER_CATALOG_MAX_BYTES,
  });
  if (snapshot === undefined) return undefined;
  assertSecureLedgerFile(snapshot.identity);
  const lines = snapshot.content.split("\n");
  if (lines[0] !== LEDGER_CATALOG_HEADER || lines.length !== LEDGER_SHARDS.length + 2 || lines.at(-1) !== "") {
    throw new Error("memory-bujo: completed-turn admission ledger catalog is malformed.");
  }
  const entries = new Map<string, LedgerCatalogEntry>();
  for (let index = 0; index < LEDGER_SHARDS.length; index += 1) {
    const match = LEDGER_CATALOG_LINE.exec(lines[index + 1]!);
    const shard = LEDGER_SHARDS[index]!;
    if (match === null || match[1] !== shard) {
      throw new Error("memory-bujo: completed-turn admission ledger catalog entry is malformed.");
    }
    const bytes = Number(match[2]);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes % LEDGER_ENTRY_BYTES !== 0
      || (bytes === 0 && match[3] !== EMPTY_SHA256)) {
      throw new Error("memory-bujo: completed-turn admission ledger catalog commitment is invalid.");
    }
    entries.set(shard, { bytes, hash: match[3]! });
  }
  return { relativePath, entries, identity: snapshot.identity };
}

function emptyLedgerCatalog(): ReadonlyMap<string, LedgerCatalogEntry> {
  return new Map(LEDGER_SHARDS.map((shard) => [shard, { bytes: 0, hash: EMPTY_SHA256 }] as const));
}

function serializeLedgerCatalog(entries: ReadonlyMap<string, LedgerCatalogEntry>): string {
  const lines = [LEDGER_CATALOG_HEADER];
  for (const shard of LEDGER_SHARDS) {
    const entry = entries.get(shard);
    if (entry === undefined || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || entry.bytes % LEDGER_ENTRY_BYTES !== 0 || !ID.test(entry.hash)) {
      throw new Error("memory-bujo: completed-turn admission ledger catalog cannot be serialized.");
    }
    lines.push(`${shard} ${String(entry.bytes).padStart(16, "0")} ${entry.hash}`);
  }
  const content = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(content, "utf8") > LEDGER_CATALOG_MAX_BYTES) {
    throw new Error("memory-bujo: completed-turn admission ledger catalog exceeds its bound.");
  }
  return content;
}

function updateLedgerCatalog(
  root: string,
  catalog: LedgerCatalogSnapshot,
  shardName: string,
  content: string,
): LedgerCatalogSnapshot {
  const current = catalog.entries.get(shardName);
  if (current === undefined || content.length < current.bytes) {
    throw new Error("memory-bujo: completed-turn admission ledger catalog update would regress.");
  }
  const entries = new Map(catalog.entries);
  entries.set(shardName, { bytes: content.length, hash: hashText(content) });
  writeCanonicalFileAtomic(root, catalog.relativePath, serializeLedgerCatalog(entries), catalog.identity);
  const verified = readLedgerCatalog(root, false)!;
  const committed = verified.entries.get(shardName);
  if (committed?.bytes !== content.length || committed.hash !== hashText(content)) {
    throw new Error("memory-bujo: completed-turn admission ledger catalog durability verification failed.");
  }
  return verified;
}

function parseLedgerEntries(content: string, shard: string): Map<string, string> {
  if (content.length % LEDGER_ENTRY_BYTES !== 0) {
    throw new Error("memory-bujo: completed-turn admission ledger entry boundary is invalid.");
  }
  const entries = new Map<string, string>();
  for (let offset = 0; offset < content.length; offset += LEDGER_ENTRY_BYTES) {
    const match = LEDGER_ENTRY.exec(content.slice(offset, offset + LEDGER_ENTRY_BYTES));
    if (match === null || match[1]!.slice(0, 2) !== shard || entries.has(match[1]!)) {
      throw new Error("memory-bujo: completed-turn admission ledger contains a malformed or duplicate entry.");
    }
    entries.set(match[1]!, match[2]!);
  }
  return entries;
}

function hashText(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function assertSecureLedgerFile(identity: CanonicalFileIdentity): void {
  if ((identity.mode & 0o777) !== FILE_MODE
    || identity.nlink !== 1
    || (typeof process.getuid === "function" && identity.uid !== process.getuid())) {
    throw new Error("memory-bujo: completed-turn admission ledger must be owner-only and single-link.");
  }
}

function ensureDirectory(parent: string, path: string, create: boolean, label: string): string {
  const parentBefore = lstatSync(parent);
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) {
    throw new Error("memory-bujo: completed-turn intake parent layout is unsafe.");
  }
  let created = false;
  if (!create) {
    let existing: Stats;
    try {
      existing = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("memory-bujo: completed-turn intake layout is missing.");
      }
      throw error;
    }
    assertSecureDirectory(existing, label);
    const parentAfter = lstatSync(parent);
    assertSecureParentIdentity(parentBefore, parentAfter);
    return path;
  }
  try {
    mkdirSync(path, { mode: DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("memory-bujo: completed-turn intake layout is missing.");
      }
      throw error;
    }
  }
  const stat = lstatSync(path);
  assertSecureDirectory(stat, label);
  const parentAfter = lstatSync(parent);
  assertSecureParentIdentity(parentBefore, parentAfter);
  if (created) fsyncSecureDirectory(parent, parentBefore);
  return path;
}

function listRecords(root: string, state: IntakeState): LocatedRecord[] {
  return listRecordsWithTemporary(root, state).records;
}

function listRecordsWithTemporary(
  root: string,
  state: IntakeState,
): { readonly records: LocatedRecord[]; readonly temporary: number } {
  const records: LocatedRecord[] = [];
  let temporary = 0;
  for (const name of listStateNames(root, state)) {
    if (FILE_NAME.test(name)) {
      records.push(readRecord(root, state, name.slice(0, -5)));
      continue;
    }
    if (ORPHAN_TEMP_NAME.test(name)) {
      validateOrphanTemp(root, state, name);
      temporary += 1;
      continue;
    }
    throw new Error("memory-bujo: completed-turn intake has an invalid record name.");
  }
  return { records, temporary };
}

function listStateNames(root: string, state: IntakeState): string[] {
  const directory = join(root, INTAKE_ROOT, state);
  const parent = lstatSync(join(root, INTAKE_ROOT));
  assertSecureDirectory(parent, INTAKE_ROOT);
  const before = lstatSync(directory);
  assertSecureDirectory(before, `${INTAKE_ROOT}/${state}`);
  const fd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  let names: string[];
  try {
    const opened = fstatSync(fd);
    assertSecureDirectory(opened, `${INTAKE_ROOT}/${state}`);
    assertSameNode(before, opened);
    names = readdirSync(directory, { encoding: "utf8" }).sort();
    if (names.length > MAX_FILES_PER_STATE) {
      throw new Error("memory-bujo: completed-turn intake state exceeds its bounded file count.");
    }
    assertSameNode(opened, lstatSync(directory));
    assertSameNode(parent, lstatSync(join(root, INTAKE_ROOT)));
  } finally {
    closeSync(fd);
  }
  return names;
}

function validateOrphanTemp(
  root: string,
  state: IntakeState,
  name: string,
): NonNullable<ReturnType<typeof readCanonicalFileSnapshot>> {
  const relativePath = `${INTAKE_ROOT}/${state}/${name}`;
  const snapshot = readCanonicalFileSnapshot(root, relativePath, { maxBytes: MAX_RECORD_BYTES });
  if (snapshot === undefined || (snapshot.identity.mode & 0o777) !== FILE_MODE
    || snapshot.identity.nlink !== 1
    || (typeof process.getuid === "function" && snapshot.identity.uid !== process.getuid())) {
    throw new Error("memory-bujo: completed-turn intake orphan temp has unsafe identity.");
  }
  return snapshot;
}

function retireOrphanIntakeTemps(root: string): void {
  for (const state of STATES) {
    for (const name of listStateNames(root, state)) {
      if (FILE_NAME.test(name)) continue;
      if (!ORPHAN_TEMP_NAME.test(name)) {
        throw new Error("memory-bujo: completed-turn intake has an invalid record name.");
      }
      const snapshot = validateOrphanTemp(root, state, name);
      removeCanonicalFile(root, `${INTAKE_ROOT}/${state}/${name}`, snapshot.identity);
    }
  }
}

function readRecord(root: string, state: IntakeState, id: string): LocatedRecord {
  assertId(id);
  const relativePath = recordPath(state, id);
  const snapshot = readCanonicalFileSnapshot(root, relativePath, { maxBytes: MAX_RECORD_BYTES });
  if (snapshot === undefined) throw new Error("memory-bujo: completed-turn intake record disappeared.");
  if ((snapshot.identity.mode & 0o777) !== FILE_MODE
    || snapshot.identity.nlink !== 1
    || (typeof process.getuid === "function" && snapshot.identity.uid !== process.getuid())) {
    throw new Error("memory-bujo: completed-turn intake record has unsafe permissions or ownership.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.content) as unknown;
  } catch {
    throw new Error("memory-bujo: completed-turn intake record is not valid JSON.");
  }
  const record = validateRecord(parsed, state, id);
  return {
    record,
    relativePath,
    identity: snapshot.identity,
    bytes: Buffer.byteLength(snapshot.content, "utf8"),
  };
}

function writeRecord(root: string, state: IntakeState, record: IntakeRecord): LocatedRecord {
  if (record.state !== state) throw new Error("memory-bujo: completed-turn intake state/path mismatch.");
  validateRecord(record, state, record.id);
  const relativePath = recordPath(state, record.id);
  const data = serializeRecord(record);
  writeCanonicalFileAtomic(root, relativePath, data);
  const verified = readRecord(root, state, record.id);
  if (createHash("sha256").update(data).digest("hex")
    !== createHash("sha256").update(readCanonicalFileSnapshot(root, relativePath)!.content).digest("hex")) {
    throw new Error("memory-bujo: completed-turn intake durability verification failed.");
  }
  return verified;
}

function replaceRecord<T extends PendingRecord>(
  root: string,
  current: LocatedRecord<PendingRecord>,
  next: T,
): LocatedRecord<T> {
  const materialized = { ...next, revision: current.record.revision + 1 } as T;
  const data = serializeRecord(materialized);
  writeCanonicalFileAtomic(root, current.relativePath, data, current.identity);
  return readRecord(root, "pending", next.id) as LocatedRecord<T>;
}

function moveRecord(
  root: string,
  source: LocatedRecord,
  state: IntakeState,
  target: IntakeRecord,
  beforeSourceRetirement?: (id: string, state: "dead" | "resolved") => void,
): LocatedRecord {
  if (target.revision !== source.record.revision + 1) {
    throw new Error("memory-bujo: completed-turn intake transition revision is not monotonic.");
  }
  const existing = locateById(root, target.id).find((candidate) => candidate.record.state === state);
  let written: LocatedRecord;
  if (existing === undefined) {
    written = writeRecord(root, state, target);
  } else {
    if (existing.record.payloadHash !== target.payloadHash || serializeRecord(existing.record) !== serializeRecord(target)) {
      throw new Error("memory-bujo: completed-turn intake destination conflicts with source state.");
    }
    written = existing;
  }
  if (state === "dead" || state === "resolved") beforeSourceRetirement?.(target.id, state);
  removeCanonicalFile(root, source.relativePath, source.identity);
  return written;
}

function resolvePending(
  root: string,
  source: LocatedRecord<PendingRecord>,
  outcome: "captured" | "summary_only",
  resolvedAt: string,
  beforeSourceRetirement?: (id: string, state: "dead" | "resolved") => void,
): LocatedRecord<ResolvedRecord> {
  // Never discard the payload-bearing state until its exact permanent
  // commitment is present and conflict-free.
  ensureLedgerEntry(root, source.record.id, source.record.payloadHash);
  const receipt: ResolvedRecord = {
    schemaVersion: COMPLETED_TURN_INTAKE_SCHEMA_VERSION,
    state: "resolved",
    id: source.record.id,
    payloadHash: source.record.payloadHash,
    admittedAt: source.record.admittedAt,
    resolvedAt,
    revision: source.record.revision + 1,
    attempt: source.record.attempt,
    outcome,
  };
  return moveRecord(
    root,
    source,
    "resolved",
    receipt,
    beforeSourceRetirement,
  ) as LocatedRecord<ResolvedRecord>;
}

function moveToDead(
  root: string,
  source: LocatedRecord<PendingRecord>,
  attempt: number,
  lastError: FailureCode,
  deadAt: string,
  beforeSourceRetirement?: (id: string, state: "dead" | "resolved") => void,
): LocatedRecord<DeadRecord> {
  const dead: DeadRecord = {
    schemaVersion: COMPLETED_TURN_INTAKE_SCHEMA_VERSION,
    state: "dead",
    id: source.record.id,
    payloadHash: source.record.payloadHash,
    runId: source.record.runId,
    conversationId: source.record.conversationId,
    summary: source.record.summary,
    ...(source.record.captureText === undefined ? {} : { captureText: source.record.captureText }),
    admittedAt: source.record.admittedAt,
    revision: source.record.revision + 1,
    attempt,
    deadAt,
    summaryWritten: source.record.summaryWritten,
    lastError,
  };
  return moveRecord(root, source, "dead", dead, beforeSourceRetirement) as LocatedRecord<DeadRecord>;
}

function recoverStateConflicts(root: string): void {
  const records = STATES.flatMap((state) => listRecords(root, state));
  const grouped = new Map<string, LocatedRecord[]>();
  for (const located of records) {
    const group = grouped.get(located.record.id) ?? [];
    group.push(located);
    grouped.set(located.record.id, group);
  }
  for (const group of grouped.values()) {
    if (group.length < 2) continue;
    const keep = preferredRecord(group)!;
    for (const extra of group) {
      if (extra === keep) continue;
      removeCanonicalFile(root, extra.relativePath, extra.identity);
    }
  }
}

function logicalRecords(records: readonly LocatedRecord[]): {
  readonly located: LocatedRecord[];
  readonly transitioning: number;
} {
  const grouped = new Map<string, LocatedRecord[]>();
  for (const located of records) {
    const group = grouped.get(located.record.id) ?? [];
    group.push(located);
    grouped.set(located.record.id, group);
  }
  let transitioning = 0;
  const located: LocatedRecord[] = [];
  for (const group of grouped.values()) {
    if (group.length > 1) transitioning += 1;
    located.push(preferredRecord(group)!);
  }
  return { located, transitioning };
}

function locateById(root: string, id: string): LocatedRecord[] {
  assertId(id);
  const found: LocatedRecord[] = [];
  for (const state of STATES) {
    try {
      found.push(readRecord(root, state, id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return found;
}

function preferredRecord(records: readonly LocatedRecord[]): LocatedRecord | undefined {
  if (records.length === 0) return undefined;
  if (records.length > 2 || new Set(records.map(({ record }) => record.payloadHash)).size !== 1) {
    throw new Error("memory-bujo: completed-turn intake states have a payload or transition conflict.");
  }
  const ordered = [...records].sort((left, right) => right.record.revision - left.record.revision);
  if (ordered.length > 1 && ordered[0]!.record.revision === ordered[1]!.record.revision) {
    throw new Error("memory-bujo: completed-turn intake states have a conflicting equal revision.");
  }
  if (ordered.length > 1 && ordered[0]!.record.revision !== ordered[1]!.record.revision + 1) {
    throw new Error("memory-bujo: completed-turn intake states have a conflicting revision gap.");
  }
  if (ordered.length > 1) {
    const transition = `${ordered[1]!.record.state}->${ordered[0]!.record.state}`;
    if (!new Set(["pending->dead", "pending->resolved", "dead->pending", "dead->resolved"]).has(transition)) {
      throw new Error("memory-bujo: completed-turn intake states have an invalid transition direction.");
    }
  }
  return ordered[0];
}

function pruneResolved(
  root: string,
  retain: number,
  preserveId?: string,
  runtimeInventory?: readonly { readonly id: string; readonly resolvedAt: string }[],
): readonly string[] {
  const resolved: Array<{
    readonly id: string;
    readonly resolvedAt: string;
    readonly located?: LocatedRecord<ResolvedRecord>;
  }> = runtimeInventory === undefined
    ? listRecords(root, "resolved")
      .filter((located): located is LocatedRecord<ResolvedRecord> => located.record.state === "resolved")
      .map((located) => ({ id: located.record.id, resolvedAt: located.record.resolvedAt, located }))
    : runtimeInventory.map((record) => ({ ...record }));
  resolved.sort((left, right) => left.resolvedAt.localeCompare(right.resolvedAt) || left.id.localeCompare(right.id));
  const removeCount = Math.max(0, resolved.length - retain);
  const removable = preserveId === undefined
    ? resolved
    : resolved.filter(({ id }) => id !== preserveId);
  const retiring = removable.slice(0, removeCount);
  const located: LocatedRecord<ResolvedRecord>[] = retiring.map((record) => {
    if (record.located !== undefined) return record.located;
    const source = readRecord(root, "resolved", record.id);
    if (source.record.state !== "resolved") {
      throw new Error("memory-bujo: completed-turn resolved runtime cache diverged from durable state.");
    }
    return source as LocatedRecord<ResolvedRecord>;
  });
  // Preflight every commitment before retiring any rich receipt. This both
  // restores a missing shard from recoverable metadata and fails closed on a
  // conflict without partially pruning the batch.
  ensureLedgerEntries(root, located.map(({ record }) => ({
    id: record.id,
    payloadHash: record.payloadHash,
  })));
  for (const record of located) {
    removeCanonicalFile(root, record.relativePath, record.identity);
  }
  return located.map(({ record }) => record.id);
}

function validateRecord(value: unknown, state: IntakeState, expectedId: string): IntakeRecord {
  if (!isRecord(value)
    || value.schemaVersion !== COMPLETED_TURN_INTAKE_SCHEMA_VERSION
    || value.state !== state
    || value.id !== expectedId
    || idFor(String(value.runId ?? "")) !== expectedId && state !== "resolved") {
    throw new Error("memory-bujo: completed-turn intake record envelope is malformed.");
  }
  assertId(expectedId);
  if (!ID.test(String(value.payloadHash ?? "")) || !canonicalTimestamp(value.admittedAt)
    || !validAttempt(value.attempt) || !validAttempt(value.revision)) {
    throw new Error("memory-bujo: completed-turn intake record metadata is malformed.");
  }
  if (state === "resolved") {
    if (!hasOnlyKeys(value, [
      "schemaVersion", "state", "id", "payloadHash", "admittedAt", "resolvedAt", "revision", "attempt", "outcome", "reason",
    ]) || !canonicalTimestamp(value.resolvedAt)
      || (value.outcome !== "captured" && value.outcome !== "summary_only" && value.outcome !== "operator_resolved")
      || (value.outcome === "operator_resolved"
        ? typeof value.reason === "string" && SAFE_REASON.test(value.reason)
        : value.reason === undefined) === false) {
      throw new Error("memory-bujo: completed-turn resolved receipt is malformed.");
    }
    return value as unknown as ResolvedRecord;
  }
  const payload = validatePayload({
    runId: value.runId as string,
    conversationId: value.conversationId as string,
    summary: value.summary as string,
    ...(value.captureText === undefined ? {} : { captureText: value.captureText as string }),
  });
  if (hashPayload(payload) !== value.payloadHash || idFor(payload.runId) !== value.id) {
    throw new Error("memory-bujo: completed-turn intake payload commitment is invalid.");
  }
  if (typeof value.summaryWritten !== "boolean") {
    throw new Error("memory-bujo: completed-turn intake summary state is malformed.");
  }
  if (state === "pending") {
    if (!hasOnlyKeys(value, [
      "schemaVersion", "state", "id", "payloadHash", "runId", "conversationId", "summary", "captureText",
      "admittedAt", "revision", "attempt", "nextAttemptAt", "summaryWritten", "lastError",
    ]) || !canonicalTimestamp(value.nextAttemptAt)
      || (value.lastError !== undefined && !validFailureCode(value.lastError))) {
      throw new Error("memory-bujo: completed-turn pending record is malformed.");
    }
    return value as unknown as PendingRecord;
  }
  if (!hasOnlyKeys(value, [
    "schemaVersion", "state", "id", "payloadHash", "runId", "conversationId", "summary", "captureText",
    "admittedAt", "revision", "attempt", "deadAt", "summaryWritten", "lastError",
  ]) || !canonicalTimestamp(value.deadAt) || !validFailureCode(value.lastError)) {
    throw new Error("memory-bujo: completed-turn dead letter is malformed.");
  }
  return value as unknown as DeadRecord;
}

function validatePayload(value: MemoryCompletedTurn): IntakePayload {
  if (!isRecord(value) || !hasOnlyKeys(value, ["runId", "conversationId", "summary", "captureText"])) {
    throw new Error("memory-bujo: completed-turn payload has unknown or missing fields.");
  }
  const runId = boundedText(value.runId, "runId", MAX_RUN_ID_BYTES, false);
  const conversationId = boundedText(value.conversationId, "conversationId", MAX_CONVERSATION_ID_BYTES, false);
  const summary = boundedText(value.summary, "summary", MAX_SUMMARY_BYTES, true);
  if (summary.includes("<!--mem") || /[\p{Zl}\p{Zp}]/u.test(summary)) {
    throw new Error("memory-bujo: completed-turn summary contains a reserved delimiter or line separator.");
  }
  let captureText: string | undefined;
  if (value.captureText !== undefined) {
    captureText = boundedText(value.captureText, "captureText", MAX_CAPTURE_TEXT_BYTES, true);
  }
  return { runId, conversationId, summary, ...(captureText === undefined ? {} : { captureText }) };
}

function boundedText(value: unknown, label: string, maxBytes: number, allowLayoutWhitespace: boolean): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0
    || Buffer.byteLength(value, "utf8") > maxBytes
    || /[\p{Cs}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
    || /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
    || (!allowLayoutWhitespace && /[\r\n\t]/u.test(value))) {
    throw new Error(`memory-bujo: completed-turn ${label} is invalid or exceeds its bound.`);
  }
  return value;
}

function payloadOf(record: PendingRecord | DeadRecord): MemoryCompletedTurn {
  return {
    runId: record.runId,
    conversationId: record.conversationId,
    summary: record.summary,
    ...(record.captureText === undefined ? {} : { captureText: record.captureText }),
  };
}

function idFor(runId: string): string {
  return createHash("sha256").update(runId, "utf8").digest("hex");
}

function hashPayload(payload: IntakePayload): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function serializeRecord(record: IntakeRecord): string {
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
    throw new Error("memory-bujo: completed-turn intake record exceeds its durable bound.");
  }
  return serialized;
}

function recordPath(state: IntakeState, id: string): string {
  return `${INTAKE_ROOT}/${state}/${id}.json`;
}

function assertId(id: string): void {
  if (!ID.test(id)) throw new Error("memory-bujo: completed-turn intake id is invalid.");
}

function canonicalNow(clock: () => Date): string {
  const date = clock();
  if (!Number.isFinite(date.getTime())) throw new Error("memory-bujo: completed-turn intake clock is invalid.");
  return date.toISOString();
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function validAttempt(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000;
}

function validFailureCode(value: unknown): value is FailureCode {
  return value === "model_output" || value === "provider" || value === "processing";
}

function failureCode(error: unknown): FailureCode {
  if (isRecord(error) && error.name === "MemoryModelOutputError") return "model_output";
  if (isRecord(error) && error.name === "MemoryModelError") return "provider";
  return "processing";
}

function retryDelay(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * (2 ** Math.min(Math.max(0, attempt - 1), 20)));
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected <= 0) {
    throw new Error(`memory-bujo: completed-turn intake ${label} must be a positive integer.`);
  }
  return selected;
}

function assertSecureDirectory(stat: Stats, label: string): void {
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== DIRECTORY_MODE
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error(`memory-bujo: completed-turn intake directory "${label}" must be owner-only and not a symlink.`);
  }
}

function assertSameNode(left: Stats, right: Stats): void {
  if (left.dev !== right.dev || left.ino !== right.ino) {
    throw new Error("memory-bujo: completed-turn intake directory changed during access.");
  }
}

function assertSecureParentIdentity(before: Stats, after: Stats): void {
  if (after.isSymbolicLink() || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error("memory-bujo: completed-turn intake parent changed during layout validation.");
  }
}

function fsyncSecureDirectory(path: string, expected: Stats): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    assertSameNode(expected, opened);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeWarn(warn: (message: string) => void, message: string): void {
  try { warn(message); } catch { /* Diagnostics cannot poison durable work. */ }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
