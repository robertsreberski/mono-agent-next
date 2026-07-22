import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runMetrics: vi.fn(async () => 0),
  runAuditRuns: vi.fn(async () => 0),
}));

vi.mock("../metrics.js", () => ({ runMetrics: mocks.runMetrics }));
vi.mock("../audit-runs.js", () => ({ runAuditRuns: mocks.runAuditRuns }));

import { parseCliArgs } from "../cli-args.js";
import { runRunsCommand } from "../cli-runs-command.js";

beforeEach(() => {
  mocks.runMetrics.mockClear();
  mocks.runAuditRuns.mockClear();
});

async function captureRuns(argv: readonly string[]): Promise<{ readonly code: number; readonly stderr: string }> {
  const stderr: string[] = [];
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write);
  try {
    const code = await runRunsCommand(parseCliArgs(argv));
    return { code, stderr: stderr.join("") };
  } finally {
    stderrSpy.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runRunsCommand", () => {
  it("defaults to report mode and calls runMetrics", async () => {
    const { code } = await captureRuns(["runs"]);
    expect(code).toBe(0);
    expect(mocks.runMetrics).toHaveBeenCalledTimes(1);
    expect(mocks.runAuditRuns).not.toHaveBeenCalled();
  });

  it("routes explicit report mode to runMetrics with its report-scoped flags", async () => {
    const { code } = await captureRuns(["runs", "report", "--by", "model", "--since", "2026-06-01T00:00:00.000Z", "--json"]);
    expect(code).toBe(0);
    expect(mocks.runAuditRuns).not.toHaveBeenCalled();
    expect(mocks.runMetrics).toHaveBeenCalledTimes(1);
    expect(mocks.runMetrics).toHaveBeenCalledWith(expect.objectContaining({
      groupBy: "model",
      since: "2026-06-01T00:00:00.000Z",
      json: true,
    }));
  });

  it("routes explicit audit mode to runAuditRuns with its audit-scoped flags", async () => {
    const { code } = await captureRuns(["runs", "audit", "--stale-after-ms", "1234", "--include-memory", "--json"]);
    expect(code).toBe(0);
    expect(mocks.runMetrics).not.toHaveBeenCalled();
    expect(mocks.runAuditRuns).toHaveBeenCalledTimes(1);
    expect(mocks.runAuditRuns).toHaveBeenCalledWith(expect.objectContaining({
      staleAfterMs: 1234,
      includeMemory: true,
      json: true,
    }));
  });

  it("rejects an unknown mode with a usage error (exit 2) naming both modes and calls no engine", async () => {
    const { code, stderr } = await captureRuns(["runs", "bogus"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/Unknown `runs` mode `bogus`/u);
    expect(stderr).toMatch(/report or audit/u);
    expect(mocks.runMetrics).not.toHaveBeenCalled();
    expect(mocks.runAuditRuns).not.toHaveBeenCalled();
  });

  it("rejects extra positionals beyond the mode with a usage error (exit 2)", async () => {
    const { code, stderr } = await captureRuns(["runs", "audit", "extra"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/takes no extra arguments/u);
    expect(mocks.runMetrics).not.toHaveBeenCalled();
    expect(mocks.runAuditRuns).not.toHaveBeenCalled();
  });

  // Per-mode strictness: the flags each engine cannot use are rejected here rather
  // than silently dropped. --consumer on report is the worst case — dropping it
  // would quietly read the default artifact folder instead of the requested one.
  it.each([
    { argv: ["runs", "report", "--consumer", "/some/agent"], flag: "--consumer", target: "runs audit" },
    { argv: ["runs", "report", "--stale-after-ms", "5000"], flag: "--stale-after-ms", target: "runs audit" },
    { argv: ["runs", "audit", "--by", "model"], flag: "--by", target: "runs report" },
    { argv: ["runs", "audit", "--since", "2026-06-01T00:00:00.000Z"], flag: "--since", target: "runs report" },
    { argv: ["runs", "audit", "--until", "2026-06-30T00:00:00.000Z"], flag: "--until", target: "runs report" },
  ])("rejects $flag on the wrong mode with a usage error naming $target and calls no engine", async ({ argv, flag, target }) => {
    const { code, stderr } = await captureRuns(argv);
    expect(code).toBe(2);
    expect(stderr).toContain(flag);
    expect(stderr).toContain(`only supported for \`mono-agent ${target}\``);
    expect(mocks.runMetrics).not.toHaveBeenCalled();
    expect(mocks.runAuditRuns).not.toHaveBeenCalled();
  });
});
