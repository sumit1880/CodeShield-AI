import multer from 'multer';
import { env } from '../config/env';

// Buffer in memory (not written to disk until safe-extraction runs its own
// checks); size limit gives an early, cheap rejection before we even look
// at ZIP internals.
export const zipUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.limits.maxZipSizeMb * 1024 * 1024
  }
}).single('file');
