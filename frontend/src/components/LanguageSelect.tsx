interface Option {
  id: string;
  label: string;
}

interface LanguageSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly Option[];
  disabled?: boolean;
  label: string;
}

export function LanguageSelect({ value, onChange, options, disabled, label }: LanguageSelectProps) {
  return (
    <label className="flex items-center gap-2 font-mono text-xs text-ink-dim">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="border border-line bg-panel-alt px-2 py-1.5 font-mono text-xs text-ink outline-none disabled:opacity-50"
      >
        {options.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
