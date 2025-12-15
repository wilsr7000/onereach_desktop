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
  }

  /**
   * Get API key from settings
   */
  getApiKey() {
    if (this.apiKey) return this.apiKey;
    if (global.settingsManager) {
      this.apiKey = global.settingsManager.get('openaiApiKey');
    }
    return this.apiKey;
  }

  /**
   * Connect to OpenAI Realtime API
   */
  async connect() {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('OpenAI API key not configured');
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
          
          // Configure the session for transcription
          this.sendEvent({
            type: 'session.update',
            session: {
              modalities: ['text', 'audio'],
              input_audio_format: 'pcm16',
              input_audio_transcription: {
                model: 'whisper-1'
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500
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
          this.broadcast({ type: 'transcript', text: finalText, isFinal: true });
        }
        break;

      case 'error':
        console.error('[RealtimeSpeech] API Error:', event.error);
        this.broadcast({ type: 'error', error: event.error });
        break;

      case 'rate_limits.updated':
        // Rate limit info, can ignore
        break;

      default:
        // Log unknown events for debugging
        if (!['response.created', 'response.done', 'response.output_item.added', 
              'response.output_item.done', 'response.content_part.added',
              'response.content_part.done', 'response.audio.delta',
              'response.audio.done', 'response.audio_transcript.delta',
              'response.audio_transcript.done'].includes(event.type)) {
          console.log('[RealtimeSpeech] Unhandled event:', event.type);
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
