// SPDX-License-Identifier: MIT
import { boundedInteger } from "./bounded-integer.js";
export const DEFAULT_HTTP_MAX_RESPONSE_BYTES = 1_048_576;
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
export const DEFAULT_HTTP_MAX_REDIRECTS = 3;
const CROSS_ORIGIN_HEADER_ALLOWLIST = new Set(["accept", "content-type", "user-agent"]);
export type HttpSafetyErrorCode =
  | "invalid_url"
  | "unsafe_protocol"
  | "embedded_credentials"
  | "invalid_limit"
  | "redirect_missing_location"
  | "redirect_limit"
  | "redirect_cross_origin"
  | "redirect_unsafe_method"
  | "response_too_large"
  | "request_failed";
export class HttpSafetyError extends Error {
  readonly code: HttpSafetyErrorCode;
  readonly url?: string;
  readonly status?: number;
  constructor(options: {
    readonly code: HttpSafetyErrorCode;
    readonly message: string;
    readonly url?: string;
    readonly status?: number;
    readonly cause?: unknown;
  }) {
    if (options.cause === undefined) super(options.message);
    else super(options.message, { cause: options.cause });
    this.name = "HttpSafetyError";
    this.code = options.code;
    if (options.url !== undefined) this.url = options.url;
    if (options.status !== undefined) this.status = options.status;
  }
}
export interface CheckedFetchOptions {
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  /** Allowed cross-origin redirects retain only Accept, Content-Type, and User-Agent. */
  readonly allowCrossOriginRedirects?: boolean;
}
export interface BoundedHttpResponse {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
  text(): string;
  json(): unknown;
}
/** True only for numeric loopback literals; DNS names such as localhost fail. */
export function isLiteralLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}
/** HTTPS is allowed; plaintext HTTP is restricted to an explicitly literal loopback host. */
export function assertSafeHttpUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input instanceof URL ? input.href : input);
  } catch (error) {
    throw httpError("invalid_url", "HTTP URL is invalid", undefined, undefined, error);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw httpError("embedded_credentials", "HTTP URLs must not embed credentials", url.href);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol !== "http:" || !isLiteralLoopbackHostname(url.hostname) || !hasLiteralLoopbackAuthority(input, url)) {
    throw httpError(
      "unsafe_protocol",
      "HTTP URL must use HTTPS or a literal 127.0.0.1/[::1] loopback host",
      url.href,
    );
  }
  return url;
}
/**
 * Fetch a bounded response while manually validating every redirect. Redirects
 * for mutating methods and cross-origin redirects are denied by default.
 */
export async function checkedFetch(
  input: string | URL,
  init: RequestInit = {},
  options: CheckedFetchOptions = {},
): Promise<BoundedHttpResponse> {
  const maxResponseBytes = boundedInteger(
    options.maxResponseBytes ?? DEFAULT_HTTP_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
    1,
    1_073_741_824,
    (message) => httpError("invalid_limit", message),
  );
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    "timeoutMs",
    1,
    3_600_000,
    (message) => httpError("invalid_limit", message),
  );
  const maxRedirects = boundedInteger(
    options.maxRedirects ?? DEFAULT_HTTP_MAX_REDIRECTS,
    "maxRedirects",
    0,
    20,
    (message) => httpError("invalid_limit", message),
  );
  let url = assertSafeHttpUrl(input);
  let headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal == null
    ? timeoutSignal
    : AbortSignal.any([init.signal, timeoutSignal]);
  for (let redirects = 0; ; redirects += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        method,
        headers,
        redirect: "manual",
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      throw httpError("request_failed", "Bounded HTTP request failed", url.href, undefined, error);
    }
    if (!isRedirectStatus(response.status)) {
      const body = await readBoundedBody(response, maxResponseBytes);
      return boundedResponse(response, body);
    }
    await response.body?.cancel();
    if (method !== "GET" && method !== "HEAD") {
      throw httpError(
        "redirect_unsafe_method",
        `Refusing to replay ${method} across an HTTP redirect`,
        url.href,
        response.status,
      );
    }
    if (redirects >= maxRedirects) {
      throw httpError("redirect_limit", "HTTP redirect limit exceeded", url.href, response.status);
    }
    const location = response.headers.get("location");
    if (location === null) {
      throw httpError("redirect_missing_location", "HTTP redirect has no Location header", url.href, response.status);
    }
    let next: URL;
    try {
      next = assertSafeHttpUrl(new URL(location, url));
    } catch (error) {
      if (error instanceof HttpSafetyError) throw error;
      throw httpError("invalid_url", "HTTP redirect Location is invalid", url.href, response.status, error);
    }
    if (next.origin !== url.origin) {
      if (options.allowCrossOriginRedirects !== true) {
        throw httpError(
          "redirect_cross_origin",
          "Cross-origin HTTP redirect was not explicitly allowed",
          next.href,
          response.status,
        );
      }
      headers = withoutSensitiveHeaders(headers);
    }
    url = next;
  }
}
/** Backward-readable alias emphasizing that the response body is fully bounded. */
export const fetchBounded = checkedFetch;
async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await response.body?.cancel();
    throw httpError("response_too_large", `HTTP response exceeds ${maxBytes} bytes`, response.url, response.status);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw httpError("response_too_large", `HTTP response exceeds ${maxBytes} bytes`, response.url, response.status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
function boundedResponse(response: Response, body: Uint8Array): BoundedHttpResponse {
  const copy = new Uint8Array(body);
  return Object.freeze({
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
    body: copy,
    text: () => new TextDecoder("utf-8", { fatal: true }).decode(copy),
    json: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(copy)) as unknown,
  });
}
function withoutSensitiveHeaders(input: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of input) {
    if (CROSS_ORIGIN_HEADER_ALLOWLIST.has(name.toLowerCase())) {
      headers.append(name, value);
    }
  }
  return headers;
}
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
function hasLiteralLoopbackAuthority(input: string | URL, parsed: URL): boolean {
  if (input instanceof URL) return isLiteralLoopbackHostname(input.hostname);
  const match = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/iu.exec(input);
  if (match === null) return false;
  const authority = match[1];
  if (authority === undefined || authority.includes("@") || authority.includes("%")) return false;
  let hostname: string;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) return false;
    hostname = authority.slice(0, close + 1);
  } else {
    hostname = authority.split(":", 1)[0] ?? "";
  }
  return isLiteralLoopbackHostname(hostname) && isLiteralLoopbackHostname(parsed.hostname);
}
function httpError(
  code: HttpSafetyErrorCode,
  message: string,
  url?: string,
  status?: number,
  cause?: unknown,
): HttpSafetyError {
  return new HttpSafetyError({
    code,
    message,
    ...(url === undefined ? {} : { url }),
    ...(status === undefined ? {} : { status }),
    ...(cause === undefined ? {} : { cause }),
  });
}
