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
    this._reconnectTimer = null;
    this._isConnecting = false;

    // Track responses to prevent unwanted AI speech
    this.sanctionedResponseIds = new Set();
    this.pendingResponseCreate = false;
    this.hasActiveResponse = false;
    this.activeResponseId = null;

    // Pending function call tracking
    this.pendingFunctionCallId = null;
    this.pendingFunctionItemId = null;

    // ==================== PAUSE DETECTOR (Phase 3.5) ====================
    // Lazy-initialized on first speech burst when the pauseDetection
    // flag is on. Holds per-turn accumulated partial transcript and a
    // silence ticker that re-evaluates the commit policy every
    // PAUSE_TICK_MS. When the detector decides the turn is over, it
    // calls commitAudio() earlier than the server VAD's 1200ms floor.
    this.pauseDetector = null;
    this._silenceTimer = null;
    this._silenceStartedAt = null;
    this._accumulatedPartial = '';
    this._evaluatingSilence = false;

    // Track whether any audio has been appended to the server buffer
    // since the last commit/clear. `input_audio_buffer.commit` on a
    // buffer with <100ms of audio returns a hard API error that tears
    // down the Realtime session. Both the pause-detector's
    // onCommitReady and function-call paths can race the server-side
    // VAD auto-commit, so we need an explicit guard.
    this._bufferHasAudio = false;

    log.info('voice', 'Initialized');
  }

  // ==================== PAUSE DETECTOR HELPERS (Phase 3.5) ====================

  /**
   * Lazy-initialize the pause detector on first speech burst.
   * @private
   */
  _ensurePauseDetector() {
    if (this.pauseDetector) return this.pauseDetector;

    const { createPauseDetector } = require('./lib/naturalness/pause-detector');
    const aiService = require('./lib/ai-service');

    this.pauseDetector = createPauseDetector({
      ai: (args) => aiService.chat(args),
      onCommitReady: (text, meta) => {
        log.info('voice', '[PauseDetector] commit-ready', {
          text: (text || '').slice(0, 60),
          reason: meta.reason,
          silenceMs: meta.silenceMs,
          classification: meta.classification,
          hitMaxWait: meta.hitMaxWait,
        });
        this._stopSilenceTicker();
        this._accumulatedPartial = '';
        // Commit the audio buffer so the Realtime API closes the turn.
        // The server will also eventually commit at its 1200ms floor;
        // doing it here just fires earlier for complete utterances.
        this.commitAudio();
      },
      onClassifyNeeded: () => {
        log.info('voice', '[PauseDetector] consulting LLM classifier');
      },
    });
    return this.pauseDetector;
  }

  /**
   * Start the silence ticker. Runs every PAUSE_TICK_MS and asks the
   * detector to evaluate. The detector is guarded by a single-flight
   * lock so slow LLM calls don't queue up.
   * @private
   */
  _startSilenceTicker() {
    this._stopSilenceTicker();
    if (!this.pauseDetector) return;

    const PAUSE_TICK_MS = 100;
    this._silenceStartedAt = Date.now();
    this._silenceTimer = setInterval(async () => {
      if (this._evaluatingSilence) return;
      this._evaluatingSilence = true;
      try {
        const elapsed = Date.now() - this._silenceStartedAt;
        this.pauseDetector.setSilence(elapsed);
        await this.pauseDetector.evaluate();
      } catch (err) {
        log.warn('voice', '[PauseDetector] evaluate error', { error: err.message });
      } finally {
        this._evaluatingSilence = false;
      }
    }, PAUSE_TICK_MS);

    // Never prevent process exit because of this timer.
    if (this._silenceTimer && typeof this._silenceTimer.unref === 'function') {
      this._silenceTimer.unref();
    }
  }

  /**
   * Stop the silence ticker. Safe to call any time, including when
   * no ticker is running.
   * @private
   */
  _stopSilenceTicker() {
    if (this._silenceTimer) {
      clearInterval(this._silenceTimer);
      this._silenceTimer = null;
    }
    this._silenceStartedAt = null;
  }

  /**
   * Connect to OpenAI Realtime API
   */
  async connect() {
    if (this.ws && this.isConnected) {
      log.info('voice', 'Already connected');
      return true;
    }
    if (this._isConnecting) {
      log.info('voice', 'Connection already in progress');
      return true;
    }
    this._isConnecting = true;

    // Kick off the repair-memory load in parallel with the WebSocket
    // handshake so the first transcript after connect has the user's
    // learned phonetic fixes already in memory. Fire-and-forget; the
    // apply path is a no-op on an empty map, so any race just means
    // the very first transcript doesn't get fixes applied (rare).
    // Imports through the public naturalness barrel.
    try {
      const { repairMemorySingleton } = require('./lib/naturalness');
      repairMemorySingleton.ensureLoaded().catch(() => {});
    } catch (_err) { /* repair layer optional at boot */ }

    return new Promise((resolve, reject) => {
      try {
        log.info('voice', 'Connecting to OpenAI Realtime API...');

        const session = getAIService().realtime({
          onMessage: (event) => this.handleEvent(event),
          onError: (error) => {
            log.error('voice', 'WebSocket error', { error: error.message });
            this.isConnected = false;
            this._isConnecting = false;
            reject(error);
          },
          onClose: (code, _reason) => {
            log.info('voice', 'Connection closed: ...', { code });
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

              if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
              this._reconnectTimer = setTimeout(async () => {
                this._reconnectTimer = null;
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
          this._isConnecting = false;
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
        // Speech during TTS is handled by the barge detector (echo
        // filter + classifier). We keep the input buffer so genuine
        // interrupts reach transcription; echo is filtered downstream.
        if (hudApi.isSpeaking()) {
          log.info('voice', 'Speech during TTS -- keeping buffer for barge detection');
        }
        log.info('voice', 'Speech started');
        this.broadcast({ type: 'speech_started' });
        // Phase 3.5: reset the pause detector for a fresh turn.
        // Lazy-inits on first speech burst when flag is on.
        {
          const detector = this._ensurePauseDetector();
          if (detector) {
            detector.resetOnSpeech();
            this._accumulatedPartial = '';
            this._stopSilenceTicker();
          }
        }
        // Phase 4.5: reset the barge partial too -- a new speech
        // burst means a fresh interrupt candidate.
        this._bargePartial = '';
        break;

      case 'input_audio_buffer.speech_stopped':
        // Process normally whether or not TTS is playing; the barge
        // detector decides whether the captured speech was a genuine
        // interrupt.
        log.info('voice', 'Speech stopped', { duringTts: hudApi.isSpeaking() });
        this.broadcast({ type: 'speech_stopped' });
        // Phase 3.5: begin the silence ticker so the detector can
        // decide to commit earlier than the 1200ms server VAD.
        if (this.pauseDetector) {
          this._startSilenceTicker();
        }
        break;

      case 'input_audio_buffer.committed':
        // The server's own VAD (or an earlier client commit) has
        // closed the turn. Flip the audio-buffer flag so any lingering
        // pause-detector commit races become no-ops instead of empty-
        // commit API errors.
        this._bufferHasAudio = false;
        this._stopSilenceTicker();
        break;

      case 'input_audio_buffer.cleared':
        this._bufferHasAudio = false;
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (event.delta) {
          // Feed the growing partial into the pause detector so it
          // can commit early when the user clearly finished talking.
          if (this.pauseDetector) {
            this._accumulatedPartial += event.delta;
            this.pauseDetector.onPartial(this._accumulatedPartial);
          }
          // During TTS playback, also feed the partial to the barge
          // detector so it can decide whether the user is interrupting.
          try {
            if (hudApi.isSpeaking()) {
              if (!this._bargePartial) this._bargePartial = '';
              this._bargePartial += event.delta;
              const {
                getSharedBargeDetector,
              } = require('./lib/naturalness/barge-detector-singleton');
              getSharedBargeDetector().onUserPartial(this._bargePartial);
            } else {
              this._bargePartial = '';
            }
          } catch (_err) {
            // Barge layer must never block transcription delivery.
          }
          this.broadcast({ type: 'transcript_delta', text: event.delta, isFinal: false });
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          // Phase 5: apply learned phonetic fixes so "play jess" gets
          // rewritten to "play jazz" before the rest of the pipeline
          // sees it. No-op when the repairMemory flag is off.
          let finalTranscript = event.transcript;
          try {
            const {
              getSharedRepairMemory,
            } = require('./lib/naturalness/repair-memory-singleton');
            const repair = getSharedRepairMemory();
            const fixed = repair.applyFixes(finalTranscript);
            if (fixed.appliedCount > 0) {
              log.info('voice', '[RepairMemory] applied fixes', {
                before: finalTranscript.slice(0, 60),
                after: fixed.text.slice(0, 60),
                fixes: fixed.applied,
              });
              finalTranscript = fixed.text;
            }
          } catch (_err) { /* repair layer must not block transcripts */ }

          log.info('voice', 'Transcription', { transcript: finalTranscript });
          this.broadcast({
            type: 'transcript',
            text: finalTranscript,
            isFinal: true,
          });
        }
        // Phase 3.5: the server committed the turn. Our detector may
        // or may not have committed first; either way stop the ticker
        // and reset for the next speech burst.
        this._stopSilenceTicker();
        this._accumulatedPartial = '';
        // Phase 4.5: also reset the barge partial so the next TTS
        // session starts with a clean buffer.
        this._bargePartial = '';
        if (this.pauseDetector) {
          this.pauseDetector.reset();
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
      this._bufferHasAudio = true;
    }

    this._bufferHasAudio = true;
    return this.sendEvent({
      type: 'input_audio_buffer.append',
      audio: base64Audio,
    });
  }

  /**
   * Commit the audio buffer.
   *
   * Skips the send when the buffer has no appended audio since the
   * last commit/clear. Committing an empty buffer makes the Realtime
   * API return `input_audio_buffer_commit_empty` (buffer too small)
   * which closes the session. The pause-detector's onCommitReady can
   * race the server-side VAD auto-commit; the guard makes both sides
   * idempotent.
   */
  commitAudio() {
    if (!this._bufferHasAudio) {
      log.warn('voice', '[VoiceListener] commitAudio() called with no buffered audio -- skipping');
      return { success: true, skipped: 'empty-buffer' };
    }
    this._bufferHasAudio = false;
    return this.sendEvent({ type: 'input_audio_buffer.commit' });
  }

  /**
   * Clear the audio buffer.
   */
  clearAudio() {
    this.audioBuffer = [];
    this._bufferHasAudio = false;
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
    if (this.session) {
      log.info('voice', 'Disconnecting...');
      this.session.close();
      this.session = null;
    }
    if (this.ws) {
      this.ws = null;
    }
    this.isConnected = false;
    this._isConnecting = false;
    this.sessionId = null;
    this.audioBuffer = [];
    this._bufferHasAudio = false;
    this.sanctionedResponseIds.clear();
    this.reconnectAttempts = 0;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    // Phase 3.5: stop the pause-detector silence ticker and reset its
    // internal state. Without this, a disconnect mid-turn (error,
    // user-stop, session timeout) left the 100 ms interval running
    // forever -- re-evaluating the classifier on stale partials and
    // occasionally triggering downstream state transitions (and tones).
    this._stopSilenceTicker();
    this._accumulatedPartial = '';
    this._bargePartial = '';
    if (this.pauseDetector) {
      try { this.pauseDetector.reset(); } catch (_e) { /* detector optional */ }
    }

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
