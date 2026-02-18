/**
 * Action Executor - Centralized Action Registry and Execution
 *
 * Single source of truth for all app actions that can be triggered
 * by voice commands, agents, or other automation.
 *
 * Actions are organized by category:
 * - windows: Open app windows (Spaces, Video Editor, etc.)
 * - search: Search operations
 * - ai: Open AI services
 * - utility: Misc operations
 */

const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

/**
 * Action Registry
 * Maps action types to their execution functions
 */
const ACTION_REGISTRY = {
  // ==================== WINDOW OPERATIONS ====================
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
      const videoWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        title: 'Video Editor',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          devTools: true,
          preload: path.join(__dirname, 'preload-video-editor.js'),
        },
      });
      videoWindow.loadFile('video-editor.html');
      return { success: true, message: 'Video Editor opened' };
    },
  },

  'open-gsx-create': {
    category: 'windows',
    description: 'Open GSX Create (AI coding assistant)',
    execute: () => {
      const { screen } = require('electron');
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
      const aiderWindow = new BrowserWindow({
        width: Math.min(1800, screenWidth - 100),
        height: Math.min(1100, screenHeight - 100),
        title: 'GSX Create',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, 'preload.js'),
        },
      });
      aiderWindow.loadFile('aider-ui.html');
      return { success: true, message: 'GSX Create opened' };
    },
  },

  'open-settings': {
    category: 'windows',
    description: 'Open Settings',
    execute: () => {
      const settingsWindow = new BrowserWindow({
        width: 800,
        height: 700,
        title: 'Settings',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, 'preload.js'),
        },
      });
      settingsWindow.loadFile('settings.html');
      return { success: true, message: 'Settings opened' };
    },
  },

  'open-budget': {
    category: 'windows',
    description: 'Open Budget Dashboard',
    execute: () => {
      const budgetWindow = new BrowserWindow({
        width: 900,
        height: 700,
        title: 'Budget Dashboard',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, 'preload.js'),
        },
      });
      budgetWindow.loadFile('budget-dashboard.html');
      return { success: true, message: 'Budget Dashboard opened' };
    },
  },

  'open-app-health': {
    category: 'windows',
    description: 'Open App Health Dashboard',
    execute: () => {
      const healthWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        title: 'App Health',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, 'preload.js'),
        },
      });
      healthWindow.loadFile('app-health-dashboard.html');
      return { success: true, message: 'App Health opened' };
    },
  },

  'open-agent-manager': {
    category: 'windows',
    description: 'Open Agent Manager',
    execute: () => {
      const agentWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        title: 'Agent Manager',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, 'preload-agent-manager.js'),
        },
      });
      agentWindow.loadFile('agent-manager.html');
      return { success: true, message: 'Agent Manager opened' };
    },
  },

  'open-log-viewer': {
    category: 'windows',
    description: 'Open Event Log Viewer',
    execute: () => {
      const logWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'Event Log Viewer',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, 'preload-log-viewer.js'),
        },
      });
      logWindow.loadFile('log-viewer.html');
      return { success: true, message: 'Log Viewer opened' };
    },
  },

  // ==================== SEARCH OPERATIONS ====================
  'search-spaces': {
    category: 'search',
    description: 'Search in Spaces',
    execute: (params = {}) => {
      const query = params.query || '';
      if (global.clipboardManager) {
        global.clipboardManager.createClipboardWindow();
        // Wait for window to be ready, then trigger search
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

  // ==================== AI SERVICE OPERATIONS ====================
  'open-chatgpt': {
    category: 'ai',
    description: 'Open ChatGPT',
    execute: () => openAIService('chatgpt'),
  },

  'open-claude': {
    category: 'ai',
    description: 'Open Claude',
    execute: () => openAIService('claude'),
  },

  'open-gemini': {
    category: 'ai',
    description: 'Open Gemini',
    execute: () => openAIService('gemini'),
  },

  'open-grok': {
    category: 'ai',
    description: 'Open Grok',
    execute: () => openAIService('grok'),
  },

  'open-perplexity': {
    category: 'ai',
    description: 'Open Perplexity',
    execute: () => openAIService('perplexity'),
  },

  // ==================== UTILITY OPERATIONS ====================
  'focus-main-window': {
    category: 'utility',
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

  // ==================== TOOLS OPERATIONS ====================
  'open-black-hole': {
    category: 'tools',
    description: 'Open Black Hole (quick paste to Spaces)',
    execute: () => {
      if (global.clipboardManager) {
        const { screen } = require('electron');
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width, height } = primaryDisplay.workAreaSize;
        const position = {
          x: Math.round(width / 2),
          y: Math.round(height / 2),
        };
        global.clipboardManager.showBlackHole(position, 'voice');
        return { success: true, message: 'Black Hole opened' };
      }
      return { success: false, error: 'Clipboard manager not available' };
    },
  },

  'open-clipboard-viewer': {
    category: 'tools',
    description: 'Open Clipboard Viewer',
    execute: () => {
      // Just open Spaces - it includes the clipboard viewer
      if (global.clipboardManager) {
        global.clipboardManager.createClipboardWindow();
        return { success: true, message: 'Clipboard Viewer opened' };
      }
      return { success: false, error: 'Clipboard manager not available' };
    },
  },

  'open-module': {
    category: 'tools',
    description: 'Open a module/tool',
    execute: (params = {}) => {
      if (global.moduleManager && params.moduleId) {
        global.moduleManager.openModule(params.moduleId);
        return { success: true, message: `Module ${params.moduleId} opened` };
      }
      return { success: false, error: 'Module manager not available or no moduleId provided' };
    },
  },

  'open-web-tool': {
    category: 'tools',
    description: 'Open a web tool',
    execute: (params = {}) => {
      if (params.url) {
        const { shell } = require('electron');
        shell.openExternal(params.url);
        return { success: true, message: `Opening ${params.name || 'web tool'}` };
      }
      return { success: false, error: 'No URL provided' };
    },
  },
};

/**
 * Helper: Open an AI service
 */
function openAIService(serviceName) {
  if (global.mainWindow && !global.mainWindow.isDestroyed()) {
    global.mainWindow.webContents.send('open-ai-service', { service: serviceName });
    return { success: true, message: `Opening ${serviceName}` };
  }
  return { success: false, error: 'Main window not available' };
}

/**
 * Execute an action by type
 * @param {string} actionType - The action type (e.g., 'open-spaces')
 * @param {Object} params - Optional parameters for the action
 * @returns {Object} - { success: boolean, message?: string, error?: string }
 */
function executeAction(actionType, params = {}) {
  console.log(`[ActionExecutor] Executing: ${actionType}`, params);

  const action = ACTION_REGISTRY[actionType];

  if (!action) {
    console.warn(`[ActionExecutor] Unknown action: ${actionType}`);
    return { success: false, error: `Unknown action: ${actionType}` };
  }

  try {
    const result = action.execute(params);
    console.log(`[ActionExecutor] Result:`, result);
    return result;
  } catch (error) {
    console.error(`[ActionExecutor] Action failed:`, error);
    return { success: false, error: error.message };
  }
}

/**
 * List all available actions
 * @returns {Object} - Actions grouped by category
 */
function listActions() {
  const byCategory = {};

  for (const [type, action] of Object.entries(ACTION_REGISTRY)) {
    const category = action.category || 'other';
    if (!byCategory[category]) {
      byCategory[category] = [];
    }
    byCategory[category].push({
      type,
      description: action.description,
    });
  }

  return byCategory;
}

/**
 * Check if an action type exists
 * @param {string} actionType
 * @returns {boolean}
 */
function hasAction(actionType) {
  return !!ACTION_REGISTRY[actionType];
}

/**
 * Get action info
 * @param {string} actionType
 * @returns {Object|null}
 */
function getActionInfo(actionType) {
  const action = ACTION_REGISTRY[actionType];
  if (!action) return null;

  return {
    type: actionType,
    category: action.category,
    description: action.description,
  };
}

/**
 * Set up IPC handlers for action execution
 * Call this from main.js during app initialization
 */
function setupActionIPC() {
  // Execute an action
  ipcMain.handle('action:execute', async (event, actionType, params) => {
    return executeAction(actionType, params);
  });

  // List available actions
  ipcMain.handle('action:list', async () => {
    return listActions();
  });

  // Check if action exists
  ipcMain.handle('action:has', async (event, actionType) => {
    return hasAction(actionType);
  });

  // Get action info
  ipcMain.handle('action:info', async (event, actionType) => {
    return getActionInfo(actionType);
  });

  console.log('[ActionExecutor] IPC handlers registered');
}

module.exports = {
  executeAction,
  listActions,
  hasAction,
  getActionInfo,
  setupActionIPC,
  ACTION_REGISTRY,
};
