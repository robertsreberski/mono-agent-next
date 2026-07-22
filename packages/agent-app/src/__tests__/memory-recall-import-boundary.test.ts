import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const sentinels = vi.hoisted(() => ({
  recallImport: "native recall import sentinel",
}));

vi.mock("@mono-agent/memory/bujo", () => ({
  resolveActiveMemoryDbPath: vi.fn(),
  rollbackMemoryIndex: vi.fn(),
  safeRebuildMemoryIndex: vi.fn(),
}));

// Keep the simulated heavyweight failure on the lazy binding access. Throwing
// from the mock factory replaces it with Vitest's own module-mock wrapper before
// the command boundary can observe the original failure.
vi.mock("../memory-recall.js", () => ({
  get createMemoryEmbeddingProvider() {
    throw new Error(sentinels.recallImport);
  },
  get createRecallStore() {
    throw new Error(sentinels.recallImport);
  },
}));

import { runMemoryCommand } from "../memory-command.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("memory command recall import boundary", () => {
  it.each(["rebuild", "rollback"] as const)(
    "keeps a native recall-module import failure inside the %s command boundary",
    async (operation) => {
      const dir = await agentDir({
        mode: "lite",
        path: "./memory",
        writeMode: "append-host-summary",
      });

      const result = await capture(() => runMemoryCommand(commandInput(dir, [operation])));

      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr: expect.stringContaining(`memory ${operation} failed: ${sentinels.recallImport}`),
      });
    },
  );

  it("keeps an irrelevant native recall-module import failure inside Supermemory search", async () => {
    const dir = await agentDir({
      backend: "supermemory",
      mode: "lite",
      writeMode: "capture",
      recallTool: { enabled: false },
      supermemory: {
        baseUrl: "http://127.0.0.1:6767",
        container: "agent-alpha",
      },
    });

    const result = await capture(() => runMemoryCommand(commandInput(dir, ["search", "coffee"])));

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining(`memory search failed: ${sentinels.recallImport}`),
    });
  });
});

function commandInput(
  cwd: string,
  positionals: readonly string[],
): Parameters<typeof runMemoryCommand>[0] {
  return {
    cwd,
    env: {},
    positionals,
    json: false,
    strict: false,
  };
}

async function agentDir(memory: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-app-recall-import-boundary-"));
  tempDirs.push(dir);
  await writeFile(join(dir, "IDENTITY.md"), "# Test Agent\n", "utf8");
  await writeFile(join(dir, "mono-agent.config.json"), `${JSON.stringify({
    runtime: { model: "pi:ollama:test-model" },
    context: { identityPath: "./IDENTITY.md" },
    memory,
  }, null, 2)}\n`, "utf8");
  return dir;
}

async function capture(run: () => Promise<number>): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write);
  try {
    return { code: await run(), stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}
