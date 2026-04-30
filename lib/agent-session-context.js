/**
 * Agent Session Context (Phase 2c -- calendar agent overhaul)
 *
 * Per-agent ephemeral, in-process state. NEVER persisted to disk.
 *
 * The naming-convention contract from Phase 0 of the calendar overhaul:
 *   - `lib/calendar-memory.js` (and any `getAgentMemory(...)`) -- everything
 *     here goes to Spaces and survives restart.
 *   - `lib/agent-session-context.js` (this file) -- ephemeral scratch pad
 *     keyed by agentId. Cleared on app reload. Used for `lastQuery`,
 *     `lastResultEventIds`, fuzzy-match cache, multi-turn intermediate state,
 *     and similar in-memory scratch.
 *
 * Lint rule (or code-review convention): nothing under `memory.*` may be
 * ephemeral; nothing under `sessionContext.*` may be persisted.
 *
 * The store is intentionally small and dependency-free. It must NEVER touch
 * the filesystem under any code path -- the `agent-session-context.test.js`
 * unit asserts this property.
 *
 * Optional TTL: setSession() accepts `{ ttlMs }` so caches can self-expire
 * without callers having to remember to clear. TTL timers are unref'd so
 * they don't keep the event loop alive.
 */

'use strict';

// agentId -> Map<key, { value, expiresAt? }>
const _store = new Map();

// Per-(agentId, key) timer handles so we can cancel previous TTLs on overwrite.
const _timers = new Map();

function _timerKey(agentId, key) {
  return `${agentId}::${key}`;
}

/**
 * Get the entire ephemeral context for an agent. Returns a plain object
 * (not the underlying Map) so callers can't mutate the store directly --
 * mutations must go through setSession().
 *
 * @param {string} agentId
 * @returns {Object} keys -> values, with expired entries omitted
 */
function getSession(agentId) {
  if (!agentId || typeof agentId !== 'string') return {};
  const m = _store.get(agentId);
  if (!m) return {};
  const now = Date.now();
  const out = {};
  for (const [key, entry] of m) {
    if (entry.expiresAt && entry.expiresAt <= now) {
      m.delete(key);
      continue;
    }
    out[key] = entry.value;
  }
  return out;
}

/**
 * Read a single key from an agent's session.
 *
 * @param {string} agentId
 * @param {string} key
 * @returns {*} undefined if not set or expired
 */
function getSessionValue(agentId, key) {
  if (!agentId || !key) return undefined;
  const m = _store.get(agentId);
  if (!m) return undefined;
  const entry = m.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) {
    m.delete(key);
    return undefined;
  }
  return entry.value;
}

/**
 * Set a value on an agent's session.
 *
 * @param {string} agentId
 * @param {string} key
 * @param {*} value
 * @param {Object} [opts]
 * @param {number} [opts.ttlMs] - if provided, value is auto-cleared after ttlMs
 */
function setSession(agentId, key, value, opts = {}) {
  if (!agentId || !key) return;

  let m = _store.get(agentId);
  if (!m) {
    m = new Map();
    _store.set(agentId, m);
  }

  // Cancel any prior TTL on this key.
  const tk = _timerKey(agentId, key);
  const prevTimer = _timers.get(tk);
  if (prevTimer) {
    clearTimeout(prevTimer);
    _timers.delete(tk);
  }

  const entry = { value };
  if (Number.isFinite(opts.ttlMs) && opts.ttlMs > 0) {
    entry.expiresAt = Date.now() + opts.ttlMs;
    const timer = setTimeout(() => {
      const inner = _store.get(agentId);
      if (inner) inner.delete(key);
      _timers.delete(tk);
    }, opts.ttlMs);
    if (typeof timer.unref === 'function') timer.unref();
    _timers.set(tk, timer);
  }

  m.set(key, entry);
}

/**
 * Clear a single key from an agent's session.
 */
function clearSessionValue(agentId, key) {
  if (!agentId) return;
  const m = _store.get(agentId);
  if (!m) return;
  m.delete(key);
  const tk = _timerKey(agentId, key);
  const t = _timers.get(tk);
  if (t) {
    clearTimeout(t);
    _timers.delete(tk);
  }
}

/**
 * Clear all session state for an agent.
 */
function clearSession(agentId) {
  if (!agentId) return;
  _store.delete(agentId);
  // Drop any timers tagged with this agent.
  for (const tk of [..._timers.keys()]) {
    if (tk.startsWith(`${agentId}::`)) {
      clearTimeout(_timers.get(tk));
      _timers.delete(tk);
    }
  }
}

/**
 * Clear all session state for every agent. Used by the unit test, and by
 * test fixtures that need a clean slate.
 */
function clearAll() {
  for (const t of _timers.values()) clearTimeout(t);
  _timers.clear();
  _store.clear();
}

/**
 * Test introspection helper -- returns the raw store size. Not for production
 * code paths; production callers should use getSession().
 */
function _debugSize() {
  let total = 0;
  for (const m of _store.values()) total += m.size;
  return total;
}

module.exports = {
  getSession,
  getSessionValue,
  setSession,
  clearSessionValue,
  clearSession,
  clearAll,
  _debugSize,
};
