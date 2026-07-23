import { describe, expect, it } from "vitest";

import {
  OPERATOR_LIMITS,
  OperatorProtocolError,
  parseAskAnswerRequest,
  parseOperatorFrame,
  parseOperatorInfo,
  parseTurnRequest,
  serializeOperatorFrame,
} from "../index.js";
import { MALFORMED_OPERATOR_FRAMES, VALID_OPERATOR_INFO, VALID_TURN_FRAMES, VALID_TURN_REQUEST } from "../testing.js";

describe("operator protocol", () => {
  it("round-trips the golden info, request, and frames", () => {
    expect(parseOperatorInfo(VALID_OPERATOR_INFO)).toEqual(VALID_OPERATOR_INFO);
    expect(parseTurnRequest(VALID_TURN_REQUEST)).toEqual(VALID_TURN_REQUEST);
    for (const frame of VALID_TURN_FRAMES) {
      expect(parseOperatorFrame(JSON.parse(serializeOperatorFrame(frame)))).toEqual(frame);
    }
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
