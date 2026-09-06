import { useState } from 'react';
import { UncertainFindingResponse, VulnerabilityResponse } from '../types/api';
import { SeverityBadge } from './SeverityBadge';

interface FindingCardProps {
  finding: VulnerabilityResponse | UncertainFindingResponse;
  index: number;
}

export function FindingCard({ finding, index }: FindingCardProps) {
  const [open, setOpen] = useState(false);
  const isUncertain = finding.verification.status !== 'CONFIRMED';

  return (
    <div
      className="animate-stagger border border-line bg-panel"
      style={{ animationDelay: `${Math.min(index, 10) * 45}ms` }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <div className="flex min-w-0 items-center gap-3">
          <SeverityBadge severity={finding.severity} />
          <span className="truncate font-mono text-sm text-ink">{finding.title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden font-mono text-xs text-ink-faint sm:inline">
            {finding.cwe.id} · {Math.round(finding.confidence * 100)}% confidence
          </span>
          {isUncertain && (
            <span className="border border-medium/50 bg-medium/10 px-2 py-0.5 font-mono text-[11px] text-medium">
              {finding.verification.status.toLowerCase()}
            </span>
          )}
          <ChevronIcon open={open} />
        </div>
      </button>

      {open && (
        <div className="border-t border-line px-4 py-4">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 font-mono text-xs text-ink-dim sm:grid-cols-2">
            <div>
              <dt className="text-ink-faint">CWE</dt>
              <dd className="text-ink">
                {finding.cwe.id} — {finding.cwe.name}
              </dd>
            </div>
            <div>
              <dt className="text-ink-faint">Location</dt>
              <dd className="text-ink">
                {finding.location.file}:{finding.location.lineStart}
                {finding.location.lineEnd !== finding.location.lineStart ? `–${finding.location.lineEnd}` : ''}
                {finding.location.function ? ` (${finding.location.function})` : ''}
              </dd>
            </div>
            <div>
              <dt className="text-ink-faint">Confidence</dt>
              <dd className="text-ink">{Math.round(finding.confidence * 100)}%</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Verification</dt>
              <dd className="text-ink">{finding.verification.status.toLowerCase()}</dd>
            </div>
          </dl>

          {isUncertain && 'reason' in finding.verification && finding.verification.reason && (
            <p className="mt-3 border border-medium/30 bg-medium/5 px-3 py-2 text-sm text-ink-dim">
              {finding.verification.reason}
            </p>
          )}

          <div className="mt-4">
            <p className="font-mono text-xs text-ink-faint">Explanation</p>
            <p className="mt-1 text-sm leading-relaxed text-ink-dim">{finding.explanation}</p>
          </div>
          <div className="mt-4">
            <p className="font-mono text-xs text-ink-faint">Recommendation</p>
            <p className="mt-1 text-sm leading-relaxed text-ink-dim">{finding.recommendation}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      className={`shrink-0 text-ink-faint transition-transform ${open ? 'rotate-180' : ''}`}
    >
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
