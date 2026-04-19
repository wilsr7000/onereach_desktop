/**
 * Variant Selector
 *
 * Small LLM micro-call that classifies a task into an auction variant
 * ('winner' | 'council' | 'lead_plus_probers') when the caller didn't
 * supply one. Introduced in Phase 3 of the agent-system upgrade.
 *
 * Rationale:
 *   - Most tasks today are one-shot commands best served by
 *     winner-take-all (play music, schedule a meeting, open a file).
 *   - Evaluation-style requests ("evaluate this plan", "score this
 *     document") genuinely benefit from multi-agent council
 *     aggregation.
 *   - Interview-style requests ("interview me about X", "help me
 *     explore this idea") want a lead agent plus probes from others.
 *
 * Asking the caller to predeclare the variant puts the wrong burden on
 * them. A ~80-token classification call, cached by normalized task
 * text, is cheap enough to run on every ambiguous task.
 *
 * The flag:
 *   - `variantSelector` must be on for this module to do anything at
 *     the call site. If off, the caller's explicit `task.variant` is
 *     used, or the auction defaults to `winner`.
 *
 * Offline tests use the `classifier` injection point (no LLM call).
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const VALID_VARIANTS = new Set(['winner', 'council', 'lead_plus_probers']);
const DEFAULT_VARIANT = 'winner';
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;

// Module-level cache: normalized task text -> { variant, at }
const _variantCache = new Map();

function _cacheKey(task) {
  const content = (task && task.content) || '';
  return content.trim().toLowerCase().slice(0, 240);
}

function _cacheGet(key) {
  const entry = _variantCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    _variantCache.delete(key);
    return null;
  }
  return entry.variant;
}

function _cacheSet(key, variant) {
  _variantCache.set(key, { variant, at: Date.now() });
  if (_variantCache.size > CACHE_MAX) {
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const [k, v] of _variantCache.entries()) {
      if (v.at < cutoff) _variantCache.delete(k);
    }
  }
}

/**
 * Classify a task into one of the known variants.
 *
 * @param {Object} task
 * @param {string} task.content
 * @param {Object} [options]
 * @param {Function} [options.classifier] - Override the LLM call.
 *                                          Signature: async ({ content }) =>
 *                                          one of VALID_VARIANTS.
 * @returns {Promise<string>} One of VALID_VARIANTS (guaranteed)
 */
async function selectVariant(task, options = {}) {
  const key = _cacheKey(task);
  if (!key) return DEFAULT_VARIANT;

  const cached = _cacheGet(key);
  if (cached) return cached;

  // If the caller injected a classifier (tests / alt bidders), use it
  // directly. Otherwise lazy-load the LLM path.
  const classifier = typeof options.classifier === 'function'
    ? options.classifier
    : _llmClassifier;

  let variant;
  try {
    const raw = await classifier({ content: task.content || '' });
    variant = VALID_VARIANTS.has(raw) ? raw : DEFAULT_VARIANT;
  } catch (err) {
    log.warn('agent', '[VariantSelector] classification failed, defaulting to winner', {
      error: err.message,
    });
    variant = DEFAULT_VARIANT;
  }

  _cacheSet(key, variant);
  return variant;
}

/**
 * Clear the cache (test utility and manual refresh).
 */
function clearVariantCache() {
  _variantCache.clear();
}

/**
 * Size snapshot for diagnostics.
 */
function getVariantCacheSize() {
  return _variantCache.size;
}

// ==================== INTERNAL ====================

async function _llmClassifier({ content }) {
  if (!content || !content.trim()) return DEFAULT_VARIANT;
  const ai = require('../ai-service');
  const prompt = `Classify this user request into ONE of three auction variants used by a multi-agent system.

Request: "${content.trim().slice(0, 500)}"

Variants:
- "winner": A single-agent command or question (do X, answer Y, open Z). The one best agent handles it.
- "council": An evaluation / judgment / scoring task (evaluate, review, critique, grade, compare). Multiple expert agents weigh in and the result is a weighted aggregate score with conflicts surfaced.
- "lead_plus_probers": An open-ended exploration / interview / brainstorm. One agent leads, others contribute probe questions.

Pick the variant that best matches what the user is asking for. When in doubt, choose "winner" -- it is the cheapest and matches most commands.

Respond with JSON:
{ "variant": "winner" | "council" | "lead_plus_probers" }`;

  const result = await ai.json(prompt, {
    profile: 'fast',
    temperature: 0,
    maxTokens: 40,
    feature: 'variant-selector',
  });
  const out = result && typeof result.variant === 'string' ? result.variant : DEFAULT_VARIANT;
  return VALID_VARIANTS.has(out) ? out : DEFAULT_VARIANT;
}

module.exports = {
  selectVariant,
  clearVariantCache,
  getVariantCacheSize,
  VALID_VARIANTS,
  DEFAULT_VARIANT,
  CACHE_TTL_MS,
};
