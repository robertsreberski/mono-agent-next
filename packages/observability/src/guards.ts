/**
 * Node-free validation/guard helpers and shared limit constants for the
 * observability artifact store. Kept import-free of `node:*` so that the
 * export-mapping surface (and any browser-safe subpath) can reuse them without
 * pulling node:fs/node:path into the graph. The filesystem helpers that DO need
 * node remain in {@link ./artifact-fs.ts}, which re-exports these for existing
 * importers.
 */

export const DEFAULT_MAX_RUNS = 50;
export const DEFAULT_MAX_EVENTS_PER_RUN = 500;
export const DEFAULT_MAX_STRING_BYTES = 4_096;

/** Thrown to abort with a caller-supplied, code-tagged error. */
export type Raise = (message: string) => never;

/** Variant that also forwards the offending field name into the error details. */
export type RaiseField = (message: string, field: string) => never;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function positiveInteger(value: number | undefined, fallback: number, field: string, raise: RaiseField): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1) {
    raise(`${field} must be a positive integer.`, field);
  }
  return value;
}

export function minInteger(value: number | undefined, fallback: number, min: number, field: string, raise: RaiseField): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < min) {
    raise(`${field} must be an integer of at least ${min}.`, field);
  }
  return value;
}
