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

const { ipcMain, _BrowserWindow } = require('electron');
const { getBudgetManager } = require('./budget-manager');
const { getAIService } = require('./lib/ai-service');
const hudApi = require('./lib/hud-api');
const { getTranscriptService } = require('./lib/transcript-service');
const { getLogQueue } = require('./lib/log-event-queue');
const log = getLogQueue();

class VoiceListener {
  constructor() {
    this.ws = null;
    this.session = null;
    this.isConnected = false;
    this.sessionId = null;
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

    log.info('voice', 'Initialized');
  }

  /**
   * Connect to OpenAI Realtime API
   */
  async connect() {
    // #region agent log
    this._connectSeq = (this._connectSeq || 0) + 1;
    const _cSeq = this._connectSeq;
    fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: 'voice-listener.js:connect',
        message: 'connect() called',
        data: {
          seq: _cSeq,
          hasWs: !!this.ws,
          isConnected: this.isConnected,
          sessionId: this.sessionId,
          subscriberCount: this.subscribers.size,
        },
        timestamp: Date.now(),
        sessionId: 'debug-session',
        hypothesisId: 'H-RACE',
      }),
    }).catch((err) => console.warn('[voice-listener] connect agent-log:', err.message));
    // #endregion

    if (this.ws && this.isConnected) {
      log.info('voice', 'Already connected');
      return true;
    }

    return new Promise((resolve, reject) => {
      try {
        log.info('voice', 'Connecting to OpenAI Realtime API...');

        const session = getAIService().realtime({
          onMessage: (event) => this.handleEvent(event),
          onError: (error) => {
            log.error('voice', 'WebSocket error', { error: error.message });
            this.isConnected = false;
            reject(error);
          },
          onClose: (code, _reason) => {
            log.info('voice', 'Connection closed: ...', { code });
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                location: 'voice-listener.js:ws-close',
                message: 'WebSocket close event fired',
                data: {
                  seq: _cSeq,
                  code,
                  currentConnectSeq: this._connectSeq,
                  wasConnected: this.isConnected,
                  hadWs: !!this.ws,
                  subscriberCount: this.subscribers.size,
                },
                timestamp: Date.now(),
                sessionId: 'debug-session',
                hypothesisId: 'H-RACE',
              }),
            }).catch((err) => console.warn('[voice-listener] ws-close agent-log:', err.message));
            // #endregion
            this.isConnected = false;
            this.ws = null;
            this.session = null;

            // Attempt reconnection for unexpected closures (not user-initiated)
            // Code 1000 = normal close, 1005 = no status (server timeout)
            const isUserInitiated = code === 1000;
            const hasSubscribers = this.subscribers.size > 0;

            if (!isUserInitiated && hasSubscribers && this.reconnectAttempts < this.maxReconnectAttempts) {
              this.reconnectAttempts++;
              const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 8000); // 1s, 2s, 4s
              log.info(
                'voice',
                `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
              );
              this.broadcast({ type: 'reconnecting', attempt: this.reconnectAttempts, delay });

              setTimeout(async () => {
                if (this.subscribers.size === 0) {
                  log.info('voice', 'Reconnect cancelled - no subscribers');
                  return;
                }
                try {
                  await this.connect();
                  log.info('voice', 'Reconnected successfully');
                  this.broadcast({ type: 'reconnected' });
                } catch (err) {
                  log.error('voice', 'Reconnect failed', { error: err.message, attempt: this.reconnectAttempts });
                  // If all attempts exhausted, notify subscribers to reset
                  if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                    log.warn('voice', 'Max reconnect attempts reached - giving up');
                    this.broadcast({ type: 'disconnected', code, permanent: true });
                  }
                }
              }, delay);
            } else {
              this.broadcast({ type: 'disconnected', code });
            }
          },
        });

        this.ws = session.ws;
        this.session = session;

        // Register open handler BEFORE connection completes (WebSocket may connect immediately)
        this.ws.on('open', () => {
          log.info('voice', 'Connected');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              location: 'voice-listener.js:ws-open',
              message: 'WebSocket opened',
              data: { seq: _cSeq, wsIdentity: this.ws?._debugId || 'unknown' },
              timestamp: Date.now(),
              sessionId: 'debug-session',
              hypothesisId: 'H-RACE',
            }),
          }).catch((err) => console.warn('[voice-listener] ws-open agent-log:', err.message));
          // #endregion

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
                model: 'whisper-1',
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.6,
                prefix_padding_ms: 500,
                silence_duration_ms: 1200,
              },
              tools: [
                {
                  type: 'function',
                  name: 'handle_user_request',
                  description: 'REQUIRED: Process ALL user requests.',
                  parameters: {
                    type: 'object',
                    properties: {
                      transcript: {
                        type: 'string',
                        description: 'The exact text of what the user said',
                      },
                    },
                    required: ['transcript'],
                  },
                },
              ],
              tool_choice: 'required',
            },
          });

          resolve(true);
        });
      } catch (err) {
        log.error('voice', 'Connection error', { error: err.message || err });
        reject(err);
      }
    });
  }

  /**
   * Send event to OpenAI
   */
  sendEvent(event) {
    if (!this.ws || !this.isConnected) {
      // #region agent log
      if (event.type !== 'input_audio_buffer.append')
        fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location: 'voice-listener.js:sendEvent-fail',
            message: 'sendEvent failed - not connected',
            data: {
              eventType: event.type,
              hasWs: !!this.ws,
              isConnected: this.isConnected,
              connectSeq: this._connectSeq,
            },
            timestamp: Date.now(),
            sessionId: 'debug-session',
            hypothesisId: 'H-NOSEND',
          }),
        }).catch((err) => console.warn('[voice-listener] sendEvent-fail agent-log:', err.message));
      // #endregion
      log.warn('voice', 'Not connected');
      return false;
    }

    try {
      this.ws.send(JSON.stringify(event));
      return true;
    } catch (err) {
      log.error('voice', 'Error sending event', { error: err.message || err });
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
        log.info('voice', 'Session created', { sessionId: this.sessionId });
        this.broadcast({ type: 'session_created', sessionId: this.sessionId });
        break;

      case 'session.updated':
        log.info('voice', 'Session updated');
        this.broadcast({ type: 'session_updated' });
        break;

      case 'input_audio_buffer.speech_started':
        // If TTS is playing, this is likely our own audio bleeding into the mic.
        // Clear the buffer so the Realtime API doesn't transcribe it.
        if (hudApi.isSpeaking()) {
          log.info('voice', 'Speech detected during TTS playback -- clearing input buffer (mic gate)');
          this.sendEvent({ type: 'input_audio_buffer.clear' });
          break;
        }
        log.info('voice', 'Speech started');
        this.broadcast({ type: 'speech_started' });
        break;

      case 'input_audio_buffer.speech_stopped':
        // If TTS is still playing, ignore this event entirely
        if (hudApi.isSpeaking()) {
          log.info('voice', 'Speech stopped during TTS playback -- ignoring (mic gate)');
          break;
        }
        log.info('voice', 'Speech stopped');
        this.broadcast({ type: 'speech_stopped' });
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (event.delta) {
          this.broadcast({ type: 'transcript_delta', text: event.delta, isFinal: false });
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          log.info('voice', 'Transcription', { transcript: event.transcript });
          this.broadcast({
            type: 'transcript',
            text: event.transcript,
            isFinal: true,
          });
        }
        break;

      case 'error':
        if (event.error?.code === 'response_cancel_not_active') {
          log.info('voice', 'Cancel failed (no active response)');
          this.hasActiveResponse = false;
          break;
        }
        log.error('voice', 'API Error', { error: event.error });
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
        log.info('voice', 'Response created', { detail: event.response?.id });
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
              operation: 'voice-transcription',
            });
          } catch (e) {
            log.warn('voice', 'Failed to track usage', { error: e.message });
          }
        }
        break;

      case 'response.cancelled':
        log.info('voice', 'Response cancelled');
        this.hasActiveResponse = false;
        this.broadcast({ type: 'response_cancelled' });
        break;

      case 'response.audio.delta':
        // Block any audio from the Realtime API - we use voice-speaker.js for TTS
        // With tool_choice: "required", this shouldn't happen, but just in case
        if (!this.sanctionedResponseIds.has(event.response_id)) {
          // Silently drop - don't forward audio
          log.info('voice', 'Blocking unsanctioned audio');
        }
        break;

      case 'response.audio_transcript.delta':
        // Also block audio transcripts from unsanctioned responses
        if (!this.sanctionedResponseIds.has(event.response_id)) {
          // Silently drop
        }
        break;

      case 'response.function_call_arguments.done':
        log.info('voice', 'Function call', { eventName: event.name });

        if (event.name === 'handle_user_request') {
          try {
            const args = JSON.parse(event.arguments);
            const transcript = args.transcript;

            log.info('voice', 'User request', { transcript });

            this.pendingFunctionCallId = event.call_id;
            this.pendingFunctionItemId = event.item_id;

            // Broadcast for agent processing
            this.broadcast({
              type: 'function_call_transcript',
              transcript: transcript,
              callId: event.call_id,
              itemId: event.item_id,
            });
          } catch (err) {
            log.error('voice', 'Error parsing function arguments', { error: err.message || err });
          }
        }
        break;
    }
  }

  /**
   * Send audio data to OpenAI.
   * Drops audio when TTS is playing to prevent feedback loops.
   */
  sendAudio(base64Audio) {
    if (!this.isConnected) {
      // Cap buffer to prevent unbounded memory growth (max ~5 seconds of audio at 24kHz)
      if (this.audioBuffer.length < 120) {
        this.audioBuffer.push(base64Audio);
      }
      return false;
    }

    // ---- MIC GATING: drop audio while system is speaking ----
    if (hudApi.isSpeaking()) {
      // Discard any buffered audio that accumulated during speech
      if (this.audioBuffer.length > 0) {
        this.audioBuffer = [];
      }
      // Don't send this chunk -- it's our own TTS output
      return false;
    }

    while (this.audioBuffer.length > 0) {
      const buffered = this.audioBuffer.shift();
      this.sendEvent({
        type: 'input_audio_buffer.append',
        audio: buffered,
      });
    }

    return this.sendEvent({
      type: 'input_audio_buffer.append',
      audio: base64Audio,
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
      log.error('voice', 'Cannot respond - not connected');
      return false;
    }

    log.info('voice', 'Responding to function call', { callId });

    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({ response: result || '', handled: true }),
      },
    });

    return true;
  }

  /**
   * Cancel any active response
   */
  cancelResponse() {
    if (!this.isConnected) return false;

    log.info('voice', 'Cancelling response');
    this.hasActiveResponse = false;
    this.sendEvent({ type: 'response.cancel' });
    return true;
  }

  /**
   * Subscribe to listener events
   */
  subscribe(webContentsId, callback) {
    this.subscribers.set(webContentsId, callback);
    log.info('voice', 'Subscriber added: ...', { webContentsId });
  }

  /**
   * Unsubscribe
   */
  unsubscribe(webContentsId) {
    this.subscribers.delete(webContentsId);
    log.info('voice', 'Subscriber removed: ...', { webContentsId });

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
      } catch (_err) {
        log.error('voice', 'Error broadcasting to ...', { id });
      }
    });

    // Push final transcripts into the TranscriptService rolling buffer
    if (event.type === 'transcript' || event.type === 'function_call_transcript') {
      try {
        getTranscriptService().push({
          text: event.text || event.transcript,
          speaker: 'user',
          isFinal: true,
        });
      } catch (_) {
        /* non-fatal -- don't break broadcast for transcript store */
      }
    }
  }

  /**
   * Disconnect from OpenAI
   */
  disconnect() {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: 'voice-listener.js:disconnect',
        message: 'disconnect() called',
        data: {
          hasWs: !!this.ws,
          isConnected: this.isConnected,
          connectSeq: this._connectSeq,
          subscriberCount: this.subscribers.size,
        },
        timestamp: Date.now(),
        sessionId: 'debug-session',
        hypothesisId: 'H-RACE',
      }),
    }).catch((err) => console.warn('[voice-listener] disconnect agent-log:', err.message));
    // #endregion
    if (this.session) {
      log.info('voice', 'Disconnecting...');
      this.session.close();
      this.session = null;
    }
    if (this.ws) {
      this.ws = null;
    }
    this.isConnected = false;
    this.sessionId = null;
    this.audioBuffer = [];
    this.sanctionedResponseIds.clear();
    this.reconnectAttempts = 0; // Reset for next connection

    // Clear pending function call state
    this.pendingFunctionCallId = null;
    this.pendingFunctionItemId = null;
    this.hasActiveResponse = false;
    this.activeResponseId = null;
    this.pendingResponseCreate = false;
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
      // Check if API key is available via ai-service
      let hasApiKey = false;
      try {
        const ai = getAIService();
        ai._getApiKey('openai'); // This will throw if no key
        hasApiKey = true;
      } catch {
        hasApiKey = false;
      }

      return {
        connected: this.isConnected,
        sessionId: this.sessionId,
        hasApiKey,
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

    log.info('voice', 'IPC handlers registered');
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
