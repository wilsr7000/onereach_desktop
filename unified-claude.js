/**
 * @deprecated Use lib/ai-service.js instead.
 * This file is retained for backward compatibility but all consumers
 * have been migrated to the centralized AI service.
 * See: const ai = require('./lib/ai-service');
 *
 * Original: Unified Claude Service - Headless First, API Fallback
 */
console.warn('[UnifiedClaude] DEPRECATED — use lib/ai-service.js instead');

const { getSettingsManager } = require('./settings-manager');

class UnifiedClaudeService {
  constructor() {
    // Default settings - can be overridden via settings manager
    this.headlessEnabled = true;
    this.headlessTimeout = 60000; // 60s for headless
    this.apiTimeout = 120000; // 120s for API
    this.preferHeadless = true; // Try headless first
    this.apiFallbackEnabled = true; // Fall back to API if headless fails

    // Load settings if available
    this._loadSettings();
  }

  /**
   * Load settings from settings manager
   */
  _loadSettings() {
    try {
      const settingsManager = getSettingsManager();

      // Load Claude headless preferences
      const preferHeadless = settingsManager.get('claudePreferHeadless');
      if (preferHeadless !== undefined) {
        this.preferHeadless = preferHeadless;
        this.headlessEnabled = preferHeadless;
      }

      const headlessTimeout = settingsManager.get('claudeHeadlessTimeout');
      if (headlessTimeout !== undefined) {
        this.headlessTimeout = headlessTimeout;
      }

      const apiFallback = settingsManager.get('claudeApiFallback');
      if (apiFallback !== undefined) {
        this.apiFallbackEnabled = apiFallback;
      }

      console.log('[UnifiedClaude] Settings loaded:', {
        preferHeadless: this.preferHeadless,
        headlessEnabled: this.headlessEnabled,
        headlessTimeout: this.headlessTimeout,
        apiFallbackEnabled: this.apiFallbackEnabled,
      });
    } catch (_err) {
      console.log('[UnifiedClaude] Using default settings (settings manager not available)');
    }
  }

  /**
   * Main completion method - tries headless first, then API fallback
   *
   * @param {string} prompt - The prompt to send to Claude
   * @param {Object} options - Options
   * @param {boolean} options.forceApi - Force API-only (skip headless)
   * @param {boolean} options.forceHeadless - Force headless-only (no API fallback)
   * @param {number} options.timeout - Custom timeout in ms
   * @param {boolean} options.saveToSpaces - Save to Spaces (headless only)
   * @param {string} options.operation - Operation name for tracking
   * @returns {Promise<Object>} Result object with response and method used
   */
  async complete(prompt, options = {}) {
    const { forceApi = false, forceHeadless = false, timeout, saveToSpaces = true, operation = 'complete' } = options;

    console.log('[UnifiedClaude] Starting completion:', {
      promptLength: prompt.length,
      forceApi,
      forceHeadless,
      operation,
    });

    // Strategy 1: Headless first (if enabled and not forced to API)
    if (this.headlessEnabled && this.preferHeadless && !forceApi) {
      try {
        console.log('[UnifiedClaude] Trying headless method...');
        const result = await this.tryHeadless(prompt, {
          timeout: timeout || this.headlessTimeout,
          saveToSpaces,
        });

        if (result.success) {
          console.log('[UnifiedClaude] Headless succeeded');
          return {
            ...result,
            method: 'headless',
            cost: 0, // Headless is free
          };
        }

        console.log('[UnifiedClaude] Headless returned failure:', result.error);
      } catch (err) {
        console.log('[UnifiedClaude] Headless failed:', err.message);
      }
    }

    // Strategy 2: API fallback (if enabled and not forced to headless)
    if (this.apiFallbackEnabled && !forceHeadless) {
      console.log('[UnifiedClaude] Falling back to API...');
      try {
        const result = await this.tryApi(prompt, {
          timeout: timeout || this.apiTimeout,
          operation,
        });

        console.log('[UnifiedClaude] API succeeded');
        return result;
      } catch (err) {
        console.error('[UnifiedClaude] API also failed:', err.message);
        throw err;
      }
    }

    // If we get here, all methods failed or were disabled
    throw new Error('All Claude methods failed or were disabled');
  }

  /**
   * Try headless Claude (via browser automation)
   */
  async tryHeadless(prompt, options = {}) {
    // Access the global function set by main.js
    if (typeof global.runHeadlessClaudePrompt !== 'function') {
      throw new Error('Headless Claude not available (function not initialized)');
    }

    return global.runHeadlessClaudePrompt(prompt, {
      timeout: options.timeout || this.headlessTimeout,
      saveToSpaces: options.saveToSpaces ?? true,
    });
  }

  /**
   * Try Claude API via centralized AI service
   */
  async tryApi(prompt, options = {}) {
    try {
      const { getAIService } = require('./lib/ai-service');
      const ai = getAIService();

      const result = await ai.chat({
        profile: 'standard',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: options.maxTokens || 4096,
        temperature: options.temperature || 0.3,
        feature: 'unified-claude-compat',
      });

      return {
        success: true,
        response: result.content,
        method: 'api',
        usage: result.usage,
        cost: result.cost || 0,
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        method: 'api',
      };
    }
  }

  /**
   * Check if headless Claude is available (user logged in)
   * This is a quick check - actual availability determined at runtime
   */
  async isHeadlessAvailable() {
    return this.headlessEnabled && typeof global.runHeadlessClaudePrompt === 'function';
  }

  /**
   * Check if API is available (API key configured)
   */
  async isApiAvailable() {
    try {
      const settingsManager = getSettingsManager();
      const apiKey = settingsManager.get('anthropicApiKey') || settingsManager.get('llmApiKey');
      return !!apiKey;
    } catch {
      return false;
    }
  }

  /**
   * Get status of both methods
   */
  async getStatus() {
    const headlessAvailable = await this.isHeadlessAvailable();
    const apiAvailable = await this.isApiAvailable();

    return {
      headless: {
        enabled: this.headlessEnabled,
        available: headlessAvailable,
        timeout: this.headlessTimeout,
        preferred: this.preferHeadless,
      },
      api: {
        enabled: this.apiFallbackEnabled,
        available: apiAvailable,
        timeout: this.apiTimeout,
      },
      recommended: headlessAvailable ? 'headless' : apiAvailable ? 'api' : 'none',
    };
  }

  /**
   * Update settings
   */
  updateSettings(settings) {
    if (settings.preferHeadless !== undefined) {
      this.preferHeadless = settings.preferHeadless;
      this.headlessEnabled = settings.preferHeadless;
    }
    if (settings.headlessTimeout !== undefined) {
      this.headlessTimeout = settings.headlessTimeout;
    }
    if (settings.apiFallbackEnabled !== undefined) {
      this.apiFallbackEnabled = settings.apiFallbackEnabled;
    }

    // Persist to settings manager
    try {
      const settingsManager = getSettingsManager();
      if (settings.preferHeadless !== undefined) {
        settingsManager.set('claudePreferHeadless', settings.preferHeadless);
      }
      if (settings.headlessTimeout !== undefined) {
        settingsManager.set('claudeHeadlessTimeout', settings.headlessTimeout);
      }
      if (settings.apiFallbackEnabled !== undefined) {
        settingsManager.set('claudeApiFallback', settings.apiFallbackEnabled);
      }
    } catch (err) {
      console.warn('[UnifiedClaude] Could not persist settings:', err.message);
    }

    console.log('[UnifiedClaude] Settings updated:', {
      preferHeadless: this.preferHeadless,
      headlessTimeout: this.headlessTimeout,
      apiFallbackEnabled: this.apiFallbackEnabled,
    });
  }
}

// Singleton instance
let unifiedClaudeInstance = null;

/**
 * Get the singleton UnifiedClaudeService instance
 */
function getUnifiedClaudeService() {
  if (!unifiedClaudeInstance) {
    unifiedClaudeInstance = new UnifiedClaudeService();
  }
  return unifiedClaudeInstance;
}

module.exports = {
  UnifiedClaudeService,
  getUnifiedClaudeService,
};
