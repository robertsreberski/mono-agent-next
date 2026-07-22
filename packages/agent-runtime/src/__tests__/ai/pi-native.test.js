// Pi-native AgentHarness bridge integration.
//
// Drives generatePiNativeResponse end-to-end through pi-ai's own `fauxProvider`:
// a real provider is added to a `Models` collection, so the REAL AgentHarness +
// REAL `streamSimple` dispatch run with scripted assistant responses and no
// network/API key. This exercises the production harness path while keeping the
// provider deterministic.
//
// pi 0.80 drives model requests through `Models`, so the bridge is handed both
// the faux Model (via the `piResolvedModel` seam) and the faux `Models`
// collection (via `piResolvedModels`) — the faux provider is not in pi's
// builtin catalog, so it can only be reached through an explicit collection.
//
// The native bridge must return the SAME unified result shape and emit the
// SAME normalized runtime events as the legacy pi-sdk bridge.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDynamicCredentialStore,
  generatePiNativeResponse,
  splitPromptMessages,
} from "../../ai/providers/pi-native.js";
import { failureKindForPiError } from "../../ai/providers/pi-native/result-builder.js";
import { startLiveInput } from "../../ai/providers/pi-native/turn-runner.js";
import { createToolContext } from "../../agent/tools/shared/tool-context.js";

const FAUX_MODEL = { api: "faux", provider: "faux", id: "faux-model" };

describe("pi-native live input", () => {
  it("acknowledges a follow-up only after native harness steering accepts it", async () => {
    const acknowledge = vi.fn();
    const reject = vi.fn();
    const steer = vi.fn(async () => undefined);
    const warnings = [];
    const liveInput = (async function* () {
      yield { body: "Use the new limit", id: "input-1", acknowledge, reject };
    })();
    const consumer = startLiveInput({
      harness: { steer },
      options: { liveInput },
      onEvent: (event) => warnings.push(event),
    });

    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    await consumer.stop();
    expect(steer.mock.calls[0]?.[0]).toContain("Use the new limit");
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it("stops without waiting for a third-party iterator return that never settles", async () => {
    const iterator = {
      next: vi.fn(() => new Promise(() => {})),
      return: vi.fn(() => new Promise(() => {})),
    };
    const consumer = startLiveInput({
      harness: { steer: vi.fn() },
      options: { liveInput: { [Symbol.asyncIterator]: () => iterator } },
      onEvent: vi.fn(),
    });

    await vi.waitFor(() => expect(iterator.next).toHaveBeenCalledTimes(1));
    await expect(consumer.stop()).resolves.toBeUndefined();
    expect(iterator.return).toHaveBeenCalledTimes(1);
  });
});

describe("splitPromptMessages (pi-native multimodal preservation)", () => {
  it("preserves text + image parts of the final user turn (no JSON stringification)", () => {
    const { priorMessages, promptText, promptImages } = splitPromptMessages(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "image", data: "BASE64DATA", mimeType: "image/png" },
          ],
        },
      ],
      FAUX_MODEL,
    );
    expect(priorMessages).toEqual([]);
    expect(promptText).toBe("describe this");
    expect(promptImages).toEqual([{ type: "image", data: "BASE64DATA", mimeType: "image/png" }]);
  });

  it("keeps prior-turn structure (image blocks) via toAgentMessages instead of stringifying", () => {
    const { priorMessages, promptText, promptImages } = splitPromptMessages(
      [
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", data: "X", mimeType: "image/jpeg" }] },
        { role: "assistant", content: "ok" },
        { role: "user", content: "follow up" },
      ],
      FAUX_MODEL,
    );
    expect(promptText).toBe("follow up");
    expect(promptImages).toEqual([]);
    const priorUser = priorMessages.find((message) => message.role === "user");
    expect(Array.isArray(priorUser.content)).toBe(true);
    expect(priorUser.content).toContainEqual({ type: "image", data: "X", mimeType: "image/jpeg" });
  });

  it("handles a plain string final turn", () => {
    const { promptText, promptImages } = splitPromptMessages([{ role: "user", content: "just text" }], FAUX_MODEL);
    expect(promptText).toBe("just text");
    expect(promptImages).toEqual([]);
  });
});

// pi 0.80 resolves request auth through a Models CredentialStore instead of the
// removed harness getApiKeyAndHeaders hook. These assert the bridge's per-run
// key-resolution contract survived the migration: apiKeys map wins, else the
// host resolvePiApiKey callback, and a callback failure emits a pi_auth_failed
// runtime warning and proceeds keyless (never throwing a hard auth error).
describe("createDynamicCredentialStore (pi 0.80 auth contract)", () => {
  it("returns the apiKeys map entry as an api_key credential without consulting the callback", async () => {
    let called = false;
    const store = createDynamicCredentialStore(
      new Map([["anthropic", "map-key"]]),
      async () => { called = true; return "callback-key"; },
      [],
    );
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "map-key" });
    expect(called).toBe(false);
  });

  it("falls back to resolvePiApiKey when the map has no entry", async () => {
    const store = createDynamicCredentialStore(new Map(), async (provider) => `key-for-${provider}`, []);
    expect(await store.read("openai")).toEqual({ type: "api_key", key: "key-for-openai" });
  });

  it("preserves OAuth credentials exposed by the host resolver credential store", async () => {
    const resolver = async () => {
      throw new Error("legacy api-key resolver should not run for OAuth store reads");
    };
    resolver.readCredential = async (provider) => provider === "openai-codex"
      ? {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 4_200_000_000_000,
      }
      : undefined;

    const store = createDynamicCredentialStore(new Map(), resolver, []);

    expect(await store.read("openai-codex")).toEqual({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 4_200_000_000_000,
    });
  });

  it("rejects credential-store read failures so Pi can surface auth storage errors", async () => {
    const resolver = async () => "legacy-key";
    resolver.readCredential = async () => {
      throw new Error("auth file is corrupt");
    };
    const warnings = [];
    const store = createDynamicCredentialStore(new Map(), resolver, warnings);

    await expect(store.read("openai-codex")).rejects.toThrow("auth file is corrupt");
    expect(warnings).toEqual([]);
  });

  it("delegates OAuth refresh writes to the host resolver credential store", async () => {
    let credential = {
      type: "oauth",
      access: "old-access",
      refresh: "old-refresh",
      expires: 1,
    };
    const resolver = async () => {
      throw new Error("legacy api-key resolver should not run for OAuth store writes");
    };
    resolver.readCredential = async () => credential;
    resolver.modifyCredential = async (_provider, fn) => {
      const next = await fn(credential);
      if (next !== undefined) credential = next;
      return credential;
    };

    const store = createDynamicCredentialStore(new Map(), resolver, []);
    const updated = await store.modify("openai-codex", async (current) => ({
      ...current,
      access: "new-access",
      expires: 4_200_000_000_000,
    }));

    expect(updated).toEqual({
      type: "oauth",
      access: "new-access",
      refresh: "old-refresh",
      expires: 4_200_000_000_000,
    });
    expect(credential.access).toBe("new-access");
  });

  it("emits a pi_auth_failed warning and proceeds keyless when resolvePiApiKey throws", async () => {
    const warnings = [];
    const store = createDynamicCredentialStore(
      new Map(),
      async () => { throw new Error("boom"); },
      warnings,
    );
    // Resolves to no credential rather than rejecting: a keyless read lets a
    // builtin provider fall back to its own env vars, exactly as the removed
    // getApiKeyAndHeaders hook did when it returned undefined.
    await expect(store.read("anthropic")).resolves.toBeUndefined();
    expect(warnings).toContainEqual({ warning_kind: "pi_auth_failed", provider: "anthropic", message: "boom" });
  });

  it("returns no credential (env fallback) when no key source is available, never throwing", async () => {
    const store = createDynamicCredentialStore(new Map(), undefined, []);
    await expect(store.read("google")).resolves.toBeUndefined();
  });

  it("treats an empty-string key as no credential", async () => {
    const store = createDynamicCredentialStore(new Map(), async () => "", []);
    expect(await store.read("openai")).toBeUndefined();
  });
});

describe("failureKindForPiError", () => {
  it("classifies Pi credential errors as provider_auth", () => {
    expect(failureKindForPiError("No API key for provider: openai-codex", {}, {})).toBe("provider_auth");
    expect(failureKindForPiError("OAuth refresh failed for openai-codex", {}, {})).toBe("provider_auth");
  });

  it("classifies the OpenAI Codex input overflow as context_limit", () => {
    expect(failureKindForPiError(
      "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.",
      {},
      {},
    )).toBe("context_limit");
  });

  it("keeps max-turn termination in usage_limit", () => {
    expect(failureKindForPiError("Maximum turns reached", {}, { maxTurnsHit: true })).toBe("usage_limit");
  });
});

let faux = null;
let fauxModels = null;

// Register a faux provider into a fresh `Models` collection and hand its model
// back. `modelDef` overrides merge onto the base faux model (e.g. `reasoning`,
// `input`). The collection is stashed so `runOptions` can inject it.
function setup(modelDef = {}) {
  faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-model", ...modelDef }],
    tokensPerSecond: undefined,
  });
  fauxModels = createModels();
  fauxModels.setProvider(faux.provider);
  return faux.getModel();
}

beforeEach(() => {
  faux = null;
  fauxModels = null;
});

afterEach(() => {
  faux = null;
  fauxModels = null;
});

function runOptions(model, overrides = {}) {
  return {
    model: { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:faux-model" },
    piResolvedModel: model,
    piResolvedModels: fauxModels,
    effort: "none",
    allowedTools: [],
    ...overrides,
  };
}

describe("pi-native AgentHarness bridge", () => {
  const sessionsRoot = mkdtempSync(join(tmpdir(), "pi-native-sessions-"));
  afterAll(() => rmSync(sessionsRoot, { recursive: true, force: true }));

  it("wires native max through the AgentHarness stream options when advertised", async () => {
    const model = setup({ reasoning: true });
    model.thinkingLevelMap = { xhigh: "xhigh", max: "max" };
    const originalStreamSimple = faux.provider.streamSimple.bind(faux.provider);
    let observedReasoning;
    faux.provider.streamSimple = (requestModel, context, options) => {
      observedReasoning = options?.reasoning;
      return originalStreamSimple(requestModel, context, options);
    };
    faux.setResponses([fauxAssistantMessage([fauxText("max response")])]);

    const result = await generatePiNativeResponse("system", runOptions(model, {
      effort: "max",
      messages: [{ role: "user", content: "use native max" }],
      resolvePiApiKey: async () => "faux-key",
      piSessionsRoot: sessionsRoot,
    }));

    expect(result.error).toBeNull();
    expect(observedReasoning).toBe("max");
  });

  it("returns the unified result shape and streams normalized events on a simple turn", async () => {
    const model = setup({ reasoning: true });
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("considering"), fauxText("hello world")]),
    ]);
    const onEvent = vi.fn();

    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "say hi" }],
      effort: "medium",
      onEvent,
    }));

    expect(result.error).toBeNull();
    expect(result.text).toBe("hello world");
    expect(result.sdk).toBe("pi");
    expect(result.model).toBe("pi:faux:faux-model");
    expect(result.cancelled).toBe(false);
    expect(result.providerSessionId).toBeTruthy();
    expect(Array.isArray(result.events)).toBe(true);
    expect(result.numTurns).toBe(1);
    expect(result.diagnostics.provider_session_id).toBe(result.providerSessionId);
    expect(result.diagnostics.pi_engine).toBe("native");
    expect(result.diagnostics.pi_transport_requested).toBe("auto");

    const events = onEvent.mock.calls.map(([event]) => event);
    expect(events[0]).toMatchObject({ type: "provider_request_started", sdk: "pi", runtime: "pi" });
    expect(events.some((event) => event?.type === "provider_request_completed")).toBe(true);
    const contextUsage = events.find((event) => event?.type === "context_usage");
    expect(contextUsage).toMatchObject({
      sdk: "pi",
      model: "pi:faux:faux-model",
      contextWindow: 128_000,
      tokens: {
        input: expect.any(Number),
        output: expect.any(Number),
        cacheRead: 0,
        cacheCreation: expect.any(Number),
        total: expect.any(Number),
      },
    });
    expect(contextUsage.tokens.total).toBe(
      contextUsage.tokens.input +
      contextUsage.tokens.output +
      contextUsage.tokens.cacheRead +
      contextUsage.tokens.cacheCreation,
    );
    const textBlocks = events
      .filter((event) => event?.type === "assistant")
      .flatMap((event) => event.message?.content || [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text);
    expect(textBlocks.join("")).toContain("hello world");
  });

  it("forwards the requested transport to Pi and reports it in diagnostics", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("over sse")])]);
    const originalStreamSimple = faux.provider.streamSimple.bind(faux.provider);
    let observedTransport;
    faux.provider.streamSimple = (requestModel, context, options) => {
      observedTransport = options?.transport;
      return originalStreamSimple(requestModel, context, options);
    };

    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "say hi" }],
      piTransport: "sse",
    }));

    expect(result.error).toBeNull();
    expect(result.text).toBe("over sse");
    expect(observedTransport).toBe("sse");
    expect(result.diagnostics.pi_transport_requested).toBe("sse");
  });

  it("delivers final-turn images to the model as image content blocks (not dropped)", async () => {
    // Regression: AgentHarness.prompt takes images under an options object
    // (`{ images }`). Passing a bare ImageContent[] as the second positional arg
    // makes `options?.images` undefined, so the image is silently dropped and
    // never reaches the model. Assert the image block survives to the provider.
    const model = setup({ input: ["text", "image"] });

    let capturedMessages = null;
    faux.setResponses([
      (context) => {
        capturedMessages = context.messages;
        return fauxAssistantMessage([fauxText("seen")]);
      },
    ]);

    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image", data: "BASE64DATA", mimeType: "image/png" },
          ],
        },
      ],
    }));

    expect(result.error).toBeNull();
    expect(capturedMessages).not.toBeNull();
    const lastUser = [...capturedMessages].reverse().find((message) => message.role === "user");
    expect(lastUser).toBeDefined();
    expect(Array.isArray(lastUser.content)).toBe(true);
    expect(lastUser.content).toContainEqual({ type: "image", data: "BASE64DATA", mimeType: "image/png" });
    expect(lastUser.content).toContainEqual({ type: "text", text: "what is this" });
  });

  it("maps a tool call to normalized tool_use and tool_result events", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-native-tool-"));
    try {
      writeFileSync(join(root, "notes.txt"), "important context\n");
      const model = setup();
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("Read", { file_path: "notes.txt" }, { id: "call-1" })]),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      const onEvent = vi.fn();

      const result = await generatePiNativeResponse("system", runOptions(model, {
        cwd: root,
        allowedTools: ["Read"],
        messages: [{ role: "user", content: "read the notes" }],
        onEvent,
      }));

      expect(result.error).toBeNull();
      expect(result.text).toBe("done");

      const events = onEvent.mock.calls.map(([event]) => event);
      const syntheticProgress = events.find((event) =>
        event?.message?.content?.[0]?.type === "thinking");
      const toolUse = events.find((event) =>
        event?.message?.content?.[0]?.type === "tool_use"
        && event.message.content[0].name === "Read");
      const toolResult = events.find((event) =>
        event?.message?.content?.[0]?.type === "tool_result"
        && event.message.content[0].tool_use_id === "call-1");
      const toolTiming = events.find((event) =>
        event?.type === "tool_timing" && event.tool_use_id === "call-1");
      expect(syntheticProgress).toBeUndefined();
      expect(toolUse).toBeTruthy();
      expect(toolResult).toBeTruthy();
      expect(toolTiming).toBeTruthy();
      expect(toolTiming.name).toBe("Read");
      expect(typeof toolTiming.execution_ms).toBe("number");
      expect(toolTiming.execution_ms).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps one NodeRepl session for the Pi run and cleans it up afterward", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-native-node-repl-"));
    const cleanup = vi.fn(async () => {});
    const sandbox = {
      mergePolicies: (configured, request) => request ?? configured,
      prepareCommand: async ({ command }) => ({
        ...command,
        args: command.args ?? [],
        cwd: command.cwd ?? root,
        sandboxed: false,
        cleanup,
      }),
      networkAllowsUrl: () => true,
    };
    try {
      const model = setup();
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("NodeRepl", { code: "const answer = 40" }, { id: "repl-1" })]),
        fauxAssistantMessage([fauxToolCall("NodeRepl", { code: "answer + 2" }, { id: "repl-2" })]),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      const onEvent = vi.fn();

      const result = await generatePiNativeResponse("system", runOptions(model, {
        cwd: root,
        allowedTools: ["NodeRepl"],
        messages: [{ role: "user", content: "calculate in Node" }],
        onEvent,
        sandbox,
      }));

      expect(result.error).toBeNull();
      expect(result.text).toBe("done");
      const toolResults = onEvent.mock.calls
        .map(([event]) => event?.message?.content?.[0])
        .filter((block) => block?.type === "tool_result");
      expect(toolResults).toEqual(expect.arrayContaining([
        expect.objectContaining({ tool_use_id: "repl-1", content: "undefined", is_error: false }),
        expect.objectContaining({ tool_use_id: "repl-2", content: "42", is_error: false }),
      ]));
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records a pi-native Write call without synthetic file_edit tool events", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-native-write-"));
    try {
      const model = setup();
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("Write", { file_path: "notes.txt", content: "written\n" }, { id: "write-1" })]),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      const onEvent = vi.fn();

      const result = await generatePiNativeResponse("system", runOptions(model, {
        cwd: root,
        allowedTools: ["Write"],
        messages: [{ role: "user", content: "write the notes" }],
        onEvent,
      }));

      expect(result.error).toBeNull();
      expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("written\n");

      const events = onEvent.mock.calls.map(([event]) => event);
      const contentBlocks = events.flatMap((event) => event?.message?.content || []);
      const toolUses = contentBlocks.filter((block) => block?.type === "tool_use");
      const writeResult = contentBlocks.find((block) =>
        block?.type === "tool_result" && block.tool_use_id === "write-1");
      const syntheticFileEditBlocks = contentBlocks.filter((block) =>
        (block?.type === "tool_use" && block.name === "file_edit")
        || (block?.type === "tool_result" && String(block.tool_use_id || "").startsWith("file_edit:")));

      expect(toolUses.map((block) => block.name)).toEqual(["Write"]);
      expect(writeResult?.file_change).toMatchObject({
        status: "completed",
        summary: { files: 1, added_lines: 1, removed_lines: 0, changed_lines: 1, unavailable_count: 0 },
        changes: [{
          path: join(root, "notes.txt"),
          kind: "add",
          line_stats: { before_lines: 0, after_lines: 1, added_lines: 1, removed_lines: 0, changed_lines: 1 },
        }],
      });
      expect(syntheticFileEditBlocks).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces MCP server init failures in runtimeWarnings, not just as transient events", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
    const onEvent = vi.fn();

    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hi" }],
      // A stdio child that exits immediately fails the MCP handshake ("Connection closed"),
      // mirroring the adapter-send -32000 flake that was previously invisible in the run summary.
      mcpServers: { broken: { command: process.execPath, args: ["-e", "process.exit(1)"] } },
      onEvent,
    }));

    expect(result.error).toBeNull();
    const initWarnings = (result.runtimeWarnings || []).filter((warning) => warning?.warning_kind === "mcp_init_failed");
    expect(initWarnings.length).toBeGreaterThanOrEqual(1);
    expect(initWarnings[0]).toMatchObject({ warning_kind: "mcp_init_failed", server: "broken" });
    // ...and it is STILL emitted to the live event stream (existing behavior preserved).
    const events = onEvent.mock.calls.map(([event]) => event);
    expect(events.some((event) => event?.warning_kind === "mcp_init_failed")).toBe(true);
  });

  it("propagates MCP CallToolResult.isError into tool-result and timing events", async () => {
    const model = setup();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("failing_thing", {}, { id: "mcp-error-1" })]),
      fauxAssistantMessage([fauxText("handled")]),
    ]);
    const connectSpy = vi.spyOn(McpClient.prototype, "connect").mockResolvedValue(undefined);
    const listSpy = vi.spyOn(McpClient.prototype, "listTools").mockResolvedValue({
      tools: [{ name: "failing_thing", description: "d", inputSchema: { type: "object", properties: {} } }],
    });
    const callSpy = vi.spyOn(McpClient.prototype, "callTool").mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "permission denied" }],
      structuredContent: { code: "denied" },
    });
    const closeSpy = vi.spyOn(McpClient.prototype, "close").mockResolvedValue(undefined);
    const onEvent = vi.fn();
    try {
      const result = await generatePiNativeResponse("system", runOptions(model, {
        messages: [{ role: "user", content: "try it" }],
        mcpServers: { srv: { type: "http", url: "http://127.0.0.1:9/mcp" } },
        onEvent,
      }));

      expect(result.error).toBeNull();
      const events = onEvent.mock.calls.map(([event]) => event);
      expect(events.find((event) => event.type === "tool_timing" && event.tool_use_id === "mcp-error-1"))
        .toMatchObject({ is_error: true });
      const toolResult = events
        .flatMap((event) => event?.message?.content || [])
        .find((block) => block.type === "tool_result" && block.tool_use_id === "mcp-error-1");
      expect(toolResult).toMatchObject({ is_error: true, content: "permission denied" });
      expect(toolResult.raw_result.details.raw).toMatchObject({
        isError: true,
        structuredContent: { code: "denied" },
      });
    } finally {
      connectSpy.mockRestore();
      listSpy.mockRestore();
      callSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it("captures structured output through the StructuredOutput tool", async () => {
    const model = setup();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("StructuredOutput", { answer: 42 }, { id: "so-1" })]),
      fauxAssistantMessage([fauxText("final")]),
    ]);

    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "give structured output" }],
      outputSchema: {
        type: "object",
        properties: { answer: { type: "number" } },
        required: ["answer"],
        additionalProperties: false,
      },
    }));

    expect(result.error).toBeNull();
    expect(result.structuredResult).toEqual({ answer: 42 });
    expect(result.structuredResultSource).toBe("StructuredOutput");
  });

  it("forwards maxRetries to the provider stream options", async () => {
    const model = setup();
    let seenOptions = null;
    faux.setResponses([
      (_context, options) => {
        seenOptions = options;
        return fauxAssistantMessage([fauxText("ok")]);
      },
    ]);

    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hi" }],
      piMaxRetries: 4,
    }));

    expect(result.error).toBeNull();
    expect(seenOptions?.maxRetries).toBe(4);
  });

  it("surfaces a provider stream error in the unified failure shape", async () => {
    const model = setup();
    const onEvent = vi.fn();
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom provider failure" }),
    ]);

    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hi" }],
      onEvent,
    }));

    expect(result.error).toBe("boom provider failure");
    expect(result.failureKind).toBeTruthy();
    expect(result.cancelled).toBe(false);
    expect(onEvent.mock.calls.some(([event]) => event?.type === "context_usage")).toBe(false);
  });

  it("resumes a durable session and seeds the next run with the prior transcript", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("reply-1")])]);
    const first = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-1" }],
      sessionKeepAlive: true,
      piSessionsRoot: sessionsRoot,
    }));
    expect(first.error).toBeNull();
    expect(first.text).toBe("reply-1");
    expect(first.providerSessionId).toBeTruthy();

    // Capture the provider context of the resumed run to assert prior turns are seeded.
    let resumedContext = null;
    faux.setResponses([
      (context) => {
        resumedContext = context;
        return fauxAssistantMessage([fauxText("reply-2")]);
      },
    ]);
    const second = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "turn-2" }],
      sessionKeepAlive: true,
      sessionId: first.providerSessionId,
      piSessionsRoot: sessionsRoot,
    }));
    expect(second.error).toBeNull();
    expect(second.text).toBe("reply-2");
    expect(second.providerSessionId).toBe(first.providerSessionId);

    const userTexts = (resumedContext?.messages || [])
      .filter((message) => message?.role === "user")
      .map((message) => (typeof message.content === "string"
        ? message.content
        : (message.content || [])
          .filter((block) => block?.type === "text")
          .map((block) => block.text)
          .join("")));
    expect(userTexts).toContain("turn-1");
    expect(userTexts).toContain("turn-2");
  });

  it("fails fast with session_not_found on an in-memory resume miss without invoking the provider", async () => {
    // In-memory resume miss (no piSessionsRoot): no live entry and no durable
    // repo to create-on-miss into, so the per-process session_not_found contract
    // holds. (The DURABLE resume miss now creates-on-miss under the requested id
    // — see the cross-restart resume test in pi-native-sessions.test.js, F9.)
    const model = setup();
    let invoked = false;
    faux.setResponses([
      () => { invoked = true; return fauxAssistantMessage([fauxText("never")]); },
    ]);
    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hi" }],
      sessionId: "no-such-native-session",
    }));
    expect(result.failureKind).toBe("session_not_found");
    expect(result.providerSessionId).toBe("no-such-native-session");
    expect(result.diagnostics.pi_error_code).toBe("pi_session_not_found");
    expect(invoked).toBe(false);
  });

  it("honors an already-aborted signal without invoking the provider", async () => {
    const model = setup();
    let invoked = false;
    faux.setResponses([
      () => { invoked = true; return fauxAssistantMessage([fauxText("never")]); },
    ]);
    const controller = new AbortController();
    controller.abort();
    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hi" }],
      abortSignal: controller.signal,
    }));
    expect(result.cancelled).toBe(true);
    expect(result.error).toBeNull();
    expect(invoked).toBe(false);
  });

  it("honors an abort that fires DURING setup, before the provider call (F5)", async () => {
    // The bridge installs its abort handler only AFTER a long stretch of awaited
    // setup (reopen/create/MCP-init/buildContext/appendMessage/getLeafId). An
    // abort that lands during that window is dropped by the (not-yet-attached)
    // handler, so the F5 re-check right before provider_request_started is the
    // load-bearing guard. We model "abort fired during setup" with a signal that
    // is NOT aborted at the entry pre-check (~:356) but flips to aborted exactly
    // when the bridge attaches its handler (~:640) — i.e. AFTER all setup awaits
    // and BEFORE the provider call (~:706). The faux response must never run.
    const model = setup();
    let invoked = false;
    faux.setResponses([
      () => { invoked = true; return fauxAssistantMessage([fauxText("never")]); },
    ]);

    let aborted = false;
    const signal = {
      get aborted() { return aborted; },
      reason: undefined,
      // The bridge attaches its handler here (post-setup); flipping aborted on
      // that call deterministically simulates an abort the handler install missed.
      addEventListener(_type, _handler, _opts) { aborted = true; },
      removeEventListener() {},
    };

    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hi" }],
      abortSignal: signal,
    }));
    expect(result.cancelled).toBe(true);
    expect(result.error).toBeNull();
    expect(invoked).toBe(false);
  });

  it("applies configured tool-output limits to tool params (not the pi-bridge fallbacks)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-native-limits-"));
    try {
      writeFileSync(join(root, "a.txt"), "needle here\n");
      const model = setup();
      // The model issues a Grep call with NO explicit max_output_chars/head_limit
      // so the params are filled in purely from the resolved tool limits. The
      // configured clamps are set BELOW the pi-bridge fallbacks (16000 text /
      // 100 search) so the normalized params can only equal the configured values
      // if settings-driven clamping reached the tool builder + display path.
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("Grep", { pattern: "needle" }, { id: "g-1" })]),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      const onEvent = vi.fn();
      const result = await generatePiNativeResponse("system", runOptions(model, {
        cwd: root,
        allowedTools: ["Grep"],
        messages: [{ role: "user", content: "search" }],
        settings: {
          // Both below the pi-bridge fallbacks (16000 text / 100 search) AND
          // within resolveAgentCompactionPolicy's clamp floors (>=1000 text,
          // >=10 search) so they survive policy resolution verbatim.
          agent_tool_text_limit_chars: 1000,
          agent_search_result_limit: 25,
        },
        onEvent,
      }));
      expect(result.error).toBeNull();

      const events = onEvent.mock.calls.map(([event]) => event);
      const toolUse = events
        .filter((event) => event?.message?.content?.[0]?.type === "tool_use")
        .map((event) => event.message.content[0])
        .find((block) => block.name === "Grep");
      expect(toolUse).toBeTruthy();
      // 1000 / 25 are the configured clamps; the fallback path would yield 16000 / 100.
      expect(toolUse.input.max_output_chars).toBe(1000);
      expect(toolUse.input.head_limit).toBe(25);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports context_compaction_applied as false when enabled but not triggered", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hi" }],
    }));
    expect(result.error).toBeNull();
    // false = the compaction path is enabled but did not need to fire this run.
    expect(result.capabilitiesUsed.context_compaction_applied).toBe(false);
  });

  it("reports context_compaction_applied as null when disabled via settings", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hi" }],
      settings: { agent_compaction_enabled: false },
    }));
    expect(result.error).toBeNull();
    expect(result.capabilitiesUsed.context_compaction_applied).toBeNull();
  });
});

describe("pi-native typed policy objects + deprecated settings shim", () => {
  const deprecationWarnings = (result) =>
    (result.runtimeWarnings || []).filter((warning) => warning?.warning_kind === "deprecated_settings_option");

  async function grepClampRun(overrides) {
    const root = mkdtempSync(join(tmpdir(), "pi-native-typed-"));
    try {
      writeFileSync(join(root, "a.txt"), "needle here\n");
      const model = setup();
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("Grep", { pattern: "needle" }, { id: "g-1" })]),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      const onEvent = vi.fn();
      const result = await generatePiNativeResponse("system", runOptions(model, {
        cwd: root,
        allowedTools: ["Grep"],
        messages: [{ role: "user", content: "search" }],
        onEvent,
        ...overrides,
      }));
      expect(result.error).toBeNull();
      const events = onEvent.mock.calls.map(([event]) => event);
      const toolUse = events
        .filter((event) => event?.message?.content?.[0]?.type === "tool_use")
        .map((event) => event.message.content[0])
        .find((block) => block.name === "Grep");
      return { result, toolUse };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("applies typed toolLimits clamps to tool params, with no deprecation warning", async () => {
    const { result, toolUse } = await grepClampRun({
      toolLimits: { toolTextLimitChars: 1000, searchResultLimit: 25 },
    });
    // 1000 / 25 are the configured clamps; the fallback path would yield 16000 / 100.
    expect(toolUse.input.max_output_chars).toBe(1000);
    expect(toolUse.input.head_limit).toBe(25);
    expect(deprecationWarnings(result)).toHaveLength(0);
  });

  it("emits exactly one deprecated_settings_option warning (with the consumed keys) when settings is used", async () => {
    const { result } = await grepClampRun({
      settings: { agent_tool_text_limit_chars: 1000, agent_search_result_limit: 25 },
    });
    const warnings = deprecationWarnings(result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].settings_keys).toEqual(
      expect.arrayContaining(["agent_tool_text_limit_chars", "agent_search_result_limit"]),
    );
  });

  it("lets a typed toolLimits object win over settings for its group (settings ignored, no warning)", async () => {
    const { result, toolUse } = await grepClampRun({
      toolLimits: { toolTextLimitChars: 1000, searchResultLimit: 25 },
      settings: { agent_tool_text_limit_chars: 5000, agent_search_result_limit: 77 },
    });
    // Typed object wins; the settings tool keys are ignored, so no group falls
    // back to settings and no deprecation warning fires.
    expect(toolUse.input.max_output_chars).toBe(1000);
    expect(toolUse.input.head_limit).toBe(25);
    expect(deprecationWarnings(result)).toHaveLength(0);
  });

  it("emits no deprecation warning when neither settings nor typed objects are passed", async () => {
    const { result } = await grepClampRun({});
    expect(deprecationWarnings(result)).toHaveLength(0);
  });

  it("honors a typed compaction policy object (enabled:false -> context_compaction_applied null)", async () => {
    const model = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
    const result = await generatePiNativeResponse("system", runOptions(model, {
      messages: [{ role: "user", content: "hi" }],
      compaction: { enabled: false },
    }));
    expect(result.error).toBeNull();
    expect(result.capabilitiesUsed.context_compaction_applied).toBeNull();
    expect(result.runtimeWarnings.filter((w) => w?.warning_kind === "deprecated_settings_option")).toHaveLength(0);
  });

  it("routes tool sandboxing through a per-run RuntimeSandbox override (run impl > host impl)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-native-sandbox-"));
    try {
      const recorder = (calls) => ({
        mergePolicies: (a, b) => b ?? a,
        prepareCommand: async ({ command }) => {
          calls.push(command);
          return { ...command, args: command.args ?? [], cwd: command.cwd ?? root, sandboxed: false };
        },
        networkAllowsUrl: () => true,
      });
      const hostCalls = [];
      const runCalls = [];
      // Host ToolContext carries one sandbox impl; the run overrides it with another.
      const toolContext = createToolContext({ workspace: root, sandbox: recorder(hostCalls) });
      const model = setup();
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("Bash", { command: "echo hi", workdir: root }, { id: "b-1" })]),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      const result = await generatePiNativeResponse("system", runOptions(model, {
        cwd: root,
        allowedTools: ["Bash"],
        messages: [{ role: "user", content: "run it" }],
        toolContext,
        sandbox: recorder(runCalls),
      }));
      expect(result.error).toBeNull();
      // The per-run sandbox impl enforced this run's Bash call; the host impl was
      // NOT consulted (run impl > host impl).
      expect(runCalls.some((command) => (command.args || []).some((arg) => /echo hi/.test(arg)))).toBe(true);
      expect(hostCalls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pi-native auto-compaction", () => {
  const sessionsRoot = mkdtempSync(join(tmpdir(), "pi-native-compaction-"));
  afterAll(() => rmSync(sessionsRoot, { recursive: true, force: true }));

  // Build a transcript large enough that AgentHarness.compact() (keepRecent ~20k)
  // finds a cut point and actually summarizes a prefix. The trailing user turn
  // becomes the prompt; the rest is seeded as prior history.
  function bigHistory(turns, chars) {
    const blob = "x".repeat(chars);
    const messages = [];
    for (let i = 0; i < turns; i += 1) {
      messages.push({ role: "user", content: `u${i} ${blob}` });
      messages.push({ role: "assistant", content: `a${i} ${blob}` });
    }
    messages.push({ role: "user", content: "continue" });
    return messages;
  }

  it("proactively compacts before the turn when near the window", async () => {
    const base = setup();
    const windowed = { ...base, contextWindow: 4000 };
    let summaryCalled = false;
    faux.setResponses([
      () => { summaryCalled = true; return fauxAssistantMessage([fauxText("SUMMARY of earlier work")]); },
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const result = await generatePiNativeResponse("system", runOptions(base, {
      piResolvedModel: windowed,
      model: { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:proactive" },
      messages: bigHistory(60, 2000),
      resolvePiApiKey: async () => "faux-key",
      piSessionsRoot: sessionsRoot,
    }));
    expect(result.error).toBeNull();
    expect(result.text).toBe("done");
    expect(summaryCalled).toBe(true);
    expect(result.capabilitiesUsed.context_compaction_applied).toBe(true);
    expect(result.diagnostics.context_compaction_proactive).toBe(true);
  });

  it("reactively compacts and re-prompts once when a turn overflows", async () => {
    const base = setup();
    // Huge window so the PROACTIVE trigger never fires; the overflow forces the
    // REACTIVE path. The big transcript lets compact() actually find a cut.
    const windowed = { ...base, contextWindow: 10_000_000 };
    let summaryCalled = false;
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "Your input exceeds the context window of this model." }),
      () => { summaryCalled = true; return fauxAssistantMessage([fauxText("SUMMARY")]); },
      fauxAssistantMessage([fauxText("recovered")]),
    ]);
    const result = await generatePiNativeResponse("system", runOptions(base, {
      piResolvedModel: windowed,
      model: { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:reactive" },
      messages: bigHistory(60, 2000),
      resolvePiApiKey: async () => "faux-key",
      piSessionsRoot: sessionsRoot,
    }));
    expect(result.error).toBeNull();
    expect(result.text).toBe("recovered");
    expect(summaryCalled).toBe(true);
    expect(result.capabilitiesUsed.context_compaction_applied).toBe(true);
    expect(result.diagnostics.context_compaction_reactive).toBe(true);
    expect(result.diagnostics.context_compaction_proactive).toBeUndefined();
  });

  it("does not re-compact (or loop) when a proactively-compacted turn still overflows", async () => {
    const base = setup();
    // Small window so the PROACTIVE trigger fires; the turn then still overflows.
    const windowed = { ...base, contextWindow: 4000 };
    let providerCalls = 0;
    faux.setResponses([
      () => { providerCalls += 1; return fauxAssistantMessage([fauxText("SUMMARY")]); }, // proactive compact
      () => { providerCalls += 1; return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Your input exceeds the context window of this model." }); },
      () => { providerCalls += 1; return fauxAssistantMessage([fauxText("should-not-happen")]); },
    ]);
    const result = await generatePiNativeResponse("system", runOptions(base, {
      piResolvedModel: windowed,
      model: { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:guard" },
      messages: bigHistory(60, 2000),
      resolvePiApiKey: async () => "faux-key",
      piSessionsRoot: sessionsRoot,
    }));
    // Proactive compaction fired, the turn still overflowed, and the bridge
    // surfaces the overflow WITHOUT a second compaction or a re-prompt.
    expect(result.diagnostics.context_compaction_proactive).toBe(true);
    expect(result.error).toBe("Your input exceeds the context window of this model.");
    expect(result.failureKind).toBe("context_limit");
    expect(providerCalls).toBe(2); // summary + main overflow; no re-prompt
  });

  it("re-prompts at most once even if the overflow persists after compaction", async () => {
    const base = setup();
    const windowed = { ...base, contextWindow: 10_000_000 };
    let providerCalls = 0;
    faux.setResponses([
      () => { providerCalls += 1; return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Your input exceeds the context window of this model." }); },
      () => { providerCalls += 1; return fauxAssistantMessage([fauxText("SUMMARY")]); },
      () => { providerCalls += 1; return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Your input exceeds the context window of this model." }); },
      () => { providerCalls += 1; return fauxAssistantMessage([fauxText("should-not-happen")]); },
    ]);
    const result = await generatePiNativeResponse("system", runOptions(base, {
      piResolvedModel: windowed,
      model: { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:loop" },
      messages: bigHistory(60, 2000),
      resolvePiApiKey: async () => "faux-key",
      piSessionsRoot: sessionsRoot,
    }));
    expect(result.failureKind).toBe("context_limit");
    // overflow + summary + ONE re-prompt overflow = 3 calls; never the 4th.
    expect(providerCalls).toBe(3);
    expect(result.diagnostics.context_compaction_reactive).toBe(true);
  });

  it("learns the real context window from an overflow error and triggers proactively next run", async () => {
    const base = setup();
    // Declared window is large, so proactively nothing fires at first.
    const windowed = { ...base, contextWindow: 200000 };
    const runRef = { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:learn" };

    // Run 1: a ~60k-token transcript stays under the declared-window trigger
    // (~150k), so it does NOT compact proactively. The overflow names the real
    // ceiling (120000), which the bridge records for this model.
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "maximum context length is 120000 tokens" }),
      fauxAssistantMessage([fauxText("SUMMARY")]),
      fauxAssistantMessage([fauxText("recovered-1")]),
    ]);
    const run1 = await generatePiNativeResponse("system", runOptions(base, {
      piResolvedModel: windowed,
      model: runRef,
      messages: bigHistory(60, 2000),
      resolvePiApiKey: async () => "faux-key",
      piSessionsRoot: sessionsRoot,
    }));
    expect(run1.diagnostics.context_compaction_proactive).toBeUndefined();
    expect(run1.diagnostics.context_compaction_reactive).toBe(true);

    // Run 2: same model. A ~110k-token transcript is under the declared trigger
    // (~150k) but OVER the learned-window trigger (~90k), so proactive fires only
    // because the real ceiling (120000) was learned.
    faux.setResponses([
      fauxAssistantMessage([fauxText("SUMMARY")]),
      fauxAssistantMessage([fauxText("done-2")]),
    ]);
    const run2 = await generatePiNativeResponse("system", runOptions(base, {
      piResolvedModel: windowed,
      model: runRef,
      messages: bigHistory(110, 2000),
      resolvePiApiKey: async () => "faux-key",
      piSessionsRoot: sessionsRoot,
    }));
    expect(run2.error).toBeNull();
    expect(run2.text).toBe("done-2");
    expect(run2.diagnostics.context_compaction_proactive).toBe(true);
    expect(run2.diagnostics.context_window).toBe(120000);
  });

  // Budget-aware compaction (Layer A): the raw transcript estimate excludes the
  // system prompt + tool schemas the provider meters. On a seeded session whose
  // last-assistant usage is absent (cron-after-restart / daily rollover) the raw
  // branch wins, so without the fixed-overhead correction the trigger under-fires
  // and the request overflows. These two runs use the SAME transcript (sized just
  // UNDER the trigger) so the ONLY thing that flips proactive compaction on is the
  // overhead from a large system prompt + several tools.
  //
  // contextWindow 100000 -> trigger 70000, keepRecent 10000. The seeded transcript
  // (~56k tokens) sits below the trigger but above keepRecent (so compact() has a
  // prefix to summarize). The overhead counts the system prompt (~30k tokens) +
  // tool schemas + the trailing per-turn user message ("continue", ~3 tokens) —
  // NOT the prior transcript (already summed by the raw branch). That ~30k of
  // overhead pushes the corrected estimate (~56k + ~30k = ~86k) over 70000.
  function overheadFixture(reference) {
    const base = setup();
    const windowed = { ...base, contextWindow: 100000 };
    // ~120k chars -> ~30k tokens of system-prompt overhead.
    const bigSystemPrompt = "S".repeat(120000);
    // Several distinct tools so toolSchemaTokens is non-trivial too (the bridge's
    // built-in tools are also counted, but allowing a couple makes the intent
    // explicit and keeps the schemas in the overhead estimate).
    const messages = bigHistory(28, 4000); // ~56k-token transcript, under 75000.
    return { base, windowed, reference, bigSystemPrompt, messages };
  }

  it("proactively compacts on a seeded session once fixed overhead is counted (default on)", async () => {
    const { base, windowed, bigSystemPrompt, messages } = overheadFixture("pi:faux:overhead-on");
    // When the corrected trigger fires: call 1 = compaction summary, call 2 = turn.
    let providerCalls = 0;
    faux.setResponses([
      () => { providerCalls += 1; return fauxAssistantMessage([fauxText("SUMMARY")]); },
      () => { providerCalls += 1; return fauxAssistantMessage([fauxText("done")]); },
    ]);
    const result = await generatePiNativeResponse(bigSystemPrompt, runOptions(base, {
      piResolvedModel: windowed,
      model: { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:overhead-on" },
      messages,
      allowedTools: ["Read", "Grep", "Bash"],
      resolvePiApiKey: async () => "faux-key",
      piSessionsRoot: sessionsRoot,
      // On by default — no flag set; the correction fires unless explicitly disabled.
    }));
    expect(result.error).toBeNull();
    expect(result.text).toBe("done");
    expect(providerCalls).toBe(2); // summary + turn — proactive compaction fired
    expect(result.capabilitiesUsed.context_compaction_applied).toBe(true);
    expect(result.diagnostics.context_compaction_proactive).toBe(true);
    // A4 observability: the new budget-aware diagnostics are present and consistent.
    expect(result.diagnostics.context_fixed_overhead_tokens).toBeGreaterThan(0);
    expect(result.diagnostics.context_system_prompt_tokens).toBeGreaterThan(0);
    expect(typeof result.diagnostics.context_tool_schema_tokens).toBe("number");
    expect(result.diagnostics.context_compaction_trigger_tokens).toBe(70000);
    expect(result.diagnostics.context_transcript_estimate)
      .toBeGreaterThanOrEqual(result.diagnostics.context_compaction_trigger_tokens);
    // Regression guard for the transcript double-count: only the TRAILING per-turn
    // user message ("continue", ~3 tokens) plus the system prompt (~30k) + tool
    // schemas may be counted — NOT the ~56k-token prior transcript (already summed
    // by the raw branch). A double-count would inflate this past the system prompt
    // by tens of thousands of tokens, so bound it just above the system-prompt size.
    expect(result.diagnostics.context_fixed_overhead_tokens)
      .toBeLessThan(result.diagnostics.context_system_prompt_tokens + 1000);
  });

  it("does NOT proactively compact on the same seeded session when fixed overhead is explicitly disabled", async () => {
    const { base, windowed, bigSystemPrompt, messages } = overheadFixture("pi:faux:overhead-off");
    // With overhead explicitly disabled the transcript alone is under the trigger,
    // so no compaction fires: call 1 IS the turn (text "turn-output"), never a summary.
    let providerCalls = 0;
    faux.setResponses([
      () => { providerCalls += 1; return fauxAssistantMessage([fauxText("turn-output")]); },
      () => { providerCalls += 1; return fauxAssistantMessage([fauxText("should-not-happen")]); },
    ]);
    const result = await generatePiNativeResponse(bigSystemPrompt, runOptions(base, {
      piResolvedModel: windowed,
      model: { sdk: "pi", provider: "faux", model: "faux-model", reference: "pi:faux:overhead-off" },
      messages,
      allowedTools: ["Read", "Grep", "Bash"],
      resolvePiApiKey: async () => "faux-key",
      piSessionsRoot: sessionsRoot,
      // Escape hatch: explicitly disable the correction to restore the prior
      // transcript-only trigger (under-counts overhead).
      settings: { agent_compaction_fixed_overhead_enabled: false },
    }));
    expect(result.error).toBeNull();
    // Disabling overhead reproduces the prior under-counting behavior: the proactive
    // path does NOT fire, so the very first provider call is the turn itself.
    expect(providerCalls).toBe(1);
    expect(result.text).toBe("turn-output");
    expect(result.diagnostics.context_compaction_proactive).toBeUndefined();
    expect(result.diagnostics.context_fixed_overhead_tokens).toBe(0);
    expect(result.diagnostics.context_request_estimate_tokens).toBeGreaterThan(0);
  });
});
