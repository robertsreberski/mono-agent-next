import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJsonlRunRecorder, type RunSummary } from "@mono-agent/observability";
import { buildRunReadableSpans, createDeterministicIdFactory } from "@mono-agent/observability/otel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { backfillRuns, isRetryable, readRunArtifacts, runStartEndNanos } from "../backfill.js";

const summary: RunSummary = {
  runId: "run-x",
  conversationId: "conv-x",
  status: "succeeded",
  durationMs: 1000,
  eventCount: 2,
  artifactPaths: [],
  startedAt: "2026-06-18T00:00:00.000Z",
  endedAt: "2026-06-18T00:00:01.000Z",
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "backfill-test-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

async function writeRun(runId: string, sum: RunSummary, eventLines: string[]): Promise<void> {
  await writeRunIn(dir, runId, sum, eventLines);
}

async function writeRunIn(root: string, runId: string, sum: RunSummary, eventLines: string[]): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${runId}.summary.json`), JSON.stringify(sum));
  if (eventLines.length > 0) {
    await writeFile(join(root, `${runId}.events.jsonl`), eventLines.join("\n") + "\n");
  }
}

describe("readRunArtifacts", () => {
  it("parses the summary and raw event lines", async () => {
    await writeRun("run-x", summary, [
      JSON.stringify({ type: "tool_call", name: "Read" }),
      JSON.stringify({ type: "assistant", text: "hi" }),
    ]);

    const { summary: parsed, events, warnings } = await readRunArtifacts(dir, "run-x");
    expect(parsed.runId).toBe("run-x");
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("tool_call");
    expect(warnings).toHaveLength(0);
  });

  it("skips malformed event lines with a warning", async () => {
    await writeRun("run-x", summary, [JSON.stringify({ type: "tool_call" }), "{not json"]);

    const { events, warnings } = await readRunArtifacts(dir, "run-x");
    expect(events).toHaveLength(1);
    expect(warnings.join("\n")).toMatch(/malformed/iu);
  });

  it("tolerates a missing events file (root-span-only) with a warning", async () => {
    await writeRun("run-x", summary, []);

    const { events, warnings } = await readRunArtifacts(dir, "run-x");
    expect(events).toHaveLength(0);
    expect(warnings.join("\n")).toMatch(/no .*events/iu);
  });

  it("finds memory namespace artifacts for an explicit run id", async () => {
    await writeRunIn(join(dir, "memory"), "mem-new", {
      ...summary,
      runId: "mem-new",
      conversationId: "memory:capture:distill",
    }, [JSON.stringify({ type: "assistant", text: "memory" })]);

    const { summary: parsed, events } = await readRunArtifacts(dir, "mem-new");

    expect(parsed.runId).toBe("mem-new");
    expect(parsed.conversationId).toBe("memory:capture:distill");
    expect(events).toHaveLength(1);
  });
});

describe("runStartEndNanos", () => {
  it("derives nanos from startedAt/endedAt", () => {
    const { start, end } = runStartEndNanos(summary);
    expect(start).toBe(BigInt(Date.parse("2026-06-18T00:00:00.000Z")) * 1_000_000n);
    expect(end).toBe(BigInt(Date.parse("2026-06-18T00:00:01.000Z")) * 1_000_000n);
  });

  it("falls back to startedAt + durationMs when endedAt is missing", () => {
    const { endedAt: _omit, ...noEnd } = summary;
    const { start, end } = runStartEndNanos(noEnd as RunSummary);
    expect(start).toBe(BigInt(Date.parse("2026-06-18T00:00:00.000Z")) * 1_000_000n);
    expect(end).toBe(BigInt(Date.parse("2026-06-18T00:00:00.000Z") + 1000) * 1_000_000n);
  });
});

describe("isRetryable", () => {
  it("retries transient OTLP statuses (Phoenix 503 backpressure, 429, 5xx) and network errors", () => {
    expect(isRetryable(new Error("OTLP export failed: http://x responded 503"))).toBe(true);
    expect(isRetryable(new Error("OTLP export failed: http://x responded 429"))).toBe(true);
    expect(isRetryable(new Error("OTLP export failed: http://x responded 500"))).toBe(true);
    expect(isRetryable(new Error("network down"))).toBe(true);
  });

  it("does not retry permanent client errors (415 wrong content type, 422, 404)", () => {
    expect(isRetryable(new Error("OTLP export failed: http://x responded 415"))).toBe(false);
    expect(isRetryable(new Error("OTLP export failed: http://x responded 422"))).toBe(false);
    expect(isRetryable(new Error("OTLP export failed: http://x responded 404"))).toBe(false);
  });
});

describe("backfill mapping integration", () => {
  it("maps parsed artifacts to one root span plus one child per event", async () => {
    await writeRun("run-x", summary, [
      JSON.stringify({ type: "tool_call", name: "Read" }),
      JSON.stringify({ type: "assistant", text: "hi" }),
    ]);
    const { summary: parsed, events } = await readRunArtifacts(dir, "run-x");
    const { start, end } = runStartEndNanos(parsed);
    const spans = buildRunReadableSpans({
      summary: parsed,
      events,
      context: {
        runId: parsed.runId,
        conversationId: parsed.conversationId,
        includeSensitiveData: false,
        contentPatternRedaction: false,
      },
      projectName: "local-agent-alpha",
      startTimeUnixNanos: start,
      endTimeUnixNanos: end,
      idFactory: createDeterministicIdFactory(parsed.runId),
    });
    expect(spans).toHaveLength(1 + events.length);
    // Historical timestamps, not wall-clock now().
    expect(spans[0]!.startTime[0]).toBe(Math.trunc(Date.parse("2026-06-18T00:00:00.000Z") / 1000));
  });

  it("exports recorder-persisted userInput without rewriting its truncation marker", async () => {
    const cwd = join(dir, "consumer");
    const artifactDir = join(cwd, "artifacts");
    const configPath = join(cwd, "mono-agent.config.json");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "IDENTITY.md"), "# Identity\n", "utf8");
    await writeFile(configPath, JSON.stringify({
      runtime: { model: "claude:claude-sonnet-4-6" },
      context: { identityPath: "./IDENTITY.md" },
      artifacts: { dir: "./artifacts" },
      observability: {
        exporters: [{
          type: "phoenix",
          endpoint: "http://127.0.0.1:6006/v1/traces",
          includeSensitiveData: true,
        }],
      },
    }), "utf8");

    const recorder = createJsonlRunRecorder({
      runId: "run-long",
      conversationId: "conv-long",
      artifactDir,
      userInput: "x".repeat(100_000),
    });
    await recorder.finish({});
    const persisted = (await readRunArtifacts(artifactDir, "run-long")).summary.userInput;
    expect(persisted).toBe(`${"x".repeat(4_096)}…[truncated 95904 bytes]`);

    let postedBody: Uint8Array | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.body instanceof Uint8Array) postedBody = init.body;
      return new Response(null, { status: 200 });
    }));

    const result = await backfillRuns({ env: {}, cwd, configPath }, { run: "run-long" });
    expect(result.outcomes).toEqual([
      expect.objectContaining({ runId: "run-long", status: "ok" }),
    ]);
    expect(postedBody).toBeInstanceOf(Uint8Array);
    if (postedBody === undefined) throw new Error("backfill did not POST an OTLP body");
    expect(new TextDecoder().decode(postedBody)).toContain(persisted);
  });

  it("redacts recorder-truncated userInput idempotently across repeated backfill", async () => {
    const cwd = join(dir, "consumer-redacted");
    const artifactDir = join(cwd, "artifacts");
    const configPath = join(cwd, "mono-agent.config.json");
    const fixture = ["xox", "b-", "A".repeat(24)].join("");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "IDENTITY.md"), "# Identity\n", "utf8");
    await writeFile(configPath, JSON.stringify({
      runtime: { model: "claude:claude-sonnet-4-6" },
      context: { identityPath: "./IDENTITY.md" },
      artifacts: { dir: "./artifacts" },
      observability: {
        exporters: [{
          type: "phoenix",
          endpoint: "http://127.0.0.1:6006/v1/traces",
          includeSensitiveData: true,
          contentPatternRedaction: true,
        }],
      },
    }), "utf8");

    const recorder = createJsonlRunRecorder({
      runId: "run-long-redacted",
      conversationId: "conv-long",
      artifactDir,
      userInput: `prefix ${fixture} ${"x".repeat(100_000)}`,
    });
    await recorder.finish({});
    const persisted = (await readRunArtifacts(artifactDir, "run-long-redacted")).summary.userInput;
    if (typeof persisted !== "string") throw new Error("recorder did not persist userInput");
    expect(persisted).not.toContain(fixture);
    expect(persisted).toContain("[redacted]");
    expect(persisted.match(/…\[truncated/gu)).toHaveLength(1);

    const postedBodies: Uint8Array[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.body instanceof Uint8Array) postedBodies.push(new Uint8Array(init.body));
      return new Response(null, { status: 200 });
    }));

    const input = { env: {}, cwd, configPath };
    await backfillRuns(input, { run: "run-long-redacted" });
    await backfillRuns(input, { run: "run-long-redacted" });

    expect(postedBodies).toHaveLength(2);
    expect(postedBodies[1]).toEqual(postedBodies[0]);
    const decoded = new TextDecoder().decode(postedBodies[0]);
    const expected = persisted.replace(fixture, "[redacted]");
    expect(decoded).toContain(expected);
    expect(decoded).not.toContain(fixture);
    expect(expected.match(/…\[truncated/gu)).toHaveLength(1);
  });

  it("exports agent runs by default for --all and includes memory runs with includeMemory", async () => {
    const cwd = join(dir, "consumer");
    await mkdir(cwd, { recursive: true });
    const artifactDir = join(cwd, "artifacts");
    const configPath = join(cwd, "mono-agent.config.json");
    await writeFile(join(cwd, "IDENTITY.md"), "# Identity\n", "utf8");
    await writeFile(configPath, JSON.stringify({
      runtime: { model: "claude:claude-sonnet-4-6" },
      context: { identityPath: "./IDENTITY.md" },
      artifacts: { dir: "./artifacts" },
      observability: { exporters: [{ type: "phoenix", endpoint: "http://127.0.0.1:9/v1/traces" }] },
    }), "utf8");
    await writeRunIn(artifactDir, "run-agent", { ...summary, runId: "run-agent", conversationId: "chat" }, []);
    await writeRunIn(artifactDir, "mem-legacy", {
      ...summary,
      runId: "mem-legacy",
      conversationId: "memory:capture:distill",
    }, []);
    await writeRunIn(join(artifactDir, "memory"), "mem-new", {
      ...summary,
      runId: "mem-new",
      conversationId: "memory:capture:entities",
    }, []);

    const input = { env: {}, cwd, configPath };
    const agentOnly = await backfillRuns(input, { all: true, dryRun: true });
    const all = await backfillRuns(input, { all: true, dryRun: true, includeMemory: true });
    const explicitMemory = await backfillRuns(input, { run: "mem-new", dryRun: true });

    expect(agentOnly.outcomes.map((outcome) => outcome.runId)).toEqual(["run-agent"]);
    expect(all.outcomes.map((outcome) => outcome.runId).sort()).toEqual(["mem-legacy", "mem-new", "run-agent"]);
    expect(explicitMemory.outcomes).toHaveLength(1);
    expect(explicitMemory.outcomes[0]).toMatchObject({ runId: "mem-new", status: "ok" });
  });

  it("threads content-pattern redaction into dry-run backfill mapping", async () => {
    const cwd = join(dir, "consumer");
    await mkdir(cwd, { recursive: true });
    const artifactDir = join(cwd, "artifacts");
    const configPath = join(cwd, "mono-agent.config.json");
    const fixture = ["xapp", "-1-", "A".repeat(64)].join("");
    await writeFile(join(cwd, "IDENTITY.md"), "# Identity\n", "utf8");
    await writeRunIn(
      artifactDir,
      "run-agent",
      { ...summary, runId: "run-agent", conversationId: "chat" },
      [JSON.stringify({ type: "assistant_message", role: "assistant", text: `returned ${fixture}` })],
    );

    const writeConfig = async (contentPatternRedaction: boolean): Promise<void> => {
      await writeFile(configPath, JSON.stringify({
        runtime: { model: "claude:claude-sonnet-4-6" },
        context: { identityPath: "./IDENTITY.md" },
        artifacts: { dir: "./artifacts" },
        observability: {
          exporters: [{
            type: "phoenix",
            endpoint: "http://127.0.0.1:9/v1/traces",
            includeSensitiveData: true,
            contentPatternRedaction,
          }],
        },
      }), "utf8");
    };

    await writeConfig(false);
    const unscanned = await backfillRuns({ env: {}, cwd, configPath }, { run: "run-agent", dryRun: true });
    await writeConfig(true);
    const scanned = await backfillRuns({ env: {}, cwd, configPath }, { run: "run-agent", dryRun: true });

    const unscannedOutcome = unscanned.outcomes[0];
    const scannedOutcome = scanned.outcomes[0];
    expect(unscannedOutcome).toMatchObject({ status: "ok", dryRun: true });
    expect(scannedOutcome).toMatchObject({ status: "ok", dryRun: true });
    if (unscannedOutcome?.status !== "ok" || scannedOutcome?.status !== "ok") {
      throw new Error("expected successful dry-run backfill outcomes");
    }
    expect(scannedOutcome.bytes).toBeLessThan(unscannedOutcome.bytes);
  });
});
