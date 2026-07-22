import type { SandboxEffectiveState } from "@mono-agent/runtime-adapter";
import type { ConfiguredAgentSessionEvent, ConfiguredAgentSessionSnapshot } from "./configured-agent.js";

/** Outcome of applying a saved configuration to the running app. */
export type ConfigApplyResult =
  | { readonly kind: "applied"; readonly message: string; readonly transports: readonly string[] }
  | { readonly kind: "waiting_for_config"; readonly message: string; readonly transports: readonly string[] }
  | { readonly kind: "failed"; readonly message: string; readonly transports: readonly string[] };

export type TraceabilityStatus =
  | {
      readonly kind: "running";
      readonly sourceId: string;
      readonly registryDir: string;
      readonly artifactDir: string;
    }
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export type ExporterStatus =
  | {
      readonly kind: "configured";
      readonly endpoint: string;
      readonly includeSensitiveData: boolean;
      readonly lastWarning?: string;
      readonly lastError?: string;
    }
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export interface SandboxStatus extends SandboxEffectiveState {
  readonly detail: string;
  readonly warning?: string;
  readonly resolutionError?: string;
}

type SessionTraceState = "warm" | "cold";

/** Internal trace metadata retained by the controller between session events. */
export interface SessionTraceMetadata {
  readonly currentBucketId: string;
  readonly state: SessionTraceState;
  readonly event: ConfiguredAgentSessionEvent["kind"];
  readonly updatedAt: string;
  readonly snapshot?: readonly ConfiguredAgentSessionSnapshot[];
  readonly providerSessionId?: string;
  readonly createdAt?: number;
  readonly lastActivityAt?: number;
  readonly busy?: boolean;
  readonly reason?: string;
  readonly nextRolloverAt?: string;
}
