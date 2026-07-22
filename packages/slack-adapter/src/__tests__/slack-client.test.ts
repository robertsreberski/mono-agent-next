import { describe, expect, it, vi } from "vitest";

import {
  SlackApiError,
  SlackWebApiClient,
} from "../slack-client.js";

const BOT_TOKEN = "test-bot-token";
const APP_TOKEN = "test-app-token";

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("SlackWebApiClient", () => {
  it("sends Slack Web API requests with bearer auth and JSON bodies", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, channel: "C1", ts: "171.1", message: { text: "hello" } }),
    ) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      apiBaseUrl: "https://slack.example/api/",
      fetchImpl,
      requestTimeoutMs: 0,
    });

    const result = await client.chatPostMessage({ channel: "C1", text: "hello" });

    expect(result).toMatchObject({ ok: true, channel: "C1", ts: "171.1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(String(url)).toBe("https://slack.example/api/chat.postMessage");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      authorization: `Bearer ${BOT_TOKEN}`,
      "content-type": "application/json; charset=utf-8",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ channel: "C1", text: "hello" });
  });

  it("uses the app token for Socket Mode connection URLs", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, url: "wss://wss.slack.com/link/?ticket=abc" }),
    ) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      fetchImpl,
      requestTimeoutMs: 0,
    });

    await expect(client.appsConnectionsOpen()).resolves.toEqual({
      ok: true,
      url: "wss://wss.slack.com/link/?ticket=abc",
    });

    const [, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${APP_TOKEN}` });
  });

  it("deletes a transient message through chat.delete", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, channel: "C1", ts: "171.1" }),
    ) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      fetchImpl,
      requestTimeoutMs: 0,
    });

    await expect(client.chatDelete({ channel: "C1", ts: "171.1" })).resolves.toMatchObject({
      ok: true,
      channel: "C1",
      ts: "171.1",
    });
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(String(url)).toBe("https://slack.com/api/chat.delete");
    expect(JSON.parse(String(init?.body))).toEqual({ channel: "C1", ts: "171.1" });
  });

  it("allows send-only clients without an app token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, channel: "C1", ts: "171.1" }),
    ) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      fetchImpl,
      requestTimeoutMs: 0,
    });

    await expect(client.chatPostMessage({ channel: "C1", text: "hello" })).resolves.toMatchObject({
      ok: true,
      channel: "C1",
      ts: "171.1",
    });
    await expect(client.appsConnectionsOpen()).rejects.toThrow(/app token is required/u);
  });

  it("throws sanitized errors for Slack ok=false envelopes", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: "invalid_auth", needed: BOT_TOKEN }),
    ) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      fetchImpl,
      requestTimeoutMs: 0,
    });

    const error = await captureError(() =>
      client.chatUpdate({ channel: "C1", ts: "171.1", text: "updated" }),
    );

    expect(error).toBeInstanceOf(SlackApiError);
    expect(error).toMatchObject({ kind: "slack", slackError: "invalid_auth" });
    expect(error.message).not.toContain(BOT_TOKEN);
  });

  it("throws sanitized HTTP, network, abort, and malformed errors", async () => {
    const http = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      fetchImpl: vi.fn(async () => new Response(`body ${BOT_TOKEN}`, { status: 502 })) as unknown as typeof fetch,
      requestTimeoutMs: 0,
    });
    const network = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      fetchImpl: vi.fn(async () => {
        throw new Error(`network ${BOT_TOKEN}`);
      }) as unknown as typeof fetch,
      requestTimeoutMs: 0,
    });
    const aborted = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      fetchImpl: vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }) as unknown as typeof fetch,
      requestTimeoutMs: 0,
    });
    const malformed = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      fetchImpl: vi.fn(async () => new Response("not json")) as unknown as typeof fetch,
      requestTimeoutMs: 0,
    });

    await expect(http.authTest()).rejects.toMatchObject({ kind: "http", status: 502 });
    await expect(network.authTest()).rejects.toMatchObject({ kind: "network" });
    await expect(aborted.authTest()).rejects.toMatchObject({ kind: "aborted" });
    await expect(malformed.authTest()).rejects.toMatchObject({ kind: "malformed" });
  });

  it("downloads a private file with bot bearer auth via GET", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const fetchImpl = vi.fn(async () => new Response(bytes)) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      fetchImpl,
      requestTimeoutMs: 0,
    });

    const result = await client.downloadFile({ url: "https://files.slack.test/p.png" });

    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(String(url)).toBe("https://files.slack.test/p.png");
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual({ authorization: `Bearer ${BOT_TOKEN}` });
  });

  it("rejects a download that exceeds the configured byte cap", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const fetchImpl = vi.fn(async () => new Response(bytes)) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      fetchImpl,
      requestTimeoutMs: 0,
    });

    await expect(
      client.downloadFile({ url: "https://files.slack.test/big.bin", maxBytes: 4 }),
    ).rejects.toBeInstanceOf(SlackApiError);
  });

  it("surfaces a sanitized HTTP error for a failed download", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(`body ${BOT_TOKEN}`, { status: 403 }),
    ) as unknown as typeof fetch;
    const client = new SlackWebApiClient({
      botToken: BOT_TOKEN,
      appToken: APP_TOKEN,
      fetchImpl,
      requestTimeoutMs: 0,
    });

    const error = await captureError(() =>
      client.downloadFile({ url: "https://files.slack.test/forbidden.png" }),
    );
    expect(error).toBeInstanceOf(SlackApiError);
    expect(error).toMatchObject({ kind: "http", status: 403 });
    expect(error.message).not.toContain(BOT_TOKEN);
  });
});

async function captureError(action: () => Promise<unknown>): Promise<SlackApiError> {
  try {
    await action();
  } catch (error) {
    return error as SlackApiError;
  }
  throw new Error("Expected action to throw.");
}
