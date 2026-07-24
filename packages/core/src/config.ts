import { dirname, isAbsolute, resolve } from "node:path";
import {
  type RuntimeModelDescriptor,
  type RuntimeModelValidation,
  type RuntimeModuleDefinition,
} from "@mono-agent/module-sdk";
import {
  AuthorityReadError,
  decodeAuthorityText,
  DEFAULT_AUTHORITY_MAX_BYTES,
  readAuthorityFile,
  type AuthorityFileSnapshot,
} from "./authority-read.js";
import { AgentConfigError, AgentModuleError, type AgentConfigIssue, errorMessage } from "./errors.js";
import {
  loadSelectedModules,
  moduleConfigFor,
  validateLoadedModuleReferences,
} from "./module-loader.js";
import { parseProjectMcpConfig, type ProjectMcpConfig } from "./mcp.js";
import { runtimeNativeToolPolicyIssue } from "./native-tool-policy.js";
import { normalizeRuntimeModelValidation } from "./runtime-result-normalizer.js";
import type {
  AgentConfig,
  AgentLoadOptions,
  AgentValidationResult,
  LoadedAgentConfig,
  LoadedAgentModule,
  ModuleKind,
  ResolvedAgentPaths,
  SelectedModuleConfig,
} from "./types.js";
const TOP_LEVEL_KEYS = new Set([
  "$schema",
  "configVersion",
  "agent",
  "runtimes",
  "routing",
  "session",
  "context",
  "channels",
  "memory",
  "state",
  "triggers",
  "observability",
  "policy",
]);
export const MAX_CONTEXT_BYTES = 1_000_000;
type ConfiguredRuntimeModel = Readonly<RuntimeModelDescriptor & { readonly runtime: string }>;
interface RuntimeRouteValidation { readonly issues: readonly AgentConfigIssue[]; readonly models: readonly ConfiguredRuntimeModel[]; }
const environments = new WeakMap<LoadedAgentConfig, Readonly<Record<string, string | undefined>>>();
const runtimeModels = new WeakMap<LoadedAgentConfig, readonly ConfiguredRuntimeModel[]>();
const validatedConfigs = new WeakSet<LoadedAgentConfig>();
export async function loadAgentConfig(
  configPath: string,
  options: AgentLoadOptions = {},
): Promise<LoadedAgentConfig> {
  const absoluteConfigPath = resolve(configPath);
  const configDirectory = dirname(absoluteConfigPath);
  const projectRoot = resolve(options.projectRoot ?? configDirectory);
  let configSnapshot: AuthorityFileSnapshot;
  try {
    configSnapshot = await readAuthorityFile(absoluteConfigPath, {
      maxBytes: DEFAULT_AUTHORITY_MAX_BYTES,
      requireSingleLink: true,
    });
  } catch (error) {
    throw new AgentConfigError(`Could not read agent config ${absoluteConfigPath}`, [
      { path: "$", message: errorMessage(error), code: "config_read" },
    ]);
  }
  let source: string;
  try {
    source = decodeAuthorityText(configSnapshot);
  } catch (error) {
    throw new AgentConfigError(`Agent config is not valid UTF-8: ${absoluteConfigPath}`, [
      { path: "$", message: errorMessage(error), code: "invalid_utf8" },
    ]);
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(source) as unknown;
  } catch (error) {
    throw new AgentConfigError(`Agent config is not strict JSON: ${absoluteConfigPath}`, [
      { path: "$", message: errorMessage(error), code: "invalid_json" },
    ]);
  }
  const issues = validateAgentEnvelope(candidate);
  if (issues.length > 0) {
    throw new AgentConfigError(`Agent config is invalid: ${absoluteConfigPath}`, issues);
  }
  const raw = candidate as AgentConfig;
  const paths = resolveAgentPaths(raw, configDirectory);
  const environment = snapshotEnvironment(options.environment ?? process.env);
  const projectMcp = await loadProjectMcpSnapshot(paths.mcpConfig, environment);
  const requestContextIssues = validateMcpRequestContextServers(raw, projectMcp.config);
  if (requestContextIssues.length > 0) {
    throw new AgentConfigError(
      `Configured MCP request-context servers are invalid: ${absoluteConfigPath}`,
      requestContextIssues,
    );
  }
  const selections = collectModuleSelections(raw);
  let modules: readonly LoadedAgentModule[];
  try {
    modules = await loadSelectedModules({ projectRoot, selections, environment });
  } catch (error) {
    if (error instanceof AgentConfigError) throw error;
    if (error instanceof AgentModuleError && error.code !== undefined) {
      throw new AgentConfigError(`Selected module validation failed: ${absoluteConfigPath}`, [
        { path: error.configPath ?? "$", message: error.message, code: error.code },
      ]);
    }
    throw new AgentConfigError(`Selected module validation failed: ${absoluteConfigPath}`, [
      { path: "$", message: errorMessage(error), code: "module_load" },
    ]);
  }
  const referenceIssues = validateLoadedModuleReferences(modules);
  if (referenceIssues.length > 0) {
    throw new AgentConfigError(`Selected module references are invalid: ${absoluteConfigPath}`, referenceIssues);
  }
  const routeValidation = validateRuntimeRoutes(raw, modules);
  if (routeValidation.issues.length > 0) {
    throw new AgentConfigError(`Configured runtime routes are invalid: ${absoluteConfigPath}`,
      routeValidation.issues);
  }
  const loaded: LoadedAgentConfig = deepFreeze({
    configPath: absoluteConfigPath,
    configDirectory,
    projectRoot,
    raw,
    paths,
    sources: {
      config: configSnapshot.source,
      ...(projectMcp.source === undefined ? {} : { mcp: projectMcp.source }),
    },
    mcp: projectMcp.config,
    modules,
  });
  validatedConfigs.add(loaded);
  environments.set(loaded, environment);
  runtimeModels.set(loaded, routeValidation.models);
  return loaded;
}
function validateRuntimeRoutes(
  config: AgentConfig,
  modules: readonly LoadedAgentModule[],
): RuntimeRouteValidation {
  const issues: AgentConfigIssue[] = [];
  const models: ConfiguredRuntimeModel[] = [];
  const seen = new Set<string>();
  const routes = [config.routing.primary, ...config.routing.fallbacks];
  for (const [index, route] of routes.entries()) {
    const routePath = index === 0 ? "routing.primary" : `routing.fallbacks.${index - 1}`;
    const key = `${route.runtime}\0${route.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const loaded = modules.find((module) =>
      module.slot === "runtime" && module.instanceId === route.runtime);
    if (loaded === undefined) continue;
    const definition = loaded.definition as RuntimeModuleDefinition;
    let validation: RuntimeModelValidation = { supported: true };
    if (definition.validateModel !== undefined) {
      try {
        const rawValidation = definition.validateModel({
          model: route.model,
          config: moduleConfigFor(loaded),
        });
        if (typeof rawValidation === "object" && rawValidation !== null
          && typeof Reflect.get(rawValidation, "then") === "function") {
          throw new TypeError("runtime definition validateModel must be synchronous");
        }
        validation = normalizeRuntimeModelValidation(
          rawValidation,
          "runtime definition validateModel result",
        );
      } catch (error) {
        issue(issues, `${routePath}.model`, errorMessage(error), "runtime_model_validation");
        continue;
      }
    }
    if (!validation.supported) {
      issue(issues, `${routePath}.model`,
        `${loaded.packageName} does not support model ${JSON.stringify(route.model)}`, "unsupported_model");
      continue;
    }
    if (validation.model !== undefined && validation.model.id !== route.model) {
      issue(issues, `${routePath}.model`,
        `${loaded.packageName} described model ${JSON.stringify(validation.model.id)} for requested model ${JSON.stringify(route.model)}`,
        "runtime_model_validation");
      continue;
    }
    if (index === 0 && config.routing.effort !== undefined && validation.model?.efforts !== undefined
      && !validation.model.efforts.includes(config.routing.effort)) {
      issue(issues, "routing.effort",
        `${loaded.packageName} model ${JSON.stringify(route.model)} does not support effort ${JSON.stringify(config.routing.effort)}`,
        "unsupported_effort");
    }
    models.push(Object.freeze({
      runtime: route.runtime,
      ...validation.model,
      id: route.model,
      ...(validation.model?.efforts === undefined
        ? {}
        : { efforts: Object.freeze([...validation.model.efforts]) }),
    }));
    const nativeToolIssue = runtimeNativeToolPolicyIssue({
      nativeTools: validation.nativeTools ?? [],
      ...(validation.capabilities === undefined
        ? {}
        : { capabilities: validation.capabilities }),
      config,
    });
    if (nativeToolIssue !== undefined) {
      issue(issues, `${routePath}.model`, `${loaded.packageName} ${nativeToolIssue}`, "native_tool_policy");
    }
  }
  return { issues: Object.freeze(issues), models: Object.freeze(models) };
}
export async function validateAgentConfig(
  configPath: string,
  options: AgentLoadOptions = {},
): Promise<AgentValidationResult> {
  try {
    return { ok: true, issues: [], loaded: await loadAgentConfig(configPath, options) };
  } catch (error) {
    if (error instanceof AgentConfigError) return { ok: false, issues: error.issues };
    return {
      ok: false,
      issues: [{ path: "$", message: errorMessage(error), code: "unexpected" }],
    };
  }
}
export function environmentFor(config: LoadedAgentConfig): Readonly<Record<string, string | undefined>> {
  return environments.get(config) ?? process.env;
}
export function runtimeModelsFor(
  config: LoadedAgentConfig,
): readonly ConfiguredRuntimeModel[] {
  const models = runtimeModels.get(config);
  if (models === undefined) throw new TypeError("Loaded agent config has no validated runtime models");
  return models;
}
export function isLoadedAgentConfig(value: unknown): value is LoadedAgentConfig {
  return isRecord(value) && validatedConfigs.has(value as unknown as LoadedAgentConfig);
}
export async function ensureLoadedAgentConfig(
  value: string | LoadedAgentConfig,
  options: AgentLoadOptions = {},
): Promise<LoadedAgentConfig> {
  if (typeof value === "string") return loadAgentConfig(value, options);
  if (isLoadedAgentConfig(value)) return value;
  throw new AgentConfigError("Loaded agent config is not a validated Core snapshot", [
    {
      path: "$",
      message: "pass the exact object returned by loadAgentConfig or validateAgentConfig",
      code: "unvalidated_snapshot",
    },
  ]);
}
export interface ModuleSelection {
  readonly slot: ModuleKind;
  readonly instanceId: string;
  readonly configPath: string;
  readonly selected: SelectedModuleConfig;
}
export function collectModuleSelections(config: AgentConfig): readonly ModuleSelection[] {
  const selections: ModuleSelection[] = [];
  addMapSelections(selections, "runtime", "runtimes", config.runtimes);
  addMapSelections(selections, "channel", "channels", config.channels ?? {});
  if (config.memory !== undefined) addSingletonSelection(selections, "memory", "memory", config.memory);
  if (config.state !== undefined) addSingletonSelection(selections, "state", "state", config.state);
  addMapSelections(selections, "trigger", "triggers", config.triggers ?? {});
  addMapSelections(selections, "exporter", "observability.exporters", config.observability?.exporters ?? {});
  if (!("mode" in config.policy.sandbox && config.policy.sandbox.mode === "off")) {
    addSingletonSelection(selections, "sandbox", "policy.sandbox", config.policy.sandbox as SelectedModuleConfig);
  }
  return selections;
}
function addMapSelections(
  output: ModuleSelection[],
  slot: ModuleKind,
  prefix: string,
  values: Readonly<Record<string, SelectedModuleConfig>>,
): void {
  for (const instanceId of Object.keys(values).sort()) {
    const selected = values[instanceId];
    if (selected !== undefined) output.push({ slot, instanceId, configPath: `${prefix}.${instanceId}`, selected });
  }
}
function addSingletonSelection(
  output: ModuleSelection[],
  slot: ModuleKind,
  configPath: string,
  selected: SelectedModuleConfig,
): void {
  output.push({ slot, instanceId: slot, configPath, selected });
}
export function validateAgentEnvelope(input: unknown): readonly AgentConfigIssue[] {
  const issues: AgentConfigIssue[] = [];
  if (!isRecord(input)) return [{ path: "$", message: "must be a JSON object", code: "type" }];
  rejectUnknown(input, TOP_LEVEL_KEYS, "$", issues);
  if (input.configVersion !== 1) issue(issues, "configVersion", "must be exactly 1", "version");
  if (input.$schema !== undefined) expectString(input.$schema, "$schema", issues);
  validateAgent(input.agent, issues);
  validateModuleMap(input.runtimes, "runtimes", issues, true);
  validateRouting(input.routing, input.runtimes, issues);
  validateSession(input.session, issues);
  validateContext(input.context, issues);
  validateModuleMap(input.channels, "channels", issues, false);
  validateSelectedModule(input.memory, "memory", issues, false);
  validateSelectedModule(input.state, "state", issues, false);
  validateModuleMap(input.triggers, "triggers", issues, false);
  validateObservability(input.observability, issues);
  validatePolicy(input.policy, issues);
  return issues;
}
function validateAgent(value: unknown, issues: AgentConfigIssue[]): void {
  if (!expectRecord(value, "agent", issues)) return;
  rejectUnknown(value, new Set(["id", "name", "instructions", "workspace"]), "agent", issues);
  expectNonEmptyString(value.id, "agent.id", issues);
  expectNonEmptyString(value.name, "agent.name", issues);
  expectNonEmptyString(value.instructions, "agent.instructions", issues);
  expectNonEmptyString(value.workspace, "agent.workspace", issues);
  if (typeof value.id === "string" && !/^[a-z0-9][a-z0-9._-]*$/u.test(value.id)) {
    issue(issues, "agent.id", "must use lowercase letters, digits, dot, underscore, or hyphen", "format");
  }
}
function validateRouting(value: unknown, runtimes: unknown, issues: AgentConfigIssue[]): void {
  if (!expectRecord(value, "routing", issues)) return;
  rejectUnknown(value, new Set(["primary", "fallbacks", "effort"]), "routing", issues);
  validateRoute(value.primary, "routing.primary", runtimes, issues);
  if (!Array.isArray(value.fallbacks)) {
    issue(issues, "routing.fallbacks", "must be an array", "type");
  } else {
    value.fallbacks.forEach((route, index) => validateRoute(route, `routing.fallbacks.${index}`, runtimes, issues));
  }
  if (value.effort !== undefined) expectNonEmptyString(value.effort, "routing.effort", issues);
}
function validateRoute(value: unknown, path: string, runtimes: unknown, issues: AgentConfigIssue[]): void {
  if (!expectRecord(value, path, issues)) return;
  rejectUnknown(value, new Set(["runtime", "model"]), path, issues);
  expectNonEmptyString(value.runtime, `${path}.runtime`, issues);
  expectNonEmptyString(value.model, `${path}.model`, issues);
  if (typeof value.runtime === "string" && isRecord(runtimes) && !(value.runtime in runtimes)) {
    issue(issues, `${path}.runtime`, `references unconfigured runtime ${JSON.stringify(value.runtime)}`, "reference");
  }
}
function validateSession(value: unknown, issues: AgentConfigIssue[]): void {
  if (value === undefined) return;
  if (!expectRecord(value, "session", issues)) return;
  rejectUnknown(
    value,
    new Set(["mode", "idleTimeoutMs", "rollover", "timezone", "isolateProactiveRuns"]),
    "session",
    issues,
  );
  expectEnum(value.mode, ["continuous", "per-message"], "session.mode", issues);
  if (value.idleTimeoutMs !== undefined) expectPositiveInteger(value.idleTimeoutMs, "session.idleTimeoutMs", issues);
  if (value.rollover !== undefined) expectEnum(value.rollover, ["none", "daily"], "session.rollover", issues);
  if (value.timezone !== undefined) expectIanaTimeZone(value.timezone, "session.timezone", issues);
  if (value.isolateProactiveRuns !== undefined) expectBoolean(value.isolateProactiveRuns, "session.isolateProactiveRuns", issues);
}
function validateContext(value: unknown, issues: AgentConfigIssue[]): void {
  if (value === undefined) return;
  if (!expectRecord(value, "context", issues)) return;
  rejectUnknown(value, new Set(["skills", "mcp"]), "context", issues);
  if (value.skills !== undefined) {
    if (expectRecord(value.skills, "context.skills", issues)) {
      rejectUnknown(value.skills, new Set(["roots", "load", "disclosure", "maxBytes"]), "context.skills", issues);
      expectStringArray(value.skills.roots, "context.skills.roots", issues);
      if (value.skills.load !== undefined) expectEnum(value.skills.load, ["all"], "context.skills.load", issues);
      if (value.skills.disclosure !== undefined) {
        expectEnum(value.skills.disclosure, ["full", "index"], "context.skills.disclosure", issues);
      }
      if (value.skills.maxBytes !== undefined) {
        expectPositiveInteger(value.skills.maxBytes, "context.skills.maxBytes", issues);
        if (typeof value.skills.maxBytes === "number"
          && Number.isSafeInteger(value.skills.maxBytes)
          && value.skills.maxBytes > MAX_CONTEXT_BYTES) {
          issue(
            issues,
            "context.skills.maxBytes",
            `must not exceed the hard context ceiling of ${MAX_CONTEXT_BYTES} bytes`,
            "range",
          );
        }
      }
    }
  }
  if (value.mcp !== undefined && expectRecord(value.mcp, "context.mcp", issues)) {
    rejectUnknown(value.mcp, new Set(["configPath", "requestContextServers"]), "context.mcp", issues);
    expectNonEmptyString(value.mcp.configPath, "context.mcp.configPath", issues);
    if (value.mcp.requestContextServers !== undefined
      && expectStringArray(value.mcp.requestContextServers, "context.mcp.requestContextServers", issues)) {
      if (value.mcp.requestContextServers.length > 32) {
        issue(issues, "context.mcp.requestContextServers", "must contain at most 32 server names", "limit");
      }
      const seen = new Set<string>();
      value.mcp.requestContextServers.forEach((name, index) => {
        if (typeof name === "string" && seen.has(name))
          issue(issues, `context.mcp.requestContextServers.${index}`, "must be unique", "duplicate");
        else if (typeof name === "string") seen.add(name);
      });
    }
  }
}
function validateObservability(value: unknown, issues: AgentConfigIssue[]): void {
  if (value === undefined) return;
  if (!expectRecord(value, "observability", issues)) return;
  rejectUnknown(value, new Set(["exporters"]), "observability", issues);
  validateModuleMap(value.exporters, "observability.exporters", issues, false);
}
function validatePolicy(value: unknown, issues: AgentConfigIssue[]): void {
  if (!expectRecord(value, "policy", issues)) return;
  rejectUnknown(value, new Set(["tools", "approvals", "sandbox"]), "policy", issues);
  if (expectRecord(value.tools, "policy.tools", issues)) {
    rejectUnknown(value.tools, new Set(["default", "allow", "deny"]), "policy.tools", issues);
    expectEnum(value.tools.default, ["allow", "deny"], "policy.tools.default", issues);
    if (value.tools.allow !== undefined) expectStringArray(value.tools.allow, "policy.tools.allow", issues);
    if (value.tools.deny !== undefined) expectStringArray(value.tools.deny, "policy.tools.deny", issues);
    if (value.tools.default === "deny" && value.tools.deny !== undefined) {
      issue(issues, "policy.tools.deny", "is not valid when default is deny; use allow", "policy");
    }
    if (value.tools.default === "allow" && value.tools.allow !== undefined) {
      issue(issues, "policy.tools.allow", "is not valid when default is allow; use deny", "policy");
    }
  }
  if (expectRecord(value.approvals, "policy.approvals", issues)) {
    rejectUnknown(value.approvals, new Set(["default", "timeoutMs"]), "policy.approvals", issues);
    expectEnum(value.approvals.default, ["allow", "ask", "deny"], "policy.approvals.default", issues);
    if (value.approvals.timeoutMs !== undefined) {
      expectPositiveInteger(value.approvals.timeoutMs, "policy.approvals.timeoutMs", issues);
      if (
        typeof value.approvals.timeoutMs === "number"
        && value.approvals.timeoutMs > 3_600_000
      ) {
        issue(
          issues,
          "policy.approvals.timeoutMs",
          "must be at most 3600000",
          "range",
        );
      }
    }
  }
  if (!expectRecord(value.sandbox, "policy.sandbox", issues)) return;
  if (value.sandbox.mode === "off") {
    rejectUnknown(value.sandbox, new Set(["mode"]), "policy.sandbox", issues);
  } else {
    validateSelectedModule(value.sandbox, "policy.sandbox", issues, true);
  }
}
function validateModuleMap(value: unknown, path: string, issues: AgentConfigIssue[], required: boolean): void {
  if (value === undefined) {
    if (required) issue(issues, path, "is required", "required");
    return;
  }
  if (!expectRecord(value, path, issues)) return;
  for (const [instanceId, selected] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(instanceId)) {
      issue(issues, `${path}.${instanceId}`, "instance id must be lowercase and path-safe", "format");
    }
    validateSelectedModule(selected, `${path}.${instanceId}`, issues, true);
  }
}
function validateSelectedModule(value: unknown, path: string, issues: AgentConfigIssue[], required: boolean): void {
  if (value === undefined) {
    if (required) issue(issues, path, "is required", "required");
    return;
  }
  if (!expectRecord(value, path, issues)) return;
  expectNonEmptyString(value.$use, `${path}.$use`, issues);
  if (typeof value.$use === "string" && !isBarePackageName(value.$use)) {
    issue(issues, `${path}.$use`, "must be a literal bare npm package name (no path, URL, subpath, or alias)", "package_name");
  }
  for (const key of Object.keys(value)) {
    if (key.startsWith("$") && key !== "$use") {
      issue(issues, `${path}.${key}`, "is not a recognized core module directive", "unknown_directive");
    }
  }
}
export function isBarePackageName(value: string): boolean {
  if (value.length === 0 || value.length > 214 || value.includes("\\") || value.includes(":")) return false;
  if (value.startsWith(".") || value.startsWith("/") || value.includes("//")) return false;
  return /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u.test(value);
}
function resolveAgentPaths(config: AgentConfig, configDirectory: string): ResolvedAgentPaths {
  const fromConfig = (value: string): string => (isAbsolute(value) ? value : resolve(configDirectory, value));
  return {
    ...(config.$schema === undefined ? {} : { schema: fromConfig(config.$schema) }),
    instructions: fromConfig(config.agent.instructions),
    workspace: fromConfig(config.agent.workspace),
    skillRoots: (config.context?.skills?.roots ?? []).map(fromConfig),
    ...(config.context?.mcp?.configPath === undefined
      ? {}
      : { mcpConfig: fromConfig(config.context.mcp.configPath) }),
  };
}
function rejectUnknown(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: AgentConfigIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(issues, path === "$" ? key : `${path}.${key}`, "is not allowed", "unknown");
  }
}
function expectRecord(value: unknown, path: string, issues: AgentConfigIssue[]): value is Record<string, unknown> {
  if (isRecord(value)) return true;
  issue(issues, path, "must be an object", "type");
  return false;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function expectString(value: unknown, path: string, issues: AgentConfigIssue[]): value is string {
  if (typeof value === "string") return true;
  issue(issues, path, "must be a string", "type");
  return false;
}
function expectNonEmptyString(value: unknown, path: string, issues: AgentConfigIssue[]): value is string {
  if (expectString(value, path, issues) && value.trim().length > 0) return true;
  if (typeof value === "string") issue(issues, path, "must not be empty", "format");
  return false;
}
function expectStringArray(value: unknown, path: string, issues: AgentConfigIssue[]): value is string[] {
  if (!Array.isArray(value)) {
    issue(issues, path, "must be an array", "type");
    return false;
  }
  value.forEach((entry, index) => expectNonEmptyString(entry, `${path}.${index}`, issues));
  return true;
}
function expectEnum(value: unknown, values: readonly string[], path: string, issues: AgentConfigIssue[]): void {
  if (typeof value !== "string" || !values.includes(value)) {
    issue(issues, path, `must be one of ${values.map((entry) => JSON.stringify(entry)).join(", ")}`, "enum");
  }
}
function expectPositiveInteger(value: unknown, path: string, issues: AgentConfigIssue[]): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    issue(issues, path, "must be a positive safe integer", "range");
  }
}
function expectBoolean(value: unknown, path: string, issues: AgentConfigIssue[]): void {
  if (typeof value !== "boolean") issue(issues, path, "must be a boolean", "type");
}
function expectIanaTimeZone(value: unknown, path: string, issues: AgentConfigIssue[]): void {
  if (!expectNonEmptyString(value, path, issues)) return;
  try {
    if (value.startsWith("+") || value.startsWith("-")) throw new RangeError("offset time zone");
    new Intl.DateTimeFormat("en", { timeZone: value });
  } catch {
    issue(issues, path, "must be a valid IANA time zone", "timezone");
  }
}
function issue(issues: AgentConfigIssue[], path: string, message: string, code: string): void {
  issues.push({ path, message, code });
}
function snapshotEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const snapshot: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;
  for (const [name, value] of Object.entries(environment)) snapshot[name] = value;
  return Object.freeze(snapshot);
}
async function loadProjectMcpSnapshot(
  path: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<{
  readonly source?: AuthorityFileSnapshot["source"];
  readonly config: ProjectMcpConfig;
}> {
  if (path === undefined) {
    return { config: deepFreeze({ mcpServers: {} }) };
  }
  let snapshot: AuthorityFileSnapshot;
  try {
    snapshot = await readAuthorityFile(path, {
      maxBytes: DEFAULT_AUTHORITY_MAX_BYTES,
      requireSingleLink: true,
    });
  } catch (error) {
    throw new AgentConfigError(`Could not read project MCP config ${path}`, [
      {
        path: "context.mcp.configPath",
        message: errorMessage(error),
        code: error instanceof AuthorityReadError && error.code === "too_large"
          ? "mcp_config_size"
          : "mcp_config",
      },
    ]);
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(decodeAuthorityText(snapshot)) as unknown;
  } catch (error) {
    throw new AgentConfigError(`Project MCP config is not strict JSON: ${path}`, [
      {
        path: "context.mcp.configPath",
        message: errorMessage(error),
        code: error instanceof AuthorityReadError ? error.code : "invalid_json",
      },
    ]);
  }
  return {
    source: snapshot.source,
    config: deepFreeze(parseProjectMcpConfig(candidate, environment, path)),
  };
}
function validateMcpRequestContextServers(
  config: AgentConfig,
  mcp: ProjectMcpConfig,
): readonly AgentConfigIssue[] {
  const issues: AgentConfigIssue[] = [];
  for (const [index, name] of (config.context?.mcp?.requestContextServers ?? []).entries()) {
    const path = `context.mcp.requestContextServers.${index}`;
    const server = mcp.mcpServers[name];
    if (server === undefined) {
      issue(issues, path, `references unconfigured MCP server ${JSON.stringify(name)}`, "reference");
    } else if (server.type !== "stdio") {
      issue(issues, path, "request context is allowed only for direct stdio MCP transports", "transport");
    }
  }
  return issues;
}
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
