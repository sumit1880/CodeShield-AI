import path from 'path';
import { LlmService } from '../services/llm/llm.service';
import { generateStructured } from '../services/llm/structured-output';
import { verificationOutputSchema } from '../schemas/agent.schema';
import { AnalyzedFinding, SemgrepFinding, VerificationResult } from '../types/findings';
import { buildVerificationUserPrompt, VERIFICATION_SYSTEM_PROMPT } from './prompts/verification.prompt';

export interface VerificationInput {
  language: string;
  sourceCode: string;
  findings: AnalyzedFinding[];
  semgrepFindings?: SemgrepFinding[];
  signal?: AbortSignal;
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
      schema: verificationOutputSchema,
      signal: input.signal
    });

    // Semgrep findings with severity ERROR are a floor:
    // the verifier may mark them UNCERTAIN but not silently REJECTED without a stored reason.
    if (input.semgrepFindings && input.semgrepFindings.length > 0) {
      const errorSemgrep = input.semgrepFindings.filter(
        (sf) => sf.severity?.toUpperCase() === 'ERROR'
      );

      if (errorSemgrep.length > 0) {
        const findingById = new Map(input.findings.map((f) => [f.id, f]));

        for (const verdict of result.findings) {
          const finding = findingById.get(verdict.id);
          if (!finding) continue;

          const isSemgrepError = errorSemgrep.some((sf) => {
            const fileMatch =
              sf.file === finding.location.file ||
              path.normalize(sf.file) === path.normalize(finding.location.file) ||
              sf.file.endsWith(finding.location.file) ||
              finding.location.file.endsWith(sf.file);
            if (!fileMatch) return false;
            return Math.max(sf.lineStart, finding.location.lineStart) <= Math.min(sf.lineEnd, finding.location.lineEnd);
          });

          if (isSemgrepError && verdict.status === 'REJECTED') {
            const hasReason = verdict.reason && verdict.reason.trim().length > 0;
            if (!hasReason) {
              verdict.status = 'UNCERTAIN';
              verdict.reason = 'Semgrep ERROR finding cannot be silently REJECTED without a stored reason';
            }
          }
        }
      }
    }

    const findings: VerificationResult[] = result.findings.map((f) => ({
      id: f.id,
      status: f.status,
      confidence: f.confidence,
      reason: f.reason || ''
    }));

    return { findings };
  }
}
