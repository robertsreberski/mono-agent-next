// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { api, parseEventStream, saveToken, streamTurn } from "./api";
import type { Attachment, WebEvent } from "./types";

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

  it("omits an empty bearer header and sends a stored browser token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({
        version: 1,
        revision: 0,
        agents: [],
        threads: [],
        newProactiveThreadIds: [],
      }), { status: 200, headers: { "content-type": "application/json" } }));

    saveToken("browser-token-0123456789");
    await api.probeBootstrap();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);

    await api.bootstrap();
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("authorization"))
      .toBe("Bearer browser-token-0123456789");
    saveToken("");
    fetchMock.mockRestore();
  });

  it("rejects an oversized serialized turn before opening a request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const attachment = (name: string): Attachment => ({
      id: name,
      name,
      mediaType: "application/octet-stream",
      sizeBytes: 350 * 1_024,
      url: `data:application/octet-stream;base64,${
        "AAAA".repeat(Math.floor((350 * 1_024) / 3)) + "AAA="
      }`,
    });

    await expect(streamTurn("thread-1", {
      text: "x".repeat(100 * 1_024),
      attachments: [attachment("first.bin"), attachment("second.bin")],
    }, vi.fn())).rejects.toThrow(
      "Message content and attachments exceed the 1 MiB request limit.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});
