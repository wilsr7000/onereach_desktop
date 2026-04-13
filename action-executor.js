/**
 * Action Executor - Centralized Action Registry and Execution
 *
 * Single source of truth for ALL app actions callable by voice commands,
 * agents, the command palette, native menus, REST API, or other automation.
 *
 * Categories: windows, idw, gsx, agents, settings, modules, tabs,
 *             credentials, budget, ai, voice, video, backup,
 *             dev-tools, learning, help, share, search, system
 *
 * Entry points:
 *   IPC:  action:execute / action:list / action:has / action:info
 *   REST: GET/POST /app/actions (port 47292, via log-server.js)
 *   Code: require('./action-executor').executeAction(type, params)
 */

const { BrowserWindow, ipcMain, clipboard, shell } = require('electron');
const path = require('path');

// ---------------------------------------------------------------------------
// Lazy-require helpers (avoid circular deps and startup cost)
// ---------------------------------------------------------------------------

function getMenuDataManager() {
  try { return require('./menu-data-manager'); } catch (_) { return null; }
}
function getAgentStore() {
  try { return require('./src/voice-task-sdk/agent-store'); } catch (_) { return null; }
}
function getAgentRegistry() {
  try { return require('./packages/agents/agent-registry'); } catch (_) { return null; }
}
function getCredentialManager() {
  try { return require('./credential-manager'); } catch (_) { return null; }
}
function getAIService() {
  try { return require('./lib/ai-service'); } catch (_) { return null; }
}
function getGSXAutologin() {
  try { return require('./lib/gsx-autologin'); } catch (_) { return null; }
}
function getDevToolsBuilder() {
  try { return require('./lib/menu-sections/dev-tools-builder'); } catch (_) { return null; }
}
function getFlowContext() {
  try { return require('./lib/gsx-flow-context'); } catch (_) { return null; }
}
function _getMemoryEditorAPI() {
  try { return require('./lib/memory-editor-api'); } catch (_) { return null; }
}
function getRollbackManager() {
  try { return require('./rollback-manager'); } catch (_) { return null; }
}
function getGSXFileSync() {
  try { return require('./gsx-file-sync'); } catch (_) { return null; }
}
function getExchangeBridge() {
  try { return require('./src/voice-task-sdk/exchange-bridge'); } catch (_) { return null; }
}
function getHudAPI() {
  try { return require('./lib/hud-api'); } catch (_) { return null; }
}
function getAgentMemoryStore() {
  try { return require('./lib/agent-memory-store'); } catch (_) { return null; }
}

function openAIService(serviceName) {
  if (global.mainWindow && !global.mainWindow.isDestroyed()) {
    global.mainWindow.webContents.send('open-ai-service', { service: serviceName });
    return { success: true, message: `Opening ${serviceName}` };
  }
  return { success: false, error: 'Main window not available' };
}

function createStandardWindow(opts) {
  const win = new BrowserWindow({
    width: opts.width || 1000,
    height: opts.height || 700,
    title: opts.title || '',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      ...(opts.preload ? { preload: path.join(__dirname, opts.preload) } : {}),
      ...(opts.sandbox === false ? { sandbox: false } : {}),
      ...(opts.devTools !== undefined ? { devTools: opts.devTools } : {}),
    },
  });
  win.once('ready-to-show', () => { win.show(); });
  win.loadFile(opts.file);
  return win;
}

function sendToMainWindow(channel, data) {
  if (global.mainWindow && !global.mainWindow.isDestroyed()) {
    global.mainWindow.webContents.send(channel, data);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// ACTION REGISTRY
// ---------------------------------------------------------------------------

const ACTION_REGISTRY = {

  // ============================= WINDOWS ====================================

  'open-spaces': {
    category: 'windows',
    description: 'Open Spaces (content organizer)',
    execute: () => {
      if (global.clipboardManager) {
        global.clipboardManager.createClipboardWindow();
        return { success: true, message: 'Spaces opened' };
      }
      return { success: false, error: 'Clipboard manager not available' };
    },
  },

  'open-clipboard': {
    category: 'windows',
    description: 'Open Clipboard (alias for Spaces)',
    execute: () => ACTION_REGISTRY['open-spaces'].execute(),
  },

  'open-video-editor': {
    category: 'windows',
    description: 'Open Video Editor',
    execute: () => {
      const win = createStandardWindow({
        width: 1400, height: 900, title: 'Video Editor',
        preload: 'preload-video-editor.js', file: 'video-editor.html', devTools: true,
      });
      if (global.videoEditor && global.videoEditor.setupIPC) {
        global.videoEditor.setupIPC(win);
      }
      return { success: true, message: 'Video Editor opened' };
    },
  },

  'open-gsx-create': {
    category: 'windows',
    description: 'Open GSX Create (AI coding assistant)',
    execute: () => {
      const { screen } = require('electron');
      const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
      createStandardWindow({
        width: Math.min(1800, sw - 100), height: Math.min(1100, sh - 100),
        title: 'GSX Create', preload: 'preload.js', file: 'aider-ui.html',
      });
      return { success: true, message: 'GSX Create opened' };
    },
  },

  'open-settings': {
    category: 'windows',
    description: 'Open Settings',
    execute: (params = {}) => {
      if (global.openSettingsWindowGlobal) {
        global.openSettingsWindowGlobal(params.section);
        return { success: true, message: 'Settings opened' };
      }
      createStandardWindow({
        width: 800, height: 700, title: 'Settings',
        preload: 'preload.js', file: 'settings.html',
      });
      return { success: true, message: 'Settings opened' };
    },
    optionalParams: ['section'],
  },

  'open-budget': {
    category: 'windows',
    description: 'Open Budget Dashboard',
    execute: () => {
      createStandardWindow({
        width: 900, height: 700, title: 'Budget Dashboard',
        preload: 'preload.js', file: 'budget-dashboard.html',
      });
      return { success: true, message: 'Budget Dashboard opened' };
    },
  },

  'open-app-health': {
    category: 'windows',
    description: 'Open App Health Dashboard',
    execute: () => {
      if (global.openDashboardWindow) {
        global.openDashboardWindow();
      } else {
        createStandardWindow({
          width: 1000, height: 700, title: 'App Health',
          preload: 'preload.js', file: 'app-health-dashboard.html',
        });
      }
      return { success: true, message: 'App Health opened' };
    },
  },

  'open-health-dashboard': {
    category: 'windows',
    description: 'Open App Health Dashboard (alias)',
    execute: () => ACTION_REGISTRY['open-app-health'].execute(),
  },

  'open-agent-manager': {
    category: 'windows',
    description: 'Open Agent Manager',
    execute: () => {
      try {
        const main = require('./main');
        if (main.createAgentManagerWindow) {
          main.createAgentManagerWindow();
          return { success: true, message: 'Agent Manager opened' };
        }
      } catch (_) { /* fallback */ }
      createStandardWindow({
        width: 1000, height: 800, title: 'Agent Manager',
        preload: 'preload-agent-manager.js', file: 'agent-manager.html',
      });
      return { success: true, message: 'Agent Manager opened' };
    },
  },

  'open-recorder': {
    category: 'windows',
    description: 'Open WISER Meeting Recorder',
    execute: (params = {}) => {
      if (global.recorder && global.recorder.open) {
        global.recorder.open(params);
        return { success: true, message: 'Recorder opened' };
      }
      createStandardWindow({
        width: 1200, height: 800, title: 'WISER Meeting',
        preload: 'preload-recorder.js', file: 'recorder.html', sandbox: false,
      });
      return { success: true, message: 'Recorder opened' };
    },
  },

  'open-log-viewer': {
    category: 'windows',
    description: 'Open Event Log Viewer',
    execute: () => {
      createStandardWindow({
        width: 1200, height: 800, title: 'Event Log Viewer',
        preload: 'preload-log-viewer.js', file: 'log-viewer.html',
      });
      return { success: true, message: 'Log Viewer opened' };
    },
  },

  'open-memory-editor': {
    category: 'windows',
    description: 'Open Memory Editor',
    execute: (params = {}) => {
      try {
        const main = require('./main');
        if (main.createMemoryEditorWindow) {
          main.createMemoryEditorWindow(params);
          return { success: true, message: 'Memory Editor opened' };
        }
      } catch (_) { /* fallback */ }
      return { success: false, error: 'Memory Editor not available' };
    },
    optionalParams: ['agentId'],
  },

  'open-idw-store': {
    category: 'windows',
    description: 'Open IDW Store (browse and install IDW environments)',
    execute: () => {
      createStandardWindow({
        width: 900, height: 700, title: 'IDW Store',
        preload: 'preload.js', file: 'idw-store.html',
      });
      return { success: true, message: 'IDW Store opened' };
    },
  },

  'manage-environments': {
    category: 'windows',
    description: 'Open Setup Wizard to manage IDW environments',
    execute: () => {
      if (global.openSetupWizardGlobal) {
        global.openSetupWizardGlobal();
        return { success: true, message: 'Setup Wizard opened' };
      }
      createStandardWindow({
        width: 800, height: 600, title: 'Setup Wizard',
        preload: 'preload.js', file: 'setup-wizard.html',
      });
      return { success: true, message: 'Setup Wizard opened' };
    },
  },

  'open-tutorials': {
    category: 'learning',
    description: 'Open Tutorials browser',
    execute: () => {
      createStandardWindow({
        width: 1000, height: 700, title: 'Tutorials',
        preload: 'preload.js', file: 'tutorials.html',
      });
      return { success: true, message: 'Tutorials opened' };
    },
  },

  'open-learning': {
    category: 'learning',
    description: 'Open a learning module by URL',
    params: ['url'],
    optionalParams: ['title'],
    execute: (params = {}) => {
      const autologin = getGSXAutologin();
      if (autologin && autologin.openLearningWindow) {
        autologin.openLearningWindow(params.url, params.title || 'Learning');
      } else {
        shell.openExternal(params.url);
      }
      return { success: true, message: `Opening ${params.title || 'learning module'}` };
    },
  },

  'open-ai-runtimes': {
    category: 'learning',
    description: 'Open AI Run Times reader',
    execute: () => {
      createStandardWindow({
        width: 1100, height: 800, title: 'AI Run Times',
        preload: 'Flipboard-IDW-Feed/preload.js',
        file: 'Flipboard-IDW-Feed/uxmag.html',
      });
      return { success: true, message: 'AI Run Times opened' };
    },
  },

  'open-extension-setup': {
    category: 'windows',
    description: 'Open Browser Extension Setup guide',
    execute: () => {
      createStandardWindow({
        width: 800, height: 600, title: 'Extension Setup',
        preload: 'preload.js', file: 'extension-setup.html',
      });
      return { success: true, message: 'Extension Setup opened' };
    },
  },

  'open-docs-readme': {
    category: 'learning',
    description: 'Open local README documentation',
    execute: () => {
      createStandardWindow({
        width: 900, height: 700, title: 'Documentation',
        preload: 'preload.js', file: 'docs-readme.html',
      });
      return { success: true, message: 'Documentation opened' };
    },
  },

  'open-docs-ai-insights': {
    category: 'learning',
    description: 'Open AI Run Times Guide documentation',
    execute: () => {
      createStandardWindow({
        width: 900, height: 700, title: 'AI Run Times Guide',
        preload: 'preload.js', file: 'docs-ai-insights.html',
      });
      return { success: true, message: 'AI Run Times Guide opened' };
    },
  },

  'open-docs-spaces-api': {
    category: 'learning',
    description: 'Open Spaces API documentation',
    execute: () => {
      createStandardWindow({
        width: 900, height: 700, title: 'Spaces API Guide',
        preload: 'preload.js', file: 'docs-spaces-api.html',
      });
      return { success: true, message: 'Spaces API Guide opened' };
    },
  },

  'open-online-docs': {
    category: 'learning',
    description: 'Open online documentation in browser',
    execute: () => {
      shell.openExternal('https://onereach.ai');
      return { success: true, message: 'Online docs opened in browser' };
    },
  },

  'open-test-runner': {
    category: 'windows',
    description: 'Open Integrated Test Runner',
    execute: () => {
      createStandardWindow({
        width: 1000, height: 700, title: 'Test Runner',
        preload: 'preload.js', file: 'test-runner.html',
      });
      return { success: true, message: 'Test Runner opened' };
    },
  },

  'open-module-manager': {
    category: 'windows',
    description: 'Open Module Manager UI',
    execute: () => {
      createStandardWindow({
        width: 900, height: 700, title: 'Manage Tools',
        preload: 'preload.js', file: 'module-manager-ui.html',
      });
      return { success: true, message: 'Module Manager opened' };
    },
  },

  'open-claude-code-ui': {
    category: 'windows',
    description: 'Open Agent Composer (Create Agent with AI)',
    execute: (params = {}) => {
      try {
        const main = require('./main');
        if (main.createClaudeCodeWindow) {
          main.createClaudeCodeWindow(params);
          return { success: true, message: 'Agent Composer opened' };
        }
      } catch (_) { /* fallback */ }
      return { success: false, error: 'Agent Composer not available' };
    },
    optionalParams: ['mode', 'existingAgent'],
  },

  'open-claude-terminal': {
    category: 'windows',
    description: 'Open Claude Code terminal for login',
    execute: () => {
      try {
        const main = require('./main');
        if (main.createClaudeTerminalWindow) {
          main.createClaudeTerminalWindow();
          return { success: true, message: 'Claude Code terminal opened' };
        }
      } catch (_) { /* fallback */ }
      return { success: false, error: 'Claude Code terminal not available' };
    },
  },

  // ============================= IDW ========================================

  'open-idw': {
    category: 'idw',
    description: 'Open an IDW environment in a browser tab',
    params: ['url'],
    optionalParams: ['label'],
    execute: (params = {}) => {
      if (sendToMainWindow('open-in-new-tab', params.url)) {
        return { success: true, message: `Opening IDW: ${params.label || params.url}` };
      }
      shell.openExternal(params.url);
      return { success: true, message: `Opening IDW in external browser: ${params.label || params.url}` };
    },
  },

  'open-external-bot': {
    category: 'idw',
    description: 'Open an external bot chat',
    params: ['url'],
    optionalParams: ['label'],
    execute: (params = {}) => {
      if (sendToMainWindow('open-in-new-tab', params.url)) {
        return { success: true, message: `Opening bot: ${params.label || params.url}` };
      }
      shell.openExternal(params.url);
      return { success: true, message: `Opening bot in external browser` };
    },
  },

  'open-image-creator': {
    category: 'idw',
    description: 'Open an image creator tool',
    params: ['url'],
    optionalParams: ['label'],
    execute: (params = {}) => {
      if (sendToMainWindow('open-in-new-tab', params.url)) {
        return { success: true, message: `Opening image creator: ${params.label || params.url}` };
      }
      shell.openExternal(params.url);
      return { success: true, message: 'Opening image creator in external browser' };
    },
  },

  'open-video-creator': {
    category: 'idw',
    description: 'Open a video creator tool',
    params: ['url'],
    optionalParams: ['label'],
    execute: (params = {}) => {
      if (sendToMainWindow('open-in-new-tab', params.url)) {
        return { success: true, message: `Opening video creator: ${params.label || params.url}` };
      }
      shell.openExternal(params.url);
      return { success: true, message: 'Opening video creator in external browser' };
    },
  },

  'open-audio-generator': {
    category: 'idw',
    description: 'Open an audio generator tool',
    params: ['url'],
    optionalParams: ['label'],
    execute: (params = {}) => {
      if (sendToMainWindow('open-in-new-tab', params.url)) {
        return { success: true, message: `Opening audio generator: ${params.label || params.url}` };
      }
      shell.openExternal(params.url);
      return { success: true, message: 'Opening audio generator in external browser' };
    },
  },

  'open-ui-design-tool': {
    category: 'idw',
    description: 'Open a UI design tool',
    params: ['url'],
    optionalParams: ['label'],
    execute: (params = {}) => {
      if (sendToMainWindow('open-in-new-tab', params.url)) {
        return { success: true, message: `Opening UI design tool: ${params.label || params.url}` };
      }
      shell.openExternal(params.url);
      return { success: true, message: 'Opening UI design tool in external browser' };
    },
  },

  'idw-list': {
    category: 'idw',
    description: 'List all configured IDW environments',
    execute: () => {
      const mdm = getMenuDataManager();
      if (mdm && mdm.getIDWEnvironments) {
        return { success: true, data: mdm.getIDWEnvironments() };
      }
      return { success: false, error: 'Menu data manager not available' };
    },
  },

  'idw-add': {
    category: 'idw',
    description: 'Add a new IDW environment',
    params: ['environment'],
    execute: async (params = {}) => {
      const mdm = getMenuDataManager();
      if (mdm && mdm.addIDWEnvironment) {
        const result = await mdm.addIDWEnvironment(params.environment);
        return { success: !result.error, data: result.data, error: result.error };
      }
      return { success: false, error: 'Menu data manager not available' };
    },
  },

  'idw-update': {
    category: 'idw',
    description: 'Update an existing IDW environment',
    params: ['id', 'updates'],
    execute: async (params = {}) => {
      const mdm = getMenuDataManager();
      if (mdm && mdm.updateIDWEnvironment) {
        const result = await mdm.updateIDWEnvironment(params.id, params.updates);
        return { success: !result.error, data: result.data, error: result.error };
      }
      return { success: false, error: 'Menu data manager not available' };
    },
  },

  'idw-remove': {
    category: 'idw',
    description: 'Remove an IDW environment',
    params: ['id'],
    execute: async (params = {}) => {
      const mdm = getMenuDataManager();
      if (mdm && mdm.removeIDWEnvironment) {
        const result = await mdm.removeIDWEnvironment(params.id);
        return { success: !result.error, error: result.error };
      }
      return { success: false, error: 'Menu data manager not available' };
    },
  },

  'idw-store-directory': {
    category: 'idw',
    description: 'Fetch the IDW store directory listing',
    execute: async () => {
      try {
        const main = require('./main');
        if (main.fetchIDWStoreDirectory) {
          const data = await main.fetchIDWStoreDirectory();
          return { success: true, data };
        }
      } catch (_) { /* fallback */ }
      return { success: false, error: 'IDW store directory not available' };
    },
  },

  // ============================= GSX ========================================

  'open-gsx-tool': {
    category: 'gsx',
    description: 'Open a GSX tool in a dedicated window',
    params: ['url'],
    optionalParams: ['title', 'environment'],
    execute: (params = {}) => {
      const autologin = getGSXAutologin();
      if (autologin && autologin.openGSXLargeWindow) {
        autologin.openGSXLargeWindow(params.url, params.title, params.title, null, params.environment);
        return { success: true, message: `Opening GSX tool: ${params.title || params.url}` };
      }
      shell.openExternal(params.url);
      return { success: true, message: 'Opening GSX tool in external browser' };
    },
  },

  'gsx-sync-backup': {
    category: 'gsx',
    description: 'Run a complete GSX file sync backup',
    execute: async () => {
      const sync = getGSXFileSync();
      if (sync && sync.syncCompleteBackup) {
        try {
          await sync.syncCompleteBackup();
          return { success: true, message: 'Complete backup finished' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'GSX file sync not available' };
    },
  },

  'gsx-sync-spaces': {
    category: 'gsx',
    description: 'Sync Spaces data to GSX',
    execute: async () => {
      const sync = getGSXFileSync();
      if (sync && sync.syncClipboardData) {
        try {
          await sync.syncClipboardData();
          return { success: true, message: 'Spaces sync complete' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'GSX file sync not available' };
    },
  },

  'gsx-sync-settings': {
    category: 'gsx',
    description: 'Sync app settings to GSX',
    execute: async () => {
      const sync = getGSXFileSync();
      if (sync && sync.syncAppSettings) {
        try {
          await sync.syncAppSettings();
          return { success: true, message: 'Settings sync complete' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'GSX file sync not available' };
    },
  },

  'gsx-sync-view-history': {
    category: 'gsx',
    description: 'Get GSX file sync history',
    execute: () => {
      const sync = getGSXFileSync();
      if (sync && sync.getHistory) {
        return { success: true, data: sync.getHistory() };
      }
      return { success: false, error: 'GSX file sync not available' };
    },
  },

  'gsx-sync-clear-history': {
    category: 'gsx',
    description: 'Clear GSX file sync history',
    execute: () => {
      const sync = getGSXFileSync();
      if (sync && sync.clearHistory) {
        sync.clearHistory();
        return { success: true, message: 'Sync history cleared' };
      }
      return { success: false, error: 'GSX file sync not available' };
    },
  },

  // ============================= AGENTS =====================================

  'agents-list': {
    category: 'agents',
    description: 'List all local (user-defined) agents',
    execute: () => {
      const store = getAgentStore();
      if (store && store.getLocalAgents) {
        return { success: true, data: store.getLocalAgents() };
      }
      return { success: false, error: 'Agent store not available' };
    },
  },

  'agents-list-builtin': {
    category: 'agents',
    description: 'List built-in agents with enabled state',
    execute: () => {
      const registry = getAgentRegistry();
      if (registry && registry.getAllAgents) {
        const agents = registry.getAllAgents();
        const states = global.settingsManager
          ? global.settingsManager.get('builtinAgentStates') || {}
          : {};
        const list = agents.map(a => ({
          id: a.id, name: a.name, description: a.description,
          categories: a.categories,
          enabled: states[a.id] !== undefined ? states[a.id] : true,
        }));
        return { success: true, data: list };
      }
      return { success: false, error: 'Agent registry not available' };
    },
  },

  'agents-create': {
    category: 'agents',
    description: 'Create a new local agent',
    params: ['agentData'],
    execute: async (params = {}) => {
      const store = getAgentStore();
      if (store && store.createAgent) {
        try {
          const agent = await store.createAgent(params.agentData);
          return { success: true, data: agent, message: `Agent "${agent.name}" created` };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Agent store not available' };
    },
  },

  'agents-update': {
    category: 'agents',
    description: 'Update an existing agent',
    params: ['id', 'updates'],
    execute: async (params = {}) => {
      const store = getAgentStore();
      if (store && store.updateAgent) {
        try {
          const agent = await store.updateAgent(params.id, params.updates);
          return { success: true, data: agent, message: 'Agent updated' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Agent store not available' };
    },
  },

  'agents-delete': {
    category: 'agents',
    description: 'Delete an agent',
    params: ['id'],
    execute: async (params = {}) => {
      const store = getAgentStore();
      if (store && store.deleteAgent) {
        try {
          await store.deleteAgent(params.id);
          return { success: true, message: 'Agent deleted' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Agent store not available' };
    },
  },

  'agents-execute': {
    category: 'agents',
    description: 'Execute an agent with a phrase',
    params: ['agentId', 'phrase'],
    execute: async (params = {}) => {
      const store = getAgentStore();
      const registry = getAgentRegistry();
      let agent = store ? store.getAgent(params.agentId) : null;
      if (!agent && registry) agent = registry.getAgent(params.agentId);
      if (!agent) return { success: false, error: `Agent not found: ${params.agentId}` };
      try {
        if (agent.initialize) await agent.initialize();
        const result = await agent.execute({ id: params.agentId, content: params.phrase });
        return { success: true, data: result };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  'agents-test-phrase': {
    category: 'agents',
    description: 'Test how well a phrase matches a specific agent',
    params: ['agentId', 'phrase'],
    execute: async (params = {}) => {
      try {
        const { evaluateAgentBid } = require('./src/voice-task-sdk/unified-bidder');
        const store = getAgentStore();
        const registry = getAgentRegistry();
        let agent = store ? store.getAgent(params.agentId) : null;
        if (!agent && registry) agent = registry.getAgent(params.agentId);
        if (!agent) return { success: false, error: `Agent not found: ${params.agentId}` };
        const bid = await evaluateAgentBid(agent, params.phrase);
        return { success: true, data: bid };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  'agents-test-phrase-all': {
    category: 'agents',
    description: 'Test a phrase against all agents and rank matches',
    params: ['phrase'],
    execute: async (params = {}) => {
      try {
        const { evaluateAgentBid } = require('./src/voice-task-sdk/unified-bidder');
        const store = getAgentStore();
        const agents = store ? store.getAllAgents() : [];
        const results = [];
        for (const agent of agents) {
          try {
            const bid = await evaluateAgentBid(agent, params.phrase);
            results.push({ agentId: agent.id, name: agent.name, bid });
          } catch (_) { /* skip */ }
        }
        results.sort((a, b) => (b.bid?.confidence || 0) - (a.bid?.confidence || 0));
        return { success: true, data: results };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  'agents-set-builtin-enabled': {
    category: 'agents',
    description: 'Enable or disable a built-in agent',
    params: ['agentId', 'enabled'],
    execute: (params = {}) => {
      if (!global.settingsManager) return { success: false, error: 'Settings not available' };
      const states = global.settingsManager.get('builtinAgentStates') || {};
      states[params.agentId] = !!params.enabled;
      global.settingsManager.set('builtinAgentStates', states);
      return { success: true, message: `Built-in agent ${params.agentId} ${params.enabled ? 'enabled' : 'disabled'}` };
    },
  },

  'agents-enhance': {
    category: 'agents',
    description: 'Open Agent Composer to enhance an existing agent',
    params: ['agentId'],
    execute: (params = {}) => {
      const store = getAgentStore();
      const agent = store ? store.getAgent(params.agentId) : null;
      if (!agent) return { success: false, error: `Agent not found: ${params.agentId}` };
      return ACTION_REGISTRY['open-claude-code-ui'].execute({ mode: 'enhance', existingAgent: agent });
    },
  },

  'agents-get-stats': {
    category: 'agents',
    description: 'Get execution statistics for an agent',
    params: ['agentId'],
    execute: (params = {}) => {
      try {
        const stats = require('./src/voice-task-sdk/agent-stats');
        return { success: true, data: stats.getStats(params.agentId) };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  'agents-get-all-stats': {
    category: 'agents',
    description: 'Get execution statistics for all agents',
    execute: () => {
      try {
        const stats = require('./src/voice-task-sdk/agent-stats');
        return { success: true, data: stats.getAllStats() };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  'agents-get-bid-history': {
    category: 'agents',
    description: 'Get recent bid/auction history',
    optionalParams: ['limit'],
    execute: (params = {}) => {
      try {
        const stats = require('./src/voice-task-sdk/agent-stats');
        return { success: true, data: stats.getBidHistory(params.limit || 50) };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  'agents-version-history': {
    category: 'agents',
    description: 'Get version history for an agent',
    params: ['agentId'],
    execute: (params = {}) => {
      const store = getAgentStore();
      if (store && store.getVersionHistory) {
        return { success: true, data: store.getVersionHistory(params.agentId) };
      }
      return { success: false, error: 'Agent store not available' };
    },
  },

  'agents-revert': {
    category: 'agents',
    description: 'Revert an agent to a previous version',
    params: ['agentId', 'versionNumber'],
    execute: async (params = {}) => {
      const store = getAgentStore();
      if (store && store.revertToVersion) {
        try {
          const agent = await store.revertToVersion(params.agentId, params.versionNumber);
          return { success: true, data: agent, message: 'Agent reverted' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Agent store not available' };
    },
  },

  'agents-memory-list': {
    category: 'agents',
    description: 'List all agent memories',
    execute: () => {
      const memStore = getAgentMemoryStore();
      if (memStore && memStore.listAgentMemories) {
        return { success: true, data: memStore.listAgentMemories() };
      }
      return { success: false, error: 'Agent memory store not available' };
    },
  },

  'agents-memory-load': {
    category: 'agents',
    description: 'Load memory content for an agent',
    params: ['agentId'],
    execute: (params = {}) => {
      const memStore = getAgentMemoryStore();
      if (memStore && memStore.getAgentMemory) {
        return { success: true, data: memStore.getAgentMemory(params.agentId) };
      }
      return { success: false, error: 'Agent memory store not available' };
    },
  },

  'agents-memory-save': {
    category: 'agents',
    description: 'Save memory content for an agent',
    params: ['agentId', 'content'],
    execute: (params = {}) => {
      const memStore = getAgentMemoryStore();
      if (memStore && memStore.saveAgentMemory) {
        memStore.saveAgentMemory(params.agentId, params.content);
        return { success: true, message: 'Agent memory saved' };
      }
      return { success: false, error: 'Agent memory store not available' };
    },
  },

  'agents-memory-delete': {
    category: 'agents',
    description: 'Delete memory for an agent',
    params: ['agentId'],
    execute: (params = {}) => {
      const memStore = getAgentMemoryStore();
      if (memStore && memStore.deleteAgentMemory) {
        memStore.deleteAgentMemory(params.agentId);
        return { success: true, message: 'Agent memory deleted' };
      }
      return { success: false, error: 'Agent memory store not available' };
    },
  },

  'agents-gsx-list-connections': {
    category: 'agents',
    description: 'List GSX agent connections',
    execute: () => {
      const store = getAgentStore();
      if (store && store.getGSXConnections) {
        return { success: true, data: store.getGSXConnections() };
      }
      return { success: false, error: 'Agent store not available' };
    },
  },

  'agents-gsx-add-connection': {
    category: 'agents',
    description: 'Add a GSX agent connection',
    params: ['connData'],
    execute: async (params = {}) => {
      const store = getAgentStore();
      if (store && store.addGSXConnection) {
        try {
          const conn = await store.addGSXConnection(params.connData);
          return { success: true, data: conn, message: 'GSX connection added' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Agent store not available' };
    },
  },

  'agents-gsx-update-connection': {
    category: 'agents',
    description: 'Update a GSX agent connection',
    params: ['id', 'updates'],
    execute: async (params = {}) => {
      const store = getAgentStore();
      if (store && store.updateGSXConnection) {
        try {
          const conn = await store.updateGSXConnection(params.id, params.updates);
          return { success: true, data: conn, message: 'GSX connection updated' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Agent store not available' };
    },
  },

  'agents-gsx-delete-connection': {
    category: 'agents',
    description: 'Delete a GSX agent connection',
    params: ['id'],
    execute: async (params = {}) => {
      const store = getAgentStore();
      if (store && store.deleteGSXConnection) {
        try {
          await store.deleteGSXConnection(params.id);
          return { success: true, message: 'GSX connection deleted' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Agent store not available' };
    },
  },

  'agents-gsx-test-connection': {
    category: 'agents',
    description: 'Test a GSX agent connection',
    params: ['id'],
    execute: async (params = {}) => {
      const store = getAgentStore();
      if (store && store.testGSXConnection) {
        try {
          const result = await store.testGSXConnection(params.id);
          return { success: true, data: result };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Agent store not available' };
    },
  },

  // ============================= SETTINGS ===================================

  'settings-get-all': {
    category: 'settings',
    description: 'Get all application settings',
    execute: () => {
      if (global.settingsManager) {
        const settings = global.settingsManager.getAll();
        const redacted = { ...settings };
        for (const key of Object.keys(redacted)) {
          if (/apiKey|secret|Token|password/i.test(key) && redacted[key]) {
            redacted[key] = '***REDACTED***';
          }
        }
        return { success: true, data: redacted };
      }
      return { success: false, error: 'Settings manager not available' };
    },
  },

  'settings-save': {
    category: 'settings',
    description: 'Save multiple settings at once',
    params: ['settings'],
    execute: (params = {}) => {
      if (global.settingsManager) {
        global.settingsManager.update(params.settings);
        return { success: true, message: 'Settings saved' };
      }
      return { success: false, error: 'Settings manager not available' };
    },
  },

  'settings-get': {
    category: 'settings',
    description: 'Get a single setting value',
    params: ['key'],
    execute: (params = {}) => {
      if (global.settingsManager) {
        const value = global.settingsManager.get(params.key);
        if (/apiKey|secret|Token|password/i.test(params.key) && value) {
          return { success: true, data: '***REDACTED***' };
        }
        return { success: true, data: value };
      }
      return { success: false, error: 'Settings manager not available' };
    },
  },

  'settings-set': {
    category: 'settings',
    description: 'Set a single setting value',
    params: ['key', 'value'],
    execute: (params = {}) => {
      if (global.settingsManager) {
        global.settingsManager.set(params.key, params.value);
        return { success: true, message: `Setting "${params.key}" updated` };
      }
      return { success: false, error: 'Settings manager not available' };
    },
  },

  'settings-test-llm': {
    category: 'settings',
    description: 'Test LLM API connection',
    optionalParams: ['provider'],
    execute: async (params = {}) => {
      const ai = getAIService();
      if (ai && ai.testConnection) {
        try {
          const result = await ai.testConnection(params.provider);
          return { success: true, data: result };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'AI service not available' };
    },
  },

  // ============================= MODULES ====================================

  'modules-list': {
    category: 'modules',
    description: 'List installed modules',
    execute: () => {
      if (global.moduleManager) {
        return { success: true, data: global.moduleManager.getInstalledModules() };
      }
      return { success: false, error: 'Module manager not available' };
    },
  },

  'modules-install-url': {
    category: 'modules',
    description: 'Install a module from a URL',
    params: ['url'],
    execute: async (params = {}) => {
      if (global.moduleManager) {
        try {
          const result = await global.moduleManager.installModuleFromUrl(params.url);
          return { success: true, data: result, message: 'Module installed' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Module manager not available' };
    },
  },

  'modules-install-file': {
    category: 'modules',
    description: 'Install a module from a local zip file',
    params: ['filePath'],
    execute: async (params = {}) => {
      if (global.moduleManager) {
        try {
          const result = await global.moduleManager.installModuleFromZip(params.filePath);
          return { success: true, data: result, message: 'Module installed' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Module manager not available' };
    },
  },

  'modules-remove': {
    category: 'modules',
    description: 'Remove an installed module',
    params: ['moduleId'],
    execute: async (params = {}) => {
      if (global.moduleManager) {
        try {
          await global.moduleManager.removeModule(params.moduleId);
          return { success: true, message: `Module "${params.moduleId}" removed` };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Module manager not available' };
    },
  },

  'modules-open': {
    category: 'modules',
    description: 'Open an installed module',
    params: ['moduleId'],
    execute: (params = {}) => {
      if (global.moduleManager) {
        global.moduleManager.openModule(params.moduleId);
        return { success: true, message: `Module "${params.moduleId}" opened` };
      }
      return { success: false, error: 'Module manager not available' };
    },
  },

  'web-tools-list': {
    category: 'modules',
    description: 'List installed web tools',
    execute: () => {
      if (global.moduleManager) {
        return { success: true, data: global.moduleManager.getWebTools() };
      }
      return { success: false, error: 'Module manager not available' };
    },
  },

  'web-tools-add': {
    category: 'modules',
    description: 'Add a web tool',
    params: ['tool'],
    execute: async (params = {}) => {
      if (global.moduleManager) {
        try {
          const result = await global.moduleManager.addWebTool(params.tool);
          return { success: true, data: result, message: 'Web tool added' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Module manager not available' };
    },
  },

  'web-tools-open': {
    category: 'modules',
    description: 'Open a web tool',
    params: ['toolId'],
    execute: (params = {}) => {
      if (global.moduleManager) {
        global.moduleManager.openWebTool(params.toolId);
        return { success: true, message: `Web tool "${params.toolId}" opened` };
      }
      return { success: false, error: 'Module manager not available' };
    },
  },

  'web-tools-delete': {
    category: 'modules',
    description: 'Delete a web tool',
    params: ['toolId'],
    execute: async (params = {}) => {
      if (global.moduleManager) {
        try {
          await global.moduleManager.deleteWebTool(params.toolId);
          return { success: true, message: `Web tool "${params.toolId}" deleted` };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Module manager not available' };
    },
  },

  // ============================= TABS =======================================

  'tab-open': {
    category: 'tabs',
    description: 'Open a URL in a new browser tab',
    params: ['url'],
    execute: (params = {}) => {
      if (sendToMainWindow('open-in-new-tab', params.url)) {
        return { success: true, message: `Opening tab: ${params.url}` };
      }
      return { success: false, error: 'Main window not available' };
    },
  },

  'tab-list': {
    category: 'tabs',
    description: 'List open browser tabs',
    execute: async () => {
      try {
        const main = require('./main');
        if (main.getTabList) {
          const tabs = await main.getTabList();
          return { success: true, data: tabs };
        }
      } catch (_) { /* fallback */ }
      return { success: false, error: 'Tab listing not available' };
    },
  },

  // ============================= CREDENTIALS ================================

  'credentials-list': {
    category: 'credentials',
    description: 'List saved credentials (domain and username only, no passwords)',
    execute: async () => {
      const cm = getCredentialManager();
      if (cm && cm.listCredentials) {
        try {
          const creds = await cm.listCredentials();
          return { success: true, data: creds };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Credential manager not available' };
    },
  },

  'credentials-save': {
    category: 'credentials',
    description: 'Save a credential for an IDW domain',
    params: ['url', 'username', 'password'],
    optionalParams: ['idwName'],
    execute: async (params = {}) => {
      const cm = getCredentialManager();
      if (cm && cm.saveCredential) {
        try {
          const ok = await cm.saveCredential(params.url, params.username, params.password, params.idwName);
          return { success: ok, message: ok ? 'Credential saved' : 'Failed to save credential' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Credential manager not available' };
    },
  },

  'credentials-delete': {
    category: 'credentials',
    description: 'Delete a saved credential',
    params: ['accountKey'],
    execute: async (params = {}) => {
      const cm = getCredentialManager();
      if (cm && cm.deleteCredential) {
        try {
          const ok = await cm.deleteCredential(params.accountKey);
          return { success: ok, message: ok ? 'Credential deleted' : 'Credential not found' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Credential manager not available' };
    },
  },

  'credentials-check': {
    category: 'credentials',
    description: 'Check if a credential exists for a URL',
    params: ['url'],
    execute: async (params = {}) => {
      const cm = getCredentialManager();
      if (cm && cm.hasCredential) {
        try {
          const has = await cm.hasCredential(params.url);
          return { success: true, data: { hasCredential: has } };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Credential manager not available' };
    },
  },

  'onereach-credentials-status': {
    category: 'credentials',
    description: 'Check if unified OneReach credentials are configured',
    execute: async () => {
      const cm = getCredentialManager();
      if (cm && cm.hasOneReachCredentials) {
        try {
          const status = await cm.hasOneReachCredentials();
          return { success: true, data: status };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Credential manager not available' };
    },
  },

  // ============================= BUDGET =====================================

  'budget-summary': {
    category: 'budget',
    description: 'Get AI cost summary',
    optionalParams: ['period'],
    execute: async (params = {}) => {
      if (global.budgetTracker && global.budgetTracker.getCostSummary) {
        try {
          const data = await global.budgetTracker.getCostSummary(params.period || 'daily');
          return { success: true, data };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Budget tracker not available' };
    },
  },

  'budget-get-limits': {
    category: 'budget',
    description: 'Get all budget limits',
    execute: async () => {
      if (global.budgetTracker && global.budgetTracker.getAllBudgetLimits) {
        try {
          return { success: true, data: await global.budgetTracker.getAllBudgetLimits() };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Budget tracker not available' };
    },
  },

  'budget-set-limit': {
    category: 'budget',
    description: 'Set a budget limit for a category',
    params: ['category', 'limit'],
    execute: async (params = {}) => {
      if (global.budgetTracker && global.budgetTracker.setBudgetLimit) {
        try {
          await global.budgetTracker.setBudgetLimit(params.category, params.limit);
          return { success: true, message: `Budget limit for "${params.category}" set to ${params.limit}` };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Budget tracker not available' };
    },
  },

  'budget-usage-history': {
    category: 'budget',
    description: 'Get AI usage history',
    optionalParams: ['period'],
    execute: async (params = {}) => {
      if (global.budgetTracker && global.budgetTracker.getUsageHistory) {
        try {
          return { success: true, data: await global.budgetTracker.getUsageHistory(params.period) };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Budget tracker not available' };
    },
  },

  'budget-stats-by-feature': {
    category: 'budget',
    description: 'Get cost breakdown by feature',
    execute: async () => {
      if (global.budgetTracker && global.budgetTracker.getStatsByFeature) {
        try {
          return { success: true, data: await global.budgetTracker.getStatsByFeature() };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Budget tracker not available' };
    },
  },

  'budget-stats-by-provider': {
    category: 'budget',
    description: 'Get cost breakdown by AI provider',
    execute: async () => {
      if (global.budgetTracker && global.budgetTracker.getStatsByProvider) {
        try {
          return { success: true, data: await global.budgetTracker.getStatsByProvider() };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Budget tracker not available' };
    },
  },

  'budget-stats-by-model': {
    category: 'budget',
    description: 'Get cost breakdown by AI model',
    execute: async () => {
      if (global.budgetTracker && global.budgetTracker.getStatsByModel) {
        try {
          return { success: true, data: await global.budgetTracker.getStatsByModel() };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Budget tracker not available' };
    },
  },

  // ============================= AI =========================================

  'ai-chat': {
    category: 'ai',
    description: 'Run an AI chat completion',
    params: ['messages'],
    optionalParams: ['profile', 'system', 'maxTokens', 'temperature', 'jsonMode', 'feature'],
    execute: async (params = {}) => {
      const ai = getAIService();
      if (!ai) return { success: false, error: 'AI service not available' };
      try {
        const result = await ai.chat({
          messages: params.messages,
          profile: params.profile || 'fast',
          system: params.system,
          maxTokens: params.maxTokens,
          temperature: params.temperature,
          jsonMode: params.jsonMode,
          feature: params.feature || 'action-api',
        });
        return { success: true, data: { content: result.content, usage: result.usage } };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  'ai-complete': {
    category: 'ai',
    description: 'Run a text completion (convenience wrapper)',
    params: ['prompt'],
    optionalParams: ['profile'],
    execute: async (params = {}) => {
      const ai = getAIService();
      if (!ai) return { success: false, error: 'AI service not available' };
      try {
        const text = await ai.complete(params.prompt, { profile: params.profile || 'fast' });
        return { success: true, data: text };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  'ai-json': {
    category: 'ai',
    description: 'Run an AI completion that returns parsed JSON',
    params: ['prompt'],
    optionalParams: ['profile'],
    execute: async (params = {}) => {
      const ai = getAIService();
      if (!ai) return { success: false, error: 'AI service not available' };
      try {
        const obj = await ai.json(params.prompt, { profile: params.profile || 'fast' });
        return { success: true, data: obj };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  'ai-vision': {
    category: 'ai',
    description: 'Analyze an image with AI vision',
    params: ['imageData', 'prompt'],
    optionalParams: ['profile'],
    execute: async (params = {}) => {
      const ai = getAIService();
      if (!ai) return { success: false, error: 'AI service not available' };
      try {
        const result = await ai.vision(params.imageData, params.prompt, { profile: params.profile || 'vision' });
        return { success: true, data: result };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  'ai-embed': {
    category: 'ai',
    description: 'Generate text embeddings',
    params: ['text'],
    execute: async (params = {}) => {
      const ai = getAIService();
      if (!ai) return { success: false, error: 'AI service not available' };
      try {
        const result = await ai.embed(params.text, { profile: 'embedding' });
        return { success: true, data: result };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  'ai-transcribe': {
    category: 'ai',
    description: 'Transcribe audio to text',
    params: ['audioPath'],
    execute: async (params = {}) => {
      const ai = getAIService();
      if (!ai) return { success: false, error: 'AI service not available' };
      try {
        const fs = require('fs');
        const buffer = fs.readFileSync(params.audioPath);
        const result = await ai.transcribe(buffer, {
          responseFormat: 'verbose_json',
          timestampGranularities: ['word'],
        });
        return { success: true, data: { text: result.text, words: result.words, duration: result.duration } };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  'ai-image-generate': {
    category: 'ai',
    description: 'Generate an image with DALL-E',
    params: ['prompt'],
    optionalParams: ['model', 'size', 'quality'],
    execute: async (params = {}) => {
      const ai = getAIService();
      if (!ai) return { success: false, error: 'AI service not available' };
      try {
        const result = await ai.imageGenerate(params.prompt, {
          model: params.model || 'dall-e-3',
          size: params.size || '1024x1024',
          quality: params.quality || 'standard',
        });
        return { success: true, data: result };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  'ai-status': {
    category: 'ai',
    description: 'Get AI service status and circuit breaker state',
    execute: () => {
      const ai = getAIService();
      if (!ai) return { success: false, error: 'AI service not available' };
      try {
        return { success: true, data: ai.getStatus ? ai.getStatus() : { available: true } };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  'ai-profiles': {
    category: 'ai',
    description: 'Get current AI model profile configuration',
    execute: () => {
      const ai = getAIService();
      if (!ai) return { success: false, error: 'AI service not available' };
      try {
        return { success: true, data: ai.getProfiles ? ai.getProfiles() : {} };
      } catch (e) {
        return { success: false, error: e.message };
      }
    },
  },

  // ============================= VOICE / HUD ================================

  'voice-submit-task': {
    category: 'voice',
    description: 'Submit a task to the voice/agent pipeline',
    params: ['text'],
    optionalParams: ['targetAgentId', 'spaceId'],
    execute: async (params = {}) => {
      const hud = getHudAPI();
      if (hud && hud.submitTask) {
        try {
          const result = await hud.submitTask(params.text, {
            targetAgentId: params.targetAgentId,
            spaceId: params.spaceId,
          });
          return { success: true, data: result };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      const bridge = getExchangeBridge();
      if (bridge && bridge.processSubmit) {
        try {
          const result = await bridge.processSubmit(params.text, {
            agentFilter: params.targetAgentId,
            spaceId: params.spaceId,
          });
          return { success: true, data: result };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Voice/agent pipeline not available' };
    },
  },

  'voice-orb-show': {
    category: 'voice',
    description: 'Show the Voice Orb',
    execute: () => {
      if (global.showOrbWindow) {
        global.showOrbWindow();
        return { success: true, message: 'Voice Orb shown' };
      }
      return { success: false, error: 'Voice Orb not available' };
    },
  },

  'voice-orb-hide': {
    category: 'voice',
    description: 'Hide the Voice Orb',
    execute: () => {
      if (global.hideOrbWindow) {
        global.hideOrbWindow();
        return { success: true, message: 'Voice Orb hidden' };
      }
      return { success: false, error: 'Voice Orb not available' };
    },
  },

  'voice-orb-toggle': {
    category: 'voice',
    description: 'Toggle the Voice Orb visibility',
    execute: () => {
      try {
        const main = require('./main');
        if (main.toggleOrbWindow) {
          main.toggleOrbWindow();
          return { success: true, message: 'Voice Orb toggled' };
        }
      } catch (_) { /* fallback */ }
      return { success: false, error: 'Voice Orb not available' };
    },
  },

  'voice-exchange-status': {
    category: 'voice',
    description: 'Get the agent exchange bridge status',
    execute: () => {
      const bridge = getExchangeBridge();
      if (bridge) {
        return {
          success: true,
          data: {
            running: bridge.isRunning ? bridge.isRunning() : false,
            port: bridge.getExchangePort ? bridge.getExchangePort() : null,
            url: bridge.getExchangeUrl ? bridge.getExchangeUrl() : null,
          },
        };
      }
      return { success: false, error: 'Exchange bridge not available' };
    },
  },

  // ============================= VIDEO ======================================

  'video-get-info': {
    category: 'video',
    description: 'Get media file information',
    params: ['inputPath'],
    execute: async (params = {}) => {
      if (global.videoEditor && global.videoEditor.getInfo) {
        try {
          const info = await global.videoEditor.getInfo(params.inputPath);
          return { success: true, data: info };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Video editor not available' };
    },
  },

  'video-transcribe': {
    category: 'video',
    description: 'Transcribe audio from a video/audio file',
    params: ['inputPath'],
    execute: async (params = {}) => {
      if (global.videoEditor && global.videoEditor.transcribe) {
        try {
          const result = await global.videoEditor.transcribe(params.inputPath);
          return { success: true, data: result };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Video editor not available' };
    },
  },

  'video-trim': {
    category: 'video',
    description: 'Trim a video/audio file',
    params: ['inputPath', 'startTime', 'endTime'],
    optionalParams: ['outputPath'],
    execute: async (params = {}) => {
      if (global.videoEditor && global.videoEditor.trim) {
        try {
          const result = await global.videoEditor.trim(
            params.inputPath, params.startTime, params.endTime, params.outputPath
          );
          return { success: true, data: result };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }
      return { success: false, error: 'Video editor not available' };
    },
  },

  // ============================= BACKUP =====================================

  'backup-list': {
    category: 'backup',
    description: 'List available app backups',
    execute: () => {
      const rm = getRollbackManager();
      if (rm && rm.getAvailableBackups) {
        return { success: true, data: rm.getAvailableBackups() };
      }
      return { success: false, error: 'Rollback manager not available' };
    },
  },

  'backup-open-folder': {
    category: 'backup',
    description: 'Open the backups folder in Finder',
    execute: () => {
      const rm = getRollbackManager();
      if (rm && rm.openBackupsFolder) {
        rm.openBackupsFolder();
        return { success: true, message: 'Backups folder opened' };
      }
      return { success: false, error: 'Rollback manager not available' };
    },
  },

  // ============================= DEV TOOLS ==================================

  'dev-tools-copy-flow-id': {
    category: 'dev-tools',
    description: 'Copy the current Edison flow ID to clipboard',
    execute: () => {
      const ctx = getFlowContext();
      if (ctx) {
        const current = ctx.get ? ctx.get() : null;
        if (current && current.flowId) {
          clipboard.writeText(current.flowId);
          return { success: true, message: 'Flow ID copied', data: current.flowId };
        }
        return { success: false, error: 'No active flow context' };
      }
      return { success: false, error: 'Flow context not available' };
    },
  },

  'dev-tools-copy-flow-context': {
    category: 'dev-tools',
    description: 'Copy the full flow context JSON to clipboard',
    execute: () => {
      const ctx = getFlowContext();
      if (ctx) {
        const current = ctx.get ? ctx.get() : null;
        if (current) {
          clipboard.writeText(JSON.stringify(current, null, 2));
          return { success: true, message: 'Flow context copied' };
        }
        return { success: false, error: 'No active flow context' };
      }
      return { success: false, error: 'Flow context not available' };
    },
  },

  'dev-tools-toggle-logging': {
    category: 'dev-tools',
    description: 'Toggle Edison event logging',
    optionalParams: ['enabled'],
    execute: (params = {}) => {
      if (!global.settingsManager) return { success: false, error: 'Settings not available' };
      const current = global.settingsManager.get('edisonEventLogging') || false;
      const newValue = params.enabled !== undefined ? !!params.enabled : !current;
      global.settingsManager.set('edisonEventLogging', newValue);
      return { success: true, message: `Edison event logging ${newValue ? 'enabled' : 'disabled'}`, data: newValue };
    },
  },

  'open-library-browser': {
    category: 'dev-tools',
    description: 'Open the Edison step template library browser',
    execute: () => {
      const dt = getDevToolsBuilder();
      if (dt && dt.openLibraryBrowser) {
        dt.openLibraryBrowser();
        return { success: true, message: 'Library Browser opened' };
      }
      createStandardWindow({
        width: 1100, height: 800, title: 'Step Template Library',
        preload: 'preload.js', file: 'library-browser.html',
      });
      return { success: true, message: 'Library Browser opened' };
    },
  },

  'open-validator-results': {
    category: 'dev-tools',
    description: 'Open the flow validator results window',
    optionalParams: ['results'],
    execute: (params = {}) => {
      const dt = getDevToolsBuilder();
      if (dt && dt.openValidatorResults) {
        dt.openValidatorResults(params.results);
        return { success: true, message: 'Validator Results opened' };
      }
      createStandardWindow({
        width: 900, height: 700, title: 'Flow Validator Results',
        preload: 'preload.js', file: 'flow-validator-results.html',
      });
      return { success: true, message: 'Validator Results opened' };
    },
  },

  'open-flow-logs': {
    category: 'dev-tools',
    description: 'Open the flow logs results window',
    optionalParams: ['logs'],
    execute: (params = {}) => {
      const dt = getDevToolsBuilder();
      if (dt && dt.openFlowLogsResults) {
        dt.openFlowLogsResults(params.logs);
        return { success: true, message: 'Flow Logs opened' };
      }
      createStandardWindow({
        width: 900, height: 700, title: 'Flow Logs',
        preload: 'preload.js', file: 'flow-logs-results.html',
      });
      return { success: true, message: 'Flow Logs opened' };
    },
  },

  'open-configure-step': {
    category: 'dev-tools',
    description: 'Open the configure step wizard',
    execute: () => {
      const dt = getDevToolsBuilder();
      if (dt && dt.openConfigureStep) {
        dt.openConfigureStep();
        return { success: true, message: 'Configure Step opened' };
      }
      createStandardWindow({
        width: 800, height: 600, title: 'Configure Step',
        preload: 'preload.js', file: 'configure-step.html',
      });
      return { success: true, message: 'Configure Step opened' };
    },
  },

  'open-build-step-template': {
    category: 'dev-tools',
    description: 'Open the build step template wizard',
    execute: () => {
      const dt = getDevToolsBuilder();
      if (dt && dt.openBuildStepTemplate) {
        dt.openBuildStepTemplate();
        return { success: true, message: 'Build Step Template opened' };
      }
      createStandardWindow({
        width: 800, height: 600, title: 'Build Step Template',
        preload: 'preload.js', file: 'build-step-template.html',
      });
      return { success: true, message: 'Build Step Template opened' };
    },
  },

  'open-sdk-dashboard': {
    category: 'dev-tools',
    description: 'Open the Edison SDK dashboard in settings',
    execute: () => {
      if (global.openSettingsWindowGlobal) {
        global.openSettingsWindowGlobal('edison-sdks');
        return { success: true, message: 'SDK Dashboard opened' };
      }
      return ACTION_REGISTRY['open-settings'].execute({ section: 'edison-sdks' });
    },
  },

  // ============================= SEARCH =====================================

  'search-spaces': {
    category: 'search',
    description: 'Search in Spaces',
    optionalParams: ['query'],
    execute: (params = {}) => {
      const query = params.query || '';
      if (global.clipboardManager) {
        global.clipboardManager.createClipboardWindow();
        setTimeout(() => {
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed() && win.getTitle().includes('Spaces')) {
              win.webContents.send('search:focus', { query });
            }
          });
        }, 500);
        return { success: true, message: query ? `Searching for "${query}"` : 'Search opened' };
      }
      return { success: false, error: 'Clipboard manager not available' };
    },
  },

  // ============================= AI SERVICE TABS ============================

  'open-chatgpt': { category: 'ai-tabs', description: 'Open ChatGPT', execute: () => openAIService('chatgpt') },
  'open-claude': { category: 'ai-tabs', description: 'Open Claude', execute: () => openAIService('claude') },
  'open-gemini': { category: 'ai-tabs', description: 'Open Gemini', execute: () => openAIService('gemini') },
  'open-grok': { category: 'ai-tabs', description: 'Open Grok', execute: () => openAIService('grok') },
  'open-perplexity': { category: 'ai-tabs', description: 'Open Perplexity', execute: () => openAIService('perplexity') },

  // ============================= HELP / UTILITY =============================

  'focus-main-window': {
    category: 'system',
    description: 'Focus the main window',
    execute: () => {
      if (global.mainWindow && !global.mainWindow.isDestroyed()) {
        global.mainWindow.show();
        global.mainWindow.focus();
        return { success: true, message: 'Main window focused' };
      }
      return { success: false, error: 'Main window not available' };
    },
  },

  'toggle-voice-orb': {
    category: 'system',
    description: 'Toggle the Voice Orb (alias)',
    execute: () => ACTION_REGISTRY['voice-orb-toggle'].execute(),
  },

  'check-for-updates': {
    category: 'system',
    description: 'Check for application updates',
    execute: () => {
      if (global.checkForUpdatesGlobal) {
        global.checkForUpdatesGlobal();
        return { success: true, message: 'Checking for updates...' };
      }
      try {
        const main = require('./main');
        if (main.checkForUpdates) {
          main.checkForUpdates();
          return { success: true, message: 'Checking for updates...' };
        }
      } catch (_) { /* fallback */ }
      return { success: false, error: 'Update checker not available' };
    },
  },

  'relaunch-app': {
    category: 'system',
    description: 'Relaunch the application',
    execute: () => {
      const { app } = require('electron');
      setTimeout(() => { app.relaunch(); app.exit(0); }, 500);
      return { success: true, message: 'App will relaunch in 500ms' };
    },
  },

  'app-version': {
    category: 'system',
    description: 'Get the current app version',
    execute: () => {
      try {
        const { app } = require('electron');
        return { success: true, data: app.getVersion() };
      } catch (_) {
        return { success: false, error: 'Could not determine app version' };
      }
    },
  },

  'app-health': {
    category: 'system',
    description: 'Get app health summary',
    execute: () => {
      try {
        const { app } = require('electron');
        return {
          success: true,
          data: {
            version: app.getVersion(),
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
            pid: process.pid,
          },
        };
      } catch (_) {
        return { success: false, error: 'Health check failed' };
      }
    },
  },

  'app-situation': {
    category: 'system',
    description: 'Get a comprehensive snapshot of the current app state (windows, tabs, flow, orb, agents, recent activity, settings)',
    execute: () => {
      let version = 'unknown';
      try { const { app } = require('electron'); version = app.getVersion(); } catch (_) { /* ignore */ }
      let healthStatus = null;
      try {
        const { getHealthStatus } = require('./lib/health-monitor');
        healthStatus = getHealthStatus();
      } catch (_) { /* health monitor may not be started yet */ }

      const snapshot = {
        timestamp: new Date().toISOString(),
        app: { version, uptime: Math.round(process.uptime()), pid: process.pid },
        windows: _gatherWindowState(),
        flowContext: _gatherFlowContext(),
        voice: _gatherVoiceState(),
        agents: _gatherAgentState(),
        recentActivity: _gatherRecentActivity(),
        settings: _gatherKeySettings(),
        health: healthStatus,
      };
      return { success: true, data: snapshot };
    },
  },

  // ============================= TOOLS ======================================

  'open-black-hole': {
    category: 'tools',
    description: 'Open Black Hole (quick paste to Spaces)',
    execute: () => {
      if (global.clipboardManager) {
        const { screen } = require('electron');
        const { width, height } = screen.getPrimaryDisplay().workAreaSize;
        global.clipboardManager.showBlackHole({ x: Math.round(width / 2), y: Math.round(height / 2) }, 'voice');
        return { success: true, message: 'Black Hole opened' };
      }
      return { success: false, error: 'Clipboard manager not available' };
    },
  },

  'open-clipboard-viewer': {
    category: 'tools',
    description: 'Open Clipboard Viewer',
    execute: () => {
      if (global.clipboardManager) {
        global.clipboardManager.createClipboardWindow();
        return { success: true, message: 'Clipboard Viewer opened' };
      }
      return { success: false, error: 'Clipboard manager not available' };
    },
  },

  'open-module': {
    category: 'tools',
    description: 'Open a module/tool by ID',
    params: ['moduleId'],
    execute: (params = {}) => {
      if (global.moduleManager) {
        global.moduleManager.openModule(params.moduleId);
        return { success: true, message: `Module ${params.moduleId} opened` };
      }
      return { success: false, error: 'Module manager not available' };
    },
  },

  'open-web-tool': {
    category: 'tools',
    description: 'Open a web tool by URL',
    params: ['url'],
    optionalParams: ['name'],
    execute: (params = {}) => {
      shell.openExternal(params.url);
      return { success: true, message: `Opening ${params.name || 'web tool'}` };
    },
  },

  // ============================= SHARE ======================================

  'copy-download-link': {
    category: 'share',
    description: 'Copy the app download link to clipboard',
    execute: () => {
      clipboard.writeText('https://github.com/AirTalk/GSX-power-user/releases/latest');
      return { success: true, message: 'Download link copied to clipboard' };
    },
  },

  'share-via-email': {
    category: 'share',
    description: 'Open email client with app share link',
    execute: () => {
      shell.openExternal(
        'mailto:?subject=Check%20out%20GSX%20Power%20User&body=Download%20link%3A%20https%3A%2F%2Fgithub.com%2FAirTalk%2FGSX-power-user%2Freleases%2Flatest'
      );
      return { success: true, message: 'Email client opened' };
    },
  },

  'open-github-page': {
    category: 'share',
    description: 'Open the GitHub repository page',
    execute: () => {
      shell.openExternal('https://github.com/AirTalk/GSX-power-user');
      return { success: true, message: 'GitHub page opened' };
    },
  },

  // ============================= DESKTOP AUTOPILOT ==========================

  'desktop-status': {
    category: 'desktop',
    description: 'Get Desktop Autopilot status and capabilities (browser, app control, system control)',
    execute: () => {
      const autopilot = require('./lib/desktop-autopilot');
      return autopilot.status();
    },
  },

  'open-autopilot': {
    category: 'desktop',
    description: 'Open the Desktop Autopilot status window',
    execute: () => {
      const _win = createStandardWindow({
        file: 'autopilot-status.html',
        title: 'Desktop Autopilot',
        width: 520,
        height: 640,
      });
      return { success: true, message: 'Autopilot window opened' };
    },
  },

  'desktop-browse-task': {
    category: 'desktop',
    description: 'Run a natural-language browser task — uses cached script if available (~3s), otherwise AI drives the browser and caches for next time',
    params: ['task'],
    optionalParams: ['useVision', 'maxSteps', 'profile', 'headless', 'skipCache'],
    execute: async (params) => {
      const autopilot = require('./lib/desktop-autopilot');
      return autopilot.browser.runTask(params.task, {
        useVision: params.useVision,
        maxSteps: params.maxSteps,
        profile: params.profile,
        headless: params.headless,
        skipCache: params.skipCache,
      });
    },
  },

  'desktop-cache-list': {
    category: 'desktop',
    description: 'List all cached autopilot scripts with hit counts and last usage',
    execute: () => {
      const cache = require('./lib/autopilot-script-cache');
      return { success: true, scripts: cache.list() };
    },
  },

  'desktop-cache-clear': {
    category: 'desktop',
    description: 'Clear all cached autopilot scripts',
    execute: () => {
      const cache = require('./lib/autopilot-script-cache');
      const count = cache.clearAll();
      return { success: true, cleared: count };
    },
  },

  'desktop-browse': {
    category: 'desktop',
    description: 'Low-level browser control: navigate, screenshot, get state, extract content, or evaluate JavaScript',
    params: ['action'],
    optionalParams: ['url', 'script', 'selector', 'fullPage', 'headless'],
    execute: async (params) => {
      const autopilot = require('./lib/desktop-autopilot');
      switch (params.action) {
        case 'navigate':
          return autopilot.browser.navigate(params.url, { headless: params.headless });
        case 'screenshot':
          return autopilot.browser.screenshot({ fullPage: params.fullPage });
        case 'get_state':
          return autopilot.browser.getState();
        case 'extract_content':
          return autopilot.browser.extractContent({ selector: params.selector });
        case 'evaluate':
          return autopilot.browser.evaluate(params.script);
        case 'close':
          return autopilot.browser.close();
        default:
          return { success: false, error: `Unknown browser action: ${params.action}` };
      }
    },
  },

  'desktop-applescript': {
    category: 'desktop',
    description: 'Execute AppleScript for macOS system automation (requires System Control enabled)',
    params: ['script'],
    execute: async (params) => {
      const autopilot = require('./lib/desktop-autopilot');
      return autopilot.system.applescript(params.script);
    },
  },

  'desktop-mouse': {
    category: 'desktop',
    description: 'Mouse control: move, click, double-click, right-click, scroll, or get position (requires System Control enabled)',
    params: ['action'],
    optionalParams: ['x', 'y', 'button'],
    execute: (params) => {
      const autopilot = require('./lib/desktop-autopilot');
      switch (params.action) {
        case 'move':
          return autopilot.system.mouseMove(params.x, params.y);
        case 'click':
          return autopilot.system.mouseClick(params.button || 'left', false);
        case 'double_click':
          return autopilot.system.mouseClick(params.button || 'left', true);
        case 'right_click':
          return autopilot.system.mouseClick('right', false);
        case 'scroll':
          return autopilot.system.mouseScroll(params.x || 0, params.y || 0);
        case 'get_position':
          return autopilot.system.getMousePosition();
        default:
          return { success: false, error: `Unknown mouse action: ${params.action}` };
      }
    },
  },

  'desktop-keyboard': {
    category: 'desktop',
    description: 'Keyboard control: type text or press key combos with modifiers (requires System Control enabled)',
    params: ['action'],
    optionalParams: ['text', 'key', 'shift', 'control', 'alt', 'meta'],
    execute: (params) => {
      const autopilot = require('./lib/desktop-autopilot');
      if (params.action === 'type') {
        return autopilot.system.keyType(params.text);
      }
      if (params.action === 'press') {
        return autopilot.system.keyPress(params.key, {
          shift: params.shift,
          control: params.control,
          alt: params.alt,
          meta: params.meta,
        });
      }
      return { success: false, error: `Unknown keyboard action: ${params.action}` };
    },
  },
};

// ---------------------------------------------------------------------------
// SITUATIONAL AWARENESS HELPERS (for app-situation action)
// ---------------------------------------------------------------------------

function _gatherWindowState() {
  const result = { total: 0, focusedName: null, open: [] };

  try {
    const registry = global.windowRegistry || require('./lib/window-registry');
    const registered = registry.list();
    const registeredIds = new Set();

    for (const entry of registered) {
      if (!entry.alive) continue;
      const win = registry.get(entry.name);
      if (win && win.id) registeredIds.add(win.id);
      const item = {
        name: entry.name,
        title: win && win.getTitle ? win.getTitle() : entry.name,
        visible: entry.visible,
        focused: entry.focused,
      };
      if (entry.focused) result.focusedName = entry.name;
      result.open.push(item);
    }

    try {
      const { BrowserWindow: BW } = require('electron');
      if (BW && typeof BW.getAllWindows === 'function') {
        const focusedWin = typeof BW.getFocusedWindow === 'function' ? BW.getFocusedWindow() : null;
        const focusedId = focusedWin && !focusedWin.isDestroyed() ? focusedWin.id : null;
        for (const win of BW.getAllWindows()) {
          if (win.isDestroyed() || registeredIds.has(win.id)) continue;
          const title = win.getTitle() || '';
          const isFocused = win.id === focusedId;
          result.open.push({ name: null, title, visible: win.isVisible(), focused: isFocused });
          if (isFocused && !result.focusedName) result.focusedName = title || `window-${win.id}`;
        }
      }
    } catch (_) { /* BrowserWindow not available (tests) */ }

    result.total = result.open.length;
  } catch (_) { /* graceful fallback */ }

  return result;
}

function _gatherFlowContext() {
  const ctx = getFlowContext();
  if (ctx && ctx.get) {
    const c = ctx.get();
    return c || null;
  }
  return null;
}

function _gatherVoiceState() {
  const state = { orbVisible: false, listening: false, connected: false };
  try {
    const registry = global.windowRegistry || require('./lib/window-registry');
    const orbWin = registry.get('orb');
    state.orbVisible = !!(orbWin && !orbWin.isDestroyed() && orbWin.isVisible());
  } catch (_) { /* ignore */ }
  try {
    const realtimeSpeech = require('./realtime-speech');
    if (realtimeSpeech && typeof realtimeSpeech.isConnected === 'function') {
      state.connected = realtimeSpeech.isConnected();
      state.listening = state.connected;
    }
  } catch (_) { /* ignore */ }
  return state;
}

function _gatherAgentState() {
  const state = { exchangeRunning: false, connectedCount: 0, connected: [] };
  const bridge = getExchangeBridge();
  if (!bridge) return state;
  try {
    state.exchangeRunning = bridge.isRunning ? bridge.isRunning() : false;
    const exchange = bridge.getExchange ? bridge.getExchange() : null;
    if (exchange && exchange.agents) {
      const agents = typeof exchange.agents.getAll === 'function'
        ? exchange.agents.getAll() : [];
      state.connected = agents.map(a => ({
        id: a.id, name: a.name, healthy: a.healthy !== false,
      }));
      state.connectedCount = state.connected.length;
    }
  } catch (_) { /* ignore */ }
  return state;
}

function _gatherRecentActivity() {
  const activity = { recentBids: [], recentLogs: [] };
  try {
    const stats = require('./src/voice-task-sdk/agent-stats');
    if (stats && stats.getBidHistory) {
      activity.recentBids = stats.getBidHistory(5).map(b => ({
        taskContent: b.taskContent,
        winnerId: b.winnerId,
        winnerName: b.bids?.find(bid => bid.won)?.agentName || null,
        timestamp: b.timestamp,
      }));
    }
  } catch (_) { /* ignore */ }
  try {
    const { getLogQueue } = require('./lib/log-event-queue');
    const queue = getLogQueue();
    if (queue && queue.query) {
      const MAX_DATA_BYTES = 2048;
      activity.recentLogs = queue.query({ limit: 25 })
        .filter(e => e.category !== 'situation')
        .map(e => {
          let data = e.data || null;
          if (data) {
            const serialized = JSON.stringify(data);
            if (serialized.length > MAX_DATA_BYTES) {
              data = { _truncated: true, _originalSize: serialized.length };
            }
          }
          return {
            level: e.level,
            category: e.category,
            message: e.message,
            source: e.source || null,
            data,
            timestamp: e.timestamp,
          };
        });
    }
  } catch (_) { /* ignore */ }
  return activity;
}

function _gatherKeySettings() {
  if (!global.settingsManager) return {};
  try {
    const all = global.settingsManager.getAll();
    return {
      theme: all.theme || null,
      llmProvider: all.llmProvider || null,
      llmModel: all.llmModel || null,
      diagnosticLogging: all.diagnosticLogging || 'info',
    };
  } catch (_) {
    return {};
  }
}

// ---------------------------------------------------------------------------
// EXECUTION ENGINE
// ---------------------------------------------------------------------------

async function executeAction(actionType, params = {}) {
  console.log(`[ActionExecutor] Executing: ${actionType}`, Object.keys(params));

  const action = ACTION_REGISTRY[actionType];
  if (!action) {
    console.warn(`[ActionExecutor] Unknown action: ${actionType}`);
    return { success: false, error: `Unknown action: ${actionType}` };
  }

  if (action.params) {
    for (const param of action.params) {
      if (params[param] === undefined || params[param] === null) {
        return { success: false, error: `Missing required parameter: ${param}` };
      }
    }
  }

  try {
    const result = action.execute(params);
    if (result && typeof result.then === 'function') {
      return await result;
    }
    return result;
  } catch (error) {
    console.error(`[ActionExecutor] Action failed:`, error);
    return { success: false, error: error.message };
  }
}

function listActions() {
  const byCategory = {};
  for (const [type, action] of Object.entries(ACTION_REGISTRY)) {
    const category = action.category || 'other';
    if (!byCategory[category]) byCategory[category] = [];
    byCategory[category].push({
      type,
      description: action.description,
      params: action.params || [],
      optionalParams: action.optionalParams || [],
    });
  }
  return byCategory;
}

function hasAction(actionType) {
  return !!ACTION_REGISTRY[actionType];
}

function getActionInfo(actionType) {
  const action = ACTION_REGISTRY[actionType];
  if (!action) return null;
  return {
    type: actionType,
    category: action.category,
    description: action.description,
    params: action.params || [],
    optionalParams: action.optionalParams || [],
  };
}

function setupActionIPC() {
  ipcMain.handle('action:execute', async (event, actionType, params) => {
    return executeAction(actionType, params);
  });
  ipcMain.handle('action:list', async () => {
    return listActions();
  });
  ipcMain.handle('action:has', async (event, actionType) => {
    return hasAction(actionType);
  });
  ipcMain.handle('action:info', async (event, actionType) => {
    return getActionInfo(actionType);
  });
  console.log(`[ActionExecutor] IPC handlers registered (${Object.keys(ACTION_REGISTRY).length} actions)`);
}

/**
 * Start periodic situation snapshots in the log stream.
 * Emits a full app-situation snapshot as a 'situation' category log entry
 * at the given interval, creating a queryable timeline of app state.
 * @param {number} [intervalMs=60000] - Snapshot interval in milliseconds
 * @returns {NodeJS.Timeout} The interval timer (call clearInterval to stop)
 */
function startSituationLogger(intervalMs = 60000) {
  const { getLogQueue } = require('./lib/log-event-queue');
  const queue = getLogQueue();
  const timer = setInterval(async () => {
    try {
      const result = await executeAction('app-situation');
      if (result && result.success) {
        const snapshot = { ...result.data };
        // Strip recentActivity before enqueuing to prevent recursive nesting:
        // each snapshot would otherwise embed previous snapshots (which embed
        // even older ones), causing exponential size growth that can exceed
        // 300 MB per entry and trigger macOS disk-write termination.
        delete snapshot.recentActivity;
        queue.enqueue({
          level: 'info',
          category: 'situation',
          message: 'Periodic app situation snapshot',
          data: snapshot,
          source: 'situation-logger',
        });
      }
    } catch (_) { /* don't let snapshot failures break the timer */ }
  }, intervalMs);
  timer.unref();
  queue.info('app', 'Situation logger started', { intervalMs });
  return timer;
}

module.exports = {
  executeAction,
  listActions,
  hasAction,
  getActionInfo,
  setupActionIPC,
  startSituationLogger,
  ACTION_REGISTRY,
};
