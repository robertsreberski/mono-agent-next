export interface RedactSecretsOptions {
  readonly fallback: string;
  readonly secrets?: Iterable<string>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly maxChars?: number;
}

const SENSITIVE_ENV_NAME = /(api.?key|credential|password|secret|token)/iu;
export const REDACTED_DIAGNOSTIC_MAX_CHARS = 400;

export function isSensitiveEnvironmentName(name: string): boolean {
  return SENSITIVE_ENV_NAME.test(name);
}

/**
 * Produce one bounded, single-line diagnostic with explicit, environment,
 * and common inline credential forms scrubbed. Environment values are scrubbed
 * once they are distinctive enough to avoid erasing ordinary one-character text.
 */
export function redactSecrets(value: unknown, options: RedactSecretsOptions): string {
  const maxChars = options.maxChars ?? REDACTED_DIAGNOSTIC_MAX_CHARS;
  if (!Number.isSafeInteger(maxChars) || maxChars < 2) {
    throw new Error("Secret-redaction maxChars must be a safe integer of at least 2.");
  }

  let message = diagnosticMessage(value, options.fallback);

  const secrets = new Set<string>();
  for (const secret of options.secrets ?? []) {
    if (secret.length > 0) secrets.add(secret);
  }
  for (const [name, environmentValue] of Object.entries(options.environment ?? {})) {
    if (typeof environmentValue === "string"
      && environmentValue.length > 0
      && (environmentValue.length >= 4 || isSensitiveEnvironmentName(name))) {
      secrets.add(environmentValue);
    }
  }
  const scrub = (input: string): string => {
    let scrubbed = input;
    for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
      scrubbed = scrubbed.replaceAll(secret, "[REDACTED]");
    }
    return scrubbed
      .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
      .replace(/\b(Authorization\s*:\s*)Basic\s+[^\s,;]+/giu, "$1Basic [REDACTED]")
      .replace(
        /\b(api[ _-]?key|(?:access|auth|refresh|session)[ _-]?token|authorization|client[ _-]?secret|password|secret|token)(["']?\s*[=:]\s*["']?)(?!\[REDACTED\])([^\s,;}\]"']+)/giu,
        (_match, label: string, separator: string) => `${label}${separator}[REDACTED]`,
      )
      .replace(
        /([a-z][a-z0-9+.-]*:\/\/)([^/\s]+)@/giu,
        "$1[REDACTED]@",
      )
      .replace(/(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/=-]{24,}(?![A-Za-z0-9_+/=-])/gu, "[REDACTED]")
      .replace(/\s+/gu, " ")
      .trim();
  };

  message = scrub(message);
  if (message.length === 0) message = scrub(options.fallback);
  if (message.length === 0) message = "Diagnostic unavailable.";
  return message.length > maxChars
    ? `${message.slice(0, maxChars - 1)}…`
    : message;
}

function diagnosticMessage(value: unknown, fallback: string): string {
  try {
    if (typeof value === "string") return value;
    if (!(value instanceof Error)) return fallback;
    const message = value.message;
    return typeof message === "string" ? message : fallback;
  } catch { return fallback; }
}
