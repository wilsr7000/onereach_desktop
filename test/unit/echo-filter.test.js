/**
 * Echo Filter - Unit Tests
 *
 * Run:  npx vitest run test/unit/echo-filter.test.js
 */

import { describe, it, expect } from 'vitest';

const { isLikelyEcho, HARD_BARGE_TOKENS } = require('../../lib/naturalness/echo-filter');

const call = (candidate, ttsText, thresholds) =>
  isLikelyEcho({ candidate, ttsText, thresholds });

describe('echo-filter.isLikelyEcho', () => {
  describe('empty / absent context', () => {
    it('returns not-echo for empty candidate', () => {
      expect(call('', 'hello world').isEcho).toBe(false);
    });

    it('returns not-echo when no TTS is playing', () => {
      const r = call('what time is it', '');
      expect(r.isEcho).toBe(false);
      expect(r.reason).toMatch(/no TTS context/i);
      expect(r.nonEchoContent).toBe('what time is it');
    });
  });

  describe('clear echoes', () => {
    it('short candidate that fully overlaps TTS is echo', () => {
      const r = call('hello there', 'hello there, how can i help');
      expect(r.isEcho).toBe(true);
      expect(r.similarity).toBeGreaterThan(0);
    });

    it('exact match is echo', () => {
      expect(call('hello there', 'hello there').isEcho).toBe(true);
    });

    it('near-match below word limit is echo', () => {
      const r = call('setting a timer', 'got it, setting a timer for five minutes');
      expect(r.isEcho).toBe(true);
    });

    it('single word that matches TTS is echo', () => {
      expect(call('hello', 'hello there friend').isEcho).toBe(true);
    });

    it('long candidate that is fully a subset of TTS is echo', () => {
      const tts =
        'okay, scheduling the meeting with alice for tomorrow at three in the afternoon now';
      const r = call('scheduling the meeting with alice for tomorrow', tts);
      expect(r.isEcho).toBe(true);
    });
  });

  describe('clear user speech (not echo)', () => {
    it('user adding new information mid-TTS is not echo', () => {
      const r = call(
        'change it to four instead',
        'got it, setting a timer for five minutes'
      );
      expect(r.isEcho).toBe(false);
    });

    it('single unique word is not echo (ambiguous -> not echo)', () => {
      const r = call('wait', 'hello there, how can i help');
      expect(r.isEcho).toBe(false);
    });

    it('user speech with low overlap is not echo', () => {
      const r = call(
        'schedule a dentist appointment tomorrow',
        'okay, here is the weather forecast for today'
      );
      expect(r.isEcho).toBe(false);
    });
  });

  describe('hard barge override', () => {
    it('"stop" during TTS is never echo even with other overlap', () => {
      const r = call('stop please', 'please hold while I look that up');
      expect(r.isEcho).toBe(false);
      expect(r.reason).toMatch(/hard barge/i);
    });

    for (const marker of HARD_BARGE_TOKENS) {
      it(`hard barge marker "${marker}" overrides echo`, () => {
        const r = call(`${marker} now`, 'now playing jazz');
        expect(r.isEcho).toBe(false);
      });
    }

    it('hard barge marker IN tts does not trigger override (actual echo possible)', () => {
      // TTS happens to say "stop" -- candidate is an echo
      const r = call('stop', 'we will stop playback in a moment');
      expect(r.isEcho).toBe(true);
    });
  });

  describe('nonEchoContent extraction', () => {
    it('strips overlapping tokens', () => {
      const r = call('setting a timer quickly', 'got it, setting a timer for five');
      expect(r.nonEchoContent).toBe('quickly');
    });

    it('empty when fully overlapping', () => {
      const r = call('hello there', 'hello there');
      expect(r.nonEchoContent).toBe('');
    });
  });

  describe('threshold overrides', () => {
    it('tightening echoSimilarity makes borderline cases not-echo', () => {
      // 'a b c d' vs 'a b x y' -> jaccard 2/6 ≈ 0.33
      const strict = call('a b c d', 'a b x y', { echoSimilarity: 0.9 });
      expect(strict.isEcho).toBe(false);
      const loose = call('a b c d', 'a b x y', { echoSimilarity: 0.2, shortCandidateMaxWords: 6 });
      expect(loose.isEcho).toBe(true);
    });
  });

  describe('defensive inputs', () => {
    it('punctuation and case are ignored', () => {
      const r = call('Hello, THERE!', 'hello there');
      expect(r.isEcho).toBe(true);
    });

    it('null / undefined inputs do not throw', () => {
      expect(() => call(null, 'x')).not.toThrow();
      expect(() => call('x', null)).not.toThrow();
      expect(() => call(undefined, undefined)).not.toThrow();
    });
  });
});
