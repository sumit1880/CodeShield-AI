import { RequestHandler, Router } from 'express';
import { Container } from '../config/container';
import { googleAuth, AuthenticatedRequest } from '../middleware/google-auth.middleware';
import { ApiError, ErrorCode } from '../utils/errors';
import { z } from 'zod';

export interface AnalysesRouterOptions {
  /** Verifies the caller's Google ID token. Defaults to real Google verification. */
  authMiddleware?: RequestHandler;
}

/**
 * GET /api/analyses           – paginated list of the signed-in user's analyses
 * GET /api/analyses/:id       – single analysis (with findings), scoped to the user
 */
export function buildAnalysesRouter(container: Container, options: AnalysesRouterOptions = {}): Router {
  const router = Router();
  const auth = options.authMiddleware ?? googleAuth;

  // All routes require a verified Google identity.
  router.use(auth);

  // ------------------------------------------------------------------
  // GET /api/analyses?page=1&limit=20
  // ------------------------------------------------------------------
  const listQuerySchema = z.object({
    page: z
      .string()
      .optional()
      .transform((v) => (v ? Math.max(1, parseInt(v, 10)) : 1))
      .pipe(z.number().int().min(1)),
    limit: z
      .string()
      .optional()
      .transform((v) => (v ? Math.min(100, Math.max(1, parseInt(v, 10))) : 20))
      .pipe(z.number().int().min(1).max(100))
  });

  router.get('/', async (req, res, next) => {
    try {
      const userId = (req as AuthenticatedRequest).user?.id;
      if (!userId) throw new ApiError(ErrorCode.UNAUTHORIZED, 'Authentication required');

      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiError(ErrorCode.INVALID_REQUEST, 'Invalid query parameters', parsed.error.flatten());
      }
      const { page, limit } = parsed.data;
      const skip = (page - 1) * limit;

      const [total, analyses] = await Promise.all([
        container.prisma.analysis.count({ where: { userId } }),
        container.prisma.analysis.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
          select: {
            id: true,
            language: true,
            sourceType: true,
            status: true,
            createdAt: true,
            completedAt: true,
            durationMs: true,
            _count: { select: { findings: true } }
          }
        })
      ]);

      res.json({
        success: true,
        data: analyses.map((a) => ({
          id: a.id,
          language: a.language,
          sourceType: a.sourceType,
          status: a.status,
          createdAt: a.createdAt,
          completedAt: a.completedAt,
          durationMs: a.durationMs,
          findingCount: a._count.findings
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      });
    } catch (err) {
      next(err);
    }
  });

  // ------------------------------------------------------------------
  // GET /api/analyses/:id
  // ------------------------------------------------------------------
  router.get('/:id', async (req, res, next) => {
    try {
      const userId = (req as AuthenticatedRequest).user?.id;
      if (!userId) throw new ApiError(ErrorCode.UNAUTHORIZED, 'Authentication required');

      const { id } = req.params;

      const analysis = await container.prisma.analysis.findFirst({
        where: { id, userId },
        include: { findings: true }
      });

      if (!analysis) {
        throw new ApiError(ErrorCode.NOT_FOUND, 'Analysis not found');
      }

      res.json({ success: true, data: analysis });
    } catch (err) {
      next(err);
    }
  });

  // ------------------------------------------------------------------
  // GET /api/analyses/:id/sarif
  // ------------------------------------------------------------------
  router.get('/:id/sarif', async (req, res, next) => {
    try {
      const userId = (req as AuthenticatedRequest).user?.id;
      if (!userId) throw new ApiError(ErrorCode.UNAUTHORIZED, 'Authentication required');

      const { id } = req.params;

      const analysis = await container.prisma.analysis.findFirst({
        where: { id, userId },
        include: { findings: true }
      });

      if (!analysis) {
        throw new ApiError(ErrorCode.NOT_FOUND, 'Analysis not found');
      }

      const { generateSarifLog } = await import('../utils/sarif');
      const sarifLog = generateSarifLog({
        analysisId: analysis.id,
        findings: analysis.findings
      });

      res.setHeader('Content-Type', 'application/sarif+json');
      res.setHeader('Content-Disposition', `attachment; filename="codeshield-${analysis.id}.sarif"`);
      res.json(sarifLog);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

