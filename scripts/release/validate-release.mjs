#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MINIMUM_NODE_VERSION, SUPPORTED_NODE_ENGINE } from "../node-version.mjs";

import {
  DEPENDENCY_SECTIONS,
  REPO_ROOT,
  discoverPackages,
  publishablePackages,
  sortForPublish,
} from "./package-graph.mjs";
import { releaseDependencyPinIssues } from "./dependency-policy.mjs";

const TAG_RE = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)$/;
const ROOT_DEPENDENCY_SECTIONS = [
  ...DEPENDENCY_SECTIONS,
  "devDependencies",
];
const PACKAGE_PIN_SECTIONS = ROOT_DEPENDENCY_SECTIONS;
export const RELEASE_REPOSITORY = Object.freeze({
  type: "git",
  url: "git+https://github.com/robertsreberski/mono-agent-next.git",
});
export const SOURCE_BETA_RELEASE_PACKAGE_NAMES = Object.freeze([
  "@mono-agent/channel-openai-api",
  "@mono-agent/channel-operator",
  "@mono-agent/channel-slack",
  "@mono-agent/channel-telegram",
  "@mono-agent/channel-webhook",
  "@mono-agent/cli",
  "@mono-agent/core",
  "@mono-agent/docs-mcp",
  "@mono-agent/exporter-otlp",
  "@mono-agent/memory-local",
  "@mono-agent/module-sdk",
  "@mono-agent/operator",
  "@mono-agent/runtime-claude",
  "@mono-agent/runtime-codex",
  "@mono-agent/runtime-opencode",
  "@mono-agent/runtime-pi",
  "@mono-agent/sandbox-srt",
  "@mono-agent/service-macos",
  "@mono-agent/state-local",
  "@mono-agent/trigger-cron",
  "@mono-agent/tui",
  "@mono-agent/web",
  "create-mono-agent",
]);

function argValue(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] || null;
}

function rel(filePath) {
  return filePath ? path.relative(REPO_ROOT, filePath) || "." : "(unknown manifest)";
}

export function releaseVersionFromTag(tag) {
  const match = TAG_RE.exec(tag || "");
  if (!match) {
    throw new Error(`release tag must look like v1.2.3 or v1.2.3-beta.1; received ${tag || "(missing)"}`);
  }
  return match[1];
}

export function validateRelease(options = {}) {
  const {
    tag = process.env.GITHUB_REF_NAME,
    packages = discoverPackages(),
    rootPackageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")),
    nodeVersionFile = fs.readFileSync(path.join(REPO_ROOT, ".nvmrc"), "utf8").trim(),
    silent = false,
    enforceSourceBetaRoster = options.packages === undefined,
  } = options;
  const version = releaseVersionFromTag(tag);
  const publishable = publishablePackages(packages);
  const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const issues = [];

  if (!publishable.length) {
    issues.push("no publishable packages found");
  }
  if (enforceSourceBetaRoster) {
    const expectedNames = new Set(SOURCE_BETA_RELEASE_PACKAGE_NAMES);
    const actualNames = new Set(publishable.map((pkg) => pkg.name));
    const missing = SOURCE_BETA_RELEASE_PACKAGE_NAMES.filter((name) => !actualNames.has(name));
    const unexpected = [...actualNames].filter((name) => !expectedNames.has(name)).sort();
    if (missing.length > 0 || unexpected.length > 0) {
      issues.push(
        `publishable package roster must contain exactly ${SOURCE_BETA_RELEASE_PACKAGE_NAMES.length} source-beta packages`
        + `${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}`
        + `${unexpected.length > 0 ? `; unexpected: ${unexpected.join(", ")}` : ""}`,
      );
    }
  }

  if (rootPackageJson.engines?.node !== SUPPORTED_NODE_ENGINE) {
    issues.push(`root package.json engines.node must be ${SUPPORTED_NODE_ENGINE}; found ${rootPackageJson.engines?.node ?? "(missing)"}`);
  }
  if (nodeVersionFile !== MINIMUM_NODE_VERSION) {
    issues.push(`.nvmrc must be ${MINIMUM_NODE_VERSION}; found ${nodeVersionFile || "(empty)"}`);
  }

  const expectedWorkspaceRange = `workspace:${version}`;
  for (const section of ROOT_DEPENDENCY_SECTIONS) {
    for (const [name, range] of Object.entries(rootPackageJson[section] || {})) {
      if (name.startsWith("@mono-agent/") && range !== expectedWorkspaceRange) {
        issues.push(`root package.json ${section}.${name} must be ${expectedWorkspaceRange}; found ${range}`);
      }
    }
  }

  for (const pkg of publishable) {
    // The `alias` tier is the intentionally unscoped `mono-agent` npm name; every
    // other publishable package must use the @mono-agent scope.
    if (pkg.catalogEntry.tier !== "alias" && !pkg.name?.startsWith("@mono-agent/")) {
      issues.push(`${pkg.name || rel(pkg.manifestPath)} must use the @mono-agent scope`);
    }
    if (pkg.private) {
      issues.push(`${pkg.name} must not be private`);
    }
    if (pkg.publishConfig?.access !== "public") {
      issues.push(`${pkg.name} publishConfig.access must be public`);
    }
    if (pkg.packageJson.engines?.node !== SUPPORTED_NODE_ENGINE) {
      issues.push(`${pkg.name} engines.node must be ${SUPPORTED_NODE_ENGINE}; found ${pkg.packageJson.engines?.node ?? "(missing)"}`);
    }
    const repository = pkg.packageJson.repository;
    if (repository?.type !== RELEASE_REPOSITORY.type
      || repository?.url !== RELEASE_REPOSITORY.url
      || repository?.directory !== pkg.relativeDir) {
      issues.push(
        `${pkg.name} repository must be ${RELEASE_REPOSITORY.type} ${RELEASE_REPOSITORY.url} `
        + `at ${pkg.relativeDir}`,
      );
    }
  }

  issues.push(...releaseDependencyPinIssues(publishable));

  for (const pkg of publishable) {
    if (pkg.version !== version) {
      issues.push(`${pkg.name} version must be ${version}; found ${pkg.version} in ${rel(pkg.manifestPath)}`);
    }
  }

  for (const pkg of publishable) {
    for (const section of PACKAGE_PIN_SECTIONS) {
      for (const [name, range] of Object.entries(pkg.packageJson[section] || {})) {
        const dependency = packagesByName.get(name);
        if (dependency === undefined) {
          continue;
        }
        if (dependency.catalogEntry.publishable !== true) {
          issues.push(`${pkg.name} ${section}.${name} points at nonpublishable workspace package ${name}`);
          continue;
        }
        if (range !== expectedWorkspaceRange) {
          issues.push(`${pkg.name} ${section}.${name} must be ${expectedWorkspaceRange}; found ${range}`);
        }
      }
    }
  }

  for (const pkg of packages) {
    if (pkg.catalogEntry.publishable !== true && pkg.publishConfig) {
      issues.push(`${pkg.name || rel(pkg.manifestPath)} has publishConfig but is not catalog-publishable`);
    }
  }

  const publishOrder = issues.length ? [] : sortForPublish(publishable);

  if (issues.length) {
    const error = new Error(`release validation failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    error.issues = issues;
    throw error;
  }

  if (!silent) {
    console.log(`Release ${tag} validates as version ${version}.`);
    console.log("Publish order:");
    for (const pkg of publishOrder) {
      console.log(`- ${pkg.name}@${pkg.version} (${pkg.relativeDir})`);
    }
    console.log(`Checked package internal pin sections: ${PACKAGE_PIN_SECTIONS.join(", ")}`);
    console.log(`Checked root internal dependency sections: ${ROOT_DEPENDENCY_SECTIONS.join(", ")}`);
  }

  return { tag, version, packages, publishablePackages: publishOrder };
}

async function main() {
  const tag = argValue("--tag") || process.env.GITHUB_REF_NAME;
  validateRelease({ tag });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
