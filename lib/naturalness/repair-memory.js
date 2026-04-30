/**
 * Repair Memory (Phase 5 / repairMemory)
 *
 * Per-user learned phonetic fixes. When the app mishears the user
 * ("play jess" instead of "play jazz") and the user corrects the
 * error ("I meant jazz"), the correction is stored so the next time
 * the transcription service emits "jess" we transparently rewrite it
 * to "jazz" before the rest of the pipeline sees it.
 *
 * STORAGE: JSON file in the user's Spaces ("gsx-agent/phonetic-fixes.json")
 * so fixes survive app restarts AND follow the user to other
 * Onereach products (WISER Playbooks, etc).
 *
 * SHAPE on disk:
 *   {
 *     "version": 1,
 *     "savedAt": 1713811200000,
 *     "fixes": [
 *       { "heard": "jess", "meant": "jazz", "hits": 3, "lastHit": 1713811000000 }
 *     ]
 *   }
 *
 * API (see implementations below):
 *   createRepairMemory({ spaces, log, now, capacity }) -> {
 *     load(), save(),
 *     applyFixes(transcript) -> { text, appliedCount, applied: [{heard,meant}] },
 *     learnFix(heard, meant) -> { added, updated, existing },
 *     getFixes(), size(), clear(),
 *   }
 *
 * The module does NOT call Spaces directly at boot time; `load()`
 * must be invoked by the caller once the Spaces API is available.
 *
 * DESIGN CHOICES:
 *   - Word-boundary regex replacement (safe for partial matches).
 *   - Hit count + lastHit per fix so stale fixes can be evicted
 *     (LRU-ish when capacity is reached).
 *   - Reject pathological fixes (empty, identical, or extremely
 *     generic like a single common word) to avoid poisoning the map.
 */

'use strict';

const DEFAULT_CAPACITY = 200;

// Generic English words that should never become the "heard" side of
// a fix -- otherwise a one-off "I meant X" accidentally rewrites every
// occurrence of a common word.
const POISON_HEARD = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if',
  'i', 'you', 'me', 'my', 'your', 'it', 'is', 'was', 'are',
  'to', 'of', 'for', 'with', 'on', 'at', 'in', 'from',
  'yes', 'no', 'ok', 'okay', 'please',
]);

/**
 * @param {object} [deps]
 * @param {object} [deps.spaces]        - a Spaces API with files.read/write/delete
 * @param {{info:Function,warn:Function,error:Function}} [deps.log]
 * @param {() => number} [deps.now]
 * @param {number} [deps.capacity]
 */
function createRepairMemory(deps = {}) {
  const spaces = deps.spaces || null;
  const log = deps.log || _silentLog();
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const capacity = Number.isFinite(deps.capacity) && deps.capacity > 0
    ? deps.capacity
    : DEFAULT_CAPACITY;

  /** @type {Map<string, {heard:string, meant:string, hits:number, lastHit:number}>} */
  const fixes = new Map();
  /** @type {string|null} key of the most recently added/updated fix */
  let lastLearnedKey = null;

  // ---- persistence ----

  async function load() {
    if (!spaces || !spaces.files) return false;
    try {
      const raw = await spaces.files.read('gsx-agent', 'phonetic-fixes.json');
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.fixes)) return false;
      fixes.clear();
      lastLearnedKey = null;
      for (const entry of parsed.fixes) {
        if (!entry || typeof entry.heard !== 'string' || typeof entry.meant !== 'string') {
          continue;
        }
        const key = _normalize(entry.heard);
        if (!key) continue;
        fixes.set(key, {
          heard: entry.heard,
          meant: entry.meant,
          hits: Number.isFinite(entry.hits) ? entry.hits : 1,
          lastHit: Number.isFinite(entry.lastHit) ? entry.lastHit : now(),
        });
      }
      log.info('voice', '[RepairMemory] loaded fixes', { count: fixes.size });
      return true;
    } catch (err) {
      log.warn('voice', '[RepairMemory] load failed', { error: err.message });
      return false;
    }
  }

  async function save() {
    if (!spaces || !spaces.files) return false;
    try {
      const payload = {
        version: 1,
        savedAt: now(),
        fixes: Array.from(fixes.values()),
      };
      await spaces.files.write(
        'gsx-agent',
        'phonetic-fixes.json',
        JSON.stringify(payload, null, 2)
      );
      return true;
    } catch (err) {
      log.warn('voice', '[RepairMemory] save failed', { error: err.message });
      return false;
    }
  }

  // ---- learning ----

  /**
   * Record a new phonetic fix. Returns { added, updated, unlearned, reason }.
   *
   * Cycle detection: if the inverse fix (meant -> heard) already
   * exists, the caller is almost certainly correcting a prior bad
   * learn ("I meant jess" after we wrongly learned "jess -> jazz").
   * We DELETE the inverse fix rather than install the reverse --
   * installing both would produce flip-flopping rewrites in
   * applyFixes.
   *
   * @param {string} heard   - what the STT heard (the bad version)
   * @param {string} meant   - what the user actually said
   */
  function learnFix(heard, meant) {
    const hNorm = _normalize(heard);
    const mNorm = _normalize(meant);
    if (!hNorm || !mNorm) return { added: false, updated: false, reason: 'empty' };
    if (hNorm === mNorm) return { added: false, updated: false, reason: 'identical' };

    // Guard against generic words -- a single common word as "heard"
    // would rewrite benign future utterances.
    if (_wordCount(hNorm) === 1 && POISON_HEARD.has(hNorm)) {
      return { added: false, updated: false, reason: 'poison-heard' };
    }

    // Cycle detection: if fix (meant -> heard) already exists,
    // interpret this as an undo of that fix rather than installing
    // the inverse.
    const inverse = fixes.get(mNorm);
    if (inverse && _normalize(inverse.meant) === hNorm) {
      fixes.delete(mNorm);
      if (lastLearnedKey === mNorm) lastLearnedKey = null;
      return { added: false, updated: false, unlearned: true, reason: 'cycle-undo' };
    }

    const existing = fixes.get(hNorm);
    if (existing) {
      // Update meant + bump stats.
      existing.meant = meant;
      existing.hits++;
      existing.lastHit = now();
      lastLearnedKey = hNorm;
      return { added: false, updated: true, existing: { ...existing } };
    }

    fixes.set(hNorm, {
      heard,
      meant,
      hits: 1,
      lastHit: now(),
    });
    lastLearnedKey = hNorm;

    // Evict least recently hit entries if we are over capacity.
    if (fixes.size > capacity) {
      const sortedByLastHit = Array.from(fixes.entries()).sort(
        (a, b) => a[1].lastHit - b[1].lastHit
      );
      while (fixes.size > capacity && sortedByLastHit.length > 0) {
        const [keyToDrop] = sortedByLastHit.shift();
        if (keyToDrop === lastLearnedKey) continue; // never evict the just-learned
        fixes.delete(keyToDrop);
      }
    }

    return { added: true, updated: false };
  }

  /**
   * Remove a fix by its heard-side token. Case-insensitive.
   * @param {string} heard
   * @returns {{removed: boolean, entry?: object}}
   */
  function unlearnFix(heard) {
    const key = _normalize(heard);
    if (!key || !fixes.has(key)) return { removed: false };
    const entry = fixes.get(key);
    fixes.delete(key);
    if (lastLearnedKey === key) lastLearnedKey = null;
    return { removed: true, entry };
  }

  /**
   * Remove the most recently added/updated fix. Useful for voice
   * undo ("never mind", "forget that fix").
   * @returns {{removed: boolean, entry?: object, reason?: string}}
   */
  function unlearnLast() {
    if (!lastLearnedKey || !fixes.has(lastLearnedKey)) {
      return { removed: false, reason: 'no-recent-fix' };
    }
    const entry = fixes.get(lastLearnedKey);
    fixes.delete(lastLearnedKey);
    lastLearnedKey = null;
    return { removed: true, entry };
  }

  /**
   * @returns {object|null} the most recently added/updated fix, or null
   */
  function getLastLearned() {
    if (!lastLearnedKey || !fixes.has(lastLearnedKey)) return null;
    return { ...fixes.get(lastLearnedKey) };
  }

  // ---- application ----

  /**
   * Apply all known fixes to an incoming transcript. Matches on word
   * boundaries (case-insensitive) so "jess" becomes "jazz" but
   * "jessica" is untouched.
   *
   * Updates hits / lastHit for every fix that actually fired.
   *
   * @param {string} transcript
   * @returns {{ text: string, appliedCount: number, applied: Array<{heard,meant}> }}
   */
  function applyFixes(transcript) {
    const text = (transcript || '').toString();
    if (!text || fixes.size === 0) {
      return { text, appliedCount: 0, applied: [] };
    }

    // Match every fix against the ORIGINAL text (not the running
    // output) so fixes never cascade into each other. Rewrites are
    // collected and applied with a single pass that picks the
    // LONGEST match when spans overlap.
    const matches = [];
    for (const fix of fixes.values()) {
      const pattern = new RegExp(
        `\\b${_escapeRegex(fix.heard)}\\b`,
        'gi'
      );
      let m;
      while ((m = pattern.exec(text)) !== null) {
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          heard: fix.heard,
          meant: fix.meant,
          fix,
        });
        if (m.index === pattern.lastIndex) pattern.lastIndex++;
      }
    }

    if (matches.length === 0) return { text, appliedCount: 0, applied: [] };

    // Sort by start ascending, then by length descending (longer
    // match wins on ties). Greedily take non-overlapping matches.
    matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const chosen = [];
    let cursor = 0;
    for (const mt of matches) {
      if (mt.start < cursor) continue;
      chosen.push(mt);
      cursor = mt.end;
    }

    // Splice out the chosen matches right-to-left so indices stay valid.
    let out = text;
    const applied = [];
    for (const mt of [...chosen].reverse()) {
      out = out.slice(0, mt.start) + mt.meant + out.slice(mt.end);
      mt.fix.hits++;
      mt.fix.lastHit = now();
      applied.push({ heard: mt.heard, meant: mt.meant });
    }
    return { text: out, appliedCount: applied.length, applied };
  }

  // ---- utility ----

  function getFixes() {
    return Array.from(fixes.values());
  }

  function size() {
    return fixes.size;
  }

  function clear() {
    fixes.clear();
    lastLearnedKey = null;
  }

  return {
    load,
    save,
    learnFix,
    unlearnFix,
    unlearnLast,
    getLastLearned,
    applyFixes,
    getFixes,
    size,
    clear,
  };
}

// ==================== HELPERS ====================

function _normalize(s) {
  return (s || '').toString().trim().toLowerCase();
}

function _wordCount(s) {
  return s ? s.split(/\s+/).filter(Boolean).length : 0;
}

function _escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

module.exports = {
  createRepairMemory,
  DEFAULT_CAPACITY,
  POISON_HEARD,
};
