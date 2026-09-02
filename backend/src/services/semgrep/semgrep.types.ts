export interface RawSemgrepResultRange {
  start: { line: number; col?: number };
  end: { line: number; col?: number };
}

export interface RawSemgrepResult {
  check_id: string;
  path: string;
  start: { line: number; col?: number };
  end: { line: number; col?: number };
  extra: {
    message: string;
    severity: string;
    metadata?: Record<string, unknown>;
    lines?: string;
  };
}

export interface RawSemgrepOutput {
  results: RawSemgrepResult[];
  errors?: Array<{ message: string; type?: string }>;
}
