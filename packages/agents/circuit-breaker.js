/**
 * Circuit Breaker
 *
 * Prevents cascading failures when external services are down.
 * After N failures within a time window, the circuit "opens" and fails fast.
 *
 * States:
 * - CLOSED: Normal operation, requests flow through
 * - OPEN: Failing fast, no requests sent
 * - HALF_OPEN: Testing if service recovered
 */

const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

const STATES = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
};

class CircuitBreaker {
  /**
   * Create a circuit breaker
   * @param {Object} options
   * @param {string} options.name - Name for logging
   * @param {number} options.failureThreshold - Failures before opening (default 3)
   * @param {number} options.resetTimeout - Ms before trying half-open (default 30000)
   * @param {number} options.windowMs - Time window for counting failures (default 60000)
   */
  constructor(options = {}) {
    this.name = options.name || 'CircuitBreaker';
    this.failureThreshold = options.failureThreshold || 3;
    this.resetTimeout = options.resetTimeout || 30000;
    this.windowMs = options.windowMs || 60000;

    this.state = STATES.CLOSED;
    this.failures = [];
    this.lastFailureTime = null;
    this.openedAt = null;

    // Stats
    this.stats = {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      rejectedCalls: 0,
    };
  }

  /**
   * Execute a function through the circuit breaker
   * @param {Function} fn - Async function to execute
   * @returns {Promise<*>} - Result of fn or throws
   */
  async execute(fn) {
    this.stats.totalCalls++;

    // Check if we should try half-open
    if (this.state === STATES.OPEN) {
      if (this.shouldAttemptReset()) {
        this.state = STATES.HALF_OPEN;
        log.info('agent', `[${this.name}] Circuit half-open, testing...`);
      } else {
        this.stats.rejectedCalls++;
        throw new CircuitOpenError(this.name, this.getRemainingOpenTime());
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  /**
   * Record a successful call
   */
  onSuccess() {
    this.stats.successfulCalls++;

    if (this.state === STATES.HALF_OPEN) {
      // Success in half-open means we're recovered
      log.info('agent', `[${this.name}] Circuit closed (recovered)`);
      this.state = STATES.CLOSED;
      this.failures = [];
      this.openedAt = null;
    }
  }

  /**
   * Record a failed call
   * @param {Error} error
   */
  onFailure(_error) {
    this.stats.failedCalls++;
    const now = Date.now();

    // Add failure to window
    this.failures.push(now);
    this.lastFailureTime = now;

    // Clean old failures outside window
    this.failures = this.failures.filter((t) => now - t < this.windowMs);

    if (this.state === STATES.HALF_OPEN) {
      // Failure in half-open means still broken
      log.info('agent', `[${this.name}] Circuit re-opened (still failing)`);
      this.state = STATES.OPEN;
      this.openedAt = now;
    } else if (this.state === STATES.CLOSED && this.failures.length >= this.failureThreshold) {
      // Too many failures, open circuit
      log.info('agent', `[${this.name}] Circuit opened after ${this.failures.length} failures`);
      this.state = STATES.OPEN;
      this.openedAt = now;
    }
  }

  /**
   * Check if we should attempt to reset (half-open)
   * @returns {boolean}
   */
  shouldAttemptReset() {
    if (!this.openedAt) return true;
    return Date.now() - this.openedAt >= this.resetTimeout;
  }

  /**
   * Get remaining time circuit will stay open
   * @returns {number} - Ms remaining, or 0 if should reset
   */
  getRemainingOpenTime() {
    if (!this.openedAt) return 0;
    const elapsed = Date.now() - this.openedAt;
    return Math.max(0, this.resetTimeout - elapsed);
  }

  /**
   * Get current state
   * @returns {string}
   */
  getState() {
    return this.state;
  }

  /**
   * Get stats
   * @returns {Object}
   */
  getStats() {
    return {
      ...this.stats,
      state: this.state,
      recentFailures: this.failures.length,
      remainingOpenTime: this.state === STATES.OPEN ? this.getRemainingOpenTime() : 0,
    };
  }

  /**
   * Force close the circuit (for testing/admin)
   */
  forceClose() {
    this.state = STATES.CLOSED;
    this.failures = [];
    this.openedAt = null;
    log.info('agent', `[${this.name}] Circuit force-closed`);
  }

  /**
   * Force open the circuit (for testing/admin)
   */
  forceOpen() {
    this.state = STATES.OPEN;
    this.openedAt = Date.now();
    log.info('agent', `[${this.name}] Circuit force-opened`);
  }
}

/**
 * Error thrown when circuit is open
 */
class CircuitOpenError extends Error {
  constructor(name, remainingMs) {
    super(`Circuit breaker "${name}" is open. Retry in ${Math.ceil(remainingMs / 1000)}s`);
    this.name = 'CircuitOpenError';
    this.circuitName = name;
    this.remainingMs = remainingMs;
  }
}

// Singleton instances for common services
const circuits = new Map();

/**
 * Get or create a circuit breaker for a service
 * @param {string} name - Service name
 * @param {Object} options - Circuit breaker options
 * @returns {CircuitBreaker}
 */
function getCircuit(name, options = {}) {
  if (!circuits.has(name)) {
    circuits.set(name, new CircuitBreaker({ name, ...options }));
  }
  return circuits.get(name);
}

/**
 * Wrap a function with circuit breaker protection
 * @param {string} circuitName - Name of circuit to use
 * @param {Function} fn - Async function to protect
 * @param {Object} options - Circuit options
 * @returns {Function} - Protected function
 */
function withCircuitBreaker(circuitName, fn, options = {}) {
  const circuit = getCircuit(circuitName, options);

  return async function (...args) {
    return circuit.execute(() => fn(...args));
  };
}

/**
 * Get all circuit stats (for monitoring)
 * @returns {Object}
 */
function getAllStats() {
  const stats = {};
  for (const [name, circuit] of circuits) {
    stats[name] = circuit.getStats();
  }
  return stats;
}

module.exports = {
  CircuitBreaker,
  CircuitOpenError,
  getCircuit,
  withCircuitBreaker,
  getAllStats,
  STATES,
};
