import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import { env } from '../config/env';
import { ApiError, ErrorCode } from '../utils/errors';
import { logger } from '../utils/logger';

/** Maximum number of invocation attempts per call (initial + retry). */
const MAX_INVOKE_ATTEMPTS = 2;

/** Configurable delay function (can be overridden in tests to 0ms for speed). */
let delayFn: (ms: number) => Promise<void> = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function setStructuredOutputDelayFn(fn: (ms: number) => Promise<void>): void {
  delayFn = fn;
}

export function resetStructuredOutputDelayFn(): void {
  delayFn = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
}

/** Delay between retry attempts in milliseconds. */
const RETRY_DELAY_MS = 1000;

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
}

function tryParseJson(text: string): unknown {
  return JSON.parse(stripCodeFences(text));
}

/**
 * Returns true when the error is a transient invocation failure that
 * is worth retrying on the same model. Notice: Provider-level errors
 * that represent provider outages (503, rate limits) or permanent errors
 * should NOT be retried here within structured-output, because the
 * LangChainFallbackRouter handles provider retries/fallback.
 * Structured-output only retries transient empty responses from the SDK.
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof ApiError) return false;
  const msg = String((err as Error)?.message ?? '');
  // Empty output from the model SDK
  if (/model output.*(empty|must contain)/i.test(msg) || /Empty model response/i.test(msg)) {
    return true;
  }
  return false;
}

/**
 * Returns true when the LLM output text looks like a refusal rather than
 * a genuine attempt at JSON. These should not be retried on the same
 * provider — they indicate the model is refusing the request.
 */
export function isRefusalResponse(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  const lower = text.trim().toLowerCase();
  return (
    lower.startsWith('sorry') ||
    lower.startsWith("i'm sorry") ||
    lower.startsWith('i cannot') ||
    lower.startsWith("i can't") ||
    lower.startsWith('as an ai') ||
    lower.startsWith('i apologize')
  );
}

/**
 * Safely invokes the model with a bounded retry for transient empty-response
 * errors. Returns the text content on success. Throws on permanent failure
 * or after exhausting retries.
 */
async function safeInvoke(
  model: BaseChatModel,
  messages: Array<{ role: string; content: string }>,
  signal: AbortSignal | undefined,
  stage: string
): Promise<string> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_INVOKE_ATTEMPTS; attempt++) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Aborted');
    }

    const start = Date.now();
    try {
      const callSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(env.ai.requestTimeoutMs)])
        : AbortSignal.timeout(env.ai.requestTimeoutMs);
      const response = await model.invoke(messages, { signal: callSignal } as any);

      const text =
        typeof response.content === 'string'
          ? response.content
          : JSON.stringify(response.content);

      const elapsed = Date.now() - start;

      // Guard against empty responses that didn't throw
      if (!text || text.trim().length === 0) {
        logger.warn(
          { stage, attempt, elapsedMs: elapsed },
          '[StructuredOutput] Model returned empty content'
        );
        lastErr = new Error('Empty model response');

        if (attempt < MAX_INVOKE_ATTEMPTS) {
          await delayFn(RETRY_DELAY_MS);
          continue;
        }
        throw lastErr;
      }

      logger.debug(
        { stage, attempt, elapsedMs: elapsed, contentLength: text.length },
        '[StructuredOutput] Model invocation succeeded'
      );

      return text;
    } catch (err) {
      const elapsed = Date.now() - start;
      lastErr = err;

      logger.warn(
        {
          stage,
          attempt,
          elapsedMs: elapsed,
          errorMessage: (err as Error)?.message?.slice(0, 200),
          isTransient: isTransientError(err)
        },
        '[StructuredOutput] Model invocation failed'
      );

      // Don't retry non-transient errors (auth, config, provider errors, etc.)
      if (!isTransientError(err)) {
        throw err;
      }

      // Retry after delay if we have attempts left
      if (attempt < MAX_INVOKE_ATTEMPTS) {
        await delayFn(RETRY_DELAY_MS);
        continue;
      }

      throw err;
    }
  }

  // Should not reach here, but TypeScript needs it
  throw lastErr ?? new Error('All invocation attempts exhausted');
}

/**
 * Calls the LangChain chat model for structured output, validates the result
 * against `schema`. On failure performs exactly ONE repair attempt by asking the
 * model to fix its own output. Each invocation has a bounded retry for transient
 * empty-response errors.
 *
 * If the model returns a refusal (non-JSON prose starting with "Sorry", etc.),
 * the error is re-thrown as AI_PROVIDER_ERROR so the fallback router can try
 * another provider.
 *
 * If repair also fails, throws INVALID_AI_RESPONSE for schema/parse failures,
 * or re-throws the provider error for infrastructure failures.
 */
export async function generateStructuredWithModel<T>(
  model: BaseChatModel,
  params: {
    systemPrompt: string;
    userPrompt: string;
    schema: z.ZodSchema<T>;
    signal?: AbortSignal;
  }
): Promise<T> {
  const { systemPrompt, userPrompt, schema, signal } = params;

  if (signal?.aborted) {
    throw signal.reason ?? new Error('Aborted');
  }

  const validate = (raw: string): { ok: true; data: T } | { ok: false; error: string } => {
    // Check for refusal responses before attempting JSON parse
    if (isRefusalResponse(raw)) {
      return { ok: false, error: `Model refused the request: "${raw.slice(0, 100)}..."` };
    }

    let parsed: unknown;
    try {
      parsed = tryParseJson(raw);
    } catch (err) {
      return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      return { ok: false, error: result.error.message };
    }
    return { ok: true, data: result.data };
  };

  // ── First invocation ──────────────────────────────────────────────────
  let firstText: string;
  try {
    firstText = await safeInvoke(
      model,
      [
        { role: 'system', content: systemPrompt },
        { role: 'human', content: userPrompt }
      ],
      signal,
      'initial'
    );
  } catch (err) {
    if (err instanceof ApiError) {
      throw err;
    }
    // All retries exhausted — re-throw as a provider error so the
    // fallback router can try the next provider.
    throw toProviderError(err, 'Initial invocation failed after retries');
  }

  const firstResult = validate(firstText);
  if (firstResult.ok) return firstResult.data;

  // If the model refused, throw as a provider error for fallback
  if (isRefusalResponse(firstText)) {
    throw new ApiError(
      ErrorCode.AI_PROVIDER_ERROR,
      `Model refused the analysis request: "${firstText.slice(0, 100)}..."`
    );
  }

  logger.warn(
    { error: firstResult.error.slice(0, 300) },
    '[StructuredOutput] First response failed validation, attempting repair'
  );

  if (signal?.aborted) {
    throw signal.reason ?? new Error('Aborted');
  }

  // ── Repair invocation ─────────────────────────────────────────────────
  const repairUserPrompt = [
    'Your previous response was invalid JSON or did not match the required schema.',
    'Return ONLY a valid JSON object matching the schema. No markdown fences, no explanatory text.',
    `Validation error: ${firstResult.error.slice(0, 500)}`
  ].join('\n\n');

  let repairText: string;
  try {
    repairText = await safeInvoke(
      model,
      [
        { role: 'system', content: systemPrompt },
        { role: 'human', content: repairUserPrompt }
      ],
      signal,
      'repair'
    );
  } catch (err) {
    if (err instanceof ApiError) {
      throw err;
    }
    // Repair invocation also failed — re-throw as provider error
    throw toProviderError(err, 'Repair invocation failed after retries');
  }

  const repairedResult = validate(repairText);
  if (repairedResult.ok) return repairedResult.data;

  // If repair also returned a refusal, throw as provider error
  if (isRefusalResponse(repairText)) {
    throw new ApiError(
      ErrorCode.AI_PROVIDER_ERROR,
      `Model refused the repair request: "${repairText.slice(0, 100)}..."`
    );
  }

  throw new ApiError(
    ErrorCode.INVALID_AI_RESPONSE,
    `AI response could not be validated after repair attempt: ${repairedResult.error.slice(0, 500)}`
  );
}

/**
 * Wraps an unknown error into an ApiError with AI_PROVIDER_ERROR code
 * if it isn't already an ApiError. This ensures the LangChainFallbackRouter
 * treats it as fallback-worthy.
 */
function toProviderError(err: unknown, context: string): ApiError {
  if (err instanceof ApiError) return err;
  const msg = (err as Error)?.message ?? String(err);
  return new ApiError(
    ErrorCode.AI_PROVIDER_ERROR,
    `${context}: ${msg.slice(0, 300)}`
  );
}
