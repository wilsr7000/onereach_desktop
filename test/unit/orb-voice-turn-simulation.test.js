/**
 * Orb voice-turn simulation — end-to-end turn harness
 *
 * Composes the THREE real renderer modules that decide a voice turn — the state
 * machine (orb-state), the event router (orb-event-router), and the turn-response
 * classifier (orb-turn-response) — and walks complete turns of each shape. This
 * is the harness that was impossible before the turn-response extraction: the
 * decision logic now lives in a pure module, so a full turn (request in →
 * decision → action → result playback) can be simulated without the unloadable
 * orb.html handler.
 *
 * Each scenario asserts the exact sequence a healthy turn must follow, so a
 * regression in ANY of the three modules (or their contract) fails here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadOrb() {
  const win = {};
  for (const rel of [
    '../../lib/orb/orb-state.js',
    '../../lib/orb/orb-event-router.js',
    '../../lib/orb/orb-turn-response.js',
  ]) {
    const code = readFileSync(resolve(__dirname, rel), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function('window', 'console', code)(win, console);
  }
  return win;
}

describe('orb voice-turn simulation (state + router + turn-response)', () => {
  let win, S, TR, captured, orbAPI;

  beforeEach(() => {
    win = loadOrb();
    S = win.OrbState;
    TR = win.OrbTurnResponse;
    captured = null;
    orbAPI = { onEvent: (cb) => { captured = cb; } };
  });

  function startRouter(handlers) {
    win.OrbEventRouter.start(orbAPI, handlers, {});
    return captured;
  }

  it('daily-brief turn: committed request delivered while speaking → silent-ack → async result plays from idle', () => {
    const fcHandler = vi.fn();
    const emit = startRouter({ function_call_transcript: fcHandler, audio_wav: vi.fn() });

    // Orb is speaking a short ack when the tool call lands.
    S.transition('speaking', 'setup');
    emit({ type: 'function_call_transcript', transcript: 'give me the daily brief', callId: 'c1' });
    expect(fcHandler).toHaveBeenCalledTimes(1); // never phase-dropped

    // The exchange returns the daily-brief shape: queued + suppress.
    const desc = TR.classifyTurnResponse({ queued: true, suppressAIResponse: true, message: 'Processing…' });
    expect(desc.action).toBe('silent-ack');

    // Later the async result comes back via voice-speaker while the orb is idle.
    S.transition('idle', 'audio-done');
    expect(S.transition('speaking', 'audio_wav:taskResult:daily-brief-agent')).toBe(true);
  });

  it('needs-input turn: classifier → needs-input, awaitInput set, processing → speaking permitted', () => {
    const desc = TR.classifyTurnResponse({ needsInput: true, message: 'Which calendar?' });
    expect(desc).toMatchObject({ action: 'needs-input', ackText: 'Which calendar?', awaitInput: true });
    // The handler transitions processing -> speaking to voice the prompt.
    S.transition('connecting', 'x'); S.transition('listening', 'x'); S.transition('processing', 'x');
    expect(S.transition('speaking', 'tts-followup')).toBe(true);
  });

  it('standard spoken turn: route → speak with route.speech precedence', () => {
    const first = TR.classifyTurnResponse({ message: 'The time is 3pm' });
    expect(first.action).toBe('route');
    const routed = TR.classifyRoutedResponse({ message: 'The time is 3pm' }, { mode: 'full', speech: 'It is 3 PM.' });
    expect(routed).toMatchObject({ action: 'speak', ackText: 'It is 3 PM.' });
  });

  it('tone-only turn: route → tone, silent ack, dwell captured', () => {
    const first = TR.classifyTurnResponse({ message: 'done' });
    expect(first.action).toBe('route');
    const routed = TR.classifyRoutedResponse({ message: 'done' }, { mode: 'tone', dwellMs: 4000 });
    expect(routed).toMatchObject({ action: 'tone', ackText: '', dwellMs: 4000 });
  });

  it('non-committed stray transcript is still dropped while speaking (echo guard intact)', () => {
    const tHandler = vi.fn();
    const emit = startRouter({ transcript: tHandler });
    S.transition('speaking', 'setup');
    emit({ type: 'transcript', text: 'the orb speaking to itself' });
    expect(tHandler).not.toHaveBeenCalled();
  });
});
