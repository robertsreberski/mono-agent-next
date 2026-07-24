import { isProxy } from "node:util/types";

import {
  MODULE_API_VERSION,
  MODULE_TOOL_LIMITS,
  MODULE_SCHEMA_SLOT_REFERENCE,
  OPEN_MODULE_KINDS,
  readCrossSlotReference,
  type Awaitable, type Channel, type ChannelOutboundMessage, type ChannelModuleDefinition,
  type Memory, type MemoryModuleDefinition, type ModuleKind, type ModuleSchema,
  type ModuleToolBinding,
  type OpenModuleDefinition, type Runtime, type RuntimeModuleDefinition,
} from "./index.js";
const RESERVED_DIRECTIVES = new Set(["$schema", "$use", "$env"]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const INSTANCE_METHODS = ["start", "drain", "stop", "health", "diagnostics"] as const;
const RUNTIME_CAPABILITIES = ["tools", "mcp", "attachments", "approvals", "structuredOutput", "sandbox", "sessions"] as const;
const CHANNEL_CAPABILITIES = ["attachments", "liveInput", "askUser", "proactive", "runtimeControl", "verbatim", "cancellation"] as const;
export interface ModuleComplianceOptions {
  readonly expectedKind?: ModuleKind; readonly expectedPackageName?: string;
  readonly expectedPackageVersion?: string;
}
export class ModuleComplianceError extends Error {
  readonly code = "MODULE_COMPLIANCE_FAILED";
  constructor(message: string) { super(message); this.name = "ModuleComplianceError"; }
}
export interface ChannelBehaviorComplianceOptions {
  create(signal: AbortSignal): Awaitable<Channel>; exercise(instance: Channel, signal: AbortSignal): Awaitable<void>;
  readonly delivery?: { readonly delivered: ChannelOutboundMessage; readonly conflicting: ChannelOutboundMessage;
    readonly unknown: ChannelOutboundMessage };
  readonly secrets?: readonly string[]; readonly timeoutMs?: number;
}
/** Reusable channel lane; adapter suites supply normalization/auth probes in `exercise`. */
export async function assertChannelBehaviorCompliance(options: ChannelBehaviorComplianceOptions): Promise<void> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 5_000);
  const instance = await options.create(signal);
  assertChannelInstanceCompliance(instance);
  if ((options.delivery !== undefined) !== instance.capabilities.proactive)
    fail("channel behavior delivery scenarios must exactly match proactive capability");
  await instance.start?.({ signal });
  try {
    await options.exercise(instance, signal);
    const results: unknown[] = [];
    if (options.delivery !== undefined) {
      const { delivered, conflicting, unknown } = options.delivery;
      if (delivered.idempotencyKey !== conflicting.idempotencyKey
        || delivered.idempotencyKey === unknown.idempotencyKey)
        fail("channel behavior delivery keys must model conflict and unknown independently");
      const scenarios = [
        [delivered, "delivered"], [delivered, "duplicate"], [conflicting, "failed"],
        [unknown, "unknown"], [unknown, "unknown"],
      ] as const;
      for (const [message] of scenarios) results.push(await instance.deliver!(message, signal));
      for (const [index, [message, status]] of scenarios.entries()) {
        const receipt = requireRecord(results[index], `channel delivery result ${String(index)}`);
        if (receipt.status !== status || receipt.idempotencyKey !== message.idempotencyKey)
          fail(`channel delivery result ${String(index)} violates idempotency semantics`);
      }
    }
    if (instance.health === undefined) fail("channel behavior requires bounded health");
    results.push(await instance.health({ signal }), ...(await instance.diagnostics?.({ signal, verbose: true }) ?? []));
    const report = JSON.stringify(results);
    if (new TextEncoder().encode(report).byteLength > 64 * 1024) fail("channel behavior reports exceed 64 KiB");
    for (const secret of options.secrets ?? []) if (secret.length > 0 && report.includes(secret))
      fail("channel behavior reports contain a configured secret");
    await instance.drain?.({ signal });
  } finally {
    await instance.stop?.({ signal, reason: "shutdown" }); await instance.stop?.({ signal, reason: "shutdown" });
  }
}
export function assertModuleDefinitionCompliance(value: unknown, options: ModuleComplianceOptions = {}):
asserts value is OpenModuleDefinition {
  const definition = requireRecord(value, "module definition");
  const manifest = requireRecord(definition.manifest, "module manifest");
  requireNonEmptyString(manifest.packageName, "manifest.packageName");
  requireNonEmptyString(manifest.packageVersion, "manifest.packageVersion");
  requireNonEmptyString(manifest.responsibility, "manifest.responsibility");
  if (manifest.apiVersion !== MODULE_API_VERSION) fail(`manifest.apiVersion must be ${MODULE_API_VERSION}`);
  if (typeof manifest.kind !== "string" || !(OPEN_MODULE_KINDS as readonly string[]).includes(manifest.kind))
    fail(`manifest.kind must be one of ${OPEN_MODULE_KINDS.join(", ")}`);
  for (const [property, expected] of [
    ["kind", options.expectedKind], ["packageName", options.expectedPackageName],
    ["packageVersion", options.expectedPackageVersion],
  ] as const) if (expected !== undefined && manifest[property] !== expected)
    fail(`manifest.${property} must be ${expected}, received ${String(manifest[property])}`);
  assertCapabilities(manifest.capabilities);
  assertSchemaCompliance(definition.schema);
  if (typeof definition.create !== "function") fail("module definition create must be a function");
}
export function assertRuntimeModuleCompliance(
  value: unknown, options: Omit<ModuleComplianceOptions, "expectedKind"> = {},
): asserts value is RuntimeModuleDefinition {
  assertModuleDefinitionCompliance(value, { ...options, expectedKind: "runtime" });
  assertOptionalFunction((value as unknown as Record<string, unknown>).validateModel,
    "runtime module definition validateModel");
}
export function assertChannelModuleCompliance(
  value: unknown, options: Omit<ModuleComplianceOptions, "expectedKind"> = {},
): asserts value is ChannelModuleDefinition {
  assertModuleDefinitionCompliance(value, { ...options, expectedKind: "channel" });
}
export function assertMemoryModuleCompliance(
  value: unknown, options: Omit<ModuleComplianceOptions, "expectedKind"> = {},
): asserts value is MemoryModuleDefinition {
  assertModuleDefinitionCompliance(value, { ...options, expectedKind: "memory" });
}
export function assertRuntimeInstanceCompliance(value: unknown): asserts value is Runtime {
  const instance = assertModuleInstance(value, "runtime");
  assertInstanceCapabilities(instance, "runtime", RUNTIME_CAPABILITIES,
    ["artifactResults", "liveInput", "maxTurns", "maxOutputTokens"]);
  if (typeof instance.runTurn !== "function") fail("runtime instance runTurn must be a function");
  for (const method of ["validateModel", "preflightModel"] as const)
    assertOptionalFunction(instance[method], `runtime instance ${method}`);
}
export function assertChannelInstanceCompliance(value: unknown): asserts value is Channel {
  const instance = assertModuleInstance(value, "channel");
  const capabilities = assertInstanceCapabilities(instance, "channel", CHANNEL_CAPABILITIES, ["approvals"]);
  for (const method of ["deliver", "resolveDefaultDeliveryConversationId", "resolveDeliveryHistory"] as const)
    assertOptionalFunction(instance[method], `channel instance ${method}`);
  const sendTools = assertChannelSendTools(readOwnDataProperty(instance, "sendTools", "channel instance"));
  for (const method of ["deliver", "resolveDeliveryHistory"] as const)
    if (capabilities.proactive !== (typeof instance[method] === "function"))
      fail(`channel proactive capability and ${method} function must match`);
  if (sendTools > 0 && capabilities.proactive !== true)
    fail("channel sendTools require proactive capability and delivery");
}
export function assertMemoryInstanceCompliance(value: unknown): asserts value is Memory {
  const instance = assertModuleInstance(value, "memory");
  const capabilities = assertInstanceCapabilities(instance, "memory", ["capture", "forget"], ["recallTool"]);
  if (typeof instance.recall !== "function") fail("memory instance recall must be a function");
  for (const method of ["capture", "forget"] as const)
    assertOptionalFunction(instance[method], `memory instance ${method}`);
  for (const method of ["capture", "forget"] as const) {
    if (capabilities[method] === true && typeof instance[method] !== "function")
      fail(`${method}-capable memory instance ${method} must be a function`);
  }
}
export function assertMonoAgentModuleExport(namespace: unknown, options: ModuleComplianceOptions = {}):
OpenModuleDefinition {
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
export function assertModuleToolContributionsCompliance(
  value: unknown,
  label = "module instance toolContributions",
): void {
  if (value === undefined) return;
  const contributions = requireOwnDataArray(value, label, MODULE_TOOL_LIMITS.perInstance);
  const names = new Set<string>();
  for (const [index, raw] of contributions.entries()) {
    const toolLabel = `${label}[${String(index)}]`;
    const tool = requirePlainRecord(raw, toolLabel);
    assertExactOwnDataKeys(tool, toolLabel, [
      "name", "description", "inputSchema", "effects", "bind",
    ]);
    const name = readOwnDataProperty(tool, "name", toolLabel, true);
    if (typeof name !== "string"
      || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name)) {
      fail(`${toolLabel}.name must be a portable tool name`);
    }
    if (names.has(name)) fail(`${label} contains duplicate ${name}`);
    names.add(name);
    const description = readOwnDataProperty(tool, "description", toolLabel, true);
    requireNonEmptyString(description, `${toolLabel}.description`);
    if (utf8Bytes(description) > MODULE_TOOL_LIMITS.descriptionBytes) {
      fail(`${toolLabel}.description exceeds ${String(MODULE_TOOL_LIMITS.descriptionBytes)} UTF-8 bytes`);
    }
    const inputSchema = requirePlainRecord(
      readOwnDataProperty(tool, "inputSchema", toolLabel, true),
      `${toolLabel}.inputSchema`,
    );
    assertBoundedModuleToolSchema(inputSchema, `${toolLabel}.inputSchema`);
    assertSchemaGraph(inputSchema);
    const effects = requireOwnDataArray(
      readOwnDataProperty(tool, "effects", toolLabel, true),
      `${toolLabel}.effects`,
      4,
    );
    const seenEffects = new Set<string>();
    for (const [effectIndex, effect] of effects.entries()) {
      if (typeof effect !== "string"
        || !["read", "write", "execute", "network"].includes(effect)) {
        fail(`${toolLabel}.effects[${String(effectIndex)}] is invalid`);
      }
      if (seenEffects.has(effect)) {
        fail(`${toolLabel}.effects contains duplicate ${effect}`);
      }
      seenEffects.add(effect);
    }
    if (typeof readOwnDataProperty(tool, "bind", toolLabel, true) !== "function") {
      fail(`${toolLabel}.bind must be a function`);
    }
  }
}
export function assertModuleToolBindingCompliance(
  value: unknown,
  label = "module tool binding",
): asserts value is ModuleToolBinding {
  const binding = requirePlainRecord(value, label);
  assertExactOwnDataKeys(binding, label, ["execute"]);
  if (typeof readOwnDataProperty(binding, "execute", label, true) !== "function") {
    fail(`${label}.execute must be a function`);
  }
}
function assertChannelSendTools(value: unknown): number {
  if (value === undefined) return 0;
  if (!Array.isArray(value) || value.length > 64) fail("channel instance sendTools must be an array of at most 64 tools");
  const names = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const tool = requirePlainRecord(raw, `channel instance sendTools[${index}]`);
    const name = readOwnDataProperty(tool, "name", `channel instance sendTools[${index}]`, true);
    const description = readOwnDataProperty(tool, "description", `channel instance sendTools[${index}]`, true);
    if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name)) fail(`channel instance sendTools[${index}].name must be a portable tool name`);
    if (names.has(name)) fail(`channel instance sendTools contains duplicate ${name}`);
    names.add(name); requireNonEmptyString(description, `channel instance sendTools[${index}].description`);
    const schema = requirePlainRecord(readOwnDataProperty(
      tool, "inputSchema", `channel instance sendTools[${index}]`, true,
    ), `channel instance sendTools[${index}].inputSchema`);
    assertSchemaGraph(schema);
    for (const method of ["prepare"] as const) if (typeof readOwnDataProperty(
      tool, method, `channel instance sendTools[${index}]`, true,
    ) !== "function") fail(`channel instance sendTools[${index}].${method} must be a function`);
  }
  return value.length;
}
function assertModuleInstance(value: unknown, kind: ModuleKind): Record<string, unknown> {
  const label = `${kind} instance`;
  const instance = requireRecord(value, label);
  for (const method of INSTANCE_METHODS) assertOptionalFunction(instance[method], `${label} ${method}`);
  const contributionDescriptor = Object.getOwnPropertyDescriptor(instance, "toolContributions");
  if (contributionDescriptor !== undefined && !("value" in contributionDescriptor)) {
    fail(`${label}.toolContributions must be an own data property`);
  }
  assertModuleToolContributionsCompliance(
    contributionDescriptor === undefined ? undefined : contributionDescriptor.value,
    `${label}.toolContributions`,
  );
  if (instance.commands !== undefined) {
    if (!Array.isArray(instance.commands)) fail(`${label} commands must be an array`);
    for (const [index, commandValue] of instance.commands.entries()) {
      const commandLabel = `${label} commands[${index}]`;
      const command = requireRecord(commandValue, commandLabel);
      for (const field of ["name", "description"] as const)
        requireNonEmptyString(command[field], `${commandLabel}.${field}`);
      if (command.kind !== "authentication" && command.kind !== "maintenance")
        fail(`${commandLabel}.kind is invalid`);
      if (typeof command.run !== "function") fail(`${commandLabel}.run must be a function`);
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
function assertInstanceCapabilities(
  instance: Record<string, unknown>, kind: ModuleKind, requiredNames: readonly string[],
  optionalNames: readonly string[] = [],
): Record<string, unknown> {
  const label = `${kind} capabilities`;
  const capabilities = requirePlainRecord(
    readOwnDataProperty(instance, "capabilities", `${kind} instance`, true), label,
  );
  const allowedNames = [...requiredNames, ...optionalNames];
  for (const key of Reflect.ownKeys(capabilities)) {
    if (typeof key !== "string") fail(`${label} contains an unknown symbol key`);
    if (UNSAFE_KEYS.has(key)) fail(`${label} contains unsafe key ${JSON.stringify(key)}`);
    if (!allowedNames.includes(key)) fail(`${label} contains unknown key ${JSON.stringify(key)}`);
  }
  const detached: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of allowedNames) {
    const required = requiredNames.includes(name);
    const capability = readOwnDataProperty(capabilities, name, label, required);
    if (required ? typeof capability !== "boolean" : capability !== undefined && typeof capability !== "boolean") {
      fail(`${label}.${name} must be a boolean${required ? "" : " when present"}`);
    }
    if (capability !== undefined) detached[name] = capability;
  }
  return detached;
}
function assertSchemaGraph(jsonSchema: Record<string, unknown>): void {
  const visited = new Set<object>();
  const pending: unknown[] = [jsonSchema];
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
  for (const current of visited) {
    if (Array.isArray(current)) continue;
    const schema = snapshots.get(current)!;
    if (MODULE_SCHEMA_SLOT_REFERENCE in schema
      && (schema.type !== "string" || !hasValidSlotReference(schema, snapshots))) {
      fail("module schema has an invalid cross-slot reference annotation");
    }
  }
}
function snapshotSchemaNode(value: object, snapshots: WeakMap<object, Record<string, unknown>>):
Record<string, unknown> {
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
    Object.defineProperty(snapshot, key,
      { value: descriptor.value, enumerable: descriptor.enumerable === true });
  }
  return snapshot;
}
function hasValidSlotReference(schema: Record<string, unknown>,
  snapshots: WeakMap<object, Record<string, unknown>>): boolean {
  const reference = schema[MODULE_SCHEMA_SLOT_REFERENCE];
  if (reference === null || typeof reference !== "object" || Array.isArray(reference)) return false;
  return readCrossSlotReference({
    [MODULE_SCHEMA_SLOT_REFERENCE]: snapshotSchemaNode(reference, snapshots),
  }) !== undefined;
}
function assertOptionalFunction(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "function") fail(`${label} must be a function when present`);
}
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  if (isProxy(value)) fail(`${label} must not be a Proxy`);
  return value as Record<string, unknown>;
}
function requirePlainRecord(value: unknown, label: string): Record<string, unknown> {
  const record = requireRecord(value, label);
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  return record;
}
function requireOwnDataArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${label} must be an ordinary array`);
  }
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    fail(`${label}.length must be a non-negative safe integer`);
  }
  if (length > maximum) fail(`${label} must contain at most ${String(maximum)} entries`);
  const allowed = new Set<PropertyKey>(["length"]);
  for (let index = 0; index < length; index += 1) allowed.add(String(index));
  for (const key of Reflect.ownKeys(value)) {
    if (!allowed.has(key)) fail(`${label} contains an unsupported property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      fail(`${label}.${String(key)} must be a data property`);
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      fail(`${label}[${String(index)}] must be an enumerable data property`);
    }
  }
  return value;
}
function assertExactOwnDataKeys(
  value: Record<string, unknown>,
  label: string,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set<PropertyKey>(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unsupported property ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      fail(`${label}.${String(key)} must be an enumerable data property`);
    }
  }
}
function readOwnDataProperty(
  value: Record<string, unknown>, key: string, label: string, required = false,
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
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function assertBoundedModuleToolSchema(value: Record<string, unknown>, label: string): void {
  let bytes = 0;
  let items = 0;
  let serializedBytes = 0;
  const active = new Set<object>();
  const charge = (amount: number): void => {
    bytes += amount;
    if (bytes > MODULE_TOOL_LIMITS.inputSchemaBytes) {
      fail(`${label} exceeds ${String(MODULE_TOOL_LIMITS.inputSchemaBytes)} UTF-8 bytes`);
    }
  };
  const chargeSerialized = (amount: number): void => {
    serializedBytes += amount;
    if (serializedBytes > MODULE_TOOL_LIMITS.inputSchemaBytes) {
      fail(`${label} exceeds ${String(MODULE_TOOL_LIMITS.inputSchemaBytes)} UTF-8 bytes`);
    }
  };
  const addItems = (amount: number): void => {
    items += amount;
    if (items > MODULE_TOOL_LIMITS.inputSchemaItems) {
      fail(`${label} exceeds ${String(MODULE_TOOL_LIMITS.inputSchemaItems)} JSON items`);
    }
  };
  const visit = (current: unknown, path: string, depth: number): void => {
    if (depth === 0) addItems(1);
    if (current === null) { charge(8); chargeSerialized(4); return; }
    if (typeof current === "boolean") {
      charge(8); chargeSerialized(current ? 4 : 5); return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail(`${path} must contain only finite numbers`);
      charge(16); chargeSerialized(jsonScalarBytes(current)); return;
    }
    if (typeof current === "string") {
      charge(utf8Bytes(current)); chargeSerialized(jsonScalarBytes(current)); return;
    }
    if (current === null || typeof current !== "object") {
      fail(`${path} must contain only JSON values`);
    }
    if (isProxy(current)) fail(`${path} must not contain a Proxy`);
    if (depth >= MODULE_TOOL_LIMITS.inputSchemaDepth) {
      fail(`${path} exceeds JSON depth ${String(MODULE_TOOL_LIMITS.inputSchemaDepth)}`);
    }
    if (active.has(current)) fail(`${path} must not contain cycles`);
    const source = Array.isArray(current)
      ? requireOwnDataArray(current, path, MODULE_TOOL_LIMITS.inputSchemaItems)
      : requirePlainRecord(current, path);
    const entries = Reflect.ownKeys(source)
      .filter((key) => !Array.isArray(current) || key !== "length");
    addItems(entries.length);
    chargeSerialized(2 + Math.max(0, entries.length - 1));
    active.add(current);
    try {
      for (const key of entries) {
        if (typeof key !== "string") fail(`${path} contains an unknown symbol key`);
        if (UNSAFE_KEYS.has(key)) fail(`${path} contains unsafe key ${JSON.stringify(key)}`);
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
          fail(`${path}.${key} must be an enumerable data property`);
        }
        if (!Array.isArray(current)) {
          charge(utf8Bytes(key));
          chargeSerialized(jsonScalarBytes(key) + 1);
        }
        visit(descriptor.value, Array.isArray(current) ? `${path}[${key}]` : `${path}.${key}`, depth + 1);
      }
    } finally {
      active.delete(current);
    }
  }
  visit(value, label, 0);
}
function jsonScalarBytes(value: string | number): number {
  return utf8Bytes(JSON.stringify(value));
}
function fail(message: string): never {
  throw new ModuleComplianceError(message);
}
