import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { MemoryBlock, MemoryStore, MemoryWriteResult } from "@mono-agent/agent-contracts";
import type { HistoryMessage } from "../context/index.js";
import type { RunRecorder, RunSummary, RuntimeEventLike, RuntimeResultLike } from "@mono-agent/observability";
import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";

import {
  AgentHarnessError,
  createAgentHarness,
  createDurableHistoryStore,
  createInMemoryHistoryStore,
} from "../index.js";
import type { AgentHarnessSessionOptions, ConversationHistoryStore } from "../index.js";
import type { SkillsCache } from "../skills/index.js";

const tempDirs: string[] = [];
const model = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;
const HISTORY_MARKER = "EARLIER-HISTORY-MARKER";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function identityFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-sessions-"));
  tempDirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are Mono.", "utf8");
  return identityPath;
}

interface FakeRuntimeCall {
  readonly prompt: string;
  readonly options: RuntimeRunOptions;
}

function createSessionFakeRuntime(
  run: (prompt: string, options: RuntimeRunOptions, call: number) => Promise<RuntimeResult>,
  sync: (providerSessionId: string, call: number) => Promise<boolean | void> = async () => true,
) {
  const calls: FakeRuntimeCall[] = [];
  const refreshedSessions: string[] = [];
  const disposedSessions: string[] = [];
  const invalidatedSessions: string[] = [];
  const syncedSessions: string[] = [];
  let disposedAll = 0;
  return {
    calls,
    refreshedSessions,
    disposedSessions,
    invalidatedSessions,
    syncedSessions,
    disposedAllCount: () => disposedAll,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        calls.push({ prompt, options });
        return await run(prompt, options, calls.length);
      },
      async refreshSession(providerSessionId: string): Promise<void> {
        refreshedSessions.push(providerSessionId);
      },
      async disposeSession(providerSessionId: string): Promise<boolean> {
        disposedSessions.push(providerSessionId);
        return true;
      },
      async invalidateSession(providerSessionId: string): Promise<boolean> {
        invalidatedSessions.push(providerSessionId);
        return true;
      },
      async syncSession(providerSessionId: string): Promise<boolean> {
        syncedSessions.push(providerSessionId);
        return await sync(providerSessionId, syncedSessions.length) === true;
      },
      async disposeAllSessions(): Promise<void> {
        disposedAll += 1;
      },
    },
  };
}

const session: AgentHarnessSessionOptions = { mode: "continuous", idleTimeoutMs: 60_000, supportsResume: true };

async function primedHistoryStore(conversationId: string) {
  const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
  await historyStore.append(conversationId, [
    { role: "assistant", content: HISTORY_MARKER, timestamp: "2026-06-01T00:00:00Z" },
  ]);
  return historyStore;
}

function request(conversationId: string, userMessage = "hello") {
  return { conversationId, userMessage, abortSignal: new AbortController().signal };
}

function createCoordinatedDurableHistoryStore(
  options: Parameters<typeof createDurableHistoryStore>[0],
) {
  return createDurableHistoryStore({
    ...options,
    retireProviderSession: options.retireProviderSession ?? (async () => undefined),
  });
}

function createSpyHistoryStore() {
  const appended: HistoryMessage[] = [];
  const store: ConversationHistoryStore = {
    async load(): Promise<readonly HistoryMessage[]> {
      return [];
    },
    async append(_conversationId: string, messages: readonly HistoryMessage[]): Promise<void> {
      appended.push(...messages);
    },
  };
  return { appended, store };
}

function createSpyMemoryStore() {
  let hostSummaryCalls = 0;
  let captureCalls = 0;
  const store: MemoryStore = {
    async load(): Promise<MemoryBlock | undefined> {
      return undefined;
    },
    async appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult> {
      hostSummaryCalls += 1;
      return { conversationId, source: "spy", bytesWritten: summary.length };
    },
    scheduleCapture(): void {
      captureCalls += 1;
    },
  };
  return { store, hostSummaryCalls: () => hostSummaryCalls, captureCalls: () => captureCalls };
}

describe("AgentHarness continuous sessions", () => {
  it("first run goes fresh with history, second run resumes without history", async () => {
    const identityPath = await identityFixture();
    const historyStore = await primedHistoryStore("conv-1");
    const fake = createSessionFakeRuntime(async () => ({ text: "answer", providerSessionId: "ps-1" }));
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    const first = await harness.run(request("conv-1", "first question"));
    expect(first.text).toBe("answer");
    expect(fake.calls[0]?.options.sessionId).toBeUndefined();
    expect(fake.calls[0]?.options.sessionKeepAlive).toBe(true);
    expect(fake.calls[0]?.prompt).toContain(HISTORY_MARKER);

    const second = await harness.run(request("conv-1", "second question"));
    expect(second.text).toBe("answer");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.options.sessionId).toBe("ps-1");
    expect(fake.calls[1]?.options.providerSessionId).toBe("ps-1");
    expect(fake.calls[1]?.options.sessionKeepAlive).toBe(true);
    expect(fake.calls[1]?.prompt).not.toContain(HISTORY_MARKER);
  });

  it("does not read history for an ordinary confirmed warm resume", async () => {
    const identityPath = await identityFixture();
    let loads = 0;
    const historyStore: ConversationHistoryStore = {
      async load() {
        loads += 1;
        if (loads > 1) throw new Error("history backend unavailable");
        return [];
      },
      async append() {},
    };
    const fake = createSessionFakeRuntime(async () => ({ text: "answer", providerSessionId: "ps-warm" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      historyStore,
      session,
    });

    await expect(harness.run(request("conv-warm-load", "first"))).resolves.toMatchObject({ text: "answer" });
    await expect(harness.run(request("conv-warm-load", "second"))).resolves.toMatchObject({ text: "answer" });
    expect(loads).toBe(1);
    expect(fake.calls[1]?.options.sessionId).toBe("ps-warm");
  });

  it("retires the provider session when durable history publication fails", async () => {
    const identityPath = await identityFixture();
    let appendCalls = 0;
    const historyStore: ConversationHistoryStore = {
      async load() {
        return [{ role: "assistant", content: HISTORY_MARKER }];
      },
      async append() {
        appendCalls += 1;
        if (appendCalls === 1) throw new Error("injected durable history failure");
      },
    };
    const fake = createSessionFakeRuntime(async () => ({ text: "answer", providerSessionId: "ps-history" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      historyStore,
      session,
    });

    const failed = await harness.run(request("conv-history-failure", "first"));
    expect(failed.failure?.message).toContain("injected durable history failure");
    expect(fake.invalidatedSessions).toContain("ps-history");

    const recovered = await harness.run(request("conv-history-failure", "second"));
    expect(recovered.text).toBe("answer");
    expect(fake.calls[1]?.options.sessionId).toBeUndefined();
    expect(fake.calls[1]?.prompt).toContain(HISTORY_MARKER);
  });

  it("invalidates a warm provider session when recorder preparation fails before history commit", async () => {
    const identityPath = await identityFixture();
    const historyStore = createInMemoryHistoryStore({ maxMessages: 20 });
    const fake = createSessionFakeRuntime(async (_prompt, _options, call) => ({
      text: `answer-${call}`,
      providerSessionId: call < 3 ? "ps-warm" : "ps-fresh",
    }));
    let recorderRun = 0;
    const recorderFactory = (input: { readonly runId: string; readonly conversationId: string }): RunRecorder => {
      recorderRun += 1;
      const currentRun = recorderRun;
      const summary = (status: RunSummary["status"]): RunSummary => ({
        runId: input.runId,
        conversationId: input.conversationId,
        status,
        durationMs: 1,
        eventCount: 0,
        artifactPaths: [],
      });
      return {
        onEvent() {},
        async prepareFinish() {
          if (currentRun === 2) throw new Error("recorder prepare unavailable");
        },
        async finish() { return summary("succeeded"); },
        async fail() { return summary("failed"); },
      };
    };
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      historyStore,
      session,
      recorderFactory,
    });

    await expect(harness.run(request("conv-recorder-prepare", "first"))).resolves.toMatchObject({ text: "answer-1" });
    const failed = await harness.run(request("conv-recorder-prepare", "second"));
    expect(failed.failure?.message).toContain("recorder prepare unavailable");
    expect(fake.calls[1]?.options.sessionId).toBe("ps-warm");
    expect(fake.invalidatedSessions).toContain("ps-warm");

    await expect(harness.run(request("conv-recorder-prepare", "third"))).resolves.toMatchObject({ text: "answer-3" });
    expect(fake.calls[2]?.options.sessionId).toBeUndefined();
  });

  it("invalidates a warm provider session when continuation context admission fails before history commit", async () => {
    const identityPath = await identityFixture();
    const historyStore = createInMemoryHistoryStore({ maxMessages: 20 });
    const fake = createSessionFakeRuntime(async (_prompt, _options, call) => ({
      text: `answer-${call}`,
      providerSessionId: call < 3 ? "ps-continuation" : "ps-fresh",
    }));
    let requiresCalls = 0;
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      historyStore,
      session,
      runtimeOptions: { mcpServers: { control: { command: "a8c-control" } } },
      continuationContext: {
        serverNames: ["control"],
        capabilityIssuer: {
          issueContinuationClaimCapability() {
            return {
              url: "http://127.0.0.1:43125/continuations/claim",
              token: "session-regression-token",
              fingerprint: "session-regression-fingerprint",
              mode: "reply" as const,
              async requiresOriginContext() {
                requiresCalls += 1;
                if (requiresCalls === 2) throw new Error("continuation store unavailable");
                return false;
              },
              async finalizeOriginContext() {},
              async activateOriginContext() {},
              async abandonOriginContext() {},
              async release() {},
            };
          },
        },
      },
    });
    const continuationRequest = (message: string) => ({
      ...request("conv-continuation-admission", message),
      replyTo: { conversationId: "slack:C1:T1" },
    });

    await expect(harness.run(continuationRequest("first"))).resolves.toMatchObject({ text: "answer-1" });
    const failed = await harness.run(continuationRequest("second"));
    expect(failed.failure?.message).toContain("continuation store unavailable");
    expect(fake.calls[1]?.options.sessionId).toBe("ps-continuation");
    expect(fake.invalidatedSessions).toContain("ps-continuation");

    await expect(harness.run(continuationRequest("third"))).resolves.toMatchObject({ text: "answer-3" });
    expect(fake.calls[2]?.options.sessionId).toBeUndefined();
  });

  it("releases an acquired session when boundary event callbacks throw before runtime", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async () => ({ text: "answer", providerSessionId: "ps-1" }));
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(request("conv-boundary", "first"));
    const failed = await harness.run({
      ...request("conv-boundary", "second"),
      sessionBoundary: {
        type: "session_boundary",
        kind: "rollover",
        conversationId: "conv-boundary",
        previousConversationId: "conv-boundary#old",
      },
      onEvent: () => {
        throw new Error("stream callback failed");
      },
    });
    await harness.run(request("conv-boundary", "third"));

    expect(failed.failure?.kind).toBe("Error");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.options.sessionId).toBe("ps-1");
  });

  it("carries recalled memory on the user message of every turn, including the resumed turn", async () => {
    const identityPath = await identityFixture();
    const memory: MemoryStore = {
      async load(): Promise<MemoryBlock | undefined> {
        return { kind: "markdown", content: "## Memory (recalled)\n- [ ] launch checklist", source: "spy", truncated: false };
      },
      async appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult> {
        return { conversationId, source: "spy", bytesWritten: summary.length };
      },
    };
    const fake = createSessionFakeRuntime(async () => ({ text: "answer", providerSessionId: "ps-1" }));
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", memory, session });

    await harness.run(request("conv-mem", "first question"));
    await harness.run(request("conv-mem", "second question"));

    // Turn 2 resumes the warm session...
    expect(fake.calls[1]?.options.sessionId).toBe("ps-1");
    // ...yet recalled memory still reaches the model on BOTH turns because it
    // rides on the user message, not the system prompt (which a resume may drop).
    expect(String(fake.calls[0]?.options.messages?.[0]?.content)).toContain("launch checklist");
    expect(String(fake.calls[1]?.options.messages?.[0]?.content)).toContain("launch checklist");
    // And it is NOT in the system prompt on either turn.
    expect(fake.calls[0]?.prompt).not.toContain("launch checklist");
    expect(fake.calls[1]?.prompt).not.toContain("launch checklist");
  });

  it("uses a history-owned epoch id and supplies canonical history structurally on cold durable reopen", async () => {
    const identityPath = await identityFixture();
    const durableRoot = await mkdtemp(join(tmpdir(), "agent-harness-durable-history-"));
    tempDirs.push(durableRoot);
    const historyStore = createCoordinatedDurableHistoryStore({ root: join(durableRoot, "history") });
    await historyStore.append("conv-d", [
      { role: "assistant", content: HISTORY_MARKER, timestamp: "2026-06-01T00:00:00Z" },
    ]);
    const piSessionsRoot = join(durableRoot, "pi-sessions");
    const fake = createSessionFakeRuntime(async (_prompt, options) => ({
      text: "answer",
      providerSessionId: options.sessionId as string,
    }));
    const harness = createAgentHarness({
      identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session,
      piSessionsRoot,
    });

    const first = await harness.run(request("conv-d", "first question"));
    expect(first.text).toBe("answer");
    // The durable history record, not a bare conversation hash, owns the epoch id.
    expect(typeof fake.calls[0]?.options.sessionId).toBe("string");
    expect((fake.calls[0]?.options.sessionId as string).length).toBeGreaterThan(0);
    const legacyConversationOnlyId = createHash("sha256").update("conv-d").digest("hex").slice(0, 32);
    expect(fake.calls[0]?.options.sessionId).not.toBe(legacyConversationOnlyId);
    expect(fake.calls[0]?.options.piSessionsRoot).toBe(piSessionsRoot);
    // A cold durable reopen keeps canonical history out of the system prompt and
    // supplies it as leading structured messages. Pi can then seed create-on-miss
    // while skipping the leading messages for a true durable resume.
    expect(fake.calls[0]?.prompt).not.toContain(HISTORY_MARKER);
    expect(fake.calls[0]?.options.messages).toEqual([
      { role: "assistant", content: HISTORY_MARKER, timestamp: "2026-06-01T00:00:00Z" },
      { role: "user", content: "first question" },
    ]);
    expect(fake.syncedSessions).toEqual([fake.calls[0]?.options.sessionId]);

    // Once the exact clean epoch is live, the warm optimization omits history.
    const second = await harness.run(request("conv-d", "second question"));
    expect(fake.calls[1]?.options.sessionId).toBe(fake.calls[0]?.options.sessionId);
    expect(fake.calls[1]?.prompt).not.toContain(HISTORY_MARKER);
    expect(fake.calls[1]?.options.messages).toEqual([
      { role: "user", content: "second question" },
    ]);
    expect(fake.syncedSessions).toEqual([
      fake.calls[0]?.options.sessionId,
      fake.calls[0]?.options.sessionId,
    ]);
  });

  it("cold-reopens a stale local Pi handle after another harness advances the durable transcript", async () => {
    const identityPath = await identityFixture();
    const root = await mkdtemp(join(tmpdir(), "agent-harness-cross-process-revision-"));
    tempDirs.push(root);
    const historyRoot = join(root, "history");
    const piSessionsRoot = join(root, "pi");
    const fakeA = createSessionFakeRuntime(async (_prompt, options, call) => ({
      text: call === 1 ? "answer-from-a1" : "answer-from-a2",
      providerSessionId: options.sessionId as string,
    }));
    const fakeB = createSessionFakeRuntime(async (_prompt, options) => ({
      text: "answer-from-b",
      providerSessionId: options.sessionId as string,
    }));
    const harnessA = createAgentHarness({
      identityPath,
      runtime: fakeA.runtime,
      model,
      executionMode: "sdk",
      historyStore: createCoordinatedDurableHistoryStore({ root: historyRoot }),
      session,
      piSessionsRoot,
    });
    const harnessB = createAgentHarness({
      identityPath,
      runtime: fakeB.runtime,
      model,
      executionMode: "sdk",
      historyStore: createCoordinatedDurableHistoryStore({ root: historyRoot }),
      session,
      piSessionsRoot,
    });

    await harnessA.run(request("conv-shared", "question-a1"));
    const durableId = fakeA.calls[0]?.options.sessionId as string;
    await harnessB.run(request("conv-shared", "question-b"));
    expect(fakeB.calls[0]?.options.sessionId).toBe(durableId);

    await harnessA.run(request("conv-shared", "question-a2"));
    expect(fakeA.calls[1]?.options.sessionId).toBe(durableId);
    expect(fakeA.refreshedSessions).toEqual([durableId, durableId]);
    expect(fakeA.calls[1]?.prompt).not.toContain("question-b");
    expect(fakeA.calls[1]?.prompt).not.toContain("answer-from-b");
    expect(fakeA.calls[1]?.options.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "question-b" }),
      expect.objectContaining({ role: "assistant", content: "answer-from-b" }),
    ]));
  });

  it("cold-reopens a shared provider handle when a reloaded harness has no local session mapping", async () => {
    const identityPath = await identityFixture();
    const root = await mkdtemp(join(tmpdir(), "agent-harness-reloaded-revision-"));
    tempDirs.push(root);
    const historyRoot = join(root, "history");
    const piSessionsRoot = join(root, "pi");
    const fakeA = createSessionFakeRuntime(async (_prompt, options, call) => ({
      text: call === 1 ? "answer-from-a1" : "answer-from-reloaded-a",
      providerSessionId: options.sessionId as string,
    }));
    const fakeB = createSessionFakeRuntime(async (_prompt, options) => ({
      text: "answer-from-b",
      providerSessionId: options.sessionId as string,
    }));
    const harnessA = createAgentHarness({
      identityPath,
      runtime: fakeA.runtime,
      model,
      executionMode: "sdk",
      historyStore: createCoordinatedDurableHistoryStore({ root: historyRoot }),
      session,
      piSessionsRoot,
    });

    await harnessA.run(request("conv-reloaded", "question-a1"));
    const durableId = fakeA.calls[0]?.options.sessionId as string;
    const harnessB = createAgentHarness({
      identityPath,
      runtime: fakeB.runtime,
      model,
      executionMode: "sdk",
      historyStore: createCoordinatedDurableHistoryStore({ root: historyRoot }),
      session,
      piSessionsRoot,
    });
    await harnessB.run(request("conv-reloaded", "question-b"));

    // A newly constructed harness has an empty local RuntimeSessionStore, but
    // it shares fakeA's process-level provider registry. The durable revision
    // barrier must still refresh that registry before resuming the epoch.
    const reloadedHarnessA = createAgentHarness({
      identityPath,
      runtime: fakeA.runtime,
      model,
      executionMode: "sdk",
      historyStore: createCoordinatedDurableHistoryStore({ root: historyRoot }),
      session,
      piSessionsRoot,
    });
    await reloadedHarnessA.run(request("conv-reloaded", "question-a2"));

    expect(fakeA.calls[1]?.options.sessionId).toBe(durableId);
    expect(fakeA.refreshedSessions).toEqual([durableId, durableId]);
    expect(fakeA.calls[1]?.prompt).not.toContain("question-b");
    expect(fakeA.calls[1]?.prompt).not.toContain("answer-from-b");
    expect(fakeA.calls[1]?.options.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: "question-b" }),
      expect.objectContaining({ role: "assistant", content: "answer-from-b" }),
    ]));
  });

  it("keeps a custom history store process-local even when extensions try to force durable Pi state", async () => {
    const identityPath = await identityFixture();
    const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
    const fake = createSessionFakeRuntime(async () => ({ text: "answer", providerSessionId: "warm-only" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      historyStore,
      session,
      piSessionsRoot: "/tmp/configured-root",
      runtimeOptionsForRequest: () => ({
        runtimeOptions: {
          piSessionsRoot: "/tmp/extension-root",
          sessionId: "extension-session",
          providerSessionId: "extension-provider",
        } as never,
      }),
    });

    await harness.run(request("conv-custom-history"));
    expect(fake.calls[0]?.options.piSessionsRoot).toBeUndefined();
    expect(fake.calls[0]?.options.sessionId).toBeUndefined();
    expect(fake.calls[0]?.options.providerSessionId).toBeUndefined();
    expect(fake.calls[0]?.options.sessionKeepAlive).toBe(true);

    await harness.run(request("conv-custom-history", "again"));
    expect(fake.calls[1]?.options.sessionId).toBe("warm-only");
    expect(fake.calls[1]?.options.piSessionsRoot).toBeUndefined();
  });

  it("commits canonical history but rotates the durable epoch when provider transcript sync is not acknowledged", async () => {
    const identityPath = await identityFixture();
    const root = await mkdtemp(join(tmpdir(), "agent-harness-sync-failure-"));
    tempDirs.push(root);
    const historyStore = createCoordinatedDurableHistoryStore({ root: join(root, "history") });
    const fake = createSessionFakeRuntime(
      async (_prompt, options) => ({ text: "canonical answer", providerSessionId: options.sessionId as string }),
      async () => false,
    );
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      historyStore,
      session,
      piSessionsRoot: join(root, "pi"),
    });

    const first = await harness.run(request("conv-sync-failure", "first question"));
    expect(first.text).toBe("canonical answer");
    const firstId = fake.calls[0]?.options.sessionId;
    expect(typeof firstId).toBe("string");
    expect(fake.invalidatedSessions).toContain(firstId);
    expect((await historyStore.load("conv-sync-failure")).map((message) => message.content)).toEqual([
      "first question",
      "canonical answer",
    ]);

    const second = await harness.run(request("conv-sync-failure", "second question"));
    expect(second.text).toBe("canonical answer");
    expect(fake.calls[1]?.options.sessionId).not.toBe(firstId);
    expect(fake.calls[1]?.prompt).not.toContain("first question");
    expect(fake.calls[1]?.prompt).not.toContain("canonical answer");
    expect(fake.calls[1]?.options.messages).toEqual([
      expect.objectContaining({ role: "user", content: "first question" }),
      expect.objectContaining({ role: "assistant", content: "canonical answer" }),
      { role: "user", content: "second question" },
    ]);
  });

  it.each(["failure result", "throw"] as const)(
    "leaves the durable provider epoch dirty and invalidates it after a %s",
    async (outcome) => {
      const identityPath = await identityFixture();
      const root = await mkdtemp(join(tmpdir(), "agent-harness-dirty-provider-"));
      tempDirs.push(root);
      const historyStore = createCoordinatedDurableHistoryStore({ root: join(root, "history") });
      const fake = createSessionFakeRuntime(async (_prompt, options) => {
        if (outcome === "throw") throw new Error("provider transport died");
        return {
          failureKind: "provider_unavailable",
          error: "provider failed after admission",
          providerSessionId: options.sessionId as string,
        };
      });
      const harness = createAgentHarness({
        identityPath,
        runtime: fake.runtime,
        model,
        executionMode: "sdk",
        historyStore,
        session,
        piSessionsRoot: join(root, "pi"),
      });

      const failed = await harness.run(request("conv-dirty-provider", "question"));
      expect(failed.failure).toBeDefined();
      const failedId = fake.calls[0]?.options.sessionId;
      expect(typeof failedId).toBe("string");
      expect(fake.invalidatedSessions).toContain(failedId);
      expect(fake.syncedSessions).toEqual([]);
      expect(await historyStore.load("conv-dirty-provider")).toEqual([]);

      const next = await historyStore.beginProviderSessionTurn("conv-dirty-provider", "next-run");
      expect(next.providerSessionId).not.toBe(failedId);
      await next.abort();
    },
  );

  it("rotates the durable provider epoch after appendVerbatimTurn adds host-only history", async () => {
    const identityPath = await identityFixture();
    const root = await mkdtemp(join(tmpdir(), "agent-harness-verbatim-epoch-"));
    tempDirs.push(root);
    const historyStore = createCoordinatedDurableHistoryStore({ root: join(root, "history") });
    const fake = createSessionFakeRuntime(async (_prompt, options) => ({
      text: "answer",
      providerSessionId: options.sessionId as string,
    }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      historyStore,
      session,
      piSessionsRoot: join(root, "pi"),
    });

    await harness.run(request("conv-verbatim", "first"));
    const firstId = fake.calls[0]?.options.sessionId;
    await harness.appendVerbatimTurn?.("conv-verbatim", "Scheduled delivery.", { idempotencyKey: "delivery:one" });
    await harness.run(request("conv-verbatim", "follow-up"));

    expect(fake.calls[1]?.options.sessionId).not.toBe(firstId);
    expect(fake.calls[1]?.prompt).not.toContain("Scheduled delivery.");
    expect(fake.calls[1]?.options.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: "Scheduled delivery." }),
    ]));
  });

  it("tracks provider session id rotation", async () => {
    const identityPath = await identityFixture();
    const ids = ["ps-1", "ps-2", "ps-3"];
    const fake = createSessionFakeRuntime(async (_p, _o, call) => ({ text: "ok", providerSessionId: ids[call - 1] ?? null }));
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(request("conv-1"));
    await harness.run(request("conv-1"));
    await harness.run(request("conv-1"));
    expect(fake.calls[1]?.options.sessionId).toBe("ps-1");
    expect(fake.calls[2]?.options.sessionId).toBe("ps-2");
    // Rotation retires the superseded provider session.
    expect(fake.disposedSessions).toEqual(["ps-1", "ps-2"]);
  });

  it("retries once with history when the resumed session is stale", async () => {
    const identityPath = await identityFixture();
    const historyStore = await primedHistoryStore("conv-1");
    const events: RuntimeEventLike[] = [];
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        return { failureKind: "session_not_found", error: "session expired" };
      }
      return { text: "recovered", providerSessionId: "ps-next" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    const first = await harness.run(request("conv-1"));
    expect(first.text).toBe("recovered");

    const second = await harness.run({ ...request("conv-1", "again"), onEvent: (event) => events.push(event) });
    expect(second.text).toBe("recovered");
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[1]?.options.sessionId).toBe("ps-next");
    expect(fake.calls[2]?.options.sessionId).toBeUndefined();
    expect(fake.calls[2]?.prompt).toContain(HISTORY_MARKER);
    expect(fake.disposedSessions).toContain("ps-next");
    expect(events).toContainEqual(expect.objectContaining({
      type: "session_boundary",
      kind: "resume_replay",
      conversationId: "conv-1",
      providerSessionId: "ps-next",
      reason: "runtime_result",
    }));
  });

  it("retries once with history when a resumed attempt throws a structured session miss", async () => {
    const identityPath = await identityFixture();
    const historyStore = await primedHistoryStore("conv-1");
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        throw new AgentHarnessError("session_not_found", "session expired");
      }
      return { text: "recovered", providerSessionId: "ps-next" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    const first = await harness.run(request("conv-1"));
    expect(first.text).toBe("recovered");

    const second = await harness.run(request("conv-1", "again"));
    expect(second.text).toBe("recovered");
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[1]?.options.sessionId).toBe("ps-next");
    expect(fake.calls[2]?.options.sessionId).toBeUndefined();
    expect(fake.calls[2]?.prompt).toContain(HISTORY_MARKER);
    expect(fake.disposedSessions).toContain("ps-next");
  });

  it("retries once with history when the resumed session is busy", async () => {
    const identityPath = await identityFixture();
    const historyStore = await primedHistoryStore("conv-1");
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        return { failureKind: "session_busy", error: "session is busy" };
      }
      return { text: "recovered", providerSessionId: "ps-next" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    await harness.run(request("conv-1"));
    const second = await harness.run(request("conv-1", "again"));
    expect(second.text).toBe("recovered");
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[1]?.options.sessionId).toBe("ps-next");
    expect(fake.calls[2]?.options.sessionId).toBeUndefined();
    expect(fake.calls[2]?.prompt).toContain(HISTORY_MARKER);
    expect(fake.disposedSessions).toContain("ps-next");
  });

  it("does not retry and invalidates a resumed provider attempt that throws without session failure details", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        throw new Error("transport died");
      }
      return { text: "recovered", providerSessionId: "ps-next" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(request("conv-1"));
    const second = await harness.run(request("conv-1"));
    expect(second.failure).toMatchObject({ kind: "Error", message: "transport died" });
    expect(fake.calls).toHaveLength(2);
    expect(fake.invalidatedSessions).toContain("ps-next");
    expect(fake.disposedSessions).toContain("ps-next");
  });

  it("does not retry cancelled resumed runs", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        return { cancelled: true };
      }
      return { text: "ok", providerSessionId: "ps-1" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(request("conv-1"));
    const second = await harness.run(request("conv-1"));
    expect(second.failure).toMatchObject({ kind: "cancelled" });
    expect(fake.calls).toHaveLength(2);
  });

  it("never passes session keys when resume is unsupported", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async () => ({ text: "ok", providerSessionId: "ps-1" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      session: { ...session, supportsResume: false },
    });

    await harness.run(request("conv-1"));
    await harness.run(request("conv-1"));
    for (const call of fake.calls) {
      expect(call.options.sessionId).toBeUndefined();
      expect(call.options.sessionKeepAlive).toBeUndefined();
    }
  });

  it("strips static and request-scoped provider-session keys when sessions are disabled", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async () => ({ text: "ok", providerSessionId: "unexpected" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      runtimeOptions: {
        piSessionsRoot: "/tmp/static-root",
        sessionKeepAlive: true,
        sessionIdleTimeoutMs: 1234,
        sessionId: "static-session",
        providerSessionId: "static-provider",
      } as never,
      runtimeOptionsForRequest: () => ({
        runtimeOptions: {
          piSessionsRoot: "/tmp/request-root",
          sessionKeepAlive: true,
          sessionIdleTimeoutMs: 5678,
          sessionId: "request-session",
          providerSessionId: "request-provider",
        } as never,
      }),
    });

    await harness.run(request("conv-no-sessions"));
    expect(fake.calls[0]?.options.piSessionsRoot).toBeUndefined();
    expect(fake.calls[0]?.options.sessionKeepAlive).toBeUndefined();
    expect(fake.calls[0]?.options.sessionIdleTimeoutMs).toBeUndefined();
    expect(fake.calls[0]?.options.sessionId).toBeUndefined();
    expect(fake.calls[0]?.options.providerSessionId).toBeUndefined();
  });

  it("never passes session keys in per-message mode", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async () => ({ text: "ok", providerSessionId: "ps-1" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      session: { mode: "per-message", idleTimeoutMs: 60_000, supportsResume: true },
    });

    await harness.run(request("conv-1"));
    await harness.run(request("conv-1"));
    for (const call of fake.calls) {
      expect(call.options.sessionId).toBeUndefined();
      expect(call.options.sessionKeepAlive).toBeUndefined();
    }
  });

  it("still appends history on resumed successful turns", async () => {
    const identityPath = await identityFixture();
    const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
    const fake = createSessionFakeRuntime(async () => ({ text: "answer", providerSessionId: "ps-1" }));
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    await harness.run(request("conv-1", "first"));
    await harness.run(request("conv-1", "second"));
    const history = await historyStore.load("conv-1");
    expect(history).toHaveLength(4);
    expect(history.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("resets one conversation's history and warm session while clearing the skills cache", async () => {
    const identityPath = await identityFixture();
    const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
    const fake = createSessionFakeRuntime(async () => ({ text: "answer", providerSessionId: "ps-reset" }));
    let cacheClears = 0;
    const skillsCache: SkillsCache = {
      loadSelectedSkillsCached: async () => ({ index: [], instructions: [], loaded: [] }),
      clear: () => { cacheClears += 1; },
    };
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      historyStore,
      skillsCache,
      session,
    });
    await harness.run(request("telegram:42", "old"));
    await historyStore.append("telegram:99", [{ role: "assistant", content: "keep" }]);

    await harness.resetConversation?.("telegram:42");

    await expect(historyStore.load("telegram:42")).resolves.toEqual([]);
    await expect(historyStore.load("telegram:99")).resolves.toEqual([{ role: "assistant", content: "keep" }]);
    expect(fake.disposedSessions).toContain("ps-reset");
    expect(cacheClears).toBe(1);
  });

  it("rejects an unsupported history reset before evicting the warm session", async () => {
    const identityPath = await identityFixture();
    const backingStore = createInMemoryHistoryStore({ maxMessages: 10 });
    const historyStore: ConversationHistoryStore = {
      load: (conversationId) => backingStore.load(conversationId),
      append: (conversationId, messages) => backingStore.append(conversationId, messages),
    };
    const fake = createSessionFakeRuntime(async () => ({ text: "answer", providerSessionId: "ps-preserved" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      historyStore,
      session,
    });
    await harness.run(request("telegram:42", "old"));

    await expect(harness.resetConversation?.("telegram:42"))
      .rejects.toThrow("does not support session reset");

    expect(fake.disposedSessions).toEqual([]);
    await expect(historyStore.load("telegram:42")).resolves.toHaveLength(2);
  });

  it("a concurrent second run goes fresh instead of resuming a busy session", async () => {
    const identityPath = await identityFixture();
    const historyStore = await primedHistoryStore("conv-1");
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fake = createSessionFakeRuntime(async (_prompt, _options, call) => {
      if (call === 2) {
        await firstGate;
      }
      return { text: `answer-${call}`, providerSessionId: "ps-1" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    await harness.run(request("conv-1", "seed"));
    const inFlight = harness.run(request("conv-1", "long"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const concurrent = await harness.run(request("conv-1", "while busy"));
    expect(fake.calls[2]?.options.sessionId).toBeUndefined();
    expect(fake.calls[2]?.prompt).toContain(HISTORY_MARKER);
    expect(concurrent.text).toBe("answer-3");
    releaseFirst?.();
    await inFlight;
  });

  it("dispose retires this harness's tracked sessions without touching the process-global registries", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async () => ({ text: "ok", providerSessionId: "ps-1" }));
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(request("conv-1"));
    await harness.dispose?.();
    expect(fake.disposedSessions).toContain("ps-1");
    // Other harnesses may share the provider registries; dispose must stay
    // scoped to this harness's conversations.
    expect(fake.disposedAllCount()).toBe(0);

    // After dispose the next run starts fresh.
    await harness.run(request("conv-1"));
    expect(fake.calls[1]?.options.sessionId).toBeUndefined();
  });

  it("the stale retry keeps sessionKeepAlive and the idle timeout so a fresh provider session is captured", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        return { failureKind: "session_not_found", error: "gone" };
      }
      return { text: "ok", providerSessionId: "ps-1" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(request("conv-1"));
    await harness.run(request("conv-1"));
    const retryCall = fake.calls[2];
    expect(retryCall?.options.sessionId).toBeUndefined();
    expect(retryCall?.options.sessionKeepAlive).toBe(true);
    expect(retryCall?.options.sessionIdleTimeoutMs).toBe(60_000);
  });

  it("retries exactly once even when the retry also fails", async () => {
    const identityPath = await identityFixture();
    let seeded = false;
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (!seeded) {
        seeded = true;
        return { text: "ok", providerSessionId: "ps-1" };
      }
      return options.sessionId !== undefined
        ? { failureKind: "session_not_found", error: "gone" }
        : { failureKind: "provider_unavailable", error: "still down" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(request("conv-1"));
    const second = await harness.run(request("conv-1"));
    expect(second.failure).toMatchObject({ kind: "provider_unavailable" });
    expect(fake.calls).toHaveLength(3);
  });

  it("does not replay history for non-session provider failures during resume", async () => {
    const identityPath = await identityFixture();
    const historyStore = await primedHistoryStore("conv-1");
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        return { failureKind: "provider_unavailable", error: "stream disconnected" };
      }
      return { text: "ok", providerSessionId: "ps-1" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    await harness.run(request("conv-1"));
    const second = await harness.run(request("conv-1", "again"));
    expect(second.failure).toMatchObject({ kind: "provider_unavailable", message: "stream disconnected" });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.options.sessionId).toBe("ps-1");
    expect(fake.calls[1]?.prompt).not.toContain(HISTORY_MARKER);
    expect(fake.disposedSessions).toContain("ps-1");

    const third = await harness.run(request("conv-1", "after failure"));
    expect(third.text).toBe("ok");
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2]?.options.sessionId).toBeUndefined();
    expect(fake.calls[2]?.prompt).toContain(HISTORY_MARKER);
  });

  it("does not replay history for an error-only resumed result without a session failure kind", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        return { error: "thread evaporated" };
      }
      return { text: "ok", providerSessionId: "ps-1" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(request("conv-1"));
    const second = await harness.run(request("conv-1"));
    expect(second.failure).toMatchObject({ kind: "runtime_error", message: "thread evaporated" });
    expect(fake.calls).toHaveLength(2);
  });

  it("an empty resumed turn retires the session so the next message replays history", async () => {
    const identityPath = await identityFixture();
    const historyStore = await primedHistoryStore("conv-1");
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        return { text: "   ", providerSessionId: options.sessionId as string };
      }
      return { text: "ok", providerSessionId: "ps-1" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    await harness.run(request("conv-1"));
    const second = await harness.run(request("conv-1"));
    expect(second.failure).toMatchObject({ kind: "empty_response" });
    expect(fake.disposedSessions).toContain("ps-1");
    const third = await harness.run(request("conv-1"));
    expect(third.text).toBe("ok");
    expect(fake.calls[2]?.options.sessionId).toBeUndefined();
    expect(fake.calls[2]?.prompt).toContain(HISTORY_MARKER);
  });

  it("request extensions cannot clobber the harness session keys", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async () => ({ text: "ok", providerSessionId: "ps-1" }));
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      session,
      runtimeOptionsForRequest: () => ({
        runtimeOptions: { sessionId: "hijacked", sessionKeepAlive: false } as Record<string, unknown>,
      }),
    });

    await harness.run(request("conv-1"));
    expect(fake.calls[0]?.options.sessionId).toBeUndefined();
    expect(fake.calls[0]?.options.sessionKeepAlive).toBe(true);
    await harness.run(request("conv-1"));
    expect(fake.calls[1]?.options.sessionId).toBe("ps-1");
  });

  it("emits a session_resume_retry warning on stale retry", async () => {
    const identityPath = await identityFixture();
    const events: unknown[] = [];
    const fake = createSessionFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        return { failureKind: "session_not_found", error: "gone" };
      }
      return { text: "ok", providerSessionId: "ps-1" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(request("conv-1"));
    await harness.run({ ...request("conv-1"), onEvent: (event) => events.push(event) });
    expect(events).toContainEqual(expect.objectContaining({
      type: "runtime_warning",
      warning_kind: "session_resume_retry",
      provider_session_id: "ps-1",
    }));
  });

  it("does not commit a cancelled turn that returns success after a mid-turn abort (F3)", async () => {
    const identityPath = await identityFixture();
    const history = createSpyHistoryStore();
    const memory = createSpyMemoryStore();
    const controller = new AbortController();
    // The runtime ignores the abort and returns a success-shaped result, but the
    // live-session cancel signal landed mid-turn — request.abortSignal is aborted
    // by the time runRuntime() resolves. This is the TOCTOU race F3 guards.
    const fake = createSessionFakeRuntime(async () => {
      controller.abort(new Error("cancelled mid-turn"));
      return { text: "done", providerSessionId: "ps-x" };
    });
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      session,
      historyStore: history.store,
      memory: memory.store,
      memoryWriteMode: "capture",
    });

    const response = await harness.run({ conversationId: "conv-1", userMessage: "hello", abortSignal: controller.signal });

    // The response is a cancelled failure, not a committed success.
    expect(response.text).toBeUndefined();
    expect(response.failure?.kind).toBe("cancelled");
    // No history committed for the cancelled turn.
    expect(history.appended).toHaveLength(0);
    // No memory written for the cancelled turn.
    expect(memory.hostSummaryCalls()).toBe(0);
    expect(memory.captureCalls()).toBe(0);
    // The returned provider session was invalidated, so the next message replays
    // history into a fresh session rather than resuming a cancelled-turn session.
    expect(fake.invalidatedSessions).toContain("ps-x");
  });

  it("does not retain a cancelled turn's warm session for the next turn (F3)", async () => {
    const identityPath = await identityFixture();
    const historyStore = await primedHistoryStore("conv-1");
    let runCount = 0;
    // Turn 1 establishes a warm session (ps-1). Turn 2 resumes it, but aborts
    // mid-turn while returning success — the cancelled turn must retire ps-1 so
    // turn 3 goes fresh (no resume of a session diverged from history).
    const abortOnSecond = new AbortController();
    const fake = createSessionFakeRuntime(async (_prompt, _options, call) => {
      runCount = call;
      if (call === 2) {
        abortOnSecond.abort(new Error("cancelled mid-turn"));
        return { text: "ignored", providerSessionId: "ps-1" };
      }
      return { text: "answer", providerSessionId: "ps-1" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    await harness.run(request("conv-1", "first"));
    expect(fake.calls[0]?.options.sessionId).toBeUndefined();

    const cancelled = await harness.run({ conversationId: "conv-1", userMessage: "second", abortSignal: abortOnSecond.signal });
    expect(cancelled.failure?.kind).toBe("cancelled");
    // ps-1 was retired (evicted) on the cancelled turn.
    expect(fake.disposedSessions).toContain("ps-1");

    // Turn 3 must go fresh (no sessionId) and replay history.
    await harness.run(request("conv-1", "third"));
    expect(runCount).toBe(3);
    expect(fake.calls[2]?.options.sessionId).toBeUndefined();
    expect(fake.calls[2]?.prompt).toContain(HISTORY_MARKER);
  });

  it("does not commit a turn cancelled DURING recorder.prepareFinish() after runRuntime succeeds (R9)", async () => {
    const identityPath = await identityFixture();
    const history = createSpyHistoryStore();
    const memory = createSpyMemoryStore();
    const controller = new AbortController();
    // The runtime returns success cleanly (no abort during the run). The abort
    // is injected LATER, inside recorder.prepareFinish() — simulating a live-session
    // cancel landing during the post-runtime commit path (after the line-221
    // guard, while the non-terminal prepare phase yields). The
    // pre-commit recheck (R9) must catch it before saveSession/persist.
    const fake = createSessionFakeRuntime(async () => ({ text: "done", providerSessionId: "ps-x" }));
    // A recorder whose prepareFinish() aborts the request before resolving — the abort
    // lands AFTER runRuntime returned but BEFORE the commit.
    const recorderFactory = (input: { readonly runId: string; readonly conversationId: string }): RunRecorder => {
      const startedAt = Date.now();
      const summary = (status: RunSummary["status"], result: RuntimeResultLike): RunSummary => ({
        runId: input.runId,
        conversationId: input.conversationId,
        status,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(result.providerSessionId === undefined ? {} : { providerSessionId: result.providerSessionId }),
        eventCount: 0,
        artifactPaths: [],
      });
      return {
        onEvent(_event: RuntimeEventLike): void {},
        async start(): Promise<RunSummary> {
          return summary("running", {});
        },
        async prepareFinish(): Promise<void> {
          // Simulate pre-terminal filesystem setup yielding: flip the abort
          // before resolving so the pre-commit recheck sees it.
          controller.abort(new Error("cancelled during prepare"));
          await Promise.resolve();
        },
        async finish(result: RuntimeResultLike): Promise<RunSummary> {
          return summary(result.cancelled === true ? "cancelled" : "succeeded", result);
        },
        async fail(): Promise<RunSummary> {
          return summary("failed", {});
        },
      };
    };
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      session,
      historyStore: history.store,
      memory: memory.store,
      memoryWriteMode: "capture",
      recorderFactory,
    });

    const response = await harness.run({ conversationId: "conv-1", userMessage: "hello", abortSignal: controller.signal });

    // The response is a cancelled failure, not a committed success.
    expect(response.text).toBeUndefined();
    expect(response.failure?.kind).toBe("cancelled");
    // No history committed for the cancelled turn.
    expect(history.appended).toHaveLength(0);
    // No memory written for the cancelled turn.
    expect(memory.hostSummaryCalls()).toBe(0);
    expect(memory.captureCalls()).toBe(0);
    // The provider session returned by the (successful) run was invalidated, so the
    // next turn replays history into a fresh session.
    expect(fake.invalidatedSessions).toContain("ps-x");
  });

  it("rejects the caller and persists nothing when cancel() lands during prepareFinish() on a continuous harness (R9 e2e)", async () => {
    const identityPath = await identityFixture();
    const history = createSpyHistoryStore();
    const memory = createSpyMemoryStore();
    // finishGate lets the test release recorder.prepareFinish() only after it has
    // observed the active turn, so cancel() and finish() are deterministically
    // ordered: prepareFinish() begins (signalling finishStarted), the test cancels,
    // then releases finishGate so finish() resolves.
    let signalFinishStarted!: () => void;
    const finishStartedSignal = new Promise<void>((resolve) => { signalFinishStarted = resolve; });
    let releaseFinish!: () => void;
    const finishGate = new Promise<void>((resolve) => { releaseFinish = resolve; });
    const fake = createSessionFakeRuntime(async () => ({ text: "done", providerSessionId: "ps-e2e" }));
    const recorderFactory = (input: { readonly runId: string; readonly conversationId: string }): RunRecorder => {
      const startedAt = Date.now();
      const summary = (status: RunSummary["status"], result: RuntimeResultLike): RunSummary => ({
        runId: input.runId,
        conversationId: input.conversationId,
        status,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(result.providerSessionId === undefined ? {} : { providerSessionId: result.providerSessionId }),
        eventCount: 0,
        artifactPaths: [],
      });
      return {
        onEvent(): void {},
        async start(): Promise<RunSummary> { return summary("running", {}); },
        async prepareFinish(): Promise<void> {
          signalFinishStarted();
          await finishGate;
        },
        async finish(result: RuntimeResultLike): Promise<RunSummary> {
          return summary(result.cancelled === true ? "cancelled" : "succeeded", result);
        },
        async fail(): Promise<RunSummary> { return summary("failed", {}); },
      };
    };
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      session,
      historyStore: history.store,
      memory: memory.store,
      memoryWriteMode: "capture",
      recorderFactory,
    });

    const caller = harness.submit!({ conversationId: "conv-e2e", userMessage: "hello", abortSignal: new AbortController().signal });
    // Once finish() is in flight, cancel the conversation — this aborts the
    // active turn's request signal, which the pre-commit recheck must observe.
    await finishStartedSignal;
    harness.cancel!("conv-e2e");
    releaseFinish();

    // The caller promise rejects (cancelled), agreeing with the no-persist path.
    await expect(caller).rejects.toMatchObject({ name: "AgentResponseCancelledError" });
    expect(history.appended).toHaveLength(0);
    expect(memory.hostSummaryCalls()).toBe(0);
    expect(memory.captureCalls()).toBe(0);
    expect(fake.invalidatedSessions).toContain("ps-e2e");
  });
});
