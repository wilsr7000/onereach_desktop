/**
 * Conversation Continuity (HUD Core)
 *
 * Tracks which agent handled recent turns and, on the next user
 * utterance, names the agent most likely to be the "conversation
 * continuation." The HUD gives that agent priority in the auction
 * so a three-turn follow-up feels like one continuous conversation
 * instead of three independent routing decisions.
 *
 * Example:
 *   User: "what's the weather tomorrow"      -> weather-agent wins
 *   User: "and the day after"                -> weather-agent again,
 *                                               because it's still the
 *                                               most recent winner
 *                                               within the window
 *   User: (2 hours later) "play some jazz"   -> continuity has decayed,
 *                                               no priority, normal
 *                                               auction runs
 *
 * Two usage modes:
 *
 * 1. **Pure query**: a caller that already stores wins elsewhere
 *    (DB, external service) passes the recent win history as an
 *    argument to `pickContinuityAgent({ wins, now, windowMs })`.
 *
 * 2. **Stateful tracker**: a caller that wants the HUD core to own
 *    the rolling window uses `createContinuityTracker({ windowMs, now })`
 *    which returns an object with `recordWin()`, `pickContinuityAgent()`,
 *    `clear()`, and `getWins()`.
 *
 * No host dependencies. Deterministic on input (tests can inject
 * `now` for full control).
 */

'use strict';

const DEFAULT_WINDOW_MS = 2 * 60 * 1000;     // 2 minutes
const DEFAULT_MAX_WINS_PER_AGENT = 20;       // bounded memory per agent

/**
 * Pick the agent most likely to be the conversation continuation.
 *
 * Selection rule: the agent whose most recent win has the highest
 * timestamp AND is within `windowMs` of `now`.
 *
 * @param {object} input
 * @param {Array<{agentId: string, timestamp: number, text?: string}>} [input.wins]
 * @param {number} [input.now]          - defaults to Date.now()
 * @param {number} [input.windowMs]     - defaults to 2 minutes
 * @returns {{agentId: string, timestamp: number} | null}
 */
function pickContinuityAgent(input = {}) {
  const wins = Array.isArray(input.wins) ? input.wins : [];
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const windowMs = Number.isFinite(input.windowMs) ? input.windowMs : DEFAULT_WINDOW_MS;

  let best = null;
  for (const w of wins) {
    if (!w || typeof w.agentId !== 'string') continue;
    if (!Number.isFinite(w.timestamp)) continue;
    if (now - w.timestamp > windowMs) continue;
    if (!best || w.timestamp > best.timestamp) {
      best = { agentId: w.agentId, timestamp: w.timestamp };
    }
  }
  return best;
}

/**
 * Build a stateful tracker that owns the rolling window.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowMs]              - defaults to 2 minutes
 * @param {number} [opts.maxWinsPerAgent]       - defaults to 20
 * @param {() => number} [opts.now]             - defaults to Date.now
 * @returns {{
 *   recordWin: (agentId: string, meta?: {text?: string}) => void,
 *   pickContinuityAgent: () => ({agentId: string, timestamp: number} | null),
 *   getWins: (agentId?: string) => Array<{agentId, timestamp, text}>,
 *   prune: () => number,
 *   clear: () => void,
 *   _peek: () => object,
 * }}
 */
function createContinuityTracker(opts = {}) {
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : DEFAULT_WINDOW_MS;
  const maxWinsPerAgent = Number.isFinite(opts.maxWinsPerAgent)
    ? opts.maxWinsPerAgent
    : DEFAULT_MAX_WINS_PER_AGENT;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  /** @type {Map<string, Array<{timestamp: number, text?: string}>>} */
  const perAgentWins = new Map();

  function recordWin(agentId, meta = {}) {
    if (typeof agentId !== 'string' || !agentId) return;
    const entry = { timestamp: now(), text: typeof meta.text === 'string' ? meta.text.slice(0, 120) : undefined };
    const list = perAgentWins.get(agentId) || [];
    list.push(entry);
    // Trim by time AND by count so memory stays bounded.
    const cutoff = entry.timestamp - windowMs;
    let fresh = list.filter((e) => e.timestamp >= cutoff);
    if (fresh.length > maxWinsPerAgent) {
      fresh = fresh.slice(-maxWinsPerAgent);
    }
    perAgentWins.set(agentId, fresh);
  }

  function _flatWins() {
    const out = [];
    for (const [agentId, list] of perAgentWins) {
      for (const e of list) out.push({ agentId, timestamp: e.timestamp, text: e.text });
    }
    return out;
  }

  function pickContinuityAgentFn() {
    return pickContinuityAgent({ wins: _flatWins(), now: now(), windowMs });
  }

  function getWins(agentId) {
    if (typeof agentId === 'string') {
      return (perAgentWins.get(agentId) || []).map((e) => ({ agentId, ...e }));
    }
    return _flatWins();
  }

  /**
   * Drop expired entries. Useful when pinned to a background
   * interval. Returns the count of entries pruned.
   */
  function prune() {
    const cutoff = now() - windowMs;
    let pruned = 0;
    for (const [agentId, list] of Array.from(perAgentWins.entries())) {
      const fresh = list.filter((e) => e.timestamp >= cutoff);
      pruned += list.length - fresh.length;
      if (fresh.length === 0) {
        perAgentWins.delete(agentId);
      } else {
        perAgentWins.set(agentId, fresh);
      }
    }
    return pruned;
  }

  function clear() {
    perAgentWins.clear();
  }

  function _peek() {
    const snapshot = {};
    for (const [k, v] of perAgentWins) snapshot[k] = v.slice();
    return snapshot;
  }

  return {
    recordWin,
    pickContinuityAgent: pickContinuityAgentFn,
    getWins,
    prune,
    clear,
    _peek,
  };
}

module.exports = {
  pickContinuityAgent,
  createContinuityTracker,
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX_WINS_PER_AGENT,
};
