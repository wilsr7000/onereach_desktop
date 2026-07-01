/**
 * voice-listener -- realtime transport resilience
 *
 * Regression cover for the "voice orb did nothing" failure: a 1005 close
 * at end-of-turn used to silently abort the request (respondToFunctionCall
 * wrote to a dead socket) and the reconnect logic was fragile.
 *
 * The behaviour-level fallback (respondToFunctionCall -> voice-speaker when
 * the realtime slot is dead/stale) is pinned in voice-listener-affect.test.js.
 * This file pins:
 *   - the deferred-teardown state machine (directly exercisable), and
 *   - the onClose hardening, via source assertions (the same approach the
 *     cancel/stop-tools test uses for branches that need a live socket).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: {},
  app: { getPath: () => '/tmp' },
}), { virtual: true });

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../budget-manager', () => ({
  getBudgetManager: () => ({ trackUsage: vi.fn() }),
}));

vi.mock('../../lib/transcript-service', () => ({
  getTranscriptService: () => ({ push: vi.fn() }),
}));

vi.mock('../../lib/ai-service', () => ({
  getAIService: () => ({ _getApiKey: () => 'test-key' }),
}));

const { VoiceListener } = require('../../voice-listener.js');

function newListener() {
  const listener = new VoiceListener();
  listener.__setDeps({
    hudApi: { isSpeaking: () => false, speechStarted: vi.fn(), speechEnded: vi.fn() },
    getBargeDetector: () => null,
    getAffect: () => null,
    getVoiceSpeaker: () => ({ speak: vi.fn(() => Promise.resolve()) }),
  });
  return listener;
}

describe('voice-listener -- deferred teardown while a request is pending', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('tears down immediately when the last subscriber leaves and nothing is pending', () => {
    const listener = newListener();
    listener.subscribe(1, () => {});
    const disconnectSpy = vi.spyOn(listener, 'disconnect');

    listener.unsubscribe(1);
    expect(disconnectSpy).toHaveBeenCalled();
  });

  it('holds the session open when the last subscriber leaves mid-request', () => {
    const listener = newListener();
    listener.subscribe(1, () => {});
    const disconnectSpy = vi.spyOn(listener, 'disconnect');

    listener.pendingFunctionCallId = 'call_1';
    listener.unsubscribe(1);

    // Not torn down immediately -- the answer is still coming back.
    expect(disconnectSpy).not.toHaveBeenCalled();
    expect(listener._idleDisconnectTimer).not.toBeNull();
  });

  it('forces teardown once the grace window elapses with no answer', () => {
    const listener = newListener();
    listener.subscribe(1, () => {});
    const disconnectSpy = vi.spyOn(listener, 'disconnect');

    listener.pendingFunctionCallId = 'call_1';
    listener.unsubscribe(1);
    vi.advanceTimersByTime(listener._idleDisconnectMs);

    expect(disconnectSpy).toHaveBeenCalled();
  });

  it('a returning subscriber cancels the scheduled teardown', () => {
    const listener = newListener();
    listener.subscribe(1, () => {});
    const disconnectSpy = vi.spyOn(listener, 'disconnect');

    listener.pendingFunctionCallId = 'call_1';
    listener.unsubscribe(1);
    expect(listener._idleDisconnectTimer).not.toBeNull();

    listener.subscribe(2, () => {}); // orb returns
    expect(listener._idleDisconnectTimer).toBeNull();

    vi.advanceTimersByTime(listener._idleDisconnectMs);
    expect(disconnectSpy).not.toHaveBeenCalled();
  });

  it('disconnect() clears a scheduled idle-teardown timer', () => {
    const listener = newListener();
    listener.subscribe(1, () => {});
    listener.pendingFunctionCallId = 'call_1';
    listener.unsubscribe(1);
    expect(listener._idleDisconnectTimer).not.toBeNull();

    listener.disconnect();
    expect(listener._idleDisconnectTimer).toBeNull();
    expect(listener.pendingFunctionCallGeneration).toBeNull();
  });
});

describe('voice-listener -- default resilience configuration', () => {
  it('starts at generation 0 with no pending generation', () => {
    const listener = newListener();
    expect(listener._generation).toBe(0);
    expect(listener.pendingFunctionCallGeneration).toBeNull();
  });

  it('allows several reconnect attempts before giving up', () => {
    const listener = newListener();
    expect(listener.maxReconnectAttempts).toBeGreaterThanOrEqual(5);
  });
});

// The onClose handler lives inside connect()'s Promise executor and needs a
// live realtime socket to reach, so we pin its resilience invariants against
// the source (mirrors voice-listener-cancel-stop-tools.test.js).
describe('voice-listener -- onClose source invariants', () => {
  const src = readFileSync(resolve(__dirname, '..', '..', 'voice-listener.js'), 'utf8');
  const onCloseStart = src.indexOf('onClose:');
  const onCloseBlock = src.slice(onCloseStart, onCloseStart + 2000);

  it('resets the connect guard (_isConnecting) on close', () => {
    expect(onCloseBlock).toMatch(/this\._isConnecting\s*=\s*false/);
  });

  it('reconnects when a request is in-flight, not just when subscribers exist', () => {
    expect(onCloseBlock).toMatch(/hasPendingRequest/);
    expect(onCloseBlock).toMatch(/hasSubscribers\s*\|\|\s*hasPendingRequest/);
  });

  it('adds jitter to the reconnect backoff', () => {
    expect(onCloseBlock).toMatch(/Math\.random\(\)/);
  });

  it('bumps the session generation on a successful open', () => {
    const openStart = src.indexOf("this.ws.on('open'");
    const openBlock = src.slice(openStart, openStart + 800);
    expect(openBlock).toMatch(/this\._generation\+\+/);
  });
});
