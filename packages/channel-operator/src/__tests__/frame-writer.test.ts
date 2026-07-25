import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";

import {
  OPERATOR_LIMITS,
  parseOperatorFrame,
  type OperatorFrame,
} from "@mono-agent/operator";
import { describe, expect, it } from "vitest";

import { StreamLimitError } from "../errors.js";
import { OperatorFrameWriter } from "../frame-writer.js";

class FakeFrameResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  backpressured = false;
  readonly writes: string[] = [];

  write(value: string): boolean {
    this.writes.push(value);
    return !this.backpressured;
  }
}

describe("OperatorFrameWriter", () => {
  it("waits for drain when the response applies backpressure", async () => {
    const response = new FakeFrameResponse();
    response.backpressured = true;
    const writer = new OperatorFrameWriter(
      response as unknown as ServerResponse,
      new AbortController(),
    );
    let resolved = false;
    const pending = writer.write({
      type: "accepted",
      turnId: "backpressure",
      conversationId: "conversation",
      startedAt: "2026-01-02T03:04:05.000Z",
    }).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    response.backpressured = false;
    response.emit("drain");
    await pending;
    expect(resolved).toBe(true);
  });

  it("reserves a terminal stream_limit frame and aborts at the stream byte bound", async () => {
    const response = new FakeFrameResponse();
    const controller = new AbortController();
    const writer = new OperatorFrameWriter(
      response as unknown as ServerResponse,
      controller,
    );
    const largeFrame: OperatorFrame = {
      type: "delta",
      turnId: "stream-limit",
      target: "assistant",
      text: "x".repeat(Math.floor(OPERATOR_LIMITS.frameBytes / 2)),
      mode: "append",
    };

    await writer.write(largeFrame);
    await writer.write(largeFrame);
    await writer.write(largeFrame);
    await expect(writer.write(largeFrame)).rejects.toBeInstanceOf(StreamLimitError);

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(StreamLimitError);
    const terminal = parseOperatorFrame(
      JSON.parse(response.writes.at(-1) ?? "null") as unknown,
    );
    expect(terminal).toMatchObject({
      type: "error",
      turnId: "stream-limit",
      error: {
        code: "stream_limit",
        message: "The operator stream exceeded its byte limit.",
      },
      cancelled: false,
    });
    expect(Buffer.byteLength(response.writes.join(""), "utf8"))
      .toBeLessThanOrEqual(OPERATOR_LIMITS.streamBytes);
  });
});
