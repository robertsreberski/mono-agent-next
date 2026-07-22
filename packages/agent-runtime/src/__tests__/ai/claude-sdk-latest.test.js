import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import {
  claudeEffortOptions,
  claudeSdkModelForQuery,
  generateClaudeResponse,
} from "../../ai/providers/claude-sdk.js";

function resultEvent(overrides = {}) {
  return {
    type: "result",
    subtype: "success",
    result: "done",
    usage: { input_tokens: 2, output_tokens: 3 },
    duration_ms: 4,
    num_turns: 1,
    total_cost_usd: 0.125,
    ...overrides,
  };
}

function installStream(events, { throwAfter = null } = {}) {
  const close = vi.fn();
  queryMock.mockImplementation(() => {
    const stream = (async function* () {
      for (const event of events) yield event;
      if (throwAfter) throw throwAfter;
    })();
    stream.close = close;
    return stream;
  });
  return close;
}

function options(overrides = {}) {
  return {
    model: { model: "claude-opus-4-8", reference: "claude:claude-opus-4-8" },
    messages: [{ role: "user", content: "hello" }],
    cwd: "/tmp",
    ...overrides,
  };
}

beforeEach(() => queryMock.mockReset());

describe("Claude Agent SDK 0.3 effort and query contract", () => {
  it("acknowledges live input when the SDK prompt iterator accepts the user message", async () => {
    const acknowledge = vi.fn();
    const reject = vi.fn();
    const prompts = [];
    const close = vi.fn();
    queryMock.mockImplementation((input) => {
      if (!input) return undefined;
      const { prompt } = input;
      const stream = (async function* () {
        for await (const message of prompt) {
          prompts.push(message);
          if (prompts.length === 2) break;
        }
        yield resultEvent();
      })();
      stream.close = close;
      return stream;
    });
    const liveInput = (async function* () {
      yield { body: "Use the new limit", id: "input-1", acknowledge, reject };
    })();

    await expect(generateClaudeResponse("system", options({ liveInput }))).resolves.toMatchObject({ text: "done" });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatchObject({
      type: "user",
      uuid: "input-1",
      message: { role: "user", content: expect.stringContaining("Use the new limit") },
    });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("preserves authored [1m] ids and recognizes Opus 4.8 for explicit 1m selection", () => {
    expect(claudeSdkModelForQuery("claude-opus-4-8[1m]", undefined)).toBe("claude-opus-4-8[1m]");
    expect(claudeSdkModelForQuery("claude-opus-4-8", "1m")).toBe("claude-opus-4-8[1m]");
  });

  it("passes exact supported efforts and preserves the provider default when omitted", async () => {
    expect(claudeEffortOptions(undefined)).toEqual({});
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(claudeEffortOptions(effort)).toEqual({ effort });
    }

    const close = installStream([resultEvent()]);
    await generateClaudeResponse("system", options({ providerEnv: { CLAUDE_TEST_PROVIDER_ENV: "forwarded" } }));
    const queryOptions = queryMock.mock.calls[0][0].options;
    expect(queryOptions).not.toHaveProperty("effort");
    expect(queryOptions).not.toHaveProperty("thinking");
    expect(queryOptions).toMatchObject({
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      env: { MCP_CONNECTION_NONBLOCKING: "0" },
    });
    expect(queryOptions.env.CLAUDE_TEST_PROVIDER_ENV).toBe("forwarded");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects none before query creation with an actionable typed result", async () => {
    const result = await generateClaudeResponse("system", options({ effort: "none" }));
    expect(result).toMatchObject({
      failureKind: "skipped_capability_mismatch",
      errorDetails: {
        claude_error_code: "claude_effort_unsupported",
        claude_error_category: "nonretryable",
        retryable: false,
      },
    });
    expect(result.error).toContain("Omit effort to use the provider default");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("keeps the mono-agent SDK route inside the pinned public effort contract", async () => {
    expect(() => claudeEffortOptions("ultra")).toThrowError(
      'Mono-agent\'s Claude SDK route does not support effort "ultra": the pinned Claude Agent SDK public effort contract ends at "max"',
    );
    const result = await generateClaudeResponse("system", options({ effort: "ultra" }));
    expect(result).toMatchObject({
      failureKind: "skipped_capability_mismatch",
      errorDetails: {
        claude_error_code: "claude_effort_unsupported",
        claude_error_category: "nonretryable",
        retryable: false,
      },
    });
    expect(result.error).toContain('pinned Claude Agent SDK public effort contract ends at "max"');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("uses tools for an explicit empty allowlist and leaves canUseTool authoritative", async () => {
    installStream([resultEvent()]);
    const approval = vi.fn(async () => ({ decision: "approve" }));
    await generateClaudeResponse("system", options({
      allowedTools: [],
      onToolApprovalRequest: approval,
    }));
    const queryOptions = queryMock.mock.calls[0][0].options;
    expect(queryOptions.tools).toEqual([]);
    expect(queryOptions.allowedTools).toBeUndefined();
    expect(queryOptions.canUseTool).toBeTypeOf("function");
    await queryOptions.canUseTool("Bash", { command: "pwd" }, { toolUseID: "tool-upper-id" });
    expect(approval).toHaveBeenCalledWith(expect.objectContaining({ toolUseId: "tool-upper-id" }));
  });

  it("defers to provider defaults for allow-all and disables persistence only for disposable runs", async () => {
    installStream([resultEvent()]);
    await generateClaudeResponse("system", options({ allowedTools: ["*"], sessionKeepAlive: false }));
    const disposable = queryMock.mock.calls[0][0].options;
    expect(disposable.tools).toBeUndefined();
    expect(disposable.allowedTools).toBeUndefined();
    expect(disposable.persistSession).toBe(false);

    queryMock.mockClear();
    installStream([resultEvent({ session_id: "session-next" })]);
    await generateClaudeResponse("system", options({ providerSessionId: "session-existing" }));
    const production = queryMock.mock.calls[0][0].options;
    expect(production.resume).toBe("session-existing");
    expect(production).not.toHaveProperty("persistSession");
  });
});

describe("Claude Agent SDK terminal handling", () => {
  it.each([
    ["authentication_failed", "provider_auth", "authentication", false],
    ["overloaded", "provider_unavailable", "provider_unavailable", true],
    ["server_error", "provider_unavailable", "provider_unavailable", true],
    ["rate_limit", "usage_limit", "usage_limit", false],
    ["billing_error", "provider_unavailable", "nonretryable", false],
    ["invalid_request", "provider_unavailable", "nonretryable", false],
    ["unknown", "provider_unavailable", "unknown", false],
  ])("maps assistant error %s to a bounded typed failure", async (code, failureKind, category, retryable) => {
    installStream([
      { type: "assistant", error: code, request_id: "req_mapping_12345", message: { content: [] } },
      resultEvent(),
    ]);
    const result = await generateClaudeResponse("system", options());
    expect(result).toMatchObject({
      failureKind,
      errorDetails: {
        claude_error_code: code,
        claude_error_category: category,
        retryable,
      },
    });
    expect(result.error.length).toBeLessThanOrEqual(2_200);
  });

  it("keeps a structured assistant auth error and request id when a result and iterator throw follow", async () => {
    const close = installStream([
      {
        type: "assistant",
        error: "authentication_failed",
        request_id: "req_structured_12345",
        session_id: "session-auth",
        message: { content: [{ type: "text", text: "Please run /login" }] },
      },
      resultEvent({ result: "Credentials required", is_error: false }),
    ], { throwAfter: new Error("raw iterator credential dump must not win") });

    const result = await generateClaudeResponse("system", options());
    expect(result).toMatchObject({
      failureKind: "provider_auth",
      providerSessionId: "session-auth",
      errorDetails: {
        claude_error_code: "authentication_failed",
        claude_error_category: "authentication",
        retryable: false,
        request_id: "req_structured_12345",
      },
    });
    expect(result.error).toContain("authentication failed");
    expect(result.error).toContain("req_structured_12345");
    expect(result.error).not.toContain("credential dump");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("uses SDK total_cost_usd and reports thinking only when observed", async () => {
    installStream([
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "considering" }] } },
      resultEvent({ total_cost_usd: 1.75 }),
    ]);
    const observed = await generateClaudeResponse("system", options({ effort: "low" }));
    expect(observed.usage.cost_usd).toBe(1.75);
    expect(observed.capabilitiesUsed.thinking_enabled).toBe(true);

    queryMock.mockClear();
    installStream([resultEvent({ total_cost_usd: 0.5 })]);
    const unknown = await generateClaudeResponse("system", options({ effort: "high" }));
    expect(unknown.capabilitiesUsed.thinking_enabled).toBeNull();
  });

  it("forwards SDK events it does not interpret", async () => {
    const unknownEvent = { type: "future_sdk_event", safe: "payload" };
    installStream([unknownEvent, resultEvent()]);
    const emitted = [];
    const result = await generateClaudeResponse("system", options({ onEvent: (event) => emitted.push(event) }));
    expect(emitted).toContainEqual(unknownEvent);
    expect(result.events).toContainEqual(unknownEvent);
  });

  it("mirrors caller abort into a private controller and always closes the query", async () => {
    const close = vi.fn();
    let captured;
    queryMock.mockImplementation((input) => {
      const queryOptions = input?.options;
      if (!queryOptions) return undefined;
      captured = queryOptions;
      const stream = (async function* () {
        await new Promise((resolve) => queryOptions.abortController.signal.addEventListener("abort", resolve, { once: true }));
      })();
      stream.close = close;
      return stream;
    });
    const caller = new AbortController();
    const pending = generateClaudeResponse("system", options({ abortSignal: caller.signal }));
    await vi.waitFor(() => expect(captured).toBeDefined());
    caller.abort();
    const result = await pending;
    expect(captured.abortController).not.toBe(caller);
    expect(captured.abortController.signal.aborted).toBe(true);
    expect(close).toHaveBeenCalled();
    expect(result.cancelled).toBe(true);
  });
});
