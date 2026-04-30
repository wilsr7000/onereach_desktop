/**
 * Barge Detector - Unit Tests
 *
 * Drives the stateful detector with scripted TTS + user-speech events
 * on an injected clock, asserting fire / suppress decisions and their
 * reasons.
 *
 * Run:  npx vitest run test/unit/barge-detector.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { createBargeDetector } = require('../../lib/naturalness/barge-detector');

describe('createBargeDetector', () => {
  let nowMs;
  let onBargeIn;
  let onEchoSuppressed;
  let onIgnored;
  let detector;

  function build(extra = {}) {
    detector = createBargeDetector({
      now: () => nowMs,
      onBargeIn,
      onEchoSuppressed,
      onIgnored,
      ...extra,
    });
  }

  beforeEach(() => {
    nowMs = 1_000_000;
    onBargeIn = vi.fn();
    onEchoSuppressed = vi.fn();
    onIgnored = vi.fn();
    build();
  });

  describe('no TTS active', () => {
    it('ignores user speech entirely', () => {
      detector.onUserPartial('stop');
      expect(onBargeIn).not.toHaveBeenCalled();
      expect(onIgnored).toHaveBeenCalledTimes(1);
      expect(onIgnored.mock.calls[0][0].kind).toBe('no-tts');
    });

    it('ignores any speech including commands', () => {
      detector.onUserPartial('play some jazz');
      expect(onBargeIn).not.toHaveBeenCalled();
    });
  });

  describe('stop barge', () => {
    beforeEach(() => {
      detector.onTtsStart('here is the weather forecast for today');
    });

    it('fires on "stop"', () => {
      detector.onUserPartial('stop');
      expect(onBargeIn).toHaveBeenCalledTimes(1);
      const ev = onBargeIn.mock.calls[0][0];
      expect(ev.kind).toBe('stop');
      expect(ev.text).toBe('stop');
    });

    it('fires on "wait please"', () => {
      detector.onUserPartial('wait please');
      expect(onBargeIn).toHaveBeenCalledTimes(1);
      expect(onBargeIn.mock.calls[0][0].kind).toBe('stop');
    });

    it('fires on "actually change that"', () => {
      detector.onUserPartial('actually change that');
      expect(onBargeIn).toHaveBeenCalledTimes(1);
      expect(onBargeIn.mock.calls[0][0].kind).toBe('stop');
    });
  });

  describe('command barge', () => {
    beforeEach(() => {
      detector.onTtsStart('here is the weather forecast for today');
    });

    it('fires on "what about tomorrow"', () => {
      detector.onUserPartial('what about tomorrow');
      const ev = onBargeIn.mock.calls[0][0];
      expect(ev.kind).toBe('command');
      expect(ev.text).toBe('what about tomorrow');
    });

    it('fires on a full new command mid-TTS', () => {
      detector.onUserPartial('schedule a meeting with alice tomorrow at three');
      const ev = onBargeIn.mock.calls[0][0];
      expect(ev.kind).toBe('command');
    });
  });

  describe('ack backchannel', () => {
    beforeEach(() => {
      detector.onTtsStart('here is the weather forecast for today');
    });

    it('"yeah" is suppressed as ack', () => {
      detector.onUserPartial('yeah');
      expect(onBargeIn).not.toHaveBeenCalled();
      expect(onIgnored).toHaveBeenCalledTimes(1);
      expect(onIgnored.mock.calls[0][0].kind).toBe('ack');
    });

    it('"mm-hmm" is suppressed as ack', () => {
      detector.onUserPartial('mm-hmm');
      expect(onBargeIn).not.toHaveBeenCalled();
    });
  });

  describe('echo suppression', () => {
    beforeEach(() => {
      detector.onTtsStart('here is the weather forecast for today');
    });

    it('user partial that is a subset of TTS is suppressed as echo', () => {
      detector.onUserPartial('weather forecast');
      expect(onBargeIn).not.toHaveBeenCalled();
      expect(onEchoSuppressed).toHaveBeenCalledTimes(1);
    });

    it('"stop" during TTS that does not say stop is not echo (hard barge)', () => {
      detector.onUserPartial('stop');
      expect(onBargeIn).toHaveBeenCalled();
    });
  });

  describe('grace window after TTS ends', () => {
    beforeEach(() => {
      detector.onTtsStart('here is the weather forecast for today');
    });

    it('barge within grace window after TTS end still fires', () => {
      detector.onTtsEnd();
      nowMs += 200; // within default 300ms grace
      detector.onUserPartial('stop');
      expect(onBargeIn).toHaveBeenCalledTimes(1);
    });

    it('past grace window no longer fires', () => {
      detector.onTtsEnd();
      nowMs += 500;
      detector.onUserPartial('stop');
      expect(onBargeIn).not.toHaveBeenCalled();
      expect(onIgnored.mock.calls[0][0].kind).toBe('no-tts');
    });

    it('custom grace window is honored', () => {
      const d = createBargeDetector({
        now: () => nowMs,
        onBargeIn,
        graceAfterTtsMs: 50,
      });
      d.onTtsStart('ok');
      d.onTtsEnd();
      nowMs += 100;
      d.onUserPartial('stop');
      expect(onBargeIn).not.toHaveBeenCalled();
    });
  });

  describe('cooldown', () => {
    beforeEach(() => {
      detector.onTtsStart('playing some music for you');
    });

    it('a second barge within cooldown is ignored', () => {
      detector.onUserPartial('stop');
      expect(onBargeIn).toHaveBeenCalledTimes(1);

      nowMs += 100; // within default 500ms cooldown
      detector.onUserPartial('what about jazz');
      expect(onBargeIn).toHaveBeenCalledTimes(1);
      const lastIgnored = onIgnored.mock.calls.at(-1)[0];
      expect(lastIgnored.kind).toBe('cooldown');
    });

    it('a second barge past cooldown fires', () => {
      detector.onUserPartial('stop');
      nowMs += 600; // past default 500ms cooldown
      detector.onUserPartial('what about jazz');
      expect(onBargeIn).toHaveBeenCalledTimes(2);
    });

    it('custom cooldownMs is honored', () => {
      const d = createBargeDetector({
        now: () => nowMs,
        onBargeIn,
        onIgnored,
        cooldownMs: 100,
      });
      d.onTtsStart('music');
      d.onUserPartial('stop');
      nowMs += 150;
      d.onUserPartial('play jazz');
      expect(onBargeIn).toHaveBeenCalledTimes(2);
    });
  });

  describe('callback safety', () => {
    it('throwing callback does not corrupt detector state', () => {
      const badCb = vi.fn(() => {
        throw new Error('bad cb');
      });
      const d = createBargeDetector({ now: () => nowMs, onBargeIn: badCb });
      d.onTtsStart('music');
      d.onUserPartial('stop');
      expect(badCb).toHaveBeenCalled();
      expect(d.getState().totalBarges).toBe(1);
    });
  });

  describe('reset', () => {
    it('wipes all state', () => {
      detector.onTtsStart('music');
      detector.onUserPartial('stop');
      detector.reset();
      const s = detector.getState();
      expect(s.ttsPlaying).toBe(false);
      expect(s.ttsText).toBe('');
      expect(s.ttsEndedAt).toBeNull();
      expect(s.lastBargeAt).toBeNull();
      expect(s.totalBarges).toBe(0);
    });
  });

  describe('onTtsUpdate', () => {
    it('updates the current TTS text mid-playback', () => {
      detector.onTtsStart('playing music');
      detector.onTtsUpdate('playing music and the weather is sunny');
      expect(detector.getState().ttsText).toContain('weather');
    });
  });

  describe('empty / defensive inputs', () => {
    it('empty user partial is a no-op', () => {
      detector.onTtsStart('music');
      detector.onUserPartial('');
      detector.onUserPartial(null);
      expect(onBargeIn).not.toHaveBeenCalled();
      expect(onIgnored).not.toHaveBeenCalled();
      expect(onEchoSuppressed).not.toHaveBeenCalled();
    });
  });
});
