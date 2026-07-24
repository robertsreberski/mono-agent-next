import {
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { consoleGridColumnsForViewport } from "./agent-rail-layout";
import { Chat } from "./chat";
import { AgentRail, BrandMark } from "./components/AgentRail";
import { CommandPalette } from "./components/CommandPalette";
import { Icon } from "./components/Icon";
import { dismissPopovers } from "./components/Popover";
import { ThreadSidebar } from "./components/ThreadSidebar";
import { useConsole } from "./console";

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
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || rootRef.current === null) return;
      const focusable = [...rootRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) =>
          !element.hidden
          && element.getAttribute("aria-hidden") !== "true"
          && !element.closest("[inert]"),
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
  }, [onClose, open, rootRef]);
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
        <p>
          Enter the bearer token from this web service’s private configuration.
          It stays in this browser tab.
        </p>
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
        {consoleState.error && (
          <p className="login-error" role="alert">{consoleState.error}</p>
        )}
        <button
          className="primary"
          type="submit"
          disabled={token.trim().length < 16}
        >
          Open console
        </button>
      </form>
    </main>
  );
}

function InitialLoading() {
  return (
    <main className="loading-page" role="status">
      <BrandMark />
      <span>Discovering agents…</span>
    </main>
  );
}

function FatalError() {
  const consoleState = useConsole();
  return (
    <main className="login-page">
      <section className="login-card" role="alert">
        <BrandMark />
        <span className="eyebrow">Console unavailable</span>
        <h1>Couldn’t reach the mono-agent service.</h1>
        <p>{consoleState.error ?? "The local web service did not respond."}</p>
        <button className="primary" type="button" onClick={() => void consoleState.retry()}>
          Try again
        </button>
      </section>
    </main>
  );
}

function useDesktopLayout(): boolean {
  const [desktop, setDesktop] = useState(() => {
    if (typeof window.matchMedia !== "function") return true;
    return window.matchMedia("(min-width: 901px)").matches;
  });
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(min-width: 901px)");
    const onChange = (event: MediaQueryListEvent) => setDesktop(event.matches);
    setDesktop(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return desktop;
}

function ConsoleShell() {
  const consoleState = useConsole();
  const desktop = useDesktopLayout();
  const [agentDrawer, setAgentDrawer] = useState(false);
  const [threadDrawer, setThreadDrawer] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const agentDrawerRef = useRef<HTMLElement>(null);
  const threadDrawerRef = useRef<HTMLElement>(null);

  const closeDrawers = useCallback(() => {
    setAgentDrawer(false);
    setThreadDrawer(false);
  }, []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openPalette = useCallback(() => {
    closeDrawers();
    dismissPopovers();
    setPaletteOpen(true);
  }, [closeDrawers]);
  const openAgents = useCallback(() => {
    dismissPopovers();
    setPaletteOpen(false);
    setThreadDrawer(false);
    setAgentDrawer(true);
  }, []);
  const openThreads = useCallback(() => {
    dismissPopovers();
    setPaletteOpen(false);
    setAgentDrawer(false);
    setThreadDrawer(true);
  }, []);
  const navigationModalOpen = agentDrawer || threadDrawer;
  const interfaceModalOpen = navigationModalOpen || paletteOpen;

  useModalFocus(agentDrawer, agentDrawerRef, closeDrawers);
  useModalFocus(threadDrawer, threadDrawerRef, closeDrawers);

  useEffect(() => {
    document.body.toggleAttribute("data-console-modal-open", interfaceModalOpen);
    return () => document.body.removeAttribute("data-console-modal-open");
  }, [interfaceModalOpen]);

  useEffect(() => {
    if (desktop) closeDrawers();
  }, [closeDrawers, desktop]);

  useEffect(() => {
    const onCommand = () => {
      if (paletteOpen) closePalette();
      else openPalette();
    };
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
  }, [closePalette, openPalette, paletteOpen]);

  useEffect(() => {
    if (notice === undefined) return;
    const timer = window.setTimeout(() => setNotice(undefined), 6_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT"
        || target?.tagName === "SELECT"
        || target?.tagName === "TEXTAREA"
        || target?.isContentEditable;
      const headerPopoverOpen =
        document.body.dataset.consolePopover !== undefined;

      if (headerPopoverOpen || (navigationModalOpen && !paletteOpen)) return;

      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        if (paletteOpen) closePalette();
        else openPalette();
        return;
      }
      if (paletteOpen) return;
      if (
        (event.metaKey || event.ctrlKey)
        && event.shiftKey
        && event.key.toLocaleLowerCase() === "o"
      ) {
        event.preventDefault();
        if (consoleState.selectedAgent?.online) {
          void consoleState.createThread().catch(() => undefined);
        }
        return;
      }
      if (!typing && !navigationModalOpen && event.key === "/") {
        event.preventDefault();
        document.querySelector<HTMLTextAreaElement>("#composer-input")?.focus();
      }
      if (event.key === "Escape") closeDrawers();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    closeDrawers,
    closePalette,
    consoleState,
    navigationModalOpen,
    openPalette,
    paletteOpen,
  ]);

  if (consoleState.loading && consoleState.bootstrap === undefined) {
    return <InitialLoading />;
  }
  if (consoleState.error && consoleState.bootstrap === undefined) {
    return <FatalError />;
  }

  return (
    <div
      className={`console-shell${consoleState.railExpanded ? " rail-expanded" : " rail-collapsed"}`}
      style={{
        gridTemplateColumns: consoleGridColumnsForViewport(
          consoleState.railExpanded,
          desktop,
        ),
      }}
    >
      <nav
        className="mobile-navigation"
        aria-label="Console navigation"
        aria-hidden={interfaceModalOpen || undefined}
        inert={interfaceModalOpen}
      >
        <button
          type="button"
          aria-label="Choose agent"
          title="Choose agent"
          onClick={openAgents}
        >
          <Icon name="agents" size={18} />
        </button>
        <button
          type="button"
          aria-label="Open conversations"
          title="Open conversations"
          onClick={openThreads}
        >
          <Icon name="menu" size={18} />
        </button>
      </nav>
      <div
        className="desktop-agent-rail"
        aria-hidden={interfaceModalOpen || undefined}
        inert={interfaceModalOpen}
      >
        <AgentRail onOpenCommandPalette={openPalette} />
      </div>
      <div
        className="desktop-thread-sidebar"
        aria-hidden={interfaceModalOpen || undefined}
        inert={interfaceModalOpen}
      >
        <ThreadSidebar />
      </div>
      <Chat backgroundInert={interfaceModalOpen} />
      {navigationModalOpen && (
        <button
          type="button"
          className="drawer-scrim"
          aria-hidden="true"
          tabIndex={-1}
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
          <AgentRail
            mobile
            onSelect={closeDrawers}
            onClose={closeDrawers}
            onOpenCommandPalette={openPalette}
          />
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
          <ThreadSidebar
            onSelect={closeDrawers}
            onClose={closeDrawers}
          />
        </aside>
      )}
      <CommandPalette open={paletteOpen} onClose={closePalette} />
      {notice && (
        <div
          className="toast shell-toast"
          role="status"
          aria-live="polite"
          aria-hidden={interfaceModalOpen || undefined}
          inert={interfaceModalOpen}
        >
          <span>{notice}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setNotice(undefined)}
          >
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
