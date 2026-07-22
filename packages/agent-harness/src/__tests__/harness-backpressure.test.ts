import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";

import { createAgentHarness } from "../index.js";

const tempDirs: string[] = [];
const model = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function identityFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-bp-"));
  tempDirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are Mono.", "utf8");
  return identityPath;
}

async function attachmentsDirFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-bpdir-"));
  tempDirs.push(dir);
  return dir;
}

async function waitForAttachmentFiles(dir: string, expectedCount: number): Promise<string[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const files = await readdir(dir);
    if (files.length === expectedCount) {
      return files;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return readdir(dir);
}

function attachmentRequest(conversationId: string) {
  const bytes = Buffer.from(`bytes-for-${conversationId}`);
  return {
    conversationId,
    userMessage: "look at this",
    abortSignal: new AbortController().signal,
    attachments: [
      { kind: "image" as const, mimeType: "image/png", data: bytes.toString("base64"), name: `${conversationId}.png`, sizeBytes: bytes.length },
    ],
  };
}

describe("AgentHarness backpressure (maxPendingRuns)", () => {
  it("fails the over-capacity run fast without persisting its attachment or invoking the runtime", async () => {
    const identityPath = await identityFixture();
    const attachmentsDir = await attachmentsDirFixture();

    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: { options: RuntimeRunOptions }[] = [];
    const runtime = {
      async run(_prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        calls.push({ options });
        if (calls.length === 1) {
          started();
          await gate; // first run holds the only concurrency slot
        }
        return { text: "ok" };
      },
      async disposeSession(): Promise<boolean> { return true; },
      async disposeAllSessions(): Promise<void> {},
    };

    const harness = createAgentHarness({
      identityPath,
      runtime,
      model,
      executionMode: "sdk",
      attachmentsDir,
      // Width 1: only one provider call at a time. Pending 1: only one admitted
      // run may wait for that slot; a further arrival fails fast.
      concurrency: { maxConcurrentRuns: 1, maxPendingRuns: 1 },
    });

    // Run 1: admitted, reaches the provider, leaves pending, then blocks on gate.
    const first = harness.run(attachmentRequest("c1"));
    await firstStarted;

    // Run 2: admitted (pending=1), parks waiting for the concurrency slot.
    const second = harness.run(attachmentRequest("c2"));
    await waitForAttachmentFiles(attachmentsDir, 2);

    // Run 3: arrives while pending is already at the bound -> fails fast.
    const third = await harness.run(attachmentRequest("c3"));

    expect(third.failure?.kind).toBe("capacity_exceeded");
    expect(third.text).toBeUndefined();

    // The runtime was only invoked for the first (admitted-and-running) run; the
    // second is still parked, the third never reached the provider.
    expect(calls).toHaveLength(1);

    // The rejected third run wrote nothing to disk; only the two admitted runs'
    // attachments were persisted (one file each, unique per runId).
    const files = await readdir(attachmentsDir);
    expect(files).toHaveLength(2);
    expect(files.some((name) => name.endsWith("-0-c3.png"))).toBe(false);

    // Drain.
    release();
    await first;
    // After the first releases its slot, the second admits to the provider and
    // a subsequent run is welcome again (pending freed).
    await second;
    const fourth = await harness.run(attachmentRequest("c4"));
    expect(fourth.failure).toBeUndefined();
    expect(fourth.text).toBe("ok");
  });

  it("decrements the pending counter on a successful run", async () => {
    const identityPath = await identityFixture();
    const runtime = {
      async run(): Promise<RuntimeResult> { return { text: "ok" }; },
      async disposeSession(): Promise<boolean> { return true; },
      async disposeAllSessions(): Promise<void> {},
    };
    const harness = createAgentHarness({
      identityPath,
      runtime,
      model,
      executionMode: "sdk",
      concurrency: { maxPendingRuns: 1 },
    });

    // Each run completes before the next starts, so the counter must return to 0
    // each time — otherwise the second/third would be rejected.
    for (const id of ["c1", "c2", "c3"]) {
      const response = await harness.run({ conversationId: id, userMessage: "hi", abortSignal: new AbortController().signal });
      expect(response.failure).toBeUndefined();
      expect(response.text).toBe("ok");
    }
  });

  it("decrements the pending counter when pre-provider work throws", async () => {
    const identityPath = await identityFixture();
    let runCount = 0;
    const runtime = {
      async run(): Promise<RuntimeResult> { runCount += 1; return { text: "ok" }; },
      async disposeSession(): Promise<boolean> { return true; },
      async disposeAllSessions(): Promise<void> {},
    };
    // A history store that throws on the first load makes prepareContext (the
    // pre-provider work) throw before the run reaches the runtime.
    let firstLoad = true;
    const historyStore = {
      async load() {
        if (firstLoad) {
          firstLoad = false;
          throw new Error("history backend down");
        }
        return [];
      },
      async append() {},
    };
    const harness = createAgentHarness({
      identityPath,
      runtime,
      model,
      executionMode: "sdk",
      historyStore,
      concurrency: { maxPendingRuns: 1 },
    });

    // First run throws in prepareContext (never reaches the runtime).
    const bad = await harness.run({ conversationId: "bad", userMessage: "x", abortSignal: new AbortController().signal });
    expect(bad.failure).toBeDefined();
    expect(bad.failure?.kind).not.toBe("capacity_exceeded");
    expect(runCount).toBe(0);

    // The pending slot was released despite the throw: a clean follow-up admits
    // rather than being rejected as over-capacity.
    const good = await harness.run({ conversationId: "good", userMessage: "hi", abortSignal: new AbortController().signal });
    expect(good.failure).toBeUndefined();
    expect(good.text).toBe("ok");
    expect(runCount).toBe(1);
  });
});
