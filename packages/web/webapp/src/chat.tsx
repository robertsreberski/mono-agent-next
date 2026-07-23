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
import { type FormEvent, useMemo, useRef, useState } from "react";
import type { OperatorActivity } from "@mono-agent/operator";

import { useConsole } from "./console";
import type { AskQuestion, Attachment, Telemetry } from "./types";

function QuoteBlock({ text }: QuoteMessagePartProps) {
  return <blockquote className="message-quote"><span aria-hidden="true">❝</span>{text}</blockquote>;
}

function MarkdownText() {
  return <MarkdownTextPrimitive className="markdown" data-aui-quote-selectable />;
}

function EmptyPart({ status }: EmptyMessagePartProps) {
  const role = useAuiState((state) => state.message.role);
  if (role !== "assistant" || status.type !== "running") return null;
  return <span className="thinking" role="status" aria-label="Agent is thinking"><i /><i /><i /></span>;
}

const parts = { Text: MarkdownText, Quote: QuoteBlock, Empty: EmptyPart } as const;

function Attachments() {
  const raw = useAuiState((state) => state.message.metadata.custom?.attachments);
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return (
    <ul className="message-attachments">
      {(raw as readonly Attachment[]).map((attachment) => (
        <li key={attachment.id}>📎 {attachment.name}</li>
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
    <div className="activity-feed" aria-label="Agent activity">
      {(raw as readonly OperatorActivity[]).map((activity, index) => {
        if (activity.type === "activity") {
          return <div className="activity-row" key={`${activity.type}:${index}`}><i />{activity.text}</div>;
        }
        if (activity.type === "compaction") {
          const { compaction } = activity;
          const tokens = compaction.tokensBefore === undefined
            ? ""
            : compaction.tokensAfter === undefined
              ? ` · ${compactCount(compaction.tokensBefore)} tokens before`
              : ` · ${compactCount(compaction.tokensBefore)} → ${compactCount(compaction.tokensAfter)} tokens`;
          return (
            <div className="activity-row is-compaction" key={`${activity.type}:${index}`}>
              <i />{compaction.compacted ? "Context compacted" : "Context compaction skipped"}{tokens}
            </div>
          );
        }
        if (activity.type === "tool_call") {
          return (
            <details className="tool-activity" key={`${activity.type}:${activity.call.id}:${index}`}>
              <summary><i /><strong>{activity.call.name}</strong><span>tool call</span></summary>
              <pre>{activity.call.inputOmitted ? "Input omitted by policy" : safeJson(activity.call.input)}</pre>
            </details>
          );
        }
        return (
          <details
            className={`tool-activity${activity.result.isError ? " is-error" : ""}`}
            key={`${activity.type}:${activity.result.callId}:${index}`}
          >
            <summary><i /><strong>Tool result</strong><span>{activity.result.isError ? "failed" : "complete"}</span></summary>
            <pre>
              {activity.result.contentOmitted
                ? "Output omitted by policy"
                : activity.result.content?.map((part) =>
                    part.type === "text" ? part.text : safeJson(part.value)
                  ).join("\n\n") ?? "No output"}
            </pre>
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
        type="button"
        disabled={!text}
        onClick={() => void navigator.clipboard?.writeText(text)}
      >
        Copy
      </button>
    </ActionBarPrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="message message-user">
      <div className="message-bubble">
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
      <div className="assistant-avatar">m</div>
      <div className="assistant-body">
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
      <SelectionToolbarPrimitive.Quote className="selection-toolbar-button">
        ❝ Quote
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
    <form className="ask-card" onSubmit={(event) => void submit(event)}>
      <header><span>Input needed</span><small>{ask.questions.length} question{ask.questions.length === 1 ? "" : "s"}</small></header>
      {ask.questions.map((question) => (
        <AskQuestionField
          key={question.id}
          question={question}
          values={answers[question.id] ?? []}
          onChange={(values) => setAnswers((current) => ({ ...current, [question.id]: values }))}
        />
      ))}
      <button className="primary" type="submit" disabled={!valid || submitting}>
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
          <label className={`ask-choice${checked ? " is-selected" : ""}`} key={choice.value}>
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
        <label className="ask-custom">
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
  const model = consoleState.selectedAgent?.models?.find((candidate) =>
    candidate.id === consoleState.model
  );
  const effortOptions = model?.efforts ?? (
    consoleState.selectedAgent?.defaults?.effort ? [consoleState.selectedAgent.defaults.effort] : []
  );
  return (
    <div className="composer-area">
      <AskUser />
      <ComposerPrimitive.Root className="composer">
        <ComposerPrimitive.Quote className="composer-quote">
          <span aria-hidden="true">❝</span>
          <ComposerPrimitive.QuoteText />
          <ComposerPrimitive.QuoteDismiss aria-label="Remove quote">×</ComposerPrimitive.QuoteDismiss>
        </ComposerPrimitive.Quote>
        {consoleState.pendingFiles.length > 0 && (
          <ul className="pending-files">
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
          <div className="composer-settings">
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
                <select
                  value={consoleState.model}
                  onChange={(event) => {
                    consoleState.setModel(event.target.value);
                    consoleState.setEffort("");
                  }}
                  aria-label="Model"
                >
                  <option value="">Default model</option>
                  {consoleState.selectedAgent.models?.map((option) => (
                    <option key={option.id} value={option.id}>{option.label ?? option.id}</option>
                  ))}
                </select>
                {effortOptions.length > 0 && (
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
            <ComposerPrimitive.Send className="send-button" aria-label={isRunning ? "Send live input" : "Send message"}>
              Send
            </ComposerPrimitive.Send>
            {isRunning && (
              <ComposerPrimitive.Cancel className="stop-button" aria-label="Stop response">
                Stop
              </ComposerPrimitive.Cancel>
            )}
          </div>
        </div>
      </ComposerPrimitive.Root>
    </div>
  );
}

export function Chat() {
  const consoleState = useConsole();
  const thread = consoleState.selectedThread;
  const title = useMemo(() => thread?.title ?? "No conversation selected", [thread?.title]);
  return (
    <main className="chat">
      <header className="chat-header">
        <div>
          <span className="eyebrow">{consoleState.selectedAgent?.label ?? "mono-agent"}</span>
          <h1>{title}</h1>
        </div>
        {thread && (
          <div className="thread-actions">
            <button
              type="button"
              onClick={() => {
                const next = window.prompt("Conversation title", thread.title)?.trim();
                if (next) void consoleState.renameThread(thread.id, next);
              }}
            >Rename</button>
            <button type="button" onClick={() => void consoleState.archiveThread(thread.id, !thread.archivedAt)}>
              {thread.archivedAt ? "Restore" : "Archive"}
            </button>
            {thread.archivedAt && (
              <button
                type="button"
                className="danger"
                onClick={() => {
                  if (window.confirm("Permanently delete this archived conversation?")) {
                    void consoleState.deleteThread(thread.id);
                  }
                }}
              >Delete</button>
            )}
          </div>
        )}
      </header>
      {consoleState.error && <div className="error-banner" role="alert">{consoleState.error}</div>}
      {thread === undefined ? (
        <div className="empty-chat">
          <div className="brand-mark">m</div>
          <h2>Start a conversation</h2>
          <p>Select an online agent and create a thread.</p>
          <button className="primary" disabled={!consoleState.selectedAgent?.online} onClick={() => void consoleState.createThread()}>
            New conversation
          </button>
        </div>
      ) : (
        <ThreadPrimitive.Root className="thread-root">
          <SelectionToolbar />
          <ThreadPrimitive.Viewport className="thread-viewport" autoScroll>
            <div className="message-column">
              <ThreadPrimitive.Empty>
                <div className="thread-empty"><span>New conversation</span><small>Send a message to begin.</small></div>
              </ThreadPrimitive.Empty>
              <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
            </div>
            <ThreadPrimitive.ScrollToBottom className="scroll-bottom" aria-label="Scroll to latest">↓</ThreadPrimitive.ScrollToBottom>
            <ThreadPrimitive.ViewportFooter className="thread-footer">
              {thread.archivedAt
                ? <div className="archived-note">This conversation is archived. Restore it to continue.</div>
                : <Composer />}
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      )}
    </main>
  );
}
