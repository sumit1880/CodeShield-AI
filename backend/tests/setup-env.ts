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

// Multi-provider LLM config: default to Gemini-only in tests so
// isProviderConfigured()/buildLlmService() behave predictably; individual
// tests override GROK_*/LLAMA_*/LLM_PROVIDER_ORDER as needed.
process.env.LLM_PROVIDER_ORDER = process.env.LLM_PROVIDER_ORDER || 'gemini';
process.env.GROK_API_KEY = process.env.GROK_API_KEY || '';
process.env.GROK_MODEL = process.env.GROK_MODEL || '';
process.env.LLAMA_API_KEY = process.env.LLAMA_API_KEY || '';
process.env.LLAMA_BASE_URL = process.env.LLAMA_BASE_URL || '';
process.env.LLAMA_MODEL = process.env.LLAMA_MODEL || '';

// Auth / rate limit / concurrency: sensible test defaults (never real secrets).
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id.apps.googleusercontent.com';
process.env.RATE_LIMIT_WINDOW_MS = process.env.RATE_LIMIT_WINDOW_MS || '60000';
process.env.RATE_LIMIT_MAX_REQUESTS = process.env.RATE_LIMIT_MAX_REQUESTS || '30';
process.env.MAX_CONCURRENT_ANALYSES = process.env.MAX_CONCURRENT_ANALYSES || '3';
process.env.AI_REQUEST_TIMEOUT_MS = process.env.AI_REQUEST_TIMEOUT_MS || '20000';
process.env.AI_MAX_RETRIES = process.env.AI_MAX_RETRIES || '1';
