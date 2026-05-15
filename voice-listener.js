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

// Phase 3 (audio output): map AffectTracker labels onto short tone
// directives we splice into response.create instructions. Keeps the
// vocabulary the model interprets reliably (its preamble guide lists
// these tones) instead of stuffing raw "frustrated" into the prompt.
const AFFECT_TONE_MAP = {
  frustrated: 'calm and empathetic',
  angry: 'calm and empathetic',
  upset: 'calm and empathetic',
  sad: 'gentle and warm',
  worried: 'reassuring and steady',
  anxious: 'reassuring and steady',
  excited: 'upbeat and friendly',
  happy: 'upbeat and friendly',
  calm: 'measured and friendly',
};

// Phase 3 (audio output): production deps for the parts of the listener
// that drive the orb's speaking lifecycle and barge detector. Tests stub
// these via VoiceListener.prototype.__setDeps() so the unit tests don't
// have to fight vitest's path-based mock resolution for the lazy
// barge-detector-singleton require.
const _defaultListenerDeps = {
  hudApi,
  getBargeDetector: () => {
    try {
      return require('./lib/naturalness/barge-detector-singleton').getSharedBargeDetector();
    } catch (_err) {
      return null;
    }
  },
  /**
   * Lazily resolve the AffectTracker. Returns `{ label }` snapshot or null.
   * Wrapped so tests can stub without mocking the lib/naturalness barrel.
   */
  getAffect: () => {
    try {
      const naturalness = require('./lib/naturalness');
      if (!naturalness.flags || !naturalness.flags.isFlagEnabled('affectMatching')) {
        return null;
      }
      return naturalness.affectTracker.getSharedAffectTracker().get();
    } catch (_err) {
      return null;
    }
  },
};

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

    // Track whether any audio has been appended to the server buffer
    // since the last commit/clear. `input_audio_buffer.commit` on a
    // buffer with <100ms of audio returns a hard API error that tears
    // down the Realtime session. The semantic_vad auto-commit can race
    // explicit commits from the function-call path, so we keep this
    // guard to make both sides idempotent.
    this._bufferHasAudio = false;

    // Phase 3 (audio output): rolling state per assistant response.
    this._modelTranscript = ''; // accumulated text from output_audio_transcript deltas
    this._audioStartedForResponseId = null; // first audio_delta flips this on; response.done releases it

    // Test seam for hud-api + barge-detector. See _defaultListenerDeps.
    this._deps = _defaultListenerDeps;

    // ==================== PHASE 3.5 PAUSE DETECTOR (RETIRED) ====================
    // The orb previously ran a custom pause detector + 100ms silence
    // ticker to commit utterances earlier than the preview API's 1200ms
    // server_vad floor. The GA Realtime API 2 ships semantic_vad which
    // does this model-side, so the custom path is no longer wired here.
    // lib/naturalness/pause-detector.js remains in the tree for unit
    // tests and potential reuse; it just isn't called from this listener.

    log.info('voice', 'Initialized');
  }

  /**
   * Test seam: override hud-api + barge-detector dependencies. Production
   * callers never use this.
   */
  __setDeps(deps) {
    this._deps = { ..._defaultListenerDeps, ...(deps || {}) };
  }

  __resetDeps() {
    this._deps = _defaultListenerDeps;
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

          this.sendEvent(this.buildSessionUpdate());

          resolve(true);
        });
      } catch (err) {
        log.error('voice', 'Connection error', { error: err.message || err });
        reject(err);
      }
    });
  }

  /**
   * Build the initial session.update payload sent to the GA Realtime API
   * after the WebSocket opens.
   *
   * Extracted as a method so the payload can be asserted by unit tests
   * without spinning up the full connect() flow (which has many side
   * effects -- WebSocket, repair-memory load, retry timers, etc.).
   *
   * Phase 3 (audio output hard cut) notes:
   *   - `output_modalities: ['audio']` lets the model voice agent
   *     responses natively. voice-speaker.js's tts-1 pipeline is kept
   *     alive for non-orb proactive callers (critical-meeting alarms etc.)
   *     so we don't have a coordination bug between two audio paths in
   *     the orb itself. The GA Realtime API rejects the combined
   *     `['audio', 'text']` value -- it only accepts `['audio']` OR
   *     `['text']`. When `['audio']` is selected the model still emits
   *     `response.output_audio_transcript.delta` events (the spoken
   *     transcript), so nothing user-visible is lost.
   *   - `audio.output.voice` is locked to `marin` for the whole session.
   *     The GA API forbids voice changes after the first audio response,
   *     so per-agent voices (the preview behavior) require custom voice
   *     uploads -- documented as follow-up. `marin` is OpenAI's
   *     recommended default for production voice agents.
   *   - `tool_choice: 'auto'` (down from 'required') so the model can
   *     speak the agent result after function_call_output without trying
   *     to call the tool again. The instructions still route every
   *     utterance through handle_user_request reliably.
   *   - `reasoning: { effort: 'low' }` -- recommended default for
   *     production voice agents.
   */
  buildSessionUpdate() {
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: 'gpt-realtime-2',
        output_modalities: ['audio'],
        reasoning: { effort: 'low' },
        instructions:
          'Every time the user speaks, call handle_user_request with their verbatim transcript. ' +
          'After the function returns, speak the function output verbatim and stop. ' +
          'Do not invent answers; a brief preamble like "one moment" before calling the tool is fine.',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-realtime-whisper' },
            turn_detection: { type: 'semantic_vad' },
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: 'marin',
          },
        },
        tools: [
          {
            type: 'function',
            name: 'handle_user_request',
            description: 'REQUIRED: Process every user utterance.',
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
        tool_choice: 'auto',
      },
    };
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
        // Phase 4.5: reset the barge partial -- a new speech burst
        // means a fresh interrupt candidate.
        this._bargePartial = '';
        break;

      case 'input_audio_buffer.speech_stopped':
        // Process normally whether or not TTS is playing; the barge
        // detector decides whether the captured speech was a genuine
        // interrupt. The GA semantic_vad commits the turn on its own
        // once it decides the user finished, so no client ticker here.
        log.info('voice', 'Speech stopped', { duringTts: hudApi.isSpeaking() });
        this.broadcast({ type: 'speech_stopped' });
        break;

      case 'input_audio_buffer.committed':
        // The server's semantic_vad (or an explicit client commit) has
        // closed the turn. Reset the audio-buffer flag.
        this._bufferHasAudio = false;
        break;

      case 'input_audio_buffer.cleared':
        this._bufferHasAudio = false;
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (event.delta) {
          // During TTS playback, feed the partial to the barge detector
          // so it can decide whether the user is interrupting.
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
        // Phase 4.5: reset the barge partial so the next TTS session
        // starts with a clean buffer.
        this._bargePartial = '';
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

        if (this.pendingResponseCreate) {
          this.sanctionedResponseIds.add(event.response?.id);
          this.pendingResponseCreate = false;
        }
        log.info('voice', 'Response created', { detail: event.response?.id });

        // Phase 3: reset per-response state; the speaking flag flips on
        // when we actually receive an audio delta (not here), because
        // some responses are tool-call-only and have no audio.
        this._modelTranscript = '';
        this._audioStartedForResponseId = null;
        break;

      case 'response.done':
        this.hasActiveResponse = false;
        if (event.response?.id) {
          this.sanctionedResponseIds.delete(event.response.id);
        }
        this.activeResponseId = null;

        // Phase 3 safety net: if this response produced audio and we never
        // got an output_audio.done event, release the speaking flag here.
        if (this._audioStartedForResponseId && this._audioStartedForResponseId === event.response?.id) {
          try { this._deps.hudApi.speechEnded(); } catch (_err) { /* optional */ }
          try {
            const barge = this._deps.getBargeDetector();
            if (barge) barge.onTtsEnd();
          } catch (_err) { /* optional */ }
          this._audioStartedForResponseId = null;
        }

        // Track API usage. GA Realtime API 2 reports usage with text and audio
        // token buckets split out under input_token_details / output_token_details,
        // plus cached_tokens (the realtime API caches the session prefix
        // automatically -- our long router instructions get cached on subsequent
        // turns). We forward all three buckets so pricing-config applies the
        // per-bucket rates ($4 text / $32 audio / $0.40 cached per 1M input).
        if (event.response?.usage) {
          try {
            const usage = event.response.usage;
            const inputAudio = usage.input_token_details?.audio_tokens || 0;
            const outputAudio = usage.output_token_details?.audio_tokens || 0;
            const cachedInput = usage.input_token_details?.cached_tokens || 0;
            const inputText =
              usage.input_token_details?.text_tokens ??
              Math.max(0, (usage.input_tokens || 0) - inputAudio);
            const outputText =
              usage.output_token_details?.text_tokens ??
              Math.max(0, (usage.output_tokens || 0) - outputAudio);
            const budgetManager = getBudgetManager();
            budgetManager.trackUsage({
              provider: 'openai',
              model: 'gpt-realtime-2',
              inputTokens: inputText,
              outputTokens: outputText,
              feature: 'realtime-voice',
              operation: 'voice-transcription',
              options: {
                inputAudioTokens: inputAudio,
                outputAudioTokens: outputAudio,
                cachedInputTokens: cachedInput,
              },
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

      case 'response.output_audio.delta':
        // Phase 3 (audio output hard cut): forward the base64-encoded PCM
        // chunk to orb subscribers as audio_delta. The orb's OrbAudio
        // module decodes + plays. This replaces the previous voice-speaker
        // tts-1 pipeline for orb-driven responses.
        //
        // First delta of a response flips hudApi.speaking ON (gating the
        // mic from feedback) and primes the barge detector. We tie this
        // to the first delta rather than response.created because some
        // responses (tool-call-only) never emit audio and we'd otherwise
        // strand the speaking flag forever.
        if (event.delta) {
          if (this._audioStartedForResponseId !== event.response_id) {
            this._audioStartedForResponseId = event.response_id;
            try { this._deps.hudApi.speechStarted(); } catch (_err) { /* optional */ }
            try {
              const barge = this._deps.getBargeDetector();
              if (barge) barge.onTtsStart('');
            } catch (_err) { /* optional */ }
          }
          this.broadcast({
            type: 'audio_delta',
            audio: event.delta,
            responseId: event.response_id,
          });
        }
        break;

      case 'response.output_audio.done':
        // End-of-audio marker -- orb flushes any buffered PCM and clears
        // its speaking state.
        this.broadcast({ type: 'audio_done', responseId: event.response_id });
        try { this._deps.hudApi.speechEnded(); } catch (_err) { /* optional */ }
        try {
          const barge = this._deps.getBargeDetector();
          if (barge) barge.onTtsEnd();
        } catch (_err) { /* optional */ }
        break;

      case 'response.output_audio_transcript.delta':
        // Carry the spoken-text caption to the orb (matches the legacy
        // speech_text_delta shape from voice-speaker.js). Also feed the
        // barge detector so it knows what the model is saying for echo
        // suppression on user partials.
        if (event.delta) {
          this._modelTranscript = (this._modelTranscript || '') + event.delta;
          this.broadcast({
            type: 'speech_text_delta',
            text: event.delta,
            responseId: event.response_id,
          });
          try {
            const barge = this._deps.getBargeDetector();
            if (barge) barge.onTtsUpdate(this._modelTranscript);
          } catch (_err) { /* optional */ }
        }
        break;

      case 'response.output_audio_transcript.done':
        // Final transcript -- broadcast as speech_text for any consumer
        // that wants the full sentence (e.g. transcript history, captions).
        if (event.transcript || this._modelTranscript) {
          this.broadcast({
            type: 'speech_text',
            text: event.transcript || this._modelTranscript || '',
            responseId: event.response_id,
          });
        }
        this._modelTranscript = '';
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
   * Respond to a function call (acknowledges the call to OpenAI).
   *
   * Phase 3 (audio output): after sending the function_call_output, emit
   * an explicit `response.create` so the GA model voices the result --
   * BUT only when there is a non-empty result to speak. Empty results
   * are silent acknowledgements: the caller (e.g. orb suppressAIResponse
   * path, or the realtime-speech.js wrapper that delegates to
   * voice-speaker) has already handled TTS through another channel and
   * just needs us to satisfy OpenAI's pending function_call slot without
   * producing competing audio. Triggering response.create on an empty
   * output made the model hallucinate a spoken reply that collided with
   * the real TTS stream -- breaking the daily-brief flow (panel rendered
   * but audio was either silent or garbled).
   *
   * When response.create IS sent, its instructions are affect-tuned --
   * if AffectTracker has a non-neutral user state (frustrated, calm,
   * excited), we steer the model's vocal tone to match. This is the
   * Phase 3 port of the previous voice-speaker affect-matching layer,
   * which post-edited the text -- realtime audio is generated on the
   * fly, so we steer via instructions instead.
   */
  respondToFunctionCall(callId, result = '') {
    if (!this.isConnected) {
      log.error('voice', 'Cannot respond - not connected');
      return false;
    }

    const speakResult = typeof result === 'string' && result.trim().length > 0;
    log.info('voice', 'Responding to function call', { callId, speakResult });

    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({ response: result || '', handled: true }),
      },
    });

    if (!speakResult) {
      // Silent acknowledgement: caller is handling TTS through another
      // path (voice-speaker, panel-only response, etc.). Don't make the
      // model speak from empty output -- it collides with the real audio.
      return true;
    }

    // Phase 3: trigger an audio response with optionally-affect-tuned
    // instructions. The model speaks `result` aloud using the session's
    // configured voice + the tone we steer to here.
    const affectInstructions = this._buildAffectInstructions();
    const responseCreate = { type: 'response.create' };
    if (affectInstructions) {
      responseCreate.response = { instructions: affectInstructions };
    }
    this.sendEvent(responseCreate);
    this.pendingResponseCreate = true;

    return true;
  }

  /**
   * Read the AffectTracker via the injectable getAffect dep and produce
   * a short tone-steering instruction string, or null if affect is
   * neutral / unavailable / the affectMatching flag is off. Mirrors the
   * legacy affect-adjust behavior from voice-speaker._doSpeak.
   *
   * Returns: e.g. "Speak in a calm, empathetic tone." or null.
   */
  _buildAffectInstructions() {
    let affect;
    try {
      affect = this._deps.getAffect();
    } catch (_err) {
      return null;
    }
    if (!affect || !affect.label || affect.label === 'neutral') return null;
    const tone = AFFECT_TONE_MAP[affect.label];
    if (!tone) return null;
    return `Speak the function output verbatim in a ${tone} tone.`;
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

    // Reset barge-detector partial so the next session starts clean.
    this._bargePartial = '';

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
