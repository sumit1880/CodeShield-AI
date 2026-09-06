import { RequestHandler, Router } from 'express';
import { Container } from '../config/container';
import { analyzeRequestSchema, analyzeUploadQuerySchema } from '../schemas/api.schema';
import { ApiError, ErrorCode } from '../utils/errors';
import { withTempDir } from '../utils/temp-workspace';
import { zipUpload } from '../middleware/upload';
import { googleAuth } from '../middleware/google-auth.middleware';
import { buildConcurrencyLimiter } from '../middleware/concurrency';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { RequestWithId } from '../middleware/request-id';

export interface AnalyzeRouterOptions {
  /** Verifies the caller's Google ID token. Defaults to real Google verification. */
  authMiddleware?: RequestHandler;
  /** Caps simultaneous in-flight analyses. Defaults to a real in-memory limiter. */
  concurrencyLimiter?: RequestHandler;
}

export function buildAnalyzeRouter(container: Container, options: AnalyzeRouterOptions = {}): Router {
  const router = Router();

  const authMiddleware = options.authMiddleware ?? googleAuth;
  const concurrencyLimiter = options.concurrencyLimiter ?? buildConcurrencyLimiter(env.concurrency.maxConcurrentAnalyses);

  // Every route below requires a verified Google identity and counts toward
  // the shared concurrency budget — these are the expensive, LLM-backed
  // endpoints this app exists to protect.
  router.use(authMiddleware, concurrencyLimiter);

  router.post('/analyze', async (req, res, next) => {
    const requestId = (req as RequestWithId).requestId;
    try {
      const parsed = analyzeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(ErrorCode.INVALID_REQUEST, 'Invalid request body', parsed.error.flatten());
      }

      logger.info({ requestId, language: parsed.data.language, sourceType: 'PASTE' }, '[Analysis] Started');

      const result = await container.orchestrator.analyzePastedCode({
        language: parsed.data.language,
        code: parsed.data.code
      });

      logger.info({ requestId, analysisId: result.id, status: result.analysisStatus }, '[Analysis] Completed');

      res.json({ success: true, analysis: toApiShape(result) });
    } catch (err) {
      logger.warn({ requestId, err: err instanceof Error ? err.message : 'unknown' }, '[Analysis] Failed');
      next(err);
    }
  });

  router.post('/analyze/upload', zipUpload, async (req, res, next) => {
    const requestId = (req as RequestWithId).requestId;
    try {
      if (!req.file) {
        throw new ApiError(ErrorCode.INVALID_REQUEST, 'No file uploaded (expected multipart field "file")');
      }

      const query = analyzeUploadQuerySchema.safeParse(req.query);
      const language = query.success && query.data.language ? query.data.language : 'auto';

      logger.info({ requestId, language, sourceType: 'ZIP', sizeBytes: req.file.size }, '[Analysis] Started');

      const result = await withTempDir(async (tempDir) => {
        const extracted = await container.zipService.safeExtract(req.file!.buffer, tempDir);

        if (extracted.length === 0) {
          throw new ApiError(ErrorCode.INVALID_REQUEST, 'Archive contained no usable files');
        }

        return container.orchestrator.analyzeProject({
          language,
          files: extracted.map((f) => ({ relativePath: f.relativePath, absolutePath: f.absolutePath })),
          projectRoot: tempDir
        });
      });

      logger.info({ requestId, analysisId: result.id, status: result.analysisStatus }, '[Analysis] Completed');

      res.json({ success: true, analysis: toApiShape(result) });
    } catch (err) {
      logger.warn({ requestId, err: err instanceof Error ? err.message : 'unknown' }, '[Analysis] Failed');
      next(err);
    }
  });

  return router;
}

function toApiShape(result: Awaited<ReturnType<Container['orchestrator']['analyzePastedCode']>>) {
  return {
    id: result.id,
    language: result.language,
    summary: result.summary,
    vulnerabilities: result.vulnerabilities,
    // Additive fields: existing consumers that only read `vulnerabilities`
    // keep working unchanged. `uncertainFindings`/`partial` let a frontend
    // that wants it distinguish "nothing found" from "ran out of time".
    uncertainFindings: result.uncertainFindings ?? [],
    partial: result.partial ?? false,
    analysisStatus: result.analysisStatus ?? 'COMPLETE'
  };
}
