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
const { getBudgetManager } = require('./budget-manager');

class VoiceSpeaker {
  constructor() {
    this.apiKey = null;
    this.isSpeaking = false;
    this.subscribers = new Map();  // webContents ID -> callback
    
    // Speech queue for preventing overlapping audio
    this.speechQueue = getSpeechQueue();
    this.speechQueue.setSpeakFunction((text, metadata) => this._doSpeak(text, metadata));
    this.speechQueue.setCancelFunction(() => this._doCancel());
    
    console.log('[VoiceSpeaker] Initialized');
  }

  /**
   * Get OpenAI API key from settings
   */
  getApiKey() {
    if (this.apiKey) return this.apiKey;
    
    if (global.settingsManager) {
      // First try the dedicated OpenAI key
      const openaiKey = global.settingsManager.get('openaiApiKey');
      if (openaiKey) {
        this.apiKey = openaiKey;
        return this.apiKey;
      }
      
      // Fall back to LLM API key if provider is OpenAI
      const provider = global.settingsManager.get('llmProvider');
      const llmKey = global.settingsManager.get('llmApiKey');
      
      if (llmKey && (!provider || provider === 'openai')) {
        this.apiKey = llmKey;
        return this.apiKey;
      }
      
      // If llmApiKey starts with sk-, assume it's OpenAI
      if (llmKey && llmKey.startsWith('sk-')) {
        this.apiKey = llmKey;
        return this.apiKey;
      }
    }
    
    return null;
  }

  /**
   * Clear cached API key (call when settings change)
   */
  clearApiKey() {
    this.apiKey = null;
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
        voice: options.voice || 'alloy'
      }
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
      ...this.speechQueue.getStatus()
    };
  }

  /**
   * Internal: Actually speak text using OpenAI TTS API
   * @private
   */
  async _doSpeak(text, metadata = {}) {
    this._ensureOrbSubscribed();
    
    const apiKey = this.getApiKey();
    if (!apiKey) {
      console.error('[VoiceSpeaker] No API key available');
      return false;
    }
    
    // Clear any currently playing audio
    if (this.isSpeaking) {
      this.broadcast({ type: 'clear_audio_buffer' });
      this.isSpeaking = false;
    }
    
    const voice = metadata?.voice || 'alloy';
    console.log('[VoiceSpeaker] Speaking:', text.slice(0, 80), '| Voice:', voice);
    
    try {
      this.isSpeaking = true;
      
      // Call OpenAI TTS API
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: text,
          voice: voice,
          response_format: 'wav',
        }),
      });
      
      if (!response.ok) {
        const error = await response.text();
        console.error('[VoiceSpeaker] TTS API error:', response.status, error);
        this.isSpeaking = false;
        return false;
      }
      
      // Track usage for cost monitoring
      try {
        const budgetManager = getBudgetManager();
        const estimatedTokens = Math.ceil(text.length / 4);
        budgetManager.trackUsage({
          provider: 'openai',
          model: 'tts-1',
          inputTokens: estimatedTokens,
          outputTokens: 0,
          feature: 'tts-voice',
          operation: 'text-to-speech',
        });
      } catch (trackError) {
        console.warn('[VoiceSpeaker] Failed to track usage:', trackError.message);
      }
      
      // Get audio data
      const ttsResponseId = `tts-${Date.now()}`;
      const audioBuffer = await response.arrayBuffer();
      const base64Audio = Buffer.from(audioBuffer).toString('base64');
      
      console.log(`[VoiceSpeaker] WAV received: ${audioBuffer.byteLength} bytes`);
      
      // Estimate duration (48000 bytes/sec for 24kHz 16-bit mono + 44 byte header)
      const estimatedDurationMs = Math.max(500, ((audioBuffer.byteLength - 44) / 48000) * 1000);
      
      // Stream text word-by-word synced to audio
      this._streamTextWithTiming(text, estimatedDurationMs, ttsResponseId);
      
      // Send WAV audio to renderer
      this.broadcast({ 
        type: 'audio_wav', 
        audio: base64Audio, 
        responseId: ttsResponseId,
        format: 'wav'
      });
      
      // Mark complete after estimated duration
      setTimeout(() => {
        this.broadcast({ type: 'audio_done', responseId: ttsResponseId });
        this.speechQueue.markComplete();
        this.isSpeaking = false;
      }, estimatedDurationMs + 100);
      
      // Also broadcast full text
      this.broadcast({ type: 'speech_text', text: text });
      
      return true;
      
    } catch (err) {
      console.error('[VoiceSpeaker] TTS error:', err);
      this.isSpeaking = false;
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
        responseId 
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
    console.log(`[VoiceSpeaker] Subscriber added: ${webContentsId}`);
  }

  /**
   * Unsubscribe from events
   */
  unsubscribe(webContentsId) {
    this.subscribers.delete(webContentsId);
    console.log(`[VoiceSpeaker] Subscriber removed: ${webContentsId}`);
  }

  /**
   * Ensure orb window is subscribed for audio playback
   * @private
   */
  _ensureOrbSubscribed() {
    try {
      const windows = BrowserWindow.getAllWindows();
      
      const orbWindow = windows.find(w => {
        try {
          const url = w.webContents?.getURL() || '';
          return url.includes('orb.html');
        } catch { return false; }
      });
      
      if (orbWindow && !orbWindow.isDestroyed()) {
        const orbId = orbWindow.webContents.id;
        
        if (!this.subscribers.has(orbId)) {
          console.log(`[VoiceSpeaker] Auto-subscribing orb window (id: ${orbId})`);
          
          this.subscribe(orbId, (event) => {
            if (!orbWindow.isDestroyed()) {
              orbWindow.webContents.send('realtime-speech:event', event);
            }
          });
        }
      }
    } catch (err) {
      console.warn('[VoiceSpeaker] Error ensuring orb subscribed:', err.message);
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
      } catch (err) {
        console.error(`[VoiceSpeaker] Error broadcasting to ${id}:`, err);
      }
    });
    
    // For audio events, send directly to all windows if no subscribers
    const audioEvents = ['audio_wav', 'audio_delta', 'audio_done', 'clear_audio_buffer', 'speech_text_delta', 'speech_text'];
    if (this.subscribers.size === 0 && audioEvents.includes(event.type)) {
      try {
        const windows = BrowserWindow.getAllWindows();
        
        for (const win of windows) {
          try {
            if (!win.isDestroyed() && win.webContents) {
              win.webContents.send('realtime-speech:event', event);
            }
          } catch (e) {
            // Ignore individual window errors
          }
        }
      } catch (err) {
        console.error('[VoiceSpeaker] Error sending to windows:', err.message);
      }
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
