import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agent } from "../test/fixtures";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("../console-store", () => ({
  useConsoleStore: () => storeMock.current,
}));

import { AgentRail, MobileAgentPicker } from "./AgentRail";

const createStore = () => ({
  agents: [
    agent("favorite", {
      label: "A complete favorite agent name",
      pinned: true,
      status: "offline",
    }),
    agent("other", { label: "Other agent" }),
    agent("current-offline", { label: "Current offline agent", status: "offline" }),
    agent("hidden-offline", { label: "Hidden offline agent", status: "offline" }),
  ],
  visibleAgents: [
    agent("favorite", {
      label: "A complete favorite agent name",
      pinned: true,
      status: "offline",
    }),
    agent("other", { label: "Other agent" }),
    agent("current-offline", { label: "Current offline agent", status: "offline" }),
  ],
  connection: "live",
  selectedAgentId: "current-offline",
  hiddenOfflineAgentCount: 1,
  showOfflineAgents: false,
  selectAgent: vi.fn(),
  setAgentPinned: vi.fn().mockResolvedValue(undefined),
  setShowOfflineAgents: vi.fn(),
});

describe("AgentRail", () => {
  beforeEach(() => {
    storeMock.current = createStore();
  });

  it("renders full names and independent selection and pin controls", () => {
    const onToggleExpanded = vi.fn();
    render(<AgentRail expanded onToggleExpanded={onToggleExpanded} />);
    const store = storeMock.current as ReturnType<typeof createStore>;

    expect(screen.getByText("A complete favorite agent name")).toBeVisible();
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent(
      "A complete favorite agent name",
    );
    expect(screen.getByText("Current offline agent")).toBeVisible();
    expect(screen.queryByText("Hidden offline agent")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Unpin A complete favorite agent name" }));
    expect(store.setAgentPinned).toHaveBeenCalledWith("favorite", false);
    expect(store.selectAgent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Other agent, online" }));
    expect(store.selectAgent).toHaveBeenCalledWith("other");
    expect(store.setAgentPinned).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Show 1 offline agent" }));
    expect(store.setShowOfflineAgents).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: "Collapse agent sidebar" }));
    expect(onToggleExpanded).toHaveBeenCalledOnce();
  });

  it("exposes pin state through pressed semantics", () => {
    render(<AgentRail expanded />);

    expect(
      screen.getByRole("button", { name: "Unpin A complete favorite agent name" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Pin Other agent" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});

describe("MobileAgentPicker", () => {
  it("pinning does not select the agent or close the drawer", () => {
    storeMock.current = createStore();
    const onSelect = vi.fn();
    render(<MobileAgentPicker onSelect={onSelect} />);
    const store = storeMock.current as ReturnType<typeof createStore>;

    fireEvent.click(screen.getByRole("button", { name: "Pin Other agent" }));

    expect(store.setAgentPinned).toHaveBeenCalledWith("other", true);
    expect(store.selectAgent).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("uses the same hidden-offline policy as the desktop rail", () => {
    storeMock.current = createStore();
    render(<MobileAgentPicker onSelect={vi.fn()} />);
    const store = storeMock.current as ReturnType<typeof createStore>;

    expect(screen.getByText("A complete favorite agent name")).toBeVisible();
    expect(screen.getByText("Current offline agent")).toBeVisible();
    expect(screen.queryByText("Hidden offline agent")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show 1 offline agent" }));
    expect(store.setShowOfflineAgents).toHaveBeenCalledWith(true);
  });
});
