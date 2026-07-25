// SPDX-License-Identifier: MIT
import {
  EXECUTION_STATE_PREFIXES,
  admissionStateKey,
  runStateKey,
  retentionCheckpointStateKey,
  type ExecutionRecord,
} from "./execution-store.js";

import {
  ARTIFACT_RECONCILIATION_DEFAULT_LIMIT,
  ARTIFACT_RECONCILIATION_MAX_LIMIT,
  RETENTION_SCAN_PAGE_SIZE,
} from "./execution-journal-constants.js";

import {
  parseAdmissionRecord,
  parseStoredRunRecord,
  parseRunHistoryRecord,
  parseProviderSessionRecord,
  parseArtifactPublicationIntentRecord,
  parseRunRetentionCheckpoint,
  uniqueArtifactRefs,
  boundedInteger,
  canonicalNow,
  canonicalTimestamp,
} from "./execution-codec.js";

import type {
  ExecutionMaintenanceInput,
  ExecutionMaintenanceResult,
  ReconcileArtifactPublicationsInput,
  ArtifactPublicationReconciliation,
} from "./execution-journal.js";

import type {
  AdmissionRecord,
  StoredRunRecord,
  RunHistoryRecord,
  RunRetentionCheckpoint,
} from "./execution-journal-records.js";

import {
  ExecutionJournalConcern,
  type ExecutionJournalDependencies,
} from "./execution-journal-concern.js";

export class ExecutionMaintenanceJournal extends ExecutionJournalConcern {
  constructor(dependencies: ExecutionJournalDependencies) {
    super(dependencies);
  }

  async reconcileArtifactPublications(
    input: ReconcileArtifactPublicationsInput,
  ): Promise<ArtifactPublicationReconciliation> {
    const limit = boundedInteger(
      input.limit ?? ARTIFACT_RECONCILIATION_DEFAULT_LIMIT,
      "artifact reconciliation limit",
      1,
      ARTIFACT_RECONCILIATION_MAX_LIMIT,
    );
    const page = await this.store.scan(
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
      const reconciled = await this.reconcileArtifactIntent(record, input.signal);
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

  /**
   * Bounded, restart-safe retirement of execution-owned state.
   *
   * A terminal run first receives a durable checkpoint. Event pages can then
   * be removed across multiple passes; the final run/history/admission delete
   * is atomic. The checkpoint remains until every published artifact named by
   * the retired owners is either still referenced elsewhere or has completed
   * state-local's private v2 release protocol.
   */
  async maintainExecution(
    input: ExecutionMaintenanceInput,
  ): Promise<ExecutionMaintenanceResult> {
    const cutoffAt = canonicalTimestamp(input.cutoffAt, "execution maintenance.cutoffAt");
    const dryRun = input.dryRun ?? false;
    if (typeof dryRun !== "boolean") {
      throw new TypeError("execution maintenance.dryRun must be a boolean");
    }
    const limit = boundedInteger(
      input.limit ?? RETENTION_SCAN_PAGE_SIZE,
      "execution maintenance.limit",
      1,
      RETENTION_SCAN_PAGE_SIZE,
    );
    let budget = limit;
    let terminalRunsRemoved = 0;
    let runEventsRemoved = 0;
    let terminalAdmissionsRemoved = 0;
    let staleSessionsRemoved = 0;
    let publishedArtifactsReleased = 0;
    let truncated = false;

    const checkpoints = await this.scanAll(
      EXECUTION_STATE_PREFIXES.retentionCheckpoints,
      parseRunRetentionCheckpoint,
      input.signal,
    );
    truncated ||= checkpoints.truncated;
    if (!dryRun) {
      for (const checkpoint of checkpoints.records) {
        if (budget < 1) {
          truncated = true;
          break;
        }
        const resumed = await this.resumeRunRetention(
          checkpoint,
          budget,
          input.signal,
        );
        budget -= resumed.mutations;
        terminalRunsRemoved += resumed.runRemoved;
        runEventsRemoved += resumed.eventsRemoved;
        terminalAdmissionsRemoved += resumed.admissionRemoved;
        publishedArtifactsReleased += resumed.artifactsReleased;
        truncated ||= resumed.pending;
      }
    }

    const histories = await this.scanAll(
      EXECUTION_STATE_PREFIXES.runHistory,
      parseRunHistoryRecord,
      input.signal,
    );
    truncated ||= histories.truncated;
    const terminalCandidates: {
      readonly history: ExecutionRecord<RunHistoryRecord>;
      readonly run: ExecutionRecord<StoredRunRecord>;
      readonly admission: ExecutionRecord<AdmissionRecord> | undefined;
    }[] = [];
    for (const history of histories.records) {
      const run = await this.store.read(
        runStateKey(history.value.runId),
        parseStoredRunRecord,
        input.signal,
      );
      if (run === undefined) {
        // A checkpoint owns any partially retired history row. An uncheckpointed
        // dangling index is corruption, not deletion authority.
        const checkpoint = await this.store.read(
          retentionCheckpointStateKey(history.value.runId),
          parseRunRetentionCheckpoint,
          input.signal,
        );
        if (checkpoint === undefined) {
          throw new Error("run history index points to missing uncheckpointed run state");
        }
        continue;
      }
      const endedAt = run.value.summary.endedAt;
      if (
        run.value.summary.status === "running"
        || endedAt === undefined
        || endedAt > cutoffAt
      ) {
        continue;
      }
      if (run.value.summary.startedAt !== history.value.startedAt) {
        throw new Error("run retention history authority is mismatched");
      }
      const admission = await this.store.read(
        admissionStateKey(run.value.summary.requestId),
        parseAdmissionRecord,
        input.signal,
      );
      if (
        admission !== undefined
        && (
          admission.value.runId !== run.value.summary.runId
          || admission.value.conversationId !== run.value.summary.conversationId
          || admission.value.status === "running"
        )
      ) {
        throw new Error("terminal run retention admission authority is mismatched");
      }
      terminalCandidates.push({ history, run, admission });
    }

    if (!dryRun) {
      for (const candidate of terminalCandidates) {
        if (budget < 1) {
          truncated = true;
          break;
        }
        const key = retentionCheckpointStateKey(candidate.run.value.summary.runId);
        const existing = await this.store.read(
          key,
          parseRunRetentionCheckpoint,
          input.signal,
        );
        if (existing !== undefined) continue;
        const artifacts = uniqueArtifactRefs([
          candidate.run.value.transcriptRef,
          candidate.admission?.value.responseRef,
        ]);
        const checkpoint: RunRetentionCheckpoint = Object.freeze({
          schemaVersion: 1,
          kind: "mono-agent.run-retention-checkpoint",
          runId: candidate.run.value.summary.runId,
          historyKey: candidate.history.key,
          requestId: candidate.run.value.summary.requestId,
          startedAt: candidate.run.value.summary.startedAt,
          endedAt: candidate.run.value.summary.endedAt!,
          artifacts,
          createdAt: canonicalNow(this.clock),
        });
        const claimed = await this.store.transaction({
          puts: [{ key, expectedVersion: null, value: checkpoint }],
          signal: input.signal,
        });
        if (claimed.status === "applied") budget -= 1;
      }
    }

    const sessions = await this.scanAll(
      EXECUTION_STATE_PREFIXES.sessions,
      parseProviderSessionRecord,
      input.signal,
    );
    truncated ||= sessions.truncated;
    const staleSessions = sessions.records.filter(({ value }) =>
      value.updatedAt <= cutoffAt);
    if (!dryRun && budget > 0 && staleSessions.length > 0) {
      const selected = staleSessions.slice(0, budget);
      const deleted = await this.store.transaction({
        deletes: selected.map((record) => ({
          key: record.key,
          expectedVersion: record.version,
        })),
        signal: input.signal,
      });
      if (deleted.status === "conflict") {
        throw new Error("stale session retention lost an atomic state race");
      }
      staleSessionsRemoved = deleted.deletedKeys.length;
      budget -= deleted.deletedKeys.length;
      if (selected.length < staleSessions.length) truncated = true;
    } else if (!dryRun && staleSessions.length > 0) {
      truncated = true;
    }

    const remainingCheckpoints = await this.scanAll(
      EXECUTION_STATE_PREFIXES.retentionCheckpoints,
      parseRunRetentionCheckpoint,
      input.signal,
    );
    truncated ||= remainingCheckpoints.truncated;
    return Object.freeze({
      terminalRunCandidates: terminalCandidates.length,
      terminalRunsRemoved,
      runEventsRemoved,
      terminalAdmissionsRemoved,
      // Delivered and unknown receipts are permanent idempotency authority.
      // A time-based pass must never turn either outcome back into `send`.
      terminalDeliveryCandidates: 0,
      terminalDeliveriesRemoved: 0,
      staleSessionCandidates: staleSessions.length,
      staleSessionsRemoved,
      publishedArtifactsReleased,
      pendingCheckpoints: remainingCheckpoints.records.length,
      truncated,
    });
  }

}
