import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { verificationOutputSchema } from '../../schemas/agent.schema';
import { generateStructuredWithModel } from '../../llm/structured-output';
import { VERIFICATION_SYSTEM_PROMPT, buildVerificationPromptTemplate } from '../../prompts/verification.prompt';
import { VerificationResult } from '../../types/findings';
import { logger } from '../../utils/logger';
import { AnalysisGraphState, AnalysisGraphUpdate } from '../state';

interface ReanalyzeNodeDeps {
  model: BaseChatModel;
  signal?: AbortSignal;
}

export function reanalyzeNode(deps: ReanalyzeNodeDeps) {
  return async (state: AnalysisGraphState): Promise<AnalysisGraphUpdate> => {
    const uncertainIds = new Set(
      Object.values(state.verifiedById)
        .filter((v) => v.status === 'UNCERTAIN')
        .map((v) => v.id)
    );
    const targets = state.classifiedFindings.filter((f) => uncertainIds.has(f.id));

    if (targets.length === 0) {
      return {
        actionsTaken: [
          {
            iteration: state.iteration,
            action: 'REANALYZE_FINDING',
            reason: 'No UNCERTAIN findings to reanalyze',
            resultSummary: 'No UNCERTAIN findings to reanalyze'
          }
        ]
      };
    }

    const { variables } = buildVerificationPromptTemplate({
      language: state.language,
      sourceCode: state.sourceCode,
      analyzedFindingsJson: JSON.stringify(targets, null, 2)
    });

    const result = await generateStructuredWithModel(deps.model, {
      systemPrompt: VERIFICATION_SYSTEM_PROMPT,
      userPrompt: variables.userContent,
      schema: verificationOutputSchema,
      signal: deps.signal
    });

    const newVerdicts: VerificationResult[] = result.findings.map((v, i) => {
      const targetId = targets.find((t) => t.id === v.id)?.id ?? targets[i]?.id ?? v.id;
      return { id: targetId, status: v.status, confidence: v.confidence, reason: v.reason || '' };
    });

    const verifiedById = {
      ...state.verifiedById,
      ...Object.fromEntries(newVerdicts.map((v) => [v.id, v]))
    };

    logger.info({ count: newVerdicts.length }, '[Node:reanalyze] Reanalysis complete');

    return {
      verifiedById,
      toolCallCount: state.toolCallCount + 1,
      actionsTaken: [
        {
          iteration: state.iteration,
          action: 'REANALYZE_FINDING',
          reason: `${targets.length} UNCERTAIN finding(s) reanalyzed`,
          resultSummary: `Reanalyzed ${newVerdicts.length} previously uncertain finding(s)`
        }
      ]
    };
  };
}
