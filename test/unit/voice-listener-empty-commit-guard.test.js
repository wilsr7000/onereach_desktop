/**
 * voice-listener -- empty-buffer commit guard
 *
 * Regression guard for a session-killing bug where the pause-detector
 * (or any caller) would call `commitAudio()` after the server's VAD
 * already auto-committed. The Realtime API rejects a commit on a buffer
 * with <100ms of audio as `input_audio_buffer_commit_empty`, which
 * tears down the WebSocket and leaves the orb stranded in idle while
 * the visual looks like listening.
 *
 * The guard is a `_bufferHasAudio` flag that tracks whether any audio
 * has been appended since the last commit/clear. The real bug source
 * (the pause-detector racing the server VAD) isn't changed here -- we
 * just make the client-side commit idempotent on an empty buffer.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub the only things voice-listener pulls in at require time.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: {},
  app: { getPath: () => '/tmp' },
}), { virtual: true });

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('../../lib/hud-api', () => ({
  isSpeaking: () => false,
}));

vi.mock('../../lib/ai-service', () => ({
  getAIService: () => ({
    _getApiKey: () => 'test-key',
  }),
}));

const { VoiceListener } = require('../../voice-listener.js');

let listener;
let sendEventSpy;

beforeEach(() => {
  listener = new VoiceListener();
  // Pretend connection is open so sendEvent does not early-return.
  listener.isConnected = true;
  listener.ws = { readyState: 1, send: () => {} };
  // Intercept outgoing events so we can assert what was sent to OpenAI.
  sendEventSpy = vi.fn(() => true);
  listener.sendEvent = sendEventSpy;
});

describe('empty-buffer guard', () => {
  it('skips the commit when no audio has been appended', () => {
    const result = listener.commitAudio();
    expect(result).toMatchObject({ skipped: 'empty-buffer' });
    expect(sendEventSpy).not.toHaveBeenCalled();
  });

  it('allows commit after audio has been appended', () => {
    listener.sendAudio('base64data==');
    sendEventSpy.mockClear();

    const result = listener.commitAudio();
    expect(result).toBe(true);
    expect(sendEventSpy).toHaveBeenCalledWith({ type: 'input_audio_buffer.commit' });
  });

  it('second consecutive commit is skipped (idempotent)', () => {
    listener.sendAudio('base64data==');
    listener.commitAudio();          // real send
    sendEventSpy.mockClear();

    const second = listener.commitAudio();
    expect(second).toMatchObject({ skipped: 'empty-buffer' });
    expect(sendEventSpy).not.toHaveBeenCalled();
  });

  it('clearAudio resets the flag', () => {
    listener.sendAudio('base64data==');
    listener.clearAudio();
    sendEventSpy.mockClear();

    const result = listener.commitAudio();
    expect(result).toMatchObject({ skipped: 'empty-buffer' });
    expect(sendEventSpy).not.toHaveBeenCalled();
  });

  it('server-side input_audio_buffer.committed flips the flag off', () => {
    listener.sendAudio('base64data==');
    // Simulate the server VAD closing the turn by handing the event
    // to the same handler the WS listener calls.
    listener.broadcast = vi.fn();
    listener._stopSilenceTicker = vi.fn();
    listener.handleEvent({ type: 'input_audio_buffer.committed' });

    sendEventSpy.mockClear();
    const result = listener.commitAudio();
    expect(result).toMatchObject({ skipped: 'empty-buffer' });
    expect(sendEventSpy).not.toHaveBeenCalled();
  });

  it('server-side input_audio_buffer.cleared flips the flag off', () => {
    listener.sendAudio('base64data==');
    listener.broadcast = vi.fn();
    listener.handleEvent({ type: 'input_audio_buffer.cleared' });

    sendEventSpy.mockClear();
    expect(listener.commitAudio()).toMatchObject({ skipped: 'empty-buffer' });
  });

  it('sendAudio after a commit re-arms the buffer so next commit succeeds', () => {
    listener.sendAudio('first==');
    listener.commitAudio();
    listener.sendAudio('second==');
    sendEventSpy.mockClear();

    const result = listener.commitAudio();
    expect(result).toBe(true);
    expect(sendEventSpy).toHaveBeenCalledWith({ type: 'input_audio_buffer.commit' });
  });
});

describe('disconnect resets the guard', () => {
  it('commit after disconnect+reconnect starts fresh (must send audio first)', () => {
    listener.sendAudio('base64data==');
    listener.disconnect();

    // Simulate reconnect
    listener.isConnected = true;
    listener.ws = { readyState: 1, send: () => {} };
    listener.sendEvent = sendEventSpy;
    sendEventSpy.mockClear();

    // Commit without sending new audio should be skipped.
    expect(listener.commitAudio()).toMatchObject({ skipped: 'empty-buffer' });
    expect(sendEventSpy).not.toHaveBeenCalled();

    // After appending fresh audio, commit works.
    listener.sendAudio('new==');
    sendEventSpy.mockClear();
    expect(listener.commitAudio()).toBe(true);
  });
});
