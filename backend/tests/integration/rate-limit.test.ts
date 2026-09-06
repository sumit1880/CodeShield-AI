import request from 'supertest';

describe('rate limiting on /api/*', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  it('returns 429 once the configured request budget is exceeded', async () => {
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    process.env.RATE_LIMIT_MAX_REQUESTS = '2';
    jest.resetModules();

    const { createApp } = await import('../../src/app');

    const orchestrator = { analyzePastedCode: jest.fn().mockResolvedValue({
      id: 'a1',
      language: 'javascript',
      summary: { totalIssues: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      vulnerabilities: []
    }), analyzeProject: jest.fn() } as any;
    const container = { orchestrator, zipService: { safeExtract: jest.fn() } as any, prisma: {} as any };

    // Real rate limiter, but auth/concurrency bypassed — this test is only
    // about the request-count budget.
    const app = createApp(container, {
      authMiddleware: (_req, _res, next) => next(),
      concurrencyLimiter: (_req, _res, next) => next()
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
