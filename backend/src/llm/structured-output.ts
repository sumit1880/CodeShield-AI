import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import { ApiError, ErrorCode } from '../utils/errors';
import { logger } from '../utils/logger';

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
 * Calls the LangChain chat model once for structured output, validates the result
 * against `schema`. On failure performs exactly ONE repair attempt by asking the
 * model to fix its own output. If repair also fails, throws INVALID_AI_RESPONSE.
 *
 * Errors from here are schema/validation failures and must NOT trigger provider
 * fallback in the calling layer.
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

  const attempt = (raw: string): { ok: true; data: T } | { ok: false; error: string } => {
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

  const firstResponse = await model.invoke(
    [
      { role: 'system', content: systemPrompt },
      { role: 'human', content: userPrompt }
    ],
    { signal } as any
  );

  const firstText =
    typeof firstResponse.content === 'string'
      ? firstResponse.content
      : JSON.stringify(firstResponse.content);

  const firstResult = attempt(firstText);
  if (firstResult.ok) return firstResult.data;

  logger.warn({ error: firstResult.error }, 'AI response failed validation, attempting repair');

  if (signal?.aborted) {
    throw signal.reason ?? new Error('Aborted');
  }

  const repairUserPrompt = [
    'Your previous response was invalid. Fix it and return ONLY valid JSON matching the required schema.',
    `Validation error: ${firstResult.error}`,
    'Previous response:',
    firstText
  ].join('\n\n');

  const repairResponse = await model.invoke(
    [
      { role: 'system', content: systemPrompt },
      { role: 'human', content: repairUserPrompt }
    ],
    { signal } as any
  );

  const repairText =
    typeof repairResponse.content === 'string'
      ? repairResponse.content
      : JSON.stringify(repairResponse.content);

  const repairedResult = attempt(repairText);
  if (repairedResult.ok) return repairedResult.data;

  throw new ApiError(
    ErrorCode.INVALID_AI_RESPONSE,
    `AI response could not be validated after repair attempt: ${repairedResult.error}`
  );
}
