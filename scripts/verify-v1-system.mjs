#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packageCatalog, packageRelativePath } from "./package-catalog.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "0.15.0";
const COMMAND_TIMEOUT_MS = 300_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const EXPECTED_REPLY = "mono-agent-next durable provider fact 7d3f9c";
const MEMORY_QUERY = "packed-memory-query-a41c";
const WEBHOOK_SECRET = "packed-system-webhook-token";
const OPERATOR_SECRET = "packed-system-operator-token-0000000000000001";
const DELIVERY_SECRET = "packed-system-delivery-token";
const FIXED_CRON_INSTANT = "2031-02-03T04:05:00.000Z";

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
  MONO_AGENT_OPENAI_API_KEY: "packed-template-openai-token",
  MONO_AGENT_OPERATOR_TOKEN: "packed-template-operator-token-0000000000000001",
  MONO_AGENT_TELEGRAM_BOT_TOKEN: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
  MONO_AGENT_WEBHOOK_API_KEY: "packed-template-personal-webhook-token",
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
  assertSupportedNode();
  assertExactCatalog();

  const authoredTemporaryRoot = await mkdtemp(join(tmpdir(), "mono-agent-v1-system-"));
  const temporaryRoot = await realpath(authoredTemporaryRoot);
  const tarballDirectory = join(temporaryRoot, "tarballs");
  const consumerDirectory = join(temporaryRoot, "consumer");
  const scaffoldDirectory = join(temporaryRoot, "scaffolds");
  let packageRegistry;
  let provider;
  let otlpReceiver;
  let deliveryReceiver;

  try {
    await Promise.all([
      mkdir(tarballDirectory, { recursive: true }),
      mkdir(consumerDirectory, { recursive: true }),
      mkdir(scaffoldDirectory, { recursive: true }),
    ]);

    buildPackages();
    const tarballs = packPackages(tarballDirectory);
    packageRegistry = await startPackageRegistry(tarballs);
    await installSystemConsumer(consumerDirectory, tarballs, packageRegistry.url);
    await assertCleanInstalledClosure(consumerDirectory);
    await importAllPackages(consumerDirectory);
    await scaffoldAndValidateTemplates(consumerDirectory, scaffoldDirectory, packageRegistry.url);

    [provider, otlpReceiver, deliveryReceiver] = await Promise.all([
      startOpenAiCompatibleProvider(),
      startOtlpReceiver(),
      startDeliveryReceiver(),
    ]);

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
    assertScenarioOutput(scenario.stdout);
    assertProviderRequests(provider.requests);
    assertOtlpRequests(otlpReceiver.requests);
    assertDeliveryRequests(deliveryReceiver.requests);

    console.log(
      `Verified exact ${String(EXPECTED_PACKAGE_NAMES.length)}-package packed v1: clean install/import, all templates, Core/Pi/state/memory/webhook/operator/cron/OTLP, restart persistence, atomic trigger delivery, and bounded shutdown on Node.js ${process.versions.node}.`,
    );
  } finally {
    await Promise.allSettled([
      provider?.close(),
      otlpReceiver?.close(),
      deliveryReceiver?.close(),
      packageRegistry?.close(),
    ]);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function assertSupportedNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`Packed v1 proof requires Node.js >=22.19.0; current runtime is ${process.versions.node}`);
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

function buildPackages() {
  const args = ["-r", "--sort"];
  for (const packageName of EXPECTED_PACKAGE_NAMES) args.push("--filter", packageName);
  args.push("run", "build");
  run("pnpm", args, REPO_ROOT);
}

function packPackages(tarballDirectory) {
  const packed = new Map();
  for (const entry of packageCatalog) {
    const directory = packageRelativePath(entry);
    const result = run(
      "pnpm",
      ["--dir", directory, "pack", "--pack-destination", tarballDirectory, "--json"],
      REPO_ROOT,
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
  }
  return packed;
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

async function assertCleanInstalledClosure(directory) {
  const lock = await readFile(join(directory, "pnpm-lock.yaml"), "utf8");
  if (lock.includes("workspace:")) throw new Error("Packed consumer lockfile contains a workspace protocol");
  for (const forbidden of FORBIDDEN_PREDECESSOR_PACKAGES) {
    if (lock.includes(forbidden)) {
      throw new Error(`Packed consumer lockfile contains predecessor package ${forbidden}`);
    }
  }

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
  const path = join(directory, "import-all.mjs");
  await writeFile(path, [
    `const packages = ${JSON.stringify(EXPECTED_PACKAGE_NAMES)};`,
    "for (const packageName of packages) {",
    "  const imported = await import(packageName);",
    "  if (imported === null || typeof imported !== 'object') throw new Error('Invalid import for ' + packageName);",
    "}",
    "process.stdout.write(JSON.stringify({ imported: packages }) + '\\n');",
    "",
  ].join("\n"), "utf8");
  const result = await runAsync(process.execPath, [basename(path)], directory);
  const parsed = JSON.parse(result.stdout.trim());
  if (JSON.stringify(parsed.imported) !== JSON.stringify(EXPECTED_PACKAGE_NAMES)) {
    throw new Error("Packed import proof did not cover the exact v1 package roster");
  }
}

async function scaffoldAndValidateTemplates(consumerDirectory, scaffoldDirectory, registryUrl) {
  const create = join(consumerDirectory, "node_modules", ".bin", "create-mono-agent");
  for (const template of ["minimal", "personal", "multi-runtime"]) {
    const target = join(scaffoldDirectory, template);
    const scaffold = run(create, [target, "--template", template], consumerDirectory);
    const event = JSON.parse(scaffold.stdout.trim());
    if (event.event !== "scaffolded" || event.template !== template) {
      throw new Error(`Packed scaffolder returned an invalid ${template} result: ${scaffold.stdout}`);
    }
    await assertTemplateContract(target, template);
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
  const config = await readJson(join(directory, "mono-agent.config.json"));
  const expectedUses = expectedDependencies
    .filter((name) => !["@mono-agent/cli", "@mono-agent/core", "@mono-agent/module-sdk"].includes(name))
    .sort();
  const actualUses = collectSelectedPackages(config).sort();
  if (JSON.stringify(actualUses) !== JSON.stringify(expectedUses)) {
    throw new Error(
      `${template} module selection must be ${expectedUses.join(", ")}; found ${actualUses.join(", ")}`,
    );
  }
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
notify:
  channel: webhook
  destination: packed-system-destination
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
          models: [{ id: "echo", contextWindow: 16_384, maxTokens: 1_024 }],
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
      directory: "./.mono-agent/memory",
      capture: { mode: "direct" },
    },
    state: {
      $use: "@mono-agent/state-local",
      root: "./.mono-agent/state",
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
      tools: { default: "deny", allow: [] },
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

const EXPECTED_REPLY = "mono-agent-next durable provider fact 7d3f9c";
const MEMORY_QUERY = "packed-memory-query-a41c";
const FIXED_CRON_INSTANT = "2031-02-03T04:05:00.000Z";
const configPath = resolve(process.argv[2] ?? "mono-agent.config.json");
const configDirectory = dirname(configPath);
const webhookSecret = requiredEnvironment("SYSTEM_WEBHOOK_TOKEN");
const operatorSecret = requiredEnvironment("SYSTEM_OPERATOR_TOKEN");
const deliverySecret = requiredEnvironment("SYSTEM_DELIVERY_TOKEN");
let firstHost;
let secondHost;

try {
  firstHost = await createAgentHost(configPath, { drainTimeoutMs: 5000, lifecycleTimeoutMs: 5000 });
  const firstEndpoints = endpoints(firstHost);
  await proveWebhookAuthentication(firstEndpoints.webhook);
  const firstOperator = await proveOperatorSurfaces(firstEndpoints.operator, "packed-system", 2);
  assert.equal(firstOperator.info.agent.id, "packed-system");

  const firstCron = await firstHost.runModuleCommand("cron", "trigger-cron:invoke", {
    jobId: "packed-system",
    scheduledAt: FIXED_CRON_INSTANT,
  });
  assert.equal(firstCron.value.status, "accepted");
  assert.equal(firstCron.value.idempotencyKey, expectedCronIdempotencyKey());

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
  const recalledReplay = await persisted.client.getReplay("packed-memory-recall");
  assert.equal(recalledReplay.messages.length, 2);

  const duplicate = await secondHost.runModuleCommand("cron", "trigger-cron:invoke", {
    jobId: "packed-system",
    scheduledAt: FIXED_CRON_INSTANT,
  });
  assert.equal(duplicate.value.status, "rejected");
  assert.equal(duplicate.value.reason, "duplicate trigger event");
  assert.equal(duplicate.value.idempotencyKey, firstCron.value.idempotencyKey);

  await stopHost(secondHost, "second host");
  secondHost = undefined;

  const memory = await openMemoryLocal({
    config: { directory: "./.mono-agent/memory", capture: { mode: "direct" } },
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
  }) + "\n");
} finally {
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
  assert.equal(replay.messages.length, expectedMessages);
  assert.equal(config.redacted, true);
  const serializedConfig = JSON.stringify(config.value);
  assert.equal(serializedConfig.includes(webhookSecret), false);
  assert.equal(serializedConfig.includes(operatorSecret), false);
  assert.equal(serializedConfig.includes(deliverySecret), false);
  assert.equal(health.status, "healthy", JSON.stringify(health));
  return { client, info, replay, config, health };
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

function expectedCronIdempotencyKey() {
  const digest = createHash("sha256")
    .update(JSON.stringify([1, "cron", "packed-system", FIXED_CRON_INSTANT]), "utf8")
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
  if (parsed.firstCron?.status !== "accepted" || parsed.duplicateCron?.status !== "rejected") {
    throw new Error(`Packed scenario did not prove trigger persistence: ${stdout}`);
  }
  const expectedKey = expectedCronIdempotencyKey();
  if (
    parsed.firstCron.idempotencyKey !== expectedKey
    || parsed.duplicateCron.idempotencyKey !== expectedKey
  ) {
    throw new Error(`Packed scenario trigger keys did not match the deterministic event identity: ${stdout}`);
  }
  if (!parsed.operatorFrames?.includes("completed")) {
    throw new Error(`Packed scenario did not complete an operator turn: ${stdout}`);
  }
}

function assertProviderRequests(requests) {
  if (requests.length !== 3) {
    throw new Error(`Fake provider expected exactly three turns; received ${String(requests.length)}`);
  }
  for (const request of requests) {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      throw new Error(`Unexpected provider request: ${JSON.stringify(request)}`);
    }
    if (request.parsed.model !== "echo" || request.parsed.stream !== true) {
      throw new Error(`Provider request did not select the packed local model: ${request.body}`);
    }
  }
  const userInputs = requests.map((request) => finalProviderUserText(request.parsed));
  const expectedInputs = [MEMORY_QUERY, "Run the packed system cron proof.", MEMORY_QUERY];
  if (JSON.stringify(userInputs) !== JSON.stringify(expectedInputs)) {
    throw new Error(`Packed provider user inputs must be ${JSON.stringify(expectedInputs)}; found ${JSON.stringify(userInputs)}`);
  }
  const memoryRecallRequest = requests[2];
  if (!JSON.stringify(memoryRecallRequest.parsed.messages).includes(EXPECTED_REPLY)) {
    throw new Error("Fresh operator conversation did not receive Core-recalled memory in its Pi provider request");
  }
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

function otlpRequestSummary({ body: _body, ...summary }) {
  return summary;
}

function assertDeliveryRequests(requests) {
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
    || request.idempotencyKey !== expectedCronIdempotencyKey()
  ) {
    throw new Error(`Trigger delivery used an invalid idempotency key: ${JSON.stringify(request)}`);
  }
  if (request.body.conversationId !== "packed-system-destination" || request.body.text !== EXPECTED_REPLY) {
    throw new Error(`Trigger delivery payload was invalid: ${JSON.stringify(request.body)}`);
  }
}

function expectedCronIdempotencyKey() {
  const digest = createHash("sha256")
    .update(JSON.stringify([1, "cron", "packed-system", FIXED_CRON_INSTANT]), "utf8")
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
      response.write(sse({
        id,
        object: "chat.completion.chunk",
        created,
        model: "echo",
        choices: [{ index: 0, delta: { content: EXPECTED_REPLY }, finish_reason: null }],
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
