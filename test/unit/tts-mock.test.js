/**
 * TTS Mock - Unit Tests
 *
 * Exercises the capture / clock / cancellation semantics that
 * naturalness scenarios rely on.
 *
 * Run:  npx vitest run test/unit/tts-mock.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';

const { TTSMock } = require('../harness/tts-mock');

describe('TTSMock', () => {
  let tts;

  beforeEach(() => {
    tts = new TTSMock({ wpm: 120 }); // 1 word = 500ms at 120 wpm
  });

  it('captures speak() calls with text and voice', async () => {
    await tts.speak('got it', { voice: 'coral' });
    expect(tts.events).toHaveLength(1);
    expect(tts.events[0].text).toBe('got it');
    expect(tts.events[0].voice).toBe('coral');
  });

  it('tracks isSpeaking during a playing utterance', async () => {
    expect(tts.isSpeaking).toBe(false);
    await tts.speak('hello world');
    expect(tts.isSpeaking).toBe(true);
  });

  it('auto-completes after advance() past duration', async () => {
    await tts.speak('got it'); // 2 words @ 120wpm = 1000ms
    tts.advance(500);
    expect(tts.isSpeaking).toBe(true);
    tts.advance(600);
    expect(tts.isSpeaking).toBe(false);
    expect(tts.events[0].completed).toBe(true);
    expect(tts.events[0].cancelled).toBe(false);
  });

  it('playthrough() fast-forwards the current utterance', async () => {
    await tts.speak('the quick brown fox');
    expect(tts.isSpeaking).toBe(true);
    tts.playthrough();
    expect(tts.isSpeaking).toBe(false);
    expect(tts.events[0].completed).toBe(true);
  });

  it('cancel() marks the current event as cancelled with partial playedMs', async () => {
    await tts.speak('hello world and goodbye'); // 4 words = 2000ms
    tts.advance(400);
    await tts.cancel();
    expect(tts.events[0].cancelled).toBe(true);
    expect(tts.events[0].playedMs).toBe(400);
    expect(tts.isSpeaking).toBe(false);
  });

  it('speak() while one is playing marks the previous as preempted', async () => {
    await tts.speak('starting a long sentence that will be cut short');
    tts.advance(250);
    await tts.speak('new thing');
    expect(tts.events).toHaveLength(2);
    expect(tts.events[0].preempted).toBe(true);
    expect(tts.events[0].playedMs).toBe(250);
    expect(tts.events[1].startedAt).toBe(250);
  });

  it('hasSpokenContaining finds substrings', async () => {
    await tts.speak('got it, setting a timer');
    expect(tts.hasSpokenContaining('timer')).toBe(true);
    expect(tts.hasSpokenContaining('calendar')).toBe(false);
  });

  it('spokenTexts returns utterances in order', async () => {
    await tts.speak('one');
    tts.playthrough();
    await tts.speak('two');
    tts.playthrough();
    expect(tts.spokenTexts).toEqual(['one', 'two']);
  });

  it('reset() clears events and resets the clock', async () => {
    await tts.speak('something');
    tts.advance(100);
    tts.reset();
    expect(tts.events).toEqual([]);
    expect(tts.now()).toBe(0);
    expect(tts.isSpeaking).toBe(false);
  });

  it('empty text still produces a finite minimum duration', async () => {
    await tts.speak('');
    expect(tts.events[0].durationMs).toBeGreaterThanOrEqual(150);
  });

  it('non-string input is coerced', async () => {
    await tts.speak(null);
    await tts.speak(undefined);
    await tts.speak(42);
    expect(tts.events.map((e) => e.text)).toEqual(['', '', '42']);
  });

  it('negative advance is a no-op', async () => {
    await tts.speak('hi');
    const before = tts.now();
    tts.advance(-100);
    expect(tts.now()).toBe(before);
  });
});
