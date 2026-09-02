import { getPrismaClient } from '../src/config/prisma';
import { GeminiEmbeddingService } from '../src/services/embeddings/gemini-embedding.service';
import { IngestService } from '../src/services/rag/ingest.service';
import { SEED_KNOWLEDGE } from '../src/services/rag/knowledge-seed-data';

const prisma = getPrismaClient();

async function main() {
  const embeddings = new GeminiEmbeddingService();
  const ingest = new IngestService(prisma, embeddings);

  for (const doc of SEED_KNOWLEDGE) {
    const id = await ingest.ingestDocument(doc);
    // eslint-disable-next-line no-console
    console.log(`Ingested: ${doc.title} (${id})`);
  }
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Seeding failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
