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
  const res = await fetch(`${BASE_URL}/api/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`
    },
    body: JSON.stringify({ language, code }),
    signal
  });
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

  const query = language && language !== 'auto' ? `?language=${encodeURIComponent(language)}` : '';

  const res = await fetch(`${BASE_URL}/api/analyze/upload${query}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`
    },
    body: form,
    signal
  });
  return handleResponse<AnalyzeSuccessResponse>(res);
}

export const API_BASE_URL = BASE_URL;
