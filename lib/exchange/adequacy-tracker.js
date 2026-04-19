/**
 * Adequacy Tracker -- Phase 5 multi-turn elicitation loop
 *
 * Tracks turn counts for tasks whose agents want to keep asking the
 * user until the answer is usable, not just until the user speaks
 * once. Works alongside the existing `needsInput` protocol in
 * `src/voice-task-sdk/exchange-bridge.js`.
 *
 * Protocol:
 *
 *   Agent returns:
 *     {
 *       needsInput: {
 *         prompt: 'What is the target audience?',
 *         adequacy: {
 *           requires: 'a specific demographic',  // human description
 *           maxTurns: 3,                         // hard cap
 *           retryPrompt: 'Could you be more specific?'  // optional
 *         }
 *       }
 *     }
 *
 *   Caller flow (in exchange-bridge.routePendingInput):
 *     1. On each user response, call `tracker.increment(taskId, prompt, answer)`.
 *     2. Before re-dispatching to the agent, call `tracker.shouldContinue(taskId, maxTurns)`.
 *     3. If the agent again returns needsInput with an adequacy block, loop.
 *     4. If shouldContinue returns false, call `tracker.exhausted(taskId)` and
 *        resolve the task with a graceful "couldn't collect adequate input"
 *        fallback.
 *
 * State is in-memory keyed by taskId. A TTL (5 min, matching the
 * hud-api needs-input TTL) prevents abandoned loops from leaking.
 * Explicit `clear(taskId)` on successful completion is preferred.
 *
 * No LLM calls here. Pure state tracking so tests are fast and
 * deterministic.
 */

'use strict';

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_TURNS = 3;

class AdequacyTracker {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
    // taskId -> { taskId, turns, history: [{prompt, answer, at}], adequacy, createdAt }
    this._state = new Map();
  }

  /**
   * Open a new adequacy loop for a task. Called when the agent's first
   * `needsInput.adequacy` is observed.
   *
   * @param {string} taskId
   * @param {Object} adequacy - The block copied from needsInput.adequacy
   * @returns {Object}
   */
  open(taskId, adequacy) {
    if (!taskId) throw new Error('AdequacyTracker.open: taskId required');
    const now = Date.now();
    const entry = {
      taskId,
      turns: 0,
      history: [],
      adequacy: adequacy && typeof adequacy === 'object' ? adequacy : {},
      createdAt: now,
      updatedAt: now,
      exhausted: false,
    };
    this._state.set(taskId, entry);
    return entry;
  }

  /**
   * Record a user response to the current prompt, incrementing the
   * turn count. Returns the updated entry. If no entry exists (no
   * `open()` was called), the tracker opens one implicitly so loose
   * call sites still work; this matches the existing needsInput flow
   * where the initial prompt might have arrived before any adequacy
   * block was declared.
   *
   * @param {string} taskId
   * @param {string} prompt
   * @param {string} answer
   * @returns {Object}
   */
  increment(taskId, prompt, answer) {
    let entry = this._state.get(taskId);
    if (!entry) entry = this.open(taskId, {});
    entry.turns += 1;
    entry.updatedAt = Date.now();
    entry.history.push({
      prompt: typeof prompt === 'string' ? prompt : '',
      answer: typeof answer === 'string' ? answer : '',
      at: entry.updatedAt,
    });
    this._gc();
    return entry;
  }

  /**
   * Decide whether to keep looping. True when we have not yet hit the
   * maxTurns cap (from the adequacy block or the explicit override).
   *
   * @param {string} taskId
   * @param {number} [explicitMax]
   * @returns {{ ok: boolean, turn: number, maxTurns: number, reason?: string }}
   */
  shouldContinue(taskId, explicitMax) {
    const entry = this._state.get(taskId);
    if (!entry) {
      return { ok: true, turn: 0, maxTurns: explicitMax || DEFAULT_MAX_TURNS };
    }
    if (entry.exhausted) {
      return { ok: false, turn: entry.turns, maxTurns: 0, reason: 'already-exhausted' };
    }
    const maxTurns = typeof explicitMax === 'number'
      ? explicitMax
      : (typeof entry.adequacy?.maxTurns === 'number' ? entry.adequacy.maxTurns : DEFAULT_MAX_TURNS);
    if (entry.turns >= maxTurns) {
      return { ok: false, turn: entry.turns, maxTurns, reason: 'max-turns-reached' };
    }
    return { ok: true, turn: entry.turns, maxTurns };
  }

  /**
   * Mark a loop as exhausted. Called by routePendingInput when
   * shouldContinue returns false. Keeps history available for
   * diagnostic / HUD surfaces but forbids further increments.
   */
  exhausted(taskId) {
    const entry = this._state.get(taskId);
    if (!entry) return null;
    entry.exhausted = true;
    entry.updatedAt = Date.now();
    return entry;
  }

  /**
   * Close and drop an adequacy entry. Call on successful completion
   * OR task cancellation.
   */
  clear(taskId) {
    return this._state.delete(taskId);
  }

  /**
   * Read-only snapshot of the loop state for HUD / diagnostics.
   */
  getEntry(taskId) {
    const entry = this._state.get(taskId);
    return entry ? { ...entry, history: [...entry.history] } : null;
  }

  /**
   * Convenience: the current turn count for a task (0 if unknown).
   */
  getTurnCount(taskId) {
    const entry = this._state.get(taskId);
    return entry ? entry.turns : 0;
  }

  /**
   * Convenience: answer history for a task (oldest-first).
   */
  getHistory(taskId) {
    const entry = this._state.get(taskId);
    return entry ? [...entry.history] : [];
  }

  /**
   * Active loop count (for diagnostics / stats).
   */
  size() {
    return this._state.size;
  }

  /**
   * Format a synthetic "exhausted" fallback result that `routePendingInput`
   * can return to the caller when the loop cannot continue. Uses the
   * agent's declared requirement as the user-facing explanation when
   * one was provided.
   */
  buildExhaustedResult(taskId) {
    const entry = this._state.get(taskId);
    const requires = entry?.adequacy?.requires;
    const turns = entry?.turns || 0;
    const max = entry?.adequacy?.maxTurns || DEFAULT_MAX_TURNS;
    const message = requires
      ? `I couldn't get a clear answer (${requires}) after ${turns} attempts. Let's try again later.`
      : `I couldn't get an adequate answer after ${turns} attempts. Let's try again later.`;
    return {
      success: false,
      message,
      adequacyExhausted: true,
      turns,
      maxTurns: max,
    };
  }

  /** Purge entries whose last update is older than ttlMs. */
  _gc() {
    if (this._state.size < 16) return; // cheap short-circuit
    const cutoff = Date.now() - this.ttlMs;
    for (const [taskId, entry] of this._state) {
      if (entry.updatedAt < cutoff) this._state.delete(taskId);
    }
  }
}

// ==================== SINGLETON ====================

let _instance = null;

function getAdequacyTracker() {
  if (!_instance) _instance = new AdequacyTracker();
  return _instance;
}

function _resetAdequacyTrackerForTests() {
  _instance = null;
}

module.exports = {
  AdequacyTracker,
  getAdequacyTracker,
  _resetAdequacyTrackerForTests,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_TURNS,
};
