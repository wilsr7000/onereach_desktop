/**
 * voice-listener -- orphaned user request → direct exchange dispatch
 *
 * Regression for the recurring "daily brief did nothing": the orb can play a
 * short trailing audio, hit audio-done → idle → disconnect (unsubscribe)
 * microseconds BEFORE the handle_user_request tool call lands. The
 * function_call_transcript then broadcasts to ZERO subscribers and the request
 * is silently orphaned -- it never reaches the exchange.
 *
 * The fix: when there are no subscribers at that instant, voice-listener
 * dispatches the request to the exchange directly from the main process (the
 * same hudApi.submitTask → processSubmit path the renderer uses), so the brief
 * still runs. These tests pin that behaviour and guard against double-dispatch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// hud-api is exercised through the injectable _deps seam (avoids the flaky
// vitest+CJS module-mock interception for voice-listener's require chain).
let submitTask;
function makeListener() {
  const listener = new VoiceListener();
  submitTask = vi.fn(() => Promise.resolve({ taskId: 't1', queued: true }));
  listener.__setDeps({
    hudApi: { submitTask, isSpeaking: () => false, speechStarted: () => {}, speechEnded: () => {} },
    getBargeDetector: () => null,
    getAffect: () => null,
    getVoiceSpeaker: () => ({ speak: () => Promise.resolve() }),
  });
  return listener;
}

function userRequestEvent(transcript, callId = 'call_1') {
  return {
    type: 'response.function_call_arguments.done',
    name: 'handle_user_request',
    arguments: JSON.stringify({ transcript }),
    call_id: callId,
    item_id: 'item_1',
  };
}

describe('voice-listener -- orphaned user request → direct exchange dispatch', () => {
  beforeEach(() => { submitTask = undefined; });

  it('dispatches to the exchange directly when there are NO subscribers (the orphan case)', () => {
    const listener = makeListener();
    // No subscribers -- the orb disconnected right before the tool call landed.
    expect(listener.subscribers.size).toBe(0);

    listener.handleEvent(userRequestEvent('Give me the daily brief'));

    expect(submitTask).toHaveBeenCalledTimes(1);
    expect(submitTask).toHaveBeenCalledWith(
      'Give me the daily brief',
      expect.objectContaining({ toolId: 'orb', inputModality: 'voice' })
    );
  });

  it('does NOT dispatch from main when a subscriber is present (renderer handles it — no double-dispatch)', () => {
    const listener = makeListener();
    listener.subscribe(1, () => {}); // orb is subscribed and will dispatch itself

    listener.handleEvent(userRequestEvent('Give me the daily brief'));

    expect(submitTask).not.toHaveBeenCalled();
  });

  it('still broadcasts function_call_transcript to a present subscriber', () => {
    const listener = makeListener();
    const received = [];
    listener.subscribe(1, (e) => received.push(e));

    listener.handleEvent(userRequestEvent('hello'));

    const fc = received.find((e) => e.type === 'function_call_transcript');
    expect(fc).toBeTruthy();
    expect(fc.transcript).toBe('hello');
    expect(fc.callId).toBe('call_1');
  });

  it('does not dispatch for an empty/whitespace transcript', () => {
    const listener = makeListener();
    listener.handleEvent(userRequestEvent('   '));
    expect(submitTask).not.toHaveBeenCalled();
  });

  it('survives a submitTask rejection without throwing (best-effort dispatch)', () => {
    const listener = makeListener();
    submitTask.mockReturnValueOnce(Promise.reject(new Error('exchange down')));
    expect(() => listener.handleEvent(userRequestEvent('brief please'))).not.toThrow();
    expect(submitTask).toHaveBeenCalledTimes(1);
  });
});
