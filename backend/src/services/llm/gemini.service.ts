import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env';
import { ApiError, ErrorCode } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { LlmProvider, LlmRequest, LlmResponse } from './llm.service';
import { withTimeout } from './timeout';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Detects Google API rate-limit (429) errors across SDK error shapes. */
function isRateLimitError(err: any): boolean {
  const status = err?.status ?? err?.response?.status ?? err?.code;
  return status === 429 || /rate limit|quota/i.test(String(err?.message || ''));
}

function isServerError(err: any): boolean {
  const status = err?.status ?? err?.response?.status ?? err?.code;
  return typeof status === 'number' && status >= 500 && status < 600;
}

export class GeminiService implements LlmProvider {
  readonly name = 'gemini';
  readonly model: string;
  private client: GoogleGenAI;

  constructor(apiKey: string = env.gemini.apiKey, model: string = env.gemini.model) {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const maxAttempts = env.ai.maxRetries + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await withTimeout(
          this.client.models.generateContent({
            model: this.model,
            contents: request.userPrompt,
            config: {
              systemInstruction: request.systemPrompt,
              ...(request.jsonMode ? { responseMimeType: 'application/json' } : {})
            }
          }),
          env.ai.requestTimeoutMs,
          'Gemini request'
        );
        const text = response.text ?? '';
        const usageMeta = (response as any).usageMetadata;
        return {
          text,
          provider: this.name,
          model: this.model,
          usage: usageMeta
            ? { inputTokens: usageMeta.promptTokenCount, outputTokens: usageMeta.candidatesTokenCount }
            : undefined
        };
      } catch (err) {
        lastError = err;

        if (err instanceof ApiError) {
          // Timeout: don't retry indefinitely, but allow one more attempt.
          if (attempt >= maxAttempts) throw err;
          logger.warn({ provider: this.name, attempt }, 'LLM request timed out, retrying');
          continue;
        }

        if (isRateLimitError(err)) {
          if (attempt >= maxAttempts) {
            throw new ApiError(ErrorCode.AI_RATE_LIMIT, 'Gemini API rate limit exceeded');
          }
          const backoffMs = 500 * 2 ** (attempt - 1);
          logger.warn({ provider: this.name, attempt, backoffMs }, 'Gemini rate limited, backing off');
          await sleep(backoffMs);
          continue;
        }

        if (isServerError(err)) {
          if (attempt >= maxAttempts) {
            throw new ApiError(ErrorCode.AI_PROVIDER_ERROR, 'Gemini API server error');
          }
          const backoffMs = 500 * 2 ** (attempt - 1);
          logger.warn({ provider: this.name, attempt, backoffMs }, 'Gemini server error, retrying');
          await sleep(backoffMs);
          continue;
        }

        // Unknown/non-retryable error class.
        throw new ApiError(
          ErrorCode.AI_PROVIDER_ERROR,
          `Gemini API request failed: ${(err as Error)?.message || 'unknown error'}`
        );
      }
    }

    throw new ApiError(
      ErrorCode.AI_PROVIDER_ERROR,
      `Gemini API request failed after ${maxAttempts} attempts: ${
        (lastError as Error)?.message || 'unknown error'
      }`
    );
  }
}
