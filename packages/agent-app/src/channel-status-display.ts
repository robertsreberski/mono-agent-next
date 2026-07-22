import * as ui from "./ui.js";

export interface HumanChannelStatus {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
}

export interface HumanChannelSection {
  readonly title: "channels" | "operator";
  readonly lines: readonly string[];
}

const OPERATOR_CHANNEL_IDS = new Set(["tui"]);

/**
 * Keep transport ids stable in config/JSON while giving humans the product
 * name and purpose they actually interact with.
 */
export function formatHumanChannelSections(
  entries: readonly HumanChannelStatus[],
): readonly HumanChannelSection[] {
  const sections: HumanChannelSection[] = [];
  for (const title of ["channels", "operator"] as const) {
    const selected = entries.filter(({ id }) => OPERATOR_CHANNEL_IDS.has(id) === (title === "operator"));
    if (selected.length === 0) continue;

    const lines = selected
      .filter(({ kind }) => kind !== "disabled")
      .map((entry) => formatHumanChannelLine(entry));
    const disabled = selected
      .filter(({ kind }) => kind === "disabled")
      .map(({ id }) => displayChannelId(id));
    if (disabled.length > 0) {
      lines.push(
        `  ${ui.channelBadge("disabled")}${ui.style.bold("disabled".padEnd(11))} ${disabled.join(", ")}`,
      );
    }
    sections.push({ title, lines });
  }
  return sections;
}

function formatHumanChannelLine(entry: HumanChannelStatus): string {
  const id = displayChannelId(entry.id);
  return `  ${ui.channelBadge(entry.kind)}${ui.style.bold(id.padEnd(11))} ${describeOperatorPurpose(entry)}`;
}

function displayChannelId(id: string): string {
  return id === "tui" ? "gui" : id;
}

function describeOperatorPurpose(entry: HumanChannelStatus): string {
  const purpose = entry.id === "tui" ? "TUI + Web" : undefined;
  if (purpose === undefined || entry.kind !== "running") return entry.text;
  if (entry.text === "running") return `running (${purpose})`;
  if (entry.text.startsWith("running (") && entry.text.endsWith(")")) {
    return `running (${purpose}; ${entry.text.slice("running (".length, -1)})`;
  }
  return entry.text;
}
