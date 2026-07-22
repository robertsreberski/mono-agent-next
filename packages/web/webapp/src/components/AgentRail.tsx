import { useConsoleStore } from "../console-store";
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
    hiddenOfflineAgentCount,
    selectedAgentId,
    showOfflineAgents,
    selectAgent,
    setAgentPinned,
    setShowOfflineAgents,
  } = useConsoleStore();
  return (
    <nav className={`agent-rail${expanded ? " is-expanded" : ""}`} aria-label="Agents">
      <div className="rail-brand" title="mono-agent">
        <BrandMark />
        <span className="rail-brand-copy">mono-agent</span>
      </div>
      <div className="agent-list" role="list">
        {visibleAgents.map((agent) => {
          const pinned = Boolean(agent.pinned);
          return (
            <div className="agent-item" role="listitem" key={agent.sourceId}>
              <button
                type="button"
                className={`agent-button${selectedAgentId === agent.sourceId ? " is-active" : ""}`}
                onClick={() => {
                  selectAgent(agent.sourceId);
                  onSelect?.();
                }}
                aria-pressed={selectedAgentId === agent.sourceId}
                aria-label={`${agent.label}, ${agent.status}${pinned ? ", pinned" : ""}`}
                title={`${agent.label} · ${agent.status}`}
              >
                <span className="agent-avatar-wrap">
                  <span className="agent-avatar">{initials(agent.label)}</span>
                  <span className={`agent-status is-${agent.status}`} />
                </span>
                <span className="agent-label">{agent.label}</span>
              </button>
              <button
                type="button"
                className={`agent-pin${pinned ? " is-pinned" : ""}`}
                aria-pressed={pinned}
                aria-label={`${pinned ? "Unpin" : "Pin"} ${agent.label}`}
                title={`${pinned ? "Remove from" : "Add to"} favorites`}
                onClick={() => { void setAgentPinned(agent.sourceId, !pinned).catch(() => {}); }}
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
        {hiddenOfflineAgentCount > 0 && (
          <button
            type="button"
            className={`rail-offline-toggle${showOfflineAgents ? " is-active" : ""}`}
            aria-pressed={showOfflineAgents}
            aria-label={showOfflineAgents
              ? "Hide offline agents"
              : `Show ${hiddenOfflineAgentCount} offline agent${hiddenOfflineAgentCount === 1 ? "" : "s"}`}
            title={showOfflineAgents ? "Hide offline agents" : `Show ${hiddenOfflineAgentCount} offline`}
            onClick={() => setShowOfflineAgents(!showOfflineAgents)}
          >
            <Icon name={showOfflineAgents ? "eye-off" : "eye"} size={16} />
            <span className="rail-offline-copy">
              {showOfflineAgents ? "Hide offline" : `Show ${hiddenOfflineAgentCount} offline`}
            </span>
            {!expanded && <span className="rail-offline-count">{hiddenOfflineAgentCount}</span>}
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
    hiddenOfflineAgentCount,
    selectedAgentId,
    showOfflineAgents,
    selectAgent,
    setAgentPinned,
    setShowOfflineAgents,
  } = useConsoleStore();
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
          return (
            <div className="mobile-agent-row" key={agent.sourceId}>
              <button
                type="button"
                className={`mobile-agent-select${selectedAgentId === agent.sourceId ? " is-active" : ""}`}
                aria-pressed={selectedAgentId === agent.sourceId}
                aria-label={`${agent.label}, ${agent.status}${pinned ? ", pinned" : ""}`}
                onClick={() => {
                  selectAgent(agent.sourceId);
                  onSelect();
                }}
              >
                <span className="mobile-agent-avatar">{initials(agent.label)}</span>
                <span className="mobile-agent-copy">
                  <strong>{agent.label}</strong>
                  <small>{agent.status === "degraded" ? "Available with warnings" : agent.status}</small>
                </span>
                <span className={`agent-status is-${agent.status}`} />
                {selectedAgentId === agent.sourceId && <Icon name="check" size={16} />}
              </button>
              <button
                type="button"
                className={`mobile-agent-pin${pinned ? " is-pinned" : ""}`}
                aria-pressed={pinned}
                aria-label={`${pinned ? "Unpin" : "Pin"} ${agent.label}`}
                title={`${pinned ? "Remove from" : "Add to"} favorites`}
                onClick={() => { void setAgentPinned(agent.sourceId, !pinned).catch(() => {}); }}
              >
                <Icon name="star" size={17} fill={pinned ? "currentColor" : "none"} />
              </button>
            </div>
          );
        })}
        {visibleAgents.length === 0 && (
          <p>No agents discovered. Running agents will appear automatically.</p>
        )}
        {hiddenOfflineAgentCount > 0 && (
          <button
            type="button"
            className={`mobile-offline-toggle${showOfflineAgents ? " is-active" : ""}`}
            aria-pressed={showOfflineAgents}
            onClick={() => setShowOfflineAgents(!showOfflineAgents)}
          >
            <Icon name={showOfflineAgents ? "eye-off" : "eye"} size={16} />
            <span>
              {showOfflineAgents
                ? "Hide offline agents"
                : `Show ${hiddenOfflineAgentCount} offline agent${hiddenOfflineAgentCount === 1 ? "" : "s"}`}
            </span>
          </button>
        )}
      </div>
    </aside>
  );
}
