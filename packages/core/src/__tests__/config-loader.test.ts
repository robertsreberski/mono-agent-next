import { randomUUID } from "node:crypto";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentConfigError,
  composeAgentConfigSchema,
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
    expect(explanation.entries).toContainEqual({
      path: "runtimes.main.apiKey",
      owner: runtime,
      source: "env",
      env: "FIXTURE_API_KEY",
      redacted: true,
    });
    expect(JSON.stringify(explanation)).not.toContain(secret);

    const schema = await composeAgentConfigSchema(loaded);
    const apiKey = nested(schema, ["properties", "runtimes", "properties", "main", "properties", "apiKey"]);
    expect(apiKey).toMatchObject({
      type: "object",
      required: ["$env"],
      additionalProperties: false,
    });
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
