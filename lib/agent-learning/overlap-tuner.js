/**
 * Overlap Tuner (Phase 4 of self-learning arbitration)
 *
 * Weekly cron. Reads `arbitration-decisions` items over the last
 * `arbitrationOverlap.tunerWindowDays` (default 30). For each
 * candidate (threshold, maxPenalty) pair on a small grid, replays the
 * auction-phase fast path with overlap penalty applied at those
 * constants. Scores each candidate against an outcome-quality metric.
 *
 * Outcome quality is intentionally NOT a single LLM signal -- LLM
 * judges have systematic biases. The weighted-outcome formula is:
 *
 *   userFeedback === 'wrong'  -> hard veto, decision quality = 0
 *   reflectorScore           -> primary signal, weight 1.0 (range 0-1)
 *   counterfactualJudgment   -> tiebreaker, weight 0.3
 *
 * A decision with no outcome signals at all is excluded from the
 * quality calculation (not assumed neutral).
 *
 * Conservative gating (won't apply tuned constants unless):
 *   - sample size >= MIN_SAMPLES_TO_APPLY (100)
 *   - tuned-pair quality is at least IMPROVEMENT_FLOOR (5%) better
 *     than the seed pair's quality
 *
 * When a tune is applied, settings.arbitrationOverlap.tuned is set to
 * { threshold, maxPenalty, tunedAt, sampleSize, qualityDelta }. The
 * orchestrator reads this on every decision; new constants take
 * effect immediately.
 *
 * @file lib/agent-learning/overlap-tuner.js
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');

const DEFAULT_THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7];
const DEFAULT_MAX_PENALTIES = [0.2, 0.3, 0.5, 0.7];
const DEFAULT_WINDOW_DAYS = 30;
const MIN_SAMPLES_TO_APPLY = 100;
const IMPROVEMENT_FLOOR = 0.05; // tuned must be 5% better than seed
const ARBITRATION_SPACE_ID = 'arbitration-decisions';

// Outcome signal weights. Hard-coded here so the tuner's signal
// hierarchy is in one place; the orchestrator's decision-recorder
// already pre-joins the signals onto each decision item.
const SIGNAL_WEIGHTS = Object.freeze({
  userNegativeFeedbackVeto: 0,    // any 'wrong' -> outcomeQuality = 0
  reflectorScoreWeight: 1.0,
  counterfactualMatchWeight: 0.3,
});

class OverlapTuner {
  constructor(opts = {}) {
    this._log = opts.log || getLogQueue();
    this._spacesAPI = opts.spacesAPI || null;
    this._settingsManager = opts.settingsManager || null;
    this._applyOverlapPenalty = opts.applyOverlapPenalty || null;
    this._pickWinnerFastPath = opts.pickWinnerFastPath || null;

    this._thresholds = Array.isArray(opts.thresholds) ? opts.thresholds : DEFAULT_THRESHOLDS;
    this._maxPenalties = Array.isArray(opts.maxPenalties) ? opts.maxPenalties : DEFAULT_MAX_PENALTIES;
    this._minSamplesToApply = typeof opts.minSamplesToApply === 'number'
      ? opts.minSamplesToApply
      : MIN_SAMPLES_TO_APPLY;
    this._improvementFloor = typeof opts.improvementFloor === 'number'
      ? opts.improvementFloor
      : IMPROVEMENT_FLOOR;
  }

  _getSpacesAPI() {
    if (this._spacesAPI) return this._spacesAPI;
    try {
      const { getSpacesAPI } = require('../../spaces-api');
      this._spacesAPI = getSpacesAPI();
    } catch (_e) {
      this._spacesAPI = null;
    }
    return this._spacesAPI;
  }

  _getSettings() {
    if (this._settingsManager) return this._settingsManager;
    try {
      this._settingsManager = global.settingsManager || null;
    } catch (_e) {
      this._settingsManager = null;
    }
    return this._settingsManager;
  }

  _windowDays() {
    const s = this._getSettings();
    if (!s) return DEFAULT_WINDOW_DAYS;
    const v = s.get('arbitrationOverlap.tunerWindowDays');
    return typeof v === 'number' && v > 0 ? v : DEFAULT_WINDOW_DAYS;
  }

  /**
   * Read raw decision payloads from the arbitration-decisions Space
   * within the rolling window.
   */
  _readDecisions(now) {
    const api = this._getSpacesAPI();
    if (!api) return [];
    const storage = api.storage || api._storage;
    if (!storage) return [];
    const cutoff = (now || Date.now()) - this._windowDays() * 24 * 60 * 60 * 1000;
    const items = (storage.index?.items || [])
      .filter((i) => i.spaceId === ARBITRATION_SPACE_ID)
      .filter((i) => typeof i.timestamp === 'number' && i.timestamp >= cutoff);
    const decisions = [];
    for (const item of items) {
      try {
        const d = JSON.parse(item.content);
        if (d && d.taskId && Array.isArray(d.bids) && d.bids.length >= 2) {
          decisions.push(d);
        }
      } catch (_e) { /* skip malformed */ }
    }
    return decisions;
  }

  /**
   * Pure outcome-quality function. Returns null when no signals are
   * available (caller should exclude from aggregation rather than
   * treating as neutral).
   */
  outcomeQuality(outcome) {
    if (!outcome) return null;
    if (outcome.userFeedback === 'wrong') return 0; // hard veto
    let weighted = 0;
    let weight = 0;
    if (typeof outcome.reflectorScore === 'number') {
      const s = Math.max(0, Math.min(1, outcome.reflectorScore));
      weighted += s * SIGNAL_WEIGHTS.reflectorScoreWeight;
      weight += SIGNAL_WEIGHTS.reflectorScoreWeight;
    }
    if (outcome.counterfactualJudgment) {
      const cf = outcome.counterfactualJudgment === 'winner-better' ? 1
        : outcome.counterfactualJudgment === 'same' ? 0.6
          : 0.2;
      weighted += cf * SIGNAL_WEIGHTS.counterfactualMatchWeight;
      weight += SIGNAL_WEIGHTS.counterfactualMatchWeight;
    }
    return weight > 0 ? weighted / weight : null;
  }

  _ensureDeps() {
    if (!this._applyOverlapPenalty || !this._pickWinnerFastPath) {
      const hudCore = require('../hud-core');
      this._applyOverlapPenalty = this._applyOverlapPenalty || hudCore.applyOverlapPenalty;
      this._pickWinnerFastPath = this._pickWinnerFastPath || hudCore.pickWinnerFastPath;
    }
  }

  /**
   * Replay the fast-path decision under a given (threshold, maxPenalty)
   * config. Returns the resulting top-1 agentId, or null when no clear
   * winner emerges (no fast path firing == LLM would be needed).
   */
  _replayFastPath(decision, config) {
    const adjusted = this._applyOverlapPenalty(decision.bids, config);
    const fp = this._pickWinnerFastPath(adjusted);
    if (!fp || !Array.isArray(fp.winners) || fp.winners.length === 0) return null;
    return fp.winners[0];
  }

  /**
   * Score a single (threshold, maxPenalty) config against the corpus.
   * For each decision where the replay flips the winner, look up the
   * outcome quality of the *actual* winner. If the actual winner had
   * good outcome (high quality), flipping was bad -- subtract.
   * If the actual winner had poor outcome (low quality), flipping
   * could be good -- add. Decisions where the replay agrees with
   * the actual winner contribute 0 (neutral).
   *
   * @returns {{ score: number, flips: number, evaluable: number, sampleSize: number }}
   */
  scoreConfig(decisions, config) {
    let score = 0;
    let flips = 0;
    let evaluable = 0;
    let sampleSize = 0;
    for (const d of decisions) {
      if (!Array.isArray(d.bids) || d.bids.length < 2) continue;
      sampleSize += 1;
      const replayWinner = this._replayFastPath(d, config);
      if (!replayWinner) continue; // no clear winner under config
      if (replayWinner === d.chosenWinner) continue; // agrees, neutral
      flips += 1;
      const q = this.outcomeQuality(d.outcome);
      if (q === null) continue; // not evaluable
      evaluable += 1;
      // Neutral midpoint at 0.5: above means actual winner was good
      // (flipping is bad), below means it was bad (flipping is good).
      score += (0.5 - q);
    }
    return { score, flips, evaluable, sampleSize };
  }

  /**
   * Run one tuning pass. Returns the chosen (threshold, maxPenalty)
   * + sample size + diagnostics. Persists to settings only if the
   * conservative gates pass.
   *
   * @param {object} [opts]
   * @param {number} [opts.now]
   * @returns {Promise<{
   *   ranAt: number,
   *   sampleSize: number,
   *   evaluable: number,
   *   bestConfig?: { threshold, maxPenalty },
   *   seedConfig: { threshold, maxPenalty },
   *   bestScore: number,
   *   seedScore: number,
   *   qualityDelta: number,
   *   applied: boolean,
   *   reason?: string,
   * }>}
   */
  async runOnce(opts = {}) {
    this._ensureDeps();
    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const decisions = this._readDecisions(now);

    const seedConfig = { threshold: 0.5, maxPenalty: 0.3 };
    const seedResult = this.scoreConfig(decisions, seedConfig);

    if (seedResult.sampleSize < this._minSamplesToApply) {
      this._log.info('agent-learning', '[OverlapTuner] insufficient samples', {
        sampleSize: seedResult.sampleSize,
        minRequired: this._minSamplesToApply,
      });
      return {
        ranAt: now,
        sampleSize: seedResult.sampleSize,
        evaluable: seedResult.evaluable,
        seedConfig,
        bestScore: 0,
        seedScore: 0,
        qualityDelta: 0,
        applied: false,
        reason: 'insufficient-samples',
      };
    }

    let best = { config: seedConfig, result: seedResult };
    for (const t of this._thresholds) {
      for (const mp of this._maxPenalties) {
        if (t === seedConfig.threshold && mp === seedConfig.maxPenalty) continue;
        const cfg = { threshold: t, maxPenalty: mp };
        const res = this.scoreConfig(decisions, cfg);
        // Only replace if score is strictly better AND we have evaluable evidence.
        if (res.evaluable > 0 && res.score > best.result.score) {
          best = { config: cfg, result: res };
        }
      }
    }

    const qualityDelta = best.result.score - seedResult.score;
    const improvementRatio = Math.abs(seedResult.score) > 1e-9
      ? qualityDelta / Math.abs(seedResult.score)
      : qualityDelta; // when seed is 0, treat absolute delta as the ratio
    const meetsImprovementFloor = improvementRatio >= this._improvementFloor;

    if (best.config !== seedConfig && meetsImprovementFloor) {
      this._persist({
        threshold: best.config.threshold,
        maxPenalty: best.config.maxPenalty,
        tunedAt: now,
        sampleSize: seedResult.sampleSize,
        qualityDelta,
      });
      this._log.info('agent-learning', '[OverlapTuner] tuned constants applied', {
        threshold: best.config.threshold,
        maxPenalty: best.config.maxPenalty,
        sampleSize: seedResult.sampleSize,
        qualityDelta,
      });
      return {
        ranAt: now,
        sampleSize: seedResult.sampleSize,
        evaluable: seedResult.evaluable,
        bestConfig: best.config,
        seedConfig,
        bestScore: best.result.score,
        seedScore: seedResult.score,
        qualityDelta,
        applied: true,
      };
    }

    this._log.info('agent-learning', '[OverlapTuner] no tune applied (insufficient improvement)', {
      sampleSize: seedResult.sampleSize,
      seedScore: seedResult.score,
      bestScore: best.result.score,
      qualityDelta,
      improvementRatio,
    });
    return {
      ranAt: now,
      sampleSize: seedResult.sampleSize,
      evaluable: seedResult.evaluable,
      seedConfig,
      bestConfig: best.config,
      bestScore: best.result.score,
      seedScore: seedResult.score,
      qualityDelta,
      applied: false,
      reason: best.config === seedConfig ? 'seed-is-best' : 'below-improvement-floor',
    };
  }

  _persist(tuned) {
    const s = this._getSettings();
    if (!s || typeof s.set !== 'function') return;
    try {
      s.set('arbitrationOverlap.tuned', tuned);
    } catch (err) {
      this._log.warn('agent-learning', '[OverlapTuner] persist failed', { error: err.message });
    }
  }
}

let _instance = null;
function getOverlapTuner(opts) {
  if (!_instance) _instance = new OverlapTuner(opts);
  return _instance;
}

function _resetSingletonForTests() {
  _instance = null;
}

module.exports = {
  OverlapTuner,
  getOverlapTuner,
  DEFAULT_THRESHOLDS,
  DEFAULT_MAX_PENALTIES,
  MIN_SAMPLES_TO_APPLY,
  IMPROVEMENT_FLOOR,
  SIGNAL_WEIGHTS,
  _resetSingletonForTests,
};
