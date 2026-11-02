import { AllProvidersFailedError } from '../../llm/factory';
import { VerificationResult } from '../../types/findings';
import { ApiError, ErrorCode } from '../../utils/errors';

/**
 * LLM-side failures a verification node must survive: every provider failed, a provider
 * refused, the answer was empty/invalid, or a rate limit / timeout was hit. These are
 * "verification could not be completed", NOT "the analysis failed" — the detection and
 * classification work that already exists must still reach the user.
 */
const RECOVERABLE_CODES = new Set<string>([
  ErrorCode.AI_RATE_LIMIT,
  ErrorCode.AI_TIMEOUT,
  ErrorCode.AI_PROVIDER_ERROR,
  ErrorCode.INVALID_AI_RESPONSE
]);

/**
 * True only for LLM failures worth degrading on. Client cancellation (aborted signal)
 * and programming errors are never swallowed: they must keep propagating.
 */
export function isRecoverableLlmFailure(err: unknown, signal?: AbortSignal): err is ApiError {
  if (signal?.aborted) return false;
  return err instanceof ApiError && RECOVERABLE_CODES.has(err.code);
}

/** Short, secret-free description of why verification could not be completed. */
export function describeLlmFailure(err: ApiError): string {
  if (err instanceof AllProvidersFailedError) {
    const chain = err.attempts.map((a) => `${a.provider}:${a.category}`).join(' -> ');
    return `all LLM providers failed (${chain})`;
  }
  if (err.code === ErrorCode.INVALID_AI_RESPONSE) return 'the model returned an invalid response';
  if (/refus/i.test(err.message)) return 'the model refused the request';
  if (err.code === ErrorCode.AI_RATE_LIMIT) return 'the provider rate limit was hit';
  if (err.code === ErrorCode.AI_TIMEOUT) return 'the provider timed out';
  return `provider error: ${err.message.slice(0, 120)}`;
}

/**
 * Code-assigned verdict for a finding whose verification did not complete. It is never
 * CONFIRMED and never produced by the LLM; finalize reports it as UNVERIFIED (PARTIAL result)
 * and the router treats it as "attempted", so the same failing call is not repeated.
 */
export function unverifiedVerdict(
  findingId: string,
  confidence: number,
  reason: string
): VerificationResult {
  return { id: findingId, status: 'UNVERIFIED', confidence, reason };
}
