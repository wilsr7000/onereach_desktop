/**
 * AI Pause -- emergency kill switch for all LLM traffic.
 *
 * When paused:
 *   - ipcMain handlers for ai:chat, ai:complete, ai:json, ai:vision, ai:embed,
 *     ai:transcribe, and ai:chatStream short-circuit with an error before
 *     hitting the provider.
 *   - Registered hooks fire so subsystems with their own timers
 *     (app-manager-agent scan loop, agent-learning evaluation cycle, etc.)
 *     can stop themselves cleanly.
 *
 * Control surfaces:
 *   - Env var AI_PAUSE=1 at launch -> starts paused.
 *   - Log server HTTP: GET /ai/status, POST /ai/pause, POST /ai/resume.
 *   - IPC: ai:pause, ai:resume, ai:pause-status.
 *   - Node:  const p = require('./lib/ai-pause'); p.pause(reason);
 *
 * The module keeps state in a file so the pause survives app restarts.
 */

'use strict';

const fs = require('fs');
const path = require('path');

let _paused = false;
let _reason = null;
let _since = null;
let _stateFile = null;
let _hooks = [];

function _loadState() {
  try {
    if (_stateFile && fs.existsSync(_stateFile)) {
      const data = JSON.parse(fs.readFileSync(_stateFile, 'utf8'));
      if (typeof data.paused === 'boolean') {
        _paused = data.paused;
        _reason = data.reason || null;
        _since = data.since || null;
      }
    }
  } catch (err) {
    console.warn('[ai-pause] Failed to load state:', err.message);
  }
}

function _saveState() {
  try {
    if (!_stateFile) return;
    fs.mkdirSync(path.dirname(_stateFile), { recursive: true });
    fs.writeFileSync(
      _stateFile,
      JSON.stringify({ paused: _paused, reason: _reason, since: _since }, null, 2)
    );
  } catch (err) {
    console.warn('[ai-pause] Failed to save state:', err.message);
  }
}

/**
 * Initialize from a user-data directory and optional env override.
 * Safe to call multiple times; later calls refresh the state file location.
 */
function init(userDataDir, { envOverride = true } = {}) {
  if (userDataDir) {
    _stateFile = path.join(userDataDir, 'ai-pause.json');
    _loadState();
  }

  if (envOverride && process.env.AI_PAUSE === '1' && !_paused) {
    _paused = true;
    _reason = 'AI_PAUSE env var';
    _since = new Date().toISOString();
    _saveState();
    console.warn('[ai-pause] Starting PAUSED due to AI_PAUSE=1');
  }

  if (_paused) {
    console.warn(
      `[ai-pause] AI traffic is currently PAUSED (reason: ${_reason || 'unspecified'}, since ${_since || 'unknown'}). All ai:* IPC calls will be blocked.`
    );
  }
}

function isPaused() {
  return _paused;
}

function getStatus() {
  return {
    paused: _paused,
    reason: _reason,
    since: _since,
    hookCount: _hooks.length,
  };
}

/**
 * Register a subsystem that should stop on pause and restart on resume.
 * @param {{ name:string, onPause: function, onResume: function }} hook
 * @returns {function} unregister callback
 */
function registerHook(hook) {
  if (!hook || typeof hook !== 'object') return () => {};
  _hooks.push(hook);
  if (_paused && typeof hook.onPause === 'function') {
    Promise.resolve()
      .then(() => hook.onPause(_reason))
      .catch((err) => console.warn(`[ai-pause] Hook ${hook.name} onPause (immediate) error:`, err.message));
  }
  return () => {
    _hooks = _hooks.filter((h) => h !== hook);
  };
}

async function _fireHooks(kind) {
  for (const hook of _hooks) {
    const fn = hook[kind];
    if (typeof fn !== 'function') continue;
    try {
      await fn(_reason);
    } catch (err) {
      console.warn(`[ai-pause] Hook ${hook.name || '?'} ${kind} error:`, err.message);
    }
  }
}

async function pause(reason = 'manual') {
  if (_paused) return getStatus();
  _paused = true;
  _reason = String(reason || 'manual').slice(0, 200);
  _since = new Date().toISOString();
  _saveState();
  console.warn(`[ai-pause] PAUSED (${_reason})`);
  await _fireHooks('onPause');
  return getStatus();
}

async function resume() {
  if (!_paused) return getStatus();
  _paused = false;
  const wasReason = _reason;
  _reason = null;
  _since = new Date().toISOString();
  _saveState();
  console.warn(`[ai-pause] RESUMED (was paused for: ${wasReason})`);
  await _fireHooks('onResume');
  return getStatus();
}

/**
 * Standard error response shape for IPC handlers to return when paused.
 */
function pausedError() {
  return {
    error: `AI traffic is paused (${_reason || 'manual'})`,
    code: 'AI_PAUSED',
    paused: true,
    reason: _reason,
    since: _since,
  };
}

module.exports = {
  init,
  isPaused,
  getStatus,
  pause,
  resume,
  registerHook,
  pausedError,
};
