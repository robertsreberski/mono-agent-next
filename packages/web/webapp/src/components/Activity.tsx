import {
  groupPartByType,
  type DataMessagePartProps,
  type ReasoningMessagePartProps,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { type PropsWithChildren, useEffect, useRef, useState } from "react";

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
  const previousStreaming = useRef(streaming);
  const [open, setOpen] = useState(streaming);
  const visible = streaming || open;

  useEffect(() => {
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
        type="button"
        className="activity-trigger"
        aria-expanded={visible}
        onClick={() => {
          if (!streaming) setOpen((current) => !current);
        }}
      >
        <span className={`activity-status${streaming ? " is-running" : ""}`} aria-hidden="true" />
        <span>Activity</span>
        {streaming && <span className="activity-running-label">Working</span>}
        <Icon name="chevron" className="activity-chevron" size={14} />
      </button>
      <div className="activity-panel" hidden={!visible} aria-busy={streaming}>
        {children}
      </div>
    </section>
  );
}

export function ActivityText({ text }: ReasoningMessagePartProps) {
  if (!text.trim()) return null;
  return (
    <div className="activity-note">
      <span className="activity-note-dot" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

export function ToolActivity({
  toolName,
  args,
  result,
  isError,
  status,
}: ToolCallMessagePartProps) {
  const running = status.type === "running";
  const state = running ? "running" : isError ? "failed" : result === undefined ? "called" : "complete";
  return (
    <details className={`tool-call${isError ? " is-error" : ""}`}>
      <summary>
        <span className={`tool-status${running ? " is-running" : ""}`} aria-hidden="true" />
        <strong>{toolName}</strong>
        <span>{state}</span>
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

interface CompactionData {
  readonly compacted?: boolean;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly summaryTokens?: number;
}

export function CompactionActivity({ data, status }: DataMessagePartProps) {
  const compaction = data as CompactionData;
  const running = status.type === "running" && compaction.compacted === undefined;
  const label = running
    ? "Compacting context…"
    : compaction.compacted === false
      ? "Context compaction skipped"
      : "Context compacted";
  const counts =
    finiteCount(compaction.tokensBefore) !== undefined
      ? finiteCount(compaction.tokensAfter) !== undefined
        ? `${compactCount(compaction.tokensBefore!)} → ${compactCount(compaction.tokensAfter!)} tokens`
        : `${compactCount(compaction.tokensBefore!)} tokens before`
      : undefined;
  return (
    <div className={`context-compaction-row${running ? " is-running" : ""}`} role="status">
      <span className="context-compaction-status" aria-hidden="true" />
      <span>{label}</span>
      {counts && <small>{counts}</small>}
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
    <details className={`tool-call${result.isError ? " is-error" : ""}`}>
      <summary>
        <span className="tool-status" aria-hidden="true" />
        <strong>Tool result</strong>
        <span>{result.isError ? "failed" : "complete"}</span>
        <Icon name="chevron" size={14} />
      </summary>
      <div className="tool-payload">
        <span>{result.callId ? `Call ${result.callId}` : "Output"}</span>
        <pre>{result.contentOmitted ? "Output omitted by policy" : safeJson(result.content)}</pre>
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "Structured value unavailable";
  }
}
