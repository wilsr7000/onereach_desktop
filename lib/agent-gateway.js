/**
 * Agent Gateway -- Phase 6 HTTP / SSE shell
 *
 * Exposes the agent system over HTTP so remote tools, web clients, and
 * a future flow runtime can interact with the same auction that the
 * in-app orb and command HUD use today. This is an ADDITIVE transport
 * shim: every route delegates to existing main-process functions
 * (hudApi.submitTask, hudApi.respondToInput, hudApi.selectDisambiguation).
 * No new business logic lives here.
 *
 * Routes:
 *   POST /submit-task
 *     Body:   { text, toolId?, spaceId?, targetAgentId?, metadata?,
 *               variant?, criteria?, rubric?, weightingMode? }
 *     200 ->  { taskId, queued, handled, message?, ui?, data? }
 *
 *   GET /events/:taskId  (Server-Sent Events)
 *     Replays the task's persisted timeline (Phase 0) and then streams
 *     live lifecycle events until the client disconnects. Events are
 *     `data: <JSON>\n\n` with the standard SSE framing.
 *
 *   POST /respond-input
 *     Body:   { taskId, response }
 *     200 ->  { success, message? }
 *
 *   POST /select-disambiguation
 *     Body:   { stateId, optionIndex? | customText? }
 *     200 ->  { success, taskId?, queued? }
 *
 *   POST /cancel-task
 *     Body:   { taskId }
 *     200 ->  { success }
 *
 *   GET /health
 *     200 ->  { ok: true, tasks, subscribers, pid }
 *
 * All routes require the `httpGateway` feature flag to be enabled. The
 * gateway is created on demand via `startAgentGateway(options)`; the
 * default port mirrors the existing log server / Spaces API (47293).
 *
 * Security posture: binds to 127.0.0.1 only. Intended for local tool
 * integration and future flow-runtime calls. NOT for public exposure.
 */

'use strict';

const http = require('http');
const url = require('url');

const DEFAULT_PORT = 47293;
const DEFAULT_HOST = '127.0.0.1';

const { isAgentFlagEnabled } = require('./agent-system-flags');

// Lazy requires so this module loads cleanly in Node-only test
// contexts without pulling in Electron / hud-api transitively unless
// the gateway is actually started.
let _hudApiCached = null;
function _getHudApi() {
  if (_hudApiCached) return _hudApiCached;
  try {
    _hudApiCached = require('./hud-api');
  } catch (_err) {
    _hudApiCached = null;
  }
  return _hudApiCached;
}

let _statsCached = null;
function _getAgentStats() {
  if (_statsCached) return _statsCached;
  try {
    const { getAgentStats } = require('../src/voice-task-sdk/agent-stats');
    _statsCached = getAgentStats();
  } catch (_err) {
    _statsCached = null;
  }
  return _statsCached;
}

// ==================== SSE SUBSCRIBERS ====================
// taskId -> Set<ServerResponse>. A single task can have multiple
// subscribers (e.g. a web dashboard + a CLI tail). Unsubscribe on
// 'close'.
const _subscribers = new Map();

function _subscribe(taskId, res) {
  if (!_subscribers.has(taskId)) _subscribers.set(taskId, new Set());
  _subscribers.get(taskId).add(res);
}

function _unsubscribe(taskId, res) {
  const set = _subscribers.get(taskId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) _subscribers.delete(taskId);
}

/**
 * Broadcast a lifecycle event to any SSE subscribers for a task.
 * Safe to call from main-process consumers (exchange-bridge, hud-api)
 * so the gateway can mirror live events without owning the emission.
 *
 * @param {string} taskId
 * @param {Object} event  - JSON-serializable; { type, ...data }
 */
function broadcastLifecycle(taskId, event) {
  if (!taskId || !event) return;
  const set = _subscribers.get(taskId);
  if (!set || set.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch (_err) { /* client went away */ }
  }
}

// ==================== HTTP PLUMBING ====================

async function _readJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        return reject(new Error('Request body too large'));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error('Invalid JSON body: ' + err.message));
      }
    });
    req.on('error', reject);
  });
}

function _sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
}

function _sendError(res, status, message) {
  _sendJson(res, status, { error: message });
}

// ==================== ROUTE HANDLERS ====================

async function _handleSubmitTask(req, res) {
  const body = await _readJsonBody(req);
  const hudApi = _getHudApi();
  if (!hudApi) return _sendError(res, 503, 'hud-api not available');

  const { text, toolId, spaceId, targetAgentId, metadata, variant, criteria, rubric, weightingMode } = body;
  if (typeof text !== 'string' || !text.trim()) {
    return _sendError(res, 400, 'text is required');
  }

  const result = await hudApi.submitTask(text, {
    toolId: toolId || 'agent-gateway',
    spaceId,
    targetAgentId,
    metadata: metadata || {},
    variant,
    criteria,
    rubric,
    weightingMode,
    skipFilter: true, // HTTP body is not a voice transcript
  });
  _sendJson(res, 200, result);
}

async function _handleRespondInput(req, res) {
  const body = await _readJsonBody(req);
  const hudApi = _getHudApi();
  if (!hudApi) return _sendError(res, 503, 'hud-api not available');

  if (!body.taskId || typeof body.response !== 'string') {
    return _sendError(res, 400, 'taskId and response are required');
  }
  if (typeof hudApi.respondToInput !== 'function') {
    return _sendError(res, 501, 'respondToInput not implemented by hud-api');
  }
  const result = await hudApi.respondToInput(body.taskId, body.response);
  _sendJson(res, 200, result || { success: true });
}

async function _handleSelectDisambiguation(req, res) {
  const body = await _readJsonBody(req);
  const hudApi = _getHudApi();
  if (!hudApi) return _sendError(res, 503, 'hud-api not available');

  if (!body.stateId) {
    return _sendError(res, 400, 'stateId is required');
  }
  if (typeof hudApi.selectDisambiguation !== 'function') {
    return _sendError(res, 501, 'selectDisambiguation not implemented by hud-api');
  }
  const result = await hudApi.selectDisambiguation(body.stateId, {
    optionIndex: typeof body.optionIndex === 'number' ? body.optionIndex : undefined,
    customText: typeof body.customText === 'string' ? body.customText : undefined,
  });
  _sendJson(res, 200, result || { success: true });
}

async function _handleCancelTask(req, res) {
  const body = await _readJsonBody(req);
  const hudApi = _getHudApi();
  if (!hudApi) return _sendError(res, 503, 'hud-api not available');
  if (!body.taskId) return _sendError(res, 400, 'taskId is required');
  hudApi.cancelTask(body.taskId);
  _sendJson(res, 200, { success: true });
}

async function _handleEvents(req, res, taskId) {
  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
  // Strip any CR/LF that slipped through URL decoding so a crafted
  // `%0A` in the path can't break SSE framing by injecting extra
  // event boundaries into the comment line.
  const safeTaskId = String(taskId).replace(/[\r\n]/g, '');
  res.write(`: agent-gateway sse stream for ${safeTaskId}\n\n`);

  // 1. Replay persisted timeline (Phase 0 durable store).
  const stats = _getAgentStats();
  if (stats && typeof stats.getTaskTimeline === 'function') {
    try {
      const past = stats.getTaskTimeline(taskId) || [];
      for (const event of past) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (_err) { /* best-effort replay */ }
  }

  // 2. Subscribe for live events.
  _subscribe(taskId, res);

  // 3. Cleanup on disconnect.
  req.on('close', () => _unsubscribe(taskId, res));

  // 4. Keep-alive heartbeat every 25s (under typical idle-timeouts).
  const heartbeat = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (_err) { /* client gone */ }
  }, 25_000);
  req.on('close', () => clearInterval(heartbeat));
}

function _handleHealth(req, res) {
  _sendJson(res, 200, {
    ok: true,
    pid: process.pid,
    subscribers: Array.from(_subscribers.values()).reduce((n, set) => n + set.size, 0),
    tasks: _subscribers.size,
  });
}

// ==================== ROUTER ====================

async function _router(req, res) {
  if (!isAgentFlagEnabled('httpGateway')) {
    return _sendError(res, 503, 'agent gateway disabled');
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const parsed = url.parse(req.url || '', true);
  const pathname = parsed.pathname || '/';

  try {
    if (req.method === 'GET' && pathname === '/health') {
      return _handleHealth(req, res);
    }

    if (req.method === 'POST' && pathname === '/submit-task') {
      return _handleSubmitTask(req, res);
    }

    if (req.method === 'POST' && pathname === '/respond-input') {
      return _handleRespondInput(req, res);
    }

    if (req.method === 'POST' && pathname === '/select-disambiguation') {
      return _handleSelectDisambiguation(req, res);
    }

    if (req.method === 'POST' && pathname === '/cancel-task') {
      return _handleCancelTask(req, res);
    }

    const eventsMatch = pathname.match(/^\/events\/([^/]+)$/);
    if (req.method === 'GET' && eventsMatch) {
      return _handleEvents(req, res, decodeURIComponent(eventsMatch[1]));
    }

    _sendError(res, 404, `Unknown route: ${req.method} ${pathname}`);
  } catch (err) {
    _sendError(res, 500, err.message || 'Internal error');
  }
}

// ==================== PUBLIC API ====================

let _server = null;

/**
 * Start the gateway HTTP server. Idempotent -- returns the existing
 * server when already running.
 *
 * @param {Object} [options]
 * @param {number} [options.port=47293]
 * @param {string} [options.host='127.0.0.1']
 * @returns {Promise<http.Server>}
 */
async function startAgentGateway(options = {}) {
  if (_server) return _server;
  // Explicit `port: 0` asks the OS for an ephemeral port; don't coerce
  // it to DEFAULT_PORT with `||`.
  const port = (typeof options.port === 'number' ? options.port : DEFAULT_PORT);
  const host = options.host || DEFAULT_HOST;

  const server = http.createServer((req, res) => { _router(req, res); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  _server = server;
  return server;
}

/**
 * Stop the gateway. Resolves once the server has fully closed.
 */
async function stopAgentGateway() {
  if (!_server) return;
  const s = _server;
  _server = null;
  for (const set of _subscribers.values()) {
    for (const res of set) {
      try { res.end(); } catch (_err) { /* ignore */ }
    }
  }
  _subscribers.clear();
  await new Promise((resolve) => s.close(() => resolve()));
}

/**
 * Is the gateway currently running?
 */
function isAgentGatewayRunning() {
  return !!_server;
}

module.exports = {
  startAgentGateway,
  stopAgentGateway,
  isAgentGatewayRunning,
  broadcastLifecycle,
  DEFAULT_PORT,
  DEFAULT_HOST,
  // Exposed for tests
  _router,
  _subscribers,
};
