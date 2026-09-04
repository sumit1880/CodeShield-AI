import fs from 'fs/promises';
import { resolveSafeEntryPath } from '../zip/zip.service';
import { ApiError, ErrorCode } from '../../utils/errors';

const MAX_MATCHES = 20;
const MAX_MATCH_LINE_CHARS = 200;
const MAX_ANALYZE_LINES = 200;

/**
 * Read-only investigation tools exposed to the Manager Agent. Every access
 * is restricted to the already-analyzed project (via resolveSafeEntryPath,
 * the same path-traversal guard used for ZIP extraction) and to the file
 * list produced for this analysis — never arbitrary filesystem access.
 */
export class CodeSearchService {
  /** Finds lines containing `query` across the analyzed files (optionally one file). */
  async searchCode(
    projectRoot: string,
    allowedFiles: string[],
    query: string,
    file?: string
  ): Promise<string[]> {
    const needle = query.toLowerCase().trim();
    if (!needle) return [];

    const targets = file ? allowedFiles.filter((f) => f === file) : allowedFiles;
    const matches: string[] = [];

    for (const relativePath of targets) {
      if (matches.length >= MAX_MATCHES) break;

      let absolutePath: string;
      try {
        absolutePath = resolveSafeEntryPath(projectRoot, relativePath);
      } catch {
        continue; // never surface unsafe paths, just skip
      }

      let content: string;
      try {
        content = await fs.readFile(absolutePath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          const snippet = lines[i].trim().slice(0, MAX_MATCH_LINE_CHARS);
          matches.push(`${relativePath}:${i + 1}: ${snippet}`);
        }
      }
    }

    return matches;
  }

  /** Returns a bounded, line-numbered window of one already-analyzed file. */
  async analyzeCode(
    projectRoot: string,
    allowedFiles: string[],
    file: string,
    startLine: number,
    endLine: number
  ): Promise<string> {
    if (!allowedFiles.includes(file)) {
      throw new ApiError(ErrorCode.INVALID_REQUEST, `File is not part of this analysis: ${file}`);
    }

    const absolutePath = resolveSafeEntryPath(projectRoot, file);
    const content = await fs.readFile(absolutePath, 'utf-8');
    const lines = content.split('\n');

    const clampedStart = Math.max(1, Math.min(startLine || 1, lines.length));
    const requestedEnd = Math.max(clampedStart, endLine || clampedStart);
    const clampedEnd = Math.min(lines.length, requestedEnd, clampedStart + MAX_ANALYZE_LINES - 1);

    return lines
      .slice(clampedStart - 1, clampedEnd)
      .map((line, idx) => `${clampedStart + idx}: ${line}`)
      .join('\n');
  }
}
