// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const consoleMock = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock("../console", () => ({
  useConsole: () => consoleMock.value,
}));

import { AgentRail, visibleAgentNavigation } from "./AgentRail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  consoleMock.value = createConsoleState();
});

afterEach(() => {
  document.body.textContent = "";
  vi.clearAllMocks();
});

describe("AgentRail", () => {
  it("keeps pinned and selected offline agents visible while counting only hidden agents", () => {
    const agents = createConsoleState().bootstrap.agents;
    const projection = visibleAgentNavigation(agents, "selected-offline", false);

    expect(projection.visible.map((agent) => agent.id)).toEqual([
      "pinned-offline",
      "online",
      "selected-offline",
    ]);
    expect(projection.hiddenOfflineCount).toBe(1);
  });

  it("separates selection and pin touch targets in the expanded rail", async () => {
    consoleMock.value = { ...createConsoleState(), railExpanded: true };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<AgentRail onOpenCommandPalette={vi.fn()} />);
    });

    const row = requiredElement(host, ".agent-item");
    const select = requiredElement<HTMLButtonElement>(row, '[data-agent-control="select"]');
    const pin = requiredElement<HTMLButtonElement>(row, '[data-agent-control="pin"]');
    expect(select.parentElement).toBe(row);
    expect(pin.parentElement).toBe(row);
    expect(requiredElement<SVGSVGElement>(pin, "svg").getAttribute("fill")).toBe(
      "currentColor",
    );

    await act(async () => pin.click());
    expect(consoleMock.value.patchAgent).toHaveBeenCalled();
    expect(consoleMock.value.selectAgent).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("does not place a pin target over the compact selection target", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<AgentRail onOpenCommandPalette={vi.fn()} />);
    });

    expect(host.querySelector('[data-agent-control="select"]')).not.toBeNull();
    expect(host.querySelector('[data-agent-control="pin"]')).toBeNull();
    expect(host.querySelector('[aria-label="Open command palette"]')).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("reports event-stream and browser connectivity without claiming a stale connection", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<AgentRail onOpenCommandPalette={vi.fn()} />);
    });
    expect(host.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(
      "Console connected",
    );

    consoleMock.value = { ...createConsoleState(), connection: "reconnecting" };
    await act(async () => {
      root.render(<AgentRail onOpenCommandPalette={vi.fn()} />);
    });
    expect(host.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(
      "Console reconnecting",
    );
    expect(host.querySelector(".rail-connection")?.classList.contains("is-reconnecting")).toBe(
      true,
    );

    consoleMock.value = { ...createConsoleState(), connection: "offline" };
    await act(async () => {
      root.render(<AgentRail onOpenCommandPalette={vi.fn()} />);
    });
    expect(host.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(
      "Browser offline",
    );

    await act(async () => root.unmount());
  });
});

function createConsoleState() {
  const agents = [
    {
      id: "pinned-offline",
      label: "Pinned Offline",
      endpoint: "http://127.0.0.1:1",
      online: false,
      pinned: true,
      capabilities: {},
    },
    {
      id: "online",
      label: "Online",
      endpoint: "http://127.0.0.1:2",
      online: true,
      pinned: false,
      capabilities: {},
    },
    {
      id: "selected-offline",
      label: "Selected Offline",
      endpoint: "http://127.0.0.1:3",
      online: false,
      pinned: false,
      capabilities: {},
    },
    {
      id: "hidden-offline",
      label: "Hidden Offline",
      endpoint: "http://127.0.0.1:4",
      online: false,
      pinned: false,
      capabilities: {},
    },
  ] as const;
  return {
    bootstrap: {
      version: 1 as const,
      revision: 1,
      agents,
      threads: [],
      newProactiveThreadIds: [],
    },
    selectedAgentId: "selected-offline",
    showOffline: false,
    railExpanded: false,
    refreshing: false,
    connection: "connected",
    tokenAuthentication: false,
    selectAgent: vi.fn(async () => undefined),
    patchAgent: vi.fn(async () => undefined),
    setShowOffline: vi.fn(),
    setRailExpanded: vi.fn(),
    logout: vi.fn(),
  };
}

function requiredElement<ElementType extends Element = HTMLElement>(
  root: ParentNode,
  selector: string,
): ElementType {
  const element = root.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Expected ${selector}`);
  return element;
}
