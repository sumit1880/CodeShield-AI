import request from 'supertest';
import { createApp, CreateAppOptions } from '../../src/app';
import { Container } from '../../src/config/container';

const USER_ID = 'test-sarif-user';

const fakeAuth: CreateAppOptions['authMiddleware'] = (req, _res, next) => {
  (req as any).user = { id: USER_ID, email: 'sarif@example.com' };
  next();
};

const testOptions: CreateAppOptions = {
  authMiddleware: fakeAuth,
  rateLimiter: (_req, _res, next) => next(),
  concurrencyLimiter: (_req, _res, next) => next()
};

function buildMockContainer(mockAnalysis: any): Container {
  const orchestrator = {} as any;
  const zipService = {} as any;
  const prisma = {
    analysis: {
      findFirst: jest.fn().mockImplementation(({ where }) => {
        if (where.id === mockAnalysis.id && where.userId === USER_ID) {
          return Promise.resolve(mockAnalysis);
        }
        return Promise.resolve(null);
      })
    }
  } as any;

  return { orchestrator, zipService, prisma };
}

describe('SARIF export endpoint', () => {
  it('GET /api/analyses/:id/sarif returns valid SARIF 2.1.0 document', async () => {
    const analysis = {
      id: 'scan-100',
      userId: USER_ID,
      language: 'javascript',
      findings: [
        {
          id: 'f-1',
          title: 'SQL Injection',
          cweId: 'CWE-89',
          cweName: 'Improper Neutralization of Special Elements used in an SQL Command',
          severity: 'HIGH',
          file: 'src/db.js',
          lineStart: 12,
          lineEnd: 15,
          explanation: 'Raw user input directly concatenated into SQL query.',
          recommendation: 'Use parameterized queries.'
        }
      ]
    };

    const container = buildMockContainer(analysis);
    const app = createApp(container, testOptions);

    const res = await request(app).get('/api/analyses/scan-100/sarif');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/sarif+json');
    expect(res.body.version).toBe('2.1.0');
    expect(res.body.runs).toHaveLength(1);

    const run = res.body.runs[0];
    expect(run.tool.driver.name).toBe('CodeShield-AI');
    expect(run.results).toHaveLength(1);

    const findingResult = run.results[0];
    expect(findingResult.ruleId).toBe('CWE-89');
    expect(findingResult.level).toBe('error');
    expect(findingResult.locations[0].physicalLocation.artifactLocation.uri).toBe('src/db.js');
    expect(findingResult.locations[0].physicalLocation.region.startLine).toBe(12);
  });

  it('GET /api/analyses/:id/sarif returns 404 if analysis is not found', async () => {
    const container = buildMockContainer({ id: 'scan-other' });
    const app = createApp(container, testOptions);

    const res = await request(app).get('/api/analyses/missing-id/sarif');
    expect(res.status).toBe(404);
  });
});
