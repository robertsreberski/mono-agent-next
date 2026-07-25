// SPDX-License-Identifier: MIT
import { Buffer } from "node:buffer";
import { lookup } from "node:dns/promises";
import {
  request as httpsRequest,
  type RequestOptions as HttpsRequestOptions,
} from "node:https";
import { BlockList, isIP } from "node:net";

export const WEB_FETCH_MAX_URL_BYTES = 8 * 1024;
export const WEB_FETCH_MAX_HEADER_VALUE_BYTES = 4 * 1024;
export const WEB_FETCH_MAX_RESPONSE_BYTES = 512 * 1024;
export const WEB_FETCH_MAX_OUTPUT_BYTES = 64 * 1024;
export const WEB_FETCH_TIMEOUT_MS = 15_000;
export const WEB_FETCH_MAX_REDIRECTS = 5;
export const WEB_FETCH_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000] as const);

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const SAFE_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "user-agent",
]);
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);
const PUBLIC_ADDRESS_BLOCKLISTS = createPublicAddressBlocklists();

export interface WebFetchInput {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly maxOutputBytes: number;
}

export interface WebFetchAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface WebFetchResponse {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

export interface WebFetchOptions {
  readonly signal?: AbortSignal;
  readonly resolve?: (hostname: string) => Promise<readonly WebFetchAddress[]>;
  readonly request?: (
    url: URL,
    address: WebFetchAddress,
    headers: Headers,
    signal: AbortSignal,
  ) => Promise<WebFetchResponse>;
  readonly timeoutMs?: number;
  readonly retryDelaysMs?: readonly number[];
}

interface PinnedHttpsRequestOptions extends HttpsRequestOptions {
  // Supported by node:net but not yet projected through @types/node's
  // http.RequestOptions even though https.request forwards it.
  readonly autoSelectFamily: false;
}

function webFetchError(message: string, cause?: unknown): Error {
  return cause === undefined
    ? new Error(`WebFetch failed: ${message}`)
    : new Error(`WebFetch failed: ${message}`, { cause });
}

class WebFetchHttpError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(
      `WebFetch failed: ${
        `endpoint returned HTTP ${String(status)} ${statusText}`.trim()
      }`,
    );
    this.status = status;
  }
}

function createPublicAddressBlocklists(): {
  readonly ipv4: BlockList;
  readonly ipv6: BlockList;
} {
  const ipv4 = new BlockList();
  const ipv6 = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    ipv4.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of [
    // Deprecated IPv4-compatible addresses can be routed through IPv4 on
    // some stacks. Block the complete form, including public-looking values.
    ["::", 96],
    ["::1", 128],
    // IPv4-mapped and IPv4-translated forms must not bypass the IPv4 ranges.
    ["::ffff:0:0", 96],
    ["::ffff:0:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["100:0:0:1::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
    ["5f00::", 16],
    ["fc00::", 7],
    ["fec0::", 10],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) {
    ipv6.addSubnet(network, prefix, "ipv6");
  }
  return { ipv4, ipv6 };
}

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/** Return true only for globally routable unicast addresses. */
export function isPublicWebFetchAddress(input: WebFetchAddress): boolean {
  if ((input.family !== 4 && input.family !== 6) || isIP(input.address) !== input.family) {
    return false;
  }
  return input.family === 4
    ? !PUBLIC_ADDRESS_BLOCKLISTS.ipv4.check(input.address, "ipv4")
    : !PUBLIC_ADDRESS_BLOCKLISTS.ipv6.check(input.address, "ipv6");
}

function assertPublicAddresses(
  hostname: string,
  addresses: readonly WebFetchAddress[],
): WebFetchAddress {
  if (addresses.length === 0) {
    throw webFetchError(`DNS returned no addresses for ${JSON.stringify(hostname)}.`);
  }
  for (const address of addresses) {
    if (!isPublicWebFetchAddress(address)) {
      throw webFetchError(
        `DNS returned a non-public address for ${JSON.stringify(hostname)}.`,
      );
    }
  }
  return addresses[0]!;
}

async function resolveHostname(hostname: string): Promise<readonly WebFetchAddress[]> {
  const literal = hostnameWithoutBrackets(hostname);
  const family = isIP(literal);
  if (family === 4 || family === 6) return [{ address: literal, family }];
  const addresses = await lookup(literal, { all: true, verbatim: true });
  return addresses.flatMap((address) =>
    address.family === 4 || address.family === 6
      ? [{ address: address.address, family: address.family }]
      : []);
}

function parseUrl(value: string): URL {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw webFetchError("url must be a non-empty string without NUL bytes.");
  }
  if (Buffer.byteLength(value, "utf8") > WEB_FETCH_MAX_URL_BYTES) {
    throw webFetchError(`url exceeds ${String(WEB_FETCH_MAX_URL_BYTES)} UTF-8 bytes.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw webFetchError("url is invalid.", error);
  }
  if (url.protocol !== "https:") {
    throw webFetchError("url must use public HTTPS.");
  }
  if (url.username !== "" || url.password !== "") {
    throw webFetchError("url must not contain embedded credentials.");
  }
  url.hash = "";
  return url;
}

function checkedHeaders(input: Readonly<Record<string, string>>): Headers {
  const headers = new Headers({
    accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1",
    "accept-encoding": "identity",
    "user-agent": "mono-agent-runtime-pi/0.15",
  });
  const seen = new Set<string>();
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (seen.has(name)) {
      throw webFetchError(`header ${JSON.stringify(rawName)} is duplicated.`);
    }
    seen.add(name);
    if (CREDENTIAL_HEADERS.has(name)) {
      throw webFetchError(`credential header ${JSON.stringify(rawName)} is forbidden.`);
    }
    if (!SAFE_REQUEST_HEADERS.has(name)) {
      throw webFetchError(`header ${JSON.stringify(rawName)} is not allowed.`);
    }
    if (typeof rawValue !== "string"
      || rawValue.includes("\r")
      || rawValue.includes("\n")
      || Buffer.byteLength(rawValue, "utf8") > WEB_FETCH_MAX_HEADER_VALUE_BYTES) {
      throw webFetchError(`header ${JSON.stringify(rawName)} has an invalid value.`);
    }
    headers.set(name, rawValue);
  }
  return headers;
}

function responseHeaders(rawHeaders: readonly string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

/** @internal Exported only for direct transport regression coverage. */
export async function requestPinnedHttps(
  url: URL,
  address: WebFetchAddress,
  headers: Headers,
  signal: AbortSignal,
): Promise<WebFetchResponse> {
  signal.throwIfAborted();
  return new Promise<WebFetchResponse>((resolve, reject) => {
    let settled = false;
    const finish = (
      callback: () => void,
    ): void => {
      if (settled) return;
      settled = true;
      callback();
    };
    const requestOptions: PinnedHttpsRequestOptions = {
      protocol: "https:",
      hostname: hostnameWithoutBrackets(url.hostname),
      port: url.port === "" ? 443 : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: Object.fromEntries(headers.entries()),
      signal,
      ...(isIP(hostnameWithoutBrackets(url.hostname)) === 0
        ? { servername: hostnameWithoutBrackets(url.hostname) }
        : {}),
      // Node enables family auto-selection by default. That mode calls a
      // custom lookup with `all: true`, but this callback deliberately returns
      // the one scalar address that passed the public-address policy.
      autoSelectFamily: false,
      lookup(_hostname, _options, callback) {
        callback(null, address.address, address.family);
      },
    };
    const request = httpsRequest(requestOptions, (response) => {
      const declaredLength = response.headers["content-length"];
      if (typeof declaredLength === "string"
        && /^\d+$/u.test(declaredLength)
        && Number(declaredLength) > WEB_FETCH_MAX_RESPONSE_BYTES) {
        response.destroy();
        finish(() => reject(webFetchError(
          `response exceeds ${String(WEB_FETCH_MAX_RESPONSE_BYTES)} bytes.`,
        )));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > WEB_FETCH_MAX_RESPONSE_BYTES) {
          response.destroy();
          finish(() => reject(webFetchError(
            `response exceeds ${String(WEB_FETCH_MAX_RESPONSE_BYTES)} bytes.`,
          )));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once("error", (error) => {
        finish(() => reject(error));
      });
      response.once("end", () => {
        finish(() => resolve({
          url: url.href,
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? "",
          headers: responseHeaders(response.rawHeaders),
          body: new Uint8Array(Buffer.concat(chunks)),
        }));
      });
    });
    request.once("error", (error) => {
      finish(() => reject(error));
    });
    request.end();
  });
}

function isSupportedContentType(value: string | null): boolean {
  if (value === null) return true;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType.startsWith("text/")
    || mediaType === "application/json"
    || mediaType.endsWith("+json")
    || mediaType === "application/xml"
    || mediaType.endsWith("+xml")
    || mediaType === "application/xhtml+xml"
    || mediaType === "application/javascript"
    || mediaType === "application/x-javascript";
}

function boundedUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  const notice = `\n\n[WebFetch output truncated to ${String(maxBytes)} UTF-8 bytes.]`;
  const noticeBytes = Buffer.byteLength(notice, "utf8");
  const includeNotice = noticeBytes <= maxBytes;
  const contentLimit = includeNotice ? maxBytes - noticeBytes : maxBytes;
  let end = contentLimit;
  while (end > 0 && ((encoded[end] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return `${encoded.subarray(0, end).toString("utf8")}${includeNotice ? notice : ""}`;
}

function crossOriginHeaders(): Headers {
  return new Headers({
    accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1",
    "accept-encoding": "identity",
    "user-agent": "mono-agent-runtime-pi/0.15",
  });
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => reject(signal.reason ?? new Error("WebFetch aborted.")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function checkedRetryDelays(value: readonly number[] | undefined): readonly number[] {
  const delays = value ?? WEB_FETCH_RETRY_DELAYS_MS;
  if (delays.length > 5 || delays.some(
    (delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > 30_000,
  )) {
    throw webFetchError("retryDelaysMs must contain at most five bounded integers.");
  }
  return [...delays];
}

function ownDataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function isRetryableWebFetchError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    if (current instanceof WebFetchHttpError) {
      return current.status >= 500 && current.status <= 599;
    }
    if (current instanceof Error
      && (current.name === "AbortError" || current.name === "TimeoutError")) {
      return true;
    }
    const code = ownDataProperty(current, "code");
    if (typeof code === "string" && [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
    ].includes(code)) {
      return true;
    }
    current = ownDataProperty(current, "cause");
  }
  return false;
}

async function delayWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (delayMs === 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("WebFetch aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchPublicWebAttempt(
  initialUrl: URL,
  initialHeaders: Headers,
  outputBytes: number,
  signal: AbortSignal,
  resolver: (hostname: string) => Promise<readonly WebFetchAddress[]>,
  request: (
    url: URL,
    address: WebFetchAddress,
    headers: Headers,
    signal: AbortSignal,
  ) => Promise<WebFetchResponse>,
): Promise<string> {
  let url = new URL(initialUrl);
  let headers = new Headers(initialHeaders);
  for (let redirects = 0; ; redirects += 1) {
    signal.throwIfAborted();
    let addresses: readonly WebFetchAddress[];
    try {
      addresses = await withAbort(
        resolver(hostnameWithoutBrackets(url.hostname)),
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      throw webFetchError(`DNS resolution failed for ${JSON.stringify(url.hostname)}.`, error);
    }
    const address = assertPublicAddresses(url.hostname, addresses);
    let response: WebFetchResponse;
    try {
      response = await withAbort(request(url, address, headers, signal), signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof Error && error.message.startsWith("WebFetch failed:")) throw error;
      throw webFetchError("HTTPS request failed.", error);
    }
    if (response.body.byteLength > WEB_FETCH_MAX_RESPONSE_BYTES) {
      throw webFetchError(
        `response exceeds ${String(WEB_FETCH_MAX_RESPONSE_BYTES)} bytes.`,
      );
    }
    if (REDIRECT_STATUS.has(response.status)) {
      if (redirects >= WEB_FETCH_MAX_REDIRECTS) {
        throw webFetchError("redirect limit exceeded.");
      }
      const location = response.headers.get("location");
      if (location === null) throw webFetchError("redirect response has no Location header.");
      let next: URL;
      try {
        next = parseUrl(new URL(location, url).href);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("WebFetch failed:")) throw error;
        throw webFetchError("redirect Location is invalid.", error);
      }
      if (next.origin !== url.origin) headers = crossOriginHeaders();
      url = next;
      continue;
    }
    if (response.status < 200 || response.status > 299) {
      throw new WebFetchHttpError(response.status, response.statusText);
    }
    if (!isSupportedContentType(response.headers.get("content-type"))) {
      throw webFetchError(
        `endpoint returned unsupported content type ${
          JSON.stringify(response.headers.get("content-type") ?? "<missing>")
        }.`,
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
    } catch (error) {
      throw webFetchError("endpoint returned malformed UTF-8.", error);
    }
    return boundedUtf8(text, outputBytes);
  }
}

/**
 * Fetch one public HTTPS resource. DNS is resolved and checked before every
 * hop and retry, then the accepted address is pinned into the TLS connection.
 */
export async function fetchPublicWeb(
  input: WebFetchInput,
  options: WebFetchOptions = {},
): Promise<string> {
  const url = parseUrl(input.url);
  const headers = checkedHeaders(input.headers);
  if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1) {
    throw webFetchError("maxOutputBytes must be a positive safe integer.");
  }
  const outputBytes = Math.min(
    WEB_FETCH_MAX_OUTPUT_BYTES,
    Math.max(1, input.maxOutputBytes),
  );
  const timeoutMs = options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw webFetchError("timeoutMs must be a positive bounded integer.");
  }
  const resolver = options.resolve ?? resolveHostname;
  const request = options.request ?? requestPinnedHttps;
  const retryDelays = checkedRetryDelays(options.retryDelaysMs);
  const overallTimeoutMs = Math.min(
    3_600_000,
    (timeoutMs * (retryDelays.length + 1))
      + retryDelays.reduce((total, delay) => total + delay, 0),
  );
  const overallTimeoutSignal = AbortSignal.timeout(overallTimeoutMs);
  const overallSignal = options.signal === undefined
    ? overallTimeoutSignal
    : AbortSignal.any([options.signal, overallTimeoutSignal]);
  for (let attempt = 0; ; attempt += 1) {
    const attemptSignal = AbortSignal.any([
      overallSignal,
      AbortSignal.timeout(timeoutMs),
    ]);
    try {
      return await fetchPublicWebAttempt(
        url,
        headers,
        outputBytes,
        attemptSignal,
        resolver,
        request,
      );
    } catch (error) {
      if (overallSignal.aborted) throw overallSignal.reason ?? error;
      const retryDelay = retryDelays[attempt];
      if (retryDelay === undefined || !isRetryableWebFetchError(error)) throw error;
      await delayWithAbort(retryDelay, overallSignal);
    }
  }
}
