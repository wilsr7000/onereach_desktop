/**
 * Barge-In Integration Smoke Test
 *
 * Mirrors the slices of voice-speaker.js and voice-listener.js that
 * run the barge flow, exercising them against the real barge-detector
 * singleton with injected mocks. Cannot import voice-speaker /
 * voice-listener directly because both pull in Electron at module
 * load; instead we recreate the exact control flow the production
 * code runs.
 *
 * With the always-on cutover, the barge system has no flag gate --
 * every TTS session feeds the detector, every mic partial during
 * TTS is checked for interrupts.
 *
 * Run:  npx vitest run test/unit/barge-integration.test.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  getSharedBargeDetector,
  configureBargeDetector,
  resetSharedBargeDetector,
} = require('../../lib/naturalness/barge-detector-singleton');

// ============================================================
// Harness: miniature mirrors of the real integrations
// ============================================================

/**
 * Mirror of voice-speaker._doSpeak / _doCancel for the lifecycle
 * events that matter to the barge detector.
 */
function makeSpeakerMirror() {
  const state = { isSpeaking: false };

  function notify(method, text) {
    try {
      const detector = getSharedBargeDetector();
      if (method === 'onTtsStart' || method === 'onTtsUpdate') {
        detector[method](text || '');
      } else {
        detector[method]();
      }
    } catch (_e) { /* barge layer must never block TTS */ }
  }

  return {
    state,
    async speak(text) {
      state.isSpeaking = true;
      notify('onTtsStart', text);
      return true;
    },
    async cancel() {
      state.isSpeaking = false;
      notify('onTtsEnd');
    },
    async finish() {
      state.isSpeaking = false;
      notify('onTtsEnd');
    },
    isSpeaking: () => state.isSpeaking,
  };
}

/**
 * Mirror of voice-listener's transcription event handling.
 * Always feeds user partials to the detector when TTS is playing.
 */
function makeListenerMirror({ speaker }) {
  const state = {
    bargePartial: '',
  };

  function onSpeechStarted() {
    // The production code keeps the input buffer whether TTS is
    // playing or not. No mic-gate clearing any more.
    state.bargePartial = '';
  }

  function onTranscriptionDelta(delta) {
    if (speaker.isSpeaking()) {
      state.bargePartial += delta;
      getSharedBargeDetector().onUserPartial(state.bargePartial);
    } else {
      state.bargePartial = '';
    }
  }

  function onTranscriptionCompleted() {
    state.bargePartial = '';
  }

  return {
    state,
    onSpeechStarted,
    onTranscriptionDelta,
    onTranscriptionCompleted,
  };
}

// ============================================================
// Tests
// ============================================================

describe('barge-in integration (voice-speaker + voice-listener slice)', () => {
  let mockSpeakerCancel;
  let mockSubmitTask;

  beforeEach(() => {
    resetSharedBargeDetector();
    mockSpeakerCancel = vi.fn().mockResolvedValue(true);
    mockSubmitTask = vi.fn().mockResolvedValue({ queued: true });

    configureBargeDetector({
      speaker: { cancel: mockSpeakerCancel },
      submitTask: mockSubmitTask,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
  });

  afterEach(() => {
    resetSharedBargeDetector();
  });

  describe('stop barge', () => {
    it('user says "stop" during TTS -> speaker.cancel called, no submit', async () => {
      const speaker = makeSpeakerMirror();
      const listener = makeListenerMirror({ speaker });

      await speaker.speak('here is the weather forecast for today');
      listener.onSpeechStarted();
      listener.onTranscriptionDelta('stop');
      await new Promise((r) => setImmediate(r));

      expect(mockSpeakerCancel).toHaveBeenCalledTimes(1);
      expect(mockSubmitTask).not.toHaveBeenCalled();
    });
  });

  describe('command barge', () => {
    it('user speaks a new command -> cancel + submit fire', async () => {
      const speaker = makeSpeakerMirror();
      const listener = makeListenerMirror({ speaker });

      await speaker.speak('here is the weather forecast for today');
      listener.onSpeechStarted();
      listener.onTranscriptionDelta('what about tomorrow');
      await new Promise((r) => setImmediate(r));

      expect(mockSpeakerCancel).toHaveBeenCalledTimes(1);
      expect(mockSubmitTask).toHaveBeenCalledTimes(1);
      const [text, opts] = mockSubmitTask.mock.calls[0];
      expect(text).toBe('what about tomorrow');
      expect(opts.metadata.barged).toBe(true);
    });
  });

  describe('ack during TTS', () => {
    it('no cancel, no submit', async () => {
      const speaker = makeSpeakerMirror();
      const listener = makeListenerMirror({ speaker });

      await speaker.speak('playing some jazz for you now');
      listener.onSpeechStarted();
      listener.onTranscriptionDelta('yeah');
      await new Promise((r) => setImmediate(r));

      expect(mockSpeakerCancel).not.toHaveBeenCalled();
      expect(mockSubmitTask).not.toHaveBeenCalled();
    });
  });

  describe('echo during TTS', () => {
    it('mic picks up TTS words -> no cancel', async () => {
      const speaker = makeSpeakerMirror();
      const listener = makeListenerMirror({ speaker });

      await speaker.speak('here is the weather forecast for today and tomorrow');
      listener.onSpeechStarted();
      listener.onTranscriptionDelta('weather forecast');
      await new Promise((r) => setImmediate(r));

      expect(mockSpeakerCancel).not.toHaveBeenCalled();
      expect(mockSubmitTask).not.toHaveBeenCalled();
    });
  });

  describe('piecewise streaming', () => {
    it('fires barge on the first classifiable partial (cooldown protects later chunks)', async () => {
      // Models the real-world constraint: the detector fires on the
      // first cumulative partial that classifies, not the final text.
      const speaker = makeSpeakerMirror();
      const listener = makeListenerMirror({ speaker });

      await speaker.speak('playing some jazz for you now');
      listener.onSpeechStarted();
      listener.onTranscriptionDelta('what ');
      listener.onTranscriptionDelta('about ');
      listener.onTranscriptionDelta('tomorrow');
      await new Promise((r) => setImmediate(r));

      expect(mockSubmitTask).toHaveBeenCalledTimes(1);
      const [text] = mockSubmitTask.mock.calls[0];
      expect(text).toBe('what');
    });

    it('full command in one delta chunk submits the complete text', async () => {
      const speaker = makeSpeakerMirror();
      const listener = makeListenerMirror({ speaker });

      await speaker.speak('playing some jazz for you now');
      listener.onSpeechStarted();
      listener.onTranscriptionDelta('what about tomorrow');
      await new Promise((r) => setImmediate(r));

      expect(mockSubmitTask).toHaveBeenCalledTimes(1);
      const [text] = mockSubmitTask.mock.calls[0];
      expect(text).toBe('what about tomorrow');
    });
  });

  describe('TTS lifecycle', () => {
    it('TTS finishes naturally -> detector cleared for next round', async () => {
      const speaker = makeSpeakerMirror();
      const listener = makeListenerMirror({ speaker });

      await speaker.speak('playing some jazz');
      await speaker.finish();

      // Well past grace window.
      await new Promise((r) => setTimeout(r, 400));
      listener.onTranscriptionDelta('stop');
      await new Promise((r) => setImmediate(r));

      expect(mockSpeakerCancel).not.toHaveBeenCalled();
    });

    it('TTS cancel propagates onTtsEnd to detector', async () => {
      const speaker = makeSpeakerMirror();
      const listener = makeListenerMirror({ speaker });

      await speaker.speak('playing some jazz');
      await speaker.cancel();

      await new Promise((r) => setTimeout(r, 400));
      listener.onTranscriptionDelta('what about tomorrow');
      await new Promise((r) => setImmediate(r));

      // Injected mock never gets called here (the local cancel didn't
      // route through the singleton callback). And no barge fires
      // because TTS ended before the partial arrived.
      expect(mockSpeakerCancel).not.toHaveBeenCalled();
      expect(mockSubmitTask).not.toHaveBeenCalled();
    });
  });

  describe('speech lifecycle resets', () => {
    it('speech_started clears barge partial mid-turn', async () => {
      const speaker = makeSpeakerMirror();
      const listener = makeListenerMirror({ speaker });

      await speaker.speak('playing some jazz');
      listener.onSpeechStarted();
      listener.onTranscriptionDelta('um actually');
      await new Promise((r) => setImmediate(r));
      expect(mockSpeakerCancel).toHaveBeenCalledTimes(1);

      listener.onSpeechStarted();
      expect(listener.state.bargePartial).toBe('');
    });

    it('transcription.completed clears barge partial', async () => {
      const speaker = makeSpeakerMirror();
      const listener = makeListenerMirror({ speaker });

      await speaker.speak('playing some jazz');
      listener.onSpeechStarted();
      listener.onTranscriptionDelta('hmm');
      listener.onTranscriptionCompleted();

      expect(listener.state.bargePartial).toBe('');
    });
  });
});
