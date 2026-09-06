import { useState } from 'react';
import { AnalysisResult, Severity } from '../types/api';
import { FindingCard } from './FindingCard';

const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

function countBySeverity(result: AnalysisResult) {
  const counts: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const v of result.vulnerabilities) counts[v.severity]++;
  return counts;
}

export function ResultsView({ result, onNewScan }: { result: AnalysisResult; onNewScan: () => void }) {
  const [tab, setTab] = useState<'confirmed' | 'uncertain'>('confirmed');
  const counts = countBySeverity(result);
  const sortedConfirmed = [...result.vulnerabilities].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );

  return (
    <div>
      <div className="border border-line bg-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-mono text-xs text-ink-faint">
              scan #{result.id.slice(0, 8)} · {result.language}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-ink">
  {result.summary.totalIssues} issue{result.summary.totalIssues === 1 ? '' : 's'} found
  {result.summary.totalIssues > 0 && (
    <span className="text-ink-faint">
      {' '}({[
        result.summary.critical && `${result.summary.critical} critical`,
        result.summary.high && `${result.summary.high} high`,
        result.summary.medium && `${result.summary.medium} medium`,
        result.summary.low && `${result.summary.low} low`,
        result.summary.info && `${result.summary.info} info`
      ].filter(Boolean).join(', ')})
    </span>
  )}
</p>
          </div>
          <button
            onClick={onNewScan}
            className="shrink-0 border border-line px-3 py-1.5 font-mono text-xs text-ink-dim transition hover:border-line-bright hover:text-ink"
          >
            New scan
          </button>
        </div>

        {result.partial && (
          <p className="mt-4 border border-medium/40 bg-medium/10 px-3 py-2 font-mono text-xs text-medium">
            Partial analysis — the pipeline ran out of time budget before finishing verification on every candidate.
            Some findings below are unverified rather than confirmed absent.
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {SEVERITY_ORDER.filter((s) => counts[s] > 0).map((s) => (
            <span key={s} className="font-mono text-xs text-ink-dim">
              <span className="text-ink">{counts[s]}</span> {s.toLowerCase()}
            </span>
          ))}
          {result.vulnerabilities.length === 0 && (
            <span className="font-mono text-xs text-confirmed">No confirmed vulnerabilities found</span>
          )}
        </div>
      </div>

      <div className="mt-6 flex gap-1 border-b border-line font-mono text-xs">
        <TabButton active={tab === 'confirmed'} onClick={() => setTab('confirmed')}>
          Confirmed ({result.vulnerabilities.length})
        </TabButton>
        <TabButton active={tab === 'uncertain'} onClick={() => setTab('uncertain')}>
          Uncertain ({result.uncertainFindings.length})
        </TabButton>
      </div>

      <div className="mt-4 space-y-2">
        {tab === 'confirmed' &&
          (sortedConfirmed.length > 0 ? (
            sortedConfirmed.map((f, i) => <FindingCard key={f.id} finding={f} index={i} />)
          ) : (
            <EmptyState message="No confirmed vulnerabilities. Verified findings, if any, appear under Uncertain." />
          ))}

        {tab === 'uncertain' &&
          (result.uncertainFindings.length > 0 ? (
            result.uncertainFindings.map((f, i) => <FindingCard key={f.id} finding={f} index={i} />)
          ) : (
            <EmptyState message="Nothing uncertain — every classified finding was either confirmed or rejected." />
          ))}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 transition ${
        active ? 'border-accent text-ink' : 'border-transparent text-ink-faint hover:text-ink-dim'
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({ message }: { message: string }) {
  return <p className="border border-line bg-panel-alt px-4 py-6 text-center text-sm text-ink-faint">{message}</p>;
}
