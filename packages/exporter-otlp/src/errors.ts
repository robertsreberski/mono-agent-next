export type OtlpExporterErrorCode =
  | "OTLP_ABORTED"
  | "OTLP_CLOSED"
  | "OTLP_CONFIG_INVALID"
  | "OTLP_FLUSH_FAILED"
  | "OTLP_HTTP_FAILED"
  | "OTLP_REDIRECT_REJECTED"
  | "OTLP_TIMEOUT";

export class OtlpExporterError extends Error {
  readonly code: OtlpExporterErrorCode;

  constructor(code: OtlpExporterErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OtlpExporterError";
    this.code = code;
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new OtlpExporterError("OTLP_ABORTED", "The OTLP operation was aborted.");
  }
}
