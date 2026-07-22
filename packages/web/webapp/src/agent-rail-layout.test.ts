import { describe, expect, it, vi } from "vitest";
import {
  AGENT_RAIL_COLLAPSED_WIDTH,
  AGENT_RAIL_EXPANDED_WIDTH,
  AGENT_RAIL_STORAGE_KEY,
  agentRailWidth,
  readAgentRailExpanded,
  writeAgentRailExpanded,
} from "./agent-rail-layout";

describe("agent rail layout preferences", () => {
  it("maps the two layout states to fixed widths", () => {
    expect(agentRailWidth(false)).toBe(AGENT_RAIL_COLLAPSED_WIDTH);
    expect(agentRailWidth(true)).toBe(AGENT_RAIL_EXPANDED_WIDTH);
  });

  it("loads the persisted state and migrates legacy resizable widths", () => {
    expect(readAgentRailExpanded({ getItem: () => "240" })).toBe(true);
    expect(readAgentRailExpanded({ getItem: () => "204" })).toBe(true);
    expect(readAgentRailExpanded({ getItem: () => "159" })).toBe(false);
    expect(readAgentRailExpanded({ getItem: () => "72" })).toBe(false);
    expect(readAgentRailExpanded({ getItem: () => "not-a-width" })).toBe(false);
    expect(readAgentRailExpanded({ getItem: () => { throw new Error("denied"); } })).toBe(false);
  });

  it("persists either fixed width without failing when storage is denied", () => {
    const setItem = vi.fn();
    writeAgentRailExpanded(true, { setItem });
    expect(setItem).toHaveBeenLastCalledWith(
      AGENT_RAIL_STORAGE_KEY,
      String(AGENT_RAIL_EXPANDED_WIDTH),
    );
    writeAgentRailExpanded(false, { setItem });
    expect(setItem).toHaveBeenLastCalledWith(
      AGENT_RAIL_STORAGE_KEY,
      String(AGENT_RAIL_COLLAPSED_WIDTH),
    );

    expect(() =>
      writeAgentRailExpanded(true, { setItem: () => { throw new Error("denied"); } }),
    ).not.toThrow();
  });
});
