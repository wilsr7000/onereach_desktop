/**
 * Live Translate Service
 *
 * Owns the WebSocket connection to OpenAI's `/v1/realtime/translations`
 * endpoint and broadcasts caption events to subscribers (recorder window,
 * orb, future caption surfaces).
 *
 * Verified against GA docs (May 2026):
 *   - URL: wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate
 *   - Headers: Authorization: Bearer <key> (+ optional OpenAI-Safety-Identifier)
 *   - session.update shape: { type, session: { audio: { output: { language } } } }
 *   - Append audio: { type: 'session.input_audio_buffer.append', audio }
 *     (note the `session.` prefix vs the conversation API's `input_audio_buffer.append`)
 *   - Events received: session.output_audio.delta, session.output_transcript.delta,
 *     session.input_transcript.delta (no response.create needed; continuous stream)
 *
 * Public surface:
 *   const svc = getLiveTranslateService();
 *   await svc.start({ sourceLang?, targetLang });   -> { success, message }
 *   svc.appendAudio(base64Pcm16);
 *   svc.stop();
 *   const id = svc.subscribe(cb);                    -> id (for unsubscribe)
 *   svc.unsubscribe(id);
 *   svc.isActive() -> boolean
 *   svc.getStatus() -> { active, sourceLang, targetLang, subscriberCount }
 *
 * Events broadcast to subscribers:
 *   { type: 'session_started', sourceLang, targetLang }
 *   { type: 'session_stopped' }
 *   { type: 'caption_delta', sourceText?, targetText?, isFinal: false }
 *   { type: 'caption_final', sourceText?, targetText?, isFinal: true }
 *   { type: 'error', message }
 *
 * Tests stub the WebSocket constructor via __setDeps({ WebSocketCtor, apiKey }).
 */

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

const TRANSLATE_URL = 'wss://api.openai.com/v1/realtime/translations';
const DEFAULT_MODEL = 'gpt-realtime-translate';

const _defaultDeps = {
  WebSocketCtor: null, // resolved lazily to avoid requiring 'ws' in renderer
  resolveApiKey: () => {
    const { getAIService } = require('./ai-service');
    return getAIService()._getApiKey('openai');
  },
};

class LiveTranslateService {
  constructor() {
    this._ws = null;
    this._active = false;
    this._sourceLang = null;
    this._targetLang = null;
    this._subscribers = new Map();
    this._nextSubId = 1;
    this._deps = _defaultDeps;
  }

  __setDeps(deps) {
    this._deps = { ..._defaultDeps, ...(deps || {}) };
  }

  __resetDeps() {
    this._deps = _defaultDeps;
  }

  isActive() {
    return this._active;
  }

  getStatus() {
    return {
      active: this._active,
      sourceLang: this._sourceLang,
      targetLang: this._targetLang,
      subscriberCount: this._subscribers.size,
    };
  }

  subscribe(callback) {
    if (typeof callback !== 'function') {
      throw new Error('subscribe() requires a callback function');
    }
    const id = this._nextSubId++;
    this._subscribers.set(id, callback);
    return id;
  }

  unsubscribe(id) {
    return this._subscribers.delete(id);
  }

  _broadcast(event) {
    for (const cb of this._subscribers.values()) {
      try {
        cb(event);
      } catch (err) {
        log.warn('translate', 'subscriber threw', { error: err.message });
      }
    }
  }

  /**
   * Open a translation session.
   * @param {{ sourceLang?: string, targetLang: string }} opts
   */
  async start(opts = {}) {
    if (this._active) {
      return { success: false, message: 'Translation session already active.' };
    }
    const { targetLang, sourceLang } = opts;
    if (!targetLang) {
      return { success: false, message: 'targetLang is required.' };
    }

    let apiKey;
    try {
      apiKey = this._deps.resolveApiKey();
    } catch (err) {
      return { success: false, message: `Cannot start translation: ${err.message}` };
    }
    if (!apiKey) {
      return { success: false, message: 'No OpenAI API key configured.' };
    }

    const WebSocketCtor =
      this._deps.WebSocketCtor || (typeof WebSocket !== 'undefined' ? WebSocket : require('ws'));

    const url = `${TRANSLATE_URL}?model=${DEFAULT_MODEL}`;
    let ws;
    try {
      ws = new WebSocketCtor(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
    } catch (err) {
      return { success: false, message: `WebSocket open failed: ${err.message}` };
    }
    this._ws = ws;

    // Register event handlers. The .on() signature exists on `ws` (node);
    // browser WebSocket uses .onopen/.onmessage etc. We support both.
    const onOpen = () => {
      this._active = true;
      this._sourceLang = sourceLang || null;
      this._targetLang = targetLang;

      // Configure the session per GA docs. session.audio.output.language is
      // the target; input language is optional/auto.
      const update = {
        type: 'session.update',
        session: {
          audio: { output: { language: targetLang } },
        },
      };
      this._send(update);
      this._broadcast({ type: 'session_started', sourceLang: sourceLang || null, targetLang });
    };

    const onMessage = (raw) => {
      const text = typeof raw === 'string' ? raw : (raw && raw.toString) ? raw.toString() : '';
      this._handleServerEvent(text);
    };

    const onError = (err) => {
      log.error('translate', 'WebSocket error', { error: err && err.message ? err.message : String(err) });
      this._broadcast({ type: 'error', message: err && err.message ? err.message : 'WebSocket error' });
    };

    const onClose = () => {
      this._active = false;
      this._broadcast({ type: 'session_stopped' });
    };

    if (typeof ws.on === 'function') {
      ws.on('open', onOpen);
      ws.on('message', (data) => onMessage(data));
      ws.on('error', onError);
      ws.on('close', onClose);
    } else {
      ws.onopen = onOpen;
      ws.onmessage = (e) => onMessage(e.data);
      ws.onerror = (e) => onError(e);
      ws.onclose = onClose;
    }

    return { success: true, message: 'Translation session opening.' };
  }

  _handleServerEvent(rawText) {
    let event;
    try {
      event = JSON.parse(rawText);
    } catch (_err) {
      return;
    }
    if (!event || typeof event.type !== 'string') return;

    switch (event.type) {
      case 'session.input_transcript.delta':
        this._broadcast({ type: 'caption_delta', sourceText: event.delta, isFinal: false });
        break;
      case 'session.input_transcript.completed':
      case 'session.input_transcript.done':
        this._broadcast({
          type: 'caption_final',
          sourceText: event.transcript || event.text || '',
          isFinal: true,
        });
        break;
      case 'session.output_transcript.delta':
        this._broadcast({ type: 'caption_delta', targetText: event.delta, isFinal: false });
        break;
      case 'session.output_transcript.completed':
      case 'session.output_transcript.done':
        this._broadcast({
          type: 'caption_final',
          targetText: event.transcript || event.text || '',
          isFinal: true,
        });
        break;
      case 'session.output_audio.delta':
        // The translation endpoint also streams translated audio; for now
        // we just forward the base64 PCM so a downstream listener could
        // play it. The recorder caption flow doesn't use this today.
        this._broadcast({ type: 'audio_delta', audio: event.delta });
        break;
      case 'error':
        this._broadcast({ type: 'error', message: event.error?.message || 'Translation error' });
        break;
      default:
        // Unknown event type -- ignore, log at debug only.
        break;
    }
  }

  /**
   * Append a base64-encoded PCM16 audio chunk to the session input buffer.
   * Note the `session.` prefix on the event type -- this is specific to
   * the translation endpoint and differs from the conversation API.
   */
  appendAudio(base64Pcm16) {
    if (!this._active || !this._ws) return false;
    if (typeof base64Pcm16 !== 'string' || !base64Pcm16) return false;
    return this._send({
      type: 'session.input_audio_buffer.append',
      audio: base64Pcm16,
    });
  }

  _send(event) {
    if (!this._ws) return false;
    try {
      const ready = typeof this._ws.readyState === 'number' ? this._ws.readyState : 1;
      if (ready !== 1 /* OPEN */) return false;
      this._ws.send(JSON.stringify(event));
      return true;
    } catch (err) {
      log.warn('translate', 'send failed', { error: err.message });
      return false;
    }
  }

  /**
   * Close the WebSocket and reset state. Idempotent.
   */
  stop() {
    if (!this._ws && !this._active) return false;
    try {
      if (this._ws && typeof this._ws.close === 'function') this._ws.close();
    } catch (_err) { /* ignore */ }
    const wasActive = this._active;
    this._ws = null;
    this._active = false;
    this._sourceLang = null;
    this._targetLang = null;
    if (wasActive) this._broadcast({ type: 'session_stopped' });
    return true;
  }
}

let _instance = null;
function getLiveTranslateService() {
  if (!_instance) _instance = new LiveTranslateService();
  return _instance;
}

module.exports = {
  LiveTranslateService,
  getLiveTranslateService,
  TRANSLATE_URL,
  DEFAULT_MODEL,
};
