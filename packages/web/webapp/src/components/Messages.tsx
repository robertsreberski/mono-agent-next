import {
  ActionBarPrimitive,
  MessagePrimitive,
  type EmptyMessagePartProps,
  useAuiState,
  useMessageQuote,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type { OperatorActivity } from "@mono-agent/operator";
import { useEffect, useState } from "react";

import { useConsole } from "../console";
import type { Attachment } from "../types";
import {
  ACTIVITY_GROUP_BY,
  ActivityDisclosure,
  ActivityText,
  CompactionActivity,
  OperatorActivityTimeline,
  OrphanResultActivity,
  ToolActivity,
} from "./Activity";
import { QuoteBlock, SelectionToolbar } from "./assistant-ui/Quote";
import { Icon } from "./Icon";

export { SelectionToolbar };

function StoredQuote() {
  const quote = useMessageQuote();
  return quote === undefined ? null : <QuoteBlock text={quote.text} messageId={quote.messageId} />;
}

function MarkdownText() {
  const consoleState = useConsole();
  const operatorMessageId = useAuiState(
    (state) => state.message.metadata.custom?.operatorMessageId,
  );
  const canQuote =
    consoleState.selectedAgent?.capabilities.quotes === true
    && typeof operatorMessageId === "string"
    && operatorMessageId.trim().length > 0;
  return (
    <div
      className="message-text"
      data-aui-quote-selectable={canQuote ? "true" : "false"}
    >
      <MarkdownTextPrimitive
        className="markdown"
        defer
        smooth
      />
    </div>
  );
}

function RunningText({ status }: EmptyMessagePartProps) {
  const role = useAuiState((state) => state.message.role);
  if (role !== "assistant" || status.type !== "running") return null;
  return (
    <span className="thinking" role="status" aria-label="Agent is thinking">
      <i />
      <i />
      <i />
    </span>
  );
}

const messageParts = {
  Text: MarkdownText,
  Quote: QuoteBlock,
  Empty: RunningText,
} as const;

function Attachments() {
  const raw = useAuiState((state) => state.message.metadata.custom?.attachments);
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const attachments = raw.filter(isAttachment);
  if (attachments.length === 0) return null;
  return (
    <ul className="message-attachments" aria-label="Attachments">
      {attachments.map((attachment) => (
        <li
          key={attachment.id}
          className="attachment-chip"
          aria-label={attachmentAccessibleName(attachment)}
        >
          <span className="attachment-icon" aria-hidden="true">
            <Icon name={attachment.mediaType.startsWith("image/") ? "spark" : "attach"} size={14} />
          </span>
          <span className="attachment-details">
            <span className="attachment-name" title={attachment.name}>{attachment.name}</span>
            <span className="attachment-meta">{attachmentMetadata(attachment)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function copyableMessageText(
  content: readonly { readonly type: string; readonly text?: string }[],
): string {
  return content
    .flatMap((part) => part.type === "text" && part.text ? [part.text] : [])
    .join("\n\n");
}

function MessageCopyButton({ label }: { readonly label: string }) {
  const text = useAuiState((state) => copyableMessageText(state.message.content));
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2_500);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  return (
    <button
      type="button"
      className={`message-action${copyState === "copied" ? " is-success" : copyState === "error" ? " is-error" : ""}`}
      disabled={!text}
      aria-label={
        copyState === "copied"
          ? "Copied"
          : copyState === "error"
            ? "Copy failed"
            : label
      }
      onClick={() => {
        void copyTextWithFallback(text).then(
          () => setCopyState("copied"),
          (error: unknown) => {
            setCopyState("error");
            window.dispatchEvent(new CustomEvent("mono-agent:notice", {
              detail: {
                message:
                  error instanceof Error && error.message.trim()
                    ? error.message
                    : "Copy failed.",
              },
            }));
          },
        );
      }}
    >
      <Icon name={copyState === "copied" ? "check" : "copy"} size={13} />
      <span>
        {copyState === "copied"
          ? "Copied"
          : copyState === "error"
            ? "Copy failed"
            : "Copy"}
      </span>
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

function AssistantParts() {
  const running = useAuiState((state) => state.message.status?.type === "running");
  const rawActivities = useAuiState(
    (state) => state.message.metadata.custom?.activities,
  );
  const activities = Array.isArray(rawActivities)
    ? rawActivities as readonly OperatorActivity[]
    : [];
  return (
    <MessagePrimitive.GroupedParts groupBy={ACTIVITY_GROUP_BY} indicator="no-text">
      {({ part, children }) => {
        switch (part.type) {
          case "group-activity":
            return (
              <ActivityDisclosure streaming={running}>
                {activities.length > 0
                  ? (
                      <OperatorActivityTimeline
                        activities={activities}
                        streaming={running}
                      />
                    )
                  : children}
              </ActivityDisclosure>
            );
          case "text":
            return part.text.length > 0
              ? <MarkdownText />
              : part.status.type === "running"
                ? <RunningText status={part.status} />
                : null;
          case "reasoning":
            return <ActivityText {...part} />;
          case "tool-call":
            return part.toolUI ?? <ToolActivity {...part} />;
          case "data":
            if (part.name === "operator-compaction") return <CompactionActivity {...part} />;
            if (part.name === "operator-result") return <OrphanResultActivity {...part} />;
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
    <MessagePrimitive.Root
      className="message message-user"
      data-aui-quote-selectable="false"
    >
      <div className="message-bubble message-user-content">
        <StoredQuote />
        <Attachments />
        <MessagePrimitive.Parts components={messageParts} />
      </div>
      <MessageActions label="Copy message" />
    </MessagePrimitive.Root>
  );
}

export function AssistantMessage() {
  return (
    <MessagePrimitive.Root
      className="message message-assistant"
      data-aui-quote-selectable="false"
    >
      <div className="assistant-mark assistant-avatar" aria-hidden="true">
        <Icon name="spark" size={15} />
      </div>
      <div className="assistant-content assistant-body">
        <StoredQuote />
        <Attachments />
        <AssistantParts />
        <MessagePrimitive.Error>
          <div className="message-error" role="alert">The response ended with an error.</div>
        </MessagePrimitive.Error>
        <div className="message-meta">
          <MessageActions label="Copy response" persistentWhenLast />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

export function attachmentMetadata(attachment: Attachment): string {
  const parts = [attachment.mediaType];
  if (attachment.sizeBytes !== undefined && Number.isFinite(attachment.sizeBytes)) {
    parts.push(formatFileSize(attachment.sizeBytes));
  }
  return parts.join(" · ");
}

function attachmentAccessibleName(attachment: Attachment): string {
  return `${attachment.name}, ${attachmentMetadata(attachment)}`;
}

function formatFileSize(sizeBytes: number): string {
  const bytes = Math.max(0, sizeBytes);
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) {
    return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0).replace(/\.0$/u, "")} KB`;
  }
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0).replace(/\.0$/u, "")} MB`;
}

function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<Attachment>;
  return (
    typeof candidate.id === "string"
    && candidate.id.length > 0
    && typeof candidate.name === "string"
    && candidate.name.length > 0
    && typeof candidate.mediaType === "string"
    && candidate.mediaType.length > 0
    && (
      candidate.sizeBytes === undefined
      || (
        typeof candidate.sizeBytes === "number"
        && Number.isFinite(candidate.sizeBytes)
        && candidate.sizeBytes >= 0
      )
    )
  );
}

export async function copyTextWithFallback(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through for LAN HTTP and browser permission failures.
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
}
