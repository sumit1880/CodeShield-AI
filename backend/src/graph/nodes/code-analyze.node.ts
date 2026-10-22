import { CodeSearchService } from '../../services/code-context/code-search.service';
import { logger } from '../../utils/logger';
import { AnalysisGraphState, AnalysisGraphUpdate } from '../state';

interface CodeAnalyzeNodeDeps {
  codeSearchService: CodeSearchService;
}

function asInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function codeAnalyzeNode(deps: CodeAnalyzeNodeDeps) {
  return async (state: AnalysisGraphState): Promise<AnalysisGraphUpdate> => {
    const args = state.nextAction?.arguments ?? {};
    const file = typeof args.file === 'string' && args.file.trim() ? args.file : '';
    const startLine = asInt(args.startLine, 1);
    const endLine = asInt(args.endLine, startLine + 20);

    if (!file) {
      return {
        actionsTaken: [
          {
            iteration: state.iteration,
            action: 'ANALYZE_CODE',
            reason: 'No file provided',
            resultSummary: 'Skipped: no file provided'
          }
        ]
      };
    }

    const snippet = await deps.codeSearchService.analyzeCode(
      state.projectRoot,
      state.files,
      file,
      startLine,
      endLine
    );

    const newEvidence = [`[ANALYZE_CODE ${file}:${startLine}-${endLine}]\n${snippet}`];

    logger.info({ file, startLine, endLine }, '[Node:code-analyze] Inspection complete');

    return {
      evidence: newEvidence,
      toolCallCount: state.toolCallCount + 1,
      actionsTaken: [
        {
          iteration: state.iteration,
          action: 'ANALYZE_CODE',
          reason: state.nextAction?.reason ?? `Inspect ${file}:${startLine}-${endLine}`,
          resultSummary: `Inspected ${file} lines ${startLine}-${endLine}`
        }
      ]
    };
  };
}
