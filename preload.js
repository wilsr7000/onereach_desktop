// Preload script runs in an isolated context, but has access to Node.js APIs
const { contextBridge, ipcRenderer } = require('electron');

// Set up console interceptor for renderer process
(function() {
  // Store original console methods
  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
    info: console.info.bind(console)
  };

  // Get window title or URL for context
  function getWindowContext() {
    let windowName = 'Unknown';
    try {
      windowName = document.title || window.location.pathname || 'Renderer';
    } catch (e) {
      // Document might not be ready yet
    }
    return windowName;
  }

  // Override console methods
  const interceptConsoleMethod = (method, level) => {
    console[method] = function(...args) {
      // Call original console method
      originalConsole[method](...args);
      
      // Format the message
      const message = args.map(arg => {
        if (typeof arg === 'object') {
          try {
            return JSON.stringify(arg, null, 2);
          } catch (e) {
            return String(arg);
          }
        }
        return String(arg);
      }).join(' ');
      
      // Send to main process via IPC
      try {
        ipcRenderer.send(`logger:${level}`, {
          message: `[Console.${method}] ${message}`,
          data: {
            window: getWindowContext(),
            url: window.location ? window.location.href : 'unknown',
            consoleMethod: method,
            timestamp: new Date().toISOString()
          }
        });
      } catch (err) {
        // Fail silently to avoid infinite loops
      }
    };
  };

  // Intercept all console methods
  interceptConsoleMethod('log', 'info');
  interceptConsoleMethod('warn', 'warn');
  interceptConsoleMethod('error', 'error');
  interceptConsoleMethod('debug', 'debug');
  interceptConsoleMethod('info', 'info');
  
  // Update window context when document is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      // Re-intercept with updated window context
      interceptConsoleMethod('log', 'info');
      interceptConsoleMethod('warn', 'warn');
      interceptConsoleMethod('error', 'error');
      interceptConsoleMethod('debug', 'debug');
      interceptConsoleMethod('info', 'info');
    });
  }
})();

// Expose protected methods that allow the renderer process to use the ipcRenderer
// without exposing the entire object
contextBridge.exposeInMainWorld(
  'api', {
    send: (channel, data) => {
      // Whitelist channels to ensure secure IPC
      const validChannels = [
        'app-message',
        'user-action',
        'menu-action',
        'idw-environments-response',
        'test-idw-load',
        'tab-action',
        'setup-webcontents-handlers',
        'update-gsx-menu',
        'save-idw-entries',
        'save-idw-environments',
        'relaunch-app',
        'open-in-new-tab',
        'open-setup-wizard',
        'open-gsx-link',
        'update-action',
        'save-user-preferences',
        'save-gsx-links',
        'save-external-bots',
        'save-image-creators',
        'save-video-creators',
        'save-audio-generators',
        'refresh-menu',
        'get-idw-environments',
        'get-external-bots',
        'get-image-creators',
            'get-video-creators',
    'get-audio-generators',
    'module:install-from-url',
    'module:install-from-file',
    'module:uninstall',
    'module:get-installed',
    'module:open',
    'add-tab',
        'close-content-window',
        'update-environment-selector',
        'open-url-in-tab',
        'auth-success',
        'handle-auth-url',
        'show-context-menu',
        'show-notification',
        'open-clipboard-viewer',
        'open-black-hole-widget',
        'close-black-hole-widget',
        'black-hole:toggle-always-on-top',
        'black-hole:active',
        'black-hole:inactive',
        'black-hole:trigger-paste',
        'open-external-url'
      ];
      if (validChannels.includes(channel)) {
        ipcRenderer.send(channel, data);
      }
    },
    receive: (channel, func) => {
      const validChannels = [
        'app-response',
        'app-update',
        'menu-action',
        'show-notification',
        'save-result',
        'request-idw-environments',
        'open-in-new-tab',
        'new-tab',
        'close-tab',
        'switch-tab',
        'handle-chat-url',
        'handle-auth-url',
        'save-tabs-state',
        'gsx-links-updated',
        'get-idw-entries-result',
        'update-status',
        'user-preferences-saved',
        'get-idw-environments',
        'get-external-bots',
        'get-image-creators',
        'get-video-creators',
        'get-audio-generators',
        'external-bots-saved',
        'image-creators-saved',
        'video-creators-saved',
        'audio-generators-saved',
        'refresh-gsx-links',
        'auth-token-update',
        'auth-error',
        'black-hole-closed',
        'black-hole-active',
        'black-hole-inactive',
        'save-generated-document'
      ];
      if (validChannels.includes(channel)) {
        // Deliberately strip event as it includes `sender` 
        ipcRenderer.on(channel, (event, ...args) => func(...args));
      }
    },
    // Methods for setup wizard
    getEntries: () => {
      try {
        return ipcRenderer.sendSync('get-idw-entries');
      } catch (error) {
        console.error('Error getting IDW entries:', error);
        return [];
      }
    },
    saveEntries: (entries) => {
      try {
        ipcRenderer.send('save-idw-entries', entries);
        return true;
      } catch (error) {
        console.error('Error saving IDW entries:', error);
        return false;
      }
    },
    // Method to get local storage data for testing
    getLocalStorage: (key) => {
      if (typeof localStorage !== 'undefined') {
        try {
          return localStorage.getItem(key);
        } catch (error) {
          console.error(`Error getting localStorage item "${key}":`, error);
          return null;
        }
      }
      return null;
    },
    // Method to set local storage data for testing
    setLocalStorage: (key, value) => {
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(key, value);
          return true;
        } catch (error) {
          console.error(`Error setting localStorage item "${key}":`, error);
          return false;
        }
      }
      return false;
    },
    // Expose environment information
    isDevMode: process.env.NODE_ENV === 'development',
    // Tab browser methods
    openInNewTab: (url) => {
      ipcRenderer.send('tab-action', { action: 'open-url', url });
    },
    getCurrentTabUrl: () => {
      return ipcRenderer.sendSync('tab-action', { action: 'get-current-url' });
    },
    getAllTabs: () => {
      return ipcRenderer.sendSync('tab-action', { action: 'get-all-tabs' });
    },
    // IDW environment methods
    getIDWEnvironments: (callback) => {
      ipcRenderer.once('get-idw-environments', (event, environments) => {
        callback(environments);
      });
      ipcRenderer.send('get-idw-environments');
    },
    // External bots methods
    getExternalBots: (callback) => {
      ipcRenderer.once('get-external-bots', (event, bots) => {
        callback(bots);
      });
      ipcRenderer.send('get-external-bots');
    },
    // Image creators methods
    getImageCreators: (callback) => {
      ipcRenderer.once('get-image-creators', (event, creators) => {
        callback(creators);
      });
      ipcRenderer.send('get-image-creators');
    },
    // Video creators methods
    getVideoCreators: (callback) => {
      ipcRenderer.once('get-video-creators', (event, creators) => {
        callback(creators);
      });
      ipcRenderer.send('get-video-creators');
    },
    // Audio generators methods
    getAudioGenerators: (callback) => {
      ipcRenderer.once('get-audio-generators', (event, generators) => {
        callback(generators);
      });
      ipcRenderer.send('get-audio-generators');
    },
    // Direct method to open GSX link in an Electron window
    openGSXLink: (url, title, options = {}) => {
      ipcRenderer.send('open-gsx-link', { 
        url, 
        title,
        environment: options.environment || null
      });
    },
    
    // Settings API
    getSettings: () => ipcRenderer.invoke('settings:get-all'),
    saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
    testLLMConnection: (config) => ipcRenderer.invoke('settings:test-llm', config),
    
    // GSX File Sync API
    testGSXConnection: (config) => ipcRenderer.invoke('gsx:test-connection', config),
    syncGSXNow: () => ipcRenderer.invoke('gsx:sync-all'),
    syncGSXCompleteBackup: () => ipcRenderer.invoke('gsx:sync-complete-backup'),
    syncGSXDesktop: (options) => ipcRenderer.invoke('gsx:sync-desktop', options),
    syncGSXORSpaces: (options) => ipcRenderer.invoke('gsx:sync-or-spaces', options),
    syncGSXAppConfig: (options) => ipcRenderer.invoke('gsx:sync-app-config', options),
    syncGSXDirectory: (localPath, remotePath, options) => ipcRenderer.invoke('gsx:sync-directory', localPath, remotePath, options),
    selectAndSyncGSX: (options) => ipcRenderer.invoke('gsx:select-and-sync', options),
    getGSXHistory: () => ipcRenderer.invoke('gsx:get-history'),
    clearGSXHistory: () => ipcRenderer.invoke('gsx:clear-history'),
    getGSXSyncPaths: () => ipcRenderer.invoke('gsx:get-sync-paths'),
    saveGSXSyncPaths: (paths) => ipcRenderer.invoke('gsx:save-sync-paths', paths),
    getGSXStatus: () => ipcRenderer.invoke('gsx:get-status'),
    
    // Event Logging API  
    logEvent: (eventType, eventData) => ipcRenderer.invoke('log:event', eventType, eventData),
    logTabCreated: (tabId, url, metadata) => ipcRenderer.invoke('log:tab-created', tabId, url, metadata),
    logTabClosed: (tabId, url) => ipcRenderer.invoke('log:tab-closed', tabId, url),
    logTabSwitched: (fromTab, toTab) => ipcRenderer.invoke('log:tab-switched', fromTab, toTab),
    logWindowNavigation: (windowId, url, from) => ipcRenderer.invoke('log:window-navigation', windowId, url, from),
    logFeatureUsed: (featureName, metadata) => ipcRenderer.invoke('log:feature-used', featureName, metadata),
    
    // Smart export API
    getSmartExportData: () => ipcRenderer.invoke('get-smart-export-data'),
    generateSmartExport: (data) => ipcRenderer.invoke('generate-smart-export', data),
    generateBasicExport: (data) => ipcRenderer.invoke('generate-basic-export', data),
    saveSmartExportHTML: (html, metadata) => ipcRenderer.invoke('save-smart-export-html', html, metadata),
    saveSmartExportPDF: (html, metadata) => ipcRenderer.invoke('save-smart-export-pdf', html, metadata),
    
    // Template methods
    getExportTemplates: () => ipcRenderer.invoke('get-export-templates'),
    getExportTemplate: (templateId) => ipcRenderer.invoke('get-export-template', templateId),
    saveExportTemplate: (template) => ipcRenderer.invoke('save-export-template', template),
    
    // Save to space
    saveToSpace: (content) => ipcRenderer.invoke('save-to-space', content),
    
    // Get spaces
    getSpaces: () => ipcRenderer.invoke('get-spaces'),
    
    // Style analysis from URLs
    analyzeWebsiteStyles: (urls, options) => ipcRenderer.invoke('analyze-website-styles', urls, options),
    
    // Style guide management
    getStyleGuides: () => ipcRenderer.invoke('get-style-guides'),
    saveStyleGuide: (guide) => ipcRenderer.invoke('save-style-guide', guide),
    deleteStyleGuide: (id) => ipcRenderer.invoke('delete-style-guide', id),
    
    // Generic invoke method for smart export features
    invoke: (channel, ...args) => {
      const validChannels = [
        'smart-export:extract-styles',
        'smart-export:extract-content-guidelines',
        'smart-export:generate-with-guidelines',
        'logger:get-recent-logs',
        'logger:get-stats',
        'logger:export',
        'logger:get-files',
        // Lessons/Tutorials API channels
        'get-current-user',
        'fetch-user-lessons',
        'update-lesson-progress',
        'log-lesson-click',
        // IDW Store channels
        'idw-store:fetch-directory',
        'idw-store:add-to-menu'
      ];
      if (validChannels.includes(channel)) {
        return ipcRenderer.invoke(channel, ...args);
      }
      throw new Error(`Invalid channel: ${channel}`);
    },

    // Logging methods
    log: {
        info: (message, data) => ipcRenderer.send('logger:info', { message, data }),
        warn: (message, data) => ipcRenderer.send('logger:warn', { message, data }),
        error: (message, data) => ipcRenderer.send('logger:error', { message, data }),
        debug: (message, data) => ipcRenderer.send('logger:debug', { message, data }),
        event: (eventType, eventData) => ipcRenderer.send('logger:event', { eventType, eventData }),
        userAction: (action, details) => ipcRenderer.send('logger:user-action', { action, details })
    },
    
    // Test context management
    setTestContext: (context) => ipcRenderer.send('test:set-context', context),
    clearTestContext: () => ipcRenderer.send('test:clear-context'),
    
    // AI log analysis
    analyzeLogsWithAI: (options) => ipcRenderer.invoke('ai:analyze-logs', options),
    generateCursorPrompt: (analysis) => ipcRenderer.invoke('ai:generate-cursor-prompt', analysis)
  }
);

// Expose electron API for relaunch functionality
contextBridge.exposeInMainWorld(
  'electron', {
    send: (channel, data) => {
      // Whitelist channels to ensure secure IPC
      const validChannels = ['relaunch-app', 'black-hole:resize-window', 'black-hole:move-window', 'black-hole:get-position', 'black-hole:restore-position', 'black-hole:active', 'black-hole:inactive', 'black-hole:widget-ready', 'show-notification'];
      if (validChannels.includes(channel)) {
        ipcRenderer.send(channel, data);
      }
    },
    on: (channel, func) => {
      const validChannels = [
        'clipboard:history-updated',
        'clipboard:spaces-updated', 
        'clipboard:spaces-toggled',
        'clipboard:active-space-changed',
        'clipboard:screenshot-capture-toggled',
        'black-hole:position-response',
        'external-file-drop',
        'prepare-for-download',
        'check-widget-ready'
      ];
      if (validChannels.includes(channel)) {
        ipcRenderer.on(channel, (event, ...args) => func(event, ...args));
      }
    },
    ipcRenderer: {
      send: (channel, data) => {
        const validChannels = ['black-hole:resize-window', 'black-hole:move-window', 'black-hole:get-position', 'black-hole:restore-position', 'black-hole:active', 'black-hole:inactive', 'black-hole:widget-ready', 'show-notification'];
        if (validChannels.includes(channel)) {
          ipcRenderer.send(channel, data);
        }
      },
      on: (channel, func) => {
        const validChannels = ['black-hole:position-response', 'external-file-drop', 'prepare-for-download', 'check-widget-ready'];
        if (validChannels.includes(channel)) {
          ipcRenderer.on(channel, (event, ...args) => func(event, ...args));
        }
      },
      invoke: (channel, ...args) => {
        const validChannels = [
          'clipboard:get-history', 
          'clipboard:search', 
          'clipboard:get-spaces', 
          'clipboard:create-space', 
          'clipboard:move-to-space', 
          'clipboard:delete-space',
          'get-memory-info',
          'save-test-results',
          'export-test-report',
          'get-test-history',
          'add-test-history',
          'save-settings',
          'get-settings',
          'get-manual-test-notes',
          'save-manual-test-notes',
          'get-manual-test-statuses',
          'save-manual-test-status',
          'get-app-version',
          'get-os-info',
          'check-widget-ready',
          'test-claude-connection',
          'test-openai-connection',
          'encrypt-data',
          'decrypt-data',
          'check-for-updates',
          'get-rollback-versions',
          'save-test-progress',
          'load-test-progress',
          'save-finalized-report',
          'save-test-history',
          'clipboard:write-text',
          // Lessons/Tutorials API channels
          'get-current-user',
          'fetch-user-lessons',
          'update-lesson-progress'
        ];
        if (validChannels.includes(channel)) {
          return ipcRenderer.invoke(channel, ...args);
        }
        throw new Error(`Invalid channel: ${channel}`);
      }
    },
    clipboard: {
      writeText: (text) => ipcRenderer.invoke('clipboard:write-text', text)
    }
  }
);

contextBridge.exposeInMainWorld('flipboardAPI', {
  fetchRSS: (url) => ipcRenderer.invoke('fetch-rss', url),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onRSSData: (callback) => {
    ipcRenderer.on('rss-data', (event, data) => callback(data));
  },
  loadReadingLog: () => ipcRenderer.invoke('load-reading-log'),
  saveReadingLog: (log) => ipcRenderer.send('save-reading-log', log),
  saveReadingLogSync: (log) => ipcRenderer.sendSync('save-reading-log-sync', log)
});

// Expose electronAPI for GSX toolbar functionality
contextBridge.exposeInMainWorld('electronAPI', {
  triggerMissionControl: () => ipcRenderer.send('trigger-mission-control')
});

// Expose Aider API for AI pair programming
contextBridge.exposeInMainWorld('aider', {
  start: () => ipcRenderer.invoke('aider:start'),
  initialize: (repoPath, modelName) => ipcRenderer.invoke('aider:initialize', repoPath, modelName),
  runPrompt: (message) => ipcRenderer.invoke('aider:run-prompt', message),
  runPromptStreaming: (message, onToken, options = {}) => {
    // Set up listener for stream events
    const handler = (event, data) => {
      if (data.type === 'token' && onToken) {
        onToken(data.content);
      }
    };
    ipcRenderer.on('aider:stream', handler);
    return ipcRenderer.invoke('aider:run-prompt-streaming', message, options).finally(() => {
      ipcRenderer.removeListener('aider:stream', handler);
    });
  },
  onStream: (callback) => ipcRenderer.on('aider:stream', (event, data) => callback(data)),
  removeStreamListener: () => ipcRenderer.removeAllListeners('aider:stream'),
  _runPrompt: (message) => ipcRenderer.invoke('aider:run-prompt', message),
  addFiles: (filePaths) => ipcRenderer.invoke('aider:add-files', filePaths),
  removeFiles: (filePaths) => ipcRenderer.invoke('aider:remove-files', filePaths),
  getRepoMap: () => ipcRenderer.invoke('aider:get-repo-map'),
  
  // Code search tools
  searchCode: (pattern, fileGlob) => ipcRenderer.invoke('aider:search-code', pattern, fileGlob),
  findDefinition: (symbol) => ipcRenderer.invoke('aider:find-definition', symbol),
  findUsages: (symbol) => ipcRenderer.invoke('aider:find-usages', symbol),
  readFileSection: (filePath, startLine, endLine) => ipcRenderer.invoke('aider:read-file-section', filePath, startLine, endLine),
  
  setTestCmd: (command) => ipcRenderer.invoke('aider:set-test-cmd', command),
  setLintCmd: (command) => ipcRenderer.invoke('aider:set-lint-cmd', command),
  shutdown: () => ipcRenderer.invoke('aider:shutdown'),
  getAppPath: () => ipcRenderer.invoke('aider:get-app-path'),
  selectFolder: () => ipcRenderer.invoke('aider:select-folder'),
  getApiConfig: () => ipcRenderer.invoke('aider:get-api-config'),
  getSpaces: () => ipcRenderer.invoke('aider:get-spaces'),
  listFiles: (dirPath) => ipcRenderer.invoke('aider:list-files', dirPath),
  getSpaceItems: (spaceId) => ipcRenderer.invoke('aider:get-space-items', spaceId),
  listProjectFiles: (dirPath) => ipcRenderer.invoke('aider:list-project-files', dirPath),
  detectProjectTools: (dirPath) => ipcRenderer.invoke('aider:detect-project-tools', dirPath),
  registerCreatedFile: (data) => ipcRenderer.invoke('aider:register-created-file', data),
  updateFileMetadata: (data) => ipcRenderer.invoke('aider:update-file-metadata', data),
  getStyleGuides: (spaceId) => ipcRenderer.invoke('aider:get-style-guides', spaceId),
  saveStyleGuide: (data) => ipcRenderer.invoke('aider:save-style-guide', data),
  deleteStyleGuide: (id) => ipcRenderer.invoke('aider:delete-style-guide', id),
  readFile: (filePath) => ipcRenderer.invoke('aider:read-file', filePath),
  openFile: (filePath) => ipcRenderer.invoke('aider:open-file', filePath),
  capturePreviewScreenshot: (htmlContent, options) => ipcRenderer.invoke('aider:capture-preview-screenshot', htmlContent, options),
  analyzeScreenshot: (screenshotBase64, prompt) => ipcRenderer.invoke('aider:analyze-screenshot', screenshotBase64, prompt),
  
  // Version Management
  getFileVersions: (spaceFolder, filePath) => ipcRenderer.invoke('aider:get-file-versions', spaceFolder, filePath),
  getVersionContent: (spaceFolder, filePath, versionId) => ipcRenderer.invoke('aider:get-version-content', spaceFolder, filePath, versionId),
  rollbackFile: (spaceFolder, filePath, versionId) => ipcRenderer.invoke('aider:rollback-file', spaceFolder, filePath, versionId),
  rollbackSession: (spaceFolder, sessionId) => ipcRenderer.invoke('aider:rollback-session', spaceFolder, sessionId),
  getRecentSessions: (spaceFolder, limit) => ipcRenderer.invoke('aider:get-recent-sessions', spaceFolder, limit),
  compareVersions: (spaceFolder, filePath, versionId1, versionId2) => ipcRenderer.invoke('aider:compare-versions', spaceFolder, filePath, versionId1, versionId2),
  
  // Cost Tracking
  recordCost: (spaceFolder, callData) => ipcRenderer.invoke('cost:record', spaceFolder, callData),
  getCostSummary: (spaceFolder) => ipcRenderer.invoke('cost:get-summary', spaceFolder),
  getCostByDateRange: (spaceFolder, startDate, endDate) => ipcRenderer.invoke('cost:get-by-date-range', spaceFolder, startDate, endDate),
  resetCosts: (spaceFolder) => ipcRenderer.invoke('cost:reset', spaceFolder),
  parseAiderCostMessage: (message) => ipcRenderer.invoke('cost:parse-aider-message', message),
  
  // Transaction Database
  txdbRecord: (data) => ipcRenderer.invoke('txdb:record', data),
  txdbGetTransactions: (options) => ipcRenderer.invoke('txdb:get-transactions', options),
  txdbGetSummary: (spaceId, days) => ipcRenderer.invoke('txdb:get-summary', spaceId, days),
  txdbLogEvent: (level, category, message, data, spaceId) => ipcRenderer.invoke('txdb:log-event', level, category, message, data, spaceId),
  txdbGetEventLogs: (options) => ipcRenderer.invoke('txdb:get-event-logs', options),
  txdbGetInfo: () => ipcRenderer.invoke('txdb:get-info'),
  txdbExport: () => ipcRenderer.invoke('txdb:export'),
  watchFile: (filePath) => ipcRenderer.invoke('aider:watch-file', filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke('aider:unwatch-file', filePath),
  onFileChanged: (callback) => {
    ipcRenderer.on('aider:file-changed', (event, filePath) => callback(filePath));
  }
});

// Expose auth API
contextBridge.exposeInMainWorld('auth', {
  // Get stored token
  getToken: (service) => {
    return localStorage.getItem(`auth_token_${service}`);
  },
  
  // Clear stored token
  clearToken: (service) => {
    localStorage.removeItem(`auth_token_${service}`);
  },
  
  // Send auth success message
  sendAuthSuccess: (token, service) => {
    ipcRenderer.send('auth-success', token, service);
  },
  
  // Listen for auth token updates
  onTokenUpdate: (callback) => {
    ipcRenderer.on('auth-token-update', (event, data) => {
      // Store token in localStorage
      localStorage.setItem(`auth_token_${data.service}`, data.token);
      callback(data);
    });
  },
  
  // Listen for auth errors
  onAuthError: (callback) => {
    ipcRenderer.on('auth-error', (event, data) => {
      callback(data);
    });
  },

  // Handle Google auth in current tab
  handleGoogleAuth: (url) => {
    // Extract token from URL if present
    const urlObj = new URL(url);
    const token = urlObj.searchParams.get('token') || 
                 urlObj.searchParams.get('access_token') ||
                 urlObj.searchParams.get('code');
    
    if (token) {
      // Store token and notify success
      localStorage.setItem('auth_token_google', token);
      ipcRenderer.send('auth-success', token, 'google');
      return true;
    }
    
    // Check for OAuth code
    const code = urlObj.searchParams.get('code');
    if (code) {
      // Store code and notify success
      localStorage.setItem('auth_code_google', code);
      ipcRenderer.send('auth-success', code, 'google');
      return true;
    }
    
    return false;
  },

  // Check if URL is a Google auth redirect
  isGoogleAuthRedirect: (url) => {
    return url.includes('accounts.google.com') || 
           url.includes('oauth2') || 
           url.includes('auth') ||
           url.includes('signin') ||
           url.includes('consent');
  }
});

// Expose clipboard API
contextBridge.exposeInMainWorld('clipboard', {
  getHistory: () => ipcRenderer.invoke('clipboard:get-history'),
  clearHistory: () => ipcRenderer.invoke('clipboard:clear-history'),
  deleteItem: (id) => ipcRenderer.invoke('clipboard:delete-item', id),
  togglePin: (id) => ipcRenderer.invoke('clipboard:toggle-pin', id),
  pasteItem: (id) => ipcRenderer.invoke('clipboard:paste-item', id),
  search: (query) => ipcRenderer.invoke('clipboard:search', query),
  getStats: () => ipcRenderer.invoke('clipboard:get-stats'),
  
  // Spaces methods
  getSpaces: () => ipcRenderer.invoke('clipboard:get-spaces'),
  createSpace: (space) => ipcRenderer.invoke('clipboard:create-space', space),
  updateSpace: (id, updates) => ipcRenderer.invoke('clipboard:update-space', id, updates),
  deleteSpace: (id) => ipcRenderer.invoke('clipboard:delete-space', id),
  setCurrentSpace: (spaceId) => ipcRenderer.invoke('clipboard:set-current-space', spaceId),
  moveToSpace: (itemId, spaceId) => ipcRenderer.invoke('clipboard:move-to-space', itemId, spaceId),
  getSpaceItems: (spaceId) => ipcRenderer.invoke('clipboard:get-space-items', spaceId),
  
  // Spaces toggle
  getSpacesEnabled: () => ipcRenderer.invoke('clipboard:get-spaces-enabled'),
  toggleSpaces: (enabled) => ipcRenderer.invoke('clipboard:toggle-spaces', enabled),
  
  // Active space
  getActiveSpace: () => ipcRenderer.invoke('clipboard:get-active-space'),
  
  // Metadata methods
  getMetadata: (itemId) => ipcRenderer.invoke('clipboard:get-metadata', itemId),
  updateMetadata: (itemId, updates) => ipcRenderer.invoke('clipboard:update-metadata', itemId, updates),
  generateMetadataAI: (itemId, apiKey, customPrompt) => ipcRenderer.invoke('clipboard:generate-metadata-ai', { itemId, apiKey, customPrompt }),
  searchByTags: (tags) => ipcRenderer.invoke('clipboard:search-by-tags', tags),
  searchAIContent: (options) => ipcRenderer.invoke('clipboard:search-ai-content', options),
  getAudioData: (itemId) => ipcRenderer.invoke('clipboard:get-audio-data', itemId),
  openStorageDirectory: () => ipcRenderer.invoke('clipboard:open-storage-directory'),
  openSpaceDirectory: (spaceId) => ipcRenderer.invoke('clipboard:open-space-directory', spaceId),
  diagnose: () => ipcRenderer.invoke('clipboard:diagnose'),
  forceResume: () => ipcRenderer.invoke('clipboard:force-resume'),
  manualCheck: () => ipcRenderer.invoke('clipboard:manual-check'),
  showItemInFinder: (itemId) => ipcRenderer.invoke('clipboard:show-item-in-finder', itemId),
  
  // Get current user
  getCurrentUser: () => ipcRenderer.invoke('clipboard:get-current-user'),
  
  // Open space notebook
  openSpaceNotebook: (spaceId) => ipcRenderer.invoke('clipboard:open-space-notebook', spaceId),
  
  // Screenshot capture
  getScreenshotCaptureEnabled: () => ipcRenderer.invoke('clipboard:get-screenshot-capture-enabled'),
  toggleScreenshotCapture: (enabled) => ipcRenderer.invoke('clipboard:toggle-screenshot-capture', enabled),
  
  // PDF methods
  getPDFPageThumbnail: (itemId, pageNumber) => ipcRenderer.invoke('clipboard:get-pdf-page-thumbnail', itemId, pageNumber),
  generateSpacePDF: (spaceId, options) => ipcRenderer.invoke('clipboard:generate-space-pdf', spaceId, options),
  exportSpacePDF: (spaceId, options) => ipcRenderer.invoke('clipboard:export-space-pdf', spaceId, options),
      smartExportSpace: (spaceId) => ipcRenderer.invoke('clipboard:smart-export-space', spaceId),
    openExportPreview: (spaceId, options) => ipcRenderer.invoke('clipboard:open-export-preview', spaceId, options),
  
  // Screenshot methods
  completeScreenshot: (data) => ipcRenderer.invoke('clipboard:complete-screenshot', data),
  
  // Website monitoring methods
  addWebsiteMonitor: (config) => ipcRenderer.invoke('clipboard:add-website-monitor', config),
  checkWebsite: (monitorId) => ipcRenderer.invoke('clipboard:check-website', monitorId),
  getWebsiteMonitors: () => ipcRenderer.invoke('clipboard:get-website-monitors'),
  getMonitorHistory: (monitorId) => ipcRenderer.invoke('clipboard:get-monitor-history', monitorId),
  removeWebsiteMonitor: (monitorId) => ipcRenderer.invoke('clipboard:remove-website-monitor', monitorId),
  pauseWebsiteMonitor: (monitorId) => ipcRenderer.invoke('clipboard:pause-website-monitor', monitorId),
  resumeWebsiteMonitor: (monitorId) => ipcRenderer.invoke('clipboard:resume-website-monitor', monitorId),
  
  // Black hole widget methods
  openBlackHole: () => ipcRenderer.invoke('clipboard:open-black-hole'),
  addText: (data) => ipcRenderer.invoke('black-hole:add-text', data),
  addHtml: (data) => ipcRenderer.invoke('black-hole:add-html', data),
  addImage: (data) => ipcRenderer.invoke('black-hole:add-image', data),
  addFile: (data) => ipcRenderer.invoke('black-hole:add-file', data),
  

  
  // Event listeners
  onHistoryUpdate: (callback) => {
    ipcRenderer.on('clipboard:history-updated', (event, history) => {
      callback(history);
    });
  },
  onSpacesUpdate: (callback) => {
    ipcRenderer.on('clipboard:spaces-updated', (event, spaces) => {
      callback(spaces);
    });
  },
  onSpacesToggled: (callback) => {
    ipcRenderer.on('clipboard:spaces-toggled', (event, enabled) => {
      callback(enabled);
    });
  },
  onActiveSpaceChanged: (callback) => {
    ipcRenderer.on('clipboard:active-space-changed', (event, data) => {
      callback(data);
    });
  }
});
// Screenshot Capture API
contextBridge.exposeInMainWorld('screenshot', {
  /**
   * Capture a screenshot from a URL
   * @param {string} url - The URL to capture
   * @param {Object} options - Options: width, height, fullPage, format, quality, timeout, delay, selector
   * @returns {Promise<{success: boolean, data?: string, error?: string}>}
   */
  capture: (url, options = {}) => ipcRenderer.invoke('screenshot:capture', url, options),
  
  /**
   * Capture a screenshot and save to file
   * @param {string} url - The URL to capture
   * @param {string} outputPath - Path to save the screenshot
   * @param {Object} options - Capture options
   * @returns {Promise<{success: boolean, path?: string, error?: string}>}
   */
  captureToFile: (url, outputPath, options = {}) => ipcRenderer.invoke('screenshot:capture-to-file', url, outputPath, options),
  
  /**
   * Capture responsive screenshots at multiple viewport sizes
   * @param {string} url - The URL to capture
   * @param {Array} viewports - Array of {name, width, height} or null for defaults
   * @param {Object} options - Additional capture options
   * @returns {Promise<{success: boolean, results?: Array, error?: string}>}
   */
  captureResponsive: (url, viewports = null, options = {}) => ipcRenderer.invoke('screenshot:capture-responsive', url, viewports, options),
  
  /**
   * Capture a thumbnail (smaller, optimized image)
   * @param {string} url - The URL to capture
   * @param {Object} options - Options: width (default 320), height (default 240), quality
   * @returns {Promise<{success: boolean, data?: string, error?: string}>}
   */
  captureThumbnail: (url, options = {}) => ipcRenderer.invoke('screenshot:capture-thumbnail', url, options)
});


// Web Scraper API
contextBridge.exposeInMainWorld('scraper', {
  /**
   * Get full HTML content of a page
   * @param {string} url - URL to scrape
   * @param {Object} options - Options: timeout, waitUntil, delay, waitForSelector, waitForIdle
   * @returns {Promise<{success: boolean, html?: string, error?: string}>}
   */
  getHTML: (url, options = {}) => ipcRenderer.invoke('scraper:get-html', url, options),
  
  /**
   * Get text content of a page (no HTML tags)
   * @param {string} url - URL to scrape
   * @param {Object} options - Scrape options
   * @returns {Promise<{success: boolean, text?: string, error?: string}>}
   */
  getText: (url, options = {}) => ipcRenderer.invoke('scraper:get-text', url, options),
  
  /**
   * Get all links from a page
   * @param {string} url - URL to scrape
   * @param {Object} options - Scrape options
   * @returns {Promise<{success: boolean, links?: Array, error?: string}>}
   */
  getLinks: (url, options = {}) => ipcRenderer.invoke('scraper:get-links', url, options),
  
  /**
   * Get all images from a page
   * @param {string} url - URL to scrape
   * @param {Object} options - Options include loadLazyImages: true
   * @returns {Promise<{success: boolean, images?: Array, error?: string}>}
   */
  getImages: (url, options = {}) => ipcRenderer.invoke('scraper:get-images', url, options),
  
  /**
   * Extract specific elements using CSS selectors
   * @param {string} url - URL to scrape
   * @param {string|Array} selectors - CSS selector(s) to extract
   * @param {Object} options - Scrape options
   * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
   */
  extract: (url, selectors, options = {}) => ipcRenderer.invoke('scraper:extract', url, selectors, options),
  
  /**
   * Get structured data (JSON-LD, Open Graph, Twitter Cards, meta tags)
   * @param {string} url - URL to scrape
   * @param {Object} options - Scrape options
   * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
   */
  getStructuredData: (url, options = {}) => ipcRenderer.invoke('scraper:get-structured-data', url, options),
  
  /**
   * Execute custom JavaScript on a page
   * @param {string} url - URL to scrape
   * @param {string} script - JavaScript code to execute
   * @param {Object} options - Scrape options
   * @returns {Promise<{success: boolean, result?: any, error?: string}>}
   */
  evaluate: (url, script, options = {}) => ipcRenderer.invoke('scraper:evaluate', url, script, options)
});


// Image Downloader API
contextBridge.exposeInMainWorld('imageDownloader', {
  /**
   * Download main images from a web page to a space directory
   * @param {string} url - Web page URL to scrape images from
   * @param {string} spaceDir - Space directory path (images saved to spaceDir/temp_images/)
   * @param {Object} options - Options: minWidth, minHeight, maxImages, loadLazyImages
   * @returns {Promise<{success: boolean, downloaded?: Array, failed?: Array, error?: string}>}
   */
  downloadFromPage: (url, spaceDir, options = {}) => 
    ipcRenderer.invoke('images:download-from-page', url, spaceDir, options),
  
  /**
   * Download a single image
   * @param {string} imageUrl - Direct URL to the image
   * @param {string} outputPath - Full path to save the image
   * @returns {Promise<{success: boolean, path?: string, size?: number, error?: string}>}
   */
  downloadSingle: (imageUrl, outputPath) => 
    ipcRenderer.invoke('images:download-single', imageUrl, outputPath)
});


// CSS Extractor API
contextBridge.exposeInMainWorld('cssExtractor', {
  /**
   * Extract all CSS from a page (stylesheets, style tags, inline styles)
   * @param {string} url - URL to extract CSS from
   * @param {Object} options - Options: timeout, waitUntil
   * @returns {Promise<{success: boolean, combined?: string, styleTags?: Array, linkedStylesheets?: Array, stats?: Object}>}
   */
  extractAll: (url, options = {}) => ipcRenderer.invoke('css:extract-all', url, options),
  
  /**
   * Extract CSS variables (custom properties)
   * @param {string} url - URL to extract from
   * @param {Object} options - Options
   * @returns {Promise<{success: boolean, root?: Object, all?: Array}>}
   */
  extractVariables: (url, options = {}) => ipcRenderer.invoke('css:extract-variables', url, options),
  
  /**
   * Extract color palette from CSS
   * @param {string} url - URL to extract from
   * @param {Object} options - Options
   * @returns {Promise<{success: boolean, colors?: Array, total?: number}>}
   */
  extractColors: (url, options = {}) => ipcRenderer.invoke('css:extract-colors', url, options),
  
  /**
   * Extract font information
   * @param {string} url - URL to extract from
   * @param {Object} options - Options
   * @returns {Promise<{success: boolean, families?: Array, fontFaces?: Array}>}
   */
  extractFonts: (url, options = {}) => ipcRenderer.invoke('css:extract-fonts', url, options),
  
  /**
   * Extract computed styles for specific elements
   * @param {string} url - URL to extract from
   * @param {string|Array} selectors - CSS selector(s)
   * @param {Object} options - Options
   * @returns {Promise<{success: boolean, styles?: Object}>}
   */
  extractComputed: (url, selectors, options = {}) => ipcRenderer.invoke('css:extract-computed', url, selectors, options)
});


// Style Guide Extractor API
contextBridge.exposeInMainWorld('styleGuideExtractor', {
  /**
   * Extract complete style guide from a URL
   * @param {string} url - URL to analyze
   * @param {Object} options - Options
   * @returns {Promise<{success: boolean, styleGuide?: Object}>}
   */
  extract: (url, options = {}) => ipcRenderer.invoke('styleguide:extract', url, options),
  
  /**
   * Extract style guide with markdown report and CSS variables
   * @param {string} url - URL to analyze
   * @param {Object} options - Options
   * @returns {Promise<{success: boolean, styleGuide?: Object, report?: string, cssVariables?: string}>}
   */
  extractWithReport: (url, options = {}) => ipcRenderer.invoke('styleguide:extract-with-report', url, options)
});


// Copy Style Extractor API
contextBridge.exposeInMainWorld('copyStyleExtractor', {
  /**
   * Extract copywriting style guide from a URL
   * @param {string} url - URL to analyze
   * @param {Object} options - Options
   * @returns {Promise<{success: boolean, copyGuide?: Object}>}
   */
  extract: (url, options = {}) => ipcRenderer.invoke('copystyle:extract', url, options),
  
  /**
   * Extract copy style with markdown report and voice summary
   * @param {string} url - URL to analyze
   * @param {Object} options - Options
   * @returns {Promise<{success: boolean, copyGuide?: Object, report?: string, voiceSummary?: string}>}
   */
  extractWithReport: (url, options = {}) => ipcRenderer.invoke('copystyle:extract-with-report', url, options)
});


// Style Prompt Generator API
contextBridge.exposeInMainWorld('promptGenerator', {
  /**
   * Generate a design prompt from visual style guide
   * @param {Object} styleGuide - Visual style guide from styleGuideExtractor
   * @param {Object} options - {type, purpose, additionalContext, includeColors, includeTypography, includeButtons}
   */
  generateDesign: (styleGuide, options = {}) => ipcRenderer.invoke('prompt:generate-design', styleGuide, options),
  
  /**
   * Generate a copy/content prompt from copy style guide
   * @param {Object} copyGuide - Copy guide from copyStyleExtractor
   * @param {Object} options - {type, topic, targetAudience, additionalContext, length}
   */
  generateCopy: (copyGuide, options = {}) => ipcRenderer.invoke('prompt:generate-copy', copyGuide, options),
  
  /**
   * Generate a combined design + copy prompt
   * @param {Object} styleGuide - Visual style guide
   * @param {Object} copyGuide - Copy style guide
   * @param {Object} options - {type, purpose, topic, targetAudience, additionalContext}
   */
  generateFull: (styleGuide, copyGuide, options = {}) => ipcRenderer.invoke('prompt:generate-full', styleGuide, copyGuide, options),
  
  /**
   * Generate a landing page prompt
   */
  generateLandingPage: (styleGuide, copyGuide, options = {}) => ipcRenderer.invoke('prompt:generate-landing-page', styleGuide, copyGuide, options),
  
  /**
   * Generate an email prompt
   */
  generateEmail: (styleGuide, copyGuide, options = {}) => ipcRenderer.invoke('prompt:generate-email', styleGuide, copyGuide, options),
  
  /**
   * Generate a social media post prompt
   * @param {Object} copyGuide - Copy style guide
   * @param {Object} options - {platform: 'twitter'|'linkedin'|'instagram'|'facebook', topic}
   */
  generateSocial: (copyGuide, options = {}) => ipcRenderer.invoke('prompt:generate-social', copyGuide, options),
  
  /**
   * Generate headline variations prompt
   * @param {Object} copyGuide - Copy style guide
   * @param {Object} options - {topic, count}
   */
  generateHeadlines: (copyGuide, options = {}) => ipcRenderer.invoke('prompt:generate-headlines', copyGuide, options),
  
  /**
   * Generate CTA variations prompt
   * @param {Object} copyGuide - Copy style guide
   * @param {Object} options - {action, count}
   */
  generateCTA: (copyGuide, options = {}) => ipcRenderer.invoke('prompt:generate-cta', copyGuide, options)
});


  // Add multimodal methods to promptGenerator
  // Note: These should be added to the existing promptGenerator object
  // Adding them as separate exposure for now

contextBridge.exposeInMainWorld('promptGeneratorMultimodal', {
  /**
   * Generate a multimodal prompt with images for AI vision models
   * @param {Object} options - {styleGuide, copyGuide, images, type, purpose, targetAudience, additionalContext}
   * @param {Array} options.images - Array of {base64, path, description, type} objects
   * @returns {Object} {text, images, messages: {claude, openai, generic}}
   */
  generateMultimodal: (options = {}) => ipcRenderer.invoke('prompt:generate-multimodal', options),
  
  /**
   * Generate a design prompt with categorized images
   * @param {Object} styleGuide - Visual style guide
   * @param {Array} images - Array of {base64, type: 'full-page'|'hero'|'component'|'responsive', description}
   * @param {Object} options - {type, purpose, additionalContext}
   */
  generateDesignWithImages: (styleGuide, images, options = {}) => 
    ipcRenderer.invoke('prompt:generate-design-with-images', styleGuide, images, options)
});


// Image Generation Prompt APIs
contextBridge.exposeInMainWorld('imageGenPrompts', {
  /**
   * Generate DALL-E 3 optimized prompt
   * @param {Object} styleGuide - Visual style guide
   * @param {Object} options - {subject, style, mood, additionalDetails, size, quality}
   * @returns {Object} {prompt, apiParams, variations}
   */
  generateDALLE: (styleGuide, options = {}) => ipcRenderer.invoke('prompt:generate-dalle', styleGuide, options),
  
  /**
   * Generate Google Imagen optimized prompt
   * @param {Object} styleGuide - Visual style guide
   * @param {Object} options - {subject, imageType, aspectRatio, mood, additionalDetails}
   * @returns {Object} {prompt, apiParams, vertexAI}
   */
  generateImagen: (styleGuide, options = {}) => ipcRenderer.invoke('prompt:generate-imagen', styleGuide, options),
  
  /**
   * Generate prompts for ALL image generation services
   * @param {Object} styleGuide - Visual style guide
   * @param {Object} copyGuide - Copy style guide
   * @param {Object} options - {subject, purpose, targetAudience}
   * @returns {Object} {dalle, imagen, midjourney, stableDiffusion, summary}
   */
  generateAll: (styleGuide, copyGuide, options = {}) => 
    ipcRenderer.invoke('prompt:generate-image-all', styleGuide, copyGuide, options)
});


// ============================================
// TEST AGENT API
// ============================================
contextBridge.exposeInMainWorld('testAgent', {
  generatePlan: (htmlFilePath, useAI) => ipcRenderer.invoke('test-agent:generate-plan', htmlFilePath, useAI),
  runTests: (htmlFilePath, options) => ipcRenderer.invoke('test-agent:run-tests', htmlFilePath, options),
  runAccessibilityTest: (htmlFilePath) => ipcRenderer.invoke('test-agent:accessibility', htmlFilePath),
  runPerformanceTest: (htmlFilePath) => ipcRenderer.invoke('test-agent:performance', htmlFilePath),
  runVisualTest: (htmlFilePath, baseline) => ipcRenderer.invoke('test-agent:visual', htmlFilePath, baseline),
  runCrossBrowserTest: (htmlFilePath) => ipcRenderer.invoke('test-agent:cross-browser', htmlFilePath),
  runInteractiveTest: (htmlFilePath) => ipcRenderer.invoke('test-agent:interactive', htmlFilePath),
  close: () => ipcRenderer.invoke('test-agent:close'),
  onProgress: (callback) => ipcRenderer.on('test-agent:progress', (event, result) => callback(result))
});
