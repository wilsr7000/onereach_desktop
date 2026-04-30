/**
 * Conversation Continuity - Unit Tests
 *
 * Covers:
 *   - Pure pickContinuityAgent() with injected wins
 *   - Stateful createContinuityTracker() with injected clock
 *   - Legacy-equivalence tests against the inline
 *     `_getConversationContinuityAgent` behaviour from
 *     exchange-bridge.js
 *
 * Run:  npx vitest run test/unit/conversation-continuity.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';

const {
  pickContinuityAgent,
  createContinuityTracker,
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX_WINS_PER_AGENT,
} = require('../../lib/hud-core/conversation-continuity');

describe('pickContinuityAgent (pure)', () => {
  it('empty wins -> null', () => {
    expect(pickContinuityAgent({ wins: [], now: 1000 })).toBeNull();
    expect(pickContinuityAgent({})).toBeNull();
    expect(pickContinuityAgent()).toBeNull();
  });

  it('single fresh win returns that agent', () => {
    const r = pickContinuityAgent({
      wins: [{ agentId: 'weather', timestamp: 1000 }],
      now: 2000,
      windowMs: 10_000,
    });
    expect(r).toEqual({ agentId: 'weather', timestamp: 1000 });
  });

  it('single stale win returns null', () => {
    const r = pickContinuityAgent({
      wins: [{ agentId: 'weather', timestamp: 1000 }],
      now: 200_000,
      windowMs: 10_000,
    });
    expect(r).toBeNull();
  });

  it('multiple agents: latest timestamp wins', () => {
    const r = pickContinuityAgent({
      wins: [
        { agentId: 'weather', timestamp: 1000 },
        { agentId: 'calendar', timestamp: 5000 },
        { agentId: 'dj', timestamp: 3000 },
      ],
      now: 6000,
      windowMs: 10_000,
    });
    expect(r.agentId).toBe('calendar');
  });

  it('only within-window wins count', () => {
    const r = pickContinuityAgent({
      wins: [
        { agentId: 'weather', timestamp: 1000 },   // stale
        { agentId: 'calendar', timestamp: 5000 },  // stale
        { agentId: 'dj', timestamp: 9500 },        // fresh
      ],
      now: 10_000,
      windowMs: 1_000,
    });
    expect(r.agentId).toBe('dj');
  });

  it('defaults to a 2-minute window when none passed', () => {
    expect(DEFAULT_WINDOW_MS).toBe(120_000);
  });

  it('skips malformed entries defensively', () => {
    const r = pickContinuityAgent({
      wins: [
        null,
        { agentId: null, timestamp: 100 },
        { timestamp: 100 },                // missing agentId
        { agentId: 'weather' },            // missing timestamp
        { agentId: 'calendar', timestamp: 500 },
      ],
      now: 1000,
      windowMs: 10_000,
    });
    expect(r.agentId).toBe('calendar');
  });

  it('non-array wins is tolerated (returns null)', () => {
    expect(pickContinuityAgent({ wins: 'nope' })).toBeNull();
    expect(pickContinuityAgent({ wins: null })).toBeNull();
  });
});

describe('createContinuityTracker (stateful)', () => {
  let clock;
  let tracker;
  beforeEach(() => {
    clock = 1_000_000;
    tracker = createContinuityTracker({
      windowMs: 60_000,
      now: () => clock,
    });
  });

  it('recordWin + pickContinuityAgent returns the just-recorded agent', () => {
    tracker.recordWin('weather');
    expect(tracker.pickContinuityAgent().agentId).toBe('weather');
  });

  it('most recent wins out', () => {
    tracker.recordWin('weather');
    clock += 1000;
    tracker.recordWin('calendar');
    clock += 500;
    expect(tracker.pickContinuityAgent().agentId).toBe('calendar');
  });

  it('expired wins are ignored (but not eagerly pruned)', () => {
    tracker.recordWin('weather');
    clock += 70_000;                     // past window
    expect(tracker.pickContinuityAgent()).toBeNull();
  });

  it('prune() drops expired entries and returns the count pruned', () => {
    tracker.recordWin('weather');
    tracker.recordWin('calendar');
    clock += 70_000;
    tracker.recordWin('dj');
    expect(tracker.prune()).toBe(2);
    expect(tracker.getWins()).toHaveLength(1);
    expect(tracker.getWins()[0].agentId).toBe('dj');
  });

  it('per-agent memory is bounded by maxWinsPerAgent', () => {
    const t = createContinuityTracker({
      windowMs: 60_000,
      maxWinsPerAgent: 3,
      now: () => clock,
    });
    for (let i = 0; i < 10; i++) {
      clock += 10;
      t.recordWin('weather');
    }
    expect(t.getWins('weather')).toHaveLength(3);
  });

  it('clear() resets everything', () => {
    tracker.recordWin('weather');
    tracker.clear();
    expect(tracker.pickContinuityAgent()).toBeNull();
    expect(tracker.getWins()).toHaveLength(0);
  });

  it('defensive: recordWin with non-string agentId is a no-op', () => {
    tracker.recordWin(null);
    tracker.recordWin(undefined);
    tracker.recordWin(123);
    tracker.recordWin('');
    expect(tracker.pickContinuityAgent()).toBeNull();
  });

  it('getWins(agentId) returns only that agent', () => {
    tracker.recordWin('weather', { text: 'forecast' });
    tracker.recordWin('calendar');
    const weather = tracker.getWins('weather');
    expect(weather).toHaveLength(1);
    expect(weather[0].text).toBe('forecast');
  });

  it('DEFAULT_MAX_WINS_PER_AGENT is a sensible cap', () => {
    expect(DEFAULT_MAX_WINS_PER_AGENT).toBeGreaterThan(0);
    expect(DEFAULT_MAX_WINS_PER_AGENT).toBeLessThanOrEqual(100);
  });
});

describe('legacy equivalence to _getConversationContinuityAgent', () => {
  // Re-implementation of the pre-extraction logic used in
  // exchange-bridge.js. Should produce identical answers to the
  // extracted version across a spread of inputs.
  function legacyImpl(agentWinStats, now = Date.now()) {
    let lastAgent = null;
    let lastTime = 0;
    for (const [agentId, stats] of agentWinStats) {
      const latest = stats.recentQueries[stats.recentQueries.length - 1];
      if (latest && latest.time > lastTime) {
        lastTime = latest.time;
        lastAgent = agentId;
      }
    }
    if (lastAgent && now - lastTime < 120000) return lastAgent;
    return null;
  }

  const cases = [
    { label: 'empty map', map: new Map(), now: 1000, expected: null },
    {
      label: 'single fresh',
      map: new Map([
        ['weather', { wins: 1, total: 1, recentQueries: [{ text: 'x', time: 900 }] }],
      ]),
      now: 1000,
      expected: 'weather',
    },
    {
      label: 'single stale',
      map: new Map([
        ['weather', { wins: 1, total: 1, recentQueries: [{ text: 'x', time: 1 }] }],
      ]),
      now: 200000,
      expected: null,
    },
    {
      label: 'multiple, latest wins',
      map: new Map([
        ['weather', { recentQueries: [{ time: 1000 }] }],
        ['calendar', { recentQueries: [{ time: 5000 }] }],
      ]),
      now: 6000,
      expected: 'calendar',
    },
    {
      label: 'multiple, one stale',
      map: new Map([
        ['weather', { recentQueries: [{ time: 500 }] }],    // > 120s old by now
        ['calendar', { recentQueries: [{ time: 140000 }] }], // fresh
      ]),
      now: 145000,
      expected: 'calendar',
    },
    {
      label: 'all stale',
      map: new Map([
        ['weather', { recentQueries: [{ time: 1000 }] }],
      ]),
      now: 500000,
      expected: null,
    },
  ];

  for (const { label, map, now, expected } of cases) {
    it(label, () => {
      const legacy = legacyImpl(map, now);

      const wins = [];
      for (const [agentId, stats] of map) {
        for (const q of stats.recentQueries || []) {
          wins.push({ agentId, timestamp: q.time });
        }
      }
      const extracted = pickContinuityAgent({ wins, now, windowMs: 120000 });
      const extractedAgent = extracted ? extracted.agentId : null;
      expect(extractedAgent).toBe(legacy);
      expect(extractedAgent).toBe(expected);
    });
  }
});

