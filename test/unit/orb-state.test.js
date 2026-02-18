/**
 * OrbState v2 Unit Tests
 *
 * Tests the state machine (lib/orb/orb-state.js) covering:
 *   - Valid transitions between 6 phases
 *   - Invalid transitions rejected
 *   - canAcceptInput() per phase
 *   - startSession() and endSession()
 *   - Built-in timeouts (connect, processing, await, session)
 *   - Derived getters
 *   - Event emission
 *
 * Run: npx vitest run test/unit/orb-state.test.js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Simulate browser environment for window global
const _window = {};

// Load the module by evaluating it in a context with window
function loadOrbState() {
  // Reset
  delete _window.OrbState;

  const fs = require('fs');
  const path = require('path');
  const code = fs.readFileSync(path.join(__dirname, '../../lib/orb/orb-state.js'), 'utf8');

  // Execute in a function scope with window set to our mock
  const fn = new Function('window', 'console', 'setTimeout', 'clearTimeout', code);
  fn(_window, console, setTimeout, clearTimeout);

  return _window.OrbState;
}

describe('OrbState v2', () => {
  let S;

  beforeEach(() => {
    vi.useFakeTimers();
    S = loadOrbState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==================== Phase Transitions ====================

  describe('valid transitions', () => {
    it('idle -> connecting', () => {
      expect(S.phase).toBe('idle');
      expect(S.transition('connecting', 'test')).toBe(true);
      expect(S.phase).toBe('connecting');
    });

    it('connecting -> listening', () => {
      S.transition('connecting');
      expect(S.transition('listening', 'session-ready')).toBe(true);
      expect(S.phase).toBe('listening');
    });

    it('connecting -> idle (error)', () => {
      S.transition('connecting');
      expect(S.transition('idle', 'error')).toBe(true);
      expect(S.phase).toBe('idle');
    });

    it('listening -> processing', () => {
      S.transition('connecting');
      S.transition('listening');
      expect(S.transition('processing', 'transcript')).toBe(true);
      expect(S.phase).toBe('processing');
    });

    it('listening -> idle (silence)', () => {
      S.transition('connecting');
      S.transition('listening');
      expect(S.transition('idle', 'silence')).toBe(true);
      expect(S.phase).toBe('idle');
    });

    it('processing -> speaking', () => {
      S.transition('connecting');
      S.transition('listening');
      S.transition('processing');
      expect(S.transition('speaking', 'tts')).toBe(true);
      expect(S.phase).toBe('speaking');
    });

    it('processing -> idle (error)', () => {
      S.transition('connecting');
      S.transition('listening');
      S.transition('processing');
      expect(S.transition('idle', 'error')).toBe(true);
    });

    it('speaking -> idle (complete)', () => {
      S.transition('connecting');
      S.transition('listening');
      S.transition('processing');
      S.transition('speaking');
      expect(S.transition('idle', 'tts-complete')).toBe(true);
      expect(S.phase).toBe('idle');
    });

    it('speaking -> listening (barge-in)', () => {
      S.transition('connecting');
      S.transition('listening');
      S.transition('processing');
      S.transition('speaking');
      expect(S.transition('listening', 'barge-in')).toBe(true);
      expect(S.phase).toBe('listening');
    });

    it('speaking -> awaitingInput (follow-up)', () => {
      S.transition('connecting');
      S.transition('listening');
      S.transition('processing');
      S.transition('speaking');
      expect(S.transition('awaitingInput', 'needs-input')).toBe(true);
      expect(S.phase).toBe('awaitingInput');
    });

    it('awaitingInput -> listening (follow-up answer)', () => {
      S.transition('connecting');
      S.transition('listening');
      S.transition('processing');
      S.transition('speaking');
      S.transition('awaitingInput');
      expect(S.transition('listening', 'followup')).toBe(true);
      expect(S.phase).toBe('listening');
    });

    it('awaitingInput -> idle (timeout)', () => {
      S.transition('connecting');
      S.transition('listening');
      S.transition('processing');
      S.transition('speaking');
      S.transition('awaitingInput');
      expect(S.transition('idle', 'timeout')).toBe(true);
    });

    it('same phase transition is a no-op (returns true)', () => {
      expect(S.transition('idle')).toBe(true);
      expect(S.phase).toBe('idle');
    });
  });

  describe('invalid transitions', () => {
    it('idle -> speaking', () => {
      expect(S.transition('speaking')).toBe(false);
      expect(S.phase).toBe('idle');
    });

    it('idle -> listening', () => {
      expect(S.transition('listening')).toBe(false);
      expect(S.phase).toBe('idle');
    });

    it('idle -> processing', () => {
      expect(S.transition('processing')).toBe(false);
      expect(S.phase).toBe('idle');
    });

    it('listening -> awaitingInput', () => {
      S.transition('connecting');
      S.transition('listening');
      expect(S.transition('awaitingInput')).toBe(false);
      expect(S.phase).toBe('listening');
    });

    it('speaking -> connecting', () => {
      S.transition('connecting');
      S.transition('listening');
      S.transition('processing');
      S.transition('speaking');
      expect(S.transition('connecting')).toBe(false);
      expect(S.phase).toBe('speaking');
    });

    it('connecting -> speaking', () => {
      S.transition('connecting');
      expect(S.transition('speaking')).toBe(false);
    });
  });

  // ==================== canAcceptInput ====================

  describe('canAcceptInput()', () => {
    it('true when listening', () => {
      S.transition('connecting');
      S.transition('listening');
      expect(S.canAcceptInput()).toBe(true);
    });

    it('true when connecting', () => {
      S.transition('connecting');
      expect(S.canAcceptInput()).toBe(true);
    });

    it('false when idle', () => {
      expect(S.canAcceptInput()).toBe(false);
    });

    it('false when processing', () => {
      S.transition('connecting');
      S.transition('listening');
      S.transition('processing');
      expect(S.canAcceptInput()).toBe(false);
    });

    it('false when speaking', () => {
      S.transition('connecting');
      S.transition('listening');
      S.transition('processing');
      S.transition('speaking');
      expect(S.canAcceptInput()).toBe(false);
    });

    it('false when awaitingInput', () => {
      S.transition('connecting');
      S.transition('listening');
      S.transition('processing');
      S.transition('speaking');
      S.transition('awaitingInput');
      expect(S.canAcceptInput()).toBe(false);
    });
  });

  // ==================== startSession / endSession ====================

  describe('startSession()', () => {
    it('transitions from idle to connecting', () => {
      expect(S.startSession()).toBe(true);
      expect(S.phase).toBe('connecting');
    });

    it('generates a session ID', () => {
      S.startSession();
      expect(S.sessionId).toBeTruthy();
      expect(typeof S.sessionId).toBe('string');
    });

    it('resets dedup state', () => {
      S.set('lastProcessedTranscript', 'old');
      S.set('lastProcessedTime', 12345);
      S.startSession();
      expect(S.get('lastProcessedTranscript')).toBe('');
      expect(S.get('lastProcessedTime')).toBe(0);
    });

    it('returns false if not idle', () => {
      S.startSession();
      expect(S.startSession()).toBe(false); // Already connecting
    });
  });

  describe('endSession()', () => {
    it('force-transitions to idle from connecting', () => {
      S.startSession();
      S.endSession('test');
      expect(S.phase).toBe('idle');
    });

    it('force-transitions to idle from listening', () => {
      S.startSession();
      S.transition('listening');
      S.endSession('test');
      expect(S.phase).toBe('idle');
    });

    it('force-transitions to idle from processing', () => {
      S.startSession();
      S.transition('listening');
      S.transition('processing');
      S.endSession('test');
      expect(S.phase).toBe('idle');
    });

    it('force-transitions to idle from speaking', () => {
      S.startSession();
      S.transition('listening');
      S.transition('processing');
      S.transition('speaking');
      S.endSession('test');
      expect(S.phase).toBe('idle');
    });

    it('force-transitions to idle from awaitingInput', () => {
      S.startSession();
      S.transition('listening');
      S.transition('processing');
      S.transition('speaking');
      S.transition('awaitingInput');
      S.endSession('test');
      expect(S.phase).toBe('idle');
    });

    it('resets session state', () => {
      S.startSession();
      S.set('isSessionReady', true);
      S.set('pendingFunctionCallId', 'abc');
      S.set('pendingSubmitCount', 3);
      S.endSession('test');
      expect(S.get('isSessionReady')).toBe(false);
      expect(S.get('pendingFunctionCallId')).toBeNull();
      expect(S.get('pendingSubmitCount')).toBe(0);
    });

    it('no-ops if already idle', () => {
      const handler = vi.fn();
      S.on('transition', handler);
      S.endSession('test');
      expect(handler).not.toHaveBeenCalled();
    });

    it('emits transition event with reason', () => {
      S.startSession();
      const handler = vi.fn();
      S.on('transition', handler);
      S.endSession('user-stop');
      expect(handler).toHaveBeenCalledWith({
        from: 'connecting',
        to: 'idle',
        reason: 'user-stop',
      });
    });
  });

  // ==================== Timeouts ====================

  describe('built-in timeouts', () => {
    it('connect timeout fires after 10s', () => {
      S.startSession(); // connecting
      expect(S.phase).toBe('connecting');
      vi.advanceTimersByTime(10000);
      expect(S.phase).toBe('idle'); // timed out
    });

    it('processing timeout fires after 30s', () => {
      S.startSession();
      S.transition('listening');
      S.transition('processing');
      expect(S.phase).toBe('processing');
      vi.advanceTimersByTime(30000);
      expect(S.phase).toBe('idle'); // timed out
    });

    it('await timeout fires after 30s', () => {
      S.startSession();
      S.transition('listening');
      S.transition('processing');
      S.transition('speaking');
      S.transition('awaitingInput');
      expect(S.phase).toBe('awaitingInput');
      vi.advanceTimersByTime(30000);
      expect(S.phase).toBe('idle'); // timed out
    });

    it('session timeout fires after 60s of inactivity', () => {
      S.startSession();
      S.transition('listening');
      // Stay in listening for 60s with no transitions
      vi.advanceTimersByTime(60000);
      expect(S.phase).toBe('idle'); // session timed out
    });

    it('session timeout resets on each transition', () => {
      S.startSession(); // connecting, starts 10s connect + 60s session timeouts
      vi.advanceTimersByTime(5000); // 5s (before 10s connect timeout)
      S.transition('listening'); // resets 60s session timer, clears connect timeout
      vi.advanceTimersByTime(50000); // 50s since listening (total 55s)
      expect(S.phase).toBe('listening'); // not timed out (60s hasn't passed since listening)
      vi.advanceTimersByTime(15000); // another 15s (65s since listening transition)
      expect(S.phase).toBe('idle'); // NOW session-timed out
    });

    it('all timeouts cleared when entering idle', () => {
      S.startSession(); // starts connect + session timeouts
      S.transition('idle', 'manual');
      vi.advanceTimersByTime(100000); // way past all timeouts
      expect(S.phase).toBe('idle'); // stayed idle, no timeout fired
    });

    it('connect timeout does not fire if transitioned to listening in time', () => {
      S.startSession();
      vi.advanceTimersByTime(5000); // 5s
      S.transition('listening'); // clears connect timeout
      vi.advanceTimersByTime(10000); // well past 10s total
      expect(S.phase).toBe('listening'); // connect timeout did not fire
    });
  });

  // ==================== Derived Getters ====================

  describe('derived getters', () => {
    it('isListening reflects phase', () => {
      expect(S.isListening).toBe(false);
      S.startSession();
      S.transition('listening');
      expect(S.isListening).toBe(true);
    });

    it('isConnected is true for all non-idle phases', () => {
      expect(S.isConnected).toBe(false);
      S.startSession();
      expect(S.isConnected).toBe(true);
      S.transition('listening');
      expect(S.isConnected).toBe(true);
    });

    it('isSpeaking reflects phase', () => {
      expect(S.isSpeaking).toBe(false);
      S.startSession();
      S.transition('listening');
      S.transition('processing');
      S.transition('speaking');
      expect(S.isSpeaking).toBe(true);
    });

    it('isAwaitingInput reflects phase', () => {
      expect(S.isAwaitingInput).toBe(false);
      S.startSession();
      S.transition('listening');
      S.transition('processing');
      S.transition('speaking');
      S.transition('awaitingInput');
      expect(S.isAwaitingInput).toBe(true);
    });
  });

  // ==================== Event Emission ====================

  describe('event emission', () => {
    it('emits transition event with from/to/reason', () => {
      const handler = vi.fn();
      S.on('transition', handler);
      S.transition('connecting', 'user-click');
      expect(handler).toHaveBeenCalledWith({
        from: 'idle',
        to: 'connecting',
        reason: 'user-click',
      });
    });

    it('emits change event on set()', () => {
      const handler = vi.fn();
      S.on('change', handler);
      S.set('isSessionReady', true);
      expect(handler).toHaveBeenCalledWith({
        key: 'isSessionReady',
        old: false,
        value: true,
      });
    });

    it('does not emit transition for same-phase no-op', () => {
      const handler = vi.fn();
      S.on('transition', handler);
      S.transition('idle'); // same phase
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not emit transition for invalid transition', () => {
      const handler = vi.fn();
      S.on('transition', handler);
      S.transition('speaking'); // invalid from idle
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ==================== State Accessors ====================

  describe('state accessors', () => {
    it('get/set work for non-phase state', () => {
      S.set('isSessionReady', true);
      expect(S.get('isSessionReady')).toBe(true);
    });

    it('set rejects phase changes', () => {
      S.set('phase', 'listening');
      expect(S.phase).toBe('idle'); // unchanged
    });

    it('update batch-sets multiple values', () => {
      S.update({ isSessionReady: true, ttsEndTime: 12345 });
      expect(S.get('isSessionReady')).toBe(true);
      expect(S.get('ttsEndTime')).toBe(12345);
    });

    it('snapshot returns all state', () => {
      const snap = S.snapshot();
      expect(snap.phase).toBe('idle');
      expect(snap).toHaveProperty('sessionId');
      expect(snap).toHaveProperty('_connectTimeoutActive');
    });

    it('reset calls endSession', () => {
      S.startSession();
      S.reset();
      expect(S.phase).toBe('idle');
    });
  });

  // ==================== ttsEndTime tracking ====================

  describe('ttsEndTime on leaving speaking', () => {
    it('sets ttsEndTime when transitioning from speaking to idle', () => {
      S.startSession();
      S.transition('listening');
      S.transition('processing');
      S.transition('speaking');
      S.set('ttsEndTime', 0);
      const before = Date.now();
      S.transition('idle', 'tts-complete');
      expect(S.get('ttsEndTime')).toBeGreaterThanOrEqual(before);
    });
  });
});
