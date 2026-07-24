import type {
  ArtifactRef,
  JsonObject,
  ModuleToolContribution,
  RouteIdentity,
} from "@mono-agent/module-sdk";
import type {
  StateExecution,
  StateExecutionRequest,
  StateStore,
} from "@mono-agent/module-sdk/internal";

import {
  DurableRunJournal,
  createDurableFingerprint,
  type DeliveryIntentInput,
  type DeliverySettlementInput,
  type DeliverySettlementWithHistoryInput,
  type ExecutionMaintenanceInput,
  type ReconcileArtifactPublicationsInput,
  type RunAdmissionInput,
  type SettleRunInput,
  type StageRunArtifactsInput,
} from "./execution-journal.js";
import { ExecutionStore } from "./execution-store.js";
import {
  appendCanonicalTranscript,
  type CanonicalTranscript,
  type CanonicalTranscriptEntry,
} from "./execution-transcript.js";
import type {
  AgentInteractionEvidence,
  AgentRunAttemptEvidence,
} from "./execution-types.js";
import { createRunHistoryToolContribution } from "./run-history-tool.js";

const EXECUTION_OPERATION_MAX_BYTES = 128;

export const STATE_LOCAL_EXECUTION_OPERATIONS = Object.freeze([
  "protocol.describe",
  "fingerprint.create",
  "transcript.append",
  "conversation.open",
  "conversation.load",
  "conversation.list",
  "run.admit",
  "run.renew-admission",
  "run.record-attempt",
  "run.record-interaction",
  "run.stage-artifacts",
  "run.settle",
  "run.read-cached-response",
  "run.read",
  "run.list",
  "session.load",
  "session.evict",
  "delivery.prepare",
  "delivery.settle",
  "delivery.settle-with-history",
  "artifact-publications.reconcile",
  "maintenance.run",
] as const);

type StateLocalExecutionOperation = (typeof STATE_LOCAL_EXECUTION_OPERATIONS)[number];

export interface StateLocalExecutionOptions {
  readonly clock?: () => Date;
  readonly staleAfterMs?: number;
  readonly createRunId?: () => string;
  readonly createDeliveryToken?: () => string;
  readonly releaseArtifact?: (
    ref: ArtifactRef,
    signal: AbortSignal,
  ) => Promise<boolean>;
}

/**
 * State-local's private durable execution protocol.
 *
 * Only `StateExecution.perform()` is exposed through Module SDK. The concrete
 * operation names live here so durable schemas can evolve with their owner
 * without promoting Core domain objects into public module contracts.
 */
export class StateLocalExecution implements StateExecution {
  readonly toolContributions: readonly ModuleToolContribution[];
  readonly #journal: DurableRunJournal;
  #operation: Promise<void> = Promise.resolve();

  constructor(state: StateStore, options: StateLocalExecutionOptions = {}) {
    this.#journal = new DurableRunJournal(new ExecutionStore(state), options);
    this.toolContributions = Object.freeze([
      createRunHistoryToolContribution({
        listRuns: (cursor, signal) =>
          this.#enqueue(() => this.#journal.listRuns(cursor, signal)),
        readRun: (runId, signal) =>
          this.#enqueue(() => this.#journal.readRun(runId, signal)),
      }),
    ]);
  }

  perform(request: StateExecutionRequest): Promise<unknown> {
    return this.#enqueue(() => this.#perform(request));
  }

  #enqueue<T>(execute: () => Promise<T>): Promise<T> {
    const pending = this.#operation.then(execute, execute);
    this.#operation = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async #perform(request: StateExecutionRequest): Promise<unknown> {
    const operation = executionOperation(request.operation);
    throwIfAborted(request.signal);

    switch (operation) {
      case "protocol.describe":
        requireNoInput(request.input, operation);
        return Object.freeze({
          protocol: "mono-agent.state-execution",
          version: 1,
          operations: STATE_LOCAL_EXECUTION_OPERATIONS,
        });
      case "fingerprint.create":
        return createDurableFingerprint(request.input);
      case "transcript.append": {
        const input = inputRecord(
          request.input,
          operation,
          ["current", "conversationId", "entries"],
        );
        return appendCanonicalTranscript(
          input.current as CanonicalTranscript | undefined,
          requiredConversationId(
            input.conversationId,
            `${operation}.conversationId`,
          ),
          input.entries as readonly CanonicalTranscriptEntry[],
        );
      }
      case "conversation.open": {
        const input = optionalInputRecord(
          request.input,
          operation,
          ["title", "initialText", "metadata"],
        );
        return this.#journal.openConversation(
          input as {
            readonly title?: string;
            readonly initialText?: string;
            readonly metadata?: JsonObject;
          },
          request.signal,
        );
      }
      case "conversation.load": {
        const input = inputRecord(request.input, operation, ["conversationId"]);
        return this.#journal.loadConversation(
          requiredConversationId(
            input.conversationId,
            `${operation}.conversationId`,
          ),
          request.signal,
        );
      }
      case "conversation.list": {
        const input = optionalInputRecord(request.input, operation, ["cursor"]);
        return this.#journal.listConversations(
          optionalString(input.cursor, `${operation}.cursor`),
          request.signal,
        );
      }
      case "run.admit": {
        const input = inputRecord(
          request.input,
          operation,
          ["requestId", "conversationId", "fingerprint", "runId"],
        );
        return this.#journal.admit({
          ...input,
          signal: request.signal,
        } as unknown as RunAdmissionInput);
      }
      case "run.renew-admission": {
        const input = inputRecord(request.input, operation, ["requestId", "runId"]);
        return this.#journal.renewAdmission(
          requiredIdentifier(input.requestId, `${operation}.requestId`),
          requiredIdentifier(input.runId, `${operation}.runId`),
          request.signal,
        );
      }
      case "run.record-attempt": {
        const input = inputRecord(request.input, operation, ["runId", "attempt"]);
        return this.#journal.recordAttempt(
          requiredIdentifier(input.runId, `${operation}.runId`),
          input.attempt as AgentRunAttemptEvidence,
          request.signal,
        );
      }
      case "run.record-interaction": {
        const input = inputRecord(request.input, operation, ["runId", "evidence"]);
        return this.#journal.recordInteraction(
          requiredIdentifier(input.runId, `${operation}.runId`),
          input.evidence as AgentInteractionEvidence,
          request.signal,
        );
      }
      case "run.stage-artifacts": {
        const input = inputRecord(
          request.input,
          operation,
          ["runId", "requestId", "artifacts"],
        );
        return this.#journal.stageRunArtifacts({
          ...input,
          signal: request.signal,
        } as unknown as StageRunArtifactsInput);
      }
      case "run.settle": {
        const input = inputRecord(
          request.input,
          operation,
          [
            "runId",
            "requestId",
            "status",
            "transcript",
            "responseBytes",
            "session",
            "sessionEviction",
            "failureCode",
          ],
        );
        return this.#journal.settle({
          ...input,
          signal: request.signal,
        } as unknown as SettleRunInput);
      }
      case "run.read-cached-response": {
        const input = inputRecord(request.input, operation, ["ref"]);
        return this.#journal.readCachedResponse(
          input.ref as ArtifactRef,
          request.signal,
        );
      }
      case "run.read": {
        const input = inputRecord(request.input, operation, ["runId"]);
        return this.#journal.readRun(
          requiredIdentifier(input.runId, `${operation}.runId`),
          request.signal,
        );
      }
      case "run.list": {
        const input = optionalInputRecord(request.input, operation, ["cursor"]);
        return this.#journal.listRuns(
          optionalString(input.cursor, `${operation}.cursor`),
          request.signal,
        );
      }
      case "session.load": {
        const input = inputRecord(
          request.input,
          operation,
          ["conversationId", "route"],
        );
        return this.#journal.loadSession(
          requiredConversationId(
            input.conversationId,
            `${operation}.conversationId`,
          ),
          input.route as RouteIdentity,
          request.signal,
        );
      }
      case "session.evict": {
        const input = inputRecord(
          request.input,
          operation,
          ["conversationId", "route", "expected"],
        );
        return this.#journal.evictSession(
          requiredConversationId(
            input.conversationId,
            `${operation}.conversationId`,
          ),
          input.route as RouteIdentity,
          input.expected as { readonly sessionId: string; readonly updatedAt: string },
          request.signal,
        );
      }
      case "delivery.prepare": {
        const input = inputRecord(
          request.input,
          operation,
          ["idempotencyKey", "fingerprint", "channelInstanceId", "runId"],
        );
        return this.#journal.prepareDelivery({
          ...input,
          signal: request.signal,
        } as unknown as DeliveryIntentInput);
      }
      case "delivery.settle": {
        const input = inputRecord(
          request.input,
          operation,
          [
            "idempotencyKey",
            "fingerprint",
            "attempt",
            "token",
            "status",
            "messageId",
            "code",
          ],
        );
        return this.#journal.settleDelivery({
          ...input,
          signal: request.signal,
        } as unknown as DeliverySettlementInput);
      }
      case "delivery.settle-with-history": {
        const input = inputRecord(
          request.input,
          operation,
          [
            "idempotencyKey",
            "fingerprint",
            "attempt",
            "token",
            "messageId",
            "conversationId",
            "entry",
            "entryFingerprint",
          ],
        );
        return this.#journal.settleDeliveryWithHistory({
          ...input,
          signal: request.signal,
        } as unknown as DeliverySettlementWithHistoryInput);
      }
      case "artifact-publications.reconcile": {
        const input = optionalInputRecord(
          request.input,
          operation,
          ["cursor", "limit"],
        );
        return this.#journal.reconcileArtifactPublications({
          ...input,
          signal: request.signal,
        } as unknown as ReconcileArtifactPublicationsInput);
      }
      case "maintenance.run": {
        const input = inputRecord(
          request.input,
          operation,
          ["cutoffAt", "dryRun", "limit"],
        );
        return this.#journal.maintainExecution({
          ...input,
          signal: request.signal,
        } as unknown as ExecutionMaintenanceInput);
      }
    }
  }
}

function executionOperation(value: unknown): StateLocalExecutionOperation {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > EXECUTION_OPERATION_MAX_BYTES
    || !STATE_LOCAL_EXECUTION_OPERATIONS.includes(value as StateLocalExecutionOperation)
  ) {
    throw new TypeError("state execution operation is unsupported");
  }
  return value as StateLocalExecutionOperation;
}

function optionalInputRecord(
  value: unknown,
  operation: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  return value === undefined
    ? Object.create(null) as Record<string, unknown>
    : inputRecord(value, operation, allowedKeys);
}

function inputRecord(
  value: unknown,
  operation: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${operation} input must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${operation} input must be a plain object`);
  }
  const allowed = new Set(allowedKeys);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${operation} input contains an unsupported field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${operation}.${key} must be an own data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function requireNoInput(value: unknown, operation: string): void {
  if (value !== undefined) {
    const input = inputRecord(value, operation, []);
    if (Object.keys(input).length !== 0) {
      throw new TypeError(`${operation} does not accept input`);
    }
  }
}

function requiredBoundedString(
  value: unknown,
  path: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new TypeError(`${path} must be a bounded non-empty string`);
  }
  return value;
}

function requiredIdentifier(value: unknown, path: string): string {
  return requiredBoundedString(value, path, 512);
}

function requiredConversationId(value: unknown, path: string): string {
  return requiredBoundedString(value, path, 4_096);
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined
    ? undefined
    : requiredBoundedString(value, path, 4_096);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error("State execution was aborted.");
    error.name = "AbortError";
    throw error;
  }
}
