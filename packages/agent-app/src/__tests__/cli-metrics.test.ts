import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../cli.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-app-metrics-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runCli runs report", () => {
  it("prints JSON metrics for the configured artifact directory without requiring or contacting exporters", async () => {
    const cwd = await tempDir();
    const artifacts = join(cwd, "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      join(cwd, "mono-agent.config.json"),
      JSON.stringify({
        artifacts: { dir: "./artifacts" },
        observability: {
          exporters: [{ type: "phoenix", endpoint: "http://127.0.0.1:9/v1/traces" }],
        },
      }, null, 2),
      "utf8",
    );
    await writeSummary(artifacts, "ok.summary.json", {
      runId: "ok",
      conversationId: "telegram:1",
      status: "succeeded",
      startedAt: "2026-06-24T10:00:00.000Z",
      endedAt: "2026-06-24T10:00:01.000Z",
      durationMs: 1000,
      cost: { cumulativeUsd: 0.05 },
      model: "codex:gpt-5.5",
      eventCount: 0,
      artifactPaths: [],
    });
    await writeSummary(artifacts, "failed.summary.json", {
      runId: "failed",
      conversationId: "telegram:1",
      status: "failed",
      failureKind: "usage_limit",
      startedAt: "2026-06-24T10:01:00.000Z",
      endedAt: "2026-06-24T10:01:01.000Z",
      durationMs: 3000,
      model: "codex:gpt-5.5",
      eventCount: 0,
      artifactPaths: [],
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("metrics must stay offline");
    });

    try {
      const result = await captureCli(() => withCwd(cwd, () => withCleanMonoAgentEnv(() => runCli(["runs", "report", "--by", "model", "--json"]))));
      const report = JSON.parse(result.stdout) as {
        readonly ok: boolean;
        readonly artifactDir: string;
        readonly overall: {
          readonly totalRuns: number;
          readonly statusCounts: { readonly succeeded: number; readonly failed: number };
          readonly cost: { readonly totalUsd: number };
        };
        readonly groups: readonly { readonly key: string; readonly totalRuns: number }[];
      };

      expect(result.code).toBe(0);
      expect(report.ok).toBe(true);
      expect(report.artifactDir).toBe(await realpath(artifacts));
      expect(report.overall.totalRuns).toBe(2);
      expect(report.overall.statusCounts.succeeded).toBe(1);
      expect(report.overall.statusCounts.failed).toBe(1);
      expect(report.overall.cost.totalUsd).toBe(0.05);
      expect(report.groups).toHaveLength(1);
      expect(report.groups[0]).toMatchObject({ key: "codex:gpt-5.5", totalRuns: 2 });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("defaults to agent metrics and includes memory metrics only with --include-memory", async () => {
    const cwd = await tempDir();
    const artifacts = join(cwd, "artifacts");
    await mkdir(join(artifacts, "memory"), { recursive: true });
    await writeFile(
      join(cwd, "mono-agent.config.json"),
      JSON.stringify({
        artifacts: { dir: "./artifacts" },
      }, null, 2),
      "utf8",
    );
    await writeSummary(artifacts, "run-agent.summary.json", {
      runId: "run-agent",
      conversationId: "telegram:1",
      status: "succeeded",
      startedAt: "2026-06-24T10:00:00.000Z",
      endedAt: "2026-06-24T10:00:01.000Z",
      durationMs: 1000,
      eventCount: 0,
      artifactPaths: [],
    });
    await writeSummary(artifacts, "mem-legacy.summary.json", {
      runId: "mem-legacy",
      conversationId: "memory:capture:distill",
      source: "memory",
      status: "succeeded",
      startedAt: "2026-06-24T10:01:00.000Z",
      endedAt: "2026-06-24T10:01:01.000Z",
      durationMs: 1000,
      eventCount: 0,
      artifactPaths: [],
    });
    await writeSummary(join(artifacts, "memory"), "mem-new.summary.json", {
      runId: "mem-new",
      conversationId: "memory:capture:entities",
      source: "memory",
      status: "failed",
      startedAt: "2026-06-24T10:02:00.000Z",
      endedAt: "2026-06-24T10:02:01.000Z",
      durationMs: 1000,
      eventCount: 0,
      artifactPaths: [],
    });

    const agentOnly = await captureCli(() => withCwd(cwd, () => withCleanMonoAgentEnv(() => runCli(["runs", "report", "--json"]))));
    const all = await captureCli(() => withCwd(cwd, () => withCleanMonoAgentEnv(() => runCli(["runs", "report", "--include-memory", "--json"]))));
    const agentReport = JSON.parse(agentOnly.stdout) as { readonly overall: { readonly totalRuns: number; readonly statusCounts: { readonly succeeded: number; readonly failed: number } } };
    const allReport = JSON.parse(all.stdout) as { readonly overall: { readonly totalRuns: number; readonly statusCounts: { readonly succeeded: number; readonly failed: number } } };

    expect(agentOnly.code).toBe(0);
    expect(all.code).toBe(0);
    expect(agentReport.overall.totalRuns).toBe(1);
    expect(agentReport.overall.statusCounts.succeeded).toBe(1);
    expect(agentReport.overall.statusCounts.failed).toBe(0);
    expect(allReport.overall.totalRuns).toBe(3);
    expect(allReport.overall.statusCounts.succeeded).toBe(2);
    expect(allReport.overall.statusCounts.failed).toBe(1);
  });
});

async function captureCli(run: () => Promise<number>): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
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

async function withCwd<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}

async function withCleanMonoAgentEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string>();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MONO_AGENT_")) {
      previous.set(key, process.env[key] ?? "");
      delete process.env[key];
    }
  }
  try {
    return await run();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MONO_AGENT_")) {
        delete process.env[key];
      }
    }
    for (const [key, value] of previous) {
      process.env[key] = value;
    }
  }
}

async function writeSummary(dir: string, name: string, summary: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, name), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}
