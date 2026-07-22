import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { useMemo, useState } from "react";
import { useConsoleStore } from "../console-store";
import type { ThreadSummary } from "../types";
import { Icon } from "./Icon";

const relativeTime = (date: string): string => {
  const elapsed = Math.max(0, Date.now() - Date.parse(date));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(date));
};

function ThreadListItem({
  thread,
  archived,
}: {
  readonly thread: ThreadSummary;
  readonly archived: boolean;
}) {
  const isActive = useAuiState(
    (state) => state.threads.mainThreadId === state.threadListItem.id,
  );
  const running = thread.runState.status === "running";
  return (
    <ThreadListItemPrimitive.Root
      className={`thread-item${isActive ? " is-active" : ""}`}
    >
      <ThreadListItemPrimitive.Trigger
        className="thread-trigger"
        aria-label={`Open ${thread.title}`}
      >
        <span className="thread-title-line">
          <span className="thread-title">
            <ThreadListItemPrimitive.Title fallback="Untitled conversation" />
          </span>
          {thread.trigger && (
            <span className="trigger-badge" aria-label={`${thread.trigger.kind} notification`}>
              {thread.trigger.kind}
            </span>
          )}
          <time dateTime={thread.updatedAt}>{relativeTime(thread.updatedAt)}</time>
        </span>
        <span className="thread-preview">
          {running && <i className="thread-running" aria-label="Agent is responding" />}
          <span className="thread-preview-text">
            {thread.lastMessagePreview || (thread.messageCount ? `${thread.messageCount} messages` : "New conversation")}
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

export function ThreadSidebar({ onSelect }: { readonly onSelect?: () => void }) {
  const {
    selectedAgent,
    threads,
    selectedAgentId,
    showArchived,
    setShowArchived,
  } = useConsoleStore();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  );
  const matchingCount = threads.filter(
    (thread) =>
      thread.sourceId === selectedAgentId &&
      Boolean(thread.archivedAt) === showArchived &&
      (!normalizedQuery ||
        thread.title.toLowerCase().includes(normalizedQuery) ||
        thread.lastMessagePreview?.toLowerCase().includes(normalizedQuery)),
  ).length;

  return (
    <aside className="thread-sidebar" aria-label="Conversations">
      <div className="sidebar-header">
        <div>
          <span className="eyebrow">Conversations</span>
          <h1>{selectedAgent?.label ?? "No agent"}</h1>
        </div>
        <ThreadListPrimitive.New
          className="new-thread-button"
          aria-label="New conversation"
          title="New conversation (⌘⇧O)"
          onClick={onSelect}
          disabled={!selectedAgent}
        >
          <Icon name="new" size={18} />
        </ThreadListPrimitive.New>
      </div>
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
        <div className="thread-list-scroll" onClick={onSelect}>
          <ThreadListPrimitive.Items archived={showArchived}>
            {({ threadListItem }) => {
              const thread = threadById.get(threadListItem.id);
              if (!thread) return null;
              const matches =
                !normalizedQuery ||
                thread.title.toLowerCase().includes(normalizedQuery) ||
                thread.lastMessagePreview?.toLowerCase().includes(normalizedQuery);
              return matches ? (
                <ThreadListItem thread={thread} archived={showArchived} />
              ) : null;
            }}
          </ThreadListPrimitive.Items>
          {matchingCount === 0 && (
            <div className="thread-list-empty">
              <Icon name={showArchived ? "archive" : "threads"} size={19} />
              <span>
                {normalizedQuery
                  ? "No matching conversations"
                  : showArchived
                    ? "No archived conversations"
                    : "Start a conversation"}
              </span>
            </div>
          )}
        </div>
      </ThreadListPrimitive.Root>
      <button
        type="button"
        className={`archive-toggle${showArchived ? " is-active" : ""}`}
        onClick={() => setShowArchived(!showArchived)}
      >
        <Icon name={showArchived ? "threads" : "archive"} size={16} />
        <span>{showArchived ? "Back to conversations" : "Archived"}</span>
        <span className="archive-count">
          {threads.filter(
            (thread) => thread.sourceId === selectedAgentId && Boolean(thread.archivedAt),
          ).length || ""}
        </span>
      </button>
    </aside>
  );
}
