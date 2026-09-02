import fs from 'fs/promises';
import path from 'path';
import { languageForExtension } from '../../config/languages';
import { SemgrepFinding } from '../../types/findings';
import { ExtractedFile } from '../zip/zip.service';

const CONTEXT_LINES_BEFORE = 15;
const CONTEXT_LINES_AFTER = 15;
const MAX_FILES_TO_LOAD_FULLY = 3; // for pasted single-file code this is trivially satisfied

export interface FileContext {
  file: string;
  /** The relevant snippet only, not the whole file, to keep prompts small. */
  snippet: string;
  startLine: number;
  endLine: number;
}

export class CodeContextService {
  /** Filters extracted project files down to ones with a known/supported extension. */
  filterRelevantFiles(files: ExtractedFile[]): ExtractedFile[] {
    return files.filter((f) => languageForExtension(path.extname(f.relativePath)) !== undefined);
  }

  /**
   * Given semgrep findings, extracts a bounded snippet of surrounding code
   * per finding location instead of concatenating whole files/projects into
   * the LLM prompt.
   */
  async extractContextForFindings(
    projectRoot: string,
    findings: SemgrepFinding[]
  ): Promise<FileContext[]> {
    const contexts: FileContext[] = [];
    const fileCache = new Map<string, string[]>();

    for (const finding of findings) {
      const absPath = path.isAbsolute(finding.file) ? finding.file : path.join(projectRoot, finding.file);

      let lines = fileCache.get(absPath);
      if (!lines) {
        try {
          const content = await fs.readFile(absPath, 'utf-8');
          lines = content.split('\n');
          fileCache.set(absPath, lines);
        } catch {
          continue; // file no longer accessible; skip context for this finding
        }
      }

      const start = Math.max(1, finding.lineStart - CONTEXT_LINES_BEFORE);
      const end = Math.min(lines.length, finding.lineEnd + CONTEXT_LINES_AFTER);
      const snippet = lines.slice(start - 1, end).join('\n');

      contexts.push({ file: finding.file, snippet, startLine: start, endLine: end });
    }

    return contexts;
  }

  /** For small single-file pasted-code submissions, the whole file *is* the context. */
  wholeFileContext(file: string, sourceCode: string): FileContext {
    const lines = sourceCode.split('\n');
    return { file, snippet: sourceCode, startLine: 1, endLine: lines.length };
  }
}
