import request from 'supertest';
import { createApp } from '../../src/app';

describe('rate limiting on /api/*', () => {
  it('returns 429 once the configured request budget is exceeded', async () => {
    const orchestrator = {
      analyzePastedCode: jest.fn().mockResolvedValue({
        id: 'a1',
        language: 'javascript',
        summary: { totalIssues: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        vulnerabilities: []
      }),
      analyzeProject: jest.fn()
    } as any;
    const container = { orchestrator, zipService: { safeExtract: jest.fn() } as any, prisma: {} as any };

    // Explicit IP rate limiter for the test with limit: 2
    const rateLimit = (await import('express-rate-limit')).default;
    const testRateLimiter = rateLimit({
      windowMs: 60000,
      limit: 2,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' }
      }
    });

    const app = createApp(container, {
      authMiddleware: (_req, _res, next) => next(),
      userRateLimiter: (_req, _res, next) => next(),
      concurrencyLimiter: (_req, _res, next) => next(),
      rateLimiter: testRateLimiter
    });

    const payload = { language: 'javascript', code: 'const a = 1;' };
    const first = await request(app).post('/api/analyze').send(payload);
    const second = await request(app).post('/api/analyze').send(payload);
    const third = await request(app).post('/api/analyze').send(payload);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.body.success).toBe(false);
  });
});
