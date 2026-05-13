/**
 * lib/live-translate-service -- WebSocket lifecycle + subscriber bus
 *
 * Covers:
 *   - start() opens a WebSocket to the GA translations endpoint and sends
 *     the GA-shape session.update with audio.output.language.
 *   - Subscribers receive session_started/session_stopped, caption_delta,
 *     caption_final, audio_delta, and error events from the server stream.
 *   - appendAudio sends the session.input_audio_buffer.append event with
 *     the `session.` prefix (specific to translations endpoint).
 *   - stop() closes the WebSocket and emits session_stopped exactly once.
 *   - subscribe/unsubscribe round-trip.
 *   - start() rejects when targetLang is missing or apiKey resolution fails.
 *
 * Uses a stub WebSocket constructor injected via service.__setDeps so we
 * don't touch the real `ws` module or network.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const { LiveTranslateService, TRANSLATE_URL, DEFAULT_MODEL } = require('../../lib/live-translate-service');

/**
 * A minimal stub that mimics the `ws` module's EventEmitter-shaped
 * WebSocket. Tests can grab the instance via the constructor's last call.
 */
function makeFakeWebSocket() {
  const handlers = {};
  const ws = {
    _handlers: handlers,
    readyState: 1, // OPEN
    sent: [],
    send: vi.fn(function send(raw) {
      ws.sent.push(typeof raw === 'string' ? JSON.parse(raw) : raw);
    }),
    close: vi.fn(),
    on(event, cb) {
      handlers[event] = cb;
    },
    fire(event, payload) {
      if (typeof handlers[event] === 'function') handlers[event](payload);
    },
  };
  return ws;
}

function makeFakeWebSocketCtor() {
  const ctor = vi.fn(function FakeWs(url, opts) {
    ctor.last = { url, opts, ws: makeFakeWebSocket() };
    return ctor.last.ws;
  });
  return ctor;
}

describe('LiveTranslateService -- start()', () => {
  let service;
  let WebSocketCtor;

  beforeEach(() => {
    service = new LiveTranslateService();
    WebSocketCtor = makeFakeWebSocketCtor();
    service.__setDeps({
      WebSocketCtor,
      resolveApiKey: () => 'test-key',
    });
  });

  it('rejects when targetLang is missing', async () => {
    const result = await service.start({});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/targetLang/);
    expect(WebSocketCtor).not.toHaveBeenCalled();
  });

  it('rejects when apiKey resolver returns empty', async () => {
    service.__setDeps({ WebSocketCtor, resolveApiKey: () => '' });
    const result = await service.start({ targetLang: 'es' });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/API key/i);
  });

  it('opens a WebSocket to the GA translations endpoint with bearer auth', async () => {
    await service.start({ targetLang: 'es' });
    expect(WebSocketCtor).toHaveBeenCalledTimes(1);
    const url = WebSocketCtor.mock.calls[0][0];
    expect(url).toBe(`${TRANSLATE_URL}?model=${DEFAULT_MODEL}`);
    const opts = WebSocketCtor.mock.calls[0][1];
    expect(opts.headers.Authorization).toBe('Bearer test-key');
  });

  it('sends session.update with audio.output.language on open', async () => {
    await service.start({ targetLang: 'fr' });
    WebSocketCtor.last.ws.fire('open');
    const sent = WebSocketCtor.last.ws.sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'session.update',
      session: { audio: { output: { language: 'fr' } } },
    });
  });

  it('broadcasts session_started after the socket opens', async () => {
    const events = [];
    service.subscribe((e) => events.push(e));
    await service.start({ sourceLang: 'en', targetLang: 'es' });
    WebSocketCtor.last.ws.fire('open');
    expect(events).toContainEqual({
      type: 'session_started',
      sourceLang: 'en',
      targetLang: 'es',
    });
    expect(service.isActive()).toBe(true);
  });

  it('rejects start() when already active', async () => {
    await service.start({ targetLang: 'es' });
    WebSocketCtor.last.ws.fire('open');
    const second = await service.start({ targetLang: 'de' });
    expect(second.success).toBe(false);
    expect(second.message).toMatch(/already active/i);
  });
});

describe('LiveTranslateService -- server event handling', () => {
  let service;
  let WebSocketCtor;
  let events;

  beforeEach(async () => {
    service = new LiveTranslateService();
    WebSocketCtor = makeFakeWebSocketCtor();
    service.__setDeps({ WebSocketCtor, resolveApiKey: () => 'k' });
    events = [];
    service.subscribe((e) => events.push(e));
    await service.start({ targetLang: 'es' });
    WebSocketCtor.last.ws.fire('open');
    events.length = 0; // discard session_started
  });

  it('routes session.input_transcript.delta to caption_delta (sourceText)', () => {
    WebSocketCtor.last.ws.fire(
      'message',
      Buffer.from(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'hola' }))
    );
    expect(events).toContainEqual({
      type: 'caption_delta',
      sourceText: 'hola',
      isFinal: false,
    });
  });

  it('routes session.output_transcript.delta to caption_delta (targetText)', () => {
    WebSocketCtor.last.ws.fire(
      'message',
      Buffer.from(JSON.stringify({ type: 'session.output_transcript.delta', delta: 'hello' }))
    );
    expect(events).toContainEqual({
      type: 'caption_delta',
      targetText: 'hello',
      isFinal: false,
    });
  });

  it('routes session.input_transcript.completed to caption_final', () => {
    WebSocketCtor.last.ws.fire(
      'message',
      Buffer.from(JSON.stringify({ type: 'session.input_transcript.completed', transcript: 'hola amigo' }))
    );
    expect(events).toContainEqual({
      type: 'caption_final',
      sourceText: 'hola amigo',
      isFinal: true,
    });
  });

  it('routes session.output_audio.delta to audio_delta', () => {
    WebSocketCtor.last.ws.fire(
      'message',
      Buffer.from(JSON.stringify({ type: 'session.output_audio.delta', delta: 'BASE64PCM' }))
    );
    expect(events).toContainEqual({ type: 'audio_delta', audio: 'BASE64PCM' });
  });

  it('routes error events to subscribers', () => {
    WebSocketCtor.last.ws.fire(
      'message',
      Buffer.from(JSON.stringify({ type: 'error', error: { message: 'bad token' } }))
    );
    expect(events).toContainEqual({ type: 'error', message: 'bad token' });
  });

  it('ignores unknown event types without throwing', () => {
    expect(() =>
      WebSocketCtor.last.ws.fire('message', Buffer.from(JSON.stringify({ type: 'unknown.future' })))
    ).not.toThrow();
  });
});

describe('LiveTranslateService -- appendAudio()', () => {
  let service;
  let WebSocketCtor;

  beforeEach(async () => {
    service = new LiveTranslateService();
    WebSocketCtor = makeFakeWebSocketCtor();
    service.__setDeps({ WebSocketCtor, resolveApiKey: () => 'k' });
    await service.start({ targetLang: 'es' });
    WebSocketCtor.last.ws.fire('open');
    WebSocketCtor.last.ws.sent.length = 0; // discard session.update
  });

  it('sends session.input_audio_buffer.append (note the session. prefix)', () => {
    service.appendAudio('BASE64PCMCHUNK');
    expect(WebSocketCtor.last.ws.sent[0]).toEqual({
      type: 'session.input_audio_buffer.append',
      audio: 'BASE64PCMCHUNK',
    });
  });

  it('returns false when not active', () => {
    service.stop();
    expect(service.appendAudio('x')).toBe(false);
  });

  it('returns false on empty input', () => {
    expect(service.appendAudio('')).toBe(false);
    expect(service.appendAudio(null)).toBe(false);
  });
});

describe('LiveTranslateService -- stop()', () => {
  let service;
  let WebSocketCtor;

  beforeEach(async () => {
    service = new LiveTranslateService();
    WebSocketCtor = makeFakeWebSocketCtor();
    service.__setDeps({ WebSocketCtor, resolveApiKey: () => 'k' });
    await service.start({ targetLang: 'es' });
    WebSocketCtor.last.ws.fire('open');
  });

  it('closes the WebSocket and broadcasts session_stopped exactly once', () => {
    const events = [];
    service.subscribe((e) => events.push(e));
    service.stop();
    expect(WebSocketCtor.last.ws.close).toHaveBeenCalledTimes(1);
    const stopped = events.filter((e) => e.type === 'session_stopped');
    expect(stopped).toHaveLength(1);
    expect(service.isActive()).toBe(false);
  });

  it('is idempotent on second call', () => {
    service.stop();
    const events = [];
    service.subscribe((e) => events.push(e));
    const second = service.stop();
    expect(second).toBe(false);
    expect(events).toHaveLength(0);
  });
});

describe('LiveTranslateService -- subscribe / unsubscribe', () => {
  let service;
  let WebSocketCtor;

  beforeEach(() => {
    service = new LiveTranslateService();
    WebSocketCtor = makeFakeWebSocketCtor();
    service.__setDeps({ WebSocketCtor, resolveApiKey: () => 'k' });
  });

  it('returns an id that can be used to unsubscribe', async () => {
    const calls = [];
    const id = service.subscribe((e) => calls.push(e));
    expect(typeof id).toBe('number');

    await service.start({ targetLang: 'es' });
    WebSocketCtor.last.ws.fire('open');
    expect(calls).toHaveLength(1);

    expect(service.unsubscribe(id)).toBe(true);
    service.stop();
    expect(calls).toHaveLength(1); // no further events delivered to this sub
  });

  it('throws when callback is not a function', () => {
    expect(() => service.subscribe(null)).toThrow(/callback/i);
  });

  it('getStatus reports subscriberCount', () => {
    service.subscribe(() => {});
    service.subscribe(() => {});
    expect(service.getStatus().subscriberCount).toBe(2);
  });
});
