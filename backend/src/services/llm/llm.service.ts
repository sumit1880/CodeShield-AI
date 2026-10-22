/**
 * Provider-agnostic LLM interface. Agents depend on this interface, not on
 * any specific provider, so providers can be swapped/mocked/fallen-back-on
 * easily (this is also what makes agent/orchestrator tests independent of
 * any real API key: tests inject a fake implementation of this interface).
 */
export interface LlmRequest {
  systemPrompt: string;
  userPrompt: string;
  /** When true, the provider is asked to return a JSON-only response. */
  jsonMode?: boolean;
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  /** Which provider actually produced this response. Optional so existing
   *  callers/tests that only read `.text` are unaffected. */
  provider?: string;
  model?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface LlmService {
  generate(request: LlmRequest): Promise<LlmResponse>;
}

/** An LlmService that also identifies itself, so a router can log which
 *  provider handled/failed a request without each provider hard-coding
 *  logging concerns. */
export interface LlmProvider extends LlmService {
  readonly name: string;
  readonly model: string;
}
