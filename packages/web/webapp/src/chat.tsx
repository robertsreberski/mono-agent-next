// SPDX-License-Identifier: MIT
import {
  ActionBarPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  type EmptyMessagePartProps,
  type QuoteMessagePartProps,
  SelectionToolbarPrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { useConsole, type ConsoleConnection } from "./console";
import { Icon } from "./components/Icon";
import { NotificationBell } from "./components/NotificationBell";
import {
  ComposerTriggerPopover,
  type ComposerTriggerCommand,
} from "./components/assistant-ui/ComposerTriggerPopover";
import { ContextDisplay } from "./components/assistant-ui/ContextDisplay";
import { ModelSelector } from "./components/assistant-ui/ModelSelector";
import {
  CompactionRow,
  OrphanResult,
  Reasoning,
  ToolCall,
} from "./components/assistant-ui/Reasoning";
import type { AskQuestion, Attachment, Message, Telemetry } from "./types";

function QuoteBlock({ text }: QuoteMessagePartProps) {
  return <blockquote className="message-quote">
      <Icon name="quote" size={14} />
      <span>{text}</span>
    </blockquote>;
}

function MarkdownText() {
  const consoleState = useConsole();
  const operatorMessageId = useAuiState(
    (state) => state.message.metadata.custom?.operatorMessageId,
  );
  const canQuote =
    consoleState.selectedAgent?.capabilities.quotes === true
    && typeof operatorMessageId === "string"
    && operatorMessageId.length > 0;
  return (
    <MarkdownTextPrimitive
      className="markdown"
      data-aui-quote-selectable={canQuote ? true : "false"}
    />
  );
}

function EmptyPart({ status }: EmptyMessagePartProps) {
  const role = useAuiState((state) => state.message.role);
  if (role !== "assistant" || status.type !== "running") return null;
  return <span className="thinking-indicator" role="status" aria-label="Agent is thinking"><i /><i /><i /></span>;
}

/**
 * Exported so a render test can drive the real map through assistant-ui.
 *
 * `tools` and `data` are lowercase because those are the keys the primitive
 * reads (`MessagePrimitiveParts.StandardComponents`). Capitalised `ToolCall` and
 * `Data` are accepted by the object literal but silently ignored at render, so
 * every tool call and data part resolved to nothing.
 */
export const parts = {
  Text: MarkdownText,
  Quote: QuoteBlock,
  Empty: EmptyPart,
  Reasoning,
  tools: { Fallback: ToolCall },
  data: {
    by_name: { "operator-compaction": CompactionRow, "operator-orphan-result": OrphanResult },
  },
} as const;

function Attachments() {
  const raw = useAuiState((state) => state.message.metadata.custom?.attachments);
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return (
    <ul className="message-attachments" aria-label="Attachments">
      {(raw as readonly Attachment[]).map((attachment) => (
        <li
          className="attachment-chip"
          key={attachment.id}
          aria-label={`${attachment.name}, ${attachmentMetadata(attachment)}`}
        >
          <span className="attachment-icon" aria-hidden="true">
            <Icon name={attachment.mediaType.startsWith("image/") ? "spark" : "attach"} size={14} />
          </span>
          {attachment.url === undefined ? (
            <span className="attachment-details">
              <span className="attachment-name" title={attachment.name}>{attachment.name}</span>
              <span className="attachment-meta">{attachmentMetadata(attachment)}</span>
            </span>
          ) : (
            <a
              className="attachment-link"
              href={attachment.url}
              download={attachment.name}
              rel="noreferrer"
            >
              <span className="attachment-details">
                <span className="attachment-name" title={attachment.name}>{attachment.name}</span>
                <span className="attachment-meta">{attachmentMetadata(attachment)}</span>
              </span>
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

export function attachmentMetadata(attachment: Attachment): string {
  const parts = [attachment.mediaType];
  if (attachment.sizeBytes !== undefined && Number.isFinite(attachment.sizeBytes)) {
    parts.push(formatFileSize(attachment.sizeBytes));
  }
  return parts.join(" · ");
}

function formatFileSize(sizeBytes: number): string {
  const bytes = Math.max(0, sizeBytes);
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) {
    return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0).replace(/\.0$/u, "")} KB`;
  }
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0).replace(/\.0$/u, "")} MB`;
}

function CopyAction() {
  const text = useAuiState((state) =>
    state.message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n\n")
  );
  return (
    <ActionBarPrimitive.Root className="message-actions" autohide="never">
      <button
        className="message-action"
        type="button"
        disabled={!text}
        onClick={() => void navigator.clipboard?.writeText(text)}
      >
        <Icon name="copy" size={13} />
        <span>Copy</span>
      </button>
    </ActionBarPrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="message message-user">
      <div className="message-user-content">
        <Attachments />
        <MessagePrimitive.Parts components={parts} />
      </div>
      <CopyAction />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="message message-assistant">
      <div className="assistant-mark" aria-hidden="true"><Icon name="spark" size={15} /></div>
      <div className="assistant-content">
        <Attachments />
        <MessagePrimitive.Parts components={parts} />
        <MessagePrimitive.Error>
          <div className="message-error" role="alert">The response ended with an error.</div>
        </MessagePrimitive.Error>
        <CopyAction />
      </div>
    </MessagePrimitive.Root>
  );
}

function SelectionToolbar() {
  return (
    <SelectionToolbarPrimitive.Root className="selection-toolbar">
      <SelectionToolbarPrimitive.Quote className="selection-toolbar-quote">
        <Icon name="quote" size={14} />
        Quote
      </SelectionToolbarPrimitive.Quote>
    </SelectionToolbarPrimitive.Root>
  );
}

function AskUser() {
  const consoleState = useConsole();
  const ask = consoleState.detail?.thread.pendingAsk;
  const [answers, setAnswers] = useState<Record<string, readonly string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  if (ask === undefined) return null;
  const valid = ask.questions.every((question) => (answers[question.id]?.length ?? 0) > 0);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setSubmitting(true);
    try {
      await consoleState.answerAsk(answers);
      setAnswers({});
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <form className="ask-user-card" onSubmit={(event) => void submit(event)}>
      <header><span>Input needed</span><small>{ask.questions.length} question{ask.questions.length === 1 ? "" : "s"}</small></header>
      {ask.questions.map((question) => (
        <AskQuestionField
          key={question.id}
          question={question}
          values={answers[question.id] ?? []}
          onChange={(values) => setAnswers((current) => ({ ...current, [question.id]: values }))}
        />
      ))}
      <button className="ask-user-submit" type="submit" disabled={!valid || submitting}>
        {submitting ? "Submitting…" : "Submit answer"}
      </button>
    </form>
  );
}

function AskQuestionField({
  question,
  values,
  onChange,
}: {
  readonly question: AskQuestion;
  readonly values: readonly string[];
  readonly onChange: (values: readonly string[]) => void;
}) {
  const custom = values.find((value) => !question.choices?.some((choice) => choice.value === value)) ?? "";
  return (
    <fieldset>
      <legend>{question.prompt}</legend>
      {question.choices?.map((choice) => {
        const checked = values.includes(choice.value);
        return (
          <label className={`ask-user-option${checked ? " is-selected" : ""}`} key={choice.value}>
            <input
              type={question.multiple ? "checkbox" : "radio"}
              name={question.id}
              checked={checked}
              onChange={() => onChange(
                question.multiple
                  ? checked ? values.filter((value) => value !== choice.value) : [...values, choice.value]
                  : [choice.value]
              )}
            />
            <span><strong>{choice.label}</strong>{choice.description && <small>{choice.description}</small>}</span>
          </label>
        );
      })}
      {question.allowFreeText && (
        <label className="ask-user-other">
          <span>Other</span>
          <textarea
            rows={2}
            value={custom}
            onChange={(event) => {
              const choices = values.filter((value) => question.choices?.some((choice) => choice.value === value));
              const value = event.target.value;
              onChange(value.trim()
                ? question.multiple ? [...choices, value] : [value]
                : choices);
            }}
          />
        </label>
      )}
    </fieldset>
  );
}

function Composer() {
  const consoleState = useConsole();
  const fileInput = useRef<HTMLInputElement>(null);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const canAttach =
    !isRunning
    && consoleState.selectedAgent?.capabilities.attachments === true;
  const commands = useMemo<readonly ComposerTriggerCommand[]>(() => [
    ...(!isRunning && consoleState.selectedAgent?.capabilities.runtimeOverrides === true
      ? [{
          id: "settings",
          label: "Run settings",
          description: "Choose the model and reasoning effort",
          icon: "settings" as const,
          execute: () => window.dispatchEvent(new Event(OPEN_RUN_SETTINGS_EVENT)),
        }]
      : []),
    ...(isRunning
      ? [{
          id: "stop",
          label: "Stop response",
          description: "Cancel the current agent run",
          icon: "stop" as const,
          execute: () => void consoleState.cancel(),
        }]
      : []),
    ...(
      !isRunning
      && consoleState.selectedAgent?.online === true
      && consoleState.pendingFiles.length === 0
        ? [{
            id: "new",
            label: "New conversation",
            description: "Start a clean conversation with this agent",
            icon: "spark" as const,
            execute: () => void consoleState.createThread(),
          }]
        : []
    ),
  ], [
    consoleState.cancel,
    consoleState.createThread,
    consoleState.pendingFiles.length,
    consoleState.selectedAgent,
    isRunning,
  ]);
  return (
    <div className="composer-shell">
      <AskUser />
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
        <ComposerPrimitive.Root className="composer-root">
          <ComposerTriggerPopover commands={commands} />
          <ComposerPrimitive.Quote className="composer-quote">
            <Icon name="quote" size={14} />
            <ComposerPrimitive.QuoteText className="composer-quote-text" />
            <ComposerPrimitive.QuoteDismiss
              className="composer-quote-dismiss"
              aria-label="Remove quote"
            >
              <Icon name="close" size={14} />
            </ComposerPrimitive.QuoteDismiss>
          </ComposerPrimitive.Quote>
          {consoleState.pendingFiles.length > 0 && (
            <ul className="composer-attachments">
              {consoleState.pendingFiles.map((file, index) => (
                <li className="attachment-chip" key={`${file.name}:${index}`}>
                  <span className="attachment-icon" aria-hidden="true">
                    <Icon name={file.type.startsWith("image/") ? "spark" : "attach"} size={14} />
                  </span>
                  <span className="attachment-details">
                    <span className="attachment-name" title={file.name}>{file.name}</span>
                    <span className="attachment-meta">
                      {attachmentMetadata({
                        id: `${file.name}:${index}`,
                        name: file.name,
                        mediaType: file.type || "application/octet-stream",
                        sizeBytes: file.size,
                      })}
                    </span>
                  </span>
                  <button
                    className="attachment-remove"
                    type="button"
                    onClick={() => consoleState.removeFile(index)}
                    aria-label={`Remove ${file.name}`}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ComposerPrimitive.Input
            id="composer-input"
            className="composer-input"
            placeholder={isRunning ? "Steer the active run…" : "Message the agent…"}
            rows={1}
            submitMode="enter"
            aria-label="Message"
          />
          <div className="composer-toolbar">
            <div className="composer-tools">
              {canAttach && (
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    hidden
                    onChange={(event) => {
                      if (event.target.files) consoleState.addFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    className="icon-button composer-tool"
                    onClick={() => fileInput.current?.click()}
                    title="Attach files"
                    aria-label="Attach files"
                  >
                    <Icon name="attach" size={17} />
                  </button>
                </>
              )}
              <span className="composer-hint">
                {isRunning ? "Enter to steer this run" : "Enter to send · / for commands"}
              </span>
            </div>
            <div className="composer-actions">
              <ComposerPrimitive.Send
                className="composer-send"
                aria-label={isRunning ? "Send live input" : "Send message"}
              >
                <Icon name="send" size={16} />
              </ComposerPrimitive.Send>
              {isRunning && (
                <ComposerPrimitive.Cancel className="composer-stop" aria-label="Stop response">
                  <Icon name="stop" size={14} />
                  <span>Stop</span>
                </ComposerPrimitive.Cancel>
              )}
            </div>
          </div>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    </div>
  );
}

export const OPEN_RUN_SETTINGS_EVENT = "mono-agent:run-settings";

export function currentAssistantContext(
  messages: readonly Message[] | undefined,
  running: boolean,
): {
  readonly pending: boolean;
  readonly telemetry?: Telemetry;
} {
  const latestAssistant = messages?.findLast((message) => message.role === "assistant");
  if (running && latestAssistant?.status !== "running") return { pending: true };
  return {
    pending:
      running
      && latestAssistant?.telemetry?.contextUsed === undefined,
    ...(latestAssistant?.telemetry === undefined
      ? {}
      : { telemetry: latestAssistant.telemetry }),
  };
}

function ModelControls() {
  const consoleState = useConsole();
  const rootRef = useRef<HTMLSpanElement>(null);
  const models = consoleState.selectedAgent?.models;
  const defaults = consoleState.selectedAgent?.defaults;
  const runtime = consoleState.runtime || defaults?.runtime;
  const modelId = consoleState.model || defaults?.model;
  const route = runtime === undefined || modelId === undefined
    ? undefined
    : { runtime, id: modelId };
  const selectedModel = route === undefined
    ? undefined
    : models?.find((model) => model.runtime === route.runtime && model.id === route.id);
  const canOverride =
    consoleState.selectedAgent?.capabilities.runtimeOverrides === true
    && models !== undefined;
  const detailMatches =
    consoleState.selectedThread !== undefined
    && consoleState.detail?.thread.id === consoleState.selectedThread.id
    && consoleState.detail.thread.agentId === consoleState.selectedThread.agentId;
  const running = (
    detailMatches
      ? consoleState.detail?.thread.status
      : consoleState.selectedThread?.status
  ) === "running";
  const context = currentAssistantContext(
    detailMatches ? consoleState.detail?.messages : undefined,
    running,
  );

  useEffect(() => {
    const open = () => {
      if (!canOverride || running) return;
      const trigger = rootRef.current?.querySelector<HTMLButtonElement>(
        'button[aria-label="Run settings"]',
      );
      if (trigger?.getAttribute("aria-expanded") !== "true") trigger?.click();
    };
    window.addEventListener(OPEN_RUN_SETTINGS_EVENT, open);
    return () => window.removeEventListener(OPEN_RUN_SETTINGS_EVENT, open);
  }, [canOverride, running]);

  return (
    <div className="model-controls" aria-label="Conversation controls">
      <ContextDisplay
        {...context}
        {...(selectedModel?.contextWindow === undefined
          ? {}
          : { modelContextWindow: selectedModel.contextWindow })}
      />
      {canOverride && (
        <span ref={rootRef} className="model-selector-wrap">
          <ModelSelector
            models={models}
            {...(route === undefined ? {} : { route })}
            effort={consoleState.effort}
            disabled={running}
            onRouteChange={(next) => {
              consoleState.setRuntime(next.runtime);
              consoleState.setModel(next.id);
              // Effort is advertised per route, so a level chosen for the
              // previous model must not survive the switch.
              consoleState.setEffort("");
            }}
            onEffortChange={consoleState.setEffort}
          />
        </span>
      )}
    </div>
  );
}

const RUN_LABELS: Readonly<Record<string, string>> = {
  idle: "Ready",
  running: "Working",
  complete: "Ready",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};

export const CONNECTION_NOTICE_DELAY_MS = 5_000;

/**
 * A brief reconnect is normal and not worth a banner, so only a connection
 * that stays down past the delay surfaces. Offline is immediate because the
 * browser already knows for certain.
 */
export function ConnectionBanner({ connection }: { readonly connection: ConsoleConnection }) {
  const [visible, setVisible] = useState(connection === "offline");

  useEffect(() => {
    if (connection === "live") {
      setVisible(false);
      return;
    }
    if (connection === "offline") {
      setVisible(true);
      return;
    }
    setVisible(false);
    const timer = window.setTimeout(() => setVisible(true), CONNECTION_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [connection]);

  if (!visible || connection === "live") return null;
  return (
    <div className="connection-banner" role="status">
      <span className="connection-pulse" />
      {connection === "offline"
        ? "You\u2019re offline. Existing conversations remain readable; you can send again after reconnecting."
        : "Live updates are reconnecting. The agent keeps working on the server."}
    </div>
  );
}

function ConversationTitle() {
  const consoleState = useConsole();
  const thread = consoleState.selectedThread;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(thread?.title ?? "New conversation");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitle(thread?.title ?? "New conversation");
    setEditing(false);
  }, [thread?.id, thread?.title]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (thread === undefined) return;
    const next = title.trim();
    if (!next) {
      setTitle(thread.title);
      return;
    }
    if (next !== thread.title) {
      void consoleState.renameThread(thread.id, next).catch(() => undefined);
    }
  };

  const triggerBadge = thread?.trigger === undefined ? null : (
    <span
      className="trigger-badge trigger-badge-header"
      aria-label={`${thread.trigger.kind} notification`}
    >
      {thread.trigger.kind}
    </span>
  );

  if (editing && thread !== undefined) {
    return (
      <div className="conversation-title-group">
        <input
          ref={inputRef}
          className="title-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setTitle(thread.title);
              setEditing(false);
            }
          }}
          maxLength={120}
          aria-label="Conversation title"
        />
        {triggerBadge}
      </div>
    );
  }

  return (
    <div className="conversation-title-group">
      <button
        type="button"
        className="conversation-title"
        onClick={() => { if (thread !== undefined) setEditing(true); }}
        disabled={thread === undefined}
        title={thread === undefined ? undefined : "Rename conversation"}
      >
        {thread?.title ?? "New conversation"}
      </button>
      {triggerBadge}
    </div>
  );
}

function EmptyConversation() {
  const consoleState = useConsole();
  return (
    <div className="chat-empty">
      <div className="empty-orbit" aria-hidden="true">
        <span />
        <Icon name="spark" size={22} />
      </div>
      <span className="eyebrow">{consoleState.selectedAgent?.label ?? "mono-agent"}</span>
      <h2>{consoleState.selectedThread === undefined ? "Start a new conversation" : "What should we work on?"}</h2>
      <p>
        {consoleState.selectedAgent === undefined
          ? "No agents have been discovered yet. Start an agent and it will appear here automatically."
          : "Messages, activity, tool calls, and files stay together in this conversation."}
      </p>
      {consoleState.selectedAgent !== undefined && consoleState.selectedThread === undefined && (
        <button
          type="button"
          className="primary-button"
          disabled={!consoleState.selectedAgent.online}
          onClick={() => void consoleState.createThread().catch(() => undefined)}
        >
          <Icon name="new" size={16} />
          New conversation
        </button>
      )}
    </div>
  );
}

export function Chat({
  onOpenAgents,
  onOpenThreads,
}: {
  readonly onOpenAgents: () => void;
  readonly onOpenThreads: () => void;
}) {
  const consoleState = useConsole();
  const thread = consoleState.selectedThread;
  const runStatus = RUN_LABELS[thread?.status ?? "idle"] ?? "Ready";
  const status = consoleState.selectedAgent?.online === false
    ? "Offline"
    : consoleState.connection === "offline"
      ? "Browser offline"
      : consoleState.connection === "reconnecting"
        ? "Reconnecting"
        : runStatus;
  const statusTone = status.toLowerCase().replace(/\s+/gu, "-");

  return (
    <main className="chat-panel">
      <header className="chat-header">
        <div className="mobile-navigation">
          <button type="button" className="icon-button" onClick={onOpenAgents} aria-label="Choose agent">
            <Icon name="agent" size={19} />
          </button>
          <button type="button" className="icon-button" onClick={onOpenThreads} aria-label="Open conversations">
            <Icon name="menu" size={19} />
          </button>
        </div>
        <div className="chat-title-block">
          <ConversationTitle />
          <span className={`chat-status is-${statusTone}`}>
            <i />
            {status}
          </span>
        </div>
        <div className="chat-header-actions">
          <ModelControls />
          <NotificationBell className="icon-button header-notifications" iconSize={17} />
          {thread !== undefined && (
            <button
              type="button"
              className="icon-button header-archive"
              aria-label={thread.archivedAt === undefined ? "Archive conversation" : "Restore conversation"}
              title={thread.archivedAt === undefined ? "Archive conversation" : "Restore conversation"}
              onClick={() => void consoleState
                .archiveThread(thread.id, thread.archivedAt === undefined)
                .catch(() => undefined)}
            >
              <Icon name={thread.archivedAt === undefined ? "archive" : "restore"} size={17} />
            </button>
          )}
          {thread?.archivedAt !== undefined && (
            <button
              type="button"
              className="icon-button header-delete"
              aria-label="Permanently delete conversation"
              title="Permanently delete conversation"
              onClick={() => {
                if (!window.confirm("Permanently delete this conversation and its attachments? This cannot be undone.")) return;
                void consoleState.deleteThread(thread.id).catch(() => undefined);
              }}
            >
              <Icon name="trash" size={17} />
            </button>
          )}
        </div>
      </header>
      <ConnectionBanner connection={consoleState.connection} />
      {consoleState.error !== undefined && consoleState.bootstrap !== undefined && (
        <div className="error-banner" role="alert">
          <span>{consoleState.error}</span>
          <button type="button" onClick={() => void consoleState.retry()}>Retry</button>
        </div>
      )}
      {thread === undefined ? (
        <EmptyConversation />
      ) : (
        <ThreadPrimitive.Root className="thread-root">
          <SelectionToolbar />
          <ThreadPrimitive.Viewport className="thread-viewport" autoScroll>
            <div className="message-column">
              <ThreadPrimitive.Empty><EmptyConversation /></ThreadPrimitive.Empty>
              <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
            </div>
            <ThreadPrimitive.ScrollToBottom className="scroll-bottom" aria-label="Scroll to latest message">
              <Icon name="arrow-down" size={16} />
            </ThreadPrimitive.ScrollToBottom>
            <ThreadPrimitive.ViewportFooter className="thread-footer">
              {thread.archivedAt === undefined ? (
                <Composer />
              ) : (
                <div className="archived-footer">
                  <span>This conversation is archived.</span>
                  <button
                    type="button"
                    onClick={() => void consoleState.archiveThread(thread.id, false).catch(() => undefined)}
                  >
                    Restore to continue
                  </button>
                </div>
              )}
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
          {consoleState.detail === undefined && (
            <div className="detail-loading" role="status" aria-label="Loading conversation">
              <span />
            </div>
          )}
        </ThreadPrimitive.Root>
      )}
    </main>
  );
}
