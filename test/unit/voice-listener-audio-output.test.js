/**
 * voice-listener -- Phase 3 audio output streaming + hud/barge lifecycle
 *
 * Covers the handleEvent paths added in Phase 3:
 *   - response.output_audio.delta forwards as audio_delta IPC broadcast
 *   - response.output_audio.done forwards as audio_done
 *   - response.output_audio_transcript.delta forwards as speech_text_delta
 *   - response.output_audio_transcript.done forwards as speech_text
 *   - hudApi.speechStarted fires on first audio delta of a response (once)
 *   - hudApi.speechEnded fires on output_audio.done
 *   - barge-detector onTtsStart / onTtsUpdate / onTtsEnd are called
 *   - response.done is a safety-net release if output_audio.done missed
 *
 * Uses VoiceListener.__setDeps to inject stub hud-api + barge-detector --
 * cleaner than vi.mock for these because some references go through lazy
 * requires that don't reliably resolve to vi.mock factories.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

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

vi.mock('../../lib/ai-service', () => ({
  getAIService: () => ({ _getApiKey: () => 'test-key' }),
}));

vi.mock('../../budget-manager', () => ({
  getBudgetManager: () => ({ trackUsage: vi.fn() }),
}));

vi.mock('../../lib/transcript-service', () => ({
  getTranscriptService: () => ({ push: vi.fn() }),
}));

const { VoiceListener } = require('../../voice-listener.js');

function makeStubs() {
  return {
    hudApi: {
      isSpeaking: vi.fn(() => false),
      speechStarted: vi.fn(),
      speechEnded: vi.fn(),
    },
    barge: {
      onTtsStart: vi.fn(),
      onTtsUpdate: vi.fn(),
      onTtsEnd: vi.fn(),
      onUserPartial: vi.fn(),
    },
  };
}

function makeListener() {
  const listener = new VoiceListener();
  const broadcasts = [];
  listener.broadcast = (e) => broadcasts.push(e);
  const stubs = makeStubs();
  listener.__setDeps({
    hudApi: stubs.hudApi,
    getBargeDetector: () => stubs.barge,
  });
  return { listener, broadcasts, hudApi: stubs.hudApi, barge: stubs.barge };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('voice-listener -- response.output_audio.delta', () => {
  it('forwards base64 PCM as audio_delta broadcast', () => {
    const { listener, broadcasts } = makeListener();
    listener.handleEvent({
      type: 'response.output_audio.delta',
      delta: 'BASE64CHUNK',
      response_id: 'resp_1',
    });
    expect(broadcasts).toContainEqual({
      type: 'audio_delta',
      audio: 'BASE64CHUNK',
      responseId: 'resp_1',
    });
  });

  it('drops empty deltas without broadcasting', () => {
    const { listener, broadcasts } = makeListener();
    listener.handleEvent({ type: 'response.output_audio.delta', response_id: 'r' });
    expect(broadcasts).toHaveLength(0);
  });

  it('fires hudApi.speechStarted + barge.onTtsStart on the first delta of a response', () => {
    const { listener, hudApi, barge } = makeListener();
    listener.handleEvent({
      type: 'response.output_audio.delta',
      delta: 'CHUNK',
      response_id: 'r1',
    });
    expect(hudApi.speechStarted).toHaveBeenCalledTimes(1);
    expect(barge.onTtsStart).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire speechStarted again on subsequent deltas of the same response', () => {
    const { listener, hudApi, barge } = makeListener();
    listener.handleEvent({ type: 'response.output_audio.delta', delta: 'A', response_id: 'r1' });
    listener.handleEvent({ type: 'response.output_audio.delta', delta: 'B', response_id: 'r1' });
    listener.handleEvent({ type: 'response.output_audio.delta', delta: 'C', response_id: 'r1' });
    expect(hudApi.speechStarted).toHaveBeenCalledTimes(1);
    expect(barge.onTtsStart).toHaveBeenCalledTimes(1);
  });

  it('fires speechStarted again for a new response_id', () => {
    const { listener, hudApi } = makeListener();
    listener.handleEvent({ type: 'response.output_audio.delta', delta: 'A', response_id: 'r1' });
    listener.handleEvent({ type: 'response.created', response: { id: 'r2' } });
    listener.handleEvent({ type: 'response.output_audio.delta', delta: 'A2', response_id: 'r2' });
    expect(hudApi.speechStarted).toHaveBeenCalledTimes(2);
  });
});

describe('voice-listener -- response.output_audio.done', () => {
  it('broadcasts audio_done and releases hudApi + barge', () => {
    const { listener, broadcasts, hudApi, barge } = makeListener();
    listener.handleEvent({ type: 'response.output_audio.delta', delta: 'A', response_id: 'r1' });
    listener.handleEvent({ type: 'response.output_audio.done', response_id: 'r1' });
    expect(broadcasts).toContainEqual({ type: 'audio_done', responseId: 'r1' });
    expect(hudApi.speechEnded).toHaveBeenCalled();
    expect(barge.onTtsEnd).toHaveBeenCalled();
  });
});

describe('voice-listener -- response.output_audio_transcript', () => {
  it('forwards delta as speech_text_delta and feeds the barge detector', () => {
    const { listener, broadcasts, barge } = makeListener();
    listener.handleEvent({ type: 'response.created', response: { id: 'r1' } });
    listener.handleEvent({
      type: 'response.output_audio_transcript.delta',
      delta: 'Hello ',
      response_id: 'r1',
    });
    listener.handleEvent({
      type: 'response.output_audio_transcript.delta',
      delta: 'world.',
      response_id: 'r1',
    });
    const deltas = broadcasts.filter((b) => b.type === 'speech_text_delta');
    expect(deltas).toHaveLength(2);
    expect(deltas[0].text).toBe('Hello ');
    expect(deltas[1].text).toBe('world.');
    const tcalls = barge.onTtsUpdate.mock.calls.map((c) => c[0]);
    expect(tcalls).toContain('Hello ');
    expect(tcalls).toContain('Hello world.');
  });

  it('broadcasts the full transcript as speech_text on done', () => {
    const { listener, broadcasts } = makeListener();
    listener.handleEvent({ type: 'response.created', response: { id: 'r1' } });
    listener.handleEvent({
      type: 'response.output_audio_transcript.delta',
      delta: 'Spoken response.',
      response_id: 'r1',
    });
    listener.handleEvent({
      type: 'response.output_audio_transcript.done',
      transcript: 'Spoken response.',
      response_id: 'r1',
    });
    const finalBroadcast = broadcasts.find((b) => b.type === 'speech_text');
    expect(finalBroadcast).toBeDefined();
    expect(finalBroadcast.text).toBe('Spoken response.');
  });
});

describe('voice-listener -- response.done safety net', () => {
  it('releases speechEnded + onTtsEnd if output_audio.done was missed', () => {
    const { listener, hudApi, barge } = makeListener();
    listener.handleEvent({ type: 'response.created', response: { id: 'r1' } });
    listener.handleEvent({ type: 'response.output_audio.delta', delta: 'A', response_id: 'r1' });
    // Simulate missing output_audio.done -- only response.done arrives.
    listener.handleEvent({ type: 'response.done', response: { id: 'r1' } });
    expect(hudApi.speechEnded).toHaveBeenCalled();
    expect(barge.onTtsEnd).toHaveBeenCalled();
  });

  it('does NOT release speechEnded for a silent function-call response', () => {
    const { listener, hudApi, barge } = makeListener();
    listener.handleEvent({ type: 'response.created', response: { id: 'r1' } });
    // No audio deltas -- this is a tool-only response.
    listener.handleEvent({ type: 'response.done', response: { id: 'r1' } });
    expect(hudApi.speechEnded).not.toHaveBeenCalled();
    expect(barge.onTtsEnd).not.toHaveBeenCalled();
  });
});
