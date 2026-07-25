// SPDX-License-Identifier: MIT
export const AGENT_RAIL_COLLAPSED_WIDTH = 72;
export const AGENT_RAIL_EXPANDED_WIDTH = 240;
export const AGENT_RAIL_LEGACY_EXPANSION_THRESHOLD = 160;
export const AGENT_RAIL_STORAGE_KEY = "mono-agent.web.agent-rail-width";

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

const browserStorage = (): Storage | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export const readAgentRailExpanded = (
  storage: StorageReader | null = browserStorage(),
): boolean => {
  if (!storage) return false;
  try {
    const stored = storage.getItem(AGENT_RAIL_STORAGE_KEY);
    if (stored === null || stored.trim() === "") return false;
    const parsed = Number(stored);
    return Number.isFinite(parsed)
      && Number.isInteger(parsed)
      && parsed >= AGENT_RAIL_LEGACY_EXPANSION_THRESHOLD;
  } catch {
    return false;
  }
};

export const writeAgentRailExpanded = (
  expanded: boolean,
  storage: StorageWriter | null = browserStorage(),
): void => {
  if (!storage) return;
  try {
    storage.setItem(
      AGENT_RAIL_STORAGE_KEY,
      String(expanded ? AGENT_RAIL_EXPANDED_WIDTH : AGENT_RAIL_COLLAPSED_WIDTH),
    );
  } catch {
    // Browser storage can be unavailable in private or locked-down contexts.
  }
};

export const agentRailWidth = (expanded: boolean): number =>
  expanded ? AGENT_RAIL_EXPANDED_WIDTH : AGENT_RAIL_COLLAPSED_WIDTH;
