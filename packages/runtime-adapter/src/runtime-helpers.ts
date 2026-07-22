/**
 * Structural object guard shared by all runtimes. Excludes arrays so callers can
 * treat the result as a plain `Record<string, unknown>`. Codex previously kept
 * ~4 byte-identical copies of this; the SDK runtimes all used the same shape.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The MCP server name policy shared by all three SDK projectors. */
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/u;

/** True when `name` is a syntactically valid MCP server key. */
export function isValidMcpServerName(name: string): boolean {
  return MCP_SERVER_NAME_RE.test(name);
}
