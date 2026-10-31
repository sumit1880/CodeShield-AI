import { Router } from 'express';
import { getPrismaClient } from '../config/prisma';
import { SemgrepService } from '../services/semgrep/semgrep.service';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({ success: true, status: 'ok', version: '1.0.1', timestamp: new Date().toISOString() });
});

healthRouter.get('/health/ready', async (_req, res) => {
  const checks: {
    database: { status: 'up' | 'down'; error?: string };
    semgrep: { available: boolean; version?: string };
  } = {
    database: { status: 'down' },
    semgrep: { available: false }
  };

  try {
    const prisma = getPrismaClient();
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: 'up' };
  } catch (err: any) {
    checks.database = { status: 'down', error: 'Database service is currently unreachable' };
  }

  try {
    const semgrep = await new SemgrepService().checkAvailability();
    checks.semgrep = semgrep;
  } catch {
    checks.semgrep = { available: false };
  }

  const isReady = checks.database.status === 'up';
  res.status(isReady ? 200 : 503).json({
    success: isReady,
    status: isReady ? 'ready' : 'unhealthy',
    timestamp: new Date().toISOString(),
    checks
  });
});
