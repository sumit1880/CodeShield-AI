import { env } from '../../../config/env';
import { ApiError, ErrorCode } from '../../../utils/errors';
import { logger } from '../../../utils/logger';
import { LlmProvider, LlmRequest, LlmResponse } from '../llm.service';
import { callOpenAiCompatibleChat } from './openai-compatible';

export interface GenericOpenAiProviderOptions {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** Error codes that are worth retrying (same call, same provider) and, at
 *  the router level, worth falling back to the next provider for. */
const RETRYABLE_CODES = new Set<string>([ErrorCode.AI_TIMEOUT, ErrorCode.AI_RATE_LIMIT, ErrorCode.AI_PROVIDER_ERROR]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Implements LlmProvider against any OpenAI-compatible `/chat/completions`
 * endpoint. Used for both Grok (xAI's OpenAI-compatible API) and the
 * user-configured Llama endpoint, so neither needs bespoke client code.
 */
export class GenericOpenAiProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(opts: GenericOpenAiProviderOptions) {
    this.name = opts.name;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const maxAttempts = env.ai.maxRetries + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const { text, usage } = await callOpenAiCompatibleChat(
          { baseUrl: this.baseUrl, apiKey: this.apiKey, model: this.model, timeoutMs: env.ai.requestTimeoutMs },
          request
        );
        return { text, provider: this.name, model: this.model, usage };
      } catch (err) {
        lastError = err;
        const retryable = err instanceof ApiError && RETRYABLE_CODES.has(err.code);
        if (!retryable || attempt >= maxAttempts) {
          throw err;
        }
        const backoffMs = 300 * 2 ** (attempt - 1);
        logger.warn(
          { provider: this.name, attempt, backoffMs, code: (err as ApiError).code },
          `${this.name} request failed, retrying`
        );
        await sleep(backoffMs);
      }
    }

    // Unreachable in practice (loop always returns or throws), but keeps
    // TypeScript's control-flow analysis happy and fails safe if it ever is.
    throw lastError instanceof Error ? lastError : new Error(`${this.name}: request failed`);
  }
}
