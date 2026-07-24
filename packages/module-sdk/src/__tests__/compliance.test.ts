import { describe, expect, it } from "vitest";

import * as publicApi from "../index.js";
import {
  MODULE_API_VERSION,
  MODULE_SCHEMA_SLOT_REFERENCE,
  defineChannelModule,
  defineMemoryModule,
  defineModuleSchema,
  defineRuntimeModule,
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
  assertRuntimeInstanceCompliance,
  assertRuntimeModuleCompliance,
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
      create: () => ({
        capabilities,
        start() { calls.push("start"); },
        drain() { calls.push("drain"); },
        stop() { calls.push("stop"); },
        health: () => ({ status: "healthy", checkedAt: new Date().toISOString() }),
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
      }),
      exercise: (_instance, signal) => { expect(signal.aborted).toBe(false); calls.push("exercise"); },
      delivery: {
        delivered,
        conflicting: { ...delivered, text: "different" },
        unknown: { ...delivered, idempotencyKey: "unknown" },
      },
      secrets: ["not-present"],
    });
    expect(calls).toEqual(["start", "exercise", "drain", "stop", "stop"]);

    await expect(assertChannelBehaviorCompliance({
      create: () => ({
        capabilities: { ...capabilities, proactive: false },
        health: () => ({ status: "healthy", checkedAt: new Date().toISOString(), summary: "secret" }),
      }),
      exercise() {},
      secrets: ["secret"],
    })).rejects.toThrow("reports contain a configured secret");
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
