/**
 * First-party contracts for reserved module slots.
 *
 * This entrypoint is intentionally not part of the third-party extension
 * promise. A reserved slot moves to the package root only after promotion by a
 * later architecture decision and a public compliance suite.
 */
import type {
  ArtifactRef,
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
interface Signaled { readonly signal: AbortSignal }
interface Keyed { readonly key: string }
interface CursorPage { readonly cursor?: string; readonly limit: number }
interface CursorResult { readonly cursor?: string }
interface VersionPrecondition extends Keyed {
  readonly expectedVersion: string | null;
}
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
export interface StateReadRequest extends Keyed, Signaled {}
export interface StateWriteRequest extends Keyed, Signaled {
  readonly value: Uint8Array;
  readonly expectedVersion?: string;
}
export interface StateDeleteRequest extends Keyed, Signaled {
  readonly expectedVersion?: string;
}
export interface StateListRequest extends CursorPage, Signaled {
  readonly prefix?: string;
}
export interface StateListResult extends CursorResult {
  readonly records: readonly StateRecord[];
}
export interface StateWriteResult { readonly version: string; readonly updatedAt: string }
export interface StateCompareAndSwapRequest extends Keyed, Signaled {
  /** `null` means the key must not exist. */
  readonly expectedVersion: string | null;
  readonly value: Uint8Array;
}
export type StateCompareAndSwapResult =
  | { readonly status: "applied"; readonly record: StateRecord }
  | { readonly status: "conflict"; readonly currentVersion?: string };
/**
 * A read-only precondition evaluated against the transaction's initial
 * snapshot. `null` requires the key to be absent; a version requires an exact
 * match.
 */
export interface StateTransactionCheck extends VersionPrecondition {}
/**
 * An atomic write. Transaction mutations deliberately have no unconditional
 * form: callers must state whether they expect absence or one exact version.
 */
export interface StateTransactionPut extends VersionPrecondition {
  readonly value: Uint8Array;
}
/**
 * An atomic delete. `null` asserts absence and therefore applies as a no-op;
 * a version removes only that exact record.
 */
export interface StateTransactionDelete extends VersionPrecondition {}
export interface StateTransactionRequest extends Signaled {
  readonly checks: readonly StateTransactionCheck[];
  readonly puts: readonly StateTransactionPut[];
  readonly deletes: readonly StateTransactionDelete[];
}
export interface StateTransactionConflict extends Keyed {
  /** Omitted when the conflicting key does not exist. */
  readonly currentVersion?: string;
}
export type StateTransactionResult =
  | {
      readonly status: "applied";
      /** Post-transaction copies for every put, in request order. */
      readonly records: readonly StateRecord[];
      /** Existing keys actually removed, in request order. */
      readonly deletedKeys: readonly string[];
    }
  | {
      readonly status: "conflict";
      /** Every failed precondition, in checks/puts/deletes request order. */
      readonly conflicts: readonly StateTransactionConflict[];
    };
/**
 * Forward prefix scan. Its opaque cursor binds the exact prefix and last
 * returned key rather than an offset or store generation, so callers can
 * continue across intervening commits without repeating earlier keys.
 */
export interface StateScanRequest extends CursorPage, Signaled {
  readonly prefix: string;
}
export interface StateScanResult extends CursorResult {
  readonly records: readonly StateRecord[];
}
export interface StatePresenceRecord {
  readonly presenceId: string;
  readonly agentId: string;
  readonly instanceId: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly metadata?: JsonObject;
}
export interface StatePresenceUpsertRequest extends Signaled {
  readonly presence: StatePresenceRecord;
}
export interface StatePresenceRemoveRequest extends Signaled {
  readonly presenceId: string;
  readonly instanceId: string;
}
export interface StatePresenceListRequest extends Signaled {
  readonly agentId?: string;
  readonly includeExpired?: boolean;
}
export type StateHostPresenceStatus = "starting" | "ready" | "degraded" | "stopping" | "stopped";
export interface StateHostPresenceRequest extends Signaled {
  readonly status: StateHostPresenceStatus;
  readonly details?: JsonObject;
}
export interface StatePutArtifactRequest extends Signaled {
  readonly data: Uint8Array;
  readonly mediaType: string;
  readonly fileName?: string;
}
export interface StateReadArtifactRequest extends Signaled {
  readonly ref: ArtifactRef;
  readonly maxBytes: number;
}
export interface StateDeleteArtifactRequest extends Signaled {
  readonly ref: ArtifactRef;
}
export interface StateListArtifactsRequest extends CursorPage, Signaled {}
export interface StateListArtifactsResult extends CursorResult {
  readonly artifacts: readonly ArtifactRef[];
}
/**
 * Opaque first-party execution protocol owned by the selected state module.
 *
 * Domain inputs and outputs deliberately remain `unknown`: durable transcript,
 * run, admission, session, delivery, and artifact-intent schemas are private to
 * the state implementation rather than becoming Module SDK contracts.
 */
export interface StateExecutionRequest extends Signaled {
  readonly operation: string;
  readonly input?: unknown;
}
export interface StateExecution {
  perform(request: StateExecutionRequest): Promise<unknown>;
}
export interface StateStore extends ModuleInstance {
  read(request: StateReadRequest): Promise<StateRecord | undefined>;
  write(request: StateWriteRequest): Promise<StateWriteResult>;
  delete(request: StateDeleteRequest): Promise<boolean>;
  list(request: StateListRequest): Promise<StateListResult>;
  compareAndSwap(request: StateCompareAndSwapRequest): Promise<StateCompareAndSwapResult>;
  transaction(request: StateTransactionRequest): Promise<StateTransactionResult>;
  scan(request: StateScanRequest): Promise<StateScanResult>;
  upsertPresence(request: StatePresenceUpsertRequest): Promise<StatePresenceRecord>;
  removePresence(request: StatePresenceRemoveRequest): Promise<boolean>;
  listPresence(request: StatePresenceListRequest): Promise<readonly StatePresenceRecord[]>;
  /** Optionally publishes owner-private process discovery outside the key/value namespace. */
  publishHostPresence?(request: StateHostPresenceRequest): Promise<void>;
  /** Optional content-addressed artifact plane used by Core for bounded large results. */
  putArtifact?(request: StatePutArtifactRequest): Promise<ArtifactRef>;
  readArtifact?(request: StateReadArtifactRequest): Promise<Uint8Array>;
  deleteArtifact?(request: StateDeleteArtifactRequest): Promise<boolean>;
  listArtifacts?(request: StateListArtifactsRequest): Promise<StateListArtifactsResult>;
  /** Optional first-party durable execution recorder; its protocol is owner-private. */
  readonly execution?: StateExecution;
}
export type StateHost = ModuleHost;
export type StateModuleCreateContext<TConfig> = ModuleCreateContext<TConfig, StateHost>;
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
export interface ExportRecord {
  readonly name: string;
  readonly timestamp: string;
  readonly attributes: JsonObject;
  readonly body?: JsonValue;
}
export interface ExportBatch extends Signaled { readonly records: readonly ExportRecord[] }
export interface ExportResult { readonly accepted: number; readonly rejected: number }
export interface Exporter extends ModuleInstance {
  export(batch: ExportBatch): Promise<ExportResult>;
  flush(signal: AbortSignal): Promise<void>;
}
export type ExporterHost = ModuleHost;
export type ExporterModuleCreateContext<TConfig> = ModuleCreateContext<TConfig, ExporterHost>;
export interface SandboxCommand extends Signaled {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array;
  readonly timeoutMs?: number;
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
interface ReservedModuleDefinitionBase<
  K extends ReservedModuleKind,
  TConfig,
  TInstance extends ModuleInstance,
  THost extends ModuleHost,
> {
  readonly manifest: ReservedModuleManifest<K>;
  readonly schema: ModuleSchema<TConfig>;
  create(context: ModuleCreateContext<TConfig, THost>): Awaitable<TInstance>;
}
export interface StateModuleDefinition<TConfig = unknown, TInstance extends StateStore = StateStore>
  extends ReservedModuleDefinitionBase<"state", TConfig, TInstance, StateHost> {}
export interface TriggerModuleDefinition<TConfig = unknown, TInstance extends Trigger = Trigger>
  extends ReservedModuleDefinitionBase<"trigger", TConfig, TInstance, TriggerHost> {}
export interface ExporterModuleDefinition<TConfig = unknown, TInstance extends Exporter = Exporter>
  extends ReservedModuleDefinitionBase<"exporter", TConfig, TInstance, ExporterHost> {}
export interface SandboxModuleDefinition<TConfig = unknown, TInstance extends Sandbox = Sandbox>
  extends ReservedModuleDefinitionBase<"sandbox", TConfig, TInstance, SandboxHost> {}
export type ReservedModuleDefinition =
  | StateModuleDefinition
  | TriggerModuleDefinition
  | ExporterModuleDefinition
  | SandboxModuleDefinition;
export function defineStateModule<TConfig, TInstance extends StateStore>(
  definition: StateModuleDefinition<TConfig, TInstance>,
): StateModuleDefinition<TConfig, TInstance> { return freezeReservedDefinition(definition) }
export function defineTriggerModule<TConfig, TInstance extends Trigger>(
  definition: TriggerModuleDefinition<TConfig, TInstance>,
): TriggerModuleDefinition<TConfig, TInstance> { return freezeReservedDefinition(definition) }
export function defineExporterModule<TConfig, TInstance extends Exporter>(
  definition: ExporterModuleDefinition<TConfig, TInstance>,
): ExporterModuleDefinition<TConfig, TInstance> { return freezeReservedDefinition(definition) }
export function defineSandboxModule<TConfig, TInstance extends Sandbox>(
  definition: SandboxModuleDefinition<TConfig, TInstance>,
): SandboxModuleDefinition<TConfig, TInstance> { return freezeReservedDefinition(definition) }
function freezeReservedDefinition<
  T extends { readonly manifest: ReservedModuleManifest; readonly schema: ModuleSchema<unknown> },
>(definition: T): T {
  const manifest = Object.freeze({
    ...definition.manifest,
    capabilities: Object.freeze([...definition.manifest.capabilities]),
  });
  return Object.freeze({ ...definition, manifest }) as T;
}
