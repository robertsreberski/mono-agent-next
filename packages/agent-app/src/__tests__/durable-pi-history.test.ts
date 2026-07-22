import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { createDurableHistoryStore, type AgentHarness } from "@mono-agent/agent-harness";
import type { MonoAgentConfig } from "@mono-agent/config";
import {
  createMonoRuntime,
  type MonoRuntimeLike,
  type RuntimeRunOptions,
} from "@mono-agent/runtime-adapter";

import { createConfiguredAgentHarness } from "../index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface ObservedRuntimeCall {
  readonly prompt: string;
  readonly options: RuntimeRunOptions;
}

interface PiContextMessage {
  readonly role?: string;
  readonly content?: unknown;
}

interface PiContext {
  readonly messages?: readonly PiContextMessage[];
}

function observeRuntime(base: MonoRuntimeLike): {
  readonly runtime: MonoRuntimeLike;
  readonly calls: ObservedRuntimeCall[];
} {
  const calls: ObservedRuntimeCall[] = [];
  return {
    calls,
    runtime: {
      ...base,
      async run(prompt, options) {
        calls.push({ prompt, options });
        return await base.run(prompt, options);
      },
    },
  };
}

function transcriptOf(context: PiContext | undefined): string[] {
  return (context?.messages ?? [])
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const text = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((block): block is { readonly type: "text"; readonly text: string } =>
                typeof block === "object"
                && block !== null
                && "type" in block
                && block.type === "text"
                && "text" in block
                && typeof block.text === "string")
              .map((block) => block.text)
              .join("")
          : "";
      return `${message.role}:${text}`;
    });
}

function contentMessages(options: RuntimeRunOptions): string[] {
  return options.messages.map((message) => `${message.role}:${String(message.content)}`);
}

describe("configured durable Pi history", () => {
  it("replays canonical history exactly once on create-on-miss, warm follow-up, and true resume", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-app-durable-pi-history-"));
    tempDirs.push(dir);
    const identityPath = join(dir, "IDENTITY.md");
    const artifactDir = join(dir, ".mono-agent", "artifacts");
    const historyRoot = join(dir, ".mono-agent", "history");
    const piSessionsRoot = join(dir, ".mono-agent", "pi-sessions");
    await writeFile(identityPath, "You are Mono.", "utf8");

    const faux = fauxProvider({
      provider: "faux",
      models: [{ id: "faux-model", reasoning: false }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const piModel = faux.getModel();
    const model = {
      sdk: "pi",
      provider: "faux",
      model: "faux-model",
      reference: "pi:faux:faux-model",
    } as const;
    const config: MonoAgentConfig = {
      runtime: {
        model,
        executionMode: "sdk",
        maxTurns: 4,
        workspace: dir,
        session: { mode: "continuous", idleTimeoutMs: 60_000 },
      },
      providers: { piNative: { piSessionsRoot } },
      context: { identityPath, selectedSkills: [] },
      tools: { allowedTools: [], disallowedTools: [] },
      artifacts: {
        dir: artifactDir,
        retention: { maxAgeDays: 365, maxCount: 50_000, dryRun: false },
        memoryRetention: { maxAgeDays: 7, maxCount: 5_000, dryRun: false },
      },
      traceability: { registryDir: join(dir, "trace-sources") },
    };
    const seedStore = createDurableHistoryStore({
      root: historyRoot,
      retireProviderSession: async () => undefined,
    });
    await seedStore.append("durable-conversation", [
      { role: "user", content: "seed-user", timestamp: "2026-07-01T00:00:00.000Z" },
      { role: "assistant", content: "seed-assistant", timestamp: "2026-07-01T00:00:01.000Z" },
    ]);

    let createOnMissContext: PiContext | undefined;
    let warmContext: PiContext | undefined;
    let trueResumeContext: PiContext | undefined;
    faux.setResponses([
      (context) => {
        createOnMissContext = context as PiContext;
        return fauxAssistantMessage([fauxText("turn-1-assistant")]);
      },
      (context) => {
        warmContext = context as PiContext;
        return fauxAssistantMessage([fauxText("turn-2-assistant")]);
      },
      (context) => {
        trueResumeContext = context as PiContext;
        return fauxAssistantMessage([fauxText("turn-3-assistant")]);
      },
    ]);

    let firstHarness: AgentHarness | undefined;
    let resumedHarness: AgentHarness | undefined;
    try {
      const firstRuntime = observeRuntime(createMonoRuntime());
      firstHarness = await createConfiguredAgentHarness({
        config,
        runtime: firstRuntime.runtime,
        runtimeOptions: {
          piResolvedModel: piModel,
          piResolvedModels: models,
          effort: "none",
        },
      });

      const first = await firstHarness.run({
        conversationId: "durable-conversation",
        userMessage: "turn-1-user",
        abortSignal: new AbortController().signal,
      });
      expect(first.text).toBe("turn-1-assistant");
      expect(firstRuntime.calls[0]?.prompt).not.toContain("seed-user");
      expect(firstRuntime.calls[0]?.prompt).not.toContain("seed-assistant");
      expect(contentMessages(firstRuntime.calls[0]!.options)).toEqual([
        "user:seed-user",
        "assistant:seed-assistant",
        "user:turn-1-user",
      ]);
      expect(transcriptOf(createOnMissContext)).toEqual([
        "user:seed-user",
        "assistant:seed-assistant",
        "user:turn-1-user",
      ]);

      const second = await firstHarness.run({
        conversationId: "durable-conversation",
        userMessage: "turn-2-user",
        abortSignal: new AbortController().signal,
      });
      expect(second.text).toBe("turn-2-assistant");
      expect(contentMessages(firstRuntime.calls[1]!.options)).toEqual(["user:turn-2-user"]);
      expect(transcriptOf(warmContext)).toEqual([
        "user:seed-user",
        "assistant:seed-assistant",
        "user:turn-1-user",
        "assistant:turn-1-assistant",
        "user:turn-2-user",
      ]);

      // Simulate process teardown while preserving the fsynced Pi JSONL. The
      // next harness has no warm mapping and must open the true durable resume.
      await firstHarness.dispose?.();
      firstHarness = undefined;

      const resumedRuntime = observeRuntime(createMonoRuntime());
      resumedHarness = await createConfiguredAgentHarness({
        config,
        runtime: resumedRuntime.runtime,
        runtimeOptions: {
          piResolvedModel: piModel,
          piResolvedModels: models,
          effort: "none",
        },
      });
      const third = await resumedHarness.run({
        conversationId: "durable-conversation",
        userMessage: "turn-3-user",
        abortSignal: new AbortController().signal,
      });
      expect(third.text).toBe("turn-3-assistant");
      expect(resumedRuntime.calls[0]?.prompt).not.toContain("seed-user");
      expect(resumedRuntime.calls[0]?.prompt).not.toContain("turn-1-user");
      expect(contentMessages(resumedRuntime.calls[0]!.options)).toEqual([
        "user:seed-user",
        "assistant:seed-assistant",
        "user:turn-1-user",
        "assistant:turn-1-assistant",
        "user:turn-2-user",
        "assistant:turn-2-assistant",
        "user:turn-3-user",
      ]);
      expect(transcriptOf(trueResumeContext)).toEqual([
        "user:seed-user",
        "assistant:seed-assistant",
        "user:turn-1-user",
        "assistant:turn-1-assistant",
        "user:turn-2-user",
        "assistant:turn-2-assistant",
        "user:turn-3-user",
      ]);
    } finally {
      await resumedHarness?.dispose?.();
      await firstHarness?.dispose?.();
    }
  });
});
