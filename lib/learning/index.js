/**
 * Learning Facade
 *
 * Single entry point for recording bid outcomes. Fans out to the three
 * stores that each own a slice of "learning":
 *
 *   - agent-stats  (src/voice-task-sdk/agent-stats.js)
 *                  raw outcome counts: totalBids, wins, successes,
 *                  failures, execution times, bid history.
 *   - meta-learning (lib/meta-learning/)
 *                  agent weighting + conflict resolution. Keyed on
 *                  agentType. Consumed by council mode + Phase 2's
 *                  learned-weight multiplier in unified-bidder.
 *   - agent-learning (lib/agent-learning/)
 *                  improvement loop. Keyed on agentId. Consumed to
 *                  generate prompt/UI patches when patterns emerge.
 *
 * See docs/internal/LEARNING-SUBSYSTEMS.md for the full boundary.
 *
 * Call sites (single-winner auction, council runner, flow gateway) MUST
 * use this facade instead of calling the subsystems directly. Keeps the
 * two learning loops from drifting apart again.
 *
 * All fan-outs are best-effort: a failure in one store never prevents
 * the others from recording. Errors are logged but swallowed.
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

let _cachedStats = null;
let _cachedMeta = null;
let _cachedAgentLearning = null;

/**
 * Resolve the agent-stats singleton lazily so this module loads cleanly
 * from Node-only test contexts.
 * @returns {Object|null}
 */
function _getAgentStats() {
  if (_cachedStats !== null) return _cachedStats;
  try {
    const { getAgentStats } = require('../../src/voice-task-sdk/agent-stats');
    _cachedStats = getAgentStats();
  } catch (_err) {
    _cachedStats = null;
  }
  return _cachedStats;
}

/**
 * Resolve the meta-learning system (created on demand).
 * Returns null if the subsystem is unavailable (minimum Node env).
 * @returns {Object|null}
 */
function _getMetaLearning() {
  if (_cachedMeta !== null) return _cachedMeta;
  try {
    // If evaluation-handlers initialized a singleton, prefer that one
    // so we share state with the eval HUD path.
    const ipc = require('../ipc/evaluation-handlers');
    if (ipc && typeof ipc.getMetaLearning === 'function') {
      const existing = ipc.getMetaLearning();
      if (existing) {
        _cachedMeta = existing;
        return _cachedMeta;
      }
    }
  } catch (_err) { /* handlers may not be loaded in this env */ }

  try {
    const { createMetaLearningSystem } = require('../meta-learning');
    _cachedMeta = createMetaLearningSystem();
  } catch (_err) {
    _cachedMeta = null;
  }
  return _cachedMeta;
}

/**
 * Resolve the agent-learning interaction collector singleton.
 * @returns {Object|null}
 */
function _getInteractionCollector() {
  if (_cachedAgentLearning !== null) return _cachedAgentLearning;
  try {
    const { InteractionCollector } = require('../agent-learning/interaction-collector');
    _cachedAgentLearning = new InteractionCollector();
  } catch (_err) {
    _cachedAgentLearning = null;
  }
  return _cachedAgentLearning;
}

/**
 * @typedef {Object} BidOutcome
 * @property {string}  agentId        - Concrete agent id (built-in or remote)
 * @property {string}  [agentType]    - Logical type key for meta-learning.
 *                                      Derived from agentId if omitted.
 * @property {string}  taskId         - Associated task id
 * @property {number}  confidence     - Bid confidence 0-1
 * @property {boolean} won            - Was this bid selected as the winner?
 * @property {boolean} success        - Did the agent execute successfully?
 *                                      (false if it wasn't asked to execute)
 * @property {number}  [durationMs]   - Execution duration
 * @property {string}  [error]        - Error message on failure
 * @property {Object}  [task]         - Snapshot of the task content/metadata
 *                                      used by agent-learning for improvement
 * @property {string}  [documentType] - Doc type for context-specific accuracy
 * @property {string}  [evaluationId] - Optional: council evaluation id the
 *                                      outcome belongs to; enables meta-
 *                                      learning accuracy updates
 * @property {boolean} [accuracy]     - Was the bid's confidence calibrated?
 *                                      (true if confidence >= 0.5 AND success,
 *                                       or confidence < 0.5 AND !won)
 */

/**
 * Record a single bid outcome across all learning stores.
 *
 * Safe to call from any bid-producing path (single-winner auction,
 * council mode, flow gateway). Returns a summary of which stores were
 * updated -- useful for tests and audit surfaces.
 *
 * @param {BidOutcome} outcome
 * @returns {Promise<{stats:boolean, meta:boolean, agentLearning:boolean}>}
 */
async function recordBidOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') {
    return { stats: false, meta: false, agentLearning: false };
  }
  const { agentId, taskId, confidence, won, success, durationMs, error } = outcome;
  if (!agentId || !taskId) {
    return { stats: false, meta: false, agentLearning: false };
  }

  const done = { stats: false, meta: false, agentLearning: false };

  // ---- 1. agent-stats: raw counters + bid history ----
  try {
    const stats = _getAgentStats();
    if (stats) {
      if (won) stats.recordWin(agentId);
      if (success === true) {
        stats.recordSuccess(agentId, durationMs);
      } else if (success === false && won) {
        // If the agent won but then failed, record failure with duration.
        stats.recordFailure(agentId, error || 'unknown', durationMs);
      }
      done.stats = true;
    }
  } catch (err) {
    log.warn('learning', 'agent-stats fan-out failed', { error: err.message });
  }

  // ---- 2. meta-learning: accuracy update (when eligible) ----
  // Only call meta-learning when we have enough signal to be meaningful.
  // A bid that never executed doesn't tell us anything about agent accuracy;
  // skip those to avoid noise in the weighting model.
  try {
    if (outcome.evaluationId && (success === true || success === false)) {
      const meta = _getMetaLearning();
      if (meta && meta.recordOutcome) {
        await meta.recordOutcome(outcome.evaluationId, {
          agentType: outcome.agentType || _deriveAgentType(agentId),
          agentId,
          taskId,
          accuracy: typeof outcome.accuracy === 'boolean'
            ? outcome.accuracy
            : (won ? success === true : confidence < 0.5),
          documentType: outcome.documentType || 'code',
          confidence,
          timestamp: Date.now(),
        });
        done.meta = true;
      }
    }
  } catch (err) {
    log.warn('learning', 'meta-learning fan-out failed', { error: err.message });
  }

  // ---- 3. agent-learning: interaction window for improvement loop ----
  try {
    const collector = _getInteractionCollector();
    if (collector && typeof collector.record === 'function') {
      await collector.record({
        agentId,
        taskId,
        taskContent: outcome.task?.content || outcome.task?.description || '',
        confidence,
        won: Boolean(won),
        success: success === true,
        failed: success === false,
        durationMs: typeof durationMs === 'number' ? durationMs : 0,
        error: error || null,
        timestamp: Date.now(),
      });
      done.agentLearning = true;
    }
  } catch (err) {
    log.warn('learning', 'agent-learning fan-out failed', { error: err.message });
  }

  return done;
}

// Minimum historical samples required before we trust the learned
// weight over the uniform 1.0 baseline. Matches what the meta-learning
// system uses internally for context-specific accuracy, but applied
// globally so an agent with zero history can't have its bid silently
// deflated to the 0.5 floor on first use.
const MIN_SAMPLES_FOR_LEARNED_WEIGHT = 5;

/**
 * Retrieve the learned weight multiplier for an agent. Phase 2's
 * consumer in unified-bidder calls this to scale bid confidence before
 * the winner-selection threshold check.
 *
 * Falls back to 1.0 (no adjustment) whenever:
 *   - The meta-learning system isn't available.
 *   - The agent has fewer than `MIN_SAMPLES_FOR_LEARNED_WEIGHT`
 *     recorded outcomes (avoids penalizing cold-start agents -- the
 *     underlying `getRecommendedWeight` starts from `overallAccuracy`
 *     which is 0 for a fresh memory, which would otherwise clamp to
 *     the 0.5 floor and block new agents from winning).
 *   - An error occurs reading the weight.
 *
 * @param {string} agentId
 * @param {Object} [context]
 * @param {string} [context.agentType]    - Override for weighting key
 * @param {string} [context.documentType] - Doc type for context-aware weight
 * @returns {number} 0.5 - 1.5 (or 1.0 when insufficient data)
 */
function getLearnedWeight(agentId, context = {}) {
  if (!agentId) return 1.0;
  try {
    const meta = _getMetaLearning();
    if (!meta || !meta.agentMemory || typeof meta.agentMemory.getRecommendedWeight !== 'function') {
      return 1.0;
    }
    const agentType = context.agentType || _deriveAgentType(agentId);

    // Cold-start guard. `getMemory` auto-creates a fresh entry on lookup,
    // so we can always read `totalEvaluations` (or a similar counter).
    if (typeof meta.agentMemory.getMemory === 'function') {
      const memory = meta.agentMemory.getMemory(agentType);
      const samples = Number(
        memory?.totalEvaluations
          ?? memory?.totalOutcomes
          ?? memory?.samples
          ?? 0
      );
      if (!isFinite(samples) || samples < MIN_SAMPLES_FOR_LEARNED_WEIGHT) {
        return 1.0;
      }
    }

    const weight = meta.agentMemory.getRecommendedWeight(agentType, context.documentType);
    if (typeof weight !== 'number' || !isFinite(weight)) return 1.0;
    // Hard clamp in case the subsystem returns something unexpected.
    return Math.max(0.5, Math.min(1.5, weight));
  } catch (_err) {
    return 1.0;
  }
}

/**
 * Snapshot of what the facade knows about an agent. Useful for the HUD
 * and for Phase 2's A/B logging.
 *
 * @param {string} agentId
 * @returns {Object}
 */
function getAgentSnapshot(agentId) {
  const out = {
    agentId,
    agentType: _deriveAgentType(agentId),
    stats: null,
    weight: 1.0,
    memory: null,
  };
  try {
    const stats = _getAgentStats();
    if (stats) out.stats = stats.getStats(agentId);
  } catch (_err) { /* ignore */ }
  out.weight = getLearnedWeight(agentId);
  try {
    const meta = _getMetaLearning();
    if (meta && meta.agentMemory && typeof meta.agentMemory.getMemory === 'function') {
      out.memory = meta.agentMemory.getMemory(out.agentType);
    }
  } catch (_err) { /* ignore */ }
  return out;
}

// ==================== INTERNAL ====================

function _deriveAgentType(agentId) {
  if (typeof agentId !== 'string') return 'unknown';
  return agentId.toLowerCase().replace(/-agent$/, '');
}

/**
 * Test-only: clear cached singletons so subsequent calls re-resolve.
 */
function _resetLearningForTests() {
  _cachedStats = null;
  _cachedMeta = null;
  _cachedAgentLearning = null;
}

module.exports = {
  recordBidOutcome,
  getLearnedWeight,
  getAgentSnapshot,
  _deriveAgentType,
  _resetLearningForTests,
};
