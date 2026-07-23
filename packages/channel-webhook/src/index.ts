import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  MODULE_API_VERSION,
  defineChannelModule,
  type Channel,
  type ChannelInboundRequest,
  type ChannelModuleCreateContext,
  type ChannelReplySink,
  type ModuleHealth,
  type ModuleHealthContext,
  type ModuleStartContext,
  type ModuleStopContext,
} from "@mono-agent/module-sdk";

import {
  webhookConfigSchema,
  type WebhookConfig,
} from "./config.js";
import {
  createWebhookChannel,
  type WebhookChannel,
  type WebhookChannelStartInfo,
  type WebhookInboundRequest,
  type WebhookSubmit,
  WebhookSubmissionError,
} from "./server.js";
import { WebhookDelivery } from "./delivery.js";
import { loadWebhookRoutesFromDirectory } from "./routes.js";

const PACKAGE_NAME = "@mono-agent/channel-webhook";
const PACKAGE_VERSION = "0.15.0";

export interface WebhookModuleChannel extends Channel {
  readonly endpoint: string | undefined;
  readonly startInfo: WebhookChannelStartInfo | undefined;
}

export const monoAgentModule = defineChannelModule({
  manifest: {
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    apiVersion: MODULE_API_VERSION,
    kind: "channel",
    responsibility: "Serves bounded authenticated webhook ingress and explicit proactive webhook delivery.",
    capabilities: [],
  },
  schema: webhookConfigSchema,
  create: createWebhookModuleChannel,
});

function createWebhookModuleChannel(
  context: ChannelModuleCreateContext<WebhookConfig>,
): WebhookModuleChannel {
  let transport: WebhookChannel | undefined;
  let info: WebhookChannelStartInfo | undefined;
  let startPromise: Promise<void> | undefined;
  const delivery = context.config.outbound === undefined ? undefined : new WebhookDelivery(context.config.outbound);
  const defaultDeliveryConversationId = context.config.outbound === undefined
    ? undefined
    : `webhook:outbound:sha256:${createHash("sha256").update(context.config.outbound.url, "utf8").digest("hex")}`;

  const submit: WebhookSubmit = async (request) => {
    let replyText = "";
    const reply: ChannelReplySink = {
      emit(event): void {
        switch (event.type) {
          case "text-delta":
            replyText += event.delta;
            break;
          case "text-replace":
            replyText = event.text;
            break;
          case "activity":
          case "attachment":
            break;
        }
      },
    };
    const inbound: ChannelInboundRequest = toChannelInboundRequest(context.instanceId, request);
    const result = await context.host.dispatch(inbound, reply);
    if (result.status !== "completed") {
      if (result.diagnostics?.some(({ code }) => code === "request_conflict") === true) {
        throw new WebhookSubmissionError("idempotency_conflict");
      }
      throw new Error("Webhook-dispatched turn did not complete.");
    }
    return { text: result.text ?? replyText };
  };

  const start = async (startContext: ModuleStartContext): Promise<void> => {
    if (startPromise !== undefined) {
      return startPromise;
    }
    startPromise = (async () => {
      throwIfAborted(startContext.signal);
      const routes = context.config.routesDirectory === undefined
        ? undefined
        : await loadWebhookRoutesFromDirectory(
          resolve(context.configDirectory, context.config.routesDirectory),
          context.config.defaultMode,
        );
      transport = createWebhookChannel({
        config: context.config,
        submit,
        requestIdNamespace: context.instanceId,
        ...(routes === undefined ? {} : { routes }),
      });
      info = await transport.start();
      context.logger.info("Webhook channel listening.", {
        instanceId: context.instanceId,
        endpoint: info.invokeUrl,
        authRequired: info.authRequired,
      });
    })();
    return startPromise;
  };

  const stop = async (_stopContext: ModuleStopContext): Promise<void> => {
    await transport?.stop();
    info = undefined;
  };

  const health = async (_healthContext: ModuleHealthContext): Promise<ModuleHealth> => {
    const channelHealth = transport?.health();
    const deliveryDegraded = delivery?.degraded ?? false;
    const deliveryReceiptCapacityExhausted = delivery?.receiptCapacityExhausted ?? false;
    const deliveryAmbiguousOutcome = delivery?.hasAmbiguousOutcome ?? false;
    const deliverySummary = deliveryReceiptCapacityExhausted
      ? "Webhook delivery receipt capacity is exhausted."
      : "Webhook delivery has an unresolved ambiguous outcome.";
    if (channelHealth === undefined) {
      return {
        status: deliveryDegraded ? "degraded" : "unknown",
        checkedAt: new Date().toISOString(),
        summary: deliveryDegraded
          ? deliverySummary
          : "Webhook channel has not started.",
        details: {
          deliveryReceiptCapacityExhausted,
          deliveryAmbiguousOutcome,
        },
      };
    }
    const status = deliveryDegraded
      ? "degraded"
      : channelHealth.status === "healthy"
      ? "healthy"
      : channelHealth.status === "degraded"
        ? "degraded"
        : "unknown";
    return {
      status,
      checkedAt: new Date().toISOString(),
      ...(channelHealth.message !== undefined
        ? { summary: channelHealth.message }
        : deliveryDegraded
          ? { summary: deliverySummary }
          : {}),
      details: {
        activeRequests: channelHealth.activeRequests,
        storedRequests: channelHealth.storedRequests,
        deliveryReceiptCapacityExhausted,
        deliveryAmbiguousOutcome,
        ...(info === undefined ? {} : { endpoint: info.invokeUrl }),
        ...(info === undefined ? {} : { routes: info.routes.length }),
      },
    };
  };

  return {
    capabilities: Object.freeze({
      attachments: false,
      liveInput: false,
      askUser: false,
      approvals: false,
      proactive: delivery !== undefined,
      runtimeControl: true,
      verbatim: false,
      cancellation: true,
    }),
    get endpoint(): string | undefined {
      return info?.invokeUrl;
    },
    get startInfo(): WebhookChannelStartInfo | undefined {
      return info;
    },
    start,
    async drain(): Promise<void> {
      await transport?.stop();
      info = undefined;
    },
    stop,
    health,
    ...(delivery === undefined
      ? {}
      : {
          resolveDefaultDeliveryConversationId: () => defaultDeliveryConversationId,
          resolveDeliveryHistory: (message) => ({
            conversationId: message.conversationId,
          }),
          deliver: (message, signal) => delivery.deliver(message, signal),
        }),
  };
}

function toChannelInboundRequest(
  instanceId: string,
  request: WebhookInboundRequest,
): ChannelInboundRequest {
  return {
    requestId: request.requestId,
    conversationId: request.conversationId,
    sender: {
      id: "webhook",
      displayName: instanceId,
    },
    text: request.text,
    attachments: [],
    receivedAt: request.receivedAt,
    ...(request.runtime === undefined ? {} : { runtime: request.runtime }),
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    ...(request.completionDelivery === undefined
      ? {}
      : { completionDelivery: request.completionDelivery }),
    signal: request.abortSignal,
    metadata: {
      ...(request.metadata ?? {}),
      webhook: {
        ...(request.routeName === undefined ? {} : { route: request.routeName }),
        bodySha256: request.bodySha256,
      },
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Webhook channel start was aborted.");
}

export * from "./config.js";
export * from "./delivery.js";
export * from "./routes.js";
export * from "./server.js";
