export type A2AProviderErrorCode =
  | "idempotency_store_error"
  | "invalid_config"
  | "invalid_idempotency_key"
  | "missing_required_config"
  | "start_failed"
  | "unsupported_input"
  | "unsafe_host";

export interface A2AProviderErrorDetails {
  readonly code?: A2AProviderErrorCode;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class A2AProviderError extends Error {
  readonly code: A2AProviderErrorCode;
  readonly details: A2AProviderErrorDetails;

  constructor(
    code: A2AProviderErrorCode,
    message: string,
    details: A2AProviderErrorDetails = {},
  ) {
    super(message);
    this.name = "A2AProviderError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export type A2AConsumerErrorCode =
  | "discovery_failed"
  | "empty_a2a_response"
  | "idempotency_conflict"
  | "idempotency_capacity_exhausted"
  | "idempotency_in_doubt"
  | "idempotency_result_expired"
  | "idempotency_unsupported"
  | "invalid_agent_card"
  | "invalid_idempotency_key"
  | "remote_auth_required"
  | "remote_canceled"
  | "remote_failed"
  | "remote_input_required"
  | "remote_rejected"
  | "send_failed"
  | "timeout";

export interface A2AConsumerErrorDetails {
  readonly code?: A2AConsumerErrorCode;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class A2AConsumerError extends Error {
  readonly code: A2AConsumerErrorCode;
  readonly details: A2AConsumerErrorDetails;

  constructor(
    code: A2AConsumerErrorCode,
    message: string,
    details: A2AConsumerErrorDetails = {},
  ) {
    super(message);
    this.name = "A2AConsumerError";
    this.code = code;
    this.details = { ...details, code };
  }
}
