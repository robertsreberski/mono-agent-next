import type { RunnerHandle } from "@grammyjs/runner";
import { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "../adapter.js";
import { createTelegramBot } from "../bot.js";
import { startTelegramAdapter } from "../start.js";

const runnerModuleMocks = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@grammyjs/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@grammyjs/runner")>();
  return {
    ...actual,
    run: ((...args: Parameters<typeof actual.run>) => {
      runnerModuleMocks.run(...args);
      return actual.run(...args);
    }) as typeof actual.run,
  };
});

const FAKE_BOT_INFO = {
  id: 1,
  is_bot: true as const,
  first_name: "Example Bot",
  username: "ExampleBot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

interface RecordedCall {
  method: string;
  payload: Record<string, unknown>;
}

function recordingBot(): { bot: Bot; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let nextMessageId = 900;
  const bot = new Bot("test-token", { botInfo: FAKE_BOT_INFO });
  bot.api.config.use(async (_prev, method, payload) => {
    const typedPayload = payload as Record<string, unknown>;
    calls.push({ method, payload: typedPayload });
    if (method === "sendMessage") {
      return {
        ok: true,
        result: {
          message_id: nextMessageId++,
          date: 0,
          chat: { id: typedPayload.chat_id, type: "private" },
          text: typedPayload.text,
        },
      } as never;
    }
    return { ok: true, result: true } as never;
  });
  return { bot, calls };
}

class FakeRunner implements RunnerHandle {
  running = true;
  stopCalls = 0;
  start(): void {
    this.running = true;
  }
  stop(): Promise<void> {
    this.stopCalls += 1;
    this.running = false;
    return Promise.resolve();
  }
  size(): number {
    return 0;
  }
  task(): Promise<void> | undefined {
    return this.running ? Promise.resolve() : undefined;
  }
  isRunning(): boolean {
    return this.running;
  }
}

function messageUpdate(text: string, chatId = 42, updateId = 1): Parameters<Bot["handleUpdate"]>[0] {
  return {
    update_id: updateId,
    message: {
      message_id: 10,
      date: 1234,
      chat: { id: chatId, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Person A" },
      text,
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

function documentUpdate(mimeType: string, updateId = 1): Parameters<Bot["handleUpdate"]>[0] {
  return {
    update_id: updateId,
    message: {
      message_id: 10,
      date: 1234,
      chat: { id: 42, type: "private" },
      from: { id: 7, is_bot: false, first_name: "Person A" },
      caption: "summarize",
      document: {
        file_id: "doc-file-id",
        file_unique_id: "doc-unique-id",
        file_name: "brief.pdf",
        mime_type: mimeType,
        file_size: 12_345,
      },
    },
  } as Parameters<Bot["handleUpdate"]>[0];
}

describe("startTelegramAdapter", () => {
  it("exposes notify() that runs a proactive turn and delivers to the chat", async () => {
    const { bot, calls } = recordingBot();
    const responder: AgentResponder = {
      async respond() {
        return { text: "ping delivered" };
      },
    };
    const result = await startTelegramAdapter({
      botToken: "test-token",
      allowAllChats: true,
      responder,
      botFactory: () => bot,
      runnerFactory: () => new FakeRunner(),
    });

    const outcome = await result.notify(99, "say hi");

    expect(outcome).toEqual({ delivered: true });
    const sent = calls.filter((call) => call.method === "sendMessage");
    expect(sent.at(-1)?.payload).toMatchObject({ chat_id: 99, text: "ping delivered" });
    await result.stop();
  });

  it("wires the grammY bot + runner and starts polling", async () => {
    const { bot, calls } = recordingBot();
    let capturedToken: string | undefined;
    let runner: FakeRunner | undefined;

    const result = await startTelegramAdapter({
      botToken: "test-token",
      allowAllChats: true,
      responder: { respond: vi.fn() } satisfies AgentResponder,
      botFactory: (token) => {
        capturedToken = token;
        return bot;
      },
      runnerFactory: () => {
        runner = new FakeRunner();
        return runner;
      },
    });

    expect(capturedToken).toBe("test-token");
    expect(runner?.isRunning()).toBe(true);
    expect(calls.some((call) => call.method === "deleteWebhook")).toBe(true);

    await result.stop();
    expect(runner?.stopCalls).toBe(1);
    expect(runner?.isRunning()).toBe(false);
  });

  it("uses the exact 90s retry budget and absorbs an isolated timeout inside one runner", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let result: Awaited<ReturnType<typeof startTelegramAdapter>> | undefined;
    try {
      runnerModuleMocks.run.mockClear();
      let pollAttempts = 0;
      let successfulPolls = 0;
      const onPollingError = vi.fn();
      const onPollingRecovered = vi.fn();
      const bot = new Bot("test-token", { botInfo: FAKE_BOT_INFO });
      bot.api.config.use(async (_prev, method, _payload, signal) => {
        if (method !== "getUpdates") {
          return { ok: true, result: true } as never;
        }
        pollAttempts += 1;
        if (pollAttempts === 1) {
          // Model one real HTTP-client timeout: the failed request itself takes
          // 50s. The old 15s budget was already exhausted when it threw; the new
          // 90s budget can wait 100ms and retry inside this same runner.
          await new Promise((_resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("getUpdates ETIMEDOUT")),
              50_000,
            );
            const abortSignal = signal as AbortSignal | undefined;
            abortSignal?.addEventListener("abort", () => {
              clearTimeout(timeout);
              reject(new Error("poll stopped"));
            }, { once: true });
          });
        }
        if (successfulPolls === 0) {
          successfulPolls += 1;
          return { ok: true, result: [] } as never;
        }
        return await new Promise((_resolve, reject) => {
          const abortSignal = signal as AbortSignal | undefined;
          abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("poll stopped")),
            { once: true },
          );
        });
      });

      result = await startTelegramAdapter({
        botToken: "test-token",
        allowAllChats: true,
        responder: { respond: vi.fn() } satisfies AgentResponder,
        deleteWebhookOnStart: false,
        onPollingError,
        onPollingRecovered,
        botFactory: () => bot,
      });

      const runOptions = runnerModuleMocks.run.mock.calls[0]?.[1];
      expect(runOptions).toMatchObject({
        runner: {
          silent: true,
          retryInterval: "exponential",
          maxRetryTime: 90_000,
          fetch: { timeout: 30, allowed_updates: ["message", "callback_query"] },
        },
      });

      await vi.advanceTimersByTimeAsync(50_100);
      // Failure, successful retry, then the runner's next active long-poll.
      expect(pollAttempts).toBe(3);
      expect(successfulPolls).toBe(1);
      expect(runnerModuleMocks.run).toHaveBeenCalledTimes(1);
      expect(onPollingError).not.toHaveBeenCalled();
      expect(onPollingRecovered).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      await result?.stop();
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("registers configured commands via setMyCommands at startup", async () => {
    const { bot, calls } = recordingBot();

    const result = await startTelegramAdapter({
      botToken: "test-token",
      allowAllChats: true,
      responder: { respond: vi.fn() } satisfies AgentResponder,
      commands: [{ command: "brief", description: "Morning brief", prompt: "Compose the brief" }],
      botFactory: () => bot,
      runnerFactory: () => new FakeRunner(),
    });

    const setCommands = calls.find((call) => call.method === "setMyCommands");
    expect(setCommands).toBeDefined();
    const registered = setCommands?.payload.commands as Array<{ command: string }>;
    expect(registered.map((entry) => entry.command)).toEqual(["help", "cancel", "brief"]);

    await result.stop();
  });

  it("registers model and effort commands when runtime controls are supplied", async () => {
    const { bot, calls } = recordingBot();

    const result = await startTelegramAdapter({
      botToken: "test-token",
      allowAllChats: true,
      responder: { respond: vi.fn() } satisfies AgentResponder,
      runtimeControls: {
        defaultModel: "codex:gpt-primary",
        models: [{ value: "codex:gpt-primary", label: "Primary", efforts: [] }],
      },
      botFactory: () => bot,
      runnerFactory: () => new FakeRunner(),
    });

    const setCommands = calls.find((call) => call.method === "setMyCommands");
    const registered = setCommands?.payload.commands as Array<{ command: string }>;
    expect(registered.map((entry) => entry.command)).toEqual(["help", "cancel", "model", "effort"]);

    await result.stop();
  });

  it("skips setMyCommands when no custom commands are configured", async () => {
    const { bot, calls } = recordingBot();

    const result = await startTelegramAdapter({
      botToken: "test-token",
      allowAllChats: true,
      responder: { respond: vi.fn() } satisfies AgentResponder,
      botFactory: () => bot,
      runnerFactory: () => new FakeRunner(),
    });

    expect(calls.some((call) => call.method === "setMyCommands")).toBe(false);

    await result.stop();
  });

  it("routes a fake update through the wired bot to the responder", async () => {
    const { bot } = recordingBot();
    const respondCalls: Array<{ text: string; chatId: unknown }> = [];
    const responder: AgentResponder = {
      async respond(request) {
        respondCalls.push({ text: request.text, chatId: request.chatId });
        return { text: "pong" };
      },
    };

    const result = await startTelegramAdapter({
      botToken: "test-token",
      allowedChatIds: [42],
      responder,
      stream: { editDebounceMs: 0 },
      botFactory: () => bot,
      runnerFactory: () => new FakeRunner(),
    });

    await bot.handleUpdate(messageUpdate("ping"));

    expect(respondCalls).toEqual([{ text: "ping", chatId: 42 }]);

    await result.stop();
  });

  it("stop() is idempotent", async () => {
    const { bot } = recordingBot();
    const result = await startTelegramAdapter({
      botToken: "test-token",
      allowAllChats: true,
      responder: { respond: vi.fn() } satisfies AgentResponder,
      botFactory: () => bot,
      runnerFactory: () => new FakeRunner(),
    });

    await result.stop();
    await expect(result.stop()).resolves.toBeUndefined();
  });

  it("forwards a narrower attachments policy through to the download path", async () => {
    const { bot, calls } = recordingBot();
    const requests: Array<{ attachments: unknown }> = [];
    const responder: AgentResponder = {
      async respond(request) {
        requests.push({ attachments: request.attachments });
        return { text: "ok" };
      },
    };

    const result = await startTelegramAdapter({
      botToken: "test-token",
      allowAllChats: true,
      responder,
      stream: { editDebounceMs: 0 },
      // A policy NARROWER than the default: application/pdf is on the default
      // allowlist but NOT on this custom one, so it must be filtered out before
      // any download (proving the policy reached downloadTelegramAttachments).
      attachments: { mimeAllowlist: ["text/plain"], maxBytes: 5 },
      botFactory: () => bot,
      runnerFactory: () => new FakeRunner(),
    });

    await bot.handleUpdate(documentUpdate("application/pdf"));

    expect(requests).toHaveLength(1);
    // The disallowed MIME type was filtered: no download, no attachment bytes.
    expect(requests[0]?.attachments).toBeUndefined();
    // getFile is the first step of a download; it must never have been called.
    expect(calls.some((call) => call.method === "getFile")).toBe(false);

    await result.stop();
  });

  it("fails closed when neither allowedChatIds nor allowAllChats is provided", async () => {
    await expect(
      startTelegramAdapter({
        botToken: "test-token",
        responder: { respond: vi.fn() } satisfies AgentResponder,
        botFactory: () => recordingBot().bot,
        runnerFactory: () => new FakeRunner(),
      }),
    ).rejects.toThrow(/allowedChatIds/);
  });
});

/**
 * A runner whose long-poll task REJECTS — models grammY's getUpdates dying after
 * a network blip / host sleep (the runner task rejects, `isRunning()` flips
 * false). Used to exercise the auto-restart monitor.
 */
class CrashingRunner implements RunnerHandle {
  running = false;
  stopCalls = 0;
  constructor(private readonly error: Error) {}
  start(): void {
    this.running = true;
  }
  stop(): Promise<void> {
    this.stopCalls += 1;
    this.running = false;
    return Promise.resolve();
  }
  size(): number {
    return 0;
  }
  task(): Promise<void> | undefined {
    // Already settled (rejected): the long-poll crashed.
    this.running = false;
    return Promise.reject(this.error);
  }
  isRunning(): boolean {
    return this.running;
  }
}

describe("startTelegramAdapter polling auto-restart", () => {
  const INITIAL_BACKOFF_MS = 500;

  it("recreates the runner after a polling crash, growing the backoff each time", async () => {
    vi.useFakeTimers();
    try {
      const { bot } = recordingBot();
      const errors: unknown[] = [];
      const errorLogs: string[] = [];
      // Every spawned runner crashes, so each restart triggers the next backoff.
      const spawned: CrashingRunner[] = [];
      const runnerFactory = vi.fn(() => {
        const runner = new CrashingRunner(new Error("getUpdates ETIMEDOUT"));
        spawned.push(runner);
        return runner;
      });

      const result = await startTelegramAdapter({
        botToken: "test-token",
        allowAllChats: true,
        responder: { respond: vi.fn() } satisfies AgentResponder,
        deleteWebhookOnStart: false,
        logger: { error: (message: string) => { errorLogs.push(message); } },
        onPollingError: (error) => { errors.push(error); },
        botFactory: () => bot,
        runnerFactory,
      });

      // The initial spawn happened during start(); flush its task rejection.
      await vi.advanceTimersByTimeAsync(0);
      expect(runnerFactory).toHaveBeenCalledTimes(1);
      expect(errors).toHaveLength(1);
      expect(errorLogs).toHaveLength(1);

      // First restart fires after the INITIAL backoff (500ms). Just-before does not.
      await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS - 1);
      expect(runnerFactory).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(runnerFactory).toHaveBeenCalledTimes(2);

      // The second restart's crash grew the backoff to 2 × initial (1000ms): the
      // first restart did NOT stay up for the stability window, so the backoff
      // doubled rather than resetting. Just-before the grown delay, no new spawn.
      await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS * 2 - 1);
      expect(runnerFactory).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(runnerFactory).toHaveBeenCalledTimes(3);

      // Third restart's backoff grew again to 4 × initial (2000ms).
      await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS * 4 - 1);
      expect(runnerFactory).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(runnerFactory).toHaveBeenCalledTimes(4);

      // The restart loop kept running, but the whole outage is one state edge:
      // repeated runner crashes neither re-log nor re-notify the host.
      expect(errors).toHaveLength(1);
      expect(errorLogs).toHaveLength(1);

      await result.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() cancels a pending restart so the runner is not resurrected", async () => {
    vi.useFakeTimers();
    try {
      const { bot } = recordingBot();
      const runnerFactory = vi.fn(() => new CrashingRunner(new Error("getUpdates EADDRNOTAVAIL")));

      const result = await startTelegramAdapter({
        botToken: "test-token",
        allowAllChats: true,
        responder: { respond: vi.fn() } satisfies AgentResponder,
        deleteWebhookOnStart: false,
        botFactory: () => bot,
        runnerFactory,
      });

      // Initial spawn + its crash; a restart is now pending behind the backoff.
      await vi.advanceTimersByTimeAsync(0);
      expect(runnerFactory).toHaveBeenCalledTimes(1);

      // Stop BEFORE the backoff elapses: the pending restart must be cancelled.
      await result.stop();

      // Advancing well past the backoff must NOT spawn another runner.
      await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS * 10);
      expect(runnerFactory).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the backoff after a runner stays up past the stability window", async () => {
    vi.useFakeTimers();
    try {
      const { bot } = recordingBot();
      // A runner whose long-poll task can be crashed on demand: it stays pending
      // (healthy) until `crash()` rejects it, modeling a runner that lives a while
      // and then dies on a later getUpdates error.
      class ControllableRunner implements RunnerHandle {
        running = true;
        private reject: ((error: Error) => void) | undefined;
        private readonly promise = new Promise<void>((_resolve, rej) => { this.reject = rej; });
        start(): void { this.running = true; }
        stop(): Promise<void> { this.running = false; return Promise.resolve(); }
        size(): number { return 0; }
        task(): Promise<void> | undefined { return this.promise; }
        isRunning(): boolean { return this.running; }
        crash(): void {
          this.running = false;
          this.reject?.(new Error("getUpdates ETIMEDOUT"));
        }
      }

      const runners: ControllableRunner[] = [];
      const runnerFactory = vi.fn(() => {
        const runner = new ControllableRunner();
        runners.push(runner);
        return runner;
      });

      const result = await startTelegramAdapter({
        botToken: "test-token",
        allowAllChats: true,
        responder: { respond: vi.fn() } satisfies AgentResponder,
        deleteWebhookOnStart: false,
        botFactory: () => bot,
        runnerFactory,
      });

      expect(runnerFactory).toHaveBeenCalledTimes(1);

      // First crash → restart fires at the INITIAL backoff (500ms).
      runners[0]?.crash();
      await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS);
      expect(runnerFactory).toHaveBeenCalledTimes(2);

      // Crash runner #2 immediately (before the stability window) → backoff grew
      // to 2 × initial, so the next restart fires only after 1000ms.
      runners[1]?.crash();
      await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS); // 500ms: not enough
      expect(runnerFactory).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS); // +500ms = 1000ms total
      expect(runnerFactory).toHaveBeenCalledTimes(3);

      // Runner #3 completes a real poll and STAYS UP past the 30s stability
      // window → the backoff resets to the initial delay. Then crash it: the
      // next restart fires at INITIAL again (500ms), proving the reset (a
      // non-reset path would wait 2000ms).
      await bot.api.getUpdates({});
      await vi.advanceTimersByTimeAsync(30_000);
      runners[2]?.crash();
      await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS);
      expect(runnerFactory).toHaveBeenCalledTimes(4);

      await result.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("startTelegramAdapter poll-liveness watchdog", () => {
  it("bounds sustained loss, then emits one degraded and one proven recovery edge", async () => {
    vi.useFakeTimers();
    try {
      const { bot } = recordingBot();
      const warnings: string[] = [];
      const onPollingError = vi.fn();
      const onPollingRecovered = vi.fn();
      const runnerFactory = vi.fn(() => new FakeRunner());

      const result = await startTelegramAdapter({
        botToken: "test-token",
        allowAllChats: true,
        responder: { respond: vi.fn() } satisfies AgentResponder,
        deleteWebhookOnStart: false,
        logger: { warn: (message) => { warnings.push(message); } },
        onPollingError,
        onPollingRecovered,
        botFactory: () => bot,
        runnerFactory,
      });

      expect(runnerFactory).toHaveBeenCalledTimes(1);

      // No getUpdates ever resolves (the FakeRunner never calls it), so the
      // heartbeat stays stale. The default watchdog remains exactly 120s and
      // force-restarts at that bound even though the runner reports running and
      // its task never rejected.
      await vi.advanceTimersByTimeAsync(119_999);
      expect(runnerFactory).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(runnerFactory).toHaveBeenCalledTimes(2);
      expect(warnings.some((w) => /poll liveness stalled/i.test(w))).toBe(true);
      expect(onPollingError).toHaveBeenCalledTimes(1);
      expect(onPollingRecovered).not.toHaveBeenCalled();

      // A runner merely surviving 30s is not enough: keep its real poll heartbeat
      // fresh throughout the stability window, then recovery fires exactly once.
      for (let elapsed = 0; elapsed < 30_000; elapsed += 10_000) {
        await vi.advanceTimersByTimeAsync(10_000);
        await bot.api.getUpdates({});
      }
      expect(runnerFactory).toHaveBeenCalledTimes(2);
      expect(onPollingError).toHaveBeenCalledTimes(1);
      expect(onPollingRecovered).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await bot.api.getUpdates({});
      expect(onPollingRecovered).toHaveBeenCalledTimes(1);

      await result.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT restart while getUpdates keeps resolving (fresh polls)", async () => {
    vi.useFakeTimers();
    try {
      const { bot } = recordingBot();
      const runnerFactory = vi.fn(() => new FakeRunner());

      const result = await startTelegramAdapter({
        botToken: "test-token",
        allowAllChats: true,
        responder: { respond: vi.fn() } satisfies AgentResponder,
        deleteWebhookOnStart: false,
        pollWatchdogMs: 3000,
        botFactory: () => bot,
        runnerFactory,
      });

      // Each gap (2000ms) is under the 3000ms window, and every getUpdates
      // resolution refreshes the heartbeat — so the watchdog must never fire.
      for (let i = 0; i < 5; i += 1) {
        await vi.advanceTimersByTimeAsync(2000);
        await bot.api.getUpdates({});
      }
      expect(runnerFactory).toHaveBeenCalledTimes(1);

      await result.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() clears the watchdog so no restart fires after teardown", async () => {
    vi.useFakeTimers();
    try {
      const { bot } = recordingBot();
      const runnerFactory = vi.fn(() => new FakeRunner());

      const result = await startTelegramAdapter({
        botToken: "test-token",
        allowAllChats: true,
        responder: { respond: vi.fn() } satisfies AgentResponder,
        deleteWebhookOnStart: false,
        pollWatchdogMs: 3000,
        botFactory: () => bot,
        runnerFactory,
      });

      await vi.advanceTimersByTimeAsync(1000);
      await result.stop();

      // Well past the watchdog window: a cleared watchdog must not respawn.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(runnerFactory).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can be disabled with pollWatchdogMs <= 0", async () => {
    vi.useFakeTimers();
    try {
      const { bot } = recordingBot();
      const runnerFactory = vi.fn(() => new FakeRunner());

      const result = await startTelegramAdapter({
        botToken: "test-token",
        allowAllChats: true,
        responder: { respond: vi.fn() } satisfies AgentResponder,
        deleteWebhookOnStart: false,
        pollWatchdogMs: 0,
        botFactory: () => bot,
        runnerFactory,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(runnerFactory).toHaveBeenCalledTimes(1);

      await result.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("startTelegramAdapter startup deleteWebhook resilience", () => {
  /** A bot whose deleteWebhook fails the given way; every other call is a no-op ok. */
  function botWithDeleteWebhook(behavior: "reject" | "hang"): Bot {
    const bot = new Bot("test-token", { botInfo: FAKE_BOT_INFO });
    bot.api.config.use(async (_prev, method, _payload, signal) => {
      if (method === "deleteWebhook") {
        if (behavior === "reject") {
          throw new Error("getUpdates ETIMEDOUT");
        }
        // Hang until the caller's timeout signal aborts the call.
        return await new Promise((_resolve, reject) => {
          const abortSignal = signal as AbortSignal | undefined;
          abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return { ok: true, result: true } as never;
    });
    return bot;
  }

  it("start() resolves and polls when deleteWebhook rejects at startup", async () => {
    const warnings: string[] = [];
    let runner: FakeRunner | undefined;

    const result = await startTelegramAdapter({
      botToken: "test-token",
      allowAllChats: true,
      responder: { respond: vi.fn() } satisfies AgentResponder,
      deleteWebhookOnStart: true,
      logger: { warn: (message) => { warnings.push(message); } },
      botFactory: () => botWithDeleteWebhook("reject"),
      runnerFactory: () => {
        runner = new FakeRunner();
        return runner;
      },
    });

    expect(runner?.isRunning()).toBe(true);
    expect(warnings.some((w) => /deleteWebhook/i.test(w))).toBe(true);
    await result.stop();
  });

  it("start() returns within the bound when deleteWebhook hangs", async () => {
    let runner: FakeRunner | undefined;

    // Real timers + a tiny bound: a hanging deleteWebhook is aborted at ~30ms and
    // start() proceeds to spawn the runner rather than blocking on the network.
    const result = await startTelegramAdapter({
      botToken: "test-token",
      allowAllChats: true,
      responder: { respond: vi.fn() } satisfies AgentResponder,
      deleteWebhookOnStart: true,
      deleteWebhookTimeoutMs: 30,
      botFactory: () => botWithDeleteWebhook("hang"),
      runnerFactory: () => {
        runner = new FakeRunner();
        return runner;
      },
    });

    expect(runner?.isRunning()).toBe(true);
    await result.stop();
  });
});

describe("startTelegramAdapter onPollingRecovered", () => {
  /** A runner that stays pending (healthy) until crash() rejects its task. */
  class RecoverableRunner implements RunnerHandle {
    running = true;
    private reject: ((error: Error) => void) | undefined;
    private readonly promise = new Promise<void>((_resolve, rej) => { this.reject = rej; });
    start(): void { this.running = true; }
    stop(): Promise<void> { this.running = false; return Promise.resolve(); }
    size(): number { return 0; }
    task(): Promise<void> | undefined { return this.promise; }
    isRunning(): boolean { return this.running; }
    crash(): void { this.running = false; this.reject?.(new Error("getUpdates ETIMEDOUT")); }
  }

  const STABILITY_MS = 30_000;

  it("fires only after a restarted runner is stable and completes a successful poll", async () => {
    vi.useFakeTimers();
    try {
      const { bot } = recordingBot();
      const onPollingRecovered = vi.fn();
      const runners: RecoverableRunner[] = [];
      const runnerFactory = vi.fn(() => { const r = new RecoverableRunner(); runners.push(r); return r; });

      const result = await startTelegramAdapter({
        botToken: "test-token",
        allowAllChats: true,
        responder: { respond: vi.fn() } satisfies AgentResponder,
        deleteWebhookOnStart: false,
        pollWatchdogMs: 0,
        onPollingRecovered,
        botFactory: () => bot,
        runnerFactory,
      });

      expect(runnerFactory).toHaveBeenCalledTimes(1);
      // Crash the initial runner → backoff restart at 500ms spawns runner #2.
      runners[0]?.crash();
      await vi.advanceTimersByTimeAsync(500);
      expect(runnerFactory).toHaveBeenCalledTimes(2);

      // Merely surviving the stability window while still retrying is not proof
      // of recovery, so the callback remains silent without a successful poll.
      expect(onPollingRecovered).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(STABILITY_MS);
      expect(onPollingRecovered).not.toHaveBeenCalled();

      // A real poll resolution from runner #2 proves connectivity and emits the
      // recovery edge immediately because stability is already established.
      await bot.api.getUpdates({});
      expect(onPollingRecovered).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(STABILITY_MS);
      expect(onPollingRecovered).toHaveBeenCalledTimes(1);

      await result.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not credit a late poll completion from the stopped runner to its replacement", async () => {
    vi.useFakeTimers();
    try {
      let releaseOldPoll!: () => void;
      let pollCalls = 0;
      const bot = new Bot("test-token", { botInfo: FAKE_BOT_INFO });
      bot.api.config.use(async (_prev, method) => {
        if (method === "getUpdates" && pollCalls++ === 0) {
          await new Promise<void>((resolve) => { releaseOldPoll = resolve; });
        }
        return { ok: true, result: [] } as never;
      });
      const onPollingRecovered = vi.fn();
      const runners: RecoverableRunner[] = [];
      const result = await startTelegramAdapter({
        botToken: "test-token",
        allowAllChats: true,
        responder: { respond: vi.fn() } satisfies AgentResponder,
        deleteWebhookOnStart: false,
        pollWatchdogMs: 0,
        onPollingRecovered,
        botFactory: () => bot,
        runnerFactory: () => {
          const runner = new RecoverableRunner();
          runners.push(runner);
          return runner;
        },
      });

      const oldPoll = bot.api.getUpdates({});
      runners[0]?.crash();
      await vi.advanceTimersByTimeAsync(500 + STABILITY_MS);
      releaseOldPoll();
      await oldPoll;
      expect(onPollingRecovered).not.toHaveBeenCalled();

      await bot.api.getUpdates({});
      expect(onPollingRecovered).toHaveBeenCalledTimes(1);
      await result.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT fire on the initial healthy start (no prior crash)", async () => {
    vi.useFakeTimers();
    try {
      const { bot } = recordingBot();
      const onPollingRecovered = vi.fn();

      const result = await startTelegramAdapter({
        botToken: "test-token",
        allowAllChats: true,
        responder: { respond: vi.fn() } satisfies AgentResponder,
        deleteWebhookOnStart: false,
        pollWatchdogMs: 0,
        onPollingRecovered,
        botFactory: () => bot,
        runnerFactory: () => new FakeRunner(),
      });

      // The initial runner crosses the stability window, but with no prior crash
      // there is nothing to recover from.
      await vi.advanceTimersByTimeAsync(STABILITY_MS * 2);
      expect(onPollingRecovered).not.toHaveBeenCalled();

      await result.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT fire if the runner crashes again before the stability window", async () => {
    vi.useFakeTimers();
    try {
      const { bot } = recordingBot();
      const onPollingRecovered = vi.fn();
      const runners: RecoverableRunner[] = [];
      const runnerFactory = vi.fn(() => { const r = new RecoverableRunner(); runners.push(r); return r; });

      const result = await startTelegramAdapter({
        botToken: "test-token",
        allowAllChats: true,
        responder: { respond: vi.fn() } satisfies AgentResponder,
        deleteWebhookOnStart: false,
        pollWatchdogMs: 0,
        onPollingRecovered,
        botFactory: () => bot,
        runnerFactory,
      });

      runners[0]?.crash();
      await vi.advanceTimersByTimeAsync(500);
      expect(runnerFactory).toHaveBeenCalledTimes(2);
      // Crash again BEFORE the restarted runner stabilizes → no recovery.
      runners[1]?.crash();
      await vi.advanceTimersByTimeAsync(STABILITY_MS);
      expect(onPollingRecovered).not.toHaveBeenCalled();

      await result.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT fire a stale recovery across a stop()/start() cycle", async () => {
    vi.useFakeTimers();
    try {
      const { bot } = recordingBot();
      const onPollingRecovered = vi.fn();
      const runners: RecoverableRunner[] = [];
      const controller = createTelegramBot({
        botToken: "test-token",
        allowAllChats: true,
        responder: { respond: vi.fn() } satisfies AgentResponder,
        deleteWebhookOnStart: false,
        pollWatchdogMs: 0,
        onPollingRecovered,
        botFactory: () => bot,
        runnerFactory: () => { const r = new RecoverableRunner(); runners.push(r); return r; },
      });

      await controller.start();
      runners[0]?.crash();        // sets the crash flag, then we stop before recovery
      await controller.stop();
      // A fresh start must clear the stale flag: the new runner staying up is the
      // initial start of THIS session, not a recovery.
      await controller.start();
      await vi.advanceTimersByTimeAsync(STABILITY_MS * 2);
      expect(onPollingRecovered).not.toHaveBeenCalled();

      await controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards apiRoot so file downloads hit the self-hosted server", async () => {
    const { bot } = recordingBot();
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === "getFile") {
        const typed = payload as Record<string, unknown>;
        return { ok: true, result: { file_id: typed.file_id, file_unique_id: "u", file_path: "docs/file.bin" } } as never;
      }
      return await prev(method, payload, signal);
    });
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      urls.push(String(url));
      return new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;
    const requests: Array<{ attachments: unknown }> = [];

    try {
      const result = await startTelegramAdapter({
        botToken: "test-token",
        allowAllChats: true,
        responder: {
          async respond(request) {
            requests.push({ attachments: request.attachments });
            return { text: "ok" };
          },
        },
        stream: { editDebounceMs: 0 },
        apiRoot: "http://127.0.0.1:8081",
        botFactory: () => bot,
        runnerFactory: () => new FakeRunner(),
      });
      await bot.handleUpdate(documentUpdate("audio/mp4"));
      await result.stop();
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(urls).toEqual(["http://127.0.0.1:8081/file/bottest-token/docs/file.bin"]);
    expect(requests[0]?.attachments).toBeDefined();
  });
});
