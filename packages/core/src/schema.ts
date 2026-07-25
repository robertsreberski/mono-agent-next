// SPDX-License-Identifier: MIT
import { ensureLoadedAgentConfig, environmentFor, MAX_CONTEXT_BYTES } from "./config.js";
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  isEnvEligibleSchema,
  isSecretSchema,
  MODULE_SCHEMA_ENV_ELIGIBLE,
  MODULE_SCHEMA_SECRET,
} from "@mono-agent/module-sdk";
import type { JsonValue } from "@mono-agent/module-sdk";
import { moduleConfigFor, schemaBranchApplicability, schemaConditionApplicability } from "./module-loader.js";
import type {
  AgentConfigExplanation,
  AgentLoadOptions,
  ConfigExplanationEntry,
  LoadedAgentConfig,
  LoadedAgentModule,
} from "./types.js";

export type JsonSchema = Readonly<Record<string, unknown>>;

export async function composeAgentConfigSchema(
  config: string | LoadedAgentConfig,
  options: AgentLoadOptions = {},
): Promise<JsonSchema> {
  const loaded = await ensureLoadedAgentConfig(config, options);
  return composeLoadedAgentConfigSchema(loaded);
}

function composeLoadedAgentConfigSchema(loaded: LoadedAgentConfig): JsonSchema {
  const byPath = new Map(loaded.modules.map((module) => [module.configPath, module]));
  const moduleMap = (prefix: string): JsonSchema => {
    const modules = loaded.modules.filter((module) => module.configPath.startsWith(`${prefix}.`));
    const properties = Object.fromEntries(
      modules.map((module) => [module.instanceId, selectedModuleSchema(module)]),
    );
    return objectSchema(properties, modules.map((module) => module.instanceId));
  };
  const singleton = (path: string): JsonSchema | undefined => {
    const module = byPath.get(path);
    return module === undefined ? undefined : selectedModuleSchema(module);
  };

  const properties: Record<string, unknown> = {
    $schema: { type: "string", minLength: 1 },
    configVersion: { const: 1 },
    agent: objectSchema(
      {
        id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]*$" },
        name: nonEmptyStringSchema(),
        instructions: nonEmptyStringSchema(),
        workspace: nonEmptyStringSchema(),
      },
      ["id", "name", "instructions", "workspace"],
    ),
    runtimes: moduleMap("runtimes"),
    routing: objectSchema(
      {
        primary: routeSchema(loaded),
        fallbacks: { type: "array", items: routeSchema(loaded) },
        effort: nonEmptyStringSchema(),
      },
      ["primary", "fallbacks"],
    ),
    session: {
      ...objectSchema(
        {
          mode: { enum: ["continuous", "per-message"], default: "continuous" },
          idleTimeoutMs: { type: "integer", minimum: 1 },
          rollover: { enum: ["none", "daily"], default: "none" },
          timezone: { ...nonEmptyStringSchema(), default: "UTC" },
          isolateProactiveRuns: { type: "boolean", default: false },
        },
        ["mode"],
      ),
      default: { mode: "continuous", rollover: "none", timezone: "UTC", isolateProactiveRuns: false },
    },
    context: objectSchema({
      skills: objectSchema(
        {
          roots: { type: "array", items: nonEmptyStringSchema() },
          load: { const: "all", default: "all" },
          disclosure: { enum: ["full", "index"], default: "index" },
          maxBytes: { type: "integer", minimum: 1, maximum: MAX_CONTEXT_BYTES, default: MAX_CONTEXT_BYTES },
        },
        ["roots"],
      ),
      mcp: objectSchema({
        configPath: nonEmptyStringSchema(),
        requestContextServers: {
          type: "array", items: nonEmptyStringSchema(), maxItems: 32, uniqueItems: true,
        },
      }, ["configPath"]),
    }),
    channels: moduleMap("channels"),
    triggers: moduleMap("triggers"),
    observability: objectSchema({ exporters: moduleMap("observability.exporters") }),
    policy: objectSchema(
      {
        tools: {
          oneOf: [
            objectSchema(
              { default: { const: "deny" }, allow: { type: "array", items: nonEmptyStringSchema(), uniqueItems: true } },
              ["default"],
            ),
            objectSchema(
              { default: { const: "allow" }, deny: { type: "array", items: nonEmptyStringSchema(), uniqueItems: true } },
              ["default"],
            ),
          ],
        },
        approvals: objectSchema(
          {
            default: { enum: ["allow", "ask", "deny"] },
            timeoutMs: {
              type: "integer", minimum: 1, maximum: 3_600_000, default: DEFAULT_APPROVAL_TIMEOUT_MS,
            },
          },
          ["default"],
        ),
        sandbox:
          singleton("policy.sandbox") === undefined
            ? objectSchema({ mode: { const: "off" } }, ["mode"])
            : {
                oneOf: [
                  objectSchema({ mode: { const: "off" } }, ["mode"]),
                  singleton("policy.sandbox") as JsonSchema,
                ],
              },
      },
      ["tools", "approvals", "sandbox"],
    ),
  };
  const memory = singleton("memory");
  if (memory !== undefined) properties.memory = memory;
  const state = singleton("state");
  if (state !== undefined) properties.state = state;

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `mono-agent:${loaded.raw.agent.id}:config`,
    title: `${loaded.raw.agent.name} mono-agent configuration`,
    ...objectSchema(properties, ["configVersion", "agent", "runtimes", "routing", "policy"]),
  };
}

export async function explainAgentConfig(
  config: string | LoadedAgentConfig,
  options: AgentLoadOptions = {},
): Promise<AgentConfigExplanation> {
  const loaded = await ensureLoadedAgentConfig(config, options);
  const schema = composeLoadedAgentConfigSchema(loaded);
  const entries: ConfigExplanationEntry[] = [];
  const environmentValues = referencedEnvironmentValues(loaded);
  visitEffectiveValue(loaded.raw, loaded.raw, "", [schema, "#"], {
    loaded, output: entries, environmentValues,
  }, true);
  entries.sort((left, right) =>
    compareText(left.path, right.path)
    || compareText(left.owner, right.owner)
    || compareText(left.schemaPointer, right.schemaPointer));
  return { configPath: loaded.configPath, entries };
}

const MISSING = Symbol("missing");
const CORE_OWNER = "@mono-agent/core";

type SchemaLocation = readonly [schema: JsonSchema, pointer: string];

interface ExplainContext {
  readonly loaded: LoadedAgentConfig;
  readonly output: ConfigExplanationEntry[];
  readonly environmentValues: readonly EnvironmentBinding[];
  readonly module?: LoadedAgentModule;
  readonly moduleValue?: unknown;
  readonly moduleEnvironmentNames?: readonly string[];
}

interface EnvironmentBinding {
  readonly name: string;
  readonly value: string;
}

function visitEffectiveValue(
  effectiveInput: unknown | typeof MISSING,
  authored: unknown | typeof MISSING,
  path: string, schema: SchemaLocation, context: ExplainContext, applyDefaults: boolean,
  modulePath: readonly (string | number)[] = [],
  trustedDefault = false,
): void {
  let effective = effectiveInput;
  if (effective === MISSING && applyDefaults) effective = schemaDefault(schema);
  if (effective === MISSING || effective === undefined) return;
  const isTrustedDefault = authored === MISSING
    && (trustedDefault || schemaDefaultMatches(schema, effective));

  const selectedModule = context.module === undefined
    ? context.loaded.modules.find((module) => module.configPath === path)
    : undefined;
  if (selectedModule !== undefined && isRecord(effective) && typeof effective.$use === "string") {
    visitEffectiveValue(effective.$use, effective.$use, appendPath(path, "$use"),
      schemaChild(schema, "$use", effective) ?? schema, context, false);
    const inline = Object.entries(effective).filter(([key]) => key !== "$use");
    const moduleValue = moduleConfigFor(selectedModule);
    visitEffectiveValue(moduleValue,
      inline.length === 0 ? MISSING : Object.fromEntries(inline), path, schema, {
        ...context, module: selectedModule,
        moduleValue,
        moduleEnvironmentNames: collectEnvironmentNames(effective),
      }, false);
    return;
  }

  if (isEnvReference(authored)) {
    emitResolvedLeaf(context, path, schema, modulePath, effective, MISSING, false, authored.$env);
    return;
  }

  if (Array.isArray(effective)) {
    if (effective.length === 0) {
      emitResolvedLeaf(context, path, schema, modulePath, [], authored, isTrustedDefault);
      return;
    }
    for (const [index, child] of effective.entries()) {
      visitEffectiveValue(child,
        Array.isArray(authored) && index < authored.length ? authored[index] : MISSING,
        appendPath(path, index), schemaChild(schema, index, effective) ?? schema, context,
        applyDefaults, [...modulePath, index], isTrustedDefault);
    }
    return;
  }

  if (isRecord(effective)) {
    const keys = new Set(
      Object.keys(effective).filter((key) =>
        effective[key] !== undefined && !(context.module !== undefined && key === "$use")),
    );
    if (applyDefaults) {
      for (const key of schemaPropertyKeys(schema, effective)) {
        const childSchema = schemaChild(schema, key, effective);
        if (
          childSchema !== undefined
          && !Object.hasOwn(effective, key)
          && schemaDefault(childSchema) !== MISSING
        ) {
          keys.add(key);
        }
      }
    }
    if (keys.size === 0) {
      emitResolvedLeaf(context, path, schema, modulePath, {}, authored, isTrustedDefault);
      return;
    }
    for (const key of [...keys].sort(compareText)) {
      visitEffectiveValue(
        Object.hasOwn(effective, key) ? effective[key] : MISSING,
        isRecord(authored) && Object.hasOwn(authored, key) ? authored[key] : MISSING,
        appendPath(path, key), schemaChild(schema, key, effective) ?? schema, context,
        applyDefaults, [...modulePath, key], isTrustedDefault);
    }
    return;
  }

  emitResolvedLeaf(context, path, schema, modulePath, effective, authored, isTrustedDefault);
}

function emitResolvedLeaf(
  context: ExplainContext,
  path: string,
  schema: SchemaLocation,
  modulePath: readonly (string | number)[],
  effective: unknown,
  authored: unknown | typeof MISSING,
  trustedDefault: boolean,
  authoredEnv?: string,
): void {
  const echo = authored === MISSING && typeof effective === "string"
    ? context.environmentValues.find(({ value }) => value.length > 0 && effective.includes(value))
    : undefined;
  const tainted = authoredEnv !== undefined
    || echo !== undefined
    || (context.moduleEnvironmentNames !== undefined
      && context.moduleEnvironmentNames.length > 0
      && authored === MISSING
      && !trustedDefault);
  const source: ConfigExplanationEntry["source"] = tainted
    ? "environment"
    : authored === MISSING ? "default" : "config";
  const env = authoredEnv ?? echo?.name;
  const redacted = source === "environment"
    || looksSecret(path)
    || (context.module !== undefined
      && modulePathIsSecret(context.module, context.moduleValue, modulePath));
  const value = redacted ? undefined : detachedJsonLeaf(effective);
  context.output.push({
    path,
    owner: context.module?.packageName ?? CORE_OWNER,
    schemaPointer: schema[1],
    source,
    ...(value === undefined ? {} : { value }),
    ...(env === undefined ? {} : { env }),
    redacted,
    remediation: remediationFor(path, source, env),
  });
}

function referencedEnvironmentValues(loaded: LoadedAgentConfig): readonly EnvironmentBinding[] {
  const environment = environmentFor(loaded);
  return collectEnvironmentNames(loaded.raw).flatMap((name) => {
    const value = environment[name];
    return value === undefined ? [] : [{ name, value }];
  });
}

function collectEnvironmentNames(value: unknown): readonly string[] {
  const names = new Set<string>();
  const visit = (child: unknown): void => {
    if (isEnvReference(child)) names.add(child.$env);
    else if (Array.isArray(child)) child.forEach(visit);
    else if (isRecord(child)) Object.values(child).forEach(visit);
  };
  visit(value);
  return [...names].sort(compareText);
}

function modulePathIsSecret(
  module: LoadedAgentModule,
  moduleValue: unknown,
  path: readonly (string | number)[],
): boolean {
  let locations: readonly SchemaLocation[] = [[module.definition.schema.jsonSchema, "#"]];
  let effective = moduleValue;
  if (locations.some((location) => schemaLocationIsSecret(location, effective))) return true;
  for (const segment of path) {
    locations = locations.flatMap((location) => schemaChildren(location, segment, effective, true));
    if (locations.length === 0) return false;
    effective = Array.isArray(effective) && typeof segment === "number"
      ? effective[segment]
      : isRecord(effective) ? effective[String(segment)] : MISSING;
    if (locations.some((location) => schemaLocationIsSecret(location, effective))) return true;
  }
  return false;
}

function schemaLocationIsSecret(location: SchemaLocation, effective: unknown): boolean {
  return isSecretSchema(location[0])
    || schemaBranches(location, effective, true).some((branch) =>
      schemaLocationIsSecret(branch, effective));
}

function schemaChild(
  location: SchemaLocation,
  segment: string | number,
  effective: unknown,
): SchemaLocation | undefined {
  return schemaChildren(location, segment, effective)[0];
}

function schemaChildren(
  location: SchemaLocation,
  segment: string | number,
  effective: unknown,
  conservative = false,
): readonly SchemaLocation[] {
  const [schema, pointer] = location;
  const key = String(segment);
  const output: SchemaLocation[] = [];
  if (isRecord(schema.properties) && isRecord(schema.properties[key]))
    output.push([schema.properties[key], `${pointer}/properties/${escapePointer(key)}`]);
  if (typeof segment === "number" && isRecord(schema.items))
    output.push([schema.items, `${pointer}/items`]);
  for (const branch of schemaBranches(location, effective, conservative)) {
    output.push(...schemaChildren(branch, segment, effective, conservative));
  }
  if (output.length === 0 && isRecord(schema.additionalProperties))
    output.push([schema.additionalProperties, `${pointer}/additionalProperties`]);
  return [...new Map(output.map((child) => [child[1], child])).values()];
}

function schemaPropertyKeys(location: SchemaLocation, effective: unknown): readonly string[] {
  const keys = new Set<string>();
  if (isRecord(location[0].properties))
    for (const key of Object.keys(location[0].properties)) keys.add(key);
  for (const branch of schemaBranches(location, effective))
    for (const key of schemaPropertyKeys(branch, effective)) keys.add(key);
  return [...keys].sort(compareText);
}

function schemaDefault(
  location: SchemaLocation,
  effective: unknown | typeof MISSING = MISSING,
): unknown | typeof MISSING {
  if (Object.hasOwn(location[0], "default")) return structuredClone(location[0].default);
  for (const branch of schemaBranches(location, effective)) {
    const value = schemaDefault(branch, effective);
    if (value !== MISSING) return value;
  }
  return MISSING;
}

function schemaDefaultMatches(location: SchemaLocation, value: unknown): boolean {
  const expected = schemaDefault(location, value);
  return expected !== MISSING && JSON.stringify(expected) === JSON.stringify(value);
}

function schemaBranches(
  [schema, pointer]: SchemaLocation,
  effective: unknown | typeof MISSING = MISSING,
  conservative = false,
): readonly SchemaLocation[] {
  const output: SchemaLocation[] = [];
  for (const keyword of ["allOf", "oneOf", "anyOf"] as const) {
    const values = schema[keyword];
    if (!Array.isArray(values)) continue;
    const branches: SchemaLocation[] = [];
    values.forEach((value, index) => isRecord(value)
      && branches.push([value, `${pointer}/${keyword}/${String(index)}`]));
    if (keyword === "allOf" || effective === MISSING) { output.push(...branches); continue; }
    const statuses = branches.map(([branch]) =>
      schemaBranchApplicability(branch, effective, true));
    const certain = branches.filter((_, index) => statuses[index] === "match");
    const possible = branches.filter((_, index) => statuses[index] !== "no");
    if (keyword === "oneOf")
      output.push(...(certain.length === 1 && possible.length === 1 ? certain : conservative ? possible : []));
    else output.push(...(conservative ? possible : certain));
  }
  if (schema.if !== undefined && effective !== MISSING) {
    const status = schemaConditionApplicability(schema.if, effective, true);
    const selected = status === "match" ? [["then", schema.then]] as const
      : status === "no" ? [["else", schema.else]] as const
        : conservative ? [["then", schema.then], ["else", schema.else]] as const : [];
    for (const [keyword, branch] of selected)
      if (isRecord(branch)) output.push([branch, `${pointer}/${keyword}`]);
  }
  return output;
}

function detachedJsonLeaf(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))) return value;
  if (Array.isArray(value) && value.length === 0) return [];
  if (isRecord(value) && Object.keys(value).length === 0) return {};
  return undefined;
}

function remediationFor(path: string, source: ConfigExplanationEntry["source"], env?: string): string {
  const label = (source === "environment" ? env ?? "the referenced variable" : path)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .slice(0, 120);
  const text = source === "environment"
    ? `Set ${label} in the process environment, then validate again.`
    : source === "default"
      ? `Set ${label} in the config to override this default, then validate again.`
      : `Edit ${label} in the config, then validate again.`;
  return text.slice(0, 240);
}

function appendPath(path: string, segment: string | number): string { return path.length === 0 ? String(segment) : `${path}.${String(segment)}`; }
function escapePointer(value: string): string { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function looksSecret(path: string): boolean {
  const key = path.split(".").at(-1)?.toLowerCase() ?? "";
  return /(?:token|password|secret|apikey|api_key|privatekey|credential)/u.test(key);
}

function selectedModuleSchema(module: LoadedAgentModule): JsonSchema {
  const leaf = materializeEnvironmentSchema(
    structuredClone(module.definition.schema.jsonSchema) as Record<string, unknown>,
  );
  const selected = addModuleSelectionToRootSchema(leaf, module.packageName);
  if (isObjectShapedSchema(selected)) return selected;
  return {
    type: "object",
    properties: { $use: { const: module.packageName } },
    required: ["$use"],
    allOf: [selected],
    unevaluatedProperties: false,
  };
}

function addModuleSelectionToRootSchema(
  schema: JsonSchema,
  packageName: string,
  hoistStrictness = false,
): JsonSchema {
  const selected: Record<string, unknown> = { ...schema };
  const hasComposition = ["allOf", "anyOf", "oneOf"].some((keyword) =>
    Array.isArray(selected[keyword]) && selected[keyword].length > 0);

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    if (!Array.isArray(selected[keyword])) continue;
    const hoistBranchStrictness = hoistStrictness || keyword === "allOf";
    selected[keyword] = selected[keyword].map((entry) =>
      isRecord(entry)
        ? addModuleSelectionToRootSchema(entry, packageName, hoistBranchStrictness)
        : entry);
  }

  if (!isObjectShapedSchema(selected)) return selected;
  const properties = isRecord(selected.properties) ? selected.properties : {};
  const required = Array.isArray(selected.required)
    ? selected.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  selected.type = "object";
  selected.properties = { $use: { const: packageName }, ...properties };
  selected.required = [...new Set(["$use", ...required])];

  if (hoistStrictness) {
    if (selected.additionalProperties === false) delete selected.additionalProperties;
    if (selected.unevaluatedProperties === false) delete selected.unevaluatedProperties;
  } else if (hasComposition) {
    if (selected.additionalProperties === false) delete selected.additionalProperties;
    if (selected.additionalProperties === undefined && selected.unevaluatedProperties === undefined) {
      selected.unevaluatedProperties = false;
    }
  } else if (selected.additionalProperties === undefined) {
    selected.additionalProperties = false;
  }
  return selected;
}

function isObjectShapedSchema(schema: JsonSchema): boolean {
  return schema.type === "object"
    || isRecord(schema.properties)
    || Array.isArray(schema.required)
    || Object.hasOwn(schema, "additionalProperties")
    || Object.hasOwn(schema, "unevaluatedProperties");
}

function materializeEnvironmentSchema(schema: JsonSchema): JsonSchema {
  const clean: Record<string, unknown> = { ...schema };
  delete clean[MODULE_SCHEMA_ENV_ELIGIBLE];
  delete clean[MODULE_SCHEMA_SECRET];
  if (isRecord(clean.properties)) {
    clean.properties = Object.fromEntries(
      Object.entries(clean.properties).map(([key, value]) => [
        key,
        isRecord(value) ? materializeEnvironmentSchema(value) : value,
      ]),
    );
  }
  if (isRecord(clean.items)) clean.items = materializeEnvironmentSchema(clean.items);
  if (isRecord(clean.additionalProperties)) {
    clean.additionalProperties = materializeEnvironmentSchema(clean.additionalProperties);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(clean[keyword])) {
      clean[keyword] = clean[keyword].map((entry) =>
        isRecord(entry) ? materializeEnvironmentSchema(entry) : entry);
    }
  }
  for (const keyword of ["if", "then", "else"] as const)
    if (isRecord(clean[keyword])) clean[keyword] = materializeEnvironmentSchema(clean[keyword]);
  if (!isEnvEligibleSchema(schema)) return clean;
  const environmentReference = objectSchema(
    { $env: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" } },
    ["$env"],
  );
  return isSecretSchema(schema) ? environmentReference : { oneOf: [clean, environmentReference] };
}

function routeSchema(loaded: LoadedAgentConfig): JsonSchema {
  const runtimeIds = Object.keys(loaded.raw.runtimes).sort();
  return objectSchema(
    {
      runtime: runtimeIds.length === 0 ? { type: "string", minLength: 1 } : { enum: runtimeIds },
      model: nonEmptyStringSchema(),
    },
    ["runtime", "model"],
  );
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): JsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  };
}

function nonEmptyStringSchema(): JsonSchema {
  return { type: "string", minLength: 1 };
}

function isEnvReference(value: unknown): value is { readonly $env: string } {
  return isRecord(value) && Object.keys(value).length === 1 && typeof value.$env === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
