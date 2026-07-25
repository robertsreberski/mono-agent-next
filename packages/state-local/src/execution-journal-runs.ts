import {
  parseArtifactRef,
  parseRouteIdentity,
  type ArtifactRef,
} from "@mono-agent/module-sdk";

import {
  EXECUTION_STATE_PREFIXES,
  admissionStateKey,
  artifactIntentStateKey,
  conversationStateKey,
  describeExecutionArtifact,
  runEventStateKey,
  runHistoryStateKey,
  runStateKey,
  retentionCheckpointStateKey,
  sessionStateKey,
  type ExecutionRecord,
} from "./execution-store.js";

import {
  RUN_HISTORY_PAGE_SIZE,
  RUN_MAX_ATTEMPTS,
  RUN_ARTIFACT_MAX_ITEMS,
  TRANSCRIPT_ARTIFACT_SLOT,
  RESPONSE_ARTIFACT_SLOT,
} from "./execution-journal-constants.js";

import {
  parseAdmissionRecord,
  parseStoredRunRecord,
  parseRunHistoryRecord,
  parseConversationRecord,
  parseProviderSessionRecord,
  parseArtifactPublicationIntentRecord,
  parseRuntimeSession,
  parseRunRetentionCheckpoint,
  freezeSummary,
  parseRunAttemptEvidence,
  eventRecord,
  sameAttempt,
  mergeArtifactPublicationDescriptors,
  publishedContentReferences,
  artifactSlot,
  sameRoute,
  nextEventCount,
  parseFingerprint,
  boundedIdentifier,
  boundedConversationId,
  boundedCode,
  terminalRunStatus,
  canonicalNow,
  addMilliseconds,
  canonicalTimestamp,
  ownDataRecord,
  denseOwnDataArray,
} from "./execution-codec.js";

import {
  assertCanonicalTranscriptAppendOnly,
  decodeCanonicalTranscript,
  encodeCanonicalTranscript,
  parseCanonicalTranscript,
  parseInteractionEvidence,
  type CanonicalTranscript,
} from "./execution-transcript.js";

import type {
  AgentInteractionEvidence,
  AgentRunAttemptEvidence,
  AgentRunEvent,
  AgentRunHistoryPage,
  AgentRunRecord,
  AgentRunSummary,
} from "./execution-types.js";

import type {
  RunAdmissionInput,
  RunAdmissionResult,
  SettleRunInput,
  StageRunArtifactsInput,
  StagedRunArtifact,
} from "./execution-journal.js";

import type {
  AdmissionRecord,
  StoredRunRecord,
  RunHistoryRecord,
  ConversationRecord,
  ProviderSessionRecord,
  ArtifactPublicationDescriptor,
  ArtifactPublicationIntentRecord,
} from "./execution-journal-records.js";

import {
  ExecutionJournalConcern,
  type ExecutionJournalDependencies,
} from "./execution-journal-concern.js";

export class ExecutionRunJournal extends ExecutionJournalConcern {
  constructor(dependencies: ExecutionJournalDependencies) {
    super(dependencies);
  }

  async admit(input: RunAdmissionInput): Promise<RunAdmissionResult> {
    const requestId = boundedIdentifier(input.requestId, "requestId");
    const conversationId = boundedConversationId(
      input.conversationId,
      "conversationId",
    );
    const fingerprint = parseFingerprint(input.fingerprint, "fingerprint");
    const admissionKey = admissionStateKey(requestId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await this.store.read(admissionKey, parseAdmissionRecord, input.signal);
      if (existing !== undefined) {
        return this.existingAdmission(existing, conversationId, fingerprint, input.signal);
      }
      const runId = boundedIdentifier(input.runId ?? this.createRunId(), "runId");
      const now = canonicalNow(this.clock);
      const leaseExpiresAt = addMilliseconds(now, this.staleAfterMs);
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
      const result = await this.store.transaction({
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
    const current = await this.store.read(key, parseAdmissionRecord, signal);
    if (
      current === undefined
      || current.value.runId !== normalizedRunId
      || current.value.status !== "running"
    ) {
      return false;
    }
    const now = canonicalNow(this.clock);
    const updated: AdmissionRecord = Object.freeze({
      ...current.value,
      updatedAt: now,
      leaseExpiresAt: addMilliseconds(now, this.staleAfterMs),
    });
    const result = await this.store.transaction({
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
      const stored = await this.requireRunningRun(normalizedRunId, signal);
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
      const now = canonicalNow(this.clock);
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
      const result = await this.store.transaction({
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
      const stored = await this.requireRunningRun(normalizedRunId, signal);
      const now = canonicalNow(this.clock);
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
      const result = await this.store.transaction({
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
    const ensured = await this.ensureArtifactIntent(
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
        const ref = await this.store.putArtifact(
          plan.data,
          plan.descriptor.mediaType,
          plan.descriptor.fileName,
          input.signal,
        );
        staged.push(Object.freeze({ slot: plan.descriptor.slot, ref }));
      }
    } catch (error) {
      await this.bestEffortAbandonArtifactPublication(
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

    const storedRun = await this.store.read(runStateKey(runId), parseStoredRunRecord, input.signal);
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
    const admission = await this.store.read(
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
    let conversationChunks: readonly ExecutionRecord<Uint8Array>[] = [];
    if (input.transcript !== undefined) {
      transcript = parseCanonicalTranscript(input.transcript);
      if (transcript.conversationId !== storedRun.value.summary.conversationId) {
        throw new TypeError("settled transcript conversation identity does not match the run");
      }
      conversation = await this.store.read(
        conversationStateKey(transcript.conversationId),
        parseConversationRecord,
        input.signal,
      );
      const expectedRevision = (conversation?.value.revision ?? 0) + 1;
      if (transcript.revision !== expectedRevision) {
        throw new Error("settled transcript revision is not the next canonical revision");
      }
      if (conversation !== undefined) {
        const loaded = await this.loadConversationTranscriptState(
          conversation.value,
          input.signal,
        );
        const previous = loaded.transcript;
        conversationChunks = loaded.chunks;
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
      providerSession = await this.store.read(
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
      providerSession = await this.store.read(
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
      : await this.ensureArtifactIntent(
        runId,
        requestId,
        publicationDescriptors,
        input.signal,
      );
    let artifactIntent = ensuredArtifactIntent?.record;
    if (artifactIntent === undefined) {
      artifactIntent = await this.store.read(
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
        await this.store.readArtifact(ref, input.signal);
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
        transcriptRef = await this.store.putArtifact(
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
        responseRef = await this.store.putArtifact(
          responseBytes,
          "application/vnd.mono-agent.response+json",
          undefined,
          input.signal,
        );
      }
    } catch (error) {
      if (ensuredArtifactIntent !== undefined) {
        await this.bestEffortAbandonArtifactPublication(
          ensuredArtifactIntent,
          possiblyPublished,
        );
      }
      throw error;
    }
    const transcriptRevision = transcript === undefined || transcriptRef === undefined
      ? undefined
      : `r${String(transcript.revision)}:${transcriptRef.sha256}`;
    const now = canonicalNow(this.clock);
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
            ...(conversation?.value.createdAt === undefined
              ? {}
              : { createdAt: conversation.value.createdAt }),
            updatedAt: now,
            ...(conversation?.value.title === undefined
              ? {}
              : { title: conversation.value.title }),
            ...(conversation?.value.metadata === undefined
              ? {}
              : { metadata: conversation.value.metadata }),
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
    const result = await this.store.transaction({
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
        ...conversationChunks.map((chunk) => ({
          key: chunk.key,
          expectedVersion: chunk.version,
        })),
      ],
      signal: input.signal,
    });
    if (result.status === "conflict") {
      throw new Error("run settlement lost an atomic state race");
    }
    if (retainedArtifactIntent !== undefined) {
      await this.bestEffortReconcileArtifactIntent(runId);
    }
    return summary;
  }

  async readCachedResponse(
    ref: ArtifactRef,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    return this.store.readArtifact(parseArtifactRef(ref), signal);
  }


  async readRun(runId: string, signal: AbortSignal): Promise<AgentRunRecord | undefined> {
    const normalizedRunId = boundedIdentifier(runId, "runId");
    const stored = await this.store.read(
      runStateKey(normalizedRunId),
      parseStoredRunRecord,
      signal,
    );
    if (stored === undefined) return undefined;
    const retention = await this.store.read(
      retentionCheckpointStateKey(normalizedRunId),
      parseRunRetentionCheckpoint,
      signal,
    );
    if (retention !== undefined) return undefined;
    const events = await this.readEvents(stored.value, signal);
    let transcript: CanonicalTranscript | undefined;
    if (stored.value.transcriptRef !== undefined) {
      const encoded = await this.store.readArtifact(stored.value.transcriptRef, signal);
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
    const page = await this.store.scan(
      EXECUTION_STATE_PREFIXES.runHistory,
      cursor,
      RUN_HISTORY_PAGE_SIZE,
      parseRunHistoryRecord,
      signal,
    );
    const runs: AgentRunSummary[] = [];
    for (const history of page.records) {
      const retention = await this.store.read(
        retentionCheckpointStateKey(history.value.runId),
        parseRunRetentionCheckpoint,
        signal,
      );
      if (retention !== undefined) continue;
      const stored = await this.store.read(
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

}
