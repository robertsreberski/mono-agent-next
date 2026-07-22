import {
  ActionBarPrimitive,
  MessagePrimitive,
  type DataMessagePartProps,
  type EmptyMessagePartProps,
  type ToolCallMessagePartProps,
  useAuiState,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useConsoleStore } from "../console-store";
import type { AskAnswer, AskSnapshot } from "../types";
import { UserMessageAttachments } from "./Attachments";
import {
  ACTIVITY_GROUP_BY,
  ActivityGroup,
  Reasoning,
} from "./assistant-ui/Reasoning";
import { Icon } from "./Icon";
import { QuoteBlock } from "./assistant-ui/Quote";

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export const copyTextWithFallback = async (text: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // LAN HTTP and denied clipboard permissions can still use the selection fallback.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = typeof document.execCommand === "function" && document.execCommand("copy");
  } finally {
    textarea.remove();
    active?.focus();
  }
  if (!copied) throw new Error("This browser did not allow clipboard access.");
};

export const copyableMessageText = (
  content: readonly { readonly type: string; readonly text?: string }[],
): string =>
  content
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n\n");

function MessageCopyButton({ label }: { readonly label: string }) {
  const text = useAuiState((state) => copyableMessageText(state.message.content));
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [state]);

  return (
    <button
      type="button"
      className={`message-action${state === "copied" ? " is-success" : state === "error" ? " is-error" : ""}`}
      aria-label={state === "copied" ? "Copied" : label}
      disabled={!text}
      onClick={() => {
        void copyTextWithFallback(text).then(
          () => setState("copied"),
          (error: unknown) => {
            setState("error");
            window.dispatchEvent(new CustomEvent("mono-agent:notice", {
              detail: {
                message: error instanceof Error ? error.message : "Copy failed.",
              },
            }));
          },
        );
      }}
    >
      <Icon name={state === "copied" ? "check" : "copy"} size={14} />
      <span>{state === "copied" ? "Copied" : state === "error" ? "Copy failed" : "Copy"}</span>
    </button>
  );
}

function MessageActions({
  label,
  persistentWhenLast = false,
}: {
  readonly label: string;
  readonly persistentWhenLast?: boolean;
}) {
  const isLast = useAuiState((state) => state.message.isLast);
  return (
    <ActionBarPrimitive.Root
      className={`message-actions${persistentWhenLast && isLast ? " is-persistent" : ""}`}
      autohide="never"
    >
      <MessageCopyButton label={label} />
    </ActionBarPrimitive.Root>
  );
}

function MarkdownText() {
  return <MarkdownTextPrimitive className="markdown" data-aui-quote-selectable defer smooth />;
}

function LiveInputStatus() {
  const status = useAuiState((state) => state.message.metadata.custom?.liveInputStatus);
  if (status !== "pending" && status !== "applied" && status !== "queued" && status !== "cancelled") {
    return null;
  }
  const label = status === "pending"
    ? "Steering current run…"
    : status === "applied"
      ? "Applied to current run"
      : status === "queued"
        ? "Queued as next turn"
        : "Cancelled";
  return <span className={`live-input-status is-${status}`} role="status">{label}</span>;
}

function RunningText({ status }: EmptyMessagePartProps) {
  const role = useAuiState((state) => state.message.role);
  if (role !== "assistant" || status.type !== "running") return null;
  return (
    <span className="thinking-indicator" aria-label="Agent is thinking">
      <i />
      <i />
      <i />
    </span>
  );
}

function AskUserTool({
  args,
  result,
  status,
}: Pick<ToolCallMessagePartProps, "args" | "result" | "status">) {
  const threadId = useConsoleStore().selectedThread?.id;
  const [snapshot, setSnapshot] = useState<AskSnapshot>();
  const [selected, setSelected] = useState<Record<string, readonly string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const input = typeof args === "object" && args !== null ? args as Record<string, unknown> : {};

  useEffect(() => {
    if (!threadId || status.type !== "running") return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const ask = await api.pendingAsk(threadId, controller.signal);
        if (ask !== undefined) {
          setSnapshot(ask);
          if (ask.status !== "pending") return;
        }
      } catch (pollError) {
        if (controller.signal.aborted) return;
        setError(pollError instanceof Error ? pollError.message : "Could not load the question.");
      }
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 400);
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [status.type, threadId]);

  const remaining = snapshot?.questions.slice(snapshot.activeQuestionIndex) ?? [];
  const complete = remaining.length > 0 && remaining.every((question) => {
    const count = (selected[question.id]?.length ?? 0) + ((custom[question.id]?.trim().length ?? 0) > 0 ? 1 : 0);
    return question.multiSelect ? count > 0 : count === 1;
  });
  const submit = async () => {
    if (!threadId || !snapshot || !complete) return;
    setSubmitting(true);
    setError(undefined);
    const answers: AskAnswer[] = remaining.map((question) => ({
      questionId: question.id,
      selectedOptionIds: selected[question.id] ?? [],
      ...(custom[question.id]?.trim() ? { customReply: custom[question.id]!.trim() } : {}),
    }));
    try {
      const response = await api.submitAsk(threadId, snapshot.interactionId, answers);
      if (!response.accepted) throw new Error(response.code === "invalid_answer" ? "Please complete every question." : "This question is no longer active.");
      if (response.snapshot !== undefined) setSnapshot(response.snapshot);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not submit the answer.");
    } finally {
      setSubmitting(false);
    }
  };

  const terminal = snapshot?.status !== undefined && snapshot.status !== "pending";
  return (
    <section className="ask-user-card" aria-label="Question from the agent">
      <div className="ask-user-heading">
        <span className={`tool-status${status.type === "running" ? " is-running" : ""}`} />
        <strong>Input needed</strong>
      </div>
      {(snapshot?.message ?? (typeof input.message === "string" ? input.message : undefined)) && (
        <div className="ask-user-context">{snapshot?.message ?? String(input.message)}</div>
      )}
      {snapshot === undefined ? (
        <p className="ask-user-loading">Preparing the questions…</p>
      ) : terminal ? (
        <p className="ask-user-complete">{snapshot.status === "answered" ? "Answers submitted." : `Question ${snapshot.status}.`}</p>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {snapshot.questions.map((question, questionIndex) => {
            const prior = snapshot.answers.find((answer) => answer.questionId === question.id);
            const isPrior = questionIndex < snapshot.activeQuestionIndex && prior !== undefined;
            const selectedIds = isPrior ? prior.selectedOptionIds : selected[question.id] ?? [];
            const customReply = isPrior ? prior.customReply ?? "" : custom[question.id] ?? "";
            return (
              <fieldset key={question.id} disabled={isPrior || submitting}>
                <legend><span>{question.header}</span>{question.question}</legend>
                <div className="ask-user-options">
                  {question.options.map((option) => {
                    const checked = selectedIds.includes(option.id);
                    return (
                      <label key={option.id} className={`ask-user-option${checked ? " is-selected" : ""}`}>
                        <input
                          type={question.multiSelect ? "checkbox" : "radio"}
                          name={question.id}
                          checked={checked}
                          onChange={() => {
                            setSelected((current) => ({
                              ...current,
                              [question.id]: question.multiSelect
                                ? checked
                                  ? (current[question.id] ?? []).filter((id) => id !== option.id)
                                  : [...(current[question.id] ?? []), option.id]
                                : [option.id],
                            }));
                            if (!question.multiSelect) setCustom((current) => ({ ...current, [question.id]: "" }));
                          }}
                        />
                        <span><strong>{option.label}</strong><small>{option.description}</small></span>
                      </label>
                    );
                  })}
                </div>
                <label className="ask-user-other">
                  <span>Custom reply</span>
                  <textarea
                    rows={2}
                    value={customReply}
                    placeholder="Type another answer…"
                    onChange={(event) => {
                      const value = event.target.value;
                      setCustom((current) => ({ ...current, [question.id]: value }));
                      if (!question.multiSelect && value.trim()) setSelected((current) => ({ ...current, [question.id]: [] }));
                    }}
                  />
                </label>
              </fieldset>
            );
          })}
          {error && <p className="ask-user-error" role="alert">{error}</p>}
          <button type="submit" className="ask-user-submit" disabled={!complete || submitting}>
            {submitting ? "Submitting…" : snapshot.questions.length === 1 ? "Submit answer" : "Submit answers"}
          </button>
        </form>
      )}
      {snapshot === undefined && status.type !== "running" && result !== undefined && (
        <pre className="ask-user-result">{safeJson(result)}</pre>
      )}
    </section>
  );
}

export function ToolFallback({
  toolName,
  args,
  result,
  isError,
  status,
}: ToolCallMessagePartProps) {
  if (toolName === "AskUser") return <AskUserTool args={args} result={result} status={status} />;
  const isRunning = status.type === "running";
  return (
    <details className={`tool-call${isError ? " is-error" : ""}`}>
      <summary>
        <span className={`tool-status${isRunning ? " is-running" : ""}`} />
        <span className="tool-name">{toolName}</span>
        <span className="tool-state">
          {isRunning ? "running" : isError ? "failed" : result === undefined ? "called" : "done"}
        </span>
        <Icon name="chevron" size={14} />
      </summary>
      <div className="tool-payload">
        <span>Input</span>
        <pre>{safeJson(args)}</pre>
        {result !== undefined && (
          <>
            <span>Output</span>
            <pre>{safeJson(result)}</pre>
          </>
        )}
      </div>
    </details>
  );
}

type CompactionDisplayStatus = "running" | "succeeded" | "skipped" | "failed" | "interrupted";

const finiteCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const compactTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return String(Math.round(tokens));
};

const compactionPayload = (value: unknown): Record<string, unknown> => {
  let current = value;
  let best: Record<string, unknown> = {};
  const seen = new Set<object>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || seen.has(current)) break;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.status === "string") best = record;
    current = record.data;
  }
  return best;
};

function ContextCompactionPart({ data, status: messageStatus }: DataMessagePartProps) {
  const payload = compactionPayload(data);
  const reported = ["running", "succeeded", "skipped", "failed"].includes(String(payload.status))
    ? payload.status as Exclude<CompactionDisplayStatus, "interrupted">
    : "failed";
  const status: CompactionDisplayStatus = reported === "running" && messageStatus.type !== "running"
    ? "interrupted"
    : reported;
  const label = {
    running: "Compacting context…",
    succeeded: "Context compacted",
    skipped: "Context compaction skipped",
    failed: "Context compaction failed",
    interrupted: "Context compaction interrupted",
  }[status];
  const trigger = typeof payload.trigger === "string" ? payload.trigger : undefined;
  const triggerLabel = trigger === "overflow"
    ? "after overflow"
    : trigger === "proactive"
      ? "proactive"
      : trigger === "manual"
        ? "manual"
        : undefined;
  const before = finiteCount(payload.tokensBefore);
  const after = finiteCount(payload.tokensAfter);
  const approximate = payload.tokenCountsExact !== true;
  const formatMeasuredCount = (tokens: number) => `${approximate ? "~" : ""}${compactTokenCount(tokens)}`;
  const counts = before !== undefined && after !== undefined
    ? `${formatMeasuredCount(before)} → ${formatMeasuredCount(after)} tokens`
    : before !== undefined
      ? `${formatMeasuredCount(before)} tokens before`
      : after !== undefined
        ? `${formatMeasuredCount(after)} tokens after`
        : undefined;

  return (
    <div
      className={`context-compaction-row is-${status}`}
      role="status"
      aria-label={[label.replace("…", ""), triggerLabel, counts].filter(Boolean).join(", ")}
    >
      <span className="context-compaction-status" aria-hidden="true" />
      <span className="context-compaction-label">{label}</span>
      {triggerLabel !== undefined && <span className="context-compaction-trigger">{triggerLabel}</span>}
      {counts !== undefined && <span className="context-compaction-counts">{counts}</span>}
    </div>
  );
}

// Runtime/provider telemetry remains attached to the message so the context
// display can summarize it. Compaction alone is promoted into Activity; other
// transport diagnostics remain out of the transcript UI.
function ErrorPart({ data }: DataMessagePartProps) {
  const payload = data as { code?: unknown; message?: unknown };
  return (
    <div className="message-error" role="alert">
      <strong>{payload.code ? String(payload.code) : "Agent error"}</strong>
      <span>{String(payload.message ?? "The agent run failed.")}</span>
    </div>
  );
}

const parts = {
  Text: MarkdownText,
  Quote: QuoteBlock,
  Empty: RunningText,
  data: {
    by_name: {
      "context-compaction": ContextCompactionPart,
      error: ErrorPart,
    },
  },
} as const;

function AssistantParts() {
  const isMessageRunning = useAuiState(
    (state) => state.message.status?.type === "running",
  );
  return (
    <MessagePrimitive.GroupedParts groupBy={ACTIVITY_GROUP_BY} indicator="no-text">
      {({ part, children }) => {
        switch (part.type) {
          case "group-activity":
            return <ActivityGroup streaming={isMessageRunning}>{children}</ActivityGroup>;
          case "text":
            return part.text.length > 0
              ? <MarkdownText />
              : part.status.type === "running"
                ? <RunningText status={part.status} />
                : null;
          case "reasoning":
            return <Reasoning {...part} />;
          case "tool-call":
            return part.toolUI ?? <ToolFallback {...part} />;
          case "data":
            if (part.name === "telemetry") return null;
            if (part.name === "context-compaction") return <ContextCompactionPart {...part} />;
            if (part.name === "error") return <ErrorPart {...part} />;
            return part.dataRendererUI;
          case "indicator":
            return <RunningText status={{ type: "running" }} />;
          default:
            return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
  );
}

export function UserMessage() {
  return (
    <MessagePrimitive.Root className="message message-user">
      <div className="message-user-content">
        <UserMessageAttachments />
        <MessagePrimitive.Parts components={parts} />
      </div>
      <LiveInputStatus />
      <MessageActions label="Copy message" />
    </MessagePrimitive.Root>
  );
}

export function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="message message-assistant">
      <div className="assistant-mark" aria-hidden="true">
        <Icon name="spark" size={15} />
      </div>
      <div className="assistant-content">
        <AssistantParts />
        <MessagePrimitive.Error>
          <div className="message-error" role="alert">The response ended with an error.</div>
        </MessagePrimitive.Error>
        <MessageActions label="Copy response" persistentWhenLast />
      </div>
    </MessagePrimitive.Root>
  );
}

export function SystemMessage() {
  return (
    <MessagePrimitive.Root className="message message-system">
      <MessagePrimitive.Parts components={parts} />
    </MessagePrimitive.Root>
  );
}
