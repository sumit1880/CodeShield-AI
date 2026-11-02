import path from 'path';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { verificationOutputSchema } from '../../schemas/agent.schema';
import { generateStructuredWithModel } from '../../llm/structured-output';
import { VERIFICATION_SYSTEM_PROMPT, buildVerificationPromptTemplate } from '../../prompts/verification.prompt';
import { VerificationResult } from '../../types/findings';
import { logger } from '../../utils/logger';
import { AnalysisGraphState, AnalysisGraphUpdate } from '../state';
import { describeLlmFailure, isRecoverableLlmFailure, unverifiedVerdict } from './verification-failure';

interface VerifyNodeDeps {
  model: BaseChatModel;
  signal?: AbortSignal;
}

function applySemgrepErrorFloor(
  results: VerificationResult[],
  state: AnalysisGraphState,
  findings: import('../../types/findings').AnalyzedFinding[]
): VerificationResult[] {
  const errorSemgrep = state.semgrepFindings.filter(
    (sf) => sf.severity?.toUpperCase() === 'ERROR'
  );
  if (errorSemgrep.length === 0) return results;

  const findingById = new Map(findings.map((f) => [f.id, f]));

  return results.map((verdict) => {
    if (verdict.status !== 'REJECTED') return verdict;

    const finding = findingById.get(verdict.id);
    if (!finding) return verdict;

    const isSemgrepError = errorSemgrep.some((sf) => {
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
      return {
        ...verdict,
        status: 'UNCERTAIN' as const,
        reason: 'Semgrep ERROR finding cannot be silently REJECTED without a stored reason'
      };
    }
    return verdict;
  });
}

export function verifyNode(deps: VerifyNodeDeps) {
  return async (state: AnalysisGraphState): Promise<AnalysisGraphUpdate> => {
    const pending = state.classifiedFindings.filter((f) => !state.verifiedById[f.id]);

    if (pending.length === 0) {
      return {
        actionsTaken: [
          {
            iteration: state.iteration,
            action: 'VERIFY_FINDING',
            reason: 'No unverified findings — forced check was a no-op',
            resultSummary: 'No unverified classified findings'
          }
        ]
      };
    }

    const { variables } = buildVerificationPromptTemplate({
      language: state.language,
      sourceCode: state.sourceCode,
      analyzedFindingsJson: JSON.stringify(pending, null, 2)
    });

    let result;
    try {
      result = await generateStructuredWithModel(deps.model, {
        systemPrompt: VERIFICATION_SYSTEM_PROMPT,
        userPrompt: variables.userContent,
        schema: verificationOutputSchema,
        signal: deps.signal
      });
    } catch (err) {
      // Provider chain exhausted / refusal / invalid or empty output / rate limit / timeout.
      // The router and generateStructuredWithModel already tried every provider (and one repair),
      // so do NOT fail the whole analysis and do NOT retry: keep the detection + classification
      // results and record each pending finding as UNVERIFIED (never CONFIRMED).
      if (!isRecoverableLlmFailure(err, deps.signal)) throw err;

      const why = describeLlmFailure(err);
      logger.warn(
        { pending: pending.length, why },
        '[Node:verify] Verification could not be completed; findings kept as UNVERIFIED'
      );
      const reason = `Verification could not be completed: ${why}`;
      return {
        verifiedById: Object.fromEntries(
          pending.map((f) => [f.id, unverifiedVerdict(f.id, f.confidence, reason)])
        ),
        toolCallCount: state.toolCallCount + 1,
        actionsTaken: [
          {
            iteration: state.iteration,
            action: 'VERIFY_FINDING',
            reason: `${pending.length} classified finding(s) pending verification`,
            resultSummary: `Verification failed; ${pending.length} finding(s) left UNVERIFIED`,
            error: why
          }
        ]
      };
    }

    // Map LLM IDs back to stable finding-N IDs
    const verdicts: VerificationResult[] = result.findings.map((v, i) => {
      const targetId = pending.find((p) => p.id === v.id)?.id ?? pending[i]?.id ?? v.id;
      return { id: targetId, status: v.status, confidence: v.confidence, reason: v.reason || '' };
    });

    const floored = applySemgrepErrorFloor(verdicts, state, pending);

    // A schema-valid answer can still omit findings (e.g. {"findings": []}). Those must not
    // look verified, and must not make the router re-force verify forever: mark them UNVERIFIED.
    const answeredIds = new Set(floored.map((v) => v.id));
    const missing = pending.filter((p) => !answeredIds.has(p.id));
    const missingVerdicts = missing.map((f) =>
      unverifiedVerdict(
        f.id,
        f.confidence,
        'Verification could not be completed: the model returned no verdict for this finding'
      )
    );

    const verifiedById = Object.fromEntries([...floored, ...missingVerdicts].map((v) => [v.id, v]));

    logger.info(
      { count: floored.length, missing: missing.length },
      '[Node:verify] Verification complete'
    );

    return {
      verifiedById,
      toolCallCount: state.toolCallCount + 1,
      actionsTaken: [
        {
          iteration: state.iteration,
          action: 'VERIFY_FINDING',
          reason: `${pending.length} classified finding(s) pending verification`,
          resultSummary:
            missing.length > 0
              ? `Verified ${floored.length} finding(s); ${missing.length} left UNVERIFIED (no verdict returned)`
              : `Verified ${floored.length} finding(s)`
        }
      ]
    };
  };
}
