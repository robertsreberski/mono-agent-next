import {
  MODULE_API_VERSION,
  MODULE_SCHEMA_SLOT_REFERENCE,
  OPEN_MODULE_KINDS,
  readCrossSlotReference,
  type Channel,
  type ChannelModuleDefinition,
  type Memory,
  type MemoryModuleDefinition,
  type ModuleKind,
  type ModuleSchema,
  type OpenModuleDefinition,
  type Runtime,
  type RuntimeModuleDefinition,
} from "./index.js";
const RESERVED_DIRECTIVES = new Set(["$schema", "$use", "$env"]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const INSTANCE_METHODS = ["start", "drain", "stop", "health", "diagnostics"] as const;
const RUNTIME_CAPABILITIES = [
  "tools", "mcp", "attachments", "approvals", "structuredOutput", "sandbox", "sessions",
] as const;
const CHANNEL_CAPABILITIES = [
  "attachments", "liveInput", "askUser", "proactive", "runtimeControl", "verbatim", "cancellation",
] as const;
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
  if (manifest.apiVersion !== MODULE_API_VERSION) fail(`manifest.apiVersion must be ${MODULE_API_VERSION}`);
  if (!isModuleKind(manifest.kind)) fail(`manifest.kind must be one of ${OPEN_MODULE_KINDS.join(", ")}`);
  assertExpectedManifestProperty(manifest, "kind", options.expectedKind);
  assertExpectedManifestProperty(manifest, "packageName", options.expectedPackageName);
  assertExpectedManifestProperty(manifest, "packageVersion", options.expectedPackageVersion);
  assertCapabilities(manifest.capabilities);
  assertSchemaCompliance(definition.schema);
  if (typeof definition.create !== "function") fail("module definition create must be a function");
}
export function assertRuntimeModuleCompliance(
  value: unknown,
  options: Omit<ModuleComplianceOptions, "expectedKind"> = {},
): asserts value is RuntimeModuleDefinition {
  assertModuleDefinitionCompliance(value, { ...options, expectedKind: "runtime" });
  const definition = value as unknown as Record<string, unknown>;
  assertOptionalFunction(definition.validateModel, "runtime module definition validateModel");
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
  const instance = assertModuleInstance(value, "runtime");
  assertInstanceCapabilities(
    instance,
    "runtime",
    RUNTIME_CAPABILITIES,
    ["artifactResults", "liveInput", "maxTurns", "maxOutputTokens"],
  );
  if (typeof instance.runTurn !== "function") fail("runtime instance runTurn must be a function");
  assertOptionalFunction(instance.validateModel, "runtime instance validateModel");
  assertOptionalFunction(instance.preflightModel, "runtime instance preflightModel");
}
export function assertChannelInstanceCompliance(value: unknown): asserts value is Channel {
  const instance = assertModuleInstance(value, "channel");
  const capabilities = assertInstanceCapabilities(instance, "channel", CHANNEL_CAPABILITIES, ["approvals"]);
  assertOptionalFunction(instance.deliver, "channel instance deliver");
  if (capabilities.proactive === true && typeof instance.deliver !== "function")
    fail("proactive channel instance deliver must be a function");
}
export function assertMemoryInstanceCompliance(value: unknown): asserts value is Memory {
  const instance = assertModuleInstance(value, "memory");
  const capabilities = assertInstanceCapabilities(instance, "memory", ["capture", "forget"]);
  if (typeof instance.recall !== "function") fail("memory instance recall must be a function");
  assertOptionalFunction(instance.capture, "memory instance capture");
  assertOptionalFunction(instance.forget, "memory instance forget");
  if (capabilities.capture === true && typeof instance.capture !== "function")
    fail("capture-capable memory instance capture must be a function");
  if (capabilities.forget === true && typeof instance.forget !== "function")
    fail("forget-capable memory instance forget must be a function");
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
  assertSchemaGraph(jsonSchema);
}
function assertExpectedManifestProperty(
  manifest: Record<string, unknown>,
  property: "kind" | "packageName" | "packageVersion",
  expected: string | undefined,
): void {
  if (expected !== undefined && manifest[property] !== expected) {
    fail(`manifest.${property} must be ${expected}, received ${String(manifest[property])}`);
  }
}
function assertModuleInstance(value: unknown, kind: ModuleKind): Record<string, unknown> {
  const label = `${kind} instance`;
  const instance = requireRecord(value, label);
  for (const method of INSTANCE_METHODS) {
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
function assertBooleanCapabilities(
  value: unknown,
  requiredNames: readonly string[],
  optionalNames: readonly string[],
  label: string,
): Record<string, unknown> {
  const capabilities = requirePlainRecord(value, label);
  const allowedNames = new Set([...requiredNames, ...optionalNames]);
  for (const key of Reflect.ownKeys(capabilities)) {
    if (typeof key !== "string") fail(`${label} contains an unknown symbol key`);
    if (UNSAFE_KEYS.has(key)) fail(`${label} contains unsafe key ${JSON.stringify(key)}`);
    if (!allowedNames.has(key)) fail(`${label} contains unknown key ${JSON.stringify(key)}`);
  }
  const detached: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [names, required] of [[requiredNames, true], [optionalNames, false]] as const) {
    for (const name of names) {
      const capability = readOwnDataProperty(capabilities, name, label, required);
      if (required ? typeof capability !== "boolean" : capability !== undefined && typeof capability !== "boolean") {
        fail(`${label}.${name} must be a boolean${required ? "" : " when present"}`);
      }
      if (capability !== undefined) detached[name] = capability;
    }
  }
  return detached;
}
function assertInstanceCapabilities(
  instance: Record<string, unknown>,
  kind: ModuleKind,
  requiredNames: readonly string[],
  optionalNames: readonly string[] = [],
): Record<string, unknown> {
  return assertBooleanCapabilities(
    readOwnDataProperty(instance, "capabilities", `${kind} instance`, true),
    requiredNames,
    optionalNames,
    `${kind} capabilities`,
  );
}
function assertSchemaGraph(jsonSchema: Record<string, unknown>): void {
  const visited = new Set<object>();
  const pending: unknown[] = [jsonSchema];
  const records: Record<string, unknown>[] = [];
  const snapshots = new WeakMap<object, Record<string, unknown>>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    const record = snapshotSchemaNode(current, snapshots);
    if (Array.isArray(current)) {
      pending.push(...Object.values(record));
      continue;
    }
    records.push(record);
    if (record.properties !== undefined) {
      const properties = snapshotSchemaNode(
        requireRecord(record.properties, "JSON Schema properties"),
        snapshots,
      );
      for (const name of Object.keys(properties)) {
        if (RESERVED_DIRECTIVES.has(name))
          fail(`module schema may not define reserved directive property ${name}`);
      }
    }
    pending.push(...Object.values(record));
  }
  for (const schema of records) {
    if (MODULE_SCHEMA_SLOT_REFERENCE in schema
      && (schema.type !== "string" || !hasValidSlotReference(schema, snapshots))) {
      fail("module schema has an invalid cross-slot reference annotation");
    }
  }
}
function snapshotSchemaNode(
  value: object,
  snapshots: WeakMap<object, Record<string, unknown>>,
): Record<string, unknown> {
  const existing = snapshots.get(value);
  if (existing !== undefined) return existing;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    fail("module schema graph must contain only plain objects and arrays");
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  snapshots.set(value, snapshot);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) fail(`module schema graph.${key} must be a data property`);
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: descriptor.enumerable === true,
    });
  }
  return snapshot;
}
function hasValidSlotReference(
  schema: Record<string, unknown>,
  snapshots: WeakMap<object, Record<string, unknown>>,
): boolean {
  const reference = schema[MODULE_SCHEMA_SLOT_REFERENCE];
  if (reference === null || typeof reference !== "object" || Array.isArray(reference)) return false;
  const safeSchema: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  safeSchema[MODULE_SCHEMA_SLOT_REFERENCE] = snapshotSchemaNode(reference, snapshots);
  return readCrossSlotReference(safeSchema) !== undefined;
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
function requirePlainRecord(value: unknown, label: string): Record<string, unknown> {
  const record = requireRecord(value, label);
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain object`);
  }
  return record;
}
function readOwnDataProperty(
  value: Record<string, unknown>,
  key: string,
  label: string,
  required = false,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    if (required) fail(`${label}.${key} is required`);
    return undefined;
  }
  if (!("value" in descriptor)) fail(`${label}.${key} must be a data property`);
  return descriptor.value;
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
