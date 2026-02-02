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
   * Cancel any in-progress AI response
   * Used when handling commands locally without AI conversation
   * @returns {Promise<{success: boolean}>}
   */
  cancelResponse: () => ipcRenderer.invoke('realtime-speech:cancel-response'),
  
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
  // VOICE TASK SDK (classification, queuing, task management)
  // ==========================================================================
  
  /**
   * Submit transcript for classification and queuing
   * @param {string} transcript
   * @param {Object} options - { priority?: 1|2|3 }
   * @returns {Promise<{transcript, action, params, confidence, queued, taskId, task}>}
   */
  submit: (transcript, options = {}) => 
    ipcRenderer.invoke('voice-task-sdk:submit', transcript, options),
  
  /**
   * Get SDK status
   * @returns {Promise<{initialized: boolean, running: boolean, version: string}>}
   */
  getStatus: () => ipcRenderer.invoke('voice-task-sdk:status'),
  
  /**
   * Get queue statistics
   * @param {string} queueName - Queue name (default: 'voice-commands')
   * @returns {Promise<{pending, running, completed, failed}>}
   */
  getQueueStats: (queueName) => ipcRenderer.invoke('voice-task-sdk:queue-stats', queueName),
  
  /**
   * List all queues with stats
   * @returns {Promise<Array<Queue>>}
   */
  listQueues: () => ipcRenderer.invoke('voice-task-sdk:list-queues'),
  
  /**
   * Get pending tasks in a queue
   * @param {string} queueName
   * @returns {Promise<Array<Task>>}
   */
  getPendingTasks: (queueName) => ipcRenderer.invoke('voice-task-sdk:pending-tasks', queueName),
  
  /**
   * List all tasks (optionally filter by status/queue)
   * @param {Object} filter - { status?, queue?, action?, limit? }
   * @returns {Promise<Array<Task>>}
   */
  listTasks: (filter) => ipcRenderer.invoke('voice-task-sdk:list-tasks', filter),
  
  /**
   * Cancel a running or pending task
   * @param {string} taskId
   * @returns {Promise<boolean>}
   */
  cancelTask: (taskId) => ipcRenderer.invoke('voice-task-sdk:cancel-task', taskId),
  
  /**
   * Pause a queue
   * @param {string} queueName
   * @returns {Promise<boolean>}
   */
  pauseQueue: (queueName) => ipcRenderer.invoke('voice-task-sdk:pause-queue', queueName),
  
  /**
   * Resume a paused queue
   * @param {string} queueName
   * @returns {Promise<boolean>}
   */
  resumeQueue: (queueName) => ipcRenderer.invoke('voice-task-sdk:resume-queue', queueName),
  
  /**
   * Listen for task lifecycle events from SDK
   * Events: queued, started, completed, failed, retry, cancelled, deadletter
   * @param {Function} callback - Called with { type, task, result?, error? }
   * @returns {Function} Unsubscribe function
   */
  onTaskEvent: (callback) => {
    const events = ['voice-task:queued', 'voice-task:started', 'voice-task:completed', 
                    'voice-task:failed', 'voice-task:retry', 'voice-task:cancelled', 
                    'voice-task:deadletter', 'voice-task:progress', 'voice-task:needs-input'];
    const handlers = events.map(event => {
      const handler = (e, data) => callback({ type: event.replace('voice-task:', ''), ...data });
      ipcRenderer.on(event, handler);
      return { event, handler };
    });
    return () => {
      handlers.forEach(({ event, handler }) => {
        ipcRenderer.removeListener(event, handler);
      });
    };
  },
  
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
   * Expand window for text chat
   * @param {string} anchor - Which corner to anchor: 'bottom-right', 'bottom-left', 'top-right', 'top-left'
   * @returns {Promise<void>}
   */
  expandForChat: (anchor = 'bottom-right') => ipcRenderer.invoke('orb:expand-for-chat', anchor),
  
  /**
   * Collapse window when text chat closes (restores to original position)
   * @returns {Promise<void>}
   */
  collapseFromChat: () => ipcRenderer.invoke('orb:collapse-from-chat'),
  
  /**
   * Notify that orb was clicked (for panel expansion)
   */
  notifyClicked: () => ipcRenderer.send('orb:clicked'),
  
  // ==========================================================================
  // TEXT-TO-SPEECH (OpenAI Realtime Voice)
  // ==========================================================================
  
  /**
   * Speak text using OpenAI Realtime TTS (same connection as speech recognition)
   * @param {string} text - Text to speak
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  speak: (text) => ipcRenderer.invoke('realtime-speech:speak', text),
  
  /**
   * Respond to a function call with our agent's result
   * @param {string} callId - The function call ID
   * @param {string} result - The result text for AI to speak
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  respondToFunction: (callId, result) => ipcRenderer.invoke('realtime-speech:respond-to-function', callId, result),
  
  /**
   * Speak text using ElevenLabs TTS (fallback)
   * @param {string} text - Text to speak
   * @param {string} voice - Voice name (default: 'Rachel')
   * @returns {Promise<string|null>} Audio file path or null if failed
   */
  speakElevenLabs: (text, voice = 'Rachel') => ipcRenderer.invoke('voice:speak', text, voice),
  
  /**
   * Check if TTS is available
   * @returns {Promise<{available: boolean}>}
   */
  isTTSAvailable: () => ipcRenderer.invoke('voice:is-available'),
  
  // ==========================================================================
  // COMMAND HUD (task status display)
  // ==========================================================================
  
  /**
   * Show the Command HUD with a task
   * @param {Object} task - Task object with action, params, status, etc.
   * @returns {Promise<void>}
   */
  showHUD: (task) => ipcRenderer.invoke('command-hud:show', task),
  
  /**
   * Hide the Command HUD
   * @returns {Promise<void>}
   */
  hideHUD: () => ipcRenderer.invoke('command-hud:hide'),
  
  /**
   * Update HUD with task status
   * @param {Object} task - Updated task object
   * @returns {Promise<void>}
   */
  updateHUD: (task) => ipcRenderer.invoke('command-hud:task', task),
  
  /**
   * Send result to HUD
   * @param {Object} result - Result object with success, message, error
   * @returns {Promise<void>}
   */
  sendHUDResult: (result) => ipcRenderer.invoke('command-hud:result', result),
  
  /**
   * Listen for HUD retry events
   * @param {Function} callback - Called when user clicks retry
   * @returns {Function} Unsubscribe function
   */
  onHUDRetry: (callback) => {
    const handler = (event, task) => callback(task);
    ipcRenderer.on('hud:retry-task', handler);
    return () => ipcRenderer.removeListener('hud:retry-task', handler);
  },
  
  // ==========================================================================
  // DISAMBIGUATION (clarification flow)
  // ==========================================================================
  
  /**
   * Show disambiguation options in the HUD
   * @param {Object} state - Disambiguation state with question and options
   * @returns {Promise<void>}
   */
  showDisambiguation: (state) => ipcRenderer.invoke('command-hud:disambiguation', state),
  
  /**
   * Cancel pending disambiguation
   * @returns {Promise<void>}
   */
  cancelDisambiguation: () => ipcRenderer.invoke('command-hud:disambiguation:cancel'),
  
  /**
   * Submit a specific action (used after disambiguation)
   * @param {Object} actionData - { action, params, originalTranscript, clarification }
   * @returns {Promise<Object>}
   */
  submitAction: (actionData) => ipcRenderer.invoke('voice-task-sdk:submit-action', actionData),
  
  /**
   * Listen for disambiguation option selection from HUD
   * @param {Function} callback - Called with { optionIndex, option, mergedTranscript }
   * @returns {Function} Unsubscribe function
   */
  onDisambiguationSelected: (callback) => {
    const handler = (event, selection) => callback(selection);
    ipcRenderer.on('orb:disambiguation:selected', handler);
    return () => ipcRenderer.removeListener('orb:disambiguation:selected', handler);
  },
  
  // ==========================================================================
  // AGENT COMPOSER INTEGRATION
  // ==========================================================================
  
  /**
   * Listen for plan summary from Agent Composer (for TTS)
   * @param {Function} callback - Called with { type, summary, agentName, timestamp }
   * @returns {Function} Unsubscribe function
   */
  onPlanSummary: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('agent-composer:plan-summary', handler);
    return () => ipcRenderer.removeListener('agent-composer:plan-summary', handler);
  },
  
  /**
   * Relay voice input to Agent Composer
   * @param {string} transcript - Voice transcript to relay
   * @returns {Promise<boolean>} Whether relay was successful
   */
  relayToComposer: (transcript) => ipcRenderer.invoke('orb:relay-to-composer', transcript),
  
  /**
   * Check if Agent Composer is in creation mode
   * @returns {Promise<boolean>}
   */
  isComposerActive: () => ipcRenderer.invoke('orb:is-composer-active'),
  
  // ==========================================================================
  // WEB SEARCH (from webview-search-service.js via main process)
  // ==========================================================================
  
  /**
   * Perform a web search using the hidden webview
   * @param {string} query - Search query
   * @returns {Promise<{success: boolean, results: Array<{title, url, snippet}>, error?: string}>}
   */
  webSearch: (query) => ipcRenderer.invoke('search:web-query', query),
  
  /**
   * Clear the search cache
   * @returns {Promise<{success: boolean}>}
   */
  clearSearchCache: () => ipcRenderer.invoke('search:clear-cache')
});

console.log('[Orb Preload] Voice Orb preload script loaded with Agent Composer integration');
