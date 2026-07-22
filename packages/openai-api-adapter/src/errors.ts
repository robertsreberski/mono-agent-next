import { CodedError } from "@mono-agent/agent-contracts";

export type OpenAIApiAdapterErrorCode =
  | "invalid_config"
  | "invalid_request"
  | "missing_required_config"
  | "unsafe_host"
  | "start_failed";

export interface OpenAIApiAdapterErrorDetails {
  readonly code?: OpenAIApiAdapterErrorCode;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class OpenAIApiAdapterError extends CodedError<OpenAIApiAdapterErrorCode> {
  declare readonly details: OpenAIApiAdapterErrorDetails;

  constructor(
    code: OpenAIApiAdapterErrorCode,
    message: string,
    details: OpenAIApiAdapterErrorDetails = {},
  ) {
    super(code, message, details);
  }
}
