import { Router } from 'express';
import { Container } from '../config/container';
import { analyzeRequestSchema, analyzeUploadQuerySchema } from '../schemas/api.schema';
import { ApiError, ErrorCode } from '../utils/errors';
import { withTempDir } from '../utils/temp-workspace';
import { zipUpload } from '../middleware/upload';

export function buildAnalyzeRouter(container: Container): Router {
  const router = Router();

  router.post('/analyze', async (req, res, next) => {
    try {
      const parsed = analyzeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(ErrorCode.INVALID_REQUEST, 'Invalid request body', parsed.error.flatten());
      }

      const result = await container.orchestrator.analyzePastedCode({
        language: parsed.data.language,
        code: parsed.data.code
      });

      res.json({ success: true, analysis: toApiShape(result) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/analyze/upload', zipUpload, async (req, res, next) => {
    try {
      if (!req.file) {
        throw new ApiError(ErrorCode.INVALID_REQUEST, 'No file uploaded (expected multipart field "file")');
      }

      const query = analyzeUploadQuerySchema.safeParse(req.query);
      const language = query.success && query.data.language ? query.data.language : 'auto';

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

      res.json({ success: true, analysis: toApiShape(result) });
    } catch (err) {
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
    vulnerabilities: result.vulnerabilities
  };
}
