// @ts-check

const PI_TRANSPORTS = new Set(["auto", "sse", "websocket", "websocket-cached"]);

/**
 * Normalize the public runtime option at the untyped JS boundary. Typed/config
 * callers already validate it; direct JavaScript callers fail safely to Pi's
 * compatibility-preserving automatic transport selection.
 * @param {unknown} value
 * @returns {"auto" | "sse" | "websocket" | "websocket-cached"}
 */
export function resolvePiTransport(value) {
  return typeof value === "string" && PI_TRANSPORTS.has(value)
    ? /** @type {"auto" | "sse" | "websocket" | "websocket-cached"} */ (value)
    : "auto";
}
