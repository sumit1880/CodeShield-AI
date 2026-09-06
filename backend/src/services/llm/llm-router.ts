import { ApiError, ErrorCode } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { LlmProvider, LlmRequest, LlmResponse, LlmService } from './llm.service';

/** Only these error classes are considered "the provider is having a
 *  problem" (quota/rate-limit, timeout, outage, 5xx, unavailable model) and
 *  therefore worth falling back from. Anything else (e.g. an application
 *  bug) propagates immediately instead of silently burning quota on every
 *  configured provider in turn. */
const FALLBACK_WORTHY_CODES = new Set<string>([
  ErrorCode.AI_RATE_LIMIT,
  ErrorCode.AI_TIMEOUT,
  ErrorCode.AI_PROVIDER_ERROR
]);

function isFallbackWorthy(err: unknown): boolean {
  return err instanceof ApiError && FALLBACK_WORTHY_CODES.has(err.code);
}

/**
 * Tries each configured provider in order (Gemini first by default) and
 * falls back to the next on quota/timeout/outage/5xx/model-unavailable
 * errors. Implements the same LlmService interface as a single provider, so
 * agents and `generateStructured` never know a router — vs. a single
 * provider — is underneath them.
 */
export class LlmRouter implements LlmService {
  constructor(private readonly providers: LlmProvider[]) {
    if (providers.length === 0) {
      throw new Error('LlmRouter requires at least one configured provider');
    }
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    let lastError: unknown;

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      logger.info({ provider: provider.name, model: provider.model }, '[LLM] Attempting provider');

      try {
        const response = await provider.generate(request);
        logger.info({ provider: provider.name, model: provider.model }, '[LLM] Provider succeeded');
        return response;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : 'Unknown error';

        if (!isFallbackWorthy(err)) {
          logger.error(
            { provider: provider.name, error: message },
            '[LLM] Non-fallback-worthy error from provider, aborting without trying further providers'
          );
          throw err;
        }

        const next = this.providers[i + 1];
        logger.warn(
          { provider: provider.name, error: message, fallingBackTo: next?.name },
          next ? '[LLM] Provider failed, falling back to next provider' : '[LLM] Provider failed, no providers left'
        );
      }
    }

    const triedNames = this.providers.map((p) => p.name).join(' -> ');
    const lastMessage = lastError instanceof Error ? lastError.message : 'unknown error';
    throw new ApiError(
      ErrorCode.AI_PROVIDER_ERROR,
      `All configured LLM providers failed (${triedNames}). Last error: ${lastMessage}`
    );
  }
}
