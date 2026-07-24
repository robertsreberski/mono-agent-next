#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { packageCatalog, packageRelativePath } from "./package-catalog.mjs";
import { publicExportSpecifiers } from "./release/fixtures/packed-consumer/public-exports.mjs";
import {
  assertFreshPackageOutputs,
  assertLockfileArtifactIntegrities,
  assertProofNodeVersion,
  assertStableGitHead,
  assertTarballSnapshotsStable,
  assertV1PublicExportSpecifiers,
  buildArtifactSetEvidence,
  buildConfigSetEvidence,
  buildInstalledClosure,
  buildTemplateConfigRecord,
  buildV1SystemProofEvidence,
  captureCleanGitHead,
  createFreshProofWorkspace,
  removeFreshProofWorkspace,
  snapshotTarball,
} from "./lib/v1-system-proof.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "0.15.0";
const COMMAND_TIMEOUT_MS = 300_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const EXPECTED_REPLY = "mono-agent-next durable provider fact 7d3f9c";
const MEMORY_QUERY = "packed-memory-query-a41c";
const MEMORY_RECALL_CALL_ID = "packed-memory-recall-call";
const ASK_USER_QUERY = "packed-ask-user-query-b52d";
const ASK_USER_CALL_ID = "packed-ask-user-call";
const ASK_USER_ANSWER = "Keep it concise and avoid jargon.";
const ASK_USER_COMPLETION = "packed AskUser answer observed";
const PERSONAL_WEBHOOK_PROMPT = "Handle this authenticated project webhook request.";
const WEBHOOK_SECRET = "packed-system-webhook-token";
const OPERATOR_SECRET = "packed-system-operator-token-0000000000000001";
const DELIVERY_SECRET = "packed-system-delivery-token";
const TEMPLATE_NAMES = Object.freeze(["minimal", "personal", "multi-runtime"]);

const EXPECTED_PACKAGE_NAMES = Object.freeze([
  "@mono-agent/module-sdk",
  "@mono-agent/core",
  "@mono-agent/cli",
  "@mono-agent/runtime-pi",
  "@mono-agent/runtime-claude",
  "@mono-agent/runtime-codex",
  "@mono-agent/runtime-opencode",
  "@mono-agent/channel-telegram",
  "@mono-agent/channel-slack",
  "@mono-agent/channel-webhook",
  "@mono-agent/channel-openai-api",
  "@mono-agent/channel-operator",
  "@mono-agent/trigger-cron",
  "@mono-agent/memory-local",
  "@mono-agent/state-local",
  "@mono-agent/exporter-otlp",
  "@mono-agent/sandbox-srt",
  "@mono-agent/operator",
  "@mono-agent/tui",
  "@mono-agent/web",
  "create-mono-agent",
  "@mono-agent/docs-mcp",
  "@mono-agent/service-macos",
]);

const FORBIDDEN_PREDECESSOR_PACKAGES = Object.freeze([
  "@mono-agent/agent-app",
  "@mono-agent/agent-runtime",
  "@mono-agent/runtime-adapter",
  "@mono-agent/telegram-adapter",
  "@mono-agent/slack-adapter",
  "@mono-agent/webhook-adapter",
]);

const TEMPLATE_ENVIRONMENT = Object.freeze({
  WEBHOOK_API_KEY: "packed-template-webhook-token",
  CLAUDE_CODE_OAUTH_TOKEN: "packed-template-claude-oauth-token",
  MONO_AGENT_OPENAI_API_KEY: "packed-template-openai-token-0000000001",
  MONO_AGENT_OPERATOR_TOKEN: "packed-template-operator-token-0000000000000001",
  MONO_AGENT_TELEGRAM_BOT_TOKEN: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
  MONO_AGENT_WEBHOOK_API_KEY: "packed-template-personal-webhook-token",
  MONO_AGENT_WEBHOOK_SIGNATURE_SECRET: "packed-template-personal-signature-secret-0001",
  PERSONAL_AGENT_TELEGRAM_CHAT_ID: "123456789",
});

const TEMPLATE_DEPENDENCIES = Object.freeze({
  minimal: Object.freeze([
    "@mono-agent/channel-webhook",
    "@mono-agent/cli",
    "@mono-agent/core",
    "@mono-agent/module-sdk",
    "@mono-agent/runtime-pi",
  ]),
  personal: Object.freeze([
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
  ]),
  "multi-runtime": Object.freeze([
    "@mono-agent/channel-webhook",
    "@mono-agent/cli",
    "@mono-agent/core",
    "@mono-agent/module-sdk",
    "@mono-agent/runtime-claude",
    "@mono-agent/runtime-pi",
  ]),
});

async function main() {
  assertProofNodeVersion();
  assertExactCatalog();

  const sourceInitial = captureCleanGitHead({ repo: REPO_ROOT });
  const workspace = createFreshProofWorkspace({ repo: REPO_ROOT, source: sourceInitial });
  const tarballDirectory = join(workspace.root, "tarballs");
  const consumerDirectory = join(workspace.root, "consumer");
  const scaffoldDirectory = join(workspace.root, "scaffolds");
  let packageRegistry;
  let provider;
  let personalOtlpReceiver;
  let otlpReceiver;
  let deliveryReceiver;
  let proofInputs;
  let proofFailure;

  try {
    await Promise.all([
      mkdir(tarballDirectory, { recursive: true }),
      mkdir(consumerDirectory, { recursive: true }),
      mkdir(scaffoldDirectory, { recursive: true }),
    ]);

    assertFreshPackageOutputs({
      workspace,
      catalog: packageCatalog,
      expectedPackageNames: EXPECTED_PACKAGE_NAMES,
    });
    installFreshCheckout(workspace.checkout);
    buildPackages(workspace.checkout);
    const { tarballs, snapshots, artifacts } = await packPackages(
      tarballDirectory,
      workspace.checkout,
    );
    packageRegistry = await startPackageRegistry(tarballs);
    await installSystemConsumer(consumerDirectory, tarballs, packageRegistry.url);
    const closure = await assertCleanInstalledClosure(consumerDirectory, artifacts);
    await importAllPackages(consumerDirectory);
    await proveDocsMcpPackedClient(
      workspace.checkout,
      tarballs.get("@mono-agent/docs-mcp"),
    );
    const configs = await scaffoldAndValidateTemplates(
      consumerDirectory,
      scaffoldDirectory,
      packageRegistry.url,
    );

    [provider, personalOtlpReceiver, otlpReceiver, deliveryReceiver] = await Promise.all([
      startOpenAiCompatibleProvider(),
      startOtlpReceiver(),
      startOtlpReceiver(),
      startDeliveryReceiver(),
    ]);
    await proveScaffoldFirstTurns(
      scaffoldDirectory,
      provider.baseUrl,
      personalOtlpReceiver.endpoint,
    );
    assertPersonalTemplateOtlpRequests(personalOtlpReceiver.requests);

    await writeSystemFixture(consumerDirectory, {
      providerBaseUrl: provider.baseUrl,
      otlpEndpoint: otlpReceiver.endpoint,
      deliveryEndpoint: deliveryReceiver.endpoint,
    });
    const scenario = await runAsync(
      process.execPath,
      ["system-scenario.mjs", "mono-agent.config.json"],
      consumerDirectory,
      {
        ...process.env,
        SYSTEM_WEBHOOK_TOKEN: WEBHOOK_SECRET,
        SYSTEM_OPERATOR_TOKEN: OPERATOR_SECRET,
        SYSTEM_DELIVERY_TOKEN: DELIVERY_SECRET,
      },
    );
    const scenarioProof = assertScenarioOutput(scenario.stdout);
    assertProviderRequests(provider.requests, scenarioProof);
    assertOtlpRequests(otlpReceiver.requests);
    assertDeliveryRequests(
      deliveryReceiver.requests,
      scenarioProof.expectedCronKey,
      webhookDefaultDestination(deliveryReceiver.endpoint),
    );

    const stableArtifacts = assertTarballSnapshotsStable(snapshots, {
      expectedPackageNames: EXPECTED_PACKAGE_NAMES,
      expectedVersion: VERSION,
    });
    if (stableArtifacts.aggregateSha256 !== artifacts.aggregateSha256) {
      throw new Error("Packed artifact aggregate changed during the system scenario.");
    }
    assertStableGitHead(
      workspace.source,
      captureCleanGitHead({ repo: workspace.checkout }),
      "fresh-checkout execution",
    );
    proofInputs = { artifacts: stableArtifacts, closure, configs };
  } catch (error) {
    proofFailure = error;
  }

  let cleanupFailure;
  try {
    await closeProofResources([
      provider,
      personalOtlpReceiver,
      otlpReceiver,
      deliveryReceiver,
      packageRegistry,
    ]);
  } catch (error) {
    cleanupFailure = error;
  }
  try {
    removeFreshProofWorkspace(workspace);
  } catch (error) {
    cleanupFailure = cleanupFailure === undefined
      ? error
      : new AggregateError(
        [cleanupFailure, error],
        "Packed v1 fixture shutdown and workspace cleanup both failed.",
      );
  }

  if (proofFailure !== undefined || cleanupFailure !== undefined) {
    const failures = [proofFailure, cleanupFailure].filter((error) => error !== undefined);
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, "Packed v1 proof and safe cleanup both failed.");
  }
  if (proofInputs === undefined) throw new Error("Packed v1 proof completed without evidence.");

  const sourceFinal = captureCleanGitHead({ repo: REPO_ROOT });
  const evidence = buildV1SystemProofEvidence({
    sourceInitial,
    sourceFinal,
    nodeVersion: process.versions.node,
    artifacts: proofInputs.artifacts,
    closure: proofInputs.closure,
    configs: proofInputs.configs,
    expectedPackageNames: EXPECTED_PACKAGE_NAMES,
    expectedVersion: VERSION,
    forbiddenNames: FORBIDDEN_PREDECESSOR_PACKAGES,
    expectedTemplates: TEMPLATE_NAMES,
  });
  console.log(JSON.stringify(evidence));
}

async function closeProofResources(resources) {
  const results = await Promise.allSettled(
    resources
      .filter((resource) => resource !== undefined)
      .map((resource) => resource.close()),
  );
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Packed v1 proof could not close all bounded fixture resources.",
    );
  }
}

function assertExactCatalog() {
  const actual = packageCatalog.map((entry) => entry.name);
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_PACKAGE_NAMES)) {
    throw new Error(
      `v1 package catalog must be the exact ordered 23-package roster; found ${actual.length}: ${actual.join(", ")}`,
    );
  }
  for (const entry of packageCatalog) {
    if (entry.publishable !== true) throw new Error(`${entry.name} is not publishable`);
  }
}

function installFreshCheckout(repoRoot) {
  run(
    "pnpm",
    ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"],
    repoRoot,
    offlineEnvironment(),
  );
}

function buildPackages(repoRoot) {
  const args = ["-r", "--sort"];
  for (const packageName of EXPECTED_PACKAGE_NAMES) args.push("--filter", packageName);
  args.push("run", "build");
  run("pnpm", args, repoRoot, offlineEnvironment());
}

async function packPackages(tarballDirectory, repoRoot) {
  const packed = new Map();
  const snapshots = [];
  for (const entry of packageCatalog) {
    const directory = packageRelativePath(entry);
    const result = run(
      "pnpm",
      ["--dir", directory, "pack", "--pack-destination", tarballDirectory, "--json"],
      repoRoot,
      offlineEnvironment(),
    );
    const packResult = parsePackJson(result.stdout);
    if (packResult.name !== entry.name || packResult.version !== VERSION) {
      throw new Error(
        `Packed identity mismatch for ${entry.name}: ${String(packResult.name)}@${String(packResult.version)}`,
      );
    }
    const packedFiles = new Set((packResult.files ?? []).map((file) => file.path));
    for (const required of ["package.json", "README.md", "LICENSE"]) {
      if (!packedFiles.has(required)) throw new Error(`${entry.name} tarball is missing ${required}`);
    }
    const filename = typeof packResult.filename === "string"
      ? packResult.filename
      : `${entry.name.replace(/^@/u, "").replace("/", "-")}-${VERSION}.tgz`;
    const tarballPath = resolve(tarballDirectory, filename);
    const manifest = readPackedManifest(tarballPath);
    const expectedLicense = entry.license ?? "GPL-3.0-only";
    if (manifest.license !== expectedLicense) {
      throw new Error(`${entry.name} packed license must be ${expectedLicense}; found ${String(manifest.license)}`);
    }
    if (JSON.stringify(manifest).includes("workspace:")) {
      throw new Error(`${entry.name} packed manifest still contains a workspace protocol`);
    }
    packed.set(entry.name, tarballPath);
    snapshots.push(snapshotTarball({
      name: entry.name,
      version: packResult.version,
      tarballPath,
      expectedDirectory: tarballDirectory,
    }));
  }
  const artifacts = buildArtifactSetEvidence(snapshots, {
    expectedPackageNames: EXPECTED_PACKAGE_NAMES,
    expectedVersion: VERSION,
  });
  const actualFiles = (await readdir(tarballDirectory)).sort();
  const expectedFiles = artifacts.packages.map((entry) => entry.filename).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `Packed artifact directory must contain exactly ${String(expectedFiles.length)} tarballs; found ${actualFiles.join(", ")}`,
    );
  }
  return { tarballs: packed, snapshots, artifacts };
}

function parsePackJson(output) {
  const start = output.search(/^(?:\{|\[)/mu);
  if (start === -1) throw new Error("pnpm pack did not emit JSON");
  const parsed = JSON.parse(output.slice(start));
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) throw new Error(`pnpm pack emitted ${String(parsed.length)} results`);
    return parsed[0];
  }
  return parsed;
}

async function installSystemConsumer(directory, tarballs, registryUrl) {
  const dependencies = Object.fromEntries(EXPECTED_PACKAGE_NAMES.map((name) => [
    name,
    name === "create-mono-agent" ? `file:${tarballs.get(name)}` : VERSION,
  ]));
  await writeJson(join(directory, "package.json"), {
    name: "mono-agent-next-packed-system-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    engines: { node: ">=22.19.0" },
    dependencies,
  });
  await writeRegistryConfig(directory, registryUrl);
  const environment = installEnvironment();
  await runAsync("pnpm", ["install", "--ignore-scripts", "--no-frozen-lockfile"], directory, environment);
  await runAsync("pnpm", ["install", "--ignore-scripts", "--frozen-lockfile"], directory, environment);
}

async function assertCleanInstalledClosure(directory, artifacts) {
  const lock = await readFile(join(directory, "pnpm-lock.yaml"), "utf8");
  if (lock.includes("workspace:")) throw new Error("Packed consumer lockfile contains a workspace protocol");
  for (const forbidden of FORBIDDEN_PREDECESSOR_PACKAGES) {
    if (lock.includes(forbidden)) {
      throw new Error(`Packed consumer lockfile contains predecessor package ${forbidden}`);
    }
  }
  assertLockfileArtifactIntegrities(parseYaml(lock), artifacts);

  const listedText = run("pnpm", ["list", "--prod", "--depth", "Infinity", "--json"], directory).stdout;
  for (const forbidden of FORBIDDEN_PREDECESSOR_PACKAGES) {
    if (listedText.includes(forbidden)) {
      throw new Error(`Packed consumer installed predecessor package ${forbidden}`);
    }
  }
  const listedPackages = collectPackageNames(JSON.parse(listedText));
  const expectedScoped = EXPECTED_PACKAGE_NAMES.filter((name) => name.startsWith("@mono-agent/")).sort();
  const actualScoped = [...listedPackages].filter((name) => name.startsWith("@mono-agent/")).sort();
  if (JSON.stringify(actualScoped) !== JSON.stringify(expectedScoped)) {
    throw new Error(
      `Packed @mono-agent closure must be exactly ${expectedScoped.join(", ")}; found ${actualScoped.join(", ")}`,
    );
  }
  if (!listedPackages.has("create-mono-agent")) {
    throw new Error("Packed consumer did not install create-mono-agent");
  }

  for (const packageName of EXPECTED_PACKAGE_NAMES) {
    const manifest = await readJson(join(directory, "node_modules", ...packageName.split("/"), "package.json"));
    if (manifest.name !== packageName || manifest.version !== VERSION) {
      throw new Error(`Installed package identity mismatch for ${packageName}`);
    }
  }
  return buildInstalledClosure(listedText, {
    expectedFirstPartyNames: EXPECTED_PACKAGE_NAMES,
    expectedFirstPartyVersion: VERSION,
    forbiddenNames: FORBIDDEN_PREDECESSOR_PACKAGES,
  });
}

function collectPackageNames(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const child of value) collectPackageNames(child, output);
    return output;
  }
  if (value === null || typeof value !== "object") return output;
  if (typeof value.name === "string") output.add(value.name);
  if (typeof value.from === "string") output.add(value.from);
  if (value.dependencies !== null && typeof value.dependencies === "object" && !Array.isArray(value.dependencies)) {
    for (const name of Object.keys(value.dependencies)) output.add(name);
  }
  for (const child of Object.values(value)) collectPackageNames(child, output);
  return output;
}

async function importAllPackages(directory) {
  const specifiers = assertV1PublicExportSpecifiers((
    await Promise.all(EXPECTED_PACKAGE_NAMES.map(async (packageName) => ({
      packageName,
      manifest: await readJson(
        join(directory, "node_modules", ...packageName.split("/"), "package.json"),
      ),
    })))
  ).flatMap(({ packageName, manifest }) => publicExportSpecifiers(packageName, manifest)));
  const path = join(directory, "import-all.mjs");
  await writeFile(path, [
    `const specifiers = ${JSON.stringify(specifiers)};`,
    "for (const specifier of specifiers) {",
    "  const imported = specifier.endsWith('/package.json')",
    "    ? await import(specifier, { with: { type: 'json' } })",
    "    : await import(specifier);",
    "  if (imported === null || typeof imported !== 'object') throw new Error('Invalid import for ' + specifier);",
    "}",
    "process.stdout.write(JSON.stringify({ imported: specifiers }) + '\\n');",
    "",
  ].join("\n"), "utf8");
  const result = await runAsync(process.execPath, [basename(path)], directory);
  const parsed = JSON.parse(result.stdout.trim());
  assertV1PublicExportSpecifiers(parsed.imported);
}

async function proveDocsMcpPackedClient(checkout, tarballPath) {
  if (typeof tarballPath !== "string") {
    throw new Error("Packed docs-mcp artifact is unavailable for the client-registration smoke");
  }
  const result = await runAsync(
    process.execPath,
    [join(checkout, "extras", "docs-mcp", "scripts", "smoke-packed.mjs")],
    checkout,
    {
      ...process.env,
      CI: "1",
      MONO_AGENT_DOCS_MCP_TARBALL: tarballPath,
      NPM_CONFIG_OFFLINE: "true",
      npm_config_offline: "true",
    },
  );
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  const proof = JSON.parse(lines.at(-1) ?? "null");
  if (
    proof?.ok !== true
    || proof.package !== "@mono-agent/docs-mcp"
    || proof.transport !== "packed-stdio"
    || proof.registration !== "mcpServers.mono-agent-docs"
    || proof.artifact !== basename(tarballPath)
  ) {
    throw new Error(`Packed docs-mcp client-registration smoke failed: ${result.stdout}`);
  }
}

async function scaffoldAndValidateTemplates(consumerDirectory, scaffoldDirectory, registryUrl) {
  const create = join(consumerDirectory, "node_modules", ".bin", "create-mono-agent");
  const configRecords = [];
  for (const template of TEMPLATE_NAMES) {
    const target = join(scaffoldDirectory, template);
    const scaffold = run(create, [target, "--template", template], consumerDirectory);
    const event = JSON.parse(scaffold.stdout.trim());
    if (event.event !== "scaffolded" || event.template !== template) {
      throw new Error(`Packed scaffolder returned an invalid ${template} result: ${scaffold.stdout}`);
    }
    const contract = await assertTemplateContract(target, template);
    configRecords.push(buildTemplateConfigRecord({
      template,
      configSource: contract.configSource,
      dependencies: contract.dependencies,
      selectedPackages: contract.selectedPackages,
    }));
    await writeRegistryConfig(target, registryUrl);
    const installEnv = installEnvironment();
    await runAsync("pnpm", ["install", "--ignore-scripts", "--no-frozen-lockfile"], target, installEnv);
    await runAsync("pnpm", ["install", "--ignore-scripts", "--frozen-lockfile"], target, installEnv);
    const cli = join(target, "node_modules", ".bin", "mono-agent");
    const validation = run(
      cli,
      ["validate", "--config", join(target, "mono-agent.config.json"), "--json"],
      target,
      { ...process.env, ...TEMPLATE_ENVIRONMENT },
    );
    assertJsonOk(validation.stdout, `${template} packed validation`);
  }
  return buildConfigSetEvidence(configRecords, { expectedTemplates: TEMPLATE_NAMES });
}

async function assertTemplateContract(directory, template) {
  const expectedDependencies = [...TEMPLATE_DEPENDENCIES[template]].sort();
  const manifest = await readJson(join(directory, "package.json"));
  const actualDependencies = Object.keys(manifest.dependencies ?? {}).sort();
  if (JSON.stringify(actualDependencies) !== JSON.stringify(expectedDependencies)) {
    throw new Error(
      `${template} dependency roster must be ${expectedDependencies.join(", ")}; found ${actualDependencies.join(", ")}`,
    );
  }
  for (const packageName of expectedDependencies) {
    if (manifest.dependencies[packageName] !== VERSION) {
      throw new Error(`${template} must pin ${packageName} to ${VERSION}`);
    }
  }
  const configSource = await readFile(join(directory, "mono-agent.config.json"));
  const config = JSON.parse(configSource.toString("utf8"));
  const expectedUses = expectedDependencies
    .filter((name) => !["@mono-agent/cli", "@mono-agent/core", "@mono-agent/module-sdk"].includes(name))
    .sort();
  const actualUses = collectSelectedPackages(config).sort();
  if (JSON.stringify(actualUses) !== JSON.stringify(expectedUses)) {
    throw new Error(
      `${template} module selection must be ${expectedUses.join(", ")}; found ${actualUses.join(", ")}`,
    );
  }
  if (template === "personal") await assertPersonalTemplateContract(directory, config);
  return {
    configSource,
    dependencies: manifest.dependencies,
    selectedPackages: actualUses,
  };
}

async function assertPersonalTemplateContract(directory, config) {
  const mcp = await readJson(join(directory, ".mcp.json"));
  const expectedMcp = {
    mcpServers: {
      "project-status": {
        type: "stdio",
        command: "node",
        args: ["./tools/project-status-mcp.mjs"],
      },
    },
  };
  if (JSON.stringify(mcp) !== JSON.stringify(expectedMcp)) {
    throw new Error(`Personal template must contain the ordinary project-status MCP fixture: ${JSON.stringify(mcp)}`);
  }
  const mcpSource = await readFile(join(directory, "tools", "project-status-mcp.mjs"), "utf8");
  if (
    !mcpSource.includes('name: "project_status"')
    || !mcpSource.includes("The scaffolded project MCP fixture is available.")
    || mcpSource.includes("@mono-agent/module-sdk")
  ) {
    throw new Error("Personal project MCP must be a real project-owned stdio fixture without module-sdk coupling");
  }
  const cronSource = await readFile(join(directory, "cron", "morning-briefing.md"), "utf8");
  for (const expected of [
    "id: morning-briefing",
    "expression: 30 7 * * *",
    "timezone: Europe/Rome",
    "runtime: pi",
    "model: openai-codex:gpt-5.6-sol",
    "notify: telegram",
    "Do not change files, contact external services",
  ]) {
    if (!cronSource.includes(expected)) {
      throw new Error(`Personal Markdown cron fixture omitted ${JSON.stringify(expected)}`);
    }
  }
  const webhookRoute = await readFile(join(directory, "webhook", "invoke.md"), "utf8");
  for (const expected of [
    "name: invoke",
    "path: /webhook/invoke",
    "enabled: true",
    PERSONAL_WEBHOOK_PROMPT,
  ]) {
    if (!webhookRoute.includes(expected)) {
      throw new Error(`Personal webhook route omitted ${JSON.stringify(expected)}`);
    }
  }
  if (
    config.context?.mcp?.configPath !== "./.mcp.json"
    || config.triggers?.cron?.jobsDirectory !== "./cron"
    || config.observability?.exporters?.phoenix?.$use !== "@mono-agent/exporter-otlp"
    || config.observability.exporters.phoenix.includeSensitiveData !== false
  ) {
    throw new Error("Personal config must select its MCP, Markdown cron, and OTLP surfaces");
  }
  assertExactPersonalConfig(config);
  const channelIds = Object.keys(config.channels ?? {}).sort();
  if (JSON.stringify(channelIds) !== JSON.stringify(["openai-api", "operator", "telegram", "webhook"])) {
    throw new Error(`Personal config must select its exact four process channels; found ${channelIds.join(", ")}`);
  }
  for (const productField of ["tui", "web", "service", "docsMcp"]) {
    if (Object.hasOwn(config, productField)) {
      throw new Error(`Personal agent config must not select the separate ${productField} product`);
    }
  }
}

function assertExactPersonalConfig(config) {
  const agentId = config.agent?.id;
  const agentName = config.agent?.name;
  if (
    typeof agentId !== "string"
    || agentId.length === 0
    || typeof agentName !== "string"
    || agentName.length === 0
  ) {
    throw new Error("Personal config must contain a generated agent identity");
  }
  if (
    config.$schema !== "./.mono-agent/mono-agent.config.schema.json"
    || config.configVersion !== 1
  ) {
    throw new Error("Personal config must retain its schema and config-version contract");
  }
  const env = (name) => ({ $env: name });
  assertExactJson(Object.keys(config).sort(), [
    "$schema",
    "agent",
    "channels",
    "configVersion",
    "context",
    "memory",
    "observability",
    "policy",
    "routing",
    "runtimes",
    "session",
    "state",
    "triggers",
  ], "Personal top-level config shape");
  assertExactJson(config.agent, {
    id: agentId,
    name: agentName,
    instructions: "./AGENTS.md",
    workspace: ".",
  }, "Personal agent contract");
  assertExactJson(config.runtimes, {
    pi: {
      $use: "@mono-agent/runtime-pi",
      auth: { path: "./.secrets/pi/auth.json" },
      sessions: { root: "./.mono-agent/sessions" },
      retry: { maxDelayMs: 30_000 },
      localProviders: [{ id: "ollama", baseUrl: "http://127.0.0.1:11434" }],
    },
  }, "Personal Pi runtime contract");
  assertExactJson(config.routing, {
    primary: { runtime: "pi", model: "openai-codex:gpt-5.6-sol" },
    fallbacks: [
      { runtime: "pi", model: "github-copilot:gemini-3.1-pro-preview" },
      { runtime: "pi", model: "github-copilot:gemini-3.5-flash" },
      { runtime: "pi", model: "opencode-go:kimi-k2.7-code" },
      { runtime: "pi", model: "opencode-go:glm-5.2" },
      { runtime: "pi", model: "anthropic:claude-opus-4-8" },
      { runtime: "pi", model: "anthropic:claude-fable-5" },
      { runtime: "pi", model: "opencode-go:kimi-k2.6" },
      { runtime: "pi", model: "opencode-go:glm-5.1" },
      { runtime: "pi", model: "openai-codex:gpt-5.6-terra" },
    ],
    effort: "high",
  }, "Personal routing contract");
  assertExactJson(config.session, {
    mode: "continuous",
    idleTimeoutMs: 1_800_000,
    rollover: "daily",
    timezone: "Europe/Rome",
    isolateProactiveRuns: true,
  }, "Personal session contract");
  assertExactJson(config.context, {
    skills: {
      roots: ["./skills"],
      load: "all",
      disclosure: "index",
      maxBytes: 96_000,
    },
    mcp: { configPath: "./.mcp.json" },
  }, "Personal context contract");
  assertExactJson(config.memory, {
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
  }, "Personal memory contract");
  assertExactJson(config.state, {
    $use: "@mono-agent/state-local",
    root: "./.mono-agent/state",
    runs: {
      artifactsDirectory: "./.mono-agent/artifacts",
      retentionDays: 30,
    },
    discovery: {
      registryDirectory: "./.mono-agent/trace-sources",
      sourceId: agentId,
      sourceLabel: agentName,
    },
  }, "Personal state contract");
  assertExactJson(config.policy, {
    tools: { default: "allow", deny: [] },
    approvals: { default: "allow" },
    sandbox: { mode: "off" },
  }, "Personal policy contract");
  assertExactJson(config.channels, {
    telegram: {
      $use: "@mono-agent/channel-telegram",
      botToken: env("MONO_AGENT_TELEGRAM_BOT_TOKEN"),
      allowedChatIds: [env("PERSONAL_AGENT_TELEGRAM_CHAT_ID")],
      allowAllChats: false,
      defaultDestination: env("PERSONAL_AGENT_TELEGRAM_CHAT_ID"),
      reactions: { working: true, done: false, error: true },
      quietHours: { start: "23:00", end: "07:00", timezone: "Europe/Rome" },
      transport: { ipFamily: 4 },
      transcription: {
        endpoint: "http://127.0.0.1:50060/v1/audio/transcriptions",
        model: "large-v3-v20240930",
      },
    },
    webhook: {
      $use: "@mono-agent/channel-webhook",
      listen: { host: "100.64.0.10", port: 4313 },
      allowNonLoopback: true,
      apiKey: env("MONO_AGENT_WEBHOOK_API_KEY"),
      signatureSecret: env("MONO_AGENT_WEBHOOK_SIGNATURE_SECRET"),
      routesDirectory: "./webhook",
      defaultMode: "async",
      retentionMs: 300_000,
      maxStoredRequests: 100,
    },
    "openai-api": {
      $use: "@mono-agent/channel-openai-api",
      listen: { host: "0.0.0.0", port: 4312 },
      allowNonLoopback: true,
      basePath: "/v1",
      apiKey: env("MONO_AGENT_OPENAI_API_KEY"),
      modelId: agentId,
    },
    operator: {
      $use: "@mono-agent/channel-operator",
      listen: { host: "127.0.0.1", port: 0 },
      auth: { token: env("MONO_AGENT_OPERATOR_TOKEN") },
    },
  }, "Personal channel contract");
  assertExactJson(config.triggers, {
    cron: {
      $use: "@mono-agent/trigger-cron",
      jobsDirectory: "./cron",
      timezone: "Europe/Rome",
    },
  }, "Personal cron selection");
  assertExactJson(config.observability, {
    exporters: {
      phoenix: {
        $use: "@mono-agent/exporter-otlp",
        endpoint: "http://127.0.0.1:6006/v1/traces",
        projectName: agentId,
        includeSensitiveData: false,
      },
    },
  }, "Personal metadata-only OTLP contract");
}

async function proveScaffoldFirstTurns(scaffoldDirectory, providerBaseUrl, personalOtlpEndpoint) {
  for (const template of TEMPLATE_NAMES) {
    const directory = join(scaffoldDirectory, template);
    const renderedConfigPath = join(directory, "mono-agent.config.json");
    const renderedConfigSource = await readFile(renderedConfigPath, "utf8");
    const renderedConfig = JSON.parse(renderedConfigSource);
    if (template === "personal") await writePersonalProofCron(directory);
    const proofConfig = template === "personal"
      ? hermeticPersonalScaffoldConfig(renderedConfig, providerBaseUrl, personalOtlpEndpoint)
      : hermeticScaffoldConfig(renderedConfig, template, providerBaseUrl);
    const proofConfigName = "mono-agent.verify.config.json";
    await writeJson(
      join(directory, proofConfigName),
      proofConfig,
    );
    const scenarioPath = join(directory, "packed-first-turn.mjs");
    await writeFile(scenarioPath, scaffoldFirstTurnScenarioSource(), "utf8");
    const result = await runAsync(
      process.execPath,
      [basename(scenarioPath), proofConfigName, template],
      directory,
      {
        ...process.env,
        ...TEMPLATE_ENVIRONMENT,
        CLAUDE_CODE_OAUTH_TOKEN: "packed-template-claude-oauth-token",
      },
    );
    const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null");
    if (
      parsed?.ok !== true
      || parsed.template !== template
      || parsed.reply !== EXPECTED_REPLY
      || (
        template === "personal"
        && (
          parsed.firstRunMarker !== "initialized"
          || parsed.personalCron?.status !== "accepted"
          || !isCanonicalInstant(parsed.personalCron?.scheduledAt)
          || parsed.personalCron.idempotencyKey !== cronIdempotencyKey(
            "cron",
            "morning-briefing",
            parsed.personalCron.scheduledAt,
          )
          || parsed.telegramDeliveries !== 1
          || JSON.stringify(parsed.channelIds) !== JSON.stringify([
            "openai-api",
            "operator",
            "telegram",
            "webhook",
          ])
        )
      )
    ) {
      throw new Error(`Packed ${template} first-turn fixture failed: ${result.stdout}`);
    }
    if (await readFile(renderedConfigPath, "utf8") !== renderedConfigSource) {
      throw new Error(`Packed ${template} proof mutated the rendered template config`);
    }
  }
}

async function writePersonalProofCron(directory) {
  const jobsDirectory = join(directory, ".mono-agent", "verify-cron");
  await mkdir(jobsDirectory, { recursive: true });
  await writeFile(join(jobsDirectory, "morning-briefing.md"), `---
id: morning-briefing
expression: 30 7 * * *
timezone: Europe/Rome
runtime: pi
model: packed-local:echo
effort: high
notify: telegram
overlap: skip
maxRunMs: 300000
---

Prepare a concise morning briefing from information already available in this workspace.
Do not change files, contact external services, or perform any other side effect.
`, "utf8");
}

function isCanonicalInstant(value) {
  return typeof value === "string" && new Date(value).toISOString() === value;
}

function cronIdempotencyKey(instanceId, jobId, scheduledAt) {
  const digest = createHash("sha256")
    .update(JSON.stringify([1, instanceId, jobId, scheduledAt]), "utf8")
    .digest("hex");
  return `cron:v1:${digest}`;
}

function hermeticScaffoldConfig(renderedConfig, template, providerBaseUrl) {
  if (template !== "minimal" && template !== "multi-runtime") {
    throw new Error(`Unsupported hermetic scaffold template ${String(template)}`);
  }
  const proof = structuredClone(renderedConfig);
  const selectedBefore = collectSelectedPackages(renderedConfig).sort();
  const pi = proof.runtimes?.pi;
  const inbound = proof.channels?.inbound;
  if (
    pi?.$use !== "@mono-agent/runtime-pi"
    || inbound?.$use !== "@mono-agent/channel-webhook"
    || proof.routing?.primary?.runtime !== "pi"
  ) {
    throw new Error(`${template} proof requires the rendered Pi and webhook selections`);
  }
  if (
    template === "multi-runtime"
    && proof.runtimes?.["claude-sdk"]?.$use !== "@mono-agent/runtime-claude"
  ) {
    throw new Error("Multi-runtime proof requires the rendered Claude runtime selection");
  }
  pi.retry = { maxRetries: 0, maxDelayMs: 0, timeoutMs: 10_000 };
  pi.localProviders = [{
    id: "packed-local",
    baseUrl: providerBaseUrl,
    models: [{ id: "echo", reasoning: true, contextWindow: 16_384, maxTokens: 1_024 }],
  }];
  proof.routing.primary = { ...proof.routing.primary, model: "packed-local:echo" };
  inbound.listen = { ...inbound.listen, port: 0 };
  inbound.maxRunMs = 10_000;
  if (proof.policy?.approvals?.default !== "ask") {
    throw new Error(`${template} rendered approval policy must remain ask during its first turn`);
  }
  const selectedAfter = collectSelectedPackages(proof).sort();
  if (JSON.stringify(selectedAfter) !== JSON.stringify(selectedBefore)) {
    throw new Error(`${template} hermetic proof must retain every rendered module selection`);
  }
  assertScaffoldHermeticOverlay(renderedConfig, proof, template, providerBaseUrl);
  return proof;
}

function hermeticPersonalScaffoldConfig(renderedConfig, providerBaseUrl, otlpEndpoint) {
  const proof = structuredClone(renderedConfig);
  const selectedBefore = collectSelectedPackages(renderedConfig).sort();
  const pi = proof.runtimes?.pi;
  if (pi?.$use !== "@mono-agent/runtime-pi" || !Array.isArray(pi.localProviders)) {
    throw new Error("Personal proof requires the rendered Pi runtime and local-provider registry");
  }
  pi.retry = { maxRetries: 0, maxDelayMs: 0, timeoutMs: 10_000 };
  pi.localProviders = [{
    id: "packed-local",
    baseUrl: providerBaseUrl,
    models: [{ id: "echo", reasoning: true, contextWindow: 16_384, maxTokens: 1_024 }],
  }];
  proof.routing.primary = { runtime: "pi", model: "packed-local:echo" };
  proof.routing.fallbacks = [];
  const memory = proof.memory;
  if (memory?.$use !== "@mono-agent/memory-local" || memory.root !== "./.mono-agent/memory") {
    throw new Error("Personal proof requires the rendered current local-memory root");
  }
  if (
    memory.capture?.enabled !== true
    || typeof memory.capture?.model?.runtime !== "string"
    || typeof memory.capture?.model?.model !== "string"
  ) {
    throw new Error("Personal proof requires the rendered runtime-backed memory capture contract");
  }
  memory.capture = { enabled: false };
  delete memory.embeddings;

  const channels = proof.channels;
  if (
    channels?.telegram?.$use !== "@mono-agent/channel-telegram"
    || channels?.webhook?.$use !== "@mono-agent/channel-webhook"
    || channels?.["openai-api"]?.$use !== "@mono-agent/channel-openai-api"
    || channels?.operator?.$use !== "@mono-agent/channel-operator"
  ) {
    throw new Error("Personal proof requires the rendered four-channel selection");
  }
  channels.telegram.pollSeconds = 1;
  delete channels.telegram.quietHours;
  channels.webhook.listen = { ...channels.webhook.listen, host: "127.0.0.1", port: 0 };
  channels.webhook.allowNonLoopback = false;
  delete channels.webhook.mode;
  channels.webhook.defaultMode = "sync";
  channels.webhook.maxRunMs = 10_000;
  channels["openai-api"].listen = {
    ...channels["openai-api"].listen,
    host: "127.0.0.1",
    port: 0,
  };
  channels["openai-api"].allowNonLoopback = false;
  channels["openai-api"].maxRunMs = 10_000;

  const exporter = proof.observability?.exporters?.phoenix;
  if (
    proof.context?.mcp?.configPath !== "./.mcp.json"
    || proof.triggers?.cron?.jobsDirectory !== "./cron"
    || exporter?.$use !== "@mono-agent/exporter-otlp"
  ) {
    throw new Error("Personal proof requires the rendered MCP, cron, and OTLP selections");
  }
  proof.triggers.cron.jobsDirectory = "./.mono-agent/verify-cron";
  Object.assign(exporter, {
    endpoint: otlpEndpoint,
    flushIntervalMs: 25,
    requestTimeoutMs: 5_000,
    flushTimeoutMs: 5_000,
    stopTimeoutMs: 5_000,
  });
  const selectedAfter = collectSelectedPackages(proof).sort();
  if (JSON.stringify(selectedAfter) !== JSON.stringify(selectedBefore)) {
    throw new Error("Personal hermetic proof must retain every rendered module selection");
  }
  assertPersonalHermeticOverlay(renderedConfig, proof, providerBaseUrl, otlpEndpoint);
  return proof;
}

function scaffoldFirstTurnScenarioSource() {
  return String.raw`import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { createAgentHost } from "@mono-agent/core";

const configPath = resolve(process.argv[2] ?? "mono-agent.config.json");
const template = process.argv[3];
const expectedReply = "mono-agent-next durable provider fact 7d3f9c";
const secret = template === "personal"
  ? process.env.MONO_AGENT_WEBHOOK_API_KEY
  : process.env.WEBHOOK_API_KEY;
assert.ok(secret, "The scaffold webhook token is required");
const signatureSecret = template === "personal"
  ? process.env.MONO_AGENT_WEBHOOK_SIGNATURE_SECRET
  : undefined;
if (template === "personal") {
  assert.ok(
    typeof signatureSecret === "string" && signatureSecret.length >= 32,
    "The Personal scaffold webhook signature secret is required",
  );
}
const nativeFetch = globalThis.fetch;
let telegramDeliveries = 0;
if (template === "personal") globalThis.fetch = telegramFixtureFetch;
let markerPath;
if (template === "personal") {
  const { MEMORY_LOCAL_MARKER_FILENAME } = await import("@mono-agent/memory-local");
  markerPath = join(dirname(configPath), ".mono-agent", "memory", MEMORY_LOCAL_MARKER_FILENAME);
  await assert.rejects(() => access(markerPath), (error) => error?.code === "ENOENT");
}

let host;
try {
  host = await createAgentHost(configPath, { drainTimeoutMs: 5_000, lifecycleTimeoutMs: 5_000 });
  const channelIds = host.startInfo.channels.map((channel) => channel.instanceId).sort();
  const expectedChannelIds = template === "personal"
    ? ["openai-api", "operator", "telegram", "webhook"]
    : ["inbound"];
  assert.deepEqual(channelIds, expectedChannelIds);
  const webhookId = template === "personal" ? "webhook" : "inbound";
  const endpoint = host.startInfo.channels.find((channel) => channel.instanceId === webhookId)?.endpoint;
  assert.equal(typeof endpoint, "string", "scaffold webhook did not expose an endpoint");
  const payload = JSON.stringify({
    text: "packed scaffold " + template + " first turn",
    conversationId: "scaffold-first-turn",
  });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: "Bearer " + secret,
      "content-type": "application/json",
      ...(signatureSecret === undefined
        ? {}
        : {
            "x-mono-agent-signature": "sha256="
              + createHmac("sha256", signatureSecret).update(payload).digest("hex"),
          }),
    },
    body: payload,
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const completed = JSON.parse(body);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.text, expectedReply);
  let personalCron;
  if (template === "personal") {
    const cron = await host.runModuleCommand("cron", "trigger-cron:invoke", {
      jobId: "morning-briefing",
    });
    assert.equal(cron.value.status, "accepted", JSON.stringify(cron.value));
    const cronInstant = cron.value.scheduledAt;
    assert.equal(new Date(cronInstant).toISOString(), cronInstant);
    assert.equal(cron.value.idempotencyKey, personalCronIdempotencyKey(cronInstant));
    assert.equal(telegramDeliveries, 1);
    personalCron = cron.value;
  }
  await host.drain();
  await host.stop();
  host = undefined;

  let firstRunMarker;
  if (markerPath !== undefined) {
    const initialized = await readFile(markerPath, "utf8");
    assert.match(initialized, /^initialized:[0-9a-f-]+\n$/u);
    firstRunMarker = "initialized";

    const interrupted = initialized.replace(/^initialized:/u, "initializing:");
    await writeFile(markerPath, interrupted, { encoding: "utf8", mode: 0o600 });
    await assert.rejects(
      () => createAgentHost(configPath, { drainTimeoutMs: 5_000, lifecycleTimeoutMs: 5_000 }),
      /incomplete|initializ/iu,
    );
    assert.equal(await readFile(markerPath, "utf8"), interrupted);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    template,
    reply: expectedReply,
    channelIds,
    ...(firstRunMarker === undefined ? {} : { firstRunMarker }),
    ...(personalCron === undefined ? {} : { personalCron, telegramDeliveries }),
  }) + "\n");
} finally {
  if (host !== undefined) await host.stop().catch(() => undefined);
}

async function telegramFixtureFetch(input, init) {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (url.origin !== "https://api.telegram.org") return nativeFetch(input, init);
  const method = url.pathname.split("/").at(-1);
  if (method === "getUpdates") {
    await pause(25, init?.signal);
    return telegramResponse([]);
  }
  if (method === "sendMessage") {
    telegramDeliveries += 1;
    return telegramResponse({ message_id: 9_000 + telegramDeliveries });
  }
  return new Response(JSON.stringify({ ok: false, description: "Unsupported fixture method." }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

function telegramResponse(result) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function pause(milliseconds, signal) {
  if (signal?.aborted) return;
  await new Promise((resolvePause) => {
    let timer;
    const done = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolvePause();
    };
    timer = setTimeout(done, milliseconds);
    timer.unref();
    signal?.addEventListener("abort", done, { once: true });
  });
}

function personalCronIdempotencyKey(scheduledAt) {
  const digest = createHash("sha256")
    .update(JSON.stringify([1, "cron", "morning-briefing", scheduledAt]), "utf8")
    .digest("hex");
  return "cron:v1:" + digest;
}
`;
}

function collectSelectedPackages(value, output = []) {
  if (Array.isArray(value)) {
    for (const child of value) collectSelectedPackages(child, output);
    return output;
  }
  if (value === null || typeof value !== "object") return output;
  if (typeof value.$use === "string") output.push(value.$use);
  for (const child of Object.values(value)) collectSelectedPackages(child, output);
  return output;
}

function assertExactJson(actual, expected, label) {
  if (JSON.stringify(canonicalJson(actual)) !== JSON.stringify(canonicalJson(expected))) {
    throw new Error(`${label} drifted from the exact retained decision.`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])]),
  );
}

function assertPersonalHermeticOverlay(rendered, proof, providerBaseUrl, otlpEndpoint) {
  const changes = [];
  collectJsonChanges(rendered, proof, "", changes);
  assertExactJson(changes.sort(), [
    "channels.openai-api.allowNonLoopback",
    "channels.openai-api.listen.host",
    "channels.openai-api.listen.port",
    "channels.openai-api.maxRunMs",
    "channels.telegram.pollSeconds",
    "channels.telegram.quietHours",
    "channels.webhook.allowNonLoopback",
    "channels.webhook.defaultMode",
    "channels.webhook.listen.host",
    "channels.webhook.listen.port",
    "channels.webhook.maxRunMs",
    "memory.capture.enabled",
    "memory.capture.model",
    "memory.capture.timeoutMs",
    "memory.embeddings",
    "observability.exporters.phoenix.endpoint",
    "observability.exporters.phoenix.flushIntervalMs",
    "observability.exporters.phoenix.flushTimeoutMs",
    "observability.exporters.phoenix.requestTimeoutMs",
    "observability.exporters.phoenix.stopTimeoutMs",
    "routing.fallbacks",
    "routing.primary.model",
    "runtimes.pi.localProviders",
    "runtimes.pi.retry.maxDelayMs",
    "runtimes.pi.retry.maxRetries",
    "runtimes.pi.retry.timeoutMs",
    "triggers.cron.jobsDirectory",
  ].sort(), "Personal rendered-to-proof overlay");

  const expected = structuredClone(rendered);
  expected.runtimes.pi.retry = { maxRetries: 0, maxDelayMs: 0, timeoutMs: 10_000 };
  expected.runtimes.pi.localProviders = [{
    id: "packed-local",
    baseUrl: providerBaseUrl,
    models: [{ id: "echo", reasoning: true, contextWindow: 16_384, maxTokens: 1_024 }],
  }];
  expected.routing.primary = { runtime: "pi", model: "packed-local:echo" };
  expected.routing.fallbacks = [];
  expected.memory.capture = { enabled: false };
  delete expected.memory.embeddings;
  expected.channels.telegram.pollSeconds = 1;
  delete expected.channels.telegram.quietHours;
  expected.channels.webhook.listen = { host: "127.0.0.1", port: 0 };
  expected.channels.webhook.allowNonLoopback = false;
  delete expected.channels.webhook.mode;
  expected.channels.webhook.defaultMode = "sync";
  expected.channels.webhook.maxRunMs = 10_000;
  expected.channels["openai-api"].listen = { host: "127.0.0.1", port: 0 };
  expected.channels["openai-api"].allowNonLoopback = false;
  expected.channels["openai-api"].maxRunMs = 10_000;
  expected.triggers.cron.jobsDirectory = "./.mono-agent/verify-cron";
  Object.assign(expected.observability.exporters.phoenix, {
    endpoint: otlpEndpoint,
    flushIntervalMs: 25,
    requestTimeoutMs: 5_000,
    flushTimeoutMs: 5_000,
    stopTimeoutMs: 5_000,
  });
  assertExactJson(proof, expected, "Personal hermetic proof shape");
}

function assertScaffoldHermeticOverlay(rendered, proof, template, providerBaseUrl) {
  const changes = [];
  collectJsonChanges(rendered, proof, "", changes);
  assertExactJson(changes.sort(), [
    "channels.inbound.listen.port",
    "channels.inbound.maxRunMs",
    "routing.primary.model",
    "runtimes.pi.localProviders",
    "runtimes.pi.retry",
  ].sort(), `${template} rendered-to-proof overlay`);

  const expected = structuredClone(rendered);
  expected.runtimes.pi.retry = { maxRetries: 0, maxDelayMs: 0, timeoutMs: 10_000 };
  expected.runtimes.pi.localProviders = [{
    id: "packed-local",
    baseUrl: providerBaseUrl,
    models: [{ id: "echo", reasoning: true, contextWindow: 16_384, maxTokens: 1_024 }],
  }];
  expected.routing.primary = { ...expected.routing.primary, model: "packed-local:echo" };
  expected.channels.inbound.listen = {
    ...expected.channels.inbound.listen,
    port: 0,
  };
  expected.channels.inbound.maxRunMs = 10_000;
  assertExactJson(proof, expected, `${template} hermetic proof shape`);
}

function collectJsonChanges(before, after, path, output) {
  if (
    Array.isArray(before)
    || Array.isArray(after)
    || before === null
    || after === null
    || typeof before !== "object"
    || typeof after !== "object"
  ) {
    if (JSON.stringify(canonicalJson(before)) !== JSON.stringify(canonicalJson(after))) {
      output.push(path);
    }
    return;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    const childPath = path === "" ? key : `${path}.${key}`;
    if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) {
      output.push(childPath);
      continue;
    }
    collectJsonChanges(before[key], after[key], childPath, output);
  }
}

async function writeSystemFixture(directory, endpoints) {
  const cronExpression = dormantCronExpression();
  await Promise.all([
    mkdir(join(directory, "cron"), { recursive: true }),
    mkdir(join(directory, ".mono-agent"), { recursive: true }),
    writeFile(
      join(directory, "AGENTS.md"),
      "# Packed system agent\n\nReturn the provider response without inventing external side effects.\n",
      "utf8",
    ),
    writeFile(join(directory, ".mcp.json"), "{\n  \"mcpServers\": {}\n}\n", "utf8"),
  ]);
  await writeFile(join(directory, "cron", "packed.md"), `---
id: packed-system
expression: ${cronExpression}
timezone: UTC
runtime: pi
model: local:echo
effort: high
notify: webhook
maxRunMs: 10000
---

Run the packed system cron proof.
`, "utf8");
  await writeJson(join(directory, "mono-agent.config.json"), packedSystemConfig(endpoints));
  await writeFile(join(directory, "system-scenario.mjs"), consumerScenarioSource(), "utf8");
}

function dormantCronExpression() {
  const target = new Date(Date.now() + 180 * 24 * 60 * 60 * 1_000);
  return `0 0 ${String(target.getUTCDate())} ${String(target.getUTCMonth() + 1)} *`;
}

function packedSystemConfig({ providerBaseUrl, otlpEndpoint, deliveryEndpoint }) {
  return {
    configVersion: 1,
    agent: {
      id: "packed-system",
      name: "Packed System",
      instructions: "./AGENTS.md",
      workspace: ".",
    },
    runtimes: {
      pi: {
        $use: "@mono-agent/runtime-pi",
        auth: { path: "./.secrets/pi/auth.json" },
        sessions: { root: "./.mono-agent/sessions" },
        retry: { maxRetries: 0, maxDelayMs: 0, timeoutMs: 10_000 },
        localProviders: [{
          id: "local",
          baseUrl: providerBaseUrl,
          models: [{ id: "echo", reasoning: true, contextWindow: 16_384, maxTokens: 1_024 }],
        }],
      },
    },
    routing: {
      primary: { runtime: "pi", model: "local:echo" },
      fallbacks: [],
      effort: "high",
    },
    session: { mode: "continuous" },
    context: { mcp: { configPath: "./.mcp.json" } },
    memory: {
      $use: "@mono-agent/memory-local",
      root: "./.mono-agent/memory",
      maxBytes: 96_000,
      capture: {
        enabled: true,
        model: { runtime: "pi", model: "local:echo" },
        timeoutMs: 10_000,
      },
      recallTool: { enabled: true },
    },
    state: {
      $use: "@mono-agent/state-local",
      root: "./.mono-agent/state",
      runs: {
        artifactsDirectory: "./.mono-agent/artifacts",
        retentionDays: 30,
      },
      discovery: {
        registryDirectory: "./.mono-agent/trace-sources",
        sourceId: "packed-system",
        sourceLabel: "Packed System",
        heartbeatMs: 1_000,
      },
    },
    channels: {
      webhook: {
        $use: "@mono-agent/channel-webhook",
        listen: { host: "127.0.0.1", port: 0 },
        apiKey: { $env: "SYSTEM_WEBHOOK_TOKEN" },
        mode: "sync",
        maxRunMs: 10_000,
        outbound: {
          url: deliveryEndpoint,
          apiKey: { $env: "SYSTEM_DELIVERY_TOKEN" },
          timeoutMs: 5_000,
        },
      },
      operator: {
        $use: "@mono-agent/channel-operator",
        listen: { host: "127.0.0.1", port: 0 },
        auth: { token: { $env: "SYSTEM_OPERATOR_TOKEN" } },
      },
    },
    triggers: {
      cron: {
        $use: "@mono-agent/trigger-cron",
        jobsDirectory: "./cron",
        timezone: "UTC",
      },
    },
    observability: {
      exporters: {
        otlp: {
          $use: "@mono-agent/exporter-otlp",
          endpoint: otlpEndpoint,
          projectName: "packed-system",
          includeSensitiveData: false,
          flushIntervalMs: 25,
          requestTimeoutMs: 5_000,
          flushTimeoutMs: 5_000,
          stopTimeoutMs: 5_000,
        },
      },
    },
    policy: {
      tools: { default: "deny", allow: ["AskUser", "MemoryRecall"] },
      approvals: { default: "allow" },
      sandbox: { mode: "off" },
    },
  };
}

function consumerScenarioSource() {
  return String.raw`import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentHost } from "@mono-agent/core";
import { openMemoryLocal } from "@mono-agent/memory-local";
import {
  OperatorClient,
  createOperatorClientForEntry,
  discoverOperators,
} from "@mono-agent/operator";
import { startWebServer } from "@mono-agent/web";

const EXPECTED_REPLY = "mono-agent-next durable provider fact 7d3f9c";
const MEMORY_QUERY = "packed-memory-query-a41c";
const WEB_TOKEN = "packed-system-web-token-0000000000000001";
const MEMORY_RECALL_CALL_ID = "packed-memory-recall-call";
const ASK_USER_QUERY = "packed-ask-user-query-b52d";
const ASK_USER_CALL_ID = "packed-ask-user-call";
const ASK_USER_ANSWER = "Keep it concise and avoid jargon.";
const ASK_USER_COMPLETION = "packed AskUser answer observed";
const configPath = resolve(process.argv[2] ?? "mono-agent.config.json");
const configDirectory = dirname(configPath);
const webhookSecret = requiredEnvironment("SYSTEM_WEBHOOK_TOKEN");
const operatorSecret = requiredEnvironment("SYSTEM_OPERATOR_TOKEN");
const deliverySecret = requiredEnvironment("SYSTEM_DELIVERY_TOKEN");
let firstHost;
let secondHost;
let webServer;

try {
  firstHost = await createAgentHost(configPath, { drainTimeoutMs: 5000, lifecycleTimeoutMs: 5000 });
  const firstEndpoints = endpoints(firstHost);
  await proveWebhookAuthentication(firstEndpoints.webhook);
  const firstOperator = await proveOperatorSurfaces(firstEndpoints.operator, "packed-system", 2);
  assert.equal(firstOperator.info.agent.id, "packed-system");

  const firstCron = await firstHost.runModuleCommand("cron", "trigger-cron:invoke", {
    jobId: "packed-system",
  });
  assert.equal(firstCron.value.status, "accepted");
  const cronInstant = firstCron.value.scheduledAt;
  assert.equal(new Date(cronInstant).toISOString(), cronInstant);
  assert.equal(firstCron.value.scheduledAt, cronInstant);
  assert.equal(firstCron.value.idempotencyKey, expectedCronIdempotencyKey(cronInstant));

  await stopHost(firstHost, "first host");
  firstHost = undefined;

  secondHost = await createAgentHost(configPath, { drainTimeoutMs: 5000, lifecycleTimeoutMs: 5000 });
  const secondEndpoints = endpoints(secondHost);
  const persisted = await proveOperatorSurfaces(secondEndpoints.operator, "packed-system", 2);
  assert.equal(persisted.replay.messages[0].text, MEMORY_QUERY);

  const operatorFrames = [];
  for await (const frame of persisted.client.streamTurn({
    conversationId: "packed-memory-recall",
    input: { text: MEMORY_QUERY },
  })) {
    operatorFrames.push(frame);
  }
  const completed = operatorFrames.find((frame) => frame.type === "completed");
  assert.ok(completed, "operator turn did not emit a completed frame");
  assert.equal(completed.finalMessage.text, EXPECTED_REPLY);
  const memoryToolCall = operatorFrames.find((frame) =>
    frame.type === "tool_call" && frame.call.name === "MemoryRecall");
  assert.deepEqual(memoryToolCall?.call.input, { query: MEMORY_QUERY });
  const memoryToolResult = operatorFrames.find((frame) =>
    frame.type === "tool_result" && frame.result.callId === MEMORY_RECALL_CALL_ID);
  assert.equal(memoryToolResult?.result.contentOmitted, false);
  assert.ok(JSON.stringify(memoryToolResult?.result.content).includes(EXPECTED_REPLY));
  const recalledReplay = await persisted.client.getReplay("packed-memory-recall");
  assert.equal(recalledReplay.messages.length, 2);
  assert.equal(typeof completed.finalMessage.id, "string");
  assert.equal(completed.finalMessage.id, recalledReplay.messages.at(-1).id);

  webServer = await startWebServer({
    config: {
      configVersion: 1,
      listen: { host: "127.0.0.1", port: 0 },
      auth: { token: WEB_TOKEN },
      dataDirectory: resolve(configDirectory, ".mono-agent", "web-system-proof"),
      agentRegistries: [resolve(configDirectory, ".mono-agent", "trace-sources")],
      externalOrigins: [],
      sourcePath: resolve(configDirectory, "web-system-proof.config.json"),
    },
    environment: process.env,
  });
  const webQuoteProof = await proveWebQuoteIdentity(webServer, persisted.client);
  await webServer.stop();
  webServer = undefined;

  const askFrames = [];
  for await (const frame of persisted.client.streamTurn({
    conversationId: "packed-ask-user",
    input: { text: ASK_USER_QUERY },
  })) {
    askFrames.push(frame);
    if (frame.type === "ask_user") {
      assert.equal(frame.ask.questions.length, 2);
      assert.equal(frame.ask.questions[0].id, "tone");
      assert.equal(frame.ask.questions[1].allowFreeText, true);
      const answered = await persisted.client.answerAsk("packed-ask-user", {
        interactionId: frame.ask.interactionId,
        answers: { tone: ["concise"], notes: [ASK_USER_ANSWER] },
      });
      assert.equal(answered.status, "accepted");
    }
  }
  const askCompleted = askFrames.find((frame) => frame.type === "completed");
  assert.equal(askCompleted?.finalMessage.text, ASK_USER_COMPLETION);
  assert.ok(askFrames.some((frame) =>
    frame.type === "tool_call" && frame.call.name === "AskUser"));
  const askToolResult = askFrames.find((frame) =>
    frame.type === "tool_result" && frame.result.callId === ASK_USER_CALL_ID);
  assert.equal(askToolResult?.result.contentOmitted, false);
  assert.ok(JSON.stringify(askToolResult?.result.content).includes(ASK_USER_ANSWER));
  assert.equal(askFrames.some((frame) => frame.type === "approval"), false);
  assert.equal((await persisted.client.getPendingAsk("packed-ask-user")).ask, null);
  assert.equal((await persisted.client.getReplay("packed-ask-user")).messages.length, 4);

  const duplicate = await secondHost.runModuleCommand("cron", "trigger-cron:invoke", {
    jobId: "packed-system",
    scheduledAt: cronInstant,
  });
  assert.equal(duplicate.value.status, "duplicate");
  assert.match(duplicate.value.reason, /already admitted/u);
  assert.equal(duplicate.value.idempotencyKey, firstCron.value.idempotencyKey);

  await stopHost(secondHost, "second host");
  secondHost = undefined;

  const memory = await openMemoryLocal({
    config: {
      root: "./.mono-agent/memory",
      capture: { enabled: false },
      recallTool: { enabled: true },
    },
    configDirectory,
    dataDirectory: resolve(configDirectory, ".mono-agent", "data", "memory", "memory"),
  });
  try {
    const recalled = await memory.recall({
      query: MEMORY_QUERY,
      limit: 8,
      signal: new AbortController().signal,
    });
    assert.ok(recalled.records.some((record) => record.text.includes(EXPECTED_REPLY)), "Core memory capture was not persisted");
  } finally {
    await within(memory.stop(), 5000, "memory inspection stop");
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    firstCron: firstCron.value,
    duplicateCron: duplicate.value,
    operatorFrames: operatorFrames.map((frame) => frame.type),
    webQuoteProof,
    askFrames: askFrames.map((frame) => frame.type),
  }) + "\n");
} finally {
  if (webServer !== undefined) await within(webServer.stop(), 5000, "web server failure cleanup").catch(() => undefined);
  if (firstHost !== undefined) await within(firstHost.stop(), 5000, "first host failure cleanup").catch(() => undefined);
  if (secondHost !== undefined) await within(secondHost.stop(), 5000, "second host failure cleanup").catch(() => undefined);
}

function endpoints(host) {
  const endpoint = (instanceId) => host.startInfo.channels.find((channel) => channel.instanceId === instanceId)?.endpoint;
  const webhook = endpoint("webhook");
  const operator = endpoint("operator");
  assert.equal(typeof webhook, "string", "webhook did not expose an endpoint");
  assert.equal(typeof operator, "string", "operator did not expose an endpoint");
  return { webhook, operator };
}

async function proveWebhookAuthentication(endpoint) {
  const unauthorized = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: MEMORY_QUERY, conversationId: "packed-system" }),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.text()).includes(webhookSecret), false);

  const authorized = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: "Bearer " + webhookSecret,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: MEMORY_QUERY, conversationId: "packed-system" }),
  });
  const body = await authorized.text();
  assert.equal(authorized.status, 200, body);
  const completed = JSON.parse(body);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.text, EXPECTED_REPLY);
}

async function proveOperatorSurfaces(endpoint, conversationId, expectedMessages) {
  const anonymous = new OperatorClient({ endpoint, requestTimeoutMs: 5000 });
  await assert.rejects(
    () => anonymous.getInfo(),
    (error) => error !== null && typeof error === "object" && error.status === 401,
  );
  const registryDirectory = resolve(configDirectory, ".mono-agent", "trace-sources");
  const entries = await discoverOperators({ registryDirectories: [registryDirectory] });
  assert.equal(entries.length, 1, JSON.stringify(entries));
  const entry = entries[0];
  assert.equal(entry.id, "packed-system");
  assert.equal(entry.label, "Packed System");
  assert.equal(entry.endpoint, endpoint);
  assert.equal(entry.tokenEnvironment, "SYSTEM_OPERATOR_TOKEN");
  assert.equal(entry.stale, false);
  const client = createOperatorClientForEntry(entry, {
    env: process.env,
    requestTimeoutMs: 5000,
  });
  const [info, replay, config, health] = await Promise.all([
    client.getInfo(),
    client.getReplay(conversationId),
    client.getConfig(),
    client.getHealth(),
  ]);
  assert.equal(info.capabilities.replay, true);
  assert.equal(info.capabilities.configView, true);
  assert.equal(info.capabilities.health, true);
  assert.equal(info.capabilities.askUser, true);
  assert.equal(replay.messages.length, expectedMessages);
  assert.equal(config.redacted, true);
  const serializedConfig = JSON.stringify(config.value);
  assert.equal(serializedConfig.includes(webhookSecret), false);
  assert.equal(serializedConfig.includes(operatorSecret), false);
  assert.equal(serializedConfig.includes(deliverySecret), false);
  assert.equal(health.status, "healthy", JSON.stringify(health));
  return { client, info, replay, config, health };
}

async function proveWebQuoteIdentity(server, operator) {
  const createdResponse = await webFetch(server, "api/v1/threads", {
    method: "POST",
    json: { agentId: "packed-system", title: "Authoritative quote identity" },
  });
  const createdBody = await createdResponse.text();
  assert.equal(createdResponse.status, 201, createdBody);
  const thread = JSON.parse(createdBody);
  assert.equal(typeof thread.operatorConversationId, "string");

  const firstTurn = await webFetch(
    server,
    "api/v1/threads/" + encodeURIComponent(thread.id) + "/turns",
    { method: "POST", json: { text: "prove authoritative quote identity" } },
  );
  const firstFrames = await firstTurn.text();
  assert.equal(firstTurn.status, 200, firstFrames);
  assert.equal(parseNdjson(firstFrames).at(-1)?.type, "done");

  const firstDetail = await webJson(
    server,
    "api/v1/threads/" + encodeURIComponent(thread.id),
  );
  const firstAssistant = lastAssistant(firstDetail);
  assert.equal(typeof firstAssistant.operatorMessageId, "string");
  const firstReplay = await operator.getReplay(thread.operatorConversationId);
  assert.equal(firstAssistant.operatorMessageId, firstReplay.messages.at(-1)?.id);

  const quotedTurn = await webFetch(
    server,
    "api/v1/threads/" + encodeURIComponent(thread.id) + "/turns",
    {
      method: "POST",
      json: {
        text: "quote the prior answer",
        quote: {
          conversationId: thread.operatorConversationId,
          messageId: firstAssistant.operatorMessageId,
          text: firstAssistant.text,
        },
      },
    },
  );
  const quotedFrames = await quotedTurn.text();
  assert.equal(quotedTurn.status, 200, quotedFrames);
  assert.equal(parseNdjson(quotedFrames).at(-1)?.type, "done");

  const quotedDetail = await webJson(
    server,
    "api/v1/threads/" + encodeURIComponent(thread.id),
  );
  const quotedAssistant = lastAssistant(quotedDetail);
  assert.equal(typeof quotedAssistant.operatorMessageId, "string");
  assert.notEqual(quotedAssistant.operatorMessageId, firstAssistant.operatorMessageId);
  const quotedReplay = await operator.getReplay(thread.operatorConversationId);
  assert.equal(quotedAssistant.operatorMessageId, quotedReplay.messages.at(-1)?.id);
  return {
    conversationId: thread.operatorConversationId,
    firstMessageId: firstAssistant.operatorMessageId,
    quotedMessageId: quotedAssistant.operatorMessageId,
  };
}

async function webFetch(server, path, options = {}) {
  const headers = new Headers({ authorization: "Bearer " + WEB_TOKEN });
  let body;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  }
  return fetch(new URL(path, server.url), {
    method: options.method ?? "GET",
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

async function webJson(server, path) {
  const response = await webFetch(server, path);
  const body = await response.text();
  assert.equal(response.status, 200, path + " returned " + String(response.status) + ": " + body);
  return JSON.parse(body);
}

function parseNdjson(body) {
  return body.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function lastAssistant(detail) {
  const message = detail?.messages?.filter((entry) => entry.role === "assistant").at(-1);
  assert.ok(message, "web thread has no assistant message");
  return message;
}

async function stopHost(host, label) {
  await within(host.drain(), 5000, label + " drain");
  await within(host.stop(), 5000, label + " stop");
  const health = await host.health();
  assert.equal(health.status, "stopped");
  assert.equal(health.pending, 0);
  assert.equal(health.active, 0);
}

function within(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label + " exceeded " + String(milliseconds) + "ms")), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function expectedCronIdempotencyKey(scheduledAt) {
  const digest = createHash("sha256")
    .update(JSON.stringify([1, "cron", "packed-system", scheduledAt]), "utf8")
    .digest("hex");
  return "cron:v1:" + digest;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(name + " is required");
  return value;
}
`;
}

function assertScenarioOutput(stdout) {
  const lines = stdout.trim().split("\n").filter(Boolean);
  const parsed = JSON.parse(lines.at(-1) ?? "null");
  if (parsed?.ok !== true) throw new Error(`Packed scenario did not report success: ${stdout}`);
  if (parsed.firstCron?.status !== "accepted" || parsed.duplicateCron?.status !== "duplicate") {
    throw new Error(`Packed scenario did not prove trigger persistence: ${stdout}`);
  }
  const cronInstant = parsed.firstCron.scheduledAt;
  if (
    typeof cronInstant !== "string"
    || new Date(cronInstant).toISOString() !== cronInstant
    || parsed.duplicateCron.scheduledAt !== cronInstant
  ) {
    throw new Error(`Packed scenario did not reuse one canonical due cron instant: ${stdout}`);
  }
  const expectedKey = expectedCronIdempotencyKey(cronInstant);
  if (
    parsed.firstCron.idempotencyKey !== expectedKey
    || parsed.duplicateCron.idempotencyKey !== expectedKey
  ) {
    throw new Error(`Packed scenario trigger keys did not match the deterministic event identity: ${stdout}`);
  }
  if (!parsed.operatorFrames?.includes("completed")) {
    throw new Error(`Packed scenario did not complete an operator turn: ${stdout}`);
  }
  if (
    typeof parsed.webQuoteProof?.conversationId !== "string"
    || typeof parsed.webQuoteProof?.firstMessageId !== "string"
    || typeof parsed.webQuoteProof?.quotedMessageId !== "string"
    || parsed.webQuoteProof.firstMessageId === parsed.webQuoteProof.quotedMessageId
  ) {
    throw new Error(`Packed scenario did not prove authoritative web quote identities: ${stdout}`);
  }
  if (!parsed.operatorFrames.includes("tool_call") || !parsed.operatorFrames.includes("tool_result")) {
    throw new Error(`Packed scenario did not stream the MemoryRecall round trip: ${stdout}`);
  }
  if (!parsed.askFrames?.includes("ask_user") || !parsed.askFrames.includes("completed")
    || !parsed.askFrames.includes("tool_call") || !parsed.askFrames.includes("tool_result")) {
    throw new Error(`Packed scenario did not stream the AskUser round trip: ${stdout}`);
  }
  return {
    expectedCronKey: expectedKey,
    webConversationId: parsed.webQuoteProof.conversationId,
    firstWebMessageId: parsed.webQuoteProof.firstMessageId,
  };
}

function assertProviderRequests(requests, scenarioProof) {
  for (const request of requests) {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      throw new Error(`Unexpected provider request: ${JSON.stringify(request)}`);
    }
    if (request.parsed.model !== "echo" || request.parsed.stream !== true) {
      throw new Error(`Provider request did not select the packed local model: ${request.body}`);
    }
  }
  const captureRequests = requests.filter((request) => isStructuredCaptureRequest(request.parsed));
  const userRequests = requests.filter((request) => !isStructuredCaptureRequest(request.parsed));
  if (captureRequests.length !== 6 || userRequests.length !== 12) {
    throw new Error(
      `Fake provider expected twelve agent turns and six memory-capture turns; received ${String(userRequests.length)} and ${String(captureRequests.length)}`,
    );
  }
  const userInputs = userRequests.map((request) => finalProviderUserText(request.parsed));
  const expectedInputs = [
    "packed scaffold minimal first turn",
    `${PERSONAL_WEBHOOK_PROMPT}\n\npacked scaffold personal first turn`,
    "Prepare a concise morning briefing from information already available in this workspace.\nDo not change files, contact external services, or perform any other side effect.",
    "packed scaffold multi-runtime first turn",
    MEMORY_QUERY,
    "Run the packed system cron proof.",
    MEMORY_QUERY,
    MEMORY_QUERY,
    "prove authoritative quote identity",
  ];
  if (JSON.stringify(userInputs.slice(0, expectedInputs.length)) !== JSON.stringify(expectedInputs)) {
    throw new Error(`Packed provider user inputs must begin ${JSON.stringify(expectedInputs)}; found ${JSON.stringify(userInputs)}`);
  }
  const projectedQuote = /^Quoted message \(verified from conversation replay\):\n(.+)\n\nUser message:\nquote the prior answer$/u
    .exec(userInputs[9] ?? "");
  if (projectedQuote === null) {
    throw new Error(`Packed web quote was not projected into the provider input: ${JSON.stringify(userInputs[9])}`);
  }
  const quote = JSON.parse(projectedQuote[1]);
  if (
    quote.conversationId !== scenarioProof.webConversationId
    || quote.messageId !== scenarioProof.firstWebMessageId
    || quote.role !== "assistant"
    || quote.text !== EXPECTED_REPLY
  ) {
    throw new Error(`Packed web quote projection did not preserve authoritative replay identity: ${projectedQuote[1]}`);
  }
  if (JSON.stringify(userInputs.slice(10)) !== JSON.stringify([ASK_USER_QUERY, ASK_USER_QUERY])) {
    throw new Error(`Packed AskUser provider inputs were not exact: ${JSON.stringify(userInputs.slice(10))}`);
  }
  for (const personalRequest of [userRequests[1], userRequests[2]]) {
    if (!JSON.stringify(personalRequest.parsed.tools ?? []).includes("project_status")) {
      throw new Error("Personal provider request did not receive the project-owned MCP tool catalog");
    }
  }
  const memoryRecallRequest = userRequests[6];
  if (!JSON.stringify(memoryRecallRequest.parsed.messages).includes(EXPECTED_REPLY)) {
    throw new Error("Fresh operator conversation did not receive Core-recalled memory in its Pi provider request");
  }
  if (!hasProviderTool(memoryRecallRequest.parsed, "MemoryRecall")) {
    throw new Error("Memory-enabled provider request did not receive the Core-owned MemoryRecall tool");
  }
  const memoryRecallContinuation = userRequests[7];
  const toolResult = memoryRecallContinuation.parsed.messages?.find((message) =>
    message?.role === "tool" && message.tool_call_id === MEMORY_RECALL_CALL_ID);
  if (!hasProviderTool(memoryRecallContinuation.parsed, "MemoryRecall")
    || typeof toolResult?.content !== "string"
    || !toolResult.content.includes(EXPECTED_REPLY)) {
    throw new Error("Pi did not continue after executing MemoryRecall against packed memory-local");
  }
  const askRequest = userRequests[10];
  if (!hasProviderTool(askRequest.parsed, "AskUser")) {
    throw new Error("Operator provider request did not receive the Core-owned AskUser tool");
  }
  const askContinuation = userRequests[11];
  const askResult = askContinuation.parsed.messages?.find((message) =>
    message?.role === "tool" && message.tool_call_id === ASK_USER_CALL_ID);
  if (!hasProviderTool(askContinuation.parsed, "AskUser")
    || typeof askResult?.content !== "string"
    || !askResult.content.includes(ASK_USER_ANSWER)) {
    throw new Error("Pi did not continue after the packed operator answered AskUser");
  }
  const capturedReplies = [];
  for (const request of captureRequests) {
    if (hasProviderTool(request.parsed, "MemoryRecall") || hasProviderTool(request.parsed, "AskUser")) {
      throw new Error("Tool-free memory capture unexpectedly received an interactive Core tool");
    }
    const input = finalProviderUserText(request.parsed);
    if (!input?.startsWith("User: ")) {
      throw new Error(`Memory capture did not receive an exact completed turn: ${JSON.stringify(input)}`);
    }
    if (input.endsWith(`Assistant: ${EXPECTED_REPLY}`)) capturedReplies.push(EXPECTED_REPLY);
    else if (input.endsWith(`Assistant: ${ASK_USER_COMPLETION}`)) capturedReplies.push(ASK_USER_COMPLETION);
    else throw new Error(`Memory capture received an unexpected completion: ${JSON.stringify(input)}`);
  }
  const expectedCapturedReplies = [
    EXPECTED_REPLY,
    EXPECTED_REPLY,
    EXPECTED_REPLY,
    EXPECTED_REPLY,
    EXPECTED_REPLY,
    ASK_USER_COMPLETION,
  ].sort();
  if (JSON.stringify(capturedReplies.sort()) !== JSON.stringify(expectedCapturedReplies)) {
    throw new Error(`Memory capture completions must be ${JSON.stringify(expectedCapturedReplies)}; found ${JSON.stringify(capturedReplies)}`);
  }
}

function isStructuredCaptureRequest(request) {
  return hasProviderTool(request, "mono_agent_structured_output");
}

function hasProviderTool(request, name) {
  return Array.isArray(request?.tools)
    && request.tools.some((tool) => tool?.function?.name === name || tool?.name === name);
}

function finalProviderUserText(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const user = messages.filter((message) => message?.role === "user").at(-1);
  if (typeof user?.content === "string") return user.content;
  if (!Array.isArray(user?.content)) return undefined;
  return user.content.flatMap((part) => typeof part?.text === "string" ? [part.text] : []).join("");
}

function assertOtlpRequests(requests) {
  if (requests.length === 0) throw new Error("Packed OTLP exporter did not reach the receiver");
  for (const request of requests) {
    if (request.method !== "POST" || request.url !== "/v1/traces" || request.bytes === 0) {
      throw new Error(`Invalid packed OTLP request: ${JSON.stringify(otlpRequestSummary(request))}`);
    }
    if (request.contentType !== "application/x-protobuf" || request.project !== "packed-system") {
      throw new Error(`Packed OTLP headers were invalid: ${JSON.stringify(otlpRequestSummary(request))}`);
    }
  }
  const payload = Buffer.concat(requests.map((request) => request.body));
  for (const expected of ["mono-agent-next", "packed-system", "mono_agent.turn.settled"]) {
    if (!payload.includes(Buffer.from(expected, "utf8"))) {
      throw new Error(`Packed OTLP protobuf did not contain expected telemetry identity ${expected}`);
    }
  }
}

function assertPersonalTemplateOtlpRequests(requests) {
  if (requests.length === 0) {
    throw new Error("Personal template OTLP exporter did not reach the offline receiver");
  }
  for (const request of requests) {
    if (
      request.method !== "POST"
      || request.url !== "/v1/traces"
      || request.bytes === 0
      || request.contentType !== "application/x-protobuf"
      || request.project !== "personal"
    ) {
      throw new Error(`Invalid Personal template OTLP request: ${JSON.stringify(otlpRequestSummary(request))}`);
    }
  }
  const payload = Buffer.concat(requests.map((request) => request.body));
  for (const expected of ["personal", "mono_agent.turn.settled"]) {
    if (!payload.includes(Buffer.from(expected, "utf8"))) {
      throw new Error(`Personal template OTLP proof omitted ${expected}`);
    }
  }
}

function otlpRequestSummary({ body: _body, ...summary }) {
  return summary;
}

function assertDeliveryRequests(requests, expectedCronKey, expectedDestination) {
  if (requests.length !== 1) {
    throw new Error(`Atomic trigger delivery expected exactly one request; received ${String(requests.length)}`);
  }
  const request = requests[0];
  if (request.method !== "POST" || request.url !== "/deliver") {
    throw new Error(`Trigger delivery used an unexpected route: ${JSON.stringify(request)}`);
  }
  if (request.authorization !== `Bearer ${DELIVERY_SECRET}`) {
    throw new Error("Trigger delivery did not use the configured outbound bearer token");
  }
  if (
    request.body.idempotencyKey !== request.idempotencyKey
    || request.idempotencyKey !== expectedCronKey
  ) {
    throw new Error(`Trigger delivery used an invalid idempotency key: ${JSON.stringify(request)}`);
  }
  if (request.body.conversationId !== expectedDestination || request.body.text !== EXPECTED_REPLY) {
    throw new Error(`Trigger delivery payload was invalid: ${JSON.stringify(request.body)}`);
  }
}

function webhookDefaultDestination(url) {
  return `webhook:outbound:sha256:${createHash("sha256").update(url, "utf8").digest("hex")}`;
}

function expectedCronIdempotencyKey(scheduledAt) {
  const digest = createHash("sha256")
    .update(JSON.stringify([1, "cron", "packed-system", scheduledAt]), "utf8")
    .digest("hex");
  return `cron:v1:${digest}`;
}

async function startPackageRegistry(tarballs) {
  const packages = new Map();
  for (const packageName of EXPECTED_PACKAGE_NAMES.filter((name) => name.startsWith("@mono-agent/"))) {
    const tarballPath = tarballs.get(packageName);
    if (tarballPath === undefined) throw new Error(`Missing packed tarball for ${packageName}`);
    const bytes = await readFile(tarballPath);
    packages.set(packageName, {
      bytes,
      manifest: readPackedManifest(tarballPath),
      shasum: createHash("sha1").update(bytes).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    });
  }

  let registryUrl;
  const server = createServer((request, response) => {
    try {
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET" });
        response.end();
        return;
      }
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://registry.invalid").pathname);
      if (pathname.startsWith("/tarballs/") && pathname.endsWith(".tgz")) {
        const packageName = pathname.slice("/tarballs/".length, -".tgz".length);
        const entry = packages.get(packageName);
        if (entry === undefined) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, {
          "content-length": String(entry.bytes.length),
          "content-type": "application/octet-stream",
        });
        response.end(entry.bytes);
        return;
      }
      const packageName = pathname.replace(/^\//u, "");
      const entry = packages.get(packageName);
      if (entry === undefined || registryUrl === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const tarball = `${registryUrl}tarballs/${packageName}.tgz`;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        name: packageName,
        "dist-tags": { latest: VERSION },
        versions: {
          [VERSION]: {
            ...entry.manifest,
            dist: { tarball, shasum: entry.shasum, integrity: entry.integrity },
          },
        },
      }));
    } catch {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "registry fixture failed" }));
    }
  });
  const baseUrl = await listenLoopback(server, "Package registry fixture");
  registryUrl = `${baseUrl}/`;
  return { url: registryUrl, close: () => closeServer(server) };
}

function readPackedManifest(tarballPath) {
  const result = spawnSync("tar", ["-xOf", tarballPath, "package/package.json"], {
    encoding: "utf8",
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Could not read packed manifest from ${tarballPath}: ${result.stderr ?? result.error?.message}`);
  }
  return JSON.parse(result.stdout);
}

async function startOpenAiCompatibleProvider() {
  const requests = [];
  let memoryRecallPrompts = 0;
  const server = createServer(async (request, response) => {
    try {
      const body = await readRequestBody(request);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      requests.push({ url: request.url, method: request.method, body, parsed });
      if (
        request.method !== "POST"
        || request.url !== "/v1/chat/completions"
        || parsed?.model !== "echo"
        || parsed?.stream !== true
      ) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unexpected request" } }));
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      });
      const id = `chatcmpl-packed-system-${String(requests.length)}`;
      const created = Math.floor(Date.now() / 1_000);
      response.write(sse({
        id,
        object: "chat.completion.chunk",
        created,
        model: "echo",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      }));
      if (isStructuredCaptureRequest(parsed)) {
        const capturedTurn = finalProviderUserText(parsed);
        if (typeof capturedTurn !== "string" || capturedTurn.length === 0) {
          throw new Error("structured capture request did not contain a completed turn");
        }
        response.write(sse({
          id,
          object: "chat.completion.chunk",
          created,
          model: "echo",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: `memory-capture-${String(requests.length)}`,
                type: "function",
                function: {
                  name: "mono_agent_structured_output",
                  arguments: JSON.stringify({ records: [{ text: capturedTurn }] }),
                },
              }],
            },
            finish_reason: null,
          }],
        }));
        response.write(sse({
          id,
          object: "chat.completion.chunk",
          created,
          model: "echo",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
        }));
        response.end("data: [DONE]\n\n");
        return;
      }
      const hasMemoryResult = parsed.messages?.some((message) =>
        message?.role === "tool" && message.tool_call_id === MEMORY_RECALL_CALL_ID);
      const hasAskUserResult = parsed.messages?.some((message) =>
        message?.role === "tool" && message.tool_call_id === ASK_USER_CALL_ID);
      if (!hasAskUserResult
        && finalProviderUserText(parsed) === ASK_USER_QUERY
        && hasProviderTool(parsed, "AskUser")) {
        response.write(sse({
          id,
          object: "chat.completion.chunk",
          created,
          model: "echo",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: ASK_USER_CALL_ID,
                type: "function",
                function: {
                  name: "AskUser",
                  arguments: JSON.stringify({
                    questions: [{
                      id: "tone",
                      prompt: "Which tone should I use?",
                      choices: [
                        { value: "concise", label: "Concise", description: "Keep it short." },
                        { value: "detailed", label: "Detailed" },
                      ],
                      allowFreeText: false,
                      multiple: false,
                    }, {
                      id: "notes",
                      prompt: "Any other constraints?",
                      allowFreeText: true,
                      multiple: false,
                    }],
                  }),
                },
              }],
            },
            finish_reason: null,
          }],
        }));
        response.write(sse({
          id,
          object: "chat.completion.chunk",
          created,
          model: "echo",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
        }));
        response.end("data: [DONE]\n\n");
        return;
      }
      if (!hasMemoryResult
        && finalProviderUserText(parsed) === MEMORY_QUERY
        && hasProviderTool(parsed, "MemoryRecall")
        && ++memoryRecallPrompts === 2) {
        response.write(sse({
          id,
          object: "chat.completion.chunk",
          created,
          model: "echo",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: MEMORY_RECALL_CALL_ID,
                type: "function",
                function: {
                  name: "MemoryRecall",
                  arguments: JSON.stringify({ query: MEMORY_QUERY }),
                },
              }],
            },
            finish_reason: null,
          }],
        }));
        response.write(sse({
          id,
          object: "chat.completion.chunk",
          created,
          model: "echo",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
        }));
        response.end("data: [DONE]\n\n");
        return;
      }
      response.write(sse({
        id,
        object: "chat.completion.chunk",
        created,
        model: "echo",
        choices: [{ index: 0, delta: { content: hasAskUserResult ? ASK_USER_COMPLETION : EXPECTED_REPLY }, finish_reason: null }],
      }));
      response.write(sse({
        id,
        object: "chat.completion.chunk",
        created,
        model: "echo",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
      }));
      response.end("data: [DONE]\n\n");
    } catch {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "provider fixture failed" } }));
    }
  });
  const baseUrl = await listenLoopback(server, "Provider fixture");
  return { baseUrl, requests, close: () => closeServer(server) };
}

async function startOtlpReceiver() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const bytes = await readRequestBytes(request);
    requests.push({
      method: request.method,
      url: request.url,
      bytes: bytes.byteLength,
      contentType: request.headers["content-type"],
      project: request.headers["x-project-name"],
      body: bytes,
    });
    if (request.method !== "POST" || request.url !== "/v1/traces") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const baseUrl = await listenLoopback(server, "OTLP receiver fixture");
  return { endpoint: `${baseUrl}/v1/traces`, requests, close: () => closeServer(server) };
}

async function startDeliveryReceiver() {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const text = await readRequestBody(request);
      const body = JSON.parse(text);
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        idempotencyKey: request.headers["idempotency-key"],
        body,
      });
      if (request.method !== "POST" || request.url !== "/deliver") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ messageId: "packed-delivery-1" }));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid delivery" }));
    }
  });
  const baseUrl = await listenLoopback(server, "Delivery receiver fixture");
  return { endpoint: `${baseUrl}/deliver`, requests, close: () => closeServer(server) };
}

function sse(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

async function listenLoopback(server, label) {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error(`${label} did not bind a TCP port`);
  return `http://127.0.0.1:${String(address.port)}`;
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolvePromise) => server.close(resolvePromise));
}

async function readRequestBody(request) {
  return (await readRequestBytes(request)).toString("utf8");
}

async function readRequestBytes(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function writeRegistryConfig(directory, registryUrl) {
  await writeFile(join(directory, ".npmrc"), `@mono-agent:registry=${registryUrl}\n`, "utf8");
}

function installEnvironment() {
  return {
    ...process.env,
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    NPM_CONFIG_USERCONFIG: "/dev/null",
  };
}

function offlineEnvironment() {
  return {
    ...process.env,
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_FROZEN_LOCKFILE: "true",
    npm_config_offline: "true",
    npm_config_frozen_lockfile: "true",
  };
}

function assertJsonOk(output, label) {
  const parsed = JSON.parse(output.trim());
  if (parsed.ok !== true) throw new Error(`${label} did not report ok: ${output}`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function run(command, args, cwd, environment = process.env) {
  console.log(`$ ${basename(command)} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${basename(command)} ${args.join(" ")} failed (${String(result.status)}): ${result.error?.message ?? detail}`,
    );
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runAsync(command, args, cwd, environment = process.env) {
  console.log(`$ ${basename(command)} ${args.join(" ")}`);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer;
    let finalTimer;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), SHUTDOWN_TIMEOUT_MS);
      finalTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          rejectPromise(new Error(
            `${basename(command)} ${args.join(" ")} exceeded ${String(COMMAND_TIMEOUT_MS)}ms and did not exit`,
          ));
        }
      }, SHUTDOWN_TIMEOUT_MS * 2);
    }, COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(finalTimer);
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(finalTimer);
      if (timedOut) {
        rejectPromise(new Error(`${basename(command)} ${args.join(" ")} exceeded ${String(COMMAND_TIMEOUT_MS)}ms`));
        return;
      }
      if (code === 0 && signal === null) {
        resolvePromise({ stdout, stderr });
        return;
      }
      rejectPromise(new Error(
        `${basename(command)} ${args.join(" ")} failed (${String(code)}/${String(signal)}): ${stderr || stdout}`,
      ));
    });
  });
}

await main();
