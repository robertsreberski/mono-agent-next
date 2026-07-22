import { describe, expect, it, vi } from "vitest";

import {
  MODULE_API_VERSION,
  ModuleConfigError,
  configIssue,
  configPathToPointer,
  defineChannelModule,
  defineConfigProvenance,
  defineMemoryModule,
  defineModuleSchema,
  defineRuntimeModule,
  envEligibleSchema,
  isEnvEligibleSchema,
  isSecretSchema,
  parseModuleConfig,
  provenanceAt,
  type Channel,
  type Memory,
  type Runtime,
} from "../index.js";
import {
  defineExporterModule,
  defineSandboxModule,
  defineStateModule,
  defineTriggerModule,
} from "../internal.js";

const emptySchema = defineModuleSchema({
  jsonSchema: { type: "object", additionalProperties: false },
  parse(input: unknown) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("expected an object");
    }
    return {};
  },
});

const runtime: Runtime = {
  capabilities: {
    tools: true,
    mcp: true,
    attachments: true,
    approvals: true,
    structuredOutput: true,
    sandbox: true,
    sessions: true,
  },
  async runTurn(request) {
    return {
      status: "completed",
      message: { role: "assistant", content: [{ type: "text", text: request.model }] },
    };
  },
};

const channel: Channel = {
  capabilities: {
    attachments: true,
    liveInput: true,
    askUser: true,
    proactive: true,
    runtimeControl: true,
    verbatim: true,
  },
};

const memory: Memory = {
  capabilities: { capture: true, forget: true },
  async recall() {
    return { records: [] };
  },
};

describe("public module definitions", () => {
  it("constructs immutable, import-safe definitions without calling create", () => {
    const create = vi.fn(() => runtime);
    const definition = defineRuntimeModule({
      manifest: {
        packageName: "@example/runtime",
        packageVersion: "1.2.3",
        apiVersion: MODULE_API_VERSION,
        kind: "runtime",
        responsibility: "Runs example turns.",
        capabilities: [],
      },
      schema: emptySchema,
      create,
    });

    expect(create).not.toHaveBeenCalled();
    expect(definition).toMatchObject({
      manifest: {
        packageName: "@example/runtime",
        packageVersion: "1.2.3",
        apiVersion: 1,
        kind: "runtime",
      },
      schema: { jsonSchema: { type: "object" } },
    });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.manifest)).toBe(true);
    expect(Object.isFrozen(definition.manifest.capabilities)).toBe(true);

    const configDirectory = "/agent/config";
    definition.create({
      instanceId: "runtime",
      config: {},
      provenance: {},
      configDirectory,
      workspaceDirectory: "/agent/workspace",
      dataDirectory: "/agent/data/runtime",
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
      host: {
        grantedCapabilities: new Set(),
        getCapability<T>() { return undefined as T | undefined; },
      },
      signal: new AbortController().signal,
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ configDirectory }));
  });

  it("keeps the three open factories kind-specific", () => {
    const channelDefinition = defineChannelModule({
      manifest: {
        packageName: "@example/channel",
        packageVersion: "1.0.0",
        apiVersion: MODULE_API_VERSION,
        kind: "channel",
        responsibility: "Carries example messages.",
        capabilities: [],
      },
      schema: emptySchema,
      create: () => channel,
    });
    const memoryDefinition = defineMemoryModule({
      manifest: {
        packageName: "@example/memory",
        packageVersion: "1.0.0",
        apiVersion: MODULE_API_VERSION,
        kind: "memory",
        responsibility: "Recalls example records.",
        capabilities: [],
      },
      schema: emptySchema,
      create: () => memory,
    });

    expect(channelDefinition.manifest.kind).toBe("channel");
    expect(memoryDefinition.manifest.kind).toBe("memory");
  });
});

describe("schema and provenance helpers", () => {
  it("marks env-eligible secret scalars without redefining the $env directive", () => {
    const schema = envEligibleSchema({ type: "string", minLength: 1 }, { secret: true });

    expect(schema).toMatchObject({
      type: "string",
      "x-mono-agent-env-eligible": true,
      "x-mono-agent-secret": true,
    });
    expect(schema).not.toHaveProperty("properties.$env");
    expect(isEnvEligibleSchema(schema)).toBe(true);
    expect(isSecretSchema(schema)).toBe(true);
  });

  it("uses escaped JSON pointers and nearest-ancestor provenance", () => {
    const file = defineConfigProvenance({ source: "file", filePath: "/agent/config.json" });
    const environment = defineConfigProvenance({
      source: "environment",
      environmentName: "EXAMPLE_TOKEN",
    });
    const provenance = {
      "": file,
      "/auth/token": environment,
    };

    expect(configPathToPointer(["a/b", "~value", 0])).toBe("/a~1b/~0value/0");
    expect(provenanceAt(provenance, ["auth", "token"])).toBe(environment);
    expect(provenanceAt(provenance, ["auth", "other"])).toBe(file);
  });

  it("preserves structured config errors and safely wraps ordinary parser errors", () => {
    const provenance = {
      "": defineConfigProvenance({ source: "file", filePath: "/agent/config.json" }),
    };
    const structured = new ModuleConfigError({
      issues: [configIssue("missing", "model is required", ["model"])],
    });
    const structuredSchema = defineModuleSchema({
      jsonSchema: {},
      parse(): never {
        throw structured;
      },
    });
    const ordinarySchema = defineModuleSchema({
      jsonSchema: {},
      parse(): never {
        throw new Error("bad token shape");
      },
    });

    expect(() => parseModuleConfig(structuredSchema, {})).toThrow(structured);
    expect(() => parseModuleConfig(ordinarySchema, {}, {
      packageName: "@example/runtime",
      provenance,
    })).toThrowError(expect.objectContaining({
      code: "MODULE_CONFIG_INVALID",
      issues: [expect.objectContaining({
        code: "invalid_config",
        provenance: { source: "file", filePath: "/agent/config.json" },
      })],
    }));
  });
});

describe("reserved module definitions", () => {
  it("keeps every reserved factory on the internal entrypoint", () => {
    const baseManifest = {
      packageName: "@mono-agent/internal-fixture",
      packageVersion: "1.0.0",
      apiVersion: MODULE_API_VERSION,
      responsibility: "Exercises a reserved contract.",
      capabilities: [],
    } as const;

    const state = defineStateModule({
      manifest: { ...baseManifest, kind: "state" },
      schema: emptySchema,
      create: () => ({
        async read() { return undefined; },
        async write() { return { version: "1", updatedAt: "2026-07-22T00:00:00.000Z" }; },
        async delete() { return false; },
        async list() { return { records: [] }; },
      }),
    });
    const trigger = defineTriggerModule({
      manifest: { ...baseManifest, kind: "trigger" },
      schema: emptySchema,
      create: () => ({}),
    });
    const exporter = defineExporterModule({
      manifest: { ...baseManifest, kind: "exporter" },
      schema: emptySchema,
      create: () => ({ async export() { return { accepted: 0, rejected: 0 }; } }),
    });
    const sandbox = defineSandboxModule({
      manifest: { ...baseManifest, kind: "sandbox" },
      schema: emptySchema,
      create: () => ({
        async execute() {
          return {
            exitCode: 0,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            timedOut: false,
          };
        },
      }),
    });

    expect([state, trigger, exporter, sandbox].map((item) => item.manifest.kind)).toEqual([
      "state",
      "trigger",
      "exporter",
      "sandbox",
    ]);
  });
});
