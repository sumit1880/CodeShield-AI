export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
/**
 * 'CONFIRMED' / 'REJECTED' / 'UNCERTAIN' are the Verification Agent's own
 * verdicts (UNCERTAIN tells the Manager more evidence is needed). 'UNVERIFIED'
 * is a code-assigned status (never produced by the LLM) applied at
 * finalization time to a classified finding that the pipeline ran out of
 * budget to verify at all (e.g. the global analysis timeout was hit before
 * VERIFY_FINDING could run on it). Only CONFIRMED findings ever ship as
 * VulnerabilityResponse/persist to the database; UNCERTAIN and UNVERIFIED
 * ship separately as "uncertain findings" so a timeout never silently
 * erases already-classified work.
 */
export type VerificationStatus = 'CONFIRMED' | 'REJECTED' | 'UNCERTAIN' | 'UNVERIFIED';

export interface SemgrepFinding {
  ruleId: string;
  message: string;
  severity: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  columnStart?: number;
  columnEnd?: number;
  metadata?: Record<string, unknown>;
}

/** Output of Agent 1 (Detection). */
export interface CandidateFinding {
  id: string;
  title: string;
  category: string;
  evidence: string;
  file: string;
  lineStart: number;
  lineEnd: number;
}

/** Output of Agent 2 (CWE + Localization + Explanation). */
export interface AnalyzedFinding {
  id: string;
  title: string;
  cwe: {
    id: string;
    name: string;
  };
  severity: Severity;
  confidence: number;
  location: {
    file: string;
    function: string | null;
    lineStart: number;
    lineEnd: number;
  };
  explanation: string;
  recommendation: string;
}

/** Output of Agent 3 (Verification), one entry per finding id. */
export interface VerificationResult {
  id: string;
  status: VerificationStatus;
  confidence: number;
  reason: string;
}

/**
 * The only verdict that ever ships as a VulnerabilityResponse / persists to
 * the database. REJECTED findings are dropped entirely; UNCERTAIN and
 * UNVERIFIED findings ship separately (see UncertainFindingResponse) so
 * this narrower type keeps the "never falsely confirm" guarantee checked
 * by the compiler, matching the persisted Prisma enum.
 */
export type ShippedVerificationStatus = 'CONFIRMED';

interface BaseFindingResponse {
  id: string;
  title: string;
  cwe: { id: string; name: string };
  severity: Severity;
  confidence: number;
  location: {
    file: string;
    function: string | null;
    lineStart: number;
    lineEnd: number;
  };
  explanation: string;
  recommendation: string;
}

/** Final, client-facing shape of a single confirmed vulnerability. */
export interface VulnerabilityResponse extends BaseFindingResponse {
  verification: {
    status: ShippedVerificationStatus;
    confidence: number;
    reason?: string;
  };
}

/**
 * A classified finding that could not be safely reported as either
 * CONFIRMED or REJECTED — either the Verification Agent itself was unsure
 * (UNCERTAIN) or the analysis ran out of budget before verifying it at all
 * (UNVERIFIED). Returned to the client separately from `vulnerabilities` so
 * a timeout never looks identical to "no vulnerabilities found".
 */
export interface UncertainFindingResponse extends BaseFindingResponse {
  verification: {
    status: Extract<VerificationStatus, 'UNCERTAIN' | 'UNVERIFIED'>;
    confidence: number;
    reason?: string;
  };
}

export interface RetrievedKnowledge {
  content: string;
  source: string;
  score: number;
}