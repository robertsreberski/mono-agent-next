import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { createNodeReplController } from "../../agent/tools/node-repl.js";

const tempDirs = [];

function tempWorkspace() {
  const dir = mkdtempSync(resolve("/tmp", "agent-runtime-node-repl-"));
  tempDirs.push(dir);
  return dir;
}

function controllerFor(root, options = {}) {
  return createNodeReplController({
    cwd: root,
    ctx: { workspace: root, sandbox: passthroughSandbox },
    ...options,
  });
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("run-scoped Node REPL controller", () => {
  it("keeps native REPL state across multiline and top-level-await evaluations", async () => {
    const root = tempWorkspace();
    const dependencyRoot = join(root, "node_modules", "local-value");
    mkdirSync(dependencyRoot, { recursive: true });
    writeFileSync(join(dependencyRoot, "index.js"), "module.exports = 41;\n");
    const controller = controllerFor(root);

    try {
      await expect(controller.execute({
        code: "const state = {\n  answer: require('local-value')\n};",
      })).resolves.toBe("undefined");
      await expect(controller.execute({ code: "await Promise.resolve(state.answer + 1)" }))
        .resolves.toBe("42");
      await expect(controller.execute({ code: "_" })).resolves.toBe("42");
      await expect(controller.execute({ code: "console.log('visible'); state.answer" }))
        .resolves.toBe("visible\n41");
    } finally {
      await controller.close();
    }
  });

  it("surfaces JavaScript errors without discarding _error or session state", async () => {
    const controller = controllerFor(tempWorkspace());

    try {
      await controller.execute({ code: "let retained = 7" });
      await expect(controller.execute({ code: "throw new Error('boom')" }))
        .rejects.toThrow("Uncaught Error: boom");
      await expect(controller.execute({ code: "`${_error.message}:${retained}`" }))
        .resolves.toBe("'boom:7'");
    } finally {
      await controller.close();
    }
  });

  it("captures direct stdout/stderr and applies the existing text limit", async () => {
    const controller = controllerFor(tempWorkspace(), { maxOutputChars: 300 });

    try {
      await expect(controller.execute({
        code: "process.stdout.write('out'); process.stderr.write('err'); 'x'.repeat(2000)",
      })).resolves.toMatch(/STDOUT:\nout[\s\S]*STDERR:\nerr[\s\S]*truncated NodeRepl output/u);
    } finally {
      await controller.close();
    }
  });

  it("kills and replaces the session when execution is aborted", async () => {
    const controller = controllerFor(tempWorkspace());
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), 50);

    try {
      await expect(controller.execute({ code: "while (true) {}" }, { signal: abortController.signal }))
        .rejects.toThrow("Session state was reset");
      await expect(controller.execute({ code: "typeof retained" })).resolves.toBe("'undefined'");
    } finally {
      await controller.close();
    }
  });

  it("restarts cleanly after evaluated code exits the child", async () => {
    const controller = controllerFor(tempWorkspace());

    try {
      await controller.execute({ code: "globalThis.beforeExit = 1" });
      await expect(controller.execute({ code: "process.exit(0)" }))
        .rejects.toThrow("Session state was reset");
      await expect(controller.execute({ code: "typeof beforeExit" })).resolves.toBe("'undefined'");
    } finally {
      await controller.close();
    }
  });

  it("prepares the child through the sandbox seam and cleans it up once", async () => {
    const root = tempWorkspace();
    const cleanup = vi.fn(async () => {});
    const prepareCommand = vi.fn(async ({ command }) => ({
      ...command,
      args: command.args ?? [],
      cwd: command.cwd ?? root,
      sandboxed: true,
      cleanup,
    }));
    const sandbox = {
      mergePolicies: (_configured, request) => request,
      prepareCommand,
      networkAllowsUrl: () => false,
    };
    const controller = createNodeReplController({
      cwd: root,
      sandboxPolicy: { mode: "native" },
      ctx: { workspace: root, sandbox },
    });

    expect(prepareCommand).not.toHaveBeenCalled();
    await expect(controller.execute({ code: "1 + 1" })).resolves.toBe("2");
    expect(prepareCommand).toHaveBeenCalledWith(expect.objectContaining({
      policy: { mode: "native" },
      command: expect.objectContaining({ command: process.execPath, cwd: root }),
    }));
    expect(prepareCommand.mock.calls[0][0].command).not.toHaveProperty("allowLocalBinding");

    await controller.close();
    await controller.close();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
