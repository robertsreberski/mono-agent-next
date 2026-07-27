// SPDX-License-Identifier: MIT
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";

import type {
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  SandboxExecutor,
  SandboxProcess,
  SandboxProcessInput,
  SandboxProcessOutput,
} from "@mono-agent/module-sdk/internal";

import type { ProcessLike, SpawnProcess } from "./cli.js";

export function claudeSandboxSpawn(
  executor: SandboxExecutor,
): SpawnProcess {
  return (command, args, options): ProcessLike => {
    const environment: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [name, value] of Object.entries(options.env)) {
      if (value !== undefined) environment[name] = value;
    }
    return executor.spawn({
      command,
      arguments: Object.freeze([...args]),
      workingDirectory: options.cwd,
      environment: Object.freeze(environment),
    }) as unknown as ProcessLike;
  };
}

export function claudeSdkSandboxSpawn(
  executor: SandboxExecutor,
): (options: SpawnOptions) => SpawnedProcess {
  return (options) => {
    if (!isAbsolute(options.command)) {
      throw new TypeError(
        "Claude Agent SDK sandbox command must be an absolute path",
      );
    }
    if (options.cwd === undefined || !isAbsolute(options.cwd)) {
      throw new TypeError(
        "Claude Agent SDK sandbox working directory must be an absolute path",
      );
    }
    const environment: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [name, value] of Object.entries(options.env)) {
      if (value !== undefined) environment[name] = value;
    }
    return new ClaudeSdkSandboxProcess(
      executor.spawn({
        command: options.command,
        arguments: Object.freeze([...options.args]),
        workingDirectory: options.cwd,
        environment: Object.freeze(environment),
      }),
      options.signal,
    );
  };
}

type StreamCallback = (error?: Error | null) => void;

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

class ClaudeSdkSandboxInput extends Writable {
  readonly #input: SandboxProcessInput;
  #active: StreamCallback | undefined;
  #failure: Error | undefined;

  constructor(
    input: SandboxProcessInput,
    onError: (error: Error) => void,
  ) {
    super();
    this.#input = input;
    this.on("error", onError);
    input.on("error", (error) => this.#fail(error));
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: StreamCallback,
  ): void {
    if (this.#failure !== undefined) {
      callback(this.#failure);
      return;
    }
    const bytes = Buffer.isBuffer(chunk)
      ? Buffer.from(chunk)
      : Buffer.from(chunk, encoding);
    this.#delegate(callback, (done) => {
      this.#input.write(bytes, done);
    });
  }

  override _final(callback: StreamCallback): void {
    if (this.#failure !== undefined) {
      callback(this.#failure);
      return;
    }
    this.#delegate(callback, (done) => {
      this.#input.end(() => done());
    });
  }

  #delegate(
    callback: StreamCallback,
    operation: (done: StreamCallback) => void,
  ): void {
    this.#active = callback;
    const done: StreamCallback = (error) => {
      if (this.#active !== callback) return;
      this.#active = undefined;
      callback(error);
    };
    try {
      operation(done);
    } catch (error) {
      done(errorOf(error));
    }
  }

  #fail(error: Error): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    const active = this.#active;
    if (active === undefined) {
      this.destroy(error);
      return;
    }
    this.#active = undefined;
    active(error);
  }
}

class ClaudeSdkSandboxOutput extends Readable {
  #finished = false;

  constructor(
    output: SandboxProcessOutput,
    onError: (error: Error) => void,
  ) {
    super();
    this.on("error", onError);
    output.on("data", (chunk) => {
      if (this.#finished || this.destroyed) return;
      this.push(Buffer.from(chunk));
    });
    output.on("error", (error) => this.destroy(error));
  }

  override _read(): void {
    // The sandbox facade owns its bounded producer and has no pause surface.
  }

  finish(): void {
    if (this.#finished || this.destroyed) return;
    this.#finished = true;
    this.push(null);
  }
}

class ClaudeSdkSandboxProcess
  extends EventEmitter
  implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: ClaudeSdkSandboxOutput;

  readonly #process: SandboxProcess;
  readonly #signal: AbortSignal;
  readonly #onAbort: () => void;
  #exitCode: number | null = null;
  #killed = false;
  #reportedError: Error | undefined;

  constructor(process: SandboxProcess, signal: AbortSignal) {
    super();
    this.on("error", () => {
      // Keep transport failures owned until the SDK registers its listener.
    });
    this.#process = process;
    this.#signal = signal;
    this.stdin = new ClaudeSdkSandboxInput(
      process.stdin,
      (error) => this.#reportError(error),
    );
    this.stdout = new ClaudeSdkSandboxOutput(
      process.stdout,
      (error) => this.#reportError(error),
    );
    this.#onAbort = () => {
      this.kill("SIGTERM");
    };
    process.stderr.on("data", () => {
      // SRT owns the bounded stderr budget; the SDK seam has no stderr stream.
    });
    process.stderr.on("error", (error) => this.#reportError(error));
    process.once("error", (error) => this.#reportError(error));
    process.once("close", (code, closedSignal) => {
      this.#exitCode = code;
      this.#signal.removeEventListener("abort", this.#onAbort);
      this.stdout.finish();
      this.stdin.destroy();
      this.emit("exit", code, closedSignal);
    });
    if (signal.aborted) this.#onAbort();
    else signal.addEventListener("abort", this.#onAbort, { once: true });
  }

  get killed(): boolean {
    return this.#killed;
  }

  get exitCode(): number | null {
    return this.#exitCode;
  }

  kill(signal: NodeJS.Signals): boolean {
    const killed = this.#process.kill(signal);
    if (killed) this.#killed = true;
    return killed;
  }

  #reportError(error: Error): void {
    if (this.#reportedError !== undefined) return;
    this.#reportedError = error;
    this.emit("error", error);
  }
}
