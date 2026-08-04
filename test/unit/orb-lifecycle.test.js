/**
 * orb-lifecycle -- renderer realtime lifecycle decision helpers
 *
 * Pins the resilience contract between the main-process reconnect logic
 * (voice-listener.js) and the orb renderer's disconnected/reconnected
 * handlers, so a recoverable mid-turn drop never tears down an in-flight
 * turn and a reconnect never yanks a mid-turn orb back to listening.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { classifyDisconnect, shouldResumeListening } = require('../../lib/orb/orb-lifecycle.js');

describe('orb-lifecycle.classifyDisconnect()', () => {
  it('treats a permanent give-up as terminal', () => {
    expect(classifyDisconnect({ code: 1006, permanent: true })).toBe('terminal');
  });

  it('treats a user-initiated normal close (1000) as terminal', () => {
    expect(classifyDisconnect({ code: 1000 })).toBe('terminal');
  });

  it('treats a bare 1005 (no permanent flag) as recoverable', () => {
    // The main process only emits a non-permanent `disconnected` when it is
    // NOT reconnecting, but defensively the renderer must not kill the turn
    // on an ambiguous drop -- the safety timer bounds it.
    expect(classifyDisconnect({ code: 1005 })).toBe('recoverable');
  });

  it('treats an unknown/abnormal code as recoverable', () => {
    expect(classifyDisconnect({ code: 1011 })).toBe('recoverable');
  });

  it('does not throw on missing/empty event', () => {
    expect(classifyDisconnect()).toBe('recoverable');
    expect(classifyDisconnect({})).toBe('recoverable');
  });

  it('permanent wins even with code 1005', () => {
    expect(classifyDisconnect({ code: 1005, permanent: true })).toBe('terminal');
  });
});

describe('orb-lifecycle.shouldResumeListening()', () => {
  it('resumes listening from awaitingInput (was waiting on the user)', () => {
    expect(shouldResumeListening('awaitingInput')).toBe(true);
  });

  it('resumes listening from connecting (session came up)', () => {
    expect(shouldResumeListening('connecting')).toBe(true);
  });

  it('does NOT interrupt a turn that is processing a request', () => {
    expect(shouldResumeListening('processing')).toBe(false);
  });

  it('does NOT interrupt a turn that is speaking a response', () => {
    expect(shouldResumeListening('speaking')).toBe(false);
  });

  it('leaves a dormant (idle) orb dormant', () => {
    expect(shouldResumeListening('idle')).toBe(false);
  });

  it('is a no-op for an orb already listening', () => {
    expect(shouldResumeListening('listening')).toBe(false);
  });
});

// Guard the orb.html wiring so a future edit can't silently revert to the
// old "endSession on every disconnect" behaviour that killed in-flight turns.
describe('orb.html -- lifecycle wiring invariants', () => {
  const orbHtml = readFileSync(resolve(__dirname, '..', '..', 'orb.html'), 'utf8');

  it('loads the orb-lifecycle module', () => {
    expect(orbHtml).toMatch(/orb-lifecycle\.js/);
  });

  it('classifies disconnects instead of unconditionally ending the session', () => {
    const start = orbHtml.indexOf('disconnected: (e) =>');
    expect(start).toBeGreaterThan(-1);
    const block = orbHtml.slice(start, start + 2400);
    expect(block).toMatch(/classifyDisconnect/);
    // endSession must be inside the terminal branch, not unconditional.
    expect(block).toMatch(/kind\s*===\s*['"]terminal['"]/);
    expect(block).toMatch(/_armDisconnectSafetyTimer\(\)/);
  });

  it('reconnected clears the safety timer and gates the listening resume', () => {
    const start = orbHtml.indexOf('reconnected: (e) =>');
    expect(start).toBeGreaterThan(-1);
    const block = orbHtml.slice(start, start + 900);
    expect(block).toMatch(/_clearDisconnectSafetyTimer\(\)/);
    expect(block).toMatch(/shouldResumeListening/);
  });

  it('defines a bounded reconnect safety timer', () => {
    expect(orbHtml).toMatch(/DISCONNECT_SAFETY_MS\s*=\s*\d+/);
    expect(orbHtml).toMatch(/function _armDisconnectSafetyTimer/);
    expect(orbHtml).toMatch(/function _clearDisconnectSafetyTimer/);
  });
});
