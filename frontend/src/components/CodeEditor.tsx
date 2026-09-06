import { useRef } from 'react';

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  maxCharacters: number;
}

export function CodeEditor({ value, onChange, disabled, maxCharacters }: CodeEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const lineCount = value.length === 0 ? 1 : value.split('\n').length;
  const overLimit = value.length > maxCharacters;

  const syncScroll = () => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  return (
    <div>
      <div className="flex border border-line bg-panel-alt">
        <div
          ref={gutterRef}
          aria-hidden="true"
          className="select-none overflow-hidden border-r border-line px-3 py-3 text-right font-mono text-xs leading-5 text-ink-faint"
          style={{ minWidth: '3.25rem' }}
        >
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          disabled={disabled}
          spellCheck={false}
          placeholder="Paste the code you want scanned…"
          className="h-80 w-full resize-y bg-transparent px-3 py-3 font-mono text-xs leading-5 text-ink outline-none placeholder:text-ink-faint disabled:opacity-50"
        />
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[11px] text-ink-faint">
        <span>{lineCount} lines</span>
        <span className={overLimit ? 'text-critical' : ''}>
          {value.length.toLocaleString()} / {maxCharacters.toLocaleString()} chars
        </span>
      </div>
    </div>
  );
}
