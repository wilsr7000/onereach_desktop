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

const { session } = require('electron');
const { getSettingsManager } = require('./settings-manager');

/**
 * Supported OneReach environments and their domain patterns
 */
const ONEREACH_ENVIRONMENTS = {
  edison: {
    patterns: ['edison.onereach.ai', 'edison.api.onereach.ai'],
    apiDomain: '.edison.api.onereach.ai'
  },
  staging: {
    patterns: ['staging.onereach.ai', 'staging.api.onereach.ai'],
    apiDomain: '.staging.api.onereach.ai'
  },
  production: {
    patterns: ['onereach.ai', 'api.onereach.ai', 'my.onereach.ai'],
    apiDomain: '.api.onereach.ai'
  },
  dev: {
    patterns: ['dev.onereach.ai', 'dev.api.onereach.ai'],
    apiDomain: '.dev.api.onereach.ai'
  }
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
    return normalized === 'onereach.ai' || 
           normalized === 'api.onereach.ai' ||
           normalized.endsWith('.onereach.ai');
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
      capturedAt: Date.now()
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
    return Object.keys(this.tokens).filter(env => this.hasValidToken(env));
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
      capturedAt: Date.now()
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
        _decodedCookieValue: decoded
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
    const targetPartitions = partitions.filter(p => p !== sourcePartition);

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
        const ses = session.fromPartition(partition);
        await ses.cookies.set({
          url: `https://api${broaderDomain}`,
          name: 'or',
          value: token.value,
          domain: broaderDomain,
          secure: token.secure !== false,
          httpOnly: token.httpOnly !== false,
          expirationDate: token.expiresAt
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
        console.log(`[MultiTenant] Loaded mult tokens for: ${Object.keys(this.tokens).join(', ') || 'none'}`);
      }
      
      // Load or tokens
      const savedOr = settingsManager.get('multiTenantOrTokens');
      if (savedOr) {
        this.orTokens = typeof savedOr === 'string' ? JSON.parse(savedOr) : savedOr;
        console.log(`[MultiTenant] Loaded or tokens for: ${Object.keys(this.orTokens).join(', ') || 'none'}`);
      }
    } catch (err) {
      console.error('[MultiTenant] Failed to load tokens:', err.message);
      this.tokens = {};
      this.orTokens = {};
    }
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
    console.log(`[MultiTenant] Registered ${partition} for ${environment} (total: ${this.activePartitions[environment].size})`);
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
    return this.activePartitions[environment] 
      ? Array.from(this.activePartitions[environment]) 
      : [];
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
    
    const ses = session.fromPartition(partitionName);
    
    // Create named handler for removal
    const handler = async (event, cookie, cause, removed) => {
      // SECURITY: Use isValidOneReachDomain() to prevent subdomain attacks
      if (!removed && this.isValidOneReachDomain(cookie.domain)) {
        const environment = this.extractEnvironment(cookie.domain);
        
        // Capture 'mult' (multi-tenant API token)
        if (cookie.name === 'mult') {
          const isRefresh = this.hasToken(environment);
          
          console.log(`[MultiTenant] ${isRefresh ? 'Refreshed' : 'Captured'} ${environment} mult token from ${partitionName}`);
          console.log(`[MultiTenant] Cookie details:`, {
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            sameSite: cookie.sameSite,
            expirationDate: cookie.expirationDate,
            valueLength: cookie.value?.length
          });
          
          await this.setToken(environment, {
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: cookie.sameSite,
            expiresAt: cookie.expirationDate,
            sourcePartition: partitionName
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
          
          console.log(`[MultiTenant] ${hasExisting ? 'Refreshed' : 'Captured'} ${environment} or token from ${partitionName}`);
          
          await this.setOrToken(environment, {
            value: cookie.value,
            domain: cookie.domain,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            expiresAt: cookie.expirationDate,
            sourcePartition: partitionName
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
    const targetPartitions = partitions.filter(p => p !== sourcePartition);
    
    if (targetPartitions.length === 0) {
      console.log(`[MultiTenant] No other partitions to propagate to for ${environment}`);
      return;
    }
    
    // Set re-entrancy guard to prevent loops from cookie listener callbacks
    this.propagating = true;
    
    console.log(`[MultiTenant] Propagating ${environment} token to ${targetPartitions.length} partitions`);
    
    // Use broader domain to cover all subdomains (auth, idw, chat, api)
    const broaderDomain = this.getBroaderDomain(environment);
    
    for (const partition of targetPartitions) {
      try {
        const ses = session.fromPartition(partition);
        
        // Set cookie on broader domain so it's sent to all subdomains
        await ses.cookies.set({
          url: `https://auth${broaderDomain}`,
          name: 'mult',
          value: token.value,
          domain: broaderDomain,
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'no_restriction',
          expirationDate: token.expiresAt
        });
        
        // CRITICAL: Flush to ensure cookie is persisted before any navigation
        await ses.cookies.flushStore();
        
        // Verify cookie was set
        const cookies = await ses.cookies.get({ name: 'mult' });
        console.log(`[MultiTenant] Propagated to ${partition} - ${cookies.length} mult cookies:`, 
          cookies.map(c => ({ domain: c.domain, sameSite: c.sameSite })));
      } catch (err) {
        console.error(`[MultiTenant] Failed to propagate to ${partition}:`, err.message);
        // Don't throw - continue propagating to other partitions
      }
    }
    
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
    
    // Check each environment's patterns
    for (const [env, config] of Object.entries(ONEREACH_ENVIRONMENTS)) {
      for (const pattern of config.patterns) {
        if (lowerDomain.includes(pattern) || lowerDomain.endsWith(pattern)) {
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
   * Get the API domain for an environment (for cookie injection)
   * @param {string} environment - The environment
   * @returns {string} API domain with leading dot
   */
  getApiDomain(environment) {
    return ONEREACH_ENVIRONMENTS[environment]?.apiDomain || '.api.onereach.ai';
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
      dev: '.dev.onereach.ai'
    };
    return domains[environment] || '.onereach.ai';
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
}

// Singleton instance
const multiTenantStore = new MultiTenantStore();

module.exports = multiTenantStore;
