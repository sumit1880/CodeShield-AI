/**
 * Centralized language configuration.
 *
 * Adding a new language = add one entry here (plus, optionally, semgrep
 * rules under semgrep-rules/<language>.yml). Nothing else in the codebase
 * hard-codes a language list.
 */

export interface LanguageConfig {
  /** Canonical id used throughout the API and DB (lowercase). */
  id: string;
  /** Human readable label. */
  label: string;
  /** File extensions (including the dot) associated with this language. */
  extensions: string[];
  /** The `--lang` value semgrep expects, if different from `id`. */
  semgrepLang?: string;
}

export const SUPPORTED_LANGUAGES: LanguageConfig[] = [
  { id: 'javascript', label: 'JavaScript', extensions: ['.js', '.jsx', '.mjs', '.cjs'] },
  { id: 'typescript', label: 'TypeScript', extensions: ['.ts', '.tsx'] },
  { id: 'python', label: 'Python', extensions: ['.py'] },
  { id: 'java', label: 'Java', extensions: ['.java'] },
  { id: 'go', label: 'Go', extensions: ['.go'] },
  { id: 'c', label: 'C', extensions: ['.c', '.h'] },
  { id: 'cpp', label: 'C++', extensions: ['.cpp', '.cc', '.cxx', '.hpp'], semgrepLang: 'cpp' },
  { id: 'ruby', label: 'Ruby', extensions: ['.rb'] },
  { id: 'php', label: 'PHP', extensions: ['.php'] },
  { id: 'csharp', label: 'C#', extensions: ['.cs'], semgrepLang: 'csharp' }
];

const byId = new Map(SUPPORTED_LANGUAGES.map((l) => [l.id, l]));

export function isSupportedLanguage(id: string): boolean {
  return byId.has(id.toLowerCase());
}

export function getLanguageConfig(id: string): LanguageConfig | undefined {
  return byId.get(id.toLowerCase());
}

/** Map a file extension (e.g. ".py") to a language id, if known. */
export function languageForExtension(ext: string): string | undefined {
  const lower = ext.toLowerCase();
  for (const lang of SUPPORTED_LANGUAGES) {
    if (lang.extensions.includes(lower)) return lang.id;
  }
  return undefined;
}

export function semgrepLangFor(id: string): string {
  const cfg = getLanguageConfig(id);
  return cfg?.semgrepLang || cfg?.id || id;
}
