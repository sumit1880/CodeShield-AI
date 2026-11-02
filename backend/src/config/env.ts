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

/**
 * Validates and sanitizes Gemini model names.
 * Maps legacy/deprecated/retired model names to currently supported models.
 */
export function sanitizeGeminiModel(raw?: string): string {
  if (!raw || !raw.trim()) return 'gemini-3.8-flash';
  const trimmed = raw.trim();
  // Legacy / retired Gemini 1.5, 2.0, 2.5 flash -> upgrade to currently supported gemini-3.8-flash
  if (
    trimmed === 'gemini-1.5-flash' ||
    trimmed === 'gemini-1.5-flash-latest' ||
    trimmed === 'gemini-1.5-pro' ||
    trimmed === 'gemini-2.0-flash' ||
    trimmed === 'gemini-2.0-flash-exp' ||
    trimmed === 'gemini-2.5-flash'
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      `[Config] Gemini model "${trimmed}" is mapped to "gemini-3.8-flash" by sanitizeGeminiModel(). ` +
        'Set GEMINI_MODEL / GEMINI_MODEL_2 / GEMINI_MODEL_3 to an explicit, currently supported model ID to avoid this remap.'
    );
    return 'gemini-3.8-flash';
  }
  return trimmed;
}

export const GEMINI_PROVIDER_NAMES = ['gemini', 'gemini2', 'gemini3'] as const;

function filterGeminiProviders(names: string[]): string[] {
  const allowed = new Set<string>(GEMINI_PROVIDER_NAMES);
  const kept = names.filter((n, i) => allowed.has(n) && names.indexOf(n) === i);
  const dropped = names.filter((n) => !allowed.has(n));
  if (dropped.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[Config] Ignoring non-Gemini entries in LLM_PROVIDER_ORDER: ${dropped.join(', ')}`);
  }
  return kept.length > 0 ? kept : [...GEMINI_PROVIDER_NAMES];
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: intEnv('PORT', 3000),

  databaseUrl: requireEnv('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/vuln_detection'),

  // Kept as its own namespace (unchanged shape) since gemini.service.ts and
  // existing tests/config already depend on env.gemini.{apiKey,model}.
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: sanitizeGeminiModel(process.env.GEMINI_MODEL)
  },

  // Second Gemini account, used as a fallback when the primary key hits a
  // free-tier rate limit/outage.
  gemini2: {
    apiKey: process.env.GEMINI_API_KEY_2 || '',
    model: sanitizeGeminiModel(process.env.GEMINI_MODEL_2 || process.env.GEMINI_MODEL)
  },

  // Third Gemini account, used as a fallback when primary and secondary keys hit rate limits/outages.
  gemini3: {
    apiKey: process.env.GEMINI_API_KEY_3 || '',
    model: sanitizeGeminiModel(process.env.GEMINI_MODEL_3 || process.env.GEMINI_MODEL)
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
    // Hard wall-clock limit for ONE provider attempt. On expiry the underlying
    // HTTP request is aborted (see AbortableChatGoogleGenerativeAI) and the
    // router moves to the next provider.
    requestTimeoutMs: intEnv('AI_REQUEST_TIMEOUT_MS', 90000),
    // Legacy variable (only used by the legacy src/services/llm stack).
    maxRetries: intEnv('AI_MAX_RETRIES', 1),
    // SDK-internal retries per provider attempt. 0 = the router's provider
    // fallback is the only retry mechanism, so one attempt cannot silently
    // take (1 + retries) x timeout.
    sdkMaxRetries: intEnv('AI_SDK_MAX_RETRIES', 0),
    // Pause before trying the next provider after a 429/5xx (not after a timeout).
    fallbackDelayMs: intEnv('LLM_FALLBACK_DELAY_MS', 1000),
    // How long a provider is skipped after a timeout / 429 / 503 / 5xx.
    providerCooldownMs: intEnv('LLM_PROVIDER_COOLDOWN_MS', 60000),
    // How long a provider is skipped after an auth / model-not-found error.
    permanentCooldownMs: intEnv('LLM_PERMANENT_COOLDOWN_MS', 600000)
  },

  agent: {
    maxIterations: intEnv('AGENT_MAX_ITERATIONS', 10),
    maxToolCalls: intEnv('AGENT_MAX_TOOL_CALLS', 20),
    maxAnalysisTimeMs: intEnv('AGENT_MAX_ANALYSIS_TIME_MS', 240000)
  },

  // LLM provider chain. Gemini-only: 'gemini' -> 'gemini2' -> 'gemini3'.
  // Any other name in LLM_PROVIDER_ORDER is ignored (see filterGeminiProviders).
  llm: {
    providerOrder: filterGeminiProviders(listEnv('LLM_PROVIDER_ORDER', [...GEMINI_PROVIDER_NAMES]))
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

function isGemini3Configured(): boolean {
  return Boolean(env.gemini3.apiKey);
}

export function isProviderConfigured(name: string): boolean {
  switch (name) {
    case 'gemini':
      return isGeminiConfigured();
    case 'gemini2':
      return isGemini2Configured();
    case 'gemini3':
      return isGemini3Configured();
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
      'No LLM provider is configured. Set at least one of: GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3.'
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
