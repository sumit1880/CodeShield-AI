import { execFile } from 'child_process';
import path from 'path';
import { env } from '../../config/env';
import { ApiError, ErrorCode } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { SemgrepFinding } from '../../types/findings';
import { RawSemgrepOutput } from './semgrep.types';

const SEMGREP_RULES_DIR = path.join(__dirname, '..', '..', '..', 'semgrep-rules');
const SEMGREP_TIMEOUT_MS = 60_000;

function runSemgrep(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      env.semgrepPath,
      args,
      { cwd, maxBuffer: 1024 * 1024 * 50, timeout: SEMGREP_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          const errno = (error as NodeJS.ErrnoException).code;
          if (errno === 'ENOENT') {
            return reject(
              new ApiError(ErrorCode.SEMGREP_NOT_INSTALLED, 'Semgrep executable was not found on PATH')
            );
          }
          // Semgrep exits non-zero when findings exist in some modes, but with
          // --json it exits 0 for findings and non-zero mainly for real errors.
          // We still attempt to parse stdout since semgrep may emit partial
          // valid JSON with a non-fatal exit code alongside `errors`.
          if (!stdout) {
            return reject(
              new ApiError(ErrorCode.SEMGREP_ERROR, `Semgrep failed: ${stderr || error.message}`)
            );
          }
        }
        resolve(stdout);
      }
    );
  });
}

export interface RunSemgrepOptions {
  /** Directory containing the code to scan (already safely materialized on disk). */
  targetDir: string;
  /** Language id (used to select a rules config when we have language-specific rules). */
  language: string;
}

export class SemgrepService {
  /**
   * Scans a directory with Semgrep and returns normalized findings.
   * Never executes or compiles the scanned code.
   */
  async scan(options: RunSemgrepOptions): Promise<SemgrepFinding[]> {
    const { targetDir, language } = options;

    const languageRuleFile = path.join(SEMGREP_RULES_DIR, `${language}.yml`);
    const configArg = (await this.ruleFileExists(languageRuleFile)) ? languageRuleFile : 'auto';

    const args = ['--json', '--quiet', '--config', configArg, '--timeout', '30', targetDir];

    logger.info({ language, configArg }, 'Running semgrep scan');

    const stdout = await runSemgrep(args, targetDir);

    let parsed: RawSemgrepOutput;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      throw new ApiError(ErrorCode.SEMGREP_ERROR, 'Semgrep produced non-JSON output');
    }

    if (parsed.errors && parsed.errors.length > 0) {
      logger.warn({ errors: parsed.errors }, 'Semgrep reported non-fatal errors during scan');
    }

    return this.normalize(parsed);
  }

  private async ruleFileExists(filePath: string): Promise<boolean> {
    try {
      const fs = await import('fs/promises');
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private normalize(output: RawSemgrepOutput): SemgrepFinding[] {
    return output.results.map((result) => ({
      ruleId: result.check_id,
      message: result.extra.message,
      severity: result.extra.severity,
      file: result.path,
      lineStart: result.start.line,
      lineEnd: result.end.line,
      columnStart: result.start.col,
      columnEnd: result.end.col,
      metadata: result.extra.metadata
    }));
  }
}
