import request from 'supertest';
import express from 'express';
import { healthRouter } from '../../src/routes/health.route';
import * as prismaModule from '../../src/config/prisma';
import { SemgrepService } from '../../src/services/semgrep/semgrep.service';

jest.mock('../../src/services/semgrep/semgrep.service');

describe('Health and Readiness checks', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use('/', healthRouter);
    jest.clearAllMocks();
  });

  it('GET /health returns basic ok status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('ok');
  });

  it('GET /health/ready returns 200 when DB is connected', async () => {
    jest.spyOn(prismaModule, 'getPrismaClient').mockReturnValue({
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }])
    } as any);

    (SemgrepService.prototype.checkAvailability as jest.Mock).mockResolvedValue({
      available: true,
      version: '1.90.0'
    });

    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks.database.status).toBe('up');
    expect(res.body.checks.semgrep.available).toBe(true);
  });

  it('GET /health/ready returns 503 when DB fails', async () => {
    jest.spyOn(prismaModule, 'getPrismaClient').mockReturnValue({
      $queryRaw: jest.fn().mockRejectedValue(new Error('Connection refused'))
    } as any);

    (SemgrepService.prototype.checkAvailability as jest.Mock).mockResolvedValue({
      available: false
    });

    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');
    expect(res.body.checks.database.status).toBe('down');
  });
});
