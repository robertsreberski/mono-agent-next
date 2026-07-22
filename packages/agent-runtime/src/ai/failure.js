// @ts-check

/**
 * @typedef {Object} RetryableProviderFailureInfo
 * @property {boolean} retryable
 * @property {string|null} subkind
 * @property {string|null} requestId
 */

/**
 * @typedef {"spawn" | "timeout" | "stall" | "context_limit" | "usage_limit" | "invalid_result"
 *   | "invalid_delegation" | "tool_failure" | "provider_unavailable"
 *   | "provider_unavailable_exhausted" | "provider_auth"
 *   | "skipped_capability_mismatch" | "cancelled" | "cancelled_user"
 *   | "cancelled_shutdown" | "cancelled_signal" | "abandoned"
 *   | "session_not_found" | "session_busy" | (string & {})} FailureKind
 * OPEN string union. The literals above are the CORE taxonomy the kernel itself
 * derives from provider/runtime signals in `classifyFailure` /
 * `retryableProviderFailureInfo` (and `provider_unavailable_exhausted`, produced
 * by the router on chain exhaustion). The union is intentionally open
 * (`string & {}`) because `FAILURE_KINDS` also transports HOST-TAXONOMY kinds
 * the kernel never originates on its own:
 *   - `child_failed`, `budget_exceeded` — `classifyFailure` only returns these
 *     when the HOST passes the matching `childFailed` / `budgetExceeded` (or a
 *     `cancelInitiator: "budget"`) input; the kernel never infers them from a
 *     provider signal.
 *   - `delegation_agent_not_in_team`, `delegation_team_roster_empty`,
 *     `invalid_delegation`, `cancelled_stale` (`stale_reconcile`) — set by a
 *     host coordinator (planner/roster/reconcile logic) and merely carried
 *     through `FAILURE_KINDS` / the `hint` passthrough; the kernel transports
 *     them in the result contract but never emits them from its own paths.
 * Hosts (e.g. worklab's coordinator) validate against `FAILURE_KINDS` and may
 * define additional kinds — accepting them at the type level is deliberate.
 */

// FAILURE_KINDS is the runtime vocabulary: `classifyFailure`'s `hint`
// passthrough accepts any member, and hosts validate `task_runs.failure_kind`
// against it. See the `FailureKind` typedef above for which members the kernel
// derives itself vs. which are host-taxonomy kinds it only transports.
export const FAILURE_KINDS = [
  "spawn",
  "timeout",
  "stall",
  "context_limit",
  "usage_limit",
  "invalid_result",
  "invalid_delegation",
  "tool_failure",
  "provider_unavailable",
  "provider_unavailable_exhausted",
  "provider_auth",
  "skipped_capability_mismatch",
  "child_failed",
  "budget_exceeded",
  "cancelled",
  "cancelled_user",
  "cancelled_stale",
  "cancelled_shutdown",
  "cancelled_signal",
  "abandoned",
  // v33: planner delegated to an agent outside the effective team's roster
  // (lead + members). Replaces the retired delegation_agent_not_allowed kind.
  "delegation_agent_not_in_team",
  "delegation_team_roster_empty",
  // Provider session resume: the host asked to resume a provider session that
  // is no longer live (expired, evicted, or process died) or that is still
  // executing another turn. Both are non-retryable at the router level; the
  // host retries once without the session (replaying history) instead.
  "session_not_found",
  "session_busy",
];

const CONTEXT_LIMIT_RE = /(?:context[_ ](?:length|window|budget)|token[_ ]limit|(?:input|prompt)(?:[_ ]tokens?)?[_ ](?:is[_ ])?too[_ ]long|(?:input|prompt|request)(?:[_ ]tokens?)?[_ ]exceeds?[_ ](?:the[_ ])?(?:context|maximum|max|limit|allowed[_ ]size)|too[_ ]many[_ ](?:input[_ ])?tokens?|tokens?[_ ]exceed(?:s|ed)?[_ ](?:the[_ ])?(?:context|maximum|max|(?:model[_ ])?limit))/i;
const USAGE_LIMIT_RE = /(rate limit|usage limit|max(?:imum)?(?:[_ ]output)?[_ ]tokens?|max turns)/i;
const PROVIDER_AUTH_RE = /(no api key|missing api key|api key required|invalid api key|incorrect api key|authentication|authorization|not authorized|forbidden|oauth (?:refresh|auth|authentication|token).*failed|credential store (?:read|modify) failed|401|403)/i;
// Mirrors the conservative connection-error/refused/failed alternation added to
// RETRYABLE_PROVIDER_RE / retryableProviderSubkind below for pi 0.80's terse
// "Connection error." — without it, classifyFailure (used directly by hosts
// like worklab's coordinator, independent of retryableProviderFailureInfo) maps
// that same terse text to the generic "spawn" kind instead of
// "provider_unavailable".
const PROVIDER_UNAVAILABLE_RE = /(econn|enotfound|etimedout|timed? ?out|service unavailable|503|502|gateway|fetch failed|network|websocket|\bconnection (?:error|refused|failed)\b|\bcould not connect\b)/i;
const TOOL_FAILURE_RE = /(tool .* failed|mcp tool|permission denied|EACCES|read-only file system)/i;
const NON_RETRYABLE_PROVIDER_RE = /(invalid[_ ]request|unknown parameter|no api key|missing api key|api key required|invalid api key|incorrect api key|authentication|authorization|not authorized|forbidden|billing|insufficient[_ ]quota|quota exceeded|model[_ ]not[_ ]found|unsupported model|permission denied|bad request|401|403|404)/i;
// pi 0.80's openai-client-style bridge collapses a connection-refused/unreachable
// provider down to a terse "Connection error." with no cause text (no ECONNREFUSED,
// no fetch failed) — the `\bconnection (?:error|refused|failed)\b|\bcould not connect\b`
// alternation below is the motivating fix so that case still fails over instead of
// being classified as non-retryable.
const RETRYABLE_PROVIDER_RE = /(currently overloaded|server(?:s)? (?:is |are )?overloaded|try again later|retry your request|request id|service unavailable|temporar(?:y|ily)|timed? ?out|stream disconnected|fetch failed|econnreset|econnrefused|eai_again|enotfound|etimedout|network|429|too many requests|500|502|503|504|gateway|internal server error|\bconnection (?:error|refused|failed)\b|\bcould not connect\b)/i;
export const PROVIDER_ABORT_RE = /\b(?:terminated|aborted before final output|aborted before final|stream aborted|stream was aborted|stream disconnected|websocket (?:error|disconnected|closed)|socket hang up|und_err_socket|econnreset|premature close)\b/i;

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isProviderAuthFailureText(text = "") {
  return PROVIDER_AUTH_RE.test(text || "");
}

/**
 * Identify request-input/context-window overflows without conflating provider
 * throttling or output-token ceilings. Context overflows are route-local: a
 * fallback model may have a larger usable window, while rate/quota/max-turn
 * failures retain the terminal `usage_limit` classification.
 * @param {string} text
 * @returns {boolean}
 */
export function isContextLimitFailureText(text = "") {
  const value = String(text || "");
  if (/rate limit|too many requests/i.test(value)) return false;
  if (/output[_ ]tokens?|output[_ ]token[_ ]limit/i.test(value)) return false;
  return CONTEXT_LIMIT_RE.test(value);
}

function requestIdFromText(text) {
  const match = /\b(?:request[_ -]?id|req[_ -]?id)\s*[:#]?\s*([A-Za-z0-9._:-]{8,})/i.exec(text || "");
  return match?.[1]?.replace(/[.,;:]+$/, "") || null;
}

function retryableProviderSubkind(text) {
  if (/overloaded/i.test(text)) return "overloaded";
  if (/429|too many requests|rate limit/i.test(text)) return "rate_limited";
  if (/timed? ?out|etimedout/i.test(text)) return "timeout";
  // pi 0.80's terse "Connection error." (no ECONNREFUSED/fetch-failed detail) still
  // needs to land in the "network" subkind so a down provider fails over.
  if (/stream disconnected|fetch failed|econnreset|econnrefused|eai_again|enotfound|network|\bconnection (?:error|refused|failed)\b|\bcould not connect\b/i.test(text)) return "network";
  if (/500|502|503|504|service unavailable|gateway|internal server error/i.test(text)) return "server_error";
  if (/retry your request|try again later|request id|processing your request/i.test(text)) return "retryable_request";
  return null;
}

/**
 * @param {Object} [options]
 * @param {string} [options.errorText]
 * @param {string} [options.stderrTail]
 * @param {string|null} [options.failureKind]
 * @returns {RetryableProviderFailureInfo}
 */
export function retryableProviderFailureInfo({
  errorText = "",
  stderrTail = "",
  failureKind = null,
} = {}) {
  const haystack = `${errorText || ""}\n${stderrTail || ""}`.trim();
  if (failureKind === "context_limit") {
    return {
      retryable: true,
      subkind: "context_limit",
      requestId: requestIdFromText(haystack),
    };
  }
  if (failureKind && failureKind !== "provider_unavailable") {
    return { retryable: false, subkind: null, requestId: null };
  }
  if (!haystack) return { retryable: false, subkind: null, requestId: null };
  const requestId = requestIdFromText(haystack);
  if (NON_RETRYABLE_PROVIDER_RE.test(haystack)) {
    return { retryable: false, subkind: "non_retryable", requestId };
  }
  const subkind = (failureKind === "provider_unavailable" && PROVIDER_ABORT_RE.test(haystack))
    ? "terminated"
    : retryableProviderSubkind(haystack);
  return {
    retryable: !!subkind || RETRYABLE_PROVIDER_RE.test(haystack),
    subkind: subkind || (RETRYABLE_PROVIDER_RE.test(haystack) ? "retryable_request" : null),
    requestId,
  };
}

// classifyFailure is the single source of truth for mapping the disparate
// inputs the coordinator sees on a worker exit (process code, signal, error
// text, stderr tail, timeout flag, cancellation flag, mcp init result, parse
// errors) into one of FAILURE_KINDS. Every adapter / spawn-worker / watcher
// path should funnel through this so the values in `task_runs.failure_kind`
// stay coherent.
/**
 * @param {Object} [options]
 * @param {number|null} [options.exitCode]
 * @param {string|null} [options.signal]
 * @param {string} [options.errorText]
 * @param {string} [options.stderrTail]
 * @param {boolean} [options.timedOut]
 * @param {boolean} [options.cancelRequested]
 * @param {string|null} [options.cancelInitiator]
 * @param {boolean} [options.resultParseError]
 * @param {boolean} [options.mcpInitFailed]
 * @param {boolean} [options.budgetExceeded]
 * @param {boolean} [options.childFailed]
 * @param {string|null} [options.hint]
 * @returns {FailureKind|null} One of FAILURE_KINDS, or null for a clean exit.
 */
export function classifyFailure({
  exitCode = null,
  signal = null,
  errorText = "",
  stderrTail = "",
  timedOut = false,
  cancelRequested = false,
  cancelInitiator = null,
  resultParseError = false,
  mcpInitFailed = false,
  budgetExceeded = false,
  childFailed = false,
  hint = null,
} = {}) {
  if (budgetExceeded) return "budget_exceeded";
  if (childFailed) return "child_failed";
  if (resultParseError) return "invalid_result";
  if (timedOut) return "timeout";
  if (cancelRequested) {
    // R5: distinguish a clean coordinator shutdown from a stale-run reconcile.
    // Both the audit and the operator care which one: a coordinator_shutdown
    // means "we asked you to stop", and the work is reconciliation-eligible
    // on the next boot. A stale_reconcile means the run was already orphaned
    // (no live coordinator to ask). Mapping both to cancelled_stale hid the
    // difference and confused the audit-period reports.
    if (cancelInitiator === "coordinator_shutdown") return "cancelled_shutdown";
    if (cancelInitiator === "stale_reconcile") return "cancelled_stale";
    if (cancelInitiator === "worker_signal") return "cancelled_signal";
    if (cancelInitiator === "user" || cancelInitiator === "api_cancel") return "cancelled_user";
    // An in-flight run cancelled by the settings-backed turn guardrail reuses
    // budget_exceeded so dashboards / reports don't have to learn a new label.
    if (cancelInitiator === "budget") return "budget_exceeded";
    return "cancelled";
  }
  if (exitCode === 130 || signal === "SIGTERM" || signal === "SIGINT") return "cancelled_signal";
  if (signal === "SIGKILL" && !exitCode) return "abandoned";

  if (hint && FAILURE_KINDS.includes(hint)) return hint;

  const haystack = `${errorText || ""}\n${stderrTail || ""}`;
  if (isContextLimitFailureText(haystack)) return "context_limit";
  if (USAGE_LIMIT_RE.test(haystack)) return "usage_limit";
  if (TOOL_FAILURE_RE.test(haystack)) return "tool_failure";
  if (PROVIDER_AUTH_RE.test(haystack)) return "provider_auth";
  if (PROVIDER_UNAVAILABLE_RE.test(haystack)) return "provider_unavailable";
  if (mcpInitFailed && haystack.toLowerCase().includes("mcp")) return "tool_failure";

  if (exitCode === 0 && !errorText) return null;
  return "spawn";
}

// Bounded ring buffer for stderr tails. CLI providers can produce 100s of MB
// of stderr; we only want the last few KB for diagnostics. Returns a string
// guaranteed to be ≤ `limit` bytes, with a `[truncated …]` marker if anything
// was dropped.
/**
 * @param {Object} [options]
 * @param {number} [options.limit]
 * @returns {{push: (chunk: (string|Buffer|null|undefined)) => void, toString: () => string, readonly bytesDropped: number}}
 */
export function createStderrTail({ limit = 8 * 1024 } = {}) {
  let buffer = "";
  let dropped = 0;
  return {
    push(chunk) {
      const text = typeof chunk === "string" ? chunk : chunk?.toString?.() || "";
      if (!text) return;
      if (text.length >= limit) {
        dropped += buffer.length + (text.length - limit);
        buffer = text.slice(text.length - limit);
        return;
      }
      const combined = buffer + text;
      if (combined.length <= limit) {
        buffer = combined;
        return;
      }
      const overflow = combined.length - limit;
      dropped += Math.min(buffer.length, overflow);
      buffer = combined.slice(overflow);
    },
    toString() {
      if (!dropped) return buffer;
      return `[truncated ${dropped} earlier bytes]\n${buffer}`;
    },
    get bytesDropped() {
      return dropped;
    },
  };
}
