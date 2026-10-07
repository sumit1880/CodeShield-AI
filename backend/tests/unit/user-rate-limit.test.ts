import { buildUserRateLimiter } from '../../src/middleware/user-rate-limit';
import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../src/middleware/google-auth.middleware';

function mockContext(userId?: string, ip: string = '127.0.0.1') {
  const req = {
    ip,
    headers: {},
    user: userId ? { id: userId, email: `${userId}@example.com` } : undefined
  } as unknown as AuthenticatedRequest;

  let statusCode = 200;
  let responseData: any = null;
  const headers: Record<string, string> = {};

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    getHeader(name: string) {
      return headers[name];
    },
    send(data: any) {
      responseData = data;
      return this;
    },
    json(data: any) {
      responseData = data;
      return this;
    },
    getStatusCode() {
      return statusCode;
    },
    getBody() {
      return responseData;
    }
  } as unknown as Response & { getStatusCode: () => number; getBody: () => any };

  const next: NextFunction & { calls: Array<unknown> } = Object.assign(
    (arg?: unknown) => {
      next.calls.push(arg);
    },
    { calls: [] as Array<unknown> }
  );

  return { req, res, next };
}

describe('buildUserRateLimiter', () => {
  it('allows requests within max limit and blocks exceeding requests for a given user', async () => {
    const limiter = buildUserRateLimiter({ windowMs: 60000, maxRequests: 2 });

    const ctx1 = mockContext('user-1');
    await (limiter as any)(ctx1.req, ctx1.res, ctx1.next);
    expect(ctx1.next.calls).toHaveLength(1);
    expect(ctx1.next.calls[0]).toBeUndefined();

    const ctx2 = mockContext('user-1');
    await (limiter as any)(ctx2.req, ctx2.res, ctx2.next);
    expect(ctx2.next.calls).toHaveLength(1);
    expect(ctx2.next.calls[0]).toBeUndefined();

    const ctx3 = mockContext('user-1');
    await (limiter as any)(ctx3.req, ctx3.res, ctx3.next);
    expect(ctx3.res.getStatusCode()).toBe(429);
    expect(ctx3.res.getBody()).toEqual({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Daily analysis quota exceeded' }
    });
  });

  it('maintains independent quotas for different users', async () => {
    const limiter = buildUserRateLimiter({ windowMs: 60000, maxRequests: 1 });

    const user1_req1 = mockContext('user-1');
    await (limiter as any)(user1_req1.req, user1_req1.res, user1_req1.next);
    expect(user1_req1.next.calls).toHaveLength(1);

    // user-2 should still be allowed even though user-1 used their slot
    const user2_req1 = mockContext('user-2');
    await (limiter as any)(user2_req1.req, user2_req1.res, user2_req1.next);
    expect(user2_req1.next.calls).toHaveLength(1);

    // user-1 second request blocked
    const user1_req2 = mockContext('user-1');
    await (limiter as any)(user1_req2.req, user1_req2.res, user1_req2.next);
    expect(user1_req2.res.getStatusCode()).toBe(429);
  });
});
