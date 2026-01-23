/**
 * Preload script for GSX Agent Composer UI
 * 
 * Provides IPC bridge between renderer and main process
 * for the chat-based agent builder.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudeCodeAPI', {
  // ==================== Authentication ====================
  
  /**
   * Check if Claude Code is authenticated (logged in)
   * @returns {Promise<{ authenticated: boolean, error?: string }>}
   */
  checkAuth: () => ipcRenderer.invoke('claude-code:check-auth'),
  
  /**
   * Trigger Claude Code login flow (opens Terminal)
   * @returns {Promise<{ success: boolean, message?: string, error?: string }>}
   */
  login: () => ipcRenderer.invoke('claude-code:login'),
  
  // ==================== Agent Types ====================
  
  /**
   * Get available agent types/templates
   * @returns {Promise<Object[]>} Array of agent type templates
   */
  getAgentTypes: () => ipcRenderer.invoke('claude-code:agent-types'),
  
  /**
   * Score all templates against a description (DEPRECATED - use planAgent instead)
   * @param {string} description - The text to match against templates
   * @returns {Promise<Object[]>} Array of { template, score, matchedKeywords }
   */
  scoreTemplates: (description) => ipcRenderer.invoke('agent-composer:score-templates', description),
  
  /**
   * Plan an agent using LLM - analyzes request and recommends approach
   * @param {string} description - What the user wants the agent to do
   * @returns {Promise<{ success: boolean, plan?: Object, error?: string }>}
   */
  planAgent: (description) => ipcRenderer.invoke('agent-composer:plan', description),
  
  // ==================== Chat-Based Agent Building ====================
  
  /**
   * Send a chat message for iterative agent building
   * @param {string} message - User's message
   * @param {Object} context - Context including agentTypeId, currentDraft, messageHistory
   * @returns {Promise<{ success: boolean, response?: string, agentDraft?: Object, error?: string }>}
   */
  chat: (message, context = {}) => ipcRenderer.invoke('gsx-create:chat', message, context),
  
  /**
   * Save the finalized agent to the agent store
   * @param {Object} agentDraft - The agent configuration to save
   * @returns {Promise<{ success: boolean, agent?: Object, error?: string }>}
   */
  saveAgent: (agentDraft) => ipcRenderer.invoke('gsx-create:save-agent', agentDraft),
  
  /**
   * Test an agent with a sample prompt
   * @param {Object} agent - The agent configuration
   * @param {string} testPrompt - The test prompt to send
   * @returns {Promise<{ success: boolean, response?: string, error?: string }>}
   */
  testAgent: (agent, testPrompt) => ipcRenderer.invoke('claude-code:test-agent', agent, testPrompt),
  
  // ==================== Autonomous Testing ====================
  
  /**
   * Run autonomous test - tests, diagnoses failures, fixes, and retries until success
   * @param {Object} agent - The agent configuration
   * @param {string} testPrompt - The test prompt
   * @returns {Promise<{ success: boolean, attempts: number, finalAgent?: Object, history: Array }>}
   */
  autoTest: (agent, testPrompt) => ipcRenderer.invoke('gsx-create:auto-test', agent, testPrompt),
  
  /**
   * Quick test - single attempt, returns immediately
   * @param {Object} agent - The agent configuration  
   * @param {string} testPrompt - The test prompt
   * @returns {Promise<{ success: boolean, verified: boolean, details: string }>}
   */
  quickTest: (agent, testPrompt) => ipcRenderer.invoke('gsx-create:quick-test', agent, testPrompt),
  
  /**
   * Subscribe to autonomous test progress updates
   * @param {Function} callback - Callback for progress updates
   * @returns {Function} Unsubscribe function
   */
  onAutoTestProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('auto-test:progress', handler);
    return () => ipcRenderer.removeListener('auto-test:progress', handler);
  },
  
  // ==================== Version History ====================
  
  /**
   * Get version history for an agent
   * @param {string} agentId - The agent ID
   * @returns {Promise<Array>} Array of version entries
   */
  getVersionHistory: (agentId) => ipcRenderer.invoke('agents:get-versions', agentId),
  
  /**
   * Undo the last change to an agent
   * @param {string} agentId - The agent ID
   * @returns {Promise<Object>} The restored agent
   */
  undoAgent: (agentId) => ipcRenderer.invoke('agents:undo', agentId),
  
  /**
   * Revert agent to a specific version
   * @param {string} agentId - The agent ID
   * @param {number} versionNumber - The version to revert to
   * @returns {Promise<Object>} The restored agent
   */
  revertToVersion: (agentId, versionNumber) => ipcRenderer.invoke('agents:revert', agentId, versionNumber),
  
  /**
   * Compare two versions of an agent
   * @param {string} agentId - The agent ID
   * @param {number} versionA - First version number
   * @param {number} versionB - Second version number
   * @returns {Promise<Object>} Comparison result with changes
   */
  compareVersions: (agentId, versionA, versionB) => ipcRenderer.invoke('agents:compare-versions', agentId, versionA, versionB),
  
  // ==================== Legacy APIs (kept for compatibility) ====================
  
  /**
   * Get all available templates
   * @returns {Promise<Object[]>} Array of templates
   */
  getTemplates: () => ipcRenderer.invoke('claude-code:templates'),
  
  /**
   * Generate an agent from natural language description (one-shot, legacy)
   * @param {string} description - User's description of the agent
   * @param {Object} options - Options including templateId
   * @returns {Promise<{ success: boolean, agent?: Object, error?: string }>}
   */
  generateAgent: (description, options = {}) => ipcRenderer.invoke('claude-code:generate-agent', description, options),
  
  // ==================== Phase 2: Claude Code CLI ====================
  
  /**
   * Check if Claude Code CLI is available
   * @returns {Promise<boolean>}
   */
  isClaudeCodeAvailable: () => ipcRenderer.invoke('claude-code:available'),
  
  /**
   * Run Claude Code CLI with a template
   * @param {string} templateId - Template to use
   * @param {string} prompt - User's prompt
   * @param {Object} options - Options including workingDir
   * @returns {Promise<{ success: boolean, message?: string, error?: string }>}
   */
  runClaudeCode: (templateId, prompt, options = {}) => 
    ipcRenderer.invoke('claude-code:run', templateId, prompt, options),
  
  /**
   * Cancel a running Claude Code process
   * @returns {Promise<boolean>}
   */
  cancelClaudeCode: () => ipcRenderer.invoke('claude-code:cancel'),
  
  /**
   * Subscribe to output events from Claude Code CLI
   * @param {Function} callback - Callback for output events
   * @returns {Function} Unsubscribe function
   */
  onOutput: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('claude-code:output', handler);
    return () => ipcRenderer.removeListener('claude-code:output', handler);
  },
  
  // ==================== Directory Selection ====================
  
  /**
   * Open directory picker dialog
   * @returns {Promise<string|null>} Selected directory path or null
   */
  browseDirectory: () => ipcRenderer.invoke('claude-code:browse-directory'),
  
  // ==================== Window Management ====================
  
  /**
   * Close the Claude Code window
   */
  close: () => ipcRenderer.send('claude-code:close'),
  
  // ==================== Voice Integration ====================
  
  /**
   * Broadcast plan summary to Orb for TTS
   * @param {string} summary - The plan summary to speak
   * @returns {Promise<{ success: boolean }>}
   */
  broadcastPlan: (summary) => ipcRenderer.invoke('agent-composer:broadcast-plan', summary),
  
  /**
   * Notify that agent creation is complete
   * @param {string} agentName - The created agent's name
   * @returns {Promise<{ success: boolean }>}
   */
  notifyCreationComplete: (agentName) => ipcRenderer.invoke('agent-composer:creation-complete', agentName),
  
  /**
   * Subscribe to initial description from voice command
   * @param {Function} callback - Callback receiving { description: string }
   * @returns {Function} Unsubscribe function
   */
  onInit: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('agent-composer:init', handler);
    return () => ipcRenderer.removeListener('agent-composer:init', handler);
  },
  
  /**
   * Subscribe to voice input relayed from Orb
   * @param {Function} callback - Callback receiving { transcript: string }
   * @returns {Function} Unsubscribe function
   */
  onVoiceInput: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('agent-composer:voice-input', handler);
    return () => ipcRenderer.removeListener('agent-composer:voice-input', handler);
  },
});

console.log('[preload-agent-composer] Exposed claudeCodeAPI');
