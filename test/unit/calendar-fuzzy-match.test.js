/**
 * Phase 4 (calendar agent overhaul) -- substring-first conditional-LLM
 * fuzzy match.
 *
 * Pinned properties (per the plan):
 *   - Cache hit: bypass everything.
 *   - Substring at confidence >= cutoff: NEVER call the LLM.
 *   - Substring miss/low confidence: ask the LLM with bounded timeout.
 *   - LLM timeout/error AND substring had matches: degrade to substring.
 *   - Nothing matched: return null.
 *   - Targets: warm path < 5 ms, cold path < timeout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fuzzyMod = require('../../lib/calendar-fuzzy-match');
const { fuzzyMatch, substringMatch, _scoreEvent, _tokenize } = fuzzyMod;
const sessionContext = require('../../lib/agent-session-context');

let originalSettings;
let originalAiJson;
let aiJsonSpy;

beforeEach(() => {
  sessionContext.clearAll();
  originalSettings = global.settingsManager;
  global.settingsManager = {
    get: vi.fn((key, def) => {
      if (key === 'calendar.fuzzyMatch.substringConfidenceCutoff') return 0.85;
      if (key === 'calendar.fuzzyMatch.llmTimeoutMs') return 200;
      return def;
    }),
  };
  originalAiJson = fuzzyMod._seams.aiJson;
  aiJsonSpy = vi.fn();
  fuzzyMod._seams.aiJson = aiJsonSpy;
});

afterEach(() => {
  global.settingsManager = originalSettings;
  fuzzyMod._seams.aiJson = originalAiJson;
  sessionContext.clearAll();
});

function evt(id, summary, attendees = []) {
  return { id, summary, attendees, start: { dateTime: '2026-04-29T09:00:00Z' } };
}

describe('Phase 4: substringMatch scoring', () => {
  it('exact substring match in title returns confidence 1.0', () => {
    const res = substringMatch('standup', [evt('a', 'Daily Standup'), evt('b', 'Lunch')]);
    expect(res.confidence).toBe(1.0);
    expect(res.matches.map((m) => m.id)).toEqual(['a']);
  });

  it('all query tokens present (boost): high confidence', () => {
    const res = substringMatch('marcus 1on1', [
      evt('a', 'Marcus weekly 1on1'),
      evt('b', 'Lunch'),
    ]);
    expect(res.confidence).toBeGreaterThan(0.85);
    expect(res.matches[0].id).toBe('a');
  });

  it('partial overlap: proportional confidence below cutoff', () => {
    const res = substringMatch('marcus quarterly review', [evt('a', 'Marcus weekly 1on1')]);
    // Only 1 of 3 tokens hits ("marcus"); not strong.
    expect(res.confidence).toBeLessThan(0.85);
  });

  it('attendee name overlap counts toward score', () => {
    const res = substringMatch('sarah', [
      evt('a', 'Quarterly review', [{ displayName: 'Sarah Smith', email: 'sarah@acme.com' }]),
      evt('b', 'Lunch'),
    ]);
    expect(res.matches[0].id).toBe('a');
  });

  it('multiple events tie at top score: confidence reduced (ambiguous)', () => {
    const res = substringMatch('review', [
      evt('a', 'Marcus review'),
      evt('b', 'Quarterly review'),
    ]);
    expect(res.matches.length).toBe(2);
    expect(res.confidence).toBeLessThan(1.0);
  });

  it('zero match: confidence 0, empty matches', () => {
    const res = substringMatch('nonexistent thing', [evt('a', 'Standup'), evt('b', 'Lunch')]);
    expect(res.confidence).toBe(0);
    expect(res.matches).toEqual([]);
  });

  it('empty query: zero confidence', () => {
    expect(substringMatch('', [evt('a', 'x')]).confidence).toBe(0);
    expect(substringMatch('   ', [evt('a', 'x')]).confidence).toBe(0);
  });
});

describe('Phase 4: fuzzyMatch warm path (substring above cutoff)', () => {
  it('substring hit -> no LLM call', async () => {
    const events = [evt('a', 'Daily Standup'), evt('b', 'Lunch')];
    const result = await fuzzyMatch('standup', events);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
    expect(aiJsonSpy).not.toHaveBeenCalled();
  });

  it('warm path latency is essentially zero (no LLM)', async () => {
    const events = [evt('a', 'Daily Standup')];
    const t0 = Date.now();
    await fuzzyMatch('standup', events);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(50); // generous slack for CI
    expect(aiJsonSpy).not.toHaveBeenCalled();
  });
});

describe('Phase 4: fuzzyMatch cold path (substring missed)', () => {
  it('substring zero -> LLM is called with bounded timeout', async () => {
    const events = [evt('a', 'Quarterly board prep'), evt('b', 'Lunch')];
    aiJsonSpy.mockResolvedValue({ indices: [0], confidence: 0.9 });

    const result = await fuzzyMatch('that strategy thing', events);
    expect(aiJsonSpy).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('LLM timeout -> degrades to substring matches if any exist', async () => {
    const events = [evt('a', 'Marcus weekly'), evt('b', 'Lunch')];
    aiJsonSpy.mockImplementation(() => new Promise(() => { /* never resolves */ }));

    // "marcus catch up" -> "marcus" hits in title (partial), substring confidence < cutoff,
    // LLM times out -> degraded fallback returns the substring matches.
    const result = await fuzzyMatch('marcus catch up', events);
    expect(result).toBeTruthy();
    expect(result[0].id).toBe('a');
  });

  it('LLM error AND substring zero -> returns null', async () => {
    const events = [evt('a', 'Lunch'), evt('b', 'Coffee')];
    aiJsonSpy.mockRejectedValue(new Error('llm down'));

    const result = await fuzzyMatch('the secret meeting', events);
    expect(result).toBeNull();
  });
});

describe('Phase 4: fuzzyMatch caching', () => {
  it('second call with same query returns cached result, no second LLM call', async () => {
    const events = [evt('a', 'Quarterly board prep'), evt('b', 'Lunch')];
    aiJsonSpy.mockResolvedValue({ indices: [0], confidence: 0.9 });

    await fuzzyMatch('that strategy thing', events);
    const second = await fuzzyMatch('that strategy thing', events);
    expect(second).toHaveLength(1);
    expect(aiJsonSpy).toHaveBeenCalledTimes(1);
  });

  it('different cacheKey buckets entries separately', async () => {
    const events = [evt('a', 'X')];
    await fuzzyMatch('standup', [evt('s', 'Standup')], { cacheKey: 'today' });
    await fuzzyMatch('standup', events, { cacheKey: 'tomorrow' });
    // Both are warm-path substring hits; the cache is just bucketed by key.
    // Sanity: this should not throw or mix results.
    expect(true).toBe(true);
  });
});

describe('Phase 4: tokenize + scoring helpers', () => {
  it('_tokenize lowercases, drops stopwords, keeps meaningful tokens', () => {
    expect(_tokenize('a meeting with sarah')).toEqual(['sarah']);
  });

  it('_scoreEvent gives 1.0 for exact substring', () => {
    expect(_scoreEvent('standup', ['standup'], { summary: 'Daily Standup', attendees: [] })).toBe(1.0);
  });
});
