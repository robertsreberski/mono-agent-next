import {
  ActionBarPrimitive,
  MessagePrimitive,
  type EmptyMessagePartProps,
  type QuoteMessagePartProps,
  SelectionToolbarPrimitive,
  useAuiState,
  useMessageQuote,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { useEffect, useState } from "react";

import { useConsole } from "../console";
import type { Attachment } from "../types";
import {
  ACTIVITY_GROUP_BY,
  ActivityDisclosure,
  ActivityText,
  CompactionActivity,
  OrphanResultActivity,
  ToolActivity,
} from "./Activity";
import { Icon } from "./Icon";

function QuoteBlock({ text }: QuoteMessagePartProps) {
  return (
    <blockquote className="message-quote">
      <Icon name="quote" size={14} />
      <span>{text}</span>
    </blockquote>
  );
}

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
    && operatorMessageId.length > 0;
  return (
    <MarkdownTextPrimitive
      className="markdown"
      data-aui-quote-selectable={canQuote ? true : "false"}
      defer
      smooth
    />
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
  return (
    <ul className="message-attachments" aria-label="Attachments">
      {(raw as readonly Attachment[]).map((attachment) => (
        <li key={attachment.id}>
          <Icon name="attach" size={13} />
          <span>{attachment.name}</span>
        </li>
      ))}
    </ul>
  );
}

function CopyAction({ label }: { readonly label: string }) {
  const text = useAuiState((state) =>
    state.message.content
      .flatMap((part) => part.type === "text" ? [part.text] : [])
      .join("\n\n")
  );
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2_000);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  return (
    <ActionBarPrimitive.Root className="message-actions" autohide="never">
      <button
        type="button"
        disabled={!text}
        aria-label={copyState === "copied" ? "Copied" : label}
        onClick={() => {
          void copyText(text).then(
            () => setCopyState("copied"),
            () => setCopyState("error"),
          );
        }}
      >
        <Icon name={copyState === "copied" ? "check" : "copy"} size={13} />
        <span>{copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : "Copy"}</span>
      </button>
    </ActionBarPrimitive.Root>
  );
}

function AssistantParts() {
  const running = useAuiState((state) => state.message.status?.type === "running");
  return (
    <MessagePrimitive.GroupedParts groupBy={ACTIVITY_GROUP_BY} indicator="no-text">
      {({ part, children }) => {
        switch (part.type) {
          case "group-activity":
            return <ActivityDisclosure streaming={running}>{children}</ActivityDisclosure>;
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
    <MessagePrimitive.Root className="message message-user">
      <div className="message-bubble">
        <StoredQuote />
        <Attachments />
        <MessagePrimitive.Parts components={messageParts} />
      </div>
      <CopyAction label="Copy message" />
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
        <StoredQuote />
        <AssistantParts />
        <MessagePrimitive.Error>
          <div className="message-error" role="alert">The response ended with an error.</div>
        </MessagePrimitive.Error>
        <div className="message-meta">
          <CopyAction label="Copy response" />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

export function SelectionToolbar() {
  return (
    <SelectionToolbarPrimitive.Root className="selection-toolbar">
      <SelectionToolbarPrimitive.Quote className="selection-toolbar-button">
        <Icon name="quote" size={14} />
        <span>Quote</span>
      </SelectionToolbarPrimitive.Quote>
    </SelectionToolbarPrimitive.Root>
  );
}

async function copyText(text: string): Promise<void> {
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
  textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.append(textarea);
  textarea.select();
  try {
    if (typeof document.execCommand !== "function" || !document.execCommand("copy")) {
      throw new Error("Clipboard access is unavailable.");
    }
  } finally {
    textarea.remove();
  }
}
