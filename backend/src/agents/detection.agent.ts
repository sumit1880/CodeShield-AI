import { LlmService } from '../services/llm/llm.service';
import { generateStructured } from '../services/llm/structured-output';
import { detectionOutputSchema } from '../schemas/agent.schema';
import { CandidateFinding, SemgrepFinding } from '../types/findings';
import { buildDetectionUserPrompt, DETECTION_SYSTEM_PROMPT } from './prompts/detection.prompt';

export interface DetectionInput {
  language: string;
  sourceCode: string;
  semgrepFindings: SemgrepFinding[];
}

export interface DetectionOutput {
  findings: CandidateFinding[];
}

/**
 * Agent 1: Detection. Exactly ONE LLM call per analysis.
 */
export class DetectionAgent {
  constructor(private llm: LlmService) {}

  async run(input: DetectionInput): Promise<DetectionOutput> {
    const userPrompt = buildDetectionUserPrompt({
      language: input.language,
      sourceCode: input.sourceCode,
      semgrepFindingsJson: JSON.stringify(input.semgrepFindings, null, 2)
    });

    const result = await generateStructured(this.llm, {
      systemPrompt: DETECTION_SYSTEM_PROMPT,
      userPrompt,
      schema: detectionOutputSchema
    });

    return result;
  }
}
