// Preload script runs in an isolated context, but has access to Node.js APIs
const { contextBridge, ipcRenderer } = require('electron');

// Set up console interceptor for renderer process
// PERFORMANCE: Uses batching to reduce IPC overhead
(function() {
  // Store original console methods
  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
    info: console.info.bind(console)
  };

  // PERFORMANCE: Batch log messages to reduce IPC calls
  const logBuffer = [];
  const BATCH_INTERVAL = 500; // Flush every 500ms
  const MAX_BUFFER_SIZE = 50; // Flush if buffer gets too large
  let flushTimeout = null;
  let isLoggingEnabled = true; // Can be disabled for maximum performance

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

  // Flush batched logs to main process
  function flushLogs() {
    if (logBuffer.length === 0) return;
    
    try {
      // Send all buffered logs in a single IPC call
      ipcRenderer.send('logger:batch', logBuffer.slice());
      logBuffer.length = 0; // Clear buffer
    } catch (err) {
      // Fail silently
    }
    flushTimeout = null;
  }

  // Schedule a flush if not already scheduled
  function scheduleFlush() {
    if (!flushTimeout) {
      flushTimeout = setTimeout(flushLogs, BATCH_INTERVAL);
    }
  }

  // Override console methods
  const interceptConsoleMethod = (method, level) => {
    console[method] = function(...args) {
      // Call original console method
      originalConsole[method](...args);
      
      // Skip logging if disabled for performance
      if (!isLoggingEnabled) return;
      
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
      
      // Add to buffer
      const logEntry = {
        level,
        message: `[Console.${method}] ${message}`,
        data: {
          window: getWindowContext(),
          url: window.location ? window.location.href : 'unknown',
          consoleMethod: method,
          timestamp: new Date().toISOString()
        }
      };
      
      // Errors are sent immediately for visibility
      if (level === 'error') {
        try {
          ipcRenderer.send('logger:error', logEntry);
        } catch (err) {
          // Fail silently
        }
      } else {
        // Batch other logs
        logBuffer.push(logEntry);
        
        // Flush immediately if buffer is full
        if (logBuffer.length >= MAX_BUFFER_SIZE) {
          flushLogs();
        } else {
          scheduleFlush();
        }
      }
    };
  };

  // Intercept all console methods
  interceptConsoleMethod('log', 'info');
  interceptConsoleMethod('warn', 'warn');
  interceptConsoleMethod('error', 'error');
  interceptConsoleMethod('debug', 'debug');
  interceptConsoleMethod('info', 'info');
  
  // Flush remaining logs before page unload
  window.addEventListener('beforeunload', flushLogs);
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
        'black-hole:debug',
        'black-hole:widget-ready',
        'black-hole:resize-window',
        'black-hole:move-window',
        'black-hole:get-position',
        'black-hole:restore-position',
        'open-external-url',
        // Credential management channels
        'credentials-captured',
        'credentials-dismiss-save',
        'login-form-detected'
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
        'save-generated-document',
        'paste-clipboard-data',
        'black-hole:init',
        'black-hole:position-response',
        'external-file-drop',
        'prepare-for-download',
        'check-widget-ready',
        // Credential management channels
        'show-save-credential-prompt',
        // LLM usage tracking
        'llm:call-made'
      ];
      if (validChannels.includes(channel)) {
        // Deliberately strip event as it includes `sender` 
        ipcRenderer.on(channel, (event, ...args) => func(...args));
      }
    },
    // NOTE: invoke method is defined below with all channels merged for better maintainability
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
    
    // Context Provider API
    getCustomFacts: () => ipcRenderer.invoke('voice-task-sdk:get-facts'),
    addCustomFact: (key, value, category) => ipcRenderer.invoke('voice-task-sdk:add-fact', key, value, category),
    removeCustomFact: (key) => ipcRenderer.invoke('voice-task-sdk:remove-fact', key),
    listContextProviders: () => ipcRenderer.invoke('voice-task-sdk:list-providers'),
    enableContextProvider: (providerId) => ipcRenderer.invoke('voice-task-sdk:enable-provider', providerId),
    disableContextProvider: (providerId) => ipcRenderer.invoke('voice-task-sdk:disable-provider', providerId),
    configureContextProvider: (providerId, settings) => ipcRenderer.invoke('voice-task-sdk:configure-provider', providerId, settings),
    getCurrentContext: () => ipcRenderer.invoke('voice-task-sdk:get-context'),
    clearConversationHistory: () => ipcRenderer.invoke('voice-task-sdk:clear-history'),
    
    // Video Release - YouTube/Vimeo Authentication
    authenticateYouTube: () => ipcRenderer.invoke('release:authenticate-youtube'),
    authenticateVimeo: () => ipcRenderer.invoke('release:authenticate-vimeo'),
    getYouTubeStatus: () => ipcRenderer.invoke('release:get-youtube-status'),
    getVimeoStatus: () => ipcRenderer.invoke('release:get-vimeo-status'),

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
    refreshGSXToken: () => ipcRenderer.invoke('gsx:refresh-token'),
    
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
    
    // Credential Management API (IDW auto-login)
    credentialsCheck: (url) => ipcRenderer.invoke('credentials-check', { url }),
    credentialsGet: (url) => ipcRenderer.invoke('credentials-get', { url }),
    credentialsList: () => ipcRenderer.invoke('credentials-list'),
    credentialsSavePending: (url) => ipcRenderer.invoke('credentials-save-pending', { url }),
    credentialsSaveManual: (url, username, password, idwName) => 
      ipcRenderer.invoke('credentials-save-manual', { url, username, password, idwName }),
    credentialsDelete: (accountKey) => ipcRenderer.invoke('credentials-delete', { accountKey }),
    credentialsDeleteAll: () => ipcRenderer.invoke('credentials-delete-all'),
    
    // Unified invoke method for all async IPC calls
    // PERFORMANCE: Merged all invoke channels into a single definition
    invoke: (channel, ...args) => {
      const validChannels = [
        // Clipboard channels
        'get-clipboard-data',
        'get-clipboard-files',
        'black-hole:get-pending-data',
        'black-hole:create-space',
        // Smart export channels
        'smart-export:extract-styles',
        'smart-export:extract-content-guidelines',
        'smart-export:generate-with-guidelines',
        // Logger channels
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
        'idw-store:add-to-menu',
        // Credential management channels
        'credentials-check',
        'credentials-get',
        'credentials-list',
        'credentials-save-pending',
        'credentials-save-manual',
        'credentials-delete',
        'credentials-delete-all'
      ];
      if (validChannels.includes(channel)) {
        return ipcRenderer.invoke(channel, ...args);
      }
      return Promise.reject(new Error(`Invalid invoke channel: ${channel}`));
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
    generateCursorPrompt: (analysis) => ipcRenderer.invoke('ai:generate-cursor-prompt', analysis),
    
    // Headless AI prompts - run prompts in hidden windows
    runHeadlessClaudePrompt: (prompt, options) => ipcRenderer.invoke('claude:runHeadlessPrompt', prompt, options),
    
    // Unified Claude Service - headless first, API fallback
    // Use this for all Claude completions - it will try free headless first, then API
    unifiedClaude: {
      // Main completion method
      complete: (prompt, options) => ipcRenderer.invoke('claude:unified-complete', prompt, options),
      // Get status of headless and API availability
      getStatus: () => ipcRenderer.invoke('claude:unified-status'),
      // Update settings (preferHeadless, headlessTimeout, apiFallbackEnabled)
      updateSettings: (settings) => ipcRenderer.invoke('claude:unified-update-settings', settings)
    }
  }
);

// Expose electron API for relaunch functionality
contextBridge.exposeInMainWorld(
  'electron', {
    send: (channel, data) => {
      // Whitelist channels to ensure secure IPC
      const validChannels = ['relaunch-app', 'black-hole:resize-window', 'black-hole:move-window', 'black-hole:get-position', 'black-hole:restore-position', 'black-hole:active', 'black-hole:inactive', 'black-hole:widget-ready', 'show-notification', 'float-card:close', 'float-card:ready'];
      if (validChannels.includes(channel)) {
        ipcRenderer.send(channel, data);
      } else {
        console.warn('[Preload] Invalid send channel:', channel);
      }
    },
    // Direct close for float card windows
    closeWindow: () => {
      ipcRenderer.send('float-card:close');
    },
    on: (channel, func) => {
      const validChannels = [
        'clipboard:history-updated',
        'clipboard:spaces-updated', 
        'clipboard:spaces-toggled',
        'clipboard:active-space-changed',
        'clipboard:screenshot-capture-toggled',
        'black-hole:position-response',
        'black-hole:init',
        'external-file-drop',
        'prepare-for-download',
        'check-widget-ready',
        'paste-clipboard-data',
        'float-card:init'
      ];
      if (validChannels.includes(channel)) {
        ipcRenderer.on(channel, (event, ...args) => func(event, ...args));
      }
    },
    ipcRenderer: {
      send: (channel, data) => {
        const validChannels = ['black-hole:resize-window', 'black-hole:move-window', 'black-hole:get-position', 'black-hole:restore-position', 'black-hole:active', 'black-hole:inactive', 'black-hole:widget-ready', 'show-notification', 'float-card:close', 'float-card:ready', 'float-card:start-drag'];
        if (validChannels.includes(channel)) {
          ipcRenderer.send(channel, data);
        } else {
          console.warn('[Preload] Invalid send channel:', channel);
        }
      },
      on: (channel, func) => {
        const validChannels = ['black-hole:position-response', 'black-hole:init', 'external-file-drop', 'prepare-for-download', 'check-widget-ready', 'paste-clipboard-data', 'float-card:init'];
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
          'get-clipboard-data',
          'get-clipboard-files',
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
          // Native drag and float card channels
          'clipboard:start-native-drag',
          'clipboard:float-item',
          'clipboard:close-float',
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
  triggerMissionControl: () => ipcRenderer.send('trigger-mission-control'),
  clearCacheAndReload: (options) => ipcRenderer.send('clear-cache-and-reload', options),
  openSettings: () => ipcRenderer.send('open-settings'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  
  // Keep-alive ping/pong for preventing zombie windows
  ping: () => ipcRenderer.send('window:ping'),
  onPong: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('window:pong', handler);
    return () => ipcRenderer.removeListener('window:pong', handler);
  },
  
  // Log event (for branch events)
  logEvent: (eventType, eventData) => ipcRenderer.send('logger:event', { eventType, eventData }),
  
  // Agent intervention system
  // Listen for agent escalation notifications
  onAgentIntervention: (callback) => {
    ipcRenderer.on('agent:user-intervention-needed', (event, escalation) => callback(escalation));
    // Return cleanup function
    return () => ipcRenderer.removeListener('agent:user-intervention-needed', callback);
  },
  
  // Respond to an agent escalation
  respondToAgentIntervention: (escalationId, action, details) => 
    ipcRenderer.invoke('agent:respond-to-escalation', escalationId, action, details),
  
  // Get pending escalations
  getPendingEscalations: () => ipcRenderer.invoke('agent:get-pending-escalations'),
  
  // HUD Activity updates - listen for activity from Aider Bridge and Agent
  onHUDActivity: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('hud:activity', handler);
    // Return cleanup function
    return () => ipcRenderer.removeListener('hud:activity', handler);
  }
});

// Expose Resource Manager API for CPU/GPU throttling
contextBridge.exposeInMainWorld('resourceManager', {
  // Get current status
  getStatus: () => ipcRenderer.invoke('resource-manager:get-status'),
  
  // Toggle resource monitoring
  toggle: (enabled) => ipcRenderer.invoke('resource-manager:toggle', enabled),
  
  // Manual throttle controls
  throttleWindow: (windowId) => ipcRenderer.invoke('resource-manager:throttle-window', windowId),
  unthrottleWindow: (windowId) => ipcRenderer.invoke('resource-manager:unthrottle-window', windowId),
  
  // Update configuration
  setConfig: (config) => ipcRenderer.invoke('resource-manager:set-config', config),
  
  // Listen for resource warnings
  onWarning: (callback) => {
    ipcRenderer.on('resource-warning', (event, data) => callback(data));
  },
  
  // Remove warning listener
  removeWarningListener: () => {
    ipcRenderer.removeAllListeners('resource-warning');
  }
});

// Expose Speech Recognition Bridge (Whisper-based) for web apps
// Use this instead of Web Speech API which doesn't work in Electron
contextBridge.exposeInMainWorld('speechBridge', {
  // Check if speech bridge is available and has API key
  isAvailable: () => ipcRenderer.invoke('speech:is-available'),
  
  // Transcribe audio data (base64 encoded)
  // Usage: const result = await speechBridge.transcribe({ audioData: base64, language: 'en', format: 'webm' })
  transcribe: (options) => ipcRenderer.invoke('speech:transcribe', options),
  
  // Transcribe from file path
  transcribeFile: (options) => ipcRenderer.invoke('speech:transcribe-file', options),
  
  // Get API key (to check if configured)
  getApiKey: () => ipcRenderer.invoke('speech:get-api-key'),
  
  // Helper: Convert Blob to base64 for transcription
  // Call this from your web app before calling transcribe()
  blobToBase64: async (blob) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  },
  
  // Request microphone permission from macOS
  // Call this before using getUserMedia to ensure proper permission dialog
  requestMicPermission: () => ipcRenderer.invoke('speech:request-mic-permission')
});

// Expose Realtime Speech API (OpenAI Realtime API for streaming transcription)
// This provides low-latency real-time speech-to-text as you speak
contextBridge.exposeInMainWorld('realtimeSpeech', {
  // Connect to OpenAI Realtime API
  connect: () => ipcRenderer.invoke('realtime-speech:connect'),
  
  // Disconnect from the API
  disconnect: () => ipcRenderer.invoke('realtime-speech:disconnect'),
  
  // Check connection status
  isConnected: () => ipcRenderer.invoke('realtime-speech:is-connected'),
  
  // Send audio chunk (base64 encoded PCM16, 24kHz, mono)
  sendAudio: (base64Audio) => ipcRenderer.invoke('realtime-speech:send-audio', base64Audio),
  
  // Commit audio buffer (signal end of speech)
  commit: () => ipcRenderer.invoke('realtime-speech:commit'),
  
  // Clear audio buffer
  clear: () => ipcRenderer.invoke('realtime-speech:clear'),
  
  // Listen for transcription events
  // Events: transcript_delta (partial), transcript (final), speech_started, speech_stopped, error
  onEvent: (callback) => {
    const handler = (event, data) => {
      callback(data);
    };
    ipcRenderer.on('realtime-speech:event', handler);
    return () => ipcRenderer.removeListener('realtime-speech:event', handler);
  },
  
  // Helper: Start streaming from microphone with automatic audio processing
  // Returns { stop: Function, onTranscript: Function }
  startStreaming: async function(onTranscript, options = {}) {
    // Request mic permission first
    await ipcRenderer.invoke('speech:request-mic-permission');
    
    // Connect to Realtime API
    const connectResult = await this.connect();
    if (!connectResult.success) {
      throw new Error(connectResult.error || 'Failed to connect');
    }
    
    // Set up event listener
    const removeListener = this.onEvent((event) => {
      if (event.type === 'transcript' || event.type === 'transcript_delta') {
        onTranscript(event.text, event.isFinal);
      }
    });
    
    // Set up audio capture with AudioContext for proper format
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        channelCount: 1,
        sampleRate: 24000,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    
    const audioContext = new AudioContext({ sampleRate: 24000 });
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    
    const sendAudio = this.sendAudio.bind(this);
    
    processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      // Convert Float32 to Int16
      const int16Data = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      // Convert to base64
      const uint8Array = new Uint8Array(int16Data.buffer);
      let binary = '';
      for (let i = 0; i < uint8Array.length; i++) {
        binary += String.fromCharCode(uint8Array[i]);
      }
      const base64 = btoa(binary);
      sendAudio(base64);
    };
    
    source.connect(processor);
    processor.connect(audioContext.destination);
    
    console.log('🎤 Realtime speech streaming started');
    
    // Return stop function
    return {
      stop: async () => {
        processor.disconnect();
        source.disconnect();
        audioContext.close();
        stream.getTracks().forEach(t => t.stop());
        removeListener();
        await this.disconnect();
        console.log('🎤 Realtime speech streaming stopped');
      }
    };
  }
});

// ==================== UNIFIED MICROPHONE MANAGER ====================
// Centralized mic access with proper async cleanup
// Based on the working Voice Mode implementation above
// Other consumers (recorder, web-recorder) should use this API

// Singleton instance for mic management
const micManagerState = {
  stream: null,
  audioContext: null,
  source: null,
  processor: null,
  activeConsumer: null,
  acquiredAt: null
};

const defaultMicConstraints = {
  channelCount: 1,
  sampleRate: 24000,
  echoCancellation: true,
  noiseSuppression: true
};

contextBridge.exposeInMainWorld('micManager', {
  /**
   * Acquire microphone access
   * @param {string} consumerId - Identifier (e.g., 'recorder', 'web-recorder')
   * @param {object} constraints - Audio constraints
   * @returns {object|null} { stream, audioContext } or null if in use
   */
  acquire: async (consumerId, constraints = {}) => {
    // Check if already in use by different consumer
    if (micManagerState.stream && micManagerState.activeConsumer !== consumerId) {
      console.warn(`[MicManager] Mic in use by "${micManagerState.activeConsumer}", requested by "${consumerId}"`);
      return null;
    }
    
    // Already acquired by this consumer
    if (micManagerState.stream && micManagerState.activeConsumer === consumerId) {
      console.log(`[MicManager] Mic already held by "${consumerId}"`);
      return { 
        stream: micManagerState.stream, 
        audioContext: micManagerState.audioContext 
      };
    }
    
    try {
      const audioConstraints = { ...defaultMicConstraints, ...constraints };
      const sampleRate = audioConstraints.sampleRate || 24000;
      
      // Request permission first
      await ipcRenderer.invoke('speech:request-mic-permission');
      
      // Acquire stream
      micManagerState.stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints
      });
      
      micManagerState.audioContext = new AudioContext({ sampleRate });
      micManagerState.activeConsumer = consumerId;
      micManagerState.acquiredAt = Date.now();
      
      console.log(`[MicManager] 🎤 Mic acquired by "${consumerId}"`);
      
      return { 
        stream: micManagerState.stream, 
        audioContext: micManagerState.audioContext 
      };
    } catch (error) {
      console.error(`[MicManager] Failed to acquire mic:`, error);
      throw error;
    }
  },

  /**
   * Release microphone - MUST be awaited for proper cleanup
   * @param {string} consumerId - Must match the consumer that acquired
   */
  release: async (consumerId) => {
    if (micManagerState.activeConsumer !== consumerId) {
      if (micManagerState.activeConsumer) {
        console.warn(`[MicManager] "${consumerId}" tried to release mic owned by "${micManagerState.activeConsumer}"`);
      }
      return;
    }
    
    // Cleanup in proper order (matches voice mode pattern)
    if (micManagerState.processor) {
      micManagerState.processor.disconnect();
      micManagerState.processor = null;
    }
    if (micManagerState.source) {
      micManagerState.source.disconnect();
      micManagerState.source = null;
    }
    if (micManagerState.audioContext) {
      await micManagerState.audioContext.close();
      micManagerState.audioContext = null;
    }
    if (micManagerState.stream) {
      micManagerState.stream.getTracks().forEach(track => track.stop());
      micManagerState.stream = null;
    }
    
    const duration = micManagerState.acquiredAt ? Date.now() - micManagerState.acquiredAt : 0;
    micManagerState.activeConsumer = null;
    micManagerState.acquiredAt = null;
    
    console.log(`[MicManager] 🎤 Mic released by "${consumerId}" (held for ${duration}ms)`);
  },

  /**
   * Force release - for emergency cleanup
   */
  forceRelease: async () => {
    const consumer = micManagerState.activeConsumer || 'unknown';
    console.warn(`[MicManager] Force releasing mic (was held by "${consumer}")`);
    
    if (micManagerState.processor) micManagerState.processor.disconnect();
    if (micManagerState.source) micManagerState.source.disconnect();
    if (micManagerState.audioContext) await micManagerState.audioContext.close();
    if (micManagerState.stream) micManagerState.stream.getTracks().forEach(t => t.stop());
    
    micManagerState.processor = null;
    micManagerState.source = null;
    micManagerState.audioContext = null;
    micManagerState.stream = null;
    micManagerState.activeConsumer = null;
    micManagerState.acquiredAt = null;
  },

  /**
   * Check if mic is in use
   */
  isInUse: () => !!micManagerState.stream,

  /**
   * Get active consumer ID
   */
  getActiveConsumer: () => micManagerState.activeConsumer,

  /**
   * Get full status for debugging
   */
  getStatus: () => ({
    inUse: !!micManagerState.stream,
    consumer: micManagerState.activeConsumer,
    acquiredAt: micManagerState.acquiredAt,
    duration: micManagerState.acquiredAt ? Date.now() - micManagerState.acquiredAt : null
  })
});

// Expose Voice TTS API (ElevenLabs Text-to-Speech for voice mode)
contextBridge.exposeInMainWorld('voiceTTS', {
  // Speak text using ElevenLabs TTS
  // Returns path to generated audio file
  speak: (text, voice = 'Rachel') => ipcRenderer.invoke('voice:speak', text, voice),
  
  // Stop any currently playing TTS audio
  stop: () => ipcRenderer.invoke('voice:stop'),
  
  // Check if TTS is available (has API key)
  isAvailable: () => ipcRenderer.invoke('voice:is-available'),
  
  // List available voices
  listVoices: () => ipcRenderer.invoke('voice:list-voices')
});

// Expose Dependency Management API
contextBridge.exposeInMainWorld('deps', {
  // Check all dependencies (Python, pipx, aider-chat)
  checkAll: () => ipcRenderer.invoke('deps:check-all'),
  
  // Install a specific dependency
  install: (depName) => ipcRenderer.invoke('deps:install', depName),
  
  // Install all missing dependencies
  installAll: () => ipcRenderer.invoke('deps:install-all'),
  
  // Cancel an ongoing installation
  cancelInstall: (depName) => ipcRenderer.invoke('deps:cancel-install', depName),
  
  // Get the aider Python path
  getAiderPython: () => ipcRenderer.invoke('deps:get-aider-python'),
  
  // Listen for installation output (streaming)
  onInstallOutput: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('deps:install-output', handler);
    // Return cleanup function
    return () => ipcRenderer.removeListener('deps:install-output', handler);
  }
});

// Expose Aider API for GSX Create
contextBridge.exposeInMainWorld('aider', {
  start: () => ipcRenderer.invoke('aider:start'),
  initialize: (repoPath, modelName) => ipcRenderer.invoke('aider:initialize', repoPath, modelName),
  runPrompt: (message) => ipcRenderer.invoke('aider:run-prompt', message),
  runPromptStreaming: (message, callback) => {
    const channel = 'aider:prompt-stream-' + Date.now();
    ipcRenderer.on(channel, (event, data) => callback(data));
    return ipcRenderer.invoke('aider:run-prompt-streaming', message, channel);
  },
  addFiles: (filePaths) => ipcRenderer.invoke('aider:add-files', filePaths),
  removeFiles: (filePaths) => ipcRenderer.invoke('aider:remove-files', filePaths),
  getRepoMap: () => ipcRenderer.invoke('aider:get-repo-map'),
  setTestCmd: (command) => ipcRenderer.invoke('aider:set-test-cmd', command),
  setLintCmd: (command) => ipcRenderer.invoke('aider:set-lint-cmd', command),
  shutdown: () => ipcRenderer.invoke('aider:shutdown'),
  getAppPath: () => ipcRenderer.invoke('aider:get-app-path'),
  selectFolder: () => ipcRenderer.invoke('aider:select-folder'),
  getApiConfig: () => ipcRenderer.invoke('aider:get-api-config'),
  evaluate: (arg1, arg2, arg3) => {
    // Support both old style (systemPrompt, userPrompt, model) and new style (options object)
    if (typeof arg1 === 'object' && arg1 !== null) {
      return ipcRenderer.invoke('aider:evaluate', arg1);
    } else {
      return ipcRenderer.invoke('aider:evaluate', arg1, arg2, arg3);
    }
  },
  getSpaces: () => ipcRenderer.invoke('aider:get-spaces'),
  createSpace: (name) => ipcRenderer.invoke('aider:create-space', name),
  listProjectFiles: (dirPath) => ipcRenderer.invoke('aider:list-project-files', dirPath),
  
  // Unified space metadata
  getSpaceMetadata: (spaceId) => ipcRenderer.invoke('aider:get-space-metadata', spaceId),
  updateSpaceMetadata: (spaceId, updates) => ipcRenderer.invoke('aider:update-space-metadata', spaceId, updates),
  setFileMetadata: (spaceId, filePath, metadata) => ipcRenderer.invoke('aider:set-file-metadata', spaceId, filePath, metadata),
  getFileMetadata: (spaceId, filePath) => ipcRenderer.invoke('aider:get-file-metadata', spaceId, filePath),
  setAssetMetadata: (spaceId, assetType, metadata) => ipcRenderer.invoke('aider:set-asset-metadata', spaceId, assetType, metadata),
  setApproval: (spaceId, itemType, itemId, approved) => ipcRenderer.invoke('aider:set-approval', spaceId, itemType, itemId, approved),
  addVersion: (spaceId, versionData) => ipcRenderer.invoke('aider:add-version', spaceId, versionData),
  updateProjectConfig: (spaceId, configUpdates) => ipcRenderer.invoke('aider:update-project-config', spaceId, configUpdates),
  // Playwright API testing
  runPlaywrightTests: (options) => ipcRenderer.invoke('aider:run-playwright-tests', options),
  // File operations
  readFile: (filePath) => ipcRenderer.invoke('aider:read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('aider:write-file', filePath, content),
  deleteFile: (filePath) => ipcRenderer.invoke('aider:delete-file', filePath),
  openFile: (filePath) => ipcRenderer.invoke('aider:open-file', filePath),
  
  // Version backup/restore
  backupVersion: (spacePath, version, metadata) => ipcRenderer.invoke('aider:backup-version', spacePath, version, metadata),
  restoreVersion: (spacePath, version, createBackupFirst) => ipcRenderer.invoke('aider:restore-version', spacePath, version, createBackupFirst),
  listBackups: (spacePath) => ipcRenderer.invoke('aider:list-backups', spacePath),
  
  // Branch system for parallel versions
  createBranch: (spacePath, branchId, metadata) => ipcRenderer.invoke('aider:create-branch', spacePath, branchId, metadata),
  listBranches: (spacePath) => ipcRenderer.invoke('aider:list-branches', spacePath),
  updateBranch: (spacePath, branchId, updates) => ipcRenderer.invoke('aider:update-branch', spacePath, branchId, updates),
  promoteBranch: (spacePath, branchId) => ipcRenderer.invoke('aider:promote-branch', spacePath, branchId),
  deleteBranch: (spacePath, branchId) => ipcRenderer.invoke('aider:delete-branch', spacePath, branchId),
  
  // Git branch operations for tabbed UI
  gitInit: (repoPath) => ipcRenderer.invoke('aider:git-init', repoPath),
  gitCreateBranch: (repoPath, branchName, baseBranch) => ipcRenderer.invoke('aider:git-create-branch', repoPath, branchName, baseBranch),
  gitCreateOrphanBranch: (repoPath, branchName) => ipcRenderer.invoke('aider:git-create-orphan-branch', repoPath, branchName),
  gitSwitchBranch: (repoPath, branchName) => ipcRenderer.invoke('aider:git-switch-branch', repoPath, branchName),
  gitDeleteBranch: (repoPath, branchName) => ipcRenderer.invoke('aider:git-delete-branch', repoPath, branchName),
  gitListBranches: (repoPath) => ipcRenderer.invoke('aider:git-list-branches', repoPath),
  gitDiffBranches: (repoPath, branchA, branchB) => ipcRenderer.invoke('aider:git-diff-branches', repoPath, branchA, branchB),
  gitMergeBranch: (repoPath, sourceBranch, targetBranch) => ipcRenderer.invoke('aider:git-merge-branch', repoPath, sourceBranch, targetBranch),
  gitMergePreview: (repoPath, sourceBranch, targetBranch) => ipcRenderer.invoke('aider:git-merge-preview', repoPath, sourceBranch, targetBranch),
  
  // Sandboxed Aider per branch (parallel exploration)
  initBranchManager: (spacePath) => ipcRenderer.invoke('aider:init-branch-manager', spacePath),
  initBranchAider: (branchPath, branchId, model, readOnlyFiles) => 
    ipcRenderer.invoke('aider:init-branch', branchPath, branchId, model, readOnlyFiles),
  runBranchPrompt: (branchId, prompt) => ipcRenderer.invoke('aider:branch-prompt', branchId, prompt, null),
  runBranchPromptStreaming: (branchId, prompt, callback) => {
    const channel = 'aider:branch-stream-' + branchId + '-' + Date.now();
    ipcRenderer.on(channel, (event, data) => callback(data));
    return ipcRenderer.invoke('aider:branch-prompt', branchId, prompt, channel);
  },
  cleanupBranchAider: (branchId) => ipcRenderer.invoke('aider:cleanup-branch', branchId),
  cleanupAllBranches: () => ipcRenderer.invoke('aider:cleanup-all-branches'),
  getBranchLog: (branchId) => ipcRenderer.invoke('aider:get-branch-log', branchId),
  getOrchestrationLog: () => ipcRenderer.invoke('aider:get-orchestration-log'),
  getActiveBranches: () => ipcRenderer.invoke('aider:get-active-branches'),
  
  watchFile: (filePath) => ipcRenderer.invoke('aider:watch-file', filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke('aider:unwatch-file', filePath),
  // Listen for file change notifications from main process watchers
  onFileChanged: (callback) => {
    const handler = (event, filePath) => {
      try { callback(filePath); } catch (e) { /* swallow callback errors */ }
    };
    ipcRenderer.on('aider:file-changed', handler);
    // Return an unsubscribe function (best-effort)
    return () => {
      try { ipcRenderer.removeListener('aider:file-changed', handler); } catch (e) { /* noop */ }
    };
  },
  // Screenshot capture (takes file path, not HTML content)
  capturePreviewScreenshot: (filePath) => ipcRenderer.invoke('aider:capture-preview-screenshot', filePath),
  analyzeScreenshot: (screenshotBase64, prompt) => ipcRenderer.invoke('aider:analyze-screenshot', screenshotBase64, prompt),
  // Web search for up-to-date info (AI models, software versions, error solutions)
  webSearch: (query, options) => ipcRenderer.invoke('aider:web-search', query, options),
  
  // ========== MULTI-AGENT SYSTEM ==========
  // Direct AI call for parallel agent operations (bypasses Aider bridge)
  directAICall: (params) => ipcRenderer.invoke('ai:direct-call', params),
  // File registration with Space Manager
  registerCreatedFile: (data) => ipcRenderer.invoke('aider:register-created-file', data),
  updateFileMetadata: (data) => ipcRenderer.invoke('aider:update-file-metadata', data),
  // Space items
  getSpaceItems: (spaceId) => ipcRenderer.invoke('clipboard:get-space-items', spaceId),
  // Style Guide management
  getStyleGuides: (spaceId) => ipcRenderer.invoke('aider:get-style-guides', spaceId),
  saveStyleGuide: (data) => ipcRenderer.invoke('aider:save-style-guide', data),
  deleteStyleGuide: (id) => ipcRenderer.invoke('aider:delete-style-guide', id),
  // Journey Maps
  getJourneyMaps: (spaceId) => ipcRenderer.invoke('aider:get-journey-maps', spaceId),
  saveJourneyMap: (data) => ipcRenderer.invoke('aider:save-journey-map', data),
  deleteJourneyMap: (id) => ipcRenderer.invoke('aider:delete-journey-map', id),
  // Transaction database for cost tracking
  txdbGetSummary: (spaceId) => ipcRenderer.invoke('txdb:get-summary', spaceId),
  txdbRecordTransaction: (data) => ipcRenderer.invoke('txdb:record-transaction', data),
  txdbGetTransactions: (spaceIdOrOptions, limit) => {
    // Handle both object form { spaceId, limit } and individual parameters
    if (typeof spaceIdOrOptions === 'object' && spaceIdOrOptions !== null) {
      return ipcRenderer.invoke('txdb:get-transactions', spaceIdOrOptions.spaceId, spaceIdOrOptions.limit);
    }
    return ipcRenderer.invoke('txdb:get-transactions', spaceIdOrOptions, limit);
  },
  // Event logging
  txdbLogEvent: (data) => ipcRenderer.invoke('txdb:log-event', data),
  txdbGetEventLogs: (options) => ipcRenderer.invoke('txdb:get-event-logs', options),
  
  // DuckDB Analytics
  eventdbCostByModel: (spaceId) => ipcRenderer.invoke('eventdb:cost-by-model', spaceId),
  eventdbDailyCosts: (spaceId, days) => ipcRenderer.invoke('eventdb:daily-costs', spaceId, days),
  eventdbQuerySpaces: (whereClause) => ipcRenderer.invoke('eventdb:query-spaces', whereClause),
  eventdbSearchSpaces: (searchTerm) => ipcRenderer.invoke('eventdb:search-spaces', searchTerm),
  eventdbQuery: (sql) => ipcRenderer.invoke('eventdb:query', sql),
  
  // Budget Manager Integration (for global budget tracking)
  budgetTrackUsage: (provider, projectId, usage) => ipcRenderer.invoke('budget:trackUsage', provider, projectId, usage),
  budgetGetCostSummary: (period) => ipcRenderer.invoke('budget:getCostSummary', period),
  budgetCheckBudget: (provider, estimatedCost) => ipcRenderer.invoke('budget:checkBudget', provider, estimatedCost),
  
  // Budget Query (Chat/Voice support)
  budgetGetStatus: (projectId) => ipcRenderer.invoke('budget:getStatus', projectId),
  budgetAnswerQuestion: (question, projectId) => ipcRenderer.invoke('budget:answerQuestion', question, projectId),
  budgetGetStatsByFeature: () => ipcRenderer.invoke('budget:getStatsByFeature'),
  budgetGetStatsByProvider: () => ipcRenderer.invoke('budget:getStatsByProvider'),
  budgetGetStatsByModel: () => ipcRenderer.invoke('budget:getStatsByModel'),
  budgetGetDailyCosts: (days) => ipcRenderer.invoke('budget:getDailyCosts', days),
  budgetSetHardLimitEnabled: (enabled) => ipcRenderer.invoke('budget:setHardLimitEnabled', enabled),
  budgetSetProjectBudget: (projectId, limit, alertAt, hardLimit) => ipcRenderer.invoke('budget:setProjectBudget', projectId, limit, alertAt, hardLimit),
  
  // Unified Pricing API
  pricingGetAll: () => ipcRenderer.invoke('pricing:getAll'),
  pricingCalculate: (model, inputTokens, outputTokens, options) => ipcRenderer.invoke('pricing:calculate', model, inputTokens, outputTokens, options),
  
  // Unified Space Metadata System
  getSpaceMetadata: (spaceId) => ipcRenderer.invoke('aider:get-space-metadata', spaceId),
  updateSpaceMetadata: (spaceId, updates) => ipcRenderer.invoke('aider:update-space-metadata', spaceId, updates),
  setFileMetadata: (spaceId, filePath, metadata) => ipcRenderer.invoke('aider:set-file-metadata', spaceId, filePath, metadata),
  getFileMetadata: (spaceId, filePath) => ipcRenderer.invoke('aider:get-file-metadata', spaceId, filePath),
  setAssetMetadata: (spaceId, assetType, metadata) => ipcRenderer.invoke('aider:set-asset-metadata', spaceId, assetType, metadata),
  setApproval: (spaceId, itemType, itemId, approved) => ipcRenderer.invoke('aider:set-approval', spaceId, itemType, itemId, approved),
  addVersion: (spaceId, versionData) => ipcRenderer.invoke('aider:add-version', spaceId, versionData),
  updateProjectConfig: (spaceId, configUpdates) => ipcRenderer.invoke('aider:update-project-config', spaceId, configUpdates),
  
  // Space Migration & Cross-Space Queries
  migrateSpaces: () => ipcRenderer.invoke('aider:migrate-spaces'),
  searchAllSpaces: (searchTerm) => ipcRenderer.invoke('aider:search-all-spaces', searchTerm),
  querySpaces: (whereClause) => ipcRenderer.invoke('aider:query-spaces', whereClause),
  getAllSpacesWithMetadata: () => ipcRenderer.invoke('aider:get-all-spaces-with-metadata'),
  getSpaceFiles: (spaceId) => ipcRenderer.invoke('aider:get-space-files', spaceId),
  getSpacePath: (spaceId) => ipcRenderer.invoke('aider:get-space-path', spaceId),
  
  // Design-First Workflow - UI Mockup Generation
  getDesignApproaches: (options) => ipcRenderer.invoke('design:get-approaches', options),
  generateDesignChoices: (options) => ipcRenderer.invoke('design:generate-choices', options),
  regenerateDesign: (options) => ipcRenderer.invoke('design:regenerate-single', options),
  extractDesignTokens: (options) => ipcRenderer.invoke('design:extract-tokens', options),
  generateCodeFromDesign: (options) => ipcRenderer.invoke('design:generate-code', options),
  
  // ========== GRACEFUL SHUTDOWN ==========
  // Listen for shutdown request from main process
  onShutdownRequest: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('request-graceful-shutdown', handler);
    return () => ipcRenderer.removeListener('request-graceful-shutdown', handler);
  },
  // Signal that shutdown can proceed (state saved)
  sendShutdownReady: () => ipcRenderer.send('shutdown-ready'),
  // Signal that shutdown is blocked (task running) with reason
  sendShutdownBlocked: (reason) => ipcRenderer.send('shutdown-blocked', reason)
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
  deleteItems: (itemIds) => ipcRenderer.invoke('clipboard:delete-items', itemIds),
  moveItems: (itemIds, toSpaceId) => ipcRenderer.invoke('clipboard:move-items', itemIds, toSpaceId),
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
  generateMetadataAI: (itemId, apiKey, customPrompt) => {
    console.log('[Preload] generateMetadataAI called with:', { itemId, hasApiKey: !!apiKey });
    return ipcRenderer.invoke('clipboard:generate-metadata-ai', { itemId, apiKey, customPrompt });
  },
  // Test function to verify IPC works
  testIPC: () => {
    console.log('[Preload] testIPC called');
    return Promise.resolve({ success: true, message: 'IPC is working!' });
  },
  searchByTags: (tags) => ipcRenderer.invoke('clipboard:search-by-tags', tags),
  
  // Video Scenes (for Agentic Player)
  getVideoScenes: (itemId) => ipcRenderer.invoke('clipboard:get-video-scenes', itemId),
  updateVideoScenes: (itemId, scenes) => ipcRenderer.invoke('clipboard:update-video-scenes', itemId, scenes),
  addVideoScene: (itemId, scene) => ipcRenderer.invoke('clipboard:add-video-scene', itemId, scene),
  deleteVideoScene: (itemId, sceneId) => ipcRenderer.invoke('clipboard:delete-video-scene', itemId, sceneId),
  getVideosWithScenes: (spaceId) => ipcRenderer.invoke('clipboard:get-videos-with-scenes', spaceId),
  
  // Content methods (for preview/edit)
  getItemContent: (itemId) => ipcRenderer.invoke('clipboard:get-item-content', itemId),
  updateItemContent: (itemId, content) => ipcRenderer.invoke('clipboard:update-item-content', itemId, content),
  
  // Open file in system default app
  openInSystem: (filePath) => ipcRenderer.invoke('clipboard:open-in-system', filePath),
  
  // Open URL in external browser
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  
  // Open URL in internal GSX window
  openGSXWindow: (url, title) => ipcRenderer.send('open-gsx-link', { url, title }),
  
  // Convert DOCX to HTML for preview/editing
  convertDocxToHtml: (filePath) => ipcRenderer.invoke('clipboard:convert-docx-to-html', filePath),
  
  // AI Image editing
  editImageWithAI: (options) => ipcRenderer.invoke('clipboard:edit-image-ai', options),
  updateItemImage: (itemId, imageData) => ipcRenderer.invoke('clipboard:update-item-image', itemId, imageData),
  saveImageAsNew: (imageData, options) => ipcRenderer.invoke('clipboard:save-image-as-new', imageData, options),
  
  // Text-to-Speech
  generateSpeech: (options) => ipcRenderer.invoke('clipboard:generate-speech', options),
  saveTTSAudio: (options) => ipcRenderer.invoke('clipboard:save-tts-audio', options),
  getTTSAudio: (itemId) => ipcRenderer.invoke('clipboard:get-tts-audio', itemId),
  
  // Audio Transcription & Extraction
  transcribeAudio: (options) => ipcRenderer.invoke('clipboard:transcribe-audio', options),
  saveTranscription: (options) => ipcRenderer.invoke('clipboard:save-transcription', options),
  getTranscription: (itemId) => ipcRenderer.invoke('clipboard:get-transcription', itemId),
  identifySpeakers: (options) => ipcRenderer.invoke('clipboard:identify-speakers', options),
  generateSummary: (options) => ipcRenderer.invoke('clipboard:generate-summary', options),
  extractAudio: (itemId) => ipcRenderer.invoke('clipboard:extract-audio', itemId),
  onSpeakerIdProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('speaker-id:progress', handler);
    return () => ipcRenderer.removeListener('speaker-id:progress', handler);
  },
  onAudioExtractProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('audio-extract-progress', handler);
    return () => ipcRenderer.removeListener('audio-extract-progress', handler);
  },
  verifyItem: (itemId) => ipcRenderer.invoke('clipboard:verify-item', itemId),
  searchAIContent: (options) => ipcRenderer.invoke('clipboard:search-ai-content', options),
  getAudioData: (itemId) => ipcRenderer.invoke('clipboard:get-audio-data', itemId),
  openStorageDirectory: () => ipcRenderer.invoke('clipboard:open-storage-directory'),
  openSpaceDirectory: (spaceId) => ipcRenderer.invoke('clipboard:open-space-directory', spaceId),
  diagnose: () => ipcRenderer.invoke('clipboard:diagnose'),
  forceResume: () => ipcRenderer.invoke('clipboard:force-resume'),
  manualCheck: () => ipcRenderer.invoke('clipboard:manual-check'),
  showItemInFinder: (itemId) => ipcRenderer.invoke('clipboard:show-item-in-finder', itemId),
  
  // Web Monitor methods
  checkMonitorNow: (itemId) => ipcRenderer.invoke('clipboard:check-monitor-now', itemId),
  setMonitorStatus: (itemId, status) => ipcRenderer.invoke('clipboard:set-monitor-status', itemId, status),
  setMonitorAiEnabled: (itemId, enabled) => ipcRenderer.invoke('clipboard:set-monitor-ai-enabled', itemId, enabled),
  setMonitorCheckInterval: (itemId, minutes) => ipcRenderer.invoke('clipboard:set-monitor-check-interval', itemId, minutes),
  
  // Video Editor
  getVideoPath: (itemId) => ipcRenderer.invoke('clipboard:get-video-path', itemId),
  openVideoEditor: (filePath) => ipcRenderer.invoke('clipboard:open-video-editor', filePath),
  
  // Specialized JSON Asset Editors (Style Guide, Journey Map)
  openStyleGuideEditor: (itemId) => ipcRenderer.invoke('clipboard:open-style-guide-editor', itemId),
  openJourneyMapEditor: (itemId) => ipcRenderer.invoke('clipboard:open-journey-map-editor', itemId),
  getJsonAssetPath: (itemId) => ipcRenderer.invoke('clipboard:get-json-asset-path', itemId),
  
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
  
  // Multi-format export
  openFormatModal: (spaceId) => ipcRenderer.invoke('smart-export:open-modal', spaceId),
  generateExport: (params) => ipcRenderer.invoke('smart-export:generate', params),
  getExportFormats: () => ipcRenderer.invoke('smart-export:get-formats'),
  
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

  // Unified space metadata methods
  getSpaceMetadata: (spaceId) => ipcRenderer.invoke('aider:get-space-metadata', spaceId),
  updateSpaceMetadata: (spaceId, updates) => ipcRenderer.invoke('aider:update-space-metadata', spaceId, updates),
  setFileMetadata: (spaceId, filePath, metadata) => ipcRenderer.invoke('aider:set-file-metadata', spaceId, filePath, metadata),
  getFileMetadata: (spaceId, filePath) => ipcRenderer.invoke('aider:get-file-metadata', spaceId, filePath),
  setAssetMetadata: (spaceId, assetName, metadata) => ipcRenderer.invoke('aider:set-asset-metadata', spaceId, assetName, metadata),
  setApproval: (spaceId, assetName, approved) => ipcRenderer.invoke('aider:set-approval', spaceId, assetName, approved),
  addVersion: (spaceId, version) => ipcRenderer.invoke('aider:add-version', spaceId, version),
  updateProjectConfig: (spaceId, config) => ipcRenderer.invoke('aider:update-project-config', spaceId, config),
  
  // ---- GENERATIVE SEARCH ----
  // LLM-powered semantic search with customizable filters
  generativeSearch: {
    /**
     * Run a generative search with LLM evaluation
     * @param {Object} options - Search options
     * @param {Array} options.filters - Active filters with thresholds and weights
     * @param {string} options.spaceId - Space to search in (null for all)
     * @param {string} options.mode - 'quick' (metadata only) or 'deep' (full content)
     * @param {string} options.userQuery - Optional free-form query
     * @returns {Promise<Array>} Scored and ranked items
     */
    search: (options) => ipcRenderer.invoke('generative-search:search', options),
    
    /**
     * Estimate cost before running search
     * @param {Object} options - Options with filters, spaceId, mode
     * @returns {Promise<Object>} Cost estimate with formatted string
     */
    estimateCost: (options) => ipcRenderer.invoke('generative-search:estimate-cost', options),
    
    /**
     * Cancel ongoing search
     * @returns {Promise<boolean>}
     */
    cancel: () => ipcRenderer.invoke('generative-search:cancel'),
    
    /**
     * Get available filter types
     * @returns {Promise<Object>} Filter definitions and categories
     */
    getFilterTypes: () => ipcRenderer.invoke('generative-search:get-filter-types'),
    
    /**
     * Clear search cache
     * @returns {Promise<boolean>}
     */
    clearCache: () => ipcRenderer.invoke('generative-search:clear-cache'),
    
    /**
     * Listen for progress updates during search
     * @param {Function} callback - Progress callback
     * @returns {Function} Cleanup function to remove listener
     */
    onProgress: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('generative-search:progress', handler);
      return () => ipcRenderer.removeListener('generative-search:progress', handler);
    }
  },
  
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

// ============================================
// UNIFIED SPACES API
// ============================================
// This is the new, clean API for accessing spaces and items.
// It provides a consistent interface that replaces the fragmented
// aider:*, clipboard:*, and other space-related APIs.
//
// Usage:
//   const spaces = await window.spaces.list();
//   const items = await window.spaces.items.list('my-space-id');
//   await window.spaces.items.add('my-space-id', { type: 'text', content: 'Hello' });
//
contextBridge.exposeInMainWorld('spaces', {
  // ---- SPACE MANAGEMENT ----
  
  /**
   * List all spaces with metadata
   * @returns {Promise<Array>} Array of space objects
   */
  list: () => ipcRenderer.invoke('spaces:list'),
  
  /**
   * Get a single space by ID
   * @param {string} id - Space ID
   * @returns {Promise<Object|null>} Space object or null
   */
  get: (id) => ipcRenderer.invoke('spaces:get', id),
  
  /**
   * Create a new space
   * @param {string} name - Space name
   * @param {Object} opts - Options (icon, color, notebook)
   * @returns {Promise<Object>} Created space
   */
  create: (name, opts) => ipcRenderer.invoke('spaces:create', name, opts),
  
  /**
   * Update a space
   * @param {string} id - Space ID
   * @param {Object} data - Updates (name, icon, color)
   * @returns {Promise<boolean>} Success status
   */
  update: (id, data) => ipcRenderer.invoke('spaces:update', id, data),
  
  /**
   * Delete a space (items move to Unclassified)
   * @param {string} id - Space ID
   * @returns {Promise<boolean>} Success status
   */
  delete: (id) => ipcRenderer.invoke('spaces:delete', id),
  
  // ---- ITEM MANAGEMENT ----
  items: {
    /**
     * List items in a space
     * @param {string} spaceId - Space ID
     * @param {Object} opts - Options (limit, offset, type, pinned, includeContent)
     * @returns {Promise<Array>} Array of items
     */
    list: (spaceId, opts) => ipcRenderer.invoke('spaces:items:list', spaceId, opts),
    
    /**
     * Get a single item with full content
     * @param {string} spaceId - Space ID
     * @param {string} itemId - Item ID
     * @returns {Promise<Object|null>} Item or null
     */
    get: (spaceId, itemId) => ipcRenderer.invoke('spaces:items:get', spaceId, itemId),
    
    /**
     * Add a new item to a space
     * @param {string} spaceId - Space ID
     * @param {Object} item - Item (type, content, metadata, source)
     * @returns {Promise<Object>} Created item
     */
    add: (spaceId, item) => ipcRenderer.invoke('spaces:items:add', spaceId, item),
    
    /**
     * Update an item's properties
     * @param {string} spaceId - Space ID
     * @param {string} itemId - Item ID
     * @param {Object} data - Updates
     * @returns {Promise<boolean>} Success status
     */
    update: (spaceId, itemId, data) => ipcRenderer.invoke('spaces:items:update', spaceId, itemId, data),
    
    /**
     * Delete an item
     * @param {string} spaceId - Space ID
     * @param {string} itemId - Item ID
     * @returns {Promise<boolean>} Success status
     */
    delete: (spaceId, itemId) => ipcRenderer.invoke('spaces:items:delete', spaceId, itemId),
    
    /**
     * Move an item to a different space
     * @param {string} itemId - Item ID
     * @param {string} from - Current space ID
     * @param {string} to - Target space ID
     * @returns {Promise<boolean>} Success status
     */
    move: (itemId, from, to) => ipcRenderer.invoke('spaces:items:move', itemId, from, to),
    
    /**
     * Toggle pin status
     * @param {string} spaceId - Space ID
     * @param {string} itemId - Item ID
     * @returns {Promise<boolean>} New pinned status
     */
    togglePin: (spaceId, itemId) => ipcRenderer.invoke('spaces:items:togglePin', spaceId, itemId),
    
    /**
     * Get tags for an item
     * @param {string} spaceId - Space ID
     * @param {string} itemId - Item ID
     * @returns {Promise<Array<string>>} Tags
     */
    getTags: (spaceId, itemId) => ipcRenderer.invoke('spaces:items:getTags', spaceId, itemId),
    
    /**
     * Set tags for an item (replaces existing)
     * @param {string} spaceId - Space ID
     * @param {string} itemId - Item ID
     * @param {Array<string>} tags - Tags to set
     * @returns {Promise<boolean>} Success
     */
    setTags: (spaceId, itemId, tags) => ipcRenderer.invoke('spaces:items:setTags', spaceId, itemId, tags),
    
    /**
     * Add a tag to an item
     * @param {string} spaceId - Space ID
     * @param {string} itemId - Item ID
     * @param {string} tag - Tag to add
     * @returns {Promise<Array<string>>} Updated tags
     */
    addTag: (spaceId, itemId, tag) => ipcRenderer.invoke('spaces:items:addTag', spaceId, itemId, tag),
    
    /**
     * Remove a tag from an item
     * @param {string} spaceId - Space ID
     * @param {string} itemId - Item ID
     * @param {string} tag - Tag to remove
     * @returns {Promise<Array<string>>} Updated tags
     */
    removeTag: (spaceId, itemId, tag) => ipcRenderer.invoke('spaces:items:removeTag', spaceId, itemId, tag),
    
    /**
     * Generate or regenerate AI metadata for an item
     * @param {string} spaceId - Space ID
     * @param {string} itemId - Item ID
     * @param {Object} opts - Options (apiKey, customPrompt)
     * @returns {Promise<Object>} { success, metadata } or { success: false, error }
     */
    generateMetadata: (spaceId, itemId, opts) => ipcRenderer.invoke('spaces:items:generateMetadata', spaceId, itemId, opts)
  },
  
  // ---- TAGS ----
  tags: {
    /**
     * List all unique tags in a space
     * @param {string} spaceId - Space ID
     * @returns {Promise<Array<{tag: string, count: number}>>} Tags with counts
     */
    list: (spaceId) => ipcRenderer.invoke('spaces:tags:list', spaceId),
    
    /**
     * List all tags across all spaces
     * @returns {Promise<Array<{tag: string, count: number, spaces: Array}>>} Tags
     */
    listAll: () => ipcRenderer.invoke('spaces:tags:listAll'),
    
    /**
     * Find items by tags
     * @param {Array<string>} tags - Tags to search
     * @param {Object} opts - Options (spaceId, matchAll, limit)
     * @returns {Promise<Array>} Matching items
     */
    findItems: (tags, opts) => ipcRenderer.invoke('spaces:tags:findItems', tags, opts),
    
    /**
     * Rename a tag across all items in a space
     * @param {string} spaceId - Space ID
     * @param {string} oldTag - Tag to rename
     * @param {string} newTag - New name
     * @returns {Promise<number>} Items updated
     */
    rename: (spaceId, oldTag, newTag) => ipcRenderer.invoke('spaces:tags:rename', spaceId, oldTag, newTag),
    
    /**
     * Delete a tag from all items in a space
     * @param {string} spaceId - Space ID
     * @param {string} tag - Tag to delete
     * @returns {Promise<number>} Items updated
     */
    deleteFromSpace: (spaceId, tag) => ipcRenderer.invoke('spaces:tags:deleteFromSpace', spaceId, tag)
  },
  
  // ---- SMART FOLDERS ----
  smartFolders: {
    /**
     * List all smart folders
     * @returns {Promise<Array>} Smart folders
     */
    list: () => ipcRenderer.invoke('spaces:smartFolders:list'),
    
    /**
     * Get a single smart folder
     * @param {string} id - Folder ID
     * @returns {Promise<Object|null>} Smart folder
     */
    get: (id) => ipcRenderer.invoke('spaces:smartFolders:get', id),
    
    /**
     * Create a smart folder
     * @param {string} name - Folder name
     * @param {Object} criteria - Filter criteria (tags, anyTags, types, spaces)
     * @param {Object} opts - Options (icon, color)
     * @returns {Promise<Object>} Created folder
     */
    create: (name, criteria, opts) => ipcRenderer.invoke('spaces:smartFolders:create', name, criteria, opts),
    
    /**
     * Update a smart folder
     * @param {string} id - Folder ID
     * @param {Object} updates - Properties to update
     * @returns {Promise<Object|null>} Updated folder
     */
    update: (id, updates) => ipcRenderer.invoke('spaces:smartFolders:update', id, updates),
    
    /**
     * Delete a smart folder
     * @param {string} id - Folder ID
     * @returns {Promise<boolean>} Success
     */
    delete: (id) => ipcRenderer.invoke('spaces:smartFolders:delete', id),
    
    /**
     * Get items matching a smart folder's criteria
     * @param {string} id - Folder ID
     * @param {Object} opts - Options (limit, offset, includeContent)
     * @returns {Promise<Array>} Matching items
     */
    getItems: (id, opts) => ipcRenderer.invoke('spaces:smartFolders:getItems', id, opts),
    
    /**
     * Preview items for criteria without saving
     * @param {Object} criteria - Filter criteria
     * @param {Object} opts - Options
     * @returns {Promise<Array>} Matching items
     */
    preview: (criteria, opts) => ipcRenderer.invoke('spaces:smartFolders:preview', criteria, opts)
  },
  
  // ---- SEARCH ----
  
  /**
   * Search across all spaces
   * @param {string} query - Search query
   * @param {Object} opts - Options (spaceId, type, limit)
   * @returns {Promise<Array>} Matching items
   */
  search: (query, opts) => ipcRenderer.invoke('spaces:search', query, opts),
  
  // ---- METADATA ----
  metadata: {
    /**
     * Get space metadata
     * @param {string} spaceId - Space ID
     * @returns {Promise<Object|null>} Metadata
     */
    get: (spaceId) => ipcRenderer.invoke('spaces:metadata:get', spaceId),
    
    /**
     * Update space metadata
     * @param {string} spaceId - Space ID
     * @param {Object} data - Updates
     * @returns {Promise<Object|null>} Updated metadata
     */
    update: (spaceId, data) => ipcRenderer.invoke('spaces:metadata:update', spaceId, data),
    
    /**
     * Get file metadata
     * @param {string} spaceId - Space ID
     * @param {string} filePath - File path
     * @returns {Promise<Object|null>} File metadata
     */
    getFile: (spaceId, filePath) => ipcRenderer.invoke('spaces:metadata:getFile', spaceId, filePath),
    
    /**
     * Set file metadata
     * @param {string} spaceId - Space ID
     * @param {string} filePath - File path
     * @param {Object} data - Metadata
     * @returns {Promise<Object|null>} Updated space metadata
     */
    setFile: (spaceId, filePath, data) => ipcRenderer.invoke('spaces:metadata:setFile', spaceId, filePath, data),
    
    /**
     * Set asset metadata (journey map, style guide, etc.)
     * @param {string} spaceId - Space ID
     * @param {string} assetType - Asset type
     * @param {Object} data - Metadata
     * @returns {Promise<Object|null>} Updated space metadata
     */
    setAsset: (spaceId, assetType, data) => ipcRenderer.invoke('spaces:metadata:setAsset', spaceId, assetType, data),
    
    /**
     * Set approval status
     * @param {string} spaceId - Space ID
     * @param {string} itemType - Item type
     * @param {string} itemId - Item ID
     * @param {boolean} approved - Approval status
     * @returns {Promise<Object|null>} Updated space metadata
     */
    setApproval: (spaceId, itemType, itemId, approved) => ipcRenderer.invoke('spaces:metadata:setApproval', spaceId, itemType, itemId, approved),
    
    /**
     * Add a version to history
     * @param {string} spaceId - Space ID
     * @param {Object} versionData - Version data
     * @returns {Promise<Object|null>} Updated space metadata
     */
    addVersion: (spaceId, versionData) => ipcRenderer.invoke('spaces:metadata:addVersion', spaceId, versionData),
    
    /**
     * Update project configuration
     * @param {string} spaceId - Space ID
     * @param {Object} config - Config updates
     * @returns {Promise<Object|null>} Updated space metadata
     */
    updateProjectConfig: (spaceId, config) => ipcRenderer.invoke('spaces:metadata:updateProjectConfig', spaceId, config)
  },
  
  // ---- FILE SYSTEM ----
  files: {
    /**
     * Get path to space directory
     * @param {string} spaceId - Space ID
     * @returns {Promise<string>} Absolute path
     */
    getPath: (spaceId) => ipcRenderer.invoke('spaces:files:getPath', spaceId),
    
    /**
     * List files in space directory
     * @param {string} spaceId - Space ID
     * @param {string} subPath - Optional subdirectory
     * @returns {Promise<Array>} File info objects
     */
    list: (spaceId, subPath) => ipcRenderer.invoke('spaces:files:list', spaceId, subPath),
    
    /**
     * Read a file from space
     * @param {string} spaceId - Space ID
     * @param {string} filePath - Relative file path
     * @returns {Promise<string|null>} File contents
     */
    read: (spaceId, filePath) => ipcRenderer.invoke('spaces:files:read', spaceId, filePath),
    
    /**
     * Write a file to space
     * @param {string} spaceId - Space ID
     * @param {string} filePath - Relative file path
     * @param {string} content - File content
     * @returns {Promise<boolean>} Success status
     */
    write: (spaceId, filePath, content) => ipcRenderer.invoke('spaces:files:write', spaceId, filePath, content),
    
    /**
     * Delete a file from space
     * @param {string} spaceId - Space ID
     * @param {string} filePath - Relative file path
     * @returns {Promise<boolean>} Success status
     */
    delete: (spaceId, filePath) => ipcRenderer.invoke('spaces:files:delete', spaceId, filePath)
  },
  
  /**
   * Get storage root path
   * @returns {Promise<string>} Path to OR-Spaces directory
   */
  getStorageRoot: () => ipcRenderer.invoke('spaces:getStorageRoot'),
  
  // ---- EVENTS ----
  
  /**
   * Listen for space created events
   * @param {Function} cb - Callback (space)
   * @returns {Function} Unsubscribe function
   */
  onSpaceCreated: (cb) => {
    const handler = (event, data) => { if (data.type === 'space:created') cb(data.space); };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },
  
  /**
   * Listen for space updated events
   * @param {Function} cb - Callback (spaceId, data)
   * @returns {Function} Unsubscribe function
   */
  onSpaceUpdated: (cb) => {
    const handler = (event, data) => { if (data.type === 'space:updated') cb(data.spaceId, data.data); };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },
  
  /**
   * Listen for space deleted events
   * @param {Function} cb - Callback (spaceId)
   * @returns {Function} Unsubscribe function
   */
  onSpaceDeleted: (cb) => {
    const handler = (event, data) => { if (data.type === 'space:deleted') cb(data.spaceId); };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },
  
  /**
   * Listen for item added events
   * @param {Function} cb - Callback (spaceId, item)
   * @returns {Function} Unsubscribe function
   */
  onItemAdded: (cb) => {
    const handler = (event, data) => { if (data.type === 'item:added') cb(data.spaceId, data.item); };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },
  
  /**
   * Listen for item updated events
   * @param {Function} cb - Callback (spaceId, itemId, data)
   * @returns {Function} Unsubscribe function
   */
  onItemUpdated: (cb) => {
    const handler = (event, data) => { if (data.type === 'item:updated') cb(data.spaceId, data.itemId, data.data); };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },
  
  /**
   * Listen for item deleted events
   * @param {Function} cb - Callback (spaceId, itemId)
   * @returns {Function} Unsubscribe function
   */
  onItemDeleted: (cb) => {
    const handler = (event, data) => { if (data.type === 'item:deleted') cb(data.spaceId, data.itemId); };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },
  
  /**
   * Listen for item moved events
   * @param {Function} cb - Callback (itemId, fromSpaceId, toSpaceId)
   * @returns {Function} Unsubscribe function
   */
  onItemMoved: (cb) => {
    const handler = (event, data) => { if (data.type === 'item:moved') cb(data.itemId, data.fromSpaceId, data.toSpaceId); };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },
  
  /**
   * Listen for any space event
   * @param {Function} cb - Callback ({ type, ...data })
   * @returns {Function} Unsubscribe function
   */
  onEvent: (cb) => {
    const handler = (event, data) => cb(data);
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  }
});

// ============================================
// YOUTUBE DOWNLOAD API
// ============================================
contextBridge.exposeInMainWorld('youtube', {
  // Check if a URL is a YouTube video
  isYouTubeUrl: (url) => ipcRenderer.invoke('youtube:is-youtube-url', url),
  
  // Extract video ID from URL
  extractVideoId: (url) => ipcRenderer.invoke('youtube:extract-video-id', url),
  
  // Get video info (title, duration, etc.) without downloading
  getInfo: (url) => ipcRenderer.invoke('youtube:get-info', url),
  
  // Download video to Space
  downloadToSpace: (url, spaceId) => ipcRenderer.invoke('youtube:download-to-space', url, spaceId),
  
  // Start background download - returns immediately with placeholder, downloads in background
  startBackgroundDownload: (url, spaceId) => ipcRenderer.invoke('youtube:start-background-download', url, spaceId),
  
  // Download video only (returns file path)
  download: (url, options) => ipcRenderer.invoke('youtube:download', url, options),
  
  // Cancel an active download
  cancelDownload: (placeholderId) => ipcRenderer.invoke('youtube:cancel-download', placeholderId),
  
  // Get list of active downloads
  getActiveDownloads: () => ipcRenderer.invoke('youtube:get-active-downloads'),
  
  // Get transcript/captions from YouTube video (uses YouTube's captions)
  getTranscript: (url, lang = 'en') => ipcRenderer.invoke('youtube:get-transcript', url, lang),
  
  // Fetch and save YouTube transcript for an existing item in the space
  fetchTranscriptForItem: (itemId, lang = 'en') => ipcRenderer.invoke('youtube:fetch-transcript-for-item', itemId, lang),
  
  // Get transcript using OpenAI Whisper (more accurate, word-level timestamps)
  // Requires OpenAI API key in settings
  getTranscriptWhisper: (url, lang = 'en') => ipcRenderer.invoke('youtube:get-transcript-whisper', url, lang),
  
  // Process speaker recognition (transcription with speaker labels)
  // Requires AssemblyAI API key in settings
  processSpeakerRecognition: (url) => ipcRenderer.invoke('youtube:process-speaker-recognition', url),
  
  // Listen for transcription progress
  onTranscribeProgress: (callback) => {
    ipcRenderer.on('youtube:transcribe-progress', (event, progress) => {
      callback(progress);
    });
  },
  
  // Listen for speaker recognition progress
  onSpeakerRecognitionProgress: (callback) => {
    ipcRenderer.on('youtube:speaker-recognition-progress', (event, progress) => {
      callback(progress);
    });
  },
  
  // Listen for download progress
  onProgress: (callback) => {
    ipcRenderer.on('youtube:download-progress', (event, progress) => {
      callback(progress);
    });
  },
  
  // Remove progress listener
  removeProgressListener: () => {
    ipcRenderer.removeAllListeners('youtube:download-progress');
  }
});

// ============================================
// TEST AGENT API
// ============================================
contextBridge.exposeInMainWorld('testAgent', {
  // Generate a test plan for an HTML file
  generatePlan: (htmlFilePath, useAI = false) => 
    ipcRenderer.invoke('test-agent:generate-plan', htmlFilePath, useAI),
  
  // Run all tests in the test plan
  runTests: (htmlFilePath, options = {}) => 
    ipcRenderer.invoke('test-agent:run-tests', htmlFilePath, options),
  
  // Run accessibility test
  runAccessibilityTest: (htmlFilePath) => 
    ipcRenderer.invoke('test-agent:accessibility', htmlFilePath),
  
  // Run performance test
  runPerformanceTest: (htmlFilePath) => 
    ipcRenderer.invoke('test-agent:performance', htmlFilePath),
  
  // Run visual regression test
  runVisualTest: (htmlFilePath, baseline = null) => 
    ipcRenderer.invoke('test-agent:visual', htmlFilePath, baseline),
  
  // Run interactive AI-powered test
  runInteractiveTest: (htmlFilePath) => 
    ipcRenderer.invoke('test-agent:interactive', htmlFilePath),
  
  // Update test agent context
  updateContext: (context) => 
    ipcRenderer.invoke('test-agent:update-context', context),
  
  // Close test agent
  close: () => 
    ipcRenderer.invoke('test-agent:close'),
  
  // Listen for test progress updates
  onProgress: (callback) => {
    ipcRenderer.on('test-agent:progress', (event, result) => {
      callback(result);
    });
  },
  
  // Run cross-browser test (Chrome, Firefox, Safari)
  runCrossBrowserTest: (htmlFilePath) => 
    ipcRenderer.invoke('test-agent:cross-browser', htmlFilePath),
  
  // Enable/disable tracing for debugging
  setTracing: (enabled) => 
    ipcRenderer.invoke('test-agent:set-tracing', enabled)
});