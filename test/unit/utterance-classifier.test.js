/**
 * Utterance Classifier - Unit Tests
 *
 * Exercises the LLM-backed completeness check with an injected AI
 * mock, a controllable clock, and a scripted sequence of LLM
 * responses + errors.
 *
 * Run:  npx vitest run test/unit/utterance-classifier.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { createUtteranceClassifier } = require('../../lib/naturalness/utterance-classifier');

// Helper: build an AI mock from an array of response objects (or errors).
// Each call consumes the next entry.
function seqAi(responses) {
  let i = 0;
  return vi.fn(async () => {
    const entry = responses[i++];
    if (entry instanceof Error) throw entry;
    return entry;
  });
}

// Wrap a JSON payload in the shape our AI service returns.
function aiJson(payload) {
  return { content: JSON.stringify(payload) };
}

describe('createUtteranceClassifier', () => {
  let nowMs;
  let tick;
  beforeEach(() => {
    nowMs = 1_000_000;
    tick = () => nowMs;
  });

  describe('happy path', () => {
    it('asks the injected AI and returns a normalized result', async () => {
      const ai = seqAi([aiJson({ complete: true, confidence: 0.95, reasoning: 'ok' })]);
      const c = createUtteranceClassifier({ ai, now: tick });

      const r = await c.classify('what time is it');
      expect(r.complete).toBe(true);
      expect(r.confidence).toBe(0.95);
      expect(r.source).toBe('llm');
      expect(r.reasoning).toBe('ok');
      expect(ai).toHaveBeenCalledTimes(1);
    });

    it('clamps out-of-range confidence', async () => {
      const ai = seqAi([aiJson({ complete: false, confidence: 7.5, reasoning: 'x' })]);
      const c = createUtteranceClassifier({ ai, now: tick });
      const r = await c.classify('uh');
      expect(r.confidence).toBe(1);
    });

    it('treats non-boolean complete as unparseable', async () => {
      const ai = seqAi([aiJson({ complete: 'yes', confidence: 0.8 })]);
      const c = createUtteranceClassifier({ ai, now: tick });
      const r = await c.classify('what time is it');
      expect(r.complete).toBeNull();
      expect(r.source).toBe('error');
    });

    it('empty partial returns not-complete without calling AI', async () => {
      const ai = vi.fn();
      const c = createUtteranceClassifier({ ai, now: tick });
      const r = await c.classify('');
      expect(r.complete).toBe(false);
      expect(r.source).toBe('empty');
      expect(ai).not.toHaveBeenCalled();
    });

    it('strips markdown code fences from AI output', async () => {
      const ai = seqAi([
        { content: '```json\n{"complete": true, "confidence": 0.9}\n```' },
      ]);
      const c = createUtteranceClassifier({ ai, now: tick });
      const r = await c.classify('play jazz');
      expect(r.complete).toBe(true);
    });
  });

  describe('cache', () => {
    it('returns cached result on re-query within TTL', async () => {
      const ai = seqAi([aiJson({ complete: true, confidence: 0.9, reasoning: 'r' })]);
      const c = createUtteranceClassifier({ ai, now: tick });
      const a = await c.classify('what time is it');
      nowMs += 500;
      const b = await c.classify('what time is it');
      expect(b.complete).toBe(true);
      expect(b.source).toBe('cache');
      expect(ai).toHaveBeenCalledTimes(1);
    });

    it('evicts entries past TTL', async () => {
      const ai = seqAi([
        aiJson({ complete: true, confidence: 0.9 }),
        aiJson({ complete: false, confidence: 0.4 }),
      ]);
      const c = createUtteranceClassifier({
        ai,
        now: tick,
        config: { cacheTtlMs: 1000 },
      });
      await c.classify('meeting tomorrow');
      nowMs += 2000; // past TTL
      const r = await c.classify('meeting tomorrow');
      expect(r.complete).toBe(false);
      expect(r.source).toBe('llm');
      expect(ai).toHaveBeenCalledTimes(2);
    });
  });

  describe('circuit breaker', () => {
    it('opens after N consecutive failures', async () => {
      const ai = seqAi([new Error('net'), new Error('net'), new Error('net')]);
      const c = createUtteranceClassifier({
        ai,
        now: tick,
        config: { failureThreshold: 3 },
      });

      for (let i = 0; i < 3; i++) {
        const r = await c.classify(`unique-${i}`);
        expect(r.complete).toBeNull();
        expect(r.source).toBe('error');
      }

      const circuitResult = await c.classify('anything else');
      expect(circuitResult.source).toBe('circuit-open');
      expect(ai).toHaveBeenCalledTimes(3); // 4th call was short-circuited
    });

    it('resets after circuitResetMs', async () => {
      const ai = seqAi([
        new Error('x'),
        new Error('x'),
        aiJson({ complete: true, confidence: 0.85 }),
      ]);
      const c = createUtteranceClassifier({
        ai,
        now: tick,
        config: { failureThreshold: 2, circuitResetMs: 5000 },
      });

      await c.classify('q1');
      await c.classify('q2');
      expect((await c.classify('q3')).source).toBe('circuit-open');

      nowMs += 6000; // past reset window
      const recovered = await c.classify('q3');
      expect(recovered.complete).toBe(true);
      expect(recovered.source).toBe('llm');
    });

    it('successful call resets failure counter', async () => {
      const ai = seqAi([
        new Error('a'),
        new Error('b'),
        aiJson({ complete: true, confidence: 0.9 }),
        new Error('c'),
      ]);
      const c = createUtteranceClassifier({
        ai,
        now: tick,
        config: { failureThreshold: 3 },
      });
      await c.classify('a');
      await c.classify('b');
      await c.classify('c'); // success, resets
      const r = await c.classify('d');
      expect(r.source).toBe('error'); // not circuit-open yet
    });
  });

  describe('no-ai behavior', () => {
    it('returns unknown when no AI injected', async () => {
      const c = createUtteranceClassifier({ now: tick });
      const r = await c.classify('what time is it');
      expect(r.complete).toBeNull();
      expect(r.source).toBe('no-ai');
    });
  });

  describe('reset + diagnostics', () => {
    it('reset() clears cache and circuit state', async () => {
      const ai = seqAi([aiJson({ complete: true, confidence: 0.9 })]);
      const c = createUtteranceClassifier({ ai, now: tick });
      await c.classify('hi');
      expect(c.getDiagnostics().cacheSize).toBe(1);
      c.reset();
      expect(c.getDiagnostics().cacheSize).toBe(0);
      expect(c.getDiagnostics().circuitFailures).toBe(0);
    });
  });
});
