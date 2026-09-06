import { HistoryEntry } from '../hooks/useAnalyze';

export function HistoryPanel({ entries, onSelect }: { entries: HistoryEntry[]; onSelect: (entry: HistoryEntry) => void }) {
  if (entries.length === 0) return null;

  return (
    <div className="mt-8 border-t border-line pt-5">
      <p className="font-mono text-xs text-ink-faint">This session</p>
      <ul className="mt-2 space-y-1.5">
        {entries.map((entry, i) => (
          <li key={`${entry.analysis.id}-${i}`}>
            <button
              onClick={() => onSelect(entry)}
              className="flex w-full items-center justify-between gap-3 border border-line bg-panel-alt px-3 py-2 text-left transition hover:border-line-bright"
            >
              <span className="min-w-0 truncate font-mono text-xs text-ink-dim">{entry.sourceLabel}</span>
              <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                {entry.analysis.vulnerabilities.length} findings ·{' '}
                {new Date(entry.submittedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
