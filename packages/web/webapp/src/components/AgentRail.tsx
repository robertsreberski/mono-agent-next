// SPDX-License-Identifier: MIT
import { useConsole } from "../console";
import { Icon } from "./Icon";

const initials = (label: string) =>
  label
    .split(/[\s_-]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "A";

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export function AgentRail({
  expanded = false,
  onToggleExpanded,
  onSelect,
}: {
  readonly expanded?: boolean;
  readonly onToggleExpanded?: () => void;
  readonly onSelect?: () => void;
}) {
  const {
    visibleAgents,
    connection,
    hiddenOfflineCount,
    selectedAgentId,
    showOffline,
    selectAgent,
    patchAgent,
    setShowOffline,
  } = useConsole();
  return (
    <nav className={`agent-rail${expanded ? " is-expanded" : ""}`} aria-label="Agents">
      <div className="rail-brand" title="mono-agent">
        <BrandMark />
        <span className="rail-brand-copy">mono-agent</span>
      </div>
      <div className="agent-list" role="list">
        {visibleAgents.map((agent) => {
          const pinned = Boolean(agent.pinned);
          const status = agent.online ? "online" : "offline";
          return (
            <div className="agent-item" role="listitem" key={agent.id}>
              <button
                type="button"
                className={`agent-button${selectedAgentId === agent.id ? " is-active" : ""}`}
                onClick={() => {
                  selectAgent(agent.id);
                  onSelect?.();
                }}
                aria-pressed={selectedAgentId === agent.id}
                aria-label={`${agent.label}, ${status}${pinned ? ", pinned" : ""}`}
                title={`${agent.label} · ${status}`}
              >
                <span className="agent-avatar-wrap">
                  <span className="agent-avatar">{initials(agent.label)}</span>
                  <span className={`agent-status is-${status}`} />
                </span>
                <span className="agent-label">{agent.label}</span>
              </button>
              <button
                type="button"
                className={`agent-pin${pinned ? " is-pinned" : ""}`}
                aria-pressed={pinned}
                aria-label={`${pinned ? "Unpin" : "Pin"} ${agent.label}`}
                title={`${pinned ? "Remove from" : "Add to"} favorites`}
                onClick={() => { void patchAgent(agent.id, !pinned).catch(() => {}); }}
              >
                <Icon name="star" size={14} fill={pinned ? "currentColor" : "none"} />
              </button>
            </div>
          );
        })}
        {visibleAgents.length === 0 && (
          <span className="rail-empty" title="No agents discovered">
            <Icon name="agent" size={19} />
          </span>
        )}
        {hiddenOfflineCount > 0 && (
          <button
            type="button"
            className={`rail-offline-toggle${showOffline ? " is-active" : ""}`}
            aria-pressed={showOffline}
            aria-label={showOffline
              ? "Hide offline agents"
              : `Show ${hiddenOfflineCount} offline agent${hiddenOfflineCount === 1 ? "" : "s"}`}
            title={showOffline ? "Hide offline agents" : `Show ${hiddenOfflineCount} offline`}
            onClick={() => setShowOffline(!showOffline)}
          >
            <Icon name={showOffline ? "eye-off" : "eye"} size={16} />
            <span className="rail-offline-copy">
              {showOffline ? "Hide offline" : `Show ${hiddenOfflineCount} offline`}
            </span>
            {!expanded && <span className="rail-offline-count">{hiddenOfflineCount}</span>}
          </button>
        )}
      </div>
      {onToggleExpanded && (
        <button
          type="button"
          className="rail-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse agent sidebar" : "Expand agent sidebar"}
          title={expanded ? "Collapse agent sidebar" : "Expand agent sidebar"}
          onClick={onToggleExpanded}
        >
          <Icon name="chevron" size={17} />
          <span className="rail-toggle-copy">{expanded ? "Collapse" : "Expand"}</span>
        </button>
      )}
      <button
        type="button"
        className="rail-command"
        aria-label="Open command palette"
        title="Command palette (⌘K)"
        onClick={() => window.dispatchEvent(new Event("mono-agent:command"))}
      >
        <Icon name="command" size={18} />
      </button>
      <span
        className={`rail-connection is-${connection}`}
        aria-label={`Console connection: ${connection}`}
        title={`Console ${connection}`}
      />
    </nav>
  );
}

export function MobileAgentPicker({ onSelect }: { readonly onSelect: () => void }) {
  const {
    visibleAgents,
    hiddenOfflineCount,
    selectedAgentId,
    showOffline,
    selectAgent,
    patchAgent,
    setShowOffline,
  } = useConsole();
  return (
    <aside className="mobile-agent-picker" aria-label="Choose an agent">
      <header>
        <BrandMark />
        <div>
          <span className="eyebrow">mono-agent</span>
          <h2>Agents</h2>
        </div>
      </header>
      <div className="mobile-agent-list">
        {visibleAgents.map((agent) => {
          const pinned = Boolean(agent.pinned);
          const status = agent.online ? "online" : "offline";
          return (
            <div className="mobile-agent-row" key={agent.id}>
              <button
                type="button"
                className={`mobile-agent-select${selectedAgentId === agent.id ? " is-active" : ""}`}
                aria-pressed={selectedAgentId === agent.id}
                aria-label={`${agent.label}, ${status}${pinned ? ", pinned" : ""}`}
                onClick={() => {
                  selectAgent(agent.id);
                  onSelect();
                }}
              >
                <span className="mobile-agent-avatar">{initials(agent.label)}</span>
                <span className="mobile-agent-copy">
                  <strong>{agent.label}</strong>
                  <small>{status}</small>
                </span>
                <span className={`agent-status is-${status}`} />
                {selectedAgentId === agent.id && <Icon name="check" size={16} />}
              </button>
              <button
                type="button"
                className={`mobile-agent-pin${pinned ? " is-pinned" : ""}`}
                aria-pressed={pinned}
                aria-label={`${pinned ? "Unpin" : "Pin"} ${agent.label}`}
                title={`${pinned ? "Remove from" : "Add to"} favorites`}
                onClick={() => { void patchAgent(agent.id, !pinned).catch(() => {}); }}
              >
                <Icon name="star" size={17} fill={pinned ? "currentColor" : "none"} />
              </button>
            </div>
          );
        })}
        {visibleAgents.length === 0 && (
          <p>No agents discovered. Running agents will appear automatically.</p>
        )}
        {hiddenOfflineCount > 0 && (
          <button
            type="button"
            className={`mobile-offline-toggle${showOffline ? " is-active" : ""}`}
            aria-pressed={showOffline}
            onClick={() => setShowOffline(!showOffline)}
          >
            <Icon name={showOffline ? "eye-off" : "eye"} size={16} />
            <span>
              {showOffline
                ? "Hide offline agents"
                : `Show ${hiddenOfflineCount} offline agent${hiddenOfflineCount === 1 ? "" : "s"}`}
            </span>
          </button>
        )}
      </div>
    </aside>
  );
}
