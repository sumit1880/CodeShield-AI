import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CodeSearchService } from '../../src/services/code-context/code-search.service';

describe('CodeSearchService', () => {
  let projectRoot: string;
  let service: CodeSearchService;

  beforeEach(async () => {
    service = new CodeSearchService();
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-search-test-'));
    await fs.writeFile(
      path.join(projectRoot, 'app.js'),
      Array.from({ length: 30 }, (_, i) => `line ${i + 1}: db.query(userInput)`).join('\n'),
      'utf-8'
    );
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('finds matching lines within an allowed file', async () => {
    const matches = await service.searchCode(projectRoot, ['app.js'], 'db.query');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]).toContain('app.js:');
  });

  it('never reads files outside the allowed file list, even if requested by name', async () => {
    // A file that exists on disk but was never part of the analyzed project.
    await fs.writeFile(path.join(projectRoot, 'secret.js'), 'const apiKey = "top-secret";', 'utf-8');
    const matches = await service.searchCode(projectRoot, ['app.js'], 'apiKey');
    expect(matches).toHaveLength(0);
  });

  it('rejects path traversal attempts in analyzeCode', async () => {
    await expect(
      service.analyzeCode(projectRoot, ['../../etc/passwd'], '../../etc/passwd', 1, 10)
    ).rejects.toThrow();
  });

  it('rejects analyzeCode for a file not in the allowed list', async () => {
    await expect(service.analyzeCode(projectRoot, ['app.js'], 'other.js', 1, 5)).rejects.toThrow();
  });

  it('clamps the requested line range to the file bounds and a max window', async () => {
    const snippet = await service.analyzeCode(projectRoot, ['app.js'], 'app.js', -5, 10000);
    const lines = snippet.split('\n');
    expect(lines[0].startsWith('1:')).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(30);
  });
});
