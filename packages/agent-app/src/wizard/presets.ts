import { defaultAnswers, type WizardAnswers } from "./answers.js";

/**
 * A saved answer-set the wizard can start from: the opinionated blueprints that
 * replace the old recipes. A preset is only a `Partial<WizardAnswers>` — the
 * composer's {@link defaultAnswers} fills the rest and recomputes `allowedTools`,
 * so there is still exactly one config-generation path.
 */
export interface WizardPreset {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: "low" | "medium" | "high";
  /**
   * The `docs/playbooks/<file>` this preset mirrors. Parity-checked by
   * `src/__tests__/presets-docs-parity.test.ts`, which asserts the file exists.
   */
  readonly playbook?: string;
  readonly answers: Partial<WizardAnswers>;
}

/**
 * The five built-in starter presets, in wizard-presentation order. Each maps to an
 * existing playbook. The former recipe → preset mapping now lives as a static table
 * in docs/reference/presets.md (the recipe surface was removed from the CLI).
 */
export const PRESET_CATALOG: readonly WizardPreset[] = [
  {
    id: "starter",
    title: "Starter (webhook smoke agent)",
    description: "Webhook loopback, no credentials, no memory — the lowest-friction smoke agent.",
    riskLevel: "low",
    playbook: "webhook-automation-sync-async.md",
    answers: {},
  },
  {
    id: "telegram-assistant",
    title: "Telegram assistant (BuJo memory)",
    description: "A Telegram bot with daily-log capture + semantic recall.",
    riskLevel: "medium",
    playbook: "telegram-personal-assistant-bujo.md",
    answers: { channels: ["channel:telegram"], memory: "memory:bujo" },
  },
  {
    id: "slack-bot",
    title: "Slack team bot",
    description: "A Socket-Mode Slack bot scoped to a channel allowlist, with the send tool.",
    riskLevel: "medium",
    playbook: "slack-team-bot-mcp-tools.md",
    answers: { channels: ["channel:slack"] },
  },
  {
    id: "local-private",
    title: "Local private agent (Ollama)",
    description:
      "Runs entirely on a local Ollama provider with journal memory — no remote calls. Light 8B default for a fast first turn.",
    riskLevel: "low",
    playbook: "local-only-ollama-agent.md",
    answers: {
      model: "pi:ollama:llama3.1:8b",
      channels: ["channel:webhook"],
      memory: "memory:journal",
    },
  },
  {
    id: "code-sandbox",
    title: "Sandboxed code agent",
    description: "Managed SRT sandbox with workspace-only FS and code tools; installs and preflights fail-closed enforcement.",
    riskLevel: "medium",
    playbook: "sandboxed-code-agent.md",
    answers: {
      model: "pi:openai-codex:gpt-5.6-terra",
      channels: ["channel:webhook"],
      sandbox: true,
    },
  },
];

/** Look up a preset by id, or `undefined` when unknown. */
export function findPreset(id: string): WizardPreset | undefined {
  return PRESET_CATALOG.find((preset) => preset.id === id);
}

/** Every preset id, in catalog order. */
export function presetIds(): readonly string[] {
  return PRESET_CATALOG.map((preset) => preset.id);
}

/** Resolve a preset to full wizard answers via the single {@link defaultAnswers} path. */
export function presetAnswers(preset: WizardPreset): WizardAnswers {
  return defaultAnswers(preset.answers);
}
