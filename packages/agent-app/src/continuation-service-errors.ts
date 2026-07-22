export class ContinuationSynthesisUnavailableError extends Error {
  readonly code: string;
  readonly retryAfterMs: number | undefined;

  constructor(code: string, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ContinuationSynthesisUnavailableError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export class ContinuationServiceStoppingError extends Error {
  constructor() {
    super("Continuation service is stopping.");
    this.name = "ContinuationServiceStoppingError";
  }
}

export class ContinuationOperationTimeoutError extends Error {
  constructor(readonly phase: "synthesis" | "delivery", timeoutMs: number) {
    super(`Continuation ${phase} exceeded its ${String(timeoutMs)}ms timeout.`);
    this.name = "ContinuationOperationTimeoutError";
  }
}

export class ContinuationProtocolError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ContinuationProtocolError";
    this.status = status;
    this.code = code;
  }
}
