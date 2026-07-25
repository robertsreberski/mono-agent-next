// SPDX-License-Identifier: MIT
import { Buffer } from "node:buffer";

import { checkedFetch } from "@mono-agent/module-sdk";

export const WEB_SEARCH_MAX_QUERY_BYTES = 1_024;
export const WEB_SEARCH_MAX_RESULTS = 10;
export const WEB_SEARCH_MAX_RESPONSE_BYTES = 512 * 1024;
export const WEB_SEARCH_MAX_OUTPUT_BYTES = 32 * 1024;
export const WEB_SEARCH_TIMEOUT_MS = 15_000;
export const WEB_SEARCH_MAX_REDIRECTS = 3;

const DEFAULT_SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const RESULT_LINK = /<a\b(?=[^>]*\bclass=(["'])[^"']*\bresult__a\b[^"']*\1)[^>]*\bhref=(["'])(.*?)\2[^>]*>([\s\S]*?)<\/a>/giu;
const RESULT_SNIPPET = /<(?:a|div)\b(?=[^>]*\bclass=(["'])[^"']*\bresult__snippet\b[^"']*\1)[^>]*>([\s\S]*?)<\/(?:a|div)>/iu;
const NO_RESULTS = /\bclass=(["'])[^"']*\b(?:no-results|result--no-result)\b[^"']*\1/iu;

export interface WebSearchInput {
  readonly query: string;
  readonly limit: number;
}

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface WebSearchOptions {
  readonly signal?: AbortSignal;
  /** Test seam; production callers use the fixed HTTPS DuckDuckGo endpoint. */
  readonly endpoint?: string;
}

function searchError(message: string, cause?: unknown): Error {
  return cause === undefined
    ? new Error(`WebSearch failed: ${message}`)
    : new Error(`WebSearch failed: ${message}`, { cause });
}

export function validateWebSearchInput(input: WebSearchInput): void {
  if (typeof input.query !== "string" || input.query.trim().length === 0) {
    throw searchError("query must be a non-empty string.");
  }
  if (Buffer.byteLength(input.query, "utf8") > WEB_SEARCH_MAX_QUERY_BYTES) {
    throw searchError(`query exceeds ${String(WEB_SEARCH_MAX_QUERY_BYTES)} UTF-8 bytes.`);
  }
  if (!Number.isSafeInteger(input.limit)
    || input.limit < 1
    || input.limit > WEB_SEARCH_MAX_RESULTS) {
    throw searchError(`limit must be an integer from 1 through ${String(WEB_SEARCH_MAX_RESULTS)}.`);
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/gu, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&#x([\da-f]+);/giu, (_match, hexadecimal: string) =>
      String.fromCodePoint(Number.parseInt(hexadecimal, 16)))
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&amp;/giu, "&")
    .replace(/&nbsp;/giu, " ");
}

function plainText(value: string): string {
  return decodeHtml(
    value
      .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/giu, " ")
      .replace(/<[^>]+>/gu, " "),
  )
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .trim();
}

function boundedUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0
    && (((encoded[end] ?? 0) & 0b1100_0000) === 0b1000_0000)) {
    end -= 1;
  }
  return encoded.subarray(0, end).toString("utf8");
}

function resultUrl(rawHref: string, responseUrl: string): string | undefined {
  const href = decodeHtml(rawHref).trim();
  let parsed: URL;
  try {
    parsed = new URL(href.startsWith("//") ? `https:${href}` : href, responseUrl);
  } catch {
    return undefined;
  }
  const redirected = parsed.hostname.endsWith("duckduckgo.com")
    ? parsed.searchParams.get("uddg")
    : null;
  if (redirected !== null) {
    try {
      parsed = new URL(redirected);
    } catch {
      return undefined;
    }
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  return boundedUtf8(parsed.href, 4_096);
}

function parseResults(
  html: string,
  responseUrl: string,
  limit: number,
): WebSearchResult[] {
  const matches = [...html.matchAll(RESULT_LINK)];
  const results: WebSearchResult[] = [];
  for (const [index, match] of matches.entries()) {
    if (results.length >= limit) break;
    const href = match[3];
    const titleMarkup = match[4];
    if (href === undefined || titleMarkup === undefined || match.index === undefined) continue;
    const next = matches[index + 1];
    const segmentEnd = next?.index ?? html.length;
    const segment = html.slice(match.index + match[0].length, segmentEnd);
    const snippetMarkup = RESULT_SNIPPET.exec(segment)?.[2] ?? "";
    const title = boundedUtf8(plainText(titleMarkup), 1_024);
    const snippet = boundedUtf8(plainText(snippetMarkup), 4_096);
    const url = resultUrl(href, responseUrl);
    if (title === "" || url === undefined) continue;
    results.push({ title, url, snippet });
  }
  return results;
}

function formatResult(result: WebSearchResult): string {
  return result.snippet === ""
    ? `${result.title}\n${result.url}`
    : `${result.title}\n${result.url}\n${result.snippet}`;
}

export function formatWebSearchResults(results: readonly WebSearchResult[]): string {
  const formatted = results.length === 0
    ? "No results."
    : results.map(formatResult).join("\n\n");
  if (Buffer.byteLength(formatted, "utf8") > WEB_SEARCH_MAX_OUTPUT_BYTES) {
    throw searchError(`parsed output exceeds ${String(WEB_SEARCH_MAX_OUTPUT_BYTES)} bytes.`);
  }
  return formatted;
}

/** Run one bounded, redirect-checked HTML search and reject ambiguous responses. */
export async function searchWeb(
  input: WebSearchInput,
  options: WebSearchOptions = {},
): Promise<WebSearchResult[]> {
  validateWebSearchInput(input);
  const endpoint = new URL(options.endpoint ?? DEFAULT_SEARCH_ENDPOINT);
  endpoint.searchParams.set("q", input.query);
  let response;
  try {
    response = await checkedFetch(
      endpoint,
      {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "mono-agent-runtime-pi/0.15",
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      {
        maxResponseBytes: WEB_SEARCH_MAX_RESPONSE_BYTES,
        timeoutMs: WEB_SEARCH_TIMEOUT_MS,
        maxRedirects: WEB_SEARCH_MAX_REDIRECTS,
      },
    );
  } catch (error) {
    throw searchError(
      error instanceof Error ? error.message : "network request failed.",
      error,
    );
  }
  if (response.status < 200 || response.status > 299) {
    throw searchError(
      `search endpoint returned HTTP ${String(response.status)} ${response.statusText}`.trim(),
    );
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    throw searchError(
      `search endpoint returned unsupported content type ${JSON.stringify(contentType ?? "<missing>")}.`,
    );
  }
  let html: string;
  try {
    html = response.text();
  } catch (error) {
    throw searchError("search endpoint returned malformed UTF-8.", error);
  }
  const results = parseResults(html, response.url, input.limit);
  if (results.length > 0) {
    formatWebSearchResults(results);
    return results;
  }
  if (NO_RESULTS.test(html)) return [];
  throw searchError("search endpoint returned an unrecognized response.");
}
