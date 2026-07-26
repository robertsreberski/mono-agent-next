// SPDX-License-Identifier: MIT
import type { SandboxExecutor, SandboxResult } from "@mono-agent/module-sdk/internal";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import {
  RUNTIME_PI_SANDBOX_WORKER_RESPONSE_MAX_BYTES,
  RuntimePiSandboxTools,
} from "../sandbox-tools.js";

const workerSuccess = (): SandboxResult => ({
  exitCode: 0,
  stdout: new TextEncoder().encode(JSON.stringify({
    ok: true,
    result: {
      content: [{ type: "text", text: "Write sandboxed" }],
    },
  })),
  stderr: new Uint8Array(),
  timedOut: false,
});

describe("selected-sandbox Pi tools", () => {
  it("serializes concurrent Writes to the same path across calls", async () => {
    let releaseFirst = (): void => undefined;
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    let active = 0;
    let maximumActive = 0;
    const paths: string[] = [];
    const execute = vi.fn<SandboxExecutor["execute"]>(async (command) => {
      const request = JSON.parse(new TextDecoder().decode(command.stdin)) as {
        readonly params: { readonly path: string };
      };
      paths.push(request.params.path);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (paths.length === 1) await firstGate;
        return workerSuccess();
      } finally {
        active -= 1;
      }
    });
    const executor: SandboxExecutor = {
      execute,
      spawn() {
        throw new Error("spawn is not used by this test");
      },
    };
    const tools = new RuntimePiSandboxTools(executor, "/approved-workspace");
    const target = "/approved-workspace/shared.txt";
    const first = tools.execute(
      "Write",
      { path: target, content: "first" },
      new AbortController().signal,
    );
    const second = tools.execute(
      "Write",
      { path: target, content: "second" },
      new AbortController().signal,
    );

    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    expect(maximumActive).toBe(1);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    expect(paths).toEqual([target, target]);
    expect(maximumActive).toBe(1);
  });

  it("rechecks queued Write cancellation and releases the following slot", async () => {
    let releaseFirst = (): void => undefined;
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    let calls = 0;
    const execute = vi.fn<SandboxExecutor["execute"]>(async () => {
      calls += 1;
      if (calls === 1) await firstGate;
      return workerSuccess();
    });
    const executor: SandboxExecutor = {
      execute,
      spawn() {
        throw new Error("spawn is not used by this test");
      },
    };
    const tools = new RuntimePiSandboxTools(executor, "/approved-workspace");
    const first = tools.execute(
      "Write",
      { path: "/approved-workspace/shared.txt", content: "first" },
      new AbortController().signal,
    );
    const cancellation = new AbortController();
    const cancelled = tools.execute(
      "Write",
      { path: "/approved-workspace/shared.txt", content: "cancelled" },
      cancellation.signal,
    );
    const cancelledOutcome = cancelled.then(
      () => new Error("queued Write unexpectedly resolved"),
      (error: unknown) => error,
    );

    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledTimes(1);
    });
    cancellation.abort(new Error("cancelled while queued"));
    const cancellationResult = await Promise.race([
      cancelledOutcome,
      delay(100).then(() =>
        new Error("queued Write cancellation did not settle promptly")),
    ]);
    expect(cancellationResult).toBeInstanceOf(Error);
    expect((cancellationResult as Error).message).toBe("cancelled while queued");
    const third = tools.execute(
      "Write",
      { path: "/approved-workspace/shared.txt", content: "third" },
      new AbortController().signal,
    );
    await delay(10);
    expect(execute).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;
    await expect(third).resolves.toMatchObject({
      content: [{ type: "text", text: "Write sandboxed" }],
    });

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("accepts the bounded worker envelope and rejects one byte beyond it", async () => {
    const emptyResponse = JSON.stringify({
      ok: true,
      result: { content: [{ type: "text", text: "" }] },
    });
    const payload = "x".repeat(
      RUNTIME_PI_SANDBOX_WORKER_RESPONSE_MAX_BYTES
        - Buffer.byteLength(emptyResponse, "utf8"),
    );
    const accepted = new TextEncoder().encode(JSON.stringify({
      ok: true,
      result: { content: [{ type: "text", text: payload }] },
    }));
    expect(accepted.byteLength)
      .toBe(RUNTIME_PI_SANDBOX_WORKER_RESPONSE_MAX_BYTES);
    const execute = vi.fn<SandboxExecutor["execute"]>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: accepted,
        stderr: new Uint8Array(),
        timedOut: false,
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: new Uint8Array(
          RUNTIME_PI_SANDBOX_WORKER_RESPONSE_MAX_BYTES + 1,
        ),
        stderr: new Uint8Array(),
        timedOut: false,
      });
    const tools = new RuntimePiSandboxTools({
      execute,
      spawn() {
        throw new Error("spawn is not used by this test");
      },
    }, "/approved-workspace");

    await expect(tools.execute(
      "Read",
      { path: "/approved-workspace/image.jpg" },
      new AbortController().signal,
    )).resolves.toMatchObject({
      content: [{ type: "text", text: payload }],
    });
    await expect(tools.execute(
      "Read",
      { path: "/approved-workspace/image.jpg" },
      new AbortController().signal,
    )).rejects.toThrow("returned an invalid response");
  });
});
