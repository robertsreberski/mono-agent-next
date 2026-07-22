export type StateLocalErrorCode =
  | "STATE_ABORTED"
  | "STATE_ALREADY_OPEN"
  | "STATE_CLOSED"
  | "STATE_CORRUPT"
  | "STATE_INVALID_CONFIG"
  | "STATE_INVALID_CURSOR"
  | "STATE_INVALID_KEY"
  | "STATE_LIMIT_EXCEEDED"
  | "STATE_PATH_CHANGED"
  | "STATE_PATH_INSECURE"
  | "STATE_POISONED"
  | "STATE_VERSION_MISMATCH";

export class StateLocalError extends Error {
  readonly code: StateLocalErrorCode;

  constructor(code: StateLocalErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StateLocalError";
    this.code = code;
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new StateLocalError("STATE_ABORTED", "The state operation was aborted.", signal.reason);
  }
}
