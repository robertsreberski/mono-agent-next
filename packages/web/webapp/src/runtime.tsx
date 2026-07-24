import {
  AssistantRuntimeProvider,
  type CompleteAttachment,
  type AppendMessage,
  type ExternalThreadQueueAdapter,
  type QuoteInfo,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type {
  OperatorActivity,
  OperatorJsonValue,
  OperatorToolResult,
} from "@mono-agent/operator";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

import { useConsole } from "./console";
import { InlineAttachmentAdapter, toWebAttachments } from "./inline-attachments";
import type { Message, Quote } from "./types";

type MessageContentPart = Exclude<ThreadMessageLike["content"], string>[number];
type JsonObject = { readonly [key: string]: OperatorJsonValue };

export interface FailedComposerDraft {
  readonly id: number;
  readonly threadId: string;
  readonly text: string;
  readonly attachments: readonly CompleteAttachment[];
  readonly quote?: QuoteInfo;
}

interface FailedDraftContextValue {
  readonly draft?: FailedComposerDraft;
  clear(draft: FailedComposerDraft): void;
}

interface AttachmentPreparationContextValue {
  readonly hasPending: boolean;
  readonly pendingVersion: number | undefined;
  abortPending(): Promise<void>;
}

const FailedDraftContext = createContext<FailedDraftContextValue>({
  clear: () => undefined,
});
const AttachmentPreparationContext =
  createContext<AttachmentPreparationContextValue | undefined>(undefined);

export function useFailedComposerDraft(): FailedDraftContextValue {
  return useContext(FailedDraftContext);
}

export function useAttachmentPreparation(): AttachmentPreparationContextValue {
  const value = useContext(AttachmentPreparationContext);
  if (value === undefined) {
    throw new Error("useAttachmentPreparation must be used inside WebRuntimeProvider.");
  }
  return value;
}

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
  const content = [
    ...(message.role === "assistant" ? convertOperatorActivities(message.activities ?? []) : []),
    ...(message.text.length > 0 ? [{ type: "text" as const, text: message.text }] : []),
  ];
  return {
    id: message.id,
    role: message.role,
    content,
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

/**
 * Promote durable operator activity into assistant-ui's native part model.
 * Calls own their matching result regardless of adjacency; unmatched results
 * remain visible as named data parts instead of being silently discarded.
 */
export function convertOperatorActivities(
  activities: readonly OperatorActivity[],
): readonly MessageContentPart[] {
  const results = new Map<string, OperatorToolResult>();
  for (const activity of activities) {
    if (activity.type === "tool_result") results.set(activity.result.callId, activity.result);
  }

  return activities.flatMap<MessageContentPart>((activity) => {
    switch (activity.type) {
      case "activity":
        return [{ type: "reasoning", text: activity.text }];
      case "compaction":
        return [{
          type: "data-operator-compaction",
          data: {
            compacted: activity.compaction.compacted,
            ...(activity.compaction.tokensBefore === undefined
              ? {}
              : { tokensBefore: activity.compaction.tokensBefore }),
            ...(activity.compaction.tokensAfter === undefined
              ? {}
              : { tokensAfter: activity.compaction.tokensAfter }),
            ...(activity.compaction.summaryTokens === undefined
              ? {}
              : { summaryTokens: activity.compaction.summaryTokens }),
          },
        }];
      case "tool_call": {
        const result = results.get(activity.call.id);
        return [{
          type: "tool-call",
          toolCallId: activity.call.id,
          toolName: activity.call.name,
          args: activity.call.inputOmitted
            ? { omitted: true, message: "Input omitted by policy" }
            : jsonObject(activity.call.input),
          argsText: activity.call.inputOmitted
            ? "{\"omitted\":true}"
            : jsonText(activity.call.input),
          ...(result === undefined ? {} : {
            result: toolResult(result),
            isError: result.isError === true,
          }),
        }];
      }
      case "tool_result":
        return activities.some(
          (candidate) =>
            candidate.type === "tool_call"
            && candidate.call.id === activity.result.callId,
        )
          ? []
          : [{
              type: "data-operator-result",
              data: toolResult(activity.result),
            }];
    }
  });
}

export function WebRuntimeProvider({ children }: { readonly children: ReactNode }) {
  const consoleState = useConsole();
  const [failedDrafts, setFailedDrafts] = useState<
    ReadonlyMap<string, readonly FailedComposerDraft[]>
  >(() => new Map());
  const nextDraftId = useRef(1);
  const attachmentAdapter = useMemo(
    () => new InlineAttachmentAdapter(consoleState.reportError),
    [consoleState.reportError],
  );
  const rememberFailedDraft = useCallback((
    threadId: string,
    text: string,
    attachments: readonly CompleteAttachment[],
    quote: QuoteInfo | undefined,
  ) => {
    const id = nextDraftId.current;
    nextDraftId.current += 1;
    setFailedDrafts((current) => {
      const next = new Map(current);
      const draft: FailedComposerDraft = {
        id,
        threadId,
        text,
        attachments,
        ...(quote === undefined ? {} : { quote }),
      };
      next.set(threadId, [...(current.get(threadId) ?? []), draft]);
      return next;
    });
  }, []);
  const onNew = useCallback(async (message: AppendMessage) => {
    const threadId = consoleState.selectedThreadId;
    if (threadId === undefined) {
      consoleState.reportError("Create a conversation first.");
      return;
    }
    const text = message.content
      .filter((part): part is Extract<(typeof message.content)[number], { readonly type: "text" }> =>
        part.type === "text"
      )
      .map((part) => part.text)
      .join("\n");
    const messageAttachments = message.attachments ?? [];
    const draftQuote = quoteInfo(message.metadata?.custom?.quote);
    try {
      const attachments = toWebAttachments(messageAttachments);
      const quote = resolveOperatorQuote(
        draftQuote,
        consoleState.detail?.messages ?? [],
        consoleState.selectedAgent?.capabilities.quotes === true,
      );
      if (!text.trim() && attachments.length === 0) return;
      const sent = await consoleState.send({
        text,
        ...(consoleState.runtime ? { runtime: consoleState.runtime } : {}),
        ...(consoleState.model ? { model: consoleState.model } : {}),
        ...(consoleState.effort ? { effort: consoleState.effort } : {}),
      }, attachments, quote);
      if (!sent) rememberFailedDraft(threadId, text, messageAttachments, draftQuote);
    } catch (cause) {
      consoleState.reportError(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : "Could not prepare the message.",
      );
      rememberFailedDraft(threadId, text, messageAttachments, draftQuote);
    }
  }, [consoleState, rememberFailedDraft]);
  const detailMatchesSelection =
    consoleState.detail !== undefined
    && consoleState.detail.thread.id === consoleState.selectedThreadId
    && consoleState.detail.thread.agentId === consoleState.selectedAgentId
    && consoleState.selectedThread !== undefined
    && consoleState.selectedThread.id === consoleState.selectedThreadId
    && consoleState.selectedThread.agentId === consoleState.selectedAgentId;
  const isRunning = consoleState.detail?.thread.status === "running";
  const canLiveInput = consoleState.selectedAgent?.capabilities.liveInput === true;
  const canCancel = consoleState.selectedAgent?.capabilities.cancellation === true;
  const queue = useMemo<ExternalThreadQueueAdapter | undefined>(() => (
    isRunning && canLiveInput
      ? {
          items: [],
          enqueue: (message) => { void onNew(message); },
          steer: () => undefined,
          remove: () => undefined,
          clear: () => undefined,
        }
      : undefined
  ), [canLiveInput, isRunning, onNew]);
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
    onSwitchToThread: async (threadId: string) => {
      await consoleState.selectThread(threadId);
    },
    onRename: consoleState.renameThread,
    onArchive: async (threadId: string) => { await consoleState.archiveThread(threadId, true); },
    onUnarchive: async (threadId: string) => { await consoleState.archiveThread(threadId, false); },
    onDelete: async (threadId: string) => { await consoleState.deleteThread(threadId); },
  }), [
    consoleState.archiveThread,
    consoleState.bootstrap?.threads,
    consoleState.createThread,
    consoleState.loading,
    consoleState.deleteThread,
    consoleState.renameThread,
    consoleState.selectThread,
    consoleState.selectedAgentId,
    consoleState.selectedThreadId,
  ]);
  const runtime = useExternalStoreRuntime<Message>({
    messages: detailMatchesSelection ? consoleState.detail?.messages ?? [] : [],
    convertMessage,
    isLoading: consoleState.loading || consoleState.refreshing || !detailMatchesSelection,
    isRunning: detailMatchesSelection && isRunning,
    isSendDisabled:
      !detailMatchesSelection
      || consoleState.submitting
      || consoleState.selectedThread === undefined
      || consoleState.selectedThread.archivedAt !== undefined
      || consoleState.selectedAgent?.online !== true
      || (isRunning && !canLiveInput),
    onNew,
    onCancel: canCancel ? consoleState.cancel : undefined,
    queue,
    unstable_capabilities: { copy: true },
    adapters: {
      threadList,
      ...(consoleState.selectedAgent?.capabilities.attachments === true
        ? { attachments: attachmentAdapter }
        : {}),
    },
  });
  const failedDraft = consoleState.selectedThreadId === undefined
    ? undefined
    : failedDrafts.get(consoleState.selectedThreadId)?.[0];
  const failedDraftContext = useMemo<FailedDraftContextValue>(() => ({
    ...(failedDraft === undefined ? {} : { draft: failedDraft }),
    clear: (draft) => {
      setFailedDrafts((current) => {
        const queue = current.get(draft.threadId);
        if (queue?.[0]?.id !== draft.id) return current;
        const next = new Map(current);
        if (queue.length === 1) next.delete(draft.threadId);
        else next.set(draft.threadId, queue.slice(1));
        return next;
      });
    },
  }), [failedDraft]);
  return (
    <AttachmentPreparationContext.Provider value={attachmentAdapter}>
      <AssistantRuntimeProvider runtime={runtime}>
        <FailedDraftContext.Provider value={failedDraftContext}>
          {children}
        </FailedDraftContext.Provider>
      </AssistantRuntimeProvider>
    </AttachmentPreparationContext.Provider>
  );
}

function jsonObject(value: OperatorJsonValue | undefined): JsonObject {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return value === undefined ? {} : { value };
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

function toolResult(result: OperatorToolResult): {
  readonly callId: string;
  readonly content?: readonly unknown[];
  readonly contentOmitted: boolean;
  readonly isError: boolean;
} {
  return {
    callId: result.callId,
    contentOmitted: result.contentOmitted,
    isError: result.isError === true,
    ...(result.contentOmitted || result.content === undefined
      ? {}
      : {
          content: result.content.map((part) =>
            part.type === "text" ? part.text : part.value
          ),
        }),
  };
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

function quoteInfo(value: unknown): QuoteInfo | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const quote = value as Partial<QuoteInfo>;
  return typeof quote.messageId === "string"
    && quote.messageId.length > 0
    && typeof quote.text === "string"
    && quote.text.trim().length > 0
    ? { messageId: quote.messageId, text: quote.text }
    : undefined;
}
