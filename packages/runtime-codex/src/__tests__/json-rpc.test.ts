// SPDX-License-Identifier: MIT
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import type {
  SandboxExecutor,
  SandboxProcess,
  SandboxProcessInput,
  SandboxProcessOutput,
} from "@mono-agent/module-sdk/internal";
import { describe, expect, it, vi } from "vitest";

import {
  JsonRpcProcess,
  type ProcessLike,
} from "../json-rpc.js";
import { codexSandboxSpawn } from "../sandbox.js";

class FakeRpcChild extends EventEmitter implements ProcessLike {
  readonly pid = 9876;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly writes: Record<string, unknown>[] = [];
  killed = false;

  constructor() {
    super();
    let input = "";
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        input += String(chunk);
        while (input.includes("\n")) {
          const newline = input.indexOf("\n");
          const line = input.slice(0, newline);
          input = input.slice(newline + 1);
          this.writes.push(JSON.parse(line) as Record<string, unknown>);
        }
        callback();
      },
    });
  }

  send(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, signal ?? "SIGTERM"));
    return true;
  }
}

class MinimalSandboxOutput
  extends EventEmitter
  implements SandboxProcessOutput {
  override on(
    event: "data" | "error",
    listener: ((chunk: Uint8Array) => void) | ((error: Error) => void),
  ): this {
    return super.on(event, listener);
  }
}

class MinimalSandboxInput
  extends EventEmitter
  implements SandboxProcessInput {
  readonly #output: MinimalSandboxOutput;
  readonly #failingOutput: MinimalSandboxOutput | undefined;
  readonly #failureMessage: string | undefined;

  constructor(
    output: MinimalSandboxOutput,
    failingOutput?: MinimalSandboxOutput,
    failureMessage?: string,
  ) {
    super();
    this.#output = output;
    this.#failingOutput = failingOutput;
    this.#failureMessage = failureMessage;
  }

  write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void): boolean;
  write(
    chunk: string,
    encoding: BufferEncoding,
    callback?: (error?: Error | null) => void,
  ): boolean;
  write(
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const settled = typeof encodingOrCallback === "function"
      ? encodingOrCallback
      : callback;
    const request = JSON.parse(String(chunk)) as { readonly id?: unknown };
    queueMicrotask(() => {
      settled?.();
      if (
        this.#failingOutput !== undefined
        && this.#failureMessage !== undefined
      ) {
        this.#failingOutput.emit("error", new Error(this.#failureMessage));
        return;
      }
      this.#output.emit("data", Buffer.from(JSON.stringify({
        id: request.id,
        result: { sandbox: "minimal-facade" },
      }) + "\n"));
    });
    return true;
  }

  end(callback?: () => void): this;
  end(chunk: string | Uint8Array, callback?: () => void): this;
  end(chunk: string, encoding: BufferEncoding, callback?: () => void): this;
  end(
    chunkOrCallback?: string | Uint8Array | (() => void),
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): this {
    const settled = typeof chunkOrCallback === "function"
      ? chunkOrCallback
      : typeof encodingOrCallback === "function"
        ? encodingOrCallback
        : callback;
    queueMicrotask(() => settled?.());
    return this;
  }
}

class MinimalSandboxProcess
  extends EventEmitter
  implements SandboxProcess {
  readonly pid = undefined;
  readonly stdout = new MinimalSandboxOutput();
  readonly stderr = new MinimalSandboxOutput();
  readonly stdin: MinimalSandboxInput;

  constructor(failingStream?: "stdout" | "stderr") {
    super();
    this.stdin = new MinimalSandboxInput(
      this.stdout,
      failingStream === undefined ? undefined : this[failingStream],
      failingStream === undefined
        ? undefined
        : `minimal sandbox ${failingStream} failed`,
    );
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}

class ThrowingCleanupProcess extends EventEmitter implements ProcessLike {
  readonly pid = 9_876;
  readonly stdout = new MinimalSandboxOutput();
  readonly stderr = new MinimalSandboxOutput();
  readonly stdin: Writable;
  readonly killSignals: NodeJS.Signals[] = [];

  constructor() {
    super();
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    stdin.end = (() => {
      throw new Error("stdin end threw");
    }) as Writable["end"];
    this.stdin = stdin;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    if (signal === "SIGKILL") {
      queueMicrotask(() => this.emit("close", null, signal));
    }
    throw new Error(`${signal} threw`);
  }
}

function client(child: ProcessLike): JsonRpcProcess {
  return new JsonRpcProcess({
    command: "codex",
    args: ["app-server"],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 1_000,
    maxLineBytes: 64_000,
    maxStderrBytes: 4_000,
    spawnProcess: () => child,
  });
}

describe("JsonRpcProcess server requests", () => {
  it("uses the exact callback-bearing sandbox facade without Node streams", async () => {
    const child = new MinimalSandboxProcess();
    const spawn = vi.fn<SandboxExecutor["spawn"]>(() => child);
    const rpc = new JsonRpcProcess({
      command: "/absolute/codex",
      args: ["app-server"],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 1_000,
      maxLineBytes: 64_000,
      maxStderrBytes: 4_000,
      spawnProcess: codexSandboxSpawn({
        async execute() {
          throw new Error("one-shot execution is not expected");
        },
        spawn,
      }),
    });

    await expect(rpc.request("initialize", {})).resolves.toEqual({
      sandbox: "minimal-facade",
    });
    expect(spawn).toHaveBeenCalledWith({
      command: "/absolute/codex",
      arguments: ["app-server"],
      workingDirectory: process.cwd(),
      environment: {},
    });
    await rpc.close();
  });

  it.each(["stdout", "stderr"] as const)(
    "owns a minimal sandbox %s failure on the persistent JSON-RPC path",
    async (stream) => {
      const child = new MinimalSandboxProcess(stream);
      const rpc = client(child);

      await expect(rpc.request("initialize", {})).rejects.toThrow(
        `minimal sandbox ${stream} failed`,
      );
      await rpc.close();
    },
  );

  it("continues bounded TERM/KILL cleanup when facade end and kill throw", async () => {
    vi.useFakeTimers();
    try {
      const child = new ThrowingCleanupProcess();
      const closing = client(child).close();

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(closing).resolves.toBeUndefined();
      expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes provider requests so approval authority cannot race", async () => {
    const child = new FakeRpcChild();
    const rpc = client(child);
    const observed: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    rpc.handleServerRequests(async (request) => {
      observed.push(String(request.id));
      if (request.id === "first") await first;
      return { decision: "decline" };
    });

    child.send({ id: "first", method: "approval", params: {} });
    child.send({ id: "second", method: "approval", params: {} });
    await vi.waitFor(() => expect(observed).toEqual(["first"]));
    expect(child.writes).toEqual([]);

    releaseFirst();
    await vi.waitFor(() => expect(observed).toEqual(["first", "second"]));
    await vi.waitFor(() => expect(child.writes).toEqual([
      { id: "first", result: { decision: "decline" } },
      { id: "second", result: { decision: "decline" } },
    ]));
    await rpc.close();
  });

  it("kills the transport when the bounded provider-request queue overflows", async () => {
    const child = new FakeRpcChild();
    const rpc = client(child);
    const closed: string[] = [];
    rpc.subscribe((message) => {
      if (
        message.method === "$transport/closed"
        && typeof (message.params as { readonly message?: unknown }).message === "string"
      ) {
        closed.push((message.params as { readonly message: string }).message);
      }
    });
    rpc.handleServerRequests(async () => new Promise<never>(() => undefined));

    for (let index = 0; index < 17; index += 1) {
      child.send({
        id: `approval-${index}`,
        method: "item/commandExecution/requestApproval",
        params: {},
      });
    }

    await vi.waitFor(() => expect(child.killed).toBe(true));
    expect(closed).toEqual([
      "Codex app-server exceeded the 16-request server queue limit",
    ]);
  });

  it("fails closed on stdout line overflow", async () => {
    const child = new FakeRpcChild();
    const rpc = client(child);
    const pending = rpc.request("initialize", {});
    await vi.waitFor(() => expect(child.writes).toHaveLength(1));

    child.stdout.write("x".repeat(64_001));

    await expect(pending).rejects.toThrow(
      "Codex app-server output exceeds the configured line limit",
    );
    await vi.waitFor(() => expect(child.killed).toBe(true));
  });

  it("owns an asynchronous stdin failure and rejects the pending request", async () => {
    const child = new FakeRpcChild();
    const rpc = client(child);
    const pending = rpc.request("initialize", {});
    await vi.waitFor(() => expect(child.writes).toHaveLength(1));

    child.stdin.emit("error", new Error("sandbox stdin EPIPE"));

    await expect(pending).rejects.toThrow("sandbox stdin EPIPE");
    await vi.waitFor(() => expect(child.killed).toBe(true));
  });

  it.each(["stdout", "stderr"] as const)(
    "owns an asynchronous %s failure and rejects the pending request",
    async (stream) => {
      const child = new FakeRpcChild();
      const rpc = client(child);
      const pending = rpc.request("initialize", {});
      await vi.waitFor(() => expect(child.writes).toHaveLength(1));

      child[stream].emit("error", new Error(`sandbox ${stream} failed`));

      await expect(pending).rejects.toThrow(`sandbox ${stream} failed`);
      await vi.waitFor(() => expect(child.killed).toBe(true));
    },
  );
});
