#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { packageCatalog } from "./package-catalog.mjs";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_ADVISORY_DEPENDENCY_PATH_STEPS = 100_000;
const MAX_BULK_ADVISORIES = 1_000;
const MAX_DIRECT_PRODUCTION_ENTRY_STEPS = 100_000;
const MAX_PRODUCTION_PATHS_PER_PACKAGE_VERSION = 10_000;
const MAX_PRODUCTION_SUBTREE_COUNT_STEPS = 100_000;
const MAX_PRODUCTION_TRAVERSAL_STEPS = 100_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_WHY_PATHS_PER_TARGET = 10_000;
const MAX_WHY_TRAVERSAL_STEPS_PER_TARGET = 100_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TEMPORARY_ACCEPTANCE_DAYS = 90;
const MAX_DISPOSITION_OWNER_BYTES = 200;
const MAX_DISPOSITION_RATIONALE_BYTES = 4_096;
const MAX_DIAGNOSTIC_CHARS = 500;
const DATE_ONLY_PATTERN = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;
const PNPM_VERSION_PATTERN = /^(?<major>0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SEVERITY_RANK = Object.freeze({ low: 0, moderate: 1, high: 2, critical: 3 });
const DISPOSITION_TOP_LEVEL_FIELDS = Object.freeze([
  "advisories",
  "minimumSeverity",
  "reviewedAt",
  "schemaVersion",
]);
const DISPOSITION_ADVISORY_FIELDS = Object.freeze([
  "dependencyPaths",
  "disposition",
  "expiresAt",
  "id",
  "owner",
  "package",
  "rationale",
  "severity",
  "title",
  "url",
  "versions",
  "vulnerableVersions",
]);
const DEFAULT_ROOT_PACKAGE_NAMES = packageCatalog
  .filter((entry) => entry.publishable === true)
  .map((entry) => entry.name)
  .sort();

export const DEFAULT_AUDIT_REGISTRY_URL = "https://registry.npmjs.org/";
export const DEFAULT_DISPOSITIONS_PATH = fileURLToPath(
  new URL("./dependency-vulnerability-dispositions.json", import.meta.url),
);

export function parsePnpmProductionInventory(source) {
  // pnpm 10's parseable `--prod` output is compact and excludes root dev-only
  // packages. Parse registry package names from the virtual-store paths; local
  // workspace links never enter `.pnpm/` and are excluded deliberately.
  const inventory = Object.create(null);
  for (const rawPath of source.split(/\r?\n/u)) {
    const packagePath = rawPath.trim();
    if (packagePath.length === 0 || !packagePath.replaceAll("\\", "/").includes("/node_modules/.pnpm/")) {
      continue;
    }
    const { name, version } = parseVirtualStorePackagePath(packagePath);
    inventory[name] ??= [];
    inventory[name].push(version);
  }
  return normalizeInventory(inventory);
}

export function parsePnpmProductionGraph(source, options = {}) {
  let document;
  try {
    document = JSON.parse(source);
  } catch (error) {
    throw new Error(`pnpm list output was not valid JSON: ${reasonOf(error)}`);
  }
  if (!Array.isArray(document)) {
    throw new Error("pnpm list output must be an array of workspace roots.");
  }

  // pnpm 11's recursive output includes root devDependencies even when `--prod`
  // is present. The JSON output preserves dependency sections, so walk only
  // dependencies/optionalDependencies from the publishable roots. pnpm 11 also
  // deduplicates repeated JSON subtrees; index every expanded node by its stable
  // installed path first, then hydrate deduped occurrences during traversal.
  const rootPackageNames = normalizeRootPackageNames(
    options.rootPackageNames ?? DEFAULT_ROOT_PACKAGE_NAMES,
  );
  const requestedRoots = new Set(rootPackageNames);
  const rootsByName = new Map();
  const rootsByPath = new Map();
  for (const root of document) {
    if (!isRecord(root) || typeof root.name !== "string" || root.name.length === 0
      || typeof root.path !== "string" || root.path.length === 0) {
      throw new Error("pnpm list output contains a malformed workspace root.");
    }
    if (!requestedRoots.has(root.name)) {
      continue;
    }
    if (rootsByName.has(root.name)) {
      throw new Error(`pnpm list output contains duplicate workspace root ${root.name}.`);
    }
    if (rootsByPath.has(root.path)) {
      throw new Error(
        `pnpm list output maps multiple publishable workspace roots to ${root.path}: `
        + `${rootsByPath.get(root.path).name}, ${root.name}.`,
      );
    }
    rootsByName.set(root.name, root);
    rootsByPath.set(root.path, root);
  }
  const missingRoots = rootPackageNames.filter((name) => !rootsByName.has(name));
  if (missingRoots.length > 0) {
    throw new Error(`pnpm list output is missing publishable workspace roots: ${missingRoots.join(", ")}.`);
  }

  const { expandedNodes, subtreeCountState } = indexExpandedProductionNodes(document, rootsByPath);
  const inventory = Object.create(null);
  const dependencyPaths = {};
  const traversalBudget = {
    pathCounts: new Map(),
    steps: 0,
  };
  for (const rootName of rootPackageNames) {
    traverseProductionChildren(rootsByName.get(rootName), [rootName], new Set());
  }
  return normalizeProductionGraph({ inventory, dependencyPaths });

  function traverseProductionChildren(parent, parentPath, ancestors) {
    for (const section of ["dependencies", "optionalDependencies"]) {
      const children = parent[section];
      if (children === undefined) {
        continue;
      }
      if (!isRecord(children)) {
        throw new Error(`pnpm list ${section} must be an object at ${parentPath.join(" -> ")}.`);
      }
      for (const [childName, child] of Object.entries(children).sort(([left], [right]) => left.localeCompare(right))) {
        traversalBudget.steps += 1;
        if (traversalBudget.steps > MAX_PRODUCTION_TRAVERSAL_STEPS) {
          throw new Error(
            `pnpm list production graph exceeded ${MAX_PRODUCTION_TRAVERSAL_STEPS} traversal steps.`,
          );
        }
        validatePnpmForwardDependencyNode(childName, child, `pnpm list ${section}`);
        // Every publishable workspace package is traversed from its own root.
        // Skip its consumer-prefixed occurrence; the requested root below is
        // hydrated from the expansion index if pnpm rendered it as deduped.
        if (isLocalDependencyVersion(child.version)) {
          const linkedRoot = validatePnpmWorkspaceLinkBinding(
            childName,
            child,
            rootsByPath,
            "pnpm list",
          );
          if (linkedRoot === undefined) {
            throw new Error(
              `pnpm list production graph links non-publishable workspace path ${child.path}.`,
            );
          }
          continue;
        }
        const actualName = dependencyRegistryName(childName, child);
        const nodeKey = packageVersionKey(actualName, child.version);
        const nodeIdentity = forwardProductionNodeIdentity(child);
        if (ancestors.has(nodeIdentity)) {
          continue;
        }
        const pathCount = (traversalBudget.pathCounts.get(nodeKey) ?? 0) + 1;
        if (pathCount > MAX_PRODUCTION_PATHS_PER_PACKAGE_VERSION) {
          throw new Error(
            `pnpm list package version ${nodeKey} exceeded `
            + `${MAX_PRODUCTION_PATHS_PER_PACKAGE_VERSION} production dependency paths.`,
          );
        }
        traversalBudget.pathCounts.set(nodeKey, pathCount);
        const childPath = [...parentPath, nodeKey];
        inventory[actualName] ??= [];
        inventory[actualName].push(child.version);
        dependencyPaths[nodeKey] ??= [];
        dependencyPaths[nodeKey].push(childPath.join(" -> "));
        const expandedChild = resolveExpandedProductionNode(
          childName,
          child,
          expandedNodes,
          subtreeCountState,
        );
        traverseProductionChildren(
          expandedChild,
          childPath,
          new Set([...ancestors, nodeIdentity]),
        );
      }
    }
  }
}

export function parsePnpmWhyDependencyPaths(source, options) {
  let document;
  try {
    document = JSON.parse(source);
  } catch (error) {
    throw new Error(`pnpm why output was not valid JSON: ${reasonOf(error)}`);
  }
  if (!Array.isArray(document)) {
    throw new Error("pnpm why output must be an array of workspace roots.");
  }
  const packageName = options?.packageName;
  const versions = options?.versions;
  if (typeof packageName !== "string" || packageName.length === 0 || !Array.isArray(versions)
    || versions.length === 0) {
    throw new Error("pnpm why path parsing requires a package name and versions.");
  }
  const targetVersions = new Set(versions);
  for (const version of targetVersions) {
    packageVersionKey(packageName, version);
  }
  const normalizedRootPackageNames = normalizeRootPackageNames(
    options.rootPackageNames ?? DEFAULT_ROOT_PACKAGE_NAMES,
  );
  const rootPackageNames = new Set(normalizedRootPackageNames);
  const pnpmMajor = options?.pnpmMajor;
  if (pnpmMajor !== 10 && pnpmMajor !== 11) {
    throw new Error("pnpm why path parsing requires audited pnpm major 10 or 11.");
  }
  const hasDependentsShape = document.some(
    (entry) => isRecord(entry) && Object.hasOwn(entry, "dependents"),
  );
  const hasChildTreeShape = document.some(
    (entry) => isRecord(entry)
      && (Object.hasOwn(entry, "dependencies") || Object.hasOwn(entry, "optionalDependencies")),
  );
  if ((pnpmMajor === 10 && hasDependentsShape) || (pnpmMajor === 11 && hasChildTreeShape)) {
    throw new Error("pnpm why output mixes child-tree and dependents-tree shapes.");
  }
  if (pnpmMajor === 11) {
    return parseDependentsShape();
  }
  const rootsByName = new Map();
  const rootsByPath = new Map();
  for (const root of document) {
    if (!isRecord(root) || typeof root.name !== "string" || root.name.length === 0
      || typeof root.path !== "string" || root.path.length === 0) {
      throw new Error("pnpm why output contains a malformed workspace root.");
    }
    if (!rootPackageNames.has(root.name)) {
      continue;
    }
    if (rootsByName.has(root.name)) {
      throw new Error(`pnpm why output contains duplicate workspace root ${root.name}.`);
    }
    if (rootsByPath.has(root.path)) {
      throw new Error(
        `pnpm why output maps multiple publishable workspace roots to ${root.path}: `
        + `${rootsByPath.get(root.path).name}, ${root.name}.`,
      );
    }
    rootsByName.set(root.name, root);
    rootsByPath.set(root.path, root);
  }
  const missingRoots = normalizedRootPackageNames.filter((name) => !rootsByName.has(name));
  if (missingRoots.length > 0) {
    throw new Error(`pnpm why output is missing publishable workspace roots: ${missingRoots.join(", ")}.`);
  }
  const dependencyPaths = {};
  for (const rootName of normalizedRootPackageNames) {
    traverseWhyChildren(rootsByName.get(rootName), [rootName], new Set(), false);
  }
  for (const version of targetVersions) {
    const key = packageVersionKey(packageName, version);
    if (!Array.isArray(dependencyPaths[key]) || dependencyPaths[key].length === 0) {
      throw new Error(`pnpm why found no production dependency path for ${key}.`);
    }
    dependencyPaths[key] = [...new Set(dependencyPaths[key])].sort();
  }
  return dependencyPaths;

  function parseDependentsShape() {
    const paths = {};
    const targetVariants = new Set();
    const traversalBudgets = new Map();
    for (const target of document) {
      if (!isRecord(target) || typeof target.name !== "string" || target.name.length === 0) {
        throw new Error("pnpm why output contains a malformed top-level entry.");
      }
      validatePnpmReverseNode(target, `pnpm why target ${target.name}`);
      const targetName = dependencyRegistryName(target.name, target);
      if (targetName !== packageName) {
        continue;
      }
      if (!targetVersions.has(target.version)) {
        continue;
      }
      if (target.deduped !== undefined || target.circular !== undefined || target.depField !== undefined) {
        throw new Error(`pnpm why target variant ${reverseDependencyIdentity(targetName, target)} is malformed.`);
      }
      const targetIdentity = reverseDependencyIdentity(targetName, target);
      if (targetVariants.has(targetIdentity)) {
        throw new Error(`pnpm why contains duplicate target variant ${targetIdentity}.`);
      }
      targetVariants.add(targetIdentity);
      if (!Object.hasOwn(target, "dependents")) {
        throw new Error(
          `pnpm why target variant ${targetIdentity} has no dependents tree.`,
        );
      }
      if (!Array.isArray(target.dependents)) {
        throw new Error(`pnpm why dependents must be an array for ${packageVersionKey(packageName, target.version)}.`);
      }
      const targetKey = packageVersionKey(packageName, target.version);
      const expandedDependents = indexExpandedDependents(
        target.dependents,
        targetIdentity,
        targetKey,
      );
      const traversalBudget = traversalBudgets.get(targetKey) ?? {
        completePaths: 0,
        steps: 0,
        targetKey,
      };
      traversalBudgets.set(targetKey, traversalBudget);
      const completePathCount = traverseDependents(
        target.dependents,
        [targetKey],
        new Set([targetIdentity]),
        expandedDependents,
        traversalBudget,
      );
      if (completePathCount === 0) {
        throw new Error(`pnpm why target variant ${targetIdentity} has no complete production dependency path.`);
      }
    }
    for (const version of targetVersions) {
      const key = packageVersionKey(packageName, version);
      if (!Array.isArray(paths[key]) || paths[key].length === 0) {
        throw new Error(`pnpm why found no production dependency path for ${key}.`);
      }
      paths[key] = [...new Set(paths[key])].sort();
    }
    return paths;

    function indexExpandedDependents(dependents, targetIdentity, targetKey) {
      // pnpm 11 expands a reverse graph node once per target variant and emits
      // identity-only `deduped` references for later occurrences. Hydrate only
      // from that target's expanded sibling so peer variants cannot cross-bind.
      const expandedDependents = new Map();
      const dedupedDependents = [];
      scan(
        dependents,
        [targetIdentity],
        new Set([targetIdentity]),
        new Set([targetKey]),
      );
      for (const { identity, suffix } of dedupedDependents) {
        if (!expandedDependents.has(identity)) {
          throw new Error(
            `pnpm why deduped branch ${identity} above ${suffix.join(" -> ")} has no expanded dependents tree.`,
          );
        }
      }
      return expandedDependents;

      function scan(entries, suffix, ancestorIdentities, ancestorPackages) {
        for (const dependent of entries) {
          validatePnpmReverseNode(dependent, `pnpm why dependent above ${suffix.join(" -> ")}`);
          const dependentName = dependencyRegistryName(dependent.name, dependent);
          const identity = reverseDependencyIdentity(dependentName, dependent);
          if (dependent.circular === true) {
            if (dependent.deduped === true || Object.hasOwn(dependent, "dependents")
              || dependent.depField !== undefined) {
              throw new Error(`pnpm why circular branch ${dependentName}@${dependent.version} is malformed.`);
            }
            if (!reverseCircularReferencesAncestor(
              dependentName,
              dependent,
              ancestorIdentities,
              ancestorPackages,
            )) {
              throw new Error(`pnpm why circular branch ${identity} does not reference an ancestor.`);
            }
            continue;
          }
          if (rootPackageNames.has(dependentName)) {
            if (dependent.deduped === true || Object.hasOwn(dependent, "dependents")) {
              throw new Error(`pnpm why publishable root ${dependentName} must be a terminal dependent.`);
            }
            continue;
          }
          if (dependent.depField !== undefined) {
            throw new Error(`pnpm why package dependent ${dependentName} unexpectedly has depField.`);
          }
          if (ancestorIdentities.has(identity)) {
            throw new Error(`pnpm why repeated ancestor ${identity} is not marked circular.`);
          }
          if (dependent.deduped === true) {
            if (Object.hasOwn(dependent, "dependents")) {
              throw new Error(`pnpm why deduped branch ${identity} must not include dependents.`);
            }
            dedupedDependents.push({ identity, suffix: [identity, ...suffix] });
            continue;
          }
          if (dependent.dependents === undefined) {
            continue;
          }
          if (!Array.isArray(dependent.dependents)) {
            throw new Error(`pnpm why dependents must be an array for ${identity}.`);
          }
          if (dependent.dependents.length === 0) {
            throw new Error(`pnpm why incomplete branch ${identity} has an empty dependents tree.`);
          }
          if (expandedDependents.has(identity)) {
            throw new Error(`pnpm why contains duplicate expanded dependents trees for ${identity}.`);
          }
          expandedDependents.set(identity, dependent);
          scan(
            dependent.dependents,
            [identity, ...suffix],
            new Set([...ancestorIdentities, identity]),
            new Set([...ancestorPackages, packageVersionKey(dependentName, dependent.version)]),
          );
        }
      }
    }

    function traverseDependents(
      dependents,
      suffix,
      ancestorIdentities,
      expandedDependents,
      traversalBudget,
    ) {
      let completePathCount = 0;
      for (const dependent of dependents) {
        traversalBudget.steps += 1;
        if (traversalBudget.steps > MAX_WHY_TRAVERSAL_STEPS_PER_TARGET) {
          throw new Error(
            `pnpm why target ${traversalBudget.targetKey} exceeded `
            + `${MAX_WHY_TRAVERSAL_STEPS_PER_TARGET} reverse dependency traversal steps.`,
          );
        }
        validatePnpmReverseNode(dependent, `pnpm why dependent above ${suffix.join(" -> ")}`);
        const dependentName = dependencyRegistryName(dependent.name, dependent);
        const dependentIdentity = reverseDependencyIdentity(dependentName, dependent);
        if (dependent.circular === true) {
          // indexExpandedDependents already proved this marker against the
          // source tree's ancestry. A deduped expansion can be hydrated under
          // a different parent, where the original ancestor is not present.
          continue;
        }
        if (rootPackageNames.has(dependentName)) {
          if (dependent.depField === undefined) {
            throw new Error(`pnpm why publishable root ${dependentName} is missing depField.`);
          }
          const targetKey = suffix.at(-1);
          traversalBudget.completePaths += 1;
          if (traversalBudget.completePaths > MAX_WHY_PATHS_PER_TARGET) {
            throw new Error(
              `pnpm why target ${traversalBudget.targetKey} exceeded `
              + `${MAX_WHY_PATHS_PER_TARGET} complete production dependency paths.`,
            );
          }
          paths[targetKey] ??= [];
          paths[targetKey].push([dependentName, ...suffix].join(" -> "));
          completePathCount += 1;
          continue;
        }
        const dependentKey = packageVersionKey(dependentName, dependent.version);
        if (ancestorIdentities.has(dependentIdentity)) {
          // Hydration can make a source-valid deduped edge point at a node in
          // the current traversal ancestry. It is terminal in this path.
          continue;
        }
        const expandedDependent = dependent.deduped === true
          ? expandedDependents.get(dependentIdentity)
          : dependent;
        if (expandedDependent === undefined) {
          throw new Error(`pnpm why deduped branch ${dependentIdentity} has no expanded dependents tree.`);
        }
        if (expandedDependent.dependents === undefined) {
          throw new Error(`pnpm why incomplete branch ${dependentKey} has no complete root path.`);
        }
        if (!Array.isArray(expandedDependent.dependents)) {
          throw new Error(`pnpm why dependents must be an array for ${dependentKey}.`);
        }
        completePathCount += traverseDependents(
          expandedDependent.dependents,
          [dependentKey, ...suffix],
          new Set([...ancestorIdentities, dependentIdentity]),
          expandedDependents,
          traversalBudget,
        );
      }
      return completePathCount;
    }
  }

  function traverseWhyChildren(parent, parentPath, ancestors, traversedWorkspaceLink) {
    for (const section of ["dependencies", "optionalDependencies"]) {
      const children = parent[section];
      if (children === undefined) {
        continue;
      }
      if (!isRecord(children)) {
        throw new Error(`pnpm why ${section} must be an object at ${parentPath.join(" -> ")}.`);
      }
      for (const [childName, child] of Object.entries(children).sort(([left], [right]) => left.localeCompare(right))) {
        if (isRecord(child) && Object.hasOwn(child, "dependents")) {
          throw new Error("pnpm why output mixes child-tree and dependents-tree shapes.");
        }
        validatePnpmDependencyNode(childName, child, `pnpm why ${section}`);
        const localWorkspaceLink = isLocalDependencyVersion(child.version);
        if (localWorkspaceLink) {
          const linkedRoot = validatePnpmWorkspaceLinkBinding(
            childName,
            child,
            rootsByPath,
            "pnpm why",
          );
          if (linkedRoot === undefined) {
            throw new Error(
              `pnpm why workspace link ${childName} is not bound to its publishable workspace root.`,
            );
          }
        }
        const actualName = dependencyRegistryName(childName, child);
        const nodeKey = localWorkspaceLink ? undefined : packageVersionKey(actualName, child.version);
        const nodeIdentity = productionNodeIdentity(childName, child);
        if (ancestors.has(nodeIdentity)) {
          continue;
        }
        const label = localWorkspaceLink ? childName : nodeKey;
        const childPath = [...parentPath, label];
        const crossedWorkspaceBoundary = traversedWorkspaceLink || localWorkspaceLink;
        // Every catalog-publishable workspace package is queried as its own root.
        // Suppress paths that traverse another workspace link: their suffix is
        // represented from that package's root, avoiding redundant consumer paths.
        if (actualName === packageName && targetVersions.has(child.version) && !crossedWorkspaceBoundary) {
          dependencyPaths[nodeKey] ??= [];
          dependencyPaths[nodeKey].push(childPath.join(" -> "));
        }
        traverseWhyChildren(
          child,
          childPath,
          new Set([...ancestors, nodeIdentity]),
          crossedWorkspaceBoundary,
        );
      }
    }
  }
}

export function normalizeInventory(input) {
  if (!isRecord(input)) {
    throw new Error("production dependency inventory must be an object.");
  }
  const entries = Object.entries(input)
    .map(([name, versions]) => {
      if (name.length === 0 || !Array.isArray(versions) || versions.length === 0) {
        throw new Error(`production dependency inventory has no versions for ${name || "<empty name>"}.`);
      }
      const normalizedVersions = [...new Set(versions.map((version) => {
        if (typeof version !== "string" || version.length === 0) {
          throw new Error(`production dependency inventory contains an invalid version for ${name}.`);
        }
        packageVersionKey(name, version);
        return version;
      }))].sort();
      return [name, normalizedVersions];
    })
    .sort(([left], [right]) => left.localeCompare(right));

  if (entries.length === 0) {
    throw new Error("production dependency inventory is empty; run pnpm install --frozen-lockfile first.");
  }
  return Object.fromEntries(entries);
}

export function normalizeProductionGraph(input) {
  if (!isRecord(input)) {
    throw new Error("production dependency graph must be an object.");
  }
  const inventory = normalizeInventory(input.inventory);
  if (!isRecord(input.dependencyPaths)) {
    throw new Error("production dependency graph must include dependencyPaths.");
  }

  const expectedKeys = new Set(
    Object.entries(inventory).flatMap(([packageName, versions]) => (
      versions.map((version) => packageVersionKey(packageName, version))
    )),
  );
  const dependencyPaths = {};
  for (const [key, paths] of Object.entries(input.dependencyPaths)) {
    if (!expectedKeys.has(key)) {
      throw new Error(`production dependency graph contains paths for absent package version ${key}.`);
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error(`production dependency graph has an invalid empty path set for ${key}.`);
    }
    const normalizedPaths = [...new Set(paths.map((path) => {
      if (typeof path !== "string" || path.length === 0) {
        throw new Error(`production dependency graph contains an invalid path for ${key}.`);
      }
      if (!path.endsWith(` -> ${key}`)) {
        throw new Error(`production dependency path does not end at ${key}: ${path}`);
      }
      return path;
    }))].sort();
    dependencyPaths[key] = normalizedPaths;
  }
  return { inventory, dependencyPaths };
}

export async function collectProductionGraph(options = {}) {
  const command = options.pnpmCommand ?? "pnpm";
  const cwd = options.cwd ?? process.cwd();
  const runCommand = options.runCommand ?? runCommandCapture;
  const versionResult = await runCommand(command, ["--version"], { cwd });
  if (versionResult.exitCode !== 0) {
    throw new Error(`could not determine pnpm version: ${commandFailureDetail(versionResult)}`);
  }
  const major = parsePnpmMajorVersion(versionResult.stdout.trim());
  const args = major === 10
    ? ["list", "--prod", "--recursive", "--depth", "Infinity", "--parseable"]
    : ["list", "--prod", "--recursive", "--depth", "Infinity", "--json"];
  const result = await runCommand(
    command,
    args,
    { cwd },
  );
  if (result.exitCode !== 0) {
    const detail = commandFailureDetail(result);
    throw new Error(`could not collect pnpm production graph: ${detail}`);
  }
  const graph = major === 10
    ? { inventory: parsePnpmProductionInventory(result.stdout), dependencyPaths: {} }
    : parsePnpmProductionGraph(result.stdout, {
      rootPackageNames: options.rootPackageNames,
    });
  return { ...graph, pnpmMajor: major };
}

export async function collectAdvisoryDependencyPaths(productionGraph, packageNames, options = {}) {
  const graph = normalizeProductionGraph(productionGraph);
  if (options.pnpmMajor !== 10 && options.pnpmMajor !== 11) {
    throw new Error("dependency-path collection requires audited pnpm major 10 or 11.");
  }
  const command = options.pnpmCommand ?? "pnpm";
  const cwd = options.cwd ?? process.cwd();
  const runCommand = options.runCommand ?? runCommandCapture;
  const dependencyPaths = { ...graph.dependencyPaths };
  for (const packageName of [...new Set(packageNames)].sort()) {
    const versions = graph.inventory[packageName];
    if (!Array.isArray(versions) || versions.length === 0) {
      throw new Error(`cannot collect dependency paths for package absent from inventory: ${packageName}.`);
    }
    const result = await runCommand(
      command,
      ["why", packageName, "--prod", "--recursive", "--json"],
      { cwd },
    );
    if (result.exitCode !== 0) {
      const detail = commandFailureDetail(result);
      throw new Error(`could not collect pnpm dependency paths for ${packageName}: ${detail}`);
    }
    Object.assign(dependencyPaths, parsePnpmWhyDependencyPaths(result.stdout, {
      packageName,
      versions,
      pnpmMajor: options.pnpmMajor,
      rootPackageNames: options.rootPackageNames,
    }));
  }
  return normalizeProductionGraph({ inventory: graph.inventory, dependencyPaths });
}

export async function loadDependencyVulnerabilityDispositions(path = DEFAULT_DISPOSITIONS_PATH) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`could not read dependency vulnerability dispositions at ${path}: ${reasonOf(error)}`);
  }
  try {
    return normalizeDispositions(JSON.parse(source));
  } catch (error) {
    throw new Error(`invalid dependency vulnerability dispositions at ${path}: ${reasonOf(error)}`);
  }
}

export function normalizeDispositions(input) {
  if (!isRecord(input)) {
    throw new Error("dispositions must use schemaVersion 1 and minimumSeverity high.");
  }
  const document = snapshotDataRecord(input, "dispositions");
  if (document.schemaVersion !== 1 || document.minimumSeverity !== "high") {
    throw new Error("dispositions must use schemaVersion 1 and minimumSeverity high.");
  }
  assertExactFields(document, DISPOSITION_TOP_LEVEL_FIELDS, "dispositions");
  if (typeof document.reviewedAt !== "string" || document.reviewedAt.length === 0
    || !Array.isArray(document.advisories)) {
    throw new Error("dispositions must include reviewedAt and an advisories array.");
  }
  const reviewedAtEpoch = parseDateOnly(document.reviewedAt, "dispositions reviewedAt");
  const dispositionEntries = snapshotDataArray(document.advisories, "dispositions advisories");

  const seen = new Set();
  const advisories = dispositionEntries.map((inputEntry) => {
    if (!isRecord(inputEntry)) {
      throw new Error("dispositions contain a malformed advisory entry.");
    }
    const entry = snapshotDataRecord(inputEntry, "disposition advisory");
    assertExactFields(
      entry,
      DISPOSITION_ADVISORY_FIELDS,
      `disposition advisory ${String(entry.id)}`,
    );
    const requiredStrings = [
      "package",
      "severity",
      "title",
      "url",
      "vulnerableVersions",
      "disposition",
      "expiresAt",
      "owner",
      "rationale",
    ];
    for (const field of requiredStrings) {
      if (!isCanonicalNonEmptyString(entry[field])) {
        throw new Error(`disposition advisory ${String(entry.id)} is missing ${field}.`);
      }
    }
    assertBoundedUtf8(
      entry.owner,
      MAX_DISPOSITION_OWNER_BYTES,
      `disposition advisory ${String(entry.id)} owner`,
    );
    assertBoundedUtf8(
      entry.rationale,
      MAX_DISPOSITION_RATIONALE_BYTES,
      `disposition advisory ${String(entry.id)} rationale`,
    );
    if (entry.disposition !== "accepted-temporarily") {
      throw new Error(`disposition advisory ${String(entry.id)} must be accepted-temporarily.`);
    }
    const expiresAtEpoch = parseDateOnly(
      entry.expiresAt,
      `disposition advisory ${String(entry.id)} expiresAt`,
    );
    const acceptanceDays = (expiresAtEpoch - reviewedAtEpoch) / 86_400_000;
    if (acceptanceDays <= 0 || acceptanceDays > MAX_TEMPORARY_ACCEPTANCE_DAYS) {
      throw new Error(
        `disposition advisory ${String(entry.id)} expiresAt must be after reviewedAt and within `
        + `${MAX_TEMPORARY_ACCEPTANCE_DAYS} days.`,
      );
    }
    if (!isKnownSeverity(entry.severity) || SEVERITY_RANK[entry.severity] < SEVERITY_RANK.high) {
      throw new Error(`disposition advisory ${String(entry.id)} must be high or critical.`);
    }
    if (!Array.isArray(entry.versions)) {
      throw new Error(`disposition advisory ${String(entry.id)} must pin at least one exact version.`);
    }
    const versions = snapshotDataArray(
      entry.versions,
      `disposition advisory ${String(entry.id)} versions`,
    ).map((version) => {
      if (!isCanonicalNonEmptyString(version)) {
        throw new Error(`disposition advisory ${String(entry.id)} contains an invalid exact version.`);
      }
      return version;
    });
    if (versions.length === 0) {
      throw new Error(`disposition advisory ${String(entry.id)} must pin at least one exact version.`);
    }
    if (new Set(versions).size !== versions.length) {
      throw new Error(`disposition advisory ${String(entry.id)} contains duplicate exact versions.`);
    }
    if (!Array.isArray(entry.dependencyPaths)) {
      throw new Error(`disposition advisory ${String(entry.id)} must name its production dependency paths.`);
    }
    const dependencyPaths = snapshotDataArray(
      entry.dependencyPaths,
      `disposition advisory ${String(entry.id)} dependencyPaths`,
    );
    if (dependencyPaths.length === 0
      || dependencyPaths.some((dependencyPath) => !isCanonicalNonEmptyString(dependencyPath))) {
      throw new Error(`disposition advisory ${String(entry.id)} must name its production dependency paths.`);
    }
    if (new Set(dependencyPaths).size !== dependencyPaths.length) {
      throw new Error(`disposition advisory ${String(entry.id)} contains duplicate production dependency paths.`);
    }
    if (!isValidAdvisoryId(entry.id)) {
      throw new Error("disposition advisory is missing id.");
    }
    const key = advisoryKey(entry.package, entry.id);
    if (seen.has(key)) {
      throw new Error(`duplicate disposition for ${advisoryLabel(entry.package, entry.id)}.`);
    }
    seen.add(key);
    return {
      package: entry.package,
      versions: [...versions].sort(),
      id: String(entry.id),
      severity: entry.severity,
      title: entry.title,
      url: entry.url,
      vulnerableVersions: entry.vulnerableVersions,
      disposition: entry.disposition,
      expiresAt: entry.expiresAt,
      dependencyPaths: [...dependencyPaths].sort(),
      owner: entry.owner,
      rationale: entry.rationale,
    };
  }).sort(compareAdvisories);

  return {
    schemaVersion: 1,
    minimumSeverity: "high",
    reviewedAt: document.reviewedAt,
    advisories,
  };
}

export async function queryBulkAdvisories(inventory, options = {}) {
  const registryUrl = options.registryUrl ?? DEFAULT_AUDIT_REGISTRY_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let endpoint;
  try {
    if (typeof registryUrl !== "string") {
      throw new TypeError("registry URL must be a string");
    }
    endpoint = new URL("-/npm/v1/security/advisories/bulk", ensureTrailingSlash(registryUrl));
  } catch {
    throw new Error("bulk advisory registry URL is invalid.");
  }
  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    throw new Error("bulk advisory registry URL must not include credentials.");
  }
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("bulk advisory timeout must be a positive finite number.");
  }
  const controller = new AbortController();
  const timeoutError = new Error(`request timed out after ${timeoutMs}ms`);
  const responseTooLargeError = new Error(
    `bulk advisory response exceeded ${MAX_RESPONSE_BYTES} bytes.`,
  );
  let timeout;

  let response;
  let source;
  try {
    const request = Promise.resolve().then(async () => {
      const fetched = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "mono-agent-dependency-vulnerability-gate",
        },
        body: JSON.stringify(inventory),
        signal: controller.signal,
      });
      if (typeof fetched?.ok !== "boolean" || typeof fetched.status !== "number"
        || (fetched.body !== null
          && (!isRecord(fetched.body) || typeof fetched.body.getReader !== "function"))) {
        throw new Error("bulk advisory endpoint returned a malformed HTTP response");
      }
      const responseSource = await readBoundedResponseBody(
        fetched.body,
        MAX_RESPONSE_BYTES,
        responseTooLargeError,
        () => controller.abort(responseTooLargeError),
      );
      return { response: fetched, source: responseSource };
    });
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });
    ({ response, source } = await Promise.race([request, timedOut]));
  } catch (error) {
    if (error === timeoutError) {
      throw new Error(`bulk advisory request timed out after ${timeoutMs}ms.`);
    }
    if (error === responseTooLargeError) {
      throw error;
    }
    throw new Error(`bulk advisory request failed: ${reasonOf(error)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(
      `bulk advisory endpoint returned HTTP ${response.status}: `
      + boundedSingleLine(source, MAX_DIAGNOSTIC_CHARS),
    );
  }
  try {
    const document = JSON.parse(source);
    if (!isRecord(document)) {
      throw new Error("response root is not an object");
    }
    return document;
  } catch (error) {
    throw new Error(`bulk advisory response was not valid JSON: ${reasonOf(error)}`);
  }
}

async function readBoundedResponseBody(body, maxBytes, limitError, abortRequest) {
  if (body === null) {
    return "";
  }
  const reader = body.getReader();
  if (!isRecord(reader) || typeof reader.read !== "function"
    || typeof reader.cancel !== "function" || typeof reader.releaseLock !== "function") {
    throw new Error("bulk advisory endpoint returned a malformed response body");
  }
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (!isRecord(result) || typeof result.done !== "boolean") {
        throw new Error("bulk advisory endpoint returned a malformed response chunk");
      }
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        throw new Error("bulk advisory endpoint returned a non-byte response chunk");
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        let cancellation;
        try {
          cancellation = reader.cancel(limitError);
        } catch {
          // The request abort below still tears down the transport.
        }
        abortRequest();
        void Promise.resolve(cancellation).catch(() => {});
        throw limitError;
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A transport abort can release or invalidate the reader first.
    }
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

export function evaluateDependencyVulnerabilities({ productionGraph, report, dispositions, now = new Date() }) {
  const normalizedGraph = normalizeProductionGraph(productionGraph);
  const normalizedInventory = normalizedGraph.inventory;
  const normalizedDispositions = normalizeDispositions(dispositions);
  const todayEpoch = utcDayEpoch(now);
  const reviewedAtEpoch = parseDateOnly(normalizedDispositions.reviewedAt, "dispositions reviewedAt");
  if (reviewedAtEpoch > todayEpoch) {
    throw new Error(`dispositions reviewedAt ${normalizedDispositions.reviewedAt} is in the future.`);
  }
  if (!isRecord(report)) {
    throw new Error("bulk advisory report must be an object keyed by package name.");
  }
  const normalizedReport = normalizeBulkAdvisoryReport(report, normalizedInventory);

  const active = [];
  const advisoryPathBudget = { steps: 0 };
  for (const [packageName, advisories] of Object.entries(normalizedReport)) {
    for (const advisory of advisories) {
      const normalized = normalizeLiveAdvisory(
        packageName,
        normalizedInventory[packageName],
        normalizedGraph.dependencyPaths,
        advisory,
        advisoryPathBudget,
      );
      if (SEVERITY_RANK[normalized.severity] >= SEVERITY_RANK.high) {
        active.push(normalized);
      }
    }
  }
  active.sort(compareAdvisories);

  const activeByKey = new Map(active.map((advisory) => [advisoryKey(advisory.package, advisory.id), advisory]));
  const dispositionsByKey = new Map(
    normalizedDispositions.advisories.map((advisory) => [advisoryKey(advisory.package, advisory.id), advisory]),
  );
  const unreviewed = [];
  const mismatched = [];
  const stale = [];
  const expired = normalizedDispositions.advisories.filter(
    (disposition) => parseDateOnly(
      disposition.expiresAt,
      `disposition advisory ${disposition.id} expiresAt`,
    ) <= todayEpoch,
  );

  for (const advisory of active) {
    const disposition = dispositionsByKey.get(advisoryKey(advisory.package, advisory.id));
    if (disposition === undefined) {
      unreviewed.push(advisory);
      continue;
    }
    const differences = dispositionDifferences(advisory, disposition);
    if (differences.length > 0) {
      mismatched.push({ advisory, disposition, differences });
    }
  }
  for (const disposition of normalizedDispositions.advisories) {
    if (!activeByKey.has(advisoryKey(disposition.package, disposition.id))) {
      stale.push(disposition);
    }
  }

  return {
    ok: unreviewed.length === 0 && mismatched.length === 0 && stale.length === 0 && expired.length === 0,
    productionGraph: normalizedGraph,
    inventory: normalizedInventory,
    dispositions: normalizedDispositions,
    active,
    unreviewed,
    mismatched,
    stale,
    expired,
  };
}

export async function runDependencyVulnerabilityCheck(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let parsed;
  try {
    parsed = parseArgs(options.argv ?? process.argv.slice(2));
  } catch (error) {
    stderr.write(`${boundedSingleLine(reasonOf(error), 2_000)}\n\n${usage()}\n`);
    return { exitCode: 1 };
  }
  if (parsed.help) {
    stdout.write(`${usage()}\n`);
    return { exitCode: 0 };
  }

  try {
    const cwd = options.cwd ?? process.cwd();
    const productionGraph = options.productionGraph ?? await (
      options.collectGraph ?? collectProductionGraph
    )({
      cwd,
      pnpmCommand: options.pnpmCommand,
      rootPackageNames: options.rootPackageNames,
      runCommand: options.runCommand,
    });
    const dispositions = options.dispositions ?? await loadDependencyVulnerabilityDispositions(
      options.dispositionsPath ?? DEFAULT_DISPOSITIONS_PATH,
    );
    const registryUrl = options.registryUrl
      ?? process.env.MONO_AGENT_DEPENDENCY_AUDIT_REGISTRY
      ?? DEFAULT_AUDIT_REGISTRY_URL;
    const normalizedGraph = normalizeProductionGraph(productionGraph);
    const report = await (options.queryAdvisories ?? queryBulkAdvisories)(normalizedGraph.inventory, {
      registryUrl,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
    const normalizedReport = normalizeBulkAdvisoryReport(report, normalizedGraph.inventory);
    const highSeverityPackages = highSeverityReportPackageNames(normalizedReport);
    const packagesMissingPaths = highSeverityPackages.filter((packageName) => (
      normalizedGraph.inventory[packageName].some((version) => (
        !Array.isArray(normalizedGraph.dependencyPaths[packageVersionKey(packageName, version)])
      ))
    ));
    const graphWithPaths = packagesMissingPaths.length === 0
      ? normalizedGraph
      : await (options.collectDependencyPaths ?? collectAdvisoryDependencyPaths)(
        normalizedGraph,
        packagesMissingPaths,
        {
          cwd,
          pnpmMajor: options.pnpmMajor ?? productionGraph.pnpmMajor,
          pnpmCommand: options.pnpmCommand,
          rootPackageNames: options.rootPackageNames,
          runCommand: options.runCommand,
        },
      );
    const evaluation = evaluateDependencyVulnerabilities({
      productionGraph: graphWithPaths,
      report: normalizedReport,
      dispositions,
      now: options.now,
    });
    renderEvaluation(evaluation, { stdout, stderr });
    return { exitCode: evaluation.ok ? 0 : 1, evaluation };
  } catch (error) {
    stderr.write(
      `dependency vulnerability check: FAILED — ${boundedSingleLine(reasonOf(error), 2_000)}\n`,
    );
    return { exitCode: 1, error };
  }
}

function renderEvaluation(evaluation, { stdout, stderr }) {
  const packageCount = Object.keys(evaluation.inventory).length;
  const versionCount = Object.values(evaluation.inventory).reduce((total, versions) => total + versions.length, 0);
  if (!evaluation.ok) {
    stderr.write(
      `dependency vulnerability check: FAILED — ${packageCount} production packages / ${versionCount} versions; `
      + `${evaluation.active.length} high-or-critical advisories.\n`,
    );
    for (const advisory of evaluation.unreviewed) {
      stderr.write(`  UNREVIEWED ${formatAdvisory(advisory)}\n`);
    }
    for (const mismatch of evaluation.mismatched) {
      stderr.write(`  MISMATCH ${formatAdvisory(mismatch.advisory)} — ${mismatch.differences.join("; ")}\n`);
    }
    for (const disposition of evaluation.expired) {
      stderr.write(
        `  EXPIRED [${disposition.severity}] ${disposition.package}@${disposition.versions.join(",")} `
        + `${boundedSingleLine(disposition.url, MAX_DIAGNOSTIC_CHARS)} — temporary acceptance expired `
        + `${disposition.expiresAt}\n`,
      );
    }
    for (const disposition of evaluation.stale) {
      stderr.write(
        `  STALE [${disposition.severity}] ${disposition.package}@${disposition.versions.join(",")} `
        + `${boundedSingleLine(disposition.url, MAX_DIAGNOSTIC_CHARS)} — no matching active advisory\n`,
      );
    }
    return;
  }

  stdout.write(
    `dependency vulnerability check: OK — ${packageCount} production packages / ${versionCount} versions; `
    + `${evaluation.active.length} high-or-critical advisories, all exactly dispositioned.\n`,
  );
  for (const advisory of evaluation.active) {
    const disposition = evaluation.dispositions.advisories.find(
      (entry) => advisoryKey(entry.package, entry.id) === advisoryKey(advisory.package, advisory.id),
    );
    stdout.write(
      `  DISPOSITIONED ${formatAdvisory(advisory)} — owner `
      + `${boundedSingleLine(disposition.owner, MAX_DISPOSITION_OWNER_BYTES)}; `
      + `${boundedSingleLine(disposition.rationale, MAX_DISPOSITION_RATIONALE_BYTES)}\n`,
    );
  }
}

function normalizeLiveAdvisory(packageName, versions, dependencyPaths, advisory, advisoryPathBudget) {
  if (!isRecord(advisory)) {
    throw new Error(`bulk advisory report for ${packageName} contains a malformed entry.`);
  }
  const severity = advisory.severity;
  if (!isKnownSeverity(severity)) {
    throw new Error(`bulk advisory ${String(advisory.id)} for ${packageName} has an unknown severity.`);
  }
  const requiredStrings = ["title", "url", "vulnerable_versions"];
  for (const field of requiredStrings) {
    if (typeof advisory[field] !== "string" || advisory[field].length === 0) {
      throw new Error(`bulk advisory ${String(advisory.id)} for ${packageName} is missing ${field}.`);
    }
  }
  if (!isValidAdvisoryId(advisory.id)) {
    throw new Error(`bulk advisory for ${packageName} is missing id.`);
  }
  const advisoryDependencyPaths = [];
  if (SEVERITY_RANK[severity] >= SEVERITY_RANK.high) {
    for (const version of versions) {
      const key = packageVersionKey(packageName, version);
      const paths = dependencyPaths[key];
      if (!Array.isArray(paths) || paths.length === 0) {
        throw new Error(`production dependency graph has no paths for advisory package ${key}.`);
      }
      advisoryPathBudget.steps += paths.length;
      if (advisoryPathBudget.steps > MAX_ADVISORY_DEPENDENCY_PATH_STEPS) {
        throw new Error(
          `bulk advisory report exceeded ${MAX_ADVISORY_DEPENDENCY_PATH_STEPS} `
          + "dependency-path expansion steps.",
        );
      }
      advisoryDependencyPaths.push(...paths);
    }
    advisoryDependencyPaths.sort();
  }
  return {
    package: packageName,
    versions: [...versions],
    dependencyPaths: advisoryDependencyPaths,
    id: String(advisory.id),
    severity,
    title: advisory.title,
    url: advisory.url,
    vulnerableVersions: advisory.vulnerable_versions,
  };
}

function dispositionDifferences(advisory, disposition) {
  const differences = [];
  if (JSON.stringify(advisory.versions) !== JSON.stringify(disposition.versions)) {
    differences.push(
      "exact versions changed ("
      + `${boundedSingleLine(disposition.versions.join(","), MAX_DIAGNOSTIC_CHARS)} -> `
      + `${boundedSingleLine(advisory.versions.join(","), MAX_DIAGNOSTIC_CHARS)})`,
    );
  }
  if (JSON.stringify(advisory.dependencyPaths) !== JSON.stringify(disposition.dependencyPaths)) {
    differences.push("production dependency paths changed");
  }
  for (const field of ["severity", "title", "url", "vulnerableVersions"]) {
    if (advisory[field] !== disposition[field]) {
      differences.push(`${field} changed`);
    }
  }
  return differences;
}

function highSeverityReportPackageNames(report) {
  return Object.entries(report)
    .filter(([, advisories]) => advisories.some(
      (advisory) => SEVERITY_RANK[advisory.severity] >= SEVERITY_RANK.high,
    ))
    .map(([packageName]) => packageName)
    .sort();
}

function normalizeBulkAdvisoryReport(report, inventory) {
  if (!isRecord(report)) {
    throw new Error("bulk advisory report must be an object keyed by package name.");
  }
  const document = snapshotDataRecord(report, "bulk advisory report");
  const normalizedReport = Object.create(null);
  const seenAdvisories = new Set();
  let advisoryCount = 0;
  for (const [packageName, inputAdvisories] of Object.entries(document)) {
    if (!Object.hasOwn(inventory, packageName)) {
      throw new Error(`bulk advisory report returned package absent from inventory: ${packageName}.`);
    }
    if (!Array.isArray(inputAdvisories)) {
      throw new Error(`bulk advisory report for ${packageName} is not an array.`);
    }
    const advisories = snapshotDataArray(inputAdvisories, `bulk advisory report for ${packageName}`, {
      maxLength: MAX_BULK_ADVISORIES - advisoryCount,
      limitMessage: `bulk advisory report exceeded ${MAX_BULK_ADVISORIES} advisory entries.`,
    });
    advisoryCount += advisories.length;
    normalizedReport[packageName] = advisories.map((inputAdvisory) => {
      if (!isRecord(inputAdvisory)) {
        throw new Error(`bulk advisory report for ${packageName} contains an unknown severity.`);
      }
      const advisory = snapshotDataRecord(inputAdvisory, `bulk advisory report for ${packageName} entry`);
      if (!isKnownSeverity(advisory.severity)) {
        throw new Error(`bulk advisory report for ${packageName} contains an unknown severity.`);
      }
      if (!isValidAdvisoryId(advisory.id)) {
        throw new Error(`bulk advisory report for ${packageName} contains an advisory without an id.`);
      }
      for (const field of ["title", "url", "vulnerable_versions"]) {
        if (typeof advisory[field] !== "string" || advisory[field].length === 0) {
          throw new Error(`bulk advisory ${String(advisory.id)} for ${packageName} is missing ${field}.`);
        }
      }
      const key = advisoryKey(packageName, advisory.id);
      if (seenAdvisories.has(key)) {
        throw new Error(
          `bulk advisory report contains duplicate advisory ${advisoryLabel(packageName, advisory.id)}.`,
        );
      }
      seenAdvisories.add(key);
      return {
        id: advisory.id,
        severity: advisory.severity,
        title: advisory.title,
        url: advisory.url,
        vulnerable_versions: advisory.vulnerable_versions,
      };
    });
  }
  return normalizedReport;
}

function parseArgs(argv) {
  let help = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { help };
}

function usage() {
  return [
    "Usage:",
    "  pnpm run check:dependency-vulnerabilities",
    "",
    "Audits the full publishable cross-platform production/optional dependency graph through npm's bulk advisory API.",
    "Fails closed on registry errors and on unreviewed, expired, stale, or metadata/version/path-mismatched high/critical findings.",
    "Set MONO_AGENT_DEPENDENCY_AUDIT_REGISTRY only to use a compatible registry mirror.",
  ].join("\n");
}

async function runCommandCapture(command, args, options) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: typeof error.code === "number" ? error.code : 1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : reasonOf(error),
    };
  }
}

function commandFailureDetail(result) {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return boundedDetail(detail);
}

function formatAdvisory(advisory) {
  return `[${advisory.severity}] `
    + `${boundedSingleLine(`${advisory.package}@${advisory.versions.join(",")}`, MAX_DIAGNOSTIC_CHARS)} `
    + `${boundedSingleLine(advisory.id, MAX_DIAGNOSTIC_CHARS)} `
    + `${boundedSingleLine(advisory.title, MAX_DIAGNOSTIC_CHARS)} `
    + boundedSingleLine(advisory.url, MAX_DIAGNOSTIC_CHARS);
}

function compareAdvisories(left, right) {
  return left.package.localeCompare(right.package) || String(left.id).localeCompare(String(right.id));
}

function advisoryKey(packageName, id) {
  return JSON.stringify([packageName, String(id)]);
}

function advisoryLabel(packageName, id) {
  return `${packageName}:${String(id)}`;
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeRootPackageNames(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("production graph rootPackageNames must be a non-empty array.");
  }
  const names = input.map((name) => {
    if (!isUnambiguousPackageName(name)) {
      throw new Error("production graph rootPackageNames contains an invalid package name.");
    }
    return name;
  });
  if (new Set(names).size !== names.length) {
    throw new Error("production graph rootPackageNames contains duplicates.");
  }
  return [...names].sort();
}

function indexExpandedProductionNodes(document, rootsByPath) {
  const expandedNodes = new Map();
  const directEntryState = {
    cache: new WeakMap(),
    steps: 0,
  };
  const installedPathOwners = new Map();
  const dedupedNodes = [];
  const subtreeCountState = {
    cache: new WeakMap(),
    steps: 0,
  };
  const workspaceLinksByPath = new Map();
  for (const root of document) {
    scanChildren(root, [root.name], new Set());
  }
  for (const { childName, node } of dedupedNodes) {
    resolveExpandedProductionNode(childName, node, expandedNodes, subtreeCountState);
  }
  validateRequestedWorkspaceLinks();
  return { expandedNodes, subtreeCountState };

  function scanChildren(parent, parentPath, ancestors) {
    for (const section of ["dependencies", "optionalDependencies"]) {
      const children = parent[section];
      if (children === undefined) {
        continue;
      }
      if (!isRecord(children)) {
        throw new Error(`pnpm list ${section} must be an object at ${parentPath.join(" -> ")}.`);
      }
      for (const [childName, child] of Object.entries(children)) {
        validatePnpmForwardDependencyNode(childName, child, `pnpm list ${section}`);
        if (isLocalDependencyVersion(child.version)) {
          const linkedRoot = validatePnpmWorkspaceLinkBinding(
            childName,
            child,
            rootsByPath,
            "pnpm list",
          );
          if (linkedRoot !== undefined) {
            const occurrences = workspaceLinksByPath.get(child.path) ?? [];
            occurrences.push({ childName, node: child });
            workspaceLinksByPath.set(child.path, occurrences);
          }
          if (child.deduped !== true) {
            scanChildren(child, [...parentPath, childName], ancestors);
          }
          continue;
        }
        const identity = forwardProductionNodeIdentity(child);
        const owner = packageVersionKey(dependencyRegistryName(childName, child), child.version);
        if (rootsByPath.has(child.path)) {
          throw new Error(
            `pnpm list registry package ${owner} reuses publishable workspace root path ${child.path}.`,
          );
        }
        const existingOwner = installedPathOwners.get(identity);
        if (existingOwner !== undefined && existingOwner !== owner) {
          throw new Error(
            `pnpm list installed path ${child.path} has conflicting owners ${existingOwner} and ${owner}.`,
          );
        }
        installedPathOwners.set(identity, owner);
        if (ancestors.has(identity)) {
          if (child.deduped === true || Object.hasOwn(child, "dependencies")
            || Object.hasOwn(child, "optionalDependencies")) {
            throw new Error(`pnpm list rendered cycle ${identity} contains unexpected dependency metadata.`);
          }
          continue;
        }
        if (child.deduped === true) {
          dedupedNodes.push({ childName, node: child });
          continue;
        }
        const existing = expandedNodes.get(identity);
        if (existing !== undefined) {
          const existingSignature = directProductionDependencySignature(
            existing.childName,
            existing.node,
            directEntryState,
          );
          const candidateSignature = directProductionDependencySignature(
            childName,
            child,
            directEntryState,
          );
          if (existingSignature !== candidateSignature) {
            throw new Error(`pnpm list contains inconsistent expanded subtrees for ${identity}.`);
          }
        } else {
          expandedNodes.set(identity, { childName, node: child });
        }
        scanChildren(
          child,
          [...parentPath, owner],
          new Set([...ancestors, identity]),
        );
      }
    }
  }

  function validateRequestedWorkspaceLinks() {
    for (const [workspacePath, occurrences] of workspaceLinksByPath) {
      const root = rootsByPath.get(workspacePath);
      const expandedOccurrences = occurrences.filter(({ node }) => node.deduped !== true);
      const rootEntries = new Set(
        directProductionDependencyEntries(root.name, root, directEntryState)
          .map(workspaceProductionDependencyKey),
      );
      for (const { childName, node } of expandedOccurrences) {
        assertWorkspaceLinkClosureIsRootSubset(
          childName,
          node,
          rootEntries,
          directEntryState,
        );
      }

      const countSources = expandedOccurrences.length > 0
        ? expandedOccurrences.map(({ node }) => node)
        : [root];
      const expectedCounts = new Set(
        countSources.map((node) => countProductionSubtreeEntries(node, subtreeCountState)),
      );
      for (const { childName, node } of occurrences) {
        if (node.deduped !== true || expectedCounts.has(node.dedupedDependenciesCount)) {
          continue;
        }
        throw new Error(
          `pnpm list deduped workspace link ${childName} at ${workspacePath} reports `
          + `${node.dedupedDependenciesCount} dependencies, but expanded occurrences contain `
          + `${[...expectedCounts].sort((left, right) => left - right).join(" or ")}.`,
        );
      }
    }
  }
}

function resolveExpandedProductionNode(childName, child, expandedNodes, subtreeCountState) {
  if (child.deduped !== true) {
    return child;
  }
  if (typeof child.path !== "string" || child.path.length === 0) {
    throw new Error(`pnpm list deduped node ${childName}@${child.version} has no stable path identity.`);
  }
  const identity = forwardProductionNodeIdentity(child);
  const expanded = expandedNodes.get(identity);
  if (expanded === undefined) {
    throw new Error(`pnpm list deduped node ${identity} has no expanded subtree.`);
  }
  if (dependencyRegistryName(expanded.childName, expanded.node) !== dependencyRegistryName(childName, child)
    || expanded.node.version !== child.version) {
    throw new Error(`pnpm list deduped node ${identity} does not match its expanded subtree.`);
  }
  // pnpm's count is the recursive number of entries in the cached rendered
  // subtree (nested deduped or rendered-cycle leaves count once), not direct arity.
  const expandedChildCount = countProductionSubtreeEntries(expanded.node, subtreeCountState);
  if (expandedChildCount === 0) {
    throw new Error(`pnpm list deduped node ${identity} resolves to an empty expanded subtree.`);
  }
  if (child.dedupedDependenciesCount !== expandedChildCount) {
    throw new Error(
      `pnpm list deduped node ${identity} reports ${child.dedupedDependenciesCount} dependencies, `
      + `but its expanded subtree contains ${expandedChildCount}.`,
    );
  }
  return expanded.node;
}

function validatePnpmDependencyNode(childName, child, description) {
  if (childName.length === 0 || !isRecord(child)
    || typeof child.version !== "string" || child.version.length === 0) {
    throw new Error(`${description} contains a malformed entry for ${childName || "<empty name>"}.`);
  }
  if (child.from !== undefined && (typeof child.from !== "string" || child.from.length === 0)) {
    throw new Error(`${description} contains an invalid registry package name for ${childName}.`);
  }
  if (child.path !== undefined && (typeof child.path !== "string" || child.path.length === 0)) {
    throw new Error(`${description} contains an invalid installed path for ${childName}.`);
  }
  if (child.deduped !== undefined && typeof child.deduped !== "boolean") {
    throw new Error(`${description} contains an invalid deduped marker for ${childName}.`);
  }
  if (child.deduped === true) {
    if (!Number.isSafeInteger(child.dedupedDependenciesCount) || child.dedupedDependenciesCount <= 0) {
      throw new Error(`${description} deduped entry ${childName} must name a positive dependency count.`);
    }
    if (Object.hasOwn(child, "dependencies") || Object.hasOwn(child, "optionalDependencies")) {
      throw new Error(`${description} deduped entry ${childName} must not include dependency children.`);
    }
  } else if (child.dedupedDependenciesCount !== undefined) {
    throw new Error(`${description} entry ${childName} has a dependency count without deduped true.`);
  }
}

function validatePnpmForwardDependencyNode(childName, child, description) {
  validatePnpmDependencyNode(childName, child, description);
  if (typeof child.from !== "string" || child.from.length === 0) {
    throw new Error(`${description} entry ${childName} is missing registry-owner metadata.`);
  }
  if (typeof child.path !== "string" || child.path.length === 0) {
    throw new Error(`${description} entry ${childName} is missing its installed path.`);
  }
}

function validatePnpmWorkspaceLinkBinding(childName, child, rootsByPath, description) {
  if (child.from !== childName) {
    throw new Error(`${description} workspace link ${childName} has inconsistent alias metadata.`);
  }
  const linkedRoot = rootsByPath.get(child.path);
  if (linkedRoot !== undefined && linkedRoot.name !== childName) {
    throw new Error(
      `${description} workspace link ${childName} is not bound to its publishable workspace root.`,
    );
  }
  return linkedRoot;
}

function validatePnpmReverseNode(node, description) {
  if (!isRecord(node) || typeof node.name !== "string" || node.name.length === 0
    || typeof node.version !== "string" || node.version.length === 0) {
    throw new Error(`${description} is malformed.`);
  }
  if (Object.hasOwn(node, "dependencies") || Object.hasOwn(node, "optionalDependencies")) {
    throw new Error("pnpm why output mixes child-tree and dependents-tree shapes.");
  }
  if (node.from !== undefined && (typeof node.from !== "string" || node.from.length === 0)) {
    throw new Error(`${description} has an invalid registry package name.`);
  }
  if (node.peersSuffixHash !== undefined
    && (typeof node.peersSuffixHash !== "string" || node.peersSuffixHash.length === 0)) {
    throw new Error(`${description} has an invalid peer-variant hash.`);
  }
  if (node.deduped !== undefined && typeof node.deduped !== "boolean") {
    throw new Error(`${description} has an invalid deduped marker.`);
  }
  if (node.circular !== undefined && typeof node.circular !== "boolean") {
    throw new Error(`${description} has an invalid circular marker.`);
  }
  if (node.depField !== undefined
    && node.depField !== "dependencies"
    && node.depField !== "optionalDependencies") {
    throw new Error(`pnpm why contains non-production ${String(node.depField)} path through ${node.name}.`);
  }
}

function countProductionSubtreeEntries(parent, state) {
  if (state.cache.has(parent)) {
    return state.cache.get(parent);
  }
  let count = 0;
  for (const section of ["dependencies", "optionalDependencies"]) {
    const children = parent[section];
    if (children === undefined) {
      continue;
    }
    if (!isRecord(children)) {
      throw new Error(`pnpm list ${section} must be an object while validating a deduped subtree.`);
    }
    for (const [childName, child] of Object.entries(children)) {
      state.steps += 1;
      if (state.steps > MAX_PRODUCTION_SUBTREE_COUNT_STEPS) {
        throw new Error(
          `pnpm list subtree validation exceeded ${MAX_PRODUCTION_SUBTREE_COUNT_STEPS} dependency entries.`,
        );
      }
      validatePnpmForwardDependencyNode(childName, child, `pnpm list ${section}`);
      count += 1;
      if (child.deduped !== true) {
        count += countProductionSubtreeEntries(child, state);
      }
    }
  }
  state.cache.set(parent, count);
  return count;
}

function dependencyRegistryName(childName, child) {
  return child.from ?? childName;
}

function productionNodeIdentity(childName, child) {
  if (typeof child.path === "string" && child.path.length > 0) {
    return `path:${child.path}`;
  }
  const peersSuffix = typeof child.peersSuffixHash === "string" ? `#${child.peersSuffixHash}` : "";
  return `package:${packageVersionKey(dependencyRegistryName(childName, child), child.version)}${peersSuffix}`;
}

function forwardProductionNodeIdentity(child) {
  return `path:${child.path}`;
}

function reverseDependencyIdentity(packageName, node) {
  const peersSuffix = typeof node.peersSuffixHash === "string" ? `#${node.peersSuffixHash}` : "";
  return `${packageVersionKey(packageName, node.version)}${peersSuffix}`;
}

function reverseCircularReferencesAncestor(packageName, node, ancestorIdentities, ancestorPackages) {
  // pnpm's reverse renderer omits the peer hash from circular leaves. Prefer
  // exact variant identity when it is present; otherwise validate the package
  // name/version information the renderer actually retained.
  if (typeof node.peersSuffixHash === "string") {
    return ancestorIdentities.has(reverseDependencyIdentity(packageName, node));
  }
  return ancestorPackages.has(packageVersionKey(packageName, node.version));
}

function directProductionDependencySignature(childName, child, state) {
  return JSON.stringify(directProductionDependencyEntries(childName, child, state));
}

function directProductionDependencyEntries(childName, child, state) {
  if (state.cache.has(child)) {
    return state.cache.get(child);
  }
  const entries = [];
  for (const section of ["dependencies", "optionalDependencies"]) {
    const children = child[section];
    if (children === undefined) {
      continue;
    }
    if (!isRecord(children)) {
      throw new Error(`pnpm list ${section} must be an object at ${childName}@${child.version}.`);
    }
    for (const [dependencyName, dependency] of Object.entries(children)) {
      state.steps += 1;
      if (state.steps > MAX_DIRECT_PRODUCTION_ENTRY_STEPS) {
        throw new Error(
          `pnpm list direct-entry validation exceeded ${MAX_DIRECT_PRODUCTION_ENTRY_STEPS} dependencies.`,
        );
      }
      validatePnpmForwardDependencyNode(dependencyName, dependency, `pnpm list ${section}`);
      entries.push(isLocalDependencyVersion(dependency.version)
        ? [section, "workspace-link", dependency.path]
        : [
          section,
          dependencyName,
          dependencyRegistryName(dependencyName, dependency),
          dependency.version,
          dependency.path,
        ]);
    }
  }
  const sortedEntries = entries.sort(
    (left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  state.cache.set(child, sortedEntries);
  return sortedEntries;
}

function assertWorkspaceLinkClosureIsRootSubset(childName, child, rootEntries, directEntryState) {
  for (const entry of directProductionDependencyEntries(childName, child, directEntryState)) {
    if (!rootEntries.has(workspaceProductionDependencyKey(entry))) {
      throw new Error(
        `pnpm list workspace link ${childName} at ${child.path} contains a production dependency `
        + "that contradicts its publishable workspace root.",
      );
    }
  }
}

function workspaceProductionDependencyKey(entry) {
  // pnpm 11 preserves the dependency section on workspace roots, but its
  // recursive renderer flattens optional children into `dependencies`.
  // Both sections are audited, so compare their union at this boundary.
  return JSON.stringify(entry.slice(1));
}

function parsePnpmMajorVersion(value) {
  const match = PNPM_VERSION_PATTERN.exec(value);
  if (match?.groups === undefined) {
    throw new Error(`pnpm returned an invalid version: ${boundedDetail(value || "<empty>")}.`);
  }
  const major = Number(match.groups.major);
  if (major !== 10 && major !== 11) {
    throw new Error(
      `dependency vulnerability check supports audited pnpm majors 10 and 11; found ${boundedDetail(value)}.`,
    );
  }
  return major;
}

function boundedDetail(value) {
  return value.length <= 500 ? value : `${value.slice(0, 500)}…`;
}

function parseVirtualStorePackagePath(value) {
  const normalizedPath = value.replaceAll("\\", "/");
  const marker = "/node_modules/.pnpm/";
  const markerIndex = normalizedPath.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`pnpm production inventory path is not in the virtual store: ${value}`);
  }
  const relative = normalizedPath.slice(markerIndex + marker.length);
  const nodeModulesMarker = "/node_modules/";
  const nodeModulesIndex = relative.indexOf(nodeModulesMarker);
  if (nodeModulesIndex < 0) {
    throw new Error(`pnpm production inventory path has no package suffix: ${value}`);
  }
  const virtualStoreDirectory = relative.slice(0, nodeModulesIndex);
  const packageSegments = relative.slice(nodeModulesIndex + nodeModulesMarker.length).split("/");
  const name = packageSegments[0]?.startsWith("@")
    ? packageSegments.slice(0, 2).join("/")
    : packageSegments[0];
  if (typeof name !== "string" || name.length === 0 || (name.startsWith("@") && !name.includes("/"))) {
    throw new Error(`pnpm production inventory path has an invalid package name: ${value}`);
  }
  const encodedPrefix = `${name.replace("/", "+")}@`;
  if (!virtualStoreDirectory.startsWith(encodedPrefix)) {
    throw new Error(`pnpm virtual-store directory does not match package ${name}: ${value}`);
  }
  const version = virtualStoreDirectory.slice(encodedPrefix.length).split("_", 1)[0];
  if (version.length === 0) {
    throw new Error(`pnpm production inventory path has no version for ${name}: ${value}`);
  }
  return { name, version };
}

function isLocalDependencyVersion(version) {
  return version.startsWith("link:") || version.startsWith("file:") || version.startsWith("workspace:");
}

function packageVersionKey(packageName, version) {
  if (!isUnambiguousPackageName(packageName)
    || typeof version !== "string" || version.length === 0
    || version.includes("@") || version.includes("#")) {
    throw new Error("package/version identity cannot be represented unambiguously.");
  }
  return `${packageName}@${version}`;
}

function isUnambiguousPackageName(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  const firstAt = value.indexOf("@");
  if (firstAt < 0) {
    return true;
  }
  const slash = value.indexOf("/");
  return firstAt === 0
    && value.indexOf("@", 1) < 0
    && slash > 1
    && slash < value.length - 1;
}

function parseDateOnly(value, description) {
  if (typeof value !== "string") {
    throw new Error(`${description} must be a valid YYYY-MM-DD date.`);
  }
  const match = DATE_ONLY_PATTERN.exec(value);
  if (match?.groups === undefined) {
    throw new Error(`${description} must be a valid YYYY-MM-DD date.`);
  }
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const epoch = Date.UTC(year, month - 1, day);
  const parsed = new Date(epoch);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error(`${description} must be a valid YYYY-MM-DD date.`);
  }
  return epoch;
}

function assertExactFields(value, expectedFields, description) {
  const expected = new Set(expectedFields);
  const unknown = Object.keys(value).filter((field) => !expected.has(field)).sort();
  if (unknown.length > 0) {
    throw new Error(`${description} contains unknown fields: ${unknown.join(", ")}.`);
  }
  const missing = expectedFields.filter((field) => !Object.hasOwn(value, field)).sort();
  if (missing.length > 0) {
    throw new Error(`${description} is missing required own fields: ${missing.join(", ")}.`);
  }
}

function snapshotDataRecord(value, description) {
  if (!isRecord(value)) {
    throw new Error(`${description} must be a data object.`);
  }
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new Error(`${description} must contain only enumerable string data fields.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) {
      throw new Error(`${description} must contain only enumerable string data fields.`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotDataArray(value, description, options = {}) {
  if (!Array.isArray(value)) {
    throw new Error(`${description} must be an array.`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, "value")
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    throw new Error(`${description} must be a dense data array.`);
  }
  const maxLength = options.maxLength ?? Number.MAX_SAFE_INTEGER;
  if (lengthDescriptor.value > maxLength) {
    throw new Error(options.limitMessage ?? `${description} exceeds ${maxLength} entries.`);
  }
  const snapshot = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) {
      throw new Error(`${description} must be a dense data array.`);
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function assertBoundedUtf8(value, maxBytes, description) {
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${description} exceeds ${maxBytes} UTF-8 bytes.`);
  }
}

function isCanonicalNonEmptyString(value) {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && !/[\p{Cc}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u.test(value);
}

function isKnownSeverity(value) {
  return typeof value === "string" && Object.hasOwn(SEVERITY_RANK, value);
}

function isValidAdvisoryId(value) {
  return typeof value === "number"
    ? Number.isSafeInteger(value) && value >= 0
    : isCanonicalNonEmptyString(value);
}

function boundedSingleLine(value, maxChars) {
  const escaped = String(value).replace(
    /[\p{Cc}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu,
    (character) => {
      if (character === "\n") return "\\n";
      if (character === "\r") return "\\r";
      if (character === "\t") return "\\t";
      const codePoint = character.codePointAt(0);
      const hexadecimal = codePoint.toString(16);
      return codePoint <= 0xffff
        ? `\\u${hexadecimal.padStart(4, "0")}`
        : `\\u{${hexadecimal}}`;
    },
  );
  return escaped.length <= maxChars ? escaped : `${escaped.slice(0, maxChars - 1)}…`;
}

function utcDayEpoch(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("dependency vulnerability evaluation time must be a valid date.");
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

const isCli = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
  const result = await runDependencyVulnerabilityCheck();
  process.exitCode = result.exitCode;
}
