// SPDX-License-Identifier: MIT
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { api, parseEventStream, saveToken } from "./api";
import type { WebEvent } from "./types";

Object.defineProperty(window, "sessionStorage", {
  configurable: true,
  value: memoryStorage(),
});

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("browser event protocol", () => {
  it("parses fragmented SSE data blocks and ignores heartbeats", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": keep-alive\n\nid: 7\nevent: thread.changed\nda"));
        controller.enqueue(encoder.encode('ta: {"id":"7","version":1,"revision":7,'));
        controller.enqueue(encoder.encode('"type":"thread.changed","at":"2026-01-01T00:00:00.000Z","threadId":"thread-1"}\n\n'));
        controller.close();
      },
    });
    const events: WebEvent[] = [];
    await parseEventStream(stream, (event) => events.push(event));
    expect(events).toEqual([{
      id: "7",
      version: 1,
      revision: 7,
      type: "thread.changed",
      at: "2026-01-01T00:00:00.000Z",
      threadId: "thread-1",
    }]);
  });

  it("probes without credentials and sends a stored token only after authentication is required", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({
        version: 1,
        revision: 0,
        agents: [],
        threads: [],
        newProactiveThreadIds: [],
      }), { status: 200, headers: { "content-type": "application/json" } })
    );

    saveToken("browser-token-0123456789");
    await api.probeBootstrap();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);

    await api.bootstrap();
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("authorization"))
      .toBe("Bearer browser-token-0123456789");
  });
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}
