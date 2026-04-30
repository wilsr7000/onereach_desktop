/**
 * Slow-Success Tracker
 *
 * When a task succeeds only after one or more agents timed out, the
 * system already emits `learning:slow-success`. This tracker aggregates
 * those events and decides when to suggest building a dedicated agent
 * for that class of question.
 *
 * Design goals:
 *   - Don't nag. At most one suggestion per query-class per session, and
 *     at most one suggestion every N minutes overall.
 *   - Aggregate by query shape, not exact text -- "coffee near me" and
 *     "coffee shops nearby" should count as the same class.
 *   - Decide synchronously (< 1ms) so the orb can tack the suggestion
 *     onto the current TTS response without visible delay.
 *
 * Consumers call shouldSuggestBuild(event) after receiving each
 * `learning:slow-success`. Returns either null (no suggestion) or an
 * object with `reason`, `queryClass`, and `suggestedPrompt` the consumer
 * can speak to the user.
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');

const DEFAULT_THRESHOLD = 2;                       // need >=2 slow-successes for same class before suggesting
const DEFAULT_CLASS_COOLDOWN_MS = 24 * 60 * 60 * 1000; // don't re-suggest same class for 24h
const DEFAULT_GLOBAL_COOLDOWN_MS = 5 * 60 * 1000;   // don't suggest *anything* more than once per 5 min
const MAX_ENTRIES = 200;                            // bound the tracker

/**
 * Classify a query into a coarse bucket. Different bucket != different
 * class; same bucket = same class for the purposes of tracking slow
 * successes. This is intentionally coarse: we want "coffee shops
 * nearby", "best pizza near me", and "closest pharmacy" to count as the
 * same *kind* of question (local search) so we can notice a pattern
 * after 2-3 slow turns. The exact wording doesn't matter.
 */
function normalizeQueryClass(text) {
  if (!text) return '';
  const q = String(text).toLowerCase().trim();
  if (!q) return '';

  // Bucket: local search (nearby, restaurants, coffee, etc.)
  const localMarkers =
    /\b(nearby|near me|near here|around here|around me|in this area|close by|closest|nearest|local)\b/;
  const localNouns =
    /\b(restaurant|cafe|coffee|espresso|bar|pub|brewery|store|shop|grocery|market|pharmacy|hospital|clinic|dentist|gas station|hotel|park|gym|atm|bank|barber|salon|cinema|bookstore|pizza|lunch|dinner|breakfast|brunch|tacos|sushi|burger)\b/;
  if (localMarkers.test(q) || localNouns.test(q)) return 'bucket:local-search';

  // Bucket: weather. Suffixed forms ("raining", "snowing", "windy") covered
  // by omitting the trailing word boundary on verbs/adjectives.
  if (/\b(weather|forecast|temperature|rain|snow|sunny|cloud|humid|wind)/.test(q)) {
    return 'bucket:weather';
  }

  // Bucket: directions / navigation
  if (/\b(directions|drive to|walk to|how far|how long|get to|route to|map)\b/.test(q)) {
    return 'bucket:directions';
  }

  // Bucket: news / current events
  if (/\b(news|headlines|latest|breaking|today'?s|recent)\b/.test(q)) {
    return 'bucket:news';
  }

  // Bucket: time / scheduling
  if (/\b(what time|what day|timezone|clock|schedule my|on my calendar)\b/.test(q)) {
    return 'bucket:time';
  }

  // Bucket: definitional / factual
  if (/\b(what is|what's|who is|who's|define|meaning of|how does|how do)\b/.test(q)) {
    return 'bucket:factual';
  }

  // Everything else -- use a generic "other" bucket so repeated failures
  // on the same kind of weird query still accumulate.
  return 'bucket:other';
}

class SlowSuccessTracker {
  constructor(opts = {}) {
    this._log = getLogQueue();
    // Use nullish coalescing so explicitly setting cooldown to 0 (common in
    // tests) isn't silently overridden by the default.
    this._threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    this._classCooldownMs = opts.classCooldownMs ?? DEFAULT_CLASS_COOLDOWN_MS;
    this._globalCooldownMs = opts.globalCooldownMs ?? DEFAULT_GLOBAL_COOLDOWN_MS;
    // Map<classKey, { count, firstAt, lastAt, suggestedAt }>
    this._classes = new Map();
    this._lastSuggestAt = 0;
  }

  /**
   * Record a slow-success event and decide whether to suggest now.
   *
   * @param {Object} event - { userInput, winningAgentId, bustCount, bustedAgents, totalDurationMs }
   * @returns {Object|null}
   *   null                  - don't suggest (under threshold, on cooldown, etc.)
   *   { reason, queryClass, suggestedPrompt, agentIdea, detail }
   */
  shouldSuggestBuild(event) {
    if (!event || !event.userInput) return null;

    const classKey = normalizeQueryClass(event.userInput);
    if (!classKey) return null;

    const now = Date.now();
    let entry = this._classes.get(classKey);
    if (!entry) {
      entry = { count: 0, firstAt: now, lastAt: now, suggestedAt: 0 };
      this._classes.set(classKey, entry);
    }
    entry.count += 1;
    entry.lastAt = now;

    // Evict oldest if we're over the bound.
    if (this._classes.size > MAX_ENTRIES) {
      const oldest = [...this._classes.entries()].sort(
        (a, b) => a[1].lastAt - b[1].lastAt
      )[0];
      if (oldest) this._classes.delete(oldest[0]);
    }

    // Threshold check
    if (entry.count < this._threshold) return null;

    // Per-class cooldown
    if (entry.suggestedAt && now - entry.suggestedAt < this._classCooldownMs) {
      return null;
    }

    // Global cooldown -- don't interrupt the user with a suggestion more
    // than once every 5 min, even if different classes are misbehaving.
    if (now - this._lastSuggestAt < this._globalCooldownMs) return null;

    // We're going to suggest. Record the timestamps.
    entry.suggestedAt = now;
    this._lastSuggestAt = now;

    const agentIdea = this._guessAgentIdea(event.userInput, event.bustedAgents);
    const suggestedPrompt = this._buildPrompt(agentIdea, entry.count);

    this._log.info('agent-learning', 'Slow-success tracker suggesting build', {
      classKey,
      count: entry.count,
      agentIdea,
    });

    return {
      reason: 'slow-success-threshold',
      queryClass: classKey,
      occurrenceCount: entry.count,
      agentIdea,
      suggestedPrompt,
      detail: {
        winningAgentId: event.winningAgentId,
        bustedAgents: event.bustedAgents,
        totalDurationMs: event.totalDurationMs,
      },
    };
  }

  /**
   * Lightly heuristic summary of what a dedicated agent could do.
   * This is just shown to the user to make the suggestion feel concrete;
   * the real agent-builder assessment happens on their "yes".
   */
  _guessAgentIdea(userInput, _bustedAgents) {
    const q = String(userInput || '').toLowerCase();
    if (/coffee|cafe|espresso|brew/i.test(q)) return 'a local-search agent for coffee and cafes';
    if (/restaurant|lunch|dinner|food|eat|meal/i.test(q)) return 'a local-restaurant agent';
    // Weather: verb forms like "raining", "snowing", "windy" also count.
    if (/weather|forecast|temperature|rain|snow|sunny|cloud|humid|wind/i.test(q)) {
      return 'a location-aware weather agent';
    }
    if (/near me|nearby|around here|closest|nearest/i.test(q)) return 'a location-aware local-search agent';
    if (/news|headlines|today/i.test(q)) return 'a focused news agent';
    return 'a dedicated agent for this kind of question';
  }

  _buildPrompt(agentIdea, _count) {
    return (
      `That took a few tries. I could build ${agentIdea} so it's faster next time -- ` +
      `just say "build that agent" anytime.`
    );
  }

  /** Testing hook */
  _reset() {
    this._classes.clear();
    this._lastSuggestAt = 0;
  }
}

let _instance = null;
function getSlowSuccessTracker() {
  if (!_instance) _instance = new SlowSuccessTracker();
  return _instance;
}

module.exports = {
  SlowSuccessTracker,
  getSlowSuccessTracker,
  normalizeQueryClass,
};
