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

export function convertMessage(message: Message): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: [{ type: "text", text: message.text }],
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
    const quote = quoteFromMetadata(message.metadata?.custom?.quote);
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
          enqueue: (message) => { onNew(message); },
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

function quoteFromMetadata(value: unknown): Quote | undefined {
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
  return { conversationId: "", messageId: quote.messageId, text: quote.text };
}
