import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import { env, isProviderConfigured } from '../config/env';
import { logger } from '../utils/logger';
import { ApiError, ErrorCode } from '../utils/errors';

// xAI Grok is OpenAI-compatible at this base URL
const XAI_BASE_URL = 'https://api.x.ai/v1';

/**
 * Error codes that represent provider-side infrastructure failures:
 * rate limit, timeout, 5xx, outage. Only these trigger fallback to the next
 * provider. Schema validation / parse errors must NOT cause fallback.
 */
const PROVIDER_ERROR_CODES = new Set<string>([
  ErrorCode.AI_RATE_LIMIT,
  ErrorCode.AI_TIMEOUT,
  ErrorCode.AI_PROVIDER_ERROR
]);

function isFallbackWorthy(err: unknown): boolean {
  return err instanceof ApiError && PROVIDER_ERROR_CODES.has(err.code);
}

function isRateLimitError(err: unknown): boolean {
  const status = (err as any)?.status ?? (err as any)?.response?.status ?? (err as any)?.code;
  return status === 429 || /rate limit|quota|resource_exhausted/i.test(String((err as any)?.message || ''));
}

function isServerError(err: unknown): boolean {
  const status = (err as any)?.status ?? (err as any)?.response?.status;
  return (
    (typeof status === 'number' && status >= 500 && status < 600) ||
    /503|unavailable|high demand/i.test(String((err as any)?.message || ''))
  );
}

function isTimeoutError(err: unknown): boolean {
  const msg = (err as any)?.message ?? '';
  return /timeout|timed out|deadline_exceeded/i.test(msg) || (err instanceof ApiError && err.code === ErrorCode.AI_TIMEOUT);
}

/**
 * Normalizes raw provider errors into typed ApiErrors so the router
 * can make fallback decisions without knowing each provider's SDK internals.
 */
function normalizeProviderError(err: unknown, providerName: string): ApiError {
  if (err instanceof ApiError) return err;
  if (isRateLimitError(err)) {
    return new ApiError(ErrorCode.AI_RATE_LIMIT, `${providerName} API rate limit exceeded`);
  }
  if (isTimeoutError(err)) {
    return new ApiError(ErrorCode.AI_TIMEOUT, `${providerName} API request timed out`);
  }
  if (isServerError(err)) {
    return new ApiError(ErrorCode.AI_PROVIDER_ERROR, `${providerName} API server error`);
  }
  return new ApiError(
    ErrorCode.AI_PROVIDER_ERROR,
    `${providerName} API request failed: ${(err as Error)?.message || 'unknown'}`
  );
}

/**
 * A lightweight fallback router around LangChain chat models.
 * Falls back to the next model ONLY when the current one throws a
 * provider-side error (rate limit, timeout, 5xx). Schema validation
 * errors propagate immediately without fallback.
 */
export class LangChainFallbackRouter extends BaseChatModel {
  private readonly providers: Array<{ name: string; model: BaseChatModel }>;

  constructor(providers: Array<{ name: string; model: BaseChatModel }>) {
    super({});
    if (providers.length === 0) {
      throw new Error('LangChainFallbackRouter requires at least one provider');
    }
    this.providers = providers;
  }

  _llmType(): string {
    return 'fallback-router';
  }

  async _generate(
    messages: import('@langchain/core/messages').BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: import('@langchain/core/callbacks/manager').CallbackManagerForLLMRun
  ): Promise<import('@langchain/core/outputs').ChatResult> {
    let lastError: unknown;

    for (let i = 0; i < this.providers.length; i++) {
      const { name, model } = this.providers[i];
      logger.info({ provider: name }, '[LLM] Attempting provider');

      try {
        // Delegate to the underlying LangChain model's _generate
        const result = await model._generate(messages, options as any, runManager);
        logger.info({ provider: name }, '[LLM] Provider succeeded');
        return result;
      } catch (err) {
        const normalized = normalizeProviderError(err, name);
        lastError = normalized;

        if (!isFallbackWorthy(normalized)) {
          logger.error(
            { provider: name, error: normalized.message },
            '[LLM] Non-fallback error, aborting'
          );
          throw normalized;
        }

        const next = this.providers[i + 1];
        logger.warn(
          { provider: name, error: normalized.message, fallingBackTo: next?.name },
          next ? '[LLM] Provider failed, falling back' : '[LLM] Provider failed, no providers left'
        );
      }
    }

    const tried = this.providers.map((p) => p.name).join(' -> ');
    throw new ApiError(
      ErrorCode.AI_PROVIDER_ERROR,
      `All LLM providers failed (${tried}): ${(lastError as Error)?.message ?? 'unknown'}`
    );
  }
}

function buildProviderModel(name: string): { name: string; model: BaseChatModel } | null {
  switch (name) {
    case 'gemini':
      if (!isProviderConfigured('gemini')) return null;
      return {
        name: 'gemini',
        model: new ChatGoogleGenerativeAI({
          apiKey: env.gemini.apiKey,
          model: env.gemini.model,
          maxRetries: env.ai.maxRetries
        }) as unknown as BaseChatModel
      };

    case 'gemini2':
      if (!isProviderConfigured('gemini2')) return null;
      return {
        name: 'gemini2',
        model: new ChatGoogleGenerativeAI({
          apiKey: env.gemini2.apiKey,
          model: env.gemini2.model,
          maxRetries: env.ai.maxRetries
        }) as unknown as BaseChatModel
      };

    case 'grok':
      if (!isProviderConfigured('grok')) return null;
      return {
        name: 'grok',
        model: new ChatOpenAI({
          apiKey: env.llm.grok.apiKey,
          model: env.llm.grok.model,
          configuration: { baseURL: XAI_BASE_URL },
          maxRetries: env.ai.maxRetries,
          timeout: env.ai.requestTimeoutMs
        }) as unknown as BaseChatModel
      };

    case 'llama':
      if (!isProviderConfigured('llama')) return null;
      return {
        name: 'llama',
        model: new ChatOpenAI({
          apiKey: env.llm.llama.apiKey || 'noop',
          model: env.llm.llama.model,
          configuration: { baseURL: env.llm.llama.baseUrl },
          maxRetries: env.ai.maxRetries,
          timeout: env.ai.requestTimeoutMs
        }) as unknown as BaseChatModel
      };

    default:
      logger.warn({ name }, '[LLM] Unknown provider, skipping');
      return null;
  }
}

/**
 * Builds a LangChain BaseChatModel from the configured provider chain.
 * Uses LangChainFallbackRouter with provider-error-only fallback semantics.
 */
export function buildChatModel(): BaseChatModel {
  const providers = env.llm.providerOrder
    .map(buildProviderModel)
    .filter((p): p is { name: string; model: BaseChatModel } => p !== null);

  if (providers.length === 0) {
    throw new Error(
      'No LLM provider configured. Set GEMINI_API_KEY, GROK_API_KEY+GROK_MODEL, or LLAMA_BASE_URL+LLAMA_MODEL.'
    );
  }

  logger.info({ providers: providers.map((p) => p.name) }, '[LLM] Configured provider chain');

  return new LangChainFallbackRouter(providers);
}
