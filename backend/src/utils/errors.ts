export const ErrorCode = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  EMPTY_CODE: 'EMPTY_CODE',
  UNSUPPORTED_LANGUAGE: 'UNSUPPORTED_LANGUAGE',
  CODE_TOO_LARGE: 'CODE_TOO_LARGE',
  ZIP_TOO_LARGE: 'ZIP_TOO_LARGE',
  ARCHIVE_TOO_LARGE: 'ARCHIVE_TOO_LARGE',
  TOO_MANY_FILES: 'TOO_MANY_FILES',
  UNSAFE_ARCHIVE: 'UNSAFE_ARCHIVE',
  SEMGREP_NOT_INSTALLED: 'SEMGREP_NOT_INSTALLED',
  SEMGREP_ERROR: 'SEMGREP_ERROR',
  AI_RATE_LIMIT: 'AI_RATE_LIMIT',
  AI_TIMEOUT: 'AI_TIMEOUT',
  AI_PROVIDER_ERROR: 'AI_PROVIDER_ERROR',
  INVALID_AI_RESPONSE: 'INVALID_AI_RESPONSE',
  DATABASE_ERROR: 'DATABASE_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_BUSY: 'SERVICE_BUSY',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

const STATUS_BY_CODE: Record<ErrorCodeType, number> = {
  INVALID_REQUEST: 400,
  EMPTY_CODE: 400,
  UNSUPPORTED_LANGUAGE: 400,
  CODE_TOO_LARGE: 413,
  ZIP_TOO_LARGE: 413,
  ARCHIVE_TOO_LARGE: 413,
  TOO_MANY_FILES: 413,
  UNSAFE_ARCHIVE: 400,
  SEMGREP_NOT_INSTALLED: 500,
  SEMGREP_ERROR: 502,
  AI_RATE_LIMIT: 429,
  AI_TIMEOUT: 504,
  AI_PROVIDER_ERROR: 502,
  INVALID_AI_RESPONSE: 502,
  DATABASE_ERROR: 500,
  UNAUTHORIZED: 401,
  RATE_LIMITED: 429,
  SERVICE_BUSY: 503,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500
};

export class ApiError extends Error {
  public readonly code: ErrorCodeType;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(code: ErrorCodeType, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = details;
  }

  toJSON() {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {})
      }
    };
  }
}
