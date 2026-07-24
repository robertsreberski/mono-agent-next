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
import type { OperatorActivity } from "@mono-agent/operator";

import { useConsole, type ConsoleConnection } from "./console";
import { Icon } from "./components/Icon";
import type { AskQuestion, Attachment, Telemetry } from "./types";

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

const parts = { Text: MarkdownText, Quote: QuoteBlock, Empty: EmptyPart } as const;

function Attachments() {
  const raw = useAuiState((state) => state.message.metadata.custom?.attachments);
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return (
    <ul className="message-attachments" aria-label="Attachments">
      {(raw as readonly Attachment[]).map((attachment) => (
        <li className="attachment-chip" key={attachment.id}>
          <span className="attachment-icon" aria-hidden="true">
            <Icon name={attachment.mediaType.startsWith("image/") ? "spark" : "attach"} size={14} />
          </span>
          {attachment.url === undefined ? (
            <span className="attachment-name" title={attachment.name}>{attachment.name}</span>
          ) : (
            <a
              className="attachment-link"
              href={attachment.url}
              download={attachment.name}
              rel="noreferrer"
            >
              <span className="attachment-name" title={attachment.name}>{attachment.name}</span>
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

function TelemetryBadge() {
  const raw = useAuiState((state) => state.message.metadata.custom?.telemetry);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const telemetry = raw as Telemetry;
  return (
    <span className="telemetry" title="Token usage">
      {telemetry.inputTokens.toLocaleString()} in · {telemetry.outputTokens.toLocaleString()} out
      {telemetry.compacted ? " · compacted" : ""}
      {telemetry.sessionEvicted ? " · session renewed" : ""}
    </span>
  );
}

function ActivityFeed() {
  const raw = useAuiState((state) => state.message.metadata.custom?.activities);
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return (
    <div className="activity-list" aria-label="Agent activity">
      {(raw as readonly OperatorActivity[]).map((activity, index) => {
        if (activity.type === "activity") {
          return <div className="activity-line" key={`${activity.type}:${index}`}><i />{activity.text}</div>;
        }
        if (activity.type === "compaction") {
          const { compaction } = activity;
          const tokens = compaction.tokensBefore === undefined
            ? ""
            : compaction.tokensAfter === undefined
              ? ` · ${compactCount(compaction.tokensBefore)} tokens before`
              : ` · ${compactCount(compaction.tokensBefore)} → ${compactCount(compaction.tokensAfter)} tokens`;
          return (
            <div className="context-compaction-row" key={`${activity.type}:${index}`}>
              <i className="context-compaction-status" />{compaction.compacted ? "Context compacted" : "Context compaction skipped"}{tokens}
            </div>
          );
        }
        if (activity.type === "tool_call") {
          return (
            <details className="tool-call" key={`${activity.type}:${activity.call.id}:${index}`}>
              <summary>
                <i className="tool-status" />
                <span className="tool-name">{activity.call.name}</span>
                <span className="tool-state">tool call</span>
                <Icon name="chevron" size={13} />
              </summary>
              <div className="tool-payload">
                <span>Input</span>
                <pre>{activity.call.inputOmitted ? "Input omitted by policy" : safeJson(activity.call.input)}</pre>
              </div>
            </details>
          );
        }
        return (
          <details
            className={`tool-call${activity.result.isError ? " is-error" : ""}`}
            key={`${activity.type}:${activity.result.callId}:${index}`}
          >
            <summary>
              <i className="tool-status" />
              <span className="tool-name">Tool result</span>
              <span className="tool-state">{activity.result.isError ? "failed" : "complete"}</span>
              <Icon name="chevron" size={13} />
            </summary>
            <div className="tool-payload">
              <span>Output</span>
              <pre>
                {activity.result.contentOmitted
                  ? "Output omitted by policy"
                  : activity.result.content?.map((part) =>
                      part.type === "text" ? part.text : safeJson(part.value)
                    ).join("\n\n") ?? "No output"}
              </pre>
            </div>
          </details>
        );
      })}
    </div>
  );
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
        <ActivityFeed />
        <MessagePrimitive.Parts components={parts} />
        <MessagePrimitive.Error>
          <div className="message-error" role="alert">The response ended with an error.</div>
        </MessagePrimitive.Error>
        <TelemetryBadge />
        <CopyAction />
      </div>
    </MessagePrimitive.Root>
  );
}

function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return String(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "Structured value unavailable";
  }
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
  const models = consoleState.selectedAgent?.models;
  const model = models?.find((candidate) =>
    candidate.id === (consoleState.model || consoleState.selectedAgent?.defaults?.model)
  );
  const effortOptions = model?.efforts;
  return (
    <div className="composer-shell">
      <AskUser />
      <ComposerPrimitive.Root className="composer-root">
        <ComposerPrimitive.Quote className="composer-quote">
          <span aria-hidden="true">❝</span>
          <ComposerPrimitive.QuoteText />
          <ComposerPrimitive.QuoteDismiss aria-label="Remove quote">×</ComposerPrimitive.QuoteDismiss>
        </ComposerPrimitive.Quote>
        {consoleState.pendingFiles.length > 0 && (
          <ul className="composer-attachments">
            {consoleState.pendingFiles.map((file, index) => (
              <li key={`${file.name}:${index}`}>
                <span>{file.name}</span>
                <button type="button" onClick={() => consoleState.removeFile(index)} aria-label={`Remove ${file.name}`}>×</button>
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
          <div className="model-controls">
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
                <button type="button" onClick={() => fileInput.current?.click()} title="Attach files">＋ File</button>
              </>
            )}
            {consoleState.selectedAgent?.capabilities.runtimeOverrides === true && (
              <>
                <input
                  className="runtime-input"
                  value={consoleState.runtime}
                  onChange={(event) => consoleState.setRuntime(event.target.value)}
                  placeholder="runtime"
                  aria-label="Runtime override"
                />
                {models === undefined ? (
                  <input
                    value={consoleState.model}
                    onChange={(event) => {
                      consoleState.setModel(event.target.value);
                      consoleState.setEffort("");
                    }}
                    placeholder="model"
                    aria-label="Model override"
                  />
                ) : (
                  <select
                    value={consoleState.model}
                    onChange={(event) => {
                      consoleState.setModel(event.target.value);
                      consoleState.setEffort("");
                    }}
                    aria-label="Model"
                  >
                    <option value="">Default model</option>
                    {models.map((option) => (
                      <option key={option.id} value={option.id}>{option.label ?? option.id}</option>
                    ))}
                  </select>
                )}
                {effortOptions === undefined ? (
                  <input
                    value={consoleState.effort}
                    onChange={(event) => consoleState.setEffort(event.target.value)}
                    placeholder="effort"
                    aria-label="Reasoning effort override"
                  />
                ) : (
                  <select
                    value={consoleState.effort}
                    onChange={(event) => consoleState.setEffort(event.target.value)}
                    aria-label="Reasoning effort"
                  >
                    <option value="">Default effort</option>
                    {effortOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                )}
              </>
            )}
          </div>
          <div className="composer-actions">
            <ComposerPrimitive.Send className="composer-send" aria-label={isRunning ? "Send live input" : "Send message"}>
              Send
            </ComposerPrimitive.Send>
            {isRunning && (
              <ComposerPrimitive.Cancel className="composer-stop" aria-label="Stop response">
                Stop
              </ComposerPrimitive.Cancel>
            )}
          </div>
        </div>
      </ComposerPrimitive.Root>
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
        <div className="connection-banner" role="alert">
          <span className="connection-pulse" />
          {consoleState.error}
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
