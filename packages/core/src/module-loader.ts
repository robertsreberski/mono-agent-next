import { createRequire } from "node:module";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import {
  isEnvEligibleSchema,
  isSecretSchema,
  MODULE_API_VERSION,
  readCrossSlotReference,
  type JsonSchema,
} from "@mono-agent/module-sdk";
import {
  assertModuleDefinitionCompliance,
  assertSchemaCompliance,
} from "@mono-agent/module-sdk/testing";
import { parse as parseYaml } from "yaml";

import { AgentConfigError, AgentModuleError, errorMessage } from "./errors.js";
import { snapshotBoundedValue } from "./bounded-value.js";
import type { ModuleSelection } from "./config.js";
import type { GenericModuleDefinition, LoadedAgentModule } from "./types.js";
import type { AgentConfigIssue } from "./errors.js";

const moduleConfigs = new WeakMap<LoadedAgentModule, unknown>();
const MODULE_CONFIG_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const MODULE_CONFIG_SNAPSHOT_MAX_DEPTH = 64;
const MODULE_CONFIG_SNAPSHOT_MAX_ITEMS = 50_000;

export function moduleConfigFor(module: LoadedAgentModule): unknown {
  if (!moduleConfigs.has(module)) throw new AgentModuleError(`Parsed config is unavailable for ${module.packageName}`);
  return moduleConfigs.get(module);
}

export function validateLoadedModuleReferences(
  modules: readonly LoadedAgentModule[],
): readonly AgentConfigIssue[] {
  const issues: AgentConfigIssue[] = [];
  for (const module of modules) {
    visitModuleReferencesFromSchemas(
      moduleConfigFor(module),
      [module.definition.schema.jsonSchema],
      module.configPath,
      modules,
      issues,
    );
  }
  return issues;
}

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly main?: string;
  readonly exports?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly ["mono-agent"]?: {
    readonly packageName?: string;
    readonly apiVersion?: number;
    readonly kind?: string;
    readonly responsibility?: string;
  };
}

export async function loadSelectedModules(input: {
  readonly projectRoot: string;
  readonly selections: readonly ModuleSelection[];
  readonly environment: Readonly<Record<string, string | undefined>>;
}): Promise<readonly LoadedAgentModule[]> {
  const projectManifestPath = join(input.projectRoot, "package.json");
  const projectManifest = await readJson<PackageManifest>(projectManifestPath, "project package.json");
  const lock = await readProjectLock(input.projectRoot);
  const preflighted = [];
  for (const selection of input.selections) {
    preflighted.push(await preflightModule(selection, input.projectRoot, projectManifestPath, projectManifest, lock));
  }

  const loaded: LoadedAgentModule[] = [];
  for (const preflight of preflighted) loaded.push(await importAndValidateModule(preflight, input.environment));
  return loaded;
}

interface ProjectLock {
  readonly kind: "pnpm" | "npm";
  hasDirect(packageName: string, installedVersion: string): boolean;
}

async function readProjectLock(projectRoot: string): Promise<ProjectLock> {
  const pnpmPath = join(projectRoot, "pnpm-lock.yaml");
  try {
    const parsed = parseYaml(await readFile(pnpmPath, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.importers) || !isRecord(parsed.importers["."])) {
      throw new AgentModuleError(`${pnpmPath} has no root importer`);
    }
    const importer = parsed.importers["."];
    return {
      kind: "pnpm",
      hasDirect(packageName, installedVersion) {
        return ["dependencies", "optionalDependencies"].some((field) => {
          const entries = importer[field];
          if (!isRecord(entries) || !Object.hasOwn(entries, packageName)) return false;
          const locked = entries[packageName];
          const resolved = isRecord(locked) ? locked.version : locked;
          return typeof resolved !== "string"
            || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?:\([^)]*\))?$/u.test(resolved)
            || resolved === installedVersion
            || resolved.startsWith(`${installedVersion}(`);
        });
      },
    };
  } catch (error) {
    if (!isNotFound(error)) throw new AgentModuleError(`Could not parse ${pnpmPath}`, { cause: error });
  }

  const npmPath = join(projectRoot, "package-lock.json");
  try {
    const parsed = await readJson<Record<string, unknown>>(npmPath, "package-lock.json");
    const packages = isRecord(parsed.packages) ? parsed.packages : {};
    const root = isRecord(packages[""]) ? packages[""] : {};
    return {
      kind: "npm",
      hasDirect(packageName, installedVersion) {
        const declared = ["dependencies", "optionalDependencies"].some((field) => {
          const entries = root[field];
          return isRecord(entries) && Object.hasOwn(entries, packageName);
        });
        const installed = packages[`node_modules/${packageName}`];
        return declared && isRecord(installed) && installed.version === installedVersion;
      },
    };
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  throw new AgentModuleError(`Project ${projectRoot} must contain pnpm-lock.yaml or package-lock.json`);
}

interface PreflightedModule {
  readonly selection: ModuleSelection;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly packageRoot: string;
  readonly packageEntry: string;
}

async function preflightModule(
  selection: ModuleSelection,
  projectRoot: string,
  projectManifestPath: string,
  projectManifest: PackageManifest,
  lock: ProjectLock,
): Promise<PreflightedModule> {
  const packageName = selection.selected.$use;
  const dependencySpec = projectManifest.dependencies?.[packageName]
    ?? projectManifest.optionalDependencies?.[packageName];
  if (dependencySpec === undefined) {
    throw moduleIssue(selection, `${packageName} must be a direct project dependency`);
  }
  if (/^(?:npm:|file:|link:|portal:|patch:|git(?:\+|:)|https?:|github:|\.\.?\/|\/)/u.test(dependencySpec)) {
    throw moduleIssue(selection, `${packageName} uses forbidden dependency spec ${JSON.stringify(dependencySpec)}`);
  }
  const projectRequire = createRequire(projectManifestPath);
  let packageRoot: string;
  try {
    packageRoot = await findPackageRoot(projectRequire, packageName);
  } catch (error) {
    throw moduleIssue(selection, `${packageName} cannot be resolved from ${projectRoot}`, error);
  }
  const realPackageRoot = await realpath(packageRoot);
  const manifest = await readJson<PackageManifest>(join(realPackageRoot, "package.json"), `${packageName} package.json`);
  const entryTarget = packageImportTarget(manifest);
  if (entryTarget === undefined || entryTarget.includes("\0") || isAbsolute(entryTarget)) {
    throw moduleIssue(selection, `${packageName} must declare a relative ESM import export or main entry`);
  }
  let realPackageEntry: string;
  try {
    realPackageEntry = await realpath(join(realPackageRoot, entryTarget));
  } catch (error) {
    throw moduleIssue(selection, `${packageName} entry ${JSON.stringify(entryTarget)} cannot be resolved`, error);
  }
  const entryRelative = relative(realPackageRoot, realPackageEntry);
  if (entryRelative === "" || entryRelative.startsWith("..") || isAbsolute(entryRelative)) {
    throw moduleIssue(selection, `${packageName} entry escapes its installed package root`);
  }
  if (manifest.name !== packageName) throw moduleIssue(selection, `resolved package identity is ${JSON.stringify(manifest.name)}`);
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw moduleIssue(selection, `${packageName} package.json must declare a version`);
  }
  if (!lock.hasDirect(packageName, manifest.version)) {
    throw moduleIssue(selection, `${packageName}@${manifest.version} is missing or mismatched in the ${lock.kind} lockfile root importer`);
  }
  const metadata = manifest["mono-agent"];
  if (!isRecord(metadata)) throw moduleIssue(selection, `${packageName} package.json is missing mono-agent metadata`);
  if (metadata.packageName !== packageName) {
    throw moduleIssue(selection, `${packageName} mono-agent.packageName must match the package identity`);
  }
  if (metadata.apiVersion !== MODULE_API_VERSION) {
    throw moduleIssue(selection, `${packageName} mono-agent.apiVersion must be ${MODULE_API_VERSION}`);
  }
  if (metadata.kind !== selection.slot) {
    throw moduleIssue(selection, `${packageName} declares kind ${JSON.stringify(metadata.kind)}; expected ${selection.slot}`);
  }
  if (typeof metadata.responsibility !== "string" || metadata.responsibility.trim().length === 0) {
    throw moduleIssue(selection, `${packageName} mono-agent.responsibility must be non-empty`);
  }
  return {
    selection,
    packageName,
    packageVersion: manifest.version,
    packageRoot: realPackageRoot,
    packageEntry: realPackageEntry,
  };
}

function packageImportTarget(manifest: PackageManifest): string | undefined {
  if (manifest.exports === undefined) return manifest.main;
  const rootExport = isRecord(manifest.exports) && Object.hasOwn(manifest.exports, ".")
    ? manifest.exports["."]
    : manifest.exports;
  return conditionalImportTarget(rootExport);
}

function conditionalImportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const target = conditionalImportTarget(entry);
      if (target !== undefined) return target;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (Object.hasOwn(value, "import")) {
    const target = conditionalImportTarget(value.import);
    if (target !== undefined) return target;
  }
  if (Object.hasOwn(value, "default")) return conditionalImportTarget(value.default);
  return undefined;
}

async function importAndValidateModule(
  preflight: PreflightedModule,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<LoadedAgentModule> {
  let namespace: Record<string, unknown>;
  try {
    namespace = (await import(pathToFileURL(preflight.packageEntry).href)) as Record<string, unknown>;
  } catch (error) {
    throw moduleIssue(preflight.selection, `failed to import ${preflight.packageName}`, error);
  }
  const definition = namespace.monoAgentModule;
  if (definition === undefined) {
    throw moduleIssue(preflight.selection, `${preflight.packageName} must export monoAgentModule`);
  }
  assertLoadedModuleDefinitionCompliance(definition, preflight);
  const manifest = definition.manifest;
  if (manifest.packageName !== preflight.packageName) {
    throw moduleIssue(preflight.selection, `exported packageName ${JSON.stringify(manifest.packageName)} does not match`);
  }
  if (manifest.packageVersion !== preflight.packageVersion) {
    throw moduleIssue(preflight.selection, `exported packageVersion ${JSON.stringify(manifest.packageVersion)} does not match`);
  }
  if (manifest.apiVersion !== MODULE_API_VERSION) {
    throw moduleIssue(preflight.selection, `exported apiVersion must be ${MODULE_API_VERSION}`);
  }
  if (manifest.kind !== preflight.selection.slot) {
    throw moduleIssue(preflight.selection, `exported kind ${JSON.stringify(manifest.kind)} does not match ${preflight.selection.slot}`);
  }
  const installedManifest = await readJson<PackageManifest>(
    join(preflight.packageRoot, "package.json"),
    `${preflight.packageName} package.json`,
  );
  if (manifest.responsibility !== installedManifest["mono-agent"]?.responsibility) {
    throw moduleIssue(preflight.selection, "exported responsibility does not match package.json mono-agent metadata");
  }

  const inline: Record<string, unknown> = { ...preflight.selection.selected };
  delete inline.$use;
  const resolvedEnvironmentValues = new Set<string>();
  const resolvedInline = resolveEnvironmentDirectivesFromSchemas(
    inline,
    [[definition.schema.jsonSchema]],
    environment,
    preflight.selection.configPath,
    resolvedEnvironmentValues,
  );
  let config: unknown;
  try {
    config = snapshotModuleConfig(
      definition.schema.parse(resolvedInline),
      `${preflight.selection.configPath} parsed config`,
    );
  } catch (error) {
    const issues = moduleSchemaIssues(preflight.selection.configPath, error, resolvedEnvironmentValues);
    throw new AgentConfigError(`Invalid config for ${preflight.packageName}`, issues);
  }
  const loaded: LoadedAgentModule = {
    slot: preflight.selection.slot,
    instanceId: preflight.selection.instanceId,
    configPath: preflight.selection.configPath,
    packageName: preflight.packageName,
    packageVersion: preflight.packageVersion,
    packageRoot: preflight.packageRoot,
    packageEntry: preflight.packageEntry,
    definition,
  };
  moduleConfigs.set(loaded, config);
  return loaded;
}

function snapshotModuleConfig(value: unknown, path: string): unknown {
  return snapshotBoundedValue(value, {
    path,
    maxBytes: MODULE_CONFIG_SNAPSHOT_MAX_BYTES,
    maxDepth: MODULE_CONFIG_SNAPSHOT_MAX_DEPTH,
    maxItems: MODULE_CONFIG_SNAPSHOT_MAX_ITEMS,
    label: "config",
    allowUndefined: true,
    freeze: true,
    preserveAliases: true,
    preserveObjectPrototype: true,
    requireEnumerable: true,
    requireOrdinaryArrays: true,
  }).value;
}

function isModuleDefinition(value: unknown): value is GenericModuleDefinition {
  if (!isRecord(value) || !isRecord(value.manifest) || !isRecord(value.schema)) return false;
  return (
    typeof value.manifest.packageName === "string" &&
    typeof value.manifest.packageVersion === "string" &&
    value.manifest.apiVersion === 1 &&
    typeof value.manifest.kind === "string" &&
    typeof value.manifest.responsibility === "string" &&
    Array.isArray(value.manifest.capabilities) &&
    value.manifest.capabilities.every((entry) => typeof entry === "string") &&
    isRecord(value.schema.jsonSchema) &&
    typeof value.schema.parse === "function" &&
    typeof value.create === "function"
  );
}

function assertLoadedModuleDefinitionCompliance(
  value: unknown,
  preflight: PreflightedModule,
): asserts value is GenericModuleDefinition {
  try {
    if (!isModuleDefinition(value)) {
      throw new TypeError("monoAgentModule does not satisfy the module definition contract");
    }
    if (
      preflight.selection.slot === "runtime"
      || preflight.selection.slot === "channel"
      || preflight.selection.slot === "memory"
    ) {
      assertModuleDefinitionCompliance(value, {
        expectedKind: preflight.selection.slot,
        expectedPackageName: preflight.packageName,
        expectedPackageVersion: preflight.packageVersion,
      });
    } else {
      assertReservedModuleManifestCompliance(value);
      assertSchemaCompliance(value.schema);
    }
    assertSecurityAnnotationReachability(value.schema.jsonSchema);
  } catch (error) {
    throw moduleIssue(
      preflight.selection,
      `${preflight.packageName} exports a non-compliant monoAgentModule: ${errorMessage(error)}`,
      error,
    );
  }
}

function assertSecurityAnnotationReachability(root: JsonSchema): void {
  const seen = new Set<object>();
  const visit = (schema: JsonSchema): void => {
    if (seen.has(schema)) return;
    seen.add(schema);
    if (["$ref", "$dynamicRef", "$recursiveRef"].some((key) => Object.hasOwn(schema, key)))
      throw new TypeError("module security schemas may not use unresolved references");
    for (const [key, value] of Object.entries(schema)) {
      if (key === "properties" && isRecord(value)) {
        for (const child of Object.values(value)) if (isRecord(child)) visit(child);
      } else if (["items", "additionalProperties", "not", "if", "then", "else"].includes(key)
        && isRecord(value)) visit(value);
      else if (["allOf", "anyOf", "oneOf"].includes(key) && Array.isArray(value)) {
        for (const child of value) if (isRecord(child)) visit(child);
      } else if (!KNOWN_SCHEMA_KEYS.has(key) && containsSecurityAnnotation(value)) {
        throw new TypeError(`module security annotations under unsupported schema keyword ${key}`);
      }
    }
  };
  visit(root);
}

function containsSecurityAnnotation(value: unknown, seen = new Set<object>()): boolean {
  if (!isRecord(value) && !Array.isArray(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (isRecord(value) && (isSecretSchema(value) || isEnvEligibleSchema(value))) return true;
  return Object.values(value).some((child) => containsSecurityAnnotation(child, seen));
}

function assertReservedModuleManifestCompliance(definition: GenericModuleDefinition): void {
  const { manifest } = definition;
  if (manifest.packageName.trim().length === 0) throw new TypeError("manifest.packageName must be non-empty");
  if (manifest.packageVersion.trim().length === 0) throw new TypeError("manifest.packageVersion must be non-empty");
  if (manifest.responsibility.trim().length === 0) throw new TypeError("manifest.responsibility must be non-empty");
  const seen = new Set<string>();
  for (const [index, capability] of manifest.capabilities.entries()) {
    if (capability.trim().length === 0) {
      throw new TypeError(`manifest.capabilities[${index}] must be non-empty`);
    }
    if (seen.has(capability)) {
      throw new TypeError(`manifest.capabilities contains duplicate ${capability}`);
    }
    seen.add(capability);
  }
}

function resolveEnvironmentDirectivesFromSchemas(
  value: unknown,
  options: SchemaOptions,
  environment: Readonly<Record<string, string | undefined>>,
  path: string,
  resolvedEnvironmentValues: Set<string>,
): unknown {
  const activeOptions = applicableSchemaOptions(options, value);
  const activeSchemas = activeOptions.flat();
  if (isEnvironmentReference(value)) {
    if (!activeOptions.every((schemas) => schemas.some(isEnvEligibleSchema))) {
      throw new AgentConfigError("Environment directive is not allowed", [{
        path,
        message: "$env may appear only at a module schema path marked env-eligible",
        code: "env_not_eligible",
      }]);
    }
    const name = value.$env;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new AgentConfigError("Environment directive is invalid", [{
        path: `${path}.$env`,
        message: "must be an environment variable name",
        code: "env_name",
      }]);
    }
    const resolved = environment[name];
    if (typeof resolved !== "string" || resolved.length === 0) {
      throw new AgentConfigError("Environment variable is missing", [{
        path,
        message: `environment variable ${name} is missing or empty`,
        code: "missing_environment",
      }]);
    }
    resolvedEnvironmentValues.add(resolved);
    return resolved;
  }
  if (value === undefined) return undefined;
  if (activeSchemas.some(isSecretSchema)) {
    throw new AgentConfigError("Inline secret is forbidden", [{
      path,
      message: "secret values must use an explicit {$env:NAME} reference",
      code: "inline_secret",
    }]);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => resolveEnvironmentDirectivesFromSchemas(
      entry,
      activeOptions.map(childSchemasForItems),
      environment,
      `${path}.${index}`,
      resolvedEnvironmentValues,
    ));
  }
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    output[key] = resolveEnvironmentDirectivesFromSchemas(
      entry,
      activeOptions.map((schemas) => childSchemasForProperty(schemas, key)),
      environment,
      `${path}.${key}`,
      resolvedEnvironmentValues,
    );
  }
  return output;
}

function visitModuleReferencesFromSchemas(
  value: unknown,
  schemas: readonly JsonSchema[],
  path: string,
  modules: readonly LoadedAgentModule[],
  issues: AgentConfigIssue[],
): void {
  const activeSchemas = applicableSchemas(schemas, value);
  for (const schema of activeSchemas) {
    const reference = readCrossSlotReference(schema);
    if (reference === undefined) continue;
    const target = typeof value === "string"
      ? modules.find((module) => module.slot === reference.slot && module.instanceId === value)
      : undefined;
    if (target === undefined) {
      issues.push({
        path,
        message: `references unconfigured ${reference.slot} instance ${JSON.stringify(value)}`,
        code: "module_reference",
      });
    } else if (
      reference.capability !== undefined
      && !target.definition.manifest.capabilities.includes(reference.capability)
    ) {
      issues.push({
        path,
        message: `${reference.slot} instance ${JSON.stringify(value)} does not declare capability ${JSON.stringify(reference.capability)}`,
        code: "module_capability",
      });
    }
  }
  if (Array.isArray(value)) {
    const items = childSchemasForItems(activeSchemas);
    value.forEach((entry, index) => visitModuleReferencesFromSchemas(entry, items, `${path}.${index}`, modules, issues));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    visitModuleReferencesFromSchemas(entry, childSchemasForProperty(activeSchemas, key), `${path}.${key}`, modules, issues);
  }
}

function applicableSchemas(schemas: readonly JsonSchema[], value: unknown): readonly JsonSchema[] {
  const output: JsonSchema[] = [];
  const visit = (schema: JsonSchema): void => {
    output.push(schema);
    const allOf = schemaArray(schema.allOf);
    for (const branch of allOf) visit(branch);
    const oneOf = schemaArray(schema.oneOf);
    const oneOfStatuses = oneOf.map((branch) => schemaBranchApplicability(branch, value));
    const possibleOneOf = oneOf.filter((_, index) => oneOfStatuses[index] !== "no");
    for (const branch of possibleOneOf) visit(branch);
    const anyOf = schemaArray(schema.anyOf).filter((branch) =>
      schemaBranchApplicability(branch, value) !== "no");
    for (const branch of anyOf) visit(branch);
    if (schema.if !== undefined) {
      const status = schemaConditionApplicability(schema.if, value);
      if (status !== "no" && isRecord(schema.then)) visit(schema.then);
      if (status !== "match" && isRecord(schema.else)) visit(schema.else);
    }
  };
  for (const schema of schemas) visit(schema);
  return output;
}

export type SchemaApplicability = "match" | "no" | "unknown";
type SchemaOptions = readonly (readonly JsonSchema[])[];
const MAX_SCHEMA_OPTIONS = 256;
const MAX_SCHEMAS_PER_OPTION = 4_096;

export function schemaConditionApplicability(
  schema: unknown,
  value: unknown,
  acceptMaterializedEnvironment = false,
): SchemaApplicability {
  return schema === true ? "match" : schema === false ? "no" : isRecord(schema)
    ? schemaBranchApplicability(schema, value, acceptMaterializedEnvironment) : "unknown";
}

function applicableSchemaOptions(options: SchemaOptions, value: unknown): SchemaOptions {
  return options.flatMap((schemas) => {
    let output: JsonSchema[][] = [[]];
    for (const schema of schemas) output = crossSchemaOptions(output, schemaExpansionOptions(schema, value));
    return output;
  });
}

function schemaExpansionOptions(
  schema: JsonSchema,
  value: unknown,
  seen: ReadonlySet<JsonSchema> = new Set(),
): readonly JsonSchema[][] {
  if (seen.has(schema)) return [[schema]];
  const nextSeen = new Set(seen).add(schema);
  let output: JsonSchema[][] = [[schema]];
  for (const branch of schemaArray(schema.allOf))
    output = crossSchemaOptions(output, schemaExpansionOptions(branch, value, nextSeen));
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const branches = schemaArray(schema[keyword]).filter((branch) =>
      schemaBranchApplicability(branch, value) !== "no");
    if (branches.length > 0) output = crossSchemaOptions(
      output,
      boundedExpansionChoices(branches, value, nextSeen),
    );
  }
  if (schema.if !== undefined) {
    const status = schemaConditionApplicability(schema.if, value);
    const candidates = status === "match" ? [schema.then] : status === "no"
      ? [schema.else] : [schema.then, schema.else];
    const choices = candidates.map((branch) =>
      isRecord(branch) ? schemaExpansionOptions(branch, value, nextSeen) : [[]]).flat();
    output = crossSchemaOptions(output, choices);
  }
  return output;
}

function boundedExpansionChoices(
  branches: readonly JsonSchema[],
  value: unknown,
  seen: ReadonlySet<JsonSchema>,
): JsonSchema[][] {
  const output: JsonSchema[][] = [];
  for (const branch of branches)
    for (const option of schemaExpansionOptions(branch, value, seen)) {
      if (output.length >= MAX_SCHEMA_OPTIONS)
        throw new AgentModuleError("Module schema applicability exceeds the bounded complexity limit");
      output.push(option);
    }
  return output;
}

function crossSchemaOptions(
  left: readonly (readonly JsonSchema[])[],
  right: readonly (readonly JsonSchema[])[],
): JsonSchema[][] {
  if (left.length * right.length > MAX_SCHEMA_OPTIONS
    || left.some((first) => right.some((second) =>
      first.length + second.length > MAX_SCHEMAS_PER_OPTION))) {
    throw new AgentModuleError("Module schema applicability exceeds the bounded complexity limit");
  }
  return left.flatMap((first) => right.map((second) => [...first, ...second]));
}

const KNOWN_SCHEMA_KEYS = new Set([
  "$schema", "$id", "$anchor", "$comment", "title", "description", "default", "examples",
  "deprecated", "readOnly", "writeOnly", "type", "const", "enum", "pattern", "minLength",
  "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minItems", "maxItems", "minProperties", "maxProperties", "required", "properties",
  "additionalProperties", "items", "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
  "x-mono-agent-env-eligible", "x-mono-agent-secret", "x-mono-agent-slot-reference",
]);

export function schemaBranchApplicability(
  schema: JsonSchema,
  value: unknown,
  acceptMaterializedEnvironment = false,
): SchemaApplicability {
  const materializedValue = acceptMaterializedEnvironment && typeof value === "string"
    ? materializedEnvironmentValueSchema(schema) : undefined;
  if (materializedValue !== undefined)
    return schemaBranchApplicability(materializedValue, value, acceptMaterializedEnvironment);
  if (
    acceptMaterializedEnvironment
    && typeof value === "string"
    && isMaterializedEnvironmentReferenceSchema(schema)
  ) return "match";
  let result: SchemaApplicability = Object.keys(schema).some((key) => !KNOWN_SCHEMA_KEYS.has(key))
    ? "unknown" : "match";
  const typeStatus = schemaTypeApplicability(schema.type, value);
  if (typeStatus === "no") return "no";
  if (typeStatus === "unknown") result = "unknown";
  if (!acceptMaterializedEnvironment && isEnvironmentReference(value)) return "unknown";
  if (Object.hasOwn(schema, "const")) {
    const equal = jsonSchemaEqual(schema.const, value);
    if (equal === false) return "no";
    if (equal === undefined) result = "unknown";
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) result = "unknown";
    else {
      const equalities = schema.enum.map((entry) => jsonSchemaEqual(entry, value));
      if (!equalities.includes(true)) {
        if (!equalities.includes(undefined)) return "no";
        result = "unknown";
      }
    }
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (numericKeywordFails(schema, "minLength", length, (actual, limit) => actual < limit)
      || numericKeywordFails(schema, "maxLength", length, (actual, limit) => actual > limit)) return "no";
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== "string") result = "unknown";
      else {
        const matches = boundedPatternMatches(schema.pattern, value);
        if (matches === false) return "no";
        if (matches === undefined) result = "unknown";
      }
    }
  }
  if (typeof value === "number") {
    if (numericKeywordFails(schema, "minimum", value, (actual, limit) => actual < limit)
      || numericKeywordFails(schema, "maximum", value, (actual, limit) => actual > limit)
      || numericKeywordFails(schema, "exclusiveMinimum", value, (actual, limit) => actual <= limit)
      || numericKeywordFails(schema, "exclusiveMaximum", value, (actual, limit) => actual >= limit)) return "no";
  }
  const items = schema.items;
  if (Array.isArray(value)) {
    if (numericKeywordFails(schema, "minItems", value.length, (actual, limit) => actual < limit)
      || numericKeywordFails(schema, "maxItems", value.length, (actual, limit) => actual > limit)) return "no";
    if (isRecord(items) && !Object.hasOwn(schema, "prefixItems")) for (const entry of value) {
      const child = schemaBranchApplicability(items, entry, acceptMaterializedEnvironment);
      if (child === "no") return "no";
      if (child === "unknown") result = "unknown";
    }
  }
  if (isRecord(value)) {
    if (numericKeywordFails(schema, "minProperties", Object.keys(value).length, (actual, limit) => actual < limit)
      || numericKeywordFails(schema, "maxProperties", Object.keys(value).length, (actual, limit) => actual > limit)) return "no";
    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (required.some((key) =>
      !(acceptMaterializedEnvironment && key === "$use") && !Object.hasOwn(value, key))) return "no";
    if (schema.required !== undefined
      && (!Array.isArray(schema.required) || required.length !== schema.required.length)) result = "unknown";
    const validProperties = schema.properties === undefined || isRecord(schema.properties);
    if (!validProperties) result = "unknown";
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (schema.additionalProperties === false
      && Object.keys(value).some((key) => !Object.hasOwn(properties, key))) {
      if (validProperties && !Object.hasOwn(schema, "patternProperties")) return "no";
      result = "unknown";
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key) || !isRecord(child)) continue;
      const applicability = schemaBranchApplicability(child, value[key], acceptMaterializedEnvironment);
      if (applicability === "no") return "no";
      if (applicability === "unknown") result = "unknown";
    }
  }
  const oneOf = schemaArray(schema.oneOf);
  if (oneOf.length > 0) {
    const statuses = oneOf.map((branch) =>
      schemaBranchApplicability(branch, value, acceptMaterializedEnvironment));
    const matches = statuses.filter((status) => status === "match").length;
    if (matches > 1 || (matches === 0 && !statuses.includes("unknown"))) return "no";
    if (statuses.includes("unknown")) result = "unknown";
  }
  const anyOf = schemaArray(schema.anyOf);
  if (anyOf.length > 0) {
    const statuses = anyOf.map((branch) =>
      schemaBranchApplicability(branch, value, acceptMaterializedEnvironment));
    if (!statuses.includes("match") && !statuses.includes("unknown")) return "no";
    if (!statuses.includes("match")) result = "unknown";
  }
  for (const branch of schemaArray(schema.allOf)) {
    const status = schemaBranchApplicability(branch, value, acceptMaterializedEnvironment);
    if (status === "no") return "no";
    if (status === "unknown") result = "unknown";
  }
  if (isRecord(schema.not)) {
    const status = schemaBranchApplicability(schema.not, value, acceptMaterializedEnvironment);
    if (status === "match") return "no";
    if (status === "unknown") result = "unknown";
  }
  if (schema.if !== undefined) {
    const condition = schemaConditionApplicability(schema.if, value, acceptMaterializedEnvironment);
    if (condition === "unknown") {
      const outcomes = [schema.then, schema.else].map((branch) =>
        branch === undefined ? "match"
          : schemaConditionApplicability(branch, value, acceptMaterializedEnvironment));
      if (outcomes.every((outcome) => outcome === "no")) return "no";
      if (!outcomes.every((outcome) => outcome === "match")) result = "unknown";
    } else {
      const selected = condition === "match" ? schema.then : condition === "no" ? schema.else : undefined;
      if (selected !== undefined) {
        const outcome = schemaConditionApplicability(selected, value, acceptMaterializedEnvironment);
        if (outcome === "no") return "no";
        if (outcome === "unknown") result = "unknown";
      }
    }
  }
  return result;
}

function numericKeywordFails(
  schema: JsonSchema,
  key: string,
  actual: number,
  fails: (actual: number, limit: number) => boolean,
): boolean {
  const limit = schema[key];
  return typeof limit === "number" && Number.isFinite(limit) && fails(actual, limit);
}

function boundedPatternMatches(pattern: string, value: string): boolean | undefined {
  if (pattern.length > 256 || value.length > 512) return undefined;
  const anchoredStart = pattern.startsWith("^");
  let body = anchoredStart ? pattern.slice(1) : pattern;
  const anchoredEnd = body.endsWith("$") && !isEscaped(body, body.length - 1);
  if (anchoredEnd) body = body.slice(0, -1);
  let literal = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (character === "\\") {
      const escaped = body[index += 1];
      if (escaped === undefined || !".*+?()[]{}|^$/\\".includes(escaped)) return undefined;
      literal += escaped;
    } else {
      if (".*+?()[]{}|^$".includes(character)) return undefined;
      literal += character;
    }
  }
  return anchoredStart && anchoredEnd ? value === literal
    : anchoredStart ? value.startsWith(literal)
      : anchoredEnd ? value.endsWith(literal) : value.includes(literal);
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  while (index > 0 && value[index - 1] === "\\") { slashes += 1; index -= 1; }
  return slashes % 2 === 1;
}

function jsonSchemaEqual(left: unknown, right: unknown, depth = 0): boolean | undefined {
  if (left === right) return true;
  if (depth >= 64) return undefined;
  if (typeof left !== "object" || left === null
    || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    const equalities = left.map((entry, index) => jsonSchemaEqual(entry, right[index], depth + 1));
    return equalities.includes(false) ? false : equalities.includes(undefined) ? undefined : true;
  }
  if (!isRecord(left) || !isRecord(right)) return undefined;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length
    || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  const equalities = leftKeys.map((key) => jsonSchemaEqual(left[key], right[key], depth + 1));
  return equalities.includes(false) ? false : equalities.includes(undefined) ? undefined : true;
}

function schemaTypeApplicability(type: unknown, value: unknown): SchemaApplicability {
  if (type === undefined) return "match";
  if (Array.isArray(type)) {
    const statuses = type.map((entry) => schemaTypeApplicability(entry, value));
    return statuses.includes("unknown") ? "unknown" : statuses.includes("match") ? "match" : "no";
  }
  if (typeof type !== "string") return "unknown";
  if (isEnvironmentReference(value)) return type === "string" ? "match" : "no";
  switch (type) {
    case "null":
      return value === null ? "match" : "no";
    case "boolean":
      return typeof value === "boolean" ? "match" : "no";
    case "string":
      return typeof value === "string" ? "match" : "no";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? "match" : "no";
    case "integer":
      return typeof value === "number" && Number.isInteger(value) ? "match" : "no";
    case "array":
      return Array.isArray(value) ? "match" : "no";
    case "object":
      return isRecord(value) ? "match" : "no";
    default:
      return "unknown";
  }
}

function schemaArray(value: unknown): readonly JsonSchema[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isMaterializedEnvironmentReferenceSchema(schema: JsonSchema): boolean {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const variable = properties.$env;
  return schema.type === "object"
    && schema.additionalProperties === false
    && Array.isArray(schema.required)
    && schema.required.length === 1
    && schema.required[0] === "$env"
    && Object.keys(properties).length === 1
    && isRecord(variable)
    && variable.type === "string"
    && variable.pattern === "^[A-Za-z_][A-Za-z0-9_]*$";
}

function materializedEnvironmentValueSchema(schema: JsonSchema): JsonSchema | undefined {
  const variants = schemaArray(schema.oneOf);
  return Object.keys(schema).length === 1 && variants.length === 2
    && isMaterializedEnvironmentReferenceSchema(variants[1]!) ? variants[0] : undefined;
}

function childSchemasForProperty(schemas: readonly JsonSchema[], key: string): readonly JsonSchema[] {
  const output: JsonSchema[] = [];
  for (const schema of schemas) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (isRecord(properties[key])) output.push(properties[key]);
    else if (isRecord(schema.additionalProperties)) output.push(schema.additionalProperties);
  }
  return output.length === 0 ? [{}] : output;
}

function childSchemasForItems(schemas: readonly JsonSchema[]): readonly JsonSchema[] {
  const output = schemas.flatMap((schema) => isRecord(schema.items) ? [schema.items] : []);
  return output.length === 0 ? [{}] : output;
}

function isEnvironmentReference(value: unknown): value is { readonly $env: string } {
  return isRecord(value) && Object.keys(value).length === 1 && typeof value.$env === "string";
}

function moduleSchemaIssues(
  prefix: string,
  error: unknown,
  sensitiveValues: ReadonlySet<string>,
): readonly { path: string; message: string; code: string }[] {
  if (isRecord(error) && Array.isArray(error.issues)) {
    return error.issues.map((entry) => {
      if (!isRecord(entry)) return { path: prefix, message: String(entry), code: "module_schema" };
      const suffix = Array.isArray(entry.path) ? entry.path.map(String).join(".") : typeof entry.path === "string" ? entry.path : "";
      return {
        path: suffix.length === 0 ? prefix : `${prefix}.${suffix}`,
        message: typeof entry.message === "string"
          ? redactSensitiveValues(entry.message, sensitiveValues)
          : "module schema rejected value",
        code: typeof entry.code === "string" ? entry.code : "module_schema",
      };
    });
  }
  return [{
    path: prefix,
    message: redactSensitiveValues(errorMessage(error), sensitiveValues),
    code: "module_schema",
  }];
}

function redactSensitiveValues(message: string, sensitiveValues: ReadonlySet<string>): string {
  let redacted = message;
  for (const value of sensitiveValues) redacted = redacted.replaceAll(value, "[REDACTED]");
  return redacted;
}

function moduleIssue(selection: ModuleSelection, message: string, cause?: unknown): AgentModuleError {
  return new AgentModuleError(`${selection.configPath}: ${message}`, {
    packageName: selection.selected.$use,
    configPath: selection.configPath,
    ...(cause === undefined ? {} : { cause }),
  });
}

async function findPackageRoot(projectRequire: NodeJS.Require, expectedName: string): Promise<string> {
  const searchPaths = projectRequire.resolve.paths(expectedName) ?? [];
  for (const nodeModules of searchPaths) {
    const current = join(nodeModules, expectedName);
    try {
      const manifest = await readJson<PackageManifest>(join(current, "package.json"), `${expectedName} package.json`);
      if (manifest.name === expectedName) return current;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  throw new AgentModuleError(`Could not locate installed package root for ${expectedName}`);
}

async function readJson<T>(path: string, label: string): Promise<T> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new AgentModuleError(`Could not read ${label} at ${path}`, { cause: error });
  }
  try {
    return JSON.parse(source) as T;
  } catch (error) {
    throw new AgentModuleError(`${label} at ${path} is not valid JSON`, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  if (isRecord(error) && error.code === "ENOENT") return true;
  if (error instanceof AgentModuleError && isRecord(error.cause) && error.cause.code === "ENOENT") return true;
  return false;
}
