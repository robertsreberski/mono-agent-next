/**
 * Shared base for the workspace's typed errors. The repo had ~30 error classes
 * in five mutually incompatible shapes; this base captures the reference shape
 * (a `code` discriminant plus a `details` object that always echoes the code and
 * preserves `this.name`) so packages can converge incrementally without changing
 * their runtime field layout.
 */
export class CodedError<Code extends string = string> extends Error {
  readonly code: Code;
  readonly details: Record<string, unknown>;

  constructor(
    code: Code,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    // The most-derived subclass name, so subclasses keep their own `name`
    // without re-assigning it.
    this.name = new.target.name;
    this.code = code;
    this.details = { ...details, code };
  }
}

/**
 * Structural guard for coded errors. Matches both {@link CodedError} instances
 * and legacy errors that already carry a string `code`, so callers can stop
 * string-matching `.message` while classes migrate onto the base incrementally.
 */
export function isCodedError<Code extends string = string>(
  error: unknown,
  code?: Code,
): error is CodedError<Code> {
  if (!(error instanceof Error)) {
    return false;
  }
  const candidate = error as { code?: unknown };
  if (typeof candidate.code !== "string") {
    return false;
  }
  return code === undefined || candidate.code === code;
}
