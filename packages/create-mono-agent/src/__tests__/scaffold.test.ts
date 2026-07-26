// SPDX-License-Identifier: MIT
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import packageManifest from "../../package.json" with { type: "json" };
import {
  packageManagerInvocationForTesting,
  ScaffoldError,
  scaffoldAgent,
  scaffoldAgentForTesting,
} from "../scaffold.js";
import {
  acquireScaffoldLock,
  releaseScaffoldLock,
} from "../scaffold-lock.js";
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
  "@mono-agent/runtime-pi": true,
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
      policy: { approvals: { default: "ask" } },
    });
  });

  it.each(["minimal", "multi-runtime"] as const)(
    "renders %s with deny-by-default tools and ask-by-default approvals",
    (template) => {
      const files = fileMap(renderProject({ projectName: `${template}-agent`, template }));
      const config = parseJson(files, "mono-agent.config.json");
      const routing = record(config.routing);
      const runtimes = record(config.runtimes);
      const policy = record(config.policy);
      const approvalDefault = record(policy.approvals).default;
      const routes = [record(routing.primary), ...(routing.fallbacks as readonly unknown[]).map(record)];

      expect(policy).toMatchObject({
        tools: { default: "deny", allow: [] },
        approvals: { default: "ask" },
      });
      for (const route of routes) {
        const runtimeId = String(route.runtime);
        const packageName = String(record(runtimes[runtimeId]).$use);
        const approvalsSupported = DECLARED_RUNTIME_APPROVAL_CAPABILITIES[packageName];
        expect(approvalsSupported, `${packageName} must declare an approval capability fixture`).toBeDefined();
      }
      const primaryRuntimeId = String(record(routing.primary).runtime);
      const primaryPackage = String(record(runtimes[primaryRuntimeId]).$use);
      expect(approvalDefault).toBe("ask");
      expect(
        DECLARED_RUNTIME_APPROVAL_CAPABILITIES[primaryPackage],
        `${template} primary runtime must support approval callbacks`,
      ).toBe(true);
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
    expect(new Set(Object.values(record(manifest.dependencies))))
      .toEqual(new Set([packageManifest.version]));
    expect(record(
      parseJson(files, ".mono-agent/mono-agent.config.schema.json"),
    ).$id).toBe(
      `https://mono-agent.dev/schemas/${packageManifest.version}/scaffold-${template}.json`,
    );
    expect(files.get("AGENTS.md")).toContain("Never print, persist, or summarize credential values.");
    expect(parseJson(files, ".mono-agent/mono-agent.config.schema.json")).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
    });
  });

  it.each(PROJECT_TEMPLATES)(
    "keeps the rendered %s README off unpublished registry execution",
    (template) => {
      const files = fileMap(renderProject({ projectName: `${template}-example`, template }));
      const readme = files.get("README.md");

      expect(readme).toContain("not published to npm during the source preview");
      expect(readme).toContain("belong to the predecessor repository");
      expect(readme).toContain("pnpm run verify:consumers");
      expect(readme).not.toMatch(/\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\b/iu);
      expect(readme).not.toMatch(/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?start\b/iu);
      expect(readme).not.toMatch(/\bnpx\b/iu);
    },
  );

  it("renders the retained Personal Agent contract with current module fields", () => {
    const files = fileMap(renderProject({ projectName: "personal-agent", template: "personal" }));
    const config = parseJson(files, "mono-agent.config.json");
    const memory = record(config.memory);
    const state = record(config.state);
    const channels = record(config.channels);
    const mcp = parseJson(files, ".mcp.json");
    const cron = files.get("cron/morning-briefing.md") ?? "";
    const projectMcp = files.get("tools/project-status-mcp.mjs") ?? "";
    const webhookRoute = files.get("webhook/invoke.md") ?? "";
    const environment = files.get(".env.example") ?? "";
    const gitignore = files.get(".gitignore") ?? "";

    expect([...files.keys()]).toContain(".mcp.json");
    expect([...files.keys()]).toContain("cron/morning-briefing.md");
    expect([...files.keys()]).toContain("skills/.gitkeep");
    expect([...files.keys()]).toContain("tools/project-status-mcp.mjs");
    expect([...files.keys()]).toContain("webhook/invoke.md");
    expect([...files.keys()]).not.toContain("cron/.gitkeep");
    expect([...files.keys()]).not.toContain(".mono-agent/memory/.first-run-memory-initializing");
    expect(mcp).toEqual({
      mcpServers: {
        "project-status": {
          type: "stdio",
          command: "node",
          args: ["./tools/project-status-mcp.mjs"],
        },
      },
    });
    expect(projectMcp).toContain('name: "project_status"');
    expect(projectMcp).toContain("The scaffolded project MCP fixture is available.");
    expect(cron).toContain("id: morning-briefing");
    expect(cron).toContain("expression: 30 7 * * *");
    expect(cron).toContain("runtime: pi");
    expect(cron).toContain("model: openai-codex:gpt-5.6-sol");
    expect(cron).toContain("notify: telegram");
    expect(cron).toContain("Do not change files, contact external services");
    expect(webhookRoute).toContain("name: invoke");
    expect(webhookRoute).toContain("path: /webhook/invoke");
    expect(webhookRoute).toContain("enabled: true");
    expect(environment).toContain("MONO_AGENT_WEBHOOK_SIGNATURE_SECRET=\n");
    expect(gitignore).toContain(".mono-agent/artifacts/\n");
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
        skills: { roots: ["./skills"], load: "all", disclosure: "index", maxBytes: 256_000 },
      },
      policy: { tools: { default: "allow" } },
    });
    expect(record(channels.telegram)).toMatchObject({
      quietHours: { start: "23:00", end: "07:00", timezone: "Europe/Rome" },
      transport: { ipFamily: 4 },
      transcription: {
        endpoint: "http://127.0.0.1:50060/v1/audio/transcriptions",
        model: "large-v3-v20240930",
      },
    });
    expect(record(channels.webhook)).toMatchObject({
      listen: { host: "100.64.0.10", port: 4313 },
      allowNonLoopback: true,
      apiKey: { $env: "MONO_AGENT_WEBHOOK_API_KEY" },
      signatureSecret: { $env: "MONO_AGENT_WEBHOOK_SIGNATURE_SECRET" },
      routesDirectory: "./webhook",
      defaultMode: "async",
      retentionMs: 300_000,
      maxStoredRequests: 100,
    });
    expect(record(channels.webhook)).not.toHaveProperty("path");
    expect(record(channels.webhook)).not.toHaveProperty("mode");
    expect(record(channels["openai-api"])).toMatchObject({
      listen: { host: "0.0.0.0", port: 4312 },
      allowNonLoopback: true,
    });
  });

  it("ships a runnable project-owned MCP fixture without a mono-agent module dependency", async () => {
    const root = await makeTemporaryDirectory();
    const target = join(root, "personal-agent");
    await scaffoldAgent({ targetDirectory: target, template: "personal" });
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "project_status", arguments: {} } },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n";
    const result = spawnSync(process.execPath, ["./tools/project-status-mcp.mjs"], {
      cwd: target,
      input,
      encoding: "utf8",
      timeout: 5_000,
      shell: false,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const frames = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(frames).toHaveLength(3);
    expect(frames[1]).toMatchObject({
      id: 2,
      result: { tools: [{ name: "project_status" }] },
    });
    expect(frames[2]).toMatchObject({
      id: 3,
      result: {
        content: [{ type: "text", text: "The scaffolded project MCP fixture is available." }],
      },
    });
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

  it("reclaims a SIGKILL-stale scaffold lock and stage", async () => {
    const root = await makeTemporaryDirectory();
    const targetName = "crash-agent";
    const child = await crashScaffoldOwner(root, targetName);
    expect(child).toMatchObject({ code: null, signal: "SIGKILL", stderr: "" });

    const leaked = await readdir(root);
    expect(leaked).toContain(`.${targetName}.mono-agent-scaffold.lock`);
    expect(leaked).toContainEqual(
      expect.stringMatching(new RegExp(`^\\.${targetName}\\.mono-agent-stage-`, "u")),
    );

    const stageName = leaked.find((entry) =>
      entry.startsWith(`.${targetName}.mono-agent-stage-`));
    if (stageName === undefined) throw new Error("Missing crashed scaffold stage");

    await expect(scaffoldAgent({
      targetDirectory: join(root, targetName),
    })).resolves.toMatchObject({
      directory: join(root, targetName),
      installed: false,
      retainedRecoveryPaths: [join(root, stageName)],
    });

    const recovered = await readdir(root);
    expect(recovered).toContain(targetName);
    expect(recovered).not.toContain(`.${targetName}.mono-agent-scaffold.lock`);
    expect(recovered).toContain(stageName);
    await expect(readFile(join(root, stageName, "partial"), "utf8"))
      .resolves.toBe("partial\n");
  }, 20_000);

  it("restores the exact parked target after SIGKILL before publication", async () => {
    const root = await makeTemporaryDirectory();
    const targetName = "parked-crash-agent";
    const target = join(root, targetName);
    await mkdir(target, { mode: 0o750 });
    const original = await lstat(target);

    const child = await crashScaffoldPublication(
      root,
      targetName,
      "after-parked",
    );
    expect(child).toMatchObject({
      code: null,
      signal: "SIGKILL",
      stderr: "",
    });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    const crashedEntries = await readdir(root);
    const parkedName = crashedEntries.find((entry) =>
      entry.startsWith(`.${targetName}.mono-agent-parked-`));
    const stageName = crashedEntries.find((entry) =>
      entry.startsWith(`.${targetName}.mono-agent-stage-`));
    if (parkedName === undefined || stageName === undefined) {
      throw new Error("Missing deterministic crash artifacts");
    }
    const parked = await lstat(join(root, parkedName));
    expect(identityOfStats(parked)).toEqual(identityOfStats(original));

    let restoredBeforeRetryPublication:
      | { readonly dev: number; readonly ino: number; readonly mode: number }
      | undefined;
    const result = await scaffoldAgent({
      targetDirectory: target,
      install: true,
      installer: async () => {
        restoredBeforeRetryPublication = await lstat(target);
      },
    });
    expect(identityOfStats(restoredBeforeRetryPublication!))
      .toEqual(identityOfStats(original));
    expect(restoredBeforeRetryPublication!.mode & 0o777)
      .toBe(original.mode & 0o777);
    expect(result.retainedRecoveryPaths).toEqual([join(root, stageName)]);
    expect(await readdir(root)).not.toContain(parkedName);
    await expect(readFile(join(target, "package.json"), "utf8"))
      .resolves.toContain('"name": "parked-crash-agent"');
  }, 20_000);

  it("preserves the exact target after SIGKILL at durable park intent", async () => {
    const root = await makeTemporaryDirectory();
    const targetName = "intent-crash-agent";
    const target = join(root, targetName);
    await mkdir(target, { mode: 0o750 });
    const original = identityOfStats(await lstat(target));

    const child = await crashScaffoldPublication(
      root,
      targetName,
      "after-intent",
    );
    expect(child).toMatchObject({ code: null, signal: "SIGKILL" });
    expect(identityOfStats(await lstat(target))).toEqual(original);
    expect((await readdir(root)).some((entry) =>
      entry.startsWith(`.${targetName}.mono-agent-parked-`))).toBe(false);

    let observedBeforePublication:
      | { readonly device: number; readonly inode: number }
      | undefined;
    const result = await scaffoldAgent({
      targetDirectory: target,
      install: true,
      installer: async () => {
        observedBeforePublication = identityOfStats(await lstat(target));
      },
    });
    expect(observedBeforePublication).toEqual(original);
    expect(result.retainedRecoveryPaths).toHaveLength(1);
  }, 20_000);

  it("restores the exact parked target when publication fails before its rename", async () => {
    const root = await makeTemporaryDirectory();
    const targetName = "parked-hook-failure-agent";
    const target = join(root, targetName);
    await mkdir(target, { mode: 0o750 });
    const original = await lstat(target);

    await expect(scaffoldAgentForTesting(
      { targetDirectory: target },
      {
        afterParkedBeforePublish: async () => {
          throw new Error("injected pre-publication failure");
        },
      },
    )).rejects.toThrow(/injected pre-publication failure/u);

    const restored = await lstat(target);
    expect(identityOfStats(restored)).toEqual(identityOfStats(original));
    expect(restored.mode & 0o777).toBe(original.mode & 0o777);
    expect(await readdir(target)).toEqual([]);
    expect(await readdir(root)).toEqual([targetName]);
  });

  it.each([
    {
      name: "before the published frame",
      hooks: {
        afterPublishBeforeJournal: async () => {
          throw new Error("injected pre-journal failure");
        },
      },
    },
    {
      name: "before parked-target cleanup",
      hooks: {
        afterPublishedBeforeParkedCleanup: async () => {
          throw new Error("injected pre-cleanup failure");
        },
      },
    },
  ])("retains the exact journal after publication $name", async ({ hooks }) => {
    const root = await makeTemporaryDirectory();
    const targetName = `retained-${randomUUID()}`;
    const target = join(root, targetName);
    await mkdir(target, { mode: 0o750 });
    const originalIdentity = identityOfStats(await lstat(target));

    await expect(scaffoldAgentForTesting(
      { targetDirectory: target },
      hooks,
    )).rejects.toThrow(/retained scaffold recovery journal=/u);

    await expect(readFile(join(target, "package.json"), "utf8"))
      .resolves.toContain(`"name": "${targetName}"`);
    const entries = await readdir(root);
    const lockName = `.${targetName}.mono-agent-scaffold.lock`;
    const abandonedName = `${lockName}.abandoned`;
    const parkedName = entries.find((entry) =>
      entry.startsWith(`.${targetName}.mono-agent-parked-`));
    expect(entries).toContain(lockName);
    expect(entries).toContain(abandonedName);
    expect(entries.some((entry) =>
      entry.startsWith(`.${targetName}.mono-agent-stage-`))).toBe(false);
    if (parkedName === undefined) throw new Error("Missing retained parked target");
    expect(identityOfStats(await lstat(join(root, parkedName))))
      .toEqual(originalIdentity);

    await expect(scaffoldAgent({ targetDirectory: target }))
      .rejects.toThrow(/Recovered a previously published scaffold/u);
    expect((await readdir(root))).not.toContain(lockName);
    expect((await readdir(root))).not.toContain(abandonedName);
    await expect(lstat(join(root, parkedName)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    {
      name: "before canonical journal removal",
      canonicalRemains: true,
      hooks: {
        beforeCanonicalJournalRemoval: async () => {
          throw new Error("injected canonical retirement failure");
        },
      },
    },
    {
      name: "after canonical journal removal",
      canonicalRemains: false,
      hooks: {
        afterCanonicalJournalRemoval: async () => {
          throw new Error("injected marker retirement failure");
        },
      },
    },
  ])(
    "recovers an abandoned journal when retirement fails $name",
    async ({ canonicalRemains, hooks }) => {
      const root = await makeTemporaryDirectory();
      const targetName = `retirement-${randomUUID()}`;
      const target = join(root, targetName);
      await mkdir(target, { mode: 0o750 });
      await expect(scaffoldAgentForTesting(
        { targetDirectory: target },
        {
          afterPublishBeforeJournal: async () => {
            throw new Error("retain publication for retirement test");
          },
        },
      )).rejects.toThrow(/retained scaffold recovery journal=/u);

      const lockPath = join(
        root,
        `.${targetName}.mono-agent-scaffold.lock`,
      );
      const abandonedPath = `${lockPath}.abandoned`;
      await expect(scaffoldAgentForTesting(
        { targetDirectory: target },
        hooks,
      )).rejects.toThrow(/retirement failure/u);
      if (canonicalRemains) {
        await expect(lstat(lockPath)).resolves.toBeDefined();
      } else {
        await expect(lstat(lockPath))
          .rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(lstat(abandonedPath)).resolves.toBeDefined();

      await expect(scaffoldAgent({ targetDirectory: target }))
        .rejects.toThrow(/Recovered a previously published scaffold/u);
      await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(abandonedPath))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(target, "package.json"), "utf8"))
        .resolves.toContain(`"name": "${targetName}"`);
    },
  );

  it("recognizes a SIGKILL publication before its published frame", async () => {
    const root = await makeTemporaryDirectory();
    const targetName = "published-crash-agent";
    const target = join(root, targetName);
    await mkdir(target, { mode: 0o750 });

    const child = await crashScaffoldPublication(
      root,
      targetName,
      "after-publish-before-journal",
    );
    expect(child).toMatchObject({
      code: null,
      signal: "SIGKILL",
      stderr: "",
    });
    const published = await lstat(target);
    const entries = await readdir(root);
    const parkedName = entries.find((entry) =>
      entry.startsWith(`.${targetName}.mono-agent-parked-`));
    if (parkedName === undefined) throw new Error("Missing parked target");
    const journal = join(
      root,
      `.${targetName}.mono-agent-scaffold.lock`,
    );
    expect(await readFile(journal, "utf8")).not.toContain(
      '"phase":"published"',
    );

    await expect(scaffoldAgent({ targetDirectory: target }))
      .rejects.toThrow(/Recovered a previously published scaffold/u);
    expect(identityOfStats(await lstat(target))).toEqual(
      identityOfStats(published),
    );
    await expect(readFile(join(target, "partial"), "utf8"))
      .resolves.toBe("partial\n");
    await expect(lstat(join(root, parkedName)))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(journal)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it.each([
    {
      name: "ASCII",
      tail: Buffer.from('{"phase":"published"', "utf8"),
    },
    {
      name: "invalid UTF-8",
      tail: Buffer.from([0x7b, 0x22, 0xc3]),
    },
  ])("ignores an unterminated $name journal tail", async ({ tail }) => {
    const root = await makeTemporaryDirectory();
    const targetName = `torn-${String(tail[tail.length - 1])}-agent`;
    const target = join(root, targetName);
    await mkdir(target, { mode: 0o700 });

    const child = await crashScaffoldPublication(
      root,
      targetName,
      "after-publish-before-journal",
      tail,
    );
    expect(child).toMatchObject({ code: null, signal: "SIGKILL" });

    await expect(scaffoldAgent({ targetDirectory: target }))
      .rejects.toThrow(/Recovered a previously published scaffold/u);
    await expect(readFile(join(target, "partial"), "utf8"))
      .resolves.toBe("partial\n");
  }, 20_000);

  it("rejects a malformed newline-terminated journal frame", async () => {
    const root = await makeTemporaryDirectory();
    const targetName = "durable-torn-agent";
    const target = join(root, targetName);
    await mkdir(target, { mode: 0o700 });
    const malformed = Buffer.from('{"phase":"published"\n', "utf8");

    const child = await crashScaffoldPublication(
      root,
      targetName,
      "after-publish-before-journal",
      malformed,
    );
    expect(child).toMatchObject({ code: null, signal: "SIGKILL" });
    const targetIdentity = identityOfStats(await lstat(target));
    const journal = join(
      root,
      `.${targetName}.mono-agent-scaffold.lock`,
    );

    await expect(scaffoldAgent({ targetDirectory: target }))
      .rejects.toThrow(/contains invalid JSON/u);
    expect(identityOfStats(await lstat(target))).toEqual(targetIdentity);
    await expect(lstat(journal)).resolves.toMatchObject({ isFile: expect.any(Function) });
    expect((await readdir(root)).some((entry) =>
      entry.startsWith(`.${targetName}.mono-agent-parked-`))).toBe(true);
  }, 20_000);

  it.each(["symlink", "inode", "mode"] as const)(
    "fails closed on a %s-substituted parked target",
    async (substitution) => {
      const root = await makeTemporaryDirectory();
      const targetName = `${substitution}-park-agent`;
      const target = join(root, targetName);
      await mkdir(target, { mode: 0o700 });
      const child = await crashScaffoldPublication(
        root,
        targetName,
        "after-parked",
      );
      expect(child).toMatchObject({ code: null, signal: "SIGKILL" });
      const entries = await readdir(root);
      const parkedName = entries.find((entry) =>
        entry.startsWith(`.${targetName}.mono-agent-parked-`));
      if (parkedName === undefined) throw new Error("Missing parked target");
      const parkedPath = join(root, parkedName);
      const exactOriginal = `${parkedPath}.exact-original`;
      const external = join(root, `${targetName}-external`);
      if (substitution === "symlink") {
        await mkdir(external, { mode: 0o700 });
        await writeFile(join(external, "sentinel"), "keep\n", { mode: 0o600 });
        await rename(parkedPath, exactOriginal);
        await symlink(external, parkedPath, "dir");
      } else if (substitution === "inode") {
        await rename(parkedPath, exactOriginal);
        await mkdir(parkedPath, { mode: 0o700 });
      } else {
        await chmod(parkedPath, 0o770);
      }
      const journal = join(
        root,
        `.${targetName}.mono-agent-scaffold.lock`,
      );

      await expect(scaffoldAgent({ targetDirectory: target })).rejects.toThrow(
        substitution === "symlink"
          ? /real directory/u
          : substitution === "inode"
            ? /changed identity/u
            : /group or other write/u,
      );
      await expect(lstat(journal)).resolves.toBeDefined();
      await expect(lstat(parkedPath)).resolves.toBeDefined();
      if (substitution !== "mode") {
        await expect(lstat(exactOriginal)).resolves.toBeDefined();
      }
      if (substitution === "symlink") {
        await expect(readFile(join(external, "sentinel"), "utf8"))
          .resolves.toBe("keep\n");
      }
    },
    20_000,
  );

  it("fails closed on a substituted published target inode", async () => {
    const root = await makeTemporaryDirectory();
    const targetName = "published-swap-agent";
    const target = join(root, targetName);
    await mkdir(target, { mode: 0o700 });
    const child = await crashScaffoldPublication(
      root,
      targetName,
      "after-publish-before-journal",
    );
    expect(child).toMatchObject({ code: null, signal: "SIGKILL" });
    const exactPublished = `${target}.exact-published`;
    await rename(target, exactPublished);
    await mkdir(target, { mode: 0o700 });
    await writeFile(join(target, "sentinel"), "competitor\n", { mode: 0o600 });
    const journal = join(
      root,
      `.${targetName}.mono-agent-scaffold.lock`,
    );

    await expect(scaffoldAgent({ targetDirectory: target }))
      .rejects.toThrow(/competitor prevents exact parked-target restoration/u);
    await expect(readFile(join(target, "sentinel"), "utf8"))
      .resolves.toBe("competitor\n");
    await expect(readFile(join(exactPublished, "partial"), "utf8"))
      .resolves.toBe("partial\n");
    await expect(lstat(journal)).resolves.toBeDefined();
    expect((await readdir(root)).some((entry) =>
      entry.startsWith(`.${targetName}.mono-agent-parked-`))).toBe(true);
  }, 20_000);

  it("reports an exact retained parked path when cleanup fails safely", async () => {
    const root = await makeTemporaryDirectory();
    const target = join(root, "cleanup-failure-agent");
    await mkdir(target, { mode: 0o750 });
    const original = identityOfStats(await lstat(target));
    let retainedPath = "";

    const result = await scaffoldAgentForTesting(
      { targetDirectory: target },
      {
        removeParkedDirectory: async (path) => {
          retainedPath = path;
          const error = new Error("simulated directory sync failure");
          Object.assign(error, { code: "EIO" });
          throw error;
        },
      },
    );

    expect(result.retainedRecoveryPaths).toEqual([retainedPath]);
    expect(identityOfStats(await lstat(retainedPath))).toEqual(original);
    expect(await readdir(retainedPath)).toEqual([]);
    await expect(readFile(join(target, "package.json"), "utf8"))
      .resolves.toContain('"name": "cleanup-failure-agent"');
    await expect(lstat(join(
      root,
      ".cleanup-failure-agent.mono-agent-scaffold.lock",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses unsafe stale v1 recovery without guessing parked siblings", async () => {
    const root = await makeTemporaryDirectory();
    const targetName = "legacy-agent";
    const nonce = randomUUID().toLowerCase();
    const lockPath = join(
      root,
      `.${targetName}.mono-agent-scaffold.lock`,
    );
    const stagePath = join(
      root,
      `.${targetName}.mono-agent-stage-${nonce}`,
    );
    const parkedPath = join(
      root,
      `.${targetName}.mono-agent-empty-${randomUUID().toLowerCase()}`,
    );
    const legacy = `${JSON.stringify({
      schemaVersion: 1,
      kind: "mono-agent.scaffold-lock",
      nonce,
      ownerPid: 99_999_999,
      stageName: `.${targetName}.mono-agent-stage-${nonce}`,
    })}\n`;
    await writeFile(lockPath, legacy, { mode: 0o600 });
    await mkdir(stagePath, { mode: 0o700 });
    await writeFile(join(stagePath, "partial"), "legacy\n", { mode: 0o600 });
    await mkdir(parkedPath, { mode: 0o700 });
    const lockIdentity = identityOfStats(await lstat(lockPath));
    const stageIdentity = identityOfStats(await lstat(stagePath));
    const parkedIdentity = identityOfStats(await lstat(parkedPath));

    await expect(scaffoldAgent({
      targetDirectory: join(root, targetName),
    })).rejects.toThrow(/schema version 1 cannot be recovered safely/u);
    expect(await readFile(lockPath, "utf8")).toBe(legacy);
    expect(identityOfStats(await lstat(lockPath))).toEqual(lockIdentity);
    expect(identityOfStats(await lstat(stagePath))).toEqual(stageIdentity);
    expect(identityOfStats(await lstat(parkedPath))).toEqual(parkedIdentity);
    await expect(readFile(join(stagePath, "partial"), "utf8"))
      .resolves.toBe("legacy\n");
  });

  it("keeps the scaffold fault seam out of the package root", async () => {
    const publicApi = await import("../index.js");
    expect(publicApi).not.toHaveProperty("scaffoldAgentForTesting");
  });

  it("fails closed on a substituted stale stage without touching its referent", async () => {
    const root = await makeTemporaryDirectory();
    const targetName = "substituted-agent";
    const child = await crashScaffoldOwner(root, targetName);
    expect(child).toMatchObject({ code: null, signal: "SIGKILL", stderr: "" });
    const stageName = (await readdir(root)).find((entry) =>
      entry.startsWith(`.${targetName}.mono-agent-stage-`));
    if (stageName === undefined) throw new Error("Missing crashed scaffold stage");
    const stagePath = join(root, stageName);
    const external = join(root, "external");
    await mkdir(external, { mode: 0o700 });
    await writeFile(join(external, "sentinel"), "keep\n", { mode: 0o600 });
    await rm(stagePath, { recursive: true, force: true });
    await symlink(external, stagePath, "dir");

    const lockPath = join(root, `.${targetName}.mono-agent-scaffold.lock`);
    await expect(scaffoldAgent({
      targetDirectory: join(root, targetName),
    })).rejects.toThrow(new RegExp(`real directory.*lock: ${escapePattern(lockPath)}`, "u"));
    await expect(readFile(join(external, "sentinel"), "utf8")).resolves.toBe("keep\n");
  }, 20_000);

  it("fails closed when an installer substitutes the live scaffold stage", async () => {
    const root = await makeTemporaryDirectory();
    const target = join(root, "stage-swap-agent");
    let substitutedStage = "";

    await expect(scaffoldAgent({
      targetDirectory: target,
      install: true,
      installer: async (_packageManager, stagePath) => {
        const original = `${stagePath}.original-${randomUUID()}`;
        await rename(stagePath, original);
        await mkdir(stagePath, { mode: 0o700 });
        await writeFile(join(stagePath, "sentinel"), "attacker-owned\n", {
          mode: 0o600,
        });
        substitutedStage = stagePath;
      },
    })).rejects.toThrow("Scaffold stage changed identity");

    await expect(lstat(target)).rejects.toThrow();
    await expect(readFile(join(substitutedStage, "sentinel"), "utf8"))
      .resolves.toBe("attacker-owned\n");
  });

  it("fails closed when an installer replaces the pinned scaffold lock", async () => {
    const root = await makeTemporaryDirectory();
    const targetName = "lock-swap-agent";
    const target = join(root, targetName);
    const lockPath = join(root, `.${targetName}.mono-agent-scaffold.lock`);
    let replacementWritten = false;
    let replacementBlockedCode: unknown;
    let failure: unknown;

    try {
      await scaffoldAgent({
        targetDirectory: target,
        install: true,
        installer: async () => {
          try {
            // Linux may immediately reuse an unpinned inode after this unlink.
            await unlink(lockPath);
            await writeFile(lockPath, "replacement\n", { mode: 0o600 });
            replacementWritten = true;
          } catch (error) {
            replacementBlockedCode = codeOf(error);
            throw error;
          }
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    await expect(lstat(target)).rejects.toThrow();
    if (replacementWritten) {
      expect((failure as Error).message).toContain(
        "Scaffold lock changed identity",
      );
      await expect(readFile(lockPath, "utf8")).resolves.toBe("replacement\n");
    } else {
      expect(["EACCES", "EBUSY", "EPERM"]).toContain(replacementBlockedCode);
      await expect(lstat(lockPath)).rejects.toThrow();
    }
  });

  it("closes the pinned scaffold-lock handle on release", async () => {
    const root = await makeTemporaryDirectory();
    const lock = await acquireScaffoldLock(root, "released-agent");

    await releaseScaffoldLock(lock);

    await expect(lock.handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    await expect(lstat(lock.path)).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "preserves a replacement and closes the pinned handle when release fails",
    async () => {
      const root = await makeTemporaryDirectory();
      const lock = await acquireScaffoldLock(root, "release-swap-agent");
      const held = await lock.handle.stat();
      expect({
        device: held.dev,
        inode: held.ino,
      }).toEqual(lock.identity);
      await unlink(lock.path);
      await writeFile(lock.path, "replacement\n", { mode: 0o600 });
      const replacement = await lstat(lock.path);
      expect({
        device: replacement.dev,
        inode: replacement.ino,
      }).not.toEqual(lock.identity);

      await expect(releaseScaffoldLock(lock)).rejects.toThrow(
        "scaffold lock changed identity",
      );

      await expect(lock.handle.stat()).rejects.toMatchObject({ code: "EBADF" });
      await expect(readFile(lock.path, "utf8")).resolves.toBe("replacement\n");
    },
  );

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

  it("runs Windows package-manager shims through cmd without enabling spawn's shell", () => {
    expect(packageManagerInvocationForTesting("npm", "win32")).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd install"],
    });
    expect(packageManagerInvocationForTesting("pnpm", "win32")).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd install"],
    });
    expect(packageManagerInvocationForTesting("npm", "linux")).toEqual({
      command: "npm",
      args: ["install"],
    });
    expect(packageManagerInvocationForTesting("pnpm", "darwin")).toEqual({
      command: "pnpm",
      args: ["install"],
    });
  });

  it.runIf(process.platform !== "win32")(
    "exercises real install spawn success, nonzero exit, and signal termination",
    async () => {
      const root = await makeTemporaryDirectory();
      const bin = join(root, "bin");
      const stub = join(bin, "pnpm");
      await mkdir(bin, { mode: 0o700 });
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
      try {
        await writePackageManagerStub(stub, [
          'import { writeFileSync } from "node:fs";',
          'if (process.argv[2] !== "install") process.exit(64);',
          'writeFileSync("install-spawn-success", "ok\\n");',
        ]);
        const success = join(root, "spawn-success");
        await expect(scaffoldAgent({
          targetDirectory: success,
          install: true,
          packageManager: "pnpm",
        })).resolves.toMatchObject({ installed: true, packageManager: "pnpm" });
        await expect(readFile(join(success, "install-spawn-success"), "utf8"))
          .resolves.toBe("ok\n");

        await writePackageManagerStub(stub, [
          'if (process.argv[2] !== "install") process.exit(64);',
          "process.exit(23);",
        ]);
        await expect(scaffoldAgent({
          targetDirectory: join(root, "spawn-nonzero"),
          install: true,
          packageManager: "pnpm",
        })).rejects.toThrow("pnpm install exited with code 23");

        await writePackageManagerStub(stub, [
          'if (process.argv[2] !== "install") process.exit(64);',
          'process.kill(process.pid, "SIGTERM");',
          "setTimeout(() => process.exit(99), 1_000);",
        ]);
        await expect(scaffoldAgent({
          targetDirectory: join(root, "spawn-signal"),
          install: true,
          packageManager: "pnpm",
        })).rejects.toThrow("pnpm install was terminated by SIGTERM");
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    },
    20_000,
  );

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

async function crashScaffoldOwner(
  parent: string,
  targetName: string,
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}> {
  const moduleUrl = new URL("../scaffold-lock.ts", import.meta.url).href;
  return runChild([
    `import { acquireScaffoldLock, createScaffoldStage } from ${JSON.stringify(moduleUrl)};`,
    'import { writeFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    `const lock = await acquireScaffoldLock(${JSON.stringify(parent)}, ${JSON.stringify(targetName)});`,
    "const stage = await createScaffoldStage(lock);",
    'await writeFile(join(stage.path, "partial"), "partial\\n", { mode: 0o600 });',
    'process.kill(process.pid, "SIGKILL");',
  ].join("\n"));
}

async function crashScaffoldPublication(
  parent: string,
  targetName: string,
  point: "after-intent" | "after-parked" | "after-publish-before-journal",
  tornTail?: Uint8Array,
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}> {
  const moduleUrl = new URL("../scaffold-lock.ts", import.meta.url).href;
  const source = [
    "import { constants } from \"node:fs\";",
    "import { open, rename, writeFile } from \"node:fs/promises\";",
    "import { join } from \"node:path\";",
    `import {
      acquireScaffoldLock,
      assertScaffoldTargetParkingReady,
      createScaffoldStage,
      prepareScaffoldTargetParking,
      recordScaffoldPublished,
      recordScaffoldTargetParked
    } from ${JSON.stringify(moduleUrl)};`,
    `const lock = await acquireScaffoldLock(${JSON.stringify(parent)}, ${JSON.stringify(targetName)});`,
    "const stage = await createScaffoldStage(lock);",
    'await writeFile(join(stage.path, "partial"), "partial\\n", { mode: 0o600 });',
    "const parkedIdentity = await prepareScaffoldTargetParking(lock);",
    ...(point === "after-intent"
      ? ['process.kill(process.pid, "SIGKILL");']
      : [
          "await assertScaffoldTargetParkingReady(lock, parkedIdentity);",
          "await rename(lock.targetPath, lock.parkedPath);",
          "await recordScaffoldTargetParked(lock, parkedIdentity);",
        ]),
    ...(point === "after-parked"
      ? ['process.kill(process.pid, "SIGKILL");']
      : []),
    ...(point === "after-publish-before-journal"
      ? [
          "await rename(stage.path, lock.targetPath);",
          "await recordScaffoldPublished(lock, stage, async () => {",
          ...(tornTail === undefined
            ? []
            : [
                `  const tail = Buffer.from(${JSON.stringify(Buffer.from(tornTail).toString("base64"))}, "base64");`,
                "  const journal = await open(lock.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);",
                "  await journal.write(tail);",
                "  await journal.sync();",
                "  await journal.close();",
              ]),
          '  process.kill(process.pid, "SIGKILL");',
          "});",
        ]
      : []),
  ].join("\n");
  return runChild(source);
}

async function writePackageManagerStub(
  path: string,
  lines: readonly string[],
): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node\n${lines.join("\n")}\n`,
    { mode: 0o700 },
  );
}

async function runChild(source: string): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}> {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", source],
    {
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      resolvePromise({ code, signal, stderr });
    });
  });
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? Reflect.get(error, "code")
    : undefined;
}

function identityOfStats(
  value: { readonly dev: number; readonly ino: number },
): { readonly device: number; readonly inode: number } {
  return { device: value.dev, inode: value.ino };
}
