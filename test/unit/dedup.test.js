/**
 * Dedup - Unit Tests
 *
 * Covers the normalization rule, the exact/prefix match predicate,
 * the stateful tracker with an injected clock, and a legacy-
 * equivalence test against the inline logic from exchange-bridge.
 *
 * Run:  npx vitest run test/unit/dedup.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';

const {
  normalizeTranscript,
  isDuplicateSubmission,
  createDedupTracker,
  DEFAULT_WINDOW_MS,
  DEFAULT_PRUNE_MULTIPLIER,
} = require('../../lib/hud-core/dedup');

// ============================================================
// normalizeTranscript
// ============================================================

describe('normalizeTranscript', () => {
  it('lowercases', () => {
    expect(normalizeTranscript('PLAY JAZZ')).toBe('play jazz');
  });

  it('strips standard punctuation', () => {
    expect(normalizeTranscript('Play, jazz! Please?')).toBe('play jazz please');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeTranscript('  play jazz  ')).toBe('play jazz');
  });

  it('tolerates null / non-string', () => {
    expect(normalizeTranscript(null)).toBe('');
    expect(normalizeTranscript(undefined)).toBe('');
    expect(normalizeTranscript(42)).toBe('');
  });

  it('preserves inner spacing (does NOT collapse multiple spaces)', () => {
    // Matches the pre-extraction inline code, which only trimmed
    // edges.
    expect(normalizeTranscript('play   jazz')).toBe('play   jazz');
  });
});

// ============================================================
// isDuplicateSubmission
// ============================================================

describe('isDuplicateSubmission', () => {
  it('no recent entries -> not duplicate', () => {
    const r = isDuplicateSubmission({
      normalized: 'play jazz',
      recent: [],
      now: 1000,
      windowMs: 3000,
    });
    expect(r.duplicate).toBe(false);
    expect(r.match).toBeNull();
  });

  it('exact match within window -> duplicate', () => {
    const r = isDuplicateSubmission({
      normalized: 'play jazz',
      recent: [{ text: 'play jazz', time: 900 }],
      now: 1000,
      windowMs: 3000,
    });
    expect(r.duplicate).toBe(true);
    expect(r.match).toEqual({ text: 'play jazz', time: 900 });
  });

  it('exact match outside window -> NOT duplicate', () => {
    const r = isDuplicateSubmission({
      normalized: 'play jazz',
      recent: [{ text: 'play jazz', time: 1 }],
      now: 100_000,
      windowMs: 3000,
    });
    expect(r.duplicate).toBe(false);
  });

  it('new is a prefix of recent -> duplicate', () => {
    // "can you play it on?" -> "can you play it on my speaker?"
    const r = isDuplicateSubmission({
      normalized: 'can you play it on',
      recent: [{ text: 'can you play it on my speaker', time: 900 }],
      now: 1000,
      windowMs: 3000,
    });
    expect(r.duplicate).toBe(true);
  });

  it('recent is a prefix of new -> duplicate', () => {
    const r = isDuplicateSubmission({
      normalized: 'can you play it on my speaker',
      recent: [{ text: 'can you play it on', time: 900 }],
      now: 1000,
      windowMs: 3000,
    });
    expect(r.duplicate).toBe(true);
  });

  it('no overlap -> not duplicate', () => {
    expect(
      isDuplicateSubmission({
        normalized: 'check my calendar',
        recent: [{ text: 'play some jazz', time: 900 }],
        now: 1000,
        windowMs: 3000,
      }).duplicate
    ).toBe(false);
  });

  it('malformed recent entries are skipped, not thrown', () => {
    const r = isDuplicateSubmission({
      normalized: 'play jazz',
      recent: [
        null,
        { text: null, time: 900 },
        { text: 'play jazz' }, // missing time
        { text: 'play jazz', time: 900 }, // valid match
      ],
      now: 1000,
      windowMs: 3000,
    });
    expect(r.duplicate).toBe(true);
  });

  it('empty normalized -> not duplicate', () => {
    expect(
      isDuplicateSubmission({
        normalized: '',
        recent: [{ text: '', time: 1 }],
        now: 2,
      }).duplicate
    ).toBe(false);
  });

  it('returns the FIRST matching entry, not the latest', () => {
    // Matches legacy behavior (first hit in iteration order).
    const r = isDuplicateSubmission({
      normalized: 'play jazz',
      recent: [
        { text: 'play jazz', time: 500 },
        { text: 'play jazz', time: 900 },
      ],
      now: 1000,
      windowMs: 3000,
    });
    expect(r.match.time).toBe(500);
  });
});

// ============================================================
// createDedupTracker
// ============================================================

describe('createDedupTracker', () => {
  let clock;
  let tracker;
  beforeEach(() => {
    clock = 1_000_000;
    tracker = createDedupTracker({ windowMs: 3_000, now: () => clock });
  });

  it('first check -> not duplicate', () => {
    expect(tracker.check('play jazz').duplicate).toBe(false);
  });

  it('record -> check same text -> duplicate', () => {
    tracker.record('play jazz');
    clock += 500;
    const r = tracker.check('play jazz');
    expect(r.duplicate).toBe(true);
    expect(r.normalized).toBe('play jazz');
  });

  it('record + check with different casing/punctuation still detects duplicate', () => {
    tracker.record('Play Jazz!');
    clock += 500;
    expect(tracker.check('play jazz').duplicate).toBe(true);
  });

  it('duplicate expires after window', () => {
    tracker.record('play jazz');
    clock += 3_500; // past 3s window
    expect(tracker.check('play jazz').duplicate).toBe(false);
  });

  it('prefix in either direction is detected', () => {
    tracker.record('can you play it on');
    clock += 200;
    expect(tracker.check('can you play it on my speaker').duplicate).toBe(true);

    tracker = createDedupTracker({ windowMs: 3_000, now: () => clock });
    tracker.record('can you play it on my speaker');
    clock += 200;
    expect(tracker.check('can you play it on').duplicate).toBe(true);
  });

  it('record returns the normalized form', () => {
    expect(tracker.record('Play JAZZ!')).toBe('play jazz');
  });

  it('record on empty/invalid input is a no-op', () => {
    expect(tracker.record('')).toBe('');
    expect(tracker.record(null)).toBe('');
    expect(tracker.record(undefined)).toBe('');
    expect(tracker.size()).toBe(0);
  });

  it('pruneStale drops entries past windowMs * pruneMultiplier', () => {
    tracker.record('a');           // time: 1_000_000
    clock += 10_000;
    tracker.record('b');           // time: 1_010_000
    clock += 10_000;               // now: 1_020_000
    // Window 3_000, multiplier 5 -> cutoff = 1_020_000 - 15_000 = 1_005_000
    // 'a' (at 1_000_000) is before cutoff -> pruned
    // 'b' (at 1_010_000) is after cutoff -> kept
    const pruned = tracker.pruneStale();
    expect(pruned).toBe(1);
    expect(tracker.size()).toBe(1);
  });

  it('clear empties the tracker', () => {
    tracker.record('a');
    tracker.record('b');
    tracker.clear();
    expect(tracker.size()).toBe(0);
    expect(tracker.check('a').duplicate).toBe(false);
  });

  it('DEFAULT_WINDOW_MS and DEFAULT_PRUNE_MULTIPLIER match the desktop values', () => {
    expect(DEFAULT_WINDOW_MS).toBe(3_000);
    expect(DEFAULT_PRUNE_MULTIPLIER).toBe(5);
  });

  it('re-recording the same text updates the timestamp', () => {
    tracker.record('play jazz');
    clock += 1_000;
    tracker.record('play jazz');  // refresh
    clock += 2_500;
    // 3.5s since first record, but only 2.5s since last record.
    expect(tracker.check('play jazz').duplicate).toBe(true);
  });
});

// ============================================================
// Legacy equivalence
// ============================================================

describe('legacy equivalence to inline dedup in exchange-bridge', () => {
  // Reproduces the pre-extraction inline dedup loop:
  //   for (const [recentText, recentTime] of recentSubmissions) {
  //     if (now - recentTime < SUBMIT_DEDUP_WINDOW_MS) {
  //       if (recentText === normalizedTranscript ||
  //           recentText.startsWith(normalizedTranscript) ||
  //           normalizedTranscript.startsWith(recentText)) {
  //         isDuplicate = true;
  //         break;
  //       }
  //     }
  //   }
  function legacyIsDuplicate(normalizedTranscript, recentSubmissionsMap, now, windowMs) {
    for (const [recentText, recentTime] of recentSubmissionsMap) {
      if (now - recentTime < windowMs) {
        if (
          recentText === normalizedTranscript ||
          recentText.startsWith(normalizedTranscript) ||
          normalizedTranscript.startsWith(recentText)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  const scenarios = [
    {
      label: 'empty',
      normalized: 'play jazz',
      recent: new Map(),
      now: 1000,
    },
    {
      label: 'exact match in window',
      normalized: 'play jazz',
      recent: new Map([['play jazz', 900]]),
      now: 1000,
    },
    {
      label: 'exact match past window',
      normalized: 'play jazz',
      recent: new Map([['play jazz', 1]]),
      now: 10000,
    },
    {
      label: 'new is prefix of recent',
      normalized: 'can you play it on',
      recent: new Map([['can you play it on my speaker', 900]]),
      now: 1000,
    },
    {
      label: 'recent is prefix of new',
      normalized: 'can you play it on my speaker',
      recent: new Map([['can you play it on', 900]]),
      now: 1000,
    },
    {
      label: 'no match',
      normalized: 'check my calendar',
      recent: new Map([['play some jazz', 900]]),
      now: 1000,
    },
  ];

  for (const { label, normalized, recent, now } of scenarios) {
    it(label, () => {
      const WINDOW = 3000;
      const legacy = legacyIsDuplicate(normalized, recent, now, WINDOW);
      const extracted = isDuplicateSubmission({
        normalized,
        recent: Array.from(recent.entries()).map(([text, time]) => ({ text, time })),
        now,
        windowMs: WINDOW,
      }).duplicate;
      expect(extracted).toBe(legacy);
    });
  }
});
