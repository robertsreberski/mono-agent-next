import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { useMemo, useState } from "react";

import { useConsole } from "../console";
import type { Thread } from "../types";
import { Icon } from "./Icon";

export function threadMatchesQuery(thread: Thread, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return !normalized || thread.title.toLocaleLowerCase().includes(normalized);
}

function ThreadListItem({
  thread,
  archived,
  onSelect,
}: {
  readonly thread: Thread;
  readonly archived: boolean;
  readonly onSelect?: () => void;
}) {
  const isActive = useAuiState(
    (state) => state.threads.mainThreadId === state.threadListItem.id,
  );
  return (
    <ThreadListItemPrimitive.Root className={`thread-item${isActive ? " is-active" : ""}`}>
      <ThreadListItemPrimitive.Trigger
        className="thread-trigger"
        aria-label={`Open ${thread.title}`}
        onClick={onSelect}
      >
        <span className="thread-title-line">
          <span className="thread-title">
            <ThreadListItemPrimitive.Title fallback="Untitled conversation" />
          </span>
          {thread.trigger?.kind && <span className="trigger-badge">{thread.trigger.kind}</span>}
          <time dateTime={thread.updatedAt}>{relativeTime(thread.updatedAt)}</time>
        </span>
        <span className="thread-preview">
          {thread.status === "running" && (
            <i className="thread-running" aria-label="Agent is responding" />
          )}
          <span>
            {thread.status === "running"
              ? "Agent is responding…"
              : thread.proactive
                ? "Proactive conversation"
                : "Conversation"}
          </span>
        </span>
      </ThreadListItemPrimitive.Trigger>
      {archived ? (
        <ThreadListItemPrimitive.Unarchive
          className="thread-action"
          aria-label={`Restore ${thread.title}`}
          title="Restore conversation"
        >
          <Icon name="restore" size={15} />
        </ThreadListItemPrimitive.Unarchive>
      ) : (
        <ThreadListItemPrimitive.Archive
          className="thread-action"
          aria-label={`Archive ${thread.title}`}
          title="Archive conversation"
        >
          <Icon name="archive" size={15} />
        </ThreadListItemPrimitive.Archive>
      )}
    </ThreadListItemPrimitive.Root>
  );
}

export function ThreadSidebar({
  onSelect,
  onClose,
}: {
  readonly onSelect?: () => void;
  readonly onClose?: () => void;
}) {
  const consoleState = useConsole();
  const agent = consoleState.selectedAgent;
  const [query, setQuery] = useState("");
  const threadById = useMemo(
    () => new Map(consoleState.visibleThreads.map((thread) => [thread.id, thread])),
    [consoleState.visibleThreads],
  );
  const matchingCount = consoleState.visibleThreads.filter(
    (thread) => threadMatchesQuery(thread, query),
  ).length;
  const archivedCount = (consoleState.bootstrap?.threads ?? []).filter(
    (thread) =>
      thread.agentId === consoleState.selectedAgentId
      && thread.archivedAt !== undefined,
  ).length;

  return (
    <aside className="thread-sidebar" aria-label="Conversations">
      <header className="sidebar-header">
        <div>
          <span className="eyebrow">Conversations</span>
          <h1>{agent?.label ?? "No agent"}</h1>
        </div>
        <div className="sidebar-header-actions">
          {onClose && (
            <button
              type="button"
              className="drawer-close"
              aria-label="Close conversations"
              onClick={onClose}
            >
              <Icon name="close" size={16} />
            </button>
          )}
          <ThreadListPrimitive.New
            className="new-thread-button"
            aria-label="New conversation"
            title="New conversation (⌘⇧O)"
            onClick={onSelect}
            disabled={!agent?.online}
          >
            <Icon name="new" size={18} />
          </ThreadListPrimitive.New>
        </div>
      </header>
      <label className="thread-search">
        <Icon name="search" size={16} />
        <span className="sr-only">Search conversations</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          type="search"
        />
        {query && (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
            <Icon name="close" size={13} />
          </button>
        )}
      </label>
      <ThreadListPrimitive.Root className="thread-list">
        <div className="thread-list-scroll">
          <ThreadListPrimitive.Items archived={consoleState.showArchived}>
            {({ threadListItem }) => {
              const thread = threadById.get(threadListItem.id);
              if (thread === undefined || !threadMatchesQuery(thread, query)) return null;
              return (
                <ThreadListItem
                  thread={thread}
                  archived={consoleState.showArchived}
                  {...(onSelect === undefined ? {} : { onSelect })}
                />
              );
            }}
          </ThreadListPrimitive.Items>
          {matchingCount === 0 && (
            <div className="thread-list-empty">
              <Icon name={consoleState.showArchived ? "archive" : "threads"} size={19} />
              <span>
                {query.trim()
                  ? "No matching conversations"
                  : consoleState.showArchived
                    ? "No archived conversations"
                    : "Start a conversation"}
              </span>
            </div>
          )}
        </div>
      </ThreadListPrimitive.Root>
      <div className="sidebar-controls">
        <button
          type="button"
          className={`archive-toggle${consoleState.showArchived ? " is-active" : ""}`}
          onClick={() => consoleState.setShowArchived(!consoleState.showArchived)}
        >
          <Icon name={consoleState.showArchived ? "threads" : "archive"} size={16} />
          <span>{consoleState.showArchived ? "Back to conversations" : "Archived"}</span>
          <span className="archive-count">{archivedCount || ""}</span>
        </button>
        <ConsoleUtilities />
      </div>
    </aside>
  );
}

function ConsoleUtilities() {
  const consoleState = useConsole();
  return (
    <div className="sidebar-utilities">
      <button
        type="button"
        className={consoleState.refreshing ? "is-refreshing" : ""}
        aria-label={consoleState.refreshing ? "Syncing console" : "Refresh console"}
        title={consoleState.refreshing ? "Syncing…" : "Refresh"}
        onClick={() => void consoleState.retry()}
      >
        <Icon name="refresh" size={15} />
      </button>
    </div>
  );
}

export function relativeTime(value: string, now = Date.now()): string {
  const difference = Math.max(0, now - Date.parse(value));
  if (difference < 60_000) return "Now";
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)}m`;
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)}h`;
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
