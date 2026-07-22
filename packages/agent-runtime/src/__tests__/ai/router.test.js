import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.fn();
const resolveRuntimeBridgeMock = vi.fn();

vi.mock("../../ai/runtime/registry.js", async () => {
  const actual = await vi.importActual("../../ai/runtime/registry.js");
  return {
    ...actual,
    resolveRuntimeBridge: (...args) => resolveRuntimeBridgeMock(...args),
  };
});

const { createRouterRuntime } = await import("../../ai/runtime/router.js");
const { createRuntime } = await import("../../runtime.js");
const { passthroughSandbox } = await import("../../agent/sandbox-seam.js");
const { resetToolRuntime } = await import("../../agent/tools/shared/runtime-context.js");
const { createFakeSandbox } = await import("../helpers/fake-sandbox.js");

beforeEach(() => {
  executeMock.mockReset();
  resolveRuntimeBridgeMock.mockReset();
  resolveRuntimeBridgeMock.mockResolvedValue({ id: "stub", execute: executeMock });
  resetToolRuntime();
});

afterEach(() => {
  resetToolRuntime();
});

describe("createRouterRuntime — basic", () => {
  it("rejects an empty chain", () => {
    expect(() => createRouterRuntime({ chain: [] })).toThrow(/non-empty chain/);
  });

  it("uses the first chain entry when it succeeds", async () => {
    executeMock.mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.text).toBe("ok");
    expect(result.failoverHistory).toEqual([]);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});

describe("createRouterRuntime — fallback on retryable", () => {
  it("falls back to the next chain entry on a retryable provider error", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "Anthropic API overloaded — try again later",
        failureKind: "provider_unavailable",
        events: [
          { type: "assistant", message: { content: [{ type: "text", text: "thinking..." }] } },
          { type: "final" },
        ],
        cancelled: false,
      })
      .mockResolvedValueOnce({
        text: "recovered",
        events: [],
        failureKind: null,
      });

    const events = [];
    const router = createRouterRuntime({
      chain: [
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
      ],
    });
    const result = await router.run("sys", { messages: [], onEvent: (e) => events.push(e) });
    expect(result.text).toBe("recovered");
    expect(result.failoverHistory).toHaveLength(1);
    expect(result.failoverHistory[0].model.model).toBe("claude-opus-4-7");
    expect(executeMock).toHaveBeenCalledTimes(2);
    const failoverEvents = events.filter((e) => e.type?.startsWith("provider_failover"));
    expect(failoverEvents.map((e) => e.type)).toEqual([
      "provider_failover_started",
      "provider_failover_completed",
    ]);
  });

  it("reuses one instrumented live-input stream across failover without duplicate applied events", async () => {
    const acknowledge = vi.fn();
    const events = [];
    executeMock
      .mockImplementationOnce(async (_systemPrompt, options) => {
        const next = await options.liveInput[Symbol.asyncIterator]().next();
        next.value.acknowledge();
        return {
          text: null,
          error: "Connection error.",
          failureKind: "provider_unavailable",
          events: [],
          cancelled: false,
        };
      })
      .mockImplementationOnce(async (_systemPrompt, options) => {
        const replay = await options.liveInput[Symbol.asyncIterator]().next();
        replay.value.acknowledge();
        return { text: "recovered", events: [], failureKind: null };
      });
    const liveInput = {
      [Symbol.asyncIterator]() {
        let delivered = false;
        return {
          async next() {
            if (delivered) return { done: true, value: undefined };
            delivered = true;
            return {
              done: false,
              value: {
                body: "guide",
                id: "follow-up-1",
                receivedAt: "2026-07-22T08:30:00.000Z",
                acknowledge,
              },
            };
          },
        };
      },
    };
    const router = createRouterRuntime({
      chain: [
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
      ],
    });

    const result = await router.run("sys", {
      messages: [],
      liveInput,
      onEvent: (event) => events.push(event),
    });

    expect(result.text).toBe("recovered");
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type === "live_input_applied")).toEqual([{
      type: "live_input_applied",
      inputId: "follow-up-1",
      receivedAt: "2026-07-22T08:30:00.000Z",
    }]);
    expect(executeMock.mock.calls[0][1].liveInput).toBe(executeMock.mock.calls[1][1].liveInput);
  });

  it("falls back on pi 0.80's terse 'Connection error.' (live-smoke regression)", async () => {
    // pi 0.80's bridge collapses a connection-refused/unreachable provider down
    // to this bare string with no cause text — see ai/failure.js's
    // retryableProviderSubkind "network" branch.
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "Connection error.",
        failureKind: "provider_unavailable",
        events: [],
        cancelled: false,
      })
      .mockResolvedValueOnce({
        text: "recovered",
        events: [],
        failureKind: null,
      });

    const router = createRouterRuntime({
      chain: [
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.text).toBe("recovered");
    expect(result.failoverHistory).toHaveLength(1);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("falls back when the primary model still exceeds its context window after compaction", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.",
        failureKind: "context_limit",
        events: [],
        cancelled: false,
        diagnostics: {
          context_compaction_reactive_attempted: true,
          context_compaction_reduced: true,
        },
      })
      .mockResolvedValueOnce({
        text: "recovered through Kimi",
        events: [],
        failureKind: null,
      });
    const router = createRouterRuntime({
      chain: [
        { sdk: "pi", provider: "openai-codex", model: "gpt-5.6-sol" },
        { sdk: "pi", provider: "opencode-go", model: "kimi-k2.6" },
      ],
    });

    const result = await router.run("sys", { messages: [] });

    expect(result.text).toBe("recovered through Kimi");
    expect(result.failoverHistory).toEqual([
      expect.objectContaining({
        model: expect.objectContaining({ provider: "openai-codex", model: "gpt-5.6-sol" }),
        failureKind: "context_limit",
        retryableSubkind: "context_limit",
      }),
    ]);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("returns the last failure with provider_unavailable_exhausted when every entry fails", async () => {
    executeMock.mockResolvedValue({
      text: null,
      error: "Anthropic API overloaded — try again later",
      failureKind: "provider_unavailable",
      events: [],
      cancelled: false,
    });
    const router = createRouterRuntime({
      chain: [
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.failureKind).toBe("provider_unavailable_exhausted");
    expect(result.failoverHistory).toHaveLength(2);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("does not fall back on non-retryable provider request failures", async () => {
    executeMock.mockResolvedValueOnce({
      text: null,
      error: "invalid_request_error: Unknown parameter: prompt_cache_retention",
      failureKind: "provider_unavailable",
      events: [],
      cancelled: false,
    });
    const router = createRouterRuntime({
      chain: [
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.failoverHistory).toHaveLength(1);
    expect(result.failureKind).toBe("provider_unavailable");
    expect(result.failoverHistory[0].failureKind).toBe("provider_unavailable");
    expect(result.failoverHistory[0].retryableSubkind).toBe("non_retryable");
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("falls back on provider_auth failures and preserves the attempt detail", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "No API key for provider: openai-codex",
        failureKind: "provider_auth",
        events: [],
        cancelled: false,
      })
      .mockResolvedValueOnce({
        text: "recovered",
        events: [],
        failureKind: null,
      });
    const router = createRouterRuntime({
      chain: [
        { sdk: "pi", model: "openai-codex:gpt-5.5" },
        { sdk: "pi", model: "opencode-go:kimi-k2.6" },
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.text).toBe("recovered");
    expect(result.failoverHistory).toHaveLength(1);
    expect(result.failoverHistory[0].failureKind).toBe("provider_auth");
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("fails over from a direct OpenCode provider-auth result to the next route", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "Sign in to GitHub Copilot.",
        failureKind: "provider_auth",
        events: [],
        cancelled: false,
      })
      .mockResolvedValueOnce({
        text: "recovered through Pi",
        events: [],
        failureKind: null,
      });
    const router = createRouterRuntime({
      chain: [
        { sdk: "opencode", provider: "github-copilot", model: "gpt-5.1" },
        { sdk: "pi", provider: "opencode-go", model: "kimi-k2.6" },
      ],
    });

    const result = await router.run("sys", { messages: [] });

    expect(result.text).toBe("recovered through Pi");
    expect(result.failoverHistory).toEqual([
      expect.objectContaining({
        model: expect.objectContaining({ sdk: "opencode", provider: "github-copilot" }),
        failureKind: "provider_auth",
      }),
    ]);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("strips foreign session state before a non-resumable OpenCode fallback", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "Connection error.",
        failureKind: "provider_unavailable",
        events: [],
        cancelled: false,
      })
      .mockResolvedValueOnce({ text: "recovered", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        { sdk: "pi", provider: "openai-codex", model: "gpt-5.5" },
        { sdk: "opencode", provider: "github-copilot", model: "gpt-5.1" },
      ],
    });

    const result = await router.run("sys", {
      messages: [],
      sessionId: "host-session",
      providerSessionId: "pi-provider-session",
      sessionKeepAlive: true,
      sessionIdleTimeoutMs: 60_000,
    });

    expect(result.text).toBe("recovered");
    expect(executeMock.mock.calls[0][1]).not.toHaveProperty("sessionId");
    expect(executeMock.mock.calls[0][1]).not.toHaveProperty("providerSessionId");
    expect(executeMock.mock.calls[0][1]).not.toHaveProperty("sessionKeepAlive");
    expect(executeMock.mock.calls[0][1]).not.toHaveProperty("sessionIdleTimeoutMs");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("sessionId");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("providerSessionId");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("sessionKeepAlive");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("sessionIdleTimeoutMs");
  });

  it("normalizes auth-shaped provider_unavailable failures before falling back", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "No API key for provider: openai-codex",
        failureKind: "provider_unavailable",
        events: [],
        cancelled: false,
      })
      .mockResolvedValueOnce({
        text: "recovered",
        events: [],
        failureKind: null,
      });
    const router = createRouterRuntime({
      chain: [
        { sdk: "pi", model: "openai-codex:gpt-5.5" },
        { sdk: "pi", model: "opencode-go:kimi-k2.6" },
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.text).toBe("recovered");
    expect(result.failoverHistory).toHaveLength(1);
    expect(result.failoverHistory[0].failureKind).toBe("provider_auth");
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("reports chain exhaustion when every eligible entry fails with provider_auth", async () => {
    executeMock.mockResolvedValue({
      text: null,
      error: "No API key for provider: openai-codex",
      failureKind: "provider_auth",
      events: [],
      cancelled: false,
    });
    const router = createRouterRuntime({
      chain: [
        { sdk: "pi", model: "openai-codex:gpt-5.5" },
        { sdk: "pi", model: "opencode-go:kimi-k2.6" },
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.failureKind).toBe("provider_unavailable_exhausted");
    expect(result.failoverHistory).toHaveLength(2);
    expect(result.failoverHistory.map((entry) => entry.failureKind)).toEqual([
      "provider_auth",
      "provider_auth",
    ]);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("does not fall back when the run was cancelled", async () => {
    executeMock.mockResolvedValueOnce({
      text: null,
      error: "cancelled",
      failureKind: "cancelled_user",
      events: [],
      cancelled: true,
    });
    const router = createRouterRuntime({
      chain: [
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.cancelled).toBe(true);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});

describe("createRouterRuntime — transcript replay on fallback", () => {
  it("prepends a resume context to the system prompt when falling back", async () => {
    const callPrompts = [];
    executeMock.mockImplementation(async (systemPrompt) => {
      callPrompts.push(systemPrompt);
      if (callPrompts.length === 1) {
        return {
          text: null,
          error: "overloaded",
          failureKind: "provider_unavailable",
          events: [
            { type: "assistant", message: { content: [{ type: "text", text: "first attempt" }] } },
            { type: "final" },
          ],
          cancelled: false,
        };
      }
      return { text: "ok", events: [], failureKind: null };
    });
    const router = createRouterRuntime({
      chain: [
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
      ],
    });
    await router.run("Original system prompt", { messages: [] });
    expect(callPrompts).toHaveLength(2);
    expect(callPrompts[0]).toBe("Original system prompt");
    expect(callPrompts[1]).toContain("<resume_context>");
    expect(callPrompts[1]).toContain("first attempt");
    expect(callPrompts[1]).toContain("Original system prompt");
  });

  it("does not duplicate a pending snapshot across a bridge mismatch", async () => {
    const prompts = [];
    executeMock.mockImplementationOnce(async (prompt) => {
      prompts.push(prompt);
      return {
        text: null,
        error: "Connection error.",
        failureKind: "provider_unavailable",
        events: [{ type: "assistant", message: { content: [{ type: "text", text: "first attempt" }] } }],
        cancelled: false,
      };
    }).mockImplementationOnce(async (prompt) => {
      prompts.push(prompt);
      return {
        text: null,
        error: "unsupported option",
        failureKind: "skipped_capability_mismatch",
        events: [],
        cancelled: false,
      };
    }).mockImplementationOnce(async (prompt) => {
      prompts.push(prompt);
      return { text: "ok", events: [], failureKind: null };
    });
    const router = createRouterRuntime({
      chain: [
        { sdk: "claude", model: "first" },
        { sdk: "claude", model: "mismatch" },
        { sdk: "pi", provider: "openai", model: "success" },
      ],
    });

    const result = await router.run("Original system prompt", { messages: [] });

    expect(result.text).toBe("ok");
    expect(prompts).toHaveLength(3);
    expect(prompts[1].match(/<resume_context>/gu)).toHaveLength(1);
    expect(prompts[2].match(/<resume_context>/gu)).toHaveLength(1);
    expect(prompts[2]).toContain("first attempt");
  });
});

describe("createRouterRuntime — capability filtering", () => {
  it("skips chain entries that don't satisfy `requires`", async () => {
    executeMock.mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        { model: { sdk: "claude", model: "x" }, requires: { kind: "does-not-exist" } },
        { sdk: "pi", model: "openai-gpt-4" },
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.text).toBe("ok");
    expect(result.failoverHistory).toHaveLength(1);
    expect(result.failoverHistory[0].failureKind).toBe("skipped_capability_mismatch");
  });

  it("does not report provider availability exhaustion when no provider entry executed", async () => {
    const router = createRouterRuntime({
      chain: [
        { model: { sdk: "claude", model: "x" }, requires: { kind: "does-not-exist" } },
        { model: { sdk: "pi", model: "openai-gpt-4" }, requires: { kind: "also-missing" } },
      ],
    });
    const result = await router.run("sys", { messages: [] });

    expect(executeMock).not.toHaveBeenCalled();
    expect(result.failureKind).toBe("skipped_capability_mismatch");
    expect(result.failoverHistory).toHaveLength(2);
  });

  it.each([
    ["structured output", { outputSchema: {} }],
    ["MCP", { mcpServers: { filesystem: { command: "server" } } }],
    ["skills", { skills: [{ name: "deploy" }] }],
    ["live input", { liveInput: true }],
    ["fast mode", { fastMode: true }],
    ["native subagents", { nativeSubagents: { teammates: [{ name: "researcher" }] } }],
  ])("skips OpenCode and reaches a capable fallback for request-required %s", async (_label, required) => {
    executeMock.mockResolvedValueOnce({ text: "capable", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        { sdk: "opencode", provider: "github-copilot", model: "gpt-5.1" },
        { sdk: "codex", model: "gpt-5.5" },
      ],
    });

    const result = await router.run("sys", { messages: [], ...required });

    expect(result.text).toBe("capable");
    expect(result.failoverHistory[0]).toMatchObject({
      model: expect.objectContaining({ sdk: "opencode" }),
      failureKind: "skipped_capability_mismatch",
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][1].model.sdk).toBe("codex");
  });

  it("continues when a bridge itself returns a capability mismatch", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "unsupported option",
        failureKind: "skipped_capability_mismatch",
        events: [{ type: "assistant", message: { content: [{ type: "text", text: "must not snapshot" }] } }],
        cancelled: false,
      })
      .mockResolvedValueOnce({ text: "recovered", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        { sdk: "claude", model: "first" },
        { sdk: "pi", provider: "openai", model: "second" },
      ],
    });

    const result = await router.run("sys", { messages: [] });

    expect(result.text).toBe("recovered");
    expect(result.failoverHistory[0].failureKind).toBe("skipped_capability_mismatch");
    expect(executeMock.mock.calls[1][0]).toBe("sys");
    expect(executeMock.mock.calls[1][1].diagnosticsSeed).toBeUndefined();
  });

  it("returns capability mismatch rather than availability exhaustion when every route skips", async () => {
    const router = createRouterRuntime({
      chain: [{ sdk: "opencode", provider: "github-copilot", model: "gpt-5.1" }],
    });

    const result = await router.run("sys", {
      messages: [],
      mcpServers: { filesystem: { command: "server" } },
    });

    expect(result.failureKind).toBe("skipped_capability_mismatch");
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("request-implied capabilities override a contradictory requires=false pin", async () => {
    executeMock.mockResolvedValueOnce({ text: "capable", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        {
          model: { sdk: "opencode", provider: "github-copilot", model: "gpt-5.1" },
          requires: { supports_mcp: false },
        },
        { sdk: "codex", model: "gpt-5.5" },
      ],
    });

    const result = await router.run("sys", {
      messages: [],
      mcpServers: { filesystem: { command: "server" } },
    });

    expect(result.text).toBe("capable");
    expect(result.failoverHistory[0].failureKind).toBe("skipped_capability_mismatch");
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][1].model.sdk).toBe("codex");
  });

  it("exhausts after a real provider failure when every remaining route skips", async () => {
    executeMock.mockResolvedValueOnce({
      text: null,
      error: "Connection error.",
      failureKind: "provider_unavailable",
      events: [],
      cancelled: false,
    });
    const router = createRouterRuntime({
      chain: [
        { sdk: "claude", model: "first" },
        { sdk: "opencode", provider: "github-copilot", model: "gpt-5.1" },
      ],
    });

    const result = await router.run("sys", {
      messages: [],
      mcpServers: { filesystem: { command: "server" } },
    });

    expect(result.failureKind).toBe("provider_unavailable_exhausted");
    expect(result.failoverHistory.map((entry) => entry.failureKind)).toEqual([
      "provider_unavailable",
      "skipped_capability_mismatch",
    ]);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("skips a pi fallback when native-subagent teammates are required (F1)", async () => {
    // Claude primary (supports_native_subagents:true) is handed native teammates,
    // fails retryably; the pi fallback (supports_native_subagents:false) must be
    // SKIPPED rather than silently succeeding with the teammates dropped — the run
    // is then exhausted, surfacing the correct signal instead of false success.
    executeMock.mockResolvedValueOnce({
      text: null,
      error: "Anthropic API overloaded — try again later",
      failureKind: "provider_unavailable",
      events: [],
      cancelled: false,
    });
    const router = createRouterRuntime({
      chain: [
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "pi", model: "openai-gpt-4" },
      ],
    });
    const result = await router.run("sys", {
      messages: [],
      nativeSubagents: { provider: "claude", teammates: [{ name: "researcher" }] },
    });
    // Claude attempted once (and failed retryably); pi never attempted.
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(result.failureKind).toBe("provider_unavailable_exhausted");
    const piSkip = result.failoverHistory.find(
      (h) => h.model?.sdk === "pi" && h.failureKind === "skipped_capability_mismatch",
    );
    expect(piSkip).toBeDefined();
  });

  it("still attempts a pi fallback when no native subagents are requested (F1 negative)", async () => {
    // Guards against over-restricting normal fallback: with no teammates, the pi
    // entry is NOT capability-filtered and the fallback succeeds.
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "Anthropic API overloaded — try again later",
        failureKind: "provider_unavailable",
        events: [],
        cancelled: false,
      })
      .mockResolvedValueOnce({ text: "recovered", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        { sdk: "claude", model: "claude-opus-4-7" },
        { sdk: "pi", model: "openai-gpt-4" },
      ],
    });
    const result = await router.run("sys", { messages: [] });
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("recovered");
    expect(
      result.failoverHistory.some((h) => h.failureKind === "skipped_capability_mismatch"),
    ).toBe(false);
  });
});

describe("createRouterRuntime — chain entry shorthand", () => {
  it("accepts bare ModelRef entries", async () => {
    executeMock.mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [{ sdk: "claude", model: "x" }],
    });
    const result = await router.run("sys", { messages: [] });
    expect(result.text).toBe("ok");
    const call = executeMock.mock.calls[0][1];
    expect(call.model).toEqual({ sdk: "claude", model: "x" });
  });
});

describe("createRouterRuntime — production fallback contracts", () => {
  it("applies tri-state effort semantics per route", async () => {
    executeMock
      .mockResolvedValueOnce({ text: null, error: "Connection error.", failureKind: "provider_unavailable", events: [], cancelled: false })
      .mockResolvedValueOnce({ text: null, error: "Connection error.", failureKind: "provider_unavailable", events: [], cancelled: false })
      .mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        { model: { sdk: "claude", model: "inherit" } },
        { model: { sdk: "codex", model: "provider-default" }, effort: null },
        { model: { sdk: "pi", provider: "openai", model: "fixed" }, effort: "ultra" },
      ],
    });

    await router.run("sys", { messages: [], effort: "high" });

    expect(executeMock.mock.calls[0][1].effort).toBe("high");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("effort");
    expect(executeMock.mock.calls[2][1].effort).toBe("ultra");
  });

  it("makes the entire fallback chain stateless even when both routes support resume", async () => {
    executeMock
      .mockResolvedValueOnce({ text: null, error: "Connection error.", failureKind: "provider_unavailable", events: [], cancelled: false })
      .mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        { sdk: "claude", model: "primary" },
        { sdk: "claude", model: "fallback" },
      ],
    });

    await router.run("sys", {
      messages: [],
      sessionId: "host-session",
      providerSessionId: "provider-session",
      sessionKeepAlive: true,
      sessionIdleTimeoutMs: 60_000,
    });

    expect(executeMock.mock.calls[0][1]).not.toHaveProperty("providerSessionId");
    expect(executeMock.mock.calls[0][1]).not.toHaveProperty("sessionKeepAlive");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("providerSessionId");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("sessionKeepAlive");
  });

  it("resolves private local-provider options for the actual attempted model without leaking them", async () => {
    executeMock
      .mockResolvedValueOnce({ text: null, error: "Connection error.", failureKind: "provider_unavailable", events: [], cancelled: false })
      .mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });
    const seen = [];
    const router = createRouterRuntime({
      chain: [
        { sdk: "pi", provider: "local-a", model: "a" },
        { sdk: "pi", provider: "openai", model: "b" },
      ],
      resolveAttempt: ({ model }) => {
        seen.push(model.provider);
        return model.provider === "local-a"
          ? { options: { customProvider: { id: "local-a", api_key: "route-secret" } } }
          : { options: {} };
      },
    });

    const result = await router.run("sys", {
      messages: [],
      customProvider: { id: "wrong-primary", api_key: "wrong-secret" },
      customModel: { id: "wrong-model" },
    });

    expect(seen).toEqual(["local-a", "openai"]);
    expect(executeMock.mock.calls[0][1].customProvider).toEqual({ id: "local-a", api_key: "route-secret" });
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("customProvider");
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("customModel");
    expect(JSON.stringify(result)).not.toContain("route-secret");
    expect(JSON.stringify(result)).not.toContain("wrong-secret");
  });

  it("keeps primary run-level custom metadata for compatibility but scrubs every fallback without a resolver", async () => {
    executeMock
      .mockResolvedValueOnce({ text: null, error: "Connection error.", failureKind: "provider_unavailable", events: [], cancelled: false })
      .mockResolvedValueOnce({ text: "builtin recovered", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        { sdk: "pi", provider: "local", model: "custom-primary" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
      ],
    });
    const primaryMetadata = {
      customProvider: { id: "local", api_key: "primary-secret" },
      customModel: { id: "custom-primary", contextWindow: 32_000 },
      modelCapabilities: { reasoning: true, tools: true },
      isPrivateProvider: true,
    };

    const result = await router.run("sys", { messages: [], ...primaryMetadata });

    expect(result.text).toBe("builtin recovered");
    expect(executeMock.mock.calls[0][1]).toMatchObject(primaryMetadata);
    for (const key of Object.keys(primaryMetadata)) {
      expect(executeMock.mock.calls[1][1]).not.toHaveProperty(key);
    }
  });

  it("keeps uniform safety monotonic and explicitly projects per-route-native contracts", async () => {
    const sandboxPolicy = { mode: "native", engine: "srt", root: "/repo" };
    executeMock.mockResolvedValueOnce({ text: "uniform", events: [], failureKind: null });
    const uniform = createRouterRuntime({ chain: [{ sdk: "codex", model: "uniform" }] });
    await uniform.run("sys", {
      messages: [],
      sandboxPolicy,
      allowedTools: ["Read"],
      disallowedTools: ["Write"],
    });
    expect(executeMock.mock.calls[0][1]).toMatchObject({
      sandboxPolicy,
      allowedTools: ["Read"],
      disallowedTools: ["Write"],
    });

    executeMock.mockReset();
    executeMock
      .mockResolvedValueOnce({ text: null, error: "Connection error.", failureKind: "provider_unavailable", events: [], cancelled: false })
      .mockResolvedValueOnce({ text: "native", events: [], failureKind: null });
    const events = [];
    const native = createRouterRuntime({
      host: { sandboxPolicy },
      routeSafety: "per-route-native",
      chain: [
        { sdk: "pi", provider: "openai", model: "pi-route" },
        { sdk: "codex", model: "codex-route" },
      ],
    });
    const result = await native.run("sys", {
      messages: [],
      sandboxPolicy,
      allowedTools: ["Read"],
      disallowedTools: ["Write"],
      onEvent: (event) => events.push(event),
    });

    expect(executeMock.mock.calls[0][1]).toMatchObject({ sandboxPolicy, allowedTools: ["Read"] });
    expect(executeMock.mock.calls[0][1].toolContext.sandboxPolicy).toEqual(sandboxPolicy);
    expect(executeMock.mock.calls[1][1]).not.toHaveProperty("sandboxPolicy");
    expect(executeMock.mock.calls[1][1].toolContext.sandboxPolicy).toBeUndefined();
    expect(executeMock.mock.calls[1][1]).toMatchObject({ allowedTools: ["*"], disallowedTools: [] });
    expect(events.filter((event) => event.type === "provider_route_safety")).toHaveLength(2);
    expect(result.routeSafetyHistory).toHaveLength(2);
    expect(result.routeSafetyHistory[0].safetyContract).toEqual({
      mode: "per-route-native",
      sandbox: "mono-agent-srt",
      tools: "mono-agent-policy",
    });
    expect(result.failoverHistory[0].safetyContract).toEqual(result.routeSafetyHistory[0].safetyContract);
    expect(result.routeSafetyHistory[1].safetyContract).toEqual({
      mode: "per-route-native",
      sandbox: "codex-native",
      tools: "exact-allow-all",
    });
  });

  it.each([
    ["absent", undefined],
    ["explicitly off", { mode: "off" }],
  ])("reports per-route-native Pi as unsandboxed when its SRT policy is %s", async (_label, sandboxPolicy) => {
    executeMock.mockImplementation(async (_prompt, options) => options.model.sdk === "pi"
      ? { text: null, error: "Connection error.", failureKind: "provider_unavailable", events: [], cancelled: false }
      : { text: "fallback", events: [], failureKind: null });
    const events = [];
    const router = createRouterRuntime({
      routeSafety: "per-route-native",
      chain: [
        { sdk: "pi", provider: "openai", model: "pi-route" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
      ],
    });
    const result = await router.run("sys", {
      messages: [],
      ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
      onEvent: (event) => events.push(event),
    });

    const piContract = {
      mode: "per-route-native",
      sandbox: "disabled",
      tools: "mono-agent-policy",
    };
    expect(result.routeSafetyHistory[0].safetyContract).toEqual(piContract);
    expect(result.failoverHistory[0].safetyContract).toEqual(piContract);
    expect(events.find((event) => event.type === "provider_route_safety")?.safetyContract).toEqual(piContract);
  });

  it("reports an explicitly permitted Pi host-process fallback consistently without attesting SRT", async () => {
    const unsafePolicy = {
      mode: "native",
      engine: "srt",
      fallback: "unsafe-host-process",
      unsafeAllowHostProcess: true,
    };
    executeMock
      .mockResolvedValueOnce({ text: null, error: "Connection error.", failureKind: "provider_unavailable", events: [], cancelled: false })
      .mockResolvedValueOnce({ text: "fallback", events: [], failureKind: null });
    const events = [];
    const router = createRouterRuntime({
      host: { sandboxPolicy: unsafePolicy, sandbox: createFakeSandbox() },
      routeSafety: "per-route-native",
      chain: [
        { sdk: "pi", provider: "openai", model: "pi-route" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
      ],
    });

    const result = await router.run("sys", {
      messages: [],
      onEvent: (event) => events.push(event),
    });

    const expectedContract = {
      mode: "per-route-native",
      sandbox: "mono-agent-srt-unsafe-host-fallback",
      tools: "mono-agent-policy",
    };
    const routeEvent = events.find((event) => event.type === "provider_route_safety");
    expect(routeEvent?.safetyContract).toEqual(expectedContract);
    expect(result.routeSafetyHistory[0].safetyContract).toEqual(expectedContract);
    expect(result.failoverHistory[0].safetyContract).toEqual(expectedContract);
    expect(JSON.stringify({ routeEvent, result })).not.toContain('"sandbox":"mono-agent-srt"');
  });

  it("derives Pi safety telemetry from the same monotonic host, configured, and request precedence as execution", async () => {
    const unsafePolicy = {
      mode: "native",
      engine: "srt",
      fallback: "unsafe-host-process",
      unsafeAllowHostProcess: true,
    };
    const failClosedPolicy = {
      mode: "native",
      engine: "srt",
      fallback: "fail-closed",
      unsafeAllowHostProcess: false,
    };
    const cases = [
      {
        label: "request-only explicit unsafe posture is reported",
        hostPolicy: undefined,
        requestPolicy: unsafePolicy,
        expected: "mono-agent-srt-unsafe-host-fallback",
      },
      {
        label: "request fail-closed tightens an unsafe host policy",
        hostPolicy: unsafePolicy,
        requestPolicy: failClosedPolicy,
        expected: "mono-agent-srt",
      },
      {
        label: "fail-closed host policy rejects an unsafe request weakening",
        hostPolicy: failClosedPolicy,
        requestPolicy: unsafePolicy,
        expected: "mono-agent-srt",
      },
      {
        label: "trusted configureTools replacement permits the unsafe posture",
        hostPolicy: failClosedPolicy,
        configuredPolicy: unsafePolicy,
        expected: "mono-agent-srt-unsafe-host-fallback",
      },
      {
        label: "unsafe fallback without its explicit opt-in remains fail-closed",
        hostPolicy: { ...unsafePolicy, unsafeAllowHostProcess: false },
        expected: "mono-agent-srt",
      },
    ];

    for (const testCase of cases) {
      executeMock.mockReset();
      executeMock.mockResolvedValue({ text: "ok", events: [], failureKind: null });
      const events = [];
      const router = createRouterRuntime({
        host: { sandboxPolicy: testCase.hostPolicy, sandbox: createFakeSandbox() },
        routeSafety: "per-route-native",
        chain: [{ sdk: "pi", provider: "openai", model: `pi-${testCase.label}` }],
      });
      if (testCase.configuredPolicy !== undefined) {
        router.configureTools({ sandboxPolicy: testCase.configuredPolicy });
      }

      const result = await router.run("sys", {
        messages: [],
        ...(testCase.requestPolicy === undefined ? {} : { sandboxPolicy: testCase.requestPolicy }),
        onEvent: (event) => events.push(event),
      });

      expect(
        events.find((event) => event.type === "provider_route_safety")?.safetyContract.sandbox,
        testCase.label,
      ).toBe(testCase.expected);
      expect(result.routeSafetyHistory[0].safetyContract.sandbox, testCase.label).toBe(testCase.expected);
    }
  });

  it("reports the effective monotonic Pi policy after host and configureTools precedence", async () => {
    const nativePolicy = { mode: "native", engine: "srt", fallback: "fail-closed" };
    executeMock.mockResolvedValue({ text: "ok", events: [], failureKind: null });
    const router = createRouterRuntime({
      host: { sandboxPolicy: nativePolicy },
      routeSafety: "per-route-native",
      chain: [{ sdk: "pi", provider: "openai", model: "pi-route" }],
    });

    const protectedResult = await router.run("sys", {
      messages: [],
      sandboxPolicy: { mode: "off" },
    });
    expect(protectedResult.routeSafetyHistory[0].safetyContract.sandbox).toBe("mono-agent-srt");

    router.configureTools({ sandboxPolicy: undefined });
    const clearedResult = await router.run("sys", {
      messages: [],
      sandboxPolicy: { mode: "off" },
    });
    expect(clearedResult.routeSafetyHistory[0].safetyContract.sandbox).toBe("disabled");
  });

  it("projects outer host, configured, and run safety into a blank resolver-supplied Pi runtime", async () => {
    const outerPolicy = {
      mode: "native",
      engine: "srt",
      readableRoots: ["/outer"],
      writableRoots: ["/outer"],
      denyWrite: [".env"],
      network: { mode: "none", allowlist: [] },
      fallback: "fail-closed",
      unsafeAllowHostProcess: false,
    };
    const requestPolicy = {
      ...outerPolicy,
      fallback: "unsafe-host-process",
      unsafeAllowHostProcess: true,
    };
    const outerEngine = { name: "outer-srt-engine" };
    const outerSandbox = createFakeSandbox();
    const suppliedRuntime = createRuntime();
    const events = [];
    executeMock.mockResolvedValue({ text: "ok", events: [], failureKind: null });
    const router = createRouterRuntime({
      host: {
        workspace: "/outer/workspace",
        sandboxPolicy: outerPolicy,
        sandboxEngine: outerEngine,
        sandbox: outerSandbox,
      },
      routeSafety: "per-route-native",
      chain: [{ sdk: "pi", provider: "openai", model: "supplied-blank" }],
      resolveAttempt: () => ({ runtime: suppliedRuntime }),
    });
    router.configureTools({ qaOutputDir: "/outer/qa" });

    const result = await router.run("sys", {
      messages: [],
      sandboxPolicy: requestPolicy,
      onEvent: (event) => events.push(event),
    });

    const actualOptions = executeMock.mock.calls[0][1];
    expect(actualOptions.toolContext).toMatchObject({
      workspace: "/outer/workspace",
      qaOutputDir: "/outer/qa",
      sandboxPolicy: outerPolicy,
      sandboxEngine: outerEngine,
      sandbox: outerSandbox,
    });
    expect(actualOptions.sandboxPolicy).toBe(requestPolicy);
    const actualPolicy = actualOptions.toolContext.sandbox.mergePolicies(
      actualOptions.toolContext.sandboxPolicy,
      actualOptions.sandboxPolicy,
    );
    expect(actualPolicy).toMatchObject({
      fallback: "fail-closed",
      unsafeAllowHostProcess: false,
    });
    const expectedContract = {
      mode: "per-route-native",
      sandbox: "mono-agent-srt",
      tools: "mono-agent-policy",
    };
    expect(result.routeSafetyHistory[0].safetyContract).toEqual(expectedContract);
    expect(events.find((event) => event.type === "provider_route_safety")?.safetyContract).toEqual(expectedContract);
  });

  it("clears a conflicting hidden policy from a resolver-supplied Pi runtime", async () => {
    const hiddenPolicy = {
      mode: "native",
      engine: "srt",
      fallback: "unsafe-host-process",
      unsafeAllowHostProcess: true,
    };
    const hiddenEngine = { name: "hidden-engine" };
    const hiddenSandbox = createFakeSandbox();
    const suppliedRuntime = createRuntime({
      workspace: "/hidden/workspace",
      sandboxPolicy: hiddenPolicy,
      sandboxEngine: hiddenEngine,
      sandbox: hiddenSandbox,
    });
    executeMock.mockResolvedValue({ text: "ok", events: [], failureKind: null });
    const router = createRouterRuntime({
      host: { workspace: "/outer/workspace" },
      routeSafety: "per-route-native",
      chain: [{ sdk: "pi", provider: "openai", model: "supplied-conflicting" }],
      resolveAttempt: () => ({ runtime: suppliedRuntime }),
    });

    const result = await router.run("sys", { messages: [] });

    const actualContext = executeMock.mock.calls[0][1].toolContext;
    expect(actualContext.workspace).toBe("/outer/workspace");
    expect(actualContext.sandboxPolicy).toBeUndefined();
    expect(actualContext.sandboxEngine).toBeUndefined();
    expect(actualContext.sandbox).toBe(passthroughSandbox);
    expect(result.routeSafetyHistory[0].safetyContract).toEqual({
      mode: "per-route-native",
      sandbox: "disabled",
      tools: "mono-agent-policy",
    });
  });

  it("fails closed before executing a supplied Pi runtime that cannot accept tool-context projection", async () => {
    const unsafeRun = vi.fn().mockResolvedValue({ text: "must not run", events: [], failureKind: null });
    const router = createRouterRuntime({
      host: { sandboxPolicy: { mode: "native", engine: "srt", fallback: "fail-closed" } },
      routeSafety: "per-route-native",
      chain: [{ sdk: "pi", provider: "openai", model: "unconfigurable" }],
      resolveAttempt: () => ({ runtime: { run: unsafeRun } }),
    });

    const result = await router.run("sys", { messages: [] });

    expect(unsafeRun).not.toHaveBeenCalled();
    expect(result.failureKind).toBe("safety_unavailable");
    expect(result.routeSafetyHistory[0]).toMatchObject({
      status: "safety_unavailable",
      safetyContract: { sandbox: "mono-agent-srt", tools: "mono-agent-policy" },
    });
  });

  it("projects configureTools before route creation while retaining the sandbox implementation seam", async () => {
    const sandboxPolicy = { mode: "native", marker: "configured" };
    const sandboxEngine = { name: "srt-engine" };
    const sandbox = {
      mergePolicies: (configured, request) => configured ?? request,
      prepareCommand: async ({ command }) => command,
      networkAllowsUrl: () => true,
    };
    executeMock
      .mockResolvedValueOnce({ text: null, error: "Connection error.", failureKind: "provider_unavailable", events: [], cancelled: false })
      .mockResolvedValueOnce({ text: "native", events: [], failureKind: null });
    const router = createRouterRuntime({
      routeSafety: "per-route-native",
      chain: [
        { sdk: "pi", provider: "openai", model: "pi-route" },
        { sdk: "claude", model: "claude-sonnet-4-6" },
      ],
    });

    router.configureTools({
      workspace: "/tmp/configured-before-run",
      sandboxPolicy,
      sandboxEngine,
      sandbox,
    });
    await router.run("sys", { messages: [] });

    const piContext = executeMock.mock.calls[0][1].toolContext;
    const claudeContext = executeMock.mock.calls[1][1].toolContext;
    expect(piContext).toMatchObject({
      workspace: "/tmp/configured-before-run",
      sandboxPolicy,
      sandboxEngine,
      sandbox,
    });
    expect(claudeContext.workspace).toBe("/tmp/configured-before-run");
    expect(claudeContext.sandboxPolicy).toBeUndefined();
    expect(claudeContext.sandboxEngine).toBeUndefined();
    expect(claudeContext.sandbox).toBe(sandbox);
  });

  it("clears stale policy state from a resolver runtime and on reconfiguration after a run", async () => {
    const stalePolicy = { mode: "native", marker: "stale" };
    const staleEngine = { name: "stale-engine" };
    const sandbox = {
      mergePolicies: (configured, request) => configured ?? request,
      prepareCommand: async ({ command }) => command,
      networkAllowsUrl: () => true,
    };
    const resolvedRuntime = createRuntime({ sandboxPolicy: stalePolicy, sandboxEngine: staleEngine, sandbox });
    const seenContexts = [];
    executeMock.mockImplementation(async (_prompt, options) => {
      seenContexts.push({ ...options.toolContext });
      return { text: "ok", events: [], failureKind: null };
    });
    const router = createRouterRuntime({
      routeSafety: "per-route-native",
      chain: [{ sdk: "claude", model: "claude-sonnet-4-6" }],
      resolveAttempt: () => ({ runtime: resolvedRuntime }),
    });

    await router.run("sys", { messages: [] });
    resolvedRuntime.configureTools({ sandboxPolicy: stalePolicy, sandboxEngine: staleEngine });
    router.configureTools({ workspace: "/tmp/reconfigured-after-run" });
    await router.run("sys", { messages: [] });

    expect(seenContexts).toHaveLength(2);
    expect(seenContexts[0].sandboxPolicy).toBeUndefined();
    expect(seenContexts[0].sandboxEngine).toBeUndefined();
    expect(seenContexts[0].sandbox).toBe(sandbox);
    expect(seenContexts[1]).toMatchObject({ workspace: "/tmp/reconfigured-after-run", sandbox });
    expect(seenContexts[1].sandboxPolicy).toBeUndefined();
    expect(seenContexts[1].sandboxEngine).toBeUndefined();
  });

  it("skips an unsupported native safety route and never lets the resolver override policy", async () => {
    executeMock.mockResolvedValueOnce({ text: "fallback", events: [], failureKind: null });
    const router = createRouterRuntime({
      routeSafety: "per-route-native",
      chain: [
        { sdk: "future-sdk", model: "unknown" },
        { sdk: "pi", provider: "openai", model: "safe" },
      ],
      resolveAttempt: ({ model }) => model.sdk === "future-sdk"
        ? { options: { sandboxPolicy: undefined } }
        : { options: {} },
    });

    const result = await router.run("sys", { messages: [] });

    expect(result.text).toBe("fallback");
    expect(result.failoverHistory[0].failureKind).toBe("safety_unavailable");
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("does not expose route credentials from resolver failures", async () => {
    const router = createRouterRuntime({
      routeSafety: "per-route-native",
      chain: [{ sdk: "pi", provider: "local", model: "private" }],
      resolveAttempt: () => {
        throw new Error("failed with api_key=route-secret-value");
      },
    });

    const result = await router.run("sys", { messages: [] });

    expect(result.failureKind).toBe("safety_unavailable");
    expect(result.error).toBe("The route safety contract could not be established before execution.");
    expect(JSON.stringify(result)).not.toContain("route-secret-value");
  });

  it("keeps a single merged resume snapshot across multiple provider failures", async () => {
    executeMock
      .mockResolvedValueOnce({
        text: null,
        error: "Connection error.",
        failureKind: "provider_unavailable",
        events: [{ type: "assistant", message: { content: [{ type: "text", text: "first progress" }] } }],
        cancelled: false,
      })
      .mockResolvedValueOnce({
        text: null,
        error: "Connection error.",
        failureKind: "provider_unavailable",
        events: [{ type: "assistant", message: { content: [{ type: "text", text: "second progress" }] } }],
        cancelled: false,
      })
      .mockResolvedValueOnce({ text: "ok", events: [], failureKind: null });
    const router = createRouterRuntime({
      chain: [
        { sdk: "claude", model: "one" },
        { sdk: "claude", model: "two" },
        { sdk: "claude", model: "three" },
      ],
    });

    await router.run("sys", { messages: [] });

    const finalPrompt = executeMock.mock.calls[2][0];
    expect(finalPrompt.match(/<resume_context>/gu)).toHaveLength(1);
    expect(finalPrompt).toContain("first progress");
    expect(finalPrompt).toContain("second progress");
  });

  it("rejects duplicate chains before creating a run", () => {
    expect(() => createRouterRuntime({
      chain: [
        { sdk: "claude", model: "same" },
        { model: { sdk: "claude", model: "same" }, effort: "high" },
      ],
    })).toThrow(/duplicate model/u);
    expect(() => createRouterRuntime({
      chain: [{ model: { sdk: "claude", model: "bad-effort" }, effort: " " }],
    })).toThrow(/non-empty trimmed string/u);
  });
});
