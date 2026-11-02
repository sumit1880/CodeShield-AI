describe('buildLlmService', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  it('returns a single Gemini provider directly when it is the only one configured', async () => {
    process.env.LLM_PROVIDER_ORDER = 'gemini';
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY_2 = '';
    process.env.GEMINI_API_KEY_3 = '';
    jest.resetModules();

    const { buildLlmService } = await import('../../src/services/llm/llm-factory');
    const { GeminiService } = await import('../../src/services/llm/gemini.service');

    const service = buildLlmService();
    expect(service).toBeInstanceOf(GeminiService);
  });

  it('wraps multiple configured providers in an LlmRouter, skipping unconfigured ones', async () => {
    process.env.LLM_PROVIDER_ORDER = 'gemini,gemini2,gemini3';
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY_2 = 'test-key-2';
    process.env.GEMINI_API_KEY_3 = ''; // not configured -> skipped
    jest.resetModules();

    const { buildLlmService } = await import('../../src/services/llm/llm-factory');
    const { LlmRouter } = await import('../../src/services/llm/llm-router');

    const service = buildLlmService();
    expect(service).toBeInstanceOf(LlmRouter);
  });

  it('throws a clear error when no provider is configured', async () => {
    process.env.LLM_PROVIDER_ORDER = 'gemini,gemini2,gemini3';
    process.env.GEMINI_API_KEY = '';
    process.env.GEMINI_API_KEY_2 = '';
    process.env.GEMINI_API_KEY_3 = '';
    jest.resetModules();

    const { buildLlmService } = await import('../../src/services/llm/llm-factory');

    expect(() => buildLlmService()).toThrow(/No LLM provider configured/);
  });
});
