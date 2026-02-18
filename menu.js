const { app, Menu, shell, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

// Extracted modules
const { _registerGSXWindow, closeAllGSXWindows } = require('./lib/gsx-window-tracker');
const { _openGSXLargeWindow, openLearningWindow } = require('./lib/gsx-autologin');

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
    return this.lastLoaded > 0 && Date.now() - this.lastLoaded < this.cacheValidMs;
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
        userPrefs: this.userPrefs || {},
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
      userPrefs: this.userPrefs || {},
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
  },
};

// Auto-login system, window helpers, and GSX window tracking
// have been extracted to lib/gsx-autologin.js and lib/gsx-window-tracker.js

const { buildIDWAndGSXMenuItems } = require('./lib/menu-sections/idw-gsx-builder');

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

  // Generate default GSX links if none exist
  let gsxLinksData = cachedData.gsxLinks || [];
  if (gsxLinksData.length === 0 && idwEnvironments.length > 0) {
    console.log('[Menu] No GSX links found, generating defaults');
    const gsxAccountId = cachedData.userPrefs.gsxAccountId || '';
    gsxLinksData = generateDefaultGSXLinks(idwEnvironments, gsxAccountId);

    if (gsxLinksData.length) {
      try {
        const electronApp = require('electron').app;
        const userDataPath = electronApp.getPath('userData');
        const gsxConfigPath = path.join(userDataPath, 'gsx-links.json');
        fs.writeFileSync(gsxConfigPath, JSON.stringify(gsxLinksData, null, 2));
        console.log(`[Menu] Wrote ${gsxLinksData.length} default GSX links`);
        menuCache.gsxLinks = gsxLinksData;
      } catch (err) {
        console.error('[Menu] Failed to write default GSX links:', err);
      }
    }
  }

  console.log(`[Menu] Data loading took ${Date.now() - startTime}ms`);

  // Build dynamic IDW and GSX menu items via the extracted builder
  const enrichedCachedData = {
    ...cachedData,
    gsxLinks: gsxLinksData,
  };
  const { idwMenuItems, gsxMenuItems } = buildIDWAndGSXMenuItems(idwEnvironments, enrichedCachedData);

  // ============================================
  // ASSEMBLE TEMPLATE
  // ============================================
  const template = [
    // App menu (macOS only)
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              {
                label: 'Settings...',
                accelerator: 'CmdOrCtrl+,',
                click: () => {
                  console.log('[Menu Click] Settings clicked, opening settings window');
                  if (typeof global.openSettingsWindowGlobal === 'function') {
                    global.openSettingsWindowGlobal();
                  } else {
                    const focusedWindow = BrowserWindow.getFocusedWindow();
                    if (focusedWindow) {
                      focusedWindow.webContents.send('menu-action', { action: 'open-settings' });
                    }
                  }
                },
              },
              { type: 'separator' },
              {
                label: 'Manage Environments...',
                click: () => {
                  console.log('[Menu Click] Manage Environments clicked, opening setup wizard');
                  if (typeof global.openSetupWizardGlobal === 'function') {
                    global.openSetupWizardGlobal();
                  } else {
                    const focusedWindow = BrowserWindow.getFocusedWindow();
                    if (focusedWindow) {
                      focusedWindow.webContents.send('menu-action', { action: 'open-preferences' });
                    }
                  }
                },
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
                  ...(isMac
                    ? [
                        { role: 'pasteAndMatchStyle' },
                        { role: 'delete' },
                        { role: 'selectAll' },
                        { type: 'separator' },
                        {
                          label: 'Speech',
                          submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }],
                        },
                      ]
                    : [{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }]),
                ],
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),

    // IDW menu (with dynamic IDW environment items)
    {
      label: 'IDW',
      submenu: idwMenuItems,
    },

    // GSX menu (with dynamic GSX links)
    {
      label: 'GSX',
      submenu: gsxMenuItems,
    },

    // Agentic University menu
    _buildUniversityMenu(),

    // Clipboard / Manage Spaces menu
    _buildSpacesMenu(),

    // Tools menu
    _buildToolsMenu(showTestMenu),

    // Help menu
    _buildHelpMenu(showTestMenu),

    // Share menu
    _buildShareMenu(),
  ];

  // Debug: Log the menu items being built
  console.log('[Menu] Building menu with items:', template.map((item) => item.label || item.role).filter(Boolean));

  try {
    const menu = Menu.buildFromTemplate(template);
    console.log('[Menu] Menu built successfully.');

    // Debug: Verify Share menu is in the built menu
    const menuItems = menu.items.map((item) => item.label || item.role);
    console.log('[Menu] Final menu items:', menuItems);
    if (!menuItems.includes('Share')) {
      console.error('[Menu] WARNING: Share menu is missing from final menu!');
    } else {
      console.log('[Menu] Share menu is present in position:', menuItems.indexOf('Share'));
    }

    return menu;
  } catch (error) {
    console.error('[Menu] Error building menu from template:', error);
    console.error('[Menu] Template:', JSON.stringify(template, null, 2));
    throw error;
  }
}

// ============================================
// STATIC MENU SECTION BUILDERS
// ============================================

function _buildUniversityMenu() {
  return {
    label: 'Agentic University',
    submenu: [
      {
        label: 'Open LMS',
        click: () => {
          openLearningWindow('https://learning.staging.onereach.ai/', 'Learning Management System');
        },
      },
      { type: 'separator' },
      {
        label: 'Quick Starts',
        submenu: [
          {
            label: 'View All Tutorials',
            click: () => {
              const getLogger = require('./event-logger');
              const logger = getLogger();
              if (logger && logger.info) {
                logger.info('Quick Starts Accessed', {
                  action: 'menu_click',
                  menuPath: 'Agentic University > Quick Starts > View All Tutorials',
                  timestamp: new Date().toISOString(),
                });
              }
              console.log('[Menu] User opened Quick Starts tutorials page');
              const preloadPath = path.join(__dirname, 'preload.js');
              const tutorialsWindow = new BrowserWindow({
                width: 1400,
                height: 900,
                webPreferences: {
                  nodeIntegration: false,
                  contextIsolation: true,
                  preload: preloadPath,
                  sandbox: false,
                  webSecurity: true,
                  enableRemoteModule: false,
                },
              });
              tutorialsWindow.loadFile('tutorials.html');
              tutorialsWindow.webContents.on('preload-error', (event, preloadPath, error) => {
                console.error('[Menu] Preload error:', error);
              });
              tutorialsWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
                console.error('[Menu] Failed to load tutorials:', errorDescription);
              });
            },
          },
          { type: 'separator' },
          {
            label: 'Getting Started',
            click: () =>
              openLearningWindow('https://learning.staging.onereach.ai/courses/getting-started', 'Getting Started'),
          },
          {
            label: 'Building Your First Agent',
            click: () =>
              openLearningWindow(
                'https://learning.staging.onereach.ai/courses/first-agent',
                'Building Your First Agent'
              ),
          },
          {
            label: 'Workflow Fundamentals',
            click: () =>
              openLearningWindow(
                'https://learning.staging.onereach.ai/courses/workflow-basics',
                'Workflow Fundamentals'
              ),
          },
          {
            label: 'API Integration',
            click: () =>
              openLearningWindow('https://learning.staging.onereach.ai/courses/api-integration', 'API Integration'),
          },
        ],
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
              preload: path.join(__dirname, 'Flipboard-IDW-Feed/preload.js'),
            },
          });
          aiWindow.loadFile('Flipboard-IDW-Feed/uxmag.html');
        },
      },
      { type: 'separator' },
      {
        label: 'Wiser Method',
        click: () => openLearningWindow('https://www.wisermethod.com/', 'Wiser Method'),
      },
    ],
  };
}

function _buildSpacesMenu() {
  return {
    label: 'Manage Spaces',
    submenu: [
      {
        label: 'Show Clipboard History',
        accelerator: process.platform === 'darwin' ? 'Cmd+Shift+V' : 'Ctrl+Shift+V',
        click: () => {
          if (global.clipboardManager) {
            global.clipboardManager.createClipboardWindow();
          } else {
            const { getLogQueue } = require('./lib/log-event-queue');
            getLogQueue().error('menu', 'Clipboard manager not available when Manage Spaces clicked');
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Open Black Hole (Upload Files)',
        accelerator: process.platform === 'darwin' ? 'Cmd+Shift+U' : 'Ctrl+Shift+U',
        click: () => {
          if (global.clipboardManager) {
            const focusedWindow = BrowserWindow.getFocusedWindow();
            if (focusedWindow) {
              const bounds = focusedWindow.getBounds();
              const position = {
                x: bounds.x + bounds.width / 2 - 200,
                y: bounds.y + bounds.height / 2 - 200,
              };
              global.clipboardManager.createBlackHoleWindow(position, true);
            } else {
              global.clipboardManager.createBlackHoleWindow({ x: 400, y: 300 }, true);
            }
          } else {
            console.error('[Menu] Clipboard manager not available');
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Validate & Clean Storage',
        click: async () => {
          const { dialog } = require('electron');
          const ClipboardStorageValidator = require('./clipboard-storage-validator');
          const validator = new ClipboardStorageValidator();

          const result = await dialog.showMessageBox({
            type: 'question',
            title: 'Validate Clipboard Storage',
            message: 'Check for and fix storage issues?',
            detail:
              'This will:\n- Remove orphaned metadata entries\n- Clean up files without metadata\n- Fix corrupted index entries\n- Remove inaccessible files',
            buttons: ['Check Only', 'Check & Fix', 'Cancel'],
            defaultId: 1,
            cancelId: 2,
          });

          if (result.response === 2) return;

          const autoFix = result.response === 1;
          const report = await validator.validateStorage(autoFix);
          const summary = report.summary;
          const issueCount = report.issues.length;

          let message = `Validation ${autoFix ? 'and cleanup ' : ''}complete!`;
          let detail = `Items checked: ${summary.totalItems}\n`;
          detail += `Valid items: ${summary.validItems}\n`;

          if (issueCount > 0) {
            detail += `\nIssues found:\n`;
            if (summary.orphanedMetadata > 0) detail += `- Orphaned metadata: ${summary.orphanedMetadata}\n`;
            if (summary.missingFiles > 0) detail += `- Missing files: ${summary.missingFiles}\n`;
            if (summary.orphanedDirectories > 0) detail += `- Orphaned directories: ${summary.orphanedDirectories}\n`;
            if (autoFix && summary.fixedIssues > 0) detail += `\nFixed ${summary.fixedIssues} issues`;
          } else {
            detail += '\nNo issues found!';
          }

          dialog.showMessageBox({
            type: issueCount > 0 && !autoFix ? 'warning' : 'info',
            title: 'Storage Validation Results',
            message: message,
            detail: detail,
            buttons: ['OK'],
          });
        },
      },
      {
        label: 'Storage Summary',
        click: async () => {
          const { dialog } = require('electron');
          const ClipboardStorageValidator = require('./clipboard-storage-validator');
          const validator = new ClipboardStorageValidator();

          const summary = await validator.getStorageSummary();

          const formatBytes = (bytes) => {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
          };

          let detail = `Total Size: ${formatBytes(summary.totalSize)}\n`;
          detail += `Total Items: ${summary.itemCount}\n`;
          detail += `Spaces: ${summary.spaceCount}\n\n`;

          if (Object.keys(summary.fileTypes).length > 0) {
            detail += 'Item Types:\n';
            for (const [type, count] of Object.entries(summary.fileTypes)) {
              detail += `- ${type}: ${count}\n`;
            }
          }

          if (summary.largestFiles.length > 0) {
            detail += '\nLargest Files:\n';
            for (const file of summary.largestFiles.slice(0, 5)) {
              detail += `- ${file.name || 'Unnamed'}: ${formatBytes(file.size)}\n`;
            }
          }

          dialog.showMessageBox({
            type: 'info',
            title: 'Clipboard Storage Summary',
            message: 'Storage Usage',
            detail: detail,
            buttons: ['OK'],
          });
        },
      },
    ],
  };
}

function _buildToolsMenu(_showTestMenu) {
  return {
    label: 'Tools',
    submenu: [
      ...(global.moduleManager ? global.moduleManager.getModuleMenuItems() : []),
      ...(global.moduleManager && global.moduleManager.getInstalledModules().length > 0 ? [{ type: 'separator' }] : []),
      ...(global.moduleManager ? global.moduleManager.getWebToolMenuItems() : []),
      ...(global.moduleManager && global.moduleManager.getWebTools().length > 0 ? [{ type: 'separator' }] : []),
      {
        label: 'Black Hole (Paste to Spaces)',
        accelerator: 'CommandOrControl+Shift+B',
        click: () => {
          if (global.clipboardManager) {
            const { screen, BrowserWindow } = require('electron');
            // Use the focused window's display, not always primary (multi-monitor)
            const focused = BrowserWindow.getFocusedWindow();
            const display = focused
              ? screen.getDisplayNearestPoint({ x: focused.getBounds().x, y: focused.getBounds().y })
              : screen.getPrimaryDisplay();
            const wa = display.workArea;
            const position = { x: Math.round(wa.x + wa.width / 2 - 75), y: Math.round(wa.y + wa.height / 2 - 75) };
            global.clipboardManager.createBlackHoleWindow(position, true);
          }
        },
      },
      {
        label: 'Toggle Voice Orb',
        accelerator: 'CommandOrControl+Shift+O',
        click: () => {
          try {
            const main = require('./main');
            if (main.toggleOrbWindow) {
              main.toggleOrbWindow();
            } else {
              console.log('[Menu] Voice Orb not initialized - enable in Settings');
            }
          } catch (error) {
            console.error('[Menu] Voice Orb toggle error:', error);
          }
        },
      },
      {
        label: 'Manage Agents...',
        click: () => {
          try {
            const main = require('./main');
            if (main.createAgentManagerWindow) main.createAgentManagerWindow();
          } catch (error) {
            console.error('[Menu] Agent Manager error:', error);
          }
        },
      },
      {
        label: 'Create Agent with AI...',
        accelerator: 'CmdOrCtrl+Shift+G',
        click: () => {
          try {
            const main = require('./main');
            if (main.createClaudeCodeWindow) main.createClaudeCodeWindow();
          } catch (error) {
            console.error('[Menu] Claude Code error:', error);
          }
        },
      },
      {
        label: 'Claude Code Status...',
        click: async () => {
          try {
            const { dialog } = require('electron');
            const claudeCode = require('./lib/claude-code-runner');
            const authStatus = await claudeCode.isAuthenticated();

            if (authStatus.authenticated) {
              dialog.showMessageBox({
                type: 'info',
                title: 'Claude Code',
                message: 'Authenticated',
                detail: 'Claude Code is ready to use with your Anthropic API key.',
                buttons: ['OK'],
              });
            } else {
              const result = await dialog.showMessageBox({
                type: 'warning',
                title: 'Claude Code',
                message: 'Not Configured',
                detail: authStatus.error || 'Please add your Anthropic API key in Settings.',
                buttons: ['Open Settings', 'Cancel'],
                defaultId: 0,
              });
              if (result.response === 0) {
                const main = require('./main');
                if (main.openSetupWizard) main.openSetupWizard();
              }
            }
          } catch (error) {
            console.error('[Menu] Claude Code status error:', error);
          }
        },
      },
      {
        label: 'Claude Code Login...',
        click: () => {
          try {
            const main = require('./main');
            if (main.createClaudeTerminalWindow) {
              main.createClaudeTerminalWindow();
            } else {
              console.error('[Menu] createClaudeTerminalWindow not found in main');
            }
          } catch (error) {
            console.error('[Menu] Claude Terminal error:', error);
          }
        },
      },
      { type: 'separator' },
      {
        label: 'GSX Create',
        accelerator: 'CommandOrControl+Shift+A',
        click: () => {
          const { screen } = require('electron');
          // Use the focused window's display for sizing (multi-monitor)
          const focused = BrowserWindow.getFocusedWindow();
          const display = focused
            ? screen.getDisplayNearestPoint({ x: focused.getBounds().x, y: focused.getBounds().y })
            : screen.getPrimaryDisplay();
          const { width: screenWidth, height: screenHeight } = display.workAreaSize;

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
        },
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
              preload: path.join(__dirname, 'preload-video-editor.js'),
            },
          });
          videoEditorWindow.loadFile('video-editor.html');
          videoEditorWindow.webContents.on('before-input-event', (event, input) => {
            if ((input.meta && input.alt && input.key === 'i') || (input.control && input.shift && input.key === 'I')) {
              videoEditorWindow.webContents.toggleDevTools();
            }
          });
          if (global.videoEditor) {
            global.videoEditor.setupIPC(videoEditorWindow);
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Manage Tools...',
        click: () => {
          const managerWindow = new BrowserWindow({
            width: 800,
            height: 600,
            webPreferences: {
              nodeIntegration: true,
              contextIsolation: false,
              enableRemoteModule: true,
            },
            title: 'Module Manager',
          });
          managerWindow.loadFile('module-manager-ui.html');
        },
      },
    ],
  };
}

function _buildHelpMenu(showTestMenu) {
  return {
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
            message: 'GSX Power User Keyboard Shortcuts',
            detail: shortcutsMessage,
            buttons: ['OK'],
          });
        },
      },
      {
        label: 'Learn More',
        click: async () => {
          await shell.openExternal('https://onereach.ai');
        },
      },
      { type: 'separator' },
      {
        label: 'Browser Extension Setup',
        click: () => {
          const setupWindow = new BrowserWindow({
            width: 600,
            height: 700,
            backgroundColor: '#0d0d14',
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              preload: path.join(__dirname, 'preload-minimal.js'),
            },
          });
          setupWindow.loadFile('extension-setup.html');
        },
      },
      { type: 'separator' },
      {
        label: 'Documentation',
        submenu: [
          {
            label: 'Local Documentation (README)',
            click: () => {
              const docWindow = new BrowserWindow({
                width: 1000,
                height: 800,
                webPreferences: {
                  nodeIntegration: false,
                  contextIsolation: true,
                  preload: path.join(__dirname, 'preload.js'),
                  webSecurity: true,
                },
              });
              try {
                docWindow.loadFile('docs-readme.html');
              } catch (error) {
                console.error('Error loading local documentation:', error);
                shell.openExternal('https://onereach.ai/docs');
              }
            },
          },
          {
            label: 'AI Run Times Guide',
            click: () => {
              const aiHelpWindow = new BrowserWindow({
                width: 1000,
                height: 800,
                webPreferences: {
                  nodeIntegration: false,
                  contextIsolation: true,
                  preload: path.join(__dirname, 'preload.js'),
                  webSecurity: true,
                },
              });
              try {
                aiHelpWindow.loadFile('docs-ai-insights.html');
              } catch (error) {
                console.error('Error loading AI Run Times guide:', error);
                shell.openExternal('https://onereach.ai/docs');
              }
            },
          },
          { type: 'separator' },
          {
            label: 'Online Documentation',
            click: async () => {
              await shell.openExternal('https://onereach.ai/docs');
            },
          },
        ],
      },
      {
        label: 'Developer Docs',
        submenu: [
          {
            label: 'Spaces API Guide',
            click: () => {
              const apiDocWindow = new BrowserWindow({
                width: 1100,
                height: 900,
                webPreferences: {
                  nodeIntegration: false,
                  contextIsolation: true,
                  preload: path.join(__dirname, 'preload.js'),
                  webSecurity: true,
                },
              });
              try {
                apiDocWindow.loadFile('docs-spaces-api.html');
              } catch (error) {
                console.error('Error loading Spaces API documentation:', error);
              }
            },
          },
        ],
      },
      { type: 'separator' },
      {
        label: 'Report a Bug',
        accelerator: process.platform === 'darwin' ? 'Cmd+Shift+B' : 'Ctrl+Shift+B',
        click: async () => {
          const { dialog, app, clipboard, shell } = require('electron');
          const os = require('os');
          const crypto = require('crypto');

          try {
            const reportId = `BR-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
            const userInfo = { username: os.userInfo().username, hostname: os.hostname(), homedir: os.homedir() };
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
              uptime: `${Math.round(os.uptime() / 3600)} hours`,
            };
            const appPaths = {
              userData: app.getPath('userData'),
              logs: app.getPath('logs'),
              temp: app.getPath('temp'),
            };

            let recentLogs = '';
            let logError = null;
            try {
              const logPath = path.join(app.getPath('userData'), 'logs', 'app.log');
              if (fs.existsSync(logPath)) {
                const logContent = fs.readFileSync(logPath, 'utf8');
                recentLogs = logContent
                  .split('\n')
                  .filter((line) => line.trim())
                  .slice(-200)
                  .join('\n');
              } else {
                const altLogPath = path.join(app.getPath('userData'), 'app.log');
                if (fs.existsSync(altLogPath)) {
                  recentLogs = fs
                    .readFileSync(altLogPath, 'utf8')
                    .split('\n')
                    .filter((line) => line.trim())
                    .slice(-200)
                    .join('\n');
                }
              }
            } catch (error) {
              logError = error.message;
            }

            let appSettings = {};
            try {
              const settingsPath = path.join(app.getPath('userData'), 'settings.json');
              if (fs.existsSync(settingsPath)) {
                appSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                delete appSettings.apiKeys;
                delete appSettings.credentials;
                delete appSettings.tokens;
                delete appSettings.passwords;
              }
            } catch (_error) {
              appSettings = { error: 'Failed to load settings' };
            }

            const emailBody = `\n===========================================\nBUG REPORT ID: ${reportId}\n===========================================\n\nPLEASE DESCRIBE YOUR ISSUE HERE:\n[Please describe what happened, what you expected to happen, and steps to reproduce the issue]\n\n\n\n===========================================\nAUTOMATED SYSTEM INFORMATION (DO NOT EDIT)\n===========================================\n\nReport ID: ${reportId}\nTimestamp: ${new Date().toLocaleString()}\nUser: ${userInfo.username}@${userInfo.hostname}\n\nAPP INFORMATION:\n- App Version: ${systemInfo.app_version}\n- Electron: ${systemInfo.electron_version}\n- Node: ${systemInfo.node_version}\n- Chrome: ${systemInfo.chrome_version}\n\nSYSTEM INFORMATION:\n- Platform: ${systemInfo.platform} ${systemInfo.platform_version}\n- Architecture: ${systemInfo.arch}\n- CPUs: ${systemInfo.cpus}\n- Memory: ${systemInfo.memory_total} total (${systemInfo.memory_free} free)\n- System Uptime: ${systemInfo.uptime}\n\nAPP PATHS:\n- User Data: ${appPaths.userData}\n- Logs: ${appPaths.logs}\n- Temp: ${appPaths.temp}\n\nRECENT LOG ENTRIES (Last 200 lines):\n----------------------------------------\n${recentLogs || 'No logs available' + (logError ? `\nLog Error: ${logError}` : '')}\n----------------------------------------\n\nAPP SETTINGS (Sensitive data removed):\n${JSON.stringify(appSettings, null, 2)}\n\n===========================================\nEND OF AUTOMATED REPORT\n===========================================\n`;

            const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
              type: 'info',
              title: 'Bug Report Ready',
              message: `Bug Report ${reportId} Prepared`,
              detail:
                'Your bug report has been prepared with all system information and logs. Choose how you want to submit it:',
              buttons: ['Open GitHub Issues', 'Send Email', 'Copy to Clipboard', 'Save to File', 'Cancel'],
              defaultId: 0,
              cancelId: 4,
            });

            if (result.response === 0) {
              const issueTitle = `Bug Report ${reportId} - GSX Power User v${systemInfo.app_version}`;
              const githubUrl = `https://github.com/wilsr7000/onereach_desktop/issues/new?title=${encodeURIComponent(issueTitle)}&body=${encodeURIComponent(emailBody)}`;
              await shell.openExternal(githubUrl);
              dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                type: 'info',
                title: 'GitHub Issues Opened',
                message: 'GitHub Issues page opened',
                detail: `A new issue page has been opened on GitHub with Report ${reportId}.`,
                buttons: ['OK'],
              });
            } else if (result.response === 1) {
              const subject = `Bug Report ${reportId} - GSX Power User v${systemInfo.app_version}`;
              await shell.openExternal(
                `mailto:support@onereach.ai?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(emailBody)}`
              );
              dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                type: 'info',
                title: 'Email Opened',
                message: 'Bug report email opened',
                detail: `Your email client should now be open with Report ${reportId}.`,
                buttons: ['OK'],
              });
            } else if (result.response === 2) {
              clipboard.writeText(emailBody);
              dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                type: 'info',
                title: 'Copied to Clipboard',
                message: `Bug Report ${reportId} copied to clipboard`,
                buttons: ['OK'],
              });
            } else if (result.response === 3) {
              const savePath = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
                defaultPath: `bug-report-${reportId}.txt`,
                filters: [
                  { name: 'Text Files', extensions: ['txt'] },
                  { name: 'All Files', extensions: ['*'] },
                ],
              });
              if (!savePath.canceled && savePath.filePath) {
                fs.writeFileSync(savePath.filePath, emailBody);
                dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                  type: 'info',
                  title: 'Saved Successfully',
                  message: `Bug Report ${reportId} saved`,
                  detail: `Report saved to:\n${savePath.filePath}`,
                  buttons: ['OK'],
                });
              }
            }
          } catch (error) {
            console.error('Error creating bug report:', error);
            dialog.showErrorBox('Error', `Failed to create bug report: ${error.message}`);
          }
        },
      },
      {
        label: 'Export Debug Info',
        click: async () => {
          const { dialog, app, clipboard } = require('electron');
          const os = require('os');

          try {
            const debugInfo = {
              timestamp: new Date().toISOString(),
              app: {
                name: app.getName(),
                version: app.getVersion(),
                paths: { userData: app.getPath('userData'), temp: app.getPath('temp'), exe: app.getPath('exe') },
              },
              system: {
                platform: os.platform(),
                release: os.release(),
                arch: os.arch(),
                cpus: os.cpus().length,
                memory: {
                  total: `${Math.round(os.totalmem() / 1073741824)}GB`,
                  free: `${Math.round(os.freemem() / 1073741824)}GB`,
                },
                uptime: `${Math.round(os.uptime() / 3600)} hours`,
              },
              electron: {
                version: process.versions.electron,
                node: process.versions.node,
                chrome: process.versions.chrome,
                v8: process.versions.v8,
              },
              settings: {},
            };

            try {
              const settingsPath = path.join(app.getPath('userData'), 'settings.json');
              if (fs.existsSync(settingsPath)) {
                const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                delete settings.apiKeys;
                delete settings.credentials;
                debugInfo.settings = settings;
              }
            } catch (_error) {
              debugInfo.settings = { error: 'Failed to load settings' };
            }

            const debugText = JSON.stringify(debugInfo, null, 2);
            const result = await dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
              type: 'info',
              title: 'Debug Information',
              message: 'Debug information has been collected',
              detail: 'What would you like to do with it?',
              buttons: ['Copy to Clipboard', 'Save to File', 'Cancel'],
              defaultId: 0,
              cancelId: 2,
            });

            if (result.response === 0) {
              clipboard.writeText(debugText);
              dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                type: 'info',
                title: 'Success',
                message: 'Debug information copied to clipboard!',
              });
            } else if (result.response === 1) {
              const savePath = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
                defaultPath: `onereach-debug-${Date.now()}.json`,
                filters: [
                  { name: 'JSON Files', extensions: ['json'] },
                  { name: 'All Files', extensions: ['*'] },
                ],
              });
              if (!savePath.canceled && savePath.filePath) {
                fs.writeFileSync(savePath.filePath, debugText);
                dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
                  type: 'info',
                  title: 'Success',
                  message: 'Debug information saved successfully!',
                });
              }
            }
          } catch (error) {
            console.error('Error exporting debug info:', error);
            const { dialog } = require('electron');
            dialog.showErrorBox('Error', 'Failed to export debug information.');
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Check for Updates',
        click: () => {
          console.log('[Menu Click] Check for Updates clicked');
          const { checkForUpdates } = require('./main.js');
          if (typeof checkForUpdates === 'function') {
            checkForUpdates();
          } else if (typeof global.checkForUpdatesGlobal === 'function') {
            global.checkForUpdatesGlobal();
          } else {
            const { dialog } = require('electron');
            dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
              type: 'info',
              title: 'Updates Not Available',
              message: 'Auto-update repository not configured',
              detail:
                'The public releases repository needs to be created first:\n\n1. Go to github.com/new\n2. Create repository: onereach_desktop\n3. Make it PUBLIC\n4. Run: npm run release',
              buttons: ['OK'],
            });
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Manage Backups',
        submenu: [
          {
            label: 'View Available Backups',
            click: async () => {
              const { dialog, _shell } = require('electron');
              const focusedWindow = BrowserWindow.getFocusedWindow();
              const rollbackManager = require('./rollback-manager');
              const result = await rollbackManager.getBackups();

              if (!result || result.length === 0) {
                dialog.showMessageBox(focusedWindow, {
                  type: 'info',
                  title: 'No Backups Available',
                  message: 'No app backups found. Backups are created automatically before updates.',
                  buttons: ['OK'],
                });
                return;
              }

              const buttons = result.map(
                (backup) => `v${backup.version} (${new Date(backup.createdAt).toLocaleDateString()})`
              );
              buttons.push('Cancel');

              const { response } = await dialog.showMessageBox(focusedWindow, {
                type: 'question',
                title: 'Available Backups',
                message: 'Select a backup version to create a restore script:',
                detail: 'The restore script will help you rollback to a previous version if needed.',
                buttons,
                cancelId: buttons.length - 1,
              });

              if (response < result.length) {
                const backup = result[response];
                const scriptResult = await rollbackManager.createRestoreScript(backup.version);
                if (scriptResult.success) {
                  const { response: showFolder } = await dialog.showMessageBox(focusedWindow, {
                    type: 'info',
                    title: 'Restore Script Created',
                    message: `Restore script for v${backup.version} has been created.`,
                    detail: 'Would you like to open the backups folder?',
                    buttons: ['Open Folder', 'OK'],
                    defaultId: 0,
                  });
                  if (showFolder === 0) await rollbackManager.openBackupsFolder();
                } else {
                  dialog.showErrorBox('Error', `Failed to create restore script: ${scriptResult.error}`);
                }
              }
            },
          },
          {
            label: 'Open Backups Folder',
            click: async () => {
              const rollbackManager = require('./rollback-manager');
              await rollbackManager.openBackupsFolder();
            },
          },
        ],
      },
      { type: 'separator' },
      {
        label: 'App Health Dashboard',
        accelerator: 'CmdOrCtrl+Shift+H',
        click: () => {
          console.log('[Menu] Opening App Health Dashboard');
          if (global.openDashboardWindow) {
            global.openDashboardWindow();
          } else {
            console.error('[Menu] Dashboard window function not available');
          }
        },
      },
      // Test menu items (conditional)
      ...(showTestMenu
        ? [
            { type: 'separator' },
            {
              label: 'Data Validation Tests',
              click: () => {
                ipcMain.emit('menu-action', null, { action: 'open-data-tests' });
                const focusedWindow = BrowserWindow.getFocusedWindow();
                if (focusedWindow) focusedWindow.webContents.send('menu-action', { action: 'open-data-tests' });
              },
            },
            {
              label: 'CSP Test Page',
              click: () => {
                ipcMain.emit('menu-action', null, { action: 'open-csp-test' });
                const focusedWindow = BrowserWindow.getFocusedWindow();
                if (focusedWindow) focusedWindow.webContents.send('menu-action', { action: 'open-csp-test' });
              },
            },
            {
              label: 'Integrated Test Runner',
              accelerator: 'CmdOrCtrl+Shift+T',
              click: () => {
                const testWindow = new BrowserWindow({
                  width: 1200,
                  height: 900,
                  webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    preload: path.join(__dirname, 'preload.js'),
                    webSecurity: true,
                  },
                });
                testWindow.loadFile('test-runner.html');
              },
            },
            {
              label: 'Event Log Viewer',
              accelerator: 'CmdOrCtrl+Shift+L',
              click: () => {
                const logWindow = new BrowserWindow({
                  width: 1200,
                  height: 800,
                  webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    preload: path.join(__dirname, 'preload-log-viewer.js'),
                    webSecurity: true,
                  },
                  title: 'Event Log Viewer',
                });
                logWindow.loadFile('log-viewer.html');
              },
            },
            {
              label: 'Test ElevenLabs APIs',
              click: async () => {
                const { dialog } = require('electron');
                const focusedWindow = BrowserWindow.getFocusedWindow();
                try {
                  const { VideoEditor } = require('./src/video/index.js');
                  const videoEditor = new VideoEditor();
                  const results = { passed: [], failed: [] };

                  try {
                    const models = await videoEditor.elevenLabsService.listModels();
                    results.passed.push(`List Models: Found ${models?.length || 0} models`);
                  } catch (e) {
                    results.failed.push(`List Models: ${e.message}`);
                  }
                  try {
                    const voices = await videoEditor.elevenLabsService.listVoices();
                    results.passed.push(`List Voices: Found ${voices.voices?.length || 0} voices`);
                  } catch (e) {
                    results.failed.push(`List Voices: ${e.message}`);
                  }
                  try {
                    const projects = await videoEditor.elevenLabsService.listStudioProjects();
                    results.passed.push(`List Studio Projects: Found ${projects?.length || 0} projects`);
                  } catch (e) {
                    results.failed.push(`List Studio Projects: ${e.message}`);
                  }
                  try {
                    const history = await videoEditor.elevenLabsService.getHistory({ pageSize: 5 });
                    results.passed.push(`Get History: Found ${history.history?.length || 0} items`);
                  } catch (e) {
                    results.failed.push(`Get History: ${e.message}`);
                  }
                  try {
                    const user = await videoEditor.elevenLabsService.getUserInfo();
                    results.passed.push(`Get User Info: ${user.first_name || 'OK'}`);
                  } catch (e) {
                    results.failed.push(`Get User Info: ${e.message}`);
                  }
                  try {
                    const sub = await videoEditor.elevenLabsService.getUserSubscription();
                    results.passed.push(`Get Subscription: ${sub.tier || 'OK'}`);
                  } catch (e) {
                    results.failed.push(`Get Subscription: ${e.message}`);
                  }

                  const message = [
                    `Passed: ${results.passed.length}`,
                    `Failed: ${results.failed.length}`,
                    '',
                    '--- Passed ---',
                    ...results.passed,
                    '',
                    '--- Failed ---',
                    ...results.failed,
                  ].join('\n');
                  dialog.showMessageBox(focusedWindow, {
                    type: results.failed.length > 0 ? 'warning' : 'info',
                    title: 'ElevenLabs API Test Results',
                    message: `Passed: ${results.passed.length} | Failed: ${results.failed.length}`,
                    detail: message,
                    buttons: ['OK'],
                  });
                } catch (error) {
                  dialog.showErrorBox('ElevenLabs Test Error', error.message);
                }
              },
            },
            {
              label: 'Debug: Open Setup Wizard',
              click: async () => {
                const wizardWindow = new BrowserWindow({
                  width: 1000,
                  height: 700,
                  webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    preload: path.join(__dirname, 'preload.js'),
                    webSecurity: true,
                    enableRemoteModule: false,
                    sandbox: false,
                  },
                });
                wizardWindow.loadFile('setup-wizard.html');
              },
            },
          ]
        : []),
    ],
  };
}

function _buildShareMenu() {
  return {
    label: 'Share',
    submenu: [
      {
        label: 'Copy Download Link',
        click: () => {
          const { clipboard, dialog } = require('electron');
          clipboard.writeText('https://github.com/wilsr7000/Onereach_Desktop_App/releases/latest');
          dialog.showMessageBox(BrowserWindow.getFocusedWindow(), {
            type: 'info',
            title: 'Link Copied',
            message: 'Download link copied to clipboard!',
            buttons: ['OK'],
          });
        },
      },
      {
        label: 'Share via Email',
        click: () => {
          const subject = encodeURIComponent('Check out GSX Power User');
          const body = encodeURIComponent(
            "I'm using GSX Power User - a powerful app for AI productivity. Download it here: https://github.com/wilsr7000/Onereach_Desktop_App/releases/latest"
          );
          shell.openExternal(`mailto:?subject=${subject}&body=${body}`);
        },
      },
      {
        label: 'Open GitHub Page',
        click: () => {
          shell.openExternal('https://github.com/wilsr7000/Onereach_Desktop_App/releases/latest');
        },
      },
    ],
  };
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
          submenu: [{ role: 'quit' }],
        },
        {
          label: 'Help',
          submenu: [
            {
              label: 'Debug Menu Error',
              click: () => {
                const { dialog } = require('electron');
                dialog.showErrorBox('Menu Error', `Failed to create menu: ${error.message}`);
              },
            },
          ],
        },
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
      body: isTestMenuVisible ? 'Test menu activated' : 'Test menu deactivated',
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
        idwEnvironments.forEach((env) => {
          console.log(
            `[Menu] IDW Environment: id=${env.id || 'undefined'}, label=${env.label}, environment=${env.environment}`
          );

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
        allGsxLinks.forEach((link) => {
          console.log(
            `[Menu] Link: ID=${link.id}, Label=${link.label}, URL=${link.url && link.url.substring(0, 30)}..., IDW=${link.idwId || 'none'}, Custom=${link.custom || false}, Env=${link.environment || 'none'}`
          );
        });

        // Log custom links for deeper debugging
        const customLinks = allGsxLinks.filter((link) => link.custom === true);
        console.log(`[Menu] Found ${customLinks.length} custom links in GSX links file:`);
        customLinks.forEach((link) => {
          const linkIdwId = String(link.idwId || '').trim();
          console.log(
            `[Menu] Custom link: ID=${link.id}, Label=${link.label}, URL=${link.url && link.url.substring(0, 30)}..., IDW=${linkIdwId}, Env=${link.environment || 'none'}`
          );

          // Check if this link has an IDW ID that matches any IDW environment
          const matchingEnv = idwEnvironments.find((env) => {
            const envId = String(env.id || '').trim();
            return envId === linkIdwId;
          });

          if (matchingEnv) {
            console.log(`[Menu] ✓ Custom link ${link.id} matches IDW ${matchingEnv.label} (${matchingEnv.id})`);
          } else {
            console.log(`[Menu] ✕ Custom link ${link.id} has no matching IDW environment for ID ${linkIdwId}`);

            // Try to find an environment match by environment name as fallback
            if (link.environment) {
              const envMatch = idwEnvironments.find(
                (env) => env.environment && env.environment.toLowerCase() === link.environment.toLowerCase()
              );

              if (envMatch) {
                console.log(
                  `[Menu] ℹ️ Found fallback match by environment name: ${link.environment} -> ${envMatch.label}`
                );
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
function generateDefaultGSXLinks(idwEnvironments = [], defaultAccountId = '') {
  if (!Array.isArray(idwEnvironments) || idwEnvironments.length === 0) return [];
  const links = [];

  idwEnvironments.forEach((env) => {
    const envName = env.environment;
    const idwId = env.id;
    if (!envName || !idwId) return; // skip incomplete entries

    // Extract accountId - priority order:
    // 1. Explicit gsxAccountId field (if user configured it)
    // 2. accountId query param in chatUrl or url
    // 3. Default accountId from settings
    let accountId = defaultAccountId;
    const urlToCheck = env.chatUrl || env.url || '';

    // First check explicit gsxAccountId
    if (env.gsxAccountId) {
      accountId = env.gsxAccountId;
      console.log(`[Menu] Using configured gsxAccountId ${accountId} for IDW ${idwId}`);
    } else if (urlToCheck) {
      // Try query parameter (most reliable)
      const urlMatch = urlToCheck.match(/accountId=([a-f0-9-]+)/i);
      if (urlMatch) {
        accountId = urlMatch[1];
        console.log(`[Menu] Extracted accountId ${accountId} from query param for IDW ${idwId}`);
      }
      // NOTE: We intentionally do NOT fall back to extracting UUIDs from the /chat/ path.
      // Those are chatId/botId values, not accountId, and using them causes wrong-account errors.
    }

    const withAccount = (url) => (accountId ? `${url}?accountId=${accountId}` : url);

    links.push(
      {
        id: `hitl-${envName}-${idwId}`,
        label: 'HITL',
        url: withAccount(`https://hitl.${envName}.onereach.ai/`),
        environment: envName,
        idwId,
      },
      {
        id: `actiondesk-${envName}-${idwId}`,
        label: 'Action Desk',
        url: withAccount(`https://actiondesk.${envName}.onereach.ai/dashboard/`),
        environment: envName,
        idwId,
      },
      {
        id: `designer-${envName}-${idwId}`,
        label: 'Designer',
        url: withAccount(`https://studio.${envName}.onereach.ai/bots`),
        environment: envName,
        idwId,
      },
      {
        id: `agents-${envName}-${idwId}`,
        label: 'Agents',
        url: withAccount(`https://agents.${envName}.onereach.ai/agents`),
        environment: envName,
        idwId,
      },
      {
        id: `tickets-${envName}-${idwId}`,
        label: 'Tickets',
        url: withAccount(`https://tickets.${envName}.onereach.ai/`),
        environment: envName,
        idwId,
      },
      {
        id: `calendar-${envName}-${idwId}`,
        label: 'Calendar',
        url: withAccount(`https://calendar.${envName}.onereach.ai/`),
        environment: envName,
        idwId,
      },
      {
        id: `developer-${envName}-${idwId}`,
        label: 'Developer',
        url: withAccount(`https://docs.${envName}.onereach.ai/`),
        environment: envName,
        idwId,
      }
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

/**
 * Get all openable menu items for voice/agent access
 * Returns a flat list of items the agent can open
 */
function getOpenableItems() {
  const cachedData = menuCache.loadAll();
  const items = [];

  // App features (built-in windows/features)
  // Note: Spaces is handled by the dedicated Spaces Agent for smart summaries
  const appFeatures = [
    {
      name: 'Video Editor',
      type: 'app-feature',
      action: 'open-video-editor',
      keywords: ['video', 'editor', 'edit video', 'video edit'],
    },
    {
      name: 'GSX Create',
      type: 'app-feature',
      action: 'open-gsx-create',
      keywords: ['gsx', 'create', 'aider', 'coding', 'development'],
    },
    {
      name: 'Settings',
      type: 'app-feature',
      action: 'open-settings',
      keywords: ['settings', 'preferences', 'options', 'config'],
    },
    {
      name: 'Budget Manager',
      type: 'app-feature',
      action: 'open-budget',
      keywords: ['budget', 'cost', 'spending', 'money', 'usage'],
    },
    {
      name: 'App Health',
      type: 'app-feature',
      action: 'open-app-health',
      keywords: ['health', 'status', 'errors', 'diagnostics'],
    },
    {
      name: 'Agent Manager',
      type: 'app-feature',
      action: 'open-agent-manager',
      keywords: ['agents', 'manage agents', 'custom agents'],
    },
  ];

  items.push(...appFeatures);

  // External AI bots (ChatGPT, Claude, etc.)
  if (cachedData.externalBots) {
    cachedData.externalBots.forEach((bot) => {
      items.push({
        name: bot.name,
        type: 'external-bot',
        url: bot.chatUrl,
        keywords: [bot.name.toLowerCase(), ...bot.name.toLowerCase().split(' ')],
      });
    });
  }

  // Image creators (Midjourney, DALL-E, etc.)
  if (cachedData.imageCreators) {
    cachedData.imageCreators.forEach((creator) => {
      items.push({
        name: creator.name,
        type: 'image-creator',
        url: creator.chatUrl || creator.url,
        keywords: [creator.name.toLowerCase(), 'image', 'art', ...creator.name.toLowerCase().split(' ')],
      });
    });
  }

  // Video creators (Runway, Veo3, etc.)
  if (cachedData.videoCreators) {
    cachedData.videoCreators.forEach((creator) => {
      items.push({
        name: creator.name,
        type: 'video-creator',
        url: creator.chatUrl || creator.url,
        keywords: [creator.name.toLowerCase(), 'video', ...creator.name.toLowerCase().split(' ')],
      });
    });
  }

  // Audio generators (ElevenLabs, etc.)
  if (cachedData.audioGenerators) {
    cachedData.audioGenerators.forEach((generator) => {
      items.push({
        name: generator.name,
        type: 'audio-generator',
        url: generator.chatUrl || generator.url,
        keywords: [generator.name.toLowerCase(), 'audio', 'voice', ...generator.name.toLowerCase().split(' ')],
      });
    });
  }

  // IDW environments
  if (cachedData.idwEnvironments) {
    cachedData.idwEnvironments.forEach((env) => {
      items.push({
        name: env.label || env.name,
        type: 'idw-environment',
        url: env.chatUrl || env.url, // IDW environments use chatUrl
        keywords: [(env.label || env.name || '').toLowerCase(), 'idw', 'environment'],
      });
    });
  }

  // Tools menu items (modules and web tools)
  // Note: LLM uses item names for matching, no keywords needed
  if (global.moduleManager) {
    // Installed modules
    const modules = global.moduleManager.getInstalledModules();
    if (modules && modules.length > 0) {
      modules.forEach((mod) => {
        items.push({
          name: mod.name || mod.id,
          type: 'tool-module',
          action: 'open-module',
          moduleId: mod.id,
          keywords: [], // LLM matches by name
        });
      });
    }

    // Web tools
    const webTools = global.moduleManager.getWebTools();
    if (webTools && webTools.length > 0) {
      webTools.forEach((tool) => {
        items.push({
          name: tool.name,
          type: 'web-tool',
          action: 'open-web-tool',
          url: tool.url,
          keywords: [], // LLM matches by name
        });
      });
    }
  }

  // Built-in tools
  const builtInTools = [
    { name: 'Black Hole', type: 'tool', action: 'open-black-hole', keywords: [] },
    { name: 'Clipboard Viewer', type: 'tool', action: 'open-clipboard-viewer', keywords: [] },
  ];
  items.push(...builtInTools);

  return items;
}

const ai = require('./lib/ai-service');

/**
 * Use LLM to find the best matching menu item for a user's request
 * @param {string} userRequest - What the user said
 * @returns {Promise<Object|null>} - Matching menu item or null
 */
async function findMenuItemWithLLM(userRequest) {
  const items = getOpenableItems();

  if (items.length === 0) {
    console.log('[Menu] No menu items available');
    return null;
  }

  // Build the list of available items for the LLM
  const itemList = items.map((item, i) => `${i + 1}. "${item.name}" (${item.type})`).join('\n');

  const prompt = `You are a voice command interpreter matching garbled speech-to-text to menu items.

AVAILABLE MENU ITEMS:
${itemList}

USER SAID: "${userRequest}"

CRITICAL: Voice transcription is often VERY WRONG. Common errors:
- "OpenGLAD" or "open glad" = "Open Claude" 
- "OpenCLoud" or "open cloud" = "Open Claude"
- "chat GBT" or "chat GPT" = "ChatGPT"
- "mid journey" or "mid jerky" = "Midjourney"
- "dolly" or "dally" = "DALL-E"
- "eleven lab" = "ElevenLabs"
- "Jim and I" or "gem in eye" = "Gemini"
- "run way" = "Runway"
- "perplexing" = "Perplexity"
- Words often merged: "openclaude" "opengpt" "launchgemini"

Your task: Find the INTENDED menu item despite transcription errors.
- Look for phonetic similarity (sounds like)
- Look for partial matches
- Assume "open" or "launch" at the start means they want to open something
- Be generous - if it COULD be a match, it probably is

Respond with JSON only:
{
  "matchIndex": <1-based index of matching item, or 0 if truly no match>,
  "confidence": <0.0-1.0>,
  "reasoning": "<brief explanation>"
}`;

  try {
    const response = await ai.chat({
      profile: 'fast',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      maxTokens: 150,
      jsonMode: true,
      feature: 'menu-matcher',
    });

    const content = response.content || '';

    // Parse JSON response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('[Menu] LLM returned invalid JSON');
      return findMenuItemSimple(userRequest);
    }

    const result = JSON.parse(jsonMatch[0]);
    console.log(`[Menu] LLM match result:`, result);

    if (result.matchIndex > 0 && result.matchIndex <= items.length && result.confidence >= 0.3) {
      const matchedItem = items[result.matchIndex - 1];
      console.log(`[Menu] LLM matched "${userRequest}" to "${matchedItem.name}" (confidence: ${result.confidence})`);
      return matchedItem;
    }

    // LLM didn't match - try phonetic fallback for common cases
    console.log(`[Menu] LLM found no match, trying phonetic fallback for "${userRequest}"`);
    return findMenuItemPhonetic(userRequest, items);
  } catch (error) {
    console.error('[Menu] LLM matching error:', error.message);
    return findMenuItemSimple(userRequest);
  }
}

/**
 * Phonetic/fuzzy fallback for common transcription errors
 */
function findMenuItemPhonetic(query, items) {
  const lower = query.toLowerCase().replace(/[^a-z]/g, ''); // Remove non-letters

  // Common phonetic patterns: what it sounds like → what they meant
  const phoneticMap = {
    // Claude variations
    glad: 'claude',
    cloud: 'claude',
    clod: 'claude',
    claud: 'claude',
    claw: 'claude',
    clawed: 'claude',
    klad: 'claude',
    // ChatGPT variations
    gpt: 'chatgpt',
    gbt: 'chatgpt',
    chatgbt: 'chatgpt',
    chargpt: 'chatgpt',
    chatgp: 'chatgpt',
    chegg: 'chatgpt',
    // Gemini variations
    gemini: 'gemini',
    jimini: 'gemini',
    jiminy: 'gemini',
    jemini: 'gemini',
    // Midjourney variations
    journey: 'midjourney',
    midjerky: 'midjourney',
    midjourny: 'midjourney',
    // DALL-E variations
    dolly: 'dall-e',
    dally: 'dall-e',
    dalle: 'dall-e',
    dali: 'dall-e',
    // Perplexity variations
    perplexity: 'perplexity',
    perplexing: 'perplexity',
    perplex: 'perplexity',
    // Runway variations
    runway: 'runway',
    runaway: 'runway',
    // ElevenLabs variations
    elevenlabs: 'elevenlabs',
    elevenlab: 'elevenlabs',
    eleven: 'elevenlabs',
    // Grok variations
    grok: 'grok',
    grock: 'grok',
    grawl: 'grok',
  };

  // Check each phonetic pattern
  for (const [sound, target] of Object.entries(phoneticMap)) {
    if (lower.includes(sound)) {
      // Find item matching the target
      const match = items.find(
        (item) => item.name.toLowerCase().includes(target) || item.keywords.some((kw) => kw.includes(target))
      );
      if (match) {
        console.log(`[Menu] Phonetic match: "${sound}" in "${query}" → "${match.name}"`);
        return match;
      }
    }
  }

  return null;
}

/**
 * Simple fallback matching (when LLM is unavailable)
 */
function findMenuItemSimple(query) {
  const items = getOpenableItems();
  const lower = query.toLowerCase();

  // Try exact name match
  let match = items.find((item) => item.name.toLowerCase() === lower);
  if (match) return match;

  // Try contains
  match = items.find((item) => lower.includes(item.name.toLowerCase()) || item.name.toLowerCase().includes(lower));
  if (match) return match;

  // Try keywords
  match = items.find((item) => item.keywords.some((kw) => lower.includes(kw) || kw.includes(lower)));

  return match || null;
}

/**
 * Find menu item - uses LLM when available, falls back to simple matching
 * @param {string} query - User's request
 * @returns {Promise<Object|null>}
 */
async function findMenuItem(query) {
  return findMenuItemWithLLM(query);
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
  closeAllGSXWindows,
  // For agent/voice access
  getOpenableItems,
  findMenuItem,
};
