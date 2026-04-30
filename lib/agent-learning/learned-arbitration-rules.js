/**
 * Learned Arbitration Rules (Phase 3 of self-learning arbitration)
 *
 * Read/write store for routing rules that the user has accepted from
 * the transcript-reviewer's proposals. Consulted by the master
 * orchestrator at decision time, before pickWinnerFastPath.
 *
 * Why a JSON file rather than a Space:
 *   - Rules are read on EVERY arbitration decision. Spaces are
 *     designed for items + tags + queries, not for sub-millisecond
 *     read access in the auction's hot path.
 *   - The file is small (rules are few). Atomic rename keeps writes
 *     consistent across concurrent appenders.
 *   - The transcripts-review Space is the durable history of what
 *     was proposed; this file is just the active set.
 *
 * Supported rule types:
 *   - shrink         multiply a target agent's confidence by (1 - magnitude)
 *                    when the task matches the rule's conditions
 *   - boost          multiply by (1 + magnitude); capped at confidence=1
 *   - suppress-pair  when both agents in target=[a,b] bid, drop the
 *                    lower-confidence one
 *   - route-class    force-prefer a single agent for matching task
 *                    class (sets others' confidence to 0)
 *
 * Conditions:
 *   - taskContentMatchesRegex   string regex tested against task.content
 *   - taskClass                 matches a slow-success-tracker bucket
 *                               (the orchestrator can pass classifyBucket
 *                               from temporal-context if available)
 *
 * @file lib/agent-learning/learned-arbitration-rules.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getLogQueue } = require('../log-event-queue');

const VALID_RULE_TYPES = Object.freeze(new Set([
  'shrink', 'boost', 'suppress-pair', 'route-class',
]));

const VALID_ACCEPTED_BY = Object.freeze(new Set(['user', 'auto']));

// File schema is tiny; the rules array is bounded by the user's
// review activity. Hard cap so a runaway acceptance flow can't bloat
// the file.
const MAX_RULES = 500;

class LearnedArbitrationRulesStore {
  constructor(opts = {}) {
    this._log = opts.log || getLogQueue();
    this._diskPath = null;
    this._rules = [];
    this._updatedAt = 0;
  }

  /**
   * Initialise from disk. `userDataDir` is the electron userData
   * directory; in tests pass any writable directory.
   */
  init(userDataDir) {
    if (!userDataDir) return this;
    try {
      const dir = path.join(userDataDir, 'agent-learning');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this._diskPath = path.join(dir, 'learned-arbitration-rules.json');
      if (fs.existsSync(this._diskPath)) {
        const raw = JSON.parse(fs.readFileSync(this._diskPath, 'utf8'));
        if (raw && Array.isArray(raw.rules)) {
          this._rules = raw.rules.filter((r) => isValidRule(r));
          this._updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now();
        }
      }
    } catch (err) {
      this._log.warn('agent-learning', '[Rules] Init error', { error: err.message });
    }
    return this;
  }

  listRules() {
    return this._rules.map((r) => ({ ...r }));
  }

  getRule(id) {
    const r = this._rules.find((x) => x.id === id);
    return r ? { ...r } : null;
  }

  /**
   * Add a rule (e.g. from a user-accepted proposal).
   * Returns the inserted rule with normalised fields.
   */
  addRule(rule) {
    const normalised = normaliseRule(rule);
    if (!normalised) {
      this._log.warn('agent-learning', '[Rules] Refusing invalid rule', { rule });
      return null;
    }
    // Replace if same id; append otherwise.
    const idx = this._rules.findIndex((r) => r.id === normalised.id);
    if (idx >= 0) {
      this._rules[idx] = normalised;
    } else {
      if (this._rules.length >= MAX_RULES) {
        // Drop the oldest rule to bound the file.
        this._rules.shift();
      }
      this._rules.push(normalised);
    }
    this._updatedAt = Date.now();
    this._persist();
    return { ...normalised };
  }

  removeRule(id) {
    const idx = this._rules.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    this._rules.splice(idx, 1);
    this._updatedAt = Date.now();
    this._persist();
    return true;
  }

  /**
   * Filter rules to those whose conditions match the (task, bids) pair.
   * Pure read; no I/O.
   */
  getApplicableRules(task, bids, classifyFn) {
    const content = (task && task.content) || '';
    const cls = typeof classifyFn === 'function' ? classifyFn(content) : null;
    return this._rules.filter((rule) => {
      const c = rule.conditions || {};
      if (typeof c.taskContentMatchesRegex === 'string' && c.taskContentMatchesRegex) {
        try {
          const re = new RegExp(c.taskContentMatchesRegex, 'i');
          if (!re.test(content)) return false;
        } catch (_e) {
          // Bad regex stored -- skip the condition rather than crash.
          return false;
        }
      }
      if (typeof c.taskClass === 'string' && c.taskClass) {
        if (!cls || cls !== c.taskClass) return false;
      }
      // Type-specific bid presence check: suppress-pair only fires
      // when both target agents are present in bids.
      if (rule.type === 'suppress-pair') {
        const [a, b] = Array.isArray(rule.target) ? rule.target : [];
        const ids = new Set((bids || []).map((bb) => bb && bb.agentId).filter(Boolean));
        if (!a || !b || !ids.has(a) || !ids.has(b)) return false;
      }
      // For shrink/boost/route-class, the target agent must at least
      // be in the bid set; otherwise applying the rule is a no-op.
      if (rule.type === 'shrink' || rule.type === 'boost' || rule.type === 'route-class') {
        const ids = new Set((bids || []).map((bb) => bb && bb.agentId).filter(Boolean));
        if (typeof rule.target !== 'string' || !ids.has(rule.target)) return false;
      }
      return true;
    });
  }

  _persist() {
    if (!this._diskPath) return;
    try {
      const payload = JSON.stringify({
        rules: this._rules,
        updatedAt: this._updatedAt,
      }, null, 2);
      const tmp = this._diskPath + '.tmp';
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this._diskPath); // atomic on same fs
    } catch (err) {
      this._log.warn('agent-learning', '[Rules] Persist error', { error: err.message });
    }
  }

  _resetForTests() {
    this._rules = [];
    this._updatedAt = 0;
    this._diskPath = null;
  }
}

// ============================================================
// Pure helpers (no class state)
// ============================================================

function isValidRule(rule) {
  if (!rule || typeof rule !== 'object') return false;
  if (typeof rule.id !== 'string' || !rule.id) return false;
  if (!VALID_RULE_TYPES.has(rule.type)) return false;
  if (typeof rule.magnitude !== 'number' || !Number.isFinite(rule.magnitude)) return false;
  if (rule.magnitude < 0 || rule.magnitude > 1) return false;
  if (rule.type === 'suppress-pair') {
    if (!Array.isArray(rule.target) || rule.target.length !== 2) return false;
    if (rule.target.some((t) => typeof t !== 'string' || !t)) return false;
  } else {
    if (typeof rule.target !== 'string' || !rule.target) return false;
  }
  if (rule.acceptedBy && !VALID_ACCEPTED_BY.has(rule.acceptedBy)) return false;
  return true;
}

function normaliseRule(rule) {
  if (!isValidRule(rule)) return null;
  return {
    id: rule.id,
    type: rule.type,
    target: rule.type === 'suppress-pair' ? [...rule.target] : rule.target,
    magnitude: Math.max(0, Math.min(1, rule.magnitude)),
    conditions: rule.conditions && typeof rule.conditions === 'object'
      ? { ...rule.conditions }
      : {},
    acceptedAt: typeof rule.acceptedAt === 'number' ? rule.acceptedAt : Date.now(),
    acceptedBy: rule.acceptedBy || 'user',
    sourceFindingId: rule.sourceFindingId || null,
  };
}

/**
 * Apply a single rule to a bid array. PURE: returns a new array,
 * does not mutate. The orchestrator runs this in a fold across all
 * applicable rules before pickWinnerFastPath.
 *
 * @param {Array} bids
 * @param {object} rule
 * @returns {{ adjusted: Array, dropped: string[] }}
 */
function applyRule(bids, rule) {
  if (!Array.isArray(bids) || bids.length === 0 || !isValidRule(rule)) {
    return { adjusted: bids || [], dropped: [] };
  }
  const dropped = [];
  let adjusted;

  switch (rule.type) {
    case 'shrink': {
      adjusted = bids.map((b) => {
        if (!b || b.agentId !== rule.target) return b;
        const factor = Math.max(0, 1 - rule.magnitude);
        const newConfidence = (b.confidence || 0) * factor;
        return {
          ...b,
          confidence: newConfidence,
          score: typeof b.score === 'number' ? b.score * factor : newConfidence,
          _ruleApplied: rule.id,
        };
      });
      break;
    }
    case 'boost': {
      adjusted = bids.map((b) => {
        if (!b || b.agentId !== rule.target) return b;
        const factor = 1 + rule.magnitude;
        const newConfidence = Math.min(1, (b.confidence || 0) * factor);
        return {
          ...b,
          confidence: newConfidence,
          score: typeof b.score === 'number' ? Math.min(1, b.score * factor) : newConfidence,
          _ruleApplied: rule.id,
        };
      });
      break;
    }
    case 'suppress-pair': {
      const [a, b] = rule.target;
      const bidA = bids.find((x) => x && x.agentId === a);
      const bidB = bids.find((x) => x && x.agentId === b);
      if (!bidA || !bidB) {
        adjusted = bids;
        break;
      }
      // Drop the lower-confidence of the two; keep the other untouched.
      const drop = (bidA.confidence || 0) <= (bidB.confidence || 0) ? a : b;
      dropped.push(drop);
      adjusted = bids.filter((x) => !x || x.agentId !== drop);
      break;
    }
    case 'route-class': {
      // Force-prefer rule.target: zero out everyone else's confidence
      // (and remove them from the bid array; routing rules are
      // strong, not soft). Magnitude is unused here.
      const survivors = bids.filter((b) => b && b.agentId === rule.target);
      const removed = bids
        .filter((b) => b && b.agentId !== rule.target)
        .map((b) => b.agentId);
      adjusted = survivors;
      dropped.push(...removed);
      break;
    }
    default:
      adjusted = bids;
  }

  return { adjusted, dropped };
}

/**
 * Apply all rules in sequence, returning the final bid array plus a
 * list of every rule application that fired and what it changed.
 * Used by master-orchestrator.evaluate() before pickWinnerFastPath.
 *
 * @param {Array} bids
 * @param {Array} rules
 * @returns {{ bids: Array, applied: Array<{ ruleId, type, target, dropped: string[] }> }}
 */
function applyRules(bids, rules) {
  if (!Array.isArray(bids) || bids.length === 0) return { bids: bids || [], applied: [] };
  if (!Array.isArray(rules) || rules.length === 0) return { bids, applied: [] };
  let working = bids;
  const applied = [];
  for (const rule of rules) {
    const before = working;
    const { adjusted, dropped } = applyRule(working, rule);
    working = adjusted;
    if (adjusted !== before || dropped.length > 0) {
      applied.push({
        ruleId: rule.id,
        type: rule.type,
        target: rule.target,
        dropped,
      });
    }
  }
  return { bids: working, applied };
}

// ============================================================
// Singleton
// ============================================================

let _instance = null;
function getLearnedArbitrationRules() {
  if (!_instance) _instance = new LearnedArbitrationRulesStore();
  return _instance;
}

function _resetSingletonForTests() {
  _instance = null;
}

module.exports = {
  LearnedArbitrationRulesStore,
  getLearnedArbitrationRules,
  applyRule,
  applyRules,
  isValidRule,
  normaliseRule,
  VALID_RULE_TYPES,
  MAX_RULES,
  _resetSingletonForTests,
};
