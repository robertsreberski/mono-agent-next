// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import * as publicApi from "../index.js";
import {
  MODULE_API_VERSION,
  MODULE_SCHEMA_SLOT_REFERENCE,
  RuntimeTurnError,
  defineChannelModule,
  defineMemoryModule,
  defineModuleSchema,
  defineRuntimeModule,
  type Runtime,
} from "../index.js";
import * as internalApi from "../internal.js";
import {
  ModuleComplianceError,
  assertChannelBehaviorCompliance,
  assertChannelInstanceCompliance,
  assertChannelModuleCompliance,
  assertMemoryInstanceCompliance,
  assertMemoryModuleCompliance,
  assertModuleToolBindingCompliance,
  assertModuleToolContributionsCompliance,
  assertMonoAgentModuleExport,
  assertRuntimeBehaviorCompliance,
  assertRuntimeInstanceCompliance,
  assertRuntimeModuleCompliance,
  snapshotSelectedModuleInstanceCompliance,
  type RuntimeBehaviorComplianceOptions,
  type RuntimeBehaviorScenario,
} from "../testing.js";

const schema = defineModuleSchema({
  jsonSchema: { type: "object", properties: { model: { type: "string" } } },
  parse: () => ({ model: "example" }),
});

const manifestBase = {
  packageVersion: "1.0.0",
  apiVersion: MODULE_API_VERSION,
  capabilities: [],
} as const;

describe("public compliance assertions", () => {
  it("narrows valid open-slot definitions and their instances", () => {
    const runtime = defineRuntimeModule({
      manifest: {
        ...manifestBase,
        packageName: "@example/runtime",
        kind: "runtime",
        responsibility: "Runs fixture turns.",
      },
      schema,
      create: () => ({
        capabilities: {
          tools: false,
          mcp: false,
          attachments: false,
          approvals: false,
          structuredOutput: false,
          sandbox: false,
          sessions: false,
        },
        async runTurn() {
          return {
            status: "completed" as const,
            message: { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] },
          };
        },
      }),
    });
    const channel = defineChannelModule({
      manifest: {
        ...manifestBase,
        packageName: "@example/channel",
        kind: "channel",
        responsibility: "Carries fixture messages.",
      },
      schema,
      create: () => ({
        capabilities: {
          attachments: false,
          liveInput: false,
          askUser: false,
          approvals: false,
          proactive: false,
          runtimeControl: false,
          verbatim: false,
          cancellation: true,
        },
      }),
    });
    const memory = defineMemoryModule({
      manifest: {
        ...manifestBase,
        packageName: "@example/memory",
        kind: "memory",
        responsibility: "Recalls fixture memory.",
      },
      schema,
      create: () => ({
        capabilities: { capture: false, forget: false },
        async recall() { return { records: [] }; },
      }),
    });

    expect(() => assertRuntimeModuleCompliance(runtime, {
      expectedPackageName: "@example/runtime",
      expectedPackageVersion: "1.0.0",
    })).not.toThrow();
    expect(() => assertChannelModuleCompliance(channel)).not.toThrow();
    expect(() => assertMemoryModuleCompliance(memory)).not.toThrow();
    expect(assertMonoAgentModuleExport({ monoAgentModule: runtime }).manifest.kind).toBe("runtime");

    expect(() => assertRuntimeInstanceCompliance(runtime.create as unknown)).toThrow(ModuleComplianceError);
    expect(() => assertRuntimeInstanceCompliance({
      capabilities: {
        tools: false,
        mcp: false,
        attachments: false,
        approvals: false,
        structuredOutput: false,
        sandbox: false,
        sessions: false,
      },
      runTurn() {},
    })).not.toThrow();
    expect(() => assertChannelInstanceCompliance({
      capabilities: {
        attachments: false,
        liveInput: false,
        askUser: false,
        approvals: false,
        proactive: false,
        runtimeControl: false,
        verbatim: false,
        cancellation: true,
      },
    })).not.toThrow();
    expect(() => assertMemoryInstanceCompliance({
      capabilities: { capture: false, forget: false },
      recall() {},
    })).not.toThrow();
  });

  it("validates bounded own-data module tool contributions and bindings", () => {
    const contribution = {
      name: "Lookup",
      description: "Look up bounded fixture data.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" } },
      },
      effects: ["read"] as const,
      bind: () => ({ execute: () => ({ ok: true }) }),
    };
    expect(() => assertModuleToolContributionsCompliance([contribution])).not.toThrow();
    expect(() => assertModuleToolBindingCompliance(contribution.bind())).not.toThrow();

    expect(() => assertModuleToolContributionsCompliance([
      contribution,
      { ...contribution },
    ])).toThrow("contains duplicate Lookup");
    expect(() => assertModuleToolContributionsCompliance([{
      ...contribution,
      effects: ["read", "read"],
    }])).toThrow("effects contains duplicate read");
    let coercions = 0;
    expect(() => assertModuleToolContributionsCompliance([{
      ...contribution,
      effects: [{
        toString() {
          coercions += 1;
          return "read";
        },
      }],
    }])).toThrow("effects[0] is invalid");
    expect(coercions).toBe(0);
    expect(() => assertModuleToolContributionsCompliance([{
      ...contribution,
      description: "x".repeat(16 * 1_024 + 1),
    }])).toThrow("description exceeds 16384 UTF-8 bytes");
    expect(() => assertModuleToolContributionsCompliance([{
      ...contribution,
      inputSchema: { description: "x".repeat(64 * 1_024) },
    }])).toThrow("inputSchema exceeds 65536 UTF-8 bytes");
    expect(() => assertModuleToolContributionsCompliance([{
      ...contribution,
      inputSchema: { description: "\n".repeat(40_000) },
    }])).toThrow("inputSchema exceeds 65536 UTF-8 bytes");
    expect(() => assertModuleToolContributionsCompliance([{
      ...contribution,
      unexpected: true,
    }])).toThrow("contains unsupported property unexpected");
    expect(() => assertModuleToolBindingCompliance({
      execute() {},
      dispose() {},
    })).toThrow("contains unsupported property dispose");
    expect(() => assertModuleToolContributionsCompliance([{
      ...contribution,
      inputSchema: { default: undefined },
    }])).toThrow("must contain only JSON values");
    expect(() => assertModuleToolContributionsCompliance([{
      ...contribution,
      inputSchema: { maximum: Number.POSITIVE_INFINITY },
    }])).toThrow("must contain only finite numbers");
    expect(() => assertModuleToolContributionsCompliance([{
      ...contribution,
      inputSchema: new Proxy({}, {}),
    }])).toThrow("must not be a Proxy");

    let tooDeep: Record<string, unknown> = {};
    for (let depth = 0; depth < 32; depth += 1) tooDeep = { nested: tooDeep };
    expect(() => assertModuleToolContributionsCompliance([{
      ...contribution,
      inputSchema: tooDeep,
    }])).toThrow("exceeds JSON depth 32");

    expect(() => assertModuleToolContributionsCompliance([{
      ...contribution,
      inputSchema: {
        enum: Array.from(
          { length: 10_000 },
          (_value, index) => index,
        ),
      },
    }])).toThrow("exceeds 10000 JSON items");

    const mutable = { ...contribution, effects: ["read"] as ("read" | "write")[] };
    const instance = { ...validRuntimeInstance(), toolContributions: [mutable] };
    const snapshot = snapshotSelectedModuleInstanceCompliance("runtime", instance);
    mutable.description = "mutated after validation";
    mutable.effects.push("write");
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      name: "Lookup",
      description: "Look up bounded fixture data.",
      effects: ["read"],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
  });

  it("rejects getter-backed and exotic module tool contributions without invoking accessors", () => {
    let descriptorReads = 0;
    const getterBacked = {
      name: "Lookup",
      inputSchema: {},
      effects: [],
      bind: () => ({ execute() {} }),
    } as Record<string, unknown>;
    Object.defineProperty(getterBacked, "description", {
      enumerable: true,
      get() {
        descriptorReads += 1;
        return "unsafe";
      },
    });
    expect(() => assertModuleToolContributionsCompliance([getterBacked]))
      .toThrow(".description must be an enumerable data property");
    expect(descriptorReads).toBe(0);

    let collectionReads = 0;
    const instance = validRuntimeInstance();
    Object.defineProperty(instance, "toolContributions", {
      enumerable: true,
      get() {
        collectionReads += 1;
        return [];
      },
    });
    expect(() => assertRuntimeInstanceCompliance(instance))
      .toThrow("toolContributions must be an own data property");
    expect(collectionReads).toBe(0);

    const exotic = Object.assign(Object.create({ inherited: true }), {
      name: "Lookup",
      description: "safe",
      inputSchema: {},
      effects: [],
      bind: () => ({ execute() {} }),
    });
    expect(() => assertModuleToolContributionsCompliance([exotic]))
      .toThrow("must be a plain object");
    expect(descriptorReads).toBe(0);
    expect(() => assertModuleToolContributionsCompliance(
      Object.assign(Object.create(Array.prototype), []),
    )).toThrow("must be an ordinary array");

    let effectReads = 0;
    const effects = ["read"];
    Object.defineProperty(effects, "0", {
      enumerable: true,
      get() {
        effectReads += 1;
        return "read";
      },
    });
    expect(() => assertModuleToolContributionsCompliance([{
      name: "Lookup",
      description: "safe",
      inputSchema: {},
      effects,
      bind: () => ({ execute() {} }),
    }])).toThrow("effects.0 must be a data property");
    expect(effectReads).toBe(0);

    const nonEnumerable = {
      name: "Lookup",
      description: "safe",
      inputSchema: {},
      effects: [],
      bind: () => ({ execute() {} }),
    };
    Object.defineProperty(nonEnumerable, "description", {
      value: "safe",
      enumerable: false,
    });
    expect(() => assertModuleToolContributionsCompliance([nonEnumerable]))
      .toThrow(".description must be an enumerable data property");

    const proxied = new Proxy({
      name: "Lookup",
      description: "safe",
      inputSchema: {},
      effects: [],
      bind: () => ({ execute() {} }),
    }, {});
    expect(() => assertModuleToolContributionsCompliance([proxied]))
      .toThrow("must not be a Proxy");
    expect(() => assertModuleToolContributionsCompliance(new Proxy([], {})))
      .toThrow("must be an ordinary array");
  });

  it("rejects identity, API, capability, and reserved-directive drift", () => {
    const invalid = {
      manifest: {
        packageName: "@example/runtime",
        packageVersion: "1.0.0",
        apiVersion: 2,
        kind: "runtime",
        responsibility: "Runs fixture turns.",
        capabilities: ["network", "network"],
      },
      schema,
      create() {},
    };
    const reservedSchema = {
      ...invalid,
      manifest: { ...invalid.manifest, apiVersion: 1, capabilities: [] },
      schema: defineModuleSchema({
        jsonSchema: { type: "object", properties: { $use: { type: "string" } } },
        parse: () => ({}),
      }),
    };
    const invalidReferenceSchema = {
      ...invalid,
      manifest: { ...invalid.manifest, apiVersion: 1, capabilities: [] },
      schema: defineModuleSchema({
        jsonSchema: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              [MODULE_SCHEMA_SLOT_REFERENCE]: { slot: "channel", capability: "" },
            },
          },
        },
        parse: () => ({}),
      }),
    };

    expect(() => assertRuntimeModuleCompliance(invalid)).toThrow("manifest.apiVersion must be 1");
    expect(() => assertRuntimeModuleCompliance(reservedSchema)).toThrow(
      "module schema may not define reserved directive property $use",
    );
    expect(() => assertRuntimeModuleCompliance(invalidReferenceSchema)).toThrow(
      "module schema has an invalid cross-slot reference annotation",
    );
    let schemaAccessorReads = 0;
    const accessorSchema = { type: "object" };
    Object.defineProperty(accessorSchema, "properties", {
      enumerable: true,
      get() {
        schemaAccessorReads += 1;
        return {};
      },
    });
    expect(() => assertRuntimeModuleCompliance({
      ...invalidReferenceSchema,
      schema: { jsonSchema: accessorSchema, parse: () => ({}) },
    })).toThrow("module schema graph.properties must be a data property");
    expect(schemaAccessorReads).toBe(0);
    const inheritedAnnotation = Object.assign(Object.create({
      [MODULE_SCHEMA_SLOT_REFERENCE]: { slot: "channel" },
    }) as Record<string, unknown>, { type: "number" });
    expect(() => assertRuntimeModuleCompliance({
      ...invalidReferenceSchema,
      schema: { jsonSchema: inheritedAnnotation, parse: () => ({}) },
    })).toThrow("module schema graph must contain only plain objects and arrays");
    expect(() => assertChannelModuleCompliance({
      ...reservedSchema,
      schema,
    })).toThrow("manifest.kind must be channel");
  });

  it("fails a 20,000-level schema graph at the deterministic iterative bound", () => {
    const jsonSchema: Record<string, unknown> = { type: "array" };
    let cursor = jsonSchema;
    for (let depth = 0; depth < 20_000; depth += 1) {
      const next: Record<string, unknown> = { type: "array" };
      cursor.items = next;
      cursor = next;
    }
    expect(() => assertRuntimeModuleCompliance({
      manifest: {
        ...manifestBase,
        packageName: "@example/runtime-deep-schema",
        kind: "runtime",
        responsibility: "Exercises bounded schema traversal.",
      },
      schema: { jsonSchema, parse: () => ({}) },
      create() {},
    })).toThrow("module schema graph exceeds 10000 nodes");
  });

  it("requires proactive channels to implement delivery", () => {
    expect(() => assertChannelInstanceCompliance({
      capabilities: {
        attachments: false,
        liveInput: false,
        askUser: false,
        approvals: false,
        proactive: true,
        runtimeControl: false,
        verbatim: false,
        cancellation: true,
      },
    })).toThrow("channel proactive capability and deliver function must match");
    expect(() => assertChannelInstanceCompliance({
      capabilities: {
        attachments: false, liveInput: false, askUser: false, proactive: false,
        runtimeControl: false, verbatim: false, cancellation: true,
      },
      deliver: async (message: { idempotencyKey: string }) => ({
        status: "delivered" as const, idempotencyKey: message.idempotencyKey,
      }),
    })).toThrow("channel proactive capability and deliver function must match");
    expect(() => assertChannelInstanceCompliance({
      capabilities: {
        attachments: false, liveInput: false, askUser: false, proactive: true,
        runtimeControl: false, verbatim: false, cancellation: true,
      },
      deliver: async (message: { idempotencyKey: string }) => ({
        status: "delivered" as const, idempotencyKey: message.idempotencyKey,
      }),
    })).toThrow("channel proactive capability and resolveDeliveryHistory function must match");
    expect(() => assertChannelInstanceCompliance({
      capabilities: {
        attachments: false, liveInput: false, askUser: false, proactive: false,
        runtimeControl: false, verbatim: false, cancellation: true,
      },
      resolveDefaultDeliveryConversationId: "telegram:42",
    })).toThrow("resolveDefaultDeliveryConversationId must be a function");
  });

  it("runs reusable lifecycle, delivery, health, and redaction checks", async () => {
    const calls: string[] = [];
    const receipts = new Map<string, string>();
    const capabilities = {
      attachments: false, liveInput: false, askUser: false, approvals: false,
      proactive: true, runtimeControl: false, verbatim: false, cancellation: true,
    } as const;
    const delivered = { conversationId: "chat", text: "hello", idempotencyKey: "known" };
    await assertChannelBehaviorCompliance({
      create: () => {
        let running = false;
        return {
          capabilities,
          start() { calls.push("start"); running = true; },
          drain() { calls.push("drain"); },
          stop() { calls.push("stop"); running = false; },
          health: () => ({
            status: running ? "healthy" as const : "unknown" as const,
            checkedAt: new Date().toISOString(),
          }),
          diagnostics: () => [{ code: "fixture", severity: "info", message: "safe" }],
          resolveDeliveryHistory: (message) => ({
            conversationId: message.conversationId,
          }),
          async deliver(message) {
            if (message.idempotencyKey === "unknown") {
              return { status: "unknown", idempotencyKey: message.idempotencyKey };
            }
            const prior = receipts.get(message.idempotencyKey);
            if (prior !== undefined && prior !== message.text) {
              return { status: "failed", idempotencyKey: message.idempotencyKey };
            }
            if (prior !== undefined) return { status: "duplicate", idempotencyKey: message.idempotencyKey };
            receipts.set(message.idempotencyKey, message.text);
            return { status: "delivered", idempotencyKey: message.idempotencyKey };
          },
        };
      },
      exercise: (_instance, signal) => { expect(signal.aborted).toBe(false); calls.push("exercise"); },
      delivery: {
        delivered,
        conflicting: { ...delivered, text: "different" },
        unknown: { ...delivered, idempotencyKey: "unknown" },
      },
      secrets: ["not-present"],
    });
    expect(calls).toEqual(["start", "stop", "start", "exercise", "drain", "stop", "stop"]);

    await expect(assertChannelBehaviorCompliance({
      create: () => ({
        capabilities: { ...capabilities, proactive: false },
        health: () => ({ status: "healthy", checkedAt: new Date().toISOString(), summary: "secret" }),
      }),
      exercise() {},
      secrets: ["secret"],
    })).rejects.toThrow("reports contain a configured secret");

    const escapedSecret = "quote\"slash\\line\n";
    await expect(assertChannelBehaviorCompliance({
      create: () => ({
        capabilities: { ...capabilities, proactive: false },
        health: () => ({
          status: "healthy",
          checkedAt: new Date().toISOString(),
          summary: escapedSecret,
        }),
      }),
      exercise() {},
      secrets: [escapedSecret],
    })).rejects.toThrow("reports contain a configured secret");
  });

  it("rejects a clean stop that allows an unsettled channel start to become healthy", async () => {
    let releaseStart = (): void => undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const capabilities = {
      attachments: false, liveInput: false, askUser: false, approvals: false,
      proactive: false, runtimeControl: false, verbatim: false, cancellation: true,
    } as const;

    await expect(assertChannelBehaviorCompliance({
      create: () => {
        let running = false;
        return {
          capabilities,
          async start() {
            await startGate;
            running = true;
          },
          stop() {
            releaseStart();
          },
          health: () => ({
            status: running ? "healthy" as const : "unknown" as const,
            checkedAt: new Date().toISOString(),
          }),
        };
      },
      exercise() {},
    })).rejects.toThrow("stop resolved while an unsettled start remained healthy");
  });

  it("accepts a bounded concurrent-stop rejection before exercising a fresh channel", async () => {
    let created = 0;
    const capabilities = {
      attachments: false, liveInput: false, askUser: false, approvals: false,
      proactive: false, runtimeControl: false, verbatim: false, cancellation: true,
    } as const;

    await expect(assertChannelBehaviorCompliance({
      create: () => {
        created += 1;
        let running = false;
        const rejectStop = created === 1;
        return {
          capabilities,
          start() {
            running = true;
          },
          stop() {
            running = false;
            if (rejectStop) throw new Error("bounded startup shutdown");
          },
          health: () => ({
            status: running ? "healthy" as const : "unknown" as const,
            checkedAt: new Date().toISOString(),
          }),
        };
      },
      exercise() {},
    })).resolves.toBeUndefined();
    expect(created).toBe(2);
  });

  it("runs every process and in-process runtime behavior scenario with fresh lifecycle cleanup", async () => {
    const processCalls: string[] = [];
    await expect(assertRuntimeBehaviorCompliance(runtimeBehaviorOptions({
      profile: "process", calls: processCalls,
    }))).resolves.toBeUndefined();
    expect(processCalls.filter((call) => call.startsWith("create:"))).toEqual([
      "create:completed", "create:cancelled", "create:process-exit",
      "create:stdin-error", "create:stderr-exit",
    ]);
    expect(processCalls.filter((call) => call.startsWith("stop:"))).toHaveLength(10);
    expect(processCalls.filter((call) => call.startsWith("dispose:"))).toHaveLength(5);

    const inProcessCalls: string[] = [];
    await expect(assertRuntimeBehaviorCompliance(runtimeBehaviorOptions({
      profile: "in-process", calls: inProcessCalls,
    }))).resolves.toBeUndefined();
    expect(inProcessCalls.filter((call) => call.startsWith("create:"))).toEqual([
      "create:completed", "create:cancelled",
    ]);
  });

  it.each([
    ["completed", "completed must emit and return its marker"],
    ["cancelled", "cancelled must settle as cancelled"],
    ["process-exit", "process-exit must throw a typed error containing its marker"],
    ["stdin-error", "stdin-error must throw a typed error containing its marker"],
    ["stderr-exit", "stderr-exit must throw a typed error containing its marker"],
  ] as const)("proves the %s runtime behavior scenario bites", async (breakScenario, message) => {
    await expect(assertRuntimeBehaviorCompliance(runtimeBehaviorOptions({ breakScenario })))
      .rejects.toThrow(message);
  });

  it("rejects provider-operation and stopped-process leaks", async () => {
    await expect(assertRuntimeBehaviorCompliance(runtimeBehaviorOptions({ activeLeak: true })))
      .rejects.toThrow("completed leaked provider operations");
    await expect(assertRuntimeBehaviorCompliance(runtimeBehaviorOptions({ processLeak: true })))
      .rejects.toThrow("completed left provider processes after stop");
  });

  it.each(["secret", "quote\"slash\\line\n"])(
    "rejects raw or JSON-escaped secrets in runtime reports",
    async (reportSecret) => {
      await expect(assertRuntimeBehaviorCompliance(runtimeBehaviorOptions({ reportSecret })))
        .rejects.toThrow("runtime behavior reports contain a configured secret");
    },
  );

  it("rejects oversized reports and a non-idempotent second stop", async () => {
    await expect(assertRuntimeBehaviorCompliance(runtimeBehaviorOptions({ oversizedReport: true })))
      .rejects.toThrow("runtime behavior reports exceed 64 KiB");
    const calls: string[] = [];
    await expect(assertRuntimeBehaviorCompliance(runtimeBehaviorOptions({ secondStopFails: true, calls })))
      .rejects.toThrow("fixture second stop failed");
    expect(calls.filter((call) => call.startsWith("dispose:"))).toHaveLength(1);
  });

  it("always finishes cleanup without masking the primary behavior failure", async () => {
    const calls: string[] = [];
    await expect(assertRuntimeBehaviorCompliance(runtimeBehaviorOptions({
      breakScenario: "completed", secondStopFails: true, calls,
    }))).rejects.toThrow("completed must emit and return its marker");
    expect(calls.filter((call) => call.startsWith("stop:"))).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith("dispose:"))).toHaveLength(1);
  });

  it("validates model-visible channel send tools", () => {
    const capabilities = {
      attachments: false, liveInput: false, askUser: false, proactive: true,
      runtimeControl: false, verbatim: false, cancellation: true,
    };
    const sendTool = {
      name: "SendMessage", description: "Send one message.",
      inputSchema: { type: "object", additionalProperties: false },
      prepare: () => ({ conversationId: "chat", text: "hello" }),
    };
    const resolveDeliveryHistory = () => ({ conversationId: "chat" });
    expect(() => assertChannelInstanceCompliance({
      capabilities, deliver: async () => ({ status: "delivered", idempotencyKey: "key" }),
      resolveDeliveryHistory, sendTools: [sendTool],
    })).not.toThrow();
    expect(() => assertChannelInstanceCompliance({
      capabilities: { ...capabilities, proactive: false }, sendTools: [sendTool],
    })).toThrow("channel sendTools require proactive capability and delivery");
    expect(() => assertChannelInstanceCompliance({
      capabilities, deliver: async () => ({ status: "delivered", idempotencyKey: "key" }),
      resolveDeliveryHistory, sendTools: [sendTool, sendTool],
    })).toThrow("duplicate SendMessage");
    let reads = 0;
    const accessor = { ...sendTool };
    Object.defineProperty(accessor, "prepare", { get() { reads += 1; return () => ({}); } });
    expect(() => assertChannelInstanceCompliance({
      capabilities, deliver: async () => ({ status: "delivered", idempotencyKey: "key" }),
      resolveDeliveryHistory, sendTools: [accessor],
    })).toThrow("prepare must be a data property");
    expect(reads).toBe(0);
  });

  it("requires truthful channel, memory, and runtime optional surfaces", () => {
    expect(() => assertChannelInstanceCompliance({
      capabilities: {
        attachments: false,
        liveInput: false,
        askUser: false,
        proactive: false,
        runtimeControl: false,
        verbatim: false,
        cancellation: true,
      },
    })).not.toThrow();
    expect(() => assertChannelInstanceCompliance({
      capabilities: {
        attachments: false,
        liveInput: false,
        askUser: false,
        approvals: "sometimes",
        proactive: false,
        runtimeControl: false,
        verbatim: false,
        cancellation: true,
      },
    })).toThrow("channel capabilities.approvals must be a boolean when present");

    expect(() => assertMemoryInstanceCompliance({
      capabilities: { capture: true, forget: false },
      recall() {},
    })).toThrow("capture-capable memory instance capture must be a function");
    expect(() => assertMemoryInstanceCompliance({
      capabilities: { capture: false, forget: true },
      recall() {},
    })).toThrow("forget-capable memory instance forget must be a function");
    expect(() => assertMemoryInstanceCompliance({
      capabilities: { capture: true, forget: true, recallTool: true },
      recall() {},
      capture() {},
      forget() { return false; },
    })).not.toThrow();
    expect(() => assertMemoryInstanceCompliance({
      capabilities: { capture: false, forget: false, recallTool: "sometimes" },
      recall() {},
    })).toThrow("memory capabilities.recallTool must be a boolean when present");

    expect(() => assertRuntimeInstanceCompliance({
      capabilities: {
        tools: false,
        mcp: false,
        attachments: false,
        approvals: false,
        structuredOutput: false,
        sandbox: false,
        sessions: false,
      },
      runTurn() {},
      preflightModel: "not-a-function",
    })).toThrow("runtime instance preflightModel must be a function when present");

    expect(() => assertRuntimeModuleCompliance({
      manifest: {
        ...manifestBase,
        packageName: "@example/runtime-invalid-validator",
        kind: "runtime",
        responsibility: "Has an invalid pure model validator.",
      },
      schema,
      validateModel: true,
      create() {},
    })).toThrow("runtime module definition validateModel must be a function when present");
  });

  it("matches Core's exact own-data capability authority boundary", () => {
    const runtimeCapabilities = {
      tools: false,
      mcp: false,
      attachments: false,
      approvals: false,
      structuredOutput: false,
      sandbox: false,
      sessions: false,
    };
    const channelCapabilities = {
      attachments: false,
      liveInput: false,
      askUser: false,
      proactive: false,
      runtimeControl: false,
      verbatim: false,
      cancellation: false,
    };

    expect(() => assertRuntimeInstanceCompliance({
      capabilities: {
        ...runtimeCapabilities,
        artifactResults: true,
        liveInput: false,
        maxTurns: true,
        maxOutputTokens: true,
      },
      runTurn() {},
    })).not.toThrow();
    expect(() => assertChannelInstanceCompliance({
      capabilities: { ...channelCapabilities },
    })).not.toThrow();

    expect(() => assertRuntimeInstanceCompliance({
      capabilities: { ...runtimeCapabilities, unexpected: false },
      runTurn() {},
    })).toThrow('runtime capabilities contains unknown key "unexpected"');
    expect(() => assertChannelInstanceCompliance({
      capabilities: Object.create(channelCapabilities) as unknown,
    })).toThrow("channel capabilities must be a plain object");

    const symbolCapabilities = { ...runtimeCapabilities } as Record<PropertyKey, unknown>;
    symbolCapabilities[Symbol("unknown")] = false;
    expect(() => assertRuntimeInstanceCompliance({
      capabilities: symbolCapabilities,
      runTurn() {},
    })).toThrow("runtime capabilities contains an unknown symbol key");

    let fieldAccessorCalls = 0;
    const accessorCapabilities = { ...channelCapabilities };
    Object.defineProperty(accessorCapabilities, "askUser", {
      enumerable: true,
      get() {
        fieldAccessorCalls += 1;
        return false;
      },
    });
    expect(() => assertChannelInstanceCompliance({
      capabilities: accessorCapabilities,
    })).toThrow("channel capabilities.askUser must be a data property");
    expect(fieldAccessorCalls).toBe(0);

    let instanceAccessorCalls = 0;
    const accessorInstance = {};
    Object.defineProperty(accessorInstance, "capabilities", {
      enumerable: true,
      get() {
        instanceAccessorCalls += 1;
        return runtimeCapabilities;
      },
    });
    expect(() => assertRuntimeInstanceCompliance(accessorInstance)).toThrow(
      "runtime instance.capabilities must be a data property",
    );
    expect(instanceAccessorCalls).toBe(0);
  });
});

interface RuntimeBehaviorFixtureOptions {
  readonly profile?: "process" | "in-process";
  readonly breakScenario?: RuntimeBehaviorScenario["kind"];
  readonly activeLeak?: boolean;
  readonly processLeak?: boolean;
  readonly reportSecret?: string;
  readonly oversizedReport?: boolean;
  readonly secondStopFails?: boolean;
  readonly calls?: string[];
}

function runtimeBehaviorOptions(options: RuntimeBehaviorFixtureOptions = {}):
RuntimeBehaviorComplianceOptions {
  const profile = options.profile ?? "process";
  return {
    profile,
    timeoutMs: 1_000,
    ...(options.reportSecret === undefined ? {} : { secrets: [options.reportSecret] }),
    create(scenario) {
      options.calls?.push(`create:${scenario.kind}`);
      let state: "created" | "running" | "draining" | "stopped" = "created";
      let activeProviderOperations = 0;
      let liveProcesses = profile === "process" ? 0 : undefined;
      let stopCalls = 0;
      let resolveActive!: () => void;
      let resolveTrigger!: () => void;
      const active = new Promise<void>((resolve) => { resolveActive = resolve; });
      const triggered = new Promise<void>((resolve) => { resolveTrigger = resolve; });
      const instance: Runtime = {
        capabilities: {
          tools: true, mcp: false, attachments: false, approvals: false,
          structuredOutput: false, sandbox: false, sessions: false,
        },
        start() {
          state = "running";
          if (profile === "process") liveProcesses = 1;
        },
        drain() { state = "draining"; },
        stop() {
          stopCalls += 1;
          options.calls?.push(`stop:${scenario.kind}`);
          if (options.secondStopFails === true && stopCalls === 2) {
            throw new Error("fixture second stop failed");
          }
          state = "stopped";
          activeProviderOperations = 0;
          if (options.processLeak !== true && profile === "process") liveProcesses = 0;
        },
        health: () => ({
          status: state === "running" ? "healthy" : state === "draining" ? "degraded" : "unknown",
          checkedAt: new Date().toISOString(),
          summary: options.oversizedReport === true
            ? "x".repeat(64 * 1_024 + 1)
            : options.reportSecret ?? "safe",
        }),
        diagnostics: () => [{ code: "fixture", severity: "info", message: "safe" }],
        async runTurn(request, context) {
          activeProviderOperations = 1;
          resolveActive();
          try {
            if (scenario.kind === "completed") {
              const marker = options.breakScenario === "completed" ? "wrong-marker" : scenario.marker;
              await context.emit({ type: "text-delta", delta: marker });
              const call = { id: "runtime-compliance-call", name: "RuntimeComplianceTool", input: {} };
              await context.emit({ type: "tool-call", call });
              const result = await context.executeTool(call, request.signal);
              await context.emit({ type: "tool-result", result });
              return {
                status: "completed",
                message: { role: "assistant", content: [{ type: "text", text: marker }] },
              };
            }
            if (scenario.kind === "cancelled") {
              await new Promise<void>((resolve) => {
                if (request.signal.aborted) resolve();
                else request.signal.addEventListener("abort", () => resolve(), { once: true });
              });
              return options.breakScenario === "cancelled"
                ? {
                    status: "completed",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: scenario.marker }],
                    },
                  }
                : { status: "cancelled" };
            }
            await triggered;
            if (options.breakScenario === scenario.kind) throw new Error(scenario.marker);
            throw new RuntimeTurnError({
              code: `fixture_${scenario.kind}`,
              message: `${scenario.marker} provider failure`,
              retryability: "not-retryable",
              sideEffects: "none",
            });
          } finally {
            activeProviderOperations = options.activeLeak === true ? 1 : 0;
          }
        },
      };
      return {
        instance,
        model: "fixture/model",
        waitUntilActive: () => active,
        trigger: () => { resolveTrigger(); },
        observe: () => ({
          activeProviderOperations,
          ...(liveProcesses === undefined ? {} : { liveProcesses }),
        }),
        dispose: () => { options.calls?.push(`dispose:${scenario.kind}`); },
      };
    },
  };
}

function validRuntimeInstance(): Record<string, unknown> {
  return {
    capabilities: {
      tools: false,
      mcp: false,
      attachments: false,
      approvals: false,
      structuredOutput: false,
      sandbox: false,
      sessions: false,
    },
    runTurn() {},
  };
}

describe("entrypoint boundary", () => {
  it("does not export reserved-slot factories from any supported entrypoint", () => {
    for (const name of [
      "defineStateModule",
      "defineTriggerModule",
      "defineExporterModule",
      "defineSandboxModule",
    ]) {
      expect(publicApi).not.toHaveProperty(name);
      expect(internalApi).not.toHaveProperty(name);
    }
    expect(internalApi).toHaveProperty("RESERVED_MODULE_KINDS");
  });
});
