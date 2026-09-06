import { useCallback, useRef, useState } from 'react';

interface FileDropzoneProps {
  file: File | null;
  onSelect: (file: File | null) => void;
  maxSizeMb: number;
  disabled?: boolean;
}

export function FileDropzone({ file, onSelect, maxSizeMb, disabled }: FileDropzoneProps) {
  const [dragging, setDragging] = useState(false);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const validateAndSet = useCallback(
    (candidate: File | null) => {
      if (!candidate) {
        onSelect(null);
        setSizeError(null);
        return;
      }
      if (!candidate.name.toLowerCase().endsWith('.zip')) {
        setSizeError('Only .zip archives are accepted.');
        return;
      }
      const maxBytes = maxSizeMb * 1024 * 1024;
      if (candidate.size > maxBytes) {
        setSizeError(`That archive is ${(candidate.size / 1024 / 1024).toFixed(1)} MB — the limit is ${maxSizeMb} MB.`);
        return;
      }
      setSizeError(null);
      onSelect(candidate);
    },
    [maxSizeMb, onSelect]
  );

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (disabled) return;
          validateAndSet(e.dataTransfer.files[0] ?? null);
        }}
        onClick={() => !disabled && inputRef.current?.click()}
        role="button"
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) inputRef.current?.click();
        }}
        aria-disabled={disabled}
        className={`flex h-80 cursor-pointer flex-col items-center justify-center gap-3 border border-dashed px-6 text-center transition ${
          dragging ? 'border-accent bg-accent/5' : 'border-line bg-panel-alt hover:border-line-bright'
        } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".zip"
          className="hidden"
          disabled={disabled}
          onChange={(e) => validateAndSet(e.target.files?.[0] ?? null)}
        />
        <ArchiveIcon />
        {file ? (
          <div>
            <p className="font-mono text-sm text-ink">{file.name}</p>
            <p className="mt-1 font-mono text-xs text-ink-faint">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                validateAndSet(null);
                if (inputRef.current) inputRef.current.value = '';
              }}
              className="mt-3 border border-line px-2.5 py-1 font-mono text-xs text-ink-dim hover:border-line-bright hover:text-ink"
            >
              Remove
            </button>
          </div>
        ) : (
          <div>
            <p className="font-mono text-sm text-ink">Drop a .zip project here</p>
            <p className="mt-1 font-mono text-xs text-ink-faint">or click to browse · up to {maxSizeMb} MB</p>
          </div>
        )}
      </div>
      {sizeError && <p className="mt-1.5 font-mono text-xs text-critical">{sizeError}</p>}
    </div>
  );
}

function ArchiveIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="0" stroke="#6E6555" strokeWidth="1.3" />
      <path d="M4 9h16" stroke="#6E6555" strokeWidth="1.3" />
      <path d="M10.5 9v2a1.5 1.5 0 003 0V9" stroke="#E8A33D" strokeWidth="1.3" />
    </svg>
  );
}
