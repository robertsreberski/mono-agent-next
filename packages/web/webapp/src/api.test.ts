// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { parseEventStream } from "./api";
import type { WebEvent } from "./types";

describe("authenticated browser event protocol", () => {
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
});
