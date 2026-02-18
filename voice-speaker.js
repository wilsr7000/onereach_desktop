/**
 * Voice Speaker - Pure Text-to-Speech Module
 *
 * Uses OpenAI's TTS API to convert text to speech.
 * No AI "thinking" - just pure text-to-speech conversion.
 *
 * Features:
 * - Speech queue to prevent overlapping audio
 * - Real-time text streaming synced to audio
 * - Broadcasts audio events to renderer windows
 */

const { BrowserWindow } = require('electron');
const { getSpeechQueue, PRIORITY } = require('./src/voice-task-sdk/audio/speechQueue');
const { getAIService } = require('./lib/ai-service');
const hudApi = require('./lib/hud-api');
const { getTranscriptService } = require('./lib/transcript-service');
const { getLogQueue } = require('./lib/log-event-queue');
const log = getLogQueue();

class VoiceSpeaker {
  constructor() {
    this.isSpeaking = false;
    this.subscribers = new Map(); // webContents ID -> callback

    // Speech queue for preventing overlapping audio
    this.speechQueue = getSpeechQueue();
    this.speechQueue.setSpeakFunction((text, metadata) => this._doSpeak(text, metadata));
    this.speechQueue.setCancelFunction(() => this._doCancel());

    log.info('voice', 'Initialized');
  }

  /**
   * Speak text using OpenAI TTS API
   * @param {string} text - Text to speak
   * @param {Object} options - { voice, priority }
   * @returns {Promise<boolean>}
   */
  async speak(text, options = {}) {
    return this.speechQueue.enqueue(text, {
      priority: options.priority ?? PRIORITY.NORMAL,
      metadata: {
        voice: options.voice || 'alloy',
      },
    });
  }

  /**
   * Cancel current speech and clear queue
   */
  async cancel() {
    await this.speechQueue.cancelAll();
  }

  /**
   * Cancel just the current speech (queue continues)
   */
  async cancelCurrent() {
    await this.speechQueue.cancelCurrent();
  }

  /**
   * Check if currently speaking or has pending speech
   */
  hasPendingSpeech() {
    return this.speechQueue.hasPendingOrActiveSpeech();
  }

  /**
   * Get speech queue status
   */
  getStatus() {
    return {
      isSpeaking: this.isSpeaking,
      ...this.speechQueue.getStatus(),
    };
  }

  /**
   * Internal: Actually speak text using OpenAI TTS API
   * @private
   */
  async _doSpeak(text, metadata = {}) {
    // NOTE: Removed _ensureOrbSubscribed() here. The orb subscribes when it
    // connects (startListening) and unsubscribes when it disconnects (session end).
    // Auto-re-subscribing here caused phantom audio on the idle orb because
    // speech from other flows (NormalizeIntent clarification) would be routed
    // back to an orb that had explicitly ended its session.

    // Clear any currently playing audio
    if (this.isSpeaking) {
      this.broadcast({ type: 'clear_audio_buffer' });
      this.isSpeaking = false;
    }

    const voice = metadata?.voice || 'alloy';
    log.info('voice', 'Speaking', { arg1: text.slice(0, 80), arg2: '| Voice:', voice });
    // #region agent log
    const _stack = new Error().stack
      .split('\n')
      .slice(1, 5)
      .map((s) => s.trim());
    fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: 'voice-speaker.js:_doSpeak',
        message: '_doSpeak called',
        data: {
          textPreview: text.slice(0, 80),
          voice,
          subscriberCount: this.subscribers?.size || 0,
          callerStack: _stack,
        },
        timestamp: Date.now(),
        hypothesisId: 'SPEAK-TRACE',
      }),
    }).catch((err) => console.warn('[voice-speaker] _doSpeak agent-log:', err.message));
    // #endregion

    try {
      this.isSpeaking = true;

      // Signal HUD API so voice listener can mute during playback
      hudApi.speechStarted();

      // Call TTS via centralized AI service
      const ai = getAIService();
      const result = await ai.tts(text, {
        voice: voice,
        responseFormat: 'wav',
        feature: 'voice-speaker',
      });

      // Get audio data (result.audioBuffer is a Buffer)
      const ttsResponseId = `tts-${Date.now()}`;
      const audioBuffer = result.audioBuffer;
      const base64Audio = audioBuffer.toString('base64');

      log.info('voice', 'WAV received: ... bytes', { byteLength: audioBuffer.byteLength });

      // Record agent speech in the transcript store
      try {
        getTranscriptService().push({ text, speaker: 'agent', agentId: metadata?.agentId });
      } catch (_) {
        /* non-fatal */
      }

      // Estimate duration (48000 bytes/sec for 24kHz 16-bit mono + 44 byte header)
      const estimatedDurationMs = Math.max(500, ((audioBuffer.byteLength - 44) / 48000) * 1000);

      // Stream text word-by-word synced to audio
      this._streamTextWithTiming(text, estimatedDurationMs, ttsResponseId);

      // Send WAV audio to renderer
      this.broadcast({
        type: 'audio_wav',
        audio: base64Audio,
        responseId: ttsResponseId,
        format: 'wav',
      });

      // Mark complete after estimated duration
      setTimeout(() => {
        this.broadcast({ type: 'audio_done', responseId: ttsResponseId });
        this.speechQueue.markComplete();
        this.isSpeaking = false;
        hudApi.speechEnded();
      }, estimatedDurationMs + 100);

      // Also broadcast full text
      this.broadcast({ type: 'speech_text', text: text });

      return true;
    } catch (err) {
      log.error('voice', 'TTS error', {
        error: err.message || err,
        responseBody: err.responseBody?.slice?.(0, 200) || undefined,
      });
      this.isSpeaking = false;
      hudApi.speechEnded();
      return false;
    }
  }

  /**
   * Internal: Cancel current speech
   * @private
   */
  async _doCancel() {
    this.isSpeaking = false;
    this.broadcast({ type: 'clear_audio_buffer' });
    hudApi.speechEnded();
  }

  /**
   * Stream text word-by-word with timing to match audio
   * @private
   */
  _streamTextWithTiming(text, durationMs, responseId) {
    const words = text.split(/(\s+)/);
    const totalChars = text.length;

    if (words.length === 0) return;

    const msPerChar = durationMs / totalChars;
    let wordIndex = 0;

    const streamNextWord = () => {
      if (wordIndex >= words.length || !this.isSpeaking) {
        return;
      }

      const word = words[wordIndex];
      wordIndex++;

      this.broadcast({
        type: 'speech_text_delta',
        text: word,
        responseId,
      });

      if (wordIndex < words.length) {
        const nextDelay = Math.max(20, word.length * msPerChar);
        setTimeout(streamNextWord, nextDelay);
      }
    };

    streamNextWord();
  }

  /**
   * Subscribe to speaker events
   */
  subscribe(webContentsId, callback) {
    this.subscribers.set(webContentsId, callback);
    log.info('voice', 'Subscriber added: ...', { webContentsId });
  }

  /**
   * Unsubscribe from events
   */
  unsubscribe(webContentsId) {
    this.subscribers.delete(webContentsId);
    log.info('voice', 'Subscriber removed: ...', { webContentsId });
  }

  /**
   * Ensure orb window is subscribed for audio playback
   * @private
   */
  _ensureOrbSubscribed() {
    try {
      const windows = BrowserWindow.getAllWindows();

      const orbWindow = windows.find((w) => {
        try {
          const url = w.webContents?.getURL() || '';
          return url.includes('orb.html');
        } catch {
          return false;
        }
      });

      if (orbWindow && !orbWindow.isDestroyed()) {
        const orbId = orbWindow.webContents.id;

        if (!this.subscribers.has(orbId)) {
          log.info('voice', 'Auto-subscribing orb window (id: ...)', { orbId });

          this.subscribe(orbId, (event) => {
            if (!orbWindow.isDestroyed()) {
              orbWindow.webContents.send('realtime-speech:event', event);
            }
          });
        }
      }
    } catch (err) {
      log.warn('voice', 'Error ensuring orb subscribed', { error: err.message });
    }
  }

  /**
   * Broadcast event to all subscribers
   */
  broadcast(event) {
    // Send to all registered subscribers
    this.subscribers.forEach((callback, id) => {
      try {
        callback(event);
      } catch (_err) {
        log.error('voice', 'Error broadcasting to ...', { id });
      }
    });

    // Removed: broadcast-to-all-windows fallback. This caused phantom audio
    // on the idle orb when no explicit subscribers existed. Audio should only
    // go to windows that have an active voice session (explicit subscriber).
  }
}

// Singleton instance
let instance = null;

function getVoiceSpeaker() {
  if (!instance) {
    instance = new VoiceSpeaker();
  }
  return instance;
}

module.exports = { VoiceSpeaker, getVoiceSpeaker, PRIORITY };
