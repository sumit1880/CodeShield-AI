import { useEffect, useState } from 'react';

// Purely cosmetic staging — the backend doesn't stream real progress, so this
// never claims a percentage or a step count. It just proves the pipeline is
// still alive during a run that can take up to ~4 minutes.
const STAGES = [
  'Uploading to analyzer…',
  'Running static analysis (Semgrep)…',
  'Detection agent scanning for candidates…',
  'Classification agent assigning CWE + severity…',
  'Verification agent double-checking findings…',
  'Still working — LLM fallback chain may be in use…'
];

export function LoadingState() {
  const [stageIndex, setStageIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const stageTimer = window.setInterval(() => {
      setStageIndex((i) => Math.min(i + 1, STAGES.length - 1));
    }, 14000);
    const clock = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => {
      window.clearInterval(stageTimer);
      window.clearInterval(clock);
    };
  }, []);

  const minutes = Math.floor(elapsed / 60);
  const seconds = String(elapsed % 60).padStart(2, '0');

  return (
    <div className="border border-line bg-panel p-8">
      <div className="relative h-1 w-full overflow-hidden bg-panel-alt">
        <div className="absolute inset-y-0 w-1/3 animate-scan bg-accent" style={{ animationDuration: '1.6s' }} />
      </div>

      <div className="mt-6 flex items-start justify-between">
        <div>
          <p className="font-mono text-sm text-ink">
            {STAGES[stageIndex]}
            <span className="cursor-caret" />
          </p>
          <p className="mt-2 text-sm text-ink-dim">
            Multi-agent analysis can take up to ~4 minutes, especially if a provider fallback is needed. This screen
            will update automatically — no need to resubmit.
          </p>
        </div>
        <span className="shrink-0 font-mono text-xs text-ink-faint">
          {minutes}:{seconds}
        </span>
      </div>

      <ul className="mt-6 space-y-1.5">
        {STAGES.map((stage, i) => (
          <li
            key={stage}
            className={`flex items-center gap-2 font-mono text-xs ${
              i < stageIndex ? 'text-ink-faint line-through' : i === stageIndex ? 'text-accent' : 'text-ink-faint'
            }`}
          >
            <span className={`h-1 w-1 shrink-0 rounded-full ${i <= stageIndex ? 'bg-accent' : 'bg-line-bright'}`} />
            {stage}
          </li>
        ))}
      </ul>
    </div>
  );
}
