// SPDX-License-Identifier: MIT
import { useMemo, useState } from "react";

import { useConsole } from "../console";
import type { Thread } from "../types";
import { Icon } from "./Icon";

const relativeTime = (date: string): string => {
  const elapsed = Math.max(0, Date.now() - Date.parse(date));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7
    ? `${days}d`
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(date));
};

/**
 * The web contract carries no message preview, so the secondary line reports
 * the run state it does know rather than inventing a snippet.
 */
const previewText = (thread: Thread): string => ({
  running: "Responding…",
  failed: "Last turn failed",
  cancelled: "Last turn stopped",
  interrupted: "Last turn interrupted",
  idle: "New conversation",
  complete: "Ready",
}[thread.status]);

function ThreadListItem({
  thread,
  active,
  onSelect,
}: {
  readonly thread: Thread;
  readonly active: boolean;
  readonly onSelect?: () => void;
}) {
  const consoleState = useConsole();
  const archived = thread.archivedAt !== undefined;
  const running = thread.status === "running";
  return (
    <div className={`thread-item${active ? " is-active" : ""}`}>
      <button
        type="button"
        className="thread-trigger"
        aria-label={`Open ${thread.title}`}
        aria-current={active || undefined}
        onClick={() => {
          consoleState.selectThread(thread.id);
          onSelect?.();
        }}
      >
        <span className="thread-title-line">
          <span className="thread-title">{thread.title}</span>
          {thread.trigger !== undefined && (
            <span className="trigger-badge" aria-label={`${thread.trigger.kind} notification`}>
              {thread.trigger.kind}
            </span>
          )}
          <time dateTime={thread.updatedAt}>{relativeTime(thread.updatedAt)}</time>
        </span>
        <span className="thread-preview">
          {running && <i className="thread-running" aria-label="Agent is responding" />}
          <span className="thread-preview-text">{previewText(thread)}</span>
        </span>
      </button>
      <button
        type="button"
        className="thread-action"
        aria-label={`${archived ? "Restore" : "Archive"} ${thread.title}`}
        title={`${archived ? "Restore" : "Archive"} conversation`}
        onClick={() => void consoleState.archiveThread(thread.id, !archived).catch(() => undefined)}
      >
        <Icon name={archived ? "restore" : "archive"} size={15} />
      </button>
    </div>
  );
}

export function ThreadSidebar({ onSelect }: { readonly onSelect?: () => void }) {
  const consoleState = useConsole();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const matching = useMemo(
    () => consoleState.visibleThreads.filter((thread) =>
      normalizedQuery.length === 0 || thread.title.toLowerCase().includes(normalizedQuery)),
    [consoleState.visibleThreads, normalizedQuery],
  );
  const archivedCount = (consoleState.bootstrap?.threads ?? []).filter((thread) =>
    thread.agentId === consoleState.selectedAgentId && thread.archivedAt !== undefined).length;

  return (
    <aside className="thread-sidebar" aria-label="Conversations">
      <div className="sidebar-header">
        <div>
          <span className="eyebrow">Conversations</span>
          <h1>{consoleState.selectedAgent?.label ?? "No agent"}</h1>
        </div>
        <button
          type="button"
          className="new-thread-button"
          aria-label="New conversation"
          title="New conversation (⌘⇧O)"
          disabled={consoleState.selectedAgent?.online !== true}
          onClick={() => {
            void consoleState.createThread().catch(() => undefined);
            onSelect?.();
          }}
        >
          <Icon name="new" size={18} />
        </button>
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
      <div className="thread-list">
        <div className="thread-list-scroll">
          {matching.map((thread) => (
            <ThreadListItem
              key={thread.id}
              thread={thread}
              active={thread.id === consoleState.selectedThreadId}
              {...(onSelect === undefined ? {} : { onSelect })}
            />
          ))}
          {matching.length === 0 && (
            <div className="thread-list-empty">
              <Icon name={consoleState.showArchived ? "archive" : "threads"} size={19} />
              <span>
                {normalizedQuery
                  ? "No matching conversations"
                  : consoleState.showArchived
                    ? "No archived conversations"
                    : "Start a conversation"}
              </span>
            </div>
          )}
        </div>
      </div>
      <button
        type="button"
        className={`archive-toggle${consoleState.showArchived ? " is-active" : ""}`}
        onClick={() => consoleState.setShowArchived(!consoleState.showArchived)}
      >
        <Icon name={consoleState.showArchived ? "threads" : "archive"} size={16} />
        <span>{consoleState.showArchived ? "Back to conversations" : "Archived"}</span>
        <span className="archive-count">{archivedCount || ""}</span>
      </button>
    </aside>
  );
}
