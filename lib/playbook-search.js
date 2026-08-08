/**
 * Playbook Search — finding the right playbook by more than its title.
 *
 * Two tiers, used together or separately:
 *
 *   1. searchPlaybooks(query)        — deterministic. Routes through the
 *      canonical SpacesAPI.search() with full-content scoring enabled
 *      (title, tags, metadata AND body text), then filters to playbooks
 *      with the same isPlaybook heuristic the executor uses. Fast, free,
 *      ranked, with match highlights. Empty query = list every playbook.
 *
 *   2. agenticSearchPlaybooks(query) — the agent pass. Gathers every
 *      playbook (keyword-ranked candidates first so likely matches are
 *      examined early, then the rest — the point is finding what keyword
 *      search misses), and goes ONE BY ONE: each playbook's full content
 *      is judged by the LLM against the natural-language query, resolving
 *      to { match, confidence, reason, matchedSections }. Sequential by
 *      design (progress is streamable and cost is inspectable), resilient
 *      to per-item LLM failures, capped by maxEvaluations / stopAfter.
 *      Every call goes through ai-service, so spend lands in the budget
 *      manager under feature "playbook-search".
 *
 * Pure logic + deps-injectable singletons (same pattern as agent-playbook):
 * every function accepts a `deps` override so tests inject fakes without
 * fighting the require cache.
 */

'use strict';

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// ---------------------------------------------------------------------------
// Deps resolution (test seams)
// ---------------------------------------------------------------------------

function _spacesAPI(deps) {
  if (deps.spacesAPI) return deps.spacesAPI;
  const { getSpacesAPI } = require('../spaces-api');
  return getSpacesAPI();
}

function _isPlaybookFn(deps) {
  return deps.isPlaybook || require('./playbook-executor').isPlaybook;
}

function _ai(deps) {
  return deps.ai || require('./ai-service');
}

// ---------------------------------------------------------------------------
// Tier 1: deterministic title + content search
// ---------------------------------------------------------------------------

/**
 * Shape one item into a search result row.
 */
function _shape(item, search) {
  return {
    id: item.id,
    spaceId: item.spaceId || null,
    title: item.metadata?.title || item.fileName || 'Untitled',
    type: item.type,
    preview: typeof item.content === 'string' ? item.content.substring(0, 200) : '',
    score: search ? search.score : null,
    matches: search ? search.matches || [] : [],
    highlights: search ? search.highlights || null : null,
  };
}

/**
 * Search playbooks by title, tags, metadata AND full content.
 *
 * @param {string} query - Search terms. Empty/blank = list all playbooks.
 * @param {Object} [opts]
 * @param {string} [opts.spaceId] - Limit to one space (default: all spaces)
 * @param {number} [opts.limit=25]
 * @param {Object} [deps] - { spacesAPI, isPlaybook } test seam
 * @returns {Promise<Array<Object>>} Ranked result rows (see _shape)
 */
async function searchPlaybooks(query, opts = {}, deps = {}) {
  const spacesAPI = _spacesAPI(deps);
  const isPlaybook = _isPlaybookFn(deps);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 25;
  const q = (query || '').trim();

  if (!q) {
    // List mode: every playbook, newest first (no scores to rank by).
    const all = (spacesAPI.storage && spacesAPI.storage.getAllItems
      ? spacesAPI.storage.getAllItems()
      : []
    )
      .filter((i) => (!opts.spaceId || i.spaceId === opts.spaceId))
      .filter(isPlaybook)
      .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    return all.slice(0, limit).map((i) => _shape(i, null));
  }

  // Canonical scored search — content scoring ON (the whole point here).
  const results = await spacesAPI.search(q, {
    spaceId: opts.spaceId,
    searchContent: true,
    searchTags: true,
    searchMetadata: true,
    fuzzy: true,
    includeHighlights: true,
    // Generous pre-filter limit: playbooks are filtered AFTER scoring, so a
    // tight limit here could evict every playbook behind non-playbook hits.
    limit: 500,
  });

  return results
    .filter(isPlaybook)
    .slice(0, limit)
    .map((i) => _shape(i, i._search));
}

// ---------------------------------------------------------------------------
// Tier 2: agentic search — one-by-one prompt resolution
// ---------------------------------------------------------------------------

const EVAL_CONTENT_CHARS = 6000;

function _evalPrompt(query, title, content) {
  return `You are resolving a search query against ONE playbook to decide if it matches.

Query: "${query}"

Playbook title: ${title}
Playbook content (may be truncated):
---
${(content || '').slice(0, EVAL_CONTENT_CHARS)}
---

Does this playbook genuinely satisfy the INTENT of the query — is it the
playbook someone typing that query is looking for, or directly useful to it?
Matching keywords alone are not enough; judge purpose, steps, and subject.

Respond with JSON only:
{
  "match": true or false,
  "confidence": 0.0 to 1.0,
  "reason": "one sentence on why it matches or does not",
  "matchedSections": ["heading or step that matches", "..."]
}`;
}

/**
 * Fetch an item's full content (list rows can carry truncated or no content).
 */
async function _fullContent(spacesAPI, row) {
  try {
    if (spacesAPI.items && typeof spacesAPI.items.get === 'function') {
      const item = await spacesAPI.items.get(row.spaceId, row.id);
      if (item && typeof item.content === 'string' && item.content.length > 0) {
        return item.content;
      }
    }
  } catch (err) {
    log.warn('playbook-search', 'items.get failed; using preview', {
      id: row.id,
      error: err.message,
    });
  }
  return row.preview || '';
}

/**
 * Agentic search: walk playbooks one by one, resolving each against the
 * query with the LLM.
 *
 * @param {string} query - Natural-language query ("the playbook for onboarding
 *   a new enterprise customer"), not just keywords.
 * @param {Object} [opts]
 * @param {string} [opts.spaceId]          - Limit to one space
 * @param {number} [opts.maxEvaluations=25] - Hard cap on LLM evaluations
 * @param {number} [opts.stopAfter=5]       - Stop once this many matches found
 * @param {string} [opts.profile='fast']    - ai-service model profile
 * @param {Function} [opts.onProgress]      - ({phase, index, total, id, title,
 *   confidence?, matchesSoFar}) fired before each evaluation and on each match
 * @param {Object} [deps] - { spacesAPI, isPlaybook, ai } test seam
 * @returns {Promise<{query, matches, evaluated, totalCandidates, stoppedEarly}>}
 *   matches: result rows + { confidence, reason, matchedSections }, sorted by
 *   confidence descending.
 */
async function agenticSearchPlaybooks(query, opts = {}, deps = {}) {
  const q = (query || '').trim();
  if (!q) {
    return { query: q, matches: [], evaluated: 0, totalCandidates: 0, stoppedEarly: false };
  }

  const spacesAPI = _spacesAPI(deps);
  const ai = _ai(deps);
  const maxEvaluations = opts.maxEvaluations && opts.maxEvaluations > 0 ? opts.maxEvaluations : 25;
  const stopAfter = opts.stopAfter && opts.stopAfter > 0 ? opts.stopAfter : 5;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  // Candidate queue: keyword-ranked hits first (cheap wins early), then every
  // remaining playbook — the agent pass exists precisely to catch playbooks
  // keyword scoring misses.
  const ranked = await searchPlaybooks(q, { spaceId: opts.spaceId, limit: 500 }, deps);
  const everything = await searchPlaybooks('', { spaceId: opts.spaceId, limit: 1000 }, deps);
  const seen = new Set(ranked.map((r) => r.id));
  const queue = [...ranked, ...everything.filter((p) => !seen.has(p.id))];

  const matches = [];
  let evaluated = 0;
  let stoppedEarly = false;

  for (const pb of queue) {
    if (matches.length >= stopAfter) {
      stoppedEarly = true;
      break;
    }
    if (evaluated >= maxEvaluations) {
      stoppedEarly = evaluated < queue.length;
      break;
    }
    evaluated++;

    if (onProgress) {
      onProgress({
        phase: 'evaluating',
        index: evaluated,
        total: Math.min(queue.length, maxEvaluations),
        id: pb.id,
        title: pb.title,
        matchesSoFar: matches.length,
      });
    }

    try {
      const content = await _fullContent(spacesAPI, pb);
      const verdict = await ai.json(_evalPrompt(q, pb.title, content), {
        profile: opts.profile || 'fast',
        feature: 'playbook-search',
        maxTokens: 300,
      });

      if (verdict && verdict.match === true) {
        const confidence = Math.max(0, Math.min(1, Number(verdict.confidence) || 0));
        matches.push({
          ...pb,
          confidence,
          reason: verdict.reason || '',
          matchedSections: Array.isArray(verdict.matchedSections) ? verdict.matchedSections : [],
        });
        if (onProgress) {
          onProgress({
            phase: 'match',
            index: evaluated,
            id: pb.id,
            title: pb.title,
            confidence,
            matchesSoFar: matches.length,
          });
        }
      }
    } catch (err) {
      // One bad evaluation (LLM hiccup, malformed item) must not sink the
      // walk — log, report, move to the next playbook.
      log.warn('playbook-search', 'Agentic evaluation failed; continuing', {
        id: pb.id,
        error: err.message,
      });
      if (onProgress) {
        onProgress({ phase: 'error', index: evaluated, id: pb.id, title: pb.title, error: err.message });
      }
    }
  }

  matches.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  return {
    query: q,
    matches,
    evaluated,
    totalCandidates: queue.length,
    stoppedEarly,
  };
}

module.exports = {
  searchPlaybooks,
  agenticSearchPlaybooks,
  // exported for tests
  _evalPrompt,
};
