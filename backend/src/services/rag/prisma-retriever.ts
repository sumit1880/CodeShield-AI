import { BaseRetriever, type BaseRetrieverInput } from '@langchain/core/retrievers';
import { Document } from '@langchain/core/documents';
import { type CallbackManagerForRetrieverRun } from '@langchain/core/callbacks/manager';
import { PrismaClient } from '@prisma/client';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { logger } from '../../utils/logger';
import { RetrievedKnowledge } from '../../types/findings';

interface KnowledgeRow {
  content: string;
  source: string;
  distance: number;
}

/**
 * LangChain BaseRetriever implementation backed by pgvector cosine similarity
 * search via Prisma. Wraps the existing raw SQL query so RagService (and the
 * graph's rag node) can depend on LangChain's standard retriever interface.
 *
 * Degrades gracefully: both embedding failures and DB query failures return []
 * rather than aborting the analysis.
 */
export class PrismaPgvectorRetriever extends BaseRetriever {
  static lc_name() {
    return 'PrismaPgvectorRetriever';
  }

  lc_namespace = ['codeshield', 'retrievers'];

  private readonly prisma: PrismaClient;
  private readonly embeddings: GoogleGenerativeAIEmbeddings;
  private readonly topK: number;

  constructor(
    prisma: PrismaClient,
    embeddings: GoogleGenerativeAIEmbeddings,
    topK = 5,
    fields?: BaseRetrieverInput
  ) {
    super(fields);
    this.prisma = prisma;
    this.embeddings = embeddings;
    this.topK = topK;
  }

  async _getRelevantDocuments(
    query: string,
    _runManager?: CallbackManagerForRetrieverRun
  ): Promise<Document[]> {
    let queryEmbedding: number[];

    try {
      queryEmbedding = await this.embeddings.embedQuery(query);
    } catch (err) {
      logger.warn({ err }, 'RAG retrieval skipped: embedding failed');
      return [];
    }

    const vectorLiteral = `[${queryEmbedding.join(',')}]`;

    try {
      const rows = await this.prisma.$queryRaw<KnowledgeRow[]>`
        SELECT kc.content AS content, kd.source AS source,
               kc.embedding <=> ${vectorLiteral}::vector AS distance
        FROM "KnowledgeChunk" kc
        JOIN "KnowledgeDocument" kd ON kd.id = kc."documentId"
        WHERE kc.embedding IS NOT NULL
        ORDER BY kc.embedding <=> ${vectorLiteral}::vector
        LIMIT ${this.topK}
      `;

      return rows.map((row) => new Document({
        pageContent: row.content,
        metadata: { source: row.source, score: 1 - row.distance }
      }));
    } catch (err) {
      logger.warn({ err }, 'RAG retrieval skipped: query failed');
      return [];
    }
  }

  /** Convenience method returning the domain-typed results used by graph nodes. */
  async retrieveKnowledge(query: string): Promise<RetrievedKnowledge[]> {
    const docs = await this._getRelevantDocuments(query);
    return docs.map((d) => ({
      content: d.pageContent,
      source: d.metadata.source as string,
      score: d.metadata.score as number
    }));
  }
}
