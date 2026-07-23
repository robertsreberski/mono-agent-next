import { createHash, randomUUID } from "node:crypto";

import {
  parseArtifactRef,
  parseRouteIdentity,
  type ArtifactRef,
  type JsonObject,
  type JsonValue,
  type RuntimeSession,
  type RouteIdentity,
} from "@mono-agent/module-sdk";

import {
  EXECUTION_STATE_PREFIXES,
  ExecutionStore,
  admissionStateKey,
  artifactIntentStateKey,
  conversationStateKey,
  describeExecutionArtifact,
  deliveryStateKey,
  runEventPrefix,
  runEventStateKey,
  runHistoryStateKey,
  runStateKey,
  sessionStateKey,
  type ExecutionArtifactDescriptor,
  type ExecutionRecord,
} from "./execution-store.js";
import {
  assertCanonicalTranscriptAppendOnly,
  decodeCanonicalTranscript,
  encodeCanonicalTranscript,
  parseCanonicalTranscript,
  parseInteractionEvidence,
  type CanonicalTranscript,
} from "./transcript.js";
import type {
  AgentInteractionEvidence,
  AgentRunAttemptEvidence,
  AgentRunEvent,
  AgentRunHistoryPage,
  AgentRunRecord,
  AgentRunStatus,
  AgentRunSummary,
} from "./types.js";

const DEFAULT_STALE_AFTER_MS = 30 * 60_000;
const MIN_STALE_AFTER_MS = 1_000;
const MAX_STALE_AFTER_MS = 24 * 60 * 60_000;
const RUN_HISTORY_PAGE_SIZE = 50;
const RUN_EVENT_PAGE_SIZE = 1_000;
const RUN_MAX_EVENTS = 10_000;
const RUN_MAX_ATTEMPTS = 1_000;
const RUN_ARTIFACT_MAX_ITEMS = 512;
const RUN_CONTENT_ARTIFACT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const ARTIFACT_RECONCILIATION_DEFAULT_LIMIT = 50;
const ARTIFACT_RECONCILIATION_MAX_LIMIT = 200;
const ARTIFACT_CLEANUP_TIMEOUT_MS = 5_000;
const FINGERPRINT_MAX_ITEMS = 20_000;
const FINGERPRINT_MAX_BYTES = 16 * 1024 * 1024;
const IDENTIFIER_MAX_BYTES = 4_096;
const CODE_MAX_BYTES = 512;
const SESSION_METADATA_MAX_ITEMS = 10_000;
const SESSION_METADATA_MAX_BYTES = 64 * 1024;
const INTERNAL_ARTIFACT_SLOT_PREFIX = "@core/";
const TRANSCRIPT_ARTIFACT_SLOT = `${INTERNAL_ARTIFACT_SLOT_PREFIX}transcript`;
const RESPONSE_ARTIFACT_SLOT = `${INTERNAL_ARTIFACT_SLOT_PREFIX}response`;

export type DurableFingerprint = `sha256:${string}`;

interface AdmissionRecord {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.admission";
  readonly requestId: string;
  readonly conversationId: string;
  readonly fingerprint: DurableFingerprint;
  readonly runId: string;
  readonly status: "running" | "settled" | "uncertain";
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly leaseExpiresAt: string;
  readonly settledStatus?: Exclude<AgentRunStatus, "running">;
  readonly responseRef?: ArtifactRef;
}

interface StoredRunRecord {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.run";
  readonly summary: AgentRunSummary;
  readonly eventCount: number;
  readonly transcriptRef?: ArtifactRef;
}

interface StoredRunEvent {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.run-event";
  readonly event: AgentRunEvent;
}

interface RunHistoryRecord {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.run-history";
  readonly runId: string;
  readonly startedAt: string;
}

interface ConversationRecord {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.conversation";
  readonly conversationId: string;
  readonly revision: number;
  readonly transcriptRef: ArtifactRef;
  readonly entryCount: number;
  readonly updatedAt: string;
}

interface ProviderSessionRecord {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.provider-session";
  readonly conversationId: string;
  readonly route: RouteIdentity;
  readonly session: RuntimeSession;
  readonly updatedAt: string;
}

interface ArtifactPublicationDescriptor extends ExecutionArtifactDescriptor {
  readonly slot: string;
}

interface ArtifactPublicationIntentRecord {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.artifact-publication-intent";
  readonly runId: string;
  readonly requestId: string;
  /** Descriptors that may still be promoted by a successful run settlement. */
  readonly artifacts: readonly ArtifactPublicationDescriptor[];
  /** Descriptors whose physical deletion has not yet been proven. */
  readonly cleanupArtifacts: readonly ArtifactPublicationDescriptor[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface EnsuredArtifactIntent {
  readonly record: ExecutionRecord<ArtifactPublicationIntentRecord>;
  /** Slots newly added or restored from cleanup by this publication attempt. */
  readonly activatedSlots: ReadonlySet<string>;
}

type DeliveryStatus = "intent" | "delivered" | "failed" | "unknown";

interface DeliveryRecord {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.delivery";
  readonly idempotencyKey: string;
  readonly fingerprint: DurableFingerprint;
  readonly channelInstanceId: string;
  readonly runId?: string;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly attemptToken: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly leaseExpiresAt?: string;
  readonly messageId?: string;
  readonly code?: string;
}

export interface RunAdmissionInput {
  readonly requestId: string;
  readonly conversationId: string;
  readonly fingerprint: DurableFingerprint;
  readonly runId?: string;
  readonly signal: AbortSignal;
}

export type RunAdmissionResult =
  | { readonly status: "accepted"; readonly summary: AgentRunSummary }
  | { readonly status: "join"; readonly runId: string }
  | {
      readonly status: "cached";
      readonly summary: AgentRunSummary;
      readonly responseRef?: ArtifactRef;
    }
  | { readonly status: "conflict"; readonly runId: string }
  | { readonly status: "uncertain"; readonly runId: string };

export interface SettleRunInput {
  readonly runId: string;
  readonly requestId: string;
  readonly status: Exclude<AgentRunStatus, "running">;
  readonly transcript?: CanonicalTranscript;
  readonly responseBytes?: Uint8Array;
  readonly session?: {
    readonly value: RuntimeSession;
    readonly updatedAt: string;
  };
  readonly sessionEviction?: RouteIdentity;
  readonly failureCode?: string;
  readonly signal: AbortSignal;
}

export interface StageRunArtifactInput {
  readonly slot: string;
  readonly data: Uint8Array;
  readonly mediaType: string;
  readonly fileName?: string;
}

export interface StageRunArtifactsInput {
  readonly runId: string;
  readonly requestId: string;
  readonly artifacts: readonly StageRunArtifactInput[];
  readonly signal: AbortSignal;
}

export interface StagedRunArtifact {
  readonly slot: string;
  readonly ref: ArtifactRef;
}

export interface DeliveryIntentInput {
  readonly idempotencyKey: string;
  readonly fingerprint: DurableFingerprint;
  readonly channelInstanceId: string;
  readonly runId?: string;
  readonly signal: AbortSignal;
}

export type DeliveryIntentResult =
  | { readonly status: "send"; readonly attempt: number; readonly token: string }
  | { readonly status: "join" }
  | { readonly status: "duplicate"; readonly messageId?: string }
  | { readonly status: "conflict" }
  | { readonly status: "unknown"; readonly code?: string };

export interface DeliverySettlementInput {
  readonly idempotencyKey: string;
  readonly fingerprint: DurableFingerprint;
  readonly attempt: number;
  readonly token: string;
  readonly status: "delivered" | "failed" | "unknown";
  readonly messageId?: string;
  readonly code?: string;
  readonly signal: AbortSignal;
}

export interface DurableRunJournalOptions {
  readonly clock?: () => Date;
  readonly staleAfterMs?: number;
  readonly createRunId?: () => string;
  readonly createDeliveryToken?: () => string;
}

export interface ReconcileArtifactPublicationsInput {
  readonly cursor?: string;
  readonly limit?: number;
  readonly signal: AbortSignal;
}

export interface ArtifactPublicationReconciliation {
  readonly examined: number;
  readonly deletedArtifacts: number;
  readonly pendingArtifacts: number;
  readonly skippedActive: number;
  readonly nextCursor?: string;
}

export class DurableRunJournal {
  readonly #store: ExecutionStore;
  readonly #clock: () => Date;
  readonly #staleAfterMs: number;
  readonly #createRunId: () => string;
  readonly #createDeliveryToken: () => string;

  constructor(store: ExecutionStore, options: DurableRunJournalOptions = {}) {
    this.#store = store;
    this.#clock = options.clock ?? (() => new Date());
    this.#staleAfterMs = boundedDuration(
      options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
      "staleAfterMs",
    );
    this.#createRunId = options.createRunId ?? randomUUID;
    this.#createDeliveryToken = options.createDeliveryToken ?? randomUUID;
  }

  async admit(input: RunAdmissionInput): Promise<RunAdmissionResult> {
    const requestId = boundedIdentifier(input.requestId, "requestId");
    const conversationId = boundedIdentifier(input.conversationId, "conversationId");
    const fingerprint = parseFingerprint(input.fingerprint, "fingerprint");
    const admissionKey = admissionStateKey(requestId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await this.#store.read(admissionKey, parseAdmissionRecord, input.signal);
      if (existing !== undefined) {
        return this.#existingAdmission(existing, conversationId, fingerprint, input.signal);
      }
      const runId = boundedIdentifier(input.runId ?? this.#createRunId(), "runId");
      const now = canonicalNow(this.#clock);
      const leaseExpiresAt = addMilliseconds(now, this.#staleAfterMs);
      const summary = freezeSummary({
        runId,
        requestId,
        conversationId,
        status: "running",
        startedAt: now,
        updatedAt: now,
        attempts: [],
      });
      const admission: AdmissionRecord = Object.freeze({
        schemaVersion: 1,
        kind: "mono-agent.admission",
        requestId,
        conversationId,
        fingerprint,
        runId,
        status: "running",
        startedAt: now,
        updatedAt: now,
        leaseExpiresAt,
      });
      const event: AgentRunEvent = Object.freeze({
        type: "admitted",
        runId,
        sequence: 0,
        recordedAt: now,
      });
      const run: StoredRunRecord = Object.freeze({
        schemaVersion: 1,
        kind: "mono-agent.run",
        summary,
        eventCount: 1,
      });
      const history: RunHistoryRecord = Object.freeze({
        schemaVersion: 1,
        kind: "mono-agent.run-history",
        runId,
        startedAt: now,
      });
      const result = await this.#store.transaction({
        puts: [
          { key: admissionKey, expectedVersion: null, value: admission },
          { key: runStateKey(runId), expectedVersion: null, value: run },
          {
            key: runEventStateKey(runId, 0),
            expectedVersion: null,
            value: eventRecord(event),
          },
          {
            key: runHistoryStateKey(now, runId),
            expectedVersion: null,
            value: history,
          },
        ],
        signal: input.signal,
      });
      if (result.status === "applied") return { status: "accepted", summary };
      if (!result.conflicts.some((conflict) => conflict.key === admissionKey)) {
        throw new Error("run admission collided with an unrelated durable identity");
      }
    }
    throw new Error("run admission did not converge after contention");
  }

  async renewAdmission(
    requestId: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const key = admissionStateKey(boundedIdentifier(requestId, "requestId"));
    const normalizedRunId = boundedIdentifier(runId, "runId");
    const current = await this.#store.read(key, parseAdmissionRecord, signal);
    if (
      current === undefined
      || current.value.runId !== normalizedRunId
      || current.value.status !== "running"
    ) {
      return false;
    }
    const now = canonicalNow(this.#clock);
    const updated: AdmissionRecord = Object.freeze({
      ...current.value,
      updatedAt: now,
      leaseExpiresAt: addMilliseconds(now, this.#staleAfterMs),
    });
    const result = await this.#store.transaction({
      puts: [{ key, expectedVersion: current.version, value: updated }],
      signal,
    });
    return result.status === "applied";
  }

  async recordAttempt(
    runId: string,
    attempt: AgentRunAttemptEvidence,
    signal: AbortSignal,
  ): Promise<AgentRunSummary> {
    const normalizedRunId = boundedIdentifier(runId, "runId");
    const evidence = parseRunAttemptEvidence(attempt, "attempt");
    if (evidence.route.runtimeInstanceId.length === 0) {
      throw new TypeError("attempt route must name a runtime");
    }
    for (let retry = 0; retry < 3; retry += 1) {
      const stored = await this.#requireRunningRun(normalizedRunId, signal);
      if (evidence.attempt > stored.value.summary.attempts.length + 1) {
        throw new RangeError("attempt evidence skipped an attempt number");
      }
      const attempts = [...stored.value.summary.attempts];
      const prior = attempts[evidence.attempt - 1];
      if (prior !== undefined && prior.status !== "started") {
        if (sameAttempt(prior, evidence)) return stored.value.summary;
        throw new Error("terminal attempt evidence cannot be rewritten");
      }
      if (prior !== undefined && evidence.status === "started") {
        if (sameAttempt(prior, evidence)) return stored.value.summary;
        throw new Error("started attempt evidence cannot be rewritten");
      }
      if (prior === undefined) attempts.push(evidence);
      else attempts[evidence.attempt - 1] = evidence;
      if (attempts.length > RUN_MAX_ATTEMPTS) throw new RangeError("run exceeds its attempt limit");
      const now = canonicalNow(this.#clock);
      const event = Object.freeze({
        type: "attempt",
        runId: normalizedRunId,
        sequence: stored.value.eventCount,
        recordedAt: now,
        attempt: evidence,
      } as const satisfies AgentRunEvent);
      const updated: StoredRunRecord = Object.freeze({
        ...stored.value,
        summary: freezeSummary({
          ...stored.value.summary,
          updatedAt: now,
          attempts,
        }),
        eventCount: nextEventCount(stored.value.eventCount),
      });
      const result = await this.#store.transaction({
        puts: [
          { key: stored.key, expectedVersion: stored.version, value: updated },
          {
            key: runEventStateKey(normalizedRunId, event.sequence),
            expectedVersion: null,
            value: eventRecord(event),
          },
        ],
        signal,
      });
      if (result.status === "applied") return updated.summary;
    }
    throw new Error("attempt recording did not converge after contention");
  }

  async recordInteraction(
    runId: string,
    evidence: AgentInteractionEvidence,
    signal: AbortSignal,
  ): Promise<AgentRunSummary> {
    const normalizedRunId = boundedIdentifier(runId, "runId");
    const normalizedEvidence = parseInteractionEvidence(evidence, "interaction evidence");
    for (let retry = 0; retry < 3; retry += 1) {
      const stored = await this.#requireRunningRun(normalizedRunId, signal);
      const now = canonicalNow(this.#clock);
      const event = Object.freeze({
        type: "interaction",
        runId: normalizedRunId,
        sequence: stored.value.eventCount,
        recordedAt: now,
        evidence: normalizedEvidence,
      } as const satisfies AgentRunEvent);
      const updated: StoredRunRecord = Object.freeze({
        ...stored.value,
        summary: freezeSummary({ ...stored.value.summary, updatedAt: now }),
        eventCount: nextEventCount(stored.value.eventCount),
      });
      const result = await this.#store.transaction({
        puts: [
          { key: stored.key, expectedVersion: stored.version, value: updated },
          {
            key: runEventStateKey(normalizedRunId, event.sequence),
            expectedVersion: null,
            value: eventRecord(event),
          },
        ],
        signal,
      });
      if (result.status === "applied") return updated.summary;
    }
    throw new Error("interaction recording did not converge after contention");
  }

  async stageRunArtifacts(
    input: StageRunArtifactsInput,
  ): Promise<readonly StagedRunArtifact[]> {
    const runId = boundedIdentifier(input.runId, "runId");
    const requestId = boundedIdentifier(input.requestId, "requestId");
    const rawArtifacts = denseOwnDataArray(
      input.artifacts,
      "artifacts",
      RUN_ARTIFACT_MAX_ITEMS,
    );
    if (rawArtifacts.length === 0) return Object.freeze([]);
    const seenSlots = new Set<string>();
    const plans = rawArtifacts.map((value, index) => {
      const path = `artifacts.${String(index)}`;
      const artifact = ownDataRecord(
        value,
        path,
        ["slot", "data", "mediaType", "fileName"],
      );
      const slot = artifactSlot(artifact.slot, `${path}.slot`, false);
      if (seenSlots.has(slot)) throw new TypeError("artifacts contains a duplicate slot");
      seenSlots.add(slot);
      if (!(artifact.data instanceof Uint8Array)) {
        throw new TypeError(`${path}.data must be bytes`);
      }
      const data = new Uint8Array(artifact.data);
      const descriptor = Object.freeze({
        slot,
        ...describeExecutionArtifact(
          data,
          artifact.mediaType as string,
          artifact.fileName as string | undefined,
        ),
      });
      return Object.freeze({ data, descriptor });
    });
    const ensured = await this.#ensureArtifactIntent(
      runId,
      requestId,
      plans.map((plan) => plan.descriptor),
      input.signal,
    );
    const staged: StagedRunArtifact[] = [];
    const possiblyPublished: ArtifactPublicationDescriptor[] = [];
    try {
      for (const plan of plans) {
        if (ensured.activatedSlots.has(plan.descriptor.slot)) {
          // Include the descriptor before awaiting publication: a backend can
          // commit its index and then reject, making the result ambiguous.
          possiblyPublished.push(plan.descriptor);
        }
        const ref = await this.#store.putArtifact(
          plan.data,
          plan.descriptor.mediaType,
          plan.descriptor.fileName,
          input.signal,
        );
        staged.push(Object.freeze({ slot: plan.descriptor.slot, ref }));
      }
    } catch (error) {
      await this.#bestEffortAbandonArtifactPublication(
        ensured,
        possiblyPublished,
      );
      throw error;
    }
    return Object.freeze(staged);
  }

  async settle(input: SettleRunInput): Promise<AgentRunSummary> {
    const runId = boundedIdentifier(input.runId, "runId");
    const requestId = boundedIdentifier(input.requestId, "requestId");
    const status = terminalRunStatus(input.status, "status");
    const failureCode = input.failureCode === undefined
      ? undefined
      : boundedCode(input.failureCode, "failureCode");
    if ((status === "failed" || status === "uncertain") !== (failureCode !== undefined)) {
      throw new TypeError("failed and uncertain runs require exactly one bounded failureCode");
    }
    const userVisibleSettlement =
      status === "completed" || status === "cancelled" || status === "max-turns";
    if (userVisibleSettlement !== (input.transcript !== undefined)) {
      throw new TypeError("user-visible settlement requires exactly one canonical transcript");
    }
    if (userVisibleSettlement !== (input.responseBytes !== undefined)) {
      throw new TypeError("user-visible settlement requires exactly one cacheable response");
    }
    if (!userVisibleSettlement && input.session !== undefined) {
      throw new TypeError("failed and uncertain runs cannot commit provider sessions");
    }
    if (!userVisibleSettlement && input.sessionEviction !== undefined) {
      throw new TypeError("failed and uncertain runs cannot evict provider sessions");
    }
    if (input.session !== undefined && input.sessionEviction !== undefined) {
      throw new TypeError("run settlement cannot store and evict the same provider session");
    }

    const storedRun = await this.#store.read(runStateKey(runId), parseStoredRunRecord, input.signal);
    if (storedRun === undefined) throw new Error(`run ${runId} does not exist`);
    if (storedRun.value.summary.requestId !== requestId) {
      throw new Error("run request identity does not match");
    }
    if (storedRun.value.summary.status !== "running") {
      if (
        storedRun.value.summary.status === status
        && storedRun.value.summary.failureCode === failureCode
      ) {
        return storedRun.value.summary;
      }
      throw new Error("terminal run settlement cannot be rewritten");
    }
    const admission = await this.#store.read(
      admissionStateKey(requestId),
      parseAdmissionRecord,
      input.signal,
    );
    if (
      admission === undefined
      || admission.value.runId !== runId
      || admission.value.conversationId !== storedRun.value.summary.conversationId
    ) {
      throw new Error("run admission identity is missing or mismatched");
    }
    if (admission.value.status !== "running") {
      throw new Error("run admission is no longer settleable");
    }

    let transcript: CanonicalTranscript | undefined;
    let transcriptBytes: Uint8Array | undefined;
    let conversation: ExecutionRecord<ConversationRecord> | undefined;
    if (input.transcript !== undefined) {
      transcript = parseCanonicalTranscript(input.transcript);
      if (transcript.conversationId !== storedRun.value.summary.conversationId) {
        throw new TypeError("settled transcript conversation identity does not match the run");
      }
      conversation = await this.#store.read(
        conversationStateKey(transcript.conversationId),
        parseConversationRecord,
        input.signal,
      );
      const expectedRevision = (conversation?.value.revision ?? 0) + 1;
      if (transcript.revision !== expectedRevision) {
        throw new Error("settled transcript revision is not the next canonical revision");
      }
      if (conversation !== undefined) {
        const previousBytes = await this.#store.readArtifact(
          conversation.value.transcriptRef,
          input.signal,
        );
        const previous = decodeCanonicalTranscript(
          previousBytes,
          transcript.conversationId,
        );
        if (
          previous.revision !== conversation.value.revision
          || previous.entries.length !== conversation.value.entryCount
        ) {
          throw new Error("canonical transcript pointer does not match its artifact");
        }
        assertCanonicalTranscriptAppendOnly(previous, transcript);
      }
      transcriptBytes = encodeCanonicalTranscript(transcript);
    }
    let providerSession: ExecutionRecord<ProviderSessionRecord> | undefined;
    let providerSessionValue: ProviderSessionRecord | undefined;
    let providerSessionKey: string | undefined;
    if (input.session !== undefined) {
      const session = parseRuntimeSession(input.session.value, "session.value");
      if (session.conversationId !== storedRun.value.summary.conversationId) {
        throw new TypeError("provider session conversation identity does not match the run");
      }
      const updatedAt = canonicalTimestamp(input.session.updatedAt, "session.updatedAt");
      providerSessionKey = sessionStateKey(
        session.conversationId,
        session.route.runtimeInstanceId,
        session.route.model,
      );
      providerSession = await this.#store.read(
        providerSessionKey,
        parseProviderSessionRecord,
        input.signal,
      );
      if (
        providerSession !== undefined
        && (
          providerSession.value.conversationId !== session.conversationId
          || !sameRoute(providerSession.value.route, session.route)
        )
      ) {
        throw new Error("provider session key points to mismatched authority");
      }
      providerSessionValue = Object.freeze({
        schemaVersion: 1,
        kind: "mono-agent.provider-session",
        conversationId: session.conversationId,
        route: session.route,
        session,
        updatedAt,
      });
    } else if (input.sessionEviction !== undefined) {
      const route = parseRouteIdentity(input.sessionEviction);
      providerSessionKey = sessionStateKey(
        storedRun.value.summary.conversationId,
        route.runtimeInstanceId,
        route.model,
      );
      providerSession = await this.#store.read(
        providerSessionKey,
        parseProviderSessionRecord,
        input.signal,
      );
      if (
        providerSession !== undefined
        && (
          providerSession.value.conversationId
            !== storedRun.value.summary.conversationId
          || !sameRoute(providerSession.value.route, route)
        )
      ) {
        throw new Error("provider session eviction key points to mismatched authority");
      }
    }
    if (
      input.responseBytes !== undefined
      && !(input.responseBytes instanceof Uint8Array)
    ) {
      throw new TypeError("responseBytes must be bytes");
    }
    const responseBytes = input.responseBytes === undefined
      ? undefined
      : new Uint8Array(input.responseBytes);
    const publicationDescriptors: ArtifactPublicationDescriptor[] = [];
    if (transcriptBytes !== undefined) {
      publicationDescriptors.push(Object.freeze({
        slot: TRANSCRIPT_ARTIFACT_SLOT,
        ...describeExecutionArtifact(
          transcriptBytes,
          "application/vnd.mono-agent.transcript+json",
        ),
      }));
    }
    if (responseBytes !== undefined) {
      publicationDescriptors.push(Object.freeze({
        slot: RESPONSE_ARTIFACT_SLOT,
        ...describeExecutionArtifact(
          responseBytes,
          "application/vnd.mono-agent.response+json",
        ),
      }));
    }
    const ensuredArtifactIntent = publicationDescriptors.length === 0
      ? undefined
      : await this.#ensureArtifactIntent(
        runId,
        requestId,
        publicationDescriptors,
        input.signal,
      );
    let artifactIntent = ensuredArtifactIntent?.record;
    if (artifactIntent === undefined) {
      artifactIntent = await this.#store.read(
        artifactIntentStateKey(runId),
        parseArtifactPublicationIntentRecord,
        input.signal,
      );
      if (
        artifactIntent !== undefined
        && (
          artifactIntent.value.runId !== runId
          || artifactIntent.value.requestId !== requestId
        )
      ) {
        throw new Error("artifact publication intent authority is mismatched");
      }
    }
    if (artifactIntent !== undefined && transcript !== undefined) {
      const stagedContent = publishedContentReferences(
        artifactIntent.value,
        transcript,
      );
      for (const ref of stagedContent) {
        await this.#store.readArtifact(ref, input.signal);
      }
    }
    let transcriptRef: ArtifactRef | undefined;
    let responseRef: ArtifactRef | undefined;
    const possiblyPublished: ArtifactPublicationDescriptor[] = [];
    try {
      if (transcriptBytes !== undefined) {
        const descriptor = publicationDescriptors.find(
          (candidate) => candidate.slot === TRANSCRIPT_ARTIFACT_SLOT,
        )!;
        if (ensuredArtifactIntent?.activatedSlots.has(descriptor.slot) === true) {
          possiblyPublished.push(descriptor);
        }
        transcriptRef = await this.#store.putArtifact(
          transcriptBytes,
          "application/vnd.mono-agent.transcript+json",
          undefined,
          input.signal,
        );
      }
      if (responseBytes !== undefined) {
        const descriptor = publicationDescriptors.find(
          (candidate) => candidate.slot === RESPONSE_ARTIFACT_SLOT,
        )!;
        if (ensuredArtifactIntent?.activatedSlots.has(descriptor.slot) === true) {
          possiblyPublished.push(descriptor);
        }
        responseRef = await this.#store.putArtifact(
          responseBytes,
          "application/vnd.mono-agent.response+json",
          undefined,
          input.signal,
        );
      }
    } catch (error) {
      if (ensuredArtifactIntent !== undefined) {
        await this.#bestEffortAbandonArtifactPublication(
          ensuredArtifactIntent,
          possiblyPublished,
        );
      }
      throw error;
    }
    const transcriptRevision = transcript === undefined || transcriptRef === undefined
      ? undefined
      : `r${String(transcript.revision)}:${transcriptRef.sha256}`;
    const now = canonicalNow(this.#clock);
    const cleanupArtifacts = artifactIntent === undefined
      ? Object.freeze([]) as readonly ArtifactPublicationDescriptor[]
      : Object.freeze(
          userVisibleSettlement
            ? [...artifactIntent.value.cleanupArtifacts]
            : mergeArtifactPublicationDescriptors(
                artifactIntent.value.cleanupArtifacts,
                artifactIntent.value.artifacts,
              ),
        );
    const retainedArtifactIntent: ArtifactPublicationIntentRecord | undefined =
      artifactIntent === undefined || cleanupArtifacts.length === 0
        ? undefined
        : Object.freeze({
            ...artifactIntent.value,
            artifacts: Object.freeze([]),
            cleanupArtifacts,
            updatedAt: now,
          });
    const conversationValue: ConversationRecord | undefined =
      transcript === undefined || transcriptRef === undefined
        ? undefined
        : Object.freeze({
            schemaVersion: 1,
            kind: "mono-agent.conversation",
            conversationId: transcript.conversationId,
            revision: transcript.revision,
            transcriptRef,
            entryCount: transcript.entries.length,
            updatedAt: now,
          });
    const summary = freezeSummary({
      ...storedRun.value.summary,
      status,
      updatedAt: now,
      endedAt: now,
      ...(transcriptRevision === undefined ? {} : { transcriptRevision }),
      ...(failureCode === undefined ? {} : { failureCode }),
    });
    const event = Object.freeze({
      type: "settled",
      runId,
      sequence: storedRun.value.eventCount,
      recordedAt: now,
      status,
      ...(transcriptRevision === undefined ? {} : { transcriptRevision }),
      ...(failureCode === undefined ? {} : { failureCode }),
    } as const satisfies AgentRunEvent);
    const updatedRun: StoredRunRecord = Object.freeze({
      ...storedRun.value,
      summary,
      eventCount: nextEventCount(storedRun.value.eventCount),
      ...(transcriptRef === undefined ? {} : { transcriptRef }),
    });
    const updatedAdmission: AdmissionRecord = Object.freeze({
      ...admission.value,
      status: status === "uncertain" ? "uncertain" : "settled",
      updatedAt: now,
      leaseExpiresAt: now,
      settledStatus: status,
      ...(responseRef === undefined ? {} : { responseRef }),
    });
    const puts = [
      {
        key: storedRun.key,
        expectedVersion: storedRun.version,
        value: updatedRun,
      },
      {
        key: admission.key,
        expectedVersion: admission.version,
        value: updatedAdmission,
      },
      {
        key: runEventStateKey(runId, event.sequence),
        expectedVersion: null,
        value: eventRecord(event),
      },
      ...(conversationValue === undefined
        ? []
        : [{
            key: conversationStateKey(conversationValue.conversationId),
            expectedVersion: conversation?.version ?? null,
            value: conversationValue,
          }]),
      ...(providerSessionValue === undefined
        ? []
        : [{
            key: providerSessionKey!,
            expectedVersion: providerSession?.version ?? null,
            value: providerSessionValue,
          }]),
      ...(artifactIntent === undefined || retainedArtifactIntent === undefined
        ? []
        : [{
            key: artifactIntent.key,
            expectedVersion: artifactIntent.version,
            value: retainedArtifactIntent,
          }]),
    ];
    const result = await this.#store.transaction({
      puts,
      deletes: [
        ...(artifactIntent === undefined || retainedArtifactIntent !== undefined
          ? []
          : [{
              key: artifactIntent.key,
              expectedVersion: artifactIntent.version,
            }]),
        ...(input.sessionEviction === undefined || providerSessionKey === undefined
          ? []
          : [{
              key: providerSessionKey,
              expectedVersion: providerSession?.version ?? null,
            }]),
      ],
      signal: input.signal,
    });
    if (result.status === "conflict") {
      throw new Error("run settlement lost an atomic state race");
    }
    if (retainedArtifactIntent !== undefined) {
      await this.#bestEffortReconcileArtifactIntent(runId);
    }
    return summary;
  }

  async readCachedResponse(
    ref: ArtifactRef,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    return this.#store.readArtifact(parseArtifactRef(ref), signal);
  }

  async loadTranscript(
    conversationId: string,
    signal: AbortSignal,
  ): Promise<CanonicalTranscript | undefined> {
    const normalizedId = boundedIdentifier(conversationId, "conversationId");
    const record = await this.#store.read(
      conversationStateKey(normalizedId),
      parseConversationRecord,
      signal,
    );
    if (record === undefined) return undefined;
    const encoded = await this.#store.readArtifact(record.value.transcriptRef, signal);
    const transcript = decodeCanonicalTranscript(encoded, normalizedId);
    if (
      transcript.revision !== record.value.revision
      || transcript.entries.length !== record.value.entryCount
    ) {
      throw new Error("canonical transcript pointer does not match its artifact");
    }
    return transcript;
  }

  async loadSession(
    conversationId: string,
    route: RouteIdentity,
    signal: AbortSignal,
  ): Promise<{ readonly value: RuntimeSession; readonly updatedAt: string } | undefined> {
    const normalizedConversationId = boundedIdentifier(conversationId, "conversationId");
    const normalizedRoute = parseRouteIdentity(route);
    const record = await this.#store.read(
      sessionStateKey(
        normalizedConversationId,
        normalizedRoute.runtimeInstanceId,
        normalizedRoute.model,
      ),
      parseProviderSessionRecord,
      signal,
    );
    if (record === undefined) return undefined;
    if (
      record.value.conversationId !== normalizedConversationId
      || !sameRoute(record.value.route, normalizedRoute)
      || record.value.session.conversationId !== normalizedConversationId
      || !sameRoute(record.value.session.route, normalizedRoute)
    ) {
      throw new Error("provider session key does not match its stored authority");
    }
    return Object.freeze({
      value: record.value.session,
      updatedAt: record.value.updatedAt,
    });
  }

  /**
   * Delete only the exact provider session previously observed by a caller.
   * A missing session or concurrently replaced session is a harmless miss.
   */
  async evictSession(
    conversationId: string,
    route: RouteIdentity,
    expected: {
      readonly sessionId: string;
      readonly updatedAt: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> {
    const normalizedConversationId = boundedIdentifier(conversationId, "conversationId");
    const normalizedRoute = parseRouteIdentity(route);
    const expectedInput = ownDataRecord(
      expected,
      "expected session authority",
      ["sessionId", "updatedAt"],
    );
    const sessionId = boundedIdentifier(
      expectedInput.sessionId,
      "expected session authority.sessionId",
    );
    const updatedAt = canonicalTimestamp(
      expectedInput.updatedAt,
      "expected session authority.updatedAt",
    );
    const key = sessionStateKey(
      normalizedConversationId,
      normalizedRoute.runtimeInstanceId,
      normalizedRoute.model,
    );
    const record = await this.#store.read(
      key,
      parseProviderSessionRecord,
      signal,
    );
    if (record === undefined) return false;
    if (
      record.value.conversationId !== normalizedConversationId
      || !sameRoute(record.value.route, normalizedRoute)
      || record.value.session.conversationId !== normalizedConversationId
      || !sameRoute(record.value.session.route, normalizedRoute)
    ) {
      throw new Error("provider session key does not match its stored authority");
    }
    if (
      record.value.session.id !== sessionId
      || record.value.updatedAt !== updatedAt
    ) {
      return false;
    }
    const result = await this.#store.transaction({
      deletes: [{
        key,
        expectedVersion: record.version,
      }],
      signal,
    });
    return result.status === "applied";
  }

  async readRun(runId: string, signal: AbortSignal): Promise<AgentRunRecord | undefined> {
    const normalizedRunId = boundedIdentifier(runId, "runId");
    const stored = await this.#store.read(
      runStateKey(normalizedRunId),
      parseStoredRunRecord,
      signal,
    );
    if (stored === undefined) return undefined;
    const events = await this.#readEvents(stored.value, signal);
    let transcript: CanonicalTranscript | undefined;
    if (stored.value.transcriptRef !== undefined) {
      const encoded = await this.#store.readArtifact(stored.value.transcriptRef, signal);
      transcript = decodeCanonicalTranscript(
        encoded,
        stored.value.summary.conversationId,
      );
      const expected = `r${String(transcript.revision)}:${stored.value.transcriptRef.sha256}`;
      if (stored.value.summary.transcriptRevision !== expected) {
        throw new Error("run transcript revision does not match its artifact");
      }
    }
    return Object.freeze({
      summary: stored.value.summary,
      events,
      transcript: Object.freeze(
        transcript?.entries.filter((entry) => entry.runId === normalizedRunId) ?? [],
      ),
    });
  }

  async listRuns(cursor: string | undefined, signal: AbortSignal): Promise<AgentRunHistoryPage> {
    const page = await this.#store.scan(
      EXECUTION_STATE_PREFIXES.runHistory,
      cursor,
      RUN_HISTORY_PAGE_SIZE,
      parseRunHistoryRecord,
      signal,
    );
    const runs: AgentRunSummary[] = [];
    for (const history of page.records) {
      const stored = await this.#store.read(
        runStateKey(history.value.runId),
        parseStoredRunRecord,
        signal,
      );
      if (
        stored === undefined
        || stored.value.summary.startedAt !== history.value.startedAt
      ) {
        throw new Error("run history index points to missing or mismatched run state");
      }
      runs.push(stored.value.summary);
    }
    return Object.freeze({
      runs: Object.freeze(runs),
      ...(page.cursor === undefined ? {} : { nextCursor: page.cursor }),
    });
  }

  async prepareDelivery(input: DeliveryIntentInput): Promise<DeliveryIntentResult> {
    const idempotencyKey = boundedIdentifier(input.idempotencyKey, "idempotencyKey");
    const fingerprint = parseFingerprint(input.fingerprint, "fingerprint");
    const channelInstanceId = boundedIdentifier(input.channelInstanceId, "channelInstanceId");
    const runId = input.runId === undefined ? undefined : boundedIdentifier(input.runId, "runId");
    const key = deliveryStateKey(idempotencyKey);

    for (let retry = 0; retry < 3; retry += 1) {
      const existing = await this.#store.read(key, parseDeliveryRecord, input.signal);
      if (existing === undefined) {
        const now = canonicalNow(this.#clock);
        const attemptToken = boundedIdentifier(
          this.#createDeliveryToken(),
          "delivery attempt token",
        );
        const record: DeliveryRecord = Object.freeze({
          schemaVersion: 1,
          kind: "mono-agent.delivery",
          idempotencyKey,
          fingerprint,
          channelInstanceId,
          ...(runId === undefined ? {} : { runId }),
          status: "intent",
          attempts: 1,
          attemptToken,
          createdAt: now,
          updatedAt: now,
          leaseExpiresAt: addMilliseconds(now, this.#staleAfterMs),
        });
        const created = await this.#store.transaction({
          puts: [{ key, expectedVersion: null, value: record }],
          signal: input.signal,
        });
        if (created.status === "applied") {
          return { status: "send", attempt: 1, token: attemptToken };
        }
        continue;
      }
      if (
        existing.value.fingerprint !== fingerprint
        || existing.value.channelInstanceId !== channelInstanceId
        || existing.value.runId !== runId
      ) {
        return { status: "conflict" };
      }
      if (existing.value.status === "delivered") {
        return {
          status: "duplicate",
          ...(existing.value.messageId === undefined
            ? {}
            : { messageId: existing.value.messageId }),
        };
      }
      if (existing.value.status === "unknown") {
        return {
          status: "unknown",
          ...(existing.value.code === undefined ? {} : { code: existing.value.code }),
        };
      }
      if (existing.value.status === "intent") {
        if (!isExpired(existing.value.leaseExpiresAt, this.#clock)) return { status: "join" };
        const now = canonicalNow(this.#clock);
        const unknown: DeliveryRecord = Object.freeze({
          schemaVersion: 1,
          kind: "mono-agent.delivery",
          idempotencyKey: existing.value.idempotencyKey,
          fingerprint: existing.value.fingerprint,
          channelInstanceId: existing.value.channelInstanceId,
          ...(existing.value.runId === undefined ? {} : { runId: existing.value.runId }),
          status: "unknown",
          attempts: existing.value.attempts,
          attemptToken: existing.value.attemptToken,
          createdAt: existing.value.createdAt,
          updatedAt: now,
          code: "stale-delivery-intent",
        });
        const settled = await this.#store.transaction({
          puts: [{ key, expectedVersion: existing.version, value: unknown }],
          signal: input.signal,
        });
        if (settled.status === "applied") {
          return { status: "unknown", code: "stale-delivery-intent" };
        }
        continue;
      }
      const now = canonicalNow(this.#clock);
      const attemptToken = boundedIdentifier(
        this.#createDeliveryToken(),
        "delivery attempt token",
      );
      const retryRecord: DeliveryRecord = Object.freeze({
        schemaVersion: 1,
        kind: "mono-agent.delivery",
        idempotencyKey: existing.value.idempotencyKey,
        fingerprint: existing.value.fingerprint,
        channelInstanceId: existing.value.channelInstanceId,
        ...(existing.value.runId === undefined ? {} : { runId: existing.value.runId }),
        status: "intent",
        attempts: existing.value.attempts + 1,
        attemptToken,
        createdAt: existing.value.createdAt,
        updatedAt: now,
        leaseExpiresAt: addMilliseconds(now, this.#staleAfterMs),
      });
      const retried = await this.#store.transaction({
        puts: [{ key, expectedVersion: existing.version, value: retryRecord }],
        signal: input.signal,
      });
      if (retried.status === "applied") {
        return {
          status: "send",
          attempt: retryRecord.attempts,
          token: attemptToken,
        };
      }
    }
    throw new Error("delivery intent did not converge after contention");
  }

  async settleDelivery(input: DeliverySettlementInput): Promise<DeliveryIntentResult> {
    const idempotencyKey = boundedIdentifier(input.idempotencyKey, "idempotencyKey");
    const fingerprint = parseFingerprint(input.fingerprint, "fingerprint");
    const attempt = boundedInteger(input.attempt, "attempt", 1, 10_000);
    const token = boundedIdentifier(input.token, "delivery attempt token");
    const key = deliveryStateKey(idempotencyKey);
    const existing = await this.#store.read(key, parseDeliveryRecord, input.signal);
    if (existing === undefined) throw new Error("delivery intent does not exist");
    if (existing.value.fingerprint !== fingerprint) return { status: "conflict" };
    if (
      existing.value.attempts !== attempt
      || existing.value.attemptToken !== token
    ) {
      return { status: "conflict" };
    }
    if (existing.value.status === "delivered") {
      return {
        status: "duplicate",
        ...(existing.value.messageId === undefined ? {} : { messageId: existing.value.messageId }),
      };
    }
    if (existing.value.status === "unknown") {
      return {
        status: "unknown",
        ...(existing.value.code === undefined ? {} : { code: existing.value.code }),
      };
    }
    if (existing.value.status !== "intent") {
      if (input.status === "failed") return { status: "join" };
      throw new Error("only an active delivery intent can settle");
    }
    const messageId = input.messageId === undefined
      ? undefined
      : boundedIdentifier(input.messageId, "messageId");
    const code = input.code === undefined ? undefined : boundedCode(input.code, "code");
    if (input.status === "delivered" && code !== undefined) {
      throw new TypeError("delivered receipts cannot carry a failure code");
    }
    if (input.status !== "delivered" && code === undefined) {
      throw new TypeError("failed and unknown delivery receipts require a bounded code");
    }
    if (input.status !== "delivered" && messageId !== undefined) {
      throw new TypeError("non-delivered receipts cannot claim a message id");
    }
    const updated: DeliveryRecord = Object.freeze({
      schemaVersion: 1,
      kind: "mono-agent.delivery",
      idempotencyKey: existing.value.idempotencyKey,
      fingerprint: existing.value.fingerprint,
      channelInstanceId: existing.value.channelInstanceId,
      ...(existing.value.runId === undefined ? {} : { runId: existing.value.runId }),
      status: input.status,
      attempts: existing.value.attempts,
      attemptToken: existing.value.attemptToken,
      createdAt: existing.value.createdAt,
      updatedAt: canonicalNow(this.#clock),
      ...(messageId === undefined ? {} : { messageId }),
      ...(code === undefined ? {} : { code }),
    });
    const result = await this.#store.transaction({
      puts: [{ key, expectedVersion: existing.version, value: updated }],
      signal: input.signal,
    });
    if (result.status === "conflict") throw new Error("delivery settlement lost an atomic state race");
    if (updated.status === "delivered") {
      return {
        status: "duplicate",
        ...(updated.messageId === undefined ? {} : { messageId: updated.messageId }),
      };
    }
    if (updated.status === "unknown") {
      return {
        status: "unknown",
        ...(updated.code === undefined ? {} : { code: updated.code }),
      };
    }
    return { status: "join" };
  }

  /**
   * Reconcile a bounded page of durable artifact-publication intents.
   *
   * A descriptor is removed only after the selected state backend confirms
   * physical deletion. Backends that cannot prove reference-safe deletion
   * leave the descriptor cleanup-pending for a later retention/GC pass.
   */
  async reconcileArtifactPublications(
    input: ReconcileArtifactPublicationsInput,
  ): Promise<ArtifactPublicationReconciliation> {
    const limit = boundedInteger(
      input.limit ?? ARTIFACT_RECONCILIATION_DEFAULT_LIMIT,
      "artifact reconciliation limit",
      1,
      ARTIFACT_RECONCILIATION_MAX_LIMIT,
    );
    const page = await this.#store.scan(
      EXECUTION_STATE_PREFIXES.artifactIntents,
      input.cursor,
      limit,
      parseArtifactPublicationIntentRecord,
      input.signal,
    );
    let deletedArtifacts = 0;
    let pendingArtifacts = 0;
    let skippedActive = 0;
    for (const record of page.records) {
      const reconciled = await this.#reconcileArtifactIntent(record, input.signal);
      deletedArtifacts += reconciled.deletedArtifacts;
      pendingArtifacts += reconciled.pendingArtifacts;
      skippedActive += reconciled.skippedActive;
    }
    return Object.freeze({
      examined: page.records.length,
      deletedArtifacts,
      pendingArtifacts,
      skippedActive,
      ...(page.cursor === undefined ? {} : { nextCursor: page.cursor }),
    });
  }

  async #bestEffortAbandonArtifactPublication(
    ensured: EnsuredArtifactIntent,
    possiblyPublished: readonly ArtifactPublicationDescriptor[],
  ): Promise<void> {
    try {
      const signal = AbortSignal.timeout(ARTIFACT_CLEANUP_TIMEOUT_MS);
      const pending = await this.#abandonArtifactPublication(
        ensured,
        possiblyPublished,
        signal,
      );
      if (pending !== undefined) {
        await this.#reconcileArtifactIntent(pending, signal);
      }
    } catch {
      // The durable intent remains authoritative. Publication failures must
      // retain their original error while bounded reconciliation can retry.
    }
  }

  async #abandonArtifactPublication(
    ensured: EnsuredArtifactIntent,
    possiblyPublished: readonly ArtifactPublicationDescriptor[],
    signal: AbortSignal,
  ): Promise<ExecutionRecord<ArtifactPublicationIntentRecord> | undefined> {
    const key = ensured.record.key;
    const activatedSlots = ensured.activatedSlots;
    const possiblyPublishedBySlot = new Map(
      possiblyPublished.map((artifact) => [artifact.slot, artifact]),
    );
    for (let retry = 0; retry < 3; retry += 1) {
      const current = await this.#store.read(
        key,
        parseArtifactPublicationIntentRecord,
        signal,
      );
      if (current === undefined) return undefined;
      if (
        current.value.runId !== ensured.record.value.runId
        || current.value.requestId !== ensured.record.value.requestId
      ) {
        throw new Error("artifact publication intent authority is mismatched");
      }
      const artifacts: ArtifactPublicationDescriptor[] = [];
      const cleanupArtifacts = [...current.value.cleanupArtifacts];
      for (const artifact of current.value.artifacts) {
        if (!activatedSlots.has(artifact.slot)) {
          artifacts.push(artifact);
          continue;
        }
        const ambiguous = possiblyPublishedBySlot.get(artifact.slot);
        if (ambiguous === undefined) continue;
        if (!sameArtifactPublicationDescriptor(artifact, ambiguous)) {
          throw new Error(`artifact publication slot ${artifact.slot} cannot be rewritten`);
        }
        cleanupArtifacts.push(artifact);
      }
      const value = artifacts.length + cleanupArtifacts.length === 0
        ? undefined
        : Object.freeze({
            ...current.value,
            artifacts: Object.freeze(artifacts),
            cleanupArtifacts: Object.freeze(cleanupArtifacts),
            updatedAt: canonicalNow(this.#clock),
          });
      const result = await this.#store.transaction({
        puts: value === undefined
          ? []
          : [{ key, expectedVersion: current.version, value }],
        deletes: value === undefined
          ? [{ key, expectedVersion: current.version }]
          : [],
        signal,
      });
      if (result.status === "conflict") continue;
      if (value === undefined) return undefined;
      const stored = await this.#store.read(
        key,
        parseArtifactPublicationIntentRecord,
        signal,
      );
      if (stored === undefined) {
        throw new Error("artifact cleanup intent disappeared after commit");
      }
      return stored;
    }
    throw new Error("artifact publication abandonment did not converge after contention");
  }

  async #bestEffortReconcileArtifactIntent(runId: string): Promise<void> {
    try {
      const signal = AbortSignal.timeout(ARTIFACT_CLEANUP_TIMEOUT_MS);
      const record = await this.#store.read(
        artifactIntentStateKey(runId),
        parseArtifactPublicationIntentRecord,
        signal,
      );
      if (record !== undefined) {
        await this.#reconcileArtifactIntent(record, signal);
      }
    } catch {
      // The retained intent is the recovery authority for the next bounded
      // reconciliation pass. Cleanup must not obscure the settled run result.
    }
  }

  async #reconcileArtifactIntent(
    initial: ExecutionRecord<ArtifactPublicationIntentRecord>,
    signal: AbortSignal,
  ): Promise<{
    readonly deletedArtifacts: number;
    readonly pendingArtifacts: number;
    readonly skippedActive: number;
  }> {
    const provenDeleted = new Map<string, ArtifactPublicationDescriptor>();
    let current: ExecutionRecord<ArtifactPublicationIntentRecord> | undefined = initial;
    for (let retry = 0; retry < 5; retry += 1) {
      if (retry > 0) {
        current = await this.#store.read(
          initial.key,
          parseArtifactPublicationIntentRecord,
          signal,
        );
      }
      if (current === undefined) {
        return {
          deletedArtifacts: provenDeleted.size,
          pendingArtifacts: 0,
          skippedActive: 0,
        };
      }
      const run = await this.#store.read(
        runStateKey(current.value.runId),
        parseStoredRunRecord,
        signal,
      );
      if (
        run !== undefined
        && run.value.summary.requestId !== current.value.requestId
      ) {
        throw new Error("artifact cleanup intent run authority is mismatched");
      }
      const terminalOrMissing = run === undefined || run.value.summary.status !== "running";
      if (terminalOrMissing && current.value.artifacts.length > 0) {
        const cleanupValue: ArtifactPublicationIntentRecord = Object.freeze({
          ...current.value,
          artifacts: Object.freeze([]),
          cleanupArtifacts: Object.freeze(mergeArtifactPublicationDescriptors(
            current.value.cleanupArtifacts,
            current.value.artifacts,
          )),
          updatedAt: canonicalNow(this.#clock),
        });
        const moved = await this.#store.transaction({
          puts: [{
            key: current.key,
            expectedVersion: current.version,
            value: cleanupValue,
          }],
          signal,
        });
        if (moved.status === "conflict") continue;
        current = await this.#store.read(
          current.key,
          parseArtifactPublicationIntentRecord,
          signal,
        );
        if (current === undefined) {
          throw new Error("artifact cleanup intent disappeared after commit");
        }
      }
      const candidates = current.value.cleanupArtifacts;
      if (candidates.length === 0) {
        return {
          deletedArtifacts: provenDeleted.size,
          pendingArtifacts: 0,
          skippedActive: current.value.artifacts.length > 0 ? 1 : 0,
        };
      }
      for (const artifact of candidates) {
        const deleted = provenDeleted.get(artifact.slot);
        if (deleted !== undefined) {
          if (!sameArtifactPublicationDescriptor(deleted, artifact)) {
            throw new Error(`artifact publication slot ${artifact.slot} cannot be rewritten`);
          }
          continue;
        }
        try {
          if (await this.#store.deleteArtifact(
            artifactReference(artifact),
            signal,
          )) {
            provenDeleted.set(artifact.slot, artifact);
          }
        } catch {
          // A failed or unsupported deletion remains explicitly pending.
        }
      }
      if (provenDeleted.size === 0) {
        return {
          deletedArtifacts: 0,
          pendingArtifacts: candidates.length,
          skippedActive: current.value.artifacts.length > 0 ? 1 : 0,
        };
      }
      const cleanupArtifacts = candidates.filter(
        (artifact) => {
          const deleted = provenDeleted.get(artifact.slot);
          if (deleted === undefined) return true;
          if (!sameArtifactPublicationDescriptor(deleted, artifact)) {
            throw new Error(`artifact publication slot ${artifact.slot} cannot be rewritten`);
          }
          return false;
        },
      );
      const removeIntent =
        current.value.artifacts.length === 0 && cleanupArtifacts.length === 0;
      const result = await this.#store.transaction({
        puts: removeIntent
          ? []
          : [{
              key: current.key,
              expectedVersion: current.version,
              value: Object.freeze({
                ...current.value,
                cleanupArtifacts: Object.freeze(cleanupArtifacts),
                updatedAt: canonicalNow(this.#clock),
              }),
            }],
        deletes: removeIntent
          ? [{ key: current.key, expectedVersion: current.version }]
          : [],
        signal,
      });
      if (result.status === "conflict") continue;
      return {
        deletedArtifacts: provenDeleted.size,
        pendingArtifacts: cleanupArtifacts.length,
        skippedActive: current.value.artifacts.length > 0 ? 1 : 0,
      };
    }
    throw new Error("artifact publication reconciliation did not converge after contention");
  }

  async #ensureArtifactIntent(
    runId: string,
    requestId: string,
    descriptors: readonly ArtifactPublicationDescriptor[],
    signal: AbortSignal,
  ): Promise<EnsuredArtifactIntent> {
    if (descriptors.length < 1 || descriptors.length > RUN_ARTIFACT_MAX_ITEMS) {
      throw new RangeError("artifact publication intent exceeds its item limit");
    }
    const additions = descriptors.map((descriptor, index) =>
      parseArtifactPublicationDescriptor(
        descriptor,
        `artifact publication descriptor.${String(index)}`,
      ));
    assertArtifactPublicationBounds(additions);
    const additionSlots = new Set<string>();
    for (const descriptor of additions) {
      if (additionSlots.has(descriptor.slot)) {
        throw new TypeError("artifact publication intent contains a duplicate slot");
      }
      additionSlots.add(descriptor.slot);
    }
    const key = artifactIntentStateKey(runId);
    for (let retry = 0; retry < 3; retry += 1) {
      const storedRun = await this.#requireRunningRun(runId, signal);
      if (storedRun.value.summary.requestId !== requestId) {
        throw new Error("artifact publication run request identity does not match");
      }
      const admission = await this.#store.read(
        admissionStateKey(requestId),
        parseAdmissionRecord,
        signal,
      );
      if (
        admission === undefined
        || admission.value.runId !== runId
        || admission.value.conversationId !== storedRun.value.summary.conversationId
        || admission.value.status !== "running"
      ) {
        throw new Error("artifact publication admission authority is missing or mismatched");
      }
      const existing = await this.#store.read(
        key,
        parseArtifactPublicationIntentRecord,
        signal,
      );
      let value: ArtifactPublicationIntentRecord;
      let expectedVersion: string | null;
      const activatedSlots = new Set<string>();
      if (existing === undefined) {
        const now = canonicalNow(this.#clock);
        value = Object.freeze({
          schemaVersion: 1,
          kind: "mono-agent.artifact-publication-intent",
          runId,
          requestId,
          artifacts: Object.freeze([...additions]),
          cleanupArtifacts: Object.freeze([]),
          createdAt: now,
          updatedAt: now,
        });
        for (const addition of additions) activatedSlots.add(addition.slot);
        expectedVersion = null;
      } else {
        if (
          existing.value.runId !== runId
          || existing.value.requestId !== requestId
        ) {
          throw new Error("artifact publication intent authority is mismatched");
        }
        const artifacts = [...existing.value.artifacts];
        const bySlot = new Map(artifacts.map((artifact) => [artifact.slot, artifact]));
        const cleanupBySlot = new Map(
          existing.value.cleanupArtifacts.map((artifact) => [artifact.slot, artifact]),
        );
        for (const addition of additions) {
          const pendingCleanup = cleanupBySlot.get(addition.slot);
          if (pendingCleanup !== undefined) {
            if (!sameArtifactPublicationDescriptor(pendingCleanup, addition)) {
              throw new Error(`artifact publication slot ${addition.slot} cannot be rewritten`);
            }
            throw new Error(
              `artifact publication slot ${addition.slot} is awaiting proven cleanup`,
            );
          }
          const prior = bySlot.get(addition.slot);
          if (prior !== undefined) {
            if (!sameArtifactPublicationDescriptor(prior, addition)) {
              throw new Error(`artifact publication slot ${addition.slot} cannot be rewritten`);
            }
            continue;
          }
          artifacts.push(addition);
          bySlot.set(addition.slot, addition);
          activatedSlots.add(addition.slot);
        }
        if (
          artifacts.length + existing.value.cleanupArtifacts.length
          > RUN_ARTIFACT_MAX_ITEMS
        ) {
          throw new RangeError("artifact publication intent exceeds its item limit");
        }
        assertArtifactPublicationBounds([
          ...artifacts,
          ...existing.value.cleanupArtifacts,
        ]);
        if (artifacts.length === existing.value.artifacts.length) {
          return Object.freeze({
            record: existing,
            activatedSlots: Object.freeze(activatedSlots),
          });
        }
        value = Object.freeze({
          ...existing.value,
          artifacts: Object.freeze(artifacts),
          updatedAt: canonicalNow(this.#clock),
        });
        expectedVersion = existing.version;
      }
      const result = await this.#store.transaction({
        checks: [
          { key: storedRun.key, expectedVersion: storedRun.version },
          { key: admission.key, expectedVersion: admission.version },
        ],
        puts: [{ key, expectedVersion, value }],
        signal,
      });
      if (result.status === "conflict") continue;
      const stored = await this.#store.read(
        key,
        parseArtifactPublicationIntentRecord,
        signal,
      );
      if (stored === undefined) {
        throw new Error("artifact publication intent disappeared after commit");
      }
      return Object.freeze({
        record: stored,
        activatedSlots: Object.freeze(activatedSlots),
      });
    }
    throw new Error("artifact publication intent did not converge after contention");
  }

  async #existingAdmission(
    admission: ExecutionRecord<AdmissionRecord>,
    conversationId: string,
    fingerprint: DurableFingerprint,
    signal: AbortSignal,
    contention = 0,
  ): Promise<RunAdmissionResult> {
    if (
      admission.value.conversationId !== conversationId
      || admission.value.fingerprint !== fingerprint
    ) {
      return { status: "conflict", runId: admission.value.runId };
    }
    if (admission.value.status === "uncertain") {
      await this.#bestEffortReconcileArtifactIntent(admission.value.runId);
      return { status: "uncertain", runId: admission.value.runId };
    }
    if (admission.value.status === "settled") {
      const run = await this.#store.read(
        runStateKey(admission.value.runId),
        parseStoredRunRecord,
        signal,
      );
      if (
        run === undefined
        || run.value.summary.status === "running"
        || run.value.summary.requestId !== admission.value.requestId
        || run.value.summary.conversationId !== admission.value.conversationId
      ) {
        throw new Error("settled admission points to missing or running state");
      }
      await this.#bestEffortReconcileArtifactIntent(admission.value.runId);
      return {
        status: "cached",
        summary: run.value.summary,
        ...(admission.value.responseRef === undefined
          ? {}
          : { responseRef: admission.value.responseRef }),
      };
    }
    if (!isExpired(admission.value.leaseExpiresAt, this.#clock)) {
      return { status: "join", runId: admission.value.runId };
    }
    const run = await this.#store.read(
      runStateKey(admission.value.runId),
      parseStoredRunRecord,
      signal,
    );
    if (
      run === undefined
      || run.value.summary.status !== "running"
      || run.value.summary.requestId !== admission.value.requestId
      || run.value.summary.conversationId !== admission.value.conversationId
    ) {
      throw new Error("running admission points to missing or terminal state");
    }
    const now = canonicalNow(this.#clock);
    const summary = freezeSummary({
      ...run.value.summary,
      status: "uncertain",
      updatedAt: now,
      endedAt: now,
      failureCode: "stale-running-admission",
    });
    const event = Object.freeze({
      type: "settled",
      runId: admission.value.runId,
      sequence: run.value.eventCount,
      recordedAt: now,
      status: "uncertain",
      failureCode: "stale-running-admission",
    } as const satisfies AgentRunEvent);
    const updatedRun: StoredRunRecord = Object.freeze({
      ...run.value,
      summary,
      eventCount: nextEventCount(run.value.eventCount),
    });
    const updatedAdmission: AdmissionRecord = Object.freeze({
      ...admission.value,
      status: "uncertain",
      updatedAt: now,
      leaseExpiresAt: now,
      settledStatus: "uncertain",
    });
    const artifactIntent = await this.#store.read(
      artifactIntentStateKey(admission.value.runId),
      parseArtifactPublicationIntentRecord,
      signal,
    );
    if (
      artifactIntent !== undefined
      && (
        artifactIntent.value.runId !== admission.value.runId
        || artifactIntent.value.requestId !== admission.value.requestId
      )
    ) {
      throw new Error("artifact publication intent authority is mismatched");
    }
    const cleanupIntent = artifactIntent === undefined
      ? undefined
      : Object.freeze({
          ...artifactIntent.value,
          artifacts: Object.freeze([]),
          cleanupArtifacts: Object.freeze(mergeArtifactPublicationDescriptors(
            artifactIntent.value.cleanupArtifacts,
            artifactIntent.value.artifacts,
          )),
          updatedAt: now,
        });
    const result = await this.#store.transaction({
      puts: [
        { key: admission.key, expectedVersion: admission.version, value: updatedAdmission },
        { key: run.key, expectedVersion: run.version, value: updatedRun },
        {
          key: runEventStateKey(admission.value.runId, event.sequence),
          expectedVersion: null,
          value: eventRecord(event),
        },
        ...(artifactIntent === undefined || cleanupIntent === undefined
          ? []
          : [{
              key: artifactIntent.key,
              expectedVersion: artifactIntent.version,
              value: cleanupIntent,
            }]),
      ],
      signal,
    });
    if (result.status === "conflict") {
      if (contention >= 2) throw new Error("stale admission classification did not converge");
      const current = await this.#store.read(admission.key, parseAdmissionRecord, signal);
      if (current === undefined) throw new Error("admission disappeared during stale classification");
      return this.#existingAdmission(
        current,
        conversationId,
        fingerprint,
        signal,
        contention + 1,
      );
    }
    if (cleanupIntent !== undefined) {
      await this.#bestEffortReconcileArtifactIntent(admission.value.runId);
    }
    return { status: "uncertain", runId: admission.value.runId };
  }

  async #requireRunningRun(
    runId: string,
    signal: AbortSignal,
  ): Promise<ExecutionRecord<StoredRunRecord>> {
    const stored = await this.#store.read(runStateKey(runId), parseStoredRunRecord, signal);
    if (stored === undefined) throw new Error(`run ${runId} does not exist`);
    if (stored.value.summary.status !== "running") throw new Error(`run ${runId} is already terminal`);
    return stored;
  }

  async #readEvents(
    run: StoredRunRecord,
    signal: AbortSignal,
  ): Promise<readonly AgentRunEvent[]> {
    const events: AgentRunEvent[] = [];
    let cursor: string | undefined;
    do {
      const remaining = run.eventCount - events.length;
      if (remaining <= 0) break;
      const page = await this.#store.scan(
        runEventPrefix(run.summary.runId),
        cursor,
        Math.min(RUN_EVENT_PAGE_SIZE, remaining),
        parseStoredRunEvent,
        signal,
      );
      for (const stored of page.records) events.push(stored.value.event);
      cursor = page.cursor;
    } while (cursor !== undefined);
    if (events.length !== run.eventCount || cursor !== undefined) {
      throw new Error("run event journal is incomplete");
    }
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (
        event === undefined
        || event.runId !== run.summary.runId
        || event.sequence !== index
      ) {
        throw new Error("run event journal is non-canonical");
      }
      if (
        index > 0
        && Date.parse(event.recordedAt) < Date.parse(events[index - 1]!.recordedAt)
      ) {
        throw new Error("run event journal timestamps are non-monotonic");
      }
    }
    if (
      events[0]?.type !== "admitted"
      || events[0].recordedAt !== run.summary.startedAt
    ) {
      throw new Error("run event journal has an invalid admission event");
    }
    const last = events[events.length - 1];
    if (run.summary.status === "running") {
      if (last?.type === "settled") throw new Error("running run has terminal event evidence");
    } else if (
      last?.type !== "settled"
      || last.status !== run.summary.status
      || last.transcriptRevision !== run.summary.transcriptRevision
      || last.failureCode !== run.summary.failureCode
    ) {
      throw new Error("terminal run does not match its settlement event");
    }
    return Object.freeze(events);
  }
}

/**
 * Compute a deterministic request or delivery fingerprint without retaining
 * source bytes. Callers pass a bounded own-data graph; byte arrays contribute
 * only their length and SHA-256 digest.
 */
export function createDurableFingerprint(value: unknown): DurableFingerprint {
  const state = { items: 0, bytes: 0, active: new Set<object>() };
  const canonical = canonicalFingerprintValue(value, "$", state);
  const encoded = JSON.stringify(canonical);
  if (Buffer.byteLength(encoded, "utf8") > FINGERPRINT_MAX_BYTES) {
    throw new RangeError("fingerprint material exceeds its byte limit");
  }
  return `sha256:${createHash("sha256")
    .update("mono-agent:durable-fingerprint:v1\0", "utf8")
    .update(encoded, "utf8")
    .digest("hex")}`;
}

function parseAdmissionRecord(value: unknown): AdmissionRecord {
  const input = ownDataRecord(
    value,
    "admission record",
    [
      "schemaVersion",
      "kind",
      "requestId",
      "conversationId",
      "fingerprint",
      "runId",
      "status",
      "startedAt",
      "updatedAt",
      "leaseExpiresAt",
      "settledStatus",
      "responseRef",
    ],
  );
  if (input.schemaVersion !== 1 || input.kind !== "mono-agent.admission") {
    throw new TypeError("admission record has an unsupported schema");
  }
  const status = stringEnum(
    input.status,
    ["running", "settled", "uncertain"] as const,
    "admission record.status",
  );
  const settledStatus = input.settledStatus === undefined
    ? undefined
    : terminalRunStatus(input.settledStatus, "admission record.settledStatus");
  if ((status === "running") === (settledStatus !== undefined)) {
    throw new TypeError("admission record settlement fields are inconsistent");
  }
  const responseRef = input.responseRef === undefined
    ? undefined
    : parseArtifactRef(input.responseRef);
  if (status === "running" && responseRef !== undefined) {
    throw new TypeError("running admission cannot carry a response");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.admission",
    requestId: boundedIdentifier(input.requestId, "admission record.requestId"),
    conversationId: boundedIdentifier(
      input.conversationId,
      "admission record.conversationId",
    ),
    fingerprint: parseFingerprint(input.fingerprint, "admission record.fingerprint"),
    runId: boundedIdentifier(input.runId, "admission record.runId"),
    status,
    startedAt: canonicalTimestamp(input.startedAt, "admission record.startedAt"),
    updatedAt: canonicalTimestamp(input.updatedAt, "admission record.updatedAt"),
    leaseExpiresAt: canonicalTimestamp(
      input.leaseExpiresAt,
      "admission record.leaseExpiresAt",
    ),
    ...(settledStatus === undefined ? {} : { settledStatus }),
    ...(responseRef === undefined ? {} : { responseRef }),
  });
}

function parseStoredRunRecord(value: unknown): StoredRunRecord {
  const input = ownDataRecord(
    value,
    "run record",
    ["schemaVersion", "kind", "summary", "eventCount", "transcriptRef"],
  );
  if (input.schemaVersion !== 1 || input.kind !== "mono-agent.run") {
    throw new TypeError("run record has an unsupported schema");
  }
  const summary = parseRunSummary(input.summary);
  const eventCount = boundedInteger(input.eventCount, "run record.eventCount", 1, RUN_MAX_EVENTS);
  const transcriptRef = input.transcriptRef === undefined
    ? undefined
    : parseArtifactRef(input.transcriptRef);
  if ((summary.transcriptRevision !== undefined) !== (transcriptRef !== undefined)) {
    throw new TypeError("run transcript fields are inconsistent");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.run",
    summary,
    eventCount,
    ...(transcriptRef === undefined ? {} : { transcriptRef }),
  });
}

function parseStoredRunEvent(value: unknown): StoredRunEvent {
  const input = ownDataRecord(
    value,
    "run event record",
    ["schemaVersion", "kind", "event"],
  );
  if (input.schemaVersion !== 1 || input.kind !== "mono-agent.run-event") {
    throw new TypeError("run event record has an unsupported schema");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.run-event",
    event: parseRunEvent(input.event),
  });
}

function parseRunHistoryRecord(value: unknown): RunHistoryRecord {
  const input = ownDataRecord(
    value,
    "run history record",
    ["schemaVersion", "kind", "runId", "startedAt"],
  );
  if (input.schemaVersion !== 1 || input.kind !== "mono-agent.run-history") {
    throw new TypeError("run history record has an unsupported schema");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.run-history",
    runId: boundedIdentifier(input.runId, "run history record.runId"),
    startedAt: canonicalTimestamp(input.startedAt, "run history record.startedAt"),
  });
}

function parseConversationRecord(value: unknown): ConversationRecord {
  const input = ownDataRecord(
    value,
    "conversation record",
    [
      "schemaVersion",
      "kind",
      "conversationId",
      "revision",
      "transcriptRef",
      "entryCount",
      "updatedAt",
    ],
  );
  if (input.schemaVersion !== 1 || input.kind !== "mono-agent.conversation") {
    throw new TypeError("conversation record has an unsupported schema");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.conversation",
    conversationId: boundedIdentifier(
      input.conversationId,
      "conversation record.conversationId",
    ),
    revision: boundedInteger(
      input.revision,
      "conversation record.revision",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    transcriptRef: parseArtifactRef(input.transcriptRef),
    entryCount: boundedInteger(
      input.entryCount,
      "conversation record.entryCount",
      0,
      50_000,
    ),
    updatedAt: canonicalTimestamp(input.updatedAt, "conversation record.updatedAt"),
  });
}

function parseProviderSessionRecord(value: unknown): ProviderSessionRecord {
  const input = ownDataRecord(
    value,
    "provider session record",
    ["schemaVersion", "kind", "conversationId", "route", "session", "updatedAt"],
  );
  if (input.schemaVersion !== 1 || input.kind !== "mono-agent.provider-session") {
    throw new TypeError("provider session record has an unsupported schema");
  }
  const conversationId = boundedIdentifier(
    input.conversationId,
    "provider session record.conversationId",
  );
  const route = parseRouteIdentity(input.route);
  const session = parseRuntimeSession(input.session, "provider session record.session");
  if (
    session.conversationId !== conversationId
    || !sameRoute(session.route, route)
  ) {
    throw new TypeError("provider session record authority is inconsistent");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.provider-session",
    conversationId,
    route,
    session,
    updatedAt: canonicalTimestamp(
      input.updatedAt,
      "provider session record.updatedAt",
    ),
  });
}

function parseArtifactPublicationIntentRecord(
  value: unknown,
): ArtifactPublicationIntentRecord {
  const input = ownDataRecord(
    value,
    "artifact publication intent",
    [
      "schemaVersion",
      "kind",
      "runId",
      "requestId",
      "artifacts",
      "cleanupArtifacts",
      "createdAt",
      "updatedAt",
    ],
  );
  if (
    input.schemaVersion !== 1
    || input.kind !== "mono-agent.artifact-publication-intent"
  ) {
    throw new TypeError("artifact publication intent has an unsupported schema");
  }
  const rawArtifacts = denseOwnDataArray(
    input.artifacts,
    "artifact publication intent.artifacts",
    RUN_ARTIFACT_MAX_ITEMS,
  );
  const rawCleanupArtifacts = denseOwnDataArray(
    input.cleanupArtifacts,
    "artifact publication intent.cleanupArtifacts",
    RUN_ARTIFACT_MAX_ITEMS,
  );
  if (rawArtifacts.length + rawCleanupArtifacts.length === 0) {
    throw new TypeError("artifact publication intent must name at least one artifact");
  }
  if (rawArtifacts.length + rawCleanupArtifacts.length > RUN_ARTIFACT_MAX_ITEMS) {
    throw new RangeError("artifact publication intent exceeds its item limit");
  }
  const seenSlots = new Set<string>();
  const parseUnique = (
    artifact: unknown,
    path: string,
  ): ArtifactPublicationDescriptor => {
    const parsed = parseArtifactPublicationDescriptor(
      artifact,
      path,
    );
    if (seenSlots.has(parsed.slot)) {
      throw new TypeError("artifact publication intent contains a duplicate slot");
    }
    seenSlots.add(parsed.slot);
    return parsed;
  };
  const artifacts = rawArtifacts.map((artifact, index) =>
    parseUnique(
      artifact,
      `artifact publication intent.artifacts.${String(index)}`,
    ));
  const cleanupArtifacts = rawCleanupArtifacts.map((artifact, index) =>
    parseUnique(
      artifact,
      `artifact publication intent.cleanupArtifacts.${String(index)}`,
    ));
  assertArtifactPublicationBounds([...artifacts, ...cleanupArtifacts]);
  const createdAt = canonicalTimestamp(
    input.createdAt,
    "artifact publication intent.createdAt",
  );
  const updatedAt = canonicalTimestamp(
    input.updatedAt,
    "artifact publication intent.updatedAt",
  );
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new TypeError("artifact publication intent timestamps are non-monotonic");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.artifact-publication-intent",
    runId: boundedIdentifier(input.runId, "artifact publication intent.runId"),
    requestId: boundedIdentifier(
      input.requestId,
      "artifact publication intent.requestId",
    ),
    artifacts: Object.freeze(artifacts),
    cleanupArtifacts: Object.freeze(cleanupArtifacts),
    createdAt,
    updatedAt,
  });
}

function parseArtifactPublicationDescriptor(
  value: unknown,
  path: string,
): ArtifactPublicationDescriptor {
  const input = ownDataRecord(
    value,
    path,
    ["slot", "sha256", "sizeBytes", "mediaType", "fileName"],
  );
  const ref = parseArtifactRef({
    id: `artifact:${String(input.sha256)}`,
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
    mediaType: input.mediaType,
    ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
  });
  return Object.freeze({
    slot: artifactSlot(input.slot, `${path}.slot`, true),
    sha256: ref.sha256,
    sizeBytes: ref.sizeBytes,
    mediaType: ref.mediaType,
    ...(ref.fileName === undefined ? {} : { fileName: ref.fileName }),
  });
}

function parseRuntimeSession(value: unknown, path: string): RuntimeSession {
  const input = ownDataRecord(
    value,
    path,
    ["id", "conversationId", "route", "createdAt", "expiresAt", "metadata"],
  );
  const createdAt = input.createdAt === undefined
    ? undefined
    : canonicalTimestamp(input.createdAt, `${path}.createdAt`);
  const expiresAt = input.expiresAt === undefined
    ? undefined
    : canonicalTimestamp(input.expiresAt, `${path}.expiresAt`);
  if (
    createdAt !== undefined
    && expiresAt !== undefined
    && Date.parse(expiresAt) <= Date.parse(createdAt)
  ) {
    throw new TypeError(`${path}.expiresAt must be later than createdAt`);
  }
  const metadata = input.metadata === undefined
    ? undefined
    : parseSessionMetadata(input.metadata, `${path}.metadata`);
  return Object.freeze({
    id: boundedIdentifier(input.id, `${path}.id`),
    conversationId: boundedIdentifier(input.conversationId, `${path}.conversationId`),
    route: parseRouteIdentity(input.route),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function parseSessionMetadata(value: unknown, path: string): JsonObject {
  const state = { items: 0, bytes: 0, active: new Set<object>() };
  const parsed = parseSessionJsonValue(value, path, state);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${path} must be a JSON object`);
  }
  const encoded = JSON.stringify(parsed);
  if (Buffer.byteLength(encoded, "utf8") > SESSION_METADATA_MAX_BYTES) {
    throw new RangeError(`${path} exceeds its byte limit`);
  }
  return parsed as JsonObject;
}

function parseSessionJsonValue(
  value: unknown,
  path: string,
  state: { items: number; bytes: number; readonly active: Set<object> },
): JsonValue {
  state.items += 1;
  if (state.items > SESSION_METADATA_MAX_ITEMS) {
    throw new RangeError(`${path} has too many JSON items`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain finite numbers`);
    return value;
  }
  if (typeof value === "string") {
    state.bytes += Buffer.byteLength(value, "utf8");
    if (state.bytes > SESSION_METADATA_MAX_BYTES) {
      throw new RangeError(`${path} exceeds its byte limit`);
    }
    return value;
  }
  if (typeof value !== "object" || value === null || value instanceof Uint8Array) {
    throw new TypeError(`${path} must contain only JSON values`);
  }
  if (state.active.has(value)) throw new TypeError(`${path} must not contain cycles`);
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      const raw = denseOwnDataArray(value, path, SESSION_METADATA_MAX_ITEMS);
      return Object.freeze(raw.map((entry, index) =>
        parseSessionJsonValue(entry, `${path}.${String(index)}`, state)));
    }
    const keys = ownStringKeys(value).sort();
    const input = ownDataRecord(value, path, keys);
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of keys) {
      output[key] = parseSessionJsonValue(input[key], `${path}.${key}`, state);
    }
    return Object.freeze(output);
  } finally {
    state.active.delete(value);
  }
}

function parseDeliveryRecord(value: unknown): DeliveryRecord {
  const input = ownDataRecord(
    value,
    "delivery record",
    [
      "schemaVersion",
      "kind",
      "idempotencyKey",
      "fingerprint",
      "channelInstanceId",
      "runId",
      "status",
      "attempts",
      "attemptToken",
      "createdAt",
      "updatedAt",
      "leaseExpiresAt",
      "messageId",
      "code",
    ],
  );
  if (input.schemaVersion !== 1 || input.kind !== "mono-agent.delivery") {
    throw new TypeError("delivery record has an unsupported schema");
  }
  const status = stringEnum(
    input.status,
    ["intent", "delivered", "failed", "unknown"] as const,
    "delivery record.status",
  );
  const leaseExpiresAt = input.leaseExpiresAt === undefined
    ? undefined
    : canonicalTimestamp(input.leaseExpiresAt, "delivery record.leaseExpiresAt");
  const messageId = input.messageId === undefined
    ? undefined
    : boundedIdentifier(input.messageId, "delivery record.messageId");
  const code = input.code === undefined
    ? undefined
    : boundedCode(input.code, "delivery record.code");
  if ((status === "intent") !== (leaseExpiresAt !== undefined)) {
    throw new TypeError("delivery intent lease fields are inconsistent");
  }
  if (status !== "delivered" && messageId !== undefined) {
    throw new TypeError("non-delivered state cannot carry a message receipt");
  }
  if ((status === "failed" || status === "unknown") !== (code !== undefined)) {
    throw new TypeError("delivery diagnostic fields are inconsistent");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.delivery",
    idempotencyKey: boundedIdentifier(
      input.idempotencyKey,
      "delivery record.idempotencyKey",
    ),
    fingerprint: parseFingerprint(input.fingerprint, "delivery record.fingerprint"),
    channelInstanceId: boundedIdentifier(
      input.channelInstanceId,
      "delivery record.channelInstanceId",
    ),
    ...(input.runId === undefined
      ? {}
      : { runId: boundedIdentifier(input.runId, "delivery record.runId") }),
    status,
    attempts: boundedInteger(input.attempts, "delivery record.attempts", 1, 10_000),
    attemptToken: boundedIdentifier(
      input.attemptToken,
      "delivery record.attemptToken",
    ),
    createdAt: canonicalTimestamp(input.createdAt, "delivery record.createdAt"),
    updatedAt: canonicalTimestamp(input.updatedAt, "delivery record.updatedAt"),
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(code === undefined ? {} : { code }),
  });
}

function parseRunSummary(value: unknown): AgentRunSummary {
  const input = ownDataRecord(
    value,
    "run summary",
    [
      "runId",
      "requestId",
      "conversationId",
      "status",
      "startedAt",
      "updatedAt",
      "endedAt",
      "attempts",
      "transcriptRevision",
      "failureCode",
    ],
  );
  const status = runStatus(input.status, "run summary.status");
  const endedAt = input.endedAt === undefined
    ? undefined
    : canonicalTimestamp(input.endedAt, "run summary.endedAt");
  const rawAttempts = denseOwnDataArray(
    input.attempts,
    "run summary.attempts",
    RUN_MAX_ATTEMPTS,
  );
  const attempts = rawAttempts.map((attempt, index) => {
    const parsed = parseRunAttemptEvidence(attempt, `run summary.attempts.${String(index)}`);
    if (parsed.attempt !== index + 1) {
      throw new TypeError("run summary attempts must be contiguous and ordered");
    }
    return parsed;
  });
  const transcriptRevision = input.transcriptRevision === undefined
    ? undefined
    : boundedCode(input.transcriptRevision, "run summary.transcriptRevision");
  const failureCode = input.failureCode === undefined
    ? undefined
    : boundedCode(input.failureCode, "run summary.failureCode");
  if ((status === "running") === (endedAt !== undefined)) {
    throw new TypeError("run summary terminal timestamps are inconsistent");
  }
  if ((status === "failed" || status === "uncertain") !== (failureCode !== undefined)) {
    throw new TypeError("run summary failure fields are inconsistent");
  }
  return Object.freeze({
    runId: boundedIdentifier(input.runId, "run summary.runId"),
    requestId: boundedIdentifier(input.requestId, "run summary.requestId"),
    conversationId: boundedIdentifier(
      input.conversationId,
      "run summary.conversationId",
    ),
    status,
    startedAt: canonicalTimestamp(input.startedAt, "run summary.startedAt"),
    updatedAt: canonicalTimestamp(input.updatedAt, "run summary.updatedAt"),
    ...(endedAt === undefined ? {} : { endedAt }),
    attempts: Object.freeze(attempts),
    ...(transcriptRevision === undefined ? {} : { transcriptRevision }),
    ...(failureCode === undefined ? {} : { failureCode }),
  });
}

function freezeSummary(value: AgentRunSummary): AgentRunSummary {
  return parseRunSummary(value);
}

function parseRunAttemptEvidence(
  value: unknown,
  path: string,
): AgentRunAttemptEvidence {
  const input = ownDataRecord(
    value,
    path,
    [
      "attempt",
      "route",
      "status",
      "startedAt",
      "endedAt",
      "code",
      "retryability",
      "sideEffects",
    ],
  );
  const status = stringEnum(
    input.status,
    ["started", "ineligible", "failed", "completed"] as const,
    `${path}.status`,
  );
  const endedAt = input.endedAt === undefined
    ? undefined
    : canonicalTimestamp(input.endedAt, `${path}.endedAt`);
  const code = input.code === undefined ? undefined : boundedCode(input.code, `${path}.code`);
  const retryability = input.retryability === undefined
    ? undefined
    : stringEnum(
      input.retryability,
      ["retryable", "not-retryable", "unknown"] as const,
      `${path}.retryability`,
    );
  const sideEffects = input.sideEffects === undefined
    ? undefined
    : stringEnum(
      input.sideEffects,
      ["none", "committed", "unknown"] as const,
      `${path}.sideEffects`,
    );
  if ((status === "started") === (endedAt !== undefined)) {
    throw new TypeError(`${path} terminal timestamp is inconsistent`);
  }
  if (
    (status === "ineligible" || status === "failed")
    !== (code !== undefined)
  ) {
    throw new TypeError(`${path} failure code is inconsistent`);
  }
  if (status !== "failed" && (retryability !== undefined || sideEffects !== undefined)) {
    throw new TypeError(`${path} retry evidence is valid only for failed attempts`);
  }
  if (status === "failed" && (retryability === undefined || sideEffects === undefined)) {
    throw new TypeError(`${path} failed attempts require explicit retry and side-effect evidence`);
  }
  return Object.freeze({
    attempt: boundedInteger(input.attempt, `${path}.attempt`, 1, RUN_MAX_ATTEMPTS),
    route: parseRouteIdentity(input.route),
    status,
    startedAt: canonicalTimestamp(input.startedAt, `${path}.startedAt`),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(code === undefined ? {} : { code }),
    ...(retryability === undefined ? {} : { retryability }),
    ...(sideEffects === undefined ? {} : { sideEffects }),
  });
}

function parseRunEvent(value: unknown): AgentRunEvent {
  const type = valueType(value);
  const input = ownDataRecord(
    value,
    "run event",
    type === "attempt"
      ? ["type", "runId", "sequence", "recordedAt", "attempt"]
      : type === "interaction"
        ? ["type", "runId", "sequence", "recordedAt", "evidence"]
        : type === "settled"
          ? [
              "type",
              "runId",
              "sequence",
              "recordedAt",
              "status",
              "transcriptRevision",
              "failureCode",
            ]
          : ["type", "runId", "sequence", "recordedAt"],
  );
  const runId = boundedIdentifier(input.runId, "run event.runId");
  const sequence = boundedInteger(input.sequence, "run event.sequence", 0, RUN_MAX_EVENTS - 1);
  const recordedAt = canonicalTimestamp(input.recordedAt, "run event.recordedAt");
  if (input.type === "admitted") {
    return Object.freeze({ type: "admitted", runId, sequence, recordedAt });
  }
  if (input.type === "attempt") {
    return Object.freeze({
      type: "attempt",
      runId,
      sequence,
      recordedAt,
      attempt: parseRunAttemptEvidence(input.attempt, "run event.attempt"),
    });
  }
  if (input.type === "interaction") {
    return Object.freeze({
      type: "interaction",
      runId,
      sequence,
      recordedAt,
      evidence: parseInteractionEvidence(input.evidence, "run event.evidence"),
    });
  }
  if (input.type === "settled") {
    const status = terminalRunStatus(input.status, "run event.status");
    const transcriptRevision = input.transcriptRevision === undefined
      ? undefined
      : boundedCode(input.transcriptRevision, "run event.transcriptRevision");
    const failureCode = input.failureCode === undefined
      ? undefined
      : boundedCode(input.failureCode, "run event.failureCode");
    if ((status === "failed" || status === "uncertain") !== (failureCode !== undefined)) {
      throw new TypeError("run event failure fields are inconsistent");
    }
    return Object.freeze({
      type: "settled",
      runId,
      sequence,
      recordedAt,
      status,
      ...(transcriptRevision === undefined ? {} : { transcriptRevision }),
      ...(failureCode === undefined ? {} : { failureCode }),
    });
  }
  throw new TypeError("run event.type is invalid");
}

function eventRecord(event: AgentRunEvent): StoredRunEvent {
  return Object.freeze({
    schemaVersion: 1,
    kind: "mono-agent.run-event",
    event: parseRunEvent(event),
  });
}

function canonicalFingerprintValue(
  value: unknown,
  path: string,
  state: { items: number; bytes: number; readonly active: Set<object> },
): unknown {
  state.items += 1;
  if (state.items > FINGERPRINT_MAX_ITEMS) throw new RangeError("fingerprint material has too many items");
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "string") {
    state.bytes += Buffer.byteLength(value, "utf8");
    if (state.bytes > FINGERPRINT_MAX_BYTES) throw new RangeError("fingerprint material exceeds its byte limit");
    return ["string", value];
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain finite numbers`);
    return ["number", Object.is(value, -0) ? "-0" : value];
  }
  if (value instanceof Uint8Array) {
    state.bytes += value.byteLength;
    if (state.bytes > FINGERPRINT_MAX_BYTES) throw new RangeError("fingerprint material exceeds its byte limit");
    return [
      "bytes",
      value.byteLength,
      createHash("sha256").update(value).digest("hex"),
    ];
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${path} must contain only JSON values or bytes`);
  }
  if (state.active.has(value)) throw new TypeError(`${path} must not contain cycles`);
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      const raw = denseOwnDataArray(value, path, FINGERPRINT_MAX_ITEMS);
      return [
        "array",
        raw.map((entry, index) =>
          canonicalFingerprintValue(entry, `${path}.${String(index)}`, state)),
      ];
    }
    const input = ownDataRecord(value, path, ownStringKeys(value).sort());
    return [
      "object",
      Object.keys(input).sort().map((key) => [
        key,
        canonicalFingerprintValue(input[key], `${path}.${key}`, state),
      ]),
    ];
  } finally {
    state.active.delete(value);
  }
}

function ownStringKeys(value: object): string[] {
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError("fingerprint material cannot contain symbols");
    keys.push(key);
  }
  return keys;
}

function sameAttempt(
  left: AgentRunAttemptEvidence,
  right: AgentRunAttemptEvidence,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameArtifactPublicationDescriptor(
  left: ArtifactPublicationDescriptor,
  right: ArtifactPublicationDescriptor,
): boolean {
  return left.slot === right.slot
    && left.sha256 === right.sha256
    && left.sizeBytes === right.sizeBytes
    && left.mediaType === right.mediaType
    && left.fileName === right.fileName;
}

function artifactReference(
  artifact: ArtifactPublicationDescriptor,
): ArtifactRef {
  return parseArtifactRef({
    id: `artifact:${artifact.sha256}`,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
    mediaType: artifact.mediaType,
    ...(artifact.fileName === undefined ? {} : { fileName: artifact.fileName }),
  });
}

function mergeArtifactPublicationDescriptors(
  first: readonly ArtifactPublicationDescriptor[],
  second: readonly ArtifactPublicationDescriptor[],
): readonly ArtifactPublicationDescriptor[] {
  const merged = [...first];
  const bySlot = new Map(merged.map((artifact) => [artifact.slot, artifact]));
  for (const artifact of second) {
    const existing = bySlot.get(artifact.slot);
    if (existing !== undefined) {
      if (!sameArtifactPublicationDescriptor(existing, artifact)) {
        throw new Error(`artifact publication slot ${artifact.slot} cannot be rewritten`);
      }
      continue;
    }
    merged.push(artifact);
    bySlot.set(artifact.slot, artifact);
  }
  if (merged.length > RUN_ARTIFACT_MAX_ITEMS) {
    throw new RangeError("artifact publication intent exceeds its item limit");
  }
  assertArtifactPublicationBounds(merged);
  return Object.freeze(merged);
}

function assertArtifactPublicationBounds(
  artifacts: readonly ArtifactPublicationDescriptor[],
): void {
  const contentBytes = artifacts.reduce(
    (total, artifact) => artifact.slot.startsWith(INTERNAL_ARTIFACT_SLOT_PREFIX)
      ? total
      : total + artifact.sizeBytes,
    0,
  );
  if (
    !Number.isSafeInteger(contentBytes)
    || contentBytes > RUN_CONTENT_ARTIFACT_MAX_TOTAL_BYTES
  ) {
    throw new RangeError("staged run content exceeds its aggregate artifact byte limit");
  }
}

function publishedContentReferences(
  intent: ArtifactPublicationIntentRecord,
  transcript: CanonicalTranscript,
): readonly ArtifactRef[] {
  const referenced = transcript.entries.flatMap((entry) =>
    entry.kind === "verbatim"
      ? []
      : entry.content.flatMap((part) =>
          part.type === "artifact" ? [part.ref] : []));
  const staged: ArtifactRef[] = [];
  const seen = new Set<string>();
  for (const artifact of intent.artifacts) {
    if (artifact.slot.startsWith(INTERNAL_ARTIFACT_SLOT_PREFIX)) continue;
    const ref = referenced.find((candidate) =>
      candidate.sha256 === artifact.sha256
      && candidate.sizeBytes === artifact.sizeBytes
      && candidate.mediaType === artifact.mediaType
      && candidate.fileName === artifact.fileName);
    if (ref === undefined) {
      throw new Error(
        `staged artifact slot ${artifact.slot} is not referenced by the settled transcript`,
      );
    }
    const identity = JSON.stringify([
      ref.id,
      ref.sha256,
      ref.sizeBytes,
      ref.mediaType,
      ref.fileName,
    ]);
    if (!seen.has(identity)) {
      seen.add(identity);
      staged.push(ref);
    }
  }
  return Object.freeze(staged);
}

function artifactSlot(value: unknown, path: string, allowInternal: boolean): string {
  const slot = boundedIdentifier(value, path);
  if (slot.startsWith(INTERNAL_ARTIFACT_SLOT_PREFIX)) {
    if (!allowInternal) {
      throw new TypeError(`${path} uses a reserved internal prefix`);
    }
    if (slot !== TRANSCRIPT_ARTIFACT_SLOT && slot !== RESPONSE_ARTIFACT_SLOT) {
      throw new TypeError(`${path} uses an unknown internal slot`);
    }
  }
  return slot;
}

function sameRoute(left: RouteIdentity, right: RouteIdentity): boolean {
  return left.runtimeInstanceId === right.runtimeInstanceId
    && left.model === right.model;
}

function nextEventCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= RUN_MAX_EVENTS) {
    throw new RangeError("run exceeds its event limit");
  }
  return value + 1;
}

function parseFingerprint(value: unknown, path: string): DurableFingerprint {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${path} must be a lowercase SHA-256 fingerprint`);
  }
  return value as DurableFingerprint;
}

function boundedIdentifier(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > IDENTIFIER_MAX_BYTES
  ) {
    throw new TypeError(`${path} must be a bounded non-empty string`);
  }
  return value;
}

function boundedCode(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > CODE_MAX_BYTES
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)
  ) {
    throw new TypeError(`${path} must be a bounded machine-readable code`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) {
    throw new TypeError(`${path} is outside its integer bound`);
  }
  return value as number;
}

function boundedDuration(value: number, path: string): number {
  return boundedInteger(value, path, MIN_STALE_AFTER_MS, MAX_STALE_AFTER_MS);
}

function runStatus(value: unknown, path: string): AgentRunStatus {
  return stringEnum(
    value,
    ["running", "completed", "cancelled", "max-turns", "failed", "uncertain"] as const,
    path,
  );
}

function terminalRunStatus(
  value: unknown,
  path: string,
): Exclude<AgentRunStatus, "running"> {
  return stringEnum(
    value,
    ["completed", "cancelled", "max-turns", "failed", "uncertain"] as const,
    path,
  );
}

function canonicalNow(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("journal clock returned an invalid Date");
  }
  return value.toISOString();
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(
    canonicalTimestampMilliseconds(timestamp, "timestamp") + milliseconds,
  ).toISOString();
}

function isExpired(value: string | undefined, clock: () => Date): boolean {
  if (value === undefined) return true;
  const expires = canonicalTimestampMilliseconds(value, "leaseExpiresAt");
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("journal clock returned an invalid Date");
  }
  return now.getTime() >= expires;
}

function canonicalTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a canonical timestamp`);
  canonicalTimestampMilliseconds(value, path);
  return value;
}

function canonicalTimestampMilliseconds(value: string, path: string): number {
  if (value.length !== 24) throw new TypeError(`${path} must be a canonical timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${path} must be a canonical timestamp`);
  }
  return milliseconds;
}

function stringEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`${path} is invalid`);
  }
  return value as T[number];
}

function valueType(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "type");
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function ownDataRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const allowed = new Set(allowedKeys);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${path} contains an unknown field`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} must be an own data property`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function denseOwnDataArray(
  value: unknown,
  path: string,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  if (!Number.isSafeInteger(value.length) || value.length > maximum) {
    throw new RangeError(`${path} exceeds its item limit`);
  }
  const allowed = new Set(["length"]);
  for (let index = 0; index < value.length; index += 1) allowed.add(String(index));
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${path} contains an unknown array field`);
    }
  }
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${path}.${String(index)} must be an own data property`);
    }
    output.push(descriptor.value);
  }
  return output;
}
