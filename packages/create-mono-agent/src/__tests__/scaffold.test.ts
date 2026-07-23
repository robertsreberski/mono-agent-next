import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ScaffoldError, scaffoldAgent } from "../scaffold.js";
import {
  PROJECT_TEMPLATES,
  renderMinimalProject,
  renderProject,
  type ProjectTemplate,
} from "../templates.js";

const temporaryDirectories: string[] = [];

const EXPECTED_DEPENDENCIES: Readonly<Record<ProjectTemplate, readonly string[]>> = {
  minimal: [
    "@mono-agent/channel-webhook",
    "@mono-agent/cli",
    "@mono-agent/core",
    "@mono-agent/module-sdk",
    "@mono-agent/runtime-pi",
  ],
  personal: [
    "@mono-agent/channel-openai-api",
    "@mono-agent/channel-operator",
    "@mono-agent/channel-telegram",
    "@mono-agent/channel-webhook",
    "@mono-agent/cli",
    "@mono-agent/core",
    "@mono-agent/exporter-otlp",
    "@mono-agent/memory-local",
    "@mono-agent/module-sdk",
    "@mono-agent/runtime-pi",
    "@mono-agent/state-local",
    "@mono-agent/trigger-cron",
  ],
  "multi-runtime": [
    "@mono-agent/channel-webhook",
    "@mono-agent/cli",
    "@mono-agent/core",
    "@mono-agent/module-sdk",
    "@mono-agent/runtime-claude",
    "@mono-agent/runtime-pi",
  ],
};

const DECLARED_RUNTIME_APPROVAL_CAPABILITIES: Readonly<Record<string, boolean>> = {
  "@mono-agent/runtime-claude": false,
  "@mono-agent/runtime-pi": false,
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("project templates", () => {
  it("defaults the generic and compatibility renderers to the minimal five-package closure", () => {
    const generic = renderProject({ projectName: "minimal-example" });
    const compatible = renderMinimalProject({ projectName: "minimal-example" });
    expect(generic).toEqual(compatible);

    const files = fileMap(generic);
    const manifest = parseJson(files, "package.json");
    const config = parseJson(files, "mono-agent.config.json");
    expect(Object.keys(record(manifest.dependencies)).sort()).toEqual(EXPECTED_DEPENDENCIES.minimal);
    expect(config).toMatchObject({
      agent: { id: "minimal-example", name: "Minimal Example", instructions: "./AGENTS.md" },
      routing: {
        primary: { runtime: "pi", model: "openai-codex:gpt-5.6-sol" },
        fallbacks: [],
      },
      channels: {
        inbound: {
          $use: "@mono-agent/channel-webhook",
          listen: { host: "127.0.0.1", port: 3210 },
          apiKey: { $env: "WEBHOOK_API_KEY" },
        },
      },
      policy: { approvals: { default: "allow" } },
    });
  });

  it.each(["minimal", "multi-runtime"] as const)(
    "renders every %s route with an approval policy supported by its runtime",
    (template) => {
      const files = fileMap(renderProject({ projectName: `${template}-agent`, template }));
      const config = parseJson(files, "mono-agent.config.json");
      const routing = record(config.routing);
      const runtimes = record(config.runtimes);
      const policy = record(config.policy);
      const approvalDefault = record(policy.approvals).default;
      const routes = [record(routing.primary), ...(routing.fallbacks as readonly unknown[]).map(record)];

      for (const route of routes) {
        const runtimeId = String(route.runtime);
        const packageName = String(record(runtimes[runtimeId]).$use);
        const approvalsSupported = DECLARED_RUNTIME_APPROVAL_CAPABILITIES[packageName];
        expect(approvalsSupported, `${packageName} must declare an approval capability fixture`).toBeDefined();
        expect(
          approvalDefault !== "ask" || approvalsSupported,
          `${template} route ${runtimeId} is blocked because ${packageName} does not support approvals`,
        ).toBe(true);
      }
    },
  );

  it.each(PROJECT_TEMPLATES)("renders the %s template with exact direct dependencies", (template) => {
    const files = fileMap(renderProject({ projectName: `${template}-example`, template }));
    const manifest = parseJson(files, "package.json");
    const config = parseJson(files, "mono-agent.config.json");
    const dependencies = Object.keys(record(manifest.dependencies)).sort();
    const selections = selectedPackages(config);

    expect(dependencies).toEqual(EXPECTED_DEPENDENCIES[template]);
    expect([...selections].sort()).toEqual(
      dependencies.filter((name) => !["@mono-agent/cli", "@mono-agent/core", "@mono-agent/module-sdk"].includes(name)),
    );
    expect(new Set(Object.values(record(manifest.dependencies)))).toEqual(new Set(["0.15.0"]));
    expect(files.get("AGENTS.md")).toContain("Never print, persist, or summarize credential values.");
    expect(parseJson(files, ".mono-agent/mono-agent.config.schema.json")).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
    });
  });

  it("renders the current Personal Agent module shapes without stale PRD-only fields", () => {
    const files = fileMap(renderProject({ projectName: "personal-agent", template: "personal" }));
    const config = parseJson(files, "mono-agent.config.json");
    const memory = record(config.memory);
    const state = record(config.state);
    const channels = record(config.channels);

    expect([...files.keys()]).toContain(".mcp.json");
    expect([...files.keys()]).toContain("cron/.gitkeep");
    expect([...files.keys()]).toContain("skills/.gitkeep");
    expect([...files.keys()]).not.toContain(".mono-agent/memory/.first-run-memory-initializing");
    expect(memory).toEqual({
      $use: "@mono-agent/memory-local",
      root: "./.mono-agent/memory",
      maxBytes: 96_000,
      capture: {
        enabled: true,
        model: { runtime: "pi", model: "openai-codex:gpt-5.4-mini" },
        timeoutMs: 360_000,
      },
      embeddings: {
        provider: "ollama",
        endpoint: "http://127.0.0.1:11434",
        model: "nomic-embed-text:v1.5",
        dimensions: 768,
      },
      recallTool: { enabled: true },
    });
    expect(state).toMatchObject({
      $use: "@mono-agent/state-local",
      root: "./.mono-agent/state",
      runs: {
        artifactsDirectory: "./.mono-agent/artifacts",
        retentionDays: 30,
      },
      discovery: { sourceId: "personal-agent", sourceLabel: "Personal Agent" },
    });
    expect(config).toMatchObject({
      context: {
        skills: { roots: ["./skills"], load: "all", disclosure: "index", maxBytes: 96_000 },
      },
      policy: { tools: { default: "allow" } },
    });
    expect(record(channels.telegram)).not.toHaveProperty("quietHours");
    expect(record(channels.telegram)).not.toHaveProperty("transcription");
    expect(record(channels.webhook)).toMatchObject({ path: "/webhook/invoke", mode: "async" });
    expect(record(channels.webhook)).not.toHaveProperty("routesDirectory");
    expect(record(channels["openai-api"]).listen).toEqual({ host: "127.0.0.1", port: 4312 });
  });

  it("renders explicit Pi and native Claude routes for multi-runtime", () => {
    const files = fileMap(renderProject({ projectName: "multi-agent", template: "multi-runtime" }));
    const config = parseJson(files, "mono-agent.config.json");
    expect(config).toMatchObject({
      runtimes: {
        pi: { $use: "@mono-agent/runtime-pi" },
        "claude-sdk": {
          $use: "@mono-agent/runtime-claude",
          mode: "sdk",
          auth: { method: "oauth-token", token: { $env: "CLAUDE_CODE_OAUTH_TOKEN" } },
        },
      },
      routing: {
        fallbacks: [
          { runtime: "claude-sdk", model: "claude-opus-4-8" },
          { runtime: "pi", model: "anthropic:claude-opus-4-8" },
        ],
      },
    });
  });

  it.each(PROJECT_TEMPLATES)("emits names-only secret references for %s", (template) => {
    const files = fileMap(renderProject({ projectName: "safe-agent", template }));
    const environment = files.get(".env.example") ?? "";
    expect(environment.trimEnd().split("\n").every((line) => /^[A-Z_][A-Z0-9_]*=$/u.test(line))).toBe(true);
    expect(environment).not.toMatch(/=.+/u);
    expect([...files.keys()]).not.toContain(".env");
    expect([...files.keys()].some((path) => path.startsWith(".secrets/"))).toBe(false);
    expect([...files.values()].join("\n")).not.toMatch(/(?:sk-[A-Za-z0-9]{8}|Bearer\s+\S+|BEGIN PRIVATE KEY)/u);
  });

  it("rejects unsafe names and unknown templates before rendering", () => {
    expect(() => renderProject({ projectName: "../escape" })).toThrow("Invalid npm package name");
    expect(() => renderProject({ projectName: "valid", displayName: "bad\nname" })).toThrow("displayName");
    expect(() => renderProject({
      projectName: `a${"b".repeat(128)}`,
      displayName: "Personal Agent",
      template: "personal",
    })).toThrow("agent id must be at most 128 characters");
    expect(() => renderProject({
      projectName: "valid",
      template: "unknown" as ProjectTemplate,
    })).toThrow("Unknown project template");
  });
});

describe("scaffoldAgent", () => {
  it.each(PROJECT_TEMPLATES)("publishes a complete %s project", async (template) => {
    const root = await makeTemporaryDirectory();
    const target = join(root, `${template}-agent`);

    await expect(scaffoldAgent({ targetDirectory: target, template })).resolves.toMatchObject({
      directory: target,
      template,
      installed: false,
    });
    expect(JSON.parse(await readFile(join(target, "package.json"), "utf8")).dependencies)
      .toHaveProperty(EXPECTED_DEPENDENCIES[template][0]!);
    expect((await stat(join(target, ".env.example"))).mode & 0o777).toBe(0o600);
  });

  it("accepts an existing empty directory without overwriting non-empty or symlink targets", async () => {
    const root = await makeTemporaryDirectory();
    const empty = join(root, "empty-agent");
    const occupied = join(root, "occupied");
    const external = join(root, "external");
    const linked = join(root, "linked");
    await mkdir(empty);
    await mkdir(occupied);
    await mkdir(external);
    await writeFile(join(occupied, "keep.txt"), "keep", "utf8");
    await writeFile(join(external, "keep.txt"), "external", "utf8");
    await symlink(external, linked);

    await expect(scaffoldAgent({ targetDirectory: empty })).resolves.toMatchObject({ template: "minimal" });
    await expect(scaffoldAgent({ targetDirectory: occupied })).rejects.toThrow(ScaffoldError);
    await expect(scaffoldAgent({ targetDirectory: linked })).rejects.toThrow(/symbolic link/u);
    await expect(readFile(join(occupied, "keep.txt"), "utf8")).resolves.toBe("keep");
    await expect(readFile(join(external, "keep.txt"), "utf8")).resolves.toBe("external");
    expect(await readdir(external)).toEqual(["keep.txt"]);
  });

  it("allows only one concurrent scaffold owner", async () => {
    const root = await makeTemporaryDirectory();
    const target = join(root, "race-agent");
    let releaseInstall!: () => void;
    let markInstallerStarted!: () => void;
    const installerStarted = new Promise<void>((resolvePromise) => {
      markInstallerStarted = resolvePromise;
    });
    const installer = vi.fn(async () => {
      markInstallerStarted();
      await new Promise<void>((resolvePromise) => {
        releaseInstall = resolvePromise;
      });
    });
    const first = scaffoldAgent({ targetDirectory: target, install: true, installer });
    await installerStarted;

    await expect(scaffoldAgent({ targetDirectory: target })).rejects.toThrow(/Another scaffold operation/u);
    releaseInstall();
    await expect(first).resolves.toMatchObject({ installed: true });
    expect(installer).toHaveBeenCalledTimes(1);
  });

  it("never invokes a package manager without the explicit install flag", async () => {
    const root = await makeTemporaryDirectory();
    const installer = vi.fn(async () => undefined);

    await scaffoldAgent({ targetDirectory: join(root, "default-agent"), installer });
    expect(installer).not.toHaveBeenCalled();

    await scaffoldAgent({
      targetDirectory: join(root, "installed-agent"),
      template: "multi-runtime",
      install: true,
      packageManager: "npm",
      installer,
    });
    expect(installer).toHaveBeenCalledOnce();
    expect(installer).toHaveBeenCalledWith("npm", expect.stringContaining(".installed-agent.mono-agent-stage-"));
  });

  it("rolls back every staged file when explicit installation fails", async () => {
    const root = await makeTemporaryDirectory();
    const target = join(root, "failed-agent");

    await expect(scaffoldAgent({
      targetDirectory: target,
      template: "personal",
      install: true,
      installer: async () => {
        throw new Error("registry unavailable");
      },
    })).rejects.toThrow("registry unavailable");

    await expect(readdir(target)).rejects.toThrow();
    expect((await readdir(root)).filter((entry) => entry.includes("mono-agent-stage"))).toEqual([]);
  });
});

function fileMap(files: readonly { readonly path: string; readonly contents: string }[]): Map<string, string> {
  return new Map(files.map((file) => [file.path, file.contents]));
}

function parseJson(files: ReadonlyMap<string, string>, path: string): Record<string, unknown> {
  const source = files.get(path);
  if (source === undefined) throw new Error(`Missing rendered file ${path}`);
  return record(JSON.parse(source) as unknown);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected an object");
  }
  return value as Record<string, unknown>;
}

function selectedPackages(value: unknown, output = new Set<string>()): ReadonlySet<string> {
  if (Array.isArray(value)) {
    for (const child of value) selectedPackages(child, output);
    return output;
  }
  if (value === null || typeof value !== "object") return output;
  const object = value as Record<string, unknown>;
  if (typeof object.$use === "string") output.add(object.$use);
  for (const child of Object.values(object)) selectedPackages(child, output);
  return output;
}

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "create-mono-agent-test-"));
  temporaryDirectories.push(path);
  return path;
}
