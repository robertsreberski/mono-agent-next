import { describe, expect, it } from "vitest";

import {
  describeRunFailureKind,
  RUNS_HEALTH_STALE_RUNNING_MS,
  type RecordedRunListItem,
  type RunSummaryStatus,
} from "@mono-agent/observability";

import { buildRunsHealthDisplay } from "../runs-health.js";

const NOW_MS = Date.parse("2026-07-12T12:00:00.000Z");

function recordedRun(
  runId: string,
  status: RunSummaryStatus,
  overrides: Partial<RecordedRunListItem> = {},
): RecordedRunListItem {
  return {
    runId,
    conversationId: "telegram:42",
    status,
    durationMs: 10,
    eventCount: 0,
    updatedAt: new Date(NOW_MS).toISOString(),
    ...overrides,
  };
}

function timestampLessRun(runId: string, status: RunSummaryStatus): RecordedRunListItem {
  const fixture: Record<string, unknown> = { ...recordedRun(runId, status) };
  delete fixture.updatedAt;
  return fixture as unknown as RecordedRunListItem;
}

function lineStarting(details: readonly string[], prefix: string): string {
  const line = details.find((detail) => detail.startsWith(prefix));
  if (line === undefined) throw new Error(`Missing detail line ${prefix}`);
  return line;
}

describe("buildRunsHealthDisplay", () => {
  it("surfaces explicit user cancellation without degrading health", () => {
    const run = recordedRun("run-cancelled-user", "cancelled", {
      failureKind: "cancelled_user",
      updatedAt: "2026-07-12T08:00:00.000Z",
    });

    const display = buildRunsHealthDisplay({
      artifactDir: "/agent/.mono-agent/artifacts",
      runs: [run],
      warnings: [],
      nowMs: Date.parse("2026-07-12T08:01:00.000Z"),
    });

    expect(display.status).toBe("ok");
    expect(display.details).toContain(
      "User-cancelled runs: 1 (expected lifecycle outcome; health unchanged).",
    );
    expect(display.details.join("\n")).not.toContain("[WARN]");
  });

  it("distinguishes an empty store from reader warnings", () => {
    const empty = buildRunsHealthDisplay({
      artifactDir: "/agent/.mono-agent/artifacts",
      runs: [],
      warnings: [],
      nowMs: NOW_MS,
    });
    expect(empty).toMatchObject({ status: "disabled" });
    expect(empty.details).toContain("No runs recorded yet.");

    const unreadable = buildRunsHealthDisplay({
      artifactDir: "/agent/.mono-agent/artifacts",
      runs: [],
      warnings: ["bad summary", "events file disappeared"],
      nowMs: NOW_MS,
    });
    expect(unreadable.status).toBe("waiting");
    expect(unreadable.details).toEqual(expect.arrayContaining([
      "[WARN] Run artifact reader: bad summary",
      "[WARN] Run artifact reader: events file disappeared",
      "No runs recorded yet.",
    ]));

    const partiallyReadable = buildRunsHealthDisplay({
      artifactDir: "/agent/.mono-agent/artifacts",
      runs: [recordedRun("healthy-run", "succeeded")],
      warnings: ["one summary was unreadable"],
      nowMs: NOW_MS,
    });
    expect(partiallyReadable.status).toBe("waiting");
    expect(partiallyReadable.details).toContain(
      "[WARN] Run artifact reader: one summary was unreadable",
    );
  });

  it("flags only running summaries strictly past the stale boundary and all running summaries when the owner is gone", () => {
    const completed = recordedRun("run-completed", "succeeded", {
      startedAt: new Date(NOW_MS - RUNS_HEALTH_STALE_RUNNING_MS - 1).toISOString(),
    });
    const stale = recordedRun("run-stale", "running", {
      startedAt: new Date(NOW_MS - RUNS_HEALTH_STALE_RUNNING_MS - 1).toISOString(),
    });
    const atBoundary = recordedRun("run-at-boundary", "running", {
      startedAt: new Date(NOW_MS - RUNS_HEALTH_STALE_RUNNING_MS).toISOString(),
    });
    const fresh = recordedRun("run-fresh", "running", {
      startedAt: new Date(NOW_MS - 1_000).toISOString(),
    });
    const invalidTimestamp = recordedRun("run-invalid-time", "running", { startedAt: "not-an-instant" });
    const missingTimestamp = recordedRun("run-missing-time", "running");
    const display = buildRunsHealthDisplay({
      artifactDir: "/agent/.mono-agent/artifacts",
      runs: [completed, stale, atBoundary, fresh, invalidTimestamp, missingTimestamp],
      warnings: [],
      runOwnerAlive: false,
      nowMs: NOW_MS,
    });

    expect(display.status).toBe("waiting");
    const staleLine = lineStarting(display.details, "[WARN] Stale running runs");
    expect(staleLine).toContain("run-stale");
    expect(staleLine).not.toContain("run-completed");
    expect(staleLine).not.toContain("run-at-boundary");
    expect(staleLine).not.toContain("run-fresh");
    expect(staleLine).not.toContain("run-invalid-time");
    expect(staleLine).not.toContain("run-missing-time");
    const ownerGoneLine = lineStarting(display.details, "[WARN] Running summaries while process is gone:");
    for (const run of [stale, atBoundary, fresh, invalidTimestamp, missingTimestamp]) {
      expect(ownerGoneLine).toContain(run.runId);
    }
    expect(ownerGoneLine).not.toContain("run-completed");
  });

  it("keeps old completed and fresh running summaries healthy while the owner is alive or unspecified", () => {
    const runs = [
      recordedRun("run-old-succeeded", "succeeded", {
        startedAt: new Date(NOW_MS - RUNS_HEALTH_STALE_RUNNING_MS - 1).toISOString(),
      }),
      recordedRun("run-fresh", "running", {
        startedAt: new Date(NOW_MS - 1_000).toISOString(),
      }),
    ];
    const displayForOwner = (runOwnerAlive?: boolean) => buildRunsHealthDisplay({
      artifactDir: "/agent/.mono-agent/artifacts",
      runs,
      warnings: [],
      ...(runOwnerAlive === undefined ? {} : { runOwnerAlive }),
      nowMs: NOW_MS,
    });

    for (const display of [displayForOwner(true), displayForOwner()]) {
      expect(display.status).toBe("ok");
      expect(
        display.details.some((detail) => detail.startsWith("[WARN] Stale running runs")),
      ).toBe(false);
      expect(
        display.details.some((detail) => detail.startsWith("[WARN] Running summaries while process is gone:")),
      ).toBe(false);
      expect(display.details).toContain("Failure kinds: none in recent window.");
    }
  });

  it("sorts and explains failure kinds while separating expected and unhealthy cancellation", () => {
    const providerUnavailable = describeRunFailureKind({
      failureKind: "provider_unavailable",
    });
    const display = buildRunsHealthDisplay({
      artifactDir: "/agent/.mono-agent/artifacts",
      runs: [
        recordedRun("provider-1", "failed", { failureKind: "provider_unavailable" }),
        recordedRun("provider-2", "failed", { failureKind: "provider_unavailable" }),
        recordedRun("custom", "failed", { failureKind: "  custom_failure  " }),
        recordedRun("fallback-kind", "failed", { failureKind: "   " }),
        recordedRun("shutdown", "cancelled", { failureKind: "cancelled_shutdown" }),
        recordedRun("interrupted", "interrupted"),
        recordedRun("user-cancelled", "cancelled", { failureKind: "cancelled_user" }),
      ],
      warnings: [],
      nowMs: NOW_MS,
    });

    expect(display.status).toBe("waiting");
    expect(display.details).toContain(
      "User-cancelled runs: 1 (expected lifecycle outcome; health unchanged).",
    );
    expect(display.details).toContain("[WARN] Cancelled recent runs: 1.");
    expect(display.details).toContain("[WARN] Interrupted recent runs: 1.");
    expect(lineStarting(display.details, "[WARN] Recent non-successful runs:")).toContain("and 1 more");
    expect(lineStarting(display.details, "[WARN] Failure kinds:")).toBe(
      "[WARN] Failure kinds: provider_unavailable=2, cancelled_shutdown=1, custom_failure=1, exception=1, interrupted=1.",
    );
    expect(display.details).toEqual(expect.arrayContaining([
      `[WARN] ${providerUnavailable.label} [provider_unavailable, 2 recent]: ${providerUnavailable.explanation} Next: ${providerUnavailable.nextStep}`,
      expect.stringContaining("Unclassified failure (custom_failure) [custom_failure (unclassified), 1 recent]"),
      expect.stringContaining("Unclassified exception [exception, 1 recent]"),
    ]));
    expect(display.details.join("\n")).not.toContain("Failure kinds: cancelled_user=");
  });

  it("treats only cancelled runs with a normalized cancelled_user kind as expected lifecycle", () => {
    const display = buildRunsHealthDisplay({
      artifactDir: "/agent/.mono-agent/artifacts",
      runs: [
        recordedRun("expected-cancellation", "cancelled", {
          failureKind: "  cancelled_user  ",
        }),
        recordedRun("failed-with-cancellation-kind", "failed", {
          failureKind: "cancelled_user",
        }),
      ],
      warnings: [],
      nowMs: NOW_MS,
    });

    expect(display.status).toBe("waiting");
    expect(display.details).toContain(
      "User-cancelled runs: 1 (expected lifecycle outcome; health unchanged).",
    );
    const unsuccessful = lineStarting(display.details, "[WARN] Recent non-successful runs:");
    expect(unsuccessful).toContain("failed-with-cancellation-kind");
    expect(unsuccessful).not.toContain("expected-cancellation");
    expect(display.details).not.toContain("[WARN] Cancelled recent runs: 1.");
    expect(display.details).toContain("[WARN] Failure kinds: cancelled_user=1.");
  });

  it("formats second, minute, hour, day, future, and unknown ages while capping examples", () => {
    const display = buildRunsHealthDisplay({
      artifactDir: "/agent/.mono-agent/artifacts",
      runs: [
        recordedRun("seconds", "succeeded", { endedAt: new Date(NOW_MS - 59_000).toISOString() }),
        recordedRun("minutes", "succeeded", { updatedAt: new Date(NOW_MS - 60_000).toISOString() }),
        recordedRun("hours", "succeeded", { updatedAt: new Date(NOW_MS - 60 * 60_000).toISOString() }),
        recordedRun("days", "succeeded", { endedAt: new Date(NOW_MS - 48 * 60 * 60_000).toISOString() }),
        recordedRun("invalid", "succeeded", { endedAt: "not-an-instant" }),
        timestampLessRun("not-rendered", "succeeded"),
      ],
      warnings: [],
      nowMs: NOW_MS,
    });

    expect(lineStarting(display.details, "Last runs:")).toBe(
      "Last runs: seconds succeeded 59s ago, minutes succeeded 1m ago, hours succeeded 1h ago, days succeeded 2d ago, invalid succeeded age unknown and 1 more.",
    );
    expect(display.status).toBe("ok");
    expect(display.details).toContain("Failure kinds: none in recent window.");

    const clockSkew = buildRunsHealthDisplay({
      artifactDir: "/agent/.mono-agent/artifacts",
      runs: [
        recordedRun("future", "succeeded", { endedAt: new Date(NOW_MS + 60_000).toISOString() }),
        timestampLessRun("missing", "succeeded"),
      ],
      warnings: [],
      nowMs: NOW_MS,
    });
    expect(lineStarting(clockSkew.details, "Last runs:")).toContain(
      "future succeeded 0s ago, missing succeeded age unknown",
    );

    const startedAtOnly = buildRunsHealthDisplay({
      artifactDir: "/agent/.mono-agent/artifacts",
      runs: [{
        ...timestampLessRun("started-only", "succeeded"),
        startedAt: new Date(NOW_MS - 60_000).toISOString(),
      }],
      warnings: [],
      nowMs: NOW_MS,
    });
    expect(lineStarting(startedAtOnly.details, "Last runs:")).toBe(
      "Last runs: started-only succeeded 1m ago.",
    );
  });
});
