import AdmZip from 'adm-zip';
import path from 'path';
import { ZipService, resolveSafeEntryPath } from '../../src/services/zip/zip.service';
import { withTempDir } from '../../src/utils/temp-workspace';
import { ApiError, ErrorCode } from '../../src/utils/errors';

describe('resolveSafeEntryPath (pure path-traversal defense)', () => {
  const root = '/tmp/some-extraction-root';

  it('resolves a normal relative path inside the root', () => {
    const result = resolveSafeEntryPath(root, 'src/index.js');
    expect(result).toBe(path.resolve(root, 'src/index.js'));
  });

  it('rejects a traversal sequence that escapes the root', () => {
    expect(() => resolveSafeEntryPath(root, '../../etc/passwd')).toThrow(ApiError);
    try {
      resolveSafeEntryPath(root, '../../etc/passwd');
    } catch (err) {
      expect((err as ApiError).code).toBe(ErrorCode.UNSAFE_ARCHIVE);
    }
  });

  it('rejects a traversal sequence embedded mid-path', () => {
    expect(() => resolveSafeEntryPath(root, 'foo/../../bar.txt')).toThrow(ApiError);
  });

  it('rejects an absolute path', () => {
    expect(() => resolveSafeEntryPath(root, '/etc/passwd')).toThrow(ApiError);
  });

  it('allows a path that merely contains ".." as part of a legitimate nested-but-contained traversal', () => {
    // "a/b/../c" resolves to "a/c", which is still inside root — this must be allowed.
    const result = resolveSafeEntryPath(root, 'a/b/../c.js');
    expect(result).toBe(path.resolve(root, 'a/c.js'));
  });
});

describe('ZipService.safeExtract', () => {
  it('extracts a normal small archive successfully', async () => {
    const zip = new AdmZip();
    zip.addFile('index.js', Buffer.from('console.log("hi");'));
    zip.addFile('lib/util.js', Buffer.from('module.exports = {};'));

    await withTempDir(async (dir) => {
      const service = new ZipService();
      const extracted = await service.safeExtract(zip.toBuffer(), dir);
      expect(extracted).toHaveLength(2);
      expect(extracted.map((f) => f.relativePath).sort()).toEqual(['index.js', 'lib/util.js']);
    });
  });

  it('skips dangerous executable file types instead of writing them', async () => {
    const zip = new AdmZip();
    zip.addFile('malware.exe', Buffer.from('MZ...'));
    zip.addFile('readme.txt', Buffer.from('hello'));

    await withTempDir(async (dir) => {
      const service = new ZipService();
      const extracted = await service.safeExtract(zip.toBuffer(), dir);
      expect(extracted.map((f) => f.relativePath)).toEqual(['readme.txt']);
    });
  });

  it('drops .semgrepignore and .gitignore so uploads cannot hide files from the scan', async () => {
    const zip = new AdmZip();
    zip.addFile('.semgrepignore', Buffer.from('*'));
    zip.addFile('sub/.gitignore', Buffer.from('*'));
    zip.addFile('app.js', Buffer.from('x = 1;'));

    await withTempDir(async (dir) => {
      const extracted = await new ZipService().safeExtract(zip.toBuffer(), dir);
      expect(extracted.map((f) => f.relativePath)).toEqual(['app.js']);
    });
  });

  it('rejects archives exceeding the configured ZIP size limit', async () => {
    const zip = new AdmZip();
    zip.addFile('big.txt', Buffer.alloc(1024, 'a'));
    const buf = zip.toBuffer();

    await withTempDir(async (dir) => {
      const service = new ZipService();
      const originalEnv = process.env.MAX_ZIP_SIZE_MB;
      // Force an artificially tiny limit for this test via a fresh env import.
      process.env.MAX_ZIP_SIZE_MB = '0';
      jest.resetModules();
      const { ZipService: FreshZipService } = await import('../../src/services/zip/zip.service');
      const fresh = new FreshZipService();

      await expect(fresh.safeExtract(buf, dir)).rejects.toMatchObject({ code: ErrorCode.ZIP_TOO_LARGE });

      process.env.MAX_ZIP_SIZE_MB = originalEnv;
    });
  });
});
