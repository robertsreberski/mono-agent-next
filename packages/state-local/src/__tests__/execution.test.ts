import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedStateLocalConfig } from "../config.js";
import { acquireProcessLease } from "../secure-fs.js";
import { StateLocalStore } from "../store.js";

const OLD = "2026-07-20T12:00:00.000Z";
const NOW = "2026-07-23T12:00:00.000Z";
const roots: string[] = [];
const signal = new AbortController().signal;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) =>
      rm(root, { recursive: true, force: true })),
  );
});

describe("state-local execution ownership", () => {
  it("owns the opaque protocol and proactive conversation representation", async () => {
    const store = await open(await createConfig(), () => new Date(NOW));
    expect(await perform<{
      readonly protocol: string;
      readonly version: number;
      readonly operations: readonly string[];
    }>(store, "protocol.describe")).toMatchObject({
      protocol: "mono-agent.state-execution",
      version: 1,
    });

    const opened = await perform<ConversationView>(store, "conversation.open", {
      title: "Daily report",
      initialText: "The report is ready.",
      metadata: { trigger: "cron" },
    });
    expect(opened.conversationId).toMatch(/^proactive:/u);
    expect(opened.createdAt).toBe(NOW);
    expect(opened.updatedAt).toBe(NOW);
    expect(opened.title).toBe("Daily report");
    expect(opened.metadata).toEqual({ trigger: "cron" });
    expect(opened.transcript).toMatchObject({
      schemaVersion: 1,
      kind: "mono-agent.canonical-transcript",
      conversationId: opened.conversationId,
      revision: 1,
    });
    expect(opened.transcript.entries).toEqual([expect.objectContaining({
      kind: "verbatim",
      role: "assistant",
      text: "The report is ready.",
    })]);

    await expect(perform<ConversationView>(store, "conversation.load", {
      conversationId: opened.conversationId,
    })).resolves.toEqual(opened);
    const listed = await perform<{
      readonly conversations: readonly {
        readonly conversationId: string;
        readonly createdAt: string;
        readonly updatedAt: string;
        readonly title?: string;
      }[];
    }>(store, "conversation.list");
    expect(listed.conversations).toEqual([{
      conversationId: opened.conversationId,
      createdAt: NOW,
      updatedAt: NOW,
      title: "Daily report",
      metadata: { trigger: "cron" },
    }]);

    const appended = await perform<CanonicalTranscript>(
      store,
      "transcript.append",
      {
        current: opened.transcript,
        conversationId: opened.conversationId,
        entries: [{
          kind: "verbatim",
          entryId: "entry-2",
          runId: "run-2",
          requestId: "request-2",
          conversationId: opened.conversationId,
          recordedAt: NOW,
          role: "user",
          text: "Thanks",
        }],
      },
    );
    expect(appended.revision).toBe(2);
    expect(appended.entries).toHaveLength(2);

    let getterInvoked = false;
    const hostile = {};
    Object.defineProperty(hostile, "cursor", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return "cursor";
      },
    });
    await expect(store.execution.perform({
      operation: "run.list",
      input: hostile,
      signal,
    })).rejects.toThrow(/own data property/u);
    expect(getterInvoked).toBe(false);
    await expect(store.execution.perform({
      operation: "not-supported",
      signal,
    })).rejects.toThrow(/unsupported/u);
    await store.close();
  });

  it("atomically persists a Core-limit proactive seed as restart-safe transcript chunks", async () => {
    const config = await createConfig();
    const initialText = "🙂".repeat((1024 * 1024) / 4);
    expect(Buffer.byteLength(initialText, "utf8")).toBe(1024 * 1024);
    const first = await open(config, () => new Date(NOW));
    const opened = await perform<ConversationView>(first, "conversation.open", {
      title: "Near-limit seed",
      initialText,
    });
    const initialChunks = await first.scan({
      prefix: "core/conversation-chunks/",
      limit: 100,
      signal,
    });
    expect(initialChunks.records.length).toBeGreaterThan(1);
    expect(initialChunks.records.every((record) =>
      record.value.byteLength <= 256 * 1024)).toBe(true);
    await first.close();

    const second = await open(config, () => new Date(NOW));
    const reloaded = await perform<ConversationView>(second, "conversation.load", {
      conversationId: opened.conversationId,
    });
    expect(reloaded.transcript.entries).toEqual([expect.objectContaining({
      kind: "verbatim",
      role: "assistant",
      text: initialText,
    })]);

    const fingerprint = await perform<string>(second, "fingerprint.create", {
      request: "continue-near-limit-seed",
    });
    await perform(second, "run.admit", {
      requestId: "continue-near-limit-seed",
      conversationId: opened.conversationId,
      fingerprint,
      runId: "near-limit-run",
    });
    const settledTranscript = await perform<CanonicalTranscript>(
      second,
      "transcript.append",
      {
        current: reloaded.transcript,
        conversationId: opened.conversationId,
        entries: [{
          kind: "verbatim",
          entryId: "near-limit-assistant",
          runId: "near-limit-run",
          requestId: "continue-near-limit-seed",
          conversationId: opened.conversationId,
          recordedAt: NOW,
          role: "assistant",
          text: "continued",
        }],
      },
    );
    await perform(second, "run.settle", {
      runId: "near-limit-run",
      requestId: "continue-near-limit-seed",
      status: "completed",
      transcript: settledTranscript,
      responseBytes: Buffer.from('{"status":"ok"}', "utf8"),
    });
    expect((await second.scan({
      prefix: "core/conversation-chunks/",
      limit: 100,
      signal,
    })).records).toHaveLength(0);
    await second.close();

    const third = await open(config, () => new Date(NOW));
    const settledReload = await perform<ConversationView>(third, "conversation.load", {
      conversationId: opened.conversationId,
    });
    expect(settledReload.transcript.entries).toEqual([
      expect.objectContaining({ text: initialText }),
      expect.objectContaining({ text: "continued" }),
    ]);
    await third.close();
  });

  it("recovers all chunks after an uncertain commit and none after a pre-commit crash", async () => {
    const initialText = "x".repeat(1024 * 1024);
    const committedConfig = await createConfig();
    let crashAfterCommit = true;
    const uncertain = await StateLocalStore.open(committedConfig, {
      instanceId: "execution-open-uncertain-test",
      signal,
      clock: () => new Date(NOW),
      hooks: {
        snapshot: {
          afterRename: () => {
            if (!crashAfterCommit) return;
            crashAfterCommit = false;
            throw new Error("simulated crash after conversation commit");
          },
        },
      },
    });
    await expect(perform(uncertain, "conversation.open", { initialText }))
      .rejects.toMatchObject({ code: "STATE_POISONED" });
    await uncertain.close();

    const recovered = await open(committedConfig, () => new Date(NOW));
    const recoveredList = await perform<{
      readonly conversations: readonly { readonly conversationId: string }[];
    }>(recovered, "conversation.list");
    expect(recoveredList.conversations).toHaveLength(1);
    const recoveredConversation = await perform<ConversationView>(
      recovered,
      "conversation.load",
      { conversationId: recoveredList.conversations[0]!.conversationId },
    );
    expect(recoveredConversation.transcript.entries).toEqual([
      expect.objectContaining({ text: initialText }),
    ]);
    expect((await recovered.scan({
      prefix: "core/conversation-chunks/",
      limit: 100,
      signal,
    })).records.length).toBeGreaterThan(1);
    await recovered.close();

    const rejectedConfig = await createConfig();
    let crashBeforeCommit = true;
    const rejected = await StateLocalStore.open(rejectedConfig, {
      instanceId: "execution-open-rejected-test",
      signal,
      clock: () => new Date(NOW),
      hooks: {
        snapshot: {
          beforeRename: () => {
            if (!crashBeforeCommit) return;
            crashBeforeCommit = false;
            throw new Error("simulated crash before conversation commit");
          },
        },
      },
    });
    await expect(perform(rejected, "conversation.open", { initialText }))
      .rejects.toMatchObject({ code: "STATE_POISONED" });
    await rejected.close();

    const clean = await open(rejectedConfig, () => new Date(NOW));
    expect(await perform(clean, "conversation.list")).toEqual({
      conversations: [],
    });
    expect((await clean.scan({
      prefix: "core/conversation-chunks/",
      limit: 100,
      signal,
    })).records).toHaveLength(0);
    await clean.close();
  });

  it("records complete runs and crash-resumes terminal retention without touching running work", async () => {
    const config = await createConfig();
    let now = OLD;
    let crashRelease = true;
    const store = await StateLocalStore.open(config, {
      instanceId: "execution-retention-test",
      signal,
      clock: () => new Date(now),
      hooks: {
        artifacts: {
          afterOrphanClaim: () => {
            if (!crashRelease) return;
            crashRelease = false;
            throw new Error("crash during published release");
          },
        },
      },
    });
    const conversationId = "conversation-1";
    const route = { runtimeInstanceId: "runtime-1", model: "model-1" };
    const fingerprint = await perform<string>(store, "fingerprint.create", {
      request: "terminal",
    });
    const admitted = await perform<AdmissionResult>(store, "run.admit", {
      requestId: "request-terminal",
      conversationId,
      fingerprint,
      runId: "run-terminal",
    });
    expect(admitted.status).toBe("accepted");

    await perform(store, "run.record-attempt", {
      runId: "run-terminal",
      attempt: {
        attempt: 1,
        route,
        status: "completed",
        startedAt: OLD,
        endedAt: OLD,
      },
    });
    const transcript = await perform<CanonicalTranscript>(
      store,
      "transcript.append",
      {
        conversationId,
        entries: [
          {
            kind: "verbatim",
            entryId: "terminal-user",
            runId: "run-terminal",
            requestId: "request-terminal",
            conversationId,
            recordedAt: OLD,
            role: "user",
            text: "hello",
          },
          {
            kind: "verbatim",
            entryId: "terminal-assistant",
            runId: "run-terminal",
            requestId: "request-terminal",
            conversationId,
            recordedAt: OLD,
            role: "assistant",
            text: "world",
          },
        ],
      },
    );
    const responseBytes = Buffer.from('{"status":"ok"}', "utf8");
    await perform(store, "run.settle", {
      runId: "run-terminal",
      requestId: "request-terminal",
      status: "completed",
      transcript,
      responseBytes,
      session: {
        value: {
          id: "session-1",
          conversationId,
          route,
          createdAt: OLD,
        },
        updatedAt: OLD,
      },
    });
    expect(await perform(store, "session.load", {
      conversationId,
      route,
    })).toMatchObject({ value: { id: "session-1" }, updatedAt: OLD });

    const cached = await perform<AdmissionResult>(store, "run.admit", {
      requestId: "request-terminal",
      conversationId,
      fingerprint,
    });
    if (cached.status !== "cached" || cached.responseRef === undefined) {
      throw new Error("Expected a cached terminal admission with a response ref.");
    }
    expect(await store.deleteArtifact({ ref: cached.responseRef, signal })).toBe(false);

    const deliveryFingerprint = await perform<string>(
      store,
      "fingerprint.create",
      { delivery: "one" },
    );
    const delivery = await perform<DeliveryResult>(store, "delivery.prepare", {
      idempotencyKey: "delivery-1",
      fingerprint: deliveryFingerprint,
      channelInstanceId: "channel-1",
      runId: "run-terminal",
    });
    if (delivery.status !== "send") throw new Error("Expected a delivery send intent.");
    await perform(store, "delivery.settle", {
      idempotencyKey: "delivery-1",
      fingerprint: deliveryFingerprint,
      attempt: delivery.attempt,
      token: delivery.token,
      status: "delivered",
      messageId: "message-1",
    });

    const runningFingerprint = await perform<string>(
      store,
      "fingerprint.create",
      { request: "running" },
    );
    await perform(store, "run.admit", {
      requestId: "request-running",
      conversationId,
      fingerprint: runningFingerprint,
      runId: "run-running",
    });
    const staged = await perform<readonly {
      readonly slot: string;
      readonly ref: ArtifactRefLike;
    }[]>(store, "run.stage-artifacts", {
      runId: "run-running",
      requestId: "request-running",
      artifacts: [{
        slot: "live-output",
        data: Buffer.from("still referenced by a running intent", "utf8"),
        mediaType: "text/plain",
      }],
    });
    expect(staged).toHaveLength(1);

    now = NOW;
    const first = await store.maintain({ limit: 100, signal });
    expect(first).toMatchObject({
      terminalRunCandidates: 1,
      terminalRunsRemoved: 0,
      terminalDeliveryCandidates: 0,
      terminalDeliveriesRemoved: 0,
      staleSessionsRemoved: 1,
      pendingRunRetentionCheckpoints: 1,
    });
    expect(await perform(store, "run.read", { runId: "run-terminal" })).toBeUndefined();
    const second = await store.maintain({ limit: 100, signal });
    expect(second.runEventsRemoved).toBe(3);
    const third = await store.maintain({ limit: 100, signal });
    expect(third).toMatchObject({
      terminalRunsRemoved: 1,
      terminalAdmissionsRemoved: 1,
      pendingRunRetentionCheckpoints: 1,
    });
    await expect(store.maintain({ limit: 100, signal }))
      .rejects.toThrow("crash during published release");
    await store.close();

    const reopened = await open(config, () => new Date(NOW));
    const resumed = await reopened.maintain({ limit: 100, signal });
    expect(resumed).toMatchObject({
      publishedArtifactsReleased: 1,
      pendingRunRetentionCheckpoints: 1,
    });
    await expect(reopened.readArtifact({
      ref: cached.responseRef,
      maxBytes: responseBytes.byteLength,
      signal,
    })).rejects.toMatchObject({ code: "STATE_ARTIFACT_NOT_FOUND" });
    expect(await perform(reopened, "run.read", { runId: "run-terminal" })).toBeUndefined();
    expect(await perform(reopened, "session.load", {
      conversationId,
      route,
    })).toBeUndefined();
    expect(await perform<RunRecord>(reopened, "run.read", {
      runId: "run-running",
    })).toMatchObject({ summary: { status: "running" } });
    expect(await perform<{
      readonly runs: readonly { readonly runId: string }[];
    }>(reopened, "run.list")).toMatchObject({
      runs: [{ runId: "run-running" }],
    });
    expect(await perform(reopened, "conversation.load", {
      conversationId,
    })).toMatchObject({
      transcript: { entries: expect.arrayContaining([
        expect.objectContaining({ text: "world" }),
      ]) },
    });
    expect(await perform(reopened, "artifact-publications.reconcile", {
      limit: 10,
    })).toMatchObject({
      skippedActive: 1,
      deletedArtifacts: 0,
    });
    expect(await reopened.deleteArtifact({ ref: staged[0]!.ref, signal })).toBe(false);
    expect((await reopened.listArtifacts({ limit: 10, signal })).artifacts)
      .toHaveLength(2);
    await reopened.close();
  });

  it("preserves delivered and unknown idempotency authority across retention and restart", async () => {
    const config = await createConfig();
    let now = OLD;
    const store = await open(config, () => new Date(now));
    const deliveredFingerprint = await perform<string>(
      store,
      "fingerprint.create",
      { destination: "delivered" },
    );
    const unknownFingerprint = await perform<string>(
      store,
      "fingerprint.create",
      { destination: "unknown" },
    );
    const delivered = await perform<DeliveryResult>(store, "delivery.prepare", {
      idempotencyKey: "retained-delivered",
      fingerprint: deliveredFingerprint,
      channelInstanceId: "channel-1",
    });
    const unknown = await perform<DeliveryResult>(store, "delivery.prepare", {
      idempotencyKey: "retained-unknown",
      fingerprint: unknownFingerprint,
      channelInstanceId: "channel-1",
    });
    if (delivered.status !== "send" || unknown.status !== "send") {
      throw new Error("Expected fresh delivery intents.");
    }
    await perform(store, "delivery.settle", {
      idempotencyKey: "retained-delivered",
      fingerprint: deliveredFingerprint,
      attempt: delivered.attempt,
      token: delivered.token,
      status: "delivered",
      messageId: "message-1",
    });
    await perform(store, "delivery.settle", {
      idempotencyKey: "retained-unknown",
      fingerprint: unknownFingerprint,
      attempt: unknown.attempt,
      token: unknown.token,
      status: "unknown",
      code: "transport-outcome-unknown",
    });

    now = NOW;
    await expect(store.maintain({ limit: 100, signal })).resolves.toMatchObject({
      terminalDeliveryCandidates: 0,
      terminalDeliveriesRemoved: 0,
    });
    await store.close();

    const reopened = await open(config, () => new Date(NOW));
    await expect(perform(reopened, "delivery.prepare", {
      idempotencyKey: "retained-delivered",
      fingerprint: deliveredFingerprint,
      channelInstanceId: "channel-1",
    })).resolves.toEqual({ status: "duplicate", messageId: "message-1" });
    await expect(perform(reopened, "delivery.prepare", {
      idempotencyKey: "retained-unknown",
      fingerprint: unknownFingerprint,
      channelInstanceId: "channel-1",
    })).resolves.toEqual({
      status: "unknown",
      code: "transport-outcome-unknown",
    });
    const conflictingFingerprint = await perform<string>(
      reopened,
      "fingerprint.create",
      { destination: "different" },
    );
    await expect(perform(reopened, "delivery.prepare", {
      idempotencyKey: "retained-delivered",
      fingerprint: conflictingFingerprint,
      channelInstanceId: "channel-1",
    })).resolves.toEqual({ status: "conflict" });
    await reopened.close();
  });

  it("never grants private release authority to a legacy published artifact row", async () => {
    const config = await createConfig();
    const writer = await open(config, () => new Date(OLD));
    const conversationId = "legacy-conversation";
    const fingerprint = await perform<string>(writer, "fingerprint.create", {
      request: "legacy",
    });
    await perform(writer, "run.admit", {
      requestId: "legacy-request",
      conversationId,
      fingerprint,
      runId: "legacy-run",
    });
    const transcript = await perform<CanonicalTranscript>(
      writer,
      "transcript.append",
      {
        conversationId,
        entries: [{
          kind: "verbatim",
          entryId: "legacy-entry",
          runId: "legacy-run",
          requestId: "legacy-request",
          conversationId,
          recordedAt: OLD,
          role: "assistant",
          text: "legacy",
        }],
      },
    );
    const responseBytes = Buffer.from("legacy response", "utf8");
    await perform(writer, "run.settle", {
      runId: "legacy-run",
      requestId: "legacy-request",
      status: "completed",
      transcript,
      responseBytes,
    });
    const cached = await perform<AdmissionResult>(writer, "run.admit", {
      requestId: "legacy-request",
      conversationId,
      fingerprint,
    });
    if (cached.status !== "cached" || cached.responseRef === undefined) {
      throw new Error("Expected a cached legacy response reference.");
    }
    await writer.close();

    const artifactDirectory = config.runs?.artifactsDirectory;
    if (artifactDirectory === undefined) throw new Error("Expected an artifact directory.");
    const lease = await acquireProcessLease(
      join(artifactDirectory, ".mono-agent-artifacts.lease.sqlite"),
    );
    try {
      const digest = cached.responseRef.sha256.slice("sha256:".length);
      const key = `artifact:${digest}`;
      const encoded = lease.readIndex(key, 2_048);
      if (encoded === undefined) throw new Error("Expected a v2 artifact index row.");
      const current = JSON.parse(encoded.toString("utf8")) as {
        readonly storageName?: unknown;
      };
      if (typeof current.storageName !== "string") {
        throw new Error("Expected a v2 artifact storage name.");
      }
      lease.writeIndex(
        key,
        Buffer.from(`${JSON.stringify({
          digest,
          sizeBytes: responseBytes.byteLength,
          storageName: current.storageName,
        })}\n`, "utf8"),
      );
    } finally {
      await lease.release();
    }

    const retained = await open(config, () => new Date(NOW));
    await retained.maintain({ limit: 100, signal });
    await retained.maintain({ limit: 100, signal });
    await retained.maintain({ limit: 100, signal });
    const releasePass = await retained.maintain({ limit: 100, signal });
    expect(releasePass).toMatchObject({
      publishedArtifactsReleased: 0,
      pendingRunRetentionCheckpoints: 1,
    });
    expect(Buffer.from(await retained.readArtifact({
      ref: cached.responseRef,
      maxBytes: responseBytes.byteLength,
      signal,
    }))).toEqual(responseBytes);
    await retained.close();
  });
});

interface ArtifactRefLike {
  readonly id: string;
  readonly sha256: `sha256:${string}`;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly fileName?: string;
}

interface CanonicalTranscript {
  readonly schemaVersion: 1;
  readonly kind: "mono-agent.canonical-transcript";
  readonly conversationId: string;
  readonly revision: number;
  readonly entries: readonly Record<string, unknown>[];
}

interface ConversationView {
  readonly conversationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly transcript: CanonicalTranscript;
  readonly title?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

type AdmissionResult =
  | { readonly status: "accepted"; readonly summary: { readonly runId: string } }
  | {
      readonly status: "cached";
      readonly responseRef?: ArtifactRefLike;
    }
  | { readonly status: "join" | "conflict" | "uncertain" };

type DeliveryResult =
  | {
      readonly status: "send";
      readonly attempt: number;
      readonly token: string;
    }
  | {
      readonly status: "join" | "duplicate" | "conflict" | "unknown";
    };

interface RunRecord {
  readonly summary: {
    readonly status: string;
  };
}

async function perform<T = unknown>(
  store: StateLocalStore,
  operation: string,
  input?: unknown,
): Promise<T> {
  return await store.execution.perform({
    operation,
    ...(input === undefined ? {} : { input }),
    signal,
  }) as T;
}

async function createConfig(): Promise<ResolvedStateLocalConfig> {
  const parent = await mkdtemp(join(tmpdir(), "mono-agent-state-execution-"));
  roots.push(parent);
  const root = join(parent, "state");
  return {
    root,
    maxRecordBytes: 1024 * 1024,
    maxRecords: 10_000,
    maxTotalBytes: 64 * 1024 * 1024,
    runs: {
      artifactsDirectory: join(root, "artifacts"),
      retentionDays: 1,
    },
  };
}

function open(
  config: ResolvedStateLocalConfig,
  clock: () => Date,
): Promise<StateLocalStore> {
  return StateLocalStore.open(config, {
    instanceId: "execution-test",
    signal,
    clock,
  });
}
