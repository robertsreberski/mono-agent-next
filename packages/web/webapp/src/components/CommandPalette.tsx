import { Command } from "cmdk";
import { useEffect, useMemo, useRef, useState } from "react";

import { useConsole } from "../console";
import { visibleAgentNavigation } from "./AgentRail";
import { Icon, type IconName } from "./Icon";

const FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface PaletteAction {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly hint?: string;
  readonly icon: IconName;
  readonly disabled?: boolean;
  readonly keywords?: readonly string[];
  readonly run: () => void | Promise<void>;
}

export function CommandPalette({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const consoleState = useConsole();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const { hiddenOfflineCount } = visibleAgentNavigation(
    consoleState.bootstrap?.agents ?? [],
    consoleState.selectedAgentId,
    consoleState.showOffline,
  );
  const actions = useMemo<readonly PaletteAction[]>(() => [
    {
      id: "new",
      label: "New conversation",
      description: "Start a clean conversation with this agent",
      hint: "⌘⇧O",
      icon: "new",
      disabled: consoleState.selectedAgent?.online !== true,
      run: consoleState.createThread,
    },
    {
      id: "rename",
      label: "Rename conversation",
      description: "Change the selected conversation title",
      icon: "threads",
      disabled: consoleState.selectedThread === undefined,
      run: () => {
        const thread = consoleState.selectedThread;
        if (thread === undefined) return;
        const title = window.prompt("Conversation title", thread.title)?.trim();
        if (title) return consoleState.renameThread(thread.id, title);
      },
    },
    {
      id: "focus",
      label: "Focus message composer",
      description: "Move the cursor to the message field",
      hint: "/",
      icon: "threads",
      disabled: consoleState.selectedThread === undefined,
      run: () => document.querySelector<HTMLTextAreaElement>("#composer-input")?.focus(),
    },
    {
      id: "archive-view",
      label: consoleState.showArchived
        ? "Show active conversations"
        : "Show archived conversations",
      icon: consoleState.showArchived ? "threads" : "archive",
      run: () => consoleState.setShowArchived(!consoleState.showArchived),
    },
    {
      id: "pin-agent",
      label: consoleState.selectedAgent?.pinned
        ? `Unpin ${consoleState.selectedAgent.label}`
        : `Pin ${consoleState.selectedAgent?.label ?? "agent"}`,
      description: "Change whether this agent stays in the rail",
      icon: "star",
      disabled: consoleState.selectedAgent === undefined,
      run: () => {
        const agent = consoleState.selectedAgent;
        if (agent === undefined) return;
        return consoleState.patchAgent(agent.id, !agent.pinned);
      },
    },
    ...(hiddenOfflineCount > 0
      ? [{
          id: "offline-agents",
          label: consoleState.showOffline
            ? "Hide offline agents"
            : `Show ${hiddenOfflineCount} offline agent${hiddenOfflineCount === 1 ? "" : "s"}`,
          icon: (consoleState.showOffline ? "eye-off" : "eye") as IconName,
          run: () => consoleState.setShowOffline(!consoleState.showOffline),
        }]
      : []),
    {
      id: "refresh",
      label: "Refresh console",
      description: "Reload agents and conversations",
      icon: "refresh",
      disabled: consoleState.refreshing,
      run: consoleState.retry,
    },
    ...(consoleState.bootstrap?.agents ?? []).map((agent) => ({
      id: `agent:${agent.id}`,
      label: `Switch to ${agent.label}`,
      description: agent.online ? "Online" : "Offline",
      icon: "agents" as const,
      keywords: [agent.label, agent.id, agent.online ? "online" : "offline"],
      run: () => consoleState.selectAgent(agent.id),
    })),
    ...(consoleState.tokenAuthentication
      ? [{
          id: "lock",
          label: "Lock console",
          description: "Remove this tab’s bearer token",
          icon: "lock" as const,
          run: consoleState.logout,
        }]
      : []),
  ], [consoleState, hiddenOfflineCount]);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setQuery("");
    const focusFrame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(focusFrame);
      const restore = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restore?.isConnected) restore.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (dialog === null) return;
      const controls = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((element) => {
          const style = window.getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden";
        });
      if (controls.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = controls[0];
      const last = controls.at(-1);
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, open]);

  if (!open) return null;
  return (
    <div
      className="dialog-layer command-palette-layer"
      role="presentation"
      onPointerDown={onClose}
    >
      <section
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Command
          className="palette-command"
          label="Command palette"
          loop
          shouldFilter
        >
          <div className="palette-search">
            <Icon name="search" size={17} />
            <Command.Input
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              placeholder="Type a command…"
              aria-label="Search commands"
            />
            <kbd>esc</kbd>
          </div>
          <Command.List className="palette-results" aria-label="Available commands">
            <Command.Empty className="palette-empty">No matching commands</Command.Empty>
            <Command.Group>
              {actions.map((action) => (
                <Command.Item
                  key={action.id}
                  value={[
                    action.id,
                    action.label,
                    action.description,
                    ...(action.keywords ?? []),
                  ].filter(Boolean).join(" ")}
                  {...(action.disabled === undefined
                    ? {}
                    : { disabled: action.disabled })}
                  onSelect={() => {
                    onClose();
                    window.requestAnimationFrame(() => {
                      void Promise.resolve(action.run()).catch(() => undefined);
                    });
                  }}
                >
                  <span className="palette-icon">
                    <Icon name={action.icon} size={16} />
                  </span>
                  <span className="palette-copy">
                    <strong>{action.label}</strong>
                    {action.description && <small>{action.description}</small>}
                  </span>
                  {action.hint && <kbd>{action.hint}</kbd>}
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
          <footer>
            <span><kbd>↑↓</kbd> navigate</span>
            <span><kbd>↵</kbd> run</span>
            <span><kbd>esc</kbd> close</span>
          </footer>
        </Command>
      </section>
    </div>
  );
}
