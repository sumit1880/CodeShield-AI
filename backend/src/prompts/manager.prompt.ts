import { ChatPromptTemplate } from '@langchain/core/prompts';
import { SystemMessage } from '@langchain/core/messages';
import { AnalysisState } from '../types/agent-state';

export const MANAGER_SYSTEM_PROMPT = `You are the Manager Agent of a bounded autonomous security-analysis system. You do NOT
analyze code yourself. You observe compact analysis state and choose exactly ONE next action
from a fixed safe action set, to be executed by the backend.

Note: the backend automatically runs CLASSIFY_FINDING whenever unclassified candidates exist,
and VERIFY_FINDING whenever classified findings still need verification — it will never ask
you to decide in those situations, so you only need to choose between the actions below.

Allowed actions (choose exactly one):
- RUN_SEMGREP: re-run static analysis (rarely needed twice; initial Semgrep already ran).
- DETECT_VULNERABILITIES: run the Detection specialist over current Semgrep evidence.
- SEARCH_SECURITY_KNOWLEDGE: query the CWE/OWASP knowledge base (args: { "query": string }).
- SEARCH_CODE: text-search the analyzed project for a pattern (args: { "query": string, "file"?: string }).
- ANALYZE_CODE: inspect a bounded line range of one file (args: { "file": string, "startLine": number, "endLine": number }).
- REANALYZE_FINDING: re-run Verification specifically on findings currently marked UNCERTAIN
  (call this only after gathering more evidence via SEARCH_CODE/ANALYZE_CODE/SEARCH_SECURITY_KNOWLEDGE).
- FINISH: stop the analysis. Any classified finding left unverified is still returned to the
  client separately as an uncertain/unverified finding — never as a confirmed vulnerability.

Decision principles:
- If there are no candidate findings and Detection has already run, FINISH.
- If every finding is resolved (CONFIRMED or REJECTED, none UNCERTAIN), FINISH.
- Use SEARCH_SECURITY_KNOWLEDGE, SEARCH_CODE, or ANALYZE_CODE only when evidence is genuinely
  missing for an UNCERTAIN finding — not speculatively.
- Prefer the fewest actions that produce a well-verified result. Minimize LLM/tool calls.
- Never request an action outside the fixed set above.

Respond with ONLY compact JSON, no explanation outside the JSON, matching:
{ "action": "<ONE_OF_THE_ACTIONS_ABOVE>", "arguments": { ... }, "reason": "short reason, <30 words" }`;

export const managerTemplate = ChatPromptTemplate.fromMessages([
  new SystemMessage(MANAGER_SYSTEM_PROMPT),
  ['human', 'Current analysis state (JSON):\n{compactState}\n\nChoose the single best next action.']
]);

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Serializes only what the Manager needs — compact, never full source or full history. */
export function buildManagerCompactState(state: AnalysisState): string {
  const verified = Object.entries(state.verifiedById).map(([id, v]) => ({ id, ...v }));
  const uncertainIds = verified.filter((v) => v.status === 'UNCERTAIN').map((v) => v.id);
  const classifiedIds = new Set(state.classifiedFindings.map((f) => f.id));
  const verifiedIds = new Set(verified.map((v) => v.id));

  const unclassifiedCount = state.candidateFindings.filter((f) => !classifiedIds.has(f.id)).length;
  const unverifiedCount = state.classifiedFindings.filter((f) => !verifiedIds.has(f.id)).length;

  const recentActions = state.actionsTaken.slice(-6).map((a) => ({
    action: a.action,
    reason: truncate(a.reason, 80),
    result: a.error ? `ERROR: ${truncate(a.error, 80)}` : truncate(a.resultSummary || '', 100)
  }));

  return JSON.stringify(
    {
      goal: state.goal,
      language: state.language,
      fileCount: state.files.length,
      counts: {
        semgrepFindings: state.semgrepFindings.length,
        candidateFindings: state.candidateFindings.length,
        classifiedFindings: state.classifiedFindings.length,
        verified: verified.length,
        confirmed: verified.filter((v) => v.status === 'CONFIRMED').length,
        rejected: verified.filter((v) => v.status === 'REJECTED').length,
        uncertain: uncertainIds.length,
        unclassified: unclassifiedCount,
        unverified: unverifiedCount,
        knowledgeChunks: state.knowledge.length,
        evidenceItems: state.evidence.length
      },
      uncertainFindingIds: uncertainIds,
      iteration: state.iteration,
      toolCallsSoFar: state.toolCallCount,
      recentActions
    },
    null,
    2
  );
}
