import { describe, expect, it, vi } from "vitest";

import {
  createSecretSafeSlackLogger,
  isSafeSlackPrototypeInstance,
  redactSlackErrorMessage,
  redactSlackSecretText,
} from "../log-redaction.js";

// Build credential-shaped fixtures at runtime so repository secret scanners do
// not mistake the intentionally fake values for committed credentials.
const BOT_TOKEN = [
  "xoxb",
  "123456789012",
  "123456789012",
  "exampleBotSecret0123456789",
].join("-");
const UNCONFIGURED_BOT_TOKEN = ["xoxb", "unconfiguredBotSecret0123456789"].join("-");
const UNCONFIGURED_USER_TOKEN = ["xoxp", "unconfiguredUserSecret0123456789"].join("-");
const UNCONFIGURED_XOX_TOKENS = Array.from({ length: 26 }, (_, index) => [
  `xox${String.fromCharCode("a".charCodeAt(0) + index)}`,
  `unconfiguredFamily${String(index)}Secret0123456789`,
].join("-"));
const APP_TOKEN = ["xapp", "1", "exampleAppSecret0123456789"].join("-");
const OTHER_BEARER = "opaque-service-bearer-credential-abcdef";
const SHORT_BEARER = "abc";

describe("Slack log redaction", () => {
  it("redacts configured and recognizable Slack tokens plus bearer-shaped text", () => {
    const redacted = redactSlackSecretText(
      `bot=${BOT_TOKEN} other_bot=${UNCONFIGURED_BOT_TOKEN} user=${UNCONFIGURED_USER_TOKEN} families=${UNCONFIGURED_XOX_TOKENS.join(" ")} app=${APP_TOKEN} Authorization: Bearer ${SHORT_BEARER} X-Amz-Security-Token: ${OTHER_BEARER} Cookie: session=${OTHER_BEARER} https://host.invalid/?X-Amz-Signature=${OTHER_BEARER}&refresh_token=${SHORT_BEARER} wss://wss.slack.com/link/?ticket=${OTHER_BEARER} https://user:${OTHER_BEARER}@host.invalid/`,
      [BOT_TOKEN],
    );
    expect(redacted).not.toContain(BOT_TOKEN);
    expect(redacted).not.toContain(UNCONFIGURED_BOT_TOKEN);
    expect(redacted).not.toContain(UNCONFIGURED_USER_TOKEN);
    for (const familyToken of UNCONFIGURED_XOX_TOKENS) {
      expect(redacted).not.toContain(familyToken);
    }
    expect(redacted).not.toContain(APP_TOKEN);
    expect(redacted).not.toContain(OTHER_BEARER);
    expect(redacted).not.toContain(`Bearer ${SHORT_BEARER}`);
    expect(redacted).not.toContain(`refresh_token=${SHORT_BEARER}`);
    expect(redacted).toContain("[REDACTED_SLACK_TOKEN]");
    expect(redacted).toContain("[REDACTED_BEARER_CREDENTIAL]");

    for (const rawHeader of [
      `Authorization: Basic ${OTHER_BEARER}`,
      `Authorization: "Basic ${OTHER_BEARER}"`,
      `Proxy-Authorization: ApiKey ${OTHER_BEARER}`,
      `Cookie: session=${OTHER_BEARER}; refresh=${SHORT_BEARER}`,
      `authorization=Basic ${OTHER_BEARER}`,
      `{"Authorization":"Basic ${OTHER_BEARER}"}`,
      `{"headers":{"x-api-key":"${OTHER_BEARER}"}}`,
      `{"query":{"token":"${OTHER_BEARER}"}}`,
      JSON.stringify(JSON.stringify({ headers: { Authorization: `Basic ${OTHER_BEARER}` } })),
      JSON.stringify(JSON.stringify({ query: { token: OTHER_BEARER } })),
      `Bearer "${OTHER_BEARER}"`,
      `Bearer \\"${OTHER_BEARER}\\"`,
      `socks5://user:${OTHER_BEARER}@proxy.invalid:1080`,
      `https://:${OTHER_BEARER}@host.invalid/`,
      `https://user@realm:${OTHER_BEARER}@host.invalid/`,
      `https://host.invalid/?%74oken=${OTHER_BEARER}`,
      `https://host.invalid/?%74oken%ZZ=${OTHER_BEARER}`,
      `https://host.invalid/?auth[token]=${OTHER_BEARER}`,
    ]) {
      const safe = redactSlackSecretText(rawHeader);
      expect(safe).not.toContain(OTHER_BEARER);
      expect(safe).not.toContain(SHORT_BEARER);
    }

    expect(redactSlackSecretText("statusCode: 502, monkey: healthy"))
      .toBe("statusCode: 502, monkey: healthy");
  });

  it("bounds direct and wrapped message text at the same limit", () => {
    const atLimit = "a".repeat(16_384);
    const overLimit = "a".repeat(16_385);
    const sink = vi.fn((_message: string, _metadata?: Record<string, unknown>) => undefined);
    const logger = createSecretSafeSlackLogger({ error: sink }, []);

    expect(redactSlackSecretText(atLimit)).toBe(atLimit);
    expect(redactSlackSecretText(overLimit)).toBe("[SLACK_LOG_DETAILS_TRUNCATED]");
    logger?.error?.(overLimit);
    expect(sink).toHaveBeenCalledWith("[SLACK_LOG_DETAILS_TRUNCATED]", undefined);

    const expansionSink = vi.fn((_message: string) => undefined);
    const expansionLogger = createSecretSafeSlackLogger({ error: expansionSink }, ["a"]);
    const expansionInput = "a".repeat(1_000);
    expect(redactSlackSecretText(expansionInput, ["a"]))
      .toBe("[SLACK_LOG_DETAILS_TRUNCATED]");
    expansionLogger?.error?.(expansionInput);
    expect(expansionSink).toHaveBeenCalledWith("[SLACK_LOG_DETAILS_TRUNCATED]", undefined);
  });

  it("redacts credentials reconstructed across named object values", () => {
    const sink = vi.fn((_message: string, _metadata?: Record<string, unknown>) => undefined);
    const logger = createSecretSafeSlackLogger({ error: sink }, [BOT_TOKEN]);

    for (const payload of [
      {
        left: BOT_TOKEN.slice(0, 7),
        right: BOT_TOKEN.slice(7),
      },
      {
        left: BOT_TOKEN.slice(0, 7),
        right: `${BOT_TOKEN.slice(7)} ${UNCONFIGURED_USER_TOKEN}`,
      },
      {
        left: `${UNCONFIGURED_USER_TOKEN} ${BOT_TOKEN.slice(0, 7)}`,
        right: BOT_TOKEN.slice(7),
      },
    ]) {
      logger?.error?.("request failed", { payload });
      expect(sink.mock.calls.at(-1)?.[1]).toEqual({
        payload: {
          left: "[REDACTED_FRAGMENTED_CREDENTIAL]",
          right: "[REDACTED_FRAGMENTED_CREDENTIAL]",
        },
      });
    }
  });

  it("sanitizes nested errors, causes, request objects, URLs, and stacks before logging", () => {
    const requestUrl = `https://slack.com/api/chat.postMessage?token=${OTHER_BEARER}`;
    const error = Object.assign(new Error(`request failed for ${BOT_TOKEN}`, {
      cause: {
        request: { url: new URL(requestUrl), authorization: `Bearer ${OTHER_BEARER}` },
      },
    }), {
      request: {
        url: requestUrl,
        token: APP_TOKEN,
        ticket: OTHER_BEARER,
        credentials: OTHER_BEARER,
        tokens: OTHER_BEARER,
        apiKeys: OTHER_BEARER,
        APIKeys: OTHER_BEARER,
        headers: {
          Authorization: `Bearer ${SHORT_BEARER}`,
          "x-api-key": OTHER_BEARER,
          "x-auth-token": OTHER_BEARER,
          "x-client-secret": OTHER_BEARER,
          "x-session-token": OTHER_BEARER,
          "x-future-auth-material": OTHER_BEARER,
        },
        headerPairs: [["x-auth-token", OTHER_BEARER]],
        rawHeaders: ["X-Future-Header", OTHER_BEARER],
        headersMap: { "X-Future-Header": OTHER_BEARER },
        query: {
          token: OTHER_BEARER,
          code: SHORT_BEARER,
          signature: OTHER_BEARER,
          key: OTHER_BEARER,
        },
        queryMap: { oauth_nonce: OTHER_BEARER },
        queryPairs: [["oauth_nonce", OTHER_BEARER]],
      },
    });
    const sink = vi.fn();
    const logger = createSecretSafeSlackLogger({ error: sink }, [BOT_TOKEN, APP_TOKEN]);

    logger?.error?.(`Slack request failed for ${BOT_TOKEN}`, { error, url: requestUrl });

    const serialized = JSON.stringify(sink.mock.calls);
    expect(serialized).not.toContain(BOT_TOKEN);
    expect(serialized).not.toContain(APP_TOKEN);
    expect(serialized).not.toContain(OTHER_BEARER);
    expect(serialized).toContain("[REDACTED_SLACK_TOKEN]");
    expect(serialized).toContain("request failed");
  });

  it("neutralizes executable hooks, accessors, aliases, tuples, and URL userinfo", () => {
    const sink = vi.fn((_message: string, metadata?: Record<string, unknown>) => {
      JSON.stringify(metadata);
    });
    const logger = createSecretSafeSlackLogger({ error: sink }, [BOT_TOKEN, APP_TOKEN]);
    const shared = { status: "shared" };
    const error = Object.assign(new Error("failed"), {
      toJSON: () => ({ credential: OTHER_BEARER }),
    });
    Object.defineProperty(error, "throwing", {
      enumerable: true,
      get: () => { throw new Error(OTHER_BEARER); },
    });
    const messageGetter = vi.fn(() => OTHER_BEARER);
    const specialError = new Error("safe");
    Object.defineProperty(specialError, "message", {
      configurable: true,
      get: messageGetter,
    });
    const hrefGetter = vi.fn(() => `https://host.invalid/?token=${OTHER_BEARER}`);
    const specialUrl = new URL("https://safe.invalid/");
    Object.defineProperty(specialUrl, "href", {
      configurable: true,
      get: hrefGetter,
    });
    const arrayGetter = vi.fn(() => OTHER_BEARER);
    const hostileArray: unknown[] = [];
    Object.defineProperty(hostileArray, "0", {
      configurable: true,
      enumerable: true,
      get: arrayGetter,
    });
    Object.defineProperty(hostileArray, "map", {
      configurable: true,
      value: () => [OTHER_BEARER],
    });

    expect(() => logger?.error?.("request failed", {
      payload: { toJSON: () => ({ credential: OTHER_BEARER }) },
      query: { apikey: OTHER_BEARER, "request.authorization": OTHER_BEARER },
      tuple: ["apikey", OTHER_BEARER],
      requestHeaders: [["X-Future-Header", OTHER_BEARER]],
      responseHeaders: ["X-Future-Header", OTHER_BEARER],
      socks: new URL(`socks5://user:${OTHER_BEARER}@proxy.invalid:1080`),
      emptyUser: new URL(`https://:${OTHER_BEARER}@host.invalid/`),
      error,
      specialError,
      specialUrl,
      hostileArray,
      first: shared,
      second: shared,
      [BOT_TOKEN]: "value",
    })).not.toThrow();

    const serialized = JSON.stringify(sink.mock.calls);
    expect(serialized).not.toContain(OTHER_BEARER);
    expect(serialized).not.toContain(BOT_TOKEN);
    expect(serialized).not.toContain("[Circular]");
    expect(serialized).toContain("[Function]");
    expect(serialized).toContain("[Accessor]");
    const logged = sink.mock.calls[0]?.[1];
    expect((logged?.payload as Record<string, unknown>)?.toJSON).toBe("[Function]");
    expect((logged?.error as Record<string, unknown>)?.throwing).toBe("[Accessor]");
    expect((logged?.hostileArray as unknown[])?.[0]).toBe("[Accessor]");
    expect(messageGetter).not.toHaveBeenCalled();
    expect(hrefGetter).not.toHaveBeenCalled();
    expect(arrayGetter).not.toHaveBeenCalled();
  });

  it("redacts every logger level while preserving benign metadata and the sink receiver", () => {
    const calls: Array<{
      readonly level: "debug" | "info" | "warn" | "error";
      readonly receiver: string;
      readonly message: string;
      readonly metadata: Record<string, unknown> | undefined;
    }> = [];
    const sink = {
      receiver: "original",
      debug(this: { receiver: string }, message: string, metadata?: Record<string, unknown>) {
        calls.push({ level: "debug", receiver: this.receiver, message, metadata });
      },
      info(this: { receiver: string }, message: string, metadata?: Record<string, unknown>) {
        calls.push({ level: "info", receiver: this.receiver, message, metadata });
      },
      warn(this: { receiver: string }, message: string, metadata?: Record<string, unknown>) {
        calls.push({ level: "warn", receiver: this.receiver, message, metadata });
      },
      error(this: { receiver: string }, message: string, metadata?: Record<string, unknown>) {
        calls.push({ level: "error", receiver: this.receiver, message, metadata });
      },
    };
    const logger = createSecretSafeSlackLogger(sink, [BOT_TOKEN]);
    const metadata = {
      status: "healthy",
      nested: { count: 2, token: BOT_TOKEN },
      symbol: Symbol(BOT_TOKEN),
      bigint: 1n,
    };

    logger?.debug?.(`debug ${BOT_TOKEN}`, metadata);
    logger?.info?.(`info ${BOT_TOKEN}`, metadata);
    logger?.warn?.(`warn ${BOT_TOKEN}`, metadata);
    logger?.error?.(`error ${BOT_TOKEN}`, metadata);

    expect(calls).toHaveLength(4);
    expect(calls.map((call) => call.level)).toEqual(["debug", "info", "warn", "error"]);
    expect(calls.every((call) => call.receiver === "original")).toBe(true);
    expect(calls.every((call) => call.metadata?.status === "healthy")).toBe(true);
    expect(calls.every((call) => call.metadata?.symbol === "[Symbol]")).toBe(true);
    expect(calls.every((call) => call.metadata?.bigint === "[BigInt]")).toBe(true);
    expect(JSON.stringify(calls)).not.toContain(BOT_TOKEN);
  });

  it("enforces one cumulative metadata text budget", () => {
    const sink = vi.fn((_message: string, _metadata?: Record<string, unknown>) => undefined);
    const logger = createSecretSafeSlackLogger({ info: sink }, []);
    const chunk = "a".repeat(16_000);

    logger?.info?.("bounded metadata", {
      a: chunk,
      b: chunk,
      c: chunk,
      d: chunk,
      e: chunk,
    });

    const logged = sink.mock.calls[0]?.[1];
    expect(logged?.a).toBe(chunk);
    expect(logged?.b).toBe(chunk);
    expect(logged?.c).toBe(chunk);
    expect(logged?.d).toBe(chunk);
    expect(logged?.e).toBe("[SLACK_LOG_DETAILS_TRUNCATED]");
    expect((JSON.stringify(logged) ?? "").length).toBeLessThan(70_000);
  });

  it("fails closed for reconstructable, malformed, cyclic, and oversized metadata", () => {
    const sink = vi.fn((_message: string, _metadata?: Record<string, unknown>) => undefined);
    const logger = createSecretSafeSlackLogger({ error: sink }, [BOT_TOKEN]);
    const characterFragments = [...BOT_TOKEN];
    const stringFragments = [BOT_TOKEN.slice(0, 7), BOT_TOKEN.slice(7)];
    const mixedFragments = [BOT_TOKEN.slice(0, 7), null, BOT_TOKEN.slice(7)];
    const nestedFragments = [[BOT_TOKEN.slice(0, 7)], [BOT_TOKEN.slice(7)]];
    const numericFragments = [...BOT_TOKEN].map((character) => character.charCodeAt(0));
    const boxedFragments = [Object(BOT_TOKEN.slice(0, 7)), Object(BOT_TOKEN.slice(7))];
    const holeSeparatedFragments: unknown[] = [];
    holeSeparatedFragments.length = 3;
    holeSeparatedFragments[0] = BOT_TOKEN.slice(0, 7);
    holeSeparatedFragments[2] = BOT_TOKEN.slice(7);
    const binary = Buffer.from(BOT_TOKEN);
    const bytes = Uint8Array.from([...BOT_TOKEN].map((character) => character.charCodeAt(0)));
    const proxiedBoxed = new Proxy(Object(BOT_TOKEN), {});
    const proxiedBinary = new Proxy(Buffer.from(BOT_TOKEN), {});
    const proxyDescriptorTrap = vi.fn(() => { throw new Error(OTHER_BEARER); });
    const statefulArray = new Proxy(["safe"], {
      getOwnPropertyDescriptor: proxyDescriptorTrap,
    });
    const nestedProxyArray = [statefulArray];
    const proxyPrototypeTrap = vi.fn(() => { throw new Error(OTHER_BEARER); });
    const hostilePrototypeProxy = new Proxy({}, {
      getPrototypeOf: proxyPrototypeTrap,
    });
    const gappedNumeric = {
      0: BOT_TOKEN.slice(0, 7),
      2: BOT_TOKEN.slice(7),
      label: "gapped",
    };
    const sparse: unknown[] = [];
    sparse.length = 1_000_000;
    const sharedLargeString = "a".repeat(16_384);
    const amplification = Array.from(
      { length: 8 },
      () => [null, ...Array<unknown>(255).fill(sharedLargeString)],
    );
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const oversizedAlphabeticKey = "k".repeat(16_385);
    const oversizedNumericKey = "9".repeat(16_385);
    const oversizedAlphabeticFields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    oversizedAlphabeticFields[oversizedAlphabeticKey] = BOT_TOKEN;
    const oversizedNumericFields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    oversizedNumericFields[oversizedNumericKey] = BOT_TOKEN;
    let dag: Record<string, unknown> = { status: "leaf" };
    for (let depth = 0; depth < 8; depth += 1) {
      dag = { left: dag, right: dag };
    }

    logger?.error?.("request failed", {
      boxed: Object(BOT_TOKEN),
      binary,
      bytes,
      proxiedBoxed,
      proxiedBinary,
      statefulArray,
      nestedProxyArray,
      hostilePrototypeProxy,
      gappedNumeric,
      characterFragments,
      stringFragments,
      mixedFragments,
      nestedFragments,
      numericFragments,
      boxedFragments,
      holeSeparatedFragments,
      headers: [OTHER_BEARER],
      rawHeaders: [OTHER_BEARER, "safe-name", OTHER_BEARER],
      queryPairs: [OTHER_BEARER],
      amplification,
      sparse,
      cycle,
      dag,
      oversizedAlphabeticFields,
      oversizedNumericFields,
    });

    const logged = sink.mock.calls[0]?.[1];
    expect(logged?.boxed).toBe("[REDACTED_SLACK_TOKEN]");
    expect(logged?.binary).toBe("[SLACK_LOG_BINARY_DATA_OMITTED]");
    expect(logged?.bytes).toBe("[SLACK_LOG_BINARY_DATA_OMITTED]");
    expect(logged?.proxiedBoxed).toBe("[SLACK_LOG_DETAILS_UNAVAILABLE]");
    expect(logged?.proxiedBinary).toBe("[SLACK_LOG_DETAILS_UNAVAILABLE]");
    expect(logged?.statefulArray).toBe("[SLACK_LOG_DETAILS_UNAVAILABLE]");
    expect(logged?.nestedProxyArray).toEqual(["[SLACK_LOG_DETAILS_TRUNCATED]"]);
    expect(logged?.hostilePrototypeProxy).toBe("[SLACK_LOG_DETAILS_UNAVAILABLE]");
    expect((logged?.gappedNumeric as Record<string, unknown>)?.value)
      .toBe("[SLACK_LOG_BINARY_DATA_OMITTED]");
    expect(proxyDescriptorTrap).not.toHaveBeenCalled();
    expect(proxyPrototypeTrap).not.toHaveBeenCalled();
    for (const field of [
      "characterFragments",
      "stringFragments",
      "mixedFragments",
      "nestedFragments",
      "numericFragments",
      "boxedFragments",
      "holeSeparatedFragments",
    ]) {
      expect(logged?.[field]).toEqual(["[REDACTED_FRAGMENTED_CREDENTIAL]"]);
    }
    expect(logged?.headers).toEqual(["[REDACTED_BEARER_CREDENTIAL]"]);
    expect(logged?.rawHeaders).toEqual([
      "[REDACTED_BEARER_CREDENTIAL]",
      "[REDACTED_BEARER_CREDENTIAL]",
      "[REDACTED_BEARER_CREDENTIAL]",
    ]);
    expect(logged?.queryPairs).toEqual(["[REDACTED_BEARER_CREDENTIAL]"]);
    expect(logged?.amplification).toEqual(["[SLACK_LOG_DETAILS_TRUNCATED]"]);
    expect(logged?.sparse).toEqual(["[SLACK_LOG_DETAILS_TRUNCATED]"]);
    expect((logged?.cycle as Record<string, unknown>)?.self).toBe("[Circular]");
    const dagSerialized = JSON.stringify(logged?.dag) ?? "";
    expect(dagSerialized).toContain("[Repeated]");
    expect(dagSerialized.length).toBeLessThan(20_000);
    for (const field of ["oversizedAlphabeticFields", "oversizedNumericFields"]) {
      const safeOversizedKeys = logged?.[field] as Record<string, unknown>;
      expect(Object.keys(safeOversizedKeys), field).toEqual(["[SLACK_LOG_DETAILS_TRUNCATED]"]);
      expect(safeOversizedKeys["[SLACK_LOG_DETAILS_TRUNCATED]"])
        .toBe("[SLACK_LOG_DETAILS_TRUNCATED]");
    }
  });

  it("renders hostile errors without invoking message accessors or coercion hooks", () => {
    const messageGetter = vi.fn(() => { throw new Error(OTHER_BEARER); });
    const primitiveHook = vi.fn(() => { throw new Error(OTHER_BEARER); });
    const hostileError = new Error("safe");
    Object.defineProperty(hostileError, "message", {
      configurable: true,
      get: messageGetter,
    });
    const hostileValue = { [Symbol.toPrimitive]: primitiveHook };
    const proxyPrototypeHook = vi.fn(() => { throw new Error(OTHER_BEARER); });
    const hostileProxy = new Proxy({}, { getPrototypeOf: proxyPrototypeHook });

    expect(redactSlackErrorMessage(hostileError)).toBe("[SLACK_LOG_DETAILS_UNAVAILABLE]");
    expect(redactSlackErrorMessage(hostileValue)).toBe("[SLACK_LOG_DETAILS_UNAVAILABLE]");
    expect(redactSlackErrorMessage(hostileProxy)).toBe("[SLACK_LOG_DETAILS_UNAVAILABLE]");
    expect(redactSlackErrorMessage(1n)).toBe("[BigInt]");
    expect(redactSlackErrorMessage(Symbol("sensitive"))).toBe("[Symbol]");
    expect(messageGetter).not.toHaveBeenCalled();
    expect(primitiveHook).not.toHaveBeenCalled();
    expect(proxyPrototypeHook).not.toHaveBeenCalled();
  });

  it("does not classify a prototype object as its own instance", () => {
    class ExampleError extends Error {}

    expect(isSafeSlackPrototypeInstance(ExampleError.prototype, ExampleError.prototype))
      .toBe(false);
    expect(isSafeSlackPrototypeInstance(new ExampleError("example"), ExampleError.prototype))
      .toBe(true);
  });

  it("snapshots known secrets and contains hostile logger members", () => {
    const knownSecrets = [OTHER_BEARER];
    const sink = vi.fn();
    const logger = createSecretSafeSlackLogger({ error: sink }, knownSecrets);
    knownSecrets.length = 0;

    logger?.error?.(`request failed for ${OTHER_BEARER}`);

    expect(JSON.stringify(sink.mock.calls)).not.toContain(OTHER_BEARER);

    const hostileLogger: { error?: (message: string) => void } = {};
    Object.defineProperty(hostileLogger, "error", {
      get: () => { throw new Error("hostile logger getter"); },
    });
    expect(() => createSecretSafeSlackLogger(hostileLogger, [])).not.toThrow();
  });

  it("swallows synchronous and asynchronous logger sink failures after sanitizing", async () => {
    const logger = createSecretSafeSlackLogger({
      error: (_message: string) => { throw new Error("sink failed"); },
    }, []);
    let asyncSinkCalled = false;
    const asyncLogger = createSecretSafeSlackLogger({
      error: async () => {
        asyncSinkCalled = true;
        throw new Error("async sink failed");
      },
    }, []);
    const rejection = Promise.reject(new Error("overridden catch failed"));
    const catchOverride = vi.fn(() => rejection);
    Object.defineProperty(rejection, "catch", {
      configurable: true,
      value: catchOverride,
    });
    const hostilePromiseLogger = createSecretSafeSlackLogger({
      error: () => rejection,
    }, []);

    expect(() => logger?.error?.(`Bearer ${OTHER_BEARER}`)).not.toThrow();
    expect(() => asyncLogger?.error?.(`Bearer ${OTHER_BEARER}`)).not.toThrow();
    expect(() => hostilePromiseLogger?.error?.(`Bearer ${OTHER_BEARER}`)).not.toThrow();
    await new Promise<void>((resolve) => { queueMicrotask(resolve); });
    expect(asyncSinkCalled).toBe(true);
    expect(catchOverride).not.toHaveBeenCalled();
  });
});
