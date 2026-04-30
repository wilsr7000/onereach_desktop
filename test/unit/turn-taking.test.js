/**
 * Turn-Taking Policy - Unit Tests
 *
 * Run:  npx vitest run test/unit/turn-taking.test.js
 */

import { describe, it, expect } from 'vitest';

const {
  decide,
  heuristicClassify,
  DEFAULT_THRESHOLDS,
  SINGLE_WORD_FAST_PATHS,
} = require('../../lib/naturalness/turn-taking');

// Convenience wrapper
function call(partial, silenceMs, overrides) {
  return decide({ partial, silenceMs, thresholds: overrides });
}

describe('heuristicClassify', () => {
  describe('complete utterances', () => {
    const completeExamples = [
      'what time is it',
      "what's the weather in tokyo",
      'who is the president',
      'when does the meeting start',
      'how many emails did I get',
      'where is my phone',
      'why is this happening',
      'play some jazz',
      'pause the music',
      'open my calendar',
      'send alice a message',
      'remind me to call mom',
      'tell me about jupiter',
      'cancel the 3pm meeting',
      'schedule a meeting tomorrow',
      'good morning',
      'thanks',
      'give me a morning brief',
    ];
    for (const utterance of completeExamples) {
      it(`flags "${utterance}" as complete`, () => {
        expect(heuristicClassify(utterance)).toBe('complete');
      });
    }
  });

  describe('incomplete utterances', () => {
    const incompleteExamples = [
      'call alice and',
      'what time is it and',
      'schedule a meeting but',
      "send me the report because",
      'i need to',
      'send it to',
      'the',
      'about to',
      'give me the',
      'uh',
      'um',
      'er',
      'mm',
    ];
    for (const utterance of incompleteExamples) {
      it(`flags "${utterance}" as incomplete`, () => {
        expect(heuristicClassify(utterance)).toBe('incomplete');
      });
    }
  });

  describe('single-word fast-paths', () => {
    it('every fast-path word classifies as complete', () => {
      for (const word of SINGLE_WORD_FAST_PATHS) {
        expect(heuristicClassify(word)).toBe('complete');
      }
    });

    it('a single non-fast-path word is ambiguous', () => {
      expect(heuristicClassify('set')).toBe('ambiguous');
      expect(heuristicClassify('maybe')).toBe('ambiguous');
    });
  });

  describe('ambiguous utterances', () => {
    const examples = [
      'i wonder about the weather',
      'jazz music jazz',
      'meeting tomorrow',
      'calendar event calendar',
    ];
    for (const utterance of examples) {
      it(`"${utterance}" is ambiguous (no clear signal)`, () => {
        expect(heuristicClassify(utterance)).toBe('ambiguous');
      });
    }
  });

  describe('defensive inputs', () => {
    it('empty string is ambiguous', () => {
      expect(heuristicClassify('')).toBe('ambiguous');
    });
    it('null / undefined are ambiguous', () => {
      expect(heuristicClassify(null)).toBe('ambiguous');
      expect(heuristicClassify(undefined)).toBe('ambiguous');
    });
    it('all punctuation is ambiguous', () => {
      expect(heuristicClassify('.')).toBe('ambiguous');
      expect(heuristicClassify('?!?')).toBe('ambiguous');
    });
    it('strips trailing punctuation', () => {
      expect(heuristicClassify('play some jazz.')).toBe('complete');
      expect(heuristicClassify('play some jazz!!!')).toBe('complete');
    });
  });
});

describe('decide', () => {
  describe('commit-now', () => {
    it('fires for a complete utterance at the fastFinalizeMs boundary', () => {
      const r = call('what time is it', DEFAULT_THRESHOLDS.fastFinalizeMs);
      expect(r.action).toBe('commit-now');
      expect(r.classification).toBe('complete');
      expect(r.hitMaxWait).toBe(false);
    });

    it('fires for a single-word fast-path after fastFinalizeMs', () => {
      const r = call('cancel', DEFAULT_THRESHOLDS.fastFinalizeMs);
      expect(r.action).toBe('commit-now');
    });

    it('waits before the fastFinalizeMs boundary even when complete', () => {
      const r = call('what time is it', 100);
      expect(r.action).toBe('keep-waiting');
    });
  });

  describe('max-wait ceiling', () => {
    it('commits even when partial is incomplete', () => {
      const r = call('call alice and', DEFAULT_THRESHOLDS.maxWaitMs);
      expect(r.action).toBe('commit-now');
      expect(r.hitMaxWait).toBe(true);
    });

    it('commits even when partial is empty', () => {
      const r = call('', DEFAULT_THRESHOLDS.maxWaitMs);
      expect(r.action).toBe('commit-now');
      expect(r.hitMaxWait).toBe(true);
    });
  });

  describe('keep-waiting', () => {
    it('holds on incomplete utterances below the ceiling', () => {
      const r = call('call alice and', 800);
      expect(r.action).toBe('keep-waiting');
      expect(r.classification).toBe('incomplete');
    });

    it('holds on ambiguous partials below waitMs', () => {
      const r = call('meeting tomorrow', 300);
      expect(r.action).toBe('keep-waiting');
      expect(r.classification).toBe('ambiguous');
    });
  });

  describe('check-llm', () => {
    it('fires when ambiguous at or past waitMs but below maxWait', () => {
      const r = call('meeting tomorrow', DEFAULT_THRESHOLDS.waitMs);
      expect(r.action).toBe('check-llm');
    });

    it('does not fire when partial is classifiable as complete', () => {
      const r = call('what time is it', DEFAULT_THRESHOLDS.waitMs);
      expect(r.action).toBe('commit-now');
    });

    it('does not fire when partial is incomplete', () => {
      const r = call('call alice and', DEFAULT_THRESHOLDS.waitMs);
      expect(r.action).toBe('keep-waiting');
    });
  });

  describe('threshold overrides', () => {
    it('honors custom fastFinalizeMs', () => {
      const r = call('what time is it', 200, { fastFinalizeMs: 150 });
      expect(r.action).toBe('commit-now');
    });

    it('honors custom maxWaitMs', () => {
      const r = call('and', 900, { maxWaitMs: 800 });
      expect(r.action).toBe('commit-now');
      expect(r.hitMaxWait).toBe(true);
    });

    it('honors custom waitMs', () => {
      const r = call('meeting tomorrow', 500, { waitMs: 400 });
      expect(r.action).toBe('check-llm');
    });
  });

  describe('reason is always populated', () => {
    it('returns a non-empty reason for every branch', () => {
      expect(call('what time is it', 500).reason).toBeTruthy();
      expect(call('and', 900).reason).toBeTruthy();
      expect(call('meeting tomorrow', 800).reason).toBeTruthy();
      expect(call('', 200).reason).toBeTruthy();
    });
  });
});
