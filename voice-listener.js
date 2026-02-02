/**
 * Voice Listener - Speech-to-Text via OpenAI Realtime API
 * 
 * Handles:
 * - WebSocket connection to OpenAI Realtime API
 * - Real-time transcription (speech-to-text)
 * - Voice Activity Detection (VAD)
 * - Function call routing to agents
 * 
 * Does NOT handle TTS (use voice-speaker.js for that)
 */

const WebSocket = require('ws');
const { ipcMain, BrowserWindow } = require('electron');
const { getBudgetManager } = require('./budget-manager');

class VoiceListener {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.sessionId = null;
    this.apiKey = null;
    this.subscribers = new Map();
    this.audioBuffer = [];
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    
    // Track responses to prevent unwanted AI speech
    this.sanctionedResponseIds = new Set();
    this.pendingResponseCreate = false;
    this.hasActiveResponse = false;
    this.activeResponseId = null;
    
    // Pending function call tracking
    this.pendingFunctionCallId = null;
    this.pendingFunctionItemId = null;
    
    console.log('[VoiceListener] Initialized');
  }

  /**
   * Get OpenAI API key from settings
   */
  getApiKey() {
    if (this.apiKey) return this.apiKey;
    
    if (global.settingsManager) {
      const openaiKey = global.settingsManager.get('openaiApiKey');
      if (openaiKey) {
        this.apiKey = openaiKey;
        return this.apiKey;
      }
      
      const provider = global.settingsManager.get('llmProvider');
      const llmKey = global.settingsManager.get('llmApiKey');
      
      if (llmKey && (!provider || provider === 'openai')) {
        this.apiKey = llmKey;
        return this.apiKey;
      }
      
      if (llmKey && llmKey.startsWith('sk-')) {
        this.apiKey = llmKey;
        return this.apiKey;
      }
    }
    
    return null;
  }

  /**
   * Clear cached API key
   */
  clearApiKey() {
    this.apiKey = null;
  }

  /**
   * Connect to OpenAI Realtime API
   */
  async connect() {
    this.apiKey = null;  // Refresh from settings
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('OpenAI API key not found');
    }

    if (this.ws && this.isConnected) {
      console.log('[VoiceListener] Already connected');
      return true;
    }

    return new Promise((resolve, reject) => {
      try {
        const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';
        
        console.log('[VoiceListener] Connecting to OpenAI Realtime API...');
        
        this.ws = new WebSocket(url, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'OpenAI-Beta': 'realtime=v1'
          }
        });

        this.ws.on('open', () => {
          console.log('[VoiceListener] Connected');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          
          // Configure session for transcription with function calling
          this.sendEvent({
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              instructions: `You are a voice command router. Your ONLY job is to call the handle_user_request function.
ABSOLUTE RULES - NO EXCEPTIONS:
1. IMMEDIATELY call handle_user_request for EVERY input
2. NEVER speak directly - the function provides ALL responses
3. Do NOT ask clarifying questions - just pass the transcript to the function`,
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
              tools: [{
                type: 'function',
                name: 'handle_user_request',
                description: 'REQUIRED: Process ALL user requests.',
                parameters: {
                  type: 'object',
                  properties: {
                    transcript: {
                      type: 'string',
                      description: 'The exact text of what the user said'
                    }
                  },
                  required: ['transcript']
                }
              }],
              tool_choice: 'required'
            }
          });
          
          resolve(true);
        });

        this.ws.on('message', (data) => {
          try {
            const event = JSON.parse(data.toString());
            this.handleEvent(event);
          } catch (err) {
            console.error('[VoiceListener] Error parsing message:', err);
          }
        });

        this.ws.on('error', (error) => {
          console.error('[VoiceListener] WebSocket error:', error.message);
          this.isConnected = false;
          reject(error);
        });

        this.ws.on('close', (code, reason) => {
          console.log(`[VoiceListener] Connection closed: ${code}`);
          this.isConnected = false;
          this.ws = null;
          this.broadcast({ type: 'disconnected', code });
        });

      } catch (err) {
        console.error('[VoiceListener] Connection error:', err);
        reject(err);
      }
    });
  }

  /**
   * Send event to OpenAI
   */
  sendEvent(event) {
    if (!this.ws || !this.isConnected) {
      console.warn('[VoiceListener] Not connected');
      return false;
    }
    
    try {
      this.ws.send(JSON.stringify(event));
      return true;
    } catch (err) {
      console.error('[VoiceListener] Error sending event:', err);
      return false;
    }
  }

  /**
   * Handle incoming events from OpenAI
   */
  handleEvent(event) {
    switch (event.type) {
      case 'session.created':
        this.sessionId = event.session?.id;
        console.log('[VoiceListener] Session created:', this.sessionId);
        this.broadcast({ type: 'session_created', sessionId: this.sessionId });
        break;

      case 'session.updated':
        console.log('[VoiceListener] Session updated');
        this.broadcast({ type: 'session_updated' });
        break;

      case 'input_audio_buffer.speech_started':
        console.log('[VoiceListener] Speech started');
        this.broadcast({ type: 'speech_started' });
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('[VoiceListener] Speech stopped');
        this.broadcast({ type: 'speech_stopped' });
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (event.delta) {
          this.broadcast({ type: 'transcript_delta', text: event.delta, isFinal: false });
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          console.log('[VoiceListener] Transcription:', event.transcript);
          this.broadcast({ 
            type: 'transcript', 
            text: event.transcript, 
            isFinal: true
          });
        }
        break;

      case 'error':
        if (event.error?.code === 'response_cancel_not_active') {
          console.log('[VoiceListener] Cancel failed (no active response)');
          this.hasActiveResponse = false;
          break;
        }
        console.error('[VoiceListener] API Error:', event.error);
        this.broadcast({ type: 'error', error: event.error });
        break;

      case 'response.created':
        this.hasActiveResponse = true;
        this.activeResponseId = event.response?.id;
        
        // DON'T cancel auto-triggered responses - they need to call our function
        // The Realtime API creates responses automatically when user stops speaking
        // With tool_choice: "required", these responses will call handle_user_request
        // We only track sanctioned responses for explicit speak requests
        if (this.pendingResponseCreate) {
          this.sanctionedResponseIds.add(event.response?.id);
          this.pendingResponseCreate = false;
        }
        // Note: We no longer cancel unsanctioned responses here because that
        // prevents the function call from happening. Audio blocking happens
        // in response.audio.delta if needed.
        console.log('[VoiceListener] Response created:', event.response?.id);
        break;

      case 'response.done':
        this.hasActiveResponse = false;
        if (event.response?.id) {
          this.sanctionedResponseIds.delete(event.response.id);
        }
        this.activeResponseId = null;
        
        // Track API usage
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
              operation: 'voice-transcription'
            });
          } catch (e) {
            console.warn('[VoiceListener] Failed to track usage:', e.message);
          }
        }
        break;

      case 'response.cancelled':
        console.log('[VoiceListener] Response cancelled');
        this.hasActiveResponse = false;
        this.broadcast({ type: 'response_cancelled' });
        break;

      case 'response.audio.delta':
        // Block any audio from the Realtime API - we use voice-speaker.js for TTS
        // With tool_choice: "required", this shouldn't happen, but just in case
        if (!this.sanctionedResponseIds.has(event.response_id)) {
          // Silently drop - don't forward audio
          console.log('[VoiceListener] Blocking unsanctioned audio');
        }
        break;

      case 'response.audio_transcript.delta':
        // Also block audio transcripts from unsanctioned responses
        if (!this.sanctionedResponseIds.has(event.response_id)) {
          // Silently drop
        }
        break;

      case 'response.function_call_arguments.done':
        console.log('[VoiceListener] Function call:', event.name);
        
        if (event.name === 'handle_user_request') {
          try {
            const args = JSON.parse(event.arguments);
            const transcript = args.transcript;
            
            console.log('[VoiceListener] User request:', transcript);
            
            this.pendingFunctionCallId = event.call_id;
            this.pendingFunctionItemId = event.item_id;
            
            // Broadcast for agent processing
            this.broadcast({ 
              type: 'function_call_transcript', 
              transcript: transcript,
              callId: event.call_id,
              itemId: event.item_id
            });
          } catch (err) {
            console.error('[VoiceListener] Error parsing function arguments:', err);
          }
        }
        break;
    }
  }

  /**
   * Send audio data to OpenAI
   */
  sendAudio(base64Audio) {
    if (!this.isConnected) {
      this.audioBuffer.push(base64Audio);
      return false;
    }

    while (this.audioBuffer.length > 0) {
      const buffered = this.audioBuffer.shift();
      this.sendEvent({
        type: 'input_audio_buffer.append',
        audio: buffered
      });
    }

    return this.sendEvent({
      type: 'input_audio_buffer.append',
      audio: base64Audio
    });
  }

  /**
   * Commit the audio buffer
   */
  commitAudio() {
    return this.sendEvent({ type: 'input_audio_buffer.commit' });
  }

  /**
   * Clear the audio buffer
   */
  clearAudio() {
    this.audioBuffer = [];
    return this.sendEvent({ type: 'input_audio_buffer.clear' });
  }

  /**
   * Respond to a function call (acknowledges the call to OpenAI)
   */
  respondToFunctionCall(callId, result = '') {
    if (!this.isConnected) {
      console.error('[VoiceListener] Cannot respond - not connected');
      return false;
    }
    
    console.log('[VoiceListener] Responding to function call:', callId);
    
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({ response: result || '', handled: true })
      }
    });
    
    return true;
  }

  /**
   * Cancel any active response
   */
  cancelResponse() {
    if (!this.isConnected) return false;
    
    console.log('[VoiceListener] Cancelling response');
    this.hasActiveResponse = false;
    this.sendEvent({ type: 'response.cancel' });
    return true;
  }

  /**
   * Subscribe to listener events
   */
  subscribe(webContentsId, callback) {
    this.subscribers.set(webContentsId, callback);
    console.log(`[VoiceListener] Subscriber added: ${webContentsId}`);
  }

  /**
   * Unsubscribe
   */
  unsubscribe(webContentsId) {
    this.subscribers.delete(webContentsId);
    console.log(`[VoiceListener] Subscriber removed: ${webContentsId}`);
    
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
        console.error(`[VoiceListener] Error broadcasting to ${id}:`, err);
      }
    });
  }

  /**
   * Disconnect from OpenAI
   */
  disconnect() {
    if (this.ws) {
      console.log('[VoiceListener] Disconnecting...');
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.sessionId = null;
    this.audioBuffer = [];
    this.sanctionedResponseIds.clear();
  }

  /**
   * Set up IPC handlers
   */
  setupIPC() {
    ipcMain.handle('voice-listener:connect', async (event) => {
      try {
        await this.connect();
        
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

    ipcMain.handle('voice-listener:send-audio', async (event, base64Audio) => {
      return this.sendAudio(base64Audio);
    });

    ipcMain.handle('voice-listener:commit', async () => {
      return this.commitAudio();
    });

    ipcMain.handle('voice-listener:clear', async () => {
      return this.clearAudio();
    });

    ipcMain.handle('voice-listener:disconnect', async (event) => {
      this.unsubscribe(event.sender.id);
      return { success: true };
    });

    ipcMain.handle('voice-listener:is-connected', async () => {
      return {
        connected: this.isConnected,
        sessionId: this.sessionId,
        hasApiKey: !!this.getApiKey()
      };
    });

    ipcMain.handle('voice-listener:cancel-response', async () => {
      return { success: this.cancelResponse() };
    });

    ipcMain.handle('voice-listener:respond-to-function', async (event, callId, result) => {
      try {
        const success = this.respondToFunctionCall(callId, result);
        return { success };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    console.log('[VoiceListener] IPC handlers registered');
  }
}

// Singleton
let instance = null;

function getVoiceListener() {
  if (!instance) {
    instance = new VoiceListener();
  }
  return instance;
}

module.exports = { VoiceListener, getVoiceListener };
