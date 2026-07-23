#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  SOURCE_BETA_REPORT_OUTPUT,
  collectExecutableConfigReference,
  collectSourceBetaReport,
  discoverTypedModulePackages,
  renderSourceBetaComplexityMarkdown,
  renderSourceBetaConfigMarkdown,
  renderSourceBetaProductsMarkdown,
  renderSourceBetaPublicApiMarkdown,
} from "./lib/source-beta-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = parseArgs(process.argv.slice(2));
const typedModulePackages = discoverTypedModulePackages(root);
buildExecutableSchemas(root, typedModulePackages);
const { renderProject } = await import(
  pathToFileURL(join(root, "packages/create-mono-agent/src/templates.ts")).href
);

const report = collectSourceBetaReport({ root, renderProject });
const renderedProjects = report.templates.rows.map(({ template }) => {
  const files = renderProject({ projectName: `${template}-source-beta`, template });
  const configSource = files.find((file) => file.path === "mono-agent.config.json")?.contents;
  if (configSource === undefined) throw new Error(`${template} did not render mono-agent.config.json.`);
  return Object.freeze({ template, config: JSON.parse(configSource) });
});
const configReference = await loadExecutableConfigReference(
  root,
  renderProject,
  typedModulePackages,
);
const outputs = new Map([
  [
    "docs/config/reference.md",
    renderSourceBetaConfigMarkdown(report, renderedProjects, configReference),
  ],
  ["docs/products/index.md", renderSourceBetaProductsMarkdown(report)],
  ["docs/reference/public-api.md", renderSourceBetaPublicApiMarkdown(report)],
  [SOURCE_BETA_REPORT_OUTPUT, renderSourceBetaComplexityMarkdown(report)],
]);

let changed = 0;
const stalePaths = [];
for (const [relativePath, contents] of outputs) {
  const path = join(root, relativePath);
  let current;
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (current === contents) continue;
  changed += 1;
  stalePaths.push(relativePath);
  if (!check) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  }
}

if (check && changed > 0) {
  throw new Error(
    `${String(changed)} generated source-beta documentation file(s) are stale `
    + `(${stalePaths.join(", ")}); run pnpm run generate:source-beta-docs.`,
  );
}
console.log(
  check
    ? `Source-beta documentation is current (${String(outputs.size)} files checked).`
    : `Source-beta documentation generated (${String(changed)} files updated).`,
);

function parseArgs(argv) {
  if (argv.length === 0) return false;
  if (argv.length === 1 && argv[0] === "--check") return true;
  throw new Error("Usage: node --experimental-strip-types scripts/generate-source-beta-docs.mjs [--check]");
}

function isMissing(error) {
  return typeof error === "object" && error !== null && error.code === "ENOENT";
}

function buildExecutableSchemas(repositoryRoot, packageRecords) {
  const selectors = [
    "@mono-agent/core",
    ...packageRecords.map(({ packageName }) => packageName),
  ].sort();
  execFileSync("pnpm", [
    ...selectors.flatMap((selector) => ["--filter", `${selector}...`]),
    "run",
    "build",
  ], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });
}

async function loadExecutableConfigReference(repositoryRoot, render, packageRecords) {
  const typedModules = [];
  for (const record of packageRecords) {
    const namespace = await import(
      pathToFileURL(join(repositoryRoot, record.packagePath, record.importTarget)).href
    );
    const definition = namespace.monoAgentModule;
    if (
      definition === null
      || typeof definition !== "object"
      || definition.manifest?.packageName !== record.packageName
      || definition.manifest?.kind !== record.kind
      || definition.schema === null
      || typeof definition.schema !== "object"
      || definition.schema.jsonSchema === null
      || typeof definition.schema.jsonSchema !== "object"
      || Array.isArray(definition.schema.jsonSchema)
    ) {
      throw new Error(`${record.packageName} did not export its declared executable module schema.`);
    }
    typedModules.push(Object.freeze({
      packageName: record.packageName,
      kind: record.kind,
      jsonSchema: definition.schema.jsonSchema,
    }));
  }

  const core = await import(
    pathToFileURL(join(repositoryRoot, "packages/core/dist/index.js")).href
  );
  if (
    typeof core.loadAgentConfig !== "function"
    || typeof core.composeAgentConfigSchema !== "function"
  ) {
    throw new Error("@mono-agent/core did not export its executable config schema APIs.");
  }
  const project = await materializeSchemaProject(repositoryRoot, render, packageRecords);
  try {
    const loaded = await core.loadAgentConfig(project.configPath, {
      projectRoot: project.root,
      environment: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: "source-beta-schema-claude-token",
        CODEX_API_KEY: "source-beta-schema-codex-token",
        MONO_AGENT_OPENAI_API_KEY: "source-beta-schema-openai-token-000001",
        MONO_AGENT_OPERATOR_TOKEN: "source-beta-schema-operator-token-0000001",
        MONO_AGENT_TELEGRAM_BOT_TOKEN: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
        MONO_AGENT_WEBHOOK_API_KEY: "source-beta-schema-webhook-token-000001",
        MONO_AGENT_WEBHOOK_SIGNATURE_SECRET: "source-beta-schema-signature-secret-000001",
        PERSONAL_AGENT_TELEGRAM_CHAT_ID: "123456789",
        SLACK_APP_TOKEN: "xapp-source-beta-schema-app-token",
        SLACK_BOT_TOKEN: "xoxb-source-beta-schema-bot-token",
        WEBHOOK_API_KEY: "source-beta-schema-minimal-token-000001",
      },
    });
    const coreSchema = await core.composeAgentConfigSchema(loaded);
    return collectExecutableConfigReference({
      coreSchema,
      selectedModules: loaded.modules.map((module) => ({
        configPath: module.configPath,
        kind: module.slot,
      })),
      typedModules,
    });
  } finally {
    await rm(project.root, { recursive: true, force: true });
  }
}

async function materializeSchemaProject(repositoryRoot, render, packageRecords) {
  const nodeModules = join(repositoryRoot, "node_modules");
  const projectRoot = await mkdtemp(join(nodeModules, ".mono-agent-source-beta-schema-"));
  try {
    const files = render({ projectName: "source-beta-schema-reference", template: "personal" });
    for (const file of files) {
      const path = resolve(projectRoot, file.path);
      if (path !== projectRoot && !path.startsWith(`${projectRoot}/`)) {
        throw new Error(`Schema composition project path escapes its root: ${file.path}`);
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.contents, "utf8");
    }

    const dependencyNames = [
      "@mono-agent/cli",
      "@mono-agent/core",
      "@mono-agent/module-sdk",
      ...packageRecords.map(({ packageName }) => packageName),
    ].sort();
    const dependencies = {};
    const packages = {
      "": { dependencies },
    };
    for (const packageName of dependencyNames) {
      const installedRoot = join(repositoryRoot, "node_modules", ...packageName.split("/"));
      const manifestPath = join(installedRoot, "package.json");
      const installed = JSON.parse(await readFile(manifestPath, "utf8"));
      if (typeof installed.version !== "string" || installed.version.length === 0) {
        throw new Error(`${packageName} has no installed version for schema composition.`);
      }
      dependencies[packageName] = installed.version;
      packages[`node_modules/${packageName}`] = { version: installed.version };
      const localRoot = join(projectRoot, "node_modules", ...packageName.split("/"));
      await mkdir(dirname(localRoot), { recursive: true });
      await symlink(installedRoot, localRoot, "dir");
    }
    const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    manifest.dependencies = dependencies;
    await writeFile(
      join(projectRoot, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    const config = allShippedModulesConfig(
      JSON.parse(await readFile(join(projectRoot, "mono-agent.config.json"), "utf8")),
    );
    assertAllTypedModulesSelected(config, packageRecords);
    await writeFile(
      join(projectRoot, "mono-agent.config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(projectRoot, "package-lock.json"),
      `${JSON.stringify({ lockfileVersion: 3, packages }, null, 2)}\n`,
      "utf8",
    );
    return Object.freeze({
      root: projectRoot,
      configPath: join(projectRoot, "mono-agent.config.json"),
    });
  } catch (error) {
    await rm(projectRoot, { recursive: true, force: true });
    throw error;
  }
}

function allShippedModulesConfig(personal) {
  const digest = "0".repeat(64);
  return {
    ...personal,
    runtimes: {
      ...personal.runtimes,
      claude: {
        $use: "@mono-agent/runtime-claude",
        mode: "sdk",
        auth: {
          method: "oauth-token",
          token: { $env: "CLAUDE_CODE_OAUTH_TOKEN" },
        },
      },
      codex: {
        $use: "@mono-agent/runtime-codex",
        auth: { apiKey: { $env: "CODEX_API_KEY" } },
      },
      opencode: {
        $use: "@mono-agent/runtime-opencode",
      },
    },
    routing: {
      primary: { runtime: "claude", model: "claude-sonnet-4" },
      fallbacks: [],
      effort: "high",
    },
    channels: {
      ...personal.channels,
      slack: {
        $use: "@mono-agent/channel-slack",
        appToken: { $env: "SLACK_APP_TOKEN" },
        botToken: { $env: "SLACK_BOT_TOKEN" },
        allowedTeamIds: ["T00000001"],
        allowedChannelIds: ["C00000001"],
      },
    },
    policy: {
      tools: { default: "deny", allow: [] },
      approvals: { default: "allow" },
      sandbox: {
        $use: "@mono-agent/sandbox-srt",
        executable: { path: "/schema-reference/srt", sha256: digest },
        settings: { path: "/schema-reference/settings.json", sha256: digest },
      },
    },
  };
}

function assertAllTypedModulesSelected(config, packageRecords) {
  const selected = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (typeof value.$use === "string") selected.add(value.$use);
    Object.values(value).forEach(visit);
  };
  visit(config);
  const expected = packageRecords.map(({ packageName }) => packageName).sort();
  const actual = [...selected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `All-module Core schema composition selected ${actual.join(", ")}; expected ${expected.join(", ")}.`,
    );
  }
}
