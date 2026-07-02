/**
 * Orb voice-turn contract — cross-module invariants
 *
 * Locks in the three fixes that closed the "daily brief did nothing" class of
 * silent failures, by composing the REAL orb-state machine with the REAL event
 * router (not mocks) and asserting the contract between them. If any of these
 * regress, a spoken request or its answer silently vanishes again.
 *
 *   1. A committed request (function_call_transcript) reaches its handler even
 *      when the orb is speaking or idle — never phase-dropped. (router de-gate)
 *   2. A normal, non-committed input (transcript) is STILL phase-gated — the
 *      de-gate is narrow, not a hole. (guards against over-de-gating)
 *   3. An async agent result / proactive audio (audio_wav, OUTPUT) reaches its
 *      handler regardless of phase. (two-channel TTS: voice-speaker path)
 *   4. The state machine permits idle -> speaking so that async result can
 *      actually play after the orb has returned to idle. (result playback)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Load the real orb-state + orb-event-router into a shared fake `window`, so
// the router drives the actual state machine (not a mock).
function loadOrb() {
  const win = {};
  for (const rel of ['../../lib/orb/orb-state.js', '../../lib/orb/orb-event-router.js']) {
    const code = readFileSync(resolve(__dirname, rel), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function('window', 'console', code)(win, console);
  }
  return win;
}

describe('orb voice-turn contract (real orb-state + real router)', () => {
  let win;
  let S;
  let captured;
  let orbAPI;

  beforeEach(() => {
    win = loadOrb();
    S = win.OrbState;
    captured = null;
    orbAPI = { onEvent: (cb) => { captured = cb; } };
  });

  function startRouter(handlers) {
    win.OrbEventRouter.start(orbAPI, handlers, {});
    return captured;
  }

  it('4. state machine allows idle -> speaking (async result playback)', () => {
    expect(S.phase).toBe('idle');
    expect(S.transition('speaking', 'audio_wav:taskResult:daily-brief-agent')).toBe(true);
    expect(S.phase).toBe('speaking');
  });

  it('1. committed request (function_call_transcript) is delivered while SPEAKING', () => {
    const handler = vi.fn();
    const emit = startRouter({ function_call_transcript: handler });
    S.transition('speaking', 'setup'); // idle -> speaking (now allowed)
    expect(S.phase).toBe('speaking');
    expect(S.canAcceptInput()).toBe(false); // phase would normally gate input
    emit({ type: 'function_call_transcript', transcript: 'give me the daily brief', callId: 'c1' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('1b. committed request is delivered while IDLE', () => {
    const handler = vi.fn();
    const emit = startRouter({ function_call_transcript: handler });
    expect(S.phase).toBe('idle');
    expect(S.canAcceptInput()).toBe(false);
    emit({ type: 'function_call_transcript', transcript: 'daily brief', callId: 'c2' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('2. a NON-committed input (transcript) is still phase-gated while speaking', () => {
    const handler = vi.fn();
    const emit = startRouter({ transcript: handler });
    S.transition('speaking', 'setup');
    expect(S.canAcceptInput()).toBe(false);
    emit({ type: 'transcript', text: 'some stray words' });
    expect(handler).not.toHaveBeenCalled(); // de-gate is narrow, not a hole
  });

  it('3. async result audio (audio_wav) is delivered regardless of phase', () => {
    const handler = vi.fn();
    const emit = startRouter({ audio_wav: handler });
    // idle
    emit({ type: 'audio_wav', taskResult: true });
    // speaking
    S.transition('speaking', 'setup');
    emit({ type: 'audio_wav', taskResult: true });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
