import { describe, expect, it } from "vitest";

import * as publicApi from "../index.js";
import {
  MODULE_API_VERSION,
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
          proactive: false,
          runtimeControl: false,
          verbatim: false,
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
        proactive: false,
        runtimeControl: false,
        verbatim: false,
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

    expect(() => assertRuntimeModuleCompliance(invalid)).toThrow("manifest.apiVersion must be 1");
    expect(() => assertRuntimeModuleCompliance(reservedSchema)).toThrow(
      "module schema may not define reserved directive property $use",
    );
    expect(() => assertChannelModuleCompliance({
      ...reservedSchema,
      schema,
    })).toThrow("manifest.kind must be channel");
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
