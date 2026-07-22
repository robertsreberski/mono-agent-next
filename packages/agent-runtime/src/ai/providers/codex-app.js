import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { normalizeCodexItemEvent } from "../streaming/codex-events.js";
import { createFileChangePayload } from "../file-change-stats.js";
import { formatLiveInputGuidance } from "../live-input-prompt.js";
import { estimateCost } from "../cost.js";
import { codexModelSupportsFastMode, normalizeFastMode } from "../runtime/fast-mode.js";
import { readRuntimeBrand } from "../../agent/tools/shared/runtime-context.js";
import { buildCapabilitiesUsed } from "../runtime/capabilities-used.js";
import { resolveSandboxPolicy } from "../../agent/tools/shared/tool-context.js";
import { createSessionRegistry } from "../runtime/sessions.js";
import { createSessionLiveness } from "../runtime/session-liveness.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_THREAD_START_ATTEMPTS = 2;
const DEFAULT_THREAD_START_BACKOFF_MS = 5_000;
const MIN_THREAD_START_TIMEOUT_MS = 60_000;
const MAX_THREAD_START_TIMEOUT_MS = 180_000;
const THREAD_START_PROMPT_CHARS_PER_STEP = 50_000;
const THREAD_START_TIMEOUT_STEP_MS = 30_000;
const CODEX_DIAGNOSTIC_BYTES = 8 * 1024;
const CODEX_STDERR_TAIL_BYTES = 8 * 1024;
const CODEX_SHUTDOWN_GRACE_MS = 1_000;
const CODEX_KILL_GRACE_MS = 1_000;

const SENSITIVE_ASSIGNMENT_RE = /((?:api[_-]?key|private[_-]?key|access[_-]?key|authorization|authentication|auth|bearer|cookie|credential|password|signature|sig|secret|token)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,\r\n]+)/giu;
const SENSITIVE_HEADER_RE = /((?:(?:proxy-)?authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]*/giu;
const SENSITIVE_JSON_LINE_RE = /("(?:api[_-]?key|private[_-]?key|access[_-]?key|authorization|authentication|auth|bearer|cookie|credential|password|signature|sig|secret|token)"\s*:\s*)[^\r\n]*/giu;
const SENSITIVE_ESCAPED_JSON_LINE_RE = /(\\"(?:api[_-]?key|private[_-]?key|access[_-]?key|authorization|authentication|auth|bearer|cookie|credential|password|signature|sig|secret|token)\\"\s*:\s*)[^\r\n]*/giu;

function normalizedSensitiveName(name) {
  return String(name || "")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

function isSensitivePayloadField(name) {
  const normalized = normalizedSensitiveName(name);
  return /(?:^|_)(?:token|secret|password|authorization|api_key|apikey|credential|cookie|auth|authentication|bearer|private_key|access_key|signature|sig)$/u.test(normalized);
}

function isSensitiveEnvironmentKey(name) {
  const normalized = normalizedSensitiveName(name);
  return /(?:^|_)(?:token|secret|password|authorization|api_key|apikey|credential|cookie|auth|authentication|bearer|private_key|access_key|signature|sig)(?:_|$)/u.test(normalized);
}

function isSensitiveCliFlag(name) {
  const normalized = normalizedSensitiveName(String(name || "").replace(/^-+/u, ""));
  return isSensitivePayloadField(normalized)
    || /(?:^|_)(?:auth|private_key|access_key|signature|sig)$/u.test(normalized);
}

function boundedTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : fallback;
}

function sensitiveEnvironmentValues(env) {
  return [...new Set(Object.entries(env || {})
    .filter(([key, value]) => isSensitiveEnvironmentKey(key) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value))]
    .sort((left, right) => right.length - left.length);
}

function addOpaqueSensitiveValue(target, value, { splitCredentials = false } = {}) {
  if (typeof value !== "string" || value.length < 8) return;
  target.add(value);
  if (!splitCredentials) return;
  const schemeMatch = value.match(/^\s*(Bearer|Basic|Token)\s+(.+?)\s*$/iu);
  const payload = schemeMatch?.[2];
  if (payload?.length >= 8) target.add(payload);
  if (schemeMatch?.[1]?.toLowerCase() === "basic" && payload && payload.length <= 16 * 1024) {
    try {
      const decoded = Buffer.from(payload, "base64").toString("utf8");
      if (decoded && !decoded.includes("\uFFFD")) {
        addOpaqueSensitiveValue(target, decoded);
        const separator = decoded.indexOf(":");
        if (separator >= 0) {
          addOpaqueSensitiveValue(target, decoded.slice(0, separator));
          addOpaqueSensitiveValue(target, decoded.slice(separator + 1));
        }
      }
    } catch {
      // The raw Basic payload remains protected even if it is malformed.
    }
  }
}

function addOpaqueSensitiveValues(target, values, { splitCredentials = false } = {}) {
  if (!values || typeof values !== "object") return;
  for (const value of Object.values(values)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => addOpaqueSensitiveValue(target, entry, { splitCredentials }));
    } else {
      addOpaqueSensitiveValue(target, value, { splitCredentials });
    }
  }
}

function addEncodedCredentialValue(target, value) {
  addOpaqueSensitiveValue(target, value);
  try {
    const decoded = decodeURIComponent(value);
    addOpaqueSensitiveValue(target, decoded);
    addOpaqueSensitiveValue(target, encodeURIComponent(decoded));
  } catch {
    // Invalid percent escapes are still covered by the original raw value.
  }
}

function addUrlSensitiveValues(target, rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl) return;
  try {
    const parsed = new URL(rawUrl);
    addEncodedCredentialValue(target, parsed.username);
    addEncodedCredentialValue(target, parsed.password);
    for (const value of parsed.searchParams.values()) {
      // Query parameter names are provider-defined. All opaque query values are
      // treated as credentials rather than betting on a finite key allowlist.
      addEncodedCredentialValue(target, value);
    }
    for (const part of parsed.search.slice(1).split("&")) {
      if (part.includes("=")) addEncodedCredentialValue(target, part.slice(part.indexOf("=") + 1));
    }
  } catch {
    // Non-URL templates are passed through unchanged and may still be covered
    // by a surrounding secret-bearing CLI flag or payload-field redaction.
  }
}

function addHeaderArgumentSensitiveValues(target, header) {
  if (typeof header !== "string") return;
  const separator = header.indexOf(":");
  const value = separator >= 0 ? header.slice(separator + 1).trim() : header.trim();
  addOpaqueSensitiveValue(target, value, { splitCredentials: true });
}

function addCliSensitiveValues(target, args) {
  if (!Array.isArray(args)) return;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (typeof argument !== "string") continue;
    addUrlSensitiveValues(target, argument);
    const equals = argument.indexOf("=");
    if (equals > 0) {
      const flag = argument.slice(0, equals);
      const value = argument.slice(equals + 1);
      // `--url=...` and `--endpoint=...` are not themselves secret flags, but
      // their inline RHS can contain URL userinfo or query credentials.
      addUrlSensitiveValues(target, value);
      if (/^(?:-H|--header|--http-header)$/iu.test(flag)) {
        addHeaderArgumentSensitiveValues(target, value);
        continue;
      }
      if (isSensitiveCliFlag(flag)) {
        addOpaqueSensitiveValue(target, value, { splitCredentials: true });
        continue;
      }
    }
    if (isSensitiveCliFlag(argument) && typeof args[index + 1] === "string") {
      addOpaqueSensitiveValue(target, args[index + 1], { splitCredentials: true });
      index += 1;
      continue;
    }
    if (/^(?:-H|--header|--http-header)$/iu.test(argument) && typeof args[index + 1] === "string") {
      addHeaderArgumentSensitiveValues(target, args[index + 1]);
      index += 1;
    }
  }
}

function codexRequestSensitiveValues(options = {}) {
  const values = new Set(sensitiveEnvironmentValues({
    ...process.env,
    ...(options.codexAppServerEnv || {}),
  }));
  for (const server of Object.values(options.mcpServers || {})) {
    if (!server || typeof server !== "object") continue;
    // MCP env/header names are provider-defined and need not contain words such
    // as "token" or "secret". Treat every opaque value on these credential-
    // bearing surfaces as sensitive instead of relying on a key-name heuristic.
    addOpaqueSensitiveValues(values, server.env);
    addOpaqueSensitiveValues(values, server.headers, { splitCredentials: true });
    addUrlSensitiveValues(values, server.url);
    addCliSensitiveValues(values, server.args);
  }
  addCliSensitiveValues(values, options.codexAppServerArgs);
  return [...values].sort((left, right) => right.length - left.length);
}

function leadingSensitiveOverlap(text, sensitiveValue) {
  const maxLength = Math.min(text.length, sensitiveValue.length, CODEX_STDERR_TAIL_BYTES);
  if (maxLength < 8) return 0;
  const pattern = text.slice(0, maxLength);
  const failure = new Array(pattern.length).fill(0);
  for (let index = 1, matched = 0; index < pattern.length; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) matched = failure[matched - 1];
    if (pattern[index] === pattern[matched]) matched += 1;
    failure[index] = matched;
  }
  let matched = 0;
  for (const character of sensitiveValue.slice(-maxLength)) {
    while (matched > 0 && character !== pattern[matched]) matched = failure[matched - 1];
    if (character === pattern[matched]) matched += 1;
  }
  return matched >= 8 ? matched : 0;
}

function redactCodexDiagnostic(text, sensitiveValues, truncatedStart = false) {
  let redacted = String(text || "");
  for (const value of sensitiveValues) {
    if (truncatedStart) {
      const overlap = leadingSensitiveOverlap(redacted, value);
      if (overlap > 0) redacted = `[REDACTED]${redacted.slice(overlap)}`;
    }
    redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted
    .replace(SENSITIVE_HEADER_RE, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|pk|sess|oauth)[-_][A-Za-z0-9._-]{12,}\b/giu, "[REDACTED]")
    .replace(SENSITIVE_ESCAPED_JSON_LINE_RE, '$1\\"[REDACTED]\\"')
    .replace(SENSITIVE_JSON_LINE_RE, '$1"[REDACTED]"')
    .replace(SENSITIVE_ASSIGNMENT_RE, "$1[REDACTED]");
}

function utf8Head(text, limit) {
  if (limit <= 0) return "";
  const bytes = Buffer.from(String(text || ""));
  if (bytes.length <= limit) return bytes.toString("utf8");
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function boundCodexDiagnostic(text, limit = CODEX_DIAGNOSTIC_BYTES) {
  const value = String(text || "");
  const byteLength = Buffer.byteLength(value);
  if (byteLength <= limit) return value;
  let droppedBytes = byteLength - limit;
  let marker = `\n[truncated ${droppedBytes} later bytes]`;
  let bodyLimit = Math.max(0, limit - Buffer.byteLength(marker));
  droppedBytes = byteLength - bodyLimit;
  marker = `\n[truncated ${droppedBytes} later bytes]`;
  bodyLimit = Math.max(0, limit - Buffer.byteLength(marker));
  return utf8Head(value, bodyLimit) + marker;
}

function safeDiagnosticString(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error && typeof value.message === "string") return value.message;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : String(value ?? "");
  } catch {
    try {
      return String(value);
    } catch {
      return "Codex app-server diagnostic unavailable";
    }
  }
}

function sanitizeCodexDiagnostic(value, sensitiveValues, limit = CODEX_DIAGNOSTIC_BYTES) {
  return boundCodexDiagnostic(
    redactCodexDiagnostic(safeDiagnosticString(value), sensitiveValues),
    limit,
  );
}

function sanitizeCodexProtocolCode(value, sensitiveValues) {
  return typeof value === "number"
    ? value
    : sanitizeCodexDiagnostic(value, sensitiveValues, 256);
}

function boundedCodexDiagnosticPayload(value, sensitiveValues, limit) {
  const sanitized = redactCodexPayload(value, sensitiveValues);
  try {
    if (Buffer.byteLength(JSON.stringify(sanitized) || "") <= limit) return sanitized;
  } catch {
    // Fall through to a safe string summary for non-serializable values.
  }
  return sanitizeCodexDiagnostic(value, sensitiveValues, limit);
}

function redactCodexPayload(value, sensitiveValues, seen = new WeakSet(), depth = 0) {
  if (typeof value === "string") return redactCodexDiagnostic(value, sensitiveValues);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    const errorCode = /** @type {any} */ (value).code;
    return {
      name: redactCodexDiagnostic(value.name || "Error", sensitiveValues),
      message: sanitizeCodexDiagnostic(value.message || value, sensitiveValues),
      ...(errorCode !== undefined
        ? { code: sanitizeCodexProtocolCode(errorCode, sensitiveValues) }
        : {}),
    };
  }
  if (depth >= 20) return "[truncated nested Codex payload]";
  if (seen.has(value)) return "[circular Codex payload]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => redactCodexPayload(entry, sensitiveValues, seen, depth + 1));
    seen.delete(value);
    return result;
  }
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = isSensitivePayloadField(key)
      ? "[REDACTED]"
      : redactCodexPayload(entry, sensitiveValues, seen, depth + 1);
  }
  seen.delete(value);
  return result;
}

function sanitizeCodexResponseError(error, sensitiveValues) {
  const sanitized = redactCodexPayload(error, sensitiveValues);
  let serialized;
  try {
    serialized = JSON.stringify(sanitized);
  } catch {
    serialized = "";
  }
  if (Buffer.byteLength(serialized || "") <= CODEX_DIAGNOSTIC_BYTES) return sanitized;

  const data = error && typeof error === "object" ? error.data : null;
  const nestedError = data && typeof data === "object" ? data.error : null;
  const info = data?.info ?? nestedError?.info ?? error?.info;
  return {
    ...(error?.code !== undefined
      ? { code: sanitizeCodexProtocolCode(error.code, sensitiveValues) }
      : {}),
    message: sanitizeCodexDiagnostic(codexErrorMessage(error), sensitiveValues, 6 * 1024),
    ...(info !== undefined
      ? { data: { info: boundedCodexDiagnosticPayload(info, sensitiveValues, 1_024) } }
      : {}),
    diagnostic_truncated: true,
  };
}

const CODEX_DIAGNOSTIC_NOTIFICATION_METHODS = new Set([
  "warning",
  "error",
  "configWarning",
  "guardianWarning",
]);

function sanitizeCodexNotification(notification, sensitiveValues) {
  const safe = redactCodexPayload(notification, sensitiveValues);
  if (!safe || typeof safe !== "object") return safe;
  if (CODEX_DIAGNOSTIC_NOTIFICATION_METHODS.has(safe.method)) {
    const params = safe.params && typeof safe.params === "object" ? safe.params : {};
    return {
      ...safe,
      params: {
        ...(params.code !== undefined
          ? { code: sanitizeCodexProtocolCode(params.code, sensitiveValues) }
          : {}),
        message: sanitizeCodexDiagnostic(params.message || params.error || params, sensitiveValues),
      },
    };
  }
  if (safe.method === "turn/completed" && safe.params?.turn?.error !== undefined) {
    return {
      ...safe,
      params: {
        ...safe.params,
        turn: {
          ...safe.params.turn,
          error: sanitizeCodexResponseError(safe.params.turn.error, sensitiveValues),
        },
      },
    };
  }
  if ((safe.method === "item/started" || safe.method === "item/completed") && safe.params?.item?.error !== undefined) {
    return {
      ...safe,
      params: {
        ...safe.params,
        item: {
          ...safe.params.item,
          error: sanitizeCodexResponseError(safe.params.item.error, sensitiveValues),
        },
      },
    };
  }
  return safe;
}

function utf8Tail(text, limit) {
  if (limit <= 0) return "";
  const bytes = Buffer.from(String(text || ""));
  if (bytes.length <= limit) return bytes.toString("utf8");
  let start = bytes.length - limit;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function createCodexStderrTail(sensitiveValues, limit = CODEX_STDERR_TAIL_BYTES) {
  let buffer = Buffer.alloc(0);
  let bytesDropped = 0;
  return {
    push(chunk) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
      if (incoming.length === 0) return;
      if (incoming.length >= limit) {
        bytesDropped += buffer.length + incoming.length - limit;
        buffer = Buffer.from(incoming.subarray(incoming.length - limit));
        return;
      }
      const overflow = Math.max(0, buffer.length + incoming.length - limit);
      bytesDropped += overflow;
      buffer = Buffer.concat([buffer.subarray(overflow), incoming], Math.min(limit, buffer.length + incoming.length));
    },
    toString() {
      const redacted = redactCodexDiagnostic(
        buffer.toString("utf8").replace(/^\uFFFD/u, ""),
        sensitiveValues,
        bytesDropped > 0,
      ).trim();
      if (bytesDropped === 0) return utf8Tail(redacted, limit);
      const marker = `[truncated ${bytesDropped} earlier bytes]\n`;
      const bodyLimit = Math.max(0, limit - Buffer.byteLength(marker));
      return marker + utf8Tail(redacted, bodyLimit);
    },
  };
}

const CODEX_APP_CAPABILITIES = {
  kind: "codex-app",
  runtime: "app-server",
  streaming: true,
  structured_output: true,
  // codex-app emits the started thread id, surfaced as provider_session_id.
  // With options.sessionKeepAlive the app-server subprocess + thread stay
  // live in codexSessions, so a follow-up run can resume the thread via
  // options.sessionId. The protocol still has no thread/load primitive, so
  // resume only works while the subprocess is alive.
  supports_session_resume: true,
  native_runtime_config: null,
  supports_mcp: true,
  supports_skills: true,
  supports_builtin_tools: true,
  supports_live_input: true,
  supports_native_subagents: true,
  supports_fast_mode: true,
};

function promptFromMessages(messages) {
  return Array.isArray(messages)
    ? messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n\n")
    : String(messages || "");
}

function pushUniqueText(texts, text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return;
  if (texts.some((existing) => existing.trim() === value)) return;
  texts.push(value);
}

function userTextInput(text) {
  return [{ type: "text", text: String(text || ""), text_elements: [] }];
}

function integerOption(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function defaultThreadStartTimeoutMs(systemPrompt) {
  const promptChars = String(systemPrompt || "").length;
  const sizeSteps = Math.max(0, Math.ceil(promptChars / THREAD_START_PROMPT_CHARS_PER_STEP) - 1);
  return clamp(
    MIN_THREAD_START_TIMEOUT_MS + (sizeSteps * THREAD_START_TIMEOUT_STEP_MS),
    MIN_THREAD_START_TIMEOUT_MS,
    MAX_THREAD_START_TIMEOUT_MS,
  );
}

function threadStartPolicy(systemPrompt, options = {}) {
  return {
    timeoutMs: integerOption(
      options.codexThreadStartTimeoutMs,
      defaultThreadStartTimeoutMs(systemPrompt),
      { min: 1, max: Number.MAX_SAFE_INTEGER },
    ),
    attempts: integerOption(
      options.codexThreadStartAttempts,
      DEFAULT_THREAD_START_ATTEMPTS,
      { min: 1, max: 5 },
    ),
    backoffMs: integerOption(
      options.codexThreadStartBackoffMs,
      DEFAULT_THREAD_START_BACKOFF_MS,
      { min: 0, max: 300_000 },
    ),
  };
}

function delay(ms, signal) {
  const timeoutMs = Math.max(0, Number(ms) || 0);
  if (!timeoutMs || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    signal?.addEventListener?.("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function sandboxForRun(options) {
  if (options.codexNoToolsProbe === true) return "read-only";
  if (options.permissionMode === "bypassPermissions") return "danger-full-access";
  if (options.permissionMode === "plan") return "read-only";
  return "workspace-write";
}

function approvalPolicyForRun(options) {
  // mono-agent channel turns are unattended: there is no interactive app-server
  // approval UI on the other end of stdio. `never` lets Codex execute within the
  // selected sandbox and deny escalations itself instead of waiting forever for
  // a client response that cannot arrive.
  return "never";
}

function sandboxPolicyForRun(options) {
  if (options.codexNoToolsProbe === true) return { type: "readOnly", networkAccess: false };
  if (options.permissionMode === "bypassPermissions") return { type: "dangerFullAccess" };
  if (options.permissionMode === "plan") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: [options.cwd || process.cwd()],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function codexToolPolicyProblem(options) {
  const allowedTools = Array.isArray(options.allowedTools) ? options.allowedTools : null;
  const disallowedTools = Array.isArray(options.disallowedTools) ? options.disallowedTools : [];
  if (options.codexNoToolsProbe === true) {
    const mcpServerCount = Object.keys(options.mcpServers || {}).length;
    if (allowedTools?.length === 0 && disallowedTools.length === 0 && mcpServerCount === 0 && options.sessionKeepAlive !== true) {
      return null;
    }
    return "Codex no-tool probe mode requires an empty tool policy, no MCP servers, and a disposable session.";
  }
  // `undefined` retains the public runtime's documented allow-all default.
  // Once a caller specifies a policy, require the exact wildcard contract.
  // Extra entries can conceal a caller's mistaken belief that Codex enforces a
  // mixed allowlist, which the app-server cannot project.
  const effectiveAllowAll = allowedTools === null || (allowedTools.length === 1 && allowedTools[0] === "*");
  return effectiveAllowAll && disallowedTools.length === 0
    ? null
    : "Direct Codex cannot enforce allowedTools/disallowedTools. Use exact allow-all ([\"*\"] with no disallowedTools) or another runtime.";
}

const CODEX_NO_TOOL_ACTION_ITEMS = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
]);

const CODEX_NO_TOOL_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "item/permissions/requestApproval",
  "item/tool/call",
  "mcpServer/elicitation/request",
  "applyPatchApproval",
  "execCommandApproval",
]);

function codexMcpConfig(mcpServers = {}) {
  const servers = {};
  for (const [name, cfg] of Object.entries(mcpServers || {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    if (cfg?.command) {
      servers[name] = {
        command: cfg.command,
        ...(Array.isArray(cfg.args) ? { args: cfg.args } : {}),
        ...(cfg.env && typeof cfg.env === "object" ? { env: cfg.env } : {}),
        ...(cfg.cwd && typeof cfg.cwd === "string" ? { cwd: cfg.cwd } : {}),
        enabled: true,
        required: false,
      };
    } else if (cfg?.url) {
      servers[name] = {
        url: cfg.url,
        ...(cfg.headers && typeof cfg.headers === "object" ? { http_headers: cfg.headers } : {}),
        enabled: true,
        required: false,
      };
    }
  }
  return servers;
}

function codexErrorMessage(error) {
  if (!error) return "Codex app-server error";
  if (typeof error === "string") return error;
  const data = error.data || error.error || {};
  const info = data.info || data.code || error.code;
  if (info && typeof info === "object" && "activeTurnNotSteerable" in info) {
    return "Codex active turn is not steerable";
  }
  return error.message || data.message || safeDiagnosticString(error);
}

function isActiveTurnNotSteerable(error) {
  const info = error?.data?.info || error?.data?.error?.info || error?.info;
  return info === "activeTurnNotSteerable" || Boolean(info?.activeTurnNotSteerable);
}

function isNoActiveTurnToSteer(error) {
  return /no active turn to steer/i.test(codexErrorMessage(error));
}

function isCodexRequestTimeout(error, method = null) {
  return error?.code === "CODEX_APP_SERVER_REQUEST_TIMEOUT"
    && (!method || error.method === method);
}

function codexErrorDiagnostics(error, sensitiveValues = []) {
  if (!error) return {};
  if (isCodexRequestTimeout(error)) {
    return {
      codex_error_code: "codex_app_server_request_timeout",
      codex_request_method: error.method ? sanitizeCodexDiagnostic(error.method, sensitiveValues, 256) : null,
      codex_request_timeout_ms: error.timeoutMs || null,
      ...(error.stderrTail
        ? { stderr_tail: sanitizeCodexDiagnostic(error.stderrTail, sensitiveValues) }
        : {}),
    };
  }
  return error.code
    ? { codex_error_code: sanitizeCodexDiagnostic(error.code, sensitiveValues, 256) }
    : {};
}

function withoutCodexRequestErrorDiagnostics(diagnostics) {
  const {
    codex_error_code: _codexErrorCode,
    codex_request_method: _codexRequestMethod,
    codex_request_timeout_ms: _codexRequestTimeoutMs,
    stderr_tail: _stderrTail,
    ...rest
  } = diagnostics || {};
  return rest;
}

function codexNativeTeammates(nativeSubagents) {
  if (nativeSubagents?.provider !== "codex" || !Array.isArray(nativeSubagents.teammates)) return [];
  return nativeSubagents.teammates.map((agent) => {
    const name = String(agent?.name || "").trim();
    if (!name) return null;
    return {
      name,
      displayName: agent.displayName || name,
      description: agent.description || "",
      model: agent.model?.model || agent.modelRef || null,
      reasoningEffort: agent.effort || null,
      instructions: agent.helperSystemPrompt || agent.instructions || "",
    };
  }).filter(Boolean);
}

function codexCollaborationModePayload(nativeSubagents, { model, effort, systemPrompt }) {
  const teammates = codexNativeTeammates(nativeSubagents);
  if (!teammates.length) return null;
  return {
    mode: "default",
    teammates,
    settings: {
      model,
      reasoningEffort: effort || null,
      developerInstructions: systemPrompt,
    },
  };
}

/**
 * @param {{command?: string, args?: string[], cwd?: any, env?: any, redactionValues?: string[], onNotification?: (msg: any) => void, onServerRequest?: (msg: any) => Promise<any> | any, shutdownGraceMs?: number, killGraceMs?: number}} [options]
 */
export function createCodexAppServerClient({
  command = "codex",
  // project_doc_max_bytes=0 keeps codex from injecting its own project docs;
  // the host supplies the full context through developerInstructions.
  args = ["app-server", "--listen", "stdio://", "-c", "project_doc_max_bytes=0"],
  cwd,
  env = {},
  redactionValues = [],
  onNotification = () => {},
  onServerRequest = (message) => {
    throw new Error(`Unsupported Codex app-server request: ${String(message?.method || "unknown")}`);
  },
  shutdownGraceMs = CODEX_SHUTDOWN_GRACE_MS,
  killGraceMs = CODEX_KILL_GRACE_MS,
} = {}) {
  const childEnv = { ...process.env, ...env };
  const configuredSensitiveValues = new Set();
  for (const value of redactionValues) {
    addOpaqueSensitiveValue(configuredSensitiveValues, value, { splitCredentials: true });
  }
  const sensitiveValues = [...new Set([
    ...sensitiveEnvironmentValues(childEnv),
    ...configuredSensitiveValues,
  ])].sort((left, right) => right.length - left.length);
  const child = spawn(command, args, {
    cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const stderrTail = createCodexStderrTail(sensitiveValues);
  const shutdownTimers = new Set();
  let nextId = 1;
  let closed = false;
  let processSettled = false;
  let closing = false;
  /** @type {Promise<void> | null} */
  let closePromise = null;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });

  function rejectAll(err) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    pending.clear();
  }

  function safeTransportError(error) {
    const message = sanitizeCodexDiagnostic(error?.message || error || "codex app-server failed", sensitiveValues);
    const safe = new Error(message || "codex app-server failed");
    return error?.code === undefined ? safe : Object.assign(safe, { code: error.code });
  }

  function onStderrData(chunk) {
    stderrTail.push(chunk);
  }

  child.stderr.on("data", onStderrData);

  function writeProtocolMessage(payload) {
    if (closed || child.stdin?.destroyed || child.stdin?.writableEnded) return;
    child.stdin.write(`${JSON.stringify(payload)}\n`, () => {});
  }

  function respondToServerRequest(message) {
    // Preserve request visibility for the normal event/fail-fast path, then
    // always settle the JSON-RPC request. Never leave the app-server blocked on
    // an inbound request that this unattended client cannot service.
    const safeMessage = redactCodexPayload(message, sensitiveValues);
    onNotification(safeMessage);
    Promise.resolve()
      .then(() => onServerRequest(safeMessage))
      .then(
        (result) => writeProtocolMessage({ id: message.id, result: result ?? {} }),
        () => writeProtocolMessage({
          id: message.id,
          error: { code: -32601, message: `Unsupported Codex app-server request: ${String(message.method || "unknown")}` },
        }),
      );
  }

  const rl = createInterface({ input: child.stdout });
  function onLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      onNotification({
        method: "warning",
        params: {
          message: sanitizeCodexDiagnostic(
            `Malformed Codex app-server output: ${line}`,
            sensitiveValues,
          ),
        },
      });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "id") && (message.result !== undefined || message.error !== undefined)) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const responseError = sanitizeCodexResponseError(message.error, sensitiveValues);
        entry.reject(Object.assign(
          new Error(sanitizeCodexDiagnostic(codexErrorMessage(responseError), sensitiveValues)),
          { responseError },
        ));
      }
      else entry.resolve(message.result);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
      respondToServerRequest(message);
      return;
    }
    if (message.method) onNotification(sanitizeCodexNotification(message, sensitiveValues));
  }
  rl.on("line", onLine);

  function cleanupTransport() {
    for (const timer of shutdownTimers) clearTimeout(timer);
    shutdownTimers.clear();
    rl.off("line", onLine);
    try { rl.close(); } catch {}
    child.stderr?.off?.("data", onStderrData);
    child.off("error", onChildError);
    child.off("close", onChildClose);
    try { child.stdin?.destroy?.(); } catch {}
    try { child.stdout?.destroy?.(); } catch {}
    try { child.stderr?.destroy?.(); } catch {}
  }

  function settleClosed(error) {
    if (processSettled) return;
    processSettled = true;
    closed = true;
    rejectAll(error);
    cleanupTransport();
    resolveClosed(error);
  }

  function onChildError(error) {
    const safe = safeTransportError(error);
    closed = true;
    rejectAll(safe);
    // A spawn failure has no live process and may not emit `close`. By contrast,
    // ChildProcess also emits `error` when signaling a live child fails (EPERM,
    // ESRCH races). Only `close` proves that such a process actually exited.
    if (child.pid === undefined) {
      settleClosed(safe);
      return;
    }
    if (!closing) void close();
  }

  function onChildClose(code, signal) {
    if (closing) {
      settleClosed(new Error("codex app-server closed"));
      return;
    }
    const summary = signal === null
      ? `codex app-server exited ${code ?? "unknown"}`
      : `codex app-server terminated by ${signal}`;
    const detail = stderrTail.toString();
    settleClosed(new Error(detail ? `${summary}: ${detail}` : summary));
  }

  child.on("error", onChildError);
  child.once("close", onChildClose);

  function request(method, params, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    if (closed || child.stdin?.destroyed || child.stdin?.writableEnded) {
      return Promise.reject(new Error("codex app-server is not running"));
    }
    const id = nextId++;
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`codex app-server request timed out: ${method}`), {
          code: "CODEX_APP_SERVER_REQUEST_TIMEOUT",
          method,
          timeoutMs,
          stderrTail: stderrTail.toString(),
        }));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (!err) return;
        pending.delete(id);
        clearTimeout(timer);
        reject(safeTransportError(err));
      });
    });
  }

  function waitForProcessClose(timeoutMs) {
    if (processSettled) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (didClose) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          shutdownTimers.delete(timer);
        }
        resolve(didClose);
      };
      timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      shutdownTimers.add(timer);
      closedPromise.then(() => finish(true));
    });
  }

  function close() {
    if (closePromise !== null) return closePromise;
    closePromise = (async () => {
      closing = true;
      closed = true;
      rejectAll(new Error("codex app-server closed"));
      if (processSettled) return;

      try { child.stdin?.end?.(); } catch {}
      try { child.kill("SIGTERM"); } catch {}
      if (await waitForProcessClose(boundedTimeout(shutdownGraceMs, CODEX_SHUTDOWN_GRACE_MS))) return;

      try { child.kill("SIGKILL"); } catch {}
      if (await waitForProcessClose(boundedTimeout(killGraceMs, CODEX_KILL_GRACE_MS))) return;

      try { child.unref?.(); } catch {}
      settleClosed(new Error("codex app-server did not exit after SIGKILL"));
    })();
    return closePromise;
  }

  return { request, close, child, closed: closedPromise };
}

function mapThreadItem(method, item) {
  if (!item || typeof item !== "object") return null;
  const type = method.endsWith("started") ? "item.started" : "item.completed";
  if (item.type === "agentMessage") {
    return { type, item: { type: "agent_message", id: item.id, text: item.text || "" } };
  }
  if (item.type === "commandExecution") {
    return {
      type,
      item: {
        type: "command_execution",
        id: item.id,
        command: item.command,
        aggregated_output: item.aggregatedOutput || "",
        exit_code: item.exitCode,
        status: item.status,
      },
    };
  }
  if (item.type === "fileChange") {
    return {
      type,
      item: {
        type: "file_change",
        id: item.id,
        changes: item.changes || [],
        status: item.status,
      },
    };
  }
  if (item.type === "mcpToolCall") {
    return {
      type,
      item: {
        type: "mcp_tool_call",
        id: item.id,
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        result: item.result,
        error: item.error,
        status: item.status,
      },
    };
  }
  if (item.type === "collabAgentToolCall") {
    const name = `codex_${item.tool || "subagent"}`;
    if (method.endsWith("started")) {
      return {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: item.id,
            name,
            input: {
              prompt: item.prompt,
              model: item.model,
              reasoningEffort: item.reasoningEffort,
              receiverThreadIds: item.receiverThreadIds || [],
            },
          }],
        },
      };
    }
    return {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: item.id,
          content: {
            status: item.status,
            receiverThreadIds: item.receiverThreadIds || [],
            agentsStates: item.agentsStates || [],
            ...(item.error ? { error: item.error } : {}),
          },
          is_error: item.status === "failed" || Boolean(item.error),
        }],
      },
    };
  }
  if (item.type === "reasoning") {
    const text = [...(item.summary || []), ...(item.content || [])].join("\n").trim();
    return text ? { type: "assistant", message: { content: [{ type: "thinking", text }] } } : null;
  }
  return null;
}

function usageFromTokenUsage(tokenUsage) {
  const last = tokenUsage?.last || tokenUsage?.total || {};
  return {
    input_tokens: last.inputTokens ?? null,
    output_tokens: last.outputTokens ?? null,
    cache_read_tokens: last.cachedInputTokens ?? null,
  };
}

function contextUsageFromTokenUsage(tokenUsage) {
  const last = tokenUsage?.last;
  const total = Number(last?.totalTokens);
  if (!last || !Number.isFinite(total) || total <= 0) return null;
  const input = Number(last.inputTokens) || 0;
  const cachedInput = Number(last.cachedInputTokens) || 0;
  const output = Number(last.outputTokens) || 0;
  const reasoning = Number(last.reasoningOutputTokens) || 0;
  const contextWindow = Number(tokenUsage?.modelContextWindow) || 0;
  return {
    tokens: {
      input: Math.max(0, input - cachedInput),
      cachedInput,
      output,
      reasoning,
      total,
    },
    ...(contextWindow > 0 ? { contextWindow } : {}),
  };
}

const noopNotificationHandler = () => {};

async function closeCodexClient(client) {
  if (!client?.close) return;
  try {
    await client.close();
  } catch {
    // Teardown is best-effort at result boundaries, but the returned promise is
    // always observed so a custom client cannot create an unhandled rejection.
  }
}

// Live keep-alive sessions keyed by codex thread id.
const codexSessions = createSessionRegistry({
  isBusy: (entry) => entry.busy === true,
  onEvict: async (entry) => {
    await closeCodexClient(entry.client);
  },
});
// Synchronous liveness primitives over the registry. Codex only needs the
// await-free busy claim (its resume handling is simpler than pi's — no durable
// reopen / create-on-miss reservation), so it consumes claim(); its keep-alive
// register + deletes stay direct registry ops.
const codexLiveness = createSessionLiveness(codexSessions);

export async function generateCodexAppResponse(systemPrompt, options = {}) {
  const start = Date.now();
  const resolved = options.model;
  const requestedReference = resolved?.reference || `codex:${resolved?.model || ""}`;
  // Resolve every credential-bearing value before the app-server client is
  // constructed. The same set protects transport errors and provider events,
  // including MCP servers whose custom env/header names are not recognizable
  // through key-name heuristics.
  const sensitiveValues = codexRequestSensitiveValues(options);
  const safeDiagnostic = (value, limit) => sanitizeCodexDiagnostic(value, sensitiveValues, limit);
  const safeResponseError = (error) => sanitizeCodexResponseError(error, sensitiveValues);
  // Test seam: lets tests drive the bridge with a stub app-server client.
  const makeClient = options.codexClientFactory || createCodexAppServerClient;
  const keepAlive = options.sessionKeepAlive === true;
  const noToolsProbe = options.codexNoToolsProbe === true;
  // The bridge TTL is a backstop behind the host's session policy; the grace
  // keeps the host's lazy expiry firing first so eviction stays host-driven.
  const sessionTtlMs = Number.isFinite(Number(options.sessionIdleTimeoutMs))
    ? Number(options.sessionIdleTimeoutMs) + 60_000
    : undefined;
  const resumeSessionId = typeof options.sessionId === "string" && options.sessionId.trim()
    ? options.sessionId
    : null;
  const prompt = promptFromMessages(options.messages);
  // Effort arrives pre-normalized; codex has no "max" reasoning tier, so clamp
  // to its ceiling here instead of failing the app-server turn.
  const requestedEffort = typeof options.effort === "string" && options.effort.trim()
    ? options.effort
    : null;
  const normalizedEffort = requestedEffort === "max" ? "xhigh" : requestedEffort;
  const events = [];
  const texts = [];
  const agentTextByItem = new Map();
  const compactionStatuses = new Map();
  const activeCompactions = new Map();
  const nativeCompactionTurnKeys = new Set();
  const legacyCompactionTurnKeys = new Set();
  let threadId = null;
  let activeTurnId = null;
  let actualModel = resolved?.model || null;
  let turnCompleted = false;
  let errorMessage = null;
  let failureKind = null;
  let usage = {};
  let codexDiagnostics = {};
  let noToolsViolation = null;
  let serverRequestViolation = null;
  let resolveTurn;
  let resolveTurnReady;
  let turnReadyResolved = false;
  const fileChangeSnapshots = new Map();
  const codexItemContext = {
    fileChangePayload: (raw) => createFileChangePayload(raw, {
      cwd: options.cwd || process.cwd(),
      snapshots: fileChangeSnapshots,
    }),
  };
  const turnDone = new Promise((resolve) => { resolveTurn = resolve; });
  const turnReady = new Promise((resolve) => { resolveTurnReady = resolve; });

  function setActiveTurnId(turnId, { steerReady = false } = {}) {
    activeTurnId = turnId || activeTurnId;
    if (steerReady && !turnReadyResolved && threadId && activeTurnId) {
      turnReadyResolved = true;
      resolveTurnReady();
    }
    // An abort that fired before the turn id was known could not interrupt;
    // deliver it as soon as the turn becomes addressable.
    if (abortRequested && !interruptSent && threadId && activeTurnId) {
      interruptSent = true;
      client?.request("turn/interrupt", { threadId, turnId: activeTurnId }).catch(() => {});
    }
  }

  function emitEvent(event) {
    if (!event) return;
    const safeEvent = redactCodexPayload(event, sensitiveValues);
    events.push(safeEvent);
    options.onEvent?.(safeEvent);
  }

  const compactionTurnKey = (params = {}) => `${params.threadId || threadId || "thread"}:${params.turnId || activeTurnId || "turn"}`;

  /**
   * @param {{operationId: string, status: string, turnKey?: string, reason?: string, message?: string}} event
   */
  function emitCompaction({
    operationId,
    status,
    turnKey,
    reason,
    message,
  }) {
    const previous = compactionStatuses.get(operationId);
    if (previous === status || previous === "succeeded" || previous === "failed" || previous === "skipped") return;
    compactionStatuses.set(operationId, status);
    if (status === "running") activeCompactions.set(operationId, { turnKey: turnKey || compactionTurnKey() });
    else activeCompactions.delete(operationId);
    emitEvent({
      type: "context_compaction",
      operationId,
      status,
      sdk: "codex",
      trigger: "automatic",
      timestamp: Date.now(),
      model: actualModel ? `codex:${actualModel}` : requestedReference,
      ...(reason ? { reason } : {}),
      ...(message ? { message } : {}),
    });
  }

  function finalizeOpenCompactions(reason, message) {
    for (const [operationId, active] of [...activeCompactions]) {
      emitCompaction({
        operationId,
        status: "failed",
        turnKey: active.turnKey,
        reason,
        message,
      });
    }
  }

  function handleContextCompactionItem(method, params) {
    const item = params.item;
    const turnKey = compactionTurnKey(params);
    nativeCompactionTurnKeys.add(turnKey);
    if (legacyCompactionTurnKeys.has(turnKey)) return;
    const operationId = `codex:${item.id}`;
    emitCompaction({
      operationId,
      status: method === "item/started" ? "running" : "succeeded",
      turnKey,
    });
  }

  function handleLegacyCompaction(params) {
    const turnKey = compactionTurnKey(params);
    const active = [...activeCompactions].find(([, value]) => value.turnKey === turnKey);
    if (active) {
      emitCompaction({ operationId: active[0], status: "succeeded", turnKey });
      return;
    }
    if (nativeCompactionTurnKeys.has(turnKey) || legacyCompactionTurnKeys.has(turnKey)) return;
    legacyCompactionTurnKeys.add(turnKey);
    emitCompaction({
      operationId: `codex:${turnKey}:legacy`,
      status: "succeeded",
      turnKey,
    });
  }

  function handleAgentText(text) {
    const safeText = redactCodexDiagnostic(text, sensitiveValues);
    pushUniqueText(texts, safeText);
    emitEvent({ type: "assistant", message: { content: [{ type: "text", text: safeText }] } });
  }

  function failNoToolsProbe(action) {
    if (!noToolsProbe || noToolsViolation) return;
    const safeAction = safeDiagnostic(action, 512);
    noToolsViolation = safeAction;
    errorMessage = `Codex attempted ${safeAction} during a no-tool readiness probe`;
    failureKind = "tool_policy_violation";
    codexDiagnostics = { ...codexDiagnostics, codex_error_code: "codex_no_tools_violation", codex_tool_action: safeAction };
    emitEvent({
      type: "runtime_warning",
      warning_kind: "codex_no_tools_violation",
      message: "Codex attempted a tool action during the no-tool readiness probe; the turn was interrupted.",
    });
    if (threadId && activeTurnId && !interruptSent) {
      interruptSent = true;
      client?.request("turn/interrupt", { threadId, turnId: activeTurnId }).catch(() => {});
    }
    turnCompleted = true;
    resolveTurn({ id: activeTurnId, status: "interrupted" });
  }

  function failUnsupportedServerRequest(method) {
    if (noToolsProbe) {
      failNoToolsProbe(method);
      return;
    }
    if (serverRequestViolation) return;
    const safeMethod = safeDiagnostic(method, 512);
    serverRequestViolation = safeMethod;
    errorMessage = `Codex requested unsupported client interaction (${safeMethod}); the unattended turn was stopped.`;
    failureKind = "skipped_capability_mismatch";
    codexDiagnostics = {
      ...codexDiagnostics,
      codex_error_code: "codex_server_request_unsupported",
      codex_server_request_method: safeMethod,
    };
    emitEvent({
      type: "runtime_warning",
      warning_kind: "codex_server_request_unsupported",
      message: errorMessage,
    });
    turnCompleted = true;
    resolveTurn({ id: activeTurnId, status: "interrupted" });
  }

  function assertNoUnsupportedServerRequest() {
    if (serverRequestViolation) {
      throw new Error(errorMessage || `Unsupported Codex app-server request: ${serverRequestViolation}`);
    }
  }

  function handleNotification(notification) {
    const safeNotification = sanitizeCodexNotification(notification, sensitiveValues);
    const { method, params = {} } = safeNotification;
    if (noToolsProbe) {
      const itemType = params.item?.type;
      if (
        CODEX_NO_TOOL_REQUEST_METHODS.has(method)
        || ((method === "item/started" || method === "item/completed") && CODEX_NO_TOOL_ACTION_ITEMS.has(itemType))
      ) {
        failNoToolsProbe(typeof itemType === "string" ? itemType : method);
        return;
      }
    }
    if (method === "turn/started") {
      setActiveTurnId(params.turn?.id, { steerReady: true });
      emitEvent({ type: "cli_event", raw: { type: "turn_started", turn: params.turn } });
      return;
    }
    if (method === "turn/completed") {
      setActiveTurnId(params.turn?.id);
      turnCompleted = true;
      if (params.turn?.status === "failed") {
        errorMessage = safeDiagnostic(params.turn?.error?.message || params.turn?.error || "Codex turn failed");
        failureKind = "provider_unavailable";
      }
      if (activeCompactions.size > 0) {
        const cancelled = params.turn?.status === "cancelled" || params.turn?.status === "interrupted";
        finalizeOpenCompactions(
          cancelled ? "cancelled" : "incomplete",
          cancelled ? "Compaction was interrupted." : "Compaction ended without a completion event.",
        );
      }
      const safeTurn = params.turn?.error === undefined
        ? params.turn
        : { ...params.turn, error: safeResponseError(params.turn.error) };
      emitEvent({ type: "cli_event", raw: { type: "turn_completed", turn: safeTurn } });
      resolveTurn(params.turn);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      usage = usageFromTokenUsage(params.tokenUsage);
      const contextUsage = contextUsageFromTokenUsage(params.tokenUsage);
      if (contextUsage) {
        emitEvent({
          type: "context_usage",
          sdk: "codex",
          model: actualModel ? `codex:${actualModel}` : requestedReference,
          timestamp: Date.now(),
          ...(typeof params.turnId === "string" && params.turnId.length > 0
            ? { measurementId: params.turnId }
            : {}),
          ...contextUsage,
        });
      }
      return;
    }
    if (method === "model/rerouted") {
      if (typeof params.toModel === "string" && params.toModel.trim().length > 0) actualModel = params.toModel;
      return;
    }
    if (method === "thread/compacted") {
      handleLegacyCompaction(params);
      return;
    }
    if (method === "item/agentMessage/delta") {
      const current = agentTextByItem.get(params.itemId) || "";
      agentTextByItem.set(params.itemId, `${current}${params.delta || ""}`);
      return;
    }
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      emitEvent({ type: "assistant", message: { content: [{ type: "thinking", text: params.delta || "" }] } });
      return;
    }
    if (method === "warning" || method === "error" || method === "configWarning" || method === "guardianWarning") {
      emitEvent({
        type: "runtime_warning",
        warning_kind: method.replace(/\W+/g, "_"),
        message: safeDiagnostic(params.message || params.error || params),
      });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      if (params.item?.type === "contextCompaction") {
        handleContextCompactionItem(method, params);
        return;
      }
      const raw = mapThreadItem(method, params.item);
      if (params.item?.type === "agentMessage") {
        const text = params.item.text || agentTextByItem.get(params.item.id) || "";
        if (method === "item/completed") handleAgentText(text);
        return;
      }
      if (raw) emitEvent(normalizeCodexItemEvent(raw, codexItemContext) || raw);
    }
  }

  let client = null;
  let resumeEntry = null;
  let sessionRetained = false;
  let abortRequested = false;
  let interruptSent = false;
  // Mutable holder so keep-alive clients can outlive this run: each run
  // installs its own handleNotification and the bridge restores a no-op
  // once the session goes idle.
  const notificationTarget = { handler: handleNotification };
  function createClient() {
    return makeClient({
      command: options.codexAppServerCommand,
      args: options.codexAppServerArgs,
      cwd: options.cwd,
      env: options.codexAppServerEnv,
      redactionValues: sensitiveValues,
      onNotification: (notification) => notificationTarget.handler(
        sanitizeCodexNotification(notification, sensitiveValues),
      ),
      onServerRequest: (request) => {
        const method = typeof request?.method === "string" ? request.method : "unknown";
        failUnsupportedServerRequest(method);
        throw new Error(`Unsupported Codex app-server request: ${method}`);
      },
    });
  }

  async function initializeClient(nextClient) {
    const brand = options.toolContext?.runtimeBrand ?? readRuntimeBrand();
    await nextClient.request("initialize", {
      clientInfo: { name: brand.clientInfoName, title: brand.clientInfoTitle, version: "0" },
      capabilities: { experimentalApi: true },
    });
    assertNoUnsupportedServerRequest();
  }

  async function requestThreadStart(params) {
    const policy = threadStartPolicy(systemPrompt, options);
    const startedAt = Date.now();
    let lastError = null;
    for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
      if (!client) {
        client = createClient();
        await initializeClient(client);
      }
      try {
        const thread = await client.request("thread/start", params, { timeoutMs: policy.timeoutMs });
        assertNoUnsupportedServerRequest();
        codexDiagnostics = {
          ...withoutCodexRequestErrorDiagnostics(codexDiagnostics),
          codex_thread_start_attempts: attempt,
          codex_thread_start_timeout_ms: policy.timeoutMs,
          codex_thread_start_duration_ms: Date.now() - startedAt,
          ...(attempt > 1 ? { codex_thread_start_retried: true } : {}),
        };
        return thread;
      } catch (err) {
        lastError = err;
        codexDiagnostics = {
          ...codexDiagnostics,
          ...codexErrorDiagnostics(err, sensitiveValues),
          codex_thread_start_attempts: attempt,
          codex_thread_start_timeout_ms: policy.timeoutMs,
          codex_thread_start_duration_ms: Date.now() - startedAt,
          ...(attempt > 1 ? { codex_thread_start_retried: true } : {}),
        };
        if (!isCodexRequestTimeout(err, "thread/start") || attempt >= policy.attempts || options.abortSignal?.aborted) {
          throw err;
        }
        emitEvent({
          type: "runtime_warning",
          warning_kind: "codex_thread_start_retry",
          message: `Codex app-server thread/start timed out after ${policy.timeoutMs}ms; retrying with a fresh app-server.`,
        });
        await closeCodexClient(client);
        client = null;
        await delay(policy.backoffMs, options.abortSignal);
      }
    }
    throw lastError || new Error("codex app-server request timed out: thread/start");
  }

  const abortHandler = () => {
    abortRequested = true;
    if (threadId && activeTurnId && !interruptSent) {
      interruptSent = true;
      client?.request("turn/interrupt", { threadId, turnId: activeTurnId }).catch(() => {});
    }
    // Resumed sessions stay alive across an interrupt; only fresh runs tear
    // down their subprocess on abort.
    if (!resumeEntry) void closeCodexClient(client);
  };

  async function steerLiveInput() {
    if (!options.liveInput) return;
    const iterator = options.liveInput[Symbol.asyncIterator]();
    try {
      while (!turnCompleted) {
        const next = await Promise.race([
          iterator.next(),
          turnDone.then(() => ({ done: true, value: undefined })),
        ]);
        if (next.done || turnCompleted) break;
        const message = next.value;
        if (!threadId || !activeTurnId || !turnReadyResolved) {
          await Promise.race([
            turnReady,
            turnDone,
            client.closed.then((err) => { throw err; }),
          ]);
          if (turnCompleted || !turnReadyResolved) break;
        }
        const input = userTextInput(formatLiveInputGuidance(message.body, options.prompts));
        try {
          const response = await client.request("turn/steer", {
            threadId,
            expectedTurnId: activeTurnId,
            input,
          });
          activeTurnId = response?.turnId || activeTurnId;
          message.acknowledge?.();
        } catch (err) {
          const providerError = err?.responseError;
          if (isNoActiveTurnToSteer(providerError || err)) {
            await Promise.race([
              turnReady,
              turnDone,
              client.closed.then((closedErr) => { throw closedErr; }),
            ]);
            if (turnCompleted) break;
            try {
              const response = await client.request("turn/steer", {
                threadId,
                expectedTurnId: activeTurnId,
                input,
              });
              activeTurnId = response?.turnId || activeTurnId;
              message.acknowledge?.();
              continue;
            } catch (retryErr) {
              message.reject?.(retryErr);
              const retryProviderError = retryErr?.responseError
                ? safeResponseError(retryErr.responseError)
                : null;
              emitEvent({
                type: "runtime_warning",
                warning_kind: isActiveTurnNotSteerable(retryProviderError) ? "active_turn_not_steerable" : "live_input_rejected",
                message: safeDiagnostic(codexErrorMessage(retryProviderError || retryErr)),
              });
              // Preserve FIFO fallback: once one message is rejected, later
              // entries must not overtake it inside this provider attempt.
              break;
            }
          }
          message.reject?.(err);
          emitEvent({
            type: "runtime_warning",
            warning_kind: isActiveTurnNotSteerable(providerError) ? "active_turn_not_steerable" : "live_input_rejected",
            message: safeDiagnostic(codexErrorMessage(
              providerError ? safeResponseError(providerError) : err,
            )),
          });
          break;
        }
      }
    } finally {
      if (typeof iterator.return === "function") {
        try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* best-effort */ }
      }
    }
  }

  function sessionUnavailableResult(kind, error, codexErrorCode) {
    return {
      text: null,
      structuredResult: undefined,
      structuredResultSource: null,
      events: [],
      usage: {},
      durationMs: Date.now() - start,
      numTurns: 0,
      model: resolved?.reference || `codex:${resolved?.model || ""}`,
      effort: options.effort || null,
      sdk: "codex",
      providerSessionId: resumeSessionId,
      provider_session_id: resumeSessionId,
      cancelled: false,
      error,
      failureKind: kind,
      diagnostics: { codex_error_code: codexErrorCode },
      capabilitiesUsed: buildCapabilitiesUsed({
        promptCacheActive: null,
        thinkingEnabled: null,
        structuredOutputEnforced: !!options.outputSchema,
        subagentInvoked: null,
        mcpServersUsed: Object.keys(options.mcpServers || {}),
        nativeSubagentsUsed: [],
        toolCompactionApplied: false,
        contextCompactionApplied: null,
      }),
    };
  }

  if (resolveSandboxPolicy(options.toolContext, options.sandboxPolicy) !== undefined) {
    return sessionUnavailableResult(
      "skipped_capability_mismatch",
      "Direct Codex cannot enforce mono-agent's native srt sandbox scopes. Remove the mono-agent sandbox policy or use a Pi runtime for exact readableRoots, writableRoots, denyWrite, and network rules.",
      "codex_sandbox_policy_unsupported",
    );
  }

  const toolPolicyProblem = codexToolPolicyProblem(options);
  if (toolPolicyProblem) {
    return sessionUnavailableResult(
      "skipped_capability_mismatch",
      toolPolicyProblem,
      "codex_tool_policy_unsupported",
    );
  }

  if (resumeSessionId) {
    // Await-free busy claim (get -> busy check -> set-busy in one span). A miss
    // fails fast: the host sent no conversation history for a resume, so silently
    // starting a fresh thread would lose context. A busy entry is executing a
    // turn already.
    const claimed = codexLiveness.claim(resumeSessionId);
    if (!claimed.ok) {
      // @ts-check does not narrow the ClaimResult union on `!claimed.ok`,
      // though the loser branch always carries `reason`.
      return /** @type {{reason: string}} */ (claimed).reason === "missing"
        ? sessionUnavailableResult(
          "session_not_found",
          `Codex session ${resumeSessionId} is not live; cannot resume`,
          "codex_session_not_found",
        )
        : sessionUnavailableResult(
          "session_busy",
          `Codex session ${resumeSessionId} is already executing a turn`,
          "codex_session_busy",
        );
    }
    resumeEntry = claimed.entry;
  }

  try {
    if (resumeEntry) {
      client = resumeEntry.client;
      threadId = resumeEntry.threadId;
      resumeEntry.notificationTarget.handler = handleNotification;
      // Keep the idle TTL from firing while the turn is in flight.
      codexSessions.touch(resumeSessionId, { idleTimeoutMs: sessionTtlMs });
    } else {
      client = createClient();
    }
    if (options.abortSignal) {
      if (options.abortSignal.aborted) abortHandler();
      else options.abortSignal.addEventListener("abort", abortHandler, { once: true });
    }
    if (!resumeEntry) await initializeClient(client);
    let collaborationMode = noToolsProbe
      ? null
      : codexCollaborationModePayload(options.nativeSubagents, {
        model: resolved.model,
        effort: normalizedEffort,
        systemPrompt,
      });
    if (collaborationMode) {
      try {
        await client.request("collaborationMode/list", {}, { timeoutMs: 5_000 });
      } catch (err) {
        emitEvent({
          type: "runtime_warning",
          warning_kind: "codex_collaboration_mode_unavailable",
          message: safeDiagnostic(codexErrorMessage(
            err?.responseError ? safeResponseError(err.responseError) : err,
          )),
        });
        collaborationMode = null;
      }
    }
    const fastMode = codexModelSupportsFastMode(resolved.model) && normalizeFastMode(options.fastMode, true);
    if (!resumeEntry) {
      const mcpServers = noToolsProbe ? {} : codexMcpConfig(options.mcpServers);
      // Incrementally assembled config handed across the codex app-server
      // boundary; the reasoning fields below are attached conditionally.
      const config = /** @type {any} */ ({
        ...(fastMode ? { service_tier: "fast" } : {}),
        features: { fast_mode: fastMode },
        ...(noToolsProbe
          ? { mcp_servers: {} }
          : Object.keys(mcpServers).length
            ? { mcp_servers: mcpServers }
            : {}),
      });
      if (normalizedEffort) {
        config.model_reasoning_effort = normalizedEffort;
        if (normalizedEffort !== "none") config.model_reasoning_summary = "auto";
      }
      // The codex app-server protocol exposes thread/start but no thread/load
      // primitive, so cold continuations always start a fresh thread; a
      // thread is only resumable while its subprocess stays live in
      // codexSessions (options.sessionKeepAlive + options.sessionId).
      const thread = await requestThreadStart({
        model: resolved.model,
        modelProvider: "openai",
        ...(fastMode ? { serviceTier: "fast" } : {}),
        cwd: options.cwd || process.cwd(),
        approvalPolicy: approvalPolicyForRun(options),
        sandbox: sandboxForRun(options),
        config,
        serviceName: (options.toolContext?.runtimeBrand ?? readRuntimeBrand()).serviceName,
        developerInstructions: systemPrompt,
        ephemeral: true,
        sessionStartSource: "startup",
        ...(noToolsProbe ? { environments: [], dynamicTools: [], selectedCapabilityRoots: [] } : {}),
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      });
      threadId = thread?.thread?.id;
      if (!threadId) throw new Error("Codex app-server did not return a thread id");
    }

    const steerTask = steerLiveInput();
    steerTask.catch((err) => {
      emitEvent({
        type: "runtime_warning",
        warning_kind: "live_input_failed",
        message: safeDiagnostic(err?.message || err),
      });
    });
    const turnParams = {
      threadId,
      input: userTextInput(prompt),
      cwd: options.cwd || process.cwd(),
      approvalPolicy: approvalPolicyForRun(options),
      sandboxPolicy: sandboxPolicyForRun(options),
      model: resolved.model,
      ...(fastMode ? { serviceTier: "fast" } : {}),
      effort: normalizedEffort,
      summary: normalizedEffort && normalizedEffort !== "none" ? "auto" : "none",
      outputSchema: options.outputSchema,
      ...(collaborationMode ? { collaborationMode } : {}),
    };
    let turn;
    try {
      turn = await client.request("turn/start", turnParams);
      assertNoUnsupportedServerRequest();
    } catch (err) {
      if (!collaborationMode) throw err;
      emitEvent({
        type: "runtime_warning",
        warning_kind: "codex_collaboration_mode_rejected",
        message: safeDiagnostic(codexErrorMessage(
          err?.responseError ? safeResponseError(err.responseError) : err,
        )),
      });
      const fallbackParams = { ...turnParams };
      delete fallbackParams.collaborationMode;
      turn = await client.request("turn/start", fallbackParams);
      assertNoUnsupportedServerRequest();
    }
    setActiveTurnId(turn?.turn?.id);

    let prematureClose = false;
    // Resumed runs watch subprocess death through the entry's mutable hook
    // instead of client.closed.then: a long-lived thread would otherwise
    // accumulate one permanent .then closure per turn.
    const closedSignal = resumeEntry
      ? new Promise((resolve) => { resumeEntry.closedTarget.handler = resolve; })
      : client.closed;
    // Resumed runs never close the client on abort, so the wait must also
    // resolve on the abort signal or an interrupted turn could hang forever.
    let abortRaceCleanup = () => {};
    const abortedSignal = resumeEntry && options.abortSignal
      ? new Promise((resolve) => {
        if (options.abortSignal.aborted) {
          resolve(null);
          return;
        }
        const onAbort = () => resolve(null);
        options.abortSignal.addEventListener("abort", onAbort, { once: true });
        abortRaceCleanup = () => options.abortSignal.removeEventListener?.("abort", onAbort);
      })
      : null;
    try {
      await Promise.race([
        turnDone,
        ...(abortedSignal === null ? [] : [abortedSignal]),
        closedSignal.then((err) => {
          if (!turnCompleted) {
            prematureClose = true;
            throw err || new Error("codex app-server closed");
          }
          return null;
        }),
      ]);
    } catch (err) {
      if (prematureClose && !errorMessage) {
        errorMessage = safeDiagnostic(err?.message || "codex app-server stream closed before turn completed");
        failureKind = "provider_unavailable";
      } else if (!prematureClose) {
        throw err;
      }
    } finally {
      abortRaceCleanup();
    }
    turnCompleted = true;
    await steerTask;

    const text = texts[texts.length - 1] || "";
    let codexErrorCode = prematureClose ? "codex_app_server_closed" : null;
    if (!errorMessage && !text.trim()) {
      errorMessage = "codex app-server completed without final output";
      failureKind = "provider_unavailable";
      codexErrorCode = codexErrorCode || "codex_app_server_no_output";
    }
    if (resumeEntry) {
      // A failed turn or a closed transport leaves the thread untrustworthy,
      // but an interrupt is normal steering: the aborted session survives.
      const aborted = !!options.abortSignal?.aborted;
      sessionRetained = (aborted && !prematureClose) || (!errorMessage && !failureKind);
      if (sessionRetained) codexSessions.touch(resumeSessionId, { idleTimeoutMs: sessionTtlMs });
      else codexSessions.delete(resumeSessionId);
    } else if (keepAlive && threadId && !errorMessage && !failureKind && !options.abortSignal?.aborted) {
      sessionRetained = true;
      notificationTarget.handler = noopNotificationHandler;
      const entry = { client, threadId, busy: false, notificationTarget, closedTarget: { handler: null } };
      codexSessions.set(threadId, entry, { idleTimeoutMs: sessionTtlMs });
      client.closed.then(() => {
        codexSessions.delete(threadId);
        entry.closedTarget.handler?.(new Error("codex app-server closed"));
      });
    }
    const hadPartialProgress = events.length > 0 || texts.length > 0;
    const reference = requestedReference;
    const inputTokens = usage?.input_tokens ?? usage?.inputTokens ?? 0;
    const outputTokens = usage?.output_tokens ?? usage?.outputTokens ?? 0;
    const cachedTokens = usage?.cache_read_tokens ?? usage?.cachedInputTokens ?? 0;
    const cacheCreationTokens = usage?.cache_creation_tokens ?? usage?.cacheCreationTokens ?? 0;
    const billableInputTokens = Math.max(0, inputTokens - cachedTokens - cacheCreationTokens);
    const costUsd = estimateCost({
      resolveCustomPricing: options.resolveCustomPricing,
      model: reference,
      inputTokens: billableInputTokens,
      outputTokens,
      cachedTokens,
      cacheWriteTokens: cacheCreationTokens,
    });
    const enrichedUsage = {
      ...usage,
      input_tokens: inputTokens || null,
      output_tokens: outputTokens || null,
      cache_read_tokens: cachedTokens || null,
      cache_creation_tokens: cacheCreationTokens || null,
      cost_usd: costUsd,
    };
    return {
      text,
      structuredResult: undefined,
      structuredResultSource: null,
      events,
      usage: enrichedUsage,
      durationMs: Date.now() - start,
      numTurns: 1,
      model: reference,
      effort: options.effort || null,
      sdk: "codex",
      providerSessionId: threadId || null,
      provider_session_id: threadId || null,
      cancelled: !!options.abortSignal?.aborted,
      error: errorMessage,
      failureKind,
      diagnostics: {
        ...codexDiagnostics,
        ...(codexErrorCode ? { codex_error_code: codexErrorCode } : {}),
        ...(hadPartialProgress && failureKind === "provider_unavailable"
          ? { had_partial_progress: true }
          : {}),
      },
      capabilitiesUsed: buildCapabilitiesUsed({
        promptCacheActive: (cachedTokens || 0) > 0 || (cacheCreationTokens || 0) > 0,
        thinkingEnabled: null,
        structuredOutputEnforced: !!options.outputSchema,
        subagentInvoked: null,
        mcpServersUsed: Object.keys(options.mcpServers || {}),
        nativeSubagentsUsed: [],
        toolCompactionApplied: false,
        contextCompactionApplied: null,
      }),
    };
  } catch (err) {
    if (resumeEntry) codexSessions.delete(resumeSessionId);
    return {
      text: texts[texts.length - 1] || null,
      structuredResult: undefined,
      structuredResultSource: null,
      events,
      usage,
      durationMs: Date.now() - start,
      numTurns: texts.length || (events.length ? 1 : 0),
      model: resolved?.reference || `codex:${resolved?.model || ""}`,
      effort: options.effort || null,
      sdk: "codex",
      providerSessionId: threadId || null,
      provider_session_id: threadId || null,
      cancelled: !!options.abortSignal?.aborted,
      error: safeDiagnostic(err?.message || err),
      failureKind: failureKind || "provider_unavailable",
      diagnostics: {
        ...codexDiagnostics,
        ...codexErrorDiagnostics(err, sensitiveValues),
        ...(events.length > 0 || texts.length > 0 ? { had_partial_progress: true } : {}),
      },
      capabilitiesUsed: buildCapabilitiesUsed({
        promptCacheActive: null,
        thinkingEnabled: null,
        structuredOutputEnforced: !!options.outputSchema,
        subagentInvoked: null,
        mcpServersUsed: Object.keys(options.mcpServers || {}),
        nativeSubagentsUsed: [],
        toolCompactionApplied: false,
        contextCompactionApplied: null,
      }),
    };
  } finally {
    if (activeCompactions.size > 0) {
      const cancelled = !!options.abortSignal?.aborted;
      finalizeOpenCompactions(
        cancelled ? "cancelled" : "incomplete",
        cancelled ? "Compaction was interrupted." : "Compaction ended without a completion event.",
      );
    }
    options.abortSignal?.removeEventListener?.("abort", abortHandler);
    if (resumeEntry) {
      resumeEntry.busy = false;
      resumeEntry.notificationTarget.handler = noopNotificationHandler;
      resumeEntry.closedTarget.handler = null;
    }
    if (!sessionRetained) await closeCodexClient(client);
  }
}

// CLI bridge for sdk='codex' agents that opt into execution_mode='cli'. The
// codex `app-server` is more capable than `codex exec` (better event
// streaming, MCP support), so this is the default CLI path for Codex.
export const codexAppRuntimeBridge = {
  id: "codex-app",
  kind: "codex-app",
  capabilities: CODEX_APP_CAPABILITIES,
  supports: (ref, options) => ref?.sdk === "codex" && options?.executionMode === "cli",
  execute: generateCodexAppResponse,
};
