import { LlmService } from '../services/llm/llm.service';
import { generateStructured } from '../services/llm/structured-output';
import { verificationOutputSchema } from '../schemas/agent.schema';
import { AnalyzedFinding, VerificationResult } from '../types/findings';
import { buildVerificationUserPrompt, VERIFICATION_SYSTEM_PROMPT } from './prompts/verification.prompt';

export interface VerificationInput {
  language: string;
  sourceCode: string;
  findings: AnalyzedFinding[];
}

export interface VerificationOutput {
  findings: VerificationResult[];
}

/**
 * Agent 3: Verification. Exactly ONE LLM call per analysis.
 */
export class VerificationAgent {
  constructor(private llm: LlmService) {}

  async run(input: VerificationInput): Promise<VerificationOutput> {
    if (input.findings.length === 0) {
      return { findings: [] };
    }

    const userPrompt = buildVerificationUserPrompt({
      language: input.language,
      sourceCode: input.sourceCode,
      analyzedFindingsJson: JSON.stringify(input.findings, null, 2)
    });

    const result = await generateStructured(this.llm, {
      systemPrompt: VERIFICATION_SYSTEM_PROMPT,
      userPrompt,
      schema: verificationOutputSchema
    });

    return result;
  }
}
