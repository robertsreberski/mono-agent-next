// SPDX-License-Identifier: MIT
import type {
  ChannelAttachment,
  ChannelInboundRequest,
  ChannelModuleCreateContext,
  ChannelReplyEvent,
  ChannelReplySink,
} from "@mono-agent/module-sdk";

import { SlackAskController } from "./ask.js";
import type { SlackApiClient } from "./client.js";
import type {
  SlackConfig,
  SlackConfiguredAction,
} from "./config.js";
import {
  MAX_SLACK_STATUS_TEXT_LENGTH,
  MAX_TOTAL_SLACK_ATTACHMENT_BYTES,
} from "./limits.js";
import {
  homeView,
  indicateActivity,
  rememberActivity,
  statusText,
} from "./presentation.js";
import {
  rememberRuntimeSelection,
  runtimeCommand,
  runtimeConfirmation,
  type SlackRuntimeSelection,
  updateRuntimeSelection,
} from "./runtime-control.js";
import type {
  SlackHomeActionEvent,
  SlackMessageEvent,
  SlackShortcutEvent,
  SlackSocketEvent,
} from "./socket.js";

const MAX_TRACKED_TOOL_CALLS = 256;
const MAX_TOOL_NAME_LENGTH = MAX_SLACK_STATUS_TEXT_LENGTH - " completed.".length;

export interface SlackEventProcessor {
  readonly transientActivityEntries: number;
  clear(): void;
  forgetPrimaryOnly(envelopeId: string): void;
  isControlEligible(event: SlackSocketEvent): boolean;
  markPrimaryOnly(envelopeId: string): void;
  processControlEvent(event: SlackSocketEvent, signal: AbortSignal): Promise<boolean>;
  processPrimaryEvent(event: SlackSocketEvent, signal: AbortSignal): Promise<void>;
}

interface CreateSlackEventProcessorOptions {
  readonly context: ChannelModuleCreateContext<SlackConfig>;
  readonly client: SlackApiClient;
  readonly scheduleControl: () => void;
  readonly currentAdmissionOrder: () => number;
  readonly admissionOrderFor: (envelopeId: string) => number;
}

export function createSlackEventProcessor(
  options: CreateSlackEventProcessorOptions,
): SlackEventProcessor {
  const {
    context,
    client,
    scheduleControl,
    currentAdmissionOrder,
    admissionOrderFor,
  } = options;
  const asks = new SlackAskController(
    context,
    client,
    scheduleControl,
    currentAdmissionOrder,
    admissionOrderFor,
  );
  const runtimeSelections = new Map<string, SlackRuntimeSelection>();
  const activityLedger = new Map<string, string[]>();
  const assistantStatusUnavailable = new Set<string>();
  const reacted = new Set<string>();
  const activePrimaryConversations = new Set<string>();
  const primaryOnlyEnvelopeIds = new Set<string>();

  const destinationAuthorized = (channelId: string): boolean =>
    context.config.allowAllChannels
      || context.config.allowedChannelIds.includes(channelId);

  const warnOutput = (operation: string): void => {
    context.logger.warn(`Slack ${operation} failed; channel processing continues.`, {
      instanceId: context.instanceId,
    });
  };

  const bestEffort = async (
    operation: string,
    task: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await task();
    } catch {
      warnOutput(operation);
    }
  };

  const warnMessage = async (
    event: SlackMessageEvent,
    signal: AbortSignal,
  ): Promise<void> => {
    if (client.addReaction === undefined) return;
    await bestEffort("warning reaction", async () =>
      client.addReaction!(event.channelId, event.messageId, "warning", signal));
  };

  const settleAskRenderFailure = async (
    conversationId: string,
    turn: AbortController,
    lifecycleSignal: AbortSignal,
    error: unknown,
  ): Promise<void> => {
    warnOutput("AskUser rendering");
    turn.abort(error instanceof Error ? error : new Error("Slack AskUser rendering failed."));
    if (context.host.cancel !== undefined && !lifecycleSignal.aborted) {
      await bestEffort("AskUser cancellation", async () => context.host.cancel!({
        conversationId,
        reason: "Slack could not render the AskUser interaction.",
        signal: lifecycleSignal,
      }));
    }
  };

  const processConfiguredAction = async (
    event: SlackShortcutEvent | SlackHomeActionEvent,
    configured: SlackConfiguredAction,
    lifecycleSignal: AbortSignal,
  ): Promise<void> => {
    const sourceChannelId = event.kind === "shortcut"
      ? event.sourceChannelId
      : undefined;
    const configuredDefault = context.config.defaultDestination?.split(":", 1)[0];
    const channelId = configured.channelId
      ?? sourceChannelId
      ?? configuredDefault
      ?? context.config.allowedChannelIds[0];
    if (channelId === undefined || !destinationAuthorized(channelId)) return;
    const sourceThreadId = event.kind === "shortcut"
      && configured.channelId === undefined
      && sourceChannelId === channelId
      ? event.sourceThreadId
      : undefined;
    let threadId = sourceThreadId;
    let messageId = event.kind === "shortcut" ? event.sourceMessageId : undefined;
    if (configured.ackText !== undefined) {
      try {
        const acknowledged = await client.postMessage({
          channelId,
          ...(sourceThreadId === undefined ? {} : { threadId: sourceThreadId }),
          text: configured.ackText,
          signal: lifecycleSignal,
        });
        messageId ??= acknowledged.messageId;
        if (configured.threadReply && threadId === undefined) {
          threadId = acknowledged.messageId;
        }
      } catch {
        warnOutput("configured action acknowledgement");
      }
    }
    const conversationTail = threadId ?? `action-${event.envelopeId}`;
    const conversationId = `slack:${channelId}:${conversationTail}`;
    const turn = new AbortController();
    const signal = AbortSignal.any([lifecycleSignal, turn.signal]);
    let replyText = "";
    let askDeliveryFailed = false;
    const toolNames = new Map<string, string>();
    const reply: ChannelReplySink = {
      async emit(replyEvent: ChannelReplyEvent): Promise<void> {
        if (replyEvent.type === "text-delta") replyText += replyEvent.delta;
        else if (replyEvent.type === "text-replace") replyText = replyEvent.text;
        else if (replyEvent.type === "activity"
          && threadId !== undefined
          && client.setAssistantStatus !== undefined) {
          await bestEffort("configured action activity", async () =>
            client.setAssistantStatus!(
              channelId,
              threadId!,
              statusText(replyEvent.text),
              signal,
            ));
        } else if (replyEvent.type === "tool-call" || replyEvent.type === "tool-result") {
          const activity = toolActivity(toolNames, replyEvent);
          if (threadId !== undefined && client.setAssistantStatus !== undefined) {
            await bestEffort("configured action tool activity", async () =>
              client.setAssistantStatus!(
                channelId,
                threadId!,
                statusText(activity),
                signal,
              ));
          }
        } else if (replyEvent.type === "attachment") {
          await bestEffort("configured action attachment delivery", async () =>
            client.postFile({
              channelId,
              ...(threadId === undefined ? {} : { threadId }),
              attachment: replyEvent.attachment,
              signal,
            }));
        } else if (replyEvent.type === "ask-user"
          && context.host.answerAsk !== undefined) {
          try {
            await asks.render(
              conversationId,
              channelId,
              threadId,
              replyEvent.ask,
              signal,
            );
          } catch (error) {
            askDeliveryFailed = true;
            await settleAskRenderFailure(
              conversationId,
              turn,
              lifecycleSignal,
              error,
            );
            throw error;
          }
        }
      },
    };
    activePrimaryConversations.add(conversationId);
    asks.retainConversation(conversationId);
    scheduleControl();
    let result;
    try {
      try {
        result = await context.host.dispatch({
          requestId: event.envelopeId,
          conversationId,
          messageId: messageId ?? event.envelopeId,
          sender: { id: event.userId },
          text: configured.prompt,
          attachments: [],
          receivedAt: event.receivedAt,
          signal,
          metadata: {
            channel: "slack",
            instanceId: context.instanceId,
            teamId: event.teamId,
            channelId,
            source: event.kind,
          },
        }, reply);
      } catch (error) {
        if (askDeliveryFailed) return;
        throw error;
      }
    } finally {
      activePrimaryConversations.delete(conversationId);
      asks.releaseConversation(conversationId);
    }
    if (askDeliveryFailed) return;
    const final = result.text ?? replyText;
    if (result.status === "completed" && final.length > 0) {
      await bestEffort("configured action final reply", async () =>
        client.postMessage({
          channelId,
          ...(threadId === undefined ? {} : { threadId }),
          text: final,
          signal,
        }));
    }
  };

  const handleCancel = async (
    event: SlackMessageEvent,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (event.text.trim() !== "/cancel" || context.host.cancel === undefined) {
      return false;
    }
    const conversationId = asks.conversationFor(event);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await context.host.cancel({
        conversationId,
        reason: "Slack user requested cancellation.",
        signal,
      });
      if (result.status !== "idle" || !activePrimaryConversations.has(conversationId)) {
        break;
      }
      await delay(10);
    }
    return true;
  };

  const offerLiveInput = async (
    event: SlackMessageEvent,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (context.host.offerLiveInput === undefined
      || event.text.length === 0
      || event.files.length > 0) {
      return false;
    }
    const offered = await context.host.offerLiveInput({
      conversationId: asks.conversationFor(event),
      id: event.envelopeId,
      text: event.text,
      receivedAt: event.receivedAt,
      signal,
    });
    return offered.status === "applied" || offered.status === "discarded";
  };

  const isControlEligible = (event: SlackSocketEvent): boolean => {
    if (event.kind === "action") return true;
    if (event.kind !== "message" || primaryOnlyEnvelopeIds.has(event.envelopeId)) {
      return false;
    }
    const conversationId = asks.conversationFor(event);
    if (event.text.trim() === "/cancel") {
      return activePrimaryConversations.has(conversationId)
        && context.host.cancel !== undefined;
    }
    if (asks.hasFreeTextAnswer(event)) return true;
    if (!activePrimaryConversations.has(conversationId)) return false;
    return context.host.offerLiveInput !== undefined
      && event.files.length === 0
      && event.text.length > 0
      && runtimeCommand(event.text) === undefined
      && !/^\/help\s*$/u.test(event.text.trim());
  };

  const processControlEvent = async (
    event: SlackSocketEvent,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (event.kind === "action") {
      await asks.answerAction(event, signal);
      return true;
    }
    if (event.kind !== "message") return false;
    if (await handleCancel(event, signal)) return true;
    if (await asks.answerFreeText(event, signal)) return true;
    return offerLiveInput(event, signal);
  };

  const downloadAttachments = async (
    event: SlackMessageEvent,
    signal: AbortSignal,
  ): Promise<readonly ChannelAttachment[] | undefined> => {
    const knownTotal = event.files.reduce(
      (total, file) => total + (file.sizeBytes ?? 0),
      0,
    );
    if (knownTotal > MAX_TOTAL_SLACK_ATTACHMENT_BYTES) {
      warnOutput("inbound attachment admission");
      await warnMessage(event, signal);
      return undefined;
    }
    const attachments: ChannelAttachment[] = [];
    let remaining = MAX_TOTAL_SLACK_ATTACHMENT_BYTES;
    try {
      for (const file of event.files) {
        const attachment = await client.download(
          file,
          Math.min(context.config.maxAttachmentBytes, remaining),
          signal,
        );
        if (attachment.data.byteLength > remaining) {
          throw new Error("Slack inbound attachments exceed their aggregate byte limit.");
        }
        remaining -= attachment.data.byteLength;
        attachments.push(attachment);
      }
    } catch {
      warnOutput("inbound attachment download");
      await warnMessage(event, signal);
      return undefined;
    }
    return attachments;
  };

  const processMessage = async (
    event: SlackMessageEvent,
    lifecycleSignal: AbortSignal,
  ): Promise<void> => {
    const conversationId = messageConversationId(event);
    await indicateActivity(
      client,
      assistantStatusUnavailable,
      reacted,
      conversationId,
      event,
      "is thinking…",
      lifecycleSignal,
      warnOutput,
    );
    if (await handleCancel(event, lifecycleSignal)) return;
    if (await asks.answerFreeText(event, lifecycleSignal)) return;
    const command = runtimeCommand(event.text);
    if (command !== undefined) {
      const selection = updateRuntimeSelection(
        runtimeSelections.get(conversationId),
        command,
      );
      rememberRuntimeSelection(runtimeSelections, conversationId, selection);
      await bestEffort("runtime confirmation", async () =>
        client.postMessage({
          channelId: event.channelId,
          threadId: event.threadId,
          text: runtimeConfirmation(command, selection),
          signal: lifecycleSignal,
        }));
      return;
    }
    if (/^\/help\s*$/u.test(event.text.trim())) {
      await bestEffort("help reply", async () =>
        client.postMessage({
          channelId: event.channelId,
          threadId: event.threadId,
          text: "Commands: /model <id|default>, /effort <level|default>, /cancel, /help",
          signal: lifecycleSignal,
        }));
      return;
    }
    if (await offerLiveInput(event, lifecycleSignal)) return;
    const attachments = await downloadAttachments(event, lifecycleSignal);
    if (attachments === undefined) return;
    const turn = new AbortController();
    const signal = AbortSignal.any([lifecycleSignal, turn.signal]);
    let replyText = "";
    let askDeliveryFailed = false;
    const toolNames = new Map<string, string>();
    const reply: ChannelReplySink = {
      async emit(replyEvent: ChannelReplyEvent): Promise<void> {
        if (replyEvent.type === "text-delta") replyText += replyEvent.delta;
        else if (replyEvent.type === "text-replace") replyText = replyEvent.text;
        else if (replyEvent.type === "activity" && replyEvent.text.length > 0) {
          rememberActivity(activityLedger, conversationId, replyEvent.text);
          await indicateActivity(
            client,
            assistantStatusUnavailable,
            reacted,
            conversationId,
            event,
            statusText(replyEvent.text),
            signal,
            warnOutput,
          );
        } else if (replyEvent.type === "tool-call" || replyEvent.type === "tool-result") {
          const activity = toolActivity(toolNames, replyEvent);
          rememberActivity(activityLedger, conversationId, activity);
          await indicateActivity(
            client,
            assistantStatusUnavailable,
            reacted,
            conversationId,
            event,
            statusText(activity),
            signal,
            warnOutput,
          );
        } else if (replyEvent.type === "attachment") {
          await bestEffort("reply attachment delivery", async () =>
            client.postFile({
              channelId: event.channelId,
              threadId: event.threadId,
              attachment: replyEvent.attachment,
              signal,
            }));
        } else if (replyEvent.type === "ask-user"
          && context.host.answerAsk !== undefined) {
          try {
            await asks.render(
              conversationId,
              event.channelId,
              event.threadId,
              replyEvent.ask,
              signal,
            );
          } catch (error) {
            askDeliveryFailed = true;
            await settleAskRenderFailure(
              conversationId,
              turn,
              lifecycleSignal,
              error,
            );
            throw error;
          }
        }
      },
    };
    activePrimaryConversations.add(conversationId);
    scheduleControl();
    let result;
    try {
      try {
        result = await context.host.dispatch(inbound(
          context.instanceId,
          event,
          attachments,
          runtimeSelections.get(conversationId),
          signal,
        ), reply);
      } catch (error) {
        if (askDeliveryFailed) return;
        throw error;
      }
      if (askDeliveryFailed) return;
      const final = result.text ?? replyText;
      if (result.status === "completed" && final.length > 0) {
        await bestEffort("final reply", async () =>
          client.postMessage({
            channelId: event.channelId,
            threadId: event.threadId,
            text: final,
            signal,
          }));
      } else if (result.status === "rejected") {
        await warnMessage(event, signal);
      }
    } finally {
      activePrimaryConversations.delete(conversationId);
      activityLedger.delete(conversationId);
      reacted.delete(conversationId);
    }
  };

  const processPrimaryEvent = async (
    event: SlackSocketEvent,
    signal: AbortSignal,
  ): Promise<void> => {
    if (event.kind === "home-opened") {
      if (context.config.homeTab.enabled && client.publishHome !== undefined) {
        await bestEffort("App Home publishing", async () =>
          client.publishHome!(event.userId, homeView(context.config), signal));
      }
      return;
    }
    if (event.kind === "shortcut") {
      const configured = context.config.shortcuts.find(
        (candidate) => candidate.callbackId === event.callbackId,
      );
      if (configured !== undefined) {
        await processConfiguredAction(event, configured, signal);
      }
      return;
    }
    if (event.kind === "home-action") {
      const configured = context.config.homeTab.buttons.find(
        (candidate) => candidate.actionId === event.actionId,
      );
      if (context.config.homeTab.enabled && configured !== undefined) {
        await processConfiguredAction(event, configured, signal);
      }
      return;
    }
    if (event.kind === "message") await processMessage(event, signal);
  };

  return {
    get transientActivityEntries() {
      return [...activityLedger.values()].reduce(
        (total, entries) => total + entries.length,
        0,
      );
    },
    clear() {
      asks.clearAll();
      runtimeSelections.clear();
      activityLedger.clear();
      assistantStatusUnavailable.clear();
      reacted.clear();
      activePrimaryConversations.clear();
      primaryOnlyEnvelopeIds.clear();
    },
    forgetPrimaryOnly(envelopeId) {
      primaryOnlyEnvelopeIds.delete(envelopeId);
    },
    isControlEligible,
    markPrimaryOnly(envelopeId) {
      primaryOnlyEnvelopeIds.add(envelopeId);
    },
    processControlEvent,
    processPrimaryEvent,
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
    MAX_TOOL_NAME_LENGTH,
    false,
  );
}

function formatToolActivity(
  name: string,
  state: "running" | "completed" | "failed",
): string {
  const prefix = state === "running" ? "Running " : "";
  const suffix = state === "running" ? "…" : ` ${state}.`;
  const maximumNameLength = MAX_SLACK_STATUS_TEXT_LENGTH - prefix.length - suffix.length;
  return `${prefix}${boundedToolName(name, maximumNameLength, state !== "running")}${suffix}`;
}

function boundedToolName(
  name: string,
  maximumLength: number,
  markTruncation: boolean,
): string {
  if (name.length <= maximumLength) return name;
  const marker = markTruncation ? "…" : "";
  let end = maximumLength - marker.length;
  if (end > 0 && isHighSurrogate(name.charCodeAt(end - 1)) && isLowSurrogate(name.charCodeAt(end))) {
    end -= 1;
  }
  return `${name.slice(0, end)}${marker}`;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function inbound(
  instanceId: string,
  event: SlackMessageEvent,
  attachments: readonly ChannelAttachment[],
  selection: SlackRuntimeSelection | undefined,
  signal: AbortSignal,
): ChannelInboundRequest {
  return {
    requestId: event.envelopeId,
    conversationId: messageConversationId(event),
    messageId: event.messageId,
    sender: { id: event.userId },
    text: event.text,
    attachments,
    receivedAt: event.receivedAt,
    ...(selection?.model === undefined ? {} : { model: selection.model }),
    ...(selection?.effort === undefined ? {} : { effort: selection.effort }),
    signal,
    metadata: {
      channel: "slack",
      instanceId,
      teamId: event.teamId,
      channelId: event.channelId,
      threadId: event.threadId,
    },
  };
}

function messageConversationId(event: SlackMessageEvent): string {
  return `slack:${event.channelId}:${event.threadId}`;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
