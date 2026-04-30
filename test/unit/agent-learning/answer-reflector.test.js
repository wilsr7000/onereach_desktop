/**
 * AnswerReflector tests
 *
 * Run: npx vitest run test/unit/agent-learning/answer-reflector.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const {
  AnswerReflector,
  LOW_QUALITY_THRESHOLD,
} = require('../../../lib/agent-learning/answer-reflector');

function makeMockAi(response) {
  return {
    json: vi.fn(async () => response),
  };
}

describe('AnswerReflector', () => {
  let reflector;

  beforeEach(() => {
    reflector = new AnswerReflector({ sampleRate: 1.0, highConfSampleRate: 1.0 });
  });

  describe('shouldReflect', () => {
    it('reflects on successful answers with content', () => {
      expect(reflector.shouldReflect({
        agent: { id: 'search-agent' },
        result: { success: true, message: 'Berkeley has good coffee.' },
        userInput: 'coffee shops in Berkeley',
      })).toBe(true);
    });

    it('skips when agent explicitly opts out', () => {
      expect(reflector.shouldReflect({
        agent: { id: 'docs-agent', skipReflection: true },
        result: { success: true, message: 'answer' },
        userInput: 'q',
      })).toBe(false);
    });

    it('skips when agent already marked failure', () => {
      expect(reflector.shouldReflect({
        agent: { id: 'x' },
        result: { success: false, message: 'failed' },
        userInput: 'q',
      })).toBe(false);
    });

    it('skips when result is needsInput (mid-conversation)', () => {
      expect(reflector.shouldReflect({
        agent: { id: 'x' },
        result: { success: true, message: 'ask', needsInput: { prompt: 'what city?' } },
        userInput: 'q',
      })).toBe(false);
    });

    it('skips when answer is empty or trivial', () => {
      expect(reflector.shouldReflect({
        agent: { id: 'x' },
        result: { success: true, message: '' },
        userInput: 'q',
      })).toBe(false);
      expect(reflector.shouldReflect({
        agent: { id: 'x' },
        result: { success: true, message: 'ok' },
        userInput: 'q',
      })).toBe(false);
    });

    it('respects sample rate (0 = always skip)', () => {
      const r = new AnswerReflector({ sampleRate: 0 });
      expect(r.shouldReflect({
        agent: { id: 'x' },
        result: { success: true, message: 'good answer here' },
        userInput: 'q',
      })).toBe(false);
    });
  });

  describe('reflect', () => {
    it('returns scores and overall for a good answer', async () => {
      reflector._setAi(makeMockAi({
        grounded: 0.9, relevant: 0.9, complete: 0.85, confident: 0.9,
        issues: [], verdict: 'well grounded',
      }));
      const r = await reflector.reflect({
        agent: { id: 'search-agent' },
        task: { id: 't1', content: 'coffee shops in Berkeley' },
        result: { success: true, message: 'Jaffa Coffee Roasters and The Hidden Cafe are two popular spots in Berkeley.' },
        evidence: [{ title: 'Jaffa Coffee Roasters', snippet: 'Cafe in Berkeley', url: 'x' }],
      });
      expect(r.scores.grounded).toBeCloseTo(0.9, 1);
      expect(r.overall).toBeGreaterThan(0.8);
      expect(r.lowQuality).toBe(false);
    });

    it('flags low-quality answers', async () => {
      reflector._setAi(makeMockAi({
        grounded: 0.2, relevant: 0.3, complete: 0.4, confident: 0.5,
        issues: ['ungrounded', 'vague'],
        verdict: 'barely on-topic',
      }));
      const r = await reflector.reflect({
        agent: { id: 'x' },
        task: { id: 't2', content: 'what is quantum computing' },
        result: { success: true, message: 'It is a thing.' },
      });
      expect(r.overall).toBeLessThan(LOW_QUALITY_THRESHOLD);
      expect(r.lowQuality).toBe(true);
      expect(r.issues.length).toBeGreaterThan(0);
    });

    it('clamps malformed scores into 0-1 range', async () => {
      reflector._setAi(makeMockAi({
        grounded: 2.5, relevant: -0.1, complete: 'bogus', confident: 0.7,
      }));
      const r = await reflector.reflect({
        agent: { id: 'x' },
        task: { id: 't3', content: 'q' },
        result: { success: true, message: 'answer text here please' },
      });
      expect(r.scores.grounded).toBe(1);
      expect(r.scores.relevant).toBe(0);
      expect(r.scores.complete).toBe(0.5); // non-numeric -> default
      expect(r.scores.confident).toBe(0.7);
    });

    it('returns skipped record on judge failure (never throws)', async () => {
      reflector._setAi({ json: vi.fn(async () => { throw new Error('judge crashed'); }) });
      const r = await reflector.reflect({
        agent: { id: 'x' },
        task: { id: 't4', content: 'q' },
        result: { success: true, message: 'answer content' },
      });
      expect(r.skipped).toBe(true);
      expect(r.error).toMatch(/crashed/);
    });

    it('coalesces duplicate reflections of the same task', async () => {
      const ai = makeMockAi({
        grounded: 0.8, relevant: 0.8, complete: 0.8, confident: 0.8,
      });
      reflector._setAi(ai);
      const args = {
        agent: { id: 'x' },
        task: { id: 't5', content: 'q' },
        result: { success: true, message: 'answer text to be judged' },
      };
      const [a, b] = await Promise.all([
        reflector.reflect(args),
        reflector.reflect(args),
      ]);
      expect(a).toBe(b); // same promise / same record
      expect(ai.json).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStatsByAgent', () => {
    it('aggregates scores by agent', async () => {
      reflector._setAi(makeMockAi({
        grounded: 0.9, relevant: 0.9, complete: 0.9, confident: 0.9,
      }));
      await reflector.reflect({
        agent: { id: 'search-agent' },
        task: { id: 'a' },
        result: { success: true, message: 'one' },
      });
      reflector._setAi(makeMockAi({
        grounded: 0.2, relevant: 0.2, complete: 0.2, confident: 0.2,
      }));
      await reflector.reflect({
        agent: { id: 'search-agent' },
        task: { id: 'b' },
        result: { success: true, message: 'two' },
      });
      const stats = reflector.getStatsByAgent();
      expect(stats['search-agent'].count).toBe(2);
      expect(stats['search-agent'].lowQualityRate).toBeCloseTo(0.5, 1);
    });
  });
});
