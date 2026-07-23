import { randomUUID } from "node:crypto";

import type {
  AgentInteractionHandler, Channel, ChannelOutboundMessage, ChannelReplyEvent,
} from "@mono-agent/module-sdk";
import type { StateExecutionRequest } from "@mono-agent/module-sdk/internal";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentHost } from "../host.js";
import type { AgentHost } from "../types.js";
import { MemoryStateStore } from "./durable-state-fixture.js";
import {
  completed,
  createFixtureProject,
  minimalConfig,
  runtimeController,
  type FixtureProject,
} from "./fixture.js";

const projects: FixtureProject[] = [];
const hosts: AgentHost[] = [];
const channelCapabilities = {
  attachments: true, liveInput: false, askUser: false, approvals: false,
  proactive: true, runtimeControl: false, verbatim: true, cancellation: false,
} as const;

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.stop()));
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

describe("channel kernel", () => {
  it("qualifies repeated instance tools and rejects reserved-name collisions", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtime = `@fixture/runtime-channel-tools-${suffix}`;
    const channels = ["alpha", "beta"].map((id) => ({
      id, packageName: `@fixture/channel-tools-${id}-${suffix}`,
    }));
    let names: string[] = [];
    const project = await tracked([
      {
        name: runtime, kind: "runtime" as const,
        controller: runtimeController((request) => {
          names = toolNames(request);
          return completed("ok");
        }),
      },
      ...channels.map(({ packageName }) => ({
        name: packageName, kind: "channel" as const,
        controller: { create: () => channel([sendTool("ChannelSend", "destination")]) },
      })),
    ]);
    await project.writeConfig(minimalConfig(runtime, {
      channels: Object.fromEntries(channels.map(({ id, packageName }) => [id, { $use: packageName }])),
      policy: allowPolicy(),
    }));
    const host = await started(project);
    await host.submit({ requestId: "qualified", conversationId: "producer", text: "go" });
    expect(names).toHaveLength(2);
    expect(names.every((name) => /^channel__[A-Za-z0-9_-]{43}$/u.test(name))).toBe(true);
    expect(new Set(names).size).toBe(2);
    await host.stop();
    hosts.splice(hosts.indexOf(host), 1);
    names = [];
    await project.writeConfig(minimalConfig(runtime, {
      channels: Object.fromEntries(channels.map(({ id, packageName }) => [id, { $use: packageName }])),
      policy: { tools: { default: "deny" }, approvals: { default: "allow" }, sandbox: { mode: "off" } },
    }));
    const denied = await started(project);
    await denied.submit({ requestId: "denied", conversationId: "producer", text: "go" });
    expect(names).toEqual([]);

    const reserved = await tracked([
      { name: `${runtime}-reserved`, kind: "runtime", controller: runtimeController(() => completed("unused")) },
      {
        name: `${channels[0]!.packageName}-reserved`, kind: "channel",
        controller: { create: () => channel([sendTool("RunHistory", "destination")]) },
      },
    ]);
    await reserved.writeConfig(minimalConfig(`${runtime}-reserved`, {
      channels: { reserved: { $use: `${channels[0]!.packageName}-reserved` } },
    }));
    await expect(createAgentHost(reserved.configPath)).rejects.toThrow(/RunHistory conflicts/u);
  });

  it("governs send tools and retries an atomic post-commit response loss without resending", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtime = `@fixture/runtime-channel-history-${suffix}`;
    const stateName = `@fixture/state-channel-history-${suffix}`;
    const channelName = `@fixture/channel-history-${suffix}`;
    const state = new MemoryStateStore();
    let sends = 0;
    let results: unknown[] = [];
    const project = await tracked([
      {
        name: runtime, kind: "runtime",
        controller: runtimeController(async (request, context) => {
          const execute = method(context, "executeTool");
          const tool = toolNames(request).find((name) => name === "ChannelSend");
          if (tool === undefined) throw new Error("ChannelSend was not visible");
          results = [await execute(
            { id: "same-call", name: tool, input: { text: "hello" } },
            signalOf(request),
          )];
          return completed("done");
        }),
      },
      { name: stateName, kind: "state", controller: { create: () => state } },
      {
        name: channelName, kind: "channel",
        controller: { create: () => channel([sendTool("ChannelSend", "destination")], async (message) => {
          sends += 1;
          return { status: "delivered", idempotencyKey: message.idempotencyKey, messageId: "message-1" };
        }) },
      },
    ]);
    await project.writeConfig(minimalConfig(runtime, {
      state: { $use: stateName }, channels: { notify: { $use: channelName } },
      policy: { tools: { default: "deny", allow: ["ChannelSend"] },
        approvals: { default: "ask", timeoutMs: 1_000 }, sandbox: { mode: "off" } },
    }));
    let failResponse = true;
    state.shouldFailExecutionAfter = (operation) => {
      if (operation !== "delivery.settle-with-history" || !failResponse) return false;
      failResponse = false;
      return true;
    };
    const approvals: string[] = [];
    const handler: AgentInteractionHandler = {
      async askUser() { throw new Error("not expected"); },
      async requestApproval(request) {
        approvals.push(request.toolId);
        return { interactionId: request.interactionId, decision: "allow_once", decidedAt: new Date().toISOString() };
      },
    };
    const host = await started(project);
    await host.submit({
      requestId: "history-request", conversationId: "producer", text: "go", interactionHandler: handler,
    });
    expect(sends).toBe(1);
    expect(approvals).toEqual(["ChannelSend"]);
    expect(results[0]).not.toHaveProperty("isError");
    expect((await host.replay("destination")).messages).toEqual([
      expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "hello" }] }),
    ]);
    await host.stop();
    hosts.splice(hosts.indexOf(host), 1);
    const restarted = await started(project);
    expect((await restarted.replay("destination")).messages).toHaveLength(1);
  });

  it("keeps an unknown delivery sticky and blocks later same-turn send effects", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtime = `@fixture/runtime-channel-conflict-${suffix}`;
    const stateName = `@fixture/state-channel-conflict-${suffix}`;
    const channelName = `@fixture/channel-conflict-${suffix}`;
    const state = new MemoryStateStore();
    let sends = 0;
    let outputs: unknown[] = [];
    const project = await tracked([
      {
        name: runtime, kind: "runtime",
        controller: runtimeController(async (request, context) => {
          const execute = method(context, "executeTool");
          outputs = [
            await execute({ id: "call-1", name: "ChannelSend", input: {} }, signalOf(request)),
            await execute({ id: "call-2", name: "ChannelSend", input: {} }, signalOf(request)),
          ];
          return completed("done");
        }),
      },
      { name: stateName, kind: "state", controller: { create: () => state } },
      {
        name: channelName, kind: "channel",
        controller: { create: () => channel([sendTool("ChannelSend", "destination")], async () => {
          sends += 1;
          throw new Error("ambiguous transport");
        }) },
      },
    ]);
    await project.writeConfig(minimalConfig(runtime, {
      state: { $use: stateName }, channels: { notify: { $use: channelName } }, policy: allowPolicy(),
    }));
    const host = await started(project);
    await expect(host.submit({
      requestId: "unknown-request", conversationId: "producer", text: "go",
    })).rejects.toThrow(/may have delivered without confirmed destination history/u);
    expect(sends).toBe(1);
    expect(outputs).toEqual([
      expect.objectContaining({ isError: true }),
      expect.objectContaining({ isError: true }),
    ]);
    expect((await host.replay("destination")).messages).toEqual([]);
  });

  it("propagates tool cancellation through deferred preparation and sends nothing", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtime = `@fixture/runtime-channel-cancel-${suffix}`;
    const stateName = `@fixture/state-channel-cancel-${suffix}`;
    const channelName = `@fixture/channel-cancel-${suffix}`;
    const state = new MemoryStateStore();
    let markEntered!: () => void;
    let releasePrepare!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const released = new Promise<void>((resolve) => { releasePrepare = resolve; });
    let sends = 0;
    let output: unknown;
    const project = await tracked([
      {
        name: runtime, kind: "runtime",
        controller: runtimeController(async (request, context) => {
          const controller = new AbortController();
          const pending = method(context, "executeTool")(
            { id: "cancelled-call", name: "ChannelSend", input: {} },
            controller.signal,
          );
          await entered;
          controller.abort();
          releasePrepare();
          output = await pending;
          return completed("done");
        }),
      },
      { name: stateName, kind: "state", controller: { create: () => state } },
      {
        name: channelName, kind: "channel",
        controller: { create: () => channel([{
          ...sendTool("ChannelSend", "destination"),
          async prepare() {
            markEntered();
            await released;
            return { conversationId: "destination", text: "must not send" };
          },
        }], async (message) => {
          sends += 1;
          return { status: "delivered", idempotencyKey: message.idempotencyKey };
        }) },
      },
    ]);
    await project.writeConfig(minimalConfig(runtime, {
      state: { $use: stateName }, channels: { notify: { $use: channelName } }, policy: allowPolicy(),
    }));
    const host = await started(project);
    await host.submit({ requestId: "cancelled-request", conversationId: "producer", text: "go" });
    expect(output).toMatchObject({ isError: true });
    expect(sends).toBe(0);
  });

  it("rejects state-incompatible projections before transport and handles a 25MB attachment", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtime = `@fixture/runtime-channel-preflight-${suffix}`;
    const stateName = `@fixture/state-channel-preflight-${suffix}`;
    const channelName = `@fixture/channel-preflight-${suffix}`;
    const state = new MemoryStateStore();
    const modes = ["text-nul", "name-nul", "id-nul", "media-nul", "name-oversize", "history-oversize", "large"] as const;
    const outputs: unknown[] = [];
    let sends = 0;
    let sentBytes = 0;
    const attachment = (name: string, data = new Uint8Array([1]), id = "attachment", mediaType = "application/octet-stream") => ({
      id, kind: "file" as const, name, mediaType, sizeBytes: data.byteLength, data,
    });
    const project = await tracked([
      {
        name: runtime, kind: "runtime",
        controller: runtimeController(async (request, context) => {
          const execute = method(context, "executeTool");
          for (const [index, mode] of modes.entries()) outputs.push(await execute(
            { id: `preflight-${String(index)}`, name: "ChannelSend", input: { mode } },
            signalOf(request),
          ));
          return completed("done");
        }),
      },
      { name: stateName, kind: "state", controller: { create: () => state } },
      {
        name: channelName, kind: "channel",
        controller: { create: () => channel([{
          ...sendTool("ChannelSend", "destination"),
          prepare(input: unknown) {
            const mode = isRecord(input) ? input.mode : undefined;
            if (mode === "text-nul") return { conversationId: "destination", text: "bad\0text" };
            if (mode === "name-nul") return { conversationId: "destination", text: "", attachments: [attachment("bad\0name")] };
            if (mode === "id-nul") return { conversationId: "destination", text: "", attachments: [attachment("ok", undefined, "bad\0id")] };
            if (mode === "media-nul") return { conversationId: "destination", text: "", attachments: [attachment("ok", undefined, "id", "text/plain\0")] };
            if (mode === "name-oversize") return { conversationId: "destination", text: "", attachments: [attachment("n".repeat(256))] };
            if (mode === "history-oversize") return {
              conversationId: "destination", text: "t".repeat(1_000_000), attachments: [attachment("extra")],
            };
            return {
              conversationId: "destination", text: "",
              attachments: [attachment("large.bin", new Uint8Array(25_000_000))],
            };
          },
        }], async (message) => {
          sends += 1;
          sentBytes = message.attachments?.[0]?.data.byteLength ?? 0;
          return { status: "delivered", idempotencyKey: message.idempotencyKey };
        }) },
      },
    ]);
    await project.writeConfig(minimalConfig(runtime, {
      state: { $use: stateName }, channels: { notify: { $use: channelName } }, policy: allowPolicy(),
    }));
    const host = await started(project);
    await host.submit({ requestId: "preflight-request", conversationId: "producer", text: "go" });
    expect(outputs.slice(0, -1).every((value) => isRecord(value) && value.isError === true)).toBe(true);
    expect(outputs.at(-1)).not.toHaveProperty("isError");
    expect({ sends, sentBytes }).toEqual({ sends: 1, sentBytes: 25_000_000 });
    expect((await host.replay("destination")).messages.at(-1)?.content)
      .toEqual([{ type: "text", text: "[sent attachment: large.bin]" }]);
  });

  it("atomically appends concurrent no-state deliveries to one destination history", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtime = `@fixture/runtime-channel-concurrent-${suffix}`;
    const channelName = `@fixture/channel-concurrent-${suffix}`;
    let turns = 0;
    let sends = 0;
    let release!: () => void;
    let bothEntered!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { bothEntered = resolve; });
    const project = await tracked([
      {
        name: runtime, kind: "runtime",
        controller: runtimeController(async (request, context) => {
          turns += 1;
          await method(context, "executeTool")(
            { id: "concurrent-call", name: "ChannelSend", input: { text: `delivery-${String(turns)}` } },
            signalOf(request),
          );
          return completed("done");
        }),
      },
      {
        name: channelName, kind: "channel",
        controller: { create: () => channel([sendTool("ChannelSend", "destination")], async (message) => {
          sends += 1;
          if (sends === 2) bothEntered();
          await released;
          return { status: "delivered", idempotencyKey: message.idempotencyKey };
        }) },
      },
    ]);
    await project.writeConfig(minimalConfig(runtime, {
      channels: { notify: { $use: channelName } }, policy: allowPolicy(),
    }));
    const host = await started(project);
    const pending = Promise.all([
      host.submit({ requestId: "concurrent-a", conversationId: "producer-a", text: "go" }),
      host.submit({ requestId: "concurrent-b", conversationId: "producer-b", text: "go" }),
    ]);
    await entered;
    release();
    await pending;
    expect(sends).toBe(2);
    expect((await host.replay("destination")).messages.map((message) =>
      message.content[0]?.type === "text" ? message.content[0].text : "")).toEqual(
      expect.arrayContaining(["delivery-1", "delivery-2"]),
    );
  });

  it("does not let a delayed state revision overwrite newer destination history", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtime = `@fixture/runtime-channel-revisions-${suffix}`;
    const stateName = `@fixture/state-channel-revisions-${suffix}`;
    const channelName = `@fixture/channel-revisions-${suffix}`;
    const state = new MemoryStateStore();
    const underlying = state.execution;
    const entries: Record<string, unknown>[] = [];
    let releaseFirst!: () => void;
    let markSecondLoad!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondLoaded = new Promise<void>((resolve) => { markSecondLoad = resolve; });
    let loads = 0;
    Object.defineProperty(state, "execution", {
      configurable: true,
      value: {
        async perform(request: StateExecutionRequest) {
          if (request.operation === "delivery.settle-with-history") {
            const result = await underlying.perform(request);
            const input = isRecord(request.input) ? request.input : {};
            if (isRecord(input.entry)
              && !entries.some((entry) => entry.entryId === input.entry.entryId))
              entries.push(input.entry);
            return result;
          }
          const input = isRecord(request.input) ? request.input : {};
          if (request.operation !== "conversation.load" || input.conversationId !== "destination")
            return underlying.perform(request);
          loads += 1;
          const revision = loads;
          if (revision === 1) await firstReleased;
          else markSecondLoad();
          const recordedAt = `2026-07-23T10:00:0${String(revision)}.000Z`;
          const transcript = {
            schemaVersion: 1, kind: "mono-agent.canonical-transcript", conversationId: "destination",
            revision, entries: entries.slice(0, revision).map((entry) => ({ ...entry, recordedAt })),
          };
          return {
            conversationId: "destination", createdAt: "2026-07-23T10:00:00.000Z",
            updatedAt: recordedAt, transcript,
          };
        },
      },
    });
    let turns = 0;
    let sends = 0;
    let releaseSends!: () => void;
    let markBothSends!: () => void;
    const sendsReleased = new Promise<void>((resolve) => { releaseSends = resolve; });
    const bothSends = new Promise<void>((resolve) => { markBothSends = resolve; });
    const project = await tracked([
      {
        name: runtime, kind: "runtime",
        controller: runtimeController(async (request, context) => {
          turns += 1;
          await method(context, "executeTool")(
            { id: "revision-call", name: "ChannelSend", input: { text: `revision-${String(turns)}` } },
            signalOf(request),
          );
          return completed("done");
        }),
      },
      { name: stateName, kind: "state", controller: { create: () => state } },
      {
        name: channelName, kind: "channel",
        controller: { create: () => channel([sendTool("ChannelSend", "destination")], async (message) => {
          sends += 1;
          if (sends === 2) markBothSends();
          await sendsReleased;
          return { status: "delivered", idempotencyKey: message.idempotencyKey };
        }) },
      },
    ]);
    await project.writeConfig(minimalConfig(runtime, {
      state: { $use: stateName }, channels: { notify: { $use: channelName } }, policy: allowPolicy(),
    }));
    const host = await started(project);
    const first = host.submit({ requestId: "revision-a", conversationId: "producer-a", text: "go" });
    const second = host.submit({ requestId: "revision-b", conversationId: "producer-b", text: "go" });
    await bothSends;
    releaseSends();
    await secondLoaded;
    await Promise.race([first, second]);
    releaseFirst();
    await Promise.all([first, second]);
    expect((await host.replay("destination")).messages.map((message) =>
      message.content[0]?.type === "text" ? message.content[0].text : "")).toEqual(
      expect.arrayContaining(["revision-1", "revision-2"]),
    );
  });

  it("persists 4,096-byte destinations and rejects larger ones before delivery", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtime = `@fixture/runtime-channel-destination-${suffix}`;
    const stateName = `@fixture/state-channel-destination-${suffix}`;
    const channelName = `@fixture/channel-destination-${suffix}`;
    const state = new MemoryStateStore();
    let destination = "";
    let result: unknown;
    let sends = 0;
    const project = await tracked([
      {
        name: runtime, kind: "runtime",
        controller: runtimeController(async (request, context) => {
          result = await method(context, "executeTool")(
            { id: "destination-call", name: "ChannelSend", input: {} },
            signalOf(request),
          );
          return completed("done");
        }),
      },
      { name: stateName, kind: "state", controller: { create: () => state } },
      {
        name: channelName, kind: "channel",
        controller: { create: () => channel([{
          ...sendTool("ChannelSend", "unused"),
          prepare: () => ({ conversationId: destination, text: "hello" }),
          historyConversationId: (message: ChannelOutboundMessage) => message.conversationId,
        }], async (message) => {
          sends += 1;
          return { status: "delivered", idempotencyKey: message.idempotencyKey };
        }) },
      },
    ]);
    await project.writeConfig(minimalConfig(runtime, {
      state: { $use: stateName }, channels: { notify: { $use: channelName } }, policy: allowPolicy(),
    }));
    const host = await started(project);
    for (const bytes of [513, 4_096]) {
      destination = "d".repeat(bytes);
      await host.submit({ requestId: `destination-${String(bytes)}`, conversationId: "producer", text: "go" });
      expect(result).not.toHaveProperty("isError");
      expect((await host.replay(destination)).messages).toEqual([
        expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "hello" }] }),
      ]);
    }
    destination = "d".repeat(4_097);
    await host.submit({ requestId: "destination-4097", conversationId: "producer", text: "go" });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("conversationId exceeds 4096 bytes");
    expect(sends).toBe(2);
  });

  it("redacts tool events, omits file bytes, and forwards neutral telemetry", async () => {
    const suffix = randomUUID().toLowerCase();
    const secret = "xyz";
    const shortSecret = "Z";
    const runtime = `@fixture/runtime-channel-events-${suffix}`;
    const channelName = `@fixture/channel-events-${suffix}`;
    let dispatch: ((request: unknown, reply: unknown) => Promise<unknown>) | undefined;
    const project = await tracked([
      {
        name: runtime, kind: "runtime",
        controller: runtimeController(async (_request, context) => {
          const emit = method(context, "emit");
          await emit({ type: "tool-call", call: {
            id: `before${secret}after`, name: secret,
            input: { arbitrary: `before${secret}after` },
          } });
          await emit({ type: "tool-result", result: { callId: secret, content: [
            { type: "text", text: shortSecret.repeat(1_000_000) },
            { type: "json", value: { arbitrary: secret } },
            { type: "file", mediaType: "text/plain", name: secret, data: new TextEncoder().encode(secret) },
          ] } });
          await emit({ type: "compaction", compaction: { compacted: true, tokensBefore: 10, tokensAfter: 5 } });
          await emit({ type: "usage", usage: { inputTokens: 10, outputTokens: 5, sessionEvicted: true } });
          return completed("done");
        }),
      },
      {
        name: channelName, kind: "channel",
        schema: {
          type: "object", additionalProperties: false, required: ["token", "short"],
          properties: {
            token: { type: "string", "x-mono-agent-env-eligible": true, "x-mono-agent-secret": true },
            short: { type: "string", "x-mono-agent-env-eligible": true, "x-mono-agent-secret": true },
          },
        },
        controller: { create: (context) => {
          dispatch = method(methodRecord(context, "channel context").host, "dispatch") as typeof dispatch;
          return channel([]);
        } },
      },
    ]);
    await project.writeConfig(minimalConfig(runtime, {
      channels: { stream: {
        $use: channelName, token: { $env: "CHANNEL_EVENT_SECRET" },
        short: { $env: "CHANNEL_EVENT_SHORT_SECRET" },
      } },
    }));
    await started(project, {
      CHANNEL_EVENT_SECRET: secret, CHANNEL_EVENT_SHORT_SECRET: shortSecret,
    });
    const events: ChannelReplyEvent[] = [];
    const result = await dispatch!({
      requestId: "event-request", conversationId: "events", sender: { id: "user" },
      text: "go", attachments: [], receivedAt: new Date().toISOString(),
      signal: new AbortController().signal,
    }, { emit(event: ChannelReplyEvent) { events.push(event); } });
    expect(result).toMatchObject({ status: "completed" });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(Buffer.from(secret).toString("base64"));
    const toolResult = events.find((event) => event.type === "tool-result");
    const repeated = toolResult?.type === "tool-result"
      ? toolResult.result.content.find((part) => part.type === "text")?.text : undefined;
    expect(typeof repeated === "string" ? Buffer.byteLength(repeated, "utf8") : Infinity)
      .toBeLessThanOrEqual(1_000_000);
    expect(repeated).not.toContain(shortSecret);
    expect(events).toContainEqual({ type: "session-evicted" });
    expect(events).toContainEqual(expect.objectContaining({ type: "compaction" }));
    expect(events.find((event) => event.type === "tool-result")).toMatchObject({
      result: { content: expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringMatching(/file result omitted/u) })]) },
    });
  });

  it("grants declared cron state through an instance namespace and rejects hostile signals", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtime = `@fixture/runtime-cron-grant-${suffix}`;
    const stateName = `@fixture/state-cron-grant-${suffix}`;
    const triggerName = `@fixture/trigger-cron-grant-${suffix}`;
    const undeclaredName = `@fixture/trigger-no-grant-${suffix}`;
    const state = new MemoryStateStore();
    let grant: {
      read(request: unknown): Promise<unknown>;
      compareAndSwap(request: unknown): Promise<unknown>;
    } | undefined;
    let undeclared: unknown;
    const project = await tracked([
      { name: runtime, kind: "runtime", controller: runtimeController(() => completed("unused")) },
      { name: stateName, kind: "state", controller: { create: () => state } },
      {
        name: triggerName, kind: "trigger", capabilities: ["cron.durable-state.v1"],
        controller: { create(context) {
          const host = methodRecord(methodRecord(context, "trigger context").host, "host");
          grant = methodRecord(host.getCapability("cron.durable-state.v1"), "cron grant") as typeof grant;
          return {};
        } },
      },
      {
        name: undeclaredName, kind: "trigger",
        controller: { create(context) {
          const host = methodRecord(methodRecord(context, "trigger context").host, "host");
          undeclared = host.getCapability("cron.durable-state.v1");
          return {};
        } },
      },
    ]);
    await project.writeConfig(minimalConfig(runtime, {
      state: { $use: stateName },
      triggers: { cron: { $use: triggerName }, plain: { $use: undeclaredName } },
    }));
    await started(project);
    expect(undeclared).toBeUndefined();
    const signal = new AbortController().signal;
    const bytes = new Uint8Array([1, 2, 3]);
    await grant!.compareAndSwap({ key: "jobs/one", expectedVersion: null, value: bytes, signal });
    bytes[0] = 9;
    expect([...state.records.keys()]).toContain("trigger/cron/jobs/one");
    const first = await grant!.read({ key: "jobs/one", signal }) as { value: Uint8Array };
    expect([...first.value]).toEqual([1, 2, 3]);
    first.value[0] = 8;
    expect([...(await grant!.read({ key: "jobs/one", signal }) as { value: Uint8Array }).value]).toEqual([1, 2, 3]);
    await expect(grant!.read({ key: "jobs/two", signal: {} })).rejects.toThrow(/AbortSignal/u);
    await expect(grant!.read(Object.defineProperty({ key: "jobs/two" }, "signal", {
      get() { throw new Error("accessor invoked"); }, enumerable: true,
    }))).rejects.toThrow(/data property/u);
  });
});

function channel(
  sendTools: readonly unknown[],
  deliver: NonNullable<Channel["deliver"]> = async (message) => ({
    status: "delivered", idempotencyKey: message.idempotencyKey, messageId: "message",
  }),
): Channel {
  return { capabilities: channelCapabilities, sendTools: sendTools as NonNullable<Channel["sendTools"]>, deliver };
}

function sendTool(name: string, destination: string) {
  return {
    name, description: `Send through ${name}.`,
    inputSchema: { type: "object", additionalProperties: true },
    prepare(input: unknown) {
      return { conversationId: destination,
        text: isRecord(input) && typeof input.text === "string" ? input.text : "hello" };
    },
    historyConversationId() { return destination; },
  };
}

function allowPolicy() {
  return {
    tools: { default: "allow" as const }, approvals: { default: "allow" as const },
    sandbox: { mode: "off" as const },
  };
}

async function tracked(options: Parameters<typeof createFixtureProject>[0]): Promise<FixtureProject> {
  const project = await createFixtureProject(options);
  projects.push(project);
  return project;
}

async function started(
  project: FixtureProject,
  environment?: Readonly<Record<string, string>>,
): Promise<AgentHost> {
  const host = await createAgentHost(project.configPath, environment === undefined ? {} : { environment });
  hosts.push(host);
  return host;
}

function toolNames(value: unknown): string[] {
  return isRecord(value) && Array.isArray(value.tools)
    ? value.tools.flatMap((tool) => isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [])
    : [];
}

function signalOf(value: unknown): AbortSignal {
  if (!isRecord(value) || !(value.signal instanceof AbortSignal)) throw new Error("fixture signal missing");
  return value.signal;
}

function method(value: unknown, name: string): (...args: any[]) => Promise<any> {
  const record = methodRecord(value, name);
  const callable = record[name];
  if (typeof callable !== "function") throw new Error(`${name} is unavailable`);
  return callable.bind(value) as (...args: any[]) => Promise<any>;
}

function methodRecord(value: unknown, label: string): Record<string, any> {
  if (!isRecord(value)) throw new Error(`${label} record is unavailable`);
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
