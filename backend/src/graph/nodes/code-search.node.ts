import { CodeSearchService } from '../../services/code-context/code-search.service';
import { logger } from '../../utils/logger';
import { AnalysisGraphState, AnalysisGraphUpdate } from '../state';

interface CodeSearchNodeDeps {
  codeSearchService: CodeSearchService;
}

export function codeSearchNode(deps: CodeSearchNodeDeps) {
  return async (state: AnalysisGraphState): Promise<AnalysisGraphUpdate> => {
    const args = state.nextAction?.arguments ?? {};
    const query = typeof args.query === 'string' && args.query.trim() ? args.query : '';
    const file = typeof args.file === 'string' ? args.file : undefined;

    if (!query) {
      return {
        actionsTaken: [
          {
            iteration: state.iteration,
            action: 'SEARCH_CODE',
            reason: 'No query provided',
            resultSummary: 'Skipped: no query provided'
          }
        ]
      };
    }

    const matches = await deps.codeSearchService.searchCode(
      state.projectRoot,
      state.files,
      query,
      file
    );

    const newEvidence = matches.map((m) => `[SEARCH_CODE "${query}"] ${m}`);

    logger.info({ count: matches.length, query }, '[Node:code-search] Search complete');

    return {
      evidence: newEvidence,
      toolCallCount: state.toolCallCount + 1,
      actionsTaken: [
        {
          iteration: state.iteration,
          action: 'SEARCH_CODE',
          reason: state.nextAction?.reason ?? `Search for: ${query}`,
          resultSummary: `Found ${matches.length} match(es) for "${query}"`
        }
      ]
    };
  };
}
