import { defineStateModule } from "@mono-agent/module-sdk/internal";

import {
  parseStateLocalConfig,
  resolveStateLocalConfig,
  stateLocalConfigSchema,
  type ResolvedStateLocalConfig,
  type ResolvedStateLocalRunsConfig,
  type StateLocalConfig,
  type StateLocalDiscoveryConfig,
  type StateLocalRunsConfig,
} from "./config.js";
import { StateLocalConfigError } from "./config.js";
import { StateLocalError, type StateLocalErrorCode } from "./errors.js";
import type {
  StatePresenceDescriptor,
  StatePresenceStatus,
  StatePresenceUpdate,
} from "./presence.js";
import {
  StateLocalStore,
  type StateLocalStoreHooks,
  type StateLocalStoreOpenOptions,
} from "./store.js";
import type {
  StateArtifactRef,
  StateDeleteArtifactRequest,
  StateListArtifactsRequest,
  StateListArtifactsResult,
  StatePutArtifactRequest,
  StateReadArtifactRequest,
} from "./artifacts.js";

export const monoAgentModule = defineStateModule({
  manifest: {
    packageName: "@mono-agent/state-local",
    packageVersion: "0.15.0",
    apiVersion: 1,
    kind: "state",
    responsibility: "Provides owner-private CAS state, durable transcript/run records, idempotency, and presence publication.",
    capabilities: [
      "state.local",
      "state.cas",
      "state.transactions",
      "state.scan",
      "state.presence",
      "state.artifacts",
    ],
  },
  schema: stateLocalConfigSchema,
  create: async (context) => StateLocalStore.open(
    resolveStateLocalConfig(context.config, context.configDirectory),
    {
      instanceId: context.instanceId,
      signal: context.signal,
    },
  ),
});

export default monoAgentModule;

export {
  parseStateLocalConfig,
  resolveStateLocalConfig,
  StateLocalConfigError,
  StateLocalError,
  StateLocalStore,
};
export type {
  ResolvedStateLocalConfig,
  ResolvedStateLocalRunsConfig,
  StateArtifactRef,
  StateDeleteArtifactRequest,
  StateListArtifactsRequest,
  StateListArtifactsResult,
  StateLocalConfig,
  StateLocalDiscoveryConfig,
  StateLocalRunsConfig,
  StateLocalErrorCode,
  StateLocalStoreHooks,
  StateLocalStoreOpenOptions,
  StatePresenceDescriptor,
  StatePresenceStatus,
  StatePresenceUpdate,
  StatePutArtifactRequest,
  StateReadArtifactRequest,
};
