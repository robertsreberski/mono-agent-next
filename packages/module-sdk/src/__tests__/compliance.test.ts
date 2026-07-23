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
  assertChannelInstanceCompliance,
  assertChannelModuleCompliance,
  assertMemoryInstanceCompliance,
  assertMemoryModuleCompliance,
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
    })).toThrow("proactive channel instance deliver must be a function");
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
      capabilities: { capture: true, forget: true },
      recall() {},
      capture() {},
      forget() { return false; },
    })).not.toThrow();

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

describe("entrypoint boundary", () => {
  it("exports reserved definitions only from the internal entrypoint", () => {
    for (const name of [
      "defineStateModule",
      "defineTriggerModule",
      "defineExporterModule",
      "defineSandboxModule",
    ]) {
      expect(publicApi).not.toHaveProperty(name);
      expect(internalApi).toHaveProperty(name);
    }
  });
});
