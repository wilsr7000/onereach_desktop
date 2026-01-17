const { app, Menu, shell, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

// ============================================
// GSX WINDOW TRACKING
// ============================================
// Track all GSX windows to ensure proper cleanup on quit
const gsxWindows = [];

/**
 * Register a GSX window for tracking
 * @param {BrowserWindow} window - The window to track
 * @param {string} title - Window title for debugging
 */
function registerGSXWindow(window, title) {
  gsxWindows.push({ window, title, created: Date.now() });
  console.log(`[GSX Windows] Registered: ${title} (Total: ${gsxWindows.length})`);
  
  // Remove from tracking when closed
  window.once('closed', () => {
    const index = gsxWindows.findIndex(w => w.window === window);
    if (index !== -1) {
      gsxWindows.splice(index, 1);
      console.log(`[GSX Windows] Unregistered: ${title} (Remaining: ${gsxWindows.length})`);
    }
  });
}

/**
 * Force close all tracked GSX windows
 * Used during app quit to prevent zombie windows
 */
function closeAllGSXWindows() {
  console.log(`[GSX Windows] Force closing ${gsxWindows.length} windows`);
  
  gsxWindows.forEach(({ window, title }) => {
    if (!window.isDestroyed()) {
      console.log(`[GSX Windows] Destroying: ${title}`);
      try {
        window.destroy();
      } catch (error) {
        console.error(`[GSX Windows] Error destroying ${title}:`, error);
      }
    }
  });
  
  gsxWindows.length = 0; // Clear array
}

// ============================================
// PERFORMANCE: Menu data caching
// ============================================
// Cache menu configuration data to avoid repeated file I/O
const menuCache = {
  idwEnvironments: null,
  gsxLinks: null,
  externalBots: null,
  imageCreators: null,
  videoCreators: null,
  audioGenerators: null,
  uiDesignTools: null,
  userPrefs: null,
  lastLoaded: 0,
  cacheValidMs: 60000, // Cache valid for 60 seconds
  
  // Check if cache is still valid
  isValid() {
    return this.lastLoaded > 0 && (Date.now() - this.lastLoaded) < this.cacheValidMs;
  },
  
  // Invalidate cache (call when files are updated)
  invalidate() {
    this.lastLoaded = 0;
    console.log('[Menu Cache] Cache invalidated');
  },
  
  // Load all menu data with caching
  loadAll() {
    if (this.isValid()) {
      console.log('[Menu Cache] Using cached menu data');
      return {
        idwEnvironments: this.idwEnvironments || [],
        gsxLinks: this.gsxLinks || [],
        externalBots: this.externalBots || [],
        imageCreators: this.imageCreators || [],
        videoCreators: this.videoCreators || [],
        audioGenerators: this.audioGenerators || [],
        uiDesignTools: this.uiDesignTools || [],
        userPrefs: this.userPrefs || {}
      };
    }
    
    console.log('[Menu Cache] Loading menu data from files...');
    const startTime = Date.now();
    
    try {
      const electronApp = require('electron').app;
      const userDataPath = electronApp.getPath('userData');
      
      // Load all files
      this.idwEnvironments = this._loadJsonFile(path.join(userDataPath, 'idw-entries.json'), []);
      this.gsxLinks = this._loadJsonFile(path.join(userDataPath, 'gsx-links.json'), []);
      this.externalBots = this._loadJsonFile(path.join(userDataPath, 'external-bots.json'), []);
      this.imageCreators = this._loadJsonFile(path.join(userDataPath, 'image-creators.json'), []);
      this.videoCreators = this._loadJsonFile(path.join(userDataPath, 'video-creators.json'), []);
      this.audioGenerators = this._loadJsonFile(path.join(userDataPath, 'audio-generators.json'), []);
      this.uiDesignTools = this._loadJsonFile(path.join(userDataPath, 'ui-design-tools.json'), []);
      this.userPrefs = this._loadJsonFile(path.join(userDataPath, 'user-preferences.json'), {});
      
      this.lastLoaded = Date.now();
      console.log(`[Menu Cache] Loaded all menu data in ${Date.now() - startTime}ms`);
      
    } catch (error) {
      console.error('[Menu Cache] Error loading menu data:', error);
    }
    
    return {
      idwEnvironments: this.idwEnvironments || [],
      gsxLinks: this.gsxLinks || [],
      externalBots: this.externalBots || [],
      imageCreators: this.imageCreators || [],
      videoCreators: this.videoCreators || [],
      audioGenerators: this.audioGenerators || [],
      uiDesignTools: this.uiDesignTools || [],
      userPrefs: this.userPrefs || {}
    };
  },
  
  // Helper to load a JSON file with default value
  _loadJsonFile(filePath, defaultValue) {
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error(`[Menu Cache] Error loading ${filePath}:`, error.message);
    }
    return defaultValue;
  }
};

/**
 * Helper function to open GSX content in a large app window
 * @param {string} url The URL to load
 * @param {string} title The window title
 * @param {string} windowTitle The full window title
 * @param {string} loadingMessage The loading message to display
 * @param {string} idwEnvironment The IDW environment for session isolation
 * @returns {BrowserWindow} The created window
 */
function openGSXLargeWindow(url, title, windowTitle, loadingMessage = 'Loading...', idwEnvironment = null) {
  const getLogger = require('./event-logger');
  const logger = getLogger();
  
  // Log the window access
  if (logger && logger.info) {
    logger.info('GSX Large Window Opened', {
      action: 'window_open',
      title: title,
      url: url,
      timestamp: new Date().toISOString()
    });
  }
  console.log(`[Menu] Opening GSX large window: ${title} - ${url}`);
  
  // Extract environment from URL if not provided
  if (!idwEnvironment) {
    try {
      const urlObj = new URL(url);
      // Extract from hostname - e.g., studio.edison.onereach.ai -> edison
      const hostParts = urlObj.hostname.split('.');
      idwEnvironment = hostParts.find(part => 
        ['staging', 'edison', 'production', 'store'].includes(part)
      ) || 'default';
    } catch (err) {
      console.error('Error parsing GSX URL to extract environment:', err);
      idwEnvironment = 'default';
    }
  }
  
  // Create session partition name based ONLY on the IDW environment
  // This allows all GSX windows in the same IDW group to share cookies
  // while keeping different IDW groups sandboxed from each other
  const partitionName = `gsx-${idwEnvironment}`;
  
  console.log(`[Menu] Using shared session partition for IDW group: ${partitionName}`);
  
  const gsxWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: windowTitle || title,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      partition: `persist:${partitionName}`,  // Session partitioning for cookie isolation
      sandbox: false,
      webSecurity: true,
      webviewTag: false
    },
    backgroundColor: '#1a1a1a',
    show: false
  });
  
  // Show loading indicator with a unique class
  let loadingIndicatorInserted = false;
  gsxWindow.webContents.on('did-start-loading', () => {
    if (!loadingIndicatorInserted) {
      loadingIndicatorInserted = true;
      gsxWindow.webContents.insertCSS(`
        body::before {
          content: '${loadingMessage}';
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          font-size: 24px;
          color: #666;
          z-index: 99999;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: rgba(255, 255, 255, 0.95);
          padding: 20px 40px;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        }
        body.gsx-loaded::before {
          display: none !important;
        }
      `);
    }
  });
  
  // Inject minimal toolbar after page loads
  gsxWindow.webContents.on('did-finish-load', () => {
    // Add class to hide the loading indicator
    gsxWindow.webContents.executeJavaScript(`
      document.body.classList.add('gsx-loaded');
    `).catch(err => console.error('[GSX Window] Error hiding loading indicator:', err));
    
    // Inject the minimal toolbar
    gsxWindow.webContents.executeJavaScript(`
      (function() {
        // Check if toolbar already exists
        if (document.getElementById('gsx-minimal-toolbar')) return;
        
        // Create toolbar
        const toolbar = document.createElement('div');
        toolbar.id = 'gsx-minimal-toolbar';
        toolbar.innerHTML = \`
          <button id="gsx-back" title="Back">◀</button>
          <button id="gsx-forward" title="Forward">▶</button>
          <button id="gsx-refresh" title="Refresh">↻</button>
          <button id="gsx-mission-control" title="Show All Windows">⊞</button>
          <button id="gsx-close" title="Close Window">×</button>
        \`;
        
        // Add styles
        const style = document.createElement('style');
        style.textContent = \`
          #gsx-minimal-toolbar {
            position: fixed;
            bottom: 0;
            left: 50%;
            transform: translateX(-50%);
            z-index: 999999;
            background: rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(8px);
            padding: 4px 8px;
            display: flex;
            gap: 4px;
            border-radius: 8px 8px 0 0;
            opacity: 0.4;
            transition: opacity 0.3s, padding 0.2s;
          }
          
          #gsx-minimal-toolbar:hover {
            opacity: 1;
            padding: 6px 10px;
          }
          
          #gsx-minimal-toolbar button {
            background: transparent;
            border: none;
            color: rgba(255, 255, 255, 0.7);
            width: 28px;
            height: 28px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
          }
          
          #gsx-minimal-toolbar button:hover {
            background: rgba(255, 255, 255, 0.15);
            color: rgba(255, 255, 255, 1);
            transform: scale(1.1);
          }
          
          #gsx-minimal-toolbar button:active {
            transform: scale(0.95);
          }
          
          #gsx-minimal-toolbar button:disabled {
            opacity: 0.3;
            cursor: not-allowed;
          }
          
          #gsx-minimal-toolbar button#gsx-close {
            margin-left: 8px;
            border-left: 1px solid rgba(255, 255, 255, 0.1);
            padding-left: 12px;
          }
          
          #gsx-minimal-toolbar button#gsx-close:hover {
            background: rgba(255, 59, 48, 0.2);
            color: #ff3b30;
          }
        \`;
        
        document.head.appendChild(style);
        document.body.appendChild(toolbar);
        
        // Add event listeners
        document.getElementById('gsx-back').addEventListener('click', () => {
          window.history.back();
        });
        
        document.getElementById('gsx-forward').addEventListener('click', () => {
          window.history.forward();
        });
        
        document.getElementById('gsx-refresh').addEventListener('click', () => {
          // Clear cache and reload using Electron API
          if (window.electronAPI && window.electronAPI.clearCacheAndReload) {
            window.electronAPI.clearCacheAndReload();
          } else {
            window.location.reload();
          }
        });
        
        document.getElementById('gsx-mission-control').addEventListener('click', () => {
          // This will be handled by IPC
          if (window.electronAPI && window.electronAPI.triggerMissionControl) {
            window.electronAPI.triggerMissionControl();
          }
        });
        
        document.getElementById('gsx-close').addEventListener('click', () => {
          window.close();
        });
        
        // Update button states based on history
        function updateNavigationButtons() {
          const backBtn = document.getElementById('gsx-back');
          const forwardBtn = document.getElementById('gsx-forward');
          
          if (backBtn) backBtn.disabled = !window.history.length || window.history.length <= 1;
          if (forwardBtn) forwardBtn.disabled = false; // Can't easily check forward history
        }
        
        updateNavigationButtons();
        window.addEventListener('popstate', updateNavigationButtons);
      })();
    `).catch(err => console.error('[GSX Window] Error injecting toolbar:', err));
    
    // Inject window keep-alive and zombie detection
    gsxWindow.webContents.executeJavaScript(`
      (function() {
        // Skip if already initialized
        if (window.__gsxKeepAliveInitialized) return;
        window.__gsxKeepAliveInitialized = true;
        
        console.log('[GSX Keep-Alive] Initializing connection monitoring');
        
        let lastPong = Date.now();
        let lastActivity = Date.now();
        let emergencyUIShown = false;
        let pingIntervalId = null;
        let zombieCheckIntervalId = null;
        let pongCleanup = null;
        
        // Track pong responses
        if (window.electronAPI && window.electronAPI.onPong) {
          pongCleanup = window.electronAPI.onPong((data) => {
            lastPong = Date.now();
            console.log('[GSX Keep-Alive] Pong received');
          });
        }
        
        // Wrap electronAPI to track activity (smart keep-alive)
        if (window.electronAPI) {
          const originalAPI = window.electronAPI;
          const activityProxy = new Proxy(originalAPI, {
            get(target, prop) {
              if (typeof target[prop] === 'function' && prop !== 'onPong') {
                return function(...args) {
                  lastActivity = Date.now();
                  return target[prop](...args);
                };
              }
              return target[prop];
            }
          });
          window.electronAPI = activityProxy;
        }
        
        // Backup ping only when idle for 4 minutes
        pingIntervalId = setInterval(() => {
          const idleTime = Date.now() - lastActivity;
          if (idleTime > 240000 && window.electronAPI && window.electronAPI.ping) {
            console.log('[GSX Keep-Alive] Sending idle ping');
            window.electronAPI.ping();
          }
        }, 60000); // Check every minute
        
        // Detect zombie state (no pong for 10 minutes)
        zombieCheckIntervalId = setInterval(() => {
          const timeSinceLastPong = Date.now() - lastPong;
          if (timeSinceLastPong > 600000 && !emergencyUIShown) {
            console.error('[GSX Keep-Alive] Connection lost - window is zombie');
            showEmergencyUI();
            emergencyUIShown = true;
          }
        }, 30000); // Check every 30 seconds
        
        // Cleanup function for window close
        function cleanup() {
          console.log('[GSX Keep-Alive] Cleaning up intervals and listeners');
          if (pingIntervalId) clearInterval(pingIntervalId);
          if (zombieCheckIntervalId) clearInterval(zombieCheckIntervalId);
          if (pongCleanup) pongCleanup();
        }
        
        // Listen for window closing signal from main process
        if (window.electronAPI && window.electronAPI.onPong) {
          // Piggyback on existing IPC infrastructure
          window.addEventListener('beforeunload', cleanup);
        }
        
        // Also listen for explicit close signal
        window.addEventListener('window-closing', cleanup);
        
        // Show emergency UI when connection is dead
        function showEmergencyUI() {
          const emergency = document.createElement('div');
          emergency.id = 'gsx-emergency-banner';
          emergency.innerHTML = \`
            <div style="display: flex; align-items: center; gap: 12px;">
              <span style="font-size: 20px;">⚠️</span>
              <div style="flex: 1;">
                <div style="font-weight: 600; margin-bottom: 4px;">Window Connection Lost</div>
                <div style="font-size: 12px; opacity: 0.9;">Close button may not work. Use Cmd+Q to quit the app.</div>
              </div>
              <button onclick="window.close()" style="
                background: rgba(255,59,48,0.2);
                border: 1px solid #ff3b30;
                color: #ff3b30;
                padding: 8px 16px;
                border-radius: 6px;
                cursor: pointer;
                font-weight: 600;
                font-size: 12px;
              ">Try Close Anyway</button>
            </div>
          \`;
          
          emergency.style.cssText = \`
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            z-index: 9999999;
            background: rgba(255,165,0,0.95);
            color: white;
            padding: 16px 24px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 14px;
            backdrop-filter: blur(10px);
          \`;
          
          document.body.appendChild(emergency);
        }
      })();
    `).catch(err => console.error('[GSX Window] Error injecting keep-alive:', err));
  });
  
  // Also remove on did-stop-loading as a fallback
  gsxWindow.webContents.on('did-stop-loading', () => {
    gsxWindow.webContents.executeJavaScript(`
      document.body.classList.add('gsx-loaded');
    `).catch(err => console.error('[GSX Window] Error hiding loading indicator:', err));
  });
  
  // Load the URL
  gsxWindow.loadURL(url);
  
  // Handle navigation to keep everything in the app window
  gsxWindow.webContents.on('new-window', (event, navUrl) => {
    event.preventDefault();
    // Navigate in the same window for onereach domains
    if (navUrl.includes('onereach.ai')) {
      gsxWindow.loadURL(navUrl);
    } else {
      // Open external URLs in browser
      shell.openExternal(navUrl);
    }
  });
  
  // Show window when ready
  gsxWindow.once('ready-to-show', () => {
    gsxWindow.show();
  });
  
  // Add forced close handler to prevent zombie windows
  let isClosing = false;
  gsxWindow.on('close', (event) => {
    if (isClosing) return; // Already closing, don't interfere
    
    console.log(`[GSX Window] Close requested: ${title}`);
    isClosing = true;
    
    // Prevent default to control the shutdown
    event.preventDefault();
    
    // Try to notify renderer
    try {
      gsxWindow.webContents.send('window-closing');
    } catch (e) {
      console.log(`[GSX Window] Could not send closing signal: ${e.message}`);
    }
    
    // Force destroy after short delay (500ms for state save)
    setTimeout(() => {
      if (!gsxWindow.isDestroyed()) {
        console.log(`[GSX Window] Force destroying: ${title}`);
        gsxWindow.destroy();
      }
    }, 500);
  });
  
  // Register for tracking
  registerGSXWindow(gsxWindow, title);
  
  return gsxWindow;
}

/**
 * Helper function to open learning content in an app window
 * @param {string} url The URL to load
 * @param {string} title The window title
 * @returns {BrowserWindow} The created window
 */
function openLearningWindow(url, title = 'Agentic University') {
  const getLogger = require('./event-logger');
  const logger = getLogger();
  
  // Log the learning content access
  if (logger && logger.info) {
    logger.info('Learning Content Accessed', {
      action: 'learning_window_open',
      title: title,
      url: url,
      timestamp: new Date().toISOString()
    });
  }
  console.log(`[Menu] User opened learning content: ${title} - ${url}`);
  
  const learningWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: `Agentic University - ${title}`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false,
      webSecurity: true,
      webviewTag: false
    },
    backgroundColor: '#1a1a1a',
    show: false
  });
  
  // Show loading indicator with a unique class
  let loadingIndicatorInserted = false;
  learningWindow.webContents.on('did-start-loading', () => {
    if (!loadingIndicatorInserted) {
      loadingIndicatorInserted = true;
      learningWindow.webContents.insertCSS(`
        body::before {
          content: 'Loading...';
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          font-size: 24px;
          color: #666;
          z-index: 99999;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: rgba(255, 255, 255, 0.95);
          padding: 20px 40px;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        }
        body.learning-loaded::before {
          display: none !important;
        }
      `);
    }
  });
  
  // Remove loading indicator when page finishes loading
  learningWindow.webContents.on('did-finish-load', () => {
    // Add class to hide the loading indicator
    learningWindow.webContents.executeJavaScript(`
      document.body.classList.add('learning-loaded');
    `).catch(err => console.error('[Learning Window] Error hiding loading indicator:', err));
    
    // Apply custom CSS for Wiser Method site (fix dark text on dark bg)
    if (url.includes('wisermethod.com')) {
      learningWindow.webContents.insertCSS(`
        /* Fix text visibility on Wiser Method */
        body, p, span, div, h1, h2, h3, h4, h5, h6, li, a, td, th, label {
          color: #e0e0e0 !important;
        }
        a {
          color: #7eb3ff !important;
        }
        a:hover {
          color: #aaccff !important;
        }
        /* Keep buttons and specific elements readable */
        button, input, select, textarea {
          color: #333 !important;
          background-color: #fff !important;
        }
        /* Ensure headings stand out */
        h1, h2, h3 {
          color: #ffffff !important;
        }
      `).catch(err => console.error('[Learning Window] Error injecting Wiser Method CSS:', err));
    }
  });
  
  // Also remove on did-stop-loading as a fallback
  learningWindow.webContents.on('did-stop-loading', () => {
    learningWindow.webContents.executeJavaScript(`
      document.body.classList.add('learning-loaded');
    `).catch(err => console.error('[Learning Window] Error hiding loading indicator:', err));
  });
  
  // Load the URL
  learningWindow.loadURL(url);
  
  // Handle navigation to keep everything in the app window
  learningWindow.webContents.on('new-window', (event, navUrl) => {
    event.preventDefault();
    // If it's a learning.staging.onereach.ai URL, navigate in the same window
    if (navUrl.includes('learning.staging.onereach.ai') || navUrl.includes('learning.onereach.ai')) {
      learningWindow.loadURL(navUrl);
    } else {
      // Otherwise open in external browser
      shell.openExternal(navUrl);
    }
  });
  
  // Handle will-navigate for links
  learningWindow.webContents.on('will-navigate', (event, navUrl) => {
    // Allow navigation within the learning domain
    if (!navUrl.includes('learning.staging.onereach.ai') && !navUrl.includes('learning.onereach.ai')) {
      event.preventDefault();
      shell.openExternal(navUrl);
    }
  });
  
  // Show window when ready
  learningWindow.once('ready-to-show', () => {
    learningWindow.show();
  });
  
  // Log window creation
  console.log(`[Menu] Created learning window for: ${title}`);
  
  return learningWindow;
}

/**
 * Creates and returns the application menu
 * @param {boolean} showTestMenu Whether to show the test menu
 * @param {Array} idwEnvironments Array of IDW environments to create menu items for
 * @returns {Menu} The application menu
 */
function createMenu(showTestMenu = false, idwEnvironments = []) {
  console.log('[Menu] Creating application menu...');
  const isMac = process.platform === 'darwin';
  const startTime = Date.now();
  
  // PERFORMANCE: Use cached menu data instead of reading files every time
  const cachedData = menuCache.loadAll();
  
  // Use passed IDW environments or fall back to cache
  if (!idwEnvironments || !idwEnvironments.length) {
    idwEnvironments = cachedData.idwEnvironments;
    console.log(`[Menu] Using cached IDW environments: ${idwEnvironments.length} items`);
  }
  
  // Use cached data for other menu items
  let allGsxLinks = cachedData.gsxLinks;
  let externalBots = cachedData.externalBots;
  let imageCreators = cachedData.imageCreators;
  let videoCreators = cachedData.videoCreators;
  let audioGenerators = cachedData.audioGenerators;
  let uiDesignTools = cachedData.uiDesignTools;
  
  // Generate default GSX links if none exist
  if (allGsxLinks.length === 0 && idwEnvironments.length > 0) {
    console.log('[Menu] No GSX links found, generating defaults');
    const gsxAccountId = cachedData.userPrefs.gsxAccountId || '';
    allGsxLinks = generateDefaultGSXLinks(idwEnvironments, gsxAccountId);
    
    // Save generated links
    if (allGsxLinks.length) {
      try {
        const electronApp = require('electron').app;
        const userDataPath = electronApp.getPath('userData');
        const gsxConfigPath = path.join(userDataPath, 'gsx-links.json');
        fs.writeFileSync(gsxConfigPath, JSON.stringify(allGsxLinks, null, 2));
        console.log(`[Menu] Wrote ${allGsxLinks.length} default GSX links`);
        menuCache.gsxLinks = allGsxLinks;
      } catch (err) {
        console.error('[Menu] Failed to write default GSX links:', err);
      }
    }
  }
  
  console.log(`[Menu] Data loading took ${Date.now() - startTime}ms`);

  // --- Menu Item Creation ---
  const idwMenuItems = [];
  const gsxMenuItems = [];
  
  // Get userDataPath for any needed operations
  const electronApp = require('electron').app;
  const userDataPath = electronApp.getPath('userData');
  
  console.log('[Menu] Processing IDW environments to create menu items...');
  if (idwEnvironments && idwEnvironments.length > 0) {
    idwEnvironments.forEach((env, index) => {
      console.log(`[Menu] Processing IDW Env ${index + 1}: Label='${env.label}', URL='${env.chatUrl}', Environment='${env.environment}'`);
      if (!env.label || !env.chatUrl || !env.environment) {
        console.warn(`[Menu] Skipping IDW Env ${index + 1} due to missing properties.`);
        return; // Skip this environment if essential properties are missing
      }

      // --- IDW Menu Item ---
      // Add keyboard shortcuts for the first 9 IDWs (Cmd+1 through Cmd+9)
      const accelerator = index < 9 ? `CmdOrCtrl+${index + 1}` : undefined;
      
      idwMenuItems.push({
        label: env.label,
        accelerator: accelerator,
        click: (menuItem, browserWindow) => {
          // Log that we're handling the IDW environment click
          console.log(`[Menu Click] IDW menu item clicked: ${env.label}`);
          
          if (browserWindow) {
            console.log(`[Menu Click] Opening IDW environment chat in main window: ${env.chatUrl}`);
            
            // Emit the action directly in the main process
            ipcMain.emit('menu-action', null, {
              action: 'open-idw-url',
              url: env.chatUrl,
              label: env.label
            });
          } else {
            // If no browser window, try using shell to open the URL
            console.log(`[Menu Click] Opening IDW environment chat in external browser: ${env.chatUrl}`);
            
            // Validate and clean the URL before opening
            let urlToOpen = env.chatUrl;
            if (urlToOpen && typeof urlToOpen === 'string') {
              // Remove any leading invalid characters
              urlToOpen = urlToOpen.trim();
              // If URL doesn't start with http:// or https://, fix it
              if (!urlToOpen.startsWith('http://') && !urlToOpen.startsWith('https://')) {
                // Remove any invalid prefix before https
                const httpsIndex = urlToOpen.indexOf('https://');
                const httpIndex = urlToOpen.indexOf('http://');
                if (httpsIndex > 0) {
                  urlToOpen = urlToOpen.substring(httpsIndex);
                } else if (httpIndex > 0) {
                  urlToOpen = urlToOpen.substring(httpIndex);
                }
              }
              console.log(`[Menu Click] Cleaned URL: ${urlToOpen}`);
              
              const { shell } = require('electron');
              shell.openExternal(urlToOpen);
            } else {
              console.error(`[Menu Click] Invalid URL: ${env.chatUrl}`);
            }
          }
        }
      });

      // --- GSX Submenu Item ---
      const gsxSubmenu = [];
      console.log(`[Menu] Filtering GSX links for environment: '${env.environment}'`);
      
      // Filter GSX links for this environment
      const gsxLinks = allGsxLinks.filter(link => {
        if (!link.url || !link.label) {
            console.warn(`[Menu] Skipping GSX link due to missing properties:`, link);
            return false;
        }
        
        // CRITICAL: Special handling for custom links - MUST match exactly the IDW ID
        if (link.custom === true) {
          // Debug detailed link information for custom links
          console.log(`[Menu] Evaluating custom link: ID=${link.id}, Label=${link.label}`);
          console.log(`[Menu] Custom link properties: idwId=${link.idwId || 'none'}, env.id=${env.id || 'none'}`);
          
          // This is the critical check - custom links MUST have a matching idwId
          // If link has no idwId, it cannot appear in ANY menu
          if (!link.idwId) {
            console.log(`[Menu] Custom link ${link.id} has no idwId, excluding from all menus`);
            return false;
          }
          
          // Make sure both env.id and link.idwId exist before comparison
          if (!env.id) {
            console.log(`[Menu] Environment ${env.label} has no id, cannot match custom links`);
            return false;
          }
          
          // Convert both to strings for comparison to ensure proper matching
          const linkIdwId = String(link.idwId).trim();
          const envId = String(env.id).trim();
          
          // Strict equality check between link's idwId and environment id
          const idMatch = linkIdwId === envId;
          console.log(`[Menu] Custom link IDW match check: '${linkIdwId}' === '${envId}' = ${idMatch}`);
          
          // Add fallback for legacy links before returning
          if (!idMatch && link.environment && env.environment && 
              link.environment.toLowerCase() === env.environment.toLowerCase()) {
            console.log(`[Menu] Custom link ${link.id} matches environment name as fallback: ${link.environment}`);
            return true;
          }
          
          return idMatch;
        }
        
        // For standard links, use environment + idwId matching to avoid duplicates
        if (link.environment && env.environment &&
            link.environment.toLowerCase() === env.environment.toLowerCase()) {
          // If link has idwId, it MUST match the env.id exactly
          // If link has no idwId, it's a legacy link that can match by environment only
          if (link.idwId) {
            // Link has idwId - strict matching required
            if (env.id && link.idwId === env.id) {
              console.log(`[Menu] Standard link matches by idwId: ${link.label} (env=${link.environment}, idwId=${link.idwId})`);
              return true;
            } else {
              // Link has idwId but it doesn't match this IDW - skip it
              return false;
            }
          } else {
            // Legacy link without idwId - allow environment-only match
            console.log(`[Menu] Legacy link matches by environment only: ${link.label} (env=${link.environment})`);
            return true;
          }
        }
        
        // URL-based matching should only apply to links WITHOUT idwId (legacy links)
        // If a link has idwId, it should have already matched above or been rejected
        if (link.idwId) {
          // Link has idwId but didn't match above - don't try URL matching
          return false;
        }
        
        try {
            const url = new URL(link.url);
            // More flexible matching to handle different environment naming patterns
            let match = false;
            
            // Direct environment name matching in hostname
            if (env.environment && url.hostname.includes(env.environment)) {
                console.log(`[Menu] GSX link URL hostname includes environment: hostname='${url.hostname}', env='${env.environment}'`);
                match = true;
            }
            
            // Also check if no specific environment in the URL (generic GSX links)
            // This helps with links like 'https://hitl.onereach.ai/' without environment
            if (!match && !url.hostname.includes('staging.') && 
                !url.hostname.includes('edison.') && 
                !url.hostname.includes('production.')) {
                console.log(`[Menu] GSX URL '${url.hostname}' has no environment prefix, including it for all environments`);
                match = true;
            }
            
            console.log(`[Menu] Checking GSX link: URL='${link.url}', Host='${url.hostname}', Matches Env='${env.environment}'? ${match}`);
            return match;
        } catch (e) {
            console.warn(`[Menu] Skipping GSX link due to invalid URL '${link.url}':`, e);
            return false;
        }
      });
      console.log(`[Menu] Found ${gsxLinks.length} matching GSX links for '${env.label}'`);

      // Add GSX links as submenu items
      if (gsxLinks && gsxLinks.length > 0) {
        gsxLinks.forEach((link, linkIndex) => {
           console.log(`[Menu] Adding GSX submenu item ${linkIndex + 1}: Label='${link.label}', URL='${link.url}'`);
          gsxSubmenu.push({
            label: link.label,
            click: async () => {
              console.log(`[Menu Click] GSX menu item clicked: ${link.label} (URL: ${link.url}, Env: ${env.environment})`);
              try {
                // Open GSX in a large window using helper function
                openGSXLargeWindow(
                  link.url,
                  link.label,
                  `${link.label} - ${env.label}`,
                  `Loading ${link.label}...`,
                  env.environment  // Pass the IDW environment for session isolation
                );
                console.log('[Menu Click] GSX window created successfully.');
              } catch (error) {
                console.error('[Menu Click] Failed to open GSX URL:', error);
                // Show error dialog
                const { dialog } = require('electron');
                dialog.showErrorBox(
                  'Error Opening GSX',
                  `Failed to open ${link.label}. Please ensure you are logged in to your IDW environment and try again.\n\nError: ${error.message}`
                );
              }
            }
          });
        });
      } else {
        console.log(`[Menu] No matching GSX links found for '${env.label}', adding 'No links' item.`);
        gsxSubmenu.push({
          label: 'No GSX links available',
          enabled: false
        });
      }

      // Add this IDW's GSX submenu to the main GSX menu
      gsxMenuItems.push({
        label: env.label,
        submenu: gsxSubmenu
      });
    });
    
    // Add a separator in IDW menu
    if (idwMenuItems.length > 0) {
      idwMenuItems.push({ type: 'separator' });
    }
  } else {
    console.log('[Menu] No valid IDW environments found or loaded.');
  }
  
  // Add Explore IDW Store menu item
  idwMenuItems.push({
    label: '🔍 Explore IDW Store',
    click: () => {
      const { BrowserWindow } = require('electron');
      const path = require('path');
      
      console.log('[Menu] Opening IDW Store...');
      
      // Create the IDW Store window
      const storeWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, 'preload.js'),
          webSecurity: true,
          sandbox: false
        },
        title: 'Explore IDW Store',
        backgroundColor: '#000000',
        show: false
      });
      
      storeWindow.loadFile('idw-store.html');
      
      storeWindow.once('ready-to-show', () => {
        storeWindow.show();
      });
      
      console.log('[Menu] IDW Store window created');
    }
  });
  
  // Add separator
  idwMenuItems.push({ type: 'separator' });
  
  // Add the Add/Remove menu item to IDW menu
  idwMenuItems.push({
    label: 'Add/Remove',
    accelerator: 'CmdOrCtrl+A',
    click: () => {
      // Call openSetupWizard via the global function
      console.log('[Menu Click] Add/Remove clicked, calling global.openSetupWizardGlobal');
      if (typeof global.openSetupWizardGlobal === 'function') {
        global.openSetupWizardGlobal();
      } else {
        console.error('[Menu Click] openSetupWizardGlobal function not found in global scope');
      }
    }
  });

  // Add external bots to IDW menu if any exist
  if (externalBots && externalBots.length > 0) {
    console.log(`[Menu] Adding ${externalBots.length} external bots to IDW menu`);
    
    // Add separator before external bots
    idwMenuItems.push({ type: 'separator' });
    
    // Add a label for the external bots section
    idwMenuItems.push({
      label: 'External Bots',
      enabled: false
    });
    
    // Add each external bot to IDW menu
    externalBots.forEach((bot, botIndex) => {
      console.log(`[Menu] Adding external bot to IDW menu: ${bot.name} (${bot.chatUrl})`);
      
      // Add keyboard shortcuts for the first 4 external bots (Alt+1 through Alt+4)
      const botAccelerator = botIndex < 4 ? `Alt+${botIndex + 1}` : undefined;
      
      idwMenuItems.push({
        label: bot.name,
        accelerator: botAccelerator,
        click: async () => {
          console.log(`[Menu Click] Opening external bot in tab: ${bot.name} at ${bot.chatUrl}`);
          
          // Send message to main process to open in a new tab
          
          
          // Emit the action directly in the main process
          ipcMain.emit('menu-action', null, {
            action: 'open-external-bot',
            url: bot.chatUrl,
            label: bot.name,
            isExternal: true
          });
        }
      });
    });
  }

  // Add image creators to IDW menu if any exist
  if (imageCreators && imageCreators.length > 0) {
    console.log(`[Menu] Adding ${imageCreators.length} image creators to IDW menu`);
    
    // Add separator before image creators
    idwMenuItems.push({ type: 'separator' });
    
    // Add a label for the image creators section
    idwMenuItems.push({
      label: 'Image Creators',
      enabled: false
    });
    
    // Add each image creator to IDW menu
    imageCreators.forEach((creator, creatorIndex) => {
      console.log(`[Menu] Adding image creator to IDW menu: ${creator.name} (${creator.url})`);
      
      // Add keyboard shortcuts for the first 4 image creators (Shift+Cmd/Ctrl+1 through 4)
      const creatorAccelerator = creatorIndex < 4 ? `Shift+CmdOrCtrl+${creatorIndex + 1}` : undefined;
      
      idwMenuItems.push({
        label: creator.name,  // Removed emoji
        accelerator: creatorAccelerator,
        click: async () => {
          console.log(`[Menu Click] Opening image creator in tab: ${creator.name} at ${creator.url}`);
          
          // Send message to main process to open in a new tab
          
          
          // Emit the action directly in the main process
          ipcMain.emit('menu-action', null, {
            action: 'open-image-creator',
            url: creator.url,
            label: creator.name,
            isImageCreator: true
          });
        }
      });
    });
  }

  // Add video creators to IDW menu if any exist
  if (videoCreators && videoCreators.length > 0) {
    console.log(`[Menu] Adding ${videoCreators.length} video creators to IDW menu`);
    
    // Add separator before video creators
    idwMenuItems.push({ type: 'separator' });
    
    // Add a label for the video creators section
    idwMenuItems.push({
      label: 'Video Creators',
      enabled: false
    });
    
    // Add each video creator to IDW menu
    videoCreators.forEach(creator => {
      console.log(`[Menu] Adding video creator to IDW menu: ${creator.name} (${creator.url})`);
      
      idwMenuItems.push({
        label: creator.name,
        click: async () => {
          console.log(`[Menu Click] Opening video creator in tab: ${creator.name} at ${creator.url}`);
          
          // Send message to main process to open in a new tab
          
          
          // Emit the action directly in the main process
          ipcMain.emit('menu-action', null, {
            action: 'open-video-creator',
            url: creator.url,
            label: creator.name,
            isVideoCreator: true
          });
        }
      });
    });
  }

  // Add audio generators to IDW menu if any exist
  if (audioGenerators && audioGenerators.length > 0) {
    console.log(`[Menu] Adding ${audioGenerators.length} audio generators to IDW menu`);
    
    // Add separator before audio generators
    idwMenuItems.push({ type: 'separator' });
    
    // Add a label for the audio generators section
    idwMenuItems.push({
      label: 'Audio Generators',
      enabled: false
    });
    
    // Group audio generators by category
    const audioByCategory = {
      music: [],
      effects: [],
      narration: [],
      custom: []
    };
    
    audioGenerators.forEach(generator => {
      const category = generator.category || 'custom';
      if (audioByCategory[category]) {
        audioByCategory[category].push(generator);
      } else {
        audioByCategory.custom.push(generator);
      }
    });
    
    // Add music generators
    if (audioByCategory.music.length > 0) {
      idwMenuItems.push({
        label: '🎵 Music',
        submenu: audioByCategory.music.map(generator => ({
          label: generator.name,
          click: async () => {
            console.log(`[Menu Click] Opening audio generator in tab: ${generator.name} at ${generator.url}`);
            
            
            ipcMain.emit('menu-action', null, {
              action: 'open-audio-generator',
              url: generator.url,
              label: generator.name,
              isAudioGenerator: true,
              category: 'music'
            });
          }
        }))
      });
    }
    
    // Add sound effects generators
    if (audioByCategory.effects.length > 0) {
      idwMenuItems.push({
        label: '🔊 Sound Effects',
        submenu: audioByCategory.effects.map(generator => ({
          label: generator.name,
          click: async () => {
            console.log(`[Menu Click] Opening audio generator in tab: ${generator.name} at ${generator.url}`);
            
            
            ipcMain.emit('menu-action', null, {
              action: 'open-audio-generator',
              url: generator.url,
              label: generator.name,
              isAudioGenerator: true,
              category: 'effects'
            });
          }
        }))
      });
    }
    
    // Add narration generators
    if (audioByCategory.narration.length > 0) {
      idwMenuItems.push({
        label: '🎙️ Narration & Voice',
        submenu: audioByCategory.narration.map(generator => ({
          label: generator.name,
          click: async () => {
            console.log(`[Menu Click] Opening audio generator in tab: ${generator.name} at ${generator.url}`);
            
            
            ipcMain.emit('menu-action', null, {
              action: 'open-audio-generator',
              url: generator.url,
              label: generator.name,
              isAudioGenerator: true,
              category: 'narration'
            });
          }
        }))
      });
    }
    
    // Add custom generators
    if (audioByCategory.custom.length > 0) {
      idwMenuItems.push({
        label: '⚙️ Custom',
        submenu: audioByCategory.custom.map(generator => ({
          label: generator.name,
          click: async () => {
            console.log(`[Menu Click] Opening audio generator in tab: ${generator.name} at ${generator.url}`);
            
            
            ipcMain.emit('menu-action', null, {
              action: 'open-audio-generator',
              url: generator.url,
              label: generator.name,
              isAudioGenerator: true,
              category: 'custom'
            });
          }
        }))
      });
    }
  }

  // === NEW: Add UI Design tools to IDW menu ===
  if (uiDesignTools && uiDesignTools.length > 0) {
    console.log(`[Menu] Adding ${uiDesignTools.length} UI design tools to IDW menu`);

    // Separator before this section
    idwMenuItems.push({ type: 'separator' });
    idwMenuItems.push({ label: 'UI Design Tools', enabled: false });

    uiDesignTools.forEach(tool => {
      idwMenuItems.push({
        label: tool.name,
        click: () => {
          
          console.log(`[Menu Click] Opening UI design tool: ${tool.name} -> ${tool.url}`);
          ipcMain.emit('menu-action', null, {
            action: 'open-ui-design-tool',
            url: tool.url,
            label: tool.name,
            isUIDesignTool: true
          });
        }
      });
    });
  }

  // If no IDW environments, show a disabled message in GSX menu
  if (gsxMenuItems.length === 0) {
    console.log('[Menu] No IDW environments configured, adding disabled item to GSX menu.');
    gsxMenuItems.push({
      label: 'No IDW environments available',
      enabled: false
    });
  }
  
  // Add external bot API docs to GSX menu if any exist
  if (externalBots && externalBots.length > 0) {
    const externalBotsWithAPIs = externalBots.filter(bot => bot.apiUrl);
    
    if (externalBotsWithAPIs.length > 0) {
      console.log(`[Menu] Processing ${externalBotsWithAPIs.length} external bot API docs for GSX menu`);
      
      // Add separator if there are IDW items
      if (gsxMenuItems.length > 0 && gsxMenuItems[0].label !== 'No IDW environments available') {
        gsxMenuItems.push({ type: 'separator' });
        console.log('[Menu] Added separator before external bot APIs');
      }
      
      // Create external bot APIs submenu
      const externalBotAPIsMenu = [];
      
      externalBotsWithAPIs.forEach(bot => {
        console.log(`[Menu] Adding API docs for ${bot.name}: ${bot.apiUrl}`);
        
        externalBotAPIsMenu.push({
          label: `${bot.name} API`,
          click: async () => {
            console.log(`[Menu Click] Opening API docs for ${bot.name} at ${bot.apiUrl}`);
            openGSXLargeWindow(
              bot.apiUrl,
              `${bot.name} API`,
              `${bot.name} API Documentation`,
              `Loading ${bot.name} API documentation...`
            );
          }
        });
      });
      
      console.log(`[Menu] Created external bot APIs submenu with ${externalBotAPIsMenu.length} items`);
      
      // Add the external bot APIs submenu
      gsxMenuItems.push({
        label: 'External Bot APIs',
        submenu: externalBotAPIsMenu
      });
      
      console.log('[Menu] Added external bot APIs submenu to GSX menu');
    }
  }
  
  // Add image creator API docs to GSX menu if any exist
  if (imageCreators && imageCreators.length > 0) {
    const imageCreatorsWithAPIs = imageCreators.filter(creator => creator.apiUrl);
    
    if (imageCreatorsWithAPIs.length > 0) {
      console.log(`[Menu] Processing ${imageCreatorsWithAPIs.length} image creator API docs for GSX menu`);
      
      // Add separator if there are items and we haven't added one for external bots
      if (gsxMenuItems.length > 0 && gsxMenuItems[0].label !== 'No IDW environments available' &&
          !(externalBots && externalBots.filter(bot => bot.apiUrl).length > 0)) {
        gsxMenuItems.push({ type: 'separator' });
        console.log('[Menu] Added separator before image creator APIs');
      }
      
      // Create image creator APIs submenu
      const imageCreatorAPIsMenu = [];
      
      imageCreatorsWithAPIs.forEach(creator => {
        console.log(`[Menu] Adding API docs for ${creator.name}: ${creator.apiUrl}`);
        
        imageCreatorAPIsMenu.push({
          label: `${creator.name} API`,
          click: async () => {
            console.log(`[Menu Click] Opening API docs for ${creator.name} at ${creator.apiUrl}`);
            openGSXLargeWindow(
              creator.apiUrl,
              `${creator.name} API`,
              `${creator.name} API Documentation`,
              `Loading ${creator.name} API documentation...`
            );
          }
        });
      });
      
      console.log(`[Menu] Created image creator APIs submenu with ${imageCreatorAPIsMenu.length} items`);
      
      // Add the image creator APIs submenu
      gsxMenuItems.push({
        label: 'Image Creator APIs',
        submenu: imageCreatorAPIsMenu
      });
      
      console.log('[Menu] Added image creator APIs submenu to GSX menu');
    }
  }
  
  // Add video creator API docs to GSX menu if any exist
  if (videoCreators && videoCreators.length > 0) {
    const videoCreatorsWithAPIs = videoCreators.filter(creator => creator.apiUrl);
    
    if (videoCreatorsWithAPIs.length > 0) {
      console.log(`[Menu] Processing ${videoCreatorsWithAPIs.length} video creator API docs for GSX menu`);
      
      // Add separator if there are items and we haven't added one for external bots or image creators
      if (gsxMenuItems.length > 0 && gsxMenuItems[0].label !== 'No IDW environments available' &&
          !(externalBots && externalBots.filter(bot => bot.apiUrl).length > 0) &&
          !(imageCreators && imageCreators.filter(creator => creator.apiUrl).length > 0)) {
        gsxMenuItems.push({ type: 'separator' });
        console.log('[Menu] Added separator before video creator APIs');
      }
      
      // Create video creator APIs submenu
      const videoCreatorAPIsMenu = [];
      
      videoCreatorsWithAPIs.forEach(creator => {
        console.log(`[Menu] Adding API docs for ${creator.name}: ${creator.apiUrl}`);
        
        videoCreatorAPIsMenu.push({
          label: `${creator.name} API`,
          click: async () => {
            console.log(`[Menu Click] Opening API docs for ${creator.name} at ${creator.apiUrl}`);
            openGSXLargeWindow(
              creator.apiUrl,
              `${creator.name} API`,
              `${creator.name} API Documentation`,
              `Loading ${creator.name} API documentation...`
            );
          }
        });
      });
      
      console.log(`[Menu] Created video creator APIs submenu with ${videoCreatorAPIsMenu.length} items`);
      
      // Add the video creator APIs submenu
      gsxMenuItems.push({
        label: 'Video Creator APIs',
        submenu: videoCreatorAPIsMenu
      });
      
      console.log('[Menu] Added video creator APIs submenu to GSX menu');
    }
  }
  
  // Add audio generator API docs to GSX menu if any exist
  if (audioGenerators && audioGenerators.length > 0) {
    const audioGeneratorsWithAPIs = audioGenerators.filter(generator => generator.apiUrl);
    
    if (audioGeneratorsWithAPIs.length > 0) {
      console.log(`[Menu] Processing ${audioGeneratorsWithAPIs.length} audio generator API docs for GSX menu`);
      
      // Add separator if there are items and we haven't added one for other APIs
      if (gsxMenuItems.length > 0 && gsxMenuItems[0].label !== 'No IDW environments available' &&
          !(externalBots && externalBots.filter(bot => bot.apiUrl).length > 0) &&
          !(imageCreators && imageCreators.filter(creator => creator.apiUrl).length > 0) &&
          !(videoCreators && videoCreators.filter(creator => creator.apiUrl).length > 0)) {
        gsxMenuItems.push({ type: 'separator' });
        console.log('[Menu] Added separator before audio generator APIs');
      }
      
      // Create audio generator APIs submenu
      const audioGeneratorAPIsMenu = [];
      
      audioGeneratorsWithAPIs.forEach(generator => {
        console.log(`[Menu] Adding API docs for ${generator.name}: ${generator.apiUrl}`);
        
        audioGeneratorAPIsMenu.push({
          label: `${generator.name} API`,
          click: async () => {
            console.log(`[Menu Click] Opening API docs for ${generator.name} at ${generator.apiUrl}`);
            openGSXLargeWindow(
              generator.apiUrl,
              `${generator.name} API`,
              `${generator.name} API Documentation`,
              `Loading ${generator.name} API documentation...`
            );
          }
        });
      });
      
      console.log(`[Menu] Created audio generator APIs submenu with ${audioGeneratorAPIsMenu.length} items`);
      
      // Add the audio generator APIs submenu
      gsxMenuItems.push({
        label: 'Audio Generator APIs',
        submenu: audioGeneratorAPIsMenu
      });
      
      console.log('[Menu] Added audio generator APIs submenu to GSX menu');
    }
  }
  
  // === NEW: Add UI Design tool API docs ===
  if (uiDesignTools && uiDesignTools.length > 0) {
    const toolsWithAPIs = uiDesignTools.filter(t => t.apiUrl);
    if (toolsWithAPIs.length) {
      console.log(`[Menu] Adding ${toolsWithAPIs.length} UI design tool API docs to GSX menu`);
      if (gsxMenuItems.length && gsxMenuItems[gsxMenuItems.length - 1].type !== 'separator') {
        gsxMenuItems.push({ type: 'separator' });
      }
      gsxMenuItems.push({
        label: 'UI Design Tool APIs',
        submenu: toolsWithAPIs.map(t => ({
          label: `${t.name} API`,
          click: () => shell.openExternal(t.apiUrl)
        }))
      });
    }
  }
  
  // Add GSX File Sync menu items
  if (gsxMenuItems.length > 0 && gsxMenuItems[0].label !== 'No IDW environments available') {
    gsxMenuItems.push({ type: 'separator' });
  }
  
  gsxMenuItems.push({
    label: 'File Sync',
    submenu: [
      {
        label: 'Complete Backup (Recommended)',
        click: async () => {
          console.log('[Menu] Complete Backup clicked');
          const { getGSXFileSync } = require('./gsx-file-sync');
          const gsxFileSync = getGSXFileSync();
          const { dialog } = require('electron');
          
          // Show progress notification
          const { Notification } = require('electron');
          const notification = new Notification({
            title: 'GSX Backup',
            body: 'Starting complete backup...'
          });
          notification.show();
          
          try {
            console.log('[Menu] Calling syncCompleteBackup...');
            const result = await gsxFileSync.syncCompleteBackup();
            console.log('[Menu] Backup result:', JSON.stringify(result, null, 2));
            
            // Check if result has the expected structure
            if (!result || !result.summary) {
              console.error('[Menu] Result missing summary:', result);
              throw new Error('Backup completed but result format is unexpected');
            }
            
            // Build detailed report
            let reportDetails = `✅ Backup completed in ${result.summary.durationFormatted || '0s'}\n\n`;
            reportDetails += `📊 Summary:\n`;
            reportDetails += `• Total Files: ${result.summary.totalFiles || 0}\n`;
            reportDetails += `• Total Size: ${result.summary.totalSizeFormatted || '0 Bytes'}\n`;
            reportDetails += `• Environment: ${result.summary.environment || 'unknown'}\n`;
            reportDetails += `• Timestamp: ${result.timestamp || new Date().toISOString()}\n\n`;
            reportDetails += `📁 What was backed up:\n\n`;
            
            if (result.results && result.results.length > 0) {
              result.results.forEach(r => {
                reportDetails += `${r.name || 'Unknown'}:\n`;
                reportDetails += `  • Files: ${r.fileCount || 0}\n`;
                reportDetails += `  • Size: ${r.totalSizeFormatted || '0 Bytes'}\n`;
                reportDetails += `  • Duration: ${r.durationFormatted || '0s'}\n`;
                reportDetails += `  • Location: GSX Files/${r.remotePath || 'unknown'}\n\n`;
              });
            } else {
              reportDetails += `(Details not available)\n\n`;
            }
            
            reportDetails += `🌐 Access your files at:\n`;
            const envPrefix = result.summary.environment && result.summary.environment !== 'production' 
              ? result.summary.environment + '.' 
              : '';
            reportDetails += `https://studio.${envPrefix}onereach.ai/files`;
            
            console.log('[Menu] Showing success dialog...');
            
            dialog.showMessageBox({
              type: 'info',
              title: '✅ Complete Backup Successful',
              message: 'All your data has been backed up to GSX Files',
              detail: reportDetails,
              buttons: ['OK']
            });
            
            console.log('[Menu] Dialog shown, showing notification...');
            
            // Show success notification
            const successNotification = new Notification({
              title: '✅ Backup Complete',
              body: `Backed up ${result.summary.totalFiles || 0} files (${result.summary.totalSizeFormatted || '0 Bytes'})`
            });
            successNotification.show();
            
            console.log('[Menu] Notification shown');
            
          } catch (error) {
            console.error('[Menu] Backup error:', error);
            console.error('[Menu] Error details:', error.stack);
            dialog.showErrorBox('Backup Failed', error.message);
            
            // Show error notification
            const errorNotification = new Notification({
              title: '❌ Backup Failed',
              body: error.message
            });
            errorNotification.show();
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Sync Desktop to GSX',
        click: async () => {
          console.log('[Menu] Sync Desktop to GSX clicked');
          const { getGSXFileSync } = require('./gsx-file-sync');
          const gsxFileSync = getGSXFileSync();
          const { BrowserWindow } = require('electron');
          
          // Create progress window
          const progressWindow = new BrowserWindow({
            width: 500,
            height: 600,
            title: 'GSX Sync Progress',
            webPreferences: {
              nodeIntegration: true,
              contextIsolation: false
            },
            resizable: false,
            minimizable: false,
            maximizable: false,
            alwaysOnTop: true,
            backgroundColor: '#667eea'
          });
          
          progressWindow.loadFile('gsx-sync-progress.html');
          
          // Send initial reset message to clear any previous state
          progressWindow.webContents.once('did-finish-load', () => {
            progressWindow.webContents.send('sync-progress', {
              type: 'reset',
              source: 'desktop'
            });
          });
          
          // Set up progress callback
          const progressCallback = (data) => {
            progressWindow.webContents.send('sync-progress', { ...data, source: 'desktop' });
          };
          
          try {
            const desktopPath = path.join(require('os').homedir(), 'Desktop');
            const result = await gsxFileSync.syncDirectory(desktopPath, 'Desktop-Backup', {
              progressCallback
            });
            
            progressCallback({
              type: 'complete',
              message: 'Sync complete!',
              result
            });
          } catch (error) {
            progressCallback({
              type: 'error',
              message: 'Sync failed',
              error: error.message
            });
          }
        }
      },
      {
        label: 'Sync OR-Spaces (Clipboard Data)',
        click: async () => {
          console.log('[Menu] Sync OR-Spaces to GSX clicked');
          const { getGSXFileSync } = require('./gsx-file-sync');
          const gsxFileSync = getGSXFileSync();
          const { BrowserWindow, app } = require('electron');
          
          // Create progress window
          const progressWindow = new BrowserWindow({
            width: 500,
            height: 600,
            title: 'GSX Sync Progress - OR-Spaces',
            webPreferences: {
              nodeIntegration: true,
              contextIsolation: false
            },
            resizable: false,
            minimizable: false,
            maximizable: false,
            alwaysOnTop: true,
            backgroundColor: '#667eea'
          });
          
          progressWindow.loadFile('gsx-sync-progress.html');
          
          // Send initial reset message to clear any previous state
          progressWindow.webContents.once('did-finish-load', () => {
            progressWindow.webContents.send('sync-progress', {
              type: 'reset',
              source: 'or-spaces'
            });
          });
          
          // Set up progress callback
          const progressCallback = (data) => {
            progressWindow.webContents.send('sync-progress', { ...data, source: 'or-spaces' });
          };
          
          try {
            console.log('[Menu] About to call syncORSpaces method');
            // Use the syncORSpaces method which properly handles the OR-Spaces directory
            const result = await gsxFileSync.syncORSpaces({
              progressCallback,
              remotePath: 'OR-Spaces-Backup'
            });
            console.log('[Menu] syncORSpaces returned:', result);
            
            progressCallback({
              type: 'complete',
              message: 'OR-Spaces sync complete!',
              result
            });
          } catch (error) {
            progressCallback({
              type: 'error',
              message: 'Sync failed',
              error: error.message
            });
          }
        }
      },
      {
        label: 'Sync App Config (Settings & Logs)',
        click: async () => {
          console.log('[Menu] Sync App Config clicked');
          const { getGSXFileSync } = require('./gsx-file-sync');
          const gsxFileSync = getGSXFileSync();
          const { dialog } = require('electron');
          
          try {
            const result = await gsxFileSync.syncAppConfig();
            
            const reportDetails = `✅ Sync completed in ${result.durationFormatted}\n\n` +
              `📊 Details:\n` +
              `• Files synced: ${result.fileCount || 0}\n` +
              `• Total size: ${result.totalSizeFormatted || '0 Bytes'}\n` +
              `• Source: ${result.localPath}\n` +
              `• Destination: GSX Files/${result.remotePath}\n\n` +
              `📁 Includes:\n` +
              `• App settings & preferences\n` +
              `• IDW environment configs\n` +
              `• GSX links & shortcuts\n` +
              `• Reading logs\n` +
              `• Clipboard configurations`;
            
            dialog.showMessageBox({
              type: 'info',
              title: '✅ App Config Sync Complete',
              message: 'App configuration synced successfully',
              detail: reportDetails
            });
          } catch (error) {
            dialog.showErrorBox('Sync Failed', error.message);
          }
        }
      },
      {
        label: 'Sync Custom Directory...',
        click: async () => {
          console.log('[Menu] Sync Custom Directory clicked');
          const { getGSXFileSync } = require('./gsx-file-sync');
          const gsxFileSync = getGSXFileSync();
          
          try {
            const localPath = await gsxFileSync.selectDirectoryForSync();
            if (localPath) {
              const dirName = path.basename(localPath);
              const result = await gsxFileSync.syncDirectory(localPath, dirName);
              const { dialog } = require('electron');
              dialog.showMessageBox({
                type: 'info',
                title: 'Sync Complete',
                message: 'Directory synced to GSX successfully',
                detail: `Synced ${localPath} to GSX Files/${dirName}`
              });
            }
          } catch (error) {
            const { dialog } = require('electron');
            dialog.showErrorBox('Sync Failed', error.message);
          }
        }
      },
      { type: 'separator' },
      {
        label: 'View Sync History',
        click: async () => {
          console.log('[Menu] View Sync History clicked');
          const { getGSXFileSync } = require('./gsx-file-sync');
          const gsxFileSync = getGSXFileSync();
          const history = gsxFileSync.getHistory();
          
          if (history.length === 0) {
            const { dialog } = require('electron');
            dialog.showMessageBox({
              type: 'info',
              title: 'Sync History',
              message: 'No sync history available',
              detail: 'No files have been synced yet.'
            });
          } else {
            // Show recent sync history
            const recentHistory = history.slice(0, 10);
            const historyText = recentHistory.map(h => 
              `${new Date(h.timestamp).toLocaleString()}: ${h.localPath} → ${h.remotePath} (${h.status})`
            ).join('\n');
            
            const { dialog } = require('electron');
            dialog.showMessageBox({
              type: 'info',
              title: 'Recent Sync History',
              message: 'Last 10 sync operations:',
              detail: historyText
            });
          }
        }
      },
      {
        label: 'Clear Sync History',
        click: async () => {
          console.log('[Menu] Clear Sync History clicked');
          const { dialog } = require('electron');
          const result = await dialog.showMessageBox({
            type: 'question',
            title: 'Clear Sync History',
            message: 'Are you sure you want to clear the sync history?',
            buttons: ['Cancel', 'Clear'],
            defaultId: 0
          });
          
          if (result.response === 1) {
            const { getGSXFileSync } = require('./gsx-file-sync');
            const gsxFileSync = getGSXFileSync();
            await gsxFileSync.clearHistory();
            
            dialog.showMessageBox({
              type: 'info',
              title: 'History Cleared',
              message: 'Sync history has been cleared.'
            });
          }
        }
      }
    ]
  });
  
  const template = [
    // App menu (macOS only)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { 
          label: 'Settings...',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            // Open the settings window
            console.log('[Menu Click] Settings clicked, opening settings window');
            if (typeof global.openSettingsWindowGlobal === 'function') {
              global.openSettingsWindowGlobal();
            } else {
              // Fallback: send to renderer if global function not available
              const focusedWindow = BrowserWindow.getFocusedWindow();
              if (focusedWindow) {
                focusedWindow.webContents.send('menu-action', { action: 'open-settings' });
              }
            }
          }
        },
        { type: 'separator' },
        { 
          label: 'Manage Environments...',
          click: () => {
            // Open the setup wizard to manage environments
            console.log('[Menu Click] Manage Environments clicked, opening setup wizard');
            if (typeof global.openSetupWizardGlobal === 'function') {
              global.openSetupWizardGlobal();
            } else {
              // Fallback: send to renderer if global function not available
              const focusedWindow = BrowserWindow.getFocusedWindow();
              if (focusedWindow) {
                focusedWindow.webContents.send('menu-action', { action: 'open-preferences' });
              }
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            ...(isMac ? [
              { role: 'pasteAndMatchStyle' },
              { role: 'delete' },
              { role: 'selectAll' },
              { type: 'separator' },
              {
                label: 'Speech',
                submenu: [
                  { role: 'startSpeaking' },
                  { role: 'stopSpeaking' }
                ]
              }
            ] : [
              { role: 'delete' },
              { type: 'separator' },
              { role: 'selectAll' }
            ])
          ]
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    
    // IDW menu (with dynamic IDW environment items)
    {
      label: 'IDW',
      submenu: idwMenuItems
    },
    
    // GSX menu (with dynamic GSX links)
    {
      label: 'GSX',
      submenu: gsxMenuItems
    },
    
    // Agentic University menu
    {
      label: 'Agentic University',
      submenu: [
        {
          label: 'Open LMS',
          click: () => {
            openLearningWindow('https://learning.staging.onereach.ai/', 'Learning Management System');
          }
        },
        { type: 'separator' },
        {
          label: 'Quick Starts',
          submenu: [
            {
              label: 'View All Tutorials',
              click: () => {
                const { BrowserWindow, app } = require('electron');
                const path = require('path');
                const getLogger = require('./event-logger');
                const logger = getLogger();
                
                // Log the Quick Starts access
                if (logger && logger.info) {
                  logger.info('Quick Starts Accessed', {
                    action: 'menu_click',
                    menuPath: 'Agentic University > Quick Starts > View All Tutorials',
                    timestamp: new Date().toISOString()
                  });
                }
                console.log('[Menu] User opened Quick Starts tutorials page');
                
                // Use __dirname which works for other windows
                const preloadPath = path.join(__dirname, 'preload.js');
                
                // Creating tutorials window with preload
                
                const tutorialsWindow = new BrowserWindow({
                  width: 1400,
                  height: 900,
                  webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    preload: preloadPath,
                    sandbox: false,
                    webSecurity: true,
                    enableRemoteModule: false
                  }
                });
                
                tutorialsWindow.loadFile('tutorials.html');
                
                // Add debug info
                tutorialsWindow.webContents.on('preload-error', (event, preloadPath, error) => {
                  console.error('[Menu] Preload error:', error);
                });
                
                tutorialsWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
                  console.error('[Menu] Failed to load tutorials:', errorDescription);
                });
                
                tutorialsWindow.webContents.on('did-finish-load', () => {
                  // Tutorials window loaded successfully
                });
              }
            },
            { type: 'separator' },
            {
              label: 'Getting Started',
              click: () => {
                openLearningWindow('https://learning.staging.onereach.ai/courses/getting-started', 'Getting Started');
              }
            },
            {
              label: 'Building Your First Agent',
              click: () => {
                openLearningWindow('https://learning.staging.onereach.ai/courses/first-agent', 'Building Your First Agent');
              }
            },
            {
              label: 'Workflow Fundamentals',
              click: () => {
                openLearningWindow('https://learning.staging.onereach.ai/courses/workflow-basics', 'Workflow Fundamentals');
              }
            },
            {
              label: 'API Integration',
              click: () => {
                openLearningWindow('https://learning.staging.onereach.ai/courses/api-integration', 'API Integration');
              }
            }
          ]
        },
        { type: 'separator' },
        {
          label: 'AI Run Times',
          click: () => {
            const aiWindow = new BrowserWindow({
              width: 1200,
              height: 800,
              webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                webSecurity: true,
                preload: path.join(__dirname, 'Flipboard-IDW-Feed/preload.js')
              }
            });
            
            // Load the UXmag.html file
            aiWindow.loadFile('Flipboard-IDW-Feed/uxmag.html');
          }
        },
        { type: 'separator' },
        {
          label: 'Wiser Method',
          click: () => {
            openLearningWindow('https://www.wisermethod.com/', 'Wiser Method');
          }
        }
      ]
    },
    
    // Clipboard menu
    {
      label: 'Manage Spaces',
      submenu: [
        {
          label: 'Show Clipboard History',
          accelerator: process.platform === 'darwin' ? 'Cmd+Shift+V' : 'Ctrl+Shift+V',
          click: () => {
            // Get the clipboard manager from the global scope
            if (global.clipboardManager) {
              global.clipboardManager.createClipboardWindow();
            } else {
              console.error('[Menu] Clipboard manager not available');
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Validate & Clean Storage',
          click: async () => {
            const { dialog } = require('electron');
            const ClipboardStorageValidator = require('./clipboard-storage-validator');
            const validator = new ClipboardStorageValidator();
            
            // Ask user if they want to auto-fix issues
            const result = await dialog.showMessageBox({
              type: 'question',
              title: 'Validate Clipboard Storage',
              message: 'Check for and fix storage issues?',
              detail: 'This will:\n• Remove orphaned metadata entries\n• Clean up files without metadata\n• Fix corrupted index entries\n• Remove inaccessible files',
              buttons: ['Check Only', 'Check & Fix', 'Cancel'],
              defaultId: 1,
              cancelId: 2
            });
            
            if (result.response === 2) return; // Cancel
            
            const autoFix = result.response === 1;
            
            // Show progress
            const progressDialog = dialog.showMessageBox({
              type: 'info',
              title: 'Validating Storage',
              message: 'Please wait...',
              detail: 'Checking clipboard storage integrity...',
              buttons: []
            });
            
            // Run validation
            const report = await validator.validateStorage(autoFix);
            
            // Show results
            const summary = report.summary;
            const issueCount = report.issues.length;
            
            let message = `Validation ${autoFix ? 'and cleanup ' : ''}complete!`;
            let detail = `Items checked: ${summary.totalItems}\n`;
            detail += `Valid items: ${summary.validItems}\n`;
            
            if (issueCount > 0) {
              detail += `\nIssues found:\n`;
              if (summary.orphanedMetadata > 0) {
                detail += `• Orphaned metadata: ${summary.orphanedMetadata}\n`;
              }
              if (summary.missingFiles > 0) {
                detail += `• Missing files: ${summary.missingFiles}\n`;
              }
              if (summary.orphanedDirectories > 0) {
                detail += `• Orphaned directories: ${summary.orphanedDirectories}\n`;
              }
              
              if (autoFix && summary.fixedIssues > 0) {
                detail += `\n✅ Fixed ${summary.fixedIssues} issues`;
              }
            } else {
              detail += '\n✅ No issues found!';
            }
            
            dialog.showMessageBox({
              type: issueCount > 0 && !autoFix ? 'warning' : 'info',
              title: 'Storage Validation Results',
              message: message,
              detail: detail,
              buttons: ['OK']
            });
          }
        },
        {
          label: 'Storage Summary',
          click: async () => {
            const { dialog } = require('electron');
            const ClipboardStorageValidator = require('./clipboard-storage-validator');
            const validator = new ClipboardStorageValidator();
            
            const summary = await validator.getStorageSummary();
            
            // Format file size
            const formatBytes = (bytes) => {
              if (bytes === 0) return '0 Bytes';
              const k = 1024;
              const sizes = ['Bytes', 'KB', 'MB', 'GB'];
              const i = Math.floor(Math.log(bytes) / Math.log(k));
              return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
            };
            
            let detail = `Total Size: ${formatBytes(summary.totalSize)}\n`;
            detail += `Total Items: ${summary.itemCount}\n`;
            detail += `Spaces: ${summary.spaceCount}\n\n`;
            
            if (Object.keys(summary.fileTypes).length > 0) {
              detail += 'Item Types:\n';
              for (const [type, count] of Object.entries(summary.fileTypes)) {
                detail += `• ${type}: ${count}\n`;
              }
            }
            
            if (summary.largestFiles.length > 0) {
              detail += '\nLargest Files:\n';
              for (const file of summary.largestFiles.slice(0, 5)) {
                detail += `• ${file.name || 'Unnamed'}: ${formatBytes(file.size)}\n`;
              }
            }
            
            dialog.showMessageBox({
              type: 'info',
              title: 'Clipboard Storage Summary',
              message: 'Storage Usage',
              detail: detail,
              buttons: ['OK']
            });
          }
        }
      ]
    },
    
        // Tools menu (formerly Modules)
    {
      label: 'Tools',
      submenu: [
        // Dynamic module/tool items will be inserted here
        ...(global.moduleManager ? global.moduleManager.getModuleMenuItems() : []),
        ...(global.moduleManager && global.moduleManager.getInstalledModules().length > 0 ? [{ type: 'separator' }] : []),
        // Web tool items
        ...(global.moduleManager ? global.moduleManager.getWebToolMenuItems() : []),
        ...(global.moduleManager && global.moduleManager.getWebTools().length > 0 ? [{ type: 'separator' }] : []),
        {
          label: 'Black Hole (Paste to Spaces)',
          accelerator: 'CommandOrControl+Shift+B',
          click: () => {
            if (global.clipboardManager) {
              // Position near center of screen
              const { screen } = require('electron');
              const primaryDisplay = screen.getPrimaryDisplay();
              const { width, height } = primaryDisplay.workAreaSize;
              const position = {
                x: Math.round(width / 2 - 75),
                y: Math.round(height / 2 - 75)
              };
              global.clipboardManager.createBlackHoleWindow(position, true);
            }
          }
        },
        {
          label: 'GSX Create',
          accelerator: 'CommandOrControl+Shift+A',
          click: () => {
            // #region agent log
            console.log('[GSX-DEBUG] H0: GSX Create menu item clicked - opening window');
            // #endregion
            // Get screen dimensions for larger window
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
                preload: path.join(__dirname, 'preload.js')
              }
            });
            
            // #region agent log
            aiderWindow.webContents.on('did-finish-load', () => {
              console.log('[GSX-DEBUG] H0: GSX Create window finished loading');
            });
            aiderWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
              console.log('[GSX-DEBUG] H0: GSX Create window FAILED to load:', errorCode, errorDescription);
            });
            // #endregion
            aiderWindow.loadFile('aider-ui.html');
          }
        },
        {
          label: 'Video Editor',
          accelerator: 'CommandOrControl+Shift+V',
          click: () => {
            const videoEditorWindow = new BrowserWindow({
              width: 1400,
              height: 900,
              title: 'Video Editor',
              webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                devTools: true,
                preload: path.join(__dirname, 'preload-video-editor.js')
              }
            });
            
            videoEditorWindow.loadFile('video-editor.html');

            // Enable dev tools keyboard shortcut (Cmd+Option+I / Ctrl+Shift+I)
            videoEditorWindow.webContents.on('before-input-event', (event, input) => {
              if ((input.meta && input.alt && input.key === 'i') || 
                  (input.control && input.shift && input.key === 'I')) {
                videoEditorWindow.webContents.toggleDevTools();
              }
            });
            
            // Setup video editor IPC for this window
            if (global.videoEditor) {
              global.videoEditor.setupIPC(videoEditorWindow);
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Manage Tools...',
          click: () => {
            const { BrowserWindow } = require('electron');
            
            // Create module manager window
            const managerWindow = new BrowserWindow({
              width: 800,
              height: 600,
              webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                enableRemoteModule: true
              },
              title: 'Module Manager'
            });
            
            managerWindow.loadFile('module-manager-ui.html');
          }
        }
      ]
    },
    
    // Help menu (macOS forces this to be last when using role: 'help')
    {
      role: 'help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          click: () => {
            const { dialog } = require('electron');
            const focusedWindow = BrowserWindow.getFocusedWindow();
            
            const shortcutsMessage = `IDW Environments:
Cmd/Ctrl+1 through 9: Open IDW environments 1-9

External AI Agents:
Alt+1: Google Gemini
Alt+2: Perplexity
Alt+3: ChatGPT
Alt+4: Claude

Image Creators:
Shift+Cmd/Ctrl+1: Midjourney
Shift+Cmd/Ctrl+2: Ideogram
Shift+Cmd/Ctrl+3: Adobe Firefly
Shift+Cmd/Ctrl+4: OpenAI Image (DALL-E 3)

Other Shortcuts:
Cmd/Ctrl+A: Add/Remove environments
Cmd/Ctrl+,: Settings
Cmd/Ctrl+Shift+V: Show Clipboard History
Cmd/Ctrl+Shift+T: Test Runner
Cmd/Ctrl+Shift+L: Event Log Viewer
Cmd/Ctrl+Shift+B: Report a Bug

Right-click anywhere: Paste to Black Hole`;
            
            dialog.showMessageBox(focusedWindow, {
              type: 'info',
              title: 'Keyboard Shortcuts',
              message: 'OneReach.ai Keyboard Shortcuts',
              detail: shortcutsMessage,
              buttons: ['OK']
            });
          }
        },
        {
          label: 'Learn More',
          click: async () => {
            await shell.openExternal('https://onereach.ai');
          }
        },
        { type: 'separator' },
        {
          label: 'Browser Extension Setup',
          click: () => {
            const { BrowserWindow } = require('electron');
            const path = require('path');
            
            // Create extension setup window
            const setupWindow = new BrowserWindow({
              width: 600,
              height: 700,
              backgroundColor: '#0d0d14',
              webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload-minimal.js')
              }
            });
            
            setupWindow.loadFile('extension-setup.html');
          }
        },
        { type: 'separator' },
        {
          label: 'Documentation',
          submenu: [
            {
              label: 'Local Documentation (README)',
              click: () => {
                const { BrowserWindow } = require('electron');
                const path = require('path');
                
                // Create a documentation window
                const docWindow = new BrowserWindow({
                  width: 1000,
                  height: 800,
                  webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    preload: path.join(__dirname, 'preload.js'),
                    webSecurity: true
                  }
                });
                
                // Load the dedicated documentation HTML file
                try {
                  docWindow.loadFile('docs-readme.html');
                } catch (error) {
                  console.error('Error loading local documentation:', error);
                  // Fallback to external documentation
                  shell.openExternal('https://onereach.ai/docs');
                }
              }
            },
            {
              label: 'AI Run Times Guide',
              click: () => {
                const { BrowserWindow } = require('electron');
                const path = require('path');
                
                // Create AI Run Times help window
                const aiHelpWindow = new BrowserWindow({
                  width: 1000,
                  height: 800,
                  webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    preload: path.join(__dirname, 'preload.js'),
                    webSecurity: true
                  }
                });
                
                // Load the dedicated AI Run Times guide HTML file
                try {
                  aiHelpWindow.loadFile('docs-ai-insights.html');
                } catch (error) {
                  console.error('Error loading AI Run Times guide:', error);
                  // Fallback to external documentation
                  shell.openExternal('https://onereach.ai/docs');
                }
              }
            },
            { type: 'separator' },
            {
              label: 'Online Documentation',
              click: async () => {
                await shell.openExternal('https://onereach.ai/docs');
              }
            }
          ]
        },
        {
          label: 'Developer Docs',
          submenu: [
            {
              label: 'Spaces API Guide',
              click: () => {
                const { BrowserWindow } = require('electron');
                const path = require('path');
                
                // Create Spaces API documentation window
                const apiDocWindow = new BrowserWindow({
                  width: 1100,
                  height: 900,
                  webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    preload: path.join(__dirname, 'preload.js'),
                    webSecurity: true
                  }
                });
                
                // Load the Spaces API guide HTML file
                try {
                  apiDocWindow.loadFile('docs-spaces-api.html');
                } catch (error) {
                  console.error('Error loading Spaces API documentation:', error);
                }
              }
            }
          ]
        },
        { type: 'separator' },
        {
          label: '🐛 Report a Bug',
          accelerator: process.platform === 'darwin' ? 'Cmd+Shift+B' : 'Ctrl+Shift+B',
          click: async () => {
            const { dialog, app, clipboard, shell } = require('electron');
            const os = require('os');
            const fs = require('fs');
            const path = require('path');
            const crypto = require('crypto');
            
            try {
              // Generate unique report ID
              const reportId = `BR-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
              
              // Get user info
              const userInfo = {
                username: os.userInfo().username,
                hostname: os.hostname(),
                homedir: os.homedir()
              };
              
              // Collect comprehensive system information
              const systemInfo = {
                app_version: app.getVersion(),
                app_name: app.getName(),
                electron_version: process.versions.electron,
                node_version: process.versions.node,
                chrome_version: process.versions.chrome,
                v8_version: process.versions.v8,
                platform: os.platform(),
                platform_version: os.release(),
                arch: os.arch(),
                cpus: os.cpus().length,
                memory_total: `${Math.round(os.totalmem() / 1073741824)}GB`,
                memory_free: `${Math.round(os.freemem() / 1073741824)}GB`,
                uptime: `${Math.round(os.uptime() / 3600)} hours`
              };
              
              // Get app paths
              const appPaths = {
                userData: app.getPath('userData'),
                logs: app.getPath('logs'),
                temp: app.getPath('temp')
              };
              
              // Collect recent logs automatically (last 200 lines)
              let recentLogs = '';
              let logError = null;
              try {
                const logPath = path.join(app.getPath('userData'), 'logs', 'app.log');
                if (fs.existsSync(logPath)) {
                  const logContent = fs.readFileSync(logPath, 'utf8');
                  const lines = logContent.split('\n').filter(line => line.trim());
                  // Get last 200 lines
                  recentLogs = lines.slice(-200).join('\n');
                } else {
                  // Try alternative log locations
                  const altLogPath = path.join(app.getPath('userData'), 'app.log');
                  if (fs.existsSync(altLogPath)) {
                    const logContent = fs.readFileSync(altLogPath, 'utf8');
                    const lines = logContent.split('\n').filter(line => line.trim());
                    recentLogs = lines.slice(-200).join('\n');
                  }
                }
              } catch (error) {
                logError = error.message;
                console.error('Failed to read logs:', error);
              }
              
              // Get settings (without sensitive data)
              let appSettings = {};
              try {
                const settingsPath = path.join(app.getPath('userData'), 'settings.json');
                if (fs.existsSync(settingsPath)) {
                  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                  // Remove sensitive data
                  delete settings.apiKeys;
                  delete settings.credentials;
                  delete settings.tokens;
                  delete settings.passwords;
                  appSettings = settings;
                }
              } catch (error) {
                appSettings = { error: 'Failed to load settings' };
              }
              
              // Create comprehensive bug report
              const bugReportData = {
                reportId,
                timestamp: new Date().toISOString(),
                user: {
                  username: userInfo.username,
                  hostname: userInfo.hostname
                },
                system: systemInfo,
                app: {
                  version: systemInfo.app_version,
                  paths: appPaths,
                  settings: appSettings
                },
                logs: recentLogs || 'No logs available',
                logError
              };
              
              // Create user-friendly email body
              const emailBody = `
===========================================
BUG REPORT ID: ${reportId}
===========================================

PLEASE DESCRIBE YOUR ISSUE HERE:
[Please describe what happened, what you expected to happen, and steps to reproduce the issue]




===========================================
AUTOMATED SYSTEM INFORMATION (DO NOT EDIT)
===========================================

Report ID: ${reportId}
Timestamp: ${new Date().toLocaleString()}
User: ${userInfo.username}@${userInfo.hostname}

APP INFORMATION:
- App Version: ${systemInfo.app_version}
- Electron: ${systemInfo.electron_version}
- Node: ${systemInfo.node_version}
- Chrome: ${systemInfo.chrome_version}

SYSTEM INFORMATION:
- Platform: ${systemInfo.platform} ${systemInfo.platform_version}
- Architecture: ${systemInfo.arch}
- CPUs: ${systemInfo.cpus}
- Memory: ${systemInfo.memory_total} total (${systemInfo.memory_free} free)
- System Uptime: ${systemInfo.uptime}

APP PATHS:
- User Data: ${appPaths.userData}
- Logs: ${appPaths.logs}
- Temp: ${appPaths.temp}

RECENT LOG ENTRIES (Last 200 lines):
----------------------------------------
${recentLogs || 'No logs available' + (logError ? `\nLog Error: ${logError}` : '')}
----------------------------------------

APP SETTINGS (Sensitive data removed):
${JSON.stringify(appSettings, null, 2)}

===========================================
END OF AUTOMATED REPORT
===========================================
`;

              // Show dialog to confirm sending
              const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                type: 'info',
                title: 'Bug Report Ready',
                message: `Bug Report ${reportId} Prepared`,
                detail: 'Your bug report has been prepared with all system information and logs. Choose how you want to submit it:',
                buttons: ['Open GitHub Issues', 'Send Email', 'Copy to Clipboard', 'Save to File', 'Cancel'],
                defaultId: 0,
                cancelId: 4
              });
              
              if (result.response === 0) {
                // Open GitHub issues page with pre-filled title
                const issueTitle = `Bug Report ${reportId} - Onereach.ai v${systemInfo.app_version}`;
                const encodedTitle = encodeURIComponent(issueTitle);
                const encodedBody = encodeURIComponent(emailBody);
                
                // Open GitHub issues page with title and body pre-filled
                const githubUrl = `https://github.com/wilsr7000/onereach_desktop/issues/new?title=${encodedTitle}&body=${encodedBody}`;
                await shell.openExternal(githubUrl);
                
                // Show success message
                dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                  type: 'info',
                  title: 'GitHub Issues Opened',
                  message: 'GitHub Issues page opened',
                  detail: `A new issue page has been opened on GitHub with Report ${reportId}. Please describe your issue at the top of the issue body and submit it.`,
                  buttons: ['OK']
                });
                
              } else if (result.response === 1) {
                // Open email client with everything pre-filled
                const subject = `Bug Report ${reportId} - Onereach.ai v${systemInfo.app_version}`;
                const encodedSubject = encodeURIComponent(subject);
                const encodedBody = encodeURIComponent(emailBody);
                
                // Create mailto link with subject and body
                const mailtoLink = `mailto:support@onereach.ai?subject=${encodedSubject}&body=${encodedBody}`;
                
                // Open default email client
                await shell.openExternal(mailtoLink);
                
                // Show success message
                dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                  type: 'info',
                  title: 'Email Opened',
                  message: 'Bug report email opened',
                  detail: `Your email client should now be open with Report ${reportId}. Please describe your issue at the top of the email and send it to support.`,
                  buttons: ['OK']
                });
                
              } else if (result.response === 2) {
                // Copy to clipboard
                clipboard.writeText(emailBody);
                dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                  type: 'info',
                  title: 'Copied to Clipboard',
                  message: `Bug Report ${reportId} copied to clipboard`,
                  detail: 'You can now paste this into any text editor or email client.',
                  buttons: ['OK']
                });
                
              } else if (result.response === 3) {
                // Save to file
                const savePath = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
                  defaultPath: `bug-report-${reportId}.txt`,
                  filters: [
                    { name: 'Text Files', extensions: ['txt'] },
                    { name: 'All Files', extensions: ['*'] }
                  ]
                });
                
                if (!savePath.canceled && savePath.filePath) {
                  // Also save JSON version
                  const jsonPath = savePath.filePath.replace('.txt', '.json');
                  fs.writeFileSync(savePath.filePath, emailBody);
                  fs.writeFileSync(jsonPath, JSON.stringify(bugReportData, null, 2));
                  
                  dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                    type: 'info',
                    title: 'Saved Successfully',
                    message: `Bug Report ${reportId} saved`,
                    detail: `Report saved to:\n${savePath.filePath}\n\nJSON data also saved to:\n${jsonPath}`,
                    buttons: ['OK']
                  });
                }
              }
              // If response === 4, user cancelled
              
            } catch (error) {
              console.error('Error creating bug report:', error);
              dialog.showErrorBox('Error', `Failed to create bug report: ${error.message}\n\nPlease try again or contact support directly.`);
            }
          }
        },
        {
          label: '📋 Export Debug Info',
          click: async () => {
            const { dialog, app, clipboard } = require('electron');
            const os = require('os');
            const fs = require('fs');
            const path = require('path');
            
            try {
              // Collect comprehensive debug information
              const debugInfo = {
                timestamp: new Date().toISOString(),
                app: {
                  name: app.getName(),
                  version: app.getVersion(),
                  paths: {
                    userData: app.getPath('userData'),
                    temp: app.getPath('temp'),
                    exe: app.getPath('exe')
                  }
                },
                system: {
                  platform: os.platform(),
                  release: os.release(),
                  arch: os.arch(),
                  cpus: os.cpus().length,
                  memory: {
                    total: `${Math.round(os.totalmem() / 1073741824)}GB`,
                    free: `${Math.round(os.freemem() / 1073741824)}GB`
                  },
                  uptime: `${Math.round(os.uptime() / 3600)} hours`
                },
                electron: {
                  version: process.versions.electron,
                  node: process.versions.node,
                  chrome: process.versions.chrome,
                  v8: process.versions.v8
                },
                settings: {}
              };
              
              // Try to load app settings (without sensitive data)
              try {
                const settingsPath = path.join(app.getPath('userData'), 'settings.json');
                if (fs.existsSync(settingsPath)) {
                  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                  // Remove sensitive data
                  delete settings.apiKeys;
                  delete settings.credentials;
                  debugInfo.settings = settings;
                }
              } catch (error) {
                debugInfo.settings = { error: 'Failed to load settings' };
              }
              
              const debugText = JSON.stringify(debugInfo, null, 2);
              
              // Ask user what to do with debug info
              const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                type: 'info',
                title: 'Debug Information',
                message: 'Debug information has been collected',
                detail: 'What would you like to do with it?',
                buttons: ['Copy to Clipboard', 'Save to File', 'Cancel'],
                defaultId: 0,
                cancelId: 2
              });
              
              if (result.response === 0) {
                clipboard.writeText(debugText);
                dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                  type: 'info',
                  title: 'Success',
                  message: 'Debug information copied to clipboard!'
                });
              } else if (result.response === 1) {
                const savePath = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
                  defaultPath: `onereach-debug-${Date.now()}.json`,
                  filters: [
                    { name: 'JSON Files', extensions: ['json'] },
                    { name: 'All Files', extensions: ['*'] }
                  ]
                });
                
                if (!savePath.canceled && savePath.filePath) {
                  fs.writeFileSync(savePath.filePath, debugText);
                  dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                    type: 'info',
                    title: 'Success',
                    message: 'Debug information saved successfully!'
                  });
                }
              }
            } catch (error) {
              console.error('Error exporting debug info:', error);
              dialog.showErrorBox('Error', 'Failed to export debug information.');
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Check for Updates',
          click: () => {
            console.log('[Menu Click] Check for Updates clicked');
            
            // Call the checkForUpdates function directly from main process
            const { checkForUpdates } = require('./main.js');
            if (typeof checkForUpdates === 'function') {
              checkForUpdates();
            } else {
              // Fallback: Try using the global function if available
              if (typeof global.checkForUpdatesGlobal === 'function') {
                global.checkForUpdatesGlobal();
              } else {
                const { dialog } = require('electron');
                const focusedWindow = BrowserWindow.getFocusedWindow();
                dialog.showMessageBox(focusedWindow, {
                  type: 'info',
                  title: 'Updates Not Available',
                  message: 'Auto-update repository not configured',
                  detail: 'The public releases repository needs to be created first:\n\n1. Go to github.com/new\n2. Create repository: onereach_desktop\n3. Make it PUBLIC\n4. Run: npm run release',
                  buttons: ['OK']
                });
              }
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Manage Backups',
          submenu: [
            {
              label: 'View Available Backups',
              click: async () => {
                const { dialog, shell } = require('electron');
                const focusedWindow = BrowserWindow.getFocusedWindow();
                
                // Get available backups
                const rollbackManager = require('./rollback-manager');
                const result = await rollbackManager.getBackups();
                
                if (!result || result.length === 0) {
                  dialog.showMessageBox(focusedWindow, {
                    type: 'info',
                    title: 'No Backups Available',
                    message: 'No app backups found. Backups are created automatically before updates.',
                    buttons: ['OK']
                  });
                  return;
                }
                
                // Show backups in a dialog
                const buttons = result.map(backup => 
                  `v${backup.version} (${new Date(backup.createdAt).toLocaleDateString()})`
                );
                buttons.push('Cancel');
                
                const { response } = await dialog.showMessageBox(focusedWindow, {
                  type: 'question',
                  title: 'Available Backups',
                  message: 'Select a backup version to create a restore script:',
                  detail: 'The restore script will help you rollback to a previous version if needed.',
                  buttons: buttons,
                  cancelId: buttons.length - 1
                });
                
                if (response < result.length) {
                  // Create restore script for selected backup
                  const backup = result[response];
                  const scriptResult = await rollbackManager.createRestoreScript(backup.version);
                  
                  if (scriptResult.success) {
                    const { response: showFolder } = await dialog.showMessageBox(focusedWindow, {
                      type: 'info',
                      title: 'Restore Script Created',
                      message: `Restore script for v${backup.version} has been created.`,
                      detail: 'Would you like to open the backups folder?',
                      buttons: ['Open Folder', 'OK'],
                      defaultId: 0
                    });
                    
                    if (showFolder === 0) {
                      await rollbackManager.openBackupsFolder();
                    }
                  } else {
                    dialog.showErrorBox('Error', `Failed to create restore script: ${scriptResult.error}`);
                  }
                }
              }
            },
            {
              label: 'Open Backups Folder',
              click: async () => {
                const rollbackManager = require('./rollback-manager');
                await rollbackManager.openBackupsFolder();
              }
            }
          ]
        },
        { type: 'separator' },
        {
          label: '◎ App Health Dashboard',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => {
            console.log("[Menu] Opening App Health Dashboard");
            if (global.openDashboardWindow) {
              global.openDashboardWindow();
            } else {
              console.error('[Menu] Dashboard window function not available');
            }
          }
        },
        // Conditionally add test menu items if showTestMenu is true
        ...(showTestMenu ? [
          { type: 'separator' },
          {
            label: '🧪 Data Validation Tests',
            click: () => {
              console.log("Test menu item clicked - sending open-data-tests action");
              // Send directly to main process for immediate handling
              
              ipcMain.emit('menu-action', null, { action: 'open-data-tests' });
              
              // Also send to focused window as backup
              const focusedWindow = BrowserWindow.getFocusedWindow();
              if (focusedWindow) {
                focusedWindow.webContents.send('menu-action', { action: 'open-data-tests' });
              }
            }
          },
          {
            label: '🛡️ CSP Test Page',
            click: () => {
              console.log("CSP Test menu item clicked - sending open-csp-test action");
              // Send directly to main process for immediate handling
              
              ipcMain.emit('menu-action', null, { action: 'open-csp-test' });
              
              // Also send to focused window as backup
              const focusedWindow = BrowserWindow.getFocusedWindow();
              if (focusedWindow) {
                focusedWindow.webContents.send('menu-action', { action: 'open-csp-test' });
              }
            }
          },
          {
            label: '🧬 Integrated Test Runner',
            accelerator: 'CmdOrCtrl+Shift+T',
            click: () => {
              console.log("Test Runner clicked - opening integrated test runner");
              
              // Create test runner window
              const { BrowserWindow } = require('electron');
              const path = require('path');
              
              const testWindow = new BrowserWindow({
                width: 1200,
                height: 900,
                webPreferences: {
                  nodeIntegration: false,
                  contextIsolation: true,
                  preload: path.join(__dirname, 'preload.js'),
                  webSecurity: true
                }
              });
              
              testWindow.loadFile('test-runner.html');
            }
          },
          {
            label: '📋 Event Log Viewer',
            accelerator: 'CmdOrCtrl+Shift+L',
            click: () => {
              console.log("Event Log Viewer clicked - opening log viewer");
              
              // Create log viewer window
              const { BrowserWindow } = require('electron');
              const path = require('path');
              
              const logWindow = new BrowserWindow({
                width: 1200,
                height: 800,
                webPreferences: {
                  nodeIntegration: false,
                  contextIsolation: true,
                  preload: path.join(__dirname, 'preload-log-viewer.js'),
                  webSecurity: true
                },
                title: 'Event Log Viewer'
              });
              
              logWindow.loadFile('log-viewer.html');
            }
          },
          {
            label: '🧪 Test ElevenLabs APIs',
            click: async () => {
              console.log('[Menu] Testing ElevenLabs APIs...');
              const { dialog, BrowserWindow } = require('electron');
              const focusedWindow = BrowserWindow.getFocusedWindow();
              
              try {
                // Get the video editor service
                const { VideoEditor } = require('./src/video/index.js');
                const videoEditor = new VideoEditor();
                
                const results = { passed: [], failed: [] };
                
                // Test 1: List Models
                try {
                  const models = await videoEditor.elevenLabsService.listModels();
                  results.passed.push(`List Models: Found ${models?.length || 0} models`);
                } catch (e) {
                  results.failed.push(`List Models: ${e.message}`);
                }
                
                // Test 2: List Voices
                try {
                  const voices = await videoEditor.elevenLabsService.listVoices();
                  results.passed.push(`List Voices: Found ${voices.voices?.length || 0} voices`);
                } catch (e) {
                  results.failed.push(`List Voices: ${e.message}`);
                }
                
                // Test 3: List Studio Projects
                try {
                  const projects = await videoEditor.elevenLabsService.listStudioProjects();
                  results.passed.push(`List Studio Projects: Found ${projects?.length || 0} projects`);
                } catch (e) {
                  results.failed.push(`List Studio Projects: ${e.message}`);
                }
                
                // Test 4: Get History
                try {
                  const history = await videoEditor.elevenLabsService.getHistory({ pageSize: 5 });
                  results.passed.push(`Get History: Found ${history.history?.length || 0} items`);
                } catch (e) {
                  results.failed.push(`Get History: ${e.message}`);
                }
                
                // Test 5: Get User Info
                try {
                  const user = await videoEditor.elevenLabsService.getUserInfo();
                  results.passed.push(`Get User Info: ${user.first_name || 'OK'}`);
                } catch (e) {
                  results.failed.push(`Get User Info: ${e.message}`);
                }
                
                // Test 6: Get Subscription
                try {
                  const sub = await videoEditor.elevenLabsService.getUserSubscription();
                  results.passed.push(`Get Subscription: ${sub.tier || 'OK'}`);
                } catch (e) {
                  results.failed.push(`Get Subscription: ${e.message}`);
                }
                
                // Show results
                const message = [
                  `✅ Passed: ${results.passed.length}`,
                  `❌ Failed: ${results.failed.length}`,
                  '',
                  '--- Passed ---',
                  ...results.passed,
                  '',
                  '--- Failed ---',
                  ...results.failed
                ].join('\n');
                
                console.log('[Menu] ElevenLabs Test Results:\n' + message);
                
                dialog.showMessageBox(focusedWindow, {
                  type: results.failed.length > 0 ? 'warning' : 'info',
                  title: 'ElevenLabs API Test Results',
                  message: `Passed: ${results.passed.length} | Failed: ${results.failed.length}`,
                  detail: message,
                  buttons: ['OK']
                });
              } catch (error) {
                console.error('[Menu] ElevenLabs test error:', error);
                dialog.showErrorBox('ElevenLabs Test Error', error.message);
              }
            }
          },
          {
            label: '🔧 Debug: Open Setup Wizard',
            click: async () => {
              console.log('Debug: Opening setup wizard directly');
              const { BrowserWindow } = require('electron');
              const path = require('path');
              const fs = require('fs');
              
              // Create the setup wizard window directly
              const wizardWindow = new BrowserWindow({
                width: 1000, 
                height: 700,
                webPreferences: {
                  nodeIntegration: false,
                  contextIsolation: true,
                  preload: path.join(__dirname, 'preload.js'),
                  webSecurity: true,
                  enableRemoteModule: false,
                  sandbox: false
                }
              });
              
              // Load the setup wizard directly
              console.log('Loading setup-wizard.html directly');
              wizardWindow.loadFile('setup-wizard.html');
            }
          }
        ] : [])
      ]
    },
    
    // Share menu - positioned before Help (must have submenu)
    {
      label: 'Share',
      submenu: [
        {
          label: 'Copy Download Link',
          click: () => {
            console.log('[Share] Copy Download Link clicked');
            const { clipboard, dialog } = require('electron');
            clipboard.writeText('https://github.com/wilsr7000/onereach_desktop/releases/latest');
            const focusedWindow = BrowserWindow.getFocusedWindow();
            dialog.showMessageBox(focusedWindow, {
              type: 'info',
              title: 'Link Copied',
              message: 'Download link copied to clipboard!',
              buttons: ['OK']
            });
          }
        },
        {
          label: 'Share via Email',
          click: () => {
            console.log('[Share] Share via Email clicked');
            const { shell } = require('electron');
            const subject = encodeURIComponent('Check out Onereach.ai Desktop');
            const body = encodeURIComponent('I\'m using Onereach.ai Desktop - a powerful app for AI productivity. Download it here: https://github.com/wilsr7000/onereach_desktop/releases/latest');
            shell.openExternal(`mailto:?subject=${subject}&body=${body}`);
          }
        },
        {
          label: 'Open GitHub Page',  
          click: () => {
            console.log('[Share] Open GitHub Page clicked');
            const { shell } = require('electron');
            shell.openExternal('https://github.com/wilsr7000/onereach_desktop/releases/latest');
          }
        }
      ]
    }
  ];

  // Debug: Log the menu items being built
  console.log('[Menu] Building menu with items:', template.map(item => item.label || item.role).filter(Boolean));
  
  try {
    const menu = Menu.buildFromTemplate(template);
    console.log('[Menu] Menu built successfully.');
    
    // Debug: Verify Share menu is in the built menu
    const menuItems = menu.items.map(item => item.label || item.role);
    console.log('[Menu] Final menu items:', menuItems);
    if (!menuItems.includes('Share')) {
      console.error('[Menu] WARNING: Share menu is missing from final menu!');
    } else {
      console.log('[Menu] ✓ Share menu is present in position:', menuItems.indexOf('Share'));
    }
    
    return menu;
  } catch (error) {
    console.error('[Menu] Error building menu from template:', error);
    console.error('[Menu] Template:', JSON.stringify(template, null, 2));
    throw error;
  }
}

// State for test menu visibility
let isTestMenuVisible = false;

/**
 * Sets the application menu
 */
function setApplicationMenu(idwEnvironments = []) {
  try {
    console.log('[Menu] setApplicationMenu called with', idwEnvironments.length, 'environments');
    const menu = createMenu(isTestMenuVisible, idwEnvironments);
    console.log('[Menu] Menu created successfully, setting application menu');
    Menu.setApplicationMenu(menu);
    console.log('[Menu] Application menu set successfully');
  } catch (error) {
    console.error('[Menu] Error setting application menu:', error);
    console.error('[Menu] Stack trace:', error.stack);
    
    // Try to set a minimal fallback menu
    try {
      const fallbackMenu = Menu.buildFromTemplate([
        {
          label: 'File',
          submenu: [
            { role: 'quit' }
          ]
        },
        {
          label: 'Help',
          submenu: [
            { 
              label: 'Debug Menu Error',
              click: () => {
                const { dialog } = require('electron');
                dialog.showErrorBox('Menu Error', `Failed to create menu: ${error.message}`);
              }
            }
          ]
        }
      ]);
      Menu.setApplicationMenu(fallbackMenu);
      console.log('[Menu] Fallback menu set');
    } catch (fallbackError) {
      console.error('[Menu] Failed to set fallback menu:', fallbackError);
    }
  }
}

/**
 * Toggles the visibility of the test menu
 */
function toggleTestMenu() {
  isTestMenuVisible = !isTestMenuVisible;
  setApplicationMenu();
  
  // Show notification to user
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow) {
    focusedWindow.webContents.send('show-notification', {
      title: 'Test Menu',
      body: isTestMenuVisible ? 'Test menu activated' : 'Test menu deactivated'
    });
  }
}

/**
 * Registers the keyboard shortcut for toggling the test menu
 */
function registerTestMenuShortcut() {
  // Unregister first to prevent duplicates
  globalShortcut.unregister('CommandOrControl+Alt+H');
  
  // Register the shortcut
  globalShortcut.register('CommandOrControl+Alt+H', () => {
    toggleTestMenu();
  });
}

/**
 * Updates the application menu by reloading GSX links from file system
 * This is used when GSX links are updated in the setup wizard
 */
function refreshGSXLinks() {
  console.log('[Menu] Refreshing GSX links from file system');
  
  // PERFORMANCE: Invalidate cache so fresh data is loaded
  menuCache.invalidate();
  
  try {
    // Get current IDW environments first
    let idwEnvironments = [];
    const electronApp = require('electron').app;
    const userDataPath = electronApp.getPath('userData');
    const idwConfigPath = path.join(userDataPath, 'idw-entries.json');
    
    console.log('[Menu] Checking for IDW environments file at:', idwConfigPath);
    if (fs.existsSync(idwConfigPath)) {
      try {
        const idwData = fs.readFileSync(idwConfigPath, 'utf8');
        idwEnvironments = JSON.parse(idwData);
        console.log(`[Menu] Loaded ${idwEnvironments.length} IDW environments for GSX refresh`);
        
        // Log IDW environments for debugging
        idwEnvironments.forEach(env => {
          console.log(`[Menu] IDW Environment: id=${env.id || 'undefined'}, label=${env.label}, environment=${env.environment}`);
          
          // Ensure environment has an ID (critical for custom links)
          if (!env.id) {
            // Generate an ID if missing
            env.id = `${env.label}-${env.environment}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
            console.log(`[Menu] Generated missing ID for environment: ${env.id}`);
          }
        });
      } catch (error) {
        console.error('[Menu] Error parsing IDW environments from file:', error);
        idwEnvironments = [];
      }
    } else {
      console.log('[Menu] IDW environments file not found');
    }
    
    // Load GSX links from file
    const gsxConfigPath = path.join(userDataPath, 'gsx-links.json');
    console.log('[Menu] Checking for GSX links file at:', gsxConfigPath);
    
    if (fs.existsSync(gsxConfigPath)) {
      try {
        console.log('[Menu] Found gsx-links.json, reading fresh data');
        const data = fs.readFileSync(gsxConfigPath, 'utf8');
        const allGsxLinks = JSON.parse(data);
        console.log(`[Menu] Loaded ${allGsxLinks.length} GSX links`);
        
        // Log all links for debugging
        console.log('[Menu] All links in GSX links file:');
        allGsxLinks.forEach(link => {
          console.log(`[Menu] Link: ID=${link.id}, Label=${link.label}, URL=${link.url && link.url.substring(0, 30)}..., IDW=${link.idwId || 'none'}, Custom=${link.custom || false}, Env=${link.environment || 'none'}`);
        });
        
        // Log custom links for deeper debugging
        const customLinks = allGsxLinks.filter(link => link.custom === true);
        console.log(`[Menu] Found ${customLinks.length} custom links in GSX links file:`);
        customLinks.forEach(link => {
          const linkIdwId = String(link.idwId || '').trim();
          console.log(`[Menu] Custom link: ID=${link.id}, Label=${link.label}, URL=${link.url && link.url.substring(0, 30)}..., IDW=${linkIdwId}, Env=${link.environment || 'none'}`);
          
          // Check if this link has an IDW ID that matches any IDW environment
          const matchingEnv = idwEnvironments.find(env => {
            const envId = String(env.id || '').trim();
            return envId === linkIdwId;
          });
          
          if (matchingEnv) {
            console.log(`[Menu] ✓ Custom link ${link.id} matches IDW ${matchingEnv.label} (${matchingEnv.id})`);
          } else {
            console.log(`[Menu] ✕ Custom link ${link.id} has no matching IDW environment for ID ${linkIdwId}`);
            
            // Try to find an environment match by environment name as fallback
            if (link.environment) {
              const envMatch = idwEnvironments.find(env => 
                env.environment && 
                env.environment.toLowerCase() === link.environment.toLowerCase()
              );
              
              if (envMatch) {
                console.log(`[Menu] ℹ️ Found fallback match by environment name: ${link.environment} -> ${envMatch.label}`);
              }
            }
          }
        });
        
        // Rebuild the menu completely with the fresh data
        console.log('[Menu] Building a fresh application menu');
        const newMenu = createMenu(isTestMenuVisible, idwEnvironments);
        console.log('[Menu] Setting the fresh application menu');
        Menu.setApplicationMenu(newMenu);
        
        console.log('[Menu] Menu refreshed with latest GSX links');
        return true;
      } catch (error) {
        console.error('[Menu] Error parsing GSX links from file:', error);
        return false;
      }
    } else {
      console.log('[Menu] GSX links file not found – generating default links');
      
      // Load user preferences to get GSX account ID
      let gsxAccountId = '';
      try {
        const prefsPath = path.join(userDataPath, 'user-preferences.json');
        if (fs.existsSync(prefsPath)) {
          const prefsData = fs.readFileSync(prefsPath, 'utf8');
          const userPrefs = JSON.parse(prefsData);
          if (userPrefs.gsxAccountId) {
            gsxAccountId = userPrefs.gsxAccountId;
            console.log('[Menu] Found GSX Account ID in user preferences:', gsxAccountId);
          }
        }
      } catch (error) {
        console.error('[Menu] Error loading user preferences for GSX account ID:', error);
      }
      
      const defaultLinks = generateDefaultGSXLinks(idwEnvironments, gsxAccountId);
      if (defaultLinks.length) {
        try {
          fs.writeFileSync(gsxConfigPath, JSON.stringify(defaultLinks, null, 2));
          console.log(`[Menu] Wrote ${defaultLinks.length} default GSX links to`, gsxConfigPath);
          // Recursively call refresh to build menu with fresh data
          return refreshGSXLinks();
        } catch (err) {
          console.error('[Menu] Failed to write default GSX links:', err);
        }
      } else {
        console.warn('[Menu] No IDWs available – skipping default GSX link generation');
      }
      return false;
    }
  } catch (error) {
    console.error('[Menu] Error refreshing GSX links:', error);
    return false;
  }
}

// Helper: generate default GSX links for all IDWs ----------------------------
function generateDefaultGSXLinks(idwEnvironments=[], accountId='') {
  if (!Array.isArray(idwEnvironments) || idwEnvironments.length === 0) return [];
  const links = [];
  const withAccount = url => accountId ? `${url}?accountId=${accountId}` : url;
  idwEnvironments.forEach(env => {
    const envName = env.environment;
    const idwId   = env.id;
    if (!envName || !idwId) return; // skip incomplete entries
    links.push(
      { id:`hitl-${envName}-${idwId}`,       label:'HITL',       url: withAccount(`https://hitl.${envName}.onereach.ai/`),              environment: envName, idwId },
      { id:`actiondesk-${envName}-${idwId}`, label:'Action Desk',url: withAccount(`https://actiondesk.${envName}.onereach.ai/dashboard/`), environment: envName, idwId },
      { id:`designer-${envName}-${idwId}`,   label:'Designer',   url: withAccount(`https://studio.${envName}.onereach.ai/bots`),         environment: envName, idwId },
      { id:`agents-${envName}-${idwId}`,     label:'Agents',     url: withAccount(`https://agents.${envName}.onereach.ai/agents`),       environment: envName, idwId },
      { id:`tickets-${envName}-${idwId}`,    label:'Tickets',    url: withAccount(`https://tickets.${envName}.onereach.ai/`),            environment: envName, idwId },
      { id:`calendar-${envName}-${idwId}`,   label:'Calendar',   url: withAccount(`https://calendar.${envName}.onereach.ai/`),           environment: envName, idwId },
      { id:`developer-${envName}-${idwId}`,  label:'Developer',  url: withAccount(`https://docs.${envName}.onereach.ai/`),               environment: envName, idwId }
    );
  });
  return links;
}

/**
 * Refreshes the application menu to update dynamic content
 */
function refreshApplicationMenu() {
  // Get current IDW environments
  let idwEnvironments = [];
  try {
    const electronApp = require('electron').app;
    const userDataPath = electronApp.getPath('userData');
    const idwConfigPath = path.join(userDataPath, 'idw-entries.json');
    
    if (fs.existsSync(idwConfigPath)) {
      const idwData = fs.readFileSync(idwConfigPath, 'utf8');
      idwEnvironments = JSON.parse(idwData);
    }
  } catch (error) {
    console.error('[Menu] Error loading IDW environments:', error);
  }
  
  setApplicationMenu(idwEnvironments);
}

module.exports = {
  createMenu,
  setApplicationMenu,
  registerTestMenuShortcut,
  refreshGSXLinks,
  refreshApplicationMenu,
  // PERFORMANCE: Expose cache invalidation for when menu data files are updated
  invalidateMenuCache: () => menuCache.invalidate(),
  // Window management for app quit
  closeAllGSXWindows
}; 