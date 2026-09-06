import crypto from 'crypto';
import { NextFunction, Request, RequestHandler, Response } from 'express';

export interface RequestWithId extends Request {
  requestId: string;
}

/**
 * Attaches a short request ID to every request (reusing an inbound
 * `X-Request-Id` if a trusted proxy/client already set one), and echoes it
 * back in the response headers. pino-http already logs per-request, but a
 * stable ID lets a single analysis be traced across the
 * "request started" / "analysis started" / "provider X" / "analysis
 * completed" log lines emitted from different modules.
 */
export const requestId: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : crypto.randomUUID();
  (req as RequestWithId).requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
};
