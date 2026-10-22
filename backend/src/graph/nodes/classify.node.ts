import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { classificationOutputSchema } from '../../schemas/agent.schema';
import { generateStructuredWithModel } from '../../llm/structured-output';
import { CLASSIFICATION_SYSTEM_PROMPT, classificationTemplate } from '../../prompts/classification.prompt';
import { AnalyzedFinding } from '../../types/findings';
import { logger } from '../../utils/logger';
import { AnalysisGraphState, AnalysisGraphUpdate } from '../state';

interface ClassifyNodeDeps {
  model: BaseChatModel;
  signal?: AbortSignal;
}

export function classifyNode(deps: ClassifyNodeDeps) {
  return async (state: AnalysisGraphState): Promise<AnalysisGraphUpdate> => {
    const classifiedIds = new Set(state.classifiedFindings.map((f) => f.id));
    const pending = state.candidateFindings.filter((f) => !classifiedIds.has(f.id));

    if (pending.length === 0) {
      return {
        actionsTaken: [
          {
            iteration: state.iteration,
            action: 'CLASSIFY_FINDING',
            reason: 'No unclassified candidates — forced check was a no-op',
            resultSummary: 'No unclassified candidate findings'
          }
        ]
      };
    }

    const userPrompt = await classificationTemplate.formatMessages({
      language: state.language,
      candidateFindingsJson: JSON.stringify(pending, null, 2),
      retrievedKnowledgeJson: JSON.stringify(state.knowledge, null, 2),
      sourceCode: state.sourceCode
    });
    const userText = userPrompt.map((m) =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ).join('\n');

    const result = await generateStructuredWithModel(deps.model, {
      systemPrompt: CLASSIFICATION_SYSTEM_PROMPT,
      userPrompt: userText,
      schema: classificationOutputSchema,
      signal: deps.signal
    });

    // Map LLM-returned IDs back to the stable finding-N IDs assigned during candidate deduplication
    const classified: AnalyzedFinding[] = result.findings.map((item, i) => {
      const targetId = pending.find((p) => p.id === item.id)?.id ?? pending[i]?.id ?? item.id;
      return { ...item, id: targetId };
    });

    logger.info({ count: classified.length }, '[Node:classify] Classification complete');

    return {
      classifiedFindings: classified,
      toolCallCount: state.toolCallCount + 1,
      actionsTaken: [
        {
          iteration: state.iteration,
          action: 'CLASSIFY_FINDING',
          reason: `${pending.length} candidate finding(s) pending classification`,
          resultSummary: `Classified ${classified.length} finding(s)`
        }
      ]
    };
  };
}
