// SPDX-License-Identifier: MIT
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import type { SandboxProcess } from "@mono-agent/module-sdk/internal";

import { SandboxSrtError } from "./errors.js";

export interface StreamingSandboxProcessOptions {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly start: (
    started: (child: ChildProcessWithoutNullStreams) => void,
  ) => Promise<void>;
}

type ProcessSignal = NodeJS.Signals;
type InputCallback = (error?: Error | null) => void;
const SIGKILL_GRACE_MS = 100;

class ForwardingSandboxInput extends Writable {
  readonly #maxBytes: number;
  readonly #onFailure: (error: Error) => void;
  #child: NodeJS.WritableStream | undefined;
  #pending:
    | { readonly kind: "write"; readonly chunk: Buffer; readonly callback: InputCallback }
    | { readonly kind: "final"; readonly callback: InputCallback }
    | undefined;
  #active: InputCallback | undefined;
  #bytes = 0;
  #failure: Error | undefined;

  constructor(maxBytes: number, onFailure: (error: Error) => void) {
    super({ highWaterMark: Math.max(1, Math.min(maxBytes, 16_384)) });
    this.#maxBytes = maxBytes;
    this.#onFailure = onFailure;
    this.on("error", () => {
      // The process-level error is the authoritative failure.
    });
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: InputCallback,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.#bytes += bytes.byteLength;
    if (this.#bytes > this.#maxBytes) {
      this.#reject(
        new SandboxSrtError(
          "invalid_command",
          `Sandbox stdin exceeded ${String(this.#maxBytes)} bytes.`,
        ),
        callback,
      );
      return;
    }
    if (this.#failure !== undefined) {
      callback(this.#failure);
      return;
    }
    if (this.#child === undefined) {
      this.#pending = { kind: "write", chunk: Buffer.from(bytes), callback };
      return;
    }
    this.#write(this.#child, bytes, callback);
  }

  override _final(callback: InputCallback): void {
    if (this.#failure !== undefined) {
      callback(this.#failure);
      return;
    }
    if (this.#child === undefined) {
      this.#pending = { kind: "final", callback };
      return;
    }
    this.#end(this.#child, callback);
  }

  adopt(child: NodeJS.WritableStream): void {
    if (this.#child !== undefined) {
      throw new SandboxSrtError(
        "execution_failed",
        "SRT process stdin was adopted more than once.",
      );
    }
    this.#child = child;
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending === undefined || this.#failure !== undefined) return;
    if (pending.kind === "write") {
      this.#write(child, pending.chunk, pending.callback);
    } else {
      this.#end(child, pending.callback);
    }
  }

  fail(error: Error, notifyOwner = true): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    if (notifyOwner) this.#onFailure(error);
    const callback = this.#active ?? this.#pending?.callback;
    this.#active = undefined;
    this.#pending = undefined;
    if (callback === undefined) this.destroy(error);
    else callback(error);
  }

  close(): void {
    if (this.#failure !== undefined) return;
    if (this.#active === undefined && this.#pending === undefined) {
      this.destroy();
      return;
    }
    const error = new SandboxSrtError(
      "execution_failed",
      "SRT process closed before sandbox stdin settled.",
    );
    this.fail(error);
  }

  #write(
    child: NodeJS.WritableStream,
    chunk: Buffer,
    callback: InputCallback,
  ): void {
    this.#active = callback;
    try {
      child.write(chunk, (error) => this.#complete(callback, error));
    } catch (error) {
      this.#complete(
        callback,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  #end(child: NodeJS.WritableStream, callback: InputCallback): void {
    this.#active = callback;
    try {
      child.end((error?: Error | null) => this.#complete(callback, error));
    } catch (error) {
      this.#complete(
        callback,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  #complete(callback: InputCallback, error?: Error | null): void {
    if (this.#active !== callback) return;
    this.#active = undefined;
    if (error == null) callback();
    else this.#reject(error, callback);
  }

  #reject(error: Error, callback: InputCallback): void {
    if (this.#failure === undefined) {
      this.#failure = error;
      this.#onFailure(error);
    }
    callback(error);
  }
}

export class StreamingSandboxProcess
  extends EventEmitter
  implements SandboxProcess {
  readonly stdin: ForwardingSandboxInput;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly done: Promise<void>;

  readonly #options: StreamingSandboxProcessOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #outputBytes = 0;
  #failure: Error | undefined;
  #requestedSignal: ProcessSignal | undefined;
  #killTimer: NodeJS.Timeout | undefined;
  #settled = false;
  #resolveDone!: () => void;

  constructor(options: StreamingSandboxProcessOptions) {
    super();
    this.#options = options;
    this.stdin = new ForwardingSandboxInput(
      options.maxInputBytes,
      (error) => this.#fail(error),
    );
    this.done = new Promise<void>((resolve) => {
      this.#resolveDone = resolve;
    });
    setImmediate(() => {
      void this.#start();
    });
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  override once(
    event: "error" | "close",
    listener: ((error: Error) => void)
      | ((code: number | null, signal: ProcessSignal | null) => void),
  ): this {
    return super.once(event, listener);
  }

  kill(signal: ProcessSignal = "SIGTERM"): boolean {
    if (this.#settled) return false;
    this.#requestedSignal = signal;
    if (this.#child !== undefined) this.#beginTermination(signal);
    return true;
  }

  async #start(): Promise<void> {
    try {
      await this.#options.start((child) => this.#attach(child));
      if (this.#child === undefined && !this.#settled) {
        throw new SandboxSrtError(
          "execution_failed",
          "SRT process start completed without a child.",
        );
      }
    } catch (error) {
      this.#fail(error instanceof Error
        ? error
        : new SandboxSrtError("execution_failed", "SRT process could not be started."));
      if (this.#child === undefined) this.#settle(null, null);
    }
  }

  #attach(child: ChildProcessWithoutNullStreams): void {
    if (this.#child !== undefined) {
      terminate(child, "SIGKILL");
      throw new SandboxSrtError(
        "execution_failed",
        "SRT process start returned more than one child.",
      );
    }
    if (this.#settled) {
      terminate(child, this.#requestedSignal ?? "SIGTERM");
      return;
    }
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      this.#acceptOutput(this.stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.#acceptOutput(this.stderr, chunk);
    });
    child.stdout.once("error", (error) => this.#fail(error));
    child.stderr.once("error", (error) => this.#fail(error));
    child.stdin.on("error", (error) => {
      this.stdin.fail(error);
    });
    child.once("error", (error) => this.#fail(error));
    child.once("close", (code, signal) => {
      terminate(child, "SIGKILL");
      this.#settle(code, signal);
    });
    this.stdin.adopt(child.stdin);
    if (this.#requestedSignal !== undefined) {
      this.#beginTermination(this.#requestedSignal);
    }
  }

  #acceptOutput(target: PassThrough, chunk: Buffer): void {
    if (this.#settled || this.#failure !== undefined) return;
    this.#outputBytes += chunk.byteLength;
    if (this.#outputBytes > this.#options.maxOutputBytes) {
      this.#fail(new SandboxSrtError(
        "output_limit_exceeded",
        `Sandbox output exceeded ${String(this.#options.maxOutputBytes)} bytes.`,
      ));
      return;
    }
    target.write(chunk);
  }

  #fail(error: Error): void {
    if (this.#failure !== undefined || this.#settled) return;
    this.#failure = error;
    this.stdin.fail(error, false);
    this.emit("error", error);
    if (this.#child !== undefined) this.#beginTermination("SIGTERM");
    else this.#requestedSignal = "SIGTERM";
  }

  #beginTermination(signal: ProcessSignal): void {
    const child = this.#child;
    if (child === undefined) {
      this.#requestedSignal = signal;
      return;
    }
    terminate(child, signal);
    if (signal === "SIGKILL" || this.#killTimer !== undefined) return;
    this.#killTimer = setTimeout(() => terminate(child, "SIGKILL"), SIGKILL_GRACE_MS);
    this.#killTimer.unref();
  }

  #settle(code: number | null, signal: ProcessSignal | null): void {
    if (this.#settled) return;
    this.stdin.close();
    this.#settled = true;
    if (this.#killTimer !== undefined) clearTimeout(this.#killTimer);
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
    this.#resolveDone();
  }
}

function terminate(
  child: ChildProcessWithoutNullStreams,
  signal: ProcessSignal,
): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child.
    }
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    // The close event remains authoritative.
  }
}
