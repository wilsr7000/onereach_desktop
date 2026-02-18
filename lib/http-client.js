/**
 * Centralized HTTP Client for non-LLM API calls.
 *
 * Parallels how `ai-service.js` centralizes all LLM calls -- this module
 * centralizes non-LLM HTTP calls (weather APIs, search APIs, playbook APIs, etc.)
 * with consistent timeout, retry, and circuit-breaker behavior.
 *
 * Usage:
 *   const http = require('../lib/http-client');
 *
 *   // Fetch with timeout (returns raw Response)
 *   const res = await http.fetch('https://api.example.com/data', { timeoutMs: 5000 });
 *
 *   // Fetch JSON with retry (returns parsed object or null)
 *   const data = await http.fetchJSON('https://api.example.com/data', {
 *     timeoutMs: 5000,
 *     retries: 2,
 *   });
 */

'use strict';

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// ==================== CIRCUIT BREAKER ====================

const circuitState = new Map();

const CIRCUIT_DEFAULTS = {
  failureThreshold: 5,
  resetTimeMs: 30_000,
};

/**
 * Get or initialize the circuit state for a given host.
 * @param {string} host
 * @returns {{ failures: number, openedAt: number|null }}
 */
function getCircuit(host) {
  if (!circuitState.has(host)) {
    circuitState.set(host, { failures: 0, openedAt: null });
  }
  return circuitState.get(host);
}

/**
 * Check if the circuit breaker allows a request to the given host.
 * @param {string} host
 * @returns {boolean}
 */
function isCircuitOpen(host) {
  const circuit = getCircuit(host);
  if (!circuit.openedAt) return false;

  const elapsed = Date.now() - circuit.openedAt;
  if (elapsed > CIRCUIT_DEFAULTS.resetTimeMs) {
    // Half-open: allow one attempt through
    circuit.openedAt = null;
    circuit.failures = 0;
    return false;
  }
  return true;
}

/**
 * Record a success for circuit breaker tracking.
 * @param {string} host
 */
function recordSuccess(host) {
  const circuit = getCircuit(host);
  circuit.failures = 0;
  circuit.openedAt = null;
}

/**
 * Record a failure and open the circuit if threshold exceeded.
 * @param {string} host
 */
function recordFailure(host) {
  const circuit = getCircuit(host);
  circuit.failures++;
  if (circuit.failures >= CIRCUIT_DEFAULTS.failureThreshold) {
    circuit.openedAt = Date.now();
    log.warn('http-client', `Circuit opened for ${host} after ${circuit.failures} failures`);
  }
}

// ==================== CORE FETCH ====================

/**
 * Fetch with timeout and circuit breaker. Returns the raw Response.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeoutMs=10000] - Request timeout in ms
 * @param {string} [options.method] - HTTP method
 * @param {object} [options.headers] - Request headers
 * @param {string|object} [options.body] - Request body (objects are JSON-stringified)
 * @returns {Promise<Response>}
 * @throws {Error} On timeout, circuit-open, or network error
 */
async function fetchWithTimeout(url, options = {}) {
  const { timeoutMs = 10_000, ...fetchOpts } = options;

  let host;
  try {
    host = new URL(url).host;
  } catch (_ignored) {
    host = url;
  }

  if (isCircuitOpen(host)) {
    throw new Error(`Circuit breaker open for ${host} -- backing off`);
  }

  // Auto-stringify object bodies
  if (fetchOpts.body && typeof fetchOpts.body === 'object') {
    fetchOpts.body = JSON.stringify(fetchOpts.body);
    fetchOpts.headers = { 'Content-Type': 'application/json', ...fetchOpts.headers };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...fetchOpts,
      signal: controller.signal,
    });
    recordSuccess(host);
    return response;
  } catch (err) {
    recordFailure(host);
    if (err.name === 'AbortError') {
      throw new Error(`Request to ${host} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse JSON with optional retry. Returns parsed object or null on failure.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeoutMs=10000] - Request timeout in ms
 * @param {number} [options.retries=0] - Number of retries on failure
 * @param {number} [options.retryDelayMs=1000] - Delay between retries
 * @param {string} [options.method] - HTTP method
 * @param {object} [options.headers] - Request headers
 * @param {string|object} [options.body] - Request body
 * @returns {Promise<object|null>}
 */
async function fetchJSON(url, options = {}) {
  const { retries = 0, retryDelayMs = 1000, ...fetchOpts } = options;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, fetchOpts);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        log.warn('http-client', `HTTP ${response.status} from ${url}`, { body: text.substring(0, 200) });
        // Try to parse error body as JSON anyway
        try {
          return JSON.parse(text);
        } catch (_ignored) {
          /* not JSON */
        }
        return null;
      }

      return await response.json();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        log.info('http-client', `Retry ${attempt + 1}/${retries} for ${url}`, { error: err.message });
        await new Promise((r) => {
          setTimeout(r, retryDelayMs);
        });
      }
    }
  }

  log.warn('http-client', `All attempts failed for ${url}`, { error: lastError?.message });
  return null;
}

/**
 * Reset circuit breaker state (useful for testing).
 */
function resetCircuits() {
  circuitState.clear();
}

module.exports = {
  fetch: fetchWithTimeout,
  fetchJSON,
  resetCircuits,
};
