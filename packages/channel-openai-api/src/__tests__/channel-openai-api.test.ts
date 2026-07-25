// SPDX-License-Identifier: MIT
import { readFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { hostname as systemHostname } from "node:os";

import {
  isEnvEligibleSchema,
  isSecretSchema,
  type ChannelHost,
  type ChannelInboundRequest,
  type ChannelReplySink,
  type ChannelTurnResult,
} from "@mono-agent/module-sdk";
import { assertChannelModuleCompliance } from "@mono-agent/module-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOpenAiApiServer,
  monoAgentModule,
  openAiApiConfigSchema,
  parseOpenAiApiConfig,
  type OpenAiApiConfig,
  type OpenAiApiServer,
  type OpenAiApiStartInfo,
} from "../index.js";
import {
  OPEN_WEBUI_TOOL_DETAIL_FRAME_BYTES,
  renderOpenWebUiToolDetail,
} from "../tool-details.js";

const httpTestState = vi.hoisted(() => ({
  latestServer: undefined as Server | undefined,
}));

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: unknown[]) => {
      const server = Reflect.apply(actual.createServer, actual, args) as Server;
      httpTestState.latestServer = server;
      return server;
    },
  };
});

const KEY = "openai-api-test-key-long-enough!";
const servers = new Set<OpenAiApiServer>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.stop()));
  servers.clear();
  httpTestState.latestServer = undefined;
});

describe("OpenAI-compatible channel", () => {
  it("renders completed host tools as bounded Open WebUI details without file bytes", () => {
    const detail = renderOpenWebUiToolDetail(
      {
        id: "call-<&\"",
        name: "search<&\"",
        input: {
          token: "input-secret-value",
          query: `<unsafe>${"x".repeat(20_000)}`,
        },
      },
      {
        callId: "call-<&\"",
        content: [
          {
            type: "json",
            value: {
              authorization: "Bearer result-secret-value",
              note: "password=hunter2",
            },
          },
          {
            type: "file",
            mediaType: "application/octet-stream",
            name: "secret.bin",
            data: new Uint8Array([1, 2, 3, 4]),
          },
          { type: "text", text: `<result>${"y".repeat(20_000)}` },
        ],
      },
    );

    expect(Buffer.byteLength(detail, "utf8")).toBeLessThanOrEqual(
      OPEN_WEBUI_TOOL_DETAIL_FRAME_BYTES,
    );
    expect(detail).toContain('<details type="tool_calls" done="true"');
    expect(detail).toContain("Tool Executed");
    expect(detail).toContain("&lt;unsafe&gt;");
    expect(detail).toContain("&lt;result&gt;");
    expect(detail).toContain("__monoAgentTruncation");
    expect(detail).toContain("bytesOmitted");
    expect(detail).toContain("[REDACTED]");
    expect(detail).not.toContain("input-secret-value");
    expect(detail).not.toContain("result-secret-value");
    expect(detail).not.toContain("hunter2");
    expect(detail).not.toContain('"0":1');
  });

  it("redacts quoted credential assignments and Basic or Bearer authorization values", () => {
    const detail = renderOpenWebUiToolDetail(
      {
        id: "call-redaction",
        name: "lookup",
        input: {
          quotedJson: '{"password":"quoted-input-secret"}',
          basicAuthorization: "Basic YTpi",
        },
      },
      {
        callId: "call-redaction",
        content: [{
          type: "text",
          text: [
            '{"api_key":"quoted-result-secret"}',
            "Bearer eyJhbGciOiJIUzI1NiJ9.secret.signature",
          ].join(" "),
        }],
      },
    );

    expect(detail).toContain("[REDACTED]");
    expect(detail).not.toContain("quoted-input-secret");
    expect(detail).not.toContain("quoted-result-secret");
    expect(detail).not.toContain("YTpi");
    expect(detail).not.toContain("eyJhbGciOiJIUzI1NiJ9.secret.signature");
  });

  it("renders completed tools into the JSON assistant content without delegating them to the client", async () => {
    const { info } = await start(async (_request, reply) => {
      await reply.emit({ type: "text-delta", delta: "before " });
      await reply.emit({
        type: "tool-call",
        call: {
          id: "call-json",
          name: "lookup",
          input: { query: "status", apiKey: "json-input-secret" },
        },
      });
      await reply.emit({
        type: "tool-result",
        result: {
          callId: "call-json",
          content: [
            { type: "json", value: { status: "ready", token: "json-result-secret" } },
            {
              type: "file",
              mediaType: "application/octet-stream",
              name: "private.bin",
              data: new Uint8Array([9, 8, 7]),
            },
          ],
        },
      });
      await reply.emit({ type: "text-delta", delta: "after" });
      return { status: "completed", text: "before after" };
    });

    const response = await post(info, chatBody(false));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };
    const content = body.choices[0]!.message.content;
    expect(content).toMatch(/^before <details type="tool_calls"[\s\S]*<\/details>\nafter$/u);
    expect(body.choices[0]!.finish_reason).toBe("stop");
    expect(content).toContain('id="call-json"');
    expect(content).toContain('name="lookup"');
    expect(content).toContain("bytesOmitted");
    expect(content).toContain("[REDACTED]");
    expect(content).not.toContain("json-input-secret");
    expect(content).not.toContain("json-result-secret");
    expect(body.choices[0]!.message).not.toHaveProperty("tool_calls");
  });

  it("streams each completed tool detail between the surrounding text deltas", async () => {
    const { info } = await start(async (_request, reply) => {
      await reply.emit({ type: "text-delta", delta: "before " });
      await reply.emit({
        type: "tool-call",
        call: { id: "call-stream", name: "search", input: { query: "bounded" } },
      });
      await reply.emit({
        type: "tool-result",
        result: {
          callId: "call-stream",
          content: [{ type: "text", text: "found" }],
        },
      });
      await reply.emit({ type: "text-delta", delta: "after" });
      return { status: "completed", text: "before after" };
    });

    const response = await post(info, chatBody(true));
    expect(response.status).toBe(200);
    const stream = await response.text();
    const content = deltaValues(stream);
    expect(content).toHaveLength(3);
    expect(content[0]).toBe("before ");
    expect(content[1]).toMatch(/^<details type="tool_calls" done="true"[\s\S]*Tool Executed[\s\S]*found[\s\S]*<\/details>\n$/u);
    expect(content[2]).toBe("after");
    expect(content.join("")).toBe(`before ${content[1]}after`);
    expect(stream.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("fails closed on unmatched or unfinished tool event sequences", async () => {
    let attempt = 0;
    const { info } = await start(async (_request, reply) => {
      attempt += 1;
      if (attempt === 1) {
        await reply.emit({
          type: "tool-result",
          result: { callId: "missing", content: [] },
        });
      } else {
        await reply.emit({
          type: "tool-call",
          call: { id: "unfinished", name: "lookup", input: {} },
        });
      }
      return { status: "completed", text: "must not render" };
    });

    const unmatched = await post(info, chatBody(false));
    expect(unmatched.status).toBe(502);
    expect(await errorCode(unmatched)).toBe("invalid_tool_event");

    const unfinished = await post(info, chatBody(false));
    expect(unfinished.status).toBe(502);
    expect(await errorCode(unfinished)).toBe("incomplete_tool_event");
  });

  it("rejects reused tool-call ids for JSON and already-started SSE responses", async () => {
    const { info } = await start(async (_request, reply) => {
      await reply.emit({ type: "text-delta", delta: "before " });
      await reply.emit({
        type: "tool-call",
        call: { id: "reused", name: "lookup", input: { attempt: 1 } },
      });
      await reply.emit({
        type: "tool-result",
        result: { callId: "reused", content: [{ type: "text", text: "first" }] },
      });
      await reply.emit({
        type: "tool-call",
        call: { id: "reused", name: "lookup", input: { attempt: 2 } },
      });
      return { status: "completed", text: "must not complete" };
    });

    await expectInvalidToolSequence(info, false, 0);
    await expectInvalidToolSequence(info, true, 1);
  });

  it("bounds total tool calls per turn for JSON and already-started SSE responses", async () => {
    const { info } = await start(async (_request, reply) => {
      await reply.emit({ type: "text-delta", delta: "before " });
      for (let index = 0; index < 256; index += 1) {
        const id = `bounded-${String(index)}`;
        await reply.emit({
          type: "tool-call",
          call: { id, name: "lookup", input: {} },
        });
        await reply.emit({
          type: "tool-result",
          result: { callId: id, content: [] },
        });
      }
      await reply.emit({
        type: "tool-call",
        call: { id: "one-too-many", name: "lookup", input: {} },
      });
      return { status: "completed", text: "must not complete" };
    });

    await expectInvalidToolSequence(info, false, 0);
    await expectInvalidToolSequence(info, true, 256);
  });

  it("requires env-only authentication, defaults to loopback, and gates non-loopback binds", () => {
    const properties = openAiApiConfigSchema.jsonSchema.properties as Record<string, Readonly<Record<string, unknown>>>;
    const apiKey = properties.apiKey!;
    expect(isEnvEligibleSchema(apiKey)).toBe(true);
    expect(isSecretSchema(apiKey)).toBe(true);
    expect(properties.allowNonLoopback).toMatchObject({ type: "boolean", default: false });
    expect(properties.maxResponseBytes).toMatchObject({ minimum: 4_096 });
    expect(() => parseOpenAiApiConfig({ apiKey: { $env: "KEY" } })).toThrow(/resolved/u);
    expect(() => parseOpenAiApiConfig({ apiKey: KEY, listen: { host: "0.0.0.0" } })).toThrow(/loopback/u);
    expect(() => parseOpenAiApiConfig({
      apiKey: "x".repeat(31),
      listen: { host: "0.0.0.0" },
      allowNonLoopback: true,
    })).toThrow(/at least 32/u);
    expect(parseOpenAiApiConfig({
      apiKey: KEY,
      listen: { host: "0.0.0.0" },
      allowNonLoopback: true,
    })).toMatchObject({ listen: { host: "0.0.0.0" }, allowNonLoopback: true });
    expect(() => parseOpenAiApiConfig({ apiKey: KEY, allowNonLoopback: "yes" })).toThrow(/boolean/u);
    expect(() => parseOpenAiApiConfig({ apiKey: KEY, basePath: "//v1" })).toThrow(/origin-form/u);
    expect(() => parseOpenAiApiConfig({ apiKey: KEY, basePath: "/" })).toThrow(/must not be the root path/u);
    expect(() => assertChannelModuleCompliance(monoAgentModule, { expectedPackageName: "@mono-agent/channel-openai-api" })).not.toThrow();
  });

  it("keeps the module manifest version aligned with package.json", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { readonly version: unknown };

    expect(monoAgentModule.manifest.packageVersion).toBe(packageJson.version);
  });

  it("defensively rejects unsafe public config values passed around the parser", () => {
    const parsed = parseOpenAiApiConfig({ apiKey: KEY });
    const unsafe: OpenAiApiConfig = {
      ...parsed,
      listen: { host: "0.0.0.0", port: 0 },
    };
    expect(() => createOpenAiApiServer({
      config: unsafe,
      dispatch: async () => ({ status: "completed", text: "unexpected" }),
    })).toThrow(/explicit allowNonLoopback/u);
    expect(() => createOpenAiApiServer({
      config: { ...unsafe, allowNonLoopback: true, apiKey: "x".repeat(31) },
      dispatch: async () => ({ status: "completed", text: "unexpected" }),
    })).toThrow(/at least 32/u);
  });

  it("serves an explicitly authorized wildcard bind through safe local authorities", async () => {
    const dispatch = vi.fn(async () => ({ status: "completed" as const, text: "ok" }));
    const { info } = await start(dispatch, {
      listen: { host: "0.0.0.0", port: 0 },
      allowNonLoopback: true,
    });

    expect(info.host).toBe("0.0.0.0");
    expect(new URL(info.baseUrl).hostname).toBe("127.0.0.1");
    const models = await fetch(info.modelsUrl, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(models.status).toBe(200);
    expect(await authorityStatus(info.port, `${systemHostname()}:${info.port}`)).toBe(200);
    expect(await authorityStatus(info.port, `attacker.invalid:${info.port}`)).toBe(421);

    const completion = await post(info, chatBody(false), {
      origin: new URL(info.baseUrl).origin,
    });
    expect(completion.status).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("authenticates first, rejects queries, and requires Origin to match Host authority exactly", async () => {
    const dispatch = vi.fn(async () => ({ status: "completed" as const, text: "ok" }));
    const { info } = await start(dispatch);

    expect((await fetch(`${info.modelsUrl}?probe=1`)).status).toBe(401);
    const query = await fetch(`${info.modelsUrl}?probe=1`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(query.status).toBe(400);
    expect(await errorCode(query)).toBe("invalid_query");
    expect(await authorityStatus(info.port, `attacker.invalid:${info.port}`)).toBe(421);

    const aliasOrigin = await post(info, chatBody(false), { origin: `http://localhost:${info.port}` });
    expect(aliasOrigin.status).toBe(403);
    expect(await errorCode(aliasOrigin)).toBe("cross_origin");

    const exactOrigin = await post(info, chatBody(false), { origin: new URL(info.baseUrl).origin });
    expect(exactOrigin.status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("normalizes canonical inline images without forwarding the facade model as a Core override", async () => {
    const seen: ChannelInboundRequest[] = [];
    const dispatch = vi.fn(async (request: ChannelInboundRequest, reply: ChannelReplySink) => {
      seen.push(request);
      await reply.emit({ type: "text-delta", delta: "hello world" });
      await reply.emit({ type: "usage", usage: { inputTokens: 3, outputTokens: 2 } });
      return { status: "completed" as const, text: "hello world" };
    });
    const { info } = await start(dispatch);

    const response = await post(info, chatBody(false));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: "hello world" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    expect(seen[0]).toMatchObject({
      conversationId: "openai:chat-1",
      attachments: [{ mediaType: "image/png", sizeBytes: 4 }],
    });
    expect(seen[0]).not.toHaveProperty("model");

    const invalid = replaceImage(chatBody(false), "data:image/png;base64,AB==");
    const invalidResponse = await post(info, invalid);
    expect(invalidResponse.status).toBe(400);
    expect(await errorCode(invalidResponse)).toBe("invalid_image");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("uses Open WebUI chat identity and sends only the latest user turn for durable continuation", async () => {
    const requests: ChannelInboundRequest[] = [];
    const { info } = await start(async (request) => {
      requests.push(request);
      return { status: "completed", text: "ok" };
    });
    const response = await post(info, {
      model: "personal",
      stream: false,
      user: "person-1",
      messages: [
        { role: "system", content: "client system" },
        { role: "user", content: "old user" },
        { role: "assistant", content: "old assistant" },
        { role: "user", content: "latest user" },
      ],
    }, { "x-openwebui-chat-id": "owui-chat-1" });
    expect(response.status).toBe(200);
    expect(requests[0]).toMatchObject({
      conversationId: "openai:owui-chat-1",
      sender: { id: "person-1" },
      text: "[user]\nlatest user",
    });

    const second = await post(info, {
      model: "personal",
      stream: false,
      metadata: { conversation_id: "body-chat" },
      messages: [{ role: "user", content: "body wins" }],
    }, { "x-openwebui-chat-id": "header-chat" });
    expect(second.status).toBe(200);
    expect(requests[1]).toMatchObject({ conversationId: "openai:body-chat" });
  });

  it("keeps append-only SSE replacements and final text truthful without duplication", async () => {
    const dispatch = vi.fn(async (_request: ChannelInboundRequest, reply: ChannelReplySink) => {
      await reply.emit({ type: "text-delta", delta: "hello" });
      await reply.emit({ type: "text-replace", text: "hello world" });
      await reply.emit({ type: "usage", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } });
      return { status: "completed" as const, text: "hello world" };
    });
    const { info } = await start(dispatch);

    const response = await post(info, chatBody(true, true));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const stream = await response.text();
    expect(deltaContent(stream)).toBe("hello world");
    expect(stream).toContain('"finish_reason":"stop"');
    expect(stream).toContain('"prompt_tokens":4');
    expect(stream.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("drops transient thinking from JSON and streaming assistant responses", async () => {
    const hidden = `private-reasoning-${"x".repeat(8_000)}`;
    const dispatch = vi.fn(async (_request: ChannelInboundRequest, reply: ChannelReplySink) => {
      await reply.emit({ type: "thinking-delta", delta: hidden });
      await reply.emit({ type: "text-delta", delta: "visible answer" });
      return { status: "completed" as const, text: "visible answer" };
    });
    const { info } = await start(dispatch, { maxResponseBytes: 4_096 });

    const json = await post(info, chatBody(false));
    expect(json.status).toBe(200);
    const jsonBody = await json.text();
    expect(jsonBody).toContain("visible answer");
    expect(jsonBody).not.toContain("private-reasoning");

    const streaming = await post(info, chatBody(true));
    expect(streaming.status).toBe(200);
    const streamBody = await streaming.text();
    expect(deltaContent(streamBody)).toBe("visible answer");
    expect(streamBody).not.toContain("private-reasoning");
  });

  it("drops activity without failing a completed turn", async () => {
    const { info } = await start(async (_request, reply) => {
      await reply.emit({ type: "text-delta", delta: "visible " });
      await reply.emit({ type: "activity", text: "working" });
      await reply.emit({ type: "text-delta", delta: "answer" });
      return { status: "completed", text: "visible answer" };
    });

    const response = await post(info, chatBody(false));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: "visible answer" }, finish_reason: "stop" }],
    });
  });

  it("terminates SSE with an error instead of appending divergent replacement or final text", async () => {
    let call = 0;
    const dispatch = vi.fn(async (_request: ChannelInboundRequest, reply: ChannelReplySink) => {
      call += 1;
      await reply.emit({ type: "text-delta", delta: "draft" });
      if (call === 1) await reply.emit({ type: "text-replace", text: "final" });
      return { status: "completed" as const, text: "final" };
    });
    const { info } = await start(dispatch);

    const replacement = await post(info, chatBody(true));
    expect(replacement.status).toBe(200);
    const replacementStream = await replacement.text();
    expect(replacementStream).toContain('"code":"non_append_text_replace"');
    expect(replacementStream).not.toContain('"finish_reason":"stop"');
    expect(replacementStream.endsWith("data: [DONE]\n\n")).toBe(true);

    const final = await post(info, chatBody(true));
    expect(final.status).toBe(200);
    const finalStream = await final.text();
    expect(finalStream).toContain('"code":"non_append_final_text"');
    expect(finalStream).not.toContain('"finish_reason":"stop"');
    expect(finalStream.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("bounds dispatch even when Core ignores abort", async () => {
    let signal: AbortSignal | undefined;
    const dispatch = vi.fn((request: ChannelInboundRequest): Promise<ChannelTurnResult> => {
      signal = request.signal;
      return new Promise<ChannelTurnResult>(() => {});
    });
    const { info } = await start(dispatch, { maxRunMs: 20 });
    const started = Date.now();

    const response = await post(info, chatBody(false));
    expect(response.status).toBe(504);
    expect(await errorCode(response)).toBe("turn_timeout");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(signal?.aborted).toBe(true);
  });

  it("lets an in-flight module request finish during graceful drain", async () => {
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    const lifecycle = new AbortController();
    const host: ChannelHost = {
      grantedCapabilities: new Set(),
      getCapability<T>(): T | undefined {
        return undefined;
      },
      async dispatch(request) {
        requestSignal = request.signal;
        markEntered();
        await dispatchGate;
        return { status: "completed", text: "drained answer" };
      },
    };
    const channel = await monoAgentModule.create({
      instanceId: "openai-drain",
      config: monoAgentModule.schema.parse({ apiKey: KEY, modelId: "personal" }),
      provenance: {},
      configDirectory: "/config",
      workspaceDirectory: "/workspace",
      dataDirectory: "/data",
      logger: noopLogger(),
      host,
      signal: lifecycle.signal,
    });

    try {
      await channel.start?.({ signal: lifecycle.signal });
      const responsePromise = post(channel.startInfo!, chatBody(false));
      await entered;
      let drainSettled = false;
      const draining = Promise.resolve(channel.drain?.({
        signal: lifecycle.signal,
        deadline: new Date(Date.now() + 2_000).toISOString(),
      })).then(() => {
        drainSettled = true;
      });

      await Promise.resolve();
      expect(drainSettled).toBe(false);
      expect(requestSignal?.aborted).toBe(false);
      releaseDispatch();

      const [response] = await Promise.all([responsePromise, draining]);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        choices: [{ message: { content: "drained answer" } }],
      });
      expect(requestSignal?.aborted).toBe(false);
      expect(channel.endpoint).toBeUndefined();
    } finally {
      await channel.stop?.({ signal: lifecycle.signal, reason: "shutdown" });
    }
  });

  it("abrupt stop aborts an in-flight request with 503", async () => {
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    const { server, info } = await start(async (request) => {
      requestSignal = request.signal;
      markEntered();
      await waitForAbort(request.signal);
      return { status: "cancelled" };
    });
    const responsePromise = post(info, chatBody(false));
    await entered;

    const stopping = server.stop();
    const response = await responsePromise;
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("shutting_down");
    await stopping;
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toMatchObject({
      status: 503,
      code: "shutting_down",
    });
  });

  it("escalates an active graceful drain when stop is called", async () => {
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    const { server, info } = await start(async (request) => {
      requestSignal = request.signal;
      markEntered();
      await waitForAbort(request.signal);
      return { status: "cancelled" };
    });
    const responsePromise = post(info, chatBody(false));
    await entered;
    let drainSettled = false;
    const draining = server.drain({
      signal: new AbortController().signal,
      deadline: new Date(Date.now() + 2_000).toISOString(),
    }).then(() => {
      drainSettled = true;
    });

    await Promise.resolve();
    expect(drainSettled).toBe(false);
    expect(requestSignal?.aborted).toBe(false);
    const startedAt = Date.now();
    const stopping = server.stop();

    const [response] = await Promise.all([responsePromise, draining, stopping]);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("shutting_down");
    expect(requestSignal?.aborted).toBe(true);
  });

  it("bounds a request body admitted before drain by the listener deadline", async () => {
    const dispatch = vi.fn(async () => ({ status: "completed" as const, text: "unexpected" }));
    const { server, info } = await start(dispatch);
    const listener = httpTestState.latestServer;
    expect(listener).toBeDefined();
    let markAdmitted!: () => void;
    const admitted = new Promise<void>((resolve) => {
      markAdmitted = resolve;
    });
    listener!.once("request", markAdmitted);
    const url = new URL(info.chatCompletionsUrl);
    const request = httpRequest({
      hostname: url.hostname,
      port: info.port,
      path: url.pathname,
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
        "content-length": 100,
      },
    });
    request.on("error", () => undefined);
    request.flushHeaders();
    request.write("{");
    await admitted;
    let drainSettled = false;
    const startedAt = Date.now();
    const draining = server.drain({
      signal: new AbortController().signal,
      deadline: new Date(Date.now() + 100).toISOString(),
    }).then(() => {
      drainSettled = true;
    });

    await Promise.resolve();
    expect(drainSettled).toBe(false);
    expect(server.health().activeRequests).toBe(0);
    await draining;
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(dispatch).not.toHaveBeenCalled();
    request.destroy();
  });

  it("falls back to abrupt cancellation at an expired drain deadline", async () => {
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    const { server, info } = await start((request) => {
      requestSignal = request.signal;
      markEntered();
      return new Promise<ChannelTurnResult>(() => {});
    });
    const responsePromise = post(info, chatBody(false)).catch(() => undefined);
    await entered;
    const startedAt = Date.now();

    await server.drain({
      signal: new AbortController().signal,
      deadline: new Date(0).toISOString(),
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toMatchObject({
      status: 503,
      code: "shutting_down",
    });
    await responsePromise;
    await vi.waitFor(() => expect(server.health().activeRequests).toBe(0));
  });

  it("rejects restart after stop", async () => {
    const { server } = await start(async () => ({ status: "completed", text: "ok" }));

    await server.stop();

    await expect(server.start()).rejects.toThrow("cannot restart after stop");
  });

  it("reports degraded health after a post-startup listener error", async () => {
    const { server } = await start(async () => ({ status: "completed", text: "ok" }));
    const listener = httpTestState.latestServer;
    expect(listener).toBeDefined();

    listener!.emit("error", new Error("post-start listener failure"));

    expect(server.health()).toMatchObject({
      status: "degraded",
      message: "OpenAI API listener failed after startup.",
    });
  });

  it("aborts dispatch with client_closed when a streaming client disconnects", async () => {
    let requestSignal: AbortSignal | undefined;
    const { server, info } = await start(async (request, reply) => {
      requestSignal = request.signal;
      await reply.emit({ type: "text-delta", delta: "first chunk" });
      await waitForAbort(request.signal);
      return { status: "cancelled" };
    });

    await disconnectAfterFirstChunk(info);

    await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true));
    expect(requestSignal?.reason).toMatchObject({
      status: 499,
      code: "client_closed",
    });
    await vi.waitFor(() => expect(server.health().activeRequests).toBe(0));
  });

  it("does not inspect accessors on an untrusted dispatch failure", async () => {
    const hostile = new Proxy({}, {
      getPrototypeOf() { throw new Error("accessor must not escape"); },
      get() { throw new Error("accessor must not escape"); },
    });
    const { info } = await start(async () => { throw hostile; });
    const response = await post(info, chatBody(false));
    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe("internal_error");
  });

  it("bounds response output and rejects reply events Chat Completions cannot represent", async () => {
    let call = 0;
    const dispatch = vi.fn(async (_request: ChannelInboundRequest, reply: ChannelReplySink) => {
      call += 1;
      if (call === 1) {
        await reply.emit({ type: "text-delta", delta: "x".repeat(8_000) });
      } else {
        await reply.emit({
          type: "approval",
          approval: {
            interactionId: "approval-1",
            callId: "call-1",
            toolId: "runtime__shell",
            displayName: "Shell",
            effects: ["execute"],
            summary: "Run a command.",
            requestedAt: "2026-07-23T12:00:00.000Z",
          },
        });
      }
      return { status: "completed" as const };
    });
    const { info } = await start(dispatch, { maxResponseBytes: 4_096 });

    const oversized = await post(info, chatBody(false));
    expect(oversized.status).toBe(502);
    expect(await errorCode(oversized)).toBe("response_too_large");

    const approval = await post(info, chatBody(false));
    expect(approval.status).toBe(502);
    expect(await errorCode(approval)).toBe("unsupported_reply_event");
  });
});

async function start(
  dispatch: (request: ChannelInboundRequest, reply: ChannelReplySink) => Promise<ChannelTurnResult>,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<{ readonly server: OpenAiApiServer; readonly info: OpenAiApiStartInfo }> {
  const server = createOpenAiApiServer({
    config: parseOpenAiApiConfig({ apiKey: KEY, modelId: "personal", ...overrides }),
    dispatch,
  });
  servers.add(server);
  return { server, info: await server.start() };
}

function chatBody(stream: boolean, includeUsage = false): unknown {
  return {
    model: "personal",
    conversation_id: "chat-1",
    stream,
    ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "describe" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==" } },
      ],
    }],
  };
}

function replaceImage(value: unknown, url: string): unknown {
  const input = structuredClone(value) as { messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }> };
  const image = input.messages[0]?.content.find((part) => part.type === "image_url");
  if (image?.image_url !== undefined) image.image_url.url = url;
  return input;
}

function post(info: OpenAiApiStartInfo, body: unknown, extra: Readonly<Record<string, string>> = {}): Promise<Response> {
  return fetch(info.chatCompletionsUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...extra },
    body: JSON.stringify(body),
  });
}

async function errorCode(response: Response): Promise<unknown> {
  const body = await response.json() as { error?: { code?: unknown } };
  return body.error?.code;
}

function deltaContent(stream: string): string {
  return [...stream.matchAll(/"content":"([^"]*)"/gu)].map((match) => match[1] ?? "").join("");
}

function deltaValues(stream: string): string[] {
  return stream
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: unknown } }> })
    .flatMap((value) => {
      const content = value.choices?.[0]?.delta?.content;
      return typeof content === "string" ? [content] : [];
    });
}

async function expectInvalidToolSequence(
  info: OpenAiApiStartInfo,
  stream: boolean,
  completedToolDetails: number,
): Promise<void> {
  const response = await post(info, chatBody(stream));
  if (!stream) {
    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe("invalid_tool_event");
    return;
  }
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
  expect(body).toContain('"code":"invalid_tool_event"');
  expect(deltaValues(body).filter((value) =>
    value.startsWith('<details type="tool_calls"'))).toHaveLength(completedToolDetails);
}

function authorityStatus(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/v1/models",
      headers: { host, authorization: `Bearer ${KEY}` },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

function disconnectAfterFirstChunk(info: OpenAiApiStartInfo): Promise<void> {
  const url = new URL(info.chatCompletionsUrl);
  const body = JSON.stringify(chatBody(true));
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = httpRequest({
      hostname: url.hostname,
      port: info.port,
      path: url.pathname,
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      response.once("data", () => {
        settled = true;
        response.destroy();
        resolve();
      });
      response.once("error", (error) => {
        if (!settled) reject(error);
      });
    });
    request.once("error", (error) => {
      if (!settled) reject(error);
    });
    request.end(body);
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function noopLogger(): {
  readonly debug: () => void;
  readonly info: () => void;
  readonly warn: () => void;
  readonly error: () => void;
} {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
