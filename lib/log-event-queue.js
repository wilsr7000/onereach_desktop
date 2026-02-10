/**
 * Central Logging Event Queue
 * 
 * ALL logging in the app flows through this queue via enqueue().
 * Built-in consumers handle storage, buffering, and statistics.
 * External consumers (WebSocket server, IPC broadcaster) subscribe to events.
 * 
 * Usage (main process):
 *   const { getLogQueue } = require('./lib/log-event-queue');
 *   const log = getLogQueue();
 *   log.info('spaces', 'Space created', { spaceId: '123' });
 *   log.error('agent', 'Agent failed', { error: err.message });
 * 
 * Usage (renderer via IPC):
 *   window.logging.info('video', 'Frame rendered', { frame: 42 });
 * 
 * Usage (external via REST):
 *   POST http://127.0.0.1:47292/logs { level, category, message, data }
 * 
 * Usage (external via WebSocket):
 *   ws://127.0.0.1:47292/ws -> { type: 'subscribe', filter: { level: 'error' } }
 */

const EventEmitter = require('events');

// Valid log levels (ordered by severity)
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

// Valid categories
const CATEGORIES = [
  'app', 'agent', 'voice', 'video', 'spaces', 'clipboard',
  'network', 'api', 'ipc', 'window', 'performance', 'user-action',
  'recorder', 'settings', 'menu', 'file', 'module', 'external',
  'task-exchange', 'test'
];

class LogEventQueue extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);

    // App version -- stamped on every log entry so old/new logs are distinguishable
    try {
      this._appVersion = require('../../package.json').version;
    } catch (e) {
      try {
        this._appVersion = require('../package.json').version;
      } catch (e2) {
        this._appVersion = 'unknown';
      }
    }

    // Ring buffer for fast in-memory queries
    this._ringBuffer = [];
    this._maxRingSize = 10000;

    // Stats collector
    this._stats = {
      total: 0,
      byLevel: { debug: 0, info: 0, warn: 0, error: 0 },
      byCategory: {},
      recentErrors: [],       // sliding window of error timestamps
      startedAt: new Date().toISOString()
    };

    // File writer reference (lazy-loaded to avoid circular deps)
    this._fileWriter = null;
    this._fileWriterFailed = false;

    // Filtered subscriptions
    this._subscriptions = new Map(); // handler -> filter

    // Minimum log level (configurable)
    this._minLevel = 'debug';

    // Initialize built-in consumers
    this._initConsumers();
  }

  // ==========================================================================
  // PRODUCER API -- What callers use to log events
  // ==========================================================================

  /**
   * Push an event onto the queue. This is the core method -- all logging flows here.
   * @param {Object} event - { level, category, message, data, source, timestamp }
   * @returns {Object} The normalized log entry
   */
  enqueue(event) {
    if (!event || typeof event !== 'object') return null;

    const level = (event.level || 'info').toLowerCase();

    // Skip if below minimum level
    if (LOG_LEVELS[level] === undefined || LOG_LEVELS[level] < LOG_LEVELS[this._minLevel]) {
      return null;
    }

    const entry = {
      id: this._generateId(),
      timestamp: event.timestamp || new Date().toISOString(),
      level,
      category: event.category || 'app',
      message: typeof event.message === 'string' ? event.message : String(event.message || ''),
      source: event.source || 'main',
      data: event.data || {},
      v: this._appVersion
    };

    // Emit to all consumers
    this.emit('event', entry);

    // Emit to filtered subscriptions
    for (const [handler, filter] of this._subscriptions) {
      if (this._matchesFilter(entry, filter)) {
        try {
          handler(entry);
        } catch (err) {
          // Don't let subscriber errors break the queue
        }
      }
    }

    return entry;
  }

  /**
   * Log an info-level event
   * @param {string} category - Event category (e.g., 'spaces', 'agent', 'video')
   * @param {string} message - Human-readable message
   * @param {Object} [data] - Structured data
   * @returns {Object} The log entry
   */
  info(category, message, data) {
    return this.enqueue({ level: 'info', category, message, data });
  }

  /**
   * Log a warning-level event
   */
  warn(category, message, data) {
    return this.enqueue({ level: 'warn', category, message, data });
  }

  /**
   * Log an error-level event
   */
  error(category, message, data) {
    return this.enqueue({ level: 'error', category, message, data });
  }

  /**
   * Log a debug-level event
   */
  debug(category, message, data) {
    return this.enqueue({ level: 'debug', category, message, data });
  }

  // ==========================================================================
  // CONSUMER API -- For reading, querying, and subscribing to events
  // ==========================================================================

  /**
   * Query the ring buffer (and optionally file-backed logs) for events.
   * @param {Object} opts - Query options
   * @param {string} [opts.level] - Filter by level
   * @param {string} [opts.category] - Filter by category
   * @param {string} [opts.source] - Filter by source
   * @param {string} [opts.search] - Search in message text
   * @param {string} [opts.since] - ISO timestamp lower bound
   * @param {string} [opts.until] - ISO timestamp upper bound
   * @param {number} [opts.limit=100] - Max results
   * @param {number} [opts.offset=0] - Skip N results
   * @returns {Array} Matching log entries (newest first)
   */
  query(opts = {}) {
    const { level, category, source, search, since, until, limit = 100, offset = 0 } = opts;

    let results = [...this._ringBuffer].reverse(); // newest first

    if (level) {
      results = results.filter(e => e.level === level);
    }
    if (category) {
      results = results.filter(e => e.category === category);
    }
    if (source) {
      results = results.filter(e => e.source === source);
    }
    if (search) {
      const term = search.toLowerCase();
      results = results.filter(e =>
        e.message.toLowerCase().includes(term) ||
        JSON.stringify(e.data).toLowerCase().includes(term)
      );
    }
    if (since) {
      const sinceDate = new Date(since);
      results = results.filter(e => new Date(e.timestamp) >= sinceDate);
    }
    if (until) {
      const untilDate = new Date(until);
      results = results.filter(e => new Date(e.timestamp) <= untilDate);
    }

    return results.slice(offset, offset + limit);
  }

  /**
   * Subscribe to real-time events with an optional filter.
   * @param {Object} filter - { level, category, source }
   * @param {Function} handler - Called with each matching entry
   * @returns {Function} Unsubscribe function
   */
  subscribe(filter, handler) {
    if (typeof filter === 'function') {
      handler = filter;
      filter = {};
    }
    this._subscriptions.set(handler, filter || {});
    return () => this._subscriptions.delete(handler);
  }

  /**
   * Remove a subscription
   */
  unsubscribe(handler) {
    this._subscriptions.delete(handler);
  }

  /**
   * Get aggregated statistics
   */
  getStats() {
    // Calculate errors per minute (last 5 minutes)
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const recentErrorCount = this._stats.recentErrors.filter(t => t > fiveMinAgo).length;

    return {
      total: this._stats.total,
      byLevel: { ...this._stats.byLevel },
      byCategory: { ...this._stats.byCategory },
      errorsPerMinute: Math.round((recentErrorCount / 5) * 100) / 100,
      ringBufferSize: this._ringBuffer.length,
      ringBufferCapacity: this._maxRingSize,
      subscriberCount: this._subscriptions.size,
      startedAt: this._stats.startedAt,
      minLevel: this._minLevel
    };
  }

  /**
   * Export logs. Reads from file-backed storage for full history.
   * @param {Object} opts - { since, until, level, category, format: 'json'|'text' }
   * @returns {Promise<Array|string>} Log entries or text
   */
  async export(opts = {}) {
    const { format = 'json' } = opts;

    // Try to get logs from file writer (event-logger)
    const fileWriter = this._getFileWriter();
    if (fileWriter && typeof fileWriter.exportLogs === 'function') {
      try {
        const exported = await fileWriter.exportLogs({
          startDate: opts.since ? new Date(opts.since) : new Date(Date.now() - 24 * 60 * 60 * 1000),
          endDate: opts.until ? new Date(opts.until) : new Date(),
          includeDebug: true,
          format
        });
        return exported;
      } catch (err) {
        // Fall back to ring buffer
      }
    }

    // Fallback: return ring buffer contents
    const results = this.query(opts);
    if (format === 'text') {
      return results.map(e =>
        `[${e.timestamp}] ${e.level.toUpperCase()} [${e.category}] ${e.message} ${JSON.stringify(e.data)}`
      ).join('\n');
    }
    return results;
  }

  /**
   * Set the minimum log level
   * @param {string} level - 'debug' | 'info' | 'warn' | 'error'
   */
  setMinLevel(level) {
    if (LOG_LEVELS[level] !== undefined) {
      this._minLevel = level;
    }
  }

  /**
   * Get recent log entries (convenience, delegates to query)
   */
  getRecentLogs(count = 100) {
    return this.query({ limit: count });
  }

  /**
   * Get log files info from the file writer
   */
  getLogFiles() {
    const fw = this._getFileWriter();
    return fw && typeof fw.getLogFiles === 'function' ? fw.getLogFiles() : [];
  }

  // ==========================================================================
  // BUILT-IN CONSUMERS (private)
  // ==========================================================================

  _initConsumers() {
    // 1. Ring Buffer -- keeps last N events in memory for fast queries
    this.on('event', (entry) => {
      this._ringBuffer.push(entry);
      if (this._ringBuffer.length > this._maxRingSize) {
        this._ringBuffer.shift();
      }
    });

    // 2. Stats Collector -- maintains counts and rates
    this.on('event', (entry) => {
      this._stats.total++;
      this._stats.byLevel[entry.level] = (this._stats.byLevel[entry.level] || 0) + 1;
      this._stats.byCategory[entry.category] = (this._stats.byCategory[entry.category] || 0) + 1;

      // Track error timestamps for rate calculation
      if (entry.level === 'error') {
        this._stats.recentErrors.push(Date.now());
        // Keep only last 5 minutes of error timestamps
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;
        this._stats.recentErrors = this._stats.recentErrors.filter(t => t > fiveMinAgo);
      }
    });

    // 3. File Writer -- delegates to event-logger.js for disk persistence
    this.on('event', (entry) => {
      try {
        const fw = this._getFileWriter();
        if (fw && typeof fw.log === 'function') {
          fw.log(entry.level, entry.message, {
            category: entry.category,
            source: entry.source,
            ...entry.data
          });
        }
      } catch (err) {
        // File writer errors should not break the queue
      }
    });
  }

  // ==========================================================================
  // INTERNAL HELPERS
  // ==========================================================================

  /**
   * Lazy-load the file writer (event-logger) to avoid circular deps
   */
  _getFileWriter() {
    if (this._fileWriter) return this._fileWriter;
    if (this._fileWriterFailed) return null;

    try {
      // Check if we're in an Electron main process
      const electron = require('electron');
      if (!electron.app || !electron.app.isReady()) {
        return null;
      }
      const getLogger = require('../event-logger');
      this._fileWriter = getLogger();
      return this._fileWriter;
    } catch (err) {
      this._fileWriterFailed = true;
      return null;
    }
  }

  /**
   * Check if an entry matches a subscription filter
   */
  _matchesFilter(entry, filter) {
    if (!filter || Object.keys(filter).length === 0) return true;
    if (filter.level && entry.level !== filter.level) return false;
    if (filter.category && entry.category !== filter.category) return false;
    if (filter.source && entry.source !== filter.source) return false;
    if (filter.minLevel && LOG_LEVELS[entry.level] < LOG_LEVELS[filter.minLevel]) return false;
    return true;
  }

  /**
   * Generate a unique event ID
   */
  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 7);
  }

  /**
   * Clean up resources
   */
  destroy() {
    this.removeAllListeners();
    this._subscriptions.clear();
    this._ringBuffer = [];
  }
}

// ==========================================================================
// SINGLETON
// ==========================================================================

let instance = null;

/**
 * Get the singleton LogEventQueue instance
 * @returns {LogEventQueue}
 */
function getLogQueue() {
  if (!instance) {
    instance = new LogEventQueue();
  }
  return instance;
}

// Export both the class and the singleton getter
module.exports = { LogEventQueue, getLogQueue, LOG_LEVELS, CATEGORIES };
