import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentHost } from "../host.js";
import {
  completed,
  createFixtureProject,
  minimalConfig,
  runtimeController,
  type FixtureProject,
} from "./fixture.js";

const projects: FixtureProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

describe("complete agent plane", () => {
  it("publishes the exact started operator identity through owner-private state discovery", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtimeName = `@fixture/runtime-${suffix}`;
    const stateName = `@fixture/state-${suffix}`;
    const operatorName = `@fixture/operator-${suffix}`;
    const published: unknown[] = [];
    const startedAt = "2026-07-22T12:00:00.000Z";
    const project = await createFixtureProject([
      {
        name: runtimeName,
        kind: "runtime",
        controller: runtimeController(() => completed("unused")),
      },
      {
        name: stateName,
        kind: "state",
        controller: {
          create: () => ({
            async read() { return undefined; },
            async write() { return { version: "1", updatedAt: startedAt }; },
            async delete() { return false; },
            async list() { return { records: [] }; },
            async compareAndSwap() { return { status: "conflict" }; },
            async upsertPresence(request: { presence: unknown }) { return request.presence; },
            async removePresence() { return false; },
            async listPresence() { return []; },
            async publishHostPresence(request: unknown) {
              published.push(request);
            },
          }),
        },
      },
      {
        name: operatorName,
        kind: "channel",
        capabilities: ["operator.identity.v1"],
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            auth: {
              type: "object",
              additionalProperties: false,
              properties: {
                token: {
                  type: "string",
                  "x-mono-agent-env-eligible": true,
                  "x-mono-agent-secret": true,
                },
              },
              required: ["token"],
            },
          },
          required: ["auth"],
        },
        controller: {
          create(context: unknown) {
            const grant = (context as { host: { getCapability(name: string): unknown } }).host
              .getCapability("operator.identity.v1");
            expect(grant).toMatchObject({
              agent: { id: "fixture-agent", label: "Fixture Agent" },
              process: { pid: process.pid },
              defaults: { runtime: "main", model: "fixture:model" },
            });
            return {
              capabilities: {
                attachments: true,
                liveInput: true,
                askUser: true,
                approvals: false,
                proactive: true,
                runtimeControl: true,
                verbatim: false,
                cancellation: true,
              },
              endpoint: "http://127.0.0.1:43210",
              startInfo: {
                endpoint: "http://127.0.0.1:43210",
                startedAt,
              },
              async deliver(message: { idempotencyKey: string }) {
                return { status: "delivered", idempotencyKey: message.idempotencyKey };
              },
              readHostPresence() {
                return {
                  operatorRegistry: {
                    schema: "mono-agent.operator-registry-details.v1",
                    agent: { id: "fixture-agent", label: "Fixture Agent" },
                    operator: {
                      endpoint: "http://127.0.0.1:43210",
                      tokenEnvironment: "MONO_AGENT_OPERATOR_TOKEN",
                    },
                    process: { pid: process.pid, startedAt },
                    capabilities: {
                      attachments: true,
                      liveInput: true,
                      askUser: true,
                      cancellation: true,
                      quotes: false,
                      runtimeOverrides: true,
                      proactive: true,
                      configView: true,
                      replay: true,
                      health: true,
                    },
                  },
                };
              },
            };
          },
        },
      },
    ]);
    projects.push(project);
    await project.writeConfig(minimalConfig(runtimeName, {
      state: { $use: stateName },
      channels: {
        operator: {
          $use: operatorName,
          auth: { token: { $env: "MONO_AGENT_OPERATOR_TOKEN" } },
        },
      },
    }));

    const host = await createAgentHost(project.configPath, {
      environment: { MONO_AGENT_OPERATOR_TOKEN: "fixture-operator-token-that-is-long-enough" },
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      status: "ready",
      details: {
        operatorRegistry: {
          schema: "mono-agent.operator-registry-details.v1",
          agent: { id: "fixture-agent", label: "Fixture Agent" },
          operator: {
            endpoint: "http://127.0.0.1:43210",
            tokenEnvironment: "MONO_AGENT_OPERATOR_TOKEN",
          },
          process: { pid: process.pid, startedAt },
          capabilities: {
            attachments: true,
            liveInput: true,
            askUser: true,
            cancellation: true,
            quotes: false,
            runtimeOverrides: true,
            proactive: true,
            configView: true,
            replay: true,
            health: true,
          },
        },
      },
      signal: expect.any(AbortSignal),
    });
    await host.stop();
  });

  it("persists canonical transcript/session state, recalls and captures memory, and exports settlement metadata", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtimeName = `@fixture/runtime-${suffix}`;
    const stateName = `@fixture/state-${suffix}`;
    const memoryName = `@fixture/memory-${suffix}`;
    const exporterName = `@fixture/exporter-${suffix}`;
    const records = new Map<string, { value: Uint8Array; version: string; updatedAt: string }>();
    const captures: unknown[] = [];
    const exports: unknown[] = [];
    const requests: Array<Record<string, unknown>> = [];
    let version = 0;

    const project = await createFixtureProject([
      {
        name: runtimeName,
        kind: "runtime",
        controller: runtimeController((request) => {
          requests.push(request as Record<string, unknown>);
          return {
            ...(completed(`answer-${String(requests.length)}`) as Record<string, unknown>),
            session: { id: "native-session" },
          };
        }),
      },
      {
        name: stateName,
        kind: "state",
        controller: {
          create: () => ({
            async read(request: { key: string }) {
              const record = records.get(request.key);
              return record === undefined ? undefined : { key: request.key, ...record };
            },
            async write(request: { key: string; value: Uint8Array; expectedVersion?: string }) {
              const current = records.get(request.key);
              if (request.expectedVersion !== undefined && request.expectedVersion !== current?.version) {
                throw new Error("CAS mismatch");
              }
              const result = { version: String(++version), updatedAt: new Date().toISOString() };
              records.set(request.key, { value: request.value, ...result });
              return result;
            },
            async compareAndSwap(request: { key: string; value: Uint8Array; expectedVersion: string | null }) {
              const current = records.get(request.key);
              const matches = request.expectedVersion === null
                ? current === undefined
                : current?.version === request.expectedVersion;
              if (!matches) return { status: "conflict", ...(current === undefined ? {} : { currentVersion: current.version }) };
              const result = { version: String(++version), updatedAt: new Date().toISOString() };
              const record = { key: request.key, value: request.value, ...result };
              records.set(request.key, { value: request.value, ...result });
              return { status: "applied", record };
            },
            async delete(request: { key: string }) {
              return records.delete(request.key);
            },
            async list(request: { prefix?: string }) {
              return {
                records: [...records.entries()]
                  .filter(([key]) => request.prefix === undefined || key.startsWith(request.prefix))
                  .map(([key, record]) => ({ key, ...record })),
              };
            },
            async upsertPresence(request: { presence: unknown }) { return request.presence; },
            async removePresence() { return false; },
            async listPresence() { return []; },
          }),
        },
      },
      {
        name: memoryName,
        kind: "memory",
        controller: {
          create: () => ({
            capabilities: { capture: true, forget: true },
            async recall() {
              return { records: [{ id: "remembered", text: "The durable preference is concise output.", createdAt: new Date(0).toISOString() }] };
            },
            async capture(request: unknown) {
              captures.push(request);
            },
            async forget() {
              return true;
            },
          }),
        },
      },
      {
        name: exporterName,
        kind: "exporter",
        controller: {
          create: () => ({
            async export(batch: unknown) {
              exports.push(batch);
              return { accepted: 1, rejected: 0 };
            },
            async flush() {},
          }),
        },
      },
    ]);
    projects.push(project);
    await project.writeConfig(minimalConfig(runtimeName, {
      state: { $use: stateName },
      memory: { $use: memoryName },
      observability: { exporters: { otlp: { $use: exporterName } } },
      session: { mode: "continuous" },
    }));

    const first = await createAgentHost(project.configPath);
    await expect(first.submit({
      requestId: "durable-first",
      conversationId: "durable",
      text: "first",
    })).resolves.toMatchObject({ text: "answer-1" });
    await first.stop();

    const second = await createAgentHost(project.configPath);
    await expect(second.submit({
      requestId: "durable-second",
      conversationId: "durable",
      text: "second",
    })).resolves.toMatchObject({ text: "answer-2" });
    const replay = await second.replay("durable");
    expect(replay.messages).toHaveLength(4);
    await second.stop();

    const secondRequest = requests[1]!;
    expect(secondRequest.session).toEqual({ id: "native-session" });
    expect(JSON.stringify(secondRequest.messages)).toContain("durable preference");
    expect(captures).toHaveLength(2);
    expect(exports).toHaveLength(2);
    expect([...records.keys()].some((key) => key.startsWith("core/conversations/"))).toBe(true);
  });

  it("executes trigger commands once and delivers through the explicitly selected proactive channel", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtimeName = `@fixture/runtime-${suffix}`;
    const triggerName = `@fixture/trigger-${suffix}`;
    const channelName = `@fixture/channel-${suffix}`;
    const deliveries: unknown[] = [];
    let turns = 0;
    const project = await createFixtureProject([
      {
        name: runtimeName,
        kind: "runtime",
        controller: runtimeController(() => {
          turns += 1;
          return completed("scheduled answer");
        }),
      },
      {
        name: channelName,
        kind: "channel",
        controller: {
          create: () => ({
            capabilities: {
              attachments: false,
              liveInput: false,
              askUser: false,
              approvals: false,
              proactive: true,
              runtimeControl: false,
              verbatim: false,
              cancellation: false,
            },
            async deliver(message: unknown) {
              deliveries.push(message);
              const idempotencyKey = (message as { idempotencyKey: string }).idempotencyKey;
              return { status: "delivered", idempotencyKey, messageId: "sent-1" };
            },
          }),
        },
      },
      {
        name: triggerName,
        kind: "trigger",
        controller: {
          create(context: unknown) {
            const host = (context as { host: { emit(event: unknown, signal: AbortSignal): Promise<unknown> } }).host;
            return {
              commands: [{
                name: "cron:invoke",
                kind: "maintenance",
                description: "Invoke one fixture schedule.",
                async run() {
                  return host.emit({
                    id: "daily:2026-07-22",
                    triggerInstanceId: "cron",
                    prompt: "prepare update",
                    createdAt: new Date().toISOString(),
                    deliveryChannel: "notify",
                    metadata: { destination: "operator-admin" },
                  }, new AbortController().signal);
                },
              }],
            };
          },
        },
      },
    ]);
    projects.push(project);
    await project.writeConfig(minimalConfig(runtimeName, {
      channels: { notify: { $use: channelName } },
      triggers: { cron: { $use: triggerName } },
    }));

    const host = await createAgentHost(project.configPath);
    await expect(host.runModuleCommand("cron", "cron:invoke")).resolves.toMatchObject({
      value: { status: "accepted" },
    });
    await expect(host.runModuleCommand("cron", "cron:invoke")).resolves.toMatchObject({
      value: { status: "rejected", reason: "duplicate trigger event" },
    });
    expect(turns).toBe(1);
    expect(deliveries).toEqual([
      expect.objectContaining({
        conversationId: "operator-admin",
        text: "scheduled answer",
        idempotencyKey: "daily:2026-07-22",
      }),
    ]);
    await host.stop();
  });

  it("retries failed delivery claims and atomically reclaims stale started trigger leases", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtimeName = `@fixture/runtime-trigger-recovery-${suffix}`;
    const stateName = `@fixture/state-trigger-recovery-${suffix}`;
    const triggerName = `@fixture/trigger-recovery-${suffix}`;
    const channelName = `@fixture/channel-trigger-recovery-${suffix}`;
    const records = new Map<string, { value: Uint8Array; version: string; updatedAt: string }>();
    let version = 0;
    let turns = 0;
    let deliveries = 0;
    let deliveryStatus: "delivered" | "failed" | "unknown" = "failed";
    const project = await createFixtureProject([
      {
        name: runtimeName,
        kind: "runtime",
        controller: runtimeController(() => {
          turns += 1;
          return completed(`scheduled-${turns}`);
        }),
      },
      {
        name: stateName,
        kind: "state",
        controller: {
          create: () => ({
            async read(request: { key: string }) {
              const record = records.get(request.key);
              return record === undefined ? undefined : { key: request.key, ...record };
            },
            async write(request: { key: string; value: Uint8Array; expectedVersion?: string }) {
              const current = records.get(request.key);
              if (request.expectedVersion !== undefined && current?.version !== request.expectedVersion) {
                throw new Error("fixture state version conflict");
              }
              const result = { version: String(++version), updatedAt: new Date().toISOString() };
              records.set(request.key, { value: new Uint8Array(request.value), ...result });
              return result;
            },
            async delete(request: { key: string }) { return records.delete(request.key); },
            async list(request: { prefix?: string }) {
              return {
                records: [...records.entries()]
                  .filter(([key]) => request.prefix === undefined || key.startsWith(request.prefix))
                  .map(([key, record]) => ({ key, ...record })),
              };
            },
            async compareAndSwap(request: { key: string; value: Uint8Array; expectedVersion: string | null }) {
              const current = records.get(request.key);
              const matches = request.expectedVersion === null
                ? current === undefined
                : current?.version === request.expectedVersion;
              if (!matches) return { status: "conflict", ...(current === undefined ? {} : { currentVersion: current.version }) };
              const result = { version: String(++version), updatedAt: new Date().toISOString() };
              const record = { key: request.key, value: new Uint8Array(request.value), ...result };
              records.set(request.key, { value: record.value, ...result });
              return { status: "applied", record };
            },
            async upsertPresence(request: { presence: unknown }) { return request.presence; },
            async removePresence() { return false; },
            async listPresence() { return []; },
          }),
        },
      },
      {
        name: channelName,
        kind: "channel",
        controller: {
          create: () => ({
            capabilities: {
              attachments: false,
              liveInput: false,
              askUser: false,
              approvals: false,
              proactive: true,
              runtimeControl: false,
              verbatim: false,
              cancellation: false,
            },
            async deliver(message: { idempotencyKey: string }) {
              deliveries += 1;
              return { status: deliveryStatus, idempotencyKey: message.idempotencyKey };
            },
          }),
        },
      },
      {
        name: triggerName,
        kind: "trigger",
        controller: {
          create(context: unknown) {
            const host = (context as { host: { emit(event: unknown, signal: AbortSignal): Promise<unknown> } }).host;
            return {
              commands: [{
                name: "cron:invoke",
                kind: "maintenance",
                description: "Invoke a recoverable fixture schedule.",
                async run(input: unknown) {
                  const id = typeof input === "string" ? input : "failed-delivery";
                  return host.emit({
                    id,
                    triggerInstanceId: "cron",
                    prompt: "prepare recovery update",
                    createdAt: new Date().toISOString(),
                    deliveryChannel: "notify",
                  }, new AbortController().signal);
                },
              }],
            };
          },
        },
      },
    ]);
    projects.push(project);
    await project.writeConfig(minimalConfig(runtimeName, {
      state: { $use: stateName },
      channels: { notify: { $use: channelName } },
      triggers: { cron: { $use: triggerName } },
    }));
    const host = await createAgentHost(project.configPath);

    await expect(host.runModuleCommand("cron", "cron:invoke", "failed-delivery")).resolves.toMatchObject({
      value: { status: "rejected", reason: "Trigger delivery ended with failed" },
    });
    const failedKey = `core/triggers/${createHash("sha256").update("failed-delivery").digest("hex")}`;
    expect(JSON.parse(new TextDecoder().decode(records.get(failedKey)?.value))).toMatchObject({ status: "failed" });
    deliveryStatus = "delivered";
    await expect(host.runModuleCommand("cron", "cron:invoke", "failed-delivery")).resolves.toMatchObject({
      value: { status: "accepted" },
    });
    expect(turns).toBe(2);
    expect(deliveries).toBe(2);
    deliveryStatus = "unknown";
    await expect(host.runModuleCommand("cron", "cron:invoke", "unknown-delivery")).resolves.toMatchObject({
      value: { status: "rejected", reason: "Trigger delivery ended with unknown" },
    });
    const unknownKey = `core/triggers/${createHash("sha256").update("unknown-delivery").digest("hex")}`;
    expect(JSON.parse(new TextDecoder().decode(records.get(unknownKey)?.value))).toMatchObject({
      status: "delivery_unknown",
      delivery: { status: "unknown" },
    });
    await expect(host.runModuleCommand("cron", "cron:invoke", "unknown-delivery")).resolves.toMatchObject({
      value: { status: "rejected", reason: "duplicate trigger event" },
    });
    expect(turns).toBe(3);
    expect(deliveries).toBe(3);
    deliveryStatus = "delivered";
    await host.stop();

    const staleId = "stale-started";
    const staleKey = `core/triggers/${createHash("sha256").update(staleId).digest("hex")}`;
    records.set(staleKey, {
      value: new TextEncoder().encode(JSON.stringify({
        status: "started",
        event: { id: staleId },
        startedAt: "2020-01-01T00:00:00.000Z",
        leaseExpiresAt: "2020-01-01T00:30:00.000Z",
      })),
      version: String(++version),
      updatedAt: new Date().toISOString(),
    });
    const restarted = await createAgentHost(project.configPath);
    await expect(restarted.runModuleCommand("cron", "cron:invoke", staleId)).resolves.toMatchObject({
      value: { status: "accepted" },
    });
    expect(turns).toBe(4);
    await restarted.stop();
  });
});
