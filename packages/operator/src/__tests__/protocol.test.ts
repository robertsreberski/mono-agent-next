import { describe, expect, it } from "vitest";

import {
  OPERATOR_LIMITS,
  OperatorProtocolError,
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

  it("bounds serialized frames by UTF-8 bytes", () => {
    expect(() => serializeOperatorFrame({
      type: "delta",
      turnId: "fixture-turn",
      target: "assistant",
      text: "x".repeat(OPERATOR_LIMITS.frameBytes),
    })).toThrow("limit");
  });
});
