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
  onShow: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('hud:show', handler);
    return () => ipcRenderer.removeListener('hud:show', handler);
  },
  onHide: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('hud:hide', handler);
    return () => ipcRenderer.removeListener('hud:hide', handler);
  },
  onTask: (callback) => {
    const handler = (_, task) => callback(task);
    ipcRenderer.on('hud:task', handler);
    return () => ipcRenderer.removeListener('hud:task', handler);
  },
  onResult: (callback) => {
    const handler = (_, result) => callback(result);
    ipcRenderer.on('hud:result', handler);
    return () => ipcRenderer.removeListener('hud:result', handler);
  },
  onReset: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('hud:reset', handler);
    return () => ipcRenderer.removeListener('hud:reset', handler);
  },
  onTaskLifecycle: (callback) => {
    const handler = (_, event) => callback(event);
    ipcRenderer.on('voice-task:lifecycle', handler);
    return () => ipcRenderer.removeListener('voice-task:lifecycle', handler);
  },

  // ==================== SUBTASK EVENTS ====================
  // Listen for subtask events (spawned by agents during execution)
  onSubtask: (callback) => {
    const handler = (_, subtask) => callback(subtask);
    ipcRenderer.on('subtask:event', handler);
    return () => ipcRenderer.removeListener('subtask:event', handler);
  },

  // ==================== CONTEXT MENU ====================

  // Show context menu (triggered by right-click)
  showContextMenu: () => ipcRenderer.send('hud:show-context-menu'),

  // Listen for context menu actions
  onShowTextInput: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('hud:action:text-input', handler);
    return () => ipcRenderer.removeListener('hud:action:text-input', handler);
  },
  onTriggerAgent: (callback) => {
    const handler = (_, agent) => callback(agent);
    ipcRenderer.on('hud:action:trigger-agent', handler);
    return () => ipcRenderer.removeListener('hud:action:trigger-agent', handler);
  },

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
    const handler = (_, state) => callback(state);
    ipcRenderer.on('hud:disambiguation', handler);
    return () => ipcRenderer.removeListener('hud:disambiguation', handler);
  },

  // Listen for listening state during disambiguation
  onDisambiguationListening: (callback) => {
    const handler = (_, listening) => callback(listening);
    ipcRenderer.on('hud:disambiguation:listening', handler);
    return () => ipcRenderer.removeListener('hud:disambiguation:listening', handler);
  },

  // Listen for voice response during disambiguation
  onDisambiguationVoiceResponse: (callback) => {
    const handler = (_, response) => callback(response);
    ipcRenderer.on('hud:disambiguation:voice-response', handler);
    return () => ipcRenderer.removeListener('hud:disambiguation:voice-response', handler);
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
try {
  const { getHudApiMethods } = require('./preload-hud-api');
  contextBridge.exposeInMainWorld('agentHUD', getHudApiMethods());
  console.log('[PreloadHUD] commandHUD + agentHUD exposed');
} catch (hudErr) {
  console.error('[PreloadHUD] FAILED to load agentHUD:', hudErr.message);
  console.error('[PreloadHUD] Stack:', hudErr.stack?.split('\n').slice(0, 3).join(' | '));
  try {
    contextBridge.exposeInMainWorld('agentHUD', {
      submitTask: () => Promise.reject(new Error('HUD API failed to load: ' + hudErr.message)),
      onLifecycle: () => {},
      onResult: () => {},
      onDisambiguation: () => {},
      onNeedsInput: () => {},
    });
  } catch (_) {
    /* already exposed or sandbox issue */
  }
}
