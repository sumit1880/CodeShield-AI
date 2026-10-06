import { LlmRequest, LlmResponse, LlmService } from '../../src/services/llm/llm.service';

/**
 * A scriptable fake LlmService: queue up responses (as JSON strings) to be
 * returned in order. Used so agent/orchestrator tests never call a real
 * Gemini API.
 */
interface QueuedResponse {
  text: string;
  /** Optional artificial delay (ms) before resolving, to simulate a slow LLM call in timeout tests. */
  delayMs?: number;
  /** If true, waits until aborted rather than resolving. */
  hangUntilAbort?: boolean;
}

export class FakeLlmService implements LlmService {
  private queue: QueuedResponse[] = []
  public calls: LlmRequest[] = [];

  enqueue(jsonResponse: object | string, delayMs?: number): this {
    this.queue.push({ text: typeof jsonResponse === 'string' ? jsonResponse : JSON.stringify(jsonResponse), delayMs });
    return this;
  }

  /** Queue a response that hangs indefinitely until signal is aborted (for testing abort). */
  enqueueHang(): this {
    this.queue.push({ text: '', hangUntilAbort: true });
    return this;
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    this.calls.push(request);
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error('FakeLlmService: no more queued responses');
    }
    if (next.hangUntilAbort) {
      // Wait forever, but respect abort signal
      await new Promise<void>((_, reject) => {
        if (request.signal?.aborted) {
          return reject(request.signal.reason ?? new Error('Aborted'));
        }
        const onAbort = () => reject(request.signal?.reason ?? new Error('Aborted'));
        request.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (next.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, next.delayMs));
    }
    return { text: next.text };
  }
}
