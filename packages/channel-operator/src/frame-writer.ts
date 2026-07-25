import type { ServerResponse } from "node:http";

import {
  OPERATOR_LIMITS,
  serializeOperatorFrame,
  type OperatorErrorFrame,
  type OperatorFrame,
} from "@mono-agent/operator";

import { StreamClosedError, StreamLimitError } from "./errors.js";

const TERMINAL_FRAME_RESERVE_BYTES = 1_024;

type FrameResponse = Pick<
  ServerResponse,
  "destroyed" | "writableEnded" | "write" | "once" | "off"
>;

export class OperatorFrameWriter {
  #writtenBytes = 0;
  #terminalWritten = false;

  constructor(
    private readonly response: FrameResponse,
    private readonly controller: AbortController,
  ) {}

  async write(frame: OperatorFrame): Promise<void> {
    if (this.#terminalWritten || this.response.destroyed || this.response.writableEnded) {
      const error = new StreamClosedError();
      this.controller.abort(error);
      throw error;
    }
    const line = serializeOperatorFrame(frame);
    const bytes = Buffer.byteLength(line, "utf8");
    const isTerminal = frame.type === "completed" || frame.type === "error";
    const limit = isTerminal
      ? OPERATOR_LIMITS.streamBytes
      : OPERATOR_LIMITS.streamBytes - TERMINAL_FRAME_RESERVE_BYTES;
    if (this.#writtenBytes + bytes > limit) {
      this.#writeStreamLimit(frame.turnId);
    }
    this.#writtenBytes += bytes;
    this.#terminalWritten = isTerminal;
    if (this.response.write(line)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.response.off("drain", onDrain);
        this.response.off("close", onClose);
        this.response.off("error", onError);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onClose = (): void => {
        cleanup();
        const error = new StreamClosedError();
        this.controller.abort(error);
        reject(error);
      };
      const onError = (): void => {
        cleanup();
        const error = new StreamClosedError();
        this.controller.abort(error);
        reject(error);
      };
      this.response.once("drain", onDrain);
      this.response.once("close", onClose);
      this.response.once("error", onError);
    });
  }

  #writeStreamLimit(turnId: string | undefined): never {
    const error = new StreamLimitError();
    const frame: OperatorErrorFrame = {
      type: "error",
      ...(turnId === undefined ? {} : { turnId }),
      error: {
        code: "stream_limit",
        message: "The operator stream exceeded its byte limit.",
        retryable: false,
      },
      cancelled: false,
      finishedAt: new Date().toISOString(),
    };
    const line = serializeOperatorFrame(frame);
    const bytes = Buffer.byteLength(line, "utf8");
    this.controller.abort(error);
    if (
      !this.response.destroyed
      && !this.response.writableEnded
      && this.#writtenBytes + bytes <= OPERATOR_LIMITS.streamBytes
    ) {
      this.#writtenBytes += bytes;
      this.#terminalWritten = true;
      try {
        this.response.write(line);
      } catch {
        // The stream-limit abort remains authoritative if the socket closed.
      }
    }
    throw error;
  }
}
