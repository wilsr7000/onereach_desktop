/**
 * Agent Transition Tracker (Phase 2 / multi-voice bridging)
 *
 * Remembers which agent spoke last in a given conversation context so
 * the pipeline can decide whether the next agent's turn is a handoff
 * (voice change) or a continuation (same agent).
 *
 * Keyed by a "context key" chosen by the caller -- usually the toolId
 * that submitted the task, or a toolId+sessionId combo. Entries have
 * a TTL so a stale context from hours ago does not trigger a bogus
 * handoff bridge on the next unrelated task.
 *
 * Pure in-memory. Good enough for a single Electron process; fully
 * replaced by a merge field during the GSX migration later.
 *
 * Example:
 *
 *   tracker.recordAgent('voice', 'time-agent');
 *   ...
 *   if (tracker.hasTransition('voice', 'calendar-query-agent')) {
 *     const phrase = buildHandoffPhrase({ ... });
 *   }
 *   tracker.recordAgent('voice', 'calendar-query-agent');
 */

'use strict';

const DEFAULT_TTL_MS = 5 * 60 * 1000;  // 5 minutes

class AgentTransitionTracker {
  /**
   * @param {object} [options]
   * @param {number} [options.ttlMs]      - entry TTL in ms
   * @param {() => number} [options.now]  - override clock for tests
   */
  constructor(options = {}) {
    this._ttlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0
      ? options.ttlMs
      : DEFAULT_TTL_MS;
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();

    /** @type {Map<string, { agentId: string, recordedAt: number }>} */
    this._entries = new Map();
  }

  /**
   * Record that an agent just spoke in the given context.
   * @param {string} contextKey
   * @param {string} agentId
   */
  recordAgent(contextKey, agentId) {
    if (!contextKey || !agentId) return;
    this._entries.set(contextKey, {
      agentId,
      recordedAt: this._now(),
    });
  }

  /**
   * Return the most recent non-stale agent for the context, or null.
   * @param {string} contextKey
   * @returns {string|null}
   */
  getLastAgent(contextKey) {
    if (!contextKey) return null;
    const entry = this._entries.get(contextKey);
    if (!entry) return null;
    if (this._now() - entry.recordedAt > this._ttlMs) {
      this._entries.delete(contextKey);
      return null;
    }
    return entry.agentId;
  }

  /**
   * Return true iff a non-stale previous agent is recorded for this
   * context and it differs from the one about to speak.
   * @param {string} contextKey
   * @param {string} nextAgentId
   * @returns {boolean}
   */
  hasTransition(contextKey, nextAgentId) {
    const last = this.getLastAgent(contextKey);
    if (!last || !nextAgentId) return false;
    return last !== nextAgentId;
  }

  /**
   * Drop one context key.
   * @param {string} contextKey
   */
  forget(contextKey) {
    this._entries.delete(contextKey);
  }

  /**
   * Drop all keys. Useful between tests.
   */
  clear() {
    this._entries.clear();
  }

  /**
   * Number of live entries (stale entries are NOT removed lazily until
   * touched). Exposed for tests / diagnostics.
   * @returns {number}
   */
  size() {
    return this._entries.size;
  }
}

// Shared singleton for production use. Tests should prefer building
// their own instance with an injected clock.
let _shared = null;
function getSharedTracker() {
  if (!_shared) _shared = new AgentTransitionTracker();
  return _shared;
}

module.exports = {
  AgentTransitionTracker,
  DEFAULT_TTL_MS,
  getSharedTracker,
};
