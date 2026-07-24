import {
  groupPartByType,
  type DataMessagePartProps,
  type ReasoningMessagePartProps,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import type {
  OperatorActivity,
  OperatorCompaction,
  OperatorToolCall,
  OperatorToolResult,
} from "@mono-agent/operator";
import {
  Fragment,
  type PropsWithChildren,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { Icon } from "./Icon";

const ACTIVITY_BY_TYPE = groupPartByType({
  reasoning: ["group-activity"] as const,
  "tool-call": ["group-activity"] as const,
});

export const ACTIVITY_GROUP_BY: typeof ACTIVITY_BY_TYPE = (part, context) => {
  if (
    part.type === "data"
    && (part.name === "operator-compaction" || part.name === "operator-result")
  ) {
    return ["group-activity"] as const;
  }
  return ACTIVITY_BY_TYPE(part, context);
};

export function ActivityDisclosure({
  children,
  streaming,
}: PropsWithChildren<{ readonly streaming: boolean }>) {
  const disclosureId = useId();
  const previousStreaming = useRef(streaming);
  const [open, setOpen] = useState(streaming);
  const visible = streaming || open;

  useLayoutEffect(() => {
    if (previousStreaming.current === streaming) return;
    previousStreaming.current = streaming;
    setOpen(streaming);
  }, [streaming]);

  return (
    <section
      className="activity-root"
      data-streaming={streaming ? "true" : "false"}
      data-open={visible ? "true" : "false"}
    >
      <button
        id={`${disclosureId}-trigger`}
        type="button"
        className="activity-trigger"
        aria-controls={`${disclosureId}-panel`}
        aria-expanded={visible}
        aria-label={streaming ? "Activity in progress" : "Activity"}
        onClick={() => {
          if (!streaming) setOpen((current) => !current);
        }}
      >
        <span className={`activity-status${streaming ? " is-running" : ""}`} aria-hidden="true" />
        <span>Activity</span>
        {streaming && (
          <span className="activity-running-label">
            Working<span className="sr-only">; updates are shown below</span>
          </span>
        )}
        <Icon name="chevron" className="activity-chevron" size={14} />
      </button>
      <div
        id={`${disclosureId}-panel`}
        className="activity-panel"
        role="region"
        aria-labelledby={`${disclosureId}-trigger`}
        aria-busy={streaming}
        hidden={!visible}
      >
        {children}
      </div>
    </section>
  );
}

export function ActivityText({ text }: ReasoningMessagePartProps) {
  return <ActivityNote text={text} />;
}

function ActivityNote({
  text,
  occurrence,
}: {
  readonly text: string;
  readonly occurrence?: boolean;
}) {
  if (!text.trim()) return null;
  return (
    <div
      className="activity-note"
      data-activity-occurrence={occurrence ? "activity" : undefined}
    >
      <span className="activity-note-dot" aria-hidden="true" />
      <div className="activity-note-copy">
        {text.trim().split(/\n{2,}/u).map((paragraph, paragraphIndex) => (
          <p key={paragraphIndex}>
            {paragraph.split("\n").map((line, lineIndex, lines) => (
              <Fragment key={lineIndex}>
                {line}
                {lineIndex < lines.length - 1 && <br />}
              </Fragment>
            ))}
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * Render the durable operator stream directly instead of reconstructing its
 * chronology from assistant-ui's converted parts. Converted tool calls attach
 * a matching result even when another activity occurred between the call and
 * result, so those parts remain a compatibility fallback only.
 */
export function OperatorActivityTimeline({
  activities,
  streaming,
}: {
  readonly activities: readonly OperatorActivity[];
  readonly streaming: boolean;
}) {
  const toolNames = new Map<string, string>();
  const completedCalls = new Set<string>();
  for (const activity of activities) {
    if (activity.type === "tool_call") {
      toolNames.set(activity.call.id, activity.call.name);
    } else if (activity.type === "tool_result") {
      completedCalls.add(activity.result.callId);
    }
  }

  return activities.map((activity, index) => {
    switch (activity.type) {
      case "activity":
        return (
          <ActivityNote
            key={`activity-${index}`}
            text={activity.text}
            occurrence
          />
        );
      case "compaction":
        return (
          <CompactionRow
            key={`compaction-${index}`}
            compaction={activity.compaction}
            running={false}
            occurrence
          />
        );
      case "tool_call":
        return (
          <ToolCallOccurrence
            key={`tool-call-${activity.call.id}-${index}`}
            call={activity.call}
            running={streaming && !completedCalls.has(activity.call.id)}
          />
        );
      case "tool_result": {
        const toolName = toolNames.get(activity.result.callId);
        return (
          <ToolResultOccurrence
            key={`tool-result-${activity.result.callId}-${index}`}
            result={activity.result}
            {...(toolName === undefined ? {} : { toolName })}
          />
        );
      }
    }
  });
}

export function ToolActivity({
  toolName,
  args,
  result,
  isError,
  status,
}: ToolCallMessagePartProps) {
  const running = status.type === "running";
  const state =
    running
      ? "running"
      : isError
        ? "failed"
        : result === undefined
          ? "called"
          : "done";
  return (
    <details className={`tool-call${isError ? " is-error" : ""}`}>
      <summary>
        <span className={`tool-status${running ? " is-running" : ""}`} aria-hidden="true" />
        <strong className="tool-name">{toolName}</strong>
        <span className="tool-state">{state}</span>
        <Icon name="chevron" size={14} />
      </summary>
      <div className="tool-payload">
        <span>Input</span>
        <pre>{toolInputText(args)}</pre>
        {result !== undefined && (
          <>
            <span>Output</span>
            <pre>{toolOutputText(result)}</pre>
          </>
        )}
      </div>
    </details>
  );
}

interface CompactionData {
  readonly compacted?: boolean;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly summaryTokens?: number;
}

export function CompactionActivity({ data, status }: DataMessagePartProps) {
  const compaction = data as CompactionData;
  const running = status.type === "running" && compaction.compacted === undefined;
  return <CompactionRow compaction={compaction} running={running} />;
}

function CompactionRow({
  compaction,
  occurrence,
  running,
}: {
  readonly compaction: CompactionData | OperatorCompaction;
  readonly occurrence?: boolean;
  readonly running: boolean;
}) {
  const displayStatus = running
    ? "running"
    : compaction.compacted === false
      ? "skipped"
      : "succeeded";
  const label = running
    ? "Compacting context…"
    : compaction.compacted === false
      ? "Context compaction skipped"
      : "Context compacted";
  const before = finiteCount(compaction.tokensBefore);
  const after = finiteCount(compaction.tokensAfter);
  const summary = finiteCount(compaction.summaryTokens);
  const counts = before !== undefined
    ? after !== undefined
      ? `${compactCount(before)} → ${compactCount(after)} tokens`
      : `${compactCount(before)} tokens before`
    : after !== undefined
      ? `${compactCount(after)} tokens after`
      : undefined;
  const summaryLabel =
    summary === undefined ? undefined : `${compactCount(summary)} summary tokens`;
  return (
    <div
      className={`context-compaction-row is-${displayStatus}`}
      data-activity-occurrence={occurrence ? "compaction" : undefined}
      role="status"
      aria-label={[
        label.replace("…", ""),
        counts,
        summaryLabel,
      ].filter(Boolean).join(", ")}
    >
      <span className="context-compaction-status" aria-hidden="true" />
      <span className="context-compaction-label">{label}</span>
      {(counts !== undefined || summaryLabel !== undefined) && (
        <small className="context-compaction-metrics">
          {counts}
          {counts !== undefined && summaryLabel !== undefined && " · "}
          {summaryLabel}
        </small>
      )}
    </div>
  );
}

interface ResultData {
  readonly callId?: string;
  readonly content?: unknown;
  readonly contentOmitted?: boolean;
  readonly isError?: boolean;
}

export function OrphanResultActivity({ data }: DataMessagePartProps) {
  const result = data as ResultData;
  return (
    <ResultDetails
      {...(result.callId === undefined ? {} : { callId: result.callId })}
      content={result.content}
      contentOmitted={result.contentOmitted === true}
      isError={result.isError === true}
      orphan
    />
  );
}

function ToolCallOccurrence({
  call,
  running,
}: {
  readonly call: OperatorToolCall;
  readonly running: boolean;
}) {
  return (
    <details
      className="tool-call"
      data-activity-occurrence="tool_call"
      data-call-id={call.id}
    >
      <summary>
        <span className={`tool-status${running ? " is-running" : ""}`} aria-hidden="true" />
        <strong className="tool-name">{call.name}</strong>
        <span className="tool-state">{running ? "running" : "called"}</span>
        <Icon name="chevron" size={14} />
      </summary>
      <div className="tool-payload">
        <span>{`Input · call ${call.id}`}</span>
        <pre>
          {call.inputOmitted
            ? "Input omitted by policy"
            : call.input === undefined
              ? "{}"
              : safeJson(call.input)}
        </pre>
      </div>
    </details>
  );
}

function ToolResultOccurrence({
  result,
  toolName,
}: {
  readonly result: OperatorToolResult;
  readonly toolName?: string;
}) {
  const content = result.content?.map((part) =>
    part.type === "text" ? part.text : part.value
  );
  return (
    <ResultDetails
      callId={result.callId}
      content={content}
      contentOmitted={result.contentOmitted}
      isError={result.isError === true}
      occurrence
      {...(toolName === undefined ? {} : { toolName })}
    />
  );
}

function ResultDetails({
  callId,
  content,
  contentOmitted,
  isError,
  occurrence,
  orphan,
  toolName,
}: {
  readonly callId?: string;
  readonly content: unknown;
  readonly contentOmitted: boolean;
  readonly isError: boolean;
  readonly occurrence?: boolean;
  readonly orphan?: boolean;
  readonly toolName?: string;
}) {
  return (
    <details
      className={`tool-call${orphan ? " is-orphan" : ""}${isError ? " is-error" : ""}`}
      data-activity-occurrence={occurrence ? "tool_result" : undefined}
      data-call-id={occurrence ? callId : undefined}
    >
      <summary>
        <span className="tool-status" aria-hidden="true" />
        <strong className="tool-name">
          {toolName === undefined ? "Tool result" : `${toolName} result`}
        </strong>
        <span className="tool-state">{isError ? "failed" : "done"}</span>
        <Icon name="chevron" size={14} />
      </summary>
      <div className="tool-payload">
        <span>{callId ? `Call ${callId}` : "Output"}</span>
        <pre>{contentOmitted ? "Output omitted by policy" : safeJson(content)}</pre>
      </div>
    </details>
  );
}

function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return String(Math.round(value));
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function toolInputText(value: unknown): string {
  if (isRecord(value) && value.omitted === true && typeof value.message === "string") {
    return value.message;
  }
  return safeJson(value);
}

function toolOutputText(value: unknown): string {
  if (!isRecord(value)) return safeJson(value);
  if (value.contentOmitted === true) return "Output omitted by policy";
  if ("content" in value) return safeJson(value.content);
  return safeJson(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized ?? String(value);
  } catch {
    return "Structured value unavailable";
  }
}
