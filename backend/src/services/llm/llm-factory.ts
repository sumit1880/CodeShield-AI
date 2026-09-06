import { env, isProviderConfigured } from '../../config/env';
import { logger } from '../../utils/logger';
import { GeminiService } from './gemini.service';
import { GenericOpenAiProvider } from './providers/generic-openai.provider';
import { LlmProvider, LlmService } from './llm.service';
import { LlmRouter } from './llm-router';

// xAI's Grok API is OpenAI-compatible at this base URL (see
// https://docs.x.ai/docs/api-reference). Not user-configurable since it's
// part of what makes a provider "Grok" rather than a generic endpoint —
// GROK_API_KEY/GROK_MODEL are the only env vars needed.
const XAI_BASE_URL = 'https://api.x.ai/v1';

function buildProvider(name: string): LlmProvider | null {
  switch (name) {
    case 'gemini':
      return isProviderConfigured('gemini') ? new GeminiService() : null;
    case 'grok':
      return isProviderConfigured('grok')
        ? new GenericOpenAiProvider({
            name: 'grok',
            baseUrl: XAI_BASE_URL,
            apiKey: env.llm.grok.apiKey,
            model: env.llm.grok.model
          })
        : null;
    case 'llama':
      return isProviderConfigured('llama')
        ? new GenericOpenAiProvider({
            name: 'llama',
            baseUrl: env.llm.llama.baseUrl,
            apiKey: env.llm.llama.apiKey || undefined,
            model: env.llm.llama.model
          })
        : null;
    default:
      logger.warn({ provider: name }, '[LLM] Unknown provider name in LLM_PROVIDER_ORDER, skipping');
      return null;
  }
}

/**
 * Builds the LLM service used by all agents, honoring LLM_PROVIDER_ORDER
 * (Gemini first by default). Providers missing required config are skipped
 * silently — only providers that are actually configured take part in the
 * fallback chain. Throws if none are configured (callers should validate
 * this at startup instead of at first request — see env.validateStartupConfig).
 */
export function buildLlmService(): LlmService {
  const providers = env.llm.providerOrder.map(buildProvider).filter((p): p is LlmProvider => p !== null);

  if (providers.length === 0) {
    throw new Error(
      'No LLM provider configured. Set GEMINI_API_KEY, or GROK_API_KEY+GROK_MODEL, or LLAMA_BASE_URL+LLAMA_MODEL.'
    );
  }

  logger.info({ providers: providers.map((p) => p.name) }, '[LLM] Configured provider chain');

  return providers.length === 1 ? providers[0] : new LlmRouter(providers);
}
