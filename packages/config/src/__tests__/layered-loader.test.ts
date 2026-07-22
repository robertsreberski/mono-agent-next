import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MonoAgentConfigError } from "../config.js";
import { loadMonoAgentConfigWithSources, layerJsonOntoEnv } from "../layered-loader.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-layer-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("layerJsonOntoEnv", () => {
  it("returns env values unchanged when JSON is empty", () => {
    const layered = layerJsonOntoEnv({}, { FOO: "bar" });
    expect(layered).toEqual({ FOO: "bar" });
  });

  it("translates JSON sections to env keys", () => {
    const layered = layerJsonOntoEnv(
      {
        agent: { name: "Research Partner" },
        runtime: {
          model: "pi:openai-codex:gpt-5.5",
          fallbacks: [
            { model: "claude:claude-sonnet-4-6", effort: "low" },
            { model: "pi:ollama:gemma4:31b" },
          ],
          routeSafety: "per-route-native",
          maxTurns: 12,
        },
        context: { identityPath: "IDENTITY.md", selectedSkills: ["a", "b"] },
        memory: {
          mode: "journal",
          path: ".mono-agent/memory",
        },
        tools: {
          allowedTools: ["Read"],
          disallowedTools: ["Bash"],
          mcpRequestContextServers: ["transcribe"],
          continuationServers: ["a8c-control"],
          mcpCallTimeoutMs: 150000,
          mcpCallMaxTotalTimeoutMs: 2700000,
        },
        artifacts: {
          dir: ".mono-agent/artifacts",
          retention: { maxAgeDays: 21, maxCount: 300, dryRun: true },
          memoryRetention: { maxAgeDays: 5, maxCount: 30, dryRun: false },
        },
        traceability: { registryDir: ".mono-agent/traces", sourceId: "json-source", staleAfterMs: 60000 },
        providers: {
          piAuthPath: ".pi/auth.json",
          local: [
            {
              id: "ollama",
              type: "ollama",
              baseUrl: "http://localhost:11434",
              enabled: true,
            },
          ],
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_NAME).toBe("Research Partner");
    expect(layered.MONO_AGENT_MODEL).toBe("pi:openai-codex:gpt-5.5");
    expect(JSON.parse(layered.MONO_AGENT_FALLBACKS_JSON ?? "[]")).toEqual([
      { model: "claude:claude-sonnet-4-6", effort: "low" },
      { model: "pi:ollama:gemma4:31b" },
    ]);
    expect(layered.MONO_AGENT_ROUTE_SAFETY).toBe("per-route-native");
    expect(layered.MONO_AGENT_MAX_TURNS).toBe("12");
    expect(layered.MONO_AGENT_IDENTITY_PATH).toBe("IDENTITY.md");
    expect(layered.MONO_AGENT_SELECTED_SKILLS).toBe("a,b");
    expect(layered.MONO_AGENT_MEMORY_MODE).toBe("journal");
    expect(layered.MONO_AGENT_MEMORY_PATH).toBe(".mono-agent/memory");
    expect(layered.MONO_AGENT_ALLOWED_TOOLS).toBe("Read");
    expect(layered.MONO_AGENT_DISALLOWED_TOOLS).toBe("Bash");
    expect(layered.MONO_AGENT_MCP_REQUEST_CONTEXT_SERVERS).toBe("transcribe");
    expect(layered.MONO_AGENT_CONTINUATION_SERVERS).toBe("a8c-control");
    expect(layered.MONO_AGENT_MCP_CALL_TIMEOUT_MS).toBe("150000");
    expect(layered.MONO_AGENT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS).toBe("2700000");
    expect(layered.MONO_AGENT_ARTIFACT_DIR).toBe(".mono-agent/artifacts");
    expect(layered.MONO_AGENT_ARTIFACT_RETENTION_MAX_AGE_DAYS).toBe("21");
    expect(layered.MONO_AGENT_ARTIFACT_RETENTION_MAX_COUNT).toBe("300");
    expect(layered.MONO_AGENT_ARTIFACT_RETENTION_DRY_RUN).toBe("true");
    expect(layered.MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_AGE_DAYS).toBe("5");
    expect(layered.MONO_AGENT_ARTIFACT_MEMORY_RETENTION_MAX_COUNT).toBe("30");
    expect(layered.MONO_AGENT_ARTIFACT_MEMORY_RETENTION_DRY_RUN).toBe("false");
    expect(layered.MONO_AGENT_TRACE_REGISTRY_DIR).toBe(".mono-agent/traces");
    expect(layered.MONO_AGENT_TRACE_SOURCE_ID).toBe("json-source");
    expect(layered.MONO_AGENT_TRACE_STALE_AFTER_MS).toBe("60000");
    expect(layered.MONO_AGENT_PI_AUTH_PATH).toBe(".pi/auth.json");
    expect(JSON.parse(layered.MONO_AGENT_LOCAL_PROVIDERS_JSON ?? "[]")).toEqual([
      {
        id: "ollama",
        type: "ollama",
        baseUrl: "http://localhost:11434",
        enabled: true,
      },
    ]);
  });

  it("lets either fallback env form override JSON without cross-form ambiguity", () => {
    const json = {
      runtime: { fallbacks: [{ model: "claude:claude-sonnet-4-6" }] },
    } as const;
    const legacy = layerJsonOntoEnv(json, { MONO_AGENT_FALLBACK_MODELS: "codex:gpt-5.6-sol" });
    expect(legacy.MONO_AGENT_FALLBACK_MODELS).toBe("codex:gpt-5.6-sol");
    expect(legacy.MONO_AGENT_FALLBACKS_JSON).toBeUndefined();

    const canonical = layerJsonOntoEnv(
      { runtime: { fallbackModels: ["claude:claude-sonnet-4-6"] } },
      { MONO_AGENT_FALLBACKS_JSON: JSON.stringify([{ model: "codex:gpt-5.6-sol" }]) },
    );
    expect(canonical.MONO_AGENT_FALLBACKS_JSON).toContain("gpt-5.6-sol");
    expect(canonical.MONO_AGENT_FALLBACK_MODELS).toBeUndefined();
  });

  it("treats an explicitly empty legacy fallback env as a JSON-clearing override", async () => {
    const json = {
      runtime: {
        model: "codex:gpt-5.6-terra",
        fallbackModels: ["claude:claude-sonnet-4-6"],
      },
      context: { identityPath: "IDENTITY.md" },
    } as const;
    const layered = layerJsonOntoEnv(json, { MONO_AGENT_FALLBACK_MODELS: "" });
    expect(layered.MONO_AGENT_FALLBACK_MODELS).toBe("");
    expect(layered.MONO_AGENT_FALLBACKS_JSON).toBeUndefined();

    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify(json));
    const loaded = await loadMonoAgentConfigWithSources({
      cwd: "/repo",
      env: { MONO_AGENT_FALLBACK_MODELS: "" },
      jsonPath: configPath,
    });
    expect(loaded.runtime.fallbackModels).toBeUndefined();
    expect(loaded.runtime.fallbacks).toBeUndefined();
  });

  it("translates JSON providers.piNative knobs to env keys", () => {
    const layered = layerJsonOntoEnv(
      {
        providers: {
          piNative: { transport: "sse", piMaxRetries: 4, maxRetryDelayMs: 30000, piSessionsRoot: ".mono-agent/sessions" },
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_PI_MAX_RETRIES).toBe("4");
    expect(layered.MONO_AGENT_PI_TRANSPORT).toBe("sse");
    expect(layered.MONO_AGENT_MAX_RETRY_DELAY_MS).toBe("30000");
    expect(layered.MONO_AGENT_PI_SESSIONS_ROOT).toBe(".mono-agent/sessions");
  });

  it("translates JSON runtime permission mode to env keys", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { permissionMode: "bypassPermissions" } },
      {},
    );
    expect(layered.MONO_AGENT_PERMISSION_MODE).toBe("bypassPermissions");
  });

  it("lets env override JSON permission mode", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { permissionMode: "bypassPermissions" } },
      {
        MONO_AGENT_PERMISSION_MODE: "default",
      },
    );
    expect(layered.MONO_AGENT_PERMISSION_MODE).toBe("default");
  });

  it("translates runtime.compaction JSON and lets env override individual fields", () => {
    const layered = layerJsonOntoEnv(
      {
        runtime: {
          compaction: {
            enabled: false,
            triggerRatio: 0.75,
            keepRecentTokens: 9_000,
            summaryMaxTokens: 3_000,
            minSavingsTokens: 7_000,
            fixedOverheadEnabled: false,
            contextWindowOverride: 272_000,
          },
        },
      },
      {
        MONO_AGENT_COMPACTION_ENABLED: "true",
        MONO_AGENT_COMPACTION_KEEP_RECENT_TOKENS: "12000",
      },
    );
    expect(layered).toMatchObject({
      MONO_AGENT_COMPACTION_ENABLED: "true",
      MONO_AGENT_COMPACTION_TRIGGER_RATIO: "0.75",
      MONO_AGENT_COMPACTION_KEEP_RECENT_TOKENS: "12000",
      MONO_AGENT_COMPACTION_SUMMARY_MAX_TOKENS: "3000",
      MONO_AGENT_COMPACTION_MIN_SAVINGS_TOKENS: "7000",
      MONO_AGENT_COMPACTION_FIXED_OVERHEAD_ENABLED: "false",
      MONO_AGENT_COMPACTION_CONTEXT_WINDOW_OVERRIDE: "272000",
    });
  });

  it("loads runtime.compaction from JSON with env precedence", async () => {
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({
      runtime: {
        model: "pi:openai-codex:gpt-5.5",
        compaction: { triggerRatio: 0.75, summaryMaxTokens: 3_000 },
      },
      context: { identityPath: "IDENTITY.md" },
    }));
    const loaded = await loadMonoAgentConfigWithSources({
      cwd: "/repo",
      jsonPath: configPath,
      env: { MONO_AGENT_COMPACTION_TRIGGER_RATIO: "0.8" },
    });
    expect(loaded.runtime.compaction).toEqual({
      enabled: true,
      triggerRatio: 0.8,
      summaryMaxTokens: 3_000,
      fixedOverheadEnabled: true,
    });
  });

  it.each([
    ["not-an-object", "runtime.compaction"],
    [{ enabled: "yes" }, "runtime.compaction.enabled"],
    [{ triggerRatio: 0.1 }, "runtime.compaction.triggerRatio"],
    [{ keepRecentTokens: 4_000.5 }, "runtime.compaction.keepRecentTokens"],
    [{ summaryMaxTokens: 999 }, "runtime.compaction.summaryMaxTokens"],
    [{ minSavingsTokens: -1 }, "runtime.compaction.minSavingsTokens"],
    [{ fixedOverheadEnabled: "yes" }, "runtime.compaction.fixedOverheadEnabled"],
    [{ contextWindowOverride: 31_999 }, "runtime.compaction.contextWindowOverride"],
  ])("rejects invalid runtime.compaction JSON at %s", (compaction, path) => {
    expect(() => layerJsonOntoEnv({ runtime: { compaction: compaction as never } }, {}))
      .toThrowError(expect.objectContaining({ code: "invalid_json", details: expect.objectContaining({ path }) }));
  });

  it("translates JSON concurrency to env keys", () => {
    const layered = layerJsonOntoEnv(
      { concurrency: { maxConcurrentRuns: 4 } },
      {},
    );
    expect(layered.MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS).toBe("4");
  });

  it("translates JSON concurrency.maxPendingRuns to env keys", () => {
    const layered = layerJsonOntoEnv(
      { concurrency: { maxConcurrentRuns: 4, maxPendingRuns: 16 } },
      {},
    );
    expect(layered.MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS).toBe("4");
    expect(layered.MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS).toBe("16");
  });

  it("lets env override JSON concurrency", () => {
    const layered = layerJsonOntoEnv(
      { concurrency: { maxConcurrentRuns: 4, maxPendingRuns: 16 } },
      {
        MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS: "8",
        MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS: "32",
      },
    );
    expect(layered.MONO_AGENT_CONCURRENCY_MAX_CONCURRENT_RUNS).toBe("8");
    expect(layered.MONO_AGENT_CONCURRENCY_MAX_PENDING_RUNS).toBe("32");
  });

  it("translates JSON memory embeddings timeoutMs and circuit breaker to env keys", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          mode: "journal",
          path: ".mono-agent/memory",
          embeddings: {
            provider: "ollama",
            model: "nomic-embed-text",
            timeoutMs: 5000,
            circuitBreaker: { failureThreshold: 5, cooldownMs: 20000 },
          },
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_EMBEDDINGS_TIMEOUT_MS).toBe("5000");
    expect(layered.MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_FAILURE_THRESHOLD).toBe("5");
    expect(layered.MONO_AGENT_MEMORY_EMBEDDINGS_CIRCUIT_BREAKER_COOLDOWN_MS).toBe("20000");
  });

  it("loads keyless LM Studio embeddings and preserves an unresolved JSON credential reference", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        mode: "journal",
        path: ".mono-agent/memory",
        embeddings: {
          provider: "lmstudio",
          model: "embed-model",
          endpoint: "http://localhost:1234",
          apiKeyEnv: "LM_STUDIO_API_KEY",
          dim: 768,
        },
      },
    }), "utf8");

    const config = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });

    expect(config.memory?.embeddings).toEqual({
      provider: "lmstudio",
      model: "embed-model",
      endpoint: "http://localhost:1234",
      apiKeyEnv: "LM_STUDIO_API_KEY",
      dim: 768,
    });
    expect(config.memory?.embeddings?.apiKey).toBeUndefined();
  });

  it("translates JSON memory.recallTool.enabled to an env key", () => {
    const layered = layerJsonOntoEnv(
      { memory: { mode: "journal", path: ".mono-agent/memory", recallTool: { enabled: false } } },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED).toBe("false");
  });

  it("lets env override JSON memory.recallTool.enabled", () => {
    const layered = layerJsonOntoEnv(
      { memory: { mode: "journal", path: ".mono-agent/memory", recallTool: { enabled: false } } },
      { MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED: "true" },
    );
    expect(layered.MONO_AGENT_MEMORY_RECALL_TOOL_ENABLED).toBe("true");
  });

  it("translates the JSON memory.backend + supermemory block to env keys", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          backend: "supermemory",
          path: ".mono-agent/memory",
          supermemory: {
            baseUrl: "http://127.0.0.1:8080",
            apiKeyEnv: "SM_KEY",
            container: "agent-alpha",
            timeoutMs: 5000,
            exposeMcpServer: true,
          },
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_BACKEND).toBe("supermemory");
    expect(layered.MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL).toBe("http://127.0.0.1:8080");
    expect(layered.MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY_ENV).toBe("SM_KEY");
    expect(layered.MONO_AGENT_MEMORY_SUPERMEMORY_CONTAINER).toBe("agent-alpha");
    expect(layered.MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS).toBe("5000");
    expect(layered.MONO_AGENT_MEMORY_SUPERMEMORY_EXPOSE_MCP_SERVER).toBe("true");
  });

  it("translates JSON runtime.session to env keys", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { session: { mode: "per-message", idleTimeoutMs: 120_000, rolloverNotice: true } } },
      {},
    );
    expect(layered.MONO_AGENT_SESSION_MODE).toBe("per-message");
    expect(layered.MONO_AGENT_SESSION_IDLE_TIMEOUT_MS).toBe("120000");
    expect(layered.MONO_AGENT_SESSION_ROLLOVER_NOTICE).toBe("true");
  });

  it("lets env override JSON session values", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { session: { mode: "per-message", idleTimeoutMs: 120_000, rolloverNotice: true } } },
      {
        MONO_AGENT_SESSION_MODE: "continuous",
        MONO_AGENT_SESSION_IDLE_TIMEOUT_MS: "5000",
        MONO_AGENT_SESSION_ROLLOVER_NOTICE: "false",
      },
    );
    expect(layered.MONO_AGENT_SESSION_MODE).toBe("continuous");
    expect(layered.MONO_AGENT_SESSION_IDLE_TIMEOUT_MS).toBe("5000");
    expect(layered.MONO_AGENT_SESSION_ROLLOVER_NOTICE).toBe("false");
  });

  it("lets env override JSON values", () => {
    const layered = layerJsonOntoEnv(
      {
        runtime: { maxTurns: 4 },
        providers: {
          piAuthPath: ".json/pi-auth.json",
          local: [{ id: "json-ollama", type: "ollama", baseUrl: "http://localhost:11434" }],
        },
      },
      {
        MONO_AGENT_MAX_TURNS: "16",
        MONO_AGENT_PI_AUTH_PATH: "/env/pi-auth.json",
        MONO_AGENT_LOCAL_PROVIDER_ID: "ollama",
        MONO_AGENT_LOCAL_PROVIDER_TYPE: "ollama",
      },
    );
    expect(layered.MONO_AGENT_MAX_TURNS).toBe("16");
    expect(layered.MONO_AGENT_PI_AUTH_PATH).toBe("/env/pi-auth.json");
    expect(layered.MONO_AGENT_LOCAL_PROVIDERS_JSON).toBeUndefined();
    expect(layered.MONO_AGENT_LOCAL_PROVIDER_ID).toBe("ollama");
  });

  it("translates the JSON sandbox section to env keys", () => {
    const layered = layerJsonOntoEnv(
      {
        sandbox: {
          mode: "native",
          network: { mode: "allowlist", allowlist: ["github.com", "api.github.com"] },
          readableRoots: [".", "../shared-docs"],
          writableRoots: ["out"],
          denyWrite: [".env", "secrets/**"],
          fallback: "fail-closed",
          unsafeAllowHostProcess: false,
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_SANDBOX_MODE).toBe("native");
    expect(layered.MONO_AGENT_SANDBOX_NETWORK).toBe("allowlist");
    expect(layered.MONO_AGENT_SANDBOX_NETWORK_ALLOWLIST).toBe("github.com,api.github.com");
    expect(layered.MONO_AGENT_SANDBOX_READABLE_ROOTS).toBe(".,../shared-docs");
    expect(layered.MONO_AGENT_SANDBOX_WRITABLE_ROOTS).toBe("out");
    expect(layered.MONO_AGENT_SANDBOX_DENY_WRITE).toBe(".env,secrets/**");
    expect(layered.MONO_AGENT_SANDBOX_FALLBACK).toBe("fail-closed");
    expect(layered.MONO_AGENT_SANDBOX_UNSAFE_ALLOW_HOST_PROCESS).toBe("false");
  });

  it("translates JSON memory embeddings to env keys (graphPath is a no-op — retired)", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          mode: "journal",
          path: ".mono-agent/memory",
          embeddings: {
            provider: "ollama",
            model: "nomic-embed-text",
            endpoint: "http://localhost:11434",
            apiKeyEnv: "EMBEDDINGS_KEY",
          },
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_GRAPH_PATH).toBeUndefined();
    expect(layered.MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER).toBe("ollama");
    expect(layered.MONO_AGENT_MEMORY_EMBEDDINGS_MODEL).toBe("nomic-embed-text");
    expect(layered.MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT).toBe("http://localhost:11434");
    expect(layered.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY_ENV).toBe("EMBEDDINGS_KEY");
  });

  it("translates JSON memory bujo mode and llm block to env keys", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          embeddings: { provider: "ollama", model: "nomic-embed-text", dim: 768 },
          llm: { provider: "ollama", model: "qwen3.6:latest", endpoint: "http://localhost:11434" },
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_MODE).toBe("bujo");
    expect(layered.MONO_AGENT_MEMORY_EMBEDDINGS_DIM).toBe("768");
    expect(layered.MONO_AGENT_MEMORY_LLM_PROVIDER).toBe("ollama");
    expect(layered.MONO_AGENT_MEMORY_LLM_MODEL).toBe("qwen3.6:latest");
    expect(layered.MONO_AGENT_MEMORY_LLM_ENDPOINT).toBe("http://localhost:11434");
  });

  it("translates JSON agent-host memory llm block to env keys", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          llm: { provider: "agent-host", model: "pi:openai-codex:gpt-5.5", executionMode: "sdk" },
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_LLM_PROVIDER).toBe("agent-host");
    expect(layered.MONO_AGENT_MEMORY_LLM_MODEL).toBe("pi:openai-codex:gpt-5.5");
    expect(layered.MONO_AGENT_MEMORY_LLM_EXECUTION_MODE).toBe("sdk");
    expect(layered.MONO_AGENT_MEMORY_LLM_ENDPOINT).toBeUndefined();
  });

  it("preserves an invalid JSON agent-host endpoint so config validation can reject it", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: ".mono-agent/memory",
        embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
        llm: {
          provider: "agent-host",
          model: "pi:openai-codex:gpt-5.5",
          executionMode: "sdk",
          endpoint: "http://127.0.0.1:11434",
        },
      },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
        MONO_AGENT_MEMORY_LLM_MODEL: "pi:openai-codex:gpt-5.5",
      },
      cwd: dir,
      jsonPath: path,
    })).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: "memory.llm.endpoint", code: "invalid_json" },
    });
  });

  it("translates JSON memory llm timeoutMs to its env key", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          llm: { provider: "agent-host", model: "pi:opencode-go:kimi-k2.6", timeoutMs: 120000 },
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_LLM_TIMEOUT_MS).toBe("120000");
  });

  it("drops a stale JSON Ollama LLM endpoint when env switches memory llm to agent-host", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          llm: { provider: "ollama", model: "qwen3.6:latest", endpoint: "http://localhost:11434" },
        },
      },
      {
        MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
        MONO_AGENT_MEMORY_LLM_MODEL: "pi:openai-codex:gpt-5.5",
      },
    );
    expect(layered.MONO_AGENT_MEMORY_LLM_PROVIDER).toBe("agent-host");
    expect(layered.MONO_AGENT_MEMORY_LLM_MODEL).toBe("pi:openai-codex:gpt-5.5");
    expect(layered.MONO_AGENT_MEMORY_LLM_ENDPOINT).toBeUndefined();
  });

  it("preserves an explicit env endpoint so invalid agent-host env config can fail validation", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          llm: { provider: "ollama", model: "qwen3.6:latest", endpoint: "http://localhost:11434" },
        },
      },
      {
        MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
        MONO_AGENT_MEMORY_LLM_MODEL: "pi:openai-codex:gpt-5.5",
        MONO_AGENT_MEMORY_LLM_ENDPOINT: "http://localhost:11434",
      },
    );
    expect(layered.MONO_AGENT_MEMORY_LLM_PROVIDER).toBe("agent-host");
    expect(layered.MONO_AGENT_MEMORY_LLM_ENDPOINT).toBe("http://localhost:11434");
  });

  it("omits LLM env keys when llm block is absent in JSON", () => {
    const layered = layerJsonOntoEnv(
      { memory: { mode: "bujo", path: ".mono-agent/memory" } },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_LLM_MODEL).toBeUndefined();
    expect(layered.MONO_AGENT_MEMORY_LLM_PROVIDER).toBeUndefined();
    expect(layered.MONO_AGENT_MEMORY_LLM_ENDPOINT).toBeUndefined();
  });

  it("translates JSON memory consolidation block to env keys", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
          llm: { provider: "ollama", model: "qwen3.6:latest" },
          consolidation: { enabled: true, cron: "0 */2 * * *" },
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED).toBe("true");
    expect(layered.MONO_AGENT_MEMORY_CONSOLIDATION_CRON).toBe("0 */2 * * *");
  });

  it("omits consolidation env keys when consolidation block is absent in JSON", () => {
    const layered = layerJsonOntoEnv(
      { memory: { mode: "bujo", path: ".mono-agent/memory" } },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED).toBeUndefined();
    expect(layered.MONO_AGENT_MEMORY_CONSOLIDATION_CRON).toBeUndefined();
  });

  it("does not translate removed JSON reflection and migration blocks to env keys", () => {
    const layered = layerJsonOntoEnv(
      {
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          reflection: { enabled: true, cron: "0 3 * * *" },
          migration: { enabled: false, cron: "0 4 1 * *" },
        },
      },
      {},
    );
    expect(layered.MONO_AGENT_MEMORY_REFLECTION_ENABLED).toBeUndefined();
    expect(layered.MONO_AGENT_MEMORY_REFLECTION_CRON).toBeUndefined();
    expect(layered.MONO_AGENT_MEMORY_MIGRATION_ENABLED).toBeUndefined();
    expect(layered.MONO_AGENT_MEMORY_MIGRATION_CRON).toBeUndefined();
  });

  it("uses lite as the default memory mode when mode is omitted from JSON", () => {
    const layered = layerJsonOntoEnv(
      { memory: { path: ".mono-agent/memory" } },
      {},
    );
    // mode not set from JSON — the loader supplies the lite default
    expect(layered.MONO_AGENT_MEMORY_MODE).toBeUndefined();
  });

  it("translates JSON context.skillMaxBytes to an env key", () => {
    const layered = layerJsonOntoEnv(
      { context: { identityPath: "IDENTITY.md", skillMaxBytes: 24000 } },
      {},
    );
    expect(layered.MONO_AGENT_SKILL_MAX_BYTES).toBe("24000");
  });

  it("translates JSON context.skillDisclosure to an env key", () => {
    const layered = layerJsonOntoEnv(
      { context: { identityPath: "IDENTITY.md", skillDisclosure: "index" } },
      {},
    );
    expect(layered.MONO_AGENT_SKILL_DISCLOSURE).toBe("index");
  });

  it("omits MONO_AGENT_SKILL_DISCLOSURE when context.skillDisclosure is absent", () => {
    const layered = layerJsonOntoEnv(
      { context: { identityPath: "IDENTITY.md" } },
      {},
    );
    expect(layered.MONO_AGENT_SKILL_DISCLOSURE).toBeUndefined();
  });

  it("translates JSON runtime.session.isolateProactive to an env key", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { session: { isolateProactive: true } } },
      {},
    );
    expect(layered.MONO_AGENT_SESSION_ISOLATE_PROACTIVE).toBe("true");
  });

  it("translates JSON runtime.session.rolloverNotice false to an env key", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { session: { rolloverNotice: false } } },
      {},
    );
    expect(layered.MONO_AGENT_SESSION_ROLLOVER_NOTICE).toBe("false");
  });

  it("rejects non-boolean JSON runtime.session.rolloverNotice", () => {
    expect(() =>
      layerJsonOntoEnv(
        { runtime: { session: { rolloverNotice: "false" as unknown as boolean } } },
        {},
      ),
    ).toThrow(/runtime\.session\.rolloverNotice must be a boolean/u);
  });

  it("omits MONO_AGENT_SESSION_ISOLATE_PROACTIVE when session.isolateProactive is absent", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { session: { mode: "continuous" } } },
      {},
    );
    expect(layered.MONO_AGENT_SESSION_ISOLATE_PROACTIVE).toBeUndefined();
    expect(layered.MONO_AGENT_SESSION_ROLLOVER_NOTICE).toBeUndefined();
  });

  it("treats empty env values as absent so JSON wins", () => {
    const layered = layerJsonOntoEnv(
      { runtime: { maxTurns: 4 } },
      { MONO_AGENT_MAX_TURNS: "   " },
    );
    expect(layered.MONO_AGENT_MAX_TURNS).toBe("4");
  });

  it("translates JSON observability.exporters to MONO_AGENT_OBSERVABILITY_EXPORTERS", () => {
    const exporters = [
      {
        type: "phoenix",
        endpoint: "http://127.0.0.1:6006/v1/traces",
        includeSensitiveData: true,
        contentPatternRedaction: true,
      },
    ];
    const layered = layerJsonOntoEnv({ observability: { exporters } }, {});
    expect(JSON.parse(layered.MONO_AGENT_OBSERVABILITY_EXPORTERS ?? "[]")).toEqual(exporters);
  });

  it("lets env override JSON observability exporters", () => {
    const layered = layerJsonOntoEnv(
      {
        observability: {
          exporters: [{ type: "phoenix", endpoint: "http://json-host:6006/v1/traces" }],
        },
      },
      {
        MONO_AGENT_OBSERVABILITY_EXPORTERS: JSON.stringify([
          { type: "phoenix", endpoint: "http://env-host:6006/v1/traces" },
        ]),
      },
    );
    expect(JSON.parse(layered.MONO_AGENT_OBSERVABILITY_EXPORTERS ?? "[]")).toEqual([
      { type: "phoenix", endpoint: "http://env-host:6006/v1/traces" },
    ]);
  });
});

describe("loadMonoAgentConfigWithSources", () => {
  it("attributes strict Journal prerequisites to the JSON path that needs repair", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: { mode: "journal", path: ".mono-agent/memory" },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_json",
      message: expect.stringContaining("memory.embeddings"),
      details: { path: "memory.embeddings", code: "invalid_json" },
    });
  });

  it("attributes strict BuJo LLM prerequisites to the JSON path that needs repair", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: { mode: "bujo", path: ".mono-agent/memory", embeddings: { provider: "ollama" } },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_json",
      message: expect.stringContaining("memory.llm"),
      details: { path: "memory.llm", code: "invalid_json" },
    });
  });

  it.each([
    ["provider", { provider: "ollama" }],
    ["endpoint", { endpoint: "http://localhost:11434" }],
    ["executionMode", { executionMode: "sdk" }],
    ["trace", { trace: false }],
    ["timeoutMs", { timeoutMs: 120_000 }],
    ["provider and endpoint", { provider: "ollama", endpoint: "http://localhost:11434" }],
  ])("rejects a Journal JSON memory.llm block with only %s", async (_name, llm) => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        mode: "journal",
        path: ".mono-agent/memory",
        embeddings: { provider: "ollama" },
        llm,
      },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_json",
      message: expect.stringContaining("memory.llm"),
      details: { path: "memory.llm", code: "invalid_json" },
    });
  });

  it("retains env attribution when the strict memory tier came from env", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: { path: ".mono-agent/memory" },
    }), "utf8");

    try {
      await loadMonoAgentConfigWithSources({
        env: { MONO_AGENT_MEMORY_MODE: "journal" },
        cwd: dir,
        jsonPath: path,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect(error).toMatchObject({
        code: "invalid_env",
        details: { env: "MONO_AGENT_MEMORY_EMBEDDINGS_MODEL", code: "invalid_env" },
      });
      return;
    }
    throw new Error("Expected the env-selected Journal tier to fail.");
  });

  it.each([
    {
      mode: "lite",
      memory: {},
      env: { MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "nomic-embed-text:v1.5" },
      implicated: "MONO_AGENT_MEMORY_EMBEDDINGS_MODEL",
    },
    {
      mode: "journal",
      memory: { embeddings: { provider: "ollama" } },
      env: { MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest" },
      implicated: "MONO_AGENT_MEMORY_LLM_MODEL",
    },
    {
      mode: "journal",
      memory: { embeddings: { provider: "ollama" } },
      env: { MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED: "true" },
      implicated: "MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED",
    },
    {
      mode: "journal",
      memory: {},
      env: {
        MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "nomic-embed-text:v1.5",
        MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest",
      },
      implicated: "MONO_AGENT_MEMORY_LLM_MODEL",
    },
    {
      mode: "journal",
      memory: {},
      env: {
        MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "nomic-embed-text:v1.5",
        MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED: "true",
      },
      implicated: "MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED",
    },
    {
      mode: "journal",
      memory: {},
      env: {
        MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "ollama",
        MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest",
      },
      implicated: "MONO_AGENT_MEMORY_LLM_MODEL",
    },
  ])("attributes a mixed-source $mode incompatibility to $implicated", async ({ mode, memory, env, implicated }) => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: { mode, path: ".mono-agent/memory", ...memory },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({ env, cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_env",
      message: expect.stringContaining(implicated),
      details: { env: implicated, code: "invalid_env" },
    });
  });

  it.each([
    {
      name: "Journal JSON LLM with an env trace override",
      memory: {
        mode: "journal",
        embeddings: { provider: "ollama" },
        llm: { provider: "agent-host", model: "pi:openai-codex:gpt-5.5" },
      },
      env: { MONO_AGENT_MEMORY_LLM_TRACE: "false" },
      path: "memory.llm",
    },
    {
      name: "Journal JSON LLM with an env provider override",
      memory: {
        mode: "journal",
        embeddings: { provider: "ollama" },
        llm: { provider: "agent-host", model: "pi:openai-codex:gpt-5.5" },
      },
      env: { MONO_AGENT_MEMORY_LLM_PROVIDER: "ollama" },
      path: "memory.llm",
    },
    {
      name: "Lite JSON embeddings with an env LLM",
      memory: { mode: "lite", embeddings: { provider: "ollama" } },
      env: { MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest" },
      path: "memory.embeddings",
    },
    {
      name: "Journal JSON consolidation with an env LLM",
      memory: {
        mode: "journal",
        embeddings: { provider: "ollama" },
        consolidation: { enabled: true },
      },
      env: { MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest" },
      path: "memory.consolidation",
    },
  ])("keeps $name attributed to $path", async ({ memory, env, path: expectedPath }) => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: { path: ".mono-agent/memory", ...memory },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({ env, cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_json",
      message: expect.stringContaining(expectedPath),
      details: { path: expectedPath, code: "invalid_json" },
    });
  });

  it("lets an env tier override make a JSON capability valid", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        mode: "lite",
        path: ".mono-agent/memory",
        embeddings: { provider: "ollama" },
      },
    }), "utf8");

    const config = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MEMORY_MODE: "journal" },
      cwd: dir,
      jsonPath: path,
    });
    expect(config.memory?.mode).toBe("journal");
    expect(config.memory?.embeddings?.provider).toBe("ollama");
  });

  it("resolves an omitted tools block to the allow-all default (['*'])", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
      }),
      "utf8",
    );
    const config = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(config.tools.allowedTools).toEqual(["*"]);
  });

  it("resolves an explicit empty tools.allowedTools to [] (chat-only)", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        tools: { allowedTools: [] },
      }),
      "utf8",
    );
    const config = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(config.tools.allowedTools).toEqual([]);
  });

  it("loads config from JSON when env is missing the required fields", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 12 },
        context: { identityPath: "IDENTITY.md" },
        providers: {
          piAuthPath: ".worklab/auth.json",
          local: [
            {
              id: "ollama",
              type: "ollama",
              baseUrl: "http://localhost:11434",
              enabled: true,
              models: [{ name: "qwen3:8b", capabilities: { context_window: 32768 } }],
            },
          ],
        },
      }),
      "utf8",
    );
    const config = await loadMonoAgentConfigWithSources({
      env: {},
      cwd: dir,
      jsonPath: path,
    });
    expect(config.runtime.maxTurns).toBe(12);
    expect(config.runtime.model).toMatchObject({ sdk: "pi" });
    expect(config.providers?.piAuthPath).toBe(join(dir, ".worklab", "auth.json"));
    expect(config.providers?.local?.[0]?.models?.[0]?.capabilities).toMatchObject({ context_window: 32768 });
  });

  it("env local-provider settings beat JSON provider defaults", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:ollama:qwen3:8b" },
        context: { identityPath: "IDENTITY.md" },
        providers: {
          local: [{ id: "json-ollama", type: "ollama", baseUrl: "http://localhost:11434" }],
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_LOCAL_PROVIDER_ID: "ollama",
        MONO_AGENT_LOCAL_PROVIDER_TYPE: "ollama",
        MONO_AGENT_LOCAL_PROVIDER_BASE_URL: "http://localhost:11434",
      },
      cwd: dir,
      jsonPath: path,
    });
    expect(config.providers?.local?.map((provider) => provider.id)).toEqual(["ollama"]);
  });

  it("env beats JSON for overlapping fields", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 4 },
        context: { identityPath: "IDENTITY.md" },
      }),
      "utf8",
    );
    const config = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MAX_TURNS: "20" },
      cwd: dir,
      jsonPath: path,
    });
    expect(config.runtime.maxTurns).toBe(20);
  });

  it("treats a JSON runtime maxTurns value of zero as unlimited", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 0 },
        context: { identityPath: "IDENTITY.md" },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({
      env: {},
      cwd: dir,
      jsonPath: path,
    });

    expect(config.runtime.maxTurns).toBeUndefined();
  });

  it("lets env runtime max turns of zero override JSON to unlimited", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5", maxTurns: 4 },
        context: { identityPath: "IDENTITY.md" },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MAX_TURNS: "0" },
      cwd: dir,
      jsonPath: path,
    });

    expect(config.runtime.maxTurns).toBeUndefined();
  });

  it("loads session settings from JSON and lets env win for overlaps", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: {
          model: "pi:openai-codex:gpt-5.5",
          session: { mode: "per-message", idleTimeoutMs: 120_000 },
        },
        context: { identityPath: "IDENTITY.md" },
      }),
      "utf8",
    );

    const fromJson = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(fromJson.runtime.session).toEqual({ mode: "per-message", idleTimeoutMs: 120_000, rollover: "none" });

    const withEnv = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_SESSION_MODE: "continuous", MONO_AGENT_SESSION_IDLE_TIMEOUT_MS: "5000" },
      cwd: dir,
      jsonPath: path,
    });
    expect(withEnv.runtime.session).toEqual({ mode: "continuous", idleTimeoutMs: 5000, rollover: "none" });
  });

  it("loads session.rollover + rolloverTimezone from json and env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-rollover-"));
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: {
          model: "pi:openai-codex:gpt-5.5",
          session: { rollover: "daily", rolloverTimezone: "Europe/Rome" },
        },
        context: { identityPath: "IDENTITY.md" },
      }),
      "utf8",
    );

    const fromJson = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(fromJson.runtime.session.rollover).toBe("daily");
    expect(fromJson.runtime.session.rolloverTimezone).toBe("Europe/Rome");

    const withEnv = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_SESSION_ROLLOVER: "none", MONO_AGENT_SESSION_ROLLOVER_TIMEZONE: "UTC" },
      cwd: dir,
      jsonPath: path,
    });
    // Env overrides json (higher precedence).
    expect(withEnv.runtime.session.rollover).toBe("none");
    expect(withEnv.runtime.session.rolloverTimezone).toBe("UTC");
  });

  it("round-trips context.skillDisclosure + session.isolateProactive + session.rolloverNotice from JSON through to the config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-disclosure-isolate-"));
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: {
          model: "pi:openai-codex:gpt-5.5",
          session: { isolateProactive: true, rolloverNotice: true },
        },
        context: { identityPath: "IDENTITY.md", skillDisclosure: "index" },
      }),
      "utf8",
    );

    const fromJson = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(fromJson.context.skillDisclosure).toBe("index");
    expect(fromJson.runtime.session.isolateProactive).toBe(true);
    expect(fromJson.runtime.session.rolloverNotice).toBe(true);

    // These keys default to UNSET so legacy behavior is byte-for-byte preserved.
    const path2 = join(dir, "config2.json");
    await writeFile(
      path2,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
      }),
      "utf8",
    );
    const defaults = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path2 });
    expect(defaults.context.skillDisclosure).toBeUndefined();
    expect(defaults.runtime.session.isolateProactive).toBeUndefined();
    expect(defaults.runtime.session.rolloverNotice).toBeUndefined();

    // Env overrides JSON (higher precedence).
    const withEnv = await loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_SKILL_DISCLOSURE: "full",
        MONO_AGENT_SESSION_ISOLATE_PROACTIVE: "false",
        MONO_AGENT_SESSION_ROLLOVER_NOTICE: "false",
      },
      cwd: dir,
      jsonPath: path,
    });
    expect(withEnv.context.skillDisclosure).toBe("full");
    expect(withEnv.runtime.session.isolateProactive).toBe(false);
    expect(withEnv.runtime.session.rolloverNotice).toBe(false);
  });

  it("loads a sandbox policy from the JSON config file", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        sandbox: {
          mode: "native",
          network: { mode: "localhost" },
          denyWrite: [".env", "secrets/**"],
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(config.sandbox).toMatchObject({
      mode: "native",
      fallback: "fail-closed",
      network: { mode: "localhost" },
      denyWrite: [".env", "secrets/**"],
    });
  });

  it("loads memory embeddings from the JSON config file (graphPath is retired — ignored)", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        memory: {
          mode: "journal",
          path: ".mono-agent/memory",
          embeddings: { provider: "ollama" },
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(config.memory).not.toHaveProperty("graphPath");
    expect(config.memory?.embeddings).toEqual({ provider: "ollama", model: "nomic-embed-text:v1.5" });
  });

  it("treats a dim-only JSON embeddings block as explicit and applies provider/model defaults", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        memory: {
          mode: "journal",
          path: ".mono-agent/memory",
          embeddings: { dim: 768 },
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(config.memory?.embeddings).toEqual({
      provider: "ollama",
      model: "nomic-embed-text:v1.5",
      dim: 768,
    });
  });

  it("rejects an empty JSON embeddings block consistently with the published schema", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: { mode: "journal", path: ".mono-agent/memory", embeddings: {} },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: "memory.embeddings", code: "invalid_json" },
    });
  });

  it("ignores stale empty BuJo blocks when JSON selects the Supermemory backend", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        backend: "supermemory",
        mode: "bujo",
        writeMode: "capture",
        supermemory: { baseUrl: "http://127.0.0.1:6767" },
        embeddings: {},
        llm: {},
      },
    }), "utf8");

    const config = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(config.memory).toMatchObject({
      backend: "supermemory",
      writeMode: "capture",
      supermemory: { baseUrl: "http://127.0.0.1:6767" },
    });
    expect(config.memory?.embeddings).toBeUndefined();
    expect(config.memory?.llm).toBeUndefined();
  });

  it("uses env backend precedence before validating stale empty JSON BuJo blocks", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        backend: "bujo",
        mode: "journal",
        path: ".mono-agent/memory",
        embeddings: {},
        llm: {},
      },
    }), "utf8");

    const config = await loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_MEMORY_BACKEND: "supermemory",
        MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: "http://127.0.0.1:6767",
      },
      cwd: dir,
      jsonPath: path,
    });
    expect(config.memory?.backend).toBe("supermemory");
    expect(config.memory?.embeddings).toBeUndefined();
    expect(config.memory?.llm).toBeUndefined();
  });

  it("attributes a non-string JSON memory backend to memory.backend", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: { backend: 123, path: ".mono-agent/memory" },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path })).rejects.toMatchObject({
      name: "MonoAgentConfigError",
      code: "invalid_json",
      message: expect.stringContaining("memory.backend"),
      details: { path: "memory.backend", code: "invalid_json" },
    });
  });

  it("attributes an unsupported JSON memory backend to memory.backend", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: { backend: "not-a-backend", path: ".mono-agent/memory" },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path })).rejects.toMatchObject({
      name: "MonoAgentConfigError",
      code: "invalid_json",
      message: expect.stringContaining("memory.backend"),
      details: { path: "memory.backend", code: "invalid_json" },
    });
  });

  it("attributes a null JSON memory LLM block to memory.llm", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: ".mono-agent/memory",
        embeddings: { dim: 768 },
        llm: null,
      },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path })).rejects.toMatchObject({
      name: "MonoAgentConfigError",
      code: "invalid_json",
      message: expect.stringContaining("memory.llm"),
      details: { path: "memory.llm", code: "invalid_json" },
    });
  });

  it.each([
    ["provider", 123, "a string"],
    ["model", null, "a string"],
    ["executionMode", 123, "a string"],
    ["endpoint", 123, "a string"],
    ["trace", [false], "a boolean"],
    ["timeoutMs", [60_000], "a number"],
  ])("attributes a malformed JSON memory.llm.%s field before env coercion", async (field, value, expected) => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: ".mono-agent/memory",
        embeddings: { dim: 768 },
        llm: {
          provider: "ollama",
          model: "qwen3:4b",
          [field]: value,
        },
      },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path })).rejects.toMatchObject({
      name: "MonoAgentConfigError",
      code: "invalid_json",
      message: expect.stringContaining(expected),
      details: { path: `memory.llm.${field}`, code: "invalid_json" },
    });
  });

  it.each([
    ["provider", { provider: [] }, "memory.embeddings.provider"],
    ["model", { model: {} }, "memory.embeddings.model"],
    ["endpoint", { endpoint: [] }, "memory.embeddings.endpoint"],
    ["apiKey", { apiKey: {} }, "memory.embeddings.apiKey"],
    ["apiKeyEnv", { apiKeyEnv: [] }, "memory.embeddings.apiKeyEnv"],
    ["dim", { dim: [2] }, "memory.embeddings.dim"],
    ["timeoutMs", { timeoutMs: [60_000] }, "memory.embeddings.timeoutMs"],
    [
      "circuitBreaker.failureThreshold",
      { circuitBreaker: { failureThreshold: [3] } },
      "memory.embeddings.circuitBreaker.failureThreshold",
    ],
    [
      "circuitBreaker.cooldownMs",
      { circuitBreaker: { cooldownMs: {} } },
      "memory.embeddings.circuitBreaker.cooldownMs",
    ],
    ["circuitBreaker block", { circuitBreaker: [] }, "memory.embeddings.circuitBreaker"],
  ] as const)("attributes malformed JSON memory.embeddings %s before env coercion", async (
    _name,
    embeddings,
    expectedPath,
  ) => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: { mode: "journal", path: ".mono-agent/memory", embeddings },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: expectedPath, code: "invalid_json" },
    });
  });

  it.each([
    ["baseUrl", { baseUrl: [] }, "memory.supermemory.baseUrl"],
    ["apiKey", { baseUrl: "http://127.0.0.1:6767", apiKey: {} }, "memory.supermemory.apiKey"],
    ["apiKeyEnv", { baseUrl: "http://127.0.0.1:6767", apiKeyEnv: [] }, "memory.supermemory.apiKeyEnv"],
    ["container", { baseUrl: "http://127.0.0.1:6767", container: {} }, "memory.supermemory.container"],
    ["timeoutMs", { baseUrl: "http://127.0.0.1:6767", timeoutMs: [1_000] }, "memory.supermemory.timeoutMs"],
    [
      "exposeMcpServer",
      { baseUrl: "http://127.0.0.1:6767", exposeMcpServer: [true] },
      "memory.supermemory.exposeMcpServer",
    ],
    ["block", [], "memory.supermemory"],
  ] as const)("attributes malformed JSON memory.supermemory %s before env coercion", async (
    _name,
    supermemory,
    expectedPath,
  ) => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: { backend: "supermemory", supermemory },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: expectedPath, code: "invalid_json" },
    });
  });

  it.each([
    ["memory block", [], "memory"],
    ["mode", { mode: [], path: ".mono-agent/memory" }, "memory.mode"],
    ["path", { mode: "lite", path: {} }, "memory.path"],
    ["maxBytes", { mode: "lite", path: ".mono-agent/memory", maxBytes: [2_048] }, "memory.maxBytes"],
    ["writeMode", { mode: "lite", path: ".mono-agent/memory", writeMode: {} }, "memory.writeMode"],
    [
      "recallTool block",
      { mode: "lite", path: ".mono-agent/memory", recallTool: [] },
      "memory.recallTool",
    ],
    [
      "recallTool.enabled",
      { mode: "lite", path: ".mono-agent/memory", recallTool: { enabled: [true] } },
      "memory.recallTool.enabled",
    ],
    [
      "consolidation block",
      { mode: "bujo", path: ".mono-agent/memory", consolidation: [] },
      "memory.consolidation",
    ],
    [
      "consolidation.enabled",
      { mode: "bujo", path: ".mono-agent/memory", consolidation: { enabled: [true] } },
      "memory.consolidation.enabled",
    ],
    [
      "consolidation.cron",
      { mode: "bujo", path: ".mono-agent/memory", consolidation: { cron: {} } },
      "memory.consolidation.cron",
    ],
  ] as const)("attributes malformed adjacent JSON memory scalar %s before env coercion", async (
    _name,
    memory,
    expectedPath,
  ) => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory,
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: expectedPath, code: "invalid_json" },
    });
  });

  it.each([
    [
      "embeddings provider",
      { mode: "journal", path: ".mono-agent/memory", embeddings: { provider: "bad-provider" } },
      "memory.embeddings.provider",
    ],
    [
      "embeddings dimension",
      { mode: "journal", path: ".mono-agent/memory", embeddings: { dim: 1.5 } },
      "memory.embeddings.dim",
    ],
    [
      "embeddings circuit breaker",
      {
        mode: "journal",
        path: ".mono-agent/memory",
        embeddings: { dim: 384, circuitBreaker: { failureThreshold: 101 } },
      },
      "memory.embeddings.circuitBreaker.failureThreshold",
    ],
    [
      "Supermemory timeout",
      { backend: "supermemory", supermemory: { baseUrl: "http://127.0.0.1:6767", timeoutMs: 0 } },
      "memory.supermemory.timeoutMs",
    ],
    ["root mode", { mode: "not-a-mode", path: ".mono-agent/memory" }, "memory.mode"],
    ["root writeMode", { mode: "lite", path: ".mono-agent/memory", writeMode: "wrong" }, "memory.writeMode"],
    ["root maxBytes", { mode: "lite", path: ".mono-agent/memory", maxBytes: 0 }, "memory.maxBytes"],
  ] as const)("attributes semantically invalid JSON %s to its exact leaf", async (
    _name,
    memory,
    expectedPath,
  ) => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory,
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: expectedPath, code: "invalid_json" },
    });
  });

  it.each([
    [
      "JSON-selected Supermemory without a base URL",
      { backend: "supermemory" },
      "memory.supermemory.baseUrl",
    ],
    [
      "a partial JSON Supermemory block",
      { mode: "lite", path: ".mono-agent/memory", supermemory: { container: "agent" } },
      "memory.supermemory.baseUrl",
    ],
    [
      "JSON-selected OpenAI embeddings without credentials",
      { mode: "journal", path: ".mono-agent/memory", embeddings: { provider: "openai" } },
      "memory.embeddings.apiKey",
    ],
    [
      "an unresolved JSON OpenAI embeddings credential reference",
      {
        mode: "journal",
        path: ".mono-agent/memory",
        embeddings: { provider: "openai", apiKeyEnv: "MISSING_EMBEDDINGS_KEY" },
      },
      "memory.embeddings.apiKeyEnv",
    ],
  ] as const)("attributes the required leaf for %s", async (_name, memory, expectedPath) => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory,
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: expectedPath, code: "invalid_json" },
    });
  });

  it.each([
    [
      "Supermemory backend",
      { mode: "lite", path: ".mono-agent/memory" },
      { MONO_AGENT_MEMORY_BACKEND: "supermemory" },
      "MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL",
    ],
    [
      "OpenAI embeddings provider",
      { mode: "journal", path: ".mono-agent/memory", embeddings: { dim: 384 } },
      { MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "openai" },
      "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY",
    ],
  ] as const)("keeps an env-activated missing requirement for %s attributed to env", async (
    _name,
    memory,
    env,
    expectedEnv,
  ) => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory,
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({ env, cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_env",
      details: { env: expectedEnv, code: "invalid_env" },
    });
  });

  it.each(["", "   "])(
    "does not treat a %j JSON Supermemory container as activating a JSON-owned base URL requirement",
    async (container) => {
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        memory: {
          backend: "bujo",
          mode: "lite",
          path: ".mono-agent/memory",
          supermemory: { container },
        },
      }), "utf8");

      await expect(loadMonoAgentConfigWithSources({
        env: { MONO_AGENT_MEMORY_BACKEND: "supermemory" },
        cwd: dir,
        jsonPath: path,
      })).rejects.toMatchObject({
        code: "invalid_env",
        details: {
          env: "MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL",
          code: "invalid_env",
        },
      });
    },
  );

  it.each(["", "   "])(
    "does not treat a %j JSON embeddings credential reference as JSON-owned",
    async (apiKeyEnv) => {
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        memory: {
          mode: "journal",
          path: ".mono-agent/memory",
          embeddings: { dim: 384, apiKeyEnv },
        },
      }), "utf8");

      await expect(loadMonoAgentConfigWithSources({
        env: { MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "openai" },
        cwd: dir,
        jsonPath: path,
      })).rejects.toMatchObject({
        code: "invalid_env",
        details: {
          env: "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY",
          code: "invalid_env",
        },
      });
    },
  );

  it.each([
    [
      "BuJo backend",
      {
        backend: " bujo ",
        mode: "journal",
        path: ".mono-agent/memory",
        embeddings: { provider: "bad-provider" },
      },
      {},
      "memory.embeddings.provider",
    ],
    [
      "Supermemory backend",
      { backend: " supermemory " },
      {},
      "memory.supermemory.baseUrl",
    ],
    [
      "OpenAI embeddings provider",
      {
        mode: "journal",
        path: ".mono-agent/memory",
        embeddings: { provider: " openai " },
      },
      {},
      "memory.embeddings.apiKey",
    ],
    [
      "Lite mode with embeddings",
      {
        mode: " lite ",
        path: ".mono-agent/memory",
        embeddings: { dim: 384 },
      },
      {},
      "memory.embeddings",
    ],
    [
      "Journal mode with an LLM",
      {
        mode: " journal ",
        path: ".mono-agent/memory",
        embeddings: { dim: 384 },
        llm: { provider: "ollama", model: "qwen3:4b" },
      },
      {},
      "memory.llm",
    ],
    [
      "agent-host LLM provider",
      {
        mode: "bujo",
        path: ".mono-agent/memory",
        embeddings: { dim: 384 },
        llm: {
          provider: " agent-host ",
          model: "pi:openai-codex:gpt-5.5",
          endpoint: [],
        },
      },
      { MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host" },
      "memory.llm.endpoint",
    ],
  ] as const)("normalizes a padded JSON %s before source routing", async (
    _name,
    memory,
    env,
    expectedPath,
  ) => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory,
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({ env, cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: expectedPath, code: "invalid_json" },
    });
  });

  it("drops a malformed endpoint when a padded JSON Ollama provider is switched to agent-host", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: ".mono-agent/memory",
        embeddings: { dim: 384 },
        llm: { provider: " ollama ", model: "qwen3:4b", endpoint: [] },
      },
    }), "utf8");

    const config = await loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
        MONO_AGENT_MEMORY_LLM_MODEL: "pi:openai-codex:gpt-5.5",
      },
      cwd: dir,
      jsonPath: path,
    });
    expect(config.memory?.llm).toEqual({
      provider: "agent-host",
      model: "pi:openai-codex:gpt-5.5",
      executionMode: "sdk",
    });
  });

  it("normalizes padded JSON Lite mode before attributing an env capability conflict", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: { mode: " lite ", path: ".mono-agent/memory" },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MEMORY_EMBEDDINGS_DIM: "384" },
      cwd: dir,
      jsonPath: path,
    })).rejects.toMatchObject({
      code: "invalid_env",
      details: {
        env: "MONO_AGENT_MEMORY_EMBEDDINGS_DIM",
        code: "invalid_env",
      },
    });
  });

  it("lets non-empty env leaves override malformed lower-precedence embeddings and Supermemory JSON", async () => {
    const embeddingsPath = join(dir, "embeddings.json");
    await writeFile(embeddingsPath, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        mode: "journal",
        path: ".mono-agent/memory",
        embeddings: { dim: [2] },
      },
    }), "utf8");
    const embeddingsConfig = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MEMORY_EMBEDDINGS_DIM: "384" },
      cwd: dir,
      jsonPath: embeddingsPath,
    });
    expect(embeddingsConfig.memory?.embeddings?.dim).toBe(384);

    const supermemoryPath = join(dir, "supermemory.json");
    await writeFile(supermemoryPath, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        backend: "supermemory",
        supermemory: { baseUrl: "http://127.0.0.1:6767", timeoutMs: [1_000] },
      },
    }), "utf8");
    const supermemoryConfig = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MEMORY_SUPERMEMORY_TIMEOUT_MS: "2000" },
      cwd: dir,
      jsonPath: supermemoryPath,
    });
    expect(supermemoryConfig.memory?.supermemory?.timeoutMs).toBe(2_000);
  });

  it("keeps invalid non-empty env scalar overrides attributed to env", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: { mode: "journal", path: ".mono-agent/memory", embeddings: { dim: [2] } },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MEMORY_EMBEDDINGS_DIM: "not-an-integer" },
      cwd: dir,
      jsonPath: path,
    })).rejects.toMatchObject({
      code: "invalid_env",
      details: {
        env: "MONO_AGENT_MEMORY_EMBEDDINGS_DIM",
        code: "invalid_env",
      },
    });
  });

  it("does not let a blank env value hide malformed JSON", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: { mode: "journal", path: ".mono-agent/memory", embeddings: { dim: [2] } },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MEMORY_EMBEDDINGS_DIM: "   " },
      cwd: dir,
      jsonPath: path,
    })).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: "memory.embeddings.dim", code: "invalid_json" },
    });
  });

  it("ignores malformed stale BuJo scalar leaves after switching to Supermemory", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        backend: "bujo",
        mode: "bujo",
        path: ".mono-agent/memory",
        embeddings: { dim: [2] },
        llm: { provider: "ollama", model: "qwen3:4b", trace: [false] },
        consolidation: { enabled: [true] },
      },
    }), "utf8");

    const config = await loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_MEMORY_BACKEND: "supermemory",
        MONO_AGENT_MEMORY_SUPERMEMORY_BASE_URL: "http://127.0.0.1:6767",
      },
      cwd: dir,
      jsonPath: path,
    });
    expect(config.memory?.backend).toBe("supermemory");
    expect(config.memory?.embeddings).toBeUndefined();
    expect(config.memory?.llm).toBeUndefined();
    expect(config.memory?.consolidation).toBeUndefined();
  });

  it("validates the Supermemory block activated by an env backend switch", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        backend: "bujo",
        mode: "journal",
        path: ".mono-agent/memory",
        embeddings: { dim: 384 },
        supermemory: { baseUrl: "http://127.0.0.1:6767", timeoutMs: [1_000] },
      },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MEMORY_BACKEND: "supermemory" },
      cwd: dir,
      jsonPath: path,
    })).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: "memory.supermemory.timeoutMs", code: "invalid_json" },
    });
  });

  it("validates configured Supermemory scalars even when BuJo remains the effective backend", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        backend: "supermemory",
        mode: "journal",
        path: ".mono-agent/memory",
        embeddings: { dim: 384 },
        supermemory: { baseUrl: "http://127.0.0.1:6767", timeoutMs: [1_000] },
      },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MEMORY_BACKEND: "bujo" },
      cwd: dir,
      jsonPath: path,
    })).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: "memory.supermemory.timeoutMs", code: "invalid_json" },
    });
  });

  it.each([
    ["unsupported provider", { provider: "bad-provider", model: "qwen3:4b" }, "provider"],
    ["invalid execution mode", {
      provider: "agent-host", model: "pi:openai-codex:gpt-5.5", executionMode: "native",
    }, "executionMode"],
    ["provider-incompatible execution mode", {
      provider: "ollama", model: "qwen3:4b", executionMode: "sdk",
    }, "executionMode"],
    ["invalid agent-host model", { provider: "agent-host", model: "not-a-runtime-model" }, "model"],
    ["fractional timeout", {
      provider: "agent-host", model: "pi:openai-codex:gpt-5.5", timeoutMs: 1_500.5,
    }, "timeoutMs"],
    ["timeout below range", {
      provider: "agent-host", model: "pi:openai-codex:gpt-5.5", timeoutMs: 999,
    }, "timeoutMs"],
    ["timeout above range", {
      provider: "agent-host", model: "pi:openai-codex:gpt-5.5", timeoutMs: 600_001,
    }, "timeoutMs"],
    ["provider-incompatible timeout", { provider: "ollama", model: "qwen3:4b", timeoutMs: 60_000 }, "timeoutMs"],
    ["provider-incompatible trace", { provider: "ollama", model: "qwen3:4b", trace: false }, "trace"],
    ["CLI-backed model", { provider: "agent-host", model: "codex:gpt-5.5" }, "model"],
    ["explicit CLI mode", {
      provider: "agent-host", model: "claude:claude-sonnet-4-6", executionMode: "cli",
    }, "executionMode"],
  ] as const)("attributes semantically invalid JSON memory.llm case %s to its exact leaf", async (_name, llm, field) => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: ".mono-agent/memory",
        embeddings: { dim: 768 },
        llm,
      },
    }), "utf8");

    let error: unknown;
    try {
      await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({
      name: "MonoAgentConfigError",
      code: "invalid_json",
      message: expect.stringContaining(`memory.llm.${field}`),
      details: {
        path: `memory.llm.${field}`,
        code: "invalid_json",
        reason: expect.any(String),
      },
    });
    if (!(error instanceof MonoAgentConfigError)) throw new Error("Expected a MonoAgentConfigError.");
    expect(error.details.env).toBeUndefined();
  });

  it.each([
    ["provider", "MONO_AGENT_MEMORY_LLM_PROVIDER", "bad-provider", "invalid_env"],
    ["model", "MONO_AGENT_MEMORY_LLM_MODEL", "not-a-runtime-model", "invalid_model_reference"],
    ["model", "MONO_AGENT_MEMORY_LLM_MODEL", "codex:gpt-5.5", "incompatible_execution_mode"],
    ["executionMode", "MONO_AGENT_MEMORY_LLM_EXECUTION_MODE", "native", "invalid_env"],
    ["executionMode", "MONO_AGENT_MEMORY_LLM_EXECUTION_MODE", "cli", "incompatible_execution_mode"],
    ["endpoint", "MONO_AGENT_MEMORY_LLM_ENDPOINT", "http://127.0.0.1:11434", "invalid_env"],
    ["trace", "MONO_AGENT_MEMORY_LLM_TRACE", "not-a-boolean", "invalid_env"],
    ["timeoutMs", "MONO_AGENT_MEMORY_LLM_TIMEOUT_MS", "1500.5", "invalid_env"],
  ] as const)("keeps a non-empty env-owned memory.llm.%s failure attributed to env", async (
    _field,
    envName,
    value,
    code,
  ) => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: ".mono-agent/memory",
        embeddings: { dim: 768 },
        llm: { provider: "agent-host", model: "pi:openai-codex:gpt-5.5" },
      },
    }), "utf8");

    let error: unknown;
    try {
      await loadMonoAgentConfigWithSources({
        env: { [envName]: value },
        cwd: dir,
        jsonPath: path,
      });
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({
      name: "MonoAgentConfigError",
      code,
      details: { env: envName, code },
    });
    if (!(error instanceof MonoAgentConfigError)) throw new Error("Expected a MonoAgentConfigError.");
    expect(error.details.path).toBeUndefined();
  });

  it.each([
    ["number", 123, undefined],
    ["array", [], undefined],
    ["array with a blank env endpoint", [], "   "],
  ])("drops a stale malformed JSON Ollama endpoint (%s) when env switches to agent-host", async (
    _type,
    endpoint,
    envEndpoint,
  ) => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: ".mono-agent/memory",
        embeddings: { dim: 768 },
        llm: { provider: "ollama", model: "qwen3:4b", endpoint },
      },
    }), "utf8");

    const config = await loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
        MONO_AGENT_MEMORY_LLM_MODEL: "pi:openai-codex:gpt-5.5",
        MONO_AGENT_MEMORY_LLM_ENDPOINT: envEndpoint,
      },
      cwd: dir,
      jsonPath: path,
    });
    expect(config.memory?.llm).toEqual({
      provider: "agent-host",
      model: "pi:openai-codex:gpt-5.5",
      executionMode: "sdk",
    });
  });

  it("keeps a malformed JSON endpoint strict when JSON already selects agent-host", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: ".mono-agent/memory",
        embeddings: { dim: 768 },
        llm: { provider: "agent-host", model: "pi:openai-codex:gpt-5.5", endpoint: [] },
      },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
        MONO_AGENT_MEMORY_LLM_MODEL: "pi:openai-codex:gpt-5.5",
      },
      cwd: dir,
      jsonPath: path,
    })).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: "memory.llm.endpoint", code: "invalid_json" },
    });
  });

  it("skips only the stale endpoint leaf when env switches JSON Ollama to agent-host", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: ".mono-agent/memory",
        embeddings: { dim: 768 },
        llm: { provider: "ollama", model: "qwen3:4b", endpoint: [], trace: [false] },
      },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
        MONO_AGENT_MEMORY_LLM_MODEL: "pi:openai-codex:gpt-5.5",
      },
      cwd: dir,
      jsonPath: path,
    })).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: "memory.llm.trace", code: "invalid_json" },
    });
  });

  it("keeps an explicit env endpoint strict when the dropped JSON endpoint is malformed", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: ".mono-agent/memory",
        embeddings: { dim: 768 },
        llm: { provider: "ollama", model: "qwen3:4b", endpoint: [] },
      },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_MEMORY_LLM_PROVIDER: "agent-host",
        MONO_AGENT_MEMORY_LLM_MODEL: "pi:openai-codex:gpt-5.5",
        MONO_AGENT_MEMORY_LLM_ENDPOINT: "http://127.0.0.1:11434",
      },
      cwd: dir,
      jsonPath: path,
    })).rejects.toMatchObject({
      code: "invalid_env",
      details: { env: "MONO_AGENT_MEMORY_LLM_ENDPOINT", code: "invalid_env" },
    });
  });

  it("lets a non-empty env field override its malformed lower-precedence JSON memory.llm field", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: ".mono-agent/memory",
        embeddings: { dim: 768 },
        llm: { provider: "ollama", model: null },
      },
    }), "utf8");

    const config = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MEMORY_LLM_MODEL: "qwen3:4b" },
      cwd: dir,
      jsonPath: path,
    });
    expect(config.memory?.llm).toMatchObject({ provider: "ollama", model: "qwen3:4b" });
  });

  it("lets an env backend override a malformed lower-precedence JSON backend", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        backend: 123,
        supermemory: { baseUrl: "http://127.0.0.1:6767" },
      },
    }), "utf8");

    const config = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MEMORY_BACKEND: "supermemory" },
      cwd: dir,
      jsonPath: path,
    });
    expect(config.memory?.backend).toBe("supermemory");
  });

  it("keeps an invalid env backend authoritative over malformed lower-precedence JSON", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: { backend: 123 },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MEMORY_BACKEND: "not-a-backend" },
      cwd: dir,
      jsonPath: path,
    })).rejects.toMatchObject({
      name: "MonoAgentConfigError",
      code: "invalid_env",
      details: { env: "MONO_AGENT_MEMORY_BACKEND", code: "invalid_env" },
    });
  });

  it("ignores a stale null BuJo LLM block for the effective external backend", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        backend: "bujo",
        supermemory: { baseUrl: "http://127.0.0.1:6767" },
        llm: null,
      },
    }), "utf8");

    const config = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MEMORY_BACKEND: "supermemory" },
      cwd: dir,
      jsonPath: path,
    });
    expect(config.memory?.backend).toBe("supermemory");
    expect(config.memory?.llm).toBeUndefined();
  });

  it("re-enables strict empty-block validation when env overrides Supermemory with BuJo", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        backend: "supermemory",
        mode: "journal",
        path: ".mono-agent/memory",
        supermemory: { baseUrl: "http://127.0.0.1:6767" },
        embeddings: {},
      },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MEMORY_BACKEND: "bujo" },
      cwd: dir,
      jsonPath: path,
    })).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: "memory.embeddings", code: "invalid_json" },
    });
  });

  it("rejects an empty JSON llm block for the effective built-in tier", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        mode: "bujo",
        path: ".mono-agent/memory",
        embeddings: { dim: 768 },
        llm: {},
      },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: "memory.llm", code: "invalid_json" },
    });
  });

  it("attributes a JSON agent-host endpoint to JSON even when the memory tier comes from env", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5" },
      context: { identityPath: "IDENTITY.md" },
      memory: {
        path: ".mono-agent/memory",
        embeddings: { dim: 768 },
        llm: {
          provider: "agent-host",
          model: "pi:openai-codex:gpt-5.5",
          executionMode: "sdk",
          endpoint: "http://127.0.0.1:11434",
        },
      },
    }), "utf8");

    await expect(loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MEMORY_MODE: "bujo" },
      cwd: dir,
      jsonPath: path,
    })).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: "memory.llm.endpoint", code: "invalid_json" },
    });
  });

  it("treats a dim-only embeddings env surface as explicit and applies provider/model defaults", async () => {
    const config = await loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_MODEL: "pi:openai-codex:gpt-5.5",
        MONO_AGENT_IDENTITY_PATH: "IDENTITY.md",
        MONO_AGENT_MEMORY_MODE: "journal",
        MONO_AGENT_MEMORY_PATH: ".mono-agent/memory",
        MONO_AGENT_MEMORY_EMBEDDINGS_DIM: "384",
      },
      cwd: dir,
    });
    expect(config.memory?.embeddings).toEqual({
      provider: "ollama",
      model: "nomic-embed-text:v1.5",
      dim: 384,
    });
  });

  it("works without a jsonPath (pure env loader behavior)", async () => {
    const config = await loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_MODEL: "pi:openai-codex:gpt-5.5",
        MONO_AGENT_IDENTITY_PATH: "IDENTITY.md",
      },
      cwd: dir,
    });
    expect(config.runtime.model).toMatchObject({ sdk: "pi" });
  });

  it("treats a missing JSON file as an empty layer", async () => {
    const config = await loadMonoAgentConfigWithSources({
      env: {
        MONO_AGENT_MODEL: "pi:openai-codex:gpt-5.5",
        MONO_AGENT_IDENTITY_PATH: "IDENTITY.md",
      },
      cwd: dir,
      jsonPath: join(dir, "absent.json"),
    });
    expect(config.runtime.model).toMatchObject({ sdk: "pi" });
  });

  it("loads lite mode from a JSON config file (no embeddings, no llm)", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        memory: {
          mode: "lite",
          path: ".mono-agent/memory",
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(config.memory?.mode).toBe("lite");
    expect(config.memory?.embeddings).toBeUndefined();
    expect(config.memory?.llm).toBeUndefined();
    expect(config.memory?.consolidation).toBeUndefined();
  });

  it("loads journal mode from a JSON config file", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        memory: {
          mode: "journal",
          path: ".mono-agent/memory",
          embeddings: { provider: "ollama", model: "nomic-embed-text", dim: 768 },
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(config.memory?.mode).toBe("journal");
    expect(config.memory?.embeddings).toMatchObject({ provider: "ollama", model: "nomic-embed-text", dim: 768 });
    expect(config.memory?.llm).toBeUndefined();
  });

  it("loads bujo mode with consolidation block from a JSON config file", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          embeddings: { provider: "ollama", model: "nomic-embed-text", dim: 768 },
          llm: { provider: "ollama", model: "qwen3:8b" },
          consolidation: { enabled: true, cron: "0 */2 * * *" },
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });
    expect(config.memory?.mode).toBe("bujo");
    expect(config.memory?.consolidation).toEqual({ enabled: true, cron: "0 */2 * * *" });
  });

  it("env consolidation cron beats JSON consolidation cron", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
          llm: { provider: "ollama", model: "qwen3.6:latest" },
          consolidation: { enabled: true, cron: "0 */2 * * *" },
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({
      env: { MONO_AGENT_MEMORY_CONSOLIDATION_CRON: "0 */4 * * *" },
      cwd: dir,
      jsonPath: path,
    });
    expect(config.memory?.consolidation?.cron).toBe("0 */4 * * *");
  });

  it("loads bujo mode with llm block from a JSON config file", async () => {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        memory: {
          mode: "bujo",
          path: ".mono-agent/memory",
          embeddings: {
            provider: "ollama",
            model: "nomic-embed-text:v1.5",
            dim: 768,
          },
          llm: {
            provider: "ollama",
            model: "qwen3.6:latest",
          },
        },
      }),
      "utf8",
    );

    const config = await loadMonoAgentConfigWithSources({ env: {}, cwd: dir, jsonPath: path });

    expect(config.memory?.mode).toBe("bujo");
    expect(config.memory?.path).toBe(join(dir, ".mono-agent", "memory"));
    expect(config.memory?.embeddings).toMatchObject({
      provider: "ollama",
      model: "nomic-embed-text:v1.5",
      dim: 768,
    });
    expect(config.memory?.llm).toEqual({
      provider: "ollama",
      model: "qwen3.6:latest",
    });
  });
});
