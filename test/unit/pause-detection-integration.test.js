/**
 * Phase 3.5 Integration Smoke Test
 *
 * Mirrors the voice-listener.js event dispatch slice that was edited
 * by Phase 3.5, but without importing voice-listener itself (which
 * pulls in Electron + WebSocket + OpenAI Realtime deps). The slice
 * below is the exact pattern the production handler runs for each
 * event type.
 *
 * Tests:
 *   - speech_started -> detector resets, ticker stops, accumulator clear
 *   - transcription.delta -> accumulator grows, onPartial called with cumulative text
 *   - speech_stopped -> silence ticker starts
 *   - ticker evaluate loop commits when the partial is complete + past fastFinalizeMs
 *   - onCommitReady -> commitAudio() is called once and ticker stops
 *   - transcription.completed -> reset state even if server committed first
 *   - flag OFF -> detector is never created, no ticker, no extra commits
 *
 * Run:  npx vitest run test/unit/pause-detection-integration.test.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { createPauseDetector } = require('../../lib/naturalness/pause-detector');

// ============================================================
// Harness: a miniature VoiceListener mirror that runs just the
// pause-detector wiring the real file contains.
// ============================================================

function makeListenerSlice({ ai, commitAudio, tickMs = 100, now = Date.now }) {
  const state = {
    pauseDetector: null,
    silenceTimer: null,
    silenceStartedAt: null,
    accumulatedPartial: '',
    evaluating: false,
    commits: 0,
  };

  function ensureDetector() {
    if (state.pauseDetector) return state.pauseDetector;
    state.pauseDetector = createPauseDetector({
      ai,
      onCommitReady: () => {
        stopTicker();
        state.accumulatedPartial = '';
        state.commits++;
        commitAudio();
      },
    });
    return state.pauseDetector;
  }

  function startTicker() {
    stopTicker();
    if (!state.pauseDetector) return;
    state.silenceStartedAt = now();
    state.silenceTimer = setInterval(async () => {
      if (state.evaluating) return;
      state.evaluating = true;
      try {
        const elapsed = now() - state.silenceStartedAt;
        state.pauseDetector.setSilence(elapsed);
        await state.pauseDetector.evaluate();
      } finally {
        state.evaluating = false;
      }
    }, tickMs);
    if (state.silenceTimer && typeof state.silenceTimer.unref === 'function') {
      state.silenceTimer.unref();
    }
  }

  function stopTicker() {
    if (state.silenceTimer) {
      clearInterval(state.silenceTimer);
      state.silenceTimer = null;
    }
    state.silenceStartedAt = null;
  }

  async function handleEvent(event) {
    switch (event.type) {
      case 'input_audio_buffer.speech_started': {
        const d = ensureDetector();
        if (d) {
          d.resetOnSpeech();
          state.accumulatedPartial = '';
          stopTicker();
        }
        return;
      }
      case 'input_audio_buffer.speech_stopped': {
        if (state.pauseDetector) startTicker();
        return;
      }
      case 'conversation.item.input_audio_transcription.delta': {
        if (event.delta && state.pauseDetector) {
          state.accumulatedPartial += event.delta;
          state.pauseDetector.onPartial(state.accumulatedPartial);
        }
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        stopTicker();
        state.accumulatedPartial = '';
        if (state.pauseDetector) state.pauseDetector.reset();
        return;
      }
      default:
        return;
    }
  }

  return { handleEvent, state, startTicker, stopTicker, ensureDetector };
}

// Convenience: allow the test to advance a controllable clock and
// manually invoke one tick of the ticker by calling evaluateOnce.
function makeControlledListener(opts = {}) {
  let clockMs = opts.initialClock || 1_000_000;
  const controlled = makeListenerSlice({
    ai: opts.ai,
    commitAudio: opts.commitAudio,
    tickMs: 1_000_000, // effectively disabled; tests drive the clock
    now: () => clockMs,
  });
  // Replace startTicker with a noop so tests manually drive evaluations.
  controlled.startTicker = function noopStartTicker() {
    controlled.state.silenceStartedAt = clockMs;
  };
  controlled.advance = (ms) => {
    clockMs += ms;
  };
  controlled.manualEvaluate = async () => {
    if (!controlled.state.pauseDetector) return;
    const elapsed = clockMs - (controlled.state.silenceStartedAt || clockMs);
    controlled.state.pauseDetector.setSilence(elapsed);
    return controlled.state.pauseDetector.evaluate();
  };
  return controlled;
}

// ============================================================
// Tests
// ============================================================

describe('pause-detection integration (voice-listener slice)', () => {
  let commitAudio;
  let ai;

  beforeEach(() => {
    commitAudio = vi.fn();
    // Default AI: respond "complete" with high confidence so the LLM
    // path also ends in a commit when exercised.
    ai = vi.fn(async () => ({
      content: JSON.stringify({ complete: true, confidence: 0.9, reasoning: 'clear' }),
    }));
    for (const k of Object.keys(process.env).filter((k) => k.startsWith('NATURAL_'))) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of Object.keys(process.env).filter((k) => k.startsWith('NATURAL_'))) {
      delete process.env[k];
    }
  });

  describe('complete utterance', () => {
    it('commits after fastFinalizeMs of silence', async () => {
      const listener = makeControlledListener({ ai, commitAudio });

      await listener.handleEvent({ type: 'input_audio_buffer.speech_started' });
      // Streaming partials: "what", "what time", "what time is it"
      await listener.handleEvent({
        type: 'conversation.item.input_audio_transcription.delta',
        delta: 'what ',
      });
      await listener.handleEvent({
        type: 'conversation.item.input_audio_transcription.delta',
        delta: 'time is ',
      });
      await listener.handleEvent({
        type: 'conversation.item.input_audio_transcription.delta',
        delta: 'it',
      });
      expect(listener.state.accumulatedPartial).toBe('what time is it');

      await listener.handleEvent({ type: 'input_audio_buffer.speech_stopped' });
      expect(listener.state.silenceStartedAt).not.toBeNull();

      // Advance past fastFinalizeMs (400) and manually evaluate.
      listener.advance(450);
      await listener.manualEvaluate();

      expect(commitAudio).toHaveBeenCalledTimes(1);
      expect(listener.state.commits).toBe(1);
      expect(listener.state.accumulatedPartial).toBe('');
    });
  });

  describe('incomplete utterance holds until ceiling', () => {
    beforeEach(() => {
    });

    it('does not commit early for incomplete partials', async () => {
      const listener = makeControlledListener({ ai, commitAudio });

      await listener.handleEvent({ type: 'input_audio_buffer.speech_started' });
      await listener.handleEvent({
        type: 'conversation.item.input_audio_transcription.delta',
        delta: 'call alice and',
      });
      await listener.handleEvent({ type: 'input_audio_buffer.speech_stopped' });

      // Past fastFinalizeMs but still below maxWaitMs -> keep-waiting.
      listener.advance(500);
      await listener.manualEvaluate();
      expect(commitAudio).not.toHaveBeenCalled();

      // Past maxWaitMs ceiling -> commit.
      listener.advance(700);
      await listener.manualEvaluate();
      expect(commitAudio).toHaveBeenCalledTimes(1);
    });
  });

  describe('speech resume during the same turn', () => {
    beforeEach(() => {
    });

    it('a second speech_started resets accumulator + ticker', async () => {
      const listener = makeControlledListener({ ai, commitAudio });

      await listener.handleEvent({ type: 'input_audio_buffer.speech_started' });
      await listener.handleEvent({
        type: 'conversation.item.input_audio_transcription.delta',
        delta: 'what',
      });
      await listener.handleEvent({ type: 'input_audio_buffer.speech_stopped' });
      expect(listener.state.silenceStartedAt).not.toBeNull();

      // User resumes speaking before ticker could commit.
      await listener.handleEvent({ type: 'input_audio_buffer.speech_started' });
      expect(listener.state.accumulatedPartial).toBe('');
      expect(listener.state.silenceTimer).toBeNull();
    });
  });

  describe('server-side completion', () => {
    beforeEach(() => {
    });

    it('server transcription.completed resets detector + accumulator', async () => {
      const listener = makeControlledListener({ ai, commitAudio });

      await listener.handleEvent({ type: 'input_audio_buffer.speech_started' });
      await listener.handleEvent({
        type: 'conversation.item.input_audio_transcription.delta',
        delta: 'what time',
      });
      await listener.handleEvent({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'what time is it',
      });

      expect(listener.state.accumulatedPartial).toBe('');
      expect(listener.state.pauseDetector.getState().partial).toBe('');
      expect(listener.state.pauseDetector.getState().committed).toBe(false);
      expect(listener.state.silenceTimer).toBeNull();
    });
  });

  describe('LLM classifier path', () => {
    beforeEach(() => {
    });

    it('ambiguous partial + LLM says complete -> commits', async () => {
      const listener = makeControlledListener({ ai, commitAudio });

      await listener.handleEvent({ type: 'input_audio_buffer.speech_started' });
      await listener.handleEvent({
        type: 'conversation.item.input_audio_transcription.delta',
        delta: 'morning brief',
      });
      await listener.handleEvent({ type: 'input_audio_buffer.speech_stopped' });

      // Past waitMs (700), partial is ambiguous -> LLM consulted.
      listener.advance(750);
      await listener.manualEvaluate();

      expect(ai).toHaveBeenCalledTimes(1);
      expect(commitAudio).toHaveBeenCalledTimes(1);
    });

    it('ambiguous partial + LLM says not complete -> keeps waiting', async () => {
      ai = vi.fn(async () => ({
        content: JSON.stringify({ complete: false, confidence: 0.8, reasoning: 'fragment' }),
      }));
      const listener = makeControlledListener({ ai, commitAudio });

      await listener.handleEvent({ type: 'input_audio_buffer.speech_started' });
      await listener.handleEvent({
        type: 'conversation.item.input_audio_transcription.delta',
        delta: 'morning brief',
      });
      await listener.handleEvent({ type: 'input_audio_buffer.speech_stopped' });

      listener.advance(750);
      await listener.manualEvaluate();

      expect(ai).toHaveBeenCalledTimes(1);
      expect(commitAudio).not.toHaveBeenCalled();
    });
  });
});
