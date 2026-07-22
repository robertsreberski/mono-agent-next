import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ai/providers/opencode-server.js", () => ({ createIsolatedOpencode: vi.fn() }));

import { createIsolatedOpencode } from "../../ai/providers/opencode-server.js";
import {
  opencodeAppRuntimeBridge,
  mapSpawnFailureKind,
  mapErrorFailureKind,
} from "../../ai/providers/opencode-app.js";

// Build a fake OpenCode client whose event stream yields `events` then ends,
// and whose session.prompt resolves with the given final message/parts.
function fakeOpencode({
  events = [],
  promptParts = [],
  info = {},
  sessionId = "sess-1",
  permissionReply,
  providers = [],
} = {}) {
  const close = vi.fn();
  const sessionCreate = vi.fn().mockResolvedValue({ data: { id: sessionId } });
  const sessionPrompt = vi.fn().mockResolvedValue({ data: { info, parts: promptParts } });
  const sessionAbort = vi.fn().mockResolvedValue({ data: true });
  const subscribe = vi.fn().mockResolvedValue({
    stream: (async function* () {
      for (const ev of events) yield ev;
    })(),
  });
  const client = {
    session: { create: sessionCreate, prompt: sessionPrompt, abort: sessionAbort },
    event: { subscribe },
    permission: { reply: permissionReply || vi.fn().mockResolvedValue({ data: true }) },
    provider: { list: vi.fn().mockResolvedValue({ data: { all: providers, default: {}, connected: [] } }) },
  };
  createIsolatedOpencode.mockResolvedValue({ client, server: { url: "http://127.0.0.1:0", close } });
  return { client, close, sessionCreate, sessionPrompt, sessionAbort, subscribe };
}

const baseInfo = {
  id: "assistant-1",
  role: "assistant",
  cost: 0.0021,
  tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 0 } },
};

const partUpdated = (part) => ({ type: "message.part.updated", properties: { part } });
const partDelta = ({ partID, delta, sessionID = "sess-1", field = "text" }) => ({
  type: "message.part.delta",
  properties: { sessionID, messageID: "message-1", partID, field, delta },
});
const messageUpdated = (info) => ({ type: "message.updated", properties: { info } });
const idle = (sessionID = "sess-1") => ({ type: "session.idle", properties: { sessionID } });
const sessionError = (error, sessionID = "sess-1") => ({
  type: "session.error",
  properties: { sessionID, error },
});
const permissionAsked = (options = {}) => {
  const {
    sessionID = "sess-1",
    patterns = ["*"],
    metadata = {},
    always = [],
    callID,
  } = options;
  return {
    type: "permission.asked",
    properties: {
      id: Object.hasOwn(options, "id") ? options.id : "perm-1",
      sessionID,
      permission: Object.hasOwn(options, "permission") ? options.permission : "bash",
      patterns,
      metadata,
      always,
      ...(callID === undefined ? {} : { tool: { messageID: "message-1", callID } }),
    },
  };
};
const defaultPermission = {
  "*": "ask",
  question: "deny",
  task: "deny",
  plan_enter: "deny",
  plan_exit: "deny",
};
const planPermission = {
  "*": "deny",
  read: {
    "*": "allow",
    "*.env": "deny",
    "*.env.*": "deny",
    "*.env.example": "allow",
  },
  question: "deny",
  task: "deny",
  plan_enter: "deny",
  plan_exit: "deny",
};
const acceptEditsPermission = { ...defaultPermission, edit: "allow" };
const bypassPermission = {
  "*": "allow",
  question: "deny",
  task: "deny",
  plan_enter: "deny",
  plan_exit: "deny",
};

beforeEach(() => createIsolatedOpencode.mockReset());
afterEach(() => vi.clearAllMocks());

describe("opencode-app bridge", () => {
  it("supports only opencode sdk under cli execution mode", () => {
    expect(opencodeAppRuntimeBridge.supports({ sdk: "opencode" }, { executionMode: "cli" })).toBe(true);
    expect(opencodeAppRuntimeBridge.supports({ sdk: "opencode" }, { executionMode: "sdk" })).toBe(false);
    expect(opencodeAppRuntimeBridge.supports({ sdk: "codex" }, { executionMode: "cli" })).toBe(false);
    expect(opencodeAppRuntimeBridge.supports({ sdk: "pi", provider: "opencode-go" }, { executionMode: "sdk" })).toBe(false);
  });

  it("fails closed before creating OpenCode when a native mono-agent sandbox is supplied", async () => {
    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: {
        sdk: "opencode",
        provider: "github-copilot",
        model: "gpt-5.1",
        reference: "opencode:github-copilot:gpt-5.1",
      },
      messages: [{ role: "user", content: "do it" }],
      sandboxPolicy: {
        mode: "native",
        readableRoots: ["/workspace"],
        writableRoots: ["/workspace"],
        denyWrite: [".env"],
        network: { mode: "localhost" },
      },
    });

    expect(result).toMatchObject({
      model: "opencode:github-copilot:gpt-5.1",
      sdk: "opencode",
      failureKind: "skipped_capability_mismatch",
      diagnostics: { opencode_error_code: "opencode_sandbox_policy_unsupported" },
    });
    expect(result.error).toContain("cannot enforce mono-agent's native srt sandbox scopes");
    expect(result.error).toContain("pi:opencode-go:*");
    expect(createIsolatedOpencode).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty allowlist", { allowedTools: [], disallowedTools: [] }],
    ["a specific allowlist", { allowedTools: ["Read"], disallowedTools: [] }],
    ["a denylist", { allowedTools: ["*"], disallowedTools: ["Bash"] }],
  ])("fails closed before creating OpenCode for %s", async (_label, policy) => {
    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: {
        sdk: "opencode",
        provider: "github-copilot",
        model: "gpt-5.1",
        reference: "opencode:github-copilot:gpt-5.1",
      },
      messages: [{ role: "user", content: "do it" }],
      ...policy,
    });

    expect(result).toMatchObject({
      model: "opencode:github-copilot:gpt-5.1",
      sdk: "opencode",
      failureKind: "skipped_capability_mismatch",
      diagnostics: { opencode_error_code: "opencode_tool_policy_unsupported" },
    });
    expect(result.error).toContain("cannot enforce allowedTools/disallowedTools");
    expect(result.error).toContain("pi:opencode-go:*");
    expect(createIsolatedOpencode).not.toHaveBeenCalled();
  });

  it("runs a turn: normalizes tool events, captures final text + usage, closes the server", async () => {
    const harness = fakeOpencode({
      events: [
        partUpdated({ type: "tool", callID: "c1", tool: "bash", state: { status: "running", input: { command: "ls" } }, sessionID: "sess-1" }),
        partUpdated({ type: "tool", callID: "c1", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "file.txt" }, sessionID: "sess-1" }),
        idle(),
      ],
      promptParts: [{ type: "text", text: "final answer" }],
      info: baseInfo,
    });

    const onEvent = vi.fn();
    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "github-copilot", model: "gpt-5.1", reference: "opencode:github-copilot:gpt-5.1" },
      messages: [{ role: "user", content: "do it" }],
      onEvent,
    });

    expect(result.sdk).toBe("opencode");
    expect(result.error).toBeNull();
    expect(result.failureKind).toBeNull();
    expect(result.text).toContain("final answer");
    expect(result.providerSessionId).toBeNull();
    expect(result.provider_session_id).toBeNull();
    expect(result.model).toBe("opencode:github-copilot:gpt-5.1");
    expect(createIsolatedOpencode).toHaveBeenCalledWith(expect.objectContaining({
      hostname: "127.0.0.1",
      port: 0,
    }));
    // model routed to OpenCode provider/model
    expect(harness.sessionPrompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: "sess-1",
      model: { providerID: "github-copilot", modelID: "gpt-5.1" },
      system: "SYSTEM",
    }));
    // tool_use + tool_result normalized onto the event stream
    const kinds = onEvent.mock.calls.map(([e]) => e.message?.content?.[0]?.type);
    expect(kinds).toContain("tool_use");
    expect(kinds).toContain("tool_result");
    // usage + cost (OpenCode reports its own cost)
    expect(result.usage).toMatchObject({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 2 });
    expect(result.usage.cost_usd).toBe(0.0021);
    expect(harness.close).toHaveBeenCalled();
  });

  it("emits one exact completed-message context snapshot with the native model window", async () => {
    const exactInfo = {
      ...baseInfo,
      providerID: "p",
      modelID: "m",
      finish: "stop",
      time: { completed: 1_750_000_000_000 },
      tokens: {
        total: 925,
        input: 800,
        output: 125,
        reasoning: 75,
        cache: { read: 300, write: 20 },
      },
    };
    const harness = fakeOpencode({
      events: [messageUpdated(exactInfo), idle()],
      promptParts: [{ type: "text", text: "done" }],
      info: exactInfo,
      providers: [{
        id: "p",
        models: { m: { id: "m", providerID: "p", limit: { context: 200_000 } } },
      }],
    });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(harness.client.provider.list).toHaveBeenCalledWith({});
    expect(result.events.filter((event) => event.type === "context_usage")).toEqual([
      {
        type: "context_usage",
        sdk: "opencode",
        model: "opencode:p:m",
        timestamp: 1_750_000_000_000,
        measurementId: "assistant-1",
        contextWindow: 200_000,
        tokens: {
          input: 500,
          cachedInput: 300,
          cacheCreation: 20,
          output: 125,
          reasoning: 75,
          total: 925,
        },
      },
    ]);
  });

  it("normalizes one OpenCode compaction lifecycle and ignores its legacy duplicate", async () => {
    const secretSummary = "private compaction summary";
    fakeOpencode({
      events: [
        {
          type: "session.next.compaction.started",
          properties: { sessionID: "sess-1", messageID: "compact-1", summary: secretSummary },
        },
        {
          type: "session.next.compaction.ended",
          properties: { sessionID: "sess-1", messageID: "compact-1", summary: secretSummary },
        },
        { type: "session.compacted", id: "legacy-1", properties: { sessionID: "sess-1" } },
        idle(),
      ],
      info: baseInfo,
    });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
    });

    const events = result.events.filter((event) => event.type === "context_compaction");
    expect(events).toEqual([
      expect.objectContaining({
        operationId: "opencode:sess-1:compact-1",
        status: "running",
        sdk: "opencode",
      }),
      expect.objectContaining({
        operationId: "opencode:sess-1:compact-1",
        status: "succeeded",
        sdk: "opencode",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(secretSummary);
  });

  it("preserves distinct compactions from OpenCode's legacy event stream", async () => {
    fakeOpencode({
      events: [
        { type: "session.compacted", id: "legacy-1", properties: { sessionID: "sess-1" } },
        { type: "session.compacted", id: "legacy-2", properties: { sessionID: "sess-1" } },
        idle(),
      ],
      info: baseInfo,
    });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.events.filter((event) => event.type === "context_compaction")).toEqual([
      expect.objectContaining({
        operationId: "opencode:sess-1:legacy:legacy-1",
        status: "succeeded",
        sdk: "opencode",
      }),
      expect.objectContaining({
        operationId: "opencode:sess-1:legacy:legacy-2",
        status: "succeeded",
        sdk: "opencode",
      }),
    ]);
  });

  it("closes a dangling OpenCode compaction as failed when the session becomes idle", async () => {
    fakeOpencode({
      events: [
        {
          type: "session.next.compaction.started",
          properties: { sessionID: "sess-1", messageID: "compact-incomplete" },
        },
        idle(),
      ],
      info: baseInfo,
    });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
    });

    const events = result.events.filter((event) => event.type === "context_compaction");
    expect(events.map(({ status }) => status)).toEqual(["running", "failed"]);
    expect(events[1]).toMatchObject({
      operationId: events[0].operationId,
      reason: "incomplete",
    });
  });

  it("streams v2 text and reasoning deltas and does not duplicate final assistant text", async () => {
    fakeOpencode({
      events: [
        partUpdated({ id: "reasoning-1", type: "reasoning", text: "", sessionID: "sess-1", messageID: "message-1" }),
        partUpdated({ id: "text-1", type: "text", text: "", sessionID: "sess-1", messageID: "message-1" }),
        partDelta({ partID: "reasoning-1", delta: "thinking" }),
        partDelta({ partID: "text-1", delta: "Hello " }),
        partDelta({ partID: "text-1", delta: "world" }),
        partUpdated({ id: "reasoning-1", type: "reasoning", text: "thinking", sessionID: "sess-1", messageID: "message-1" }),
        idle(),
      ],
      promptParts: [{ id: "text-1", type: "text", text: "Hello world" }],
      info: baseInfo,
    });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.text).toBe("Hello world");
    expect(result.events.map((event) => event.message?.content?.[0])).toEqual([
      { type: "thinking", text: "thinking" },
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ]);
  });

  it("streams and falls back per text part while preserving the complete result text", async () => {
    fakeOpencode({
      events: [
        partUpdated({ id: "text-streamed", type: "text", text: "", sessionID: "sess-1", messageID: "message-1" }),
        partUpdated({ id: "reasoning-fallback", type: "reasoning", text: "completed thought", sessionID: "sess-1", messageID: "message-1" }),
        partDelta({ partID: "text-streamed", delta: "streamed" }),
        idle(),
      ],
      promptParts: [
        { id: "text-streamed", type: "text", text: "streamed" },
        { id: "text-final-only", type: "text", text: " plus final" },
      ],
      info: baseInfo,
    });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.text).toBe("streamed plus final");
    expect(result.events.map((event) => event.message?.content?.[0])).toEqual([
      { type: "text", text: "streamed" },
      { type: "thinking", text: "completed thought" },
      { type: "text", text: " plus final" },
    ]);
  });

  it("ignores v2 deltas from foreign sessions and unknown or non-text parts", async () => {
    fakeOpencode({
      events: [
        partUpdated({ id: "foreign-text", type: "text", text: "", sessionID: "sess-other", messageID: "message-1" }),
        partUpdated({ id: "tool-1", type: "tool", callID: "c1", tool: "bash", state: { status: "pending", input: {} }, sessionID: "sess-1", messageID: "message-1" }),
        partDelta({ partID: "foreign-text", delta: "foreign" }),
        partDelta({ partID: "missing", delta: "unknown" }),
        partDelta({ partID: "tool-1", delta: "not tool input" }),
        partDelta({ partID: "tool-1", delta: "wrong field", field: "input" }),
        partDelta({ partID: "tool-1", delta: "wrong session", sessionID: "sess-other" }),
        idle(),
      ],
      promptParts: [],
      info: baseInfo,
    });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
    });

    const streamedText = result.events
      .flatMap((event) => event.message?.content ?? [])
      .filter((content) => content.type === "text" || content.type === "thinking");
    expect(streamedText).toEqual([]);
  });

  it("emits a settled tool result only once when OpenCode repeats the completed part", async () => {
    const completed = {
      id: "tool-1",
      type: "tool",
      callID: "c1",
      tool: "bash",
      state: { status: "completed", input: { command: "pwd" }, output: "/repo" },
      sessionID: "sess-1",
      messageID: "message-1",
    };
    fakeOpencode({
      events: [partUpdated(completed), partUpdated(completed), idle()],
      promptParts: [{ id: "text-1", type: "text", text: "done" }],
      info: baseInfo,
    });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.events.filter((event) => event.message?.content?.[0]?.type === "tool_use")).toHaveLength(1);
    expect(result.events.filter((event) => event.message?.content?.[0]?.type === "tool_result")).toHaveLength(1);
  });

  it("aggregates usage and cost across unique assistant steps without double-counting updates", async () => {
    fakeOpencode({
      events: [
        messageUpdated({
          id: "assistant-step-1",
          role: "assistant",
          cost: 0.1,
          tokens: { input: 10, output: 2, cache: { read: 1, write: 0 } },
        }),
        messageUpdated({
          id: "assistant-step-1",
          role: "assistant",
          cost: 0.12,
          tokens: { input: 12, output: 3, cache: { read: 2, write: 0 } },
        }),
        messageUpdated({
          id: "assistant-step-2",
          role: "assistant",
          cost: 0.05,
          tokens: { input: 5, output: 1, cache: { read: 0, write: 0 } },
        }),
        idle(),
      ],
      promptParts: [{ type: "text", text: "multi-step answer" }],
      info: {
        id: "assistant-step-2",
        role: "assistant",
        cost: 0.2,
        tokens: { input: 6, output: 4, reasoning: 1, cache: { read: 3, write: 2 } },
      },
    });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.numTurns).toBe(2);
    expect(result.usage).toMatchObject({
      input_tokens: 18,
      output_tokens: 7,
      cache_read_tokens: 5,
      cache_creation_tokens: 2,
      cost_usd: 0.32,
    });
  });

  it("fails closed before startup when MCP config could leak through provider shell env", async () => {
    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      mcpServers: {
        remote: { url: "https://example.com/mcp?token=SECRET", headers: { Authorization: "Bearer SECRET" } },
      },
    });
    expect(result).toMatchObject({
      failureKind: "skipped_capability_mismatch",
      diagnostics: { opencode_error_code: "opencode_mcp_unsupported" },
    });
    expect(result.error).toContain("cannot safely inject MCP configuration");
    expect(result.error).not.toContain("SECRET");
    expect(createIsolatedOpencode).not.toHaveBeenCalled();
  });

  it("scopes OpenCode session, event, prompt, and permission calls to the run cwd", async () => {
    const harness = fakeOpencode({
      events: [
        permissionAsked(),
        idle(),
      ],
      promptParts: [{ type: "text", text: "ok" }],
      info: baseInfo,
    });

    await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      cwd: "/agent/workspace",
      permissionMode: "default",
    });

    const directory = { directory: "/agent/workspace" };
    expect(harness.sessionCreate).toHaveBeenCalledWith(directory);
    expect(harness.subscribe).toHaveBeenCalledWith(directory);
    expect(harness.sessionPrompt).toHaveBeenCalledWith(expect.objectContaining(directory));
    expect(harness.client.permission.reply).toHaveBeenCalledWith(expect.objectContaining({
      ...directory,
      requestID: "perm-1",
      reply: "reject",
    }));
  });

  it.each([7, 0.5])("fails closed for a positive maxTurns=%s that OpenCode cannot enforce", async (maxTurns) => {
    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      maxTurns,
    });

    expect(result).toMatchObject({
      failureKind: "skipped_capability_mismatch",
      diagnostics: { opencode_error_code: "opencode_max_turns_unsupported" },
    });
    expect(result.error).toContain("no enforceable hard turn cap");
    expect(createIsolatedOpencode).not.toHaveBeenCalled();
  });

  it.each([undefined, 0])("keeps OpenCode turns unlimited for maxTurns=%s", async (maxTurns) => {
    const harness = fakeOpencode({ events: [idle()], promptParts: [{ type: "text", text: "ok" }], info: baseInfo });

    await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      maxTurns,
    });

    const config = createIsolatedOpencode.mock.calls[0]?.[0]?.config;
    const [agentName] = Object.keys(config.agent);
    expect(agentName).toMatch(/^mono-agent-run-[0-9a-f-]{36}$/);
    expect(config.agent[agentName]).toEqual({
      description: "mono-agent isolated run",
      mode: "primary",
      permission: defaultPermission,
    });
    expect(harness.sessionPrompt).toHaveBeenCalledWith(expect.objectContaining({ agent: agentName }));
  });

  it("uses a collision-resistant run-owned agent for every execution", async () => {
    fakeOpencode({ events: [idle()], promptParts: [{ type: "text", text: "ok" }], info: baseInfo });
    const options = {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      maxTurns: 0,
    };

    await opencodeAppRuntimeBridge.execute("SYSTEM", options);
    await opencodeAppRuntimeBridge.execute("SYSTEM", options);

    const agentNames = createIsolatedOpencode.mock.calls.map(([request]) => Object.keys(request.config.agent)[0]);
    expect(agentNames[0]).not.toBe(agentNames[1]);
  });

  it.each(["high", "ultra"])("fails closed before creating OpenCode when effort %s is explicitly configured", async (effort) => {
    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      effort,
    });

    expect(result).toMatchObject({
      model: "opencode:p:m",
      sdk: "opencode",
      effort: null,
      failureKind: "skipped_capability_mismatch",
      diagnostics: { opencode_error_code: "opencode_effort_unsupported" },
    });
    expect(result.error).toContain("has no reasoning-effort input");
    expect(createIsolatedOpencode).not.toHaveBeenCalled();
  });

  it.each([
    ["default", defaultPermission],
    ["plan", planPermission],
    ["acceptEdits", acceptEditsPermission],
    ["bypassPermissions", bypassPermission],
  ])("projects %s permissionMode into OpenCode config", async (permissionMode, permission) => {
    fakeOpencode({ events: [idle()], promptParts: [{ type: "text", text: "ok" }], info: baseInfo });
    await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      permissionMode,
    });

    const config = createIsolatedOpencode.mock.calls[0]?.[0]?.config;
    const [agentName] = Object.keys(config.agent);
    expect(config.permission).toEqual(permission);
    expect(config.agent[agentName].permission).toEqual(permission);
    expect(Object.keys(config.permission)).toEqual(Object.keys(permission));
    expect(Object.keys(config.agent[agentName].permission)).toEqual(Object.keys(permission));
    if (permission.read) {
      expect(Object.keys(config.permission.read)).toEqual(Object.keys(permission.read));
      expect(Object.keys(config.agent[agentName].permission.read)).toEqual(Object.keys(permission.read));
    }
  });

  it("fails closed for providerSessionId because direct OpenCode state is per-run", async () => {
    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      providerSessionId: "resumed-1",
    });
    expect(result).toMatchObject({
      failureKind: "skipped_capability_mismatch",
      diagnostics: { opencode_error_code: "opencode_session_resume_unsupported" },
    });
    expect(result.providerSessionId).toBeNull();
    expect(result.provider_session_id).toBeNull();
    expect(createIsolatedOpencode).not.toHaveBeenCalled();
  });

  it.each([
    ["structured output", { outputSchema: {} }, "opencode_structured_output_unsupported"],
    ["native subagents", { nativeSubagents: { teammates: [{ name: "researcher" }] } }, "opencode_native_subagents_unsupported"],
    ["live input", { liveInput: true }, "opencode_live_input_unsupported"],
    ["fast mode", { fastMode: true }, "opencode_fast_mode_unsupported"],
    ["runtime skills", { skills: [{ name: "deploy" }] }, "opencode_skills_unsupported"],
  ])("fails closed before startup for unsupported %s", async (_label, unsupported, code) => {
    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      ...unsupported,
    });

    expect(result).toMatchObject({
      failureKind: "skipped_capability_mismatch",
      providerSessionId: null,
      diagnostics: { opencode_error_code: code },
    });
    expect(createIsolatedOpencode).not.toHaveBeenCalled();
  });

  it("forwards permission requests to onToolApprovalRequest and replies to OpenCode", async () => {
    const respond = vi.fn().mockResolvedValue({ data: true });
    fakeOpencode({
      events: [
        permissionAsked({
          id: "perm-1",
          permission: "bash",
          callID: "call-1",
          patterns: ["ls *"],
          metadata: { token: "TOP_SECRET" },
        }),
        idle(),
      ],
      promptParts: [{ type: "text", text: "ok" }],
      info: baseInfo,
      permissionReply: respond,
    });
    const onToolApprovalRequest = vi.fn().mockResolvedValue({ decision: "approve" });
    const onEvent = vi.fn();
    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      onToolApprovalRequest,
      toolRiskTiers: { Bash: "high" },
      onEvent,
    });
    expect(onToolApprovalRequest).toHaveBeenCalledWith({
      requestId: "perm-1",
      toolName: "Bash",
      toolUseId: "call-1",
      argumentsSummary: '{"patterns":["ls *"],"metadata":{"token":"[REDACTED]"}}',
      riskTier: "high",
      model: "opencode:p:m",
    });
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      requestID: "perm-1",
      reply: "once",
    }));
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool_approval_pending",
        requestId: "perm-1",
        toolName: "Bash",
        riskTier: "high",
        argumentsSummary: '{"patterns":["ls *"],"metadata":{"token":"[REDACTED]"}}',
      }),
      expect.objectContaining({
        type: "tool_approval_granted",
        requestId: "perm-1",
        decision: "approve",
        riskTier: "high",
      }),
    ]));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "tool_approval_pending" }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "tool_approval_granted" }));
    expect(JSON.stringify(result.events)).not.toContain("TOP_SECRET");
  });

  it.each([undefined, null, {}, { decision: "unexpected" }])(
    "strictly rejects a malformed callback response %j even for a low-risk permission",
    async (callbackResponse) => {
      const respond = vi.fn().mockResolvedValue({ data: true });
      fakeOpencode({
        events: [
          permissionAsked({ id: "perm-low" }),
          idle(),
        ],
        promptParts: [{ type: "text", text: "ok" }],
        info: baseInfo,
        permissionReply: respond,
      });
      const onToolApprovalRequest = vi.fn().mockResolvedValue(callbackResponse);

      const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
        model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
        messages: [{ role: "user", content: "hi" }],
        onToolApprovalRequest,
        toolRiskTiers: { bash: "low" },
      });

      expect(onToolApprovalRequest).toHaveBeenCalledTimes(1);
      expect(onToolApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({ riskTier: "low" }));
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({ reply: "reject" }));
      expect(result.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "tool_approval_pending", riskTier: "low" }),
        expect.objectContaining({
          type: "tool_approval_denied",
          riskTier: "low",
          reason: "invalid_host_response",
        }),
      ]));
    },
  );

  it("rejects a low-risk permission when no approval callback exists", async () => {
    const respond = vi.fn().mockResolvedValue({ data: true });
    fakeOpencode({
      events: [
        permissionAsked({ id: "perm-low-no-host" }),
        idle(),
      ],
      promptParts: [{ type: "text", text: "ok" }],
      info: baseInfo,
      permissionReply: respond,
    });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      toolRiskTiers: { Bash: "low" },
    });

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ reply: "reject" }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_approval_denied",
      reason: "no_host_callback",
      riskTier: "low",
    }));
  });

  it("allows an explicit host decision for a dynamic MCP permission name", async () => {
    const respond = vi.fn().mockResolvedValue({ data: true });
    fakeOpencode({
      events: [
        permissionAsked({ id: "perm-dynamic", permission: "custom_mcp_publish" }),
        idle(),
      ],
      promptParts: [{ type: "text", text: "ok" }],
      info: baseInfo,
      permissionReply: respond,
    });
    const onToolApprovalRequest = vi.fn().mockResolvedValue({ decision: "approve" });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      onToolApprovalRequest,
      toolRiskTiers: { custom_mcp_publish: "high" },
    });

    expect(onToolApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "perm-dynamic",
      toolName: "custom_mcp_publish",
      riskTier: "high",
    }));
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      requestID: "perm-dynamic",
      reply: "once",
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_approval_granted",
      requestId: "perm-dynamic",
    }));
  });

  it("rejects a dynamic permission name when no approval callback exists", async () => {
    const respond = vi.fn().mockResolvedValue({ data: true });
    fakeOpencode({
      events: [permissionAsked({ id: "perm-dynamic", permission: "custom_mcp_publish" }), idle()],
      promptParts: [{ type: "text", text: "ok" }],
      info: baseInfo,
      permissionReply: respond,
    });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ reply: "reject" }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_approval_denied",
      requestId: "perm-dynamic",
      reason: "no_host_callback",
    }));
  });

  it("forwards a current repo_clone permission through the approval callback", async () => {
    const respond = vi.fn().mockResolvedValue({ data: true });
    fakeOpencode({
      events: [permissionAsked({ id: "perm-repo", permission: "repo_clone" }), idle()],
      promptParts: [{ type: "text", text: "ok" }],
      info: baseInfo,
      permissionReply: respond,
    });
    const onToolApprovalRequest = vi.fn().mockResolvedValue({ decision: "approve" });

    await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      onToolApprovalRequest,
    });

    expect(onToolApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "perm-repo",
      toolName: "RepoClone",
    }));
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      requestID: "perm-repo",
      reply: "once",
    }));
  });

  it("bypassPermissions allows an unknown permission without consulting the callback", async () => {
    const respond = vi.fn().mockResolvedValue({ data: true });
    fakeOpencode({
      events: [
        permissionAsked({ id: "perm-bypass", permission: "future_permission" }),
        idle(),
      ],
      promptParts: [{ type: "text", text: "ok" }],
      info: baseInfo,
      permissionReply: respond,
    });
    const onToolApprovalRequest = vi.fn().mockResolvedValue({ decision: "deny" });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      permissionMode: "bypassPermissions",
      onToolApprovalRequest,
    });

    expect(onToolApprovalRequest).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ reply: "once" }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_approval_granted",
      reason: "permission_mode_bypass",
    }));
  });

  it("rejects an unsupported question permission even in bypass mode", async () => {
    const respond = vi.fn().mockResolvedValue({ data: true });
    fakeOpencode({
      events: [permissionAsked({ id: "perm-question", permission: "question" }), idle()],
      promptParts: [{ type: "text", text: "ok" }],
      info: baseInfo,
      permissionReply: respond,
    });
    const onToolApprovalRequest = vi.fn().mockResolvedValue({ decision: "approve" });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      permissionMode: "bypassPermissions",
      onToolApprovalRequest,
    });

    expect(onToolApprovalRequest).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ reply: "reject" }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_approval_denied",
      requestId: "perm-question",
      reason: "unsupported_permission_type",
    }));
  });

  it("denies on approval timeout and emits the canonical lifecycle", async () => {
    const respond = vi.fn().mockResolvedValue({ data: true });
    fakeOpencode({
      events: [
        permissionAsked({ id: "perm-timeout" }),
        idle(),
      ],
      promptParts: [{ type: "text", text: "ok" }],
      info: baseInfo,
      permissionReply: respond,
    });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      onToolApprovalRequest: vi.fn(() => new Promise(() => {})),
      approvalTimeoutMs: 5,
    });

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ reply: "reject" }));
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_approval_pending", requestId: "perm-timeout" }),
      expect.objectContaining({
        type: "tool_approval_denied",
        requestId: "perm-timeout",
        reason: "approval_timeout",
      }),
    ]));
  });

  it("keeps an always decision session-scoped and emits a grant for the allowlist hit", async () => {
    const respond = vi.fn().mockResolvedValue({ data: true });
    fakeOpencode({
      events: [
        permissionAsked({ id: "perm-1" }),
        permissionAsked({ id: "perm-2" }),
        idle(),
      ],
      promptParts: [{ type: "text", text: "ok" }],
      info: baseInfo,
      permissionReply: respond,
    });
    const onToolApprovalRequest = vi.fn().mockResolvedValue({ decision: "always" });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      onToolApprovalRequest,
    });

    expect(onToolApprovalRequest).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls.map(([request]) => request.reply)).toEqual(["once", "once"]);
    expect(result.events.filter((event) => event.type === "tool_approval_pending")).toHaveLength(1);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_approval_granted",
      requestId: "perm-2",
      reason: "session_allowed",
    }));
  });

  it.each([
    ["plan", "bash", "reject"],
    ["default", "bash", "reject"],
    ["default", "future_permission", "reject"],
    ["acceptEdits", "edit", "once"],
    ["acceptEdits", "bash", "reject"],
    ["bypassPermissions", "future_permission", "once"],
    ["unexpected-mode", "bash", "reject"],
  ])("uses a fail-closed %s decision for an unanswered %s permission", async (
    permissionMode,
    permissionType,
    response,
  ) => {
    const respond = vi.fn().mockResolvedValue({ data: true });
    fakeOpencode({
      events: [
        permissionAsked({ permission: permissionType }),
        idle(),
      ],
      promptParts: [{ type: "text", text: "ok" }],
      info: baseInfo,
      permissionReply: respond,
    });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      permissionMode,
    });

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      reply: response,
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: response === "reject" ? "tool_approval_denied" : "tool_approval_granted",
      riskTier: "medium",
    }));
  });

  it("plan rejects permission events without consulting an approval callback", async () => {
    const respond = vi.fn().mockResolvedValue({ data: true });
    fakeOpencode({
      events: [
        permissionAsked(),
        idle(),
      ],
      promptParts: [{ type: "text", text: "ok" }],
      info: baseInfo,
      permissionReply: respond,
    });
    const onToolApprovalRequest = vi.fn().mockResolvedValue({ decision: "approve" });

    await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      permissionMode: "plan",
      onToolApprovalRequest,
    });

    expect(onToolApprovalRequest).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ reply: "reject" }));
  });

  it.each([
    ["approve", "once"],
    ["always", "once"],
    ["deny", "reject"],
  ])("maps callback decision %s to OpenCode response %s", async (decision, response) => {
    const respond = vi.fn().mockResolvedValue({ data: true });
    fakeOpencode({
      events: [
        permissionAsked(),
        idle(),
      ],
      promptParts: [{ type: "text", text: "ok" }],
      info: baseInfo,
      permissionReply: respond,
    });

    await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      permissionMode: "default",
      onToolApprovalRequest: vi.fn().mockResolvedValue({ decision }),
    });

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ reply: response }));
  });

  it("rejects when the OpenCode approval callback throws", async () => {
    const respond = vi.fn().mockResolvedValue({ data: true });
    fakeOpencode({
      events: [
        permissionAsked(),
        idle(),
      ],
      promptParts: [{ type: "text", text: "ok" }],
      info: baseInfo,
      permissionReply: respond,
    });

    await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      permissionMode: "default",
      onToolApprovalRequest: vi.fn().mockRejectedValue(new Error("host unavailable")),
    });

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ reply: "reject" }));
  });

  it("honors the explicit always-allow list without calling the approval callback", async () => {
    const respond = vi.fn().mockResolvedValue({ data: true });
    fakeOpencode({
      events: [
        permissionAsked(),
        idle(),
      ],
      promptParts: [{ type: "text", text: "ok" }],
      info: baseInfo,
      permissionReply: respond,
    });
    const onToolApprovalRequest = vi.fn().mockResolvedValue({ decision: "deny" });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      permissionMode: "default",
      approvalAlwaysAllowTools: ["bash"],
      onToolApprovalRequest,
    });

    expect(onToolApprovalRequest).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ reply: "once" }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_approval_granted",
      toolName: "Bash",
      reason: "session_allowed",
    }));
  });

  it("fails and aborts promptly when OpenCode rejects a permission reply", async () => {
    const respond = vi.fn().mockResolvedValue({ error: { message: "reply transport failed" } });
    const harness = fakeOpencode({
      events: [
        messageUpdated({
          id: "assistant-partial",
          role: "assistant",
          cost: 0.07,
          tokens: { input: 8, output: 2, cache: { read: 1, write: 0 } },
        }),
        permissionAsked({ id: "perm-failed" }),
      ],
      permissionReply: respond,
    });
    harness.sessionPrompt.mockReturnValue(new Promise(() => {}));

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      onToolApprovalRequest: vi.fn().mockResolvedValue({ decision: "approve" }),
    });

    expect(result).toMatchObject({
      failureKind: "tool_failure",
      diagnostics: {
        opencode_error_code: "opencode_permission_reply_failed",
        opencode_permission_id: "perm-failed",
      },
    });
    expect(result.error).toContain("permission decision");
    expect(result.usage).toMatchObject({
      input_tokens: 8,
      output_tokens: 2,
      cache_read_tokens: 1,
      cost_usd: 0.07,
    });
    expect(result.numTurns).toBe(1);
    expect(result.providerSessionId).toBeNull();
    expect(harness.sessionAbort).toHaveBeenCalledWith(expect.objectContaining({ sessionID: "sess-1" }));
  });

  it("observes an asynchronous abort rejection without corrupting the run result", async () => {
    const controller = new AbortController();
    const harness = fakeOpencode({ events: [idle()], info: baseInfo });
    let resolvePrompt;
    harness.sessionPrompt.mockReturnValue(new Promise((resolve) => {
      resolvePrompt = resolve;
    }));
    harness.sessionAbort.mockRejectedValue(new Error("abort transport failed"));

    const execution = opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
      abortSignal: controller.signal,
    });
    await vi.waitFor(() => expect(harness.sessionPrompt).toHaveBeenCalledTimes(1));
    controller.abort();
    resolvePrompt({
      data: {
        info: baseInfo,
        parts: [{ type: "text", text: "result after abort request" }],
      },
    });

    const result = await execution;
    expect(harness.sessionAbort).toHaveBeenCalledTimes(1);
    expect(harness.sessionAbort).toHaveBeenCalledWith({ sessionID: "sess-1" });
    expect(result).toMatchObject({
      cancelled: true,
      error: null,
      failureKind: null,
      text: "result after abort request",
    });
  });

  it.each([undefined, "", "   "])(
    "fails closed and aborts a permission request with malformed id %j",
    async (permissionId) => {
      const respond = vi.fn().mockResolvedValue({ data: true });
      const harness = fakeOpencode({
        events: [
          permissionAsked({ id: permissionId }),
        ],
        permissionReply: respond,
      });
      harness.sessionPrompt.mockReturnValue(new Promise(() => {}));
      const onToolApprovalRequest = vi.fn().mockResolvedValue({ decision: "approve" });

      const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
        model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
        messages: [{ role: "user", content: "hi" }],
        onToolApprovalRequest,
      });

      expect(result).toMatchObject({
        failureKind: "tool_failure",
        diagnostics: { opencode_error_code: "opencode_permission_invalid" },
      });
      expect(onToolApprovalRequest).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
      expect(harness.sessionAbort).toHaveBeenCalled();
      expect(result.events).toContainEqual(expect.objectContaining({
        type: "tool_approval_denied",
        requestId: null,
        reason: "invalid_permission_id",
      }));
    },
  );

  it.each([undefined, "", "   "])(
    "fails closed and aborts a permission request with malformed permission %j",
    async (permission) => {
      const respond = vi.fn().mockResolvedValue({ data: true });
      const harness = fakeOpencode({
        events: [permissionAsked({ id: "perm-invalid", permission })],
        permissionReply: respond,
      });
      harness.sessionPrompt.mockReturnValue(new Promise(() => {}));
      const onToolApprovalRequest = vi.fn().mockResolvedValue({ decision: "approve" });

      const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
        model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
        messages: [{ role: "user", content: "hi" }],
        onToolApprovalRequest,
      });

      expect(result).toMatchObject({
        failureKind: "tool_failure",
        diagnostics: {
          opencode_error_code: "opencode_permission_invalid",
          opencode_permission_id: "perm-invalid",
        },
      });
      expect(onToolApprovalRequest).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
      expect(harness.sessionAbort).toHaveBeenCalledWith({ sessionID: "sess-1" });
      expect(result.events).toContainEqual(expect.objectContaining({
        type: "tool_approval_denied",
        requestId: "perm-invalid",
        reason: "invalid_permission_type",
      }));
    },
  );

  it("classifies failure kinds", () => {
    expect(mapSpawnFailureKind({ code: "ENOENT", message: "opencode: command not found" })).toBe("spawn");
    expect(mapSpawnFailureKind({ message: "spawn opencode failed" })).toBe("spawn");
    expect(mapSpawnFailureKind({ message: "network blip" })).toBe("provider_unavailable");
    expect(mapErrorFailureKind({ name: "MessageAbortedError" })).toBe("cancelled");
    expect(mapErrorFailureKind({ name: "MessageOutputLengthError" })).toBe("usage_limit");
    expect(mapErrorFailureKind({ name: "ContextOverflowError" })).toBe("context_limit");
    expect(mapErrorFailureKind({ name: "ProviderAuthError" })).toBe("provider_auth");
  });

  it.each([
    ["ProviderAuthError", "Sign in to GitHub Copilot.", "provider_auth"],
    ["ContextOverflowError", "The model context window is full.", "context_limit"],
    ["APIError", "The provider API is temporarily unavailable.", "provider_unavailable"],
  ])("surfaces the safe nested SDK message for %s", async (name, message, failureKind) => {
    fakeOpencode({
      events: [sessionError({ name, data: { message } })],
      promptParts: [],
      info: baseInfo,
    });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result).toMatchObject({ error: message, failureKind });
  });

  it("uses nested prompt error text without leaking SDK response fields and bounds it", async () => {
    const longMessage = `Provider rejected the request: ${"x".repeat(2_000)}`;
    fakeOpencode({
      events: [idle()],
      promptParts: [],
      info: {
        ...baseInfo,
        error: {
          name: "APIError",
          data: {
            message: longMessage,
            responseBody: "SECRET_RESPONSE_BODY",
            responseHeaders: { authorization: "Bearer SECRET_HEADER" },
            metadata: { token: "SECRET_METADATA" },
          },
        },
      },
    });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.error).toHaveLength(1_000);
    expect(result.error).toMatch(/^Provider rejected the request:/u);
    expect(result.error.endsWith("…")).toBe(true);
    expect(result.error).not.toContain("SECRET_RESPONSE_BODY");
    expect(result.error).not.toContain("SECRET_HEADER");
    expect(result.error).not.toContain("SECRET_METADATA");
  });

  it("uses a generic unwrap error when no safe message field exists", async () => {
    const harness = fakeOpencode({ events: [], promptParts: [], info: baseInfo });
    harness.sessionCreate.mockResolvedValue({
      error: {
        name: "APIError",
        data: { responseBody: "SECRET_RESPONSE_BODY" },
        headers: { authorization: "Bearer SECRET_HEADER" },
      },
    });

    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.error).toBe("OpenCode request failed.");
    expect(result.error).not.toContain("SECRET");
  });

  it("surfaces an OpenCode error response as a failed run and still closes the server", async () => {
    const harness = fakeOpencode({ events: [idle()], promptParts: [], info: baseInfo });
    harness.sessionCreate.mockResolvedValue({ error: { name: "ProviderAuthError", message: "not logged in" } });
    const result = await opencodeAppRuntimeBridge.execute("SYSTEM", {
      model: { sdk: "opencode", provider: "p", model: "m", reference: "opencode:p:m" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.error).toMatch(/not logged in/);
    expect(result.failureKind).toBe("provider_auth");
    expect(harness.close).toHaveBeenCalled();
  });
});
