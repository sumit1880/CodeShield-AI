import { useEffect, useState } from 'react';
import { ApiRequestError } from '../types/api';

interface ErrorBannerProps {
  error: Error;
  onRetry: () => void;
}

export function ErrorBanner({ error, onRetry }: ErrorBannerProps) {
  const isApiError = error instanceof ApiRequestError;
  const status = isApiError ? error.status : null;

  const [cooldown, setCooldown] = useState<number | null>(
    isApiError && error.status === 429 ? error.retryAfterSeconds ?? 30 : null
  );

  useEffect(() => {
    if (cooldown === null || cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((c) => (c !== null ? c - 1 : c)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  let title = 'Something went wrong';
  let body = error.message || 'The request failed unexpectedly.';
  let canRetry = true;

  if (status === 400) {
    title = 'Request rejected';
    body = error.message || 'The server rejected the request as invalid.';
  } else if (status === 401) {
    title = 'Session ended';
    body = 'Your Google session expired or was rejected. Sign in again to continue.';
    canRetry = false;
  } else if (status === 429) {
    title = 'Rate limit reached';
    body = 'Too many requests in a short window. This is a manual retry — it will not resubmit automatically.';
  } else if (status === 503) {
    title = 'Analyzer at capacity';
    body = error.message || 'The server is already running the maximum number of concurrent analyses. Try again shortly.';
  } else if (status === 413) {
    title = 'Too large';
    body = error.message || 'The submission exceeded a size limit.';
  } else if (status === 504) {
    title = 'Analysis timed out';
    body = 'The AI provider chain took too long to respond. Try again, or with a smaller submission.';
  } else if (status && status >= 500) {
    title = 'Server error';
    body = error.message || 'An unexpected server error occurred.';
  }

  const cooldownActive = cooldown !== null && cooldown > 0;

  return (
    <div className="border border-critical/40 bg-critical/5 p-5">
      <p className="font-mono text-sm text-critical">{title}</p>
      <p className="mt-1.5 text-sm text-ink-dim">{body}</p>
      {canRetry && (
        <button
          onClick={onRetry}
          disabled={cooldownActive}
          className="mt-4 border border-line px-3 py-1.5 font-mono text-xs text-ink transition hover:border-line-bright disabled:cursor-not-allowed disabled:opacity-40"
        >
          {cooldownActive ? `Retry available in ${cooldown}s` : 'Retry'}
        </button>
      )}
    </div>
  );
}
