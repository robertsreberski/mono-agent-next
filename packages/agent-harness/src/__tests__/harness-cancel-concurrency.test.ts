import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";

import { createAgentHarness } from "../index.js";
import type { AgentHarnessSessionOptions } from "../index.js";

const tempDirs: string[] = [];
const model = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;
const session: AgentHarnessSessionOptions = { mode: "continuous", idleTimeoutMs: 60_000, supportsResume: true };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function identityFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-cancelconc-"));
  tempDirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are Mono.", "utf8");
  return identityPath;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    }),
  ]);
}

describe("AgentHarness cancel frees the concurrency slot (R10)", () => {
  it("a /cancel of an abort-ignoring never-resolving run frees the maxConcurrentRuns slot for the next turn", async () => {
    const identityPath = await identityFixture();

    let signalAStarted!: () => void;
    const aStarted = new Promise<void>((resolve) => { signalAStarted = resolve; });
    let signalBStarted!: () => void;
    const bStarted = new Promise<void>((resolve) => { signalBStarted = resolve; });
    let releaseB!: () => void;
    const bGate = new Promise<void>((resolve) => { releaseB = resolve; });
    const never = new Promise<RuntimeResult>(() => {});

    const calls: { options: RuntimeRunOptions }[] = [];
    const runtime = {
      async run(_prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        calls.push({ options });
        if (calls.length === 1) {
          // Turn A: ignore the abort signal entirely and never resolve. It holds
          // the only concurrency slot. Pre-fix, this slot is never released on
          // cancel, so turn B can never acquire it.
          signalAStarted();
          return await never;
        }
        // Turn B: proves the slot was freed by actually being invoked.
        signalBStarted();
        await bGate;
        return { text: "answer-b", providerSessionId: "ps-b" };
      },
      async disposeSession(): Promise<boolean> { return true; },
      async disposeAllSessions(): Promise<void> {},
    };

    const harness = createAgentHarness({
      identityPath,
      runtime,
      model,
      executionMode: "sdk",
      session,
      concurrency: { maxConcurrentRuns: 1 },
    });

    // Turn A: submit and wait until it has acquired the slot and entered runtime.run.
    const callerA = harness.submit!({ conversationId: "conv-1", userMessage: "first", abortSignal: new AbortController().signal });
    await withTimeout(aStarted, 1_000, "turn A did not reach runtime.run");

    // Cancel the conversation: the caller promise must reject (cancelled), and
    // the held slot must be freed even though runtime.run never settles.
    harness.cancel!("conv-1");
    await expect(withTimeout(callerA, 1_000, "turn A caller did not reject")).rejects.toMatchObject({
      name: "AgentResponseCancelledError",
    });

    // Turn B (same conversation): must admit and actually invoke runtime.run.
    // Pre-fix the slot is still held by the zombie A, so B parks forever and
    // this times out (regression manifests as a hang).
    const callerB = harness.submit!({ conversationId: "conv-1", userMessage: "second", abortSignal: new AbortController().signal });
    await withTimeout(bStarted, 1_000, "turn B never admitted — concurrency slot not freed on cancel");

    // Drain B cleanly and confirm it resolved.
    releaseB();
    const responseB = await withTimeout(callerB, 1_000, "turn B did not resolve");
    expect(responseB.text).toBe("answer-b");
    // Exactly two runtime invocations: the zombie A and the admitted B.
    expect(calls).toHaveLength(2);
  });
});
