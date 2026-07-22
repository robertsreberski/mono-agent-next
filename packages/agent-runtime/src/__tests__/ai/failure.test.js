import { describe, it, expect } from "vitest";
import {
  classifyFailure,
  createStderrTail,
  FAILURE_KINDS,
  isContextLimitFailureText,
  retryableProviderFailureInfo,
} from "../../ai/failure.js";

describe("classifyFailure", () => {
  it("returns null for clean exit", () => {
    expect(classifyFailure({ exitCode: 0 })).toBeNull();
  });

  it("classifies budget exceeded first", () => {
    expect(classifyFailure({ budgetExceeded: true, errorText: "rate limit" })).toBe("budget_exceeded");
  });

  it("classifies child failure", () => {
    expect(classifyFailure({ childFailed: true })).toBe("child_failed");
  });

  it("classifies invalid result before timeout", () => {
    expect(classifyFailure({ resultParseError: true, timedOut: true })).toBe("invalid_result");
  });

  it("classifies timeout", () => {
    expect(classifyFailure({ timedOut: true })).toBe("timeout");
  });

  it("classifies user cancellation", () => {
    expect(classifyFailure({ cancelRequested: true, cancelInitiator: "user" })).toBe("cancelled_user");
    expect(classifyFailure({ cancelRequested: true, cancelInitiator: "api_cancel" })).toBe("cancelled_user");
    expect(classifyFailure({ cancelRequested: true })).toBe("cancelled");
  });

  it("classifies stale cancel as cancelled_stale", () => {
    expect(classifyFailure({ cancelRequested: true, cancelInitiator: "stale_reconcile" })).toBe("cancelled_stale");
  });

  it("distinguishes coordinator shutdown from stale cancel (R5)", () => {
    expect(classifyFailure({ cancelRequested: true, cancelInitiator: "coordinator_shutdown" })).toBe("cancelled_shutdown");
  });

  it("classifies raw cancellation exits and signals", () => {
    expect(classifyFailure({ exitCode: 130 })).toBe("cancelled_signal");
    expect(classifyFailure({ signal: "SIGTERM" })).toBe("cancelled_signal");
    expect(classifyFailure({ signal: "SIGINT" })).toBe("cancelled_signal");
  });

  it("classifies SIGKILL with no code as abandoned", () => {
    expect(classifyFailure({ signal: "SIGKILL" })).toBe("abandoned");
  });

  it("respects an explicit hint when valid", () => {
    expect(classifyFailure({ exitCode: 1, errorText: "x", hint: "tool_failure" })).toBe("tool_failure");
    expect(classifyFailure({ exitCode: 1, errorText: "x", hint: "invalid_delegation" })).toBe("invalid_delegation");
  });

  it("ignores invalid hints", () => {
    expect(classifyFailure({ exitCode: 1, errorText: "x", hint: "made_up" })).toBe("spawn");
  });

  it("matches usage limit messages from stderr", () => {
    expect(classifyFailure({ exitCode: 2, stderrTail: "rate limit reached" })).toBe("usage_limit");
    expect(classifyFailure({ exitCode: 2, errorText: "Max turns" })).toBe("usage_limit");
    expect(classifyFailure({ exitCode: 2, errorText: "maximum output tokens reached" })).toBe("usage_limit");
  });

  it("classifies request context overflows separately from usage limits", () => {
    const codexError = "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.";
    expect(isContextLimitFailureText(codexError)).toBe(true);
    expect(classifyFailure({ exitCode: 2, errorText: codexError })).toBe("context_limit");
    expect(isContextLimitFailureText("429 rate limit: too many requests")).toBe(false);
  });

  it("matches provider unavailable messages", () => {
    expect(classifyFailure({ exitCode: 1, errorText: "fetch failed: ECONNRESET" })).toBe("provider_unavailable");
    expect(classifyFailure({ exitCode: 1, stderrTail: "503 Service Unavailable" })).toBe("provider_unavailable");
    expect(classifyFailure({ exitCode: 1, errorText: "Codex SSE response headers timed out after 10000ms" })).toBe("provider_unavailable");
  });

  it("classifies provider credential failures separately from availability", () => {
    expect(classifyFailure({ exitCode: 1, errorText: "No API key for provider: openai-codex" })).toBe("provider_auth");
    expect(classifyFailure({ exitCode: 1, errorText: "OAuth refresh failed for openai-codex" })).toBe("provider_auth");
  });

  // I14: classifyFailure is a separate code path from retryableProviderFailureInfo
  // (hosts like worklab's coordinator call it directly), so the terse-connection-error
  // fix landed on RETRYABLE_PROVIDER_RE/retryableProviderSubkind needs the same
  // conservative alternation mirrored onto PROVIDER_UNAVAILABLE_RE, or a host
  // classifying this exact text without a `hint` falls through to "spawn" instead
  // of "provider_unavailable". No signature changes.
  it("classifies pi 0.80's terse 'Connection error.' as provider_unavailable (no hint)", () => {
    expect(classifyFailure({ exitCode: 1, errorText: "Connection error." })).toBe("provider_unavailable");
  });

  it("matches tool failure messages", () => {
    expect(classifyFailure({ exitCode: 1, errorText: "tool Edit failed" })).toBe("tool_failure");
  });

  it("falls back to spawn", () => {
    expect(classifyFailure({ exitCode: 127, errorText: "command not found" })).toBe("spawn");
  });

  it("FAILURE_KINDS includes the new entries", () => {
    expect(FAILURE_KINDS).toEqual(expect.arrayContaining([
      "budget_exceeded", "child_failed", "cancelled", "cancelled_user", "cancelled_stale", "cancelled_signal",
      "context_limit", "invalid_delegation", "provider_unavailable_exhausted",
    ]));
  });

  it("FAILURE_KINDS distinguishes provider_unavailable from provider_unavailable_exhausted", () => {
    expect(FAILURE_KINDS).toContain("provider_unavailable");
    expect(FAILURE_KINDS).toContain("provider_unavailable_exhausted");
    expect(FAILURE_KINDS).toContain("provider_auth");
    expect(FAILURE_KINDS).toContain("skipped_capability_mismatch");
  });
});

describe("createStderrTail", () => {
  it("keeps only the last `limit` bytes", () => {
    const tail = createStderrTail({ limit: 16 });
    tail.push("aaaaaaaa");
    tail.push("bbbbbbbb");
    tail.push("cccccccc");
    expect(tail.toString()).toContain("cccccccc");
    expect(tail.toString()).not.toContain("aaaaaaaa");
  });

  it("notes how many bytes were dropped", () => {
    const tail = createStderrTail({ limit: 4 });
    tail.push("abcdef");
    expect(tail.bytesDropped).toBe(2);
    expect(tail.toString()).toMatch(/^\[truncated 2 earlier bytes\]/);
  });

  it("handles a single chunk larger than limit", () => {
    const tail = createStderrTail({ limit: 4 });
    tail.push("abcdefghij");
    expect(tail.toString()).toContain("ghij");
  });

  it("accepts buffer-like values via toString", () => {
    const tail = createStderrTail({ limit: 8 });
    tail.push(Buffer.from("hello "));
    tail.push("world");
    expect(tail.toString()).toContain("world");
  });
});

describe("retryableProviderFailureInfo", () => {
  it("marks overloaded provider errors as retryable", () => {
    expect(retryableProviderFailureInfo({
      failureKind: "provider_unavailable",
      errorText: "Our servers are currently overloaded. Please try again later.",
    })).toMatchObject({ retryable: true, subkind: "overloaded" });
  });

  it("extracts request IDs from generic retryable provider messages", () => {
    expect(retryableProviderFailureInfo({
      failureKind: "provider_unavailable",
      errorText: "An error occurred while processing your request. You can retry your request. Please include the request ID 7e4dca0a-6e17-486c-9af6-59785816e5de.",
    })).toMatchObject({
      retryable: true,
      subkind: "retryable_request",
      requestId: "7e4dca0a-6e17-486c-9af6-59785816e5de",
    });
  });

  it("treats provider-side terminated aborts as retryable", () => {
    expect(retryableProviderFailureInfo({
      failureKind: "provider_unavailable",
      errorText: "terminated",
    })).toMatchObject({ retryable: true, subkind: "terminated" });
  });

  it.each([
    "socket hang up",
    "UND_ERR_SOCKET",
    "ECONNRESET while reading response",
    "Premature close",
    "Stream disconnected before completion",
    "WebSocket error",
    "websocket disconnected before completion",
  ])("treats %s as a retryable provider termination", (message) => {
    expect(retryableProviderFailureInfo({
      failureKind: "provider_unavailable",
      errorText: message,
    })).toMatchObject({ retryable: true, subkind: "terminated" });
  });

  it("does not treat generic termination text as retryable without provider classification", () => {
    expect(retryableProviderFailureInfo({
      errorText: "terminated",
    })).toMatchObject({ retryable: false, subkind: null });
  });

  it("does not treat generic WebSocket text as retryable without provider classification", () => {
    expect(retryableProviderFailureInfo({
      errorText: "WebSocket error",
    })).toMatchObject({ retryable: false, subkind: null });
  });

  it("keeps nonretryable provider errors terminal", () => {
    expect(retryableProviderFailureInfo({
      failureKind: "provider_unavailable",
      errorText: "invalid_request_error: Unknown parameter: prompt_cache_retention",
    })).toMatchObject({ retryable: false, subkind: "non_retryable" });
  });

  // pi 0.80's openai-client-style bridge surfaces a down/unreachable provider as
  // this terse string with no cause text (no ECONNREFUSED, no "fetch failed").
  // Before this fix it matched neither RETRYABLE_PROVIDER_RE nor any
  // retryableProviderSubkind pattern, so createRouterRuntime never failed over
  // on the most basic "provider is down" scenario.
  it("treats pi 0.80's terse 'Connection error.' as a retryable network failure", () => {
    expect(retryableProviderFailureInfo({
      failureKind: "provider_unavailable",
      errorText: "Connection error.",
    })).toMatchObject({ retryable: true, subkind: "network" });
  });

  it("treats a connection refused message as a retryable network failure", () => {
    expect(retryableProviderFailureInfo({
      failureKind: "provider_unavailable",
      errorText: "connection refused while contacting upstream provider",
    })).toMatchObject({ retryable: true, subkind: "network" });
  });

  it("keeps an auth error mentioning 'connection' non-retryable (NON_RETRYABLE precedence)", () => {
    expect(retryableProviderFailureInfo({
      failureKind: "provider_unavailable",
      errorText: "invalid api key for connection",
    })).toMatchObject({ retryable: false, subkind: "non_retryable" });
  });

  it("keeps explicit provider auth failures terminal", () => {
    expect(retryableProviderFailureInfo({
      failureKind: "provider_auth",
      errorText: "No API key for provider: openai-codex",
    })).toMatchObject({ retryable: false, subkind: null });
  });

  it("treats a classified context overflow as route-fallback eligible", () => {
    expect(retryableProviderFailureInfo({
      failureKind: "context_limit",
      errorText: "Your input exceeds the context window of this model.",
    })).toMatchObject({ retryable: true, subkind: "context_limit" });
  });
});
