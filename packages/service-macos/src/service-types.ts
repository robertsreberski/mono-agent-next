// SPDX-License-Identifier: MIT
import type {
  AgentLoadOptions,
  AgentValidationResult,
} from "@mono-agent/core";
import type { WebConfig } from "@mono-agent/web";

import type { CommandRunner } from "./command.js";
import type {
  ServiceMacosServiceConfig,
} from "./config.js";
import type { ManagedServiceLogSnapshot } from "./logs.js";
import type {
  ServiceMacosRuntimePaths,
  ServiceMacosTarget,
  ServiceRunnerBinding,
} from "./plist.js";

export interface ServiceFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly ctimeNanoseconds: string;
  readonly uid: number;
  readonly mode: number;
  readonly links: number;
  readonly size: number;
}

export interface ServiceFileObservation {
  readonly exists: boolean;
  readonly digest?: string;
  readonly bytes?: number;
  readonly identity?: ServiceFileIdentity;
}

export interface CompleteServiceMacosObservation {
  readonly target: ServiceMacosTarget;
  readonly file: ServiceFileObservation;
  readonly loaded: boolean;
  readonly launchdState: "absent" | "running" | "exited" | "unknown";
  readonly pid?: number;
  readonly ready: boolean;
  readonly observationError?: never;
}

interface FailedServiceMacosObservation {
  readonly target: ServiceMacosTarget;
  readonly file?: ServiceFileObservation;
  readonly loaded?: boolean;
  readonly launchdState: "unknown";
  readonly ready: false;
  readonly observationError: string;
}

export type ServiceMacosObservation =
  | CompleteServiceMacosObservation
  | FailedServiceMacosObservation;

export interface ServicePlanBinding extends ServiceRunnerBinding {
  readonly environmentFile?: string;
}

export type ServicePlanAction =
  | "create"
  | "update"
  | "load"
  | "restart"
  | "noop";
export type ServiceRemovalAction = "remove" | "noop";

export interface ServiceMacosPlanEntry {
  readonly serviceId: string;
  readonly service: ServiceMacosServiceConfig;
  readonly target: ServiceMacosTarget;
  readonly binding: ServicePlanBinding;
  readonly observed: CompleteServiceMacosObservation;
  readonly desiredPlist: string;
  readonly desiredDigest: string;
  readonly readinessToken: string;
  readonly action: ServicePlanAction;
}

export interface ServiceMacosPlan {
  readonly schemaVersion: 1;
  readonly configPath: string;
  readonly configDigest: string;
  readonly runtime: ServiceMacosRuntimePaths;
  readonly launchAgentsDirectoryIdentity: string;
  readonly entries: readonly ServiceMacosPlanEntry[];
  readonly fingerprint: string;
}

export interface ServiceMacosRemovalPlanEntry {
  readonly serviceId: string;
  readonly target: ServiceMacosTarget;
  readonly observed: CompleteServiceMacosObservation;
  readonly action: ServiceRemovalAction;
}

export interface ServiceMacosRemovalPlan {
  readonly schemaVersion: 1;
  readonly operation: "remove";
  readonly configPath: string;
  readonly configDigest: string;
  readonly runtime: ServiceMacosRuntimePaths;
  readonly launchAgentsDirectoryIdentity: string;
  readonly entries: readonly ServiceMacosRemovalPlanEntry[];
  readonly fingerprint: string;
}

export interface ServiceMacosStopPlanEntry {
  readonly serviceId: string;
  readonly service: ServiceMacosServiceConfig;
  readonly target: ServiceMacosTarget;
  readonly observed: CompleteServiceMacosObservation;
  readonly action: "stop" | "noop";
}

export interface ServiceMacosStopPlan {
  readonly schemaVersion: 1;
  readonly operation: "stop";
  readonly configPath: string;
  readonly configDigest: string;
  readonly runtime: ServiceMacosRuntimePaths;
  readonly launchAgentsDirectoryIdentity: string;
  readonly entry: ServiceMacosStopPlanEntry;
  readonly fingerprint: string;
}

export interface ServiceMacosStatus {
  readonly schemaVersion: 1;
  readonly operation: "status";
  readonly configPath: string;
  readonly configDigest: string;
  readonly serviceId: string;
  readonly observation: ServiceMacosObservation;
  readonly fingerprint: string;
}

export interface ServiceMacosLogsSnapshot {
  readonly schemaVersion: 1;
  readonly operation: "logs";
  readonly configPath: string;
  readonly configDigest: string;
  readonly serviceId: string;
  readonly observation: ServiceMacosObservation;
  readonly stdout: ManagedServiceLogSnapshot;
  readonly stderr: ManagedServiceLogSnapshot;
  readonly fingerprint: string;
}

export interface InspectServiceMacosOptions {
  readonly runtime: ServiceMacosRuntimePaths;
  readonly runner?: CommandRunner;
  readonly signal?: AbortSignal;
}

export interface PlanServiceMacosOptions extends InspectServiceMacosOptions {
  readonly validateAgent?: (
    path: string,
    options?: AgentLoadOptions,
  ) => Promise<AgentValidationResult>;
  readonly validateWeb?: (
    path: string,
    options?: {
      readonly environment?: Readonly<Record<string, string | undefined>>;
    },
  ) => Promise<WebConfig>;
}

export interface ApplyServiceMacosOptions extends PlanServiceMacosOptions {
  readonly allowMutation?: boolean;
}

export interface PlanServiceMacosRemovalOptions
  extends InspectServiceMacosOptions {
  readonly serviceId: string;
}

export interface RemoveServiceMacosOptions extends InspectServiceMacosOptions {
  readonly allowMutation?: boolean;
}

export interface RecoverServiceMacosOptions extends InspectServiceMacosOptions {
  readonly allowMutation?: boolean;
  readonly serviceId?: string;
}

export interface SelectedServiceMacosOptions
  extends InspectServiceMacosOptions {
  readonly serviceId: string;
}

export interface PlanSelectedServiceMacosOptions
  extends PlanServiceMacosOptions {
  readonly serviceId: string;
}

export interface MutateSelectedServiceMacosOptions
  extends PlanServiceMacosOptions {
  readonly allowMutation?: boolean;
}

export interface StopServiceMacosOptions extends InspectServiceMacosOptions {
  readonly allowMutation?: boolean;
}

export interface ReadServiceMacosLogsOptions
  extends SelectedServiceMacosOptions {
  readonly maxBytes?: number;
}

export interface ServiceValidators {
  readonly validateAgent: (
    path: string,
    options?: AgentLoadOptions,
  ) => Promise<AgentValidationResult>;
  readonly validateWeb: (
    path: string,
    options?: {
      readonly environment?: Readonly<Record<string, string | undefined>>;
    },
  ) => Promise<WebConfig>;
}
