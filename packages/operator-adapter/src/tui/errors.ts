import { CodedError } from "@mono-agent/agent-contracts";

export type TuiAdapterErrorCode =
  | "invalid_config"
  | "invalid_request"
  | "missing_required_config"
  | "unsafe_host"
  | "start_failed";

export interface TuiAdapterErrorDetails {
  readonly code?: TuiAdapterErrorCode;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class TuiAdapterError extends CodedError<TuiAdapterErrorCode> {
  declare readonly details: TuiAdapterErrorDetails;

  constructor(
    code: TuiAdapterErrorCode,
    message: string,
    details: TuiAdapterErrorDetails = {},
  ) {
    super(code, message, details);
  }
}
