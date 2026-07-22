import { describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { CronAdapterConfig, CronAdapterOptions, CronAdapterStartResult } from "@mono-agent/cron-adapter";

import type { ChannelStartInput, CronChannelOverrides } from "../channels.js";
import { createCronChannelDriver } from "../channels.js";

const noopResponder: AgentResponder = {
  async respond() {
    return {};
  },
};

const baseInput = {
  coreConfig: {} as never,
  responder: noopResponder,
  cwd: "/tmp",
  onFailure: () => {},
  config: {
    jobs: [{ id: "j", expression: "* * * * *", timezone: "UTC", prompt: "p", enabled: true }],
  },
} satisfies ChannelStartInput<CronAdapterConfig>;

function succeededResult(text?: string, notifyConversationId?: string) {
  return {
    kind: "succeeded" as const,
    jobId: "j",
    scheduledAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    ...(notifyConversationId === undefined ? {} : { notifyConversationId }),
    ...(text === undefined ? {} : { text }),
  };
}

function failedResult(
  error = "No API key for provider: openai-codex",
  failureKind = "provider_unavailable_exhausted",
) {
  return {
    kind: "failed" as const,
    jobId: "j",
    scheduledAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    error,
    failureKind,
  };
}

async function startCapturingCron(
  input: unknown,
  overrides: CronChannelOverrides = {},
): Promise<CronAdapterOptions> {
  let captured: CronAdapterOptions | undefined;
  const driver = createCronChannelDriver({
    ...overrides,
    adapterFactory: (options): CronAdapterStartResult => {
      captured = options;
      return { jobs: options.jobs, activeJobCount: 0, stop: () => {} };
    },
  });

  await driver.start(input as never);
  if (captured === undefined) {
    throw new Error("Cron adapter was not started.");
  }
  return captured;
}

describe("cron channel driver — run watchdog", () => {
  it("passes a default maxRunMs so a hung run is reclaimed instead of blocking the job forever", async () => {
    let captured: CronAdapterOptions | undefined;
    const driver = createCronChannelDriver({
      adapterFactory: (options): CronAdapterStartResult => {
        captured = options;
        return { jobs: options.jobs, activeJobCount: 0, stop: () => {} };
      },
    });

    await driver.start(baseInput);

    expect(captured?.maxRunMs).toBe(20 * 60 * 1000);
    expect(captured?.overlap).toBe("skip");
  });

  it("honors an explicit maxRunMs override", async () => {
    let captured: CronAdapterOptions | undefined;
    const driver = createCronChannelDriver({
      maxRunMs: 5_000,
      adapterFactory: (options): CronAdapterStartResult => {
        captured = options;
        return { jobs: options.jobs, activeJobCount: 0, stop: () => {} };
      },
    });

    await driver.start(baseInput);

    expect(captured?.maxRunMs).toBe(5_000);
  });

  it("passes job-specific maxRunMs values through to the cron adapter", async () => {
    let captured: CronAdapterOptions | undefined;
    const driver = createCronChannelDriver({
      adapterFactory: (options): CronAdapterStartResult => {
        captured = options;
        return { jobs: options.jobs, activeJobCount: 0, stop: () => {} };
      },
    });
    const input = {
      ...baseInput,
      config: {
        jobs: [
          {
            id: "bills",
            expression: "0 9 * * *",
            timezone: "Europe/Rome",
            prompt: "p",
            enabled: true,
            maxRunMs: 2_700_000,
          },
        ],
      },
    } as never;

    await driver.start(input);

    expect(captured?.jobs).toEqual([
      {
        id: "bills",
        expression: "0 9 * * *",
        timezone: "Europe/Rome",
        prompt: "p",
        maxRunMs: 2_700_000,
      },
    ]);
  });
});

describe("cron channel driver — native notification delivery", () => {
  it("passes native notify settings through to the cron adapter", async () => {
    const captured = await startCapturingCron({
      ...baseInput,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
            notifyConversationId: "telegram:42",
          },
        ],
      },
    });

    expect(captured.jobs).toEqual([
      {
        id: "j",
        expression: "* * * * *",
        timezone: "UTC",
        prompt: "p",
        notify: true,
        notifyConversationId: "telegram:42",
      },
    ]);
  });

  it("delivers successful native notify jobs to the configured destination", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const captured = await startCapturingCron({
      ...baseInput,
      notifyDestination,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
            notifyConversationId: "telegram:42",
          },
        ],
      },
    });

    await captured.onResult?.(succeededResult("Morning brief"));

    await vi.waitFor(() => expect(notifyDestination).toHaveBeenCalledOnce());
    // Verbatim delivery: the final answer is posted as-is (no echo-turn wrapper).
    expect(notifyDestination).toHaveBeenCalledWith("telegram:42", "Morning brief", { verbatim: true });
    const deliveredText = (notifyDestination.mock.calls[0] as [string, string, unknown] | undefined)?.[1];
    expect(deliveredText).toBe("Morning brief");
    expect(deliveredText).not.toContain("Do not call tools");
  });

  it("adds stable success and failure delivery keys only for web:new", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const captured = await startCapturingCron({
      ...baseInput,
      notifyDestination,
      config: {
        jobs: [{
          id: "daily brief",
          expression: "* * * * *",
          timezone: "UTC",
          prompt: "p",
          enabled: true,
          notify: true,
          notifyConversationId: "web:new",
        }],
      },
    });

    await captured.onResult?.({ ...succeededResult("Morning brief"), jobId: "daily brief" });
    await vi.waitFor(() => expect(notifyDestination).toHaveBeenCalledTimes(1));
    expect(notifyDestination).toHaveBeenLastCalledWith("web:new", "Morning brief", {
      verbatim: true,
      deliveryKey: "cron:daily%20brief:2026-01-01T00:00:00.000Z:success",
    });

    await captured.onResult?.({ ...failedResult(), jobId: "daily brief" });
    await vi.waitFor(() => expect(notifyDestination).toHaveBeenCalledTimes(2));
    const failureCall = notifyDestination.mock.calls[1] as unknown as [string, string, unknown];
    expect(failureCall[2]).toEqual({
      verbatim: true,
      deliveryKey: "cron:daily%20brief:2026-01-01T00:00:00.000Z:failure:provider_unavailable_exhausted",
    });
  });

  it("infers a single notify destination when no destination is configured", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const listNotifyDestinations = vi.fn(async () => [
      { conversationId: "slack:C1", channelId: "slack" as const },
    ]);
    const captured = await startCapturingCron({
      ...baseInput,
      notifyDestination,
      listNotifyDestinations,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
          },
        ],
      },
    });

    expect(captured.jobs[0]).not.toHaveProperty("notifyFallbackConversationId");
    const notifyConversationId = await captured.resolveNotifyFallbackConversationId?.();
    expect(notifyConversationId).toBe("slack:C1");

    await captured.onResult?.(succeededResult("Digest", notifyConversationId));

    await vi.waitFor(() =>
      expect(notifyDestination).toHaveBeenCalledWith("slack:C1", "Digest", { verbatim: true }),
    );
  });

  it("re-resolves inferred destinations per run and delivers only on the route bound to that run", async () => {
    const warn = vi.fn();
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    let candidates = [
      { conversationId: "slack:C1", channelId: "slack" as const },
    ];
    const listNotifyDestinations = vi.fn(async () => candidates);
    const captured = await startCapturingCron({
      ...baseInput,
      logger: { warn },
      notifyDestination,
      listNotifyDestinations,
      config: {
        jobs: [{
          id: "j",
          expression: "* * * * *",
          timezone: "UTC",
          prompt: "p",
          enabled: true,
          notify: true,
        }],
      },
    });

    expect(listNotifyDestinations).not.toHaveBeenCalled();
    const firstRoute = await captured.resolveNotifyFallbackConversationId?.();
    candidates = [
      { conversationId: "slack:C1", channelId: "slack" as const },
      { conversationId: "slack:C2", channelId: "slack" as const },
    ];
    // The first run keeps the route it resolved before starting even though a
    // second candidate appears before completion; replyTo and delivery cannot drift.
    await captured.onResult?.(succeededResult("First digest", firstRoute));
    await vi.waitFor(() =>
      expect(notifyDestination).toHaveBeenCalledWith("slack:C1", "First digest", { verbatim: true }),
    );

    const secondRoute = await captured.resolveNotifyFallbackConversationId?.();
    expect(secondRoute).toBeUndefined();
    await captured.onResult?.(succeededResult("Second digest", secondRoute));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    expect(notifyDestination).toHaveBeenCalledTimes(1);
    expect(listNotifyDestinations).toHaveBeenCalledTimes(2);
  });

  it("skips native delivery for blank final text", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const captured = await startCapturingCron({
      ...baseInput,
      notifyDestination,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
            notifyConversationId: "telegram:42",
          },
        ],
      },
    });

    await captured.onResult?.(succeededResult("   "));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifyDestination).not.toHaveBeenCalled();
  });

  it("skips native delivery when the final text is the NOTHING_TO_REPORT sentinel", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const captured = await startCapturingCron({
      ...baseInput,
      notifyDestination,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
            notifyConversationId: "telegram:42",
          },
        ],
      },
    });

    await captured.onResult?.(succeededResult("  nothing_to_report  "));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifyDestination).not.toHaveBeenCalled();
  });

  it("skips and warns when destination inference has zero or multiple candidates", async () => {
    const warn = vi.fn();
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const listNotifyDestinations = vi.fn(async () => [
      { conversationId: "telegram:42", channelId: "telegram" as const },
      { conversationId: "slack:C1", channelId: "slack" as const },
    ]);
    const captured = await startCapturingCron({
      ...baseInput,
      logger: { warn },
      notifyDestination,
      listNotifyDestinations,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
          },
        ],
      },
    });

    await captured.onResult?.(succeededResult("Digest"));

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(notifyDestination).not.toHaveBeenCalled();
  });

  it("logs delivery failures without failing the cron result path", async () => {
    const warn = vi.fn();
    const notifyDestination = vi.fn(async () => ({ delivered: false, reason: "blocked" }));
    const captured = await startCapturingCron({
      ...baseInput,
      logger: { warn },
      notifyDestination,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
            notifyConversationId: "telegram:42",
          },
        ],
      },
    });

    expect(() => captured.onResult?.(succeededResult("Digest"))).not.toThrow();

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls.at(-1)?.[1]).toMatchObject({ jobId: "j", reason: "blocked" });
  });

  it("delivers one verbatim model-exhaustion failure notice and rate-limits repeats", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const captured = await startCapturingCron({
      ...baseInput,
      notifyDestination,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
            notifyConversationId: "telegram:42",
          },
        ],
      },
    });

    const result = failedResult("No API key for provider: openai-codex\nretry failed");
    await captured.onResult?.(result);
    await captured.onResult?.(result);

    await vi.waitFor(() => expect(notifyDestination).toHaveBeenCalledTimes(1));
    expect(notifyDestination).toHaveBeenCalledWith(
      "telegram:42",
      'Cron job "j" failed: all configured models failed. Latest error: No API key for provider: openai-codex retry failed',
      { verbatim: true },
    );
    const deliveredText = (notifyDestination.mock.calls[0] as [string, string, unknown] | undefined)?.[1];
    expect(deliveredText).not.toContain("\n");
  });

  it("does not consume the failure notice cooldown when delivery throws", async () => {
    const warn = vi.fn();
    const notifyDestination = vi.fn()
      .mockRejectedValueOnce(new Error("transport offline"))
      .mockResolvedValueOnce({ delivered: true });
    let now = new Date("2026-01-01T00:00:00.000Z");
    const captured = await startCapturingCron({
      ...baseInput,
      logger: { warn },
      notifyDestination,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
            notifyConversationId: "telegram:42",
            notifyFailureCooldownHours: 1,
          },
        ],
      },
    }, { now: () => now });

    await captured.onResult?.(failedResult());
    await vi.waitFor(() => expect(notifyDestination).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      "Cron failure notice failed.",
      expect.objectContaining({ jobId: "j", reason: "transport offline" }),
    ));

    now = new Date("2026-01-01T00:05:00.000Z");
    await captured.onResult?.(failedResult());

    await vi.waitFor(() => expect(notifyDestination).toHaveBeenCalledTimes(2));
  });

  it("uses a job-specific failure notice cooldown", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    let now = new Date("2026-01-01T00:00:00.000Z");
    const captured = await startCapturingCron({
      ...baseInput,
      notifyDestination,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
            notifyConversationId: "telegram:42",
            notifyFailureCooldownHours: 1,
          },
        ],
      },
    }, { now: () => now });

    await captured.onResult?.(failedResult());
    await vi.waitFor(() => expect(notifyDestination).toHaveBeenCalledTimes(1));

    now = new Date("2026-01-01T00:59:00.000Z");
    await captured.onResult?.(failedResult());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifyDestination).toHaveBeenCalledTimes(1);

    now = new Date("2026-01-01T01:01:00.000Z");
    await captured.onResult?.(failedResult());
    await vi.waitFor(() => expect(notifyDestination).toHaveBeenCalledTimes(2));
  });

  it("does not send failure notices for non-exhausted failures or missing explicit destinations", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const listNotifyDestinations = vi.fn(async () => [
      { conversationId: "telegram:42", channelId: "telegram" as const },
    ]);
    const nonExhausted = await startCapturingCron({
      ...baseInput,
      notifyDestination,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
            notifyConversationId: "telegram:42",
          },
        ],
      },
    });
    await nonExhausted.onResult?.(failedResult("provider unavailable", "provider_unavailable"));

    const missingDestination = await startCapturingCron({
      ...baseInput,
      notifyDestination,
      listNotifyDestinations,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
          },
        ],
      },
    });
    await missingDestination.onResult?.(failedResult());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifyDestination).not.toHaveBeenCalled();
  });
});
