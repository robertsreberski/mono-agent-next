// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  MODULE_API_VERSION,
  defineChannelModule,
  type Channel,
  type ChannelInboundRequest,
  type ChannelModuleCreateContext,
  type ChannelReplyEvent,
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
import { MAX_WEBHOOK_ACTIVITY_BYTES } from "./limits.js";
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
const MAX_TRACKED_TOOL_CALLS = 256;
const MAX_TOOL_NAME_BYTES = MAX_WEBHOOK_ACTIVITY_BYTES
  - Buffer.byteLength(" completed.", "utf8");

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
  let stopping = false;
  const delivery = context.config.outbound === undefined ? undefined : new WebhookDelivery(context.config.outbound);
  const defaultDeliveryConversationId = context.config.outbound === undefined
    ? undefined
    : `webhook:outbound:sha256:${createHash("sha256").update(context.config.outbound.url, "utf8").digest("hex")}`;

  const submit: WebhookSubmit = async (request, reportActivity) => {
    let replyText = "";
    const toolNames = new Map<string, string>();
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
            if (event.text.length > 0) reportActivity?.(event.text);
            break;
          case "tool-call":
          case "tool-result":
            reportActivity?.(toolActivity(toolNames, event));
            break;
          case "attachment":
            break;
        }
      },
    };
    const inbound: ChannelInboundRequest = toChannelInboundRequest(context.instanceId, request);
    const result = await context.host.dispatch(inbound, reply);
    if (result.status === "cancelled") {
      throw new WebhookSubmissionError("cancelled");
    }
    if (result.status === "rejected") {
      if (result.diagnostics?.some(({ code }) => code === "request_conflict") === true) {
        throw new WebhookSubmissionError("idempotency_conflict");
      }
      throw new WebhookSubmissionError("rejected");
    }
    return { text: result.text ?? replyText };
  };

  const start = async (startContext: ModuleStartContext): Promise<void> => {
    if (stopping) {
      throw new Error("Webhook channel cannot be started after stop().");
    }
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
      if (stopping) {
        throw new Error("Webhook channel stopped while starting.");
      }
      transport = createWebhookChannel({
        config: context.config,
        submit,
        requestIdNamespace: context.instanceId,
        ...(routes === undefined ? {} : { routes }),
      });
      const startInfo = await transport.start();
      if (stopping) {
        await transport.stop();
        throw new Error("Webhook channel stopped while starting.");
      }
      info = startInfo;
      context.logger.info("Webhook channel listening.", {
        instanceId: context.instanceId,
        endpoint: info.invokeUrl,
        authRequired: info.authRequired,
      });
    })();
    return startPromise;
  };

  const stop = async (_stopContext: ModuleStopContext): Promise<void> => {
    stopping = true;
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
      stopping = true;
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

function toolActivity(
  toolNames: Map<string, string>,
  event: Extract<ChannelReplyEvent, { readonly type: "tool-call" | "tool-result" }>,
): string {
  if (event.type === "tool-call") {
    rememberToolName(toolNames, event.call.id, displayToolName(event.call.name));
    return formatToolActivity(toolNames.get(event.call.id) ?? "tool", "running");
  }
  const name = toolNames.get(event.result.callId);
  toolNames.delete(event.result.callId);
  return formatToolActivity(
    name ?? "Tool",
    event.result.isError === true ? "failed" : "completed",
  );
}

function rememberToolName(
  toolNames: Map<string, string>,
  callId: string,
  name: string,
): void {
  if (!toolNames.has(callId) && toolNames.size >= MAX_TRACKED_TOOL_CALLS) {
    const oldest = toolNames.keys().next().value as string | undefined;
    if (oldest !== undefined) toolNames.delete(oldest);
  }
  toolNames.set(callId, name);
}

function displayToolName(name: string): string {
  const normalized = name.replace(/[\s\u0000-\u001f\u007f]+/gu, " ").trim();
  return boundedToolName(
    normalized.length === 0 ? "tool" : normalized,
    MAX_TOOL_NAME_BYTES,
    false,
  );
}

function formatToolActivity(
  name: string,
  state: "running" | "completed" | "failed",
): string {
  const prefix = state === "running" ? "Running " : "";
  const suffix = state === "running" ? "…" : ` ${state}.`;
  const maximumNameBytes = MAX_WEBHOOK_ACTIVITY_BYTES
    - Buffer.byteLength(prefix, "utf8")
    - Buffer.byteLength(suffix, "utf8");
  return `${prefix}${boundedToolName(name, maximumNameBytes, state !== "running")}${suffix}`;
}

function boundedToolName(
  name: string,
  maximumBytes: number,
  markTruncation: boolean,
): string {
  if (Buffer.byteLength(name, "utf8") <= maximumBytes) return name;
  const marker = markTruncation ? "…" : "";
  const bytes = Buffer.from(name, "utf8");
  let end = maximumBytes - Buffer.byteLength(marker, "utf8");
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 0b10) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}${marker}`;
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
      triggerKind: "webhook",
      webhook: {
        ...(request.routeName === undefined ? {} : { route: request.routeName }),
        bodySha256: request.bodySha256,
        attempt: request.attempt,
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
export {
  MAX_WEBHOOK_ROUTES,
  MAX_WEBHOOK_ROUTE_BYTES,
  loadWebhookRoutesFromDirectory,
  parseWebhookNotify,
  parseWebhookRouteMarkdown,
  type WebhookRoute,
} from "./routes.js";
export * from "./server.js";
