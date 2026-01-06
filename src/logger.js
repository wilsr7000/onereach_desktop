/**
 * Universal Logger for Onereach.ai
 * Works in both main process and renderer contexts
 * 
 * Usage:
 *   const logger = require('./logger'); // or import logger from './logger'
 *   logger.info('Message', { key: 'value' });
 *   logger.error('Error occurred', { error: err.message });
 *   logger.logFeatureUsed('feature-name', { action: 'init' });
 * 
 * In main process: Uses event-logger directly
 * In renderer: Uses window.api.log via IPC
 * Fallback: Console output if neither available
 */

// Detect environment
const isRenderer = typeof window !== 'undefined' && window.api;
const isMain = typeof process !== 'undefined' && process.type !== 'renderer';

// Main process logger instance
let mainLogger = null;

/**
 * Get the main process logger (lazy initialization)
 */
function getMainLogger() {
  if (!mainLogger && isMain) {
    try {
      const getLogger = require('../event-logger');
      mainLogger = getLogger();
    } catch (e) {
      // event-logger not available
      console.warn('[Logger] Main process logger not available:', e.message);
    }
  }
  return mainLogger;
}

/**
 * Universal logger that works in both contexts
 */
const logger = {
  /**
   * Log info level message
   * @param {string} message - Log message
   * @param {Object} data - Additional data
   */
  info(message, data = {}) {
    if (isRenderer && window.api && window.api.log) {
      window.api.log.info(message, data);
    } else if (isMain) {
      const l = getMainLogger();
      if (l && l.info) {
        l.info(message, data);
      } else {
        console.log('[INFO]', message, data);
      }
    } else {
      console.log('[INFO]', message, data);
    }
  },

  /**
   * Log warning level message
   * @param {string} message - Log message
   * @param {Object} data - Additional data
   */
  warn(message, data = {}) {
    if (isRenderer && window.api && window.api.log) {
      window.api.log.warn(message, data);
    } else if (isMain) {
      const l = getMainLogger();
      if (l && l.warn) {
        l.warn(message, data);
      } else {
        console.warn('[WARN]', message, data);
      }
    } else {
      console.warn('[WARN]', message, data);
    }
  },

  /**
   * Log error level message
   * @param {string} message - Log message
   * @param {Object} data - Additional data (include error.message and stack)
   */
  error(message, data = {}) {
    if (isRenderer && window.api && window.api.log) {
      window.api.log.error(message, data);
    } else if (isMain) {
      const l = getMainLogger();
      if (l && l.error) {
        l.error(message, data);
      } else {
        console.error('[ERROR]', message, data);
      }
    } else {
      console.error('[ERROR]', message, data);
    }
  },

  /**
   * Log debug level message
   * @param {string} message - Log message
   * @param {Object} data - Additional data
   */
  debug(message, data = {}) {
    if (isRenderer && window.api && window.api.log) {
      window.api.log.debug(message, data);
    } else if (isMain) {
      const l = getMainLogger();
      if (l && l.debug) {
        l.debug(message, data);
      } else {
        console.debug('[DEBUG]', message, data);
      }
    } else {
      console.debug('[DEBUG]', message, data);
    }
  },

  /**
   * Log a custom event
   * @param {string} eventType - Event type (e.g., 'video:loaded')
   * @param {Object} eventData - Event data
   */
  logEvent(eventType, eventData = {}) {
    if (isRenderer && window.api && window.api.log) {
      window.api.log.event(eventType, eventData);
    } else if (isMain) {
      const l = getMainLogger();
      if (l && l.logEvent) {
        l.logEvent(eventType, eventData);
      } else {
        console.log('[EVENT]', eventType, eventData);
      }
    } else {
      console.log('[EVENT]', eventType, eventData);
    }
  },

  /**
   * Log user action
   * @param {string} action - Action name
   * @param {Object} details - Action details
   */
  logUserAction(action, details = {}) {
    if (isRenderer && window.api && window.api.log) {
      window.api.log.userAction(action, details);
    } else if (isMain) {
      const l = getMainLogger();
      if (l && l.logUserAction) {
        l.logUserAction(action, details);
      } else {
        console.log('[USER_ACTION]', action, details);
      }
    } else {
      console.log('[USER_ACTION]', action, details);
    }
  },

  /**
   * Log feature usage
   * @param {string} featureName - Feature name
   * @param {Object} metadata - Feature metadata
   */
  logFeatureUsed(featureName, metadata = {}) {
    if (isRenderer && window.api && window.api.logFeatureUsed) {
      window.api.logFeatureUsed(featureName, metadata);
    } else if (isMain) {
      const l = getMainLogger();
      if (l && l.logFeatureUsed) {
        l.logFeatureUsed(featureName, metadata);
      } else {
        console.log('[FEATURE]', featureName, metadata);
      }
    } else {
      console.log('[FEATURE]', featureName, metadata);
    }
  },

  /**
   * Log API error
   * @param {string} endpoint - API endpoint
   * @param {Error|Object} error - Error object or message
   * @param {Object} metadata - Additional metadata
   */
  logAPIError(endpoint, error, metadata = {}) {
    const errorData = {
      endpoint,
      error: error.message || String(error),
      stack: error.stack,
      ...metadata
    };
    
    if (isRenderer && window.api && window.api.log) {
      window.api.log.error('API Error', errorData);
    } else if (isMain) {
      const l = getMainLogger();
      if (l && l.logAPIError) {
        l.logAPIError(endpoint, error, metadata);
      } else {
        console.error('[API_ERROR]', endpoint, errorData);
      }
    } else {
      console.error('[API_ERROR]', endpoint, errorData);
    }
  },

  /**
   * Log network request
   * @param {string} method - HTTP method
   * @param {string} url - Request URL
   * @param {number} statusCode - Response status code
   * @param {number} duration - Request duration in ms
   */
  logNetworkRequest(method, url, statusCode, duration) {
    const data = { method, url, statusCode, duration };
    
    if (isRenderer && window.api && window.api.log) {
      window.api.log.info('Network Request', { event: 'network:request', ...data });
    } else if (isMain) {
      const l = getMainLogger();
      if (l && l.logNetworkRequest) {
        l.logNetworkRequest(method, url, statusCode, duration);
      } else {
        console.log('[NETWORK]', data);
      }
    } else {
      console.log('[NETWORK]', data);
    }
  },

  /**
   * Log file operation
   * @param {string} operation - Operation type (read, write, delete, etc.)
   * @param {string} filePath - File path
   * @param {Object} metadata - Additional metadata
   */
  logFileOperation(operation, filePath, metadata = {}) {
    const data = { operation, filePath, ...metadata };
    
    if (isRenderer && window.api && window.api.log) {
      window.api.log.info('File Operation', { event: 'file:operation', ...data });
    } else if (isMain) {
      const l = getMainLogger();
      if (l && l.logFileOperation) {
        l.logFileOperation(operation, filePath, metadata);
      } else {
        console.log('[FILE]', data);
      }
    } else {
      console.log('[FILE]', data);
    }
  }
};

// Export for both CommonJS and ES modules
module.exports = logger;
module.exports.default = logger;






