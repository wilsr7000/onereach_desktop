/**
 * Affect Classifier - Unit Tests
 *
 * Verifies label dispatch, conservative neutral default, tie-breaking
 * priority, and defensive inputs.
 *
 * Run:  npx vitest run test/unit/affect-classifier.test.js
 */

import { describe, it, expect } from 'vitest';

const { classifyAffect } = require('../../lib/naturalness/affect-classifier');

describe('classifyAffect', () => {
  describe('neutral default', () => {
    const neutrals = [
      '',
      'what time is it',
      'play some jazz',
      'hello',
      'schedule a meeting tomorrow at three',
      'remind me to get milk',
    ];
    for (const u of neutrals) {
      it(`"${u}" -> neutral`, () => {
        const r = classifyAffect({ text: u });
        expect(r.label).toBe('neutral');
      });
    }
  });

  describe('frustrated', () => {
    it('strong profanity triggers frustrated', () => {
      const r = classifyAffect({ text: "what the hell, fuck this" });
      expect(r.label).toBe('frustrated');
      expect(r.confidence).toBeGreaterThan(0.3);
      expect(r.signals.some((s) => s.includes('profanity'))).toBe(true);
    });

    it('profanity alone (single word) is enough', () => {
      const r = classifyAffect({ text: 'ugh' });
      expect(r.label).toBe('frustrated');
    });

    it('two mild frustration words trigger frustrated', () => {
      const r = classifyAffect({
        text: "this is really annoying and frustrating",
      });
      expect(r.label).toBe('frustrated');
    });

    it('single mild word alone stays neutral', () => {
      const r = classifyAffect({ text: 'this is really broken' });
      expect(r.label).toBe('neutral');
    });

    it('"stop doing that" is a strong signal', () => {
      const r = classifyAffect({ text: 'stop doing that please' });
      expect(r.label).toBe('frustrated');
    });

    it('repeated request + mild word triggers frustrated', () => {
      const r = classifyAffect({
        text: 'play jazz',
        recentRepeat: true,
      });
      // Repeat alone (2) isn't enough (MIN_SCORE=3). Pair with any signal.
      expect(r.label).toBe('neutral');

      const r2 = classifyAffect({
        text: 'play jazz seriously',
        recentRepeat: true,
      });
      expect(r2.label).toBe('frustrated');
    });

    it('recent errors >= 2 plus mild word triggers frustrated', () => {
      const r = classifyAffect({
        text: 'still broken',
        recentErrors: 2,
      });
      expect(r.label).toBe('frustrated');
    });
  });

  describe('excited', () => {
    it('multiple exclamations plus positive word triggers excited', () => {
      const r = classifyAffect({ text: 'yes!! finally it works!' });
      expect(r.label).toBe('excited');
    });

    it('"nice!" alone stays neutral (one signal each)', () => {
      const r = classifyAffect({ text: 'nice!' });
      // Only score 2 (1 word + 1 bang). Below MIN_SCORE=3.
      expect(r.label).toBe('neutral');
    });

    it('strong excitement does not trip frustrated even with mild-frustration word co-occurring', () => {
      const r = classifyAffect({
        text: 'finally!! got it! amazing!',
      });
      expect(r.label).toBe('excited');
    });
  });

  describe('rushed', () => {
    it('"quick, what time is it" triggers rushed', () => {
      const r = classifyAffect({ text: 'quick, what time is it' });
      expect(r.label).toBe('rushed');
    });

    it('all-caps single phrase triggers rushed', () => {
      const r = classifyAffect({ text: 'STOP IT NOW' });
      expect(r.label).toBe('rushed');
    });

    it('"hurry" counts', () => {
      const r = classifyAffect({ text: 'please hurry up and pause it' });
      expect(r.label).toBe('rushed');
    });
  });

  describe('hesitant', () => {
    it('multiple hedges trigger hesitant', () => {
      const r = classifyAffect({ text: 'um, maybe I guess we could try it' });
      expect(r.label).toBe('hesitant');
    });

    it('single hedge alone stays neutral', () => {
      const r = classifyAffect({ text: 'maybe tomorrow' });
      expect(r.label).toBe('neutral');
    });
  });

  describe('deliberate', () => {
    it('"could you show me the details" plus verbose triggers deliberate', () => {
      const r = classifyAffect({
        text: 'could you show me the details of the three largest categories in the dataset along with their breakdown',
      });
      expect(r.label).toBe('deliberate');
    });

    it('short "could you show me" alone falls short of MIN_SCORE', () => {
      const r = classifyAffect({ text: 'could you show me' });
      // Matches deliberate-phrase (2) but not long enough for verbose (+1).
      expect(r.label).toBe('neutral');
    });
  });

  describe('priority on ties', () => {
    it('frustrated beats excited when both score equal', () => {
      // Profanity(3) + single exclaim(1) vs many bangs but no excite words.
      const r = classifyAffect({ text: 'ugh! yes!' });
      // Both are marginal; frustrated wins on priority.
      expect(['frustrated', 'excited']).toContain(r.label);
      if (r.label !== 'neutral') {
        // If a label fires, frustrated should win ties due to priority.
        expect(r.label).toBe('frustrated');
      }
    });

    it('rushed beats hesitant on priority', () => {
      const r = classifyAffect({ text: 'QUICK GO NOW GO' });
      expect(r.label).toBe('rushed');
    });
  });

  describe('defensive inputs', () => {
    it('null / undefined / empty never throws', () => {
      expect(() => classifyAffect()).not.toThrow();
      expect(() => classifyAffect({})).not.toThrow();
      expect(() => classifyAffect({ text: null })).not.toThrow();
      expect(() => classifyAffect({ text: undefined })).not.toThrow();
      expect(classifyAffect({ text: '' }).label).toBe('neutral');
    });

    it('non-string text is tolerated', () => {
      expect(classifyAffect({ text: 42 }).label).toBe('neutral');
    });
  });

  describe('returned shape', () => {
    it('always includes label, confidence (0..1), signals array', () => {
      const r = classifyAffect({ text: 'ugh this is awful' });
      expect(r).toHaveProperty('label');
      expect(typeof r.label).toBe('string');
      expect(typeof r.confidence).toBe('number');
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
      expect(Array.isArray(r.signals)).toBe(true);
    });
  });
});
