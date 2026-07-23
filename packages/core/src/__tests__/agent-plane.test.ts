import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentHost } from "../host.js";
import {
  completed,
  createFixtureProject,
  minimalConfig,
  runtimeController,
  runtimeSession,
  type FixtureProject,
} from "./fixture.js";
import { MemoryStateStore } from "./durable-state-fixture.js";

const projects: FixtureProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

describe("complete agent plane", () => {
  it("fails startup before runtimes when the selected state protocol is incompatible", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtimeName = `@fixture/runtime-protocol-${suffix}`;
    const stateName = `@fixture/state-protocol-${suffix}`;
    const state = new MemoryStateStore();
    let stateStarts = 0;
    Object.defineProperty(state, "start", {
      configurable: true,
      value() { stateStarts += 1; },
    });
    Object.defineProperty(state, "execution", {
      configurable: true,
      value: {
        async perform() {
          return {
            protocol: "mono-agent.state-execution",
            version: 2,
            operations: [],
          };
        },
      },
    });
    let runtimeCreates = 0;
    const validRuntime = runtimeController(() => completed("unused"));
    const project = await createFixtureProject([
      {
        name: runtimeName,
        kind: "runtime",
        controller: {
          create(context) {
            runtimeCreates += 1;
            return validRuntime.create(context);
          },
        },
      },
      {
        name: stateName,
        kind: "state",
        controller: { create: () => state },
      },
    ]);
    projects.push(project);
    await project.writeConfig(minimalConfig(runtimeName, {
      state: { $use: stateName },
    }));

    await expect(createAgentHost(project.configPath)).rejects.toThrow(/malformed protocol/u);
    expect(stateStarts).toBe(0);
    expect(runtimeCreates).toBe(0);
  });

  it("publishes the exact started operator identity through owner-private state discovery", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtimeName = `@fixture/runtime-${suffix}`;
    const stateName = `@fixture/state-${suffix}`;
    const operatorName = `@fixture/operator-${suffix}`;
    const published: unknown[] = [];
    const startedAt = "2026-07-22T12:00:00.000Z";
    const state = Object.assign(new MemoryStateStore(), {
      async publishHostPresence(request: unknown) {
        published.push(request);
      },
    });
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
          create: () => state,
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
              resolveDeliveryHistory(message: { conversationId: string }) {
                return { conversationId: message.conversationId };
              },
              readHostPresence() {
                return {
                  operatorRegistry: {
                    schema: "mono-agent.operator-registry-details.v2",
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
          schema: "mono-agent.operator-registry-details.v2",
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
    const state = new MemoryStateStore();
    const captures: unknown[] = [];
    const exports: unknown[] = [];
    const requests: Array<Record<string, unknown>> = [];

    const project = await createFixtureProject([
      {
        name: runtimeName,
        kind: "runtime",
        controller: runtimeController((request) => {
          requests.push(request as Record<string, unknown>);
          return {
            ...(completed(`answer-${String(requests.length)}`) as Record<string, unknown>),
            session: runtimeSession("native-session", request),
          };
        }),
      },
      {
        name: stateName,
        kind: "state",
        controller: {
          create: () => state,
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
    expect(secondRequest.session).toEqual({
      id: "native-session",
      conversationId: "durable",
      route: { runtimeInstanceId: "main", model: "fixture:model" },
    });
    expect(JSON.stringify(secondRequest.messages)).toContain("durable preference");
    expect(captures).toHaveLength(2);
    expect(exports).toHaveLength(2);
  });

  it("replays webhook completion delivery once across restart and conflicts on changed raw bytes", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtimeName = `@fixture/runtime-webhook-${suffix}`;
    const stateName = `@fixture/state-webhook-${suffix}`;
    const sourceName = `@fixture/channel-webhook-${suffix}`;
    const targetName = `@fixture/channel-notify-${suffix}`;
    const state = new MemoryStateStore();
    let providerTurns = 0;
    let sends = 0;
    let dispatch: ((request: Record<string, unknown>, reply: {
      emit(event: unknown): Promise<void>;
    }) => Promise<Record<string, unknown>>) | undefined;
    const project = await createFixtureProject([
      {
        name: runtimeName,
        kind: "runtime",
        controller: runtimeController(() => {
          providerTurns += 1;
          return completed("webhook answer");
        }),
      },
      { name: stateName, kind: "state", controller: { create: () => state } },
      {
        name: sourceName,
        kind: "channel",
        controller: {
          create(context: unknown) {
            const sourceHost = (context as { host: { dispatch: typeof dispatch } }).host;
            dispatch = sourceHost.dispatch!.bind(sourceHost) as typeof dispatch;
            return {
              capabilities: {
                attachments: false, liveInput: false, askUser: false, approvals: false,
                proactive: false, runtimeControl: false, verbatim: true, cancellation: false,
              },
            };
          },
        },
      },
      {
        name: targetName,
        kind: "channel",
        controller: {
          create: () => ({
            capabilities: {
              attachments: false, liveInput: false, askUser: false, approvals: false,
              proactive: true, runtimeControl: false, verbatim: true, cancellation: false,
            },
            resolveDeliveryHistory: () => ({ conversationId: "telegram:42" }),
            async deliver(message: { idempotencyKey: string }) {
              sends += 1;
              return {
                status: "delivered",
                idempotencyKey: message.idempotencyKey,
                messageId: "telegram-message-1",
              };
            },
          }),
        },
      },
    ]);
    projects.push(project);
    await project.writeConfig(minimalConfig(runtimeName, {
      state: { $use: stateName },
      channels: {
        incoming: { $use: sourceName },
        notify: { $use: targetName },
      },
    }));
    const rawHash = (raw: string): string =>
      createHash("sha256").update(raw).digest("hex");
    const request = (raw: string, text = "same") => ({
      requestId: "webhook-stable-request",
      conversationId: "webhook:triage:webhook-stable-request",
      sender: { id: "webhook", displayName: "incoming" },
      text,
      attachments: [],
      receivedAt: "2026-07-23T10:00:00.000Z",
      completionDelivery: { channel: "notify", destination: "telegram:42" },
      metadata: { webhook: { route: "triage", bodySha256: rawHash(raw) } },
      signal: new AbortController().signal,
    });
    const reply = { async emit() {} };
    const first = await createAgentHost(project.configPath);
    expect(await dispatch!(request('{"text":"same"}'), reply)).toMatchObject({
      status: "completed",
      text: "webhook answer",
    });
    expect(providerTurns).toBe(1);
    expect(sends).toBe(1);
    expect((await first.replay("telegram:42")).messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "webhook answer" }],
      }),
    ]);
    await first.stop();

    const restarted = await createAgentHost(project.configPath);
    expect(await dispatch!(request('{"text":"same"}'), reply)).toMatchObject({
      status: "completed",
      text: "webhook answer",
    });
    for (const changed of [
      request('{ "text": "same" }'),
      request('{"text":"different"}', "different"),
    ]) {
      expect(await dispatch!(changed, reply)).toMatchObject({
        status: "rejected",
        diagnostics: [{ code: "request_conflict" }],
      });
    }
    expect(providerTurns).toBe(1);
    expect(sends).toBe(1);
    expect((await restarted.replay("telegram:42")).messages).toHaveLength(1);
    await restarted.stop();
  });

  it("executes a cron-style default notification once through the selected proactive channel", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtimeName = `@fixture/runtime-${suffix}`;
    const stateName = `@fixture/state-trigger-${suffix}`;
    const triggerName = `@fixture/trigger-${suffix}`;
    const channelName = `@fixture/channel-${suffix}`;
    const deliveries: unknown[] = [];
    const state = new MemoryStateStore();
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
        name: stateName,
        kind: "state",
        controller: { create: () => state },
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
            resolveDefaultDeliveryConversationId: () => "telegram:42",
            resolveDeliveryHistory: (message: { conversationId: string }) => ({
              conversationId: message.conversationId,
            }),
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
                    metadata: { destination: "" },
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
    await expect(host.runModuleCommand("cron", "cron:invoke")).resolves.toMatchObject({
      value: { status: "accepted" },
    });
    await expect(host.runModuleCommand("cron", "cron:invoke")).resolves.toMatchObject({
      value: { status: "rejected", reason: "duplicate trigger event" },
    });
    expect(turns).toBe(1);
    expect(deliveries).toEqual([
      expect.objectContaining({
        conversationId: "telegram:42",
        text: "scheduled answer",
        idempotencyKey: "daily:2026-07-22",
      }),
    ]);
    await host.stop();
  });

  it("suppresses only the exact proactive sentinel while retaining the completed run", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtimeName = `@fixture/runtime-suppression-${suffix}`;
    const stateName = `@fixture/state-suppression-${suffix}`;
    const triggerName = `@fixture/trigger-suppression-${suffix}`;
    const channelName = `@fixture/channel-suppression-${suffix}`;
    const state = new MemoryStateStore();
    const deliveries: string[] = [];
    let sequence = 0;
    const project = await createFixtureProject([
      {
        name: runtimeName,
        kind: "runtime",
        controller: runtimeController((request) =>
          completed((request as { messages: readonly { content: readonly { text?: string }[] }[] })
            .messages.at(-1)?.content[0]?.text ?? "")),
      },
      {
        name: stateName,
        kind: "state",
        controller: { create: () => state },
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
            resolveDeliveryHistory: (message: { conversationId: string }) => ({
              conversationId: message.conversationId,
            }),
            async deliver(message: { text: string; idempotencyKey: string }) {
              deliveries.push(message.text);
              return { status: "delivered", idempotencyKey: message.idempotencyKey };
            },
          }),
        },
      },
      {
        name: triggerName,
        kind: "trigger",
        controller: {
          create(context: unknown) {
            const triggerHost = (context as {
              host: { emit(event: unknown, signal: AbortSignal): Promise<unknown> };
            }).host;
            return {
              commands: [
                {
                  name: "cron:invoke",
                  kind: "maintenance",
                  description: "Exercise exact proactive suppression.",
                  async run(input: unknown) {
                    sequence += 1;
                    return triggerHost.emit({
                      id: `suppression-${sequence}`,
                      triggerInstanceId: "cron",
                      prompt: String(input),
                      createdAt: new Date().toISOString(),
                      deliveryChannel: "notify",
                      metadata: { destination: "operator-admin" },
                    }, new AbortController().signal);
                  },
                },
                {
                  name: "cron:repeat-suppressed",
                  kind: "maintenance",
                  description: "Replay the suppressed fixture event.",
                  run: () => triggerHost.emit({
                    id: "suppression-1",
                    triggerInstanceId: "cron",
                    prompt: "NOTHING_TO_REPORT",
                    createdAt: new Date().toISOString(),
                    deliveryChannel: "notify",
                  }, new AbortController().signal),
                },
                {
                  name: "cron:no-delivery",
                  kind: "maintenance",
                  description: "Exercise duplicate rejection without delivery.",
                  run: () => triggerHost.emit({
                    id: "no-delivery",
                    triggerInstanceId: "cron",
                    prompt: "ordinary report",
                    createdAt: new Date().toISOString(),
                  }, new AbortController().signal),
                },
              ],
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
    for (const text of [
      "NOTHING_TO_REPORT",
      "prefix NOTHING_TO_REPORT suffix",
      "nothing_to_report",
      " NOTHING_TO_REPORT",
      "NOTHING_TO_REPORT ",
    ]) {
      await expect(host.runModuleCommand("cron", "cron:invoke", text)).resolves.toMatchObject({
        value: { status: "accepted" },
      });
    }
    expect(deliveries).toEqual([
      "prefix NOTHING_TO_REPORT suffix",
      "nothing_to_report",
      " NOTHING_TO_REPORT",
      "NOTHING_TO_REPORT ",
    ]);
    await expect(host.runModuleCommand("cron", "cron:repeat-suppressed")).resolves.toMatchObject({
      value: { status: "rejected", code: "execution_failed",
        reason: "Request suppression-1 was already used with different input" },
    });
    await expect(host.runModuleCommand("cron", "cron:no-delivery")).resolves.toMatchObject({
      value: { status: "accepted" },
    });
    await expect(host.runModuleCommand("cron", "cron:no-delivery")).resolves.toMatchObject({
      value: { status: "rejected", reason: "duplicate trigger event" },
    });
    expect((await host.replay("operator-admin")).messages.map((message) =>
      message.content[0]?.type === "text" ? message.content[0].text : "")).toEqual(deliveries);
    const history = await host.listRuns();
    expect(history.runs).toHaveLength(6);
    const suppressed = history.runs.find(({ requestId }) => requestId === "suppression-1");
    expect(suppressed).toMatchObject({ status: "completed" });
    expect(JSON.stringify(await host.readRun(suppressed!.runId))).toContain("NOTHING_TO_REPORT");
    await host.stop();
  });

  it("retries failed delivery from the cached run and preserves unknown outcomes across restart", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtimeName = `@fixture/runtime-trigger-recovery-${suffix}`;
    const stateName = `@fixture/state-trigger-recovery-${suffix}`;
    const triggerName = `@fixture/trigger-recovery-${suffix}`;
    const channelName = `@fixture/channel-trigger-recovery-${suffix}`;
    const state = new MemoryStateStore();
    let turns = 0;
    let deliveries = 0;
    const receipts = new Map<string, unknown>();
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
          create: () => state,
        },
      },
      {
        name: channelName,
        kind: "channel",
        schema: {
          type: "object", additionalProperties: false, required: ["token"],
          properties: {
            token: {
              type: "string", "x-mono-agent-env-eligible": true, "x-mono-agent-secret": true,
            },
          },
        },
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
            resolveDeliveryHistory: (message: { conversationId: string }) => ({
              conversationId: message.conversationId,
            }),
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
                  const receipt = await host.emit({
                    id,
                    triggerInstanceId: "cron",
                    prompt: "prepare recovery update",
                    createdAt: new Date().toISOString(),
                    deliveryChannel: "notify",
                  }, new AbortController().signal);
                  receipts.set(id, receipt);
                  return receipt;
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
      channels: { notify: { $use: channelName, token: { $env: "UNKNOWN_SECRET" } } },
      triggers: { cron: { $use: triggerName } },
    }));
    const host = await createAgentHost(project.configPath, {
      environment: { UNKNOWN_SECRET: "unknown" },
    });

    await expect(host.runModuleCommand("cron", "cron:invoke", "failed-delivery")).resolves.toMatchObject({
      value: { status: "rejected", code: "execution_failed", reason: "Trigger delivery ended with failed" },
    });
    deliveryStatus = "delivered";
    await expect(host.runModuleCommand("cron", "cron:invoke", "failed-delivery")).resolves.toMatchObject({
      value: { status: "accepted" },
    });
    // The failed delivery is retried from the settled model response; the
    // provider turn itself remains exactly-once.
    expect(turns).toBe(1);
    expect(deliveries).toBe(2);
    await expect(host.runModuleCommand("cron", "cron:invoke", "failed-delivery")).resolves.toMatchObject({
      value: { status: "rejected", code: "duplicate", reason: "duplicate trigger event" },
    });
    expect(turns).toBe(1);
    expect(deliveries).toBe(2);
    state.mapExecutionResult = (operation, input, result) =>
      operation === "run.admit"
        && (input as { readonly requestId?: unknown }).requestId === "joined-admission"
        ? { status: "join", runId: "joined-run" }
        : result;
    await host.runModuleCommand("cron", "cron:invoke", "joined-admission");
    expect(receipts.get("joined-admission")).toMatchObject({
      status: "unknown", code: "execution_unknown",
    });
    await host.runModuleCommand("cron", "cron:invoke", "joined-admission");
    expect(receipts.get("joined-admission")).toMatchObject({
      status: "unknown", code: "execution_unknown",
    });
    state.mapExecutionResult = (_operation, _input, result) => result;
    deliveryStatus = "unknown";
    await host.runModuleCommand("cron", "cron:invoke", "unknown-delivery");
    expect(receipts.get("unknown-delivery")).toMatchObject({
      status: "unknown", code: "delivery_unknown",
    });
    expect((receipts.get("unknown-delivery") as { reason: string }).reason).not.toContain("unknown");
    await host.runModuleCommand("cron", "cron:invoke", "unknown-delivery");
    expect(receipts.get("unknown-delivery")).toMatchObject({
      status: "unknown", code: "delivery_unknown",
    });
    expect((receipts.get("unknown-delivery") as { reason: string }).reason).not.toContain("unknown");
    expect(turns).toBe(2);
    expect(deliveries).toBe(3);
    await host.stop();

    const restarted = await createAgentHost(project.configPath, {
      environment: { UNKNOWN_SECRET: "unknown" },
    });
    await restarted.runModuleCommand("cron", "cron:invoke", "joined-admission");
    expect(receipts.get("joined-admission")).toMatchObject({
      status: "unknown", code: "execution_unknown",
    });
    await restarted.runModuleCommand("cron", "cron:invoke", "unknown-delivery");
    expect(receipts.get("unknown-delivery")).toMatchObject({
      status: "unknown", code: "delivery_unknown",
    });
    expect((receipts.get("unknown-delivery") as { reason: string }).reason).not.toContain("unknown");
    expect(turns).toBe(2);
    expect(deliveries).toBe(3);
    await restarted.stop();
  });
});
