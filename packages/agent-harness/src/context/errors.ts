export type ContextValidationErrorCode =
  | 'empty_required_field'
  | 'invalid_context_block'
  | 'invalid_history'
  | 'invalid_json'
  | 'invalid_skill_index'
  | 'file_read_failed';

export interface ContextValidationErrorDetails {
  readonly [key: string]: unknown;
}

export class ContextValidationError extends Error {
  readonly code: ContextValidationErrorCode;
  readonly details: ContextValidationErrorDetails;

  constructor(
    code: ContextValidationErrorCode,
    message: string,
    details: ContextValidationErrorDetails = {},
  ) {
    super(message);
    this.name = 'ContextValidationError';
    this.code = code;
    this.details = { ...details, code };
  }
}
