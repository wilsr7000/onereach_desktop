/**
 * Universal Logger for Onereach.ai
 *
 * Thin producer that pushes all log events onto the central LogEventQueue.
 * Works in both main process and renderer contexts.
 *
 * Usage:
 *   const logger = require('./src/logger');
 *   logger.info('spaces', 'Space created', { spaceId: '123' });
 *   logger.error('agent', 'Agent failed', { error: err.message });
 *   logger.logEvent('video:loaded', { duration: 5.2 });
 *   logger.logUserAction('click', { target: 'save-button' });
 *
 * In main process: pushes directly to LogEventQueue
 * In renderer: pushes via window.logging IPC bridge
 * Fallback: console output if neither available
 */

// Detect environment
const isRenderer = typeof window !== 'undefined' && typeof window.logging !== 'undefined';
const isMain = typeof process !== 'undefined' && process.type !== 'renderer';

// Main process queue reference (lazy-loaded)
let _queue = null;

function _getQueue() {
  if (_queue) return _queue;
  if (isMain) {
    try {
      const { getLogQueue } = require('../lib/log-event-queue');
      _queue = getLogQueue();
    } catch (_e) {
      // Queue not available yet
    }
  }
  return _queue;
}

/**
 * Universal logger that works in both contexts
 */
const logger = {
  /**
   * Log info level message
   * @param {string} category - Event category (e.g., 'spaces', 'agent', 'video')
   * @param {string} message - Human-readable message
   * @param {Object} [data] - Structured data
   */
  info(category, message, data) {
    if (isRenderer && window.logging) {
      window.logging.info(category, message, data);
    } else {
      const q = _getQueue();
      if (q) {
        q.info(category, message, data);
      } else {
        console.log(`[INFO] [${category}]`, message, data || '');
      }
    }
  },

  /**
   * Log warning level message
   */
  warn(category, message, data) {
    if (isRenderer && window.logging) {
      window.logging.warn(category, message, data);
    } else {
      const q = _getQueue();
      if (q) {
        q.warn(category, message, data);
      } else {
        console.warn(`[WARN] [${category}]`, message, data || '');
      }
    }
  },

  /**
   * Log error level message
   */
  error(category, message, data) {
    if (isRenderer && window.logging) {
      window.logging.error(category, message, data);
    } else {
      const q = _getQueue();
      if (q) {
        q.error(category, message, data);
      } else {
        console.error(`[ERROR] [${category}]`, message, data || '');
      }
    }
  },

  /**
   * Log debug level message
   */
  debug(category, message, data) {
    if (isRenderer && window.logging) {
      window.logging.debug(category, message, data);
    } else {
      const q = _getQueue();
      if (q) {
        q.debug(category, message, data);
      } else {
        console.debug(`[DEBUG] [${category}]`, message, data || '');
      }
    }
  },

  /**
   * Log a custom event (convenience wrapper)
   */
  logEvent(eventType, eventData) {
    this.info('app', `Event: ${eventType}`, { event: eventType, ...eventData });
  },

  /**
   * Log user action (convenience wrapper)
   */
  logUserAction(action, details) {
    this.info('user-action', action, details);
  },

  /**
   * Log feature usage (convenience wrapper)
   */
  logFeatureUsed(featureName, metadata) {
    this.info('app', `Feature used: ${featureName}`, { feature: featureName, ...metadata });
  },

  /**
   * Log API error (convenience wrapper)
   */
  logAPIError(endpoint, error, metadata) {
    this.error('api', `API error: ${endpoint}`, {
      endpoint,
      error: error.message || String(error),
      stack: error.stack,
      ...metadata,
    });
  },

  /**
   * Log network request (convenience wrapper)
   */
  logNetworkRequest(method, url, statusCode, duration) {
    this.info('network', `${method} ${url}`, { method, url, statusCode, duration });
  },

  /**
   * Log file operation (convenience wrapper)
   */
  logFileOperation(operation, filePath, metadata) {
    this.info('file', `File ${operation}: ${filePath}`, { operation, filePath, ...metadata });
  },
};

module.exports = logger;
module.exports.default = logger;
