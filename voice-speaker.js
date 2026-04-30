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
        // Proactive speech (from the agent message queue, e.g. the critical
        // meeting alarm agent) carries an agentId and the `proactive` flag
        // so the orb's idle-audio guard lets it through. Task-driven speech
        // leaves these undefined and behaves exactly as before.
        agentId: options.agentId,
        proactive: !!options.proactive,
        skipAffectMatching: options.skipAffectMatching,
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

    // Phase 6: affect-match the outgoing text. The tracker holds the
    // user's last detected non-neutral affect (if any, TTL-bounded).
    // The modifier is a no-op when the tracker is empty or the affect
    // doesn't warrant a change. Callers can opt out by setting
    // `metadata.skipAffectMatching = true` (e.g., for fixed safety
    // prompts that must be spoken verbatim).
    //
    // Imports through the public naturalness barrel so this file
    // stays on the stable surface instead of reaching into
    // per-phase internals.
    try {
      const {
        flags,
        affectTracker,
        responseModifier,
      } = require('./lib/naturalness');
      if (flags.isFlagEnabled('affectMatching') && !metadata?.skipAffectMatching) {
        const affect = affectTracker.getSharedAffectTracker().get();
        if (affect) {
          const adjusted = responseModifier.adjustResponse({ text, affect });
          if (adjusted.modified) {
            log.info('voice', '[Affect] adjusted response', {
              label: affect.label,
              transforms: adjusted.transforms,
              before: text.slice(0, 60),
              after: adjusted.text.slice(0, 60),
            });
            text = adjusted.text;
          }
        }
      }
    } catch (_err) { /* affect layer must never block TTS */ }

    // Clear any currently playing audio
    if (this.isSpeaking) {
      this.broadcast({ type: 'clear_audio_buffer' });
      this.isSpeaking = false;
    }

    const voice = metadata?.voice || 'alloy';
    log.info('voice', 'Speaking', { arg1: text.slice(0, 80), arg2: '| Voice:', voice });

    try {
      this.isSpeaking = true;

      // Signal HUD API so voice listener can mute during playback
      hudApi.speechStarted();

      // Phase 4.5: notify the barge detector that TTS has begun so it
      // can consider subsequent user partials as potential interrupts.
      // Lazy-load to avoid paying the cost when the flag is off.
      this._notifyBargeDetector('onTtsStart', text);

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

      // Re-arm HUD speech-state safety timeout with the known duration
      // so long-form briefs (40s+) don't get auto-cleared mid-playback.
      hudApi.speechStarted(estimatedDurationMs);

      // Stream text word-by-word synced to audio
      this._streamTextWithTiming(text, estimatedDurationMs, ttsResponseId);

      const proactive = !!metadata?.proactive;
      const agentId = metadata?.agentId;

      // Send WAV audio to renderer
      this.broadcast({
        type: 'audio_wav',
        audio: base64Audio,
        responseId: ttsResponseId,
        format: 'wav',
        proactive,
        agentId,
      });

      // Mark complete after estimated duration
      setTimeout(() => {
        this.broadcast({
          type: 'audio_done',
          responseId: ttsResponseId,
          proactive,
          agentId,
        });
        this.speechQueue.markComplete();
        this.isSpeaking = false;
        hudApi.speechEnded();
        // Phase 4.5: TTS naturally finished; the barge detector no
        // longer considers this turn a candidate for interruption.
        this._notifyBargeDetector('onTtsEnd');
      }, estimatedDurationMs + 100);

      // Also broadcast full text
      this.broadcast({ type: 'speech_text', text: text, proactive, agentId });

      return true;
    } catch (err) {
      log.error('voice', 'TTS error', {
        error: err.message || err,
        responseBody: err.responseBody?.slice?.(0, 200) || undefined,
      });
      this.isSpeaking = false;
      hudApi.speechEnded();
      // Phase 4.5: TTS errored out -- clear barge-detector state.
      this._notifyBargeDetector('onTtsEnd');
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
    // Phase 4.5: cancelled (e.g. by a barge or explicit cancel()).
    // Idempotent on the detector -- onTtsEnd just stamps endedAt.
    this._notifyBargeDetector('onTtsEnd');
  }

  /**
   * Forward a TTS lifecycle event to the shared barge detector so
   * interrupts can be detected. Lazy requires keep this module free
   * of naturalness imports at boot.
   * @private
   */
  _notifyBargeDetector(method, text) {
    try {
      const {
        getSharedBargeDetector,
      } = require('./lib/naturalness/barge-detector-singleton');
      const detector = getSharedBargeDetector();
      if (detector && typeof detector[method] === 'function') {
        if (method === 'onTtsStart' || method === 'onTtsUpdate') {
          detector[method](text || '');
        } else {
          detector[method]();
        }
      }
    } catch (_err) {
      // Barge layer must never block TTS.
    }
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

    // When no subscribers exist but we have audio to deliver, send directly
    // to the orb window. This covers the case where a task was triggered
    // from the UI (e.g. calendar click) after the voice session ended.
    // We don't re-subscribe -- just a one-shot delivery so the orb can
    // decide whether to play it (it checks for an active task).
    if (this.subscribers.size === 0 && (event.type === 'audio_wav' || event.type === 'audio_done' || event.type === 'speech_text' || event.type === 'clear_audio_buffer')) {
      try {
        const windows = BrowserWindow.getAllWindows();
        const orbWindow = windows.find((w) => {
          try {
            return (w.webContents?.getURL() || '').includes('orb.html');
          } catch { return false; }
        });
        if (orbWindow && !orbWindow.isDestroyed()) {
          orbWindow.webContents.send('realtime-speech:event', event);
        }
      } catch (_) { /* non-fatal */ }
    }
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
