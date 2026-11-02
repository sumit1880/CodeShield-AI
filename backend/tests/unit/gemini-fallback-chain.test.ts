import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import {
  AbortableChatGoogleGenerativeAI,
  AllProvidersFailedError,
  LangChainFallbackRouter,
  buildChatModel,
  buildProviderModel,
  classifyProviderError,
  resetProviderHealth,
  setFallbackRouterDelayFn,
  resetFallbackRouterDelayFn
} from '../../src/llm/factory';
import { generateStructuredWithModel, setStructuredOutputDelayFn, resetStructuredOutputDelayFn } from '../../src/llm/structured-output';
import { env } from '../../src/config/env';
import { ApiError, ErrorCode } from '../../src/utils/errors';
import { FakeChatModel } from '../../src/llm/fake-chat-model';

const schema = z.object({ ok: z.boolean() });
const GOOD = { ok: true };

function httpError(status: number, message: string): Error {
  const e: any = new Error(message);
  e.status = status;
  return e;
}

function chain(p1: FakeChatModel, p2?: FakeChatModel, p3?: FakeChatModel) {
  const entries = [{ name: 'gemini', model: p1, modelName: 'model-1' }] as any[];
  if (p2) entries.push({ name: 'gemini2', model: p2, modelName: 'model-2' });
  if (p3) entries.push({ name: 'gemini3', model: p3, modelName: 'model-3' });
  return new LangChainFallbackRouter(entries);
}

const run = (router: LangChainFallbackRouter) =>
  generateStructuredWithModel(router, { systemPrompt: 's', userPrompt: 'u', schema });

const saved = { timeout: env.ai.requestTimeoutMs, cooldown: env.ai.providerCooldownMs, permanent: env.ai.permanentCooldownMs };

beforeEach(() => {
  resetProviderHealth();
  setFallbackRouterDelayFn(async () => {});
  setStructuredOutputDelayFn(async () => {});
  (env.ai as any).requestTimeoutMs = 80;
  (env.ai as any).providerCooldownMs = 0;
  (env.ai as any).permanentCooldownMs = 0;
});

afterEach(() => {
  resetFallbackRouterDelayFn();
  resetStructuredOutputDelayFn();
  (env.ai as any).requestTimeoutMs = saved.timeout;
  (env.ai as any).providerCooldownMs = saved.cooldown;
  (env.ai as any).permanentCooldownMs = saved.permanent;
});

describe('Gemini chain: gemini -> gemini2 -> gemini3', () => {
  it('gemini succeeds: later providers are never called', async () => {
    const p1 = new FakeChatModel().enqueue(GOOD);
    const p2 = new FakeChatModel();
    expect(await run(chain(p1, p2))).toEqual(GOOD);
    expect(p2.calls).toHaveLength(0);
  });

  it('gemini times out -> gemini2 succeeds, and the timed-out request is aborted', async () => {
    const p1 = new FakeChatModel().enqueueHang();
    const p2 = new FakeChatModel().enqueue(GOOD);
    const spy = jest.spyOn(p1, '_generate');
    expect(await run(chain(p1, p2))).toEqual(GOOD);
    const signal = (spy.mock.calls[0][1] as any).signal as AbortSignal;
    expect(signal.aborted).toBe(true); // cancellation reached the provider call
    const p2Signal = ((jest.spyOn(p2, '_generate').mock.calls[0]?.[1]) as any)?.signal;
    expect(p2Signal === undefined || p2Signal.aborted === false).toBe(true);
  });

  it('gemini 503 -> gemini2 succeeds', async () => {
    const p1 = new FakeChatModel().enqueueError(httpError(503, '[503] This model is currently experiencing high demand.'));
    const p2 = new FakeChatModel().enqueue(GOOD);
    expect(await run(chain(p1, p2))).toEqual(GOOD);
    expect(p2.calls).toHaveLength(1);
  });

  it('gemini and gemini2 fail -> gemini3 succeeds', async () => {
    const p1 = new FakeChatModel().enqueueHang();
    const p2 = new FakeChatModel().enqueueError(httpError(429, 'Resource exhausted'));
    const p3 = new FakeChatModel().enqueue(GOOD);
    expect(await run(chain(p1, p2, p3))).toEqual(GOOD);
    expect(p3.calls).toHaveLength(1);
  });

  it('all three fail -> AllProvidersFailedError listing each attempt (no silent success)', async () => {
    const p1 = new FakeChatModel().enqueueHang();
    const p2 = new FakeChatModel().enqueueError(httpError(503, 'high demand'));
    const p3 = new FakeChatModel().enqueueError(httpError(500, 'Internal error'));
    const err: any = await run(chain(p1, p2, p3)).catch((e) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect(err.code).toBe(ErrorCode.AI_PROVIDER_ERROR);
    expect(err.attempts.map((a: any) => [a.provider, a.category])).toEqual([
      ['gemini', 'timeout'],
      ['gemini2', 'overloaded'],
      ['gemini3', 'server_error']
    ]);
    // the exhausted chain must not be re-run by the structured-output layer
    expect(p2.calls).toHaveLength(1);
    expect(p3.calls).toHaveLength(1);
  });

  it('invalid API key on one provider: reported as auth, next provider used', async () => {
    const p1 = new FakeChatModel().enqueueError(httpError(400, '[400 Bad Request] API key not valid. Please pass a valid API key.'));
    const p2 = new FakeChatModel().enqueue(GOOD);
    expect(classifyProviderError(httpError(400, 'API key not valid. Please pass a valid API key.'))).toBe('auth');
    expect(await run(chain(p1, p2))).toEqual(GOOD);
  });

  it('invalid model ID on one provider: reported as model_not_found, next provider used', async () => {
    const p1 = new FakeChatModel().enqueueError(httpError(404, 'models/gemini-x is not found for API version v1beta'));
    const p2 = new FakeChatModel().enqueue(GOOD);
    expect(classifyProviderError(httpError(404, 'models/gemini-x is not found'))).toBe('model_not_found');
    expect(await run(chain(p1, p2))).toEqual(GOOD);
  });

  it('malformed JSON from gemini triggers fallback to gemini2 (not just a repair on the same chain)', async () => {
    const p1 = new FakeChatModel().enqueue('this is {not json');
    const p2 = new FakeChatModel().enqueue(GOOD);
    expect(await run(chain(p1, p2))).toEqual(GOOD);
    expect(p2.calls).toHaveLength(1);
  });

  it('empty response from gemini triggers fallback to gemini2', async () => {
    const p1 = new FakeChatModel().enqueue('   ');
    const p2 = new FakeChatModel().enqueue(GOOD);
    expect(await run(chain(p1, p2))).toEqual(GOOD);
  });

  it('every provider returns empty -> failure, not an empty "clean" result', async () => {
    const router = chain(new FakeChatModel().enqueue(''), new FakeChatModel().enqueue(''));
    await expect(run(router)).rejects.toBeInstanceOf(AllProvidersFailedError);
  });

  it('every provider returns malformed JSON -> INVALID_AI_RESPONSE (validation is not weakened)', async () => {
    const mk = () => new FakeChatModel().enqueue('nope {').enqueue('still nope {');
    const err: any = await run(chain(mk(), mk())).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe(ErrorCode.INVALID_AI_RESPONSE);
  });

  it('a valid response is never treated as a failure', async () => {
    const p1 = new FakeChatModel().enqueue('```json\n{"ok": true}\n```');
    const p2 = new FakeChatModel();
    expect(await run(chain(p1, p2))).toEqual(GOOD);
    expect(p2.calls).toHaveLength(0);
  });
});

describe('Provider isolation and cooldown', () => {
  it('after a timeout, gemini is skipped for later calls (no repeated 50s waits); gemini2 state is unaffected', async () => {
    (env.ai as any).providerCooldownMs = 60_000;
    const p1 = new FakeChatModel().enqueueHang();
    const p2 = new FakeChatModel().enqueue(GOOD).enqueue(GOOD);
    const router = chain(p1, p2);
    await run(router);
    await run(router);
    expect(p1.calls).toHaveLength(1); // second call skipped gemini entirely
    expect(p2.calls).toHaveLength(2);
  });

  it('never fails without trying: when every provider is cooling down, the chain is attempted anyway', async () => {
    (env.ai as any).providerCooldownMs = 60_000;
    const p1 = new FakeChatModel().enqueueError(httpError(503, 'high demand')).enqueue(GOOD);
    const router = chain(p1);
    await expect(run(router)).rejects.toBeInstanceOf(AllProvidersFailedError);
    expect(await run(router)).toEqual(GOOD);
  });

  it('a content failure (bad JSON) does not put a healthy provider into cooldown', async () => {
    (env.ai as any).providerCooldownMs = 60_000;
    const p1 = new FakeChatModel().enqueue('bad {').enqueue(GOOD);
    const p2 = new FakeChatModel().enqueue(GOOD);
    const router = chain(p1, p2);
    await run(router);
    await run(router);
    expect(p1.calls).toHaveLength(2);
  });
});

describe('Provider construction: Gemini only, correct key/model mapping', () => {
  const keep = {
    k1: env.gemini.apiKey, m1: env.gemini.model,
    k2: env.gemini2.apiKey, m2: env.gemini2.model,
    k3: env.gemini3.apiKey, m3: env.gemini3.model,
    order: env.llm.providerOrder
  };
  afterEach(() => {
    (env.gemini as any).apiKey = keep.k1; (env.gemini as any).model = keep.m1;
    (env.gemini2 as any).apiKey = keep.k2; (env.gemini2 as any).model = keep.m2;
    (env.gemini3 as any).apiKey = keep.k3; (env.gemini3 as any).model = keep.m3;
    (env.llm as any).providerOrder = keep.order;
  });

  it('maps each provider to its own key and model, in order gemini, gemini2, gemini3', () => {
    Object.assign(env.gemini, { apiKey: 'key-one', model: 'model-one' });
    Object.assign(env.gemini2, { apiKey: 'key-two', model: 'model-two' });
    Object.assign(env.gemini3, { apiKey: 'key-three', model: 'model-three' });
    (env.llm as any).providerOrder = ['gemini', 'gemini2', 'gemini3'];

    const router = buildChatModel() as LangChainFallbackRouter;
    const got = router.registeredProviders.map((p) => [p.name, (p.model as any).apiKey, p.modelName, (p.model as any).model]);
    expect(got).toEqual([
      ['gemini', 'key-one', 'model-one', 'model-one'],
      ['gemini2', 'key-two', 'model-two', 'model-two'],
      ['gemini3', 'key-three', 'model-three', 'model-three']
    ]);
    router.registeredProviders.forEach((p) => expect(p.model).toBeInstanceOf(AbortableChatGoogleGenerativeAI));
  });

  it('rejects every non-Gemini provider name', () => {
    for (const name of ['grok', 'groq', 'llama', 'openai', 'xai', '']) {
      expect(buildProviderModel(name)).toBeNull();
    }
  });

  it('LLM_PROVIDER_ORDER can never introduce a non-Gemini provider', async () => {
    const prev = { ...process.env };
    process.env.LLM_PROVIDER_ORDER = 'grok,gemini,llama,gemini2,openai,gemini3';
    jest.resetModules();
    const fresh = await import('../../src/config/env');
    expect(fresh.env.llm.providerOrder).toEqual(['gemini', 'gemini2', 'gemini3']);
    process.env = prev;
    jest.resetModules();
  });

  it('does not duplicate a provider that reuses the same key AND model', () => {
    Object.assign(env.gemini, { apiKey: 'same', model: 'm' });
    Object.assign(env.gemini2, { apiKey: 'same', model: 'm' });
    Object.assign(env.gemini3, { apiKey: 'other', model: 'm' });
    expect(buildProviderModel('gemini2')).toBeNull();
    expect(buildProviderModel('gemini3')).not.toBeNull();
  });
});

describe('AbortableChatGoogleGenerativeAI: abort reaches the Google HTTP request', () => {
  it('forwards the call signal to client.generateContent and rejects when aborted', async () => {
    const model = new AbortableChatGoogleGenerativeAI({ apiKey: 'test-key', model: 'm', maxRetries: 0 } as any);
    let seen: AbortSignal | undefined;
    (model as any).client = {
      generateContent: jest.fn((_req: unknown, opts?: { signal?: AbortSignal }) => {
        seen = opts?.signal;
        return new Promise((_, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason ?? new Error('aborted')), { once: true });
        });
      })
    };

    const controller = new AbortController();
    const pending = model._generate([new HumanMessage('hi')], { signal: controller.signal } as any);
    setTimeout(() => controller.abort(new Error('timeout')), 10);

    await expect(pending).rejects.toBeDefined();
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(true);
  });
});

describe('Router secrecy', () => {
  it('error messages and attempts never contain API keys', async () => {
    const p1 = new FakeChatModel().enqueueError(httpError(503, 'high demand'));
    const err: any = await run(chain(p1)).catch((e) => e);
    expect(JSON.stringify(err.attempts)).not.toMatch(/key/i);
    expect(err.message).not.toContain(env.gemini.apiKey);
  });
});
