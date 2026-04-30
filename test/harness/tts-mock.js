/**
 * TTS Mock - captures speak/cancel calls for naturalness scenario tests.
 *
 * Matches the public surface of voice-speaker.js's VoiceSpeaker:
 *   - speak(text, options) -> Promise<boolean>
 *   - cancel()              -> Promise<void>
 *   - cancelCurrent()       -> Promise<void>
 *
 * A mock test clock drives "spoken duration" deterministically so tests
 * can assert things like "TTS was interrupted 200ms in" without any
 * real audio playback. The clock is in simulated-milliseconds since
 * `reset()` -- callers advance it via `advance(ms)` or `playthrough()`.
 *
 * The mock never imports Electron, OpenAI, or any heavy dependency,
 * so scenario tests stay fast and hermetic.
 *
 * Example:
 *   const tts = new TTSMock();
 *   await tts.speak('got it, setting a timer');
 *   tts.advance(300);            // 300 simulated ms pass
 *   await tts.cancel();          // user barges in
 *   expect(tts.events[0].cancelled).toBe(true);
 *   expect(tts.events[0].playedMs).toBe(300);
 */

'use strict';

// Default words-per-minute for simulated TTS duration. OpenAI TTS at
// normal rate is around 150 wpm; rounded up because most of our
// acknowledgments are short, punchy phrases.
const DEFAULT_WPM = 170;

class TTSMock {
  constructor(options = {}) {
    this._wpm = options.wpm || DEFAULT_WPM;
    this.events = [];
    this._current = null;
    this._clockMs = 0;
  }

  /**
   * Drop all captured events and reset the simulated clock.
   */
  reset() {
    this.events = [];
    this._current = null;
    this._clockMs = 0;
  }

  /**
   * Advance the simulated clock. Auto-completes any currently playing
   * utterance whose duration is now past.
   * @param {number} ms
   */
  advance(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this._clockMs += ms;
    if (this._current && this._clockMs >= this._current.endsAt) {
      this._current.endedAt = this._current.endsAt;
      this._current.playedMs = this._current.endsAt - this._current.startedAt;
      this._current.completed = true;
      this._current = null;
    }
  }

  /**
   * Fast-forward through the currently playing utterance if any.
   */
  playthrough() {
    if (this._current) {
      const remaining = this._current.endsAt - this._clockMs;
      if (remaining > 0) this.advance(remaining);
    }
  }

  /**
   * Simulated current time, in ms since reset.
   * @returns {number}
   */
  now() {
    return this._clockMs;
  }

  /**
   * True while a speak() call has an unfinished / uncancelled utterance.
   * Mirrors VoiceSpeaker.isSpeaking.
   * @returns {boolean}
   */
  get isSpeaking() {
    return Boolean(this._current);
  }

  /**
   * Mirror of VoiceSpeaker.speak. Queues implicitly serialized -- if
   * a new speak() arrives while one is playing, the previous event is
   * marked preempted and the new one starts immediately. Tests that
   * want strict queueing can advance the clock between calls.
   *
   * @param {string} text
   * @param {Object} [options] - { voice, priority }
   * @returns {Promise<boolean>}
   */
  async speak(text, options = {}) {
    if (typeof text !== 'string') text = String(text ?? '');

    if (this._current) {
      // Implicit preemption -- previous speech replaced by this one.
      this._current.endedAt = this._clockMs;
      this._current.playedMs = this._clockMs - this._current.startedAt;
      this._current.preempted = true;
      this._current = null;
    }

    const durationMs = this._estimateDurationMs(text);
    const event = {
      id: this.events.length + 1,
      text,
      voice: options.voice || 'alloy',
      priority: options.priority ?? null,
      startedAt: this._clockMs,
      endsAt: this._clockMs + durationMs,
      durationMs,
      endedAt: null,
      playedMs: null,
      cancelled: false,
      preempted: false,
      completed: false,
    };
    this.events.push(event);
    this._current = event;
    return true;
  }

  /**
   * Mirror of VoiceSpeaker.cancel -- cancels current + clears queue.
   * In the mock there is no separate queue, so this is equivalent to
   * cancelCurrent().
   */
  async cancel() {
    await this.cancelCurrent();
  }

  /**
   * Mirror of VoiceSpeaker.cancelCurrent.
   */
  async cancelCurrent() {
    if (this._current) {
      this._current.endedAt = this._clockMs;
      this._current.playedMs = this._clockMs - this._current.startedAt;
      this._current.cancelled = true;
      this._current = null;
    }
  }

  /**
   * Convenience: array of texts in the order they were spoken.
   * @returns {string[]}
   */
  get spokenTexts() {
    return this.events.map((e) => e.text);
  }

  /**
   * Convenience: true if any spoken event text contains the needle.
   * @param {string} needle
   * @returns {boolean}
   */
  hasSpokenContaining(needle) {
    if (!needle) return false;
    return this.events.some((e) => e.text.includes(needle));
  }

  /**
   * Simulated duration for a piece of text at the configured WPM.
   * Always returns at least 150ms so zero-word texts still have a
   * finite window for "was TTS playing?" checks.
   * @param {string} text
   * @returns {number}
   */
  _estimateDurationMs(text) {
    const words = text.trim().split(/\s+/).filter(Boolean).length || 1;
    const ms = (words / this._wpm) * 60 * 1000;
    return Math.max(150, Math.round(ms));
  }
}

module.exports = { TTSMock, DEFAULT_WPM };
