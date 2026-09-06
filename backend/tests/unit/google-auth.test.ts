import { Request, Response } from 'express';
import { buildGoogleAuthMiddleware, AuthenticatedRequest } from '../../src/middleware/google-auth.middleware';
import { ApiError, ErrorCode } from '../../src/utils/errors';

function mockReq(headers: Record<string, string> = {}): AuthenticatedRequest {
  return { headers } as unknown as AuthenticatedRequest;
}

function mockRes(): Response {
  return {} as Response;
}

describe('googleAuth middleware', () => {
  it('rejects a request with no Authorization header', async () => {
    const middleware = buildGoogleAuthMiddleware(async () => ({ sub: 'user-1' } as any));
    const next = jest.fn();

    await middleware(mockReq(), mockRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('rejects a header that is not a Bearer token', async () => {
    const middleware = buildGoogleAuthMiddleware(async () => ({ sub: 'user-1' } as any));
    const next = jest.fn();

    await middleware(mockReq({ authorization: 'Basic abc123' }), mockRes(), next);

    expect(next.mock.calls[0][0]).toBeInstanceOf(ApiError);
    expect(next.mock.calls[0][0].code).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('rejects a token that fails Google verification', async () => {
    const middleware = buildGoogleAuthMiddleware(async () => {
      throw new Error('invalid token signature');
    });
    const next = jest.fn();

    await middleware(mockReq({ authorization: 'Bearer bad-token' }), mockRes(), next);

    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(ErrorCode.UNAUTHORIZED);
    // The verification library's raw error message must never leak to the client.
    expect(err.message).not.toMatch(/signature/);
  });

  it('rejects a verified payload with no subject claim', async () => {
    const middleware = buildGoogleAuthMiddleware(async () => ({} as any));
    const next = jest.fn();

    await middleware(mockReq({ authorization: 'Bearer some-token' }), mockRes(), next);

    expect(next.mock.calls[0][0].code).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('accepts a valid Google ID token and attaches req.user', async () => {
    const middleware = buildGoogleAuthMiddleware(async (token) => {
      expect(token).toBe('good-token');
      return { sub: 'google-user-123', email: 'dev@example.com' } as any;
    });
    const req = mockReq({ authorization: 'Bearer good-token' });
    const next = jest.fn();

    await middleware(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toEqual({ id: 'google-user-123', email: 'dev@example.com' });
  });
});
