/**
 * Orb State Machine v2 - Formal state machine for the voice command interface.
 *
 * 6 phases:
 *   idle          - Orb is dormant
 *   connecting    - WebSocket handshake in progress
 *   listening     - Mic active, waiting for speech
 *   processing    - Transcript submitted, waiting for agent result
 *   speaking      - TTS playing agent response
 *   awaitingInput - Agent asked a follow-up question, waiting for re-listen
 *
 * Built-in timeouts auto-fire on phase transitions:
 *   connecting  -> 10s  connect timeout  -> endSession('connect-timeout')
 *   processing  -> 30s  processing timeout -> endSession('processing-timeout')
 *   awaitingInput -> 30s await timeout   -> endSession('await-timeout')
 *   any non-idle -> 60s session timeout  -> endSession('session-timeout')
 *
 * Loaded as a <script> in orb.html before the main script block.
 * Exposes window.OrbState namespace.
 */

'use strict';

(function () {
  // ==================== VALID TRANSITIONS ====================
  const VALID_TRANSITIONS = {
    idle: ['connecting', 'ambient'],
    ambient: ['connecting', 'idle'],
    connecting: ['listening', 'idle'],
    listening: ['processing', 'idle'],
    processing: ['speaking', 'idle'],
    speaking: ['idle', 'awaitingInput', 'listening', 'processing'],
    awaitingInput: ['listening', 'idle'],
  };

  // ==================== TIMEOUT DURATIONS ====================
  const CONNECT_TIMEOUT_MS = 10000; // 10s to establish WebSocket
  const PROCESSING_TIMEOUT_MS = 30000; // 30s for agent to respond
  const AWAIT_TIMEOUT_MS = 30000; // 30s for user to answer follow-up
  const SESSION_TIMEOUT_MS = 60000; // 60s inactivity safety net
  const AMBIENT_TIMEOUT_MS = 30000; // 30s before ambient auto-dismisses

  // ==================== STATE ====================
  const state = {
    // Core state machine
    phase: 'idle',

    // Session
    sessionId: null,

    // Connection
    isSessionReady: false,

    // Speech recognition
    lastProcessedTranscript: '',
    lastProcessedTime: 0,
    lastFunctionCallTranscript: '',
    lastFunctionCallTime: 0,
    lastSpeechTime: 0,
    hasSpokenThisSession: false,

    // TTS
    ttsEndTime: 0,

    // Pending operations
    pendingFunctionCallId: null,
    pendingSubmitCount: 0,
    pendingDisambiguation: null,

    // Panel state (replaces _suppressTranscriptForPanel)
    hasActivePanel: false,

    // Ambient attention queue
    ambientItems: [],

    // Timers (managed internally - not directly settable)
    silenceTimeoutId: null,
    noSpeechTimeoutId: null,

    // Audio resources (kept as passthrough for mic capture)
    audioContext: null,
    mediaStream: null,
    processor: null,
    ttsAudio: null,

    // UI
    isDragging: false,
    hasMoved: false,
    currentOrbSide: 'right',
    isTextChatOpen: false,
    chatHistory: [],
    currentChatAnchor: 'bottom-right',
  };

  // Internal timeout IDs (not exposed via state)
  let _connectTimeoutId = null;
  let _processingTimeoutId = null;
  let _awaitTimeoutId = null;
  let _sessionTimeoutId = null;
  let _ambientTimeoutId = null;

  // ==================== EVENT LISTENERS ====================
  const listeners = {};

  function on(event, fn) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
  }

  function off(event, fn) {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter((f) => f !== fn);
  }

  function emit(event, data) {
    if (listeners[event]) {
      for (const fn of listeners[event]) {
        try {
          fn(data);
        } catch (e) {
          console.error(`[OrbState] Listener error on '${event}':`, e);
        }
      }
    }
  }

  // ==================== TIMEOUT MANAGEMENT ====================

  function _clearAllTimeouts() {
    if (_connectTimeoutId) { clearTimeout(_connectTimeoutId); _connectTimeoutId = null; }
    if (_processingTimeoutId) { clearTimeout(_processingTimeoutId); _processingTimeoutId = null; }
    if (_awaitTimeoutId) { clearTimeout(_awaitTimeoutId); _awaitTimeoutId = null; }
    if (_sessionTimeoutId) { clearTimeout(_sessionTimeoutId); _sessionTimeoutId = null; }
    if (_ambientTimeoutId) { clearTimeout(_ambientTimeoutId); _ambientTimeoutId = null; }
  }

  function _startPhaseTimeout(newPhase) {
    // Clear any existing phase-specific timeout
    if (_connectTimeoutId) {
      clearTimeout(_connectTimeoutId);
      _connectTimeoutId = null;
    }
    if (_processingTimeoutId) {
      clearTimeout(_processingTimeoutId);
      _processingTimeoutId = null;
    }
    if (_awaitTimeoutId) {
      clearTimeout(_awaitTimeoutId);
      _awaitTimeoutId = null;
    }

    // Start phase-specific timeout
    if (newPhase === 'connecting') {
      _connectTimeoutId = setTimeout(() => {
        _connectTimeoutId = null;
        if (state.phase === 'connecting') {
          console.warn('[OrbState] Connect timeout (10s) - forcing idle');
          endSession('connect-timeout');
        }
      }, CONNECT_TIMEOUT_MS);
    } else if (newPhase === 'processing') {
      _processingTimeoutId = setTimeout(() => {
        _processingTimeoutId = null;
        if (state.phase === 'processing') {
          console.warn('[OrbState] Processing timeout (30s) - forcing idle');
          endSession('processing-timeout');
        }
      }, PROCESSING_TIMEOUT_MS);
    } else if (newPhase === 'awaitingInput') {
      _awaitTimeoutId = setTimeout(() => {
        _awaitTimeoutId = null;
        if (state.phase === 'awaitingInput') {
          console.warn('[OrbState] Await timeout (30s) - forcing idle');
          endSession('await-timeout');
        }
      }, AWAIT_TIMEOUT_MS);
    } else if (newPhase === 'ambient') {
      _ambientTimeoutId = setTimeout(() => {
        _ambientTimeoutId = null;
        if (state.phase === 'ambient') {
          console.log('[OrbState] Ambient auto-dismiss (30s)');
          transition('idle', 'ambient-timeout');
        }
      }, AMBIENT_TIMEOUT_MS);
      return; // ambient doesn't need a session timeout
    }

    // Reset session-level inactivity timeout for any non-idle phase
    if (newPhase !== 'idle') {
      if (_sessionTimeoutId) {
        clearTimeout(_sessionTimeoutId);
        _sessionTimeoutId = null;
      }
      _sessionTimeoutId = setTimeout(() => {
        _sessionTimeoutId = null;
        if (state.phase !== 'idle') {
          console.warn('[OrbState] Session inactivity timeout (60s) - forcing idle');
          endSession('session-timeout');
        }
      }, SESSION_TIMEOUT_MS);
    }
  }

  // ==================== TRANSITIONS ====================

  /**
   * Transition to a new phase. Invalid transitions are logged but not thrown.
   * @param {string} newPhase - Target phase
   * @param {string} [reason] - Optional reason for debugging
   * @returns {boolean} Whether the transition was valid
   */
  function transition(newPhase, reason = '') {
    const oldPhase = state.phase;

    if (oldPhase === newPhase) return true; // No-op

    const valid = VALID_TRANSITIONS[oldPhase];
    if (!valid || !valid.includes(newPhase)) {
      console.warn(`[OrbState] Invalid transition: ${oldPhase} -> ${newPhase} (reason: ${reason})`);
      return false;
    }

    state.phase = newPhase;
    console.log(`[OrbState] ${oldPhase} -> ${newPhase}${reason ? ` (${reason})` : ''}`);

    // Manage timeouts based on new phase
    if (newPhase === 'idle') {
      _clearAllTimeouts();
    } else {
      _startPhaseTimeout(newPhase);
    }

    // Track ttsEndTime when leaving speaking
    if (oldPhase === 'speaking') {
      state.ttsEndTime = Date.now();
    }

    emit('transition', { from: oldPhase, to: newPhase, reason });
    return true;
  }

  // ==================== SESSION MANAGEMENT ====================

  /**
   * Start a new voice session. Generates a session ID, resets dedup state,
   * and transitions to 'connecting'.
   */
  function startSession() {
    if (state.phase !== 'idle') {
      console.warn('[OrbState] startSession called but not idle (phase:', state.phase, ')');
      return false;
    }

    state.sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.lastProcessedTranscript = '';
    state.lastProcessedTime = 0;
    state.ttsEndTime = 0;
    state.hasSpokenThisSession = false;
    state.hasActivePanel = false;

    console.log(`[OrbState] Session started: ${state.sessionId}`);
    return transition('connecting', 'session-start');
  }

  /**
   * End the current session. Force-transitions to idle from ANY phase
   * (bypasses normal transition validation for emergency cleanup).
   * @param {string} [reason] - Why the session ended
   */
  function endSession(reason = 'unknown') {
    const oldPhase = state.phase;

    if (oldPhase === 'idle') return; // Already idle

    // Force to idle (bypasses validation)
    state.phase = 'idle';
    _clearAllTimeouts();

    // Reset session state
    state.isSessionReady = false;
    state.pendingFunctionCallId = null;
    state.pendingSubmitCount = 0;
    state.pendingDisambiguation = null;
    state.hasActivePanel = false;

    console.log(`[OrbState] Session ended: ${oldPhase} -> idle (${reason})`);
    emit('transition', { from: oldPhase, to: 'idle', reason });
  }

  /**
   * Check if the state machine can accept user input.
   * True when listening (normal speech) or connecting (session_updated event).
   */
  function canAcceptInput() {
    return state.phase === 'listening' || state.phase === 'connecting';
  }

  // ==================== STATE ACCESSORS ====================

  function getPhase() {
    return state.phase;
  }

  function is(phase) {
    return state.phase === phase;
  }

  function get(key) {
    return state[key];
  }

  function set(key, value) {
    if (key === 'phase') {
      console.warn('[OrbState] Use transition() to change phase, not set()');
      return;
    }
    const old = state[key];
    state[key] = value;
    if (old !== value) {
      emit('change', { key, old, value });
    }
  }

  function update(obj) {
    for (const [key, value] of Object.entries(obj)) {
      set(key, value);
    }
  }

  function reset() {
    endSession('reset');
  }

  function snapshot() {
    return {
      ...state,
      _connectTimeoutActive: _connectTimeoutId !== null,
      _processingTimeoutActive: _processingTimeoutId !== null,
      _awaitTimeoutActive: _awaitTimeoutId !== null,
      _sessionTimeoutActive: _sessionTimeoutId !== null,
    };
  }

  // ==================== EXPOSE ====================

  window.OrbState = {
    // Phase transitions
    transition,
    startSession,
    endSession,
    canAcceptInput,

    // Phase queries
    getPhase,
    is,

    // State access
    get,
    set,
    update,
    reset,
    snapshot,

    // Events
    on,
    off,

    // Derived getters (read-only)
    get phase() {
      return state.phase;
    },
    get isListening() {
      return state.phase === 'listening';
    },
    get isProcessing() {
      return state.phase === 'processing';
    },
    get isSpeaking() {
      return state.phase === 'speaking';
    },
    get isConnected() {
      // #region agent log
      if (state.phase === 'ambient') { try { fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'8b8027'},body:JSON.stringify({sessionId:'8b8027',location:'orb-state.js:isConnected',message:'isConnected called during ambient',data:{phase:state.phase},timestamp:Date.now(),hypothesisId:'A'})}).catch(()=>{}); } catch(_){} }
      // #endregion
      return state.phase !== 'idle';
    },
    get isAwaitingInput() {
      return state.phase === 'awaitingInput';
    },
    get isAmbient() {
      return state.phase === 'ambient';
    },
    get sessionId() {
      return state.sessionId;
    },
  };
})();
