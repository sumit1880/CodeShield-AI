import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { generateStructuredWithModel } from '../../llm/structured-output';
import { MANAGER_SYSTEM_PROMPT, buildManagerCompactState } from '../../prompts/manager.prompt';
import { managerDecisionSchema } from '../../schemas/manager.schema';
import { ManagerDecision, AGENT_ACTIONS } from '../../types/agent-state';
import { logger } from '../../utils/logger';
import { ApiError, ErrorCode } from '../../utils/errors';
import { AnalysisGraphState, AnalysisGraphUpdate } from '../state';

interface ManagerNodeDeps {
  model: BaseChatModel;
  signal?: AbortSignal;
}

// Rebuild a minimal AnalysisState-compatible view from graph state for compact state serializer
function graphStateToAnalysisState(state: AnalysisGraphState) {
  return {
    goal: state.goal,
    language: state.language,
    files: state.files,
    semgrepFindings: state.semgrepFindings,
    candidateFindings: state.candidateFindings,
    classifiedFindings: state.classifiedFindings,
    verifiedById: state.verifiedById as any,
    knowledge: state.knowledge,
    evidence: state.evidence,
    actionsTaken: state.actionsTaken,
    iteration: state.iteration,
    toolCallCount: state.toolCallCount,
    status: 'RUNNING' as const
  };
}

export function managerNode(deps: ManagerNodeDeps) {
  return async (state: AnalysisGraphState): Promise<AnalysisGraphUpdate> => {
    const compactState = buildManagerCompactState(graphStateToAnalysisState(state) as any);

    let result;
    try {
      result = await generateStructuredWithModel(deps.model, {
        systemPrompt: MANAGER_SYSTEM_PROMPT,
        userPrompt: `Current analysis state (JSON):\n${compactState}\n\nChoose the single best next action.`,
        schema: managerDecisionSchema,
        signal: deps.signal
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === ErrorCode.INVALID_AI_RESPONSE) {
        logger.warn({ err }, '[Node:manager] Manager decision invalid or rejected by schema, defaulting to FINISH');
        return {
          nextAction: { action: 'FINISH', arguments: {}, reason: 'Unknown or invalid action, defaulting to FINISH' },
          iteration: state.iteration + 1
        };
      }
      throw err;
    }

    // Validate the action is within the fixed allow-list
    const action = result.action as ManagerDecision['action'];
    if (!AGENT_ACTIONS.includes(action)) {
      logger.warn({ action }, '[Node:manager] Manager chose unknown action, defaulting to FINISH');
      return {
        nextAction: { action: 'FINISH', arguments: {}, reason: 'Unknown action, defaulting to FINISH' },
        iteration: state.iteration + 1
      };
    }

    logger.info({ action, reason: result.reason }, `[Node:manager] Decision: ${action}`);

    return {
      nextAction: {
        action,
        arguments: result.arguments ?? {},
        reason: result.reason
      },
      iteration: state.iteration + 1
    };
  };
}
