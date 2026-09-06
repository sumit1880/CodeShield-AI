import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { HistoryEntry, useAnalyze } from '../hooks/useAnalyze';
import { SUPPORTED_LANGUAGES, UPLOAD_LANGUAGES } from '../types/api';
import { CodeEditor } from './CodeEditor';
import { ErrorBanner } from './ErrorBanner';
import { FileDropzone } from './FileDropzone';
import { HistoryPanel } from './HistoryPanel';
import { LanguageSelect } from './LanguageSelect';
import { LoadingState } from './LoadingState';
import { ResultsView } from './ResultsView';

const MAX_CODE_CHARACTERS = 500_000;
const MAX_ZIP_SIZE_MB = Number(import.meta.env.VITE_MAX_ZIP_SIZE_MB) || 50;

type Mode = 'paste' | 'upload';

export function Workspace() {
  const { idToken } = useAuth();
  const [mode, setMode] = useState<Mode>('paste');
  const [language, setLanguage] = useState('javascript');
  const [code, setCode] = useState('');
  const [uploadLanguage, setUploadLanguage] = useState('auto');
  const [file, setFile] = useState<File | null>(null);
  const [viewedHistoryResult, setViewedHistoryResult] = useState<HistoryEntry | null>(null);

  const { state, isRunning, submitPaste, submitUpload, reset, history } = useAnalyze(idToken);

  const canSubmitPaste = code.trim().length > 0 && code.length <= MAX_CODE_CHARACTERS && !isRunning;
  const canSubmitUpload = file !== null && !isRunning;

  const handleSubmit = () => {
    setViewedHistoryResult(null);
    if (mode === 'paste') submitPaste(language, code);
    else if (file) submitUpload(file, uploadLanguage);
  };

  const activeResult = viewedHistoryResult?.analysis ?? (state.phase === 'success' ? state.result : null);

  if (activeResult) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10">
        <ResultsView
          result={activeResult}
          onNewScan={() => {
            reset();
            setViewedHistoryResult(null);
          }}
        />
        <HistoryPanel entries={history} onSelect={setViewedHistoryResult} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex gap-1 border-b border-line font-mono text-sm">
        <ModeTab active={mode === 'paste'} onClick={() => setMode('paste')} disabled={isRunning}>
          Paste code
        </ModeTab>
        <ModeTab active={mode === 'upload'} onClick={() => setMode('upload')} disabled={isRunning}>
          Upload .zip
        </ModeTab>
      </div>

      <div className="mt-6">
        {mode === 'paste' ? (
          <div>
            <div className="mb-3 flex justify-end">
              <LanguageSelect
                label="Language"
                value={language}
                onChange={setLanguage}
                options={SUPPORTED_LANGUAGES}
                disabled={isRunning}
              />
            </div>
            <CodeEditor value={code} onChange={setCode} disabled={isRunning} maxCharacters={MAX_CODE_CHARACTERS} />
          </div>
        ) : (
          <div>
            <div className="mb-3 flex justify-end">
              <LanguageSelect
                label="Language"
                value={uploadLanguage}
                onChange={setUploadLanguage}
                options={UPLOAD_LANGUAGES}
                disabled={isRunning}
              />
            </div>
            <FileDropzone file={file} onSelect={setFile} maxSizeMb={MAX_ZIP_SIZE_MB} disabled={isRunning} />
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button
            onClick={handleSubmit}
            disabled={mode === 'paste' ? !canSubmitPaste : !canSubmitUpload}
            className="border border-accent bg-accent px-5 py-2 font-mono text-sm text-accent-ink transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-ink-faint"
          >
            {isRunning ? 'Analyzing…' : 'Run analysis'}
          </button>
        </div>
      </div>

      <div className="mt-8">
        {state.phase === 'running' && <LoadingState />}
        {state.phase === 'error' && <ErrorBanner error={state.error} onRetry={handleSubmit} />}
      </div>

      <HistoryPanel entries={history} onSelect={setViewedHistoryResult} />
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  disabled,
  children
}: {
  active: boolean;
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`-mb-px border-b-2 px-4 py-2.5 transition disabled:cursor-not-allowed disabled:opacity-50 ${
        active ? 'border-accent text-ink' : 'border-transparent text-ink-faint hover:text-ink-dim'
      }`}
    >
      {children}
    </button>
  );
}
