export type MemoryLocalErrorCode =
  | "unsafe_store"
  | "incomplete_initialization"
  | "corrupt_store"
  | "invalid_record"
  | "duplicate_record"
  | "capacity_exceeded"
  | "writer_active"
  | "embedding_unavailable"
  | "maintenance_failed"
  | "runtime_capture_unavailable"
  | "runtime_capture_invalid"
  | "closed";

export class MemoryLocalError extends Error {
  constructor(
    readonly code: MemoryLocalErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MemoryLocalError";
  }
}
