import { ensureLoadedAgentConfig } from "./config.js";
import {
  isEnvEligibleSchema,
  isSecretSchema,
  MODULE_SCHEMA_ENV_ELIGIBLE,
  MODULE_SCHEMA_SECRET,
} from "@mono-agent/module-sdk";
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
    session: objectSchema(
      {
        mode: { enum: ["continuous", "per-message"] },
        idleTimeoutMs: { type: "integer", minimum: 1 },
        rollover: { enum: ["none", "daily"] },
        timezone: nonEmptyStringSchema(),
        isolateProactiveRuns: { type: "boolean" },
      },
      ["mode"],
    ),
    context: objectSchema({
      skills: objectSchema(
        {
          roots: { type: "array", items: nonEmptyStringSchema() },
          load: { const: "all" },
          disclosure: { enum: ["full", "index"] },
          maxBytes: { type: "integer", minimum: 1 },
        },
        ["roots"],
      ),
      mcp: objectSchema({ configPath: nonEmptyStringSchema() }, ["configPath"]),
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
        approvals: objectSchema({ default: { enum: ["allow", "ask", "deny"] } }, ["default"]),
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
  const entries: ConfigExplanationEntry[] = [];
  visit(loaded.raw, "", loaded, entries);
  return { configPath: loaded.configPath, entries };
}

function visit(
  value: unknown,
  path: string,
  loaded: LoadedAgentConfig,
  output: ConfigExplanationEntry[],
): void {
  if (isEnvReference(value)) {
    output.push({
      path,
      owner: ownerFor(path, loaded),
      source: "env",
      env: value.$env,
      redacted: true,
    });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => visit(child, path.length === 0 ? String(index) : `${path}.${index}`, loaded, output));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      visit(child, path.length === 0 ? key : `${path}.${key}`, loaded, output);
    }
    return;
  }
  const secret = looksSecret(path);
  output.push({
    path,
    owner: ownerFor(path, loaded),
    source: "config",
    ...(secret ? { redacted: true } : { value }),
  });
}

function ownerFor(path: string, loaded: LoadedAgentConfig): string {
  for (const module of loaded.modules) {
    if (path === `${module.configPath}.$use`) return "@mono-agent/core";
    if (path === module.configPath || path.startsWith(`${module.configPath}.`)) return module.packageName;
  }
  return "@mono-agent/core";
}

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
