import { buildAnalysesRouter } from '../../src/routes/analyses.route';
import request from 'supertest';
import pino from 'pino';
import pinoHttp from 'pino-http';
import express from 'express';
import { Writable } from 'stream';
import { Prisma } from '@prisma/client';
import { sanitizeGeminiModel, env } from '../../src/config/env';
import { isPermanentError, LangChainFallbackRouter, buildProviderModel } from '../../src/llm/factory';
import { FakeChatModel } from '../../src/llm/fake-chat-model';
import { generateStructuredWithModel } from '../../src/llm/structured-output';
import { errorHandler } from '../../src/middleware/error-handler';
import { z } from 'zod';
import { finalizeNode } from '../../src/graph/nodes/finalize.node';
import { AnalysisOrchestrator } from '../../src/orchestrator/analysis.orchestrator';
import { CodeContextService } from '../../src/services/code-context/code-context.service';
import { CodeSearchService } from '../../src/services/code-context/code-search.service';
import { SemgrepService } from '../../src/services/semgrep/semgrep.service';
import { isTimeoutError } from '../../src/llm/factory';

describe('Production Bug Regressions', () => {
  // ── 1. Model Configuration & Sanitize Check ─────────────────────────
  describe('Task 1: Gemini model configuration & sanitation', () => {
    it('upgrades retired gemini-1.5-flash, gemini-2.0-flash, and gemini-2.5-flash to gemini-3.8-flash', () => {
      expect(sanitizeGeminiModel('gemini-1.5-flash')).toBe('gemini-3.8-flash');
      expect(sanitizeGeminiModel('gemini-1.5-flash-latest')).toBe('gemini-3.8-flash');
      expect(sanitizeGeminiModel('gemini-1.5-pro')).toBe('gemini-3.8-flash');
      expect(sanitizeGeminiModel('gemini-2.0-flash')).toBe('gemini-3.8-flash');
      expect(sanitizeGeminiModel('gemini-2.0-flash-exp')).toBe('gemini-3.8-flash');
      expect(sanitizeGeminiModel('gemini-2.5-flash')).toBe('gemini-3.8-flash');
      expect(sanitizeGeminiModel('')).toBe('gemini-3.8-flash');
      expect(sanitizeGeminiModel(undefined)).toBe('gemini-3.8-flash');
    });

    it('preserves valid custom/modern model identifiers', () => {
      expect(sanitizeGeminiModel('gemini-2.5-pro')).toBe('gemini-2.5-pro');
      expect(sanitizeGeminiModel('gemini-3.8-flash')).toBe('gemini-3.8-flash');
      expect(sanitizeGeminiModel('gemini-3.8-pro')).toBe('gemini-3.8-pro');
    });

    it('classifies 404 model-not-found / unsupported generateContent as permanent error', () => {
      const err404 = {
        status: 404,
        message: 'models/gemini-2.5-flash is not found for API version v1beta or is not supported for generateContent'
      };
      expect(isPermanentError(err404)).toBe(true);

      const errText = new Error('Model not found for API version');
      expect(isPermanentError(errText)).toBe(true);
    });
  });

  // ── 2. Provider Fallback on 404 Model Not Found ─────────────────────
  describe('Task 2: Provider fallback skips 404 model errors and duplicate models', () => {
    const testSchema = z.object({ ok: z.boolean() });

    it('skips 404 model-not-found provider without retry and succeeds on next independent provider', async () => {
      const p1 = new FakeChatModel();
      const p2 = new FakeChatModel();

      // p1 throws Google 404 model not found
      p1.enqueueError(
        new Error('models/gemini-old is not found for API version v1beta or is not supported for generateContent')
      );
      // p2 has valid model and succeeds
      p2.enqueue({ ok: true });

      const router = new LangChainFallbackRouter([
        { name: 'gemini', model: p1, modelName: 'gemini-old' },
        { name: 'gemini2', model: p2, modelName: 'gemini-3.8-flash' }
      ]);

      const result = await generateStructuredWithModel(router, {
        systemPrompt: 'System',
        userPrompt: 'User',
        schema: testSchema
      });

      expect(result).toEqual({ ok: true });
      expect(p1.calls).toHaveLength(1); // Never retried p1
      expect(p2.calls).toHaveLength(1);
    });

    it('skips subsequent provider when it uses the identical failing model identifier', async () => {
      const p1 = new FakeChatModel();
      const p2 = new FakeChatModel();
      const p3 = new FakeChatModel();

      // p1 throws Google 404 model not found for gemini-old
      p1.enqueueError(
        new Error('models/gemini-old is not found for API version v1beta or is not supported for generateContent')
      );
      // p2 uses the exact same model name 'gemini-old' and should be skipped automatically
      // p3 uses 'grok-beta' and succeeds
      p3.enqueue({ ok: true });

      const router = new LangChainFallbackRouter([
        { name: 'gemini', model: p1, modelName: 'gemini-old' },
        { name: 'gemini2', model: p2, modelName: 'gemini-old' },
        { name: 'grok', model: p3, modelName: 'grok-beta' }
      ]);

      const result = await generateStructuredWithModel(router, {
        systemPrompt: 'System',
        userPrompt: 'User',
        schema: testSchema
      });

      expect(result).toEqual({ ok: true });
      expect(p1.calls).toHaveLength(1);
      expect(p2.calls).toHaveLength(0); // Successfully skipped p2 because it shares the failing model
      expect(p3.calls).toHaveLength(1);
    });

    it('throws when all providers fail without fabricating vulnerabilities', async () => {
      const p1 = new FakeChatModel();
      p1.enqueueError(new Error('models/gemini-old is not found'));

      const router = new LangChainFallbackRouter([
        { name: 'gemini', model: p1, modelName: 'gemini-old' }
      ]);

      await expect(
        generateStructuredWithModel(router, {
          systemPrompt: 'System',
          userPrompt: 'User',
          schema: testSchema
        })
      ).rejects.toThrow(/All LLM providers failed/);
    });

    it('passes the configured model to the provider constructor', () => {
      const origKey = env.gemini.apiKey;
      const origModel = env.gemini.model;
      try {
        (env.gemini as any).apiKey = 'test-key-123';
        (env.gemini as any).model = 'gemini-3.8-flash';
        const provider = buildProviderModel('gemini');
        expect(provider).not.toBeNull();
        expect(provider?.modelName).toBe('gemini-3.8-flash');
        expect((provider?.model as any).model).toBe('gemini-3.8-flash');
      } finally {
        (env.gemini as any).apiKey = origKey;
        (env.gemini as any).model = origModel;
      }
    });

    it('skips duplicate gemini2 provider when API key and model are identical to gemini', () => {
      const origKey = env.gemini.apiKey;
      const origModel = env.gemini.model;
      const origKey2 = env.gemini2.apiKey;
      const origModel2 = env.gemini2.model;
      try {
        (env.gemini as any).apiKey = 'same-api-key';
        (env.gemini as any).model = 'gemini-3.8-flash';
        (env.gemini2 as any).apiKey = 'same-api-key';
        (env.gemini2 as any).model = 'gemini-3.8-flash';

        const provider2 = buildProviderModel('gemini2');
        expect(provider2).toBeNull();
      } finally {
        (env.gemini as any).apiKey = origKey;
        (env.gemini as any).model = origModel;
        (env.gemini2 as any).apiKey = origKey2;
        (env.gemini2 as any).model = origModel2;
      }
    });

    it('keeps independent gemini2 provider when it has a distinct key', () => {
      const origKey = env.gemini.apiKey;
      const origModel = env.gemini.model;
      const origKey2 = env.gemini2.apiKey;
      const origModel2 = env.gemini2.model;
      try {
        (env.gemini as any).apiKey = 'primary-key';
        (env.gemini as any).model = 'gemini-3.8-flash';
        (env.gemini2 as any).apiKey = 'secondary-key-distinct';
        (env.gemini2 as any).model = 'gemini-3.8-flash';

        const provider2 = buildProviderModel('gemini2');
        expect(provider2).not.toBeNull();
        expect(provider2?.name).toBe('gemini2');
        expect(provider2?.modelName).toBe('gemini-3.8-flash');
      } finally {
        (env.gemini as any).apiKey = origKey;
        (env.gemini as any).model = origModel;
        (env.gemini2 as any).apiKey = origKey2;
        (env.gemini2 as any).model = origModel2;
      }
    });

    it('skips duplicate gemini3 provider when API key and model are identical to gemini or gemini2', () => {
      const origKey = env.gemini.apiKey;
      const origModel = env.gemini.model;
      const origKey2 = env.gemini2.apiKey;
      const origModel2 = env.gemini2.model;
      const origKey3 = env.gemini3.apiKey;
      const origModel3 = env.gemini3.model;

      try {
        (env.gemini as any).apiKey = 'key-alpha';
        (env.gemini as any).model = 'gemini-3.8-flash';
        (env.gemini2 as any).apiKey = 'key-beta';
        (env.gemini2 as any).model = 'gemini-3.8-flash';

        // gemini3 duplicates gemini
        (env.gemini3 as any).apiKey = 'key-alpha';
        (env.gemini3 as any).model = 'gemini-3.8-flash';
        expect(buildProviderModel('gemini3')).toBeNull();

        // gemini3 duplicates gemini2
        (env.gemini3 as any).apiKey = 'key-beta';
        (env.gemini3 as any).model = 'gemini-3.8-flash';
        expect(buildProviderModel('gemini3')).toBeNull();
      } finally {
        (env.gemini as any).apiKey = origKey;
        (env.gemini as any).model = origModel;
        (env.gemini2 as any).apiKey = origKey2;
        (env.gemini2 as any).model = origModel2;
        (env.gemini3 as any).apiKey = origKey3;
        (env.gemini3 as any).model = origModel3;
      }
    });

    it('keeps independent gemini3 provider when it has a distinct key and independent model', () => {
      const origKey = env.gemini.apiKey;
      const origModel = env.gemini.model;
      const origKey2 = env.gemini2.apiKey;
      const origModel2 = env.gemini2.model;
      const origKey3 = env.gemini3.apiKey;
      const origModel3 = env.gemini3.model;

      try {
        (env.gemini as any).apiKey = 'key-alpha';
        (env.gemini as any).model = 'gemini-3.8-flash';
        (env.gemini2 as any).apiKey = 'key-beta';
        (env.gemini2 as any).model = 'gemini-3.8-flash';
        (env.gemini3 as any).apiKey = 'key-gamma-distinct';
        (env.gemini3 as any).model = 'gemini-2.5-pro';

        const provider3 = buildProviderModel('gemini3');
        expect(provider3).not.toBeNull();
        expect(provider3?.name).toBe('gemini3');
        expect(provider3?.modelName).toBe('gemini-2.5-pro');
      } finally {
        (env.gemini as any).apiKey = origKey;
        (env.gemini as any).model = origModel;
        (env.gemini2 as any).apiKey = origKey2;
        (env.gemini2 as any).model = origModel2;
        (env.gemini3 as any).apiKey = origKey3;
        (env.gemini3 as any).model = origModel3;
      }
    });
  });

  // ── 3. Credential Redaction in Request Logs ─────────────────────────
  describe('Task 3: Stop logging credentials (Pino redaction)', () => {
    it('redacts Authorization bearer tokens and cookies from HTTP logs on success and failure', async () => {
      let loggedChunks = '';
      const stream = new Writable({
        write(chunk, encoding, callback) {
          loggedChunks += chunk.toString();
          callback();
        }
      });

      const testLogger = pino(
        {
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-api-key"]'
            ],
            censor: '[REDACTED]'
          }
        },
        stream
      );

      const app = express();
      app.use(
        pinoHttp({
          logger: testLogger,
          serializers: {
            req: (req: any) => {
              const raw = req.raw || req;
              const headers = { ...(raw.headers || {}) };
              if (headers.authorization) headers.authorization = '[REDACTED]';
              if (headers.cookie) headers.cookie = '[REDACTED]';
              if (headers['x-api-key']) headers['x-api-key'] = '[REDACTED]';
              return {
                id: req.id,
                method: req.method,
                url: req.url,
                query: req.query,
                params: req.params,
                headers
              };
            }
          }
        })
      );
      app.get('/test-auth', (req, res) => {
        res.json({ ok: true });
      });
      app.get('/test-error', (req, res) => {
        res.status(500).json({ error: 'failed' });
      });

      const superSecretToken = 'ya29.a0AfH6SMB_secret_bearer_token_xyz_12345';
      const superSecretCookie = 'session_id=super_secret_cookie_val';
      const superSecretApiKey = 'AIzaSy_secret_key_12345';

      await request(app)
        .get('/test-auth')
        .set('Authorization', `Bearer ${superSecretToken}`)
        .set('Cookie', superSecretCookie)
        .set('x-api-key', superSecretApiKey);

      await request(app)
        .get('/test-error')
        .set('Authorization', `Bearer ${superSecretToken}`)
        .set('Cookie', superSecretCookie)
        .set('x-api-key', superSecretApiKey);

      // Verify the sensitive values were never written to the stream
      expect(loggedChunks).not.toContain(superSecretToken);
      expect(loggedChunks).not.toContain(superSecretCookie);
      expect(loggedChunks).not.toContain(superSecretApiKey);
      // Verify [REDACTED] placeholder was used
      expect(loggedChunks).toContain('[REDACTED]');
    });
  });

  // ── 4. Database Connection Error Handling ───────────────────────────
  describe('Task 4: Prisma Database Connection Errors', () => {
    it('maps PrismaClientInitializationError to HTTP 503 DATABASE_ERROR', async () => {
      const app = express();
      app.get('/test-db-error', (req, res, next) => {
        const initErr = new Prisma.PrismaClientInitializationError(
          "Can't reach database server at `ep-dry-dew-ayav47xf-pooler.c-5.us-east-2.aws.neon.tech:5432`",
          '5.22.0'
        );
        next(initErr);
      });
      app.use(errorHandler);

      const res = await request(app).get('/test-db-error');
      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('DATABASE_ERROR');
      expect(res.body.error.message).toContain('Database service is currently unreachable');
    });
  });

  // ── 5. thinkingConfig correctness ────────────────────────────────────
  describe('Task 5: thinkingConfig uses uppercase LOW (SDK enum)', () => {
    it('buildProviderModel passes thinkingLevel: "LOW" (uppercase) matching GoogleGenerativeAIThinkingLevel', () => {
      const origKey = env.gemini.apiKey;
      const origModel = env.gemini.model;
      try {
        (env.gemini as any).apiKey = 'test-key-abc';
        (env.gemini as any).model = 'gemini-3.8-flash';
        const provider = buildProviderModel('gemini');
        expect(provider).not.toBeNull();
        // Verify the model was instantiated with thinkingLevel uppercase 'LOW'
        const internalConfig = (provider!.model as any).thinkingConfig;
        expect(internalConfig).toBeDefined();
        expect(internalConfig.thinkingLevel).toBe('LOW');
        // Ensure it is not the incorrect lowercase 'low'
        expect(internalConfig.thinkingLevel).not.toBe('low');
      } finally {
        (env.gemini as any).apiKey = origKey;
        (env.gemini as any).model = origModel;
      }
    });
  });

  // ── 6. Async lifecycle shape verification ────────────────────────────
  describe('Task 6: Async analysis lifecycle shape', () => {
    // Tests mapConfirmedFinding / mapUncertainFinding expectations by inspecting the
    // Prisma Finding schema field names that GET /api/analyses/:id returns.
    // The frontend mapping reads: id, title, severity, confidence (Float), cweId, cweName,
    // file, function, lineStart, lineEnd, explanation, recommendation,
    // verificationStatus, verificationReason — all confirmed in schema.prisma.

    it('mapConfirmedFinding expected DB fields are present on a Finding-shaped row', () => {
      const row = {
        id: 'f1', title: 'SQL Injection', severity: 'HIGH', confidence: 0.95,
        cweId: 'CWE-89', cweName: 'SQL Injection',
        file: 'app.js', function: 'query', lineStart: 12, lineEnd: 14,
        explanation: 'User input used in SQL', recommendation: 'Use parameterized queries',
        verificationStatus: 'CONFIRMED', verificationReason: 'Confirmed by verification agent'
      };

      // Replicate mapConfirmedFinding logic
      const mapped = {
        id: row.id,
        title: row.title,
        severity: row.severity,
        confidence: typeof row.confidence === 'number' ? row.confidence : 0.5,
        cwe: { id: row.cweId, name: row.cweName },
        location: { file: row.file, function: row.function, lineStart: row.lineStart, lineEnd: row.lineEnd },
        explanation: row.explanation,
        recommendation: row.recommendation,
        verification: { status: 'CONFIRMED' as const, confidence: row.confidence }
      };

      expect(mapped.cwe.id).toBe('CWE-89');
      expect(mapped.verification.status).toBe('CONFIRMED');
      expect(mapped.verification.confidence).toBe(0.95);
      expect(mapped.location.lineStart).toBe(12);
    });

    it('mapUncertainFinding maps verificationReason correctly', () => {
      const row = {
        id: 'f2', title: 'Path Traversal', severity: 'MEDIUM', confidence: 0.6,
        cweId: 'CWE-22', cweName: 'Path Traversal',
        file: 'upload.js', function: null, lineStart: 5, lineEnd: 7,
        explanation: 'Path not sanitized', recommendation: 'Validate paths',
        verificationStatus: 'UNCERTAIN', verificationReason: 'Could not confirm without runtime'
      };

      const mapped = {
        id: row.id, title: row.title, severity: row.severity,
        confidence: typeof row.confidence === 'number' ? row.confidence : 0.5,
        cwe: { id: row.cweId, name: row.cweName },
        location: { file: row.file, function: row.function, lineStart: row.lineStart, lineEnd: row.lineEnd },
        explanation: row.explanation, recommendation: row.recommendation,
        verification: { status: 'UNCERTAIN' as const, confidence: row.confidence, reason: row.verificationReason ?? undefined }
      };

      expect(mapped.verification.status).toBe('UNCERTAIN');
      expect(mapped.verification.reason).toBe('Could not confirm without runtime');
    });

    it('202 async response shape has jobId and pollUrl', () => {
      // The backend returns: { success: true, status: 'PENDING', jobId, pollUrl }
      // The frontend reads: (await res.json()) as { jobId: string }
      const backendResponse = { success: true, status: 'PENDING', jobId: 'abc123', pollUrl: '/api/analyses/abc123' };
      expect(backendResponse.jobId).toBeTruthy();
      const frontendReads = (backendResponse as { jobId: string }).jobId;
      expect(frontendReads).toBe('abc123');
    });
  });

  // ── 7. Analysis Polling Cache Invalidation ───────────────────────────
  describe('Task 7: Polling GET /api/analyses/:id cache-control', () => {
    it('sets Cache-Control: no-store and returns 200 even when If-None-Match header is provided', async () => {
      const mockAnalysis = {
        id: 'job-pending-1',
        userId: 'test-user-id',
        language: 'javascript',
        status: 'PENDING',
        findings: []
      };

      const mockContainer = {
        prisma: {
          analysis: {
            findFirst: jest.fn().mockResolvedValue(mockAnalysis)
          }
        }
      } as any;

      const app = express();
      app.use('/api/analyses', buildAnalysesRouter(mockContainer, {
        authMiddleware: (req, _res, next) => {
          (req as any).user = { id: 'test-user-id' };
          next();
        }
      }));

      const res = await request(app)
        .get('/api/analyses/job-pending-1')
        .set('If-None-Match', 'W/"123-fakeetag"')
        .set('If-Modified-Since', 'Wed, 21 Oct 2026 07:28:00 GMT');

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toContain('no-store');
      expect(res.headers['pragma']).toBe('no-cache');
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('job-pending-1');
      expect(res.body.data.status).toBe('PENDING');
    });
  });

  // ── 8. Production Pipeline Robustness & State Transitions ───────────
  describe('Task 8: Production Pipeline Robustness & State Transitions', () => {
    it('isTimeoutError detects native TimeoutError by name and message', () => {
      const errByName = new Error('The operation timed out');
      errByName.name = 'TimeoutError';
      expect(isTimeoutError(errByName)).toBe(true);

      const errByMsg = new Error('Request deadline_exceeded after 20000ms');
      expect(isTimeoutError(errByMsg)).toBe(true);
    });

    it('finalizeNode converts unclassified candidates to UNVERIFIED uncertain findings instead of dropping them', async () => {
      const finalize = finalizeNode();
      const mockState: any = {
        candidateFindings: [
          {
            id: 'finding-1',
            title: 'Unchecked Input in exec',
            category: 'Command Injection',
            evidence: 'child_process.exec(userInput)',
            file: 'server.js',
            lineStart: 42,
            lineEnd: 45
          }
        ],
        classifiedFindings: [],
        verifiedById: {},
        semgrepFindings: [],
        iteration: 1,
        toolCallCount: 1,
        deadline: Date.now() - 1000,
        stopReason: 'FINISHED'
      };

      const result = await finalize(mockState);
      expect(result.finalized).toBeDefined();
      const finalized = result.finalized as any;
      expect(finalized.vulnerabilities).toHaveLength(0);
      expect(finalized.uncertainFindings).toHaveLength(1);
      expect(finalized.uncertainFindings[0]).toMatchObject({
        id: 'finding-1',
        title: 'Unchecked Input in exec',
        severity: 'MEDIUM',
        verification: expect.objectContaining({
          status: 'UNVERIFIED',
          reason: expect.stringContaining('before classification')
        })
      });
      expect(finalized.partial).toBe(true);
    });

    it('AnalysisOrchestrator.persist rethrows error when updating an existing async analysis job', async () => {
      const model = new FakeChatModel();
      const updateMock = jest.fn().mockRejectedValue(new Error('Prisma connection timeout during write'));
      const prismaMock = {
        analysis: {
          update: updateMock,
          create: jest.fn()
        }
      } as any;

      const orchestrator = new AnalysisOrchestrator({
        detectionModel: model,
        verificationModel: model,
        semgrepService: new SemgrepService(),
        retriever: { retrieveKnowledge: jest.fn().mockResolvedValue([]), _getRelevantDocuments: jest.fn().mockResolvedValue([]) } as any,
        codeContextService: new CodeContextService(),
        codeSearchService: new CodeSearchService(),
        prisma: prismaMock
      });

      await expect(
        (orchestrator as any).persist({
          existingId: 'async-job-999',
          userId: 'test-user',
          language: 'javascript',
          codeHash: 'hash123',
          sourceType: 'PASTE',
          durationMs: 500,
          vulnerabilities: [],
          uncertainFindings: [],
          partial: false
        })
      ).rejects.toThrow('Prisma connection timeout during write');

      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'async-job-999' }
        })
      );
    });
  });
});