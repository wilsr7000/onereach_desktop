/**
 * Agent Health Tracker - per-agent failure and quality streaks feeding the
 * auto-heal loop (UC-05 / UC-08).
 *
 * Streams in:
 *   recordFailure(agentId, {transient})  <- agent:execution-failure events
 *                                           (transient = rate-limit/timeout,
 *                                           never counts toward healing)
 *   recordBadGrade(agentId)              <- learning:low-quality-answer
 *   recordSuccess(agentId)               <- resets both streaks
 *
 * Decision out:
 *   evaluate(agentId) -> { heal, reason } once a streak crosses its
 *   threshold AND heal attempts remain (hard cap per agent per session).
 *
 * Pure state machine, no I/O. The auto-heal executor (auto-heal.js) owns
 * the side effects.
 */

'use strict';

const DEFAULTS = Object.freeze({
  failureThreshold: 2, // consecutive hard failures before healing
  badGradeThreshold: 2, // consecutive low-quality grades before healing
  maxHealAttempts: 3, // per agent per session ("tries up to 3 times")
});

class AgentHealthTracker {
  constructor(opts = {}) {
    this.failureThreshold = opts.failureThreshold ?? DEFAULTS.failureThreshold;
    this.badGradeThreshold = opts.badGradeThreshold ?? DEFAULTS.badGradeThreshold;
    this.maxHealAttempts = opts.maxHealAttempts ?? DEFAULTS.maxHealAttempts;
    this._agents = new Map(); // agentId -> { failures, badGrades, healAttempts, lastTaskContent }
  }

  _get(agentId) {
    if (!this._agents.has(agentId)) {
      this._agents.set(agentId, { failures: 0, badGrades: 0, healAttempts: 0, lastTaskContent: null });
    }
    return this._agents.get(agentId);
  }

  /** @returns {number} the new failure streak (transient failures don't count) */
  recordFailure(agentId, { transient = false, taskContent = null } = {}) {
    if (!agentId) return 0;
    const a = this._get(agentId);
    if (transient) return a.failures;
    a.failures += 1;
    if (taskContent) a.lastTaskContent = taskContent;
    return a.failures;
  }

  /** @returns {number} the new bad-grade streak */
  recordBadGrade(agentId, { taskContent = null } = {}) {
    if (!agentId) return 0;
    const a = this._get(agentId);
    a.badGrades += 1;
    if (taskContent) a.lastTaskContent = taskContent;
    return a.badGrades;
  }

  /** A clean execution clears both streaks (not the heal-attempt count). */
  recordSuccess(agentId) {
    if (!agentId || !this._agents.has(agentId)) return;
    const a = this._get(agentId);
    a.failures = 0;
    a.badGrades = 0;
  }

  /**
   * Should this agent be auto-healed NOW?
   * @returns {{ heal: boolean, reason: string|null, attemptsUsed: number, lastTaskContent: string|null }}
   */
  evaluate(agentId) {
    const a = this._get(agentId);
    const base = { attemptsUsed: a.healAttempts, lastTaskContent: a.lastTaskContent };
    if (a.healAttempts >= this.maxHealAttempts) {
      return { heal: false, reason: 'attempts-exhausted', ...base };
    }
    if (a.failures >= this.failureThreshold) {
      return { heal: true, reason: 'failure-streak', ...base };
    }
    if (a.badGrades >= this.badGradeThreshold) {
      return { heal: true, reason: 'quality-streak', ...base };
    }
    return { heal: false, reason: null, ...base };
  }

  /**
   * Consume one heal attempt. Also clears the triggering streaks so a heal
   * that works isn't immediately re-triggered by stale counts.
   * @returns {number|null} the attempt number (1-based), or null when exhausted
   */
  beginHealAttempt(agentId) {
    const a = this._get(agentId);
    if (a.healAttempts >= this.maxHealAttempts) return null;
    a.healAttempts += 1;
    a.failures = 0;
    a.badGrades = 0;
    return a.healAttempts;
  }

  /** Test/inspection helper. */
  snapshot(agentId) {
    const a = this._get(agentId);
    return { ...a };
  }
}

let _singleton = null;
function getAgentHealthTracker() {
  if (!_singleton) _singleton = new AgentHealthTracker();
  return _singleton;
}

module.exports = { AgentHealthTracker, getAgentHealthTracker, DEFAULTS };
