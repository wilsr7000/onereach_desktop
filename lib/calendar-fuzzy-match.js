/**
 * Calendar Fuzzy Match (Phase 4 -- calendar agent overhaul)
 *
 * Substring-first, conditional-LLM event resolver. The plan calls this out
 * as the right shape after the prior draft (race substring AND LLM in
 * parallel) was found wasteful -- substring always returns first (~1 ms) so
 * the LLM call ran unconditionally even when substring sufficed.
 *
 * The contract:
 *
 *   1. Cache hit (sessionContext) -> return immediately.
 *   2. Substring with confidence >= cutoff -> return, NEVER call the LLM.
 *   3. Substring miss/low-confidence -> call LLM with bounded timeout.
 *   4. LLM result -> return.
 *   5. LLM timeout/error AND substring had any matches -> return substring
 *      anyway (degraded but useful).
 *   6. All of the above failed -> return null (caller falls back to
 *      "here's your schedule, which one?").
 *
 * Targets per plan: warm path ~1 ms, cold path bounded by `llmTimeoutMs`
 * (default 600 ms). Cache is in `sessionContext` (NOT calendar-memory) --
 * fuzzy results are ephemeral, no cross-restart persistence.
 */

'use strict';

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();
const { getSessionValue, setSession } = require('./agent-session-context');

// Test seam matching the meeting-classifier pattern.
const _seams = {
  aiJson: async (prompt, opts) => {
    const ai = require('./ai-service');
    return ai.json(prompt, opts);
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'with', 'about', 'for', 'on', 'at', 'in', 'of', 'and', 'or',
  'meeting', 'call', 'sync', 'event', 'next', 'my', 'our',
]);

function _tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && t.length >= 2 && !STOPWORDS.has(t));
}

function _normalizeQuery(q) {
  return String(q || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function _readSetting(key, fallback) {
  try {
    const v = global.settingsManager?.get(key);
    if (v !== undefined && v !== null) return v;
  } catch {
    /* fall through */
  }
  return fallback;
}

// ─── Substring scoring ─────────────────────────────────────────────────────

/**
 * Score how well an event matches the query. Returns 0..1.
 *
 *   - Exact title substring -> 1.0
 *   - All query tokens present in title or attendee names -> 0.85
 *   - Partial overlap -> proportional
 *   - Multiple events tied at the same score -> caller treats as ambiguous
 */
function _scoreEvent(queryNormalized, queryTokens, event) {
  const title = (event.summary || '').toLowerCase();
  if (!queryNormalized || queryTokens.length === 0) return 0;

  // Exact substring match in title is the strongest signal.
  if (title.includes(queryNormalized)) return 1.0;

  // Token overlap with title.
  const titleTokens = new Set(_tokenize(title));
  let titleHits = 0;
  for (const t of queryTokens) if (titleTokens.has(t)) titleHits += 1;

  // Token overlap with attendee display names + emails.
  const attendeeTokens = new Set();
  for (const a of event.attendees || []) {
    for (const t of _tokenize(a.displayName || '')) attendeeTokens.add(t);
    for (const t of _tokenize((a.email || '').replace(/@.*/, ''))) attendeeTokens.add(t);
  }
  let attendeeHits = 0;
  for (const t of queryTokens) if (attendeeTokens.has(t)) attendeeHits += 1;

  const totalHits = titleHits + Math.min(attendeeHits, queryTokens.length);
  const baseScore = Math.min(1, totalHits / queryTokens.length);

  // Boost when ALL tokens hit somewhere.
  if (totalHits >= queryTokens.length) return Math.min(0.95, baseScore + 0.1);
  return baseScore;
}

/**
 * Score every event and return top-K with their scores. If multiple events
 * are tied at the top score, confidence is reduced (we can't disambiguate
 * cleanly).
 */
function substringMatch(query, events) {
  const queryNormalized = _normalizeQuery(query);
  const queryTokens = _tokenize(query);

  if (!queryNormalized || events.length === 0) {
    return { matches: [], confidence: 0 };
  }

  const scored = events
    .map((event) => ({ event, score: _scoreEvent(queryNormalized, queryTokens, event) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { matches: [], confidence: 0 };

  const topScore = scored[0].score;
  const tied = scored.filter((s) => s.score === topScore);

  // If multiple events tie, the resolver is ambiguous -- drop confidence
  // even when the substring scored 1.0 (both exact-match means we can't
  // disambiguate without more context).
  let confidence = topScore;
  if (tied.length > 1) {
    confidence = topScore * 0.6;
  }

  return {
    matches: tied.map((s) => s.event),
    confidence,
  };
}

// ─── LLM scoring ──────────────────────────────────────────────────────────

async function _llmScore(query, events) {
  if (events.length === 0) return null;

  const eventList = events
    .slice(0, 25)
    .map((e, i) => {
      const title = (e.summary || 'Untitled').replace(/[\r\n]/g, ' ');
      const attendees = (e.attendees || [])
        .slice(0, 5)
        .map((a) => a.displayName || a.email || '')
        .filter(Boolean)
        .join(', ');
      const start = e.start?.dateTime || e.start?.date || '';
      return `[${i}] "${title}" at ${start}${attendees ? ` -- attendees: ${attendees}` : ''}`;
    })
    .join('\n');

  const prompt = `Match this user query to ONE OR MORE calendar events from the list below.

USER QUERY: "${query}"

EVENTS:
${eventList}

Return JSON: { "indices": [<integers>], "confidence": <0..1> }
- Return an empty indices array if nothing reasonably matches.
- Return one index for an unambiguous match, more if the query is genuinely ambiguous.
- Confidence is your subjective certainty, 0 (no match) to 1 (definitely this one).`;

  const result = await _seams.aiJson(prompt, { profile: 'fast', feature: 'calendar-fuzzy-match' });

  const indices = Array.isArray(result?.indices) ? result.indices : [];
  const matches = indices
    .filter((i) => Number.isInteger(i) && i >= 0 && i < events.length)
    .map((i) => events[i]);
  const confidence = Number.isFinite(result?.confidence) ? Math.max(0, Math.min(1, result.confidence)) : 0;

  return { matches, confidence };
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Resolve a fuzzy event query against a list of events.
 *
 * @param {string} query - user-spoken query (e.g. "the standup", "with Sarah")
 * @param {Array} events - candidate events for the day/range
 * @param {Object} [opts]
 * @param {string} [opts.agentId='calendar-query-agent'] - sessionContext key
 * @param {string} [opts.cacheKey] - additional discriminator (e.g. dateRange)
 *   so cache entries are bucketed correctly
 * @returns {Promise<Array|null>} matched events, or null if no match
 */
async function fuzzyMatch(query, events, opts = {}) {
  const agentId = opts.agentId || 'calendar-query-agent';
  const cacheKey = `fuzzy:${_normalizeQuery(query)}:${opts.cacheKey || 'default'}`;

  // (1) Cache hit
  const cached = getSessionValue(agentId, cacheKey);
  if (cached) return cached;

  // (2) Substring first
  const sub = substringMatch(query, events);
  const cutoff = _readSetting('calendar.fuzzyMatch.substringConfidenceCutoff', 0.85);
  if (sub.confidence >= cutoff && sub.matches.length >= 1) {
    setSession(agentId, cacheKey, sub.matches, { ttlMs: 60_000 });
    return sub.matches;
  }

  // (3) Cold path: LLM with bounded timeout
  const timeoutMs = _readSetting('calendar.fuzzyMatch.llmTimeoutMs', 600);
  let llmResult = null;
  try {
    llmResult = await Promise.race([
      _llmScore(query, events),
      new Promise((_, rej) => {
        setTimeout(() => rej(new Error('llm_timeout')), timeoutMs);
      }),
    ]);
  } catch (err) {
    log.info('calendar-fuzzy-match', 'LLM scoring timed out or errored', { error: err.message });
  }

  if (llmResult && llmResult.matches.length > 0) {
    setSession(agentId, cacheKey, llmResult.matches, { ttlMs: 60_000 });
    return llmResult.matches;
  }

  // (5) Degraded fallback: substring even at low confidence
  if (sub.matches.length >= 1) return sub.matches;

  // (6) Nothing matched
  return null;
}

module.exports = {
  fuzzyMatch,
  substringMatch,
  _seams,
  _tokenize,
  _normalizeQuery,
  _scoreEvent,
};
