/**
 * Correction Detector - Unit Tests
 *
 * Run:  npx vitest run test/unit/correction-detector.test.js
 */

import { describe, it, expect } from 'vitest';

const {
  detectCorrection,
  detectUndoCorrection,
} = require('../../lib/naturalness/correction-detector');

describe('detectCorrection', () => {
  describe('I said X not Y', () => {
    it('extracts heard = Y, meant = X', () => {
      const r = detectCorrection('I said jazz not jess');
      expect(r).toEqual({ heard: 'jess', meant: 'jazz', pattern: 'I-said-X-not-Y' });
    });

    it('works with "I meant"', () => {
      const r = detectCorrection('I meant jazz not jess');
      expect(r).toMatchObject({ heard: 'jess', meant: 'jazz' });
    });

    it('works with "No, I said"', () => {
      const r = detectCorrection('no, I said jazz not jess');
      expect(r).toMatchObject({ heard: 'jess', meant: 'jazz' });
    });

    it('handles multi-word slots', () => {
      const r = detectCorrection('I said alice smith not ellis smith');
      expect(r).toMatchObject({ heard: 'ellis smith', meant: 'alice smith' });
    });
  });

  describe('not Y, X', () => {
    it('"not jess, jazz"', () => {
      const r = detectCorrection('not jess, jazz');
      expect(r).toEqual({ heard: 'jess', meant: 'jazz', pattern: 'not-Y-X' });
    });

    it('"not jess I meant jazz"', () => {
      const r = detectCorrection('not jess I meant jazz');
      expect(r).toMatchObject({ heard: 'jess', meant: 'jazz' });
    });
  });

  describe('I meant X (needs prior)', () => {
    it('diffs a single token against prior', () => {
      const r = detectCorrection('I meant jazz', 'play jess');
      expect(r).toEqual({ heard: 'jess', meant: 'jazz', pattern: 'I-meant-X' });
    });

    it('returns null when prior has no unique token to blame', () => {
      // Prior identical-ish to meant -- no diff.
      expect(detectCorrection('I meant jazz', 'jazz')).toBeNull();
    });

    it('picks the last content token as heard when prior has multiple candidates', () => {
      // Heuristic: with multiple candidates, prefer the tail of the
      // prior utterance (typically the proper-noun slot).
      const r = detectCorrection('I meant jazz', 'play loud jess');
      expect(r).toMatchObject({ heard: 'jess', meant: 'jazz' });
    });

    it('returns null when no prior utterance is provided', () => {
      expect(detectCorrection('I meant jazz')).toBeNull();
      expect(detectCorrection('I meant jazz', '')).toBeNull();
    });
  });

  describe('actually X (needs prior)', () => {
    it('"actually jazz" after "play jess"', () => {
      const r = detectCorrection('actually jazz', 'play jess');
      expect(r).toMatchObject({ heard: 'jess', meant: 'jazz', pattern: 'actually-X' });
    });
  });

  describe('no it\'s X / no that\'s X', () => {
    it('"no it\'s jazz" after "play jess"', () => {
      const r = detectCorrection("no it's jazz", 'play jess');
      expect(r).toMatchObject({ heard: 'jess', meant: 'jazz' });
    });

    it('"no that was alice" after "call ellis"', () => {
      const r = detectCorrection('no that was alice', 'call ellis');
      expect(r).toMatchObject({ heard: 'ellis', meant: 'alice' });
    });
  });

  describe('non-corrections', () => {
    const nonCorrections = [
      '',
      'hello there',
      'play jazz',
      'what time is it',
      'schedule a meeting tomorrow',
      'thanks',
    ];
    for (const u of nonCorrections) {
      it(`"${u}" is not a correction`, () => {
        expect(detectCorrection(u, 'play jess')).toBeNull();
      });
    }
  });

  describe('defensive inputs', () => {
    it('null / undefined do not throw', () => {
      expect(detectCorrection(null)).toBeNull();
      expect(detectCorrection(undefined)).toBeNull();
      expect(detectCorrection('I meant jazz', null)).toBeNull();
    });

    it('trailing punctuation does not break pattern matches', () => {
      expect(detectCorrection('I meant jazz!', 'play jess')).toMatchObject({
        heard: 'jess',
        meant: 'jazz',
      });
      expect(detectCorrection('I said jazz not jess.')).toMatchObject({
        heard: 'jess',
        meant: 'jazz',
      });
    });
  });
});

describe('detectUndoCorrection', () => {
  const UNDO_PHRASES = [
    'forget that fix',
    'forget that correction',
    'forget the last fix',
    'forget the last correction',
    'forget my fix',
    'forget what you learned',
    'forget what you learnt',
    'please forget that fix',
    'undo that fix',
    'undo that correction',
    'undo the last fix',
    'undo my last correction',
    'never mind that fix',
    'never mind that correction',
    'never mind the last fix',
    'that fix was wrong',
    'the last correction was wrong',
    'that last fix was wrong',
  ];

  for (const phrase of UNDO_PHRASES) {
    it(`detects: "${phrase}"`, () => {
      const r = detectUndoCorrection(phrase);
      expect(r).toMatchObject({ undo: true });
    });
  }

  describe('trailing punctuation is tolerated', () => {
    it('"forget that fix!"', () => {
      expect(detectUndoCorrection('forget that fix!')).toMatchObject({ undo: true });
    });
    it('"forget that correction."', () => {
      expect(detectUndoCorrection('forget that correction.')).toMatchObject({ undo: true });
    });
  });

  describe('does NOT match ambiguous undo-like phrases', () => {
    const nonUndos = [
      'never mind',                       // too ambiguous, user might be cancelling
      'forget it',                        // could be cancellation
      'that was wrong',                   // lacks "fix" / "correction"
      'undo',                             // too broad
      'undo my last email',               // different task
      'forget about the meeting',         // unrelated
      'never mind the email',             // unrelated
      'i meant jazz',                     // this is a learn, not an undo
    ];
    for (const u of nonUndos) {
      it(`"${u}" is NOT an undo`, () => {
        expect(detectUndoCorrection(u)).toBeNull();
      });
    }
  });

  describe('defensive inputs', () => {
    it('null / undefined / empty strings', () => {
      expect(detectUndoCorrection(null)).toBeNull();
      expect(detectUndoCorrection(undefined)).toBeNull();
      expect(detectUndoCorrection('')).toBeNull();
      expect(detectUndoCorrection('   ')).toBeNull();
    });
  });
});
