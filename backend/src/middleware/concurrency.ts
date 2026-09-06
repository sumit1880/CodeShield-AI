import { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError, ErrorCode } from '../utils/errors';

/**
 * Simple in-process counter that rejects new analysis requests once `max`
 * are already in flight. Intentionally not backed by Redis/a queue: this
 * app is meant to run as a single free-tier instance, and an in-memory
 * counter is enough to stop a burst of concurrent requests from exhausting
 * the box's CPU/memory or the LLM providers' free quotas simultaneously.
 *
 * A queue with acquire/release semantics would let one instance serialize
 * requests instead of rejecting them; that's a reasonable enhancement if
 * this ever runs with more than one instance behind a load balancer.
 */
export function buildConcurrencyLimiter(max: number): RequestHandler {
  let active = 0;

  return function concurrencyLimiter(req: Request, res: Response, next: NextFunction) {
    if (active >= max) {
      return next(
        new ApiError(
          ErrorCode.SERVICE_BUSY,
          `Server is at capacity (${max} concurrent analyses in progress); please retry shortly`
        )
      );
    }

    active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
    };
    res.on('finish', release);
    res.on('close', release);

    next();
  };
}
