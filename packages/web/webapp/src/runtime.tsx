// SPDX-License-Identifier: MIT
import {
  AssistantRuntimeProvider,
  type AppendMessage,
  type ExternalThreadQueueAdapter,
  type QuoteInfo,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { type ReactNode, useCallback, useMemo } from "react";

import { useConsole } from "./console";
import type { Message, Quote } from "./types";

function status(message: Message): ThreadMessageLike["status"] {
  if (message.status === "running") return { type: "running" };
  if (message.status === "complete") return { type: "complete", reason: "stop" };
  if (message.status === "cancelled") return { type: "incomplete", reason: "cancelled" };
  if (message.status === "failed") {
    return { type: "incomplete", reason: "error", error: message.error?.message ?? "Agent run failed." };
  }
  return { type: "incomplete", reason: "other", error: "Agent run was interrupted." };
}

/**
 * Project operator activities onto assistant-ui's own part vocabulary so the
 * transcript is rendered by registered part components rather than a bespoke
 * feed read out of message metadata. A tool result is merged into the part its
 * call created, which is what assistant-ui expects and what lets a renderer
 * show one disclosure per invocation instead of two unrelated rows.
 */
type MessagePart = Exclude<ThreadMessageLike["content"], string>[number];
type ToolCallPart = Extract<MessagePart, { readonly type: "tool-call" }>;

function activityParts(message: Message): readonly MessagePart[] {
  const parts: MessagePart[] = [];
  const toolCallIndexById = new Map<string, number>();
  for (const activity of message.activities ?? []) {
    if (activity.type === "activity") {
      parts.push({ type: "reasoning", text: activity.text });
      continue;
    }
    if (activity.type === "tool_call") {
      const call: ToolCallPart = {
        type: "tool-call",
        toolCallId: activity.call.id,
        toolName: activity.call.name,
        args: (activity.call.inputOmitted
          ? {}
          : activity.call.input ?? {}) as NonNullable<ToolCallPart["args"]>,
        argsText: activity.call.inputOmitted ? "" : JSON.stringify(activity.call.input ?? {}),
      };
      toolCallIndexById.set(activity.call.id, parts.length);
      parts.push(call);
      continue;
    }
    if (activity.type === "tool_result") {
      const index = toolCallIndexById.get(activity.result.callId);
      const existing = index === undefined ? undefined : parts[index];
      if (index !== undefined && existing?.type === "tool-call") {
        parts[index] = {
          ...existing,
          result: activity.result,
          ...(activity.result.isError === undefined ? {} : { isError: activity.result.isError }),
        };
        continue;
      }
      // A result whose call never arrived still has to be visible rather than
      // dropped, so it renders as its own orphaned entry.
      parts.push({ type: "data", name: "operator-orphan-result", data: activity.result });
      continue;
    }
    parts.push({ type: "data", name: "operator-compaction", data: activity.compaction });
  }
  return parts;
}

export function convertMessage(message: Message): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: [
      ...(message.role === "assistant" ? activityParts(message) : []),
      { type: "text", text: message.text },
    ],
    createdAt: new Date(message.createdAt),
    ...(message.role === "assistant" ? { status: status(message) } : {}),
    metadata: {
      custom: {
        ...(message.quote?.text === undefined
          ? {}
          : { quote: { messageId: message.quote.messageId, text: message.quote.text } }),
        ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
        ...(message.activities === undefined ? {} : { activities: message.activities }),
        ...(message.telemetry === undefined ? {} : { telemetry: message.telemetry }),
        ...(message.error === undefined ? {} : { error: message.error }),
        ...(message.operatorMessageId === undefined
          ? {}
          : { operatorMessageId: message.operatorMessageId }),
      },
    },
  };
}

export function WebRuntimeProvider({ children }: { readonly children: ReactNode }) {
  const consoleState = useConsole();
  const onNew = useCallback(async (message: AppendMessage) => {
    const text = message.content
      .filter((part): part is Extract<(typeof message.content)[number], { readonly type: "text" }> =>
        part.type === "text"
      )
      .map((part) => part.text)
      .join("\n")
      .trim();
    const quote = resolveOperatorQuote(
      message.metadata?.custom?.quote,
      consoleState.detail?.messages ?? [],
      consoleState.selectedAgent?.capabilities.quotes === true,
    );
    if (!text && consoleState.pendingFiles.length === 0) return;
    await consoleState.send({
      text,
      ...(consoleState.runtime ? { runtime: consoleState.runtime } : {}),
      ...(consoleState.model ? { model: consoleState.model } : {}),
      ...(consoleState.effort ? { effort: consoleState.effort } : {}),
    }, quote);
  }, [consoleState]);
  const isRunning = consoleState.detail?.thread.status === "running";
  const queue = useMemo<ExternalThreadQueueAdapter | undefined>(() => (
    isRunning && consoleState.selectedAgent?.capabilities.liveInput === true
      ? {
          items: [],
          // `onNew` reaches `api.liveInput`, which rejects with 409
          // `live_input_unavailable` when the turn settles between the composer
          // accepting the steer and the request landing. Dropping the promise
          // turned that ordinary race into an unhandled rejection, and the
          // operator saw nothing at all.
          enqueue: (message) => {
            void onNew(message).catch((error: unknown) => {
              window.dispatchEvent(new CustomEvent("mono-agent:notice", {
                detail: {
                  message: error instanceof Error && error.message.trim()
                    ? error.message
                    : "Live input could not be delivered.",
                },
              }));
            });
          },
          steer: () => undefined,
          remove: () => undefined,
          clear: () => undefined,
        }
      : undefined
  ), [consoleState.selectedAgent?.capabilities.liveInput, isRunning, onNew]);
  const threadList = useMemo(() => ({
    threadId: consoleState.selectedThreadId,
    isLoading: consoleState.loading,
    threads: (consoleState.bootstrap?.threads ?? [])
      .filter((thread) =>
        thread.agentId === consoleState.selectedAgentId && thread.archivedAt === undefined
      )
      .map((thread) => ({
        id: thread.id,
        remoteId: thread.id,
        status: "regular" as const,
        title: thread.title,
      })),
    archivedThreads: (consoleState.bootstrap?.threads ?? [])
      .filter((thread) =>
        thread.agentId === consoleState.selectedAgentId && thread.archivedAt !== undefined
      )
      .map((thread) => ({
        id: thread.id,
        remoteId: thread.id,
        status: "archived" as const,
        title: thread.title,
      })),
    onSwitchToNewThread: consoleState.createThread,
    onSwitchToThread: async (threadId: string) => { consoleState.selectThread(threadId); },
    onRename: consoleState.renameThread,
    onArchive: async (threadId: string) => { await consoleState.archiveThread(threadId, true); },
    onUnarchive: async (threadId: string) => { await consoleState.archiveThread(threadId, false); },
  }), [
    consoleState.archiveThread,
    consoleState.bootstrap?.threads,
    consoleState.createThread,
    consoleState.loading,
    consoleState.renameThread,
    consoleState.selectThread,
    consoleState.selectedAgentId,
    consoleState.selectedThreadId,
  ]);
  const runtime = useExternalStoreRuntime<Message>({
    messages: consoleState.detail?.messages ?? [],
    convertMessage,
    isLoading: consoleState.loading || consoleState.refreshing,
    isRunning,
    isSendDisabled:
      consoleState.selectedThread === undefined
      || consoleState.selectedThread.archivedAt !== undefined
      || consoleState.selectedAgent?.online !== true,
    onNew,
    onCancel: consoleState.cancel,
    queue,
    unstable_capabilities: { copy: true },
    adapters: { threadList },
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

export function resolveOperatorQuote(
  value: unknown,
  messages: readonly Message[],
  enabled: boolean,
): Quote | undefined {
  if (!enabled) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const quote = value as Partial<QuoteInfo>;
  if (
    typeof quote.messageId !== "string"
    || !quote.messageId
    || typeof quote.text !== "string"
    || !quote.text.trim()
  ) {
    return undefined;
  }
  const source = messages.find((message) => message.id === quote.messageId);
  if (source?.operatorMessageId === undefined) return undefined;
  return {
    conversationId: "",
    messageId: source.operatorMessageId,
    text: source.text,
  };
}
