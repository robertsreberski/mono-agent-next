import { link, lstat, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { MemoryBlock, MemoryStore, MemoryWriteResult } from "@mono-agent/agent-contracts";
import type { HistoryMessage } from "../context/index.js";
import type { RuntimeRunOptions, RuntimeResult } from "@mono-agent/runtime-adapter";

import { createAgentHarness } from "../index.js";
import type { ConversationHistoryStore } from "../index.js";

const tempDirs: string[] = [];
const model = { sdk: "pi", provider: "openai-codex", model: "gpt-5.5", reference: "pi:openai-codex:gpt-5.5" } as const;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function identityFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-att-"));
  tempDirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are Mono.", "utf8");
  return identityPath;
}

async function attachmentsDirFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-harness-attdir-"));
  tempDirs.push(dir);
  return dir;
}

function createCapturingRuntime() {
  const calls: { prompt: string; options: RuntimeRunOptions }[] = [];
  return {
    calls,
    runtime: {
      async run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> {
        calls.push({ prompt, options });
        return { text: "ok" };
      },
      async disposeSession(): Promise<boolean> {
        return true;
      },
      async disposeAllSessions(): Promise<void> {},
    },
  };
}

function userContent(call: { options: RuntimeRunOptions }): string {
  const messages = call.options.messages as Array<{ role: string; content: unknown }> | undefined;
  return typeof messages?.[0]?.content === "string" ? (messages[0].content as string) : "";
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
  const hostSummaries: string[] = [];
  const captures: string[] = [];
  const store: MemoryStore = {
    async load(): Promise<MemoryBlock | undefined> {
      return undefined;
    },
    async appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult> {
      hostSummaries.push(summary);
      return { conversationId, source: "spy", bytesWritten: summary.length };
    },
    scheduleCapture(_conversationId: string, text: string): void {
      captures.push(text);
    },
  };
  return { hostSummaries, captures, store };
}

describe("AgentHarness attachments", () => {
  it("injects only successfully persisted current-request attachment paths into opted stdio MCPs", async () => {
    const identityPath = await identityFixture();
    const attachmentsDir = await attachmentsDirFixture();
    const outputRoot = join(attachmentsDir, "outbound");
    const fake = createCapturingRuntime();
    const runIds = ["run-with-attachment", "run-other-chat"];
    const target = {
      type: "stdio",
      command: "transcribe-mcp",
      env: {
        MONO_AGENT_MCP_ATTACHMENTS_ROOT: "/spoofed",
        MONO_AGENT_MCP_ALLOWED_ATTACHMENT_PATHS: '["/spoofed/old"]',
        MONO_AGENT_MCP_ALLOWED_ATTACHMENT_IDENTITIES: '[{"path":"/spoofed/old","dev":1,"ino":2}]',
      },
    };
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      attachmentsDir,
      createRunId: () => runIds.shift() as string,
      runtimeOptions: {
        mcpServers: {
          target,
          untouched: { type: "stdio", command: "other" },
          remote: { type: "http", url: "https://mcp.example.test" },
        },
      },
      mcpRequestContext: { serverNames: ["target", "remote"], runOutputRoot: outputRoot },
    });

    await harness.run({
      conversationId: "telegram:42#today",
      userMessage: "clean this",
      abortSignal: new AbortController().signal,
      attachments: [{
        kind: "document",
        mimeType: "text/plain",
        data: Buffer.from("current transcript").toString("base64"),
        name: "current.txt",
      }],
    });
    await harness.run({
      conversationId: "telegram:99#today",
      userMessage: "no attachment",
      abortSignal: new AbortController().signal,
    });

    const firstServers = fake.calls[0]?.options.mcpServers as Record<string, Record<string, unknown>>;
    const secondServers = fake.calls[1]?.options.mcpServers as Record<string, Record<string, unknown>>;
    const firstEnv = firstServers.target?.env as Record<string, string>;
    const secondEnv = secondServers.target?.env as Record<string, string>;
    const canonicalRoot = await realpath(attachmentsDir);
    const firstAllowed = JSON.parse(firstEnv.MONO_AGENT_MCP_ALLOWED_ATTACHMENT_PATHS as string) as string[];
    const firstIdentities = JSON.parse(firstEnv.MONO_AGENT_MCP_ALLOWED_ATTACHMENT_IDENTITIES as string) as Array<{
      path: string;
      dev: number;
      ino: number;
    }>;
    expect(firstEnv.MONO_AGENT_MCP_ATTACHMENTS_ROOT).toBe(canonicalRoot);
    expect(firstAllowed).toHaveLength(1);
    expect(firstAllowed[0]).toMatch(/current\.txt$/u);
    expect(firstAllowed[0]?.startsWith(`${canonicalRoot}/`)).toBe(true);
    const savedStats = await lstat(firstAllowed[0] as string);
    expect(firstIdentities).toEqual([{ path: firstAllowed[0], dev: savedStats.dev, ino: savedStats.ino }]);
    expect(savedStats.mode & 0o777).toBe(0o600);
    expect(secondEnv.MONO_AGENT_MCP_ATTACHMENTS_ROOT).toBe(canonicalRoot);
    expect(secondEnv.MONO_AGENT_MCP_ALLOWED_ATTACHMENT_PATHS).toBe("[]");
    expect(secondEnv.MONO_AGENT_MCP_ALLOWED_ATTACHMENT_IDENTITIES).toBe("[]");
    expect(firstServers.untouched).toBe(secondServers.untouched);
    expect(firstServers.remote).toBe(secondServers.remote);
    expect(target.env.MONO_AGENT_MCP_ATTACHMENTS_ROOT).toBe("/spoofed");
    expect(target.env.MONO_AGENT_MCP_ALLOWED_ATTACHMENT_IDENTITIES).toContain("/spoofed/old");
    await expect(lstat(join(outputRoot, "run-with-attachment"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(outputRoot, "run-other-chat"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["symlink", "hardlink"] as const)(
    "pins the writer descriptor identity when the saved attachment path is swapped to a %s",
    async (replacement) => {
      const identityPath = await identityFixture();
      const attachmentsDir = await attachmentsDirFixture();
      const canonicalRoot = await realpath(attachmentsDir);
      const runId = `run-${replacement}-swap`;
      const currentPath = join(canonicalRoot, `${runId}-0-current.m4a`);
      const preservedOriginal = join(canonicalRoot, `${runId}-original.m4a`);
      const olderOtherChat = join(canonicalRoot, "run-other-chat-0-private.m4a");
      await writeFile(olderOtherChat, "other chat private audio", "utf8");
      const fake = createCapturingRuntime();
      const harness = createAgentHarness({
        identityPath,
        runtime: fake.runtime,
        model,
        executionMode: "sdk",
        attachmentsDir,
        createRunId: () => runId,
        runtimeOptions: {
          mcpServers: { target: { type: "stdio", command: "target" } },
        },
        runtimeOptionsForRequest: async () => {
          // This hook runs after persistence and before request-context
          // injection, making both path replacement variants deterministic.
          await link(currentPath, preservedOriginal);
          await rm(currentPath);
          if (replacement === "symlink") {
            await symlink(olderOtherChat, currentPath);
          } else {
            await link(olderOtherChat, currentPath);
          }
          return { runtimeOptions: {} };
        },
        mcpRequestContext: {
          serverNames: ["target"],
          runOutputRoot: join(attachmentsDir, "outbound"),
        },
      });

      await harness.run({
        conversationId: "telegram:current",
        userMessage: "transcribe",
        abortSignal: new AbortController().signal,
        attachments: [{
          kind: "document",
          mimeType: "audio/mp4",
          data: Buffer.from("current request audio").toString("base64"),
          name: "current.m4a",
        }],
      });

      const servers = fake.calls[0]?.options.mcpServers as Record<string, { env?: Record<string, string> }>;
      const env = servers.target?.env ?? {};
      const allowedPaths = JSON.parse(env.MONO_AGENT_MCP_ALLOWED_ATTACHMENT_PATHS ?? "[]") as string[];
      const identities = JSON.parse(env.MONO_AGENT_MCP_ALLOWED_ATTACHMENT_IDENTITIES ?? "[]") as Array<{
        path: string;
        dev: number;
        ino: number;
      }>;
      const originalStats = await lstat(preservedOriginal);
      const replacementStats = await lstat(currentPath);

      expect(allowedPaths).toEqual([currentPath]);
      expect(identities).toEqual([{ path: currentPath, dev: originalStats.dev, ino: originalStats.ino }]);
      expect({ dev: replacementStats.dev, ino: replacementStats.ino }).not.toEqual({
        dev: originalStats.dev,
        ino: originalStats.ino,
      });
    },
  );

  it("persists an image attachment to attachmentsDir and references its saved path in the message", async () => {
    const identityPath = await identityFixture();
    const attachmentsDir = await attachmentsDirFixture();
    const fake = createCapturingRuntime();
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", attachmentsDir });

    const bytes = Buffer.from("\x89PNG\r\n fake image bytes");
    await harness.run({
      conversationId: "c1",
      userMessage: "what is in this image?",
      abortSignal: new AbortController().signal,
      attachments: [{ kind: "image", mimeType: "image/png", data: bytes.toString("base64"), name: "photo.png", sizeBytes: bytes.length }],
    });

    const files = await readdir(attachmentsDir);
    expect(files).toHaveLength(1);
    // The saved bytes round-trip.
    const saved = await readFile(join(attachmentsDir, files[0] as string));
    expect(saved.equals(bytes)).toBe(true);

    const content = userContent(fake.calls[0] as { options: RuntimeRunOptions });
    expect(content).toContain("what is in this image?"); // original preserved
    expect(content).toContain(attachmentsDir); // saved path referenced
    expect(content).toContain("image/png");
  });

  it("saves a nameless voice note with its audio extension and surfaces the duration in the prompt", async () => {
    // Telegram voice notes arrive without a fileName; the saved file must still
    // carry a usable extension (ffmpeg/transcription tools sniff by suffix) and
    // the prompt line should quote the duration so the agent can estimate ETAs.
    const identityPath = await identityFixture();
    const attachmentsDir = await attachmentsDirFixture();
    const fake = createCapturingRuntime();
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", attachmentsDir });

    const bytes = Buffer.from("OggS fake opus voice bytes");
    await harness.run({
      conversationId: "c1",
      userMessage: "",
      abortSignal: new AbortController().signal,
      attachments: [{ kind: "document", mimeType: "audio/ogg", data: bytes.toString("base64"), sizeBytes: bytes.length, durationSeconds: 47 }],
    });

    const files = await readdir(attachmentsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.ogg$/u);

    const content = userContent(fake.calls[0] as { options: RuntimeRunOptions });
    expect(content).toContain("audio/ogg");
    expect(content).toContain("0:47");
  });

  it("inlines extracted document text alongside the saved-path reference", async () => {
    const identityPath = await identityFixture();
    const attachmentsDir = await attachmentsDirFixture();
    const fake = createCapturingRuntime();
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", attachmentsDir });

    await harness.run({
      conversationId: "c1",
      userMessage: "summarize",
      abortSignal: new AbortController().signal,
      attachments: [{ kind: "document", mimeType: "text/plain", data: Buffer.from("HELLO-DOC-BODY").toString("base64"), name: "note.txt", text: "HELLO-DOC-BODY" }],
    });

    const content = userContent(fake.calls[0] as { options: RuntimeRunOptions });
    expect(content).toContain("summarize");
    expect(content).toContain("HELLO-DOC-BODY"); // extracted text inlined
  });

  it("leaves the message unchanged when there are no attachments", async () => {
    const identityPath = await identityFixture();
    const attachmentsDir = await attachmentsDirFixture();
    const fake = createCapturingRuntime();
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", attachmentsDir });

    await harness.run({ conversationId: "c1", userMessage: "plain message", abortSignal: new AbortController().signal });

    expect(userContent(fake.calls[0] as { options: RuntimeRunOptions })).toContain("plain message");
    expect(await readdir(attachmentsDir)).toHaveLength(0);
  });

  it("sanitizes a path-traversal runId so attachments cannot escape attachmentsDir", async () => {
    const identityPath = await identityFixture();
    const attachmentsDir = await attachmentsDirFixture();
    const fake = createCapturingRuntime();
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      attachmentsDir,
      createRunId: () => "../../etc/evil",
    });

    const bytes = Buffer.from("data");
    await harness.run({
      conversationId: "c1",
      userMessage: "hi",
      abortSignal: new AbortController().signal,
      attachments: [{ kind: "document", mimeType: "text/plain", data: bytes.toString("base64"), name: "n.txt" }],
    });

    // Exactly one file, written as a direct child of attachmentsDir (readdir on
    // attachmentsDir proves it did not escape), with no path separators or
    // leading dots in its name (so no traversal / hidden-file escape).
    const files = await readdir(attachmentsDir);
    expect(files).toHaveLength(1);
    const name = files[0] as string;
    expect(name.includes("/")).toBe(false);
    expect(name.includes("\\")).toBe(false);
    expect(name.startsWith(".")).toBe(false);
  });

  it("emits a provider_bridge_latency event around the provider call", async () => {
    const identityPath = await identityFixture();
    const fake = createCapturingRuntime();
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk" });

    const events: Array<{ type?: string; durationMs?: number }> = [];
    await harness.run({
      conversationId: "c1",
      userMessage: "hi",
      abortSignal: new AbortController().signal,
      onEvent: (event) => events.push(event as { type?: string; durationMs?: number }),
    });

    const latency = events.find((event) => event.type === "provider_bridge_latency");
    expect(latency).toBeDefined();
    expect(typeof latency?.durationMs).toBe("number");
    expect(latency?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("does not pass piSessionsRoot without a crash-safe history coordinator", async () => {
    const identityPath = await identityFixture();
    const fake = createCapturingRuntime();
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      piSessionsRoot: "/tmp/pi-sessions",
    });

    await harness.run({ conversationId: "c1", userMessage: "hi", abortSignal: new AbortController().signal });

    expect((fake.calls[0]?.options as { piSessionsRoot?: string }).piSessionsRoot).toBeUndefined();
  });

  it("accepts an attachment-only request (empty userMessage) and synthesizes a prompt", async () => {
    const identityPath = await identityFixture();
    const attachmentsDir = await attachmentsDirFixture();
    const fake = createCapturingRuntime();
    const harness = createAgentHarness({ identityPath, runtime: fake.runtime, model, executionMode: "sdk", attachmentsDir });

    const response = await harness.run({
      conversationId: "c1",
      userMessage: "", // file upload with no caption (e.g. a Slack file_share)
      abortSignal: new AbortController().signal,
      attachments: [{ kind: "image", mimeType: "image/png", data: Buffer.from("img").toString("base64"), name: "shot.png" }],
    });

    // The empty-text request is NOT rejected; the runtime runs with a synthesized
    // prompt that references the attachment.
    expect(response.failure).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
    expect(userContent(fake.calls[0] as { options: RuntimeRunOptions })).toContain("shot.png");
  });

  it("does not allocate a request extension when concurrency admission is aborted while queued", async () => {
    const identityPath = await identityFixture();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let runCount = 0;
    const runtime = {
      async run(): Promise<RuntimeResult> {
        runCount += 1;
        if (runCount === 1) {
          markFirstStarted();
          await firstGate; // hold the only concurrency slot
        }
        return { text: "ok" };
      },
      async disposeSession(): Promise<boolean> { return true; },
      async disposeAllSessions(): Promise<void> {},
    };
    const allocations: string[] = [];
    const cleanups: string[] = [];
    const harness = createAgentHarness({
      identityPath,
      runtime,
      model,
      executionMode: "sdk",
      concurrency: { maxConcurrentRuns: 1 },
      runtimeOptionsForRequest: ({ request }) => {
        allocations.push(request.conversationId);
        return { cleanup: async () => { cleanups.push(request.conversationId); } };
      },
    });

    // First run takes the only slot and blocks inside runtime.run.
    const first = harness.run({ conversationId: "c1", userMessage: "first", abortSignal: new AbortController().signal });
    await firstStarted;

    // Second run queues for admission, then is aborted before it can acquire.
    const secondAbort = new AbortController();
    const second = harness.run({ conversationId: "c2", userMessage: "second", abortSignal: secondAbort.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    secondAbort.abort(new Error("cancelled"));
    const secondResult = await second;

    // It never acquired a provider slot, so it never allocated an extension.
    expect(secondResult.failure?.kind).toBe("cancelled");
    expect(allocations).toEqual(["c1"]);
    expect(cleanups).not.toContain("c2");

    releaseFirst();
    await first;
    expect(cleanups).toEqual(["c1"]);
  });

  it("bounds request extension resources by provider concurrency while runs queue", async () => {
    const identityPath = await identityFixture();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let runCount = 0;
    let activeExtensions = 0;
    let maxActiveExtensions = 0;
    const allocations: string[] = [];
    const runtime = {
      async run(): Promise<RuntimeResult> {
        runCount += 1;
        if (runCount === 1) {
          markFirstStarted();
          await firstGate;
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
      concurrency: { maxConcurrentRuns: 1 },
      runtimeOptionsForRequest: ({ request }) => {
        allocations.push(request.conversationId);
        activeExtensions += 1;
        maxActiveExtensions = Math.max(maxActiveExtensions, activeExtensions);
        let cleaned = false;
        return {
          cleanup: async () => {
            if (cleaned) return;
            cleaned = true;
            activeExtensions -= 1;
          },
        };
      },
    });

    const runs = Array.from({ length: 25 }, (_, index) => harness.run({
      conversationId: `queued-${index}`,
      userMessage: `turn ${index}`,
      abortSignal: new AbortController().signal,
    }));
    await firstStarted;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(allocations).toHaveLength(1);
    expect(activeExtensions).toBe(1);
    expect(maxActiveExtensions).toBe(1);

    releaseFirst();
    const results = await Promise.all(runs);
    expect(results.every((result) => result.text === "ok")).toBe(true);
    expect(allocations).toHaveLength(25);
    expect(maxActiveExtensions).toBe(1);
    expect(activeExtensions).toBe(0);
  });

  it("closes request extensions before releasing an aborted provider slot", async () => {
    const identityPath = await identityFixture();
    let releaseZombie!: () => void;
    let markZombieStarted!: () => void;
    const zombieStarted = new Promise<void>((resolve) => { markZombieStarted = resolve; });
    const zombieGate = new Promise<void>((resolve) => { releaseZombie = resolve; });
    let runtimeCalls = 0;
    let activeExtensions = 0;
    let maxActiveExtensions = 0;
    let cleanupCalls = 0;
    const runtime = {
      async run(): Promise<RuntimeResult> {
        runtimeCalls += 1;
        if (runtimeCalls === 1) {
          markZombieStarted();
          await zombieGate; // Deliberately ignores abort until the test releases it.
        }
        return { text: "ok" };
      },
    };
    const harness = createAgentHarness({
      identityPath,
      runtime,
      model,
      executionMode: "sdk",
      concurrency: { maxConcurrentRuns: 1 },
      runtimeOptionsForRequest: () => {
        activeExtensions += 1;
        maxActiveExtensions = Math.max(maxActiveExtensions, activeExtensions);
        let cleaned = false;
        return {
          cleanup: async () => {
            if (cleaned) return;
            cleaned = true;
            cleanupCalls += 1;
            activeExtensions -= 1;
          },
        };
      },
    });

    const firstAbort = new AbortController();
    const first = harness.run({
      conversationId: "abort-zombie",
      userMessage: "first",
      abortSignal: firstAbort.signal,
    });
    await zombieStarted;
    expect(activeExtensions).toBe(1);

    firstAbort.abort(new Error("cancelled"));
    for (let attempt = 0; attempt < 20 && activeExtensions !== 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(activeExtensions).toBe(0);

    const second = await harness.run({
      conversationId: "after-abort",
      userMessage: "second",
      abortSignal: new AbortController().signal,
    });
    expect(second.text).toBe("ok");
    expect(maxActiveExtensions).toBe(1);
    expect(activeExtensions).toBe(0);

    releaseZombie();
    await expect(first).resolves.toMatchObject({ failure: { kind: "cancelled" } });
    expect(cleanupCalls).toBe(2);
  });

  it("persists the original caption + redacted metadata to history/memory, never the extracted document body (F8)", async () => {
    const identityPath = await identityFixture();
    const attachmentsDir = await attachmentsDirFixture();
    const fake = createCapturingRuntime();
    const history = createSpyHistoryStore();
    const memory = createSpyMemoryStore();
    const harness = createAgentHarness({
      identityPath,
      runtime: fake.runtime,
      model,
      executionMode: "sdk",
      attachmentsDir,
      historyStore: history.store,
      memory: memory.store,
      memoryWriteMode: "capture",
    });

    const SECRET = "SECRET-DOC-BODY";
    const CAPTION = "summarize this for me";
    await harness.run({
      conversationId: "c1",
      userMessage: CAPTION,
      abortSignal: new AbortController().signal,
      attachments: [{
        kind: "document",
        mimeType: "text/plain",
        data: Buffer.from(SECRET).toString("base64"),
        name: "secret.txt",
        text: SECRET,
        sizeBytes: SECRET.length,
      }],
    });

    // (a) The PROVIDER call still receives the expanded prompt with the extracted
    // body and the saved-path reference — the current turn is unchanged.
    const prompt = userContent(fake.calls[0] as { options: RuntimeRunOptions });
    expect(prompt).toContain(CAPTION);
    expect(prompt).toContain(SECRET);
    expect(prompt).toContain(attachmentsDir);

    // (b) The persisted history user message keeps the original caption +
    // redacted metadata (path/type/size/name) but NOT the extracted body.
    const persistedUser = history.appended.find((message) => message.role === "user");
    expect(persistedUser).toBeDefined();
    const persistedText = persistedUser?.content ?? "";
    expect(persistedText).toContain(CAPTION);
    expect(persistedText).not.toContain(SECRET);
    expect(persistedText).not.toContain("--- extracted text ---");
    // Redacted metadata IS retained so a follow-up can re-open the file.
    expect(persistedText).toContain(attachmentsDir);
    expect(persistedText).toContain("secret.txt");

    // (c) The intelligent-capture payload must not carry the extracted body.
    expect(memory.captures).toHaveLength(1);
    expect(memory.captures[0]).not.toContain(SECRET);
    expect(memory.captures[0]).toContain(CAPTION);

    // (d) The deterministic host summary must not carry the extracted body.
    expect(memory.hostSummaries).toHaveLength(1);
    expect(memory.hostSummaries[0]).not.toContain(SECRET);
  });
});
