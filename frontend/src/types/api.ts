export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface FindingLocation {
  file: string;
  function: string | null;
  lineStart: number;
  lineEnd: number;
}

export interface Cwe {
  id: string;
  name: string;
}

export interface VulnerabilityResponse {
  id: string;
  title: string;
  cwe: Cwe;
  severity: Severity;
  confidence: number;
  location: FindingLocation;
  explanation: string;
  recommendation: string;
  verification: {
    status: 'CONFIRMED';
    confidence: number;
  };
}

export interface UncertainFindingResponse {
  id: string;
  title: string;
  cwe: Cwe;
  severity: Severity;
  confidence: number;
  location: FindingLocation;
  explanation: string;
  recommendation: string;
  verification: {
    status: 'UNCERTAIN' | 'UNVERIFIED';
    confidence: number;
    reason?: string;
  };
}

export type AnalysisStatus = 'COMPLETE' | 'PARTIAL' | string;

export interface AnalysisSummary {
  totalIssues: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface AnalysisResult {
  id: string;
  language: string;
  summary: AnalysisSummary;   // was: string
  vulnerabilities: VulnerabilityResponse[];
  uncertainFindings: UncertainFindingResponse[];
  partial: boolean;
  analysisStatus: AnalysisStatus;
}

export interface AnalyzeSuccessResponse {
  success: true;
  analysis: AnalysisResult;
}

export const ErrorCode = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  EMPTY_CODE: 'EMPTY_CODE',
  UNSUPPORTED_LANGUAGE: 'UNSUPPORTED_LANGUAGE',
  CODE_TOO_LARGE: 'CODE_TOO_LARGE',
  ZIP_TOO_LARGE: 'ZIP_TOO_LARGE',
  ARCHIVE_TOO_LARGE: 'ARCHIVE_TOO_LARGE',
  TOO_MANY_FILES: 'TOO_MANY_FILES',
  UNSAFE_ARCHIVE: 'UNSAFE_ARCHIVE',
  SEMGREP_NOT_INSTALLED: 'SEMGREP_NOT_INSTALLED',
  SEMGREP_ERROR: 'SEMGREP_ERROR',
  AI_RATE_LIMIT: 'AI_RATE_LIMIT',
  AI_TIMEOUT: 'AI_TIMEOUT',
  AI_PROVIDER_ERROR: 'AI_PROVIDER_ERROR',
  INVALID_AI_RESPONSE: 'INVALID_AI_RESPONSE',
  DATABASE_ERROR: 'DATABASE_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_BUSY: 'SERVICE_BUSY',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorBody {
  success: false;
  error: {
    code: ErrorCodeType | string;
    message: string;
    details?: unknown;
  };
}

/** Thrown by the API client. Carries the HTTP status so callers can branch on it. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;

  constructor(status: number, body: ApiErrorBody | null, retryAfterSeconds?: number) {
    super(body?.error?.message ?? `Request failed with status ${status}`);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body?.error?.code ?? 'UNKNOWN';
    this.details = body?.error?.details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const SUPPORTED_LANGUAGES = [
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'java', label: 'Java' },
  { id: 'go', label: 'Go' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'php', label: 'PHP' },
  { id: 'csharp', label: 'C#' }
] as const;

export const UPLOAD_LANGUAGES = [{ id: 'auto', label: 'Auto-detect' }, ...SUPPORTED_LANGUAGES] as const;
