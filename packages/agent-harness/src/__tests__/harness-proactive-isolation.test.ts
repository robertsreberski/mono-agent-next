import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";

import { createAgentHarness, createInMemoryHistoryStore } from "../index.js";
import type { AgentHarnessSessionOptions } from "../index.js";

const tempDirs: string[] = [];
const model = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function identityFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-proactive-"));
  tempDirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are Mono.", "utf8");
  return identityPath;
}

interface FakeRuntimeCall {
  readonly prompt: string;
  readonly options: RuntimeRunOptions;
}

function createSessionFakeRuntime(run: (prompt: string, options: RuntimeRunOptions, call: number) => Promise<RuntimeResult>) {
  const calls: FakeRuntimeCall[] = [];
  const disposedSessions: string[] = [];
  return {
    calls,
    disposedSessions,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        calls.push({ prompt, options });
        return await run(prompt, options, calls.length);
      },
      async disposeSession(providerSessionId: string): Promise<boolean> {
        disposedSessions.push(providerSessionId);
        return true;
      },
    },
  };
}

const session: AgentHarnessSessionOptions = { mode: "continuous", idleTimeoutMs: 60_000, supportsResume: true };
const isolatingSession: AgentHarnessSessionOptions = { ...session, isolateProactive: true };

const cronMetadata = { cron: { jobId: "nightly", expression: "0 3 * * *" } } as const;

function cronRequest(conversationId: string, userMessage = "cron tick") {
  return { conversationId, userMessage, abortSignal: new AbortController().signal, metadata: cronMetadata };
}

function request(conversationId: string, userMessage = "hello") {
  return { conversationId, userMessage, abortSignal: new AbortController().signal };
}

describe("AgentHarness proactive session isolation", () => {
  it("an isolated cron run neither resumes nor persists the shared session", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async () => ({ text: "answer", providerSessionId: "ps-cron" }));
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session: isolatingSession });
    const events: unknown[] = [];

    // First cron run: no session keys requested, no warm session derived.
    const response = await harness.run({ ...cronRequest("cron:nightly", "first"), onEvent: (event) => events.push(event) });
    expect(fake.calls[0]?.options.sessionId).toBeUndefined();
    expect(fake.calls[0]?.options.providerSessionId).toBeUndefined();
    expect(response.metadata.summary).toMatchObject({ isolated: true });
    expect(events).toContainEqual(expect.objectContaining({
      type: "session_boundary",
      kind: "isolated",
      conversationId: "cron:nightly",
      reason: "proactive",
    }));

    // Second cron run on the SAME conversation does NOT resume the prior turn —
    // the isolated run saved nothing, so it goes fresh again.
    await harness.run(cronRequest("cron:nightly", "second"));
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.options.sessionId).toBeUndefined();

    // The provider session each isolated turn opened is retired (not leaked).
    expect(fake.disposedSessions).toContain("ps-cron");
  });

  it("an isolated cron turn does not pollute a following interactive turn", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async (_p, _o, call) => ({ text: `answer-${call}`, providerSessionId: `ps-${call}` }));
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session: isolatingSession });

    // A cron turn runs ephemerally...
    await harness.run(cronRequest("telegram:morgan", "cron tick"));
    expect(fake.calls[0]?.options.sessionId).toBeUndefined();

    // ...then an interactive turn on the SAME conversation must start fresh (no
    // resume of the cron turn's session) because the cron turn saved nothing.
    await harness.run(request("telegram:morgan", "human message"));
    expect(fake.calls[1]?.options.sessionId).toBeUndefined();

    // But the interactive turn DOES warm the shared session — a subsequent
    // interactive turn resumes it, proving isolation only suppressed the cron turn.
    await harness.run(request("telegram:morgan", "follow-up"));
    expect(fake.calls[2]?.options.sessionId).toBe("ps-2");
  });

  it("with isolateProactive off, a cron request uses the shared session as before", async () => {
    const identityPath = await identityFixture();
    const fake = createSessionFakeRuntime(async () => ({ text: "answer", providerSessionId: "ps-shared" }));
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", session });

    await harness.run(cronRequest("cron:nightly", "first"));
    // First turn warms the session (keepalive requested, id captured).
    expect(fake.calls[0]?.options.sessionKeepAlive).toBe(true);

    // Second cron turn resumes the warm session — unchanged legacy behavior.
    await harness.run(cronRequest("cron:nightly", "second"));
    expect(fake.calls[1]?.options.sessionId).toBe("ps-shared");
  });

  it("with isolateProactive on, an interactive (non-cron) turn is byte-for-byte unchanged", async () => {
    const identityPath = await identityFixture();
    const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
    const fake = createSessionFakeRuntime(async () => ({ text: "answer", providerSessionId: "ps-1" }));
    const harness = createAgentHarness({
      identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session: isolatingSession,
    });

    await harness.run(request("telegram:morgan", "first"));
    expect(fake.calls[0]?.options.sessionKeepAlive).toBe(true);
    // Interactive turns still resume the warm session.
    await harness.run(request("telegram:morgan", "second"));
    expect(fake.calls[1]?.options.sessionId).toBe("ps-1");
    // Both interactive turns committed to history.
    const history = await historyStore.load("telegram:morgan");
    expect(history).toHaveLength(4);
  });
});
