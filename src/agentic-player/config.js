/**
 * Agentic Player Configuration
 * @module src/agentic-player/config
 */

/**
 * Default configuration
 */
export const defaultConfig = {
  apiEndpoint: null,
  apiKey: null,
  apiHeaders: {},
  context: {},
  prefetchWhenRemaining: 2,  // Fetch more when this many clips left
  prefetchThreshold: 5,      // Seconds before clip end to check queue
  debugMode: false           // Enable verbose logging
};

/**
 * Load configuration from window object
 * @returns {Object} Configuration
 */
export function loadConfig() {
  const cfg = window.AGENTIC_PLAYER_CONFIG || {};
  return {
    apiEndpoint: cfg.apiEndpoint || defaultConfig.apiEndpoint,
    apiKey: cfg.apiKey || defaultConfig.apiKey,
    apiHeaders: cfg.apiHeaders || defaultConfig.apiHeaders,
    context: cfg.context || defaultConfig.context,
    prefetchWhenRemaining: cfg.prefetchWhenRemaining || defaultConfig.prefetchWhenRemaining,
    prefetchThreshold: cfg.prefetchThreshold || defaultConfig.prefetchThreshold,
    debugMode: cfg.debugMode || defaultConfig.debugMode
  };
}
















