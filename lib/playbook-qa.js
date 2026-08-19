/**
 * Playbook Q&A — the corpus agent.
 *
 * Answers questions about the playbook corpus over a plain function call
 * or an HTTP POST, so the app, a flow, or another agent can all ask the
 * same thing and get the same shaped answer.
 *
 * Two kinds of question, because they are genuinely different verbs:
 *
 *   RETRIEVAL  "which playbook covers enterprise onboarding?"
 *     Narrow the corpus to what is relevant. Delegates to
 *     playbook-search (deterministic tier, then the agentic walk).
 *
 *   QUALITY    "which playbooks are really well written?"
 *     SCORE the corpus against a rubric and rank it. Retrieval machinery
 *     cannot answer this and will mislead if asked to: its prompt judges
 *     "purpose, steps and subject" (so a craft question gets read as a
 *     topic), its candidate order is keyword-based (meaningless without
 *     keywords), and `stopAfter` returns the first N that passed rather
 *     than the best N — a confident answer computed from an arbitrary
 *     slice of the corpus.
 *
 * Quality judgments are cached against a CONTENT HASH plus the rubric
 * version: a playbook's quality cannot change unless its text changes or
 * the standard does. That turns a corpus-wide sweep from a per-question
 * cost into an incremental one, and — the reason it matters more than
 * money — it makes verdicts STABLE. Re-asking does not reshuffle the
 * ranking underneath the user, which is the usual way LLM scoring
 * betrays trust.
 *
 * The rubric is deliberately the HOUSE standard (the Checklist
 * Manifesto's spirit: anchored, short, verifiable), not generic prose
 * quality — "well written" has to mean something specific here or the
 * model returns pleasant mush about clarity and engagement.
 */

'use strict';

const crypto = require('crypto');
const { getLogQueue } = require('./log-event-queue');

const log = getLogQueue();

// ---------------------------------------------------------------------------
// The rubric
// ---------------------------------------------------------------------------

/**
 * Bump when the dimensions or their meaning change — it is part of the
 * cache key, so a rubric change invalidates every stored verdict rather
 * than silently mixing old scores with new ones.
 */
const RUBRIC_VERSION = 1;

const QUALITY_RUBRIC = Object.freeze([
  Object.freeze({
    id: 'anchored',
    weight: 0.25,
    question:
      'Does it say WHEN this runs — the trigger, pause point, or situation that calls for it? An unanchored playbook is never reached for.',
  }),
  Object.freeze({
    id: 'verifiable',
    weight: 0.3,
    question:
      'Are the steps concrete and checkable — could a reader tell whether each one is done? Aspiration ("align stakeholders") is not a step.',
  }),
  Object.freeze({
    id: 'brevity',
    weight: 0.2,
    question:
      'Is it short enough to actually be used under pressure? Length that buries the operative steps is a defect, not thoroughness.',
  }),
  Object.freeze({
    id: 'purpose',
    weight: 0.15,
    question:
      'Is the outcome it produces clear — what is true after running it that was not true before?',
  }),
  Object.freeze({
    id: 'complete',
    weight: 0.1,
    question:
      'Is it finished — no TODOs, placeholders, lorem text, or steps that trail off?',
  }),
]);

const RUBRIC_IDS = QUALITY_RUBRIC.map((d) => d.id);

const EVAL_CONTENT_CHARS = 6000;

function _qualityPrompt(title, content) {
  const dims = QUALITY_RUBRIC.map((d) => `- ${d.id}: ${d.question}`).join('\n');
  return `You are judging the CRAFT of one operational playbook against a fixed standard.
You are NOT judging its subject matter, and NOT deciding whether it matches a search.

Playbook title: ${title}
Playbook content (may be truncated):
---
${(content || '').slice(0, EVAL_CONTENT_CHARS)}
---

Score each dimension from 0.0 (fails completely) to 1.0 (exemplary):
${dims}

Be a hard marker: 0.5 is "acceptable", 0.9+ is rare. Judge what is on the
page, not what the author probably intended.

Respond with JSON only:
{
  "dimensions": { ${RUBRIC_IDS.map((id) => `"${id}": 0.0`).join(', ')} },
  "reason": "one sentence naming the single biggest weakness",
  "strongest": "dimension id",
  "weakest": "dimension id"
}`;
}

// ---------------------------------------------------------------------------
// Verdict cache — keyed by content hash + rubric version
// ---------------------------------------------------------------------------

function contentHash(content) {
  return crypto
    .createHash('sha256')
    .update(String(content || ''), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/** Cache key. Content OR rubric changing invalidates the verdict. */
function verdictKey(content) {
  return `v${RUBRIC_VERSION}:${contentHash(content)}`;
}

/** Default in-memory store. Callers may inject a persistent one. */
function createMemoryVerdictStore() {
  const map = new Map();
  return {
    get: (key) => (map.has(key) ? map.get(key) : null),
    set: (key, value) => {
      map.set(key, value);
    },
    size: () => map.size,
  };
}

// ---------------------------------------------------------------------------
// Deps (test seams — same convention as playbook-search)
// ---------------------------------------------------------------------------

function _ai(deps) {
  return deps.ai || require('./ai-service');
}

function _search(deps) {
  return deps.playbookSearch || require('./playbook-search');
}

let _defaultStore = null;
function _store(deps) {
  if (deps.verdictStore) return deps.verdictStore;
  if (_defaultStore === null) _defaultStore = createMemoryVerdictStore();
  return _defaultStore;
}

// ---------------------------------------------------------------------------
// Access — who is allowed to see what, resolved BEFORE anything is read
// ---------------------------------------------------------------------------

/**
 * A corpus agent is an exfiltration surface: one question can return
 * titles, previews and critiques of every playbook on the graph. So the
 * candidate set is filtered by VISIBILITY before a single evaluation
 * runs — never after, or a restricted playbook has already been read,
 * sent to a model, and cached.
 *
 * Access resolver contract (injectable, `deps.access`):
 *
 *   visibleSpaceIds(viewer) -> Promise<Set<string> | null>
 *
 * `null` means "could not determine", which FAILS CLOSED: nothing
 * passes. An agent that cannot establish what the caller may see must
 * answer about nothing, not about everything.
 *
 * NOTE ON AUTHENTICATION: this is SCOPING, not authentication. The agent
 * gateway binds to 127.0.0.1 and has no auth of any kind, so a local
 * caller can claim any viewer id. This gate stops an over-broad answer;
 * it is not a security boundary. Exposing the gateway beyond localhost —
 * or fronting it with a flow — requires real authentication first.
 */
function _access(deps) {
  if (deps.access) return deps.access;
  return {
    async visibleSpaceIds(viewer) {
      let api;
      try {
        api = deps.spacesAPI || require('../spaces-api').getSpacesAPI();
      } catch {
        return null; // no API — fail closed
      }
      const list =
        (typeof api.listSpaces === 'function' && (await api.listSpaces())) ||
        (typeof api.getSpaces === 'function' && (await api.getSpaces())) ||
        null;
      if (!Array.isArray(list)) return null; // cannot determine — fail closed
      const viewerId = viewer && viewer.id ? String(viewer.id).toLowerCase() : null;
      const allowed = new Set();
      for (const sp of list) {
        if (!sp || !sp.id) continue;
        const visibility = String(sp.visibility || '').toLowerCase();
        const isOpen = visibility === 'open' || visibility === 'public';
        if (isOpen) {
          allowed.add(sp.id);
          continue;
        }
        if (viewerId === null) continue; // anonymous sees only open spaces
        const members = Array.isArray(sp.members) ? sp.members : [];
        const isMember = members.some(
          (m) => String(m?.id ?? m ?? '').toLowerCase() === viewerId
        );
        const isOwner = String(sp.ownerId ?? sp.created_by_user ?? '').toLowerCase() === viewerId;
        if (isMember || isOwner) allowed.add(sp.id);
      }
      return allowed;
    },
  };
}

/**
 * Drop every row the viewer may not see. Rows with no spaceId are
 * dropped too — an unplaceable playbook cannot be shown to be allowed.
 */
async function filterByAccess(rows, viewer, deps = {}) {
  const allowed = await _access(deps).visibleSpaceIds(viewer || null);
  if (!(allowed instanceof Set)) {
    return { visible: [], withheld: rows.length, undetermined: true };
  }
  const visible = rows.filter((r) => r && r.spaceId && allowed.has(r.spaceId));
  return { visible, withheld: rows.length - visible.length, undetermined: false };
}

// ---------------------------------------------------------------------------
// Quality evaluation
// ---------------------------------------------------------------------------

function _clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** Weighted mean of the rubric dimensions. */
function scoreOf(dimensions) {
  let total = 0;
  let weight = 0;
  for (const d of QUALITY_RUBRIC) {
    total += _clamp01(dimensions[d.id]) * d.weight;
    weight += d.weight;
  }
  return weight === 0 ? 0 : Number((total / weight).toFixed(3));
}

function _weakest(dimensions) {
  let worst = null;
  for (const d of QUALITY_RUBRIC) {
    const v = _clamp01(dimensions[d.id]);
    if (worst === null || v < worst.value) worst = { id: d.id, value: v };
  }
  return worst === null ? null : worst.id;
}

/**
 * Judge ONE playbook. Returns a verdict, served from cache when the
 * content and rubric are unchanged.
 *
 * @returns {Promise<{id, title, score, dimensions, reason, weakest,
 *   rubricVersion, contentHash, cached}>}
 */
async function evaluateQuality(playbook, opts = {}, deps = {}) {
  const content = typeof playbook.content === 'string' ? playbook.content : '';
  const key = verdictKey(content);
  const store = _store(deps);

  const hit = store.get(key);
  if (hit && opts.refresh !== true) {
    return { ...hit, id: playbook.id, title: playbook.title, cached: true };
  }

  const ai = _ai(deps);
  let raw;
  try {
    raw = await ai.json(_qualityPrompt(playbook.title, content), {
      profile: opts.profile || 'fast',
      feature: 'playbook-quality',
      maxTokens: 400,
    });
  } catch (err) {
    // One bad evaluation must not sink a corpus sweep.
    log.warn('playbook-qa', 'quality evaluation failed', {
      id: playbook.id,
      error: err.message,
    });
    return null;
  }

  const dims = {};
  for (const d of QUALITY_RUBRIC) {
    dims[d.id] = _clamp01(raw && raw.dimensions ? raw.dimensions[d.id] : 0);
  }
  const verdict = {
    score: scoreOf(dims),
    dimensions: dims,
    reason: typeof raw?.reason === 'string' ? raw.reason : '',
    weakest: RUBRIC_IDS.includes(raw?.weakest) ? raw.weakest : _weakest(dims),
    rubricVersion: RUBRIC_VERSION,
    contentHash: contentHash(content),
  };
  store.set(key, verdict);
  return { ...verdict, id: playbook.id, title: playbook.title, cached: false };
}

/**
 * Score the WHOLE candidate set and rank it. Never exits early: "the
 * best five" is only knowable after everything has been looked at, and
 * an early exit would return "the first five that passed" while looking
 * like an answer.
 *
 * `limit` truncates the RESULT, never the evaluation.
 */
async function assessCorpus(opts = {}, deps = {}) {
  const search = _search(deps);
  const listOpts = opts.spaceId ? { spaceId: opts.spaceId } : {};
  const candidates = await search.searchPlaybooks('', listOpts, deps);
  const all = Array.isArray(candidates) ? candidates : candidates?.results || [];

  // Permission gate FIRST: nothing the viewer cannot see is read,
  // evaluated, sent to a model, or cached.
  const gate = await filterByAccess(all, opts.viewer, deps);
  const rows = gate.visible;

  const verdicts = [];
  let evaluated = 0;
  let fromCache = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (typeof opts.onProgress === 'function') {
      opts.onProgress({
        phase: 'evaluating',
        index: i,
        total: rows.length,
        id: row.id,
        title: row.title,
      });
    }
    const verdict = await evaluateQuality(
      { id: row.id, title: row.title, content: row.content || row.preview || '' },
      opts,
      deps
    );
    if (verdict === null) continue; // skipped, not scored — never counted as 0
    evaluated += 1;
    if (verdict.cached) fromCache += 1;
    verdicts.push({ ...row, ...verdict });
  }

  verdicts.sort((a, b) => b.score - a.score);
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : verdicts.length;
  return {
    ranked: verdicts.slice(0, limit),
    totalCandidates: rows.length,
    evaluated,
    fromCache,
    skipped: rows.length - evaluated,
    withheld: gate.withheld,
    accessUndetermined: gate.undetermined,
  };
}

// ---------------------------------------------------------------------------
// Question routing
// ---------------------------------------------------------------------------

const QUALITY_HINTS = [
  'well written', 'well-written', 'quality', 'best written', 'good playbook',
  'badly written', 'poorly written', 'worst', 'weakest', 'strongest',
  'sloppy', 'incomplete', 'unfinished', 'needs work', 'need work', 'improve',
  'review', 'critique', 'rate', 'score',
  // Bare "good" is too broad — "a good onboarding playbook" is a TOPIC
  // question. These phrasings are unambiguously about craft.
  'how good', 'any good', 'how well written', 'well done',
];

/**
 * Retrieval or quality? A pure heuristic — deterministic, free, and
 * testable — and callers who know can pass `mode` explicitly rather than
 * relying on it. Deliberately NOT an LLM call: routing that costs a
 * model round-trip makes every question slower to serve a case the
 * caller usually already knows.
 */
function classifyQuestion(question) {
  const q = String(question || '').toLowerCase();
  return QUALITY_HINTS.some((h) => q.includes(h)) ? 'quality' : 'retrieval';
}

/** Human-readable answer, synthesized from the data — no second LLM call. */
function _summarizeQuality(result, question) {
  const { ranked, totalCandidates, evaluated, skipped } = result;
  if (evaluated === 0) {
    if (result.accessUndetermined) {
      return 'Cannot answer: your access to these playbooks could not be established, so none were read.';
    }
    if (result.withheld > 0) {
      return `Nothing to assess — all ${result.withheld} playbooks are outside your access.`;
    }
    return `No playbooks could be assessed${totalCandidates > 0 ? ` (${totalCandidates} found, all evaluations failed)` : ''}.`;
  }
  const strong = ranked.filter((r) => r.score >= 0.8).length;
  const weak = ranked.filter((r) => r.score < 0.5).length;
  const top = ranked[0];
  const parts = [
    `Assessed ${evaluated} playbook${evaluated === 1 ? '' : 's'} against the house standard.`,
    `${strong} scored 0.8 or better; ${weak} fell below 0.5.`,
  ];
  if (top) {
    parts.push(
      `Strongest: "${top.title}" at ${top.score.toFixed(2)}${top.reason ? ` — ${top.reason}` : ''}.`
    );
  }
  const worst = ranked[ranked.length - 1];
  if (worst && ranked.length > 1) {
    parts.push(`Weakest: "${worst.title}" at ${worst.score.toFixed(2)}, weakest on ${worst.weakest}.`);
  }
  if (skipped > 0) parts.push(`${skipped} could not be evaluated and were left unscored.`);
  if (result.withheld > 0) {
    const n = result.withheld;
    const were = n === 1 ? 'was' : 'were';
    parts.push(
      result.accessUndetermined
        ? `${n} ${were} withheld because your access could not be established.`
        : `${n} ${were} outside your access and ${n === 1 ? 'was' : 'were'} not assessed.`
    );
  }
  return parts.join(' ');
}

function _summarizeRetrieval(matches, question, totalCandidates) {
  if (matches.length === 0) {
    return `No playbook answers that${totalCandidates ? ` (${totalCandidates} considered)` : ''}.`;
  }
  const top = matches[0];
  const rest = matches.length - 1;
  return (
    `"${top.title}"${top.reason ? ` — ${top.reason}` : ''}` +
    (rest > 0 ? ` (${rest} other${rest === 1 ? '' : 's'} also matched.)` : '')
  );
}

/**
 * THE agent entry point. One question in, one structured answer out.
 *
 * @param {string} question
 * @param {Object} [opts] - { mode: 'auto'|'quality'|'retrieval', spaceId,
 *   limit, refresh, profile, onProgress }
 * @returns {Promise<{question, mode, answer, results, evaluated?,
 *   fromCache?, totalCandidates, rubricVersion?}>}
 */
async function answerPlaybookQuestion(question, opts = {}, deps = {}) {
  const q = String(question || '').trim();
  if (q.length === 0) {
    return {
      question: q,
      mode: 'none',
      answer: 'Ask a question about the playbooks — what to use, or how good they are.',
      results: [],
      totalCandidates: 0,
    };
  }

  const requested = opts.mode || 'auto';
  const mode = requested === 'auto' ? classifyQuestion(q) : requested;

  if (mode === 'quality') {
    const result = await assessCorpus(opts, deps);
    return {
      question: q,
      mode,
      answer: _summarizeQuality(result, q),
      results: result.ranked.map((r) => ({
        id: r.id,
        title: r.title,
        spaceId: r.spaceId ?? null,
        score: r.score,
        dimensions: r.dimensions,
        weakest: r.weakest,
        reason: r.reason,
        cached: r.cached,
      })),
      evaluated: result.evaluated,
      fromCache: result.fromCache,
      skipped: result.skipped,
      withheld: result.withheld,
      accessUndetermined: result.accessUndetermined,
      totalCandidates: result.totalCandidates,
      rubricVersion: RUBRIC_VERSION,
    };
  }

  const search = _search(deps);
  const found = await search.agenticSearchPlaybooks(
    q,
    {
      ...(opts.spaceId ? { spaceId: opts.spaceId } : {}),
      ...(opts.limit ? { stopAfter: Number(opts.limit) } : {}),
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(typeof opts.onProgress === 'function' ? { onProgress: opts.onProgress } : {}),
    },
    deps
  );
  const rawMatches = Array.isArray(found?.matches) ? found.matches : [];
  // Retrieval leaks just as readily as a quality sweep — a match is a
  // title, a reason, and the sections that matched. Same gate.
  const gate = await filterByAccess(rawMatches, opts.viewer, deps);
  const matches = gate.visible;
  return {
    question: q,
    mode: 'retrieval',
    answer:
      matches.length === 0 && gate.withheld > 0
        ? gate.undetermined
          ? 'Cannot answer: your access to these playbooks could not be established.'
          : 'No playbook you can see answers that.'
        : _summarizeRetrieval(matches, q, found?.totalCandidates),
    withheld: gate.withheld,
    accessUndetermined: gate.undetermined,
    results: matches.map((m) => ({
      id: m.id,
      title: m.title,
      spaceId: m.spaceId ?? null,
      confidence: m.confidence,
      reason: m.reason,
      matchedSections: m.matchedSections || [],
    })),
    evaluated: found?.evaluated ?? matches.length,
    totalCandidates: found?.totalCandidates ?? matches.length,
  };
}

module.exports = {
  RUBRIC_VERSION,
  QUALITY_RUBRIC,
  contentHash,
  verdictKey,
  createMemoryVerdictStore,
  scoreOf,
  classifyQuestion,
  filterByAccess,
  evaluateQuality,
  assessCorpus,
  answerPlaybookQuestion,
};
