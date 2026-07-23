import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeReplController } from "../node-repl.js";

const roots: string[] = [];

afterEach(async () => {
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

  it("bounds input before child creation and refuses use after run settlement", async () => {
    const controller = createNodeReplController(await workspace());

    await expect(controller.execute({
      code: "x".repeat(256 * 1024 + 1),
    })).rejects.toThrow("code exceeds 262144 bytes");
    await controller.close();
    await expect(controller.execute({ code: "1 + 1" }))
      .rejects.toThrow("run has already ended");
  });
});
