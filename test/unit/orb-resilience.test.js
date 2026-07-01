/**
 * orb-resilience -- "never end a turn in silence"
 *
 * Pins the policy that turns a silent dead-end (dispatched a request, nothing
 * came back, a watchdog force-idled the orb) into a spoken fallback -- the fix
 * for "the interaction was smooth but it just didn't do anything". Also guards
 * the orb.html idle-entry wiring and the realtime keepalive in the OpenAI
 * adapter against silent regression.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { isDeadEndReason, deadEndMessage } = require('../../lib/orb/orb-resilience.js');

describe('orb-resilience.isDeadEndReason()', () => {
  it('flags a processing timeout (agent never answered)', () => {
    expect(isDeadEndReason('processing-timeout')).toBe(true);
  });

  it('flags a session timeout', () => {
    expect(isDeadEndReason('session-timeout')).toBe(true);
  });

  it('flags a mid-turn reconnect timeout', () => {
    expect(isDeadEndReason('ws-reconnect-timeout')).toBe(true);
  });

  it('does NOT flag a normal completion', () => {
    expect(isDeadEndReason('tts-complete')).toBe(false);
  });

  it('does NOT flag a user stop', () => {
    expect(isDeadEndReason('user-stop')).toBe(false);
  });

  it('does NOT flag connect/mic setup failures (they have their own UI)', () => {
    expect(isDeadEndReason('connect-timeout')).toBe(false);
    expect(isDeadEndReason('connect-failed')).toBe(false);
    expect(isDeadEndReason('mic-failed')).toBe(false);
  });

  it('does not throw on undefined', () => {
    expect(isDeadEndReason(undefined)).toBe(false);
  });
});

describe('orb-resilience.deadEndMessage()', () => {
  it('returns a retry-inviting message for a timeout', () => {
    const msg = deadEndMessage('processing-timeout');
    expect(msg).toMatch(/try again/i);
    expect(msg.length).toBeGreaterThan(0);
  });

  it('names the dropped connection for a reconnect timeout', () => {
    expect(deadEndMessage('ws-reconnect-timeout')).toMatch(/connection/i);
  });

  it('always returns a non-empty string, even for unknown reasons', () => {
    expect(typeof deadEndMessage('something-new')).toBe('string');
    expect(deadEndMessage('something-new').length).toBeGreaterThan(0);
  });
});

describe('orb.html -- dead-end fallback wiring', () => {
  const orbHtml = readFileSync(resolve(__dirname, '..', '..', 'orb.html'), 'utf8');

  it('loads the orb-resilience module', () => {
    expect(orbHtml).toMatch(/orb-resilience\.js/);
  });

  it('speaks a fallback on idle entry for a dead-end reason', () => {
    const idleIdx = orbHtml.indexOf("if (to === 'idle')");
    expect(idleIdx).toBeGreaterThan(-1);
    const block = orbHtml.slice(idleIdx, idleIdx + 1200);
    expect(block).toMatch(/OrbResilience\.isDeadEndReason\(reason\)/);
    expect(block).toMatch(/orbAPI\?\.speak\?\./);
  });
});

describe('openai-adapter -- realtime keepalive', () => {
  const adapter = readFileSync(
    resolve(__dirname, '..', '..', 'lib', 'ai-providers', 'openai-adapter.js'),
    'utf8'
  );
  const start = adapter.indexOf('createRealtimeSession(opts)');
  const block = adapter.slice(start, start + 2500);

  it('pings the socket on an interval while open', () => {
    expect(block).toMatch(/setInterval/);
    expect(block).toMatch(/ws\.ping\(\)/);
  });

  it('clears the keepalive timer on close', () => {
    expect(block).toMatch(/clearInterval\(keepaliveTimer\)/);
  });

  it('unrefs the keepalive timer so it cannot hold the process open', () => {
    expect(block).toMatch(/keepaliveTimer\.unref/);
  });
});
