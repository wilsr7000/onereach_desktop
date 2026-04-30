/**
 * Dedup (HUD Core)
 *
 * Detect when a "new" task submission is actually a duplicate of a
 * recent one -- same transcript (modulo casing / punctuation), or a
 * prefix/superset of a recent one caught mid-stream from incremental
 * STT. Extracted from the inline dedup block in
 * `src/voice-task-sdk/exchange-bridge.js`.
 *
 * Why it matters: voice STT emits partial + final transcripts in
 * quick succession. "Can you play it on?" followed by "Can you play
 * it on my speaker?" should not trigger two tasks.
 *
 * What's portable:
 *   - The normalization rule (lowercase + strip punctuation + trim)
 *   - The match predicate (exact OR prefix in either direction)
 *   - The time-windowed decision
 *   - The prune policy (>5x window = definitely stale)
 *
 * What's NOT portable (and stays in the consumer):
 *   - The KV store that holds "recent submissions". The reference
 *     `createDedupTracker` here uses an in-memory Map, which is fine
 *     for single-process consumers. A distributed consumer can
 *     substitute Redis, a DB, etc. by implementing the same
 *     small interface.
 */

'use strict';

/**
 * Match window -- duplicate checks only compare against submissions
 * within this many ms. Matches the desktop app's
 * SUBMIT_DEDUP_WINDOW_MS (3s).
 */
const DEFAULT_WINDOW_MS = 3_000;

/**
 * How many window-multiples to keep before pruning a stale entry
 * from the store. The desktop app uses 5x (so 15s total).
 */
const DEFAULT_PRUNE_MULTIPLIER = 5;

// ============================================================
// Pure primitives
// ============================================================

/**
 * Canonical normalization: lowercase, strip punctuation, trim.
 * The same rule the desktop app applies before comparing, extracted
 * so consumers (GSX, WISER, CLI) hash/compare the same way.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeTranscript(text) {
  if (typeof text !== 'string') return '';
  return text.toLowerCase().replace(/[.,!?;:'"]/g, '').trim();
}

/**
 * Decide whether `normalized` duplicates anything in `recent`
 * (an array of `{ text, time }` entries) within the window.
 * Match semantics:
 *   - exact text equality
 *   - new text is a prefix of recent text, OR
 *   - recent text is a prefix of new text
 *
 * @param {object} input
 * @param {string} input.normalized    - the incoming normalized transcript
 * @param {Array<{text:string, time:number}>} input.recent
 * @param {number} [input.now]         - default Date.now()
 * @param {number} [input.windowMs]    - default 3000
 * @returns {{ duplicate: boolean, match: {text, time} | null }}
 */
function isDuplicateSubmission(input) {
  const normalized = input && typeof input.normalized === 'string' ? input.normalized : '';
  if (!normalized) return { duplicate: false, match: null };
  const now = typeof input.now === 'number' ? input.now : Date.now();
  const windowMs = typeof input.windowMs === 'number' ? input.windowMs : DEFAULT_WINDOW_MS;
  const recent = Array.isArray(input.recent) ? input.recent : [];

  for (const entry of recent) {
    if (!entry || typeof entry.text !== 'string') continue;
    if (typeof entry.time !== 'number') continue;
    if (now - entry.time >= windowMs) continue;
    if (
      entry.text === normalized ||
      entry.text.startsWith(normalized) ||
      normalized.startsWith(entry.text)
    ) {
      return { duplicate: true, match: { text: entry.text, time: entry.time } };
    }
  }
  return { duplicate: false, match: null };
}

// ============================================================
// Stateful tracker (reference implementation)
// ============================================================

/**
 * An in-memory dedup tracker that owns the rolling window. Consumers
 * with a single-process deployment can use this directly. Consumers
 * with a distributed deployment (Redis-backed, DB-backed) can write
 * their own implementation following this same small interface:
 *
 *   check(text)   -> { duplicate, match | null }
 *   record(text)  -> void
 *   pruneStale()  -> number      (pruned entry count)
 *   clear()       -> void
 *   size()        -> number
 *
 * @param {object} [opts]
 * @param {number} [opts.windowMs]         - default 3000
 * @param {number} [opts.pruneMultiplier]  - default 5 (prune after 5*windowMs)
 * @param {() => number} [opts.now]        - default Date.now
 */
function createDedupTracker(opts = {}) {
  const windowMs = typeof opts.windowMs === 'number' ? opts.windowMs : DEFAULT_WINDOW_MS;
  const pruneMultiplier =
    typeof opts.pruneMultiplier === 'number' ? opts.pruneMultiplier : DEFAULT_PRUNE_MULTIPLIER;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  /** @type {Map<string, number>} normalized -> timestamp */
  const entries = new Map();

  function _recent() {
    return Array.from(entries.entries()).map(([text, time]) => ({ text, time }));
  }

  /**
   * @param {string} text - the RAW (un-normalized) submission text
   * @returns {{ duplicate: boolean, match: {text:string,time:number} | null, normalized: string }}
   */
  function check(text) {
    const normalized = normalizeTranscript(text);
    const r = isDuplicateSubmission({
      normalized,
      recent: _recent(),
      now: now(),
      windowMs,
    });
    return { ...r, normalized };
  }

  /**
   * @param {string} text - the RAW submission text to remember
   * @returns {string} the normalized form that was stored
   */
  function record(text) {
    const normalized = normalizeTranscript(text);
    if (!normalized) return '';
    entries.set(normalized, now());
    return normalized;
  }

  /**
   * Drop entries older than windowMs * pruneMultiplier.
   * @returns {number} pruned count
   */
  function pruneStale() {
    const current = now();
    const cutoff = current - windowMs * pruneMultiplier;
    let pruned = 0;
    for (const [key, time] of Array.from(entries.entries())) {
      if (time < cutoff) {
        entries.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  function clear() {
    entries.clear();
  }

  function size() {
    return entries.size;
  }

  return { check, record, pruneStale, clear, size };
}

module.exports = {
  normalizeTranscript,
  isDuplicateSubmission,
  createDedupTracker,
  DEFAULT_WINDOW_MS,
  DEFAULT_PRUNE_MULTIPLIER,
};
