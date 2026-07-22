import { createRequire } from "node:module";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import {
  isEnvEligibleSchema,
  isSecretSchema,
  MODULE_API_VERSION,
  type JsonSchema,
} from "@mono-agent/module-sdk";
import { parse as parseYaml } from "yaml";

import { AgentConfigError, AgentModuleError, errorMessage } from "./errors.js";
import type { ModuleSelection } from "./config.js";
import type { GenericModuleDefinition, LoadedAgentModule, ModuleKind } from "./types.js";

const moduleConfigs = new WeakMap<LoadedAgentModule, unknown>();

export function moduleConfigFor(module: LoadedAgentModule): unknown {
  if (!moduleConfigs.has(module)) throw new AgentModuleError(`Parsed config is unavailable for ${module.packageName}`);
  return moduleConfigs.get(module);
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
  if (!isModuleDefinition(definition)) {
    throw moduleIssue(preflight.selection, `${preflight.packageName} must export monoAgentModule`);
  }
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
    config = definition.schema.parse(resolvedInline);
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

function isModuleDefinition(value: unknown): value is GenericModuleDefinition {
  if (!isRecord(value) || !isRecord(value.manifest) || !isRecord(value.schema)) return false;
  return (
    typeof value.manifest.packageName === "string" &&
    typeof value.manifest.packageVersion === "string" &&
    value.manifest.apiVersion === 1 &&
    typeof value.manifest.kind === "string" &&
    typeof value.manifest.responsibility === "string" &&
    isRecord(value.schema.jsonSchema) &&
    typeof value.schema.parse === "function" &&
    typeof value.create === "function"
  );
}

function resolveEnvironmentDirectives(
  value: unknown,
  schema: JsonSchema,
  environment: Readonly<Record<string, string | undefined>>,
  path: string,
  resolvedEnvironmentValues: Set<string>,
): unknown {
  if (isEnvironmentReference(value)) {
    if (!isEnvEligibleSchema(schema)) {
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
  if (isSecretSchema(schema)) {
    throw new AgentConfigError("Inline secret is forbidden", [{
      path,
      message: "secret values must use an explicit {$env:NAME} reference",
      code: "inline_secret",
    }]);
  }
  if (Array.isArray(value)) {
    const items = isRecord(schema.items) ? schema.items : {};
    return value.map((entry, index) => resolveEnvironmentDirectives(
      entry,
      items,
      environment,
      `${path}.${index}`,
      resolvedEnvironmentValues,
    ));
  }
  if (!isRecord(value)) return value;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    const childSchema = isRecord(properties[key]) ? properties[key] : {};
    output[key] = resolveEnvironmentDirectives(
      entry,
      childSchema,
      environment,
      `${path}.${key}`,
      resolvedEnvironmentValues,
    );
  }
  return output;
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
