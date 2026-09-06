import { getPrismaClient } from '../config/prisma';
import { buildLlmService } from '../services/llm/llm-factory';
import { GeminiEmbeddingService } from '../services/embeddings/gemini-embedding.service';
import { SemgrepService } from '../services/semgrep/semgrep.service';
import { RagService } from '../services/rag/rag.service';
import { CodeContextService } from '../services/code-context/code-context.service';
import { CodeSearchService } from '../services/code-context/code-search.service';
import { DetectionAgent } from '../agents/detection.agent';
import { ClassificationAgent } from '../agents/classification.agent';
import { VerificationAgent } from '../agents/verification.agent';
import { ManagerAgent } from '../agents/manager.agent';
import { AnalysisOrchestrator } from '../orchestrator/analysis.orchestrator';
import { ZipService } from '../services/zip/zip.service';

/**
 * Builds the fully-wired orchestrator (and any other shared services routes
 * need) from real implementations. Tests construct their own orchestrator
 * with mocked agents/services instead of using this factory.
 */
export function buildContainer() {
  // Gemini -> Grok -> Llama fallback chain (order configurable via
  // LLM_PROVIDER_ORDER). Agents depend on the LlmService interface only, so
  // they never know whether a single provider or the router is underneath.
  const llm = buildLlmService();
  // Embeddings (RAG knowledge base) intentionally stay Gemini-only: no
  // fallback need was requested for embeddings, and keeping this simple
  // avoids needless complexity on a free-tier deployment.
  const embeddings = new GeminiEmbeddingService();
  const prisma = getPrismaClient();

  const semgrepService = new SemgrepService();
  const ragService = new RagService(prisma, embeddings);
  const codeContextService = new CodeContextService();
  const codeSearchService = new CodeSearchService();
  const zipService = new ZipService();

  const detectionAgent = new DetectionAgent(llm);
  const classificationAgent = new ClassificationAgent(llm);
  const verificationAgent = new VerificationAgent(llm);
  const managerAgent = new ManagerAgent(llm);

  const orchestrator = new AnalysisOrchestrator({
    detectionAgent,
    classificationAgent,
    verificationAgent,
    managerAgent,
    semgrepService,
    ragService,
    codeContextService,
    codeSearchService,
    prisma
  });

  return { orchestrator, zipService, prisma };
}

export type Container = ReturnType<typeof buildContainer>;
