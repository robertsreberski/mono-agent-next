import { ThreadPrimitive } from "@assistant-ui/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useConsole } from "./console";
import {
  Composer,
  OPEN_RUN_SETTINGS_EVENT,
} from "./components/Composer";
import { ContextDisplay } from "./components/assistant-ui/ContextDisplay";
import {
  ModelSelector,
  type ModelRoute,
} from "./components/assistant-ui/ModelSelector";
import { Icon } from "./components/Icon";
import {
  AssistantMessage,
  SelectionToolbar,
  UserMessage,
} from "./components/Messages";
import { NotificationBell } from "./components/NotificationBell";
import { Popover, PopoverProvider } from "./components/Popover";
import type {
  Message,
  ModelOption,
  Telemetry,
  Thread,
  TurnStatus,
} from "./types";

const RUN_LABELS: Readonly<Record<TurnStatus, string>> = {
  idle: "Ready",
  running: "Working",
  complete: "Ready",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};

function selectedThreadStatus(
  summary: Thread | undefined,
  detail: Thread | undefined,
): TurnStatus {
  const detailMatchesSummary =
    summary !== undefined
    && detail?.id === summary.id
    && detail.agentId === summary.agentId;
  return detailMatchesSummary ? detail.status : summary?.status ?? "idle";
}

export function ContextUsage({
  modelContextWindow,
  pending = false,
  telemetry,
}: {
  readonly modelContextWindow?: number;
  readonly pending?: boolean;
  readonly telemetry?: Telemetry;
}) {
  return (
    <ContextDisplay
      {...(modelContextWindow === undefined ? {} : { modelContextWindow })}
      pending={pending}
      {...(telemetry === undefined ? {} : { telemetry })}
    />
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
    setTitle(thread.title);
    if (!next) {
      return;
    }
    if (next !== thread.title) {
      void consoleState.renameThread(thread.id, next).catch(() => undefined);
    }
  };

  return (
    <div className="conversation-title-group">
      <h1 className="conversation-heading">
        {editing && thread !== undefined ? (
          <input
            ref={inputRef}
            className="title-input"
            value={title}
            maxLength={120}
            aria-label="Conversation title"
            onChange={(event) => setTitle(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setTitle(thread.title);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="conversation-title"
            disabled={thread === undefined}
            title={thread === undefined ? undefined : "Rename conversation"}
            onClick={() => {
              if (thread !== undefined) setTitle(thread.title);
              setEditing(true);
            }}
          >
            {thread?.title ?? "New conversation"}
          </button>
        )}
      </h1>
      {thread?.trigger?.kind !== undefined && (
        <span
          className="trigger-badge trigger-badge-header"
          aria-label={`${thread.trigger.kind} notification`}
        >
          {thread.trigger.kind}
        </span>
      )}
    </div>
  );
}

function ThreadActions() {
  const consoleState = useConsole();
  const thread = consoleState.selectedThread;
  if (thread === undefined) return null;

  return (
    <Popover
      id="thread-actions"
      triggerClassName="icon-button thread-menu-trigger"
      triggerLabel="Conversation actions"
      panelClassName="thread-menu-panel"
      panelRole="menu"
      trigger={<Icon name="more" size={18} />}
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
              void consoleState.archiveThread(thread.id, thread.archivedAt === undefined);
            }}
          >
            <Icon name={thread.archivedAt === undefined ? "archive" : "restore"} size={14} />
            <span>{thread.archivedAt === undefined ? "Archive" : "Restore"}</span>
          </button>
          {thread.archivedAt !== undefined && (
            <button
              type="button"
              className="danger"
              role="menuitem"
              onClick={() => {
                close();
                if (window.confirm(
                  "Permanently delete this conversation and its attachments? This cannot be undone.",
                )) {
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

function selectedModelOption(
  models: readonly ModelOption[] | undefined,
  route: ModelRoute | undefined,
  defaults: { readonly runtime?: string; readonly model?: string } | undefined,
): ModelOption | undefined {
  const runtime = route?.runtime ?? defaults?.runtime;
  const model = route?.id ?? defaults?.model;
  if (runtime === undefined || model === undefined) return undefined;
  return models?.find((candidate) =>
    candidate.runtime === runtime && candidate.id === model
  );
}

function ModelControls({
  context,
}: {
  readonly context: ReturnType<typeof displayedAssistantContext>;
}) {
  const consoleState = useConsole();
  const rootRef = useRef<HTMLSpanElement>(null);
  const authoredRoute =
    consoleState.runtime && consoleState.model
      ? { runtime: consoleState.runtime, id: consoleState.model }
      : undefined;
  const model = selectedModelOption(
    consoleState.selectedAgent?.models,
    authoredRoute,
    consoleState.selectedAgent?.defaults,
  );
  const canOverride =
    consoleState.selectedAgent?.capabilities.runtimeOverrides === true;
  const disabled =
    selectedThreadStatus(
      consoleState.selectedThread,
      consoleState.detail?.thread,
    ) === "running";

  useEffect(() => {
    const open = () => {
      if (!canOverride || disabled) return;
      const trigger = rootRef.current?.querySelector<HTMLButtonElement>(
        'button[aria-label="Run settings"]',
      );
      if (trigger?.getAttribute("aria-expanded") !== "true") trigger?.click();
    };
    window.addEventListener(OPEN_RUN_SETTINGS_EVENT, open);
    return () => window.removeEventListener(OPEN_RUN_SETTINGS_EVENT, open);
  }, [canOverride, disabled]);

  return (
    <div className="model-controls" aria-label="Conversation controls">
      <ContextUsage
        {...context}
        {...(model?.contextWindow === undefined
          ? {}
          : { modelContextWindow: model.contextWindow })}
      />
      {canOverride && (
        <span ref={rootRef} className="model-selector-wrap">
          <ModelSelector
            {...(consoleState.selectedAgent?.models === undefined
              ? {}
              : { models: consoleState.selectedAgent.models })}
            {...(authoredRoute === undefined ? {} : { route: authoredRoute })}
            {...(
              consoleState.selectedAgent?.defaults?.runtime === undefined
              || consoleState.selectedAgent.defaults.model === undefined
                ? {}
                : {
                    defaultRoute: {
                      runtime: consoleState.selectedAgent.defaults.runtime,
                      id: consoleState.selectedAgent.defaults.model,
                    },
                  }
            )}
            effort={consoleState.effort}
            triggerLabel="Run settings"
            disabled={disabled}
            onRouteChange={(route) => {
              consoleState.setRuntime(route?.runtime ?? "");
              consoleState.setModel(route?.id ?? "");
            }}
            onEffortChange={consoleState.setEffort}
          />
        </span>
      )}
    </div>
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

function EmptyConversation({ hasThread }: { readonly hasThread: boolean }) {
  const consoleState = useConsole();
  const content = (
    <div className="chat-empty">
      <div className="empty-orbit" aria-hidden="true">
        <span />
        <Icon name="spark" size={22} />
      </div>
      <span className="eyebrow">{consoleState.selectedAgent?.label ?? "mono-agent"}</span>
      <h2>{hasThread ? "What should we work on?" : "Start a new conversation"}</h2>
      <p>
        {consoleState.selectedAgent === undefined
          ? "No agents have been discovered yet. Start an agent and it will appear here automatically."
          : "Messages, Activity, files, and requested input stay together in this conversation."}
      </p>
      {!hasThread && consoleState.selectedAgent !== undefined && (
        <button
          type="button"
          className="primary-button"
          disabled={!consoleState.selectedAgent.online}
          onClick={() => void consoleState.createThread()}
        >
          New conversation
        </button>
      )}
    </div>
  );
  return hasThread ? <ThreadPrimitive.Empty>{content}</ThreadPrimitive.Empty> : content;
}

export function Chat({ backgroundInert = false }: { readonly backgroundInert?: boolean }) {
  const consoleState = useConsole();
  const thread = consoleState.selectedThread;
  const context = useMemo(
    () => displayedAssistantContext(
      consoleState.detail?.messages,
      consoleState.sending,
    ),
    [consoleState.detail?.messages, consoleState.sending],
  );
  const runStatus = RUN_LABELS[
    selectedThreadStatus(thread, consoleState.detail?.thread)
  ];
  const connectionStatus = {
    connected: undefined,
    connecting: "Connecting",
    reconnecting: "Reconnecting",
    offline: "Browser offline",
  }[consoleState.connection];
  const status =
    consoleState.selectedAgent?.online === false
      ? "Offline"
      : runStatus !== "Ready"
        ? runStatus
        : connectionStatus ?? (consoleState.refreshing ? "Syncing" : "Ready");
  const statusTone =
    status === "Browser offline"
      ? "browser"
      : status === "Connecting" || status === "Reconnecting" || status === "Syncing"
        ? "reconnecting"
        : status.toLocaleLowerCase();

  return (
    <PopoverProvider>
      <main
        className="chat-panel"
        aria-hidden={backgroundInert || undefined}
        inert={backgroundInert}
      >
        <header className="chat-header">
          <div className="chat-title-block">
            <ConversationTitle />
            <span
              className={`chat-status is-${statusTone}`}
              role="status"
              aria-label={`Agent status: ${status}`}
            >
              <i aria-hidden="true" />
              {status}
            </span>
          </div>
          <div className="chat-header-actions">
            <ModelControls context={context} />
            <NotificationBell className="icon-button header-notifications" iconSize={17} />
            <ThreadActions />
          </div>
        </header>
        {consoleState.error !== undefined && (
          <div className="error-banner" role="alert">
            <span>{consoleState.error}</span>
            <button type="button" onClick={() => void consoleState.retry()}>Retry</button>
          </div>
        )}
        {thread === undefined ? (
          <EmptyConversation hasThread={false} />
        ) : (
          <ThreadPrimitive.Root className="thread-root">
            <SelectionToolbar />
            <ThreadPrimitive.Viewport className="thread-viewport" autoScroll>
              <div className="message-column">
                <EmptyConversation hasThread />
                <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
              </div>
              <ThreadPrimitive.ScrollToBottom
                className="scroll-bottom"
                aria-label="Scroll to latest message"
              >
                <Icon name="chevron" size={16} />
              </ThreadPrimitive.ScrollToBottom>
              <ThreadPrimitive.ViewportFooter className="thread-footer">
                {thread.archivedAt !== undefined ? (
                  <div className="archived-footer">
                    <span>This conversation is archived.</span>
                    <button
                      type="button"
                      onClick={() => void consoleState.archiveThread(thread.id, false)}
                    >
                      Restore to continue
                    </button>
                  </div>
                ) : (
                  <Composer />
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
    </PopoverProvider>
  );
}
