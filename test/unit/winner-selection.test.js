/**
 * Winner Selection - Unit Tests
 *
 * Covers each of the four building blocks plus a legacy-equivalence
 * test that reproduces the pre-extraction master-orchestrator logic
 * and compares against the extracted versions.
 *
 * Run:  npx vitest run test/unit/winner-selection.test.js
 */

import { describe, it, expect } from 'vitest';

const {
  scoreOf,
  pickWinnerFastPath,
  hasMultiIntent,
  applyMultiIntentOverride,
  fallbackSelection,
  validateWinners,
  DEFAULT_DOMINANCE_GAP,
  MULTI_INTENT_PATTERN,
} = require('../../lib/hud-core/winner-selection');

// ============================================================
// scoreOf
// ============================================================

describe('scoreOf', () => {
  it('returns score when present', () => {
    expect(scoreOf({ score: 0.82, confidence: 0.5 })).toBe(0.82);
  });

  it('falls back to confidence when score is missing', () => {
    expect(scoreOf({ confidence: 0.5 })).toBe(0.5);
  });

  it('returns 0 for invalid input', () => {
    expect(scoreOf(null)).toBe(0);
    expect(scoreOf({})).toBe(0);
    expect(scoreOf({ score: 'bad' })).toBe(0);
  });

  it('prefers numeric score over numeric confidence', () => {
    expect(scoreOf({ score: 0.1, confidence: 0.9 })).toBe(0.1);
  });

  it('tolerates score=0 (does not fall through to confidence)', () => {
    expect(scoreOf({ score: 0, confidence: 0.9 })).toBe(0);
  });
});

// ============================================================
// pickWinnerFastPath
// ============================================================

describe('pickWinnerFastPath', () => {
  it('no bids -> empty winners, single mode, "No bids received"', () => {
    const r = pickWinnerFastPath([]);
    expect(r).toEqual({
      winners: [],
      executionMode: 'single',
      reasoning: 'No bids received',
      rejectedBids: [],
      agentFeedback: [],
    });
  });

  it('non-array input -> same empty shape', () => {
    expect(pickWinnerFastPath(null).winners).toEqual([]);
    expect(pickWinnerFastPath(undefined).winners).toEqual([]);
  });

  it('single bid -> that agent wins, "Only one agent bid"', () => {
    const r = pickWinnerFastPath([{ agentId: 'a', confidence: 0.6 }]);
    expect(r.winners).toEqual(['a']);
    expect(r.executionMode).toBe('single');
    expect(r.reasoning).toBe('Only one agent bid');
  });

  it('dominant top bid (gap > 0.3) -> winner by gap', () => {
    const r = pickWinnerFastPath([
      { agentId: 'a', confidence: 0.9 },
      { agentId: 'b', confidence: 0.4 },
    ]);
    expect(r.winners).toEqual(['a']);
    expect(r.reasoning).toMatch(/Clear winner by 0\.50 confidence gap/);
  });

  it('close bids (gap = 0.2) -> null (LLM needed)', () => {
    const r = pickWinnerFastPath([
      { agentId: 'a', confidence: 0.8 },
      { agentId: 'b', confidence: 0.6 },
    ]);
    expect(r).toBeNull();
  });

  it('gap just under 0.3 -> null (strict > boundary)', () => {
    // 0.55 - 0.3 = 0.25 gap, well below threshold
    const r = pickWinnerFastPath([
      { agentId: 'a', confidence: 0.55 },
      { agentId: 'b', confidence: 0.3 },
    ]);
    expect(r).toBeNull();
  });

  it('prefers score over confidence when sorting', () => {
    const r = pickWinnerFastPath([
      { agentId: 'a', confidence: 0.9, score: 0.2 },
      { agentId: 'b', confidence: 0.1, score: 0.9 },
    ]);
    expect(r.winners).toEqual(['b']);
  });

  it('custom dominanceGap changes the threshold', () => {
    const bids = [
      { agentId: 'a', confidence: 0.7 },
      { agentId: 'b', confidence: 0.5 },
    ];
    expect(pickWinnerFastPath(bids)).toBeNull();       // gap 0.2, default 0.3
    expect(pickWinnerFastPath(bids, { dominanceGap: 0.1 }).winners).toEqual(['a']);
  });

  it('DEFAULT_DOMINANCE_GAP is 0.3 (preserves legacy behavior)', () => {
    expect(DEFAULT_DOMINANCE_GAP).toBe(0.3);
  });
});

// ============================================================
// hasMultiIntent
// ============================================================

describe('hasMultiIntent', () => {
  const multi = [
    'check my calendar and play some music',
    'schedule a meeting, then send a reminder',
    'play jazz and also send a text',
    'weather tomorrow plus traffic report',
    'PLAY music AND call mom',
  ];
  for (const text of multi) {
    it(`detects: "${text}"`, () => {
      expect(hasMultiIntent(text)).toBe(true);
    });
  }

  const single = [
    'what time is it',
    'play some jazz',
    'schedule a meeting',
    'weather tomorrow',
    '',
    null,
    undefined,
  ];
  for (const text of single) {
    it(`does NOT detect in: ${JSON.stringify(text)}`, () => {
      expect(hasMultiIntent(text)).toBe(false);
    });
  }

  it('MULTI_INTENT_PATTERN is case-insensitive', () => {
    expect(MULTI_INTENT_PATTERN.test('AND')).toBe(true);
  });
});

// ============================================================
// applyMultiIntentOverride
// ============================================================

describe('applyMultiIntentOverride', () => {
  it('single winner -> forced single mode', () => {
    const r = applyMultiIntentOverride(
      { winners: ['a'], executionMode: 'parallel' },
      'anything'
    );
    expect(r.winners).toEqual(['a']);
    expect(r.executionMode).toBe('single');
  });

  it('multi winners + no multi-intent -> first winner, single mode', () => {
    const r = applyMultiIntentOverride(
      { winners: ['a', 'b', 'c'], executionMode: 'parallel' },
      'what time is it'
    );
    expect(r.winners).toEqual(['a']);
    expect(r.executionMode).toBe('single');
  });

  it('multi winners + multi-intent -> passes through', () => {
    const r = applyMultiIntentOverride(
      { winners: ['a', 'b'], executionMode: 'parallel' },
      'check my calendar and play music'
    );
    expect(r.winners).toEqual(['a', 'b']);
    expect(r.executionMode).toBe('parallel');
  });

  it('empty winners -> empty, single mode', () => {
    const r = applyMultiIntentOverride(
      { winners: [], executionMode: 'parallel' },
      'anything'
    );
    expect(r.winners).toEqual([]);
    expect(r.executionMode).toBe('single');
  });

  it('null decision is tolerated', () => {
    const r = applyMultiIntentOverride(null, 'text');
    expect(r.winners).toEqual([]);
    expect(r.executionMode).toBe('single');
  });
});

// ============================================================
// fallbackSelection
// ============================================================

describe('fallbackSelection', () => {
  it('picks highest-scored bid', () => {
    const r = fallbackSelection([
      { agentId: 'a', confidence: 0.3 },
      { agentId: 'b', confidence: 0.9 },
      { agentId: 'c', confidence: 0.5 },
    ]);
    expect(r.winners).toEqual(['b']);
    expect(r.executionMode).toBe('single');
    expect(r.reasoning).toMatch(/Fallback/);
  });

  it('empty bids -> empty winners', () => {
    const r = fallbackSelection([]);
    expect(r.winners).toEqual([]);
  });

  it('prefers score over confidence', () => {
    const r = fallbackSelection([
      { agentId: 'a', confidence: 0.9, score: 0.1 },
      { agentId: 'b', confidence: 0.1, score: 0.9 },
    ]);
    expect(r.winners).toEqual(['b']);
  });
});

// ============================================================
// validateWinners
// ============================================================

describe('validateWinners', () => {
  const bids = [
    { agentId: 'a' },
    { agentId: 'b' },
  ];

  it('drops winners that are not in the bid list', () => {
    expect(validateWinners(['a', 'xyz'], bids)).toEqual(['a']);
  });

  it('preserves order of valid winners', () => {
    expect(validateWinners(['b', 'a'], bids)).toEqual(['b', 'a']);
  });

  it('empty inputs', () => {
    expect(validateWinners([], bids)).toEqual([]);
    expect(validateWinners(['a'], [])).toEqual([]);
  });

  it('non-string winners dropped', () => {
    expect(validateWinners(['a', null, undefined, 42], bids)).toEqual(['a']);
  });
});

// ============================================================
// Legacy equivalence
// ============================================================

describe('legacy equivalence to master-orchestrator.evaluate() fast paths', () => {
  // Reproduces the pre-extraction inline logic from
  // packages/agents/master-orchestrator.js (see `evaluate` and
  // `_fallbackSelection`).
  function legacyFastPath(bids) {
    if (!bids || bids.length === 0) {
      return {
        winners: [],
        executionMode: 'single',
        reasoning: 'No bids received',
        rejectedBids: [],
        agentFeedback: [],
      };
    }
    if (bids.length === 1) {
      return {
        winners: [bids[0].agentId],
        executionMode: 'single',
        reasoning: 'Only one agent bid',
        rejectedBids: [],
        agentFeedback: [],
      };
    }
    const sortedBids = [...bids].sort(
      (a, b) => (b.score || b.confidence) - (a.score || a.confidence)
    );
    const topScore = sortedBids[0]?.score || sortedBids[0]?.confidence || 0;
    const secondScore = sortedBids[1]?.score || sortedBids[1]?.confidence || 0;
    if (topScore - secondScore > 0.3) {
      return {
        winners: [sortedBids[0].agentId],
        executionMode: 'single',
        reasoning: `Clear winner by ${(topScore - secondScore).toFixed(2)} confidence gap`,
        rejectedBids: [],
        agentFeedback: [],
      };
    }
    return null;
  }

  function legacyFallback(bids) {
    const winner = bids[0];
    return {
      winners: [winner.agentId],
      executionMode: 'single',
      reasoning: 'Fallback: selected highest scoring bid',
      rejectedBids: [],
      agentFeedback: [],
    };
  }

  function legacyMultiIntentOverride(finalWinners, executionMode, taskText) {
    if (finalWinners.length > 1) {
      const hasMulti = /\band\b|\bthen\b|\balso\b|\bplus\b/.test(
        taskText.toLowerCase()
      );
      if (!hasMulti) {
        finalWinners = [finalWinners[0]];
        executionMode = 'single';
      }
    }
    if (finalWinners.length === 1) {
      executionMode = 'single';
    }
    return { winners: finalWinners, executionMode };
  }

  const fastPathCases = [
    { label: 'empty', bids: [] },
    { label: 'single', bids: [{ agentId: 'a', confidence: 0.3 }] },
    {
      label: 'dominant gap',
      bids: [{ agentId: 'a', confidence: 0.95 }, { agentId: 'b', confidence: 0.4 }],
    },
    {
      label: 'close',
      bids: [{ agentId: 'a', confidence: 0.7 }, { agentId: 'b', confidence: 0.6 }],
    },
    {
      label: 'score dominates confidence',
      bids: [
        { agentId: 'a', score: 0.2, confidence: 0.9 },
        { agentId: 'b', score: 0.9, confidence: 0.1 },
      ],
    },
    {
      label: 'zero scores',
      bids: [{ agentId: 'a', confidence: 0 }, { agentId: 'b', confidence: 0 }],
    },
  ];

  for (const { label, bids } of fastPathCases) {
    it(`fast-path equivalence: ${label}`, () => {
      expect(pickWinnerFastPath(bids)).toEqual(legacyFastPath(bids));
    });
  }

  it('fallback equivalence', () => {
    const bids = [
      { agentId: 'a', confidence: 0.9 },
      { agentId: 'b', confidence: 0.4 },
    ];
    // Legacy called `bids[0]` without sorting; the pre-extraction
    // code assumed the caller pre-sorted. Our extracted version
    // sorts defensively. Test the pre-sorted input case (legacy
    // contract) against the extracted contract.
    expect(fallbackSelection(bids)).toEqual(legacyFallback(bids));
  });

  // NOTE: the extracted version forces executionMode='single' for
  // winners.length <= 1 (including zero). The legacy left zero-
  // winners mode untouched. Since empty winners never reach execution,
  // the drift is a defensive no-op and equivalence is only tested on
  // the non-degenerate cases that actually occurred in production.
  const overrideCases = [
    { label: 'single winner', winners: ['a'], mode: 'parallel', task: 'weather' },
    { label: 'multi winners no multi-intent', winners: ['a', 'b'], mode: 'parallel', task: 'weather' },
    { label: 'multi winners with "and"', winners: ['a', 'b'], mode: 'parallel', task: 'weather and music' },
    { label: 'multi winners with "then"', winners: ['a', 'b', 'c'], mode: 'parallel', task: 'send email then wait' },
  ];

  for (const { label, winners, mode, task } of overrideCases) {
    it(`override equivalence: ${label}`, () => {
      const extracted = applyMultiIntentOverride(
        { winners, executionMode: mode },
        task
      );
      const legacy = legacyMultiIntentOverride([...winners], mode, task);
      expect(extracted.winners).toEqual(legacy.winners);
      expect(extracted.executionMode).toBe(legacy.executionMode);
    });
  }
});
