/**
 * Barge Classifier - Unit Tests
 *
 * Run:  npx vitest run test/unit/barge-classifier.test.js
 */

import { describe, it, expect } from 'vitest';

const {
  classifyBarge,
  STOP_PHRASES,
  ACK_PHRASES,
  COMMAND_LEAD_TOKENS,
} = require('../../lib/naturalness/barge-classifier');

const kind = (text, opts) => classifyBarge(text, opts).kind;

describe('classifyBarge', () => {
  describe('stop phrases', () => {
    for (const phrase of STOP_PHRASES) {
      it(`classifies "${phrase}" as stop`, () => {
        const r = classifyBarge(phrase);
        expect(r.kind).toBe('stop');
        expect(r.confidence).toBeGreaterThan(0.8);
      });
    }

    it('classifies stop phrase with trailing words as stop', () => {
      expect(kind('stop please')).toBe('stop');
      expect(kind('cancel that one')).toBe('stop');
      expect(kind('never mind, sorry')).toBe('stop');
    });

    it('does not false-match when the stop word is mid-sentence', () => {
      expect(kind('can you stop at the bakery')).not.toBe('stop');
    });
  });

  describe('ack phrases', () => {
    for (const phrase of ACK_PHRASES) {
      it(`classifies "${phrase}" as ack`, () => {
        const r = classifyBarge(phrase);
        expect(r.kind).toBe('ack');
        expect(r.confidence).toBeGreaterThan(0.8);
      });
    }

    it('hyphenated forms normalize and still match', () => {
      expect(kind('mm-hmm')).toBe('ack');
      expect(kind('uh-huh')).toBe('ack');
    });

    it('short ack with trailing word still classifies as ack', () => {
      expect(kind('yes please')).toBe('ack');
      expect(kind('ok sure')).toBe('ack');
    });
  });

  describe('commands', () => {
    it('interrogatives are commands', () => {
      expect(kind('what about tomorrow')).toBe('command');
      expect(kind('when does it start')).toBe('command');
      expect(kind('how many emails do i have')).toBe('command');
    });

    it('imperative verbs at the start are commands', () => {
      expect(kind('play some jazz')).toBe('command');
      expect(kind('open my calendar')).toBe('command');
      expect(kind('send alice a message')).toBe('command');
      expect(kind('schedule a meeting with bob tomorrow')).toBe('command');
    });

    it('"cancel X" is a stop (phrase list wins over command list)', () => {
      // Phrase list match fires first, so "cancel that meeting" is
      // classified as a stop of the TTS. That's fine: the detector
      // caller then submits the raw text as a fresh task itself.
      expect(kind('cancel that meeting')).toBe('stop');
    });

    it('command word list members are recognized', () => {
      for (const tok of ['play', 'open', 'send', 'schedule', 'search']) {
        expect(COMMAND_LEAD_TOKENS.has(tok)).toBe(true);
      }
    });

    it('long utterance without a recognized command verb is still a command (best-effort)', () => {
      const r = classifyBarge('the thing i was telling you about yesterday');
      expect(r.kind).toBe('command');
      expect(r.confidence).toBeLessThan(0.8);
    });
  });

  describe('unclear', () => {
    it('empty input is unclear with zero confidence', () => {
      const r = classifyBarge('');
      expect(r.kind).toBe('unclear');
      expect(r.confidence).toBe(0);
    });

    it('short ambiguous phrase is unclear', () => {
      expect(kind('hmm')).toBe('unclear');
      expect(kind('maybe')).toBe('unclear');
    });
  });

  describe('stop beats ack on overlap', () => {
    it('"actually" is stop even though it could be interpreted as start of a command', () => {
      expect(kind('actually')).toBe('stop');
      expect(kind('actually change that to four')).toBe('stop');
    });
  });

  describe('defensive inputs', () => {
    it('null / undefined returns unclear without throwing', () => {
      expect(classifyBarge(null).kind).toBe('unclear');
      expect(classifyBarge(undefined).kind).toBe('unclear');
    });

    it('punctuation and casing are normalized', () => {
      expect(kind('STOP!')).toBe('stop');
      expect(kind('  Yes.  ')).toBe('ack');
    });
  });

  describe('threshold overrides', () => {
    it('lowering maxPhraseWords lets a 3-word utterance skip phrase match', () => {
      // "cancel the thing" -> phrase-list match "cancel" still wins (stop).
      expect(kind('cancel the thing', { thresholds: { maxPhraseWords: 1 } })).toBe('stop');
      // A non-matching short utterance treated as long/command when threshold is low
      const r = classifyBarge('change that setting', { thresholds: { maxPhraseWords: 1 } });
      expect(r.kind).toBe('command');
    });
  });
});
