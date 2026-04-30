/**
 * Shared Barge Detector Singleton - Unit Tests
 *
 * Exercises the wiring: onBargeIn cancels the injected speaker, and
 * for 'command' kind, submits via the injected submitTask. Tests use
 * configureBargeDetector + resetSharedBargeDetector to isolate each
 * case and avoid leaking state between tests.
 *
 * Run:  npx vitest run test/unit/barge-detector-singleton.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  getSharedBargeDetector,
  configureBargeDetector,
  resetSharedBargeDetector,
} = require('../../lib/naturalness/barge-detector-singleton');

describe('barge-detector-singleton', () => {
  let speaker;
  let submitTask;
  let log;

  beforeEach(() => {
    resetSharedBargeDetector();
    speaker = { cancel: vi.fn().mockResolvedValue(true) };
    submitTask = vi.fn().mockResolvedValue({ queued: true });
    log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    configureBargeDetector({ speaker, submitTask, log });
  });

  describe('singleton behavior', () => {
    it('returns the same instance across calls', () => {
      const a = getSharedBargeDetector();
      const b = getSharedBargeDetector();
      expect(a).toBe(b);
    });

    it('reset + reconfigure creates a fresh instance', () => {
      const a = getSharedBargeDetector();
      resetSharedBargeDetector();
      configureBargeDetector({ speaker, submitTask, log });
      const b = getSharedBargeDetector();
      expect(a).not.toBe(b);
    });
  });

  describe('stop barge', () => {
    it('cancels the speaker and does not submit a task', async () => {
      const d = getSharedBargeDetector();
      d.onTtsStart('here is the weather forecast for today');
      d.onUserPartial('stop');

      // Let the async onBargeIn settle.
      await new Promise((r) => setImmediate(r));

      expect(speaker.cancel).toHaveBeenCalledTimes(1);
      expect(submitTask).not.toHaveBeenCalled();
    });
  });

  describe('command barge', () => {
    it('cancels the speaker AND submits the text as a new task', async () => {
      const d = getSharedBargeDetector();
      d.onTtsStart('here is the weather forecast for today');
      d.onUserPartial('what about tomorrow');

      await new Promise((r) => setImmediate(r));

      expect(speaker.cancel).toHaveBeenCalledTimes(1);
      expect(submitTask).toHaveBeenCalledTimes(1);

      const [text, opts] = submitTask.mock.calls[0];
      expect(text).toBe('what about tomorrow');
      expect(opts.toolId).toBe('voice');
      expect(opts.metadata.barged).toBe(true);
      expect(opts.metadata.bargeReason).toBeTruthy();
    });
  });

  describe('ack during TTS', () => {
    it('does not cancel the speaker for short affirmations', async () => {
      const d = getSharedBargeDetector();
      d.onTtsStart('playing some jazz for you now');
      d.onUserPartial('yeah');

      await new Promise((r) => setImmediate(r));

      expect(speaker.cancel).not.toHaveBeenCalled();
      expect(submitTask).not.toHaveBeenCalled();
    });
  });

  describe('echo during TTS', () => {
    it('does not cancel when mic caught TTS content', async () => {
      const d = getSharedBargeDetector();
      d.onTtsStart('here is the weather forecast for today and tomorrow');
      d.onUserPartial('weather forecast');

      await new Promise((r) => setImmediate(r));

      expect(speaker.cancel).not.toHaveBeenCalled();
      expect(submitTask).not.toHaveBeenCalled();
    });
  });

  describe('no TTS active', () => {
    it('user partial is ignored entirely; no cancel, no submit', async () => {
      const d = getSharedBargeDetector();
      d.onUserPartial('stop');

      await new Promise((r) => setImmediate(r));

      expect(speaker.cancel).not.toHaveBeenCalled();
      expect(submitTask).not.toHaveBeenCalled();
    });
  });

  describe('fault tolerance', () => {
    it('speaker.cancel throwing does not block submitTask on command barge', async () => {
      speaker.cancel = vi.fn().mockRejectedValue(new Error('audio device busy'));
      const d = getSharedBargeDetector();
      d.onTtsStart('playing music for you now');
      d.onUserPartial('what about tomorrow');

      await new Promise((r) => setImmediate(r));

      expect(speaker.cancel).toHaveBeenCalled();
      expect(submitTask).toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalled();
    });

    it('submitTask throwing is logged but does not propagate', async () => {
      submitTask = vi.fn().mockRejectedValue(new Error('task queue down'));
      resetSharedBargeDetector();
      configureBargeDetector({ speaker, submitTask, log });

      const d = getSharedBargeDetector();
      d.onTtsStart('playing music for you now');
      d.onUserPartial('what about tomorrow');

      await new Promise((r) => setImmediate(r));

      expect(submitTask).toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalled();
    });

    it('no speaker and no submitTask configured -> logs but does not throw', async () => {
      resetSharedBargeDetector();
      configureBargeDetector({ log }); // no speaker / no submitTask
      const d = getSharedBargeDetector();
      d.onTtsStart('playing music');
      d.onUserPartial('what about tomorrow');

      await new Promise((r) => setImmediate(r));

      // Just assert nothing crashed; the test completing is the win.
      expect(log.info).toHaveBeenCalled();
    });
  });

  describe('TTS lifecycle propagation', () => {
    it('onTtsEnd makes subsequent user partials past the grace window no-ops', async () => {
      const d = getSharedBargeDetector();
      d.onTtsStart('playing music for you now');
      d.onTtsEnd();

      // Burn through the 300ms grace window using the detector's built-in clock.
      await new Promise((r) => setTimeout(r, 350));

      d.onUserPartial('what about tomorrow');
      await new Promise((r) => setImmediate(r));

      expect(speaker.cancel).not.toHaveBeenCalled();
      expect(submitTask).not.toHaveBeenCalled();
    });
  });
});
