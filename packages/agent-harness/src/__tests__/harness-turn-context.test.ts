import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { MemoryBlock, MemoryStore, MemoryWriteResult } from "@mono-agent/agent-contracts";
import type { RunRecorder, RunSummary, RuntimeEventLike, RuntimeResultLike } from "@mono-agent/observability";
import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";

import { createAgentHarness, createInMemoryHistoryStore } from "../index.js";
import type { AgentHarnessSessionOptions } from "../index.js";

const tempDirs: string[] = [];
const model = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function identityFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-turn-context-"));
  tempDirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are Mono.", "utf8");
  return identityPath;
}

function createFakeRuntime(
  run: (prompt: string, options: RuntimeRunOptions, call: number) => Promise<RuntimeResult> = async () => ({ text: "ok" }),
) {
  const calls: Array<{ prompt: string; options: RuntimeRunOptions }> = [];
  return {
    calls,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        calls.push({ prompt, options });
        return await run(prompt, options, calls.length);
      },
      async disposeSession(): Promise<boolean> {
        return true;
      },
    },
  };
}

class SpyRecorder implements RunRecorder {
  readonly events: RuntimeEventLike[] = [];

  onEvent(event: RuntimeEventLike): void {
    this.events.push(event);
  }

  async start(): Promise<RunSummary> {
    return { runId: "r", conversationId: "c", status: "running", durationMs: 0, eventCount: 0, artifactPaths: [] };
  }

  async finish(_result: RuntimeResultLike): Promise<RunSummary> {
    return { runId: "r", conversationId: "c", status: "succeeded", durationMs: 1, eventCount: this.events.length, artifactPaths: [] };
  }

  async fail(_error: unknown): Promise<RunSummary> {
    return { runId: "r", conversationId: "c", status: "failed", durationMs: 1, eventCount: this.events.length, artifactPaths: [] };
  }
}

const session: AgentHarnessSessionOptions = { mode: "continuous", idleTimeoutMs: 60_000, supportsResume: true };

function request(conversationId: string, userMessage = "hello") {
  return { conversationId, userMessage, abortSignal: new AbortController().signal };
}

/** A memory store whose recall returns the given block once (or nothing). */
function memoryStore(block: MemoryBlock | undefined): MemoryStore {
  return {
    async load(): Promise<MemoryBlock | undefined> {
      return block;
    },
    async appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult> {
      return { conversationId, source: "spy", bytesWritten: summary.length };
    },
  };
}

interface TurnContextEvent extends RuntimeEventLike {
  readonly type: "turn_context";
  readonly historyCount: number;
  readonly historyOmitted: boolean;
  readonly history?: ReadonlyArray<{ role: string; content: string; name?: string; timestamp?: string; truncated?: boolean }>;
  readonly memory?: { content: string; source?: string; truncated?: boolean };
  readonly timestamp: string;
}

function turnContextEvents(events: readonly RuntimeEventLike[]): TurnContextEvent[] {
  return events.filter((event): event is TurnContextEvent => event.type === "turn_context");
}

describe("AgentHarness turn_context synthetic event", () => {
  it("emits exactly one turn_context to BOTH recorder and host on a cold turn, with history + memory", async () => {
    const identityPath = await identityFixture();
    const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
    await historyStore.append("conv-1", [
      { role: "user", content: "earlier question", timestamp: "2026-06-01T00:00:00Z" },
      { role: "assistant", content: "earlier answer", timestamp: "2026-06-01T00:00:01Z" },
    ]);
    const fake = createFakeRuntime();
    const recorder = new SpyRecorder();
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      historyStore,
      memory: memoryStore({ kind: "markdown", content: "## Memory (recalled)\n- launch checklist", source: "bujo", truncated: false }),
      recorderFactory: () => recorder,
    });

    const hostEvents: RuntimeEventLike[] = [];
    await harness.run({ ...request("conv-1", "hi"), onEvent: (event) => hostEvents.push(event) });

    const recorderTc = turnContextEvents(recorder.events);
    const hostTc = turnContextEvents(hostEvents);
    expect(recorderTc).toHaveLength(1);
    expect(hostTc).toHaveLength(1);

    const evt = recorderTc[0]!;
    expect(evt.historyOmitted).toBe(false);
    expect(evt.historyCount).toBe(2);
    expect(evt.history).toEqual([
      { role: "user", content: "earlier question", timestamp: "2026-06-01T00:00:00Z" },
      { role: "assistant", content: "earlier answer", timestamp: "2026-06-01T00:00:01Z" },
    ]);
    expect(evt.memory).toEqual({ content: "## Memory (recalled)\n- launch checklist", source: "bujo" });
    // The current user message never rides in the event (it is the run's userInput).
    expect(JSON.stringify(evt.history)).not.toContain("hi");
    expect(typeof evt.timestamp).toBe("string");
    // Host and recorder see the same event object payload.
    expect(hostTc[0]).toMatchObject(evt as Record<string, unknown>);
  });

  it("omits history on a warm resumed turn (historyOmitted:true, no history key)", async () => {
    const identityPath = await identityFixture();
    const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
    await historyStore.append("conv-warm", [
      { role: "assistant", content: "seed", timestamp: "2026-06-01T00:00:00Z" },
    ]);
    const fake = createFakeRuntime(async () => ({ text: "answer", providerSessionId: "ps-1" }));
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    // Turn 1 establishes the warm session (cold, history present).
    const first: RuntimeEventLike[] = [];
    await harness.run({ ...request("conv-warm", "first"), onEvent: (event) => first.push(event) });
    expect(turnContextEvents(first)[0]?.historyOmitted).toBe(false);

    // Turn 2 resumes the warm session -> history omitted.
    const second: RuntimeEventLike[] = [];
    await harness.run({ ...request("conv-warm", "second"), onEvent: (event) => second.push(event) });
    const tc = turnContextEvents(second);
    expect(tc).toHaveLength(1);
    expect(tc[0]!.historyOmitted).toBe(true);
    expect(tc[0]!.historyCount).toBe(0);
    expect(tc[0]!.history).toBeUndefined();
  });

  it("reports authoritative empty history instead of claiming a custom store's uncoordinated durable resume", async () => {
    const identityPath = await identityFixture();
    const piSessionsRoot = await mkdtemp(join(tmpdir(), "agent-harness-turn-context-pi-"));
    tempDirs.push(piSessionsRoot);
    // A custom in-memory history store cannot coordinate crash-safe provider
    // epochs. Even with piSessionsRoot configured, the harness must not claim an
    // unverified JSONL transcript carries context after restart.
    const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
    const fake = createFakeRuntime(async () => ({ text: "answer", providerSessionId: "ps-durable" }));
    const recorder = new SpyRecorder();
    const harness = createAgentHarness({
      identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session,
      piSessionsRoot, recorderFactory: () => recorder,
    });

    await harness.run(request("conv-durable", "after restart"));

    const tc = turnContextEvents(recorder.events);
    expect(tc).toHaveLength(1);
    expect(tc[0]!.historyOmitted).toBe(false);
    expect(tc[0]!.historyCount).toBe(0);
    expect(tc[0]!.history).toBeUndefined();
    expect(fake.calls[0]?.options.sessionId).toBeUndefined();
    expect(fake.calls[0]?.options.piSessionsRoot).toBeUndefined();
  });

  it("double-fires on the resume-replay retry, the second carrying replayed history", async () => {
    const identityPath = await identityFixture();
    const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
    await historyStore.append("conv-replay", [
      { role: "assistant", content: "REPLAY-MARKER", timestamp: "2026-06-01T00:00:00Z" },
    ]);
    // Resuming a session fails (stale) -> harness retries with history.
    const fake = createFakeRuntime(async (_prompt, options) => {
      if (options.sessionId !== undefined) {
        return { failureKind: "session_not_found", error: "session expired" };
      }
      return { text: "recovered", providerSessionId: "ps-next" };
    });
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", historyStore, session });

    // Turn 1 goes fresh (no session) and captures ps-next.
    await harness.run(request("conv-replay", "first"));

    // Turn 2 resumes ps-next -> stale -> retry with history. Two turn_context events.
    const second: RuntimeEventLike[] = [];
    await harness.run({ ...request("conv-replay", "again"), onEvent: (event) => second.push(event) });
    const tc = turnContextEvents(second);
    expect(tc).toHaveLength(2);
    // First fire: warm-resume attempt, history omitted.
    expect(tc[0]!.historyOmitted).toBe(true);
    expect(tc[0]!.history).toBeUndefined();
    // Second fire: retry replays history.
    expect(tc[1]!.historyOmitted).toBe(false);
    expect(JSON.stringify(tc[1]!.history)).toContain("REPLAY-MARKER");
  });

  it("clamps an over-long history message and flags truncated:true", async () => {
    const identityPath = await identityFixture();
    const longContent = "x".repeat(2_500);
    const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
    await historyStore.append("conv-clamp", [
      { role: "assistant", content: longContent, timestamp: "2026-06-01T00:00:00Z" },
    ]);
    const fake = createFakeRuntime();
    const recorder = new SpyRecorder();
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, historyStore, recorderFactory: () => recorder });

    await harness.run(request("conv-clamp", "hi"));

    const entry = turnContextEvents(recorder.events)[0]!.history![0]!;
    expect(entry.content).toHaveLength(2_000);
    expect(entry.truncated).toBe(true);
  });

  it("clamps an over-long recalled-memory block and flags truncated:true", async () => {
    const identityPath = await identityFixture();
    const longMemory = "m".repeat(5_000);
    const fake = createFakeRuntime();
    const recorder = new SpyRecorder();
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      memory: memoryStore({ kind: "markdown", content: longMemory, source: "bujo", truncated: false }),
      recorderFactory: () => recorder,
    });

    await harness.run(request("conv-mem-clamp", "hi"));

    const mem = turnContextEvents(recorder.events)[0]!.memory!;
    expect(mem.content).toHaveLength(4_000);
    expect(mem.truncated).toBe(true);
  });

  it("byte-clamps a multibyte (CJK) history message under the redaction byte cap without splitting a code point", async () => {
    const identityPath = await identityFixture();
    // 2000 chars would clamp cleanly, but each 字 is 3 UTF-8 bytes → ~6000 bytes,
    // over the 4096-byte recorder cap. The clamp must cut on a UTF-8 boundary.
    const cjk = "字".repeat(3_000);
    const historyStore = createInMemoryHistoryStore({ maxMessages: 10 });
    await historyStore.append("conv-cjk", [{ role: "assistant", content: cjk, timestamp: "2026-06-01T00:00:00Z" }]);
    const fake = createFakeRuntime();
    const recorder = new SpyRecorder();
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, historyStore, recorderFactory: () => recorder });

    await harness.run(request("conv-cjk", "hi"));

    const entry = turnContextEvents(recorder.events)[0]!.history![0]!;
    expect(entry.truncated).toBe(true);
    expect(Buffer.byteLength(entry.content, "utf8")).toBeLessThanOrEqual(4_096);
    // No replacement char (would signal a split multi-byte code point) and only whole 字.
    expect(entry.content).not.toContain("�");
    expect(entry.content).toMatch(/^字+$/u);
    expect(entry.content.length).toBeLessThan(2_000);
  });

  it("byte-clamps a multibyte (emoji) recalled-memory block without splitting a surrogate pair", async () => {
    const identityPath = await identityFixture();
    // Each 🧠 is 2 UTF-16 units and 4 UTF-8 bytes → 2000 emoji ≈ 8000 bytes.
    const emoji = "🧠".repeat(3_000);
    const fake = createFakeRuntime();
    const recorder = new SpyRecorder();
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      memory: memoryStore({ kind: "markdown", content: emoji, source: "bujo", truncated: false }),
      recorderFactory: () => recorder,
    });

    await harness.run(request("conv-emoji", "hi"));

    const mem = turnContextEvents(recorder.events)[0]!.memory!;
    expect(mem.truncated).toBe(true);
    expect(Buffer.byteLength(mem.content, "utf8")).toBeLessThanOrEqual(4_096);
    expect(mem.content).not.toContain("�");
    // Only whole 🧠 clusters survived (no lone surrogate at the cut).
    expect(mem.content).toMatch(/^(?:🧠)+$/u);
  });

  it("omits the memory key when no memory is configured", async () => {
    const identityPath = await identityFixture();
    const fake = createFakeRuntime();
    const recorder = new SpyRecorder();
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, recorderFactory: () => recorder });

    await harness.run(request("conv-no-mem", "hi"));

    const tc = turnContextEvents(recorder.events);
    expect(tc).toHaveLength(1);
    expect(tc[0]!.memory).toBeUndefined();
    // No history configured either -> no history key, count 0.
    expect(tc[0]!.history).toBeUndefined();
    expect(tc[0]!.historyCount).toBe(0);
    expect(tc[0]!.historyOmitted).toBe(false);
  });
});
