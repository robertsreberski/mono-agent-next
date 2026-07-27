// SPDX-License-Identifier: MIT
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type {
  SandboxCommand,
  SandboxExecutor,
  SandboxResult,
} from "@mono-agent/module-sdk/internal";
import { afterEach, describe, expect, it } from "vitest";

import { RUNTIME_PI_MAX_IMAGE_BASE64_BYTES } from "../coding-tools-shared.js";
import {
  RUNTIME_PI_SANDBOX_WORKER_RESPONSE_MAX_BYTES,
  RuntimePiSandboxTools,
} from "../sandbox-tools.js";

const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) continue;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  children.clear();
  await Promise.all(roots.splice(0).map(async (root) =>
    rm(root, { recursive: true, force: true })));
});

describe("sandbox tool worker lifecycle", () => {
  it("preserves bounded large JPEG results without duplicated worker details", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-pi-sandbox-image-"));
    roots.push(root);
    let response = Buffer.alloc(0);
    const executor: SandboxExecutor = {
      async execute(command) {
        const result = await executeOnHost(command);
        response = Buffer.from(result.stdout);
        return result;
      },
      spawn() {
        throw new Error("spawn is not used by this test");
      },
    };
    const tools = new RuntimePiSandboxTools(executor, root);
    const acceptedSizes = [
      Math.floor(3.25 * 1024 * 1024),
      RUNTIME_PI_MAX_IMAGE_BASE64_BYTES / 4 * 3,
    ];

    for (const [index, size] of acceptedSizes.entries()) {
      const source = jpeg(size);
      const path = join(root, `accepted-${String(index)}.jpg`);
      await writeFile(path, source);
      const result = await tools.execute(
        "Read",
        { path, max_output_chars: 1_024 },
        new AbortController().signal,
      );
      const image = result.content.find((part) => part.type === "image");

      expect(image).toMatchObject({
        type: "image",
        mimeType: "image/jpeg",
        data: source.toString("base64"),
      });
      expect(response.byteLength).toBeGreaterThan(4 * 1024 * 1024);
      expect(response.byteLength)
        .toBeLessThanOrEqual(RUNTIME_PI_SANDBOX_WORKER_RESPONSE_MAX_BYTES);
      const envelope = JSON.parse(response.toString("utf8")) as {
        readonly result: Readonly<Record<string, unknown>>;
      };
      expect(Object.keys(envelope.result)).toEqual(["content"]);
    }

    const oversized = jpeg(
      RUNTIME_PI_MAX_IMAGE_BASE64_BYTES / 4 * 3 + 3,
    );
    const oversizedPath = join(root, "oversized.jpg");
    await writeFile(oversizedPath, oversized);
    const omitted = await tools.execute(
      "Read",
      { path: oversizedPath, max_output_chars: 1_024 },
      new AbortController().signal,
    );

    expect(omitted.content).toContainEqual({
      type: "text",
      text: expect.stringContaining(
        `[Image omitted: encoded payload exceeds the ${
          String(RUNTIME_PI_MAX_IMAGE_BASE64_BYTES)
        }-byte runtime limit.]`,
      ),
    });
    expect(omitted.content.some((part) => part.type === "image")).toBe(false);
    expect(response.byteLength)
      .toBeLessThan(RUNTIME_PI_SANDBOX_WORKER_RESPONSE_MAX_BYTES);
  }, 30_000);

  it("kills a Bash descendant in the sandbox worker process group", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-pi-sandbox-worker-"));
    roots.push(root);
    const started = join(root, "started.txt");
    const escaped = join(root, "escaped.txt");
    const workerPath = fileURLToPath(new URL(
      "../sandbox-tools-worker.ts",
      import.meta.url,
    ));
    const loaderPath = fileURLToPath(new URL(
      "../typescript-source-loader.mjs",
      import.meta.url,
    ));
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-strip-types",
        "--experimental-loader",
        loaderPath,
        workerPath,
      ],
      {
        cwd: root,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.add(child);
    child.stdout.resume();
    child.stderr.resume();
    const closed = once(child, "close");
    child.stdin.end(JSON.stringify({
      toolId: "Bash",
      params: {
        command: `printf started > ${quote(started)}; sleep 2; printf escaped > ${quote(escaped)}`,
        timeout: 10,
      },
      workspaceDirectory: root,
    }));

    await waitForFile(started, 10_000);
    if (child.pid === undefined) throw new Error("sandbox worker did not expose a pid");
    process.kill(-child.pid, "SIGTERM");
    await Promise.race([
      closed,
      delay(2_000).then(() => {
        throw new Error("sandbox worker did not close after SIGTERM");
      }),
    ]);
    children.delete(child);
    await delay(2_200);
    await expect(access(escaped)).rejects.toThrow();
  }, 20_000);
});

function jpeg(bytes: number): Buffer {
  const value = randomBytes(bytes);
  value.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return value;
}

async function executeOnHost(command: SandboxCommand): Promise<SandboxResult> {
  const child = spawn(
    command.command,
    [...command.arguments],
    {
      cwd: command.workingDirectory,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.add(child);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  const onAbort = (): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };
  command.signal.addEventListener("abort", onAbort, { once: true });
  if (command.signal.aborted) onAbort();
  child.stdin.end(command.stdin);
  const [exitCode, signal] = await once(child, "close") as [
    number | null,
    NodeJS.Signals | null,
  ];
  command.signal.removeEventListener("abort", onAbort);
  children.delete(child);
  return {
    exitCode,
    ...(signal === null ? {} : { signal }),
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
    timedOut: false,
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error("Bash descendant did not start");
}
