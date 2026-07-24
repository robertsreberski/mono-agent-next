import { useMemo } from "react";

import { useConsole } from "../console";
import type { Agent } from "../types";
import { Icon } from "./Icon";

export interface AgentRailVisibility {
  readonly visible: readonly Agent[];
  readonly hiddenOfflineCount: number;
}

export function visibleAgentNavigation(
  agents: readonly Agent[],
  selectedAgentId: string | undefined,
  showOffline: boolean,
): AgentRailVisibility {
  const ordered = [...agents].sort((left, right) => {
    const pinned = Number(right.pinned) - Number(left.pinned);
    if (pinned !== 0) return pinned;
    return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
  });
  const hidden = ordered.filter(
    (agent) =>
      !agent.online
      && !agent.pinned
      && agent.id !== selectedAgentId,
  );
  return {
    visible: showOffline
      ? ordered
      : ordered.filter((agent) => !hidden.includes(agent)),
    hiddenOfflineCount: hidden.length,
  };
}

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
  mobile = false,
  onSelect,
  onClose,
  onOpenCommandPalette,
}: {
  readonly mobile?: boolean;
  readonly onSelect?: () => void;
  readonly onClose?: () => void;
  readonly onOpenCommandPalette: () => void;
}) {
  const consoleState = useConsole();
  const expanded = mobile || consoleState.railExpanded;
  const { visible, hiddenOfflineCount } = useMemo(
    () => visibleAgentNavigation(
      consoleState.bootstrap?.agents ?? [],
      consoleState.selectedAgentId,
      consoleState.showOffline,
    ),
    [
      consoleState.bootstrap?.agents,
      consoleState.selectedAgentId,
      consoleState.showOffline,
    ],
  );
  const connectionLabel = {
    connected: "Console connected",
    connecting: "Console connecting",
    reconnecting: "Console reconnecting",
    offline: "Browser offline",
  }[consoleState.connection];
  const connectionTone = consoleState.connection === "connected"
    ? "live"
    : consoleState.connection;

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
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
      <div className="agent-list" role="list">
        {visible.map((agent) => (
          <div className="agent-item" role="listitem" key={agent.id}>
            <button
              type="button"
              className={`agent-button${agent.id === consoleState.selectedAgentId ? " is-active" : ""}`}
              data-agent-control="select"
              onClick={() => {
                void consoleState.selectAgent(agent.id).catch(() => undefined);
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
            {expanded && (
              <button
                type="button"
                className={`agent-pin${agent.pinned ? " is-pinned" : ""}`}
                data-agent-control="pin"
                aria-pressed={agent.pinned}
                aria-label={`${agent.pinned ? "Unpin" : "Pin"} ${agent.label}`}
                title={agent.pinned ? "Remove from favorites" : "Add to favorites"}
                onClick={() => {
                  void consoleState.patchAgent(agent.id, !agent.pinned).catch(() => undefined);
                }}
              >
                <Icon name="star" size={14} fill={agent.pinned ? "currentColor" : "none"} />
              </button>
            )}
          </div>
        ))}
        {visible.length === 0 && (
          <span className="rail-empty" title="No agents discovered">
            <Icon name="agents" size={19} />
          </span>
        )}
        {hiddenOfflineCount > 0 && (
          <button
            type="button"
            className={`rail-offline-toggle${consoleState.showOffline ? " is-active" : ""}`}
            aria-pressed={consoleState.showOffline}
            aria-label={consoleState.showOffline
              ? "Hide offline agents"
              : `Show ${hiddenOfflineCount} offline agent${hiddenOfflineCount === 1 ? "" : "s"}`}
            title={consoleState.showOffline ? "Hide offline agents" : `Show ${hiddenOfflineCount} offline`}
            onClick={() => consoleState.setShowOffline(!consoleState.showOffline)}
          >
            <Icon name={consoleState.showOffline ? "eye-off" : "eye"} size={16} />
            <span className="rail-offline-copy">
              {consoleState.showOffline ? "Hide offline" : `Show ${hiddenOfflineCount} offline`}
            </span>
            {!expanded && <span className="rail-offline-count">{hiddenOfflineCount}</span>}
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
          <Icon name="chevron-right" size={17} />
          <span className="rail-toggle-copy">{expanded ? "Collapse" : "Expand"}</span>
        </button>
      )}
      <button
        type="button"
        className="rail-command"
        aria-label="Open command palette"
        title="Command palette (⌘K)"
        onClick={onOpenCommandPalette}
      >
        <span aria-hidden="true">⌘</span>
        <span className="rail-toggle-copy">Commands</span>
      </button>
      {consoleState.tokenAuthentication && (
        <button
          type="button"
          className="rail-command rail-lock"
          aria-label="Lock console"
          title="Lock console"
          onClick={consoleState.logout}
        >
          <Icon name="lock" size={17} />
          <span className="rail-toggle-copy">Lock console</span>
        </button>
      )}
      <span
        className={`rail-connection is-${connectionTone}`}
        role="status"
        aria-label={connectionLabel}
        title={connectionLabel}
      />
    </nav>
  );
}

function initials(label: string): string {
  return label
    .split(/[\s_-]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "A";
}
