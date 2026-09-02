import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

/**
 * Creates a fresh temporary directory, hands it to `fn`, and guarantees
 * cleanup afterwards (success or failure). Used for both pasted-code
 * scanning and ZIP extraction so we never leave submitted source on disk.
 */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = path.join(os.tmpdir(), `vuln-scan-${crypto.randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
