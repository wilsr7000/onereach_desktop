/**
 * VoiceSpottingController.js - Voice-Activated Spotting
 * 
 * Features:
 * - Web Speech API integration
 * - Template-specific voice commands
 * - Visual feedback for recognized commands
 * - Noise handling and command confirmation
 */

import { getVoiceCommands } from './ContentTemplates.js';

/**
 * VoiceSpottingController - Voice command recognition
 */
export class VoiceSpottingController {
  constructor(lineScriptPanel) {
    this.panel = lineScriptPanel;
    this.app = lineScriptPanel.app;
    
    // Speech recognition
    this.recognition = null;
    this.isListening = false;
    this.isSupported = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
    
    // Configuration
    this.templateId = 'podcast';
    this.voiceCommands = {};
    this.confidenceThreshold = 0.7;
    
    // Command tracking
    this.lastCommand = null;
    this.lastCommandTime = 0;
    this.commandCooldown = 500; // ms
    
    // Event listeners
    this.eventListeners = {};
    
    // UI elements
    this.feedbackElement = null;
    this.statusElement = null;
    
    // Initialize if supported
    if (this.isSupported) {
      this.initRecognition();
    }
  }

  /**
   * Initialize speech recognition
   */
  initRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRecognition();
    
    // Configuration
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';
    this.recognition.maxAlternatives = 3;
    
    // Event handlers
    this.recognition.onstart = () => this.handleStart();
    this.recognition.onend = () => this.handleEnd();
    this.recognition.onresult = (e) => this.handleResult(e);
    this.recognition.onerror = (e) => this.handleError(e);
    this.recognition.onnomatch = () => this.handleNoMatch();
  }

  /**
   * Set template for voice commands
   * @param {string} templateId - Template ID
   */
  setTemplate(templateId) {
    this.templateId = templateId;
    this.voiceCommands = getVoiceCommands(templateId);
    window.logging.info('video', `VoiceSpotting Loaded ${Object.keys(this.voiceCommands).length} commands for ${templateId}`);
  }

  /**
   * Start listening
   * @returns {boolean} Success
   */
  start() {
    if (!this.isSupported) {
      window.logging.warn('video', 'VoiceSpotting Speech recognition not supported');
      this.emit('error', { message: 'Speech recognition not supported in this browser' });
      return false;
    }
    
    if (this.isListening) {
      window.logging.warn('video', 'VoiceSpotting Already listening');
      return true;
    }
    
    try {
      // Load commands for current template
      this.setTemplate(this.panel.currentTemplateId || this.templateId);
      
      this.recognition.start();
      return true;
    } catch (error) {
      window.logging.error('video', 'VoiceSpotting Failed to start', { error: error.message || error });
      this.emit('error', { error });
      return false;
    }
  }

  /**
   * Stop listening
   */
  stop() {
    if (!this.recognition || !this.isListening) return;
    
    try {
      this.recognition.stop();
    } catch (error) {
      window.logging.error('video', 'VoiceSpotting Failed to stop', { error: error.message || error });
    }
    
    this.isListening = false;
    this.updateStatus('stopped');
  }

  /**
   * Toggle listening
   * @returns {boolean} New listening state
   */
  toggle() {
    if (this.isListening) {
      this.stop();
      return false;
    } else {
      return this.start();
    }
  }

  /**
   * Handle recognition start
   */
  handleStart() {
    this.isListening = true;
    this.updateStatus('listening');
    this.emit('started');
    window.logging.info('video', 'VoiceSpotting Started listening');
  }

  /**
   * Handle recognition end
   */
  handleEnd() {
    this.isListening = false;
    this.updateStatus('stopped');
    this.emit('stopped');
    window.logging.info('video', 'VoiceSpotting Stopped listening');
    
    // Auto-restart if still supposed to be listening
    if (this.shouldAutoRestart) {
      setTimeout(() => {
        if (this.shouldAutoRestart) {
          this.start();
        }
      }, 100);
    }
  }

  /**
   * Handle recognition result
   * @param {SpeechRecognitionEvent} event - Recognition event
   */
  handleResult(event) {
    const results = event.results;
    const lastResult = results[results.length - 1];
    
    if (!lastResult.isFinal) {
      // Show interim results
      this.updateStatus('hearing', lastResult[0].transcript);
      return;
    }
    
    // Get best transcript
    const transcript = lastResult[0].transcript.toLowerCase().trim();
    const confidence = lastResult[0].confidence;
    
    window.logging.info('video', `VoiceSpotting Heard: "${transcript}" (${(confidence * 100).toFixed(1)}%)`);
    
    // Check confidence
    if (confidence < this.confidenceThreshold) {
      window.logging.info('video', 'VoiceSpotting Confidence too low, ignoring');
      return;
    }
    
    // Check cooldown
    const now = Date.now();
    if (now - this.lastCommandTime < this.commandCooldown) {
      window.logging.info('video', 'VoiceSpotting Command cooldown, ignoring');
      return;
    }
    
    // Process command
    this.processCommand(transcript);
  }

  /**
   * Process recognized speech
   * @param {string} transcript - Recognized text
   */
  processCommand(transcript) {
    // Try exact match first
    let command = this.voiceCommands[transcript];
    
    // Try partial match if no exact match
    if (!command) {
      for (const [phrase, cmd] of Object.entries(this.voiceCommands)) {
        if (transcript.includes(phrase) || phrase.includes(transcript)) {
          command = cmd;
          break;
        }
      }
    }
    
    if (!command) {
      window.logging.info('video', `VoiceSpotting Unknown command: "${transcript}"`);
      this.updateStatus('unknown', transcript);
      return;
    }
    
    // Execute command
    this.executeCommand(command, transcript);
    
    // Update tracking
    this.lastCommand = command;
    this.lastCommandTime = Date.now();
  }

  /**
   * Execute a voice command
   * @param {Object} command - Command configuration
   * @param {string} transcript - Original transcript
   */
  executeCommand(command, transcript) {
    window.logging.info('video', `VoiceSpotting Executing: ${command.action}`);
    
    // Show feedback
    this.showFeedback(command.feedback);
    
    // Get current time
    const currentTime = this.app.video?.currentTime || 0;
    
    // Execute action through panel
    if (this.panel && typeof this.panel.executeAction === 'function') {
      this.panel.executeAction(command.action);
    } else {
      // Direct execution
      this.executeDirectAction(command, currentTime);
    }
    
    // Emit event
    this.emit('commandExecuted', { 
      command, 
      transcript, 
      time: currentTime 
    });
  }

  /**
   * Execute action directly
   * @param {Object} command - Command configuration
   * @param {number} time - Current time
   */
  executeDirectAction(command, time) {
    const markerManager = this.app.markerManager;
    
    switch (command.action) {
      case 'addPointMarker':
      case 'addQuoteMarker':
      case 'addTopicMarker':
      case 'addClipMarker':
      case 'addFeatureMarker':
      case 'addHookMarker':
      case 'addChapterMarker':
      case 'addKeyPointMarker':
        if (markerManager) {
          markerManager.addSpotMarker(
            time,
            command.feedback,
            null,
            { markerType: command.markerType || 'spot' }
          );
        }
        break;
        
      case 'setInPoint':
        this.panel?.setInPoint(time);
        break;
        
      case 'setOutPoint':
        this.panel?.setOutPoint(time);
        break;
        
      case 'undoLastMarker':
        this.panel?.undoLastMarker();
        break;
    }
  }

  /**
   * Handle recognition error
   * @param {SpeechRecognitionError} event - Error event
   */
  handleError(event) {
    window.logging.error('video', 'VoiceSpotting Error', { error: event.error });
    
    let message = 'Voice recognition error';
    
    switch (event.error) {
      case 'not-allowed':
        message = 'Microphone access denied';
        this.shouldAutoRestart = false;
        break;
      case 'no-speech':
        message = 'No speech detected';
        break;
      case 'network':
        message = 'Network error';
        break;
      case 'audio-capture':
        message = 'Microphone not available';
        break;
    }
    
    this.updateStatus('error', message);
    this.emit('error', { error: event.error, message });
  }

  /**
   * Handle no match
   */
  handleNoMatch() {
    window.logging.info('video', 'VoiceSpotting No match');
    this.updateStatus('no-match');
  }

  /**
   * Show visual feedback for command
   * @param {string} feedback - Feedback text
   */
  showFeedback(feedback) {
    // Create feedback element if needed
    if (!this.feedbackElement) {
      this.feedbackElement = document.createElement('div');
      this.feedbackElement.className = 'voice-spotting-feedback';
      document.body.appendChild(this.feedbackElement);
    }
    
    // Show feedback
    this.feedbackElement.textContent = feedback;
    this.feedbackElement.classList.add('visible');
    
    // Animate
    this.feedbackElement.classList.remove('pulse');
    void this.feedbackElement.offsetWidth; // Trigger reflow
    this.feedbackElement.classList.add('pulse');
    
    // Hide after delay
    setTimeout(() => {
      this.feedbackElement.classList.remove('visible');
    }, 1500);
  }

  /**
   * Update status display
   * @param {string} status - Status type
   * @param {string} text - Optional text
   */
  updateStatus(status, text = '') {
    // Create status element if needed
    if (!this.statusElement) {
      this.statusElement = document.querySelector('.voice-status') || 
                           document.createElement('div');
      if (!this.statusElement.parentElement) {
        this.statusElement.className = 'voice-status';
        // Would be added to panel in actual implementation
      }
    }
    
    const statusIcons = {
      listening: '🎤',
      hearing: '👂',
      stopped: '🔇',
      error: '⚠️',
      unknown: '❓',
      'no-match': '🤷'
    };
    
    this.statusElement.innerHTML = `
      <span class="status-icon">${statusIcons[status] || '🎤'}</span>
      <span class="status-text">${text || status}</span>
    `;
    
    this.statusElement.className = `voice-status status-${status}`;
    
    this.emit('statusChanged', { status, text });
  }

  /**
   * Get available commands for current template
   * @returns {Object} Commands
   */
  getAvailableCommands() {
    return { ...this.voiceCommands };
  }

  /**
   * Check if voice spotting is supported
   * @returns {boolean} Support status
   */
  isVoiceSupported() {
    return this.isSupported;
  }

  /**
   * Check if currently listening
   * @returns {boolean} Listening status
   */
  isActive() {
    return this.isListening;
  }

  /**
   * Set auto-restart behavior
   * @param {boolean} enabled - Enable auto-restart
   */
  setAutoRestart(enabled) {
    this.shouldAutoRestart = enabled;
  }

  /**
   * Set confidence threshold
   * @param {number} threshold - Threshold (0-1)
   */
  setConfidenceThreshold(threshold) {
    this.confidenceThreshold = Math.max(0, Math.min(1, threshold));
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
    this.stop();
    this.shouldAutoRestart = false;
    
    if (this.feedbackElement) {
      this.feedbackElement.remove();
    }
    
    this.eventListeners = {};
  }
}

export default VoiceSpottingController;











