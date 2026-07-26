// SPDX-License-Identifier: MIT
import {
  RUNTIME_SESSION_UNAVAILABLE_CODE,
  RuntimeTurnError,
} from "@mono-agent/module-sdk";

import { redactRuntimePiText } from "./credentials.js";

export class RuntimePiError extends RuntimeTurnError {
  declare readonly code:
    | "RUNTIME_NOT_RUNNING"
    | "MODEL_INVALID"
    | "PROCESS_TERMINATION_FAILED"
    | "PROVIDER_FAILED"
    | "SESSION_INVALID"
    | typeof RUNTIME_SESSION_UNAVAILABLE_CODE
    | "UNSUPPORTED";
  readonly committedSideEffects: boolean;
  readonly retryable: boolean;

  constructor(
    code: RuntimePiError["code"],
    message: string,
    options: {
      readonly committedSideEffects?: boolean;
      readonly retryable?: boolean;
      readonly cause?: unknown;
      readonly secrets?: readonly string[];
    } = {},
  ) {
    const retryable = options.retryable ?? false;
    const committedSideEffects = options.committedSideEffects ?? false;
    const safeCause = options.cause === undefined
      ? undefined
      : Object.freeze(Object.assign(
        new Error(redactRuntimePiText(options.cause, options.secrets ?? [])),
        { name: "RuntimePiCause" },
      ));
    super({
      code,
      message,
      retryability: retryable ? "retryable" : "not-retryable",
      sideEffects: committedSideEffects ? "committed" : "none",
      ...(safeCause === undefined ? {} : { cause: safeCause }),
    });
    this.name = "RuntimePiError";
    this.committedSideEffects = committedSideEffects;
    this.retryable = retryable;
  }
}

export function withCommittedEffects(
  error: RuntimePiError,
  committedSideEffects: boolean,
): RuntimePiError {
  if (!committedSideEffects || error.committedSideEffects) return error;
  return new RuntimePiError(error.code, error.message, {
    committedSideEffects: true,
    retryable: error.retryable,
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  });
}
