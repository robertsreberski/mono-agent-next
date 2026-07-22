import { resolve } from 'node:path';

import { ContextValidationError } from './errors.js';

export function resolveRequiredPath(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContextValidationError('file_read_failed', `${field} must be a non-empty path.`, {
      field,
    });
  }
  return resolve(value);
}

export function fileReadError(message: string, filePath: string, error: unknown): ContextValidationError {
  return new ContextValidationError('file_read_failed', message, {
    path: filePath,
    cause: error instanceof Error ? error.message : String(error),
  });
}
