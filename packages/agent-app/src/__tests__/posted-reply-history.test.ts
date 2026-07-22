import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentMessageStream,
  AgentRequestBase,
  AgentResponder,
} from "@mono-agent/agent-contracts";
import {
  createAgentHarness,
  createAgentResponder,
  createInMemoryHistoryStore,
  type ConversationHistoryStore,
  type HistoryMessage,
} from "@mono-agent/agent-harness";
import type {
  MonoRuntimeLike,
  RuntimeResult,
  RuntimeRunOptions,
} from "@mono-agent/runtime-adapter";

import { createSlackPostedReplyHistory } from "../posted-reply-history.js";

const MODEL = {
  sdk: "pi",
  provider: "fake",
  model: "fake-model",
  reference: "pi:fake:fake-model",
} as const;
const PRODUCER = "cron:scheduled-scan";
const CHANNEL = "C123";
const THREAD_TS = "1784242800.000100";
const PHYSICAL = `slack:${CHANNEL}:${THREAD_TS}`;
const RECEIPT_KEY = `adapter-send:slack:${CHANNEL}:${THREAD_TS}`;
const SENT_TEXT = "Exact proactive Slack delivery.";
const STIMULUS = "[A scheduled or triggered task produced the message below, delivered to you proactively.]";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

function noopStream(): AgentMessageStream {
  return { append: async () => undefined };
}

function slackReplyRequest(input: {
  readonly producer?: string;
  readonly channelId?: string;
  readonly threadTs?: string;
  readonly messageTs?: string;
  readonly metadata?: AgentRequestBase["metadata"];
} = {}): AgentRequestBase {
  const channelId = input.channelId ?? CHANNEL;
  const threadTs = input.threadTs ?? THREAD_TS;
  return {
    conversationId: input.producer ?? PRODUCER,
    replyTo: { conversationId: `slack:${channelId}:${threadTs}` },
    text: "What did you send?",
    abortSignal: new AbortController().signal,
    metadata: input.metadata ?? {
      slack: {
        channel: { id: channelId },
        message: { ts: input.messageTs ?? `${Number(threadTs) + 1}`, threadTs },
      },
    },
  };
}

async function seedDelivery(
  store: ConversationHistoryStore,
  conversationId = PHYSICAL,
  options: {
    readonly text?: string;
    readonly receiptKey?: string;
    readonly timestamp?: string;
  } = {},
): Promise<void> {
  const timestamp = options.timestamp ?? "2026-07-16T23:00:00.000Z";
  await store.append(conversationId, [
    { role: "user", content: STIMULUS, timestamp },
    {
      role: "assistant",
      content: options.text ?? SENT_TEXT,
      timestamp,
      idempotencyKey: options.receiptKey ?? RECEIPT_KEY,
    },
  ]);
}

async function identityFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-app-posted-reply-history-"));
  tempDirs.push(dir);
  const identityPath = join(dir, "IDENTITY.md");
  await writeFile(identityPath, "You are Mono.", "utf8");
  return identityPath;
}

function observingRuntime(
  result: (call: number) => RuntimeResult = () => ({ text: "Model reply." }),
): {
  readonly runtime: MonoRuntimeLike;
  readonly calls: Array<{ readonly prompt: string; readonly options: RuntimeRunOptions }>;
} {
  const calls: Array<{ readonly prompt: string; readonly options: RuntimeRunOptions }> = [];
  return {
    calls,
    runtime: {
      async run(prompt, options) {
        calls.push({ prompt, options });
        return result(calls.length);
      },
    },
  };
}

async function captureLoad(
  bridge: ReturnType<typeof createSlackPostedReplyHistory>,
  store: ConversationHistoryStore,
  request: AgentRequestBase,
): Promise<readonly HistoryMessage[]> {
  let captured: readonly HistoryMessage[] | undefined;
  const responder = bridge.wrapResponder({
    async respond(activeRequest) {
      captured = await store.load(activeRequest.conversationId);
      return { text: "ok" };
    },
  });
  await responder.respond(request, noopStream());
  if (captured === undefined) throw new Error("test responder did not load history");
  return captured;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("createSlackPostedReplyHistory", () => {
  it("forwards conversation reset controls through both decorators", async () => {
    const reset = vi.fn(async () => undefined);
    const startNewSession = vi.fn(async () => undefined);
    const bridge = createSlackPostedReplyHistory({ maxMessages: 64 });
    const history = bridge.wrapHistoryStore({
      load: async () => [],
      append: async () => undefined,
      reset,
    });
    const responder = bridge.wrapResponder({
      respond: async () => ({ text: "ok" }),
      startNewSession,
    } as AgentResponder & { startNewSession(conversationId: string): Promise<void> });

    await history.reset?.("telegram:42");
    await (responder as AgentResponder & {
      startNewSession?: (conversationId: string) => Promise<void>;
    }).startNewSession?.("telegram:42");

    expect(reset).toHaveBeenCalledWith("telegram:42");
    expect(startNewSession).toHaveBeenCalledWith("telegram:42");
  });

  it("adds the exact destination receipt once to a cold real replay without changing producer history", async () => {
    const identityPath = await identityFixture();
    const canonical = createInMemoryHistoryStore({ maxMessages: 64 });
    await canonical.append(PRODUCER, [
      { role: "user", content: "Run the scheduled scan.", timestamp: "2026-07-16T22:00:00.000Z" },
      { role: "assistant", content: "The scan completed.", timestamp: "2026-07-16T22:01:00.000Z" },
    ]);
    await seedDelivery(canonical);

    const bridge = createSlackPostedReplyHistory({ maxMessages: 64 });
    const runtime = observingRuntime();
    const harness = createAgentHarness({
      identityPath,
      runtime: runtime.runtime,
      model: MODEL,
      executionMode: "sdk",
      historyStore: bridge.wrapHistoryStore(canonical),
    });
    const responder = bridge.wrapResponder(createAgentResponder({ harness }));

    try {
      const response = await responder.respond(slackReplyRequest(), noopStream());
      expect(response.text).toBe("Model reply.");
      expect(runtime.calls).toHaveLength(1);
      const providerInput = [
        runtime.calls[0]?.prompt ?? "",
        ...(runtime.calls[0]?.options.messages ?? []).map((message) => String(message.content)),
      ].join("\n");
      expect(occurrences(providerInput, SENT_TEXT)).toBe(1);

      const producerHistory = await canonical.load(PRODUCER);
      expect(producerHistory.map((message) => message.content)).toEqual([
        "Run the scheduled scan.",
        "The scan completed.",
        "What did you send?",
        "Model reply.",
      ]);
      expect(producerHistory.some((message) => message.content === SENT_TEXT)).toBe(false);
      expect((await canonical.load(PHYSICAL)).filter((message) => message.content === SENT_TEXT)).toHaveLength(1);
    } finally {
      await harness.dispose?.();
    }
  });

  it("strictly excludes same-id, continuation, and unauthenticated Slack request shapes", async () => {
    const canonical = createInMemoryHistoryStore({ maxMessages: 64 });
    await canonical.append(PRODUCER, [
      { role: "assistant", content: "Producer canonical only.", timestamp: "2026-07-16T22:00:00.000Z" },
    ]);
    await seedDelivery(canonical);
    const bridge = createSlackPostedReplyHistory({ maxMessages: 64 });
    const wrapped = bridge.wrapHistoryStore(canonical);

    const sameId = await captureLoad(
      bridge,
      wrapped,
      slackReplyRequest({ producer: PHYSICAL }),
    );
    expect(sameId.filter((message) => message.content === SENT_TEXT)).toHaveLength(1);
    expect(sameId).toHaveLength(2);

    const continuation = {
      ...slackReplyRequest(),
      continuation: {
        continuationId: "continuation-1",
        originRunId: "origin-run-1",
        originContextPolicy: "detached_latest",
        toolsDisabled: true,
        deferHistoryCommit: true,
      } as const,
    };
    const { metadata: _metadata, ...missingMetadata } = slackReplyRequest();
    const excluded: ReadonlyArray<readonly [string, AgentRequestBase]> = [
      ["continuation", continuation],
      ["missing metadata", missingMetadata],
      [
        "wrong channel metadata",
        slackReplyRequest({
          metadata: {
            slack: {
              channel: { id: "C999" },
              message: { ts: `${Number(THREAD_TS) + 1}`, threadTs: THREAD_TS },
            },
          },
        }),
      ],
      [
        "missing thread metadata",
        slackReplyRequest({
          metadata: { slack: { channel: { id: CHANNEL }, message: { ts: `${Number(THREAD_TS) + 1}` } } },
        }),
      ],
      [
        "top-level rather than reply metadata",
        slackReplyRequest({
          metadata: { slack: { channel: { id: CHANNEL }, message: { ts: THREAD_TS, threadTs: THREAD_TS } } },
        }),
      ],
    ];

    for (const [label, request] of excluded) {
      const seen = await captureLoad(bridge, wrapped, request);
      expect(seen, label).toEqual([
        expect.objectContaining({ content: "Producer canonical only." }),
      ]);
    }
  });

  it("does not overlay a destination assistant entry with the wrong receipt key", async () => {
    const canonical = createInMemoryHistoryStore({ maxMessages: 64 });
    await canonical.append(PRODUCER, [
      { role: "assistant", content: "Producer canonical only.", timestamp: "2026-07-16T22:00:00.000Z" },
    ]);
    await seedDelivery(canonical, PHYSICAL, { receiptKey: "adapter-send:slack:C123:different-ts" });
    const bridge = createSlackPostedReplyHistory({ maxMessages: 64 });

    const seen = await captureLoad(bridge, bridge.wrapHistoryStore(canonical), slackReplyRequest());
    expect(seen.map((message) => message.content)).toEqual(["Producer canonical only."]);
  });

  it("finds the receipt in its send-day bucket when the real reply arrives in a later daily bucket", async () => {
    const sendTime = new Date("2026-07-17T02:00:00.000Z");
    const threadTs = `${sendTime.getTime() / 1_000}.000100`;
    const channelId = "CDAILY";
    const physical = `slack:${channelId}:${threadTs}`;
    const receiptKey = `adapter-send:slack:${channelId}:${threadTs}`;
    const producer = `${PRODUCER}#2026-07-17`;
    const canonical = createInMemoryHistoryStore({ maxMessages: 64 });
    await canonical.append(producer, [
      { role: "assistant", content: "Current producer bucket.", timestamp: "2026-07-17T12:00:00.000Z" },
    ]);
    // 02:00 UTC is still July 16 in New York; this is intentionally not the
    // producer's July 17 reply bucket.
    await seedDelivery(canonical, `${physical}#2026-07-16`, {
      receiptKey,
      timestamp: sendTime.toISOString(),
    });
    const bridge = createSlackPostedReplyHistory({
      maxMessages: 64,
      rollover: "daily",
      rolloverTimezone: "America/New_York",
    });

    const seen = await captureLoad(bridge, bridge.wrapHistoryStore(canonical), slackReplyRequest({
      producer,
      channelId,
      threadTs,
      messageTs: `${Number(threadTs) + 43_200}`,
    }));
    expect(seen.filter((message) => message.content === SENT_TEXT)).toHaveLength(1);
    expect((await canonical.load(producer)).map((message) => message.content)).toEqual(["Current producer bucket."]);
  });

  it("keeps the supplemental replay bounded to 64 messages", async () => {
    const canonical = createInMemoryHistoryStore({ maxMessages: 100 });
    await canonical.append(PRODUCER, Array.from({ length: 64 }, (_, index): HistoryMessage => ({
      role: "assistant",
      content: `canonical-${index}`,
      timestamp: new Date(Date.UTC(2026, 6, 16, 20, 0, index)).toISOString(),
    })));
    await seedDelivery(canonical, PHYSICAL, { timestamp: "2026-07-16T23:00:00.000Z" });
    const bridge = createSlackPostedReplyHistory({ maxMessages: 64 });

    const seen = await captureLoad(bridge, bridge.wrapHistoryStore(canonical), slackReplyRequest());
    expect(seen).toHaveLength(64);
    expect(seen[0]?.content).toBe("canonical-2");
    expect(seen.filter((message) => message.content === STIMULUS)).toHaveLength(1);
    expect(seen.filter((message) => message.content === SENT_TEXT)).toHaveLength(1);
    expect(await canonical.load(PRODUCER)).toHaveLength(64);
  });

  it("keeps concurrent posted-reply scopes isolated", async () => {
    const canonical = createInMemoryHistoryStore({ maxMessages: 64 });
    const producerA = "cron:producer-a";
    const producerB = "cron:producer-b";
    const channelA = "CA";
    const channelB = "CB";
    const threadA = "1784242801.000100";
    const threadB = "1784242802.000100";
    const sentA = "Destination delivery A";
    const sentB = "Destination delivery B";
    await canonical.append(producerA, [{ role: "assistant", content: "producer A", timestamp: "2026-07-16T20:00:00Z" }]);
    await canonical.append(producerB, [{ role: "assistant", content: "producer B", timestamp: "2026-07-16T20:00:00Z" }]);
    await seedDelivery(canonical, `slack:${channelA}:${threadA}`, {
      text: sentA,
      receiptKey: `adapter-send:slack:${channelA}:${threadA}`,
    });
    await seedDelivery(canonical, `slack:${channelB}:${threadB}`, {
      text: sentB,
      receiptKey: `adapter-send:slack:${channelB}:${threadB}`,
    });
    const bridge = createSlackPostedReplyHistory({ maxMessages: 64 });
    const wrapped = bridge.wrapHistoryStore(canonical);
    const captured = new Map<string, readonly HistoryMessage[]>();
    let entered = 0;
    let releaseBoth!: () => void;
    const bothEntered = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const responder = bridge.wrapResponder({
      async respond(request) {
        entered += 1;
        if (entered === 2) releaseBoth();
        await bothEntered;
        captured.set(request.conversationId, await wrapped.load(request.conversationId));
        return { text: "ok" };
      },
    });

    await Promise.all([
      responder.respond(slackReplyRequest({ producer: producerA, channelId: channelA, threadTs: threadA }), noopStream()),
      responder.respond(slackReplyRequest({ producer: producerB, channelId: channelB, threadTs: threadB }), noopStream()),
    ]);

    expect(captured.get(producerA)?.map((message) => message.content)).toContain(sentA);
    expect(captured.get(producerA)?.map((message) => message.content)).not.toContain(sentB);
    expect(captured.get(producerB)?.map((message) => message.content)).toContain(sentB);
    expect(captured.get(producerB)?.map((message) => message.content)).not.toContain(sentA);
  });

  it("keeps a warm provider's tool transcript authoritative without injecting a duplicate receipt", async () => {
    const identityPath = await identityFixture();
    const canonical = createInMemoryHistoryStore({ maxMessages: 64 });
    const loadedConversationIds: string[] = [];
    const countingStore: ConversationHistoryStore = {
      async load(conversationId) {
        loadedConversationIds.push(conversationId);
        return await canonical.load(conversationId);
      },
      async append(conversationId, messages) {
        await canonical.append(conversationId, messages);
      },
    };
    const bridge = createSlackPostedReplyHistory({ maxMessages: 64 });
    const providerTranscript: string[] = [];
    const runtime = observingRuntime((call) => {
      if (call === 2) providerTranscript.push(SENT_TEXT);
      return { text: "Model reply.", providerSessionId: "provider-session-1" };
    });
    const harness = createAgentHarness({
      identityPath,
      runtime: runtime.runtime,
      model: MODEL,
      executionMode: "sdk",
      historyStore: bridge.wrapHistoryStore(countingStore),
      session: { mode: "continuous", idleTimeoutMs: 60_000, supportsResume: true },
    });
    const responder = bridge.wrapResponder(createAgentResponder({ harness }));

    try {
      await responder.respond({
        conversationId: PRODUCER,
        text: "Prime the provider session.",
        abortSignal: new AbortController().signal,
      }, noopStream());
      const loadsAfterColdTurn = [...loadedConversationIds];

      // This warm producer turn represents the real tool call: the provider owns
      // its tool arguments/result in the resumed transcript, while the confirmed
      // receipt is committed only under the physical Slack destination.
      await responder.respond({
        conversationId: PRODUCER,
        text: "Send the proactive update.",
        abortSignal: new AbortController().signal,
      }, noopStream());
      await seedDelivery(canonical);

      await responder.respond(slackReplyRequest(), noopStream());

      expect(loadedConversationIds).toEqual(loadsAfterColdTurn);
      expect(runtime.calls[1]?.options.sessionId).toBe("provider-session-1");
      expect(runtime.calls[2]?.options.sessionId).toBe("provider-session-1");
      const warmProviderInput = [
        runtime.calls[2]?.prompt ?? "",
        ...(runtime.calls[2]?.options.messages ?? []).map((message) => String(message.content)),
      ].join("\n");
      expect(warmProviderInput).not.toContain(SENT_TEXT);
      expect(occurrences([...providerTranscript, warmProviderInput].join("\n"), SENT_TEXT)).toBe(1);
      expect((await canonical.load(PRODUCER)).some((message) => message.content === SENT_TEXT)).toBe(false);
    } finally {
      await harness.dispose?.();
    }
  });
});
