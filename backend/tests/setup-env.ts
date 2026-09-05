// Ensures tests never require real external services / secrets.
process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-real';
process.env.GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
process.env.EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-004';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb';
process.env.MAX_CODE_LINES = process.env.MAX_CODE_LINES || '10000';
process.env.MAX_CODE_CHARACTERS = process.env.MAX_CODE_CHARACTERS || '500000';
process.env.MAX_ZIP_SIZE_MB = process.env.MAX_ZIP_SIZE_MB || '50';
process.env.MAX_EXTRACTED_SIZE_MB = process.env.MAX_EXTRACTED_SIZE_MB || '500';
process.env.MAX_FILES_PER_PROJECT = process.env.MAX_FILES_PER_PROJECT || '5000';
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
process.env.SEMGREP_PATH = process.env.SEMGREP_PATH || 'semgrep';
