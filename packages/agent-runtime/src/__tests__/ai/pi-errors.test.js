import { describe, expect, it } from "vitest";

import { isContextLimitError, normalizePiErrorMessage, parseContextLimitFromError } from "../../ai/providers/pi-errors.js";

describe("isContextLimitError", () => {
  const contextLimitMessages = [
    // Previously-matched phrasings (must keep matching).
    "context_length_exceeded",
    "context length exceeded",
    "This model's maximum context length is 128000 tokens",
    "exceeds the context window",
    "too many tokens",
    "token limit exceeded",
    "prompt is too long",
    // Newly-covered phrasings.
    "context window exceeded",
    "context budget exhausted",
    "prompt too long",
    "the request exceeds max context",
    "input tokens exceed the limit",
    "input exceeds the allowed size",
    "tokens exceed the model limit",
    "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.",
  ];

  for (const message of contextLimitMessages) {
    it(`classifies as context-limit: "${message}"`, () => {
      expect(isContextLimitError(message)).toBe(true);
    });
  }

  const nonContextLimitMessages = [
    "",
    "rate limit exceeded",
    "Rate limit reached for requests",
    "too many requests, slow down",
    "internal server error",
    "invalid api key",
    "network timeout",
    "max tokens reached",
    "max_tokens exceeded",
    "maximum tokens for this model",
    "maximum output tokens for this model",
    "output tokens exceed the cap",
  ];

  for (const message of nonContextLimitMessages) {
    it(`does not classify as context-limit: "${message}"`, () => {
      expect(isContextLimitError(message)).toBe(false);
    });
  }

  it("lets rate-limit wording win even when token wording is also present", () => {
    expect(isContextLimitError("rate limit: too many tokens")).toBe(false);
  });
});

describe("normalizePiErrorMessage", () => {
  it("unwraps a Codex error envelope", () => {
    const raw = 'Codex error: {"type":"error","error":{"message":"context_length_exceeded"}}';
    expect(normalizePiErrorMessage(raw)).toBe("context_length_exceeded");
  });

  it("returns null for empty input", () => {
    expect(normalizePiErrorMessage("")).toBeNull();
  });
});

describe("parseContextLimitFromError", () => {
  const cases = [
    ["This model's maximum context length is 128000 tokens", 128000],
    ["maximum context length is 200000 tokens, however you requested 210000 tokens", 200000],
    ["context window of 128000", 128000],
    ["context length: 32768", 32768],
    ["this model supports at most 8192 tokens", 8192],
    ["supports up to 1000000 tokens", 1000000],
    ["token limit is 16385", 16385],
    ["maximum context length is 128,000 tokens", 128000],
  ];
  for (const [message, expected] of cases) {
    it(`extracts ${expected} from "${message}"`, () => {
      expect(parseContextLimitFromError(message)).toBe(expected);
    });
  }

  const noLimit = [
    "",
    "Your input exceeds the context window of this model. Please adjust your input and try again.",
    "rate limit exceeded",
    "context_length_exceeded",
    "internal server error",
    "8 tokens", // too small to be a real window
  ];
  for (const message of noLimit) {
    it(`returns null for "${message}"`, () => {
      expect(parseContextLimitFromError(message)).toBeNull();
    });
  }
});
