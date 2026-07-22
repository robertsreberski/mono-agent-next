export class WebConsoleError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "WebConsoleError";
    this.code = code;
    this.status = status;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}
