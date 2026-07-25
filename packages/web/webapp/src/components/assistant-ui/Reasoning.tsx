// SPDX-License-Identifier: MIT
import { Collapsible } from "@base-ui/react/collapsible";
import {
  useAuiState,
  type DataMessagePartProps,
  type ReasoningMessagePartProps,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { useEffect, useState } from "react";

import type {
  OperatorCompaction,
  OperatorToolResult,
  OperatorToolResultPart,
} from "@mono-agent/operator";
import { Icon } from "../Icon";

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "Structured value unavailable";
  }
};

const renderToolOutput = (
  content: readonly OperatorToolResultPart[] | undefined,
): string =>
  content
    ?.map((part) => part.type === "text" ? part.text : safeJson(part.value))
    .join("\n\n") ?? "No output";

const compactCount = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return String(value);
};

/**
 * The agent's narrated reasoning. It opens while the turn streams so progress
 * is visible, then collapses once the answer lands so a settled transcript
 * reads as prose rather than a wall of intermediate thinking.
 */
export function Reasoning({ text, status }: ReasoningMessagePartProps) {
  const streaming = status.type === "running";
  const [open, setOpen] = useState(streaming);

  useEffect(() => {
    setOpen(streaming);
  }, [streaming]);

  if (!text.trim()) return null;
  return (
    <Collapsible.Root
      className="reasoning-root"
      open={open}
      onOpenChange={setOpen}
      data-streaming={streaming ? "true" : "false"}
    >
      <Collapsible.Trigger className="reasoning-trigger" data-active={streaming ? "true" : "false"}>
        <span className="reasoning-trigger-icon">
          <Icon name="spark" size={14} />
        </span>
        <span className="reasoning-trigger-label">{streaming ? "Thinking" : "Thought process"}</span>
        <Icon name="chevron" size={13} className="reasoning-trigger-chevron" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="reasoning-content">
        <div className="reasoning-text">
          <div className="reasoning-text-content">
            {text.trim().split(/\n{2,}/u).map((paragraph, index) => (
              <div className="reasoning-part" key={index}><p>{paragraph}</p></div>
            ))}
          </div>
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/**
 * One disclosure per invocation. The call's arguments and its result share a
 * single row because they describe the same effect.
 */
export function ToolCall({ toolName, args, argsText, result, isError }: ToolCallMessagePartProps) {
  const running = result === undefined;
  const toolResult = result as OperatorToolResult | undefined;
  const output = toolResult === undefined
    ? undefined
    : toolResult.contentOmitted
      ? "Output omitted by policy"
      : renderToolOutput(toolResult.content);
  return (
    <details className={`tool-call${isError === true ? " is-error" : ""}`}>
      <summary>
        <i className={`tool-status${running ? " is-running" : ""}`} />
        <span className="tool-name">{toolName}</span>
        <span className="tool-state">
          {isError === true ? "failed" : running ? "running" : "complete"}
        </span>
        <Icon name="chevron" size={13} />
      </summary>
      <div className="tool-payload">
        <span>Input</span>
        <pre>{argsText === "" ? "Input omitted by policy" : safeJson(args)}</pre>
        {output !== undefined && (
          <>
            <span>Output</span>
            <pre>{output}</pre>
          </>
        )}
      </div>
    </details>
  );
}

export function CompactionRow({ data }: DataMessagePartProps<OperatorCompaction>) {
  const tokens = data.tokensBefore === undefined
    ? ""
    : data.tokensAfter === undefined
      ? `${compactCount(data.tokensBefore)} tokens before`
      : `${compactCount(data.tokensBefore)} → ${compactCount(data.tokensAfter)} tokens`;
  return (
    <div className={`context-compaction-row${data.compacted ? "" : " is-skipped"}`}>
      <i className="context-compaction-status" />
      <span className="context-compaction-label">
        {data.compacted ? "Context compacted" : "Context compaction skipped"}
      </span>
      {tokens !== "" && <span className="context-compaction-counts">{tokens}</span>}
    </div>
  );
}

/** A result whose call never arrived still has to be visible, not dropped. */
export function OrphanResult({ data }: DataMessagePartProps<OperatorToolResult>) {
  return (
    <details className={`tool-call${data.isError === true ? " is-error" : ""}`}>
      <summary>
        <i className="tool-status" />
        <span className="tool-name">Tool result</span>
        <span className="tool-state">{data.isError === true ? "failed" : "complete"}</span>
        <Icon name="chevron" size={13} />
      </summary>
      <div className="tool-payload">
        <span>Output</span>
        <pre>
          {data.contentOmitted
            ? "Output omitted by policy"
            : renderToolOutput(data.content)}
        </pre>
      </div>
    </details>
  );
}

/** Streaming placeholder shown before the first assistant token arrives. */
export function ThinkingIndicator() {
  const role = useAuiState((state) => state.message.role);
  if (role !== "assistant") return null;
  return (
    <span className="thinking-indicator" role="status" aria-label="Agent is thinking">
      <i /><i /><i />
    </span>
  );
}
