import { LlmRouter } from '../../src/services/llm/llm-router';
import { LlmProvider, LlmRequest } from '../../src/services/llm/llm.service';
import { ApiError, ErrorCode } from '../../src/utils/errors';

function fakeProvider(
  name: string,
  behavior: (req: LlmRequest) => Promise<{ text: string }>
): LlmProvider {
  return {
    name,
    model: `${name}-model`,
    generate: jest.fn(behavior) as any
  };
}

const req: LlmRequest = { systemPrompt: 'sys', userPrompt: 'user', jsonMode: true };

describe('LlmRouter', () => {
  it('throws if constructed with no providers', () => {
    expect(() => new LlmRouter([])).toThrow();
  });

  it('Gemini success: returns Gemini response without calling other providers', async () => {
    const gemini = fakeProvider('gemini', async () => ({ text: '{"ok":true}' }));
    const grok = fakeProvider('grok', async () => ({ text: 'should not be called' }));

    const router = new LlmRouter([gemini, grok]);
    const result = await router.generate(req);

    expect(result.text).toBe('{"ok":true}');
    expect(gemini.generate).toHaveBeenCalledTimes(1);
    expect(grok.generate).not.toHaveBeenCalled();
  });

  it('Gemini failure (rate limit) -> falls back to Grok', async () => {
    const gemini = fakeProvider('gemini', async () => {
      throw new ApiError(ErrorCode.AI_RATE_LIMIT, 'Gemini quota exceeded');
    });
    const grok = fakeProvider('grok', async () => ({ text: '{"from":"grok"}' }));

    const router = new LlmRouter([gemini, grok]);
    const result = await router.generate(req);

    expect(result.text).toBe('{"from":"grok"}');
    expect(gemini.generate).toHaveBeenCalledTimes(1);
    expect(grok.generate).toHaveBeenCalledTimes(1);
  });

  it('Gemini + Grok failure (timeout/outage) -> falls back to Llama', async () => {
    const gemini = fakeProvider('gemini', async () => {
      throw new ApiError(ErrorCode.AI_TIMEOUT, 'Gemini timed out');
    });
    const grok = fakeProvider('grok', async () => {
      throw new ApiError(ErrorCode.AI_PROVIDER_ERROR, 'Grok 503');
    });
    const llama = fakeProvider('llama', async () => ({ text: '{"from":"llama"}' }));

    const router = new LlmRouter([gemini, grok, llama]);
    const result = await router.generate(req);

    expect(result.text).toBe('{"from":"llama"}');
    expect(llama.generate).toHaveBeenCalledTimes(1);
  });

  it('all providers fail -> throws a controlled AI_PROVIDER_ERROR naming every provider tried', async () => {
    const gemini = fakeProvider('gemini', async () => {
      throw new ApiError(ErrorCode.AI_RATE_LIMIT, 'Gemini quota exceeded');
    });
    const grok = fakeProvider('grok', async () => {
      throw new ApiError(ErrorCode.AI_TIMEOUT, 'Grok timed out');
    });
    const llama = fakeProvider('llama', async () => {
      throw new ApiError(ErrorCode.AI_PROVIDER_ERROR, 'Llama endpoint unreachable');
    });

    const router = new LlmRouter([gemini, grok, llama]);

    await expect(router.generate(req)).rejects.toMatchObject({
      code: ErrorCode.AI_PROVIDER_ERROR
    });
    await expect(router.generate(req)).rejects.toThrow(/gemini.*grok.*llama/i);
  });

  it('a provider-side model-unavailable error (4xx) still triggers fallback', async () => {
    const gemini = fakeProvider('gemini', async () => {
      throw new ApiError(ErrorCode.AI_PROVIDER_ERROR, 'Provider request failed (404): model not found');
    });
    const grok = fakeProvider('grok', async () => ({ text: '{"from":"grok"}' }));

    const router = new LlmRouter([gemini, grok]);
    const result = await router.generate(req);

    expect(result.text).toBe('{"from":"grok"}');
  });

  it('a non-provider/application error does NOT trigger fallback', async () => {
    const gemini = fakeProvider('gemini', async () => {
      throw new ApiError(ErrorCode.INVALID_AI_RESPONSE, 'Schema validation failed');
    });
    const grok = fakeProvider('grok', async () => ({ text: 'should not be called' }));

    const router = new LlmRouter([gemini, grok]);

    await expect(router.generate(req)).rejects.toMatchObject({ code: ErrorCode.INVALID_AI_RESPONSE });
    expect(grok.generate).not.toHaveBeenCalled();
  });

  it('an unexpected non-ApiError exception does NOT trigger fallback', async () => {
    const gemini = fakeProvider('gemini', async () => {
      throw new TypeError('unexpected bug');
    });
    const grok = fakeProvider('grok', async () => ({ text: 'should not be called' }));

    const router = new LlmRouter([gemini, grok]);

    await expect(router.generate(req)).rejects.toThrow('unexpected bug');
    expect(grok.generate).not.toHaveBeenCalled();
  });

  it('skips a missing/unconfigured optional provider entirely (single configured provider works standalone)', async () => {
    // Simulates llm-factory only including configured providers: Grok/Llama
    // simply never appear in the list passed to the router when unconfigured.
    const gemini = fakeProvider('gemini', async () => ({ text: '{"ok":true}' }));

    const router = new LlmRouter([gemini]);
    const result = await router.generate(req);

    expect(result.text).toBe('{"ok":true}');
  });
});
