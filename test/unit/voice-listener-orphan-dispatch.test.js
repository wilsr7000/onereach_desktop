/**
 * voice-listener -- SINGLE-PATH dispatch (main process owns voice dispatch)
 *
 * History: this file originally pinned an "orphan dispatch" fallback (main
 * dispatched only when zero renderers were subscribed) layered on top of the
 * renderer's own submitTask path. The dual paths raced each other -- the orb
 * unsubscribing microseconds before the tool call landed produced the
 * "daily brief did nothing" failures, and reciprocal same-turn dedup was
 * needed to stop double-dispatch. That architecture is gone.
 *
 * Contract now: the main process ALWAYS dispatches on handle_user_request
 * (renderers receive function_call_transcript for UI only), the realtime tool
 * call is ALWAYS silent-acked immediately (the realtime session is an ear,
 * never an answer channel), and synchronous (non-queued) replies are spoken
 * through voice-speaker from main.
 */

import { describe, it, expect, vi } from 'vitest';

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

// hud-api + speaker via the injectable _deps seam (vitest module mocks don't
// reliably intercept this CJS require chain).
let submitTask, speak;
function makeListener() {
  const listener = new VoiceListener();
  submitTask = vi.fn(() => Promise.resolve({ taskId: 't1', queued: true, suppressAIResponse: true }));
  speak = vi.fn(() => Promise.resolve(true));
  listener.__setDeps({
    hudApi: { submitTask, isSpeaking: () => false, speechStarted: () => {}, speechEnded: () => {} },
    getBargeDetector: () => null,
    getAffect: () => null,
    getVoiceSpeaker: () => ({ speak }),
  });
  // Capture realtime sends so we can assert the silent ack.
  listener.isConnected = true;
  listener.sent = [];
  listener.sendEvent = vi.fn((e) => { listener.sent.push(e); return true; });
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

const flush = () => new Promise((r) => { setTimeout(r, 0); });

describe('voice-listener -- single-path dispatch (main always dispatches)', () => {
  it('dispatches to the exchange with NO subscribers (the old orphan race is structurally gone)', () => {
    const listener = makeListener();
    expect(listener.subscribers.size).toBe(0);
    listener.handleEvent(userRequestEvent('Give me the daily brief'));
    expect(submitTask).toHaveBeenCalledTimes(1);
    expect(submitTask).toHaveBeenCalledWith(
      'Give me the daily brief',
      expect.objectContaining({ toolId: 'orb', inputModality: 'voice' })
    );
  });

  it('ALSO dispatches when a renderer is subscribed — main is the only dispatcher, no dedup needed', () => {
    const listener = makeListener();
    listener.subscribe(1, () => {});
    listener.handleEvent(userRequestEvent('Give me the daily brief'));
    expect(submitTask).toHaveBeenCalledTimes(1);
  });

  it('silent-acks the realtime tool call immediately (ear, not answer channel)', () => {
    const listener = makeListener();
    listener.handleEvent(userRequestEvent('hello', 'call_42'));
    const ack = listener.sent.find((e) => e.type === 'conversation.item.create');
    expect(ack).toBeTruthy();
    expect(ack.item.call_id).toBe('call_42');
    expect(JSON.parse(ack.item.output).response).toBe('');
    // Silent ack must NOT trigger a model response.create (no realtime voicing).
    expect(listener.sent.find((e) => e.type === 'response.create')).toBeUndefined();
  });

  it('still broadcasts function_call_transcript to subscribers, marked uiOnly', () => {
    const listener = makeListener();
    const received = [];
    listener.subscribe(1, (e) => received.push(e));
    listener.handleEvent(userRequestEvent('hello'));
    const fc = received.find((e) => e.type === 'function_call_transcript');
    expect(fc).toBeTruthy();
    expect(fc.transcript).toBe('hello');
    expect(fc.uiOnly).toBe(true);
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

describe('voice-listener -- immediate (non-queued) replies speak via voice-speaker', () => {
  it('speaks a synchronous message (clarification / filter) through the speaker', async () => {
    const listener = makeListener();
    submitTask.mockReturnValueOnce(
      Promise.resolve({ queued: false, message: 'Did you mean the morning brief?' })
    );
    listener.handleEvent(userRequestEvent('the thing'));
    await flush();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0]).toContain('morning brief');
  });

  it('prefers the needsInput prompt over message', async () => {
    const listener = makeListener();
    submitTask.mockReturnValueOnce(
      Promise.resolve({ queued: false, message: 'x', needsInput: { prompt: 'Which alarm time?' } })
    );
    listener.handleEvent(userRequestEvent('set an alarm'));
    await flush();
    expect(speak.mock.calls[0][0]).toBe('Which alarm time?');
  });

  it('stays silent for queued results — the task:settled path owns those answers', async () => {
    const listener = makeListener();
    listener.handleEvent(userRequestEvent('daily brief'));
    await flush();
    expect(speak).not.toHaveBeenCalled();
  });
});

describe('voice-listener -- transcript fidelity (Whisper over model paraphrase)', () => {
  it('dispatches the fresh Whisper transcript, not the tool-call paraphrase', () => {
    const listener = makeListener();
    listener.handleEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'Can you watch wiser playbooks?',
    });
    listener.handleEvent(userRequestEvent('any much wiser playbooks'));
    expect(submitTask).toHaveBeenCalledWith(
      'Can you watch wiser playbooks?',
      expect.objectContaining({ toolId: 'orb' })
    );
  });

  it('falls back to the tool-call transcript when no fresh Whisper text exists', () => {
    const listener = makeListener();
    listener.handleEvent(userRequestEvent('build a joke agent'));
    expect(submitTask).toHaveBeenCalledWith('build a joke agent', expect.anything());
  });
});
