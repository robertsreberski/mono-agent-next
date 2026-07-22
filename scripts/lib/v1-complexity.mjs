import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { TextDecoder } from "node:util";
import { runInNewContext } from "node:vm";

export const COMPLEXITY_REPORT_SCHEMA = "mono-agent.v1-complexity-report.v1";
export const COMPLEXITY_POLICY_SCHEMA = "mono-agent.v1-complexity-policy.v1";
export const COMPLEXITY_ALGORITHM_VERSION = 1;

const PACKAGE_CATALOG_PATH = "scripts/package-catalog.mjs";

export const SOURCE_EXTENSIONS = Object.freeze([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

export const CLASSIFICATIONS = Object.freeze([
  "production",
  "test",
  "generated",
  "vendored",
  "excluded",
  "unclassified",
]);

export const GATE_ORDER = Object.freeze([
  "G0",
  "G0.25",
  "G0.5",
  "G1",
  "G2",
  "G3",
  "G4",
  "G5",
  "G6",
  "G7",
  "G8",
]);

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const POLICY_KEYS = Object.freeze([
  "algorithmVersion",
  "budgets",
  "closures",
  "configSchemaPath",
  "excludedRules",
  "generatedRules",
  "implementationFamilies",
  "knownNativeDependencies",
  "nonShippingRules",
  "productionRoots",
  "schema",
  "sourceExtensions",
  "testFilenameMarkers",
  "testPathSegments",
  "vendoredRules",
]);

const REQUIRED_BUDGETS = Object.freeze([
  Object.freeze({
    id: "repository-production",
    classification: "production",
    maxLines: 130_000,
    enforceAt: "G8",
  }),
  Object.freeze({
    id: "kernel-production",
    classification: "production",
    owners: Object.freeze(["packages/cli", "packages/core", "packages/module-sdk"]),
    maxLines: 15_000,
    enforceAt: "G8",
    requireOwners: true,
  }),
]);

const REQUIRED_IMPLEMENTATION_FAMILIES = Object.freeze([
  Object.freeze({
    id: "operator-wire-client",
    members: Object.freeze([
      "packages/tui/src/remote/client.ts",
      "packages/web/src/operator-client.ts",
    ]),
    maxMembers: 1,
    enforceAt: "G8",
  }),
]);

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot contain non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}.`);
}

export function stablePrettyJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeSourceText(text) {
  return text.replace(/\r\n?/gu, "\n");
}

export function countPhysicalLines(text) {
  if (text.length === 0) return 0;
  const newlineCount = text.match(/\n/gu)?.length ?? 0;
  return newlineCount + (text.endsWith("\n") ? 0 : 1);
}

export function validateComplexityPolicy(policy) {
  const errors = [];
  if (!isRecord(policy)) return ["policy must be a JSON object"];
  validateObjectKeys(policy, "policy", POLICY_KEYS, POLICY_KEYS, errors);
  if (policy.schema !== COMPLEXITY_POLICY_SCHEMA) {
    errors.push(`policy.schema must be ${COMPLEXITY_POLICY_SCHEMA}`);
  }
  if (policy.algorithmVersion !== COMPLEXITY_ALGORITHM_VERSION) {
    errors.push(`policy.algorithmVersion must be exactly ${COMPLEXITY_ALGORITHM_VERSION}`);
  }

  validateUniqueStrings(policy.sourceExtensions, "sourceExtensions", errors, (value) => value.startsWith("."), true);
  if (!Array.isArray(policy.sourceExtensions)
    || canonicalJson(policy.sourceExtensions) !== canonicalJson(SOURCE_EXTENSIONS)) {
    errors.push(`sourceExtensions must exactly equal ${SOURCE_EXTENSIONS.join(", ")}`);
  }
  validateUniqueStrings(policy.testPathSegments, "testPathSegments", errors, () => true, true);
  validateUniqueStrings(policy.testFilenameMarkers, "testFilenameMarkers", errors, (value) => value.includes("."), true);
  validateUniqueStrings(policy.productionRoots, "productionRoots", errors, isSafePrefix, true);
  validateUniqueStrings(policy.knownNativeDependencies, "knownNativeDependencies", errors);

  const ruleIds = new Set();
  for (const [group, requiredFields] of [
    ["generatedRules", ["generator", "reproducibilityCheck"]],
    ["vendoredRules", ["upstream", "version", "licensePath"]],
    ["excludedRules", []],
    ["nonShippingRules", []],
  ]) {
    if (!Array.isArray(policy[group])) {
      errors.push(`${group} must be an array`);
      continue;
    }
    for (const [index, rule] of policy[group].entries()) {
      const label = `${group}[${index}]`;
      if (!isRecord(rule)) {
        errors.push(`${label} must be an object`);
        continue;
      }
      const allowedFields = ["id", "match", "reason", ...requiredFields];
      validateObjectKeys(rule, label, allowedFields, allowedFields, errors);
      if (typeof rule.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(rule.id)) {
        errors.push(`${label}.id must be a kebab-case identifier`);
      } else if (ruleIds.has(rule.id)) {
        errors.push(`${label}.id duplicates ${rule.id}`);
      } else {
        ruleIds.add(rule.id);
      }
      if (typeof rule.reason !== "string" || rule.reason.trim().length === 0) {
        errors.push(`${label}.reason must be a non-empty string`);
      }
      validateMatch(rule.match, `${label}.match`, errors);
      if (group === "generatedRules") {
        validateArgvCommand(rule.generator, `${label}.generator`, errors);
        validateArgvCommand(rule.reproducibilityCheck, `${label}.reproducibilityCheck`, errors);
      } else if (group === "vendoredRules") {
        if (!isSafeHttpsUrl(rule.upstream)) errors.push(`${label}.upstream must be an HTTPS URL without credentials`);
        if (typeof rule.version !== "string" || !/^[^\s\u0000-\u001f\u007f]+$/u.test(rule.version)) {
          errors.push(`${label}.version must be a non-empty whitespace-free version`);
        }
        if (!isSafePath(rule.licensePath)) {
          errors.push(`${label}.licensePath must be a safe repository-relative path`);
        }
      }
    }
  }

  if (!Array.isArray(policy.budgets)) {
    errors.push("budgets must be an array");
  } else {
    const ids = new Set();
    for (const [index, budget] of policy.budgets.entries()) {
      const label = `budgets[${index}]`;
      if (!isRecord(budget)) {
        errors.push(`${label} must be an object`);
        continue;
      }
      validateObjectKeys(
        budget,
        label,
        ["classification", "enforceAt", "id", "maxLines", "owners", "requireOwners"],
        ["classification", "enforceAt", "id", "maxLines"],
        errors,
      );
      if (typeof budget.id !== "string" || budget.id.length === 0 || ids.has(budget.id)) {
        errors.push(`${label}.id must be a unique non-empty string`);
      } else {
        ids.add(budget.id);
      }
      if (!CLASSIFICATIONS.includes(budget.classification)) {
        errors.push(`${label}.classification is invalid`);
      }
      if (!Number.isSafeInteger(budget.maxLines) || budget.maxLines < 0) {
        errors.push(`${label}.maxLines must be a non-negative integer`);
      }
      if (!GATE_ORDER.includes(budget.enforceAt)) {
        errors.push(`${label}.enforceAt is invalid`);
      }
      if (budget.owners !== undefined) validateUniqueStrings(budget.owners, `${label}.owners`, errors, isSafeOwner);
      if (budget.requireOwners !== undefined && typeof budget.requireOwners !== "boolean") {
        errors.push(`${label}.requireOwners must be boolean when present`);
      }
    }
    validateRequiredBindings(policy.budgets, REQUIRED_BUDGETS, "budget", errors);
  }

  if (policy.configSchemaPath !== null && !isSafePath(policy.configSchemaPath)) {
    errors.push("configSchemaPath must be null or a safe repository-relative path");
  }
  if (!Array.isArray(policy.closures)) {
    errors.push("closures must be an array");
  } else {
    const ids = new Set();
    for (const [index, closure] of policy.closures.entries()) {
      const label = `closures[${index}]`;
      if (!isRecord(closure)) {
        errors.push(`${label} must be an object`);
        continue;
      }
      validateObjectKeys(closure, label, ["id", "roots"], ["id", "roots"], errors);
      if (typeof closure.id !== "string" || closure.id.length === 0 || ids.has(closure.id)) {
        errors.push(`${label}.id must be a unique non-empty string`);
      } else {
        ids.add(closure.id);
      }
      validateUniqueStrings(closure.roots, `${label}.roots`, errors);
    }
  }
  if (!Array.isArray(policy.implementationFamilies)) {
    errors.push("implementationFamilies must be an array");
  } else {
    const ids = new Set();
    for (const [index, family] of policy.implementationFamilies.entries()) {
      const label = `implementationFamilies[${index}]`;
      if (!isRecord(family)) {
        errors.push(`${label} must be an object`);
        continue;
      }
      validateObjectKeys(
        family,
        label,
        ["enforceAt", "id", "maxMembers", "members"],
        ["enforceAt", "id", "maxMembers", "members"],
        errors,
      );
      if (typeof family.id !== "string" || family.id.length === 0 || ids.has(family.id)) {
        errors.push(`${label}.id must be a unique non-empty string`);
      } else {
        ids.add(family.id);
      }
      validateUniqueStrings(family.members, `${label}.members`, errors, isSafePath);
      if (!Number.isSafeInteger(family.maxMembers) || family.maxMembers < 0) {
        errors.push(`${label}.maxMembers must be a non-negative integer`);
      }
      if (!GATE_ORDER.includes(family.enforceAt)) errors.push(`${label}.enforceAt is invalid`);
    }
    validateRequiredBindings(
      policy.implementationFamilies,
      REQUIRED_IMPLEMENTATION_FAMILIES,
      "implementation family",
      errors,
    );
  }
  return errors.sort(compareText);
}

export function classifySourcePath(path, policy) {
  const explicitMatches = [
    ...matchingRules(path, policy.generatedRules, "generated"),
    ...matchingRules(path, policy.vendoredRules, "vendored"),
    ...matchingRules(path, policy.excludedRules, "excluded"),
  ];
  if (explicitMatches.length > 1) {
    return {
      classification: "unclassified",
      ruleId: "conflicting-explicit-rules",
      issue: `${path} matches conflicting explicit rules: ${explicitMatches.map((entry) => entry.rule.id).sort(compareText).join(", ")}`,
      matchedRuleIds: explicitMatches.map((entry) => entry.rule.id),
    };
  }
  if (explicitMatches.length === 1) {
    const match = explicitMatches[0];
    return { classification: match.classification, ruleId: match.rule.id, matchedRuleIds: [match.rule.id] };
  }

  if (isTestPath(path, policy)) {
    return { classification: "test", ruleId: "test-path-or-filename", matchedRuleIds: [] };
  }

  const productionMatches = policy.productionRoots.filter((prefix) => path.startsWith(prefix));
  const nonShippingMatches = matchingRules(path, policy.nonShippingRules, "excluded");
  if (productionMatches.length > 0 && nonShippingMatches.length > 0) {
    return {
      classification: "unclassified",
      ruleId: "conflicting-scope-rules",
      issue: `${path} matches both production and non-shipping scope rules`,
      matchedRuleIds: nonShippingMatches.map((entry) => entry.rule.id),
    };
  }
  if (productionMatches.length > 0) {
    return { classification: "production", ruleId: "shipped-workspace-source", matchedRuleIds: [] };
  }
  if (nonShippingMatches.length > 1) {
    return {
      classification: "unclassified",
      ruleId: "conflicting-non-shipping-rules",
      issue: `${path} matches conflicting non-shipping rules: ${nonShippingMatches.map((entry) => entry.rule.id).sort(compareText).join(", ")}`,
      matchedRuleIds: nonShippingMatches.map((entry) => entry.rule.id),
    };
  }
  if (nonShippingMatches.length === 1) {
    return {
      classification: "excluded",
      ruleId: nonShippingMatches[0].rule.id,
      matchedRuleIds: [nonShippingMatches[0].rule.id],
    };
  }
  return {
    classification: "unclassified",
    ruleId: "no-classification-rule",
    issue: `${path} has no classification rule`,
    matchedRuleIds: [],
  };
}

export function buildFileManifest({ entries, blobsByOid, policy, catalog = [], unstagedPaths = [] }) {
  const files = [];
  const issues = [];
  const ruleUsage = new Map(allPolicyRules(policy).map((rule) => [rule.id, 0]));
  const sourceExtensions = new Set(policy.sourceExtensions);
  const unstaged = new Set(unstagedPaths);

  for (const entry of entries) {
    const bytes = blobsByOid.get(entry.oid);
    const sourceExtension = sourceExtensions.has(sourceExtensionOf(entry.path));
    const executableMode = entry.mode === "100755";
    const hasShebang = bytes?.subarray(0, 2).toString("utf8") === "#!";
    if (!sourceExtension && !executableMode && !hasShebang) continue;

    if (!/^(?:100644|100755)$/u.test(entry.mode) || bytes === undefined) {
      const rawDigest = bytes === undefined ? null : sha256(bytes);
      files.push({
        path: entry.path,
        gitMode: entry.mode,
        owner: ownerForPath(entry.path, catalog),
        classification: "unclassified",
        ruleId: "non-regular-source",
        lines: 0,
        contentSha256: rawDigest,
      });
      issues.push(`${entry.path} is source-shaped but is not a regular stage-0 blob`);
      continue;
    }

    const rawDigest = sha256(bytes);
    let text;
    try {
      if (bytes.includes(0)) throw new Error("contains NUL bytes");
      text = normalizeSourceText(utf8Decoder.decode(bytes));
    } catch (error) {
      files.push({
        path: entry.path,
        gitMode: entry.mode,
        owner: ownerForPath(entry.path, catalog),
        classification: "unclassified",
        ruleId: "invalid-source-text",
        lines: 0,
        contentSha256: rawDigest,
      });
      issues.push(`${entry.path} is not valid UTF-8 source text: ${reasonOf(error)}`);
      continue;
    }

    const classified = classifySourcePath(entry.path, policy);
    for (const id of classified.matchedRuleIds) ruleUsage.set(id, (ruleUsage.get(id) ?? 0) + 1);
    if (classified.issue !== undefined) issues.push(classified.issue);
    if (unstaged.has(entry.path)) issues.push(`${entry.path} has unstaged source changes`);
    files.push({
      path: entry.path,
      gitMode: entry.mode,
      owner: ownerForPath(entry.path, catalog),
      classification: classified.classification,
      ruleId: classified.ruleId,
      lines: countPhysicalLines(text),
      contentSha256: sha256(text),
    });
  }

  for (const [ruleId, count] of [...ruleUsage].sort(([left], [right]) => compareText(left, right))) {
    if (count === 0) issues.push(`classification rule ${ruleId} did not match any tracked source file`);
  }

  files.sort((left, right) => compareText(left.path, right.path));
  issues.sort(compareText);
  return { files, issues, ruleUsage };
}

export function buildComplexitySnapshot({
  manifest,
  policy,
  entries,
  blobsByOid,
  catalog = [],
  extraIssues = [],
}) {
  const issues = [
    ...manifest.issues,
    ...extraIssues,
    ...vendoredProvenanceIssues(policy, entries, blobsByOid),
  ];
  const totals = totalsForFiles(manifest.files);
  const byOwner = ownerTotals(manifest.files);
  const inventory = buildInventory({
    files: manifest.files,
    entries,
    blobsByOid,
    policy,
    catalog,
    issues,
  });
  const budgets = buildBudgets(policy, totals, byOwner);
  const manifestJsonl = manifest.files.map((row) => canonicalJson(row)).join("\n") + "\n";
  const measuredSnapshot = {
    schema: COMPLEXITY_REPORT_SCHEMA,
    algorithmVersion: policy.algorithmVersion,
    policySha256: sha256(canonicalJson(policy)),
    manifestSha256: sha256(manifestJsonl),
    totals,
    budgets,
    byOwner,
    inventory,
    files: manifest.files,
  };
  return {
    ...measuredSnapshot,
    issues: [...new Set(issues)].sort(compareText),
    snapshotSha256: sha256(canonicalJson(measuredSnapshot)),
  };
}

export function compareComplexitySnapshots(current, baseline) {
  validateComplexitySnapshot(baseline);
  const byClassification = Object.fromEntries(CLASSIFICATIONS.map((classification) => {
    const currentCount = current.totals.byClassification[classification];
    const baselineCount = baseline.totals.byClassification[classification];
    return [classification, {
      files: currentCount.files - baselineCount.files,
      lines: currentCount.lines - baselineCount.lines,
    }];
  }));
  const currentFiles = new Map(current.files.map((file) => [file.path, file]));
  const baselineFiles = new Map(baseline.files.map((file) => [file.path, file]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  let reclassified = 0;
  for (const [path, file] of currentFiles) {
    const old = baselineFiles.get(path);
    if (old === undefined) {
      added += 1;
      continue;
    }
    if (file.classification !== old.classification || file.ruleId !== old.ruleId) reclassified += 1;
    if (canonicalJson(file) !== canonicalJson(old)) changed += 1;
  }
  for (const path of baselineFiles.keys()) {
    if (!currentFiles.has(path)) removed += 1;
  }
  return {
    matches: current.snapshotSha256 === baseline.snapshotSha256,
    algorithmMatches: current.algorithmVersion === baseline.algorithmVersion,
    policyMatches: current.policySha256 === baseline.policySha256,
    baselineSnapshotSha256: baseline.snapshotSha256,
    byClassification,
    files: { added, removed, changed, reclassified },
  };
}

export function validateComplexitySnapshot(snapshot) {
  if (!isRecord(snapshot) || snapshot.schema !== COMPLEXITY_REPORT_SCHEMA) {
    throw new Error(`Baseline must use ${COMPLEXITY_REPORT_SCHEMA}.`);
  }
  if (!Array.isArray(snapshot.files) || !isRecord(snapshot.totals) || !isRecord(snapshot.totals.byClassification)) {
    throw new Error("Baseline is missing its file manifest or totals.");
  }
  if (snapshot.algorithmVersion !== COMPLEXITY_ALGORITHM_VERSION) {
    throw new Error(`Baseline algorithmVersion must be ${COMPLEXITY_ALGORITHM_VERSION}.`);
  }
  for (const key of ["manifestSha256", "policySha256", "snapshotSha256"]) {
    if (typeof snapshot[key] !== "string" || !/^[0-9a-f]{64}$/u.test(snapshot[key])) {
      throw new Error(`Baseline ${key} must be a lowercase SHA-256 digest.`);
    }
  }
  if (!Array.isArray(snapshot.issues) || snapshot.issues.some((issue) => typeof issue !== "string")) {
    throw new Error("Baseline issues must be a string array.");
  }
  const withoutDigest = { ...snapshot };
  delete withoutDigest.snapshotSha256;
  delete withoutDigest.comparison;
  delete withoutDigest.issues;
  const expectedSnapshot = sha256(canonicalJson(withoutDigest));
  if (snapshot.snapshotSha256 !== expectedSnapshot) {
    throw new Error("Baseline snapshot digest does not match its contents.");
  }
  const manifestJsonl = snapshot.files.map((row) => canonicalJson(row)).join("\n") + "\n";
  if (snapshot.manifestSha256 !== sha256(manifestJsonl)) {
    throw new Error("Baseline manifest digest does not match its file rows.");
  }
  const recomputed = totalsForFiles(snapshot.files);
  if (canonicalJson(recomputed) !== canonicalJson(snapshot.totals)) {
    throw new Error("Baseline totals do not match its file rows.");
  }
}

export function loadComplexityBaseline({ cwd = process.cwd(), path, requireCommitted = false }) {
  if (!isSafePath(path)) throw new Error("Baseline path must be a safe repository-relative path.");
  const absolutePath = resolve(cwd, path);
  let bytes;
  let evidence;
  if (requireCommitted) {
    const entries = listIndexEntries(cwd);
    const indexEntry = entries.find((entry) => entry.path === path);
    if (indexEntry === undefined) throw new Error(`Baseline ${path} must be tracked in the Git index.`);
    if (!/^(?:100644|100755)$/u.test(indexEntry.mode)) {
      throw new Error(`Baseline ${path} must be a regular tracked file.`);
    }
    const commit = runGit(cwd, ["rev-parse", "--verify", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const treeRecord = runGit(cwd, ["ls-tree", "-z", "HEAD", "--", path], { encoding: "utf8" }).stdout;
    const match = /^(\d{6}) blob ([0-9a-f]{40,64})\t([^\0]+)\0$/u.exec(treeRecord);
    if (match === null || match[3] !== path) {
      throw new Error(`Baseline ${path} must exist as a regular file in HEAD.`);
    }
    if (match[1] !== indexEntry.mode || match[2] !== indexEntry.oid) {
      throw new Error(`Baseline ${path} must be unchanged between HEAD and the Git index.`);
    }
    if (listUnstagedPaths(cwd).includes(path)) {
      throw new Error(`Baseline ${path} must have no unstaged changes.`);
    }
    bytes = readFileSync(absolutePath);
    const indexedBytes = readIndexBlobs(cwd, [indexEntry]).get(indexEntry.oid);
    if (indexedBytes === undefined || !bytes.equals(indexedBytes)) {
      throw new Error(`Baseline ${path} worktree bytes must match its committed blob.`);
    }
    evidence = {
      source: "committed-git-blob",
      path,
      commit,
      gitBlobOid: indexEntry.oid,
      contentSha256: sha256(bytes),
    };
  } else {
    bytes = readFileSync(absolutePath);
    evidence = {
      source: "worktree-file",
      path,
      contentSha256: sha256(bytes),
    };
  }
  const snapshot = JSON.parse(utf8Decoder.decode(bytes));
  validateComplexitySnapshot(snapshot);
  if (requireCommitted && snapshot.issues.length > 0) {
    throw new Error(`Committed baseline ${path} contains report issues.`);
  }
  return {
    snapshot,
    evidence: {
      ...evidence,
      snapshotSha256: snapshot.snapshotSha256,
      manifestSha256: snapshot.manifestSha256,
      policySha256: snapshot.policySha256,
    },
  };
}

export function evaluateGate(snapshot, gate) {
  const gateIndex = GATE_ORDER.indexOf(gate);
  if (gateIndex === -1) throw new Error(`Unknown gate ${gate}.`);
  const failures = [...snapshot.issues];
  for (const budget of snapshot.budgets) {
    if (GATE_ORDER.indexOf(budget.enforceAt) > gateIndex) continue;
    if (budget.requireOwners === true && budget.missingOwners.length > 0) {
      failures.push(`${budget.id} is missing required owners: ${budget.missingOwners.join(", ")}`);
    }
    if (budget.actualLines > budget.maxLines) {
      failures.push(`${budget.id} has ${budget.actualLines} lines, exceeding ${budget.maxLines}`);
    }
  }
  for (const family of snapshot.inventory.implementationFamilies) {
    if (GATE_ORDER.indexOf(family.enforceAt) <= gateIndex && family.activeMembers > family.maxMembers) {
      failures.push(`${family.id} has ${family.activeMembers} implementations, exceeding ${family.maxMembers}`);
    }
  }
  if (snapshot.inventory.dependencyGraph.cycles.length > 0) {
    failures.push(`workspace production dependency graph contains ${snapshot.inventory.dependencyGraph.cycles.length} cycle(s)`);
  }
  return [...new Set(failures)].sort(compareText);
}

export function collectComplexitySnapshot({
  cwd = process.cwd(),
  policyPath = "refactor/v1-complexity-policy.json",
  catalog,
} = {}) {
  const entries = listIndexEntries(cwd);
  const blobsByOid = readIndexBlobs(cwd, entries);
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const policyEntry = entryByPath.get(policyPath);
  if (policyEntry === undefined) throw new Error(`${policyPath} must be tracked in the Git index.`);
  const policyBytes = blobsByOid.get(policyEntry.oid);
  if (policyBytes === undefined) throw new Error(`Unable to read indexed policy ${policyPath}.`);
  const policy = JSON.parse(utf8Decoder.decode(policyBytes));
  const policyErrors = validateComplexityPolicy(policy);
  if (policyErrors.length > 0) throw new Error(`Invalid v1 complexity policy:\n- ${policyErrors.join("\n- ")}`);

  const resolvedCatalog = catalog ?? loadIndexedPackageCatalog({ entries, blobsByOid });

  const unstagedPaths = listUnstagedPaths(cwd);
  const manifest = buildFileManifest({ entries, blobsByOid, policy, catalog: resolvedCatalog, unstagedPaths });
  const relevantInventoryPaths = new Set([
    policyPath,
    PACKAGE_CATALOG_PATH,
    ...(policy.configSchemaPath === null ? [] : [policy.configSchemaPath]),
    ...resolvedCatalog.map((entry) => `${catalogPath(entry)}/package.json`),
  ]);
  const extraIssues = unstagedPaths
    .filter((path) => relevantInventoryPaths.has(path))
    .map((path) => `${path} has unstaged report-input changes`);
  return buildComplexitySnapshot({
    manifest,
    policy,
    entries,
    blobsByOid,
    catalog: resolvedCatalog,
    extraIssues,
  });
}

/**
 * Load the catalog through its stage-0 blob, never through the live worktree
 * module. The catalog is executable JavaScript rather than JSON, so evaluate it
 * in an isolated, code-generation-disabled VM and retain only the fields the
 * complexity inventory owns. The indexed packageRelativePath implementation is
 * used too, keeping optional extras paths authoritative without a second path
 * convention in this report.
 */
export function loadIndexedPackageCatalog({ entries, blobsByOid, path = PACKAGE_CATALOG_PATH }) {
  const entry = entries.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`${path} must be tracked in the Git index.`);
  if (!/^(?:100644|100755)$/u.test(entry.mode)) {
    throw new Error(`${path} must be a regular tracked file.`);
  }
  const bytes = blobsByOid.get(entry.oid);
  if (bytes === undefined) throw new Error(`Unable to read indexed package catalog ${path}.`);
  if (bytes.includes(0)) throw new Error(`Indexed package catalog ${path} contains NUL bytes.`);

  let source;
  try {
    source = normalizeSourceText(utf8Decoder.decode(bytes));
  } catch (error) {
    throw new Error(`Indexed package catalog ${path} is not valid UTF-8: ${reasonOf(error)}`);
  }
  const script = `${source.replace(
    /^export\s+(?=(?:const|let|var|function|class)\b)/gmu,
    "",
  )}\n;JSON.stringify(packageCatalog.map((entry) => ({\n  name: entry.name,\n  publishable: entry.publishable,\n  path: packageRelativePath(entry),\n})));\n`;

  let serialized;
  try {
    serialized = runInNewContext(script, Object.create(null), {
      contextCodeGeneration: { strings: false, wasm: false },
      filename: `${path} (stage-0 catalog evaluation)`,
      timeout: 1_000,
    });
  } catch (error) {
    throw new Error(`Unable to evaluate indexed package catalog ${path}: ${reasonOf(error)}`);
  }
  if (typeof serialized !== "string") {
    throw new Error(`Indexed package catalog ${path} did not produce a JSON inventory.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Indexed package catalog ${path} produced invalid JSON: ${reasonOf(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Indexed package catalog ${path} must contain at least one package.`);
  }

  const names = new Set();
  const paths = new Set();
  return parsed.map((raw, index) => {
    const label = `indexed package catalog entry ${index}`;
    if (!isRecord(raw)) throw new Error(`${label} must be an object.`);
    if (typeof raw.name !== "string" || raw.name.length === 0 || names.has(raw.name)) {
      throw new Error(`${label}.name must be a unique non-empty string.`);
    }
    if (typeof raw.publishable !== "boolean") {
      throw new Error(`${label}.publishable must be boolean.`);
    }
    if (!isSafePath(raw.path)
      || (!raw.path.startsWith("packages/") && !raw.path.startsWith("extras/"))
      || paths.has(raw.path)) {
      throw new Error(`${label}.path must be a unique safe packages/ or extras/ path.`);
    }
    names.add(raw.name);
    paths.add(raw.path);
    return { name: raw.name, path: raw.path, publishable: raw.publishable };
  });
}

/** Capture the exact committed tree a gate report claims to measure. */
export function collectTrackedTreeEvidence({ cwd = process.cwd() } = {}) {
  const commit = runGit(cwd, ["rev-parse", "--verify", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const tree = runGit(cwd, ["rev-parse", "--verify", "HEAD^{tree}"], { encoding: "utf8" }).stdout.trim();
  const stagedPaths = listChangedPaths(cwd, ["diff", "--cached", "--name-only", "-z", "HEAD", "--"]);
  const unstagedPaths = listUnstagedPaths(cwd);
  return {
    source: "git-head",
    commit,
    tree,
    trackedClean: stagedPaths.length === 0 && unstagedPaths.length === 0,
    stagedPaths,
    unstagedPaths,
  };
}

function buildInventory({ files, entries, blobsByOid, policy, catalog, issues }) {
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const packageRecords = [];
  const packageNames = new Set(catalog.map((entry) => entry.name));
  for (const catalogEntry of [...catalog].sort((left, right) => compareText(catalogPath(left), catalogPath(right)))) {
    const path = catalogPath(catalogEntry);
    const manifestPath = `${path}/package.json`;
    let manifest;
    try {
      manifest = parseJsonBlob(manifestPath, entryByPath, blobsByOid);
    } catch (error) {
      issues.push(`${manifestPath}: ${reasonOf(error)}`);
      continue;
    }
    packageRecords.push({ catalogEntry, path, manifest });
  }

  const dependencyEdges = [];
  for (const record of packageRecords) {
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const dependencies = isRecord(record.manifest[section]) ? record.manifest[section] : {};
      for (const dependency of Object.keys(dependencies).sort(compareText)) {
        if (packageNames.has(dependency)) {
          dependencyEdges.push({ from: record.catalogEntry.name, to: dependency, kind: section });
        }
      }
    }
  }
  dependencyEdges.sort((left, right) => compareText(left.from, right.from)
    || compareText(left.to, right.to)
    || compareText(left.kind, right.kind));
  const cycles = dependencyCycles(packageNames, dependencyEdges);

  const exportSubpaths = [];
  for (const record of packageRecords) {
    for (const subpath of codeExportSubpaths(record.manifest.exports)) {
      exportSubpaths.push({ package: record.catalogEntry.name, subpath });
    }
  }
  exportSubpaths.sort((left, right) => compareText(left.package, right.package) || compareText(left.subpath, right.subpath));

  let configSchema = null;
  if (policy.configSchemaPath !== null) {
    try {
      const entry = entryByPath.get(policy.configSchemaPath);
      if (entry === undefined) throw new Error("is not tracked");
      const bytes = blobsByOid.get(entry.oid);
      if (bytes === undefined) throw new Error("blob is unavailable");
      const text = normalizeSourceText(utf8Decoder.decode(bytes));
      const schema = JSON.parse(text);
      const fields = configSchemaFields(schema);
      configSchema = {
        path: policy.configSchemaPath,
        propertyNodes: fields.propertyNodes,
        leafFields: fields.leafPaths.length,
        leafFieldsSha256: sha256(fields.leafPaths.join("\n") + "\n"),
        contentSha256: sha256(text),
      };
    } catch (error) {
      issues.push(`${policy.configSchemaPath}: ${reasonOf(error)}`);
    }
  }

  const productionLinesByOwner = new Map(ownerTotals(files).map((owner) => [
    owner.owner,
    owner.byClassification.production.lines,
  ]));
  const manifestsByName = new Map(packageRecords.map((record) => [record.catalogEntry.name, record]));
  const adjacency = new Map([...packageNames].map((name) => [name, []]));
  for (const edge of dependencyEdges) adjacency.get(edge.from)?.push(edge.to);
  const closures = policy.closures.map((closure) => {
    const missingRoots = closure.roots.filter((name) => !packageNames.has(name));
    for (const name of missingRoots) issues.push(`closure ${closure.id} references missing package ${name}`);
    const names = transitiveClosure(
      closure.roots.filter((name) => packageNames.has(name)),
      adjacency,
    );
    const nativeDependencies = new Set();
    let productionLines = 0;
    for (const name of names) {
      const record = manifestsByName.get(name);
      if (record === undefined) continue;
      productionLines += productionLinesByOwner.get(record.path) ?? 0;
      const dependencies = {
        ...(isRecord(record.manifest.dependencies) ? record.manifest.dependencies : {}),
        ...(isRecord(record.manifest.optionalDependencies) ? record.manifest.optionalDependencies : {}),
        ...(isRecord(record.manifest.peerDependencies) ? record.manifest.peerDependencies : {}),
      };
      for (const dependency of policy.knownNativeDependencies) {
        if (Object.hasOwn(dependencies, dependency)) nativeDependencies.add(dependency);
      }
    }
    return {
      id: closure.id,
      roots: closure.roots,
      packageNames: names,
      packageCount: names.length,
      productionLines,
      knownNativeDependencies: [...nativeDependencies].sort(compareText),
    };
  });

  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const implementationFamilies = policy.implementationFamilies.map((family) => {
    const missingMembers = family.members.filter((path) => !fileByPath.has(path));
    return {
      id: family.id,
      members: family.members,
      activeMembers: family.members.length - missingMembers.length,
      missingMembers,
      maxMembers: family.maxMembers,
      enforceAt: family.enforceAt,
    };
  });

  return {
    workspacePackages: {
      total: packageRecords.length,
      publishable: packageRecords.filter((record) => record.catalogEntry.publishable === true).length,
    },
    publicCodeExportSubpaths: {
      total: exportSubpaths.length,
      entries: exportSubpaths,
    },
    dependencyGraph: {
      edges: dependencyEdges,
      edgeCount: dependencyEdges.length,
      cycles,
    },
    configSchema,
    closures,
    implementationFamilies,
  };
}

function vendoredProvenanceIssues(policy, entries, blobsByOid) {
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const issues = [];
  for (const rule of policy.vendoredRules) {
    const entry = entryByPath.get(rule.licensePath);
    if (entry === undefined) {
      issues.push(`vendored rule ${rule.id} license ${rule.licensePath} is not tracked`);
    } else if (!/^(?:100644|100755)$/u.test(entry.mode) || !blobsByOid.has(entry.oid)) {
      issues.push(`vendored rule ${rule.id} license ${rule.licensePath} is not a readable regular file`);
    }
  }
  return issues;
}

function buildBudgets(policy, totals, byOwner) {
  const byOwnerMap = new Map(byOwner.map((entry) => [entry.owner, entry]));
  return policy.budgets.map((budget) => {
    const owners = budget.owners ?? [];
    const actualLines = owners.length === 0
      ? totals.byClassification[budget.classification].lines
      : owners.reduce((sum, owner) => sum + (byOwnerMap.get(owner)?.byClassification[budget.classification].lines ?? 0), 0);
    return {
      id: budget.id,
      classification: budget.classification,
      owners,
      actualLines,
      maxLines: budget.maxLines,
      enforceAt: budget.enforceAt,
      requireOwners: budget.requireOwners === true,
      missingOwners: owners.filter((owner) => !byOwnerMap.has(owner)),
      withinLimit: actualLines <= budget.maxLines,
    };
  });
}

function totalsForFiles(files) {
  const byClassification = Object.fromEntries(CLASSIFICATIONS.map((classification) => [
    classification,
    { files: 0, lines: 0 },
  ]));
  for (const file of files) {
    const bucket = byClassification[file.classification];
    if (bucket === undefined) throw new Error(`Unknown file classification ${file.classification}.`);
    bucket.files += 1;
    bucket.lines += file.lines;
  }
  return {
    allExecutable: {
      files: files.length,
      lines: files.reduce((sum, file) => sum + file.lines, 0),
    },
    byClassification,
  };
}

function ownerTotals(files) {
  const owners = new Map();
  for (const file of files) {
    let owner = owners.get(file.owner);
    if (owner === undefined) {
      owner = Object.fromEntries(CLASSIFICATIONS.map((classification) => [classification, { files: 0, lines: 0 }]));
      owners.set(file.owner, owner);
    }
    owner[file.classification].files += 1;
    owner[file.classification].lines += file.lines;
  }
  return [...owners]
    .sort(([left], [right]) => compareText(left, right))
    .map(([owner, byClassification]) => ({ owner, byClassification }));
}

function listIndexEntries(cwd) {
  const result = runGit(cwd, ["ls-files", "--stage", "-z"], { encoding: "utf8" });
  const entries = [];
  const seen = new Set();
  for (const raw of result.stdout.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/u.exec(raw);
    if (match === null) throw new Error(`Malformed git ls-files record: ${JSON.stringify(raw)}.`);
    const [, mode, oid, stage, path] = match;
    if (stage !== "0") throw new Error(`Unmerged index stage ${stage} for ${path}.`);
    if (!isSafePath(path) || /[\r\n]/u.test(path)) throw new Error(`Unsafe tracked path ${JSON.stringify(path)}.`);
    if (seen.has(path)) throw new Error(`Duplicate tracked path ${path}.`);
    seen.add(path);
    entries.push({ mode, oid, path });
  }
  return entries.sort((left, right) => compareText(left.path, right.path));
}

function readIndexBlobs(cwd, entries) {
  const oids = [...new Set(entries.filter((entry) => entry.mode !== "160000").map((entry) => entry.oid))].sort(compareText);
  if (oids.length === 0) return new Map();
  const result = runGit(cwd, ["cat-file", "--batch"], {
    input: `${oids.join("\n")}\n`,
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
  });
  const output = result.stdout;
  const blobs = new Map();
  let offset = 0;
  for (const requestedOid of oids) {
    const newline = output.indexOf(10, offset);
    if (newline === -1) throw new Error(`git cat-file omitted header for ${requestedOid}.`);
    const header = output.subarray(offset, newline).toString("utf8");
    const match = /^([0-9a-f]{40,64}) blob (\d+)$/u.exec(header);
    if (match === null || match[1] !== requestedOid) throw new Error(`Unexpected git cat-file header ${header}.`);
    const size = Number(match[2]);
    const start = newline + 1;
    const end = start + size;
    if (!Number.isSafeInteger(size) || end >= output.length || output[end] !== 10) {
      throw new Error(`Malformed git cat-file payload for ${requestedOid}.`);
    }
    blobs.set(requestedOid, output.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== output.length) throw new Error("git cat-file returned unexpected trailing bytes.");
  return blobs;
}

function listUnstagedPaths(cwd) {
  return listChangedPaths(cwd, ["diff", "--name-only", "-z", "--"]);
}

function listChangedPaths(cwd, args) {
  const result = runGit(cwd, args, { encoding: "utf8" });
  return result.stdout.split("\0").filter(Boolean).sort(compareText);
}

function runGit(cwd, args, options) {
  const result = spawnSync("git", args, {
    cwd,
    env: process.env,
    encoding: options.encoding,
    input: options.input,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
    throw new Error(`git ${args.join(" ")} failed: ${String(stderr).trim()}`);
  }
  return result;
}

function parseJsonBlob(path, entryByPath, blobsByOid) {
  const entry = entryByPath.get(path);
  if (entry === undefined) throw new Error("is not tracked");
  const bytes = blobsByOid.get(entry.oid);
  if (bytes === undefined) throw new Error("blob is unavailable");
  return JSON.parse(utf8Decoder.decode(bytes));
}

export function configSchemaFields(schema) {
  if (!isRecord(schema)) throw new Error("config schema must be a JSON object");
  const propertyPaths = new Set();
  const visitedNodes = new WeakMap();
  const activeRefs = new Set();

  function visit(node, prefix) {
    if (typeof node === "boolean" || node === undefined) return;
    if (!isRecord(node)) throw new Error(`schema node at ${prefix || "<root>"} must be an object or boolean`);

    let prefixes = visitedNodes.get(node);
    if (prefixes === undefined) {
      prefixes = new Set();
      visitedNodes.set(node, prefixes);
    }
    if (prefixes.has(prefix)) return;
    prefixes.add(prefix);

    if (node.$ref !== undefined) {
      if (typeof node.$ref !== "string" || (node.$ref !== "#" && !node.$ref.startsWith("#/"))) {
        throw new Error(`unsupported config schema reference ${String(node.$ref)}`);
      }
      const refKey = `${node.$ref}\0${prefix}`;
      if (!activeRefs.has(refKey)) {
        activeRefs.add(refKey);
        visit(resolveLocalSchemaRef(schema, node.$ref), prefix);
        activeRefs.delete(refKey);
      }
    }

    if (node.properties !== undefined && !isRecord(node.properties)) {
      throw new Error(`properties at ${prefix || "<root>"} must be an object`);
    }
    for (const key of Object.keys(node.properties ?? {}).sort(compareText)) {
      const path = appendSchemaPath(prefix, key);
      propertyPaths.add(path);
      visit(node.properties[key], path);
    }

    if (node.patternProperties !== undefined && !isRecord(node.patternProperties)) {
      throw new Error(`patternProperties at ${prefix || "<root>"} must be an object`);
    }
    for (const pattern of Object.keys(node.patternProperties ?? {}).sort(compareText)) {
      const path = appendSchemaPath(prefix, `{${pattern}}`);
      propertyPaths.add(path);
      visit(node.patternProperties[pattern], path);
    }

    for (const [keyword, marker] of [
      ["additionalProperties", "*"],
      ["unevaluatedProperties", "**"],
    ]) {
      const child = node[keyword];
      if (isRecord(child)) {
        const path = appendSchemaPath(prefix, marker);
        propertyPaths.add(path);
        visit(child, path);
      } else if (child !== undefined && typeof child !== "boolean") {
        throw new Error(`${keyword} at ${prefix || "<root>"} must be an object or boolean`);
      }
    }

    if (node.items !== undefined) visit(node.items, `${prefix}[]`);
    if (Array.isArray(node.prefixItems)) {
      for (const [index, child] of node.prefixItems.entries()) visit(child, `${prefix}[${index}]`);
    } else if (node.prefixItems !== undefined) {
      throw new Error(`prefixItems at ${prefix || "<root>"} must be an array`);
    }
    if (node.contains !== undefined) visit(node.contains, `${prefix}[]`);

    for (const keyword of ["allOf", "anyOf", "oneOf"]) {
      const branches = node[keyword];
      if (branches === undefined) continue;
      if (!Array.isArray(branches)) throw new Error(`${keyword} at ${prefix || "<root>"} must be an array`);
      for (const branch of branches) visit(branch, prefix);
    }
    for (const keyword of ["if", "then", "else", "not"]) {
      if (node[keyword] !== undefined) visit(node[keyword], prefix);
    }
    if (node.dependentSchemas !== undefined && !isRecord(node.dependentSchemas)) {
      throw new Error(`dependentSchemas at ${prefix || "<root>"} must be an object`);
    }
    for (const child of Object.values(node.dependentSchemas ?? {})) visit(child, prefix);
  }

  visit(schema, "");
  const sortedPaths = [...propertyPaths].sort(compareText);
  const leafPaths = sortedPaths.filter((candidate) => !sortedPaths.some((other) => (
    other !== candidate
      && (other.startsWith(`${candidate}.`)
        || other.startsWith(`${candidate}[`))
  )));
  return { propertyNodes: sortedPaths.length, leafPaths };
}

function appendSchemaPath(prefix, segment) {
  return prefix.length === 0 ? segment : `${prefix}.${segment}`;
}

function resolveLocalSchemaRef(root, ref) {
  if (ref === "#") return root;
  let value = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (!isRecord(value) || !Object.hasOwn(value, segment)) {
      throw new Error(`unresolved config schema reference ${ref}`);
    }
    value = value[segment];
  }
  if (typeof value !== "boolean" && !isRecord(value)) {
    throw new Error(`config schema reference ${ref} does not target a schema`);
  }
  return value;
}

function codeExportSubpaths(exportsValue) {
  if (exportsValue === undefined) return [];
  const entries = isRecord(exportsValue) && Object.keys(exportsValue).some((key) => key.startsWith("."))
    ? Object.entries(exportsValue).filter(([key]) => key.startsWith("."))
    : [[".", exportsValue]];
  return entries
    .filter(([, target]) => exportTargetContainsCode(target))
    .map(([subpath]) => subpath)
    .sort(compareText);
}

function exportTargetContainsCode(target) {
  if (typeof target === "string") return /\.(?:cjs|js|jsx|mjs)$/u.test(target);
  if (Array.isArray(target)) return target.some((entry) => exportTargetContainsCode(entry));
  if (isRecord(target)) return Object.values(target).some((entry) => exportTargetContainsCode(entry));
  return false;
}

function dependencyCycles(packageNames, edges) {
  const adjacency = new Map([...packageNames].sort(compareText).map((name) => [name, []]));
  for (const edge of edges) adjacency.get(edge.from)?.push(edge.to);
  for (const dependencies of adjacency.values()) dependencies.sort(compareText);
  const indexByName = new Map();
  const lowByName = new Map();
  const active = new Set();
  const stack = [];
  const cycles = [];
  let nextIndex = 0;
  function visit(name) {
    indexByName.set(name, nextIndex);
    lowByName.set(name, nextIndex);
    nextIndex += 1;
    stack.push(name);
    active.add(name);
    for (const dependency of adjacency.get(name) ?? []) {
      if (!indexByName.has(dependency)) {
        visit(dependency);
        lowByName.set(name, Math.min(lowByName.get(name), lowByName.get(dependency)));
      } else if (active.has(dependency)) {
        lowByName.set(name, Math.min(lowByName.get(name), indexByName.get(dependency)));
      }
    }
    if (lowByName.get(name) !== indexByName.get(name)) return;
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      active.delete(member);
      component.push(member);
      if (member === name) break;
    }
    component.sort(compareText);
    const selfCycle = component.length === 1 && (adjacency.get(component[0]) ?? []).includes(component[0]);
    if (component.length > 1 || selfCycle) cycles.push(component);
  }
  for (const name of adjacency.keys()) if (!indexByName.has(name)) visit(name);
  return cycles.sort((left, right) => compareText(left.join("\0"), right.join("\0")));
}

function transitiveClosure(roots, adjacency) {
  const seen = new Set();
  function visit(name) {
    if (seen.has(name)) return;
    seen.add(name);
    for (const dependency of adjacency.get(name) ?? []) visit(dependency);
  }
  for (const root of roots) visit(root);
  return [...seen].sort(compareText);
}

function matchingRules(path, rules, classification) {
  return rules.filter((rule) => matchesPath(path, rule.match)).map((rule) => ({ rule, classification }));
}

function matchesPath(path, match) {
  return (match.paths ?? []).includes(path)
    || (match.prefixes ?? []).some((prefix) => path.startsWith(prefix))
    || (match.suffixes ?? []).some((suffix) => path.endsWith(suffix));
}

function isTestPath(path, policy) {
  const segments = path.split("/");
  if (segments.some((segment) => policy.testPathSegments.includes(segment))) return true;
  const filename = segments.at(-1) ?? path;
  return policy.testFilenameMarkers.some((marker) => filename.includes(marker));
}

function sourceExtensionOf(path) {
  if (/\.d\.(?:cts|mts|ts)$/u.test(path)) return extname(path);
  return extname(path);
}

function ownerForPath(path, catalog) {
  const catalogPaths = catalog
    .map((entry) => catalogPath(entry))
    .sort((left, right) => right.length - left.length || compareText(left, right));
  const catalogOwner = catalogPaths.find((candidate) => path.startsWith(`${candidate}/`));
  if (catalogOwner !== undefined) return catalogOwner;
  const segments = path.split("/");
  if (["packages", "extras"].includes(segments[0]) && segments.length >= 2) return `${segments[0]}/${segments[1]}`;
  return segments.length === 1 ? "repo:root" : `repo:${segments[0]}`;
}

function catalogPath(entry) {
  return entry.path ?? `packages/${entry.dir}`;
}

function allPolicyRules(policy) {
  return [
    ...policy.generatedRules,
    ...policy.vendoredRules,
    ...policy.excludedRules,
    ...policy.nonShippingRules,
  ];
}

function validateMatch(match, label, errors) {
  if (!isRecord(match)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const keys = Object.keys(match);
  if (keys.length === 0 || keys.some((key) => !["paths", "prefixes", "suffixes"].includes(key))) {
    errors.push(`${label} must contain only paths, prefixes, or suffixes`);
  }
  let values = 0;
  for (const key of ["paths", "prefixes", "suffixes"]) {
    if (match[key] === undefined) continue;
    const predicate = key === "paths" ? isSafePath : key === "prefixes" ? isSafePrefix : (value) => value.startsWith(".");
    validateUniqueStrings(match[key], `${label}.${key}`, errors, predicate);
    if (Array.isArray(match[key])) values += match[key].length;
  }
  if (values === 0) errors.push(`${label} must match at least one path`);
}

function validateArgvCommand(command, label, errors) {
  if (!isRecord(command)) {
    errors.push(`${label} must be an object`);
    return;
  }
  validateObjectKeys(command, label, ["args", "command"], ["args", "command"], errors);
  if (typeof command.command !== "string" || command.command.length === 0) {
    errors.push(`${label}.command must be a non-empty string`);
  }
  if (!Array.isArray(command.args) || command.args.some((arg) => typeof arg !== "string")) {
    errors.push(`${label}.args must be a string array`);
  }
}

function validateUniqueStrings(value, label, errors, predicate = () => true, requireNonEmpty = false) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    errors.push(`${label} must be an array of non-empty strings`);
    return;
  }
  if (requireNonEmpty && value.length === 0) errors.push(`${label} must not be empty`);
  if (new Set(value).size !== value.length) errors.push(`${label} must not contain duplicates`);
  if (value.some((entry) => !predicate(entry))) errors.push(`${label} contains an invalid value`);
}

function validateObjectKeys(value, label, allowedKeys, requiredKeys, errors) {
  if (!isRecord(value)) return;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value).sort(compareText)) {
    if (!allowed.has(key)) errors.push(`${label} contains unknown key ${key}`);
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) errors.push(`${label} is missing required key ${key}`);
  }
}

function validateRequiredBindings(actualBindings, requiredBindings, kind, errors) {
  if (!Array.isArray(actualBindings)) return;
  for (const required of requiredBindings) {
    const actual = actualBindings.find((entry) => isRecord(entry) && entry.id === required.id);
    if (actual === undefined) {
      errors.push(`required ${kind} ${required.id} is missing`);
      continue;
    }
    if (canonicalJson(actual) !== canonicalJson(required)) {
      errors.push(`required ${kind} ${required.id} must exactly match its binding contract`);
    }
  }
}

function isSafePath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.split("/").includes("..")
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isSafePrefix(value) {
  return isSafePath(value) && value.endsWith("/");
}

function isSafeOwner(value) {
  return isSafePath(value) || /^repo:[a-z0-9-]+$/u.test(value);
}

function isSafeHttpsUrl(value) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, stableValue(value[key])]));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}
