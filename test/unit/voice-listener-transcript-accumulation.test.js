/**
 * voice-listener -- user input transcription accumulation
 *
 * Regression for "transcription shows weird, like a word at a time": the
 * realtime API streams `conversation.item.input_audio_transcription.delta`
 * one word/token at a time, and the orb's showTranscript() REPLACES its
 * caption on each event. Broadcasting the bare delta therefore flashed a
 * single word at a time. The listener must accumulate and broadcast the
 * FULL running transcript, resetting at turn boundaries (speech_started and
 * the completed event).
 *
 * Uses VoiceListener.__setDeps to inject stubs (same approach as
 * voice-listener-audio-output.test.js).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: {},
  app: { getPath: () => '/tmp' },
}), { virtual: true });

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../lib/ai-service', () => ({ getAIService: () => ({ _getApiKey: () => 'test-key' }) }));
vi.mock('../../budget-manager', () => ({ getBudgetManager: () => ({ trackUsage: vi.fn() }) }));
vi.mock('../../lib/transcript-service', () => ({ getTranscriptService: () => ({ push: vi.fn() }) }));

const { VoiceListener } = require('../../voice-listener.js');

function makeListener() {
  const listener = new VoiceListener();
  const broadcasts = [];
  listener.broadcast = (e) => broadcasts.push(e);
  listener.__setDeps({
    hudApi: { isSpeaking: vi.fn(() => false), speechStarted: vi.fn(), speechEnded: vi.fn() },
    getBargeDetector: () => ({
      onTtsStart: vi.fn(), onTtsUpdate: vi.fn(), onTtsEnd: vi.fn(), onUserPartial: vi.fn(),
    }),
  });
  return { listener, broadcasts };
}

const deltas = (broadcasts) => broadcasts.filter((b) => b.type === 'transcript_delta').map((b) => b.text);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('voice-listener -- input transcription accumulation', () => {
  it('broadcasts the accumulated running transcript, not the bare delta', () => {
    const { listener, broadcasts } = makeListener();
    for (const word of ['Play ', 'some ', 'jazz']) {
      listener.handleEvent({
        type: 'conversation.item.input_audio_transcription.delta',
        delta: word,
      });
    }
    // Each broadcast carries the full text so far -- the sentence builds up
    // in place instead of flashing one word at a time.
    expect(deltas(broadcasts)).toEqual(['Play ', 'Play some ', 'Play some jazz']);
  });

  it('resets the running transcript when a new utterance starts', () => {
    const { listener, broadcasts } = makeListener();
    listener.handleEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: 'first turn' });
    listener.handleEvent({ type: 'input_audio_buffer.speech_started' });
    listener.handleEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: 'second ' });
    listener.handleEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: 'turn' });
    expect(deltas(broadcasts)).toEqual(['first turn', 'second ', 'second turn']);
  });

  it('resets after the transcription completes so the next turn starts clean', () => {
    const { listener, broadcasts } = makeListener();
    listener.handleEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: 'hello ' });
    listener.handleEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: 'there' });
    listener.handleEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hello there',
    });
    listener.handleEvent({ type: 'conversation.item.input_audio_transcription.delta', delta: 'next' });
    expect(deltas(broadcasts)).toEqual(['hello ', 'hello there', 'next']);
  });

  it('emits the full transcript as a final transcript event on completion', () => {
    const { listener, broadcasts } = makeListener();
    listener.handleEvent({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'play some monday afternoon music',
    });
    expect(broadcasts).toContainEqual({
      type: 'transcript',
      text: 'play some monday afternoon music',
      isFinal: true,
    });
  });
});
