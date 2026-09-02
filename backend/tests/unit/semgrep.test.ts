import fs from 'fs/promises';
import path from 'path';
import { SemgrepService } from '../../src/services/semgrep/semgrep.service';
import { withTempDir } from '../../src/utils/temp-workspace';
import { VULNERABLE_SNIPPETS, CLEAN_SNIPPET } from '../fixtures/vulnerable-code';
import { ErrorCode } from '../../src/utils/errors';

const semgrepService = new SemgrepService();

describe('SemgrepService', () => {
  it('flags a SQL injection pattern in vulnerable code', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'server.js');
      await fs.writeFile(file, VULNERABLE_SNIPPETS.sqlInjection.code, 'utf-8');

      const findings = await semgrepService.scan({ targetDir: dir, language: 'javascript' });

      expect(findings.some((f) => /sql/i.test(f.ruleId) || /sql/i.test(f.message))).toBe(true);
    });
  }, 30000);

  it('flags a command injection pattern', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'server.js');
      await fs.writeFile(file, VULNERABLE_SNIPPETS.commandInjection.code, 'utf-8');

      const findings = await semgrepService.scan({ targetDir: dir, language: 'javascript' });

      expect(findings.length).toBeGreaterThan(0);
    });
  }, 30000);

  it('returns no findings for clean code (using our curated rule set)', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'server.js');
      await fs.writeFile(file, CLEAN_SNIPPET.code, 'utf-8');

      const findings = await semgrepService.scan({ targetDir: dir, language: 'javascript' });

      expect(findings.length).toBe(0);
    });
  }, 30000);

  it('throws SEMGREP_NOT_INSTALLED when the binary is missing', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'server.js'), CLEAN_SNIPPET.code, 'utf-8');

      const originalPath = process.env.SEMGREP_PATH;
      process.env.SEMGREP_PATH = '/nonexistent/semgrep-binary';
      // env module reads process.env at import time, so re-require config for this test
      jest.resetModules();
      const { SemgrepService: FreshSemgrepService } = await import('../../src/services/semgrep/semgrep.service');
      const fresh = new FreshSemgrepService();

      await expect(fresh.scan({ targetDir: dir, language: 'javascript' })).rejects.toMatchObject({
        code: ErrorCode.SEMGREP_NOT_INSTALLED
      });

      process.env.SEMGREP_PATH = originalPath;
    });
  }, 30000);
});
