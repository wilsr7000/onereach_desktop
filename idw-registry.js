/**
 * IDW Registry - Centralized tracking system for IDW environments and tabs
 * Provides reliable tracking of which IDWs are open in which tabs
 */

class IDWRegistry {
    constructor() {
        this.environments = [];  // All configured IDW environments
        this.tabToIDW = new Map();  // Tab ID -> IDW ID mapping
        this.idwToTab = new Map();  // IDW ID -> Tab ID mapping
        this.initialized = false;
    }

    /**
     * Initialize the registry with IDW environments
     * @param {Array} environments - Array of IDW environment configs
     */
    initialize(environments) {
        console.log('[IDWRegistry] Initializing with', environments?.length || 0, 'environments');
        this.environments = environments || [];
        this.validateEnvironments();
        this.initialized = true;
    }

    /**
     * Validate and normalize IDW environment data
     */
    validateEnvironments() {
        this.environments = this.environments.map(env => {
            // Ensure each environment has required fields
            if (!env.id) {
                console.warn('[IDWRegistry] Environment missing ID:', env);
                return null;
            }
            
            return {
                id: env.id,
                label: env.label || env.id,
                environment: env.environment || 'unknown',
                homeUrl: this.normalizeURL(env.homeUrl),
                chatUrl: this.normalizeURL(env.chatUrl),
                type: env.type || 'idw',
                originalData: env
            };
        }).filter(Boolean);
    }

    /**
     * Normalize URL for consistent comparison
     * @param {string} url - URL to normalize
     * @returns {string} Normalized URL
     */
    normalizeURL(url) {
        if (!url) return '';
        
        try {
            const u = new URL(url);
            // Remove trailing slashes from pathname
            u.pathname = u.pathname.replace(/\/+$/, '');
            // Remove common tracking parameters
            u.searchParams.delete('utm_source');
            u.searchParams.delete('utm_medium');
            u.searchParams.delete('utm_campaign');
            u.searchParams.delete('ref');
            // Return canonical form
            return u.origin + u.pathname + (u.search ? u.search : '');
        } catch (e) {
            // If URL parsing fails, just clean it up
            return url.toLowerCase().replace(/\/+$/, '');
        }
    }

    /**
     * Detect which IDW (if any) a URL belongs to
     * @param {string} url - URL to check
     * @returns {Object|null} IDW environment or null
     */
    detectIDWFromURL(url) {
        if (!url) return null;
        
        const normalizedUrl = this.normalizeURL(url);
        console.log('[IDWRegistry] Detecting IDW for URL:', normalizedUrl);
        
        for (const env of this.environments) {
            if (this.isURLForIDW(normalizedUrl, env)) {
                console.log('[IDWRegistry] Matched IDW:', env.id);
                return env;
            }
        }
        
        console.log('[IDWRegistry] No IDW match found');
        return null;
    }

    /**
     * Check if a URL belongs to a specific IDW
     * @param {string} url - Normalized URL to check
     * @param {Object} idwEnv - IDW environment to check against
     * @returns {boolean} True if URL belongs to this IDW
     */
    isURLForIDW(url, idwEnv) {
        // Direct URL matches
        if (url === idwEnv.homeUrl || url === idwEnv.chatUrl) {
            return true;
        }
        
        // Check if URL starts with the IDW URLs (handles sub-paths)
        if (idwEnv.homeUrl && url.startsWith(idwEnv.homeUrl)) {
            return true;
        }
        if (idwEnv.chatUrl && url.startsWith(idwEnv.chatUrl)) {
            return true;
        }
        
        // Pattern-based matching for common IDW URL formats
        const patterns = this.getIDWURLPatterns(idwEnv);
        for (const pattern of patterns) {
            if (this.matchesPattern(url, pattern)) {
                return true;
            }
        }
        
        return false;
    }

    /**
     * Generate URL patterns for an IDW
     * @param {Object} idwEnv - IDW environment
     * @returns {Array<string>} Array of URL patterns
     */
    getIDWURLPatterns(idwEnv) {
        const patterns = [];
        
        // Common IDW URL patterns
        if (idwEnv.environment && idwEnv.id) {
            patterns.push(
                `https://idw.${idwEnv.environment}.onereach.ai/${idwEnv.id}`,
                `https://chat.${idwEnv.environment}.onereach.ai/*/${idwEnv.id}`,
                `https://${idwEnv.environment}.onereach.ai/idw/${idwEnv.id}`
            );
        }
        
        // Handle staging/production variations
        if (idwEnv.environment === 'staging' && idwEnv.id) {
            patterns.push(
                `https://chat.staging.onereach.ai/*/${idwEnv.id}`
            );
        }
        
        return patterns;
    }

    /**
     * Check if URL matches a pattern (supports wildcards)
     * @param {string} url - URL to check
     * @param {string} pattern - Pattern with optional wildcards (*)
     * @returns {boolean} True if matches
     */
    matchesPattern(url, pattern) {
        // Convert pattern to regex
        const regexPattern = pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // Escape special chars
            .replace(/\*/g, '.*');  // Replace * with .*
        
        const regex = new RegExp('^' + regexPattern + '$', 'i');
        return regex.test(url);
    }

    /**
     * Register a tab as containing an IDW
     * @param {string} tabId - Tab ID
     * @param {string} idwId - IDW ID
     * @param {Object} metadata - Additional metadata to store
     */
    registerTab(tabId, idwId, metadata = {}) {
        console.log(`[IDWRegistry] Registering tab ${tabId} with IDW ${idwId}`);
        
        // Unregister any previous IDW for this tab
        if (this.tabToIDW.has(tabId)) {
            const oldIDW = this.tabToIDW.get(tabId);
            if (oldIDW !== idwId) {
                this.idwToTab.delete(oldIDW);
            }
        }
        
        // Unregister any previous tab for this IDW
        if (this.idwToTab.has(idwId)) {
            const oldTab = this.idwToTab.get(idwId);
            if (oldTab !== tabId) {
                this.tabToIDW.delete(oldTab);
            }
        }
        
        // Register the new association
        this.tabToIDW.set(tabId, idwId);
        this.idwToTab.set(idwId, tabId);
        
        // Store metadata if needed
        if (metadata) {
            this.storeTabMetadata(tabId, { idwId, ...metadata });
        }
        
        this.saveState();
    }

    /**
     * Unregister a tab
     * @param {string} tabId - Tab ID to unregister
     */
    unregisterTab(tabId) {
        console.log(`[IDWRegistry] Unregistering tab ${tabId}`);
        
        const idwId = this.tabToIDW.get(tabId);
        if (idwId) {
            this.tabToIDW.delete(tabId);
            this.idwToTab.delete(idwId);
            this.clearTabMetadata(tabId);
            this.saveState();
        }
    }

    /**
     * Update tab's IDW based on current URL
     * @param {string} tabId - Tab ID
     * @param {string} url - Current URL of the tab
     * @returns {Object|null} New IDW if changed, null otherwise
     */
    updateTabURL(tabId, url) {
        const currentIDW = this.tabToIDW.get(tabId);
        const newIDW = this.detectIDWFromURL(url);
        
        if (newIDW?.id !== currentIDW) {
            console.log(`[IDWRegistry] Tab ${tabId} IDW changed from ${currentIDW} to ${newIDW?.id}`);
            
            if (currentIDW) {
                this.unregisterTab(tabId);
            }
            
            if (newIDW) {
                this.registerTab(tabId, newIDW.id, newIDW);
            }
            
            return newIDW;
        }
        
        return null;
    }

    /**
     * Check if an IDW is currently open in any tab
     * @param {string} idwId - IDW ID to check
     * @returns {boolean} True if IDW is open
     */
    isIDWOpen(idwId) {
        return this.idwToTab.has(idwId);
    }

    /**
     * Get the tab ID for an open IDW
     * @param {string} idwId - IDW ID
     * @returns {string|null} Tab ID or null if not open
     */
    getTabForIDW(idwId) {
        return this.idwToTab.get(idwId) || null;
    }

    /**
     * Get the IDW ID for a tab
     * @param {string} tabId - Tab ID
     * @returns {string|null} IDW ID or null if not an IDW tab
     */
    getIDWForTab(tabId) {
        return this.tabToIDW.get(tabId) || null;
    }

    /**
     * Get all available IDWs (not currently open)
     * @returns {Array} Array of available IDW environments
     */
    getAvailableIDWs() {
        return this.environments.filter(env => !this.isIDWOpen(env.id));
    }

    /**
     * Get all open IDWs
     * @returns {Array} Array of open IDW IDs
     */
    getOpenIDWs() {
        return Array.from(this.idwToTab.keys());
    }

    /**
     * Store additional metadata for a tab
     * @param {string} tabId - Tab ID
     * @param {Object} metadata - Metadata to store
     */
    storeTabMetadata(tabId, metadata) {
        if (typeof window !== 'undefined' && window.localStorage) {
            const key = `idw_tab_meta_${tabId}`;
            localStorage.setItem(key, JSON.stringify(metadata));
        }
    }

    /**
     * Get metadata for a tab
     * @param {string} tabId - Tab ID
     * @returns {Object|null} Metadata or null
     */
    getTabMetadata(tabId) {
        if (typeof window !== 'undefined' && window.localStorage) {
            const key = `idw_tab_meta_${tabId}`;
            const data = localStorage.getItem(key);
            return data ? JSON.parse(data) : null;
        }
        return null;
    }

    /**
     * Clear metadata for a tab
     * @param {string} tabId - Tab ID
     */
    clearTabMetadata(tabId) {
        if (typeof window !== 'undefined' && window.localStorage) {
            const key = `idw_tab_meta_${tabId}`;
            localStorage.removeItem(key);
        }
    }

    /**
     * Save registry state to localStorage
     */
    saveState() {
        if (typeof window !== 'undefined' && window.localStorage) {
            const state = {
                tabToIDW: Array.from(this.tabToIDW.entries()),
                idwToTab: Array.from(this.idwToTab.entries()),
                timestamp: Date.now()
            };
            localStorage.setItem('idw_registry_state', JSON.stringify(state));
        }
    }

    /**
     * Restore registry state from localStorage
     */
    restoreState() {
        if (typeof window !== 'undefined' && window.localStorage) {
            const data = localStorage.getItem('idw_registry_state');
            if (data) {
                try {
                    const state = JSON.parse(data);
                    this.tabToIDW = new Map(state.tabToIDW);
                    this.idwToTab = new Map(state.idwToTab);
                    console.log('[IDWRegistry] Restored state with', this.tabToIDW.size, 'tab associations');
                } catch (e) {
                    console.error('[IDWRegistry] Failed to restore state:', e);
                }
            }
        }
    }

    /**
     * Clear all registry data
     */
    clear() {
        this.tabToIDW.clear();
        this.idwToTab.clear();
        this.environments = [];
        this.initialized = false;
        
        // Clear localStorage
        if (typeof window !== 'undefined' && window.localStorage) {
            const keys = Object.keys(localStorage);
            keys.forEach(key => {
                if (key.startsWith('idw_tab_meta_') || key === 'idw_registry_state') {
                    localStorage.removeItem(key);
                }
            });
        }
    }

    /**
     * Get debug information about the registry state
     * @returns {Object} Debug info
     */
    getDebugInfo() {
        return {
            initialized: this.initialized,
            environmentCount: this.environments.length,
            openTabs: this.tabToIDW.size,
            openIDWs: this.idwToTab.size,
            availableIDWs: this.getAvailableIDWs().length,
            tabMappings: Array.from(this.tabToIDW.entries()),
            idwMappings: Array.from(this.idwToTab.entries())
        };
    }
}

// Export for use in browser environment
if (typeof module !== 'undefined' && module.exports) {
    module.exports = IDWRegistry;
} else if (typeof window !== 'undefined') {
    window.IDWRegistry = IDWRegistry;
}
