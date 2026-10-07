import { DetectionAgent } from '../agents/detection.agent';
import { ClassificationAgent } from '../agents/classification.agent';
import { VerificationAgent } from '../agents/verification.agent';
import { SemgrepService } from '../services/semgrep/semgrep.service';
import { RagService } from '../services/rag/rag.service';
import { CodeSearchService } from '../services/code-context/code-search.service';
import { AgentAction, AnalysisState } from '../types/agent-state';
import { AnalyzedFinding, CandidateFinding } from '../types/findings';

export interface ToolRegistryDeps {
  detectionAgent: DetectionAgent;
  classificationAgent: ClassificationAgent;
  verificationAgent: VerificationAgent;
  semgrepService: SemgrepService;
  ragService: RagService;
  codeSearchService: CodeSearchService;
}

export interface ToolContext {
  projectRoot: string;
  language: string;
  signal?: AbortSignal;
  /** Returns the base source view plus any evidence gathered so far. */
  getSourceView(): string;
}

export interface ToolResult {
  resultSummary: string;
}

type ToolHandler = (state: AnalysisState, args: Record<string, unknown>) => Promise<ToolResult>;

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim().length > 0 ? v : fallback;
}

function asInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function dedupeMerge<T extends { id: string; title?: string; file?: string; lineStart?: number }>(
  existing: T[],
  incoming: T[]
): T[] {
  let nextIdNum = existing.length + 1;
  const result = [...existing];

  for (const item of incoming) {
    const isDuplicate = existing.some(
      (e) =>
        e.title === item.title &&
        e.file === item.file &&
        e.lineStart === item.lineStart
    );

    if (!isDuplicate) {
      result.push({
        ...item,
        id: `finding-${nextIdNum++}`
      });
    }
  }

  return result;
}

/**
 * Builds the fixed, validated set of tools the Manager may invoke. This is
 * the ONLY place actions are dispatched — no arbitrary shell, filesystem,
 * network, or DB access is ever exposed to the LLM.
 */
export function createToolRegistry(deps: ToolRegistryDeps, ctx: ToolContext): Record<AgentAction, ToolHandler> {
  return {
    RUN_SEMGREP: async (state) => {
      const findings = await deps.semgrepService.scan({ targetDir: ctx.projectRoot, language: ctx.language });
      const key = (f: { ruleId: string; file: string; lineStart: number }) => `${f.ruleId}:${f.file}:${f.lineStart}`;
      const seen = new Set(state.semgrepFindings.map(key));
      const newOnes = findings.filter((f) => !seen.has(key(f)));
      state.semgrepFindings = [...state.semgrepFindings, ...newOnes];
      return { resultSummary: `Semgrep found ${findings.length} finding(s) (${newOnes.length} new).` };
    },

    DETECT_VULNERABILITIES: async (state) => {
      const detection = await deps.detectionAgent.run({
        language: ctx.language,
        sourceCode: ctx.getSourceView(),
        semgrepFindings: state.semgrepFindings,
        signal: ctx.signal
      });
      state.candidateFindings = dedupeMerge<CandidateFinding>(state.candidateFindings, detection.findings);
      return { resultSummary: `Detection produced ${detection.findings.length} candidate finding(s).` };
    },

    SEARCH_SECURITY_KNOWLEDGE: async (state, args) => {
      const query = asString(
        args.query,
        `Common vulnerability classes and secure coding guidance relevant to ${ctx.language} code`
      );
      const results = await deps.ragService.retrieve({ query, topK: 5 });
      const existingContent = new Set(state.knowledge.map((k) => k.content));
      for (const r of results) {
        if (!existingContent.has(r.content)) state.knowledge.push(r);
      }
      return { resultSummary: `RAG returned ${results.length} knowledge chunk(s) for "${query}".` };
    },

    SEARCH_CODE: async (state, args) => {
      const query = asString(args.query);
      if (!query) return { resultSummary: 'Skipped: no query provided.' };
      const file = typeof args.file === 'string' ? args.file : undefined;
      const matches = await deps.codeSearchService.searchCode(ctx.projectRoot, state.files, query, file);
      for (const m of matches) state.evidence.push(`[SEARCH_CODE "${query}"] ${m}`);
      return { resultSummary: `Found ${matches.length} match(es) for "${query}".` };
    },

    ANALYZE_CODE: async (state, args) => {
      const file = asString(args.file);
      if (!file) return { resultSummary: 'Skipped: no file provided.' };
      const startLine = asInt(args.startLine, 1);
      const endLine = asInt(args.endLine, startLine + 20);
      const snippet = await deps.codeSearchService.analyzeCode(ctx.projectRoot, state.files, file, startLine, endLine);
      state.evidence.push(`[ANALYZE_CODE ${file}:${startLine}-${endLine}]\n${snippet}`);
      return { resultSummary: `Inspected ${file} lines ${startLine}-${endLine}.` };
    },

    CLASSIFY_FINDING: async (state) => {
      const classifiedIds = new Set(state.classifiedFindings.map((f) => f.id));
      const pending = state.candidateFindings.filter((f) => !classifiedIds.has(f.id));
      if (pending.length === 0) return { resultSummary: 'No unclassified candidate findings.' };

      const classification = await deps.classificationAgent.run({
        language: ctx.language,
        sourceCode: ctx.getSourceView(),
        findings: pending,
        securityKnowledge: state.knowledge,
        signal: ctx.signal
      });

      const byId = new Map(state.classifiedFindings.map((f) => [f.id, f]));
      for (let i = 0; i < classification.findings.length; i++) {
        const item = classification.findings[i];
        // If the LLM returned its own ID (e.g. F1), map it to the corresponding pending candidate ID
        const targetId = pending.find((p) => p.id === item.id)?.id ?? pending[i]?.id ?? item.id;
        byId.set(targetId, { ...item, id: targetId });
      }
      state.classifiedFindings = Array.from(byId.values());
      return { resultSummary: `Classified ${classification.findings.length} finding(s).` };
    },

    VERIFY_FINDING: async (state) => {
      const pending = state.classifiedFindings.filter((f) => !state.verifiedById.has(f.id));
      if (pending.length === 0) return { resultSummary: 'No unverified classified findings.' };

      const verification = await deps.verificationAgent.run({
        language: ctx.language,
        sourceCode: ctx.getSourceView(),
        findings: pending,
        semgrepFindings: state.semgrepFindings,
        signal: ctx.signal
      });
      for (let i = 0; i < verification.findings.length; i++) {
        const v = verification.findings[i];
        const targetId = pending.find((p) => p.id === v.id)?.id ?? pending[i]?.id ?? v.id;
        state.verifiedById.set(targetId, { ...v, id: targetId });
      }
      return { resultSummary: `Verified ${verification.findings.length} finding(s).` };
    },

    REANALYZE_FINDING: async (state) => {
      const uncertainIds = new Set(
        Array.from(state.verifiedById.values())
          .filter((v) => v.status === 'UNCERTAIN')
          .map((v) => v.id)
      );
      const targets = state.classifiedFindings.filter((f) => uncertainIds.has(f.id));
      if (targets.length === 0) return { resultSummary: 'No UNCERTAIN findings to reanalyze.' };

      const verification = await deps.verificationAgent.run({
        language: ctx.language,
        sourceCode: ctx.getSourceView(),
        findings: targets,
        semgrepFindings: state.semgrepFindings,
        signal: ctx.signal
      });
      for (let i = 0; i < verification.findings.length; i++) {
        const v = verification.findings[i];
        const targetId = targets.find((t) => t.id === v.id)?.id ?? targets[i]?.id ?? v.id;
        state.verifiedById.set(targetId, { ...v, id: targetId });
      }
      return { resultSummary: `Reanalyzed ${verification.findings.length} previously uncertain finding(s).` };
    },

    FINISH: async () => ({ resultSummary: 'Manager requested finish.' })
  };
}
