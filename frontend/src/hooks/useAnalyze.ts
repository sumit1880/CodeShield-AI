import { useCallback, useRef, useState } from 'react';
import { analyzeCode, analyzeUpload } from '../lib/api';
import { AnalysisResult, ApiRequestError } from '../types/api';

const HISTORY_KEY = 'codeshield.history';
const HISTORY_LIMIT = 5;

export interface HistoryEntry {
  analysis: AnalysisResult;
  submittedAt: string;
  sourceLabel: string;
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = sessionStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]) {
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_LIMIT)));
  } catch {
    // Session storage full or unavailable — history just won't persist across reloads this session.
  }
}

export type AnalyzeState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'success'; result: AnalysisResult }
  | { phase: 'error'; error: ApiRequestError | Error };

export function useAnalyze(idToken: string | null) {
  const [state, setState] = useState<AnalyzeState>({ phase: 'idle' });
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const inFlight = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const pushHistory = useCallback((analysis: AnalysisResult, sourceLabel: string) => {
    setHistory((prev) => {
      const next = [{ analysis, submittedAt: new Date().toISOString(), sourceLabel }, ...prev].slice(0, HISTORY_LIMIT);
      saveHistory(next);
      return next;
    });
  }, []);

  const submitPaste = useCallback(
    async (language: string, code: string) => {
      if (inFlight.current || !idToken) return;
      inFlight.current = true;
      setState({ phase: 'running' });
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await analyzeCode(idToken, language, code, controller.signal);
        setState({ phase: 'success', result: res.analysis });
        pushHistory(res.analysis, `Pasted ${language} snippet`);
      } catch (err) {
        setState({ phase: 'error', error: err as Error });
      } finally {
        inFlight.current = false;
      }
    },
    [idToken, pushHistory]
  );

  const submitUpload = useCallback(
    async (file: File, language: string) => {
      if (inFlight.current || !idToken) return;
      inFlight.current = true;
      setState({ phase: 'running' });
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await analyzeUpload(idToken, file, language, controller.signal);
        setState({ phase: 'success', result: res.analysis });
        pushHistory(res.analysis, `Uploaded ${file.name}`);
      } catch (err) {
        setState({ phase: 'error', error: err as Error });
      } finally {
        inFlight.current = false;
      }
    },
    [idToken, pushHistory]
  );

  const reset = useCallback(() => {
    setState({ phase: 'idle' });
  }, []);

  return {
    state,
    isRunning: state.phase === 'running',
    submitPaste,
    submitUpload,
    reset,
    history
  };
}
