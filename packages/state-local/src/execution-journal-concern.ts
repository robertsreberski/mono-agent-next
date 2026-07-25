// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from "node:crypto";

import type { ArtifactRef } from "@mono-agent/module-sdk";

import {
  EXECUTION_STATE_PREFIXES,
  ExecutionStore,
  admissionStateKey,
  artifactIntentStateKey,
  runEventPrefix,
  runEventStateKey,
  runStateKey,
  type ExecutionRecord,
} from "./execution-store.js";

import {
  DEFAULT_STALE_AFTER_MS,
  RUN_EVENT_PAGE_SIZE,
  RUN_MAX_EVENTS,
  RUN_ARTIFACT_MAX_ITEMS,
  ARTIFACT_CLEANUP_TIMEOUT_MS,
  RETENTION_SCAN_PAGE_SIZE,
  RETENTION_REFERENCE_SCAN_MAX_RECORDS,
  TRANSCRIPT_MAX_BYTES,
} from "./execution-journal-constants.js";

import {
  parseAdmissionRecord,
  parseStoredRunRecord,
  parseStoredRunEvent,
  parseRunHistoryRecord,
  parseConversationRecord,
  parseArtifactPublicationIntentRecord,
  parseArtifactPublicationDescriptor,
  freezeSummary,
  eventRecord,
  sameArtifactRef,
  sameArtifactPublicationDescriptor,
  artifactReference,
  mergeArtifactPublicationDescriptors,
  assertArtifactPublicationBounds,
  nextEventCount,
  boundedDuration,
  canonicalNow,
  isExpired,
} from "./execution-codec.js";

import {
  decodeCanonicalTranscript,
  type CanonicalTranscript,
} from "./execution-transcript.js";

import type { AgentRunEvent } from "./execution-types.js";

import type {
  DurableFingerprint,
  RunAdmissionResult,
  DurableRunJournalOptions,
} from "./execution-journal.js";

import type {
  AdmissionRecord,
  StoredRunRecord,
  ConversationRecord,
  TranscriptChunkManifest,
  LoadedConversationTranscript,
  ArtifactPublicationDescriptor,
  ArtifactPublicationIntentRecord,
  EnsuredArtifactIntent,
  RunRetentionCheckpoint,
} from "./execution-journal-records.js";

export interface ExecutionJournalDependencies {
  readonly store: ExecutionStore;
  readonly clock: () => Date;
  readonly staleAfterMs: number;
  readonly createRunId: () => string;
  readonly createDeliveryToken: () => string;
  readonly releaseArtifact:
    | ((ref: ArtifactRef, signal: AbortSignal) => Promise<boolean>)
    | undefined;
}

export function createExecutionJournalDependencies(
  store: ExecutionStore,
  options: DurableRunJournalOptions,
): ExecutionJournalDependencies {
  return {
    store,
    clock: options.clock ?? (() => new Date()),
    staleAfterMs: boundedDuration(
      options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
      "staleAfterMs",
    ),
    createRunId: options.createRunId ?? randomUUID,
    createDeliveryToken: options.createDeliveryToken ?? randomUUID,
    releaseArtifact: options.releaseArtifact,
  };
}

export abstract class ExecutionJournalConcern {
  protected readonly store: ExecutionStore;
  protected readonly clock: () => Date;
  protected readonly staleAfterMs: number;
  protected readonly createRunId: () => string;
  protected readonly createDeliveryToken: () => string;
  protected readonly releaseArtifact:
    | ((ref: ArtifactRef, signal: AbortSignal) => Promise<boolean>)
    | undefined;

  protected constructor(dependencies: ExecutionJournalDependencies) {
    this.store = dependencies.store;
    this.clock = dependencies.clock;
    this.staleAfterMs = dependencies.staleAfterMs;
    this.createRunId = dependencies.createRunId;
    this.createDeliveryToken = dependencies.createDeliveryToken;
    this.releaseArtifact = dependencies.releaseArtifact;
  }

  protected async loadConversationTranscript(
    record: ConversationRecord,
    signal: AbortSignal,
  ): Promise<CanonicalTranscript> {
    return (await this.loadConversationTranscriptState(record, signal)).transcript;
  }

  protected async loadConversationTranscriptState(
    record: ConversationRecord,
    signal: AbortSignal,
  ): Promise<LoadedConversationTranscript> {
    const loaded = record.inlineTranscript !== undefined
      ? Object.freeze({
          transcript: record.inlineTranscript,
          chunks: Object.freeze([]),
        })
      : record.transcriptChunks !== undefined
        ? await this.loadChunkedTranscript(
            record.conversationId,
            record.transcriptChunks,
            signal,
          )
        : Object.freeze({
            transcript: decodeCanonicalTranscript(
              await this.store.readArtifact(record.transcriptRef!, signal),
              record.conversationId,
            ),
            chunks: Object.freeze([]),
          });
    const transcript = loaded.transcript;
    if (
      transcript.revision !== record.revision
      || transcript.entries.length !== record.entryCount
    ) {
      throw new Error("canonical transcript pointer does not match its record");
    }
    return loaded;
  }

  protected async loadChunkedTranscript(
    conversationId: string,
    manifest: TranscriptChunkManifest,
    signal: AbortSignal,
  ): Promise<LoadedConversationTranscript> {
    const chunks: ExecutionRecord<Uint8Array>[] = [];
    let totalBytes = 0;
    for (const descriptor of manifest.chunks) {
      const chunk = await this.store.readBytes(descriptor.key, signal);
      if (chunk === undefined) {
        throw new Error("canonical transcript chunk is missing");
      }
      const digest = createHash("sha256").update(chunk.value).digest("hex");
      if (
        chunk.value.byteLength !== descriptor.sizeBytes
        || digest !== descriptor.digest
      ) {
        throw new Error("canonical transcript chunk does not match its manifest");
      }
      totalBytes += chunk.value.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > TRANSCRIPT_MAX_BYTES) {
        throw new Error("canonical transcript chunks exceed their byte bound");
      }
      chunks.push(chunk);
    }
    if (totalBytes !== manifest.sizeBytes) {
      throw new Error("canonical transcript chunks do not match their declared size");
    }
    const encoded = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      encoded.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
    const digest = createHash("sha256").update(encoded).digest("hex");
    if (digest !== manifest.digest) {
      throw new Error("canonical transcript chunks do not match their content authority");
    }
    return Object.freeze({
      transcript: decodeCanonicalTranscript(encoded, conversationId),
      chunks: Object.freeze(chunks),
    });
  }


  protected async resumeRunRetention(
    checkpoint: ExecutionRecord<RunRetentionCheckpoint>,
    budget: number,
    signal: AbortSignal,
  ): Promise<{
    readonly mutations: number;
    readonly runRemoved: number;
    readonly eventsRemoved: number;
    readonly admissionRemoved: number;
    readonly artifactsReleased: number;
    readonly pending: boolean;
  }> {
    const value = checkpoint.value;
    const run = await this.store.read(
      runStateKey(value.runId),
      parseStoredRunRecord,
      signal,
    );
    if (
      run !== undefined
      && (
        run.value.summary.status === "running"
        || run.value.summary.requestId !== value.requestId
        || run.value.summary.startedAt !== value.startedAt
        || run.value.summary.endedAt !== value.endedAt
      )
    ) {
      throw new Error("run retention checkpoint no longer matches its terminal run");
    }

    const events = await this.scanAll(
      runEventPrefix(value.runId),
      parseStoredRunEvent,
      signal,
      RUN_MAX_EVENTS,
    );
    if (events.records.length > 0) {
      const selected = events.records.slice(0, Math.min(budget, RETENTION_SCAN_PAGE_SIZE));
      if (selected.length === 0) {
        return {
          mutations: 0,
          runRemoved: 0,
          eventsRemoved: 0,
          admissionRemoved: 0,
          artifactsReleased: 0,
          pending: true,
        };
      }
      const deleted = await this.store.transaction({
        deletes: selected.map((event) => ({
          key: event.key,
          expectedVersion: event.version,
        })),
        signal,
      });
      if (deleted.status === "conflict") {
        throw new Error("run event retention lost an atomic state race");
      }
      return {
        mutations: deleted.deletedKeys.length,
        runRemoved: 0,
        eventsRemoved: deleted.deletedKeys.length,
        admissionRemoved: 0,
        artifactsReleased: 0,
        pending: true,
      };
    }

    const history = await this.store.read(
      value.historyKey,
      parseRunHistoryRecord,
      signal,
    );
    if (
      history !== undefined
      && (
        history.value.runId !== value.runId
        || history.value.startedAt !== value.startedAt
      )
    ) {
      throw new Error("run retention checkpoint history authority is mismatched");
    }
    const admission = await this.store.read(
      admissionStateKey(value.requestId),
      parseAdmissionRecord,
      signal,
    );
    if (
      admission !== undefined
      && (
        admission.value.runId !== value.runId
        || admission.value.status === "running"
      )
    ) {
      throw new Error("run retention checkpoint admission authority is mismatched");
    }
    const owners = [
      ...(run === undefined ? [] : [run]),
      ...(history === undefined ? [] : [history]),
      ...(admission === undefined ? [] : [admission]),
    ];
    if (owners.length > 0) {
      if (owners.length > budget) {
        return {
          mutations: 0,
          runRemoved: 0,
          eventsRemoved: 0,
          admissionRemoved: 0,
          artifactsReleased: 0,
          pending: true,
        };
      }
      const deleted = await this.store.transaction({
        deletes: owners.map((owner) => ({
          key: owner.key,
          expectedVersion: owner.version,
        })),
        signal,
      });
      if (deleted.status === "conflict") {
        throw new Error("terminal run retention lost an atomic state race");
      }
      return {
        mutations: deleted.deletedKeys.length,
        runRemoved: run === undefined ? 0 : 1,
        eventsRemoved: 0,
        admissionRemoved: admission === undefined ? 0 : 1,
        artifactsReleased: 0,
        pending: true,
      };
    }

    let artifactsReleased = 0;
    let referencedArtifact = false;
    for (const artifact of value.artifacts) {
      if (await this.artifactIsReferenced(artifact, signal)) {
        referencedArtifact = true;
        continue;
      }
      if (this.releaseArtifact !== undefined) {
        if (await this.releaseArtifact(artifact, signal)) {
          artifactsReleased += 1;
        }
      }
    }
    if (referencedArtifact) {
      return {
        mutations: 0,
        runRemoved: 0,
        eventsRemoved: 0,
        admissionRemoved: 0,
        artifactsReleased,
        pending: true,
      };
    }
    if (budget < 1) {
      return {
        mutations: 0,
        runRemoved: 0,
        eventsRemoved: 0,
        admissionRemoved: 0,
        artifactsReleased,
        pending: true,
      };
    }
    const removedCheckpoint = await this.store.transaction({
      deletes: [{
        key: checkpoint.key,
        expectedVersion: checkpoint.version,
      }],
      signal,
    });
    if (removedCheckpoint.status === "conflict") {
      throw new Error("run retention checkpoint cleanup lost an atomic state race");
    }
    return {
      mutations: removedCheckpoint.deletedKeys.length,
      runRemoved: 0,
      eventsRemoved: 0,
      admissionRemoved: 0,
      artifactsReleased,
      pending: false,
    };
  }

  protected async artifactIsReferenced(
    artifact: ArtifactRef,
    signal: AbortSignal,
  ): Promise<boolean> {
    const conversations = await this.scanAll(
      EXECUTION_STATE_PREFIXES.conversations,
      parseConversationRecord,
      signal,
    );
    if (conversations.truncated) return true;
    if (conversations.records.some(({ value }) =>
      sameArtifactRef(value.transcriptRef, artifact))) return true;

    const runs = await this.scanAll(
      `${EXECUTION_STATE_PREFIXES.runs}records/`,
      parseStoredRunRecord,
      signal,
    );
    if (runs.truncated) return true;
    if (runs.records.some(({ value }) =>
      sameArtifactRef(value.transcriptRef, artifact))) return true;

    const admissions = await this.scanAll(
      EXECUTION_STATE_PREFIXES.admissions,
      parseAdmissionRecord,
      signal,
    );
    if (admissions.truncated) return true;
    if (admissions.records.some(({ value }) =>
      sameArtifactRef(value.responseRef, artifact))) return true;

    const intents = await this.scanAll(
      EXECUTION_STATE_PREFIXES.artifactIntents,
      parseArtifactPublicationIntentRecord,
      signal,
    );
    if (intents.truncated) return true;
    return intents.records.some(({ value }) =>
      [...value.artifacts, ...value.cleanupArtifacts].some((candidate) =>
        candidate.sha256 === artifact.sha256
        && candidate.sizeBytes === artifact.sizeBytes));
  }

  protected async scanAll<T>(
    prefix: string,
    parser: (value: unknown) => T,
    signal: AbortSignal,
    maximumRecords = RETENTION_REFERENCE_SCAN_MAX_RECORDS,
  ): Promise<{
    readonly records: readonly ExecutionRecord<T>[];
    readonly truncated: boolean;
  }> {
    const records: ExecutionRecord<T>[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    while (records.length < maximumRecords) {
      const remaining = maximumRecords - records.length;
      const page = await this.store.scan(
        prefix,
        cursor,
        Math.min(RETENTION_SCAN_PAGE_SIZE, remaining),
        parser,
        signal,
      );
      records.push(...page.records);
      if (page.cursor === undefined) {
        return { records: Object.freeze(records), truncated: false };
      }
      if (seenCursors.has(page.cursor)) {
        throw new Error("execution retention scan cursor did not advance");
      }
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }
    return {
      records: Object.freeze(records),
      truncated: cursor !== undefined,
    };
  }

  protected async bestEffortAbandonArtifactPublication(
    ensured: EnsuredArtifactIntent,
    possiblyPublished: readonly ArtifactPublicationDescriptor[],
  ): Promise<void> {
    try {
      const signal = AbortSignal.timeout(ARTIFACT_CLEANUP_TIMEOUT_MS);
      const pending = await this.abandonArtifactPublication(
        ensured,
        possiblyPublished,
        signal,
      );
      if (pending !== undefined) {
        await this.reconcileArtifactIntent(pending, signal);
      }
    } catch {
      // The durable intent remains authoritative. Publication failures must
      // retain their original error while bounded reconciliation can retry.
    }
  }

  protected async abandonArtifactPublication(
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
      const current = await this.store.read(
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
            updatedAt: canonicalNow(this.clock),
          });
      const result = await this.store.transaction({
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
      const stored = await this.store.read(
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

  protected async bestEffortReconcileArtifactIntent(runId: string): Promise<void> {
    try {
      const signal = AbortSignal.timeout(ARTIFACT_CLEANUP_TIMEOUT_MS);
      const record = await this.store.read(
        artifactIntentStateKey(runId),
        parseArtifactPublicationIntentRecord,
        signal,
      );
      if (record !== undefined) {
        await this.reconcileArtifactIntent(record, signal);
      }
    } catch {
      // The retained intent is the recovery authority for the next bounded
      // reconciliation pass. Cleanup must not obscure the settled run result.
    }
  }

  protected async reconcileArtifactIntent(
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
        current = await this.store.read(
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
      const run = await this.store.read(
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
          updatedAt: canonicalNow(this.clock),
        });
        const moved = await this.store.transaction({
          puts: [{
            key: current.key,
            expectedVersion: current.version,
            value: cleanupValue,
          }],
          signal,
        });
        if (moved.status === "conflict") continue;
        current = await this.store.read(
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
          if (await this.store.deleteArtifact(
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
      const result = await this.store.transaction({
        puts: removeIntent
          ? []
          : [{
              key: current.key,
              expectedVersion: current.version,
              value: Object.freeze({
                ...current.value,
                cleanupArtifacts: Object.freeze(cleanupArtifacts),
                updatedAt: canonicalNow(this.clock),
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

  protected async ensureArtifactIntent(
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
      const storedRun = await this.requireRunningRun(runId, signal);
      if (storedRun.value.summary.requestId !== requestId) {
        throw new Error("artifact publication run request identity does not match");
      }
      const admission = await this.store.read(
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
      const existing = await this.store.read(
        key,
        parseArtifactPublicationIntentRecord,
        signal,
      );
      let value: ArtifactPublicationIntentRecord;
      let expectedVersion: string | null;
      const activatedSlots = new Set<string>();
      if (existing === undefined) {
        const now = canonicalNow(this.clock);
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
          updatedAt: canonicalNow(this.clock),
        });
        expectedVersion = existing.version;
      }
      const result = await this.store.transaction({
        checks: [
          { key: storedRun.key, expectedVersion: storedRun.version },
          { key: admission.key, expectedVersion: admission.version },
        ],
        puts: [{ key, expectedVersion, value }],
        signal,
      });
      if (result.status === "conflict") continue;
      const stored = await this.store.read(
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

  protected async existingAdmission(
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
      await this.bestEffortReconcileArtifactIntent(admission.value.runId);
      return { status: "uncertain", runId: admission.value.runId };
    }
    if (admission.value.status === "settled") {
      const run = await this.store.read(
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
      await this.bestEffortReconcileArtifactIntent(admission.value.runId);
      return {
        status: "cached",
        summary: run.value.summary,
        ...(admission.value.responseRef === undefined
          ? {}
          : { responseRef: admission.value.responseRef }),
      };
    }
    if (!isExpired(admission.value.leaseExpiresAt, this.clock)) {
      return { status: "join", runId: admission.value.runId };
    }
    const run = await this.store.read(
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
    const now = canonicalNow(this.clock);
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
    const artifactIntent = await this.store.read(
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
    const result = await this.store.transaction({
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
      const current = await this.store.read(admission.key, parseAdmissionRecord, signal);
      if (current === undefined) throw new Error("admission disappeared during stale classification");
      return this.existingAdmission(
        current,
        conversationId,
        fingerprint,
        signal,
        contention + 1,
      );
    }
    if (cleanupIntent !== undefined) {
      await this.bestEffortReconcileArtifactIntent(admission.value.runId);
    }
    return { status: "uncertain", runId: admission.value.runId };
  }

  protected async requireRunningRun(
    runId: string,
    signal: AbortSignal,
  ): Promise<ExecutionRecord<StoredRunRecord>> {
    const stored = await this.store.read(runStateKey(runId), parseStoredRunRecord, signal);
    if (stored === undefined) throw new Error(`run ${runId} does not exist`);
    if (stored.value.summary.status !== "running") throw new Error(`run ${runId} is already terminal`);
    return stored;
  }

  protected async readEvents(
    run: StoredRunRecord,
    signal: AbortSignal,
  ): Promise<readonly AgentRunEvent[]> {
    const events: AgentRunEvent[] = [];
    let cursor: string | undefined;
    do {
      const remaining = run.eventCount - events.length;
      if (remaining <= 0) break;
      const page = await this.store.scan(
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
