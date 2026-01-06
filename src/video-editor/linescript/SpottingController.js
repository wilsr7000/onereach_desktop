/**
 * SpottingController.js - Keyboard Spotting Controller
 * 
 * Features:
 * - Play/pause control
 * - Template-specific keyboard shortcuts
 * - Range marker creation (I/O)
 * - Visual feedback
 * - Undo support
 */

import { getKeyboardShortcuts } from './ContentTemplates.js';

/**
 * SpottingController - Keyboard-based spotting
 */
export class SpottingController {
  constructor(lineScriptPanel) {
    this.panel = lineScriptPanel;
    this.app = lineScriptPanel.app;
    
    // Configuration
    this.templateId = 'podcast';
    this.shortcuts = {};
    this.enabled = true;
    
    // Range marker state
    this.pendingInPoint = null;
    
    // Undo stack
    this.undoStack = [];
    this.maxUndoSize = 50;
    
    // Feedback element
    this.feedbackElement = null;
    
    // Event listeners
    this.eventListeners = {};
    
    // Bind methods
    this.handleKeyDown = this.handleKeyDown.bind(this);
    
    // Initialize
    this.init();
  }

  /**
   * Initialize controller
   */
  init() {
    // Load shortcuts for default template
    this.loadShortcuts(this.templateId);
    
    // Setup keyboard listener
    document.addEventListener('keydown', this.handleKeyDown);
  }

  /**
   * Load shortcuts for template
   * @param {string} templateId - Template ID
   */
  loadShortcuts(templateId) {
    this.templateId = templateId;
    this.shortcuts = getKeyboardShortcuts(templateId);
    
    // Add universal shortcuts
    this.shortcuts[' '] = { action: 'togglePlayPause', label: 'Space - Play/Pause' };
    this.shortcuts['escape'] = { action: 'cancel', label: 'Esc - Cancel' };
    this.shortcuts['z'] = { action: 'undo', label: 'Z - Undo', requiresCtrl: true };
    
    console.log(`[SpottingController] Loaded ${Object.keys(this.shortcuts).length} shortcuts for ${templateId}`);
  }

  /**
   * Set template
   * @param {string} templateId - Template ID
   */
  setTemplate(templateId) {
    this.loadShortcuts(templateId);
  }

  /**
   * Enable/disable controller
   * @param {boolean} enabled - Enable state
   */
  setEnabled(enabled) {
    this.enabled = enabled;
  }

  /**
   * Handle keydown event
   * @param {KeyboardEvent} event - Keyboard event
   */
  handleKeyDown(event) {
    if (!this.enabled) return;
    
    // Don't capture if typing in input
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
    
    // Don't capture if panel isn't visible
    if (this.panel && !this.panel.visible) return;
    
    const key = event.key.toLowerCase();
    const shortcut = this.shortcuts[key];
    
    // Check for Ctrl+Z undo
    if (key === 'z' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.undo();
      return;
    }
    
    // Check for shortcut
    if (shortcut && (!shortcut.requiresCtrl || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.executeShortcut(shortcut, key);
      return;
    }
    
    // Global shortcuts
    switch (key) {
      case ' ':
        event.preventDefault();
        this.togglePlayPause();
        break;
      case 'escape':
        this.cancelPendingRange();
        break;
    }
  }

  /**
   * Execute a keyboard shortcut
   * @param {Object} shortcut - Shortcut configuration
   * @param {string} key - Key pressed
   */
  executeShortcut(shortcut, key) {
    const time = this.getCurrentTime();
    
    console.log(`[SpottingController] Executing: ${shortcut.action} at ${time.toFixed(2)}s`);
    
    // Show visual feedback
    this.showFeedback(`[${key.toUpperCase()}] ${shortcut.label || shortcut.action}`);
    
    switch (shortcut.action) {
      case 'togglePlayPause':
        this.togglePlayPause();
        break;
        
      case 'setInPoint':
        this.setInPoint(time);
        break;
        
      case 'setOutPoint':
        this.setOutPoint(time);
        break;
        
      case 'cancel':
        this.cancelPendingRange();
        break;
        
      case 'undo':
        this.undo();
        break;
        
      default:
        // Template-specific marker actions
        if (shortcut.action.startsWith('add') && shortcut.action.endsWith('Marker')) {
          this.addMarker(shortcut.action, time);
        }
    }
    
    // Emit event
    this.emit('shortcutExecuted', { shortcut, key, time });
  }

  /**
   * Toggle play/pause
   */
  togglePlayPause() {
    const video = this.app.video;
    if (!video) return;
    
    if (video.paused) {
      video.play();
      this.showFeedback('▶ Play');
    } else {
      video.pause();
      this.showFeedback('⏸ Pause');
    }
    
    this.emit('playStateChanged', { playing: !video.paused });
  }

  /**
   * Get current video time
   * @returns {number} Current time in seconds
   */
  getCurrentTime() {
    return this.app.video?.currentTime || 0;
  }

  /**
   * Set IN point for range
   * @param {number} time - Time in seconds
   */
  setInPoint(time) {
    this.pendingInPoint = time;
    this.showFeedback(`◀ IN: ${this.formatTime(time)}`);
    this.updatePendingIndicator();
    
    this.emit('inPointSet', { time });
  }

  /**
   * Set OUT point and complete range
   * @param {number} time - Time in seconds
   */
  setOutPoint(time) {
    if (this.pendingInPoint === null) {
      this.showFeedback('Set IN point first (I)', 'warning');
      return;
    }
    
    const inTime = this.pendingInPoint;
    const outTime = time;
    
    if (outTime <= inTime) {
      this.showFeedback('OUT must be after IN', 'error');
      return;
    }
    
    // Create range marker
    const marker = this.createRangeMarker(inTime, outTime);
    
    // Add to undo stack
    this.pushUndo({ type: 'marker', marker });
    
    // Clear pending
    this.pendingInPoint = null;
    this.updatePendingIndicator();
    
    this.showFeedback(`▶ OUT: ${this.formatTime(outTime)} (Range created)`);
    this.emit('rangeCreated', { inTime, outTime, marker });
  }

  /**
   * Cancel pending range
   */
  cancelPendingRange() {
    if (this.pendingInPoint !== null) {
      this.pendingInPoint = null;
      this.updatePendingIndicator();
      this.showFeedback('Range cancelled');
      this.emit('rangeCancelled');
    }
  }

  /**
   * Add a spot marker
   * @param {string} action - Action name
   * @param {number} time - Time in seconds
   */
  addMarker(action, time) {
    const markerManager = this.app.markerManager;
    if (!markerManager) return;
    
    // Determine marker type from action
    const markerType = action.replace('add', '').replace('Marker', '').toLowerCase();
    
    const marker = markerManager.addSpotMarker(
      time,
      `${markerType.charAt(0).toUpperCase() + markerType.slice(1)}`,
      null,
      { 
        markerType,
        source: 'keyboard'
      }
    );
    
    // Add to undo stack
    this.pushUndo({ type: 'marker', marker });
    
    // Notify panel
    if (this.panel) {
      this.panel.loadMarkers();
    }
    
    this.emit('markerAdded', { marker, time });
  }

  /**
   * Create range marker
   * @param {number} inTime - IN time
   * @param {number} outTime - OUT time
   * @returns {Object} Created marker
   */
  createRangeMarker(inTime, outTime) {
    const markerManager = this.app.markerManager;
    if (!markerManager) return null;
    
    const marker = markerManager.addRangeMarker(
      inTime,
      outTime,
      'Scene',
      null,
      { source: 'keyboard' }
    );
    
    // Notify panel
    if (this.panel) {
      this.panel.loadMarkers();
    }
    
    return marker;
  }

  /**
   * Undo last action
   */
  undo() {
    if (this.undoStack.length === 0) {
      this.showFeedback('Nothing to undo');
      return;
    }
    
    const lastAction = this.undoStack.pop();
    
    switch (lastAction.type) {
      case 'marker':
        // Remove marker
        const markerManager = this.app.markerManager;
        if (markerManager && lastAction.marker) {
          markerManager.deleteMarker(lastAction.marker.id);
          if (this.panel) {
            this.panel.loadMarkers();
          }
          this.showFeedback('↩️ Marker undone');
        }
        break;
        
      case 'range':
        // Remove range marker
        if (this.app.markerManager && lastAction.marker) {
          this.app.markerManager.deleteMarker(lastAction.marker.id);
          if (this.panel) {
            this.panel.loadMarkers();
          }
          this.showFeedback('↩️ Range undone');
        }
        break;
    }
    
    this.emit('undoPerformed', { action: lastAction });
  }

  /**
   * Push action to undo stack
   * @param {Object} action - Action to push
   */
  pushUndo(action) {
    this.undoStack.push(action);
    
    // Limit stack size
    while (this.undoStack.length > this.maxUndoSize) {
      this.undoStack.shift();
    }
  }

  /**
   * Clear undo stack
   */
  clearUndo() {
    this.undoStack = [];
  }

  /**
   * Show visual feedback
   * @param {string} message - Feedback message
   * @param {string} type - Feedback type
   */
  showFeedback(message, type = 'info') {
    // Create element if needed
    if (!this.feedbackElement) {
      this.feedbackElement = document.createElement('div');
      this.feedbackElement.className = 'spotting-feedback';
      document.body.appendChild(this.feedbackElement);
    }
    
    // Set content and type
    this.feedbackElement.textContent = message;
    this.feedbackElement.className = `spotting-feedback ${type} visible`;
    
    // Hide after delay
    clearTimeout(this.feedbackTimeout);
    this.feedbackTimeout = setTimeout(() => {
      this.feedbackElement.classList.remove('visible');
    }, 1500);
    
    // Also emit for external handlers
    this.emit('feedback', { message, type });
  }

  /**
   * Update pending range indicator
   */
  updatePendingIndicator() {
    if (this.panel) {
      this.panel.pendingInPoint = this.pendingInPoint;
      this.panel.updatePendingRangeUI?.();
    }
  }

  /**
   * Format time as MM:SS.f
   * @param {number} seconds - Seconds
   * @returns {string} Formatted time
   */
  formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const f = Math.floor((seconds % 1) * 10);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${f}`;
  }

  /**
   * Get all shortcuts
   * @returns {Object} Shortcuts
   */
  getShortcuts() {
    return { ...this.shortcuts };
  }

  /**
   * Get shortcuts as help text
   * @returns {Array} Shortcut help entries
   */
  getShortcutsHelp() {
    return Object.entries(this.shortcuts).map(([key, config]) => ({
      key: key.toUpperCase(),
      label: config.label || config.action
    }));
  }

  // Event emitter methods
  
  on(event, callback) {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(callback);
  }

  emit(event, data = {}) {
    if (this.eventListeners[event]) {
      this.eventListeners[event].forEach(callback => callback(data));
    }
  }

  off(event, callback) {
    if (this.eventListeners[event]) {
      this.eventListeners[event] = this.eventListeners[event].filter(cb => cb !== callback);
    }
  }

  /**
   * Destroy controller
   */
  destroy() {
    document.removeEventListener('keydown', this.handleKeyDown);
    
    if (this.feedbackElement) {
      this.feedbackElement.remove();
    }
    
    clearTimeout(this.feedbackTimeout);
    this.eventListeners = {};
  }
}

export default SpottingController;








