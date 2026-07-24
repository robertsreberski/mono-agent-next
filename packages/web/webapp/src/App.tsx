import {
  type CSSProperties,
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  agentRailWidth,
  readAgentRailExpanded,
  writeAgentRailExpanded,
} from "./agent-rail-layout";
import { Chat } from "./chat";
import { AgentRail, BrandMark, MobileAgentPicker } from "./components/AgentRail";
import { Icon, type IconName } from "./components/Icon";
import { ThreadSidebar } from "./components/ThreadSidebar";
import { useConsole } from "./console";

interface PaletteAction {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly icon: IconName;
  readonly disabled?: boolean;
  readonly run: () => void;
}

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
  initialFocusRef?: RefObject<HTMLElement | null>,
) {
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusTimer = window.setTimeout(() => {
      initialFocusRef?.current?.focus();
      if (!initialFocusRef?.current) {
        rootRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
      }
    }, 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
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
      restoreRef.current = null;
      if (restore?.isConnected) restore.focus();
    };
  }, [initialFocusRef, onClose, open, rootRef]);
}

function CommandPalette({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const consoleState = useConsole();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useModalFocus(open, dialogRef, onClose, inputRef);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const actions = useMemo<readonly PaletteAction[]>(() => [
    {
      id: "new",
      label: "New conversation",
      hint: "⌘⇧O",
      icon: "new",
      disabled: consoleState.selectedAgent?.online !== true,
      run: () => void consoleState.createThread().catch(() => undefined),
    },
    {
      id: "rename",
      label: "Rename conversation",
      icon: "threads",
      disabled: consoleState.selectedThread === undefined,
      run: () => {
        const thread = consoleState.selectedThread;
        if (thread === undefined) return;
        const title = window.prompt("Conversation title", thread.title)?.trim();
        if (title) void consoleState.renameThread(thread.id, title).catch(() => undefined);
      },
    },
    {
      id: "focus",
      label: "Focus message composer",
      hint: "/",
      icon: "threads",
      run: () => document.querySelector<HTMLTextAreaElement>("#composer-input")?.focus(),
    },
    {
      id: "archive-view",
      label: consoleState.showArchived ? "Show active conversations" : "Show archived conversations",
      icon: consoleState.showArchived ? "threads" : "archive",
      run: () => consoleState.setShowArchived(!consoleState.showArchived),
    },
    {
      id: "pin-agent",
      label: consoleState.selectedAgent?.pinned
        ? `Unpin ${consoleState.selectedAgent.label}`
        : `Pin ${consoleState.selectedAgent?.label ?? "agent"}`,
      icon: "star",
      disabled: consoleState.selectedAgent === undefined,
      run: () => {
        const agent = consoleState.selectedAgent;
        if (agent === undefined) return;
        void consoleState.patchAgent(agent.id, !agent.pinned).catch(() => undefined);
      },
    },
    ...(consoleState.hiddenOfflineCount > 0
      ? [{
          id: "offline-agents",
          label: consoleState.showOffline
            ? "Hide offline agents"
            : `Show ${consoleState.hiddenOfflineCount} offline agent${consoleState.hiddenOfflineCount === 1 ? "" : "s"}`,
          icon: (consoleState.showOffline ? "eye-off" : "eye") as IconName,
          run: () => consoleState.setShowOffline(!consoleState.showOffline),
        }]
      : []),
    {
      id: "lock",
      label: "Lock console",
      icon: "settings",
      run: () => consoleState.logout(),
    },
    ...consoleState.visibleAgents.map((agent) => ({
      id: `agent:${agent.id}`,
      label: `Switch to ${agent.label}`,
      hint: agent.online ? "online" : "offline",
      icon: "agent" as const,
      run: () => consoleState.selectAgent(agent.id),
    })),
  ], [consoleState]);

  const normalized = query.trim().toLowerCase();
  const visible = actions.filter((action) => action.label.toLowerCase().includes(normalized));

  if (!open) return null;
  return (
    <div className="dialog-layer" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette-search">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              const firstAction = visible.find((action) => action.disabled !== true);
              if (event.key === "Enter" && firstAction !== undefined) {
                onClose();
                window.requestAnimationFrame(firstAction.run);
              }
            }}
            placeholder="Type a command…"
            aria-label="Search commands"
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-results" role="listbox">
          {visible.map((action, index) => (
            <button
              key={action.id}
              type="button"
              role="option"
              aria-selected={index === 0}
              disabled={action.disabled}
              onClick={() => {
                onClose();
                window.requestAnimationFrame(action.run);
              }}
            >
              <span className="palette-icon"><Icon name={action.icon} size={16} /></span>
              <span>{action.label}</span>
              {action.hint !== undefined && <kbd>{action.hint}</kbd>}
            </button>
          ))}
          {visible.length === 0 && <p>No matching commands</p>}
        </div>
        <footer>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>⌘K</kbd> toggle</span>
        </footer>
      </section>
    </div>
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
    <main className="fatal-state" aria-label="Console sign-in">
      <BrandMark />
      <span className="eyebrow">mono-agent Console</span>
      <h1>Connect to your agents</h1>
      <p>
        Enter the bearer token from this web service’s private configuration.
        It stays in this browser tab.
      </p>
      <form className="login-form" onSubmit={submit}>
        <label>
          <span className="sr-only">Web token</span>
          <input
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="At least 16 characters"
            aria-label="Web token"
            autoFocus
          />
        </label>
        <button className="primary-button" type="submit" disabled={token.trim().length < 16}>
          Open console
        </button>
      </form>
      {consoleState.error !== undefined && (
        <small role="alert" className="login-error">{consoleState.error}</small>
      )}
    </main>
  );
}

function InitialLoading() {
  return (
    <div className="initial-state" role="status">
      <BrandMark />
      <div className="initial-loader"><span /><span /><span /></div>
      <span>Discovering agents</span>
    </div>
  );
}

function FatalError() {
  const consoleState = useConsole();
  return (
    <div className="fatal-state">
      <BrandMark />
      <span className="eyebrow">Console unavailable</span>
      <h1>Couldn’t reach the mono-agent service.</h1>
      <p>{consoleState.error ?? "The local web service did not respond."}</p>
      <button
        type="button"
        className="primary-button"
        onClick={() => void consoleState.retry().catch(() => undefined)}
      >
        Try again
      </button>
      <small>
        Check that <code>mono-agent-web</code> is still running on this machine.
      </small>
    </div>
  );
}

function ConsoleShell() {
  const consoleState = useConsole();
  const [agentDrawer, setAgentDrawer] = useState(false);
  const [threadDrawer, setThreadDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [agentRailExpanded, setAgentRailExpanded] = useState(readAgentRailExpanded);
  const agentDrawerRef = useRef<HTMLDivElement>(null);
  const threadDrawerRef = useRef<HTMLDivElement>(null);
  const appStyle = {
    "--agent-rail-width": `${agentRailWidth(agentRailExpanded)}px`,
  } as CSSProperties;

  const toggleAgentRail = useCallback(() => {
    setAgentRailExpanded((current) => {
      const next = !current;
      writeAgentRailExpanded(next);
      return next;
    });
  }, []);

  const closeDrawers = useCallback(() => {
    setAgentDrawer(false);
    setThreadDrawer(false);
  }, []);
  const closePalette = useCallback(() => setPalette(false), []);
  const togglePalette = useCallback(() => {
    closeDrawers();
    setPalette((current) => !current);
  }, [closeDrawers]);
  const openAgents = useCallback(() => {
    setPalette(false);
    setThreadDrawer(false);
    setAgentDrawer(true);
  }, []);
  const openThreads = useCallback(() => {
    setPalette(false);
    setAgentDrawer(false);
    setThreadDrawer(true);
  }, []);

  useModalFocus(agentDrawer, agentDrawerRef, closeDrawers);
  useModalFocus(threadDrawer, threadDrawerRef, closeDrawers);

  useEffect(() => {
    const onCommand = () => togglePalette();
    const onNotice = (event: Event) => {
      const message = (event as CustomEvent<{ readonly message?: unknown }>).detail?.message;
      if (typeof message === "string" && message.trim()) setNotice(message);
    };
    window.addEventListener("mono-agent:command", onCommand);
    window.addEventListener("mono-agent:notice", onNotice);
    return () => {
      window.removeEventListener("mono-agent:command", onCommand);
      window.removeEventListener("mono-agent:notice", onNotice);
    };
  }, [togglePalette]);

  useEffect(() => {
    if (notice === undefined) return;
    const timer = window.setTimeout(() => setNotice(undefined), 6_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT"
        || target?.tagName === "SELECT"
        || target?.tagName === "TEXTAREA"
        || target?.isContentEditable;
      const modalOpen = document.querySelector(
        '[role="dialog"][aria-modal="true"]:not([aria-hidden="true"]), [data-slot="model-selector-content"]',
      ) !== null;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (palette) {
          setPalette(false);
          return;
        }
        if (modalOpen) return;
        togglePalette();
        return;
      }
      if (modalOpen) return;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (consoleState.selectedAgent?.online === true) {
          void consoleState.createThread().catch(() => undefined);
        }
        return;
      }
      if (!typing && event.key === "/") {
        event.preventDefault();
        document.querySelector<HTMLTextAreaElement>("#composer-input")?.focus();
      }
      if (event.key === "Escape") {
        setPalette(false);
        closeDrawers();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDrawers, consoleState, palette, togglePalette]);

  if (consoleState.loading && consoleState.bootstrap === undefined) return <InitialLoading />;
  if (consoleState.error !== undefined && consoleState.bootstrap === undefined) return <FatalError />;

  return (
    <div className="app-shell" style={appStyle}>
      <div className="desktop-agent-rail">
        <AgentRail expanded={agentRailExpanded} onToggleExpanded={toggleAgentRail} />
      </div>
      <div className="desktop-thread-sidebar"><ThreadSidebar /></div>
      <Chat onOpenAgents={openAgents} onOpenThreads={openThreads} />

      {(agentDrawer || threadDrawer) && (
        <button
          className="drawer-scrim"
          type="button"
          onClick={closeDrawers}
          aria-label="Close navigation"
        />
      )}
      {/*
        Both drawers stay mounted so the 180ms slide-in transition has a
        previous state to animate from; toggling `is-open` is what moves them.
      */}
      <div
        ref={agentDrawerRef}
        className={`mobile-agent-drawer${agentDrawer ? " is-open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Choose agent"
        aria-hidden={!agentDrawer}
        inert={!agentDrawer}
        tabIndex={-1}
      >
        <MobileAgentPicker onSelect={closeDrawers} />
      </div>
      <div
        ref={threadDrawerRef}
        className={`mobile-thread-drawer${threadDrawer ? " is-open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Conversations"
        aria-hidden={!threadDrawer}
        inert={!threadDrawer}
        tabIndex={-1}
      >
        <ThreadSidebar onSelect={closeDrawers} />
      </div>

      <CommandPalette open={palette} onClose={closePalette} />
      {notice !== undefined && (
        <div className="toast" role="alert">
          <span>{notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(undefined)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

export function App() {
  const consoleState = useConsole();
  return consoleState.authenticated ? <ConsoleShell /> : <Login />;
}
