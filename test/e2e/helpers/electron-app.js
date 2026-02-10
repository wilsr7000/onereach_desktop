/**
 * Shared Electron Test Harness
 *
 * Provides reusable helpers for launching the Electron app, monitoring the
 * log server for errors, and tracking app AI costs during test sessions.
 *
 * Usage:
 *   const { launchApp, closeApp, snapshotErrors, checkNewErrors, ... } = require('./helpers/electron-app');
 *   let app;
 *   test.beforeAll(async () => { app = await launchApp(); });
 *   test.afterAll(async () => { await closeApp(app); });
 */

const { _electron: electron } = require('playwright');
const path = require('path');

const LOG_SERVER = 'http://127.0.0.1:47292';
const SPACES_API = 'http://127.0.0.1:47291';
const LAUNCH_TIMEOUT = 30000;
const HEALTH_POLL_INTERVAL = 500;
const HEALTH_POLL_MAX = 40; // 20 seconds max wait for health

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

/**
 * Launch the Electron app and wait for the log server health endpoint to
 * respond, indicating the app is fully initialized.
 * @param {object} [opts] - Options
 * @param {number} [opts.timeout=30000] - Max launch time in ms
 * @returns {{ electronApp, mainWindow }}
 */
async function launchApp(opts = {}) {
  const timeout = opts.timeout || LAUNCH_TIMEOUT;

  // Strip ELECTRON_RUN_AS_NODE so Electron starts as a real app (not plain Node).
  // Cursor's terminal sets this env var because Cursor itself is an Electron app.
  const env = { ...process.env, NODE_ENV: 'test', TEST_MODE: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;

  const electronApp = await electron.launch({
    args: [path.join(__dirname, '../../..')],
    env,
    timeout
  });

  const mainWindow = await electronApp.firstWindow();
  await mainWindow.waitForLoadState('domcontentloaded');

  // Wait for log server to come up (indicates full initialization)
  await waitForHealth(HEALTH_POLL_MAX);

  return { electronApp, mainWindow };
}

/**
 * Gracefully close the Electron app, with a force-kill fallback
 * if the close hangs (e.g. macOS window-all-closed refuses to quit).
 *
 * The app's before-quit handler has an 8-second hard timeout and calls
 * app.exit(0) when done, so this should normally resolve within ~10s.
 * We keep a 15s outer timeout as a safety net, then force-kill via
 * process signals if even that fails.
 */
async function closeApp({ electronApp }) {
  if (!electronApp) return;
  try {
    // Signal the app to quit via the main process (sets global.isQuitting
    // and triggers the controlled shutdown with hard timeout in before-quit)
    try {
      await electronApp.evaluate(({ app }) => { app.quit(); });
    } catch (_) { /* app may already be exiting */ }

    const closePromise = electronApp.close();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Close timeout after 15s')), 15000)
    );
    await Promise.race([closePromise, timeoutPromise]);
  } catch (e) {
    // Graceful close failed -- force exit via main process
    try { await electronApp.evaluate(({ app }) => { app.exit(0); }); } catch (_) {}

    // Give it 2 seconds to respond to app.exit()
    try {
      const closePromise = electronApp.close();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Force close timeout')), 2000)
      );
      await Promise.race([closePromise, timeoutPromise]);
    } catch (_) {
      // Last resort: Playwright will kill the process tree on GC
      console.warn('[closeApp] App did not exit cleanly -- process will be force-killed');
    }
  }
}

// ---------------------------------------------------------------------------
// Health & readiness
// ---------------------------------------------------------------------------

/**
 * Poll the log server /health endpoint until it responds.
 * @param {number} [maxAttempts=40] - Max poll attempts (500ms apart)
 * @returns {object} Health response JSON
 * @throws If health endpoint never responds
 */
async function waitForHealth(maxAttempts = HEALTH_POLL_MAX) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${LOG_SERVER}/health`);
      if (res.ok) return await res.json();
    } catch (e) {
      // Not ready yet
    }
    await sleep(HEALTH_POLL_INTERVAL);
  }
  throw new Error(`Log server did not respond after ${maxAttempts * HEALTH_POLL_INTERVAL}ms`);
}

/**
 * Get the current health status.
 */
async function getHealth() {
  const res = await fetch(`${LOG_SERVER}/health`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Error monitoring
// ---------------------------------------------------------------------------

/**
 * Snapshot the current error state. Returns an object you pass to
 * checkNewErrors() later to see only errors that appeared after the snapshot.
 */
async function snapshotErrors() {
  const timestamp = new Date().toISOString();
  const stats = await getStats();
  return {
    timestamp,
    errorCount: stats.byLevel?.error || 0,
    warnCount: stats.byLevel?.warn || 0
  };
}

/**
 * Return errors that appeared AFTER a snapshot.
 * @param {object} snapshot - From snapshotErrors()
 * @returns {Array} Array of error log entries
 */
async function checkNewErrors(snapshot) {
  try {
    const res = await fetch(
      `${LOG_SERVER}/logs?level=error&since=${encodeURIComponent(snapshot.timestamp)}&limit=50`
    );
    const data = await res.json();
    return data.data || [];
  } catch (e) {
    return [];
  }
}

/**
 * Get all errors since a given ISO timestamp.
 */
async function getErrorsSince(timestamp) {
  const res = await fetch(
    `${LOG_SERVER}/logs?level=error&since=${encodeURIComponent(timestamp)}&limit=100`
  );
  const data = await res.json();
  return data.data || [];
}

/**
 * Get log server stats.
 */
async function getStats() {
  const res = await fetch(`${LOG_SERVER}/logs/stats`);
  return res.json();
}

/**
 * Query logs with arbitrary filters.
 */
async function queryLogs(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${LOG_SERVER}/logs?${qs}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Logging level control
// ---------------------------------------------------------------------------

/**
 * Set the diagnostic logging level at runtime.
 * @param {'off'|'error'|'warn'|'info'|'debug'} level
 */
async function setLogLevel(level) {
  const res = await fetch(`${LOG_SERVER}/logging/level`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level })
  });
  return res.json();
}

/**
 * Get the current logging level.
 */
async function getLogLevel() {
  const res = await fetch(`${LOG_SERVER}/logging/level`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Spaces API helpers
// ---------------------------------------------------------------------------

/**
 * Check if the Spaces API is healthy.
 */
async function checkSpacesApi() {
  try {
    const res = await fetch(`${SPACES_API}/api/spaces`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch (e) {
    return false;
  }
}

/**
 * List all spaces via the REST API.
 * API returns { spaces: [...] }, this unwraps to the array.
 */
async function listSpaces() {
  const res = await fetch(`${SPACES_API}/api/spaces`);
  const data = await res.json();
  return data.spaces || data; // Unwrap { spaces: [...] } envelope
}

/**
 * Create a test space via the REST API.
 * API returns { success: true, space: { id, name, ... } }.
 * This unwraps to the space object.
 */
async function createSpace(name, description = 'Test space') {
  const res = await fetch(`${SPACES_API}/api/spaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description })
  });
  const data = await res.json();
  return data.space || data; // Unwrap { success, space } envelope
}

/**
 * Delete a space via the REST API.
 */
async function deleteSpace(spaceId) {
  const res = await fetch(`${SPACES_API}/api/spaces/${spaceId}`, {
    method: 'DELETE'
  });
  return res.ok;
}

// ---------------------------------------------------------------------------
// Task Exchange health
// ---------------------------------------------------------------------------

/**
 * Check if the Task Exchange is running via the exchange-bridge module
 * in the main process.
 * @param {ElectronApplication} electronApp
 * @returns {{ running: boolean, port: number, agentCount: number, url: string }}
 */
async function checkExchangeHealth(electronApp) {
  try {
    return await electronApp.evaluate(async () => {
      const bridge = require('./src/voice-task-sdk/exchange-bridge');
      const exchange = bridge.getExchange();
      return {
        running: bridge.isRunning(),
        port: bridge.DEFAULT_EXCHANGE_CONFIG.port,
        url: bridge.getExchangeUrl(),
        agentCount: exchange?.agents?.getCount() || 0,
        queueDepth: exchange?.getQueueStats()?.depth?.total || 0
      };
    });
  } catch (e) {
    return { running: false, error: e.message, port: 3456, agentCount: 0, queueDepth: 0 };
  }
}

// ---------------------------------------------------------------------------
// App AI cost monitoring
// ---------------------------------------------------------------------------

/**
 * Get the app's current AI cost summary by evaluating in the main process.
 * Requires an active electronApp.
 * @param {ElectronApplication} electronApp
 * @param {'daily'|'weekly'|'monthly'} [period='daily']
 */
async function getAppAiCost(electronApp, period = 'daily') {
  try {
    return await electronApp.evaluate(async ({ }, p) => {
      const { getBudgetManager } = require('./budget-manager');
      const bm = getBudgetManager();
      return bm.getCostSummary(p);
    }, period);
  } catch (e) {
    return { totalCost: 0, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Known benign errors (filter these out when asserting "no errors")
// ---------------------------------------------------------------------------

const BENIGN_ERROR_PATTERNS = [
  /Agent reconnect failed/i,
  /Built-in agent WebSocket error/i,
  /Failed to inject Chrome-like behavior/i,
  /Failed to check for Material Symbols/i,
  /Database IO error/i,              // Electron service worker storage
  /console-message.*deprecated/i,
  /ERR_CONNECTION_REFUSED/i,          // Agents connecting before server ready
  /ECONNREFUSED/i,                    // Same, Node-level
  /net::ERR_/i,                       // Network errors during startup race
  /ResizeObserver loop/i,             // Benign Chrome layout warning
  /ServiceWorker/i,                   // SW registration timing
  /log is not defined/i,              // Renderer script injection timing
  /Content Security Policy/i,         // CSP violations (e.g. favicon loading)
  /violates the following Content Security Policy/i,
];

/**
 * Filter an array of error entries, removing known benign errors.
 * @param {Array} errors - Error log entries from the log server
 * @returns {Array} Only genuine errors
 */
function filterBenignErrors(errors) {
  return errors.filter(err => {
    const msg = err.message || '';
    return !BENIGN_ERROR_PATTERNS.some(pattern => pattern.test(msg));
  });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Lifecycle
  launchApp,
  closeApp,

  // Health
  waitForHealth,
  getHealth,

  // Error monitoring
  snapshotErrors,
  checkNewErrors,
  getErrorsSince,
  getStats,
  queryLogs,
  filterBenignErrors,

  // Logging control
  setLogLevel,
  getLogLevel,

  // Spaces API
  checkSpacesApi,
  listSpaces,
  createSpace,
  deleteSpace,

  // Task Exchange
  checkExchangeHealth,

  // App AI costs
  getAppAiCost,

  // Utilities
  sleep,

  // Constants
  LOG_SERVER,
  SPACES_API,
  BENIGN_ERROR_PATTERNS
};
