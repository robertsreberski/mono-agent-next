import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";
import type { LocalProviderDefinition, RuntimeModelReference, SandboxPolicy } from "@mono-agent/runtime-adapter";
import { describe, expect, it, vi } from "vitest";

import type { AgentHarnessRuntimeOptionsInput } from "@mono-agent/agent-harness";

import { createRequestModelOverrideRuntimeExtension } from "../request-model-override.js";
import { composeRuntimeOptionExtensions } from "../runtime-option-extensions.js";

interface RunOptions {
  readonly logger?: { warn: ReturnType<typeof vi.fn>; info?: ReturnType<typeof vi.fn> };
  readonly localProviders?: readonly LocalProviderDefinition[];
  readonly baseModel?: RuntimeModelReference;
  readonly fallbackModels?: readonly RuntimeModelReference[];
  readonly baseEffort?: string;
  readonly baseMaxTurns?: number;
  readonly mcpSources?: readonly string[];
  readonly indexSkillsActive?: boolean;
  readonly sandboxPolicy?: Pick<SandboxPolicy, "mode">;
  readonly toolPolicy?: {
    readonly allowedTools: readonly string[];
    readonly disallowedTools: readonly string[];
  };
}

function run(metadata: Record<string, unknown> | undefined, options: RunOptions = {}, userMessage?: string) {
  const extension = createRequestModelOverrideRuntimeExtension({
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.localProviders === undefined ? {} : { localProviders: options.localProviders }),
    ...(options.baseModel === undefined ? {} : { baseModel: options.baseModel }),
    ...(options.fallbackModels === undefined ? {} : { fallbackModels: options.fallbackModels }),
    ...(options.baseEffort === undefined ? {} : { baseEffort: options.baseEffort }),
    ...(options.baseMaxTurns === undefined ? {} : { baseMaxTurns: options.baseMaxTurns }),
    ...(options.mcpSources === undefined ? {} : { mcpSources: options.mcpSources }),
    ...(options.indexSkillsActive === undefined ? {} : { indexSkillsActive: options.indexSkillsActive }),
    ...(options.sandboxPolicy === undefined ? {} : { sandboxPolicy: options.sandboxPolicy }),
    ...(options.toolPolicy === undefined ? {} : { toolPolicy: options.toolPolicy }),
  });
  return extension({
    request: {
      ...(metadata === undefined ? {} : { metadata }),
      ...(userMessage === undefined ? {} : { userMessage }),
    },
  });
}

const LMSTUDIO_PROVIDER: LocalProviderDefinition = {
  id: "lmstudio",
  type: "lmstudio",
  baseUrl: "http://localhost:1234",
  enabled: true,
};

const OLLAMA_PROVIDER: LocalProviderDefinition = {
  id: "ollama",
  type: "ollama",
  baseUrl: "http://localhost:11434",
  enabled: true,
};

describe("createRequestModelOverrideRuntimeExtension", () => {
  it("applies a webhook model + effort override (executionMode is left to the harness)", async () => {
    const result = await run({ webhook: { model: "claude:claude-opus-4-8", effort: "high" } });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ sdk: "claude", model: "claude-opus-4-8" }));
    expect(result.runtimeOptions.effort).toBe("high");
  });

  it("applies a cron model override without an effort", async () => {
    const result = await run({ cron: { model: "codex:gpt-5.5" } });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ sdk: "codex", model: "gpt-5.5" }));
    expect(result.runtimeOptions.effort).toBeUndefined();
  });

  it("prefers webhook metadata over cron metadata when both are present", async () => {
    const result = await run({
      webhook: { model: "claude:claude-opus-4-8" },
      cron: { model: "codex:gpt-5.5" },
    });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ sdk: "claude" }));
  });

  it("applies a tui per-session model + effort override", async () => {
    const result = await run({ tui: { model: "claude:claude-opus-4-8", effort: "low" } });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ sdk: "claude", model: "claude-opus-4-8" }));
    expect(result.runtimeOptions.effort).toBe("low");
  });

  it("applies a web per-thread model + effort override", async () => {
    const result = await run({ web: { model: "claude:claude-opus-4-8", effort: "low" } });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ sdk: "claude", model: "claude-opus-4-8" }));
    expect(result.runtimeOptions.effort).toBe("low");
  });

  it("applies a Telegram per-chat model + effort override", async () => {
    const result = await run({ telegram: { model: "claude:claude-opus-4-8", effort: "high" } });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({
      sdk: "claude",
      model: "claude-opus-4-8",
    }));
    expect(result.runtimeOptions.effort).toBe("high");
  });

  it("applies a Slack conversation model + effort override", async () => {
    const result = await run({ slack: { model: "claude:claude-opus-4-8", effort: "high" } });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({
      sdk: "claude",
      model: "claude-opus-4-8",
    }));
    expect(result.runtimeOptions.effort).toBe("high");
  });

  it("preserves existing Telegram precedence when malformed metadata carries both channel blocks", async () => {
    const result = await run({
      telegram: { model: "claude:claude-opus-4-8" },
      slack: { model: "codex:gpt-5.5" },
    });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ sdk: "claude" }));
  });

  it("prefers web metadata over its TUI compatibility mirror", async () => {
    const result = await run({
      web: { model: "claude:claude-opus-4-8", effort: "high" },
      tui: { model: "codex:gpt-5.5", effort: "low" },
    });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ sdk: "claude", model: "claude-opus-4-8" }));
    expect(result.runtimeOptions.effort).toBe("high");
  });

  it("prefers cron metadata over tui metadata when both are present", async () => {
    const result = await run({
      cron: { model: "codex:gpt-5.5" },
      tui: { model: "claude:claude-opus-4-8" },
    });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ sdk: "codex" }));
  });

  it("warns and ignores an invalid model string (no override applied)", async () => {
    const logger = { warn: vi.fn() };
    const result = await run({ webhook: { model: "not a model" } }, { logger });
    expect(result.runtimeOptions.model).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid per-request model"),
      expect.objectContaining({ model: "not a model" }),
    );
  });

  it("warns and ignores an invalid effort value", async () => {
    const logger = { warn: vi.fn() };
    const result = await run({ webhook: { effort: "turbo" } }, { logger });
    expect(result.runtimeOptions.effort).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid per-request effort"),
      expect.objectContaining({ effort: "turbo" }),
    );
  });

  it("rejects a direct-Codex host override to Pi without dropping an effort override", async () => {
    const logger = { warn: vi.fn() };
    const result = await run(
      { webhook: { model: "pi:ollama:qwen3:8b", effort: "high" } },
      { logger, baseModel: parseMonoRuntimeModelReference("codex:gpt-5.6-terra") },
    );

    expect(result.runtimeOptions).toEqual({ effort: "high" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("direct-Codex runtime boundary"),
      expect.objectContaining({ model: "pi:ollama:qwen3:8b" }),
    );
  });

  it("rejects a Pi host override to direct Codex", async () => {
    const logger = { warn: vi.fn() };
    const result = await run(
      { tui: { model: "codex:gpt-5.6-terra" } },
      { logger, baseModel: parseMonoRuntimeModelReference("pi:ollama:qwen3:8b") },
    );

    expect(result.runtimeOptions.model).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("direct-Codex runtime boundary"),
      expect.objectContaining({ model: "codex:gpt-5.6-terra" }),
    );
  });

  it("rejects a Claude override while a native mono-agent sandbox is active", async () => {
    const logger = { warn: vi.fn() };
    const result = await run(
      { webhook: { model: "claude:claude-opus-4-8", effort: "high" } },
      {
        logger,
        baseModel: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.6-terra"),
        sandboxPolicy: { mode: "native" },
      },
    );

    expect(result.runtimeOptions).toEqual({ effort: "high" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Claude model override while the mono-agent sandbox is active"),
      expect.objectContaining({ model: "claude:claude-opus-4-8", sandboxMode: "native" }),
    );
  });

  it("allows a Pi host override to Claude when the configured sandbox is off", async () => {
    const result = await run(
      { tui: { model: "claude:claude-opus-4-8" } },
      {
        baseModel: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.6-terra"),
        sandboxPolicy: { mode: "off" },
      },
    );

    expect(result.runtimeOptions.model).toEqual(
      expect.objectContaining({ sdk: "claude", model: "claude-opus-4-8" }),
    );
  });

  it("rejects a direct OpenCode override while a native mono-agent sandbox is active", async () => {
    const logger = { warn: vi.fn() };
    const result = await run(
      { cron: { model: "opencode:github-copilot:gpt-5.1" } },
      {
        logger,
        baseModel: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.6-terra"),
        sandboxPolicy: { mode: "native" },
      },
    );

    expect(result.runtimeOptions.model).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("direct OpenCode model override while the mono-agent sandbox is active"),
      expect.objectContaining({ model: "opencode:github-copilot:gpt-5.1", sandboxMode: "native" }),
    );
  });

  it("allows a pi:opencode-go override while a native mono-agent sandbox is active", async () => {
    const result = await run(
      { cron: { model: "pi:opencode-go:kimi-k2.6" } },
      {
        baseModel: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.6-terra"),
        sandboxPolicy: { mode: "native" },
      },
    );

    expect(result.runtimeOptions.model).toEqual(
      expect.objectContaining({ sdk: "pi", provider: "opencode-go", model: "kimi-k2.6" }),
    );
  });

  it("rejects a direct OpenCode override under a restrictive host tool policy", async () => {
    const logger = { warn: vi.fn() };
    const result = await run(
      { webhook: { model: "opencode:github-copilot:gpt-5.1", effort: "high" } },
      {
        logger,
        baseModel: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.6-terra"),
        toolPolicy: { allowedTools: ["Read", "Grep"], disallowedTools: [] },
      },
    );

    expect(result.runtimeOptions).toEqual({ effort: "high" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("direct OpenCode model override under a restrictive tool policy"),
      expect.objectContaining({ model: "opencode:github-copilot:gpt-5.1" }),
    );
  });

  it("allows a direct OpenCode override with exact allow-all and no active sandbox", async () => {
    const result = await run(
      { webhook: { model: "opencode:github-copilot:gpt-5.1" } },
      {
        baseModel: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.6-terra"),
        sandboxPolicy: { mode: "off" },
        toolPolicy: { allowedTools: ["*"], disallowedTools: [] },
      },
    );

    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({
      sdk: "opencode",
      provider: "github-copilot",
      model: "gpt-5.1",
    }));
  });

  it("warns and ignores a dynamic webhook direct OpenCode override with inherited memory MCP", async () => {
    const logger = { warn: vi.fn() };
    const result = await run(
      { webhook: { model: "opencode:github-copilot:gpt-5.1" } },
      {
        logger,
        baseModel: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.6-terra"),
        toolPolicy: { allowedTools: ["*"], disallowedTools: [] },
        mcpSources: ["memory.recallTool"],
      },
    );

    expect(result.runtimeOptions.model).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("MCP runtime options are unsupported"),
      expect.objectContaining({ mcpSources: ["memory.recallTool"] }),
    );
  });

  it("warns and ignores a dynamic TUI direct OpenCode override with index skills", async () => {
    const logger = { warn: vi.fn() };
    const result = await run(
      { tui: { model: "opencode:github-copilot:gpt-5.1" } },
      {
        logger,
        baseModel: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.6-terra"),
        toolPolicy: { allowedTools: ["*"], disallowedTools: [] },
        indexSkillsActive: true,
      },
    );

    expect(result.runtimeOptions.model).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("index skill disclosure is unsupported"),
      expect.objectContaining({ model: "opencode:github-copilot:gpt-5.1" }),
    );
  });

  it("rejects a model-only direct OpenCode override that would inherit host effort", async () => {
    const logger = { warn: vi.fn() };
    const result = await run(
      { webhook: { model: "opencode:github-copilot:gpt-5.1" } },
      {
        logger,
        baseModel: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.6-terra"),
        baseEffort: "high",
        toolPolicy: { allowedTools: ["*"], disallowedTools: [] },
      },
    );

    expect(result.runtimeOptions.model).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("direct OpenCode model override because runtime effort is unsupported"),
      expect.objectContaining({ model: "opencode:github-copilot:gpt-5.1", baseEffort: "high" }),
    );
  });

  it("rejects a direct OpenCode model override paired with requested effort", async () => {
    const logger = { warn: vi.fn() };
    const result = await run(
      { cron: { model: "opencode:github-copilot:gpt-5.1", effort: "max" } },
      {
        logger,
        baseModel: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.6-terra"),
        toolPolicy: { allowedTools: ["*"], disallowedTools: [] },
      },
    );

    expect(result.runtimeOptions.model).toBeUndefined();
    expect(result.runtimeOptions.effort).toBe("max");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("direct OpenCode model override because runtime effort is unsupported"),
      expect.objectContaining({ model: "opencode:github-copilot:gpt-5.1", requestedEffort: "max" }),
    );
  });

  it("rejects a direct OpenCode model override that would inherit a hard maxTurns cap", async () => {
    const logger = { warn: vi.fn() };
    const result = await run(
      { webhook: { model: "opencode:github-copilot:gpt-5.1" } },
      {
        logger,
        baseModel: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.6-terra"),
        baseMaxTurns: 4,
        toolPolicy: { allowedTools: ["*"], disallowedTools: [] },
      },
    );

    expect(result.runtimeOptions.model).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("runtime.maxTurns is unsupported"),
      expect.objectContaining({ model: "opencode:github-copilot:gpt-5.1", baseMaxTurns: 4 }),
    );
  });

  it("ignores an effort-only override on a direct OpenCode host", async () => {
    const logger = { warn: vi.fn() };
    const result = await run(
      { tui: { effort: "high" } },
      {
        logger,
        baseModel: parseMonoRuntimeModelReference("opencode:github-copilot:gpt-5.1"),
        toolPolicy: { allowedTools: ["*"], disallowedTools: [] },
      },
    );

    expect(result.runtimeOptions.effort).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("effort override for direct OpenCode"),
      expect.objectContaining({ effort: "high" }),
    );
  });

  it("ignores an effort-only override when a base fallback is direct OpenCode", async () => {
    const logger = { warn: vi.fn() };
    const result = await run(
      { webhook: { effort: "high" } },
      {
        logger,
        baseModel: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.6-terra"),
        fallbackModels: [parseMonoRuntimeModelReference("opencode:github-copilot:gpt-5.1")],
      },
    );

    expect(result.runtimeOptions.effort).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("effort override for direct OpenCode anywhere in the resulting model chain"),
      expect.objectContaining({
        effort: "high",
        directOpenCodeModels: ["opencode:github-copilot:gpt-5.1"],
      }),
    );
  });

  it("keeps a dynamic model override but ignores its effort when a retained fallback is direct OpenCode", async () => {
    const logger = { warn: vi.fn() };
    const result = await run(
      { tui: { model: "claude:claude-opus-4-8", effort: "low" } },
      {
        logger,
        baseModel: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.6-terra"),
        fallbackModels: [parseMonoRuntimeModelReference("opencode:github-copilot:gpt-5.1")],
      },
    );

    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({
      sdk: "claude",
      model: "claude-opus-4-8",
    }));
    expect(result.runtimeOptions.effort).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("resulting model chain"),
      expect.objectContaining({ effort: "low" }),
    );
  });

  it("is a no-op for interactive turns (no cron/webhook metadata)", async () => {
    const result = await run(undefined);
    expect(result.runtimeOptions).toEqual({});
  });

  it("recomputes the local-provider endpoint block for a local-model override", async () => {
    const result = await run(
      { tui: { model: "pi:lmstudio:qwen/qwen3-8b" } },
      { localProviders: [LMSTUDIO_PROVIDER] },
    );
    expect(result.runtimeOptions.model).toEqual(
      expect.objectContaining({ sdk: "pi", provider: "lmstudio", model: "qwen/qwen3-8b" }),
    );
    const options = result.runtimeOptions as Record<string, unknown>;
    expect(options.customProvider).toMatchObject({
      id: "lmstudio",
      provider_type: "lmstudio",
      base_url: "http://localhost:1234",
    });
    expect(options.customModel).toMatchObject({ model_name: "qwen/qwen3-8b" });
    expect(options.modelCapabilities).toEqual(expect.any(Object));
    expect(options.isPrivateProvider).toBe(true);
  });

  it("CLEARS the endpoint block (null) for a cloud-model override so the host default cannot leak", async () => {
    const result = await run(
      { webhook: { model: "claude:claude-opus-4-8", effort: "high" } },
      { localProviders: [LMSTUDIO_PROVIDER] },
    );
    // A model override OWNS the block: for a cloud model every endpoint field is
    // an explicit null so the harness merge deletes the host default's block.
    expect(result.runtimeOptions).toEqual({
      model: expect.objectContaining({ sdk: "claude" }),
      effort: "high",
      customProvider: null,
      customModel: null,
      modelCapabilities: null,
      isPrivateProvider: null,
    });
  });

  it("CLEARS the endpoint block when the override's local provider is not configured", async () => {
    const result = await run(
      { tui: { model: "pi:lmstudio:qwen/qwen3-8b" } },
      { localProviders: [OLLAMA_PROVIDER] },
    );
    // The model ref applies, but an unconfigured provider id is non-local → clear
    // (so the run cannot inherit the default local endpoint under the new name).
    expect(result.runtimeOptions).toEqual({
      model: expect.objectContaining({ sdk: "pi", provider: "lmstudio", model: "qwen/qwen3-8b" }),
      customProvider: null,
      customModel: null,
      modelCapabilities: null,
      isPrivateProvider: null,
    });
  });

  it("CLEARS the endpoint block when no local providers are configured", async () => {
    const result = await run({ tui: { model: "pi:lmstudio:qwen/qwen3-8b" } });
    expect(result.runtimeOptions).toEqual({
      model: expect.objectContaining({ sdk: "pi", provider: "lmstudio", model: "qwen/qwen3-8b" }),
      customProvider: null,
      customModel: null,
      modelCapabilities: null,
      isPrivateProvider: null,
    });
  });

  it("leaves the endpoint block UNTOUCHED for an effort-only override (no model)", async () => {
    const result = await run(
      { tui: { effort: "medium" } },
      { localProviders: [LMSTUDIO_PROVIDER] },
    );
    // No model override → the default block is correct for the default model, so
    // the four keys are neither set nor cleared (no null sentinels emitted).
    expect(result.runtimeOptions).toEqual({ effort: "medium" });
  });

  it("CLEARS the block and warns (never fails) for a misconfigured local provider", async () => {
    const logger = { warn: vi.fn() };
    const result = await run(
      { tui: { model: "pi:gateway:gpt-oss" } },
      {
        logger,
        // Untrusted public HTTP URL → runtimeOptionsForLocalProvider throws; the
        // extension warns-and-ignores and treats it as non-local (block cleared).
        localProviders: [{ id: "gateway", type: "openai_compat", baseUrl: "http://api.example.com", enabled: true }],
      },
    );
    expect(result.runtimeOptions.model).toEqual(
      expect.objectContaining({ sdk: "pi", provider: "gateway", model: "gpt-oss" }),
    );
    expect(result.runtimeOptions.customProvider).toBeNull();
    expect(result.runtimeOptions.customModel).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("local-provider endpoint"),
      expect.objectContaining({ model: "pi:gateway:gpt-oss" }),
    );
  });

  describe("effort keyword escalation", () => {
    it("escalates a plain interactive turn containing 'think' to high", async () => {
      const result = await run(undefined, {}, "think about this bug");
      expect(result.runtimeOptions.effort).toBe("high");
      expect(result.runtimeOptions.model).toBeUndefined();
    });

    it("escalates 'ultrathink' to max and 'extra think' to xhigh", async () => {
      expect((await run(undefined, {}, "ultrathink: what is 2+2")).runtimeOptions.effort).toBe("max");
      expect((await run(undefined, {}, "please extra think about it")).runtimeOptions.effort).toBe("xhigh");
    });

    it("escalates above the configured base effort", async () => {
      const result = await run(undefined, { baseEffort: "medium" }, "ultra think");
      expect(result.runtimeOptions.effort).toBe("max");
    });

    it("is a no-op when the base effort already meets the keyword level", async () => {
      const result = await run(undefined, { baseEffort: "xhigh" }, "think about this");
      expect(result.runtimeOptions.effort).toBeUndefined();
    });

    it("is a no-op without a trigger phrase or with word fragments", async () => {
      expect((await run(undefined, {}, "keep thinking about it")).runtimeOptions.effort).toBeUndefined();
      expect((await run(undefined, {}, "rethink the approach")).runtimeOptions.effort).toBeUndefined();
      expect((await run(undefined, {})).runtimeOptions.effort).toBeUndefined();
    });

    it("never downgrades a higher metadata effort override", async () => {
      const result = await run({ webhook: { effort: "max" } }, {}, "think about this");
      expect(result.runtimeOptions.effort).toBe("max");
    });

    it("outranks a lower metadata effort override", async () => {
      const result = await run({ webhook: { effort: "low" } }, {}, "ultra think through it");
      expect(result.runtimeOptions.effort).toBe("max");
    });

    it("escalates over the base effort when the metadata effort was invalid (warned and ignored)", async () => {
      const logger = { warn: vi.fn(), info: vi.fn() };
      const result = await run({ webhook: { effort: "turbo" } }, { logger, baseEffort: "low" }, "think it over");
      expect(result.runtimeOptions.effort).toBe("high");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("invalid per-request effort"),
        expect.objectContaining({ effort: "turbo" }),
      );
    });

    it("skips escalation when a configured fallback is direct OpenCode", async () => {
      const logger = { warn: vi.fn(), info: vi.fn() };
      const result = await run(
        undefined,
        {
          logger,
          baseModel: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.6-terra"),
          fallbackModels: [parseMonoRuntimeModelReference("opencode:github-copilot:gpt-5.1")],
        },
        "ultra think about it",
      );
      expect(result.runtimeOptions.effort).toBeUndefined();
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("keyword effort escalation for direct OpenCode"),
        expect.objectContaining({
          keyword: "ultra think",
          effort: "max",
          directOpenCodeModels: ["opencode:github-copilot:gpt-5.1"],
        }),
      );
    });

    it("skips escalation when the accepted model override is direct OpenCode", async () => {
      const logger = { warn: vi.fn(), info: vi.fn() };
      const result = await run(
        { tui: { model: "opencode:github-copilot:gpt-5.1" } },
        { logger },
        "ultra think about it",
      );
      expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ sdk: "opencode" }));
      expect(result.runtimeOptions.effort).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("keyword effort escalation for direct OpenCode"),
        expect.objectContaining({ keyword: "ultra think", effort: "max" }),
      );
    });

    it("logs the matched keyword and the from/to efforts via logger.info", async () => {
      const logger = { warn: vi.fn(), info: vi.fn() };
      await run(undefined, { logger, baseEffort: "medium" }, "Ultra Think this through");
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Escalating per-turn effort"),
        expect.objectContaining({ keyword: "Ultra Think", from: "medium", to: "max" }),
      );
    });
  });
});

// Mirrors the app.ts wiring shape: sibling extensions composed BEFORE the
// model-override extension, merged later-wins — escalation must survive the
// merge and sibling keys must not be dropped.
describe("composeRuntimeOptionExtensions with keyword escalation", () => {
  it("escalates from the harness request userMessage and preserves sibling runtime options", async () => {
    const sibling = async () => ({
      runtimeOptions: {
        mcpServers: { memo: { url: "http://127.0.0.1:1" } },
        allowedTools: ["memo_tool"],
      },
      cleanup: async () => {},
    });
    const overrideExtension = createRequestModelOverrideRuntimeExtension({ baseEffort: "medium" });
    const composed = composeRuntimeOptionExtensions([
      sibling,
      async (input) => overrideExtension({ request: input.request }),
    ]);
    expect(composed).toBeDefined();

    const input = {
      request: {
        conversationId: "conv-1",
        userMessage: "please ultrathink this",
        abortSignal: new AbortController().signal,
      },
      runId: "run-1",
      context: {},
    } as unknown as AgentHarnessRuntimeOptionsInput;
    const result = await composed!(input);

    expect(result.runtimeOptions?.effort).toBe("max");
    expect(result.runtimeOptions?.mcpServers).toEqual({ memo: { url: "http://127.0.0.1:1" } });
    expect(result.runtimeOptions?.allowedTools).toContain("memo_tool");
    await result.cleanup?.();
  });
});
