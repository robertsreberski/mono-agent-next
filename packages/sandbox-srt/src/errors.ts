// SPDX-License-Identifier: MIT
export type SandboxSrtErrorCode =
  | "invalid_config"
  | "invalid_command"
  | "sandbox_unavailable"
  | "output_limit_exceeded"
  | "execution_failed"
  | "closed";

export class SandboxSrtError extends Error {
  readonly code: SandboxSrtErrorCode;

  constructor(code: SandboxSrtErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxSrtError";
    this.code = code;
  }
}
