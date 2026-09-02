import AdmZip from 'adm-zip';
import fs from 'fs/promises';
import path from 'path';
import { env } from '../../config/env';
import { ApiError, ErrorCode } from '../../utils/errors';
import { logger } from '../../utils/logger';

/** Extensions that are never written to disk during extraction. */
const DANGEROUS_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.sh', '.ps1', '.msi', '.app', '.bin'
]);

export interface ExtractedFile {
  /** Path relative to the extraction root. */
  relativePath: string;
  /** Absolute path on disk. */
  absolutePath: string;
  size: number;
}

/**
 * Resolves an archive entry name against an extraction root and verifies
 * the result stays inside that root. This is the actual traversal defense
 * and is exported standalone so it can be unit tested directly with
 * hand-crafted entry names, independent of any sanitization a ZIP library
 * may or may not perform when reading/writing archives.
 */
export function resolveSafeEntryPath(root: string, entryName: string): string {
  const resolvedRoot = path.resolve(root);

  if (path.isAbsolute(entryName)) {
    throw new ApiError(ErrorCode.UNSAFE_ARCHIVE, `Unsafe absolute path in archive: ${entryName}`);
  }

  const destPath = path.resolve(resolvedRoot, entryName);

  if (destPath !== resolvedRoot && !destPath.startsWith(resolvedRoot + path.sep)) {
    throw new ApiError(ErrorCode.UNSAFE_ARCHIVE, `Path traversal detected in archive entry: ${entryName}`);
  }

  return destPath;
}

export class ZipService {
  /**
   * Safely extracts a ZIP buffer into `targetDir`, enforcing:
   * - path traversal protection (every entry must resolve inside targetDir)
   * - a cap on total uncompressed size (zip-bomb protection)
   * - a cap on file count
   * - skipping dangerous binary/executable file types
   */
  async safeExtract(zipBuffer: Buffer, targetDir: string): Promise<ExtractedFile[]> {
    const maxZipBytes = env.limits.maxZipSizeMb * 1024 * 1024;
    if (zipBuffer.length > maxZipBytes) {
      throw new ApiError(ErrorCode.ZIP_TOO_LARGE, `ZIP exceeds ${env.limits.maxZipSizeMb}MB limit`);
    }

    let zip: AdmZip;
    try {
      zip = new AdmZip(zipBuffer);
    } catch (err) {
      throw new ApiError(ErrorCode.UNSAFE_ARCHIVE, 'Could not read ZIP archive');
    }

    const entries = zip.getEntries();

    if (entries.length > env.limits.maxFilesPerProject) {
      throw new ApiError(
        ErrorCode.TOO_MANY_FILES,
        `Archive contains ${entries.length} files, exceeding the limit of ${env.limits.maxFilesPerProject}`
      );
    }

    const maxExtractedBytes = env.limits.maxExtractedSizeMb * 1024 * 1024;
    let totalUncompressed = 0;
    for (const entry of entries) {
      totalUncompressed += entry.header.size;
      if (totalUncompressed > maxExtractedBytes) {
        throw new ApiError(
          ErrorCode.ARCHIVE_TOO_LARGE,
          `Extracted content exceeds ${env.limits.maxExtractedSizeMb}MB limit`
        );
      }
    }

    const resolvedRoot = path.resolve(targetDir);
    const extracted: ExtractedFile[] = [];

    for (const entry of entries) {
      if (entry.isDirectory) continue;

      const entryName = entry.entryName;
      const destPath = resolveSafeEntryPath(resolvedRoot, entryName);

      const ext = path.extname(entryName).toLowerCase();
      if (DANGEROUS_EXTENSIONS.has(ext)) {
        logger.warn({ entryName }, 'Skipping dangerous file type during extraction');
        continue;
      }

      await fs.mkdir(path.dirname(destPath), { recursive: true });
      const data = entry.getData();
      await fs.writeFile(destPath, data);

      extracted.push({ relativePath: entryName, absolutePath: destPath, size: data.length });
    }

    return extracted;
  }
}
