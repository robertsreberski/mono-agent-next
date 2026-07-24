import { describe, expect, it, vi } from "vitest";

import {
  AGENT_RAIL_COLLAPSED_WIDTH,
  AGENT_RAIL_EXPANDED_WIDTH,
  AGENT_RAIL_PREFERENCE_KEY,
  LEGACY_AGENT_RAIL_WIDTH_KEY,
  THREAD_SIDEBAR_WIDTH,
  consoleGridColumns,
  consoleGridColumnsForViewport,
  readAgentRailExpandedPreference,
  writeAgentRailExpandedPreference,
} from "./agent-rail-layout";

describe("agent rail layout", () => {
  it("uses the restored fixed rail and conversation widths", () => {
    expect(AGENT_RAIL_COLLAPSED_WIDTH).toBe(72);
    expect(AGENT_RAIL_EXPANDED_WIDTH).toBe(240);
    expect(THREAD_SIDEBAR_WIDTH).toBe(304);
    expect(consoleGridColumns(false)).toBe("72px 304px minmax(0, 1fr)");
    expect(consoleGridColumns(true)).toBe("240px 304px minmax(0, 1fr)");
    expect(consoleGridColumnsForViewport(true, false)).toBe("minmax(0, 1fr)");
  });

  it("migrates a legacy width once and removes only that legacy preference", () => {
    const storage = memoryStorage({
      [LEGACY_AGENT_RAIL_WIDTH_KEY]: "204",
      "mono-agent.web.selected-agent": "must-not-migrate",
    });

    expect(readAgentRailExpandedPreference(storage)).toBe(true);
    expect(storage.getItem(AGENT_RAIL_PREFERENCE_KEY)).toBe("expanded");
    expect(storage.getItem(LEGACY_AGENT_RAIL_WIDTH_KEY)).toBeNull();
    expect(storage.getItem("mono-agent.web.selected-agent")).toBe("must-not-migrate");
  });

  it("preserves an existing current preference instead of replaying legacy state", () => {
    const storage = memoryStorage({
      [AGENT_RAIL_PREFERENCE_KEY]: "collapsed",
      [LEGACY_AGENT_RAIL_WIDTH_KEY]: "240",
    });

    expect(readAgentRailExpandedPreference(storage)).toBe(false);
    expect(storage.getItem(AGENT_RAIL_PREFERENCE_KEY)).toBe("collapsed");
    expect(storage.getItem(LEGACY_AGENT_RAIL_WIDTH_KEY)).toBe("240");
  });

  it("maps legacy widths below the threshold to collapsed", () => {
    const storage = memoryStorage({ [LEGACY_AGENT_RAIL_WIDTH_KEY]: "72" });

    expect(readAgentRailExpandedPreference(storage)).toBe(false);
    expect(storage.getItem(AGENT_RAIL_PREFERENCE_KEY)).toBe("collapsed");
    expect(storage.getItem(LEGACY_AGENT_RAIL_WIDTH_KEY)).toBeNull();
  });

  it("fails closed when browser storage is unavailable", () => {
    const denied = {
      getItem: vi.fn(() => {
        throw new Error("denied");
      }),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    };
    expect(readAgentRailExpandedPreference(denied)).toBe(false);
    expect(() => writeAgentRailExpandedPreference(denied, true)).not.toThrow();
  });
});

function memoryStorage(initial: Readonly<Record<string, string>> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}
