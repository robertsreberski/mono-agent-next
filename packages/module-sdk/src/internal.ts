/**
 * First-party contracts for reserved module slots.
 *
 * This entrypoint is intentionally not part of the third-party extension
 * promise. A reserved slot moves to the package root only after promotion by a
 * later architecture decision and a public compliance suite.
 */

import type {
  Awaitable,
  JsonObject,
  JsonValue,
  ModuleApiVersion,
  ModuleCreateContext,
  ModuleHost,
  ModuleInstance,
  ModuleManifest,
  ModuleSchema,
} from "./index.js";

export const RESERVED_MODULE_KINDS = ["state", "trigger", "exporter", "sandbox"] as const;

export type ReservedModuleKind = (typeof RESERVED_MODULE_KINDS)[number];

/** Same wire shape as a public manifest, but with a reserved capability kind. */
export interface ReservedModuleManifest<K extends ReservedModuleKind = ReservedModuleKind>
  extends Omit<ModuleManifest, "kind"> {
  readonly apiVersion: ModuleApiVersion;
  readonly kind: K;
}

export interface StateRecord {
  readonly key: string;
  readonly value: Uint8Array;
  readonly version: string;
  readonly updatedAt: string;
}

export interface StateReadRequest {
  readonly key: string;
  readonly signal: AbortSignal;
}

export interface StateWriteRequest {
  readonly key: string;
  readonly value: Uint8Array;
  readonly expectedVersion?: string;
  readonly signal: AbortSignal;
}

export interface StateDeleteRequest {
  readonly key: string;
  readonly expectedVersion?: string;
  readonly signal: AbortSignal;
}

export interface StateListRequest {
  readonly prefix?: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly signal: AbortSignal;
}

export interface StateListResult {
  readonly records: readonly StateRecord[];
  readonly cursor?: string;
}

export interface StateWriteResult {
  readonly version: string;
  readonly updatedAt: string;
}

export interface StateStore extends ModuleInstance {
  read(request: StateReadRequest): Promise<StateRecord | undefined>;
  write(request: StateWriteRequest): Promise<StateWriteResult>;
  delete(request: StateDeleteRequest): Promise<boolean>;
  list(request: StateListRequest): Promise<StateListResult>;
}

export type StateHost = ModuleHost;
export type StateModuleCreateContext<TConfig> = ModuleCreateContext<TConfig, StateHost>;

export interface StateModuleDefinition<TConfig = unknown, TInstance extends StateStore = StateStore> {
  readonly manifest: ReservedModuleManifest<"state">;
  readonly schema: ModuleSchema<TConfig>;
  create(context: StateModuleCreateContext<TConfig>): Awaitable<TInstance>;
}

export interface TriggerEvent {
  readonly id: string;
  readonly triggerInstanceId: string;
  readonly prompt: string;
  readonly createdAt: string;
  readonly runtime?: string;
  readonly model?: string;
  readonly deliveryChannel?: string;
  readonly metadata?: JsonObject;
}

export interface TriggerReceipt {
  readonly status: "accepted" | "rejected";
  readonly runId?: string;
  readonly reason?: string;
}

export interface TriggerHost extends ModuleHost {
  emit(event: TriggerEvent, signal: AbortSignal): Promise<TriggerReceipt>;
}

export interface Trigger extends ModuleInstance {}

export type TriggerModuleCreateContext<TConfig> = ModuleCreateContext<TConfig, TriggerHost>;

export interface TriggerModuleDefinition<TConfig = unknown, TInstance extends Trigger = Trigger> {
  readonly manifest: ReservedModuleManifest<"trigger">;
  readonly schema: ModuleSchema<TConfig>;
  create(context: TriggerModuleCreateContext<TConfig>): Awaitable<TInstance>;
}

export interface ExportRecord {
  readonly name: string;
  readonly timestamp: string;
  readonly attributes: JsonObject;
  readonly body?: JsonValue;
}

export interface ExportBatch {
  readonly records: readonly ExportRecord[];
  readonly signal: AbortSignal;
}

export interface ExportResult {
  readonly accepted: number;
  readonly rejected: number;
}

export interface Exporter extends ModuleInstance {
  export(batch: ExportBatch): Promise<ExportResult>;
  flush?(signal: AbortSignal): Promise<void>;
}

export type ExporterHost = ModuleHost;
export type ExporterModuleCreateContext<TConfig> = ModuleCreateContext<TConfig, ExporterHost>;

export interface ExporterModuleDefinition<TConfig = unknown, TInstance extends Exporter = Exporter> {
  readonly manifest: ReservedModuleManifest<"exporter">;
  readonly schema: ModuleSchema<TConfig>;
  create(context: ExporterModuleCreateContext<TConfig>): Awaitable<TInstance>;
}

export interface SandboxCommand {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array;
  readonly timeoutMs?: number;
  readonly signal: AbortSignal;
}

export interface SandboxResult {
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly timedOut: boolean;
}

export interface Sandbox extends ModuleInstance {
  execute(command: SandboxCommand): Promise<SandboxResult>;
}

export type SandboxHost = ModuleHost;
export type SandboxModuleCreateContext<TConfig> = ModuleCreateContext<TConfig, SandboxHost>;

export interface SandboxModuleDefinition<TConfig = unknown, TInstance extends Sandbox = Sandbox> {
  readonly manifest: ReservedModuleManifest<"sandbox">;
  readonly schema: ModuleSchema<TConfig>;
  create(context: SandboxModuleCreateContext<TConfig>): Awaitable<TInstance>;
}

export type ReservedModuleDefinition =
  | StateModuleDefinition
  | TriggerModuleDefinition
  | ExporterModuleDefinition
  | SandboxModuleDefinition;

export function defineStateModule<TConfig, TInstance extends StateStore>(
  definition: StateModuleDefinition<TConfig, TInstance>,
): StateModuleDefinition<TConfig, TInstance> {
  return freezeReservedDefinition(definition);
}

export function defineTriggerModule<TConfig, TInstance extends Trigger>(
  definition: TriggerModuleDefinition<TConfig, TInstance>,
): TriggerModuleDefinition<TConfig, TInstance> {
  return freezeReservedDefinition(definition);
}

export function defineExporterModule<TConfig, TInstance extends Exporter>(
  definition: ExporterModuleDefinition<TConfig, TInstance>,
): ExporterModuleDefinition<TConfig, TInstance> {
  return freezeReservedDefinition(definition);
}

export function defineSandboxModule<TConfig, TInstance extends Sandbox>(
  definition: SandboxModuleDefinition<TConfig, TInstance>,
): SandboxModuleDefinition<TConfig, TInstance> {
  return freezeReservedDefinition(definition);
}

function freezeReservedDefinition<
  T extends { readonly manifest: ReservedModuleManifest; readonly schema: ModuleSchema<unknown> },
>(definition: T): T {
  const manifest = Object.freeze({
    ...definition.manifest,
    capabilities: Object.freeze([...definition.manifest.capabilities]),
  });
  return Object.freeze({ ...definition, manifest }) as T;
}
