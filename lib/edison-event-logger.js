/**
 * Edison Event Logger
 *
 * Structured event logging for Dev Tools actions. Events are sent to an
 * Edison flow HTTP endpoint (POST /event-log) which persists them to
 * Key-Value storage on the server side.
 *
 * When the flow endpoint is not available, events are buffered locally
 * in a JSON file and retried on next flush.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

let sessionId = null;
let enabled = true;
let buffer = [];
const MAX_BUFFER = 200;

function getSessionId() {
  if (!sessionId) {
    sessionId = `session-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  }
  return sessionId;
}

function getBufferPath() {
  try {
    return path.join(app.getPath('userData'), 'edison-event-buffer.json');
  } catch {
    return path.join(require('os').homedir(), '.edison-event-buffer.json');
  }
}

function setEnabled(val) {
  enabled = !!val;
}

function isEnabled() {
  return enabled;
}

/**
 * Log a structured event.
 * @param {string} action - Event action (e.g. 'flow.opened', 'step.added')
 * @param {Object} dimensions - Context dimensions (botId, flowId, stepId, etc.)
 * @param {Object} data - Action-specific payload
 */
function logEvent(action, dimensions = {}, data = {}) {
  if (!enabled) return;

  const sdkManager = require('./edison-sdk-manager');
  const flowContext = require('./gsx-flow-context');
  const ctx = flowContext.get();

  const event = {
    accountId: sdkManager.getAccountId(),
    sessionId: getSessionId(),
    botId: dimensions.botId || ctx?.botId || null,
    flowId: dimensions.flowId || ctx?.flowId || null,
    stepId: dimensions.stepId || null,
    userId: dimensions.userId || null,
    action,
    timestamp: new Date().toISOString(),
    data,
  };

  buffer.push(event);
  if (buffer.length > MAX_BUFFER) {
    buffer = buffer.slice(-MAX_BUFFER);
  }

  _flushAsync(event);
}

async function _flushAsync(event) {
  try {
    const sdkManager = require('./edison-sdk-manager');
    await sdkManager.callFlow('event-log', event);
  } catch {
    _persistBuffer();
  }
}

function _persistBuffer() {
  try {
    fs.writeFileSync(getBufferPath(), JSON.stringify(buffer.slice(-MAX_BUFFER), null, 2));
  } catch (err) {
    log.warn('edison-event-logger', 'Failed to persist event buffer', { error: err.message });
  }
}

function getBuffer() {
  return [...buffer];
}

function clearBuffer() {
  buffer = [];
  try { fs.unlinkSync(getBufferPath()); } catch { /* intentionally empty */ }
}

function loadPersistedBuffer() {
  try {
    const raw = fs.readFileSync(getBufferPath(), 'utf8');
    const persisted = JSON.parse(raw);
    if (Array.isArray(persisted)) {
      buffer = persisted;
      log.info('edison-event-logger', 'Loaded persisted event buffer', { count: buffer.length });
    }
  } catch { /* intentionally empty */ }
}

loadPersistedBuffer();

module.exports = {
  logEvent,
  getBuffer,
  clearBuffer,
  getSessionId,
  setEnabled,
  isEnabled,
};
