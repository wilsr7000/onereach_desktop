/**
 * AdaptiveModeManager.js - Automatic Mode Detection and Switching
 *
 * Detects user context and smoothly transitions between modes:
 * - Spotting Mode: Video playing, minimal UI
 * - Edit Mode: Video paused + selecting content
 * - Review Mode: Hovering markers, previewing
 * - Export Mode: Export panel open
 */

import { VIEW_MODES } from './LineScriptPanel.js';

/**
 * Mode detection configuration
 */
const MODE_CONFIG = {
  [VIEW_MODES.SPOTTING]: {
    priority: 1,
    transitionDelay: 0,
    exitDelay: 500,
  },
  [VIEW_MODES.EDIT]: {
    priority: 2,
    transitionDelay: 300,
    exitDelay: 1000,
  },
  [VIEW_MODES.REVIEW]: {
    priority: 2,
    transitionDelay: 500,
    exitDelay: 500,
  },
  [VIEW_MODES.EXPORT]: {
    priority: 3,
    transitionDelay: 0,
    exitDelay: 0,
  },
};

/**
 * User context signals for mode detection
 */
const CONTEXT_SIGNALS = {
  VIDEO_PLAYING: 'video_playing',
  VIDEO_PAUSED: 'video_paused',
  TEXT_SELECTED: 'text_selected',
  MARKER_HOVERING: 'marker_hovering',
  MARKER_EDITING: 'marker_editing',
  EXPORT_PANEL_OPEN: 'export_panel_open',
  KEYBOARD_ACTIVE: 'keyboard_active',
  VOICE_ACTIVE: 'voice_active',
  IDLE: 'idle',
};

/**
 * AdaptiveModeManager - Handles automatic mode detection and transitions
 */
export class AdaptiveModeManager {
  constructor(lineScriptPanel) {
    this.panel = lineScriptPanel;
    this.app = lineScriptPanel.app;

    // Current state
    this.currentMode = VIEW_MODES.SPOTTING;
    this.locked = false;
    this.pendingTransition = null;

    // Context tracking
    this.activeSignals = new Set();
    this.lastActivity = Date.now();
    this.idleTimeout = 30000; // 30 seconds

    // Transition state
    this.transitioning = false;
    this.transitionCallbacks = [];

    // Mouse tracking for hover detection
    this.lastMousePosition = { x: 0, y: 0 };
    this.hoverTarget = null;

    // Event listeners
    this.eventListeners = {};

    // Bind methods
    this.handleVideoPlay = this.handleVideoPlay.bind(this);
    this.handleVideoPause = this.handleVideoPause.bind(this);
    this.handleTextSelection = this.handleTextSelection.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.checkIdleState = this.checkIdleState.bind(this);
  }

  /**
   * Initialize the mode manager
   */
  init() {
    this.setupEventListeners();
    this.startIdleCheck();
    window.logging.info('video', 'AdaptiveModeManager Initialized');
  }

  /**
   * Setup event listeners for context detection
   */
  setupEventListeners() {
    // Video events
    if (this.app.video) {
      this.app.video.addEventListener('play', this.handleVideoPlay);
      this.app.video.addEventListener('pause', this.handleVideoPause);
      this.app.video.addEventListener('ended', this.handleVideoPause);
    }

    // Selection events
    document.addEventListener('selectionchange', this.handleTextSelection);

    // Mouse events for hover detection
    document.addEventListener('mousemove', this.handleMouseMove);

    // Keyboard events
    document.addEventListener('keydown', this.handleKeyDown);

    // Panel events
    this.panel.on('export', () => this.addSignal(CONTEXT_SIGNALS.EXPORT_PANEL_OPEN));
    this.panel.on('markerAdded', () => this.recordActivity());
  }

  /**
   * Handle video play event
   */
  handleVideoPlay() {
    this.addSignal(CONTEXT_SIGNALS.VIDEO_PLAYING);
    this.removeSignal(CONTEXT_SIGNALS.VIDEO_PAUSED);
    this.recordActivity();
    this.evaluateModeChange();
  }

  /**
   * Handle video pause event
   */
  handleVideoPause() {
    this.addSignal(CONTEXT_SIGNALS.VIDEO_PAUSED);
    this.removeSignal(CONTEXT_SIGNALS.VIDEO_PLAYING);
    this.recordActivity();

    // Delay mode evaluation to allow for user action
    setTimeout(() => this.evaluateModeChange(), 300);
  }

  /**
   * Handle text selection change
   */
  handleTextSelection() {
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      this.addSignal(CONTEXT_SIGNALS.TEXT_SELECTED);
    } else {
      this.removeSignal(CONTEXT_SIGNALS.TEXT_SELECTED);
    }
    this.recordActivity();
    this.evaluateModeChange();
  }

  /**
   * Handle mouse movement for hover detection
   * @param {MouseEvent} e - Mouse event
   */
  handleMouseMove(e) {
    this.lastMousePosition = { x: e.clientX, y: e.clientY };

    // Check if hovering over marker elements
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const markerElement = target?.closest('[data-marker-id]');
    const reviewCard = target?.closest('.review-card');

    if (markerElement || reviewCard) {
      if (!this.activeSignals.has(CONTEXT_SIGNALS.MARKER_HOVERING)) {
        this.addSignal(CONTEXT_SIGNALS.MARKER_HOVERING);
        this.hoverTarget = markerElement || reviewCard;
        this.evaluateModeChange();
      }
    } else {
      if (this.activeSignals.has(CONTEXT_SIGNALS.MARKER_HOVERING)) {
        this.removeSignal(CONTEXT_SIGNALS.MARKER_HOVERING);
        this.hoverTarget = null;
        setTimeout(() => this.evaluateModeChange(), 500);
      }
    }

    this.recordActivity();
  }

  /**
   * Handle keyboard events
   * @param {KeyboardEvent} e - Keyboard event
   */
  handleKeyDown(e) {
    this.recordActivity();

    // Check for spotting shortcuts
    const spottingKeys = ['m', 'i', 'o', ' ', 'q', 't', 'c', 'f', 'h', 'k'];
    if (spottingKeys.includes(e.key.toLowerCase())) {
      this.addSignal(CONTEXT_SIGNALS.KEYBOARD_ACTIVE);
      setTimeout(() => {
        this.removeSignal(CONTEXT_SIGNALS.KEYBOARD_ACTIVE);
        this.evaluateModeChange();
      }, 2000);
    }
  }

  /**
   * Add a context signal
   * @param {string} signal - Signal to add
   */
  addSignal(signal) {
    this.activeSignals.add(signal);
    this.emit('signalAdded', { signal });
  }

  /**
   * Remove a context signal
   * @param {string} signal - Signal to remove
   */
  removeSignal(signal) {
    this.activeSignals.delete(signal);
    this.emit('signalRemoved', { signal });
  }

  /**
   * Record user activity (resets idle timer)
   */
  recordActivity() {
    this.lastActivity = Date.now();
    this.removeSignal(CONTEXT_SIGNALS.IDLE);
  }

  /**
   * Start idle state checking
   */
  startIdleCheck() {
    this.idleCheckInterval = setInterval(this.checkIdleState, 5000);
  }

  /**
   * Check for idle state
   */
  checkIdleState() {
    const idleTime = Date.now() - this.lastActivity;

    if (idleTime > this.idleTimeout) {
      if (!this.activeSignals.has(CONTEXT_SIGNALS.IDLE)) {
        this.addSignal(CONTEXT_SIGNALS.IDLE);
        this.evaluateModeChange();
      }
    }
  }

  /**
   * Evaluate and potentially change mode based on current context
   */
  evaluateModeChange() {
    if (this.locked || this.transitioning) return;

    const suggestedMode = this.detectOptimalMode();

    if (suggestedMode !== this.currentMode) {
      this.scheduleModeTransition(suggestedMode);
    }
  }

  /**
   * Detect the optimal mode based on current signals
   * @returns {string} Suggested mode
   */
  detectOptimalMode() {
    const signals = this.activeSignals;

    // Priority order: Export > Edit > Review > Spotting

    // Export mode: export panel is open
    if (signals.has(CONTEXT_SIGNALS.EXPORT_PANEL_OPEN)) {
      return VIEW_MODES.EXPORT;
    }

    // Edit mode: video paused AND (text selected OR marker editing)
    if (
      signals.has(CONTEXT_SIGNALS.VIDEO_PAUSED) &&
      (signals.has(CONTEXT_SIGNALS.TEXT_SELECTED) || signals.has(CONTEXT_SIGNALS.MARKER_EDITING))
    ) {
      return VIEW_MODES.EDIT;
    }

    // Review mode: video paused AND hovering markers
    if (signals.has(CONTEXT_SIGNALS.VIDEO_PAUSED) && signals.has(CONTEXT_SIGNALS.MARKER_HOVERING)) {
      return VIEW_MODES.REVIEW;
    }

    // Spotting mode: video playing OR keyboard active OR voice active
    if (
      signals.has(CONTEXT_SIGNALS.VIDEO_PLAYING) ||
      signals.has(CONTEXT_SIGNALS.KEYBOARD_ACTIVE) ||
      signals.has(CONTEXT_SIGNALS.VOICE_ACTIVE)
    ) {
      return VIEW_MODES.SPOTTING;
    }

    // Default: if video is paused, go to edit mode
    if (signals.has(CONTEXT_SIGNALS.VIDEO_PAUSED)) {
      return VIEW_MODES.EDIT;
    }

    // If idle, stay in current mode
    if (signals.has(CONTEXT_SIGNALS.IDLE)) {
      return this.currentMode;
    }

    // Default to spotting
    return VIEW_MODES.SPOTTING;
  }

  /**
   * Schedule a mode transition with appropriate delay
   * @param {string} targetMode - Target mode
   */
  scheduleModeTransition(targetMode) {
    // Cancel any pending transition
    if (this.pendingTransition) {
      clearTimeout(this.pendingTransition.timeout);
    }

    const config = MODE_CONFIG[targetMode];
    const delay = config.transitionDelay;

    if (delay === 0) {
      this.transitionTo(targetMode);
    } else {
      this.pendingTransition = {
        targetMode,
        timeout: setTimeout(() => {
          this.transitionTo(targetMode);
          this.pendingTransition = null;
        }, delay),
      };
    }
  }

  /**
   * Perform mode transition with animation
   * @param {string} targetMode - Target mode
   */
  transitionTo(targetMode) {
    if (this.currentMode === targetMode) return;

    this.transitioning = true;
    const previousMode = this.currentMode;

    // Emit before transition event
    this.emit('beforeTransition', { from: previousMode, to: targetMode });

    // Animate out
    this.animateOut(previousMode)
      .then(() => {
        // Update mode
        this.currentMode = targetMode;
        this.panel.viewMode = targetMode;

        // Render new mode
        this.panel.render();

        // Animate in
        return this.animateIn(targetMode);
      })
      .then(() => {
        this.transitioning = false;

        // Emit after transition event
        this.emit('afterTransition', { from: previousMode, to: targetMode });

        window.logging.info('video', `AdaptiveModeManager Transitioned: ${previousMode} → ${targetMode}`);
      });
  }

  /**
   * Animate mode out
   * @param {string} mode - Mode to animate out
   * @returns {Promise} Animation promise
   */
  animateOut(mode) {
    return new Promise((resolve) => {
      const container = this.panel.container;
      if (!container) {
        resolve();
        return;
      }

      container.classList.add('mode-transitioning', 'mode-exit');
      container.style.setProperty('--exit-mode', mode);

      setTimeout(() => {
        container.classList.remove('mode-exit');
        resolve();
      }, 200);
    });
  }

  /**
   * Animate mode in
   * @param {string} mode - Mode to animate in
   * @returns {Promise} Animation promise
   */
  animateIn(mode) {
    return new Promise((resolve) => {
      const container = this.panel.container;
      if (!container) {
        resolve();
        return;
      }

      container.classList.add('mode-enter');
      container.style.setProperty('--enter-mode', mode);

      setTimeout(() => {
        container.classList.remove('mode-transitioning', 'mode-enter');
        resolve();
      }, 200);
    });
  }

  /**
   * Lock current mode (prevent auto-switching)
   * @param {boolean} lock - Lock state
   */
  lock(lock = true) {
    this.locked = lock;
    this.emit('lockChanged', { locked: lock });

    if (lock && this.pendingTransition) {
      clearTimeout(this.pendingTransition.timeout);
      this.pendingTransition = null;
    }
  }

  /**
   * Unlock mode
   */
  unlock() {
    this.lock(false);
    this.evaluateModeChange();
  }

  /**
   * Force switch to a specific mode
   * @param {string} mode - Target mode
   */
  forceMode(mode) {
    if (Object.values(VIEW_MODES).includes(mode)) {
      this.transitionTo(mode);
    }
  }

  /**
   * Set voice active state
   * @param {boolean} active - Voice active state
   */
  setVoiceActive(active) {
    if (active) {
      this.addSignal(CONTEXT_SIGNALS.VOICE_ACTIVE);
    } else {
      this.removeSignal(CONTEXT_SIGNALS.VOICE_ACTIVE);
    }
    this.evaluateModeChange();
  }

  /**
   * Set marker editing state
   * @param {boolean} editing - Marker editing state
   */
  setMarkerEditing(editing) {
    if (editing) {
      this.addSignal(CONTEXT_SIGNALS.MARKER_EDITING);
    } else {
      this.removeSignal(CONTEXT_SIGNALS.MARKER_EDITING);
    }
    this.evaluateModeChange();
  }

  /**
   * Set export panel state
   * @param {boolean} open - Export panel open state
   */
  setExportPanelOpen(open) {
    if (open) {
      this.addSignal(CONTEXT_SIGNALS.EXPORT_PANEL_OPEN);
    } else {
      this.removeSignal(CONTEXT_SIGNALS.EXPORT_PANEL_OPEN);
    }
    this.evaluateModeChange();
  }

  /**
   * Get current context signals
   * @returns {Array} Active signals
   */
  getActiveSignals() {
    return Array.from(this.activeSignals);
  }

  /**
   * Get current mode
   * @returns {string} Current mode
   */
  getCurrentMode() {
    return this.currentMode;
  }

  /**
   * Check if mode is locked
   * @returns {boolean} Lock state
   */
  isLocked() {
    return this.locked;
  }

  /**
   * Check if currently transitioning
   * @returns {boolean} Transition state
   */
  isTransitioning() {
    return this.transitioning;
  }

  // Event emitter methods

  /**
   * Subscribe to an event
   * @param {string} event - Event name
   * @param {Function} callback - Callback function
   */
  on(event, callback) {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(callback);
  }

  /**
   * Emit an event
   * @param {string} event - Event name
   * @param {Object} data - Event data
   */
  emit(event, data = {}) {
    if (this.eventListeners[event]) {
      this.eventListeners[event].forEach((callback) => callback(data));
    }
  }

  /**
   * Unsubscribe from an event
   * @param {string} event - Event name
   * @param {Function} callback - Callback function
   */
  off(event, callback) {
    if (this.eventListeners[event]) {
      this.eventListeners[event] = this.eventListeners[event].filter((cb) => cb !== callback);
    }
  }

  /**
   * Destroy and cleanup
   */
  destroy() {
    // Clear timers
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
    }
    if (this.pendingTransition) {
      clearTimeout(this.pendingTransition.timeout);
    }

    // Remove event listeners
    if (this.app.video) {
      this.app.video.removeEventListener('play', this.handleVideoPlay);
      this.app.video.removeEventListener('pause', this.handleVideoPause);
    }
    document.removeEventListener('selectionchange', this.handleTextSelection);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('keydown', this.handleKeyDown);

    // Clear state
    this.eventListeners = {};
    this.activeSignals.clear();
  }
}

export { CONTEXT_SIGNALS };
export default AdaptiveModeManager;
