import { describe, expect, it, vi } from "vitest";

import {
  createSecretSafeTelegramLogger,
  redactTelegramError,
  redactTelegramSecretText,
} from "../log-redaction.js";

const TOKEN = "123456789:AAExampleSecret_0123456789abcdef";
const API_URL = `https://api.telegram.org/bot${TOKEN}/getUpdates`;
const FILE_URL = `https://api.telegram.org/file/bot${TOKEN}/voice/file.ogg`;
const OTHER_BEARER = "opaque-service-bearer-credential-abcdef";
const SHORT_BEARER = "abc";

describe("Telegram log redaction", () => {
  it("redacts configured tokens and Bot API URL tokens", () => {
    const redacted = redactTelegramSecretText(
      `token=${TOKEN} api=${API_URL} file=${FILE_URL} Authorization: Bearer ${SHORT_BEARER} X-Amz-Security-Token: ${OTHER_BEARER} Cookie: session=${OTHER_BEARER} https://host.invalid/?X-Amz-Signature=${OTHER_BEARER}&refresh_token=${SHORT_BEARER} https://user:${OTHER_BEARER}@host.invalid/`,
      [TOKEN],
    );
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).not.toContain(OTHER_BEARER);
    expect(redacted).not.toContain(`Bearer ${SHORT_BEARER}`);
    expect(redacted).not.toContain(`refresh_token=${SHORT_BEARER}`);
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
    ]) {
      const safe = redactTelegramSecretText(rawHeader);
      expect(safe).not.toContain(OTHER_BEARER);
      expect(safe).not.toContain(SHORT_BEARER);
    }

    expect(redactTelegramSecretText("statusCode: 502, monkey: healthy"))
      .toBe("statusCode: 502, monkey: healthy");
  });

  it("sanitizes nested errors, causes, request objects, URLs, and stacks before logging", () => {
    const error = Object.assign(new Error(`poll failed at ${API_URL}`, {
      cause: {
        request: { url: new URL(FILE_URL), authorization: `Bearer ${OTHER_BEARER}` },
      },
    }), {
      request: {
        url: API_URL,
        token: TOKEN,
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
        query: { token: OTHER_BEARER, code: SHORT_BEARER, signature: OTHER_BEARER, key: OTHER_BEARER },
      },
    });
    const sink = vi.fn();
    const logger = createSecretSafeTelegramLogger({ error: sink }, [TOKEN]);

    logger?.error?.(`Telegram polling failed for ${TOKEN}`, { error, url: FILE_URL });

    const serialized = JSON.stringify(sink.mock.calls);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(OTHER_BEARER);
    expect(serialized).toContain("[REDACTED_TELEGRAM_BOT_TOKEN]");
    expect(serialized).toContain("poll failed");
  });

  it("neutralizes executable hooks, accessors, aliases, tuples, and URL userinfo", () => {
    const sink = vi.fn((_message: string, metadata?: Record<string, unknown>) => {
      JSON.stringify(metadata);
    });
    const logger = createSecretSafeTelegramLogger({ error: sink }, [TOKEN]);
    const shared = { status: "shared" };
    const error = Object.assign(new Error("failed"), {
      toJSON: () => ({ credential: OTHER_BEARER }),
    });
    Object.defineProperty(error, "throwing", {
      enumerable: true,
      get: () => { throw new Error(OTHER_BEARER); },
    });

    expect(() => logger?.error?.("poll failed", {
      payload: { toJSON: () => ({ credential: OTHER_BEARER }) },
      query: { apikey: OTHER_BEARER, "request.authorization": OTHER_BEARER },
      tuple: ["apikey", OTHER_BEARER],
      requestHeaders: [["X-Future-Header", OTHER_BEARER]],
      responseHeaders: ["X-Future-Header", OTHER_BEARER],
      socks: new URL(`socks5://user:${OTHER_BEARER}@proxy.invalid:1080`),
      emptyUser: new URL(`https://:${OTHER_BEARER}@host.invalid/`),
      error,
      first: shared,
      second: shared,
      [TOKEN]: "value",
    })).not.toThrow();

    const serialized = JSON.stringify(sink.mock.calls);
    expect(serialized).not.toContain(OTHER_BEARER);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("[Circular]");
    expect(serialized).toContain("[Function]");
    expect(serialized).toContain("[Accessor]");
  });

  it("returns a secret-safe Error for host callbacks", () => {
    const failure = Object.assign(new Error(`poll failed at ${API_URL}`, {
      cause: { url: FILE_URL, token: TOKEN },
    }), {
      request: { url: API_URL },
    });

    const safe = redactTelegramError(failure, [TOKEN]);

    expect(safe).toBeInstanceOf(Error);
    expect(safe.message).toContain("poll failed");
    expect(safe.message).not.toContain(TOKEN);
    expect(safe.stack).not.toContain(TOKEN);
    expect(JSON.stringify(safe)).not.toContain(TOKEN);
    expect(JSON.stringify((safe as Error & { cause?: unknown }).cause)).not.toContain(TOKEN);
  });

  it("returns a safe Error when custom serialization or accessors are hostile", () => {
    const failure = Object.assign(new Error("poll failed"), {
      toJSON: () => ({ credential: OTHER_BEARER }),
    });
    Object.defineProperty(failure, "throwing", {
      enumerable: true,
      get: () => { throw new Error(OTHER_BEARER); },
    });

    const safe = redactTelegramError(failure, []);

    expect(() => JSON.stringify(safe)).not.toThrow();
    expect(JSON.stringify(safe)).not.toContain(OTHER_BEARER);
  });

  it("swallows logger sink failures after sanitizing", () => {
    const logger = createSecretSafeTelegramLogger({
      error: (_message: string) => { throw new Error("sink failed"); },
    }, []);

    expect(() => logger?.error?.(`Bearer ${OTHER_BEARER}`)).not.toThrow();
  });
});
