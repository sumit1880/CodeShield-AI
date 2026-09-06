import request from 'supertest';
import { createApp } from '../../src/app';
import { buildConcurrencyLimiter } from '../../src/middleware/concurrency';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('MAX_CONCURRENT_ANALYSES limiter', () => {
  it('rejects a request that arrives while another is still in flight', async () => {
    const first = deferred<any>();

    const orchestrator = {
      analyzePastedCode: jest
        .fn()
        // First call hangs until we resolve it manually; a second call (if
        // it ever ran) would resolve immediately — but it must never run
        // while the limit is exhausted.
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValue({
          id: 'a2',
          language: 'javascript',
          summary: { totalIssues: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
          vulnerabilities: []
        }),
      analyzeProject: jest.fn()
    } as any;
    const container = { orchestrator, zipService: { safeExtract: jest.fn() } as any, prisma: {} as any };

    const app = createApp(container, {
      authMiddleware: (_req, _res, next) => next(),
      rateLimiter: (_req, _res, next) => next(),
      concurrencyLimiter: buildConcurrencyLimiter(1)
    });

    const payload = { language: 'javascript', code: 'const a = 1;' };

    const inFlight = request(app).post('/api/analyze').send(payload);
    // Give the first request a tick to enter the handler and increment the counter.
    await new Promise((r) => setImmediate(r));

    const rejected = await request(app).post('/api/analyze').send(payload);
    expect(rejected.status).toBe(503);
    expect(rejected.body.success).toBe(false);

    first.resolve({
      id: 'a1',
      language: 'javascript',
      summary: { totalIssues: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      vulnerabilities: []
    });
    const completed = await inFlight;
    expect(completed.status).toBe(200);
    expect(completed.body.analysis.id).toBe('a1');

    // Now that the first request has finished, the slot is free again.
    const after = await request(app).post('/api/analyze').send(payload);
    expect(after.status).toBe(200);
  });
});
