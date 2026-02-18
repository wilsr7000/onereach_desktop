/**
 * Multi-Tenant Token Store
 * Manages multi-tenant authentication tokens across IDW environments
 * Handles token capture, storage, injection, and refresh propagation
 *
 * Security Features:
 * - Domain validation prevents subdomain attacks
 * - Partition validation prevents injection into arbitrary partitions
 * - Listener cleanup prevents memory leaks
 */

const { getSettingsManager } = require('./settings-manager');

// Lazy-load electron session to support unit testing with vi.mock
let _electronSession;
function getElectronSession() {
  if (!_electronSession) {
    _electronSession = require('electron').session;
  }
  return _electronSession;
}

/**
 * Supported OneReach environments and their domain patterns
 */
const ONEREACH_ENVIRONMENTS = {
  edison: {
    patterns: ['edison.onereach.ai', 'edison.api.onereach.ai'],
    apiDomain: '.edison.api.onereach.ai',
  },
  staging: {
    patterns: ['staging.onereach.ai', 'staging.api.onereach.ai'],
    apiDomain: '.staging.api.onereach.ai',
  },
  dev: {
    patterns: ['dev.onereach.ai', 'dev.api.onereach.ai'],
    apiDomain: '.dev.api.onereach.ai',
  },
  production: {
    patterns: ['onereach.ai', 'api.onereach.ai', 'my.onereach.ai'],
    apiDomain: '.api.onereach.ai',
  },
};

class MultiTenantStore {
  constructor() {
    // Token storage for 'mult' cookie: { edison: tokenData, staging: tokenData, ... }
    this.tokens = {};

    // Token storage for 'or' cookie (account session): { edison: tokenData, ... }
    this.orTokens = {};

    // Active partitions per environment: { edison: Set(['persist:tab-1', ...]) }
    this.activePartitions = {};

    // Track which partitions have cookie listeners attached
    this.listenedPartitions = new Set();

    // Track cleanup functions for listener removal
    this.listenerCleanup = new Map();

    // Re-entrancy guard to prevent propagation loops
    this.propagating = false;

    // Load persisted tokens on startup
    this.loadTokens();
  }

  // ===== Security: Domain Validation =====

  /**
   * Securely validate OneReach domain
   * Prevents subdomain attacks like api.onereach.ai.attacker.com
   * @param {string} domain - Domain to validate
   * @returns {boolean} True if valid OneReach domain
   */
  isValidOneReachDomain(domain) {
    if (!domain) return false;
    const normalized = domain.toLowerCase().replace(/^\./, '');

    // Must be exactly onereach.ai or end with .onereach.ai
    return normalized === 'onereach.ai' || normalized === 'api.onereach.ai' || normalized.endsWith('.onereach.ai');
  }

  // ===== Token Management =====

  /**
   * Store a token for an environment
   * @param {string} environment - The environment (edison, staging, etc.)
   * @param {object} tokenData - Token data including value, domain, etc.
   */
  async setToken(environment, tokenData) {
    this.tokens[environment] = {
      ...tokenData,
      capturedAt: Date.now(),
    };
    await this.saveTokens();
    console.log(`[MultiTenant] Stored token for ${environment}`);
  }

  /**
   * Get token for an environment
   * @param {string} environment - The environment
   * @returns {object|null} Token data or null
   */
  getToken(environment) {
    return this.tokens[environment] || null;
  }

  /**
   * Check if a token exists for an environment
   * @param {string} environment - The environment
   * @returns {boolean}
   */
  hasToken(environment) {
    return !!this.tokens[environment];
  }

  /**
   * Check if a token exists and is not expired
   * @param {string} environment - The environment
   * @returns {boolean}
   */
  hasValidToken(environment) {
    const token = this.tokens[environment];
    if (!token) return false;

    // Check expiration (cookie expiration is in seconds since Unix epoch)
    if (token.expiresAt && token.expiresAt * 1000 < Date.now()) {
      return false;
    }

    return true;
  }

  /**
   * Clear token for an environment
   * @param {string} environment - The environment
   */
  clearToken(environment) {
    delete this.tokens[environment];
    this.saveTokens();
    console.log(`[MultiTenant] Cleared token for ${environment}`);
  }

  /**
   * Get list of environments with valid tokens
   * @returns {string[]} Array of environment names
   */
  getEnvironmentsWithTokens() {
    return Object.keys(this.tokens).filter((env) => this.hasValidToken(env));
  }

  // ===== OR Token Management (Account Session) =====

  /**
   * Store an 'or' token for an environment (account session)
   * @param {string} environment - The environment
   * @param {object} tokenData - Token data
   */
  async setOrToken(environment, tokenData) {
    this.orTokens[environment] = {
      ...tokenData,
      capturedAt: Date.now(),
    };
    await this.saveTokens();
    console.log(`[MultiTenant] Stored or token for ${environment}`);
  }

  /**
   * Get 'or' token for an environment
   * @param {string} environment - The environment
   * @returns {object|null} Token data or null
   */
  getOrToken(environment) {
    return this.orTokens[environment] || null;
  }

  /**
   * Check if an 'or' token exists for an environment
   * @param {string} environment - The environment
   * @returns {boolean}
   */
  hasOrToken(environment) {
    return !!this.orTokens[environment];
  }

  /**
   * Check if an 'or' token exists and is not expired
   * @param {string} environment - The environment
   * @returns {boolean}
   */
  hasValidOrToken(environment) {
    const token = this.orTokens[environment];
    if (!token) return false;

    if (token.expiresAt && token.expiresAt * 1000 < Date.now()) {
      return false;
    }

    return true;
  }

  /**
   * Get the user session data extracted from 'or' cookie for localStorage injection
   * The 'or' cookie value is URL-encoded JSON containing user session info
   * @param {string} environment - The environment
   * @returns {object|null} Object with parsed data AND raw cookie value, or null
   */
  getOrTokenUserData(environment) {
    const orToken = this.orTokens[environment];
    if (!orToken || !orToken.value) return null;

    try {
      // The or cookie value is URL-encoded JSON
      const rawValue = orToken.value;
      const decoded = decodeURIComponent(rawValue);
      const userData = JSON.parse(decoded);

      // Return both parsed data and raw cookie value
      return {
        ...userData,
        _rawCookieValue: rawValue,
        _decodedCookieValue: decoded,
      };
    } catch (err) {
      console.error(`[MultiTenant] Failed to parse or token for ${environment}:`, err.message);
      return null;
    }
  }

  /**
   * Propagate 'or' token to all active partitions except the source
   * @param {string} environment - The environment
   * @param {string} sourcePartition - The partition where refresh originated
   */
  async propagateOrToken(environment, sourcePartition) {
    const token = this.getOrToken(environment);
    if (!token) {
      console.warn(`[MultiTenant] No or token to propagate for ${environment}`);
      return;
    }

    const partitions = this.getActivePartitions(environment);
    const targetPartitions = partitions.filter((p) => p !== sourcePartition);

    if (targetPartitions.length === 0) {
      console.log(`[MultiTenant] No other partitions to propagate or token to for ${environment}`);
      return;
    }

    // Set re-entrancy guard to prevent loops from cookie listener callbacks
    this.propagating = true;

    console.log(`[MultiTenant] Propagating ${environment} or token to ${targetPartitions.length} partitions`);

    const broaderDomain = this.getBroaderDomain(environment);

    for (const partition of targetPartitions) {
      try {
        const ses = getElectronSession().fromPartition(partition);
        await ses.cookies.set({
          url: `https://api${broaderDomain}`,
          name: 'or',
          value: token.value,
          domain: broaderDomain,
          secure: token.secure !== false,
          httpOnly: token.httpOnly !== false,
          expirationDate: token.expiresAt,
        });
        console.log(`[MultiTenant] Propagated or token to ${partition}`);
      } catch (err) {
        console.error(`[MultiTenant] Failed to propagate or token to ${partition}:`, err.message);
      }
    }

    // Reset re-entrancy guard
    this.propagating = false;
  }

  // ===== Persistence =====

  /**
   * Load tokens from settings (encrypted storage)
   */
  async loadTokens() {
    try {
      const settingsManager = getSettingsManager();

      // Load mult tokens
      const saved = settingsManager.get('multiTenantTokens');
      if (saved) {
        this.tokens = typeof saved === 'string' ? JSON.parse(saved) : saved;
        const envList = Object.keys(this.tokens);
        console.log(`[MultiTenant] Loaded mult tokens for: ${envList.join(', ') || 'none'}`);

        // Log validity status for each token
        envList.forEach((env) => {
          const valid = this.hasValidToken(env);
          const token = this.tokens[env];
          console.log(
            `[MultiTenant]   ${env}: valid=${valid}, valueLen=${token?.value?.length || 0}, expires=${token?.expiresAt ? new Date(token.expiresAt * 1000).toISOString() : 'none'}`
          );
        });
      } else {
        console.log('[MultiTenant] No saved mult tokens found');
      }

      // Load or tokens
      const savedOr = settingsManager.get('multiTenantOrTokens');
      if (savedOr) {
        this.orTokens = typeof savedOr === 'string' ? JSON.parse(savedOr) : savedOr;
        console.log(`[MultiTenant] Loaded or tokens for: ${Object.keys(this.orTokens).join(', ') || 'none'}`);
      } else {
        console.log('[MultiTenant] No saved or tokens found');
      }
    } catch (err) {
      console.error('[MultiTenant] Failed to load tokens:', err.message);
      this.tokens = {};
      this.orTokens = {};
    }
  }

  /**
   * Get diagnostic info about all tokens (for debugging)
   * @returns {object} Token status summary
   */
  getDiagnostics() {
    const result = {
      multTokens: {},
      orTokens: {},
      activePartitions: {},
    };

    // Mult tokens
    for (const [env, token] of Object.entries(this.tokens)) {
      result.multTokens[env] = {
        hasValue: !!token?.value,
        valueLength: token?.value?.length || 0,
        domain: token?.domain,
        expiresAt: token?.expiresAt ? new Date(token.expiresAt * 1000).toISOString() : null,
        isValid: this.hasValidToken(env),
        capturedAt: token?.capturedAt ? new Date(token.capturedAt).toISOString() : null,
        sourcePartition: token?.sourcePartition,
      };
    }

    // Or tokens
    for (const [env, token] of Object.entries(this.orTokens)) {
      result.orTokens[env] = {
        hasValue: !!token?.value,
        valueLength: token?.value?.length || 0,
        isValid: this.hasValidOrToken(env),
      };
    }

    // Active partitions
    for (const [env, partitions] of Object.entries(this.activePartitions)) {
      result.activePartitions[env] = Array.from(partitions);
    }

    return result;
  }

  /**
   * Save tokens to settings (encrypted storage)
   */
  async saveTokens() {
    try {
      const settingsManager = getSettingsManager();
      settingsManager.set('multiTenantTokens', JSON.stringify(this.tokens));
      settingsManager.set('multiTenantOrTokens', JSON.stringify(this.orTokens));
    } catch (err) {
      console.error('[MultiTenant] Failed to save tokens:', err.message);
    }
  }

  // ===== Partition Management =====

  /**
   * Register a partition for an environment (for refresh propagation)
   * @param {string} environment - The environment
   * @param {string} partition - The partition name
   */
  registerPartition(environment, partition) {
    if (!this.activePartitions[environment]) {
      this.activePartitions[environment] = new Set();
    }
    this.activePartitions[environment].add(partition);
    console.log(
      `[MultiTenant] Registered ${partition} for ${environment} (total: ${this.activePartitions[environment].size})`
    );
  }

  /**
   * Unregister a partition (on tab close)
   * @param {string} environment - The environment
   * @param {string} partition - The partition name
   */
  unregisterPartition(environment, partition) {
    if (this.activePartitions[environment]) {
      this.activePartitions[environment].delete(partition);
      console.log(`[MultiTenant] Unregistered ${partition} from ${environment}`);
    }
  }

  /**
   * Get all active partitions for an environment
   * @param {string} environment - The environment
   * @returns {string[]} Array of partition names
   */
  getActivePartitions(environment) {
    return this.activePartitions[environment] ? Array.from(this.activePartitions[environment]) : [];
  }

  // ===== Cookie Listener =====

  /**
   * Attach cookie listener to a session partition
   * Call this for each webview's partition to capture tokens
   * @param {string} partitionName - The partition name (e.g., 'persist:tab-123')
   */
  attachCookieListener(partitionName) {
    // Avoid duplicate listeners
    if (this.listenedPartitions.has(partitionName)) {
      return;
    }

    const ses = getElectronSession().fromPartition(partitionName);

    // Create named handler for removal
    const handler = async (event, cookie, cause, removed) => {
      // SECURITY: Use isValidOneReachDomain() to prevent subdomain attacks
      if (!removed && this.isValidOneReachDomain(cookie.domain)) {
        const environment = this.extractEnvironment(cookie.domain);

        // Capture 'mult' (multi-tenant API token)
        if (cookie.name === 'mult') {
          const isRefresh = this.hasToken(environment);

          console.log(
            `[MultiTenant] ${isRefresh ? 'Refreshed' : 'Captured'} ${environment} mult token from ${partitionName}`
          );
          console.log(`[MultiTenant] Cookie details:`, {
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            sameSite: cookie.sameSite,
            expirationDate: cookie.expirationDate,
            valueLength: cookie.value?.length,
          });

          await this.setToken(environment, {
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: cookie.sameSite,
            expiresAt: cookie.expirationDate,
            sourcePartition: partitionName,
          });

          // Register this partition as the source (for first login)
          this.registerPartition(environment, partitionName);

          // If refresh, propagate to all OTHER partitions (but prevent loops)
          if (isRefresh && !this.propagating) {
            await this.propagateToken(environment, partitionName);
          }
        }

        // Capture 'or' (account session token) for SSO
        if (cookie.name === 'or') {
          const hasExisting = this.hasOrToken(environment);

          console.log(
            `[MultiTenant] ${hasExisting ? 'Refreshed' : 'Captured'} ${environment} or token from ${partitionName}`
          );

          await this.setOrToken(environment, {
            value: cookie.value,
            domain: cookie.domain,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            expiresAt: cookie.expirationDate,
            sourcePartition: partitionName,
          });

          // If refresh, propagate to all OTHER partitions (but prevent loops)
          if (hasExisting && !this.propagating) {
            await this.propagateOrToken(environment, partitionName);
          }
        }
      }
    };

    ses.cookies.on('changed', handler);
    this.listenedPartitions.add(partitionName);

    // Store cleanup function
    this.listenerCleanup.set(partitionName, () => {
      ses.cookies.removeListener('changed', handler);
    });

    console.log(`[MultiTenant] Cookie listener attached to ${partitionName}`);
  }

  /**
   * Remove cookie listener when tab closes (for tab partitions only)
   * GSX partitions should NOT be cleaned up since they're shared
   * @param {string} partitionName - The partition name
   */
  removeCookieListener(partitionName) {
    // Only remove tab partition listeners
    if (!partitionName.startsWith('persist:tab-')) {
      return;
    }

    const cleanup = this.listenerCleanup.get(partitionName);
    if (cleanup) {
      cleanup();
      this.listenerCleanup.delete(partitionName);
      this.listenedPartitions.delete(partitionName);
      console.log(`[MultiTenant] Cookie listener removed from ${partitionName}`);
    }
  }

  // ===== Token Propagation =====

  /**
   * Propagate token to all active partitions EXCEPT the source
   * @param {string} environment - The environment (edison, staging, etc.)
   * @param {string} sourcePartition - The partition where refresh originated (skip this one)
   */
  async propagateToken(environment, sourcePartition) {
    const token = this.getToken(environment);
    if (!token) {
      console.warn(`[MultiTenant] No token to propagate for ${environment}`);
      return;
    }

    const partitions = this.getActivePartitions(environment);
    const targetPartitions = partitions.filter((p) => p !== sourcePartition);

    if (targetPartitions.length === 0) {
      console.log(`[MultiTenant] No other partitions to propagate to for ${environment}`);
      return;
    }

    // Set re-entrancy guard to prevent loops from cookie listener callbacks
    this.propagating = true;

    console.log(`[MultiTenant] Propagating ${environment} token to ${targetPartitions.length} partitions`);

    // Use the centralized injection function for each partition
    // Note: We use force=true because we're propagating a fresh token
    const results = await Promise.allSettled(
      targetPartitions.map((partition) =>
        this.injectTokenIntoPartition(environment, partition, {
          source: 'propagateToken',
          force: true, // Force injection even if cookie exists (we have fresh token)
          maxRetries: 1, // Fewer retries for propagation to avoid slowdown
        })
      )
    );

    // Log results
    let successCount = 0;
    let failCount = 0;

    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value.success) {
        successCount++;
      } else {
        failCount++;
        const error = result.status === 'rejected' ? result.reason?.message : result.value?.error;
        console.warn(`[MultiTenant] Propagation to ${targetPartitions[index]} failed: ${error}`);
      }
    });

    console.log(`[MultiTenant] Propagation complete: ${successCount} succeeded, ${failCount} failed`);

    // Reset re-entrancy guard
    this.propagating = false;
  }

  // ===== Environment Helpers =====

  /**
   * Extract environment from domain
   * @param {string} domain - The domain (e.g., 'edison.api.onereach.ai')
   * @returns {string} Environment name (edison, staging, production, dev)
   */
  extractEnvironment(domain) {
    if (!domain) return 'production';

    const lowerDomain = domain.toLowerCase();

    // Check each environment's patterns (specific envs first, production last)
    for (const [env, config] of Object.entries(ONEREACH_ENVIRONMENTS)) {
      for (const pattern of config.patterns) {
        if (lowerDomain === pattern || lowerDomain.endsWith('.' + pattern)) {
          return env;
        }
      }
    }

    // Fallback: try to extract from subdomain pattern
    // e.g., "something.edison.onereach.ai" -> "edison"
    const match = lowerDomain.match(/\.?(edison|staging|production|dev)\.(?:api\.)?onereach\.ai/i);
    if (match) {
      return match[1].toLowerCase();
    }

    // Default to production
    return 'production';
  }

  /**
   * Extract environment from full URL
   * @param {string} url - The URL
   * @returns {string} Environment name
   */
  extractEnvironmentFromUrl(url) {
    try {
      const hostname = new URL(url).hostname;
      return this.extractEnvironment(hostname);
    } catch {
      return 'production';
    }
  }

  /**
   * Get a broader domain that covers ALL subdomains for an environment
   * Used for cookie injection to enable SSO across auth, idw, chat, api subdomains
   * @param {string} environment - The environment
   * @returns {string} Broader domain with leading dot (e.g., '.edison.onereach.ai')
   */
  getBroaderDomain(environment) {
    const domains = {
      edison: '.edison.onereach.ai',
      staging: '.staging.onereach.ai',
      production: '.onereach.ai',
      dev: '.dev.onereach.ai',
    };
    return domains[environment] || '.onereach.ai';
  }

  /**
   * Get the API domain for an environment
   * Used for cookie injection to cover API subdomains like sdkapi.edison.api.onereach.ai
   * @param {string} environment - The environment
   * @returns {string} API domain with leading dot (e.g., '.edison.api.onereach.ai')
   */
  getApiDomain(environment) {
    const config = ONEREACH_ENVIRONMENTS[environment];
    return config?.apiDomain || '.api.onereach.ai';
  }

  /**
   * Check if a URL belongs to OneReach (securely)
   * @param {string} url - The URL to check
   * @returns {boolean}
   */
  isOneReachUrl(url) {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return this.isValidOneReachDomain(hostname);
    } catch {
      return false;
    }
  }

  // ===== Hardened Token Injection =====

  /**
   * Inject authentication token into a session partition
   * This is the SINGLE SOURCE OF TRUTH for token injection logic.
   *
   * Features:
   * - Validates environment and token before injection
   * - Injects on BOTH UI domain and API domain for full coverage
   * - Retry logic with exponential backoff
   * - Verification that cookies were actually set
   * - Detailed logging for debugging
   * - Graceful degradation on failure
   *
   * @param {string} environment - The IDW environment (edison, staging, production, dev)
   * @param {string} partition - The session partition name (e.g., 'persist:gsx-edison')
   * @param {object} options - Optional configuration
   * @param {number} options.maxRetries - Max retry attempts (default: 2)
   * @param {boolean} options.force - Force injection even if cookie exists (default: false)
   * @param {string} options.source - Caller identifier for logging (default: 'unknown')
   * @returns {Promise<{success: boolean, cookieCount: number, domains: string[], error?: string}>}
   */
  async injectTokenIntoPartition(environment, partition, options = {}) {
    const { maxRetries = 2, force = false, source = 'unknown' } = options;
    const logPrefix = `[MultiTenant:${source}]`;

    // Result object to track what happened
    const result = {
      success: false,
      cookieCount: 0,
      domains: [],
      error: null,
    };

    // === Validation ===

    // Validate environment
    if (!environment || typeof environment !== 'string') {
      result.error = 'Invalid environment parameter';
      console.error(`${logPrefix} ${result.error}:`, environment);
      return result;
    }

    // Normalize environment name
    const normalizedEnv = environment.toLowerCase().trim();
    if (!ONEREACH_ENVIRONMENTS[normalizedEnv] && normalizedEnv !== 'default') {
      console.warn(`${logPrefix} Unknown environment '${normalizedEnv}', using production defaults`);
    }

    // Validate partition
    if (!partition || typeof partition !== 'string') {
      result.error = 'Invalid partition parameter';
      console.error(`${logPrefix} ${result.error}:`, partition);
      return result;
    }

    // Ensure partition starts with 'persist:'
    const fullPartition = partition.startsWith('persist:') ? partition : `persist:${partition}`;

    // Check for valid token
    if (!this.hasValidToken(normalizedEnv)) {
      result.error = `No valid token for environment '${normalizedEnv}'`;
      console.log(`${logPrefix} ${result.error}`);
      return result;
    }

    const token = this.getToken(normalizedEnv);
    if (!token || !token.value) {
      result.error = 'Token exists but has no value';
      console.error(`${logPrefix} ${result.error}`);
      return result;
    }

    // Validate token value format (basic sanity check)
    if (token.value.length < 10) {
      result.error = 'Token value appears too short to be valid';
      console.error(`${logPrefix} ${result.error}: length=${token.value.length}`);
      return result;
    }

    // === Get domains ===

    const uiDomain = this.getBroaderDomain(normalizedEnv);
    const apiDomain = this.getApiDomain(normalizedEnv);

    // Validate domains
    if (!this.isValidOneReachDomain(uiDomain) || !this.isValidOneReachDomain(apiDomain)) {
      result.error = 'Invalid domain configuration';
      console.error(`${logPrefix} ${result.error}: ui=${uiDomain}, api=${apiDomain}`);
      return result;
    }

    console.log(`${logPrefix} Injecting token for ${normalizedEnv} into ${fullPartition}`);
    console.log(`${logPrefix}   UI domain: ${uiDomain}`);
    console.log(`${logPrefix}   API domain: ${apiDomain}`);

    // === Injection with retry ===

    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const ses = getElectronSession().fromPartition(fullPartition);

        // Check if cookies already exist (unless force=true)
        if (!force) {
          const existingUi = await ses.cookies.get({ domain: uiDomain, name: 'mult' });
          const existingApi = await ses.cookies.get({ domain: apiDomain, name: 'mult' });

          if (existingUi.length > 0 && existingApi.length > 0) {
            console.log(
              `${logPrefix} Tokens already exist in partition (ui: ${existingUi.length}, api: ${existingApi.length})`
            );
            result.success = true;
            result.cookieCount = existingUi.length + existingApi.length;
            result.domains = [...new Set([...existingUi.map((c) => c.domain), ...existingApi.map((c) => c.domain)])];
            return result;
          }
        }

        // Cookie options (shared between UI and API)
        const cookieBase = {
          name: 'mult',
          value: token.value,
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'no_restriction',
          expirationDate: token.expiresAt || Math.floor(Date.now() / 1000) + 86400 * 30, // Default 30 days
        };

        // Inject on UI domain
        await ses.cookies.set({
          ...cookieBase,
          url: `https://auth${uiDomain}`,
          domain: uiDomain,
        });

        // Inject on API domain
        await ses.cookies.set({
          ...cookieBase,
          url: `https://api${apiDomain}`,
          domain: apiDomain,
        });

        // CRITICAL: Flush to disk to ensure persistence
        await ses.cookies.flushStore();

        // === Verification ===

        // Small delay to ensure cookies are committed
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });

        // Get ALL mult cookies in this session (not just our expected domains)
        const allMultCookies = await ses.cookies.get({ name: 'mult' });
        console.log(`${logPrefix} All 'mult' cookies in session (${allMultCookies.length}):`);
        allMultCookies.forEach((c) => {
          console.log(
            `${logPrefix}   domain=${c.domain}, path=${c.path}, secure=${c.secure}, httpOnly=${c.httpOnly}, sameSite=${c.sameSite}`
          );
        });

        // Verify cookies were set on our target domains
        const verifyUi = allMultCookies.filter(
          (c) => c.domain === uiDomain || c.domain === uiDomain.replace(/^\./, '')
        );
        const verifyApi = allMultCookies.filter(
          (c) => c.domain === apiDomain || c.domain === apiDomain.replace(/^\./, '')
        );

        console.log(`${logPrefix} UI domain (${uiDomain}) cookies: ${verifyUi.length}`);
        console.log(`${logPrefix} API domain (${apiDomain}) cookies: ${verifyApi.length}`);

        if (allMultCookies.length === 0) {
          throw new Error('Cookie verification failed - no mult cookies found in session');
        }

        // Check if at least one cookie has the correct value
        const hasCorrectValue = allMultCookies.some((c) => c.value === token.value);

        if (!hasCorrectValue) {
          console.error(
            `${logPrefix} Cookie value mismatch! Expected length ${token.value.length}, found values with lengths: ${allMultCookies.map((c) => c.value?.length).join(', ')}`
          );
          throw new Error('Cookie verification failed - cookie value mismatch');
        }

        // Success!
        result.success = true;
        result.cookieCount = allMultCookies.length;
        result.domains = [...new Set(allMultCookies.map((c) => c.domain))];

        console.log(
          `${logPrefix} Successfully injected ${result.cookieCount} cookies on domains: ${result.domains.join(', ')}`
        );

        return result;
      } catch (err) {
        lastError = err;
        console.warn(`${logPrefix} Injection attempt ${attempt + 1}/${maxRetries + 1} failed: ${err.message}`);

        if (attempt < maxRetries) {
          // Exponential backoff: 100ms, 200ms, 400ms...
          const delay = 100 * Math.pow(2, attempt);
          console.log(`${logPrefix} Retrying in ${delay}ms...`);
          await new Promise((resolve) => {
            setTimeout(resolve, delay);
          });
        }
      }
    }

    // All retries exhausted
    result.error = lastError?.message || 'Unknown injection error';
    console.error(`${logPrefix} Token injection failed after ${maxRetries + 1} attempts: ${result.error}`);

    return result;
  }

  /**
   * Inject token and register partition in one call
   * Convenience method that combines injection with partition registration
   *
   * @param {string} environment - The IDW environment
   * @param {string} partition - The session partition name
   * @param {object} options - Options passed to injectTokenIntoPartition
   * @returns {Promise<{success: boolean, cookieCount: number, domains: string[], error?: string}>}
   */
  async injectAndRegister(environment, partition, options = {}) {
    // First inject the token
    const result = await this.injectTokenIntoPartition(environment, partition, options);

    // Always register and attach listener (even if injection failed)
    // This ensures future logins get propagated
    const fullPartition = partition.startsWith('persist:') ? partition : `persist:${partition}`;
    this.registerPartition(environment, fullPartition);
    this.attachCookieListener(fullPartition);

    return result;
  }
}

// Singleton instance
const multiTenantStore = new MultiTenantStore();

// Testing support: allow injection of electron session mock
// (CJS require('electron') is not intercepted by Vitest's vi.mock)
multiTenantStore._setElectronSession = function (mock) {
  _electronSession = mock;
};

module.exports = multiTenantStore;
