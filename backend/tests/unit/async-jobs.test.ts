import request from 'supertest';
import { createApp, CreateAppOptions } from '../../src/app';
import { Container } from '../../src/config/container';

const USER_ID = 'test-async-user';

const fakeAuth: CreateAppOptions['authMiddleware'] = (req, _res, next) => {
  (req as any).user = { id: USER_ID, email: 'async@example.com' };
  next();
};

const testOptions: CreateAppOptions = {
  authMiddleware: fakeAuth,
  rateLimiter: (_req, _res, next) => next(),
  concurrencyLimiter: (_req, _res, next) => next()
};

function buildMockContainer(): { container: Container; createMock: jest.Mock; updateMock: jest.Mock } {
  const createMock = jest.fn().mockResolvedValue({ id: 'job-123', status: 'PENDING' });
  const updateMock = jest.fn().mockResolvedValue({ id: 'job-123', status: 'RUNNING' });
  const findFirstMock = jest.fn().mockResolvedValue({
    id: 'job-123',
    userId: USER_ID,
    status: 'COMPLETED',
    findings: []
  });

  const orchestrator = {
    analyzePastedCode: jest.fn().mockResolvedValue({
      id: 'job-123',
      persisted: true,
      language: 'javascript',
      summary: { totalIssues: 0 },
      vulnerabilities: [],
      uncertainFindings: [],
      partial: false,
      analysisStatus: 'COMPLETE'
    }),
    analyzeProject: jest.fn().mockResolvedValue({
      id: 'job-123',
      persisted: true,
      language: 'javascript',
      summary: { totalIssues: 0 },
      vulnerabilities: [],
      uncertainFindings: [],
      partial: false,
      analysisStatus: 'COMPLETE'
    })
  } as any;

  const zipService = {
    safeExtract: jest.fn().mockResolvedValue([{ relativePath: 'index.js', absolutePath: '/tmp/index.js' }])
  } as any;

  const prisma = {
    analysis: {
      create: createMock,
      update: updateMock,
      findFirst: findFirstMock,
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([])
    }
  } as any;

  return { container: { orchestrator, zipService, prisma }, createMock, updateMock };
}

describe('Async analysis jobs (Task 11)', () => {
  it('POST /api/analyze returns 202 and jobId when async=true is passed', async () => {
    const { container, createMock } = buildMockContainer();
    const app = createApp(container, testOptions);

    const res = await request(app)
      .post('/api/analyze')
      .send({ language: 'javascript', code: 'const x = 1;', async: true });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.jobId).toBe('job-123');
    expect(res.body.pollUrl).toBe('/api/analyses/job-123');
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER_ID,
          sourceType: 'PASTE',
          status: 'PENDING'
        })
      })
    );
  });

  it('GET /api/analyses/:id returns the job status when polling', async () => {
    const { container } = buildMockContainer();
    const app = createApp(container, testOptions);

    const res = await request(app).get('/api/analyses/job-123');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe('job-123');
    expect(res.body.data.status).toBe('COMPLETED');
  });
});
