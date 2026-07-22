import { types as nodeUtilTypes } from "node:util";

const REDACTED_SLACK_TOKEN = "[REDACTED_SLACK_TOKEN]";
const REDACTED_BEARER = "[REDACTED_BEARER_CREDENTIAL]";
const REDACTION_FAILED = "[SLACK_LOG_DETAILS_UNAVAILABLE]";
const REDACTION_LIMIT = "[SLACK_LOG_DETAILS_TRUNCATED]";
const REDACTED_FRAGMENTED_CREDENTIAL = "[REDACTED_FRAGMENTED_CREDENTIAL]";
const OMITTED_BINARY_DATA = "[SLACK_LOG_BINARY_DATA_OMITTED]";
const REPEATED_REFERENCE = "[Repeated]";
const REDACTION_BOUNDARY_MARKERS = [REDACTED_SLACK_TOKEN, REDACTED_BEARER] as const;
const PRESERVED_SLACK_LOG_MARKERS = new Set([
  REDACTED_SLACK_TOKEN,
  REDACTED_BEARER,
  REDACTION_FAILED,
  REDACTION_LIMIT,
  REDACTED_FRAGMENTED_CREDENTIAL,
  OMITTED_BINARY_DATA,
  REPEATED_REFERENCE,
  "[Accessor]",
  "[BigInt]",
  "[Circular]",
  "[Function]",
  "[Symbol]",
]);
const MAX_LOG_TEXT_CHARS = 16_384;
const MAX_LOG_DEPTH = 16;
const MAX_LOG_NODES = 256;
const MAX_LOG_PROPERTIES = 512;
const MAX_LOG_PROPERTIES_PER_OBJECT = 128;
const MAX_LOG_ARRAY_LENGTH = 256;
const MAX_LOG_ARRAY_ENTRIES = 512;
const MAX_LOG_OUTPUT_CHARS = 65_536;
const SLACK_TOKEN_PATTERN = /\b(?:xox[a-z]|xapp)-[A-Za-z0-9_-]{8,}\b/giu;
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
  "ticket",
].join("|");
const SECRET_QUERY_PATTERN = new RegExp(
  `([?&](?:[^=&#\\s]*[-_.])?(?:${QUERY_SENSITIVE_NAME_FRAGMENT})(?:[-_.][^=&#\\s]*)?=)[^&#\\s]+`,
  "giu",
);
const SECRET_HEADER_TEXT_PATTERN = new RegExp(
  `((?:^|[^A-Za-z0-9_-])(?:\\\\*["'])?[A-Za-z0-9_.-]*(?:${RAW_SENSITIVE_NAME_FRAGMENT})[A-Za-z0-9_.-]*(?:\\\\*["'])?\\s*[:=]\\s*)[^\\r\\n]*`,
  "giu",
);
const QUERY_PARAMETER_PATTERN = /([?&])([^=&#\s]+)=([^&#\s]+)/giu;
const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s"'<>]*@/giu;
const URL_HREF_GETTER = Object.getOwnPropertyDescriptor(URL.prototype, "href")?.get;
const PROMISE_THEN = Promise.prototype.then;
const STRING_VALUE_OF = String.prototype.valueOf;
const ARRAY_BUFFER_IS_VIEW = ArrayBuffer.isView;
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
  "ticket",
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

export interface SlackLogSink {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

/** Redact configured and recognizable Slack credentials from arbitrary text. */
export function redactSlackSecretText(
  text: string,
  knownSecrets: readonly string[] = [],
): string {
  if (nodeUtilTypes.isProxy(knownSecrets)) return REDACTION_FAILED;
  if (text.length > MAX_LOG_TEXT_CHARS) {
    return REDACTION_LIMIT;
  }
  let redacted = text;
  for (const secret of knownSecrets) {
    if (typeof secret !== "string") continue;
    const normalized = secret.trim();
    if (normalized.length > 0) {
      redacted = replaceKnownSecretBounded(redacted, normalized);
      if (redacted === REDACTION_LIMIT) return REDACTION_LIMIT;
    }
  }
  for (const replace of [
    (value: string) => value.replace(SLACK_TOKEN_PATTERN, REDACTED_SLACK_TOKEN),
    (value: string) => value.replace(BEARER_CREDENTIAL_PATTERN, `$1${REDACTED_BEARER}`),
    (value: string) => value.replace(SECRET_QUERY_PATTERN, `$1${REDACTED_BEARER}`),
    (value: string) => value.replace(QUERY_PARAMETER_PATTERN, redactSensitiveQueryParameter),
    (value: string) => value.replace(SECRET_HEADER_TEXT_PATTERN, `$1${REDACTED_BEARER}`),
    (value: string) => value.replace(URL_USERINFO_PATTERN, `$1${REDACTED_BEARER}@`),
  ]) {
    redacted = replace(redacted);
    if (redacted.length > MAX_LOG_TEXT_CHARS) return REDACTION_LIMIT;
  }
  return redacted;
}

function replaceKnownSecretBounded(text: string, secret: string): string {
  if (!text.includes(secret)) return text;
  if (REDACTED_SLACK_TOKEN.length > secret.length) {
    let occurrences = 0;
    let offset = 0;
    while (offset <= text.length - secret.length) {
      const index = text.indexOf(secret, offset);
      if (index < 0) break;
      occurrences += 1;
      const projected = text.length
        + occurrences * (REDACTED_SLACK_TOKEN.length - secret.length);
      if (projected > MAX_LOG_TEXT_CHARS) return REDACTION_LIMIT;
      offset = index + secret.length;
    }
  }
  const replaced = text.split(secret).join(REDACTED_SLACK_TOKEN);
  return replaced.length > MAX_LOG_TEXT_CHARS ? REDACTION_LIMIT : replaced;
}

/** Render one error message without invoking user-controlled accessors or coercion hooks. */
export function redactSlackErrorMessage(
  error: unknown,
  knownSecrets: readonly string[] = [],
): string {
  try {
    if (typeof error === "string") {
      return redactSlackSecretText(error, knownSecrets);
    }
    if (
      error === null
      || error === undefined
      || typeof error === "number"
      || typeof error === "boolean"
    ) {
      return redactSlackSecretText(String(error), knownSecrets);
    }
    if (typeof error === "bigint") return "[BigInt]";
    if (typeof error === "symbol") return "[Symbol]";
    if (typeof error === "object" || typeof error === "function") {
      if (nodeUtilTypes.isProxy(error)) return REDACTION_FAILED;
      const message = safeStringProperty(error, "message");
      return message === undefined
        ? REDACTION_FAILED
        : redactSlackSecretText(message, knownSecrets);
    }
  } catch {
    // Error rendering is itself inside failure handling and must fail closed.
  }
  return REDACTION_FAILED;
}

/** Match a trusted prototype without invoking Proxy prototype traps. */
export function isSafeSlackPrototypeInstance(
  value: unknown,
  prototype: object,
): boolean {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  ) return false;
  const visited = new Set<object>();
  let current: object | null = value;
  if (nodeUtilTypes.isProxy(current)) return false;
  try {
    current = Object.getPrototypeOf(current) as object | null;
  } catch {
    return false;
  }
  while (current !== null && !visited.has(current) && visited.size < MAX_LOG_DEPTH) {
    if (nodeUtilTypes.isProxy(current)) return false;
    if (current === prototype) return true;
    visited.add(current);
    try {
      current = Object.getPrototypeOf(current) as object | null;
    } catch {
      return false;
    }
  }
  return false;
}

/** Read one data property through a bounded, Proxy-free prototype walk. */
export function readSafeSlackDataProperty(value: unknown, key: string): unknown {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  ) return undefined;
  const visited = new Set<object>();
  let current: object | null = value;
  while (current !== null && !visited.has(current) && visited.size < MAX_LOG_DEPTH) {
    if (nodeUtilTypes.isProxy(current)) return undefined;
    visited.add(current);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      return undefined;
    }
    if (descriptor !== undefined) {
      return "value" in descriptor ? descriptor.value : undefined;
    }
    try {
      current = Object.getPrototypeOf(current) as object | null;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Wrap a logger at the adapter boundary so future log sites are safe even when
 * they pass nested errors, causes, request objects, URLs, or stacks.
 */
export function createSecretSafeSlackLogger(
  logger: SlackLogSink | undefined,
  knownSecrets: readonly string[],
): SlackLogSink | undefined {
  if (logger === undefined || nodeUtilTypes.isProxy(logger)) {
    return undefined;
  }

  const safeKnownSecrets = snapshotKnownSecrets(knownSecrets);
  const wrapped: SlackLogSink = {};
  for (const level of ["debug", "info", "warn", "error"] as const) {
    let sink: unknown;
    try {
      sink = logger[level];
    } catch {
      continue;
    }
    if (typeof sink !== "function" || nodeUtilTypes.isProxy(sink)) {
      continue;
    }
    wrapped[level] = (message, metadata) => {
      let safeMessage = REDACTION_FAILED;
      let safeMetadata: Record<string, unknown> | undefined;
      try {
        if (safeKnownSecrets === undefined) {
          safeMetadata = { redaction: REDACTION_FAILED };
        } else {
          safeMessage = redactSlackSecretText(message, safeKnownSecrets);
          safeMetadata = metadata === undefined
            ? undefined
            : sanitizeSlackLogRecord(metadata, safeKnownSecrets);
        }
      } catch {
        safeMetadata = { redaction: REDACTION_FAILED };
      }
      try {
        const outcome: unknown = Reflect.apply(sink, logger, [safeMessage, safeMetadata]);
        consumeRejectedPromise(outcome);
      } catch {
        // Logging is diagnostic and cannot stop reconnect recovery or a turn.
      }
    };
  }
  return wrapped;
}

function sanitizeSlackLogRecord(
  record: Record<string, unknown>,
  knownSecrets: readonly string[],
): Record<string, unknown> {
  const context: SlackLogSanitizeContext = {
    ancestors: new WeakSet<object>(),
    seen: new WeakSet<object>(),
    remainingNodes: MAX_LOG_NODES,
    remainingProperties: MAX_LOG_PROPERTIES,
    remainingArrayEntries: MAX_LOG_ARRAY_ENTRIES,
    remainingOutputChars: MAX_LOG_OUTPUT_CHARS,
    fragmentBuffer: "",
    fragmentedCredential: false,
  };
  const sanitized = sanitizeSlackLogValue(record, knownSecrets, context, 0);
  if (context.fragmentedCredential) {
    const scrubbed = scrubFragmentedSlackLogValue(sanitized);
    return isRecord(scrubbed) ? scrubbed : { value: scrubbed };
  }
  return isRecord(sanitized) ? sanitized : { value: sanitized };
}

interface SlackLogSanitizeContext {
  readonly ancestors: WeakSet<object>;
  readonly seen: WeakSet<object>;
  remainingNodes: number;
  remainingProperties: number;
  remainingArrayEntries: number;
  remainingOutputChars: number;
  fragmentBuffer: string;
  fragmentedCredential: boolean;
}

function sanitizeSlackLogValue(
  value: unknown,
  knownSecrets: readonly string[],
  context: SlackLogSanitizeContext,
  depth: number,
  container?: "headers" | "query",
): unknown {
  if (typeof value === "string") {
    if (container !== undefined) return REDACTED_BEARER;
    return sanitizeSlackLogText(value, knownSecrets, context);
  }
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return "[Symbol]";
  if (typeof value === "bigint") return "[BigInt]";
  if (
    typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= 0x7f
  ) {
    observeSlackLogFragment(String.fromCharCode(value), knownSecrets, context);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (nodeUtilTypes.isProxy(value)) {
    return REDACTION_FAILED;
  }
  if (depth >= MAX_LOG_DEPTH || context.remainingNodes <= 0) {
    return Array.isArray(value) ? [REDACTION_LIMIT] : truncatedSlackLogRecord();
  }
  if (context.ancestors.has(value)) {
    return "[Circular]";
  }
  if (context.seen.has(value)) {
    return REPEATED_REFERENCE;
  }
  context.remainingNodes -= 1;
  context.seen.add(value);
  context.ancestors.add(value);
  try {
    const boxedString = safeBoxedStringValue(value);
    if (boxedString !== undefined) {
      return container === undefined
        ? sanitizeSlackLogText(boxedString, knownSecrets, context)
        : REDACTED_BEARER;
    }
    if (safeArrayBufferIsView(value)) {
      return OMITTED_BINARY_DATA;
    }
    const href = safeUrlHref(value);
    if (href !== undefined) {
      if (container !== undefined) return REDACTED_BEARER;
      return sanitizeSlackLogText(href, knownSecrets, context);
    }
    if (Array.isArray(value)) {
      return sanitizeSlackLogArray(value, knownSecrets, context, depth, container);
    }

    const safe = Object.create(null) as Record<string, unknown>;
    copySafeOwnProperties(value, safe, knownSecrets, context, depth, container);
    return safe;
  } catch {
    return REDACTION_FAILED;
  } finally {
    context.ancestors.delete(value);
  }
}

function sensitiveLogKey(key: string): boolean {
  const normalized = normalizeLogKey(key);
  const parts = normalized.split("-").filter(Boolean);
  if (parts.some((part) => (
    SENSITIVE_KEY_PARTS.has(part)
    || (part.endsWith("s") && SENSITIVE_KEY_PARTS.has(part.slice(0, -1)))
  ))) return true;
  if (normalized === "code") return true;
  const compact = parts.join("");
  return SENSITIVE_COMPACT_KEYS.has(compact)
    || (compact.endsWith("s") && SENSITIVE_COMPACT_KEYS.has(compact.slice(0, -1)));
}

function logContainer(key: string): "headers" | "query" | undefined {
  const normalized = normalizeLogKey(key).replace(/[-_]/gu, "");
  if (
    normalized === "header"
    || normalized.endsWith("headers")
    || normalized.endsWith("headerpairs")
    || normalized.endsWith("headerspairs")
    || normalized.endsWith("headermap")
    || normalized.endsWith("headersmap")
    || normalized.endsWith("headerlist")
    || normalized.endsWith("headerslist")
  ) {
    return "headers";
  }
  if (
    normalized === "query"
    || normalized === "params"
    || normalized.endsWith("query")
    || normalized.endsWith("queryparams")
    || normalized.endsWith("searchparams")
    || normalized.endsWith("querystring")
    || normalized.endsWith("querymap")
    || normalized.endsWith("queryparamsmap")
    || normalized.endsWith("searchparamsmap")
    || normalized.endsWith("paramsmap")
    || normalized.endsWith("querypairs")
    || normalized.endsWith("querylist")
    || normalized.endsWith("queryparampairs")
    || normalized.endsWith("queryparamslist")
    || normalized.endsWith("searchparampairs")
    || normalized.endsWith("searchparamslist")
    || normalized.endsWith("parampairs")
    || normalized.endsWith("paramslist")
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
  context: SlackLogSanitizeContext,
  depth: number,
  container?: "headers" | "query",
): void {
  // ECMAScript exposes own keys only as one materialized list. This unavoidable
  // native reflection pass scales with the raw key count; every descriptor read,
  // recursive visit, and emitted value after it is bounded by the counters below.
  const propertyNames = Object.getOwnPropertyNames(value);
  const available = Math.min(
    MAX_LOG_PROPERTIES_PER_OBJECT,
    context.remainingProperties,
  );
  const selectedNames: string[] = [];
  for (const key of propertyNames) {
    selectedNames.push(key);
    if (selectedNames.length > available) {
      setSafeProperty(target, REDACTION_LIMIT, REDACTION_LIMIT);
      return;
    }
  }
  if (selectedNames.some((key) => key.length > MAX_LOG_TEXT_CHARS)) {
    setSafeProperty(target, REDACTION_LIMIT, REDACTION_LIMIT);
    return;
  }
  if (hasCanonicalNumericProperty(selectedNames)) {
    setSafeProperty(target, "value", OMITTED_BINARY_DATA);
    return;
  }
  for (const key of selectedNames) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    context.remainingProperties -= 1;
    const safeKey = sanitizeSlackLogText(key, knownSecrets, context, false);
    const childContainer = logContainer(key);
    if (container !== undefined || sensitiveLogKey(key)) {
      setSafeProperty(target, safeKey, REDACTED_BEARER);
    } else if (!("value" in descriptor)) {
      setSafeProperty(target, safeKey, "[Accessor]");
    } else {
      setSafeProperty(target, safeKey, sanitizeSlackLogValue(
        descriptor.value,
        knownSecrets,
        context,
        depth + 1,
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
  const property = readSafeSlackDataProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function sanitizeSlackLogText(
  text: string,
  knownSecrets: readonly string[],
  context: SlackLogSanitizeContext,
  trackFragment = true,
): string {
  if (trackFragment) observeSlackLogFragment(text, knownSecrets, context);
  if (text.length > context.remainingOutputChars) return REDACTION_LIMIT;
  const safe = redactSlackSecretText(text, knownSecrets);
  if (safe === REDACTION_LIMIT || safe.length > context.remainingOutputChars) {
    return REDACTION_LIMIT;
  }
  context.remainingOutputChars -= safe.length;
  return safe;
}

function observeSlackLogFragment(
  text: string,
  knownSecrets: readonly string[],
  context: SlackLogSanitizeContext,
): void {
  if (context.fragmentedCredential || text.length === 0) return;
  if (text.length > MAX_LOG_TEXT_CHARS) {
    context.fragmentBuffer = "";
    return;
  }
  const safeText = redactSlackSecretText(text, knownSecrets);
  if (safeText === REDACTION_LIMIT || safeText === REDACTION_FAILED) {
    context.fragmentBuffer = "";
    return;
  }
  let survivingSegments = [safeText];
  for (const marker of REDACTION_BOUNDARY_MARKERS) {
    survivingSegments = survivingSegments.flatMap((segment) => segment.split(marker));
  }
  const prefix = survivingSegments[0] ?? "";
  const combined = `${context.fragmentBuffer}${prefix}`.slice(-MAX_LOG_TEXT_CHARS);
  if (
    context.fragmentBuffer.length > 0
    && prefix.length > 0
    && redactSlackSecretText(combined, knownSecrets) !== combined
  ) {
    context.fragmentedCredential = true;
    context.fragmentBuffer = "";
    return;
  }
  context.fragmentBuffer = survivingSegments.length === 1
    ? combined
    : (survivingSegments.at(-1) ?? "").slice(-MAX_LOG_TEXT_CHARS);
}

function hasCanonicalNumericProperty(propertyNames: readonly string[]): boolean {
  return propertyNames.some((key) => /^(?:0|[1-9]\d*)$/u.test(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A credential assembled across multiple metadata values makes every ordinary
 * string in that record unsafe. Preserve the already-sanitized structure and
 * diagnostic placeholders while replacing all remaining text.
 */
function scrubFragmentedSlackLogValue(value: unknown): unknown {
  if (typeof value === "string") {
    return PRESERVED_SLACK_LOG_MARKERS.has(value)
      ? value
      : REDACTED_FRAGMENTED_CREDENTIAL;
  }
  if (Array.isArray(value)) {
    const safe: unknown[] = [];
    safe.length = value.length;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor !== undefined && "value" in descriptor) {
        safe[index] = scrubFragmentedSlackLogValue(descriptor.value);
      }
    }
    return safe;
  }
  if (!isRecord(value)) return value;

  const safe = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      setSafeProperty(safe, key, scrubFragmentedSlackLogValue(descriptor.value));
    }
  }
  return safe;
}

function truncatedSlackLogRecord(): Record<string, unknown> {
  const safe = Object.create(null) as Record<string, unknown>;
  setSafeProperty(safe, REDACTION_LIMIT, REDACTION_LIMIT);
  return safe;
}

function snapshotKnownSecrets(knownSecrets: readonly string[]): readonly string[] | undefined {
  try {
    if (nodeUtilTypes.isProxy(knownSecrets)) return undefined;
    const unique = new Set<string>();
    for (const secret of knownSecrets) {
      if (typeof secret !== "string") continue;
      const normalized = secret.trim();
      if (normalized.length > 0) unique.add(normalized);
    }
    return [...unique].sort((left, right) => right.length - left.length);
  } catch {
    return undefined;
  }
}

function consumeRejectedPromise(value: unknown): void {
  if (!nodeUtilTypes.isPromise(value)) return;
  try {
    Reflect.apply(PROMISE_THEN, value, [undefined, () => undefined]);
  } catch {
    // Logging is diagnostic and cannot stop reconnect recovery or a turn.
  }
}

function safeUrlHref(value: object): string | undefined {
  if (URL_HREF_GETTER === undefined) return undefined;
  try {
    const href: unknown = Reflect.apply(URL_HREF_GETTER, value, []);
    return typeof href === "string" ? href : undefined;
  } catch {
    return undefined;
  }
}

function redactSensitiveQueryParameter(
  match: string,
  separator: string,
  encodedKey: string,
): string {
  let key = encodedKey;
  try {
    key = decodeURIComponent(encodedKey.replace(/\+/gu, " "));
  } catch {
    return encodedKey.includes("%")
      ? `${separator}${encodedKey}=${REDACTED_BEARER}`
      : match;
  }
  return sensitiveLogKey(key)
    ? `${separator}${encodedKey}=${REDACTED_BEARER}`
    : match;
}

function sanitizeSlackLogArray(
  value: readonly unknown[],
  knownSecrets: readonly string[],
  context: SlackLogSanitizeContext,
  depth: number,
  container?: "headers" | "query",
): unknown[] {
  const length = safeArrayLength(value);
  if (
    length > MAX_LOG_ARRAY_LENGTH
    || length > context.remainingArrayEntries
  ) {
    context.remainingArrayEntries = 0;
    return [REDACTION_LIMIT];
  }
  context.remainingArrayEntries -= length;
  const fragmented = fragmentedArrayText(value, length);
  if (fragmented === REDACTION_LIMIT) return [REDACTION_LIMIT];
  if (
    fragmented !== undefined
    && redactSlackSecretText(fragmented, knownSecrets) !== fragmented
  ) {
    return [REDACTED_FRAGMENTED_CREDENTIAL];
  }

  const first = arrayDataString(value, 0);
  if (container !== undefined) {
    return sanitizeSecretContainerArray(value, length, knownSecrets, context, depth, container);
  }
  if (container === undefined && first !== undefined && sensitiveLogKey(first)) {
    return [sanitizeSlackLogText(first, knownSecrets, context), REDACTED_BEARER];
  }

  const safe: unknown[] = [];
  safe.length = length;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) {
      safe[index] = "[Accessor]";
      continue;
    }
    const entry = descriptor.value as unknown;
    safe[index] = sanitizeSlackLogValue(entry, knownSecrets, context, depth + 1);
  }
  return safe;
}

function sanitizeSecretContainerArray(
  value: readonly unknown[],
  length: number,
  knownSecrets: readonly string[],
  context: SlackLogSanitizeContext,
  depth: number,
  container: "headers" | "query",
): unknown[] {
  const safe: unknown[] = [];
  safe.length = length;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) {
      safe[index] = "[Accessor]";
      continue;
    }
    const entry = descriptor.value as unknown;
    if (Array.isArray(entry)) {
      safe[index] = sanitizeSlackLogValue(entry, knownSecrets, context, depth + 1, container);
      continue;
    }
    safe[index] = REDACTED_BEARER;
  }
  return safe;
}

function safeArrayLength(value: readonly unknown[]): number {
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    descriptor === undefined
    || !("value" in descriptor)
    || typeof descriptor.value !== "number"
    || !Number.isSafeInteger(descriptor.value)
    || descriptor.value < 0
  ) {
    return 0;
  }
  return descriptor.value;
}

function arrayDataString(
  value: readonly unknown[],
  index: number,
): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  return descriptor !== undefined
    && "value" in descriptor
    && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function fragmentedArrayText(
  value: readonly unknown[],
  length: number,
): string | undefined {
  const state: FragmentCollectionState = {
    fragments: [],
    remainingEntries: MAX_LOG_ARRAY_ENTRIES,
    remainingChars: MAX_LOG_TEXT_CHARS,
    seen: new WeakSet<object>(),
    found: false,
    truncated: false,
  };
  collectArrayFragments(value, length, state);
  if (state.truncated) return REDACTION_LIMIT;
  return state.found ? state.fragments.join("") : undefined;
}

interface FragmentCollectionState {
  readonly fragments: string[];
  readonly seen: WeakSet<object>;
  remainingEntries: number;
  remainingChars: number;
  found: boolean;
  truncated: boolean;
}

function collectArrayFragments(
  value: readonly unknown[],
  length: number,
  state: FragmentCollectionState,
): void {
  if (state.truncated || state.seen.has(value)) return;
  if (
    length > MAX_LOG_ARRAY_LENGTH
    || length > state.remainingEntries
  ) {
    state.truncated = true;
    return;
  }
  state.seen.add(value);
  state.remainingEntries -= length;
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) continue;
    if (typeof descriptor.value === "string") {
      collectTextFragment(descriptor.value, state);
      continue;
    }
    if (
      typeof descriptor.value === "number"
      && Number.isInteger(descriptor.value)
      && descriptor.value >= 0
      && descriptor.value <= 0x7f
    ) {
      collectTextFragment(String.fromCharCode(descriptor.value), state);
      continue;
    }
    if (
      descriptor.value !== null
      && (typeof descriptor.value === "object" || typeof descriptor.value === "function")
      && nodeUtilTypes.isProxy(descriptor.value)
    ) {
      state.truncated = true;
      return;
    }
    if (Array.isArray(descriptor.value)) {
      collectArrayFragments(
        descriptor.value,
        safeArrayLength(descriptor.value),
        state,
      );
      continue;
    }
    if (descriptor.value !== null && typeof descriptor.value === "object") {
      const boxed = safeBoxedStringValue(descriptor.value);
      if (boxed !== undefined) collectTextFragment(boxed, state);
    }
  }
}

function collectTextFragment(text: string, state: FragmentCollectionState): void {
  if (state.truncated) return;
  if (text.length > state.remainingChars) {
    state.truncated = true;
    return;
  }
  state.remainingChars -= text.length;
  state.fragments.push(text);
  state.found = true;
}

function safeBoxedStringValue(value: object): string | undefined {
  try {
    const unboxed: unknown = Reflect.apply(STRING_VALUE_OF, value, []);
    return typeof unboxed === "string" ? unboxed : undefined;
  } catch {
    return undefined;
  }
}

function safeArrayBufferIsView(value: object): boolean {
  try {
    return Reflect.apply(ARRAY_BUFFER_IS_VIEW, ArrayBuffer, [value]) as boolean;
  } catch {
    return true;
  }
}
