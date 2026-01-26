const { app, ipcMain, Tray, Menu, MenuItem, BrowserWindow, desktopCapturer, globalShortcut, screen } = require('electron');
const dialog = require('./wrapped-dialog'); // Use wrapped dialog for Spaces integration
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { setApplicationMenu, registerTestMenuShortcut, refreshGSXLinks, closeAllGSXWindows } = require('./menu');
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
const AuthManager = require('./auth-manager');
const { getConversationCapture } = require('./src/ai-conversation-capture');

// Global conversation capture instance
let conversationCapture = null;

// Global Budget Manager instance
let budgetManager = null;

// Global Auth Manager instance
let authManager = null;

// Global Voice Orb window instance
let orbWindow = null;

// Global Command HUD window instance
let commandHUDWindow = null;

// Global Intro Wizard window instance
let introWizardWindow = null;

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
    // Validate spacePath before any path operations
    if (!spacePath || typeof spacePath !== 'string') {
      throw new Error(`[BranchManager] Invalid spacePath: ${JSON.stringify(spacePath)} (type: ${typeof spacePath})`);
    }
    
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
    // Validate required paths before any operations
    if (!branchPath || typeof branchPath !== 'string') {
      throw new Error(`[BranchManager] Invalid branchPath: ${JSON.stringify(branchPath)} (type: ${typeof branchPath})`);
    }
    if (!branchId || typeof branchId !== 'string') {
      throw new Error(`[BranchManager] Invalid branchId: ${JSON.stringify(branchId)} (type: ${typeof branchId})`);
    }
    if (!this.logsDir) {
      throw new Error('[BranchManager] logsDir is not set. Call initialize() first before initBranch().');
    }
    
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
    
    // Get Python path dynamically using DependencyManager
    const { getDependencyManager } = require('./dependency-manager');
    const depManager = getDependencyManager();
    const aiderPythonPath = depManager.getAiderPythonPath();
    
    this.logOrchestration('BRANCH', `Using Python path: ${aiderPythonPath}`);
    
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
  
  tray.setToolTip('GSX Power User');
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
          "img-src 'self' data: blob: spaces: * https://*.onereach.ai; " +
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
  
  // STARTUP RECOVERY: Check for and restore any missing config files from backups
  const userDataPath = app.getPath('userData');
  const protectedFiles = [
    'external-bots.json',
    'image-creators.json',
    'video-creators.json', 
    'audio-generators.json',
    'ui-design-tools.json',
    'web-tools.json',
    'idw-entries.json',
    'gsx-links.json'
  ];
  
  for (const filename of protectedFiles) {
    const filePath = path.join(userDataPath, filename);
    const backupPath = path.join(userDataPath, filename + '.backup');
    const protectBackupPath = path.join(userDataPath, filename + '.protect-backup');
    
    // If main file is missing or empty, try to restore from backups
    let needsRestore = false;
    try {
      if (!fs.existsSync(filePath)) {
        needsRestore = true;
      } else {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (!content || content === '[]' || content === '{}') {
          // File exists but is empty - check if backup has data
          needsRestore = true;
        }
      }
    } catch (e) {
      needsRestore = true;
    }
    
    if (needsRestore) {
      // Try protect-backup first (most recent), then regular backup
      const backupSources = [protectBackupPath, backupPath];
      for (const backup of backupSources) {
        if (fs.existsSync(backup)) {
          try {
            const backupContent = fs.readFileSync(backup, 'utf8').trim();
            if (backupContent && backupContent !== '[]' && backupContent !== '{}') {
              fs.copyFileSync(backup, filePath);
              console.log(`[Startup Recovery] Restored ${filename} from backup`);
              break;
            }
          } catch (e) {
            console.warn(`[Startup Recovery] Could not restore ${filename}:`, e.message);
          }
        }
      }
    }
  }
  console.log('[Startup Recovery] Config file check complete');
  
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
  
  // Initialize Spaces upload handler and register IPC handlers
  const { registerIPCHandlers } = require('./spaces-upload-handler');
  registerIPCHandlers();
  console.log('[Spaces Upload] IPC handlers registered');
  
  // Register Claude Terminal IPC handlers
  registerClaudeTerminalHandlers();
  
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
  
  // Initialize Auth Manager for IDW credential management
  authManager = new AuthManager(app);
  global.authManager = authManager;
  console.log('[Main] Auth Manager initialized for IDW credential management');
  
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
  
  // Initialize Spaces API Server for browser extension communication
  const { getSpacesAPIServer } = require('./spaces-api-server');
  global.spacesAPIServer = getSpacesAPIServer();
  global.spacesAPIServer.start().then(() => {
    console.log('Spaces API Server started');
  }).catch(err => {
    console.error('Failed to start Spaces API Server:', err);
  });
  
  // Set up Tab Picker IPC handlers
  setupTabPickerIPC();
  
  // Set up Intro Wizard IPC handlers
  setupIntroWizardIPC();
  
  // Set up Agent Manager IPC handlers
  setupAgentManagerIPC();
  
  // Set up Claude Code IPC handlers
  setupClaudeCodeIPC();
  
  // Add keyboard shortcuts to open dev tools (enabled in both dev and production)
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
        
        // Set up Agent Escalation IPC handlers
        ipcMain.handle('agent:respond-to-escalation', async (event, escalationId, action, details) => {
          if (!global.appManagerAgent) {
            return { success: false, error: 'Agent not initialized' };
          }
          try {
            return await global.appManagerAgent.handleUserEscalationResponse(escalationId, action, details);
          } catch (error) {
            console.error('[Agent] Error handling escalation response:', error);
            return { success: false, error: error.message };
          }
        });
        
        ipcMain.handle('agent:get-pending-escalations', async () => {
          if (!global.appManagerAgent) {
            return [];
          }
          try {
            return global.appManagerAgent.getPendingEscalations();
          } catch (error) {
            console.error('[Agent] Error getting pending escalations:', error);
            return [];
          }
        });
        
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
    
    // Ensure dock is visible on macOS (fixes mysterious menu disappearance)
    if (process.platform === 'darwin' && app.dock) {
      app.dock.show().catch(err => {
        console.log('[Dock] Could not show dock:', err.message);
      });
      console.log('[Startup] Ensured dock visibility on macOS');
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

    // Initialize Voice TTS (ElevenLabs Text-to-Speech for voice mode)
    setupVoiceTTS();

    // Initialize Voice Orb if enabled in settings
    initializeVoiceOrb();

    console.log('[Startup] Deferred managers initialized');
    
    // Check if intro wizard should be shown (first run or update)
    checkAndShowIntroWizard();
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
  
  // Setup App Actions IPC (for voice-controlled app navigation)
  try {
    setupAppActionsIPC();
    console.log('[Main] App Actions IPC initialized');
  } catch (error) {
    console.error('[Main] Error setting up App Actions IPC:', error);
  }
  
  // Setup Evaluation and Meta-Learning IPC handlers
  try {
    const { setupEvaluationIPC } = require('./lib/ipc');
    setupEvaluationIPC();
    console.log('[Main] Evaluation and Meta-Learning IPC initialized');
  } catch (error) {
    console.error('[Main] Error setting up Evaluation IPC:', error);
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
// APP LIFECYCLE HANDLERS
// ============================================

// Handle app quit - coordinate window closing
app.on('before-quit', async (event) => {
  console.log('[App] before-quit event - coordinating shutdown');
  
  // Skip cleanup if we're installing an update - let the updater handle everything
  if (global.isUpdatingApp) {
    console.log('[App] Skipping cleanup - app is updating');
    return;
  }
  
  // Save browser tab state before quitting
  try {
    const mainWindow = browserWindow.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      console.log('[App] Sending save-tabs-state to main window');
      mainWindow.webContents.send('save-tabs-state');
      // Give renderer a moment to save
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (error) {
    console.error('[App] Error saving tab state:', error);
  }
  
  // Save voice orb position before quitting
  if (typeof saveOrbPosition === 'function') {
    try {
      saveOrbPosition();
    } catch (error) {
      console.error('[App] Error saving orb position:', error);
    }
  }
  
  // Stop built-in agents
  if (typeof stopBuiltInAgents === 'function') {
    try {
      await stopBuiltInAgents();
    } catch (error) {
      console.error('[App] Error stopping built-in agents:', error);
    }
  }
  
  // Stop app manager agent (background scanner)
  try {
    if (global.appManagerAgent) {
      console.log('[App] Stopping app manager agent...');
      global.appManagerAgent.stop();
      global.appManagerAgent = null;
    }
  } catch (error) {
    console.error('[App] Error stopping app manager agent:', error);
  }
  
  // Shutdown exchange bridge
  try {
    const { shutdown } = require('./src/voice-task-sdk/exchange-bridge');
    await shutdown();
  } catch (error) {
    // Exchange may not be initialized
  }
  
  // Close all GSX windows first (they have forced destroy logic)
  try {
    closeAllGSXWindows();
  } catch (error) {
    console.error('[App] Error closing GSX windows:', error);
  }
  
  // Get all windows
  const allWindows = BrowserWindow.getAllWindows();
  console.log(`[App] Found ${allWindows.length} windows to close`);
  
  // Close clipboard manager first
  if (clipboardManager) {
    try {
      clipboardManager.destroy();
      console.log('[App] Clipboard manager destroyed');
    } catch (error) {
      console.error('[App] Error destroying clipboard manager:', error);
    }
  }
  
  // Force close all remaining windows with timeout
  allWindows.forEach((win, index) => {
    if (!win.isDestroyed()) {
      const title = win.getTitle();
      console.log(`[App] Force closing window ${index + 1}/${allWindows.length}: ${title}`);
      
      try {
        // Try graceful close first
        win.close();
        
        // Force destroy after 1 second if still alive
        setTimeout(() => {
          if (!win.isDestroyed()) {
            console.log(`[App] Force destroying stubborn window: ${title}`);
            win.destroy();
          }
        }, 1000);
      } catch (error) {
        console.error(`[App] Error closing window ${title}:`, error);
        // Try to destroy anyway
        try {
          win.destroy();
        } catch (e) {
          console.error(`[App] Error destroying window ${title}:`, e);
        }
      }
    }
  });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  console.log('[App] All windows closed');
  // On macOS, apps typically stay open until explicitly quit
  if (process.platform !== 'darwin') {
    console.log('[App] Quitting app (non-macOS)');
    app.quit();
  } else {
    console.log('[App] Staying open (macOS - waiting for Cmd+Q)');
  }
});

// Final cleanup before process exits
app.on('will-quit', (event) => {
  console.log('[App] will-quit event - final cleanup');
  
  // Skip cleanup if we're installing an update
  if (global.isUpdatingApp) {
    console.log('[App] Skipping final cleanup - app is updating');
    return;
  }
  
  // Last chance to save orb position
  if (typeof saveOrbPosition === 'function') {
    try {
      saveOrbPosition();
    } catch (error) {
      console.error('[App] Error saving orb position:', error);
    }
  }
  
  // Clean up Spaces upload temp files
  try {
    const { cleanupTempFiles } = require('./spaces-upload-handler');
    cleanupTempFiles();
    console.log('[App] Cleaned up Spaces upload temp files');
  } catch (err) {
    console.error('[App] Error cleaning up Spaces temp files:', err);
  }
  
  // Shutdown Aider Bridge
  if (aiderBridge) {
    console.log('[App] Shutting down Aider Bridge...');
    try {
      aiderBridge.shutdown().catch(err => 
        console.error('[App] Error shutting down Aider:', err)
      );
    } catch (error) {
      console.error('[App] Error in Aider shutdown:', error);
    }
  }
  
  // Unregister global shortcuts
  if (registeredShortcuts && registeredShortcuts.length > 0) {
    registeredShortcuts.forEach(shortcut => {
      try {
        globalShortcut.unregister(shortcut);
      } catch (e) {
        console.error(`[App] Error unregistering shortcut ${shortcut}:`, e);
      }
    });
    console.log(`[App] Unregistered ${registeredShortcuts.length} shortcuts`);
  }
  
  // Final log flush
  if (logger && logger.flush) {
    try {
      logger.flush();
      console.log('[App] Logger flushed');
    } catch (error) {
      console.error('[App] Error flushing logger:', error);
    }
  }
  
  console.log('[App] Final cleanup complete - app will now quit');
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
  
  // Initialize conversation capture
  try {
    
    const { getSettingsManager } = require('./settings-manager');
    const settingsManager = getSettingsManager();
    
    
    conversationCapture = getConversationCapture(spacesAPI, settingsManager);
    
    
    console.log('[ConversationCapture] ✅ Initialized');
  } catch (error) {
    console.error('[ConversationCapture] Failed to initialize:', error);
  }
  
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
  
  // ---- GENERATIVE SEARCH ----
  
  // Generative search engine instance
  let generativeSearchEngine = null;
  
  // Initialize generative search engine
  function getGenerativeSearchEngine() {
    if (!generativeSearchEngine) {
      try {
        const { GenerativeFilterEngine } = require('./lib/generative-search');
        generativeSearchEngine = new GenerativeFilterEngine(spacesAPI, {
          concurrency: 5,
          batchSize: 8,
          onProgress: (progress) => {
            // Broadcast progress to all windows
            BrowserWindow.getAllWindows().forEach(win => {
              win.webContents.send('generative-search:progress', progress);
            });
          }
        });
        console.log('[GenerativeSearch] Engine initialized');
      } catch (error) {
        console.error('[GenerativeSearch] Failed to initialize engine:', error);
      }
    }
    return generativeSearchEngine;
  }
  
  // Run generative search
  ipcMain.handle('generative-search:search', async (event, options) => {
    try {
      const engine = getGenerativeSearchEngine();
      if (!engine) {
        throw new Error('Generative search engine not available');
      }
      
      // Get API key from settings
      const apiKey = settingsManager.get('openaiApiKey');
      if (!apiKey) {
        throw new Error('OpenAI API key not configured. Please add it in Settings.');
      }
      
      const results = await engine.search({
        ...options,
        apiKey
      });
      
      return results;
    } catch (error) {
      console.error('[GenerativeSearch] Search error:', error);
      throw error;
    }
  });
  
  // Estimate search cost
  ipcMain.handle('generative-search:estimate-cost', async (event, options) => {
    try {
      const engine = getGenerativeSearchEngine();
      if (!engine) {
        return { formatted: 'Engine not available' };
      }
      
      // Get item count for the space
      let items = spacesAPI.storage.getAllItems();
      if (options.spaceId) {
        items = items.filter(item => item.spaceId === options.spaceId);
      }
      
      return engine.estimateCost(
        items.length,
        options.filters || [],
        options.mode || 'quick'
      );
    } catch (error) {
      console.error('[GenerativeSearch] Cost estimation error:', error);
      return { formatted: 'Unable to estimate' };
    }
  });
  
  // Cancel ongoing search
  ipcMain.handle('generative-search:cancel', async () => {
    try {
      const engine = getGenerativeSearchEngine();
      if (engine && engine.batchProcessor) {
        engine.batchProcessor.cancel();
      }
      return true;
    } catch (error) {
      console.error('[GenerativeSearch] Cancel error:', error);
      return false;
    }
  });
  
  // Get filter types
  ipcMain.handle('generative-search:get-filter-types', async () => {
    try {
      const { FILTER_TYPES, FILTER_CATEGORIES } = require('./lib/generative-search');
      return { filterTypes: FILTER_TYPES, categories: FILTER_CATEGORIES };
    } catch (error) {
      console.error('[GenerativeSearch] Get filter types error:', error);
      return { filterTypes: {}, categories: {} };
    }
  });
  
  // Clear search cache
  ipcMain.handle('generative-search:clear-cache', async () => {
    try {
      const engine = getGenerativeSearchEngine();
      if (engine) {
        engine.clearCache();
      }
      return true;
    } catch (error) {
      console.error('[GenerativeSearch] Clear cache error:', error);
      return false;
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
  
  // ---- MULTI-TENANT TOKEN IPC HANDLERS ----
  const { session } = require('electron');
  const multiTenantStore = require('./multi-tenant-store');
  
  // Get multi-tenant token for environment (returns metadata only, NOT the value)
  ipcMain.handle('multi-tenant:get-token', async (event, environment) => {
    const token = multiTenantStore.getToken(environment);
    if (!token) return null;
    
    // Return metadata only, NOT the value (security)
    return {
      environment,
      domain: token.domain,
      expiresAt: token.expiresAt,
      capturedAt: token.capturedAt,
      isValid: multiTenantStore.hasValidToken(environment)
    };
  });
  
  // Check if multi-tenant token exists AND is not expired
  ipcMain.handle('multi-tenant:has-token', async (event, environment) => {
    return multiTenantStore.hasValidToken(environment);
  });
  
  // Inject token into a specific partition
  ipcMain.handle('multi-tenant:inject-token', async (event, { environment, partition }) => {
    // SECURITY: Validate partition format
    const validTabPattern = /^persist:tab-\d+-[a-z0-9]+$/;
    const validGsxPattern = /^persist:gsx-(edison|staging|production|dev)$/;
    
    if (!validTabPattern.test(partition) && !validGsxPattern.test(partition)) {
      console.warn(`[MultiTenant] Rejected invalid partition: ${partition}`);
      return { success: false, error: 'Invalid partition format' };
    }
    
    // SECURITY: For GSX partitions, verify environment matches
    if (partition.startsWith('persist:gsx-')) {
      const expectedPartition = `persist:gsx-${environment}`;
      if (partition !== expectedPartition) {
        console.warn(`[MultiTenant] Environment mismatch: ${environment} vs ${partition}`);
        return { success: false, error: 'Environment/partition mismatch' };
      }
    }
    
    const token = multiTenantStore.getToken(environment);
    
    // Validate token exists
    if (!token) {
      return { success: false, error: 'No token available' };
    }
    
    // Check expiration
    if (token.expiresAt && token.expiresAt * 1000 < Date.now()) {
      console.log(`[MultiTenant] Token for ${environment} expired, clearing`);
      multiTenantStore.clearToken(environment);
      return { success: false, error: 'Token expired' };
    }
    
    // Validate token value
    if (!token.value || token.value.length < 10) {
      return { success: false, error: 'Invalid token value' };
    }
    
    try {
      const ses = session.fromPartition(partition);
      // Use broader domain to cover all subdomains (auth, idw, chat, api)
      const broaderDomain = multiTenantStore.getBroaderDomain(environment);
      
      // Log token details for debugging
      console.log(`[MultiTenant] Token details for ${environment}:`, {
        hasValue: !!token.value,
        valueLength: token.value?.length,
        originalDomain: token.domain,
        targetDomain: broaderDomain,
        expiresAt: token.expiresAt,
        expiresDate: token.expiresAt ? new Date(token.expiresAt * 1000).toISOString() : 'none',
        isExpired: token.expiresAt ? (token.expiresAt * 1000 < Date.now()) : false
      });
      
      // CRITICAL: Set cookie on BROADER domain first so it's sent to all subdomains
      // The original domain (e.g., .edison.api.onereach.ai) is too narrow -
      // it won't be sent to auth.edison.onereach.ai or idw.edison.onereach.ai
      
      // First, set the BROADER domain cookie (this is the one auth server will see)
      await ses.cookies.set({
        url: `https://auth${broaderDomain}`,  // e.g., https://auth.edison.onereach.ai
        name: 'mult',
        value: token.value,
        domain: broaderDomain,               // e.g., .edison.onereach.ai (covers ALL subdomains)
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'no_restriction',          // Allow cross-site requests (needed for SSO)
        expirationDate: token.expiresAt
      });
      
      console.log(`[MultiTenant] Injected ${environment} mult token with BROADER domain ${broaderDomain}`);
      
      // Verify the broader domain cookie was set
      const broadCookies = await ses.cookies.get({ name: 'mult', domain: broaderDomain });
      console.log(`[MultiTenant] Broader domain cookies:`, broadCookies.map(c => ({
        domain: c.domain,
        path: c.path
      })));
      
      // Also set on original domain for API calls (if different)
      const originalDomain = token.domain;
      if (originalDomain && originalDomain !== broaderDomain) {
        try {
          await ses.cookies.set({
            url: `https://${originalDomain.replace(/^\./, '')}`,
            name: 'mult',
            value: token.value,
            domain: originalDomain,
            path: token.path || '/',
            secure: token.secure !== false,
            httpOnly: token.httpOnly !== false,
            sameSite: 'no_restriction',
            expirationDate: token.expiresAt
          });
          console.log(`[MultiTenant] Also set original domain cookie: ${originalDomain}`);
        } catch (e) {
          console.log(`[MultiTenant] Could not set original domain cookie: ${e.message}`);
        }
      }
      
      // Final verification - show ALL mult cookies in this session with full details
      const allCookies = await ses.cookies.get({ name: 'mult' });
      console.log(`[MultiTenant] ALL mult cookies in ${partition}:`, allCookies.map(c => ({
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : 'session'
      })));
      
      // CRITICAL: Flush cookie store to ensure cookies are persisted before navigation
      // Without this, the first request may not include the cookie due to timing
      await ses.cookies.flushStore();
      
      // Post-flush verification - confirm cookies are still present
      const postFlushCookies = await ses.cookies.get({ name: 'mult' });
      console.log(`[MultiTenant] Cookie store flushed. ${postFlushCookies.length} mult cookies confirmed in ${partition}`);
      
      // NOTE: We intentionally do NOT inject the 'or' token here.
      // The 'or' cookie is ACCOUNT-SPECIFIC - it only works for the account it was created for.
      // If we inject an 'or' token for Account A into a tab loading Account B, it will fail.
      // Each tab should establish its own 'or' session when authenticating.
      // The 'mult' cookie alone enables SSO (skip password, just confirm account).
      
      return { success: true };
    } catch (err) {
      console.error(`[MultiTenant] Failed to inject token:`, err.message);
      return { success: false, error: err.message };
    }
  });
  
  // Attach cookie listener to a partition
  ipcMain.handle('multi-tenant:attach-listener', async (event, { partition }) => {
    multiTenantStore.attachCookieListener(partition);
    return { success: true };
  });
  
  // Remove cookie listener (for tab partitions only)
  ipcMain.handle('multi-tenant:remove-listener', async (event, { partition }) => {
    multiTenantStore.removeCookieListener(partition);
    return { success: true };
  });
  
  // Diagnostic: Get cookies from a partition (for SSO debugging)
  ipcMain.handle('multi-tenant:get-cookies', async (event, { partition, name, domain }) => {
    try {
      const ses = session.fromPartition(partition);
      const filter = {};
      if (name) filter.name = name;
      if (domain) filter.domain = domain;
      const cookies = await ses.cookies.get(filter);
      return cookies;
    } catch (err) {
      console.error(`[MultiTenant] Failed to get cookies:`, err.message);
      return [];
    }
  });
  
  // Register partition for refresh propagation
  ipcMain.handle('multi-tenant:register-partition', async (event, { environment, partition }) => {
    multiTenantStore.registerPartition(environment, partition);
    return { success: true };
  });
  
  // Unregister partition when tab closes
  ipcMain.handle('multi-tenant:unregister-partition', async (event, { environment, partition }) => {
    multiTenantStore.unregisterPartition(environment, partition);
    return { success: true };
  });
  
  // Get all environments with valid tokens (for debugging/UI)
  ipcMain.handle('multi-tenant:get-environments', async () => {
    return multiTenantStore.getEnvironmentsWithTokens();
  });
  
  // Get user data for localStorage injection (enables SSO) - async version
  ipcMain.handle('multi-tenant:get-user-data', async (event, environment) => {
    const userData = multiTenantStore.getOrTokenUserData(environment);
    return userData;
  });
  
  // Get user data SYNCHRONOUSLY for preload scripts (critical for SSO timing)
  ipcMain.on('multi-tenant:get-user-data-sync', (event, environment) => {
    const userData = multiTenantStore.getOrTokenUserData(environment);
    event.returnValue = userData;
  });
  
  console.log('[MultiTenant] ✅ All IPC handlers registered');
  
  // ---- ONEREACH AUTO-LOGIN IPC HANDLERS ----
  const credentialManager = require('./credential-manager');
  const { getTOTPManager } = require('./lib/totp-manager');
  const { getQRScanner } = require('./lib/qr-scanner');
  
  // Get OneReach credentials
  ipcMain.handle('onereach:get-credentials', async () => {
    try {
      const creds = await credentialManager.getOneReachCredentials();
      console.log('[OneReach] Get credentials result:', creds ? { email: creds.email, has2FA: creds.has2FA } : null);
      return creds;
    } catch (error) {
      console.error('[OneReach] Failed to get credentials:', error);
      return null;
    }
  });
  
  // Save OneReach credentials
  ipcMain.handle('onereach:save-credentials', async (event, { email, password }) => {
    try {
      console.log('[OneReach] Saving credentials for:', email);
      const success = await credentialManager.saveOneReachCredentials(email, password);
      console.log('[OneReach] Credentials save result:', success);
      return { success };
    } catch (error) {
      console.error('[OneReach] Failed to save credentials:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Delete OneReach credentials
  ipcMain.handle('onereach:delete-credentials', async () => {
    try {
      const success = await credentialManager.deleteOneReachCredentials();
      return { success };
    } catch (error) {
      console.error('[OneReach] Failed to delete credentials:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Save TOTP secret
  ipcMain.handle('onereach:save-totp', async (event, { secret }) => {
    try {
      const totpManager = getTOTPManager();
      
      // Validate the secret by trying to generate a code
      if (!totpManager.isValidSecret(secret)) {
        return { success: false, error: 'Invalid TOTP secret' };
      }
      
      const success = await credentialManager.saveTOTPSecret(secret);
      return { success };
    } catch (error) {
      console.error('[OneReach] Failed to save TOTP:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Delete TOTP secret
  ipcMain.handle('onereach:delete-totp', async () => {
    try {
      const success = await credentialManager.deleteTOTPSecret();
      return { success };
    } catch (error) {
      console.error('[OneReach] Failed to delete TOTP:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Scan QR code from screen
  ipcMain.handle('totp:scan-qr-screen', async () => {
    try {
      const qrScanner = getQRScanner();
      const totpManager = getTOTPManager();
      
      const qrData = await qrScanner.scanFromScreen();
      
      if (!qrData) {
        return { success: false, error: 'No QR code found' };
      }
      
      if (!qrScanner.isOTPAuthURI(qrData)) {
        return { success: false, error: 'QR code is not an authenticator setup code' };
      }
      
      const parsed = totpManager.parseOTPAuthURI(qrData);
      
      return {
        success: true,
        secret: parsed.secret,
        issuer: parsed.issuer,
        account: parsed.account
      };
    } catch (error) {
      console.error('[TOTP] QR scan error:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Get current TOTP code
  ipcMain.handle('totp:get-current-code', async () => {
    try {
      const totpSecret = await credentialManager.getTOTPSecret();
      
      if (!totpSecret) {
        return { success: false, error: 'No TOTP secret configured' };
      }
      
      const totpManager = getTOTPManager();
      const codeInfo = totpManager.getCurrentCodeInfo(totpSecret);
      
      return {
        success: true,
        code: codeInfo.code,
        formattedCode: codeInfo.formattedCode,
        timeRemaining: codeInfo.timeRemaining
      };
    } catch (error) {
      console.error('[TOTP] Failed to get code:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Test login (opens a test window)
  ipcMain.handle('onereach:test-login', async () => {
    try {
      // Open a test IDW window
      const testUrl = 'https://idw.edison.onereach.ai/';
      const { openGSXWindow } = require('./browserWindow');
      openGSXWindow(testUrl);
      return { success: true };
    } catch (error) {
      console.error('[OneReach] Test login error:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Execute JavaScript in webview iframe (for cross-origin auth frames)
  ipcMain.handle('onereach:execute-in-frame', async (event, { webContentsId, urlPattern, script }) => {
    try {
      const { webContents, webFrameMain } = require('electron');
      
      // Get the webContents by ID
      const wc = webContents.fromId(webContentsId);
      if (!wc) {
        console.error('[OneReach] WebContents not found:', webContentsId);
        return { success: false, error: 'WebContents not found' };
      }
      
      console.log(`[OneReach] Looking for frame matching: ${urlPattern}`);
      
      // Get all frames in the webContents
      const mainFrame = wc.mainFrame;
      const allFrames = [mainFrame, ...mainFrame.framesInSubtree];
      
      console.log(`[OneReach] Found ${allFrames.length} frames total`);
      
      // Find frame matching the URL pattern
      let targetFrame = null;
      for (const frame of allFrames) {
        const frameUrl = frame.url;
        console.log(`[OneReach] Frame: ${frameUrl}`);
        if (frameUrl && frameUrl.includes(urlPattern)) {
          targetFrame = frame;
          console.log(`[OneReach] Found matching frame: ${frameUrl}`);
          break;
        }
      }
      
      if (!targetFrame) {
        console.log('[OneReach] No matching frame found');
        return { success: false, error: 'No matching frame found' };
      }
      
      // Execute script in the frame
      console.log('[OneReach] Executing script in frame...');
      const result = await targetFrame.executeJavaScript(script);
      console.log('[OneReach] Script execution result:', result);
      
      return { success: true, result };
    } catch (error) {
      console.error('[OneReach] Execute in frame error:', error);
      return { success: false, error: error.message };
    }
  });
  
  console.log('[OneReach] ✅ Auto-login IPC handlers registered');
  
  // ---- CONVERSATION CAPTURE IPC HANDLERS ----
  
  // Get overlay script content
  ipcMain.handle('get-overlay-script', () => {
    try {
      const fs = require('fs');
      const overlayPath = path.join(__dirname, 'src', 'ai-window-overlay.js');
      return fs.readFileSync(overlayPath, 'utf8');
    } catch (error) {
      console.error('[ConversationCapture] Error reading overlay script:', error);
      return '';
    }
  });
  
  // Check if conversation capture is enabled
  ipcMain.handle('conversation:isEnabled', () => {
    try {
      return conversationCapture?.isEnabled() || false;
    } catch (error) {
      console.error('[ConversationCapture] Error checking enabled:', error);
      return false;
    }
  });
  
  // Check if paused
  ipcMain.handle('conversation:isPaused', () => {
    try {
      return conversationCapture?.isPaused() || false;
    } catch (error) {
      console.error('[ConversationCapture] Error checking paused:', error);
      return false;
    }
  });
  
  // Set pause state
  ipcMain.handle('conversation:setPaused', (event, paused) => {
    try {
      if (conversationCapture) {
        conversationCapture.setPaused(paused);
        return { success: true };
      }
      return { success: false, error: 'Not initialized' };
    } catch (error) {
      console.error('[ConversationCapture] Error setting paused:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Mark current conversation as do not save
  ipcMain.handle('conversation:markDoNotSave', (event, serviceId) => {
    try {
      if (conversationCapture) {
        conversationCapture.markDoNotSave(serviceId);
        return { success: true };
      }
      return { success: false, error: 'Not initialized' };
    } catch (error) {
      console.error('[ConversationCapture] Error marking do not save:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Check if current conversation is marked do not save
  ipcMain.handle('conversation:isMarkedDoNotSave', (event, serviceId) => {
    try {
      return conversationCapture?.isMarkedDoNotSave(serviceId) || false;
    } catch (error) {
      console.error('[ConversationCapture] Error checking do not save:', error);
      return false;
    }
  });
  
  // Get current conversation
  ipcMain.handle('conversation:getCurrent', (event, serviceId) => {
    try {
      return conversationCapture?.getCurrentConversation(serviceId) || null;
    } catch (error) {
      console.error('[ConversationCapture] Error getting current:', error);
      return null;
    }
  });
  
  // Undo save
  ipcMain.handle('conversation:undoSave', async (event, itemId) => {
    try {
      if (conversationCapture) {
        return await conversationCapture.undoSave(itemId);
      }
      return { success: false, error: 'Not initialized' };
    } catch (error) {
      console.error('[ConversationCapture] Error undoing save:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Copy conversation to another space
  ipcMain.handle('conversation:copyToSpace', async (event, conversationId, targetSpaceId) => {
    try {
      if (conversationCapture) {
        return await conversationCapture.copyConversationToSpace(conversationId, targetSpaceId);
      }
      return { success: false, error: 'Not initialized' };
    } catch (error) {
      console.error('[ConversationCapture] Error copying to space:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Handle ChatGPT response captured from fetch interceptor
  ipcMain.on('chatgpt-response-captured', async (event, data) => {
    console.log('[ConversationCapture] Received ChatGPT response from interceptor');
    console.log('[ConversationCapture] Conversation ID:', data.conversationId);
    console.log('[ConversationCapture] Message length:', data.message?.length || 0);
    
    try {
      if (conversationCapture && data.message) {
        await conversationCapture.captureResponse('ChatGPT', {
          message: data.message,
          externalConversationId: data.conversationId,
          timestamp: data.timestamp || new Date().toISOString()
        });
        console.log('[ConversationCapture] ✅ ChatGPT response captured successfully');
      }
    } catch (error) {
      console.error('[ConversationCapture] Error capturing ChatGPT response:', error);
    }
  });
  
  // Handle Grok response captured from fetch interceptor
  ipcMain.on('grok-response-captured', async (event, data) => {
    console.log('[ConversationCapture] Received Grok response from interceptor');
    console.log('[ConversationCapture] Conversation ID:', data.conversationId);
    console.log('[ConversationCapture] Message length:', data.message?.length || 0);
    
    try {
      if (conversationCapture && data.message) {
        await conversationCapture.captureResponse('Grok', {
          message: data.message,
          externalConversationId: data.conversationId,
          timestamp: data.timestamp || new Date().toISOString()
        });
        console.log('[ConversationCapture] ✅ Grok response captured successfully');
      }
    } catch (error) {
      console.error('[ConversationCapture] Error capturing Grok response:', error);
    }
  });
  
  // Handle Gemini response captured from fetch interceptor
  ipcMain.on('gemini-response-captured', async (event, data) => {
    console.log('[ConversationCapture] Received Gemini response from interceptor');
    console.log('[ConversationCapture] Conversation ID:', data.conversationId);
    console.log('[ConversationCapture] Message length:', data.message?.length || 0);
    
    try {
      if (conversationCapture && data.message) {
        await conversationCapture.captureResponse('Gemini', {
          message: data.message,
          externalConversationId: data.conversationId,
          timestamp: data.timestamp || new Date().toISOString()
        });
        console.log('[ConversationCapture] ✅ Gemini response captured successfully');
      }
    } catch (error) {
      console.error('[ConversationCapture] Error capturing Gemini response:', error);
    }
  });
  
  // Get media items for a conversation
  ipcMain.handle('conversation:getMedia', async (event, spaceId, conversationId) => {
    try {
      if (conversationCapture) {
        return await conversationCapture.getConversationMedia(spaceId, conversationId);
      }
      return [];
    } catch (error) {
      console.error('[ConversationCapture] Error getting media:', error);
      return [];
    }
  });
  
  // Headless Claude prompt - Run a prompt in a hidden window
  ipcMain.handle('claude:runHeadlessPrompt', async (event, prompt, options = {}) => {
    try {
      console.log('[IPC] claude:runHeadlessPrompt called');
      if (typeof global.runHeadlessClaudePrompt !== 'function') {
        return { success: false, error: 'runHeadlessClaudePrompt not initialized yet' };
      }
      return await global.runHeadlessClaudePrompt(prompt, options);
    } catch (error) {
      console.error('[IPC] Error in headless Claude prompt:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Unified Claude Service - Headless first, API fallback
  ipcMain.handle('claude:unified-complete', async (event, prompt, options = {}) => {
    try {
      console.log('[IPC] claude:unified-complete called');
      const { getUnifiedClaudeService } = require('./unified-claude');
      const unifiedClaude = getUnifiedClaudeService();
      return await unifiedClaude.complete(prompt, options);
    } catch (error) {
      console.error('[IPC] Error in unified Claude complete:', error);
      return { success: false, error: error.message };
    }
  });
  
  ipcMain.handle('claude:unified-status', async (event) => {
    try {
      const { getUnifiedClaudeService } = require('./unified-claude');
      const unifiedClaude = getUnifiedClaudeService();
      return await unifiedClaude.getStatus();
    } catch (error) {
      console.error('[IPC] Error getting Claude status:', error);
      return { error: error.message };
    }
  });
  
  ipcMain.handle('claude:unified-update-settings', async (event, settings) => {
    try {
      const { getUnifiedClaudeService } = require('./unified-claude');
      const unifiedClaude = getUnifiedClaudeService();
      unifiedClaude.updateSettings(settings);
      return { success: true };
    } catch (error) {
      console.error('[IPC] Error updating Claude settings:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Test support - Only available in test mode
  if (process.env.NODE_ENV === 'test' || process.env.TEST_MODE === 'true') {
    console.log('[ConversationCapture] Registering test-only IPC handlers');
    
    // Test capture - Simulate conversation capture for automated testing
    ipcMain.handle('conversation:test-capture', async (event, data) => {
      try {
        if (!conversationCapture) {
          return { success: false, error: 'ConversationCapture not initialized' };
        }
        
        const { serviceId, conversation } = data;
        
        // Create a new conversation if needed
        if (!conversationCapture.activeConversations.has(serviceId)) {
          conversationCapture.activeConversations.set(serviceId, {
            id: `test-conv-${Date.now()}`,
            serviceId: serviceId,
            startTime: new Date().toISOString(),
            lastActivity: Date.now(),
            messages: [],
            media: [],
            exchangeCount: 0,
            model: conversation.model || 'test-model',
            hasImages: false,
            hasFiles: false,
            hasCode: false,
            doNotSave: false,
            savedItemId: null
          });
        }
        
        // Get the active conversation
        const activeConv = conversationCapture.activeConversations.get(serviceId);
        
        // Add messages
        activeConv.messages.push(...conversation.messages);
        activeConv.exchangeCount = conversation.exchangeCount || Math.floor(conversation.messages.length / 2);
        activeConv.lastActivity = Date.now();
        
        // Save the conversation
        await conversationCapture._saveConversation(serviceId, activeConv);
        
        return { 
          success: true, 
          itemId: activeConv.savedItemId,
          conversationId: activeConv.id 
        };
      } catch (error) {
        console.error('[ConversationCapture] Test capture error:', error);
        return { success: false, error: error.message };
      }
    });
  }
  
  console.log('[ConversationCapture] ✅ IPC handlers registered');
}

// Tab picker window reference
let tabPickerWindow = null;
let tabPickerCallback = null;

// ============================================
// APP ACTIONS IPC - Voice-controlled app navigation
// ============================================

/**
 * Set up App Actions IPC handlers
 * Delegates to centralized action-executor.js
 */
function setupAppActionsIPC() {
  console.log('[AppActions] Setting up IPC handlers (delegating to action-executor)...');
  
  const { executeAction, listActions, setupActionIPC } = require('./action-executor');
  
  // Set up the action executor's IPC handlers
  setupActionIPC();
  
  // Legacy IPC handler for backward compatibility
  ipcMain.handle('app:execute-action', async (event, action) => {
    console.log('[AppActions] Executing action:', action);
    return executeAction(action.type, action);
  });
  
  // Legacy list actions handler
  ipcMain.handle('app:list-actions', async () => {
    return listActions();
  });
  
  console.log('[AppActions] IPC handlers registered');
}

// Set up Tab Picker IPC handlers
function setupTabPickerIPC() {
  // Get API server status
  ipcMain.handle('tab-picker:get-status', async () => {
    const server = global.spacesAPIServer;
    return {
      extensionConnected: server ? server.isExtensionConnected() : false,
      serverRunning: !!server
    };
  });

  // Get tabs from extension
  ipcMain.handle('tab-picker:get-tabs', async () => {
    const server = global.spacesAPIServer;
    if (!server || !server.isExtensionConnected()) {
      throw new Error('Extension not connected');
    }
    return server.getTabs();
  });

  // Capture specific tab
  ipcMain.handle('tab-picker:capture-tab', async (event, tabId) => {
    const server = global.spacesAPIServer;
    if (!server || !server.isExtensionConnected()) {
      throw new Error('Extension not connected');
    }
    return server.captureTab(tabId);
  });

  // Fetch URL as fallback (server-side capture)
  ipcMain.handle('tab-picker:fetch-url', async (event, url) => {
    return fetchUrlContent(url);
  });

  // Handle result from tab picker
  ipcMain.on('tab-picker:result', (event, result) => {
    console.log('[TabPicker] Received result:', result.type);
    if (tabPickerCallback) {
      tabPickerCallback(result);
      tabPickerCallback = null;
    }
  });

  // Close tab picker
  ipcMain.on('tab-picker:close', () => {
    if (tabPickerWindow) {
      tabPickerWindow.close();
      tabPickerWindow = null;
    }
  });

  // Open setup guide
  ipcMain.on('tab-picker:open-setup', () => {
    openExtensionSetupGuide();
  });

  // Handler to open tab picker (called from renderer)
  ipcMain.handle('open-tab-picker', async (event) => {
    return new Promise((resolve) => {
      tabPickerCallback = resolve;
      createTabPickerWindow();
    });
  });

  // Get auth token for setup
  ipcMain.handle('get-extension-auth-token', async () => {
    const server = global.spacesAPIServer;
    return server ? server.getAuthToken() : null;
  });

  console.log('[TabPicker] IPC handlers registered');
}

// Create Tab Picker window
function createTabPickerWindow() {
  if (tabPickerWindow) {
    tabPickerWindow.focus();
    return;
  }

  tabPickerWindow = new BrowserWindow({
    width: 480,
    height: 600,
    minWidth: 380,
    minHeight: 400,
    frame: false,
    transparent: false,
    resizable: true,
    alwaysOnTop: true,
    backgroundColor: '#0d0d14',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-tab-picker.js')
    }
  });

  tabPickerWindow.loadFile('tab-picker.html');

  tabPickerWindow.on('closed', () => {
    tabPickerWindow = null;
    if (tabPickerCallback) {
      tabPickerCallback(null);
      tabPickerCallback = null;
    }
  });
}

// Open extension setup guide window
function openExtensionSetupGuide() {
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

// Fetch URL content server-side (fallback when extension not available)
async function fetchUrlContent(url) {
  return new Promise((resolve, reject) => {
    // Create hidden window to load URL
    const captureWindow = new BrowserWindow({
      width: 1280,
      height: 900,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        offscreen: true
      }
    });

    let resolved = false;

    const cleanup = () => {
      if (!captureWindow.isDestroyed()) {
        captureWindow.close();
      }
    };

    // Timeout after 30 seconds
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error('Timeout loading URL'));
      }
    }, 30000);

    captureWindow.webContents.on('did-finish-load', async () => {
      if (resolved) return;
      
      try {
        // Wait a bit for dynamic content
        await new Promise(r => setTimeout(r, 1000));

        // Capture screenshot
        const image = await captureWindow.webContents.capturePage();
        const screenshot = image.toDataURL();

        // Extract text content
        const textContent = await captureWindow.webContents.executeJavaScript(`
          (function() {
            const article = document.querySelector('article');
            const main = document.querySelector('main');
            const body = document.body;
            const container = article || main || body;
            
            const clone = container.cloneNode(true);
            ['script', 'style', 'nav', 'footer', 'aside', 'header'].forEach(tag => {
              clone.querySelectorAll(tag).forEach(el => el.remove());
            });
            
            let text = clone.textContent || '';
            text = text.replace(/\\s+/g, ' ').trim();
            return text.substring(0, 100000);
          })()
        `);

        const title = await captureWindow.webContents.executeJavaScript('document.title');

        resolved = true;
        clearTimeout(timeout);
        cleanup();

        resolve({
          url,
          title,
          screenshot,
          textContent,
          capturedAt: Date.now()
        });
      } catch (error) {
        resolved = true;
        clearTimeout(timeout);
        cleanup();
        reject(error);
      }
    });

    captureWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`Failed to load: ${errorDescription}`));
      }
    });

    captureWindow.loadURL(url);
  });
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
      const result = await global.moduleManager.addWebTool(tool);
      return { success: true, agentCreated: result.agentCreated || false };
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
      await global.moduleManager.deleteWebTool(toolId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  console.log('[setupModuleManagerIPC] All handlers registered');
}

// Set up Dependency Management IPC handlers
function setupDependencyIPC() {
  console.log('[setupDependencyIPC] Setting up Dependency Management handlers');
  
  const { getDependencyManager } = require('./dependency-manager');
  
  // Check all dependencies
  ipcMain.handle('deps:check-all', async () => {
    try {
      const depManager = getDependencyManager();
      const status = depManager.checkAllDependencies();
      console.log('[DependencyManager] Check result:', status.allInstalled ? 'All installed' : `Missing: ${status.missing.map(d => d.name).join(', ')}`);
      return { success: true, ...status };
    } catch (error) {
      console.error('[DependencyManager] Check failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Install a specific dependency
  ipcMain.handle('deps:install', async (event, depName) => {
    try {
      const depManager = getDependencyManager();
      
      // Stream output back to renderer
      const result = await depManager.installDependency(depName, (output) => {
        event.sender.send('deps:install-output', { depName, ...output });
      });
      
      return { success: true, ...result };
    } catch (error) {
      console.error('[DependencyManager] Install failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Install all missing dependencies
  ipcMain.handle('deps:install-all', async (event) => {
    try {
      const depManager = getDependencyManager();
      
      // Stream output back to renderer
      const result = await depManager.installAllMissing((output) => {
        event.sender.send('deps:install-output', output);
      });
      
      return { success: result.allSuccessful, ...result };
    } catch (error) {
      console.error('[DependencyManager] Install all failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Cancel an ongoing installation
  ipcMain.handle('deps:cancel-install', async (event, depName) => {
    try {
      const depManager = getDependencyManager();
      const cancelled = depManager.cancelInstall(depName);
      return { success: true, cancelled };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Get the aider Python path
  ipcMain.handle('deps:get-aider-python', async () => {
    try {
      const depManager = getDependencyManager();
      const pythonPath = depManager.getAiderPythonPath();
      return { success: true, pythonPath };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  console.log('[setupDependencyIPC] All handlers registered');
}

// Set up Aider Bridge IPC handlers
function setupAiderIPC() {
  console.log('[setupAiderIPC] Setting up Aider Bridge handlers');
  
  // Start Aider
  ipcMain.handle('aider:start', async () => {
    try {
      if (!aiderBridge) {
        // Get API key from settings
        const { getSettingsManager } = require('./settings-manager');
        const settings = getSettingsManager();
        const apiKey = settings.getLLMApiKey();
        const provider = settings.getLLMProvider();
        
        console.log(`[Aider] Starting with provider: ${provider}, API key present: ${!!apiKey}`);
        
        // Find the correct Python path - check pipx first, then system python
        const { execSync } = require('child_process');
        const os = require('os');
        let pythonPath = 'python3';
        
        // Check for pipx aider installation
        const pipxAiderPython = path.join(os.homedir(), '.local', 'pipx', 'venvs', 'aider-chat', 'bin', 'python');
        if (fs.existsSync(pipxAiderPython)) {
          console.log('[Aider] Found pipx aider installation at:', pipxAiderPython);
          pythonPath = pipxAiderPython;
        } else {
          // Check if system python has aider
          try {
            execSync('python3 -c "import aider"', { encoding: 'utf-8', stdio: 'pipe' });
            console.log('[Aider] Using system python3 with aider');
          } catch (e) {
            // Try to find aider command and extract its Python
            try {
              const aiderPath = execSync('which aider', { encoding: 'utf-8' }).trim();
              if (aiderPath) {
                const aiderScript = fs.readFileSync(aiderPath, 'utf-8');
                const shebangMatch = aiderScript.match(/^#!(.+)$/m);
                if (shebangMatch && shebangMatch[1]) {
                  const extractedPython = shebangMatch[1].trim();
                  if (fs.existsSync(extractedPython)) {
                    console.log('[Aider] Extracted Python from aider shebang:', extractedPython);
                    pythonPath = extractedPython;
                  }
                }
              }
            } catch (e2) {
              console.log('[Aider] Could not find aider command, using python3');
            }
          }
        }
        
        console.log('[Aider] Using Python path:', pythonPath);
        aiderBridge = new AiderBridgeClient(pythonPath, apiKey, provider);
        await aiderBridge.start();
        console.log('[Aider] Bridge started successfully');
      }
      return { success: true };
    } catch (error) {
      console.error('[Aider] Failed to start:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Initialize with repo
  ipcMain.handle('aider:initialize', async (event, repoPath, modelName) => {
    try {
      if (!aiderBridge) {
        throw new Error('Aider not started');
      }
      // GSX Create should honor the selected model; default to Claude Opus 4.5 if none provided.
      const result = await aiderBridge.initialize(repoPath, modelName || 'claude-opus-4-5-20250929');
      console.log('[Aider] Initialized:', result);
      return result;
    } catch (error) {
      console.error('[Aider] Initialize failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Run prompt
  ipcMain.handle('aider:run-prompt', async (event, message) => {
    try {
      if (!aiderBridge) {
        throw new Error('Aider not started');
      }
      console.log('[Aider] Running prompt:', message.substring(0, 100) + '...');
      const result = await aiderBridge.runPrompt(message);
      console.log('[Aider] Prompt result:', result.success ? 'Success' : 'Failed');
      return result;
    } catch (error) {
      console.error('[Aider] Run prompt failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // ========== HUD ACTIVITY BROADCASTING ==========
  // Helper to broadcast HUD activity updates to all windows
  function broadcastHUDActivity(data) {
    const { BrowserWindow } = require('electron');
    BrowserWindow.getAllWindows().forEach(win => {
      if (win && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('hud:activity', data);
      }
    });
  }
  
  // Expose broadcast function globally for Agent to use
  global.broadcastHUDActivity = broadcastHUDActivity;
  
  // Run prompt with streaming
  ipcMain.handle('aider:run-prompt-streaming', async (event, message, channel) => {
    try {
      if (!aiderBridge) {
        throw new Error('Aider not started');
      }
      console.log('[Aider] Running streaming prompt:', message.substring(0, 100) + '...');
      
      // Broadcast HUD: stream starting
      broadcastHUDActivity({
        type: 'aider',
        phase: 'Execute',
        action: 'Processing prompt...',
        task: message.substring(0, 60) + (message.length > 60 ? '...' : '')
      });
      
      let currentFile = null;
      let tokenBuffer = '';
      
      const result = await aiderBridge.runPromptStreaming(message, (token) => {
        event.sender.send(channel, { type: 'token', token });
        
        // Accumulate tokens to detect patterns
        tokenBuffer += token;
        
        // Detect file being edited from SEARCH/REPLACE blocks
        const fileMatch = tokenBuffer.match(/(?:<<<<<<< SEARCH|SEARCH\/REPLACE)\s*(?:in\s+)?([^\n]+\.[a-zA-Z]+)/i);
        if (fileMatch && fileMatch[1] !== currentFile) {
          currentFile = fileMatch[1].trim();
          broadcastHUDActivity({
            type: 'aider',
            action: 'Writing code...',
            file: currentFile
          });
        }
        
        // Detect file writes
        const wroteMatch = token.match(/(?:Wrote|Applied edit to)\s+([^\s\n]+)/);
        if (wroteMatch) {
          broadcastHUDActivity({
            type: 'aider',
            action: 'File saved',
            file: wroteMatch[1],
            recent: `Updated ${wroteMatch[1].split('/').pop()}`
          });
        }
        
        // Keep buffer manageable
        if (tokenBuffer.length > 2000) {
          tokenBuffer = tokenBuffer.slice(-1000);
        }
      });
      
      // Broadcast HUD: complete
      broadcastHUDActivity({
        type: 'aider',
        action: 'Complete!',
        phase: 'Execute'
      });
      
      event.sender.send(channel, { type: 'done', result });
      return result;
    } catch (error) {
      console.error('[Aider] Streaming prompt failed:', error);
      
      // Broadcast HUD: error
      broadcastHUDActivity({
        type: 'aider',
        action: 'Error: ' + error.message.substring(0, 40),
        phase: 'Execute'
      });
      
      event.sender.send(channel, { type: 'error', error: error.message });
      return { success: false, error: error.message };
    }
  });
  
  // Add files
  ipcMain.handle('aider:add-files', async (event, filePaths) => {
    try {
      if (!aiderBridge) {
        throw new Error('Aider not started');
      }
      const result = await aiderBridge.addFiles(filePaths);
      console.log('[Aider] Added files:', result);
      return result;
    } catch (error) {
      console.error('[Aider] Add files failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Remove files
  ipcMain.handle('aider:remove-files', async (event, filePaths) => {
    try {
      if (!aiderBridge) {
        throw new Error('Aider not started');
      }
      const result = await aiderBridge.removeFiles(filePaths);
      console.log('[Aider] Removed files:', result);
      return result;
    } catch (error) {
      console.error('[Aider] Remove files failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Get repo map
  ipcMain.handle('aider:get-repo-map', async () => {
    try {
      if (!aiderBridge) {
        throw new Error('Aider not started');
      }
      const result = await aiderBridge.getRepoMap();
      console.log('[Aider] Got repo map');
      return result;
    } catch (error) {
      console.error('[Aider] Get repo map failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Set test command
  ipcMain.handle('aider:set-test-cmd', async (event, command) => {
    try {
      if (!aiderBridge) {
        throw new Error('Aider not started');
      }
      const result = await aiderBridge.setTestCmd(command);
      console.log('[Aider] Set test command:', result);
      return result;
    } catch (error) {
      console.error('[Aider] Set test command failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Set lint command
  ipcMain.handle('aider:set-lint-cmd', async (event, command) => {
    try {
      if (!aiderBridge) {
        throw new Error('Aider not started');
      }
      const result = await aiderBridge.setLintCmd(command);
      console.log('[Aider] Set lint command:', result);
      return result;
    } catch (error) {
      console.error('[Aider] Set lint command failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Shutdown Aider
  ipcMain.handle('aider:shutdown', async () => {
    try {
      if (aiderBridge) {
        await aiderBridge.shutdown();
        aiderBridge = null;
        console.log('[Aider] Shutdown complete');
      }
      return { success: true };
    } catch (error) {
      console.error('[Aider] Shutdown failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Get app path
  ipcMain.handle('aider:get-app-path', async () => {
    return app.getAppPath();
  });
  
  // Select folder dialog
  ipcMain.handle('aider:select-folder', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    });
    if (result.canceled) {
      return null;
    }
    return result.filePaths[0];
  });
  
  // Create a new space
  ipcMain.handle('aider:create-space', async (event, name) => {
    try {
      const spacesDir = path.join(app.getPath('userData'), 'spaces');
      const spaceId = `space-${Date.now()}`;
      const spacePath = path.join(spacesDir, spaceId);
      
      fs.mkdirSync(spacePath, { recursive: true });
      
      // Create initial metadata
      const metadata = {
        id: spaceId,
        name: name || 'New Space',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      fs.writeFileSync(
        path.join(spacePath, 'space-metadata.json'),
        JSON.stringify(metadata, null, 2)
      );
      
      console.log('[Aider] Created space:', spaceId);
      return { success: true, spaceId, spacePath };
    } catch (error) {
      console.error('[Aider] Create space failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Initialize the Branch Aider Manager for parallel exploration
  ipcMain.handle('aider:init-branch-manager', async (event, spacePath) => {
    try {
      // Create the branch manager instance
      branchAiderManager = new BranchAiderManager();
      
      // Call initialize() to set up the logs directory
      await branchAiderManager.initialize(spacePath);
      
      console.log('[BranchManager] Initialized for space:', spacePath);
      return { success: true, logsDir: branchAiderManager.logsDir };
    } catch (error) {
      console.error('[BranchManager] Init failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Initialize a branch-specific Aider instance
  ipcMain.handle('aider:init-branch', async (event, branchPath, branchId, model, readOnlyFiles) => {
    try {
      console.log('[BranchManager] init-branch called with:', {
        branchPath: branchPath || '<null>',
        branchId: branchId || '<null>',
        model: model || '<null>',
        readOnlyFiles: readOnlyFiles?.length || 0
      });
      
      if (!branchAiderManager) {
        throw new Error('Branch manager not initialized. Call init-branch-manager first.');
      }
      
      const result = await branchAiderManager.initBranch(branchPath, branchId, model, readOnlyFiles);
      return result;
    } catch (error) {
      console.error('[BranchManager] Init branch failed:', error);
      console.error('[BranchManager] Failed params:', { branchPath, branchId, model });
      return { success: false, error: error.message };
    }
  });
  
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
  ipcMain.handle('aider:evaluate', async (event, arg1, arg2, arg3) => {
    // Support both old style (systemPrompt, userPrompt, model) and new style ({ systemPrompt, userPrompt, image, model, maxTokens })
    let systemPrompt, userPrompt, modelName, imageBase64, maxTokens;
    
    if (typeof arg1 === 'object' && arg1 !== null) {
      // New object-style call
      systemPrompt = arg1.systemPrompt;
      userPrompt = arg1.userPrompt;
      modelName = arg1.model;
      imageBase64 = arg1.image;
      maxTokens = arg1.maxTokens || 4096;
    } else {
      // Old positional style call
      systemPrompt = arg1;
      userPrompt = arg2;
      modelName = arg3;
      maxTokens = 4096;
    }
    
    console.log('[GSX Create] Evaluation request received, model:', modelName, 'hasImage:', !!imageBase64);
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
      let model = modelName || 'claude-opus-4-5-20251101';
      
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
        
        // Build the user message content - support both text-only and image+text
        let userContent;
        if (imageBase64) {
          // Vision request with image
          // Remove data URL prefix if present (e.g., "data:image/png;base64,")
          let imageData = imageBase64;
          if (imageBase64.includes(',')) {
            imageData = imageBase64.split(',')[1];
          }
          
          userContent = [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: imageData
              }
            },
            {
              type: 'text',
              text: userPrompt || 'Analyze this image.'
            }
          ];
          console.log('[GSX Create] Including image in request (vision mode)');
        } else {
          // Text-only request
          userContent = userPrompt;
        }
        
        const requestBody = {
          model: model,
          max_tokens: maxTokens || 4096,
          system: systemPrompt || 'You are a helpful assistant.',
          messages: [
            { role: 'user', content: userContent }
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

  // ============================================
  // DESIGN-FIRST WORKFLOW - UI Mockup Generation
  // ============================================

  // Generate 4 design mockup choices using DALL-E 3
  ipcMain.handle('design:generate-choices', async (event, { objective, approaches }) => {
    console.log('[Design] Generating 4 design choices for:', objective?.substring(0, 50));
    
    try {
      const { getSettingsManager } = require('./settings-manager');
      const settings = getSettingsManager();
      const openaiKey = settings.get('openaiApiKey');
      
      if (!openaiKey) {
        throw new Error('OpenAI API key required for design generation. Please add it in Settings.');
      }
      
      const https = require('https');
      
      // Generate image with better error handling
      const generateImage = async (approach, attemptNum = 1) => {
        const maxRetries = 2;
        
        return new Promise((resolve, reject) => {
          const requestBody = JSON.stringify({
            model: 'dall-e-3',
            prompt: approach.prompt,
            n: 1,
            size: '1024x1024',
            quality: 'standard', // standard for faster generation, hd for final
            response_format: 'b64_json'
          });
          
          console.log(`[Design] Starting image generation for ${approach.id} (attempt ${attemptNum})`);
          
          const req = https.request({
            hostname: 'api.openai.com',
            path: '/v1/images/generations',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${openaiKey}`,
              'Content-Length': Buffer.byteLength(requestBody)
            },
            timeout: 120000 // 2 minute timeout for image generation
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                const response = JSON.parse(data);
                
                // Log response status
                console.log(`[Design] Response for ${approach.id}: status=${res.statusCode}`);
                
                if (response.error) {
                  const errorMsg = response.error.message || JSON.stringify(response.error);
                  console.error(`[Design] OpenAI API error for ${approach.id}:`, errorMsg);
                  
                  // Rate limit handling - retry after delay
                  if (res.statusCode === 429 && attemptNum < maxRetries) {
                    console.log(`[Design] Rate limited, will retry ${approach.id} after delay...`);
                    setTimeout(() => {
                      generateImage(approach, attemptNum + 1).then(resolve).catch(reject);
                    }, 10000); // Wait 10 seconds before retry
                    return;
                  }
                  
                  reject(new Error(errorMsg));
                  return;
                }
                
                if (response.data && response.data[0]) {
                  console.log(`[Design] Successfully generated image for ${approach.id}`);
                  
                  // Track DALL-E usage for cost monitoring
                  // DALL-E 3 1024x1024 standard = $0.04 per image
                  try {
                    if (budgetManager) {
                      budgetManager.trackUsage({
                        provider: 'openai',
                        model: 'dall-e-3',
                        inputTokens: 0,
                        outputTokens: 0,
                        feature: 'design-generation',
                        operation: 'generate-image',
                        projectId: null,
                        // DALL-E pricing is per-image, not per-token
                        metadata: {
                          imageCount: 1,
                          size: '1024x1024',
                          quality: 'standard',
                          costPerImage: 0.04
                        }
                      });
                    }
                  } catch (trackError) {
                    console.warn('[Design] Failed to track usage:', trackError.message);
                  }
                  
                  resolve({
                    id: approach.id,
                    name: approach.name,
                    icon: approach.icon,
                    description: approach.description,
                    imageData: `data:image/png;base64,${response.data[0].b64_json}`,
                    prompt: approach.prompt,
                    revisedPrompt: response.data[0].revised_prompt // DALL-E 3 sometimes modifies prompts
                  });
                } else {
                  console.error(`[Design] No image data in response for ${approach.id}:`, JSON.stringify(response).substring(0, 200));
                  reject(new Error('No image data in response'));
                }
              } catch (e) {
                console.error(`[Design] Parse error for ${approach.id}:`, e.message);
                reject(new Error('Failed to parse response: ' + e.message));
              }
            });
          });
          
          req.on('timeout', () => {
            req.destroy();
            console.error(`[Design] Request timeout for ${approach.id}`);
            reject(new Error('Request timeout - image generation took too long'));
          });
          
          req.on('error', (err) => {
            console.error(`[Design] Network error for ${approach.id}:`, err.message);
            reject(new Error('Network error: ' + err.message));
          });
          
          req.write(requestBody);
          req.end();
        });
      };
      
      // Generate images - stagger requests to avoid rate limits
      console.log('[Design] Generating 4 design images with DALL-E 3...');
      const startTime = Date.now();
      
      // Generate with staggered start times to reduce rate limit issues
      const staggeredGenerate = async () => {
        const results = [];
        for (let i = 0; i < approaches.length; i++) {
          // Small delay between requests to avoid rate limits
          if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          
          const approach = approaches[i];
          console.log(`[Design] Generating design ${i + 1}/4: ${approach.id}`);
          
          try {
            const result = await generateImage(approach);
            results.push({ status: 'fulfilled', value: result });
          } catch (error) {
            results.push({ status: 'rejected', reason: error });
          }
        }
        return results;
      };
      
      const results = await staggeredGenerate();
      
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const successCount = results.filter(r => r.status === 'fulfilled').length;
      console.log(`[Design] Generated ${successCount}/4 images in ${elapsed}s`);
      
      // Return successful generations, with placeholders for failures
      const designs = results.map((result, index) => {
        if (result.status === 'fulfilled') {
          return result.value;
        } else {
          console.error('[Design] Failed to generate', approaches[index].id, ':', result.reason);
          return {
            id: approaches[index].id,
            name: approaches[index].name,
            icon: approaches[index].icon,
            description: approaches[index].description,
            error: result.reason.message,
            imageData: null
          };
        }
      });
      
      return { success: true, designs };
      
    } catch (error) {
      console.error('[Design] Generation failed:', error);
      return { success: false, error: error.message };
    }
  });

  // Regenerate a single design mockup
  ipcMain.handle('design:regenerate-single', async (event, { approach }) => {
    console.log('[Design] Regenerating single design:', approach.id);
    
    try {
      const { getSettingsManager } = require('./settings-manager');
      const settings = getSettingsManager();
      const openaiKey = settings.get('openaiApiKey');
      
      if (!openaiKey) {
        throw new Error('OpenAI API key required');
      }
      
      const https = require('https');
      
      const requestBody = JSON.stringify({
        model: 'dall-e-3',
        prompt: approach.prompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
        response_format: 'b64_json'
      });
      
      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.openai.com',
          path: '/v1/images/generations',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openaiKey}`,
            'Content-Length': Buffer.byteLength(requestBody)
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const response = JSON.parse(data);
              if (response.error) {
                reject(new Error(response.error.message));
                return;
              }
              if (response.data && response.data[0]) {
                // Track DALL-E usage for cost monitoring
                try {
                  if (budgetManager) {
                    budgetManager.trackUsage({
                      provider: 'openai',
                      model: 'dall-e-3',
                      inputTokens: 0,
                      outputTokens: 0,
                      feature: 'design-generation',
                      operation: 'regenerate-image',
                      projectId: null,
                      metadata: {
                        imageCount: 1,
                        size: '1024x1024',
                        quality: 'standard',
                        costPerImage: 0.04
                      }
                    });
                  }
                } catch (trackError) {
                  console.warn('[Design] Failed to track usage:', trackError.message);
                }
                
                resolve({
                  id: approach.id,
                  name: approach.name,
                  icon: approach.icon,
                  description: approach.description,
                  imageData: `data:image/png;base64,${response.data[0].b64_json}`,
                  prompt: approach.prompt
                });
              } else {
                reject(new Error('No image data in response'));
              }
            } catch (e) {
              reject(new Error('Failed to parse response'));
            }
          });
        });
        
        req.on('error', reject);
        req.write(requestBody);
        req.end();
      });
      
      return { success: true, design: result };
      
    } catch (error) {
      console.error('[Design] Regeneration failed:', error);
      return { success: false, error: error.message };
    }
  });

  // Extract design tokens from selected mockup image (two-pass approach)
  ipcMain.handle('design:extract-tokens', async (event, { imageData }) => {
    console.log('[Design] Extracting design tokens from mockup...');
    
    try {
      const { getSettingsManager } = require('./settings-manager');
      const settings = getSettingsManager();
      const apiKey = settings.getLLMApiKey();
      
      if (!apiKey) {
        throw new Error('Anthropic API key required for design analysis');
      }
      
      const https = require('https');
      const { getStylePromptGenerator } = require('./style-prompt-generator');
      const styleGen = getStylePromptGenerator();
      
      // Get the extraction prompt
      const extractionPrompt = styleGen.getDesignTokenExtractionPrompt();
      
      // Extract base64 from data URL
      let base64Data = imageData;
      let mediaType = 'image/png';
      if (imageData.startsWith('data:')) {
        const matches = imageData.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          mediaType = matches[1];
          base64Data = matches[2];
        }
      }
      
      const requestBody = JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Data
              }
            },
            {
              type: 'text',
              text: extractionPrompt
            }
          ]
        }]
      });
      
      const response = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(requestBody)
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('Failed to parse response'));
            }
          });
        });
        
        req.on('error', reject);
        req.write(requestBody);
        req.end();
      });
      
      if (response.error) {
        throw new Error(response.error.message);
      }
      
      // Extract JSON from Claude's response
      const content = response.content?.[0]?.text;
      if (!content) {
        throw new Error('No content in response');
      }
      
      // Parse the JSON tokens
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Could not find JSON in response');
      }
      
      const tokens = JSON.parse(jsonMatch[0]);
      console.log('[Design] Extracted design tokens:', Object.keys(tokens));
      
      return { success: true, tokens };
      
    } catch (error) {
      console.error('[Design] Token extraction failed:', error);
      return { success: false, error: error.message };
    }
  });

  // Generate code from design using two-pass approach
  ipcMain.handle('design:generate-code', async (event, { objective, imageData, tokens, options = {} }) => {
    console.log('[Design] Generating code from design mockup...');
    
    try {
      const { getSettingsManager } = require('./settings-manager');
      const settings = getSettingsManager();
      const apiKey = settings.getLLMApiKey();
      
      if (!apiKey) {
        throw new Error('Anthropic API key required');
      }
      
      const https = require('https');
      const { getStylePromptGenerator } = require('./style-prompt-generator');
      const styleGen = getStylePromptGenerator();
      
      // Get the code generation prompt with tokens
      const codePrompt = styleGen.getCodeFromDesignPrompt(objective, tokens, options);
      
      // Extract base64 from data URL
      let base64Data = imageData;
      let mediaType = 'image/png';
      if (imageData.startsWith('data:')) {
        const matches = imageData.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          mediaType = matches[1];
          base64Data = matches[2];
        }
      }
      
      const requestBody = JSON.stringify({
        model: 'claude-opus-4-5-20251101', // Use Opus for code generation
        max_tokens: 8000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Data
              }
            },
            {
              type: 'text',
              text: codePrompt
            }
          ]
        }]
      });
      
      console.log('[Design] Calling Claude Opus for code generation...');
      
      const response = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(requestBody)
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('Failed to parse response'));
            }
          });
        });
        
        req.on('error', reject);
        req.write(requestBody);
        req.end();
      });
      
      if (response.error) {
        throw new Error(response.error.message);
      }
      
      const content = response.content?.[0]?.text;
      if (!content) {
        throw new Error('No content in response');
      }
      
      // Extract HTML code from response
      let code = content;
      
      // Try to extract just the HTML if it's wrapped in markdown
      const htmlMatch = content.match(/```html\s*([\s\S]*?)```/);
      if (htmlMatch) {
        code = htmlMatch[1].trim();
      } else {
        // Check if it starts with <!DOCTYPE or <html
        const docMatch = content.match(/(<!DOCTYPE[\s\S]*|<html[\s\S]*)/i);
        if (docMatch) {
          code = docMatch[1].trim();
        }
      }
      
      console.log('[Design] Code generated, length:', code.length);
      
      return { success: true, code };
      
    } catch (error) {
      console.error('[Design] Code generation failed:', error);
      return { success: false, error: error.message };
    }
  });

  // Get design approaches (for UI to display options)
  ipcMain.handle('design:get-approaches', async (event, { objective, options = {} }) => {
    try {
      const { getStylePromptGenerator } = require('./style-prompt-generator');
      const styleGen = getStylePromptGenerator();
      const approaches = styleGen.generateDesignApproaches(objective, options);
      return { success: true, approaches };
    } catch (error) {
      console.error('[Design] Failed to get approaches:', error);
      return { success: false, error: error.message };
    }
  });
  
  // ========== MULTI-AGENT DIRECT API CALL ==========
  // Direct AI call for parallel Q&A and agent operations (bypasses Aider bridge)
  ipcMain.handle('ai:direct-call', async (event, { model, messages, max_tokens, response_format }) => {
    console.log('[MultiAgent] Direct API call:', model, 'messages:', messages?.length);
    
    try {
      const { getSettingsManager } = require('./settings-manager');
      const settings = getSettingsManager();
      const https = require('https');
      
      // Determine which API to use based on model
      const isOpenAI = model.startsWith('gpt-') || model.includes('o1') || model.includes('o3');
      const isClaude = model.startsWith('claude');
      
      if (isOpenAI) {
        const openaiKey = settings.get('openaiApiKey');
        if (!openaiKey) {
          throw new Error('OpenAI API key required. Please add it in Settings.');
        }
        
        const requestBody = {
          model: model,
          messages: messages,
          max_tokens: max_tokens || 2000
        };
        
        if (response_format) {
          requestBody.response_format = response_format;
        }
        
        const result = await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: 'api.openai.com',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${openaiKey}`
            }
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                if (parsed.error) {
                  reject(new Error(parsed.error.message || 'OpenAI API error'));
                } else {
                  resolve(parsed);
                }
              } catch (e) {
                reject(new Error('Failed to parse OpenAI response'));
              }
            });
          });
          
          req.on('error', reject);
          req.setTimeout(120000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
          });
          
          req.write(JSON.stringify(requestBody));
          req.end();
        });
        
        return {
          success: true,
          content: result.choices[0].message.content,
          usage: result.usage,
          model: result.model
        };
        
      } else if (isClaude) {
        const anthropicKey = settings.getLLMApiKey();
        if (!anthropicKey) {
          throw new Error('Anthropic API key required. Please add it in Settings.');
        }
        
        const requestBody = {
          model: model,
          max_tokens: max_tokens || 2000,
          messages: messages.filter(m => m.role !== 'system').map(m => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content
          }))
        };
        
        // Add system prompt if present
        const systemMsg = messages.find(m => m.role === 'system');
        if (systemMsg) {
          requestBody.system = systemMsg.content;
        }
        
        const result = await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01'
            }
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                if (parsed.error) {
                  reject(new Error(parsed.error.message || 'Anthropic API error'));
                } else {
                  resolve(parsed);
                }
              } catch (e) {
                reject(new Error('Failed to parse Anthropic response'));
              }
            });
          });
          
          req.on('error', reject);
          req.setTimeout(120000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
          });
          
          req.write(JSON.stringify(requestBody));
          req.end();
        });
        
        return {
          success: true,
          content: result.content[0].text,
          usage: result.usage,
          model: result.model
        };
        
      } else {
        throw new Error(`Unsupported model: ${model}. Use gpt-* or claude-* models.`);
      }
      
    } catch (error) {
      console.error('[MultiAgent] Direct API call error:', error);
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
      const fs = require('fs');
      
      if (!repoPath || !branchName) {
        return { success: false, error: 'Missing required parameters' };
      }
      
      // Check if directory exists and is a git repo
      const gitDir = require('path').join(repoPath, '.git');
      const isGitRepo = fs.existsSync(gitDir);
      
      // Sanitize branch name - replace spaces and special chars with dashes
      const safeBranchName = branchName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
      const safeBaseBranch = baseBranch.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
      
      
      // Create and switch to new branch (using quotes for safety)
      execSync(`git checkout -b "${safeBranchName}" "${safeBaseBranch}"`, { 
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
  
  // Create an orphan branch (starts from scratch with no files)
  ipcMain.handle('aider:git-create-orphan-branch', async (event, repoPath, branchName) => {
    try {
      const { execSync } = require('child_process');
      const fs = require('fs');
      const path = require('path');
      
      if (!repoPath || !branchName) {
        return { success: false, error: 'Missing required parameters' };
      }
      
      // Sanitize branch name
      const safeBranchName = branchName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
      
      // Create orphan branch (no parent commits, empty tree)
      execSync(`git checkout --orphan "${safeBranchName}"`, { 
        cwd: repoPath,
        encoding: 'utf-8'
      });
      
      // Remove all files from the index (but not .git)
      execSync('git rm -rf --cached .', { 
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'] // Suppress errors if no files
      });
      
      // Remove all files from working directory except .git
      const files = fs.readdirSync(repoPath);
      for (const file of files) {
        if (file === '.git') continue;
        const filePath = path.join(repoPath, file);
        fs.rmSync(filePath, { recursive: true, force: true });
      }
      
      // Create initial commit so the branch is valid
      execSync('git commit --allow-empty -m "Initial empty branch"', { 
        cwd: repoPath,
        encoding: 'utf-8'
      });
      
      console.log('[GSX Create] Orphan branch created:', branchName);
      return { success: true, branch: branchName };
      
    } catch (error) {
      console.error('[GSX Create] Git create orphan branch failed:', error);
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
  
  // Merge a branch into target branch (typically main)
  ipcMain.handle('aider:git-merge-branch', async (event, repoPath, sourceBranch, targetBranch = 'main') => {
    try {
      const { execSync } = require('child_process');
      
      if (!repoPath || !sourceBranch) {
        return { success: false, error: 'Missing required parameters' };
      }
      
      // Sanitize branch names
      const safeSourceBranch = sourceBranch.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
      const safeTargetBranch = targetBranch.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
      
      // Get current branch to restore later if needed
      const currentBranch = execSync('git branch --show-current', { 
        cwd: repoPath,
        encoding: 'utf-8'
      }).trim();
      
      // Switch to target branch
      execSync(`git checkout "${safeTargetBranch}"`, { 
        cwd: repoPath,
        encoding: 'utf-8'
      });
      
      // Merge source branch into target
      try {
        execSync(`git merge "${safeSourceBranch}" -m "Merge branch '${safeSourceBranch}' into ${safeTargetBranch}"`, { 
          cwd: repoPath,
          encoding: 'utf-8'
        });
      } catch (mergeError) {
        // Check if it's a merge conflict
        if (mergeError.message && mergeError.message.includes('CONFLICT')) {
          // Abort the merge
          execSync('git merge --abort', { cwd: repoPath, encoding: 'utf-8' });
          // Switch back to original branch
          if (currentBranch && currentBranch !== safeTargetBranch) {
            execSync(`git checkout "${currentBranch}"`, { cwd: repoPath, encoding: 'utf-8' });
          }
          return { 
            success: false, 
            error: 'Merge conflict detected. Please resolve conflicts manually or use a different merge strategy.',
            hasConflict: true 
          };
        }
        throw mergeError;
      }
      
      console.log('[GSX Create] Merged branch:', sourceBranch, 'into', targetBranch);
      return { success: true, sourceBranch, targetBranch };
      
    } catch (error) {
      console.error('[GSX Create] Git merge failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Get merge preview (files that will change)
  ipcMain.handle('aider:git-merge-preview', async (event, repoPath, sourceBranch, targetBranch = 'main') => {
    try {
      const { execSync } = require('child_process');
      
      if (!repoPath || !sourceBranch) {
        return { success: false, error: 'Missing required parameters' };
      }
      
      // Get list of files that differ between branches
      const diffStat = execSync(`git diff --stat ${targetBranch}..${sourceBranch}`, { 
        cwd: repoPath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024
      });
      
      // Get commit count difference
      const commitCount = execSync(`git rev-list --count ${targetBranch}..${sourceBranch}`, { 
        cwd: repoPath,
        encoding: 'utf-8'
      }).trim();
      
      // Get list of changed files
      const changedFiles = execSync(`git diff --name-only ${targetBranch}..${sourceBranch}`, { 
        cwd: repoPath,
        encoding: 'utf-8'
      }).trim().split('\n').filter(f => f);
      
      return { 
        success: true, 
        diffStat, 
        commitCount: parseInt(commitCount) || 0,
        changedFiles 
      };
      
    } catch (error) {
      console.error('[GSX Create] Git merge preview failed:', error);
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
        await global.clipboardManager.addToHistory(item);
        console.log(`[GSX Create] Registered file via clipboard manager: ${fileName} in space ${spaceId}`);
      } else {
        // Fallback to direct storage if clipboard manager not available
        // WARNING: This bypasses in-memory sync and space metadata updates
        console.warn('[GSX Create] clipboardManager not available, using direct storage (may cause sync issues)');
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
          await global.clipboardManager.addToHistory(item);
        } else {
          // WARNING: This bypasses in-memory sync and space metadata updates
          console.warn('[GSX Create] clipboardManager not available, using direct storage (may cause sync issues)');
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
      
      // Navigate to the file (cross-platform compatible)
      const fileUrl = filePath.startsWith('file://') ? filePath : pathToFileURL(filePath).href;
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
  
  // Initialize Dependency Management handlers (before Aider so we can check deps first)
  setupDependencyIPC();
  
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
  // PROTECTION: We backup important JSON config files before clearing storage
  ipcMain.on('clear-cache-and-reload', async (event, options = {}) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) {
        const clearStorage = !!options.clearStorage;
        if (clearStorage) {
          // PROTECTION: Backup important JSON files before clearing storage
          // These files contain user's third-party AI tools, IDW environments, etc.
          const userDataPath = app.getPath('userData');
          const filesToProtect = [
            'external-bots.json',
            'image-creators.json', 
            'video-creators.json',
            'audio-generators.json',
            'ui-design-tools.json',
            'web-tools.json',
            'idw-entries.json',
            'gsx-links.json'
          ];
          
          for (const filename of filesToProtect) {
            const filePath = path.join(userDataPath, filename);
            const backupPath = path.join(userDataPath, filename + '.protect-backup');
            if (fs.existsSync(filePath)) {
              try {
                fs.copyFileSync(filePath, backupPath);
                console.log(`[IPC] Protected backup created: ${filename}`);
              } catch (e) {
                console.warn(`[IPC] Could not backup ${filename}:`, e.message);
              }
            }
          }
          
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
          
          // PROTECTION: Restore backups if original files were affected
          for (const filename of filesToProtect) {
            const filePath = path.join(userDataPath, filename);
            const backupPath = path.join(userDataPath, filename + '.protect-backup');
            if (fs.existsSync(backupPath) && !fs.existsSync(filePath)) {
              try {
                fs.copyFileSync(backupPath, filePath);
                console.log(`[IPC] Restored from backup: ${filename}`);
              } catch (e) {
                console.warn(`[IPC] Could not restore ${filename}:`, e.message);
              }
            }
            // Clean up backup
            if (fs.existsSync(backupPath)) {
              try { fs.unlinkSync(backupPath); } catch (e) {}
            }
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

  // IPC ping/pong for connection keep-alive (prevents zombie windows)
  ipcMain.on('window:ping', (event) => {
    try {
      event.reply('window:pong', { timestamp: Date.now() });
    } catch (err) {
      console.error('[IPC] Error sending pong:', err);
    }
  });

  console.log('[setupIPC] Window keep-alive handlers registered');

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
      
      console.log('[Clipboard] Getting video path for item:', itemId);
      
      // Helper to load scenes from metadata
      const loadScenes = (itemId) => {
        try {
          const metadataPath = path.join(storage.itemsDir, itemId, 'metadata.json');
          if (fs.existsSync(metadataPath)) {
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            return metadata.scenes || [];
          }
        } catch (e) {
          // Ignore metadata errors
        }
        return [];
      };
      
      // First, try to load item via storage (which scans for actual files)
      try {
        const item = storage.loadItem(itemId);
        
        if (item && item.content) {
          let filePath;
          if (path.isAbsolute(item.content)) {
            filePath = item.content;
          } else {
            filePath = path.join(storage.storageRoot, item.content);
          }
          
          if (fs.existsSync(filePath)) {
            console.log('[Clipboard] Found video via loadItem:', filePath);
            return { 
              success: true, 
              filePath: filePath,
              fileName: item.fileName || path.basename(filePath),
              scenes: loadScenes(itemId)
            };
          }
        }
      } catch (loadError) {
        console.log('[Clipboard] loadItem failed, trying fallback:', loadError.message);
      }
      
      // Fallback: Scan the item directory for video files directly
      // This handles cases where contentPath in index.json doesn't match actual filename
      const itemDir = path.join(storage.itemsDir, itemId);
      console.log('[Clipboard] Checking item directory:', itemDir);
      
      if (fs.existsSync(itemDir)) {
        const files = fs.readdirSync(itemDir);
        console.log('[Clipboard] Files in item dir:', files);
        
        // Filter for video files (excluding metadata, thumbnails, etc.)
        const videoExtensions = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm', '.m4v', '.mpg', '.mpeg'];
        const videoFile = files.find(f => {
          const lower = f.toLowerCase();
          // Skip hidden files and non-video files
          if (f.startsWith('.')) return false;
          return videoExtensions.some(ext => lower.endsWith(ext));
        });
        
        if (videoFile) {
          const videoPath = path.join(itemDir, videoFile);
          console.log('[Clipboard] Found video file in item dir:', videoPath);
          
          // Get fileName from index entry if available
          const indexEntry = storage.index.items.find(i => i.id === itemId);
          
          return { 
            success: true, 
            filePath: videoPath,
            fileName: indexEntry?.fileName || videoFile,
            scenes: loadScenes(itemId)
          };
        }
      }
      
      // File not found
      const indexEntry = storage.index.items.find(i => i.id === itemId);
      console.error('[Clipboard] Video file not found. Expected:', indexEntry?.contentPath);
      return { 
        success: false, 
        error: `Video file is missing from storage. The file may have been deleted or moved. Expected: ${indexEntry?.fileName || 'unknown'}`
      };
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

  // ============================================
  // UNIVERSAL SPACES API IPC HANDLERS
  // ============================================
  
  // Convenience method for video paths (wraps existing implementation)
  ipcMain.handle('spaces-api:getVideoPath', async (event, itemId) => {
    try {
      const ClipboardStorage = require('./clipboard-storage-v2');
      const storage = new ClipboardStorage();
      
      console.log('[SpacesAPI] Getting video path for item:', itemId);
      
      // Helper to load scenes from metadata
      const loadScenes = (itemId) => {
        try {
          const metadataPath = path.join(storage.itemsDir, itemId, 'metadata.json');
          if (fs.existsSync(metadataPath)) {
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            return metadata.scenes || [];
          }
        } catch (e) {
          // Ignore metadata errors
        }
        return [];
      };
      
      // First, try to load item via storage
      try {
        const item = storage.loadItem(itemId);
        
        if (item && item.content) {
          let filePath;
          if (path.isAbsolute(item.content)) {
            filePath = item.content;
          } else {
            filePath = path.join(storage.storageRoot, item.content);
          }
          
          if (fs.existsSync(filePath)) {
            console.log('[SpacesAPI] Found video via loadItem:', filePath);
            return { 
              success: true, 
              filePath: filePath,
              fileName: item.fileName || path.basename(filePath),
              scenes: loadScenes(itemId)
            };
          }
        }
      } catch (loadError) {
        console.log('[SpacesAPI] loadItem failed, trying fallback:', loadError.message);
      }
      
      // Fallback: Scan the item directory for video files directly
      const itemDir = path.join(storage.itemsDir, itemId);
      console.log('[SpacesAPI] Checking item directory:', itemDir);
      
      if (fs.existsSync(itemDir)) {
        const files = fs.readdirSync(itemDir);
        console.log('[SpacesAPI] Files in item dir:', files);
        
        // Filter for video files
        const videoExtensions = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm', '.m4v', '.mpg', '.mpeg'];
        const videoFile = files.find(f => {
          const lower = f.toLowerCase();
          if (f.startsWith('.')) return false;
          return videoExtensions.some(ext => lower.endsWith(ext));
        });
        
        if (videoFile) {
          const videoPath = path.join(itemDir, videoFile);
          console.log('[SpacesAPI] Found video file in item dir:', videoPath);
          
          const indexEntry = storage.index.items.find(i => i.id === itemId);
          
          return { 
            success: true, 
            filePath: videoPath,
            fileName: indexEntry?.fileName || videoFile,
            scenes: loadScenes(itemId)
          };
        }
      }
      
      // File not found
      const indexEntry = storage.index.items.find(i => i.id === itemId);
      console.error('[SpacesAPI] Video file not found. Expected:', indexEntry?.contentPath);
      return { 
        success: false, 
        error: `Video file is missing from storage. The file may have been deleted or moved. Expected: ${indexEntry?.fileName || 'unknown'}`
      };
    } catch (error) {
      console.error('[SpacesAPI] Error getting video path:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Space management
  ipcMain.handle('spaces-api:list', async () => {
    const { getSpacesAPI } = require('./spaces-api');
    const api = getSpacesAPI();
    return await api.list();
  });
  
  ipcMain.handle('spaces-api:get', async (event, spaceId) => {
    const { getSpacesAPI } = require('./spaces-api');
    const api = getSpacesAPI();
    return await api.get(spaceId);
  });
  
  ipcMain.handle('spaces-api:create', async (event, name, options) => {
    const { getSpacesAPI } = require('./spaces-api');
    const api = getSpacesAPI();
    return await api.create(name, options);
  });
  
  ipcMain.handle('spaces-api:update', async (event, spaceId, data) => {
    const { getSpacesAPI } = require('./spaces-api');
    const api = getSpacesAPI();
    return await api.update(spaceId, data);
  });
  
  ipcMain.handle('spaces-api:delete', async (event, spaceId) => {
    const { getSpacesAPI } = require('./spaces-api');
    const api = getSpacesAPI();
    return await api.delete(spaceId);
  });
  
  // Item management
  ipcMain.handle('spaces-api:items:list', async (event, spaceId, options) => {
    const { getSpacesAPI } = require('./spaces-api');
    const api = getSpacesAPI();
    return await api.items.list(spaceId, options);
  });
  
  ipcMain.handle('spaces-api:items:get', async (event, spaceId, itemId) => {
    const { getSpacesAPI } = require('./spaces-api');
    const api = getSpacesAPI();
    return await api.items.get(spaceId, itemId);
  });
  
  ipcMain.handle('spaces-api:items:add', async (event, spaceId, item) => {
    const { getSpacesAPI } = require('./spaces-api');
    const api = getSpacesAPI();
    return await api.items.add(spaceId, item);
  });
  
  ipcMain.handle('spaces-api:items:update', async (event, spaceId, itemId, data) => {
    const { getSpacesAPI } = require('./spaces-api');
    const api = getSpacesAPI();
    return await api.items.update(spaceId, itemId, data);
  });
  
  ipcMain.handle('spaces-api:items:delete', async (event, spaceId, itemId) => {
    const { getSpacesAPI } = require('./spaces-api');
    const api = getSpacesAPI();
    return await api.items.delete(spaceId, itemId);
  });
  
  ipcMain.handle('spaces-api:items:move', async (event, itemId, fromSpaceId, toSpaceId) => {
    const { getSpacesAPI } = require('./spaces-api');
    const api = getSpacesAPI();
    return await api.items.move(itemId, fromSpaceId, toSpaceId);
  });
  
  // File access
  ipcMain.handle('spaces-api:files:getSpacePath', async (event, spaceId) => {
    const { getSpacesAPI } = require('./spaces-api');
    const api = getSpacesAPI();
    return await api.files.getSpacePath(spaceId);
  });
  
  ipcMain.handle('spaces-api:files:list', async (event, spaceId, subPath) => {
    const { getSpacesAPI } = require('./spaces-api');
    const api = getSpacesAPI();
    return await api.files.list(spaceId, subPath);
  });
  
  ipcMain.handle('spaces-api:files:read', async (event, spaceId, filePath) => {
    const { getSpacesAPI } = require('./spaces-api');
    const api = getSpacesAPI();
    return await api.files.read(spaceId, filePath);
  });
  
  ipcMain.handle('spaces-api:files:write', async (event, spaceId, filePath, content) => {
    const { getSpacesAPI } = require('./spaces-api');
    const api = getSpacesAPI();
    return await api.files.write(spaceId, filePath, content);
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
  
  // ============================================
  // MULTI-FORMAT SMART EXPORT HANDLERS
  // ============================================
  
  // Get available export formats
  ipcMain.handle('smart-export:get-formats', async () => {
    try {
      const { getAllFormats } = require('./format-generators');
      return getAllFormats();
    } catch (error) {
      console.error('[SmartExport] Error getting formats:', error);
      return [];
    }
  });

  // Generate export in specified format
  ipcMain.handle('smart-export:generate', async (event, { format, spaceId, options = {} }) => {
    try {
      console.log(`[SmartExport] Generating ${format} export for space:`, spaceId);
      
      // Get space and items
      const spacesAPI = require('./spaces-api');
      const api = spacesAPI.getSpacesAPI();
      
      const space = await api.get(spaceId);
      if (!space) {
        return { success: false, error: 'Space not found' };
      }
      
      const items = await api.items.list(spaceId, { includeContent: true });
      
      // Route to appropriate generator
      let result;
      
      switch (format) {
        case 'pdf': {
          // Use existing PDF generator with smart export
          const PDFGenerator = require('./pdf-generator');
          const generator = new PDFGenerator();
          
          // Generate HTML first using SmartExport if AI-enhanced
          let html;
          if (options.aiEnhanced) {
            const SmartExport = require('./smart-export');
            const smartExport = new SmartExport();
            const exportResult = await smartExport.generateSmartExport(space, items, options);
            html = exportResult.html;
          } else {
            html = generator.generateSpaceHTML(space, items, {
              includeMetadata: options.includeMetadata !== false,
              includeTimestamps: true,
              includeTags: true,
              embedStyles: true
            });
          }
          
          // Save dialog
          const { dialog } = require('electron');
          const saveResult = await dialog.showSaveDialog({
            title: 'Export as PDF',
            defaultPath: `${space.name.replace(/[^a-z0-9]/gi, '_')}.pdf`,
            filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
          });
          
          if (saveResult.canceled) {
            return { success: false, canceled: true };
          }
          
          await generator.generatePDFFromHTML(html, saveResult.filePath);
          await generator.cleanup();
          
          shell.showItemInFolder(saveResult.filePath);
          result = { success: true, path: saveResult.filePath };
          break;
        }
        
        case 'docx': {
          const { DocxGenerator } = require('./format-generators');
          const generator = new DocxGenerator();
          const genResult = await generator.generate(space, items, options);
          
          if (!genResult.success) {
            return genResult;
          }
          
          // Save dialog
          const { dialog } = require('electron');
          const saveResult = await dialog.showSaveDialog({
            title: 'Export as Word Document',
            defaultPath: genResult.filename,
            filters: [{ name: 'Word Documents', extensions: ['docx'] }]
          });
          
          if (saveResult.canceled) {
            return { success: false, canceled: true };
          }
          
          fs.writeFileSync(saveResult.filePath, genResult.buffer);
          shell.showItemInFolder(saveResult.filePath);
          result = { success: true, path: saveResult.filePath };
          break;
        }
        
        case 'pptx': {
          const { PptxGenerator } = require('./format-generators');
          const generator = new PptxGenerator();
          const genResult = await generator.generate(space, items, options);
          
          if (!genResult.success) {
            return genResult;
          }
          
          const { dialog } = require('electron');
          const saveResult = await dialog.showSaveDialog({
            title: 'Export as PowerPoint',
            defaultPath: genResult.filename,
            filters: [{ name: 'PowerPoint Presentations', extensions: ['pptx'] }]
          });
          
          if (saveResult.canceled) {
            return { success: false, canceled: true };
          }
          
          fs.writeFileSync(saveResult.filePath, genResult.buffer);
          shell.showItemInFolder(saveResult.filePath);
          result = { success: true, path: saveResult.filePath };
          break;
        }
        
        case 'xlsx': {
          const { XlsxGenerator } = require('./format-generators');
          const generator = new XlsxGenerator();
          const genResult = await generator.generate(space, items, options);
          
          if (!genResult.success) {
            return genResult;
          }
          
          const { dialog } = require('electron');
          const saveResult = await dialog.showSaveDialog({
            title: 'Export as Excel Spreadsheet',
            defaultPath: genResult.filename,
            filters: [{ name: 'Excel Spreadsheets', extensions: ['xlsx'] }]
          });
          
          if (saveResult.canceled) {
            return { success: false, canceled: true };
          }
          
          fs.writeFileSync(saveResult.filePath, genResult.buffer);
          shell.showItemInFolder(saveResult.filePath);
          result = { success: true, path: saveResult.filePath };
          break;
        }
        
        case 'markdown': {
          const { MarkdownGenerator } = require('./format-generators');
          const generator = new MarkdownGenerator();
          const genResult = await generator.generate(space, items, options);
          
          if (!genResult.success) {
            return genResult;
          }
          
          const { dialog } = require('electron');
          const saveResult = await dialog.showSaveDialog({
            title: 'Export as Markdown',
            defaultPath: genResult.filename,
            filters: [{ name: 'Markdown Files', extensions: ['md'] }]
          });
          
          if (saveResult.canceled) {
            return { success: false, canceled: true };
          }
          
          fs.writeFileSync(saveResult.filePath, genResult.content, 'utf8');
          shell.showItemInFolder(saveResult.filePath);
          result = { success: true, path: saveResult.filePath };
          break;
        }
        
        case 'csv': {
          const { CsvGenerator } = require('./format-generators');
          const generator = new CsvGenerator();
          const genResult = await generator.generate(space, items, options);
          
          if (!genResult.success) {
            return genResult;
          }
          
          const { dialog } = require('electron');
          const saveResult = await dialog.showSaveDialog({
            title: 'Export as CSV',
            defaultPath: genResult.filename,
            filters: [{ name: 'CSV Files', extensions: ['csv'] }]
          });
          
          if (saveResult.canceled) {
            return { success: false, canceled: true };
          }
          
          fs.writeFileSync(saveResult.filePath, genResult.content, 'utf8');
          shell.showItemInFolder(saveResult.filePath);
          result = { success: true, path: saveResult.filePath };
          break;
        }
        
        case 'txt': {
          const { TxtGenerator } = require('./format-generators');
          const generator = new TxtGenerator();
          const genResult = await generator.generate(space, items, options);
          
          if (!genResult.success) {
            return genResult;
          }
          
          const { dialog } = require('electron');
          const saveResult = await dialog.showSaveDialog({
            title: 'Export as Plain Text',
            defaultPath: genResult.filename,
            filters: [{ name: 'Text Files', extensions: ['txt'] }]
          });
          
          if (saveResult.canceled) {
            return { success: false, canceled: true };
          }
          
          fs.writeFileSync(saveResult.filePath, genResult.content, 'utf8');
          shell.showItemInFolder(saveResult.filePath);
          result = { success: true, path: saveResult.filePath };
          break;
        }
        
        case 'slides': {
          const { SlidesGenerator } = require('./format-generators');
          const generator = new SlidesGenerator();
          const genResult = await generator.generate(space, items, options);
          
          if (!genResult.success) {
            return genResult;
          }
          
          const { dialog } = require('electron');
          const saveResult = await dialog.showSaveDialog({
            title: 'Export as Web Slides',
            defaultPath: genResult.filename,
            filters: [{ name: 'HTML Files', extensions: ['html'] }]
          });
          
          if (saveResult.canceled) {
            return { success: false, canceled: true };
          }
          
          fs.writeFileSync(saveResult.filePath, genResult.content, 'utf8');
          shell.showItemInFolder(saveResult.filePath);
          result = { success: true, path: saveResult.filePath };
          break;
        }
        
        case 'html': {
          // Use existing smart export for HTML
          const SmartExport = require('./smart-export');
          const smartExport = new SmartExport();
          const exportResult = await smartExport.generateSmartExport(space, items, options);
          
          const { dialog } = require('electron');
          const saveResult = await dialog.showSaveDialog({
            title: 'Export as HTML',
            defaultPath: `${space.name.replace(/[^a-z0-9]/gi, '_')}.html`,
            filters: [{ name: 'HTML Files', extensions: ['html'] }]
          });
          
          if (saveResult.canceled) {
            return { success: false, canceled: true };
          }
          
          fs.writeFileSync(saveResult.filePath, exportResult.html, 'utf8');
          shell.showItemInFolder(saveResult.filePath);
          result = { success: true, path: saveResult.filePath };
          break;
        }
        
        default:
          return { success: false, error: `Unsupported format: ${format}` };
      }
      
      return result;
      
    } catch (error) {
      console.error('[SmartExport] Error generating export:', error);
      return { success: false, error: error.message };
    }
  });

  // Open format selection modal
  ipcMain.handle('smart-export:open-modal', async (event, spaceId) => {
    try {
      // Get space data for the modal
      const spacesAPI = require('./spaces-api');
      const api = spacesAPI.getSpacesAPI();
      
      const space = await api.get(spaceId);
      const items = await api.items.list(spaceId);
      
      // Create modal window
      const modalWindow = new BrowserWindow({
        width: 780,
        height: 720,
        parent: BrowserWindow.getFocusedWindow(),
        modal: true,
        show: false,
        resizable: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, 'preload-smart-export.js')
        }
      });
      
      modalWindow.loadFile('smart-export-format-modal.html');
      
      modalWindow.once('ready-to-show', () => {
        modalWindow.show();
        // Send space data to modal
        modalWindow.webContents.send('space-data', {
          id: spaceId,
          name: space?.name || 'Unnamed Space',
          itemCount: items?.length || 0
        });
      });
      
      return { success: true };
    } catch (error) {
      console.error('[SmartExport] Error opening modal:', error);
      return { success: false, error: error.message };
    }
  });

  // Close smart-export modal via IPC
  ipcMain.on('smart-export:close-modal', (event) => {
    console.log('[SmartExport] Close modal IPC received');
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.close();
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
    // NOTE: 'open-idw-url' is handled below at line ~8171 - DO NOT add a duplicate handler here
    // The previous handler here used mainWindow.loadURL() which broke the tabbed browser
    if (data.action === 'open-external-bot' && data.url) {
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

  // Handle create space from black hole
  ipcMain.handle('black-hole:create-space', async (event) => {
    // Use a simpler approach - create a small input dialog window
    const inputWindow = new BrowserWindow({
      width: 400,
      height: 200,
      modal: true,
      parent: global.clipboardManager?.blackHoleWindow,
      show: false,
      frame: false,
      transparent: false,
      backgroundColor: '#1e1e1e',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    
    inputWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            padding: 20px;
            background: #1e1e1e;
            color: #fff;
            margin: 0;
          }
          h2 { margin-top: 0; font-size: 18px; }
          input {
            width: 100%;
            padding: 10px;
            font-size: 14px;
            border: 1px solid #444;
            border-radius: 4px;
            background: #2a2a2a;
            color: #fff;
            margin: 10px 0;
            box-sizing: border-box;
          }
          .buttons {
            display: flex;
            gap: 10px;
            margin-top: 20px;
          }
          button {
            flex: 1;
            padding: 10px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
          }
          .primary {
            background: #6366f1;
            color: white;
          }
          .secondary {
            background: #444;
            color: white;
          }
        </style>
      </head>
      <body>
        <h2>Create New Space</h2>
        <input type="text" id="spaceName" placeholder="Enter space name..." autofocus>
        <div class="buttons">
          <button class="secondary" onclick="cancel()">Cancel</button>
          <button class="primary" onclick="create()">Create</button>
        </div>
        <script>
          const { ipcRenderer } = require('electron');
          document.getElementById('spaceName').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') create();
            if (e.key === 'Escape') cancel();
          });
          function cancel() {
            ipcRenderer.send('input-dialog-response', null);
          }
          function create() {
            const name = document.getElementById('spaceName').value.trim();
            if (name) {
              ipcRenderer.send('input-dialog-response', name);
            }
          }
        </script>
      </body>
      </html>
    `)}`);
    
    inputWindow.once('ready-to-show', () => {
      inputWindow.show();
    });
    
    // Wait for response
    return new Promise((resolve) => {
      ipcMain.once('input-dialog-response', async (evt, spaceName) => {
        inputWindow.close();
        
        if (!spaceName) {
          resolve({ success: false });
          return;
        }
        
        // Create the space using the unified SpacesAPI
        try {
          const newSpace = await spacesAPI.create(spaceName, {
            icon: '📁',
            color: '#6366f1'
          });
          
          if (newSpace) {
            resolve({ success: true, space: newSpace });
          } else {
            resolve({ success: false, error: 'Failed to create space' });
          }
        } catch (error) {
          console.error('Error creating space:', error);
          resolve({ success: false, error: error.message });
        }
      });
    });
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
      
      // Add context menu handler for this webview with standard editing options and "Send to Space"
      console.log(`[Main] Adding context menu handler for webview ${data.tabId}`);
      contents.on('context-menu', (event, params) => {
        console.log(`[Webview ${data.tabId}] Context menu requested at:`, params.x, params.y, 'selectionText:', params.selectionText);
        
        // Allow native DevTools context menu to work (only when right-clicking IN DevTools)
        const url = contents.getURL();
        if (url.startsWith('devtools://') || url.startsWith('chrome-devtools://')) {
          console.log(`[Webview ${data.tabId}] DevTools panel detected, allowing native context menu`);
          return; // Don't prevent default, let DevTools handle it
        }
        
        event.preventDefault();
        
        // Build context menu template with standard editing options
        const menuTemplate = [];
        
        // Add Cut option if text is selected and editable
        if (params.editFlags.canCut) {
          menuTemplate.push({
            label: 'Cut',
            accelerator: 'CmdOrCtrl+X',
            click: () => {
              contents.cut();
            }
          });
        }
        
        // Add Copy option if text is selected
        if (params.editFlags.canCopy) {
          menuTemplate.push({
            label: 'Copy',
            accelerator: 'CmdOrCtrl+C',
            click: () => {
              contents.copy();
            }
          });
        }
        
        // Add Paste option if paste is available
        if (params.editFlags.canPaste) {
          menuTemplate.push({
            label: 'Paste',
            accelerator: 'CmdOrCtrl+V',
            click: () => {
              contents.paste();
            }
          });
        }
        
        // Add Select All option
        if (params.editFlags.canSelectAll) {
          menuTemplate.push({
            label: 'Select All',
            accelerator: 'CmdOrCtrl+A',
            click: () => {
              contents.selectAll();
            }
          });
        }
        
        // Add separator if we have any standard options
        if (params.editFlags.canCut || params.editFlags.canCopy || params.editFlags.canPaste || params.editFlags.canSelectAll) {
          menuTemplate.push({ type: 'separator' });
        }
        
        // Add "Send to Space" option if text is selected
        if (params.selectionText && params.selectionText.trim().length > 0) {
          menuTemplate.push({
            label: 'Send to Space',
            click: () => {
              console.log(`[Webview ${data.tabId}] Send to Space clicked with selection:`, params.selectionText.substring(0, 50));
              
              if (global.clipboardManager) {
                const win = BrowserWindow.fromWebContents(event.sender);
                if (win) {
                  const bounds = win.getBounds();
                  const position = {
                    x: bounds.x + params.x,
                    y: bounds.y + params.y
                  };
                  
                  const selectionData = {
                    hasText: true,
                    hasHtml: false,
                    hasImage: false,
                    text: params.selectionText,
                    html: null
                  };
                  
                  // Create window with selection data - will show modal directly
                  global.clipboardManager.createBlackHoleWindow(position, true, selectionData);
                }
              }
            }
          });
        }
        
        // Add "Send Image to Space" option if right-clicking on an image
        if (params.mediaType === 'image' && params.srcURL) {
          menuTemplate.push({
            label: 'Send Image to Space',
            click: async () => {
              console.log(`[Webview ${data.tabId}] Send Image to Space clicked:`, params.srcURL);
              
              if (global.clipboardManager) {
                const win = BrowserWindow.fromWebContents(event.sender);
                if (win) {
                  try {
                    const { net } = require('electron');
                    
                    // Download the image
                    const imageData = await new Promise((resolve, reject) => {
                      const request = net.request(params.srcURL);
                      const chunks = [];
                      
                      request.on('response', (response) => {
                        const contentType = response.headers['content-type'] || 'image/png';
                        
                        response.on('data', (chunk) => {
                          chunks.push(chunk);
                        });
                        
                        response.on('end', () => {
                          const buffer = Buffer.concat(chunks);
                          const base64 = buffer.toString('base64');
                          const mimeType = Array.isArray(contentType) ? contentType[0] : contentType;
                          resolve(`data:${mimeType};base64,${base64}`);
                        });
                        
                        response.on('error', reject);
                      });
                      
                      request.on('error', reject);
                      request.end();
                    });
                    
                    const bounds = win.getBounds();
                    const position = {
                      x: bounds.x + params.x,
                      y: bounds.y + params.y
                    };
                    
                    const imageDataObj = {
                      hasText: false,
                      hasHtml: false,
                      hasImage: true,
                      text: null,
                      html: null,
                      imageDataUrl: imageData,
                      sourceUrl: params.srcURL
                    };
                    
                    console.log(`[Webview ${data.tabId}] Image data ready from:`, params.srcURL);
                    global.clipboardManager.createBlackHoleWindow(position, true, imageDataObj);
                  } catch (error) {
                    console.error(`[Webview ${data.tabId}] Error downloading image:`, error);
                    // Fallback: just send the URL as text
                    const bounds = win.getBounds();
                    const position = {
                      x: bounds.x + params.x,
                      y: bounds.y + params.y
                    };
                    
                    const fallbackData = {
                      hasText: true,
                      hasHtml: false,
                      hasImage: false,
                      text: params.srcURL,
                      html: null
                    };
                    
                    global.clipboardManager.createBlackHoleWindow(position, true, fallbackData);
                  }
                }
              }
            }
          });
          
          // Also add "Copy Image" option for convenience
          menuTemplate.push({
            label: 'Copy Image',
            click: () => {
              contents.copyImageAt(params.x, params.y);
            }
          });
        }
        
        // Add "Paste to Space" option (for clipboard content)
        menuTemplate.push({
          label: 'Paste to Space',
          click: () => {
            console.log(`[Webview ${data.tabId}] Paste to Space clicked`);
            
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
                
                const { clipboard } = require('electron');
                const text = clipboard.readText();
                const html = clipboard.readHTML();
                const image = clipboard.readImage();
                
                // Check if HTML is really meaningful
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
                
                // Create window with clipboard data - will show modal directly
                global.clipboardManager.createBlackHoleWindow(position, true, clipboardData);
              }
            }
          }
        });
        
        const contextMenu = Menu.buildFromTemplate(menuTemplate);
        
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
    
    // ==================== APP FEATURE ACTIONS (delegated to action-executor) ====================
    // These actions are handled by action-executor.js for centralized management
    if (data.action && data.action.startsWith('open-') && !data.url) {
      const { executeAction, hasAction } = require('./action-executor');
      if (hasAction(data.action)) {
        console.log('[Menu Action] Delegating to action-executor:', data.action);
        executeAction(data.action, data);
        return;
      }
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
    } else if (url.includes('x.ai') || url.includes('grok.x.com') || url.includes('grok.com')) {
      aiType = 'chat';
      aiService = 'Grok';
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
          
          // Console log artifact-related URLs for debugging
          if (request.url.includes('artifacts') || request.url.includes('/files/')) {
            console.log(`[${label}] 🔍 Artifact URL detected: ${request.url}`);
            console.log(`[${label}]    Method: ${request.method}`);
            
            // Don't try to download - Claude's artifact endpoints return 404
            // The artifact content is embedded in the SSE completion response
          }
          
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
          // Exclude telemetry/analytics URLs
          const isTelemetryUrl = request.url.includes('/ces/') || 
                                 request.url.includes('/telemetry/') || 
                                 request.url.includes('/analytics/') ||
                                 request.url.includes('/v1/t') ||
                                 request.url.includes('ddforward=');
          
          // Grok-specific: only capture actual conversation endpoints (new and follow-up responses)
          const isGrokConversationRequest = aiService === 'Grok' && 
                                            (request.url.includes('/app-chat/conversations/new') || 
                                             request.url.includes('/responses') ||
                                             request.url.includes('/conversations_v2/'));
          
          // Gemini-specific: capture conversation-related endpoints (exclude CSP reports)
          // Focus on StreamGenerate which is the actual conversation endpoint
          const isGeminiConversationRequest = aiService === 'Gemini' && 
                                              !request.url.includes('cspreport') &&
                                              !request.url.includes('/csp/') &&
                                              request.url.includes('StreamGenerate');
          
          if (aiService === 'Gemini' && request.url.includes('StreamGenerate')) {
            console.log('[Gemini DEBUG] StreamGenerate request detected');
          }
          
          if (request.postData && !isTelemetryUrl &&
              (request.url.includes('/api/') || 
               request.url.includes('/v1/') ||
               request.url.includes('chat') ||
               request.url.includes('completion') ||
               request.url.includes('claude') ||
               request.url.includes('messages') ||
               request.url.includes('/backend-api/conversation') ||
               aiService === 'Claude' ||
               isGrokConversationRequest ||
               isGeminiConversationRequest)) {  // Grok/Gemini: specific conversation endpoints
            try {
              let payload;
              
              // Gemini uses URL-encoded form data, not JSON
              if (aiService === 'Gemini' && (request.url.includes('batchexecute') || request.url.includes('StreamGenerate'))) {
                // Parse URL-encoded form data
                const formData = new URLSearchParams(request.postData);
                const fReq = formData.get('f.req');
                
                if (fReq) {
                  console.log('[Gemini DEBUG] Found f.req in batchexecute');
                  
                  // fReq is a nested JSON string
                  // Format: [[["rpcName","[[\"message\",...]]",null,"generic"]]]
                  try {
                    const parsed = JSON.parse(fReq);
                    console.log('[Gemini DEBUG] Parsed f.req, outer array length:', parsed?.length);
                    
                    // Extract user message from the nested structure
                    // The message is typically in parsed[0][0][1] which is itself a JSON string
                    if (Array.isArray(parsed) && parsed[0] && parsed[0][0]) {
                      const innerJson = parsed[0][0][1];
                      if (typeof innerJson === 'string') {
                        try {
                          const innerParsed = JSON.parse(innerJson);
                          console.log('[Gemini DEBUG] Inner parsed type:', typeof innerParsed, Array.isArray(innerParsed) ? 'array' : '');
                          
                          // The user message is usually in the first string element
                          const extractUserMessage = (arr) => {
                            if (!Array.isArray(arr)) return null;
                            for (const item of arr) {
                              if (typeof item === 'string' && item.length > 0 && item.length < 5000 && !item.match(/^[a-f0-9-]{30,}$/i)) {
                                return item;
                              }
                              if (Array.isArray(item)) {
                                const found = extractUserMessage(item);
                                if (found) return found;
                              }
                            }
                            return null;
                          };
                          
                          const userMessage = extractUserMessage(innerParsed);
                          if (userMessage) {
                            console.log('[Gemini DEBUG] Extracted user message:', userMessage.substring(0, 100));
                            payload = { _geminiMessage: userMessage, _isGeminiBatchexecute: true };
                          } else {
                            payload = { _isGeminiBatchexecute: true };
                          }
                        } catch (innerErr) {
                          console.log('[Gemini DEBUG] Inner parse failed:', innerErr.message);
                          payload = { _isGeminiBatchexecute: true };
                        }
                      } else {
                        payload = { _isGeminiBatchexecute: true };
                      }
                    } else {
                      payload = { _isGeminiBatchexecute: true };
                    }
                  } catch (parseErr) {
                    console.log('[Gemini DEBUG] f.req parse failed:', parseErr.message);
                    payload = { _isGeminiBatchexecute: true };
                  }
                } else {
                  // No f.req, try standard JSON
                  payload = JSON.parse(request.postData);
                }
              } else {
                payload = JSON.parse(request.postData);
              }
              
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
              
              // Capture prompt for conversation history
              if (conversationCapture && aiType === 'chat') {
                try {
                  // Extract conversation ID from URL
                  let externalConversationId = null;
                  
                  if (aiService === 'Claude') {
                    // Claude: /api/organizations/.../chat_conversations/UUID/completion
                    const match = request.url.match(/chat_conversations\/([a-f0-9\-]+)/i);
                    if (match) {
                      externalConversationId = match[1];
                      console.log(`[ConversationCapture] Extracted Claude conversation ID: ${externalConversationId}`);
                    }
                  } else if (aiService === 'ChatGPT') {
                    // Only capture actual conversation requests 
                    // ChatGPT uses various paths: /backend-api/conversation, /backend-api/f/conversation, etc.
                    const isConversationEndpoint = request.url.includes('/conversation') && 
                                                   request.url.includes('backend-api');
                    
                    if (!isConversationEndpoint) {
                      console.log(`[ConversationCapture] Skipping non-conversation ChatGPT request: ${request.url.substring(0, 100)}`);
                      return;
                    }
                    
                    // Skip init requests - they have no user message
                    if (request.url.includes('/conversation/init')) {
                      console.log(`[ConversationCapture] Skipping ChatGPT init request (no user message)`);
                      return;
                    }
                    
                    console.log(`[ConversationCapture] ✅ Detected ChatGPT conversation request: ${request.url.substring(0, 100)}`);
                    
                    // ChatGPT: /backend-api/conversation/{conversation_id}
                    // OR: May be in request body as conversation_id
                    const urlMatch = request.url.match(/\/conversation\/([a-f0-9\-]+)/i);
                    if (urlMatch) {
                      externalConversationId = urlMatch[1];
                      console.log(`[ConversationCapture] Extracted ChatGPT conversation ID from URL: ${externalConversationId}`);
                    } else if (payload && payload.conversation_id) {
                      externalConversationId = payload.conversation_id;
                      console.log(`[ConversationCapture] Extracted ChatGPT conversation ID from payload: ${externalConversationId}`);
                    } else if (payload && payload.parent_message_id) {
                      // Fallback: use parent message ID to group related messages
                      externalConversationId = payload.parent_message_id;
                      console.log(`[ConversationCapture] Using ChatGPT parent message ID as conversation ID: ${externalConversationId}`);
                    }
                    
                    // Diagnostic logging for ChatGPT payload structure
                    console.log('[ChatGPT DEBUG] Request URL:', request.url);
                    console.log('[ChatGPT DEBUG] Payload keys:', Object.keys(payload));
                    if (payload.messages && Array.isArray(payload.messages)) {
                      console.log('[ChatGPT DEBUG] Message count:', payload.messages.length);
                      const lastMsg = payload.messages[payload.messages.length - 1];
                      console.log('[ChatGPT DEBUG] Last message structure:', JSON.stringify(lastMsg, null, 2).substring(0, 500));
                    }
                  } else if (aiService === 'Grok') {
                    // Grok: Only capture actual conversation requests
                    // Skip non-conversation endpoints
                    const isGrokConversation = request.url.includes('/app-chat/') || 
                                               request.url.includes('/conversations');
                    
                    if (!isGrokConversation) {
                      console.log(`[ConversationCapture] Skipping non-conversation Grok request: ${request.url.substring(0, 80)}`);
                      return;
                    }
                    
                    console.log('[Grok DEBUG] Request URL:', request.url);
                    console.log('[Grok DEBUG] Payload keys:', JSON.stringify(Object.keys(payload)));
                    console.log('[Grok DEBUG] Payload sample:', JSON.stringify(payload).substring(0, 500));
                    
                    // Try to extract conversation ID from URL
                    const urlMatch = request.url.match(/\/conversation[s]?\/([a-f0-9\-]+)/i);
                    if (urlMatch) {
                      externalConversationId = urlMatch[1];
                      console.log(`[ConversationCapture] Extracted Grok conversation ID from URL: ${externalConversationId}`);
                    } else if (payload.conversation_id || payload.conversationId) {
                      externalConversationId = payload.conversation_id || payload.conversationId;
                      console.log(`[ConversationCapture] Extracted Grok conversation ID from payload: ${externalConversationId}`);
                    } else if (payload.session_id || payload.sessionId) {
                      externalConversationId = payload.session_id || payload.sessionId;
                      console.log(`[ConversationCapture] Using Grok session ID as conversation ID: ${externalConversationId}`);
                    }
                    
                    // Extract Grok message - Grok uses 'message' field directly or nested structures
                    let grokMessage = payload.message || payload.query || payload.text || payload.content || payload.input;
                    if (!grokMessage && payload.messages && Array.isArray(payload.messages)) {
                      // If messages array exists, get last user message
                      const userMsg = payload.messages.filter(m => m.role === 'user' || m.sender === 'human').pop();
                      grokMessage = userMsg?.content || userMsg?.message || userMsg?.text;
                    }
                    
                    if (grokMessage) {
                      console.log('[Grok DEBUG] Found message:', typeof grokMessage === 'string' ? grokMessage.substring(0, 100) : JSON.stringify(grokMessage).substring(0, 100));
                      // Store in payload for extraction
                      payload._grokMessage = grokMessage;
                    }
                  } else if (aiService === 'Gemini') {
                    // Gemini: Extract conversation from various possible formats
                    // Gemini web uses batchexecute and other endpoints
                    // Exclude CSP reports and other non-conversation requests
                    const isGeminiConversation = !request.url.includes('cspreport') &&
                                                 !request.url.includes('/csp/') &&
                                                 (request.url.includes('batchexecute') || 
                                                  request.url.includes('StreamGenerate') ||
                                                  request.url.includes('/generate') ||
                                                  request.url.includes('/chat'));
                    
                    if (!isGeminiConversation) {
                      console.log(`[ConversationCapture] Skipping non-conversation Gemini request: ${request.url.substring(0, 80)}`);
                      return;
                    }
                    
                    console.log('[Gemini DEBUG] Request URL:', request.url);
                    console.log('[Gemini DEBUG] Payload keys:', JSON.stringify(Object.keys(payload)));
                    console.log('[Gemini DEBUG] Payload sample:', JSON.stringify(payload).substring(0, 500));
                    
                    // Try to extract conversation ID from URL or payload
                    const urlMatch = request.url.match(/conversation[s]?\/([a-zA-Z0-9_-]+)/i);
                    if (urlMatch) {
                      externalConversationId = urlMatch[1];
                      console.log(`[ConversationCapture] Extracted Gemini conversation ID from URL: ${externalConversationId}`);
                    } else if (payload.conversationId || payload.conversation_id) {
                      externalConversationId = payload.conversationId || payload.conversation_id;
                      console.log(`[ConversationCapture] Extracted Gemini conversation ID from payload: ${externalConversationId}`);
                    }
                    
                    // Extract Gemini message - Gemini uses various field names
                    // Common fields: contents, prompt, text, message, query
                    let geminiMessage = null;
                    
                    // Gemini API format: contents[].parts[].text
                    if (payload.contents && Array.isArray(payload.contents)) {
                      const userContent = payload.contents.filter(c => c.role === 'user').pop();
                      if (userContent?.parts) {
                        geminiMessage = userContent.parts.map(p => p.text || '').join('');
                      }
                    }
                    
                    // Alternative formats
                    if (!geminiMessage) {
                      geminiMessage = payload.prompt || payload.text || payload.message || payload.query || payload.input;
                    }
                    
                    // Nested messages array
                    if (!geminiMessage && payload.messages && Array.isArray(payload.messages)) {
                      const userMsg = payload.messages.filter(m => m.role === 'user').pop();
                      geminiMessage = userMsg?.content || userMsg?.text || userMsg?.message;
                    }
                    
                    if (geminiMessage) {
                      console.log('[Gemini DEBUG] Found message:', typeof geminiMessage === 'string' ? geminiMessage.substring(0, 100) : JSON.stringify(geminiMessage).substring(0, 100));
                      // Store in payload for extraction
                      payload._geminiMessage = geminiMessage;
                    }
                    
                    // If message was already extracted from batchexecute parsing, use it
                    if (!payload._geminiMessage && payload._isGeminiBatchexecute) {
                      console.log('[Gemini DEBUG] No message found in batchexecute - may be metadata request');
                    }
                  }
                  
                  
                  // Build message based on service
                  let messageToCapture = payload.messages || payload.prompt;
                  if (aiService === 'Grok' && payload._grokMessage) {
                    messageToCapture = payload._grokMessage;
                  } else if (aiService === 'Gemini' && payload._geminiMessage) {
                    messageToCapture = payload._geminiMessage;
                  }
                  
                  conversationCapture.capturePrompt(aiService, {
                    message: messageToCapture,
                    model: payload.model,
                    timestamp: new Date().toISOString(),
                    externalConversationId  // Pass the conversation ID
                  }).catch(err => {
                    console.error('[ConversationCapture] Error capturing prompt:', err);
                  });
                } catch (err) {
                  console.error('[ConversationCapture] Error in capturePrompt:', err);
                }
              }
              
              // Capture media files
              if (conversationCapture && aiType === 'chat' && processedPayload.files && processedPayload.files.length > 0) {
                try {
                  // Extract conversation ID from URL
                  let externalConversationId = null;
                  
                  if (aiService === 'Claude') {
                    // Claude: /api/organizations/.../chat_conversations/UUID/completion
                    const match = request.url.match(/chat_conversations\/([a-f0-9\-]+)/i);
                    if (match) {
                      externalConversationId = match[1];
                    }
                  } else if (aiService === 'ChatGPT') {
                    // ChatGPT: /backend-api/conversation/{conversation_id}
                    const urlMatch = request.url.match(/\/conversation\/([a-f0-9\-]+)/i);
                    if (urlMatch) {
                      externalConversationId = urlMatch[1];
                    } else if (payload && payload.conversation_id) {
                      externalConversationId = payload.conversation_id;
                    } else if (payload && payload.parent_message_id) {
                      externalConversationId = payload.parent_message_id;
                    }
                  }
                  
                  conversationCapture.captureMedia(aiService, processedPayload.files, externalConversationId);
                } catch (err) {
                  console.error('[ConversationCapture] Error capturing media:', err);
                }
              }
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
          
          // Get response body if it's an API response OR artifact endpoint
          if (response.url.includes('/api/') || 
              response.url.includes('/v1/') ||
              response.url.includes('chat') ||
              response.url.includes('completions') ||
              response.url.includes('artifacts')) {  // Add artifacts
            aiWindow.webContents.debugger.sendCommand('Network.getResponseBody', {
              requestId: params.requestId
            }).then(responseBody => {
              try {
                const body = responseBody.base64Encoded 
                  ? Buffer.from(responseBody.body, 'base64').toString('utf-8')
                  : responseBody.body;
                
                // Special handling for artifact responses
                if (response.url.includes('artifacts')) {
                  console.log(`[${label}] 📄 Artifact content received: ${response.url}`);
                  console.log(`[${label}]    Content length: ${body.length}`);
                  
                  // Try to parse as JSON
                  try {
                    const artifactData = JSON.parse(body);
                    console.log(`[${label}]    Artifact data:`, JSON.stringify(artifactData, null, 2).substring(0, 500));
                    
                    // TODO: Store artifact content and associate with conversation
                    // For now, just log it
                  } catch (e) {
                    // Might be raw content (SVG, HTML, etc.)
                    console.log(`[${label}]    Raw artifact content:`, body.substring(0, 500));
                  }
                }
                
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
              // Only log unexpected errors, not common DevTools protocol failures
              const errMsg = err?.message || '';
              if (errMsg && !errMsg.includes('No resource') && !errMsg.includes('No data found')) {
                console.debug(`[${label}] Response body unavailable:`, errMsg || 'unknown');
              }
            });
          }
        } else if (method === 'Network.dataReceived') {
          // Capture streaming data chunks (SSE)
          if (streamingResponses.has(params.requestId)) {
            const streamData = streamingResponses.get(params.requestId);
            // Removed verbose logging for streaming data chunks
            
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
              
              // Removed verbose logging - only log errors
            }).catch(err => {
              // Might not be available yet, that's okay
            });
          }
        } else if (method === 'Network.loadingFinished') {
          // Stream completed - process all chunks
          if (streamingResponses.has(params.requestId)) {
            const streamData = streamingResponses.get(params.requestId);
            streamData.complete = true;
            
            // Stream finished - logging reduced to avoid terminal spam
            
            // Get the final complete response
            aiWindow.webContents.debugger.sendCommand('Network.getResponseBody', {
              requestId: params.requestId
            }).then(responseBody => {
              try {
                const body = responseBody.base64Encoded 
                  ? Buffer.from(responseBody.body, 'base64').toString('utf-8')
                  : responseBody.body;
                
                // Reduced logging - only log to structured logger, not console
                
                // Parse SSE format (data: ... \n\n)
                const sseEvents = [];
                const lines = body.split('\n');
                let currentEvent = {};
                let hasToolUse = false;
                
                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    const data = line.substring(6);
                    if (data === '[DONE]') {
                      break;
                    }
                    try {
                      const parsed = JSON.parse(data);
                      sseEvents.push(parsed);
                      
                      // Check for tool_use (artifacts)
                      if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
                        hasToolUse = true;
                        console.log(`[${label}] 🔧 TOOL_USE DETECTED:`, parsed.content_block.name);
                      }
                      
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
                
                if (hasToolUse) {
                  console.log(`[${label}] 📄 Artifact detected in stream, dumping full SSE events...`);
                  console.log(JSON.stringify(sseEvents, null, 2).substring(0, 5000));
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
                  // Find the content delta events and accumulate text
                  let fullText = '';
                  let artifacts = []; // Collect artifacts
                  let artifactInputs = new Map(); // Track artifact inputs by block index
                  let currentBlockIndex = -1;
                  let currentBlockId = null;
                  
                  for (const event of sseEvents) {
                    // Track content block index
                    if (event.type === 'content_block_start') {
                      currentBlockIndex = event.index !== undefined ? event.index : currentBlockIndex + 1;
                      currentBlockId = event.content_block?.id;
                    }
                    
                    if (event.type === 'content_block_delta' && event.delta?.text) {
                      fullText += event.delta.text;
                    } else if (event.delta?.text) {
                      fullText += event.delta.text;
                    } else if (event.message?.content) {
                      // Fallback for other formats (ChatGPT, Gemini, etc.)
                      if (typeof event.message.content === 'string') {
                        fullText += event.message.content;
                      } else if (Array.isArray(event.message.content)) {
                        fullText += event.message.content.map(c => c.text || '').join('');
                      }
                    }
                    
                    // Accumulate input_json_delta chunks for artifacts
                    if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
                      const blockKey = currentBlockId || currentBlockIndex;
                      if (!artifactInputs.has(blockKey)) {
                        artifactInputs.set(blockKey, '');
                      }
                      artifactInputs.set(blockKey, artifactInputs.get(blockKey) + event.delta.partial_json);
                    }
                    
                    // Check for artifacts in the event
                    if (event.type === 'content_block_start' && event.content_block) {
                      const block = event.content_block;
                      // Claude artifacts have type 'tool_use'
                      if (block.type === 'tool_use') {
                        artifacts.push({
                          ...block,
                          _blockKey: block.id || currentBlockIndex  // Track for later input reconstruction
                        });
                      }
                    }
                    
                    // Also check message.content array for artifacts
                    if (event.message?.content && Array.isArray(event.message.content)) {
                      for (const contentBlock of event.message.content) {
                        if (contentBlock.type === 'tool_use' || (contentBlock.type && contentBlock.type !== 'text' && contentBlock.content)) {
                          artifacts.push(contentBlock);
                        }
                      }
                    }
                  }
                  
                  // Reconstruct artifact inputs from accumulated JSON deltas
                  for (const artifact of artifacts) {
                    const blockKey = artifact._blockKey;
                    if (blockKey && artifactInputs.has(blockKey)) {
                      try {
                        const inputJson = artifactInputs.get(blockKey);
                        artifact.input = JSON.parse(inputJson);
                        console.log(`[${label}] 🔧 Reconstructed input for ${artifact.name}:`, JSON.stringify(artifact.input).substring(0, 300));
                      } catch (e) {
                        console.log(`[${label}] ⚠️ Failed to parse input JSON for ${artifact.name}:`, e.message);
                      }
                    }
                    delete artifact._blockKey; // Clean up temporary key
                  }
                  
                  if (artifacts.length > 0) {
                    console.log(`[${label}] ✅ Total artifacts captured: ${artifacts.length}`);
                  }
                  
                  // Add downloaded artifacts to the artifacts array
                  if (global.pendingArtifacts && global.pendingArtifacts.length > 0) {
                    console.log(`[${label}] 📦 Adding ${global.pendingArtifacts.length} downloaded artifacts to response`);
                    artifacts.push(...global.pendingArtifacts);
                    global.pendingArtifacts = []; // Clear pending artifacts
                  }
                  
                  const lastEvent = sseEvents[sseEvents.length - 1];
                  let messageText = fullText || null;
                  
                  // Legacy extraction for other AI services
                  if (!messageText && lastEvent.message && lastEvent.message.content) {
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
                    
                    // Capture response for conversation history
                    if (conversationCapture && aiType === 'chat') {
                      try {
                        // Extract conversation ID from URL
                        let externalConversationId = null;
                        
                        if (aiService === 'Claude') {
                          // Claude: /api/organizations/.../chat_conversations/UUID/completion
                          const match = streamData.url.match(/chat_conversations\/([a-f0-9\-]+)/i);
                          if (match) {
                            externalConversationId = match[1];
                            console.log(`[ConversationCapture] Extracted Claude conversation ID from response: ${externalConversationId}`);
                          }
                        } else if (aiService === 'ChatGPT') {
                          // ChatGPT: /backend-api/conversation/{conversation_id}
                          const urlMatch = streamData.url.match(/\/conversation\/([a-f0-9\-]+)/i);
                          if (urlMatch) {
                            externalConversationId = urlMatch[1];
                            console.log(`[ConversationCapture] Extracted ChatGPT conversation ID from response URL: ${externalConversationId}`);
                          }
                          // Note: For responses, we typically don't have access to the payload,
                          // so we rely on URL matching or the ID carried over from the request
                        }
                        
                        
                        conversationCapture.captureResponse(aiService, {
                          message: messageText,
                          events: sseEvents,
                          artifacts: artifacts, // Pass artifacts
                          requestId: params.requestId,
                          timestamp: new Date().toISOString(),
                          externalConversationId  // Pass the conversation ID
                        }).catch(err => {
                          console.error('[ConversationCapture] Error capturing response:', err);
                        });
                      } catch (err) {
                        console.error('[ConversationCapture] Error in captureResponse:', err);
                      }
                    }
                  }
                }
                
              } catch (err) {
                console.error(`[${label}] Error parsing streaming response:`, err);
              }
            }).catch(err => {
              // Only log unexpected errors
              const errMsg = err?.message || '';
              if (errMsg && !errMsg.includes('No resource') && !errMsg.includes('No data found')) {
                console.debug(`[${label}] Streaming response body unavailable:`, errMsg || 'unknown');
              }
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
      const filename = item.getFilename();
      console.log(`[${label}] Download detected:`, filename);
      
      // Check if this is an artifact download from Claude
      const isArtifact = label === 'Claude' && 
                         (filename.endsWith('.docx') || 
                          filename.endsWith('.pdf') || 
                          filename.endsWith('.xlsx') || 
                          filename.endsWith('.pptx') ||
                          filename.endsWith('.zip') ||
                          filename.endsWith('.html') ||
                          filename.endsWith('.csv') ||
                          filename.endsWith('.txt'));
      
      if (isArtifact && conversationCapture) {
        console.log(`[${label}] 📦 Artifact download detected: ${filename}`);
        
        // Hook into the 'done' event to capture after download completes
        // We let handleDownloadWithSpaceOption manage the save path
        item.once('done', (event, state) => {
          if (state === 'completed') {
            // Get the actual save path (set by handleDownloadWithSpaceOption)
            const savePath = item.getSavePath();
            console.log(`[${label}] ✅ Artifact downloaded, capturing from: ${savePath}`);
            
            // Small delay to ensure file is fully written
            setTimeout(() => {
              conversationCapture.captureDownloadedArtifact(label, {
                filename: filename,
                path: savePath,
                size: item.getTotalBytes(),
                mimeType: item.getMimeType(),
                url: item.getURL()
              }).catch(err => {
                console.error(`[${label}] Failed to capture downloaded artifact:`, err);
              });
            }, 100);
          } else {
            console.warn(`[${label}] Download ${state} for: ${filename}`);
          }
        });
      }
      
      // Use normal download handler for user (it will set the save path)
      browserWindow.handleDownloadWithSpaceOption(item, label);
    });
    
    // Load the URL
    aiWindow.loadURL(url);
    
    // Inject initialization script after page loads
    aiWindow.webContents.on('did-finish-load', async () => {
      try {
        const fs = require('fs');
        const overlayPath = path.join(__dirname, 'src', 'ai-window-overlay.js');
        const overlayContent = fs.readFileSync(overlayPath, 'utf8');
        
        // Inject the initialization script
        await aiWindow.webContents.executeJavaScript(`
          (async function() {
            console.log('[External AI] Initializing conversation capture');
            
            // Load and inject overlay
            try {
              if (!window.api || !window.api.getOverlayScript) {
                console.error('[External AI] window.api not available');
                return;
              }
              
              const overlayContent = await window.api.getOverlayScript();
              
              if (!overlayContent) {
                console.error('[External AI] No overlay script content received');
                return;
              }
              
              const script = document.createElement('script');
              script.textContent = overlayContent;
              document.head.appendChild(script);
              console.log('[External AI] Overlay script injected successfully');
            } catch (error) {
              console.error('[External AI] Error injecting overlay:', error);
            }
          })();
        `);
        
        // Inject Spaces upload enhancer
        try {
          const enhancerPath = path.join(__dirname, 'browser-file-input-enhancer.js');
          const enhancerContent = fs.readFileSync(enhancerPath, 'utf8');
          console.log(`[${label}] Injecting Spaces upload enhancer (${enhancerContent.length} bytes)`);
          await aiWindow.webContents.executeJavaScript(enhancerContent);
          console.log(`[${label}] Spaces upload enhancer injected successfully`);
        } catch (error) {
          console.error(`[${label}] Error injecting spaces upload enhancer:`, error);
        }
        
        console.log(`[${label}] Conversation capture initialized`);
      } catch (error) {
        console.error(`[${label}] Error initializing conversation capture:`, error);
      }
    });
    
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

  /**
   * Run a prompt in a hidden Claude window and capture the response
   * @param {string} prompt - The prompt to send to Claude
   * @param {Object} options - Configuration options
   * @param {number} options.timeout - Timeout in ms (default: 120000)
   * @param {boolean} options.saveToSpaces - Whether to save to Spaces (default: true)
   * @returns {Promise<{success: boolean, response: string, conversationId?: string, error?: string}>}
   */
  async function runHeadlessClaudePrompt(prompt, options = {}) {
    const timeout = options.timeout || 120000;
    const saveToSpaces = options.saveToSpaces !== false;
    
    console.log('[Headless Claude] Starting headless prompt...');
    console.log('[Headless Claude] Prompt:', prompt.substring(0, 100) + (prompt.length > 100 ? '...' : ''));
    
    return new Promise((resolve, reject) => {
      let resolved = false;
      let hiddenWindow = null;
      let timeoutId = null;
      
      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (hiddenWindow && !hiddenWindow.isDestroyed()) {
          try {
            if (hiddenWindow.webContents.debugger.isAttached()) {
              hiddenWindow.webContents.debugger.detach();
            }
          } catch (e) { /* ignore */ }
          hiddenWindow.close();
        }
      };
      
      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        if (result.success) {
          resolve(result);
        } else {
          reject(new Error(result.error || 'Unknown error'));
        }
      };
      
      // Timeout handling
      timeoutId = setTimeout(() => {
        console.log('[Headless Claude] Timeout reached');
        finish({ success: false, error: 'Claude prompt timed out after ' + (timeout / 1000) + ' seconds' });
      }, timeout);
      
      try {
        // Create hidden window
        const windowConfig = {
          width: 1400,
          height: 900,
          show: false, // NEVER show
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
            partition: 'persist:claude', // Use existing Claude session
            preload: path.join(__dirname, 'preload-external-ai.js')
          }
        };
        
        hiddenWindow = new BrowserWindow(windowConfig);
        console.log('[Headless Claude] Hidden window created');
        
        // Track streaming responses
        const streamingResponses = new Map();
        let responseText = '';
        let conversationId = null;
        
        // Set up network interception via Chrome DevTools Protocol
        try {
          hiddenWindow.webContents.debugger.attach('1.3');
          hiddenWindow.webContents.debugger.sendCommand('Network.enable');
          console.log('[Headless Claude] Network debugger attached');
          
          hiddenWindow.webContents.debugger.on('message', (event, method, params) => {
            // Track request to completion endpoint
            if (method === 'Network.requestWillBeSent') {
              const request = params.request;
              if (request.url.includes('chat_conversations') && request.url.includes('completion')) {
                console.log('[Headless Claude] Detected completion request:', request.url);
                streamingResponses.set(params.requestId, {
                  url: request.url,
                  chunks: [],
                  complete: false
                });
                
                // Extract conversation ID
                const match = request.url.match(/chat_conversations\/([a-f0-9\-]+)/i);
                if (match) {
                  conversationId = match[1];
                  console.log('[Headless Claude] Conversation ID:', conversationId);
                }
              }
            }
            
            // Collect response data
            if (method === 'Network.dataReceived') {
              const streamData = streamingResponses.get(params.requestId);
              if (streamData) {
                // Data received event - we'll get actual content on loadingFinished
              }
            }
            
            // Response complete - get body
            if (method === 'Network.loadingFinished') {
              const streamData = streamingResponses.get(params.requestId);
              if (streamData && !streamData.complete) {
                streamData.complete = true;
                console.log('[Headless Claude] Response complete, fetching body...');
                
                // Get response body
                hiddenWindow.webContents.debugger.sendCommand('Network.getResponseBody', {
                  requestId: params.requestId
                }).then(response => {
                  const body = response.body;
                  console.log('[Headless Claude] Response body length:', body?.length || 0);
                  
                  if (body) {
                    // Parse SSE events
                    const lines = body.split('\n');
                    let fullText = '';
                    
                    for (const line of lines) {
                      if (line.startsWith('data: ')) {
                        const data = line.substring(6).trim();
                        if (!data || data === '[DONE]') continue;
                        
                        try {
                          const event = JSON.parse(data);
                          
                          // Claude content_block_delta format
                          if (event.type === 'content_block_delta' && event.delta?.text) {
                            fullText += event.delta.text;
                          } else if (event.delta?.text) {
                            fullText += event.delta.text;
                          }
                        } catch (e) {
                          // Skip non-JSON lines
                        }
                      }
                    }
                    
                    if (fullText) {
                      responseText = fullText;
                      console.log('[Headless Claude] Captured response:', fullText.substring(0, 200) + '...');
                      
                      // Optionally save to Spaces via conversation capture
                      if (saveToSpaces && conversationCapture) {
                        try {
                          conversationCapture.capturePrompt('Claude', {
                            message: prompt,
                            timestamp: new Date().toISOString(),
                            externalConversationId: conversationId
                          });
                          
                          conversationCapture.captureResponse('Claude', {
                            message: responseText,
                            timestamp: new Date().toISOString(),
                            externalConversationId: conversationId
                          });
                        } catch (err) {
                          console.error('[Headless Claude] Error saving to Spaces:', err);
                        }
                      }
                      
                      finish({
                        success: true,
                        response: responseText,
                        conversationId: conversationId
                      });
                    }
                  }
                }).catch(err => {
                  // Only log unexpected errors
                  const errMsg = err?.message || '';
                  if (errMsg && !errMsg.includes('No resource') && !errMsg.includes('No data found')) {
                    console.debug('[Headless Claude] Response body unavailable:', errMsg || 'unknown');
                  }
                });
              }
            }
          });
        } catch (err) {
          console.error('[Headless Claude] Error attaching debugger:', err);
          finish({ success: false, error: 'Failed to attach network debugger' });
          return;
        }
        
        // Check for login redirect
        hiddenWindow.webContents.on('did-navigate', (event, url) => {
          console.log('[Headless Claude] Navigated to:', url);
          if (url.includes('login') || url.includes('sign-in') || url.includes('oauth')) {
            finish({ success: false, error: 'Not logged in to Claude. Please log in first by opening Claude normally.' });
          }
        });
        
        // Load Claude new conversation page
        hiddenWindow.loadURL('https://claude.ai/new');
        console.log('[Headless Claude] Loading claude.ai/new...');
        
        // Inject prompt after page loads
        hiddenWindow.webContents.on('did-finish-load', async () => {
          console.log('[Headless Claude] Page loaded, waiting for DOM...');
          
          // Wait for the page to be fully interactive
          await new Promise(r => setTimeout(r, 3000));
          
          try {
            // Inject the prompt
            const injectionResult = await hiddenWindow.webContents.executeJavaScript(`
              (async function() {
                console.log('[Headless Claude Injection] Starting...');
                
                // Wait for input to appear
                let retries = 10;
                let input = null;
                
                while (retries > 0 && !input) {
                  input = document.querySelector('div[contenteditable="true"]') ||
                          document.querySelector('div.ProseMirror') ||
                          document.querySelector('[data-placeholder]');
                  if (!input) {
                    await new Promise(r => setTimeout(r, 500));
                    retries--;
                  }
                }
                
                if (!input) {
                  console.error('[Headless Claude Injection] Input not found after retries');
                  return { success: false, error: 'Input element not found - may need login' };
                }
                
                console.log('[Headless Claude Injection] Found input:', input.tagName, input.className);
                
                // Focus and set content
                input.focus();
                
                // For ProseMirror/contenteditable, we need to set innerHTML with a paragraph
                const promptText = ${JSON.stringify(prompt)};
                input.innerHTML = '<p>' + promptText + '</p>';
                
                // Dispatch input event
                input.dispatchEvent(new InputEvent('input', { 
                  bubbles: true, 
                  cancelable: true,
                  inputType: 'insertText',
                  data: promptText
                }));
                
                console.log('[Headless Claude Injection] Content set, looking for send button...');
                
                // Wait a moment for UI to update
                await new Promise(r => setTimeout(r, 500));
                
                // Find send button - Claude uses aria-label="Send Message" or similar
                let sendBtn = document.querySelector('button[aria-label*="Send"]') ||
                              document.querySelector('button[type="submit"]') ||
                              document.querySelector('button[data-testid="send-button"]') ||
                              // Fallback: look for button near the input
                              document.querySelector('form button:not([aria-label*="Attach"])');
                
                if (!sendBtn) {
                  // Try finding by icon or class
                  const buttons = document.querySelectorAll('button');
                  for (const btn of buttons) {
                    if (btn.querySelector('svg') && !btn.disabled && btn.offsetParent !== null) {
                      // Check if it's near the input area
                      const rect = btn.getBoundingClientRect();
                      if (rect.bottom > window.innerHeight - 200) {
                        sendBtn = btn;
                        break;
                      }
                    }
                  }
                }
                
                if (sendBtn) {
                  console.log('[Headless Claude Injection] Found send button, clicking...');
                  sendBtn.click();
                  return { success: true, message: 'Prompt submitted' };
                } else {
                  console.error('[Headless Claude Injection] Send button not found');
                  return { success: false, error: 'Send button not found' };
                }
              })();
            `);
            
            console.log('[Headless Claude] Injection result:', injectionResult);
            
            if (injectionResult && !injectionResult.success) {
              finish({ success: false, error: injectionResult.error || 'Failed to inject prompt' });
            }
            // Otherwise wait for network response via debugger
            
          } catch (err) {
            console.error('[Headless Claude] Error injecting prompt:', err);
            finish({ success: false, error: 'Failed to inject prompt: ' + err.message });
          }
        });
        
        // Handle window errors
        hiddenWindow.on('unresponsive', () => {
          console.log('[Headless Claude] Window unresponsive');
          finish({ success: false, error: 'Claude window became unresponsive' });
        });
        
      } catch (err) {
        console.error('[Headless Claude] Error:', err);
        finish({ success: false, error: err.message });
      }
    });
  }
  
  // Expose runHeadlessClaudePrompt globally for testing and IPC
  global.runHeadlessClaudePrompt = runHeadlessClaudePrompt;

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
    title: 'GSX Power User - App Health Dashboard',
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

// Function to open the new onboarding wizard (from Josh)
function openOnboardingWizard() {
  console.log('Opening onboarding wizard window...');
  
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
          "img-src 'self' data: blob: spaces: * https://*.onereach.ai; " +
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
        // Set flag to skip cleanup handlers during update install
        global.isUpdatingApp = true;
        // Use quitAndInstall with isForceRunAfter=true to ensure app relaunches on macOS
        // Small delay to ensure the dialog closes cleanly
        setTimeout(() => {
          autoUpdater.quitAndInstall(false, true);
        }, 100);
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
          message: 'Could not check for updates',
          detail: 'Unable to reach the update server. This could be due to:\n\n• No internet connection\n• GitHub is temporarily unavailable\n• No releases published yet\n\nPlease try again later.',
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

// Track usage (called from API services and GSX Create)
// Uses LLMUsageTracker as single entry point - it delegates to BudgetManager
ipcMain.handle('budget:trackUsage', async (event, provider, projectId, usage) => {
  try {
    const { getLLMUsageTracker } = require('./llm-usage-tracker');
    const llmTracker = getLLMUsageTracker();
    
    const feature = usage.operation?.includes('gsx') ? 'gsx-create' : 
                    usage.operation?.includes('chat') ? 'chat' : 'other';
    
    let result;
    if (provider === 'anthropic' || provider === 'claude') {
      result = llmTracker.trackClaudeCall({
        model: usage.model || 'claude-sonnet-4-5-20250929',
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        feature,
        purpose: usage.operation || 'api-call',
        projectId,
        spaceId: projectId,
        success: true
      });
    } else if (provider === 'openai') {
      result = llmTracker.trackOpenAICall({
        model: usage.model || 'gpt-5.2',
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        feature,
        purpose: usage.operation || 'api-call',
        projectId,
        spaceId: projectId,
        success: true
      });
    } else {
      // Fallback for other providers - track directly to BudgetManager
      result = budgetManager.trackUsage({
        provider,
        model: usage.model || 'unknown',
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        projectId,
        feature,
        operation: usage.operation || 'api-call',
        success: true
      });
    }
    
    // Notify budget dashboard if open
    if (budgetDashboardWindow && !budgetDashboardWindow.isDestroyed()) {
      budgetDashboardWindow.webContents.send('budget:updated', result);
    }
    
    return result;
  } catch (trackingError) {
    console.error('[BudgetManager] Usage tracking failed:', trackingError.message);
    return null;
  }
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

// ==================== BUDGET QUERY (Chat/Voice) ====================

// Get budget status for chat/voice responses
ipcMain.handle('budget:getStatus', async (event, projectId = null) => {
  return budgetManager.getBudgetStatus(projectId);
});

// Answer a budget question (natural language)
ipcMain.handle('budget:answerQuestion', async (event, question, projectId = null) => {
  return budgetManager.answerBudgetQuestion(question, projectId);
});

// Get stats by feature
ipcMain.handle('budget:getStatsByFeature', async () => {
  return budgetManager.getStatsByFeature();
});

// Get stats by provider
ipcMain.handle('budget:getStatsByProvider', async () => {
  return budgetManager.getStatsByProvider();
});

// Get stats by model
ipcMain.handle('budget:getStatsByModel', async () => {
  return budgetManager.getStatsByModel();
});

// Get daily costs chart data
ipcMain.handle('budget:getDailyCosts', async (event, days = 30) => {
  return budgetManager.getDailyCosts(days);
});

// Set hard limit enforcement
ipcMain.handle('budget:setHardLimitEnabled', async (event, enabled) => {
  return budgetManager.setHardLimitEnabled(enabled);
});

// Set project-specific budget
ipcMain.handle('budget:setProjectBudget', async (event, projectId, limit, alertAt, hardLimit) => {
  return budgetManager.setProjectBudget(projectId, limit, alertAt, hardLimit);
});

// Get unified pricing from pricing-config.js
ipcMain.handle('pricing:getAll', async () => {
  const { PRICING, getPricingSummary } = require('./pricing-config');
  return { pricing: PRICING, summary: getPricingSummary() };
});

// Calculate cost using unified pricing
ipcMain.handle('pricing:calculate', async (event, model, inputTokens, outputTokens, options = {}) => {
  const { calculateCost } = require('./pricing-config');
  return calculateCost(model, inputTokens, outputTokens, options);
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

// ==================== VOICE ORB ====================

let orbIPCInitialized = false;
let orbShortcutRegistered = false;
let builtInAgents = [];

/**
 * Start built-in agents for the exchange
 * These agents handle common voice commands locally
 */
async function startBuiltInAgents(exchangeUrl) {
  console.log('[VoiceOrb] Starting built-in agents...');
  
  try {
    // Try to load and start the spelling agent
    const { createSpellingAgent } = require('./packages/agents/spelling-agent.js');
    const spellingAgent = createSpellingAgent(exchangeUrl);
    console.log('[VoiceOrb] Spelling agent created, connecting to', exchangeUrl);
    
    spellingAgent.on('connected', () => {
      console.log('[VoiceOrb] Spelling agent connected');
    });
    
    spellingAgent.on('disconnected', ({ reason }) => {
      console.log('[VoiceOrb] Spelling agent disconnected:', reason);
    });
    
    spellingAgent.on('reconnecting', ({ attempt }) => {
      console.log('[VoiceOrb] Spelling agent reconnecting, attempt', attempt);
    });
    
    spellingAgent.on('registered', ({ agentId }) => {
      console.log('[VoiceOrb] Spelling agent registered as:', agentId);
    });
    
    spellingAgent.on('error', ({ error }) => {
      console.error('[VoiceOrb] Spelling agent error:', error.message);
    });
    
    spellingAgent.on('bid:requested', ({ task }) => {
      console.log('[VoiceOrb] Spelling agent bid requested for:', task.content);
    });
    
    spellingAgent.on('bid:submitted', ({ confidence }) => {
      console.log('[VoiceOrb] Spelling agent bid submitted:', confidence);
    });
    
    spellingAgent.on('task:assigned', ({ task, isBackup }) => {
      console.log('[VoiceOrb] Spelling agent assigned task:', task.id, 'backup:', isBackup);
    });
    
    spellingAgent.on('task:completed', ({ taskId, success }) => {
      console.log(`[VoiceOrb] Spelling agent completed task ${taskId}: ${success}`);
    });
    
    await spellingAgent.start();
    builtInAgents.push(spellingAgent);
    console.log('[VoiceOrb] Spelling agent started');
    
  } catch (error) {
    console.warn('[VoiceOrb] Could not start spelling agent:', error.message);
    console.error('[VoiceOrb] Full error:', error.stack);
    console.log('[VoiceOrb] Make sure packages are compiled: cd packages && npm run build');
  }
  
  // Start user-defined dynamic agents
  try {
    const { startDynamicAgent } = require('./packages/agents/dynamic-agent');
    const dynamicAgent = await startDynamicAgent(exchangeUrl);
    if (dynamicAgent) {
      builtInAgents.push(dynamicAgent);
      console.log('[VoiceOrb] Dynamic user-defined agent started');
    }
  } catch (error) {
    console.warn('[VoiceOrb] Could not start dynamic agent:', error.message);
  }
  
  // Start GSX/MCS connections
  try {
    const { getAgentStore } = require('./src/voice-task-sdk/agent-store');
    const { getMCSManager } = require('./src/voice-task-sdk/gsx-mcs-client');
    
    const store = getAgentStore();
    await store.init();
    
    const gsxConnections = store.getEnabledGSXConnections();
    if (gsxConnections.length > 0) {
      const manager = getMCSManager();
      
      for (const conn of gsxConnections) {
        const client = manager.addClient(conn);
        
        client.on('connected', async () => {
          console.log(`[VoiceOrb] GSX connected: ${conn.name}`);
          // Fetch agents when connected
          try {
            const agents = await client.fetchAgents();
            await store.updateGSXAgents(conn.id, agents);
          } catch (e) {
            console.warn(`[VoiceOrb] Failed to fetch GSX agents:`, e.message);
          }
        });
        
        client.on('disconnected', () => {
          console.log(`[VoiceOrb] GSX disconnected: ${conn.name}`);
        });
      }
      
      // Connect all GSX clients
      await manager.connectAll();
      console.log(`[VoiceOrb] ${gsxConnections.length} GSX connections initiated`);
    }
  } catch (error) {
    console.warn('[VoiceOrb] Could not start GSX connections:', error.message);
  }
  
  console.log(`[VoiceOrb] ${builtInAgents.length} agents started`);
}

/**
 * Stop all built-in agents
 */
async function stopBuiltInAgents() {
  console.log('[VoiceOrb] Stopping built-in agents...');
  for (const agent of builtInAgents) {
    try {
      await agent.stop();
    } catch (error) {
      console.warn('[VoiceOrb] Error stopping agent:', error.message);
    }
  }
  builtInAgents = [];
}

/**
 * Initialize Voice Orb based on settings
 */
async function initializeVoiceOrb() {
  try {
    // Always setup IPC handlers so orb can be enabled dynamically
    if (!orbIPCInitialized) {
      setupOrbIPC();
      setupCommandHUDIPC();
      orbIPCInitialized = true;
    }
    
    // Always register the shortcut so it works even if orb starts disabled
    if (!orbShortcutRegistered) {
      const shortcut = process.platform === 'darwin' ? 'Command+Shift+O' : 'Ctrl+Shift+O';
      try {
        globalShortcut.register(shortcut, () => {
          toggleOrbWindow();
        });
        console.log(`[VoiceOrb] Registered global shortcut: ${shortcut}`);
        orbShortcutRegistered = true;
      } catch (shortcutError) {
        console.error('[VoiceOrb] Failed to register shortcut:', shortcutError.message);
      }
    }
    
    // Only auto-show orb at startup if enabled in settings
    const voiceOrbEnabled = global.settingsManager?.get('voiceOrbEnabled');
    
    if (!voiceOrbEnabled) {
      console.log('[VoiceOrb] Voice Orb disabled in settings (use menu or Cmd+Shift+O to show)');
      return;
    }
    
    console.log('[VoiceOrb] Initializing Voice Orb...');
    
    // Initialize Voice Task SDK for classification
    try {
      const { initializeVoiceTaskSDK } = require('./src/voice-task-sdk/integration');
      initializeVoiceTaskSDK({ useNewSpeechService: false });
      console.log('[VoiceOrb] Voice Task SDK initialized');
    } catch (sdkError) {
      console.error('[VoiceOrb] Voice Task SDK init error:', sdkError.message);
      // Continue anyway - orb will work for transcription
    }
    
    // Initialize Exchange Bridge for auction-based task routing
    try {
      const { initializeExchangeBridge, getExchangeUrl } = require('./src/voice-task-sdk/exchange-bridge');
      const exchangeReady = await initializeExchangeBridge();
      if (exchangeReady) {
        const url = getExchangeUrl();
        console.log('[VoiceOrb] Exchange Bridge initialized at', url);
        // Wait a moment for WebSocket server to be fully ready
        await new Promise(resolve => setTimeout(resolve, 500));
        // Start built-in agents (spelling, etc.)
        await startBuiltInAgents(url);
      } else {
        console.warn('[VoiceOrb] Exchange Bridge not available - using local classification');
      }
    } catch (exchangeError) {
      console.error('[VoiceOrb] Exchange Bridge init error:', exchangeError.message);
      console.error('[VoiceOrb] Full error:', exchangeError.stack);
      // Continue anyway - will fall back to local classification
    }
    
    // Create the orb window
    createOrbWindow();
    
    console.log('[VoiceOrb] Voice Orb initialized successfully');
    
  } catch (error) {
    console.error('[VoiceOrb] Initialization error:', error);
  }
}

/**
 * Setup IPC handlers for orb window controls
 */
function setupOrbIPC() {
  // Show orb window
  ipcMain.handle('orb:show', () => {
    if (orbWindow && !orbWindow.isDestroyed()) {
      orbWindow.show();
    }
  });
  
  // Hide orb window
  ipcMain.handle('orb:hide', () => {
    if (orbWindow && !orbWindow.isDestroyed()) {
      orbWindow.hide();
    }
  });
  
  // Toggle orb visibility
  ipcMain.handle('orb:toggle', () => {
    toggleOrbWindow();
  });
  
  // Set orb position (for drag support) - debounced save
  let orbPositionSaveTimeout = null;
  ipcMain.handle('orb:position', (event, x, y) => {
    if (orbWindow && !orbWindow.isDestroyed()) {
      const posX = Math.round(x);
      const posY = Math.round(y);
      orbWindow.setPosition(posX, posY);
      
      // Debounced save - only save after dragging stops for 500ms
      if (orbPositionSaveTimeout) {
        clearTimeout(orbPositionSaveTimeout);
      }
      orbPositionSaveTimeout = setTimeout(() => {
        if (global.settingsManager && orbWindow && !orbWindow.isDestroyed()) {
          // Get the actual position from Electron (may differ from what renderer sent)
          const [actualX, actualY] = orbWindow.getPosition();
          global.settingsManager.update({ voiceOrbPosition: { x: actualX, y: actualY } });
          console.log(`[VoiceOrb] Position saved: ${actualX}, ${actualY}`);
        }
      }, 500);
    }
  });
  
  // Handle orb click (could expand to panel in future)
  ipcMain.on('orb:clicked', () => {
    console.log('[VoiceOrb] Orb clicked');
    // Future: could show an expanded panel
  });
  
  // Relay voice input from Orb to Agent Composer
  ipcMain.handle('orb:relay-to-composer', (event, transcript) => {
    console.log('[VoiceOrb] Relaying to composer:', transcript.substring(0, 50));
    return relayVoiceToComposer(transcript);
  });
  
  // Check if Agent Composer is in creation mode
  ipcMain.handle('orb:is-composer-active', () => {
    return global.agentCreationMode === true && claudeCodeWindow && !claudeCodeWindow.isDestroyed();
  });
  
  // Resize orb window for text chat
  ipcMain.handle('orb:expand-for-chat', () => {
    if (orbWindow && !orbWindow.isDestroyed()) {
      const currentBounds = orbWindow.getBounds();
      const newWidth = 380;
      const newHeight = 520;
      // Keep bottom-right corner anchored
      const newX = currentBounds.x + currentBounds.width - newWidth;
      const newY = currentBounds.y + currentBounds.height - newHeight;
      orbWindow.setBounds({ x: newX, y: newY, width: newWidth, height: newHeight }, true);
      console.log('[VoiceOrb] Expanded for text chat:', newWidth, 'x', newHeight);
      return { width: newWidth, height: newHeight };
    }
  });
  
  ipcMain.handle('orb:collapse-from-chat', () => {
    if (orbWindow && !orbWindow.isDestroyed()) {
      const currentBounds = orbWindow.getBounds();
      const newWidth = 350;
      const newHeight = 250;
      // Keep bottom-right corner anchored
      const newX = currentBounds.x + currentBounds.width - newWidth;
      const newY = currentBounds.y + currentBounds.height - newHeight;
      orbWindow.setBounds({ x: newX, y: newY, width: newWidth, height: newHeight }, true);
      console.log('[VoiceOrb] Collapsed from text chat');
      return { width: newWidth, height: newHeight };
    }
  });
  
  console.log('[VoiceOrb] IPC handlers registered');
}

/**
 * Create the floating orb window
 */
function createOrbWindow() {
  if (orbWindow && !orbWindow.isDestroyed()) {
    orbWindow.show();
    return orbWindow;
  }
  
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;
  
  // Window dimensions - large enough for text chat panel above orb
  const windowWidth = 400;
  const windowHeight = 550;
  
  // Try to restore saved position, otherwise default to bottom-right
  let x, y;
  const savedPosition = global.settingsManager?.get('voiceOrbPosition');
  const savedWindowSize = global.settingsManager?.get('voiceOrbWindowSize');
  
  // Check if window size changed (reset position if so)
  const currentWindowSize = { width: windowWidth, height: windowHeight };
  
  // Debug position restore
  console.log('[VoiceOrb] Saved position:', JSON.stringify(savedPosition));
  
  // Only reset if window size actually changed, not on first run
  const windowSizeChanged = savedWindowSize && (
    savedWindowSize.width !== windowWidth || 
    savedWindowSize.height !== windowHeight
  );
  
  // Save window size if not saved yet (first run)
  if (!savedWindowSize) {
    global.settingsManager?.update({
      voiceOrbWindowSize: currentWindowSize
    });
    console.log('[VoiceOrb] First run, saved window size');
  } else if (windowSizeChanged) {
    // Window size changed, reset position
    global.settingsManager?.update({
      voiceOrbWindowSize: currentWindowSize,
      voiceOrbPosition: null
    });
    console.log('[VoiceOrb] Window size changed, resetting position');
  }
  
  if (savedPosition && typeof savedPosition.x === 'number' && typeof savedPosition.y === 'number' && !windowSizeChanged) {
    // Validate position is still on screen
    // The orb is at bottom-right of window (right: 20px, bottom: 20px, size: 80x80)
    // Orb's left edge is at windowX + 250, right edge at windowX + 330
    // Orb's top edge is at windowY + 150, bottom edge at windowY + 230
    // Allow negative window positions as long as the orb itself is visible
    const orbLeftEdge = savedPosition.x + 250;
    const orbRightEdge = savedPosition.x + 330;
    const orbTopEdge = savedPosition.y + 150;
    const orbBottomEdge = savedPosition.y + 230;
    
    const orbVisible = orbRightEdge > 50 && orbLeftEdge < screenWidth - 50 &&
                       orbBottomEdge > 50 && orbTopEdge < screenHeight - 50;
    
    if (orbVisible) {
      x = savedPosition.x;
      y = savedPosition.y;
      console.log(`[VoiceOrb] Restoring saved position: ${x}, ${y}`);
    } else {
      // Position off screen, use default
      x = screenWidth - windowWidth - 20;
      y = screenHeight - windowHeight - 20;
      console.log(`[VoiceOrb] Saved position off screen (orb edges: L=${orbLeftEdge}, R=${orbRightEdge}, T=${orbTopEdge}, B=${orbBottomEdge}), using default`);
    }
  } else {
    // No saved position or window size changed, use default bottom-right
    x = screenWidth - windowWidth - 20;
    y = screenHeight - windowHeight - 20;
  }
  
  // Create window at default position first (Electron clamps negative values in constructor)
  const defaultX = screenWidth - windowWidth - 20;
  const defaultY = screenHeight - windowHeight - 20;
  
  orbWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: defaultX,
    y: defaultY,
    alwaysOnTop: true,
    transparent: true,
    frame: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-orb.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  
  // Now move to saved position (setPosition allows negative values, unlike constructor)
  if (x !== defaultX || y !== defaultY) {
    orbWindow.setPosition(x, y);
    console.log(`[VoiceOrb] Moved to saved position: ${x}, ${y}`);
  }
  
  // Set window level to float above everything
  orbWindow.setAlwaysOnTop(true, 'floating');
  orbWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  
  // Restore dock/menu visibility on macOS (setVisibleOnAllWorkspaces can hide it)
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show().catch(() => {});
  }
  
  // Load the orb UI
  orbWindow.loadFile(path.join(__dirname, 'orb.html'));
  
  // Save position before closing
  orbWindow.on('close', () => {
    saveOrbPosition();
  });
  
  // Handle window close
  orbWindow.on('closed', () => {
    orbWindow = null;
  });
  
  console.log('[VoiceOrb] Orb window created');
  return orbWindow;
}

/**
 * Toggle orb window visibility
 */
function toggleOrbWindow() {
  if (!orbWindow || orbWindow.isDestroyed()) {
    // Create if not exists
    createOrbWindow();
  } else if (orbWindow.isVisible()) {
    orbWindow.hide();
  } else {
    orbWindow.show();
  }
}

/**
 * Show the orb window (for menu/external access)
 */
function showOrbWindow() {
  if (!orbWindow || orbWindow.isDestroyed()) {
    createOrbWindow();
  } else {
    orbWindow.show();
  }
}

/**
 * Hide the orb window (for menu/external access)
 */
function hideOrbWindow() {
  if (orbWindow && !orbWindow.isDestroyed()) {
    saveOrbPosition();
    orbWindow.hide();
  }
}

/**
 * Save current orb position to settings
 * Only saves position keys, doesn't affect other settings
 */
function saveOrbPosition() {
  if (orbWindow && !orbWindow.isDestroyed() && global.settingsManager) {
    try {
      const [x, y] = orbWindow.getPosition();
      global.settingsManager.update({ voiceOrbPosition: { x, y } });
      console.log(`[VoiceOrb] Position saved: ${x}, ${y}`);
    } catch (error) {
      console.error('[VoiceOrb] Error saving position:', error);
    }
  }
}

// ==================== COMMAND HUD ====================

/**
 * Create the Command HUD window for displaying task status
 */
function createCommandHUDWindow() {
  if (commandHUDWindow && !commandHUDWindow.isDestroyed()) {
    return commandHUDWindow;
  }
  
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;
  
  // HUD size - tall enough to show all content without scrollbars
  const windowWidth = 340;
  const windowHeight = 420;
  
  // Position: above the orb, centered
  const orbWidth = 80;
  const orbHeight = 80;
  const spacing = 20;
  
  // Default position (bottom right, above where orb typically is)
  let x = screenWidth - windowWidth - 40;
  let y = screenHeight - windowHeight - orbHeight - spacing - 30;
  
  // If orb exists, position directly above it
  if (orbWindow && !orbWindow.isDestroyed()) {
    const [orbX, orbY] = orbWindow.getPosition();
    
    // Center HUD above orb
    x = orbX + (orbWidth / 2) - (windowWidth / 2);
    y = orbY - windowHeight - spacing;
    
    // Make sure it stays on screen
    x = Math.max(10, Math.min(x, screenWidth - windowWidth - 10));
    y = Math.max(10, Math.min(y, screenHeight - windowHeight - 10));
  }
  
  commandHUDWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: x,
    y: y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false, // Start hidden
    webPreferences: {
      preload: path.join(__dirname, 'preload-command-hud.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  
  // Set window level to float above everything
  commandHUDWindow.setAlwaysOnTop(true, 'floating');
  commandHUDWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  
  // Restore dock/menu visibility on macOS (setVisibleOnAllWorkspaces can hide it)
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show().catch(() => {});
  }
  
  // Load the HUD UI
  commandHUDWindow.loadFile(path.join(__dirname, 'command-hud.html'));
  
  // Handle window close
  commandHUDWindow.on('closed', () => {
    commandHUDWindow = null;
  });
  
  console.log('[CommandHUD] HUD window created');
  return commandHUDWindow;
}

/**
 * Show the Command HUD with a task
 */
function showCommandHUD(task) {
  if (!commandHUDWindow || commandHUDWindow.isDestroyed()) {
    createCommandHUDWindow();
  }
  
  // Reposition near orb but not overlapping
  if (orbWindow && !orbWindow.isDestroyed()) {
    const [orbX, orbY] = orbWindow.getPosition();
    const display = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = display.workAreaSize;
    
    // HUD is 340x420, orb is 80x80
    const hudWidth = 340;
    const hudHeight = 420;
    const orbWidth = 80;
    const orbHeight = 80;
    const spacing = 20; // Gap between HUD and orb
    
    // Position HUD directly above the orb, centered horizontally
    let x = orbX + (orbWidth / 2) - (hudWidth / 2);
    let y = orbY - hudHeight - spacing;
    
    // Make sure it stays on screen
    x = Math.max(10, Math.min(x, screenWidth - hudWidth - 10));
    y = Math.max(10, Math.min(y, screenHeight - hudHeight - 10));
    
    // If HUD would overlap orb vertically (not enough room above), check if there's room below
    if (y + hudHeight + spacing > orbY) {
      // Try below the orb
      y = orbY + orbHeight + spacing;
      if (y + hudHeight > screenHeight - 10) {
        // Not enough room below either, just put it as high as possible
        y = 10;
      }
    }
    
    commandHUDWindow.setPosition(Math.round(x), Math.round(y));
  }
  
  // Send task to HUD
  if (commandHUDWindow && !commandHUDWindow.isDestroyed()) {
    commandHUDWindow.webContents.send('hud:task', task);
    commandHUDWindow.show();
  }
}

/**
 * Hide the Command HUD
 */
function hideCommandHUD() {
  if (commandHUDWindow && !commandHUDWindow.isDestroyed()) {
    commandHUDWindow.hide();
  }
}

/**
 * Send result to Command HUD
 */
function sendCommandHUDResult(result) {
  if (commandHUDWindow && !commandHUDWindow.isDestroyed()) {
    commandHUDWindow.webContents.send('hud:result', result);
  }
}

/**
 * Reset Command HUD to empty state
 */
function resetCommandHUD() {
  if (commandHUDWindow && !commandHUDWindow.isDestroyed()) {
    commandHUDWindow.webContents.send('hud:reset');
  }
}

/**
 * Setup Command HUD IPC handlers
 */
function setupCommandHUDIPC() {
  // Show HUD
  ipcMain.handle('command-hud:show', (event, task) => {
    showCommandHUD(task);
  });
  
  // Hide HUD
  ipcMain.handle('command-hud:hide', () => {
    hideCommandHUD();
  });
  
  // Send task update
  ipcMain.handle('command-hud:task', (event, task) => {
    if (commandHUDWindow && !commandHUDWindow.isDestroyed()) {
      commandHUDWindow.webContents.send('hud:task', task);
    }
  });
  
  // Send result
  ipcMain.handle('command-hud:result', (event, result) => {
    sendCommandHUDResult(result);
  });
  
  // Dismiss from HUD
  ipcMain.on('hud:dismiss', () => {
    hideCommandHUD();
  });
  
  // Retry from HUD
  ipcMain.on('hud:retry', (event, task) => {
    console.log('[CommandHUD] Retry requested for task:', task?.action);
    // Re-submit the task through voice task SDK
    if (task && task.transcript) {
      // Emit retry event for the orb to handle
      if (orbWindow && !orbWindow.isDestroyed()) {
        orbWindow.webContents.send('hud:retry-task', task);
      }
    }
  });
  
  // Position update
  ipcMain.handle('hud:position', (event, x, y) => {
    if (commandHUDWindow && !commandHUDWindow.isDestroyed()) {
      commandHUDWindow.setPosition(Math.round(x), Math.round(y));
    }
  });
  
  // ==================== CONTEXT MENU ====================
  
  // Show context menu on right-click
  ipcMain.on('hud:show-context-menu', async () => {
    if (!commandHUDWindow || commandHUDWindow.isDestroyed()) return;
    
    const { Menu } = require('electron');
    
    // Get available agents
    let agents = [];
    try {
      const { getAgentStore } = require('./src/voice-task-sdk/agent-store');
      const store = getAgentStore();
      agents = await store.getAllAgents();
    } catch (e) {
      console.log('[CommandHUD] Could not load agents for context menu:', e.message);
    }
    
    // Build agents submenu
    const agentsSubmenu = agents.length > 0 
      ? agents.map(agent => ({
          label: agent.type === 'gsx' ? `[GSX] ${agent.name}` : agent.name,
          click: () => {
            commandHUDWindow.webContents.send('hud:action:trigger-agent', agent);
          }
        }))
      : [{ label: 'No agents configured', enabled: false }];
    
    // Add "Manage Agents" at the end
    agentsSubmenu.push({ type: 'separator' });
    agentsSubmenu.push({
      label: 'Manage Agents...',
      click: () => {
        createAgentManagerWindow();
      }
    });
    
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Switch to Text Input',
        click: () => {
          commandHUDWindow.webContents.send('hud:action:text-input');
        }
      },
      { type: 'separator' },
      {
        label: 'Trigger Agent',
        submenu: agentsSubmenu
      },
      { type: 'separator' },
      {
        label: 'Manage Agents...',
        click: () => {
          createAgentManagerWindow();
        }
      },
      {
        label: 'Settings...',
        click: () => {
          const { openSettingsWindow } = require('./main.js');
          if (typeof openSettingsWindow === 'function') {
            openSettingsWindow();
          } else {
            // Fallback: send IPC to open settings
            const mainWindow = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
            if (mainWindow) {
              mainWindow.webContents.send('menu-action', { action: 'settings' });
            }
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Dismiss',
        click: () => {
          hideCommandHUD();
        }
      }
    ]);
    
    contextMenu.popup({ window: commandHUDWindow });
  });
  
  // Trigger specific agent with transcript
  ipcMain.handle('hud:trigger-agent', async (event, { agentId, transcript }) => {
    console.log('[CommandHUD] Triggering agent:', agentId, 'with:', transcript);
    
    try {
      // Submit with agent hint so exchange routes directly
      const { getExchange } = require('./src/voice-task-sdk/exchange-bridge');
      const exchange = getExchange();
      
      if (exchange) {
        const result = await exchange.submit({
          content: transcript,
          metadata: {
            source: 'text',
            targetAgent: agentId,
          },
        });
        return { success: true, taskId: result.taskId };
      }
      
      return { success: false, error: 'Exchange not available' };
    } catch (error) {
      console.error('[CommandHUD] Trigger agent error:', error);
      return { success: false, error: error.message };
    }
  });
  
  console.log('[CommandHUD] IPC handlers registered');
}

// Make HUD functions available globally for Voice Task SDK integration
global.showCommandHUD = showCommandHUD;
global.hideCommandHUD = hideCommandHUD;
global.sendCommandHUDResult = sendCommandHUDResult;
global.resetCommandHUD = resetCommandHUD;

// ==================== VOICE TTS (ElevenLabs) ====================

let voiceTTSAudio = null;

function setupVoiceTTS() {
  console.log('[VoiceTTS] Setting up voice TTS handlers...');
  
  // Speak text using ElevenLabs TTS
  ipcMain.handle('voice:speak', async (event, text, voice = 'Rachel') => {
    try {
      // Import ElevenLabsService dynamically
      const { ElevenLabsService } = await import('./src/video/audio/ElevenLabsService.js');
      const elevenLabs = new ElevenLabsService();
      
      // Check if API key is configured
      const apiKey = elevenLabs.getApiKey();
      if (!apiKey) {
        console.warn('[VoiceTTS] ElevenLabs API key not configured');
        return null;
      }
      
      // Generate audio
      console.log('[VoiceTTS] Generating speech:', text.substring(0, 50) + '...');
      const audioPath = await elevenLabs.generateAudio(text, voice, {
        projectId: 'voice-mode',
        operation: 'tts'
      });
      
      console.log('[VoiceTTS] Audio generated:', audioPath);
      return audioPath;
      
    } catch (error) {
      console.error('[VoiceTTS] Error generating speech:', error);
      return null;
    }
  });
  
  // Stop TTS playback (handled client-side, but we can track state)
  ipcMain.handle('voice:stop', async () => {
    console.log('[VoiceTTS] Stop requested');
    return true;
  });
  
  // Check if TTS is available
  ipcMain.handle('voice:is-available', async () => {
    try {
      const { ElevenLabsService } = await import('./src/video/audio/ElevenLabsService.js');
      const elevenLabs = new ElevenLabsService();
      const apiKey = elevenLabs.getApiKey();
      return { available: !!apiKey };
    } catch (e) {
      return { available: false, error: e.message };
    }
  });
  
  // List available voices
  ipcMain.handle('voice:list-voices', async () => {
    try {
      const { ElevenLabsService } = await import('./src/video/audio/ElevenLabsService.js');
      const elevenLabs = new ElevenLabsService();
      const voices = await elevenLabs.listVoices();
      return { success: true, voices };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  
  console.log('[VoiceTTS] Voice TTS handlers registered');
}

// ==================== AGENT MANAGER ====================

let agentManagerWindow = null;

/**
 * Create and show the agent manager window
 */
function createAgentManagerWindow() {
  if (agentManagerWindow && !agentManagerWindow.isDestroyed()) {
    agentManagerWindow.focus();
    return agentManagerWindow;
  }
  
  console.log('[AgentManager] Creating agent manager window...');
  
  agentManagerWindow = new BrowserWindow({
    width: 900,
    height: 800,
    minWidth: 600,
    minHeight: 600,
    title: 'Manage Agents',
    frame: false,
    transparent: false,
    backgroundColor: '#1a1a24',
    center: true,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-agent-manager.js'),
      webSecurity: true,
      sandbox: false
    }
  });
  
  // Clear the reference when closed
  agentManagerWindow.on('closed', () => {
    console.log('[AgentManager] Window closed');
    agentManagerWindow = null;
  });
  
  // Load the agent manager HTML
  agentManagerWindow.loadFile('agent-manager.html').catch(err => {
    console.error('[AgentManager] Error loading agent-manager.html:', err);
  });
  
  agentManagerWindow.webContents.on('did-finish-load', () => {
    console.log('[AgentManager] Window loaded successfully');
  });
  
  return agentManagerWindow;
}

/**
 * Setup Agent Manager IPC handlers
 */
function setupAgentManagerIPC() {
  const { getAgentStore, initAgentStore } = require('./src/voice-task-sdk/agent-store');
  
  // Initialize agent store
  initAgentStore().catch(err => {
    console.error('[AgentManager] Failed to initialize agent store:', err);
  });
  
  // Close window
  ipcMain.on('agent-manager:close', () => {
    if (agentManagerWindow && !agentManagerWindow.isDestroyed()) {
      agentManagerWindow.close();
    }
  });
  
  // Open agent manager
  ipcMain.on('agents:open-manager', () => {
    createAgentManagerWindow();
  });
  
  // ==================== LOCAL AGENTS ====================
  
  // Get all local agents
  ipcMain.handle('agents:get-local', async () => {
    const store = getAgentStore();
    await store.init();
    return store.getLocalAgents();
  });
  
  // Get all agents (local + GSX)
  ipcMain.handle('agents:list', async () => {
    const store = getAgentStore();
    await store.init();
    return store.getAllAgents();
  });
  
  // Create agent
  ipcMain.handle('agents:create', async (event, agentData) => {
    const store = getAgentStore();
    return store.createAgent(agentData);
  });
  
  // Update agent
  ipcMain.handle('agents:update', async (event, id, updates) => {
    const store = getAgentStore();
    return store.updateAgent(id, updates);
  });
  
  // Delete agent
  ipcMain.handle('agents:delete', async (event, id) => {
    const store = getAgentStore();
    return store.deleteAgent(id);
  });
  
  // ==================== AGENT VERSION HISTORY ====================
  
  // Get version history for an agent
  ipcMain.handle('agents:get-versions', async (event, agentId) => {
    const store = getAgentStore();
    await store.init();
    return store.getVersionHistory(agentId);
  });
  
  // Get a specific version
  ipcMain.handle('agents:get-version', async (event, agentId, versionNumber) => {
    const store = getAgentStore();
    await store.init();
    return store.getVersion(agentId, versionNumber);
  });
  
  // Undo last change
  ipcMain.handle('agents:undo', async (event, agentId) => {
    const store = getAgentStore();
    await store.init();
    return store.undoAgent(agentId);
  });
  
  // Revert to specific version
  ipcMain.handle('agents:revert', async (event, agentId, versionNumber) => {
    const store = getAgentStore();
    await store.init();
    return store.revertToVersion(agentId, versionNumber);
  });
  
  // Compare two versions
  ipcMain.handle('agents:compare-versions', async (event, agentId, versionA, versionB) => {
    const store = getAgentStore();
    await store.init();
    return store.compareVersions(agentId, versionA, versionB);
  });
  
  // ==================== GSX CONNECTIONS ====================
  
  // Get GSX connections
  ipcMain.handle('gsx:get-connections', async () => {
    const store = getAgentStore();
    await store.init();
    return store.getGSXConnections();
  });
  
  // Add GSX connection
  ipcMain.handle('gsx:add-connection', async (event, connData) => {
    const store = getAgentStore();
    return store.addGSXConnection(connData);
  });
  
  // Update GSX connection
  ipcMain.handle('gsx:update-connection', async (event, id, updates) => {
    const store = getAgentStore();
    return store.updateGSXConnection(id, updates);
  });
  
  // Delete GSX connection
  ipcMain.handle('gsx:delete-connection', async (event, id) => {
    const store = getAgentStore();
    return store.deleteGSXConnection(id);
  });
  
  // ==================== BUILTIN AGENTS ====================
  
  // Get all builtin agents from registry (single source of truth)
  ipcMain.handle('agents:get-builtin-list', async () => {
    try {
      const { getAllAgents } = require('./packages/agents/agent-registry');
      const agents = getAllAgents();
      // Return serializable agent info for frontend
      return agents.map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
        categories: a.categories,
        keywords: a.keywords,
        capabilities: a.capabilities,
        builtin: true,
      }));
    } catch (error) {
      console.error('[AgentManager] Failed to get builtin agents:', error);
      return [];
    }
  });
  
  // Get enabled states for all builtin agents
  ipcMain.handle('agents:get-builtin-states', async () => {
    if (global.settingsManager) {
      return global.settingsManager.get('builtinAgentStates') || {};
    }
    return {};
  });
  
  // Set enabled state for a builtin agent
  ipcMain.handle('agents:set-builtin-enabled', async (event, agentId, enabled) => {
    if (global.settingsManager) {
      const states = global.settingsManager.get('builtinAgentStates') || {};
      states[agentId] = enabled;
      global.settingsManager.set('builtinAgentStates', states);
      return true;
    }
    return false;
  });
  
  // ==================== AGENT TESTING ====================
  
  // Test a single agent with a phrase
  ipcMain.handle('agents:test-phrase', async (event, agentId, phrase) => {
    try {
      const { evaluateAgentBid } = require('./packages/agents/unified-bidder');
      const { getAgent: getBuiltinAgent } = require('./packages/agents/agent-registry');
      const store = getAgentStore();
      await store.init();
      
      // Get the agent - check custom agents first, then builtin registry
      let agent = store.getAgent(agentId);
      
      // If not a custom agent, check builtin agents from registry
      if (!agent) {
        agent = getBuiltinAgent(agentId);
      }
      
      if (!agent) {
        return { confidence: 0, plan: 'Agent not found', error: 'Agent not found' };
      }
      
      const result = await evaluateAgentBid(agent, { content: phrase });
      return {
        agentId,
        agentName: agent.name,
        confidence: result.confidence,
        plan: result.plan,
        reasoning: result.plan,
      };
    } catch (error) {
      console.error('[AgentManager] Test phrase error:', error);
      return { confidence: 0, plan: error.message, error: error.message };
    }
  });
  
  // Test all enabled agents with a phrase
  ipcMain.handle('agents:test-phrase-all', async (event, phrase) => {
    try {
      const { evaluateAgentBid } = require('./packages/agents/unified-bidder');
      const { getAllAgents: getBuiltinAgents } = require('./packages/agents/agent-registry');
      const store = getAgentStore();
      await store.init();
      
      // Get custom agents
      const customAgents = store.getLocalAgents().filter(a => a.enabled);
      
      // Get enabled builtin agents from registry (single source of truth)
      const builtinStates = global.settingsManager?.get('builtinAgentStates') || {};
      const builtinAgents = getBuiltinAgents().filter(a => builtinStates[a.id] !== false);
      
      const allAgents = [...customAgents, ...builtinAgents];
      
      // Evaluate all agents in parallel
      const evaluations = await Promise.all(
        allAgents.map(async (agent) => {
          try {
            const result = await evaluateAgentBid(agent, { content: phrase });
            return {
              agentId: agent.id,
              agentName: agent.name,
              confidence: result.confidence,
              plan: result.plan,
              reasoning: result.plan,
            };
          } catch (err) {
            return {
              agentId: agent.id,
              agentName: agent.name,
              confidence: 0,
              plan: err.message,
              error: err.message,
            };
          }
        })
      );
      
      return evaluations;
    } catch (error) {
      console.error('[AgentManager] Test all agents error:', error);
      return [];
    }
  });

  // Execute an agent directly (bypasses Exchange for testing)
  ipcMain.handle('agents:execute-direct', async (event, agentId, phrase) => {
    try {
      const { getAgent: getBuiltinAgent } = require('./packages/agents/agent-registry');
      const store = getAgentStore();
      await store.init();

      // Get the agent - check custom agents first, then builtin registry
      let agent = store.getAgent(agentId);
      if (!agent) {
        agent = getBuiltinAgent(agentId);
      }

      if (!agent) {
        return { success: false, error: `Agent ${agentId} not found` };
      }

      if (!agent.execute || typeof agent.execute !== 'function') {
        return { success: false, error: `Agent ${agentId} has no execute method` };
      }

      // Get agent's ack and voice for display
      let ack = null;
      if (agent.acks && Array.isArray(agent.acks) && agent.acks.length > 0) {
        ack = agent.acks[Math.floor(Math.random() * agent.acks.length)];
      } else if (agent.ack) {
        ack = agent.ack;
      }
      const voice = agent.voice || 'alloy';

      // Initialize agent if needed
      if (agent.initialize && typeof agent.initialize === 'function') {
        await agent.initialize();
      }

      // Execute the agent
      const task = { id: `test_${Date.now()}`, content: phrase };
      const startTime = Date.now();
      const result = await agent.execute(task);
      const executionTime = Date.now() - startTime;

      return {
        success: result.success !== false,
        message: result.message || result.result || result.output,
        data: result.data,
        needsInput: result.needsInput,
        executionTime,
        agentId,
        // Include ack and voice for test UI display
        ack,
        voice,
        // Include orchestration info if present (for multi-agent coordination)
        orchestrated: result.orchestrated || false,
        agentsUsed: result.agentsUsed || null,
      };
    } catch (error) {
      console.error('[AgentManager] Execute direct error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get API key for auto-test phrase generation
  ipcMain.handle('agents:get-api-key', async () => {
    if (global.settingsManager) {
      const openaiKey = global.settingsManager.get('openaiApiKey');
      if (openaiKey) return openaiKey;
      const provider = global.settingsManager.get('llmProvider');
      const llmKey = global.settingsManager.get('llmApiKey');
      if (provider === 'openai' && llmKey) return llmKey;
    }
    return process.env.OPENAI_API_KEY || null;
  });

  // ==================== VERSION HISTORY (aliases) ====================
  
  // Get version history (alias for agents:get-versions)
  ipcMain.handle('agents:get-version-history', async (event, agentId) => {
    const store = getAgentStore();
    await store.init();
    return store.getVersionHistory(agentId);
  });
  
  // Revert to version (alias for agents:revert)
  ipcMain.handle('agents:revert-to-version', async (event, agentId, versionNumber) => {
    const store = getAgentStore();
    await store.init();
    return store.revertToVersion(agentId, versionNumber);
  });
  
  // ==================== ENHANCE AGENT ====================
  
  // Open Agent Composer in enhance mode
  ipcMain.handle('agents:enhance', async (event, agentId) => {
    const store = getAgentStore();
    await store.init();
    const agent = store.getAgent(agentId);
    
    if (!agent) {
      throw new Error('Agent not found');
    }
    
    // Open the composer with enhance mode and agent context
    createClaudeCodeWindow({
      mode: 'enhance',
      existingAgent: agent
    });
    
    return true;
  });
  
  // ==================== AGENT STATISTICS ====================
  
  // Get stats for a single agent
  ipcMain.handle('agents:get-stats', async (event, agentId) => {
    try {
      const { getAgentStats } = require('./src/voice-task-sdk/agent-stats');
      const stats = getAgentStats();
      await stats.init();
      return stats.getStats(agentId);
    } catch (error) {
      console.error('[AgentManager] Get stats error:', error);
      return null;
    }
  });
  
  // Get stats for all agents
  ipcMain.handle('agents:get-all-stats', async () => {
    try {
      const { getAgentStats } = require('./src/voice-task-sdk/agent-stats');
      const stats = getAgentStats();
      await stats.init();
      return stats.getAllStats();
    } catch (error) {
      console.error('[AgentManager] Get all stats error:', error);
      return {};
    }
  });
  
  // Get bid history
  ipcMain.handle('agents:get-bid-history', async (event, limit) => {
    try {
      const { getAgentStats } = require('./src/voice-task-sdk/agent-stats');
      const stats = getAgentStats();
      await stats.init();
      return stats.getBidHistory(limit || 50);
    } catch (error) {
      console.error('[AgentManager] Get bid history error:', error);
      return [];
    }
  });
  
  // Get bid history for a specific agent
  ipcMain.handle('agents:get-agent-bid-history', async (event, agentId, limit) => {
    try {
      const { getAgentStats } = require('./src/voice-task-sdk/agent-stats');
      const stats = getAgentStats();
      await stats.init();
      return stats.getAgentBidHistory(agentId, limit || 20);
    } catch (error) {
      console.error('[AgentManager] Get agent bid history error:', error);
      return [];
    }
  });
  
  console.log('[AgentManager] IPC handlers registered');
}

// ==================== CLAUDE CODE UI ====================

let claudeCodeWindow = null;
let pendingComposerInit = null; // Store initial description while window loads

/**
 * Create and show the GSX Agent Composer window
 * @param {Object} options - Optional configuration
 * @param {string} options.initialDescription - Initial agent description to auto-plan
 * @param {string} options.mode - 'create' (default) or 'enhance'
 * @param {Object} options.existingAgent - Agent to enhance (when mode='enhance')
 */
function createClaudeCodeWindow(options = {}) {
  const { initialDescription, mode, existingAgent } = options;
  
  if (claudeCodeWindow && !claudeCodeWindow.isDestroyed()) {
    claudeCodeWindow.focus();
    
    // If window already exists, send the appropriate init message
    if (mode === 'enhance' && existingAgent) {
      claudeCodeWindow.webContents.send('agent-composer:init', { 
        mode: 'enhance',
        existingAgent
      });
    } else if (initialDescription) {
      claudeCodeWindow.webContents.send('agent-composer:init', { 
        description: initialDescription 
      });
    }
    return claudeCodeWindow;
  }
  
  console.log('[AgentComposer] Creating GSX Create window...');
  
  // Store the init data to send after window loads
  if (mode === 'enhance' && existingAgent) {
    pendingComposerInit = { mode: 'enhance', existingAgent };
  } else {
    pendingComposerInit = initialDescription ? { description: initialDescription } : null;
  }
  
  claudeCodeWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    title: 'GSX Agent Composer',
    frame: false,
    transparent: false,
    backgroundColor: '#1a1a24',
    center: true,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-claude-code.js'),
      webSecurity: true,
      sandbox: false
    }
  });
  
  // Clear the reference when closed
  claudeCodeWindow.on('closed', () => {
    console.log('[AgentComposer] Window closed');
    claudeCodeWindow = null;
    // Clear agent creation mode when composer closes
    global.agentCreationMode = false;
  });
  
  // Load the GSX Create UI HTML
  claudeCodeWindow.loadFile('claude-code-ui.html').catch(err => {
    console.error('[AgentComposer] Error loading claude-code-ui.html:', err);
  });
  
  claudeCodeWindow.webContents.on('did-finish-load', () => {
    console.log('[AgentComposer] Window loaded successfully');
    
    // Send the initial description if we have one
    if (pendingComposerInit) {
      console.log('[AgentComposer] Sending initial description:', pendingComposerInit.description);
      claudeCodeWindow.webContents.send('agent-composer:init', pendingComposerInit);
      pendingComposerInit = null;
    }
  });
  
  return claudeCodeWindow;
}

// ==================== Claude Code In-App Terminal (PTY) ====================

let claudeTerminalWindow = null;
let claudePty = null;

/**
 * Create and show the Claude Code terminal window for login
 */
function createClaudeTerminalWindow() {
  if (claudeTerminalWindow && !claudeTerminalWindow.isDestroyed()) {
    claudeTerminalWindow.focus();
    return;
  }
  
  claudeTerminalWindow = new BrowserWindow({
    width: 800,
    height: 500,
    title: 'Claude Code Login',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-claude-terminal.js'),
    }
  });
  
  claudeTerminalWindow.loadFile('claude-terminal.html');
  
  claudeTerminalWindow.on('closed', () => {
    claudeTerminalWindow = null;
    // Kill PTY if still running
    if (claudePty) {
      try {
        claudePty.kill();
      } catch (e) {
        // Ignore
      }
      claudePty = null;
    }
  });
}

/**
 * Register Claude Terminal IPC handlers
 */
function registerClaudeTerminalHandlers() {
  // Start Claude Code PTY
  ipcMain.handle('claude-terminal:start', async (event, cols, rows) => {
    try {
      // Kill existing PTY if any
      if (claudePty) {
        try {
          claudePty.kill();
        } catch (e) {
          // Ignore
        }
      }
      
      const pty = require('node-pty');
      const claudeCodeRunner = require('./lib/claude-code-runner');
      const claudePath = claudeCodeRunner.getClaudeCodePath();
      
      console.log('[ClaudeTerminal] Starting PTY with claude at:', claudePath);
      
      // Spawn claude in PTY
      claudePty = pty.spawn(claudePath, [], {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: process.env.HOME,
        env: process.env,
      });
      
      // Forward output to renderer
      claudePty.onData((data) => {
        if (claudeTerminalWindow && !claudeTerminalWindow.isDestroyed()) {
          claudeTerminalWindow.webContents.send('claude-terminal:output', data);
        }
      });
      
      // Handle exit
      claudePty.onExit(({ exitCode }) => {
        console.log('[ClaudeTerminal] PTY exited with code:', exitCode);
        if (claudeTerminalWindow && !claudeTerminalWindow.isDestroyed()) {
          claudeTerminalWindow.webContents.send('claude-terminal:exit', exitCode);
        }
        claudePty = null;
      });
      
      return { success: true };
    } catch (error) {
      console.error('[ClaudeTerminal] Failed to start PTY:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Write to PTY
  ipcMain.on('claude-terminal:write', (event, data) => {
    if (claudePty) {
      claudePty.write(data);
    }
  });
  
  // Resize PTY
  ipcMain.on('claude-terminal:resize', (event, cols, rows) => {
    if (claudePty) {
      try {
        claudePty.resize(cols, rows);
      } catch (e) {
        console.warn('[ClaudeTerminal] Resize error:', e.message);
      }
    }
  });
  
  // Kill PTY
  ipcMain.on('claude-terminal:kill', () => {
    if (claudePty) {
      try {
        claudePty.kill();
      } catch (e) {
        // Ignore
      }
      claudePty = null;
    }
  });
  
  console.log('[ClaudeTerminal] IPC handlers registered');
}

/**
 * Broadcast plan summary to all windows (for Orb TTS)
 */
function broadcastPlanSummary(summary) {
  const { BrowserWindow } = require('electron');
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send('agent-composer:plan-summary', summary);
    }
  });
}

/**
 * Send voice command to Agent Composer
 */
function relayVoiceToComposer(transcript) {
  if (claudeCodeWindow && !claudeCodeWindow.isDestroyed()) {
    claudeCodeWindow.webContents.send('agent-composer:voice-input', { transcript });
    return true;
  }
  return false;
}

/**
 * Setup Claude Code IPC handlers
 */
function setupClaudeCodeIPC() {
  const { getAgentStore } = require('./src/voice-task-sdk/agent-store');
  const { generateAgentFromDescription } = require('./lib/ai-agent-generator');
  const { TEMPLATES, getTemplates, getTemplate } = require('./lib/claude-code-templates');
  
  // Get all templates
  ipcMain.handle('claude-code:templates', () => {
    return getTemplates();
  });
  
  // Get a specific template
  ipcMain.handle('claude-code:template', (event, templateId) => {
    return getTemplate(templateId);
  });
  
  // Get agent type templates
  ipcMain.handle('claude-code:agent-types', () => {
    try {
      const { getAgentTemplates } = require('./lib/ai-agent-generator');
      return getAgentTemplates();
    } catch (error) {
      console.error('[AgentComposer] Error getting agent types:', error);
      return [];
    }
  });
  
  // Score templates against description (for auto-highlighting)
  // DEPRECATED: Old keyword-based scoring - kept for compatibility
  ipcMain.handle('agent-composer:score-templates', (event, description) => {
    try {
      const { scoreAllTemplates } = require('./lib/agent-templates');
      return scoreAllTemplates(description || '');
    } catch (error) {
      console.error('[AgentComposer] Error scoring templates:', error);
      return [];
    }
  });
  
  // LLM-based agent planning using Claude Code CLI (for full agentic capabilities)
  ipcMain.handle('agent-composer:plan', async (event, description) => {
    try {
      const claudeCode = require('./lib/claude-code-runner');
      const { getTemplates } = require('./lib/agent-templates');
      
      const templates = getTemplates();
      
      // Convert templates to a format the planner can use
      const templateInfo = {};
      for (const t of templates) {
        templateInfo[t.id] = {
          name: t.name,
          description: t.description,
          capabilities: t.capabilities,
          executionType: t.executionType,
        };
      }
      
      console.log('[AgentComposer] Planning agent for:', description.substring(0, 50) + '...');
      console.log('[AgentComposer] Using Claude Code CLI for agentic features');
      
      const result = await claudeCode.planAgent(description, templateInfo);
      
      if (result.success) {
        console.log('[AgentComposer] Plan created via CLI:', result.plan.executionType, '-', result.plan.suggestedName);
      } else {
        console.error('[AgentComposer] CLI plan failed:', result.error);
        // Fallback to direct API if CLI fails
        console.log('[AgentComposer] Falling back to direct API...');
        const ClaudeAPI = require('./claude-api');
        const claudeAPI = new ClaudeAPI();
        const fallbackResult = await claudeAPI.planAgent(description, templateInfo);
        if (fallbackResult.success) {
          console.log('[AgentComposer] Fallback plan created:', fallbackResult.plan.executionType, '-', fallbackResult.plan.suggestedName);
        }
        return fallbackResult;
      }
      
      return result;
    } catch (error) {
      console.error('[AgentComposer] Planning error:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Broadcast plan summary to Orb for TTS
  ipcMain.handle('agent-composer:broadcast-plan', async (event, planSummary) => {
    console.log('[AgentComposer] Broadcasting plan summary:', planSummary.substring(0, 50) + '...');
    broadcastPlanSummary({
      type: 'plan-ready',
      summary: planSummary,
      timestamp: Date.now()
    });
    return { success: true };
  });
  
  // Notify that agent creation is complete
  ipcMain.handle('agent-composer:creation-complete', async (event, agentName) => {
    console.log('[AgentComposer] Agent creation complete:', agentName);
    global.agentCreationMode = false;
    broadcastPlanSummary({
      type: 'creation-complete',
      agentName,
      timestamp: Date.now()
    });
    return { success: true };
  });
  
  // Generate agent from description (Phase 1)
  ipcMain.handle('claude-code:generate-agent', async (event, description, options = {}) => {
    try {
      console.log('[AgentComposer] Generating agent from description:', description.substring(0, 50) + '...');
      if (options.templateId) {
        console.log('[AgentComposer] Using template:', options.templateId);
      }
      
      // Generate agent config using Claude API
      const config = await generateAgentFromDescription(description, options);
      
      // Save to agent store
      const store = getAgentStore();
      await store.init();
      const agent = await store.createAgent(config);
      
      console.log('[AgentComposer] Agent created:', agent.name);
      
      return { success: true, agent };
    } catch (error) {
      console.error('[AgentComposer] Agent generation failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // ==================== AGENT SELF-VERIFICATION SYSTEM ====================
  
  /**
   * Verify if an action was successful based on execution type
   * Returns: { verified: boolean, method: string, details: string }
   */
  /**
   * Verify if an agent action was successful
   * Supports multiple verification methods based on execution type and app
   */
  async function verifyAgentAction(execAsync, executionType, actionContext) {
    const { appName, action, expectedResult, script, output } = actionContext;
    
    try {
      // ==================== APPLESCRIPT VERIFICATION ====================
      if (executionType === 'applescript' && appName) {
        // First verify app is running
        const { stdout: runningApps } = await execAsync(`osascript -e 'tell application "System Events" to get name of every process'`);
        const isRunning = runningApps.toLowerCase().includes(appName.toLowerCase());
        
        if (!isRunning) {
          return { 
            verified: false, 
            method: 'process-check', 
            details: `${appName} is not running`,
            suggestion: `Try opening ${appName} first with: open -a "${appName}"`
          };
        }
        
        // ===== MUSIC APP =====
        if (appName.toLowerCase() === 'music') {
          const { stdout: state } = await execAsync(`osascript -e 'tell application "Music" to get player state'`);
          const playerState = state.trim();
          
          if (action === 'play') {
            if (playerState === 'playing') {
              const { stdout: track } = await execAsync(`osascript -e 'tell application "Music" to get name of current track'`).catch(() => ({ stdout: 'Unknown' }));
              const { stdout: artist } = await execAsync(`osascript -e 'tell application "Music" to get artist of current track'`).catch(() => ({ stdout: '' }));
              return { 
                verified: true, 
                method: 'state-check', 
                details: `Playing: "${track.trim()}"${artist.trim() ? ` by ${artist.trim()}` : ''}` 
              };
            } else {
              return { 
                verified: false, 
                method: 'state-check', 
                details: `Player state: ${playerState}`,
                suggestion: 'Select a track first with: play (some track of library playlist 1)'
              };
            }
          } else if (action === 'pause' || action === 'stop') {
            return { 
              verified: playerState === 'paused' || playerState === 'stopped', 
              method: 'state-check', 
              details: `Player state: ${playerState}` 
            };
          } else if (action === 'open') {
            return { verified: true, method: 'process-check', details: `Music is open (state: ${playerState})` };
          }
          return { verified: false, method: 'state-check', details: `Player state: ${playerState}` };
        }
        
        // ===== SAFARI =====
        if (appName.toLowerCase() === 'safari') {
          try {
            const { stdout: url } = await execAsync(`osascript -e 'tell application "Safari" to get URL of current tab of window 1'`);
            const { stdout: title } = await execAsync(`osascript -e 'tell application "Safari" to get name of current tab of window 1'`).catch(() => ({ stdout: '' }));
            
            if (action === 'open-url' && expectedResult?.url) {
              const urlMatches = url.includes(expectedResult.url);
              return { 
                verified: urlMatches, 
                method: 'url-check', 
                details: urlMatches ? `Opened: ${url.trim().substring(0, 60)}` : `Wrong URL: ${url.trim().substring(0, 60)}`
              };
            }
            return { 
              verified: true, 
              method: 'state-check', 
              details: `${title.trim() || 'Safari'} - ${url.trim().substring(0, 50)}` 
            };
          } catch (e) {
            return { verified: true, method: 'process-check', details: 'Safari is open (no tabs)' };
          }
        }
        
        // ===== FINDER =====
        if (appName.toLowerCase() === 'finder') {
          try {
            const { stdout: folder } = await execAsync(`osascript -e 'tell application "Finder" to get POSIX path of (target of front window as alias)'`);
            return { 
              verified: true, 
              method: 'state-check', 
              details: `Finder at: ${folder.trim()}` 
            };
          } catch (e) {
            return { verified: true, method: 'process-check', details: 'Finder is open' };
          }
        }
        
        // ===== MAIL =====
        if (appName.toLowerCase() === 'mail') {
          try {
            const { stdout: count } = await execAsync(`osascript -e 'tell application "Mail" to get count of messages of inbox'`);
            return { 
              verified: true, 
              method: 'state-check', 
              details: `Mail open (${count.trim()} messages in inbox)` 
            };
          } catch (e) {
            return { verified: true, method: 'process-check', details: 'Mail is open' };
          }
        }
        
        // ===== CALENDAR =====
        if (appName.toLowerCase() === 'calendar') {
          return { verified: true, method: 'process-check', details: 'Calendar is open' };
        }
        
        // ===== NOTES =====
        if (appName.toLowerCase() === 'notes') {
          return { verified: true, method: 'process-check', details: 'Notes is open' };
        }
        
        // ===== TERMINAL =====
        if (appName.toLowerCase() === 'terminal') {
          return { verified: true, method: 'process-check', details: 'Terminal is open' };
        }
        
        // ===== SPOTIFY =====
        if (appName.toLowerCase() === 'spotify') {
          try {
            const { stdout: state } = await execAsync(`osascript -e 'tell application "Spotify" to get player state'`);
            if (action === 'play' && state.trim() === 'playing') {
              const { stdout: track } = await execAsync(`osascript -e 'tell application "Spotify" to get name of current track'`).catch(() => ({ stdout: 'Unknown' }));
              return { verified: true, method: 'state-check', details: `Playing: ${track.trim()}` };
            }
            return { verified: true, method: 'process-check', details: `Spotify (${state.trim()})` };
          } catch (e) {
            return { verified: true, method: 'process-check', details: 'Spotify is open' };
          }
        }
        
        // ===== GENERIC APP - check if frontmost =====
        const { stdout: frontApp } = await execAsync(`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`);
        const isFront = frontApp.trim().toLowerCase().includes(appName.toLowerCase());
        return { 
          verified: isFront, 
          method: 'frontmost-check', 
          details: isFront ? `${appName} is active` : `Front app: ${frontApp.trim()}`,
          suggestion: isFront ? null : `Try activating with: tell application "${appName}" to activate`
        };
      }
      
      // ==================== SHELL COMMAND VERIFICATION ====================
      if (executionType === 'shell') {
        // Check if specific file should exist
        if (expectedResult?.fileExists) {
          const { stdout } = await execAsync(`test -e "${expectedResult.fileExists}" && echo "exists" || echo "missing"`);
          const exists = stdout.trim() === 'exists';
          return { 
            verified: exists, 
            method: 'file-check', 
            details: exists ? `File exists: ${expectedResult.fileExists}` : `File not found: ${expectedResult.fileExists}` 
          };
        }
        
        // Check if directory should exist
        if (expectedResult?.dirExists) {
          const { stdout } = await execAsync(`test -d "${expectedResult.dirExists}" && echo "exists" || echo "missing"`);
          const exists = stdout.trim() === 'exists';
          return { 
            verified: exists, 
            method: 'dir-check', 
            details: exists ? `Directory exists: ${expectedResult.dirExists}` : `Directory not found: ${expectedResult.dirExists}` 
          };
        }
        
        // Check if output contains expected string
        if (expectedResult?.outputContains && output) {
          const contains = output.includes(expectedResult.outputContains);
          return { 
            verified: contains, 
            method: 'output-check', 
            details: contains ? `Output contains expected text` : `Expected text not found in output` 
          };
        }
        
        // Check command exit code
        if (expectedResult?.exitCode !== undefined) {
          // Already checked by execAsync - if we got here, exit code was 0
          return { verified: true, method: 'exit-code', details: 'Command completed with expected exit code' };
        }
        
        // Generic shell - assume success if no error thrown
        return { 
          verified: true, 
          method: 'exit-code', 
          details: output ? `Output: ${output.substring(0, 100)}` : 'Command completed successfully' 
        };
      }
      
      // ==================== BROWSER AUTOMATION VERIFICATION ====================
      if (executionType === 'browser') {
        // Could integrate with Puppeteer/Playwright for verification
        return { verified: null, method: 'browser-check', details: 'Browser verification not yet implemented' };
      }
      
      // ==================== LLM (CONVERSATIONAL) VERIFICATION ====================
      if (executionType === 'llm') {
        // LLM agents can't self-verify - need user confirmation
        return { 
          verified: null, 
          method: 'user-confirmation', 
          details: 'Response generated - please confirm if it was helpful',
          needsUserConfirmation: true
        };
      }
      
      // ==================== DEFAULT ====================
      return { 
        verified: null, 
        method: 'none', 
        details: `Automatic verification not available for ${executionType} execution type` 
      };
      
    } catch (error) {
      return { 
        verified: false, 
        method: 'error', 
        details: error.message,
        suggestion: 'Check if the app/command is available on this system'
      };
    }
  }
  
  // Test an agent with a sample prompt - ACTUALLY EXECUTES the agent with SELF-VERIFICATION
  ipcMain.handle('claude-code:test-agent', async (event, agent, testPrompt) => {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    try {
      console.log('[AgentComposer] Testing agent:', agent.name, 'type:', agent.executionType, 'prompt:', testPrompt.substring(0, 50));
      
      // FAST PATH: If agent name contains a known app, just open it directly - skip Claude entirely
      const agentNameLower = agent.name?.toLowerCase() || '';
      const knownApps = {
        'music': 'Music',
        'safari': 'Safari', 
        'finder': 'Finder',
        'mail': 'Mail',
        'calendar': 'Calendar',
        'notes': 'Notes',
        'photos': 'Photos',
        'messages': 'Messages',
        'facetime': 'FaceTime',
        'maps': 'Maps',
        'calculator': 'Calculator',
        'preview': 'Preview',
        'terminal': 'Terminal',
        'chrome': 'Google Chrome',
        'spotify': 'Spotify',
        'slack': 'Slack',
        'zoom': 'zoom.us',
        'vscode': 'Visual Studio Code',
        'code': 'Visual Studio Code',
      };
      
      for (const [keyword, appName] of Object.entries(knownApps)) {
        if (agentNameLower.includes(keyword)) {
          console.log('[AgentComposer] Fast path: Opening', appName);
          try {
            // Use both open AND AppleScript activate to ensure app comes to front
            await execAsync(`open -a "${appName}"`);
            // Force bring to front with AppleScript
            await execAsync(`osascript -e 'tell application "${appName}" to activate'`);
            
            // For Music app, also start playing if the prompt suggests it
            const promptLower = testPrompt.toLowerCase();
            console.log('[AgentComposer] Checking play condition:', { keyword, promptLower, hasPlay: promptLower.includes('play') });
            if (keyword === 'music' && (promptLower.includes('play') || promptLower.includes('start') || promptLower.includes('go'))) {
              console.log('[AgentComposer] Starting music playback');
              // Must select a track first, then play - just "play" doesn't work without selection
              await execAsync(`osascript -e 'tell application "Music"
                activate
                set shuffle enabled to true
                play (some track of library playlist 1)
                play
              end tell'`);
              console.log('[AgentComposer] Play command sent');
              
              // VERIFY: Use the verification system
              await new Promise(resolve => setTimeout(resolve, 500)); // Wait a moment
              const verification = await verifyAgentAction(execAsync, 'applescript', {
                appName: 'Music',
                action: 'play'
              });
              
              console.log('[AgentComposer] Verification result:', verification);
              
              if (verification.verified === true) {
                return { 
                  success: true, 
                  response: `✓ VERIFIED: ${verification.details}`,
                  executed: true,
                  verified: true,
                  verificationMethod: verification.method
                };
              } else if (verification.verified === false) {
                return { 
                  success: false, 
                  error: `Action executed but verification failed: ${verification.details}`,
                  executed: true,
                  verified: false,
                  verificationMethod: verification.method
                };
              } else {
                // Can't auto-verify, ask user
                return {
                  success: true,
                  response: `Action executed. ${verification.details}`,
                  executed: true,
                  verified: null,
                  needsUserConfirmation: true
                };
              }
            }
            
            // VERIFY: Check if app actually opened
            await new Promise(resolve => setTimeout(resolve, 300));
            const verification = await verifyAgentAction(execAsync, 'applescript', {
              appName: appName,
              action: 'open'
            });
            
            console.log('[AgentComposer] Verification result:', verification);
            
            if (verification.verified === true) {
              return { 
                success: true, 
                response: `✓ VERIFIED: ${appName} is now open and active`,
                executed: true,
                verified: true,
                verificationMethod: verification.method
              };
            } else {
              return { 
                success: true, 
                response: `Opened ${appName}. ${verification.details}`,
                executed: true,
                verified: verification.verified,
                verificationMethod: verification.method
              };
            }
          } catch (err) {
            console.error('[AgentComposer] Failed to open', appName, err.message);
            return { success: false, error: `Failed to open ${appName}: ${err.message}` };
          }
        }
      }
      
      const claudeCodeRunner = require('./lib/claude-code-runner');
      
      // For executable agent types, ask Claude Code to generate the command/script
      const executionType = agent.executionType || 'llm';
      
      if (executionType === 'applescript') {
        
        // Ask Claude Code to generate AppleScript for this task
        const scriptResponse = await claudeCodeRunner.complete(testPrompt, {
          systemPrompt: `${agent.prompt}

CRITICAL: Respond with ONLY the AppleScript command. No explanations.

KEY RULES:
- "open" an app = use "activate" (brings window to front)
- "play music" = use "activate" first to show the app, then "play"
- Always prefer "activate" to make apps visible

COMMAND REFERENCE:
- Open/launch app: tell application "AppName" to activate
- Play music: tell application "Music" to activate
- Open URL: tell application "Safari" to open location "https://url.com"
- Open file: tell application "Finder" to open POSIX file "/path/to/file"

For this request "${testPrompt}", respond with the single AppleScript command:`,
          maxTokens: 200,
          temperature: 0.0,
        });
        
        
        if (!scriptResponse) {
          return { success: false, error: 'No script generated' };
        }
        
        // Clean the script (remove any markdown or extra text)
        let script = scriptResponse.trim();
        script = script.replace(/^```applescript\n?/i, '').replace(/\n?```$/i, '');
        script = script.replace(/^```\n?/, '').replace(/\n?```$/, '');
        
        // Fix common incomplete scripts
        // "tell application X" without action -> add "to activate"
        if (script.match(/^tell application\s+"[^"]+"\s*$/i)) {
          script = script.replace(/^(tell application\s+"[^"]+")\s*$/i, '$1 to activate');
          console.log('[AgentComposer] Fixed incomplete script, added "to activate"');
        }
        
        // If script is just an app name, wrap it
        if (script.match(/^[A-Za-z\s]+$/)) {
          script = `tell application "${script}" to activate`;
          console.log('[AgentComposer] Wrapped app name in tell statement');
        }
        
        // If user asked to "open" something but script uses "play", change to "activate"
        const wantsToOpen = testPrompt.toLowerCase().match(/\b(open|launch|start|show)\b/);
        if (wantsToOpen && script.includes('to play')) {
          script = script.replace('to play', 'to activate');
          console.log('[AgentComposer] Changed "to play" to "to activate" for open request');
        }
        
        // For any "to play" on Music app, prepend activate to ensure app is visible
        if (script.includes('Music') && script.includes('to play')) {
          script = 'tell application "Music" to activate\n' + script;
          console.log('[AgentComposer] Prepended activate before play for Music app');
        }
        
        // Simple app detection - if agent name contains app name, use shell open command (most reliable)
        const agentNameLower = agent.name?.toLowerCase() || '';
        const appMatch = agentNameLower.match(/(music|safari|finder|mail|calendar|notes|photos|messages|facetime|maps|news|stocks|weather|calculator|preview)/i);
        if (appMatch) {
          const appName = appMatch[1].charAt(0).toUpperCase() + appMatch[1].slice(1);
          // Use shell open command - more reliable than AppleScript
          console.log('[AgentComposer] Using shell open for', appName);
          try {
            const { stdout, stderr } = await execAsync(`open -a "${appName}"`);
            console.log('[AgentComposer] Shell open succeeded for', appName);
            return { 
              success: true, 
              response: `Opened ${appName} successfully!`,
              executed: true
            };
          } catch (openError) {
            console.error('[AgentComposer] Shell open failed:', openError.message);
            // Fall through to try AppleScript
          }
        }
        
        console.log('[AgentComposer] Executing AppleScript:', script.substring(0, 100));
        
        // Execute the AppleScript
        try {
          const { stdout, stderr } = await execAsync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`);
          console.log('[AgentComposer] AppleScript executed successfully');
          return { 
            success: true, 
            response: `Executed successfully!\n\nScript: ${script}\n\n${stdout ? 'Output: ' + stdout : 'Action completed.'}`,
            executed: true
          };
        } catch (execError) {
          console.error('[AgentComposer] AppleScript error:', execError.message);
          return { success: false, error: `Script execution failed: ${execError.message}` };
        }
        
      } else if (executionType === 'shell') {
        // Ask Claude Code to generate shell command
        const cmdResponse = await claudeCodeRunner.complete(testPrompt, {
          systemPrompt: `${agent.prompt}

IMPORTANT: Respond with ONLY the shell command to execute, nothing else.
Do not include explanations - just the raw command.
For safety, prefer read-only or reversible commands.`,
        });
        
        if (!cmdResponse) {
          return { success: false, error: 'No command generated' };
        }
        
        let cmd = cmdResponse.trim();
        cmd = cmd.replace(/^```(bash|sh|shell)?\n?/i, '').replace(/\n?```$/i, '');
        
        // Safety check - don't run dangerous commands
        const dangerousPatterns = ['rm -rf', 'sudo', 'mkfs', 'dd if=', '> /dev/', 'chmod -R 777'];
        if (dangerousPatterns.some(p => cmd.includes(p))) {
          return { success: false, error: 'Command blocked for safety: ' + cmd };
        }
        
        console.log('[AgentComposer] Executing shell command:', cmd);
        
        try {
          const { stdout, stderr } = await execAsync(cmd, { timeout: 10000 });
          return { 
            success: true, 
            response: `Executed: ${cmd}\n\n${stdout || 'Command completed successfully.'}`,
            executed: true
          };
        } catch (execError) {
          return { success: false, error: `Command failed: ${execError.message}` };
        }
        
      } else {
        // LLM/conversational - just get a text response from Claude Code
        const response = await claudeCodeRunner.complete(testPrompt, {
          systemPrompt: agent.prompt,
        });
        
        if (response) {
          return { success: true, response };
        } else {
          return { success: false, error: 'No response from agent' };
        }
      }
      
    } catch (error) {
      console.error('[AgentComposer] Agent test failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // ==================== GSX Create Chat-Based Agent Building ====================
  
  // Check Claude Code authentication status
  ipcMain.handle('claude-code:check-auth', async () => {
    try {
      const claudeCode = require('./lib/claude-code-runner');
      return await claudeCode.isAuthenticated();
    } catch (error) {
      return { authenticated: false, error: error.message };
    }
  });
  
  // Trigger Claude Code login/setup
  ipcMain.handle('claude-code:login', async () => {
    try {
      const claudeCode = require('./lib/claude-code-runner');
      const authStatus = await claudeCode.isAuthenticated();
      
      if (authStatus.authenticated) {
        return { success: true, message: 'Already authenticated! Your Anthropic API key is configured.' };
      }
      
      // Not authenticated - open settings to add API key
      const { dialog, shell } = require('electron');
      const result = await dialog.showMessageBox({
        type: 'info',
        title: 'Claude Code Setup',
        message: 'API Key Required',
        detail: 'Claude Code uses your Anthropic API key from Settings.\n\nWould you like to open Settings to add your API key?',
        buttons: ['Open Settings', 'Cancel'],
        defaultId: 0,
      });
      
      if (result.response === 0) {
        // Open settings window
        const main = require('./main');
        if (main.openSetupWizard) {
          main.openSetupWizard();
        }
      }
      
      return { success: false, error: 'API key not configured' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
  
  // Claude Terminal IPC handlers are registered in registerClaudeTerminalHandlers()
  
  // Chat message for iterative agent building
  ipcMain.handle('gsx-create:chat', async (event, message, context = {}) => {
    try {
      console.log('[AgentComposer] Chat message:', message.substring(0, 50) + '...');
      
      const claudeCode = require('./lib/claude-code-runner');
      const { getTemplate: getAgentTemplate } = require('./lib/agent-templates');
      
      // Check Claude Code authentication (API key)
      const authCheck = await claudeCode.isAuthenticated();
      if (!authCheck.authenticated) {
        return { 
          success: false, 
          error: authCheck.error || 'Please add your Anthropic API key in Settings.',
          needsLogin: true
        };
      }
      
      // Get agent type template for context
      const agentTemplate = getAgentTemplate(context.agentTypeId || 'conversational');
      
      // Build matched types info
      const matchedTypesInfo = context.matchedTypes?.length > 0
        ? context.matchedTypes.map(t => `${t.id} (score: ${t.score}, keywords: ${t.matchedKeywords?.join(', ')})`).join('; ')
        : 'none detected';
      
      const selectedTypesInfo = context.selectedTypes?.length > 0
        ? context.selectedTypes.join(', ')
        : 'none selected';
      
      // Build conversation history for context
      const conversationHistory = (context.messageHistory || []).map(msg => ({
        role: msg.role,
        content: msg.content,
      }));
      
      // Build plan context if available
      const planContext = context.plan ? (() => {
        const plan = context.plan;
        const enabledFeatures = (plan.features || []).filter(f => f.enabled && f.feasible);
        const disabledFeatures = (plan.features || []).filter(f => !f.enabled && f.feasible);
        const infeasibleFeatures = (plan.features || []).filter(f => !f.feasible);
        
        return `
APPROVED PLAN (User has approved this approach):
- Understanding: ${plan.understanding}
- Execution Type: ${plan.executionType}
- Reasoning: ${plan.reasoning}
- Suggested Name: ${plan.suggestedName}
- Suggested Keywords: ${plan.suggestedKeywords?.join(', ')}

SELECTED FEATURES (MUST implement these):
${enabledFeatures.map(f => `- ${f.name}: ${f.description}`).join('\n') || '- No specific features selected'}

EXCLUDED FEATURES (User chose NOT to include):
${disabledFeatures.map(f => `- ${f.name}`).join('\n') || '- None excluded'}

NOT FEASIBLE (Cannot be implemented):
${infeasibleFeatures.map(f => `- ${f.name}: ${f.feasibilityReason}`).join('\n') || '- All features are feasible'}

APPROACH:
${plan.approach?.steps?.map((s, i) => `${i + 1}. ${s}`).join('\n')}

VERIFICATION: ${plan.verification?.verificationMethod || 'user confirmation'}

TEST PLAN (Agent will be tested with these):
${plan.testPlan?.tests?.map((t, i) => `${i + 1}. "${t.testPrompt}" → ${t.expectedBehavior}`).join('\n') || 'No specific tests defined'}

BUILD THE AGENT ACCORDING TO THIS PLAN. Use execution type "${plan.executionType}".
Implement ALL selected features. Do NOT implement excluded or infeasible features.
Ensure the agent will pass the test plan above.
`;
      })() : '';

      // Build system prompt for agent creation chat
      const systemPrompt = `You are GSX Agent Composer, an AI assistant that helps users build voice agents through conversation.

Your job is to:
1. Build the agent according to the approved plan (if provided)
2. If no plan, understand what kind of agent the user wants
3. Generate and refine agent configurations based on feedback
4. Be helpful and concise
${planContext}

EXECUTION TYPE REFERENCE:
- "applescript": macOS app control (Music, Finder, Safari, Mail, etc.), window management, system dialogs
- "shell": terminal commands, file operations, git, npm, scripts
- "llm": conversations, Q&A, advice, creative writing (no system access)
- "browser": web automation, scraping, form filling
- "system": volume, brightness, display settings

${!context.plan ? `Auto-detected types: ${matchedTypesInfo}\nUser-selected types: ${selectedTypesInfo}` : ''}

IMPORTANT: Generate an agent configuration as a JSON block:
\`\`\`agent
{
  "name": "Agent Name",
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "prompt": "System prompt for the agent - be specific",
  "categories": ["category"],
  "executionType": "${context.plan?.executionType || 'llm'}",
  "capabilities": ["capability1", "capability2"],
  "verification": {
    "type": "auto or user",
    "method": "How to verify success",
    "successIndicator": "What indicates success"
  }
}
\`\`\`

Keep responses brief. Focus on building the agent.`;

      // Add the new user message
      conversationHistory.push({ role: 'user', content: message });
      
      // Call Claude Code CLI (uses browser login, no API key needed)
      const response = await claudeCode.chat(conversationHistory, {
        system: systemPrompt,
      });
      
      if (!response?.success || !response?.content) {
        return { success: false, error: response?.error || 'No response from Claude Code' };
      }
      
      const responseText = response.content;
      
      // Parse agent draft from response if present
      // Try multiple formats: ```agent, ```json, or raw JSON
      let agentDraft = context.currentDraft;
      const agentMatch = responseText.match(/```agent\s*([\s\S]*?)\s*```/) ||
                         responseText.match(/```json\s*([\s\S]*?)\s*```/) ||
                         responseText.match(/```\s*(\{[\s\S]*?\})\s*```/);
      
      // Also try to match raw JSON at the start or end of response
      const rawJsonMatch = !agentMatch && responseText.match(/(\{[\s\S]*"name"[\s\S]*"keywords"[\s\S]*\})/);
      
      const jsonToParse = agentMatch ? agentMatch[1] : (rawJsonMatch ? rawJsonMatch[1] : null);
      
      if (jsonToParse) {
        try {
          const parsedAgent = JSON.parse(jsonToParse);
          // Validate it looks like an agent (has name or keywords)
          if (parsedAgent.name || parsedAgent.keywords) {
            agentDraft = {
              ...parsedAgent,
              executionType: parsedAgent.executionType || agentTemplate?.executionType || 'llm',
              templateId: context.agentTypeId || 'conversational',
            };
            console.log('[AgentComposer] Parsed agent draft:', agentDraft.name);
          }
        } catch (parseError) {
          console.warn('[AgentComposer] Could not parse agent JSON:', parseError);
        }
      }
      
      // Clean the response text (remove all code blocks and raw JSON for display)
      let cleanResponse = responseText
        .replace(/```agent\s*[\s\S]*?\s*```/g, '')  // Remove ```agent blocks
        .replace(/```json\s*[\s\S]*?\s*```/g, '')   // Remove ```json blocks
        .replace(/```javascript\s*[\s\S]*?\s*```/g, '')  // Remove ```javascript blocks
        .replace(/```\s*\{[\s\S]*?\}\s*```/g, '')   // Remove ``` blocks containing JSON objects
        .trim();
      
      // If the remaining response looks like raw JSON, don't display it
      if (cleanResponse.startsWith('{') && cleanResponse.endsWith('}')) {
        cleanResponse = '';
      }
      
      // If response is mostly JSON-like content, provide a friendly message
      if (!cleanResponse || cleanResponse.length < 20) {
        if (agentDraft) {
          cleanResponse = `I've created the **${agentDraft.name || 'agent'}** configuration. Check the preview on the right!`;
        } else {
          cleanResponse = 'I\'ve updated the agent configuration. Check the preview!';
        }
      }
      
      return {
        success: true,
        response: cleanResponse,
        agentDraft,
      };
      
    } catch (error) {
      console.error('[AgentComposer] Chat error:', error);
      return { success: false, error: error.message || String(error) };
    }
  });
  
  // Save finalized agent
  ipcMain.handle('gsx-create:save-agent', async (event, agentDraft) => {
    try {
      console.log('[AgentComposer] Saving agent:', agentDraft.name);
      
      const { getAgentStore } = require('./src/voice-task-sdk/agent-store');
      const store = getAgentStore();
      await store.init();
      
      // Normalize and validate
      const agentConfig = {
        name: agentDraft.name?.trim() || 'Unnamed Agent',
        keywords: (agentDraft.keywords || []).map(k => String(k).toLowerCase().trim()).filter(k => k),
        prompt: agentDraft.prompt?.trim() || '',
        categories: agentDraft.categories || ['general'],
        executionType: agentDraft.executionType || 'llm',
        capabilities: agentDraft.capabilities || [],
        templateId: agentDraft.templateId,
        settings: {
          confidenceThreshold: 0.7,
          maxConcurrent: 5,
        },
      };
      
      if (!agentConfig.name || !agentConfig.prompt) {
        return { success: false, error: 'Agent must have a name and prompt' };
      }
      
      if (agentConfig.keywords.length === 0) {
        return { success: false, error: 'Agent must have at least one keyword' };
      }
      
      const agent = await store.createAgent(agentConfig);
      console.log('[AgentComposer] Agent saved:', agent.id);
      
      return { success: true, agent };
      
    } catch (error) {
      console.error('[AgentComposer] Save error:', error);
      return { success: false, error: error.message };
    }
  });
  
  // ==================== AUTONOMOUS AGENT TESTING ====================
  
  // Autonomous test - creates, tests, diagnoses, fixes, and iterates until success
  // Returns comprehensive feedback including state diffs, verification results, and timeline
  // Uses Claude Code CLI (browser login, no API key needed)
  ipcMain.handle('gsx-create:auto-test', async (event, agent, testPrompt) => {
    const { AgentAutoTester } = require('./lib/agent-auto-tester');
    
    // AgentAutoTester now uses Claude Code internally
    const autoTester = new AgentAutoTester();
    
    console.log('[AgentComposer] Starting autonomous test for:', agent.name);
    
    // Progress callback to send updates to the UI
    const progressUpdates = [];
    const onProgress = (update) => {
      progressUpdates.push(update);
      console.log('[AgentComposer] Auto-test progress:', update.type, update.message);
      
      // Include state diff info in progress updates
      if (update.stateDiff) {
        console.log('[AgentComposer] State changes:', update.stateDiff.changeCount || 0);
      }
      
      // Send progress to renderer with full details
      if (claudeCodeWindow && !claudeCodeWindow.isDestroyed()) {
        claudeCodeWindow.webContents.send('auto-test:progress', {
          ...update,
          stateDiff: update.stateDiff,
          verificationResults: update.verificationResults
        });
      }
    };
    
    try {
      const result = await autoTester.testUntilSuccess(agent, testPrompt, onProgress);
      
      console.log('[AgentComposer] Autonomous test complete:', result.success ? 'SUCCESS' : 'FAILED');
      if (result.lastResult?.stateDiff) {
        console.log('[AgentComposer] Final state changes:', result.lastResult.stateDiff.changeCount || 0);
      }
      
      // Return comprehensive result with all feedback
      return {
        success: result.success,
        attempts: result.attempts,
        verified: result.success,
        finalAgent: result.finalAgent,
        verificationDetails: result.verificationDetails,
        recommendation: result.recommendation,
        history: result.history,
        progressLog: progressUpdates,
        
        // New comprehensive feedback fields
        lastResult: result.lastResult ? {
          verified: result.lastResult.verified,
          details: result.lastResult.details,
          action: result.lastResult.action,
          beforeState: result.lastResult.beforeState,
          afterState: result.lastResult.afterState,
          stateDiff: result.lastResult.stateDiff,
          verificationResults: result.lastResult.verificationResults,
          timeline: result.lastResult.timeline,
          beforeStateFormatted: result.lastResult.beforeStateFormatted,
          afterStateFormatted: result.lastResult.afterStateFormatted
        } : null,
        timeline: result.timeline
      };
    } catch (error) {
      console.error('[AgentComposer] Autonomous test error:', error);
      return {
        success: false,
        error: error.message,
        progressLog: progressUpdates
      };
    }
  });
  
  // Quick test endpoint - single attempt, returns immediately with full feedback
  // Uses Claude Code CLI (browser login, no API key needed)
  ipcMain.handle('gsx-create:quick-test', async (event, agent, testPrompt) => {
    const { AgentAutoTester } = require('./lib/agent-auto-tester');
    
    // AgentAutoTester now uses Claude Code internally
    const autoTester = new AgentAutoTester();
    
    try {
      const result = await autoTester.executeAndVerify(agent, testPrompt);
      
      // Return comprehensive feedback
      return {
        success: result.verified === true,
        verified: result.verified,
        method: result.method,
        details: result.details,
        needsUserConfirmation: result.needsUserConfirmation || false,
        
        // Full state information
        action: result.action,
        beforeState: result.beforeState,
        afterState: result.afterState,
        stateDiff: result.stateDiff,
        verificationResults: result.verificationResults,
        timeline: result.timeline,
        beforeStateFormatted: result.beforeStateFormatted,
        afterStateFormatted: result.afterStateFormatted,
        actualState: result.actualState,
        expectedState: result.expectedState
      };
    } catch (error) {
      return {
        success: false,
        verified: false,
        error: error.message
      };
    }
  });
  
  // Check if Claude Code CLI is available (Phase 2)
  ipcMain.handle('claude-code:available', async () => {
    try {
      const { isClaudeCodeAvailable } = require('./lib/claude-code-runner');
      const result = await isClaudeCodeAvailable();
      return result.available;
    } catch (error) {
      console.error('[ClaudeCode] Error checking availability:', error);
      return false;
    }
  });
  
  // Run Claude Code CLI (Phase 2)
  ipcMain.handle('claude-code:run', async (event, templateId, prompt, options = {}) => {
    try {
      const { runClaudeCode, runTemplate } = require('./lib/claude-code-runner');
      const template = getTemplate(templateId);
      
      if (!template) {
        return { success: false, error: `Template "${templateId}" not found` };
      }
      
      if (template.backend !== 'cli') {
        return { success: false, error: 'This template does not use Claude Code CLI' };
      }
      
      console.log('[ClaudeCode] Running CLI template:', templateId);
      
      // Send output events back to renderer
      const sendOutput = (data) => {
        if (claudeCodeWindow && !claudeCodeWindow.isDestroyed()) {
          claudeCodeWindow.webContents.send('claude-code:output', data);
        }
      };
      
      const result = await runTemplate(template, prompt, {
        cwd: options.workingDir,
        onOutput: sendOutput,
        onError: sendOutput,
      });
      
      return result;
    } catch (error) {
      console.error('[ClaudeCode] Run error:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Cancel running process (Phase 2)
  ipcMain.handle('claude-code:cancel', async () => {
    try {
      const { cancelClaudeCode } = require('./lib/claude-code-runner');
      return cancelClaudeCode();
    } catch (error) {
      console.error('[ClaudeCode] Cancel error:', error);
      return false;
    }
  });
  
  // Browse for directory
  ipcMain.handle('claude-code:browse-directory', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(claudeCodeWindow, {
      properties: ['openDirectory'],
      title: 'Select Working Directory'
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  });
  
  // Close window
  ipcMain.on('claude-code:close', () => {
    if (claudeCodeWindow && !claudeCodeWindow.isDestroyed()) {
      claudeCodeWindow.close();
    }
  });
  
  console.log('[AgentComposer] IPC handlers registered');
}

// ==================== INTRO WIZARD ====================

/**
 * Create and show the intro wizard window
 * Shows intro for first-time users, or updates for returning users
 */
function createIntroWizardWindow() {
  if (introWizardWindow && !introWizardWindow.isDestroyed()) {
    introWizardWindow.focus();
    return introWizardWindow;
  }
  
  console.log('[IntroWizard] Creating intro wizard window...');
  
  introWizardWindow = new BrowserWindow({
    width: 720,
    height: 600,
    minWidth: 600,
    minHeight: 500,
    title: 'Welcome to GSX Power User',
    frame: false,
    transparent: false,
    backgroundColor: '#141414',
    center: true,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-intro-wizard.js'),
      webSecurity: true,
      sandbox: false
    }
  });
  
  // Clear the reference when closed
  introWizardWindow.on('closed', () => {
    console.log('[IntroWizard] Window closed');
    introWizardWindow = null;
  });
  
  // Load the intro wizard HTML
  introWizardWindow.loadFile('intro-wizard.html').catch(err => {
    console.error('[IntroWizard] Error loading intro-wizard.html:', err);
  });
  
  introWizardWindow.webContents.on('did-finish-load', () => {
    console.log('[IntroWizard] Window loaded successfully');
  });
  
  return introWizardWindow;
}

/**
 * Setup Intro Wizard IPC handlers
 */
function setupIntroWizardIPC() {
  const { getSettingsManager } = require('./settings-manager');
  const packageJson = require('./package.json');
  
  // Get initialization data for the wizard
  ipcMain.handle('intro-wizard:get-init-data', async () => {
    const settings = getSettingsManager();
    return {
      currentVersion: packageJson.version,
      lastSeenVersion: settings.getLastSeenVersion(),
      isFirstRun: settings.isFirstRun()
    };
  });
  
  // Mark current version as seen
  ipcMain.handle('intro-wizard:mark-seen', async () => {
    const settings = getSettingsManager();
    settings.setLastSeenVersion(packageJson.version);
    console.log('[IntroWizard] Marked version as seen:', packageJson.version);
    return true;
  });
  
  // Close the wizard window
  ipcMain.handle('intro-wizard:close', async () => {
    if (introWizardWindow && !introWizardWindow.isDestroyed()) {
      introWizardWindow.close();
    }
    return true;
  });
  
  console.log('[IntroWizard] IPC handlers registered');
}

/**
 * Check if intro wizard should be shown and show it
 * Call this after the main window is ready
 */
function checkAndShowIntroWizard() {
  const { getSettingsManager } = require('./settings-manager');
  const packageJson = require('./package.json');
  
  const settings = getSettingsManager();
  const currentVersion = packageJson.version;
  
  if (settings.shouldShowIntroWizard(currentVersion)) {
    const isFirstRun = settings.isFirstRun();
    console.log(`[IntroWizard] Showing wizard - ${isFirstRun ? 'First run' : 'Update from ' + settings.getLastSeenVersion()}`);
    
    // Delay slightly to let main window finish loading
    setTimeout(() => {
      createIntroWizardWindow();
    }, 500);
  } else {
    console.log('[IntroWizard] Not showing - already seen version', currentVersion);
  }
}

// Export functions for use in other modules
module.exports = {
  openSetupWizard,
  updateIDWMenu,
  updateGSXMenu,
  openBudgetDashboard,
  openBudgetEstimator,
  openBudgetSetup,
  // Voice Orb
  showOrbWindow,
  hideOrbWindow,
  toggleOrbWindow,
  // Intro Wizard
  createIntroWizardWindow,
  checkAndShowIntroWizard,
  // Agent Manager
  createAgentManagerWindow,
  // Claude Code UI
  createClaudeCodeWindow,
  createClaudeTerminalWindow,
  broadcastPlanSummary,
  relayVoiceToComposer,
}; 