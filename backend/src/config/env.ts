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

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: intEnv('PORT', 3000),

  databaseUrl: requireEnv('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/vuln_detection'),

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-3.6-flash'
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

  ai: {
    requestTimeoutMs: intEnv('AI_REQUEST_TIMEOUT_MS', 60000),
    maxRetries: intEnv('AI_MAX_RETRIES', 2)
  },

  agent: {
    maxIterations: intEnv('AGENT_MAX_ITERATIONS', 10),
    maxToolCalls: intEnv('AGENT_MAX_TOOL_CALLS', 20),
    maxAnalysisTimeMs: intEnv('AGENT_MAX_ANALYSIS_TIME_MS', 120000)
  }
};

export type Env = typeof env;
