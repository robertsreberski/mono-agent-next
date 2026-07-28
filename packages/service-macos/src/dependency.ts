// SPDX-License-Identifier: MIT

const EXACT_DEPENDENCY_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const LOCAL_ARCHIVE_DEPENDENCY_PATTERN =
  /^file:(?:\.\/)?[0-9A-Za-z@._+-]+(?:\/[0-9A-Za-z@._+-]+)*\.tgz$/u;
const SHA512_INTEGRITY_PATTERN =
  /^sha512-[0-9A-Za-z+/]{85}[AQgw]==$/u;

export function isExactDependencyVersion(value: unknown): value is string {
  return typeof value === "string"
    && EXACT_DEPENDENCY_VERSION_PATTERN.test(value);
}

export function isLocalArchiveDependencySpec(
  value: unknown,
): value is string {
  return typeof value === "string"
    && value.length <= 512
    && value === value.trim()
    && LOCAL_ARCHIVE_DEPENDENCY_PATTERN.test(value)
    && canonicalLocalArchiveDependencySpec(value)
      .slice("file:".length, -".tgz".length)
      .split("/")
      .every((segment) => segment !== "." && segment !== "..");
}

export function canonicalLocalArchiveDependencySpec(value: string): string {
  return value.startsWith("file:./") ? `file:${value.slice(7)}` : value;
}

export function isCanonicalSha512Integrity(value: unknown): value is string {
  return typeof value === "string"
    && SHA512_INTEGRITY_PATTERN.test(value);
}
