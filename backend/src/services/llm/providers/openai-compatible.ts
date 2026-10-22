import { ApiError, ErrorCode } from '../../../utils/errors';
import { LlmRequest } from '../llm.service';

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
}

export interface OpenAiCompatibleResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

async function safeText(res: { text: () => Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Calls a `/chat/completions` endpoint compatible with the OpenAI API shape.
 * Used for Grok (xAI) and for the user-configured Llama endpoint, so any
 * OpenAI-compatible inference provider (Groq, Together, OpenRouter,
 * self-hosted vLLM/Ollama, etc.) works without provider-specific code.
 *
 * Never executes or evaluates anything from the request/response — this is
 * a plain JSON-over-HTTP call.
 */
export async function callOpenAiCompatibleChat(
  config: OpenAiCompatibleConfig,
  request: LlmRequest
): Promise<OpenAiCompatibleResult> {
  if (request.signal?.aborted) {
    throw request.signal.reason ?? new Error('Aborted');
  }

  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const body: Record<string, unknown> = {
    model: config.model,
    temperature: 0,
    messages: [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userPrompt }
    ]
  };
  if (request.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (request.signal) {
    request.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    if (request.signal?.aborted) {
      throw request.signal.reason ?? new Error('Aborted');
    }
    if ((err as Error)?.name === 'AbortError') {
      throw new ApiError(ErrorCode.AI_TIMEOUT, `Request to ${config.baseUrl} timed out after ${config.timeoutMs}ms`);
    }
    throw new ApiError(
      ErrorCode.AI_PROVIDER_ERROR,
      `Network error calling ${config.baseUrl}: ${(err as Error)?.message || 'unknown error'}`
    );
  } finally {
    clearTimeout(timer);
    if (request.signal) {
      request.signal.removeEventListener('abort', onAbort);
    }
  }

  if (response.status === 429) {
    throw new ApiError(ErrorCode.AI_RATE_LIMIT, `Rate limited by provider at ${config.baseUrl}`);
  }
  if (response.status >= 500) {
    throw new ApiError(ErrorCode.AI_PROVIDER_ERROR, `Provider server error (${response.status}) at ${config.baseUrl}`);
  }
  if (!response.ok) {
    // Other 4xx (bad/expired key, unknown model, malformed request) are still
    // treated as a provider-level failure worth falling back from — a
    // misconfigured or discontinued model on one provider shouldn't take
    // down the whole analysis if another provider is healthy.
    const text = await safeText(response);
    throw new ApiError(
      ErrorCode.AI_PROVIDER_ERROR,
      `Provider request failed (${response.status}) at ${config.baseUrl}: ${truncate(text, 200)}`
    );
  }

  let data: any;
  try {
    data = await response.json();
  } catch (err) {
    throw new ApiError(ErrorCode.AI_PROVIDER_ERROR, `Provider at ${config.baseUrl} returned non-JSON output`);
  }

  const text = data?.choices?.[0]?.message?.content ?? '';
  const usage = data?.usage
    ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
    : undefined;

  return { text, usage };
}
