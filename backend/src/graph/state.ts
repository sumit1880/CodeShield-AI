import { Annotation } from '@langchain/langgraph';
import {
  SemgrepFinding,
  CandidateFinding,
  AnalyzedFinding,
  VerificationResult,
  RetrievedKnowledge
} from '../types/findings';
import { ActionLogEntry, AgentAction, ManagerDecision } from '../types/agent-state';

// ─── Reducer Helpers ────────────────────────────────────────────────────────

function dedupeSemgrep(existing: SemgrepFinding[], incoming: SemgrepFinding[]): SemgrepFinding[] {
  const key = (f: SemgrepFinding) => `${f.ruleId}:${f.file}:${f.lineStart}`;
  const seen = new Set(existing.map(key));
  const result = [...existing];
  for (const f of incoming) {
    if (!seen.has(key(f))) {
      result.push(f);
      seen.add(key(f));
    }
  }
  return result;
}

/**
 * Merges incoming candidates into existing list, assigning stable sequential
 * IDs (finding-1, finding-2, …). Deduplication uses title+file+lineStart.
 */
export function dedupeCandidateFindings(
  existing: CandidateFinding[],
  incoming: CandidateFinding[]
): CandidateFinding[] {
  let nextIdNum = existing.length + 1;
  const result = [...existing];

  for (const item of incoming) {
    const isDuplicate = existing.some(
      (e) => e.title === item.title && e.file === item.file && e.lineStart === item.lineStart
    );
    if (!isDuplicate) {
      result.push({ ...item, id: `finding-${nextIdNum++}` });
    }
  }
  return result;
}

/** Merges classified findings by ID; incoming entries overwrite existing ones. */
function mergeClassifiedFindings(
  existing: AnalyzedFinding[],
  incoming: AnalyzedFinding[]
): AnalyzedFinding[] {
  const byId = new Map(existing.map((f) => [f.id, f]));
  for (const f of incoming) {
    byId.set(f.id, f);
  }
  return Array.from(byId.values());
}

function dedupeKnowledge(existing: RetrievedKnowledge[], incoming: RetrievedKnowledge[]): RetrievedKnowledge[] {
  const seen = new Set(existing.map((k) => k.content));
  const result = [...existing];
  for (const k of incoming) {
    if (!seen.has(k.content)) {
      result.push(k);
      seen.add(k.content);
    }
  }
  return result;
}

// ─── Finalized Findings Output ───────────────────────────────────────────────

export interface FinalizedFindings {
  vulnerabilities: import('../types/findings').VulnerabilityResponse[];
  uncertainFindings: import('../types/findings').UncertainFindingResponse[];
  rejectedCount: number;
  partial: boolean;
}

// ─── LangGraph State Annotation ─────────────────────────────────────────────

export const AnalysisGraphAnnotation = Annotation.Root({
  // ── Run Configuration (set once, never updated) ──────────────────────────
  language: Annotation<string>({
    reducer: (_, update) => update,
    default: () => ''
  }),
  projectRoot: Annotation<string>({
    reducer: (_, update) => update,
    default: () => ''
  }),
  files: Annotation<string[]>({
    reducer: (_, update) => update,
    default: () => []
  }),
  sourceCode: Annotation<string>({
    reducer: (_, update) => update,
    default: () => ''
  }),
  goal: Annotation<string>({
    reducer: (_, update) => update,
    default: () => ''
  }),
  deadline: Annotation<number>({
    reducer: (_, update) => update,
    default: () => 0
  }),
  // AbortSignal is not JSON-serializable; we keep it in the config object at
  // graph invocation time via RunnableConfig rather than in state.

  // ── Dynamic Analysis State ────────────────────────────────────────────────
  semgrepFindings: Annotation<SemgrepFinding[]>({
    reducer: (existing, incoming) => dedupeSemgrep(existing, incoming ?? []),
    default: () => []
  }),
  candidateFindings: Annotation<CandidateFinding[]>({
    reducer: (existing, incoming) => dedupeCandidateFindings(existing, incoming ?? []),
    default: () => []
  }),
  classifiedFindings: Annotation<AnalyzedFinding[]>({
    reducer: (existing, incoming) => mergeClassifiedFindings(existing, incoming ?? []),
    default: () => []
  }),
  /** Plain Record<string, VerificationResult> — JSON-safe, merged by key. */
  verifiedById: Annotation<Record<string, VerificationResult>>({
    reducer: (existing, incoming) => ({ ...existing, ...(incoming ?? {}) }),
    default: () => ({})
  }),
  knowledge: Annotation<RetrievedKnowledge[]>({
    reducer: (existing, incoming) => dedupeKnowledge(existing, incoming ?? []),
    default: () => []
  }),
  evidence: Annotation<string[]>({
    reducer: (existing, incoming) => [...existing, ...(incoming ?? [])],
    default: () => []
  }),
  actionsTaken: Annotation<ActionLogEntry[]>({
    reducer: (existing, incoming) => [...existing, ...(incoming ?? [])],
    default: () => []
  }),

  // ── Execution Counters ────────────────────────────────────────────────────
  iteration: Annotation<number>({
    reducer: (current, update) => (update !== undefined ? update : current),
    default: () => 0
  }),
  toolCallCount: Annotation<number>({
    reducer: (current, update) => (update !== undefined ? update : current),
    default: () => 0
  }),
  stopReason: Annotation<'FINISHED' | 'MAX_ITERATIONS' | 'MAX_TOOL_CALLS' | 'TIMEOUT'>({
    reducer: (_, update) => update ?? 'FINISHED',
    default: () => 'FINISHED'
  }),

  // ── Planner Decision (transient — overwritten each iteration) ────────────
  nextAction: Annotation<ManagerDecision | null>({
    reducer: (_, update) => update ?? null,
    default: () => null
  }),

  // ── Final Output ─────────────────────────────────────────────────────────
  finalized: Annotation<FinalizedFindings | null>({
    reducer: (_, update) => update ?? null,
    default: () => null
  })
});

export type AnalysisGraphState = typeof AnalysisGraphAnnotation.State;
export type AnalysisGraphUpdate = typeof AnalysisGraphAnnotation.Update;
