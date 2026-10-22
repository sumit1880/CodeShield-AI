import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { getPrismaClient } from '../config/prisma';
import { buildChatModel } from '../llm/factory';
import { SemgrepService } from '../services/semgrep/semgrep.service';
import { PrismaPgvectorRetriever } from '../services/rag/prisma-retriever';
import { CodeContextService } from '../services/code-context/code-context.service';
import { CodeSearchService } from '../services/code-context/code-search.service';
import { AnalysisOrchestrator } from '../orchestrator/analysis.orchestrator';
import { ZipService } from '../services/zip/zip.service';
import { env } from '../config/env';

/**
 * Builds the fully-wired orchestrator from real LangChain/LangGraph
 * implementations. Tests construct their own orchestrator with mocked
 * models/services instead of using this factory.
 */
export function buildContainer() {
  // Detection, classification, and manager use the primary provider chain.
  // Verification uses a separate instance to avoid a single model validating
  // its own hallucinations.
  const detectionModel = buildChatModel();
  const verificationModel = buildChatModel();

  // Embeddings for the RAG knowledge base (Gemini-only; graceful degradation
  // on failure is handled inside PrismaPgvectorRetriever).
  const embeddings = new GoogleGenerativeAIEmbeddings({
    apiKey: env.gemini.apiKey,
    model: env.embeddingModel
  });

  const prisma = getPrismaClient();
  const semgrepService = new SemgrepService();
  const retriever = new PrismaPgvectorRetriever(prisma, embeddings);
  const codeContextService = new CodeContextService();
  const codeSearchService = new CodeSearchService();
  const zipService = new ZipService();

  const orchestrator = new AnalysisOrchestrator({
    detectionModel,
    verificationModel,
    semgrepService,
    retriever,
    codeContextService,
    codeSearchService,
    prisma
  });

  return { orchestrator, zipService, prisma };
}

export type Container = ReturnType<typeof buildContainer>;
