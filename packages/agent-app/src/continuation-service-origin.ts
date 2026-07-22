import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import {
  assertAgentContinuationOriginContext,
  type AgentContinuationOriginContext,
} from "@mono-agent/agent-contracts";

import type { ContinuationStore, DurableContinuationRecord } from "./continuation-store.js";
import {
  ContinuationOperationTimeoutError,
  ContinuationProtocolError,
  ContinuationServiceStoppingError,
} from "./continuation-service-errors.js";
import {
  continuationOperatorToken,
  errorRecord,
  originContextBindingMac,
  resolveContinuationLimits,
} from "./continuation-service-helpers.js";
import {
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_DEADLINE_MS,
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_WORKER_INTERVAL_MS,
  type ClaimBinding,
  type ContinuationServiceLogger,
  type ContinuationServiceOptions,
  type ResolvedOriginContext,
} from "./continuation-service-types.js";
import {
  TERMINAL_CONTINUATION_STATES,
  continuationDigest,
  type ContinuationLimits,
  type NamedContinuationRoute,
} from "./continuations.js";

export abstract class ContinuationOriginService {
  protected readonly instanceId = randomUUID();
  protected readonly operatorToken: string;
  protected readonly claimBindings = new Map<string, ClaimBinding>();
  protected readonly activeClaimBindings = new Set<ClaimBinding>();
  protected readonly namedRoutes: Readonly<Record<string, NamedContinuationRoute>>;
  protected readonly detachedServiceTokenHashes: ReadonlyMap<string, string>;
  protected readonly maxResultBytes: number;
  protected readonly maxDeadlineMs: number;
  protected readonly leaseMs: number;
  protected readonly workerIntervalMs: number;
  protected readonly autoProcess: boolean;
  protected readonly limits: ContinuationLimits;
  protected readonly now: () => Date;
  protected readonly logger: ContinuationServiceLogger | undefined;
  protected readonly lifecycleAbort = new AbortController();
  protected readonly inFlight = new Map<string, Promise<boolean>>();
  protected readonly activeHttpRequests = new Set<Promise<void>>();
  protected activeHandleOperations = 0;
  protected handleDrainPromise: Promise<void> | undefined;
  protected resolveHandleDrain: (() => void) | undefined;
  protected readonly resolvingUnknown = new Set<string>();
  protected dispatchTail: Promise<void> = Promise.resolve();
  protected server: Server | undefined;
  protected baseUrl = "";
  protected worker: ReturnType<typeof setInterval> | undefined;
  protected stopped = false;
  protected stopPromise: Promise<void> | undefined;

  constructor(
    protected readonly store: ContinuationStore,
    protected readonly secret: Buffer,
    protected readonly options: ContinuationServiceOptions,
    protected readonly releaseStoreLock: () => Promise<void>,
  ) {
    this.namedRoutes = options.namedRoutes ?? {};
    this.operatorToken = continuationOperatorToken(secret);
    this.detachedServiceTokenHashes = new Map(Object.entries(options.detachedServices ?? {}).map(
      ([name, token]) => [name, continuationDigest(token)],
    ));
    this.maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    this.maxDeadlineMs = options.maxDeadlineMs ?? DEFAULT_MAX_DEADLINE_MS;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.workerIntervalMs = options.workerIntervalMs ?? DEFAULT_WORKER_INTERVAL_MS;
    this.autoProcess = options.autoProcess !== false;
    this.limits = resolveContinuationLimits(options.limits);
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
  }

  abstract processDue(limit?: number): Promise<number>;

  protected throwIfStopping(): void {
    if (this.stopped || this.lifecycleAbort.signal.aborted) {
      throw new ContinuationServiceStoppingError();
    }
  }

  protected async runBoundedOperation<T>(
    phase: "synthesis" | "delivery",
    timeoutMs: number,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    this.throwIfStopping();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new ContinuationOperationTimeoutError(phase, timeoutMs)), timeoutMs);
      timeout.unref?.();
    });
    const stopped = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new ContinuationServiceStoppingError());
      this.lifecycleAbort.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([Promise.resolve().then(operation), timedOut, stopped]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (onAbort !== undefined) this.lifecycleAbort.signal.removeEventListener("abort", onAbort);
    }
  }

  protected async runHandleOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new Error("Continuation service is stopped.");
    this.activeHandleOperations += 1;
    try {
      return await operation();
    } finally {
      this.activeHandleOperations -= 1;
      if (this.stopped && this.activeHandleOperations === 0) {
        this.resolveHandleDrain?.();
        this.resolveHandleDrain = undefined;
        this.handleDrainPromise = undefined;
      }
    }
  }

  protected async drainHandleOperations(): Promise<void> {
    if (this.activeHandleOperations === 0) return;
    this.handleDrainPromise ??= new Promise<void>((resolve) => { this.resolveHandleDrain = resolve; });
    await this.handleDrainPromise;
  }

  protected async closeClaimBinding(token: string, binding: ClaimBinding): Promise<void> {
    binding.closed = true;
    if (this.claimBindings.get(token) === binding) this.claimBindings.delete(token);
    if (binding.inFlightOperations === 0) return;
    binding.drainPromise ??= new Promise<void>((resolve) => { binding.resolveDrain = resolve; });
    await binding.drainPromise;
  }

  protected beginClaim(binding: ClaimBinding): () => void {
    if (binding.closed) {
      throw new ContinuationProtocolError(401, "invalid_claim_capability", "Invalid or expired claim capability.");
    }
    binding.inFlightOperations += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      binding.inFlightOperations -= 1;
      if (binding.closed && binding.inFlightOperations === 0) {
        binding.resolveDrain?.();
        delete binding.resolveDrain;
        delete binding.drainPromise;
      }
    };
  }

  protected async requiresOriginContext(binding: ClaimBinding): Promise<boolean> {
    if (this.stopped || binding.settled) return false;
    if (!binding.closed) {
      throw new Error("Continuation claims must be revoked before origin settlement is inspected.");
    }
    if (binding.inFlightOperations > 0) {
      binding.drainPromise ??= new Promise<void>((resolve) => { binding.resolveDrain = resolve; });
      await binding.drainPromise;
    }
    const finishOperation = this.beginOriginSettlementOperation(binding);
    if (finishOperation === undefined) return false;
    try {
      if (binding.historyBoundary === undefined) {
        this.settleClaimBinding(binding);
        return false;
      }
      const required = (await this.store.list()).some((record) =>
        record.claimFingerprint === binding.fingerprint
        && !TERMINAL_CONTINUATION_STATES.has(record.state));
      if (!required) this.settleClaimBinding(binding);
      return required;
    } finally {
      finishOperation();
    }
  }

  private beginOriginSettlementOperation(binding: ClaimBinding): (() => void) | undefined {
    if (this.stopped || binding.settled) return undefined;
    if (!binding.closed) {
      throw new Error("Continuation claims must be revoked before origin settlement begins.");
    }
    if (binding.inFlightOperations !== 0) {
      throw new Error("Continuation capability release has not finished draining admitted work.");
    }
    binding.inFlightOperations += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      binding.inFlightOperations -= 1;
      if (binding.closed && binding.inFlightOperations === 0) {
        binding.resolveDrain?.();
        delete binding.resolveDrain;
        delete binding.drainPromise;
      }
    };
  }

  protected settleClaimBinding(binding: ClaimBinding): void {
    binding.settled = true;
    this.activeClaimBindings.delete(binding);
  }

  protected async finalizeOriginContext(
    binding: ClaimBinding,
    snapshot: AgentContinuationOriginContext,
  ): Promise<void> {
    const finishOperation = this.beginOriginSettlementOperation(binding);
    if (finishOperation === undefined) return;
    try {
      if (binding.historyBoundary === undefined) return;
      assertAgentContinuationOriginContext(snapshot);
      if (snapshot.conversationId !== binding.originConversationId
        || snapshot.originRunId !== binding.originRunId
        || snapshot.historyBoundary !== binding.historyBoundary) {
        throw new Error("Continuation origin context does not match its immutable claim binding.");
      }
      const matching = (await this.store.list()).filter((record) =>
        record.claimFingerprint === binding.fingerprint
        && !TERMINAL_CONTINUATION_STATES.has(record.state));
      if (matching.length === 0) return;
      const pin = await this.store.stageOriginContext(snapshot);
      try {
        await this.store.mutate((records) => {
          const candidates = [...records.values()].filter((record) =>
            record.claimFingerprint === binding.fingerprint
            && !TERMINAL_CONTINUATION_STATES.has(record.state));
          for (const record of candidates) {
            if (record.originContextState === "pinned"
              || (record.originContextState === "pending" && record.originContextRef !== undefined)) {
              if (record.originContextDigest !== pin.reference.digest
                || record.originContextRef?.digest !== pin.reference.digest) {
                throw new Error("Continuation origin context conflicts with an existing pinned snapshot.");
              }
              continue;
            }
            if (record.originContextState !== "pending") {
              throw new Error(`Continuation origin context cannot be finalized from ${record.originContextState}.`);
            }
            record.originContextRef = pin.reference;
            record.originContextDigest = pin.reference.digest;
            record.originContextMessageCount = pin.reference.messageCount;
            record.originContextFingerprint = continuationDigest(
              `mono-agent-origin-context-binding-v2\0${record.claimFingerprint}\0${pin.reference.digest}`,
            );
            record.originContextBindingMac = originContextBindingMac(this.secret, record, pin.reference);
            record.updatedAt = this.now().toISOString();
          }
        });
      } finally {
        await pin.release();
      }
    } finally {
      finishOperation();
    }
  }

  protected async activateOriginContext(binding: ClaimBinding): Promise<void> {
    const finishOperation = this.beginOriginSettlementOperation(binding);
    if (finishOperation === undefined) return;
    try {
      await this.store.activateOriginContextGroup({
        claimFingerprint: binding.fingerprint,
        activatedAt: this.now().toISOString(),
      });
      this.settleClaimBinding(binding);
    } finally {
      finishOperation();
    }
  }

  protected async abandonOriginContext(binding: ClaimBinding): Promise<void> {
    const finishOperation = this.beginOriginSettlementOperation(binding);
    if (finishOperation === undefined) return;
    const at = this.now().toISOString();
    try {
      await this.store.mutate((records) => {
        for (const record of records.values()) {
          if (record.claimFingerprint !== binding.fingerprint || record.originContextState !== "pending") continue;
          record.originContextState = "abandoned";
          delete record.originContextRef;
          record.updatedAt = at;
          record.lastError = errorRecord(
            "origin_context_unavailable",
            "The origin run did not commit its pinned continuation context.",
            at,
          );
          delete record.nextAttemptAt;
        }
      });
      this.settleClaimBinding(binding);
      if (this.autoProcess) void this.processDue().catch(() => undefined);
    } finally {
      finishOperation();
    }
  }

  protected async resolveOriginContext(record: DurableContinuationRecord): Promise<ResolvedOriginContext> {
    if (record.originContextState === "detached_latest") return { kind: "ready", policy: "detached_latest" };
    if (record.originContextState === "pending") return { kind: "pending" };
    if (record.originContextState !== "pinned" || record.originContextRef === undefined) {
      return { kind: "unavailable" };
    }
    const expectedFingerprint = continuationDigest(
      `mono-agent-origin-context-binding-v2\0${record.claimFingerprint}\0${record.originContextRef.digest}`,
    );
    const expectedMac = originContextBindingMac(this.secret, record, record.originContextRef);
    if (record.originContextDigest !== record.originContextRef.digest
      || record.originContextFingerprint !== expectedFingerprint
      || record.originContextBindingMac !== expectedMac) {
      return { kind: "invalid", code: "origin_context_binding_invalid" };
    }
    let snapshot: AgentContinuationOriginContext | undefined;
    try {
      snapshot = await this.store.loadOriginContext(record.originContextRef);
    } catch {
      await this.markOriginContextUnavailable(record.continuationId, "origin_context_unreadable");
      return { kind: "unavailable" };
    }
    if (snapshot === undefined
      || snapshot.conversationId !== record.originConversationId
      || snapshot.originRunId !== record.originRunId
      || snapshot.historyBoundary !== record.historyBoundary) {
      await this.markOriginContextUnavailable(record.continuationId, "origin_context_missing_or_corrupt");
      return { kind: "unavailable" };
    }
    return { kind: "ready", policy: "pinned", snapshot };
  }

  private async markOriginContextUnavailable(id: string, code: string): Promise<void> {
    await this.store.mutate((records) => {
      const current = records.get(id);
      if (current === undefined) throw new ContinuationProtocolError(404, "not_found", "Continuation not found.");
      if (current.leaseOwner !== this.instanceId) {
        throw new ContinuationProtocolError(409, "lease_lost", "Continuation processing lease was lost.");
      }
      current.originContextState = "abandoned";
      delete current.originContextRef;
      current.updatedAt = this.now().toISOString();
      current.lastError = errorRecord(code, "Pinned origin context is unavailable.", current.updatedAt);
    });
  }
}
