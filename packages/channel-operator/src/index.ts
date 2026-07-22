import {
  MODULE_API_VERSION,
  defineChannelModule,
  provenanceAt,
  type Channel,
  type ChannelDeliveryResult,
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
  type OperatorIdentityGrant,
} from "./server.js";

const PACKAGE_NAME = "@mono-agent/channel-operator";
const PACKAGE_VERSION = "0.15.0";

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
    responsibility: "Serves one selected agent through the authenticated shared operator protocol.",
    capabilities: ["operator.identity.v1"],
  },
  schema: operatorChannelConfigSchema,
  create: createOperatorModuleChannel,
});

function createOperatorModuleChannel(
  context: ChannelModuleCreateContext<OperatorChannelConfig>,
): OperatorModuleChannel {
  const identity = context.host.getCapability<OperatorIdentityGrant>("operator.identity.v1");
  if (identity === undefined) throw new Error("channel-operator requires the declared operator.identity.v1 host grant.");
  const transport: OperatorChannel = createOperatorChannel({
    config: context.config,
    identity,
    dispatch: (request, reply) => context.host.dispatch(request, reply),
    host: context.host,
  });
  const capabilities = Object.freeze({
    attachments: true,
    liveInput: context.host.offerLiveInput !== undefined,
    askUser: context.host.answerAsk !== undefined,
    proactive: context.host.openConversation !== undefined,
    runtimeControl: true,
    verbatim: false,
    cancellation: true,
  });
  const deliveries = new Map<string, string>();
  const pendingDeliveries = new Map<string, Promise<ChannelDeliveryResult>>();

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
    capabilities,
    get endpoint(): string | undefined {
      return transport.endpoint;
    },
    get startInfo(): OperatorChannelStartInfo | undefined {
      return transport.startInfo;
    },
    readHostPresence() {
      const info = transport.startInfo;
      if (info === undefined) return undefined;
      const tokenEnvironment = provenanceAt(context.provenance, ["auth", "token"])?.environmentName;
      if (tokenEnvironment === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tokenEnvironment)) {
        throw new Error("Operator discovery requires auth.token environment provenance.");
      }
      return {
        operatorRegistry: {
          schema: "mono-agent.operator-registry-details.v1",
          agent: identity.agent,
          operator: { endpoint: info.endpoint, tokenEnvironment },
          process: { pid: identity.process.pid, startedAt: info.startedAt },
          capabilities: {
            attachments: capabilities.attachments,
            liveInput: capabilities.liveInput,
            askUser: capabilities.askUser,
            cancellation: capabilities.cancellation,
            quotes: false,
            runtimeOverrides: capabilities.runtimeControl,
            proactive: capabilities.proactive,
            configView: true,
            replay: true,
            health: true,
          },
        },
      };
    },
    start,
    async drain(): Promise<void> {
      await transport.stop();
    },
    stop,
    health,
    ...(context.host.openConversation === undefined ? {} : {
      deliver(message, signal): Promise<ChannelDeliveryResult> {
        const existing = deliveries.get(message.idempotencyKey);
        if (existing !== undefined) return Promise.resolve({ status: "duplicate", idempotencyKey: message.idempotencyKey, messageId: existing });
        if ((message.attachments?.length ?? 0) > 0) return Promise.resolve({ status: "failed", idempotencyKey: message.idempotencyKey, diagnostic: { code: "operator_proactive_attachments_unsupported", severity: "error", message: "Operator proactive attachment delivery is unsupported." } });
        if (message.text.length === 0) return Promise.resolve({ status: "failed", idempotencyKey: message.idempotencyKey, diagnostic: { code: "operator_proactive_empty", severity: "error", message: "Operator proactive delivery requires text." } });
        const active = pendingDeliveries.get(message.idempotencyKey);
        if (active !== undefined) return active;
        const execution = (async (): Promise<ChannelDeliveryResult> => {
          try {
            const opened = await context.host.openConversation!({ initialText: message.text, metadata: { ...(message.metadata ?? {}), source: "operator-proactive", idempotencyKey: message.idempotencyKey }, signal });
            deliveries.set(message.idempotencyKey, opened.conversationId);
            while (deliveries.size > 1_000) deliveries.delete(deliveries.keys().next().value as string);
            return { status: "delivered", idempotencyKey: message.idempotencyKey, messageId: opened.conversationId };
          } catch {
            return { status: "unknown", idempotencyKey: message.idempotencyKey, diagnostic: { code: "operator_proactive_unknown", severity: "error", message: "Operator proactive delivery outcome is unknown." } };
          }
        })().finally(() => pendingDeliveries.delete(message.idempotencyKey));
        pendingDeliveries.set(message.idempotencyKey, execution);
        return execution;
      },
    }),
  };
}

function throwIfAborted(signal: AbortSignal, message: string): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(message);
}

export * from "./config.js";
export * from "./server.js";
