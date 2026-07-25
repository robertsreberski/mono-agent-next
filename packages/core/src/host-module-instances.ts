// SPDX-License-Identifier: MIT
import { isRecord } from "./host-values.js";
export function assertStateArtifactCompliance(instance: Record<string, unknown>): void {
  assertOptionalInstanceFunction(instance, "publishHostPresence", "state instance");
  const methods = ["putArtifact", "readArtifact", "deleteArtifact", "listArtifacts"] as const;
  const present = methods.filter((method) => instance[method] !== undefined).length;
  if (present > 0 && present !== methods.length)
    throw new TypeError("state instance must implement the complete artifact method group");
  for (const method of methods)
    assertOptionalInstanceFunction(instance, method, "state instance");
}
export function requireInstanceRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}
export function snapshotInstanceCapabilities<T extends object>(
  value: unknown,
  kind: "runtime" | "channel",
  instanceId: string,
  normalize: (value: unknown, label: string) => T,
): Readonly<T> {
  const instance = requireInstanceRecord(value, `${kind} instance`);
  const descriptor = Object.getOwnPropertyDescriptor(instance, "capabilities");
  if (descriptor === undefined || !("value" in descriptor))
    throw new TypeError(`${kind} instance capabilities must be an own data property`);
  return Object.freeze(normalize(descriptor.value, `${instanceId} ${kind} capabilities`));
}
export function assertInstanceLifecycle(instance: Record<string, unknown>, label: string): void {
  for (const method of ["start", "drain", "stop", "health", "diagnostics"] as const) {
    assertOptionalInstanceFunction(instance, method, label);
  }
  if (instance.commands === undefined) return;
  if (!Array.isArray(instance.commands)) throw new TypeError(`${label} commands must be an array`);
  for (const [index, rawCommand] of instance.commands.entries()) {
    const commandLabel = `${label} commands[${index}]`;
    const command = requireInstanceRecord(rawCommand, commandLabel);
    for (const field of ["name", "description"] as const)
      if (typeof command[field] !== "string" || command[field].trim().length === 0)
        throw new TypeError(`${commandLabel}.${field} must be a non-empty string`);
    if (command.kind !== "authentication" && command.kind !== "maintenance")
      throw new TypeError(`${commandLabel}.kind is invalid`);
    assertRequiredInstanceFunctions(command, ["run"], commandLabel);
  }
}
export function assertRequiredInstanceFunctions(
  instance: Record<string, unknown>,
  methods: readonly string[],
  label: string,
): void {
  for (const method of methods) {
    if (typeof instance[method] !== "function") throw new TypeError(`${label} ${method} must be a function`);
  }
}
export function assertOptionalInstanceFunction(
  instance: Record<string, unknown>,
  method: string,
  label: string,
): void {
  if (instance[method] !== undefined && typeof instance[method] !== "function") {
    throw new TypeError(`${label} ${method} must be a function when present`);
  }
}
