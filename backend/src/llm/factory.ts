import { AsyncLocalStorage } from 'async_hooks';
import { createHash } from 'crypto';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { env, isProviderConfigured } from '../config/env';
import { logger } from '../utils/logger';
import { ApiError, ErrorCode } from '../utils/errors';

/**
 * Error codes that represent provider-side infrastructure failures:
 * rate limit, timeout, 5xx, outage, empty response. Only these trigger
 * fallback to the next provider. Schema validation / parse errors from
 * INVALID_AI_RESPONSE must NOT cause fallback by themselves.
 */
const PROVIDER_ERROR_CODES = new Set<string>([
  ErrorCode.AI_RATE_LIMIT,
  ErrorCode.AI_TIMEOUT,
  ErrorCode.AI_PROVIDER_ERROR
]);

// ─────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────

export type FailureCategory =
  | 'timeout'
  | 'rate_limit'
  | 'overloaded'
  | 'server_error'
  | 'network'
  | 'auth'
  | 'model_not_found'
  | 'empty_response'
  | 'invalid_response'
  | 'refusal'
  | 'unknown';

const TRANSIENT_CATEGORIES = new Set<FailureCategory>([
  'timeout',
  'rate_limit',
  'overloaded',
  'server_error',
  'network',
  'empty_response',
  'invalid_response',
  'refusal'
]);

function statusOf(err: unknown): number | undefined {
  const e = err as any;
  const raw = e?.status ?? e?.response?.status ?? e?.statusCode;
  return typeof raw === 'number' ? raw : undefined;
}

function messageOf(err: unknown): string {
  const e = err as any;
  return String(e?.message ?? e?.error?.message ?? '');
}

/**
 * Single source of truth for "what kind of failure is this?". Status codes win
 * over message text; message regexes are anchored to HTTP-status-looking tokens so
 * that e.g. a model name or token count containing "500" is not read as a 5xx.
 */
export function classifyProviderError(err: unknown): FailureCategory {
  if (err instanceof ProviderResponseError) return err.category;
  if (err instanceof ApiError && err.code === ErrorCode.AI_TIMEOUT) return 'timeout';
  if (err instanceof ApiError && err.code === ErrorCode.AI_RATE_LIMIT) return 'rate_limit';

  const status = statusOf(err);
  const msg = messageOf(err);
  const name = String((err as any)?.name ?? '');
  const code = String((err as any)?.code ?? '');

  if (status === 429) return 'rate_limit';
  if (status === 503) return 'overloaded';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_not_found';
  if (typeof status === 'number' && status >= 500 && status < 600) return 'server_error';

  if (/api key not valid|api_key_invalid|invalid api key|permission[_ ]denied|unauthenticated|unauthorized|forbidden/i.test(msg)) {
    return 'auth';
  }
  if (/not found for api version|is not found|unsupported for generatecontent|models\/[\w.\-]+ is not found/i.test(msg)) {
    return 'model_not_found';
  }
  if (/\b429\b|rate limit|quota|resource_exhausted|too many requests/i.test(msg)) return 'rate_limit';
  if (/\[\s*503|\b503\b|high demand|overloaded|unavailable/i.test(msg)) return 'overloaded';
  if (
    name === 'TimeoutError' ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    /timeout|timed out|deadline_exceeded|\b408\b|\b504\b|abort.*due to timeout/i.test(msg)
  ) {
    return 'timeout';
  }
  if (/\[\s*5\d{2}|\b50[0-24]\b|internal error|bad gateway/i.test(msg)) return 'server_error';
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(msg)) return 'network';
  if (/model output.*(empty|must contain)|empty model response/i.test(msg)) return 'empty_response';
  return 'unknown';
}

export function isRateLimitError(err: unknown): boolean {
  return classifyProviderError(err) === 'rate_limit';
}

export function isServerError(err: unknown): boolean {
  const c = classifyProviderError(err);
  return c === 'overloaded' || c === 'server_error';
}

export function isTimeoutError(err: unknown): boolean {
  return classifyProviderError(err) === 'timeout';
}

export function isEmptyOutputError(err: unknown): boolean {
  return classifyProviderError(err) === 'empty_response';
}

/** True for authentication / permission / invalid-model errors (never fixed by retrying). */
export function isPermanentError(err: unknown): boolean {
  const c = classifyProviderError(err);
  return c === 'auth' || c === 'model_not_found';
}

export function isFallbackWorthy(err: unknown): boolean {
  if (err instanceof ApiError && PROVIDER_ERROR_CODES.has(err.code)) return true;
  return TRANSIENT_CATEGORIES.has(classifyProviderError(err));
}

/**
 * Raised inside the router when a provider answered HTTP 200 but the content is
 * unusable (empty / failed the caller's validator / refusal). Treated as a
 * provider failure so the next provider gets a chance.
 */
export class ProviderResponseError extends Error {
  constructor(
    public readonly category: 'empty_response' | 'invalid_response' | 'refusal',
    message: string
  ) {
    super(message);
    this.name = 'ProviderResponseError';
  }
}

/** Per-attempt record carried on AllProvidersFailedError.details (no secrets). */
export interface ProviderAttempt {
  provider: string;
  model?: string;
  category: FailureCategory | 'skipped_cooldown';
  elapsedMs: number;
}

/**
 * Thrown after EVERY provider in the chain failed. Callers must not blindly
 * re-run the whole chain (the router has already tried everything).
 */
export class AllProvidersFailedError extends ApiError {
  constructor(message: string, public readonly attempts: ProviderAttempt[]) {
    super(ErrorCode.AI_PROVIDER_ERROR, message, { attempts });
    this.name = 'AllProvidersFailedError';
  }
}

let fallbackRouterDelayFn: (ms: number) => Promise<void> = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function setFallbackRouterDelayFn(fn: (ms: number) => Promise<void>): void {
  fallbackRouterDelayFn = fn;
}

export function resetFallbackRouterDelayFn(): void {
  fallbackRouterDelayFn = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalizes raw provider errors into typed ApiErrors so the router
 * can make fallback decisions without knowing each provider's SDK internals.
 */
export function normalizeProviderError(err: unknown, providerName: string): ApiError {
  if (err instanceof ApiError) return err;
  const rawMsg = (err as Error)?.message || String(err) || 'unknown';
  switch (classifyProviderError(err)) {
    case 'rate_limit':
      return new ApiError(ErrorCode.AI_RATE_LIMIT, `${providerName} API rate limit exceeded: ${rawMsg}`);
    case 'timeout':
      return new ApiError(ErrorCode.AI_TIMEOUT, `${providerName} API request timed out: ${rawMsg}`);
    case 'overloaded':
    case 'server_error':
      return new ApiError(ErrorCode.AI_PROVIDER_ERROR, `${providerName} API server error: ${rawMsg}`);
    case 'empty_response':
      return new ApiError(ErrorCode.AI_PROVIDER_ERROR, `${providerName} returned empty output: ${rawMsg}`);
    default:
      return new ApiError(ErrorCode.AI_PROVIDER_ERROR, `${providerName} API request failed: ${rawMsg}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Real cancellation for Gemini requests
// ─────────────────────────────────────────────────────────────────────────

const callSignalStore = new AsyncLocalStorage<AbortSignal | undefined>();

/**
 * @langchain/google-genai (verified in 2.3.4) calls
 * `completionWithRetry(request)` from `_generate()` WITHOUT forwarding the call
 * options, so the AbortSignal the router sets on a timeout never reached the HTTP
 * request: the request kept running after the router moved on.
 *
 * This subclass carries the signal through AsyncLocalStorage and hands it to
 * `completionWithRetry`. If a future SDK version forwards the options itself,
 * the explicit options win and this shim becomes a no-op.
 */
export class AbortableChatGoogleGenerativeAI extends ChatGoogleGenerativeAI {
  // Parameter types are `any` on purpose: @langchain/google-genai bundles its own copy of
  // @langchain/core, so the nominal types differ from ours even though they are identical at runtime.
  async _generate(messages: any, options: any, runManager?: any): Promise<any> {
    return callSignalStore.run(options?.signal as AbortSignal | undefined, () =>
      super._generate(messages, options, runManager)
    );
  }

  async completionWithRetry(request: any, options?: any): Promise<any> {
    const signal: AbortSignal | undefined = options?.signal ?? callSignalStore.getStore();
    return super.completionWithRetry(request, signal ? { ...(options ?? {}), signal } : options);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Per-provider health (cooldown) — keyed by provider name, process-wide
// ─────────────────────────────────────────────────────────────────────────

interface ProviderHealth {
  cooldownUntil: number;
  lastCategory?: FailureCategory;
}

const providerHealth = new Map<string, ProviderHealth>();

export function resetProviderHealth(): void {
  providerHealth.clear();
}

function isCoolingDown(name: string, now: number): boolean {
  const h = providerHealth.get(name);
  return Boolean(h && h.cooldownUntil > now);
}

function markFailure(name: string, category: FailureCategory): void {
  const permanent = category === 'auth' || category === 'model_not_found';
  const transientInfra =
    category === 'timeout' || category === 'rate_limit' || category === 'overloaded' || category === 'server_error';
  if (!permanent && !transientInfra) return; // bad content from one call is not provider ill-health
  const ms = permanent ? env.ai.permanentCooldownMs : env.ai.providerCooldownMs;
  if (ms > 0) providerHealth.set(name, { cooldownUntil: Date.now() + ms, lastCategory: category });
}

function markSuccess(name: string): void {
  providerHealth.delete(name);
}

// ─────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────

export interface ProviderEntry {
  name: string;
  model: BaseChatModel;
  modelName?: string;
}

export type ResponseCheck = { ok: true } | { ok: false; category: 'invalid_response' | 'refusal'; message: string };

/** Optional call option: lets the caller reject a 200-OK answer so the next provider is tried. */
export type ResponseValidator = (text: string) => ResponseCheck;

function textOf(result: import('@langchain/core/outputs').ChatResult): string {
  const gen = result.generations?.[0];
  if (!gen) return '';
  if (typeof gen.text === 'string' && gen.text.length > 0) return gen.text;
  const content = (gen as any).message?.content;
  if (typeof content === 'string') return content;
  return content ? JSON.stringify(content) : '';
}

/**
 * Fallback router around LangChain chat models: gemini -> gemini2 -> gemini3.
 *
 * - Each attempt has its own AbortController + timeout; on expiry the HTTP request is aborted.
 * - Failures (timeout / 429 / 5xx / network / empty / unusable content) move on to the next provider.
 * - Auth and invalid-model errors are logged as configuration errors and the provider is skipped.
 * - A failing provider is put in a per-provider cooldown so later calls do not pay its timeout again.
 * - If every provider fails: AllProvidersFailedError (never a silent empty result).
 */
export class LangChainFallbackRouter extends BaseChatModel {
  private readonly providers: ProviderEntry[];

  constructor(providers: ProviderEntry[]) {
    super({});
    if (providers.length === 0) {
      throw new Error('LangChainFallbackRouter requires at least one provider');
    }
    this.providers = providers;
  }

  get registeredProviders(): readonly ProviderEntry[] {
    return this.providers;
  }

  _llmType(): string {
    return 'fallback-router';
  }

  async _generate(
    messages: import('@langchain/core/messages').BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: import('@langchain/core/callbacks/manager').CallbackManagerForLLMRun
  ): Promise<import('@langchain/core/outputs').ChatResult> {
    const attempts: ProviderAttempt[] = [];
    const validator = (options as any)?.responseValidator as ResponseValidator | undefined;
    let lastError: unknown;
    let lastInvalid: import('@langchain/core/outputs').ChatResult | undefined;

    // Skip providers in cooldown — unless that would leave nothing to try.
    const now = Date.now();
    const healthy = this.providers.filter((p) => !isCoolingDown(p.name, now));
    const chain = healthy.length > 0 ? healthy : this.providers;
    for (const p of this.providers) {
      if (!chain.includes(p)) {
        attempts.push({ provider: p.name, model: p.modelName, category: 'skipped_cooldown', elapsedMs: 0 });
        logger.info(
          { provider: p.name, model: p.modelName, lastFailure: providerHealth.get(p.name)?.lastCategory },
          '[LLM] Skipping provider in cooldown'
        );
      }
    }

    for (let i = 0; i < chain.length; i++) {
      if (options?.signal?.aborted) {
        throw options.signal.reason ?? new Error('Aborted');
      }

      const { name, model, modelName } = chain[i];
      const next = chain[i + 1];
      const start = Date.now();
      logger.info({ provider: name, model: modelName, index: i }, '[LLM] Attempting provider');

      // Independent controller per attempt: one provider's timeout aborts only its own request.
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      let onParentAbort: (() => void) | undefined;

      try {
        const timeoutMs = env.ai.requestTimeoutMs;
        if (options?.signal) {
          onParentAbort = () => controller.abort(options.signal?.reason ?? new Error('Aborted'));
          options.signal.addEventListener('abort', onParentAbort, { once: true });
        }

        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const timeoutErr = new ApiError(ErrorCode.AI_TIMEOUT, `${name} API request timed out after ${timeoutMs}ms`);
            controller.abort(timeoutErr);
            reject(timeoutErr);
          }, timeoutMs);
        });

        const call = model._generate(messages, { ...options, signal: controller.signal } as any, runManager);
        // After a timeout the aborted call rejects later; without this it is an unhandled rejection.
        call.catch(() => undefined);
        const result = await Promise.race([call, timeoutPromise]);

        const text = textOf(result);
        if (text.trim().length === 0) {
          throw new ProviderResponseError('empty_response', `${name} returned an empty response`);
        }
        if (validator) {
          const check = validator(text);
          if (!check.ok) {
            lastInvalid = result;
            throw new ProviderResponseError(check.category, `${name} returned an unusable response: ${check.message}`);
          }
        }

        markSuccess(name);
        logger.info({ provider: name, model: modelName, elapsedMs: Date.now() - start }, '[LLM] Provider succeeded');
        return result;
      } catch (err) {
        const elapsedMs = Date.now() - start;

        // Caller cancelled (client disconnect / overall deadline): stop, do not fall back.
        if (options?.signal?.aborted) {
          throw options.signal.reason ?? (err instanceof Error ? err : new Error(String(err)));
        }

        const category = classifyProviderError(err);
        const normalized = normalizeProviderError(err, name);
        lastError = normalized;
        attempts.push({ provider: name, model: modelName, category, elapsedMs });
        markFailure(name, category);

        const logCtx = {
          provider: name,
          model: modelName,
          category,
          elapsedMs,
          error: normalized.message.slice(0, 200),
          fallingBackTo: next?.name ?? null
        };

        if (category === 'auth' || category === 'model_not_found') {
          logger.error(
            logCtx,
            category === 'auth'
              ? '[LLM] CONFIG ERROR: provider rejected its API key (check the key for this provider); skipping'
              : '[LLM] CONFIG ERROR: provider model ID not found/unsupported (check the model ID for this provider); skipping'
          );
        } else if (!isFallbackWorthy(normalized) && !isFallbackWorthy(err)) {
          logger.error(logCtx, '[LLM] Non-retryable error, aborting without fallback');
          throw normalized;
        } else {
          logger.warn(logCtx, next ? '[LLM] Provider failed, falling back' : '[LLM] Provider failed, no providers left');
        }

        // An unknown model ID fails identically on any later provider configured with the same ID.
        if (category === 'model_not_found' && modelName) {
          while (chain[i + 1] && chain[i + 1].modelName === modelName) {
            logger.warn(
              { provider: chain[i + 1].name, model: modelName },
              '[LLM] Skipping provider because it uses the identical failing model'
            );
            attempts.push({ provider: chain[i + 1].name, model: modelName, category: 'model_not_found', elapsedMs: 0 });
            i++;
          }
        }

        // Short pause only for quota/overload (not after a timeout that already waited).
        const delayMs = env.ai.fallbackDelayMs;
        if (next && delayMs > 0 && (category === 'rate_limit' || category === 'overloaded' || category === 'server_error')) {
          logger.info({ provider: name, nextProvider: next.name, fallbackDelayMs: delayMs }, '[LLM] Backing off before attempting fallback provider');
          await fallbackRouterDelayFn(delayMs);
        }
      } finally {
        if (timer) clearTimeout(timer);
        if (options?.signal && onParentAbort) {
          options.signal.removeEventListener('abort', onParentAbort);
        }
      }
    }

    // Some provider answered but the content never validated: let the caller's own
    // repair / INVALID_AI_RESPONSE logic handle it rather than reporting an outage.
    if (lastInvalid) return lastInvalid;

    const summary = attempts.map((a) => `${a.provider}(${a.model ?? '?'}):${a.category}`).join(' -> ');
    throw new AllProvidersFailedError(
      `All LLM providers failed [${summary}]: ${((lastError as Error)?.message ?? 'unknown').slice(0, 300)}`,
      attempts
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Provider construction (Gemini only)
// ─────────────────────────────────────────────────────────────────────────

type GeminiSlot = 'gemini' | 'gemini2' | 'gemini3';
const GEMINI_SLOTS: readonly GeminiSlot[] = ['gemini', 'gemini2', 'gemini3'];

export function keyFingerprint(key: string): string {
  return key ? createHash('sha256').update(key.trim()).digest('hex').slice(0, 8) : 'none';
}

function buildGeminiEntry(slot: GeminiSlot): ProviderEntry | null {
  if (!isProviderConfigured(slot)) return null;
  const cfg = env[slot];

  // A later slot that repeats an earlier slot's key AND model is a duplicate, not a fallback.
  for (const earlierSlot of GEMINI_SLOTS.slice(0, GEMINI_SLOTS.indexOf(slot))) {
    const earlier = env[earlierSlot];
    if (earlier.apiKey && earlier.apiKey.trim() === cfg.apiKey.trim() && earlier.model === cfg.model) {
      logger.warn(
        { provider: slot, duplicateOf: earlierSlot },
        '[LLM] Provider has the same API key and model as an earlier provider; skipping duplicate'
      );
      return null;
    }
  }

  return {
    name: slot,
    modelName: cfg.model,
    model: new AbortableChatGoogleGenerativeAI({
      apiKey: cfg.apiKey,
      model: cfg.model,
      // Router-level fallback is the retry mechanism; SDK retries would multiply the timeout.
      maxRetries: env.ai.sdkMaxRetries,
      // LOW reduces reasoning-token overhead on gemini-3.x flash models (enum is uppercase).
      thinkingConfig: { thinkingLevel: 'LOW' }
    }) as unknown as BaseChatModel
  };
}

export function buildProviderModel(name: string): ProviderEntry | null {
  if ((GEMINI_SLOTS as readonly string[]).includes(name)) {
    return buildGeminiEntry(name as GeminiSlot);
  }
  logger.warn({ name }, '[LLM] Unsupported provider name (only gemini, gemini2, gemini3 exist), skipping');
  return null;
}

/**
 * Builds the LangChain model used by every agent: gemini -> gemini2 -> gemini3.
 */
export function buildChatModel(): BaseChatModel {
  const providers = env.llm.providerOrder
    .map(buildProviderModel)
    .filter((p): p is ProviderEntry => p !== null);

  if (providers.length === 0) {
    throw new Error('No LLM provider configured. Set GEMINI_API_KEY, GEMINI_API_KEY_2 and/or GEMINI_API_KEY_3.');
  }

  logger.info(
    {
      providers: providers.map((p) => p.name),
      models: Object.fromEntries(providers.map((p) => [p.name, p.modelName])),
      keyFingerprints: Object.fromEntries(
        providers.map((p) => [p.name, keyFingerprint(env[p.name as GeminiSlot].apiKey)])
      ),
      timeoutMs: env.ai.requestTimeoutMs,
      sdkMaxRetries: env.ai.sdkMaxRetries,
      cooldownMs: env.ai.providerCooldownMs
    },
    '[LLM] Configured provider chain'
  );

  return new LangChainFallbackRouter(providers);
}
