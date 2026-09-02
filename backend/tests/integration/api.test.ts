import request from 'supertest';
import { createApp } from '../../src/app';
import { Container } from '../../src/config/container';

function buildMockContainer(overrides: Partial<Container> = {}): Container {
  const orchestrator = {
    analyzePastedCode: jest.fn().mockResolvedValue({
      id: 'analysis-1',
      language: 'javascript',
      summary: { totalIssues: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      vulnerabilities: []
    }),
    analyzeProject: jest.fn()
  } as any;

  const zipService = { safeExtract: jest.fn() } as any;

  return { orchestrator, zipService, prisma: {} as any, ...overrides };
}

describe('GET /health', () => {
  it('returns ok', async () => {
    const app = createApp(buildMockContainer());
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /api/analyze', () => {
  it('returns 400 for empty code', async () => {
    const container = buildMockContainer();
    const app = createApp(container);

    const res = await request(app).post('/api/analyze').send({ language: 'javascript', code: '' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for missing language', async () => {
    const app = createApp(buildMockContainer());
    const res = await request(app).post('/api/analyze').send({ code: 'const a = 1;' });
    expect(res.status).toBe(400);
  });

  it('returns the analysis result for a valid request', async () => {
    const container = buildMockContainer();
    const app = createApp(container);

    const res = await request(app)
      .post('/api/analyze')
      .send({ language: 'javascript', code: 'const a = 1;' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.analysis.id).toBe('analysis-1');
    expect(container.orchestrator.analyzePastedCode).toHaveBeenCalledWith({
      language: 'javascript',
      code: 'const a = 1;'
    });
  });
});

describe('POST /api/analyze/upload', () => {
  it('returns 400 when no file is provided', async () => {
    const app = createApp(buildMockContainer());
    const res = await request(app).post('/api/analyze/upload');
    expect(res.status).toBe(400);
  });
});
