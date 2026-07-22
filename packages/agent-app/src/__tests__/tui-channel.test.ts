import { describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { DiscoveredLocalModel, LocalProviderDefinition } from "@mono-agent/runtime-adapter";
import type { TuiAdapterConfig, TuiAdapterInfo, TuiAdapterOptions, TuiAdapterStartResult } from "@mono-agent/operator-adapter";

import type { ChannelStartInput } from "../channels.js";
import { createTuiChannelDriver } from "../channels.js";

const noopResponder: AgentResponder = {
  async respond() {
    return {};
  },
};

const baseConfig: TuiAdapterConfig = {
  enabled: true,
  host: "127.0.0.1",
  port: 0,
  basePath: "/gui",
  allowNonLoopback: false,
};

interface BuildInputOptions {
  readonly effort?: string;
  readonly fallbackModels?: readonly { sdk: string; model: string; provider?: string; reference?: string }[];
  readonly localProviders?: readonly LocalProviderDefinition[];
}

function baseInput(options: BuildInputOptions = {}): ChannelStartInput<TuiAdapterConfig> {
  return {
    coreConfig: {
      runtime: {
        model: { sdk: "claude", model: "claude-fable-5" },
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        ...(options.fallbackModels === undefined ? {} : { fallbackModels: options.fallbackModels }),
      },
      ...(options.localProviders === undefined ? {} : { providers: { local: options.localProviders } }),
    } as never,
    responder: noopResponder,
    cwd: "/tmp",
    onFailure: () => {},
    config: baseConfig,
  };
}

interface StartOptions extends BuildInputOptions {
  readonly discoverModels?: (
    providers: readonly LocalProviderDefinition[] | undefined,
  ) => Promise<readonly DiscoveredLocalModel[]>;
}

async function startCapturingTui(options: StartOptions = {}): Promise<TuiAdapterOptions> {
  let captured: TuiAdapterOptions | undefined;
  const driver = createTuiChannelDriver({
    adapterFactory: (adapterOptions): Promise<TuiAdapterStartResult> => {
      captured = adapterOptions;
      return Promise.resolve({
        url: "http://127.0.0.1:0",
        baseUrl: "http://127.0.0.1:0/gui",
        infoUrl: "http://127.0.0.1:0/gui/v1/info",
        turnsUrl: "http://127.0.0.1:0/gui/v1/turns",
        host: "127.0.0.1",
        port: 0,
        stop: () => Promise.resolve(),
      });
    },
    ...(options.discoverModels === undefined ? {} : { discoverModels: options.discoverModels }),
  });

  await driver.start(baseInput(options));
  if (captured === undefined) {
    throw new Error("TUI adapter was not started.");
  }
  return captured;
}

/** `captured.info` is always an info PROVIDER (see design note on createTuiChannelDriver); resolve it. */
async function resolveInfo(captured: TuiAdapterOptions): Promise<TuiAdapterInfo> {
  if (typeof captured.info !== "function") {
    throw new Error("Expected info to be a provider function.");
  }
  return await captured.info();
}

describe("tui channel driver — info composition", () => {
  it("passes the configured runtime effort through to the adapter's info", async () => {
    const captured = await startCapturingTui({ effort: "high" });
    const info = await resolveInfo(captured);

    expect(info).toEqual({
      model: "claude:claude-fable-5",
      effort: "high",
      models: ["claude:claude-fable-5"],
      modelOptions: { "claude:claude-fable-5": { reasoning: true } },
    });
  });

  it("omits effort from info when the runtime has none configured", async () => {
    const captured = await startCapturingTui();
    const info = await resolveInfo(captured);

    expect(info).toEqual({
      model: "claude:claude-fable-5",
      models: ["claude:claude-fable-5"],
      modelOptions: { "claude:claude-fable-5": { reasoning: true } },
    });
  });

  it("lists the primary then fallback models as candidate models, de-duplicated", async () => {
    const captured = await startCapturingTui({
      fallbackModels: [
        { sdk: "codex", model: "gpt-5.5" },
        { sdk: "claude", model: "claude-fable-5" },
      ],
    });
    const info = await resolveInfo(captured);

    expect(info.models).toEqual(["claude:claude-fable-5", "codex:gpt-5.5"]);
  });

  it("publishes known direct and Pi context windows, preferring configured Pi capabilities", async () => {
    const captured = await startCapturingTui({
      fallbackModels: [
        { sdk: "codex", model: "gpt-5.6-sol" },
        { sdk: "pi", provider: "openai-codex", model: "gpt-5.5" },
        { sdk: "pi", provider: "openai-codex", model: "gpt-5.6-terra" },
        { sdk: "pi", provider: "openai-codex", model: "gpt-5.4" },
        { sdk: "pi", provider: "anthropic", model: "claude-sonnet-4-6" },
        { sdk: "pi", provider: "unknown-provider", model: "unknown-model" },
      ],
      localProviders: [{
        id: "openai-codex",
        type: "openai_compat",
        baseUrl: "http://localhost:1234",
        enabled: true,
        models: [
          {
            name: "gpt-5.5",
            capabilities: { context_window: 16_384, num_ctx: 8_192 },
          },
          {
            name: "gpt-5.6-terra",
            capabilities: { num_ctx: 32_768 },
          },
          {
            name: "gpt-5.4",
            capabilities: { context_window: 0, num_ctx: -1 },
          },
        ],
      }],
      discoverModels: async () => [],
    });
    const info = await resolveInfo(captured);

    expect(info.modelOptions?.["codex:gpt-5.6-sol"]?.contextWindow).toBe(372_000);
    expect(info.modelOptions?.["pi:openai-codex:gpt-5.5"]?.contextWindow).toBe(16_384);
    expect(info.modelOptions?.["pi:openai-codex:gpt-5.6-terra"]?.contextWindow).toBe(32_768);
    expect(info.modelOptions?.["pi:openai-codex:gpt-5.4"]).not.toHaveProperty("contextWindow");
    expect(info.modelOptions?.["pi:anthropic:claude-sonnet-4-6"]?.contextWindow).toBe(1_000_000);
    expect(info.modelOptions?.["pi:unknown-provider:unknown-model"]).not.toHaveProperty("contextWindow");
    expect(info.modelOptions?.["claude:claude-fable-5"]).not.toHaveProperty("contextWindow");
  });

  it("degrades to no discovered models/no local modelOptions detail when no local providers are configured", async () => {
    const discoverModels = vi.fn().mockResolvedValue([]);
    const captured = await startCapturingTui({ discoverModels });
    const info = await resolveInfo(captured);

    expect(info.models).toEqual(["claude:claude-fable-5"]);
    // The configured cloud model still gets a `reasoning: true` degrade entry
    // (so the TUI knows it's reasoning-capable) but no precise effortLevels.
    expect(info.modelOptions).toEqual({ "claude:claude-fable-5": { reasoning: true } });
  });

  it("includes locally discovered models in info.models and their resolved effort levels in info.modelOptions", async () => {
    const localProviders: readonly LocalProviderDefinition[] = [
      {
        id: "lmstudio",
        type: "lmstudio",
        baseUrl: "http://localhost:1234",
        enabled: true,
        models: [
          {
            name: "qwen/qwen3-8b",
            capabilities: {
              reasoning: true,
              reasoning_mode: "effort",
              reasoning_levels: ["low", "medium", "high"],
              context_window: 65_536,
            },
          },
        ],
      },
    ];
    const discoverModels = vi.fn().mockResolvedValue([
      { ref: "pi:lmstudio:qwen/qwen3-8b", label: "qwen/qwen3-8b", providerId: "lmstudio" },
      { ref: "pi:lmstudio:llama-3.1", label: "llama-3.1", providerId: "lmstudio" },
    ] satisfies DiscoveredLocalModel[]);

    const captured = await startCapturingTui({ localProviders, discoverModels });
    const info = await resolveInfo(captured);

    expect(info.models).toEqual([
      "claude:claude-fable-5",
      "pi:lmstudio:qwen/qwen3-8b",
      "pi:lmstudio:llama-3.1",
    ]);
    expect(info.modelOptions).toEqual({
      "claude:claude-fable-5": { reasoning: true },
      "pi:lmstudio:qwen/qwen3-8b": {
        effortLevels: ["low", "medium", "high"],
        reasoning: true,
        reasoningMode: "effort",
        label: "qwen/qwen3-8b",
        contextWindow: 65_536,
      },
      "pi:lmstudio:llama-3.1": { reasoning: false, reasoningMode: "none", label: "llama-3.1" },
    });
    expect(discoverModels).toHaveBeenCalledWith(localProviders);
  });

  it("surfaces reasoningMode:'toggle' (no effortLevels) for a discovered Ollama toggle-reasoning model (e.g. qwen)", async () => {
    const localProviders: readonly LocalProviderDefinition[] = [
      { id: "ollama", type: "ollama", baseUrl: "http://localhost:11434", enabled: true },
    ];
    const discoverModels = vi.fn().mockResolvedValue([
      { ref: "pi:ollama:qwen3.6:latest", label: "qwen3.6:latest", providerId: "ollama" },
      { ref: "pi:ollama:gpt-oss:20b", label: "gpt-oss:20b", providerId: "ollama" },
    ] satisfies DiscoveredLocalModel[]);

    const captured = await startCapturingTui({ localProviders, discoverModels });
    const info = await resolveInfo(captured);

    // Toggle model carries the mode but NO graded effortLevels; the effort model
    // carries mode + levels. The TUI renders on/off vs graded from this.
    expect(info.modelOptions?.["pi:ollama:qwen3.6:latest"]).toEqual({
      reasoning: true,
      reasoningMode: "toggle",
      label: "qwen3.6:latest",
    });
    expect(info.modelOptions?.["pi:ollama:gpt-oss:20b"]).toEqual({
      effortLevels: ["low", "medium", "high"],
      reasoning: true,
      reasoningMode: "effort",
      label: "gpt-oss:20b",
    });
  });

  it("dedups a discovered model that collides with a config-listed model, keeping the config model first", async () => {
    const localProviders: readonly LocalProviderDefinition[] = [
      { id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true },
    ];
    const discoverModels = vi.fn().mockResolvedValue([
      { ref: "claude:claude-fable-5", label: "claude-fable-5", providerId: "lmstudio" },
      { ref: "pi:lmstudio:qwen3-8b", label: "qwen3-8b", providerId: "lmstudio" },
    ] satisfies DiscoveredLocalModel[]);

    const captured = await startCapturingTui({ localProviders, discoverModels });
    const info = await resolveInfo(captured);

    expect(info.models).toEqual(["claude:claude-fable-5", "pi:lmstudio:qwen3-8b"]);
  });

  it("caches discovered models within the TTL window, avoiding a fresh discovery call on every /v1/info", async () => {
    const localProviders: readonly LocalProviderDefinition[] = [
      { id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true },
    ];
    const discoverModels = vi.fn().mockResolvedValue([]);
    const captured = await startCapturingTui({ localProviders, discoverModels });

    await resolveInfo(captured);
    await resolveInfo(captured);
    await resolveInfo(captured);

    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("refreshes discovery once the TTL window elapses", async () => {
    vi.useFakeTimers();
    try {
      const localProviders: readonly LocalProviderDefinition[] = [
        { id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true },
      ];
      const discoverModels = vi.fn().mockResolvedValue([]);
      const captured = await startCapturingTui({ localProviders, discoverModels });

      await resolveInfo(captured);
      vi.advanceTimersByTime(30_001);
      await resolveInfo(captured);

      expect(discoverModels).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
