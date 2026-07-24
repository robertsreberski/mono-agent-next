import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import {
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Chat } from "./chat";
import { dismissPopovers } from "./components/Popover";
import { useConsole } from "./console";
import { requestNotificationPermission } from "./notifications";
import { ShellIcon } from "./shell-icons";
import type { Thread } from "./types";

const FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function useModalFocus(
  open: boolean,
  rootRef: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  const restoreRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusTimer = window.setTimeout(() => {
      rootRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }, 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || rootRef.current === null) return;
      const focusable = [...rootRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
      );
      if (focusable.length === 0) {
        event.preventDefault();
        rootRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !rootRef.current.contains(active))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !rootRef.current.contains(active))) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      const restore = restoreRef.current;
      if (restore?.isConnected) restore.focus();
      restoreRef.current = null;
    };
  }, [onClose, open, rootRef]);
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function Login() {
  const consoleState = useConsole();
  const [token, setToken] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim().length < 16) return;
    void consoleState.login(token);
  };
  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <BrandMark />
        <span className="eyebrow">mono-agent Console</span>
        <h1>Connect to your agents</h1>
        <p>Enter the bearer token from this web service’s private configuration. It stays in this browser tab.</p>
        <label>
          <span>Web token</span>
          <input
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="At least 16 characters"
            autoFocus
          />
        </label>
        {consoleState.error && <p className="login-error" role="alert">{consoleState.error}</p>}
        <button className="primary" type="submit" disabled={token.trim().length < 16}>Open console</button>
      </form>
    </main>
  );
}

function AgentRail({
  mobile = false,
  onSelect,
  onClose,
}: {
  readonly mobile?: boolean;
  readonly onSelect?: () => void;
  readonly onClose?: () => void;
}) {
  const consoleState = useConsole();
  const expanded = mobile || consoleState.railExpanded;
  return (
    <nav
      className={`agent-rail${expanded ? " is-expanded" : ""}${mobile ? " is-mobile" : ""}`}
      aria-label="Agents"
    >
      <div className="rail-brand" title="mono-agent">
        <BrandMark />
        <span className="rail-brand-copy">mono-agent</span>
        {mobile && (
          <button
            type="button"
            className="drawer-close"
            aria-label="Close agent navigation"
            onClick={onClose}
          >
            <ShellIcon name="close" size={16} />
          </button>
        )}
      </div>
      <div className="agent-list" role="list">
        {consoleState.visibleAgents.map((agent) => (
          <div className="agent-item" role="listitem" key={agent.id}>
            <button
              type="button"
              className={`agent-button${agent.id === consoleState.selectedAgentId ? " is-active" : ""}`}
              onClick={() => {
                void consoleState.selectAgent(agent.id);
                onSelect?.();
              }}
              aria-pressed={agent.id === consoleState.selectedAgentId}
              aria-label={`${agent.label}, ${agent.online ? "online" : "offline"}${agent.pinned ? ", pinned" : ""}`}
              title={`${agent.label} · ${agent.online ? "online" : "offline"}`}
            >
              <span className="agent-avatar-wrap">
                <span className="agent-avatar">{initials(agent.label)}</span>
                <span className={`agent-status${agent.online ? " is-online" : " is-offline"}`} />
              </span>
              <span className="agent-label">{agent.label}</span>
            </button>
            <button
              type="button"
              className={`agent-pin${agent.pinned ? " is-pinned" : ""}`}
              aria-pressed={agent.pinned}
              aria-label={`${agent.pinned ? "Unpin" : "Pin"} ${agent.label}`}
              title={agent.pinned ? "Remove from favorites" : "Add to favorites"}
              onClick={() => void consoleState.patchAgent(agent.id, !agent.pinned)}
            >
              <ShellIcon name="star" size={14} fill={agent.pinned ? "currentColor" : "none"} />
            </button>
          </div>
        ))}
        {consoleState.visibleAgents.length === 0 && (
          <span className="rail-empty" title="No agents discovered">
            <ShellIcon name="agents" size={19} />
          </span>
        )}
        {consoleState.hiddenOfflineCount > 0 && (
          <button
            type="button"
            className={`rail-offline-toggle${consoleState.showOffline ? " is-active" : ""}`}
            aria-pressed={consoleState.showOffline}
            aria-label={consoleState.showOffline
              ? "Hide offline agents"
              : `Show ${consoleState.hiddenOfflineCount} offline agents`}
            title={consoleState.showOffline ? "Hide offline agents" : `Show ${consoleState.hiddenOfflineCount} offline`}
            onClick={() => consoleState.setShowOffline(!consoleState.showOffline)}
          >
            <ShellIcon name={consoleState.showOffline ? "eye-off" : "eye"} size={16} />
            <span className="rail-control-copy">
              {consoleState.showOffline ? "Hide offline" : `Show ${consoleState.hiddenOfflineCount} offline`}
            </span>
            {!expanded && <span className="rail-offline-count">{consoleState.hiddenOfflineCount}</span>}
          </button>
        )}
      </div>
      {!mobile && (
        <button
          type="button"
          className="rail-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse agent rail" : "Expand agent rail"}
          title={expanded ? "Collapse agent rail" : "Expand agent rail"}
          onClick={() => consoleState.setRailExpanded(!expanded)}
        >
          <ShellIcon name="chevron" size={17} />
          <span className="rail-control-copy">{expanded ? "Collapse" : "Expand"}</span>
        </button>
      )}
      {consoleState.tokenAuthentication && (
        <button
          type="button"
          className="rail-lock"
          aria-label="Lock console"
          title="Lock console"
          onClick={consoleState.logout}
        >
          <ShellIcon name="lock" size={17} />
          <span className="rail-control-copy">Lock console</span>
        </button>
      )}
      <span
        className={`rail-connection${consoleState.refreshing ? " is-syncing" : " is-live"}`}
        role="status"
        aria-label={consoleState.refreshing ? "Console syncing" : "Console connected"}
        title={consoleState.refreshing ? "Syncing" : "Connected"}
      />
    </nav>
  );
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
          {thread.status === "running" && <i className="thread-running" aria-label="Agent is responding" />}
          <span>{thread.status === "running" ? "Agent is responding…" : thread.proactive ? "Proactive conversation" : "Conversation"}</span>
        </span>
      </ThreadListItemPrimitive.Trigger>
      {archived ? (
        <ThreadListItemPrimitive.Unarchive
          className="thread-action"
          aria-label={`Restore ${thread.title}`}
          title="Restore conversation"
        >
          <ShellIcon name="restore" size={15} />
        </ThreadListItemPrimitive.Unarchive>
      ) : (
        <ThreadListItemPrimitive.Archive
          className="thread-action"
          aria-label={`Archive ${thread.title}`}
          title="Archive conversation"
        >
          <ShellIcon name="archive" size={15} />
        </ThreadListItemPrimitive.Archive>
      )}
    </ThreadListItemPrimitive.Root>
  );
}

function ThreadSidebar({
  onSelect,
  onClose,
}: {
  readonly onSelect?: () => void;
  readonly onClose?: () => void;
}) {
  const consoleState = useConsole();
  const agent = consoleState.selectedAgent;
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const threadById = useMemo(
    () => new Map(consoleState.visibleThreads.map((thread) => [thread.id, thread])),
    [consoleState.visibleThreads],
  );
  const matchingCount = consoleState.visibleThreads.filter(
    (thread) => !normalizedQuery || thread.title.toLocaleLowerCase().includes(normalizedQuery),
  ).length;
  const archivedCount = (consoleState.bootstrap?.threads ?? []).filter(
    (thread) => thread.agentId === consoleState.selectedAgentId && thread.archivedAt !== undefined,
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
              <ShellIcon name="close" size={16} />
            </button>
          )}
          <ThreadListPrimitive.New
            className="new-thread-button"
            aria-label="New conversation"
            title="New conversation"
            onClick={onSelect}
            disabled={!agent?.online}
          >
            <ShellIcon name="new" size={18} />
          </ThreadListPrimitive.New>
        </div>
      </header>
      <label className="thread-search">
        <ShellIcon name="search" size={16} />
        <span className="sr-only">Search conversations</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          type="search"
        />
        {query && (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
            <ShellIcon name="close" size={13} />
          </button>
        )}
      </label>
      <ThreadListPrimitive.Root className="thread-list">
        <div className="thread-list-scroll">
          <ThreadListPrimitive.Items archived={consoleState.showArchived}>
            {({ threadListItem }) => {
              const thread = threadById.get(threadListItem.id);
              if (thread === undefined) return null;
              if (normalizedQuery && !thread.title.toLocaleLowerCase().includes(normalizedQuery)) return null;
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
              <ShellIcon name={consoleState.showArchived ? "archive" : "threads"} size={19} />
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
      </ThreadListPrimitive.Root>
      <div className="sidebar-controls">
        <button
          type="button"
          className={`archive-toggle${consoleState.showArchived ? " is-active" : ""}`}
          onClick={() => consoleState.setShowArchived(!consoleState.showArchived)}
        >
          <ShellIcon name={consoleState.showArchived ? "threads" : "archive"} size={16} />
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
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    "Notification" in window ? Notification.permission : "unsupported"
  );
  useEffect(() => {
    if ("Notification" in window) setPermission(Notification.permission);
  }, []);
  return (
    <div className="sidebar-utilities">
      {permission !== "unsupported" && permission !== "granted" && (
        <button
          type="button"
          aria-label="Enable notifications"
          title="Enable notifications"
          onClick={() => void requestNotificationPermission().then(setPermission)}
        >
          <ShellIcon name="bell" size={15} />
        </button>
      )}
      <button
        type="button"
        className={consoleState.refreshing ? "is-refreshing" : ""}
        aria-label={consoleState.refreshing ? "Syncing console" : "Refresh console"}
        title={consoleState.refreshing ? "Syncing…" : "Refresh"}
        onClick={() => void consoleState.retry()}
      >
        <ShellIcon name="refresh" size={15} />
      </button>
    </div>
  );
}

function ConsoleShell() {
  const consoleState = useConsole();
  const [agentDrawer, setAgentDrawer] = useState(false);
  const [threadDrawer, setThreadDrawer] = useState(false);
  const agentDrawerRef = useRef<HTMLElement>(null);
  const threadDrawerRef = useRef<HTMLElement>(null);
  const closeDrawers = useCallback(() => {
    setAgentDrawer(false);
    setThreadDrawer(false);
  }, []);
  const navigationModalOpen = agentDrawer || threadDrawer;
  useModalFocus(agentDrawer, agentDrawerRef, closeDrawers);
  useModalFocus(threadDrawer, threadDrawerRef, closeDrawers);
  useEffect(() => {
    document.body.toggleAttribute("data-console-modal-open", navigationModalOpen);
    return () => document.body.removeAttribute("data-console-modal-open");
  }, [navigationModalOpen]);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const desktop = window.matchMedia("(min-width: 901px)");
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) closeDrawers();
    };
    if (desktop.matches) closeDrawers();
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, [closeDrawers]);
  if (consoleState.loading && consoleState.bootstrap === undefined) {
    return <main className="loading-page"><BrandMark /><span>Discovering agents…</span></main>;
  }
  return (
    <div className={`console-shell${consoleState.railExpanded ? " rail-expanded" : " rail-collapsed"}`}>
      <nav
        className="mobile-navigation"
        aria-label="Console navigation"
        aria-hidden={navigationModalOpen || undefined}
        inert={navigationModalOpen}
      >
        <button
          type="button"
          aria-label="Choose agent"
          title="Choose agent"
          onClick={() => {
            dismissPopovers();
            setThreadDrawer(false);
            setAgentDrawer(true);
          }}
        >
          <ShellIcon name="agents" size={18} />
        </button>
        <button
          type="button"
          aria-label="Open conversations"
          title="Open conversations"
          onClick={() => {
            dismissPopovers();
            setAgentDrawer(false);
            setThreadDrawer(true);
          }}
        >
          <ShellIcon name="menu" size={18} />
        </button>
      </nav>
      <div
        className="desktop-agent-rail"
        aria-hidden={navigationModalOpen || undefined}
        inert={navigationModalOpen}
      >
        <AgentRail />
      </div>
      <div
        className="desktop-thread-sidebar"
        aria-hidden={navigationModalOpen || undefined}
        inert={navigationModalOpen}
      >
        <ThreadSidebar />
      </div>
      <Chat backgroundInert={navigationModalOpen} />
      {navigationModalOpen && (
        <div
          className="drawer-scrim"
          aria-hidden="true"
          onPointerDown={closeDrawers}
        />
      )}
      {agentDrawer && (
        <aside
          ref={agentDrawerRef}
          className="mobile-drawer mobile-agent-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Choose agent"
          tabIndex={-1}
        >
          <AgentRail mobile onSelect={closeDrawers} onClose={closeDrawers} />
        </aside>
      )}
      {threadDrawer && (
        <aside
          ref={threadDrawerRef}
          className="mobile-drawer mobile-thread-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Conversations"
          tabIndex={-1}
        >
          <ThreadSidebar onSelect={closeDrawers} onClose={closeDrawers} />
        </aside>
      )}
    </div>
  );
}

export function App() {
  const consoleState = useConsole();
  return consoleState.authenticated ? <ConsoleShell /> : <Login />;
}

function initials(label: string): string {
  return label.split(/[\s_-]+/u).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "A";
}

function relativeTime(value: string): string {
  const difference = Math.max(0, Date.now() - Date.parse(value));
  if (difference < 60_000) return "Now";
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)}m`;
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)}h`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
