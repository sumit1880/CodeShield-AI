import { PrismaPgvectorRetriever } from '../../services/rag/prisma-retriever';
import { logger } from '../../utils/logger';
import { AnalysisGraphState, AnalysisGraphUpdate } from '../state';

interface RagNodeDeps {
  retriever: PrismaPgvectorRetriever;
  query?: string;
}

export function ragNode(deps: RagNodeDeps) {
  return async (state: AnalysisGraphState, config?: { configurable?: { ragQuery?: string } }): Promise<AnalysisGraphUpdate> => {
    const query =
      (config?.configurable?.ragQuery as string | undefined) ??
      `Common vulnerability classes and secure coding guidance relevant to ${state.language} code`;

    const results = await deps.retriever.retrieveKnowledge(query);

    logger.info({ count: results.length, query }, '[Node:rag] Knowledge retrieval complete');

    return {
      knowledge: results,
      toolCallCount: state.toolCallCount + 1,
      actionsTaken: [
        {
          iteration: state.iteration,
          action: 'SEARCH_SECURITY_KNOWLEDGE',
          reason: `Knowledge retrieval for: ${query}`,
          resultSummary: `RAG returned ${results.length} knowledge chunk(s)`
        }
      ]
    };
  };
}
