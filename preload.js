// Preload script runs in an isolated context, but has access to Node.js APIs
const { contextBridge, ipcRenderer } = require('electron');

// Set up console interceptor for renderer process
// PERFORMANCE: Uses batching to reduce IPC overhead
(function () {
  // Store original console methods
  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
    info: console.info.bind(console),
  };

  // PERFORMANCE: Batch log messages to reduce IPC calls
  const logBuffer = [];
  const BATCH_INTERVAL = 500; // Flush every 500ms
  const MAX_BUFFER_SIZE = 50; // Flush if buffer gets too large
  let flushTimeout = null;
  let isLoggingEnabled = true; // Controlled by diagnosticLogging setting

  // Read persisted setting on load (async, defaults to enabled)
  ipcRenderer
    .invoke('settings:get-all')
    .then((settings) => {
      if (settings && settings.diagnosticLogging === 'off') {
        isLoggingEnabled = false;
      }
    })
    .catch(() => {
      /* settings IPC may not be ready yet */
    });

  // Get window title or URL for context
  function getWindowContext() {
    let windowName = 'Unknown';
    try {
      windowName = document.title || window.location.pathname || 'Renderer';
    } catch (_e) {
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
    } catch (_err) {
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
    console[method] = function (...args) {
      // Call original console method
      originalConsole[method](...args);

      // Skip logging if disabled for performance
      if (!isLoggingEnabled) return;

      // Format the message
      const message = args
        .map((arg) => {
          if (typeof arg === 'object') {
            try {
              return JSON.stringify(arg, null, 2);
            } catch (_e) {
              return String(arg);
            }
          }
          return String(arg);
        })
        .join(' ');

      // Add to buffer
      const logEntry = {
        level,
        message: `[Console.${method}] ${message}`,
        data: {
          window: getWindowContext(),
          url: window.location ? window.location.href : 'unknown',
          consoleMethod: method,
          timestamp: new Date().toISOString(),
        },
      };

      // Errors are sent immediately for visibility
      if (level === 'error') {
        try {
          ipcRenderer.send('logger:error', logEntry);
        } catch (_err) {
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
contextBridge.exposeInMainWorld('api', {
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
      'login-form-detected',
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
      'llm:call-made',
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
      environment: options.environment || null,
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
  configureContextProvider: (providerId, settings) =>
    ipcRenderer.invoke('voice-task-sdk:configure-provider', providerId, settings),
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
  syncGSXDirectory: (localPath, remotePath, options) =>
    ipcRenderer.invoke('gsx:sync-directory', localPath, remotePath, options),
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
      'credentials-delete-all',
      // Multi-tenant token channels
      'multi-tenant:get-token',
      'multi-tenant:has-token',
      'multi-tenant:inject-token',
      'multi-tenant:attach-listener',
      'multi-tenant:remove-listener',
      'multi-tenant:register-partition',
      'multi-tenant:unregister-partition',
      'multi-tenant:get-environments',
      'multi-tenant:get-diagnostics',
      'multi-tenant:get-user-data',
      'multi-tenant:get-cookies',
      // OneReach auto-login channels
      'onereach:get-credentials',
      'onereach:save-credentials',
      'onereach:delete-credentials',
      'onereach:save-totp',
      'onereach:delete-totp',
      'onereach:test-login',
      'onereach:execute-in-frame',
      // TOTP channels
      'totp:scan-qr-screen',
      'totp:get-current-code',
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
    userAction: (action, details) => ipcRenderer.send('logger:user-action', { action, details }),
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
    updateSettings: (settings) => ipcRenderer.invoke('claude:unified-update-settings', settings),
  },
});

// ---------------------------------------------------------------------------
// Centralized Logging Bridge
// All renderer processes should use window.logging for structured logging.
// Logs flow to the central LogEventQueue in the main process.
// ---------------------------------------------------------------------------
contextBridge.exposeInMainWorld('logging', {
  // Producer API -- push log events onto the central queue
  enqueue: (event) => ipcRenderer.send('logging:enqueue', event),
  info: (category, message, data) => ipcRenderer.send('logging:enqueue', { level: 'info', category, message, data }),
  warn: (category, message, data) => ipcRenderer.send('logging:enqueue', { level: 'warn', category, message, data }),
  error: (category, message, data) => ipcRenderer.send('logging:enqueue', { level: 'error', category, message, data }),
  debug: (category, message, data) => ipcRenderer.send('logging:enqueue', { level: 'debug', category, message, data }),

  // Consumer API -- query and subscribe
  query: (opts) => ipcRenderer.invoke('logging:query', opts),
  getStats: () => ipcRenderer.invoke('logging:get-stats'),
  getRecentLogs: (count) => ipcRenderer.invoke('logging:get-recent-logs', count),
  export: (opts) => ipcRenderer.invoke('logging:export', opts),
  getFiles: () => ipcRenderer.invoke('logging:get-files'),

  // Real-time subscriptions
  subscribe: (filter) => ipcRenderer.invoke('logging:subscribe', filter),
  onEvent: (callback) => {
    ipcRenderer.on('logging:stream', (_, entry) => callback(entry));
  },
  offEvent: (callback) => {
    ipcRenderer.removeListener('logging:stream', callback);
  },

  // Level control (changes are persisted by main process)
  setLevel: (level) => ipcRenderer.invoke('logging:set-level', level),
  getLevel: () => ipcRenderer.invoke('logging:get-level'),
});

// ---------------------------------------------------------------------------
// Centralized AI Service Bridge
// All renderer processes should use window.ai instead of direct API calls.
// ---------------------------------------------------------------------------
contextBridge.exposeInMainWorld('ai', {
  // Chat completion (batch)
  chat: (opts) => ipcRenderer.invoke('ai:chat', opts),

  // Simple text completion
  complete: (prompt, opts) => ipcRenderer.invoke('ai:complete', prompt, opts),

  // JSON completion (returns parsed object)
  json: (prompt, opts) => ipcRenderer.invoke('ai:json', prompt, opts),

  // Vision / image analysis
  vision: (imageData, prompt, opts) => ipcRenderer.invoke('ai:vision', imageData, prompt, opts),

  // Embeddings
  embed: (input, opts) => ipcRenderer.invoke('ai:embed', input, opts),

  // Transcription (pass audio as ArrayBuffer)
  transcribe: (audioBuffer, opts) => ipcRenderer.invoke('ai:transcribe', audioBuffer, opts),

  // Streaming chat - returns { requestId } and streams chunks via events
  chatStream: (opts) => ipcRenderer.invoke('ai:chatStream', opts),

  // Listen for streaming chunks (call after chatStream)
  onStreamChunk: (requestId, callback) => {
    const channel = `ai:stream:${requestId}`;
    const handler = (_event, chunk) => callback(chunk);
    ipcRenderer.on(channel, handler);
    // Return cleanup function
    return () => ipcRenderer.removeListener(channel, handler);
  },

  // Cost monitoring
  getCostSummary: () => ipcRenderer.invoke('ai:getCostSummary'),

  // Service status (circuit breakers, adapters, profiles)
  getStatus: () => ipcRenderer.invoke('ai:getStatus'),

  // Profile management
  getProfiles: () => ipcRenderer.invoke('ai:getProfiles'),
  setProfile: (name, config) => ipcRenderer.invoke('ai:setProfile', name, config),

  // Image generation
  imageGenerate: (prompt, options) => ipcRenderer.invoke('ai:imageGenerate', prompt, options),

  // Provider management
  testConnection: (provider) => ipcRenderer.invoke('ai:testConnection', provider),
  resetCircuit: (provider) => ipcRenderer.invoke('ai:resetCircuit', provider),
});

// ---------------------------------------------------------------------------
// Conversion API Bridge
// All renderer processes should use window.convert for format conversions.
// ---------------------------------------------------------------------------
contextBridge.exposeInMainWorld('convert', {
  convert: (opts) => ipcRenderer.invoke('convert:run', opts),
  capabilities: () => ipcRenderer.invoke('convert:capabilities'),
  pipeline: (opts) => ipcRenderer.invoke('convert:pipeline', opts),
  graph: () => ipcRenderer.invoke('convert:graph'),
  status: (jobId) => ipcRenderer.invoke('convert:status', jobId),
  validatePlaybook: (data) => ipcRenderer.invoke('convert:validate-playbook', data),
  diagnosePlaybook: (data) => ipcRenderer.invoke('convert:diagnose-playbook', data),
});

// ---------------------------------------------------------------------------
// Browser Automation Bridge
// Expose browser automation service to renderer processes.
// ---------------------------------------------------------------------------
contextBridge.exposeInMainWorld('browserAutomation', {
  // Lifecycle
  start: (opts) => ipcRenderer.invoke('browser-automation:start', opts),
  stop: () => ipcRenderer.invoke('browser-automation:stop'),
  status: () => ipcRenderer.invoke('browser-automation:status'),
  configure: (cfg) => ipcRenderer.invoke('browser-automation:configure', cfg),
  // Navigation
  navigate: (url, opts) => ipcRenderer.invoke('browser-automation:navigate', url, opts),
  // Snapshot & actions
  snapshot: (opts) => ipcRenderer.invoke('browser-automation:snapshot', opts),
  screenshot: (opts) => ipcRenderer.invoke('browser-automation:screenshot', opts),
  screenshotElement: (ref, opts) => ipcRenderer.invoke('browser-automation:screenshotElement', ref, opts),
  act: (ref, action, value) => ipcRenderer.invoke('browser-automation:act', ref, action, value),
  scroll: (direction, amount) => ipcRenderer.invoke('browser-automation:scroll', direction, amount),
  drag: (sourceRef, targetRef) => ipcRenderer.invoke('browser-automation:drag', sourceRef, targetRef),
  // Data extraction
  evaluate: (script) => ipcRenderer.invoke('browser-automation:evaluate', script),
  extractText: (selector) => ipcRenderer.invoke('browser-automation:extractText', selector),
  extractLinks: () => ipcRenderer.invoke('browser-automation:extractLinks'),
  // Wait
  waitFor: (condition) => ipcRenderer.invoke('browser-automation:waitFor', condition),
  waitForFunction: (expr, timeout) => ipcRenderer.invoke('browser-automation:waitForFunction', expr, timeout),
  // Tab management
  tabs: () => ipcRenderer.invoke('browser-automation:tabs'),
  openTab: (url) => ipcRenderer.invoke('browser-automation:openTab', url),
  closeTab: (tabId) => ipcRenderer.invoke('browser-automation:closeTab', tabId),
  focusTab: (tabId) => ipcRenderer.invoke('browser-automation:focusTab', tabId),
  // Cookies
  cookies: () => ipcRenderer.invoke('browser-automation:cookies'),
  setCookie: (cookie) => ipcRenderer.invoke('browser-automation:setCookie', cookie),
  clearCookies: () => ipcRenderer.invoke('browser-automation:clearCookies'),
  // Storage
  storageGet: (type, key) => ipcRenderer.invoke('browser-automation:storageGet', type, key),
  storageSet: (type, key, value) => ipcRenderer.invoke('browser-automation:storageSet', type, key, value),
  storageClear: (type) => ipcRenderer.invoke('browser-automation:storageClear', type),
  // Dialogs
  handleDialog: (opts) => ipcRenderer.invoke('browser-automation:handleDialog', opts),
  getLastDialog: () => ipcRenderer.invoke('browser-automation:getLastDialog'),
  // File upload
  upload: (ref, filePaths) => ipcRenderer.invoke('browser-automation:upload', ref, filePaths),
  uploadViaChooser: (triggerRef, filePaths) =>
    ipcRenderer.invoke('browser-automation:uploadViaChooser', triggerRef, filePaths),
  // Download
  download: (triggerRef, saveAs) => ipcRenderer.invoke('browser-automation:download', triggerRef, saveAs),
  getDownloadDir: () => ipcRenderer.invoke('browser-automation:getDownloadDir'),
  // Network inspection
  networkStart: () => ipcRenderer.invoke('browser-automation:networkStart'),
  networkStop: () => ipcRenderer.invoke('browser-automation:networkStop'),
  getConsole: (opts) => ipcRenderer.invoke('browser-automation:getConsole', opts),
  getErrors: (opts) => ipcRenderer.invoke('browser-automation:getErrors', opts),
  getRequests: (opts) => ipcRenderer.invoke('browser-automation:getRequests', opts),
  getResponseBody: (urlPattern, timeout) =>
    ipcRenderer.invoke('browser-automation:getResponseBody', urlPattern, timeout),
  // Environment
  setViewport: (w, h) => ipcRenderer.invoke('browser-automation:setViewport', w, h),
  setDevice: (name) => ipcRenderer.invoke('browser-automation:setDevice', name),
  setGeolocation: (lat, lon, acc) => ipcRenderer.invoke('browser-automation:setGeolocation', lat, lon, acc),
  clearGeolocation: () => ipcRenderer.invoke('browser-automation:clearGeolocation'),
  setTimezone: (tz) => ipcRenderer.invoke('browser-automation:setTimezone', tz),
  setLocale: (locale) => ipcRenderer.invoke('browser-automation:setLocale', locale),
  setOffline: (offline) => ipcRenderer.invoke('browser-automation:setOffline', offline),
  setExtraHeaders: (headers) => ipcRenderer.invoke('browser-automation:setExtraHeaders', headers),
  setCredentials: (user, pass) => ipcRenderer.invoke('browser-automation:setCredentials', user, pass),
  setMedia: (colorScheme) => ipcRenderer.invoke('browser-automation:setMedia', colorScheme),
  // Debug
  traceStart: (opts) => ipcRenderer.invoke('browser-automation:traceStart', opts),
  traceStop: (savePath) => ipcRenderer.invoke('browser-automation:traceStop', savePath),
  highlight: (ref, opts) => ipcRenderer.invoke('browser-automation:highlight', ref, opts),
  // PDF
  pdf: (opts) => ipcRenderer.invoke('browser-automation:pdf', opts),
});

// Expose electron API for relaunch functionality
contextBridge.exposeInMainWorld('electron', {
  send: (channel, data) => {
    // Whitelist channels to ensure secure IPC
    const validChannels = [
      'relaunch-app',
      'black-hole:resize-window',
      'black-hole:move-window',
      'black-hole:get-position',
      'black-hole:restore-position',
      'black-hole:active',
      'black-hole:inactive',
      'black-hole:widget-ready',
      'show-notification',
      'float-card:close',
      'float-card:ready',
    ];
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
      'clipboard:select-space-for-screenshot',
      'black-hole:position-response',
      'black-hole:init',
      'external-file-drop',
      'prepare-for-download',
      'check-widget-ready',
      'paste-clipboard-data',
      'float-card:init',
      // Setup wizard: response channels for get-* requests
      'get-idw-environments',
      'get-external-bots',
      'get-image-creators',
      'get-video-creators',
      'get-audio-generators',
      'get-ui-design-tools',
    ];
    const dataOnlyChannels = [
      'get-idw-environments',
      'get-external-bots',
      'get-image-creators',
      'get-video-creators',
      'get-audio-generators',
      'get-ui-design-tools',
    ];
    if (validChannels.includes(channel)) {
      if (dataOnlyChannels.includes(channel)) {
        // Setup wizard expects (data) not (event, data)
        ipcRenderer.on(channel, (event, ...args) => func(...args));
      } else {
        ipcRenderer.on(channel, (event, ...args) => func(event, ...args));
      }
    }
  },
  ipcRenderer: {
    send: (channel, data) => {
      const validChannels = [
        'black-hole:resize-window',
        'black-hole:move-window',
        'black-hole:get-position',
        'black-hole:restore-position',
        'black-hole:active',
        'black-hole:inactive',
        'black-hole:widget-ready',
        'show-notification',
        'float-card:close',
        'float-card:ready',
        'float-card:start-drag',
      ];
      if (validChannels.includes(channel)) {
        ipcRenderer.send(channel, data);
      } else {
        console.warn('[Preload] Invalid send channel:', channel);
      }
    },
    on: (channel, func) => {
      const validChannels = [
        'black-hole:position-response',
        'black-hole:init',
        'external-file-drop',
        'prepare-for-download',
        'check-widget-ready',
        'paste-clipboard-data',
        'float-card:init',
      ];
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
        'clipboard:add-item',
        'clipboard:write-text',
        'black-hole:add-image',
        'black-hole:add-file',
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
        // Native drag and float card channels
        'clipboard:start-native-drag',
        'clipboard:float-item',
        'clipboard:close-float',
        // Lessons/Tutorials API channels
        'get-current-user',
        'fetch-user-lessons',
        'update-lesson-progress',
        // OneReach auto-login channels
        'onereach:get-credentials',
        'onereach:save-credentials',
        'onereach:delete-credentials',
        'onereach:save-totp',
        'onereach:delete-totp',
        'onereach:test-login',
        'onereach:execute-in-frame',
        // TOTP channels
        'totp:scan-qr-screen',
        'totp:get-current-code',
      ];
      if (validChannels.includes(channel)) {
        return ipcRenderer.invoke(channel, ...args);
      }
      throw new Error(`Invalid channel: ${channel}`);
    },
  },
  clipboard: {
    writeText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  },
});

contextBridge.exposeInMainWorld('flipboardAPI', {
  fetchRSS: (url) => ipcRenderer.invoke('fetch-rss', url),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onRSSData: (callback) => {
    ipcRenderer.on('rss-data', (event, data) => callback(data));
  },
  loadReadingLog: () => ipcRenderer.invoke('load-reading-log'),
  saveReadingLog: (log) => ipcRenderer.send('save-reading-log', log),
  saveReadingLogSync: (log) => ipcRenderer.sendSync('save-reading-log-sync', log),
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
  },
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
  },
});

// Expose Speech Recognition Bridge (Whisper-based) for web apps
// Speech/Voice APIs (shared module)
const {
  getSpeechBridgeMethods,
  getRealtimeSpeechMethods,
  getMicManagerMethods,
  getVoiceTTSMethods,
} = require('./preload-speech');
contextBridge.exposeInMainWorld('speechBridge', getSpeechBridgeMethods());

contextBridge.exposeInMainWorld('realtimeSpeech', getRealtimeSpeechMethods());

contextBridge.exposeInMainWorld('micManager', getMicManagerMethods());
contextBridge.exposeInMainWorld('voiceTTS', getVoiceTTSMethods());

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
  },
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
  setFileMetadata: (spaceId, filePath, metadata) =>
    ipcRenderer.invoke('aider:set-file-metadata', spaceId, filePath, metadata),
  getFileMetadata: (spaceId, filePath) => ipcRenderer.invoke('aider:get-file-metadata', spaceId, filePath),
  setAssetMetadata: (spaceId, assetType, metadata) =>
    ipcRenderer.invoke('aider:set-asset-metadata', spaceId, assetType, metadata),
  setApproval: (spaceId, itemType, itemId, approved) =>
    ipcRenderer.invoke('aider:set-approval', spaceId, itemType, itemId, approved),
  addVersion: (spaceId, versionData) => ipcRenderer.invoke('aider:add-version', spaceId, versionData),
  updateProjectConfig: (spaceId, configUpdates) =>
    ipcRenderer.invoke('aider:update-project-config', spaceId, configUpdates),
  // Playwright API testing
  runPlaywrightTests: (options) => ipcRenderer.invoke('aider:run-playwright-tests', options),
  // File operations
  readFile: (filePath) => ipcRenderer.invoke('aider:read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('aider:write-file', filePath, content),
  deleteFile: (filePath) => ipcRenderer.invoke('aider:delete-file', filePath),
  openFile: (filePath) => ipcRenderer.invoke('aider:open-file', filePath),

  // Version backup/restore
  backupVersion: (spacePath, version, metadata) =>
    ipcRenderer.invoke('aider:backup-version', spacePath, version, metadata),
  restoreVersion: (spacePath, version, createBackupFirst) =>
    ipcRenderer.invoke('aider:restore-version', spacePath, version, createBackupFirst),
  listBackups: (spacePath) => ipcRenderer.invoke('aider:list-backups', spacePath),

  // Branch system for parallel versions
  createBranch: (spacePath, branchId, metadata) =>
    ipcRenderer.invoke('aider:create-branch', spacePath, branchId, metadata),
  listBranches: (spacePath) => ipcRenderer.invoke('aider:list-branches', spacePath),
  updateBranch: (spacePath, branchId, updates) =>
    ipcRenderer.invoke('aider:update-branch', spacePath, branchId, updates),
  promoteBranch: (spacePath, branchId) => ipcRenderer.invoke('aider:promote-branch', spacePath, branchId),
  deleteBranch: (spacePath, branchId) => ipcRenderer.invoke('aider:delete-branch', spacePath, branchId),

  // Git branch operations for tabbed UI
  gitInit: (repoPath) => ipcRenderer.invoke('aider:git-init', repoPath),
  gitCreateBranch: (repoPath, branchName, baseBranch) =>
    ipcRenderer.invoke('aider:git-create-branch', repoPath, branchName, baseBranch),
  gitCreateOrphanBranch: (repoPath, branchName) =>
    ipcRenderer.invoke('aider:git-create-orphan-branch', repoPath, branchName),
  gitSwitchBranch: (repoPath, branchName) => ipcRenderer.invoke('aider:git-switch-branch', repoPath, branchName),
  gitDeleteBranch: (repoPath, branchName) => ipcRenderer.invoke('aider:git-delete-branch', repoPath, branchName),
  gitListBranches: (repoPath) => ipcRenderer.invoke('aider:git-list-branches', repoPath),
  gitDiffBranches: (repoPath, branchA, branchB) =>
    ipcRenderer.invoke('aider:git-diff-branches', repoPath, branchA, branchB),
  gitMergeBranch: (repoPath, sourceBranch, targetBranch) =>
    ipcRenderer.invoke('aider:git-merge-branch', repoPath, sourceBranch, targetBranch),
  gitMergePreview: (repoPath, sourceBranch, targetBranch) =>
    ipcRenderer.invoke('aider:git-merge-preview', repoPath, sourceBranch, targetBranch),

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
      try {
        callback(filePath);
      } catch (err) {
        console.error('[preload] IPC callback error:', err);
      }
    };
    ipcRenderer.on('aider:file-changed', handler);
    // Return an unsubscribe function (best-effort)
    return () => {
      try {
        ipcRenderer.removeListener('aider:file-changed', handler);
      } catch (_e) {
        /* noop */
      }
    };
  },
  // Screenshot capture (takes file path, not HTML content)
  capturePreviewScreenshot: (filePath) => ipcRenderer.invoke('aider:capture-preview-screenshot', filePath),
  analyzeScreenshot: (screenshotBase64, prompt) =>
    ipcRenderer.invoke('aider:analyze-screenshot', screenshotBase64, prompt),
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
  budgetSetProjectBudget: (projectId, limit, alertAt, hardLimit) =>
    ipcRenderer.invoke('budget:setProjectBudget', projectId, limit, alertAt, hardLimit),

  // Unified Pricing API
  pricingGetAll: () => ipcRenderer.invoke('pricing:getAll'),
  pricingCalculate: (model, inputTokens, outputTokens, options) =>
    ipcRenderer.invoke('pricing:calculate', model, inputTokens, outputTokens, options),

  // Unified Space Metadata System
  getSpaceMetadata: (spaceId) => ipcRenderer.invoke('aider:get-space-metadata', spaceId),
  updateSpaceMetadata: (spaceId, updates) => ipcRenderer.invoke('aider:update-space-metadata', spaceId, updates),
  setFileMetadata: (spaceId, filePath, metadata) =>
    ipcRenderer.invoke('aider:set-file-metadata', spaceId, filePath, metadata),
  getFileMetadata: (spaceId, filePath) => ipcRenderer.invoke('aider:get-file-metadata', spaceId, filePath),
  setAssetMetadata: (spaceId, assetType, metadata) =>
    ipcRenderer.invoke('aider:set-asset-metadata', spaceId, assetType, metadata),
  setApproval: (spaceId, itemType, itemId, approved) =>
    ipcRenderer.invoke('aider:set-approval', spaceId, itemType, itemId, approved),
  addVersion: (spaceId, versionData) => ipcRenderer.invoke('aider:add-version', spaceId, versionData),
  updateProjectConfig: (spaceId, configUpdates) =>
    ipcRenderer.invoke('aider:update-project-config', spaceId, configUpdates),

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
  sendShutdownBlocked: (reason) => ipcRenderer.send('shutdown-blocked', reason),
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
    const token =
      urlObj.searchParams.get('token') || urlObj.searchParams.get('access_token') || urlObj.searchParams.get('code');

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
    return (
      url.includes('accounts.google.com') ||
      url.includes('oauth2') ||
      url.includes('auth') ||
      url.includes('signin') ||
      url.includes('consent')
    );
  },
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
  setMonitorCheckInterval: (itemId, minutes) =>
    ipcRenderer.invoke('clipboard:set-monitor-check-interval', itemId, minutes),

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
  getPdfData: (itemId) => ipcRenderer.invoke('clipboard:get-pdf-data', itemId),
  getPDFPageThumbnail: (itemId, pageNumber) =>
    ipcRenderer.invoke('clipboard:get-pdf-page-thumbnail', itemId, pageNumber),
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

  // Data Source methods
  addDataSource: (data) => ipcRenderer.invoke('clipboard:add-data-source', data),
  testDataSource: (itemId, credential) => ipcRenderer.invoke('clipboard:test-data-source', itemId, credential),
  updateDataSourceDocument: (itemId, content, visibility) =>
    ipcRenderer.invoke('clipboard:update-data-source-document', itemId, content, visibility),

  // Black hole widget methods
  openBlackHole: () => ipcRenderer.invoke('clipboard:open-black-hole'),
  addText: (data) => ipcRenderer.invoke('black-hole:add-text', data),
  addHtml: (data) => ipcRenderer.invoke('black-hole:add-html', data),
  addImage: (data) => ipcRenderer.invoke('black-hole:add-image', data),
  addFile: (data) => ipcRenderer.invoke('black-hole:add-file', data),

  // Unified space metadata methods
  getSpaceMetadata: (spaceId) => ipcRenderer.invoke('aider:get-space-metadata', spaceId),
  updateSpaceMetadata: (spaceId, updates) => ipcRenderer.invoke('aider:update-space-metadata', spaceId, updates),
  setFileMetadata: (spaceId, filePath, metadata) =>
    ipcRenderer.invoke('aider:set-file-metadata', spaceId, filePath, metadata),
  getFileMetadata: (spaceId, filePath) => ipcRenderer.invoke('aider:get-file-metadata', spaceId, filePath),
  setAssetMetadata: (spaceId, assetName, metadata) =>
    ipcRenderer.invoke('aider:set-asset-metadata', spaceId, assetName, metadata),
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
    },
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
  },
  onTTSProgress: (callback) => {
    ipcRenderer.on('tts-progress', (event, progress) => {
      callback(progress);
    });
  },
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

  // ---- DISCOVERY (remote graph -> local) ----

  /**
   * Discover remote spaces in the graph not yet imported locally.
   * @returns {Promise<Object>} { spaces: [...], email, lastChecked, error? }
   */
  discover: () => ipcRenderer.invoke('spaces:discover'),

  /**
   * Import remote spaces from the graph into local storage.
   * @param {Array<Object>} remoteSpaces - Array of remote space objects from discover()
   * @returns {Promise<Object>} { imported: [...], skipped: [...], failed: [...] }
   */
  importRemote: (remoteSpaces) => ipcRenderer.invoke('spaces:discover:import', remoteSpaces),

  /**
   * Listen for remote-discovered events (fired by discovery polling).
   * @param {Function} cb - Callback with { spaces, email, lastChecked }
   * @returns {Function} Unsubscribe function
   */
  onRemoteDiscovered: (cb) => {
    const handler = (event, data) => {
      if (data.type === 'spaces:remote-discovered') cb(data);
    };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },

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
    generateMetadata: (spaceId, itemId, opts) =>
      ipcRenderer.invoke('spaces:items:generateMetadata', spaceId, itemId, opts),
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
    deleteFromSpace: (spaceId, tag) => ipcRenderer.invoke('spaces:tags:deleteFromSpace', spaceId, tag),
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
    preview: (criteria, opts) => ipcRenderer.invoke('spaces:smartFolders:preview', criteria, opts),
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
    setApproval: (spaceId, itemType, itemId, approved) =>
      ipcRenderer.invoke('spaces:metadata:setApproval', spaceId, itemType, itemId, approved),

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
    updateProjectConfig: (spaceId, config) =>
      ipcRenderer.invoke('spaces:metadata:updateProjectConfig', spaceId, config),
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
    delete: (spaceId, filePath) => ipcRenderer.invoke('spaces:files:delete', spaceId, filePath),
  },

  // ---- GSX PUSH API ----
  gsx: {
    /**
     * Initialize GSX Push with endpoint and auth
     * @param {string} endpoint - OmniGraph endpoint URL
     * @returns {Promise<Object>} { success }
     */
    initialize: (endpoint, currentUser) => ipcRenderer.invoke('spaces:gsx:initialize', endpoint, currentUser),

    /**
     * Set the current user for provenance tracking
     * @param {string} user - User email
     * @returns {Promise<Object>} { success }
     */
    setCurrentUser: (user) => ipcRenderer.invoke('spaces:gsx:setCurrentUser', user),

    /**
     * Get the current GSX auth token from settings
     * @returns {Promise<string|null>} Token or null
     */
    getToken: () => ipcRenderer.invoke('spaces:gsx:getToken'),

    /**
     * Push a single asset to GSX
     * @param {string} itemId - Item ID
     * @param {Object} opts - Options { isPublic, force }
     * @returns {Promise<Object>} { success, fileUrl, graphNodeId, version }
     */
    pushAsset: (itemId, opts) => ipcRenderer.invoke('spaces:gsx:pushAsset', itemId, opts),

    /**
     * Push multiple assets to GSX
     * @param {string[]} itemIds - Item IDs
     * @param {Object} opts - Options { isPublic }
     * @returns {Promise<Object>} { success, pushed, skipped, failed }
     */
    pushAssets: (itemIds, opts) => ipcRenderer.invoke('spaces:gsx:pushAssets', itemIds, opts),

    /**
     * Push a space to GSX
     * @param {string} spaceId - Space ID
     * @param {Object} opts - Options { isPublic, includeAssets }
     * @returns {Promise<Object>} { success, graphNodeId, assetsPushed }
     */
    pushSpace: (spaceId, opts) => ipcRenderer.invoke('spaces:gsx:pushSpace', spaceId, opts),

    /**
     * Unpush an asset from GSX (soft delete)
     * @param {string} itemId - Item ID
     * @returns {Promise<Object>} { success, message }
     */
    unpushAsset: (itemId) => ipcRenderer.invoke('spaces:gsx:unpushAsset', itemId),

    /**
     * Unpush multiple assets
     * @param {string[]} itemIds - Item IDs
     * @returns {Promise<Object>} { success, unpushed, failed }
     */
    unpushAssets: (itemIds) => ipcRenderer.invoke('spaces:gsx:unpushAssets', itemIds),

    /**
     * Unpush a space from GSX
     * @param {string} spaceId - Space ID
     * @param {Object} opts - Options { includeAssets }
     * @returns {Promise<Object>} { success }
     */
    unpushSpace: (spaceId, opts) => ipcRenderer.invoke('spaces:gsx:unpushSpace', spaceId, opts),

    /**
     * Change visibility of a pushed asset
     * @param {string} itemId - Item ID
     * @param {boolean} isPublic - New visibility
     * @returns {Promise<Object>} { success, newVisibility, fileUrl }
     */
    changeVisibility: (itemId, isPublic) => ipcRenderer.invoke('spaces:gsx:changeVisibility', itemId, isPublic),

    /**
     * Change visibility for multiple assets
     * @param {string[]} itemIds - Item IDs
     * @param {boolean} isPublic - New visibility
     * @returns {Promise<Object>} { success, changed, failed }
     */
    changeVisibilityBulk: (itemIds, isPublic) =>
      ipcRenderer.invoke('spaces:gsx:changeVisibilityBulk', itemIds, isPublic),

    /**
     * Get push status for an item
     * @param {string} itemId - Item ID
     * @returns {Promise<Object>} { status, fileUrl, graphNodeId, version, hasLocalChanges }
     */
    getPushStatus: (itemId) => ipcRenderer.invoke('spaces:gsx:getPushStatus', itemId),

    /**
     * Get push statuses for multiple items
     * @param {string[]} itemIds - Item IDs
     * @returns {Promise<Object>} Map of itemId -> pushStatus
     */
    getPushStatuses: (itemIds) => ipcRenderer.invoke('spaces:gsx:getPushStatuses', itemIds),

    /**
     * Update push status (for external sources)
     * @param {string} itemId - Item ID
     * @param {Object} pushData - Push metadata
     * @returns {Promise<Object>} { success }
     */
    updatePushStatus: (itemId, pushData) => ipcRenderer.invoke('spaces:gsx:updatePushStatus', itemId, pushData),

    /**
     * Check which items have local changes since last push
     * @param {string[]} itemIds - Item IDs
     * @returns {Promise<Object>} { changed, unchanged, notPushed }
     */
    checkLocalChanges: (itemIds) => ipcRenderer.invoke('spaces:gsx:checkLocalChanges', itemIds),

    /**
     * Get all links for a pushed item
     * @param {string} itemId - Item ID
     * @returns {Promise<Object>} { fileUrl, graphNodeId, shareLink }
     */
    getLinks: (itemId) => ipcRenderer.invoke('spaces:gsx:getLinks', itemId),

    /**
     * Get share link for an item
     * @param {string} itemId - Item ID
     * @returns {Promise<Object>} { url, requiresAuth }
     */
    getShareLink: (itemId) => ipcRenderer.invoke('spaces:gsx:getShareLink', itemId),

    /**
     * Get specific link type for an item
     * @param {string} itemId - Item ID
     * @param {string} linkType - 'file' | 'graph' | 'share'
     * @returns {Promise<Object>} { link, type }
     */
    getLink: (itemId, linkType) => ipcRenderer.invoke('spaces:gsx:getLink', itemId, linkType),
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
    const handler = (event, data) => {
      if (data.type === 'space:created') cb(data.space);
    };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },

  /**
   * Listen for space updated events
   * @param {Function} cb - Callback (spaceId, data)
   * @returns {Function} Unsubscribe function
   */
  onSpaceUpdated: (cb) => {
    const handler = (event, data) => {
      if (data.type === 'space:updated') cb(data.spaceId, data.data);
    };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },

  /**
   * Listen for space deleted events
   * @param {Function} cb - Callback (spaceId)
   * @returns {Function} Unsubscribe function
   */
  onSpaceDeleted: (cb) => {
    const handler = (event, data) => {
      if (data.type === 'space:deleted') cb(data.spaceId);
    };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },

  /**
   * Listen for item added events
   * @param {Function} cb - Callback (spaceId, item)
   * @returns {Function} Unsubscribe function
   */
  onItemAdded: (cb) => {
    const handler = (event, data) => {
      if (data.type === 'item:added') cb(data.spaceId, data.item);
    };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },

  /**
   * Listen for item updated events
   * @param {Function} cb - Callback (spaceId, itemId, data)
   * @returns {Function} Unsubscribe function
   */
  onItemUpdated: (cb) => {
    const handler = (event, data) => {
      if (data.type === 'item:updated') cb(data.spaceId, data.itemId, data.data);
    };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },

  /**
   * Listen for item deleted events
   * @param {Function} cb - Callback (spaceId, itemId)
   * @returns {Function} Unsubscribe function
   */
  onItemDeleted: (cb) => {
    const handler = (event, data) => {
      if (data.type === 'item:deleted') cb(data.spaceId, data.itemId);
    };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },

  /**
   * Listen for item moved events
   * @param {Function} cb - Callback (itemId, fromSpaceId, toSpaceId)
   * @returns {Function} Unsubscribe function
   */
  onItemMoved: (cb) => {
    const handler = (event, data) => {
      if (data.type === 'item:moved') cb(data.itemId, data.fromSpaceId, data.toSpaceId);
    };
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
  },
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
  fetchTranscriptForItem: (itemId, lang = 'en') =>
    ipcRenderer.invoke('youtube:fetch-transcript-for-item', itemId, lang),

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
  },
});

// ============================================
// TEST AGENT API
// ============================================
contextBridge.exposeInMainWorld('testAgent', {
  // Generate a test plan for an HTML file
  generatePlan: (htmlFilePath, useAI = false) => ipcRenderer.invoke('test-agent:generate-plan', htmlFilePath, useAI),

  // Run all tests in the test plan
  runTests: (htmlFilePath, options = {}) => ipcRenderer.invoke('test-agent:run-tests', htmlFilePath, options),

  // Run accessibility test
  runAccessibilityTest: (htmlFilePath) => ipcRenderer.invoke('test-agent:accessibility', htmlFilePath),

  // Run performance test
  runPerformanceTest: (htmlFilePath) => ipcRenderer.invoke('test-agent:performance', htmlFilePath),

  // Run visual regression test
  runVisualTest: (htmlFilePath, baseline = null) => ipcRenderer.invoke('test-agent:visual', htmlFilePath, baseline),

  // Run interactive AI-powered test
  runInteractiveTest: (htmlFilePath) => ipcRenderer.invoke('test-agent:interactive', htmlFilePath),

  // Update test agent context
  updateContext: (context) => ipcRenderer.invoke('test-agent:update-context', context),

  // Close test agent
  close: () => ipcRenderer.invoke('test-agent:close'),

  // Listen for test progress updates
  onProgress: (callback) => {
    ipcRenderer.on('test-agent:progress', (event, result) => {
      callback(result);
    });
  },

  // Run cross-browser test (Chrome, Firefox, Safari)
  runCrossBrowserTest: (htmlFilePath) => ipcRenderer.invoke('test-agent:cross-browser', htmlFilePath),

  // Enable/disable tracing for debugging
  setTracing: (enabled) => ipcRenderer.invoke('test-agent:set-tracing', enabled),
});

// Playbook + Sync APIs (shared module)
const { getPlaybookMethods, getSyncMethods } = require('./preload-playbook-sync');
contextBridge.exposeInMainWorld('playbook', getPlaybookMethods('preload'));
contextBridge.exposeInMainWorld('sync', getSyncMethods());
