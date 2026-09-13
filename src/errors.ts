export const errorCodes = [
  'CAPABILITY_DISABLED',
  'PATH_NOT_ALLOWED',
  'COMMAND_NOT_ALLOWED',
  'INVALID_INPUT',
  'NOT_FOUND',
  'TIMEOUT',
  'OUTPUT_LIMIT',
  'OVERLOADED',
  'CANCELLED',
  'OS_ERROR',
  'CONFLICT',
  'OUTCOME_UNKNOWN',
] as const;

export type ComputerAdapterErrorCode = (typeof errorCodes)[number];

export interface ComputerAdapterError {
  code: ComputerAdapterErrorCode;
  message: string;
  operation: string;
  details?: Record<string, unknown>;
}

export function adapterError(
  code: ComputerAdapterErrorCode,
  operation: string,
  message: string,
  details?: Record<string, unknown>,
): ComputerAdapterError {
  return details === undefined ? { code, operation, message } : { code, operation, message, details };
}

export function isComputerAdapterError(value: unknown): value is ComputerAdapterError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.code === 'string' &&
    (errorCodes as readonly string[]).includes(candidate.code) &&
    typeof candidate.message === 'string' &&
    typeof candidate.operation === 'string' &&
    (candidate.details === undefined || (typeof candidate.details === 'object' && candidate.details !== null))
  );
}
