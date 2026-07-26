// SPDX-License-Identifier: MIT
import {
  MODULE_API_VERSION,
  defineChannelModule,
  type Channel,
  type ChannelModuleCreateContext,
  type ChannelSendTool,
  type ModuleHealth,
} from "@mono-agent/module-sdk";

import { createSlackWebApiClient, type SlackApiClientFactory } from "./client.js";
import { type SlackConfig, slackConfigSchema } from "./config.js";
import { SlackDelivery } from "./delivery.js";
import {
  isSlackMessageTimestamp,
  parseSlackDestination,
  slackConversationId,
} from "./destination.js";
import { createSlackEventProcessor } from "./event-processor.js";
import { SlackInbox } from "./inbox.js";
import { createSlackSendTools } from "./send-tools.js";
import {
  createSlackSocketModeTransport,
  type SlackSocketEvent,
  type SlackSocketFailure,
  type SlackSocketTransportFactory,
} from "./socket.js";

const PACKAGE_NAME = "@mono-agent/channel-slack";
const PACKAGE_VERSION = "0.15.0";
const STOP_TIMEOUT_MS = 1_000;

export interface SlackChannel extends Channel {
  readonly running: boolean;
  readonly sendTools: readonly ChannelSendTool[];
}

export interface CreateSlackChannelOptions {
  readonly context: ChannelModuleCreateContext<SlackConfig>;
  readonly socketFactory?: SlackSocketTransportFactory;
  readonly clientFactory?: SlackApiClientFactory;
}

export const monoAgentModule = defineChannelModule({
  manifest: {
    packageName: PACKAGE_NAME,
    packageVersion: PACKAGE_VERSION,
    apiVersion: MODULE_API_VERSION,
    kind: "channel",
    responsibility: "Maps Slack Socket Mode interactions and Web API deliveries onto normalized channel turns.",
    capabilities: [],
  },
  schema: slackConfigSchema,
  create(context) {
    return createSlackChannel({ context });
  },
});

export function createSlackChannel(options: CreateSlackChannelOptions): SlackChannel {
  const { context } = options;
  const socketFactory = options.socketFactory
    ?? ((config: SlackConfig) => createSlackSocketModeTransport(config));
  const clientFactory = options.clientFactory
    ?? ((config: SlackConfig) => createSlackWebApiClient(config));
  const socket = socketFactory(context.config);
  const client = clientFactory(context.config);
  const delivery = new SlackDelivery(context.config, client);
  const sendTools = createSlackSendTools();
  let lifecycle: AbortController | undefined;
  let inbox: SlackInbox | undefined;
  let primaryWorker: Promise<void> | undefined;
  let controlWorker: Promise<void> | undefined;
  let primaryRequested = false;
  let controlRequested = false;
  let stopping = false;
  let running = false;
  let active = 0;
  let failureSummary: string | undefined;
  let schedulePrimary: () => void = () => undefined;
  let scheduleControl: () => void = () => undefined;
  let lastAdmissionOrder = 0;
  const admissionOrders = new Map<string, number>();
  const processor = createSlackEventProcessor({
    context,
    client,
    scheduleControl: () => scheduleControl(),
    currentAdmissionOrder: () => lastAdmissionOrder,
    admissionOrderFor: (envelopeId) => admissionOrders.get(envelopeId) ?? 0,
  });

  const destinationAuthorized = (channelId: string): boolean =>
    context.config.allowAllChannels
      || context.config.allowedChannelIds.includes(channelId);

  const authorized = (event: SlackSocketEvent): boolean => {
    if (!context.config.allowedTeamIds.includes(event.teamId)) return false;
    return event.kind === "message" || event.kind === "action"
      ? destinationAuthorized(event.channelId)
      : true;
  };

  const failClosed = (summary: string, abort = true): void => {
    if (failureSummary === undefined) {
      failureSummary = summary;
      context.logger.error(summary, { instanceId: context.instanceId });
    }
    running = false;
    if (abort) lifecycle?.abort(new Error(summary));
    void socket.stop().catch(() => undefined);
  };

  const failProcessing = async (
    currentInbox: SlackInbox,
    envelopeId: string,
  ): Promise<void> => {
    try {
      await currentInbox.fail(envelopeId);
    } catch {
      // The channel is failed closed either way.
    }
    failClosed("Slack durable inbox processing failed; operator recovery is required.");
  };

  const runPrimaryWorker = async (): Promise<void> => {
    const currentInbox = inbox;
    const signal = lifecycle?.signal;
    if (currentInbox === undefined || signal === undefined || signal.aborted) return;
    while (!signal.aborted) {
      const event = await currentInbox.claimNextPrimary(
        processor.isControlEligible,
        signal,
      );
      if (event === undefined) return;
      processor.forgetPrimaryOnly(event.envelopeId);
      active += 1;
      try {
        await processor.processPrimaryEvent(event, signal);
        await currentInbox.complete(event.envelopeId, signal);
        admissionOrders.delete(event.envelopeId);
      } catch {
        admissionOrders.delete(event.envelopeId);
        await failProcessing(currentInbox, event.envelopeId);
        return;
      } finally {
        active -= 1;
      }
      scheduleControl();
    }
  };

  const runControlWorker = async (): Promise<void> => {
    const currentInbox = inbox;
    const signal = lifecycle?.signal;
    if (currentInbox === undefined || signal === undefined || signal.aborted) return;
    const event = await currentInbox.claimNextControl(
      processor.isControlEligible,
      signal,
    );
    if (event === undefined) return;
    active += 1;
    let consumed = false;
    try {
      consumed = await processor.processControlEvent(event, signal);
      if (consumed) {
        await currentInbox.complete(event.envelopeId, signal);
        admissionOrders.delete(event.envelopeId);
      } else {
        processor.markPrimaryOnly(event.envelopeId);
        await currentInbox.release(event.envelopeId, signal);
      }
    } catch {
      admissionOrders.delete(event.envelopeId);
      await failProcessing(currentInbox, event.envelopeId);
      return;
    } finally {
      active -= 1;
    }
    if (consumed) scheduleControl();
    schedulePrimary();
  };

  schedulePrimary = (): void => {
    if (stopping || !running) return;
    if (primaryWorker !== undefined) {
      primaryRequested = true;
      return;
    }
    primaryWorker = runPrimaryWorker().catch(() => {
      failClosed("Slack durable inbox primary worker failed; operator recovery is required.");
    }).finally(() => {
      primaryWorker = undefined;
      if (primaryRequested) {
        primaryRequested = false;
        schedulePrimary();
      }
    });
  };

  scheduleControl = (): void => {
    if (stopping || !running) return;
    if (controlWorker !== undefined) {
      controlRequested = true;
      return;
    }
    controlWorker = runControlWorker().catch(() => {
      failClosed("Slack durable inbox control worker failed; operator recovery is required.");
    }).finally(() => {
      controlWorker = undefined;
      if (controlRequested) {
        controlRequested = false;
        scheduleControl();
      }
    });
  };

  const scheduleWorkers = (): void => {
    scheduleControl();
    schedulePrimary();
  };

  const admit = async (event: SlackSocketEvent): Promise<void> => {
    const signal = lifecycle?.signal;
    if (!running
      || stopping
      || signal === undefined
      || signal.aborted
      || inbox === undefined) {
      throw new Error("Slack channel is not accepting envelopes.");
    }
    if (!authorized(event)) return;
    try {
      const result = await inbox.enqueue(event, signal);
      if (result === "enqueued") {
        lastAdmissionOrder += 1;
        admissionOrders.set(event.envelopeId, lastAdmissionOrder);
        scheduleWorkers();
      }
    } catch (error) {
      failClosed("Slack durable inbox admission failed; the envelope was not acknowledged.");
      throw error;
    }
  };

  const transportFailed = (failure: SlackSocketFailure): void => {
    failClosed(failure.summary, false);
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    await Promise.race([
      socket.stop().catch(() => undefined),
      delay(STOP_TIMEOUT_MS),
    ]);
    await waitForWorkers(primaryWorker, controlWorker);
    lifecycle?.abort(new Error("Slack channel stopped."));
    await waitForWorkers(primaryWorker, controlWorker);
    await inbox?.close().catch(() => undefined);
    inbox = undefined;
    processor.clear();
    admissionOrders.clear();
    lastAdmissionOrder = 0;
    primaryRequested = false;
    controlRequested = false;
    running = false;
  };

  return {
    capabilities: Object.freeze({
      attachments: true,
      liveInput: context.host.offerLiveInput !== undefined,
      askUser: context.host.answerAsk !== undefined,
      approvals: false,
      proactive: true,
      runtimeControl: true,
      verbatim: false,
      cancellation: context.host.cancel !== undefined,
    }),
    sendTools,
    resolveDefaultDeliveryConversationId() {
      return context.config.defaultDestination === undefined
        ? undefined
        : slackConversationId(parseSlackDestination(
          context.config.defaultDestination,
          "Slack default destination",
        ));
    },
    resolveDeliveryHistory(message, result) {
      if (!message.conversationId.startsWith("slack:")) {
        throw new TypeError("Slack delivery history requires a Slack conversation.");
      }
      const destination = parseSlackDestination(
        message.conversationId.slice("slack:".length),
        "Slack delivery history",
      );
      if (result.status !== "delivered" && result.status !== "duplicate") {
        throw new TypeError("Slack delivery history requires confirmed delivery.");
      }
      return {
        conversationId: slackConversationId(destination.threadId === undefined
          ? isSlackMessageTimestamp(result.messageId)
            ? { channelId: destination.channelId, threadId: result.messageId }
            : { channelId: destination.channelId }
          : destination),
      };
    },
    get running() {
      return running;
    },
    async start(startContext) {
      if (running) return;
      if (inbox !== undefined
        || primaryWorker !== undefined
        || controlWorker !== undefined) {
        throw new Error("Slack channel must be stopped before restart.");
      }
      throwIfAborted(startContext.signal);
      lifecycle = new AbortController();
      stopping = false;
      failureSummary = undefined;
      try {
        inbox = await SlackInbox.open(context.dataDirectory, lifecycle.signal);
        if (stopping || lifecycle.signal.aborted) {
          throw new Error("Slack channel stopped while starting.");
        }
        const snapshot = inbox.snapshot();
        if (snapshot.blocked !== undefined) throw new Error(snapshot.blocked);
        running = true;
        await socket.start(admit, lifecycle.signal, transportFailed);
        scheduleWorkers();
      } catch (error) {
        running = false;
        failureSummary = "Slack channel startup failed closed.";
        lifecycle.abort(error);
        await socket.stop().catch(() => undefined);
        await inbox?.close().catch(() => undefined);
        throw error;
      }
    },
    async drain() {
      await stop();
    },
    async stop() {
      await stop();
    },
    async health(): Promise<ModuleHealth> {
      const snapshot = inbox?.snapshot();
      const deliveryDegraded = delivery.degraded;
      const receiptCapacityExhausted = delivery.receiptCapacityExhausted;
      const ambiguousOutcome = delivery.hasAmbiguousOutcome;
      return {
        status: failureSummary !== undefined
          ? "unhealthy"
          : deliveryDegraded
            ? "degraded"
            : running ? "healthy" : "unknown",
        checkedAt: new Date().toISOString(),
        ...(failureSummary !== undefined
          ? { summary: failureSummary }
          : deliveryDegraded
            ? {
                summary: receiptCapacityExhausted
                  ? "Slack delivery receipt capacity is exhausted."
                  : "Slack delivery has an unresolved ambiguous outcome.",
              }
            : {}),
        details: {
          activeEvents: active,
          pendingEvents: snapshot?.pending ?? 0,
          processingEvents: snapshot?.processing ?? 0,
          failedEvents: snapshot?.failed ?? 0,
          completedReceipts: snapshot?.completed ?? 0,
          transientActivityEntries: processor.transientActivityEntries,
          deliveryMode: "final-only",
          deliveryReceiptCapacityExhausted: receiptCapacityExhausted,
          deliveryAmbiguousOutcome: ambiguousOutcome,
        },
      };
    },
    deliver(message, signal) {
      return delivery.deliver(message, signal);
    },
  };
}

async function waitForWorkers(
  primary: Promise<void> | undefined,
  control: Promise<void> | undefined,
): Promise<void> {
  const workers = [primary, control].filter(
    (worker): worker is Promise<void> => worker !== undefined,
  );
  if (workers.length === 0) return;
  await Promise.race([
    Promise.all(workers.map(async (worker) => worker.catch(() => undefined))),
    delay(STOP_TIMEOUT_MS),
  ]);
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Slack channel start aborted.");
  }
}

export * from "./client.js";
export * from "./config.js";
export * from "./delivery.js";
export * from "./socket.js";
