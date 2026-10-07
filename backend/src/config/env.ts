import dotenv from 'dotenv';

dotenv.config();

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function listEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: intEnv('PORT', 3000),

  databaseUrl: requireEnv('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/vuln_detection'),

  // Kept as its own namespace (unchanged shape) since gemini.service.ts and
  // existing tests/config already depend on env.gemini.{apiKey,model}.
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-3.6-flash'
  },

  // Second Gemini account, used as a fallback when the primary key hits a
  // free-tier rate limit/outage. Falls back to GEMINI_MODEL if
  // GEMINI_MODEL_2 isn't set, since it's usually the same model on a
  // different account.
  gemini2: {
    apiKey: process.env.GEMINI_API_KEY_2 || '',
    model: process.env.GEMINI_MODEL_2 || process.env.GEMINI_MODEL || 'gemini-3.6-flash'
  },

  embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-004',

  limits: {
    maxCodeLines: intEnv('MAX_CODE_LINES', 10000),
    maxCodeCharacters: intEnv('MAX_CODE_CHARACTERS', 500000),
    maxZipSizeMb: intEnv('MAX_ZIP_SIZE_MB', 50),
    maxExtractedSizeMb: intEnv('MAX_EXTRACTED_SIZE_MB', 500),
    maxFilesPerProject: intEnv('MAX_FILES_PER_PROJECT', 5000)
  },

  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',

  semgrepPath: process.env.SEMGREP_PATH || 'semgrep',

  // Per-provider-attempt timeout/retry budget. Kept intentionally small
  // (relative to AGENT_MAX_ANALYSIS_TIME_MS) because a single logical LLM
  // call may try multiple providers in sequence, and free-tier provider
  // quotas mean retries are not free.
  ai: {
    requestTimeoutMs: intEnv('AI_REQUEST_TIMEOUT_MS', 20000),
    maxRetries: intEnv('AI_MAX_RETRIES', 1)
  },

  agent: {
    maxIterations: intEnv('AGENT_MAX_ITERATIONS', 10),
    maxToolCalls: intEnv('AGENT_MAX_TOOL_CALLS', 20),
    maxAnalysisTimeMs: intEnv('AGENT_MAX_ANALYSIS_TIME_MS', 120000)
  },

  // Multi-provider LLM configuration. Gemini is always attempted first
  // unless LLM_PROVIDER_ORDER says otherwise; providers with missing
  // required config are simply skipped (not treated as a failure).
  llm: {
    providerOrder: listEnv('LLM_PROVIDER_ORDER', ['gemini', 'gemini2']),
    grok: {
      apiKey: process.env.GROK_API_KEY || '',
      model: process.env.GROK_MODEL || ''
    },
    llama: {
      apiKey: process.env.LLAMA_API_KEY || '',
      baseUrl: process.env.LLAMA_BASE_URL || '',
      model: process.env.LLAMA_MODEL || ''
    }
  },

  google: {
    // OAuth 2.0 client ID(s) allowed as the `aud` claim on incoming Google
    // ID tokens. Comma-separated so a web client and a mobile client (which
    // Google issues distinct client IDs for) can both be accepted.
    clientIds: listEnv('GOOGLE_CLIENT_ID', [])
  },

  rateLimit: {
    windowMs: intEnv('RATE_LIMIT_WINDOW_MS', 60_000),
    maxRequests: intEnv('RATE_LIMIT_MAX_REQUESTS', 30)
  },

  dailyAnalysisLimit: intEnv('DAILY_ANALYSIS_LIMIT', 30),

  concurrency: {
    maxConcurrentAnalyses: intEnv('MAX_CONCURRENT_ANALYSES', 3)
  }
};

export type Env = typeof env;

function isGeminiConfigured(): boolean {
  return Boolean(env.gemini.apiKey);
}

function isGemini2Configured(): boolean {
  return Boolean(env.gemini2.apiKey);
}

function isGrokConfigured(): boolean {
  return Boolean(env.llm.grok.apiKey && env.llm.grok.model);
}

function isLlamaConfigured(): boolean {
  // Local/self-hosted OpenAI-compatible inference servers often don't
  // require an API key, so only base URL + model are mandatory.
  return Boolean(env.llm.llama.baseUrl && env.llm.llama.model);
}

export function isProviderConfigured(name: string): boolean {
  switch (name) {
    case 'gemini':
      return isGeminiConfigured();
    case 'gemini2':
      return isGemini2Configured();
    case 'grok':
      return isGrokConfigured();
    case 'llama':
      return isLlamaConfigured();
    default:
      return false;
  }
}

/**
 * Fails fast and loudly at process startup if the deployed configuration
 * could never serve a request correctly. Intentionally NOT run at module
 * import time (so importing `env` in tests never throws) — call this
 * explicitly from the process entry point (server.ts) only.
 */
export function validateStartupConfig(): void {
  const problems: string[] = [];

  const configuredProviders = env.llm.providerOrder.filter(isProviderConfigured);
  if (configuredProviders.length === 0) {
    problems.push(
      'No LLM provider is configured. Set at least one of: GEMINI_API_KEY, GEMINI_API_KEY_2, ' +
        '(GROK_API_KEY + GROK_MODEL), or (LLAMA_BASE_URL + LLAMA_MODEL).'
    );
  }

  if (env.google.clientIds.length === 0) {
    problems.push(
      'GOOGLE_CLIENT_ID is required to verify Google Sign-In tokens on the analysis endpoints.'
    );
  }

  if (problems.length > 0) {
    // Never log secrets here — only which variables are missing, not values.
    // eslint-disable-next-line no-console
    console.error(
      '[Startup] Invalid configuration, refusing to start:\n' + problems.map((p) => ` - ${p}`).join('\n')
    );
    process.exit(1);
  }
}