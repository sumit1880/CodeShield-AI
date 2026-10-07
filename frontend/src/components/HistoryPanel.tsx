import { useEffect, useState } from 'react';
import { HistoryEntry } from '../hooks/useAnalyze';
import { getAnalyses, getAnalysisById } from '../lib/api';
import { AnalysisResult } from '../types/api';

export function HistoryPanel({
  entries,
  idToken,
  onSelect
}: {
  entries: HistoryEntry[];
  idToken?: string | null;
  onSelect: (entry: HistoryEntry) => void;
}) {
  const [serverAnalyses, setServerAnalyses] = useState<
    Array<{
      id: string;
      language: string;
      sourceType: string;
      status: string;
      createdAt: string;
      findingCount: number;
    }>
  >([]);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  useEffect(() => {
    if (!idToken) return;
    let active = true;
    getAnalyses(idToken, 1, 10)
      .then((res) => {
        if (active && res.success) {
          setServerAnalyses(res.data);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [idToken]);

  const handleSelectServerItem = async (item: (typeof serverAnalyses)[0]) => {
    if (!idToken) return;
    setLoadingId(item.id);
    try {
      const res = await getAnalysisById(idToken, item.id);
      if (res.success && res.data) {
        const full = res.data;
        const entry: HistoryEntry = {
          analysis: {
            id: full.id,
            language: full.language,
            summary: {
              totalIssues: full.findings?.length || 0,
              critical: full.findings?.filter((f: any) => f.severity === 'CRITICAL').length || 0,
              high: full.findings?.filter((f: any) => f.severity === 'HIGH').length || 0,
              medium: full.findings?.filter((f: any) => f.severity === 'MEDIUM').length || 0,
              low: full.findings?.filter((f: any) => f.severity === 'LOW').length || 0,
              info: full.findings?.filter((f: any) => f.severity === 'INFO').length || 0
            },
            vulnerabilities: (full.findings || [])
              .filter((f: any) => f.verificationStatus === 'CONFIRMED')
              .map((f: any) => ({
                id: f.id,
                title: f.title,
                cwe: { id: f.cweId, name: f.cweName },
                severity: f.severity,
                confidence: f.confidence,
                location: {
                  file: f.file,
                  function: f.function ?? null,
                  lineStart: f.lineStart,
                  lineEnd: f.lineEnd
                },
                explanation: f.explanation,
                recommendation: f.recommendation,
                verification: {
                  status: 'CONFIRMED' as const,
                  confidence: f.confidence
                }
              })),
            uncertainFindings: (full.findings || [])
              .filter((f: any) => f.verificationStatus === 'UNCERTAIN')
              .map((f: any) => ({
                id: f.id,
                title: f.title,
                cwe: { id: f.cweId, name: f.cweName },
                severity: f.severity,
                confidence: f.confidence,
                location: {
                  file: f.file,
                  function: f.function ?? null,
                  lineStart: f.lineStart,
                  lineEnd: f.lineEnd
                },
                explanation: f.explanation,
                recommendation: f.recommendation,
                verification: {
                  status: 'UNCERTAIN' as const,
                  confidence: f.confidence,
                  reason: f.verificationReason
                }
              })),
            partial: full.status === 'PARTIAL',
            analysisStatus: full.status
          },
          submittedAt: full.createdAt,
          sourceLabel: `${full.sourceType === 'ZIP' ? 'Project' : 'Snippet'} (${full.language})`
        };
        onSelect(entry);
      }
    } catch {
      // Failed to load analysis details
    } finally {
      setLoadingId(null);
    }
  };

  const hasContent = entries.length > 0 || serverAnalyses.length > 0;
  if (!hasContent) return null;

  return (
    <div className="mt-8 border-t border-line pt-5">
      <div className="flex items-center justify-between">
        <p className="font-mono text-xs text-ink-faint">Scan history</p>
        {serverAnalyses.length > 0 && (
          <span className="font-mono text-[11px] text-ink-faint">Saved in cloud</span>
        )}
      </div>

      {serverAnalyses.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {serverAnalyses.map((item) => (
            <li key={item.id}>
              <button
                onClick={() => handleSelectServerItem(item)}
                disabled={loadingId === item.id}
                className="flex w-full items-center justify-between gap-3 border border-line bg-panel-alt px-3 py-2 text-left transition hover:border-line-bright disabled:opacity-50"
              >
                <span className="min-w-0 truncate font-mono text-xs text-ink-dim">
                  {loadingId === item.id ? 'Loading…' : `${item.sourceType === 'ZIP' ? 'Project' : 'Snippet'} (${item.language})`}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                  {item.findingCount} findings ·{' '}
                  {new Date(item.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
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
      )}
    </div>
  );
}

