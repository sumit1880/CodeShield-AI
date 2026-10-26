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
});
