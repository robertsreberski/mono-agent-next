import { DEFAULT_MAX_TOOL_OUTPUT_CHARS } from "./shared/constants.js";
import { capChars } from "./shared/output-truncation.js";
import { passthroughSandbox } from "../sandbox-seam.js";
import { readToolRuntime } from "./shared/runtime-context.js";
import { resolveSandboxPolicy } from "./shared/tool-context.js";

const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
// Backoff delays between retry attempts (length = number of retries). Retrying
// transient failures in-tool stops the model from burning whole reasoning rounds
// re-issuing the fetch (or falling back to Bash curl) on a momentary network blip.
const DEFAULT_FETCH_RETRY_DELAYS_MS = [1000, 2000];

function isTransientFetchError(err) {
  if (err === undefined || err === null) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true; // timeout
  const code = err.code ?? err.cause?.code;
  return code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "EAI_AGAIN";
}

function fetchRetryDelay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * @param {{url: string, headers?: Record<string, string>, max_output_chars?: number}} params
 * @param {{sandboxPolicy?: any, ctx?: any, retryDelaysMs?: number[]}} [options]
 */
export async function webFetchToolImpl(
  { url, headers = {}, max_output_chars },
  { sandboxPolicy, ctx, retryDelaysMs = DEFAULT_FETCH_RETRY_DELAYS_MS } = {},
) {
  const maxChars = Number(max_output_chars) || DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  let parsed;
  try { parsed = new URL(url); } catch { return "Error: Invalid URL"; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Error: WebFetch only supports http(s) URLs.";
  }
  const resolvedCtx = ctx ?? readToolRuntime();
  const sandbox = resolvedCtx.sandbox ?? passthroughSandbox;
  const policy = resolveSandboxPolicy(resolvedCtx, sandboxPolicy);
  if (!sandbox.networkAllowsUrl(policy, parsed.href)) return "Error: Network access denied by sandbox policy.";
  const requestHeaders = { "User-Agent": "AgentRuntime/0.1", ...headers };
  // `policy.network` can be absent (a hand-built, non-real-mode policy — the
  // networkAllowsUrl gate above already denied any real-mode policy missing
  // it); treat that as unrestricted rather than dereferencing `.mode` on
  // undefined.
  const restricted = policy !== undefined && policy.network !== undefined && policy.network.mode !== "all";
  const maxRetries = Array.isArray(retryDelaysMs) ? retryDelaysMs.length : 0;

  let lastErrorMessage = "request failed";
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const resp = restricted
        ? await fetchCheckingRedirects(parsed, requestHeaders, policy, sandbox)
        : await fetch(url, { headers: requestHeaders, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (typeof resp === "string") return resp; // policy/redirect error — not retryable
      // Transient server errors (5xx) are worth one more attempt.
      if (resp.status >= 500 && resp.status < 600 && attempt < maxRetries) {
        try { await resp.body?.cancel(); } catch { /* best-effort */ }
        lastErrorMessage = `HTTP ${resp.status}`;
        await fetchRetryDelay(retryDelaysMs[attempt]);
        continue;
      }
      const text = await resp.text();
      if (!resp.ok) return `HTTP ${resp.status}: ${text.slice(0, 500)}`;
      return capChars(text, { label: "WebFetch", maxChars, ctx });
    } catch (err) {
      lastErrorMessage = err.message;
      if (isTransientFetchError(err) && attempt < maxRetries) {
        await fetchRetryDelay(retryDelaysMs[attempt]);
        continue;
      }
      return `Error fetching URL: ${err.message}`;
    }
  }
  return `Error fetching URL: ${lastErrorMessage}`;
}

// fetch() follows redirects transparently, which would let an allowed host
// bounce the request to a denied one — follow them manually and re-check the
// policy on every hop. Custom headers only travel to the original origin.
async function fetchCheckingRedirects(initialUrl, headers, policy, sandbox) {
  let current = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const sameOrigin = current.origin === initialUrl.origin;
    const resp = await fetch(current, {
      headers: sameOrigin ? headers : { "User-Agent": headers["User-Agent"] },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const location = resp.headers.get("location");
    if (resp.status < 300 || resp.status >= 400 || !location) return resp;
    let next;
    try { next = new URL(location, current); } catch { return "Error: Invalid redirect URL."; }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      return "Error: WebFetch only supports http(s) URLs.";
    }
    if (!sandbox.networkAllowsUrl(policy, next.href)) {
      return "Error: Network access denied by sandbox policy (redirect).";
    }
    try { await resp.body?.cancel(); } catch { /* best-effort */ }
    current = next;
  }
  return "Error: Too many redirects.";
}
