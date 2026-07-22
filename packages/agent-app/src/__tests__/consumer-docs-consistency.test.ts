import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("consumer docs/config consistency checker", () => {
  it("fails when README references retired surfaces that the local config does not expose", async () => {
    const dir = await writeConsumer({
      readme: [
        "# Local Agent Beta",
        "",
        "Install @mono-agent/memory-mcp, call memory_note, and inspect the operator console.",
      ].join("\n"),
      config: {
        memory: { recallTool: { enabled: true } },
        tools: { allowedTools: ["MemoryRecall"], mcpConfigPath: "./mcp.json" },
        observability: { exporters: [{ type: "phoenix" }] },
      },
      mcp: { mcpServers: {} },
    });

    await expectScriptFailure(["--consumer", dir], (error) => {
      expect(error.stderr).toContain("@mono-agent/memory-mcp");
      expect(error.stderr).toContain("memory_note");
      expect(error.stderr).toContain("operator console");
    });
  });

  it("passes when README references the configured MemoryRecall surface", async () => {
    const dir = await writeConsumer({
      readme: "This consumer uses MemoryRecall and exports traces to Phoenix.",
      config: {
        memory: { recallTool: { enabled: true } },
        tools: { allowedTools: ["MemoryRecall"], mcpConfigPath: "./mcp.json" },
      },
      mcp: { mcpServers: {} },
    });

    const result = await runScript(["--consumer", dir]);
    expect(result.stdout).toMatch(successSummaryPattern(1));
    expect(result.stderr).toBe("");
  });

  it("treats missing README as a warning and keeps checking other consumers", async () => {
    const missingReadmeDir = await writeConsumer({
      config: { tools: { allowedTools: ["Read"] } },
    });
    const validDir = await writeConsumer({
      readme: "No retired surfaces here.",
      config: { tools: { allowedTools: ["Read"] } },
    });

    const result = await runScript(["--consumer", missingReadmeDir, "--consumer", validDir]);
    expect(result.stdout).toMatch(successSummaryPattern(1));
    expect(result.stderr).toContain("README.md missing; skipped");
  });

  it("warns when every requested consumer is skipped but repo docs are checked", async () => {
    const missingReadmeDir = await writeConsumer({
      config: { tools: { allowedTools: ["Read"] } },
    });

    const result = await runScript(["--consumer", missingReadmeDir]);
    expect(result.stdout).toMatch(successSummaryPattern(0));
    expect(result.stderr).toContain("README.md missing; skipped");
  });

  it("fails on malformed consumer config JSON", async () => {
    const dir = await writeConsumer({
      readme: "No retired surfaces here.",
      configRaw: "{",
    });

    await expectScriptFailure(["--consumer", dir], (error) => {
      expect(error.stderr).toContain("malformed JSON");
    });
  });
});

function successSummaryPattern(consumerCount: number): RegExp {
  return new RegExp(
    "^Repo/consumer docs/config consistency passed for [1-9]\\d* repo doc file\\(s\\) " +
      "and 11 artifact-contract source file\\(s\\) " +
      `and ${consumerCount} consumer folder\\(s\\)\\.\\n$`,
    "u",
  );
}

async function writeConsumer(input: {
  readonly readme?: string;
  readonly config?: unknown;
  readonly configRaw?: string;
  readonly mcp?: unknown;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "consumer-docs-consistency-"));
  tempDirs.push(dir);
  if (input.readme !== undefined) {
    await writeFile(join(dir, "README.md"), input.readme, "utf8");
  }
  const configRaw = input.configRaw ?? `${JSON.stringify(input.config ?? {}, null, 2)}\n`;
  await writeFile(join(dir, "mono-agent.config.json"), configRaw, "utf8");
  if (input.mcp !== undefined) {
    await writeFile(join(dir, "mcp.json"), `${JSON.stringify(input.mcp, null, 2)}\n`, "utf8");
  }
  return dir;
}

async function runScript(args: readonly string[]) {
  return await execFileAsync("node", [scriptPath(), ...args], { encoding: "utf8" });
}

async function expectScriptFailure(
  args: readonly string[],
  assertError: (error: { readonly code?: number; readonly stdout?: string; readonly stderr?: string }) => void,
): Promise<void> {
  try {
    await runScript(args);
  } catch (error) {
    const execError = error as { readonly code?: number; readonly stdout?: string; readonly stderr?: string };
    expect(execError.code).toBe(1);
    assertError(execError);
    return;
  }
  throw new Error("expected checker script to fail");
}

function scriptPath(): string {
  return join(repoRoot(), "scripts", "check-consumer-docs-consistency.mjs");
}

function repoRoot(): string {
  let dir = here;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate pnpm-workspace.yaml above the test file");
}
