import { randomUUID } from "node:crypto";

import type {
  ChannelDeliveryResult,
  ChannelOutboundMessage,
} from "@mono-agent/module-sdk";
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

type DeliveryHandler = (
  message: ChannelOutboundMessage,
  signal: AbortSignal,
) => Promise<ChannelDeliveryResult>;

interface DurableDeliveryFixture {
  readonly project: FixtureProject;
  readonly state: MemoryStateStore;
  readonly channelIds: Readonly<Record<string, string>>;
  start(): Promise<AgentHost>;
}

const projects: FixtureProject[] = [];
const hosts: AgentHost[] = [];

afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.stop()));
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

describe("durable proactive delivery", () => {
  it("sends once and returns a durable duplicate receipt for the same idempotency key", async () => {
    let sends = 0;
    const fixture = await createDurableDeliveryFixture({
      notify: async (message) => {
        sends += 1;
        return {
          status: "delivered",
          idempotencyKey: message.idempotencyKey,
          messageId: "message-1",
        };
      },
    });
    const host = await fixture.start();
    const message = outboundMessage("delivery-once", "hello");

    await expect(host.deliver("notify", message)).resolves.toEqual({
      status: "delivered",
      idempotencyKey: "delivery-once",
      messageId: "message-1",
    });
    await expect(host.deliver("notify", message)).resolves.toEqual({
      status: "duplicate",
      idempotencyKey: "delivery-once",
      messageId: "message-1",
    });
    expect(sends).toBe(1);
  });

  it("retries a known failed receipt only after a second explicit delivery attempt", async () => {
    let sends = 0;
    const fixture = await createDurableDeliveryFixture({
      notify: async (message) => {
        sends += 1;
        return sends === 1
          ? {
              status: "failed",
              idempotencyKey: message.idempotencyKey,
              diagnostic: diagnostic("rejected-before-send"),
            }
          : {
              status: "delivered",
              idempotencyKey: message.idempotencyKey,
              messageId: "message-after-retry",
            };
      },
    });
    const host = await fixture.start();
    const message = outboundMessage("delivery-retry", "retry me");

    await expect(host.deliver("notify", message)).resolves.toMatchObject({
      status: "failed",
      idempotencyKey: "delivery-retry",
    });
    expect(sends).toBe(1);

    await expect(host.deliver("notify", message)).resolves.toEqual({
      status: "delivered",
      idempotencyKey: "delivery-retry",
      messageId: "message-after-retry",
    });
    await expect(host.deliver("notify", message)).resolves.toEqual({
      status: "duplicate",
      idempotencyKey: "delivery-retry",
      messageId: "message-after-retry",
    });
    expect(sends).toBe(2);
  });

  it("settles a thrown channel delivery as unknown and never resends it after restart", async () => {
    let sends = 0;
    let shouldThrow = true;
    const fixture = await createDurableDeliveryFixture({
      notify: async (message) => {
        sends += 1;
        if (shouldThrow) throw new Error("transport outcome is ambiguous");
        return {
          status: "delivered",
          idempotencyKey: message.idempotencyKey,
          messageId: "must-not-send",
        };
      },
    });
    const first = await fixture.start();
    const message = outboundMessage("delivery-thrown", "possibly delivered");

    await expect(first.deliver("notify", message)).resolves.toMatchObject({
      status: "unknown",
      idempotencyKey: "delivery-thrown",
    });
    expect(sends).toBe(1);
    await first.stop();
    hosts.splice(hosts.indexOf(first), 1);

    shouldThrow = false;
    const restarted = await fixture.start();
    await expect(restarted.deliver("notify", message)).resolves.toMatchObject({
      status: "unknown",
      idempotencyKey: "delivery-thrown",
    });
    expect(sends).toBe(1);
  });

  it("fails closed on a mismatched channel idempotency key and never retries it", async () => {
    let sends = 0;
    const fixture = await createDurableDeliveryFixture({
      notify: async () => {
        sends += 1;
        return {
          status: "delivered",
          idempotencyKey: "different-key",
          messageId: "ambiguous-message",
        };
      },
    });
    const first = await fixture.start();
    const message = outboundMessage("delivery-mismatch", "hello");

    await expect(first.deliver("notify", message)).resolves.toMatchObject({
      status: "unknown",
      idempotencyKey: "delivery-mismatch",
      diagnostic: {
        code: "channel_delivery_idempotency_mismatch",
      },
    });
    expect(sends).toBe(1);
    await first.stop();
    hosts.splice(hosts.indexOf(first), 1);

    const restarted = await fixture.start();
    await expect(restarted.deliver("notify", message)).resolves.toMatchObject({
      status: "unknown",
      idempotencyKey: "delivery-mismatch",
    });
    expect(sends).toBe(1);
  });

  it("rejects idempotency-key reuse with a different channel or message before channel execution", async () => {
    const sends = { primary: 0, secondary: 0 };
    const fixture = await createDurableDeliveryFixture({
      primary: async (message) => {
        sends.primary += 1;
        return {
          status: "delivered",
          idempotencyKey: message.idempotencyKey,
          messageId: "primary-message",
        };
      },
      secondary: async (message) => {
        sends.secondary += 1;
        return {
          status: "delivered",
          idempotencyKey: message.idempotencyKey,
          messageId: "secondary-message",
        };
      },
    });
    const host = await fixture.start();
    const original = outboundMessage("delivery-conflict", "original");

    await expect(host.deliver("primary", original)).resolves.toMatchObject({
      status: "delivered",
    });
    await expect(host.deliver("secondary", original)).resolves.toMatchObject({
      status: "failed",
      idempotencyKey: "delivery-conflict",
      diagnostic: { code: "channel_delivery_idempotency_conflict" },
    });
    await expect(host.deliver(
      "primary",
      { ...original, text: "changed" },
    )).resolves.toMatchObject({
      status: "failed",
      idempotencyKey: "delivery-conflict",
      diagnostic: { code: "channel_delivery_idempotency_conflict" },
    });
    expect(sends).toEqual({ primary: 1, secondary: 0 });
  });

  it("joins concurrent in-process duplicates onto one channel send", async () => {
    let sends = 0;
    let releaseSend: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const fixture = await createDurableDeliveryFixture({
      notify: async (message) => {
        sends += 1;
        markStarted?.();
        await released;
        return {
          status: "delivered",
          idempotencyKey: message.idempotencyKey,
          messageId: "concurrent-message",
        };
      },
    });
    const host = await fixture.start();
    const message = outboundMessage("delivery-concurrent", "hello");

    const first = host.deliver("notify", message);
    await started;
    const second = host.deliver("notify", message);
    releaseSend?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        status: "delivered",
        idempotencyKey: "delivery-concurrent",
        messageId: "concurrent-message",
      },
      {
        status: "delivered",
        idempotencyKey: "delivery-concurrent",
        messageId: "concurrent-message",
      },
    ]);
    expect(sends).toBe(1);
  });
});

async function createDurableDeliveryFixture(
  handlers: Readonly<Record<string, DeliveryHandler>>,
): Promise<DurableDeliveryFixture> {
  const suffix = randomUUID().toLowerCase();
  const runtimeName = `@fixture/runtime-delivery-${suffix}`;
  const stateName = `@fixture/state-delivery-${suffix}`;
  const state = new MemoryStateStore();
  const channelIds = Object.fromEntries(
    Object.keys(handlers).map((instanceId) => [
      instanceId,
      `@fixture/channel-delivery-${instanceId}-${suffix}`,
    ]),
  );
  const project = await createFixtureProject([
    {
      name: runtimeName,
      kind: "runtime",
      controller: runtimeController(() => completed("unused")),
    },
    {
      name: stateName,
      kind: "state",
      controller: { create: () => state },
    },
    ...Object.entries(handlers).map(([instanceId, handler]) => ({
      name: channelIds[instanceId]!,
      kind: "channel" as const,
      controller: {
        create: () => ({
          capabilities: {
            attachments: true,
            liveInput: false,
            askUser: false,
            approvals: false,
            proactive: true,
            runtimeControl: false,
            verbatim: true,
            cancellation: false,
          },
          deliver: handler,
        }),
      },
    })),
  ]);
  projects.push(project);
  await project.writeConfig(minimalConfig(runtimeName, {
    state: { $use: stateName },
    channels: Object.fromEntries(
      Object.entries(channelIds).map(([instanceId, packageName]) => [
        instanceId,
        { $use: packageName },
      ]),
    ),
  }));
  return {
    project,
    state,
    channelIds,
    async start() {
      const host = await createAgentHost(project.configPath);
      hosts.push(host);
      return host;
    },
  };
}

function outboundMessage(
  idempotencyKey: string,
  text: string,
): ChannelOutboundMessage {
  return {
    conversationId: "conversation-1",
    text,
    idempotencyKey,
  };
}

function diagnostic(code: string) {
  return {
    code,
    severity: "error" as const,
    message: code,
  };
}
