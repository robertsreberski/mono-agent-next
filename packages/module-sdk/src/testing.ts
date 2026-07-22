import {
  MODULE_API_VERSION,
  OPEN_MODULE_KINDS,
  type Channel,
  type ChannelModuleDefinition,
  type Memory,
  type MemoryModuleDefinition,
  type ModuleInstance,
  type ModuleKind,
  type ModuleSchema,
  type OpenModuleDefinition,
  type Runtime,
  type RuntimeModuleDefinition,
} from "./index.js";

const RESERVED_DIRECTIVES = new Set(["$schema", "$use", "$env"]);

export interface ModuleComplianceOptions {
  readonly expectedKind?: ModuleKind;
  readonly expectedPackageName?: string;
  readonly expectedPackageVersion?: string;
}

export class ModuleComplianceError extends Error {
  readonly code = "MODULE_COMPLIANCE_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "ModuleComplianceError";
  }
}

export function assertModuleDefinitionCompliance(
  value: unknown,
  options: ModuleComplianceOptions = {},
): asserts value is OpenModuleDefinition {
  const definition = requireRecord(value, "module definition");
  const manifest = requireRecord(definition.manifest, "module manifest");

  requireNonEmptyString(manifest.packageName, "manifest.packageName");
  requireNonEmptyString(manifest.packageVersion, "manifest.packageVersion");
  requireNonEmptyString(manifest.responsibility, "manifest.responsibility");

  if (manifest.apiVersion !== MODULE_API_VERSION) {
    fail(`manifest.apiVersion must be ${MODULE_API_VERSION}`);
  }
  if (!isModuleKind(manifest.kind)) {
    fail(`manifest.kind must be one of ${OPEN_MODULE_KINDS.join(", ")}`);
  }
  if (options.expectedKind !== undefined && manifest.kind !== options.expectedKind) {
    fail(`manifest.kind must be ${options.expectedKind}, received ${String(manifest.kind)}`);
  }
  if (
    options.expectedPackageName !== undefined
    && manifest.packageName !== options.expectedPackageName
  ) {
    fail(
      `manifest.packageName must be ${options.expectedPackageName}, received ${String(manifest.packageName)}`,
    );
  }
  if (
    options.expectedPackageVersion !== undefined
    && manifest.packageVersion !== options.expectedPackageVersion
  ) {
    fail(
      `manifest.packageVersion must be ${options.expectedPackageVersion}, received ${String(manifest.packageVersion)}`,
    );
  }

  assertCapabilities(manifest.capabilities);
  assertSchemaCompliance(definition.schema);

  if (typeof definition.create !== "function") {
    fail("module definition create must be a function");
  }
}

export function assertRuntimeModuleCompliance(
  value: unknown,
  options: Omit<ModuleComplianceOptions, "expectedKind"> = {},
): asserts value is RuntimeModuleDefinition {
  assertModuleDefinitionCompliance(value, { ...options, expectedKind: "runtime" });
}

export function assertChannelModuleCompliance(
  value: unknown,
  options: Omit<ModuleComplianceOptions, "expectedKind"> = {},
): asserts value is ChannelModuleDefinition {
  assertModuleDefinitionCompliance(value, { ...options, expectedKind: "channel" });
}

export function assertMemoryModuleCompliance(
  value: unknown,
  options: Omit<ModuleComplianceOptions, "expectedKind"> = {},
): asserts value is MemoryModuleDefinition {
  assertModuleDefinitionCompliance(value, { ...options, expectedKind: "memory" });
}

export function assertRuntimeInstanceCompliance(value: unknown): asserts value is Runtime {
  const instance = assertModuleInstance(value, "runtime instance");
  assertBooleanCapabilities(instance.capabilities, [
    "tools",
    "mcp",
    "attachments",
    "approvals",
    "structuredOutput",
    "sandbox",
    "sessions",
  ], "runtime capabilities");
  if (typeof instance.runTurn !== "function") fail("runtime instance runTurn must be a function");
  assertOptionalFunction(instance.validateModel, "runtime instance validateModel");
}

export function assertChannelInstanceCompliance(value: unknown): asserts value is Channel {
  const instance = assertModuleInstance(value, "channel instance");
  assertBooleanCapabilities(instance.capabilities, [
    "attachments",
    "liveInput",
    "askUser",
    "proactive",
    "runtimeControl",
    "verbatim",
  ], "channel capabilities");
  assertOptionalFunction(instance.deliver, "channel instance deliver");
}

export function assertMemoryInstanceCompliance(value: unknown): asserts value is Memory {
  const instance = assertModuleInstance(value, "memory instance");
  assertBooleanCapabilities(instance.capabilities, ["capture", "forget"], "memory capabilities");
  if (typeof instance.recall !== "function") fail("memory instance recall must be a function");
  assertOptionalFunction(instance.capture, "memory instance capture");
  assertOptionalFunction(instance.forget, "memory instance forget");
}

export function assertMonoAgentModuleExport(
  namespace: unknown,
  options: ModuleComplianceOptions = {},
): OpenModuleDefinition {
  const imported = requireRecord(namespace, "imported module namespace");
  const definition = imported.monoAgentModule;
  assertModuleDefinitionCompliance(definition, options);
  return definition;
}

export function assertSchemaCompliance(value: unknown): asserts value is ModuleSchema<unknown> {
  const schema = requireRecord(value, "module schema");
  const jsonSchema = requireRecord(schema.jsonSchema, "schema.jsonSchema");
  if (typeof schema.parse !== "function") fail("schema.parse must be a function");
  assertNoReservedDirectiveProperties(jsonSchema);
}

function assertModuleInstance(value: unknown, label: string): Record<string, unknown> {
  const instance = requireRecord(value, label);
  for (const method of ["start", "drain", "stop", "health", "diagnostics"] as const) {
    assertOptionalFunction(instance[method], `${label} ${method}`);
  }

  if (instance.commands !== undefined) {
    if (!Array.isArray(instance.commands)) fail(`${label} commands must be an array`);
    for (const [index, commandValue] of instance.commands.entries()) {
      const command = requireRecord(commandValue, `${label} commands[${index}]`);
      requireNonEmptyString(command.name, `${label} commands[${index}].name`);
      requireNonEmptyString(command.description, `${label} commands[${index}].description`);
      if (command.kind !== "authentication" && command.kind !== "maintenance") {
        fail(`${label} commands[${index}].kind is invalid`);
      }
      if (typeof command.run !== "function") fail(`${label} commands[${index}].run must be a function`);
    }
  }

  return instance;
}

function assertCapabilities(value: unknown): void {
  if (!Array.isArray(value)) fail("manifest.capabilities must be an array");
  const seen = new Set<string>();
  for (const [index, capability] of value.entries()) {
    requireNonEmptyString(capability, `manifest.capabilities[${index}]`);
    if (seen.has(capability)) fail(`manifest.capabilities contains duplicate ${capability}`);
    seen.add(capability);
  }
}

function assertBooleanCapabilities(value: unknown, names: readonly string[], label: string): void {
  const capabilities = requireRecord(value, label);
  for (const name of names) {
    if (typeof capabilities[name] !== "boolean") fail(`${label}.${name} must be a boolean`);
  }
}

function assertNoReservedDirectiveProperties(jsonSchema: Record<string, unknown>): void {
  const visited = new Set<object>();
  const pending: unknown[] = [jsonSchema];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }

    const record = current as Record<string, unknown>;
    if (record.properties !== undefined) {
      const properties = requireRecord(record.properties, "JSON Schema properties");
      for (const name of Object.keys(properties)) {
        if (RESERVED_DIRECTIVES.has(name)) {
          fail(`module schema may not define reserved directive property ${name}`);
        }
      }
    }
    pending.push(...Object.values(record));
  }
}

function assertOptionalFunction(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "function") fail(`${label} must be a function when present`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be a non-empty string`);
}

function isModuleKind(value: unknown): value is ModuleKind {
  return typeof value === "string" && (OPEN_MODULE_KINDS as readonly string[]).includes(value);
}

function fail(message: string): never {
  throw new ModuleComplianceError(message);
}
