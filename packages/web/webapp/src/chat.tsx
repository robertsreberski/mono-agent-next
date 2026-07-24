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
import { Popover, PopoverProvider } from "./components/Popover";
import type { Message, Telemetry } from "./types";
import "./chat.css";

export function ContextUsage({
  pending = false,
  telemetry,
}: {
  readonly pending?: boolean;
  readonly telemetry?: Telemetry;
}) {
  const contextUsed = pending ? undefined : telemetry?.contextUsed;
  const contextWindow = telemetry?.contextWindow;
  const percent =
    contextUsed === undefined || contextWindow === undefined || contextWindow <= 0
      ? undefined
      : Math.min(100, Math.round((contextUsed / contextWindow) * 100));
  return (
    <Popover
      id="context-usage"
      triggerClassName="context-usage-trigger"
      triggerLabel="Context usage"
      panelClassName="context-usage-panel"
      trigger={(
        <>
          <Icon name="spark" size={13} />
          <span>
            {pending
              ? "Context pending"
              : contextUsed === undefined
                ? "Context unavailable"
                : `Context ${compactCount(contextUsed)}`}
          </span>
          {percent !== undefined && <small>{percent}%</small>}
          <Icon name="chevron" size={13} />
        </>
      )}
    >
      <div>
        {telemetry === undefined ? (
          <p>
            {pending
              ? "Exact context telemetry is not available for the active response yet."
              : "Exact context telemetry is not available for this conversation yet."}
          </p>
        ) : (
          <>
            {pending && (
              <p>Exact context telemetry is not available for the active response yet.</p>
            )}
            <dl>
              <div><dt>Input</dt><dd>{telemetry.inputTokens.toLocaleString()}</dd></div>
              <div><dt>Output</dt><dd>{telemetry.outputTokens.toLocaleString()}</dd></div>
              <div>
                <dt>Used</dt>
                <dd>
                  {pending
                    ? "Pending"
                    : contextUsed === undefined
                      ? "Unavailable"
                      : contextUsed.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt>Window</dt>
                <dd>{contextWindow === undefined ? "Unavailable" : contextWindow.toLocaleString()}</dd>
              </div>
              <div><dt>Compaction</dt><dd>{telemetry.compacted ? "Applied" : "No"}</dd></div>
              <div><dt>Session</dt><dd>{telemetry.sessionEvicted ? "Renewed" : "Retained"}</dd></div>
            </dl>
          </>
        )}
      </div>
    </Popover>
  );
}

function ThreadActions() {
  const consoleState = useConsole();
  const thread = consoleState.selectedThread;
  if (thread === undefined) return null;
  return (
    <Popover
      id="thread-actions"
      triggerClassName="thread-menu-trigger"
      triggerLabel="Conversation actions"
      panelClassName="thread-menu-panel"
      panelRole="menu"
      trigger={(
        <Icon name="more" size={18} />
      )}
    >
      {(close) => (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              const next = window.prompt("Conversation title", thread.title)?.trim();
              if (next) void consoleState.renameThread(thread.id, next);
            }}
          >
            <Icon name="settings" size={14} />
            <span>Rename</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              void consoleState.archiveThread(thread.id, !thread.archivedAt);
            }}
          >
            <Icon name={thread.archivedAt ? "restore" : "archive"} size={14} />
            <span>{thread.archivedAt ? "Restore" : "Archive"}</span>
          </button>
          {thread.archivedAt && (
            <button
              type="button"
              className="danger"
              role="menuitem"
              onClick={() => {
                close();
                if (window.confirm("Permanently delete this archived conversation?")) {
                  void consoleState.deleteThread(thread.id);
                }
              }}
            >
              <Icon name="trash" size={14} />
              <span>Delete</span>
            </button>
          )}
        </>
      )}
    </Popover>
  );
}

export function currentAssistantContext(messages: readonly Message[] | undefined): {
  readonly pending: boolean;
  readonly telemetry?: Telemetry;
} {
  const latestAssistant = messages?.findLast((message) => message.role === "assistant");
  return {
    pending:
      latestAssistant?.status === "running"
      && latestAssistant.telemetry?.contextUsed === undefined,
    ...(latestAssistant?.telemetry === undefined
      ? {}
      : { telemetry: latestAssistant.telemetry }),
  };
}

export function displayedAssistantContext(
  messages: readonly Message[] | undefined,
  pending: boolean,
): {
  readonly pending: boolean;
  readonly telemetry?: Telemetry;
} {
  return pending ? { pending: true } : currentAssistantContext(messages);
}

export function Chat({ backgroundInert = false }: { readonly backgroundInert?: boolean }) {
  const consoleState = useConsole();
  const thread = consoleState.selectedThread;
  const title = useMemo(() => thread?.title ?? "No conversation selected", [thread?.title]);
  const context = useMemo(
    () => displayedAssistantContext(
      consoleState.detail?.messages,
      consoleState.sending,
    ),
    [consoleState.detail?.messages, consoleState.sending],
  );
  return (
    <PopoverProvider>
      <main
        className="chat"
        aria-hidden={backgroundInert || undefined}
        inert={backgroundInert}
      >
        <header className="chat-header">
          <div className="chat-heading">
            <span className="eyebrow">{consoleState.selectedAgent?.label ?? "mono-agent"}</span>
            <h1>{title}</h1>
          </div>
          {thread !== undefined && (
            <div className="chat-header-actions">
              <ContextUsage {...context} />
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
    </PopoverProvider>
  );
}

function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return String(value);
}
