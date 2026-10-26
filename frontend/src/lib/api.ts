import { AnalyzeSuccessResponse, ApiErrorBody, ApiRequestError } from '../types/api';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, '') || 'http://localhost:3000';

let onUnauthorized: (() => void) | null = null;

/** Registered once by AuthContext so any 401 anywhere bounces the user back to login. */
export function registerUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

function parseRetryAfter(res: Response): number | undefined {
  const header = res.headers.get('Retry-After');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : undefined;
}

async function parseErrorBody(res: Response): Promise<ApiErrorBody | null> {
  try {
    const body = await res.json();
    if (body && typeof body === 'object' && 'error' in body) return body as ApiErrorBody;
    return null;
  } catch {
    return null;
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.ok) {
    return (await res.json()) as T;
  }

  const body = await parseErrorBody(res);
  const retryAfter = parseRetryAfter(res);
  const err = new ApiRequestError(res.status, body, retryAfter);

  if (res.status === 401) {
    onUnauthorized?.();
  }

  throw err;
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) return false;
    const body = await res.json();
    return body?.success === true;
  } catch {
    return false;
  }
}

export async function analyzeCode(
  idToken: string,
  language: string,
  code: string,
  signal?: AbortSignal
): Promise<AnalyzeSuccessResponse> {
  // Submit async:true so backend responds with 202+jobId immediately,
  // avoiding gateway/client timeouts when Gemini thinking takes 300+ seconds.
  const res = await fetch(`${BASE_URL}/api/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`
    },
    body: JSON.stringify({ language, code, async: true }),
    signal
  });
  if (res.status === 202) {
    const job = (await res.json()) as { jobId: string };
    return pollForResult(idToken, job.jobId, signal);
  }
  return handleResponse<AnalyzeSuccessResponse>(res);
}

export async function analyzeUpload(
  idToken: string,
  file: File,
  language: string,
  signal?: AbortSignal
): Promise<AnalyzeSuccessResponse> {
  const form = new FormData();
  form.append('file', file);

  const query = language && language !== 'auto'
    ? `?language=${encodeURIComponent(language)}&async=true`
    : '?async=true';

  const res = await fetch(`${BASE_URL}/api/analyze/upload${query}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`
    },
    body: form,
    signal
  });
  if (res.status === 202) {
    const job = (await res.json()) as { jobId: string };
    return pollForResult(idToken, job.jobId, signal);
  }
  return handleResponse<AnalyzeSuccessResponse>(res);
}

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Polls GET /api/analyses/:id until the analysis completes, then reconstructs
 * the AnalyzeSuccessResponse shape expected by the rest of the UI.
 */
async function pollForResult(
  idToken: string,
  jobId: string,
  signal?: AbortSignal
): Promise<AnalyzeSuccessResponse> {
  const deadline = Date.now() + POLL_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    await sleep(POLL_INTERVAL_MS, signal);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const res = await fetch(`${BASE_URL}/api/analyses/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${idToken}` },
      signal
    });

    if (!res.ok) await handleResponse<never>(res);

    const body = (await res.json()) as { success: true; data: any };
    const data = body.data;
    const status: string = data.status ?? 'RUNNING';

    if (status === 'FAILED') {
      throw new Error('Analysis failed on the server. Please try again.');
    }

    if (status === 'COMPLETED' || status === 'PARTIAL') {
      const findings: any[] = data.findings ?? [];
      return {
        success: true,
        analysis: {
          id: data.id,
          language: data.language,
          analysisStatus: status as any,
          partial: status === 'PARTIAL',
          summary: {
            totalIssues: findings.length,
            critical: findings.filter(function(f) { return f.severity === 'CRITICAL'; }).length,
            high: findings.filter(function(f) { return f.severity === 'HIGH'; }).length,
            medium: findings.filter(function(f) { return f.severity === 'MEDIUM'; }).length,
            low: findings.filter(function(f) { return f.severity === 'LOW'; }).length,
            info: findings.filter(function(f) { return f.severity === 'INFO'; }).length,
          },
          vulnerabilities: findings
            .filter((f) => f.verificationStatus === 'CONFIRMED')
            .map(mapConfirmedFinding),
          uncertainFindings: findings
            .filter((f) => f.verificationStatus === 'UNCERTAIN')
            .map(mapUncertainFinding)
        }
      };
    }
    // PENDING / RUNNING — keep polling
  }

  throw new Error('Analysis is taking longer than expected. Check your history once complete.');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function mapConfirmedFinding(f: any): import('../types/api').VulnerabilityResponse {
  const conf = typeof f.confidence === 'number' ? f.confidence : 0.5;
  return {
    id: f.id ?? '',
    title: f.title ?? '',
    severity: (f.severity ?? 'UNKNOWN') as any,
    confidence: conf,
    cwe: { id: f.cweId ?? '', name: f.cweName ?? '' },
    location: {
      file: f.file ?? 'unknown',
      function: f.function ?? null,
      lineStart: f.lineStart ?? 0,
      lineEnd: f.lineEnd ?? 0
    },
    explanation: f.explanation ?? '',
    recommendation: f.recommendation ?? '',
    verification: { status: 'CONFIRMED', confidence: conf }
  };
}

function mapUncertainFinding(f: any): import('../types/api').UncertainFindingResponse {
  const conf = typeof f.confidence === 'number' ? f.confidence : 0.5;
  return {
    id: f.id ?? '',
    title: f.title ?? '',
    severity: (f.severity ?? 'UNKNOWN') as any,
    confidence: conf,
    cwe: { id: f.cweId ?? '', name: f.cweName ?? '' },
    location: {
      file: f.file ?? 'unknown',
      function: f.function ?? null,
      lineStart: f.lineStart ?? 0,
      lineEnd: f.lineEnd ?? 0
    },
    explanation: f.explanation ?? '',
    recommendation: f.recommendation ?? '',
    verification: { status: 'UNCERTAIN', confidence: conf, reason: f.verificationReason ?? undefined }
  };
}

export async function getAnalyses(
  idToken: string,
  page: number = 1,
  limit: number = 20,
  signal?: AbortSignal
): Promise<{
  success: true;
  data: Array<{
    id: string;
    language: string;
    sourceType: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    durationMs: number | null;
    findingCount: number;
  }>;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const res = await fetch(`${BASE_URL}/api/analyses?page=${page}&limit=${limit}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${idToken}`
    },
    signal
  });
  return handleResponse(res);
}

export async function getAnalysisById(
  idToken: string,
  id: string,
  signal?: AbortSignal
): Promise<{ success: true; data: any }> {
  const res = await fetch(`${BASE_URL}/api/analyses/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${idToken}`
    },
    signal
  });
  return handleResponse(res);
}

export const API_BASE_URL = BASE_URL;
