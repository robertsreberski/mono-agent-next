import { ThreadPrimitive } from "@assistant-ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ConnectionState,
  effortLevelsForAgentModel,
  useConsoleStore,
} from "../console-store";
import { conversationConsoleUsage, type ConsoleUsage } from "../usage";
import { NotificationBell } from "../notifications";
import { ContextDisplay } from "./assistant-ui/ContextDisplay";
import {
  ModelSelector,
  type ModelSelectorEffortOption,
  type ModelSelectorOption,
} from "./assistant-ui/ModelSelector";
import { SelectionToolbar } from "./assistant-ui/Quote";
import { AssistantMessage, SystemMessage, UserMessage } from "./Messages";
import { Composer } from "./Composer";
import { Icon } from "./Icon";

const runLabel: Record<string, string> = {
  idle: "Ready",
  running: "Working",
  complete: "Ready",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};

export const CONNECTION_NOTICE_DELAY_MS = 5_000;

export function ConnectionBanner({ connection }: { readonly connection: ConnectionState }) {
  const [visible, setVisible] = useState(connection === "offline");

  useEffect(() => {
    if (connection === "live") {
      setVisible(false);
      return;
    }
    if (connection === "offline") {
      setVisible(true);
      return;
    }
    setVisible(false);
    const timer = window.setTimeout(() => setVisible(true), CONNECTION_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [connection]);

  if (!visible || connection === "live") return null;
  return (
    <div className="connection-banner" role="status">
      <span className="connection-pulse" />
      {connection === "offline"
        ? "You’re offline. Existing conversations remain readable; you can send again after reconnecting."
        : "Live updates are reconnecting. The agent keeps working on the server."}
    </div>
  );
}

function ConversationTitle() {
  const { selectedThread, renameThread } = useConsoleStore();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(selectedThread?.title ?? "New conversation");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitle(selectedThread?.title ?? "New conversation");
    setEditing(false);
  }, [selectedThread?.id, selectedThread?.title]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (!selectedThread) return;
    const next = title.trim();
    if (!next) {
      setTitle(selectedThread.title);
      return;
    }
    if (next !== selectedThread.title) {
      void renameThread(selectedThread.id, next).catch(() => undefined);
    }
  };

  const triggerBadge = selectedThread?.trigger ? (
    <span className="trigger-badge trigger-badge-header" aria-label={`${selectedThread.trigger.kind} notification`}>
      {selectedThread.trigger.kind}
    </span>
  ) : null;

  if (editing && selectedThread) {
    return (
      <div className="conversation-title-group">
        <input
          ref={inputRef}
          className="title-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setTitle(selectedThread.title);
              setEditing(false);
            }
          }}
          maxLength={120}
          aria-label="Conversation title"
        />
        {triggerBadge}
      </div>
    );
  }

  return (
    <div className="conversation-title-group">
      <button
        type="button"
        className="conversation-title"
        onClick={() => selectedThread && setEditing(true)}
        disabled={!selectedThread}
        title={selectedThread ? "Rename conversation" : undefined}
      >
        {selectedThread?.title ?? "New conversation"}
      </button>
      {triggerBadge}
    </div>
  );
}

export function ModelControls() {
  const {
    model,
    effort,
    modelOptions,
    effortOptions,
    setModel,
    setEffort,
    selectedThread,
    selectedAgent,
    detail,
  } = useConsoleStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const disabled = selectedThread?.runState.status === "running";
  const effectiveModel = model || selectedAgent?.defaultModel;
  const usage = useMemo<ConsoleUsage | null>(() => {
    const projected = conversationConsoleUsage(detail, { selectedModel: effectiveModel });
    if (projected !== null) return projected;
    if (selectedThread === null) return null;
    return {
      context: selectedThread.runState.status === "running"
        ? {
            status: "updating",
            reason: "The conversation is loading while the current turn updates context.",
          }
        : {
            status: "unavailable",
            reason: "Context measurements are loading for this conversation.",
          },
    };
  }, [detail, effectiveModel, selectedThread]);

  useEffect(() => {
    const openSettings = () => setSettingsOpen(true);
    window.addEventListener("mono-agent:run-settings", openSettings);
    return () => {
      window.removeEventListener("mono-agent:run-settings", openSettings);
    };
  }, []);

  const selectorModels = useMemo<readonly ModelSelectorOption[]>(() => {
    if (!selectedAgent) return [];
    const effortChoices = (reference: string): readonly ModelSelectorEffortOption[] => {
      const effectiveReference = reference || selectedAgent.defaultModel || modelOptions[0] || "";
      const toggle = selectedAgent.modelOptions?.[effectiveReference]?.reasoningMode === "toggle";
      const levels = effortLevelsForAgentModel(selectedAgent, effectiveReference);
      if (levels.length === 0) return [];
      return [
        { id: "", name: "Automatic" },
        ...levels.map((level) => ({
          id: level,
          name: toggle
            ? level === "none" ? "Off" : "On"
            : effortName(level),
        })),
      ];
    };
    return [
      {
        id: "",
        name: "Automatic model",
        description: selectedAgent.defaultModel
          ? `Agent default · ${selectedAgent.modelOptions?.[selectedAgent.defaultModel]?.label ?? selectedAgent.defaultModel}`
          : "Use the agent default",
        efforts: effortChoices(""),
      },
      ...modelOptions.map((reference) => ({
        id: reference,
        name: selectedAgent.modelOptions?.[reference]?.label ?? reference,
        description: reference,
        efforts: effortChoices(reference),
      })),
    ];
  }, [modelOptions, selectedAgent]);

  const hasSettings = modelOptions.length > 0 || effortOptions.length > 0;
  return (
    <div className="model-controls" aria-label="Run settings">
      {usage && (
        <ContextDisplay
          context={usage.context}
          processed={usage.processed}
          conversationCost={usage.cost}
        />
      )}
      {hasSettings && (
        <ModelSelector
          models={selectorModels}
          value={model}
          effort={effort}
          onValueChange={setModel}
          onEffortChange={setEffort}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          disabled={disabled}
        />
      )}
    </div>
  );
}

const effortName = (effort: string): string => ({
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
}[effort] ?? effort);

function EmptyConversation() {
  const { selectedAgent, createThread, selectedThread } = useConsoleStore();
  return (
    <ThreadPrimitive.Empty>
      <div className="chat-empty">
        <div className="empty-orbit" aria-hidden="true">
          <span />
          <Icon name="spark" size={22} />
        </div>
        <span className="eyebrow">{selectedAgent?.label ?? "mono-agent"}</span>
        <h2>{selectedThread ? "What should we work on?" : "Start a new conversation"}</h2>
        <p>
          {selectedAgent
            ? "Messages, reasoning, tool calls, and files stay together in this conversation."
            : "No agents have been discovered yet. Start an agent and it will appear here automatically."}
        </p>
        {selectedAgent && !selectedThread && (
          <button
            type="button"
            className="primary-button"
            onClick={() => void createThread().catch(() => undefined)}
          >
            <Icon name="new" size={16} />
            New conversation
          </button>
        )}
      </div>
    </ThreadPrimitive.Empty>
  );
}

export function Chat({
  onOpenAgents,
  onOpenThreads,
}: {
  readonly onOpenAgents: () => void;
  readonly onOpenThreads: () => void;
}) {
  const {
    selectedAgent,
    selectedThread,
    connection,
    detailLoading,
    archiveThread,
    unarchiveThread,
    deleteThread,
  } = useConsoleStore();
  const runStatus = selectedThread?.runState.status;
  const runNeedsAttention =
    runStatus === "running" ||
    runStatus === "failed" ||
    runStatus === "cancelled" ||
    runStatus === "interrupted";
  const status =
    selectedAgent?.status === "offline"
      ? "Offline"
      : connection === "offline"
        ? "Browser offline"
        : connection === "reconnecting"
          ? "Reconnecting"
          : runNeedsAttention && runStatus
            ? runLabel[runStatus]
            : selectedAgent?.status === "degraded"
              ? "Degraded"
              : selectedThread
                ? runLabel[selectedThread.runState.status]
                : "Ready";
  const statusTone =
    status === "Ready" ? "ready" : status === "Working" ? "working" : status.toLowerCase();

  return (
    <main className="chat-panel">
      <header className="chat-header">
        <div className="mobile-navigation">
          <button type="button" className="icon-button" onClick={onOpenAgents} aria-label="Choose agent">
            <Icon name="agent" size={19} />
          </button>
          <button type="button" className="icon-button" onClick={onOpenThreads} aria-label="Open conversations">
            <Icon name="menu" size={19} />
          </button>
        </div>
        <div className="chat-title-block">
          <ConversationTitle />
          <span className={`chat-status is-${statusTone}`}>
            <i />
            {status}
          </span>
        </div>
        <div className="chat-header-actions">
          <ModelControls />
          <NotificationBell />
          {selectedThread && (
            <button
              type="button"
              className="icon-button header-archive"
              aria-label={selectedThread.archivedAt ? "Restore conversation" : "Archive conversation"}
              title={selectedThread.archivedAt ? "Restore conversation" : "Archive conversation"}
              onClick={() => {
                const action = selectedThread.archivedAt
                  ? unarchiveThread(selectedThread.id)
                  : archiveThread(selectedThread.id);
                void action.catch(() => undefined);
              }}
            >
              <Icon name={selectedThread.archivedAt ? "restore" : "archive"} size={17} />
            </button>
          )}
          {selectedThread?.archivedAt && (
            <button
              type="button"
              className="icon-button header-delete"
              aria-label="Permanently delete conversation"
              title="Permanently delete conversation"
              onClick={() => {
                if (!window.confirm("Permanently delete this conversation and its attachments? This cannot be undone.")) return;
                void deleteThread(selectedThread.id).catch(() => undefined);
              }}
            >
              <Icon name="trash" size={17} />
            </button>
          )}
        </div>
      </header>
      <ConnectionBanner connection={connection} />
      <ThreadPrimitive.Root className="thread-root">
        <SelectionToolbar />
        <ThreadPrimitive.Viewport className="thread-viewport" autoScroll>
          <div className="message-column">
            <EmptyConversation />
            <ThreadPrimitive.Messages
              components={{
                UserMessage,
                AssistantMessage,
                SystemMessage,
              }}
            />
          </div>
          <ThreadPrimitive.ScrollToBottom className="scroll-bottom" aria-label="Scroll to latest message">
            <Icon name="arrow-down" size={16} />
          </ThreadPrimitive.ScrollToBottom>
          <ThreadPrimitive.ViewportFooter className="thread-footer">
            {selectedThread?.archivedAt ? (
              <div className="archived-footer">
                <span>This conversation is archived.</span>
                <button
                  type="button"
                  onClick={() => void unarchiveThread(selectedThread.id).catch(() => undefined)}
                >
                  Restore to continue
                </button>
              </div>
            ) : (
              <Composer />
            )}
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
        {detailLoading && selectedThread && (
          <div className="detail-loading" role="status" aria-label="Loading conversation">
            <span />
          </div>
        )}
      </ThreadPrimitive.Root>
    </main>
  );
}
