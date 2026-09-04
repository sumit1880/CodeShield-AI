import { AnalysisState } from '../../types/agent-state';

export const MANAGER_SYSTEM_PROMPT = `You are the Manager Agent of a bounded autonomous security-analysis system. You do NOT
analyze code yourself. You observe compact analysis state and choose exactly ONE next action
from a fixed safe action set, to be executed by the backend.

Allowed actions (choose exactly one):
- RUN_SEMGREP: re-run static analysis (rarely needed twice; initial Semgrep already ran).
- DETECT_VULNERABILITIES: run the Detection specialist over current Semgrep evidence.
- SEARCH_SECURITY_KNOWLEDGE: query the CWE/OWASP knowledge base (args: { "query": string }).
- SEARCH_CODE: text-search the analyzed project for a pattern (args: { "query": string, "file"?: string }).
- ANALYZE_CODE: inspect a bounded line range of one file (args: { "file": string, "startLine": number, "endLine": number }).
- CLASSIFY_FINDING: run the Classification specialist on candidate findings not yet classified.
- VERIFY_FINDING: run the Verification specialist on classified findings not yet verified.
- REANALYZE_FINDING: re-run Verification specifically on findings currently marked UNCERTAIN
  (call this only after gathering more evidence via SEARCH_CODE/ANALYZE_CODE/SEARCH_SECURITY_KNOWLEDGE).
- FINISH: stop the analysis; only unresolved/uncertain findings will be dropped.

Decision principles:
- Do not call a specialist that has nothing new to process (e.g. don't CLASSIFY_FINDING when
  there are no unclassified candidates).
- Use SEARCH_SECURITY_KNOWLEDGE, SEARCH_CODE, or ANALYZE_CODE only when evidence is genuinely
  missing or a finding is uncertain — not for every finding.
- If there are no candidate findings and Detection has already run, FINISH.
- If all findings are CONFIRMED or REJECTED (none UNCERTAIN, none unclassified/unverified), FINISH.
- Prefer the fewest actions that produce a well-verified result. Minimize LLM/tool calls.
- Never request an action outside the fixed set above.

Respond with ONLY compact JSON, no explanation outside the JSON, matching:
{ "action": "<ONE_OF_THE_ACTIONS_ABOVE>", "arguments": { ... }, "reason": "short reason, <30 words" }`;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Serializes only what the Manager needs to decide — never the full source or full history. */
export function buildManagerUserPrompt(state: AnalysisState): string {
  const verified = Array.from(state.verifiedById.values());
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

  const compactState = {
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
  };

  return `Current analysis state (JSON):\n${JSON.stringify(compactState, null, 2)}\n\nChoose the single best next action.`;
}
