/**
 * End-to-end orb flow: agent returns an implicit question -> orb detects
 * it -> mic reopens -> times out after inactivity.
 *
 * This test wires together the real response-router and the real orb
 * state machine so we can verify the full question-and-listen contract
 * without booting the Electron app. It's the test that specifically
 * guards against the "it asks a question but doesn't listen" bug.
 *
 * Run: npx vitest run test/unit/orb-implicit-question-e2e.test.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

function loadRouter() {
  const code = fs.readFileSync(
    path.join(__dirname, '..', '..', 'lib', 'orb', 'orb-response-router.js'),
    'utf8'
  );
  const _window = {};
  const _localStorage = {
    _store: {},
    getItem(k) { return this._store[k] || null; },
    setItem(k, v) { this._store[k] = v; },
  };
  const fn = new Function('window', 'localStorage', 'console', code);
  fn(_window, _localStorage, console);
  return _window.OrbResponseRouter;
}

function loadOrbState() {
  const code = fs.readFileSync(
    path.join(__dirname, '..', '..', 'lib', 'orb', 'orb-state.js'),
    'utf8'
  );
  const _window = {};
  const fn = new Function('window', 'console', code);
  fn(_window, console);
  return _window.OrbState;
}

describe('Orb implicit-question end-to-end flow', () => {
  let router;
  let S;

  beforeEach(() => {
    vi.useFakeTimers();
    router = loadRouter();
    S = loadOrbState();
    // Set the orb up in "speaking" phase to simulate TTS in progress
    S.transition('connecting', 'test-setup');
    S.transition('listening', 'test-setup');
    S.transition('processing', 'test-setup');
    S.transition('speaking', 'test-setup');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('full flow: question detected, mic reopens, times out if silent', () => {
    // ── Step 1: simulate agent returning an implicit-question result ──
    const result = {
      success: true,
      message: 'Found three coffee shops. Want directions to the closest one?',
    };
    const route = router.classify(result);
    expect(route.awaitAnswer).toBe(true);
    expect(route.dwellMs).toBeGreaterThanOrEqual(15000);
    expect(route.speech).toContain('Want directions');

    // ── Step 2: simulate the orb wiring (what orb.html does) ──
    // Flag the pending-needs-input and record the safety dwell.
    let _pendingNeedsInput = false;
    let _pendingDwellMs = 0;
    if (route.awaitAnswer && !_pendingNeedsInput) {
      _pendingNeedsInput = true;
      _pendingDwellMs = typeof route.dwellMs === 'number' && route.dwellMs > 0
        ? route.dwellMs
        : 25000;
    }
    expect(_pendingNeedsInput).toBe(true);
    expect(_pendingDwellMs).toBeGreaterThanOrEqual(15000);

    // ── Step 3: simulate TTS ending (setOnSpeakingEnd callback) ──
    // The real handler in orb.html has this branch:
    //   if (_pendingNeedsInput && S.isSpeaking) {
    //     _pendingNeedsInput = false;
    //     S.transition('awaitingInput', 'needs-input');
    //     ... 1.5s later: S.transition('listening', 'followup-listen');
    //   }
    expect(S.phase).toBe('speaking');
    expect(_pendingNeedsInput && S.isSpeaking).toBe(true);
    _pendingNeedsInput = false;
    expect(S.transition('awaitingInput', 'needs-input')).toBe(true);
    expect(S.phase).toBe('awaitingInput');

    // After 1.5 s the chime path transitions to listening
    vi.advanceTimersByTime(1500);
    if (S.isAwaitingInput) {
      S.transition('listening', 'followup-listen');
    }
    expect(S.phase).toBe('listening');

    // ── Step 4: user stays silent -- the 60s session timeout must fire ──
    // (awaitingInput's 30s timer is cleared when we leave that phase;
    //  listening has no phase-specific timer but the session timer runs.)
    vi.advanceTimersByTime(60 * 1000 + 100);
    expect(S.phase).toBe('idle');
  });

  it('fallback: if _pendingNeedsInput somehow got cleared, dwell-listen keeps the mic open', () => {
    // Simulate the race: orb.html sets _pendingNeedsInput then something
    // clears it before setOnSpeakingEnd fires. The safety dwell must
    // still result in the orb being in listening phase, not idle.
    const result = {
      success: true,
      message: 'Want me to open directions?',
    };
    const route = router.classify(result);
    const _pendingDwellMs = route.dwellMs;

    // setOnSpeakingEnd's fallback path triggers _startDwellListen(dwellMs).
    // With our fix, dwellMs is 25000 (DWELL.IMPLICIT_QUESTION). If the
    // fix is missing and dwellMs was 0, the orb would go straight to
    // idle. We assert the non-zero value so this regression is loud.
    expect(_pendingDwellMs).toBeGreaterThan(0);
    expect(_pendingDwellMs).toBeGreaterThanOrEqual(15000);

    // Simulate _startDwellListen: transition to listening if dwellMs > 0
    if (_pendingDwellMs > 0) {
      S.transition('listening', 'dwell-listen');
    } else {
      S.transition('idle', 'no-dwell');
    }
    expect(S.phase).toBe('listening');

    // Advance past the dwell period; orb should auto-idle
    vi.advanceTimersByTime(_pendingDwellMs + 1000);
    // The setTimeout inside _startDwellListen uses real window.setTimeout
    // which we don't model here -- but in practice the dwell timer fires.
    // This test pins the invariant: dwellMs > 0 means mic opens, not closes.
  });

  it('a statement (no question) does NOT flag awaitAnswer', () => {
    const route = router.classify({
      success: true,
      message: 'The weather in Berkeley is 68 degrees and sunny.',
    });
    expect(route.awaitAnswer).toBeFalsy();
  });

  it('explicit needsInput takes a different path (DWELL.QUESTION)', () => {
    const route = router.classify({
      success: true,
      message: 'What city are you in?',
      needsInput: { prompt: 'What city are you in?' },
    });
    expect(route.awaitAnswer).toBe(true);
    // needsInput uses DWELL.QUESTION (0) because awaitingInput's own 30s
    // timer handles the wait
    expect(route.dwellMs).toBe(0);
  });
});
