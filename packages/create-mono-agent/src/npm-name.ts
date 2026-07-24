export interface NormalizeNpmNameOptions {
  readonly stripLeadingAt?: boolean;
}

export function assertNpmPackageName(
  value: string,
  createError: (message: string) => Error = (message) => new TypeError(message),
): void {
  if (
    value.length > 214
    || !/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u.test(value)
  ) {
    throw createError(`Invalid npm package name: ${JSON.stringify(value)}`);
  }
}

export function normalizeNpmName(
  value: string,
  options: NormalizeNpmNameOptions = {},
): string {
  const source = options.stripLeadingAt === true
    ? value.replace(/^@/u, "")
    : value;
  return source
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "");
}
