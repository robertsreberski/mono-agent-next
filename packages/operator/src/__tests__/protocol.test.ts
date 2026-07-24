import { describe, expect, it } from "vitest";

import {
  OPERATOR_LIMITS,
  OPERATOR_PROTOCOL,
  OPERATOR_REGISTRY_DETAILS_SCHEMA,
  OPERATOR_REGISTRY_SCHEMA,
  OPERATOR_ROUTES,
  OperatorProtocolError,
  parseAskAnswerRequest,
  parseConversationList,
  parseOperatorFrame,
  parseOperatorInfo,
  parseTurnRequest,
  serializeOperatorFrame,
} from "../index.js";
import { MALFORMED_OPERATOR_FRAMES, VALID_OPERATOR_INFO, VALID_TURN_FRAMES, VALID_TURN_REQUEST } from "../testing.js";

describe("operator protocol", () => {
  it("uses an explicit v3 identity, discovery boundary, and route namespace", () => {
    expect(OPERATOR_PROTOCOL).toBe("mono-agent.operator.v3");
    expect(OPERATOR_REGISTRY_SCHEMA).toBe("mono-agent.operator-registry.v3");
    expect(OPERATOR_REGISTRY_DETAILS_SCHEMA).toBe("mono-agent.operator-registry-details.v3");
    expect([
      OPERATOR_ROUTES.info,
      OPERATOR_ROUTES.turns,
      OPERATOR_ROUTES.config,
      OPERATOR_ROUTES.health,
      OPERATOR_ROUTES.conversations,
    ].every((route) => route.startsWith("/v3/"))).toBe(true);
    expect(OPERATOR_ROUTES.ask("conversation")).toBe("/v3/conversations/conversation/ask");
    expect(OPERATOR_ROUTES.cancel("conversation")).toBe("/v3/conversations/conversation/cancel");
    expect(OPERATOR_ROUTES.liveInput("conversation")).toBe("/v3/conversations/conversation/live-input");
    expect(OPERATOR_ROUTES.replay("conversation")).toBe("/v3/conversations/conversation/replay");
    expect(() => parseOperatorInfo({
      ...VALID_OPERATOR_INFO,
      protocol: "mono-agent.operator.v1",
    })).toThrow("must equal mono-agent.operator.v3");
  });

  it("round-trips the golden info, request, and frames", () => {
    expect(parseOperatorInfo(VALID_OPERATOR_INFO)).toEqual(VALID_OPERATOR_INFO);
    expect(parseTurnRequest(VALID_TURN_REQUEST)).toEqual(VALID_TURN_REQUEST);
    for (const frame of VALID_TURN_FRAMES) {
      expect(parseOperatorFrame(JSON.parse(serializeOperatorFrame(frame)))).toEqual(frame);
    }
  });

  it("requires unique atomic runtime/model routes with exact effort metadata", () => {
    expect(() => parseOperatorInfo({
      ...VALID_OPERATOR_INFO,
      models: [{ id: "fixture:model" }],
    })).toThrow(/models\[0\]\.runtime/u);
    expect(() => parseOperatorInfo({
      ...VALID_OPERATOR_INFO,
      models: [
        ...VALID_OPERATOR_INFO.models!,
        ...VALID_OPERATOR_INFO.models!,
      ],
    })).toThrow(/unique runtime\/model routes/u);
    expect(parseOperatorInfo({
      ...VALID_OPERATOR_INFO,
      models: [
        ...VALID_OPERATOR_INFO.models!,
        {
          ...VALID_OPERATOR_INFO.models![0],
          runtime: "other-runtime",
        },
      ],
    }).models).toHaveLength(2);
    expect(() => parseOperatorInfo({
      ...VALID_OPERATOR_INFO,
      models: [{
        ...VALID_OPERATOR_INFO.models![0],
        efforts: ["high", "high"],
      }],
    })).toThrow(/efforts.*unique/u);
    expect(() => parseOperatorInfo({
      ...VALID_OPERATOR_INFO,
      defaults: { runtime: "other-runtime", model: "fixture:model" },
    })).toThrow(/defaults.*advertised runtime\/model route/u);
    expect(() => parseOperatorInfo({
      ...VALID_OPERATOR_INFO,
      defaults: { ...VALID_OPERATOR_INFO.defaults, effort: "extreme" },
    })).toThrow(/defaults\.effort.*advertised by the default runtime\/model route/u);
    expect(parseOperatorInfo({
      ...VALID_OPERATOR_INFO,
      defaults: { ...VALID_OPERATOR_INFO.defaults, effort: "provider-default" },
      models: VALID_OPERATOR_INFO.models!.map(({ efforts: _efforts, ...entry }) => entry),
    }).defaults?.effort).toBe("provider-default");
  });

  it("accepts bounded opaque message identities without widening other identifiers", () => {
    const messageId = `message~u16:${"a".repeat(1_350)}`;
    expect(parseOperatorFrame({
      type: "completed",
      turnId: "fixture-turn",
      finalMessage: { id: messageId, role: "assistant", text: "done" },
      finishedAt: "2026-01-02T03:04:06.500Z",
      stopReason: "completed",
    })).toMatchObject({ finalMessage: { id: messageId } });
    expect(parseTurnRequest({
      conversationId: "conversation",
      input: {
        text: "quote",
        quote: { conversationId: "conversation", messageId },
      },
    })).toMatchObject({ input: { quote: { messageId } } });
    expect(() => parseOperatorFrame({
      type: "completed",
      turnId: "fixture-turn",
      finalMessage: { id: "a".repeat(257), role: "assistant", text: "done" },
      finishedAt: "2026-01-02T03:04:06.500Z",
      stopReason: "completed",
    })).toThrow("contains unsupported characters");
    expect(() => parseOperatorFrame({
      type: "completed",
      turnId: "fixture-turn",
      finalMessage: {
        id: `message~u16:${"a".repeat(OPERATOR_LIMITS.messageIdentifierCharacters)}`,
        role: "assistant",
        text: "done",
      },
      finishedAt: "2026-01-02T03:04:06.500Z",
      stopReason: "completed",
    })).toThrow(`at most ${String(OPERATOR_LIMITS.messageIdentifierCharacters)} characters`);
  });

  it("preserves only explicit whitelisted trigger provenance in conversation summaries", () => {
    const updatedAt = "2026-07-24T00:00:00.000Z";
    expect(parseConversationList({
      conversations: [
        { id: "proactive:opaque", updatedAt, triggerKind: "cron" },
        { id: "trigger:cron:name-is-not-provenance", updatedAt },
      ],
    })).toEqual({
      conversations: [
        { id: "proactive:opaque", updatedAt, triggerKind: "cron" },
        { id: "trigger:cron:name-is-not-provenance", updatedAt },
      ],
    });
    expect(() => parseConversationList({
      conversations: [{ id: "proactive:opaque", updatedAt, triggerKind: "email" }],
    })).toThrow("triggerKind");
  });

  it("rejects malformed and unknown frames", () => {
    for (const frame of MALFORMED_OPERATOR_FRAMES) {
      expect(() => parseOperatorFrame(frame)).toThrow(OperatorProtocolError);
    }
  });

  it("rejects class instances and unsafe metadata keys", () => {
    class Impostor {
      protocol = VALID_OPERATOR_INFO.protocol;
    }
    expect(() => parseOperatorInfo(new Impostor())).toThrow("plain object");
    expect(() => parseTurnRequest({
      ...VALID_TURN_REQUEST,
      metadata: JSON.parse('{"__proto__":{"polluted":true}}'),
    })).toThrow("unsafe key");
    expect(() => parseTurnRequest({
      ...VALID_TURN_REQUEST,
      metadata: { values: Array.from({ length: OPERATOR_LIMITS.jsonItems }, () => null) },
    })).toThrow("item JSON boundary");
  });

  it("requires text or an attachment and rejects unknown request fields", () => {
    expect(() => parseTurnRequest({ conversationId: "c", input: {} })).toThrow("non-empty text");
    expect(() => parseTurnRequest({ ...VALID_TURN_REQUEST, surprise: true })).toThrow("unknown field");
  });

  it("allows inline attachment URLs up to the shared request budget", () => {
    const materiallyLargerUrl = `data:application/octet-stream;base64,${"A".repeat(128 * 1024)}`;
    expect(parseTurnRequest({
      conversationId: "c",
      input: {
        attachments: [{
          id: "large",
          name: "large.bin",
          mediaType: "application/octet-stream",
          url: materiallyLargerUrl,
        }],
      },
    })).toMatchObject({
      input: { attachments: [{ url: materiallyLargerUrl }] },
    });
    expect(() => parseTurnRequest({
      conversationId: "c",
      input: {
        attachments: [{
          id: "too-large",
          name: "too-large.bin",
          mediaType: "application/octet-stream",
          url: "x".repeat(OPERATOR_LIMITS.attachmentUrlCharacters + 1),
        }],
      },
    })).toThrow(`at most ${String(OPERATOR_LIMITS.attachmentUrlCharacters)} characters`);
  });

  it("bounds serialized frames by UTF-8 bytes", () => {
    expect(() => serializeOperatorFrame({
      type: "delta",
      turnId: "fixture-turn",
      target: "assistant",
      text: "x".repeat(OPERATOR_LIMITS.frameBytes),
    })).toThrow("limit");
  });

  it("bounds structured tool payloads and requires explicit omission markers", () => {
    expect(parseOperatorFrame({
      type: "tool_call",
      turnId: "fixture-turn",
      call: { id: "call", name: "Read", inputOmitted: true },
    })).toMatchObject({
      type: "tool_call",
      call: { id: "call", name: "Read", inputOmitted: true },
    });
    expect(() => parseOperatorFrame({
      type: "tool_call",
      turnId: "fixture-turn",
      call: { id: "call", name: "Read", inputOmitted: false },
    })).toThrow("must include input");
    expect(() => parseOperatorFrame({
      type: "tool_result",
      turnId: "fixture-turn",
      result: {
        callId: "call",
        content: [{ type: "text", text: "🧪".repeat(OPERATOR_LIMITS.toolPayloadBytes / 4) }],
        contentOmitted: false,
      },
    })).toThrow(`${String(OPERATOR_LIMITS.toolPayloadBytes)} UTF-8 bytes`);
  });

  it("enforces the canonical AskUser shape and UTF-8 bounds", () => {
    const valid = {
      type: "ask_user",
      turnId: "fixture-turn",
      ask: {
        interactionId: "ask",
        requestedAt: "2026-01-02T03:04:06.500Z",
        questions: [{
          id: "constructor",
          prompt: "Choose",
          choices: [{
            value: "🧪".repeat(OPERATOR_LIMITS.askChoiceValueBytes / 4),
            label: "Bounded value",
          }],
          allowFreeText: false,
          multiple: false,
        }],
      },
    } as const;
    expect(parseOperatorFrame(valid)).toEqual(valid);
    expect(() => parseOperatorFrame({
      ...valid,
      ask: {
        ...valid.ask,
        questions: [valid.ask.questions[0], valid.ask.questions[0]],
      },
    })).toThrow("must be unique");
    expect(() => parseOperatorFrame({
      ...valid,
      ask: {
        ...valid.ask,
        questions: [{
          ...valid.ask.questions[0],
          choices: [],
        }],
      },
    })).toThrow("must contain a choice");
    expect(() => parseOperatorFrame({
      ...valid,
      ask: {
        ...valid.ask,
        questions: [{
          ...valid.ask.questions[0],
          choices: [{
            ...valid.ask.questions[0].choices[0],
            value: `${valid.ask.questions[0].choices[0].value}a`,
          }],
        }],
      },
    })).toThrow(`${String(OPERATOR_LIMITS.askChoiceValueBytes)} UTF-8 bytes`);
    expect(parseAskAnswerRequest({
      interactionId: "ask",
      answers: { constructor: ["one"] },
    })).toEqual({
      interactionId: "ask",
      answers: { constructor: ["one"] },
    });
    expect(() => parseAskAnswerRequest({
      interactionId: "ask",
      answers: { constructor: ["one", "one"] },
    })).toThrow("unique answers");
  });
});
