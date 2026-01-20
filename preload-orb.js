/**
 * Preload script for Voice Orb floating window
 * 
 * Exposes APIs for:
 * - Real-time speech transcription (realtimeSpeech)
 * - Voice Task SDK (classification, actions)
 * - Window controls (drag, position)
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose Orb API to renderer
contextBridge.exposeInMainWorld('orbAPI', {
  // ==========================================================================
  // REALTIME SPEECH (from realtime-speech.js)
  // ==========================================================================
  
  /**
   * Connect to OpenAI Realtime API
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  connect: () => ipcRenderer.invoke('realtime-speech:connect'),
  
  /**
   * Disconnect from the API
   * @returns {Promise<void>}
   */
  disconnect: () => ipcRenderer.invoke('realtime-speech:disconnect'),
  
  /**
   * Check connection status
   * @returns {Promise<boolean>}
   */
  isConnected: () => ipcRenderer.invoke('realtime-speech:is-connected'),
  
  /**
   * Send audio chunk (base64 encoded PCM16, 24kHz, mono)
   * @param {string} base64Audio
   * @returns {Promise<void>}
   */
  sendAudio: (base64Audio) => ipcRenderer.invoke('realtime-speech:send-audio', base64Audio),
  
  /**
   * Commit audio buffer (signal end of speech)
   * @returns {Promise<void>}
   */
  commit: () => ipcRenderer.invoke('realtime-speech:commit'),
  
  /**
   * Clear audio buffer
   * @returns {Promise<void>}
   */
  clear: () => ipcRenderer.invoke('realtime-speech:clear'),
  
  /**
   * Listen for transcription events
   * Events: transcript_delta (partial), transcript (final), speech_started, speech_stopped, error
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  onEvent: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('realtime-speech:event', handler);
    return () => ipcRenderer.removeListener('realtime-speech:event', handler);
  },
  
  /**
   * Request microphone permission
   * @returns {Promise<boolean>}
   */
  requestMicPermission: () => ipcRenderer.invoke('speech:request-mic-permission'),
  
  // ==========================================================================
  // VOICE TASK SDK (classification)
  // ==========================================================================
  
  /**
   * Submit transcript for AI classification
   * @param {string} transcript
   * @param {Object} options
   * @returns {Promise<{transcript: string, action?: string, params?: Object}>}
   */
  submit: (transcript, options = {}) => 
    ipcRenderer.invoke('voice-task-sdk:submit', transcript, options),
  
  /**
   * Get SDK status
   * @returns {Promise<{initialized: boolean, version: string}>}
   */
  getStatus: () => ipcRenderer.invoke('voice-task-sdk:status'),
  
  // ==========================================================================
  // WINDOW CONTROLS
  // ==========================================================================
  
  /**
   * Show the orb window
   * @returns {Promise<void>}
   */
  show: () => ipcRenderer.invoke('orb:show'),
  
  /**
   * Hide the orb window
   * @returns {Promise<void>}
   */
  hide: () => ipcRenderer.invoke('orb:hide'),
  
  /**
   * Toggle orb visibility
   * @returns {Promise<void>}
   */
  toggle: () => ipcRenderer.invoke('orb:toggle'),
  
  /**
   * Set orb position
   * @param {number} x
   * @param {number} y
   * @returns {Promise<void>}
   */
  setPosition: (x, y) => ipcRenderer.invoke('orb:position', x, y),
  
  /**
   * Notify that orb was clicked (for panel expansion)
   */
  notifyClicked: () => ipcRenderer.send('orb:clicked')
});

console.log('[Orb Preload] Voice Orb preload script loaded');
