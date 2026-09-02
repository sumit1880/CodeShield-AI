import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env';
import { ApiError, ErrorCode } from '../../utils/errors';
import { EmbeddingService } from './embedding.service';

export class GeminiEmbeddingService implements EmbeddingService {
  private client: GoogleGenAI;
  private modelName: string;

  constructor(
    apiKey: string = env.gemini.apiKey,
    modelName: string = env.embeddingModel
  ) {
    this.client = new GoogleGenAI({ apiKey });
    this.modelName = modelName;
  }

  async embed(text: string): Promise<number[]> {
    try {
      const response = await this.client.models.embedContent({
        model: this.modelName,
        contents: text,
        config: {
          outputDimensionality: 768,
        },
      });

      const values = response.embeddings?.[0]?.values;

      if (!values || values.length !== 768) {
        throw new Error(
          `Expected 768-dimensional embedding, received ${values?.length ?? 0}`
        );
      }

      return values;
    } catch (err) {
      throw new ApiError(
        ErrorCode.AI_PROVIDER_ERROR,
        `Embedding request failed: ${(err as Error)?.message || 'unknown error'}`
      );
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];

    for (const text of texts) {
      results.push(await this.embed(text));
    }

    return results;
  }
}