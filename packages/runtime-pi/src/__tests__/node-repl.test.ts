// SPDX-License-Identifier: MIT
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import type { SandboxProcess } from "@mono-agent/module-sdk/internal";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createNodeReplController } from "../node-repl.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runtime-pi-node-repl-"));
  roots.push(root);
  return root;
}

describe("run-scoped Node REPL", () => {
  it("retains state across multiline and top-level-await evaluations", async () => {
    const root = await workspace();
    const dependency = join(root, "node_modules", "local-value");
    await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, "index.js"), "module.exports = 41;\n");
    const controller = createNodeReplController(root);

    try {
      await expect(controller.execute({
        code: "const state = {\n  answer: require('local-value')\n};",
      })).resolves.toBe("undefined");
      await expect(controller.execute({
        code: "await Promise.resolve(state.answer + 1)",
      })).resolves.toBe("42");
      await expect(controller.execute({ code: "_" })).resolves.toBe("42");
      await expect(controller.execute({
        code: "console.log('visible'); state.answer",
      })).resolves.toBe("visible\n41");
    } finally {
      await controller.close();
    }
  });

  it("preserves _error and existing state after an evaluated exception", async () => {
    const controller = createNodeReplController(await workspace());

    try {
      await controller.execute({ code: "let retained = 7" });
      await expect(controller.execute({
        code: "throw new Error('boom')",
      })).rejects.toThrow("Uncaught Error: boom");
      await expect(controller.execute({
        code: "`${_error.message}:${retained}`",
      })).resolves.toBe("'boom:7'");
    } finally {
      await controller.close();
    }
  });

  it("kills and replaces the child after cancellation", async () => {
    const controller = createNodeReplController(await workspace());
    const cancellation = new AbortController();
    setTimeout(() => cancellation.abort(), 50);

    try {
      await expect(controller.execute(
        { code: "while (true) {}" },
        { signal: cancellation.signal },
      )).rejects.toThrow("Session state was reset");
      await expect(controller.execute({
        code: "typeof retained",
      })).resolves.toBe("'undefined'");
    } finally {
      await controller.close();
    }
  });

  it("bounds output and resets the state after overflow", async () => {
    const controller = createNodeReplController(await workspace());

    try {
      await controller.execute({ code: "globalThis.retained = 1" });
      await expect(controller.execute({
        code: "process.stdout.write('x'.repeat(300000)); 1",
      })).rejects.toThrow("output exceeded 262144 bytes");
      await expect(controller.execute({
        code: "typeof retained",
      })).resolves.toBe("'undefined'");
    } finally {
      await controller.close();
    }
  });

  it("preserves inherited-child stdout without corrupting retained state", async () => {
    const controller = createNodeReplController(await workspace());

    try {
      await controller.execute({ code: "let retained = 41" });
      await expect(controller.execute({
        code: [
          "require('node:child_process').spawnSync(",
          "  process.execPath,",
          "  ['-e', \"process.stdout.write('child-output\\\\n')\"],",
          "  { stdio: 'inherit' },",
          ");",
          "retained + 1",
        ].join("\n"),
      })).resolves.toBe("STDOUT:\nchild-output\n42");
      await expect(controller.execute({ code: "retained" })).resolves.toBe("41");
    } finally {
      await controller.close();
    }
  });

  it("bounds inherited-child stdout and resets state after overflow", async () => {
    const controller = createNodeReplController(await workspace());

    try {
      await controller.execute({ code: "globalThis.retained = 1" });
      await expect(controller.execute({
        code: [
          "require('node:child_process').spawnSync(",
          "  process.execPath,",
          "  ['-e', \"process.stdout.write('x'.repeat(300000))\"],",
          "  { stdio: 'inherit' },",
          ");",
          "retained",
        ].join("\n"),
      })).rejects.toThrow("output exceeded 262144 bytes");
      await expect(controller.execute({ code: "typeof retained" }))
        .resolves.toBe("'undefined'");
    } finally {
      await controller.close();
    }
  });

  it("carries delayed stdout into the next response without losing state", async () => {
    const controller = createNodeReplController(await workspace());

    try {
      await expect(controller.execute({
        code: [
          "globalThis.retained = 7;",
          "setTimeout(() => process.stdout.write('late-output\\n'), 20);",
          "retained",
        ].join("\n"),
      })).resolves.toBe("7");
      await delay(50);
      await expect(controller.execute({ code: "retained + 1" }))
        .resolves.toBe("STDOUT:\nlate-output\n8");
      await expect(controller.execute({ code: "retained" })).resolves.toBe("7");
    } finally {
      await controller.close();
    }
  });

  it("terminates a pid-bearing selected process only through its sandbox facade", async () => {
    const events = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const kill = vi.fn((signal: NodeJS.Signals | number = "SIGTERM") => {
      queueMicrotask(() => {
        stdout.end();
        stderr.end();
        events.emit("close", null, signal);
      });
      return true;
    });
    let buffered = "";
    stdin.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffered.slice(0, newline)) as { readonly id: string };
      queueMicrotask(() => stdout.write(
        `\u001eMONO_AGENT_NODE_REPL_V1:${JSON.stringify({
          type: "result",
          id: request.id,
          ok: true,
          text: "sandboxed",
        })}\n`,
      ));
    });
    const selectedProcess: SandboxProcess = {
      pid: 424_242,
      stdin,
      stdout,
      stderr,
      once(event, listener) {
        events.once(event, listener);
        return this;
      },
      kill,
    };
    const hostKill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("selected process must not use host process.kill");
    });
    const controller = createNodeReplController(await workspace(), {
      spawnProcess: () => selectedProcess,
    });

    await expect(controller.execute({ code: "1 + 1" })).resolves.toBe("sandboxed");
    await controller.close();

    expect(hostKill).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("bounds failed selected-process reaping and quarantines the controller", async () => {
    const events = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const kill = vi.fn((_signal: NodeJS.Signals | number = "SIGTERM") => true);
    let receivedInput = false;
    stdin.on("data", () => {
      receivedInput = true;
    });
    const selectedProcess: SandboxProcess = {
      pid: 424_243,
      stdin,
      stdout,
      stderr,
      once(event, listener) {
        events.once(event, listener);
        return this;
      },
      kill,
    };
    const controller = createNodeReplController(await workspace(), {
      spawnProcess: () => selectedProcess,
      terminationGraceMs: 5,
    });
    const cancellation = new AbortController();
    const evaluation = controller.execute(
      { code: "new Promise(() => undefined)" },
      { signal: cancellation.signal },
    );
    await vi.waitFor(() => {
      expect(receivedInput).toBe(true);
    });

    cancellation.abort(new Error("cancel stubborn REPL"));
    await expect(Promise.race([
      evaluation,
      delay(500).then(() => {
        throw new Error("stubborn Node REPL evaluation did not settle");
      }),
    ])).rejects.toThrow("did not close after SIGKILL");
    expect(kill.mock.calls.map(([signal]) => signal))
      .toEqual(["SIGTERM", "SIGKILL"]);
    await expect(controller.execute({ code: "1 + 1" }))
      .rejects.toThrow("controller is quarantined");
    await expect(controller.close())
      .rejects.toThrow("controller is quarantined");
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it("bounds input before child creation and refuses use after run settlement", async () => {
    const controller = createNodeReplController(await workspace());

    await expect(controller.execute({
      code: "x".repeat(256 * 1024 + 1),
    })).rejects.toThrow("code exceeds 262144 bytes");
    await controller.close();
    await expect(controller.execute({ code: "1 + 1" }))
      .rejects.toThrow("run has already ended");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["malformed", {}],
  ])("fails closed when the selected sandbox returns %s", async (_name, value) => {
    const controller = createNodeReplController(await workspace(), {
      spawnProcess: () => value as never,
    });

    await expect(controller.execute({ code: "process.pid" }))
      .rejects.toThrow("Selected sandbox returned an invalid Node REPL process facade");
    await controller.close();
  });
});
