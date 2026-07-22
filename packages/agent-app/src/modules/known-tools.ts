/**
 * The single source of truth for tool names, shared by the wizard, doctor, and
 * tests. Names are exact and case-sensitive, verified against the runtime's
 * `pi-bridge.js` (built-ins) and `adapter-send-tools.ts` (adapter send tools).
 */

import { ALLOW_ALL_TOOLS } from "@mono-agent/config";

/** Re-export the allow-all sentinel so agent-app callers share one canonical value. */
export { ALLOW_ALL_TOOLS };

/** Mono-agent-managed built-ins gated by `tools.allowedTools` (pi-bridge.js). */
export const BUILTIN_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "NodeRepl",
  "WebFetch",
  "WebSearch",
] as const;

/** App-owned tools injected by the configured host and governed by tool policy. */
export const APP_TOOL_NAMES = [
  "RunHistory",
] as const;

/** Adapter send tools — require BOTH an `allowedTools` entry AND an enabled channel. */
export const ADAPTER_SEND_TOOL_NAMES = [
  "SlackSendMessage",
  "TelegramSendMessage",
  "TelegramSendFile",
  "AskUser",
] as const;

/**
 * Permanent compatibility input aliases for old snake_case tool names. Existing
 * hand-written allow/deny policies cannot be migrated automatically; in
 * particular, a legacy deny-list entry must not stop matching and silently
 * broaden access. Each alias maps to its canonical PascalCase name;
 * `telegram_send_document`/`telegram_send_photo` both collapse to the single
 * `TelegramSendFile` tool. The allow/deny matcher and doctor normalize through
 * this map, while canonical names are the only ones registered, emitted, or
 * recommended. There is no scheduled removal.
 */
export const LEGACY_TOOL_ALIASES: Record<string, string> = {
  slack_send_message: "SlackSendMessage",
  telegram_send_message: "TelegramSendMessage",
  telegram_send_document: "TelegramSendFile",
  telegram_send_photo: "TelegramSendFile",
  run_history: "RunHistory",
  memory_recall: "MemoryRecall",
  read_skill: "ReadSkill",
  ask_collaborator: "AskCollaborator",
};

/** The canonical new name for a tool, resolving a legacy snake_case alias if given. */
export function canonicalToolName(name: string): string {
  return LEGACY_TOOL_ALIASES[name] ?? name;
}

/** Safe read-only default pre-checked for every new agent. */
export const DEFAULT_SAFE_TOOLS = ["Read", "Glob", "Grep"] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];
export type AppToolName = (typeof APP_TOOL_NAMES)[number];
export type AdapterSendToolName = (typeof ADAPTER_SEND_TOOL_NAMES)[number];

/**
 * All offline-knowable tool names: built-ins, adapter send tools, AND the canonical
 * PascalCase names that only exist as alias VALUES (`ReadSkill`, `AskCollaborator`,
 * `MemoryRecall`). Folding in the alias values keeps the new
 * canonical names at least as "known" as their deprecated snake_case spellings — a
 * config listing `ReadSkill` must validate as cleanly as one listing `read_skill`.
 */
const KNOWN_TOOL_NAMES: readonly string[] = [
  ...new Set<string>([
    ...BUILTIN_TOOL_NAMES,
    ...APP_TOOL_NAMES,
    ...ADAPTER_SEND_TOOL_NAMES,
    ...Object.values(LEGACY_TOOL_ALIASES),
  ]),
];

/**
 * True when `name` is a built-in, an adapter send tool, or a canonical alias-value
 * name (exact, case-sensitive match). Legacy snake_case alias KEYS are also accepted
 * so an old config keeps validating cleanly through the rename.
 */
export function isKnownToolName(name: string): boolean {
  return name === ALLOW_ALL_TOOLS || KNOWN_TOOL_NAMES.includes(name) || name in LEGACY_TOOL_ALIASES;
}

/** True when `list` contains the global allow-all sentinel (`"*"`). */
export function isAllowAllTools(list: readonly string[]): boolean {
  return list.includes(ALLOW_ALL_TOOLS);
}

/** True when `name` targets an MCP server tool (`mcp__…`) — cannot be validated offline. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__");
}

/**
 * The closest known tool name for a typo, case-insensitive (e.g. `read` → `Read`),
 * else undefined. Used by doctor for "did you mean" hints. Matches
 * case-insensitively against the known set (BUILTIN ∪ ADAPTER_SEND ∪ alias values).
 */
export function suggestToolName(name: string): string | undefined {
  const lowered = name.toLowerCase();
  return KNOWN_TOOL_NAMES.find((known) => known.toLowerCase() === lowered);
}
