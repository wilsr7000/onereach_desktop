/**
 * Adequacy Tracker -- Phase 5 multi-turn elicitation loop
 *
 * Unit tests for lib/exchange/adequacy-tracker.js. Pure state
 * tracking; no LLM calls; fast and deterministic.
 */

import { describe, it, expect, beforeEach } from 'vitest';

const {
  AdequacyTracker,
  getAdequacyTracker,
  _resetAdequacyTrackerForTests,
  DEFAULT_MAX_TURNS,
} = require('../../lib/exchange/adequacy-tracker');

let tracker;

beforeEach(() => {
  tracker = new AdequacyTracker();
});

describe('open / getEntry', () => {
  it('open requires a taskId', () => {
    expect(() => tracker.open()).toThrow(/taskId required/);
    expect(() => tracker.open('')).toThrow(/taskId required/);
  });

  it('returns a fresh entry with zero turns', () => {
    const e = tracker.open('t1', { maxTurns: 3, requires: 'a number' });
    expect(e.taskId).toBe('t1');
    expect(e.turns).toBe(0);
    expect(e.history).toEqual([]);
    expect(e.adequacy.maxTurns).toBe(3);
    expect(typeof e.createdAt).toBe('number');
  });

  it('replaces a prior entry with the same taskId', () => {
    tracker.open('t1', { maxTurns: 3 });
    tracker.increment('t1', 'q', 'a');
    const fresh = tracker.open('t1', { maxTurns: 5 });
    expect(fresh.turns).toBe(0);
    expect(fresh.adequacy.maxTurns).toBe(5);
  });

  it('getEntry returns a snapshot (not a live reference)', () => {
    tracker.open('t1', {});
    const snap = tracker.getEntry('t1');
    snap.turns = 999;
    expect(tracker.getTurnCount('t1')).toBe(0);
  });

  it('getEntry returns null for unknown task', () => {
    expect(tracker.getEntry('missing')).toBe(null);
    expect(tracker.getTurnCount('missing')).toBe(0);
    expect(tracker.getHistory('missing')).toEqual([]);
  });
});

describe('increment', () => {
  it('increments turn count and appends history', () => {
    tracker.open('t1', { maxTurns: 3 });
    tracker.increment('t1', 'Prompt A', 'Answer 1');
    tracker.increment('t1', 'Prompt B', 'Answer 2');
    const e = tracker.getEntry('t1');
    expect(e.turns).toBe(2);
    expect(e.history.map((h) => h.answer)).toEqual(['Answer 1', 'Answer 2']);
  });

  it('implicitly opens when called before open()', () => {
    tracker.increment('late', 'Q', 'A');
    expect(tracker.getTurnCount('late')).toBe(1);
  });

  it('coerces non-string prompt/answer to empty strings', () => {
    tracker.increment('t1', undefined, null);
    const e = tracker.getEntry('t1');
    expect(e.history[0].prompt).toBe('');
    expect(e.history[0].answer).toBe('');
  });
});

describe('shouldContinue', () => {
  it('returns ok=true when no entry exists', () => {
    const r = tracker.shouldContinue('fresh', 5);
    expect(r.ok).toBe(true);
    expect(r.turn).toBe(0);
    expect(r.maxTurns).toBe(5);
  });

  it('uses adequacy.maxTurns from the entry', () => {
    tracker.open('t1', { maxTurns: 2 });
    tracker.increment('t1', 'q', 'a'); // turn 1
    expect(tracker.shouldContinue('t1').ok).toBe(true);
    tracker.increment('t1', 'q2', 'a2'); // turn 2
    const r = tracker.shouldContinue('t1');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('max-turns-reached');
  });

  it('explicit max overrides adequacy.maxTurns', () => {
    tracker.open('t1', { maxTurns: 10 });
    tracker.increment('t1', 'q', 'a');
    expect(tracker.shouldContinue('t1', 1).ok).toBe(false);
  });

  it('defaults to DEFAULT_MAX_TURNS when adequacy has no maxTurns', () => {
    tracker.open('t1', {});
    for (let i = 0; i < DEFAULT_MAX_TURNS; i++) {
      tracker.increment('t1', 'q', 'a');
    }
    expect(tracker.shouldContinue('t1').ok).toBe(false);
  });

  it('returns not-ok after exhausted() is called', () => {
    tracker.open('t1', { maxTurns: 5 });
    tracker.increment('t1', 'q', 'a');
    expect(tracker.shouldContinue('t1').ok).toBe(true);
    tracker.exhausted('t1');
    const r = tracker.shouldContinue('t1');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('already-exhausted');
  });
});

describe('exhausted / clear', () => {
  it('exhausted marks the entry but keeps history', () => {
    tracker.open('t1', { maxTurns: 2 });
    tracker.increment('t1', 'q', 'a');
    tracker.exhausted('t1');
    const e = tracker.getEntry('t1');
    expect(e.exhausted).toBe(true);
    expect(e.history).toHaveLength(1);
  });

  it('exhausted on unknown task is a no-op', () => {
    expect(tracker.exhausted('missing')).toBe(null);
  });

  it('clear removes the entry', () => {
    tracker.open('t1', {});
    expect(tracker.clear('t1')).toBe(true);
    expect(tracker.getEntry('t1')).toBe(null);
  });

  it('clear is idempotent', () => {
    expect(tracker.clear('never-opened')).toBe(false);
  });
});

describe('buildExhaustedResult', () => {
  it('includes the declared requires string when present', () => {
    tracker.open('t1', { maxTurns: 3, requires: 'a numeric score 1-10' });
    tracker.increment('t1', 'q', 'a');
    tracker.increment('t1', 'q', 'a');
    const r = tracker.buildExhaustedResult('t1');
    expect(r.success).toBe(false);
    expect(r.adequacyExhausted).toBe(true);
    expect(r.turns).toBe(2);
    expect(r.message).toContain('numeric score');
  });

  it('falls back gracefully when no requires was set', () => {
    tracker.open('t1', { maxTurns: 2 });
    tracker.increment('t1', 'q', 'a');
    const r = tracker.buildExhaustedResult('t1');
    expect(r.message).toMatch(/adequate answer/i);
    expect(r.adequacyExhausted).toBe(true);
  });
});

describe('size + diagnostics', () => {
  it('size tracks active loops', () => {
    expect(tracker.size()).toBe(0);
    tracker.open('a', {});
    tracker.open('b', {});
    expect(tracker.size()).toBe(2);
    tracker.clear('a');
    expect(tracker.size()).toBe(1);
  });
});

describe('singleton getAdequacyTracker', () => {
  it('returns the same instance across calls', () => {
    _resetAdequacyTrackerForTests();
    const a = getAdequacyTracker();
    const b = getAdequacyTracker();
    expect(a).toBe(b);
  });

  it('_resetAdequacyTrackerForTests yields a fresh singleton', () => {
    const first = getAdequacyTracker();
    first.open('leftover', {});
    _resetAdequacyTrackerForTests();
    const second = getAdequacyTracker();
    expect(first).not.toBe(second);
    expect(second.getEntry('leftover')).toBe(null);
  });
});

describe('end-to-end elicitation loop', () => {
  it('stops the loop after maxTurns and produces a graceful fallback', () => {
    tracker.open('t1', { maxTurns: 2, requires: 'a number' });

    // Turn 1: user answers, loop continues.
    tracker.increment('t1', 'What is the number?', 'not sure');
    expect(tracker.shouldContinue('t1').ok).toBe(true);

    // Turn 2: user answers again, now at maxTurns.
    tracker.increment('t1', 'Please give me a number', 'still unsure');
    const decision = tracker.shouldContinue('t1');
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe('max-turns-reached');

    // Runner marks exhausted and builds the result.
    tracker.exhausted('t1');
    const fallback = tracker.buildExhaustedResult('t1');
    expect(fallback.adequacyExhausted).toBe(true);
    expect(fallback.turns).toBe(2);
    expect(fallback.maxTurns).toBe(2);

    // Clear + verify.
    tracker.clear('t1');
    expect(tracker.getEntry('t1')).toBe(null);
  });
});
