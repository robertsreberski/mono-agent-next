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
import { createSlackInboxCommands } from "./inbox-commands.js";
import {
  acquireSlackInboxLease,
  type SlackInboxLease,
} from "./inbox-lease.js";
import { createSlackSendTools } from "./send-tools.js";
import {
  createSlackSocketModeTransport,
  type SlackSocketEvent,
  type SlackSocketFailure,
  type SlackSocketTransportFactory,
} from "./socket.js";

const PACKAGE_NAME = "@mono-agent/channel-slack";
const PACKAGE_VERSION = "0.15.0";
const DEFAULT_DRAIN_TIMEOUT_MS = 1_000;
const CANCELLATION_SETTLEMENT_MS = 1_000;

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
  let inboxLifecycle: AbortController | undefined;
  let inbox: SlackInbox | undefined;
  let inboxLease: SlackInboxLease | undefined;
  let primaryWorker: Promise<void> | undefined;
  let controlWorker: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let primaryRequested = false;
  let controlRequested = false;
  let maintenanceActive = false;
  let starting = false;
  let shuttingDown = false;
  let stopping = false;
  let running = false;
  let active = 0;
  let recoverySafe = true;
  let failureSummary: string | undefined;
  const shutdownAbortedEnvelopeIds = new Set<string>();
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
    recoverySafe = false;
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
    const inboxSignal = inboxLifecycle?.signal;
    if (currentInbox === undefined
      || signal === undefined
      || inboxSignal === undefined
      || signal.aborted
      || inboxSignal.aborted) return;
    while (!signal.aborted) {
      const event = await currentInbox.claimNextPrimary(
        processor.isControlEligible,
        inboxSignal,
      );
      if (event === undefined) return;
      processor.forgetPrimaryOnly(event.envelopeId);
      active += 1;
      try {
        await processor.processPrimaryEvent(event, signal);
        await currentInbox.complete(event.envelopeId, inboxSignal);
        admissionOrders.delete(event.envelopeId);
      } catch (error) {
        admissionOrders.delete(event.envelopeId);
        if (isOwnedShutdownAbort(error, signal)) {
          shutdownAbortedEnvelopeIds.add(event.envelopeId);
          return;
        }
        recoverySafe = false;
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
    const inboxSignal = inboxLifecycle?.signal;
    if (currentInbox === undefined
      || signal === undefined
      || inboxSignal === undefined
      || signal.aborted
      || inboxSignal.aborted) return;
    const event = await currentInbox.claimNextControl(
      processor.isControlEligible,
      inboxSignal,
    );
    if (event === undefined) return;
    active += 1;
    let consumed = false;
    try {
      consumed = await processor.processControlEvent(event, signal);
      if (consumed) {
        await currentInbox.complete(event.envelopeId, inboxSignal);
        admissionOrders.delete(event.envelopeId);
      } else {
        processor.markPrimaryOnly(event.envelopeId);
        await currentInbox.release(event.envelopeId, inboxSignal);
      }
    } catch (error) {
      admissionOrders.delete(event.envelopeId);
      if (isOwnedShutdownAbort(error, signal)) {
        shutdownAbortedEnvelopeIds.add(event.envelopeId);
        return;
      }
      recoverySafe = false;
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
    const inboxSignal = inboxLifecycle?.signal;
    if (!running
      || stopping
      || signal === undefined
      || inboxSignal === undefined
      || signal.aborted
      || inboxSignal.aborted
      || inbox === undefined) {
      throw new Error("Slack channel is not accepting envelopes.");
    }
    if (!authorized(event)) return;
    try {
      const result = await inbox.enqueue(event, inboxSignal);
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

  const withMaintenanceInbox = async <T>(
    signal: AbortSignal,
    operation: (maintenanceInbox: SlackInbox | undefined) => Promise<T> | T,
  ): Promise<T> => {
    if (
      maintenanceActive
      || starting
      || shuttingDown
      || running
      || inbox !== undefined
      || primaryWorker !== undefined
      || controlWorker !== undefined
    ) {
      throw new Error(
        "Slack inbox maintenance commands require a stopped channel instance.",
      );
    }
    throwIfAborted(signal);
    maintenanceActive = true;
    let probedInbox: SlackInbox | undefined;
    let maintenanceInbox: SlackInbox | undefined;
    let maintenanceLease: SlackInboxLease | undefined;
    try {
      probedInbox = await SlackInbox.openExisting(context.dataDirectory, signal);
      if (probedInbox === undefined) return await operation(undefined);
      const directory = probedInbox.directory;
      await probedInbox.close();
      probedInbox = undefined;
      maintenanceLease = await acquireSlackInboxLease(directory, signal);
      maintenanceInbox = await SlackInbox.openExisting(context.dataDirectory, signal);
      if (maintenanceInbox === undefined) {
        throw new Error("Slack durable inbox changed while entering maintenance.");
      }
      return await operation(maintenanceInbox);
    } finally {
      try {
        await probedInbox?.close();
      } finally {
        try {
          await maintenanceInbox?.close();
        } finally {
          try {
            await maintenanceLease?.release();
          } finally {
            maintenanceActive = false;
          }
        }
      }
    }
  };

  const commands = createSlackInboxCommands({ withInbox: withMaintenanceInbox });

  const clearShutdownState = (
    currentInbox: SlackInbox | undefined,
    currentLease: SlackInboxLease | undefined,
  ): void => {
    if (inbox === currentInbox) inbox = undefined;
    if (inboxLease === currentLease) inboxLease = undefined;
    processor.clear();
    admissionOrders.clear();
    shutdownAbortedEnvelopeIds.clear();
    lastAdmissionOrder = 0;
    primaryRequested = false;
    controlRequested = false;
    shuttingDown = false;
  };

  const closeShutdownResources = async (
    currentInbox: SlackInbox | undefined,
    currentLease: SlackInboxLease | undefined,
  ): Promise<unknown> => {
    let cleanupFailure: unknown;
    await currentInbox?.close().catch((error: unknown) => {
      cleanupFailure ??= error;
    });
    await currentLease?.release().catch((error: unknown) => {
      cleanupFailure ??= error;
    });
    clearShutdownState(currentInbox, currentLease);
    return cleanupFailure;
  };

  const finalizeRetainedShutdown = async (
    currentInbox: SlackInbox | undefined,
    currentLease: SlackInboxLease | undefined,
  ): Promise<void> => {
    try {
      const processingEvents = currentInbox?.snapshot().processing ?? 0;
      if (processingEvents > 0) {
        recoverySafe = false;
        context.logger.error(
          "Slack channel retained shutdown quiesced with ambiguous processing blocked for exact operator recovery.",
          { instanceId: context.instanceId, processingEvents },
        );
      }
    } catch {
      recoverySafe = false;
      context.logger.error(
        "Slack channel retained shutdown cleanup failed; durable processing remains blocked.",
        { instanceId: context.instanceId },
      );
    } finally {
      const cleanupFailure = await closeShutdownResources(
        currentInbox,
        currentLease,
      );
      if (cleanupFailure !== undefined) {
        context.logger.error(
          "Slack channel retained shutdown resources could not be closed cleanly.",
          { instanceId: context.instanceId },
        );
      }
    }
  };

  const shutdown = async (
    mode: "drain" | "stop",
    signal: AbortSignal,
    deadline?: string,
  ): Promise<void> => {
    shuttingDown = true;
    stopping = true;
    running = false;
    const currentInbox = inbox;
    const currentLease = inboxLease;
    const currentLifecycle = lifecycle;
    const currentPrimaryWorker = primaryWorker;
    const currentControlWorker = controlWorker;
    const hadWorkers = currentPrimaryWorker !== undefined
      || currentControlWorker !== undefined;
    const socketStopping = Promise.resolve()
      .then(async () => socket.stop())
      .catch(() => undefined);
    let shutdownFailure: unknown;
    let retainResources = false;
    let cleanupDeadline = deadline;
    try {
      let workersSettled = mode === "drain"
        ? await waitForWorkers(
            currentPrimaryWorker,
            currentControlWorker,
            deadline,
            signal,
          )
        : false;
      if (mode === "drain") {
        if (!workersSettled) {
          const processingEvents = currentInbox?.snapshot().processing ?? 0;
          if (processingEvents > 0) {
            context.logger.error(
              "Slack channel drain expired with durable inbox work still "
                + "processing; bounded cancellation must settle before restart recovery.",
              { instanceId: context.instanceId, processingEvents },
            );
          }
        }
      }
      const shutdownReason = new SlackChannelShutdownError(
        mode === "drain"
          ? "Slack channel drain grace ended."
          : "Slack channel stopped.",
      );
      currentLifecycle?.abort(shutdownReason);
      if (!workersSettled) {
        cleanupDeadline = new Date(
          Date.now() + CANCELLATION_SETTLEMENT_MS,
        ).toISOString();
        workersSettled = await waitForWorkers(
          currentPrimaryWorker,
          currentControlWorker,
          cleanupDeadline,
          signal,
        );
      }
      if (
        workersSettled
        && hadWorkers
        && recoverySafe
        && shutdownAbortedEnvelopeIds.size > 0
        && currentInbox !== undefined
      ) {
        await currentInbox.requeueProcessingForShutdown(
          [...shutdownAbortedEnvelopeIds],
        );
      }
      const processingEvents = currentInbox?.snapshot().processing ?? 0;
      if (!workersSettled || processingEvents > 0) {
        const summary = !workersSettled
          ? "Slack channel shutdown cancellation did not settle; durable processing remains blocked for exact operator recovery."
          : "Slack channel shutdown left ambiguous durable processing blocked for exact operator recovery.";
        context.logger.error(summary, {
          instanceId: context.instanceId,
          processingEvents,
        });
        failureSummary ??= summary;
        recoverySafe = false;
        shutdownFailure = new Error(summary);
        if (!workersSettled) {
          retainResources = true;
          void settleWorkers(
            currentPrimaryWorker,
            currentControlWorker,
          ).then(async () => finalizeRetainedShutdown(
            currentInbox,
            currentLease,
          )).catch(() => {
            context.logger.error(
              "Slack channel retained shutdown finalizer failed closed.",
              { instanceId: context.instanceId },
            );
          });
        }
      }
      await waitForPromise(
        socketStopping,
        drainTimeoutMs(cleanupDeadline),
        signal,
      );
    } catch (error) {
      shutdownFailure ??= error;
      recoverySafe = false;
      if (failureSummary === undefined) {
        failureSummary = "Slack durable inbox shutdown cleanup failed.";
        context.logger.error(failureSummary, { instanceId: context.instanceId });
      }
    } finally {
      if (retainResources) {
        shuttingDown = false;
      } else {
        shutdownFailure ??= await closeShutdownResources(
          currentInbox,
          currentLease,
        );
      }
    }
    if (shutdownFailure !== undefined) {
      if (failureSummary === undefined) {
        failureSummary = "Slack durable inbox shutdown cleanup failed.";
        context.logger.error(failureSummary, { instanceId: context.instanceId });
      }
      throw shutdownFailure;
    }
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
    commands,
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
      if (starting || shuttingDown) {
        throw new Error("Slack channel lifecycle transition is already in progress.");
      }
      if (running) return;
      if (inbox !== undefined
        || primaryWorker !== undefined
        || controlWorker !== undefined
        || maintenanceActive) {
        throw new Error("Slack channel must be stopped before restart.");
      }
      throwIfAborted(startContext.signal);
      starting = true;
      shutdownPromise = undefined;
      lifecycle = new AbortController();
      inboxLifecycle = new AbortController();
      const currentLifecycle = lifecycle;
      const currentInboxLifecycle = inboxLifecycle;
      currentLifecycle.signal.addEventListener("abort", () => {
        if (!isShutdownAbort(currentLifecycle.signal)) {
          currentInboxLifecycle.abort(currentLifecycle.signal.reason);
        }
      }, { once: true });
      stopping = false;
      recoverySafe = true;
      failureSummary = undefined;
      shutdownAbortedEnvelopeIds.clear();
      let openedInbox: SlackInbox | undefined;
      let acquiredLease: SlackInboxLease | undefined;
      try {
        openedInbox = await SlackInbox.open(
          context.dataDirectory,
          inboxLifecycle.signal,
        );
        inbox = openedInbox;
        if (stopping || lifecycle.signal.aborted) {
          throw new Error("Slack channel stopped while starting.");
        }
        acquiredLease = await acquireSlackInboxLease(
          openedInbox.directory,
          inboxLifecycle.signal,
        );
        inboxLease = acquiredLease;
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
        await openedInbox?.close().catch(() => undefined);
        await acquiredLease?.release().catch(() => undefined);
        if (inbox === openedInbox) inbox = undefined;
        if (inboxLease === acquiredLease) inboxLease = undefined;
        throw error;
      } finally {
        starting = false;
      }
    },
    async drain(drainContext) {
      shutdownPromise ??= shutdown(
        "drain",
        drainContext.signal,
        drainContext.deadline,
      );
      await shutdownPromise;
    },
    async stop(stopContext) {
      shutdownPromise ??= shutdown("stop", stopContext.signal);
      await shutdownPromise;
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
  deadline: string | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  const workers = [primary, control].filter(
    (worker): worker is Promise<void> => worker !== undefined,
  );
  if (workers.length === 0) return true;
  return await waitForPromise(
    settleWorkers(primary, control),
    drainTimeoutMs(deadline),
    signal,
  );
}

async function settleWorkers(
  primary: Promise<void> | undefined,
  control: Promise<void> | undefined,
): Promise<void> {
  const workers = [primary, control].filter(
    (worker): worker is Promise<void> => worker !== undefined,
  );
  await Promise.all(workers.map(async (worker) => worker.catch(() => undefined)));
}

async function waitForPromise(
  promise: Promise<unknown>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (timeoutMs === 0 || signal.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => { finish(false); };
    const timer = setTimeout(() => { finish(false); }, timeoutMs);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      () => { finish(true); },
      () => { finish(true); },
    );
  });
}

function drainTimeoutMs(deadline: string | undefined): number {
  if (deadline === undefined) return DEFAULT_DRAIN_TIMEOUT_MS;
  const parsed = Date.parse(deadline);
  return Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : 0;
}

class SlackChannelShutdownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackChannelShutdownError";
  }
}

function isShutdownAbort(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof SlackChannelShutdownError;
}

function isOwnedShutdownAbort(error: unknown, signal: AbortSignal): boolean {
  return isShutdownAbort(signal) && error === signal.reason;
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
