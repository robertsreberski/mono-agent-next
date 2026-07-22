const REDACTED_TELEGRAM_TOKEN = "[REDACTED_TELEGRAM_BOT_TOKEN]";
const REDACTED_BEARER = "[REDACTED_BEARER_CREDENTIAL]";
const REDACTION_FAILED = "[TELEGRAM_LOG_DETAILS_UNAVAILABLE]";
const TELEGRAM_URL_TOKEN_PATTERN = /(\/file\/bot|\/bot)([^/?#\s]+)/giu;
const TELEGRAM_TOKEN_PATTERN = /\b\d{5,}:[A-Za-z0-9_-]{8,}\b/gu;
const BEARER_CREDENTIAL_PATTERN = /\b(Bearer\s+)(?:\\*["'][^\r\n]*?\\*["']|[^\s,;]+)/giu;
const RAW_SENSITIVE_NAME_FRAGMENT = [
  "authorization",
  "auth(?:entication)?",
  "cookie",
  "token",
  "secret",
  "password",
  "signature",
  "credential",
  "api[-_]?key",
  "client[-_]?secret",
  "access[-_]?token",
  "refresh[-_]?token",
  "session[-_]?token",
].join("|");
const QUERY_SENSITIVE_NAME_FRAGMENT = [
  RAW_SENSITIVE_NAME_FRAGMENT,
  "key",
  "code",
  "sig",
].join("|");
const SECRET_QUERY_PATTERN = new RegExp(
  `([?&](?:[^=&#\\s]*[-_.])?(?:${QUERY_SENSITIVE_NAME_FRAGMENT})(?:[-_.][^=&#\\s]*)?=)[^&#\\s]+`,
  "giu",
);
const SECRET_HEADER_TEXT_PATTERN = new RegExp(
  `((?:^|[^A-Za-z0-9_-])(?:\\\\*["'])?[A-Za-z0-9_.-]*(?:${RAW_SENSITIVE_NAME_FRAGMENT})[A-Za-z0-9_.-]*(?:\\\\*["'])?\\s*[:=]\\s*)[^\\r\\n]*`,
  "giu",
);
const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^@/\s]*@/giu;
const SENSITIVE_KEY_PARTS = new Set([
  "authorization",
  "auth",
  "authentication",
  "cookie",
  "token",
  "secret",
  "password",
  "signature",
  "sig",
  "credential",
  "key",
]);
const SENSITIVE_COMPACT_KEYS = new Set([
  "apikey",
  "authkey",
  "clientsecret",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "proxyauthorization",
  "setcookie",
]);

export interface TelegramLogSink {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

/** Redact configured and recognizable Telegram Bot API tokens from arbitrary text. */
export function redactTelegramSecretText(
  text: string,
  knownSecrets: readonly string[] = [],
): string {
  let redacted = text;
  for (const secret of knownSecrets) {
    if (typeof secret !== "string") continue;
    const normalized = secret.trim();
    if (normalized.length > 0) {
      redacted = redacted.split(normalized).join(REDACTED_TELEGRAM_TOKEN);
    }
  }
  return redacted
    .replace(TELEGRAM_URL_TOKEN_PATTERN, `$1${REDACTED_TELEGRAM_TOKEN}`)
    .replace(TELEGRAM_TOKEN_PATTERN, REDACTED_TELEGRAM_TOKEN)
    .replace(BEARER_CREDENTIAL_PATTERN, `$1${REDACTED_BEARER}`)
    .replace(SECRET_QUERY_PATTERN, `$1${REDACTED_BEARER}`)
    .replace(SECRET_HEADER_TEXT_PATTERN, `$1${REDACTED_BEARER}`)
    .replace(URL_USERINFO_PATTERN, `$1${REDACTED_BEARER}@`);
}

/** Render one error message without allowing Telegram credentials into logs. */
export function redactTelegramErrorMessage(
  error: unknown,
  knownSecrets: readonly string[] = [],
): string {
  if (typeof error === "string") return redactTelegramSecretText(error, knownSecrets);
  if (error instanceof Error) {
    const message = safeStringProperty(error, "message");
    return message === undefined
      ? REDACTION_FAILED
      : redactTelegramSecretText(message, knownSecrets);
  }
  if (error === null || error === undefined || typeof error === "number" || typeof error === "boolean") {
    return redactTelegramSecretText(String(error), knownSecrets);
  }
  return REDACTION_FAILED;
}

/**
 * Wrap a logger at the adapter boundary so future log sites are safe even when
 * they pass nested errors, causes, request objects, URLs, or stacks.
 */
export function createSecretSafeTelegramLogger<T extends TelegramLogSink>(
  logger: T | undefined,
  knownSecrets: readonly string[],
): T | undefined {
  if (logger === undefined) {
    return undefined;
  }

  const wrapped: TelegramLogSink = {};
  for (const level of ["debug", "info", "warn", "error"] as const) {
    const sink = logger[level];
    if (sink === undefined) {
      continue;
    }
    wrapped[level] = (message, metadata) => {
      let safeMessage = REDACTION_FAILED;
      let safeMetadata: Record<string, unknown> | undefined;
      try {
        safeMessage = redactTelegramSecretText(message, knownSecrets);
        safeMetadata = metadata === undefined
          ? undefined
          : sanitizeTelegramLogRecord(metadata, knownSecrets);
      } catch {
        safeMetadata = { redaction: REDACTION_FAILED };
      }
      try {
        sink.call(logger, safeMessage, safeMetadata);
      } catch {
        // Logging is diagnostic and cannot stop polling recovery or a turn.
      }
    };
  }
  return wrapped as T;
}

/** Return an Error safe to hand to host callbacks that may log it themselves. */
export function redactTelegramError(
  error: unknown,
  knownSecrets: readonly string[],
): Error {
  try {
    const sanitized = sanitizeTelegramLogValue(error, knownSecrets, new WeakSet<object>());
    const record = isRecord(sanitized) ? sanitized : undefined;
    const safe = new Error(
      typeof record?.message === "string"
        ? record.message
        : redactTelegramErrorMessage(error, knownSecrets),
    );
    if (typeof record?.name === "string") safe.name = record.name;
    if (typeof record?.stack === "string") safe.stack = record.stack;
    if (record !== undefined) {
      for (const [key, value] of Object.entries(record)) {
        if (key === "name" || key === "message" || key === "stack") continue;
        Object.defineProperty(safe, key, {
          configurable: true,
          enumerable: key !== "cause",
          value,
        });
      }
    }
    return safe;
  } catch {
    return new Error(REDACTION_FAILED);
  }
}

function sanitizeTelegramLogRecord(
  record: Record<string, unknown>,
  knownSecrets: readonly string[],
): Record<string, unknown> {
  const sanitized = sanitizeTelegramLogValue(record, knownSecrets, new WeakSet<object>());
  return isRecord(sanitized) ? sanitized : { value: sanitized };
}

function sanitizeTelegramLogValue(
  value: unknown,
  knownSecrets: readonly string[],
  ancestors: WeakSet<object>,
  container?: "headers" | "query",
): unknown {
  if (typeof value === "string") {
    if (container !== undefined) return REDACTED_BEARER;
    return redactTelegramSecretText(value, knownSecrets);
  }
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return "[Symbol]";
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (ancestors.has(value)) {
    return "[Circular]";
  }
  ancestors.add(value);
  try {
    if (value instanceof URL) {
      return redactTelegramSecretText(value.href, knownSecrets);
    }
    if (value instanceof Error) {
      const safe = Object.create(null) as Record<string, unknown>;
      safe.name = redactSafeStringProperty(value, "name", knownSecrets);
      safe.message = redactSafeStringProperty(value, "message", knownSecrets);
      const stack = safeStringProperty(value, "stack");
      if (stack !== undefined) safe.stack = redactTelegramSecretText(stack, knownSecrets);
      copySafeOwnProperties(value, safe, knownSecrets, ancestors, container, new Set(["name", "message", "stack"]));
      return safe;
    }
    if (Array.isArray(value)) {
      if (container === "headers" || container === "query") {
        if (typeof value[0] === "string" && value.length === 2) {
          return [redactTelegramSecretText(value[0], knownSecrets), REDACTED_BEARER];
        }
        return value.map((entry, index) => {
          if (Array.isArray(entry) && typeof entry[0] === "string") {
            return [redactTelegramSecretText(entry[0], knownSecrets), REDACTED_BEARER];
          }
          if (typeof entry === "string") {
            return index % 2 === 0
              ? redactTelegramSecretText(entry, knownSecrets)
              : REDACTED_BEARER;
          }
          return sanitizeTelegramLogValue(entry, knownSecrets, ancestors, container);
        });
      }
      if (typeof value[0] === "string" && sensitiveLogKey(value[0])) {
        return [redactTelegramSecretText(value[0], knownSecrets), REDACTED_BEARER];
      }
      return value.map((entry) => {
        if (
          Array.isArray(entry)
          && typeof entry[0] === "string"
          && sensitiveLogKey(entry[0])
        ) {
          return [redactTelegramSecretText(entry[0], knownSecrets), REDACTED_BEARER];
        }
        return sanitizeTelegramLogValue(entry, knownSecrets, ancestors);
      });
    }

    const safe = Object.create(null) as Record<string, unknown>;
    copySafeOwnProperties(value, safe, knownSecrets, ancestors, container);
    return safe;
  } catch {
    return REDACTION_FAILED;
  } finally {
    ancestors.delete(value);
  }
}

function sensitiveLogKey(key: string): boolean {
  const normalized = normalizeLogKey(key);
  const parts = normalized.split("-").filter(Boolean);
  if (parts.some((part) => SENSITIVE_KEY_PARTS.has(part))) return true;
  if (normalized === "code") return true;
  return SENSITIVE_COMPACT_KEYS.has(parts.join(""));
}

function logContainer(key: string): "headers" | "query" | undefined {
  const normalized = normalizeLogKey(key).replace(/[-_]/gu, "");
  if (normalized === "header" || normalized.endsWith("headers") || normalized.endsWith("headerpairs")) {
    return "headers";
  }
  if (
    normalized === "query"
    || normalized === "params"
    || normalized.endsWith("query")
    || normalized.endsWith("queryparams")
    || normalized.endsWith("searchparams")
    || normalized.endsWith("querystring")
  ) {
    return "query";
  }
  return undefined;
}

function normalizeLogKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .toLocaleLowerCase("en-US");
}

function copySafeOwnProperties(
  value: object,
  target: Record<string, unknown>,
  knownSecrets: readonly string[],
  ancestors: WeakSet<object>,
  container?: "headers" | "query",
  excluded: ReadonlySet<string> = new Set(),
): void {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (excluded.has(key)) continue;
    const safeKey = redactTelegramSecretText(key, knownSecrets);
    const childContainer = logContainer(key);
    if (container !== undefined || sensitiveLogKey(key)) {
      setSafeProperty(target, safeKey, REDACTED_BEARER);
    } else if (!("value" in descriptor)) {
      setSafeProperty(target, safeKey, "[Accessor]");
    } else {
      setSafeProperty(target, safeKey, sanitizeTelegramLogValue(
        descriptor.value,
        knownSecrets,
        ancestors,
        childContainer,
      ));
    }
  }
}

function setSafeProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function safeStringProperty(value: object, key: string): string | undefined {
  try {
    const property = Reflect.get(value, key);
    return typeof property === "string" ? property : undefined;
  } catch {
    return undefined;
  }
}

function redactSafeStringProperty(value: object, key: string, knownSecrets: readonly string[]): string {
  const property = safeStringProperty(value, key);
  return property === undefined ? REDACTION_FAILED : redactTelegramSecretText(property, knownSecrets);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
