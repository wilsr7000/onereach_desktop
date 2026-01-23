/**
 * OpenAI Realtime API - Streaming Speech-to-Text
 * 
 * Uses WebSocket connection to OpenAI's Realtime API for low-latency
 * real-time transcription as you speak.
 */

const WebSocket = require('ws');
const { ipcMain } = require('electron');

class RealtimeSpeech {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.sessionId = null;
    this.apiKey = null;
    this.subscribers = new Map(); // webContents ID -> callback
    this.audioBuffer = [];
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    
    // Language consistency tracking
    this.languageHistory = [];  // Last 3 detected languages
    this.currentResponseLanguage = 'en';  // Default to English
    this.languageConsistencyThreshold = 2;  // Need 2 consecutive same-language inputs to switch
  }

  /**
   * Detect language from text using character patterns
   * Returns language code: 'en', 'es', 'fr', 'de', 'zh', 'ja', 'ko', 'ar', 'ru', etc.
   */
  detectLanguage(text) {
    if (!text || text.length < 3) return 'en';
    
    // Check for non-Latin scripts first (most reliable)
    const chinesePattern = /[\u4e00-\u9fff]/;
    const japanesePattern = /[\u3040-\u309f\u30a0-\u30ff]/;
    const koreanPattern = /[\uac00-\ud7af\u1100-\u11ff]/;
    const arabicPattern = /[\u0600-\u06ff]/;
    const cyrillicPattern = /[\u0400-\u04ff]/;
    const hebrewPattern = /[\u0590-\u05ff]/;
    const thaiPattern = /[\u0e00-\u0e7f]/;
    const devanagariPattern = /[\u0900-\u097f]/;
    
    if (chinesePattern.test(text)) return 'zh';
    if (japanesePattern.test(text)) return 'ja';
    if (koreanPattern.test(text)) return 'ko';
    if (arabicPattern.test(text)) return 'ar';
    if (cyrillicPattern.test(text)) return 'ru';
    if (hebrewPattern.test(text)) return 'he';
    if (thaiPattern.test(text)) return 'th';
    if (devanagariPattern.test(text)) return 'hi';
    
    // For Latin-script languages, use common word patterns
    const lowerText = text.toLowerCase();
    
    // Spanish indicators
    if (/\b(el|la|los|las|un|una|que|de|en|es|por|para|como|pero|muy|este|esta|esto|eso|ese|aquí|allí|donde|cuando|porque|también|puede|hace|tiene|quiero|hola)\b/.test(lowerText)) {
      return 'es';
    }
    
    // French indicators
    if (/\b(le|la|les|un|une|des|du|de|je|tu|il|elle|nous|vous|ils|elles|est|sont|avec|pour|dans|sur|qui|que|quoi|où|quand|comment|pourquoi|oui|non|très|bien|bonjour)\b/.test(lowerText)) {
      return 'fr';
    }
    
    // German indicators
    if (/\b(der|die|das|ein|eine|und|ist|sind|mit|für|auf|zu|von|bei|nach|über|unter|haben|sein|werden|kann|muss|will|ich|du|er|sie|wir|ihr|guten|tag|ja|nein)\b/.test(lowerText)) {
      return 'de';
    }
    
    // Portuguese indicators
    if (/\b(o|a|os|as|um|uma|que|de|em|para|com|por|como|mas|muito|este|esta|isso|aqui|onde|quando|porque|também|pode|faz|tem|quero|olá|obrigado)\b/.test(lowerText)) {
      return 'pt';
    }
    
    // Italian indicators
    if (/\b(il|la|lo|i|gli|le|un|uno|una|che|di|in|per|con|come|ma|molto|questo|questa|qui|dove|quando|perché|anche|può|fa|ha|voglio|ciao|grazie)\b/.test(lowerText)) {
      return 'it';
    }
    
    // Default to English for Latin script
    return 'en';
  }

  /**
   * Update language history and determine if we should switch response language
   * Returns the language to use for responses
   */
  updateLanguageHistory(detectedLang) {
    // Add to history
    this.languageHistory.push(detectedLang);
    
    // Keep only last 3 entries
    if (this.languageHistory.length > 3) {
      this.languageHistory.shift();
    }
    
    console.log(`[RealtimeSpeech] Language detected: ${detectedLang}, history: [${this.languageHistory.join(', ')}]`);
    
    // Check if we should switch language
    const newLang = this.shouldSwitchLanguage(detectedLang);
    
    if (newLang !== this.currentResponseLanguage) {
      console.log(`[RealtimeSpeech] Switching response language: ${this.currentResponseLanguage} -> ${newLang}`);
      this.currentResponseLanguage = newLang;
    }
    
    return this.currentResponseLanguage;
  }

  /**
   * Determine if we should switch response language based on consistency
   * Only switches if the last N inputs are consistently in the same non-English language
   */
  shouldSwitchLanguage(detectedLang) {
    // Get the most recent entries based on threshold
    const recent = this.languageHistory.slice(-this.languageConsistencyThreshold);
    
    // Not enough history yet - stay with current
    if (recent.length < this.languageConsistencyThreshold) {
      return this.currentResponseLanguage;
    }
    
    // Check if all recent entries are the same language
    const allSame = recent.every(lang => lang === detectedLang);
    
    if (allSame) {
      // If consistently non-English, switch to that language
      // If consistently English, switch back to English
      return detectedLang;
    }
    
    // Mixed languages - stay with current
    return this.currentResponseLanguage;
  }

  /**
   * Reset language tracking (e.g., on new session)
   */
  resetLanguageTracking() {
    this.languageHistory = [];
    this.currentResponseLanguage = 'en';
    console.log('[RealtimeSpeech] Language tracking reset to English');
  }

  /**
   * Get API key from settings
   * Checks openaiApiKey first, then falls back to llmApiKey if provider is OpenAI
   */
  getApiKey() {
    if (this.apiKey) return this.apiKey;
    
    if (global.settingsManager) {
      // First try the dedicated OpenAI key
      const openaiKey = global.settingsManager.get('openaiApiKey');
      console.log('[RealtimeSpeech] openaiApiKey from settings:', openaiKey ? `${openaiKey.substring(0, 10)}...` : 'not set');
      
      if (openaiKey) {
        this.apiKey = openaiKey;
        console.log('[RealtimeSpeech] Using dedicated openaiApiKey');
        return this.apiKey;
      }
      
      // Fall back to LLM API key if provider is OpenAI
      const provider = global.settingsManager.get('llmProvider');
      const llmKey = global.settingsManager.get('llmApiKey');
      console.log('[RealtimeSpeech] llmProvider:', provider);
      console.log('[RealtimeSpeech] llmApiKey from settings:', llmKey ? `${llmKey.substring(0, 10)}...` : 'not set');
      
      if (llmKey && (!provider || provider === 'openai')) {
        this.apiKey = llmKey;
        console.log('[RealtimeSpeech] Using llmApiKey (provider is OpenAI)');
        return this.apiKey;
      }
      
      // If provider is not OpenAI but we have an llmApiKey, still try to use it
      // User might have OpenAI key in llmApiKey field even with different provider selected
      if (llmKey && llmKey.startsWith('sk-')) {
        this.apiKey = llmKey;
        console.log('[RealtimeSpeech] Using llmApiKey (starts with sk-)');
        return this.apiKey;
      }
      
      console.log('[RealtimeSpeech] No OpenAI API key found in settings');
    } else {
      console.log('[RealtimeSpeech] settingsManager not available');
    }
    
    return this.apiKey;
  }

  /**
   * Clear cached API key (call when settings change)
   */
  clearApiKey() {
    this.apiKey = null;
  }

  /**
   * Connect to OpenAI Realtime API
   */
  async connect() {
    // Always refresh API key from settings on connect
    this.apiKey = null;
    const apiKey = this.getApiKey();
    if (!apiKey) {
      const provider = global.settingsManager?.get('llmProvider');
      throw new Error(`OpenAI API key not found. Please add your OpenAI API key in Settings → LLM Settings (current provider: ${provider || 'not set'}). The key should start with 'sk-'.`);
    }

    if (this.ws && this.isConnected) {
      console.log('[RealtimeSpeech] Already connected');
      return true;
    }

    return new Promise((resolve, reject) => {
      try {
        // OpenAI Realtime API endpoint
        const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';
        
        console.log('[RealtimeSpeech] Connecting to OpenAI Realtime API...');
        
        this.ws = new WebSocket(url, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'OpenAI-Beta': 'realtime=v1'
          }
        });

        this.ws.on('open', () => {
          console.log('[RealtimeSpeech] Connected to OpenAI Realtime API');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          
          // Configure the session for transcription with English preference
          this.sendEvent({
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              instructions: 'Always respond in English unless the user has consistently spoken in another language for multiple turns. Default to English. Do not switch languages based on a single input that might be misheard.',
              input_audio_format: 'pcm16',
              input_audio_transcription: {
                model: 'whisper-1'
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.6,           // Slightly higher threshold to avoid background noise triggering
                prefix_padding_ms: 500,   // More padding before speech starts
                silence_duration_ms: 1200 // Wait 1.2 seconds of silence before ending turn
              }
            }
          });
          
          resolve(true);
        });

        this.ws.on('message', (data) => {
          try {
            const event = JSON.parse(data.toString());
            this.handleEvent(event);
          } catch (err) {
            console.error('[RealtimeSpeech] Error parsing message:', err);
          }
        });

        this.ws.on('error', (error) => {
          console.error('[RealtimeSpeech] WebSocket error:', error.message);
          this.isConnected = false;
          reject(error);
        });

        this.ws.on('close', (code, reason) => {
          console.log(`[RealtimeSpeech] Connection closed: ${code} - ${reason}`);
          this.isConnected = false;
          this.ws = null;
          
          // Notify subscribers of disconnection
          this.broadcast({ type: 'disconnected', code, reason: reason.toString() });
        });

      } catch (err) {
        console.error('[RealtimeSpeech] Connection error:', err);
        reject(err);
      }
    });
  }

  /**
   * Send event to OpenAI
   */
  sendEvent(event) {
    if (!this.ws || !this.isConnected) {
      console.warn('[RealtimeSpeech] Not connected, cannot send event');
      return false;
    }
    
    try {
      this.ws.send(JSON.stringify(event));
      return true;
    } catch (err) {
      console.error('[RealtimeSpeech] Error sending event:', err);
      return false;
    }
  }

  /**
   * Handle incoming events from OpenAI
   */
  handleEvent(event) {
    // console.log('[RealtimeSpeech] Event:', event.type);
    
    switch (event.type) {
      case 'session.created':
        this.sessionId = event.session?.id;
        console.log('[RealtimeSpeech] Session created:', this.sessionId);
        this.broadcast({ type: 'session_created', sessionId: this.sessionId });
        break;

      case 'session.updated':
        console.log('[RealtimeSpeech] Session updated');
        this.broadcast({ type: 'session_updated' });
        break;

      case 'input_audio_buffer.speech_started':
        console.log('[RealtimeSpeech] Speech started');
        // AUTO-CANCEL: When user starts speaking, cancel any in-progress AI response
        if (this.hasActiveResponse) {
          console.log('[RealtimeSpeech] Auto-cancelling response due to user speech');
          this.cancelResponse();
        }
        this.broadcast({ type: 'speech_started' });
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('[RealtimeSpeech] Speech stopped');
        this.broadcast({ type: 'speech_stopped' });
        break;

      case 'conversation.item.input_audio_transcription.delta':
        // Real-time partial transcription
        const partialText = event.delta;
        if (partialText) {
          this.broadcast({ type: 'transcript_delta', text: partialText, isFinal: false });
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        // Final transcription for this segment
        const finalText = event.transcript;
        if (finalText) {
          console.log('[RealtimeSpeech] Transcription:', finalText);
          
          
          // Detect and track language for consistency checking
          const detectedLang = this.detectLanguage(finalText);
          const responseLang = this.updateLanguageHistory(detectedLang);
          
          this.broadcast({ 
            type: 'transcript', 
            text: finalText, 
            isFinal: true,
            detectedLanguage: detectedLang,
            responseLanguage: responseLang
          });
        }
        break;

      case 'error':
        console.error('[RealtimeSpeech] API Error:', event.error);
        this.broadcast({ type: 'error', error: event.error });
        break;

      case 'rate_limits.updated':
        // Rate limit info, can ignore
        break;

      case 'response.audio.delta':
        // Audio chunk for TTS output - broadcast to renderer for playback
        if (event.delta) {
          this.broadcast({ type: 'audio_delta', audio: event.delta, responseId: event.response_id });
        }
        break;

      case 'response.audio.done':
        console.log('[RealtimeSpeech] Audio output complete');
        this.broadcast({ type: 'audio_done', responseId: event.response_id });
        break;

      case 'response.audio_transcript.delta':
        // What the AI is saying (text version)
        if (event.delta) {
          this.broadcast({ type: 'speech_text_delta', text: event.delta });
        }
        break;

      case 'response.audio_transcript.done':
        console.log('[RealtimeSpeech] Speech transcript:', event.transcript);
        this.broadcast({ type: 'speech_text', text: event.transcript });
        break;

      case 'response.cancelled':
        console.log('[RealtimeSpeech] Response cancelled');
        this.hasActiveResponse = false;
        // Resolve any pending cancel wait
        if (this._cancelResolver) {
          this._cancelResolver();
          this._cancelResolver = null;
        }
        this.broadcast({ type: 'response_cancelled' });
        break;

      case 'response.created':
        this.hasActiveResponse = true;
        this.activeResponseId = event.response?.id;
        break;

      case 'response.done':
        this.hasActiveResponse = false;
        this.activeResponseId = null;
        break;

      default:
        // Log unknown events for debugging
        if (!['response.output_item.added', 
              'response.output_item.done', 'response.content_part.added',
              'response.content_part.done'].includes(event.type)) {
          // console.log('[RealtimeSpeech] Unhandled event:', event.type);
        }
    }
  }

  /**
   * Send audio data to OpenAI
   * @param {string} base64Audio - Base64 encoded audio (PCM16, 24kHz, mono)
   */
  sendAudio(base64Audio) {
    if (!this.isConnected) {
      console.warn('[RealtimeSpeech] Not connected, buffering audio');
      this.audioBuffer.push(base64Audio);
      return false;
    }

    // Send any buffered audio first
    while (this.audioBuffer.length > 0) {
      const buffered = this.audioBuffer.shift();
      this.sendEvent({
        type: 'input_audio_buffer.append',
        audio: buffered
      });
    }

    // Send current audio
    return this.sendEvent({
      type: 'input_audio_buffer.append',
      audio: base64Audio
    });
  }

  /**
   * Commit the audio buffer (signal end of utterance)
   */
  commitAudio() {
    return this.sendEvent({
      type: 'input_audio_buffer.commit'
    });
  }

  /**
   * Clear the audio buffer
   */
  clearAudio() {
    this.audioBuffer = [];
    return this.sendEvent({
      type: 'input_audio_buffer.clear'
    });
  }

  /**
   * Speak text using OpenAI Realtime TTS
   * Sends a message and triggers audio response
   * @param {string} text - Text to speak
   * @returns {Promise<boolean>}
   */
  async speak(text) {
    if (!this.isConnected) {
      console.log('[RealtimeSpeech] speak: Not connected, connecting first...');
      try {
        await this.connect();
      } catch (err) {
        console.error('[RealtimeSpeech] speak: Failed to connect:', err);
        return false;
      }
    }
    
    // If there's an active response, cancel it and wait for confirmation
    if (this.hasActiveResponse) {
      console.log('[RealtimeSpeech] speak: Active response in progress, cancelling first...');
      await this.cancelResponseAndWait();
    }
    
    console.log('[RealtimeSpeech] Speaking:', text);
    
    // Create a conversation item with the text to speak
    const itemId = `speak_${Date.now()}`;
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        id: itemId,
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `Say exactly this: "${text}"` }]
      }
    });
    
    // Trigger the response (this will generate audio)
    // Use the tracked response language for consistency
    const langInstruction = this.currentResponseLanguage === 'en' 
      ? 'Respond in English.'
      : `Respond in ${this.getLanguageName(this.currentResponseLanguage)}.`;
    
    this.sendEvent({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions: `${langInstruction} Respond by saying exactly: "${text}". Do not add anything else.`
      }
    });
    
    return true;
  }
  
  /**
   * Cancel any in-progress response and wait for confirmation
   * @returns {Promise<boolean>}
   */
  async cancelResponseAndWait() {
    if (!this.hasActiveResponse) {
      return true; // Nothing to cancel
    }
    
    return new Promise((resolve) => {
      // Set up a one-time listener for the cancelled event
      const onCancelled = () => {
        console.log('[RealtimeSpeech] Response cancelled confirmation received');
        resolve(true);
      };
      
      // Store the resolver so handleEvent can call it
      this._cancelResolver = onCancelled;
      
      // Send the cancel
      this.cancelResponse();
      
      // Timeout after 500ms to prevent hanging
      setTimeout(() => {
        if (this._cancelResolver) {
          console.log('[RealtimeSpeech] Cancel timeout, proceeding anyway');
          this._cancelResolver = null;
          this.hasActiveResponse = false;
          resolve(true);
        }
      }, 500);
    });
  }

  /**
   * Cancel any in-progress response from OpenAI
   * Used when we want to handle a command locally without AI responding
   */
  cancelResponse() {
    if (!this.isConnected) {
      return false;
    }
    
    
    console.log('[RealtimeSpeech] Cancelling any in-progress response');
    this.hasActiveResponse = false;
    
    this.sendEvent({
      type: 'response.cancel'
    });
    
    return true;
  }

  /**
   * Get human-readable language name from code
   */
  getLanguageName(code) {
    const names = {
      en: 'English',
      es: 'Spanish',
      fr: 'French',
      de: 'German',
      pt: 'Portuguese',
      it: 'Italian',
      zh: 'Chinese',
      ja: 'Japanese',
      ko: 'Korean',
      ar: 'Arabic',
      ru: 'Russian',
      he: 'Hebrew',
      th: 'Thai',
      hi: 'Hindi'
    };
    return names[code] || 'English';
  }

  /**
   * Subscribe to transcription events
   */
  subscribe(webContentsId, callback) {
    this.subscribers.set(webContentsId, callback);
    console.log(`[RealtimeSpeech] Subscriber added: ${webContentsId}, total: ${this.subscribers.size}`);
  }

  /**
   * Unsubscribe from events
   */
  unsubscribe(webContentsId) {
    this.subscribers.delete(webContentsId);
    console.log(`[RealtimeSpeech] Subscriber removed: ${webContentsId}, total: ${this.subscribers.size}`);
    
    // Disconnect if no subscribers
    if (this.subscribers.size === 0) {
      this.disconnect();
    }
  }

  /**
   * Broadcast event to all subscribers
   */
  broadcast(event) {
    this.subscribers.forEach((callback, id) => {
      try {
        callback(event);
      } catch (err) {
        console.error(`[RealtimeSpeech] Error broadcasting to ${id}:`, err);
      }
    });
  }

  /**
   * Disconnect from OpenAI
   */
  disconnect() {
    if (this.ws) {
      console.log('[RealtimeSpeech] Disconnecting...');
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.sessionId = null;
    this.audioBuffer = [];
    
    // Reset language tracking on disconnect
    this.resetLanguageTracking();
  }

  /**
   * Set up IPC handlers for renderer communication
   */
  setupIPC() {
    // Start a realtime session
    ipcMain.handle('realtime-speech:connect', async (event) => {
      try {
        await this.connect();
        
        // Subscribe this webContents to receive events
        const webContentsId = event.sender.id;
        this.subscribe(webContentsId, (speechEvent) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('realtime-speech:event', speechEvent);
          }
        });
        
        return { success: true, sessionId: this.sessionId };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    // Send audio chunk
    ipcMain.handle('realtime-speech:send-audio', async (event, base64Audio) => {
      return this.sendAudio(base64Audio);
    });

    // Commit audio (end of utterance)
    ipcMain.handle('realtime-speech:commit', async () => {
      return this.commitAudio();
    });

    // Clear audio buffer
    ipcMain.handle('realtime-speech:clear', async () => {
      return this.clearAudio();
    });

    // Disconnect
    ipcMain.handle('realtime-speech:disconnect', async (event) => {
      const webContentsId = event.sender.id;
      this.unsubscribe(webContentsId);
      return { success: true };
    });

    // Check if connected
    ipcMain.handle('realtime-speech:is-connected', async () => {
      return {
        connected: this.isConnected,
        sessionId: this.sessionId,
        hasApiKey: !!this.getApiKey()
      };
    });

    // Speak text using OpenAI Realtime TTS
    ipcMain.handle('realtime-speech:speak', async (event, text) => {
      try {
        // Subscribe if not already
        const webContentsId = event.sender.id;
        if (!this.subscribers.has(webContentsId)) {
          this.subscribe(webContentsId, (speechEvent) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send('realtime-speech:event', speechEvent);
            }
          });
        }
        
        const result = await this.speak(text);
        return { success: result };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    // Cancel any in-progress response (used when handling commands locally)
    ipcMain.handle('realtime-speech:cancel-response', async () => {
      return { success: this.cancelResponse() };
    });

    console.log('[RealtimeSpeech] IPC handlers registered');
  }
}

// Singleton instance
let instance = null;

function getRealtimeSpeech() {
  if (!instance) {
    instance = new RealtimeSpeech();
  }
  return instance;
}

module.exports = { RealtimeSpeech, getRealtimeSpeech };





































