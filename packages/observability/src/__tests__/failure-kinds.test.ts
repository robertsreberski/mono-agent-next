import { describe, expect, it } from "vitest";

import { describeRunFailureKind, KNOWN_RUN_FAILURE_KINDS } from "../index.js";

describe("describeRunFailureKind", () => {
  it("documents the core operator-facing failure kinds", () => {
    expect(describeRunFailureKind({ failureKind: "context_limit" })).toMatchObject({
      kind: "context_limit",
      label: "Context limit",
      known: true,
    });
    expect(describeRunFailureKind({ failureKind: "context_limit" }).nextStep).toContain("compaction");

    expect(describeRunFailureKind({ failureKind: "usage_limit" })).toMatchObject({
      kind: "usage_limit",
      label: "Usage limit",
      known: true,
    });
    expect(describeRunFailureKind({ failureKind: "usage_limit" }).explanation).toContain("limit");
    expect(describeRunFailureKind({ failureKind: "usage_limit" }).nextStep).toContain("Narrow");

    expect(describeRunFailureKind({ failureKind: "process_death" })).toMatchObject({
      kind: "process_death",
      label: "Process death",
      known: true,
    });
    expect(describeRunFailureKind({ status: "interrupted" })).toMatchObject({
      kind: "interrupted",
      label: "Interrupted",
      known: true,
    });

    expect(describeRunFailureKind({ failureKind: "cancelled" })).toMatchObject({
      kind: "cancelled",
      label: "Cancelled",
      known: true,
    });
    expect(describeRunFailureKind({ failureKind: "provider_unavailable" })).toMatchObject({
      kind: "provider_unavailable",
      label: "Provider unavailable",
      known: true,
    });
    expect(describeRunFailureKind({ failureKind: "provider_unavailable_exhausted" })).toMatchObject({
      kind: "provider_unavailable_exhausted",
      label: "Provider failover exhausted",
      known: true,
    });
    expect(describeRunFailureKind({ failureKind: "provider_auth" })).toMatchObject({
      kind: "provider_auth",
      label: "Provider authentication",
      known: true,
    });
    expect(describeRunFailureKind({ failureKind: "skipped_capability_mismatch" })).toMatchObject({
      kind: "skipped_capability_mismatch",
      label: "Capability mismatch",
      known: true,
    });
  });

  it("covers cancellation variants and provider session failures without requiring a closed enum", () => {
    for (const kind of [
      "cancelled_user",
      "cancelled_stale",
      "cancelled_shutdown",
      "cancelled_signal",
      "session_not_found",
      "session_busy",
      "exception",
    ]) {
      const description = describeRunFailureKind({ failureKind: kind });
      expect(description.kind).toBe(kind);
      expect(description.known).toBe(true);
      expect(description.explanation).not.toHaveLength(0);
      expect(description.nextStep).not.toHaveLength(0);
    }
  });

  it("infers useful display kinds from terminal statuses when no failureKind was recorded", () => {
    expect(describeRunFailureKind({ status: "cancelled" }).kind).toBe("cancelled");
    expect(describeRunFailureKind({ status: "interrupted" }).kind).toBe("interrupted");
    expect(describeRunFailureKind({ status: "failed" }).kind).toBe("exception");
  });

  it("falls back for unknown open-set failure kinds", () => {
    const description = describeRunFailureKind({ failureKind: "provider_error" });

    expect(description).toMatchObject({
      kind: "provider_error",
      label: "Unclassified failure (provider_error)",
      known: false,
    });
    expect(description.explanation).toContain("not yet part of the documented display taxonomy");
    expect(description.nextStep).toContain("artifact summary");
  });

  it("does not collapse provider availability kinds into a bare token", () => {
    expect(KNOWN_RUN_FAILURE_KINDS.map((entry) => entry.kind)).toContain("provider_unavailable");
    expect(KNOWN_RUN_FAILURE_KINDS.map((entry) => entry.kind)).toContain("provider_unavailable_exhausted");
    expect(KNOWN_RUN_FAILURE_KINDS.map((entry) => entry.kind)).toContain("provider_auth");
    expect(KNOWN_RUN_FAILURE_KINDS.map((entry) => entry.kind)).toContain("skipped_capability_mismatch");
  });
});
