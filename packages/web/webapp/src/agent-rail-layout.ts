export const AGENT_RAIL_COLLAPSED_WIDTH = 72;
export const AGENT_RAIL_EXPANDED_WIDTH = 240;
export const THREAD_SIDEBAR_WIDTH = 304;
export const AGENT_RAIL_PREFERENCE_KEY = "mono-agent-web-agent-rail";
export const LEGACY_AGENT_RAIL_WIDTH_KEY = "mono-agent.web.agent-rail-width";
export const LEGACY_AGENT_RAIL_EXPANSION_THRESHOLD = 160;

type RailPreferenceStorage = Pick<
  Storage,
  "getItem" | "removeItem" | "setItem"
>;

export function readAgentRailExpandedPreference(
  storage: RailPreferenceStorage,
): boolean {
  try {
    const current = storage.getItem(AGENT_RAIL_PREFERENCE_KEY);
    if (current === "expanded") return true;
    if (current === "collapsed") return false;

    const legacy = storage.getItem(LEGACY_AGENT_RAIL_WIDTH_KEY);
    if (legacy === null || legacy.trim() === "") return false;
    const width = Number(legacy);
    if (!Number.isFinite(width) || !Number.isInteger(width)) return false;
    const expanded = width >= LEGACY_AGENT_RAIL_EXPANSION_THRESHOLD;
    storage.setItem(
      AGENT_RAIL_PREFERENCE_KEY,
      expanded ? "expanded" : "collapsed",
    );
    storage.removeItem(LEGACY_AGENT_RAIL_WIDTH_KEY);
    return expanded;
  } catch {
    return false;
  }
}

export function writeAgentRailExpandedPreference(
  storage: Pick<Storage, "setItem">,
  expanded: boolean,
): void {
  try {
    storage.setItem(
      AGENT_RAIL_PREFERENCE_KEY,
      expanded ? "expanded" : "collapsed",
    );
  } catch {
    // Browser storage can be denied without making the rail unusable.
  }
}

export function consoleGridColumns(expanded: boolean): string {
  const railWidth = expanded
    ? AGENT_RAIL_EXPANDED_WIDTH
    : AGENT_RAIL_COLLAPSED_WIDTH;
  return `${railWidth}px ${THREAD_SIDEBAR_WIDTH}px minmax(0, 1fr)`;
}

export function consoleGridColumnsForViewport(
  expanded: boolean,
  desktop: boolean,
): string {
  return desktop ? consoleGridColumns(expanded) : "minmax(0, 1fr)";
}
