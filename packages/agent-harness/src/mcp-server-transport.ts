import { parseMcpServers } from "@mono-agent/runtime-adapter";

export type ContinuationMcpServerTransport = "stdio" | "http" | "unsupported";

/**
 * Classify the MCP transports that can safely receive request-bound
 * continuation capabilities. Kept in the harness package so startup
 * validation and runtime injection enforce one contract.
 */
export function classifyContinuationMcpServerTransport(value: unknown): ContinuationMcpServerTransport {
  if (isStdioMcpServerSpec(value)) return "stdio";
  if (!isRecord(value) || !isLoopbackHttpMcpServerSpec(value)) return "unsupported";
  return "http";
}

export function isStdioMcpServerSpec(value: unknown): value is Record<string, unknown> {
  return normalizedMcpTransport(value) === "stdio";
}

function isLoopbackHttpMcpServerSpec(spec: Record<string, unknown>): boolean {
  if (normalizedMcpTransport(spec) !== "http") return false;
  const urlValue = spec.url as string;
  try {
    const url = new URL(urlValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * Project through the canonical runtime parser before accepting a transport.
 * Continuation capability injection must never bless a declaration the runtime
 * will drop, or reinterpret a contradictory stdio/HTTP shape differently.
 */
function normalizedMcpTransport(value: unknown): "stdio" | "http" | "sse" | undefined {
  if (!isRecord(value) || hasConflictingTransportFields(value)) return undefined;
  if (typeof value.command === "string" && value.command.trim().length === 0) return undefined;
  const [parsed] = parseMcpServers({ continuation_server: value });
  return parsed?.transport;
}

function hasConflictingTransportFields(spec: Record<string, unknown>): boolean {
  const hasCommand = typeof spec.command === "string";
  const hasUrl = typeof spec.url === "string";
  if (hasCommand && hasUrl) return true;
  if (spec.type === "stdio" && hasUrl) return true;
  if ((spec.type === "http" || spec.type === "sse") && hasCommand) return true;
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
