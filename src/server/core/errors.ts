export type ErrorType =
  | 'AUTO_FIXABLE'
  | 'USER_CORRECTABLE'
  | 'USER_CONFIRMATION_REQUIRED'
  | 'CONFLICT'
  | 'RETRYABLE_SYSTEM_ERROR'
  | 'FATAL_SYSTEM_ERROR';

export class CommandError extends Error {
  constructor(
    public type: ErrorType,
    public code: string,
    message: string,
    public retryable = false,
    public details?: Record<string, unknown>
  ) { super(message); }
}
