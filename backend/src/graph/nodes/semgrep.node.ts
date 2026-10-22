import { SemgrepService } from '../../services/semgrep/semgrep.service';
import { ApiError, ErrorCode } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { AnalysisGraphState, AnalysisGraphUpdate } from '../state';

interface SemgrepNodeDeps {
  semgrepService: SemgrepService;
  signal?: AbortSignal;
}

export function semgrepNode(deps: SemgrepNodeDeps) {
  return async (state: AnalysisGraphState): Promise<AnalysisGraphUpdate> => {
    try {
      const findings = await deps.semgrepService.scan({
        targetDir: state.projectRoot,
        language: state.language
      });
      logger.info({ count: findings.length }, '[Node:semgrep] Scan complete');
      return {
        semgrepFindings: findings,
        toolCallCount: state.toolCallCount + 1,
        actionsTaken: [
          {
            iteration: state.iteration,
            action: 'RUN_SEMGREP',
            reason: 'Semgrep rescan requested by planner',
            resultSummary: `Semgrep found ${findings.length} finding(s)`
          }
        ]
      };
    } catch (err) {
      if (err instanceof ApiError && err.code === ErrorCode.SEMGREP_NOT_INSTALLED) {
        logger.error('[Node:semgrep] Semgrep not installed; continuing LLM-only');
        return {
          toolCallCount: state.toolCallCount + 1,
          actionsTaken: [
            {
              iteration: state.iteration,
              action: 'RUN_SEMGREP',
              reason: 'Semgrep rescan requested by planner',
              resultSummary: 'Semgrep not installed; skipped'
            }
          ]
        };
      }
      throw err;
    }
  };
}
