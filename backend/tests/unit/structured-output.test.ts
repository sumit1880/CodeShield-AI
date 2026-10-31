import { z } from 'zod';
import { FakeChatModel } from '../../src/llm/fake-chat-model';
import { env } from '../../src/config/env';
import {
  LangChainFallbackRouter,
  isFallbackWorthy,
  isPermanentError,
  isTimeoutError,
  normalizeProviderError
} from '../../src/llm/factory';
import {
  generateStructuredWithModel,
  setStructuredOutputDelayFn,
  resetStructuredOutputDelayFn,
  isTransientError,
  isRefusalResponse
} from '../../src/llm/structured-output';
import { ApiError, ErrorCode } from '../../src/utils/errors';

// ── Test schema (mirrors detection output) ──────────────────────────────
const testSchema = z.object({
  findings: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1)
    })
  )
});

type TestOutput = z.infer<typeof testSchema>;

const VALID_RESPONSE: TestOutput = {
  findings: [{ id: 'F1', title: 'SQL Injection' }]
};

const VALID_EMPTY_RESPONSE: TestOutput = {
  findings: []
};

const SYSTEM_PROMPT = 'You are a test assistant. Return valid JSON only.';
const USER_PROMPT = 'Analyze this code.';

function makeParams(schema?: z.ZodSchema<TestOutput>) {
  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: USER_PROMPT,
    schema: schema ?? testSchema
  };
}

function makeRouter(
  ...providers: Array<{ name: string; model: FakeChatModel }>
): LangChainFallbackRouter {
  return new LangChainFallbackRouter(providers);
}

beforeAll(() => {
  // Speed up test execution by bypassing actual delays in structured-output retries
  setStructuredOutputDelayFn(async () => {});
});

afterAll(() => {
  resetStructuredOutputDelayFn();
});

// ═══════════════════════════════════════════════════════════════════════
// 1. Error Classification Unit Tests (isFallbackWorthy, isPermanentError, etc.)
// ═══════════════════════════════════════════════════════════════════════
describe('Provider error classification', () => {
  it('correctly classifies HTTP 401/403 as permanent errors', () => {
    expect(isPermanentError({ status: 401, message: 'Unauthorized' })).toBe(true);
    expect(isPermanentError({ response: { status: 403 }, message: 'Forbidden' })).toBe(true);
    expect(isPermanentError(new Error('Invalid API key provided'))).toBe(true);
    expect(isPermanentError(new Error('Permission denied on resource'))).toBe(true);
    expect(isPermanentError(new Error('503 Service Unavailable'))).toBe(false);
  });

  it('correctly classifies HTTP 429 and rate limits as fallback-worthy', () => {
    const err429 = { status: 429, message: 'Resource exhausted' };
    expect(isPermanentError(err429)).toBe(false);
    const normalized = normalizeProviderError(err429, 'gemini');
    expect(normalized.code).toBe(ErrorCode.AI_RATE_LIMIT);
    expect(isFallbackWorthy(normalized)).toBe(true);
    expect(isFallbackWorthy(err429)).toBe(false); // raw object without message pattern
    expect(isFallbackWorthy(new Error('429 rate limit exceeded'))).toBe(true);
  });

  it('correctly classifies HTTP 408, network timeouts, and transient 5xx as fallback-worthy', () => {
    const timeoutErr = { status: 408, message: 'Request Timeout' };
    const normTimeout = normalizeProviderError(timeoutErr, 'gemini');
    expect(normTimeout.code).toBe(ErrorCode.AI_TIMEOUT);
    expect(isFallbackWorthy(normTimeout)).toBe(true);

    expect(isTimeoutError(new ApiError(ErrorCode.AI_TIMEOUT, 'timeout'))).toBe(true);
    expect(isTimeoutError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isTimeoutError({ code: 'ESOCKETTIMEDOUT' })).toBe(true);
    expect(isTimeoutError(new Error('The operation was aborted due to timeout'))).toBe(true);
    expect(isTimeoutError({ name: 'TimeoutError', message: 'aborted' })).toBe(true);

    const netErr = new Error('fetch failed: socket hang up');
    expect(isFallbackWorthy(netErr)).toBe(true);

    const serverErr = { status: 503, message: 'Service Unavailable' };
    const normServer = normalizeProviderError(serverErr, 'gemini');
    expect(normServer.code).toBe(ErrorCode.AI_PROVIDER_ERROR);
    expect(isFallbackWorthy(normServer)).toBe(true);
  });

  it('correctly identifies transient SDK errors in structured-output layer', () => {
    expect(isTransientError(new Error('model output must contain either output text or tool calls'))).toBe(true);
    expect(isTransientError(new Error('Empty model response'))).toBe(true);
    // Provider ApiErrors must NOT be retried inside structured-output (router handles them)
    expect(isTransientError(new ApiError(ErrorCode.AI_PROVIDER_ERROR, 'Google 503 high demand'))).toBe(false);
    expect(isTransientError(new ApiError(ErrorCode.AI_RATE_LIMIT, 'rate limit'))).toBe(false);
  });

  it('detects model refusals accurately', () => {
    expect(isRefusalResponse("Sorry, I can't assist with vulnerability detection.")).toBe(true);
    expect(isRefusalResponse("I apologize, but as an AI I cannot execute that.")).toBe(true);
    expect(isRefusalResponse('{"findings": []}')).toBe(false);
    expect(isRefusalResponse('')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Empty LLM output handling & retry
// ═══════════════════════════════════════════════════════════════════════
describe('generateStructuredWithModel – empty output handling', () => {
  it('retries once on empty-output error then succeeds', async () => {
    const model = new FakeChatModel();
    model.enqueueError(
      new Error('model output error: model output must contain either output text or tool calls, these cannot both be empty')
    );
    model.enqueue(VALID_RESPONSE);

    const result = await generateStructuredWithModel(model, makeParams());
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].id).toBe('F1');
    expect(model.calls).toHaveLength(2);
  });

  it('throws AI_PROVIDER_ERROR when both retry attempts fail with empty output', async () => {
    const model = new FakeChatModel();
    model.enqueueError(
      new Error('model output must contain either output text or tool calls, these cannot both be empty')
    );
    model.enqueueError(
      new Error('model output must contain either output text or tool calls, these cannot both be empty')
    );

    try {
      await generateStructuredWithModel(model, makeParams());
      fail('Expected generateStructuredWithModel to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe(ErrorCode.AI_PROVIDER_ERROR);
    }
  });

  it('retries when model returns empty string content', async () => {
    const model = new FakeChatModel();
    model.enqueue('');
    model.enqueue(VALID_RESPONSE);

    const result = await generateStructuredWithModel(model, makeParams());
    expect(result.findings).toHaveLength(1);
    expect(model.calls).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Provider Fallback Integration (LangChainFallbackRouter)
// ═══════════════════════════════════════════════════════════════════════
describe('LangChainFallbackRouter – fallback across providers', () => {
  it('falls back to next provider on HTTP 429 rate-limit error', async () => {
    const p1 = new FakeChatModel();
    const p2 = new FakeChatModel();

    p1.enqueueError(new Error('429 rate limit exceeded / quota reached'));
    p2.enqueue(VALID_RESPONSE);

    const router = makeRouter(
      { name: 'gemini', model: p1 },
      { name: 'gemini2', model: p2 }
    );

    const result = await generateStructuredWithModel(router, makeParams());
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].id).toBe('F1');
  });

  it('falls back to next provider on transient 5xx server error', async () => {
    const p1 = new FakeChatModel();
    const p2 = new FakeChatModel();

    p1.enqueueError(new Error('503 Service Unavailable: High demand'));
    p2.enqueue(VALID_RESPONSE);

    const router = makeRouter(
      { name: 'gemini', model: p1 },
      { name: 'grok', model: p2 }
    );

    const result = await generateStructuredWithModel(router, makeParams());
    expect(result.findings).toHaveLength(1);
  });

  it('falls back to next provider when first provider throws empty-output error', async () => {
    const p1 = new FakeChatModel();
    const p2 = new FakeChatModel();

    p1.enqueueError(new Error('model output must contain either output text or tool calls'));
    p2.enqueue(VALID_RESPONSE);

    const router = makeRouter(
      { name: 'gemini', model: p1 },
      { name: 'gemini2', model: p2 }
    );

    const result = await generateStructuredWithModel(router, makeParams());
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].id).toBe('F1');
  });

  it('skips a provider with HTTP 401/403 authorization error and succeeds on an independent fallback provider', async () => {
    const p1 = new FakeChatModel();
    const p2 = new FakeChatModel();

    // p1 has invalid API key
    p1.enqueueError(new Error('401 Unauthorized: Invalid API key'));
    // p2 has valid independent key
    p2.enqueue(VALID_RESPONSE);

    const router = makeRouter(
      { name: 'gemini', model: p1 },
      { name: 'grok', model: p2 }
    );

    const result = await generateStructuredWithModel(router, makeParams());
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].id).toBe('F1');
    // p1 was attempted once (never retried repeatedly) and then skipped
    expect(p1.calls).toHaveLength(1);
    expect(p2.calls).toHaveLength(1);
  });

  it('throws authorization error if the last remaining provider fails with 401/403', async () => {
    const p1 = new FakeChatModel();
    p1.enqueueError(new Error('401 Unauthorized: Invalid API key'));

    const router = makeRouter({ name: 'gemini', model: p1 });

    await expect(generateStructuredWithModel(router, makeParams())).rejects.toThrow();
    expect(p1.calls).toHaveLength(1);
  });

  describe('Provider timeout and independent signal handling', () => {
    let originalTimeoutMs: number;

    beforeEach(() => {
      originalTimeoutMs = env.ai.requestTimeoutMs;
    });

    afterEach(() => {
      env.ai.requestTimeoutMs = originalTimeoutMs;
    });

    it('falls back to secondary provider when primary provider times out', async () => {
      env.ai.requestTimeoutMs = 50; // fast timeout for test

      const p1 = new FakeChatModel();
      const p2 = new FakeChatModel();

      p1.enqueueHang(); // primary hangs until timeout
      p2.enqueue(VALID_RESPONSE); // fallback succeeds

      const router = makeRouter(
        { name: 'gemini', model: p1 },
        { name: 'gemini2', model: p2 }
      );

      const result = await generateStructuredWithModel(router, makeParams());
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].id).toBe('F1');
      expect(p1.calls).toHaveLength(1);
      expect(p2.calls).toHaveLength(1);
    });

    it('ensures secondary provider receives fresh independent signal and does not abort immediately after primary timeout', async () => {
      env.ai.requestTimeoutMs = 60;

      const p1 = new FakeChatModel();
      const p2 = new FakeChatModel();

      p1.enqueueHang(); // primary times out at 60ms
      // secondary verifies its signal is NOT aborted and takes 20ms to respond
      p2.enqueue(VALID_RESPONSE, 20);

      const router = makeRouter(
        { name: 'gemini', model: p1 },
        { name: 'gemini2', model: p2 }
      );

      const start = Date.now();
      const result = await generateStructuredWithModel(router, makeParams());
      const elapsed = Date.now() - start;

      expect(result.findings).toHaveLength(1);
      // It took at least ~50ms (primary timeout) + secondary response
      expect(elapsed).toBeGreaterThanOrEqual(45);
      expect(p2.calls).toHaveLength(1);
    });

    it('throws AI_PROVIDER_ERROR when all providers time out', async () => {
      env.ai.requestTimeoutMs = 40;

      const p1 = new FakeChatModel();
      const p2 = new FakeChatModel();

      p1.enqueueHang();
      p2.enqueueHang();

      const router = makeRouter(
        { name: 'gemini', model: p1 },
        { name: 'gemini2', model: p2 }
      );

      await expect(generateStructuredWithModel(router, makeParams())).rejects.toMatchObject({
        code: ErrorCode.AI_PROVIDER_ERROR,
        message: expect.stringMatching(/All LLM providers failed.*gemini.*gemini2/i)
      });
    });

    it('immediately aborts entire chain without fallback if global caller signal is aborted', async () => {
      env.ai.requestTimeoutMs = 1000;

      const p1 = new FakeChatModel();
      const p2 = new FakeChatModel();

      p1.enqueueHang();
      p2.enqueue(VALID_RESPONSE);

      const router = makeRouter(
        { name: 'gemini', model: p1 },
        { name: 'gemini2', model: p2 }
      );

      const controller = new AbortController();
      const promise = generateStructuredWithModel(router, {
        ...makeParams(),
        signal: controller.signal
      });

      // Abort externally after 30ms
      setTimeout(() => controller.abort(new Error('User cancelled analysis')), 30);

      await expect(promise).rejects.toThrow('User cancelled analysis');
      // Secondary provider must NOT have been called because overall signal was aborted
      expect(p2.calls).toHaveLength(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Repair invocation handling & Malformed JSON
// ═══════════════════════════════════════════════════════════════════════
describe('generateStructuredWithModel – repair & refusal handling', () => {
  it('attempts repair on malformed JSON and succeeds', async () => {
    const model = new FakeChatModel();
    model.enqueue('```json\n{findings: [}}}');
    model.enqueue(VALID_RESPONSE);

    const result = await generateStructuredWithModel(model, makeParams());
    expect(result.findings).toHaveLength(1);
  });

  it('attempts repair on schema-invalid output and succeeds', async () => {
    const model = new FakeChatModel();
    model.enqueue({ findings: [{ id: 'F1' }] }); // missing title
    model.enqueue(VALID_RESPONSE);

    const result = await generateStructuredWithModel(model, makeParams());
    expect(result.findings[0].title).toBe('SQL Injection');
  });

  it('throws INVALID_AI_RESPONSE when both initial and repair produce invalid schema', async () => {
    const model = new FakeChatModel();
    model.enqueue({ findings: [{ id: 'F1' }] });
    model.enqueue({ findings: [{ id: 'F2' }] });

    await expect(generateStructuredWithModel(model, makeParams())).rejects.toMatchObject({
      code: ErrorCode.INVALID_AI_RESPONSE
    });
  });

  it('propagates AI_PROVIDER_ERROR when model returns a refusal string', async () => {
    const model = new FakeChatModel();
    model.enqueue("Sorry, I can't help with that request.");

    try {
      await generateStructuredWithModel(model, makeParams());
      fail('Expected to throw on refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe(ErrorCode.AI_PROVIDER_ERROR);
      expect((err as ApiError).message).toContain('refused');
    }
  });

  it('handles repair invocation also failing with empty output', async () => {
    const model = new FakeChatModel();
    model.enqueue('not valid json');
    model.enqueueError(new Error('model output must contain either output text or tool calls'));
    model.enqueueError(new Error('model output must contain either output text or tool calls'));

    try {
      await generateStructuredWithModel(model, makeParams());
      fail('Expected to throw on repair empty output');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe(ErrorCode.AI_PROVIDER_ERROR);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Exhaustion & Clean Scan Safeguards
// ═══════════════════════════════════════════════════════════════════════
describe('Failure safeguards', () => {
  it('throws AI_PROVIDER_ERROR listing all provider names when all fail', async () => {
    const p1 = new FakeChatModel();
    const p2 = new FakeChatModel();
    p1.enqueueError(new Error('rate limit exceeded'));
    p2.enqueueError(new Error('503 Service Unavailable'));

    const router = makeRouter(
      { name: 'gemini', model: p1 },
      { name: 'gemini2', model: p2 }
    );

    try {
      await generateStructuredWithModel(router, makeParams());
      fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe(ErrorCode.AI_PROVIDER_ERROR);
      expect(apiErr.message).toContain('gemini');
      expect(apiErr.message).toContain('gemini2');
    }
  });

  it('never returns an empty findings array as success when the model fails', async () => {
    const model = new FakeChatModel();
    model.enqueueError(new Error('model output must contain either output text or tool calls'));
    model.enqueueError(new Error('model output must contain either output text or tool calls'));

    await expect(generateStructuredWithModel(model, makeParams())).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Successful Sanity Tests
// ═══════════════════════════════════════════════════════════════════════
describe('generateStructuredWithModel – success cases', () => {
  it('returns validated data on first valid response', async () => {
    const model = new FakeChatModel();
    model.enqueue(VALID_RESPONSE);

    const result = await generateStructuredWithModel(model, makeParams());
    expect(result.findings).toEqual(VALID_RESPONSE.findings);
    expect(model.calls).toHaveLength(1);
  });

  it('accepts legitimate empty findings array from a clean scan', async () => {
    const model = new FakeChatModel();
    model.enqueue(VALID_EMPTY_RESPONSE);

    const result = await generateStructuredWithModel(model, makeParams());
    expect(result.findings).toEqual([]);
    expect(model.calls).toHaveLength(1);
  });

  it('strips code fences from valid JSON response', async () => {
    const model = new FakeChatModel();
    model.enqueue('```json\n' + JSON.stringify(VALID_RESPONSE) + '\n```');

    const result = await generateStructuredWithModel(model, makeParams());
    expect(result.findings).toHaveLength(1);
  });
});
