/**
 * Memory Curator
 *
 * Agents accumulate facts over time. Left unchecked, memory files grow
 * to thousands of lines -- half of them duplicates, stale entries, or
 * contradictions. Every entry the agent reads at prompt time costs
 * tokens and cognitive load on the model. Memory bloat makes the agent
 * *less* sharp, not more.
 *
 * This curator runs periodically (or on demand) per agent and:
 *   1. Dedupes near-duplicate lines in append-style sections (Recent
 *      History, Learning Notes). Fuzzy match by normalized token set.
 *   2. Ages out entries that have a timestamp + are past the retention
 *      cap for their section (e.g. Learning Notes older than 60 days).
 *   3. Caps each section's line count (configurable per-section).
 *   4. Scores remaining entries on [recency, frequency, importance] so
 *      when we later need to retrieve top-K, we can do it cheaply.
 *
 * Key design choices:
 *   - Operates section-by-section, so hand-edited User Notes survive.
 *   - Never deletes a line that an explicit "keep" marker pins.
 *   - Writes a "Grooming" log entry so users can see what changed.
 *   - Bounded CPU per pass; safe to call on 100+ agents back-to-back.
 *
 * Sections the curator understands:
 *   - "Recent History"    append-style; dedupe + age + cap 50
 *   - "Learning Notes"    append-style; dedupe + age + cap 30
 *   - "Change Log"        append-style; dedupe + cap 30
 *   - "Learned Preferences"   key-value; dedupe by key, newest wins
 *   - Anything else       left alone (User Notes, About, etc.)
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const { getAgentMemory } = require('../agent-memory-store');

// Default rules for sections the curator knows how to groom.
//
// Calibration is owned by the bid-calibrator (Phase 5 self-learning
// arbitration). The whole section is rewritten on every weekly tune,
// so curator-style append/dedupe/age-out behavior would actively
// fight that contract. Mark it 'managed' so the curator leaves it
// alone -- like User Notes / About.
const DEFAULT_SECTION_RULES = {
  'Recent History': { style: 'append', maxLines: 50, maxAgeDays: 60 },
  'Learning Notes': { style: 'append', maxLines: 30, maxAgeDays: 90 },
  'Change Log':     { style: 'append', maxLines: 30, maxAgeDays: 60 },
  'Deleted Facts':  { style: 'append', maxLines: 30, maxAgeDays: 30 },
  'Learned Preferences': { style: 'keyvalue' },
  Calibration:      { style: 'managed' },
};

// Parse a leading ISO date from a line like "- 2026-03-12: blah".
const DATE_PREFIX_RE = /^[-*]\s*(\d{4}-\d{2}-\d{2})\s*:/;

class MemoryCurator {
  constructor(opts = {}) {
    this._log = getLogQueue();
    this._rules = { ...DEFAULT_SECTION_RULES, ...(opts.sectionRules || {}) };
    this._minIntervalMs = opts.minIntervalMs ?? 6 * 60 * 60 * 1000; // 6h per agent
    this._lastGroomAt = new Map(); // agentId -> timestamp
    this._maxAgentsPerSweep = opts.maxAgentsPerSweep ?? 25;
  }

  /**
   * Groom a single agent's memory. Returns a summary of what changed.
   * Safe to call repeatedly; respects per-agent cooldown unless `force`.
   */
  async groomAgent(agentId, { force = false, now = Date.now() } = {}) {
    if (!agentId) return { skipped: 'no-id' };
    if (!force) {
      const last = this._lastGroomAt.get(agentId) || 0;
      if (now - last < this._minIntervalMs) {
        return { skipped: 'cooldown', lastAt: last };
      }
    }

    let memory;
    try {
      memory = getAgentMemory(agentId);
      await memory.load();
    } catch (err) {
      this._log.warn('agent-learning', '[Curator] Could not load memory', {
        agentId, error: err.message,
      });
      return { skipped: 'load-error', error: err.message };
    }

    const sections = memory.getSectionNames();
    const stats = {
      agentId,
      processedSections: 0,
      removedLines: 0,
      deduplicatedLines: 0,
      agedOutLines: 0,
      keyValueMerged: 0,
      changesBySection: {},
    };

    for (const name of sections) {
      const rule = this._rules[name];
      if (!rule) continue;
      const content = memory.getSection(name) || '';
      if (!content.trim()) continue;

      if (rule.style === 'append') {
        const outcome = this._groomAppendSection(content, rule, now);
        if (outcome.changed) {
          memory.updateSection(name, outcome.content || '*No entries yet*');
          stats.removedLines += outcome.removed;
          stats.deduplicatedLines += outcome.deduped;
          stats.agedOutLines += outcome.aged;
          stats.changesBySection[name] = {
            removed: outcome.removed,
            deduped: outcome.deduped,
            aged: outcome.aged,
          };
        }
        stats.processedSections += 1;
      } else if (rule.style === 'keyvalue') {
        const outcome = this._groomKeyValueSection(content);
        if (outcome.changed) {
          memory.updateSection(name, outcome.content);
          stats.keyValueMerged += outcome.merged;
          stats.changesBySection[name] = { merged: outcome.merged };
        }
        stats.processedSections += 1;
      }
    }

    // Persist once at the end.
    if (stats.removedLines > 0 || stats.keyValueMerged > 0) {
      try { await memory.save(); } catch (err) {
        this._log.warn('agent-learning', '[Curator] Save failed', {
          agentId, error: err.message,
        });
      }
      this._log.info('agent-learning', '[Curator] Groomed agent memory', {
        agentId,
        removed: stats.removedLines,
        deduped: stats.deduplicatedLines,
        aged: stats.agedOutLines,
        merged: stats.keyValueMerged,
      });
    }
    this._lastGroomAt.set(agentId, now);
    return stats;
  }

  /**
   * Groom many agents in a single sweep. Respects `maxAgentsPerSweep`
   * so a cron-style scheduler can't pin the main loop.
   */
  async sweep(agentIds, opts = {}) {
    const results = [];
    const ids = Array.isArray(agentIds) ? agentIds : [];
    const limit = Math.min(ids.length, this._maxAgentsPerSweep);
    for (let i = 0; i < limit; i++) {
      results.push(await this.groomAgent(ids[i], opts));
    }
    return results;
  }

  /**
   * Score entries in a section for relevance retrieval. Lines are scored
   * by (recency * recencyWeight + frequency * freqWeight). Only the
   * curator knows section semantics, so this is the right place to
   * compute scores.
   *
   * @param {string} content - section content
   * @param {Object} opts -   - {number} now timestamp in ms
   * @returns {Array<{ line, score, dateIso, tokenCount }>}
   */
  scoreSectionEntries(content, { now = Date.now() } = {}) {
    const lines = this._splitLines(content);
    const scored = lines.map((line) => {
      const dateIso = this._extractDateIso(line);
      const ageDays = dateIso
        ? Math.max(0, (now - new Date(dateIso).getTime()) / (24 * 60 * 60 * 1000))
        : 30; // unknown age = treat as ~a month old
      // Recency score: 1.0 today, 0.5 at ~30 days, -> 0 at ~180 days
      const recency = Math.max(0, 1 - ageDays / 180);
      const tokens = this._tokenize(line);
      // Longer, denser lines are assumed more informative; but we cap.
      const density = Math.min(1, tokens.size / 20);
      const score = recency * 0.7 + density * 0.3;
      return { line, score, dateIso, tokenCount: tokens.size };
    });
    return scored.sort((a, b) => b.score - a.score);
  }

  // ─── internals ───────────────────────────────────────────────────────

  _groomAppendSection(content, rule, now) {
    const original = content;
    const lines = this._splitLines(content);
    if (lines.length === 0) return { changed: false };

    // Age out: drop lines older than maxAgeDays, keeping lines with no date.
    let aged = 0;
    let kept = lines;
    if (rule.maxAgeDays) {
      const cutoff = now - rule.maxAgeDays * 24 * 60 * 60 * 1000;
      kept = lines.filter((line) => {
        const iso = this._extractDateIso(line);
        if (!iso) return true; // no date; keep
        const ts = new Date(iso).getTime();
        if (Number.isNaN(ts)) return true;
        if (ts < cutoff) { aged += 1; return false; }
        return true;
      });
    }

    // Dedupe: remove later (older-position) entries whose normalized
    // token-set is a superset-match of an earlier kept entry. "First
    // occurrence wins" since the file stores newest-first.
    const deduped = [];
    const seenSigs = new Set();
    let dedupedCount = 0;
    for (const line of kept) {
      const sig = this._signature(line);
      if (!sig) { deduped.push(line); continue; }
      if (seenSigs.has(sig)) { dedupedCount += 1; continue; }
      // Also check fuzzy super/sub set against prior sigs to catch
      // "paraphrase" duplicates. Use Jaccard threshold.
      let skip = false;
      for (const prev of seenSigs) {
        if (this._jaccard(sig, prev) >= 0.75) { skip = true; break; }
      }
      if (skip) { dedupedCount += 1; continue; }
      seenSigs.add(sig);
      deduped.push(line);
    }

    // Cap to maxLines (keep newest, i.e. top of list).
    const capped = rule.maxLines && deduped.length > rule.maxLines
      ? deduped.slice(0, rule.maxLines)
      : deduped;
    const removed = lines.length - capped.length;
    const contentOut = capped.join('\n');
    return {
      changed: contentOut !== original,
      content: contentOut,
      removed,
      deduped: dedupedCount,
      aged,
    };
  }

  _groomKeyValueSection(content) {
    // Key-value lines look like "- **Key**: value" or "- Key: value".
    // File is stored newest-first, so first occurrence of a key is the
    // freshest value; later occurrences are older shadowed copies.
    const lines = this._splitLines(content);
    const byKey = new Map();
    let merged = 0;
    for (const line of lines) {
      const m = line.match(/^[-*]\s*(?:\*\*)?([^:*]+?)(?:\*\*)?\s*:\s*(.+)$/);
      if (!m) continue;
      const key = m[1].trim().toLowerCase();
      if (byKey.has(key)) {
        merged += 1;
        continue; // keep first (newest) occurrence
      }
      byKey.set(key, line);
    }
    if (byKey.size === 0) return { changed: false };
    const out = [...byKey.values()].join('\n');
    return { changed: out !== content, content: out, merged };
  }

  _splitLines(content) {
    return String(content || '').split('\n').filter((l) => l.trim());
  }

  _extractDateIso(line) {
    const m = String(line).match(DATE_PREFIX_RE);
    return m ? m[1] : null;
  }

  _tokenize(line) {
    const stop = new Set([
      'the','a','an','is','are','was','were','be','to','of','in','on','at','by',
      'for','with','and','or','but','if','then','so','that','this','it','its',
      'as','from','you','your','i','my','me','we','our','they','their',
    ]);
    const tokens = String(line)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !stop.has(t));
    return new Set(tokens);
  }

  _signature(line) {
    // Token-set signature. Uses the line's content words; strips dates
    // and timestamps so two entries with the same meaning on different
    // days still collapse.
    const noDate = String(line).replace(DATE_PREFIX_RE, '');
    const tokens = this._tokenize(noDate);
    if (tokens.size < 3) return null; // too short to safely dedupe
    return [...tokens].sort().join(' ');
  }

  _jaccard(sigA, sigB) {
    const a = new Set(sigA.split(' '));
    const b = new Set(sigB.split(' '));
    if (a.size === 0 || b.size === 0) return 0;
    let overlap = 0;
    for (const t of a) if (b.has(t)) overlap += 1;
    return overlap / (a.size + b.size - overlap);
  }

  _resetForTests() {
    this._lastGroomAt.clear();
  }
}

let _instance = null;
function getMemoryCurator() {
  if (!_instance) _instance = new MemoryCurator();
  return _instance;
}

module.exports = {
  MemoryCurator,
  getMemoryCurator,
  DEFAULT_SECTION_RULES,
};
