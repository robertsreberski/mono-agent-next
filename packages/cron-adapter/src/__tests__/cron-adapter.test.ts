import { describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";

import { CronAdapterError, startCronAdapter, toCronJobs } from "../index.js";
// handleTick is an internal export (not re-exported from the package index) so
// the overlap defense-in-depth fallback can be tested directly, bypassing the
// startup validateOptions gate that rejects an invalid overlap value.
import { handleTick } from "../scheduler.js";

describe("Cron adapter", () => {
  it("seeds hashed schedules from the stable job id", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    let scheduler: ReturnType<typeof startCronAdapter> | undefined;

    try {
      scheduler = startCronAdapter({
        responder: { respond: async () => ({}) },
        jobs: [{ id: "stable-hash", expression: "H * * * *", prompt: "check status" }],
        now: () => new Date("2026-07-10T07:30:00.000Z"),
      });
      expect(scheduler.jobs).toHaveLength(1);
      expect(random).not.toHaveBeenCalled();
    } finally {
      scheduler?.stop();
      random.mockRestore();
    }
  });

  it("runs due cron jobs through a structural responder with cron metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const calls: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request, stream) {
        calls.push(request);
        await stream.append(`ran: ${request.text}`);
        return {};
      },
    };
    const results: unknown[] = [];

    const scheduler = startCronAdapter({
      responder,
      jobs: [{
        id: "heartbeat",
        expression: "* * * * *",
        timezone: "UTC",
        prompt: "check status",
        conversationId: "cron:heartbeat",
        notify: true,
        notifyConversationId: "telegram:42",
        model: "claude:claude-opus-4-8",
        effort: "high",
      }],
      now: () => new Date(Date.now()),
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      expect(scheduler.jobs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toEqual([
        expect.objectContaining({
          conversationId: "cron:heartbeat",
          replyTo: { conversationId: "telegram:42" },
          metadata: {
            cron: expect.objectContaining({
              jobId: "heartbeat",
              expression: "* * * * *",
              nativeNotify: {
                enabled: true,
                conversationId: "telegram:42",
              },
              model: "claude:claude-opus-4-8",
              effort: "high",
              scheduledAt: "1970-01-01T00:01:00.000Z",
              startedAt: "1970-01-01T00:01:00.000Z",
            }),
          },
        }),
      ]);
      expect(results).toEqual([
        expect.objectContaining({
          kind: "succeeded",
          jobId: "heartbeat",
          text: "ran: check status",
        }),
      ]);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("keeps a mid-lifecycle destination snapshot in both replyTo and the completion result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const requests: unknown[] = [];
    const results: unknown[] = [];
    let candidates = ["slack:C1"];
    let resolutionCount = 0;
    const resolveNotifyFallbackConversationId = vi.fn(async () => {
      const resolved = candidates.length === 1 ? candidates[0] : undefined;
      if (resolutionCount === 0) {
        // The allowlist changes after this firing selects C1 but before the
        // responder starts. Neither replyTo nor the completion route may
        // re-resolve against the now-ambiguous candidate set.
        candidates = ["slack:C1", "slack:C2"];
      }
      resolutionCount += 1;
      return resolved;
    });
    const responder: AgentResponder = {
      async respond(request) {
        requests.push(request);
        return { text: "digest" };
      },
    };
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "digest", expression: "* * * * *", prompt: "p", notify: true }],
      now: () => new Date(Date.now()),
      resolveNotifyFallbackConversationId,
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests[0]).toEqual(expect.objectContaining({
        replyTo: { conversationId: "slack:C1" },
      }));
      expect(results[0]).toEqual(expect.objectContaining({
        kind: "succeeded",
        notifyConversationId: "slack:C1",
      }));

      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toHaveLength(2);
      expect(results).toHaveLength(2);
      expect(requests[1]).not.toHaveProperty("replyTo");
      expect(results[1]).not.toHaveProperty("notifyConversationId");
      expect(resolveNotifyFallbackConversationId).toHaveBeenCalledTimes(2);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("preserves configured route precedence and contains live resolver rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const seen = new Map<string, unknown>();
    const results: unknown[] = [];
    const warn = vi.fn();
    const resolveNotifyFallbackConversationId = vi.fn(async () => {
      throw new Error("destination lookup failed");
    });
    const responder: AgentResponder = {
      async respond(request) {
        const jobId = (request.metadata as { cron: { jobId: string } }).cron.jobId;
        seen.set(jobId, request.replyTo);
        return { text: jobId };
      },
    };
    const scheduler = startCronAdapter({
      responder,
      jobs: [
        {
          id: "explicit",
          expression: "* * * * *",
          prompt: "p",
          notify: true,
          notifyConversationId: "slack:C-EXPLICIT",
          notifyFallbackConversationId: "slack:C-FALLBACK",
        },
        {
          id: "fallback",
          expression: "* * * * *",
          prompt: "p",
          notify: true,
          notifyFallbackConversationId: "slack:C-FALLBACK",
        },
        { id: "dynamic", expression: "* * * * *", prompt: "p", notify: true },
      ],
      now: () => new Date(Date.now()),
      resolveNotifyFallbackConversationId,
      onResult: (result) => {
        results.push(result);
      },
      logger: { warn },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);

      expect(seen.get("explicit")).toEqual({ conversationId: "slack:C-EXPLICIT" });
      expect(seen.get("fallback")).toEqual({ conversationId: "slack:C-FALLBACK" });
      expect(seen.has("dynamic")).toBe(true);
      expect(seen.get("dynamic")).toBeUndefined();
      expect(resolveNotifyFallbackConversationId).toHaveBeenCalledOnce();
      expect(results).toHaveLength(3);
      expect(results).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "succeeded", jobId: "explicit", notifyConversationId: "slack:C-EXPLICIT" }),
        expect.objectContaining({ kind: "succeeded", jobId: "fallback", notifyConversationId: "slack:C-FALLBACK" }),
        expect.objectContaining({ kind: "succeeded", jobId: "dynamic" }),
      ]));
      const dynamicResult = results.find(
        (result) => (result as { jobId?: string }).jobId === "dynamic",
      );
      expect(dynamicResult).not.toHaveProperty("notifyConversationId");
      expect(warn).toHaveBeenCalledWith(
        "Cron native-notify destination resolution failed; running without a reply target.",
        { jobId: "dynamic", error: "destination lookup failed" },
      );
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("reclaims the slot when a responder hangs past maxRunMs (watchdog), so future firings still run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let respondCount = 0;
    const responder: AgentResponder = {
      async respond() {
        respondCount += 1;
        // Never settles and ignores the abort signal — models a wedged responder that would
        // otherwise pin state.active forever and skip every future firing.
        await new Promise(() => {});
        return {};
      },
    };
    const results: unknown[] = [];

    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "wedged", expression: "* * * * *", timezone: "UTC", prompt: "x", conversationId: "cron:wedged" }],
      now: () => new Date(Date.now()),
      onResult: (result) => {
        results.push(result);
      },
      maxRunMs: 5_000,
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000); // first firing starts, then hangs
      expect(respondCount).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000); // watchdog fires -> abort + reclaim the slot
      const failed = results.find(
        (r): r is { kind: string; error?: string } => (r as { kind?: string }).kind === "failed",
      );
      expect(failed).toBeDefined();
      expect(failed?.error).toMatch(/timed out after 5000ms/u);

      await vi.advanceTimersByTimeAsync(55_000); // next minute boundary -> a NEW run starts
      expect(respondCount).toBe(2); // proves the slot was reclaimed, not skipped as "prior run active"
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("includes destination resolution in maxRunMs and reclaims a slot when the resolver hangs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const responder = { respond: vi.fn(async () => ({ text: "unexpected" })) } satisfies AgentResponder;
    const settleResolvers: Array<(value: string | undefined) => void> = [];
    const resolveNotifyFallbackConversationId = vi.fn(() => {
      return new Promise<string | undefined>((resolve) => {
        settleResolvers.push(resolve);
      });
    });
    const results: unknown[] = [];
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "resolver-hang", expression: "* * * * *", prompt: "p", notify: true }],
      now: () => new Date(Date.now()),
      resolveNotifyFallbackConversationId,
      onResult: (result) => {
        results.push(result);
      },
      maxRunMs: 5_000,
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(resolveNotifyFallbackConversationId).toHaveBeenCalledTimes(1);
      expect(responder.respond).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(results).toContainEqual(expect.objectContaining({
        kind: "failed",
        jobId: "resolver-hang",
        error: expect.stringMatching(/timed out after 5000ms/u),
      }));

      settleResolvers[0]?.("slack:C1");
      for (let turn = 0; turn < 4; turn += 1) {
        await Promise.resolve();
      }
      expect(responder.respond).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(55_000);
      expect(resolveNotifyFallbackConversationId).toHaveBeenCalledTimes(2);
      expect(responder.respond).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("aborts hung destination resolution on stop without maxRunMs and ignores late settlement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolverSignal: AbortSignal | undefined;
    let settleResolver!: (value: string | undefined) => void;
    const resolverPromise = new Promise<string | undefined>((resolve) => {
      settleResolver = resolve;
    });
    const resolveNotifyFallbackConversationId = vi.fn((abortSignal?: AbortSignal) => {
      resolverSignal = abortSignal;
      return resolverPromise;
    });
    const responder = { respond: vi.fn(async () => ({ text: "unexpected" })) } satisfies AgentResponder;
    const results: Array<{ kind: string }> = [];
    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "resolver-stop", expression: "* * * * *", prompt: "p", notify: true }],
      now: () => new Date(Date.now()),
      resolveNotifyFallbackConversationId,
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(resolveNotifyFallbackConversationId).toHaveBeenCalledOnce();
      expect(responder.respond).not.toHaveBeenCalled();

      scheduler.stop();
      await expect.poll(() => results).toContainEqual(expect.objectContaining({
        kind: "cancelled",
        jobId: "resolver-stop",
      }));
      expect(resolverSignal?.aborted).toBe(true);

      settleResolver("slack:C-STALE");
      for (let turn = 0; turn < 4; turn += 1) {
        await Promise.resolve();
      }
      expect(responder.respond).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("preserves a harness-like failure kind on failed results", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const failure = new Error("No API key for provider: openai-codex") as Error & {
      failure: { kind: string };
    };
    failure.failure = { kind: "provider_unavailable_exhausted" };
    const responder: AgentResponder = {
      async respond() {
        throw failure;
      },
    };
    const results: unknown[] = [];

    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "morning", expression: "* * * * *", timezone: "UTC", prompt: "brief" }],
      now: () => new Date(Date.now()),
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await expect
        .poll(() => results)
        .toContainEqual(
          expect.objectContaining({
            kind: "failed",
            jobId: "morning",
            error: "No API key for provider: openai-codex",
            failureKind: "provider_unavailable_exhausted",
          }),
        );
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("lets a job-specific maxRunMs override the adapter watchdog limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const responder: AgentResponder = {
      async respond() {
        await new Promise(() => {});
        return {};
      },
    };
    const results: unknown[] = [];

    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "short", expression: "* * * * *", timezone: "UTC", prompt: "x", maxRunMs: 2_000 }],
      now: () => new Date(Date.now()),
      onResult: (result) => {
        results.push(result);
      },
      maxRunMs: 10_000,
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(results.some((r) => (r as { kind?: string }).kind === "failed")).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const failed = results.find(
        (r): r is { kind: string; error?: string } => (r as { kind?: string }).kind === "failed",
      );
      expect(failed).toBeDefined();
      expect(failed?.error).toMatch(/timed out after 2000ms/u);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("queues overlapping ticks for the same job and runs each after the prior finishes (preserve)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const started: string[] = [];
    const gates: Array<() => void> = [];
    const responder: AgentResponder = {
      async respond(request) {
        const cron = (request.metadata as { cron: { scheduledAt: string } }).cron;
        started.push(cron.scheduledAt);
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        return { text: "done" };
      },
    };
    const results: Array<{ kind: string }> = [];

    const scheduler = startCronAdapter({
      responder,
      // queue is opt-in (the default is skip), so request it explicitly.
      overlap: "queue",
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(Date.now()),
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000); // tick 1 -> run 1 starts (gated)
      await vi.advanceTimersByTimeAsync(60_000); // tick 2 -> queued (NOT skipped)

      expect(started).toHaveLength(1);
      expect(results).toContainEqual(expect.objectContaining({ kind: "queued", jobId: "slow" }));
      expect(results.some((r) => r.kind === "skipped")).toBe(false);

      gates[0]?.(); // run 1 completes -> drains the queued firing
      await vi.runOnlyPendingTimersAsync();
      await expect.poll(() => started).toHaveLength(2); // queued firing ran
      gates[1]?.();
      await vi.runOnlyPendingTimersAsync();
      await expect
        .poll(() => results.filter((r) => r.kind === "succeeded").length)
        .toBe(2); // both firings preserved + completed
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("overlap:'skip' preserves the legacy skip-on-overlap behavior", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let finish!: () => void;
    const responder: AgentResponder = {
      async respond() {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { text: "done" };
      },
    };
    const results: Array<{ kind: string }> = [];

    const scheduler = startCronAdapter({
      responder,
      overlap: "skip",
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(Date.now()),
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(results).toContainEqual(
        expect.objectContaining({ kind: "skipped", jobId: "slow", reason: "overlap" }),
      );
      finish();
      await vi.runOnlyPendingTimersAsync();
      // The original (first) run must still complete successfully after finish();
      // skipping the overlap must not abandon the in-flight run.
      expect(results).toContainEqual(
        expect.objectContaining({ kind: "succeeded", jobId: "slow" }),
      );
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("unrecognized overlap mode defaults to skip (not unbounded queue)", async () => {
    // Drive handleTick directly so an invalid overlap value reaches the
    // dispatch fallback. (Going through startCronAdapter would fail fast at
    // validateOptions; this exercises the runtime defense-in-depth path.)
    let finish!: () => void;
    let started = 0;
    const responder: AgentResponder = {
      async respond() {
        started += 1;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { text: "done" };
      },
    };
    const results: Array<{ kind: string; reason?: string }> = [];

    const options = {
      responder,
      // An invalid value a JS/untyped consumer (or `as` cast) could pass; the
      // dispatch must fall back to the safe "skip" default, not the unbounded
      // "queue" branch.
      overlap: "bogus" as never,
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(Date.now()),
      onResult: (result: { kind: string }) => {
        results.push(result);
      },
    };
    const jobStates = new Map();

    // tick 1 -> no active run, starts (and gates) the in-flight run.
    handleTick(options.jobs[0]!, new Date(0), options, jobStates);
    await expect.poll(() => started).toBe(1);

    // tick 2 -> overlaps the active run with an unrecognized mode.
    handleTick(options.jobs[0]!, new Date(60_000), options, jobStates);
    await expect
      .poll(() => results.filter((r) => r.kind !== "succeeded"))
      .toContainEqual(expect.objectContaining({ kind: "skipped", jobId: "slow", reason: "overlap" }));
    expect(results.some((r) => r.kind === "queued")).toBe(false);
    expect(started).toBe(1); // overlap was NOT queued/run

    // The in-flight run must still complete; defaulting to skip must not
    // abandon the active run.
    finish();
    await expect
      .poll(() => results)
      .toContainEqual(expect.objectContaining({ kind: "succeeded", jobId: "slow" }));
  });

  it("overlap:'replace' reports the replaced run as cancelled even if its responder ignores abort and returns text", async () => {
    // Drive handleTick directly (as the "unrecognized overlap mode" test does) so
    // we control the gate precisely. The first (replaced) responder IGNORES the
    // abort signal and resolves with text after being replaced; the success path
    // must still classify it as cancelled, not succeeded.
    const gates: Array<() => void> = [];
    let started = 0;
    const responder: AgentResponder = {
      async respond() {
        started += 1;
        // Note: deliberately does NOT honor request.abortSignal; it just waits
        // for the gate and then resolves with text.
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        return { text: "done (ignored abort)" };
      },
    };
    const results: Array<{ kind: string; scheduledAt?: string }> = [];

    const options = {
      responder,
      overlap: "replace" as const,
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(Date.now()),
      onResult: (result: { kind: string; scheduledAt?: string }) => {
        results.push(result);
      },
    };
    const jobStates = new Map();

    // tick 1 -> no active run, starts (and gates) the first run.
    handleTick(options.jobs[0]!, new Date(0), options, jobStates);
    await expect.poll(() => started).toBe(1);

    // tick 2 -> overlaps with overlap:"replace": aborts run 1's controller and
    // queues tick 2's firing.
    handleTick(options.jobs[0]!, new Date(60_000), options, jobStates);
    await expect
      .poll(() => results)
      .toContainEqual(expect.objectContaining({ kind: "queued", jobId: "slow" }));

    // Release the (now-aborted) first responder so it resolves with text. The
    // success path must reclassify it as cancelled because its controller was
    // aborted by the replace.
    gates[0]?.();
    await expect
      .poll(() => results)
      .toContainEqual(
        expect.objectContaining({ kind: "cancelled", scheduledAt: "1970-01-01T00:00:00.000Z" }),
      );

    // The replaced (first) firing must NOT be reported as succeeded.
    expect(
      results.some(
        (r) => r.kind === "succeeded" && r.scheduledAt === "1970-01-01T00:00:00.000Z",
      ),
    ).toBe(false);

    // Drain the queued (newest) firing and let it complete normally.
    await expect.poll(() => started).toBe(2);
    gates[1]?.();
    await expect
      .poll(() => results)
      .toContainEqual(
        expect.objectContaining({ kind: "succeeded", scheduledAt: "1970-01-01T00:01:00.000Z" }),
      );
  });

  it("overlap:'replace' aborts hung destination resolution without maxRunMs and ignores late settlement", async () => {
    const resolverSignals: AbortSignal[] = [];
    const settleResolvers: Array<(value: string | undefined) => void> = [];
    const resolveNotifyFallbackConversationId = vi.fn((abortSignal?: AbortSignal) => {
      if (abortSignal !== undefined) {
        resolverSignals.push(abortSignal);
      }
      return new Promise<string | undefined>((resolve) => {
        settleResolvers.push(resolve);
      });
    });
    const seenReplyTargets: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request) {
        seenReplyTargets.push(request.replyTo);
        return { text: "done" };
      },
    };
    const results: Array<{ kind: string; scheduledAt?: string; notifyConversationId?: string }> = [];
    const options = {
      responder,
      overlap: "replace" as const,
      jobs: [{ id: "resolve", expression: "* * * * *", prompt: "p", notify: true }],
      now: () => new Date(Date.now()),
      resolveNotifyFallbackConversationId,
      onResult: (result: { kind: string; scheduledAt?: string; notifyConversationId?: string }) => {
        results.push(result);
      },
    };
    const jobStates = new Map();

    handleTick(options.jobs[0]!, new Date(0), options, jobStates);
    await expect.poll(() => resolveNotifyFallbackConversationId.mock.calls.length).toBe(1);
    expect(resolverSignals[0]?.aborted).toBe(false);
    expect(seenReplyTargets).toEqual([]);

    // Replacing the first firing must abort its resolver race and drain the
    // newest firing even though no watchdog is configured.
    handleTick(options.jobs[0]!, new Date(60_000), options, jobStates);
    await expect
      .poll(() => results)
      .toContainEqual(expect.objectContaining({
        kind: "cancelled",
        scheduledAt: "1970-01-01T00:00:00.000Z",
    }));
    expect(resolverSignals[0]?.aborted).toBe(true);
    await expect.poll(() => resolveNotifyFallbackConversationId.mock.calls.length).toBe(2);

    // Settling the discarded resolver later must neither start its responder
    // nor emit a second terminal result for that firing.
    settleResolvers[0]?.("slack:C-STALE");
    for (let turn = 0; turn < 4; turn += 1) {
      await Promise.resolve();
    }
    expect(seenReplyTargets).toEqual([]);
    expect(
      results.filter(
        (result) =>
          result.scheduledAt === "1970-01-01T00:00:00.000Z"
          && ["cancelled", "failed", "succeeded"].includes(result.kind),
      ),
    ).toEqual([expect.objectContaining({ kind: "cancelled" })]);

    settleResolvers[1]?.("slack:C-NEW");
    await expect.poll(() => seenReplyTargets).toEqual([{ conversationId: "slack:C-NEW" }]);
    await expect
      .poll(() => results)
      .toContainEqual(expect.objectContaining({
        kind: "succeeded",
        scheduledAt: "1970-01-01T00:01:00.000Z",
        notifyConversationId: "slack:C-NEW",
      }));
  });

  it("observes a resolver that reentrantly replaces its run before returning a late rejection", async () => {
    const job = { id: "resolve", expression: "* * * * *", prompt: "p", notify: true };
    const jobStates = new Map();
    let rejectDiscardedResolver!: (error: Error) => void;
    const discardedResolver = new Promise<string | undefined>((_resolve, reject) => {
      rejectDiscardedResolver = reject;
    });
    const thenSpy = vi.spyOn(discardedResolver, "then");
    let resolverCallCount = 0;
    let options!: Parameters<typeof handleTick>[2];
    const responder = {
      respond: vi.fn(
        async (_request: Parameters<AgentResponder["respond"]>[0]) => ({ text: "done" }),
      ),
    } satisfies AgentResponder;
    const results: Array<{ kind: string; scheduledAt?: string; notifyConversationId?: string }> = [];
    options = {
      responder,
      overlap: "replace",
      jobs: [job],
      resolveNotifyFallbackConversationId: () => {
        resolverCallCount += 1;
        if (resolverCallCount === 1) {
          // Re-enter replacement before returning the first operation. The
          // resolver race therefore receives an already-aborted signal.
          handleTick(job, new Date(60_000), options, jobStates);
          return discardedResolver;
        }
        return Promise.resolve("slack:C-NEW");
      },
      onResult: (result) => {
        results.push(result);
      },
    };

    handleTick(job, new Date(0), options, jobStates);
    await expect
      .poll(() => results)
      .toContainEqual(expect.objectContaining({
        kind: "cancelled",
        scheduledAt: "1970-01-01T00:00:00.000Z",
      }));
    await expect.poll(() => responder.respond.mock.calls.length).toBe(1);
    expect(thenSpy).toHaveBeenCalledOnce();
    expect(responder.respond.mock.calls[0]?.[0]).toHaveProperty(
      "replyTo.conversationId",
      "slack:C-NEW",
    );
    await expect
      .poll(() => results)
      .toContainEqual(expect.objectContaining({
        kind: "succeeded",
        scheduledAt: "1970-01-01T00:01:00.000Z",
        notifyConversationId: "slack:C-NEW",
      }));
    await expect.poll(() => jobStates.size).toBe(0);

    rejectDiscardedResolver(new Error("late discarded resolver rejection"));
    for (let turn = 0; turn < 4; turn += 1) {
      await Promise.resolve();
    }
    expect(responder.respond).toHaveBeenCalledOnce();
    expect(
      results.filter(
        (result) =>
          result.scheduledAt === "1970-01-01T00:00:00.000Z"
          && ["cancelled", "failed", "succeeded"].includes(result.kind),
      ),
    ).toHaveLength(1);
  });

  it("overlap:'replace' emits a terminal 'dropped' for a queued firing it discards on a second replace", async () => {
    // Drive handleTick directly (as the prior replace test does) to bypass the
    // validateOptions overlap gate and control the gates precisely. A double
    // replace on one un-drained abort-ignoring run must surface a terminal
    // "dropped" for the firing the second replace discards — otherwise that
    // firing's earlier kind:"queued" is silently orphaned (no terminal).
    const gates: Array<() => void> = [];
    let started = 0;
    const responder: AgentResponder = {
      async respond() {
        started += 1;
        // Ignores request.abortSignal; waits for its gate, then resolves.
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        return { text: "done (ignored abort)" };
      },
    };
    const results: Array<{ kind: string; scheduledAt?: string; reason?: string }> = [];

    const options = {
      responder,
      overlap: "replace" as const,
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(Date.now()),
      onResult: (result: { kind: string; scheduledAt?: string; reason?: string }) => {
        results.push(result);
      },
    };
    const jobStates = new Map();

    // tick 1 -> no active run, starts (and gates) the first run.
    handleTick(options.jobs[0]!, new Date(0), options, jobStates);
    await expect.poll(() => started).toBe(1);

    // tick 2 (replace) -> aborts run 1's controller and queues firing F1.
    handleTick(options.jobs[0]!, new Date(60_000), options, jobStates);
    await expect
      .poll(() => results)
      .toContainEqual(
        expect.objectContaining({ kind: "queued", scheduledAt: "1970-01-01T00:01:00.000Z" }),
      );

    // tick 3 (replace) BEFORE F1 drains (run 1 is still gated/active) -> F1 must
    // receive a terminal "dropped" instead of being silently orphaned.
    handleTick(options.jobs[0]!, new Date(120_000), options, jobStates);
    await expect
      .poll(() => results)
      .toContainEqual(
        expect.objectContaining({
          kind: "dropped",
          jobId: "slow",
          scheduledAt: "1970-01-01T00:01:00.000Z",
          reason: "overflow",
        }),
      );

    // Release the (aborted) first responder so the active slot clears and the
    // newest firing (F2 from tick 3) drains.
    gates[0]?.();
    await expect.poll(() => started).toBe(2);
    gates[1]?.();
    await expect
      .poll(() => results)
      .toContainEqual(
        expect.objectContaining({ kind: "succeeded", scheduledAt: "1970-01-01T00:02:00.000Z" }),
      );
  });

  it("reports a stop()-aborted run as cancelled even if its responder ignores abort and returns text", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let finish!: () => void;
    let started = 0;
    const responder: AgentResponder = {
      async respond() {
        started += 1;
        // Ignores request.abortSignal; resolves with text after the gate.
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { text: "done (ignored abort)" };
      },
    };
    const results: Array<{ kind: string }> = [];

    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(Date.now()),
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000); // tick 1 -> run 1 active (gated)
      await expect.poll(() => started).toBe(1);

      scheduler.stop(); // aborts the active run's controller

      finish(); // responder ignores abort and resolves with text
      await expect
        .poll(() => results)
        .toContainEqual(expect.objectContaining({ kind: "cancelled", jobId: "slow" }));
      expect(results.some((r) => r.kind === "succeeded")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an invalid overlap mode at startup", () => {
    const responder: AgentResponder = {
      async respond() {
        return {};
      },
    };

    expect(() => startCronAdapter({
      responder,
      overlap: "bogus" as never,
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(0),
    })).toThrow(/overlap/u);
  });

  it("rejects an invalid overflow policy at startup", () => {
    const responder: AgentResponder = {
      async respond() {
        return {};
      },
    };

    expect(() => startCronAdapter({
      responder,
      overlap: "queue",
      overflow: "bogus" as never,
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(0),
    })).toThrow(/overflow/u);
  });

  it("drops the oldest queued firing past maxQueueDepth with overflow:'drop-oldest'", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gates: Array<() => void> = [];
    const responder: AgentResponder = {
      async respond() {
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        return { text: "done" };
      },
    };
    const results: Array<{ kind: string; reason?: string }> = [];

    const scheduler = startCronAdapter({
      responder,
      overlap: "queue",
      maxQueueDepth: 1,
      overflow: "drop-oldest",
      jobs: [{ id: "slow", expression: "* * * * *", prompt: "slow work" }],
      now: () => new Date(Date.now()),
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000); // run 1 active
      await vi.advanceTimersByTimeAsync(60_000); // queued depth 1
      await vi.advanceTimersByTimeAsync(60_000); // depth would be 2 > 1 -> drop oldest
      expect(results).toContainEqual(
        expect.objectContaining({ kind: "dropped", jobId: "slow", reason: "overflow" }),
      );
      gates.forEach((g) => g());
      await vi.runOnlyPendingTimersAsync();
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("aborts active jobs on stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let observedAbort = false;
    const responder: AgentResponder = {
      async respond(request) {
        await new Promise<void>((resolve) => {
          request.abortSignal.addEventListener("abort", () => {
            observedAbort = true;
            resolve();
          }, { once: true });
        });
        return { text: "cancelled" };
      },
    };

    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "cancel-me", expression: "* * * * *", prompt: "wait" }],
      now: () => new Date(Date.now()),
    });

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      scheduler.stop();
      expect(observedAbort).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule or run jobs disabled in config", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const calls: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request) {
        calls.push(request.text);
        return {};
      },
    };

    const scheduler = startCronAdapter({
      responder,
      jobs: toCronJobs({
        jobs: [{ id: "off", enabled: false, expression: "* * * * *", timezone: "UTC", prompt: "should not run" }],
      }),
      now: () => new Date(Date.now()),
    });

    try {
      expect(scheduler.jobs).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(calls).toEqual([]);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("rejects cron expressions that are not five fields", () => {
    const responder: AgentResponder = {
      async respond() {
        return {};
      },
    };

    expect(() => startCronAdapter({
      responder,
      jobs: [{ id: "seconds", expression: "* * * * * *", prompt: "too often" }],
      now: () => new Date(0),
    })).toThrow(/five fields/u);
  });

  it.each([
    {
      expression: "",
      message: "Cron job expression is required.",
      details: { code: "invalid_config", jobId: "contract" },
    },
    {
      expression: "* * * * * *",
      message: "Cron job expression must use exactly five fields.",
      details: { code: "invalid_config", jobId: "contract", fieldCount: 6 },
    },
    {
      expression: "61 * * * *",
      message: "Cron job expression is invalid.",
      details: {
        code: "invalid_config",
        jobId: "contract",
        reason: expect.stringMatching(/range 0-59/u),
      },
    },
  ])("preserves the scheduler error contract for '$expression'", ({ expression, message, details }) => {
    const responder: AgentResponder = {
      async respond() {
        return {};
      },
    };

    let thrown: unknown;
    try {
      startCronAdapter({
        responder,
        jobs: [{ id: "contract", expression, prompt: "validate me" }],
        now: () => new Date(0),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CronAdapterError);
    expect(thrown).toMatchObject({
      code: "invalid_config",
      message,
      details,
    });
  });

  it("does not run jobs early when the next tick is beyond Node's max timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const calls: unknown[] = [];
    const responder: AgentResponder = {
      async respond(request) {
        calls.push(request.metadata?.cron);
        return { text: "march" };
      },
    };
    const maxTimeoutMs = 2_147_483_647;
    const firstMarchTickMs = Date.UTC(1970, 2, 1);

    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "monthly", expression: "0 0 1 3 *", prompt: "march check" }],
      now: () => new Date(Date.now()),
    });

    try {
      await vi.advanceTimersByTimeAsync(maxTimeoutMs);
      expect(calls).toEqual([]);

      await vi.advanceTimersByTimeAsync(firstMarchTickMs - maxTimeoutMs);
      expect(calls).toEqual([
        expect.objectContaining({
          jobId: "monthly",
          scheduledAt: "1970-03-01T00:00:00.000Z",
        }),
      ]);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("does not double-fire the same scheduledAt when the timer wakes early (timer coalescing)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // A mutable clock skew models OS timer coalescing: the fake timer wakes at the
    // scheduled wall-clock instant, but the adapter's now() reads a few ms EARLIER
    // (production showed startedAt 16:29:59.995 for scheduledAt 16:30:00.000).
    let skewMs = 0;
    const now = () => new Date(Date.now() + skewMs);
    let respondCount = 0;
    const gates: Array<() => void> = [];
    const responder: AgentResponder = {
      async respond() {
        respondCount += 1;
        // Gate the run so it stays active across the second (potential duplicate)
        // wake — mirroring how the real run is still in flight when the coalesced
        // duplicate arrives and trips the overlap guard.
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        return { text: "done" };
      },
    };
    const results: Array<{ kind: string; scheduledAt?: string; startedAt?: string }> = [];

    const scheduler = startCronAdapter({
      responder,
      jobs: [{ id: "hb", expression: "* * * * *", prompt: "heartbeat" }],
      now,
      onResult: (result) => {
        results.push(result);
      },
    });

    try {
      // Make now() read 5ms BEFORE scheduledAt when the 00:01:00 timer fires.
      // Old scheduler: dispatches the firing at 00:00:59.995, then the post-fire
      // recompute (now < scheduledAt) returns the SAME 00:01:00 and fires it AGAIN
      // — a duplicate caught by the overlap guard as a spurious kind:"skipped".
      skewMs = -5;
      await vi.advanceTimersByTimeAsync(60_000); // early wake -> re-arm the sliver, do NOT fire
      await vi.advanceTimersByTimeAsync(5); // now() reaches 00:01:00 exactly -> fire once

      expect(respondCount).toBe(1); // responder invoked exactly once
      expect(results.filter((r) => r.kind === "skipped")).toHaveLength(0); // no spurious overlap-skip

      // Let the single run finish and assert the succeeded result did NOT start early.
      gates[0]?.();
      await expect.poll(() => results.filter((r) => r.kind === "succeeded")).toHaveLength(1);
      const succeeded = results.find((r) => r.kind === "succeeded")!;
      expect(succeeded.scheduledAt).toBe("1970-01-01T00:01:00.000Z");
      expect(Date.parse(succeeded.startedAt!)).toBeGreaterThanOrEqual(
        Date.parse(succeeded.scheduledAt!),
      ); // run started at/after scheduledAt (no ms-early startedAt)

      // With the skew cleared, the next minute must fire exactly one more time.
      skewMs = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(respondCount).toBe(2);
      expect(results.filter((r) => r.kind === "skipped")).toHaveLength(0);
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });
});
