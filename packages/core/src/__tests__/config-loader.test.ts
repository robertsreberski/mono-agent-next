import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentConfigError,
  composeAgentConfigSchema,
  createAgentHost,
  explainAgentConfig,
  loadAgentConfig,
  validateAgentConfig,
} from "../index.js";
import type { FixtureProject } from "./fixture.js";
import {
  createFixtureProject,
  minimalConfig,
  replacePackageEntryWithSymlink,
  runtimeController,
} from "./fixture.js";

const projects: FixtureProject[] = [];

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

describe("strict config and module loading", () => {
  it("loads read-only, resolves core paths from the config directory, and never starts a module", async () => {
    let created = 0;
    const project = await fixture({
      kind: "runtime",
      controller: {
        create() {
          created += 1;
          return {};
        },
      },
    });
    const runtime = project.modules[0]!.name;
    await project.writeConfig(minimalConfig(runtime, {
      $schema: "./schema.json",
      context: { skills: { roots: ["./skills"] }, mcp: { configPath: "./.mcp.json" } },
    }));
    await writeFile(join(project.root, ".mcp.json"), '{"mcpServers":{}}\n');
    const before = await tree(project.root);
    const loaded = await loadAgentConfig(project.configPath);
    const after = await tree(project.root);

    expect(after).toEqual(before);
    expect(created).toBe(0);
    expect(loaded.paths.workspace).toBe(project.root);
    expect(loaded.paths.instructions).toBe(join(project.root, "AGENTS.md"));
    expect(loaded.paths.schema).toBe(join(project.root, "schema.json"));
    expect(loaded.paths.skillRoots).toEqual([join(project.root, "skills")]);
    expect(loaded.paths.mcpConfig).toBe(join(project.root, ".mcp.json"));
    expect(loaded.mcp).toEqual({ mcpServers: {} });
    expect(loaded.sources.mcp).toMatchObject({
      path: join(project.root, ".mcp.json"),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.raw)).toBe(true);
    expect(Object.isFrozen(loaded.mcp)).toBe(true);
  });

  it("returns an opaque immutable snapshot of the exact validated config and MCP bytes", async () => {
    const project = await fixture({ kind: "runtime", controller: runtimeController(async () => ({})) });
    const runtime = project.modules[0]!.name;
    const config = minimalConfig(runtime, {
      context: { mcp: { configPath: "./.mcp.json" } },
    });
    await project.writeConfig(config);
    await project.writeMcp({
      mcpServers: {
        first: { type: "http", url: "http://127.0.0.1:3210/mcp" },
      },
    });
    const configBytes = await readFile(project.configPath);
    const loaded = await loadAgentConfig(project.configPath);

    await project.writeConfig({ ...config, agent: { ...config.agent, name: "Changed" } });
    await project.writeMcp({
      mcpServers: {
        replacement: { type: "http", url: "http://127.0.0.1:4321/mcp" },
      },
    });

    expect(loaded.raw.agent.name).toBe("Fixture Agent");
    expect(Object.keys(loaded.mcp.mcpServers)).toEqual(["first"]);
    expect(loaded.sources.config).toMatchObject({
      path: project.configPath,
      sha256: createHash("sha256").update(configBytes).digest("hex"),
      sizeBytes: configBytes.byteLength,
    });
    expect(Object.isFrozen(loaded.mcp.mcpServers.first)).toBe(true);
    const explanation = await explainAgentConfig(loaded);
    expect(explanation.entries).toContainEqual(expect.objectContaining({
      path: "routing.fallbacks",
      owner: "@mono-agent/core",
      source: "config",
      value: [],
    }));
    expect(explanation.entries).toContainEqual(expect.objectContaining({
      path: "policy.tools.allow",
      owner: "@mono-agent/core",
      source: "config",
      value: [],
    }));

    const clone = { ...loaded };
    await expect(composeAgentConfigSchema(clone)).rejects.toMatchObject({
      name: "AgentConfigError",
      issues: [expect.objectContaining({ code: "unvalidated_snapshot" })],
    });
  });

  it("detaches and freezes the exact parsed module config before creation", async () => {
    let retained!: {
      mode: string;
      nested: { value: string };
    };
    let createdConfig: unknown;
    const validRuntime = runtimeController(async () => ({ status: "cancelled" }));
    const project = await fixture({
      kind: "runtime",
      schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      controller: {
        parse() {
          retained = {
            mode: "validated",
            nested: { value: "validated" },
          };
          return retained;
        },
        create(context) {
          createdConfig = (context as { readonly config: unknown }).config;
          return validRuntime.create(context);
        },
      },
    });
    await project.writeConfig(minimalConfig(project.modules[0]!.name));
    const loaded = await loadAgentConfig(project.configPath);

    retained.mode = "mutated";
    retained.nested.value = "mutated";
    const host = await createAgentHost(loaded);

    expect(createdConfig).toEqual({
      mode: "validated",
      nested: { value: "validated" },
    });
    expect(createdConfig).not.toBe(retained);
    expect(Object.isFrozen(createdConfig)).toBe(true);
    expect(Object.isFrozen((createdConfig as { nested: object }).nested)).toBe(true);
    await host.stop();
  });

  it("rejects accessor, proxy, exotic, and cyclic parsed module config graphs", async () => {
    let accessorReads = 0;
    let proxyTraps = 0;
    const accessor = {};
    Object.defineProperty(accessor, "mode", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return "unsafe";
      },
    });
    const proxy = new Proxy({ mode: "unsafe" }, {
      getPrototypeOf(target) {
        proxyTraps += 1;
        return Reflect.getPrototypeOf(target);
      },
    });
    const exotic = Object.assign(Object.create({ inherited: "unsafe" }), {
      mode: "unsafe",
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    for (const [value, pattern] of [
      [accessor, /enumerable data property/u],
      [proxy, /Proxy/u],
      [exotic, /plain object/u],
      [cyclic, /cycles/u],
    ] as const) {
      const project = await fixture({
        kind: "runtime",
        controller: {
          parse: () => value,
          create: () => {
            throw new Error("host must not create a module from rejected config");
          },
        },
      });
      await project.writeConfig(minimalConfig(project.modules[0]!.name));
      await expectConfigIssue(loadAgentConfig(project.configPath), pattern);
    }
    expect(accessorReads).toBe(0);
    expect(proxyTraps).toBe(0);
  });

  it("validates referenced MCP syntax before importing selected module code", async () => {
    const project = await fixture({
      kind: "runtime",
      entrySource: `
import { writeFileSync } from "node:fs";
writeFileSync(new URL("./IMPORT_MARKER", import.meta.url), "imported");
export const monoAgentModule = {};
`,
    });
    const marker = join(
      project.root,
      "node_modules",
      ...project.modules[0]!.name.split("/"),
      "IMPORT_MARKER",
    );
    await project.writeMcp({ mcpServers: { broken: { type: "unsupported" } } });
    await project.writeConfig(minimalConfig(project.modules[0]!.name, {
      context: { mcp: { configPath: "./.mcp.json" } },
    }));

    const result = await validateAgentConfig(project.configPath);

    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({
        path: "mcpServers.broken.type",
        code: "enum",
      })],
    });
    await expect(access(marker)).rejects.toThrow();
  });

  it("rejects unknown fields at every core-owned level", async () => {
    const project = await fixture({ kind: "runtime", controller: runtimeController(async () => ({})) });
    const config = minimalConfig(project.modules[0]!.name) as unknown as Record<string, unknown>;
    config.surprise = true;
    config.agent = { ...(config.agent as object), surprise: true };
    config.routing = { ...(config.routing as object), surprise: true };
    config.policy = {
      ...(config.policy as object),
      tools: { default: "deny", allow: [], surprise: true },
    };
    await project.writeConfig(config);
    const result = await validateAgentConfig(project.configPath);
    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      "surprise",
      "agent.surprise",
      "routing.surprise",
      "policy.tools.surprise",
    ]));
  });

  it("validates session timezones as IANA identifiers during config loading", async () => {
    const project = await fixture({ kind: "runtime", controller: runtimeController(async () => ({})) });
    const runtime = project.modules[0]!.name;
    for (const timezone of ["UTC", "Europe/Amsterdam"]) {
      await project.writeConfig(minimalConfig(runtime, {
        session: { mode: "continuous", rollover: "daily", timezone },
      }));
      await expect(loadAgentConfig(project.configPath)).resolves.toMatchObject({
        raw: { session: { timezone } },
      });
    }

    for (const timezone of ["Mars/Olympus_Mons", "+01:00"]) {
      await project.writeConfig(minimalConfig(runtime, {
        session: { mode: "continuous", rollover: "daily", timezone },
      }));
      const result = await validateAgentConfig(project.configPath);
      expect(result).toMatchObject({
        ok: false,
        issues: [expect.objectContaining({
          path: "session.timezone",
          message: "must be a valid IANA time zone",
          code: "timezone",
        })],
      });
    }
  });

  it("rejects the unsupported skill selection mode instead of silently loading every skill", async () => {
    const project = await fixture({ kind: "runtime", controller: runtimeController(async () => ({})) });
    const runtime = project.modules[0]!.name;
    await project.writeConfig(minimalConfig(runtime, {
      context: { skills: { roots: ["./skills"], load: "selected", disclosure: "index" } },
    }));

    await expect(validateAgentConfig(project.configPath)).resolves.toMatchObject({
      ok: false,
      issues: [expect.objectContaining({
        path: "context.skills.load",
        message: "must be one of \"all\"",
      })],
    });
  });

  it("enforces the hard instruction and skill context ceiling in validation and schema", async () => {
    const project = await fixture({ kind: "runtime", controller: runtimeController(async () => ({})) });
    const runtime = project.modules[0]!.name;
    await project.writeConfig(minimalConfig(runtime, {
      context: { skills: { roots: ["./skills"], maxBytes: 1_000_001 } },
    }));

    await expect(validateAgentConfig(project.configPath)).resolves.toMatchObject({
      ok: false,
      issues: [expect.objectContaining({
        path: "context.skills.maxBytes",
        code: "range",
      })],
    });

    await project.writeConfig(minimalConfig(runtime, {
      context: { skills: { roots: ["./skills"], maxBytes: 1_000_000 } },
    }));
    const schema = await composeAgentConfigSchema(await loadAgentConfig(project.configPath));
    expect(nested(schema, [
      "properties",
      "context",
      "properties",
      "skills",
      "properties",
      "maxBytes",
    ])).toMatchObject({ minimum: 1, maximum: 1_000_000 });
  });

  it("loads an external open-slot module without any first-party catalog entry", async () => {
    let parsed = false;
    const project = await fixture({
      kind: "runtime",
      schema: {
        type: "object",
        properties: { custom: { type: "string" } },
        required: ["custom"],
        additionalProperties: false,
      },
      controller: {
        parse(input) {
          parsed = true;
          return input;
        },
        create: () => ({}),
      },
    });
    const runtime = project.modules[0]!.name;
    const config = minimalConfig(runtime);
    setMainRuntime(config, { $use: runtime, custom: "works" });
    await project.writeConfig(config);
    const loaded = await loadAgentConfig(project.configPath);
    expect(parsed).toBe(true);
    expect(loaded.modules[0]?.packageName).toBe(runtime);
  });

  it("validates annotated cross-slot instance and capability references after loading all modules", async () => {
    const suffix = randomUUID().toLowerCase();
    const runtimeName = `@fixture/runtime-${suffix}`;
    const channelName = `@fixture/channel-${suffix}`;
    const project = await createFixtureProject([
      {
        name: runtimeName,
        kind: "runtime",
        capabilities: ["runtime.fixture-target"],
        controller: { create: () => ({}) },
      },
      {
        name: channelName,
        kind: "channel",
        schema: {
          type: "object",
          properties: {
            runtime: {
              type: "string",
              "x-mono-agent-slot-reference": { slot: "runtime", capability: "runtime.fixture-target" },
            },
          },
          required: ["runtime"],
          additionalProperties: false,
        },
        controller: { create: () => ({}) },
      },
    ]);
    projects.push(project);
    const config = minimalConfig(runtimeName, {
      channels: { gateway: { $use: channelName, runtime: "main" } },
    });
    await project.writeConfig(config);
    await expect(loadAgentConfig(project.configPath)).resolves.toMatchObject({ modules: expect.any(Array) });

    (config.channels!.gateway as unknown as { runtime: string }).runtime = "missing";
    await project.writeConfig(config);
    const missing = await validateAgentConfig(project.configPath);
    expect(missing.issues).toContainEqual(expect.objectContaining({
      path: "channels.gateway.runtime",
      code: "module_reference",
    }));

    const noCapability = await createFixtureProject([
      { name: `${runtimeName}-plain`, kind: "runtime", controller: { create: () => ({}) } },
      {
        name: `${channelName}-capability`,
        kind: "channel",
        schema: {
          type: "object",
          properties: {
            runtime: {
              type: "string",
              "x-mono-agent-slot-reference": { slot: "runtime", capability: "runtime.fixture-target" },
            },
          },
          required: ["runtime"],
          additionalProperties: false,
        },
        controller: { create: () => ({}) },
      },
    ]);
    projects.push(noCapability);
    await noCapability.writeConfig(minimalConfig(`${runtimeName}-plain`, {
      channels: { gateway: { $use: `${channelName}-capability`, runtime: "main" } },
    }));
    const unsupported = await validateAgentConfig(noCapability.configPath);
    expect(unsupported.issues).toContainEqual(expect.objectContaining({
      path: "channels.gateway.runtime",
      code: "module_capability",
    }));
  });

  it("resolves only marked env leaves before module parse and never surfaces the value", async () => {
    const seen: unknown[] = [];
    const project = await fixture({
      kind: "runtime",
      schema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            "x-mono-agent-env-eligible": true,
            "x-mono-agent-secret": true,
          },
        },
        required: ["apiKey"],
        additionalProperties: false,
      },
      controller: {
        parse(input) {
          seen.push(input);
          if (!isRecord(input) || typeof input.apiKey !== "string") throw new Error("apiKey was not resolved");
          return input;
        },
        create: () => ({}),
      },
    });
    const runtime = project.modules[0]!.name;
    const config = minimalConfig(runtime);
    setMainRuntime(config, { $use: runtime, apiKey: { $env: "FIXTURE_API_KEY" } });
    await project.writeConfig(config);
    const secret = "fixture-super-secret-value";
    const loaded = await loadAgentConfig(project.configPath, { environment: { FIXTURE_API_KEY: secret } });
    expect(seen).toEqual([{ apiKey: secret }]);
    expect(JSON.stringify(loaded)).not.toContain(secret);

    const explanation = await explainAgentConfig(loaded);
    expect(explanation.entries).toContainEqual(expect.objectContaining({
      path: "runtimes.main.apiKey",
      owner: runtime,
      source: "environment",
      env: "FIXTURE_API_KEY",
      redacted: true,
    }));
    expect(JSON.stringify(explanation)).not.toContain(secret);

    const schema = await composeAgentConfigSchema(loaded);
    const apiKey = nested(schema, ["properties", "runtimes", "properties", "main", "properties", "apiKey"]);
    expect(apiKey).toMatchObject({
      type: "object",
      required: ["$env"],
      additionalProperties: false,
    });
  });

  it("explains schema-owned effective defaults and parsed module provenance without environment values", async () => {
    let created = 0;
    const apiSecret = "api-secret-must-not-escape";
    const endpointSecret = "endpoint-value-must-not-escape";
    const project = await fixture({
      kind: "runtime",
      schema: {
        type: "object",
        properties: {
          mode: { type: "string" },
          retries: { type: "integer", default: 3 },
          endpoints: { type: "array", items: { type: "string" }, default: [] },
          apiKey: {
            type: "string",
            "x-mono-agent-env-eligible": true,
            "x-mono-agent-secret": true,
          },
          endpoint: {
            type: "string",
            "x-mono-agent-env-eligible": true,
          },
          endpointEcho: { type: "string" },
          apiDigest: { type: "string" },
        },
        required: ["mode", "apiKey", "endpoint"],
        additionalProperties: false,
      },
      controller: {
        parse(input) {
          if (!isRecord(input)) throw new TypeError("runtime config must be an object");
          return {
            mode: input.mode,
            apiKey: input.apiKey,
            endpoint: input.endpoint,
            endpointEcho: `echo:${String(input.endpoint)}`,
            apiDigest: Buffer.from(String(input.apiKey)).toString("base64"),
            retries: 3,
            endpoints: [],
          };
        },
        create() {
          created += 1;
          return {};
        },
      },
    });
    const runtime = project.modules[0]!.name;
    const config = minimalConfig(runtime, {
      context: { skills: { roots: ["./skills"] } },
    });
    setMainRuntime(config, {
      $use: runtime,
      mode: "fast",
      apiKey: { $env: "FIXTURE_API_KEY" },
      endpoint: { $env: "FIXTURE_ENDPOINT" },
    });
    await project.writeConfig(config);

    const loaded = await loadAgentConfig(project.configPath, {
      environment: {
        FIXTURE_API_KEY: apiSecret,
        FIXTURE_ENDPOINT: endpointSecret,
      },
    });
    const explanation = await explainAgentConfig(loaded);
    const byPath = new Map(explanation.entries.map((entry) => [entry.path, entry]));

    expect(created).toBe(0);
    expect(explanation.entries.map((entry) => entry.path)).toEqual(
      [...explanation.entries.map((entry) => entry.path)].sort(),
    );
    expect(byPath.get("policy.approvals.timeoutMs")).toEqual({
      path: "policy.approvals.timeoutMs",
      owner: "@mono-agent/core",
      schemaPointer: "#/properties/policy/properties/approvals/properties/timeoutMs",
      source: "default",
      value: 60_000,
      redacted: false,
      remediation: "Set policy.approvals.timeoutMs in the config to override this default, then validate again.",
    });
    expect(byPath.get("session.mode")).toMatchObject({
      owner: "@mono-agent/core",
      schemaPointer: "#/properties/session/properties/mode",
      source: "default",
      value: "continuous",
      redacted: false,
    });
    expect(byPath.get("context.skills.disclosure")).toMatchObject({
      owner: "@mono-agent/core",
      source: "default",
      value: "index",
      redacted: false,
    });
    expect(byPath.get("runtimes.main.mode")).toMatchObject({
      owner: runtime,
      schemaPointer: "#/properties/runtimes/properties/main/properties/mode",
      source: "config",
      value: "fast",
      redacted: false,
    });
    expect(byPath.get("runtimes.main.retries")).toMatchObject({
      owner: runtime,
      schemaPointer: "#/properties/runtimes/properties/main/properties/retries",
      source: "default",
      value: 3,
      redacted: false,
    });
    expect(byPath.get("runtimes.main.apiKey")).toEqual({
      path: "runtimes.main.apiKey",
      owner: runtime,
      schemaPointer: "#/properties/runtimes/properties/main/properties/apiKey",
      source: "environment",
      env: "FIXTURE_API_KEY",
      redacted: true,
      remediation: "Set FIXTURE_API_KEY in the process environment, then validate again.",
    });
    expect(byPath.get("runtimes.main.endpoint")).toMatchObject({
      source: "environment",
      env: "FIXTURE_ENDPOINT",
      redacted: true,
    });
    expect(byPath.get("runtimes.main.endpointEcho")).toMatchObject({
      source: "environment",
      env: "FIXTURE_ENDPOINT",
      redacted: true,
    });
    expect(byPath.get("runtimes.main.apiDigest")).toMatchObject({
      source: "environment",
      redacted: true,
    });
    expect(explanation.entries.every((entry) =>
      entry.schemaPointer.startsWith("#")
      && entry.remediation.length <= 240
      && ["config", "environment", "default"].includes(entry.source))).toBe(true);
    expect(JSON.stringify(explanation)).not.toContain(apiSecret);
    expect(JSON.stringify(explanation)).not.toContain(endpointSecret);
    expect(JSON.stringify(explanation)).not.toContain(Buffer.from(apiSecret).toString("base64"));

    const endpoints = byPath.get("runtimes.main.endpoints")?.value;
    expect(endpoints).toEqual([]);
    (endpoints as unknown[]).push("mutated");
    const repeated = await explainAgentConfig(loaded);
    expect(repeated.entries.find((entry) => entry.path === "runtimes.main.endpoints")?.value).toEqual([]);
  });

  it("redacts resolved environment values echoed by a module parser", async () => {
    const secret = "parser-echo-secret-value";
    const project = await fixture({
      kind: "runtime",
      schema: {
        type: "object",
        properties: {
          apiKey: {
            type: "string",
            "x-mono-agent-env-eligible": true,
            "x-mono-agent-secret": true,
          },
        },
        required: ["apiKey"],
        additionalProperties: false,
      },
      controller: {
        parse(input) {
          const value = isRecord(input) ? input.apiKey : undefined;
          throw new Error(`module rejected ${String(value)}`);
        },
        create: () => ({}),
      },
    });
    const runtime = project.modules[0]!.name;
    const config = minimalConfig(runtime);
    setMainRuntime(config, { $use: runtime, apiKey: { $env: "FIXTURE_API_KEY" } });
    await project.writeConfig(config);

    const result = await validateAgentConfig(project.configPath, {
      environment: { FIXTURE_API_KEY: secret },
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.issues[0]?.message).toContain("[REDACTED]");
  });

  it("resolves and materializes env-backed secret values in schema maps", async () => {
    const seen: unknown[] = [];
    const project = await fixture({
      kind: "runtime",
      schema: {
        type: "object",
        properties: {
          headers: {
            type: "object",
            additionalProperties: {
              type: "string",
              "x-mono-agent-env-eligible": true,
              "x-mono-agent-secret": true,
            },
          },
        },
        additionalProperties: false,
      },
      controller: {
        parse(input) {
          seen.push(input);
          return input;
        },
        create: () => ({}),
      },
    });
    const runtime = project.modules[0]!.name;
    const config = minimalConfig(runtime);
    setMainRuntime(config, {
      $use: runtime,
      headers: { authorization: { $env: "OTLP_AUTHORIZATION" } },
    });
    await project.writeConfig(config);

    const loaded = await loadAgentConfig(project.configPath, {
      environment: { OTLP_AUTHORIZATION: "Bearer fixture-token" },
    });
    expect(seen).toEqual([{ headers: { authorization: "Bearer fixture-token" } }]);

    const schema = await composeAgentConfigSchema(loaded);
    const headerValue = nested(schema, [
      "properties",
      "runtimes",
      "properties",
      "main",
      "properties",
      "headers",
      "additionalProperties",
    ]);
    expect(headerValue).toMatchObject({
      type: "object",
      required: ["$env"],
      additionalProperties: false,
    });
  });

  it("rejects inline secrets, missing env names, and env directives on unmarked leaves", async () => {
    const project = await fixture({
      kind: "runtime",
      schema: {
        type: "object",
        properties: {
          apiKey: { type: "string", "x-mono-agent-env-eligible": true, "x-mono-agent-secret": true },
          label: { type: "string" },
        },
        additionalProperties: false,
      },
      controller: { create: () => ({}) },
    });
    const runtime = project.modules[0]!.name;
    const inline = minimalConfig(runtime);
    setMainRuntime(inline, { $use: runtime, apiKey: "do-not-leak-this" });
    await project.writeConfig(inline);
    const inlineResult = await validateAgentConfig(project.configPath);
    expect(inlineResult.issues[0]?.code).toBe("inline_secret");
    expect(JSON.stringify(inlineResult)).not.toContain("do-not-leak-this");

    const missing = minimalConfig(runtime);
    setMainRuntime(missing, { $use: runtime, apiKey: { $env: "ABSENT_KEY" } });
    await project.writeConfig(missing);
    const missingResult = await validateAgentConfig(project.configPath, { environment: {} });
    expect(missingResult.issues[0]?.code).toBe("missing_environment");

    const unmarked = minimalConfig(runtime);
    setMainRuntime(unmarked, { $use: runtime, label: { $env: "LABEL" } });
    await project.writeConfig(unmarked);
    const unmarkedResult = await validateAgentConfig(project.configPath, { environment: { LABEL: "value" } });
    expect(unmarkedResult.issues[0]?.code).toBe("env_not_eligible");
  });

  it("selects discriminated schema branches before resolving or publishing env directives", async () => {
    const tokenSchema = {
      type: "string",
      "x-mono-agent-env-eligible": true,
      "x-mono-agent-secret": true,
    };
    const project = await fixture({
      kind: "runtime",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          auth: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["method", "token"],
                properties: { method: { const: "oauth" }, token: tokenSchema },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["method", "token"],
                properties: { method: { const: "literal-label" }, token: { type: "string" } },
              },
            ],
          },
        },
      },
      controller: { create: () => ({}) },
    });
    const runtime = project.modules[0]!.name;
    const valid = minimalConfig(runtime);
    setMainRuntime(valid, {
      $use: runtime,
      auth: { method: "oauth", token: { $env: "OAUTH_TOKEN" } },
    });
    await project.writeConfig(valid);
    const loaded = await loadAgentConfig(project.configPath, { environment: { OAUTH_TOKEN: "secret" } });
    const schema = await composeAgentConfigSchema(loaded);
    const authBranches = nested(schema, [
      "properties", "runtimes", "properties", "main", "properties", "auth", "oneOf",
    ]);
    expect(Array.isArray(authBranches) ? nested(authBranches[0], ["properties", "token"]) : undefined)
      .toMatchObject({ type: "object", required: ["$env"], additionalProperties: false });

    const wrongBranch = minimalConfig(runtime);
    setMainRuntime(wrongBranch, {
      $use: runtime,
      auth: { method: "literal-label", token: { $env: "OAUTH_TOKEN" } },
    });
    await project.writeConfig(wrongBranch);
    expect((await validateAgentConfig(project.configPath, { environment: { OAUTH_TOKEN: "secret" } })).issues[0]?.code)
      .toBe("env_not_eligible");

    const inline = minimalConfig(runtime);
    setMainRuntime(inline, { $use: runtime, auth: { method: "oauth", token: "do-not-publish" } });
    await project.writeConfig(inline);
    expect((await validateAgentConfig(project.configPath)).issues[0]?.code).toBe("inline_secret");
  });

  it("explains the applicable oneOf and anyOf branches for overlapping effective values", async () => {
    const tokenSchema = {
      type: "string",
      "x-mono-agent-env-eligible": true,
      "x-mono-agent-secret": true,
    };
    const authBranch = (method: "oauth-token" | "api-key", audience: string) => ({
      type: "object",
      additionalProperties: false,
      required: ["method", "token"],
      properties: {
        method: { const: method },
        token: tokenSchema,
        audience: {
          type: "string",
          default: audience,
          ...(method === "api-key" ? { "x-mono-agent-secret": true } : {}),
        },
      },
    });
    const profileBranch = (method: "oauth-token" | "api-key", hint: string) => ({
      type: "object",
      additionalProperties: false,
      required: ["method", "label"],
      properties: {
        method: { const: method },
        label: { type: "string" },
        hint: { type: "string", default: hint },
      },
    });
    const sharedBranch = (secret: boolean) => ({
      type: "object",
      additionalProperties: false,
      properties: {
        value: {
          type: "string",
          default: "raw-must-not-escape",
          ...(secret ? { "x-mono-agent-secret": true } : {}),
        },
      },
    });
    const project = await fixture({
      kind: "runtime",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["auth", "profile", "shared"],
        properties: {
          auth: {
            oneOf: [
              authBranch("oauth-token", "oauth-audience"),
              authBranch("api-key", "api-audience"),
            ],
          },
          profile: {
            anyOf: [
              profileBranch("oauth-token", "oauth-hint"),
              profileBranch("api-key", "api-hint"),
            ],
          },
          shared: { anyOf: [sharedBranch(false), sharedBranch(true)] },
        },
      },
      controller: {
        parse(input) {
          if (!isRecord(input) || !isRecord(input.auth)
            || !isRecord(input.profile) || !isRecord(input.shared)) {
            throw new TypeError("runtime config must contain auth, profile, and shared objects");
          }
          const method = input.auth.method;
          return {
            ...input,
            auth: {
              ...input.auth,
              audience: method === "api-key" ? "api-audience" : "oauth-audience",
            },
            profile: {
              ...input.profile,
              hint: input.profile.method === "api-key" ? "api-hint" : "oauth-hint",
            },
            shared: { ...input.shared, value: "raw-must-not-escape" },
          };
        },
        create: () => ({}),
      },
    });
    const runtime = project.modules[0]!.name;
    const config = minimalConfig(runtime);
    setMainRuntime(config, {
      $use: runtime,
      auth: { method: "api-key", token: { $env: "CLAUDE_API_KEY" } },
      profile: { method: "api-key", label: "production" },
      shared: {},
    });
    await project.writeConfig(config);

    const loaded = await loadAgentConfig(project.configPath, {
      environment: { CLAUDE_API_KEY: "claude-api-secret" },
    });
    const explanation = await explainAgentConfig(loaded);
    const byPath = new Map(
      explanation.entries.map((entry) => [entry.path, entry]),
    );
    expect(JSON.stringify(explanation)).not.toContain("claude-api-secret");

    expect(byPath.get("runtimes.main.auth.method")).toMatchObject({
      schemaPointer: "#/properties/runtimes/properties/main/properties/auth/oneOf/1/properties/method",
      source: "config",
      value: "api-key",
    });
    expect(byPath.get("runtimes.main.auth.token")).toMatchObject({
      schemaPointer: "#/properties/runtimes/properties/main/properties/auth/oneOf/1/properties/token",
      source: "environment",
      env: "CLAUDE_API_KEY",
      redacted: true,
    });
    expect(byPath.get("runtimes.main.auth.audience")).toMatchObject({
      schemaPointer: "#/properties/runtimes/properties/main/properties/auth/oneOf/1/properties/audience",
      source: "default",
      redacted: true,
    });
    expect(byPath.get("runtimes.main.auth.audience")?.value).toBeUndefined();
    expect(byPath.get("runtimes.main.profile.hint")).toMatchObject({
      schemaPointer: "#/properties/runtimes/properties/main/properties/profile/anyOf/1/properties/hint",
      source: "default",
      value: "api-hint",
      redacted: false,
    });
    expect(byPath.get("runtimes.main.shared.value")).toMatchObject({
      schemaPointer: "#/properties/runtimes/properties/main/properties/shared/anyOf/0/properties/value",
      source: "default",
      redacted: true,
    });
    expect(byPath.get("runtimes.main.shared.value")?.value).toBeUndefined();
    expect(JSON.stringify(explanation)).not.toContain("raw-must-not-escape");

    const oauthConfig = minimalConfig(runtime);
    setMainRuntime(oauthConfig, {
      $use: runtime,
      auth: { method: "oauth-token", token: { $env: "CLAUDE_OAUTH_TOKEN" } },
      profile: { method: "oauth-token", label: "interactive" },
      shared: {},
    });
    await project.writeConfig(oauthConfig);
    const oauthByPath = new Map(
      (await explainAgentConfig(await loadAgentConfig(project.configPath, {
        environment: { CLAUDE_OAUTH_TOKEN: "also-must-not-escape" },
      }))).entries.map((entry) => [entry.path, entry]),
    );
    expect(oauthByPath.get("runtimes.main.auth.method")).toMatchObject({
      schemaPointer: "#/properties/runtimes/properties/main/properties/auth/oneOf/0/properties/method",
      value: "oauth-token",
    });
    expect(oauthByPath.get("runtimes.main.auth.audience")).toMatchObject({
      schemaPointer: "#/properties/runtimes/properties/main/properties/auth/oneOf/0/properties/audience",
      source: "default",
      value: "oauth-audience",
      redacted: false,
    });
    expect(oauthByPath.get("runtimes.main.profile.hint")).toMatchObject({
      schemaPointer: "#/properties/runtimes/properties/main/properties/profile/anyOf/0/properties/hint",
      source: "default",
      value: "oauth-hint",
      redacted: false,
    });
  });

  it("matches primitive oneOf and anyOf branches before applying env and secret annotations", async () => {
    const protectedString = {
      type: "string",
      "x-mono-agent-env-eligible": true,
      "x-mono-agent-secret": true,
    };
    const protectedNumber = {
      type: "number",
      "x-mono-agent-env-eligible": true,
      "x-mono-agent-secret": true,
    };
    const seen: unknown[] = [];
    const project = await fixture({
      kind: "runtime",
      schema: {
        type: "object",
        properties: {
          token: { oneOf: [{ type: "number" }, protectedString] },
          label: { anyOf: [{ type: "string" }, protectedNumber] },
        },
        required: ["token", "label"],
        additionalProperties: false,
      },
      controller: {
        parse(input) {
          seen.push(input);
          return input;
        },
        create: () => ({}),
      },
    });
    const runtime = project.modules[0]!.name;
    const valid = minimalConfig(runtime);
    setMainRuntime(valid, {
      $use: runtime,
      token: { $env: "TOKEN" },
      label: "public-label",
    });
    await project.writeConfig(valid);
    await loadAgentConfig(project.configPath, { environment: { TOKEN: "resolved-token" } });
    expect(seen).toEqual([{ token: "resolved-token", label: "public-label" }]);

    const inline = minimalConfig(runtime);
    setMainRuntime(inline, { $use: runtime, token: "inline-token", label: "public-label" });
    await project.writeConfig(inline);
    expect((await validateAgentConfig(project.configPath)).issues[0]?.code).toBe("inline_secret");

    const wrongAnyOfBranch = minimalConfig(runtime);
    setMainRuntime(wrongAnyOfBranch, {
      $use: runtime,
      token: { $env: "TOKEN" },
      label: { $env: "LABEL" },
    });
    await project.writeConfig(wrongAnyOfBranch);
    const result = await validateAgentConfig(project.configPath, {
      environment: { TOKEN: "resolved-token", LABEL: "public-label" },
    });
    expect(result.issues[0]?.code).toBe("env_not_eligible");
  });

  it("uses pattern constraints to enforce and explain the selected secret branch", async () => {
    const rawDefault = "pattern-default-must-not-escape";
    const protectedToken = {
      type: "string", default: rawDefault,
      "x-mono-agent-env-eligible": true, "x-mono-agent-secret": true,
    };
    const project = await fixture({
      kind: "runtime",
      schema: {
        type: "object", additionalProperties: false, required: ["auth"],
        properties: {
          auth: {
            oneOf: [
              {
                type: "object", additionalProperties: false, required: ["mode"],
                properties: {
                  mode: { type: "string", pattern: "^public$", "x-mono-agent-env-eligible": true },
                  token: { type: "string" },
                },
              },
              {
                type: "object", additionalProperties: false, required: ["mode"],
                properties: {
                  mode: { type: "string", pattern: "^secret$", "x-mono-agent-env-eligible": true },
                  token: protectedToken,
                },
              },
            ],
          },
        },
      },
      controller: {
        parse(input) {
          if (!isRecord(input) || !isRecord(input.auth)) throw new TypeError("auth required");
          return { ...input, auth: { ...input.auth, token: input.auth.token ?? rawDefault } };
        },
        create: () => ({}),
      },
    });
    const runtime = project.modules[0]!.name;
    const inline = minimalConfig(runtime);
    setMainRuntime(inline, { $use: runtime, auth: { mode: "secret", token: "inline-secret" } });
    await project.writeConfig(inline);
    expect((await validateAgentConfig(project.configPath)).issues[0]?.code).toBe("inline_secret");

    const unresolvedBranch = minimalConfig(runtime);
    setMainRuntime(unresolvedBranch, {
      $use: runtime, auth: { mode: { $env: "PATTERN_MODE" }, token: "inline-secret" },
    });
    await project.writeConfig(unresolvedBranch);
    expect((await validateAgentConfig(project.configPath, {
      environment: { PATTERN_MODE: "secret" },
    })).issues[0]?.code).toBe("inline_secret");

    const env = minimalConfig(runtime);
    setMainRuntime(env, { $use: runtime, auth: { mode: "secret", token: { $env: "PATTERN_TOKEN" } } });
    await project.writeConfig(env);
    const loaded = await loadAgentConfig(project.configPath, { environment: { PATTERN_TOKEN: "resolved-secret" } });
    const envEntry = (await explainAgentConfig(loaded)).entries
      .find((entry) => entry.path === "runtimes.main.auth.token");
    expect(envEntry).toMatchObject({
      schemaPointer: "#/properties/runtimes/properties/main/properties/auth/oneOf/1/properties/token",
      source: "environment", env: "PATTERN_TOKEN", redacted: true,
    });

    const defaults = minimalConfig(runtime);
    setMainRuntime(defaults, { $use: runtime, auth: { mode: "secret" } });
    await project.writeConfig(defaults);
    const explanation = await explainAgentConfig(await loadAgentConfig(project.configPath));
    const defaultEntry = explanation.entries.find((entry) => entry.path === "runtimes.main.auth.token");
    expect(defaultEntry).toMatchObject({
      schemaPointer: "#/properties/runtimes/properties/main/properties/auth/oneOf/1/properties/token",
      source: "default", redacted: true,
    });
    expect(JSON.stringify(explanation)).not.toContain(rawDefault);
  });

  it("uses structural JSON Schema const and enum equality for secret branches", async () => {
    const selector = { kind: "secret" };
    const scope = { level: "admin" };
    const protectedToken = {
      type: "string", "x-mono-agent-env-eligible": true, "x-mono-agent-secret": true,
    };
    const project = await fixture({
      kind: "runtime",
      schema: {
        type: "object", additionalProperties: false, required: ["auth"],
        properties: {
          auth: {
            oneOf: [
              {
                type: "object", additionalProperties: false, required: ["selector", "scope", "token"],
                properties: {
                  selector: { not: { const: selector } },
                  scope: { type: "object" },
                  token: { type: "string" },
                },
              },
              {
                type: "object", additionalProperties: false, required: ["selector", "scope", "token"],
                properties: {
                  selector: { const: selector },
                  scope: { enum: [scope] },
                  token: protectedToken,
                },
              },
            ],
          },
        },
      },
      controller: { parse: (input) => input, create: () => ({}) },
    });
    const runtime = project.modules[0]!.name;
    const inline = minimalConfig(runtime);
    setMainRuntime(inline, {
      $use: runtime, auth: { selector, scope, token: "structural-inline-secret" },
    });
    await project.writeConfig(inline);
    expect((await validateAgentConfig(project.configPath)).issues[0]?.code).toBe("inline_secret");

    const env = minimalConfig(runtime);
    setMainRuntime(env, {
      $use: runtime, auth: { selector, scope, token: { $env: "STRUCTURAL_TOKEN" } },
    });
    await project.writeConfig(env);
    const loaded = await loadAgentConfig(project.configPath, {
      environment: { STRUCTURAL_TOKEN: "structural-resolved-secret" },
    });
    const explanation = await explainAgentConfig(loaded);
    expect(explanation.entries.find((entry) => entry.path === "runtimes.main.auth.token"))
      .toMatchObject({
        schemaPointer: "#/properties/runtimes/properties/main/properties/auth/oneOf/1/properties/token",
        source: "environment", env: "STRUCTURAL_TOKEN", redacted: true,
      });
    expect(JSON.stringify(explanation)).not.toContain("structural-resolved-secret");
  });

  it("fails secure when an unknown keyword leaves a oneOf branch unresolved", async () => {
    const rawDefault = "unknown-default-must-not-escape";
    const branch = (secret: boolean) => ({
      type: "object", additionalProperties: false, required: ["mode"],
      ...(secret ? { futureValidationKeyword: true } : {}),
      properties: {
        mode: { const: "future" },
        token: {
          type: "string", default: secret ? rawDefault : "public-default",
          ...(secret ? { "x-mono-agent-env-eligible": true, "x-mono-agent-secret": true } : {}),
        },
      },
    });
    const project = await fixture({
      kind: "runtime",
      schema: {
        type: "object", additionalProperties: false, required: ["auth"],
        properties: { auth: { oneOf: [branch(false), branch(true)] } },
      },
      controller: {
        parse(input) {
          if (!isRecord(input) || !isRecord(input.auth)) throw new TypeError("auth required");
          return { ...input, auth: { ...input.auth, token: input.auth.token ?? rawDefault } };
        },
        create: () => ({}),
      },
    });
    const runtime = project.modules[0]!.name;
    const inline = minimalConfig(runtime);
    setMainRuntime(inline, { $use: runtime, auth: { mode: "future", token: "inline-secret" } });
    await project.writeConfig(inline);
    expect((await validateAgentConfig(project.configPath)).issues[0]?.code).toBe("inline_secret");

    const env = minimalConfig(runtime);
    setMainRuntime(env, { $use: runtime, auth: { mode: "future", token: { $env: "FUTURE_TOKEN" } } });
    await project.writeConfig(env);
    expect((await validateAgentConfig(project.configPath, {
      environment: { FUTURE_TOKEN: "resolved-secret" },
    })).issues[0]?.code).toBe("env_not_eligible");

    const defaults = minimalConfig(runtime);
    setMainRuntime(defaults, { $use: runtime, auth: { mode: "future" } });
    await project.writeConfig(defaults);
    const explanation = await explainAgentConfig(await loadAgentConfig(project.configPath));
    const entry = explanation.entries.find((item) => item.path === "runtimes.main.auth.token");
    expect(entry).toMatchObject({ source: "default", redacted: true });
    expect(entry?.schemaPointer).not.toContain("/oneOf/");
    expect(JSON.stringify(explanation)).not.toContain(rawDefault);
  });

  it("enforces security annotations selected by boolean conditional schemas", async () => {
    const protectedPayload = {
      type: "string", "x-mono-agent-env-eligible": true, "x-mono-agent-secret": true,
    };
    const project = await fixture({
      kind: "runtime",
      schema: {
        type: "object", additionalProperties: false, required: ["payload"],
        properties: { payload: { type: "string" } },
        if: true,
        then: { properties: { payload: protectedPayload } },
      },
      controller: { parse: (input) => input, create: () => ({}) },
    });
    const runtime = project.modules[0]!.name;
    const inline = minimalConfig(runtime);
    setMainRuntime(inline, { $use: runtime, payload: "conditional-inline-secret" });
    await project.writeConfig(inline);
    expect((await validateAgentConfig(project.configPath)).issues[0]?.code).toBe("inline_secret");

    const env = minimalConfig(runtime);
    setMainRuntime(env, { $use: runtime, payload: { $env: "CONDITIONAL_SECRET" } });
    await project.writeConfig(env);
    const loaded = await loadAgentConfig(project.configPath, {
      environment: { CONDITIONAL_SECRET: "conditional-resolved-secret" },
    });
    const explanation = await explainAgentConfig(loaded);
    expect(explanation.entries.find((entry) => entry.path === "runtimes.main.payload"))
      .toMatchObject({ source: "environment", env: "CONDITIONAL_SECRET", redacted: true });
    expect(JSON.stringify(explanation)).not.toContain("conditional-resolved-secret");
  });

  it("rejects unresolved references and hidden security annotations under unsupported applicators", async () => {
    const protectedLeaf = {
      type: "string", "x-mono-agent-env-eligible": true, "x-mono-agent-secret": true,
    };
    for (const schema of [
      {
        type: "object",
        $defs: { protectedLeaf },
        properties: { payload: { $ref: "#/$defs/protectedLeaf" } },
      },
      {
        type: "object",
        dependentSchemas: { mode: { properties: { payload: protectedLeaf } } },
      },
    ]) {
      const project = await fixture({
        kind: "runtime", schema,
        controller: { parse: (input) => input, create: () => ({}) },
      });
      const config = minimalConfig(project.modules[0]!.name);
      setMainRuntime(config, {
        $use: project.modules[0]!.name, mode: "secret", payload: "must-not-load",
      });
      await project.writeConfig(config);
      await expect(loadAgentConfig(project.configPath)).rejects.toBeInstanceOf(AgentConfigError);
    }
  });

  it("composes strict root oneOf and allOf schemas with a required module selector", async () => {
    const suffix = randomUUID().toLowerCase();
    const variantName = `@fixture/runtime-variant-${suffix}`;
    const layeredName = `@fixture/runtime-layered-${suffix}`;
    const project = await createFixtureProject([
      {
        name: variantName,
        kind: "runtime",
        schema: {
          type: "object",
          oneOf: [
            {
              type: "object",
              properties: { mode: { const: "remote" }, endpoint: { type: "string" } },
              required: ["mode", "endpoint"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { mode: { const: "local" } },
              required: ["mode"],
              additionalProperties: false,
            },
          ],
          additionalProperties: false,
        },
        controller: { create: () => ({}) },
      },
      {
        name: layeredName,
        kind: "runtime",
        schema: {
          type: "object",
          allOf: [
            {
              type: "object",
              properties: { endpoint: { type: "string" } },
              required: ["endpoint"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { timeoutMs: { type: "integer" } },
              required: ["timeoutMs"],
              additionalProperties: false,
            },
          ],
          additionalProperties: false,
        },
        controller: { create: () => ({}) },
      },
    ]);
    projects.push(project);
    const config = minimalConfig(variantName);
    setMainRuntime(config, { $use: variantName, mode: "local" });
    (config.runtimes as Record<string, unknown>).layered = {
      $use: layeredName,
      endpoint: "https://example.test",
      timeoutMs: 1_000,
    };
    await project.writeConfig(config);

    const schema = await composeAgentConfigSchema(await loadAgentConfig(project.configPath));
    const variant = nested(schema, ["properties", "runtimes", "properties", "main"]);
    expect(variant).toMatchObject({
      type: "object",
      properties: { $use: { const: variantName } },
      required: expect.arrayContaining(["$use"]),
      unevaluatedProperties: false,
    });
    expect(isRecord(variant) && Object.hasOwn(variant, "additionalProperties")).toBe(false);
    const variants = isRecord(variant) && Array.isArray(variant.oneOf) ? variant.oneOf : [];
    expect(variants).toHaveLength(2);
    for (const branch of variants) {
      expect(branch).toMatchObject({
        properties: { $use: { const: variantName } },
        required: expect.arrayContaining(["$use"]),
        additionalProperties: false,
      });
    }

    const layered = nested(schema, ["properties", "runtimes", "properties", "layered"]);
    expect(layered).toMatchObject({
      type: "object",
      properties: { $use: { const: layeredName } },
      required: expect.arrayContaining(["$use"]),
      unevaluatedProperties: false,
    });
    expect(isRecord(layered) && Object.hasOwn(layered, "additionalProperties")).toBe(false);
    const layers = isRecord(layered) && Array.isArray(layered.allOf) ? layered.allOf : [];
    expect(layers).toHaveLength(2);
    for (const branch of layers) {
      expect(branch).toMatchObject({
        properties: { $use: { const: layeredName } },
        required: expect.arrayContaining(["$use"]),
      });
      expect(isRecord(branch) && Object.hasOwn(branch, "additionalProperties")).toBe(false);
    }
  });
});

describe("dependency and package preflight", () => {
  it("loads an ESM package whose root export is import-only", async () => {
    const project = await fixture({
      kind: "runtime",
      importOnly: true,
      controller: { create: () => ({}) },
    });
    await project.writeConfig(minimalConfig(project.modules[0]!.name));
    await expect(loadAgentConfig(project.configPath)).resolves.toMatchObject({
      modules: [{ packageName: project.modules[0]!.name }],
    });
  });

  it("rejects dev-only dependencies", async () => {
    const project = await fixture({ kind: "runtime", dependencyField: "devDependencies", controller: { create: () => ({}) } });
    await project.writeConfig(minimalConfig(project.modules[0]!.name));
    await expectConfigIssue(loadAgentConfig(project.configPath), /direct project dependency/u);
  });

  it("rejects an ancestor-only node_modules package despite matching manifest and lock claims", async () => {
    const project = await fixture({ kind: "runtime", controller: { create: () => ({}) } });
    await project.writeConfig(minimalConfig(project.modules[0]!.name));
    const consumerRoot = join(project.root, "consumer");
    await mkdir(consumerRoot);
    for (const name of ["package.json", "package-lock.json", "AGENTS.md", "mono-agent.config.json"]) {
      await rename(join(project.root, name), join(consumerRoot, name));
    }

    await expectConfigIssue(
      loadAgentConfig(join(consumerRoot, "mono-agent.config.json")),
      /must be installed at .*ancestor node_modules are not eligible/u,
    );
  });

  it("rejects missing and version-mismatched lock entries", async () => {
    const missing = await fixture({ kind: "runtime", omitFromLock: true, controller: { create: () => ({}) } });
    await missing.writeConfig(minimalConfig(missing.modules[0]!.name));
    await expectConfigIssue(loadAgentConfig(missing.configPath), /lockfile/u);

    const mismatch = await fixture({ kind: "runtime", lockVersion: "9.9.9", controller: { create: () => ({}) } });
    await mismatch.writeConfig(minimalConfig(mismatch.modules[0]!.name));
    await expectConfigIssue(loadAgentConfig(mismatch.configPath), /mismatched/u);
  });

  it("rejects aliases, local paths, wrong API versions, and wrong kinds", async () => {
    const alias = await fixture({ kind: "runtime", dependencySpec: "npm:other@1.0.0", controller: { create: () => ({}) } });
    await alias.writeConfig(minimalConfig(alias.modules[0]!.name));
    await expectConfigIssue(loadAgentConfig(alias.configPath), /forbidden dependency spec/u);

    const local = await fixture({ kind: "runtime", controller: { create: () => ({}) } });
    const localConfig = minimalConfig(local.modules[0]!.name);
    setMainRuntime(localConfig, { $use: "./runtime.js" });
    await local.writeConfig(localConfig);
    const localResult = await validateAgentConfig(local.configPath);
    expect(localResult.issues.some((entry) => entry.code === "package_name")).toBe(true);

    const api = await fixture({ kind: "runtime", apiVersion: 2, controller: { create: () => ({}) } });
    await api.writeConfig(minimalConfig(api.modules[0]!.name));
    await expectConfigIssue(loadAgentConfig(api.configPath), /apiVersion/u);

    const kind = await fixture({ kind: "runtime", manifestKind: "channel", controller: { create: () => ({}) } });
    await kind.writeConfig(minimalConfig(kind.modules[0]!.name));
    await expectConfigIssue(loadAgentConfig(kind.configPath), /expected runtime/u);
  });

  it.each([
    ["GitLab shorthand", "gitlab:owner/repo#main"],
    ["Bitbucket shorthand", "bitbucket:owner/repo#main"],
    ["GitHub shorthand", "owner/repo#main"],
    ["Git SSH URL", "git+ssh://git@github.com/owner/repo.git#main"],
    ["SSH URL", "ssh://git@github.com/owner/repo.git"],
    ["scp-style Git URL", "git@github.com:owner/repo.git"],
    ["local tgz archive", "module.tgz"],
    ["local tar archive", "module.tar"],
    ["local tar.gz archive", "module.tar.gz"],
    ["case-variant local archive", "module.TGZ"],
    ["numeric JSON value", 1],
    ["object JSON value", { source: "registry" }],
  ])("rejects non-registry dependency spec: %s", async (_label, dependencySpec) => {
    const project = await fixture({
      kind: "runtime",
      dependencySpec,
      controller: { create: () => ({}) },
    });
    await project.writeConfig(minimalConfig(project.modules[0]!.name));
    await expectConfigIssue(loadAgentConfig(project.configPath), /forbidden dependency spec/u);
  });

  it("binds npm lock root evidence to the exact authored dependency spec", async () => {
    const project = await fixture({
      kind: "runtime",
      dependencySpec: "^1.0.0",
      controller: { create: () => ({}) },
    });
    await project.writeConfig(minimalConfig(project.modules[0]!.name));
    const lockPath = join(project.root, "package-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
      packages: Record<string, { dependencies?: Record<string, unknown> }>;
    };
    lock.packages[""]!.dependencies![project.modules[0]!.name] = "file:../evil";
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    await expectConfigIssue(loadAgentConfig(project.configPath), /mismatched.*npm lockfile/u);
  });

  it("rejects workspace specs and non-registry pnpm resolutions before reserved module import", async () => {
    const workspace = await createFixtureProject([
      { kind: "runtime", controller: runtimeController(async () => ({})) },
      {
        name: "@mono-agent/state-local",
        kind: "state",
        dependencySpec: "workspace:*",
        entrySource: "throw new Error('workspace reserved module was imported');",
      },
    ]);
    projects.push(workspace);
    await workspace.writeConfig(minimalConfig(workspace.modules[0]!.name, {
      state: { $use: "@mono-agent/state-local" },
    }));
    await expectConfigIssue(loadAgentConfig(workspace.configPath), /forbidden dependency spec/u);

    const marker = `reserved-link-${randomUUID().toLowerCase()}`;
    const linked = await createFixtureProject([
      { kind: "runtime", controller: runtimeController(async () => ({})) },
      {
        name: "@mono-agent/state-local",
        kind: "state",
        dependencySpec: "^1.0.0",
        entrySource: `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "bad");`,
      },
    ]);
    projects.push(linked);
    const [runtime] = linked.modules;
    const markerPath = join(linked.root, marker);
    const stateRoot = join(linked.root, "node_modules", "@mono-agent", "state-local");
    await writeFile(
      join(stateRoot, "index.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(markerPath)}, "bad");`,
    );
    await linked.writeConfig(minimalConfig(runtime!.name, {
      state: { $use: "@mono-agent/state-local" },
    }));
    await rm(join(linked.root, "package-lock.json"));
    await writeFile(join(linked.root, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      `      ${JSON.stringify(runtime!.name)}:`,
      "        specifier: 1.0.0",
      "        version: 1.0.0",
      "      '@mono-agent/state-local':",
      "        specifier: file:evil",
      "        version: 1.0.0",
      "",
    ].join("\n"));

    await expectConfigIssue(loadAgentConfig(linked.configPath), /mismatched.*pnpm lockfile/u);
    await expect(access(markerPath)).rejects.toThrow();
  });

  it.each([
    {
      kind: "state" as const,
      catalogPackage: "@mono-agent/state-local",
      configPath: "state",
      override: (packageName: string) => ({ state: { $use: packageName } }),
    },
    {
      kind: "trigger" as const,
      catalogPackage: "@mono-agent/trigger-cron",
      configPath: "triggers.rejected",
      override: (packageName: string) => ({ triggers: { rejected: { $use: packageName } } }),
    },
    {
      kind: "exporter" as const,
      catalogPackage: "@mono-agent/exporter-otlp",
      configPath: "observability.exporters.rejected",
      override: (packageName: string) => ({
        observability: { exporters: { rejected: { $use: packageName } } },
      }),
    },
    {
      kind: "sandbox" as const,
      catalogPackage: "@mono-agent/sandbox-srt",
      configPath: "policy.sandbox",
      override: (packageName: string) => ({
        policy: {
          tools: { default: "deny", allow: [] },
          approvals: { default: "allow" },
          sandbox: { $use: packageName },
        },
      }),
    },
  ])("rejects a non-catalog $kind module before importing its entrypoint", async ({
    kind,
    catalogPackage,
    configPath,
    override,
  }) => {
    const marker = `reserved-import-${randomUUID().toLowerCase()}`;
    const runtimeName = `@fixture/runtime-${randomUUID().toLowerCase()}`;
    const reservedName = `@fixture/${kind}-${randomUUID().toLowerCase()}`;
    const project = await createFixtureProject([
      { name: runtimeName, kind: "runtime", controller: runtimeController(async () => ({})) },
      {
        name: reservedName,
        kind,
        useFirstPartyReservedPackage: false,
        entrySource: `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "bad");`,
      },
    ]);
    projects.push(project);
    const markerPath = join(project.root, marker);
    const packageRoot = join(project.root, "node_modules", ...reservedName.split("/"));
    await writeFile(
      join(packageRoot, "index.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(markerPath)}, "bad");`,
    );
    await project.writeConfig(minimalConfig(runtimeName, override(reservedName)));

    await expect(loadAgentConfig(project.configPath)).rejects.toMatchObject({
      issues: [{
        code: "reserved_module_not_first_party",
        path: configPath,
        message: expect.stringContaining(catalogPackage),
      }],
    });
    await expect(access(markerPath)).rejects.toThrow();
  });

  it("preflights metadata before import and rejects an entry symlink escape", async () => {
    const markerProject = await fixture({
      kind: "runtime",
      manifestKind: "channel",
      entrySource: `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify("IMPORT_MARKER")}, "bad");`,
    });
    const marker = join(markerProject.root, "IMPORT_MARKER");
    const packageRoot = join(markerProject.root, "node_modules", ...markerProject.modules[0]!.name.split("/"));
    await writeFile(join(packageRoot, "index.js"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "bad");`);
    await markerProject.writeConfig(minimalConfig(markerProject.modules[0]!.name));
    await expectConfigIssue(loadAgentConfig(markerProject.configPath), /expected runtime/u);
    await expect(access(marker)).rejects.toThrow();

    const escaped = await fixture({ kind: "runtime", controller: { create: () => ({}) } });
    const escapedName = escaped.modules[0]!.name;
    await replacePackageEntryWithSymlink(escaped, escapedName, "export const monoAgentModule = {};\n");
    await escaped.writeConfig(minimalConfig(escapedName));
    await expectConfigIssue(loadAgentConfig(escaped.configPath), /escapes its installed package root/u);
  });

  it("rejects non-compliant module definitions and schema annotations after import", async () => {
    const duplicateCapability = await fixture({
      kind: "runtime",
      capabilities: ["runtime.fixture", "runtime.fixture"],
      controller: { create: () => ({}) },
    });
    await duplicateCapability.writeConfig(minimalConfig(duplicateCapability.modules[0]!.name));
    await expectConfigIssue(loadAgentConfig(duplicateCapability.configPath), /capabilities contains duplicate/u);

    const invalidAnnotation = await fixture({
      kind: "runtime",
      schema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            "x-mono-agent-slot-reference": { slot: "unknown" },
          },
        },
        additionalProperties: false,
      },
      controller: { create: () => ({}) },
    });
    await invalidAnnotation.writeConfig(minimalConfig(invalidAnnotation.modules[0]!.name));
    await expectConfigIssue(loadAgentConfig(invalidAnnotation.configPath), /invalid cross-slot reference annotation/u);
  });
});

async function fixture(option: Parameters<typeof createFixtureProject>[0][number]): Promise<FixtureProject> {
  const project = await createFixtureProject([option]);
  projects.push(project);
  return project;
}

async function tree(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      files.push(`${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f"}:${relative}`);
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
    }
  };
  await visit(root, "");
  return files;
}

function nested(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function setMainRuntime(config: { readonly runtimes: Readonly<Record<string, unknown>> }, value: unknown): void {
  (config.runtimes as Record<string, unknown>).main = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function expectConfigIssue(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
    throw new Error("expected config validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentConfigError);
    const configError = error as AgentConfigError;
    expect(configError.issues.some((issue) => pattern.test(issue.message))).toBe(true);
  }
}
