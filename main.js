const { app, ipcMain, Tray, Menu, MenuItem, BrowserWindow, desktopCapturer, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { setApplicationMenu, registerTestMenuShortcut, refreshGSXLinks } = require('./menu');
const { shell } = require('electron');
const browserWindow = require('./browserWindow');
const log = require('electron-log');
const ClipboardManager = require('./clipboard-manager-v2-adapter');
const rollbackManager = require('./rollback-manager');
const { SnapshotStorage } = require('./src/state-manager/SnapshotStorage');
const ModuleManager = require('./module-manager');
const getLogger = require('./event-logger');
let logger = getLogger(); // This might be a stub initially
const { createConsoleInterceptor } = require('./console-interceptor');
const { getGSXFileSync } = require('./gsx-file-sync');
const { AiderBridgeClient } = require('./aider-bridge-client');
// Use video editor module (note: src/video/ is the new modular architecture)
const VideoEditor = require('./video-editor');
const { getRecorder } = require('./recorder');
const { getBudgetManager } = require('./budget-manager');

// Global Budget Manager instance
let budgetManager = null;

// Enable Speech Recognition API in Electron
// These must be set before app.whenReady()
app.commandLine.appendSwitch('enable-speech-dispatcher');
app.commandLine.appendSwitch('enable-experimental-web-platform-features');

// Global Aider Bridge instance (main/shared)
let aiderBridge = null;

// Branch Aider Manager - handles sandboxed Aider processes per branch
class BranchAiderManager {
  constructor() {
    this.branches = new Map(); // branchId -> { aider: AiderBridgeClient, logFile: string, startTime: Date }
    this.logsDir = null;
    this.orchestrationLogFile = null;
  }
  
  async initialize(spacePath) {
    const fs = require('fs');
    const path = require('path');
    
    this.logsDir = path.join(spacePath, 'logs');
    const branchLogsDir = path.join(this.logsDir, 'branches');
    
    // Create log directories
    if (!fs.existsSync(branchLogsDir)) {
      fs.mkdirSync(branchLogsDir, { recursive: true });
    }
    
    this.orchestrationLogFile = path.join(this.logsDir, 'orchestration.log');
    this.logOrchestration('SESSION', 'Branch Aider Manager initialized');
  }
  
  logOrchestration(level, message, data = {}) {
    const fs = require('fs');
    if (!this.orchestrationLogFile) return;
    
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${level}: ${message}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`;
    
    try {
      fs.appendFileSync(this.orchestrationLogFile, logLine);
    } catch (e) {
      console.error('[BranchManager] Failed to write orchestration log:', e);
    }
    console.log(`[BranchManager] ${level}: ${message}`);
  }
  
  logBranch(branchId, level, message, data = {}) {
    const fs = require('fs');
    const path = require('path');
    if (!this.logsDir) return;
    
    const logFile = path.join(this.logsDir, 'branches', `${branchId}.log`);
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${level}: ${message}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`;
    
    try {
      fs.appendFileSync(logFile, logLine);
    } catch (e) {
      console.error(`[BranchManager] Failed to write branch log ${branchId}:`, e);
    }
  }
  
  async initBranch(branchPath, branchId, model, readOnlyFiles = []) {
    const { AiderBridgeClient } = require('./aider-bridge-client');
    const { getSettingsManager } = require('./settings-manager');
    const path = require('path');
    
    this.logOrchestration('BRANCH', `Initializing ${branchId}`, { model, branchPath });
    
    // Check if branch already has an Aider instance
    if (this.branches.has(branchId)) {
      this.logOrchestration('WARN', `Branch ${branchId} already initialized, cleaning up first`);
      await this.cleanupBranch(branchId);
    }
    
    const settings = getSettingsManager();
    const apiKey = settings.getLLMApiKey();
    const provider = settings.getLLMProvider();
    
    // Use pipx-installed Python
    const aiderPythonPath = '/Users/richardwilson/.local/pipx/venvs/aider-chat/bin/python3';
    
    const aider = new AiderBridgeClient(aiderPythonPath, apiKey, provider);
    await aider.start();
    
    // Initialize with branch path as root
    const initResult = await aider.initialize(branchPath, model || 'claude-opus-4-5-20251101');
    
    if (!initResult.success) {
      throw new Error(`Failed to initialize branch Aider: ${initResult.error}`);
    }
    
    // Set sandbox restrictions
    const sandboxResult = await aider.sendRequest('set_sandbox', {
      sandbox_root: branchPath,
      read_only_files: readOnlyFiles,
      branch_id: branchId
    });
    
    if (!sandboxResult.success) {
      console.warn(`[BranchManager] Warning: Sandbox setup returned: ${JSON.stringify(sandboxResult)}`);
    }
    
    // Add branch files to Aider context
    const fs = require('fs');
    try {
      const branchFiles = fs.readdirSync(branchPath);
      const editableFiles = branchFiles
        .filter(f => {
          const filePath = path.join(branchPath, f);
          const stat = fs.statSync(filePath);
          // Only include files (not directories), and exclude metadata files
          return stat.isFile() && !f.startsWith('.') && !f.endsWith('.json');
        })
        .map(f => path.join(branchPath, f));
      
      if (editableFiles.length > 0) {
        this.logOrchestration('BRANCH', `Adding ${editableFiles.length} files to ${branchId} context`, { files: editableFiles.map(f => path.basename(f)) });
        const addResult = await aider.sendRequest('add_files', { file_paths: editableFiles });
        
        if (!addResult.success) {
          console.warn(`[BranchManager] Warning: Failed to add files to branch context:`, addResult);
        } else {
          this.logBranch(branchId, 'FILES', `Added ${editableFiles.length} files to context`, { files: editableFiles.map(f => path.basename(f)) });
        }
      }
    } catch (fileError) {
      console.warn(`[BranchManager] Warning: Could not list branch files:`, fileError.message);
    }
    
    // Store branch info
    this.branches.set(branchId, {
      aider,
      branchPath,
      logFile: path.join(this.logsDir, 'branches', `${branchId}.log`),
      startTime: new Date(),
      model
    });
    
    this.logOrchestration('BRANCH', `${branchId} started`, { model });
    this.logBranch(branchId, 'INIT', `Aider initialized`, { branchPath, model, sandbox: true });
    
    return { success: true, branchId };
  }
  
  async runBranchPrompt(branchId, prompt, streamCallback = null) {
    const branch = this.branches.get(branchId);
    if (!branch) {
      throw new Error(`Branch ${branchId} not initialized`);
    }
    
    this.logBranch(branchId, 'PROMPT', prompt.substring(0, 200) + '...');
    this.logOrchestration('BRANCH', `${branchId} executing prompt`, { promptLength: prompt.length });
    
    let result;
    if (streamCallback) {
      result = await branch.aider.runPromptStreaming(prompt, streamCallback);
    } else {
      result = await branch.aider.runPrompt(prompt);
    }
    
    this.logBranch(branchId, 'RESPONSE', `Success: ${result.success}`, {
      modifiedFiles: result.modified_files?.length || 0,
      newFiles: result.new_files?.length || 0
    });
    
    if (result.file_details) {
      for (const file of result.file_details) {
        this.logBranch(branchId, 'EDIT', `${file.action}: ${file.name}`);
      }
    }
    
    return result;
  }
  
  async cleanupBranch(branchId) {
    const branch = this.branches.get(branchId);
    if (!branch) {
      return { success: true, message: 'Branch not found (already cleaned up)' };
    }
    
    this.logOrchestration('BRANCH', `${branchId} cleaning up`);
    this.logBranch(branchId, 'CLEANUP', 'Shutting down Aider instance');
    
    try {
      await branch.aider.shutdown();
    } catch (e) {
      console.error(`[BranchManager] Error shutting down branch ${branchId}:`, e);
    }
    
    this.branches.delete(branchId);
    
    this.logOrchestration('BRANCH', `${branchId} cleaned up`);
    return { success: true };
  }
  
  async cleanupAll() {
    this.logOrchestration('SESSION', 'Cleaning up all branches');
    
    for (const branchId of this.branches.keys()) {
      await this.cleanupBranch(branchId);
    }
    
    this.logOrchestration('SESSION', 'All branches cleaned up');
  }
  
  getBranchLog(branchId) {
    const fs = require('fs');
    const path = require('path');
    
    if (!this.logsDir) return null;
    
    const logFile = path.join(this.logsDir, 'branches', `${branchId}.log`);
    try {
      if (fs.existsSync(logFile)) {
        return fs.readFileSync(logFile, 'utf-8');
      }
    } catch (e) {
      console.error(`[BranchManager] Error reading branch log ${branchId}:`, e);
    }
    return null;
  }
  
  getOrchestrationLog() {
    const fs = require('fs');
    
    if (!this.orchestrationLogFile) return null;
    
    try {
      if (fs.existsSync(this.orchestrationLogFile)) {
        return fs.readFileSync(this.orchestrationLogFile, 'utf-8');
      }
    } catch (e) {
      console.error('[BranchManager] Error reading orchestration log:', e);
    }
    return null;
  }
  
  getActiveBranches() {
    return Array.from(this.branches.entries()).map(([id, info]) => ({
      branchId: id,
      branchPath: info.branchPath,
      model: info.model,
      startTime: info.startTime.toISOString()
    }));
  }
}

// Global Branch Aider Manager instance
let branchAiderManager = null;

// Global Snapshot Storage instance (for state manager)
let snapshotStorage = null;

// Global Video Editor instance
let videoEditor = null;

// Global Recorder instance
let recorder = null;

// autoUpdater - loaded lazily after app is ready
let autoUpdater = null;

// Configure logging for updates
log.transports.file.level = 'info';

// Path to IDW entries configuration file - initialized lazily
let idwConfigPath = null;
function getIdwConfigPath() {
  if (!idwConfigPath) {
    idwConfigPath = path.join(app.getPath('userData'), 'idw-entries.json');
  }
  return idwConfigPath;
}

// Keep global references to prevent garbage collection
let tray;
let testWindow = null;
let clipboardManager = null;
let moduleManager = null;
let registeredShortcuts = []; // Track our registered shortcuts

// Initialize clipboard manager - moved to app.whenReady()

// Override shell.openExternal to handle GSX URLs - wrapped in function to call after app ready
function setupShellOverride() {
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
}

// Create a global reference to the setup wizard function for direct access
global.openSetupWizardGlobal = () => {
  console.log('Opening setup wizard via global function');
  openSetupWizard();
};

// ---- Browser command-line tweaks ----
// NOTE: These are now set inside app.whenReady() to avoid "app undefined" errors
// The switches still work when set early in the ready handler

// Configure default session for better OAuth support
app.whenReady().then(() => {
  // Allow detached/remote-controlled media playback (Chromium blocks play() without a user gesture by default).
  // This matters for the detached video window, which is driven via IPC.
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  // Set up shell.openExternal override
  setupShellOverride();
  
  // Load and configure autoUpdater (must be done after app is ready)
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.logger = log;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
  } catch (e) {
    console.log('AutoUpdater not available:', e.message);
  }
  
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
  // Use properly sized template icon for macOS (22x22 with @2x variant for retina)
  // Template naming convention allows macOS to automatically adapt icon color for light/dark mode
  const { nativeImage } = require('electron');
  const templateIconPath = path.join(__dirname, 'assets/tray-iconTemplate.png');
  const fallbackIconPath = path.join(__dirname, 'assets/tray-icon.png');
  
  // Use template icon if it exists, otherwise fall back to regular icon
  let trayIconPath;
  if (fs.existsSync(templateIconPath)) {
    trayIconPath = templateIconPath;
    console.log('Using template tray icon:', templateIconPath);
  } else {
    trayIconPath = fallbackIconPath;
    console.log('Template icon not found, using fallback:', fallbackIconPath);
  }
  
  // Get main window reference
  const mainWindow = browserWindow.getMainWindow();
  
  // Create the tray icon using nativeImage and set as template for proper macOS rendering
  let trayIcon = nativeImage.createFromPath(trayIconPath);
  
  // On macOS, explicitly mark as template image for proper menu bar rendering
  if (process.platform === 'darwin') {
    trayIcon.setTemplateImage(true);
    console.log('Set tray icon as template image for macOS');
  }
  
  tray = new Tray(trayIcon);
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
  
  // Forward renderer logs to main process console
  ipcMain.on('log-message', (event, message) => {
    console.log(message);
  });

  // Debug-mode logger: renderer -> main -> append NDJSON
  // (Used when CSP/network blocks HTTP ingest)
  ipcMain.on('debug:log', (event, payload) => {
    try {
      const fs = require('fs');
      const logPath = path.join(__dirname, '.cursor', 'debug.log');
      const safePayload = {
        ...payload,
        timestamp: typeof payload?.timestamp === 'number' ? payload.timestamp : Date.now(),
      };
      fs.appendFileSync(logPath, JSON.stringify(safePayload) + '\n', 'utf8');
    } catch (err) {
      // Avoid crashing main process for debug logging
      console.error('[debug:log] failed to write', err?.message || err);
    }
  });
  
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

  // Create the main window FIRST for faster perceived startup
  createWindow();
  logger.logWindowCreated('main', 1, {
    bounds: { width: 1400, height: 900 },
    url: 'index.html'
  });
  
  // Initialize settings manager EARLY (needed for other managers)
  const { getSettingsManager } = require('./settings-manager');
  global.settingsManager = getSettingsManager();
  console.log('Settings manager initialized');
  
  // Initialize Menu Data Manager - SINGLE SOURCE OF TRUTH for all menu data
  // This handles: IDW environments, external bots, creators, GSX links, etc.
  // It provides: atomic saves, validation, debounced updates, event-driven architecture
  const { getMenuDataManager } = require('./menu-data-manager');
  global.menuDataManager = getMenuDataManager();
  global.menuDataManager.initialize();
  console.log('Menu Data Manager initialized');
  
  // Add keyboard shortcuts to open dev tools (only in development mode)
  const isDevelopment = process.env.NODE_ENV === 'development' || !app.isPackaged;
  
  if (isDevelopment) {
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
    console.log('Registered Cmd+Shift+I and F12 shortcuts for Developer Tools (dev mode)');
  } else {
    console.log('DevTools shortcuts disabled in production mode');
  }
  
  // PERFORMANCE: Defer heavyweight manager initializations until after window shows
  // This makes the app feel snappier by showing the UI first
  setImmediate(() => {
    console.log('[Startup] Initializing deferred managers...');
    
    // Initialize clipboard manager
    try {
      console.log('[DEBUG-H1] Creating new ClipboardManager instance...');
      clipboardManager = new ClipboardManager();
      console.log('[DEBUG-H1] ClipboardManager created, registering shortcut...');
      clipboardManager.registerShortcut();
      global.clipboardManager = clipboardManager;
      console.log('Clipboard manager initialized');
      logger.logFeatureUsed('clipboard-manager', {
        status: 'initialized',
        shortcutRegistered: true
      });
      
      // Initialize App Health Dashboard components
      try {
        const { getDashboardAPI } = require('./dashboard-api');
        const { getLLMUsageTracker } = require('./llm-usage-tracker');
        const { getAssetPipeline } = require('./asset-pipeline');
        const { getPipelineVerifier } = require('./pipeline-verifier');
        const { getThumbnailPipeline } = require('./thumbnail-pipeline');
        const { getAppManagerAgent } = require('./app-manager-agent');
        const MetadataGenerator = require('./metadata-generator');
        
        // Initialize LLM tracker
        const llmTracker = getLLMUsageTracker();
        global.llmUsageTracker = llmTracker;
        
        // Initialize Dashboard API
        const dashboardAPI = getDashboardAPI();
        global.dashboardAPI = dashboardAPI;
        
        // Initialize pipeline components
        const thumbnailPipeline = getThumbnailPipeline();
        const pipelineVerifier = getPipelineVerifier(clipboardManager.storage);
        const metadataGenerator = new MetadataGenerator(clipboardManager);
        
        // Initialize asset pipeline with dependencies
        const assetPipeline = getAssetPipeline({
          clipboardManager,
          thumbnailPipeline,
          metadataGenerator,
          verifier: pipelineVerifier,
          dashboardAPI
        });
        global.assetPipeline = assetPipeline;
        
        // Initialize App Manager Agent
        const agent = getAppManagerAgent({
          dashboardAPI,
          clipboardManager,
          pipelineVerifier,
          metadataGenerator,
          thumbnailPipeline
        });
        global.appManagerAgent = agent;
        
        // Set up Dashboard IPC handlers
        dashboardAPI.setupIPC({
          clipboardManager,
          llmTracker,
          agent
        });
        
        // Start agent (delayed to allow app to fully initialize)
        setTimeout(() => {
          agent.start();
          console.log('[App] App Manager Agent started');
        }, 5000);
        
        console.log('[App] Dashboard API and components initialized');
      } catch (dashboardError) {
        console.error('[App] Error initializing dashboard components:', dashboardError);
      }
    } catch (error) {
      console.error('[Startup] Error initializing clipboard manager:', error);
    }
    
    // Initialize video editor
    try {
      videoEditor = new VideoEditor();
      global.videoEditor = videoEditor;
      console.log('Video editor initialized');
    } catch (error) {
      console.error('[Startup] Error initializing video editor:', error);
    }

    // Initialize recorder
    try {
      recorder = getRecorder();
      recorder.setupIPC();
      global.recorder = recorder;
      console.log('Recorder initialized');
    } catch (error) {
      console.error('[Startup] Error initializing recorder:', error);
    }
    
    // Initialize module manager
    try {
      moduleManager = new ModuleManager();
      global.moduleManager = moduleManager;
      // Make updateApplicationMenu globally available for module manager
      global.updateApplicationMenu = updateApplicationMenu;
      console.log('Module manager initialized');
    } catch (error) {
      console.error('[Startup] Error initializing module manager:', error);
    }
    
    // Initialize the application menu
    try {
      console.log('[Startup] Setting up application menu...');
      const idwEnvironments = global.settingsManager ? global.settingsManager.get('idwEnvironments') || [] : [];
      setApplicationMenu(idwEnvironments);
      console.log('[Startup] Application menu initialized with', idwEnvironments.length, 'IDW environments');
    } catch (error) {
      console.error('[Startup] Error initializing application menu:', error);
    }
    
    // Initialize Speech Recognition Bridge (Whisper-based, for web apps)
    try {
      const { getSpeechBridge } = require('./speech-recognition-bridge');
      const speechBridge = getSpeechBridge();
      speechBridge.setupIPC();
      global.speechBridge = speechBridge;
      console.log('[SpeechBridge] Speech recognition bridge initialized (Whisper API)');
    } catch (error) {
      console.error('[Startup] Error initializing speech bridge:', error);
    }

    // Initialize Realtime Speech (OpenAI Realtime API for streaming transcription)
    try {
      const { getRealtimeSpeech } = require('./realtime-speech');
      const realtimeSpeech = getRealtimeSpeech();
      realtimeSpeech.setupIPC();
      global.realtimeSpeech = realtimeSpeech;
      console.log('[RealtimeSpeech] Realtime streaming speech initialized');
    } catch (error) {
      console.error('[Startup] Error initializing realtime speech:', error);
    }

    console.log('[Startup] Deferred managers initialized');
  });
  
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
  
  // Create and setup IPC handlers  
  console.log('[Main] About to call setupIPC');
  try {
    setupIPC();
    console.log('[Main] setupIPC completed successfully');
  } catch (error) {
    console.error('[Main] Error in setupIPC:', error);
  }
  
  // Setup unified Spaces API
  try {
    setupSpacesAPI();
    console.log('[Main] Spaces API initialized');
  } catch (error) {
    console.error('[Main] Error setting up Spaces API:', error);
  }
  
  // Register test menu shortcut
  console.log('[Main] Registering test menu shortcut');
  registerTestMenuShortcut();
  
  // Set up auto updater
  setupAutoUpdater();
  
  // Check for updates in the background (non-blocking)
  setTimeout(() => {
    if (app.isPackaged) {
      checkForUpdates();
    } else {
      log.info('Not checking for updates in development mode');
    }
  }, 5000); // Check after 5 seconds to not block startup
});

// ============================================
// UNIFIED SPACES API
// ============================================

/**
 * Set up the unified Spaces API IPC handlers
 * This provides a consistent API for all apps to access spaces and items
 */
function setupSpacesAPI() {
  console.log('[SpacesAPI] Setting up IPC handlers...');
  
  const { getSpacesAPI } = require('./spaces-api');
  const spacesAPI = getSpacesAPI();
  
  // Set up broadcast handler to notify all windows of changes
  spacesAPI.setBroadcastHandler((event, data) => {
    try {
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('spaces:event', { type: event, ...data });
        }
      });
    } catch (error) {
      console.error('[SpacesAPI] Broadcast error:', error);
    }
  });
  
  // ---- SPACE MANAGEMENT ----
  
  // List all spaces
  ipcMain.handle('spaces:list', async () => {
    try {
      return await spacesAPI.list();
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:list:', error);
      return [];
    }
  });
  
  // Get a single space
  ipcMain.handle('spaces:get', async (event, spaceId) => {
    try {
      return await spacesAPI.get(spaceId);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:get:', error);
      return null;
    }
  });
  
  // Create a new space
  ipcMain.handle('spaces:create', async (event, name, options = {}) => {
    try {
      return await spacesAPI.create(name, options);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:create:', error);
      throw error;
    }
  });
  
  // Update a space
  ipcMain.handle('spaces:update', async (event, spaceId, data) => {
    try {
      return await spacesAPI.update(spaceId, data);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:update:', error);
      return false;
    }
  });
  
  // Delete a space
  ipcMain.handle('spaces:delete', async (event, spaceId) => {
    try {
      return await spacesAPI.delete(spaceId);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:delete:', error);
      return false;
    }
  });
  
  // ---- ITEM MANAGEMENT ----
  
  // List items in a space
  ipcMain.handle('spaces:items:list', async (event, spaceId, options = {}) => {
    try {
      return await spacesAPI.items.list(spaceId, options);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:items:list:', error);
      return [];
    }
  });
  
  // Get a single item
  ipcMain.handle('spaces:items:get', async (event, spaceId, itemId) => {
    try {
      return await spacesAPI.items.get(spaceId, itemId);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:items:get:', error);
      return null;
    }
  });
  
  // Add an item to a space
  ipcMain.handle('spaces:items:add', async (event, spaceId, item) => {
    try {
      return await spacesAPI.items.add(spaceId, item);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:items:add:', error);
      throw error;
    }
  });
  
  // Update an item
  ipcMain.handle('spaces:items:update', async (event, spaceId, itemId, data) => {
    try {
      return await spacesAPI.items.update(spaceId, itemId, data);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:items:update:', error);
      return false;
    }
  });
  
  // Delete an item
  ipcMain.handle('spaces:items:delete', async (event, spaceId, itemId) => {
    try {
      return await spacesAPI.items.delete(spaceId, itemId);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:items:delete:', error);
      return false;
    }
  });
  
  // Move an item to a different space
  ipcMain.handle('spaces:items:move', async (event, itemId, fromSpaceId, toSpaceId) => {
    try {
      return await spacesAPI.items.move(itemId, fromSpaceId, toSpaceId);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:items:move:', error);
      return false;
    }
  });
  
  // Toggle item pin
  ipcMain.handle('spaces:items:togglePin', async (event, spaceId, itemId) => {
    try {
      return await spacesAPI.items.togglePin(spaceId, itemId);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:items:togglePin:', error);
      return false;
    }
  });
  
  // ---- SEARCH ----
  
  // Search across spaces
  ipcMain.handle('spaces:search', async (event, query, options = {}) => {
    try {
      return await spacesAPI.search(query, options);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:search:', error);
      return [];
    }
  });
  
  // ---- METADATA ----
  
  // Get space metadata
  ipcMain.handle('spaces:metadata:get', async (event, spaceId) => {
    try {
      return await spacesAPI.metadata.getSpace(spaceId);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:metadata:get:', error);
      return null;
    }
  });
  
  // Update space metadata
  ipcMain.handle('spaces:metadata:update', async (event, spaceId, data) => {
    try {
      return await spacesAPI.metadata.updateSpace(spaceId, data);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:metadata:update:', error);
      return null;
    }
  });
  
  // Get file metadata
  ipcMain.handle('spaces:metadata:getFile', async (event, spaceId, filePath) => {
    try {
      return await spacesAPI.metadata.getFile(spaceId, filePath);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:metadata:getFile:', error);
      return null;
    }
  });
  
  // Set file metadata
  ipcMain.handle('spaces:metadata:setFile', async (event, spaceId, filePath, data) => {
    try {
      return await spacesAPI.metadata.setFile(spaceId, filePath, data);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:metadata:setFile:', error);
      return null;
    }
  });
  
  // Set asset metadata
  ipcMain.handle('spaces:metadata:setAsset', async (event, spaceId, assetType, data) => {
    try {
      return await spacesAPI.metadata.setAsset(spaceId, assetType, data);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:metadata:setAsset:', error);
      return null;
    }
  });
  
  // Set approval
  ipcMain.handle('spaces:metadata:setApproval', async (event, spaceId, itemType, itemId, approved) => {
    try {
      return await spacesAPI.metadata.setApproval(spaceId, itemType, itemId, approved);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:metadata:setApproval:', error);
      return null;
    }
  });
  
  // Add version
  ipcMain.handle('spaces:metadata:addVersion', async (event, spaceId, versionData) => {
    try {
      return await spacesAPI.metadata.addVersion(spaceId, versionData);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:metadata:addVersion:', error);
      return null;
    }
  });
  
  // Update project config
  ipcMain.handle('spaces:metadata:updateProjectConfig', async (event, spaceId, config) => {
    try {
      return await spacesAPI.metadata.updateProjectConfig(spaceId, config);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:metadata:updateProjectConfig:', error);
      return null;
    }
  });
  
  // ---- FILE SYSTEM ----
  
  // Get space path
  ipcMain.handle('spaces:files:getPath', async (event, spaceId) => {
    try {
      return await spacesAPI.files.getSpacePath(spaceId);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:files:getPath:', error);
      return null;
    }
  });
  
  // List files in space
  ipcMain.handle('spaces:files:list', async (event, spaceId, subPath = '') => {
    try {
      return await spacesAPI.files.list(spaceId, subPath);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:files:list:', error);
      return [];
    }
  });
  
  // Read file from space
  ipcMain.handle('spaces:files:read', async (event, spaceId, filePath) => {
    try {
      return await spacesAPI.files.read(spaceId, filePath);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:files:read:', error);
      return null;
    }
  });
  
  // Write file to space
  ipcMain.handle('spaces:files:write', async (event, spaceId, filePath, content) => {
    try {
      return await spacesAPI.files.write(spaceId, filePath, content);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:files:write:', error);
      return false;
    }
  });
  
  // Delete file from space
  ipcMain.handle('spaces:files:delete', async (event, spaceId, filePath) => {
    try {
      return await spacesAPI.files.delete(spaceId, filePath);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:files:delete:', error);
      return false;
    }
  });
  
  // Get storage root path
  ipcMain.handle('spaces:getStorageRoot', async () => {
    try {
      return spacesAPI.getStorageRoot();
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:getStorageRoot:', error);
      return null;
    }
  });
  
  // ---- TAG MANAGEMENT ----
  
  // Get tags for an item
  ipcMain.handle('spaces:items:getTags', async (event, spaceId, itemId) => {
    try {
      return await spacesAPI.items.getTags(spaceId, itemId);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:items:getTags:', error);
      return [];
    }
  });
  
  // Set tags for an item
  ipcMain.handle('spaces:items:setTags', async (event, spaceId, itemId, tags) => {
    try {
      return await spacesAPI.items.setTags(spaceId, itemId, tags);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:items:setTags:', error);
      return false;
    }
  });
  
  // Add a tag to an item
  ipcMain.handle('spaces:items:addTag', async (event, spaceId, itemId, tag) => {
    try {
      return await spacesAPI.items.addTag(spaceId, itemId, tag);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:items:addTag:', error);
      return [];
    }
  });
  
  // Remove a tag from an item
  ipcMain.handle('spaces:items:removeTag', async (event, spaceId, itemId, tag) => {
    try {
      return await spacesAPI.items.removeTag(spaceId, itemId, tag);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:items:removeTag:', error);
      return [];
    }
  });
  
  // Generate metadata for an item
  ipcMain.handle('spaces:items:generateMetadata', async (event, spaceId, itemId, options = {}) => {
    try {
      return await spacesAPI.items.generateMetadata(spaceId, itemId, options);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:items:generateMetadata:', error);
      return { success: false, error: error.message };
    }
  });
  
  // List all tags in a space
  ipcMain.handle('spaces:tags:list', async (event, spaceId) => {
    try {
      return await spacesAPI.tags.list(spaceId);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:tags:list:', error);
      return [];
    }
  });
  
  // List all tags across all spaces
  ipcMain.handle('spaces:tags:listAll', async () => {
    try {
      return await spacesAPI.tags.listAll();
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:tags:listAll:', error);
      return [];
    }
  });
  
  // Find items by tags
  ipcMain.handle('spaces:tags:findItems', async (event, tags, options = {}) => {
    try {
      return await spacesAPI.tags.findItems(tags, options);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:tags:findItems:', error);
      return [];
    }
  });
  
  // Rename a tag in a space
  ipcMain.handle('spaces:tags:rename', async (event, spaceId, oldTag, newTag) => {
    try {
      return await spacesAPI.tags.rename(spaceId, oldTag, newTag);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:tags:rename:', error);
      return 0;
    }
  });
  
  // Delete a tag from a space
  ipcMain.handle('spaces:tags:deleteFromSpace', async (event, spaceId, tag) => {
    try {
      return await spacesAPI.tags.deleteFromSpace(spaceId, tag);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:tags:deleteFromSpace:', error);
      return 0;
    }
  });
  
  // ---- SMART FOLDERS ----
  
  // List all smart folders
  ipcMain.handle('spaces:smartFolders:list', async () => {
    try {
      return await spacesAPI.smartFolders.list();
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:smartFolders:list:', error);
      return [];
    }
  });
  
  // Get a single smart folder
  ipcMain.handle('spaces:smartFolders:get', async (event, folderId) => {
    try {
      return await spacesAPI.smartFolders.get(folderId);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:smartFolders:get:', error);
      return null;
    }
  });
  
  // Create a smart folder
  ipcMain.handle('spaces:smartFolders:create', async (event, name, criteria, options = {}) => {
    try {
      return await spacesAPI.smartFolders.create(name, criteria, options);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:smartFolders:create:', error);
      throw error;
    }
  });
  
  // Update a smart folder
  ipcMain.handle('spaces:smartFolders:update', async (event, folderId, updates) => {
    try {
      return await spacesAPI.smartFolders.update(folderId, updates);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:smartFolders:update:', error);
      return null;
    }
  });
  
  // Delete a smart folder
  ipcMain.handle('spaces:smartFolders:delete', async (event, folderId) => {
    try {
      return await spacesAPI.smartFolders.delete(folderId);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:smartFolders:delete:', error);
      return false;
    }
  });
  
  // Get items matching a smart folder
  ipcMain.handle('spaces:smartFolders:getItems', async (event, folderId, options = {}) => {
    try {
      return await spacesAPI.smartFolders.getItems(folderId, options);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:smartFolders:getItems:', error);
      return [];
    }
  });
  
  // Preview items for criteria without saving
  ipcMain.handle('spaces:smartFolders:preview', async (event, criteria, options = {}) => {
    try {
      return await spacesAPI.smartFolders.preview(criteria, options);
    } catch (error) {
      console.error('[SpacesAPI] Error in spaces:smartFolders:preview:', error);
      return [];
    }
  });
  
  console.log('[SpacesAPI] ✅ All IPC handlers registered (including tags and smart folders)');
}

// Set up module manager IPC handlers
function setupModuleManagerIPC() {
  const ModuleEvaluator = require('./module-evaluator');
  const evaluator = new ModuleEvaluator();
  
  // Get installed modules
  ipcMain.handle('module:get-installed', async () => {
    if (!global.moduleManager) {
      return []; // Not yet initialized
    }
    return global.moduleManager.getInstalledModules();
  });
  
  // Open module
  ipcMain.handle('module:open', async (event, moduleId) => {
    try {
      if (!global.moduleManager) {
        return { success: false, error: 'Module manager not yet initialized' };
      }
      global.moduleManager.openModule(moduleId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Uninstall module
  ipcMain.handle('module:uninstall', async (event, moduleId) => {
    try {
      if (!global.moduleManager) {
        return { success: false, error: 'Module manager not yet initialized' };
      }
      global.moduleManager.removeModule(moduleId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Install from URL
  ipcMain.handle('module:install-from-url', async (event, url) => {
    try {
      if (!global.moduleManager) {
        return { success: false, error: 'Module manager not yet initialized' };
      }
      const manifest = await global.moduleManager.installModuleFromUrl(url);
      return { success: true, manifest };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Install from file
  ipcMain.handle('module:install-from-file', async (event, filePath) => {
    try {
      if (!global.moduleManager) {
        return { success: false, error: 'Module manager not yet initialized' };
      }
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
    if (!global.moduleManager) {
      return []; // Not yet initialized
    }
    return global.moduleManager.getWebTools();
  });
  
  // Add web tool
  ipcMain.handle('module:add-web-tool', async (event, tool) => {
    try {
      if (!global.moduleManager) {
        return { success: false, error: 'Module manager not yet initialized' };
      }
      global.moduleManager.addWebTool(tool);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Open web tool
  ipcMain.handle('module:open-web-tool', async (event, toolId) => {
    try {
      if (!global.moduleManager) {
        return { success: false, error: 'Module manager not yet initialized' };
      }
      global.moduleManager.openWebTool(toolId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Delete web tool
  ipcMain.handle('module:delete-web-tool', async (event, toolId) => {
    try {
      if (!global.moduleManager) {
        return { success: false, error: 'Module manager not yet initialized' };
      }
      global.moduleManager.deleteWebTool(toolId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  console.log('[setupModuleManagerIPC] All handlers registered');
}

// Set up Aider Bridge IPC handlers
function setupAiderIPC() {
  console.log('[setupAiderIPC] Setting up Aider Bridge handlers');
  
  // Run prompt on a specific branch's Aider (with streaming)
  ipcMain.handle('aider:branch-prompt', async (event, branchId, prompt, channel) => {
    try {
      if (!branchAiderManager) {
        throw new Error('Branch manager not initialized');
      }
      
      let result;
      if (channel) {
        // Streaming mode
        result = await branchAiderManager.runBranchPrompt(branchId, prompt, (token) => {
          event.sender.send(channel, { type: 'token', token });
        });
        event.sender.send(channel, { type: 'done', result });
      } else {
        // Non-streaming mode
        result = await branchAiderManager.runBranchPrompt(branchId, prompt);
      }
      
      return result;
    } catch (error) {
      console.error('[BranchAider] Prompt failed:', error);
      if (channel) {
        event.sender.send(channel, { type: 'error', error: error.message });
      }
      return { success: false, error: error.message };
    }
  });
  
  // Cleanup a branch's Aider instance
  ipcMain.handle('aider:cleanup-branch', async (event, branchId) => {
    try {
      if (!branchAiderManager) {
        return { success: true, message: 'No branch manager' };
      }
      
      const result = await branchAiderManager.cleanupBranch(branchId);
      return result;
    } catch (error) {
      console.error('[BranchAider] Cleanup failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Cleanup all branch Aider instances
  ipcMain.handle('aider:cleanup-all-branches', async () => {
    try {
      if (branchAiderManager) {
        await branchAiderManager.cleanupAll();
      }
      return { success: true };
    } catch (error) {
      console.error('[BranchAider] Cleanup all failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Get branch log
  ipcMain.handle('aider:get-branch-log', async (event, branchId) => {
    try {
      if (!branchAiderManager) {
        return { success: false, error: 'Branch manager not initialized' };
      }
      const log = branchAiderManager.getBranchLog(branchId);
      return { success: true, log: log || '' };
    } catch (error) {
      console.error('[BranchAider] Get log failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Get orchestration log
  ipcMain.handle('aider:get-orchestration-log', async () => {
    try {
      if (!branchAiderManager) {
        return { success: false, error: 'Branch manager not initialized' };
      }
      const log = branchAiderManager.getOrchestrationLog();
      return { success: true, log: log || '' };
    } catch (error) {
      console.error('[BranchAider] Get orchestration log failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Get active branches
  ipcMain.handle('aider:get-active-branches', async () => {
    try {
      if (!branchAiderManager) {
        return { success: true, branches: [] };
      }
      const branches = branchAiderManager.getActiveBranches();
      return { success: true, branches };
    } catch (error) {
      console.error('[BranchAider] Get active branches failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Dialog handlers for Video Editor and other tools
  ipcMain.handle('dialog:open-file', async (event, options = {}) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: options.filters || [
        { name: 'All Files', extensions: ['*'] }
      ],
      title: options.title || 'Select File'
    });
    return result;
  });
  
  ipcMain.handle('dialog:save-file', async (event, options = {}) => {
    const result = await dialog.showSaveDialog({
      defaultPath: options.defaultPath,
      filters: options.filters || [
        { name: 'All Files', extensions: ['*'] }
      ],
      title: options.title || 'Save File'
    });
    return result;
  });
  
  // ==================== VIDEO PROJECT PERSISTENCE ====================
  // Save video project to file (alongside video file)
  ipcMain.handle('save-video-project', async (event, { videoPath, projectData }) => {
    try {
      if (!videoPath) {
        return { success: false, error: 'No video path provided' };
      }
      // Create project file path: video.mp4 -> video.onereach-project.json
      const projectPath = videoPath.replace(/\.[^.]+$/, '.onereach-project.json');
      await fs.promises.writeFile(projectPath, JSON.stringify(projectData, null, 2), 'utf-8');
      console.log('[VideoProject] Saved project to:', projectPath);
      return { success: true, path: projectPath };
    } catch (error) {
      console.error('[VideoProject] Save error:', error);
      return { success: false, error: error.message };
    }
  });

  // Load video project from file
  ipcMain.handle('load-video-project', async (event, { videoPath }) => {
    try {
      if (!videoPath) {
        return { success: false, error: 'No video path provided' };
      }
      // Create project file path: video.mp4 -> video.onereach-project.json
      const projectPath = videoPath.replace(/\.[^.]+$/, '.onereach-project.json');
      
      // Check if project file exists
      try {
        await fs.promises.access(projectPath);
      } catch {
        return { success: false, error: 'No project file found' };
      }
      
      const data = await fs.promises.readFile(projectPath, 'utf-8');
      const projectData = JSON.parse(data);
      console.log('[VideoProject] Loaded project from:', projectPath);
      return { success: true, data: projectData, path: projectPath };
    } catch (error) {
      console.error('[VideoProject] Load error:', error);
      return { success: false, error: error.message };
    }
  });

  // Delete video project file
  ipcMain.handle('delete-video-project', async (event, { videoPath }) => {
    try {
      if (!videoPath) {
        return { success: false, error: 'No video path provided' };
      }
      const projectPath = videoPath.replace(/\.[^.]+$/, '.onereach-project.json');
      await fs.promises.unlink(projectPath);
      console.log('[VideoProject] Deleted project:', projectPath);
      return { success: true };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { success: true }; // File didn't exist, that's fine
      }
      console.error('[VideoProject] Delete error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get API configuration for Aider UI
  ipcMain.handle('aider:get-api-config', async () => {
    const { getSettingsManager } = require('./settings-manager');
    const settings = getSettingsManager();
    
    const apiKey = settings.getLLMApiKey();
    const provider = settings.getLLMProvider();
    
    return {
      hasApiKey: !!apiKey,
      provider: provider || 'anthropic',
      // Don't expose the actual key, just whether it exists
    };
  });
  
  // Evaluate content using LLM (runs in main process with access to API key)
  ipcMain.handle('aider:evaluate', async (event, systemPrompt, userPrompt, modelName) => {
    console.log('[GSX Create] Evaluation request received, model:', modelName);
    try {
      const { getSettingsManager } = require('./settings-manager');
      const settings = getSettingsManager();
      
      const apiKey = settings.getLLMApiKey();
      
      if (!apiKey) {
        throw new Error('No API key configured. Please add your API key in Settings.');
      }
      
      // Determine provider from model name
      const isOpenAI = modelName && (modelName.startsWith('gpt-') || modelName.startsWith('o1') || modelName.startsWith('o3'));
      const isAnthropic = modelName && modelName.startsWith('claude');
      
      // Use the passed model, or fall back to settings - GSX Create only uses Claude 4.5 models
      const provider = isOpenAI ? 'openai' : (isAnthropic ? 'anthropic' : (settings.getLLMProvider() || 'anthropic'));
      const model = modelName || 'claude-opus-4-5-20251101';
      
      console.log('[GSX Create] Using provider:', provider, 'model:', model);
      
      let response;
      
      if (provider === 'openai') {
        // OpenAI API call
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            temperature: 0.7,
            max_tokens: 4000
          })
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
        }
        
        const data = await response.json();
        return { success: true, content: data.choices[0].message.content };
        
      } else {
        // ============================================================
        // ANTHROPIC API CALL - CLAUDE 4.5 MODELS ONLY
        // ============================================================
        // IMPORTANT: Only use Claude 4.5 models (Opus 4.5 or Sonnet 4.5)
        // NO FALLBACK to older models - if 4.5 not available, wait and retry
        // Allowed models:
        //   - claude-opus-4-5-20251101   (for complex analysis, coding)
        //   - claude-sonnet-4-5-20250929 (for general tasks)
        // DO NOT USE older models like claude-3-opus, claude-3-5-sonnet, etc.
        // Exception: Image/voice tasks may use specialized models
        // ============================================================
        
        console.log('[GSX Create] Making API request with Claude 4.5 model:', model);
        
        // Validate model is Claude 4.5
        // Correct model names (as of Dec 2025):
        //   - claude-sonnet-4-5-20250929  (Sonnet 4.5, released Sept 29, 2025)
        //   - claude-opus-4-5-20251101    (Opus 4.5, released Nov 1, 2025)
        if (!model.includes('4-5') && !model.includes('4.5')) {
          console.warn('[GSX Create] WARNING: Non-4.5 model requested:', model);
          console.warn('[GSX Create] Forcing to claude-opus-4-5-20251101');
          model = 'claude-opus-4-5-20251101';
        }
        
        const requestBody = {
          model: model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [
            { role: 'user', content: userPrompt }
          ]
        };
        
        // Retry logic with exponential backoff for Claude 4.5 models
        // If model not available, wait and retry (do NOT fallback to older models)
        const maxRetries = 10;
        const maxWaitSeconds = 30;
        let waitSeconds = 1;
        let lastError = null;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          console.log(`[GSX Create] Attempt ${attempt}/${maxRetries} with model: ${model}`);
          
          try {
            response = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
              },
              body: JSON.stringify(requestBody)
            });
            
            if (!response.ok) {
              const errorText = await response.text();
              console.error('[GSX Create] API error:', response.status, errorText);
              
              try {
                const errorJson = JSON.parse(errorText);
                lastError = errorJson.error?.message || errorText;
                
                // If model not found (404), wait and retry - DO NOT fallback
                if (response.status === 404 || errorJson.error?.type === 'not_found_error') {
                  if (attempt < maxRetries) {
                    console.log(`[GSX Create] Model ${model} not available yet, waiting ${waitSeconds}s before retry...`);
                    await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
                    waitSeconds = Math.min(waitSeconds * 2, maxWaitSeconds);
                    continue;
                  }
                }
              } catch (e) {
                lastError = errorText;
              }
              
              throw new Error(`Anthropic API error: ${response.status} - ${lastError}`);
            }
            
            // Success!
            const data = await response.json();
            
            let responseText = '';
            if (data.content) {
              for (const block of data.content) {
                if (block.type === 'text') {
                  responseText += block.text;
                }
              }
            }
            
            console.log('[GSX Create] Claude 4.5 API success, response length:', responseText.length);
            return { 
              success: true, 
              content: responseText || data.content?.[0]?.text,
              model: model,
              usage: data.usage
            };
            
          } catch (fetchError) {
            lastError = fetchError.message;
            
            // Network errors - retry
            if (attempt < maxRetries && (fetchError.message.includes('fetch') || fetchError.message.includes('network'))) {
              console.log(`[GSX Create] Network error, waiting ${waitSeconds}s before retry...`);
              await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
              waitSeconds = Math.min(waitSeconds * 2, maxWaitSeconds);
              continue;
            }
            
            throw fetchError;
          }
        }
        
        // All retries exhausted - no fallback, just fail
        throw new Error(`Claude 4.5 model ${model} not available after ${maxRetries} retries. Last error: ${lastError}`);
      }
      
    } catch (error) {
      console.error('[GSX Create] Evaluation error:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Get spaces with folder paths for GSX Create
  ipcMain.handle('aider:get-spaces', async () => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const spaces = storage.index.spaces || [];
      
      // Map spaces to include their folder paths and item counts
      const result = spaces.map(space => {
        // Calculate item count for this space from index items
        const itemCount = (storage.index.items || []).filter(item => item.spaceId === space.id).length;
        
        return {
          id: space.id,
          name: space.name,
          icon: space.icon,
          color: space.color,
          path: path.join(storage.spacesDir, space.id),
          itemCount: itemCount
        };
      });
      return result;
    } catch (error) {
      console.error('[GSX Create] Failed to get spaces:', error);
      return [];
    }
  });
  
  // Get space metadata (unified metadata file)
  ipcMain.handle('aider:get-space-metadata', async (event, spaceId) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const metadata = storage.getSpaceMetadata(spaceId);
      return { success: true, metadata };
    } catch (error) {
      console.error('[GSX Create] Failed to get space metadata:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Update space metadata
  ipcMain.handle('aider:update-space-metadata', async (event, spaceId, updates) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const metadata = storage.updateSpaceMetadata(spaceId, updates);
      return { success: true, metadata };
    } catch (error) {
      console.error('[GSX Create] Failed to update space metadata:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Set file metadata
  ipcMain.handle('aider:set-file-metadata', async (event, spaceId, filePath, fileMetadata) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const metadata = storage.setFileMetadata(spaceId, filePath, fileMetadata);
      return { success: true, metadata };
    } catch (error) {
      console.error('[GSX Create] Failed to set file metadata:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Get file metadata
  ipcMain.handle('aider:get-file-metadata', async (event, spaceId, filePath) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const fileMetadata = storage.getFileMetadata(spaceId, filePath);
      return { success: true, metadata: fileMetadata };
    } catch (error) {
      console.error('[GSX Create] Failed to get file metadata:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Set asset metadata (journey map, style guide, etc.)
  ipcMain.handle('aider:set-asset-metadata', async (event, spaceId, assetType, assetMetadata) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const metadata = storage.setAssetMetadata(spaceId, assetType, assetMetadata);
      return { success: true, metadata };
    } catch (error) {
      console.error('[GSX Create] Failed to set asset metadata:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Set approval status
  ipcMain.handle('aider:set-approval', async (event, spaceId, itemType, itemId, approved) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const metadata = storage.setApproval(spaceId, itemType, itemId, approved);
      return { success: true, metadata };
    } catch (error) {
      console.error('[GSX Create] Failed to set approval:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Add version to history
  ipcMain.handle('aider:add-version', async (event, spaceId, versionData) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const metadata = storage.addVersion(spaceId, versionData);
      return { success: true, metadata };
    } catch (error) {
      console.error('[GSX Create] Failed to add version:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Update project config
  ipcMain.handle('aider:update-project-config', async (event, spaceId, configUpdates) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const metadata = storage.updateProjectConfig(spaceId, configUpdates);
      return { success: true, metadata };
    } catch (error) {
      console.error('[GSX Create] Failed to update project config:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Migrate all spaces to unified metadata
  ipcMain.handle('aider:migrate-spaces', async () => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const migrated = storage.migrateAllSpaces();
      return { success: true, migrated };
    } catch (error) {
      console.error('[GSX Create] Failed to migrate spaces:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Search across all spaces (uses DuckDB)
  ipcMain.handle('aider:search-all-spaces', async (event, searchTerm) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const results = await storage.searchAllSpaces(searchTerm);
      return { success: true, results };
    } catch (error) {
      console.error('[GSX Create] Failed to search spaces:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Query spaces with custom conditions (uses DuckDB)
  ipcMain.handle('aider:query-spaces', async (event, whereClause) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const results = await storage.querySpaces(whereClause);
      return { success: true, results };
    } catch (error) {
      console.error('[GSX Create] Failed to query spaces:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Get all spaces with metadata
  ipcMain.handle('aider:get-all-spaces-with-metadata', async () => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const spaces = storage.getAllSpacesWithMetadata();
      return { success: true, spaces };
    } catch (error) {
      console.error('[GSX Create] Failed to get spaces with metadata:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Get space files from metadata
  ipcMain.handle('aider:get-space-files', async (event, spaceId) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const files = storage.getSpaceFiles(spaceId);
      return { success: true, files };
    } catch (error) {
      console.error('[GSX Create] Failed to get space files:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Get space directory path
  ipcMain.handle('aider:get-space-path', async (event, spaceId) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const spacePath = storage.getSpacePath(spaceId);
      return { success: true, path: spacePath };
    } catch (error) {
      console.error('[GSX Create] Failed to get space path:', error);
      return { success: false, error: error.message };
    }
  });
  
  // List files in a project directory (for GSX Create)
  ipcMain.handle('aider:list-project-files', async (event, dirPath) => {
    try {
      const fs = require('fs').promises;
      const files = await fs.readdir(dirPath, { withFileTypes: true });
      
      const projectFiles = [];
      for (const file of files) {
        // Skip hidden files and common non-code directories
        if (file.name.startsWith('.')) continue;
        if (['node_modules', '__pycache__', 'venv', '.git'].includes(file.name)) continue;
        
        const filePath = path.join(dirPath, file.name);
        const stat = await fs.stat(filePath);
        
        projectFiles.push({
          name: file.name,
          path: filePath,
          isDirectory: file.isDirectory(),
          size: stat.size,
          modified: stat.mtime.toISOString()
        });
      }
      
      // Sort: directories first, then by name
      projectFiles.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      
      return { success: true, files: projectFiles };
    } catch (error) {
      console.error('[GSX Create] Failed to list project files:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Read a file
  ipcMain.handle('aider:read-file', async (event, filePath) => {
    try {
      if (!filePath || typeof filePath !== 'string') {
        console.error('[GSX Create] Invalid file path:', filePath);
        return null;
      }
      const fs = require('fs');
      if (!fs.existsSync(filePath)) {
        console.error('[GSX Create] File does not exist:', filePath);
        return null;
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      return content;
    } catch (error) {
      console.error('[GSX Create] Failed to read file:', filePath, error.message || error);
      return null;
    }
  });
  
  // Write a file
  ipcMain.handle('aider:write-file', async (event, filePath, content) => {
    try {
      const fs = require('fs');
      const path = require('path');
      // Ensure directory exists
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, content, 'utf-8');
      console.log('[GSX Create] File written:', filePath);
      return { success: true };
    } catch (error) {
      console.error('[GSX Create] Failed to write file:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Delete a file from the project
  ipcMain.handle('aider:delete-file', async (event, filePath) => {
    try {
      const fs = require('fs');
      const path = require('path');
      
      // Security check - only allow deletion within spaces directory
      const spacesRoot = path.join(require('os').homedir(), 'Documents', 'OR-Spaces', 'spaces');
      const resolvedPath = path.resolve(filePath);
      
      if (!resolvedPath.startsWith(spacesRoot)) {
        console.error('[GSX Create] Security: Attempted to delete file outside spaces directory:', filePath);
        return { success: false, error: 'Can only delete files within the project space' };
      }
      
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'File does not exist' };
      }
      
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        // For directories, use recursive deletion
        fs.rmSync(filePath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(filePath);
      }
      
      console.log('[GSX Create] File deleted:', filePath);
      return { success: true };
    } catch (error) {
      console.error('[GSX Create] Failed to delete file:', error);
      return { success: false, error: error.message };
    }
  });
  
  // ========== Version Backup/Restore System ==========
  
  // Backup current version to backups folder
  ipcMain.handle('aider:backup-version', async (event, spacePath, version, metadata = {}) => {
    try {
      const fs = require('fs');
      const path = require('path');
      
      if (!spacePath || !version) {
        return { success: false, error: 'Space path and version required' };
      }
      
      const backupsDir = path.join(spacePath, 'backups');
      const versionDir = path.join(backupsDir, `v${version}`);
      
      // Create backups directory if needed
      if (!fs.existsSync(backupsDir)) {
        fs.mkdirSync(backupsDir, { recursive: true });
      }
      
      // If version backup exists, skip (don't overwrite)
      if (fs.existsSync(versionDir)) {
        console.log('[GSX Create] Version backup already exists:', versionDir);
        return { success: true, alreadyExists: true, path: versionDir };
      }
      
      fs.mkdirSync(versionDir, { recursive: true });
      
      // Get all files in space (excluding backups and branches folders)
      const files = fs.readdirSync(spacePath);
      const excludeDirs = ['backups', 'branches', 'node_modules', '.git'];
      const backedUpFiles = [];
      
      for (const file of files) {
        if (excludeDirs.includes(file)) continue;
        
        const srcPath = path.join(spacePath, file);
        const destPath = path.join(versionDir, file);
        const stat = fs.statSync(srcPath);
        
        if (stat.isDirectory()) {
          // Recursively copy directory
          copyDirSync(srcPath, destPath);
          backedUpFiles.push(file + '/');
        } else {
          fs.copyFileSync(srcPath, destPath);
          backedUpFiles.push(file);
        }
      }
      
      // Save version metadata
      const versionInfo = {
        version: version,
        timestamp: new Date().toISOString(),
        score: metadata.score || 0,
        objective: metadata.objective || '',
        approach: metadata.approach || '',
        model: metadata.model || '',
        files: backedUpFiles,
        ...metadata
      };
      
      fs.writeFileSync(
        path.join(versionDir, 'version-info.json'),
        JSON.stringify(versionInfo, null, 2)
      );
      
      console.log('[GSX Create] Version backup created:', versionDir, 'Files:', backedUpFiles.length);
      return { success: true, path: versionDir, files: backedUpFiles };
      
    } catch (error) {
      console.error('[GSX Create] Backup version failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Helper function to copy directory recursively
  function copyDirSync(src, dest) {
    const fs = require('fs');
    const path = require('path');
    
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      
      if (entry.isDirectory()) {
        copyDirSync(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
  
  // Restore version from backup
  ipcMain.handle('aider:restore-version', async (event, spacePath, version, createBackupFirst = true) => {
    try {
      const fs = require('fs');
      const path = require('path');
      
      if (!spacePath || !version) {
        return { success: false, error: 'Space path and version required' };
      }
      
      const backupsDir = path.join(spacePath, 'backups');
      const versionDir = path.join(backupsDir, `v${version}`);
      
      if (!fs.existsSync(versionDir)) {
        return { success: false, error: `Version v${version} backup not found` };
      }
      
      // Read version info
      const versionInfoPath = path.join(versionDir, 'version-info.json');
      let versionInfo = {};
      if (fs.existsSync(versionInfoPath)) {
        versionInfo = JSON.parse(fs.readFileSync(versionInfoPath, 'utf-8'));
      }
      
      // Get files from backup (excluding version-info.json)
      const backupFiles = fs.readdirSync(versionDir).filter(f => f !== 'version-info.json');
      const excludeDirs = ['backups', 'branches', 'node_modules', '.git'];
      
      // Restore files
      const restoredFiles = [];
      for (const file of backupFiles) {
        const srcPath = path.join(versionDir, file);
        const destPath = path.join(spacePath, file);
        const stat = fs.statSync(srcPath);
        
        if (stat.isDirectory()) {
          // Remove existing directory first
          if (fs.existsSync(destPath)) {
            fs.rmSync(destPath, { recursive: true, force: true });
          }
          copyDirSync(srcPath, destPath);
          restoredFiles.push(file + '/');
        } else {
          fs.copyFileSync(srcPath, destPath);
          restoredFiles.push(file);
        }
      }
      
      console.log('[GSX Create] Version restored:', version, 'Files:', restoredFiles.length);
      return { 
        success: true, 
        version: version,
        files: restoredFiles,
        versionInfo: versionInfo
      };
      
    } catch (error) {
      console.error('[GSX Create] Restore version failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // List available version backups
  ipcMain.handle('aider:list-backups', async (event, spacePath) => {
    try {
      const fs = require('fs');
      const path = require('path');
      
      if (!spacePath) {
        return { success: false, error: 'Space path required' };
      }
      
      const backupsDir = path.join(spacePath, 'backups');
      
      if (!fs.existsSync(backupsDir)) {
        return { success: true, backups: [] };
      }
      
      const versions = fs.readdirSync(backupsDir)
        .filter(d => d.startsWith('v') && fs.statSync(path.join(backupsDir, d)).isDirectory())
        .map(d => {
          const versionDir = path.join(backupsDir, d);
          const infoPath = path.join(versionDir, 'version-info.json');
          let info = { version: d.replace('v', '') };
          
          if (fs.existsSync(infoPath)) {
            try {
              info = { ...info, ...JSON.parse(fs.readFileSync(infoPath, 'utf-8')) };
            } catch (e) {
              console.error('[GSX Create] Error reading version info:', e);
            }
          }
          
          return info;
        })
        .sort((a, b) => Number(b.version) - Number(a.version));
      
      return { success: true, backups: versions };
      
    } catch (error) {
      console.error('[GSX Create] List backups failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // ========== Branch System for Parallel Versions ==========
  
  // Create a new branch from current state
  ipcMain.handle('aider:create-branch', async (event, spacePath, branchId, metadata = {}) => {
    try {
      const fs = require('fs');
      const path = require('path');
      
      if (!spacePath || !branchId) {
        return { success: false, error: 'Space path and branch ID required' };
      }
      
      const branchesDir = path.join(spacePath, 'branches');
      const branchDir = path.join(branchesDir, branchId);
      
      // Create branches directory if needed
      if (!fs.existsSync(branchesDir)) {
        fs.mkdirSync(branchesDir, { recursive: true });
      }
      
      // Create branch directory
      fs.mkdirSync(branchDir, { recursive: true });
      
      // Copy current files to branch
      const files = fs.readdirSync(spacePath);
      const excludeDirs = ['backups', 'branches', 'node_modules', '.git'];
      const branchFiles = [];
      
      for (const file of files) {
        if (excludeDirs.includes(file)) continue;
        
        const srcPath = path.join(spacePath, file);
        const destPath = path.join(branchDir, file);
        const stat = fs.statSync(srcPath);
        
        if (stat.isDirectory()) {
          copyDirSync(srcPath, destPath);
          branchFiles.push(file + '/');
        } else {
          fs.copyFileSync(srcPath, destPath);
          branchFiles.push(file);
        }
      }
      
      // Save branch metadata
      const branchInfo = {
        branchId: branchId,
        createdAt: new Date().toISOString(),
        status: 'pending',
        approach: metadata.approach || '',
        model: metadata.model || '',
        instructions: metadata.instructions || '',
        score: 0,
        cost: 0,
        files: branchFiles,
        ...metadata
      };
      
      fs.writeFileSync(
        path.join(branchDir, 'branch-info.json'),
        JSON.stringify(branchInfo, null, 2)
      );
      
      console.log('[GSX Create] Branch created:', branchId);
      return { success: true, branchId: branchId, path: branchDir, files: branchFiles };
      
    } catch (error) {
      console.error('[GSX Create] Create branch failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // List branches
  ipcMain.handle('aider:list-branches', async (event, spacePath) => {
    try {
      const fs = require('fs');
      const path = require('path');
      
      if (!spacePath) {
        return { success: false, error: 'Space path required' };
      }
      
      const branchesDir = path.join(spacePath, 'branches');
      
      if (!fs.existsSync(branchesDir)) {
        return { success: true, branches: [] };
      }
      
      const branches = fs.readdirSync(branchesDir)
        .filter(d => fs.statSync(path.join(branchesDir, d)).isDirectory())
        .map(d => {
          const branchDir = path.join(branchesDir, d);
          const infoPath = path.join(branchDir, 'branch-info.json');
          let info = { branchId: d };
          
          if (fs.existsSync(infoPath)) {
            try {
              info = { ...info, ...JSON.parse(fs.readFileSync(infoPath, 'utf-8')) };
            } catch (e) {
              console.error('[GSX Create] Error reading branch info:', e);
            }
          }
          
          return info;
        });
      
      return { success: true, branches: branches };
      
    } catch (error) {
      console.error('[GSX Create] List branches failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Update branch info
  ipcMain.handle('aider:update-branch', async (event, spacePath, branchId, updates) => {
    try {
      const fs = require('fs');
      const path = require('path');
      
      const branchDir = path.join(spacePath, 'branches', branchId);
      const infoPath = path.join(branchDir, 'branch-info.json');
      
      if (!fs.existsSync(branchDir)) {
        return { success: false, error: 'Branch not found' };
      }
      
      let info = { branchId: branchId };
      if (fs.existsSync(infoPath)) {
        info = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
      }
      
      info = { ...info, ...updates, updatedAt: new Date().toISOString() };
      fs.writeFileSync(infoPath, JSON.stringify(info, null, 2));
      
      return { success: true, branchInfo: info };
      
    } catch (error) {
      console.error('[GSX Create] Update branch failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Promote branch to main (copy branch files to space root)
  ipcMain.handle('aider:promote-branch', async (event, spacePath, branchId) => {
    try {
      const fs = require('fs');
      const path = require('path');
      
      const branchDir = path.join(spacePath, 'branches', branchId);
      
      if (!fs.existsSync(branchDir)) {
        return { success: false, error: 'Branch not found' };
      }
      
      // Get files from branch
      const branchFiles = fs.readdirSync(branchDir).filter(f => f !== 'branch-info.json');
      const excludeDirs = ['backups', 'branches', 'node_modules', '.git'];
      
      // Copy branch files to space root
      const promotedFiles = [];
      for (const file of branchFiles) {
        const srcPath = path.join(branchDir, file);
        const destPath = path.join(spacePath, file);
        const stat = fs.statSync(srcPath);
        
        if (stat.isDirectory()) {
          if (fs.existsSync(destPath)) {
            fs.rmSync(destPath, { recursive: true, force: true });
          }
          copyDirSync(srcPath, destPath);
          promotedFiles.push(file + '/');
        } else {
          fs.copyFileSync(srcPath, destPath);
          promotedFiles.push(file);
        }
      }
      
      console.log('[GSX Create] Branch promoted:', branchId, 'Files:', promotedFiles.length);
      return { success: true, branchId: branchId, files: promotedFiles };
      
    } catch (error) {
      console.error('[GSX Create] Promote branch failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Delete branch
  ipcMain.handle('aider:delete-branch', async (event, spacePath, branchId) => {
    try {
      const fs = require('fs');
      const path = require('path');
      
      const branchDir = path.join(spacePath, 'branches', branchId);
      
      if (!fs.existsSync(branchDir)) {
        return { success: true }; // Already deleted
      }
      
      fs.rmSync(branchDir, { recursive: true, force: true });
      console.log('[GSX Create] Branch deleted:', branchId);
      return { success: true };
      
    } catch (error) {
      console.error('[GSX Create] Delete branch failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // ========== Git Branch Operations for Tabbed UI ==========
  
  // Create a new git branch
  ipcMain.handle('aider:git-create-branch', async (event, repoPath, branchName, baseBranch = 'main') => {
    try {
      const { execSync } = require('child_process');
      
      if (!repoPath || !branchName) {
        return { success: false, error: 'Missing required parameters' };
      }
      
      // Create and switch to new branch
      execSync(`git checkout -b ${branchName} ${baseBranch}`, { 
        cwd: repoPath,
        encoding: 'utf-8'
      });
      
      console.log('[GSX Create] Git branch created:', branchName, 'from', baseBranch);
      return { success: true, branch: branchName };
      
    } catch (error) {
      console.error('[GSX Create] Git create branch failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Switch to a git branch
  ipcMain.handle('aider:git-switch-branch', async (event, repoPath, branchName) => {
    try {
      const { execSync } = require('child_process');
      
      if (!repoPath || !branchName) {
        return { success: false, error: 'Missing required parameters' };
      }
      
      execSync(`git checkout ${branchName}`, { 
        cwd: repoPath,
        encoding: 'utf-8'
      });
      
      console.log('[GSX Create] Switched to git branch:', branchName);
      return { success: true, branch: branchName };
      
    } catch (error) {
      console.error('[GSX Create] Git switch branch failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Delete a git branch
  ipcMain.handle('aider:git-delete-branch', async (event, repoPath, branchName) => {
    try {
      const { execSync } = require('child_process');
      
      if (!repoPath || !branchName) {
        return { success: false, error: 'Missing required parameters' };
      }
      
      // Switch to main first if on the branch being deleted
      const currentBranch = execSync('git branch --show-current', { 
        cwd: repoPath,
        encoding: 'utf-8'
      }).trim();
      
      if (currentBranch === branchName) {
        execSync('git checkout main', { cwd: repoPath, encoding: 'utf-8' });
      }
      
      // Delete the branch
      execSync(`git branch -D ${branchName}`, { 
        cwd: repoPath,
        encoding: 'utf-8'
      });
      
      console.log('[GSX Create] Git branch deleted:', branchName);
      return { success: true };
      
    } catch (error) {
      console.error('[GSX Create] Git delete branch failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Initialize git repository in a directory
  ipcMain.handle('aider:git-init', async (event, repoPath) => {
    const http = require('http');
    try {
      const { execSync } = require('child_process');
      const fs = require('fs');
      
      if (!repoPath || !fs.existsSync(repoPath)) {
        return { success: false, error: 'Invalid or missing repoPath' };
      }
      
      // Check if already a git repo
      const gitDir = path.join(repoPath, '.git');
      if (fs.existsSync(gitDir)) {
        return { success: true, alreadyInitialized: true };
      }
      
      // Initialize git repository
      execSync('git init', { cwd: repoPath, encoding: 'utf-8' });
      
      // Create initial commit with all existing files
      execSync('git add -A', { cwd: repoPath, encoding: 'utf-8' });
      try {
        execSync('git commit -m "Initial commit from GSX Create"', { cwd: repoPath, encoding: 'utf-8' });
      } catch (e) {
        // Ignore if nothing to commit
      }
      
      
      console.log('[GSX Create] Git repository initialized at:', repoPath);
      return { success: true, initialized: true };
      
    } catch (error) {
      console.error('[GSX Create] Git init failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // List git branches
  ipcMain.handle('aider:git-list-branches', async (event, repoPath) => {
    try {
      const { execSync } = require('child_process');
      const fs = require('fs');
      
      if (!repoPath) {
        return { success: false, error: 'Missing repoPath' };
      }
      
      // Check if the directory exists and is a git repo
      const gitDir = path.join(repoPath, '.git');
      const isGitRepo = fs.existsSync(gitDir);
      
      if (!isGitRepo) {
        return { success: false, error: 'Not a git repository', notGitRepo: true };
      }
      
      const output = execSync('git branch -a', { 
        cwd: repoPath,
        encoding: 'utf-8'
      });
      
      const branches = output.split('\n')
        .map(b => b.trim().replace('* ', ''))
        .filter(b => b && !b.startsWith('remotes/'));
      
      const currentBranch = execSync('git branch --show-current', { 
        cwd: repoPath,
        encoding: 'utf-8'
      }).trim();
      
      console.log('[GSX Create] Listed git branches:', branches.length);
      return { success: true, branches, currentBranch };
      
    } catch (error) {
      console.error('[GSX Create] Git list branches failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Get diff between branches
  ipcMain.handle('aider:git-diff-branches', async (event, repoPath, branchA, branchB) => {
    try {
      const { execSync } = require('child_process');
      
      if (!repoPath || !branchA || !branchB) {
        return { success: false, error: 'Missing required parameters' };
      }
      
      const diff = execSync(`git diff ${branchA}..${branchB}`, { 
        cwd: repoPath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large diffs
      });
      
      console.log('[GSX Create] Got diff between', branchA, 'and', branchB);
      return { success: true, diff };
      
    } catch (error) {
      console.error('[GSX Create] Git diff failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Open a file in default application
  ipcMain.handle('aider:open-file', async (event, filePath) => {
    try {
      const { shell } = require('electron');
      await shell.openPath(filePath);
      return { success: true };
    } catch (error) {
      console.error('[GSX Create] Failed to open file:', error);
      return { success: false, error: error.message };
    }
  });
  
  // ========== DuckDB Event/Transaction Handlers ==========
  
  ipcMain.handle('txdb:get-summary', async (event, spaceId) => {
    try {
      const { getEventDB } = require('./event-db');
      const eventDb = getEventDB(app.getPath('userData'));
      const summary = await eventDb.getCostSummary(spaceId);
      return { 
        success: true, 
        summary: summary || { totalCost: 0, totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 } 
      };
    } catch (error) {
      console.error('[EventDB] Failed to get summary:', error);
      return { success: false, error: error.message, summary: { totalCost: 0, totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 } };
    }
  });
  
  ipcMain.handle('txdb:record-transaction', async (event, data) => {
    try {
      const { getEventDB } = require('./event-db');
      const eventDb = getEventDB(app.getPath('userData'));
      await eventDb.logTransaction({
        spaceId: data.spaceId,
        spaceName: data.spaceName,
        type: data.type || 'api_call',
        model: data.model,
        inputTokens: data.inputTokens || data.input_tokens,
        outputTokens: data.outputTokens || data.output_tokens,
        cost: data.cost,
        status: data.status || 'success',
        promptPreview: data.promptPreview,
        responsePreview: data.responsePreview,
        errorMessage: data.errorMessage,
        durationMs: data.durationMs,
        metadata: data.metadata
      });
      return { success: true };
    } catch (error) {
      console.error('[EventDB] Failed to record transaction:', error);
      return { success: false, error: error.message };
    }
  });
  
  ipcMain.handle('txdb:get-transactions', async (event, spaceId, limit = 50) => {
    try {
      const { getEventDB } = require('./event-db');
      const eventDb = getEventDB(app.getPath('userData'));
      const transactions = await eventDb.getTransactions({ spaceId, limit });
      return { success: true, transactions };
    } catch (error) {
      console.error('[EventDB] Failed to get transactions:', error);
      return { success: false, error: error.message, transactions: [] };
    }
  });
  
  // Event logging
  ipcMain.handle('txdb:log-event', async (event, data) => {
    try {
      // Use new DuckDB-based EventDB
      const { getEventDB } = require('./event-db');
      const eventDb = getEventDB(app.getPath('userData'));
      
      await eventDb.logEvent({
        level: data.type || 'info',
        category: data.category || 'user-log',
        spaceId: data.spaceId || null,
        message: data.summary || data.message || 'No message',
        details: {
          aiSummary: data.aiSummary,
          userNotes: data.userNotes,
          context: data.context
        },
        source: data.source || 'app',
        userAction: data.userAction || null,
        filePath: data.filePath || null,
        errorStack: data.stack || null
      });
      
      console.log('[EventDB] Event logged:', data.type, (data.message || '').substring(0, 50));
      return { success: true };
    } catch (error) {
      console.error('[EventDB] Failed to log event:', error);
      return { success: false, error: error.message };
    }
  });
  
  ipcMain.handle('txdb:get-event-logs', async (event, options = {}) => {
    try {
      const { getEventDB } = require('./event-db');
      const eventDb = getEventDB(app.getPath('userData'));
      const rawLogs = await eventDb.getEventLogs(options);
      
      // Transform logs to match UI expectations
      const logs = rawLogs.map(log => ({
        id: log.id,
        type: log.level,
        summary: log.message,
        message: log.message,
        aiSummary: log.details?.aiSummary,
        userNotes: log.details?.userNotes,
        context: log.details?.context,
        stack: log.error_stack,
        timestamp: log.timestamp,
        category: log.category
      }));
      
      return { success: true, logs };
    } catch (error) {
      console.error('[EventDB] Failed to get event logs:', error);
      return { success: false, error: error.message, logs: [] };
    }
  });
  
  // DuckDB Analytics - Cost by model
  ipcMain.handle('eventdb:cost-by-model', async (event, spaceId) => {
    try {
      const { getEventDB } = require('./event-db');
      const spacesPath = path.join(require('os').homedir(), 'Documents', 'OR-Spaces', 'spaces');
      const eventDb = getEventDB(app.getPath('userData'), spacesPath);
      const data = await eventDb.getCostByModel(spaceId);
      return { success: true, data };
    } catch (error) {
      console.error('[EventDB] Failed to get cost by model:', error);
      return { success: false, error: error.message };
    }
  });
  
  // DuckDB Analytics - Daily costs
  ipcMain.handle('eventdb:daily-costs', async (event, spaceId, days = 30) => {
    try {
      const { getEventDB } = require('./event-db');
      const spacesPath = path.join(require('os').homedir(), 'Documents', 'OR-Spaces', 'spaces');
      const eventDb = getEventDB(app.getPath('userData'), spacesPath);
      const data = await eventDb.getDailyCosts(spaceId, days);
      return { success: true, data };
    } catch (error) {
      console.error('[EventDB] Failed to get daily costs:', error);
      return { success: false, error: error.message };
    }
  });
  
  // DuckDB - Query space metadata across all spaces
  ipcMain.handle('eventdb:query-spaces', async (event, whereClause) => {
    try {
      const { getEventDB } = require('./event-db');
      const spacesPath = path.join(require('os').homedir(), 'Documents', 'OR-Spaces', 'spaces');
      const eventDb = getEventDB(app.getPath('userData'), spacesPath);
      const data = await eventDb.querySpaceMetadata(whereClause);
      return { success: true, data };
    } catch (error) {
      console.error('[EventDB] Failed to query spaces:', error);
      return { success: false, error: error.message };
    }
  });
  
  // DuckDB - Search across spaces
  ipcMain.handle('eventdb:search-spaces', async (event, searchTerm) => {
    try {
      const { getEventDB } = require('./event-db');
      const spacesPath = path.join(require('os').homedir(), 'Documents', 'OR-Spaces', 'spaces');
      const eventDb = getEventDB(app.getPath('userData'), spacesPath);
      const data = await eventDb.searchAcrossSpaces(searchTerm);
      return { success: true, data };
    } catch (error) {
      console.error('[EventDB] Failed to search spaces:', error);
      return { success: false, error: error.message };
    }
  });
  
  // DuckDB - Raw query (for advanced use)
  ipcMain.handle('eventdb:query', async (event, sql) => {
    try {
      const { getEventDB } = require('./event-db');
      const eventDb = getEventDB(app.getPath('userData'));
      const data = await eventDb.query(sql);
      return { success: true, data };
    } catch (error) {
      console.error('[EventDB] Query failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Style Guides - placeholder handlers (store in memory for now)
  const styleGuides = new Map();
  const journeyMaps = new Map();
  
  ipcMain.handle('aider:get-style-guides', async (event, spaceId) => {
    try {
      const guides = styleGuides.get(spaceId) || [];
      return { success: true, styleGuides: guides };
    } catch (error) {
      console.error('[GSX Create] Failed to get style guides:', error);
      return { success: false, error: error.message, styleGuides: [] };
    }
  });
  
  ipcMain.handle('aider:save-style-guide', async (event, data) => {
    try {
      const spaceId = data.spaceId;
      const guides = styleGuides.get(spaceId) || [];
      const existingIndex = guides.findIndex(g => g.id === data.id);
      if (existingIndex >= 0) {
        guides[existingIndex] = data;
      } else {
        data.id = data.id || Date.now().toString();
        guides.push(data);
      }
      styleGuides.set(spaceId, guides);
      return { success: true, id: data.id };
    } catch (error) {
      console.error('[GSX Create] Failed to save style guide:', error);
      return { success: false, error: error.message };
    }
  });
  
  ipcMain.handle('aider:delete-style-guide', async (event, id) => {
    try {
      for (const [spaceId, guides] of styleGuides) {
        const index = guides.findIndex(g => g.id === id);
        if (index >= 0) {
          guides.splice(index, 1);
          styleGuides.set(spaceId, guides);
          break;
        }
      }
      return { success: true };
    } catch (error) {
      console.error('[GSX Create] Failed to delete style guide:', error);
      return { success: false, error: error.message };
    }
  });
  
  ipcMain.handle('aider:get-journey-maps', async (event, spaceId) => {
    try {
      const maps = journeyMaps.get(spaceId) || [];
      return { success: true, journeyMaps: maps };
    } catch (error) {
      console.error('[GSX Create] Failed to get journey maps:', error);
      return { success: false, error: error.message, journeyMaps: [] };
    }
  });
  
  ipcMain.handle('aider:save-journey-map', async (event, data) => {
    try {
      const spaceId = data.spaceId;
      const maps = journeyMaps.get(spaceId) || [];
      const existingIndex = maps.findIndex(m => m.id === data.id);
      if (existingIndex >= 0) {
        maps[existingIndex] = data;
      } else {
        data.id = data.id || Date.now().toString();
        maps.push(data);
      }
      journeyMaps.set(spaceId, maps);
      return { success: true, id: data.id };
    } catch (error) {
      console.error('[GSX Create] Failed to save journey map:', error);
      return { success: false, error: error.message };
    }
  });
  
  ipcMain.handle('aider:delete-journey-map', async (event, id) => {
    try {
      for (const [spaceId, maps] of journeyMaps) {
        const index = maps.findIndex(m => m.id === id);
        if (index >= 0) {
          maps.splice(index, 1);
          journeyMaps.set(spaceId, maps);
          break;
        }
      }
      return { success: true };
    } catch (error) {
      console.error('[GSX Create] Failed to delete journey map:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Register a file created by GSX Create as a clipboard item in the Space
  ipcMain.handle('aider:register-created-file', async (event, { spaceId, filePath, description, aiModel }) => {
    try {
      const fs = require('fs');
      
      // Read the file content
      const content = fs.readFileSync(filePath, 'utf-8');
      const fileName = path.basename(filePath);
      const ext = path.extname(fileName).toLowerCase();
      const stat = fs.statSync(filePath);
      
      // Determine file type based on extension
      const codeExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.css', '.scss', '.html', '.json', '.yaml', '.yml', '.sh', '.bash'];
      const isCode = codeExtensions.includes(ext);
      
      // Create clipboard item
      const item = {
        type: isCode ? 'code' : 'text',
        spaceId: spaceId,
        content: content,
        fileName: fileName,
        source: 'gsx-create',
        timestamp: Date.now(),
        preview: content.substring(0, 200),
        metadata: {
          filePath: filePath,
          description: description || `Created by GSX Create`,
          aiModel: aiModel || 'unknown',
          createdAt: new Date().toISOString(),
          lastModified: stat.mtime.toISOString(),
          fileSize: stat.size,
          language: ext.replace('.', '') || 'text'
        },
        tags: ['ai-generated', 'gsx-create']
      };
      
      // Use global clipboard manager to ensure both storage and in-memory history are updated
      if (global.clipboardManager) {
        global.clipboardManager.addToHistory(item);
        console.log(`[GSX Create] Registered file via clipboard manager: ${fileName} in space ${spaceId}`);
      } else {
        // Fallback to direct storage if clipboard manager not available
        const ClipboardStorage = require('./clipboard-storage-v2');
        const storage = new ClipboardStorage();
        storage.addItem(item);
        console.log(`[GSX Create] Registered file via direct storage: ${fileName} in space ${spaceId}`);
      }
      
      return { success: true, fileName, spaceId };
    } catch (error) {
      console.error('[GSX Create] Failed to register file:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Update an existing file's metadata in the Space after edits
  ipcMain.handle('aider:update-file-metadata', async (event, { spaceId, filePath, description }) => {
    try {
      const fs = require('fs');
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      
      const fileName = path.basename(filePath);
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      
      // Find existing item by filePath in metadata
      let existingItem = null;
      for (const item of storage.index.items) {
        try {
          const metadataPath = path.join(storage.itemsDir, item.id, 'metadata.json');
          if (fs.existsSync(metadataPath)) {
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
            if (metadata.filePath === filePath) {
              existingItem = item;
              break;
            }
          }
        } catch (e) {
          // Skip items with invalid metadata
        }
      }
      
      if (existingItem) {
        // Update the existing item's content and metadata
        const itemDir = path.join(storage.itemsDir, existingItem.id);
        const metadataPath = path.join(itemDir, 'metadata.json');
        
        if (fs.existsSync(metadataPath)) {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
          metadata.lastModified = stat.mtime.toISOString();
          metadata.description = description || metadata.description;
          metadata.editCount = (metadata.editCount || 0) + 1;
          fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        }
        
        // Update content file
        const contentFiles = fs.readdirSync(itemDir).filter(f => f.startsWith('content.'));
        if (contentFiles.length > 0) {
          fs.writeFileSync(path.join(itemDir, contentFiles[0]), content);
        }
        
        // Update preview in index
        existingItem.preview = content.substring(0, 100);
        existingItem.timestamp = Date.now();
        storage.saveIndex();
        
        // Also update in-memory history if clipboard manager is available
        if (global.clipboardManager) {
          const historyItem = global.clipboardManager.history.find(h => h.id === existingItem.id);
          if (historyItem) {
            historyItem.preview = existingItem.preview;
            historyItem.timestamp = existingItem.timestamp;
            historyItem.content = content;
          }
        }
        
        console.log(`[GSX Create] Updated file metadata: ${fileName}`);
        return { success: true, updated: true, fileName };
      } else {
        // File not in clipboard yet, register it as new
        const ext = path.extname(fileName).toLowerCase();
        const codeExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.css', '.scss', '.html', '.json', '.yaml', '.yml', '.sh', '.bash'];
        const isCode = codeExtensions.includes(ext);
        
        const item = {
          type: isCode ? 'code' : 'text',
          spaceId: spaceId,
          content: content,
          fileName: fileName,
          source: 'gsx-create',
          timestamp: Date.now(),
          preview: content.substring(0, 200),
          metadata: {
            filePath: filePath,
            description: description || `Created by GSX Create`,
            createdAt: new Date().toISOString(),
            lastModified: stat.mtime.toISOString(),
            fileSize: stat.size,
            language: ext.replace('.', '') || 'text'
          },
          tags: ['ai-generated', 'gsx-create']
        };
        
        // Use global clipboard manager to ensure both storage and in-memory history are updated
        if (global.clipboardManager) {
          global.clipboardManager.addToHistory(item);
        } else {
          storage.addItem(item);
        }
        console.log(`[GSX Create] Registered new file as clipboard item: ${fileName}`);
        return { success: true, updated: false, fileName };
      }
    } catch (error) {
      console.error('[GSX Create] Failed to update file metadata:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Get space items
  ipcMain.handle('aider:get-space-items', async (event, spaceId) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const items = storage.getSpaceItems(spaceId);
      return { success: true, items };
    } catch (error) {
      console.error('[GSX Create] Failed to get space items:', error);
      return { success: false, error: error.message, items: [] };
    }
  });

  // Watch file for changes
  const fileWatchers = new Map();
  ipcMain.handle('aider:watch-file', async (event, filePath) => {
    try {
      if (fileWatchers.has(filePath)) {
        return { success: true, message: 'Already watching' };
      }
      const watcher = fs.watch(filePath, (eventType) => {
        if (eventType === 'change') {
          try {
            if (event.sender && !event.sender.isDestroyed()) {
              event.sender.send('aider:file-changed', filePath);
            }
          } catch (e) {
            // Window closed, stop watching
            watcher.close();
            fileWatchers.delete(filePath);
          }
        }
      });
      fileWatchers.set(filePath, watcher);
      console.log('[Aider] Watching file:', filePath);
      return { success: true };
    } catch (error) {
      console.error('[Aider] Watch file error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('aider:unwatch-file', async (event, filePath) => {
    try {
      const watcher = fileWatchers.get(filePath);
      if (watcher) {
        watcher.close();
        fileWatchers.delete(filePath);
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Capture preview screenshot using Playwright
  ipcMain.handle('aider:capture-preview-screenshot', async (event, filePath) => {
    try {
      console.log('[Screenshot] Capturing screenshot for:', filePath);
      const { chromium } = require('playwright');
      
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 }
      });
      const page = await context.newPage();
      
      // Navigate to the file
      const fileUrl = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
      console.log('[Screenshot] Navigating to:', fileUrl);
      await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: 30000 });
      
      // Capture full page screenshot
      const buffer = await page.screenshot({ fullPage: true });
      
      await browser.close();
      
      console.log('[Screenshot] Capture successful, size:', buffer.length);
      return { 
        success: true, 
        screenshot: buffer.toString('base64'),
        size: buffer.length
      };
    } catch (error) {
      console.error('[Screenshot] Capture error:', error);
      return { success: false, error: error.message };
    }
  });

  // Analyze screenshot with AI (supports both image analysis and text-only prompts)
  ipcMain.handle('aider:analyze-screenshot', async (event, screenshotBase64, prompt) => {
    try {
      console.log('[Analyze] Analyzing with AI...');
      
      const settingsManager = require('./settings-manager').getSettingsManager();
      const settings = settingsManager.settings;
      
      if (!settings.llmApiKey) {
        return { success: false, error: 'No API key configured' };
      }
      
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: settings.llmApiKey });
      
      let messageContent;
      
      // Check if we have valid screenshot data
      if (screenshotBase64 && typeof screenshotBase64 === 'string' && screenshotBase64.length > 100) {
        // Remove data URL prefix if present
        let base64Data = screenshotBase64;
        if (base64Data.startsWith('data:')) {
          base64Data = base64Data.split(',')[1] || base64Data;
        }
        
        console.log('[Analyze] With image, data length:', base64Data.length);
        
        // Image + text analysis
        messageContent = [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: base64Data
            }
          },
          {
            type: 'text',
            text: prompt || 'Analyze this screenshot and describe what you see. Identify any UI issues, bugs, or improvements that could be made.'
          }
        ];
      } else {
        // Text-only analysis (no image)
        console.log('[Analyze] Text-only analysis (no image)');
        
        if (!prompt) {
          return { success: false, error: 'No prompt provided for text-only analysis' };
        }
        
        messageContent = [
          {
            type: 'text',
            text: prompt
          }
        ];
      }
      
      const response = await client.messages.create({
        model: settings.llmModel || 'claude-opus-4-5-20251101',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: messageContent
        }]
      });
      
      const analysis = response.content[0]?.text || 'No analysis available';
      console.log('[Analyze] Analysis complete');
      
      return { 
        success: true, 
        analysis,
        model: settings.llmModel || 'claude-opus-4-5-20251101',
        usage: response.usage
      };
    } catch (error) {
      const errorMessage = error.message || error.toString() || 'Unknown error';
      console.error('[Analyze] Error:', errorMessage, error.stack || '');
      return { success: false, error: errorMessage };
    }
  });

  console.log('[setupAiderIPC] Aider Bridge IPC handlers registered');
}

// Set up IPC handlers for communication with renderer process
function setupIPC() {
  console.log('[setupIPC] Function called');
  
  // Initialize Aider Bridge handlers
  setupAiderIPC();
  
  // Initialize GSX File Sync handlers
  try {
    const gsxFileSync = getGSXFileSync();
    gsxFileSync.setupIPC();
    console.log('[setupIPC] GSX File Sync IPC handlers registered');
  } catch (error) {
    console.error('[setupIPC] Failed to setup GSX File Sync:', error);
  }
  
  // Initialize Video Editor handlers
  try {
    if (global.videoEditor) {
      const mainWindow = BrowserWindow.getAllWindows()[0];
      global.videoEditor.setupIPC(mainWindow);
      console.log('[setupIPC] Video Editor IPC handlers registered');
    }
  } catch (error) {
    console.error('[setupIPC] Failed to setup Video Editor:', error);
  }
  
  // Initialize Project Manager handlers
  try {
    const { setupProjectManagerIPC } = require('./src/project-manager/ProjectManagerIPC');
    setupProjectManagerIPC();
    console.log('[setupIPC] Project Manager IPC handlers registered');
  } catch (error) {
    console.error('[setupIPC] Failed to setup Project Manager:', error);
  }
  
  // Web search for error diagnosis - provides up-to-date info on AI models, software versions, etc.
  ipcMain.handle('aider:web-search', async (event, query, options = {}) => {
    try {
      console.log('[WebSearch] Searching for:', query);
      const maxResults = options.maxResults || 5;
      
      // Use DuckDuckGo HTML search (no API key required)
      // This fetches the lite version which is easier to parse
      const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
      
      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        }
      });
      
      if (!response.ok) {
        throw new Error(`Search failed: ${response.status}`);
      }
      
      const html = await response.text();
      
      // Parse results from DuckDuckGo lite HTML
      const results = [];
      
      // Extract result snippets and links using regex
      // DuckDuckGo lite uses simple table structure
      const linkRegex = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
      const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([^<]+)<\/td>/gi;
      
      // Simpler parsing for lite.duckduckgo.com
      const resultBlocks = html.split(/<tr[^>]*class="result-link"/i);
      
      for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
        const block = resultBlocks[i];
        
        // Extract URL
        const urlMatch = block.match(/href="([^"]+)"/i);
        const titleMatch = block.match(/>([^<]+)<\/a>/i);
        
        // Find the next snippet
        const snippetMatch = block.match(/class="result-snippet"[^>]*>([^<]*)</i);
        
        if (urlMatch && titleMatch) {
          results.push({
            title: titleMatch[1].trim(),
            url: urlMatch[1],
            snippet: snippetMatch ? snippetMatch[1].trim() : ''
          });
        }
      }
      
      // If regex parsing didn't work well, try a simpler approach
      if (results.length === 0) {
        // Alternative: look for any href patterns that look like search results
        const allLinks = html.match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi) || [];
        
        for (const link of allLinks.slice(0, maxResults)) {
          const urlMatch = link.match(/href="(https?:\/\/[^"]+)"/i);
          const textMatch = link.match(/>([^<]+)<\/a>/i);
          
          if (urlMatch && textMatch) {
            const url = urlMatch[1];
            // Filter out DuckDuckGo internal links
            if (!url.includes('duckduckgo.com') && !url.includes('duck.co')) {
              results.push({
                title: textMatch[1].trim(),
                url: url,
                snippet: ''
              });
            }
          }
        }
      }
      
      console.log('[WebSearch] Found', results.length, 'results');
      
      return {
        success: true,
        query: query,
        results: results,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('[WebSearch] Error:', error.message);
      return {
        success: false,
        error: error.message,
        query: query,
        results: []
      };
    }
  });
  
  // Settings IPC handlers
  console.log('[setupIPC] Setting up settings handlers');
  
  // Mission Control trigger for GSX toolbar
  ipcMain.on('trigger-mission-control', () => {
    const { exec } = require('child_process');
    exec('open -a "Mission Control"');
    console.log('[IPC] Mission Control triggered from GSX toolbar');
  });
  
  // Clear cache and reload for GSX toolbar refresh button
  // If options.clearStorage is true, also clear site storage for the current page before reloading.
  ipcMain.on('clear-cache-and-reload', async (event, options = {}) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) {
        const clearStorage = !!options.clearStorage;
        if (clearStorage) {
          // Best-effort clear of per-page web storage before reload.
          // Note: we intentionally do NOT clear cookies by default, to avoid forced logouts.
          try {
            await win.webContents.executeJavaScript(
              "try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}",
              true
            );
          } catch (e) {
            // ignore - may fail on some origins / CSP
          }
          try {
            await win.webContents.session.clearStorageData({
              storages: ['localstorage', 'indexdb', 'cachestorage', 'serviceworkers']
            });
            console.log('[IPC] Storage cleared for window (localstorage/indexdb/cachestorage/serviceworkers)');
          } catch (e) {
            console.error('[IPC] Error clearing storage data:', e);
          }
        }

        // Clear the cache for this session
        await win.webContents.session.clearCache();
        console.log('[IPC] Cache cleared for window');
        // Reload ignoring cache
        win.webContents.reloadIgnoringCache();
        console.log('[IPC] Page reloaded ignoring cache');
      }
    } catch (error) {
      console.error('[IPC] Error clearing cache and reloading:', error);
    }
  });

  ipcMain.handle('settings:get-all', async () => {
    const settingsManager = global.settingsManager;
    if (!settingsManager) {
      console.error('Settings manager not initialized');
      return {};
    }
    const allSettings = settingsManager.getAll();
    return allSettings;
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
  
  // ==================== VIDEO RELEASE - YOUTUBE/VIMEO AUTH ====================
  
  ipcMain.handle('release:authenticate-youtube', async () => {
    try {
      const { YouTubeUploader } = await import('./src/video/release/YouTubeUploader.js');
      const uploader = new YouTubeUploader();
      
      // Get credentials from settings
      const settingsManager = global.settingsManager;
      if (settingsManager) {
        const clientId = settingsManager.get('youtubeClientId');
        const clientSecret = settingsManager.get('youtubeClientSecret');
        if (clientId && clientSecret) {
          uploader.setClientCredentials(clientId, clientSecret);
        }
      }
      
      return await uploader.authenticate();
    } catch (error) {
      console.error('[Release] YouTube authentication error:', error);
      return { success: false, error: error.message };
    }
  });
  
  ipcMain.handle('release:authenticate-vimeo', async () => {
    try {
      const { VimeoUploader } = await import('./src/video/release/VimeoUploader.js');
      const uploader = new VimeoUploader();
      
      // Get credentials from settings
      const settingsManager = global.settingsManager;
      if (settingsManager) {
        const clientId = settingsManager.get('vimeoClientId');
        const clientSecret = settingsManager.get('vimeoClientSecret');
        if (clientId && clientSecret) {
          uploader.setClientCredentials(clientId, clientSecret);
        }
      }
      
      return await uploader.authenticate();
    } catch (error) {
      console.error('[Release] Vimeo authentication error:', error);
      return { success: false, error: error.message };
    }
  });
  
  ipcMain.handle('release:get-youtube-status', async () => {
    try {
      const { YouTubeUploader } = await import('./src/video/release/YouTubeUploader.js');
      const uploader = new YouTubeUploader();
      
      // Get credentials from settings
      const settingsManager = global.settingsManager;
      if (settingsManager) {
        const clientId = settingsManager.get('youtubeClientId');
        const clientSecret = settingsManager.get('youtubeClientSecret');
        if (clientId && clientSecret) {
          uploader.setClientCredentials(clientId, clientSecret);
        }
      }
      
      return await uploader.getConnectionStatus();
    } catch (error) {
      console.error('[Release] Get YouTube status error:', error);
      return { configured: false, authenticated: false, error: error.message };
    }
  });
  
  ipcMain.handle('release:get-vimeo-status', async () => {
    try {
      const { VimeoUploader } = await import('./src/video/release/VimeoUploader.js');
      const uploader = new VimeoUploader();
      
      // Get credentials from settings
      const settingsManager = global.settingsManager;
      if (settingsManager) {
        const clientId = settingsManager.get('vimeoClientId');
        const clientSecret = settingsManager.get('vimeoClientSecret');
        if (clientId && clientSecret) {
          uploader.setClientCredentials(clientId, clientSecret);
        }
      }
      
      return await uploader.getConnectionStatus();
    } catch (error) {
      console.error('[Release] Get Vimeo status error:', error);
      return { configured: false, authenticated: false, error: error.message };
    }
  });
  
  // ==================== END VIDEO RELEASE AUTH ====================
  
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
  
  // ============================================
  // GSX CREATE - Cost Tracking Handlers
  // ============================================
  
  // Note: Style guides, journey maps, txdb, and file handlers are registered in setupAiderIPC
  
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

  // NOTE: Space management handlers (clipboard:get-spaces, clipboard:create-space, 
  // clipboard:update-space, clipboard:delete-space, clipboard:set-current-space, 
  // clipboard:move-to-space) are registered in clipboard-manager-v2-adapter.js
  // Using the singleton ClipboardManagerV2 instance ensures consistent in-memory state
  // and prevents issues with multiple ClipboardStorage instances causing stale data
  // Also includes: clipboard:get-space-items

  // Get audio items from a space
  ipcMain.handle('clipboard:get-space-audio', async (event, spaceId) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const items = storage.getSpaceItems(spaceId) || [];
      return items.filter(item => 
        item.fileType === 'audio' || 
        /\.(mp3|wav|m4a|aac|ogg|flac|wma|aiff)$/i.test(item.content || '')
      );
    } catch (error) {
      console.error('[Clipboard] Error getting space audio:', error);
      return [];
    }
  });

  // Get video items from a space
  ipcMain.handle('clipboard:get-space-videos', async (event, spaceId) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const items = storage.getSpaceItems(spaceId) || [];
      return items.filter(item => 
        item.fileType === 'video' || 
        /\.(mp4|mov|avi|mkv|webm|m4v|wmv|flv)$/i.test(item.content || '')
      );
    } catch (error) {
      console.error('[Clipboard] Error getting space videos:', error);
      return [];
    }
  });

  // Get file path for a clipboard item
  ipcMain.handle('clipboard:get-item-path', async (event, itemId) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const item = storage.loadItem(itemId);
      if (item && item.content) {
        // Check if it's an absolute path or needs to be resolved
        if (path.isAbsolute(item.content)) {
          return item.content;
        }
        // Resolve relative to storage root
        return path.join(storage.storageRoot, item.content);
      }
      return null;
    } catch (error) {
      console.error('[Clipboard] Error getting item path:', error);
      return null;
    }
  });

  // Get video path for a clipboard item (alias for get-item-path)
  // Returns { success: boolean, filePath?: string, fileName?: string, scenes?: array, error?: string }
  ipcMain.handle('clipboard:get-video-path', async (event, itemId) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const item = storage.loadItem(itemId);
      
      if (item && item.content) {
        let filePath;
        if (path.isAbsolute(item.content)) {
          filePath = item.content;
        } else {
          filePath = path.join(storage.storageRoot, item.content);
        }
        
        // Check if file exists
        const fs = require('fs');
        if (!fs.existsSync(filePath)) {
          console.error('[Clipboard] Video file not found:', filePath);
          return { success: false, error: 'Video file not found: ' + filePath };
        }
        
        // Load scenes from metadata if available
        let scenes = [];
        try {
          const metadataPath = path.join(storage.itemsDir, itemId, 'metadata.json');
          if (fs.existsSync(metadataPath)) {
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            scenes = metadata.scenes || [];
          }
        } catch (e) {
          // Ignore metadata errors
        }
        
        return { 
          success: true, 
          filePath: filePath,
          fileName: item.fileName || path.basename(filePath),
          scenes: scenes
        };
      }
      
      return { success: false, error: 'Video item not found or has no content' };
    } catch (error) {
      console.error('[Clipboard] Error getting video path:', error);
      return { success: false, error: error.message };
    }
  });

  // Get metadata for a clipboard item (fallback handler for video editor)
  ipcMain.handle('clipboard:get-metadata', async (event, itemId) => {
    console.log('[Clipboard] clipboard:get-metadata called with itemId:', itemId);
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      const item = storage.loadItem(itemId);
      if (!item) return { success: false, error: 'Item not found' };
      
      // Build complete metadata object with all properties
      const metadata = {
        ...(item.metadata || {}),
        description: item.metadata?.description || '',
        notes: item.metadata?.notes || '',
        instructions: item.metadata?.instructions || '',
        tags: item.metadata?.tags || [],
        source: item.metadata?.source || item.source || '',
        ai_generated: item.metadata?.ai_generated || false,
        ai_assisted: item.metadata?.ai_assisted || false,
        ai_model: item.metadata?.ai_model || '',
        ai_provider: item.metadata?.ai_provider || '',
        scenes: item.metadata?.scenes || [],
        transcription: item.metadata?.transcription || null,
        videoEditorProjectState: item.metadata?.videoEditorProjectState || null
      };
      
      return { success: true, metadata };
    } catch (error) {
      console.error('[Clipboard] Error getting metadata:', error);
      return { success: false, error: error.message };
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

  // PERFORMANCE: Handle batched logs from renderer processes
  ipcMain.on('logger:batch', (event, logEntries) => {
    if (!Array.isArray(logEntries)) return;
    
    for (const entry of logEntries) {
      const { level, message, data } = entry;
      switch (level) {
        case 'info':
          logger.info(message, { ...data, source: 'renderer' });
          break;
        case 'warn':
          logger.warn(message, { ...data, source: 'renderer' });
          break;
        case 'error':
          logger.error(message, { ...data, source: 'renderer' });
          break;
        case 'debug':
          logger.debug(message, { ...data, source: 'renderer' });
          break;
        default:
          logger.info(message, { ...data, source: 'renderer' });
      }
    }
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
        const configPath = getIdwConfigPath();
        if (fs.existsSync(configPath)) {
          const data = fs.readFileSync(configPath, 'utf8');
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
  
  // Handle opening recorder window
  ipcMain.on('open-recorder', (event, options = {}) => {
    console.log('Received request to open recorder');
    if (global.recorder) {
      global.recorder.open(options);
    }
  });

  ipcMain.handle('recorder:open', async (event, options = {}) => {
    console.log('Opening recorder with options:', options);
    if (global.recorder) {
      global.recorder.open(options);
      return { success: true };
    }
    return { success: false, error: 'Recorder not initialized' };
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
        global.clipboardManager.registerShortcut();
        console.log('Clipboard manager initialized successfully');
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
  ipcMain.on('open-black-hole-widget', (event, data) => {
    // data can include { x, y, startExpanded }
    const position = { x: data.x, y: data.y };
    const startExpanded = data.startExpanded || false;
    console.log('Received request to open black hole widget at position:', position, 'startExpanded:', startExpanded);
    if (global.clipboardManager) {
      console.log('Clipboard manager exists, creating black hole window, startExpanded:', startExpanded);
      global.clipboardManager.createBlackHoleWindow(position, startExpanded);
    } else {
      console.error('Clipboard manager not initialized yet');
      // Try to initialize it if app is ready
      if (app.isReady()) {
        const ClipboardManager = require('./clipboard-manager-v2-adapter');
        global.clipboardManager = new ClipboardManager();
        global.clipboardManager.registerShortcut();
        console.log('Clipboard manager initialized on demand');
        global.clipboardManager.createBlackHoleWindow(position, startExpanded);
      } else {
        console.error('App not ready, cannot initialize clipboard manager');
      }
    }
  });

  // Get clipboard data for paste operations
  ipcMain.handle('get-clipboard-data', () => {
    const { clipboard } = require('electron');
    const text = clipboard.readText();
    const html = clipboard.readHTML();
    const image = clipboard.readImage();

    // Check if HTML is really meaningful (STRICTER detection)
    let isRealHtml = false;
    if (html && text) {
      // Only consider it real HTML if:
      // 1. Has meaningful structure (multiple block elements or semantic content)
      // 2. Not just simple wrapping (like <span> or single <div>)
      // 3. HTML is significantly different from plain text
      
      const hasBlocks = /<(div|p|br|table|ul|ol|li|h[1-6])\b/i.test(html);
      const hasLinks = /<a\s+[^>]*href\s*=/i.test(html);
      const hasImages = /<img\s+[^>]*src\s*=/i.test(html);
      const hasFormatting = /<(strong|em|b|i|u)\b/i.test(html);
      const hasStructure = /<(section|article|header|footer|nav|aside)\b/i.test(html);
      
      // Count total HTML tags
      const tagCount = (html.match(/<[a-z]+[\s>]/gi) || []).length;
      
      // Check if HTML is just wrapping plain text (common for password managers, etc.)
      const strippedHtml = html.replace(/<[^>]*>/g, '').trim();
      const textSimilarity = strippedHtml === text.trim();
      
      // Only treat as HTML if it has meaningful structure AND is not just wrapped text
      isRealHtml = (hasLinks || hasImages || hasStructure || 
                   (hasBlocks && tagCount > 3) || 
                   (hasFormatting && tagCount > 2)) &&
                   !textSimilarity;
      
      // Additional check: If text is short and matches HTML content exactly, it's just text
      if (text.length < 100 && textSimilarity) {
        isRealHtml = false;
      }
    }

    const clipboardData = {
      hasText: !!text,
      hasHtml: isRealHtml,
      hasImage: !image.isEmpty(),
      text: text,
      html: isRealHtml ? html : null
    };

    if (!image.isEmpty()) {
      clipboardData.imageDataUrl = image.toDataURL();
    }

    console.log('get-clipboard-data:', { hasText: !!text, hasHtml: isRealHtml, hasImage: !image.isEmpty() });
    return clipboardData;
  });

  // Get file paths from clipboard
  ipcMain.handle('get-clipboard-files', () => {
    const { clipboard } = require('electron');
    const fs = require('fs');
    
    // Try to read file paths from clipboard
    // Note: Different platforms store file paths differently
    let filePaths = [];
    
    try {
      // macOS: Files are stored in clipboard as file:// URLs or paths
      const text = clipboard.readText();
      const buffer = clipboard.readBuffer('public.file-url');
      
      // Try buffer first (macOS file paths)
      if (buffer && buffer.length > 0) {
        const fileUrl = buffer.toString('utf8');
        const cleanPath = fileUrl.replace('file://', '').replace(/\0/g, '');
        if (fs.existsSync(cleanPath)) {
          filePaths.push(cleanPath);
        }
      }
      
      // Try reading as NSFilenamesPboardType (macOS)
      try {
        const nsFiles = clipboard.read('NSFilenamesPboardType');
        if (nsFiles) {
          const paths = nsFiles.split('\n').filter(p => p && fs.existsSync(p));
          filePaths.push(...paths);
        }
      } catch (e) {
        // Not available on this platform
      }
      
      // Check if text looks like file paths
      if (text && !filePaths.length) {
        const lines = text.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          // Check if it's a valid file path
          if (trimmed && !trimmed.startsWith('http') && fs.existsSync(trimmed)) {
            filePaths.push(trimmed);
          }
        }
      }
      
      console.log('[get-clipboard-files] Found', filePaths.length, 'file(s)');
      
      return {
        success: true,
        files: filePaths,
        count: filePaths.length
      };
      
    } catch (error) {
      console.error('[get-clipboard-files] Error:', error);
      return {
        success: false,
        files: [],
        count: 0,
        error: error.message
      };
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
  // Debug logging from Black Hole renderer
  ipcMain.on('black-hole:debug', (event, data) => {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  BLACK HOLE DEBUG FROM RENDERER                              ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('[BlackHole-Debug]', JSON.stringify(data, null, 2));
  });
  
  // Allow renderer to request pending clipboard data
  ipcMain.handle('black-hole:get-pending-data', async () => {
    console.log('[BlackHole] Renderer requesting pending data');
    
    // Read current clipboard
    const { clipboard, nativeImage } = require('electron');
    const text = clipboard.readText();
    const html = clipboard.readHTML();
    const image = clipboard.readImage();
    
    let isRealHtml = false;
    if (html && text) {
      const hasBlocks = /<(div|p|br|table|ul|ol|li|h[1-6])\b/i.test(html);
      const hasLinks = /<a\s+[^>]*href\s*=/i.test(html);
      const hasImages = /<img\s+[^>]*src\s*=/i.test(html);
      const hasFormatting = /<(strong|em|b|i|u)\b/i.test(html);
      isRealHtml = hasBlocks || hasLinks || hasImages || hasFormatting;
    }
    
    const clipboardData = {
      hasText: !!text,
      hasHtml: isRealHtml,
      hasImage: !image.isEmpty(),
      text: text,
      html: isRealHtml ? html : null
    };
    
    if (!image.isEmpty()) {
      clipboardData.imageDataUrl = image.toDataURL();
    }
    
    console.log('[BlackHole] Returning clipboard data:', { hasText: !!text, hasHtml: isRealHtml, hasImage: !image.isEmpty() });
    return clipboardData;
  });
  
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
        
        // Check if the HTML is really just plain text wrapped in tags
        // Many apps put both text/plain and text/html in clipboard even for plain text
        let isRealHtml = false;
        if (html && text) {
          // Strip HTML tags and normalize whitespace for comparison
          const strippedHtml = html
            .replace(/<[^>]*>/g, '') // Remove all HTML tags
            .replace(/&nbsp;/g, ' ') // Replace &nbsp; with space
            .replace(/&amp;/g, '&')  // Decode common entities
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(num)) // Decode numeric entities
            .replace(/\s+/g, ' ')    // Normalize whitespace
            .trim();
          
          const normalizedText = text.replace(/\s+/g, ' ').trim();
          
          // Check for MEANINGFUL HTML elements that indicate intentional formatting
          // Structural elements (blocks, containers)
          const hasBlocks = /<(div|p|br|table|ul|ol|li|h[1-6]|article|section|header|footer|blockquote|pre|code)\b/i.test(html);
          // Links with actual href
          const hasLinks = /<a\s+[^>]*href\s*=/i.test(html);
          // Images
          const hasImages = /<img\s+[^>]*src\s*=/i.test(html);
          // Meaningful formatting (not just wrapper spans)
          const hasFormatting = /<(strong|em|b|i|u|s|mark|sub|sup|del|ins)\b/i.test(html);
          // Has a full style block (not just inline)
          const hasStyleBlock = /<style\b/i.test(html);
          // Has multiple line breaks indicating structured content
          const hasMultipleBreaks = (html.match(/<br\s*\/?>/gi) || []).length >= 2 || (html.match(/<\/p>/gi) || []).length >= 2;
          
          // Content differs significantly (not just wrapper noise)
          const contentDiffers = strippedHtml !== normalizedText && 
            Math.abs(strippedHtml.length - normalizedText.length) > 10;
          
          // It's ONLY real HTML if it has meaningful formatting elements
          // Simple span/font wrappers with styles are NOT considered real HTML
          isRealHtml = hasBlocks || hasLinks || hasImages || hasFormatting || hasStyleBlock || hasMultipleBreaks || contentDiffers;
          
          console.log('HTML check - Blocks:', hasBlocks, 'Links:', hasLinks, 'Images:', hasImages, 
            'Formatting:', hasFormatting, 'Breaks:', hasMultipleBreaks, 'ContentDiffers:', contentDiffers, 
            'IsRealHtml:', isRealHtml);
        } else if (html && !text) {
          // Only HTML, no plain text - check if it has actual content
          const hasActualContent = /<(div|p|br|table|ul|ol|li|h[1-6]|a|img|strong|em|b|i)\b/i.test(html);
          isRealHtml = hasActualContent;
        }
        
        // Prepare clipboard data to send
        const clipboardData = {
          hasText: !!text,
          hasHtml: isRealHtml,
          hasImage: !image.isEmpty(),
          text: text,
          html: isRealHtml ? html : null
        };
        
        // If there's an image, convert it to data URL
        if (!image.isEmpty()) {
          clipboardData.imageDataUrl = image.toDataURL();
        }
        
        // Send clipboard data to the widget
        global.clipboardManager.blackHoleWindow.webContents.send('paste-clipboard-data', clipboardData);
        console.log('Sent clipboard data to black hole widget - isRealHtml:', isRealHtml);
      }
    }
  });

  // Handle get clipboard text request
  ipcMain.on('get-clipboard-text', (event) => {
    try {
      const { clipboard } = require('electron');
      const text = clipboard.readText();
      if (event.sender && !event.sender.isDestroyed()) {
        event.sender.send('clipboard-text-result', text);
      }
    } catch (error) {
      console.error('Error reading clipboard:', error);
      try {
        if (event.sender && !event.sender.isDestroyed()) {
          event.sender.send('clipboard-text-result', '');
        }
      } catch (e) { /* ignore */ }
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
        
        // Allow native DevTools context menu to work (only when right-clicking IN DevTools)
        const url = contents.getURL();
        if (url.startsWith('devtools://') || url.startsWith('chrome-devtools://')) {
          console.log(`[Webview ${data.tabId}] DevTools panel detected, allowing native context menu`);
          return; // Don't prevent default, let DevTools handle it
        }
        
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

  // NOTE: get-idw-environments is now handled by MenuDataManager (menu-data-manager.js)
  // The handler provides: validation, caching, atomic saves, and debounced menu updates
  // Use: global.menuDataManager.getIDWEnvironments() for programmatic access

  // Handle synchronous get-idw-entries request (legacy support)
  ipcMain.on('get-idw-entries', (event) => {
    try {
      // Use MenuDataManager if available, otherwise fall back to file
      if (global.menuDataManager) {
        event.returnValue = global.menuDataManager.getIDWEnvironments();
      } else {
        const configPath = getIdwConfigPath();
        if (fs.existsSync(configPath)) {
          const idwConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          event.returnValue = idwConfig;
        } else {
          event.returnValue = [];
        }
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

  // Article TTS - Generate speech for article content
  const articleTTSDir = path.join(app.getPath('userData'), 'article-tts');
  if (!fs.existsSync(articleTTSDir)) {
    fs.mkdirSync(articleTTSDir, { recursive: true });
  }

  // Save article TTS audio (separate from generation)
  ipcMain.handle('article:save-tts', async (event, options) => {
    try {
      const { articleId, audioData } = options;
      
      if (!audioData || !articleId) {
        return { success: false, error: 'Missing audio data or article ID' };
      }
      
      const sanitizedId = articleId.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
      const audioPath = path.join(articleTTSDir, `${sanitizedId}.mp3`);
      
      const audioBuffer = Buffer.from(audioData, 'base64');
      fs.writeFileSync(audioPath, audioBuffer);
      
      console.log(`[Article TTS] Saved audio: ${audioPath} (${audioBuffer.length} bytes)`);
      return { success: true, audioPath };
    } catch (error) {
      console.error('[Article TTS] Error saving:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('article:get-tts', async (event, articleId) => {
    try {
      const sanitizedId = articleId.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
      const audioPath = path.join(articleTTSDir, `${sanitizedId}.mp3`);
      
      if (fs.existsSync(audioPath)) {
        const audioData = fs.readFileSync(audioPath);
        const base64Audio = audioData.toString('base64');
        return { 
          success: true, 
          audioData: base64Audio,
          hasAudio: true
        };
      }
      
      return { success: true, hasAudio: false };
    } catch (error) {
      console.error('[Article TTS] Error getting audio:', error);
      return { success: false, error: error.message };
    }
  });

  // Persistent cache storage (survives app restart)
  const cacheDir = path.join(app.getPath('userData'), 'cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  ipcMain.handle('cache:save', async (event, { cacheName, data }) => {
    try {
      const cachePath = path.join(cacheDir, `${cacheName}.json`);
      fs.writeFileSync(cachePath, JSON.stringify(data), 'utf8');
      console.log(`[Cache] Saved ${cacheName} (${data.length} entries)`);
      return { success: true };
    } catch (error) {
      console.error(`[Cache] Error saving ${cacheName}:`, error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('cache:load', async (event, cacheName) => {
    try {
      const cachePath = path.join(cacheDir, `${cacheName}.json`);
      if (fs.existsSync(cachePath)) {
        const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        console.log(`[Cache] Loaded ${cacheName} (${data.length} entries)`);
        return { success: true, data };
      }
      return { success: true, data: null };
    } catch (error) {
      console.error(`[Cache] Error loading ${cacheName}:`, error);
      return { success: false, error: error.message };
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

  // Handle fetching article content (separate from RSS feeds) with retry logic
  ipcMain.handle('fetch-article', async (event, url) => {
    const { net } = require('electron');
    const maxRetries = 3;
    const retryDelay = 1000; // 1 second between retries
    
    const fetchWithRetry = (attemptNumber = 1) => {
      return new Promise((resolve, reject) => {
        console.log(`[Fetch] Attempt ${attemptNumber}/${maxRetries} for: ${url}`);
        
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

          // Set timeout - shorter for retries
          const timeoutMs = attemptNumber === 1 ? 15000 : 10000;
          const timeout = setTimeout(() => {
            request.abort();
            reject(new Error(`Request timeout after ${timeoutMs}ms`));
          }, timeoutMs);

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
    };
    
    // Execute with retries
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fetchWithRetry(attempt);
      } catch (error) {
        lastError = error;
        console.log(`[Fetch] Attempt ${attempt} failed: ${error.message}`);
        if (attempt < maxRetries) {
          console.log(`[Fetch] Retrying in ${retryDelay}ms...`);
          await new Promise(r => setTimeout(r, retryDelay));
        }
      }
    }
    console.error(`[Fetch] All ${maxRetries} attempts failed for: ${url}`);
    throw lastError;
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

  // Expose shortcut registration to module-scope callers (e.g. app.whenReady)
  // so we don't crash with "registerGlobalShortcuts is not defined".
  global.registerGlobalShortcuts = registerGlobalShortcuts;
  
  // NOTE: refresh-menu handler is now managed by MenuDataManager (menu-data-manager.js)
  // This provides single source of truth and prevents duplicate handler registration
  // See: getMenuDataManager().forceRefresh() for programmatic refresh
  
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
      // Using Claude 4.5 Sonnet for consistency - only 4.5 models allowed
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': settings.claudeApiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',  // Claude 4.5 only - no older models
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
      // autoUpdater loaded lazily in app.whenReady()
let autoUpdater = null;
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

// Keep a reference to the dashboard window
let dashboardWindow = null;

// Function to open the App Health Dashboard
function openDashboardWindow() {
  console.log('[Dashboard] Opening App Health Dashboard...');
  
  // Check if dashboard window already exists and is not destroyed
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    console.log('[Dashboard] Window exists, focusing it');
    dashboardWindow.show();
    dashboardWindow.focus();
    return;
  }
  
  console.log('[Dashboard] Creating new dashboard window');
  dashboardWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'OneReach.ai - App Health Dashboard',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-health-dashboard.js'),
      webSecurity: true,
      enableRemoteModule: false,
      sandbox: false
    }
  });
  
  // Clear the reference when the window is closed
  dashboardWindow.on('closed', () => {
    console.log('[Dashboard] Window closed');
    dashboardWindow = null;
  });
  
  // Log when the window successfully loads
  dashboardWindow.webContents.on('did-finish-load', () => {
    console.log('[Dashboard] Window loaded successfully');
  });
  
  // Load the dashboard HTML file
  dashboardWindow.loadFile('app-health-dashboard.html').catch(err => {
    console.error('[Dashboard] Error loading dashboard:', err);
  });
}

// Make dashboard window globally accessible
global.openDashboardWindow = openDashboardWindow;

// IPC handler to open dashboard
ipcMain.handle('dashboard:open-log-folder', async () => {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    if (fs.existsSync(logDir)) {
      shell.openPath(logDir);
      return { success: true };
    }
    return { success: false, error: 'Log folder not found' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// IPC handler to resolve/ignore agent issues
ipcMain.handle('dashboard:resolve-issue', async (event, issueId) => {
  try {
    if (global.appManagerAgent) {
      const result = global.appManagerAgent.resolveEscalatedIssue(issueId);
      return { success: result };
    }
    return { success: false, error: 'Agent not available' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('dashboard:ignore-issue', async (event, issueId) => {
  try {
    if (global.appManagerAgent) {
      const result = global.appManagerAgent.ignoreEscalatedIssue(issueId);
      return { success: result };
    }
    return { success: false, error: 'Agent not available' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Keep a reference to the budget dashboard window
let budgetDashboardWindow = null;

// Function to open the budget dashboard window
function openBudgetDashboard() {
  console.log('Opening budget dashboard window...');
  
  // Check if budget dashboard window already exists and is not destroyed
  if (budgetDashboardWindow && !budgetDashboardWindow.isDestroyed()) {
    console.log('Budget dashboard window exists, focusing it');
    budgetDashboardWindow.show();
    budgetDashboardWindow.focus();
    return;
  }
  
  console.log('Creating new budget dashboard window');
  // Create the budget dashboard window
  budgetDashboardWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    title: 'API Budget Dashboard',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-budget.js'),
      webSecurity: true,
      enableRemoteModule: false,
      sandbox: false
    }
  });
  
  // Clear the reference when the window is closed
  budgetDashboardWindow.on('closed', () => {
    console.log('Budget dashboard window closed');
    budgetDashboardWindow = null;
  });
  
  // Handle any load errors
  budgetDashboardWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load budget dashboard window:', errorCode, errorDescription);
  });
  
  // Log when the window successfully loads
  budgetDashboardWindow.webContents.on('did-finish-load', () => {
    console.log('Budget dashboard window loaded successfully');
  });
  
  // Load the budget dashboard HTML file
  budgetDashboardWindow.loadFile('budget-dashboard.html').catch(err => {
    console.error('Error loading budget-dashboard.html:', err);
  });
}

// Make budget dashboard globally accessible
global.openBudgetDashboardGlobal = openBudgetDashboard;

// Keep a reference to the budget estimator window
let budgetEstimatorWindow = null;

// Function to open the budget estimator window
function openBudgetEstimator() {
  console.log('Opening budget estimator window...');
  
  // Check if budget estimator window already exists and is not destroyed
  if (budgetEstimatorWindow && !budgetEstimatorWindow.isDestroyed()) {
    console.log('Budget estimator window exists, focusing it');
    budgetEstimatorWindow.show();
    budgetEstimatorWindow.focus();
    return;
  }
  
  console.log('Creating new budget estimator window');
  // Create the budget estimator window
  budgetEstimatorWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Project Budget Estimator',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-budget-estimator.js'),
      webSecurity: true,
      enableRemoteModule: false,
      sandbox: false
    }
  });
  
  // Clear the reference when the window is closed
  budgetEstimatorWindow.on('closed', () => {
    console.log('Budget estimator window closed');
    budgetEstimatorWindow = null;
  });
  
  // Handle any load errors
  budgetEstimatorWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load budget estimator window:', errorCode, errorDescription);
  });
  
  // Log when the window successfully loads
  budgetEstimatorWindow.webContents.on('did-finish-load', () => {
    console.log('Budget estimator window loaded successfully');
  });
  
  // Load the budget estimator HTML file
  budgetEstimatorWindow.loadFile('budget-estimator.html').catch(err => {
    console.error('Error loading budget-estimator.html:', err);
  });
}

// Make budget estimator globally accessible
global.openBudgetEstimatorGlobal = openBudgetEstimator;

// Function to open the setup wizard modal
function openSetupWizard() {
  console.log('Opening setup wizard window...');
  
  // Debug existing configuration
  const configPath = getIdwConfigPath();
  console.log('Configuration path:', configPath);
  let existingConfig = [];
  try {
    if (fs.existsSync(configPath)) {
      const rawData = fs.readFileSync(configPath, 'utf8');
      console.log('Raw config data:', rawData);
      existingConfig = JSON.parse(rawData);
      console.log('Parsed IDW config:', existingConfig);
    } else {
      console.log('No configuration file exists at', configPath);
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
    const wizardConfigPath = getIdwConfigPath();
    if (fs.existsSync(wizardConfigPath)) {
      const configData = fs.readFileSync(wizardConfigPath, 'utf8');
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
    
    // Handle window closed event (memory leak prevention)
    testWindow.on('closed', () => {
      console.log('CSP test window closed');
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

// ============================================
// TEST AGENT - Puppeteer-based UI Testing
// ============================================

const { testAgent } = require('./test-agent');

// Generate test plan for a file
ipcMain.handle('test-agent:generate-plan', async (event, htmlFilePath, useAI = false) => {
  console.log('[TestAgent] Generating test plan for:', htmlFilePath);
  try {
    let aiAnalyzer = null;
    
    if (useAI) {
      // Use the vision API to analyze
      const apiKey = settings.getLLMApiKey();
      const provider = settings.getLLMProvider();
      
      if (apiKey && provider === 'anthropic') {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic({ apiKey });
        
        aiAnalyzer = async (prompt) => {
          const response = await client.messages.create({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 2000,
            messages: [{ role: 'user', content: prompt }]
          });
          return response.content[0].text;
        };
      }
    }
    
    const plan = await testAgent.generateTestPlan(htmlFilePath, aiAnalyzer);
    return { success: true, testPlan: plan };
  } catch (error) {
    console.error('[TestAgent] Generate plan error:', error);
    return { success: false, error: error.message };
  }
});

// Run all tests
ipcMain.handle('test-agent:run-tests', async (event, htmlFilePath, options = {}) => {
  console.log('[TestAgent] Running tests for:', htmlFilePath);
  try {
    const results = await testAgent.runTests(htmlFilePath, {
      ...options,
      onProgress: (result) => {
        // Send progress updates to renderer (check if sender still exists)
        try {
          if (event.sender && !event.sender.isDestroyed()) {
            event.sender.send('test-agent:progress', result);
          }
        } catch (e) {
          console.log('[TestAgent] Could not send progress - window may be closed');
        }
      }
    });
    return results;
  } catch (error) {
    console.error('[TestAgent] Run tests error:', error);
    return { success: false, error: error.message };
  }
});

// Run Playwright API tests
ipcMain.handle('aider:run-playwright-tests', async (event, options = {}) => {
  console.log('[Playwright] Running API tests:', options);
  try {
    const { spawn } = require('child_process');
    const path = require('path');
    
    const testDir = options.testDir || process.cwd();
    const configPath = options.configPath || path.join(testDir, 'playwright.config.js');
    const project = options.project || 'api';
    
    return new Promise((resolve) => {
      const args = ['playwright', 'test', '--project=' + project, '--reporter=json'];
      
      if (options.configPath) {
        args.push('--config=' + configPath);
      }
      
      const proc = spawn('npx', args, {
        cwd: testDir,
        env: { ...process.env, API_BASE_URL: options.baseUrl || 'http://localhost:3000' }
      });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      proc.on('close', (code) => {
        try {
          // Parse JSON output
          const jsonMatch = stdout.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            const passed = result.stats?.expected || 0;
            const failed = (result.stats?.unexpected || 0) + (result.stats?.flaky || 0);
            
            resolve({
              success: failed === 0,
              passed,
              failed,
              total: passed + failed,
              suites: result.suites || [],
              raw: result
            });
          } else {
            resolve({
              success: code === 0,
              passed: code === 0 ? 1 : 0,
              failed: code === 0 ? 0 : 1,
              output: stdout,
              error: stderr
            });
          }
        } catch (e) {
          resolve({
            success: false,
            error: e.message,
            output: stdout,
            stderr: stderr
          });
        }
      });
      
      proc.on('error', (err) => {
        resolve({
          success: false,
          error: 'Playwright not installed: ' + err.message
        });
      });
    });
  } catch (error) {
    console.error('[Playwright] Test error:', error);
    return { success: false, error: error.message };
  }
});

// Run accessibility test
ipcMain.handle('test-agent:accessibility', async (event, htmlFilePath) => {
  console.log('[TestAgent] Running accessibility test for:', htmlFilePath);
  try {
    const results = await testAgent.runAccessibilityTest(htmlFilePath);
    return results;
  } catch (error) {
    console.error('[TestAgent] Accessibility test error:', error);
    return { success: false, error: error.message };
  }
});

// Run performance test
ipcMain.handle('test-agent:performance', async (event, htmlFilePath) => {
  console.log('[TestAgent] Running performance test for:', htmlFilePath);
  try {
    const results = await testAgent.runPerformanceTest(htmlFilePath);
    return results;
  } catch (error) {
    console.error('[TestAgent] Performance test error:', error);
    return { success: false, error: error.message };
  }
});

// Run visual regression test
ipcMain.handle('test-agent:visual', async (event, htmlFilePath, baseline = null) => {
  console.log('[TestAgent] Running visual test for:', htmlFilePath);
  try {
    const results = await testAgent.runVisualTest(htmlFilePath, baseline);
    return results;
  } catch (error) {
    console.error('[TestAgent] Visual test error:', error);
    return { success: false, error: error.message };
  }
});

// Interactive AI test
ipcMain.handle('test-agent:interactive', async (event, htmlFilePath) => {
  console.log('[TestAgent] Running interactive test for:', htmlFilePath);
  try {
    const { getSettingsManager } = require('./settings-manager');
    const settingsManager = getSettingsManager();
    const apiKey = settingsManager.get('llmApiKey');
    const provider = settingsManager.get('llmProvider') || 'anthropic';
    
    let aiAnalyzer = null;
    if (apiKey && provider === 'anthropic') {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      
      aiAnalyzer = async (data) => {
        const response = await client.messages.create({
          model: 'claude-sonnet-4-5-20250929', // Vision model for screenshot analysis
          max_tokens: 2000,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: data.screenshot
                }
              },
              {
                type: 'text',
                text: `Analyze this UI screenshot and the following data:
                
Console Errors: ${JSON.stringify(data.consoleErrors)}
JS Errors: ${JSON.stringify(data.jsErrors)}

Please identify:
1. Any visual bugs or issues
2. UX problems
3. Suggested fixes
4. Test cases that should be added`
              }
            ]
          }]
        });
        return response.content[0].text;
      };
    }
    
    const results = await testAgent.interactiveTest(htmlFilePath, aiAnalyzer);
    return results;
  } catch (error) {
    console.error('[TestAgent] Interactive test error:', error);
    return { success: false, error: error.message };
  }
});

// Update test agent context
ipcMain.handle('test-agent:update-context', async (event, context) => {
  testAgent.updateContext(context);
  return { success: true };
});

// Run cross-browser test
ipcMain.handle('test-agent:cross-browser', async (event, htmlFilePath) => {
  console.log('[TestAgent] Running cross-browser test for:', htmlFilePath);
  try {
    const results = await testAgent.runCrossBrowserTest(htmlFilePath);
    return results;
  } catch (error) {
    console.error('[TestAgent] Cross-browser test error:', error);
    return { success: false, error: error.message };
  }
});

// Enable/disable tracing
ipcMain.handle('test-agent:set-tracing', async (event, enabled) => {
  testAgent.setTracing(enabled);
  return { success: true };
});

// Close test agent
ipcMain.handle('test-agent:close', async () => {
  await testAgent.close();
  return { success: true };
});

// ==================== BUDGET MANAGER IPC HANDLERS ====================
// Initialize budget manager
budgetManager = getBudgetManager();
console.log('[main.js] Budget manager initialized');

// Get cost summary
ipcMain.handle('budget:getCostSummary', async (event, period) => {
  return budgetManager.getCostSummary(period);
});

// Get all budget limits
ipcMain.handle('budget:getAllBudgetLimits', async () => {
  return budgetManager.getAllBudgetLimits();
});

// Set budget limit
ipcMain.handle('budget:setBudgetLimit', async (event, scope, limit, alertAt) => {
  return budgetManager.setBudgetLimit(scope, limit, alertAt);
});

// Get usage history
ipcMain.handle('budget:getUsageHistory', async (event, options) => {
  return budgetManager.getUsageHistory(options);
});

// Get project costs
ipcMain.handle('budget:getProjectCosts', async (event, projectId) => {
  return budgetManager.getProjectCosts(projectId);
});

// Get all projects
ipcMain.handle('budget:getAllProjects', async () => {
  return budgetManager.getAllProjects();
});

// Clear usage history
ipcMain.handle('budget:clearUsageHistory', async (event, options) => {
  return budgetManager.clearUsageHistory(options);
});

// Export data
ipcMain.handle('budget:exportData', async () => {
  return budgetManager.exportData();
});

// Estimate cost
ipcMain.handle('budget:estimateCost', async (event, provider, params) => {
  return budgetManager.estimateCost(provider, params);
});

// Check budget
ipcMain.handle('budget:checkBudget', async (event, provider, estimatedCost) => {
  return budgetManager.checkBudget(provider, estimatedCost);
});

// Track usage (called from API services)
ipcMain.handle('budget:trackUsage', async (event, provider, projectId, usage) => {
  const entry = budgetManager.trackUsage(provider, projectId, usage);
  // Notify budget dashboard if open
  if (budgetDashboardWindow && !budgetDashboardWindow.isDestroyed()) {
    budgetDashboardWindow.webContents.send('budget:updated', entry);
  }
  return entry;
});

// Register project
ipcMain.handle('budget:registerProject', async (event, projectId, name) => {
  return budgetManager.registerProject(projectId, name);
});

// Get pricing
ipcMain.handle('budget:getPricing', async () => {
  return budgetManager.getPricing();
});

// Update pricing
ipcMain.handle('budget:updatePricing', async (event, provider, pricing) => {
  return budgetManager.updatePricing(provider, pricing);
});

// Reset to defaults - REQUIRES CONFIRMATION TOKEN
ipcMain.handle('budget:resetToDefaults', async (event, confirmToken) => {
  return budgetManager.resetToDefaults(confirmToken);
});

// Import data
ipcMain.handle('budget:importData', async (event, jsonData) => {
  return budgetManager.importData(jsonData);
});

// ==================== BUDGET CONFIGURATION ====================

// Check if budget is configured
ipcMain.handle('budget:isBudgetConfigured', async () => {
  return budgetManager.isBudgetConfigured();
});

// Mark budget as configured
ipcMain.handle('budget:markBudgetConfigured', async () => {
  return budgetManager.markBudgetConfigured();
});

// ==================== ESTIMATES ====================

// Get estimates for a project
ipcMain.handle('budget:getEstimates', async (event, projectId) => {
  return budgetManager.getEstimates(projectId);
});

// Save estimates for a project
ipcMain.handle('budget:saveEstimates', async (event, projectId, estimates) => {
  return budgetManager.saveEstimates(projectId, estimates);
});

// Update a single estimate
ipcMain.handle('budget:updateEstimate', async (event, projectId, category, update) => {
  return budgetManager.updateEstimate(projectId, category, update);
});

// Get total estimated amount
ipcMain.handle('budget:getTotalEstimated', async (event, projectId) => {
  return budgetManager.getTotalEstimated(projectId);
});

// Get estimate categories
ipcMain.handle('budget:getEstimateCategories', async () => {
  return budgetManager.getEstimateCategories();
});

// ==================== BACKUP & RESTORE ====================

// Create a backup
ipcMain.handle('budget:createBackup', async () => {
  return budgetManager.createBackup();
});

// List available backups
ipcMain.handle('budget:listBackups', async () => {
  return budgetManager.listBackups();
});

// Restore from a backup
ipcMain.handle('budget:restoreFromBackup', async (event, backupPath) => {
  return budgetManager.restoreFromBackup(backupPath);
});

// ==================== BUDGET SETUP WIZARD ====================

// Check if budget has been configured, show setup wizard if not
function checkAndShowBudgetSetup() {
  try {
    if (!budgetManager) {
      console.log('[Budget] Budget manager not initialized');
      return;
    }
    
    const isConfigured = budgetManager.isBudgetConfigured();
    console.log('[Budget] Budget configured:', isConfigured);
    
    if (!isConfigured) {
      console.log('[Budget] Budget not configured, showing setup wizard...');
      // Small delay to let the main window fully initialize
      setTimeout(() => {
        openBudgetSetup();
      }, 500);
    }
  } catch (error) {
    console.error('[Budget] Error checking budget configuration:', error);
  }
}

// Keep a reference to the budget setup window
let budgetSetupWindow = null;

// Function to open the budget setup wizard window
function openBudgetSetup() {
  console.log('Opening budget setup window...');
  
  // Check if budget setup window already exists and is not destroyed
  if (budgetSetupWindow && !budgetSetupWindow.isDestroyed()) {
    console.log('Budget setup window exists, focusing it');
    budgetSetupWindow.show();
    budgetSetupWindow.focus();
    return;
  }
  
  console.log('Creating new budget setup window');
  
  // Get the main window for modal parent
  const mainWindow = browserWindow.getMainWindow();
  
  // Create the budget setup window
  budgetSetupWindow = new BrowserWindow({
    width: 650,
    height: 700,
    title: 'Budget Setup - Required',
    parent: mainWindow || undefined,
    modal: !!mainWindow, // Only modal if we have a parent
    resizable: false,
    minimizable: false,
    closable: true, // User can close but will be prompted again on next launch
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-budget.js'),
      webSecurity: true,
      enableRemoteModule: false,
      sandbox: false
    }
  });
  
  // Clear the reference when the window is closed
  budgetSetupWindow.on('closed', () => {
    console.log('Budget setup window closed');
    budgetSetupWindow = null;
  });
  
  // Handle any load errors
  budgetSetupWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('Failed to load budget setup window:', errorCode, errorDescription);
  });
  
  // Log when the window successfully loads
  budgetSetupWindow.webContents.on('did-finish-load', () => {
    console.log('Budget setup window loaded successfully');
  });
  
  // Load the budget setup HTML file
  budgetSetupWindow.loadFile('budget-setup.html').catch(err => {
    console.error('Error loading budget-setup.html:', err);
  });
}

// Make budget setup globally accessible
global.openBudgetSetupGlobal = openBudgetSetup;

// Open budget setup (can be called from other windows)
ipcMain.on('open-budget-setup', () => {
  console.log('Opening budget setup via IPC');
  openBudgetSetup();
});

// Register budget warning callback to broadcast to all budget windows
budgetManager.onWarning((warningInfo) => {
  console.log('[main.js] Budget warning received:', warningInfo);
  
  // Broadcast to budget dashboard if open
  if (budgetDashboardWindow && !budgetDashboardWindow.isDestroyed()) {
    budgetDashboardWindow.webContents.send('budget:warning', warningInfo);
  }
  
  // Show system notification for exceeded budgets
  if (warningInfo.type === 'budget_exceeded') {
    const { Notification } = require('electron');
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: 'Budget Exceeded',
        body: warningInfo.message,
        icon: path.join(__dirname, 'assets', 'icon.png')
      });
      notification.show();
    }
  }
});

// Open budget dashboard (can be called from other windows)
ipcMain.on('open-budget-dashboard', () => {
  console.log('Opening budget dashboard via IPC');
  openBudgetDashboard();
});

// Open budget estimator (can be called from other windows)
ipcMain.on('open-budget-estimator', () => {
  console.log('Opening budget estimator via IPC');
  openBudgetEstimator();
});

// Export functions for use in other modules
module.exports = {
  openSetupWizard,
  updateIDWMenu,
  updateGSXMenu,
  openBudgetDashboard,
  openBudgetEstimator,
  openBudgetSetup
}; 