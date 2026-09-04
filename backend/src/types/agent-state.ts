import { AnalyzedFinding, CandidateFinding, RetrievedKnowledge, SemgrepFinding, VerificationResult } from './findings';

/** Fixed, safe action set the Manager Agent may choose from. No arbitrary tool execution. */
export const AGENT_ACTIONS = [
  'RUN_SEMGREP',
  'DETECT_VULNERABILITIES',
  'SEARCH_SECURITY_KNOWLEDGE',
  'SEARCH_CODE',
  'ANALYZE_CODE',
  'CLASSIFY_FINDING',
  'VERIFY_FINDING',
  'REANALYZE_FINDING',
  'FINISH'
] as const;

export type AgentAction = (typeof AGENT_ACTIONS)[number];

export interface ManagerDecision {
  action: AgentAction;
  arguments: Record<string, unknown>;
  reason: string;
}

export interface ActionLogEntry {
  iteration: number;
  action: AgentAction;
  reason: string;
  resultSummary?: string;
  error?: string;
}

/**
 * Compact, in-memory state for a single analysis run. Passed to the
 * Manager on every iteration (serialized in a condensed form to keep
 * prompts small) and mutated by the tool registry as actions execute.
 */
export interface AnalysisState {
  goal: string;
  language: string;
  /** Analyzable file paths, relative to projectRoot. Bounds SEARCH_CODE/ANALYZE_CODE. */
  files: string[];

  semgrepFindings: SemgrepFinding[];
  candidateFindings: CandidateFinding[];
  classifiedFindings: AnalyzedFinding[];
  /** Latest verification verdict per finding id (CONFIRMED / REJECTED / UNCERTAIN). */
  verifiedById: Map<string, VerificationResult>;

  knowledge: RetrievedKnowledge[];
  /** Free-text evidence gathered via SEARCH_CODE / ANALYZE_CODE, appended to the LLM source view. */
  evidence: string[];

  actionsTaken: ActionLogEntry[];
  iteration: number;
  toolCallCount: number;
  status: 'RUNNING' | 'DONE' | 'FAILED';
}
