import { PrismaClient } from '@prisma/client';
import { RetrievedKnowledge } from '../../types/findings';
import { EmbeddingService } from '../embeddings/embedding.service';
import { logger } from '../../utils/logger';

export interface RagRetrievalOptions {
  query: string;
  topK?: number;
}

interface KnowledgeRow {
  content: string;
  source: string;
  distance: number;
}

/**
 * Retrieval-augmented generation over the security knowledge base
 * (CWE/OWASP/secure-coding guidance), backed by pgvector cosine similarity
 * search. This is intentionally NOT used to "understand" submitted source
 * code — code understanding comes from Semgrep + Agent 1/2 reasoning over
 * extracted context.
 */
export class RagService {
  constructor(private prisma: PrismaClient, private embeddings: EmbeddingService) {}

  async retrieve(options: RagRetrievalOptions): Promise<RetrievedKnowledge[]> {
    const { query, topK = 5 } = options;

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embeddings.embed(query);
    } catch (err) {
      // RAG is an enhancement, not a hard requirement — degrade gracefully
      // rather than failing the whole analysis if embeddings are unavailable.
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
        LIMIT ${topK}
      `;

      return rows.map((row: KnowledgeRow) => ({
        content: row.content,
        source: row.source,
        score: 1 - row.distance
      }));
    } catch (err) {
      logger.warn({ err }, 'RAG retrieval skipped: query failed');
      return [];
    }
  }
}
