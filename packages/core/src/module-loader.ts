import { createRequire } from "node:module";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { isProxy } from "node:util/types";

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
import type { ModuleSelection } from "./config.js";
import type { GenericModuleDefinition, LoadedAgentModule, ModuleKind } from "./types.js";
import type { AgentConfigIssue } from "./errors.js";

const moduleConfigs = new WeakMap<LoadedAgentModule, unknown>();
const MODULE_CONFIG_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const MODULE_CONFIG_SNAPSHOT_MAX_DEPTH = 64;
const MODULE_CONFIG_SNAPSHOT_MAX_ITEMS = 50_000;
const UNSAFE_CONFIG_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function moduleConfigFor(module: LoadedAgentModule): unknown {
  if (!moduleConfigs.has(module)) throw new AgentModuleError(`Parsed config is unavailable for ${module.packageName}`);
  return moduleConfigs.get(module);
}

export function validateLoadedModuleReferences(
  modules: readonly LoadedAgentModule[],
): readonly AgentConfigIssue[] {
  const issues: AgentConfigIssue[] = [];
  for (const module of modules) {
    visitModuleReferences(
      moduleConfigFor(module),
      module.definition.schema.jsonSchema,
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
          return typeof resolved !== "string" || !isConcreteLockVersion(resolved) || lockVersionMatches(resolved, installedVersion);
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
  const dependencySpec = directDependencySpec(projectManifest, packageName);
  if (dependencySpec === undefined) {
    throw moduleIssue(selection, `${packageName} must be a direct project dependency`);
  }
  if (isForbiddenDependencySpec(dependencySpec)) {
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
  const resolvedInline = resolveEnvironmentDirectives(
    inline,
    definition.schema.jsonSchema,
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

interface ModuleConfigSnapshotState {
  readonly active: Set<object>;
  readonly copies: WeakMap<object, object>;
  bytes: number;
  items: number;
}

function snapshotModuleConfig(value: unknown, path: string): unknown {
  return snapshotModuleConfigValue(
    value,
    path,
    0,
    {
      active: new Set(),
      copies: new WeakMap(),
      bytes: 0,
      items: 0,
    },
  );
}

function snapshotModuleConfigValue(
  value: unknown,
  path: string,
  depth: number,
  state: ModuleConfigSnapshotState,
): unknown {
  addModuleConfigItem(state, path);
  if (value === undefined || value === null || typeof value === "boolean") {
    chargeModuleConfigBytes(state, 8, path);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must contain only finite numbers`);
    }
    chargeModuleConfigBytes(state, 16, path);
    return value;
  }
  if (typeof value === "string") {
    chargeModuleConfigBytes(state, Buffer.byteLength(value, "utf8"), path);
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} must contain only plain config values`);
  }
  if (isProxy(value)) {
    throw new TypeError(`${path} must not contain a Proxy`);
  }
  if (depth >= MODULE_CONFIG_SNAPSHOT_MAX_DEPTH) {
    throw new TypeError(
      `${path} exceeds the ${String(MODULE_CONFIG_SNAPSHOT_MAX_DEPTH)}-level depth boundary`,
    );
  }
  if (state.active.has(value)) {
    throw new TypeError(`${path} must not contain cycles`);
  }
  const prior = state.copies.get(value);
  if (prior !== undefined) return prior;

  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      throw new TypeError(`${path} must use the ordinary Array prototype`);
    }
    return snapshotModuleConfigArray(value, path, depth, state);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  return snapshotModuleConfigRecord(
    value as Record<string, unknown>,
    prototype,
    path,
    depth,
    state,
  );
}

function snapshotModuleConfigArray(
  value: readonly unknown[],
  path: string,
  depth: number,
  state: ModuleConfigSnapshotState,
): readonly unknown[] {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new TypeError(`${path}.length must be a non-negative safe integer data property`);
  }
  if (length > MODULE_CONFIG_SNAPSHOT_MAX_ITEMS) {
    throw new TypeError(
      `${path} exceeds the ${String(MODULE_CONFIG_SNAPSHOT_MAX_ITEMS)}-item boundary`,
    );
  }
  const allowed = new Set(["length"]);
  for (let index = 0; index < length; index += 1) allowed.add(String(index));
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${path} contains a non-index array property`);
    }
  }

  const output: unknown[] = [];
  state.copies.set(value, output);
  state.active.add(value);
  try {
    for (let index = 0; index < length; index += 1) {
      const indexPath = `${path}[${String(index)}]`;
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined) {
        throw new TypeError(`${indexPath} is required`);
      }
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`${indexPath} must be an enumerable data property`);
      }
      output.push(snapshotModuleConfigValue(descriptor.value, indexPath, depth + 1, state));
    }
  } finally {
    state.active.delete(value);
  }
  return Object.freeze(output);
}

function snapshotModuleConfigRecord(
  value: Record<string, unknown>,
  prototype: object | null,
  path: string,
  depth: number,
  state: ModuleConfigSnapshotState,
): Readonly<Record<string, unknown>> {
  const output = Object.create(prototype) as Record<string, unknown>;
  state.copies.set(value, output);
  state.active.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length > MODULE_CONFIG_SNAPSHOT_MAX_ITEMS) {
      throw new TypeError(
        `${path} exceeds the ${String(MODULE_CONFIG_SNAPSHOT_MAX_ITEMS)}-property boundary`,
      );
    }
    for (const key of keys) {
      if (typeof key !== "string") {
        throw new TypeError(`${path} must not contain symbol properties`);
      }
      if (UNSAFE_CONFIG_KEYS.has(key)) {
        throw new TypeError(`${path} contains unsafe property ${JSON.stringify(key)}`);
      }
      chargeModuleConfigBytes(state, Buffer.byteLength(key, "utf8"), path);
      const propertyPath = `${path}.${key}`;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`${propertyPath} must be an enumerable data property`);
      }
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: snapshotModuleConfigValue(
          descriptor.value,
          propertyPath,
          depth + 1,
          state,
        ),
        writable: true,
      });
    }
  } finally {
    state.active.delete(value);
  }
  return Object.freeze(output);
}

function addModuleConfigItem(state: ModuleConfigSnapshotState, path: string): void {
  state.items += 1;
  if (state.items > MODULE_CONFIG_SNAPSHOT_MAX_ITEMS) {
    throw new TypeError(
      `${path} exceeds the ${String(MODULE_CONFIG_SNAPSHOT_MAX_ITEMS)}-item boundary`,
    );
  }
}

function chargeModuleConfigBytes(
  state: ModuleConfigSnapshotState,
  bytes: number,
  path: string,
): void {
  state.bytes += bytes;
  if (state.bytes > MODULE_CONFIG_SNAPSHOT_MAX_BYTES) {
    throw new TypeError(
      `${path} exceeds the ${String(MODULE_CONFIG_SNAPSHOT_MAX_BYTES)}-byte boundary`,
    );
  }
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
    if (isOpenModuleKind(preflight.selection.slot)) {
      assertModuleDefinitionCompliance(value, {
        expectedKind: preflight.selection.slot,
        expectedPackageName: preflight.packageName,
        expectedPackageVersion: preflight.packageVersion,
      });
    } else {
      assertReservedModuleManifestCompliance(value);
      assertSchemaCompliance(value.schema);
    }
  } catch (error) {
    throw moduleIssue(
      preflight.selection,
      `${preflight.packageName} exports a non-compliant monoAgentModule: ${errorMessage(error)}`,
      error,
    );
  }
}

function isOpenModuleKind(kind: ModuleKind): kind is "runtime" | "channel" | "memory" {
  return kind === "runtime" || kind === "channel" || kind === "memory";
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

function resolveEnvironmentDirectives(
  value: unknown,
  schema: JsonSchema,
  environment: Readonly<Record<string, string | undefined>>,
  path: string,
  resolvedEnvironmentValues: Set<string>,
): unknown {
  return resolveEnvironmentDirectivesFromSchemas(
    value,
    [schema],
    environment,
    path,
    resolvedEnvironmentValues,
  );
}

function resolveEnvironmentDirectivesFromSchemas(
  value: unknown,
  schemas: readonly JsonSchema[],
  environment: Readonly<Record<string, string | undefined>>,
  path: string,
  resolvedEnvironmentValues: Set<string>,
): unknown {
  const activeSchemas = applicableSchemas(schemas, value);
  if (isEnvironmentReference(value)) {
    if (!activeSchemas.some(isEnvEligibleSchema)) {
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
    const items = childSchemasForItems(activeSchemas);
    return value.map((entry, index) => resolveEnvironmentDirectivesFromSchemas(
      entry,
      items,
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
      childSchemasForProperty(activeSchemas, key),
      environment,
      `${path}.${key}`,
      resolvedEnvironmentValues,
    );
  }
  return output;
}

function visitModuleReferences(
  value: unknown,
  schema: JsonSchema,
  path: string,
  modules: readonly LoadedAgentModule[],
  issues: AgentConfigIssue[],
): void {
  visitModuleReferencesFromSchemas(value, [schema], path, modules, issues);
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
    const matchingOneOf = oneOf.filter((branch) => schemaBranchMatches(branch, value));
    if (matchingOneOf.length === 1) visit(matchingOneOf[0]!);
    const anyOf = schemaArray(schema.anyOf).filter((branch) => schemaBranchMatches(branch, value));
    for (const branch of anyOf) visit(branch);
  };
  for (const schema of schemas) visit(schema);
  return output;
}

function schemaBranchMatches(schema: JsonSchema, value: unknown): boolean {
  if (Object.hasOwn(schema, "const") && !Object.is(schema.const, value)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) return false;
  if (!schemaTypeMatches(schema.type, value)) return false;
  if (!isRecord(value) || isEnvironmentReference(value)) return true;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (required.some((key) => !Object.hasOwn(value, key))) return false;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  if (schema.additionalProperties === false
    && Object.keys(value).some((key) => !Object.hasOwn(properties, key))) return false;
  for (const [key, child] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key) || !isRecord(child)) continue;
    if (!schemaBranchMatches(child, value[key])) return false;
  }
  const oneOf = schemaArray(schema.oneOf);
  if (oneOf.length > 0 && oneOf.filter((branch) => schemaBranchMatches(branch, value)).length !== 1) return false;
  const anyOf = schemaArray(schema.anyOf);
  if (anyOf.length > 0 && !anyOf.some((branch) => schemaBranchMatches(branch, value))) return false;
  return schemaArray(schema.allOf).every((branch) => schemaBranchMatches(branch, value));
}

function schemaTypeMatches(type: unknown, value: unknown): boolean {
  if (Array.isArray(type)) {
    const types = type.filter((entry): entry is string => typeof entry === "string");
    return types.length > 0 && types.some((entry) => schemaTypeMatches(entry, value));
  }
  if (typeof type !== "string") return true;
  if (isEnvironmentReference(value)) return type === "string";
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    default:
      return false;
  }
}

function schemaArray(value: unknown): readonly JsonSchema[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
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

function directDependencySpec(manifest: PackageManifest, packageName: string): string | undefined {
  return manifest.dependencies?.[packageName] ?? manifest.optionalDependencies?.[packageName];
}

function isForbiddenDependencySpec(spec: string): boolean {
  return /^(?:npm:|file:|link:|portal:|patch:|git(?:\+|:)|https?:|github:|\.\.?\/|\/)/u.test(spec);
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

function isConcreteLockVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?:\([^)]*\))?$/u.test(value);
}

function lockVersionMatches(locked: string, installedVersion: string): boolean {
  return locked === installedVersion || locked.startsWith(`${installedVersion}(`);
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
