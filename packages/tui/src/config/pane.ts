import { buildMonoAgentConfigView } from "@mono-agent/config";
import type {
  BuildMonoAgentConfigViewInput,
  ConfigViewFieldSource,
} from "@mono-agent/config";

/** Where a resolved config value came from. Re-exported for the Config pane. */
export type TuiConfigFieldSource = ConfigViewFieldSource;

export interface TuiConfigFieldSummary {
  readonly label: string;
  readonly value: string;
  readonly source: TuiConfigFieldSource;
  readonly redacted?: boolean;
}

export interface TuiConfigSummarySection {
  readonly heading: string;
  readonly fields: readonly TuiConfigFieldSummary[];
}

export type BuildTuiConfigSummaryInput = BuildMonoAgentConfigViewInput;

/**
 * Build a compact, redacted view of the resolved configuration for the TUI's
 * read-only Config pane. Delegates to the single `buildMonoAgentConfigView`
 * builder in `@mono-agent/config` so the pane, the `mono-agent config` command,
 * and the loader can never disagree about what is configured or where each
 * value came from. The pane is read-only — edits are made directly in
 * `mono-agent.config.json` and take effect on the next `mono-agent restart`.
 */
export function buildTuiConfigSummary(
  input: BuildTuiConfigSummaryInput,
): readonly TuiConfigSummarySection[] {
  return buildMonoAgentConfigView(input).map((section) => ({
    heading: section.id,
    fields: section.fields.map((field) => ({
      label: field.label,
      value: field.value,
      source: field.source,
      ...(field.redacted === true ? { redacted: true } : {}),
    })),
  }));
}
