/**
 * Per-Agent Bid Calibrator (Phase 5 of self-learning arbitration)
 *
 * Some agents systematically over-bid on classes they don't actually
 * handle well; others under-bid where they would have done fine.
 * Confidence is a self-report; outcome is the truth. Calibration
 * closes the gap by computing per-(agent, task-class) shrinkage from
 * historical outcomes and applying it pre-arbitration.
 *
 * Cycle:
 *   1. Weekly cron reads the arbitration-decisions Space.
 *   2. For each (agentId, classKey) bucket, compute
 *        observedAccuracy = mean of weighted outcome quality on wins
 *        meanConfidence    = mean confidence on wins
 *        calibrationError  = meanConfidence - observedAccuracy
 *        shrinkage         = clamp(calibrationError, 0, MAX_SHRINKAGE)
 *      (We only correct OVER-confidence today; under-confidence
 *       would require a boost which is riskier and is left for a
 *       follow-up.)
 *   3. Skip pairs with fewer than MIN_SAMPLES_FOR_CALIBRATION wins
 *      (default 50). Below threshold, no shrinkage applied for the
 *      pair -- no noisy early-data shrinkage.
 *   4. Persist the per-agent calibration table to that agent's
 *      memory file under a "Calibration" section. The memory curator
 *      already grooms the file; the orchestrator reads it on every
 *      decision (cached in-memory by the memory store).
 *
 * Application order (in master-orchestrator.evaluate):
 *
 *   bids -> applyRules (Phase 3, structural)
 *        -> calibrate    (Phase 5, per-agent)        <-- this module
 *        -> overlap      (Phase 4, cross-agent)
 *        -> pickWinnerFastPath / LLM evaluator
 *
 * Calibration runs BEFORE overlap because:
 *   - It corrects per-agent over-confidence at the source. The bid
 *     overlap penalty then operates on honest confidences.
 *   - If overlap ran first, an inflated bid could suppress a
 *     more-accurate competitor before the calibrator could correct
 *     the inflation.
 *
 * The signal-weighting (userFeedback hard veto > reflectorScore >
 * counterfactual) matches the overlap-tuner's `outcomeQuality` so
 * the same outcome label drives both.
 *
 * @file lib/agent-learning/bid-calibrator.js
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const { normalizeQueryClass } = require('./slow-success-tracker');

// Test-injection seam: the lazy require lets tests substitute
// getAgentMemory without going through Vitest's CJS-mock interception
// (which doesn't reliably intercept `require()` inside a transitively-
// loaded CJS module). Production code uses the real store.
let _getAgentMemoryImpl = null;
function _resolveGetAgentMemory() {
  if (_getAgentMemoryImpl) return _getAgentMemoryImpl;
  return require('../agent-memory-store').getAgentMemory;
}
function setAgentMemoryGetterForTests(fn) { _getAgentMemoryImpl = fn || null; }

const MIN_SAMPLES_FOR_CALIBRATION = 50;
const MAX_SHRINKAGE = 0.4;
const DEFAULT_WINDOW_DAYS = 30;
const ARBITRATION_SPACE_ID = 'arbitration-decisions';
const CALIBRATION_SECTION = 'Calibration';

const SIGNAL_WEIGHTS = Object.freeze({
  reflectorScoreWeight: 1.0,
  counterfactualMatchWeight: 0.3,
});

/**
 * Pure outcome-quality function. Mirrors overlap-tuner.outcomeQuality
 * so calibration and overlap-tuner see the same truth.
 */
function outcomeQuality(outcome) {
  if (!outcome) return null;
  if (outcome.userFeedback === 'wrong') return 0;
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

/**
 * Compute per-(agent, class) calibration data from a list of
 * arbitration-decision payloads. Pure: no I/O, no side effects.
 *
 * Only "wins" count -- we calibrate confidence-on-wins because the
 * recorded confidence-when-not-winning is harder to evaluate (the
 * agent didn't run, so we have no ground-truth outcome).
 *
 * Returns a Map: agentId -> classKey -> { samples, meanConfidence,
 *                                          observedAccuracy, calibrationError,
 *                                          shrinkage, applicable }.
 *
 * `applicable` is true when samples >= MIN_SAMPLES_FOR_CALIBRATION
 * AND shrinkage > 0.
 */
function computeCalibration(decisions, opts = {}) {
  const minSamples = typeof opts.minSamples === 'number'
    ? opts.minSamples
    : MIN_SAMPLES_FOR_CALIBRATION;
  const maxShrinkage = typeof opts.maxShrinkage === 'number'
    ? opts.maxShrinkage
    : MAX_SHRINKAGE;

  /** @type {Map<string, Map<string, { confSum, qSum, n }>>} */
  const buckets = new Map();

  for (const d of decisions || []) {
    if (!d || !d.chosenWinner || !Array.isArray(d.bids)) continue;
    const winnerBid = d.bids.find((b) => b && b.agentId === d.chosenWinner);
    if (!winnerBid) continue;
    const q = outcomeQuality(d.outcome);
    if (q === null) continue; // can't evaluate; skip
    const cls = normalizeQueryClass(d.content || '');
    if (!cls) continue;

    const aMap = buckets.get(d.chosenWinner) || new Map();
    const cur = aMap.get(cls) || { confSum: 0, qSum: 0, n: 0 };
    cur.confSum += typeof winnerBid.confidence === 'number' ? winnerBid.confidence : 0;
    cur.qSum += q;
    cur.n += 1;
    aMap.set(cls, cur);
    buckets.set(d.chosenWinner, aMap);
  }

  // Reduce to the per-pair calibration record.
  const out = new Map();
  for (const [agentId, classMap] of buckets) {
    const reduced = new Map();
    for (const [classKey, agg] of classMap) {
      const meanConfidence = agg.n > 0 ? agg.confSum / agg.n : 0;
      const observedAccuracy = agg.n > 0 ? agg.qSum / agg.n : 0;
      const calibrationError = meanConfidence - observedAccuracy;
      const shrinkage = Math.max(0, Math.min(maxShrinkage, calibrationError));
      const applicable = agg.n >= minSamples && shrinkage > 0;
      reduced.set(classKey, {
        samples: agg.n,
        meanConfidence,
        observedAccuracy,
        calibrationError,
        shrinkage,
        applicable,
      });
    }
    out.set(agentId, reduced);
  }
  return out;
}

/**
 * Look up calibration shrinkage for a given (agentId, taskContent) pair.
 * Reads from the agent's memory file via the existing memory store.
 *
 * Returns 0 (no shrinkage) when:
 *   - agent has no Calibration section
 *   - the task's classKey isn't tracked
 *   - the pair has fewer than MIN_SAMPLES_FOR_CALIBRATION
 *
 * Cached at the memory-store layer so this is cheap on the hot path.
 */
function getShrinkage(agentId, taskContent) {
  if (!agentId || !taskContent) return 0;
  let memory;
  try {
    memory = _resolveGetAgentMemory()(agentId);
  } catch (_e) {
    return 0;
  }
  if (!memory || typeof memory.getSection !== 'function') return 0;
  const cls = normalizeQueryClass(taskContent);
  if (!cls) return 0;
  let table;
  try {
    const section = memory.getSection(CALIBRATION_SECTION);
    if (!section) return 0;
    table = parseCalibrationSection(section);
  } catch (_e) {
    return 0;
  }
  const entry = table.get(cls);
  if (!entry || !entry.applicable) return 0;
  return Math.max(0, Math.min(MAX_SHRINKAGE, entry.shrinkage || 0));
}

/**
 * Apply calibration to a bid. Returns a new bid object (immutable
 * contract, same as overlap penalty).
 *
 * @param {object} bid
 * @param {object} task
 * @returns {object} new bid (or original if no shrinkage)
 */
function calibrate(bid, task) {
  if (!bid || !bid.agentId) return bid;
  const shrinkage = getShrinkage(bid.agentId, task?.content || '');
  if (shrinkage <= 0) return bid;
  const factor = Math.max(0, 1 - shrinkage);
  const before = typeof bid.confidence === 'number' ? bid.confidence : 0;
  return {
    ...bid,
    confidence: before * factor,
    score: typeof bid.score === 'number' ? bid.score * factor : before * factor,
    _calibrationAdjustment: {
      shrinkage,
      factor,
      before,
      after: before * factor,
    },
  };
}

/**
 * Render the calibration table as a Markdown section body so it can
 * live alongside hand-edited memory sections without confusing the
 * curator.
 */
function renderSection(perClassMap) {
  if (!perClassMap || perClassMap.size === 0) {
    return '*No calibration data yet.*';
  }
  const lines = [
    '*Auto-generated by bid-calibrator. Below MIN_SAMPLES per class is recorded but not applied.*',
    '',
  ];
  for (const [cls, entry] of perClassMap) {
    const flag = entry.applicable ? 'applied' : 'recorded';
    lines.push(
      `- ${cls}: shrinkage=${entry.shrinkage.toFixed(2)} | meanConf=${entry.meanConfidence.toFixed(2)} | accuracy=${entry.observedAccuracy.toFixed(2)} | n=${entry.samples} | ${flag}`,
    );
  }
  return lines.join('\n');
}

/**
 * Parse a Calibration section back into a Map. The format is the
 * inverse of renderSection. Resilient to extra whitespace/comments.
 */
function parseCalibrationSection(text) {
  const out = new Map();
  if (typeof text !== 'string' || !text) return out;
  const lines = text.split(/\r?\n/);
  // - bucket:weather: shrinkage=0.12 | meanConf=0.80 | accuracy=0.68 | n=72 | applied
  // Allow leading whitespace (template-literal indentation in tests
  // and any future hand-edits); the rest of the line shape is rigid.
  const lineRe = /^\s*[-*]\s*([^:]+:\S+):\s*shrinkage=([0-9.]+)\s*\|\s*meanConf=([0-9.]+)\s*\|\s*accuracy=([0-9.]+)\s*\|\s*n=(\d+)\s*\|\s*(applied|recorded)\b/i;
  for (const raw of lines) {
    const m = raw.match(lineRe);
    if (!m) continue;
    out.set(m[1], {
      shrinkage: parseFloat(m[2]),
      meanConfidence: parseFloat(m[3]),
      observedAccuracy: parseFloat(m[4]),
      samples: parseInt(m[5], 10),
      applicable: m[6].toLowerCase() === 'applied',
    });
  }
  return out;
}

// ============================================================
// Tuner cron
// ============================================================

class BidCalibrator {
  constructor(opts = {}) {
    this._log = opts.log || getLogQueue();
    this._spacesAPI = opts.spacesAPI || null;
    this._settingsManager = opts.settingsManager || null;
    this._minSamples = typeof opts.minSamples === 'number'
      ? opts.minSamples
      : MIN_SAMPLES_FOR_CALIBRATION;
    this._maxShrinkage = typeof opts.maxShrinkage === 'number'
      ? opts.maxShrinkage
      : MAX_SHRINKAGE;
    this._getMemory = opts.getMemory || _resolveGetAgentMemory();
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

  _windowDays() {
    if (this._settingsManager?.get) {
      const v = this._settingsManager.get('arbitrationDecisions.retentionDays');
      // Calibration window matches the retention window, capped at 30 if larger.
      if (typeof v === 'number' && v > 0) return Math.min(v, DEFAULT_WINDOW_DAYS);
    }
    return DEFAULT_WINDOW_DAYS;
  }

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
        if (d && d.taskId) decisions.push(d);
      } catch (_e) { /* skip malformed */ }
    }
    return decisions;
  }

  /**
   * Run one calibration pass. Returns a summary; on success, writes
   * each agent's Calibration section to their memory file.
   *
   * @param {object} [opts]
   * @returns {Promise<{
   *   ranAt: number,
   *   sampleSize: number,
   *   agentsCalibrated: number,
   *   agents: Array<{ agentId, classes: number, applied: number }>,
   * }>}
   */
  async runOnce(opts = {}) {
    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const decisions = this._readDecisions(now);

    const calibration = computeCalibration(decisions, {
      minSamples: this._minSamples,
      maxShrinkage: this._maxShrinkage,
    });

    const perAgentSummary = [];
    for (const [agentId, classMap] of calibration) {
      const applied = Array.from(classMap.values()).filter((e) => e.applicable).length;
      perAgentSummary.push({ agentId, classes: classMap.size, applied });

      try {
        const memory = this._getMemory(agentId);
        if (!memory) continue;
        if (typeof memory.load === 'function') await memory.load();
        const sectionText = renderSection(classMap);
        if (typeof memory.updateSection === 'function') {
          memory.updateSection(CALIBRATION_SECTION, sectionText);
        }
        if (typeof memory.save === 'function') await memory.save();
      } catch (err) {
        this._log.warn('agent-learning', '[BidCalibrator] memory write failed', {
          agentId,
          error: err.message,
        });
      }
    }

    this._log.info('agent-learning', '[BidCalibrator] cycle complete', {
      sampleSize: decisions.length,
      agentsCalibrated: perAgentSummary.length,
      windowDays: this._windowDays(),
    });

    return {
      ranAt: now,
      sampleSize: decisions.length,
      agentsCalibrated: perAgentSummary.length,
      agents: perAgentSummary,
    };
  }
}

let _instance = null;
function getBidCalibrator(opts) {
  if (!_instance) _instance = new BidCalibrator(opts);
  return _instance;
}

function _resetSingletonForTests() {
  _instance = null;
}

module.exports = {
  BidCalibrator,
  getBidCalibrator,
  computeCalibration,
  outcomeQuality,
  calibrate,
  getShrinkage,
  renderSection,
  parseCalibrationSection,
  setAgentMemoryGetterForTests,
  CALIBRATION_SECTION,
  MIN_SAMPLES_FOR_CALIBRATION,
  MAX_SHRINKAGE,
  SIGNAL_WEIGHTS,
  _resetSingletonForTests,
};
