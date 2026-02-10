/**
 * Voice Task SDK - Preload Extension
 * 
 * This module extends the Electron preload script to expose the new Voice Task SDK
 * APIs to the renderer process. It's designed to work alongside the existing
 * realtimeSpeech API.
 * 
 * USAGE in preload.js:
 * ```javascript
 * // At the end of preload.js, add:
 * require('./src/voice-task-sdk/preload-extension');
 * ```
 * 
 * This will expose window.voiceTaskSDK with the new SDK methods.
 */

const { contextBridge, ipcRenderer } = require('electron')

// Expose Voice Task SDK API to renderer
contextBridge.exposeInMainWorld('voiceTaskSDK', {
  // ==========================================================================
  // SDK STATUS & CONFIG
  // ==========================================================================
  
  /**
   * Get SDK initialization status
   * @returns {Promise<{initialized: boolean, useNewSpeechService: boolean, version: string}>}
   */
  getStatus: () => ipcRenderer.invoke('voice-task-sdk:status'),
  
  /**
   * Get SDK configuration
   * @returns {Promise<Object>}
   */
  getConfig: () => ipcRenderer.invoke('voice-task-sdk:config'),

  // ==========================================================================
  // TRANSCRIPT SUBMISSION (AI Classification)
  // ==========================================================================
  
  /**
   * Submit a transcript for AI classification and task routing
   * @param {string} transcript - The voice transcript to classify
   * @param {Object} options - Optional configuration
   * @returns {Promise<{transcript: string, action?: string, params?: Object, task?: Object}>}
   */
  submit: (transcript, options = {}) => 
    ipcRenderer.invoke('voice-task-sdk:submit', transcript, options),

  // ==========================================================================
  // ACTIONS (Classifiable intents)
  // ==========================================================================
  
  /**
   * List all registered actions
   * @returns {Promise<Array>}
   */
  listActions: () => ipcRenderer.invoke('voice-task-sdk:list-actions'),

  // ==========================================================================
  // QUEUES (Execution threads)
  // ==========================================================================
  
  /**
   * List all registered queues
   * @returns {Promise<Array>}
   */
  listQueues: () => ipcRenderer.invoke('voice-task-sdk:list-queues'),

  // ==========================================================================
  // AGENTS (Task executors)
  // ==========================================================================
  
  /**
   * List all registered agents
   * @returns {Promise<Array>}
   */
  listAgents: () => ipcRenderer.invoke('voice-task-sdk:list-agents'),

  // ==========================================================================
  // EVENTS
  // ==========================================================================
  
  /**
   * Listen for SDK events
   * Events: 'task:created', 'task:started', 'task:completed', 'task:failed', 'classified'
   * @param {Function} callback - Event handler
   * @returns {Function} Unsubscribe function
   */
  onEvent: (callback) => {
    const handler = (event, data) => callback(data)
    ipcRenderer.on('voice-task-sdk:event', handler)
    return () => ipcRenderer.removeListener('voice-task-sdk:event', handler)
  },

  // ==========================================================================
  // KNOWLEDGE SYSTEM (RAG)
  // ==========================================================================
  
  /**
   * Add knowledge source
   * @param {Object} source - Knowledge source configuration
   * @returns {Promise<{id: string}>}
   */
  addKnowledge: (source) => 
    ipcRenderer.invoke('voice-task-sdk:knowledge:add', source),

  /**
   * Search knowledge base
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @returns {Promise<Array>}
   */
  searchKnowledge: (query, options = {}) => 
    ipcRenderer.invoke('voice-task-sdk:knowledge:search', query, options),

  /**
   * Ask question with RAG
   * @param {string} question - Question to answer
   * @param {Object} options - Options including sourceIds
   * @returns {Promise<{answer: string, sources: Array}>}
   */
  askKnowledge: (question, options = {}) => 
    ipcRenderer.invoke('voice-task-sdk:knowledge:ask', question, options),

  // ==========================================================================
  // VOICE CONTROLS (New SDK voice service)
  // ==========================================================================
  
  voice: {
    /**
     * Start voice listening (uses new SDK speech manager)
     * @returns {Promise<boolean>}
     */
    start: () => ipcRenderer.invoke('voice-task-sdk:voice:start'),
    
    /**
     * Stop voice listening
     * @returns {Promise<void>}
     */
    stop: () => ipcRenderer.invoke('voice-task-sdk:voice:stop'),
    
    /**
     * Get current voice state
     * @returns {Promise<VoiceState>}
     */
    getState: () => ipcRenderer.invoke('voice-task-sdk:voice:state'),
    
    /**
     * Set preferred speech backend
     * @param {'realtime' | 'whisper'} backend
     * @returns {Promise<void>}
     */
    setBackend: (backend) => 
      ipcRenderer.invoke('voice-task-sdk:voice:set-backend', backend),
    
    /**
     * Listen for voice events
     * @param {Function} callback
     * @returns {Function} Unsubscribe function
     */
    onEvent: (callback) => {
      const handler = (event, data) => callback(data)
      ipcRenderer.on('voice-task-sdk:voice:event', handler)
      return () => ipcRenderer.removeListener('voice-task-sdk:voice:event', handler)
    }
  }
})

log.info('voice', '[VoiceTaskSDK] Preload extension loaded - window.voiceTaskSDK available')
