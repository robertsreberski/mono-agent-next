// SPDX-License-Identifier: MIT
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import {
  assertRuntimeBehaviorCompliance,
  type RuntimeBehaviorScenario,
} from "@mono-agent/module-sdk/testing";
import { describe, expect, it } from "vitest";

import { type ProcessLike, type SpawnProcess } from "../cli.js";
import { parseRuntimeClaudeConfig } from "../config.js";
import { createRuntimeClaude } from "../runtime.js";

const SECRET = "claude-conformance-api-key";

class ComplianceClaudeProcess extends EventEmitter implements ProcessLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly closed: Promise<void>;
  #closed = false;
  #resolveClosed!: () => void;

  constructor(private readonly scenario: RuntimeBehaviorScenario) {
    super();
    this.closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
    this.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final: (callback) => {
        callback();
        if (scenario.kind === "completed") {
          queueMicrotask(() => this.#complete());
        }
      },
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    queueMicrotask(() => this.#close(null, signal));
    return true;
  }

  async trigger(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.scenario.kind === "process-exit") {
      this.emit("error", new Error(this.scenario.marker));
    } else if (this.scenario.kind === "stdin-error") {
      this.stdin.emit("error", new Error(this.scenario.marker));
    } else if (this.scenario.kind === "stderr-exit") {
      this.stderr.write(this.scenario.marker);
      this.#close(7, null);
    } else {
      throw new Error(`Claude scenario ${this.scenario.kind} has no trigger`);
    }
    await this.closed;
  }

  #complete(): void {
    const sessionId = `claude-compliance-${this.scenario.kind}`;
    this.stdout.write(`${JSON.stringify({
      type: "stream_event",
      session_id: sessionId,
      event: {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: this.scenario.marker,
        },
      },
    })}\n`);
    this.stdout.write(`${JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: this.scenario.marker,
    })}\n`);
    this.#close(0, null);
  }

  #close(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.#closed) return;
    this.#closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
    this.#resolveClosed();
  }
}

async function waitForLaunch(
  launched: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  let rejectAborted!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = (): void => {
    rejectAborted(
      signal.reason ?? new DOMException("Aborted", "AbortError"),
    );
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([launched, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

describe("runtime-claude behavior compliance", () => {
  it("passes the shared process-runtime behavior contract", async () => {
    await assertRuntimeBehaviorCompliance({
      profile: "process",
      secrets: [SECRET],
      timeoutMs: 5_000,
      create(scenario) {
        let child: ComplianceClaudeProcess | undefined;
        let resolveLaunched!: () => void;
        const launched = new Promise<void>((resolve) => {
          resolveLaunched = resolve;
        });
        const liveProcesses = new Set<ComplianceClaudeProcess>();
        const spawnProcess: SpawnProcess = (command, args, options) => {
          expect(command).toBe("claude-conformance");
          expect(args).toContain("--print");
          expect(args).toContain("claude-sonnet-4-6");
          expect(options).toMatchObject({
            env: { ANTHROPIC_API_KEY: SECRET },
            shell: false,
          });
          const spawned = new ComplianceClaudeProcess(scenario);
          child = spawned;
          liveProcesses.add(spawned);
          spawned.once("close", () => {
            liveProcesses.delete(spawned);
          });
          resolveLaunched();
          return spawned;
        };
        const instance = createRuntimeClaude({
          config: parseRuntimeClaudeConfig({
            mode: "cli",
            binary: "claude-conformance",
            auth: {
              method: "api-key",
              token: SECRET,
            },
            timeoutMs: 5_000,
          }),
          instanceId: `claude-compliance-${scenario.kind}`,
          workspaceDirectory: process.cwd(),
          spawnProcess,
          terminationGraceMs: 100,
        });

        return {
          instance,
          model: "claude-sonnet-4-6",
          waitUntilActive(signal: AbortSignal) {
            return waitForLaunch(launched, signal);
          },
          ...(scenario.kind === "completed"
            || scenario.kind === "cancelled"
            ? {}
            : {
                async trigger(signal: AbortSignal) {
                  if (child === undefined) {
                    throw new Error("Claude conformance process did not launch");
                  }
                  await child.trigger(signal);
                },
              }),
          async observe(signal: AbortSignal) {
            const health = await instance.health?.({ signal });
            const activeTurns = health?.details?.activeTurns;
            if (typeof activeTurns !== "number") {
              throw new Error(
                "Claude conformance health omitted active turn ownership",
              );
            }
            return {
              activeProviderOperations: activeTurns,
              liveProcesses: liveProcesses.size,
            };
          },
          async dispose() {
            if (child !== undefined && liveProcesses.has(child)) {
              child.kill("SIGTERM");
              await child.closed;
            }
          },
        };
      },
    });
  });
});
