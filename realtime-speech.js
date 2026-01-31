/**
 * OpenAI Realtime API - Streaming Speech-to-Text
 * 
 * Uses WebSocket connection to OpenAI's Realtime API for low-latency
 * real-time transcription as you speak.
 * 
 * Includes speech queue to prevent overlapping audio responses.
 */

const WebSocket = require('ws');
const { ipcMain } = require('electron');
const { getSpeechQueue, PRIORITY } = require('./src/voice-task-sdk/audio/speechQueue');
const { getBudgetManager } = require('./budget-manager');

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
    
    // Speech queue for preventing overlapping audio
    this.speechQueue = getSpeechQueue();
    this.speechQueue.setSpeakFunction((text) => this._doSpeak(text));
    this.speechQueue.setCancelFunction(() => this._doCancel());
    
    // Language consistency tracking
    this.languageHistory = [];  // Last 3 detected languages
    this.currentResponseLanguage = 'en';  // Default to English
    this.languageConsistencyThreshold = 2;  // Need 2 consecutive same-language inputs to switch
    
    // Track sanctioned responses (ones we create) vs unwanted direct AI responses
    this.sanctionedResponseIds = new Set();
    this.pendingResponseCreate = false; // Flag when we're about to create a response
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
          
          // Configure the session with FUNCTION CALLING
          // This ensures the AI never responds directly - it always calls our function
          // which gives us full control over what gets said (Concierge pattern)
          this.sendEvent({
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              instructions: `You are a voice command router that MUST use tools for every input.

CRITICAL RULES:
1. ALWAYS call handle_user_request for EVERY user input - no exceptions
2. NEVER respond directly to the user - only use functions
3. NEVER say "I can't" or "I'm sorry" - the function will handle everything
4. You can play music, control apps, set timers - the function handles it all
5. After receiving function results, speak exactly what is returned

Your ONLY job is to route requests to handle_user_request and speak the results.`,
              input_audio_format: 'pcm16',
              input_audio_transcription: {
                model: 'whisper-1'
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.6,
                prefix_padding_ms: 500,
                silence_duration_ms: 1200
              },
              // FUNCTION CALLING: Route all input through our handler
              tools: [{
                type: 'function',
                name: 'handle_user_request',
                description: 'REQUIRED: Process ALL user requests. This function handles everything - music playback, timers, questions, commands, and more. The system has full capability through this function. Always call this, never respond directly.',
                parameters: {
                  type: 'object',
                  properties: {
                    transcript: {
                      type: 'string',
                      description: 'The exact text of what the user said'
                    },
                    intent: {
                      type: 'string',
                      description: 'The detected intent: question, command, statement, or unclear'
                    }
                  },
                  required: ['transcript']
                }
              }],
              tool_choice: 'required'  // Force function call on every input
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
        // AUTO-CANCEL: When user starts speaking, cancel any in-progress AI response AND queue
        if (this.hasActiveResponse || this.speechQueue.isSpeaking) {
          console.log('[RealtimeSpeech] Auto-cancelling response due to user speech');
          this.cancelResponse(true);  // true = also cancel queue
          this.broadcast({ type: 'clear_audio_buffer' });
        }
        this.broadcast({ type: 'speech_started' });
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('[RealtimeSpeech] Speech stopped');
        // With function calling, AI will call our function instead of responding directly
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
          
          
          // Language detection disabled - always use English to prevent confusion
          // (Auto-switching was causing issues with misdetected languages)
          this.broadcast({ 
            type: 'transcript', 
            text: finalText, 
            isFinal: true,
            detectedLanguage: 'en',
            responseLanguage: 'en'
          });
        }
        break;

      case 'error':
        // FIX: Handle "no active response" error gracefully - this is benign
        // It means the response already finished before we tried to cancel
        if (event.error?.code === 'response_cancel_not_active') {
          console.log('[RealtimeSpeech] Cancel failed (no active response) - treating as success');
          this.hasActiveResponse = false;
          // Resolve any pending cancel wait
          if (this._cancelResolver) {
            this._cancelResolver();
            this._cancelResolver = null;
          }
          break; // Don't broadcast this as an error
        }
        
        console.error('[RealtimeSpeech] API Error:', event.error);
        this.broadcast({ type: 'error', error: event.error });
        break;

      case 'rate_limits.updated':
        // Rate limit info, can ignore
        break;

      case 'response.audio.delta':
        // Audio chunk for TTS output - broadcast to renderer for playback
        // Only forward audio from sanctioned responses (ones we created)
        if (event.delta) {
          if (this.sanctionedResponseIds.has(event.response_id)) {
            this.broadcast({ type: 'audio_delta', audio: event.delta, responseId: event.response_id });
          } else {
            // Silently drop audio from unsanctioned responses
            // This prevents the AI from speaking when it bypasses function calling
          }
        }
        break;

      case 'response.audio.done':
        console.log('[RealtimeSpeech] Audio output complete');
        this.broadcast({ type: 'audio_done', responseId: event.response_id });
        
        // Mark speech as complete in the queue
        this.speechQueue.markComplete();
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
        
        // Check if this is a sanctioned response (one we created)
        if (this.pendingResponseCreate) {
          // We created this response - mark it as sanctioned
          this.sanctionedResponseIds.add(event.response?.id);
          this.pendingResponseCreate = false;
          console.log('[RealtimeSpeech] Sanctioned response created:', event.response?.id);
        } else {
          // Unsanctioned direct response from AI - cancel it immediately
          console.warn('[RealtimeSpeech] Cancelling unsanctioned direct AI response:', event.response?.id);
          this.sendEvent({ type: 'response.cancel' });
        }
        break;

      case 'response.done':
        this.hasActiveResponse = false;
        // Clean up sanctioned response tracking
        if (event.response?.id) {
          this.sanctionedResponseIds.delete(event.response.id);
        }
        this.activeResponseId = null;
        
        // Track API usage for cost monitoring
        if (event.response?.usage) {
          try {
            const usage = event.response.usage;
            const budgetManager = getBudgetManager();
            budgetManager.trackUsage({
              provider: 'openai',
              model: 'gpt-4o-realtime-preview',
              inputTokens: usage.input_tokens || 0,
              outputTokens: usage.output_tokens || 0,
              feature: 'realtime-voice',
              operation: 'voice-response',
              projectId: null,
              // Additional details for realtime API
              metadata: {
                totalTokens: usage.total_tokens,
                inputDetails: usage.input_token_details,
                outputDetails: usage.output_token_details
              }
            });
            console.log(`[RealtimeSpeech] Tracked usage: ${usage.input_tokens} in, ${usage.output_tokens} out`);
          } catch (trackError) {
            console.warn('[RealtimeSpeech] Failed to track usage:', trackError.message);
          }
        }
        break;
      
      // FUNCTION CALLING: Handle our handle_user_request function
      case 'response.function_call_arguments.done':
        console.log('[RealtimeSpeech] Function call complete:', event.name);
        
        if (event.name === 'handle_user_request') {
          try {
            const args = JSON.parse(event.arguments);
            const transcript = args.transcript;
            
            console.log('[RealtimeSpeech] Processing user request:', transcript);
            
            // Broadcast the transcript for processing
            // The exchange-bridge will handle it and call back with the result
            this.pendingFunctionCallId = event.call_id;
            this.pendingFunctionItemId = event.item_id;
            
            // Broadcast to trigger our agent processing
            this.broadcast({ 
              type: 'function_call_transcript', 
              transcript: transcript,
              callId: event.call_id,
              itemId: event.item_id
            });
          } catch (err) {
            console.error('[RealtimeSpeech] Error parsing function arguments:', err);
          }
        }
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
   * Speak text using OpenAI Realtime TTS (queued)
   * Uses speech queue to prevent overlapping audio
   * @param {string} text - Text to speak
   * @param {Object} options - { priority }
   * @returns {Promise<boolean>}
   */
  async speak(text, options = {}) {
    // Use speech queue to prevent overlapping
    return this.speechQueue.enqueue(text, {
      priority: options.priority ?? PRIORITY.NORMAL,
      metadata: options.metadata
    });
  }
  
  /**
   * Internal: Actually speak text (called by speech queue)
   * @private
   */
  async _doSpeak(text) {
    // CRITICAL: Ensure orb window is subscribed for audio playback
    this._ensureOrbSubscribed();
    
    if (!this.isConnected) {
      console.log('[RealtimeSpeech] _doSpeak: Not connected, connecting first...');
      try {
        await this.connect();
      } catch (err) {
        console.error('[RealtimeSpeech] _doSpeak: Failed to connect:', err);
        return false;
      }
    }
    
    // If there's an active response, cancel it and wait for confirmation
    if (this.hasActiveResponse) {
      console.log('[RealtimeSpeech] _doSpeak: Active response in progress, cancelling first...');
      
      // Broadcast to clear audio buffer IMMEDIATELY before cancel completes
      this.broadcast({ type: 'clear_audio_buffer' });
      
      await this.cancelResponseAndWait();
    }
    
    console.log('[RealtimeSpeech] Speaking:', text);
    
    // Use response.create to speak the text directly
    // ALWAYS use English - disable language auto-switching to prevent confusion
    const langInstruction = 'You MUST respond in English only.';
    
    // Reset language tracking to prevent drift
    this.currentResponseLanguage = 'en';
    
    // Mark this as a sanctioned response
    this.pendingResponseCreate = true;
    
    // Create a response that will generate audio
    this.sendEvent({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions: `${langInstruction} Say ONLY this to the user: "${text}"`,
        tool_choice: 'none'  // CRITICAL: Disable function calls so AI speaks directly
      }
    });
    
    console.log('[RealtimeSpeech] Sent response.create for text:', text.slice(0, 50));
    
    return true;
  }
  
  /**
   * Internal: Cancel current speech (called by speech queue)
   * @private
   */
  async _doCancel() {
    await this.cancelResponseAndWait();
  }
  
  /**
   * Respond to a function call with our agent's result
   * This is the key to the Concierge pattern - we provide the answer, AI speaks it
   * @param {string} callId - The function call ID
   * @param {string} result - The result text to speak
   */
  respondToFunctionCall(callId, result) {
    if (!this.isConnected) {
      console.error('[RealtimeSpeech] Cannot respond to function call - not connected');
      return false;
    }
    
    console.log('[RealtimeSpeech] Responding to function call:', callId, 'with:', result?.slice?.(0, 50) || result);
    
    // ALWAYS create the function call output first (required by OpenAI)
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({ response: result || '' })
      }
    });
    
    // If result is empty, don't create a response - just acknowledge the function call
    // This is used for async tasks where the actual response comes later via speak()
    if (!result || result.trim() === '') {
      console.log('[RealtimeSpeech] Empty result, skipping response.create (async task acknowledgment)');
      return true;
    }
    
    // If already speaking or something in queue, queue this response
    // This prevents "conversation_already_has_active_response" errors
    if (this.speechQueue.isSpeaking || this.speechQueue.queue.length > 0 || this.hasActiveResponse) {
      console.log('[RealtimeSpeech] Queue active or response in progress, queueing function response');
      this.speechQueue.enqueue(result, { 
        priority: PRIORITY.HIGH,
        metadata: { callId, type: 'function_response' }
      });
      return true;
    }
    
    // Otherwise, directly create the response (more immediate)
    // Mark this as a sanctioned response
    this.pendingResponseCreate = true;
    this.sendEvent({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions: `Speak exactly this response to the user: "${result}". Do not add anything else.`,
        tool_choice: 'none'
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
   * @param {boolean} cancelQueue - Also cancel all pending speech in queue
   */
  cancelResponse(cancelQueue = false) {
    if (cancelQueue) {
      // Cancel all pending speech as well
      this.speechQueue.cancelAll();
    }
    
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
    
    // Disconnect if no subscribers AND no active/pending speech
    if (this.subscribers.size === 0) {
      // Check if there's active speech or pending speech in queue
      // Use this.speechQueue which is already loaded
      const hasPendingSpeech = this.speechQueue && this.speechQueue.hasPendingOrActiveSpeech();
      
      if (this.hasActiveResponse || hasPendingSpeech) {
        console.log('[RealtimeSpeech] Skipping disconnect - active/pending speech');
        return;
      }
      
      this.disconnect();
    }
  }
  
  /**
   * Ensure orb window is subscribed for audio playback
   * Called before speaking to make sure audio will be received
   */
  _ensureOrbSubscribed() {
    try {
      const { BrowserWindow } = require('electron');
      const windows = BrowserWindow.getAllWindows();
      
      const orbWindow = windows.find(w => {
        try {
          const url = w.webContents?.getURL() || '';
          return url.includes('orb.html');
        } catch { return false; }
      });
      
      if (orbWindow && !orbWindow.isDestroyed()) {
        const orbId = orbWindow.webContents.id;
        
        // Only subscribe if not already subscribed
        if (!this.subscribers.has(orbId)) {
          console.log(`[RealtimeSpeech] Auto-subscribing orb window (id: ${orbId})`);
          
          this.subscribe(orbId, (speechEvent) => {
            if (!orbWindow.isDestroyed()) {
              orbWindow.webContents.send('realtime-speech:event', speechEvent);
            }
          });
        }
      }
    } catch (err) {
      console.warn('[RealtimeSpeech] Error ensuring orb subscribed:', err.message);
    }
  }

  /**
   * Broadcast event to all subscribers
   * Also sends directly to orb window for audio events if no subscribers
   */
  broadcast(event) {
    // Send to all registered subscribers
    this.subscribers.forEach((callback, id) => {
      try {
        callback(event);
      } catch (err) {
        console.error(`[RealtimeSpeech] Error broadcasting to ${id}:`, err);
      }
    });
    
    // CRITICAL FIX: For audio events, send directly to orb window if no subscribers
    // This handles the case where exchange-bridge speaks but orb has disconnected
    if (this.subscribers.size === 0 && (event.type === 'audio_delta' || event.type === 'audio_done' || event.type === 'clear_audio_buffer')) {
      try {
        const { BrowserWindow } = require('electron');
        const windows = BrowserWindow.getAllWindows();
        
        console.log(`[RealtimeSpeech] No subscribers, sending ${event.type} to all ${windows.length} windows`);
        
        // Send to ALL windows - let them filter
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
        console.error('[RealtimeSpeech] Error sending to windows:', err.message);
      }
    }
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
    
    // Clear sanctioned response tracking
    this.sanctionedResponseIds.clear();
    this.pendingResponseCreate = false;
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
    ipcMain.handle('realtime-speech:cancel-response', async (event, cancelQueue = false) => {
      return { success: this.cancelResponse(cancelQueue) };
    });
    
    // Cancel all pending speech in queue
    ipcMain.handle('realtime-speech:cancel-all', async () => {
      await this.speechQueue.cancelAll();
      return { success: true };
    });
    
    // Get speech queue status
    ipcMain.handle('realtime-speech:queue-status', async () => {
      return this.speechQueue.getStatus();
    });
    
    // Respond to a function call with our agent's result
    ipcMain.handle('realtime-speech:respond-to-function', async (event, callId, result) => {
      try {
        const success = this.respondToFunctionCall(callId, result);
        return { success };
      } catch (err) {
        return { success: false, error: err.message };
      }
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

module.exports = { RealtimeSpeech, getRealtimeSpeech, PRIORITY };





































