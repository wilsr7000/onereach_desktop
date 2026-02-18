/**
 * Basic Logger for Voice SDK
 *
 * Provides structured logging with levels, timing, and session tracking.
 */

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4,
};

class Logger {
  constructor(options = {}) {
    this.level =
      typeof options.level === 'string'
        ? (LOG_LEVELS[options.level.toUpperCase()] ?? LOG_LEVELS.INFO)
        : (options.level ?? LOG_LEVELS.INFO);

    this.prefix = options.prefix || '[VoiceSDK]';
    this.sessionId = this.generateSessionId();
    this.startTime = Date.now();

    // Performance timers
    this.timers = new Map();

    // Central logging queue sink (optional, set via setSink())
    this._sink = null;
  }

  /**
   * Generate a unique session ID
   */
  generateSessionId() {
    return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  /**
   * Get elapsed time since session start
   */
  getElapsed() {
    return Date.now() - this.startTime;
  }

  /**
   * Set a sink function that forwards logs to the central logging queue.
   * @param {Function} sinkFn - Called with { level, category, message, data }
   */
  setSink(sinkFn) {
    this._sink = typeof sinkFn === 'function' ? sinkFn : null;
  }

  /**
   * Core logging method
   */
  log(level, component, message, data = {}) {
    if (level < this.level) return;

    const elapsed = this.getElapsed();
    const levelName = Object.keys(LOG_LEVELS).find((k) => LOG_LEVELS[k] === level) || 'LOG';

    // Forward to central logging queue if sink is set
    if (this._sink) {
      try {
        this._sink({
          level: levelName.toLowerCase(),
          category: 'voice',
          message: `[${component}] ${message}`,
          data: { component, elapsed, sessionId: this.sessionId, ...data },
        });
      } catch (_e) {
        // Sink errors should not break voice logging
      }
    }

    // Color codes for terminal
    const colors = {
      DEBUG: '\x1b[36m', // Cyan
      INFO: '\x1b[32m', // Green
      WARN: '\x1b[33m', // Yellow
      ERROR: '\x1b[31m', // Red
    };
    const reset = '\x1b[0m';
    const color = colors[levelName] || '';

    const timestamp = `+${elapsed}ms`;
    const prefix = `${color}[${levelName}]${reset} ${timestamp} [${component}]`;

    if (Object.keys(data).length > 0) {
      console.log(`${prefix} ${message}`, data);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }

  /**
   * Log at DEBUG level
   */
  debug(component, message, data) {
    this.log(LOG_LEVELS.DEBUG, component, message, data);
  }

  /**
   * Log at INFO level
   */
  info(component, message, data) {
    this.log(LOG_LEVELS.INFO, component, message, data);
  }

  /**
   * Log at WARN level
   */
  warn(component, message, data) {
    this.log(LOG_LEVELS.WARN, component, message, data);
  }

  /**
   * Log at ERROR level
   */
  error(component, message, data) {
    this.log(LOG_LEVELS.ERROR, component, message, data);
  }

  /**
   * Start a performance timer
   */
  startTimer(name) {
    this.timers.set(name, {
      start: performance.now(),
      marks: [],
    });
    this.debug('Timer', `Started: ${name}`);
  }

  /**
   * Add a mark to a running timer
   */
  markTimer(name, label) {
    const timer = this.timers.get(name);
    if (timer) {
      const elapsed = performance.now() - timer.start;
      timer.marks.push({ label, elapsed });
      this.debug('Timer', `${name} - ${label}: ${elapsed.toFixed(2)}ms`);
    }
  }

  /**
   * End a timer and get total time
   */
  endTimer(name) {
    const timer = this.timers.get(name);
    if (timer) {
      const total = performance.now() - timer.start;
      this.info('Timer', `${name} completed in ${total.toFixed(2)}ms`, {
        marks: timer.marks,
      });
      this.timers.delete(name);
      return total;
    }
    return null;
  }

  /**
   * Set log level dynamically
   */
  setLevel(level) {
    if (typeof level === 'string') {
      this.level = LOG_LEVELS[level.toUpperCase()] ?? LOG_LEVELS.INFO;
    } else {
      this.level = level;
    }
    this.info('Logger', `Log level set to ${Object.keys(LOG_LEVELS).find((k) => LOG_LEVELS[k] === this.level)}`);
  }

  /**
   * Get session info
   */
  getSessionInfo() {
    return {
      sessionId: this.sessionId,
      startTime: this.startTime,
      elapsed: this.getElapsed(),
      level: Object.keys(LOG_LEVELS).find((k) => LOG_LEVELS[k] === this.level),
    };
  }
}

// Singleton instance
let loggerInstance = null;

/**
 * Get the singleton logger instance
 */
function getLogger(options) {
  if (!loggerInstance) {
    loggerInstance = new Logger(options);
  }
  return loggerInstance;
}

/**
 * Create a new logger (for testing)
 */
function createLogger(options) {
  return new Logger(options);
}

module.exports = {
  Logger,
  LOG_LEVELS,
  getLogger,
  createLogger,
};
