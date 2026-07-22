import {
  MODULE_API_VERSION,
  defineChannelModule,
  type Channel,
  type ChannelModuleCreateContext,
  type ModuleHealth,
  type ModuleHealthContext,
  type ModuleStartContext,
  type ModuleStopContext,
} from "@mono-agent/module-sdk";

import {
  operatorChannelConfigSchema,
  type OperatorChannelConfig,
} from "./config.js";
import {
  createOperatorChannel,
  type OperatorChannel,
  type OperatorChannelStartInfo,
} from "./server.js";

const PACKAGE_NAME = "@mono-agent/channel-operator";
const PACKAGE_VERSION = "0.15.0";

const CHANNEL_CAPABILITIES = Object.freeze({
  attachments: false,
  liveInput: false,
  askUser: false,
  proactive: false,
  runtimeControl: true,
  verbatim: false,
});

export interface OperatorModuleChannel extends Channel {
  readonly endpoint: string | undefined;
  readonly startInfo: OperatorChannelStartInfo | undefined;
}

export const monoAgentModule = defineChannelModule({
  manifest: {
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    apiVersion: MODULE_API_VERSION,
    kind: "channel",
    responsibility: "Serves one agent over the authenticated shared operator protocol.",
    capabilities: [],
  },
  schema: operatorChannelConfigSchema,
  create: createOperatorModuleChannel,
});

function createOperatorModuleChannel(
  context: ChannelModuleCreateContext<OperatorChannelConfig>,
): OperatorModuleChannel {
  const transport: OperatorChannel = createOperatorChannel({
    config: context.config,
    instanceId: context.instanceId,
    dispatch: (request, reply) => context.host.dispatch(request, reply),
  });

  const start = async (startContext: ModuleStartContext): Promise<void> => {
    throwIfAborted(startContext.signal, "Operator channel start was aborted.");
    const info = await transport.start();
    context.logger.info("Operator channel listening.", {
      instanceId: context.instanceId,
      endpoint: info.endpoint,
      authRequired: true,
      protocol: info.protocol,
    });
  };

  const stop = async (_stopContext: ModuleStopContext): Promise<void> => {
    await transport.stop();
  };

  const health = async (_healthContext: ModuleHealthContext): Promise<ModuleHealth> => {
    const snapshot = transport.health();
    return {
      status: snapshot.status === "healthy"
        ? "healthy"
        : snapshot.status === "degraded"
          ? "degraded"
          : "unknown",
      checkedAt: new Date().toISOString(),
      ...(snapshot.message === undefined ? {} : { summary: snapshot.message }),
      details: {
        activeTurns: snapshot.activeTurns,
        ...(transport.endpoint === undefined ? {} : { endpoint: transport.endpoint }),
      },
    };
  };

  return {
    capabilities: CHANNEL_CAPABILITIES,
    get endpoint(): string | undefined {
      return transport.endpoint;
    },
    get startInfo(): OperatorChannelStartInfo | undefined {
      return transport.startInfo;
    },
    start,
    async drain(): Promise<void> {
      await transport.stop();
    },
    stop,
    health,
  };
}

function throwIfAborted(signal: AbortSignal, message: string): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(message);
}

export * from "./config.js";
export * from "./server.js";
