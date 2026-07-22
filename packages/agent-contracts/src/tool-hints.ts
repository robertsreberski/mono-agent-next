/**
 * Friendly, secret-safe tool activity copy shared by chat channels.
 *
 * `toolHintFor()` preserves the original one-line hint behavior used by
 * streaming channels. `formatToolActivityLine()` is the richer final-only
 * status used by Slack and Telegram: it includes a bounded preview from a small
 * allowlist of scalar argument fields, but never serializes arbitrary tool
 * input or invokes getters/proxies.
 */

import { homedir } from "node:os";
import { types as nodeUtilTypes } from "node:util";

const BUILTIN_HINTS: Readonly<Record<string, string>> = {
  websearch: "Searching the web…",
  webfetch: "Reading a page…",
  bash: "Running a command…",
  read: "Reading files…",
  write: "Writing a file…",
  edit: "Editing a file…",
  glob: "Looking through files…",
  grep: "Searching the workspace…",
};

// Keyword hints matched against the tool segment of MCP tool names
// (mcp__server__tool) so integrations get a natural hint without enumerating
// every tool. Ordered: first match wins.
const KEYWORD_HINTS: ReadonlyArray<readonly [test: RegExp, hint: string]> = [
  [/calendar|event|gcal/u, "Checking the calendar…"],
  [/mail|gmail|email/u, "Checking email…"],
  [/search|find|query|lookup/u, "Searching…"],
  [/todo|task|reminder/u, "Checking your tasks…"],
  [/note|draft|doc/u, "Looking through notes…"],
  [/slack|message|chat|send/u, "Checking messages…"],
  [/file|read|fetch|get|list/u, "Looking something up…"],
  [/web|browse|http|url/u, "Browsing the web…"],
];

export function toolHintFor(toolName: string): string {
  const raw = typeof toolName === "string" ? toolName.trim() : "";
  if (raw.length === 0) {
    return "Working…";
  }

  // mcp__server__tool → use the tool segment (last) for matching + humanizing.
  const segment = raw.startsWith("mcp__")
    ? (raw.split("__").pop() ?? raw)
    : raw;
  const normalized = segment.toLowerCase();

  const builtin = BUILTIN_HINTS[normalized];
  if (builtin !== undefined) {
    return builtin;
  }
  for (const [test, hint] of KEYWORD_HINTS) {
    if (test.test(normalized)) {
      return hint;
    }
  }
  return "Working…";
}

const TOOL_PREVIEW_CODE_POINTS = 40;
const TOOL_PREVIEW_SCAN_CODE_POINTS = 4_096;
const REDACTED = "[redacted]";

interface ToolActivitySpec {
  readonly action: string;
  readonly actionWithoutPreview?: string;
  readonly previewFields: readonly string[];
  readonly quotePreview?: boolean;
}

const WEB_SEARCH_NAMES = new Set([
  "websearch",
  "searchquery",
  "searchweb",
  "internetsearch",
  "googlesearch",
  "bingsearch",
]);
const WEB_BROWSE_NAMES = new Set([
  "webfetch",
  "browse",
  "browseurl",
  "browseropen",
  "fetchurl",
  "navigate",
  "open",
  "openurl",
  "fetch",
]);
const READ_NAMES = new Set(["read", "readfile"]);
const SKILL_READ_NAMES = new Set(["readskill"]);
const FILE_SEARCH_NAMES = new Set(["glob", "grep", "searchfiles"]);
const WRITE_NAMES = new Set(["write", "writefile"]);
const EDIT_NAMES = new Set(["applypatch", "edit", "editfile", "patch"]);
const COMMAND_NAMES = new Set([
  "bash",
  "exec",
  "execcommand",
  "runcommand",
  "shell",
  "terminal",
]);
const CODE_NAMES = new Set([
  "code",
  "codeinterpreter",
  "executecode",
  "python",
  "pythoncode",
  "runcode",
]);
const IMAGE_NAMES = new Set([
  "analyzeimage",
  "image",
  "lookatimage",
  "viewimage",
  "vision",
]);
const MEMORY_NAMES = new Set([
  "memory",
  "memoryupdate",
  "memorywrite",
  "remember",
  "updatememory",
]);
const MEMORY_READ_NAMES = new Set(["memoryrecall"]);

const SENSITIVE_ASSIGNMENT_PATTERN = /\b((?:[A-Za-z][A-Za-z0-9_-]*)?(?:authorization|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|security[-_]?token|password|passwd|secret|private[-_]?key|credential|session[-_]?(?:id|token)|token))\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const SENSITIVE_QUERY_PATTERN = /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|client[-_]?secret|password|passwd|secret|signature|x-amz-signature|ticket|token)=)[^&#\s]*/giu;
const URL_USERINFO_PATTERN = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s@]*@/gu;
const SENSITIVE_FLAG_PATTERN = /(^|\s)(--?(?:[A-Za-z][A-Za-z0-9_-]*[-_])?(?:authorization|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|security[-_]?token|password|passwd|secret|private[-_]?key|credential|session[-_]?(?:id|token)|token))(?:\s+|=)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const BASIC_AUTH_FLAG_PATTERN = /(^|\s)(-u|--user(?:name)?)(?:\s+|=)(?:"[^"]*:[^"]*"|'[^']*:[^']*'|[^\s,;]+:[^\s,;]+)/giu;
const MYSQL_PASSWORD_FLAG_PATTERN = /(\b(?:mysql|mysqladmin|mysqldump|mysqlshow|mysqlimport|mysqlslap|mariadb|mariadb-dump)\b(?:(?![;&|]).)*?\s)(-p)(?:\s+|=)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const MYSQL_ATTACHED_PASSWORD_FLAG_PATTERN = /(\b(?:mysql|mysqladmin|mysqldump|mysqlshow|mysqlimport|mysqlslap|mariadb|mariadb-dump)\b(?:(?![;&|]).)*?\s)(-p)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const KNOWN_SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}\b/gu,
  /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
];

export interface ToolActivityLineOptions {
  /** Agent root used to relativize local paths; defaults to process.cwd(). */
  readonly workspaceRoot?: string;
  /** Home directory collapsed to `~`; defaults to os.homedir(). */
  readonly homeDir?: string;
}

/**
 * Format one cumulative tool-activity line for a user-visible transient status.
 * A malformed/proxied/accessor-backed argument object produces action-only copy.
 * Local absolute paths are shown relative to the agent root (or `~`) so the
 * operator's account/machine layout is not exposed in chat surfaces.
 */
export function formatToolActivityLine(
  toolName: string,
  toolArguments?: unknown,
  options?: ToolActivityLineOptions,
): string {
  const rawName = typeof toolName === "string" ? toolName.trim() : "";
  const leaf = toolLeaf(rawName);
  const normalized = leaf.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  const spec = activitySpec(normalized, leaf);
  const preview = previewFromArguments(toolArguments, spec.previewFields, options);
  return preview === undefined
    ? (spec.actionWithoutPreview ?? spec.action)
    : `${spec.action} ${spec.quotePreview ? JSON.stringify(preview) : preview}`;
}

/**
 * Format one applied live-input activity line for every structured stream.
 * The original follow-up remains a human message; this helper exposes only a
 * one-line, secret-redacted preview capped at the same 40-code-point boundary
 * used by transient tool activity.
 */
export function formatLiveInputActivityLine(
  text: string,
  options?: ToolActivityLineOptions,
): string {
  const preview = sanitizePreview(text, "head", options);
  return preview === undefined ? "↪️ Steered" : `↪️ Steered: “${preview}”`;
}

function activitySpec(normalized: string, leaf: string): ToolActivitySpec {
  if (WEB_SEARCH_NAMES.has(normalized)) {
    return {
      action: "🌐 Searching the web for",
      actionWithoutPreview: "🌐 Searching the web",
      previewFields: ["query", "q", "search_query", "text", "prompt"],
    };
  }
  if (WEB_BROWSE_NAMES.has(normalized)) {
    return { action: "🌐 Browsing", previewFields: ["url", "href", "uri", "ref_id"] };
  }
  if (SKILL_READ_NAMES.has(normalized)) {
    return { action: "📚 Reading", previewFields: ["name"], quotePreview: true };
  }
  if (READ_NAMES.has(normalized)) {
    return { action: "📖 Reading", previewFields: ["file_path", "path", "name", "skill", "skill_name"] };
  }
  if (FILE_SEARCH_NAMES.has(normalized)) {
    return {
      action: "🔎 Searching files for",
      actionWithoutPreview: "🔎 Searching files",
      previewFields: ["pattern", "query", "glob", "path"],
    };
  }
  if (WRITE_NAMES.has(normalized)) {
    return { action: "📝 Writing", previewFields: ["file_path", "path", "destination", "name"] };
  }
  if (EDIT_NAMES.has(normalized)) {
    return { action: "✏️ Editing", previewFields: ["file_path", "path", "destination", "name"] };
  }
  if (COMMAND_NAMES.has(normalized)) {
    return { action: "🖥️ Running", previewFields: ["command", "cmd", "script"] };
  }
  if (CODE_NAMES.has(normalized)) {
    return { action: "🐍 Running code", previewFields: ["code", "source", "script"] };
  }
  if (IMAGE_NAMES.has(normalized)) {
    return { action: "👁️ Looking at the image", previewFields: ["question", "prompt", "path", "file_path", "name"] };
  }
  if (MEMORY_READ_NAMES.has(normalized)) {
    // A recall query can contain private user context. Keep this status both
    // semantically distinct from writes and deliberately preview-free.
    return { action: "🧠 Recalling memory", previewFields: [] };
  }
  if (MEMORY_NAMES.has(normalized) || normalized.includes("memory")) {
    // Deliberately exclude content/text fields: memory prose can itself be
    // sensitive. Only the operation or destination is suitable for a preview.
    return { action: "🧠 Updating memory", previewFields: ["action", "target", "path", "name"] };
  }
  return {
    action: `🔧 ${humanizeToolLeaf(leaf)}`,
    previewFields: ["query", "url", "path", "name", "action", "target", "command", "cmd"],
  };
}

function toolLeaf(toolName: string): string {
  if (toolName.length === 0) return "Tool";
  const mcpLeaf = toolName.split("__").at(-1) ?? toolName;
  const dottedLeaf = mcpLeaf.split(/[./:]/u).at(-1) ?? mcpLeaf;
  return dottedLeaf.length > 0 ? dottedLeaf : "Tool";
}

function humanizeToolLeaf(leaf: string): string {
  const cleaned = leaf
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
  if (cleaned.length === 0) return "Tool";
  const bounded = truncateCodePoints(cleaned, TOOL_PREVIEW_CODE_POINTS);
  return `${bounded.charAt(0).toUpperCase()}${bounded.slice(1)}`;
}

function previewFromArguments(
  toolArguments: unknown,
  previewFields: readonly string[],
  options?: ToolActivityLineOptions,
): string | undefined {
  const record = safePlainRecord(toolArguments);
  if (record === undefined) return undefined;

  for (const key of previewFields) {
    const value = safeOwnScalar(record, key);
    if (value === undefined) continue;
    const preview = sanitizePreview(value, previewTruncationForField(key), options);
    if (preview !== undefined) return preview;
  }
  return undefined;
}

/**
 * Show local paths relative to the agent root (and collapse the operator's
 * home directory to `~`) before truncation, so transient chat statuses never
 * expose the full absolute machine layout.
 */
function relativizeLocalPaths(value: string, options?: ToolActivityLineOptions): string {
  let result = value;
  for (const [root, replacement] of [
    [normalizeRoot(options?.workspaceRoot ?? safeCwd()), ""],
    [normalizeRoot(options?.homeDir ?? safeHomedir()), "~/"],
  ] as const) {
    if (root === undefined) continue;
    result = result.replaceAll(`${root}/`, replacement);
  }
  return result;
}

function normalizeRoot(root: string | undefined): string | undefined {
  if (root === undefined || root === "" || root === "/") return undefined;
  return root.endsWith("/") ? root.slice(0, -1) : root;
}

function safeCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

function safeHomedir(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

type PreviewTruncation = "head" | "middle" | "balanced";

function previewTruncationForField(field: string): PreviewTruncation {
  if (field === "file_path" || field === "path" || field === "destination") {
    return "middle";
  }
  if (field === "command" || field === "cmd" || field === "script" || field === "code" || field === "source") {
    return "balanced";
  }
  return "head";
}

function safePlainRecord(value: unknown): object | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (nodeUtilTypes.isProxy(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? value : undefined;
  } catch {
    return undefined;
  }
}

function safeOwnScalar(record: object, key: string): string | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    const value = descriptor.value as unknown;
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return String(value);
  } catch {
    return undefined;
  }
  return undefined;
}

function sanitizePreview(
  value: string,
  truncation: PreviewTruncation,
  options?: ToolActivityLineOptions,
): string | undefined {
  let sanitized = truncateCodePoints(value, TOOL_PREVIEW_SCAN_CODE_POINTS)
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (sanitized.length === 0) return undefined;
  sanitized = relativizeLocalPaths(sanitized, options);

  sanitized = sanitized
    .replace(URL_USERINFO_PATTERN, "$1")
    .replace(SENSITIVE_QUERY_PATTERN, `$1${REDACTED}`)
    .replace(SENSITIVE_FLAG_PATTERN, (_match, boundary: string, flag: string) =>
      `${boundary}${flag} ${REDACTED}`)
    .replace(BASIC_AUTH_FLAG_PATTERN, (_match, boundary: string, flag: string) =>
      `${boundary}${flag} ${REDACTED}`)
    .replace(MYSQL_PASSWORD_FLAG_PATTERN, (_match, prefix: string, flag: string) =>
      `${prefix}${flag} ${REDACTED}`)
    .replace(MYSQL_ATTACHED_PASSWORD_FLAG_PATTERN, (_match, prefix: string, flag: string) =>
      `${prefix}${flag}${REDACTED}`)
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(AUTH_SCHEME_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED}`);
  for (const pattern of KNOWN_SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, REDACTED);
  }
  sanitized = sanitized.replace(/\s+/gu, " ").trim();
  if (sanitized.length === 0) return undefined;
  return truncatePreview(sanitized, TOOL_PREVIEW_CODE_POINTS, truncation);
}

function truncatePreview(value: string, maxCodePoints: number, mode: PreviewTruncation): string {
  if (mode === "head") return truncateCodePoints(value, maxCodePoints);
  const points = Array.from(value);
  if (points.length <= maxCodePoints) return value;
  const visible = Math.max(0, maxCodePoints - 1);
  const prefixLength = mode === "middle" ? Math.floor(visible / 3) : Math.ceil(visible / 2);
  const suffixLength = visible - prefixLength;
  return `${points.slice(0, prefixLength).join("")}…${points.slice(-suffixLength).join("")}`;
}

function truncateCodePoints(value: string, maxCodePoints: number): string {
  const points = Array.from(value);
  return points.length <= maxCodePoints
    ? value
    : `${points.slice(0, Math.max(0, maxCodePoints - 1)).join("")}…`;
}
