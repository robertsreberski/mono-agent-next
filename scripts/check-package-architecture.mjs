#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  PACKAGE_CATEGORIES,
  SHIPPED_CHANNEL_IDS,
  packageByName,
  packageCatalog,
  packageRelativePath,
} from "./package-catalog.mjs";
import { findAdapterNeutralityErrors } from "./lib/adapter-neutrality.mjs";
import { findPackagePublicApiDocErrors } from "./lib/public-api-docs.mjs";
import {
  findPackageDocGenerationErrors,
  findPackageReadmeStructureErrors,
  REQUIRED_PACKAGE_README_SECTIONS,
} from "./lib/package-docs.mjs";
import { findPackageVerificationErrors } from "./lib/package-verification.mjs";

const root = process.cwd();
const packageScope = "@mono-agent/";
const requiredReadmeSections = REQUIRED_PACKAGE_README_SECTIONS.map((section) => `## ${section}`);
const v1ModuleKinds = new Map([
  ["@mono-agent/runtime-pi", "runtime"],
  ["@mono-agent/runtime-claude", "runtime"],
  ["@mono-agent/runtime-codex", "runtime"],
  ["@mono-agent/runtime-opencode", "runtime"],
  ["@mono-agent/channel-telegram", "channel"],
  ["@mono-agent/channel-slack", "channel"],
  ["@mono-agent/channel-webhook", "channel"],
  ["@mono-agent/channel-openai-api", "channel"],
  ["@mono-agent/channel-operator", "channel"],
  ["@mono-agent/trigger-cron", "trigger"],
  ["@mono-agent/memory-local", "memory"],
  ["@mono-agent/state-local", "state"],
  ["@mono-agent/exporter-otlp", "exporter"],
  ["@mono-agent/sandbox-srt", "sandbox"],
]);
const v1InternalDependencyClosure = new Map([
  ["@mono-agent/module-sdk", []],
  ["@mono-agent/core", ["@mono-agent/module-sdk"]],
  ["@mono-agent/cli", ["@mono-agent/core"]],
  ["@mono-agent/runtime-pi", ["@mono-agent/module-sdk"]],
  ["@mono-agent/runtime-claude", ["@mono-agent/module-sdk"]],
  ["@mono-agent/runtime-codex", ["@mono-agent/module-sdk"]],
  ["@mono-agent/runtime-opencode", ["@mono-agent/module-sdk"]],
  ["@mono-agent/channel-telegram", ["@mono-agent/module-sdk"]],
  ["@mono-agent/channel-slack", ["@mono-agent/module-sdk"]],
  ["@mono-agent/channel-webhook", ["@mono-agent/module-sdk"]],
  ["@mono-agent/channel-openai-api", ["@mono-agent/module-sdk"]],
  ["@mono-agent/operator", []],
  ["@mono-agent/channel-operator", ["@mono-agent/module-sdk", "@mono-agent/operator"]],
  ["@mono-agent/trigger-cron", ["@mono-agent/module-sdk"]],
  ["@mono-agent/memory-local", ["@mono-agent/module-sdk"]],
  ["@mono-agent/state-local", ["@mono-agent/module-sdk"]],
  ["@mono-agent/exporter-otlp", ["@mono-agent/module-sdk"]],
  ["@mono-agent/sandbox-srt", ["@mono-agent/module-sdk"]],
  ["@mono-agent/tui", ["@mono-agent/operator"]],
  ["@mono-agent/web", ["@mono-agent/operator"]],
  ["create-mono-agent", ["@mono-agent/cli"]],
  ["@mono-agent/docs-mcp", []],
  ["@mono-agent/service-macos", ["@mono-agent/core"]],
]);

const errors = [];
const catalogByName = packageByName();
const catalogPaths = new Set(packageCatalog.map((entry) => packageRelativePath(entry)));
const packagePaths = workspacePackagePaths()
  .sort();

for (const packagePath of packagePaths) {
  if (!catalogPaths.has(packagePath)) {
    errors.push(`${packagePath} is missing from scripts/package-catalog.mjs.`);
  }
}

const channelOwnerById = new Map();
for (const catalogEntry of packageCatalog) {
  const packagePath = packageRelativePath(catalogEntry);
  if (!PACKAGE_CATEGORIES.includes(catalogEntry.category)) {
    errors.push(`${packagePath} has unknown category ${catalogEntry.category}.`);
  }
  for (const allowed of catalogEntry.allowedDependencyCategories) {
    if (!PACKAGE_CATEGORIES.includes(allowed)) {
      errors.push(`${packagePath} allows unknown dependency category ${allowed}.`);
    }
  }
  if (catalogEntry.category === "communication" && !Array.isArray(catalogEntry.channelIds)) {
    errors.push(`${packagePath} must declare channelIds in scripts/package-catalog.mjs.`);
    continue;
  }
  if (catalogEntry.category !== "communication" && catalogEntry.channelIds !== undefined) {
    errors.push(`${packagePath} declares channelIds but is not a communication package.`);
    continue;
  }
  if (!Array.isArray(catalogEntry.channelIds)) {
    continue;
  }
  if (catalogEntry.channelIds.length === 0) {
    errors.push(`${packagePath} must declare at least one shipped channel id.`);
  }
  for (const channelId of catalogEntry.channelIds) {
    if (typeof channelId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(channelId)) {
      errors.push(`${packagePath} has invalid shipped channel id ${JSON.stringify(channelId)}.`);
      continue;
    }
    if (catalogEntry.supersededBy !== undefined) {
      const replacement = catalogByName.get(catalogEntry.supersededBy);
      if (replacement === undefined || replacement.category !== "communication") {
        errors.push(`${packagePath} has invalid communication replacement ${catalogEntry.supersededBy}.`);
      } else if (!replacement.channelIds?.includes(channelId)) {
        errors.push(`${packagePath} replacement ${catalogEntry.supersededBy} does not own channel id ${channelId}.`);
      }
      continue;
    }
    const existingOwner = channelOwnerById.get(channelId);
    if (existingOwner !== undefined) {
      errors.push(`${packagePath} duplicates shipped channel id ${channelId} from ${existingOwner}.`);
      continue;
    }
    channelOwnerById.set(channelId, packagePath);
  }
}

for (const catalogEntry of packageCatalog) {
  const packagePath = packageRelativePath(catalogEntry);
  const dir = join(root, packagePath);
  const packageJsonPath = join(dir, "package.json");
  const readmePath = join(dir, "README.md");
  if (!existsSync(packageJsonPath)) {
    errors.push(`Missing package.json for ${packagePath}.`);
    continue;
  }
  if (!existsSync(readmePath)) {
    errors.push(`Missing README.md for ${packagePath}.`);
  } else {
    const readme = readFileSync(readmePath, "utf8");
    for (const section of requiredReadmeSections) {
      if (!readme.includes(section)) {
        errors.push(`${packagePath}/README.md missing section ${section}.`);
      }
    }
    if (!readme.includes(`Category: \`${catalogEntry.category}\``)) {
      errors.push(`${packagePath}/README.md missing catalog category line: Category: \`${catalogEntry.category}\`.`);
    }
  }

  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (catalogEntry.publishable === true) {
    errors.push(...findPackageVerificationErrors({ manifest, packagePath }));
  }
  const packageName = manifest.name;
  if (packageName !== catalogEntry.name) {
    errors.push(`${packagePath}/package.json has unexpected name ${packageName}.`);
  }
  // The `alias` tier is intentionally unscoped (the bare `mono-agent` npm name);
  // every other package must use the @mono-agent/ scope.
  if (catalogEntry.tier !== "alias" && !packageName.startsWith(packageScope)) {
    errors.push(`${packagePath}/package.json name must use the ${packageScope} scope.`);
  }
  const deps = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
  const depNames = Object.keys(deps);
  const expectedV1Dependencies = v1InternalDependencyClosure.get(packageName);
  if (expectedV1Dependencies !== undefined) {
    const actualV1Dependencies = depNames
      .filter((name) => name.startsWith(packageScope) || name === "create-mono-agent")
      .sort();
    const expected = [...expectedV1Dependencies].sort();
    if (JSON.stringify(actualV1Dependencies) !== JSON.stringify(expected)) {
      errors.push(
        `${packagePath} must have exact v1 workspace closure ${expected.join(", ") || "none"}; found ${actualV1Dependencies.join(", ") || "none"}.`,
      );
    }
  }
  const expectedModuleKind = v1ModuleKinds.get(packageName);
  if (expectedModuleKind !== undefined) {
    const moduleMetadata = manifest["mono-agent"];
    if (moduleMetadata?.packageName !== packageName
      || moduleMetadata?.apiVersion !== 1
      || moduleMetadata?.kind !== expectedModuleKind
      || typeof moduleMetadata?.responsibility !== "string"
      || moduleMetadata.responsibility.trim().length === 0) {
      errors.push(`${packagePath}/package.json must declare matching mono-agent ${expectedModuleKind} metadata at API version 1.`);
    }
  }
  for (const depName of depNames) {
    if (!depName.startsWith(packageScope)) {
      continue;
    }
    const depEntry = catalogByName.get(depName);
    if (depEntry === undefined) {
      errors.push(`${packagePath} depends on uncatalogued scoped package ${depName}.`);
      continue;
    }
    if (!catalogEntry.allowedDependencyCategories.includes(depEntry.category)) {
      errors.push(
        `${packagePath} (${catalogEntry.category}) may not depend on ${depName} (${depEntry.category}).`,
      );
    }
    if (depEntry.category === "communication" && catalogEntry.category !== "app") {
      errors.push(`${packagePath} may not depend on communication adapter ${depName}; compose adapters only in app hosts/demos.`);
    }
  }
}

errors.push(...findAdapterNeutralityErrors({ root, channelIds: SHIPPED_CHANNEL_IDS }));
errors.push(...findPackagePublicApiDocErrors({ root, catalog: packageCatalog }));
errors.push(...findPackageDocGenerationErrors({ root, catalog: packageCatalog }));
errors.push(...findPackageReadmeStructureErrors({ root, catalog: packageCatalog }));

if (errors.length > 0) {
  console.error("Package architecture check failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Package architecture check passed for ${packageCatalog.length} workspace packages.`);

function workspacePackagePaths() {
  const workspaceRoots = ["packages", "extras"];
  const paths = [];
  for (const workspaceRoot of workspaceRoots) {
    const workspaceRootPath = join(root, workspaceRoot);
    if (!existsSync(workspaceRootPath)) {
      continue;
    }
    for (const entry of readdirSync(workspaceRootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packagePath = `${workspaceRoot}/${entry.name}`;
      if (isPackageDirectory(join(root, packagePath)) || catalogPaths.has(packagePath)) {
        paths.push(packagePath);
      }
    }
  }
  return paths;
}

function walkTextFiles(dir) {
  const ignoredDirs = new Set([
    ".claude",
    ".codex",
    ".git",
    ".mono-agent",
    ".omx",
    ".superpowers",
    ".ultrawork",
    ".workflow",
    ".worklab-tmp",
    ".worktrees",
    "node_modules",
    "dist",
  ]);
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTextFiles(path));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!isTextFile(path)) {
      continue;
    }
    files.push(path);
  }
  return files;
}

function isTextFile(path) {
  if (statSync(path).size > 1_000_000) {
    return false;
  }
  return /\.(?:cjs|css|html|js|json|md|mjs|ts|tsx|yaml|yml)$/u.test(path);
}

function isPackageDirectory(dir) {
  if (existsSync(join(dir, "package.json"))) {
    return true;
  }
  const ignoredPackageArtifacts = new Set(["dist", "node_modules"]);
  return readdirSync(dir).some((entry) => !ignoredPackageArtifacts.has(entry));
}
