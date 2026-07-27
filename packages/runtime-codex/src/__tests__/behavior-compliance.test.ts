// SPDX-License-Identifier: MIT
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import {
  assertRuntimeBehaviorCompliance,
  type RuntimeBehaviorScenario,
} from "@mono-agent/module-sdk/testing";
import { describe, expect, it } from "vitest";

import { parseRuntimeCodexConfig } from "../config.js";
import { type ProcessLike, type SpawnProcess } from "../json-rpc.js";
import { createRuntimeCodex } from "../runtime.js";

const API_KEY = "codex-behavior-fixture-secret";
const BINARY = "codex-behavior-fixture";
const MODEL = "gpt-5.2-codex";

interface ControlledProcess extends ProcessLike {
  forceClose(): void;
}

class CommandProcess extends EventEmitter implements ControlledProcess {
  readonly pid = 4_201;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  #closed = false;

  constructor(
    private readonly output: {
      readonly stdout?: string;
      readonly stderr?: string;
      readonly code?: number;
    },
    private readonly onClose: () => void,
  ) {
    super();
    this.stdin = new Writable({
      final: (callback) => {
        queueMicrotask(() => this.#close(this.output.code ?? 0, null));
        callback();
      },
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.#closed) return false;
    queueMicrotask(() => this.#close(null, signal));
    return true;
  }

  forceClose(): void {
    this.#close(null, "SIGKILL");
  }

  #close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.stdout.end(this.output.stdout ?? "");
    this.stderr.end(this.output.stderr ?? "");
    this.onClose();
    this.emit("close", code, signal);
  }
}

class AppServerProcess extends EventEmitter implements ControlledProcess {
  readonly pid = 4_202;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  #closed = false;
  #input = "";

  constructor(
    private readonly scenario: RuntimeBehaviorScenario,
    private readonly onActive: () => void,
    private readonly onClose: () => void,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          this.#input += Buffer.from(chunk).toString("utf8");
          this.#readRequests();
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
  }

  trigger(): void {
    if (this.#closed) throw new Error("Codex behavior fixture is already closed");
    if (this.scenario.kind === "process-exit") {
      this.emit("error", new Error(this.scenario.marker));
      return;
    }
    if (this.scenario.kind === "stdin-error") {
      this.stdin.emit("error", new Error(this.scenario.marker));
      return;
    }
    if (this.scenario.kind === "stderr-exit") {
      this.stderr.write(this.scenario.marker);
      this.#close(17, null);
      return;
    }
    throw new Error(`Codex behavior fixture cannot trigger ${this.scenario.kind}`);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.#closed) return false;
    queueMicrotask(() => this.#close(null, signal));
    return true;
  }

  forceClose(): void {
    this.#close(null, "SIGKILL");
  }

  #readRequests(): void {
    while (this.#input.includes("\n")) {
      const newline = this.#input.indexOf("\n");
      const line = this.#input.slice(0, newline);
      this.#input = this.#input.slice(newline + 1);
      if (line.trim() === "") continue;
      this.#handleRequest(JSON.parse(line) as Record<string, unknown>);
    }
  }

  #handleRequest(request: Record<string, unknown>): void {
    const id = request.id;
    if (typeof id !== "number") return;
    if (request.method === "initialize") {
      this.#send({ id, result: { userAgent: "codex-behavior-fixture" } });
      return;
    }
    if (request.method === "config/read") {
      this.#send({ id, result: { config: { mcp_servers: {} } } });
      return;
    }
    if (request.method === "thread/start") {
      this.#send({ id, result: { thread: { id: "behavior-thread" } } });
      return;
    }
    if (request.method === "turn/start") {
      this.#send({ id, result: { turn: { id: "behavior-turn" } } });
      queueMicrotask(() => {
        this.onActive();
        if (this.scenario.kind !== "completed" || this.#closed) return;
        queueMicrotask(() => {
          if (this.#closed) return;
          this.#send({
            method: "item/agentMessage/delta",
            params: {
              threadId: "behavior-thread",
              turnId: "behavior-turn",
              itemId: "behavior-message",
              delta: this.scenario.marker,
            },
          });
          this.#send({
            method: "turn/completed",
            params: {
              threadId: "behavior-thread",
              turn: {
                id: "behavior-turn",
                status: "completed",
                items: [],
              },
            },
          });
        });
      });
      return;
    }
    if (request.method === "turn/interrupt") {
      this.#send({ id, result: {} });
      return;
    }
    throw new Error(`Unexpected Codex app-server request: ${String(request.method)}`);
  }

  #send(value: unknown): void {
    if (!this.#closed) this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  #close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.stdout.end();
    this.stderr.end();
    this.onClose();
    this.emit("close", code, signal);
  }
}

async function waitFor(
  promise: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

describe("runtime-codex behavior compliance", () => {
  it("satisfies the shared process-runtime behavior contract", async () => {
    await expect(assertRuntimeBehaviorCompliance({
      profile: "process",
      secrets: [API_KEY],
      timeoutMs: 5_000,
      async create(scenario, signal) {
        signal.throwIfAborted();
        const root = await realpath(
          await mkdtemp(join(tmpdir(), "runtime-codex-behavior-")),
        );
        await chmod(root, 0o700);
        const workspaceDirectory = join(root, "workspace");
        const dataDirectory = join(root, "data");
        await mkdir(workspaceDirectory, { mode: 0o700 });
        await mkdir(dataDirectory, { mode: 0o700 });

        const liveProcesses = new Set<ControlledProcess>();
        let resolveActive!: () => void;
        const active = new Promise<void>((resolve) => {
          resolveActive = resolve;
        });
        let appServer: AppServerProcess | undefined;
        let appServerLaunches = 0;
        const track = <T extends ControlledProcess>(child: T): T => {
          liveProcesses.add(child);
          return child;
        };
        const spawnProcess: SpawnProcess = (
          command,
          args,
          options,
        ) => {
          if (
            command !== BINARY
            || options.shell !== false
            || options.env.OPENAI_API_KEY !== API_KEY
            || options.env.CODEX_HOME !== join(dataDirectory, "codex-home")
          ) {
            throw new Error("Codex behavior fixture received an invalid launch");
          }
          const remove = (child: ControlledProcess): void => {
            liveProcesses.delete(child);
          };
          if (args[0] === "--version") {
            let child!: CommandProcess;
            child = new CommandProcess(
              { stdout: "codex-cli 0.145.0\n" },
              () => remove(child),
            );
            return track(child);
          }
          if (args[0] === "mcp") {
            let child!: CommandProcess;
            child = new CommandProcess(
              { stdout: "[]\n" },
              () => remove(child),
            );
            return track(child);
          }
          if (args[0] === "app-server" && appServerLaunches++ === 0) {
            let child!: CommandProcess;
            child = new CommandProcess({}, () => remove(child));
            return track(child);
          }
          if (args[0] === "app-server" && appServer === undefined) {
            let child!: AppServerProcess;
            child = new AppServerProcess(
              scenario,
              resolveActive,
              () => remove(child),
            );
            appServer = child;
            return track(child);
          }
          throw new Error(`Unexpected Codex behavior launch: ${args.join(" ")}`);
        };

        const instance = createRuntimeCodex({
          config: parseRuntimeCodexConfig({
            binary: BINARY,
            auth: { apiKey: API_KEY },
            requestTimeoutMs: 1_000,
          }),
          instanceId: `codex-behavior-${scenario.kind}`,
          workspaceDirectory,
          dataDirectory,
          spawnProcess,
        });

        return {
          instance,
          model: MODEL,
          waitUntilActive: async (waitSignal) => waitFor(active, waitSignal),
          ...(scenario.kind === "process-exit"
            || scenario.kind === "stdin-error"
            || scenario.kind === "stderr-exit"
            ? {
                trigger: (triggerSignal: AbortSignal) => {
                  triggerSignal.throwIfAborted();
                  if (appServer === undefined) {
                    throw new Error("Codex app-server did not become active");
                  }
                  appServer.trigger();
                },
              }
            : {}),
          async observe(observeSignal) {
            observeSignal.throwIfAborted();
            const health = await instance.health!({ signal: observeSignal });
            const activeTurns = health.details?.activeTurns;
            return {
              activeProviderOperations:
                typeof activeTurns === "number" ? activeTurns : -1,
              liveProcesses: liveProcesses.size,
            };
          },
          async dispose() {
            for (const child of [...liveProcesses]) child.forceClose();
            await rm(root, { recursive: true, force: true });
          },
        };
      },
    })).resolves.toBeUndefined();
  });
});
