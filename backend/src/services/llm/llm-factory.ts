import { env, isProviderConfigured } from '../../config/env';
import { logger } from '../../utils/logger';
import { GeminiService } from './gemini.service';
import { LlmProvider, LlmService } from './llm.service';
import { LlmRouter } from './llm-router';

function buildProvider(name: string): LlmProvider | null {
  switch (name) {
    case 'gemini':
      return isProviderConfigured('gemini') ? new GeminiService(env.gemini.apiKey, env.gemini.model, 'gemini') : null;
    case 'gemini2':
      return isProviderConfigured('gemini2')
        ? new GeminiService(env.gemini2.apiKey, env.gemini2.model, 'gemini2')
        : null;
    case 'gemini3':
      return isProviderConfigured('gemini3')
        ? new GeminiService(env.gemini3.apiKey, env.gemini3.model, 'gemini3')
        : null;
    default:
      logger.warn({ provider: name }, '[LLM] Unknown provider name in LLM_PROVIDER_ORDER, skipping');
      return null;
  }
}

/**
 * Builds the LLM service used by all agents, honoring LLM_PROVIDER_ORDER
 * (Gemini first by default; a second Gemini account can serve as a
 * fallback for free-tier rate limits — see env.gemini2). Providers missing
 * required config are skipped silently — only providers that are actually
 * configured take part in the fallback chain. Throws if none are
 * configured (callers should validate this at startup instead of at first
 * request — see env.validateStartupConfig).
 */
export function buildLlmService(): LlmService {
  const providers = env.llm.providerOrder.map(buildProvider).filter((p): p is LlmProvider => p !== null);

  if (providers.length === 0) {
    throw new Error(
      'No LLM provider configured. Set GEMINI_API_KEY, or GEMINI_API_KEY_2, or GEMINI_API_KEY_3, (Gemini is the only supported provider).'
    );
  }

  logger.info({ providers: providers.map((p) => p.name) }, '[LLM] Configured provider chain');

  return providers.length === 1 ? providers[0] : new LlmRouter(providers);
}