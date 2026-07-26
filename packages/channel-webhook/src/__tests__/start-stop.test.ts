// SPDX-License-Identifier: MIT
import type { Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

const httpTestState = vi.hoisted(() => ({
  latestServer: undefined as Server | undefined,
}));

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: unknown[]) => {
      const server = Reflect.apply(actual.createServer, actual, args) as Server;
      const listen = server.listen;
      server.listen = ((...listenArgs: unknown[]) => {
        setTimeout(() => {
          Reflect.apply(listen, server, listenArgs);
        }, 1_100);
        return server;
      }) as typeof server.listen;
      httpTestState.latestServer = server;
      return server;
    },
  };
});

import { parseWebhookConfig } from "../config.js";
import { createWebhookChannel } from "../server.js";

afterEach(async () => {
  const server = httpTestState.latestServer;
  if (server?.listening === true) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  httpTestState.latestServer = undefined;
});

describe("webhook start and stop ordering", () => {
  it("rejects stop within its bound and closes a listener that binds later", async () => {
    const channel = createWebhookChannel({
      config: parseWebhookConfig({ apiKey: "delayed-bind-key" }),
      async submit() {
        return { text: "unused" };
      },
    });

    const startedAt = Date.now();
    const starting = channel.start().then(
      () => ({ status: "fulfilled" as const }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    const stopping = channel.stop().then(
      () => ({ status: "fulfilled" as const }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    const [startResult, stopResult] = await Promise.all([starting, stopping]);

    expect(stopResult).toMatchObject({
      status: "rejected",
      reason: {
        message: "Webhook HTTP listener startup did not settle within the shutdown bound.",
      },
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(startResult).toMatchObject({
      status: "rejected",
      reason: { message: "Webhook channel stopped while starting." },
    });
    expect(httpTestState.latestServer?.listening).toBe(false);
    expect(httpTestState.latestServer?.address()).toBeNull();
    expect(channel.health().status).toBe("stopped");
  });
});
