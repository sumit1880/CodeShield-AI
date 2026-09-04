export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
/**
 * 'UNCERTAIN' is an internal verdict only: it tells the Manager Agent more
 * evidence is needed and is never persisted or returned to the API — only
 * CONFIRMED findings ever reach VulnerabilityResponse/the database.
 */
export type VerificationStatus = 'CONFIRMED' | 'REJECTED' | 'UNCERTAIN';

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
 * The only verdicts that ever ship to the API/DB. 'UNCERTAIN' is filtered
 * out in the orchestrator before a finding becomes a VulnerabilityResponse,
 * so this narrower type keeps that guarantee checked by the compiler (and
 * matches the persisted Prisma enum, which has no UNCERTAIN value).
 */
export type ShippedVerificationStatus = Exclude<VerificationStatus, 'UNCERTAIN'>;

/** Final, client-facing shape of a single vulnerability. */
export interface VulnerabilityResponse {
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
  verification: {
    status: ShippedVerificationStatus;
    confidence: number;
  };
}

export interface RetrievedKnowledge {
  content: string;
  source: string;
  score: number;
}