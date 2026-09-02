import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { EmbeddingService } from '../embeddings/embedding.service';

const CHUNK_SIZE = 800; // characters
const CHUNK_OVERLAP = 100;

export interface KnowledgeSourceDoc {
  title: string;
  source: string;
  content: string;
  metadata?: Record<string, unknown>;
}

function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + size);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - overlap;
  }
  return chunks;
}

/**
 * Ingests a security-knowledge document: chunks it, embeds each chunk, and
 * stores both the document and its chunks (with embeddings) for later
 * retrieval by RagService. This is an offline/setup-time operation, not
 * part of the per-analysis 3-LLM-call budget.
 */
export class IngestService {
  constructor(private prisma: PrismaClient, private embeddings: EmbeddingService) {}

  async ingestDocument(doc: KnowledgeSourceDoc): Promise<string> {
    const document = await this.prisma.knowledgeDocument.create({
      data: {
        title: doc.title,
        source: doc.source,
        content: doc.content,
        metadata: (doc.metadata ?? undefined) as any
      }
    });

    const chunks = chunkText(doc.content);
    const vectors = await this.embeddings.embedBatch(chunks);

    for (let i = 0; i < chunks.length; i++) {
      const vectorLiteral = `[${vectors[i].join(',')}]`;
      const chunkId = crypto.randomUUID();
      await this.prisma.$executeRaw`
        INSERT INTO "KnowledgeChunk" (id, "documentId", content, embedding, metadata, "createdAt")
        VALUES (${chunkId}, ${document.id}, ${chunks[i]}, ${vectorLiteral}::vector, '{}'::jsonb, now())
      `;
    }

    return document.id;
  }
}
