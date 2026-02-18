/**
 * Preload script for Command HUD
 * Exposes IPC methods for context menu, text input, and agent triggering
 */

const { contextBridge, ipcRenderer } = require('electron');
const DOMPurify = require('dompurify');

// Renamed from 'hudAPI' to 'commandHUD' for clarity.
// window.agentHUD is the canonical task API; window.commandHUD is HUD-window-specific.
contextBridge.exposeInMainWorld('commandHUD', {
  // ==================== EXISTING HUD METHODS ====================

  // Resize the HUD window (for agent UI panels)
  resizeWindow: (width, height) => ipcRenderer.invoke('command-hud:resize', width, height),

  // Dismiss the HUD
  dismiss: () => ipcRenderer.send('hud:dismiss'),

  // Retry a task
  retry: (task) => ipcRenderer.send('hud:retry', task),

  // Get queue stats
  getQueueStats: (queueName) => ipcRenderer.invoke('voice-task-sdk:queue-stats', queueName),

  // Event listeners for HUD state
  onShow: (callback) => ipcRenderer.on('hud:show', () => callback()),
  onHide: (callback) => ipcRenderer.on('hud:hide', () => callback()),
  onTask: (callback) => ipcRenderer.on('hud:task', (_, task) => callback(task)),
  onResult: (callback) => ipcRenderer.on('hud:result', (_, result) => callback(result)),
  onReset: (callback) => ipcRenderer.on('hud:reset', () => callback()),
  onTaskLifecycle: (callback) => ipcRenderer.on('voice-task:lifecycle', (_, event) => callback(event)),

  // ==================== SUBTASK EVENTS ====================
  // Listen for subtask events (spawned by agents during execution)
  onSubtask: (callback) => ipcRenderer.on('subtask:event', (_, subtask) => callback(subtask)),

  // ==================== CONTEXT MENU ====================

  // Show context menu (triggered by right-click)
  showContextMenu: () => ipcRenderer.send('hud:show-context-menu'),

  // Listen for context menu actions
  onShowTextInput: (callback) => ipcRenderer.on('hud:action:text-input', () => callback()),
  onTriggerAgent: (callback) => ipcRenderer.on('hud:action:trigger-agent', (_, agent) => callback(agent)),

  // ==================== TEXT INPUT ====================

  // DEPRECATED: Use window.agentHUD.submitTask() instead (canonical pipeline).
  // Kept as a no-op stub for backward compatibility with tests.
  submitTextCommand: (_text) => {
    console.warn('[PreloadHUD] submitTextCommand is deprecated - use window.agentHUD.submitTask()');
    return Promise.resolve({ deprecated: true });
  },

  // Trigger a specific agent with text
  triggerAgentWithTranscript: (agentId, transcript) => {
    return ipcRenderer.invoke('hud:trigger-agent', { agentId, transcript });
  },

  // ==================== AGENT MANAGEMENT ====================

  // Get list of available agents (local + GSX)
  getAgents: () => ipcRenderer.invoke('agents:list'),

  // Open agent manager window
  openAgentManager: () => ipcRenderer.send('agents:open-manager'),

  // Open settings window
  openSettings: () => ipcRenderer.send('open-settings'),

  // ==================== DISAMBIGUATION ====================

  // Select a disambiguation option by index
  selectDisambiguationOption: (stateId, optionIndex) => {
    return ipcRenderer.invoke('hud:disambiguation:select', { stateId, optionIndex });
  },

  // Resolve disambiguation with voice response
  resolveDisambiguationWithVoice: (stateId, voiceResponse) => {
    return ipcRenderer.invoke('hud:disambiguation:voice', { stateId, voiceResponse });
  },

  // Cancel disambiguation
  cancelDisambiguation: (stateId) => {
    return ipcRenderer.invoke('hud:disambiguation:cancel', { stateId });
  },

  // Listen for disambiguation state
  onDisambiguation: (callback) => {
    ipcRenderer.on('hud:disambiguation', (_, state) => callback(state));
  },

  // Listen for listening state during disambiguation
  onDisambiguationListening: (callback) => {
    ipcRenderer.on('hud:disambiguation:listening', (_, listening) => callback(listening));
  },

  // Listen for voice response during disambiguation
  onDisambiguationVoiceResponse: (callback) => {
    ipcRenderer.on('hud:disambiguation:voice-response', (_, response) => callback(response));
  },

  // ==================== CONTACTS ====================

  // Search contacts by name, email, or alias (returns array of contacts)
  searchContacts: (query, opts = {}) => ipcRenderer.invoke('contacts:search', query, opts),

  // Suggest contacts for autocomplete (partial name/email, excludes already-added)
  suggestContacts: (partial, opts = {}) => ipcRenderer.invoke('contacts:suggest', partial, opts),

  // Resolve guest names/emails to addresses (returns { resolved, unresolved, ambiguous })
  resolveGuests: (guests) => ipcRenderer.invoke('contacts:resolve', guests),

  // List all contacts (opts: { sortBy: 'name' | 'recent' | 'frequent' })
  listContacts: (opts = {}) => ipcRenderer.invoke('contacts:list', opts),

  // Add a new contact ({ name, email, aliases?, calendarUrl?, company?, notes?, source? })
  addContact: (data) => ipcRenderer.invoke('contacts:add', data),

  // Update an existing contact by ID
  updateContact: (id, changes) => ipcRenderer.invoke('contacts:update', id, changes),

  // Delete a contact by ID
  deleteContact: (id) => ipcRenderer.invoke('contacts:delete', id),

  // Get contacts ranked by meeting frequency (opts: { limit, since })
  frequentContacts: (opts = {}) => ipcRenderer.invoke('contacts:frequent', opts),

  // Get meeting history for a contact
  contactMeetings: (emailOrId, opts = {}) => ipcRenderer.invoke('contacts:meetings', emailOrId, opts),

  // Get people frequently in meetings with a contact
  coAttendees: (email, limit) => ipcRenderer.invoke('contacts:co-attendees', email, limit),

  // Ingest calendar events to build the attendance log
  ingestEvents: (events) => ipcRenderer.invoke('contacts:ingest-events', events),

  // ==================== MEETING LINKS ====================

  // Open a URL in the system's default browser (for meeting links)
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // ==================== HTML SANITIZATION ====================

  // Sanitize agent-generated HTML before DOM injection (XSS prevention).
  // Allows layout/styling markup but strips scripts, event handlers, and
  // javascript: URLs. Agents can only produce visual content, not executable code.
  sanitizeHTML: (html) =>
    DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [
        'div',
        'span',
        'p',
        'br',
        'button',
        'img',
        'style',
        'svg',
        'path',
        'polyline',
        'line',
        'circle',
        'rect',
      ],
      ALLOWED_ATTR: [
        'class',
        'style',
        'data-value',
        'data-agent-id',
        'src',
        'alt',
        'title',
        'width',
        'height',
        'viewBox',
        'fill',
        'stroke',
        'stroke-width',
        'd',
        'points',
        'x1',
        'y1',
        'x2',
        'y2',
        'stroke-linecap',
        'stroke-linejoin',
      ],
      ALLOW_DATA_ATTR: true,
    }),
});

// ==========================================
// CENTRALIZED HUD API (shared across tools)
// ==========================================
const { getHudApiMethods } = require('./preload-hud-api');
contextBridge.exposeInMainWorld('agentHUD', getHudApiMethods());

console.log('[PreloadHUD] commandHUD + agentHUD exposed');
