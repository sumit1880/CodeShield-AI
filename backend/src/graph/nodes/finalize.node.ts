import path from 'path';
import { VulnerabilityResponse, UncertainFindingResponse } from '../../types/findings';
import { FinalizedFindings, AnalysisGraphState, AnalysisGraphUpdate } from '../state';
import { logger } from '../../utils/logger';
import { env } from '../../config/env';

export function finalizeNode() {
  return async (state: AnalysisGraphState): Promise<AnalysisGraphUpdate> => {
    const vulnerabilities: VulnerabilityResponse[] = [];
    const uncertainFindings: UncertainFindingResponse[] = [];
    let rejectedCount = 0;

    for (const finding of state.classifiedFindings) {
      const verdict = state.verifiedById[finding.id];
      const base = {
        id: finding.id,
        title: finding.title,
        cwe: finding.cwe,
        severity: finding.severity,
        confidence: finding.confidence,
        location: finding.location,
        explanation: finding.explanation,
        recommendation: finding.recommendation
      };

      if (verdict?.status === 'CONFIRMED') {
        vulnerabilities.push({
          ...base,
          verification: { status: 'CONFIRMED', confidence: verdict.confidence, reason: verdict.reason }
        });
      } else if (verdict?.status === 'REJECTED') {
        // Semgrep ERROR findings: rejected silently without a stored reason upgrades to UNCERTAIN
        const isSemgrepError = state.semgrepFindings.some((sf) => {
          if (sf.severity?.toUpperCase() !== 'ERROR') return false;
          const fileMatch =
            sf.file === finding.location.file ||
            path.normalize(sf.file) === path.normalize(finding.location.file) ||
            sf.file.endsWith(finding.location.file) ||
            finding.location.file.endsWith(sf.file);
          if (!fileMatch) return false;
          return (
            Math.max(sf.lineStart, finding.location.lineStart) <=
            Math.min(sf.lineEnd, finding.location.lineEnd)
          );
        });

        if (isSemgrepError && (!verdict.reason || !verdict.reason.trim())) {
          uncertainFindings.push({
            ...base,
            verification: {
              status: 'UNCERTAIN',
              confidence: verdict.confidence,
              reason: 'Semgrep ERROR finding cannot be silently REJECTED without a stored reason'
            }
          });
        } else {
          rejectedCount++;
        }
      } else if (verdict?.status === 'UNCERTAIN') {
        uncertainFindings.push({
          ...base,
          verification: { status: 'UNCERTAIN', confidence: verdict.confidence, reason: verdict.reason }
        });
      } else {
        // Not reached verification — report as UNVERIFIED, never upgrade to CONFIRMED
        uncertainFindings.push({
          ...base,
          verification: { status: 'UNVERIFIED', confidence: finding.confidence }
        });
      }
    }

    const classifiedIds = new Set(state.classifiedFindings.map((f) => f.id));
    const unclassified = state.candidateFindings.filter((f) => !classifiedIds.has(f.id));
    for (const candidate of unclassified) {
      uncertainFindings.push({
        id: candidate.id,
        title: candidate.title,
        cwe: { id: 'CWE-Other', name: candidate.category || 'Potential Security Flaw' },
        severity: 'MEDIUM',
        confidence: 0.5,
        location: {
          file: candidate.file,
          function: null,
          lineStart: candidate.lineStart,
          lineEnd: candidate.lineEnd
        },
        explanation:
          candidate.evidence ||
          'Candidate finding identified during initial detection but not classified before timeout or budget limit.',
        recommendation: 'Review code around this location manually.',
        verification: {
          status: 'UNVERIFIED',
          confidence: 0.5,
          reason: 'Pipeline budget or deadline reached before classification'
        }
      });
    }
    const unclassifiedCandidates = unclassified.length;

    const stoppedByLimit =
      state.iteration > env.agent.maxIterations ||
      state.toolCallCount >= env.agent.maxToolCalls ||
      (state.deadline > 0 && Date.now() > state.deadline);

    const partial =
      state.stopReason !== 'FINISHED' ||
      stoppedByLimit ||
      unclassifiedCandidates > 0 ||
      uncertainFindings.length > 0;

    if (uncertainFindings.length > 0 || unclassifiedCandidates > 0) {
      logger.warn(
        { uncertain: uncertainFindings.length, unclassifiedCandidates, stopReason: state.stopReason },
        '[Node:finalize] Finished with uncertain/unclassified findings'
      );
    }

    const finalized: FinalizedFindings = {
      vulnerabilities,
      uncertainFindings,
      rejectedCount,
      partial
    };

    logger.info(
      { confirmed: vulnerabilities.length, uncertain: uncertainFindings.length, rejected: rejectedCount },
      '[Node:finalize] Finalization complete'
    );

    return { finalized };
  };
}
