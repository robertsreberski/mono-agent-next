import type { ChannelConfigViewSection } from "@mono-agent/agent-contracts";

/** Config-view section for a channel whose gate found no configuration intent. */
export function unconfiguredChannelView(id: string, label: string): ChannelConfigViewSection {
  return { id, label, status: "disabled", fields: [] };
}
