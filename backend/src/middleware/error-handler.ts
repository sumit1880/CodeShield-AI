import { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { ApiError, ErrorCode } from '../utils/errors';
import { logger } from '../utils/logger';

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const apiErr = new ApiError(ErrorCode.ZIP_TOO_LARGE, 'Uploaded ZIP exceeds the maximum allowed size');
      return res.status(apiErr.statusCode).json(apiErr.toJSON());
    }
    const apiErr = new ApiError(ErrorCode.INVALID_REQUEST, `Upload error: ${err.message}`);
    return res.status(apiErr.statusCode).json(apiErr.toJSON());
  }

  if (err instanceof ApiError) {
    if (err.statusCode >= 500) {
      logger.error({ err }, 'Request failed with server error');
    }
    return res.status(err.statusCode).json(err.toJSON());
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      error: {
        code: ErrorCode.INVALID_REQUEST,
        message: 'Request validation failed',
        details: err.flatten()
      }
    });
  }

  logger.error({ err }, 'Unhandled error');
  return res.status(500).json({
    success: false,
    error: { code: ErrorCode.INTERNAL_ERROR, message: 'An unexpected error occurred' }
  });
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    success: false,
    error: { code: ErrorCode.INVALID_REQUEST, message: `Route not found: ${req.method} ${req.path}` }
  });
}
