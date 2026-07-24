import { ThreadPrimitive } from "@assistant-ui/react";
import { useMemo } from "react";

import { useConsole } from "./console";
import { Composer } from "./components/Composer";
import { Icon } from "./components/Icon";
import {
  AssistantMessage,
  SelectionToolbar,
  UserMessage,
} from "./components/Messages";
import type { Telemetry } from "./types";
import "./chat.css";

function ContextUsage({ telemetry }: { readonly telemetry?: Telemetry }) {
  const contextUsed = telemetry?.contextUsed;
  const contextWindow = telemetry?.contextWindow;
  const percent =
    contextUsed === undefined || contextWindow === undefined || contextWindow <= 0
      ? undefined
      : Math.min(100, Math.round((contextUsed / contextWindow) * 100));
  return (
    <details className="context-usage">
      <summary aria-label="Context usage" title="Context usage">
        <Icon name="spark" size={13} />
        <span>
          {contextUsed === undefined ? "Context unavailable" : `Context ${compactCount(contextUsed)}`}
        </span>
        {percent !== undefined && <small>{percent}%</small>}
        <Icon name="chevron" size={13} />
      </summary>
      <div className="context-usage-panel">
        {telemetry === undefined ? (
          <p>Exact context telemetry is not available for this conversation yet.</p>
        ) : (
          <dl>
            <div><dt>Input</dt><dd>{telemetry.inputTokens.toLocaleString()}</dd></div>
            <div><dt>Output</dt><dd>{telemetry.outputTokens.toLocaleString()}</dd></div>
            <div>
              <dt>Used</dt>
              <dd>{contextUsed === undefined ? "Unavailable" : contextUsed.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Window</dt>
              <dd>{contextWindow === undefined ? "Unavailable" : contextWindow.toLocaleString()}</dd>
            </div>
            <div><dt>Compaction</dt><dd>{telemetry.compacted ? "Applied" : "No"}</dd></div>
            <div><dt>Session</dt><dd>{telemetry.sessionEvicted ? "Renewed" : "Retained"}</dd></div>
          </dl>
        )}
      </div>
    </details>
  );
}

function ThreadActions() {
  const consoleState = useConsole();
  const thread = consoleState.selectedThread;
  if (thread === undefined) return null;
  return (
    <details className="thread-menu">
      <summary className="thread-menu-trigger" aria-label="Conversation actions" title="Conversation actions">
        <Icon name="more" size={18} />
      </summary>
      <div className="thread-menu-panel">
        <button
          type="button"
          onClick={() => {
            const next = window.prompt("Conversation title", thread.title)?.trim();
            if (next) void consoleState.renameThread(thread.id, next);
          }}
        >
          <Icon name="settings" size={14} />
          <span>Rename</span>
        </button>
        <button
          type="button"
          onClick={() => void consoleState.archiveThread(thread.id, !thread.archivedAt)}
        >
          <Icon name={thread.archivedAt ? "restore" : "archive"} size={14} />
          <span>{thread.archivedAt ? "Restore" : "Archive"}</span>
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
          >
            <Icon name="trash" size={14} />
            <span>Delete</span>
          </button>
        )}
      </div>
    </details>
  );
}

export function Chat() {
  const consoleState = useConsole();
  const thread = consoleState.selectedThread;
  const title = useMemo(() => thread?.title ?? "No conversation selected", [thread?.title]);
  const telemetry = useMemo(
    () => consoleState.detail?.messages.findLast(
      (message) => message.role === "assistant" && message.telemetry !== undefined,
    )?.telemetry,
    [consoleState.detail?.messages],
  );
  return (
    <main className="chat">
      <header className="chat-header">
        <div className="chat-heading">
          <span className="eyebrow">{consoleState.selectedAgent?.label ?? "mono-agent"}</span>
          <h1>{title}</h1>
        </div>
        {thread !== undefined && (
          <div className="chat-header-actions">
            <ContextUsage {...(telemetry === undefined ? {} : { telemetry })} />
            <ThreadActions />
          </div>
        )}
      </header>
      {consoleState.error && <div className="error-banner" role="alert">{consoleState.error}</div>}
      {thread === undefined ? (
        <div className="empty-chat">
          <div className="empty-chat-mark"><Icon name="spark" size={20} /></div>
          <h2>Start a conversation</h2>
          <p>Select an online agent and create a thread.</p>
          <button
            className="primary"
            disabled={!consoleState.selectedAgent?.online}
            onClick={() => void consoleState.createThread()}
          >
            New conversation
          </button>
        </div>
      ) : (
        <ThreadPrimitive.Root className="thread-root">
          <SelectionToolbar />
          <ThreadPrimitive.Viewport className="thread-viewport" autoScroll>
            <div className="message-column">
              <ThreadPrimitive.Empty>
                <div className="thread-empty">
                  <span>New conversation</span>
                  <small>Send a message to begin.</small>
                </div>
              </ThreadPrimitive.Empty>
              <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
            </div>
            <ThreadPrimitive.ScrollToBottom
              className="scroll-bottom"
              aria-label="Scroll to latest"
            >
              <Icon name="chevron" size={16} />
            </ThreadPrimitive.ScrollToBottom>
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

function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return String(value);
}
