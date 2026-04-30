/**
 * Memory Retriever
 *
 * When an agent builds a prompt, naively appending all of its memory is
 * wasteful (tokens + noise) and often counterproductive -- irrelevant
 * facts bias the LLM. This module scores agent-memory lines against
 * the current query and returns the top-K most relevant.
 *
 * No embeddings. Uses a fast token-overlap + recency blend that is
 * deterministic, testable, and ~instant. Good enough for the long tail
 * of agent-memory lookups; we can swap in embedding-based retrieval
 * later without changing callers.
 *
 * Scoring model for each candidate line:
 *
 *   relevance  = jaccard(tokens(query), tokens(line))          # 0..1
 *   recency    = exp(-ageDays / halfLifeDays)                  # 0..1 (today=1)
 *   density    = min(1, tokens(line).size / 20)                # 0..1
 *   pin        = 1.0 if explicitly pinned (contains [pin]), else 0
 *
 *   score = relevance * W_REL + recency * W_REC + density * W_DEN + pin * W_PIN
 *
 * Defaults weight relevance highest (0.6), recency next (0.25), density
 * (0.1), and explicit pins (0.05 boost to make `[pin]` reliably float
 * without overpowering great matches).
 *
 * Callers:
 *   - Any agent's execute() can `retrieve({ agentId, query, topK })`
 *     to get its top-K facts as plain-text lines.
 *   - omni-data-agent pulls top-K on behalf of agents that don't care
 *     to handle this directly.
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const { getAgentMemory } = require('../agent-memory-store');

const DEFAULT_WEIGHTS = { rel: 0.6, rec: 0.25, den: 0.1, pin: 0.05 };
const DEFAULT_HALF_LIFE_DAYS = 30;
const DATE_PREFIX_RE = /^[-*]\s*(\d{4}-\d{2}-\d{2})\s*:/;
const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','to','of','in','on',
  'at','by','for','with','and','or','but','if','then','so','that','this','it',
  'its','as','from','you','your','i','my','me','we','our','they','their','here',
  'there','what','which','who','how','why','when','where','can','will','would',
  'should','could','may','might','do','does','did','have','has','had','not','no',
  'yes','also','just','very','more','most','some','any','all','one','two','three',
]);

function _tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}
function _tokenSet(text) { return new Set(_tokens(text)); }

function _jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const t of a) if (b.has(t)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

function _ageDaysFromLine(line, now = Date.now()) {
  const m = String(line).match(DATE_PREFIX_RE);
  if (!m) return null;
  const ts = new Date(m[1]).getTime();
  if (Number.isNaN(ts)) return null;
  return Math.max(0, (now - ts) / (24 * 60 * 60 * 1000));
}

function scoreLine(line, queryTokens, { now = Date.now(), halfLifeDays = DEFAULT_HALF_LIFE_DAYS, weights = DEFAULT_WEIGHTS } = {}) {
  const lineTokens = _tokenSet(line);
  const rel = _jaccard(queryTokens, lineTokens);
  const ageDays = _ageDaysFromLine(line, now);
  const recency = ageDays == null ? 0.5 : Math.exp(-ageDays / halfLifeDays);
  const density = Math.min(1, lineTokens.size / 20);
  const pin = /\[pin\]/i.test(line) ? 1 : 0;
  const score =
    rel * weights.rel +
    recency * weights.rec +
    density * weights.den +
    pin * weights.pin;
  return { score, rel, recency, density, pin };
}

class MemoryRetriever {
  constructor(opts = {}) {
    this._log = getLogQueue();
    this._weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
    this._halfLifeDays = opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
    this._cache = new Map(); // agentId -> { at, raw, lines }
    this._cacheTtlMs = opts.cacheTtlMs ?? 30 * 1000;
  }

  /**
   * Fetch top-K relevant lines from agent memory for a given query.
   * Returns an array of { line, score, sectionName, ageDays }.
   *
   * Includes lines from `sectionsToInclude` (default: all appendable
   * sections). User-edited free-form sections are included so hand-
   * added facts can be retrieved too.
   */
  async retrieve({ agentId, query, topK = 5, sectionsToInclude = null, now = Date.now() }) {
    if (!agentId || !query) return [];
    const queryTokens = _tokenSet(query);
    if (queryTokens.size === 0) return [];

    const lines = await this._collectLines(agentId, { sectionsToInclude });
    if (lines.length === 0) return [];

    const scored = lines.map((l) => ({
      ...l,
      ...scoreLine(l.line, queryTokens, {
        now, halfLifeDays: this._halfLifeDays, weights: this._weights,
      }),
    }));
    // Drop near-zero relevance unless a pin.
    const filtered = scored.filter((x) => x.rel > 0.05 || x.pin > 0 || x.score > 0.4);
    filtered.sort((a, b) => b.score - a.score);
    return filtered.slice(0, topK);
  }

  /**
   * Convenience: returns just the line text (for prompt splicing).
   */
  async retrieveText(args) {
    const results = await this.retrieve(args);
    return results.map((r) => r.line);
  }

  async _collectLines(agentId, { sectionsToInclude = null } = {}) {
    const cached = this._cache.get(agentId);
    if (cached && Date.now() - cached.at < this._cacheTtlMs) return cached.lines;

    let memory;
    try {
      memory = getAgentMemory(agentId);
      await memory.load();
    } catch (err) {
      this._log.warn('agent-learning', '[Retriever] Could not load memory', {
        agentId, error: err.message,
      });
      return [];
    }

    const sectionNames = memory.getSectionNames();
    const include = sectionsToInclude
      ? new Set(sectionsToInclude)
      : null;
    const lines = [];
    for (const name of sectionNames) {
      if (include && !include.has(name)) continue;
      // Skip explicitly scaffolding sections that rarely hold retrievable facts.
      if (name === 'About This Memory') continue;
      const content = memory.getSection(name) || '';
      for (const rawLine of content.split('\n')) {
        const t = rawLine.trim();
        if (!t) continue;
        if (t.startsWith('*No ')) continue; // placeholder text
        lines.push({ line: t, sectionName: name });
      }
    }
    this._cache.set(agentId, { at: Date.now(), lines });
    return lines;
  }

  /** Invalidate a specific agent's cache (e.g. after curator runs). */
  invalidate(agentId) {
    if (agentId) this._cache.delete(agentId);
    else this._cache.clear();
  }

  _resetForTests() {
    this._cache.clear();
  }
}

let _instance = null;
function getMemoryRetriever() {
  if (!_instance) _instance = new MemoryRetriever();
  return _instance;
}

module.exports = {
  MemoryRetriever,
  getMemoryRetriever,
  scoreLine,
  DEFAULT_WEIGHTS,
};
