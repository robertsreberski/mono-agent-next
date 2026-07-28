// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const PERSONAL_SUCCESSOR_SCHEMA =
  "mono-agent.personal-successor-blueprint.v1";
export const PERSONAL_SUCCESSOR_PROJECT_TOKEN = "__PROJECT_ROOT__";

export const PERSONAL_SUCCESSOR_DEPENDENCIES = Object.freeze([
  "@mono-agent/channel-openai-api",
  "@mono-agent/channel-operator",
  "@mono-agent/channel-telegram",
  "@mono-agent/channel-webhook",
  "@mono-agent/cli",
  "@mono-agent/core",
  "@mono-agent/docs-mcp",
  "@mono-agent/exporter-otlp",
  "@mono-agent/memory-local",
  "@mono-agent/module-sdk",
  "@mono-agent/operator",
  "@mono-agent/runtime-pi",
  "@mono-agent/service-macos",
  "@mono-agent/state-local",
  "@mono-agent/trigger-cron",
  "@mono-agent/tui",
  "@mono-agent/web",
]);

export const PERSONAL_SUCCESSOR_EXCLUDED_PACKAGES = Object.freeze([
  "@mono-agent/channel-slack",
  "@mono-agent/runtime-claude",
  "@mono-agent/runtime-codex",
  "@mono-agent/runtime-opencode",
  "@mono-agent/sandbox-srt",
  "create-mono-agent",
]);

const EXPECTED_PRODUCTS = Object.freeze({
  agent: "mono-agent.config.json",
  docsMcp: "node_modules/.bin/mono-agent-docs-mcp",
  serviceMacosTemplate: "service-macos.template.json",
  tui: "node_modules/.bin/mono-agent-tui",
  web: "web.config.json",
});

const EXPECTED_PROOFS = Object.freeze({
  browser: "pnpm run test:browser",
  operatorProducts: "pnpm run verify:operator-products",
  packedSystem: "pnpm run verify:system",
  serviceLifecycle: "pnpm --filter @mono-agent/service-macos test",
});

export function readPersonalSuccessorBlueprint(root) {
  const fixtureRoot = join(root, "scripts", "fixtures", "personal-successor");
  const source = readFileSync(join(fixtureRoot, "blueprint.json"), "utf8");
  return {
    fixtureRoot,
    source,
    blueprint: JSON.parse(source),
    sha256: sha256(source),
  };
}

export function assertPersonalSuccessorBlueprint(value, expectedVersion) {
  const blueprint = plainRecord(value, "Personal successor blueprint");
  exact(blueprint.schema, PERSONAL_SUCCESSOR_SCHEMA, "blueprint schema");
  exact(blueprint.template, "personal", "base template");
  exact(blueprint.projectName, "personal-agent-next", "project name");
  exact(blueprint.packageVersion, expectedVersion, "package version");
  exactJson(
    blueprint.directDependencies,
    PERSONAL_SUCCESSOR_DEPENDENCIES,
    "direct dependency roster",
  );
  exactJson(
    blueprint.excludedPackages,
    PERSONAL_SUCCESSOR_EXCLUDED_PACKAGES,
    "excluded package roster",
  );
  exactJson(blueprint.products, EXPECTED_PRODUCTS, "separate product map");
  exactJson(blueprint.proofs, EXPECTED_PROOFS, "proof map");
  const overlap = blueprint.directDependencies.filter((name) =>
    blueprint.excludedPackages.includes(name));
  if (overlap.length > 0) {
    throw new Error(`Personal successor package rosters overlap: ${overlap.join(", ")}`);
  }
  return Object.freeze({
    schema: blueprint.schema,
    template: blueprint.template,
    projectName: blueprint.projectName,
    packageVersion: blueprint.packageVersion,
    directDependencies: Object.freeze([...blueprint.directDependencies]),
    excludedPackages: Object.freeze([...blueprint.excludedPackages]),
    products: Object.freeze({ ...blueprint.products }),
    proofs: Object.freeze({ ...blueprint.proofs }),
  });
}

export function renderPersonalSuccessorProducts(fixtureRoot, projectRoot) {
  if (!isAbsolute(projectRoot)) {
    throw new Error("Personal successor project root must be absolute.");
  }
  const canonicalRoot = resolve(projectRoot);
  const webSource = readFileSync(join(fixtureRoot, "web.config.json"), "utf8");
  const serviceTemplate = readFileSync(
    join(fixtureRoot, "service-macos.template.json"),
    "utf8",
  );
  const serviceSource = serviceTemplate.replaceAll(
    PERSONAL_SUCCESSOR_PROJECT_TOKEN,
    canonicalRoot,
  );
  if (serviceSource.includes(PERSONAL_SUCCESSOR_PROJECT_TOKEN)) {
    throw new Error("Personal successor service template retained a project token.");
  }
  const web = JSON.parse(webSource);
  const serviceMacos = JSON.parse(serviceSource);
  assertWebConfig(web);
  assertServiceConfig(serviceMacos, canonicalRoot);
  return Object.freeze({
    "web.config.json": `${JSON.stringify(web, null, 2)}\n`,
    "service-macos.json": `${JSON.stringify(serviceMacos, null, 2)}\n`,
  });
}

function assertWebConfig(config) {
  exactJson(config, {
    configVersion: 1,
    listen: { host: "127.0.0.1", port: 0 },
    auth: { token: { $env: "MONO_AGENT_WEB_TOKEN" } },
    allowInsecureHttp: false,
    dataDirectory: "./.mono-agent/web",
    agentRegistries: ["./.mono-agent/trace-sources"],
    allowedHosts: [],
    externalOrigins: [],
  }, "web config");
}

function assertServiceConfig(config, root) {
  exactJson(config, {
    configVersion: 1,
    services: {
      "personal-agent-next": {
        target: { kind: "agent", config: join(root, "mono-agent.config.json") },
        startAtLogin: false,
        restartPolicy: "on-failure",
        environmentFile: join(root, ".env"),
        logs: {
          directory: join(root, ".mono-agent", "logs", "agent"),
          maxBytes: 10_485_760,
          retainFiles: 5,
        },
      },
      "personal-agent-next-web": {
        target: { kind: "web", config: join(root, "web.config.json") },
        startAtLogin: false,
        restartPolicy: "on-failure",
        environmentFile: join(root, ".env"),
        logs: {
          directory: join(root, ".mono-agent", "logs", "web"),
          maxBytes: 10_485_760,
          retainFiles: 5,
        },
      },
    },
  }, "service-macos config");
}

function plainRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

function exact(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Personal successor ${label} must be ${JSON.stringify(expected)}.`);
  }
}

function exactJson(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Personal successor ${label} drifted from its exact contract.`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
