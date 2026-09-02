import { getPrismaClient } from '../config/prisma';
import { GeminiService } from '../services/llm/gemini.service';
import { GeminiEmbeddingService } from '../services/embeddings/gemini-embedding.service';
import { SemgrepService } from '../services/semgrep/semgrep.service';
import { RagService } from '../services/rag/rag.service';
import { CodeContextService } from '../services/code-context/code-context.service';
import { DetectionAgent } from '../agents/detection.agent';
import { ClassificationAgent } from '../agents/classification.agent';
import { VerificationAgent } from '../agents/verification.agent';
import { AnalysisOrchestrator } from '../orchestrator/analysis.orchestrator';
import { ZipService } from '../services/zip/zip.service';

/**
 * Builds the fully-wired orchestrator (and any other shared services routes
 * need) from real implementations. Tests construct their own orchestrator
 * with mocked agents/services instead of using this factory.
 */
export function buildContainer() {
  const llm = new GeminiService();
  const embeddings = new GeminiEmbeddingService();
  const prisma = getPrismaClient();

  const semgrepService = new SemgrepService();
  const ragService = new RagService(prisma, embeddings);
  const codeContextService = new CodeContextService();
  const zipService = new ZipService();

  const detectionAgent = new DetectionAgent(llm);
  const classificationAgent = new ClassificationAgent(llm);
  const verificationAgent = new VerificationAgent(llm);

  const orchestrator = new AnalysisOrchestrator({
    detectionAgent,
    classificationAgent,
    verificationAgent,
    semgrepService,
    ragService,
    codeContextService,
    prisma
  });

  return { orchestrator, zipService, prisma };
}

export type Container = ReturnType<typeof buildContainer>;
