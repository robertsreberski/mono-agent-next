/** Header names that must never cross an inbound HTTP adapter metadata boundary. */
const SENSITIVE_INBOUND_HTTP_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
]);

export type InboundHttpHeaders = Readonly<
  Record<string, string | string[] | undefined>
>;

/**
 * Copy request headers while removing credentials and cookies case-insensitively.
 * HTTP-bearing adapters share this helper so their metadata redaction cannot drift.
 */
export function sanitizeInboundHttpHeaders(
  headers: InboundHttpHeaders,
): Record<string, string | string[] | undefined> {
  const sanitized: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!SENSITIVE_INBOUND_HTTP_HEADERS.has(name.toLowerCase())) {
      sanitized[name] = value;
    }
  }
  return sanitized;
}
