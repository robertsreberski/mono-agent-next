import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ExecutionStore,
  admissionStateKey,
  artifactIntentStateKey,
} from "../execution-store.js";
import {
  DurableRunJournal,
  createDurableFingerprint,
} from "../run-journal.js";
import { appendCanonicalTranscript } from "../transcript.js";
import { MemoryStateStore } from "./durable-state-fixture.js";

const signal = new AbortController().signal;
const route = { runtimeInstanceId: "primary", model: "provider:model" } as const;

describe("DurableRunJournal", () => {
  it("deduplicates exact requests, rejects conflicts, and classifies stale work as uncertain", async () => {
    const state = new MemoryStateStore();
    let now = Date.parse("2026-07-23T10:00:00.000Z");
    const journal = new DurableRunJournal(new ExecutionStore(state), {
      clock: () => new Date(now),
      staleAfterMs: 1_000,
      createRunId: () => "run-1",
    });
    const fingerprint = createDurableFingerprint({ conversationId: "c1", text: "hello" });

    await expect(journal.admit({
      requestId: "request-1",
      conversationId: "c1",
      fingerprint,
      signal,
    })).resolves.toMatchObject({ status: "accepted", summary: { runId: "run-1" } });
    await expect(journal.admit({
      requestId: "request-1",
      conversationId: "c1",
      fingerprint,
      signal,
    })).resolves.toEqual({ status: "join", runId: "run-1" });
    await expect(journal.admit({
      requestId: "request-1",
      conversationId: "different-conversation",
      fingerprint,
      signal,
    })).resolves.toEqual({ status: "conflict", runId: "run-1" });
    await expect(journal.admit({
      requestId: "request-1",
      conversationId: "c1",
      fingerprint: createDurableFingerprint({ conversationId: "c1", text: "different" }),
      signal,
    })).resolves.toEqual({ status: "conflict", runId: "run-1" });

    now += 1_001;
    await expect(journal.admit({
      requestId: "request-1",
      conversationId: "c1",
      fingerprint,
      signal,
    })).resolves.toEqual({ status: "uncertain", runId: "run-1" });
    await expect(journal.readRun("run-1", signal)).resolves.toMatchObject({
      summary: { status: "uncertain", failureCode: "stale-running-admission" },
      events: [
        { type: "admitted", sequence: 0 },
        { type: "settled", sequence: 1, status: "uncertain" },
      ],
    });
  });

  it("atomically settles transcript, run, admission, response cache, and exact session linkage", async () => {
    const state = new SessionDeleteRaceState();
    let now = Date.parse("2026-07-23T10:00:00.000Z");
    const journal = new DurableRunJournal(new ExecutionStore(state), {
      clock: () => new Date(now),
      createRunId: () => "run-settle",
    });
    const fingerprint = createDurableFingerprint({
      conversationId: "conversation-1",
      text: "raw-secret-user-text",
    });
    await journal.admit({
      requestId: "request-settle",
      conversationId: "conversation-1",
      fingerprint,
      signal,
    });
    await journal.recordAttempt("run-settle", {
      attempt: 1,
      route,
      status: "started",
      startedAt: "2026-07-23T10:00:00.000Z",
    }, signal);
    now += 100;
    await journal.recordAttempt("run-settle", {
      attempt: 1,
      route,
      status: "completed",
      startedAt: "2026-07-23T10:00:00.000Z",
      endedAt: "2026-07-23T10:00:00.100Z",
    }, signal);
    await journal.recordInteraction("run-settle", {
      kind: "approval",
      interactionId: "approval-1",
      phase: "answered",
      requestedAt: "2026-07-23T10:00:00.010Z",
      settledAt: "2026-07-23T10:00:00.090Z",
      toolId: "project.write",
      effects: ["write"],
      decision: "allow_once",
    }, signal);
    const transcript = appendCanonicalTranscript(undefined, "conversation-1", [
      {
        kind: "message",
        entryId: "user-1",
        runId: "run-settle",
        requestId: "request-settle",
        conversationId: "conversation-1",
        recordedAt: "2026-07-23T10:00:00.000Z",
        role: "user",
        content: [{ type: "text", text: "raw-secret-user-text" }],
      },
      {
        kind: "message",
        entryId: "assistant-1",
        runId: "run-settle",
        requestId: "request-settle",
        conversationId: "conversation-1",
        recordedAt: "2026-07-23T10:00:00.100Z",
        role: "assistant",
        route,
        content: [{ type: "text", text: "done" }],
      },
    ]);
    const response = Buffer.from('{"text":"cached answer"}', "utf8");
    const session = {
      id: "private-provider-session",
      conversationId: "conversation-1",
      route,
      createdAt: "2026-07-23T10:00:00.000Z",
      metadata: { revision: 1 },
    } as const;

    const summary = await journal.settle({
      runId: "run-settle",
      requestId: "request-settle",
      status: "completed",
      transcript,
      responseBytes: response,
      session: {
        value: session,
        updatedAt: "2026-07-23T10:00:00.100Z",
      },
      signal,
    });
    expect(summary).toMatchObject({
      status: "completed",
      attempts: [{ attempt: 1, status: "completed" }],
    });
    expect(summary.transcriptRevision).toMatch(/^r1:sha256:/u);

    const duplicate = await journal.admit({
      requestId: "request-settle",
      conversationId: "conversation-1",
      fingerprint,
      signal,
    });
    expect(duplicate).toMatchObject({ status: "cached", summary: { status: "completed" } });
    if (duplicate.status !== "cached" || duplicate.responseRef === undefined) {
      throw new Error("expected cached response");
    }
    await expect(journal.readCachedResponse(duplicate.responseRef, signal)).resolves.toEqual(
      new Uint8Array(response),
    );
    await expect(journal.loadTranscript("conversation-1", signal)).resolves.toEqual(transcript);
    await expect(journal.loadSession("conversation-1", route, signal)).resolves.toEqual({
      value: session,
      updatedAt: "2026-07-23T10:00:00.100Z",
    });
    await expect(journal.loadSession(
      "conversation-1",
      { runtimeInstanceId: "fallback", model: "provider:model" },
      signal,
    )).resolves.toBeUndefined();
    await expect(journal.evictSession(
      "conversation-1",
      route,
      {
        sessionId: "replaced-provider-session",
        updatedAt: "2026-07-23T10:00:00.100Z",
      },
      signal,
    )).resolves.toBe(false);
    await expect(journal.loadSession("conversation-1", route, signal)).resolves.toEqual({
      value: session,
      updatedAt: "2026-07-23T10:00:00.100Z",
    });
    state.conflictNextSessionDelete = true;
    await expect(journal.evictSession(
      "conversation-1",
      route,
      {
        sessionId: session.id,
        updatedAt: "2026-07-23T10:00:00.100Z",
      },
      signal,
    )).resolves.toBe(false);
    await expect(journal.loadSession("conversation-1", route, signal)).resolves.toEqual({
      value: session,
      updatedAt: "2026-07-23T10:00:00.100Z",
    });
    await expect(journal.evictSession(
      "conversation-1",
      route,
      {
        sessionId: session.id,
        updatedAt: "2026-07-23T10:00:00.100Z",
      },
      signal,
    )).resolves.toBe(true);
    await expect(journal.evictSession(
      "conversation-1",
      route,
      {
        sessionId: session.id,
        updatedAt: "2026-07-23T10:00:00.100Z",
      },
      signal,
    )).resolves.toBe(false);
    await expect(journal.readRun("run-settle", signal)).resolves.toMatchObject({
      summary: { status: "completed" },
      transcript: [{ kind: "message", role: "user" }, { kind: "message", role: "assistant" }],
      events: [
        { type: "admitted", sequence: 0 },
        { type: "attempt", sequence: 1, attempt: { status: "started" } },
        { type: "attempt", sequence: 2, attempt: { status: "completed" } },
        { type: "interaction", sequence: 3 },
        { type: "settled", sequence: 4 },
      ],
    });

    const stateRecords = [...state.records.entries()]
      .filter(([key]) => key.startsWith("core/runs/"))
      .map(([, record]) => Buffer.from(record.value).toString("utf8"))
      .join("\n");
    expect(stateRecords).not.toContain("raw-secret-user-text");
    expect(stateRecords).not.toContain("private-provider-session");
    expect(stateRecords).not.toContain("cached answer");
  });

  it("rejects numerically newer transcripts that truncate or rewrite settled history", async () => {
    const state = new MemoryStateStore();
    let run = 0;
    const journal = new DurableRunJournal(new ExecutionStore(state), {
      createRunId: () => `append-run-${String(++run)}`,
    });
    const firstFingerprint = createDurableFingerprint({ text: "original" });
    const firstAdmission = await journal.admit({
      requestId: "append-request-1",
      conversationId: "append-conversation",
      fingerprint: firstFingerprint,
      signal,
    });
    if (firstAdmission.status !== "accepted") throw new Error("expected first admission");
    const first = appendCanonicalTranscript(undefined, "append-conversation", [{
      kind: "message",
      entryId: "append-entry-1",
      runId: firstAdmission.summary.runId,
      requestId: "append-request-1",
      conversationId: "append-conversation",
      recordedAt: "2026-07-23T10:00:00.000Z",
      role: "user",
      content: [{ type: "text", text: "original" }],
    }]);
    await journal.settle({
      runId: firstAdmission.summary.runId,
      requestId: "append-request-1",
      status: "completed",
      transcript: first,
      responseBytes: Buffer.from("first", "utf8"),
      signal,
    });

    const secondAdmission = await journal.admit({
      requestId: "append-request-2",
      conversationId: "append-conversation",
      fingerprint: createDurableFingerprint({ text: "next" }),
      signal,
    });
    if (secondAdmission.status !== "accepted") throw new Error("expected second admission");
    await expect(journal.settle({
      runId: secondAdmission.summary.runId,
      requestId: "append-request-2",
      status: "completed",
      transcript: {
        schemaVersion: 1,
        kind: "mono-agent.canonical-transcript",
        conversationId: "append-conversation",
        revision: 2,
        entries: [],
      },
      responseBytes: Buffer.from("truncated", "utf8"),
      signal,
    })).rejects.toThrow(/cannot truncate/u);
    await expect(journal.settle({
      runId: secondAdmission.summary.runId,
      requestId: "append-request-2",
      status: "completed",
      transcript: {
        schemaVersion: 1,
        kind: "mono-agent.canonical-transcript",
        conversationId: "append-conversation",
        revision: 2,
        entries: [{
          kind: "message",
          entryId: "append-entry-1",
          runId: firstAdmission.summary.runId,
          requestId: "append-request-1",
          conversationId: "append-conversation",
          recordedAt: "2026-07-23T10:00:00.000Z",
          role: "user",
          content: [{ type: "text", text: "rewritten" }],
        }],
      },
      responseBytes: Buffer.from("rewritten", "utf8"),
      signal,
    })).rejects.toThrow(/cannot rewrite/u);
    await expect(journal.loadTranscript("append-conversation", signal)).resolves.toEqual(first);
    expect(state.records.has(artifactIntentStateKey(secondAdmission.summary.runId))).toBe(false);
  });

  it("leaves all durable authorities running when the settlement transaction fails", async () => {
    const state = new MemoryStateStore();
    const journal = new DurableRunJournal(new ExecutionStore(state), {
      createRunId: () => "run-atomic",
    });
    const fingerprint = createDurableFingerprint({ text: "hello" });
    await journal.admit({
      requestId: "request-atomic",
      conversationId: "conversation-atomic",
      fingerprint,
      signal,
    });
    const transcript = appendCanonicalTranscript(undefined, "conversation-atomic", []);
    state.failNextTransaction = true;
    await expect(journal.settle({
      runId: "run-atomic",
      requestId: "request-atomic",
      status: "completed",
      transcript,
      responseBytes: Buffer.from("response", "utf8"),
      session: {
        value: {
          id: "session-atomic",
          conversationId: "conversation-atomic",
          route,
        },
        updatedAt: new Date().toISOString(),
      },
      signal,
    })).rejects.toThrow(/injected transaction failure/u);
    await expect(journal.readRun("run-atomic", signal)).resolves.toMatchObject({
      summary: { status: "running" },
    });
    await expect(journal.loadTranscript("conversation-atomic", signal)).resolves.toBeUndefined();
    await expect(journal.loadSession("conversation-atomic", route, signal)).resolves.toBeUndefined();
    await expect(journal.admit({
      requestId: "request-atomic",
      conversationId: "conversation-atomic",
      fingerprint,
      signal,
    })).resolves.toMatchObject({ status: "join" });
  });

  it("stages content under a durable intent before publication and promotes it atomically", async () => {
    const state = new MemoryStateStore();
    const journal = new DurableRunJournal(new ExecutionStore(state), {
      createRunId: () => "run-artifacts",
    });
    const fingerprint = createDurableFingerprint({ text: "with attachment" });
    await journal.admit({
      requestId: "request-artifacts",
      conversationId: "conversation-artifacts",
      fingerprint,
      signal,
    });
    const staged = await journal.stageRunArtifacts({
      runId: "run-artifacts",
      requestId: "request-artifacts",
      artifacts: [{
        slot: "request:attachment:0",
        data: Buffer.from("attachment bytes", "utf8"),
        mediaType: "text/plain",
        fileName: "attachment.txt",
      }],
      signal,
    });
    expect(staged).toHaveLength(1);
    const attachment = staged[0];
    if (attachment === undefined) throw new Error("expected staged artifact");
    const intentKey = artifactIntentStateKey("run-artifacts");
    expect(state.records.has(intentKey)).toBe(true);
    expect(state.artifacts.has(attachment.ref.id)).toBe(true);
    await expect(journal.stageRunArtifacts({
      runId: "run-artifacts",
      requestId: "request-artifacts",
      artifacts: [{
        slot: "request:attachment:0",
        data: Buffer.from("rewritten bytes", "utf8"),
        mediaType: "text/plain",
        fileName: "attachment.txt",
      }],
      signal,
    })).rejects.toThrow(/cannot be rewritten/u);

    const transcript = appendCanonicalTranscript(undefined, "conversation-artifacts", [{
      kind: "message",
      entryId: "entry-artifacts",
      runId: "run-artifacts",
      requestId: "request-artifacts",
      conversationId: "conversation-artifacts",
      recordedAt: "2026-07-23T10:00:00.000Z",
      role: "user",
      content: [{ type: "artifact", ref: attachment.ref, name: "attachment.txt" }],
    }]);
    state.failTransactionAt = state.transactionCalls + 2;
    await expect(journal.settle({
      runId: "run-artifacts",
      requestId: "request-artifacts",
      status: "completed",
      transcript,
      responseBytes: Buffer.from("response", "utf8"),
      signal,
    })).rejects.toThrow(/injected transaction failure/u);
    await expect(journal.readRun("run-artifacts", signal)).resolves.toMatchObject({
      summary: { status: "running" },
    });
    expect(state.records.has(intentKey)).toBe(true);
    expect(state.artifacts.size).toBeGreaterThanOrEqual(3);

    await expect(journal.settle({
      runId: "run-artifacts",
      requestId: "request-artifacts",
      status: "completed",
      transcript,
      responseBytes: Buffer.from("response", "utf8"),
      signal,
    })).resolves.toMatchObject({ status: "completed" });
    expect(state.records.has(intentKey)).toBe(false);
    await expect(journal.loadTranscript("conversation-artifacts", signal)).resolves.toEqual(
      transcript,
    );
  });

  it("best-effort deletes an ambiguously published artifact before dropping its intent", async () => {
    const state = new CommitThenRejectState(false);
    const journal = new DurableRunJournal(new ExecutionStore(state), {
      createRunId: () => "run-ambiguous-cleaned",
    });
    await journal.admit({
      requestId: "request-ambiguous-cleaned",
      conversationId: "conversation-ambiguous-cleaned",
      fingerprint: createDurableFingerprint({ text: "ambiguous" }),
      signal,
    });

    await expect(journal.stageRunArtifacts({
      runId: "run-ambiguous-cleaned",
      requestId: "request-ambiguous-cleaned",
      artifacts: [{
        slot: "request:attachment:0",
        data: Buffer.from("committed before rejection", "utf8"),
        mediaType: "text/plain",
      }],
      signal,
    })).rejects.toThrow(/after artifact index commit/u);

    expect(state.artifacts.size).toBe(0);
    expect(state.records.has(artifactIntentStateKey("run-ambiguous-cleaned"))).toBe(false);
  });

  it("retains cleanup-pending authority when deletion cannot be proven across promotion", async () => {
    const state = new CommitThenRejectState(true);
    const journal = new DurableRunJournal(new ExecutionStore(state), {
      createRunId: () => "run-cleanup-pending",
    });
    await journal.admit({
      requestId: "request-cleanup-pending",
      conversationId: "conversation-cleanup-pending",
      fingerprint: createDurableFingerprint({ text: "cleanup pending" }),
      signal,
    });
    await expect(journal.stageRunArtifacts({
      runId: "run-cleanup-pending",
      requestId: "request-cleanup-pending",
      artifacts: [{
        slot: "request:ambiguous:0",
        data: Buffer.from("ambiguous orphan candidate", "utf8"),
        mediaType: "text/plain",
      }],
      signal,
    })).rejects.toThrow(/after artifact index commit/u);

    const staged = await journal.stageRunArtifacts({
      runId: "run-cleanup-pending",
      requestId: "request-cleanup-pending",
      artifacts: [{
        slot: "request:attachment:1",
        data: Buffer.from("promoted attachment", "utf8"),
        mediaType: "text/plain",
      }],
      signal,
    });
    const promoted = staged[0];
    if (promoted === undefined) throw new Error("expected promoted artifact");
    const transcript = appendCanonicalTranscript(
      undefined,
      "conversation-cleanup-pending",
      [{
        kind: "message",
        entryId: "cleanup-pending-entry",
        runId: "run-cleanup-pending",
        requestId: "request-cleanup-pending",
        conversationId: "conversation-cleanup-pending",
        recordedAt: "2026-07-23T10:00:00.000Z",
        role: "user",
        content: [{ type: "artifact", ref: promoted.ref }],
      }],
    );
    await journal.settle({
      runId: "run-cleanup-pending",
      requestId: "request-cleanup-pending",
      status: "completed",
      transcript,
      responseBytes: Buffer.from("complete", "utf8"),
      signal,
    });

    const intentKey = artifactIntentStateKey("run-cleanup-pending");
    expect(state.records.has(intentKey)).toBe(true);
    await expect(journal.reconcileArtifactPublications({
      limit: 1,
      signal,
    })).resolves.toMatchObject({
      examined: 1,
      deletedArtifacts: 0,
      pendingArtifacts: 1,
      skippedActive: 0,
    });
    expect(state.records.has(intentKey)).toBe(true);
    await expect(journal.reconcileArtifactPublications({
      limit: 0,
      signal,
    })).rejects.toThrow(/limit/u);
    await expect(journal.loadTranscript(
      "conversation-cleanup-pending",
      signal,
    )).resolves.toEqual(transcript);
  });

  it("never automatically resends unknown delivery outcomes", async () => {
    const state = new MemoryStateStore();
    let now = Date.parse("2026-07-23T10:00:00.000Z");
    const journal = new DurableRunJournal(new ExecutionStore(state), {
      clock: () => new Date(now),
      staleAfterMs: 1_000,
      createDeliveryToken: () => "delivery-token-1",
    });
    const fingerprint = createDurableFingerprint({ channel: "telegram", text: "hello" });
    const base = {
      idempotencyKey: "delivery-1",
      fingerprint,
      channelInstanceId: "telegram",
      signal,
    } as const;
    const first = await journal.prepareDelivery(base);
    expect(first).toEqual({
      status: "send",
      attempt: 1,
      token: "delivery-token-1",
    });
    if (first.status !== "send") throw new Error("expected a delivery send intent");
    await expect(journal.prepareDelivery(base)).resolves.toEqual({ status: "join" });
    await expect(journal.settleDelivery({
      idempotencyKey: "delivery-1",
      fingerprint,
      attempt: first.attempt,
      token: first.token,
      status: "unknown",
      code: "transport-timeout",
      signal,
    })).resolves.toEqual({ status: "unknown", code: "transport-timeout" });
    await expect(journal.prepareDelivery(base)).resolves.toEqual({
      status: "unknown",
      code: "transport-timeout",
    });

    const staleBase = { ...base, idempotencyKey: "delivery-stale" };
    await journal.prepareDelivery(staleBase);
    now += 1_001;
    await expect(journal.prepareDelivery(staleBase)).resolves.toEqual({
      status: "unknown",
      code: "stale-delivery-intent",
    });
    await expect(journal.prepareDelivery(staleBase)).resolves.toEqual({
      status: "unknown",
      code: "stale-delivery-intent",
    });
  });

  it("retries only known failures and caches confirmed receipts", async () => {
    let token = 0;
    const journal = new DurableRunJournal(new ExecutionStore(new MemoryStateStore()), {
      createDeliveryToken: () => `delivery-token-${String(++token)}`,
    });
    const fingerprint = createDurableFingerprint({ channel: "slack", text: "hello" });
    const intent = {
      idempotencyKey: "delivery-confirmed",
      fingerprint,
      channelInstanceId: "slack",
      signal,
    } as const;
    const first = await journal.prepareDelivery(intent);
    if (first.status !== "send") throw new Error("expected first delivery attempt");
    await expect(journal.settleDelivery({
      idempotencyKey: intent.idempotencyKey,
      fingerprint,
      attempt: first.attempt,
      token: first.token,
      status: "failed",
      code: "rejected-before-send",
      signal,
    })).resolves.toEqual({ status: "join" });
    const second = await journal.prepareDelivery(intent);
    expect(second).toEqual({
      status: "send",
      attempt: 2,
      token: "delivery-token-2",
    });
    if (second.status !== "send") throw new Error("expected second delivery attempt");
    await expect(journal.settleDelivery({
      idempotencyKey: intent.idempotencyKey,
      fingerprint,
      attempt: first.attempt,
      token: first.token,
      status: "delivered",
      messageId: "late-message",
      signal,
    })).resolves.toEqual({ status: "conflict" });
    await expect(journal.prepareDelivery(intent)).resolves.toEqual({ status: "join" });
    await expect(journal.settleDelivery({
      idempotencyKey: intent.idempotencyKey,
      fingerprint,
      attempt: second.attempt,
      token: second.token,
      status: "delivered",
      messageId: "message-1",
      signal,
    })).resolves.toEqual({ status: "duplicate", messageId: "message-1" });
    await expect(journal.prepareDelivery(intent)).resolves.toEqual({
      status: "duplicate",
      messageId: "message-1",
    });
    await expect(journal.prepareDelivery({
      ...intent,
      fingerprint: createDurableFingerprint({ channel: "slack", text: "different" }),
    })).resolves.toEqual({ status: "conflict" });
  });

  it("lists newest runs and leaves unsupported persisted schemas untouched", async () => {
    const state = new MemoryStateStore();
    let now = Date.parse("2026-07-23T10:00:00.000Z");
    let id = 0;
    const journal = new DurableRunJournal(new ExecutionStore(state), {
      clock: () => new Date(now),
      createRunId: () => `run-${String(++id)}`,
    });
    await journal.admit({
      requestId: "request-old",
      conversationId: "conversation",
      fingerprint: createDurableFingerprint({ text: "old" }),
      signal,
    });
    now += 1_000;
    await journal.admit({
      requestId: "request-new",
      conversationId: "conversation",
      fingerprint: createDurableFingerprint({ text: "new" }),
      signal,
    });
    await expect(journal.listRuns(undefined, signal)).resolves.toMatchObject({
      runs: [{ runId: "run-2" }, { runId: "run-1" }],
    });

    const unknownKey = admissionStateKey("unknown-request");
    const unknownBytes = Buffer.from('{"schemaVersion":99,"kind":"future"}', "utf8");
    await state.write({ key: unknownKey, value: unknownBytes, signal });
    await expect(journal.admit({
      requestId: "unknown-request",
      conversationId: "conversation",
      fingerprint: createDurableFingerprint({ text: "future" }),
      signal,
    })).rejects.toThrow(/unsupported schema/u);
    expect(state.records.get(unknownKey)?.value).toEqual(new Uint8Array(unknownBytes));
  });

  it("canonicalizes fingerprint key order, hashes bytes, and rejects active input", () => {
    expect(createDurableFingerprint({ b: 2, a: 1 })).toBe(
      createDurableFingerprint({ a: 1, b: 2 }),
    );
    const bytes = new TextEncoder().encode("credential-material");
    const bytesFingerprint = createDurableFingerprint({ bytes });
    expect(bytesFingerprint).not.toContain("credential-material");
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(createDurableFingerprint(bytes)).not.toBe(createDurableFingerprint({
      $bytes: bytes.byteLength,
      sha256: digest,
    }));

    const accessor = {};
    Object.defineProperty(accessor, "secret", { enumerable: true, get: () => "value" });
    expect(() => createDurableFingerprint(accessor)).toThrow(/own data property/u);

    const sparse = new Array(1);
    expect(() => createDurableFingerprint(sparse)).toThrow(/own data property/u);
  });
});

class CommitThenRejectState extends MemoryStateStore {
  #rejectNextPublication = true;

  constructor(private readonly refuseDeletion: boolean) {
    super();
  }

  override async putArtifact(
    request: Parameters<MemoryStateStore["putArtifact"]>[0],
  ): ReturnType<MemoryStateStore["putArtifact"]> {
    const ref = await super.putArtifact(request);
    if (this.#rejectNextPublication) {
      this.#rejectNextPublication = false;
      throw new Error("injected failure after artifact index commit");
    }
    return ref;
  }

  override async deleteArtifact(
    request: Parameters<MemoryStateStore["deleteArtifact"]>[0],
  ): Promise<boolean> {
    if (this.refuseDeletion) return false;
    return super.deleteArtifact(request);
  }
}

class SessionDeleteRaceState extends MemoryStateStore {
  conflictNextSessionDelete = false;

  override async transaction(
    request: Parameters<MemoryStateStore["transaction"]>[0],
  ): ReturnType<MemoryStateStore["transaction"]> {
    const sessionDelete = request.deletes.find((entry) =>
      entry.key.startsWith("core/sessions/"));
    if (this.conflictNextSessionDelete && sessionDelete !== undefined) {
      this.conflictNextSessionDelete = false;
      return {
        status: "conflict",
        conflicts: [{ key: sessionDelete.key }],
      };
    }
    return super.transaction(request);
  }
}
