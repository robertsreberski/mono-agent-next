import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../cli.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-app-audit-runs-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runCli runs audit", () => {
  it("prints a JSON audit for an explicit artifact directory without rewriting stale running summaries", async () => {
    const dir = await tempDir();
    await writeSummary(dir, "ok.summary.json", {
      runId: "ok",
      conversationId: "fixture",
      status: "succeeded",
      startedAt: "2026-06-24T10:00:00.000Z",
      endedAt: "2026-06-24T10:00:01.000Z",
      durationMs: 1000,
      eventCount: 0,
      artifactPaths: [],
    });
    await writeSummary(dir, "stale.summary.json", {
      runId: "stale",
      conversationId: "fixture",
      status: "running",
      startedAt: "2000-01-01T00:00:00.000Z",
      durationMs: 0,
      eventCount: 0,
      artifactPaths: [],
    });
    await writeFile(join(dir, "bad.summary.json"), "{bad", "utf8");
    const stalePath = join(dir, "stale.summary.json");
    const before = await readFile(stalePath, "utf8");

    const { code, stdout } = await captureCli(() => runCli(["runs", "audit", "--artifacts", dir, "--stale-after-ms", "1", "--json"]));
    const report = JSON.parse(stdout) as { readonly ok: boolean; readonly totalSummaryFiles: number; readonly parseFailureCount: number; readonly staleRunningCount: number };

    expect(code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.totalSummaryFiles).toBe(3);
    expect(report.parseFailureCount).toBe(1);
    expect(report.staleRunningCount).toBe(1);
    await expect(readFile(stalePath, "utf8")).resolves.toBe(before);
  });

  it("defaults to agent summaries and includes memory summaries only with --include-memory", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "memory"), { recursive: true });
    await writeSummary(dir, "run-agent.summary.json", {
      runId: "run-agent",
      conversationId: "fixture",
      status: "succeeded",
      startedAt: "2026-06-24T10:00:00.000Z",
      endedAt: "2026-06-24T10:00:01.000Z",
      durationMs: 1000,
      eventCount: 0,
      artifactPaths: [],
    });
    await writeSummary(dir, "mem-legacy.summary.json", {
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
    await writeSummary(join(dir, "memory"), "mem-new.summary.json", {
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

    const agentOnly = await captureCli(() => runCli(["runs", "audit", "--artifacts", dir, "--stale-after-ms", "1", "--json"]));
    const all = await captureCli(() => runCli(["runs", "audit", "--artifacts", dir, "--stale-after-ms", "1", "--include-memory", "--json"]));
    const agentReport = JSON.parse(agentOnly.stdout) as { readonly totalSummaryFiles: number; readonly statusHistogram: { readonly succeeded: number; readonly failed: number } };
    const allReport = JSON.parse(all.stdout) as { readonly totalSummaryFiles: number; readonly statusHistogram: { readonly succeeded: number; readonly failed: number } };

    expect(agentOnly.code).toBe(0);
    expect(all.code).toBe(0);
    expect(agentReport.totalSummaryFiles).toBe(1);
    expect(agentReport.statusHistogram.succeeded).toBe(1);
    expect(agentReport.statusHistogram.failed).toBe(0);
    expect(allReport.totalSummaryFiles).toBe(3);
    expect(allReport.statusHistogram.succeeded).toBe(2);
    expect(allReport.statusHistogram.failed).toBe(1);
  });

  it("resolves artifact dir and stale interval from a consumer folder without requiring an exporter", async () => {
    const consumer = await tempDir();
    const artifactDir = join(consumer, "custom-artifacts");
    await rm(artifactDir, { recursive: true, force: true });
    await writeFile(
      join(consumer, "mono-agent.config.json"),
      JSON.stringify({
        artifacts: { dir: "./custom-artifacts" },
        traceability: { staleAfterMs: 5000 },
        observability: {
          exporters: [{ type: "phoenix", endpoint: "http://127.0.0.1:9/v1/traces" }],
        },
      }, null, 2),
      "utf8",
    );
    await rm(artifactDir, { recursive: true, force: true });
    await mkdir(artifactDir, { recursive: true });
    await writeSummary(artifactDir, "consumer.summary.json", {
      runId: "consumer",
      conversationId: "fixture",
      status: "succeeded",
      startedAt: "2026-06-24T10:00:00.000Z",
      endedAt: "2026-06-24T10:00:01.000Z",
      durationMs: 1000,
      eventCount: 0,
      artifactPaths: [],
    });

    const { code, stdout } = await captureCli(() => withCleanMonoAgentEnv(() => runCli(["runs", "audit", "--consumer", consumer, "--json"])));
    const report = JSON.parse(stdout) as { readonly artifactDir: string; readonly statusHistogram: { readonly succeeded: number } };

    expect(code).toBe(0);
    expect(report.artifactDir).toBe(artifactDir);
    expect(report.statusHistogram.succeeded).toBe(1);
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
