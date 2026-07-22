import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, extname, posix as pathPosix, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { TextDecoder } from "node:util";
import { runInNewContext } from "node:vm";

export const COMPLEXITY_REPORT_SCHEMA = "mono-agent.v1-complexity-report.v1";
export const COMPLEXITY_POLICY_SCHEMA = "mono-agent.v1-complexity-inventory-policy.v1";
export const COMPLEXITY_CLASSIFICATION_AUTHORITY_SCHEMA = "mono-agent.v1-complexity-classification-authority.v1";
export const COMPLEXITY_G0_AUTHORITY_SCHEMA = "mono-agent.v1-complexity-g0-authority.v1";
export const COMPLEXITY_ALGORITHM_VERSION = 2;

const PACKAGE_CATALOG_PATH = "scripts/package-catalog.mjs";
const CLASSIFICATION_AUTHORITY_PATH = "refactor/v1-complexity-classification-authority.json";
const INVENTORY_POLICY_PATH = "refactor/v1-complexity-policy.json";
const G0_BASELINE_PATH = "refactor/baselines/v1-complexity-baseline.json";
export const G0_AUTHORITY_PATH = "refactor/baselines/v1-complexity-g0-authority.json";
export const G0_AUTHORITY_REF = "refs/tags/authority/v1-complexity-g0";

export const SOURCE_EXTENSIONS = Object.freeze([
  ".bash",
  ".cjs",
  ".css",
  ".cts",
  ".gql",
  ".graphql",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".jsonc",
  ".md",
  ".mjs",
  ".mts",
  ".py",
  ".sh",
  ".sql",
  ".svg",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml",
  ".zsh",
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

const INVENTORY_POLICY_KEYS = Object.freeze([
  "budgets",
  "classificationAuthorityPath",
  "closures",
  "configSchemaPath",
  "excludedFiles",
  "generatedFiles",
  "implementationFamilies",
  "knownNativeDependencies",
  "schema",
  "vendoredFiles",
]);

const CLASSIFICATION_AUTHORITY_KEYS = Object.freeze([
  "algorithmVersion",
  "binaryAssetExtensions",
  "buildConfigFilenameMarkers",
  "declarationSuffixes",
  "executableExtensions",
  "nonShippingRules",
  "packageDocumentationNames",
  "packageMetadataNames",
  "packageTextExtensions",
  "productionRoots",
  "schema",
  "sourceDirectorySegments",
  "testFilenameMarkers",
  "testPathSegments",
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
    detection: Object.freeze({
      allContentMarkers: Object.freeze(["/v1/turns", "application/x-ndjson", "fetchImpl"]),
      pathPrefixes: Object.freeze(["extras/", "packages/"]),
    }),
    minMembers: 1,
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

export function validateComplexityClassificationAuthority(authority) {
  const errors = [];
  if (!isRecord(authority)) return ["classification authority must be a JSON object"];
  validateObjectKeys(
    authority,
    "classification authority",
    CLASSIFICATION_AUTHORITY_KEYS,
    CLASSIFICATION_AUTHORITY_KEYS,
    errors,
  );
  if (authority.schema !== COMPLEXITY_CLASSIFICATION_AUTHORITY_SCHEMA) {
    errors.push(`classification authority.schema must be ${COMPLEXITY_CLASSIFICATION_AUTHORITY_SCHEMA}`);
  }
  if (authority.algorithmVersion !== COMPLEXITY_ALGORITHM_VERSION) {
    errors.push(`classification authority.algorithmVersion must be exactly ${COMPLEXITY_ALGORITHM_VERSION}`);
  }
  for (const key of ["executableExtensions", "packageTextExtensions", "binaryAssetExtensions"]) {
    validateUniqueStrings(authority[key], key, errors, (value) => /^\.[a-z0-9]+$/u.test(value), true);
  }
  const sourceExtensions = [
    ...(Array.isArray(authority.executableExtensions) ? authority.executableExtensions : []),
    ...(Array.isArray(authority.packageTextExtensions) ? authority.packageTextExtensions : []),
  ].sort(compareText);
  if (canonicalJson(sourceExtensions) !== canonicalJson([...SOURCE_EXTENSIONS].sort(compareText))) {
    errors.push(`classification source extensions must exactly equal ${SOURCE_EXTENSIONS.join(", ")}`);
  }
  if (new Set(sourceExtensions).size !== sourceExtensions.length) {
    errors.push("executableExtensions and packageTextExtensions must not overlap");
  }
  validateUniqueStrings(authority.sourceDirectorySegments, "sourceDirectorySegments", errors, isSafeSegment, true);
  validateUniqueStrings(authority.testPathSegments, "testPathSegments", errors, isSafeSegment, true);
  validateUniqueStrings(authority.testFilenameMarkers, "testFilenameMarkers", errors, (value) => value.includes("."), true);
  validateUniqueStrings(authority.productionRoots, "productionRoots", errors, isSafePrefix, true);
  validateUniqueStrings(authority.declarationSuffixes, "declarationSuffixes", errors, (value) => value.startsWith("."), true);
  validateUniqueStrings(authority.packageDocumentationNames, "packageDocumentationNames", errors, isSafeFilename, true);
  validateUniqueStrings(authority.packageMetadataNames, "packageMetadataNames", errors, isSafeFilename, true);
  validateUniqueStrings(authority.buildConfigFilenameMarkers, "buildConfigFilenameMarkers", errors, isSafeFilenameMarker, true);
  if (!Array.isArray(authority.nonShippingRules)) {
    errors.push("nonShippingRules must be an array");
  } else {
    const ids = new Set();
    for (const [index, rule] of authority.nonShippingRules.entries()) {
      const label = `nonShippingRules[${index}]`;
      validateExactRule(rule, label, ids, errors);
      if (isRecord(rule?.match)) {
        const productionOverlap = [...(rule.match.paths ?? []), ...(rule.match.prefixes ?? [])]
          .some((path) => authority.productionRoots.some((root) => path.startsWith(root) || root.startsWith(path)));
        if (productionOverlap) errors.push(`${label} must not overlap a production root`);
      }
    }
  }
  return errors.sort(compareText);
}

export function validateComplexityPolicy(policy) {
  const errors = [];
  if (!isRecord(policy)) return ["inventory policy must be a JSON object"];
  validateObjectKeys(policy, "inventory policy", INVENTORY_POLICY_KEYS, INVENTORY_POLICY_KEYS, errors);
  if (policy.schema !== COMPLEXITY_POLICY_SCHEMA) {
    errors.push(`inventory policy.schema must be ${COMPLEXITY_POLICY_SCHEMA}`);
  }
  if (!isSafePath(policy.classificationAuthorityPath)) {
    errors.push("classificationAuthorityPath must be a safe repository-relative path");
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
        ["detection", "enforceAt", "id", "maxMembers", "minMembers", "registeredMember"],
        ["detection", "enforceAt", "id", "maxMembers", "minMembers", "registeredMember"],
        errors,
      );
      if (typeof family.id !== "string" || family.id.length === 0 || ids.has(family.id)) {
        errors.push(`${label}.id must be a unique non-empty string`);
      } else {
        ids.add(family.id);
      }
      if (!isRecord(family.detection)) {
        errors.push(`${label}.detection must be an object`);
      } else {
        validateObjectKeys(
          family.detection,
          `${label}.detection`,
          ["allContentMarkers", "pathPrefixes"],
          ["allContentMarkers", "pathPrefixes"],
          errors,
        );
        validateUniqueStrings(
          family.detection.allContentMarkers,
          `${label}.detection.allContentMarkers`,
          errors,
          (value) => value.trim() === value,
          true,
        );
        validateUniqueStrings(
          family.detection.pathPrefixes,
          `${label}.detection.pathPrefixes`,
          errors,
          isSafePrefix,
          true,
        );
      }
      if (family.registeredMember !== null && !isSafePath(family.registeredMember)) {
        errors.push(`${label}.registeredMember must be null or a safe repository-relative path`);
      }
      if (!Number.isSafeInteger(family.minMembers) || family.minMembers < 0) {
        errors.push(`${label}.minMembers must be a non-negative integer`);
      }
      if (!Number.isSafeInteger(family.maxMembers) || family.maxMembers < 0) {
        errors.push(`${label}.maxMembers must be a non-negative integer`);
      }
      if (Number.isSafeInteger(family.minMembers)
        && Number.isSafeInteger(family.maxMembers)
        && family.minMembers > family.maxMembers) {
        errors.push(`${label}.minMembers must not exceed maxMembers`);
      }
      if (!GATE_ORDER.includes(family.enforceAt)) errors.push(`${label}.enforceAt is invalid`);
    }
    validateRequiredImplementationFamilies(policy.implementationFamilies, errors);
  }

  const evidenceIds = new Set();
  const evidencePaths = new Set();
  for (const [group, requiredKeys] of [
    ["generatedFiles", ["contentSha256", "generator", "id", "path", "reason", "reproducibilityCheck"]],
    ["vendoredFiles", ["contentSha256", "id", "licensePath", "licenseSha256", "path", "reason", "upstream", "version"]],
    ["excludedFiles", ["contentSha256", "evidence", "id", "path", "reason"]],
  ]) {
    if (!Array.isArray(policy[group])) {
      errors.push(`${group} must be an array`);
      continue;
    }
    for (const [index, evidence] of policy[group].entries()) {
      const label = `${group}[${index}]`;
      if (!isRecord(evidence)) {
        errors.push(`${label} must be an object`);
        continue;
      }
      validateObjectKeys(evidence, label, requiredKeys, requiredKeys, errors);
      validateEvidenceIdentity(evidence, label, evidenceIds, evidencePaths, errors);
      if (group === "generatedFiles") {
        validateArgvCommand(evidence.generator, `${label}.generator`, errors);
        validateArgvCommand(evidence.reproducibilityCheck, `${label}.reproducibilityCheck`, errors);
      } else if (group === "vendoredFiles") {
        if (!isSafeHttpsUrl(evidence.upstream)) errors.push(`${label}.upstream must be an HTTPS URL without credentials`);
        if (typeof evidence.version !== "string" || !/^[^\s\u0000-\u001f\u007f]+$/u.test(evidence.version)) {
          errors.push(`${label}.version must be a non-empty whitespace-free version`);
        }
        if (!isSafePath(evidence.licensePath)) errors.push(`${label}.licensePath must be a safe repository-relative path`);
        validateSha256(evidence.licenseSha256, `${label}.licenseSha256`, errors);
      } else if (typeof evidence.evidence !== "string" || evidence.evidence.trim().length === 0) {
        errors.push(`${label}.evidence must be a non-empty review evidence string`);
      }
    }
  }
  return errors.sort(compareText);
}

export function resolveComplexityPolicy(classificationAuthority, inventoryPolicy) {
  const authorityErrors = validateComplexityClassificationAuthority(classificationAuthority);
  const inventoryErrors = validateComplexityPolicy(inventoryPolicy);
  if (authorityErrors.length > 0 || inventoryErrors.length > 0) {
    throw new Error([
      ...(authorityErrors.length === 0 ? [] : [`Invalid v1 classification authority:\n- ${authorityErrors.join("\n- ")}`]),
      ...(inventoryErrors.length === 0 ? [] : [`Invalid v1 inventory policy:\n- ${inventoryErrors.join("\n- ")}`]),
    ].join("\n"));
  }
  return {
    ...classificationAuthority,
    ...inventoryPolicy,
    sourceExtensions: [
      ...classificationAuthority.executableExtensions,
      ...classificationAuthority.packageTextExtensions,
    ].sort(compareText),
    generatedRules: inventoryPolicy.generatedFiles.map((entry) => evidenceRule(entry)),
    vendoredRules: inventoryPolicy.vendoredFiles.map((entry) => evidenceRule(entry)),
    excludedRules: inventoryPolicy.excludedFiles.map((entry) => evidenceRule(entry)),
    classificationAuthoritySha256: sha256(canonicalJson(classificationAuthority)),
    inventoryPolicySha256: sha256(canonicalJson(inventoryPolicy)),
  };
}

export function classifySourcePath(path, policy, context = {}) {
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
    if (match.classification === "excluded" && context.productionReachable === true) {
      return {
        classification: "unclassified",
        ruleId: "reachable-production-exclusion",
        issue: `${path} is production-reachable and cannot be downgraded to excluded`,
        matchedRuleIds: [match.rule.id],
      };
    }
    return { classification: match.classification, ruleId: match.rule.id, matchedRuleIds: [match.rule.id] };
  }

  if (policy.declarationSuffixes.some((suffix) => path.endsWith(suffix))) {
    return { classification: "excluded", ruleId: "typescript-declaration-only", matchedRuleIds: [] };
  }
  if (context.packageMetadataKind !== undefined) {
    return { classification: "excluded", ruleId: context.packageMetadataKind, matchedRuleIds: [] };
  }
  if (context.binaryRuntimeAsset === true) {
    return { classification: "excluded", ruleId: "binary-runtime-asset", matchedRuleIds: [] };
  }
  if (isTestPath(path, policy) && context.productionReachable !== true) {
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

export function buildFileManifest({
  entries,
  blobsByOid,
  policy,
  catalog = [],
  reachability = emptyReachability(),
  unstagedPaths = [],
}) {
  const files = [];
  const issues = [];
  const ruleUsage = new Map(allPolicyRules(policy).map((rule) => [rule.id, 0]));
  const executableExtensions = new Set(policy.executableExtensions);
  const packageTextExtensions = new Set(policy.packageTextExtensions);
  const binaryAssetExtensions = new Set(policy.binaryAssetExtensions);
  const unstaged = new Set(unstagedPaths);
  const ownership = buildCatalogOwnership(catalog);

  for (const entry of entries) {
    const bytes = blobsByOid.get(entry.oid);
    const extension = sourceExtensionOf(entry.path);
    const executableExtension = executableExtensions.has(extension);
    const executableMode = entry.mode === "100755";
    const hasShebang = bytes?.subarray(0, 2).toString("utf8") === "#!";
    const owner = exactOwnerForPath(entry.path, ownership);
    const underProductionRoot = policy.productionRoots.some((prefix) => entry.path.startsWith(prefix));
    const relativeToOwner = owner === undefined ? undefined : entry.path.slice(owner.length + 1);
    const productionRoot = policy.productionRoots.find((prefix) => entry.path.startsWith(prefix));
    const relativeToProductionRoot = productionRoot === undefined
      ? undefined
      : entry.path.slice(productionRoot.length).split("/").slice(1).join("/");
    const relativeSegments = (relativeToOwner ?? relativeToProductionRoot)?.split("/") ?? [];
    const sourceDirectory = relativeSegments.some((segment) => policy.sourceDirectorySegments.includes(segment));
    const packageMetadataKind = owner === undefined
      ? undefined
      : packageMetadataClassification(entry.path, relativeSegments, policy);
    const productionReachable = reachability.production.has(entry.path) || reachability.packed.has(entry.path);
    const packedRuntime = reachability.packed.has(entry.path);
    const packageText = packageTextExtensions.has(extension);
    const binaryRuntimeAsset = (productionReachable || packedRuntime) && binaryAssetExtensions.has(extension);
    const sourceCandidate = executableExtension
      || executableMode
      || hasShebang
      || productionReachable
      || packedRuntime
      || packageMetadataKind !== undefined
      || (underProductionRoot && sourceDirectory)
      || (owner !== undefined && packageText && isTestPath(entry.path, policy));
    if (!sourceCandidate) continue;

    if (!/^(?:100644|100755)$/u.test(entry.mode) || bytes === undefined) {
      const rawDigest = bytes === undefined ? null : sha256(bytes);
      files.push({
        path: entry.path,
        gitMode: entry.mode,
        owner: owner ?? ownerForPath(entry.path, catalog),
        classification: "unclassified",
        ruleId: "non-regular-source",
        lines: 0,
        contentSha256: rawDigest,
      });
      issues.push(`${entry.path} is source-shaped but is not a regular stage-0 blob`);
      continue;
    }

    const rawDigest = sha256(bytes);
    if (binaryRuntimeAsset) {
      files.push({
        path: entry.path,
        gitMode: entry.mode,
        owner: owner ?? ownerForPath(entry.path, catalog),
        classification: "excluded",
        ruleId: "binary-runtime-asset",
        lines: 0,
        contentSha256: rawDigest,
      });
      continue;
    }
    let text;
    try {
      if (bytes.includes(0)) throw new Error("contains NUL bytes");
      text = normalizeSourceText(utf8Decoder.decode(bytes));
    } catch (error) {
      files.push({
        path: entry.path,
        gitMode: entry.mode,
        owner: owner ?? ownerForPath(entry.path, catalog),
        classification: "unclassified",
        ruleId: "invalid-source-text",
        lines: 0,
        contentSha256: rawDigest,
      });
      issues.push(`${entry.path} is not valid UTF-8 source text: ${reasonOf(error)}`);
      continue;
    }

    if (underProductionRoot && owner === undefined) {
      issues.push(`${entry.path} is source-shaped under a package root but has no exact package-catalog owner`);
    }
    if (owner !== undefined
      && sourceDirectory
      && !executableExtension
      && !packageText
      && !productionReachable
      && !packedRuntime
      && packageMetadataKind === undefined
      && !isTestPath(entry.path, policy)) {
      issues.push(`${entry.path} has an unknown source extension under ${owner}`);
    }
    const classified = owner === undefined && underProductionRoot
      ? {
        classification: "unclassified",
        ruleId: "uncatalogued-package-source",
        matchedRuleIds: [],
      }
      : classifySourcePath(entry.path, policy, {
        binaryRuntimeAsset,
        packageMetadataKind,
        packedRuntime,
        productionReachable,
      });
    for (const id of classified.matchedRuleIds) ruleUsage.set(id, (ruleUsage.get(id) ?? 0) + 1);
    if (classified.issue !== undefined) issues.push(classified.issue);
    if (unstaged.has(entry.path)) issues.push(`${entry.path} has unstaged source changes`);
    files.push({
      path: entry.path,
      gitMode: entry.mode,
      owner: owner ?? ownerForPath(entry.path, catalog),
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
  reachability = emptyReachability(),
  extraIssues = [],
}) {
  const issues = [
    ...manifest.issues,
    ...extraIssues,
    ...evidenceBindingIssues(policy, entries, blobsByOid),
  ];
  const totals = totalsForFiles(manifest.files);
  const byOwner = ownerTotals(manifest.files);
  const inventory = buildInventory({
    files: manifest.files,
    entries,
    blobsByOid,
    policy,
    catalog,
    reachability,
    issues,
  });
  const budgets = buildBudgets(policy, totals, byOwner);
  const manifestJsonl = manifest.files.map((row) => canonicalJson(row)).join("\n") + "\n";
  const measuredSnapshot = {
    schema: COMPLEXITY_REPORT_SCHEMA,
    algorithmVersion: policy.algorithmVersion,
    classificationAuthoritySha256: policy.classificationAuthoritySha256,
    inventoryPolicySha256: policy.inventoryPolicySha256,
    // Retained as a compatibility alias while downstream evidence migrates to
    // the explicitly split authority/inventory digests.
    policySha256: policy.inventoryPolicySha256,
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
    classificationAuthorityMatches:
      current.classificationAuthoritySha256 === baseline.classificationAuthoritySha256,
    inventoryPolicyMatches: current.inventoryPolicySha256 === baseline.inventoryPolicySha256,
    policyMatches: current.inventoryPolicySha256 === baseline.inventoryPolicySha256,
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
  const paths = new Set();
  let previousPath = null;
  for (const [index, file] of snapshot.files.entries()) {
    if (!isRecord(file)) throw new Error(`Baseline file row ${index} must be an object.`);
    const keys = Object.keys(file).sort(compareText).join(",");
    if (keys !== "classification,contentSha256,gitMode,lines,owner,path,ruleId") {
      throw new Error(`Baseline file row ${index} must use the exact manifest schema.`);
    }
    if (!isSafePath(file.path) || paths.has(file.path)) {
      throw new Error(`Baseline file row ${index} path must be unique and repository-relative.`);
    }
    if (previousPath !== null && compareText(previousPath, file.path) >= 0) {
      throw new Error("Baseline file rows must be strictly path-sorted.");
    }
    paths.add(file.path);
    previousPath = file.path;
    if (typeof file.gitMode !== "string" || !/^\d{6}$/u.test(file.gitMode)) {
      throw new Error(`Baseline file row ${index} gitMode is invalid.`);
    }
    if (typeof file.owner !== "string" || file.owner.length === 0) {
      throw new Error(`Baseline file row ${index} owner is invalid.`);
    }
    if (!CLASSIFICATIONS.includes(file.classification)) {
      throw new Error(`Baseline file row ${index} classification is invalid.`);
    }
    if (typeof file.ruleId !== "string" || file.ruleId.length === 0) {
      throw new Error(`Baseline file row ${index} ruleId is invalid.`);
    }
    if (!Number.isSafeInteger(file.lines) || file.lines < 0) {
      throw new Error(`Baseline file row ${index} lines is invalid.`);
    }
    if (file.contentSha256 !== null
      && (typeof file.contentSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(file.contentSha256))) {
      throw new Error(`Baseline file row ${index} contentSha256 is invalid.`);
    }
  }
  if (snapshot.algorithmVersion !== COMPLEXITY_ALGORITHM_VERSION) {
    throw new Error(`Baseline algorithmVersion must be ${COMPLEXITY_ALGORITHM_VERSION}.`);
  }
  for (const key of [
    "classificationAuthoritySha256",
    "inventoryPolicySha256",
    "manifestSha256",
    "policySha256",
    "snapshotSha256",
  ]) {
    if (typeof snapshot[key] !== "string" || !/^[0-9a-f]{64}$/u.test(snapshot[key])) {
      throw new Error(`Baseline ${key} must be a lowercase SHA-256 digest.`);
    }
  }
  if (!Array.isArray(snapshot.issues) || snapshot.issues.some((issue) => typeof issue !== "string")) {
    throw new Error("Baseline issues must be a string array.");
  }
  if (snapshot.policySha256 !== snapshot.inventoryPolicySha256) {
    throw new Error("Baseline compatibility policy digest must equal inventoryPolicySha256.");
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

export function loadComplexityG0Authority({
  cwd = process.cwd(),
  path = G0_AUTHORITY_PATH,
  baselinePath,
  gate,
}) {
  if (!GATE_ORDER.includes(gate)) throw new Error(`Unknown gate ${String(gate)}.`);
  const currentAuthority = loadCommittedJsonBlob({ cwd, path });
  validateComplexityG0Authority(currentAuthority.value);
  if (baselinePath !== currentAuthority.value.baseline.path) {
    throw new Error(`Gate baseline must be the frozen authority path ${currentAuthority.value.baseline.path}.`);
  }

  const gateIndex = GATE_ORDER.indexOf(gate);
  const refExists = gitRefExists(cwd, currentAuthority.value.authorityRef);
  if (!refExists && gateIndex > 0) {
    throw new Error(`Annotated G0 authority ref ${currentAuthority.value.authorityRef} is required after G0.`);
  }

  let authority = currentAuthority;
  let refEvidence = {
    status: "pending-post-merge",
    ref: currentAuthority.value.authorityRef,
    annotated: false,
    commit: null,
  };
  if (refExists) {
    const objectType = runGit(cwd, ["cat-file", "-t", currentAuthority.value.authorityRef], { encoding: "utf8" }).stdout.trim();
    if (objectType !== "tag") {
      throw new Error(`G0 authority ref ${currentAuthority.value.authorityRef} must be an annotated tag object.`);
    }
    const commit = runGit(cwd, ["rev-parse", "--verify", `${currentAuthority.value.authorityRef}^{commit}`], {
      encoding: "utf8",
    }).stdout.trim();
    const tagBody = runGit(cwd, ["cat-file", "-p", currentAuthority.value.authorityRef], { encoding: "utf8" }).stdout;
    const anchoredBytes = readBlobAtCommit(cwd, commit, path);
    const anchoredSha256 = sha256(anchoredBytes);
    if (!tagBody.includes(`Complexity-Authority-SHA256: ${anchoredSha256}`)) {
      throw new Error(`Annotated G0 authority tag is missing its exact Complexity-Authority-SHA256 trailer.`);
    }
    if (!anchoredBytes.equals(currentAuthority.bytes)) {
      throw new Error(`Current G0 authority file differs from protected authority ref ${currentAuthority.value.authorityRef}.`);
    }
    authority = {
      value: JSON.parse(utf8Decoder.decode(anchoredBytes)),
      bytes: anchoredBytes,
      evidence: {
        source: "annotated-authority-ref",
        path,
        commit,
        contentSha256: anchoredSha256,
        gitBlobOid: gitBlobOidAtCommit(cwd, commit, path),
      },
    };
    validateComplexityG0Authority(authority.value);
    refEvidence = {
      status: "anchored",
      ref: authority.value.authorityRef,
      annotated: true,
      commit,
      authoritySha256: anchoredSha256,
    };
  }

  const baseline = authority.value === currentAuthority.value && !refExists
    ? loadComplexityBaseline({ cwd, path: baselinePath, requireCommitted: true })
    : loadComplexityBaselineAtCommit({
      cwd,
      commit: refEvidence.commit,
      path: baselinePath,
    });
  assertG0AuthorityBindings({
    cwd,
    authority: authority.value,
    baseline,
    commit: refEvidence.commit,
  });
  return {
    authority: authority.value,
    authorityEvidence: authority.evidence,
    refEvidence,
    baseline,
  };
}

export function validateComplexityG0Authority(authority) {
  if (!isRecord(authority) || authority.schema !== COMPLEXITY_G0_AUTHORITY_SCHEMA) {
    throw new Error(`G0 authority must use ${COMPLEXITY_G0_AUTHORITY_SCHEMA}.`);
  }
  const keys = [
    "algorithmVersion",
    "authorityRef",
    "baseline",
    "classificationAuthority",
    "initialInventoryPolicy",
    "postMergeRefContract",
    "schema",
    "totals",
  ];
  const errors = [];
  validateObjectKeys(authority, "G0 authority", keys, keys, errors);
  if (authority.algorithmVersion !== COMPLEXITY_ALGORITHM_VERSION) {
    errors.push(`G0 authority.algorithmVersion must be ${COMPLEXITY_ALGORITHM_VERSION}`);
  }
  if (authority.authorityRef !== G0_AUTHORITY_REF || releaseTagName(authority.authorityRef).startsWith("v")) {
    errors.push(`G0 authority.authorityRef must be non-release annotated tag ${G0_AUTHORITY_REF}`);
  }
  validateAuthorityArtifact(authority.baseline, "G0 authority.baseline", [
    "contentSha256", "gitBlobOid", "manifestSha256", "path", "snapshotSha256",
  ], errors);
  validateAuthorityArtifact(authority.classificationAuthority, "G0 authority.classificationAuthority", [
    "canonicalSha256", "contentSha256", "gitBlobOid", "path",
  ], errors);
  validateAuthorityArtifact(authority.initialInventoryPolicy, "G0 authority.initialInventoryPolicy", [
    "canonicalSha256", "contentSha256", "gitBlobOid", "path",
  ], errors);
  if (authority.baseline?.path !== G0_BASELINE_PATH) {
    errors.push(`G0 authority.baseline.path must be ${G0_BASELINE_PATH}`);
  }
  if (authority.classificationAuthority?.path !== CLASSIFICATION_AUTHORITY_PATH) {
    errors.push(`G0 authority.classificationAuthority.path must be ${CLASSIFICATION_AUTHORITY_PATH}`);
  }
  if (authority.initialInventoryPolicy?.path !== INVENTORY_POLICY_PATH) {
    errors.push(`G0 authority.initialInventoryPolicy.path must be ${INVENTORY_POLICY_PATH}`);
  }
  if (!isRecord(authority.totals)) {
    errors.push("G0 authority.totals must be an object");
  } else {
    validateObjectKeys(authority.totals, "G0 authority.totals", [
      "allAccounted", "excluded", "generated", "production", "test", "unclassified", "vendored",
    ], ["allAccounted", "excluded", "generated", "production", "test", "unclassified", "vendored"], errors);
    for (const [key, value] of Object.entries(authority.totals)) {
      if (!isRecord(value)
        || !Number.isSafeInteger(value.files)
        || value.files < 0
        || !Number.isSafeInteger(value.lines)
        || value.lines < 0
        || Object.keys(value).sort(compareText).join(",") !== "files,lines") {
        errors.push(`G0 authority.totals.${key} must contain non-negative integer files and lines`);
      }
    }
    if (["excluded", "generated", "production", "test", "unclassified", "vendored"]
      .every((key) => isRecord(authority.totals[key]))
      && isRecord(authority.totals.allAccounted)) {
      const sum = ["excluded", "generated", "production", "test", "unclassified", "vendored"]
        .reduce((total, key) => ({
          files: total.files + authority.totals[key].files,
          lines: total.lines + authority.totals[key].lines,
        }), { files: 0, lines: 0 });
      if (canonicalJson(sum) !== canonicalJson(authority.totals.allAccounted)) {
        errors.push("G0 authority.totals.allAccounted must equal the classification sum");
      }
    }
  }
  if (!isRecord(authority.postMergeRefContract)) {
    errors.push("G0 authority.postMergeRefContract must be an object");
  } else {
    const expected = {
      annotatedTagRequired: true,
      authorityDigestTrailer: "Complexity-Authority-SHA256",
      protectedRefRequired: true,
      releaseWorkflowMustNotMatch: true,
      targetMustContainExactBlobs: true,
    };
    if (canonicalJson(authority.postMergeRefContract) !== canonicalJson(expected)) {
      errors.push("G0 authority.postMergeRefContract must exactly match the immutable authority-ref contract");
    }
  }
  if (errors.length > 0) throw new Error(`Invalid G0 complexity authority:\n- ${errors.sort(compareText).join("\n- ")}`);
}

function validateAuthorityArtifact(value, label, keys, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  validateObjectKeys(value, label, keys, keys, errors);
  if (!isSafePath(value.path)) errors.push(`${label}.path must be a safe repository-relative path`);
  for (const key of keys.filter((key) => key.endsWith("Sha256"))) validateSha256(value[key], `${label}.${key}`, errors);
  if (keys.includes("gitBlobOid") && (typeof value.gitBlobOid !== "string" || !/^[0-9a-f]{40,64}$/u.test(value.gitBlobOid))) {
    errors.push(`${label}.gitBlobOid must be a lowercase Git object id`);
  }
}

function assertG0AuthorityBindings({ cwd, authority, baseline, commit }) {
  const artifacts = [
    [authority.baseline, baseline.evidence, baseline.snapshot],
    [authority.classificationAuthority, artifactEvidence({ cwd, commit, path: authority.classificationAuthority.path })],
    [authority.initialInventoryPolicy, artifactEvidence({ cwd, commit, path: authority.initialInventoryPolicy.path })],
  ];
  for (const [expected, evidence, snapshot] of artifacts) {
    if (expected.contentSha256 !== evidence.contentSha256 || expected.gitBlobOid !== evidence.gitBlobOid) {
      throw new Error(`G0 authority artifact binding failed for ${expected.path}.`);
    }
    if (snapshot !== undefined) {
      if (expected.snapshotSha256 !== snapshot.snapshotSha256 || expected.manifestSha256 !== snapshot.manifestSha256) {
        throw new Error("G0 authority baseline snapshot or manifest digest does not match its frozen authority.");
      }
    } else {
      const parsed = JSON.parse(utf8Decoder.decode(evidence.bytes));
      if (expected.canonicalSha256 !== sha256(canonicalJson(parsed))) {
        throw new Error(`G0 authority canonical digest failed for ${expected.path}.`);
      }
    }
  }
  if (baseline.snapshot.classificationAuthoritySha256 !== authority.classificationAuthority.canonicalSha256
    || baseline.snapshot.inventoryPolicySha256 !== authority.initialInventoryPolicy.canonicalSha256) {
    throw new Error("G0 authority policy digests do not match the frozen baseline.");
  }
  const actualTotals = {
    allAccounted: baseline.snapshot.totals.allExecutable,
    ...baseline.snapshot.totals.byClassification,
  };
  if (canonicalJson(actualTotals) !== canonicalJson(authority.totals)) {
    throw new Error("G0 authority totals do not match the frozen baseline.");
  }
}

function loadCommittedJsonBlob({ cwd, path }) {
  const entries = listIndexEntries(cwd);
  const entry = entries.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`${path} must be tracked in the Git index.`);
  const commit = runGit(cwd, ["rev-parse", "--verify", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const oid = gitBlobOidAtCommit(cwd, commit, path);
  if (entry.oid !== oid || listUnstagedPaths(cwd).includes(path)) {
    throw new Error(`${path} must be unchanged across HEAD, index, and worktree.`);
  }
  const bytes = readFileSync(resolve(cwd, path));
  const indexedBytes = readIndexBlobs(cwd, [entry]).get(entry.oid);
  if (indexedBytes === undefined || !bytes.equals(indexedBytes)) throw new Error(`${path} bytes must match its committed blob.`);
  return {
    value: JSON.parse(utf8Decoder.decode(bytes)),
    bytes,
    evidence: {
      source: "committed-git-blob",
      path,
      commit,
      gitBlobOid: oid,
      contentSha256: sha256(bytes),
    },
  };
}

function loadComplexityBaselineAtCommit({ cwd, commit, path }) {
  const bytes = readBlobAtCommit(cwd, commit, path);
  const snapshot = JSON.parse(utf8Decoder.decode(bytes));
  validateComplexitySnapshot(snapshot);
  if (snapshot.issues.length > 0) throw new Error(`Frozen baseline ${path} contains report issues.`);
  return {
    snapshot,
    evidence: {
      source: "annotated-authority-ref",
      path,
      commit,
      gitBlobOid: gitBlobOidAtCommit(cwd, commit, path),
      contentSha256: sha256(bytes),
      snapshotSha256: snapshot.snapshotSha256,
      manifestSha256: snapshot.manifestSha256,
      policySha256: snapshot.policySha256,
    },
  };
}

function artifactEvidence({ cwd, commit, path }) {
  if (commit === null) {
    const loaded = loadCommittedJsonBlob({ cwd, path });
    return { ...loaded.evidence, bytes: loaded.bytes };
  }
  const bytes = readBlobAtCommit(cwd, commit, path);
  return {
    source: "annotated-authority-ref",
    path,
    commit,
    gitBlobOid: gitBlobOidAtCommit(cwd, commit, path),
    contentSha256: sha256(bytes),
    bytes,
  };
}

function readBlobAtCommit(cwd, commit, path) {
  return runGit(cwd, ["show", `${commit}:${path}`], { encoding: null }).stdout;
}

function gitBlobOidAtCommit(cwd, commit, path) {
  const output = runGit(cwd, ["ls-tree", "-z", commit, "--", path], { encoding: "utf8" }).stdout;
  const match = /^(?:100644|100755) blob ([0-9a-f]{40,64})\t[^\0]+\0$/u.exec(output);
  if (match === null) throw new Error(`${path} must be a regular blob at ${commit}.`);
  return match[1];
}

function gitRefExists(cwd, ref) {
  const result = spawnSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd, env: process.env });
  if (result.error !== undefined) throw result.error;
  return result.status === 0;
}

function releaseTagName(ref) {
  return ref.replace(/^refs\/tags\//u, "");
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
    if (GATE_ORDER.indexOf(family.enforceAt) > gateIndex) continue;
    if (family.activeMembers < family.minMembers) {
      failures.push(`${family.id} has ${family.activeMembers} implementations, below ${family.minMembers}`);
    }
    if (family.activeMembers > family.maxMembers) {
      failures.push(`${family.id} has ${family.activeMembers} implementations, exceeding ${family.maxMembers}`);
    }
    if (family.registeredMember === null) {
      failures.push(`${family.id} has no registered canonical implementation`);
    } else if (!family.discoveredMembers.includes(family.registeredMember)) {
      failures.push(`${family.id} registered implementation ${family.registeredMember} was not discovered`);
    }
    if (family.unknownMembers.length > 0) {
      failures.push(`${family.id} has unregistered implementations: ${family.unknownMembers.join(", ")}`);
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
  const inventoryPolicy = JSON.parse(utf8Decoder.decode(policyBytes));
  const policyErrors = validateComplexityPolicy(inventoryPolicy);
  if (policyErrors.length > 0) throw new Error(`Invalid v1 inventory policy:\n- ${policyErrors.join("\n- ")}`);
  const authorityPath = inventoryPolicy.classificationAuthorityPath;
  const classificationAuthority = parseJsonBlob(authorityPath, entryByPath, blobsByOid);
  const policy = resolveComplexityPolicy(classificationAuthority, inventoryPolicy);

  const resolvedCatalog = catalog ?? loadIndexedPackageCatalog({ entries, blobsByOid });
  const reachability = buildShippedReachability({
    entries,
    blobsByOid,
    catalog: resolvedCatalog,
    policy,
  });

  const unstagedPaths = listUnstagedPaths(cwd);
  const manifest = buildFileManifest({
    entries,
    blobsByOid,
    policy,
    catalog: resolvedCatalog,
    reachability,
    unstagedPaths,
  });
  const relevantInventoryPaths = new Set([
    policyPath,
    authorityPath,
    PACKAGE_CATALOG_PATH,
    ...(policy.configSchemaPath === null ? [] : [policy.configSchemaPath]),
    ...resolvedCatalog.map((entry) => `${catalogPath(entry)}/package.json`),
  ]);
  const extraIssues = [
    ...reachability.issues,
    ...runGeneratedReproducibilityChecks({ cwd, policy }),
    ...unstagedPaths
    .filter((path) => relevantInventoryPaths.has(path))
      .map((path) => `${path} has unstaged report-input changes`),
  ];
  return buildComplexitySnapshot({
    manifest,
    policy,
    entries,
    blobsByOid,
    catalog: resolvedCatalog,
    reachability,
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
  )}\n;JSON.stringify({\n  categories: PACKAGE_CATEGORIES,\n  entries: packageCatalog.map((entry) => ({\n    allowedDependencyCategories: entry.allowedDependencyCategories,\n    category: entry.category,\n    name: entry.name,\n    publishable: entry.publishable,\n    responsibility: entry.responsibility,\n    tier: entry.tier ?? null,\n    path: packageRelativePath(entry),\n  })),\n});\n`;

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
  if (!isRecord(parsed)
    || !Array.isArray(parsed.categories)
    || !Array.isArray(parsed.entries)
    || parsed.entries.length === 0) {
    throw new Error(`Indexed package catalog ${path} must contain at least one package.`);
  }
  const categories = new Set(parsed.categories);
  if (categories.size !== parsed.categories.length
    || parsed.categories.some((category) => typeof category !== "string" || category.length === 0)) {
    throw new Error(`Indexed package catalog ${path} categories must be unique non-empty strings.`);
  }

  const names = new Set();
  const paths = new Set();
  const catalog = parsed.entries.map((raw, index) => {
    const label = `indexed package catalog entry ${index}`;
    if (!isRecord(raw)) throw new Error(`${label} must be an object.`);
    if (typeof raw.name !== "string" || raw.name.length === 0 || names.has(raw.name)) {
      throw new Error(`${label}.name must be a unique non-empty string.`);
    }
    if (typeof raw.publishable !== "boolean") {
      throw new Error(`${label}.publishable must be boolean.`);
    }
    if (typeof raw.category !== "string" || !categories.has(raw.category)) {
      throw new Error(`${label}.category must be a declared package category.`);
    }
    if (typeof raw.responsibility !== "string" || raw.responsibility.trim().length === 0) {
      throw new Error(`${label}.responsibility must be a non-empty string.`);
    }
    if (!Array.isArray(raw.allowedDependencyCategories)
      || raw.allowedDependencyCategories.some((category) => typeof category !== "string" || !categories.has(category))
      || new Set(raw.allowedDependencyCategories).size !== raw.allowedDependencyCategories.length) {
      throw new Error(`${label}.allowedDependencyCategories must contain unique declared categories.`);
    }
    if (raw.tier !== null && (typeof raw.tier !== "string" || raw.tier.length === 0)) {
      throw new Error(`${label}.tier must be null or a non-empty string.`);
    }
    if (!isSafePath(raw.path)
      || (!raw.path.startsWith("packages/") && !raw.path.startsWith("extras/"))
      || paths.has(raw.path)) {
      throw new Error(`${label}.path must be a unique safe packages/ or extras/ path.`);
    }
    names.add(raw.name);
    paths.add(raw.path);
    return {
      allowedDependencyCategories: raw.allowedDependencyCategories,
      category: raw.category,
      name: raw.name,
      path: raw.path,
      publishable: raw.publishable,
      responsibility: raw.responsibility,
      tier: raw.tier,
    };
  });
  for (const [index, entry] of catalog.entries()) {
    for (const other of catalog.slice(index + 1)) {
      if (entry.path.startsWith(`${other.path}/`) || other.path.startsWith(`${entry.path}/`)) {
        throw new Error(`Indexed package catalog paths overlap: ${entry.path} and ${other.path}.`);
      }
    }
  }
  return catalog;
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

export function buildShippedReachability({ entries, blobsByOid, catalog, policy }) {
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const paths = entries.map((entry) => entry.path);
  const production = new Set();
  const packed = new Set();
  const issues = [];
  const appRoots = new Set();

  for (const catalogEntry of catalog) {
    const root = catalogPath(catalogEntry);
    const manifestPath = `${root}/package.json`;
    let manifest;
    try {
      manifest = parseJsonBlob(manifestPath, entryByPath, blobsByOid);
    } catch (error) {
      issues.push(`${manifestPath}: ${reasonOf(error)}`);
      continue;
    }
    if (!isRecord(manifest)) {
      issues.push(`${manifestPath}: package manifest must be an object`);
      continue;
    }

    const positivePackPatterns = [];
    const negativePackPatterns = [];
    for (const declaration of Array.isArray(manifest.files) ? manifest.files : []) {
      if (typeof declaration !== "string" || declaration.length === 0) {
        issues.push(`${manifestPath}: files declarations must be non-empty strings`);
        continue;
      }
      const target = declaration.startsWith("!") ? negativePackPatterns : positivePackPatterns;
      target.push(declaration.replace(/^!/u, "").replace(/^\.\//u, ""));
    }
    for (const path of paths.filter((candidate) => candidate.startsWith(`${root}/`))) {
      const relative = path.slice(root.length + 1);
      const included = positivePackPatterns.some((pattern) => matchesPackDeclaration(relative, pattern));
      const excluded = negativePackPatterns.some((pattern) => matchesPackDeclaration(relative, pattern));
      if (included && !excluded) packed.add(path);
    }

    for (const target of packageRuntimeTargets(manifest)) {
      for (const sourcePath of sourcePathsForRuntimeTarget(root, target, entryByPath)) production.add(sourcePath);
    }
  }

  for (const entry of entries) {
    if (!entry.path.endsWith("/package.json")) continue;
    const owner = exactOwnerForPath(entry.path, buildCatalogOwnership(catalog));
    if (owner === undefined) continue;
    let manifest;
    try {
      manifest = parseJsonBlob(entry.path, entryByPath, blobsByOid);
    } catch {
      continue;
    }
    const root = dirname(entry.path);
    const buildScript = isRecord(manifest?.scripts) && typeof manifest.scripts.build === "string"
      ? manifest.scripts.build
      : "";
    const viteConfigs = paths.filter((path) => (
      dirname(path) === root && /^vite\.config\.(?:[cm]?[jt]s)$/u.test(basename(path))
    ));
    if (buildScript.includes("vite") || viteConfigs.length > 0) {
      appRoots.add(root);
      const htmlEntry = `${root}/index.html`;
      if (entryByPath.has(htmlEntry)) production.add(htmlEntry);
      for (const configPath of viteConfigs) production.add(configPath);
      for (const path of paths.filter((candidate) => candidate.startsWith(`${root}/public/`))) packed.add(path);
    }
  }

  for (const entry of entries.filter((candidate) => basename(candidate.path) === "tsconfig.build.json")) {
    const owner = exactOwnerForPath(entry.path, buildCatalogOwnership(catalog));
    if (owner === undefined) continue;
    try {
      const config = resolveIndexedTsConfig(entry.path, entryByPath, blobsByOid, new Set());
      const configRoot = dirname(entry.path);
      const include = config.include ?? ["**/*"];
      const exclude = config.exclude ?? [];
      for (const path of paths.filter((candidate) => candidate.startsWith(`${configRoot}/`))) {
        const relative = path.slice(configRoot.length + 1);
        if (!policy.executableExtensions.includes(sourceExtensionOf(path))) continue;
        if (include.some((pattern) => matchesTsPattern(relative, pattern))
          && !exclude.some((pattern) => matchesTsPattern(relative, pattern))) {
          production.add(path);
        }
      }
    } catch (error) {
      issues.push(`${entry.path}: ${reasonOf(error)}`);
    }
  }

  const queue = [...production].sort(compareText);
  const visited = new Set();
  while (queue.length > 0) {
    const path = queue.shift();
    if (visited.has(path)) continue;
    visited.add(path);
    const entry = entryByPath.get(path);
    const bytes = entry === undefined ? undefined : blobsByOid.get(entry.oid);
    if (bytes === undefined || bytes.includes(0)) continue;
    let text;
    try {
      text = normalizeSourceText(utf8Decoder.decode(bytes));
    } catch {
      continue;
    }
    const appRoot = [...appRoots]
      .sort((left, right) => right.length - left.length || compareText(left, right))
      .find((candidate) => path === candidate || path.startsWith(`${candidate}/`));
    for (const specifier of referencedRelativeSpecifiers(text)) {
      for (const resolvedPath of resolveImportSpecifier({
        appRoot,
        entryByPath,
        importer: path,
        specifier,
      })) {
        if (!production.has(resolvedPath)) {
          production.add(resolvedPath);
          queue.push(resolvedPath);
        }
      }
    }
  }

  return { production, packed, issues: [...new Set(issues)].sort(compareText) };
}

function packageRuntimeTargets(manifest) {
  const targets = [];
  for (const key of ["bin", "browser", "exports", "main", "module"]) {
    collectStringLeaves(manifest[key], targets);
  }
  return [...new Set(targets)].filter((target) => target.startsWith("./")).sort(compareText);
}

function collectStringLeaves(value, output) {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStringLeaves(entry, output);
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) collectStringLeaves(entry, output);
  }
}

function sourcePathsForRuntimeTarget(root, target, entryByPath) {
  const normalized = target.replace(/^\.\//u, "");
  const candidates = new Set([`${root}/${normalized}`]);
  if (normalized.startsWith("dist/")) {
    const relative = normalized.slice("dist/".length).replace(/\.(?:cjs|js|jsx|mjs)$/u, "");
    for (const extension of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
      candidates.add(`${root}/src/${relative}${extension}`);
    }
  }
  return [...candidates].filter((path) => entryByPath.has(path));
}

function referencedRelativeSpecifiers(text) {
  const specifiers = new Set();
  const patterns = [
    /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu,
    /(?:import|require)\(\s*["']([^"']+)["']\s*\)/gu,
    /@import\s+(?:url\()?\s*["']([^"']+)["']/gu,
    /(?:href|src)\s*=\s*["']([^"']+)["']/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1];
      if (value.startsWith(".") || value.startsWith("/")) specifiers.add(value.split(/[?#]/u, 1)[0]);
    }
  }
  return [...specifiers].sort(compareText);
}

function resolveImportSpecifier({ appRoot, entryByPath, importer, specifier }) {
  const base = specifier.startsWith("/")
    ? (appRoot === undefined ? undefined : `${appRoot}/${specifier.slice(1)}`)
    : pathPosix.normalize(pathPosix.join(dirname(importer), specifier));
  if (base === undefined || !isSafePath(base)) return [];
  const candidates = [base];
  if (extname(base) === "") {
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}${extension}`);
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}/index${extension}`);
  }
  return [...new Set(candidates)].filter((path) => entryByPath.has(path)).sort(compareText);
}

function resolveIndexedTsConfig(path, entryByPath, blobsByOid, active) {
  if (active.has(path)) throw new Error(`recursive tsconfig extends chain at ${path}`);
  active.add(path);
  const parsed = parseJsonBlob(path, entryByPath, blobsByOid);
  if (!isRecord(parsed)) throw new Error("tsconfig must be an object");
  let inherited = {};
  if (typeof parsed.extends === "string" && parsed.extends.startsWith(".")) {
    let target = pathPosix.normalize(pathPosix.join(dirname(path), parsed.extends));
    if (!target.endsWith(".json")) target += ".json";
    inherited = resolveIndexedTsConfig(target, entryByPath, blobsByOid, active);
  }
  active.delete(path);
  return {
    include: Array.isArray(parsed.include) ? parsed.include : inherited.include,
    exclude: Array.isArray(parsed.exclude) ? parsed.exclude : inherited.exclude,
  };
}

function matchesTsPattern(path, pattern) {
  const normalized = pattern.replace(/^\.\//u, "");
  if (!/[?*]/u.test(normalized)) {
    return path === normalized || path.startsWith(`${normalized.replace(/\/$/u, "")}/`);
  }
  return globRegex(normalized).test(path);
}

function matchesPackDeclaration(path, declaration) {
  const normalized = declaration.replace(/^\.\//u, "");
  if (!/[?*]/u.test(normalized)) {
    return path === normalized || path.startsWith(`${normalized.replace(/\/$/u, "")}/`);
  }
  return globRegex(normalized).test(path);
}

function globRegex(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[\\^$+?.()|{}[\]]/gu, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "u");
}

function emptyReachability() {
  return { production: new Set(), packed: new Set(), issues: [] };
}

function buildInventory({ files, entries, blobsByOid, policy, catalog, reachability, issues }) {
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
    if (!isRecord(manifest) || manifest.name !== catalogEntry.name) {
      issues.push(`${manifestPath}: manifest name must exactly match catalog identity ${catalogEntry.name}`);
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

  const implementationFamilies = policy.implementationFamilies.map((family) => {
    const discoveredMembers = files
      .filter((file) => file.classification === "production")
      .filter((file) => family.detection.pathPrefixes.some((prefix) => file.path.startsWith(prefix)))
      .filter((file) => {
        const entry = entryByPath.get(file.path);
        const bytes = entry === undefined ? undefined : blobsByOid.get(entry.oid);
        if (bytes === undefined || bytes.includes(0)) return false;
        let text;
        try {
          text = utf8Decoder.decode(bytes);
        } catch {
          return false;
        }
        return family.detection.allContentMarkers.every((marker) => text.includes(marker));
      })
      .map((file) => file.path)
      .sort(compareText);
    const unknownMembers = family.registeredMember === null
      ? discoveredMembers
      : discoveredMembers.filter((path) => path !== family.registeredMember);
    return {
      id: family.id,
      detection: family.detection,
      registeredMember: family.registeredMember,
      discoveredMembers,
      unknownMembers,
      activeMembers: discoveredMembers.length,
      minMembers: family.minMembers,
      maxMembers: family.maxMembers,
      enforceAt: family.enforceAt,
    };
  });

  return {
    workspacePackages: {
      total: packageRecords.length,
      publishable: packageRecords.filter((record) => record.catalogEntry.publishable === true).length,
      entries: packageRecords.map((record) => ({
        allowedDependencyCategories: record.catalogEntry.allowedDependencyCategories,
        category: record.catalogEntry.category,
        name: record.catalogEntry.name,
        path: record.path,
        publishable: record.catalogEntry.publishable,
        responsibility: record.catalogEntry.responsibility,
        tier: record.catalogEntry.tier,
      })),
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
    shippedReachability: {
      productionPaths: reachability.production.size,
      packedRuntimePaths: reachability.packed.size,
      productionPathsSha256: sha256([...reachability.production].sort(compareText).join("\n") + "\n"),
      packedRuntimePathsSha256: sha256([...reachability.packed].sort(compareText).join("\n") + "\n"),
    },
  };
}

function evidenceBindingIssues(policy, entries, blobsByOid) {
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const issues = [];
  for (const [group, evidenceEntries] of [
    ["generated", policy.generatedFiles],
    ["vendored", policy.vendoredFiles],
    ["excluded", policy.excludedFiles],
  ]) {
    for (const evidence of evidenceEntries) {
      const entry = entryByPath.get(evidence.path);
      const bytes = entry === undefined ? undefined : blobsByOid.get(entry.oid);
      if (entry === undefined || bytes === undefined || !/^(?:100644|100755)$/u.test(entry.mode)) {
        issues.push(`${group} evidence ${evidence.id} path ${evidence.path} is not a readable regular stage-0 file`);
      } else if (sha256(bytes) !== evidence.contentSha256) {
        issues.push(`${group} evidence ${evidence.id} content digest does not match ${evidence.path}`);
      }
    }
  }
  for (const evidence of policy.vendoredFiles) {
    const entry = entryByPath.get(evidence.licensePath);
    if (entry === undefined) {
      issues.push(`vendored evidence ${evidence.id} license ${evidence.licensePath} is not tracked`);
    } else if (!/^(?:100644|100755)$/u.test(entry.mode) || !blobsByOid.has(entry.oid)) {
      issues.push(`vendored evidence ${evidence.id} license ${evidence.licensePath} is not a readable regular file`);
    } else if (sha256(blobsByOid.get(entry.oid)) !== evidence.licenseSha256) {
      issues.push(`vendored evidence ${evidence.id} license digest does not match ${evidence.licensePath}`);
    }
  }
  return issues;
}

function runGeneratedReproducibilityChecks({ cwd, policy }) {
  const issues = [];
  for (const evidence of policy.generatedFiles) {
    const before = collectReproducibilityTreeEvidence(cwd);
    runReproducibilityCommand({
      command: evidence.generator,
      evidenceId: evidence.id,
      label: "generator",
      cwd,
      issues,
    });
    runReproducibilityCommand({
      command: evidence.reproducibilityCheck,
      evidenceId: evidence.id,
      label: "reproducibility check",
      cwd,
      issues,
    });
    const after = collectReproducibilityTreeEvidence(cwd);
    if (canonicalJson(before) !== canonicalJson(after)) {
      issues.push(`generated evidence ${evidence.id} reproducibility run changed the repository tree`);
    }
  }
  return issues;
}

function runReproducibilityCommand({ command, evidenceId, label, cwd, issues }) {
  const result = spawnSync(command.command, command.args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: 120_000,
  });
  if (result.error !== undefined) {
    issues.push(`generated evidence ${evidenceId} ${label} failed: ${reasonOf(result.error)}`);
  } else if (result.status !== 0) {
    issues.push(
      `generated evidence ${evidenceId} ${label} exited ${String(result.status)}: ${String(result.stderr).trim()}`,
    );
  }
}

function collectReproducibilityTreeEvidence(cwd) {
  return {
    ...collectTrackedTreeEvidence({ cwd }),
    untrackedPaths: listChangedPaths(cwd, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
    ]),
  };
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

function buildCatalogOwnership(catalog) {
  return catalog
    .map((entry) => catalogPath(entry))
    .sort((left, right) => right.length - left.length || compareText(left, right));
}

function exactOwnerForPath(path, ownership) {
  return ownership.find((candidate) => path === candidate || path.startsWith(`${candidate}/`));
}

function packageMetadataClassification(path, relativeSegments, policy) {
  const filename = basename(path);
  if (policy.packageDocumentationNames.includes(filename)) return "package-documentation";
  if (policy.packageMetadataNames.includes(filename) || filename === ".gitkeep") return "package-metadata";
  if (policy.buildConfigFilenameMarkers.some((marker) => filename.includes(marker))) {
    return "package-build-configuration";
  }
  if (relativeSegments.length === 1 && /^(?:CHANGELOG|CONTRIBUTING|SECURITY)(?:\.[A-Za-z0-9]+)?$/u.test(filename)) {
    return "package-documentation";
  }
  return undefined;
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

function evidenceRule(entry) {
  return {
    id: entry.id,
    reason: entry.reason,
    match: { paths: [entry.path] },
  };
}

function validateExactRule(rule, label, ids, errors) {
  if (!isRecord(rule)) {
    errors.push(`${label} must be an object`);
    return;
  }
  validateObjectKeys(rule, label, ["id", "match", "reason"], ["id", "match", "reason"], errors);
  if (typeof rule.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(rule.id) || ids.has(rule.id)) {
    errors.push(`${label}.id must be a unique kebab-case identifier`);
  } else {
    ids.add(rule.id);
  }
  if (typeof rule.reason !== "string" || rule.reason.trim().length === 0) {
    errors.push(`${label}.reason must be a non-empty string`);
  }
  validateMatch(rule.match, `${label}.match`, errors);
}

function validateEvidenceIdentity(evidence, label, ids, paths, errors) {
  if (typeof evidence.id !== "string"
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(evidence.id)
    || ids.has(evidence.id)) {
    errors.push(`${label}.id must be a globally unique kebab-case identifier`);
  } else {
    ids.add(evidence.id);
  }
  if (!isSafePath(evidence.path) || paths.has(evidence.path)) {
    errors.push(`${label}.path must be a globally unique safe repository-relative path`);
  } else {
    paths.add(evidence.path);
  }
  if (typeof evidence.reason !== "string" || evidence.reason.trim().length === 0) {
    errors.push(`${label}.reason must be a non-empty string`);
  }
  validateSha256(evidence.contentSha256, `${label}.contentSha256`, errors);
}

function validateSha256(value, label, errors) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    errors.push(`${label} must be a lowercase SHA-256 digest`);
  }
}

function validateRequiredImplementationFamilies(families, errors) {
  for (const required of REQUIRED_IMPLEMENTATION_FAMILIES) {
    const actual = families.find((entry) => isRecord(entry) && entry.id === required.id);
    if (actual === undefined) {
      errors.push(`required implementation family ${required.id} is missing`);
      continue;
    }
    const binding = {
      id: actual.id,
      detection: actual.detection,
      minMembers: actual.minMembers,
      maxMembers: actual.maxMembers,
      enforceAt: actual.enforceAt,
    };
    if (!isCanonicalJsonValue(binding) || canonicalJson(binding) !== canonicalJson(required)) {
      errors.push(`required implementation family ${required.id} must exactly match its detection and cardinality contract`);
    }
  }
}

function isCanonicalJsonValue(value) {
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
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
    if (!isCanonicalJsonValue(actual) || canonicalJson(actual) !== canonicalJson(required)) {
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

function isSafeSegment(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/u.test(value) && value !== "." && value !== "..";
}

function isSafeFilename(value) {
  return isSafeSegment(value) && !value.includes("/");
}

function isSafeFilenameMarker(value) {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && !value.includes("/")
    && !/[\u0000-\u001f\u007f]/u.test(value);
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
