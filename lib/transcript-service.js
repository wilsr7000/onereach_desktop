/**
 * Transcript Service - Rolling conversation store + pending input state.
 *
 * Replaces the bare `pendingInputContexts` Map that lived in exchange-bridge.js
 * and adds a queryable rolling buffer of user/agent speech entries.
 *
 * Usage (main process):
 *   const { getTranscriptService } = require('./lib/transcript-service');
 *   const ts = getTranscriptService();
 *   ts.push({ text: 'hello', speaker: 'user' });
 *   ts.getRecent(5);
 *   ts.setPending('weather', { taskId, context });
 */

'use strict';

const EventEmitter = require('events');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

const DEFAULT_MAX_ENTRIES = 200; // ~10 min of conversation at normal pace

class TranscriptService extends EventEmitter {
  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    super();
    this.entries = [];
    this.maxEntries = maxEntries;
    this.sessionId = null;

    // Pending input state (replaces pendingInputContexts Map)
    this._pending = new Map(); // agentId -> { taskId, agentId, context, field, options }

    this.newSession();
  }

  // ── Transcript buffer ──────────────────────────────────────────────

  /**
   * Push a transcript entry into the rolling buffer.
   * @param {Object} entry
   * @param {string} entry.text    - The spoken/transcribed text
   * @param {string} entry.speaker - 'user' | 'agent'
   * @param {string} [entry.agentId] - Which agent spoke (for agent entries)
   * @param {boolean} [entry.isFinal=true]
   * @returns {Object} The stored record (with id + timestamp)
   */
  push(entry) {
    if (!entry || !entry.text) return null;

    const record = {
      id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text: entry.text,
      speaker: entry.speaker || 'user',
      isFinal: entry.isFinal !== undefined ? entry.isFinal : true,
      agentId: entry.agentId || null,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
    };

    this.entries.push(record);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    this.emit('entry', record);
    return record;
  }

  /**
   * Get the most recent N entries.
   */
  getRecent(n = 20) {
    return this.entries.slice(-n);
  }

  /**
   * Get entries since an ISO timestamp.
   */
  getSince(isoTimestamp) {
    return this.entries.filter((e) => e.timestamp >= isoTimestamp);
  }

  /**
   * Get entries filtered by speaker.
   */
  getBySpeaker(speaker, n = 20) {
    return this.entries.filter((e) => e.speaker === speaker).slice(-n);
  }

  // ── Pending input state (replaces pendingInputContexts) ────────────

  /**
   * Register an agent as waiting for user input.
   */
  setPending(agentId, context) {
    this._pending.set(agentId, context);
    log.info('voice', 'TranscriptService: pending input set', {
      agentId,
      pendingCount: this._pending.size,
    });
  }

  /**
   * Check if any agent is waiting for input.
   */
  hasPending() {
    return this._pending.size > 0;
  }

  /**
   * Get the pending context for a specific agent.
   */
  getPending(agentId) {
    return this._pending.get(agentId);
  }

  /**
   * Remove a pending input context.
   */
  clearPending(agentId) {
    this._pending.delete(agentId);
  }

  /**
   * Get all pending agent IDs.
   */
  getPendingAgentIds() {
    return Array.from(this._pending.keys());
  }

  /**
   * Pick the pending agent to route to. Prefers targetAgentId if provided
   * and pending, otherwise returns the first pending agent.
   * Returns { agentId, context } or null.
   */
  pickPending(targetAgentId) {
    if (this._pending.size === 0) return null;

    if (targetAgentId && this._pending.has(targetAgentId)) {
      const context = this._pending.get(targetAgentId);
      this._pending.delete(targetAgentId);
      return { agentId: targetAgentId, context };
    }

    const [agentId, context] = this._pending.entries().next().value;
    this._pending.delete(agentId);
    return { agentId, context };
  }

  /**
   * Snapshot of pending state for debugging / API.
   */
  getPendingSnapshot() {
    const snapshot = {};
    for (const [agentId, ctx] of this._pending) {
      snapshot[agentId] = { taskId: ctx.taskId, field: ctx.field };
    }
    return snapshot;
  }

  // ── Session management ─────────────────────────────────────────────

  /**
   * Start a new session. Clears buffer and pending state.
   */
  newSession() {
    this.sessionId = `sess-${Date.now()}`;
    this.entries = [];
    this._pending.clear();
    return this.sessionId;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────

let _instance = null;

function getTranscriptService() {
  if (!_instance) {
    _instance = new TranscriptService();
  }
  return _instance;
}

module.exports = { getTranscriptService, TranscriptService };
