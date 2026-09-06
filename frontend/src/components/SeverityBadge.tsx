import { Severity } from '../types/api';

const STYLES: Record<Severity, string> = {
  CRITICAL: 'text-critical border-critical/50 bg-critical/10',
  HIGH: 'text-high border-high/50 bg-high/10',
  MEDIUM: 'text-medium border-medium/50 bg-medium/10',
  LOW: 'text-low border-low/50 bg-low/10',
  INFO: 'text-info border-info/50 bg-info/10'
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`inline-flex items-center border px-2 py-0.5 font-mono text-[11px] ${STYLES[severity]}`}>
      {severity.toLowerCase()}
    </span>
  );
}
