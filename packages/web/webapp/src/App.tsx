import { type FormEvent, useEffect, useState } from "react";

import { Chat } from "./chat";
import { useConsole } from "./console";
import { requestNotificationPermission } from "./notifications";

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
        <div className="brand-mark">m</div>
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

function AgentRail() {
  const consoleState = useConsole();
  return (
    <aside className={`agent-rail${consoleState.railExpanded ? " is-expanded" : ""}`}>
      <header>
        <div className="brand-mark">m</div>
        {consoleState.railExpanded && <strong>mono-agent</strong>}
        <button
          type="button"
          className="rail-toggle"
          aria-label={consoleState.railExpanded ? "Collapse agent rail" : "Expand agent rail"}
          onClick={() => consoleState.setRailExpanded(!consoleState.railExpanded)}
        >{consoleState.railExpanded ? "‹" : "›"}</button>
      </header>
      <nav aria-label="Agents">
        {consoleState.visibleAgents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className={`agent-button${agent.id === consoleState.selectedAgentId ? " is-selected" : ""}`}
            onClick={() => consoleState.selectAgent(agent.id)}
            title={`${agent.label} · ${agent.online ? "online" : "offline"}`}
          >
            <span className="agent-avatar">{initials(agent.label)}</span>
            {consoleState.railExpanded && (
              <span className="agent-copy">
                <strong>{agent.label}</strong>
                <small className={agent.online ? "online" : "offline"}>{agent.online ? "Online" : "Offline"}</small>
              </span>
            )}
          </button>
        ))}
      </nav>
      <footer>
        {consoleState.hiddenOfflineCount > 0 && (
          <button type="button" onClick={() => consoleState.setShowOffline(!consoleState.showOffline)}>
            {consoleState.railExpanded
              ? consoleState.showOffline ? "Hide offline" : `Show offline (${consoleState.hiddenOfflineCount})`
              : "◉"}
          </button>
        )}
        <button type="button" onClick={consoleState.logout}>{consoleState.railExpanded ? "Lock console" : "⌁"}</button>
      </footer>
    </aside>
  );
}

function ThreadSidebar() {
  const consoleState = useConsole();
  const agent = consoleState.selectedAgent;
  return (
    <aside className="thread-sidebar">
      <header>
        <div>
          <span className="eyebrow">Workspace</span>
          <h2>{agent?.label ?? "Agents"}</h2>
        </div>
        {agent && (
          <button
            type="button"
            className={`pin-button${agent.pinned ? " is-pinned" : ""}`}
            title={agent.pinned ? "Unpin agent" : "Pin agent"}
            onClick={() => void consoleState.patchAgent(agent.id, !agent.pinned)}
          >★</button>
        )}
      </header>
      <button
        className="new-thread"
        type="button"
        disabled={!agent?.online}
        onClick={() => void consoleState.createThread()}
      >＋ New conversation</button>
      <div className="thread-filter">
        <button
          type="button"
          className={!consoleState.showArchived ? "is-selected" : ""}
          onClick={() => consoleState.setShowArchived(false)}
        >Active</button>
        <button
          type="button"
          className={consoleState.showArchived ? "is-selected" : ""}
          onClick={() => consoleState.setShowArchived(true)}
        >Archived</button>
      </div>
      <nav className="thread-list" aria-label="Conversations">
        {consoleState.visibleThreads.map((thread) => (
          <button
            key={thread.id}
            type="button"
            className={thread.id === consoleState.selectedThreadId ? "is-selected" : ""}
            onClick={() => consoleState.selectThread(thread.id)}
          >
            <span>
              <strong>{thread.title}</strong>
              <small>
                {thread.trigger?.kind && <em>{thread.trigger.kind}</em>}
                {thread.status === "running" ? "Responding…" : relativeTime(thread.updatedAt)}
              </small>
            </span>
            {thread.status === "running" && <i className="run-dot" />}
          </button>
        ))}
        {consoleState.visibleThreads.length === 0 && (
          <p>{consoleState.showArchived ? "No archived conversations." : "No active conversations."}</p>
        )}
      </nav>
      <ConsoleUtilities />
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
    <footer className="sidebar-footer">
      {permission !== "unsupported" && permission !== "granted" && (
        <button
          type="button"
          onClick={() => void requestNotificationPermission().then(setPermission)}
        >Enable notifications</button>
      )}
      {consoleState.refreshing && <span role="status">Syncing…</span>}
      <button type="button" onClick={() => void consoleState.retry()}>Refresh</button>
    </footer>
  );
}

function ConsoleShell() {
  const consoleState = useConsole();
  if (consoleState.loading && consoleState.bootstrap === undefined) {
    return <main className="loading-page"><div className="brand-mark">m</div><span>Discovering agents…</span></main>;
  }
  return (
    <div className={`console-shell${consoleState.railExpanded ? " rail-expanded" : " rail-collapsed"}`}>
      <AgentRail />
      <ThreadSidebar />
      <Chat />
    </div>
  );
}

export function App() {
  const consoleState = useConsole();
  return consoleState.authenticated ? <ConsoleShell /> : <Login />;
}

function initials(label: string): string {
  return label.split(/\s+/u).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "A";
}

function relativeTime(value: string): string {
  const difference = Math.max(0, Date.now() - Date.parse(value));
  if (difference < 60_000) return "Now";
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)}m`;
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)}h`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
