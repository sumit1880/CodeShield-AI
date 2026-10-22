import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { detectionOutputSchema } from '../../schemas/agent.schema';
import { generateStructuredWithModel } from '../../llm/structured-output';
import { buildDetectionPromptTemplate, DETECTION_SYSTEM_PROMPT } from '../../prompts/detection.prompt';
import { logger } from '../../utils/logger';
import { AnalysisGraphState, AnalysisGraphUpdate } from '../state';

interface DetectNodeDeps {
  model: BaseChatModel;
  signal?: AbortSignal;
}

export function detectNode(deps: DetectNodeDeps) {
  return async (state: AnalysisGraphState): Promise<AnalysisGraphUpdate> => {
    const { variables } = buildDetectionPromptTemplate({
      language: state.language,
      sourceCode: state.sourceCode,
      semgrepFindingsJson: JSON.stringify(state.semgrepFindings, null, 2)
    });

    const result = await generateStructuredWithModel(deps.model, {
      systemPrompt: DETECTION_SYSTEM_PROMPT,
      userPrompt: variables.userContent,
      schema: detectionOutputSchema,
      signal: deps.signal
    });

    logger.info({ count: result.findings.length }, '[Node:detect] Detection complete');

    return {
      candidateFindings: result.findings,
      toolCallCount: state.toolCallCount + 1,
      actionsTaken: [
        {
          iteration: state.iteration,
          action: 'DETECT_VULNERABILITIES',
          reason: 'Detection agent invoked',
          resultSummary: `Detection produced ${result.findings.length} candidate finding(s)`
        }
      ]
    };
  };
}
