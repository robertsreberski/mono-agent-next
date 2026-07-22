import { isPlainObject, isValidMcpServerName } from "./runtime-helpers.js";

/**
 * Canonical, SDK-agnostic MCP server transport. Each SDK runtime keeps a thin
 * projector that maps these onto its own constructor shape, so the
 * name-collision `translateMcpServers` variants converge on one parser.
 */
export type NormalizedMcpTransport = "http" | "sse" | "stdio";

/**
 * One parsed MCP server entry. `transport` is decided up front from the raw
 * record; the projectors switch on it instead of re-classifying. Only the fields
 * relevant to the chosen transport are populated.
 */
export interface NormalizedMcpServer {
  readonly name: string;
  readonly transport: NormalizedMcpTransport;
  /** Present for http/sse transports. */
  readonly url?: string;
  /** Header map for http/sse transports, when supplied. */
  readonly headers?: Record<string, string>;
  /** Present for the stdio transport. */
  readonly command?: string;
  /** stdio argv (string entries only). */
  readonly args?: readonly string[];
  /** stdio environment overrides (string values only). */
  readonly env?: Record<string, string>;
  /** stdio working directory. */
  readonly cwd?: string;
}

/**
 * Parses the loosely-typed `mcpServers` map (the runtime-contract
 * `Record<string, unknown>`) into the canonical model. Entries with invalid
 * names or shapes are dropped rather than throwing, matching the historical
 * lenient behaviour of every per-runtime translateMcpServers. Returns an empty
 * array (never undefined) when there is nothing to parse, so callers decide
 * their own empty-handling.
 */
export function parseMcpServers(
  input: Record<string, unknown> | undefined,
): readonly NormalizedMcpServer[] {
  if (input === undefined) {
    return [];
  }
  const out: NormalizedMcpServer[] = [];
  for (const [name, raw] of Object.entries(input)) {
    if (!isValidMcpServerName(name) || !isPlainObject(raw)) {
      continue;
    }
    const parsed = parseEntry(name, raw);
    if (parsed !== undefined) {
      out.push(parsed);
    }
  }
  return out;
}

function parseEntry(name: string, value: Record<string, unknown>): NormalizedMcpServer | undefined {
  const type = typeof value.type === "string" ? value.type : undefined;
  const command = typeof value.command === "string" ? value.command : undefined;
  const url = typeof value.url === "string" ? value.url : undefined;
  const headers = isPlainObject(value.headers) ? stringValueRecord(value.headers) : undefined;

  if (type === "sse") {
    if (url === undefined) {
      return undefined;
    }
    return stripUndefined({ name, transport: "sse", url, headers });
  }

  // http is the default for url-only records (no command and no explicit type).
  if (type === "http" || (type === undefined && url !== undefined && command === undefined)) {
    if (url === undefined) {
      return undefined;
    }
    return stripUndefined({ name, transport: "http", url, headers });
  }

  if (type === "stdio" || command !== undefined) {
    if (command === undefined) {
      return undefined;
    }
    return stripUndefined({
      name,
      transport: "stdio",
      command,
      args: Array.isArray(value.args)
        ? value.args.filter((arg): arg is string => typeof arg === "string")
        : undefined,
      env: isPlainObject(value.env) ? stringValueRecord(value.env) : undefined,
      cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    });
  }

  return undefined;
}

function stringValueRecord(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function stripUndefined(value: {
  readonly name: string;
  readonly transport: NormalizedMcpTransport;
  readonly url?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: Record<string, string> | undefined;
  readonly cwd?: string | undefined;
}): NormalizedMcpServer {
  return {
    name: value.name,
    transport: value.transport,
    ...(value.url === undefined ? {} : { url: value.url }),
    ...(value.headers === undefined ? {} : { headers: value.headers }),
    ...(value.command === undefined ? {} : { command: value.command }),
    ...(value.args === undefined ? {} : { args: value.args }),
    ...(value.env === undefined ? {} : { env: value.env }),
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
  };
}
