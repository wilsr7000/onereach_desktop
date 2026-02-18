/**
 * Centralized AI Service
 *
 * SINGLE ENTRY POINT for all AI model calls across the application.
 * All tools, agents, and apps should use this service instead of making
 * direct API calls to OpenAI, Anthropic, or other providers.
 *
 * Features:
 * - Model profiles: request a capability tier (fast/standard/powerful) instead of hardcoding model names
 * - Provider adapters: OpenAI, Anthropic (extensible to Google, Ollama, etc.)
 * - Auto-retry with exponential backoff
 * - Provider fallback: if primary fails, automatically try the fallback provider
 * - Circuit breaker: stop hammering a down provider
 * - Cost monitoring: pre-call budget gate, post-call usage recording
 * - Unified API: chat, chatStream, complete, json, vision, embed, realtime, transcribe, imageEdit
 *
 * Usage:
 *   const ai = require('./lib/ai-service');
 *   const result = await ai.chat({ profile: 'fast', messages: [...], feature: 'email-agent' });
 *
 * @module ai-service
 */

const { getOpenAIAdapter, estimateTokens } = require('./ai-providers/openai-adapter');
const { getAnthropicAdapter } = require('./ai-providers/anthropic-adapter');

// ---------------------------------------------------------------------------
// Debug Logging
// ---------------------------------------------------------------------------

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, none: 4 };
const AI_LOG_LEVEL = LOG_LEVELS[process.env.AI_LOG_LEVEL || 'debug'] ?? LOG_LEVELS.debug;

function _log(level, tag, message, data) {
  if (LOG_LEVELS[level] < AI_LOG_LEVEL) return;
  const prefix = `[AIService:${tag}]`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (data !== undefined) {
    fn(prefix, message, typeof data === 'object' ? JSON.stringify(data) : data);
  } else {
    fn(prefix, message);
  }
}

// Truncate strings for safe logging (never log full prompts or keys)
function _truncate(str, max = 80) {
  if (!str || typeof str !== 'string') return str;
  return str.length > max ? str.substring(0, max) + '...' : str;
}

// ---------------------------------------------------------------------------
// Default Model Profiles
// ---------------------------------------------------------------------------

const DEFAULT_MODEL_PROFILES = {
  fast: {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    fallback: { provider: 'openai', model: 'gpt-4o-mini' },
  },
  standard: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    fallback: { provider: 'openai', model: 'gpt-4o' },
  },
  powerful: {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    fallback: { provider: 'openai', model: 'gpt-4o' },
  },
  large: {
    provider: 'openai',
    model: 'gpt-4o',
    fallback: { provider: 'anthropic', model: 'claude-opus-4-6' },
  },
  vision: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    fallback: { provider: 'openai', model: 'gpt-4o' },
  },
  realtime: {
    provider: 'openai',
    model: 'gpt-4o-realtime-preview',
  },
  embedding: {
    provider: 'openai',
    model: 'text-embedding-3-small',
  },
  transcription: {
    provider: 'openai',
    model: 'whisper-1',
  },
};

// ---------------------------------------------------------------------------
// Retry Configuration
// ---------------------------------------------------------------------------

const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableStatuses: [429, 500, 502, 503],
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'],
};

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

class CircuitBreaker {
  constructor(name) {
    this.name = name;
    this.state = 'closed'; // closed | open | half-open
    this.failureCount = 0;
    this.failureThreshold = 5;
    this.resetTimeoutMs = 60000; // 60 seconds
    this.lastFailure = null;
    this.lastError = null;
  }

  isOpen() {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.resetTimeoutMs) {
        this.state = 'half-open';
        return false; // allow one test request
      }
      return true;
    }
    return false;
  }

  onSuccess() {
    this.failureCount = 0;
    this.state = 'closed';
    this.lastError = null;
  }

  onFailure(error) {
    this.failureCount++;
    this.lastFailure = Date.now();
    this.lastError = error;

    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open';
      console.error(
        `[AIService] Circuit breaker OPEN for ${this.name} after ${this.failureCount} consecutive failures`
      );
    }
  }

  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      lastFailure: this.lastFailure ? new Date(this.lastFailure).toISOString() : null,
      lastError: this.lastError?.message || null,
    };
  }
}

// ---------------------------------------------------------------------------
// Custom Errors
// ---------------------------------------------------------------------------

class BudgetExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
  }
}

class CircuitOpenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CircuitOpenError';
    this.code = 'CIRCUIT_OPEN';
  }
}

class AllProvidersFailedError extends Error {
  constructor(message, primaryError, fallbackError) {
    super(message);
    this.name = 'AllProvidersFailedError';
    this.code = 'ALL_PROVIDERS_FAILED';
    this.primaryError = primaryError;
    this.fallbackError = fallbackError;
  }
}

// ---------------------------------------------------------------------------
// AI Service
// ---------------------------------------------------------------------------

class AIService {
  constructor() {
    // Provider adapters
    this._adapters = {
      openai: getOpenAIAdapter(),
      anthropic: getAnthropicAdapter(),
    };

    // Circuit breakers per provider
    this._circuits = {
      openai: new CircuitBreaker('openai'),
      anthropic: new CircuitBreaker('anthropic'),
    };

    // Model profiles (loaded from settings on first use, falls back to defaults)
    this._profiles = null;

    // Session-level cost tracking (by profile)
    this._sessionCostByProfile = {};
    this._sessionCallCount = 0;

    // Lazy-loaded infrastructure references
    this._budgetManager = null;
    this._usageTracker = null;
    this._settingsManager = null;
    this._logger = null;

    console.log('[AIService] Centralized AI service initialized');
  }

  // =========================================================================
  // Infrastructure Access (lazy-loaded to avoid circular deps)
  // =========================================================================

  _getBudgetManager() {
    if (!this._budgetManager) {
      try {
        const { getBudgetManager } = require('../budget-manager');
        this._budgetManager = getBudgetManager();
      } catch {
        /* not available yet */
      }
    }
    return this._budgetManager;
  }

  _getUsageTracker() {
    if (!this._usageTracker) {
      try {
        const { getLLMUsageTracker } = require('../llm-usage-tracker');
        this._usageTracker = getLLMUsageTracker();
      } catch {
        /* not available yet */
      }
    }
    return this._usageTracker;
  }

  _getSettingsManager() {
    if (!this._settingsManager) {
      // Prefer global singleton (set by Electron main process or test harness)
      if (global.settingsManager) {
        this._settingsManager = global.settingsManager;
      } else {
        // Fallback: load the module directly
        try {
          const { getSettingsManager } = require('../settings-manager');
          this._settingsManager = getSettingsManager();
        } catch {
          /* not available yet */
        }
      }
    }
    return this._settingsManager;
  }

  _getLogger() {
    if (!this._logger) {
      try {
        this._logger = require('../event-logger')();
      } catch {
        // Fallback logger
        this._logger = {
          info: (...args) => console.log('[AIService]', ...args),
          warn: (...args) => console.warn('[AIService]', ...args),
          error: (...args) => console.error('[AIService]', ...args),
          debug: () => {},
        };
      }
    }
    return this._logger;
  }

  // =========================================================================
  // Profile Resolution
  // =========================================================================

  /**
   * Get model profiles. Uses settings override if available, else defaults.
   */
  getProfiles() {
    if (!this._profiles) {
      const settings = this._getSettingsManager();
      const custom = settings?.get('aiModelProfiles');
      this._profiles = custom ? { ...DEFAULT_MODEL_PROFILES, ...custom } : { ...DEFAULT_MODEL_PROFILES };
    }
    return this._profiles;
  }

  /**
   * Reload profiles from settings (call after settings change).
   */
  reloadProfiles() {
    this._profiles = null;
    return this.getProfiles();
  }

  /**
   * Resolve a profile name or direct provider/model to { provider, model, fallback }.
   */
  _resolveProfile(opts) {
    if (opts.profile) {
      const profiles = this.getProfiles();
      const profile = profiles[opts.profile];
      if (!profile) {
        throw new Error(`Unknown AI profile: "${opts.profile}". Available: ${Object.keys(profiles).join(', ')}`);
      }
      _log('debug', 'profile', `Resolved profile="${opts.profile}" -> ${profile.provider}/${profile.model}`);
      return { ...profile, profileName: opts.profile };
    }

    // Direct provider/model override
    if (opts.provider && opts.model) {
      _log('debug', 'profile', `Direct override -> ${opts.provider}/${opts.model}`);
      return { provider: opts.provider, model: opts.model, profileName: 'custom' };
    }

    // Default to 'fast'
    const profiles = this.getProfiles();
    _log('debug', 'profile', `Default -> fast (${profiles.fast.provider}/${profiles.fast.model})`);
    return { ...profiles.fast, profileName: 'fast' };
  }

  // =========================================================================
  // API Key Resolution
  // =========================================================================

  /**
   * Get the API key for a provider from settings.
   */
  _getApiKey(provider) {
    const settings = this._getSettingsManager();
    if (!settings) {
      _log('error', 'apiKey', `Settings manager not available for ${provider}`);
      throw new Error(`Settings manager not available. Cannot retrieve ${provider} API key.`);
    }

    if (provider === 'openai') {
      const key =
        settings.get('openaiApiKey') ||
        (settings.get('llmProvider') === 'openai' ? settings.get('llmApiKey') : null) ||
        process.env.OPENAI_API_KEY;
      if (!key) throw new Error('OpenAI API key not configured. Add it in Settings > API Keys.');
      _log('debug', 'apiKey', `OpenAI key loaded (${key.substring(0, 8)}...)`);
      return key;
    }

    if (provider === 'anthropic') {
      // Clean the key (handle copy-paste errors)
      const rawKey =
        settings.get('anthropicApiKey') ||
        settings.get('llmConfig.anthropic.apiKey') ||
        (settings.get('llmProvider') === 'anthropic' ? settings.get('llmApiKey') : null);
      if (!rawKey) throw new Error('Anthropic API key not configured. Add it in Settings > API Keys.');

      // Extract sk-ant- pattern
      const match = rawKey.match(/sk-ant-[A-Za-z0-9_-]+/);
      const cleanKey = match ? match[0] : rawKey;
      _log('debug', 'apiKey', `Anthropic key loaded (${cleanKey.substring(0, 10)}...)`);
      return cleanKey;
    }

    throw new Error(`Unknown provider: ${provider}`);
  }

  // =========================================================================
  // Cost Monitoring
  // =========================================================================

  /**
   * Pre-call budget check. Throws BudgetExceededError if hard limit hit.
   * Returns warnings if soft limit approached.
   */
  _checkBudget(provider, model, estimatedInputTokens, estimatedOutputTokens, feature) {
    const budgetMgr = this._getBudgetManager();
    if (!budgetMgr) {
      _log('debug', 'budget', `No budget manager available, skipping check for ${feature}`);
      return { allowed: true, blocked: false, warnings: [] };
    }

    try {
      const result = budgetMgr.preCheckBudget(provider, model, estimatedInputTokens, estimatedOutputTokens);

      if (result.blocked) {
        _log('warn', 'budget', `BLOCKED by hard budget limit: ${provider}/${model} feature=${feature}`);
        const logger = this._getLogger();
        logger.warn('AI call blocked by hard budget limit', {
          event: 'ai-service:budget-blocked',
          provider,
          model,
          feature,
        });
        throw new BudgetExceededError(`Budget limit reached. ${result.warnings?.map((w) => w.message).join('. ')}`);
      }

      if (result.warnings?.length > 0) {
        _log(
          'warn',
          'budget',
          `Budget warning for ${provider}/${model}: ${result.warnings.map((w) => w.message).join('; ')}`
        );
        const logger = this._getLogger();
        logger.warn('AI call proceeding with budget warning', {
          event: 'ai-service:budget-warning',
          provider,
          model,
          feature,
          warnings: result.warnings,
        });
      } else {
        _log('debug', 'budget', `Budget check passed for ${provider}/${model} feature=${feature}`);
      }

      return result;
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      // Budget check failed — proceed anyway (advisory)
      _log('debug', 'budget', `Budget check error (proceeding anyway): ${err.message}`);
      return { allowed: true, blocked: false, warnings: [] };
    }
  }

  /**
   * Post-call usage recording.
   */
  _recordUsage(provider, model, usage, feature, profileName, duration, success = true) {
    const inTokens = usage.promptTokens || 0;
    const outTokens = usage.completionTokens || 0;

    // Track in LLM Usage Tracker (which delegates to BudgetManager)
    const tracker = this._getUsageTracker();
    if (tracker) {
      try {
        const trackFn = provider === 'anthropic' ? 'trackClaudeCall' : 'trackOpenAICall';
        tracker[trackFn]({
          model,
          inputTokens: inTokens,
          outputTokens: outTokens,
          feature: feature || 'other',
          purpose: `ai-service:${profileName}`,
          success,
          duration,
        });
      } catch (err) {
        // Tracking failure shouldn't break the call
        _log('warn', 'usage', `Usage tracking failed: ${err.message}`);
      }
    }

    // Session-level profile tracking
    if (!this._sessionCostByProfile[profileName]) {
      this._sessionCostByProfile[profileName] = { calls: 0, cost: 0, tokens: 0 };
    }

    try {
      const { calculateCost } = require('../pricing-config');
      const costResult = calculateCost(model, inTokens, outTokens);
      this._sessionCostByProfile[profileName].calls++;
      this._sessionCostByProfile[profileName].cost += costResult.totalCost;
      this._sessionCostByProfile[profileName].tokens += inTokens + outTokens;
      this._sessionCallCount++;

      _log(
        'info',
        'usage',
        `${provider}/${model} profile=${profileName} feature=${feature} ` +
          `tokens=${inTokens}+${outTokens} cost=$${costResult.totalCost.toFixed(4)} duration=${duration}ms`
      );

      return costResult.totalCost;
    } catch {
      this._sessionCostByProfile[profileName].calls++;
      this._sessionCallCount++;
      _log(
        'info',
        'usage',
        `${provider}/${model} profile=${profileName} feature=${feature} ` +
          `tokens=${inTokens}+${outTokens} duration=${duration}ms (cost calc unavailable)`
      );
      return 0;
    }
  }

  // =========================================================================
  // Retry + Fallback Engine
  // =========================================================================

  /**
   * Execute a call with retry logic.
   */
  async _callWithRetry(adapterFn, opts, retryConfig = RETRY_CONFIG) {
    let lastError;

    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
      if (attempt > 0) {
        _log('info', 'retry', `Attempt ${attempt + 1}/${retryConfig.maxRetries + 1}`);
      }
      try {
        return await adapterFn(opts);
      } catch (err) {
        lastError = err;

        const isRetryable = this._isRetryableError(err);
        if (!isRetryable || attempt === retryConfig.maxRetries) {
          _log('error', 'retry', `Failed after ${attempt + 1} attempt(s): ${err.message} (retryable=${isRetryable})`);
          throw err;
        }

        // Calculate delay
        let delay = Math.min(retryConfig.baseDelayMs * Math.pow(2, attempt), retryConfig.maxDelayMs);
        if (err.retryAfter) {
          delay = Math.max(delay, err.retryAfter * 1000);
        }

        // Surface rate-limit errors prominently -- don't let them hide in retry noise
        if (err.statusCode === 429) {
          _log(
            'error',
            'rate-limit',
            `RATE LIMIT HIT (${opts.model || 'unknown'}): retrying in ${delay}ms. Retry-After: ${err.retryAfter || 'none'}. This should not happen routinely -- if frequent, reduce concurrency or upgrade API tier.`
          );
          // Also push to structured log so it shows on dashboards
          try {
            const logger = this._getLogger();
            if (logger?.error)
              logger.error('AI rate limit hit', {
                event: 'ai-service:rate-limit',
                model: opts.model,
                attempt: attempt + 1,
                retryAfter: err.retryAfter,
                delay,
              });
          } catch (_ignored) {
            /* logger.error may throw if logger not ready */
          }
        } else {
          _log('warn', 'retry', `Retry ${attempt + 1}/${retryConfig.maxRetries} after ${delay}ms: ${err.message}`);
        }
        await this._sleep(delay);
      }
    }

    throw lastError;
  }

  /**
   * Execute a call with circuit breaker, retry, and fallback.
   */
  async _executeWithResilience(callType, profile, primaryOpts, buildOpts) {
    const { provider: primaryProvider, model: primaryModel, fallback, profileName } = profile;
    const feature = primaryOpts.feature || 'other';
    const startTime = Date.now();

    _log(
      'debug',
      'resilience',
      `${callType} -> ${primaryProvider}/${primaryModel} (profile=${profileName}, feature=${feature})`
    );
    // Log to app log queue for observability
    this._getLogger().info(`AI ${callType}: ${primaryProvider}/${primaryModel}`, {
      event: 'ai-service:call',
      profile: profileName,
      provider: primaryProvider,
      model: primaryModel,
      feature,
    });

    // --- Try primary provider ---
    const primaryCircuit = this._circuits[primaryProvider];
    let primaryError = null;

    if (!primaryCircuit || !primaryCircuit.isOpen()) {
      try {
        const adapter = this._adapters[primaryProvider];
        if (!adapter) throw new Error(`No adapter for provider: ${primaryProvider}`);

        const apiKey = this._getApiKey(primaryProvider);
        const opts = buildOpts(adapter, apiKey, primaryModel);

        const result = await this._callWithRetry((o) => adapter[callType](o), opts);

        primaryCircuit?.onSuccess();

        // Record usage
        const duration = Date.now() - startTime;
        const cost = this._recordUsage(
          primaryProvider,
          primaryModel,
          result.usage || {},
          feature,
          profileName,
          duration
        );

        _log('info', 'resilience', `${callType} SUCCESS via ${primaryProvider}/${primaryModel} in ${duration}ms`);
        return { ...result, cost, profile: profileName, usedFallback: false };
      } catch (err) {
        primaryError = err;
        primaryCircuit?.onFailure(err);

        _log(
          'warn',
          'resilience',
          `Primary ${primaryProvider}/${primaryModel} failed: ${err.message} (circuit=${primaryCircuit?.state})`
        );
        this._getLogger().warn('Primary provider failed', {
          event: 'ai-service:primary-failed',
          provider: primaryProvider,
          model: primaryModel,
          error: err.message,
          circuitState: primaryCircuit?.state,
        });
      }
    } else {
      primaryError = new CircuitOpenError(`${primaryProvider} circuit is open`);
      _log('warn', 'resilience', `Primary ${primaryProvider} circuit is OPEN, skipping`);
    }

    // --- Try fallback provider ---
    if (fallback && !primaryOpts.noFallback) {
      const { provider: fbProvider, model: fbModel } = fallback;
      const fbCircuit = this._circuits[fbProvider];

      if (!fbCircuit || !fbCircuit.isOpen()) {
        try {
          const adapter = this._adapters[fbProvider];
          if (!adapter) throw new Error(`No adapter for fallback provider: ${fbProvider}`);

          const apiKey = this._getApiKey(fbProvider);
          const opts = buildOpts(adapter, apiKey, fbModel);

          _log('info', 'resilience', `Falling back to ${fbProvider}/${fbModel}`);

          const result = await this._callWithRetry((o) => adapter[callType](o), opts);

          fbCircuit?.onSuccess();

          const duration = Date.now() - startTime;
          const cost = this._recordUsage(fbProvider, fbModel, result.usage || {}, feature, profileName, duration);

          _log('info', 'resilience', `${callType} SUCCESS via fallback ${fbProvider}/${fbModel} in ${duration}ms`);
          return { ...result, cost, profile: profileName, usedFallback: true, fallbackProvider: fbProvider };
        } catch (fbErr) {
          fbCircuit?.onFailure(fbErr);

          _log('error', 'resilience', `Both ${primaryProvider} and fallback ${fbProvider} failed`);
          throw new AllProvidersFailedError(
            `Both ${primaryProvider} and fallback ${fbProvider} failed`,
            primaryError,
            fbErr
          );
        }
      } else {
        _log('warn', 'resilience', `Fallback ${fbProvider} circuit is OPEN, no providers left`);
      }
    }

    // No fallback or fallback circuit open
    throw primaryError;
  }

  /**
   * Check if an error is retryable.
   */
  _isRetryableError(err) {
    if (err.statusCode && RETRY_CONFIG.retryableStatuses.includes(err.statusCode)) return true;
    if (err.code && RETRY_CONFIG.retryableErrors.includes(err.code)) return true;
    if (err.message?.includes('ECONNRESET')) return true;
    if (err.message?.includes('ETIMEDOUT')) return true;
    return false;
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  // =========================================================================
  // PUBLIC API: Chat Completion
  // =========================================================================

  /**
   * Send a chat completion request.
   *
   * @param {Object} opts
   * @param {string} [opts.profile='fast'] - Profile name
   * @param {string} [opts.provider] - Direct provider override
   * @param {string} [opts.model] - Direct model override
   * @param {Array}  opts.messages - Chat messages [{role, content}]
   * @param {number} [opts.maxTokens=1024]
   * @param {number} [opts.temperature=0.7]
   * @param {boolean} [opts.jsonMode=false]
   * @param {string} [opts.system] - System prompt
   * @param {string} [opts.feature] - Feature tag for cost tracking
   * @param {boolean} [opts.noFallback=false] - Disable fallback
   * @param {number} [opts.timeout=120000]
   * @returns {Promise<Object>} { content, usage, model, provider, cost, profile, usedFallback }
   */
  async chat(opts) {
    _log(
      'debug',
      'chat',
      `messages=${opts.messages?.length || 0} feature=${opts.feature || 'none'} profile=${opts.profile || 'default'}`
    );
    const profile = this._resolveProfile(opts);

    // Budget check (estimate)
    const msgText =
      opts.messages?.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(' ') ||
      '';
    const estInput = estimateTokens(msgText);
    const estOutput = opts.maxTokens || 1024;
    this._checkBudget(profile.provider, profile.model, estInput, estOutput, opts.feature);

    return this._executeWithResilience('chat', profile, opts, (adapter, apiKey, model) => ({
      apiKey,
      model,
      messages: opts.messages,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      jsonMode: opts.jsonMode,
      system: opts.system,
      timeout: opts.timeout,
      thinking: opts.thinking,
      effort: opts.effort,
    }));
  }

  // =========================================================================
  // PUBLIC API: Streaming Chat
  // =========================================================================

  /**
   * Stream a chat completion. Returns an async iterable.
   * Each chunk: { delta, done, finalResult? }
   *
   * Note: Streaming does NOT use fallback (streaming state can't be replayed).
   * Retry is limited to connection errors before streaming starts.
   */
  async *chatStream(opts) {
    _log(
      'debug',
      'chatStream',
      `messages=${opts.messages?.length || 0} feature=${opts.feature || 'none'} profile=${opts.profile || 'default'}`
    );
    const profile = this._resolveProfile(opts);
    const { provider, model, profileName } = profile;

    // Budget check
    const msgText =
      opts.messages?.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(' ') ||
      '';
    const estInput = estimateTokens(msgText);
    this._checkBudget(provider, model, estInput, opts.maxTokens || 1024, opts.feature);

    const adapter = this._adapters[provider];
    if (!adapter) throw new Error(`No adapter for provider: ${provider}`);

    const apiKey = this._getApiKey(provider);
    const startTime = Date.now();

    const stream = adapter.chatStream({
      apiKey,
      model,
      messages: opts.messages,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      jsonMode: opts.jsonMode,
      system: opts.system,
      timeout: opts.timeout,
      thinking: opts.thinking,
      effort: opts.effort,
    });

    let finalResult = null;

    for await (const chunk of stream) {
      if (chunk.done && chunk.finalResult) {
        finalResult = chunk.finalResult;
        const duration = Date.now() - startTime;
        const cost = this._recordUsage(provider, model, finalResult.usage || {}, opts.feature, profileName, duration);
        finalResult.cost = cost;
        finalResult.profile = profileName;
        yield { delta: '', done: true, finalResult };
      } else {
        yield chunk;
      }
    }
  }

  // =========================================================================
  // PUBLIC API: Convenience Methods
  // =========================================================================

  /**
   * Simple text completion — wraps chat() with a single user prompt.
   * Returns the response text string.
   */
  async complete(prompt, opts = {}) {
    _log('debug', 'complete', `promptLen=${prompt?.length || 0} feature=${opts.feature || 'none'}`);
    const messages = [{ role: 'user', content: prompt }];
    const result = await this.chat({ ...opts, messages });
    _log('debug', 'complete', `responseLen=${result.content?.length || 0}`);
    return result.content;
  }

  /**
   * JSON completion — sends prompt and parses JSON response.
   * Returns the parsed object.
   */
  async json(prompt, opts = {}) {
    _log('debug', 'json', `promptLen=${prompt?.length || 0} feature=${opts.feature || 'none'}`);
    const messages = [{ role: 'user', content: prompt }];
    const result = await this.chat({ ...opts, messages, jsonMode: true });

    try {
      // Try direct parse
      const parsed = JSON.parse(result.content);
      _log('debug', 'json', `Parsed JSON directly, keys=${Object.keys(parsed).length}`);
      return parsed;
    } catch {
      // Try extracting JSON from markdown code blocks
      const match = result.content.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || result.content.match(/(\{[\s\S]*\})/);
      if (match) {
        const extracted = JSON.parse(match[1] || match[0]);
        _log('debug', 'json', `Extracted JSON from code block, keys=${Object.keys(extracted).length}`);
        return extracted;
      }
      _log('error', 'json', `Failed to parse JSON: ${_truncate(result.content, 120)}`);
      throw new Error(`Failed to parse JSON from AI response: ${result.content.substring(0, 200)}`);
    }
  }

  /**
   * Vision — analyze an image.
   * Returns the full result (same shape as chat).
   */
  async vision(imageData, prompt, opts = {}) {
    _log(
      'debug',
      'vision',
      `promptLen=${prompt?.length || 0} feature=${opts.feature || 'none'} imageDataLen=${typeof imageData === 'string' ? imageData.length : 'buffer'}`
    );
    const profile = this._resolveProfile({ profile: 'vision', ...opts });
    const feature = opts.feature || 'vision-analysis';

    // Budget check
    const estInput = estimateTokens(prompt) + 1000; // image tokens estimate
    this._checkBudget(profile.provider, profile.model, estInput, opts.maxTokens || 1024, feature);

    return this._executeWithResilience('vision', profile, { ...opts, feature }, (adapter, apiKey, model) => ({
      apiKey,
      model,
      imageData,
      prompt,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      system: opts.system,
      timeout: opts.timeout,
    }));
  }

  /**
   * Embeddings — generate vector embeddings.
   * Returns { embeddings, usage, model, provider }.
   */
  async embed(input, opts = {}) {
    const inputCount = Array.isArray(input) ? input.length : 1;
    _log('debug', 'embed', `inputCount=${inputCount} feature=${opts.feature || 'none'}`);
    const profile = this._resolveProfile({ profile: 'embedding', ...opts });
    const { provider, model, profileName } = profile;
    const feature = opts.feature || 'embeddings';

    const adapter = this._adapters[provider];
    if (!adapter || !adapter.embed) {
      throw new Error(`Provider ${provider} does not support embeddings`);
    }

    const apiKey = this._getApiKey(provider);
    const startTime = Date.now();

    const result = await adapter.embed({ apiKey, model, input, timeout: opts.timeout });
    const duration = Date.now() - startTime;

    // Record usage (embeddings have prompt tokens only)
    this._recordUsage(
      provider,
      model,
      { promptTokens: result.usage?.promptTokens || 0 },
      feature,
      profileName,
      duration
    );

    _log('debug', 'embed', `Completed in ${duration}ms, embeddings=${result.embeddings?.length || 0}`);
    return result;
  }

  /**
   * Transcription — transcribe audio.
   * Returns { text, duration?, language?, words?, segments?, model, provider }.
   * When opts.responseFormat='verbose_json' and opts.timestampGranularities=['word'],
   * the response includes word-level timestamps in the `words` array.
   */
  async transcribe(audioBuffer, opts = {}) {
    const bufSize = audioBuffer?.length || audioBuffer?.byteLength || 0;
    _log(
      'debug',
      'transcribe',
      `audioSize=${(bufSize / 1024).toFixed(1)}KB lang=${opts.language || 'auto'} format=${opts.responseFormat || 'json'} feature=${opts.feature || 'none'}`
    );
    const profile = this._resolveProfile({ profile: 'transcription', ...opts });
    const { provider, model, profileName } = profile;
    const feature = opts.feature || 'transcription';

    const adapter = this._adapters[provider];
    if (!adapter || !adapter.transcribe) {
      throw new Error(`Provider ${provider} does not support transcription`);
    }

    const apiKey = this._getApiKey(provider);
    const startTime = Date.now();

    const result = await adapter.transcribe({
      apiKey,
      model,
      audioBuffer,
      filename: opts.filename,
      language: opts.language,
      responseFormat: opts.responseFormat,
      timestampGranularities: opts.timestampGranularities,
      timeout: opts.timeout,
    });

    const duration = Date.now() - startTime;
    this._recordUsage(provider, model, {}, feature, profileName, duration);

    _log(
      'info',
      'transcribe',
      `Completed in ${duration}ms textLen=${result.text?.length || 0} words=${result.words?.length || 0}`
    );
    return result;
  }

  /**
   * TTS — text-to-speech.
   * Returns { audioBuffer, model, provider }.
   */
  async tts(text, opts = {}) {
    _log(
      'debug',
      'tts',
      `textLen=${text?.length || 0} voice=${opts.voice || 'alloy'} feature=${opts.feature || 'none'}`
    );
    const adapter = this._adapters.openai;
    const apiKey = this._getApiKey('openai');
    const startTime = Date.now();

    // Auto-select model based on voice: newer voices require gpt-4o-mini-tts
    const NEWER_TTS_VOICES = new Set(['ash', 'ballad', 'coral', 'sage', 'verse']);
    const voice = opts.voice || 'alloy';
    const model = opts.model || (NEWER_TTS_VOICES.has(voice) ? 'gpt-4o-mini-tts' : 'tts-1');
    const isNewerModel = model === 'gpt-4o-mini-tts';

    const result = await adapter.tts({
      apiKey,
      model,
      input: text,
      voice,
      responseFormat: opts.responseFormat || 'mp3',
      // Speed control: tts-1 uses speed param; gpt-4o-mini-tts uses instructions
      speed: !isNewerModel ? opts.speed || 1.2 : undefined,
      instructions: isNewerModel
        ? opts.instructions ||
          'Speak at a quick, energetic pace like a helpful voice assistant. Do not speak slowly or deliberately.'
        : undefined,
      timeout: opts.timeout,
    });

    const duration = Date.now() - startTime;
    this._recordUsage('openai', model, {}, opts.feature || 'tts', 'tts', duration);

    _log('info', 'tts', `Completed in ${duration}ms audioSize=${result.audioBuffer?.length || 0}`);
    return result;
  }

  /**
   * Image Edit — edit an image using DALL-E / gpt-image-1.
   * Returns { images: [{b64_json?, url?}], model, provider }.
   *
   * @param {Buffer} imageBuffer - Image file buffer (PNG preferred)
   * @param {string} prompt - Edit instructions
   * @param {Object} [opts] - Options: model, size, n, timeout, feature
   */
  async imageEdit(imageBuffer, prompt, opts = {}) {
    _log(
      'debug',
      'imageEdit',
      `promptLen=${prompt?.length || 0} imageSize=${imageBuffer?.length || 0} feature=${opts.feature || 'none'}`
    );
    const adapter = this._adapters.openai;
    if (!adapter || !adapter.imageEdit) {
      throw new Error('OpenAI adapter does not support image editing');
    }

    const apiKey = this._getApiKey('openai');
    const feature = opts.feature || 'image-edit';
    const startTime = Date.now();

    const result = await adapter.imageEdit({
      apiKey,
      imageBuffer,
      prompt,
      model: opts.model || 'gpt-image-1',
      size: opts.size,
      n: opts.n,
      timeout: opts.timeout,
    });

    const duration = Date.now() - startTime;
    this._recordUsage('openai', opts.model || 'gpt-image-1', {}, feature, 'image-edit', duration);

    _log('info', 'imageEdit', `Completed in ${duration}ms images=${result.images?.length || 0}`);
    return result;
  }

  /**
   * Image Generation — generate images using DALL-E.
   * Returns { images: [{b64_json?, url?, revised_prompt?}], model, provider, cost }.
   *
   * @param {string} prompt - Image generation prompt
   * @param {Object} [opts] - Options: model, n, size, quality, responseFormat, timeout, feature
   */
  async imageGenerate(prompt, opts = {}) {
    _log(
      'debug',
      'imageGenerate',
      `prompt="${_truncate(prompt, 60)}" model=${opts.model || 'dall-e-3'} size=${opts.size || '1024x1024'} quality=${opts.quality || 'standard'} feature=${opts.feature || 'none'}`
    );
    const adapter = this._adapters.openai;
    if (!adapter || !adapter.imageGenerate) {
      throw new Error('OpenAI adapter does not support image generation');
    }

    const apiKey = this._getApiKey('openai');
    const feature = opts.feature || 'image-generation';
    const model = opts.model || 'dall-e-3';
    const startTime = Date.now();

    // Budget check (image generation is per-image, not per-token)
    this._checkBudget('openai', model, 0, 0, feature);

    const result = await adapter.imageGenerate({
      apiKey,
      prompt,
      model,
      n: opts.n || 1,
      size: opts.size || '1024x1024',
      quality: opts.quality || 'standard',
      responseFormat: opts.responseFormat || 'b64_json',
      timeout: opts.timeout || 120000,
    });

    const duration = Date.now() - startTime;
    this._recordUsage('openai', model, {}, feature, 'image-generation', duration);

    _log('info', 'imageGenerate', `Completed in ${duration}ms images=${result.images?.length || 0}`);
    return { ...result, cost: 0, duration };
  }

  /**
   * Realtime — create a WebSocket session for voice streaming.
   * Returns a session object with send(), close().
   */
  realtime(opts = {}) {
    _log('debug', 'realtime', `Creating realtime session`);
    const profile = this._resolveProfile({ profile: 'realtime', ...opts });
    const { provider, model } = profile;

    const adapter = this._adapters[provider];
    if (!adapter || !adapter.createRealtimeSession) {
      throw new Error(`Provider ${provider} does not support realtime API`);
    }

    const apiKey = this._getApiKey(provider);

    _log('info', 'realtime', `Opening WebSocket to ${provider}/${model}`);
    return adapter.createRealtimeSession({
      apiKey,
      model,
      onMessage: opts.onMessage,
      onError: opts.onError,
      onClose: opts.onClose,
    });
  }

  // =========================================================================
  // PUBLIC API: Specialized High-Level Helpers (from claude-api.js)
  // =========================================================================

  /**
   * Plan an agent — analyze user request and recommend approach.
   * Absorbed from claude-api.js planAgent().
   */
  async planAgent(description, availableTemplates = {}, opts = {}) {
    _log(
      'debug',
      'planAgent',
      `description="${_truncate(description, 60)}" templates=${Object.keys(availableTemplates).length}`
    );
    const templateInfo = Object.entries(availableTemplates)
      .map(([id, t]) => `- ${id}: ${t.name} - ${t.description} (capabilities: ${t.capabilities?.join(', ')})`)
      .join('\n');

    const prompt = `Analyze this user request and plan the best approach for building a voice-activated agent:

USER REQUEST: "${description}"

AVAILABLE EXECUTION TYPES:
${
  templateInfo ||
  `
- shell: Terminal commands, file operations, system tasks
- applescript: macOS app control, UI automation, system features
- nodejs: JavaScript code, API calls, data processing
- llm: Conversational AI, Q&A, text generation (no system access)
- browser: Web automation, scraping, form filling
`
}

Analyze the request and identify ALL possible features this agent could have.

Respond in JSON format:
{
  "understanding": "What the user is trying to accomplish in one sentence",
  "executionType": "The best execution type for this task",
  "reasoning": "Why this execution type is best (2-3 sentences)",
  "features": [{ "id": "feature_id", "name": "Feature Name", "description": "What this feature does", "enabled": true, "feasible": true, "feasibilityReason": "Why", "priority": "core|recommended|optional", "requiresPermission": false }],
  "approach": { "steps": [], "requirements": [], "challenges": [] },
  "suggestedName": "Short agent name (2-4 words)",
  "suggestedKeywords": [],
  "verification": { "canAutoVerify": true, "verificationMethod": "How to check", "expectedOutcome": "What success looks like" },
  "testPlan": { "tests": [{ "id": "test_id", "name": "Test Name", "description": "What this test verifies", "testPrompt": "Voice command to test", "expectedBehavior": "Expected result", "verificationMethod": "auto-app-state | auto-file-check | manual", "priority": "critical | important | nice-to-have" }], "setupSteps": [], "cleanupSteps": [] },
  "confidence": 0.0
}`;

    try {
      const result = await this.json(prompt, {
        profile: opts.profile || 'powerful',
        maxTokens: 8000,
        temperature: 0.2,
        feature: opts.feature || 'agent-planning',
      });

      return { success: true, plan: result };
    } catch (_err) {
      // Try to extract partial JSON
      try {
        const text = await this.complete(prompt, {
          profile: opts.profile || 'powerful',
          maxTokens: 8000,
          temperature: 0.2,
          feature: opts.feature || 'agent-planning',
        });
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return { success: true, plan: JSON.parse(jsonMatch[0]), raw: text };
        }
        return { success: false, error: 'Could not parse planning response', raw: text };
      } catch (innerErr) {
        return { success: false, error: innerErr.message };
      }
    }
  }

  /**
   * Diagnose an agent failure.
   * Absorbed from claude-api.js diagnoseAgentFailure().
   */
  async diagnoseAgentFailure(agent, testPrompt, result, opts = {}) {
    _log('debug', 'diagnoseAgentFailure', `agent="${agent?.name}" testPrompt="${_truncate(testPrompt, 40)}"`);
    const prompt = `Analyze this agent test failure and identify the root cause:

AGENT:
- Name: ${agent.name}
- Type: ${agent.executionType}
- Prompt: ${agent.prompt?.substring(0, 500)}

TEST INPUT: ${testPrompt}

FAILURE RESULT:
- Verification Method: ${result.method}
- Details: ${result.details}
${result.script ? `- Script Used: ${result.script}` : ''}
${result.error ? '- Execution Error: true' : ''}

Respond in JSON format:
{
  "summary": "One-line description of what went wrong",
  "rootCause": "Technical explanation of why it failed",
  "category": "command-syntax | missing-prerequisite | wrong-approach | permission-denied | app-state-issue | timing-issue | other",
  "confidence": 0.0,
  "suggestedFix": "Specific change to make"
}`;

    try {
      return await this.json(prompt, {
        profile: opts.profile || 'powerful',
        maxTokens: 500,
        temperature: 0.1,
        feature: opts.feature || 'agent-diagnosis',
      });
    } catch (err) {
      return {
        summary: 'Diagnosis error',
        rootCause: err.message,
        category: 'other',
        confidence: 0,
        suggestedFix: 'Unable to diagnose - check logs manually',
      };
    }
  }

  /**
   * Generate a fix for a failed agent.
   * Absorbed from claude-api.js generateAgentFix().
   */
  async generateAgentFix(agent, testPrompt, diagnosis, opts = {}) {
    const prompt = `Generate a fix for this agent failure:

AGENT:
${JSON.stringify(agent, null, 2)}

DIAGNOSIS:
${JSON.stringify(diagnosis, null, 2)}

TEST PROMPT: ${testPrompt}

Respond in JSON format:
{
  "canFix": true,
  "reason": "Why the fix will work",
  "description": "Human-readable description of the fix",
  "fixType": "script-change | prompt-change | approach-change | add-prerequisite",
  "changes": {
    "newScript": "Corrected script or null",
    "newPrompt": "Updated prompt or null",
    "preCommands": [],
    "postCommands": [],
    "executionType": "Changed type or null"
  }
}`;

    try {
      return await this.json(prompt, {
        profile: opts.profile || 'powerful',
        maxTokens: 800,
        temperature: 0.1,
        feature: opts.feature || 'agent-diagnosis',
      });
    } catch (err) {
      return { canFix: false, reason: err.message, description: 'Fix generation failed' };
    }
  }

  /**
   * Generate an optimized script for an agent action.
   * Absorbed from claude-api.js generateOptimizedScript().
   */
  async generateOptimizedScript(agent, testPrompt, scriptType, previousAttempts = [], opts = {}) {
    const failureContext =
      previousAttempts.length > 0
        ? `\n\nPREVIOUS FAILURES (avoid these mistakes):\n${previousAttempts
            .map((a, i) => `${i + 1}. ${a.script || 'N/A'} -> Failed: ${a.details}`)
            .join('\n')}`
        : '';

    const typeInstructions =
      scriptType === 'applescript'
        ? 'Generate AppleScript code. Use proper "tell application" syntax.'
        : 'Generate a shell command. Use safe commands, no sudo or rm -rf.';

    const prompt = `${typeInstructions}

AGENT: ${agent.name}
TASK: ${testPrompt}
${failureContext}

Generate ONLY the ${scriptType} code, no explanations or markdown:`;

    const response = await this.complete(prompt, {
      profile: opts.profile || 'powerful',
      maxTokens: 300,
      temperature: 0.1,
      feature: opts.feature || 'agent-diagnosis',
    });

    // Clean up response
    let script = response.trim();
    script = script.replace(/^```(applescript|bash|sh|shell)?\n?/i, '');
    script = script.replace(/\n?```$/i, '');
    return script;
  }

  // =========================================================================
  // PUBLIC API: Cost Summary
  // =========================================================================

  /**
   * Get comprehensive cost summary.
   */
  getCostSummary() {
    const budgetMgr = this._getBudgetManager();
    const tracker = this._getUsageTracker();

    const sessionData = tracker?.getUsageSummary() || {};
    const dailyData = budgetMgr?.getCostSummary('daily') || {};
    const weeklyData = budgetMgr?.getCostSummary('weekly') || {};
    const monthlyData = budgetMgr?.getCostSummary('monthly') || {};

    return {
      session: {
        calls: sessionData.total?.calls || 0,
        totalCost: sessionData.total?.cost || 0,
        byProvider: {
          openai: sessionData.openai?.cost || 0,
          anthropic: sessionData.claude?.cost || 0,
        },
      },
      today: {
        calls: dailyData.usageCount || 0,
        totalCost: dailyData.totalCost || 0,
        budget: {
          daily: dailyData.limit || 0,
          remaining: dailyData.remaining || 0,
          pct: dailyData.percentUsed || 0,
        },
      },
      week: {
        calls: weeklyData.usageCount || 0,
        totalCost: weeklyData.totalCost || 0,
        budget: {
          weekly: weeklyData.limit || 0,
          remaining: weeklyData.remaining || 0,
          pct: weeklyData.percentUsed || 0,
        },
      },
      month: {
        calls: monthlyData.usageCount || 0,
        totalCost: monthlyData.totalCost || 0,
        budget: {
          monthly: monthlyData.limit || 0,
          remaining: monthlyData.remaining || 0,
          pct: monthlyData.percentUsed || 0,
        },
      },
      byFeature: budgetMgr?.data?.stats?.byFeature || {},
      byProfile: { ...this._sessionCostByProfile },
    };
  }

  // =========================================================================
  // PUBLIC API: Status & Configuration
  // =========================================================================

  /**
   * Get service status (circuit states, adapter availability).
   */
  getStatus() {
    return {
      adapters: Object.keys(this._adapters),
      circuits: {
        openai: this._circuits.openai.getStatus(),
        anthropic: this._circuits.anthropic.getStatus(),
      },
      profiles: this.getProfiles(),
      sessionCalls: this._sessionCallCount,
      sessionCostByProfile: { ...this._sessionCostByProfile },
    };
  }

  /**
   * Update a model profile at runtime. Persisted to settings.
   */
  setProfile(name, profileConfig) {
    _log('info', 'setProfile', `Setting profile "${name}" -> ${profileConfig.provider}/${profileConfig.model}`);
    const profiles = this.getProfiles();
    profiles[name] = profileConfig;
    this._profiles = profiles;

    // Persist to settings
    const settings = this._getSettingsManager();
    if (settings) {
      settings.set('aiModelProfiles', profiles);
    }

    return profiles;
  }

  /**
   * Reset circuit breaker for a provider.
   */
  resetCircuit(provider) {
    _log('info', 'resetCircuit', `Resetting circuit breaker for ${provider}`);
    const circuit = this._circuits[provider];
    if (circuit) {
      circuit.state = 'closed';
      circuit.failureCount = 0;
      circuit.lastError = null;
      return true;
    }
    return false;
  }

  /**
   * Test connectivity to a provider.
   */
  async testConnection(provider) {
    _log('info', 'testConnection', `Testing ${provider}...`);
    try {
      const apiKey = this._getApiKey(provider);
      const adapter = this._adapters[provider];

      if (provider === 'openai') {
        await adapter.chat({
          apiKey,
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Hi' }],
          maxTokens: 5,
          timeout: 15000,
        });
      } else if (provider === 'anthropic') {
        await adapter.chat({
          apiKey,
          model: 'claude-3-haiku-20240307',
          messages: [{ role: 'user', content: 'Hi' }],
          maxTokens: 5,
          timeout: 15000,
        });
      }

      _log('info', 'testConnection', `${provider} connection OK`);
      return { success: true, provider };
    } catch (err) {
      _log('error', 'testConnection', `${provider} connection FAILED: ${err.message}`);
      return { success: false, provider, error: err.message };
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton & Module Exports
// ---------------------------------------------------------------------------

let instance = null;

function getAIService() {
  if (!instance) {
    instance = new AIService();
  }
  return instance;
}

// Export singleton methods directly for convenience:
//   const ai = require('./lib/ai-service');
//   await ai.chat({ ... });
//
// Named exports are stored on _namedExports and returned by the Proxy's
// get trap before falling through to the singleton instance.
const _namedExports = {
  AIService,
  getAIService,
  BudgetExceededError,
  CircuitOpenError,
  AllProvidersFailedError,
  DEFAULT_MODEL_PROFILES,
};

const proxy = new Proxy(_namedExports, {
  get(target, prop) {
    // Named exports take priority
    if (prop in target) {
      return target[prop];
    }
    // Then delegate to the singleton instance
    const svc = getAIService();
    if (typeof svc[prop] === 'function') {
      return svc[prop].bind(svc);
    }
    return svc[prop];
  },
  set(target, prop, value) {
    target[prop] = value;
    return true;
  },
});

module.exports = proxy;
