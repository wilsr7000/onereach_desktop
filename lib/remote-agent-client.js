/**
 * Remote Agent Client
 *
 * HTTP client for communicating with GSX-hosted remote agents.
 * Remote agents expose a simple REST protocol:
 *   POST /bid     -- evaluate if agent can handle a task
 *   POST /execute -- execute a task
 *   GET  /health  -- health check (optional)
 *
 * Includes circuit breaker protection per agent (3 failures = disabled for 60s).
 *
 * @module RemoteAgentClient
 */

// ==================== CIRCUIT BREAKER ====================

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

const _circuits = new Map(); // agentId -> { failures, lastFailure, disabled }

const CIRCUIT_CONFIG = {
  failureThreshold: 3, // Open circuit after N failures
  resetTimeoutMs: 60000, // Reset after 60s
  bidTimeoutMs: 10000, // 10s timeout for bid
  executeTimeoutMs: 30000, // 30s timeout for execute
  healthTimeoutMs: 5000, // 5s timeout for health check
};

function _getCircuit(agentId) {
  if (!_circuits.has(agentId)) {
    _circuits.set(agentId, { failures: 0, lastFailure: 0, disabled: false });
  }
  return _circuits.get(agentId);
}

function _isCircuitOpen(agentId) {
  const circuit = _getCircuit(agentId);
  if (circuit.failures >= CIRCUIT_CONFIG.failureThreshold) {
    if (Date.now() - circuit.lastFailure > CIRCUIT_CONFIG.resetTimeoutMs) {
      // Half-open: reset and allow one attempt
      circuit.failures = 0;
      circuit.disabled = false;
      log.info('agent', 'Circuit reset for', { agentId: agentId });
      return false;
    }
    return true;
  }
  return false;
}

function _recordFailure(agentId) {
  const circuit = _getCircuit(agentId);
  circuit.failures++;
  circuit.lastFailure = Date.now();
  if (circuit.failures >= CIRCUIT_CONFIG.failureThreshold) {
    circuit.disabled = true;
    log.warn('agent', 'Circuit OPEN for after failures', { agentId: agentId, circuit: circuit.failures });
  }
}

function _recordSuccess(agentId) {
  const circuit = _getCircuit(agentId);
  circuit.failures = Math.max(0, circuit.failures - 1);
  circuit.disabled = false;
}

// ==================== HTTP HELPERS ====================

/**
 * Make an HTTP request to a remote agent with timeout.
 * @param {string} url
 * @param {Object} options
 * @param {number} timeoutMs
 * @returns {Object} Parsed JSON response
 */
async function _fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Build auth headers for a remote agent.
 * @param {Object} agent - Agent entry with authType, authToken
 * @returns {Object} Headers object
 */
function _buildAuthHeaders(agent) {
  const headers = {};
  if (agent.authType === 'bearer' && agent.authToken) {
    headers['Authorization'] = `Bearer ${agent.authToken}`;
  } else if (agent.authType === 'api-key' && agent.authToken) {
    headers['X-API-Key'] = agent.authToken;
  }
  return headers;
}

/**
 * Resolve the full URL for a remote agent endpoint path.
 * @param {Object} agent - Agent entry with endpoint
 * @param {string} path - e.g. '/bid', '/execute', '/health'
 * @returns {string} Full URL
 */
function _resolveUrl(agent, urlPath) {
  const base = agent.endpoint.replace(/\/+$/, '');
  return `${base}${urlPath}`;
}

// ==================== PUBLIC API ====================

/**
 * Call a remote agent's bid endpoint.
 *
 * @param {Object} agent - Remote agent entry { id, endpoint, authType, authToken, metadata }
 * @param {Object} task - Task to evaluate { content, metadata }
 * @returns {Object} { confidence, plan, reasoning } or { confidence: 0 } on failure
 */
async function callRemoteBid(agent, task) {
  if (_isCircuitOpen(agent.id)) {
    log.info('agent', 'Circuit open, skipping bid for', { agent: agent.id });
    return { confidence: 0, plan: null, reasoning: 'Agent temporarily unavailable (circuit open)' };
  }

  try {
    const result = await _fetchWithTimeout(
      _resolveUrl(agent, '/bid'),
      {
        method: 'POST',
        headers: _buildAuthHeaders(agent),
        body: JSON.stringify({
          task: {
            content: task.content || task.phrase || String(task),
            metadata: task.metadata || {},
          },
          context: {
            agentId: agent.id,
            agentName: agent.name || agent.id,
          },
        }),
      },
      CIRCUIT_CONFIG.bidTimeoutMs
    );

    _recordSuccess(agent.id);

    return {
      confidence: typeof result.confidence === 'number' ? result.confidence : 0,
      plan: result.plan || null,
      reasoning: result.reasoning || 'Remote agent bid',
    };
  } catch (error) {
    _recordFailure(agent.id);
    log.warn('agent', 'Bid failed for', { agent: agent.id, error: error.message });
    return { confidence: 0, plan: null, reasoning: `Remote bid failed: ${error.message}` };
  }
}

/**
 * Call a remote agent's execute endpoint.
 *
 * @param {Object} agent - Remote agent entry
 * @param {Object} task - Task to execute
 * @param {string} plan - Execution plan from bidding
 * @returns {Object} { success, message, data }
 */
async function callRemoteExecute(agent, task, plan) {
  if (_isCircuitOpen(agent.id)) {
    return { success: false, message: 'Agent temporarily unavailable' };
  }

  try {
    const result = await _fetchWithTimeout(
      _resolveUrl(agent, '/execute'),
      {
        method: 'POST',
        headers: _buildAuthHeaders(agent),
        body: JSON.stringify({
          task: {
            content: task.content || task.phrase || String(task),
            metadata: task.metadata || {},
          },
          plan,
          context: {
            agentId: agent.id,
          },
        }),
      },
      CIRCUIT_CONFIG.executeTimeoutMs
    );

    _recordSuccess(agent.id);

    return {
      success: result.success !== false,
      message: result.message || 'Remote agent completed',
      data: result.data || {},
    };
  } catch (error) {
    _recordFailure(agent.id);
    log.error('agent', 'Execute failed for', { agent: agent.id, error: error.message });
    return { success: false, message: `Remote execution failed: ${error.message}` };
  }
}

/**
 * Check a remote agent's health.
 *
 * @param {Object} agent - Remote agent entry
 * @returns {Object} { status: 'ok'|'error'|'timeout', latency, version? }
 */
async function checkRemoteHealth(agent) {
  const start = Date.now();
  const healthPath = agent.healthCheck || '/health';

  try {
    const result = await _fetchWithTimeout(
      _resolveUrl(agent, healthPath),
      {
        method: 'GET',
        headers: _buildAuthHeaders(agent),
      },
      CIRCUIT_CONFIG.healthTimeoutMs
    );

    const latency = Date.now() - start;
    _recordSuccess(agent.id);

    return {
      status: result.status || 'ok',
      latency,
      version: result.version || null,
    };
  } catch (error) {
    const latency = Date.now() - start;
    return {
      status: error.name === 'AbortError' ? 'timeout' : 'error',
      latency,
      error: error.message,
    };
  }
}

/**
 * Get circuit breaker status for all remote agents.
 * @returns {Object} agentId -> { failures, disabled, lastFailure }
 */
function getCircuitStatus() {
  const status = {};
  for (const [agentId, circuit] of _circuits) {
    status[agentId] = {
      failures: circuit.failures,
      disabled: _isCircuitOpen(agentId),
      lastFailure: circuit.lastFailure,
    };
  }
  return status;
}

/**
 * Reset circuit breaker for a specific agent.
 * @param {string} agentId
 */
function resetCircuit(agentId) {
  _circuits.delete(agentId);
  log.info('agent', 'Circuit manually reset for', { agentId: agentId });
}

module.exports = {
  callRemoteBid,
  callRemoteExecute,
  checkRemoteHealth,
  getCircuitStatus,
  resetCircuit,
  CIRCUIT_CONFIG,
};
