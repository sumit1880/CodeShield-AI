/**
 * Provider-agnostic embedding abstraction. The concrete model is
 * configured via the EMBEDDING_MODEL environment variable and is never
 * hard-coded elsewhere in the codebase.
 */
export interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}
