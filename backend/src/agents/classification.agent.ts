import { LlmService } from '../services/llm/llm.service';
import { generateStructured } from '../services/llm/structured-output';
import { classificationOutputSchema } from '../schemas/agent.schema';
import { AnalyzedFinding, CandidateFinding, RetrievedKnowledge } from '../types/findings';
import {
  buildClassificationUserPrompt,
  CLASSIFICATION_SYSTEM_PROMPT
} from './prompts/classification.prompt';

export interface ClassificationInput {
  language: string;
  sourceCode: string;
  findings: CandidateFinding[];
  securityKnowledge?: RetrievedKnowledge[];
  signal?: AbortSignal;
}

export interface ClassificationOutput {
  findings: AnalyzedFinding[];
}

/**
 * Agent 2: CWE + Localization + Explanation. Exactly ONE LLM call per analysis.
 */
export class ClassificationAgent {
  constructor(private llm: LlmService) {}

  async run(input: ClassificationInput): Promise<ClassificationOutput> {
    // If Agent 1 found nothing, skip the LLM call entirely — nothing to classify.
    if (input.findings.length === 0) {
      return { findings: [] };
    }

    const userPrompt = buildClassificationUserPrompt({
      language: input.language,
      sourceCode: input.sourceCode,
      candidateFindingsJson: JSON.stringify(input.findings, null, 2),
      retrievedKnowledgeJson: JSON.stringify(input.securityKnowledge ?? [], null, 2)
    });

    const result = await generateStructured(this.llm, {
      systemPrompt: CLASSIFICATION_SYSTEM_PROMPT,
      userPrompt,
      schema: classificationOutputSchema,
      signal: input.signal
    });

    return result;
  }
}
