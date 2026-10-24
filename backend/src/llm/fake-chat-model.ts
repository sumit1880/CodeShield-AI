import { BaseChatModel, type BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { BaseMessage, AIMessage } from '@langchain/core/messages';
import { ChatResult, ChatGeneration } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';

interface QueuedResponse {
  text: string;
  delayMs?: number;
  hangUntilAbort?: boolean;
  error?: Error;
}

/**
 * Scriptable fake chat model for tests.
 * Mirrors the interface of FakeLlmService but extends BaseChatModel so
 * it plugs directly into LangChain nodes and withStructuredOutput() calls.
 */
export class FakeChatModel extends BaseChatModel {
  private queue: QueuedResponse[] = [];
  public calls: BaseMessage[][] = [];

  constructor(fields?: BaseChatModelParams) {
    super(fields ?? {});
  }

  _llmType(): string {
    return 'fake';
  }

  enqueue(jsonResponse: object | string, delayMs?: number): this {
    const text =
      typeof jsonResponse === 'string' ? jsonResponse : JSON.stringify(jsonResponse);
    this.queue.push({ text, delayMs });
    return this;
  }

  enqueueHang(): this {
    this.queue.push({ text: '', hangUntilAbort: true });
    return this;
  }

  /** Enqueue an error to be thrown on the next invocation. */
  enqueueError(error: Error): this {
    this.queue.push({ text: '', error });
    return this;
  }

  async _generate(
    messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    this.calls.push(messages);

    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error('FakeChatModel: no more queued responses');
    }

    // Throw queued error
    if (next.error) {
      throw next.error;
    }

    if (next.hangUntilAbort) {
      await new Promise<void>((_, reject) => {
        const signal = (_options as any)?.signal as AbortSignal | undefined;
        if (signal?.aborted) {
          return reject(signal.reason ?? new Error('Aborted'));
        }
        const onAbort = () => reject(signal?.reason ?? new Error('Aborted'));
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }

    if (next.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, next.delayMs));
    }

    const generation: ChatGeneration = {
      text: next.text,
      message: new AIMessage({ content: next.text })
    };

    return { generations: [generation], llmOutput: {} };
  }
}
