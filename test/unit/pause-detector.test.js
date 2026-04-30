/**
 * Pause Detector - Unit Tests
 *
 * Drives the stateful detector with scripted event sequences and
 * asserts commit timing, LLM consultation patterns, idempotency,
 * and reset semantics.
 *
 * Run:  npx vitest run test/unit/pause-detector.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { createPauseDetector } = require('../../lib/naturalness/pause-detector');

// Default thresholds from turn-taking: fastFinalizeMs=400, waitMs=700, maxWaitMs=1100.

function makeAiMock(responses) {
  let i = 0;
  return vi.fn(async () => {
    const entry = responses[i++];
    if (entry instanceof Error) throw entry;
    return { content: JSON.stringify(entry) };
  });
}

describe('createPauseDetector', () => {
  let onCommitReady;
  let onClassifyNeeded;
  let detector;
  let ai;

  beforeEach(() => {
    onCommitReady = vi.fn();
    onClassifyNeeded = vi.fn();
    ai = null;
  });

  function build(responses = []) {
    ai = makeAiMock(responses);
    detector = createPauseDetector({
      ai,
      onCommitReady,
      onClassifyNeeded,
    });
  }

  describe('fast-path (no LLM)', () => {
    it('commits a complete utterance at fastFinalizeMs', async () => {
      build();
      detector.onPartial('what time is it');
      detector.setSilence(400);
      const r = await detector.evaluate();
      expect(r.action).toBe('commit-now');
      expect(onCommitReady).toHaveBeenCalledTimes(1);
      expect(onCommitReady).toHaveBeenCalledWith('what time is it', expect.objectContaining({
        classification: 'complete',
        silenceMs: 400,
      }));
      expect(onClassifyNeeded).not.toHaveBeenCalled();
      expect(ai).not.toHaveBeenCalled();
    });

    it('holds while silence is below fastFinalizeMs', async () => {
      build();
      detector.onPartial('what time is it');
      detector.setSilence(200);
      const r = await detector.evaluate();
      expect(r.action).toBe('keep-waiting');
      expect(onCommitReady).not.toHaveBeenCalled();
    });

    it('holds on incomplete partial even at fastFinalizeMs', async () => {
      build();
      detector.onPartial('call alice and');
      detector.setSilence(400);
      const r = await detector.evaluate();
      expect(r.action).toBe('keep-waiting');
      expect(r.classification).toBe('incomplete');
      expect(ai).not.toHaveBeenCalled();
    });
  });

  describe('max-wait ceiling', () => {
    it('commits even incomplete partial at maxWaitMs', async () => {
      build();
      detector.onPartial('call alice and');
      detector.setSilence(1100);
      const r = await detector.evaluate();
      expect(r.action).toBe('commit-now');
      expect(r.hitMaxWait).toBe(true);
      expect(onCommitReady).toHaveBeenCalled();
    });

    it('commits empty partial at maxWaitMs (edge case)', async () => {
      build();
      detector.setSilence(1100);
      const r = await detector.evaluate();
      expect(r.action).toBe('commit-now');
      expect(r.hitMaxWait).toBe(true);
    });
  });

  describe('LLM classifier path', () => {
    it('asks the LLM for ambiguous partials past waitMs', async () => {
      build([{ complete: true, confidence: 0.85, reasoning: 'ok' }]);
      detector.onPartial('meeting tomorrow');
      detector.setSilence(700);
      const r = await detector.evaluate();
      expect(onClassifyNeeded).toHaveBeenCalledWith('meeting tomorrow');
      expect(ai).toHaveBeenCalledTimes(1);
      expect(r.action).toBe('commit-now');
      expect(onCommitReady).toHaveBeenCalledTimes(1);
    });

    it('holds when LLM says not complete', async () => {
      build([{ complete: false, confidence: 0.8, reasoning: 'fragment' }]);
      detector.onPartial('meeting tomorrow');
      detector.setSilence(700);
      const r = await detector.evaluate();
      expect(r.action).toBe('keep-waiting');
      expect(r.classification).toBe('incomplete');
      expect(onCommitReady).not.toHaveBeenCalled();
    });

    it('holds when LLM is uncertain (low confidence)', async () => {
      build([{ complete: true, confidence: 0.4, reasoning: 'maybe' }]);
      detector.onPartial('meeting tomorrow');
      detector.setSilence(700);
      const r = await detector.evaluate();
      expect(r.action).toBe('keep-waiting');
      expect(onCommitReady).not.toHaveBeenCalled();
    });

    it('holds when LLM errors / circuit is open', async () => {
      build([new Error('net'), new Error('net'), new Error('net')]);
      detector.onPartial('meeting tomorrow');
      detector.setSilence(700);
      await detector.evaluate();
      // Different partial to avoid cache hit on same text
      detector.onPartial('calendar event today');
      detector.setSilence(700);
      await detector.evaluate();
      detector.onPartial('dinner at 6');
      detector.setSilence(700);
      const r = await detector.evaluate();
      expect(r.action).toBe('keep-waiting');
      expect(onCommitReady).not.toHaveBeenCalled();
    });
  });

  describe('idempotency', () => {
    it('only fires onCommitReady once per turn', async () => {
      build();
      detector.onPartial('what time is it');
      detector.setSilence(500);
      await detector.evaluate();
      await detector.evaluate();
      await detector.evaluate();
      expect(onCommitReady).toHaveBeenCalledTimes(1);
      expect(detector.getState().commitCount).toBe(1);
    });

    it('second evaluate after commit returns already-committed', async () => {
      build();
      detector.onPartial('what time is it');
      detector.setSilence(500);
      await detector.evaluate();
      const r = await detector.evaluate();
      expect(r.action).toBe('already-committed');
    });
  });

  describe('resetOnSpeech', () => {
    it('allows a fresh turn after the user resumes speaking', async () => {
      build();
      detector.onPartial('what time is it');
      detector.setSilence(500);
      await detector.evaluate();
      expect(detector.getState().committed).toBe(true);

      detector.resetOnSpeech();
      detector.onPartial('what is the weather');
      detector.setSilence(500);
      const r = await detector.evaluate();
      expect(r.action).toBe('commit-now');
      expect(onCommitReady).toHaveBeenCalledTimes(2);
      expect(detector.getState().commitCount).toBe(2);
    });

    it('onPartial resets silence (speech means not silent)', () => {
      build();
      detector.setSilence(500);
      detector.onPartial('new words');
      expect(detector.getState().silenceMs).toBe(0);
    });
  });

  describe('reset', () => {
    it('wipes all state', async () => {
      build();
      detector.onPartial('hi');
      detector.setSilence(500);
      await detector.evaluate();
      detector.reset();
      const s = detector.getState();
      expect(s.partial).toBe('');
      expect(s.silenceMs).toBe(0);
      expect(s.committed).toBe(false);
      expect(s.commitCount).toBe(0);
      expect(s.lastDecision).toBeNull();
    });
  });

  describe('onDecision observer', () => {
    it('fires on every evaluate() with the policy decision', async () => {
      const onDecision = vi.fn();
      ai = makeAiMock([]);
      const d = createPauseDetector({ ai, onCommitReady, onDecision });
      d.onPartial('what time is it');
      d.setSilence(500);
      await d.evaluate();
      expect(onDecision).toHaveBeenCalled();
      const [decision] = onDecision.mock.calls[0];
      expect(decision.action).toBe('commit-now');
    });
  });

  describe('onCommitReady error isolation', () => {
    it('detector state still advances if callback throws', async () => {
      const badCb = vi.fn(() => {
        throw new Error('bad callback');
      });
      ai = makeAiMock([]);
      const d = createPauseDetector({ ai, onCommitReady: badCb });
      d.onPartial('what time is it');
      d.setSilence(500);
      const r = await d.evaluate();
      expect(r.action).toBe('commit-now');
      expect(d.getState().committed).toBe(true);
    });
  });
});
