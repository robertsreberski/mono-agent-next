import { once } from "node:events";
import { createConnection, isIP } from "node:net";

import {
  AGENT_INTERACTION_LIMITS,
  isEnvEligibleSchema,
  isSecretSchema,
  parseAskUserAnswer,
  parseAskUserRequest,
  type AskUserAnswer,
  type ChannelHost,
  type ChannelInboundRequest,
  type ChannelReplySink,
  type ChannelTurnResult,
  type ModuleLogger,
} from "@mono-agent/module-sdk";
import {
  OPERATOR_LIMITS,
  OperatorClient,
  parseAskAnswerRequest,
  parseOperatorFrame,
  parseOperatorHealth,
  parseOperatorInfo,
  serializeOperatorFrame,
  type OperatorFrame,
} from "@mono-agent/operator";
import {
  assertChannelBehaviorCompliance,
  assertChannelInstanceCompliance,
  assertChannelModuleCompliance,
} from "@mono-agent/module-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MIN_OPERATOR_TOKEN_BYTES,
  createOperatorChannel,
  monoAgentModule,
  operatorChannelConfigSchema,
  parseOperatorChannelConfig,
  type OperatorChannel,
  type OperatorModuleChannel,
  type OperatorIdentityGrant,
} from "../index.js";

const TOKEN = "operator-fixture-token-that-is-long-enough";
const channels = new Set<OperatorChannel>();
const moduleChannels = new Set<OperatorModuleChannel>();

afterEach(async () => {
  await Promise.allSettled([
    ...[...channels].map((channel) => channel.stop()),
    ...[...moduleChannels].map((channel) => channel.stop?.({
      signal: new AbortController().signal,
      reason: "shutdown" as const,
    })),
  ]);
  channels.clear();
  moduleChannels.clear();
});

describe("operator channel config", () => {
  it("marks the nested token env-only and secret, and rejects weak or missing authentication", () => {
    const properties = operatorChannelConfigSchema.jsonSchema.properties as Record<string, unknown>;
    const auth = properties.auth as { properties: { token: Readonly<Record<string, unknown>> } };
    expect(isEnvEligibleSchema(auth.properties.token)).toBe(true);
    expect(isSecretSchema(auth.properties.token)).toBe(true);
    expect(auth.properties.token.minLength).toBe(MIN_OPERATOR_TOKEN_BYTES);

    expect(() => parseOperatorChannelConfig({})).toThrow(/auth/u);
    expect(() => parseOperatorChannelConfig({ auth: { token: "too-short" } })).toThrow(/32-4096 byte/u);
    expect(() => parseOperatorChannelConfig({
      auth: { token: { $env: "MONO_AGENT_OPERATOR_TOKEN" } },
    })).toThrow(/resolved bearer token/u);
    expect(parseOperatorChannelConfig({ auth: { token: TOKEN } })).toMatchObject({
      listen: { host: "127.0.0.1", port: 0 },
      auth: { token: TOKEN },
    });
  });

  it("has an exact shape and rejects every non-loopback bind", () => {
    expect(() => parseOperatorChannelConfig({
      auth: { token: TOKEN },
      listen: { host: "0.0.0.0", port: 4000 },
    })).toThrow(/loopback/u);
    expect(() => parseOperatorChannelConfig({
      auth: { token: TOKEN },
      allowNonLoopback: true,
    })).toThrow(/unknown field.*allowNonLoopback/u);
    expect(() => parseOperatorChannelConfig({
      auth: { token: TOKEN, fallback: "secret" },
    })).toThrow(/unknown field.*fallback/u);
    expect(parseOperatorChannelConfig({
      auth: { token: TOKEN },
      listen: { host: "::1", port: 0 },
    })).toMatchObject({ listen: { host: "::1" } });
    expect(() => parseOperatorChannelConfig({ auth: { token: TOKEN }, label: "wrong owner" })).toThrow(/unknown field.*label/u);
  });
});

describe("operator HTTP channel", () => {
  it("represents every canonical module-sdk AskUser field at its exact bound", async () => {
    expect(OPERATOR_LIMITS).toMatchObject({
      askQuestions: AGENT_INTERACTION_LIMITS.askQuestions,
      askChoicesPerQuestion: AGENT_INTERACTION_LIMITS.askChoicesPerQuestion,
      askPromptBytes: AGENT_INTERACTION_LIMITS.askPromptBytes,
      askChoiceValueBytes: AGENT_INTERACTION_LIMITS.askChoiceValueBytes,
      askChoiceLabelBytes: AGENT_INTERACTION_LIMITS.askChoiceLabelBytes,
      askChoiceDescriptionBytes: AGENT_INTERACTION_LIMITS.askChoiceDescriptionBytes,
      askAnswerValuesPerQuestion: AGENT_INTERACTION_LIMITS.askAnswerValuesPerQuestion,
      askAnswerBytes: AGENT_INTERACTION_LIMITS.askAnswerBytes,
    });
    const control = "\u0001";
    const ask = parseAskUserRequest({
      interactionId: "maximal-ask",
      requestedAt: "2026-01-02T03:04:06.500Z",
      questions: Array.from(
        { length: AGENT_INTERACTION_LIMITS.askQuestions },
        (_, questionIndex) => ({
          id: `question-${String(questionIndex)}`,
          prompt: control.repeat(AGENT_INTERACTION_LIMITS.askPromptBytes),
          choices: Array.from(
            { length: AGENT_INTERACTION_LIMITS.askChoicesPerQuestion },
            (_, choiceIndex) => {
              const prefix = `${String(questionIndex)}-${String(choiceIndex)}:`;
              return {
                value: prefix + control.repeat(
                  AGENT_INTERACTION_LIMITS.askChoiceValueBytes - prefix.length,
                ),
                label: control.repeat(AGENT_INTERACTION_LIMITS.askChoiceLabelBytes),
                description: control.repeat(AGENT_INTERACTION_LIMITS.askChoiceDescriptionBytes),
              };
            },
          ),
          allowFreeText: false,
          multiple: true,
        }),
      ),
    });
    const serialized = serializeOperatorFrame({
      type: "ask_user",
      turnId: "maximal-turn",
      ask,
    });
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(OPERATOR_LIMITS.frameBytes);
    expect(parseOperatorFrame(JSON.parse(serialized))).toEqual({
      type: "ask_user",
      turnId: "maximal-turn",
      ask,
    });

    const freeTextRequest = parseAskUserRequest({
      interactionId: "maximal-answer",
      requestedAt: "2026-01-02T03:04:06.500Z",
      questions: Array.from(
        { length: AGENT_INTERACTION_LIMITS.askQuestions },
        (_, questionIndex) => ({
          id: `free-${String(questionIndex)}`,
          prompt: "Provide values",
          allowFreeText: true,
          multiple: true,
        }),
      ),
    });
    const moduleAnswer = parseAskUserAnswer({
      interactionId: freeTextRequest.interactionId,
      answers: Object.fromEntries(freeTextRequest.questions.map((question, questionIndex) => [
        question.id,
        Array.from(
          { length: AGENT_INTERACTION_LIMITS.askAnswerValuesPerQuestion },
          (_, answerIndex) => {
            const prefix = `${String(questionIndex)}-${String(answerIndex)}:`;
            return prefix + control.repeat(AGENT_INTERACTION_LIMITS.askAnswerBytes - prefix.length);
          },
        ),
      ])),
      answeredAt: "2026-01-02T03:04:07.000Z",
    }, freeTextRequest);
    const operatorAnswer = parseAskAnswerRequest({
      interactionId: moduleAnswer.interactionId,
      answers: moduleAnswer.answers,
    });
    const answerBytes = Buffer.byteLength(JSON.stringify(operatorAnswer));
    expect(answerBytes).toBeGreaterThan(OPERATOR_LIMITS.requestBytes);
    expect(answerBytes).toBeLessThanOrEqual(OPERATOR_LIMITS.askAnswerRequestBytes);

    const answerAsk = vi.fn(async (_conversationId: string, answer: AskUserAnswer) => {
      expect(parseAskUserAnswer(answer, freeTextRequest).answers).toEqual(moduleAnswer.answers);
      return { status: "accepted" as const };
    });
    const channel = await startChannel(async (_request, reply) => {
      await reply.emit({ type: "ask-user", ask: freeTextRequest });
      return { status: "completed", text: "waiting" };
    }, { answerAsk });
    await readFrames(await postJson(channel.startInfo.turnsUrl, {
      conversationId: "maximal-answer",
      input: { text: "ask" },
    }));
    const client = new OperatorClient({ endpoint: channel.startInfo.endpoint, token: TOKEN });
    await expect(client.answerAsk("maximal-answer", operatorAnswer))
      .resolves.toEqual({ status: "accepted" });
    expect(answerAsk).toHaveBeenCalledOnce();
  });

  it("advertises the actual literal loopback address when configured with localhost", async () => {
    const channel = createOperatorChannel({
      config: parseOperatorChannelConfig({
        auth: { token: TOKEN },
        listen: { host: "localhost", port: 0 },
      }),
      identity: identity("localhost-operator", "Localhost Agent"),
      dispatch: async () => ({ status: "completed", text: "unused" }),
    });
    channels.add(channel);

    const startInfo = await channel.start();
    expect(startInfo.host).not.toBe("localhost");
    expect(isIP(startInfo.host)).toBeGreaterThan(0);
    expect(startInfo.host === "::1" || startInfo.host.split(".", 1)[0] === "127").toBe(true);
    expect(new URL(startInfo.endpoint).hostname).not.toBe("localhost");

    const client = new OperatorClient({ endpoint: startInfo.endpoint, token: TOKEN });
    await expect(client.getInfo()).resolves.toMatchObject({
      agent: { id: "localhost-operator", label: "Localhost Agent" },
    });
  });

  it("serves stable authenticated info and health from the shared protocol", async () => {
    const channel = await startChannel(async () => ({ status: "completed", text: "unused" }));
    const unauthorized = await fetch(channel.startInfo.infoUrl);
    expect(unauthorized.status).toBe(401);

    const first = parseOperatorInfo(await authorizedJson(channel.startInfo.infoUrl));
    const second = parseOperatorInfo(await authorizedJson(channel.startInfo.infoUrl));
    expect(first).toMatchObject({
      protocol: "mono-agent.operator.v2",
      agent: { id: "operator", label: "Fixture Agent" },
      capabilities: {
        attachments: true,
        cancellation: true,
        runtimeOverrides: true,
        health: true,
      },
    });
    expect(second.process.startedAt).toBe(first.process.startedAt);
    expect(channel.startInfo.startedAt).toBe(first.process.startedAt);
    expect(parseOperatorHealth(await authorizedJson(channel.startInfo.healthUrl))).toMatchObject({
      status: "healthy",
      details: [{ id: "channel-operator", status: "healthy" }],
    });
  });

  it("fails legacy v1 routes closed before dispatching or streaming v2 frames", async () => {
    const dispatch = vi.fn(async (_request: ChannelInboundRequest, reply: ChannelReplySink) => {
      await reply.emit({
        type: "tool-call",
        call: { id: "legacy-must-not-see", name: "Read", input: { path: "secret" } },
      });
      return { status: "completed", text: "must not run" } as const;
    });
    const channel = await startChannel(dispatch);
    const legacyInfo = await fetch(`${channel.startInfo.baseUrl}/v1/info`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(legacyInfo.status).toBe(404);

    const legacyTurn = await postJson(`${channel.startInfo.baseUrl}/v1/turns`, {
      conversationId: "legacy-client",
      input: { text: "do not negotiate v2" },
    });
    expect(legacyTurn.status).toBe(404);
    expect(legacyTurn.headers.get("content-type")).toContain("application/json");
    expect(await legacyTurn.text()).not.toContain("tool_call");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("streams only shared frames while preserving text, thought, structured activity, routing, and final text", async () => {
    let inbound: ChannelInboundRequest | undefined;
    const dispatch = vi.fn(async (request: ChannelInboundRequest, reply: ChannelReplySink) => {
      inbound = request;
      await reply.emit({ type: "text-delta", delta: "draft" });
      await reply.emit({ type: "thinking-delta", delta: "checking" });
      await reply.emit({ type: "text-replace", text: "answer" });
      await reply.emit({ type: "activity", text: "Checked the workspace" });
      await reply.emit({
        type: "tool-call",
        call: { id: "call-1", name: "Read", input: { path: "README.md" } },
      });
      await reply.emit({
        type: "tool-result",
        result: {
          callId: "call-1",
          content: [{ type: "text", text: "read complete" }],
        },
      });
      await reply.emit({
        type: "compaction",
        compaction: { compacted: true, tokensBefore: 30, tokensAfter: 20 },
      });
      return { status: "completed", text: "final answer" } as const;
    });
    const channel = await startChannel(dispatch);
    const response = await postJson(channel.startInfo.turnsUrl, {
      conversationId: "conversation-1",
      input: { text: "hello" },
      runtime: "pi",
      model: "openai:gpt-test",
      effort: "high",
      metadata: { source: "test", count: 2 },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const frames = await readFrames(response);
    const turnId = frames[0]?.type === "accepted" ? frames[0].turnId : undefined;
    expect(turnId).toEqual(expect.any(String));
    expect(frames).toEqual([
      {
        type: "accepted",
        turnId,
        conversationId: "conversation-1",
        startedAt: expect.any(String),
      },
      { type: "delta", turnId, target: "assistant", text: "draft", mode: "append" },
      { type: "delta", turnId, target: "thought", text: "checking", mode: "append" },
      { type: "delta", turnId, target: "assistant", text: "answer", mode: "replace" },
      { type: "activity", turnId, text: "Checked the workspace" },
      {
        type: "tool_call",
        turnId,
        call: {
          id: "call-1",
          name: "Read",
          input: { path: "README.md" },
          inputOmitted: false,
        },
      },
      {
        type: "tool_result",
        turnId,
        result: {
          callId: "call-1",
          content: [{ type: "text", text: "read complete" }],
          contentOmitted: false,
        },
      },
      {
        type: "compaction",
        turnId,
        compaction: { compacted: true, tokensBefore: 30, tokensAfter: 20 },
      },
      {
        type: "usage",
        turnId,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          compacted: true,
          sessionEvicted: false,
        },
      },
      {
        type: "completed",
        turnId,
        finalMessage: { role: "assistant", text: "final answer" },
        finishedAt: expect.any(String),
        stopReason: "completed",
      },
    ]);
    expect(inbound).toMatchObject({
      requestId: turnId,
      conversationId: "conversation-1",
      text: "hello",
      runtime: "pi",
      model: "openai:gpt-test",
      effort: "high",
      metadata: { source: "test", count: 2 },
      sender: { id: "operator", displayName: "Fixture Agent" },
      attachments: [],
    });
    expect(inbound?.signal).toBeInstanceOf(AbortSignal);
  });

  it("omits oversized structured tool payloads without losing correlation or the terminal result", async () => {
    const oversized = "x".repeat(OPERATOR_LIMITS.toolPayloadBytes);
    const channel = await startChannel(async (_request, reply) => {
      await reply.emit({
        type: "tool-call",
        call: { id: "large-call", name: "LargeTool", input: { oversized } },
      });
      await reply.emit({
        type: "tool-result",
        result: {
          callId: "large-call",
          content: [{ type: "text", text: oversized }],
        },
      });
      return { status: "completed", text: "still completed" };
    });
    const frames = await readFrames(await postJson(channel.startInfo.turnsUrl, {
      conversationId: "large-activity",
      input: { text: "run" },
    }));
    expect(frames).toContainEqual(expect.objectContaining({
      type: "tool_call",
      call: { id: "large-call", name: "LargeTool", inputOmitted: true },
    }));
    expect(frames).toContainEqual(expect.objectContaining({
      type: "tool_result",
      result: { callId: "large-call", contentOmitted: true },
    }));
    expect(frames.at(-1)).toMatchObject({
      type: "completed",
      finalMessage: { text: "still completed" },
    });
  });

  it("fails closed for malformed, unsupported, unauthorized, and cross-origin requests", async () => {
    const dispatch = vi.fn(async () => ({ status: "completed", text: "unexpected" }) as const);
    const channel = await startChannel(dispatch);
    const noAuth = await fetch(channel.startInfo.turnsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    });
    expect(noAuth.status).toBe(401);

    const simple = await fetch(channel.startInfo.turnsUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
      body: JSON.stringify({ conversationId: "c", input: { text: "hi" } }),
    });
    expect(simple.status).toBe(415);

    const crossOrigin = await fetch(channel.startInfo.turnsUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        origin: "https://attacker.invalid",
      },
      body: JSON.stringify({ conversationId: "c", input: { text: "hi" } }),
    });
    expect(crossOrigin.status).toBe(403);

    const malformed = await fetch(channel.startInfo.turnsUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ conversationId: "c", input: { text: "hi" }, surprise: true }),
    });
    expect(malformed.status).toBe(400);

    const attachment = await fetch(channel.startInfo.turnsUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        conversationId: "c",
        input: { attachments: [{ id: "a", name: "a.txt", mediaType: "text/plain" }] },
      }),
    });
    expect(attachment.status).toBe(422);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("accepts materially larger canonical inline attachments and rejects body oversize", async () => {
    let inbound: ChannelInboundRequest | undefined;
    const channel = await startChannel(async (request) => {
      inbound = request;
      return { status: "completed", text: "received" };
    });
    const data = Buffer.alloc(64 * 1024, 0x61);
    const accepted = await postJson(channel.startInfo.turnsUrl, {
      conversationId: "large-attachment",
      input: {
        attachments: [{
          id: "large",
          name: "large.bin",
          mediaType: "application/octet-stream",
          sizeBytes: data.byteLength,
          url: `data:application/octet-stream;base64,${data.toString("base64")}`,
        }],
      },
    });
    expect(accepted.status).toBe(200);
    expect((await readFrames(accepted)).at(-1)).toMatchObject({ type: "completed" });
    expect(inbound?.attachments).toEqual([expect.objectContaining({
      id: "large",
      name: "large.bin",
      sizeBytes: data.byteLength,
      data: new Uint8Array(data),
    })]);

    await expect(oversizedBodyStatus(channel.startInfo)).resolves.toBe(413);
  });

  it("resolves quotes from bounded replay and rejects foreign, missing, or mismatched references", async () => {
    const now = new Date().toISOString();
    const dispatch = vi.fn(async (
      _request: ChannelInboundRequest,
      _reply: ChannelReplySink,
    ): Promise<ChannelTurnResult> => ({ status: "completed", text: "quoted" }));
    const readReplay = vi.fn<NonNullable<ChannelHost["readReplay"]>>(async ({ conversationId }) => ({
      entries: conversationId === "quoted-conversation"
        ? [{
            turnId: "turn-1",
            createdAt: now,
            message: {
              id: "message-1",
              role: "assistant",
              content: [{ type: "text", text: "canonical quoted text" }],
            },
          }]
        : [],
    }));
    const channel = await startChannel(dispatch, { readReplay });
    await expect(authorizedJson(channel.startInfo.infoUrl)).resolves.toMatchObject({
      capabilities: { quotes: true, replay: true },
    });
    const accepted = await postJson(channel.startInfo.turnsUrl, {
      conversationId: "quoted-conversation",
      input: {
        text: "Respond to this.",
        quote: {
          conversationId: "quoted-conversation",
          messageId: "message-1",
          text: "canonical quoted text",
        },
      },
    });
    expect(accepted.status).toBe(200);
    await readFrames(accepted);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "quoted-conversation",
      metadata: {
        operatorQuote: {
          conversationId: "quoted-conversation",
          messageId: "message-1",
          role: "assistant",
        },
      },
    });
    expect(dispatch.mock.calls[0]?.[0].text).toContain("verified from conversation replay");
    expect(dispatch.mock.calls[0]?.[0].text).toContain(JSON.stringify({
      conversationId: "quoted-conversation",
      messageId: "message-1",
      role: "assistant",
      text: "canonical quoted text",
    }));
    expect(dispatch.mock.calls[0]?.[0].text).toContain("User message:\nRespond to this.");

    for (const quote of [
      { conversationId: "foreign", messageId: "message-1", text: "canonical quoted text" },
      { conversationId: "quoted-conversation", messageId: "missing", text: "canonical quoted text" },
      { conversationId: "quoted-conversation", messageId: "message-1", text: "tampered" },
    ]) {
      const rejected = await postJson(channel.startInfo.turnsUrl, {
        conversationId: "quoted-conversation",
        input: { text: "Do not run.", quote },
      });
      expect(rejected.status).toBe(422);
    }
    expect(dispatch).toHaveBeenCalledOnce();
    expect(readReplay).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "quoted-conversation",
      limit: 10_000,
    }));

    const unavailable = await startChannel(dispatch, {
      readReplay: async () => {
        throw new Error("secret storage path");
      },
    });
    const unavailableResponse = await postJson(unavailable.startInfo.turnsUrl, {
      conversationId: "quoted-conversation",
      input: {
        text: "Do not run.",
        quote: {
          conversationId: "quoted-conversation",
          messageId: "message-1",
        },
      },
    });
    expect(unavailableResponse.status).toBe(503);
    await expect(unavailableResponse.json()).resolves.toEqual({
      error: {
        code: "replay_unavailable",
        message: "Conversation replay is temporarily unavailable.",
      },
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("aborts the exact Core dispatch when the stream client disconnects", async () => {
    let observedSignal: AbortSignal | undefined;
    let resolveAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const channel = await startChannel(async (request) => {
      observedSignal = request.signal;
      await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => {
        resolveAbort?.();
        resolve();
      }, { once: true }));
      return { status: "cancelled" };
    });

    const response = await postJson(channel.startInfo.turnsUrl, {
      conversationId: "disconnect-me",
      input: { text: "wait" },
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    await reader?.cancel();

    await expect(Promise.race([
      aborted,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("abort not observed")), 2_000)),
    ])).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
  });

  it("supports authenticated explicit cancellation by conversation", async () => {
    const channel = await startChannel(async (request) => {
      await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "cancelled" };
    });
    const response = await postJson(channel.startInfo.turnsUrl, {
      conversationId: "cancel-me",
      input: { text: "wait" },
    });
    const cancel = await postJson(
      `${channel.startInfo.baseUrl}/v2/conversations/cancel-me/cancel`,
      { reason: "operator requested" },
    );
    expect(cancel.status).toBe(202);
    await expect(cancel.json()).resolves.toEqual({ status: "accepted" });
    const frames = await readFrames(response);
    expect(frames.at(-1)).toMatchObject({
      type: "error",
      error: { code: "cancelled" },
      cancelled: true,
    });

    const idle = await postJson(
      `${channel.startInfo.baseUrl}/v2/conversations/missing/cancel`,
      {},
    );
    expect(idle.status).toBe(200);
    await expect(idle.json()).resolves.toEqual({ status: "idle" });
  });

  it("projects Core-owned operator controls, AskUser state, replay, config, usage, and health", async () => {
    const now = new Date().toISOString();
    const answerAsk = vi.fn(async () => ({ status: "accepted" as const }));
    const offerLiveInput = vi.fn(async () => ({ status: "applied" as const }));
    const readReplay = vi.fn(async () => ({
      entries: [{
        turnId: "turn-1",
        createdAt: now,
        message: {
          id: "message-1",
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "remembered" }],
        },
      }],
    }));
    const host: NonNullable<Parameters<typeof createOperatorChannel>[0]["host"]> = {
      answerAsk,
      offerLiveInput,
      async listConversations() {
        return { conversations: [{ conversationId: "conversation-controls", title: "Controls", updatedAt: now }] };
      },
      readReplay,
      async readConfig() { return { runtime: "pi", token: "[redacted]" }; },
      async readHealth() { return { status: "unknown", checkedAt: now, summary: "Core is still starting." }; },
      async openConversation() { return { conversationId: "opened", createdAt: now }; },
    };
    const channel = await startChannel(async (_request, reply) => {
      await reply.emit({
        type: "ask-user",
        ask: {
          interactionId: "ask-1",
          requestedAt: now,
          questions: [{ id: "choice", prompt: "Choose", allowFreeText: false, multiple: false, choices: [{ value: "yes", label: "Yes" }] }],
        },
      });
      await reply.emit({
        type: "usage",
        usage: {
          inputTokens: 3,
          outputTokens: 5,
          contextWindow: 128_000,
          contextUsed: 8,
        },
      });
      await reply.emit({
        type: "compaction",
        compaction: {
          compacted: true,
          tokensBefore: 8,
          tokensAfter: 4,
        },
      });
      await reply.emit({
        type: "usage",
        usage: {
          inputTokens: 4,
          outputTokens: 6,
          contextUsed: 5,
        },
      });
      await reply.emit({ type: "session-evicted" });
      return { status: "completed", text: "done" };
    }, host);
    const client = new OperatorClient({ endpoint: channel.startInfo.endpoint, token: TOKEN });

    await expect(client.getInfo()).resolves.toMatchObject({
      capabilities: { liveInput: true, askUser: true, proactive: true, configView: true, replay: true },
    });
    await expect(client.getConversations()).resolves.toMatchObject({ conversations: [{ id: "conversation-controls", title: "Controls" }] });
    await expect(client.getReplay("conversation-controls")).resolves.toMatchObject({ conversationId: "conversation-controls", messages: [{ id: "message-1", text: "remembered" }] });
    expect(readReplay).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conversation-controls", limit: 10_000 }));
    await expect(client.getConfig()).resolves.toMatchObject({ value: { runtime: "pi", token: "[redacted]" }, redacted: true });
    await expect(client.getHealth()).resolves.toMatchObject({ status: "degraded", details: [{ id: "channel-operator" }, { id: "core", status: "degraded" }] });
    await expect(client.offerLiveInput("conversation-controls", { id: "live-1", text: "steer", receivedAt: now })).resolves.toEqual({ status: "applied" });
    expect(offerLiveInput).toHaveBeenCalledOnce();

    const frames = await readFrames(await postJson(channel.startInfo.turnsUrl, { conversationId: "conversation-controls", input: { text: "run" } }));
    expect(frames).toContainEqual(expect.objectContaining({ type: "ask_user", ask: expect.objectContaining({ interactionId: "ask-1" }) }));
    expect(frames).toContainEqual(expect.objectContaining({
      type: "compaction",
      compaction: { compacted: true, tokensBefore: 8, tokensAfter: 4 },
    }));
    const usageFrames = frames.filter((frame) => frame.type === "usage");
    expect(usageFrames).toHaveLength(4);
    expect(usageFrames.at(-1)).toEqual({
      type: "usage",
      turnId: expect.any(String),
      usage: {
        inputTokens: 4,
        outputTokens: 6,
        contextWindow: 128_000,
        contextUsed: 5,
        compacted: true,
        sessionEvicted: true,
      },
    });
    await expect(client.getPendingAsk("conversation-controls")).resolves.toMatchObject({ ask: { interactionId: "ask-1" } });
    await expect(client.answerAsk("conversation-controls", { interactionId: "ask-1", answers: { choice: ["yes"] } })).resolves.toEqual({ status: "accepted" });
    expect(answerAsk).toHaveBeenCalledOnce();
  });

  it("starts and stops idempotently and destroys open keep-alive sockets", async () => {
    const channel = await startChannel(async () => ({ status: "completed", text: "ok" }));
    const first = channel.startInfo;
    await expect(channel.channel.start()).resolves.toEqual(first);
    const socket = createConnection({ host: first.host, port: first.port });
    await once(socket, "connect");
    socket.on("error", () => undefined);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    await Promise.all([channel.channel.stop(), channel.channel.stop()]);

    await expect(closed).resolves.toBeUndefined();
    expect(socket.destroyed).toBe(true);
    expect(channel.channel.health()).toMatchObject({ status: "stopped", activeTurns: 0 });
  });
});

describe("mono-agent operator channel module", () => {
  it("declares and requires the exact Core-owned identity grant", () => {
    expect(monoAgentModule.manifest.capabilities).toEqual(["operator.identity.v1"]);
    const config = monoAgentModule.schema.parse({ auth: { token: TOKEN } });
    expect(() => monoAgentModule.create({
      instanceId: "operator",
      config,
      provenance: { "/auth/token": { source: "environment", environmentName: "OPERATOR_TOKEN" } },
      configDirectory: "/config",
      workspaceDirectory: "/workspace",
      dataDirectory: "/data",
      logger: noopLogger(),
      host: { grantedCapabilities: new Set(), getCapability() { return undefined; }, async dispatch() { return { status: "completed" }; } },
      signal: new AbortController().signal,
    })).toThrow(/operator\.identity\.v1/u);
  });

  it("is a compliant side-effect-free typed channel with a runnable endpoint", async () => {
    expect(() => assertChannelModuleCompliance(monoAgentModule, {
      expectedPackageName: "@mono-agent/channel-operator",
      expectedPackageVersion: "0.15.0",
    })).not.toThrow();
    const config = monoAgentModule.schema.parse({ auth: { token: TOKEN } });
    const operatorIdentity = identity("module-agent", "Module Agent");
    const dispatched: ChannelInboundRequest[] = [];
    const host: ChannelHost = {
      grantedCapabilities: new Set(["operator.identity.v1"]),
      getCapability<T>(name: string): T | undefined {
        return (name === "operator.identity.v1" ? operatorIdentity : undefined) as T | undefined;
      },
      async dispatch(request, reply): Promise<ChannelTurnResult> {
        dispatched.push(request);
        await reply.emit({ type: "text-delta", delta: "module reply" });
        return { status: "completed" };
      },
      async readReplay() { return { entries: [] }; },
    };
    const lifecycle = new AbortController();
    const channel = await monoAgentModule.create({
      instanceId: "operator",
      config,
      provenance: { "/auth/token": { source: "environment", environmentName: "OPERATOR_TOKEN" } },
      configDirectory: "/config",
      workspaceDirectory: "/workspace",
      dataDirectory: "/data",
      logger: noopLogger(),
      host,
      signal: lifecycle.signal,
    });
    moduleChannels.add(channel);
    expect(() => assertChannelInstanceCompliance(channel)).not.toThrow();
    expect(channel.capabilities.approvals).toBe(false);
    expect(channel.endpoint).toBeUndefined();

    await channel.start?.({ signal: lifecycle.signal });
    expect(channel.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(channel.readHostPresence?.()).toMatchObject({
      operatorRegistry: {
        schema: "mono-agent.operator-registry-details.v2",
        agent: operatorIdentity.agent,
        operator: { endpoint: channel.endpoint, tokenEnvironment: "OPERATOR_TOKEN" },
        process: { pid: process.pid, startedAt: channel.startInfo?.startedAt },
        capabilities: { attachments: true, cancellation: true, health: true, quotes: true },
      },
    });
    const response = await postJson(`${channel.endpoint}/v2/turns`, {
      conversationId: "module-conversation",
      input: { text: "hello module" },
    });
    expect((await readFrames(response)).at(-1)).toMatchObject({
      type: "completed",
      finalMessage: { text: "module reply" },
    });
    expect(dispatched).toHaveLength(1);
    expect(await channel.health?.({ signal: lifecycle.signal })).toMatchObject({
      status: "healthy",
      details: { activeTurns: 0, endpoint: channel.endpoint },
    });
    await channel.drain?.({ signal: lifecycle.signal });
    await channel.stop?.({ signal: lifecycle.signal, reason: "shutdown" });
  });

  it("passes the reusable channel behavior compliance contract", async () => {
    const operatorIdentity = identity("compliance-agent", "Compliance Agent");
    const openConversation = vi.fn<NonNullable<ChannelHost["openConversation"]>>(
      async (request) => {
        if (request.metadata?.idempotencyKey === "operator-compliance-unknown") {
          throw new Error("secret operator storage failure /private/token");
        }
        return {
          conversationId: "opened-compliance",
          createdAt: new Date().toISOString(),
        };
      },
    );
    await assertChannelBehaviorCompliance({
      async create(signal) {
        const channel = await monoAgentModule.create({
          instanceId: "operator-compliance",
          config: monoAgentModule.schema.parse({ auth: { token: TOKEN } }),
          provenance: {
            "/auth/token": {
              source: "environment",
              environmentName: "OPERATOR_TOKEN",
            },
          },
          configDirectory: "/config",
          workspaceDirectory: "/workspace",
          dataDirectory: "/data",
          logger: noopLogger(),
          host: {
            grantedCapabilities: new Set(["operator.identity.v1"]),
            getCapability<T>(name: string): T | undefined {
              return (name === "operator.identity.v1"
                ? operatorIdentity
                : undefined) as T | undefined;
            },
            async dispatch() { return { status: "completed" }; },
            openConversation,
          },
          signal,
        });
        moduleChannels.add(channel);
        return channel;
      },
      delivery: {
        delivered: {
          conversationId: "trigger:cron:compliance",
          text: "compliance",
          idempotencyKey: "operator-compliance",
        },
        conflicting: {
          conversationId: "trigger:cron:compliance",
          text: "conflicting compliance",
          idempotencyKey: "operator-compliance",
        },
        unknown: {
          conversationId: "trigger:cron:compliance",
          text: "ambiguous compliance",
          idempotencyKey: "operator-compliance-unknown",
        },
      },
      secrets: [TOKEN, "secret operator"],
      exercise(instance) {
        expect(instance.capabilities.proactive).toBe(true);
      },
    });
    expect(openConversation).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent proactive opens and reports later duplicates", async () => {
    const config = monoAgentModule.schema.parse({ auth: { token: TOKEN } });
    const operatorIdentity = identity("module-agent", "Module Agent");
    const openConversation = vi.fn<NonNullable<ChannelHost["openConversation"]>>(async () => ({ conversationId: "opened-1", createdAt: new Date().toISOString() }));
    const host: ChannelHost = {
      grantedCapabilities: new Set(["operator.identity.v1"]),
      getCapability<T>(name: string): T | undefined { return (name === "operator.identity.v1" ? operatorIdentity : undefined) as T | undefined; },
      async dispatch() { return { status: "completed" }; },
      openConversation,
    };
    const channel = await monoAgentModule.create({ instanceId: "operator", config, provenance: {}, configDirectory: "/config", workspaceDirectory: "/workspace", dataDirectory: "/data", logger: noopLogger(), host, signal: new AbortController().signal });
    moduleChannels.add(channel);
    const defaultConversationId = channel.resolveDefaultDeliveryConversationId?.();
    expect(defaultConversationId).toBe("operator:new-conversation");
    const message = {
      conversationId: defaultConversationId!,
      text: "proactive",
      idempotencyKey: "open-once",
    };
    await expect(Promise.all([channel.deliver!(message, new AbortController().signal), channel.deliver!(message, new AbortController().signal)])).resolves.toEqual([
      { status: "delivered", idempotencyKey: "open-once", messageId: "opened-1" },
      { status: "delivered", idempotencyKey: "open-once", messageId: "opened-1" },
    ]);
    await expect(channel.deliver!(message, new AbortController().signal)).resolves.toEqual({ status: "duplicate", idempotencyKey: "open-once", messageId: "opened-1" });
    expect(channel.resolveDeliveryHistory?.(
      message,
      { status: "delivered", idempotencyKey: "open-once", messageId: "opened-1" },
    )).toEqual({ conversationId: "opened-1" });
    await expect(channel.deliver!({
      ...message,
      text: "conflicting payload",
    }, new AbortController().signal)).resolves.toMatchObject({
      status: "failed",
      diagnostic: { code: "operator_proactive_idempotency_conflict" },
    });
    expect(openConversation).toHaveBeenCalledOnce();
    expect(openConversation.mock.calls[0]?.[0]).not.toHaveProperty("initialText");
  });

  it("fingerprints Unicode metadata keys in deterministic UTF-8 byte order", async () => {
    const config = monoAgentModule.schema.parse({ auth: { token: TOKEN } });
    const operatorIdentity = identity("module-agent", "Module Agent");
    const openConversation =
      vi.fn<NonNullable<ChannelHost["openConversation"]>>(async () => ({
        conversationId: "opened-unicode",
        createdAt: new Date().toISOString(),
      }));
    const channel = await monoAgentModule.create({
      instanceId: "operator",
      config,
      provenance: {},
      configDirectory: "/config",
      workspaceDirectory: "/workspace",
      dataDirectory: "/data",
      logger: noopLogger(),
      host: {
        grantedCapabilities: new Set(["operator.identity.v1"]),
        getCapability<T>(name: string): T | undefined {
          return (name === "operator.identity.v1"
            ? operatorIdentity
            : undefined) as T | undefined;
        },
        async dispatch() { return { status: "completed" }; },
        openConversation,
      },
      signal: new AbortController().signal,
    });
    moduleChannels.add(channel);
    const message = {
      conversationId: "",
      text: "unicode metadata",
      idempotencyKey: "unicode-metadata",
    };
    const metadata = Object.fromEntries([
      ["é", "precomposed"],
      ["e\u0301", "decomposed"],
    ]);
    await expect(channel.deliver!({
      ...message,
      metadata,
    }, new AbortController().signal)).resolves.toMatchObject({ status: "delivered" });
    await expect(channel.deliver!({
      ...message,
      metadata: Object.fromEntries(Object.entries(metadata).reverse()),
    }, new AbortController().signal)).resolves.toMatchObject({ status: "duplicate" });
    expect(openConversation).toHaveBeenCalledOnce();
  });

  it("bounds proactive metadata before fingerprinting and allows a valid retry", async () => {
    const config = monoAgentModule.schema.parse({ auth: { token: TOKEN } });
    const operatorIdentity = identity("module-agent", "Module Agent");
    const openConversation =
      vi.fn<NonNullable<ChannelHost["openConversation"]>>(async () => ({
        conversationId: "opened-valid",
        createdAt: new Date().toISOString(),
      }));
    const channel = await monoAgentModule.create({
      instanceId: "operator",
      config,
      provenance: {},
      configDirectory: "/config",
      workspaceDirectory: "/workspace",
      dataDirectory: "/data",
      logger: noopLogger(),
      host: {
        grantedCapabilities: new Set(["operator.identity.v1"]),
        getCapability<T>(name: string): T | undefined {
          return (name === "operator.identity.v1"
            ? operatorIdentity
            : undefined) as T | undefined;
        },
        async dispatch() { return { status: "completed" }; },
        openConversation,
      },
      signal: new AbortController().signal,
    });
    moduleChannels.add(channel);
    await expect(channel.deliver!({
      conversationId: "",
      text: "oversized",
      idempotencyKey: "retry-after-invalid",
      metadata: { detail: "x".repeat(65_537) },
    }, new AbortController().signal)).resolves.toMatchObject({
      status: "failed",
      diagnostic: { code: "operator_proactive_invalid" },
    });
    await expect(channel.deliver!({
      conversationId: "",
      text: "valid",
      idempotencyKey: "retry-after-invalid",
    }, new AbortController().signal)).resolves.toMatchObject({
      status: "delivered",
    });
    expect(openConversation).toHaveBeenCalledOnce();
  });

  it("fails closed at proactive receipt capacity without evicting authority", async () => {
    const config = monoAgentModule.schema.parse({ auth: { token: TOKEN } });
    const operatorIdentity = identity("module-agent", "Module Agent");
    const openConversation =
      vi.fn<NonNullable<ChannelHost["openConversation"]>>(async (request) => ({
        conversationId: `opened-${request.initialText}`,
        createdAt: new Date().toISOString(),
      }));
    const channel = await monoAgentModule.create({
      instanceId: "operator",
      config,
      provenance: {},
      configDirectory: "/config",
      workspaceDirectory: "/workspace",
      dataDirectory: "/data",
      logger: noopLogger(),
      host: {
        grantedCapabilities: new Set(["operator.identity.v1"]),
        getCapability<T>(name: string): T | undefined {
          return (name === "operator.identity.v1"
            ? operatorIdentity
            : undefined) as T | undefined;
        },
        async dispatch() { return { status: "completed" }; },
        openConversation,
      },
      signal: new AbortController().signal,
    });
    moduleChannels.add(channel);
    const signal = new AbortController().signal;
    for (let index = 0; index < 1_000; index += 1) {
      await channel.deliver!({
        conversationId: "",
        text: `notice-${String(index)}`,
        idempotencyKey: `key-${String(index)}`,
      }, signal);
    }
    await expect(channel.health?.({ signal })).resolves.toMatchObject({
      status: "degraded",
      details: { deliveryReceiptCapacityExhausted: true },
    });
    await expect(channel.deliver!({
      conversationId: "",
      text: "one too many",
      idempotencyKey: "capacity",
    }, signal)).resolves.toMatchObject({
      status: "failed",
      diagnostic: { code: "operator_proactive_receipt_capacity" },
    });
    await expect(channel.health?.({ signal })).resolves.toMatchObject({
      status: "degraded",
      details: { deliveryReceiptCapacityExhausted: true },
    });
    await expect(channel.deliver!({
      conversationId: "",
      text: "notice-0",
      idempotencyKey: "key-0",
    }, signal)).resolves.toMatchObject({ status: "duplicate" });
    expect(openConversation).toHaveBeenCalledTimes(1_000);
  });

  it("keeps an ambiguous proactive open unknown without replaying or leaking its cause", async () => {
    const config = monoAgentModule.schema.parse({ auth: { token: TOKEN } });
    const operatorIdentity = identity("module-agent", "Module Agent");
    const openConversation = vi.fn<NonNullable<ChannelHost["openConversation"]>>(
      async (request) => {
        if (request.metadata?.idempotencyKey === "ambiguous-open") {
          throw new Error("secret storage detail /private/operator-token");
        }
        return {
          conversationId: "opened-after-unknown",
          createdAt: new Date().toISOString(),
        };
      },
    );
    const host: ChannelHost = {
      grantedCapabilities: new Set(["operator.identity.v1"]),
      getCapability<T>(name: string): T | undefined {
        return (name === "operator.identity.v1"
          ? operatorIdentity
          : undefined) as T | undefined;
      },
      async dispatch() { return { status: "completed" }; },
      openConversation,
    };
    const channel = await monoAgentModule.create({
      instanceId: "operator",
      config,
      provenance: {},
      configDirectory: "/config",
      workspaceDirectory: "/workspace",
      dataDirectory: "/data",
      logger: noopLogger(),
      host,
      signal: new AbortController().signal,
    });
    moduleChannels.add(channel);
    const message = {
      conversationId: "trigger:cron:one",
      text: "proactive",
      idempotencyKey: "ambiguous-open",
    };
    const first = await channel.deliver!(message, new AbortController().signal);
    const second = await channel.deliver!(message, new AbortController().signal);
    expect(first).toEqual(second);
    expect(first).toEqual({
      status: "unknown",
      idempotencyKey: "ambiguous-open",
      diagnostic: {
        code: "operator_proactive_unknown",
        severity: "error",
        message: "Operator proactive delivery outcome is unknown.",
      },
    });
    expect(JSON.stringify(first)).not.toContain("secret storage");
    await expect(channel.health?.({
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      status: "degraded",
      summary: "An operator proactive delivery outcome is unknown.",
      details: { deliveryOutcomeAmbiguous: true },
    });
    await expect(channel.deliver!({
      ...message,
      text: "definitive success",
      idempotencyKey: "after-unknown",
    }, new AbortController().signal)).resolves.toMatchObject({ status: "delivered" });
    await expect(channel.health?.({
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      status: "degraded",
      details: { deliveryOutcomeAmbiguous: true },
    });
    expect(openConversation).toHaveBeenCalledTimes(2);
  });
});

async function startChannel(
  dispatch: (
    request: ChannelInboundRequest,
    reply: ChannelReplySink,
  ) => Promise<ChannelTurnResult>,
  host?: NonNullable<Parameters<typeof createOperatorChannel>[0]["host"]>,
): Promise<{ readonly channel: OperatorChannel; readonly startInfo: NonNullable<OperatorChannel["startInfo"]> }> {
  const channel = createOperatorChannel({
    config: parseOperatorChannelConfig({ auth: { token: TOKEN } }),
    identity: identity("operator", "Fixture Agent"),
    dispatch,
    ...(host === undefined ? {} : { host }),
  });
  channels.add(channel);
  const startInfo = await channel.start();
  return { channel, startInfo };
}

function identity(id: string, label: string): OperatorIdentityGrant {
  return {
    agent: { id, label },
    process: { pid: process.pid },
    defaults: { runtime: "pi", model: "openai:test", effort: "medium" },
    configPath: "/config/mono-agent.config.json",
    projectRoot: "/project",
  };
}

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
}

async function authorizedJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(response.status).toBe(200);
  return response.json() as Promise<unknown>;
}

async function oversizedBodyStatus(
  info: NonNullable<OperatorChannel["startInfo"]>,
): Promise<number> {
  const endpoint = new URL(info.endpoint);
  return new Promise<number>((resolve, reject) => {
    const socket = createConnection({ host: info.host, port: info.port });
    let response = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      response += chunk;
      const match = /^HTTP\/1\.1 (\d{3})/u.exec(response);
      if (match !== null) {
        resolve(Number(match[1]));
        socket.destroy();
      }
    });
    socket.once("connect", () => {
      socket.write([
        "POST /v2/turns HTTP/1.1",
        `Host: ${endpoint.host}`,
        `Authorization: Bearer ${TOKEN}`,
        "Content-Type: application/json",
        `Content-Length: ${String(OPERATOR_LIMITS.requestBytes + 1)}`,
        "Connection: close",
        "",
        "{}",
      ].join("\r\n"));
    });
  });
}

async function readFrames(response: Response): Promise<OperatorFrame[]> {
  return (await response.text())
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => parseOperatorFrame(JSON.parse(line) as unknown));
}

function noopLogger(): ModuleLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}
