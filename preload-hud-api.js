/**
 * Shared HUD API Preload Module
 *
 * Provides IPC wrappers for the centralized HUD API.
 * Each tool's preload script requires this module and exposes
 * the methods via contextBridge under their chosen namespace.
 *
 * Usage in a tool's preload:
 *   const { getHudApiMethods } = require('./preload-hud-api');
 *   contextBridge.exposeInMainWorld('agentHUD', getHudApiMethods());
 *
 * Or merge into existing API:
 *   const hudMethods = getHudApiMethods();
 *   contextBridge.exposeInMainWorld('myToolAPI', { ...toolMethods, hud: hudMethods });
 *
 * @module PreloadHudApi
 */

const { ipcRenderer } = require('electron');

/**
 * Get all HUD API methods as IPC-backed functions.
 * Each method returns a Promise (via ipcRenderer.invoke) or sets up
 * an event listener (via ipcRenderer.on).
 *
 * @returns {Object} HUD API methods ready for contextBridge
 */
function getHudApiMethods() {
  return {
    // ==================== TASK SUBMISSION ====================

    /**
     * Submit a task scoped to an agent space.
     * @param {string} text - User's input / command
     * @param {Object} options - { spaceId, toolId, metadata }
     * @returns {Promise<{ taskId, queued, error? }>}
     */
    submitTask: (text, options) => ipcRenderer.invoke('hud-api:submit-task', text, options),

    /**
     * Cancel a running task.
     * @param {string} taskId
     * @returns {Promise<{ success }>}
     */
    cancelTask: (taskId) => ipcRenderer.invoke('hud-api:cancel-task', taskId),

    // ==================== HUD ITEMS ====================

    /**
     * Add an item to the HUD.
     * @param {string} toolId
     * @param {Object} item - { type, text, tags, deadline, addedBy, agentId }
     * @returns {Promise<Object>} Full item with id and timestamp
     */
    addItem: (toolId, item) => ipcRenderer.invoke('hud-api:add-item', toolId, item),

    /**
     * Remove an item from the HUD.
     * @param {string} toolId
     * @param {string} itemId
     * @returns {Promise<{ success }>}
     */
    removeItem: (toolId, itemId) => ipcRenderer.invoke('hud-api:remove-item', toolId, itemId),

    /**
     * Get all HUD items for a tool.
     * @param {string} toolId
     * @returns {Promise<Array<Object>>}
     */
    getItems: (toolId) => ipcRenderer.invoke('hud-api:get-items', toolId),

    /**
     * Clear all HUD items for a tool.
     * @param {string} toolId
     * @returns {Promise<{ success }>}
     */
    clearItems: (toolId) => ipcRenderer.invoke('hud-api:clear-items', toolId),

    // ==================== AGENT SPACE MANAGEMENT ====================

    /**
     * Get all agent spaces.
     * @returns {Promise<Array<Object>>}
     */
    getAgentSpaces: () => ipcRenderer.invoke('hud-api:get-agent-spaces'),

    /**
     * Get agents in a specific space.
     * @param {string} spaceId
     * @returns {Promise<Array<Object>>}
     */
    getAgentsInSpace: (spaceId) => ipcRenderer.invoke('hud-api:get-agents-in-space', spaceId),

    /**
     * Enable or disable an agent within a space.
     * @param {string} spaceId
     * @param {string} agentId
     * @param {boolean} enabled
     * @returns {Promise<{ success }>}
     */
    setAgentEnabled: (spaceId, agentId, enabled) =>
      ipcRenderer.invoke('hud-api:set-agent-enabled', spaceId, agentId, enabled),

    /**
     * Get the default agent space for a tool.
     * @param {string} toolId
     * @returns {Promise<string|null>} Space ID
     */
    getDefaultSpace: (toolId) => ipcRenderer.invoke('hud-api:get-default-space', toolId),

    /**
     * Set the default agent space for a tool.
     * @param {string} toolId
     * @param {string} spaceId
     * @returns {Promise<{ success }>}
     */
    setDefaultSpace: (toolId, spaceId) => ipcRenderer.invoke('hud-api:set-default-space', toolId, spaceId),

    /**
     * Create a new agent space.
     * @param {string} name
     * @param {Object} config - { description, agentIds, defaultForTools, allowAllAgents }
     * @returns {Promise<Object>} Created space config
     */
    createAgentSpace: (name, config) => ipcRenderer.invoke('hud-api:create-agent-space', name, config),

    /**
     * Assign an agent to a space.
     * @param {string} agentId
     * @param {string} spaceId
     * @param {Object} config - Optional: { type, endpoint, authToken }
     * @returns {Promise<{ success }>}
     */
    assignAgent: (agentId, spaceId, config) => ipcRenderer.invoke('hud-api:assign-agent', agentId, spaceId, config),

    /**
     * Remove an agent from a space.
     * @param {string} agentId
     * @param {string} spaceId
     * @returns {Promise<{ success }>}
     */
    removeAgent: (agentId, spaceId) => ipcRenderer.invoke('hud-api:remove-agent', agentId, spaceId),

    // ==================== REMOTE AGENTS ====================

    /**
     * Register a remote (GSX-hosted) agent.
     * @param {Object} definition - { id, name, endpoint, authType, authToken, metadata, spaceId }
     * @returns {Promise<Object>} Created agent entry
     */
    registerRemoteAgent: (definition) => ipcRenderer.invoke('hud-api:register-remote-agent', definition),

    /**
     * Test a remote agent's health endpoint.
     * @param {string} agentId
     * @returns {Promise<{ status, latency, error? }>}
     */
    testRemoteAgent: (agentId) => ipcRenderer.invoke('hud-api:test-remote-agent', agentId),

    // ==================== DISAMBIGUATION ====================

    /**
     * User selects a disambiguation option.
     * @param {string} stateId - Disambiguation state ID
     * @param {number} index - Selected option index
     * @returns {Promise<{ taskId, queued }>}
     */
    selectDisambiguationOption: (stateId, index) => ipcRenderer.invoke('hud-api:select-disambiguation', stateId, index),

    /**
     * Cancel a disambiguation prompt.
     * @param {string} stateId
     * @returns {Promise<{ success }>}
     */
    cancelDisambiguation: (stateId) => ipcRenderer.invoke('hud-api:cancel-disambiguation', stateId),

    // ==================== MULTI-TURN CONVERSATION ====================

    /**
     * Respond to an agent's follow-up input request.
     * @param {string} taskId
     * @param {string} response - User's follow-up input
     * @returns {Promise<{ success }>}
     */
    respondToInput: (taskId, response) => ipcRenderer.invoke('hud-api:respond-to-input', taskId, response),

    // ==================== QUEUE STATISTICS ====================

    /**
     * Get queue statistics from the exchange.
     * @returns {Promise<{ pending, active, completed, failed }>}
     */
    getQueueStats: () => ipcRenderer.invoke('hud-api:get-queue-stats'),

    // ==================== TRANSCRIPTION ====================

    /**
     * Transcribe audio via centralized ai-service (main process).
     * @param {ArrayBuffer} audioData - Audio data as ArrayBuffer
     * @param {Object} opts - { language, filename }
     * @returns {Promise<{ text, error? }>}
     */
    transcribeAudio: (audioData, opts) => ipcRenderer.invoke('hud-api:transcribe-audio', audioData, opts),

    // ==================== SPEECH STATE (mic gating) ====================

    /**
     * Notify that TTS playback has started (for mic gating).
     * @returns {Promise<{ success }>}
     */
    speechStarted: () => ipcRenderer.invoke('hud-api:speech-started'),

    /**
     * Notify that TTS playback has ended.
     * @returns {Promise<{ success }>}
     */
    speechEnded: () => ipcRenderer.invoke('hud-api:speech-ended'),

    /**
     * Check if TTS is currently playing (centralized state).
     * @returns {Promise<{ isSpeaking: boolean }>}
     */
    isSpeaking: () => ipcRenderer.invoke('hud-api:is-speaking'),

    // ==================== TRANSCRIPT QUALITY FILTER ====================

    /**
     * Filter a transcript for garbled/hallucinated content before submission.
     * Two-stage: fast heuristic + optional LLM micro-check.
     * @param {string} transcript
     * @returns {Promise<{ pass: boolean, reason: string }>}
     */
    filterTranscript: (transcript) => ipcRenderer.invoke('hud-api:filter-transcript', transcript),

    // ==================== EVENT LISTENERS ====================

    /**
     * Listen for task lifecycle events.
     * @param {Function} callback - (event) => void
     * @returns {Function} Cleanup function to remove listener
     */
    onLifecycle: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('hud-api:lifecycle', handler);
      return () => ipcRenderer.removeListener('hud-api:lifecycle', handler);
    },

    /**
     * Listen for task result events.
     * @param {Function} callback - (result) => void
     * @returns {Function} Cleanup function to remove listener
     */
    onResult: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('hud-api:result', handler);
      return () => ipcRenderer.removeListener('hud-api:result', handler);
    },

    /**
     * Listen for HUD item additions.
     * @param {Function} callback - ({ toolId, item }) => void
     * @returns {Function} Cleanup function to remove listener
     */
    onItemAdded: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('hud-api:item-added', handler);
      return () => ipcRenderer.removeListener('hud-api:item-added', handler);
    },

    /**
     * Listen for HUD item removals.
     * @param {Function} callback - ({ toolId, itemId }) => void
     * @returns {Function} Cleanup function to remove listener
     */
    onItemRemoved: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('hud-api:item-removed', handler);
      return () => ipcRenderer.removeListener('hud-api:item-removed', handler);
    },

    /**
     * Listen for HUD items cleared.
     * @param {Function} callback - ({ toolId }) => void
     * @returns {Function} Cleanup function to remove listener
     */
    onItemsCleared: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('hud-api:items-cleared', handler);
      return () => ipcRenderer.removeListener('hud-api:items-cleared', handler);
    },

    /**
     * Listen for disambiguation events.
     * @param {Function} callback - ({ stateId, taskId, toolId, question, options }) => void
     * @returns {Function} Cleanup function to remove listener
     */
    onDisambiguation: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('hud-api:disambiguation', handler);
      return () => ipcRenderer.removeListener('hud-api:disambiguation', handler);
    },

    /**
     * Listen for needs-input events (agent follow-up questions).
     * @param {Function} callback - ({ taskId, toolId, prompt, agentId }) => void
     * @returns {Function} Cleanup function to remove listener
     */
    onNeedsInput: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('hud-api:needs-input', handler);
      return () => ipcRenderer.removeListener('hud-api:needs-input', handler);
    },

    /**
     * Listen for centralized speech state changes.
     * Fires when TTS starts/stops playing (for mic gating in renderer).
     * @param {Function} callback - ({ isSpeaking: boolean }) => void
     * @returns {Function} Cleanup function to remove listener
     */
    onSpeechState: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('hud-api:speech-state', handler);
      return () => ipcRenderer.removeListener('hud-api:speech-state', handler);
    },
  };
}

// Also export as a standalone preload that can be used as a secondary preload script
// This handles the case where the file is loaded directly as a preload
if (typeof process !== 'undefined' && process.argv?.includes('--standalone-preload')) {
  const { contextBridge } = require('electron');
  contextBridge.exposeInMainWorld('agentHUD', getHudApiMethods());
  console.log('[PreloadHudApi] Standalone HUD API exposed as window.agentHUD');
}

module.exports = { getHudApiMethods };
