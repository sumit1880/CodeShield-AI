import { LlmRequest, LlmResponse, LlmService } from '../../src/services/llm/llm.service';

/**
 * A scriptable fake LlmService: queue up responses (as JSON strings) to be
 * returned in order. Used so agent/orchestrator tests never call a real
 * Gemini API.
 */
export class FakeLlmService implements LlmService {
  private queue: string[] = [];
  public calls: LlmRequest[] = [];

  enqueue(jsonResponse: object | string): this {
    this.queue.push(typeof jsonResponse === 'string' ? jsonResponse : JSON.stringify(jsonResponse));
    return this;
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    this.calls.push(request);
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error('FakeLlmService: no more queued responses');
    }
    return { text: next };
  }
}
