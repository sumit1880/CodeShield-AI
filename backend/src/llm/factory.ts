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
 * rate limit, timeout, 5xx, outage, empty response. Only these trigger
 * fallback to the next provider. Schema validation / parse errors from
 * INVALID_AI_RESPONSE must NOT cause fallback (the same model will
 * produce the same bad schema on retry).
 */
const PROVIDER_ERROR_CODES = new Set<string>([
  ErrorCode.AI_RATE_LIMIT,
  ErrorCode.AI_TIMEOUT,
  ErrorCode.AI_PROVIDER_ERROR
]);

export function isRateLimitError(err: unknown): boolean {
  const status = (err as any)?.status ?? (err as any)?.response?.status ?? (err as any)?.code;
  const msg = String((err as any)?.message ?? '');
  return status === 429 || /rate limit|quota|resource_exhausted|too many requests/i.test(msg);
}

export function isServerError(err: unknown): boolean {
  const status = (err as any)?.status ?? (err as any)?.response?.status;
  const msg = String((err as any)?.message ?? '');
  return (
    (typeof status === 'number' && status >= 500 && status < 600) ||
    /5\d{2}|503|502|504|500|unavailable|high demand|overloaded/i.test(msg)
  );
}

export function isTimeoutError(err: unknown): boolean {
  if (err instanceof ApiError && err.code === ErrorCode.AI_TIMEOUT) {
    return true;
  }
  const status = (err as any)?.status ?? (err as any)?.response?.status;
  const code = (err as any)?.code;
  const msg = String((err as any)?.message ?? '');
  const name = String((err as any)?.name ?? '');
  return (
    status === 408 ||
    name === 'TimeoutError' ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    /timeout|timed out|deadline_exceeded|408|abort.*due to timeout/i.test(msg)
  );
}

export function isEmptyOutputError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? '');
  return /model output.*(empty|must contain)/i.test(msg);
}

export function isFallbackWorthy(err: unknown): boolean {
  if (err instanceof ApiError && PROVIDER_ERROR_CODES.has(err.code)) {
    return true;
  }
  if (err instanceof Error) {
    if (isRateLimitError(err) || isServerError(err) || isTimeoutError(err) || isEmptyOutputError(err)) {
      return true;
    }
    const msg = err.message || '';
    if (/model output.*(empty|must contain)/i.test(msg)) return true;
    if (/rate limit|quota|resource_exhausted|429/i.test(msg)) return true;
    if (/5\d{2}|unavailable|high demand|overloaded/i.test(msg)) return true;
    if (/timeout|timed out|deadline_exceeded|408|abort.*due to timeout/i.test(msg)) return true;
    if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|fetch failed/i.test(msg)) return true;
  }
  return false;
}

let fallbackRouterDelayFn: (ms: number) => Promise<void> = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function setFallbackRouterDelayFn(fn: (ms: number) => Promise<void>): void {
  fallbackRouterDelayFn = fn;
}

export function resetFallbackRouterDelayFn(): void {
  fallbackRouterDelayFn = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalizes raw provider errors into typed ApiErrors so the router
 * can make fallback decisions without knowing each provider's SDK internals.
 */
export function normalizeProviderError(err: unknown, providerName: string): ApiError {
  if (err instanceof ApiError) return err;
  const rawMsg = (err as Error)?.message || String(err) || 'unknown';
  if (isRateLimitError(err)) {
    return new ApiError(ErrorCode.AI_RATE_LIMIT, `${providerName} API rate limit exceeded: ${rawMsg}`);
  }
  if (isTimeoutError(err)) {
    return new ApiError(ErrorCode.AI_TIMEOUT, `${providerName} API request timed out: ${rawMsg}`);
  }
  if (isServerError(err)) {
    return new ApiError(ErrorCode.AI_PROVIDER_ERROR, `${providerName} API server error: ${rawMsg}`);
  }
  if (isEmptyOutputError(err)) {
    return new ApiError(ErrorCode.AI_PROVIDER_ERROR, `${providerName} returned empty output: ${rawMsg}`);
  }
  return new ApiError(
    ErrorCode.AI_PROVIDER_ERROR,
    `${providerName} API request failed: ${rawMsg}`
  );
}

/**
 * Returns true if the error indicates a permanent configuration, model-not-found,
 * or authentication problem for the specific provider (e.g. invalid API key, 404 model not found).
 */
export function isPermanentError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? '');
  const status = (err as any)?.status ?? (err as any)?.response?.status;
  // 401/403 = auth/permission errors
  if (status === 401 || status === 403) return true;
  // 404 = model not found or unsupported for API version
  if (status === 404 || /not found for api version|is not found|unsupported for generatecontent|model.*not found/i.test(msg)) {
    return true;
  }
  if (/api.key|invalid.*key|permission.*denied|unauthorized|forbidden/i.test(msg)) return true;
  return false;
}

export interface ProviderEntry {
  name: string;
  model: BaseChatModel;
  modelName?: string;
}

/**
 * A lightweight fallback router around LangChain chat models.
 * Falls back to the next model when the current one throws a
 * provider-side error (rate limit, timeout, 5xx, empty output, or invalid key/model).
 * If a provider fails with an authentication or configuration error (401/403/404),
 * that provider is skipped without retry and the router attempts the next configured
 * independent provider.
 * Schema validation errors from INVALID_AI_RESPONSE propagate immediately without fallback.
 */
export class LangChainFallbackRouter extends BaseChatModel {
  private readonly providers: ProviderEntry[];

  constructor(providers: ProviderEntry[]) {
    super({});
    if (providers.length === 0) {
      throw new Error('LangChainFallbackRouter requires at least one provider');
    }
    this.providers = providers;
  }

  get registeredProviders(): readonly ProviderEntry[] {
    return this.providers;
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
      // If the caller's overall signal was aborted, stop immediately without attempting further providers
      if (options?.signal?.aborted) {
        throw options.signal.reason ?? new Error('Aborted');
      }

      const { name, model } = this.providers[i];
      const start = Date.now();

      logger.info({ provider: name, index: i }, '[LLM] Attempting provider');

      // Create an independent AbortController for this provider attempt so that
      // one provider's timeout aborts only its own in-flight call and does not cancel subsequent providers.
      const providerController = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      let onParentAbort: (() => void) | undefined;

      try {
        const timeoutMs = env.ai.requestTimeoutMs;

        // Propagate caller's overall abort signal to this provider's controller
        if (options?.signal) {
          onParentAbort = () => {
            providerController.abort(options.signal?.reason ?? new Error('Aborted'));
          };
          options.signal.addEventListener('abort', onParentAbort, { once: true });
        }

        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const timeoutErr = new ApiError(ErrorCode.AI_TIMEOUT, `${name} API request timed out after ${timeoutMs}ms`);
            providerController.abort(timeoutErr);
            reject(timeoutErr);
          }, timeoutMs);
        });

        // Pass provider-specific signal to underlying provider model
        const providerOptions = {
          ...options,
          signal: providerController.signal
        };

        const result = await Promise.race([
          model._generate(messages, providerOptions as any, runManager),
          timeoutPromise
        ]);

        const elapsed = Date.now() - start;
        logger.info(
          { provider: name, elapsedMs: elapsed },
          '[LLM] Provider succeeded'
        );
        return result;
      } catch (err) {
        const elapsed = Date.now() - start;

        // If the caller's overall signal was aborted, do not fall back; abort immediately
        if (options?.signal?.aborted) {
          throw options.signal.reason ?? (err instanceof Error ? err : new Error(String(err)));
        }

        const normalized = normalizeProviderError(err, name);
        lastError = normalized;

        const isConfigOrAuthError = isPermanentError(err);
        const next = this.providers[i + 1];

        // If the error is an auth or model-not-found error on this provider:
        // Do not retry this provider, but if another independent provider is available,
        // log a clear warning and fall back to it.
        if (isConfigOrAuthError) {
          logger.warn(
            {
              provider: name,
              error: normalized.message.slice(0, 200),
              elapsedMs: elapsed,
              fallingBackTo: next?.name ?? null
            },
            next
              ? '[LLM] Provider has permanent configuration or auth error (401/403/404); skipping to next provider'
              : '[LLM] Provider has permanent configuration or auth error (401/403/404); no providers left'
          );

          if (!next) {
            break;
          }

          // If this was a 404 model-not-found error, check if subsequent providers share the same model identifier
          const isModel404 =
            (err as any)?.status === 404 ||
            (err as any)?.response?.status === 404 ||
            /not found for api version|is not found|unsupported for generatecontent|model.*not found/i.test(
              (err as any)?.message || ''
            );

          if (isModel404 && this.providers[i].modelName) {
            const failedModel = this.providers[i].modelName;
            while (i + 1 < this.providers.length && this.providers[i + 1].modelName === failedModel) {
              logger.warn(
                { provider: this.providers[i + 1].name, model: failedModel },
                '[LLM] Skipping provider because it uses the identical failing model'
              );
              i++;
            }
          }

          continue;
        }

        if (!isFallbackWorthy(normalized) && !isFallbackWorthy(err)) {
          logger.error(
            { provider: name, error: normalized.message.slice(0, 200), elapsedMs: elapsed },
            '[LLM] Non-fallback error, aborting'
          );
          throw normalized;
        }

        logger.warn(
          {
            provider: name,
            error: normalized.message.slice(0, 200),
            rawError: ((err as Error)?.message || String(err)).slice(0, 200),
            elapsedMs: elapsed,
            fallingBackTo: next?.name ?? null
          },
          next ? '[LLM] Provider failed, falling back' : '[LLM] Provider failed, no providers left'
        );

        if (next && (isServerError(err) || isRateLimitError(err) || isFallbackWorthy(err))) {
          const fallbackDelayMs = 1000;
          logger.info(
            { provider: name, nextProvider: next.name, fallbackDelayMs },
            '[LLM] Backing off before attempting fallback provider'
          );
          await fallbackRouterDelayFn(fallbackDelayMs);
        }
      } finally {
        if (timer) clearTimeout(timer);
        if (options?.signal && onParentAbort) {
          options.signal.removeEventListener('abort', onParentAbort);
        }
      }
    }

    const tried = this.providers.map((p) => p.name).join(' -> ');
    throw new ApiError(
      ErrorCode.AI_PROVIDER_ERROR,
      `All LLM providers failed (${tried}): ${((lastError as Error)?.message ?? 'unknown').slice(0, 300)}`
    );
  }
}

export function buildProviderModel(name: string): ProviderEntry | null {
  switch (name) {
    case 'gemini':
      if (!isProviderConfigured('gemini')) return null;
      return {
        name: 'gemini',
        modelName: env.gemini.model,
        model: new ChatGoogleGenerativeAI({
          apiKey: env.gemini.apiKey,
          model: env.gemini.model,
          maxRetries: env.ai.maxRetries,
          // LOW reduces reasoning token overhead on gemini-3.x flash models.
          // Value must be uppercase per GoogleGenerativeAIThinkingLevel enum.
          thinkingConfig: { thinkingLevel: 'LOW' }
        }) as unknown as BaseChatModel
      };

    case 'gemini2':
      if (!isProviderConfigured('gemini2')) return null;
      // Guard: if GEMINI_API_KEY_2 is identical to GEMINI_API_KEY AND they use the exact same model,
      // they are not distinct provider accounts/configurations; skip duplicate provider.
      if (
        env.gemini2.apiKey &&
        env.gemini.apiKey &&
        env.gemini2.apiKey.trim() === env.gemini.apiKey.trim() &&
        env.gemini2.model === env.gemini.model
      ) {
        logger.warn('[LLM] GEMINI_API_KEY_2 and model are identical to GEMINI_API_KEY; skipping duplicate provider');
        return null;
      }
      return {
        name: 'gemini2',
        modelName: env.gemini2.model,
        model: new ChatGoogleGenerativeAI({
          apiKey: env.gemini2.apiKey,
          model: env.gemini2.model,
          maxRetries: env.ai.maxRetries,
          thinkingConfig: { thinkingLevel: 'LOW' }
        }) as unknown as BaseChatModel
      };

    case 'gemini3':
      if (!isProviderConfigured('gemini3')) return null;
      // Guard: if GEMINI_API_KEY_3 is identical to GEMINI_API_KEY or GEMINI_API_KEY_2 AND they use the exact same model,
      // they are not distinct provider accounts/configurations; skip duplicate provider.
      if (
        (env.gemini3.apiKey &&
          env.gemini.apiKey &&
          env.gemini3.apiKey.trim() === env.gemini.apiKey.trim() &&
          env.gemini3.model === env.gemini.model) ||
        (env.gemini3.apiKey &&
          env.gemini2.apiKey &&
          env.gemini3.apiKey.trim() === env.gemini2.apiKey.trim() &&
          env.gemini3.model === env.gemini2.model)
      ) {
        logger.warn('[LLM] GEMINI_API_KEY_3 and model are identical to an earlier Gemini provider; skipping duplicate provider');
        return null;
      }
      return {
        name: 'gemini3',
        modelName: env.gemini3.model,
        model: new ChatGoogleGenerativeAI({
          apiKey: env.gemini3.apiKey,
          model: env.gemini3.model,
          maxRetries: env.ai.maxRetries,
          thinkingConfig: { thinkingLevel: 'LOW' }
        }) as unknown as BaseChatModel
      };

    case 'grok':
      if (!isProviderConfigured('grok')) return null;
      return {
        name: 'grok',
        modelName: env.llm.grok.model,
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
        modelName: env.llm.llama.model,
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
    .filter((p): p is ProviderEntry => p !== null);

  if (providers.length === 0) {
    throw new Error(
      'No LLM provider configured. Set GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3, GROK_API_KEY+GROK_MODEL, or LLAMA_BASE_URL+LLAMA_MODEL.'
    );
  }

  logger.info({ providers: providers.map((p) => p.name) }, '[LLM] Configured provider chain');

  return new LangChainFallbackRouter(providers);
}
