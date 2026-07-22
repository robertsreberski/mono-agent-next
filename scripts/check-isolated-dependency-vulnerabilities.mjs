#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runDependencyVulnerabilityCheck } from "./check-dependency-vulnerabilities.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const ISOLATED_DEPENDENCY_GRAPHS = Object.freeze([
  Object.freeze({
    kind: "pnpm",
    label: "bundled web console",
    cwd: "packages/web/webapp",
    rootPackageNames: Object.freeze(["mono-agent-web-console"]),
    dispositions: "scripts/webapp-dependency-vulnerability-dispositions.json",
  }),
  Object.freeze({
    kind: "pnpm",
    label: "documentation website",
    cwd: "website",
    rootPackageNames: Object.freeze(["mono-agent-docs"]),
    dispositions: "scripts/website-dependency-vulnerability-dispositions.json",
  }),
  Object.freeze({
    kind: "npm-lock",
    label: "managed sandbox runtime",
    cwd: "packages/agent-app/resources/srt",
    lockfile: "packages/agent-app/resources/srt/package-lock.json",
    dispositions: "scripts/managed-srt-dependency-vulnerability-dispositions.json",
  }),
]);

/**
 * Parse an npm lockfile v3 without installing it. The resulting graph uses the
 * same package@version inventory and complete production paths as the pnpm
 * advisory gate, so all surviving lockfiles share one fail-closed evaluator.
 */
export function parseNpmLockProductionGraph(source) {
  let document;
  try {
    document = JSON.parse(source);
  } catch (error) {
    throw new Error(`npm lockfile was not valid JSON: ${reasonOf(error)}`);
  }
  if (!isRecord(document) || document.lockfileVersion !== 3 || !isRecord(document.packages)) {
    throw new Error("npm lockfile must use lockfileVersion 3 with a packages object.");
  }
  const root = document.packages[""];
  if (!isRecord(root) || !isCanonicalString(root.name) || !isRecord(root.dependencies)) {
    throw new Error("npm lockfile root must name the package and declare production dependencies.");
  }

  const inventory = Object.create(null);
  const dependencyPaths = Object.create(null);
  for (const dependencyName of Object.keys(root.dependencies).sort()) {
    visit(dependencyName, "", [root.name], new Set(), false);
  }
  return {
    inventory: Object.fromEntries(
      Object.entries(inventory)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, versions]) => [name, [...new Set(versions)].sort()]),
    ),
    dependencyPaths: Object.fromEntries(
      Object.entries(dependencyPaths)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, paths]) => [key, [...new Set(paths)].sort()]),
    ),
  };

  function visit(dependencyName, parentPath, parentLabels, ancestors, optional) {
    const nodePath = resolveNpmLockNodePath(document.packages, parentPath, dependencyName);
    if (nodePath === undefined) {
      if (optional) return;
      throw new Error(
        `npm lockfile cannot resolve production dependency ${dependencyName} from ${parentPath || "the root"}.`,
      );
    }
    const node = document.packages[nodePath];
    if (!isRecord(node) || !isCanonicalString(node.version)) {
      throw new Error(`npm lockfile package ${nodePath} is missing an exact version.`);
    }
    if (node.dev === true) {
      throw new Error(`npm lockfile marks production dependency ${nodePath} as dev-only.`);
    }
    const name = isCanonicalString(node.name) ? node.name : dependencyName;
    const key = `${name}@${node.version}`;
    const labels = [...parentLabels, key];
    inventory[name] ??= [];
    inventory[name].push(node.version);
    dependencyPaths[key] ??= [];
    dependencyPaths[key].push(labels.join(" -> "));

    if (ancestors.has(nodePath)) return;
    const nextAncestors = new Set([...ancestors, nodePath]);
    for (const childName of objectKeys(node.dependencies, `dependencies for ${nodePath}`)) {
      visit(childName, nodePath, labels, nextAncestors, false);
    }
    for (const childName of objectKeys(node.optionalDependencies, `optionalDependencies for ${nodePath}`)) {
      visit(childName, nodePath, labels, nextAncestors, true);
    }
  }
}

export function resolveNpmLockNodePath(packages, parentPath, dependencyName) {
  if (!isRecord(packages) || !isCanonicalString(dependencyName)) return undefined;
  let current = parentPath;
  while (true) {
    const candidate = current.length === 0
      ? `node_modules/${dependencyName}`
      : `${current}/node_modules/${dependencyName}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (current.length === 0) return undefined;
    const marker = current.lastIndexOf("/node_modules/");
    current = marker === -1 ? "" : current.slice(0, marker);
  }
}

export async function runIsolatedDependencyVulnerabilityChecks(options = {}) {
  const root = resolve(options.repoRoot ?? repoRoot);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const read = options.readFile ?? readFile;
  const runCheck = options.runCheck ?? runDependencyVulnerabilityCheck;
  let exitCode = 0;

  for (const graph of options.graphs ?? ISOLATED_DEPENDENCY_GRAPHS) {
    stdout.write(`Auditing isolated ${graph.label} production graph.\n`);
    let productionGraph;
    try {
      if (graph.kind === "npm-lock") {
        productionGraph = parseNpmLockProductionGraph(
          await read(resolve(root, graph.lockfile), "utf8"),
        );
      }
      const result = await runCheck({
        cwd: resolve(root, graph.cwd),
        dispositionsPath: resolve(root, graph.dispositions),
        stdout,
        stderr,
        ...(graph.kind === "pnpm"
          ? { rootPackageNames: graph.rootPackageNames }
          : { productionGraph }),
      });
      if (result.exitCode !== 0) exitCode = 1;
    } catch (error) {
      stderr.write(`isolated dependency vulnerability check: FAILED — ${reasonOf(error)}\n`);
      exitCode = 1;
    }
  }
  return { exitCode };
}

function objectKeys(value, label) {
  if (value === undefined) return [];
  if (!isRecord(value)) throw new Error(`npm lockfile ${label} must be an object.`);
  return Object.keys(value).sort();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalString(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

const isCli = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  const result = await runIsolatedDependencyVulnerabilityChecks();
  process.exitCode = result.exitCode;
}
