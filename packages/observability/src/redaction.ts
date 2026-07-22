import { DEFAULT_MAX_STRING_BYTES } from "./guards.js";

/**
 * Node-free redaction + truncation helpers shared by the recorder and the
 * export-mapping surface. Non-numeric values under sensitive-looking object
 * keys collapse to `[redacted]`; free-text content is not scanned unless the
 * caller explicitly enables the closed high-confidence pattern scan. Circular
 * references collapse to `[circular]`, deeply nested values to `[max-depth]`,
 * and long strings are truncated by UTF-8 byte length. Kept import-free of
 * `node:*` (the prior `Buffer.byteLength` call is replaced with `TextEncoder`)
 * so the mapping module can stay browser-safe.
 */

const SENSITIVE_KEY_PATTERN =
  /(token|password|authorization|api[_-]?key|cookie|credentials?|private[_-]?key|client[_-]?secret|bearer|secret)/iu;

// This is intentionally a short, closed list of high-confidence credential
// shapes. Prefix-only matches (for example prose that mentions `sk-` or
// `ghp_`) are not enough: every pattern requires a credential-specific length
// and alphabet. Quantifiers are capped and avoid unbounded wildcard matching.
const CONTENT_SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{48}\b/gu,
  /\bsk-(?:proj-|svcacct-)[A-Za-z0-9_-]{47,511}[A-Za-z0-9]\b/gu,
  /\bghp_[A-Za-z0-9]{36}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{19,511}[A-Za-z0-9]\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{19,511}[A-Za-z0-9]\b/gu,
  /\bxapp-[A-Za-z0-9-]{19,511}[A-Za-z0-9]\b/gu,
] as const;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const TRUNCATION_SUFFIX_PATTERN = /…\[truncated ([1-9]\d*) bytes\]$/u;
const MAX_REDACTION_NODES = 10_000;
const MAX_ARRAY_ITEMS = 1_000;
const MAX_OBJECT_KEYS = 1_000;

export interface RedactJsonValueOptions {
  /**
   * Scan retained free-text content for high-confidence credential shapes.
   * Disabled by default to preserve existing prose exactly. Matches are
   * replaced before UTF-8 truncation so the emitted truncation marker describes
   * the redacted value. An existing canonical marker is preserved while its
   * retained head is scanned, keeping repeated export/backfill passes stable.
   */
  readonly contentPatternRedaction?: boolean;
}

export function redactJsonValue(
  value: unknown,
  maxStringBytes = DEFAULT_MAX_STRING_BYTES,
  options: RedactJsonValueOptions = {},
): unknown {
  return redact(
    value,
    maxStringBytes,
    options.contentPatternRedaction === true,
    0,
    undefined,
    new WeakSet<object>(),
    { remainingNodes: MAX_REDACTION_NODES },
  );
}

interface RedactionBudget {
  remainingNodes: number;
}

function redact(
  value: unknown,
  maxStringBytes: number,
  contentPatternRedaction: boolean,
  depth: number,
  key: string | undefined,
  seen: WeakSet<object>,
  budget: RedactionBudget,
): unknown {
  // Secrets (access tokens, API keys, passwords, cookies) are always strings, so a
  // numeric value under a "sensitive" key is a count/flag — e.g. `input_tokens`,
  // `output_tokens`, `cache_read_tokens` all match /token/ but carry token COUNTS
  // we want visible for cost observability. Only redact non-numeric matches.
  if (key !== undefined && SENSITIVE_KEY_PATTERN.test(key) && typeof value !== "number") {
    return "[redacted]";
  }
  if (!consumeNode(budget)) {
    return "[max-nodes]";
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return contentPatternRedaction
      ? redactStringContent(value, maxStringBytes)
      : truncateString(value, maxStringBytes);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (value instanceof Error) {
    return redact(errorToJson(value), maxStringBytes, contentPatternRedaction, depth + 1, key, seen, budget);
  }
  if (depth >= 12) {
    return "[max-depth]";
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const limit = Math.min(value.length, MAX_ARRAY_ITEMS);
    const out: unknown[] = [];
    for (let index = 0; index < limit; index += 1) {
      out.push(redact(value[index], maxStringBytes, contentPatternRedaction, depth + 1, undefined, seen, budget));
    }
    if (value.length > limit) {
      out.push("[max-items]");
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  const limit = Math.min(entries.length, MAX_OBJECT_KEYS);
  for (let index = 0; index < limit; index += 1) {
    const [entryKey, entryValue] = entries[index]!;
    out[entryKey] = redact(
      entryValue,
      maxStringBytes,
      contentPatternRedaction,
      depth + 1,
      entryKey,
      seen,
      budget,
    );
  }
  if (entries.length > limit) {
    out.__truncated__ = "[max-keys]";
  }
  return out;
}

function redactContentPatterns(value: string): string {
  let redacted = value;
  for (const pattern of CONTENT_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }
  return redacted;
}

function redactStringContent(value: string, maxStringBytes: number): string {
  const preserved = splitPreservableTruncation(value, maxStringBytes);
  if (preserved !== undefined) {
    return `${redactContentPatterns(preserved.head)}${preserved.marker}`;
  }
  return truncateString(redactContentPatterns(value), maxStringBytes);
}

function splitPreservableTruncation(
  value: string,
  maxStringBytes: number,
): { readonly head: string; readonly marker: string } | undefined {
  const match = TRUNCATION_SUFFIX_PATTERN.exec(value);
  if (match === null || match.index + match[0].length !== value.length) {
    return undefined;
  }
  const omittedBytes = Number(match[1]);
  const head = value.slice(0, match.index);
  const retainedBytes = TEXT_ENCODER.encode(head).length;
  const originalBytes = retainedBytes + omittedBytes;
  const strictCanonical =
    Number.isSafeInteger(originalBytes)
    && originalBytes > maxStringBytes
    && maxStringBytes - retainedBytes <= 3;
  const alreadyRedacted = head.includes("[redacted]");
  if (
    !Number.isSafeInteger(omittedBytes)
    || retainedBytes > maxStringBytes
    || (!strictCanonical && !alreadyRedacted)
  ) {
    return undefined;
  }
  return { head, marker: match[0] };
}

function consumeNode(budget: RedactionBudget): boolean {
  if (budget.remainingNodes <= 0) {
    return false;
  }
  budget.remainingNodes -= 1;
  return true;
}

export function truncateString(value: string, maxStringBytes: number): string {
  const encoded = TEXT_ENCODER.encode(value);
  if (encoded.length <= maxStringBytes) {
    return value;
  }
  // Recorder summaries can pass through another redaction/export boundary
  // during backfill. Preserve a marker we emitted previously instead of
  // replacing its original omitted-byte count with the marker's own size.
  // A canonical retained head ends at most three bytes below the cap because a
  // UTF-8 code point occupies at most four bytes.
  const existingMarker = TRUNCATION_SUFFIX_PATTERN.exec(value);
  if (existingMarker !== null) {
    const omittedBytes = Number(existingMarker[1]);
    const retainedBytes = TEXT_ENCODER.encode(value.slice(0, existingMarker.index)).length;
    const originalBytes = retainedBytes + omittedBytes;
    if (
      Number.isSafeInteger(omittedBytes)
      && Number.isSafeInteger(originalBytes)
      && existingMarker.index + existingMarker[0].length === value.length
      && retainedBytes <= maxStringBytes
      && maxStringBytes - retainedBytes <= 3
      && originalBytes > maxStringBytes
    ) {
      return value;
    }
  }
  // Cut on a UTF-8 boundary so the kept text never EXCEEDS the byte cap and never
  // splits a multi-byte code point. Slicing the string by `maxStringBytes` UTF-16
  // code units (the prior bug) could emit several bytes per unit. Walk back from
  // the byte cap past any continuation byte (0b10xxxxxx) to the start of its code point.
  let end = maxStringBytes;
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  const head = TEXT_DECODER.decode(encoded.subarray(0, end));
  return `${head}…[truncated ${encoded.length - end} bytes]`;
}

export function errorFailureKind(error: unknown): string {
  if (typeof error === "object" && error !== null && "failureKind" in error) {
    const failureKind = (error as { readonly failureKind?: unknown }).failureKind;
    if (typeof failureKind === "string" && failureKind.trim().length > 0) {
      return failureKind;
    }
  }
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  return "exception";
}

export function errorToJson(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return { message: String(error) };
}
