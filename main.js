const { app, ipcMain, Tray, Menu, MenuItem, BrowserWindow, desktopCapturer, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { setApplicationMenu, registerTestMenuShortcut, refreshGSXLinks } = require('./menu');
const { shell } = require('electron');
const browserWindow = require('./browserWindow');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const ClipboardManager = require('./clipboard-manager-v2-adapter');
const rollbackManager = require('./rollback-manager');
const ModuleManager = require('./module-manager');
const getLogger = require('./event-logger');
let logger = getLogger(); // This might be a stub initially
const { createConsoleInterceptor } = require('./console-interceptor');
const { getGSXFileSync } = require('./gsx-file-sync');

// Configure logging for updates
log.transports.file.level = 'info';
autoUpdater.logger = log;
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

// Path to IDW entries configuration file
const idwConfigPath = path.join(app.getPath('userData'), 'idw-entries.json');

// Keep global references to prevent garbage collection
let tray;
let testWindow = null;
let clipboardManager = null;
let moduleManager = null;
let registeredShortcuts = []; // Track our registered shortcuts

// Initialize clipboard manager - moved to app.whenReady()

// Override shell.openExternal to handle GSX URLs specifically
const originalOpenExternal = shell.openExternal;
shell.openExternal = (url, options) => {
  console.log('shell.openExternal intercepted URL:', url);
  
  // Check if it's a GSX URL that should be handled in an Electron window
  if (url.includes('.onereach.ai/') &&
      (url.includes('actiondesk.') || 
       url.includes('studio.') || 
       url.includes('hitl.') || 
       url.includes('tickets.') || 
       url.includes('calendar.') || 
       url.includes('docs.'))) {
    console.log('Intercepted GSX URL in shell.openExternal, opening in Electron window:', url);
    
    // Extract the GSX app name from the URL
    let label = 'GSX';
    if (url.includes('actiondesk.')) label = 'Action Desk';
    else if (url.includes('studio.')) label = 'Designer';
    else if (url.includes('hitl.')) label = 'HITL';
    else if (url.includes('tickets.')) label = 'Tickets';
    else if (url.includes('calendar.')) label = 'Calendar';
    else if (url.includes('docs.')) label = 'Developer';
    
    // Open the GSX URL in an Electron window
    browserWindow.openGSXWindow(url, label);
    return Promise.resolve();
  }
  
  // For all other URLs, use the original implementation
  return originalOpenExternal(url, options);
};

// Create a global reference to the setup wizard function for direct access
global.openSetupWizardGlobal = () => {
  console.log('Opening setup wizard via global function');
  openSetupWizard();
};

// ---- Browser command-line tweaks (must be before app ready) ----
// Allow third-party cookies and relax SameSite restrictions so Google OAuth works inside the app
app.commandLine.appendSwitch('disable-features', [
  'SameSiteByDefaultCookies',
  'CookiesWithoutSameSiteMustBeSecure',
  'ThirdPartyStoragePartitioning',
  'BlockThirdPartyCookies'
].join(','));

// Add additional switches for better OAuth support
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess');
app.commandLine.appendSwitch('disable-site-isolation-trials');
app.commandLine.appendSwitch('disable-web-security');

// Configure default session for better OAuth support
app.whenReady().then(() => {
  const { session } = require('electron');
  const defaultSession = session.defaultSession;
  
  // Configure session for better OAuth support
  defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const { requestHeaders } = details;
    requestHeaders['Origin'] = 'https://accounts.google.com';
    callback({ requestHeaders });
  });

  // Allow all cookies for Google domains
  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const { responseHeaders } = details;
    if (details.url.includes('accounts.google.com')) {
      responseHeaders['Access-Control-Allow-Origin'] = ['*'];
      responseHeaders['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS'];
      responseHeaders['Access-Control-Allow-Headers'] = ['*'];
    }
    callback({ responseHeaders });
  });
});
//-----------------------------------------------------------------

function createWindow() {
  // Create the main window using our browser window module
  const mainWindow = browserWindow.createMainWindow(app);
  
  // Create tray icon
  createTray();
}

function createTray() {
  // Use the tray icon PNG for all platforms
  const trayIconPath = path.join(__dirname, 'assets/tray-icon.png');
  
  // Get main window reference
  const mainWindow = browserWindow.getMainWindow();
  
  // Create the tray icon
  tray = new Tray(trayIconPath);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => { 
      const mainWindow = browserWindow.getMainWindow();
      if (mainWindow) mainWindow.show(); 
    }},
    { label: 'Quit', click: () => { app.quit(); } }
  ]);
  
  tray.setToolTip('Onereach.ai');
  tray.setContextMenu(contextMenu);
  
  // Show window when tray icon is clicked
  tray.on('click', () => {
    const mainWindow = browserWindow.getMainWindow();
    if (!mainWindow) return;
    
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}

// Add a function to update the application menu with IDW environments
function updateApplicationMenu(environments = []) {
  console.log('Updating application menu with IDW environments:', environments.length);
  
  // Parse environments if it's a string
  let idwEnvironments = environments;
  if (typeof environments === 'string') {
    try {
      idwEnvironments = JSON.parse(environments);
    } catch (error) {
      console.error('Error parsing IDW environments:', error);
      idwEnvironments = [];
    }
  }
  
  // Call the menu module to update the application menu
  const { setApplicationMenu } = require('./menu');
  setApplicationMenu(idwEnvironments);
}

// Function to create a window for external content with proper security
function secureContentWindow(parentWindow) {
  // Create a window with more restrictive security settings for external content
  const contentWindow = new BrowserWindow({
    width: parentWindow.getSize()[0],
    height: parentWindow.getSize()[1],
    parent: parentWindow,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      sandbox: true, // Enable sandbox for external content
      enableRemoteModule: false, // Disable remote module
      preload: path.join(__dirname, 'preload-minimal.js') // Use a minimal preload script
    }
  });

  // Setup security monitoring for external content
  contentWindow.webContents.on('will-navigate', (event, url) => {
    // Log navigation attempts
    console.log('Content window navigation attempted to:', url);
    
    // Allow navigation within the same window for IDW and chat URLs
    if (url.startsWith('https://idw.edison.onereach.ai/') || 
        url.startsWith('https://flow-desc.chat.edison.onereach.ai/') || 
        url.includes('/chat/')) {
      console.log('Navigation to IDW/chat URL allowed in same window:', url);
      return;
    }
    
    // Block navigation to unexpected URLs
    console.log('Blocking navigation to non-IDW URL:', url);
    event.preventDefault();
    
    // Open external URLs in default browser instead
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url).catch(err => {
        console.error('Failed to open external URL:', err);
      });
    }
  });

  // Handle redirect attempts within the page
  contentWindow.webContents.on('will-redirect', (event, url) => {
    console.log('Content window redirect attempted to:', url);
    
    // Allow redirects to IDW and chat URLs in the same window
    if (url.startsWith('https://idw.edison.onereach.ai/') || 
        url.startsWith('https://flow-desc.chat.edison.onereach.ai/') || 
        url.includes('/chat/')) {
      console.log('Redirect to IDW/chat URL allowed in same window:', url);
      return;
    }
    
    // Block redirects to unexpected URLs
    console.log('Blocking redirect to non-IDW URL:', url);
    event.preventDefault();
    
    // Open external URLs in default browser instead
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url).catch(err => {
        console.error('Failed to open external URL:', err);
      });
    }
  });

  // Set Content Security Policy for external content
  contentWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    // Note: We're using 'unsafe-eval' here because the IDW application requires it to function properly.
    // This is a calculated security risk since we're only loading trusted content from onereach.ai domains.
    // For a production app, consider:
    // 1. Working with the IDW team to remove the need for eval() in their code
    // 2. Implementing additional security measures like CORS checks
    // 3. Using a more restrictive CSP and handling any functionality issues
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' * https://*.onereach.ai https://*.api.onereach.ai; " +
          "style-src 'self' 'unsafe-inline' * https://*.onereach.ai https://fonts.googleapis.com; " + 
          "style-src-elem 'self' 'unsafe-inline' * https://*.onereach.ai https://fonts.googleapis.com; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' * https://*.onereach.ai; " +
          "connect-src 'self' * https://*.onereach.ai https://*.api.onereach.ai; " +
          "img-src 'self' data: blob: * https://*.onereach.ai; " +
          "font-src 'self' data: * https://*.onereach.ai https://fonts.gstatic.com; " +
          "media-src 'self' * https://*.onereach.ai; " +
          "object-src 'none'; " +
          "base-uri 'self'"
        ]
      }
    });
  });

  // Inject custom scrollbar CSS when content loads
  contentWindow.webContents.on('did-finish-load', () => {
    // First check if the page uses Material Symbols before preloading
    contentWindow.webContents.executeJavaScript(`
      (function() {
        // Check if the page contains any Material Symbols elements
        const hasSymbols = document.querySelector('.material-symbols-outlined') !== null || 
                          document.querySelector('[class*="material-symbols"]') !== null;
        
        // Only preload if the page actually uses the font
        if (hasSymbols) {
          try {
            const fontPreload = document.createElement('link');
            fontPreload.rel = 'preload';
            fontPreload.href = 'https://fonts.gstatic.com/s/materialsymbolsoutlined/v232/kJESBvYX7BgnkSrUwT8OhrdQw4oELdPIeeII9v6oDMzBwG-RpA6RzaxHMO1WwbppMw.woff2';
            fontPreload.as = 'font';
            fontPreload.type = 'font/woff2';
            fontPreload.crossOrigin = 'anonymous';
            document.head.appendChild(fontPreload);
            console.log('Material Symbols font preloaded - elements found on page');
          } catch (err) {
            console.error('Failed to preload font:', err);
          }
        } else {
          console.log('No Material Symbols elements found on page, skipping preload');
        }
        return hasSymbols;
      })();
    `).then(hasSymbols => {
      // Only inject the font-face if the page uses Material Symbols
      if (hasSymbols) {
        contentWindow.webContents.insertCSS(`
          /* Font optimization */
          @font-face {
            font-family: 'Material Symbols Outlined';
            font-style: normal;
            font-weight: 400;
            font-display: swap; /* Use 'swap' instead of 'block' for better performance */
            src: url(https://fonts.gstatic.com/s/materialsymbolsoutlined/v232/kJESBvYX7BgnkSrUwT8OhrdQw4oELdPIeeII9v6oDMzBwG-RpA6RzaxHMO1WwbppMw.woff2) format('woff2');
          }
        `).catch(err => console.error('Failed to inject font CSS:', err));
      }
    }).catch(err => console.error('Error executing font detection script:', err));
    
    // Inject script to intercept link clicks for chat URLs
    contentWindow.webContents.executeJavaScript(`
      (function() {
        // Function to handle clicks on all links
        document.addEventListener('click', function(e) {
          // Find clicked link
          let target = e.target;
          while(target && target.tagName !== 'A') {
            target = target.parentElement;
          }
          
          // If a link was clicked
          if (target && target.tagName === 'A') {
            const href = target.getAttribute('href');
            if (href) {
              // For chat links, let the event pass through normally
              // The will-navigate handler will handle it
              if (href.includes('/chat/') || 
                  href.startsWith('https://flow-desc.chat.edison.onereach.ai/')) {
                console.log('Chat link clicked:', href);
                // We don't need to do anything here - just log
              }
            }
          }
        }, true);
        
        console.log('Link click interceptor installed');
        return true;
      })();
    `).catch(err => console.error('Failed to inject link handler script:', err));
    
    contentWindow.webContents.insertCSS(`
      ::-webkit-scrollbar {
        width: 6px;
        height: 6px;
      }
      
      ::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.2);
        border-radius: 3px;
      }
      
      ::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
      }
      
      ::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.2);
      }
    `).catch(err => console.error('Failed to inject scrollbar CSS:', err));
  });

  // Monitor for unexpected new windows
  contentWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log('External content attempted to open new window:', url);
    
    // For chat URLs, navigate the current window instead of opening a new one
    if (url.includes('/chat/') || 
        url.startsWith('https://flow-desc.chat.edison.onereach.ai/')) {
      console.log('Chat URL detected, navigating current window to:', url);
      
      // Handle this URL manually by loading it in the current window
      setTimeout(() => {
        contentWindow.loadURL(url).catch(err => {
          console.error('Failed to load chat URL in current window:', err);
        });
      }, 0);
      
      // Prevent default window creation
      return { action: 'deny' };
    }
    
    // Only allow URLs that match our expected domains for external browser
    if (url.startsWith('https://idw.edison.onereach.ai/')) {
      // Open non-chat IDW URLs in the default browser
      shell.openExternal(url).catch(err => {
        console.error('Failed to open external URL:', err);
      });
    }
    
    // Prevent the app from opening the window directly
    return { action: 'deny' };
  });

  return contentWindow;
}

// Function to open a URL in the main window
function openURLInMainWindow(url) {
  // Use the browserWindow module to open the URL
  browserWindow.openURLInMainWindow(url);
}

// Log app launch (before app is ready)
app.on('will-finish-launching', () => {
  console.log('[App] Will finish launching...');
});

// Function to create the main window and setup app
app.whenReady().then(() => {
  // Re-initialize logger now that app is ready
  logger = getLogger();
  
  // Log app ready
  logger.logAppReady();
  console.log('App is ready, re-initialized logger. Is stub?', logger._isStub);
  
  // Initialize AI log analyzer
  const getLogAIAnalyzer = require('./log-ai-analyzer');
  const logAIAnalyzer = getLogAIAnalyzer();
  console.log('AI log analyzer initialized');
  
  // Initialize test context manager
  const testContextManager = require('./test-context-manager');
  
  // Set up test context IPC handlers
  ipcMain.on('test:set-context', (event, context) => {
    testContextManager.setContext(context);
  });
  
  ipcMain.on('test:clear-context', (event) => {
    testContextManager.clearContext();
  });
  
  // Disable the CSP warning in development mode since we're intentionally using unsafe-eval
  // for the IDW application which requires it for proper functioning
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
  
  // Explicitly set the application icon
  try {
    // Use the tray icon for all platforms as it's consistently available
    const iconPath = path.join(__dirname, 'assets/tray-icon.png');
    
    console.log(`Setting application icon from: ${iconPath}`);
    // On macOS, set the dock icon
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(iconPath);
    }
  } catch (err) {
    console.error('Failed to set application icon:', err);
  }
  
  // Set up console interceptor for main process
  createConsoleInterceptor(logger, { 
    process: 'main',
    pid: process.pid 
  });
  // Use logger directly to avoid console interceptor loop
  logger.info('Console interceptor initialized for main process');
  
  // Set up module manager IPC handlers
  setupModuleManagerIPC();
  
  // CRITICAL: Register menu-action handler EARLY (before menu is created)
  console.log('[Main] Registering menu-action handler early...');
  // REMOVED: Early menu-action handler for IDW URLs
  // This was causing duplicate tab opens because setupIPC() also has a menu-action handler
  // The setupIPC handler at line 3734 already handles 'open-idw-url' with better URL cleaning
  console.log('[Main] ✅ Skipping early menu-action handler (handled in setupIPC)');

  // Log app startup with lifecycle event
  logger.logAppLaunch({
    startTime: new Date().toISOString(),
    workingDirectory: process.cwd(),
    execPath: app.getPath('exe'),
    userDataPath: app.getPath('userData')
  });
  
  // Add test logs to verify logging works
  logger.info('Test log message 1 - This is a test info log');
  logger.warn('Test log message 2 - This is a test warning');
  logger.error('Test log message 3 - This is a test error');
  logger.debug('Test log message 4 - This is a test debug log');
  
  // Force flush logs
  if (logger.flush) {
    logger.flush();
  }
  
  // Log the log directory path
  console.log('Logger directory:', logger.logDir);
  console.log('Current log file:', logger.currentLogFile);

  // Create the main window
  createWindow();
  logger.logWindowCreated('main', 1, {
    bounds: { width: 1400, height: 900 },
    url: 'index.html'
  });
  
  // Initialize clipboard manager after app is ready
  clipboardManager = new ClipboardManager();
  // clipboardManager.registerShortcut(); // DISABLED: Cmd+Shift+V conflicts with system shortcuts
  global.clipboardManager = clipboardManager;
  console.log('Clipboard manager initialized (shortcut disabled)');
  logger.logFeatureUsed('clipboard-manager', {
    status: 'initialized',
    shortcutRegistered: true
  });
  
  // Add keyboard shortcuts to open dev tools
  const openDevTools = () => {
    console.log('Opening Developer Tools via shortcut');
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow) {
      focusedWindow.webContents.openDevTools();
    } else {
      const allWindows = BrowserWindow.getAllWindows();
      if (allWindows.length > 0) {
        allWindows[0].webContents.openDevTools();
      }
    }
  };
  
  globalShortcut.register('CommandOrControl+Shift+I', openDevTools);
  globalShortcut.register('F12', openDevTools);
  console.log('Registered Cmd+Shift+I and F12 shortcuts for Developer Tools');
  
  // Initialize module manager
  moduleManager = new ModuleManager();
  global.moduleManager = moduleManager;
  // Make updateApplicationMenu globally available for module manager
  global.updateApplicationMenu = updateApplicationMenu;
  console.log('Module manager initialized');
  logger.logFeatureUsed('module-manager', {
    status: 'initialized',
    modulesPath: moduleManager.modulesPath
  });
  
  // Initialize settings manager
  const { getSettingsManager } = require('./settings-manager');
  global.settingsManager = getSettingsManager();
  console.log('Settings manager initialized');
  
  // MIGRATION: Migrate idw-entries.json to settings manager if needed
  try {
    const idwConfigPath = path.join(app.getPath('userData'), 'idw-entries.json');
    const currentIDWs = global.settingsManager.get('idwEnvironments');
    
    if (!currentIDWs || currentIDWs.length === 0) {
      // No IDWs in settings, check if file exists
      if (fs.existsSync(idwConfigPath)) {
        console.log('[Migration] Found idw-entries.json, migrating to settings...');
        const fileData = JSON.parse(fs.readFileSync(idwConfigPath, 'utf8'));
        global.settingsManager.set('idwEnvironments', fileData);
        console.log('[Migration] ✅ Migrated', fileData.length, 'IDW environments to settings');
      }
    } else {
      console.log('[Migration] Settings already has', currentIDWs.length, 'IDW environments');
      // Ensure file is in sync
      fs.writeFileSync(idwConfigPath, JSON.stringify(currentIDWs, null, 2));
      console.log('[Migration] ✅ Synced settings to file');
    }
  } catch (error) {
    console.error('[Migration] Error during IDW migration:', error);
  }
  
  // Make logger globally available
  global.logger = logger;
  
  // Initialize module API bridge
  const { getModuleAPIBridge } = require('./module-api-bridge');
  const moduleAPIBridge = getModuleAPIBridge();
  console.log('Module API bridge initialized');
  logger.info('Module API bridge initialized');
  
  // Set up permission handlers for microphone access (voice mode)
  const { session } = require('electron');
  
  // Handle permission requests globally
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    console.log(`Permission requested: ${permission} from ${webContents.getURL()}`);
    
    // Allow microphone for voice mode
    if (permission === 'media' || permission === 'audioCapture' || permission === 'microphone') {
      console.log(`Allowing ${permission} permission`);
      callback(true);
    } else if (permission === 'notifications') {
      console.log('Allowing notifications permission');
      callback(true);
    } else if (permission === 'clipboard-read') {
      console.log('Allowing clipboard-read permission');
      callback(true);
    } else {
      console.log(`Denying ${permission} permission`);
      callback(false);
    }
  });
  
  // Also handle permission checks
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    console.log(`Permission check: ${permission} from ${webContents ? webContents.getURL() : 'unknown'}`);
    
    // Allow microphone and related permissions
    if (permission === 'media' || permission === 'audioCapture' || permission === 'microphone') {
      return true;
    } else if (permission === 'notifications') {
      return true;
    } else if (permission === 'clipboard-read') {
      return true;
    }
    
    return false;
  });
  
  // Create and setup IPC handlers  
  console.log('[Main] About to call setupIPC');
  try {
    setupIPC();
    console.log('[Main] setupIPC completed successfully');
  } catch (error) {
    console.error('[Main] Error in setupIPC:', error);
    console.error('[Main] Stack trace:', error.stack);
  }
  
  // Add a global context menu handler as a fallback for all webviews
  app.on('web-contents-created', (event, contents) => {
    console.log('[Main] New web contents created, type:', contents.getType());
    
    // Add context menu to webviews and windows (excluding the main window)
    if (contents.getType() === 'webview' || (contents.getType() === 'window' && !contents.getURL().includes('tabbed-browser.html'))) {
      console.log('[Main] Adding fallback context menu handler to', contents.getType());
      
      // Add a small delay to avoid conflicts with specific handlers
      setTimeout(() => {
        // Check if this webview already has a context menu handler
        if (!contents.listenerCount('context-menu')) {
          console.log('[Main] No existing context menu handler found, adding fallback');
          
          contents.on('context-menu', (event, params) => {
            console.log('[Main] Fallback context menu triggered at:', params.x, params.y);
            event.preventDefault();
            
            // Create context menu with "Paste to Black Hole" option
            const contextMenu = Menu.buildFromTemplate([
              {
                label: 'Paste to Black Hole',
                click: () => {
                  console.log('[Main] Fallback: Paste to Black Hole clicked');
                  
                  // Get clipboard manager from global
                  if (global.clipboardManager) {
                    // Get the browser window that contains this webview
                    const win = BrowserWindow.fromWebContents(event.sender);
                    if (win) {
                      const bounds = win.getBounds();
                      const position = {
                        x: bounds.x + params.x,
                        y: bounds.y + params.y
                      };
                      
                      // Pass true as second parameter to show in expanded mode with space chooser
                      global.clipboardManager.createBlackHoleWindow(position, true);
                      
                      // Send clipboard content after a delay
                      setTimeout(() => {
                        const { clipboard } = require('electron');
                        const text = clipboard.readText();
                        if (text && global.clipboardManager && global.clipboardManager.blackHoleWindow) {
                          global.clipboardManager.blackHoleWindow.webContents.send('paste-content', {
                            type: 'text',
                            content: text
                          });
                        }
                      }, 300);
                    }
                  }
                }
              }
            ]);
            
            // Use setImmediate to ensure the menu shows after all other handlers
            setImmediate(() => {
              const win = BrowserWindow.fromWebContents(event.sender);
              if (win) {
                contextMenu.popup({
                  window: win,
                  x: params.x,
                  y: params.y
                });
              }
            });
          });
        } else {
          console.log('[Main] Webview already has', contents.listenerCount('context-menu'), 'context menu handler(s), skipping fallback');
        }
      }, 100);
    }
  });
  
  // Initialize SmartExport and set up its IPC handlers
  const SmartExport = require('./smart-export');
  global.smartExport = new SmartExport();
  global.smartExport.setupIpcHandlers();
  console.log('SmartExport initialized and IPC handlers set up');
  
  // Initialize rollback manager
  rollbackManager.init().then(() => {
    console.log('Rollback manager initialized');
  }).catch(err => {
    console.error('Failed to initialize rollback manager:', err);
  });
  
  // Set application menu (menu is already set in createWindow, so we can skip this duplicate call)
  // Commenting out duplicate menu setup that was overriding the Share menu
  console.log('[Main] Application menu already set in createWindow');
  /*
  try {
    setApplicationMenu();
    console.log('[Main] Application menu set successfully');
  } catch (error) {
    console.error('[Main] Error setting application menu:', error);
    console.error('[Main] Stack trace:', error.stack);
  }
  */
  
  // Register test menu shortcut
  console.log('[Main] Registering test menu shortcut');
  registerTestMenuShortcut();
  
  // Register global shortcuts after menu is set up
  try {
    registerGlobalShortcuts();
    console.log('Global shortcuts registered');
  } catch (error) {
    console.error('Error registering global shortcuts:', error);
  }
  
  // Set up auto updater
  setupAutoUpdater();
  
  // Check for updates in the background (non-blocking)
  setTimeout(() => {
    if (app.isPackaged) {
      checkForUpdates();
    } else {
      log.info('Not checking for updates in development mode');
    }
  }, 3000);  // 3 second delay
  
  // Auto-open onboarding wizard for demo/first-time experience
  setTimeout(() => {
    console.log('Auto-opening onboarding wizard...');
    openOnboardingWizard();
  }, 2000);  // 2 second delay after launch
  
  // Initialize menus once the window is fully loaded
  const mainWindow = browserWindow.getMainWindow();
  if (mainWindow) {
    mainWindow.webContents.on('did-finish-load', () => {
      // Wait a bit to ensure all scripts are loaded and localStorage is accessible
      setTimeout(() => {
        // Load IDW environments from config file and save to localStorage
        try {
          let idwEnvironments = [];
          if (fs.existsSync(idwConfigPath)) {
            idwEnvironments = JSON.parse(fs.readFileSync(idwConfigPath, 'utf8'));
            console.log('Loading IDW environments from config:', idwEnvironments);
            
            // Save to localStorage in renderer process
            mainWindow.webContents.executeJavaScript(`
              localStorage.setItem('idwEnvironments', ${JSON.stringify(JSON.stringify(idwEnvironments))});
              console.log('Saved IDW environments to localStorage:', ${JSON.stringify(JSON.stringify(idwEnvironments))});
            `).catch(err => console.error('Error saving IDW environments to localStorage:', err));
          }
          
          // Also load GSX links from file if it exists
          const gsxLinksPath = path.join(app.getPath('userData'), 'gsx-links.json');
          if (fs.existsSync(gsxLinksPath)) {
            try {
              const gsxLinks = JSON.parse(fs.readFileSync(gsxLinksPath, 'utf8'));
              console.log('Loading GSX links from config:', gsxLinks);
              
              // Save to localStorage in renderer process
              mainWindow.webContents.executeJavaScript(`
                localStorage.setItem('gsxLinks', ${JSON.stringify(JSON.stringify(gsxLinks))});
                console.log('Saved GSX links to localStorage:', ${JSON.stringify(JSON.stringify(gsxLinks))});
              `).catch(err => console.error('Error saving GSX links to localStorage:', err));
              
              // Update the menu with environments (the menu system will look up the GSX links file)
              updateApplicationMenu(idwEnvironments);
            } catch (error) {
              console.error('Error parsing GSX links file:', error);
            }
          } else {
            console.log('No GSX links file found at:', gsxLinksPath);
            updateApplicationMenu(idwEnvironments);
          }
        } catch (error) {
          console.error('Error loading configuration:', error);
        }
        
        // Debug IDW environments to see what's available
        debugIDWEnvironments();
      }, 1000); // 1 second delay
    });
  }
  
  // Check if we should open the test window directly (from command line argument)
  if (process.argv.includes('--test')) {
    console.log('Opening test window directly from command line argument');
    setTimeout(() => {
      openDataTestPage();
    }, 1500); // Longer delay to ensure main window is ready
  }
  
  // On macOS, re-create a window when dock icon is clicked and no other windows are open
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  
  // Add a 'before-quit' event handler to save tab state
  app.on('before-quit', () => {
    console.log('App is about to quit, saving tab state');
    logger.logAppQuit('user-initiated');
    
    const mainWindow = browserWindow.getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send('save-tabs-state');
      
      // Small delay to ensure the save completes
      const start = Date.now();
      while (Date.now() - start < 100) {
        // Wait for a short time to allow saving to complete
      }
    }
  });
  
  // Screen sharing feature removed – do not start local signalling server
});

// Quit when all windows are closed, except on macOS where it's common for applications 
// to stay open until the user quits explicitly with Cmd + Q
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Clean up clipboard manager on quit
app.on('will-quit', () => {
  logger.info('App will quit - cleaning up resources');
  
  if (clipboardManager) {
    clipboardManager.destroy();
    console.log('Clipboard manager cleaned up');
    logger.info('Clipboard manager destroyed');
  }
  
  // Unregister only our tracked shortcuts
  registeredShortcuts.forEach(shortcut => {
    try {
      globalShortcut.unregister(shortcut);
    } catch (e) {
      console.error(`Error unregistering shortcut ${shortcut}:`, e);
    }
  });
  console.log('Global shortcuts unregistered');
  logger.info('Global shortcuts unregistered', {
    shortcutsCount: registeredShortcuts.length
  });
  
  // Final flush of logs before quit
  if (logger && logger.flush) {
    logger.flush();
  }
});

// Set up module manager IPC handlers
function setupModuleManagerIPC() {
  const ModuleEvaluator = require('./module-evaluator');
  const evaluator = new ModuleEvaluator();
  
  // Get installed modules
  ipcMain.handle('module:get-installed', async () => {
    return global.moduleManager.getInstalledModules();
  });
  
  // Open module
  ipcMain.handle('module:open', async (event, moduleId) => {
    try {
      global.moduleManager.openModule(moduleId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Uninstall module
  ipcMain.handle('module:uninstall', async (event, moduleId) => {
    try {
      global.moduleManager.removeModule(moduleId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Install from URL
  ipcMain.handle('module:install-from-url', async (event, url) => {
    try {
      const manifest = await global.moduleManager.installModuleFromUrl(url);
      return { success: true, manifest };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Install from file
  ipcMain.handle('module:install-from-file', async (event, filePath) => {
    try {
      const manifest = await global.moduleManager.installModuleFromZip(filePath);
      return { success: true, manifest };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Evaluate module
  ipcMain.handle('module:evaluate', async (event, zipPath) => {
    try {
      const evaluation = await evaluator.evaluateZip(zipPath);
      return { success: true, evaluation };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // AI Review module
  ipcMain.handle('module:ai-review', async (event, zipPath) => {
    try {
      const ModuleAIReviewer = require('./module-ai-reviewer');
      const aiReviewer = new ModuleAIReviewer();
      const result = await aiReviewer.reviewAndFix(zipPath);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Check if Claude API is configured
  ipcMain.handle('module:check-claude-api', async () => {
    const { getSettingsManager } = require('./settings-manager');
    const settingsManager = getSettingsManager();
    
    // Check for new llmConfig structure first
    const llmConfig = settingsManager.get('llmConfig');
    if (llmConfig && llmConfig.anthropic && llmConfig.anthropic.apiKey) {
      return true;
    }
    
    // Fallback to legacy structure
    const apiKey = settingsManager.get('llmApiKey');
    return !!apiKey;
  });
  
  // Generate AI review report
  ipcMain.handle('module:generate-ai-report', async (event, result) => {
    try {
      const ModuleAIReviewer = require('./module-ai-reviewer');
      const aiReviewer = new ModuleAIReviewer();
      return await aiReviewer.generateFixReport(result.review, result.verification);
    } catch (error) {
      throw error;
    }
  });
  
  // Refresh menu
  ipcMain.on('refresh-menu', () => {
    updateApplicationMenu();
  });
  
  // Download module to temp location for validation
  ipcMain.handle('module:download-temp', async (event, url) => {
    try {
      const https = require('https');
      const http = require('http');
      const fs = require('fs');
      const path = require('path');
      const { app } = require('electron');
      
      // Create temp file path
      const tempDir = app.getPath('temp');
      const tempFile = path.join(tempDir, `module-${Date.now()}.zip`);
      
      return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(tempFile);
        const protocol = url.startsWith('https') ? https : http;
        
        protocol.get(url, (response) => {
          if (response.statusCode !== 200) {
            reject(new Error(`Failed to download: ${response.statusCode}`));
            return;
          }
          
          response.pipe(file);
          
          file.on('finish', () => {
            file.close();
            resolve({ success: true, path: tempFile });
          });
        }).on('error', (err) => {
          fs.unlink(tempFile, () => {});
          reject(err);
        });
      });
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // IDW Store handlers
  console.log('[setupModuleManagerIPC] Registering IDW Store handlers');
  
  // Fetch IDW directory from API
  ipcMain.handle('idw-store:fetch-directory', async () => {
    try {
      console.log('[IDW Store] Fetching directory from API...');
      const https = require('https');
      
      const options = {
        hostname: 'em.staging.api.onereach.ai',
        port: 443,
        path: '/http/48cc49ef-ab05-4d51-acc6-559c7ff22150/idw_directory',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 10000
      };
      
      return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
          console.log('[IDW Store] Response status:', res.statusCode);
          
          let data = '';
          
          res.on('data', (chunk) => {
            data += chunk;
          });
          
          res.on('end', () => {
            console.log('[IDW Store] Response received, length:', data.length);
            
            try {
              const jsonData = JSON.parse(data);
              console.log('[IDW Store] Successfully parsed JSON');
              resolve(jsonData);
            } catch (error) {
              console.error('[IDW Store] Failed to parse response:', error);
              reject(new Error('Invalid JSON response from API'));
            }
          });
        });
        
        req.on('error', (error) => {
          console.error('[IDW Store] API request failed:', error);
          reject(error);
        });
        
        req.on('timeout', () => {
          console.error('[IDW Store] Request timeout');
          req.destroy();
          reject(new Error('Request timeout'));
        });
        
        req.write(JSON.stringify({}));
        req.end();
      });
    } catch (error) {
      console.error('[IDW Store] Error fetching directory:', error);
      return { success: false, error: { message: error.message } };
    }
  });
  
  // Add IDW to menu from store
  ipcMain.handle('idw-store:add-to-menu', async (event, idw) => {
    try {
      console.log('[IDW Store] Adding IDW to menu:', idw.name);
      
      // Get from settings manager (single source of truth)
      const settingsManager = global.settingsManager;
      let idwEnvironments = settingsManager.get('idwEnvironments') || [];
      console.log('[IDW Store] Current IDWs in settings:', idwEnvironments.length);
      
      // Check if this IDW is already installed
      const storeIdwId = `store-${idw.id}`;
      const existingIndex = idwEnvironments.findIndex(env => {
        if (env.id === storeIdwId) return true;
        if (env.storeData && env.storeData.idwId === idw.id) return true;
        if (env.chatUrl === idw.url) return true;
        if (env.label === idw.name && env.storeData && env.storeData.developer === idw.developer) return true;
        return false;
      });
      
      if (existingIndex !== -1) {
        console.log('[IDW Store] IDW already exists, updating...');
        idwEnvironments[existingIndex] = {
          id: storeIdwId,
          label: idw.name,
          chatUrl: idw.url,
          environment: 'store',
          description: idw.description,
          category: idw.category,
          storeData: {
            idwId: idw.id,
            developer: idw.developer,
            version: idw.version,
            installedAt: idwEnvironments[existingIndex].storeData?.installedAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        };
        
        // Save to settings
        settingsManager.set('idwEnvironments', idwEnvironments);
        console.log('[IDW Store] ✅ Saved update to settings');
        
        // CRITICAL: Also sync to idw-entries.json for menu
        const idwConfigPath = path.join(app.getPath('userData'), 'idw-entries.json');
        fs.writeFileSync(idwConfigPath, JSON.stringify(idwEnvironments, null, 2));
        console.log('[IDW Store] ✅ Synced to idw-entries.json');
        
        // Refresh menu
        const { refreshApplicationMenu } = require('./menu');
        refreshApplicationMenu();
        console.log('[IDW Store] ✅ Menu refreshed');
        
        return { success: true, updated: true };
      }
      
      // Add new IDW
      const newEntry = {
        id: storeIdwId,
        label: idw.name,
        chatUrl: idw.url,
        environment: 'store',
        description: idw.description,
        category: idw.category,
        storeData: {
          idwId: idw.id,
          developer: idw.developer,
          version: idw.version,
          installedAt: new Date().toISOString()
        }
      };
      
      idwEnvironments.push(newEntry);
      
      // Save to settings
      settingsManager.set('idwEnvironments', idwEnvironments);
      console.log('[IDW Store] ✅ Saved to settings, total:', idwEnvironments.length);
      
      // CRITICAL: Also sync to idw-entries.json for menu
      const idwConfigPath = path.join(app.getPath('userData'), 'idw-entries.json');
      fs.writeFileSync(idwConfigPath, JSON.stringify(idwEnvironments, null, 2));
      console.log('[IDW Store] ✅ Synced to idw-entries.json');
      
      // Refresh menu
      const { refreshApplicationMenu } = require('./menu');
      refreshApplicationMenu();
      console.log('[IDW Store] ✅ Menu refreshed');
      
      return { success: true, updated: false };
    } catch (error) {
      console.error('[IDW Store] Failed to add IDW to menu:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Web Tools handlers
  
  // Get all web tools
  ipcMain.handle('module:get-web-tools', async () => {
    return global.moduleManager.getWebTools();
  });
  
  // Add web tool
  ipcMain.handle('module:add-web-tool', async (event, tool) => {
    try {
      global.moduleManager.addWebTool(tool);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Open web tool
  ipcMain.handle('module:open-web-tool', async (event, toolId) => {
    try {
      global.moduleManager.openWebTool(toolId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Delete web tool
  ipcMain.handle('module:delete-web-tool', async (event, toolId) => {
    try {
      global.moduleManager.deleteWebTool(toolId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

// Set up IPC handlers for communication with renderer process
function setupIPC() {
  console.log('[setupIPC] Function called');
  
  // Initialize GSX File Sync handlers
  try {
    const gsxFileSync = getGSXFileSync();
    gsxFileSync.setupIPC();
    console.log('[setupIPC] GSX File Sync IPC handlers registered');
  } catch (error) {
    console.error('[setupIPC] Failed to setup GSX File Sync:', error);
  }
  
  // Settings IPC handlers
  console.log('[setupIPC] Setting up settings handlers');
  
  // Mission Control trigger for GSX toolbar
  ipcMain.on('trigger-mission-control', () => {
    const { exec } = require('child_process');
    exec('open -a "Mission Control"');
    console.log('[IPC] Mission Control triggered from GSX toolbar');
  });
  
  ipcMain.handle('settings:get-all', async () => {
    const settingsManager = global.settingsManager;
    if (!settingsManager) {
      console.error('Settings manager not initialized');
      return {};
    }
    return settingsManager.getAll();
  });
  
  ipcMain.handle('settings:save', async (event, settings) => {
    const settingsManager = global.settingsManager;
    if (!settingsManager) {
      console.error('Settings manager not initialized');
      return false;
    }
    
    // Log settings change (without sensitive values)
    logger.logSettingsChanged('multiple-settings', 'updated', 'updated');
    logger.info('Settings saved', {
      event: 'settings:saved',
      settingsCount: Object.keys(settings).length
    });
    
    const saved = settingsManager.update(settings);
    
    // If idwEnvironments was updated, also write to idw-entries.json for menu compatibility
    if (settings.idwEnvironments) {
      console.log('[Settings] idwEnvironments updated, syncing to idw-entries.json...');
      try {
        const idwConfigPath = path.join(app.getPath('userData'), 'idw-entries.json');
        fs.writeFileSync(idwConfigPath, JSON.stringify(settings.idwEnvironments, null, 2));
        console.log('[Settings] ✅ Synced', settings.idwEnvironments.length, 'IDW environments to file');
        
        // Refresh menu with new data
        const { refreshApplicationMenu } = require('./menu');
        refreshApplicationMenu();
        console.log('[Settings] ✅ Menu refreshed');
      } catch (error) {
        console.error('[Settings] Error syncing idwEnvironments to file:', error);
      }
    }
    
    return saved;
  });
  
  ipcMain.handle('settings:test-llm', async (event, config) => {
    // Test LLM connection
    try {
      // Simple test - just verify the API key format
      // In a real implementation, you would make a test API call
      if (!config.apiKey) {
        return { success: false, error: 'API key is required' };
      }
      
      // Basic validation for different providers
      switch (config.provider) {
        case 'openai':
          if (!config.apiKey.startsWith('sk-')) {
            return { success: false, error: 'Invalid OpenAI API key format' };
          }
          break;
        case 'anthropic':
          if (!config.apiKey.startsWith('sk-ant-')) {
            return { success: false, error: 'Invalid Anthropic API key format' };
          }
          break;
        // Add more provider validations as needed
      }
      
      // If we get here, assume the key is valid
      // In production, make an actual API call to test
      return { success: true };
    } catch (error) {
      console.error('Error testing LLM connection:', error);
      return { success: false, error: error.message };
    }
  });
  
  // GSX sync-all handler (for sync now button)
  ipcMain.handle('gsx:sync-all', async () => {
    try {
      const gsxFileSync = getGSXFileSync();
      const results = await gsxFileSync.syncMultiple();
      return { success: true, results };
    } catch (error) {
      console.error('GSX sync-all failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Event logging IPC handlers
  ipcMain.handle('log:event', async (event, eventType, eventData) => {
    logger.logEvent(eventType, eventData);
    return { success: true };
  });
  
  ipcMain.handle('log:tab-created', async (event, tabId, url, metadata) => {
    logger.logTabCreated(tabId, url, metadata);
    return { success: true };
  });
  
  ipcMain.handle('log:tab-closed', async (event, tabId, url) => {
    logger.logTabClosed(tabId, url);
    return { success: true };
  });
  
  ipcMain.handle('log:tab-switched', async (event, fromTab, toTab) => {
    logger.logTabSwitched(fromTab, toTab);
    return { success: true };
  });
  
  ipcMain.handle('log:window-navigation', async (event, windowId, url, from) => {
    logger.logWindowNavigation(windowId, url, from);
    return { success: true };
  });
  
  ipcMain.handle('log:feature-used', async (event, featureName, metadata) => {
    logger.logFeatureUsed(featureName, metadata);
    return { success: true };
  });
  
  // GSX test connection handler with token from settings
  // Wrapped in try-catch to skip if already registered by GSX File Sync
  try {
    ipcMain.handle('gsx:test-connection', async (event, config) => {
      try {
        console.log('[Main] Testing GSX connection with config:', {
          hasToken: !!config.token,
          tokenLength: config.token ? config.token.length : 0,
          environment: config.environment,
        hasAccountId: !!config.accountId
      });
      
      const settingsManager = global.settingsManager;
      if (config.token) {
        // Temporarily save the token to test it
        console.log('[Main] Saving token to settings (length:', config.token.length, ')');
        settingsManager.set('gsxToken', config.token);
        settingsManager.set('gsxEnvironment', config.environment || 'production');
        
        if (config.accountId) {
          console.log('[Main] Saving account ID:', config.accountId);
          settingsManager.set('gsxAccountId', config.accountId);
        }
      }
      
      // Verify token was saved
      const savedToken = settingsManager.get('gsxToken');
      console.log('[Main] Token after save - Type:', typeof savedToken, 'Length:', savedToken ? savedToken.length : 0);
      
      const gsxFileSync = getGSXFileSync();
      const result = await gsxFileSync.testConnection();
      
      console.log('[Main] Test connection result:', result);
      
      if (!result.success && config.token) {
        // If test failed, clear the temporary token
        console.log('[Main] Test failed, clearing token');
        settingsManager.set('gsxToken', '');
      }
      
      return result;
      } catch (error) {
        console.error('[Main] GSX connection test failed:', error);
        return { success: false, error: error.message };
      }
    });
  } catch (error) {
    console.log('[setupIPC] Skipping gsx:test-connection (already registered by GSX File Sync)');
  }
  
  // Smart export IPC handlers
  ipcMain.handle('get-smart-export-data', async () => {
    console.log('[Main] get-smart-export-data called, returning:', global.smartExportData ? 'data exists' : 'null');
    return global.smartExportData || null;
  });
  
  ipcMain.handle('generate-smart-export', async (event, data) => {
    try {
      // Use the global smartExport instance
      const result = await global.smartExport.generateSmartExport(data.space, data.items, data.options || {});
      
      // Store spaceData in the result for regeneration
      result.spaceData = data;
      
      return result;
    } catch (error) {
      console.error('Error generating smart export:', error);
      throw error;
    }
  });
  
  ipcMain.handle('generate-basic-export', async (event, data) => {
    try {
      const PDFGenerator = require('./pdf-generator');
      const generator = new PDFGenerator();
      
      const html = generator.generateSpaceHTML(data.space, data.items, {
        includeMetadata: true,
        includeTimestamps: true,
        includeTags: true
      });
      
      return {
        html,
        metadata: {
          model: 'basic',
          timestamp: new Date().toISOString(),
          itemCount: data.items.length,
          spaceName: data.space.name
        },
        spaceData: data
      };
    } catch (error) {
      console.error('Error generating basic export:', error);
      throw error;
    }
  });
  
  ipcMain.handle('save-smart-export-html', async (event, html, metadata) => {
    try {
      const { dialog } = require('electron');
      const fs = require('fs');
      
      const result = await dialog.showSaveDialog({
        title: 'Save Smart Export as HTML',
        defaultPath: `${metadata.spaceName}_export.html`,
        filters: [
          { name: 'HTML Files', extensions: ['html'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      
      if (!result.canceled) {
        fs.writeFileSync(result.filePath, html, 'utf8');
        shell.showItemInFolder(result.filePath);
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('Error saving HTML:', error);
      throw error;
    }
  });
  
  // Template handlers
  ipcMain.handle('get-export-templates', async () => {
    const { getTemplateManager } = require('./template-manager');
    const templateManager = getTemplateManager();
    return templateManager.getAllTemplates();
  });
  
  ipcMain.handle('get-export-template', async (event, templateId) => {
    const { getTemplateManager } = require('./template-manager');
    const templateManager = getTemplateManager();
    return templateManager.getTemplate(templateId);
  });
  
  ipcMain.handle('save-export-template', async (event, template) => {
    const { getTemplateManager } = require('./template-manager');
    const templateManager = getTemplateManager();
    templateManager.saveTemplate(template);
    return { success: true };
  });
  
  // Helper function to generate HTML preview thumbnail
  function generateHTMLPreviewThumbnail(title) {
    // Create an SVG that looks like an HTML document preview
    const svg = `
      <svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
        <rect width="400" height="300" fill="#f5f5f5" stroke="#ddd" stroke-width="1"/>
        <rect x="20" y="20" width="360" height="40" fill="#4285f4" rx="4"/>
        <text x="200" y="45" text-anchor="middle" fill="white" font-family="system-ui" font-size="16" font-weight="500">HTML Document</text>
        <text x="200" y="100" text-anchor="middle" fill="#333" font-family="system-ui" font-size="14">${title}</text>
        <rect x="40" y="130" width="120" height="8" fill="#e0e0e0" rx="4"/>
        <rect x="40" y="150" width="320" height="8" fill="#e0e0e0" rx="4"/>
        <rect x="40" y="170" width="280" height="8" fill="#e0e0e0" rx="4"/>
        <rect x="40" y="190" width="300" height="8" fill="#e0e0e0" rx="4"/>
        <rect x="40" y="210" width="240" height="8" fill="#e0e0e0" rx="4"/>
        <circle cx="360" cy="270" r="15" fill="#4285f4"/>
        <text x="360" y="275" text-anchor="middle" fill="white" font-family="system-ui" font-size="16" font-weight="bold">✨</text>
      </svg>
    `;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

  ipcMain.handle('save-to-space', async (event, content) => {
    try {
      console.log('[Main] save-to-space called with content:', content.type, content.spaceId);
      
      // Get the clipboard manager instance
      if (!global.clipboardManager) {
        throw new Error('Clipboard manager not initialized');
      }
      
      const clipboardManager = global.clipboardManager;
      
      // Create the item to save
      const item = {
        type: 'html',
        content: content.content,
        html: content.content,
        text: content.title || 'Generated Document',
        plainText: content.title || 'Generated Document',
        preview: content.title || 'Generated Document',
        timestamp: Date.now(),
        pinned: false,
        spaceId: content.spaceId || 'unclassified',
        source: 'smart-export',
        metadata: {
          ...content.metadata,
          type: 'generated-document',
          isGenerated: true,
          title: content.title || 'Generated Document'
        },
        tags: ['generated', 'ai-document'],
        // Add a thumbnail that shows it's an HTML document
        thumbnail: generateHTMLPreviewThumbnail(content.title || 'Generated Document')
      };
      
      console.log('[Main] Adding item to clipboard history');
      
      // Add to clipboard history
      clipboardManager.addToHistory(item);
      
      // Notify all clipboard viewers to refresh
      const allWindows = BrowserWindow.getAllWindows();
      const clipboardWindows = allWindows.filter(win => 
        win.webContents.getURL().includes('clipboard-viewer.html')
      );
      
      clipboardWindows.forEach(win => {
        win.webContents.send('clipboard:history-updated');
      });
      
      return true;
    } catch (error) {
      console.error('[Main] Error saving to space:', error);
      return false;
    }
  });
  
  ipcMain.handle('get-spaces', async (event) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      // Get spaces from the index
      const spaces = storage.index.spaces || [];
      return spaces;
    } catch (error) {
      console.error('Error getting spaces:', error);
      return [];
    }
  });
  
  ipcMain.handle('save-smart-export-pdf', async (event, html, metadata) => {
    try {
      const { dialog } = require('electron');
      const PDFGenerator = require('./pdf-generator');
      
      const result = await dialog.showSaveDialog({
        title: 'Export Smart Export as PDF',
        defaultPath: `${metadata.spaceName}_export.pdf`,
        filters: [
          { name: 'PDF Files', extensions: ['pdf'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      
      if (!result.canceled) {
        const generator = new PDFGenerator();
        await generator.generatePDFFromHTML(html, result.filePath);
        await generator.cleanup();
        
        shell.showItemInFolder(result.filePath);
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('Error saving PDF:', error);
      throw error;
    }
  });
  
  ipcMain.handle('analyze-website-styles', async (event, urls, options) => {
    try {
      console.log('Analyzing website styles for URLs:', urls);
      
      const WebStyleAnalyzer = require('./web-style-analyzer');
      const analyzer = new WebStyleAnalyzer();
      
      const result = await analyzer.analyzeStyles(urls, options);
      
      return result;
    } catch (error) {
      console.error('Error analyzing website styles:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });
  
  // Style guide management
  const styleGuidesPath = path.join(app.getPath('userData'), 'style-guides.json');
  
  ipcMain.handle('get-style-guides', async () => {
    try {
      if (fs.existsSync(styleGuidesPath)) {
        const data = fs.readFileSync(styleGuidesPath, 'utf8');
        return JSON.parse(data);
      }
      return {};
    } catch (error) {
      console.error('Error loading style guides:', error);
      return {};
    }
  });
  
  ipcMain.handle('save-style-guide', async (event, guide) => {
    try {
      let guides = {};
      if (fs.existsSync(styleGuidesPath)) {
        const data = fs.readFileSync(styleGuidesPath, 'utf8');
        guides = JSON.parse(data);
      }
      
      guides[guide.id] = guide;
      
      fs.writeFileSync(styleGuidesPath, JSON.stringify(guides, null, 2), 'utf8');
      
      return { success: true };
    } catch (error) {
      console.error('Error saving style guide:', error);
      return { success: false, error: error.message };
    }
  });
  
  ipcMain.handle('delete-style-guide', async (event, id) => {
    try {
      let guides = {};
      if (fs.existsSync(styleGuidesPath)) {
        const data = fs.readFileSync(styleGuidesPath, 'utf8');
        guides = JSON.parse(data);
      }
      
      delete guides[id];
      
      fs.writeFileSync(styleGuidesPath, JSON.stringify(guides, null, 2), 'utf8');
      
      return { success: true };
    } catch (error) {
      console.error('Error deleting style guide:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Add handler for desktop sources (screen capture)
  ipcMain.handle('get-desktop-sources', async () => {
    try {
      console.log('Getting desktop sources for screen capture...');
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 150, height: 150 }
      });
      console.log(`Found ${sources.length} desktop sources`);
      return sources.map(source => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL()
      }));
    } catch (error) {
      console.error('Error getting desktop sources:', error);
      throw error;
    }
  });

  // Logger IPC handlers
  ipcMain.handle('logger:get-recent-logs', async (event, count) => {
    try {
      console.log('IPC: logger:get-recent-logs called with count:', count);
      
      // Get fresh logger instance
      const getLogger = require('./event-logger');
      const currentLogger = getLogger();
      
      // Check if logger exists
      if (!currentLogger) {
        console.error('Logger not initialized!');
        throw new Error('Logger not initialized');
      }
      
      // Check if logger is a stub
      if (currentLogger._isStub) {
        console.log('Logger is still a stub, app might not be ready');
        return [];
      }
      
      currentLogger.info('Fetching recent logs', { count });
      const logs = currentLogger.getRecentLogs(count);
      console.log('Retrieved', logs.length, 'log entries');
      return logs;
    } catch (error) {
      console.error('Error in logger:get-recent-logs:', error);
      if (logger && !logger._isStub) {
        logger.error('Error getting recent logs', { error: error.message });
      }
      throw error;
    }
  });

  // Logger IPC for renderer processes
  ipcMain.on('logger:info', (event, { message, data }) => {
    logger.info(message, { ...data, source: 'renderer' });
  });

  ipcMain.on('logger:warn', (event, { message, data }) => {
    logger.warn(message, { ...data, source: 'renderer' });
  });

  ipcMain.on('logger:error', (event, { message, data }) => {
    logger.error(message, { ...data, source: 'renderer' });
  });

  ipcMain.on('logger:debug', (event, { message, data }) => {
    logger.debug(message, { ...data, source: 'renderer' });
  });

  ipcMain.on('logger:event', (event, { eventType, eventData }) => {
    logger.logEvent(eventType, { ...eventData, source: 'renderer' });
  });

  ipcMain.on('logger:user-action', (event, { action, details }) => {
    logger.logUserAction(action, { ...details, source: 'renderer' });
  });

  ipcMain.handle('logger:get-stats', async () => {
    try {
      // Get fresh logger instance
      const getLogger = require('./event-logger');
      const currentLogger = getLogger();
      
      // Check if logger exists
      if (!currentLogger || currentLogger._isStub) {
        console.error('Logger not initialized or is stub!');
        return {
          currentFile: null,
          fileSize: 0,
          totalFiles: 0
        };
      }
      
      const files = currentLogger.getLogFiles();
      const currentFile = files[0];
      return {
        currentFile: currentFile?.name,
        fileSize: currentFile?.size || 0,
        totalFiles: files.length
      };
    } catch (error) {
      console.error('Error getting log stats:', error);
      throw error;
    }
  });

  ipcMain.handle('logger:export', async (event, options) => {
    try {
      // Get fresh logger instance
      const getLogger = require('./event-logger');
      const currentLogger = getLogger();
      
      if (!currentLogger || currentLogger._isStub) {
        console.error('Logger not initialized or is stub!');
        throw new Error('Logger not available');
      }
      
      currentLogger.info('Exporting logs', { options });
      
      let startDate, endDate;
      
      // Parse time range
      if (options.timeRange === 'all') {
        startDate = new Date(0);
        endDate = new Date();
      } else {
        const hours = parseInt(options.timeRange);
        endDate = new Date();
        startDate = new Date(Date.now() - hours * 60 * 60 * 1000);
      }
      
      const logs = await currentLogger.exportLogs({
        startDate,
        endDate,
        includeDebug: options.includeDebug,
        format: options.format
      });
      
      // Save to file
      const { dialog } = require('electron');
      const extension = options.format === 'json' ? 'json' : 'txt';
      const result = await dialog.showSaveDialog({
        title: 'Export Logs',
        defaultPath: `onereach-logs-${new Date().toISOString().split('T')[0]}.${extension}`,
        filters: [
          { name: options.format === 'json' ? 'JSON Files' : 'Text Files', extensions: [extension] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      
      if (!result.canceled) {
        const content = options.format === 'json' ? JSON.stringify(logs, null, 2) : logs;
        fs.writeFileSync(result.filePath, content, 'utf8');
        shell.showItemInFolder(result.filePath);
      }
      
      return { success: true };
    } catch (error) {
      console.error('Error exporting logs:', error);
      throw error;
    }
  });

  ipcMain.handle('logger:get-files', async () => {
    try {
      // Get fresh logger instance
      const getLogger = require('./event-logger');
      const currentLogger = getLogger();
      
      if (!currentLogger || currentLogger._isStub) {
        console.error('Logger not initialized or is stub!');
        return [];
      }
      
      return currentLogger.getLogFiles();
    } catch (error) {
      console.error('Error getting log files:', error);
      throw error;
    }
  });

  // Add handler for IDW environments request
  ipcMain.on('idw-environments-response', (event, environments) => {
    console.log(`Received IDW environments from renderer: ${environments ? environments.length : 0} items`);
    if (environments && environments.length > 0) {
      updateApplicationMenu(environments);
    } else {
      // If no environments in localStorage, try reading from file as fallback
      try {
        if (fs.existsSync(idwConfigPath)) {
          const data = fs.readFileSync(idwConfigPath, 'utf8');
          const idwEnvironments = JSON.parse(data);
          console.log(`Found ${idwEnvironments.length} IDW environments in config file`);
          updateApplicationMenu(idwEnvironments);
        } else {
          console.log('No IDW environments config file found');
        }
      } catch (error) {
        console.error('Error reading IDW environments from file:', error);
      }
    }
  });
  
  // Handle user actions from the renderer
  ipcMain.on('user-action', (event, data) => {
    console.log('Received user action:', data);
    logger.logUserAction(data.action || 'unknown', data);
    
    // Handle settings window opening
    if (data && data.action === 'open-settings') {
      console.log('Opening settings window from user action');
      logger.logMenuAction('open-settings');
      openSettingsWindow();
      return;
    }
    
    // Handle IDW menu update
    if (data && data.action === 'update-idw-menu' && data.environments) {
      console.log(`Updating IDW menu with environments: ${data.environments.length}`);
      const { setApplicationMenu } = require('./menu');
      setApplicationMenu(data.environments);
      console.log('IDW menu updated with ' + data.environments.length + ' environments');
    }
    
    // Handle GSX links refresh specifically
    if (data && data.action === 'refresh-gsx-links') {
      console.log('Refreshing GSX links in menu by request from renderer process');
      try {
        // Import the refreshGSXLinks function if not already available
        const { refreshGSXLinks } = require('./menu');
        
        // Force GSX links refresh
        const success = refreshGSXLinks();
        console.log(`GSX links refresh: ${success ? 'succeeded' : 'failed'}`);
        
        // Also set the application menu again with the current environments
        // This provides a double-refresh mechanism to ensure the menu updates
        let idwEnvironments = [];
        try {
          const userDataPath = app.getPath('userData');
          const idwConfigPath = path.join(userDataPath, 'idw-entries.json');
          
          if (fs.existsSync(idwConfigPath)) {
            const idwData = fs.readFileSync(idwConfigPath, 'utf8');
            idwEnvironments = JSON.parse(idwData);
            console.log(`Loaded ${idwEnvironments.length} IDW environments for menu refresh`);
            
            // Set the menu again with the loaded environments
            const { setApplicationMenu } = require('./menu');
            setApplicationMenu(idwEnvironments);
          }
        } catch (error) {
          console.error('Error loading IDW environments for menu refresh:', error);
        }
        
        // Get a reference to the main window
        const { getMainWindow } = require('./browserWindow');
        const mainWindow = getMainWindow();
        
        // If we have a main window, let it know the menu was refreshed
        if (mainWindow) {
          mainWindow.webContents.send('menu-refreshed', { success, timestamp: new Date().toISOString() });
        }
      } catch (error) {
        console.error('Error refreshing GSX links menu:', error);
      }
    }
    
    // Handle other custom actions here
    if (data.action === 'open-idw-url' && data.url) {
      console.log(`Opening IDW URL: ${data.url}`);
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (mainWindow) {
        mainWindow.loadURL(data.url);
      }
    } else if (data.action === 'open-external-bot' && data.url) {
      // Handle external bot opening in separate windows
      openExternalAIWindow(data.url, data.label || 'External AI', {
        width: 1400,
        height: 900
      });
      return;
    } else if (data.action === 'close-setup-wizard') {
      console.log('Closing setup wizard window');
      // Find the BrowserWindow that sent this message
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) {
        win.close();
      }
      return;
    }
    
    // Handle IDW URL opening
    if (data.action === 'open-idw-url' && data.url) {
      console.log(`Opening IDW URL in new tab: ${data.label} (${data.url})`);
      
      // Extract environment from URL
      let environment = 'unknown';
      try {
        const urlObj = new URL(data.url);
        const hostParts = urlObj.hostname.split('.');
        environment = hostParts.find(part => 
          ['staging', 'edison', 'production'].includes(part)
        ) || 'unknown';
      } catch (err) {
        console.error('Error extracting environment from URL:', err);
      }
      
      // Log IDW environment opening
      logger.info('IDW Environment Opened', {
        event: 'idw:opened',
        environment: environment,
        url: data.url,
        label: data.label || 'IDW',
        openedIn: 'tab',
        timestamp: new Date().toISOString()
      });
      
      // Get the main window
      const mainWindow = browserWindow.getMainWindow();
      if (mainWindow) {
        // Send to main window to open in a new tab
        mainWindow.webContents.send('open-in-new-tab', {
          url: data.url,
          label: data.label || 'IDW'
        });
      } else {
        console.error('Main window not found, cannot open IDW URL');
      }
      return;
    }
    
        // Handle image creator opening - open in separate window
    if (data.action === 'open-image-creator' && data.url) {
      console.log('Opening image creator in separate window:', data.label, data.url);
      openExternalAIWindow(data.url, data.label || 'Image Creator', {
        width: 1400,
        height: 900
      });
      return;
    }
    
    // Handle video creator opening - open in separate window (removed duplicate tab handler)
    if (data.action === 'open-video-creator' && data.url) {
      console.log('Opening video creator in separate window:', data.label, data.url);
      openExternalAIWindow(data.url, data.label || 'Video Creator', {
        width: 1400,
        height: 900
      });
      return;
    }
    
    // Handle audio generator opening
    if (data.action === 'open-audio-generator' && data.url) {
      console.log('Opening audio generator in new tab:', data.label, data.url);
      
      // Log the AI tab opening
      logger.info('Personal AI Opened in Tab', {
        event: 'ai:opened',
        service: data.label || 'Audio Generator',
        type: 'audio-generation',
        url: data.url,
        category: data.category,
        openedIn: 'tab',
        timestamp: new Date().toISOString()
      });
      
      // Get the main window
      const mainWindow = browserWindow.getMainWindow();
      if (mainWindow) {
        // Send to main window to open in a new tab
        mainWindow.webContents.send('open-in-new-tab', {
          url: data.url,
          label: data.label || 'Audio Generator',
          isAudioGenerator: true,
          category: data.category
        });
      } else {
        console.error('Main window not found, cannot open audio generator URL');
      }
      return;
    }
    
    // Handle UI design tool opening - open in separate window
    if (data.action === 'open-ui-design-tool' && data.url) {
      console.log('Opening UI design tool in separate window:', data.label, data.url);
      openExternalAIWindow(data.url, data.label || 'UI Design Tool', {
        width: 1400,
        height: 900
      });
      return;
    }
    
    // Pass all other menu actions to the main window to handle
    const mainWindow = browserWindow.getMainWindow();
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('menu-action', data);
    }
  });
  
  // Direct handler for opening the setup wizard
  ipcMain.on('open-setup-wizard', () => {
    console.log('Received direct request to open setup wizard');
    openSetupWizard();
  });
  
  // Handler for closing wizard windows
  ipcMain.on('close-wizard', () => {
    console.log('Received request to close wizard');
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
      if (win.getTitle().includes('Welcome') || win.getTitle().includes('Wizard')) {
        win.close();
      }
    });
  });
  
  // Direct handler for opening the settings window
  ipcMain.on('open-settings', () => {
    console.log('Received direct request to open settings window');
    openSettingsWindow();
  });
  
  // Add notification handler
  ipcMain.on('show-notification', (event, data) => {
    const mainWindow = browserWindow.getMainWindow();
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('show-notification', data);
    }
  });
  
  // Handle context menu requests
  ipcMain.on('show-context-menu', (event, data) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      // Check if this is a webview context menu request
      if (data.webviewId !== undefined) {
        console.log('[Main] Showing context menu for webview:', data.webviewId);
        
        // Create context menu with "Paste to Black Hole" option
        const contextMenu = Menu.buildFromTemplate([
          {
            label: 'Paste to Black Hole',
            click: () => {
              console.log('[Main] Paste to Black Hole clicked from webview context menu');
              
              // Get clipboard manager from global
              if (global.clipboardManager) {
                // Get window bounds to position the black hole widget
                const bounds = win.getBounds();
                const position = {
                  x: bounds.x + data.x,
                  y: bounds.y + data.y
                };
                
                // Pass true as second parameter to show in expanded mode with space chooser
                global.clipboardManager.createBlackHoleWindow(position, true);
                
                // Send clipboard content after a delay
                setTimeout(() => {
                  const { clipboard } = require('electron');
                  const text = clipboard.readText();
                  if (text && global.clipboardManager && global.clipboardManager.blackHoleWindow) {
                    global.clipboardManager.blackHoleWindow.webContents.send('paste-content', {
                      type: 'text',
                      content: text
                    });
                  }
                }, 300);
              }
            }
          }
        ]);
        
        contextMenu.popup({
          window: win,
          x: data.x,
          y: data.y
        });
      } else {
        // Original template-based context menu
        const menu = Menu.buildFromTemplate(data);
        menu.popup({ window: win });
      }
    }
  });
  
  // Handle opening clipboard viewer from widgets
  ipcMain.on('open-clipboard-viewer', async () => {
    console.log('Received request to open clipboard viewer');
    
    // Ensure clipboard manager is initialized
    const ensureClipboardManager = async () => {
      if (global.clipboardManager) {
        return true;
      }
      
      if (!app.isReady()) {
        console.log('App not ready, waiting...');
        await app.whenReady();
      }
      
      try {
        console.log('Initializing clipboard manager on demand');
        const ClipboardManager = require('./clipboard-manager-v2-adapter');
        global.clipboardManager = new ClipboardManager();
        // global.clipboardManager.registerShortcut(); // DISABLED: Cmd+Shift+V conflicts with system shortcuts
        console.log('Clipboard manager initialized successfully (shortcut disabled)');
        return true;
      } catch (error) {
        console.error('Failed to initialize clipboard manager:', error);
        return false;
      }
    };
    
    // Try to ensure clipboard manager is ready
    const isReady = await ensureClipboardManager();
    if (isReady && global.clipboardManager) {
      console.log('Clipboard manager ready, creating window');
      global.clipboardManager.createClipboardWindow();
    } else {
      console.error('Failed to initialize clipboard manager');
      const { dialog } = require('electron');
      dialog.showErrorBox('Error', 'Failed to open Spaces Knowledge Manager. Please try again.');
    }
  });

  // Handle opening external URLs from renderer
  ipcMain.on('open-external-url', (event, url) => {
    console.log('Opening external URL:', url);
    const { shell } = require('electron');
    if (url && url.startsWith('http')) {
      shell.openExternal(url);
    }
  });
  
  // Handle fetching user lessons
  ipcMain.handle('fetch-user-lessons', async (event, userId) => {
    try {
      console.log(`[Main] Fetching lessons for user: ${userId}`);
      
      // Create a new instance to ensure settings are reloaded
      delete require.cache[require.resolve('./lessons-api')];
      const lessonsAPI = require('./lessons-api');
      
      // If no userId provided, try to get from settings
      if (!userId) {
        userId = global.settingsManager?.get('userId') || 'default-user';
      }
      
      const lessons = await lessonsAPI.fetchUserLessons(userId);
      
      // The API already returns { success: true, ... data ... }
      // So if it has a success field, return it directly
      if (lessons && typeof lessons.success !== 'undefined') {
        console.log('[Main] API returned success field, using API response directly');
        // If API call succeeded but returned success: false, treat as error
        if (!lessons.success) {
          return { success: false, error: lessons.error || 'API returned error' };
        }
        // Return the API response but ensure it has the expected structure
        return { success: true, data: lessons };
      }
      
      // Otherwise wrap it (for mock data or different format)
      return { success: true, data: lessons };
    } catch (error) {
      console.error('[Main] Error fetching lessons:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Handle updating lesson progress
  ipcMain.handle('update-lesson-progress', async (event, lessonId, progress) => {
    try {
      console.log(`[Main] Updating progress for lesson ${lessonId}: ${progress}%`);
      // Store progress locally
      const progressKey = `lessonProgress_${lessonId}`;
      global.settingsManager?.set(progressKey, progress);
      
      // In future, also sync with API
      // const lessonsAPI = require('./lessons-api');
      // await lessonsAPI.updateProgress(lessonId, progress);

      return { success: true };
    } catch (error) {
      console.error('[Main] Error updating lesson progress:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Handle logging lesson clicks
  ipcMain.handle('log-lesson-click', async (event, logData) => {
    try {
      // Log to event logger with detailed information
      if (logger && logger.info) {
        logger.info('Lesson Click', {
          action: logData.action,
          lessonId: logData.lessonId,
          title: logData.title,
          category: logData.category,
          difficulty: logData.difficulty,
          duration: logData.duration,
          url: logData.url,
          userProgress: logData.userProgress,
          userLevel: logData.userLevel,
          timestamp: logData.timestamp
        });
      }
      
      // Also log to console for immediate visibility
      console.log('[Main] Lesson clicked:', {
        title: logData.title,
        category: logData.category,
        lessonId: logData.lessonId,
        url: logData.url
      });
      
      // Store lesson view history
      const viewHistoryKey = 'lessonViewHistory';
      const viewHistory = global.settingsManager?.get(viewHistoryKey) || [];
      viewHistory.unshift({
        lessonId: logData.lessonId,
        title: logData.title,
        viewedAt: logData.timestamp
      });
      // Keep only last 50 viewed lessons
      if (viewHistory.length > 50) {
        viewHistory.splice(50);
      }
      global.settingsManager?.set(viewHistoryKey, viewHistory);
      
      // Track analytics if needed (future enhancement)
      // await analyticsService.track('lesson_click', logData);
      
      return { success: true };
    } catch (error) {
      console.error('[Main] Error logging lesson click:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Handle getting current user ID
  ipcMain.handle('get-current-user', async () => {
    try {
      // Get user ID from settings or use default
      const userId = global.settingsManager?.get('userId') || 'default-user';
      const userName = global.settingsManager?.get('userName') || 'User';
      
      return { 
        success: true, 
        data: { id: userId, name: userName }
      };
    } catch (error) {
      console.error('[Main] Error getting current user:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Handle opening black hole widget
  ipcMain.on('open-black-hole-widget', (event, position) => {
    console.log('Received request to open black hole widget at position:', position);
    if (global.clipboardManager) {
      console.log('Clipboard manager exists, creating black hole window');
      global.clipboardManager.createBlackHoleWindow(position);
    } else {
      console.error('Clipboard manager not initialized yet');
      // Try to initialize it if app is ready
      if (app.isReady()) {
        const ClipboardManager = require('./clipboard-manager-v2-adapter');
        global.clipboardManager = new ClipboardManager();
        // global.clipboardManager.registerShortcut(); // DISABLED: Cmd+Shift+V conflicts with system shortcuts
        console.log('Clipboard manager initialized on demand (shortcut disabled)');
        global.clipboardManager.createBlackHoleWindow(position);
      } else {
        console.error('App not ready, cannot initialize clipboard manager');
      }
    }
  });

  // Handle closing black hole widget
  ipcMain.on('close-black-hole-widget', () => {
    console.log('Received request to close black hole widget');
    if (global.clipboardManager && global.clipboardManager.blackHoleWindow) {
      if (!global.clipboardManager.blackHoleWindow.isDestroyed()) {
        console.log('Closing black hole window');
        global.clipboardManager.blackHoleWindow.close();
      }
    }
  });

  // Handle black hole widget active state (space chooser open)
  ipcMain.on('black-hole:active', () => {
    console.log('Black hole widget is active (space chooser open)');
    // Notify all browser windows that black hole is active
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('black-hole-active');
    });
  });

  // Handle black hole widget inactive state (space chooser closed)
  ipcMain.on('black-hole:inactive', (event, options = {}) => {
    console.log('Black hole widget is inactive (space chooser closed)', options);
    // Notify all browser windows that black hole is inactive
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('black-hole-inactive');
    });
    
    // If this was from a download operation, close the black hole window
    // to prevent the transparent bubble from lingering
    if (options.closeWindow || options.fromDownload) {
      console.log('Closing black hole window after download operation');
      if (global.clipboardManager && global.clipboardManager.blackHoleWindow) {
        if (!global.clipboardManager.blackHoleWindow.isDestroyed()) {
          global.clipboardManager.blackHoleWindow.close();
          global.clipboardManager.blackHoleWindow = null;
        }
      }
    }
  });

  // Handle show black hole request
  ipcMain.on('show-black-hole', (event) => {
    console.log('Received request to show black hole');
    if (global.clipboardManager) {
      // Get the main window position
      const mainWindow = browserWindow.getMainWindow();
      if (mainWindow) {
        const bounds = mainWindow.getBounds();
        const position = {
          x: bounds.x + bounds.width - 100,
          y: bounds.y + 100
        };
        global.clipboardManager.createBlackHoleWindow(position);
      } else {
        // Default position if no main window
        global.clipboardManager.createBlackHoleWindow({ x: 100, y: 100 });
      }
    }
  });

  // Handle paste to black hole
  ipcMain.on('paste-to-black-hole', (event, data) => {
    console.log('Received paste-to-black-hole:', data);
    if (global.clipboardManager && global.clipboardManager.blackHoleWindow) {
      // Send the paste data to the black hole window
      global.clipboardManager.blackHoleWindow.webContents.send('paste-content', data);
    }
  });
  
  // Handle trigger paste in black hole widget
  ipcMain.on('black-hole:trigger-paste', () => {
    console.log('Received request to trigger paste in black hole widget');
    if (global.clipboardManager && global.clipboardManager.blackHoleWindow) {
      if (!global.clipboardManager.blackHoleWindow.isDestroyed()) {
        const { clipboard, nativeImage } = require('electron');
        
        // Read clipboard content
        const text = clipboard.readText();
        const html = clipboard.readHTML();
        const image = clipboard.readImage();
        
        console.log('Clipboard content - Text:', !!text, 'HTML:', !!html, 'Image:', !image.isEmpty());
        
        // Focus the window first
        global.clipboardManager.blackHoleWindow.focus();
        
        // Prepare clipboard data to send
        const clipboardData = {
          hasText: !!text,
          hasHtml: !!html,
          hasImage: !image.isEmpty(),
          text: text,
          html: html
        };
        
        // If there's an image, convert it to data URL
        if (!image.isEmpty()) {
          clipboardData.imageDataUrl = image.toDataURL();
        }
        
        // Send clipboard data to the widget
        global.clipboardManager.blackHoleWindow.webContents.send('paste-clipboard-data', clipboardData);
        console.log('Sent clipboard data to black hole widget');
      }
    }
  });

  // Handle get clipboard text request
  ipcMain.on('get-clipboard-text', (event) => {
    try {
      const { clipboard } = require('electron');
      const text = clipboard.readText();
      event.sender.send('clipboard-text-result', text);
    } catch (error) {
      console.error('Error reading clipboard:', error);
      event.sender.send('clipboard-text-result', '');
    }
  });

  // Handle closing content windows
  ipcMain.on('close-content-window', (event) => {
    // Find the BrowserWindow that sent this message
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      console.log('Closing content window from IPC request');
      win.close();
    }
  });
  
  // Handle tab actions
  ipcMain.on('tab-action', (event, data) => {
    console.log('Received tab action:', data);
    
    if (data.action === 'open-url') {
      // Get the main window
      const mainWindow = browserWindow.getMainWindow();
      if (mainWindow) {
        // Send the URL to the renderer to open in a new tab
        mainWindow.webContents.send('open-in-new-tab', data.url);
      }
    }
  });
  
  // Handle webContents setup for direct control of window opening
  ipcMain.on('setup-webcontents-handlers', (event, data) => {
    console.log('Received setup-webcontents-handlers with data:', data);
    
    if (!data.webContentsId) {
      console.error('No webContentsId provided in setup-webcontents-handlers');
      return;
    }
    
    try {
      // Get a reference to the webContents
      const { webContents } = require('electron');
      const contents = webContents.fromId(data.webContentsId);
      
      if (!contents) {
        console.error('Could not find webContents with ID:', data.webContentsId);
        return;
      }
      
      // Add context menu handler for this webview
      console.log(`[Main] Adding context menu handler for webview ${data.tabId}`);
      contents.on('context-menu', (event, params) => {
        console.log(`[Webview ${data.tabId}] Context menu requested at:`, params.x, params.y);
        event.preventDefault();
        
        // Create context menu with "Paste to Black Hole" option
        const contextMenu = Menu.buildFromTemplate([
          {
            label: 'Paste to Black Hole',
            click: () => {
              console.log(`[Webview ${data.tabId}] Paste to Black Hole clicked`);
              
              // Get clipboard manager from global
              if (global.clipboardManager) {
                // Get the browser window that contains this webview
                const win = BrowserWindow.fromWebContents(event.sender);
                if (win) {
                  const bounds = win.getBounds();
                  const position = {
                    x: bounds.x + params.x,
                    y: bounds.y + params.y
                  };
                  
                  // Pass true as second parameter to show in expanded mode with space chooser
                  global.clipboardManager.createBlackHoleWindow(position, true);
                  
                  // Send clipboard content after a delay
                  setTimeout(() => {
                    const { clipboard } = require('electron');
                    const text = clipboard.readText();
                    if (text && global.clipboardManager && global.clipboardManager.blackHoleWindow) {
                      global.clipboardManager.blackHoleWindow.webContents.send('paste-content', {
                        type: 'text',
                        content: text
                      });
                    }
                  }, 300);
                }
              }
            }
          }
        ]);
        
        // Use setImmediate to ensure the menu shows after all other handlers
        setImmediate(() => {
          const win = BrowserWindow.fromWebContents(event.sender);
          if (win) {
            contextMenu.popup({
              window: win,
              x: params.x,
              y: params.y
            });
          }
        });
      });
      
      // Set up handlers directly on the webContents
      console.log('Setting up window.open handler for webContents ID:', data.webContentsId);
      
      // If this is a ChatGPT webview, set up enhanced permissions
      if (data.isChatGPT) {
        console.log('[ChatGPT] Setting up enhanced permissions for webContents ID:', data.webContentsId);
        
        // Set permission request handler for this specific webContents session
        contents.session.setPermissionRequestHandler((webContents, permission, callback) => {
          console.log(`[ChatGPT webview] Permission requested: ${permission}`);
          
          // Auto-allow all permissions for ChatGPT
          if (permission === 'media' || 
              permission === 'audioCapture' || 
              permission === 'microphone' ||
              permission === 'camera' ||
              permission === 'notifications' ||
              permission === 'clipboard-read' ||
              permission === 'clipboard-write') {
            console.log(`[ChatGPT webview] Auto-allowing ${permission} permission`);
            callback(true);
          } else {
            console.log(`[ChatGPT webview] Denying ${permission} permission`);
            callback(false);
          }
        });
        
        // Also set permission check handler
        contents.session.setPermissionCheckHandler((webContents, permission) => {
          console.log(`[ChatGPT webview] Permission check: ${permission}`);
          
          if (permission === 'media' || 
              permission === 'audioCapture' || 
              permission === 'microphone' ||
              permission === 'camera' ||
              permission === 'notifications' ||
              permission === 'clipboard-read' ||
              permission === 'clipboard-write') {
            return true;
          }
          
          return false;
        });
        
        // Set user agent to match Chrome
        const chromeVersion = process.versions.chrome;
        const userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
        contents.setUserAgent(userAgent);
        
        // Modify request headers to avoid Electron detection
        contents.session.webRequest.onBeforeSendHeaders((details, callback) => {
          // Remove or modify headers that might reveal Electron
          const headers = { ...details.requestHeaders };
          
          // Ensure proper user agent
          headers['User-Agent'] = userAgent;
          
          // Remove any Electron-specific headers
          delete headers['X-Electron'];
          
          // Add headers that Chrome would send
          if (!headers['Accept-Language']) {
            headers['Accept-Language'] = 'en-US,en;q=0.9';
          }
          
          if (!headers['Accept-Encoding']) {
            headers['Accept-Encoding'] = 'gzip, deflate, br';
          }
          
          callback({ requestHeaders: headers });
        });
      }
      
      // Set up window open handler
      contents.setWindowOpenHandler(({ url, frameName, features, disposition }) => {
        console.log('WebContents window open handler intercepted URL:', url, 'disposition:', disposition);
        
        // For authentication URLs, allow popup windows
        if (url.includes('accounts.google.com') || 
            url.includes('sso.global.api.onereach.ai') || 
            url.includes('auth.edison.onereach.ai') ||
            url.includes('login.onereach.ai') ||
            url.includes('login.edison.onereach.ai') ||
            url.includes('oauth') ||
            url.includes('/auth/') ||
            url.includes('firebase') ||
            url.includes('elevenlabs.io')) {
          console.log('Auth URL detected in webContents, allowing popup window:', url);
          console.log('Using parent session partition:', contents.session.partition);
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              width: 800,
              height: 600,
              webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                partition: contents.session.partition // Use same session/partition as parent
              }
            }
          };
        }
        
        // For non-chat and non-auth URLs, send a message to open in a new tab
        const mainWindow = browserWindow.getMainWindow();
        if (mainWindow) {
          setTimeout(() => {
            mainWindow.webContents.send('open-in-new-tab', url);
          }, 0);
        }
        
        // Deny other popup attempts
        return { action: 'deny' };
      });
      
      // Set up download handler for this webview
      console.log('Setting up download handler for webContents ID:', data.webContentsId);
      contents.session.on('will-download', (event, item, webContents) => {
        console.log(`[Webview] Download detected in tab ${data.tabId}`);
        // Use the handleDownloadWithSpaceOption function from browserWindow
        browserWindow.handleDownloadWithSpaceOption(item, `Tab ${data.tabId}`);
      });
      
      // Listen for will-navigate events
      contents.on('will-navigate', (event, url) => {
        console.log('WebContents will-navigate event for URL:', url);
        
        // Check if it's a chat URL
        const isChatUrl = url.includes('/chat/') || url.startsWith('https://flow-desc.chat.edison.onereach.ai/');
        
        // Check if it's an auth URL
        const isAuthUrl = url.includes('accounts.google.com') || 
                         url.includes('sso.global.api.onereach.ai') || 
                         url.includes('auth.edison.onereach.ai') ||
                         url.includes('login.onereach.ai') ||
                         url.includes('login.edison.onereach.ai');
        
        // Check if it's a callback URL after authentication
        const isCallbackUrl = url.includes('/callback') && url.includes('sso.global.api.onereach.ai');
        
        // Handle chat URLs specially
        if (isChatUrl) {
          console.log('Allowing navigation to chat URL in same webContents:', url);
          return; // Allow the navigation
        }
        
        // For auth URLs, allow navigation in current tab
        if (isAuthUrl) {
          console.log('Allowing auth navigation in current tab:', url);
          return; // Allow the navigation
        }
        
        // Handle callback URLs
        if (isCallbackUrl) {
          console.log('Detected SSO callback URL, allowing navigation:', url);
          return; // Allow the navigation
        }
        
        // For all other URLs, allow the navigation by default
      });
      
      // Add a handler for postMessage events
      contents.on('ipc-message', (event, channel, ...args) => {
        console.log('Received IPC message:', channel, args);
        
        if (channel === 'postMessage') {
          const message = args[0];
          console.log('Processing postMessage:', message);
          
          // Handle auth-popup messages
          if (message && message.type === 'auth-popup') {
            console.log('Creating auth popup window for URL:', message.url);
            
            // Create a popup window for authentication
            const authWindow = new BrowserWindow({
              width: 800,
              height: 600,
              webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                webSecurity: true,
                webviewTag: true,
                preload: path.join(__dirname, 'preload.js')
              }
            });
            
            // Load the authentication URL
            authWindow.loadURL(message.url);
            
            // Handle successful authentication
            authWindow.webContents.on('will-navigate', (event, url) => {
              if (url.includes('/callback') && url.includes('sso.global.api.onereach.ai')) {
                console.log('Detected SSO callback URL in popup:', url);
                // Send success message to the main window
                const mainWindow = browserWindow.getMainWindow();
                if (mainWindow) {
                  mainWindow.webContents.send('sso-success', {
                    type: 'sso',
                    action: 'success',
                    redirectUrl: 'https://idw.edison.onereach.ai/idw-marvin-dev'
                  });
                }
                // Close the popup window
                authWindow.close();
              }
            });
          }
          
          // Handle SSO messages
          if (message && message.type === 'sso') {
            console.log('Processing SSO message:', message);
            if (message.action === 'success') {
              // Send success message to renderer
              const mainWindow = browserWindow.getMainWindow();
              if (mainWindow) {
                mainWindow.webContents.send('sso-success', {
                  type: 'sso',
                  action: 'success',
                  redirectUrl: 'https://my.onereach.ai/'
                });
              }
            }
          }
        }
      });
      
      console.log('Successfully set up handlers for webContents ID:', data.webContentsId);
    } catch (error) {
      console.error('Error setting up webContents handlers:', error);
    }
  });

  // Handle get-idw-environments request
  ipcMain.on('get-idw-environments', (event) => {
    try {
      const idwConfig = JSON.parse(fs.readFileSync(idwConfigPath, 'utf8'));
      event.reply('get-idw-environments', idwConfig);
    } catch (error) {
      console.error('Error reading IDW config file:', error);
      event.reply('get-idw-environments', []);
    }
  });

  // Handle synchronous get-idw-entries request
  ipcMain.on('get-idw-entries', (event) => {
    try {
      if (fs.existsSync(idwConfigPath)) {
        const idwConfig = JSON.parse(fs.readFileSync(idwConfigPath, 'utf8'));
        event.returnValue = idwConfig;
      } else {
        event.returnValue = [];
      }
    } catch (error) {
      console.error('Error reading IDW entries:', error);
      event.returnValue = [];
    }
  });

  // Handle get-external-bots request
  ipcMain.on('get-external-bots', (event) => {
    try {
      const botsPath = path.join(app.getPath('userData'), 'external-bots.json');
      if (fs.existsSync(botsPath)) {
        const botsData = fs.readFileSync(botsPath, 'utf8');
        const externalBots = JSON.parse(botsData);
        console.log(`Sending ${externalBots.length} external bots to renderer`);
        event.reply('get-external-bots', externalBots);
      } else {
        console.log('No external bots file found');
        event.reply('get-external-bots', []);
      }
    } catch (error) {
      console.error('Error reading external bots file:', error);
      event.reply('get-external-bots', []);
    }
  });

  // Handle get-image-creators request
  ipcMain.on('get-image-creators', (event) => {
    try {
      const creatorsPath = path.join(app.getPath('userData'), 'image-creators.json');
      if (fs.existsSync(creatorsPath)) {
        const creatorsData = fs.readFileSync(creatorsPath, 'utf8');
        const imageCreators = JSON.parse(creatorsData);
        console.log(`Sending ${imageCreators.length} image creators to renderer`);
        event.reply('get-image-creators', imageCreators);
      } else {
        console.log('No image creators file found');
        event.reply('get-image-creators', []);
      }
    } catch (error) {
      console.error('Error reading image creators file:', error);
      event.reply('get-image-creators', []);
    }
  });
  
  // Module manager handlers are now in setupModuleManagerIPC()

  // Handle get-video-creators request
  ipcMain.on('get-video-creators', (event) => {
    try {
      const creatorsPath = path.join(app.getPath('userData'), 'video-creators.json');
      if (fs.existsSync(creatorsPath)) {
        const creatorsData = fs.readFileSync(creatorsPath, 'utf8');
        const videoCreators = JSON.parse(creatorsData);
        console.log(`Sending ${videoCreators.length} video creators to renderer`);
        event.reply('get-video-creators', videoCreators);
      } else {
        console.log('No video creators file found');
        event.reply('get-video-creators', []);
      }
    } catch (error) {
      console.error('Error reading video creators file:', error);
      event.reply('get-video-creators', []);
    }
  });

  // Handle get-audio-generators request
  ipcMain.on('get-audio-generators', (event) => {
    try {
      const generatorsPath = path.join(app.getPath('userData'), 'audio-generators.json');
      if (fs.existsSync(generatorsPath)) {
        const generatorsData = fs.readFileSync(generatorsPath, 'utf8');
        const audioGenerators = JSON.parse(generatorsData);
        console.log(`Sending ${audioGenerators.length} audio generators to renderer`);
        event.reply('get-audio-generators', audioGenerators);
      } else {
        console.log('No audio generators file found');
        event.reply('get-audio-generators', []);
      }
    } catch (error) {
      console.error('Error reading audio generators file:', error);
      event.reply('get-audio-generators', []);
    }
  });

  // Direct handler for GSX links
  ipcMain.on('open-gsx-link', (event, data) => {
    console.log('Received direct request to open GSX link:', data);
    if (data && data.url) {
      console.log(`Opening GSX link directly: ${data.url}`);
      
      // Extract environment from URL if not provided in the data
      let environment = data.environment;
      if (!environment) {
        try {
          const urlObj = new URL(data.url);
          // Extract from hostname - e.g., studio.edison.onereach.ai -> edison
          const hostParts = urlObj.hostname.split('.');
          environment = hostParts.find(part => 
            ['staging', 'edison', 'production'].includes(part)
          ) || 'unknown';
        } catch (err) {
          console.error('Error parsing GSX URL to extract environment:', err);
          environment = 'unknown';
        }
      }
      
      browserWindow.openGSXWindow(data.url, data.title || 'GSX', environment);
    }
  });

  // Update handlers
  ipcMain.on('update-action', (event, data) => {
    switch (data.action) {
      case 'check':
        checkForUpdates();
        break;
      case 'download':
        downloadUpdate();
        break;
      case 'install':
        installUpdate();
        break;
      default:
        log.warn('Unknown update action:', data.action);
    }
  });

  // Also update the save-gsx-links handler to reload links immediately
  ipcMain.on('save-gsx-links', (event, links) => {
    console.log(`Received save-gsx-links event with ${links.length} links`);
    try {
      const linksJson = JSON.stringify(links, null, 2);
      fs.writeFileSync(path.join(app.getPath('userData'), 'gsx-links.json'), linksJson);
      console.log('GSX links saved to file');
      
      // After saving, refresh the menu
      const { refreshGSXLinks } = require('./menu');
      refreshGSXLinks();
      console.log('Menu refreshed after saving GSX links');
    } catch (error) {
      console.error('Error saving GSX links:', error);
    }
  });

  // Handle reading log operations
  const readingLogPath = path.join(app.getPath('userData'), 'reading-log.json');

  // Async save
  ipcMain.on('save-reading-log', (event, log) => {
    try {
      fs.writeFileSync(readingLogPath, JSON.stringify(log, null, 2), 'utf8');
      console.log('Reading log saved successfully');
    } catch (error) {
      console.error('Error saving reading log:', error);
    }
  });

  // Sync save
  ipcMain.on('save-reading-log-sync', (event, log) => {
    try {
      fs.writeFileSync(readingLogPath, JSON.stringify(log, null, 2), 'utf8');
      console.log('Reading log saved successfully (sync)');
      event.returnValue = true;
    } catch (error) {
      console.error('Error saving reading log:', error);
      event.returnValue = false;
    }
  });

  // Load reading log
  ipcMain.handle('load-reading-log', () => {
    try {
      if (fs.existsSync(readingLogPath)) {
        const data = fs.readFileSync(readingLogPath, 'utf8');
        return JSON.parse(data);
      }
      return {};
    } catch (error) {
      console.error('Error loading reading log:', error);
      return {};
    }
  });

  // Handle RSS feed requests
  ipcMain.handle('fetch-rss', async (event, url) => {
    const { net } = require('electron');
    
    return new Promise((resolve, reject) => {
      console.log('Fetching RSS content using Electron net module:', url);
      
      try {
        const request = net.request({
          method: 'GET',
          url: url
        });

        // Set appropriate headers
        request.setHeader('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        request.setHeader('Accept', 'application/rss+xml, application/xml, text/xml, */*');
        request.setHeader('Accept-Language', 'en-US,en;q=0.9');
        request.setHeader('Cache-Control', 'no-cache');

        let responseData = '';
        let redirectCount = 0;
        const maxRedirects = 5;

        // Set timeout
        const timeout = setTimeout(() => {
          request.abort();
          reject(new Error('Request timeout'));
        }, 15000);

        request.on('response', (response) => {
          console.log('Response status:', response.statusCode);
          console.log('Response headers:', response.headers);

          // Handle redirects
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            if (redirectCount >= maxRedirects) {
              clearTimeout(timeout);
              reject(new Error('Too many redirects'));
              return;
            }

            redirectCount++;
            const redirectUrl = new URL(response.headers.location, url).href;
            console.log(`Following redirect ${redirectCount}/${maxRedirects} to:`, redirectUrl);
            
            clearTimeout(timeout);
            
            // Make a new request for the redirect
            const redirectRequest = net.request({
              method: 'GET',
              url: redirectUrl
            });
            
            // Set the same headers for redirect
            redirectRequest.setHeader('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            redirectRequest.setHeader('Accept', 'application/rss+xml, application/xml, text/xml, */*');
            redirectRequest.setHeader('Accept-Language', 'en-US,en;q=0.9');
            redirectRequest.setHeader('Cache-Control', 'no-cache');
            
            // Handle the redirect response
            redirectRequest.on('response', (redirectResponse) => {
              if (redirectResponse.statusCode !== 200) {
                reject(new Error(`HTTP ${redirectResponse.statusCode}: ${redirectResponse.statusMessage}`));
                return;
              }
              
              let redirectData = '';
              redirectResponse.on('data', (chunk) => {
                redirectData += chunk.toString();
              });
              
              redirectResponse.on('end', () => {
                console.log('Redirect fetch completed, data length:', redirectData.length);
                resolve(redirectData);
              });
              
              redirectResponse.on('error', (error) => {
                reject(error);
              });
            });
            
            redirectRequest.on('error', (error) => {
              reject(error);
            });
            
            redirectRequest.end();
            return;
          }

          if (response.statusCode !== 200) {
            clearTimeout(timeout);
            reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
            return;
          }

          response.on('data', (chunk) => {
            responseData += chunk.toString();
          });

          response.on('end', () => {
            clearTimeout(timeout);
            console.log('RSS fetch completed, data length:', responseData.length);
            resolve(responseData);
          });

          response.on('error', (error) => {
            clearTimeout(timeout);
            console.error('Response error:', error);
            reject(error);
          });
        });

        request.on('error', (error) => {
          clearTimeout(timeout);
          console.error('Request error:', error);
          reject(error);
        });

        request.end();
      } catch (error) {
        console.error('Error creating request:', error);
        reject(error);
      }
    });
  });

  // Handle opening URLs in external browser
  ipcMain.handle('open-external', async (event, url) => {
    try {
      await shell.openExternal(url);
      return true;
    } catch (error) {
      console.error('Error opening external URL:', error);
      return false;
    }
  });

  // Debug handler to save fetched content to file
  ipcMain.handle('debug-save-content', async (event, url, content) => {
    try {
      const fs = require('fs');
      const path = require('path');
      
      // Create a safe filename from the URL
      const filename = url.replace(/[^a-z0-9]/gi, '_').substring(0, 50) + '.html';
      const filepath = path.join(app.getPath('userData'), 'debug_' + filename);
      
      fs.writeFileSync(filepath, content, 'utf8');
      console.log('Debug content saved to:', filepath);
      return filepath;
    } catch (error) {
      console.error('Error saving debug content:', error);
      return null;
    }
  });

  // Handle fetching article content (separate from RSS feeds)
  ipcMain.handle('fetch-article', async (event, url) => {
    const { net } = require('electron');
    
    return new Promise((resolve, reject) => {
      console.log('Fetching article content using Electron net module:', url);
      
      try {
        const request = net.request({
          method: 'GET',
          url: url
        });

        // Set appropriate headers for HTML pages
        request.setHeader('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        request.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8');
        request.setHeader('Accept-Language', 'en-US,en;q=0.9');
        request.setHeader('Cache-Control', 'no-cache');

        let responseData = '';
        let redirectCount = 0;
        const maxRedirects = 5;

        // Set timeout
        const timeout = setTimeout(() => {
          request.abort();
          reject(new Error('Request timeout'));
        }, 15000);

        request.on('response', (response) => {
          console.log('Article response status:', response.statusCode);

          // Handle redirects
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            if (redirectCount >= maxRedirects) {
              clearTimeout(timeout);
              reject(new Error('Too many redirects'));
              return;
            }

            redirectCount++;
            const redirectUrl = new URL(response.headers.location, url).href;
            console.log(`Following article redirect ${redirectCount}/${maxRedirects} to:`, redirectUrl);
            
            clearTimeout(timeout);
            
            // Make a new request for the redirect
            const redirectRequest = net.request({
              method: 'GET',
              url: redirectUrl
            });
            
            // Set the same headers for redirect
            redirectRequest.setHeader('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            redirectRequest.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8');
            redirectRequest.setHeader('Accept-Language', 'en-US,en;q=0.9');
            redirectRequest.setHeader('Cache-Control', 'no-cache');
            
            // Handle the redirect response
            redirectRequest.on('response', (redirectResponse) => {
              if (redirectResponse.statusCode !== 200) {
                reject(new Error(`HTTP ${redirectResponse.statusCode}: ${redirectResponse.statusMessage}`));
                return;
              }
              
              let redirectData = '';
              redirectResponse.on('data', (chunk) => {
                redirectData += chunk.toString();
              });
              
              redirectResponse.on('end', () => {
                console.log('Article redirect fetch completed, data length:', redirectData.length);
                resolve(redirectData);
              });
              
              redirectResponse.on('error', (error) => {
                reject(error);
              });
            });
            
            redirectRequest.on('error', (error) => {
              reject(error);
            });
            
            redirectRequest.end();
            return;
          }

          if (response.statusCode !== 200) {
            clearTimeout(timeout);
            reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
            return;
          }

          response.on('data', (chunk) => {
            responseData += chunk.toString();
          });

          response.on('end', () => {
            clearTimeout(timeout);
            console.log('Article fetch completed, data length:', responseData.length);
            
            // Calculate reading time from the fetched HTML content
            const readingTime = calculateReadingTimeFromHTML(responseData);
            console.log('🔥 CALCULATED READING TIME FROM MAIN PROCESS:', readingTime);
            
            // Return both content and reading time
            const result = {
              content: responseData,
              readingTime: readingTime,
              wordCount: getWordCount(responseData)
            };
            
            // Also send the reading time to all windows (including AI Run Times window)
            console.log('📤 SENDING READING TIME TO ALL WINDOWS:', {
              url: url,
              readingTime: readingTime,
              wordCount: getWordCount(responseData)
            });
            
            // Send to all windows to ensure AI Run Times window receives it
            const { BrowserWindow } = require('electron');
            const allWindows = BrowserWindow.getAllWindows();
            console.log(`📤 Found ${allWindows.length} windows to send reading time to`);
            
            allWindows.forEach((window, index) => {
              if (window && !window.isDestroyed()) {
                console.log(`📤 Sending reading time to window ${index + 1}`);
                window.webContents.send('article-reading-time', {
                  url: url,
                  readingTime: readingTime,
                  wordCount: getWordCount(responseData)
                });
              }
            });
            
            resolve(result);
          });

          response.on('error', (error) => {
            clearTimeout(timeout);
            console.error('Article response error:', error);
            reject(error);
          });
        });

        request.on('error', (error) => {
          clearTimeout(timeout);
          console.error('Article request error:', error);
          reject(error);
        });

        request.end();
      } catch (error) {
        console.error('Error creating article request:', error);
        reject(error);
      }
    });
  });

  // Handle saving user preferences
  ipcMain.on('save-user-preferences', (event, preferences) => {
    console.log('Saving user preferences with GSX account ID');
    try {
      const prefsPath = path.join(app.getPath('userData'), 'user-preferences.json');
      fs.writeFileSync(prefsPath, JSON.stringify(preferences, null, 2));
      console.log('User preferences saved successfully');
      
      // If GSX account ID is provided, update existing GSX links
      if (preferences.gsxAccountId) {
        const gsxLinksPath = path.join(app.getPath('userData'), 'gsx-links.json');
        
        if (fs.existsSync(gsxLinksPath)) {
          console.log('Updating existing GSX links with account ID');
          try {
            const gsxLinksData = fs.readFileSync(gsxLinksPath, 'utf8');
            const gsxLinks = JSON.parse(gsxLinksData);
            
            // Update each non-custom link with the account ID
            const updatedLinks = gsxLinks.map(link => {
              // Skip custom links - they should manage their own account IDs
              if (link.custom) {
                return link;
              }
              
              // Update the URL to include the account ID
              try {
                const url = new URL(link.url);
                const params = new URLSearchParams(url.search);
                
                // Update or add the accountId parameter
                params.set('accountId', preferences.gsxAccountId);
                url.search = params.toString();
                
                return {
                  ...link,
                  url: url.toString()
                };
              } catch (e) {
                console.error(`Error updating URL for link ${link.label}:`, e);
                // Fallback: append accountId if URL parsing fails
                const separator = link.url.includes('?') ? '&' : '?';
                return {
                  ...link,
                  url: `${link.url}${separator}accountId=${preferences.gsxAccountId}`
                };
              }
            });
            
            // Save the updated links back to file
            fs.writeFileSync(gsxLinksPath, JSON.stringify(updatedLinks, null, 2));
            console.log('GSX links updated with account ID successfully');
            
            // Refresh the menu to reflect the changes
            refreshGSXLinks();
          } catch (error) {
            console.error('Error updating GSX links with account ID:', error);
          }
        }
      }
      
      event.reply('user-preferences-saved', true);
    } catch (error) {
      console.error('Error saving user preferences:', error);
      event.reply('user-preferences-saved', false);
    }
  });

  // Handle saving external bots
  ipcMain.on('save-external-bots', (event, bots) => {
    console.log(`Saving ${bots.length} external bots`);
    try {
      const botsPath = path.join(app.getPath('userData'), 'external-bots.json');
      fs.writeFileSync(botsPath, JSON.stringify(bots, null, 2));
      console.log('External bots saved successfully');
      
      // Refresh the menu to show new bots
      const { refreshGSXLinks } = require('./menu');
      refreshGSXLinks();
      
      // Re-register global shortcuts
      registerGlobalShortcuts();
      
      event.reply('external-bots-saved', true);
    } catch (error) {
      console.error('Error saving external bots:', error);
      event.reply('external-bots-saved', false);
    }
  });
  
  // Handle saving image creators
  ipcMain.on('save-image-creators', (event, creators) => {
    console.log(`Saving ${creators.length} image creators`);
    try {
      const creatorsPath = path.join(app.getPath('userData'), 'image-creators.json');
      fs.writeFileSync(creatorsPath, JSON.stringify(creators, null, 2));
      console.log('Image creators saved successfully');
      
      // Refresh the menu to show new image creators
      const { refreshGSXLinks } = require('./menu');
      refreshGSXLinks();
      
      event.reply('image-creators-saved', true);
    } catch (error) {
      console.error('Error saving image creators:', error);
      event.reply('image-creators-saved', false);
    }
  });
  
  // Handle saving video creators
  ipcMain.on('save-video-creators', (event, creators) => {
    console.log(`Saving ${creators.length} video creators`);
    try {
      const creatorsPath = path.join(app.getPath('userData'), 'video-creators.json');
      fs.writeFileSync(creatorsPath, JSON.stringify(creators, null, 2));
      console.log('Video creators saved successfully');
      
      // Refresh the menu to show new video creators
      const { refreshGSXLinks } = require('./menu');
      refreshGSXLinks();
      
      event.reply('video-creators-saved', true);
    } catch (error) {
      console.error('Error saving video creators:', error);
      event.reply('video-creators-saved', false);
    }
  });
  
  // Handle saving audio generators
  ipcMain.on('save-audio-generators', (event, generators) => {
    console.log(`Saving ${generators.length} audio generators`);
    try {
      const generatorsPath = path.join(app.getPath('userData'), 'audio-generators.json');
      fs.writeFileSync(generatorsPath, JSON.stringify(generators, null, 2));
      console.log('Audio generators saved successfully');
      
      // Refresh the menu to show new audio generators
      const { refreshGSXLinks } = require('./menu');
      refreshGSXLinks();
      
      event.reply('audio-generators-saved', true);
    } catch (error) {
      console.error('Error saving audio generators:', error);
      event.reply('audio-generators-saved', false);
    }
  });
  
  // Handle saving UI design tools
  ipcMain.on('save-ui-design-tools', (event, tools) => {
    console.log(`Saving ${tools.length} UI design tools`);
    try {
      const toolsPath = path.join(app.getPath('userData'), 'ui-design-tools.json');
      fs.writeFileSync(toolsPath, JSON.stringify(tools, null, 2));
      console.log('UI design tools saved successfully');
      
      // Refresh the menu to show new UI design tools
      const { refreshGSXLinks } = require('./menu');
      refreshGSXLinks();
      
      event.reply('ui-design-tools-saved', true);
    } catch (error) {
      console.error('Error saving UI design tools:', error);
      event.reply('ui-design-tools-saved', false);
    }
  });
  
  // Handle saving IDW entries
  ipcMain.on('save-idw-entries', (event, entries) => {
    console.log(`[IDW] Saving ${entries.length} IDW entries`);
    try {
      const idwConfigPath = path.join(app.getPath('userData'), 'idw-entries.json');
      
      // Create backup of existing file
      if (fs.existsSync(idwConfigPath)) {
        const backupPath = idwConfigPath + '.backup';
        fs.copyFileSync(idwConfigPath, backupPath);
        console.log('[IDW] Created backup of existing entries');
      }
      
      // Save the new entries
      fs.writeFileSync(idwConfigPath, JSON.stringify(entries, null, 2));
      console.log('[IDW] IDW entries saved successfully to:', idwConfigPath);
      
      // Refresh the menu to show new IDW entries
      const { setApplicationMenu } = require('./menu');
      setApplicationMenu(entries);
      
      event.reply('idw-entries-saved', true);
    } catch (error) {
      console.error('[IDW] Error saving IDW entries:', error);
      event.reply('idw-entries-saved', false);
    }
  });
  
  // NEW: Handle wizard save using invoke (returns promise)
  ipcMain.handle('wizard:save-idw-environments', async (event, environments) => {
    console.log('='.repeat(60));
    console.log('[WIZARD SAVE] 🔵 INVOKE Handler called!');
    console.log(`[WIZARD SAVE] Saving ${environments.length} IDW environments`);
    console.log('[WIZARD SAVE] Environment IDs:', environments.map(e => e.id).join(', '));
    
    try {
      const idwConfigPath = path.join(app.getPath('userData'), 'idw-entries.json');
      console.log('[WIZARD SAVE] File path:', idwConfigPath);
      
      // Create backup
      if (fs.existsSync(idwConfigPath)) {
        const backupPath = idwConfigPath + '.backup';
        fs.copyFileSync(idwConfigPath, backupPath);
        console.log('[WIZARD SAVE] ✅ Backup created');
      }
      
      // Write file
      fs.writeFileSync(idwConfigPath, JSON.stringify(environments, null, 2));
      console.log('[WIZARD SAVE] ✅ File written');
      
      // Verify
      const savedData = JSON.parse(fs.readFileSync(idwConfigPath, 'utf8'));
      console.log('[WIZARD SAVE] ✅ Verified:', savedData.length, 'in file');
      
      // Update the settings manager with the new environments
      console.log('[WIZARD SAVE] Updating settings manager...');
      global.settingsManager.set('idwEnvironments', environments);
      console.log('[WIZARD SAVE] ✅ Settings manager updated');
      
      // Update menu
      const { setApplicationMenu } = require('./menu');
      setApplicationMenu(environments);
      console.log('[WIZARD SAVE] ✅ Menu updated');
      
      // Re-register shortcuts
      registerGlobalShortcuts();
      console.log('[WIZARD SAVE] ✅ Shortcuts registered');
      
      console.log('[WIZARD SAVE] ✅ SUCCESS!');
      console.log('='.repeat(60));
      
      return { success: true, count: environments.length };
    } catch (error) {
      console.error('[WIZARD SAVE] ❌ ERROR:', error);
      return { success: false, error: error.message };
    }
  });
  
  // OLD: Handle saving IDW environments (from setup wizard) - kept for compatibility
  ipcMain.on('save-idw-environments', (event, environments) => {
    console.log('='.repeat(60));
    console.log('[IDW SAVE] 🔵 IPC Handler called!');
    console.log(`[IDW SAVE] Saving ${environments.length} IDW environments from setup wizard`);
    console.log('[IDW SAVE] Environment IDs:', environments.map(e => e.id).join(', '));
    
    try {
      const idwConfigPath = path.join(app.getPath('userData'), 'idw-entries.json');
      console.log('[IDW SAVE] File path:', idwConfigPath);
      
      // Create backup of existing file
      if (fs.existsSync(idwConfigPath)) {
        const backupPath = idwConfigPath + '.backup';
        fs.copyFileSync(idwConfigPath, backupPath);
        console.log('[IDW SAVE] ✅ Created backup');
      }
      
      // Save the new environments
      fs.writeFileSync(idwConfigPath, JSON.stringify(environments, null, 2));
      console.log('[IDW SAVE] ✅ File written successfully');
      
      // Verify file was written
      const savedData = JSON.parse(fs.readFileSync(idwConfigPath, 'utf8'));
      console.log('[IDW SAVE] ✅ Verified:', savedData.length, 'environments in file');
      
      // Update the settings manager with the new environments
      console.log('[IDW SAVE] Updating settings manager...');
      global.settingsManager.set('idwEnvironments', environments);
      console.log('[IDW SAVE] ✅ Settings manager updated');
      
      // Update the application menu with the new environments
      console.log('[IDW SAVE] Updating menu...');
      const { setApplicationMenu } = require('./menu');
      setApplicationMenu(environments);
      console.log('[IDW SAVE] ✅ Menu updated');
      
      // Re-register global shortcuts
      registerGlobalShortcuts();
      console.log('[IDW SAVE] ✅ Shortcuts registered');
      
      event.reply('idw-environments-saved', true);
      console.log('[IDW SAVE] ✅ COMPLETE - All done!');
      console.log('='.repeat(60));
    } catch (error) {
      console.error('[IDW SAVE] ❌ ERROR:', error);
      console.error('[IDW SAVE] Stack:', error.stack);
      event.reply('idw-environments-saved', false);
    }
  });

  // Function to register global shortcuts for environments and bots
  function registerGlobalShortcuts() {
    console.log('[Shortcuts] Registering global shortcuts...');
    
    // Unregister only our previously registered shortcuts
    registeredShortcuts.forEach(shortcut => {
      try {
        globalShortcut.unregister(shortcut);
      } catch (e) {
        console.error(`[Shortcuts] Error unregistering ${shortcut}:`, e);
      }
    });
    registeredShortcuts = [];
    
    try {
      // Load IDW environments
      const idwConfigPath = path.join(app.getPath('userData'), 'idw-entries.json');
      if (fs.existsSync(idwConfigPath)) {
        const idwEnvironments = JSON.parse(fs.readFileSync(idwConfigPath, 'utf8'));
        idwEnvironments.forEach(env => {
          if (env.globalShortcut) {
            const success = globalShortcut.register(env.globalShortcut, () => {
              console.log(`[Shortcuts] Global shortcut triggered for IDW: ${env.label}`);
              openIDWEnvironment(env.homeUrl, env.label);
            });
            if (success) {
              console.log(`[Shortcuts] Registered shortcut ${env.globalShortcut} for IDW: ${env.label}`);
              registeredShortcuts.push(env.globalShortcut);
            } else {
              console.error(`[Shortcuts] Failed to register shortcut ${env.globalShortcut} for IDW: ${env.label}`);
            }
          }
        });
      }
      
      // Load external bots
      const botsConfigPath = path.join(app.getPath('userData'), 'external-bots.json');
      if (fs.existsSync(botsConfigPath)) {
        const externalBots = JSON.parse(fs.readFileSync(botsConfigPath, 'utf8'));
        externalBots.forEach(bot => {
          if (bot.globalShortcut) {
            const success = globalShortcut.register(bot.globalShortcut, () => {
              console.log(`[Shortcuts] Global shortcut triggered for bot: ${bot.name}`);
              openExternalAIWindow(bot.chatUrl, bot.name);
            });
            if (success) {
              console.log(`[Shortcuts] Registered shortcut ${bot.globalShortcut} for bot: ${bot.name}`);
              registeredShortcuts.push(bot.globalShortcut);
            } else {
              console.error(`[Shortcuts] Failed to register shortcut ${bot.globalShortcut} for bot: ${bot.name}`);
            }
          }
        });
      }
      
    } catch (error) {
      console.error('[Shortcuts] Error registering global shortcuts:', error);
    }
  }
  
  // Handle refresh menu request
  ipcMain.on('refresh-menu', (event) => {
    console.log('='.repeat(70));
    console.log('[REFRESH-MENU] 🔵 Handler called!');
    try {
      // Reload IDW environments from file AND settings
      const idwConfigPath = path.join(app.getPath('userData'), 'idw-entries.json');
      
      // Try settings first
      let idwEnvironments = global.settingsManager.get('idwEnvironments') || [];
      console.log(`[REFRESH-MENU] Loaded ${idwEnvironments.length} IDWs from settings`);
      
      // Fallback to file if settings empty
      if (idwEnvironments.length === 0 && fs.existsSync(idwConfigPath)) {
        const data = fs.readFileSync(idwConfigPath, 'utf8');
        idwEnvironments = JSON.parse(data);
        console.log(`[REFRESH-MENU] Loaded ${idwEnvironments.length} IDWs from file (fallback)`);
      }
      
      // Update the application menu
      console.log('[REFRESH-MENU] Calling setApplicationMenu with', idwEnvironments.length, 'IDWs...');
      const { setApplicationMenu } = require('./menu');
      setApplicationMenu(idwEnvironments);
      console.log('[REFRESH-MENU] ✅ Menu refreshed successfully!');
      console.log('='.repeat(70));
    } catch (error) {
      console.error('[REFRESH-MENU] ❌ Error refreshing menu:', error);
      console.error('[REFRESH-MENU] Stack:', error.stack);
    }
  });
  
  // Handle menu actions from the menu.js
  ipcMain.on('menu-action', (event, data) => {
    console.log('='.repeat(70));
    console.log('[MENU-ACTION] 🔵 Handler called!');
    console.log('[MENU-ACTION] Received from menu.js:', data);
    console.log('='.repeat(70));
    
    // Handle specific menu actions
    if (data.action === 'open-external-bot' && data.url) {
      // Use the existing user-action handler logic for external bots
      // This ensures ChatGPT opens in a dedicated window with proper permissions
      console.log('Redirecting external bot menu action to user-action handler');
      
      // Emit to the existing user-action handler
      ipcMain.emit('user-action', event, data);
      return;
    }
    
        // Handle image creator opening - open in separate window
    if (data.action === 'open-image-creator' && data.url) {
      console.log('Opening image creator in separate window:', data.label, data.url);
      openExternalAIWindow(data.url, data.label || 'Image Creator', {
        width: 1400,
        height: 900
      });
      return;
    }
    
    
    // Handle video creator opening - open in separate window
    if (data.action === 'open-video-creator' && data.url) {
      console.log('Opening video creator in separate window:', data.label, data.url);
      openExternalAIWindow(data.url, data.label || 'Video Creator', {
        width: 1400,
        height: 900
      });
      return;
    }
    
    // Handle audio generator opening - open in separate window
    if (data.action === 'open-audio-generator' && data.url) {
      console.log('Opening audio generator in separate window:', data.label, data.url);
      openExternalAIWindow(data.url, data.label || 'Audio Generator', {
        width: 1400,
        height: 900
      });
      return;
    }
    
    // Handle UI design tool opening - open in separate window
    if (data.action === 'open-ui-design-tool' && data.url) {
      console.log(`[UI Design] Opening ${data.label} in separate window: ${data.url}`);
      openExternalAIWindow(data.url, data.label || 'UI Design Tool', { width: 1400, height: 900 });
      return;
    }
    
    // Handle IDW URL opening
    if (data.action === 'open-idw-url' && data.url) {
      // Validate and clean the URL
      let cleanUrl = data.url;
      if (cleanUrl && typeof cleanUrl === 'string') {
        cleanUrl = cleanUrl.trim();
        // If URL has invalid prefix before http/https, remove it
        if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
          const httpsIndex = cleanUrl.indexOf('https://');
          const httpIndex = cleanUrl.indexOf('http://');
          if (httpsIndex > 0) {
            cleanUrl = cleanUrl.substring(httpsIndex);
            console.log(`[Menu Action] Cleaned malformed URL: ${data.url} -> ${cleanUrl}`);
          } else if (httpIndex > 0) {
            cleanUrl = cleanUrl.substring(httpIndex);
            console.log(`[Menu Action] Cleaned malformed URL: ${data.url} -> ${cleanUrl}`);
          }
        }
      }
      
      console.log(`Opening IDW URL in new tab: ${data.label} (${cleanUrl})`);
      
      // Get the main window
      const mainWindow = browserWindow.getMainWindow();
      if (mainWindow) {
        // Send to main window to open in a new tab
        mainWindow.webContents.send('open-in-new-tab', {
          url: cleanUrl,
          label: data.label || 'IDW'
        });
      } else {
        console.error('Main window not found, cannot open IDW URL');
      }
      return;
    }
    
    // Pass all other menu actions to the main window to handle
    const mainWindow = browserWindow.getMainWindow();
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('menu-action', data);
    }
  });

  /**
   * Helper function to extract file metadata from JSON payloads
   * Replaces large base64 data with metadata
   */
  function extractFileMetadata(obj) {
    const files = [];
    
    function processObject(data, path = '') {
      if (Array.isArray(data)) {
        return data.map((item, index) => processObject(item, `${path}[${index}]`));
      } else if (data && typeof data === 'object') {
        const processed = {};
        for (const [key, value] of Object.entries(data)) {
          // Detect base64 image/file data
          if ((key === 'data' || key === 'content' || key === 'image_url') && 
              typeof value === 'string' && 
              (value.startsWith('data:') || value.startsWith('/9j/') || value.startsWith('iVBOR') || value.length > 1000)) {
            
            // Extract metadata
            let fileType = 'unknown';
            let sizeKB = Math.round(value.length / 1024);
            
            if (value.startsWith('data:')) {
              const match = value.match(/^data:([^;]+);/);
              if (match) fileType = match[1];
            } else if (value.startsWith('/9j/')) {
              fileType = 'image/jpeg';
            } else if (value.startsWith('iVBOR')) {
              fileType = 'image/png';
            }
            
            files.push({
              field: `${path}.${key}`,
              type: fileType,
              sizeKB: sizeKB,
              base64Length: value.length
            });
            
            processed[key] = `[FILE_DATA_REMOVED: ${fileType}, ${sizeKB}KB]`;
          } else {
            processed[key] = processObject(value, `${path}.${key}`);
          }
        }
        return processed;
      }
      return data;
    }
    
    const processedPayload = processObject(obj);
    return { payload: processedPayload, files: files.length > 0 ? files : undefined };
  }
  
  /**
   * Helper function to extract file metadata from multipart form data
   */
  function extractMultipartFileMetadata(data, contentType) {
    const files = [];
    
    try {
      // Extract boundary from content-type
      const boundaryMatch = contentType.match(/boundary=([^;]+)/);
      if (!boundaryMatch) return files;
      
      const boundary = boundaryMatch[1].replace(/^["']|["']$/g, '');
      const parts = data.split(`--${boundary}`);
      
      for (const part of parts) {
        // Look for Content-Disposition with filename
        const filenameMatch = part.match(/filename="([^"]+)"/);
        const contentTypeMatch = part.match(/Content-Type:\s*([^\r\n]+)/i);
        
        if (filenameMatch) {
          const filename = filenameMatch[1];
          const fileType = contentTypeMatch ? contentTypeMatch[1].trim() : 'unknown';
          const sizeKB = Math.round(part.length / 1024);
          
          files.push({
            filename: filename,
            type: fileType,
            sizeKB: sizeKB
          });
        }
      }
    } catch (err) {
      console.error('Error extracting multipart file metadata:', err);
    }
    
    return files;
  }

  /**
   * Opens an external AI service in a separate window with proper authentication support
   * @param {string} url - The URL of the external AI service
   * @param {string} label - The display name of the service
   * @param {Object} options - Additional options for the window
   */
  function openExternalAIWindow(url, label, options = {}) {
    console.log(`Opening external AI service in separate window: ${label} (${url})`);
    
    // Determine AI type based on URL and label
    let aiType = 'unknown';
    let aiService = label;
    
    if (url.includes('chatgpt.com') || url.includes('openai.com')) {
      aiType = 'chat';
      aiService = 'ChatGPT';
    } else if (url.includes('claude.ai')) {
      aiType = 'chat';
      aiService = 'Claude';
    } else if (url.includes('gemini.google.com') || url.includes('bard.google.com')) {
      aiType = 'chat';
      aiService = 'Gemini';
    } else if (url.includes('perplexity.ai')) {
      aiType = 'chat';
      aiService = 'Perplexity';
    } else if (label.toLowerCase().includes('image') || url.includes('midjourney') || url.includes('dalle')) {
      aiType = 'image-generation';
    } else if (label.toLowerCase().includes('video')) {
      aiType = 'video-generation';
    } else if (label.toLowerCase().includes('audio') || url.includes('elevenlabs')) {
      aiType = 'audio-generation';
    } else if (label.toLowerCase().includes('ui') || label.toLowerCase().includes('design')) {
      aiType = 'ui-design';
    }
    
    // Log the AI window opening
    logger.logWindowCreated('external-ai', aiService, {
      aiType: aiType,
      aiService: aiService,
      url: url,
      windowTitle: label,
      windowSize: `${options.width || 1400}x${options.height || 900}`,
      partition: `persist:${label.toLowerCase().replace(/\s/g, '-')}`
    });
    
    logger.info('Personal AI Opened', {
      event: 'ai:opened',
      service: aiService,
      type: aiType,
      url: url,
      timestamp: new Date().toISOString()
    });
    
    // Create window configuration
    const windowConfig = {
      width: options.width || 1400,
      height: options.height || 900,
      title: label,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        partition: `persist:${label.toLowerCase().replace(/\s/g, '-')}`, // Separate session for each AI
        preload: path.join(__dirname, 'preload-external-ai.js')
      }
    };

    // Create the window
    const aiWindow = new BrowserWindow(windowConfig);
    
    // Set up network traffic logging using Chrome DevTools Protocol
    try {
      aiWindow.webContents.debugger.attach('1.3');
      console.log(`[${label}] Debugger attached for network monitoring`);
      
      // Enable Network domain to capture all network traffic
      aiWindow.webContents.debugger.sendCommand('Network.enable');
      
      // Track streaming responses (SSE/text-event-stream)
      const streamingResponses = new Map(); // requestId -> { url, chunks: [], complete: false }
      
      // Listen for network requests
      aiWindow.webContents.debugger.on('message', (event, method, params) => {
        if (method === 'Network.requestWillBeSent') {
          // Log outgoing request
          const request = params.request;
          logger.info('LLM Network Request', {
            event: 'llm:network:request',
            aiService: aiService,
            requestId: params.requestId,
            url: request.url,
            method: request.method,
            headers: request.headers,
            postData: request.postData,
            timestamp: new Date().toISOString()
          });
          
          // Log detailed payload if it's an API call
          if (request.postData && 
              (request.url.includes('/api/') || 
               request.url.includes('/v1/') ||
               request.url.includes('chat') ||
               request.url.includes('completions'))) {
            try {
              const payload = JSON.parse(request.postData);
              
              // Check if payload contains file/image data and extract metadata
              const processedPayload = extractFileMetadata(payload);
              
              logger.info('LLM API Call Payload', {
                event: 'llm:api:request',
                aiService: aiService,
                requestId: params.requestId,
                url: request.url,
                payload: processedPayload.payload,
                filesDetected: processedPayload.files,
                timestamp: new Date().toISOString()
              });
            } catch (err) {
              // Not JSON, check if it's multipart form data (file upload)
              const contentType = request.headers['content-type'] || request.headers['Content-Type'] || '';
              
              if (contentType.includes('multipart/form-data')) {
                // Extract file metadata from multipart data
                const fileMetadata = extractMultipartFileMetadata(request.postData, contentType);
                logger.info('LLM File Upload (Multipart)', {
                  event: 'llm:file:upload',
                  aiService: aiService,
                  requestId: params.requestId,
                  url: request.url,
                  files: fileMetadata,
                  timestamp: new Date().toISOString()
                });
              } else {
                // Log as text (but truncate if too large)
                const truncatedData = request.postData.length > 1000 
                  ? request.postData.substring(0, 1000) + `... [truncated, total size: ${request.postData.length} bytes]`
                  : request.postData;
                  
                logger.info('LLM API Call Payload (Text)', {
                  event: 'llm:api:request',
                  aiService: aiService,
                  requestId: params.requestId,
                  url: request.url,
                  payload: truncatedData,
                  timestamp: new Date().toISOString()
                });
              }
            }
          }
        } else if (method === 'Network.responseReceived') {
          // Log response metadata
          const response = params.response;
          logger.info('LLM Network Response', {
            event: 'llm:network:response',
            aiService: aiService,
            requestId: params.requestId,
            url: response.url,
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            mimeType: response.mimeType,
            timestamp: new Date().toISOString()
          });
          
          // Check if this is a streaming response (SSE)
          const contentType = response.headers['content-type'] || response.headers['Content-Type'] || '';
          const isStreaming = contentType.includes('text/event-stream') || 
                            contentType.includes('application/stream') ||
                            contentType.includes('text/stream');
          
          // Initialize streaming tracker for SSE responses
          if (isStreaming && 
              (response.url.includes('/conversation') || 
               response.url.includes('/chat') ||
               response.url.includes('/completions'))) {
            console.log(`[${label}] Detected streaming response for request ${params.requestId}`);
            streamingResponses.set(params.requestId, {
              url: response.url,
              chunks: [],
              complete: false,
              startTime: Date.now()
            });
          }
          
          // Get response body if it's an API response
          if (response.url.includes('/api/') || 
              response.url.includes('/v1/') ||
              response.url.includes('chat') ||
              response.url.includes('completions')) {
            aiWindow.webContents.debugger.sendCommand('Network.getResponseBody', {
              requestId: params.requestId
            }).then(responseBody => {
              try {
                const body = responseBody.base64Encoded 
                  ? Buffer.from(responseBody.body, 'base64').toString('utf-8')
                  : responseBody.body;
                
                // Try to parse as JSON
                try {
                  const jsonBody = JSON.parse(body);
                  
                  // Check if response contains file/image data and extract metadata
                  const processedResponse = extractFileMetadata(jsonBody);
                  
                  logger.info('LLM API Response Payload', {
                    event: 'llm:api:response',
                    aiService: aiService,
                    requestId: params.requestId,
                    url: response.url,
                    status: response.status,
                    payload: processedResponse.payload,
                    filesDetected: processedResponse.files,
                    timestamp: new Date().toISOString()
                  });
                } catch (e) {
                  // Not JSON, truncate if too large
                  const truncatedBody = body.length > 1000 
                    ? body.substring(0, 1000) + `... [truncated, total size: ${body.length} bytes]`
                    : body;
                    
                  logger.info('LLM API Response Payload (Text)', {
                    event: 'llm:api:response',
                    aiService: aiService,
                    requestId: params.requestId,
                    url: response.url,
                    status: response.status,
                    payload: truncatedBody,
                    timestamp: new Date().toISOString()
                  });
                }
              } catch (err) {
                console.error(`[${label}] Error getting response body:`, err);
              }
            }).catch(err => {
              // Some responses can't be retrieved, that's okay
              if (!err.message.includes('No resource')) {
                console.error(`[${label}] Error getting response body:`, err);
              }
            });
          }
        } else if (method === 'Network.dataReceived') {
          // Capture streaming data chunks (SSE)
          if (streamingResponses.has(params.requestId)) {
            const streamData = streamingResponses.get(params.requestId);
            console.log(`[${label}] Received ${params.dataLength} bytes for streaming request ${params.requestId}`);
            
            // Get the actual chunk data
            aiWindow.webContents.debugger.sendCommand('Network.getResponseBody', {
              requestId: params.requestId
            }).then(responseBody => {
              const body = responseBody.base64Encoded 
                ? Buffer.from(responseBody.body, 'base64').toString('utf-8')
                : responseBody.body;
              
              // Store the cumulative response
              streamData.chunks.push(body);
              streamData.lastUpdate = Date.now();
              
              console.log(`[${label}] Stream data length: ${body.length} chars`);
            }).catch(err => {
              // Might not be available yet, that's okay
            });
          }
        } else if (method === 'Network.loadingFinished') {
          // Stream completed - process all chunks
          if (streamingResponses.has(params.requestId)) {
            const streamData = streamingResponses.get(params.requestId);
            streamData.complete = true;
            
            console.log(`[${label}] Stream finished for request ${params.requestId}`);
            
            // Get the final complete response
            aiWindow.webContents.debugger.sendCommand('Network.getResponseBody', {
              requestId: params.requestId
            }).then(responseBody => {
              try {
                const body = responseBody.base64Encoded 
                  ? Buffer.from(responseBody.body, 'base64').toString('utf-8')
                  : responseBody.body;
                
                console.log(`[${label}] Complete stream data length: ${body.length} chars`);
                
                // Parse SSE format (data: ... \n\n)
                const sseEvents = [];
                const lines = body.split('\n');
                let currentEvent = {};
                
                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    const data = line.substring(6);
                    if (data === '[DONE]') {
                      break;
                    }
                    try {
                      const parsed = JSON.parse(data);
                      sseEvents.push(parsed);
                      
                      // Extract the actual message content
                      if (parsed.message && parsed.message.content) {
                        currentEvent.content = parsed.message.content;
                      }
                      if (parsed.message && parsed.message.content && parsed.message.content.parts) {
                        currentEvent.parts = parsed.message.content.parts;
                      }
                    } catch (e) {
                      // Not JSON, might be plain text
                    }
                  }
                }
                
                // Log the complete streaming response
                logger.info('LLM Streaming Response Complete', {
                  event: 'llm:stream:complete',
                  aiService: aiService,
                  requestId: params.requestId,
                  url: streamData.url,
                  eventCount: sseEvents.length,
                  events: sseEvents,
                  extractedContent: currentEvent,
                  duration: Date.now() - streamData.startTime,
                  timestamp: new Date().toISOString()
                });
                
                // Extract and log just the final message text for easy reading
                if (sseEvents.length > 0) {
                  const lastEvent = sseEvents[sseEvents.length - 1];
                  let messageText = null;
                  
                  // Try to extract the message text
                  if (lastEvent.message && lastEvent.message.content) {
                    if (typeof lastEvent.message.content === 'string') {
                      messageText = lastEvent.message.content;
                    } else if (lastEvent.message.content.parts) {
                      messageText = lastEvent.message.content.parts.join('\n');
                    }
                  }
                  
                  if (messageText) {
                    logger.info('LLM Final Response Text', {
                      event: 'llm:response:final',
                      aiService: aiService,
                      requestId: params.requestId,
                      responseText: messageText,
                      timestamp: new Date().toISOString()
                    });
                  }
                }
                
              } catch (err) {
                console.error(`[${label}] Error parsing streaming response:`, err);
              }
            }).catch(err => {
              console.error(`[${label}] Error getting streaming response body:`, err);
            });
            
            // Clean up after logging
            setTimeout(() => streamingResponses.delete(params.requestId), 5000);
          }
        } else if (method === 'Network.webSocketCreated') {
          // Log WebSocket connections (used for streaming)
          logger.info('LLM WebSocket Created', {
            event: 'llm:websocket:created',
            aiService: aiService,
            requestId: params.requestId,
            url: params.url,
            timestamp: new Date().toISOString()
          });
        } else if (method === 'Network.webSocketFrameSent') {
          // Log WebSocket messages sent (streaming requests)
          logger.info('LLM WebSocket Message Sent', {
            event: 'llm:websocket:sent',
            aiService: aiService,
            requestId: params.requestId,
            message: params.response.payloadData,
            timestamp: new Date().toISOString()
          });
        } else if (method === 'Network.webSocketFrameReceived') {
          // Log WebSocket messages received (streaming responses)
          logger.info('LLM WebSocket Message Received', {
            event: 'llm:websocket:received',
            aiService: aiService,
            requestId: params.requestId,
            message: params.response.payloadData,
            timestamp: new Date().toISOString()
          });
        }
      });
      
      // Handle debugger detach
      aiWindow.webContents.debugger.on('detach', (event, reason) => {
        console.log(`[${label}] Debugger detached:`, reason);
      });
    } catch (err) {
      console.error(`[${label}] Error setting up network monitoring:`, err);
    }
    
    // Set up authentication handling
    aiWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
      console.log(`[${label}] Permission requested: ${permission}`);
      
      // Allow necessary permissions for AI services
      if (permission === 'media' || 
          permission === 'microphone' ||
          permission === 'camera' ||
          permission === 'notifications' ||
          permission === 'clipboard-read' ||
          permission === 'clipboard-write' ||
          permission === 'clipboard-sanitized-write') {
        console.log(`[${label}] Allowing ${permission} permission`);
        callback(true);
      } else {
        console.log(`[${label}] Denying ${permission} permission`);
        callback(false);
      }
    });
    
    // Also set permission check handler for clipboard
    aiWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
      if (permission === 'clipboard-read' || 
          permission === 'clipboard-write' ||
          permission === 'clipboard-sanitized-write' ||
          permission === 'media' ||
          permission === 'microphone' ||
          permission === 'camera') {
        return true;
      }
      return false;
    });

    // Handle new window requests (for authentication popups)
    aiWindow.webContents.setWindowOpenHandler(({ url: newUrl, disposition }) => {
      console.log(`[${label}] Window open request:`, newUrl, disposition);
      
      // Allow authentication popups
      if (newUrl.includes('accounts.google.com') ||
          newUrl.includes('login.microsoftonline.com') ||
          newUrl.includes('adobe.com/auth') ||
          newUrl.includes('firefly.adobe.com') ||
          newUrl.includes('auth.services.adobe.com') ||
          newUrl.includes('ims-na1.adobelogin.com') ||
          newUrl.includes('oauth') ||
          newUrl.includes('/auth/') ||
          newUrl.includes('/login')) {
        console.log(`[${label}] Allowing authentication popup`);
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 600,
            height: 800,
            parent: aiWindow,
            modal: false,
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              partition: aiWindow.webContents.session.partition
            }
          }
        };
      }
      
      // Deny other popups
      return { action: 'deny' };
    });

    // Handle Adobe-specific headers for Firefly
    if (url.includes('firefly.adobe.com')) {
      console.log(`[${label}] Setting up Adobe Firefly specific headers`);
      
      aiWindow.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = { ...details.requestHeaders };
        
        // Set proper user agent
        headers['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36';
        
        // Add necessary headers for Adobe services
        if (!headers['Accept']) {
          headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8';
        }
        
        if (!headers['Accept-Language']) {
          headers['Accept-Language'] = 'en-US,en;q=0.9';
        }
        
        callback({ requestHeaders: headers });
      });
    }

    // Handle download requests
    aiWindow.webContents.session.on('will-download', (event, item, webContents) => {
      console.log(`[${label}] Download detected:`, item.getFilename());
      browserWindow.handleDownloadWithSpaceOption(item, label);
    });
    
    // Load the URL
    aiWindow.loadURL(url);
    
    // Show window when ready
    aiWindow.once('ready-to-show', () => {
      aiWindow.show();
    });

    // Clean up on close
    aiWindow.on('closed', () => {
      console.log(`[${label}] Window closed`);
      
      // Detach debugger if attached
      try {
        if (aiWindow.webContents.debugger.isAttached()) {
          aiWindow.webContents.debugger.detach();
          console.log(`[${label}] Debugger detached on window close`);
        }
      } catch (err) {
        // Ignore errors during cleanup
      }
      
      // Log the AI window closing
      logger.logWindowClosed('external-ai', aiService, {
        aiType: aiType,
        aiService: aiService,
        windowTitle: label
      });
      
      logger.info('Personal AI Closed', {
        event: 'ai:closed',
        service: aiService,
        type: aiType,
        timestamp: new Date().toISOString()
      });
    });

    return aiWindow;
  }

  // Handle tab actions
  ipcMain.on('tab-action', (event, data) => {
    console.log('Received tab action:', data);
    
    if (data.action === 'open-url') {
      // Get the main window
      const mainWindow = browserWindow.getMainWindow();
      if (mainWindow) {
        // Send the URL to the renderer to open in a new tab
        mainWindow.webContents.send('open-in-new-tab', data.url);
      }
    }
  });

  // Handle reading time update requests
  ipcMain.handle('update-reading-times', async (event) => {
    log.info('[RSS] Received update-reading-times request');
    return readingTimeManager.updateAllReadingTimes();
  });

  // Handle wipe-all-partitions request
  ipcMain.on('wipe-all-partitions', async (event) => {
    console.log('[Main] Wiping all partition data...');
    
    try {
      // Get all partitions that start with "persist:"
      const partitions = [];
      const appDataPath = app.getPath('userData');
      const fs = require('fs');
      const path = require('path');
      
      // List all directories in Partitions folder
      const partitionsPath = path.join(appDataPath, 'Partitions');
      if (fs.existsSync(partitionsPath)) {
        const dirs = fs.readdirSync(partitionsPath);
        for (const dir of dirs) {
          if (dir.startsWith('persist_')) {
            const fullPath = path.join(partitionsPath, dir);
            console.log(`[Main] Deleting partition directory: ${fullPath}`);
            fs.rmSync(fullPath, { recursive: true, force: true });
          }
        }
      }
      
      console.log('[Main] All partition data wiped successfully');
    } catch (error) {
      console.error('[Main] Error wiping partitions:', error);
    }
  });
  
  // Handle open-external request
  ipcMain.on('open-external', (event, url) => {
    console.log('[Main] Opening URL in external browser:', url);
    shell.openExternal(url).catch(err => {
      console.error('[Main] Error opening external URL:', err);
    });
  });

  // Handle get-ui-design-tools request
  ipcMain.on('get-ui-design-tools', (event) => {
    try {
      const toolsPath = path.join(app.getPath('userData'), 'ui-design-tools.json');
      if (fs.existsSync(toolsPath)) {
        const toolsData = fs.readFileSync(toolsPath, 'utf8');
        event.reply('get-ui-design-tools', JSON.parse(toolsData));
      } else {
        event.reply('get-ui-design-tools', []);
      }
    } catch (err) {
      console.error('[UI Design] Failed to read ui-design-tools.json:', err);
      event.reply('get-ui-design-tools', []);
    }
  });

  // Handle save-ui-design-tools
  ipcMain.on('save-ui-design-tools', (event, tools) => {
    try {
      const toolsPath = path.join(app.getPath('userData'), 'ui-design-tools.json');
      fs.writeFileSync(toolsPath, JSON.stringify(tools, null, 2));
      event.reply('ui-design-tools-saved', true);
      // Refresh full application menu so IDW section picks up the new tools
      const { refreshApplicationMenu } = require('./menu');
      refreshApplicationMenu();
    } catch (err) {
      console.error('[UI Design] Failed to save ui-design-tools.json:', err);
      event.reply('ui-design-tools-saved', false);
    }
  });
  
  // Rollback manager handlers
  ipcMain.handle('rollback:get-backups', async () => {
    try {
      const backups = await rollbackManager.getAvailableBackups();
      return backups;
    } catch (error) {
      console.error('Error getting backups:', error);
      return [];
    }
  });
  
  ipcMain.handle('rollback:open-folder', async () => {
    try {
      await rollbackManager.openBackupsFolder();
      return true;
    } catch (error) {
      console.error('Error opening backups folder:', error);
      return false;
    }
  });
  
  ipcMain.handle('rollback:create-restore-script', async (event, version) => {
    try {
      const scriptPath = await rollbackManager.createRestoreScript(version);
      return { success: true, path: scriptPath };
    } catch (error) {
      console.error('Error creating restore script:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Test Runner handlers
  ipcMain.handle('get-memory-info', () => {
    return process.memoryUsage();
  });
  
  // Clipboard write handler for tests
  ipcMain.handle('clipboard:write-text', async (event, text) => {
    const { clipboard } = require('electron');
    clipboard.writeText(text);
    return true;
  });
  
  // Settings handlers for tests
  ipcMain.handle('save-settings', async (event, settings) => {
    try {
      const settingsPath = path.join(app.getPath('userData'), 'settings.json');
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      return true;
    } catch (error) {
      console.error('Error saving settings:', error);
      return false;
    }
  });
  
  ipcMain.handle('get-settings', async () => {
    try {
      const settingsPath = path.join(app.getPath('userData'), 'settings.json');
      if (fs.existsSync(settingsPath)) {
        return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      }
      return {};
    } catch (error) {
      console.error('Error loading settings:', error);
      return {};
    }
  });
  
  ipcMain.handle('save-test-results', async (event, results) => {
    try {
      const testResultsPath = path.join(app.getPath('userData'), 'test-results.json');
      let existingResults = [];
      
      if (fs.existsSync(testResultsPath)) {
        existingResults = JSON.parse(fs.readFileSync(testResultsPath, 'utf8'));
      }
      
      existingResults.push(results);
      
      // Keep only last 50 test runs
      if (existingResults.length > 50) {
        existingResults = existingResults.slice(-50);
      }
      
      fs.writeFileSync(testResultsPath, JSON.stringify(existingResults, null, 2));
      return true;
    } catch (error) {
      console.error('Error saving test results:', error);
      return false;
    }
  });
  
  ipcMain.handle('export-test-report', async (event, report) => {
    try {
      const result = await dialog.showSaveDialog({
        title: 'Export Test Report',
        defaultPath: `test-report-${Date.now()}.md`,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'Text', extensions: ['txt'] }
        ]
      });
      
      if (!result.canceled && result.filePath) {
        fs.writeFileSync(result.filePath, report);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error exporting test report:', error);
      return false;
    }
  });
  
  ipcMain.handle('get-test-history', () => {
    try {
      const testResultsPath = path.join(app.getPath('userData'), 'test-results.json');
      if (fs.existsSync(testResultsPath)) {
        return JSON.parse(fs.readFileSync(testResultsPath, 'utf8'));
      }
      return [];
    } catch (error) {
      console.error('Error loading test history:', error);
      return [];
    }
  });
  
  ipcMain.handle('add-test-history', async (event, run) => {
    try {
      const historyPath = path.join(app.getPath('userData'), 'test-history.json');
      let history = [];
      
      if (fs.existsSync(historyPath)) {
        history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      }
      
      history.push({
        timestamp: Date.now(),
        ...run
      });
      
      // Keep only last 100 runs
      if (history.length > 100) {
        history = history.slice(-100);
      }
      
      fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
      return true;
    } catch (error) {
      console.error('Error adding to test history:', error);
      return false;
    }
  });
  
  // Manual test handlers
  ipcMain.handle('get-manual-test-notes', (event, testId) => {
    try {
      const notesPath = path.join(app.getPath('userData'), 'manual-test-notes.json');
      if (fs.existsSync(notesPath)) {
        const notes = JSON.parse(fs.readFileSync(notesPath, 'utf8'));
        return notes[testId] || '';
      }
      return '';
    } catch (error) {
      console.error('Error loading manual test notes:', error);
      return '';
    }
  });
  
  ipcMain.handle('save-manual-test-notes', async (event, testId, notes) => {
    try {
      const notesPath = path.join(app.getPath('userData'), 'manual-test-notes.json');
      let allNotes = {};
      
      if (fs.existsSync(notesPath)) {
        allNotes = JSON.parse(fs.readFileSync(notesPath, 'utf8'));
      }
      
      allNotes[testId] = notes;
      
      fs.writeFileSync(notesPath, JSON.stringify(allNotes, null, 2));
      return true;
    } catch (error) {
      console.error('Error saving manual test notes:', error);
      return false;
    }
  });
  
  ipcMain.handle('get-manual-test-statuses', () => {
    try {
      const statusPath = path.join(app.getPath('userData'), 'manual-test-status.json');
      if (fs.existsSync(statusPath)) {
        return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      }
      return {};
    } catch (error) {
      console.error('Error loading manual test statuses:', error);
      return {};
    }
  });
  
  ipcMain.handle('save-manual-test-status', async (event, testId, checked) => {
    try {
      const statusPath = path.join(app.getPath('userData'), 'manual-test-status.json');
      let statuses = {};
      
      if (fs.existsSync(statusPath)) {
        statuses = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      }
      
      statuses[testId] = {
        checked,
        lastUpdated: Date.now()
      };
      
      fs.writeFileSync(statusPath, JSON.stringify(statuses, null, 2));
      return true;
    } catch (error) {
      console.error('Error saving manual test status:', error);
      return false;
    }
  });

  // Add missing test runner handlers
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  ipcMain.handle('get-os-info', () => {
    const os = require('os');
    return `${os.type()} ${os.release()} (${os.platform()})`;
  });

  ipcMain.handle('check-widget-ready', async () => {
    // Check if the black hole widget is ready
    if (global.clipboardManager && global.clipboardManager.blackHoleWindow) {
      return !global.clipboardManager.blackHoleWindow.isDestroyed();
    }
    return false;
  });

  ipcMain.handle('test-claude-connection', async (event) => {
    try {
      const settings = await settingsManager.getAll();
      if (!settings.claudeApiKey) {
        return { error: 'Claude API key not configured' };
      }
      
      // Test the connection with a simple request
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': settings.claudeApiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 10
        })
      });
      
      if (response.ok) {
        return { success: true };
      } else {
        const error = await response.text();
        return { error: `API returned ${response.status}: ${error}` };
      }
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('test-openai-connection', async (event) => {
    try {
      const settings = await settingsManager.getAll();
      if (!settings.openaiApiKey) {
        return { error: 'OpenAI API key not configured' };
      }
      
      // Test the connection with a simple request
      const response = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${settings.openaiApiKey}`
        }
      });
      
      if (response.ok) {
        return { success: true };
      } else {
        const error = await response.text();
        return { error: `API returned ${response.status}: ${error}` };
      }
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('encrypt-data', async (event, data) => {
    // Simple encryption for testing - in production use proper encryption
    const encrypted = Buffer.from(data).toString('base64');
    return `encrypted:${encrypted}`;
  });

  ipcMain.handle('decrypt-data', async (event, encryptedData) => {
    if (!encryptedData.startsWith('encrypted:')) {
      throw new Error('Invalid encrypted data format');
    }
    const base64 = encryptedData.substring('encrypted:'.length);
    return Buffer.from(base64, 'base64').toString('utf8');
  });

  ipcMain.handle('check-for-updates', async () => {
    try {
      // In development, just return a mock response
      if (process.env.NODE_ENV === 'development') {
        return { message: 'Update check not available in development mode' };
      }
      
      // In production, this would check for actual updates
      const { autoUpdater } = require('electron-updater');
      const result = await autoUpdater.checkForUpdates();
      return { 
        message: result.updateInfo ? `Update available: ${result.updateInfo.version}` : 'Up to date',
        updateAvailable: !!result.updateInfo
      };
    } catch (error) {
      return { message: 'Update check not available', error: error.message };
    }
  });

  ipcMain.handle('get-rollback-versions', async () => {
    try {
      const backupsPath = path.join(app.getPath('userData'), 'backups');
      if (!fs.existsSync(backupsPath)) {
        return [];
      }
      
      const files = fs.readdirSync(backupsPath);
      const backups = files
        .filter(file => file.startsWith('backup_') && file.endsWith('.json'))
        .map(file => {
          const stats = fs.statSync(path.join(backupsPath, file));
          const timestamp = file.match(/backup_(\d+)\.json/)?.[1];
          return {
            filename: file,
            timestamp: parseInt(timestamp),
            date: new Date(parseInt(timestamp)).toLocaleString(),
            size: stats.size
          };
        })
        .sort((a, b) => b.timestamp - a.timestamp);
      
      return backups;
    } catch (error) {
      console.error('Error getting rollback versions:', error);
      return [];
    }
  });

  ipcMain.handle('save-test-progress', async (event, progress) => {
    try {
      const progressPath = path.join(app.getPath('userData'), 'test-progress.json');
      fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
      return true;
    } catch (error) {
      console.error('Error saving test progress:', error);
      return false;
    }
  });

  ipcMain.handle('load-test-progress', async () => {
    try {
      const progressPath = path.join(app.getPath('userData'), 'test-progress.json');
      if (fs.existsSync(progressPath)) {
        return JSON.parse(fs.readFileSync(progressPath, 'utf8'));
      }
      return null;
    } catch (error) {
      console.error('Error loading test progress:', error);
      return null;
    }
  });

  ipcMain.handle('save-finalized-report', async (event, report) => {
    try {
      const reportsPath = path.join(app.getPath('userData'), 'test-reports');
      if (!fs.existsSync(reportsPath)) {
        fs.mkdirSync(reportsPath, { recursive: true });
      }
      
      const timestamp = Date.now();
      const filename = `report_${timestamp}.json`;
      const filepath = path.join(reportsPath, filename);
      
      fs.writeFileSync(filepath, JSON.stringify(report, null, 2));
      
      console.log(`Test report saved to: ${filepath}`);
      return { success: true, filepath };
    } catch (error) {
      console.error('Error saving finalized report:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('save-test-history', async (event, history) => {
    try {
      const historyPath = path.join(app.getPath('userData'), 'test-history.json');
      fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
      return true;
    } catch (error) {
      console.error('Error saving test history:', error);
      return false;
    }
  });
}

// Function to calculate reading time from HTML content
function calculateReadingTimeFromHTML(htmlContent) {
  try {
    // Remove HTML tags and get plain text
    const textContent = htmlContent
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove script tags
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')   // Remove style tags
      .replace(/<[^>]*>/g, ' ')                          // Remove all HTML tags
      .replace(/\s+/g, ' ')                              // Normalize whitespace
      .trim();
    
    if (!textContent || textContent.length < 50) {
      return '1 min read'; // Default for very short content
    }
    
    // Count words
    const words = textContent.split(/\s+/).filter(word => word.length > 0).length;
    
    // Calculate reading time (average 200 words per minute)
    const wordsPerMinute = 200;
    const minutes = Math.ceil(words / wordsPerMinute);
    
    console.log(`📊 Reading time calculation: ${words} words = ${minutes} min read`);
    
    return `${minutes} min read`;
  } catch (error) {
    console.error('Error calculating reading time:', error);
    return '5 min read'; // Default fallback
  }
}

// Helper function to get word count from HTML
function getWordCount(htmlContent) {
  try {
    const textContent = htmlContent
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    return textContent.split(/\s+/).filter(word => word.length > 0).length;
  } catch (error) {
    return 0;
  }
}

// Keep a reference to the settings window
let settingsWindow = null;

// Function to open the settings window
function openSettingsWindow() {
  console.log('Opening settings window...');
  
  // Check if settings window already exists and is not destroyed
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    console.log('Settings window exists, focusing it');
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  
  console.log('Creating new settings window');
  // Create the settings window
  settingsWindow = new BrowserWindow({
    width: 900,
    height: 700,
    title: 'Settings',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
      enableRemoteModule: false,
      sandbox: false
    }
  });
  
  // Clear the reference when the window is closed
  settingsWindow.on('closed', () => {
    console.log('Settings window closed');
    settingsWindow = null;
  });
  
  // Handle any load errors
  settingsWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load settings window:', errorCode, errorDescription);
  });
  
  // Log when the window successfully loads
  settingsWindow.webContents.on('did-finish-load', () => {
    console.log('Settings window loaded successfully');
  });
  
  // Load the settings HTML file
  settingsWindow.loadFile('settings.html').catch(err => {
    console.error('Error loading settings.html:', err);
  });
}

// Make settings window globally accessible
global.openSettingsWindowGlobal = openSettingsWindow;

// Function to open the new onboarding wizard
function openOnboardingWizard() {
  console.log('Opening onboarding wizard window...');
  
  const { BrowserWindow } = require('electron');
  const path = require('path');
  
  const wizardWindow = new BrowserWindow({
    width: 700,
    height: 800,
    center: true,
    resizable: false,
    minimizable: false,
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  
  wizardWindow.loadFile('onboarding-wizard.html');
  
  wizardWindow.on('closed', () => {
    console.log('Onboarding wizard closed');
  });
}

// Function to open the setup wizard modal
function openSetupWizard() {
  console.log('Opening setup wizard window...');
  
  // Debug existing configuration
  console.log('Configuration path:', idwConfigPath);
  let existingConfig = [];
  try {
    if (fs.existsSync(idwConfigPath)) {
      const rawData = fs.readFileSync(idwConfigPath, 'utf8');
      console.log('Raw config data:', rawData);
      existingConfig = JSON.parse(rawData);
      console.log('Parsed IDW config:', existingConfig);
    } else {
      console.log('No configuration file exists at', idwConfigPath);
    }
  } catch (error) {
    console.error('Error reading config:', error);
  }
  
  // Get the main window reference
  const mainWindow = browserWindow.getMainWindow();
  
  // Create the setup wizard window using our module
  let wizardWindow = browserWindow.createSetupWizardWindow({
    width: 1000,
    height: 800,
    show: false  // Don't show until content is loaded
  });

  // Set Content Security Policy for wizard window
  wizardWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' * https://*.onereach.ai https://*.api.onereach.ai; " +
          "style-src 'self' 'unsafe-inline' * https://*.onereach.ai; " + 
          "style-src-elem 'self' 'unsafe-inline' * https://*.onereach.ai; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' * https://*.onereach.ai; " +
          "connect-src 'self' * https://*.onereach.ai https://*.api.onereach.ai; " +
          "img-src 'self' data: blob: * https://*.onereach.ai; " +
          "font-src 'self' data: * https://*.onereach.ai; " +
          "media-src 'self' * https://*.onereach.ai; " +
          "object-src 'none'; " +
          "base-uri 'self'"
        ]
      }
    });
  });

  // Prepare the IDW config data to inject into the setup wizard
  let idwEnvironments = [];
  try {
    if (fs.existsSync(idwConfigPath)) {
      const configData = fs.readFileSync(idwConfigPath, 'utf8');
      console.log('Loaded IDW config data for setup wizard:', configData);
      try {
        idwEnvironments = JSON.parse(configData);
        console.log('Parsed IDW config, found', idwEnvironments.length, 'environments');
      } catch (parseError) {
        console.error('Error parsing IDW config JSON:', parseError);
        idwEnvironments = [];
      }
    } else {
      console.log('No IDW config file found, using empty array');
    }
  } catch (error) {
    console.error('Error reading IDW config file:', error);
  }

  // Load the setup wizard HTML file
  console.log('Loading setup-wizard.html file...');
  wizardWindow.loadFile('setup-wizard.html');

  // Event when content has loaded
  wizardWindow.webContents.on('did-finish-load', () => {
    console.log('Setup wizard content loaded, injecting data');
    
    // Use a simple executeJavaScript that directly uses the data inside the script
    wizardWindow.webContents.executeJavaScript(`
      (function() {
        try {
          // This is a safer approach - we're embedding the actual array data
          const environments = ${JSON.stringify(idwEnvironments)};
          console.log('IDW environments to store:', environments);
          
          // Store it properly
          localStorage.setItem('idwEnvironments', JSON.stringify(environments));
          console.log('Stored environments in localStorage:', localStorage.getItem('idwEnvironments'));
          
          // Now initialize the form with this data
          if (typeof initializeSetupWizard === 'function') {
            console.log('Calling initialization function');
            initializeSetupWizard();
          }
          
          return true;
        } catch (error) {
          console.error('Error storing environments:', error);
          return false;
        }
      })();
    `).then(result => {
      console.log('Initialization completed successfully:', result);
    }).catch(err => {
      console.error('Error running initialization script:', err);
    });
    
    // Inject custom scrollbar CSS
    wizardWindow.webContents.insertCSS(`
      ::-webkit-scrollbar {
        width: 6px;
        height: 6px;
      }
      
      ::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.2);
        border-radius: 3px;
      }
      
      ::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
      }
      
      ::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.2);
      }
    `).catch(err => console.error('Failed to inject scrollbar CSS:', err));
    
    // Trigger a check for the loaded data
    setTimeout(() => {
      wizardWindow.webContents.executeJavaScript(`
        // Log the current state of the form
        const homeUrlEl = document.getElementById('idw-home-url');
        const chatUrlEl = document.getElementById('idw-chat-url');
        console.log('[Delayed check] Form field values:', {
          'idw-home-url': homeUrlEl ? homeUrlEl.value : 'element not found',
          'idw-chat-url': chatUrlEl ? chatUrlEl.value : 'element not found',
          'form-is-populated': Boolean(homeUrlEl && homeUrlEl.value)
        });
        
        // Count environments in localStorage
        try {
          const envData = localStorage.getItem('idwEnvironments');
          console.log('[Delayed check] Environment data in localStorage exists:', Boolean(envData));
          if (envData) {
            const count = JSON.parse(envData).length;
            console.log('[Delayed check] Number of environments:', count);
          }
        } catch (e) {
          console.error('[Delayed check] Error parsing environments:', e);
        }
      `).catch(err => {
        console.error('Error running delayed check:', err);
      });
    }, 1000);
    
    // Now show the window after everything is ready
    wizardWindow.show();
  });

  // Handle window closed event
  wizardWindow.on('closed', () => {
    console.log('Setup wizard window closed');
    wizardWindow = null;
  });
}

// Function to update the IDW menu dynamically
function updateIDWMenu(environments) {
  if (!Array.isArray(environments) || environments.length === 0) return;
  
  // FIXED: Use the proper menu system from menu.js which includes the Share menu
  // The old implementation was directly calling Menu.setApplicationMenu() which
  // was overriding the Share menu. Now we use setApplicationMenu from menu.js
  const { setApplicationMenu } = require('./menu');
  setApplicationMenu(environments);
  console.log(`IDW menu updated with ${environments.length} environments using proper menu system`);
}

// Function to update the GSX menu dynamically
function updateGSXMenu(links) {
  if (!Array.isArray(links) || links.length === 0) return;
  
  // FIXED: Use the proper menu system from menu.js which includes the Share menu
  // The old implementation was directly calling Menu.setApplicationMenu() which
  // was overriding the Share menu. Now we use refreshGSXLinks from menu.js
  const { refreshGSXLinks } = require('./menu');
  refreshGSXLinks();
  console.log(`GSX menu updated with ${links.length} links using proper menu system`);
}

// Function to open an IDW environment in a new browser window or tab
function openIDWEnvironment(url, label) {
  // Here you would implement the logic to open the IDW environment
  // This could be opening a new window, a new tab, or navigating an existing view
  console.log(`Opening IDW environment: ${label} (${url})`);
  
  // Example: Open in a new browser window
  const idwWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: `IDW - ${label}`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  
  // Load the URL
  idwWindow.loadURL(url);
}

// Function to open the data test page
function openDataTestPage() {
  console.log('openDataTestPage function called');
  
  // Don't open multiple test windows
  if (testWindow) {
    console.log('Test window already exists, bringing to front');
    testWindow.focus();
    return;
  }
  
  console.log('Creating new test window');
  
  try {
    // Create a new test window using our module
    testWindow = browserWindow.createTestWindow();
    
    // Check if data-test.html exists
    const testFilePath = path.join(__dirname, 'data-test.html');
    console.log('Looking for test file at:', testFilePath);
    if (!fs.existsSync(testFilePath)) {
      console.error('data-test.html file not found at:', testFilePath);
      const mainWindow = browserWindow.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send('show-notification', {
          title: 'Error',
          body: 'Test page file not found. Please check the console for details.'
        });
      }
      return;
    }
    
    // Load the data test HTML file
    console.log('Loading data-test.html');
    testWindow.loadFile('data-test.html');
    
    // Show window when content has loaded
    testWindow.once('ready-to-show', () => {
      console.log('Test window ready to show');
      testWindow.show();
    });
    
    // Handle window closed event
    testWindow.on('closed', () => {
      console.log('Test window closed');
      testWindow = null;
    });
  } catch (error) {
    console.error('Error creating test window:', error);
    const mainWindow = browserWindow.getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send('show-notification', {
        title: 'Error',
        body: `Error creating test window: ${error.message}`
      });
    }
  }
}

// Add a function to open the CSP test page
function openCSPTestPage() {
  console.log('Opening CSP test page');
  
  try {
    // Create a new test window using our browser window module
    const testWindow = browserWindow.createTestWindow();
    
    // Check if csp-test.html exists
    const testFilePath = path.join(__dirname, 'csp-test.html');
    console.log('Looking for CSP test file at:', testFilePath);
    if (!fs.existsSync(testFilePath)) {
      console.error('csp-test.html file not found at:', testFilePath);
      const mainWindow = browserWindow.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send('show-notification', {
          title: 'Error',
          body: 'CSP test file not found. Please check the console for details.'
        });
      }
      return;
    }
    
    // Load the CSP test HTML file
    console.log('Loading csp-test.html');
    testWindow.loadFile('csp-test.html');
    
    // Show window when content has loaded
    testWindow.once('ready-to-show', () => {
      console.log('CSP test window ready to show');
      testWindow.show();
    });
  } catch (error) {
    console.error('Error creating CSP test window:', error);
    const mainWindow = browserWindow.getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send('show-notification', {
        title: 'Error',
        body: `Error creating CSP test window: ${error.message}`
      });
    }
  }
}

// Add a function to debug IDW environments
function debugIDWEnvironments() {
  try {
    console.log('Checking IDW environments in configuration file');
    const idwConfigPath = path.join(app.getPath('userData'), 'idw-entries.json');
    
    if (fs.existsSync(idwConfigPath)) {
      const data = fs.readFileSync(idwConfigPath, 'utf8');
      try {
        const idwEnvironments = JSON.parse(data);
        console.log(`Found ${idwEnvironments.length} IDW environments in config file:`);
        console.log(JSON.stringify(idwEnvironments, null, 2));
      } catch (error) {
        console.error('Error parsing IDW environments from file:', error);
      }
    } else {
      console.log('No IDW environments config file found at:', idwConfigPath);
    }
    
    // Check if main window exists to get localStorage data
    const mainWindow = browserWindow.getMainWindow();
    if (mainWindow && mainWindow.webContents) {
      console.log('Requesting localStorage data from renderer process');
      mainWindow.webContents.executeJavaScript(`
        (function() {
          const envs = localStorage.getItem('idwEnvironments');
          const links = localStorage.getItem('gsxLinks');
          const prefs = localStorage.getItem('userPreferences');
          
          return {
            idwEnvironments: envs ? JSON.parse(envs) : null,
            gsxLinks: links ? JSON.parse(links) : null,
            userPreferences: prefs ? JSON.parse(prefs) : null
          };
        })()
      `).then(data => {
        console.log('LocalStorage data:');
        console.log(JSON.stringify(data, null, 2));
      }).catch(error => {
        console.error('Error getting localStorage data:', error);
      });
    }
  } catch (error) {
    console.error('Error in debugIDWEnvironments:', error);
  }
}

// Add a test function to manually load an IDW environment
function testLoadIDWEnvironment() {
  const testUrl = 'https://idw.edison.onereach.ai/marvin-2';
  console.log('Manually testing IDW environment loading with URL:', testUrl);
  
  try {
    // Call openURLInMainWindow to load the test URL
    browserWindow.openURLInMainWindow(testUrl);
    return true;
  } catch (error) {
    console.error('Error in testLoadIDWEnvironment:', error);
    return false;
  }
}

// Add IPC handler for test command
ipcMain.on('test-idw-load', () => {
  console.log('Received test-idw-load command');
  testLoadIDWEnvironment();
});

// Setup Auto Updater handlers
function setupAutoUpdater() {
  log.info('Setting up auto updater');
  
  // Check if we're in development mode
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  
  if (isDev) {
    // In development, use the dev-app-update.yml file
    const devUpdateConfigPath = path.join(__dirname, 'dev-app-update.yml');
    if (fs.existsSync(devUpdateConfigPath)) {
      log.info('Using development update config:', devUpdateConfigPath);
      autoUpdater.updateConfigPath = devUpdateConfigPath;
    }
  }
  
  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for updates...');
    sendUpdateStatus('checking');
    
    // Show notification that we're checking
    const { Notification } = require('electron');
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: 'Checking for Updates',
        body: 'Looking for new versions...',
        silent: true
      });
      notification.show();
    }
  });
  
  autoUpdater.on('update-available', (info) => {
    log.info('Update available:', info);
    sendUpdateStatus('available', info);
    isCheckingForUpdates = false;
    
    // Show dialog to user
    const { dialog } = require('electron');
    const focusedWindow = BrowserWindow.getFocusedWindow();
    dialog.showMessageBox(focusedWindow, {
      type: 'info',
      title: 'Update Available!',
      message: `A new version (${info.version}) is available!`,
      detail: `Current version: ${app.getVersion()}\nNew version: ${info.version}\n\nWould you like to download it now?`,
      buttons: ['Download', 'Later'],
      defaultId: 0
    }).then(result => {
      if (result.response === 0) {
        downloadUpdate();
      }
    });
  });
  
  autoUpdater.on('update-not-available', (info) => {
    log.info('Update not available:', info);
    sendUpdateStatus('not-available', info);
    isCheckingForUpdates = false;
    
    // Show dialog to user
    const { dialog } = require('electron');
    const focusedWindow = BrowserWindow.getFocusedWindow();
    dialog.showMessageBox(focusedWindow, {
      type: 'info',
      title: 'No Updates Available',
      message: 'You are running the latest version!',
      detail: `Current version: ${app.getVersion()}\n\nYour app is up to date.`,
      buttons: ['OK']
    });
  });
  
      autoUpdater.on('error', (err) => {
      log.error('Error in auto-updater:', err);
      
      // Provide more helpful error messages
      let errorMessage = err.message;
      if (err.message.includes('ERR_CONNECTION_REFUSED') || err.message.includes('ENOTFOUND')) {
        errorMessage = 'Cannot connect to update server. Please check your internet connection.';
      } else if (err.message.includes('404')) {
        errorMessage = 'Update information not found on server.';
      } else if (err.message.includes('net::ERR_INTERNET_DISCONNECTED')) {
        errorMessage = 'No internet connection available.';
      }
      
      sendUpdateStatus('error', { error: errorMessage });
      isCheckingForUpdates = false;
    });
  
  autoUpdater.on('download-progress', (progressObj) => {
    log.info(`Download progress: ${progressObj.percent}%`);
    sendUpdateStatus('progress', progressObj);
    
    // Show progress in the dock icon (macOS)
    if (process.platform === 'darwin') {
      app.dock.setBadge(`${Math.round(progressObj.percent)}%`);
    }
  });
  
  autoUpdater.on('update-downloaded', async (info) => {
    log.info('Update downloaded:', info);
    
    // Clear the dock badge
    if (process.platform === 'darwin') {
      app.dock.setBadge('');
    }
    
    // Create backup of current version before installing update
    try {
      const currentVersion = app.getVersion();
      log.info(`Creating backup of current version v${currentVersion} before update...`);
      
      const backupSuccess = await rollbackManager.createBackup(currentVersion);
      if (backupSuccess) {
        log.info('Backup created successfully');
        sendUpdateStatus('downloaded', { 
          ...info, 
          backupCreated: true,
          currentVersion: currentVersion 
        });
      } else {
        log.warn('Failed to create backup, but update can still proceed');
        sendUpdateStatus('downloaded', { 
          ...info, 
          backupCreated: false,
          currentVersion: currentVersion 
        });
      }
    } catch (error) {
      log.error('Error creating backup:', error);
      // Still allow update to proceed even if backup fails
      sendUpdateStatus('downloaded', info);
    }
    
    // Show dialog to user
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const dialogOptions = {
      type: 'info',
      title: 'Update Ready to Install',
      message: `Version ${info.version} has been downloaded.`,
      detail: 'The application will restart to apply the update. Your settings and data will be preserved.',
      buttons: ['Install and Restart', 'Install Later'],
      defaultId: 0,
      cancelId: 1
    };
    
    dialog.showMessageBox(focusedWindow, dialogOptions).then((result) => {
      if (result.response === 0) {
        // User chose to install and restart
        log.info('User chose to install update and restart');
        autoUpdater.quitAndInstall();
      } else {
        // User chose to install later
        log.info('User chose to install update later');
        dialog.showMessageBox(focusedWindow, {
          type: 'info',
          title: 'Update Postponed',
          message: 'The update will be installed when you restart the application.',
          buttons: ['OK']
        });
      }
    });
  });
}

// Function to send update status to renderer
function sendUpdateStatus(status, info = {}) {
  const mainWindow = browserWindow.getMainWindow();
  if (mainWindow) {
    mainWindow.webContents.send('update-status', { status, info });
  }
}

// Function to check for updates
let isCheckingForUpdates = false;

function checkForUpdates() {
  if (isCheckingForUpdates) {
    log.info('Update check already in progress, ignoring duplicate request');
    return;
  }
  
  log.info('Manually checking for updates...');
  isCheckingForUpdates = true;
  
  try {
    autoUpdater.checkForUpdates().then(() => {
      // Reset flag when check completes (success or failure)
      setTimeout(() => {
        isCheckingForUpdates = false;
      }, 1000);
    }).catch(err => {
      log.error('Failed to check for updates:', err);
      
      // Show user-friendly error if repository doesn't exist
      const { dialog } = require('electron');
      const focusedWindow = BrowserWindow.getFocusedWindow();
      if (err.message && (err.message.includes('404') || err.message.includes('Not Found'))) {
        dialog.showMessageBox(focusedWindow, {
          type: 'info',
          title: 'No Updates Available',
          message: 'Update repository not configured',
          detail: 'The public releases repository has not been created yet.\n\nTo enable auto-updates:\n1. Create repository: github.com/wilsr7000/onereach_desktop\n2. Make it PUBLIC\n3. Publish a release using: npm run release',
          buttons: ['OK']
        });
      }
      
      sendUpdateStatus('error', { error: err.message });
      isCheckingForUpdates = false;
    });
  } catch (err) {
    log.error('Exception when checking for updates:', err);
    sendUpdateStatus('error', { error: err.message });
    isCheckingForUpdates = false;
  }
}

// Make function available globally for menu.js
global.checkForUpdatesGlobal = checkForUpdates;

// Function to download an available update
function downloadUpdate() {
  log.info('Starting update download...');
  
  // Show notification that download is starting
  const focusedWindow = BrowserWindow.getFocusedWindow();
  dialog.showMessageBox(focusedWindow, {
    type: 'info',
    title: 'Downloading Update',
    message: 'The update is now downloading in the background.',
    detail: 'You can continue using the app. You\'ll be notified when the download is complete.\n\nProgress will be shown in the dock icon.',
    buttons: ['OK']
  });
  
  try {
    autoUpdater.downloadUpdate().catch(err => {
      log.error('Failed to download update:', err);
      sendUpdateStatus('error', { error: err.message });
      
      // Clear dock badge on error
      if (process.platform === 'darwin') {
        app.dock.setBadge('');
      }
      
      // Show error dialog
      dialog.showMessageBox(focusedWindow, {
        type: 'error',
        title: 'Download Failed',
        message: 'Failed to download the update.',
        detail: err.message,
        buttons: ['OK']
      });
    });
  } catch (err) {
    log.error('Exception when downloading update:', err);
    sendUpdateStatus('error', { error: err.message });
    
    // Clear dock badge on error
    if (process.platform === 'darwin') {
      app.dock.setBadge('');
    }
    
    // Show error dialog
    dialog.showMessageBox(focusedWindow, {
      type: 'error',
      title: 'Download Failed',
      message: 'Failed to download the update.',
      detail: err.message,
      buttons: ['OK']
    });
  }
}

// Function to install a downloaded update
function installUpdate() {
  log.info('Installing update...');
  
  try {
    autoUpdater.quitAndInstall(false, true);
  } catch (err) {
    log.error('Exception when installing update:', err);
    sendUpdateStatus('error', { error: err.message });
  }
}

// Export functions for use in other modules
module.exports = {
  openSetupWizard,
  updateIDWMenu,
  updateGSXMenu
}; 