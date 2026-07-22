/**
 * Timing-safe bearer-token helpers shared by every bearer-protected surface.
 * Single-sources the constant-time compare so adapters stop comparing inbound
 * tokens with `===` (a timing side-channel on a server-side secret).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

/** Generate a 32-byte random hex token for per-boot bearer auth. */
export function generateBearerToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Constant-time token comparison. Returns false for length mismatches (length
 * is not secret in this protocol, so leaking it via early exit is acceptable).
 */
export function bearerTokensEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Extract the token from an `Authorization: Bearer <token>` header value.
 * Returns undefined when the header is absent or not a bearer credential.
 */
export function readAuthorizationBearer(
  authorization: string | undefined,
): string | undefined {
  if (typeof authorization !== "string") {
    return undefined;
  }
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  const token = authorization.slice("bearer ".length).trim();
  return token.length === 0 ? undefined : token;
}
