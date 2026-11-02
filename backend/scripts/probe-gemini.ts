/**
 * Manual diagnostic (NOT run by tests): sends one tiny request per configured Gemini provider and
 * prints model, status category and latency. Use it to see which key/model is slow or rejected.
 *   npx ts-node scripts/probe-gemini.ts
 * Uses a few tokens of real quota. Never prints API keys.
 */
import { buildProviderModel, classifyProviderError, keyFingerprint } from '../src/llm/factory';
import { env } from '../src/config/env';

async function main() {
  for (const name of ['gemini', 'gemini2', 'gemini3'] as const) {
    const entry = buildProviderModel(name);
    if (!entry) {
      console.log(`${name}: not configured (or duplicate of an earlier provider)`);
      continue;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('probe timeout')), env.ai.requestTimeoutMs);
    const start = Date.now();
    try {
      await entry.model.invoke('Reply with the single word: ok', { signal: controller.signal } as any);
      console.log(`${name}: OK model=${entry.modelName} key#${keyFingerprint(env[name].apiKey)} ${Date.now() - start}ms`);
    } catch (err) {
      console.log(
        `${name}: FAIL model=${entry.modelName} key#${keyFingerprint(env[name].apiKey)} category=${classifyProviderError(err)} ${Date.now() - start}ms`
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
main();
