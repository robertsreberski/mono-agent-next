import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  JsonRpcProcess,
  type ProcessLike,
} from "../json-rpc.js";

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

function client(child: FakeRpcChild): JsonRpcProcess {
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
});
