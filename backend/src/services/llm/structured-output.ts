import { z } from 'zod';
import { ApiError, ErrorCode } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { LlmService } from './llm.service';

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
}

function tryParseJson(text: string): unknown {
  const cleaned = stripCodeFences(text);
  return JSON.parse(cleaned);
}

/**
 * Calls the LLM once for structured JSON output, validates the result
 * against `schema`. If the response is malformed (bad JSON or fails
 * validation), performs exactly one repair attempt by asking the model to
 * fix its own output against the validation errors, then gives up cleanly.
 *
 * This still counts as a single "logical" agent call for the purposes of
 * the free-tier rule (repair is a bounded, exceptional recovery path, not
 * a normal per-finding loop).
 */
export async function generateStructured<T>(
  llm: LlmService,
  params: { systemPrompt: string; userPrompt: string; schema: z.ZodSchema<T>; signal?: AbortSignal }
): Promise<T> {
  const { systemPrompt, userPrompt, schema, signal } = params;

  if (signal?.aborted) {
    throw signal.reason ?? new Error('Aborted');
  }

  const first = await llm.generate({ systemPrompt, userPrompt, jsonMode: true, signal });

  const attempt = (raw: string) => {
    let parsed: unknown;
    try {
      parsed = tryParseJson(raw);
    } catch (err) {
      return { ok: false as const, error: `Invalid JSON: ${(err as Error).message}` };
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      return { ok: false as const, error: result.error.message };
    }
    return { ok: true as const, data: result.data };
  };

  const firstResult = attempt(first.text);
  if (firstResult.ok) return firstResult.data;

  logger.warn({ error: firstResult.error }, 'AI response failed validation, attempting repair');

  if (signal?.aborted) {
    throw signal.reason ?? new Error('Aborted');
  }

  const repairPrompt = [
    'Your previous response was invalid. Fix it and return ONLY valid JSON matching the required schema.',
    `Validation error: ${firstResult.error}`,
    'Previous response:',
    first.text
  ].join('\n\n');

  const repaired = await llm.generate({ systemPrompt, userPrompt: repairPrompt, jsonMode: true, signal });
  const repairedResult = attempt(repaired.text);

  if (repairedResult.ok) return repairedResult.data;

  throw new ApiError(
    ErrorCode.INVALID_AI_RESPONSE,
    `AI response could not be validated after repair attempt: ${repairedResult.error}`
  );
}
