/**
 * Provider-agnostic LLM interface. Agents depend on this interface, not on
 * Gemini directly, so the provider can be swapped/mocked easily (this is
 * also what makes the orchestrator/agent tests independent of a real API
 * key: tests inject a fake implementation of this interface).
 */
export interface LlmRequest {
  systemPrompt: string;
  userPrompt: string;
  /** When true, the provider is asked to return a JSON-only response. */
  jsonMode?: boolean;
}

export interface LlmResponse {
  text: string;
}

export interface LlmService {
  generate(request: LlmRequest): Promise<LlmResponse>;
}
