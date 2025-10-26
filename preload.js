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
        'black-hole:inactive'
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
        'logger:get-files'
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
          'clipboard:write-text'
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