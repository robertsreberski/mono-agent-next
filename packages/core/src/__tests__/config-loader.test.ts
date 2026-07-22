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
