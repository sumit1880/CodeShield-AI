import { LlmService } from '../services/llm/llm.service';
import { generateStructured } from '../services/llm/structured-output';
import { managerDecisionSchema } from '../schemas/manager.schema';
import { AnalysisState, ManagerDecision } from '../types/agent-state';
import { buildManagerUserPrompt, MANAGER_SYSTEM_PROMPT } from './prompts/manager.prompt';

/**
 * The Manager Agent (planner). Never executes tools itself — it only
 * observes compact state and returns a single structured decision, which
 * the orchestrator validates and dispatches through the safe tool registry.
 */
export class ManagerAgent {
  constructor(private llm: LlmService) {}

  async decide(state: AnalysisState, signal?: AbortSignal): Promise<ManagerDecision> {
    const userPrompt = buildManagerUserPrompt(state);

    const result = await generateStructured(this.llm, {
      systemPrompt: MANAGER_SYSTEM_PROMPT,
      userPrompt,
      schema: managerDecisionSchema,
      signal
    });

    return {
      action: result.action as ManagerDecision['action'],
      arguments: result.arguments ?? {},
      reason: result.reason
    };
  }
}
