/**
 * Dev Tools Menu Builder
 *
 * Builds the "Dev Tools" top-level menu for the Edison flow builder.
 * Follows the pattern of idw-gsx-builder.js.
 *
 * Categories:
 *   - Flow Context: current flow info, copy IDs
 *   - Event Log: toggle logging, view log
 *   - Library: browse/install step templates
 *   - SDK Dashboard: open settings
 */

const { clipboard, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const flowContext = require('../gsx-flow-context');
const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

function buildDevToolsMenu() {
  const ctx = flowContext.get();
  const hasContext = !!(ctx && ctx.flowId);
  const flowLabel = hasContext ? ctx.label || 'Unnamed Flow' : 'No flow detected';

  return {
    label: 'Dev Tools',
    submenu: [
      // --- Flow Context ---
      {
        label: `Flow: ${flowLabel}`,
        enabled: false,
      },
      ...(hasContext
        ? [
            {
              label: `Steps: ${ctx.stepCount || 0}`,
              enabled: false,
            },
          ]
        : []),
      { type: 'separator' },
      {
        label: 'Copy Flow ID',
        enabled: hasContext,
        click: () => {
          if (ctx?.flowId) {
            clipboard.writeText(ctx.flowId);
            log.info('dev-tools', 'Copied flow ID to clipboard', { flowId: ctx.flowId });
          }
        },
      },
      {
        label: 'Copy Flow JSON Context',
        enabled: hasContext,
        click: () => {
          if (ctx) {
            clipboard.writeText(JSON.stringify(ctx, null, 2));
            log.info('dev-tools', 'Copied flow context JSON to clipboard');
          }
        },
      },
      { type: 'separator' },

      // --- Event Log ---
      {
        label: 'Event Logging',
        submenu: [
          {
            label: 'Logging Enabled',
            type: 'checkbox',
            checked: _isLoggingEnabled(),
            click: (menuItem) => {
              _setLoggingEnabled(menuItem.checked);
              log.info('dev-tools', 'Event logging toggled', { enabled: menuItem.checked });
            },
          },
          { type: 'separator' },
          {
            label: 'View Event Log...',
            click: () => {
              ipcMain.emit('menu-action', null, { action: 'dev-tools-view-log' });
            },
          },
          {
            label: 'Clear Session Log',
            click: () => {
              ipcMain.emit('menu-action', null, { action: 'dev-tools-clear-log' });
            },
          },
        ],
      },
      { type: 'separator' },

      // --- Library ---
      {
        label: 'Library',
        submenu: [
          {
            label: 'Browse Step Templates...',
            accelerator: 'CmdOrCtrl+Shift+L',
            click: () => {
              _openLibraryBrowser();
            },
          },
        ],
      },
      { type: 'separator' },

      // --- SDK Dashboard ---
      {
        label: 'Open SDK Dashboard...',
        click: () => {
          if (typeof global.openSettingsWindowGlobal === 'function') {
            global.openSettingsWindowGlobal('edison-sdks');
          }
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Event logging state (persisted via settingsManager)
// ---------------------------------------------------------------------------

function _isLoggingEnabled() {
  const sm = global.settingsManager;
  if (sm) {
    return sm.get('edisonEventLogging') !== false;
  }
  return true;
}

function _setLoggingEnabled(val) {
  const sm = global.settingsManager;
  if (sm) {
    sm.set('edisonEventLogging', val);
  }
}

// ---------------------------------------------------------------------------
// Library Browser window
// ---------------------------------------------------------------------------

let libraryWindow = null;

function _openLibraryBrowser() {
  if (libraryWindow && !libraryWindow.isDestroyed()) {
    libraryWindow.focus();
    return;
  }

  libraryWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    title: 'Edison Step Library',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
    backgroundColor: '#111111',
    show: false,
  });

  libraryWindow.loadFile(path.join(__dirname, '..', '..', 'library-browser.html'));
  libraryWindow.once('ready-to-show', () => libraryWindow.show());
  libraryWindow.on('closed', () => { libraryWindow = null; });

  libraryWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      const lvl = level >= 3 ? 'error' : 'warn';
      log[lvl]('library-browser', message, { line, source: sourceId });
    }
  });

  log.info('dev-tools', 'Opened Library Browser window');
}

// ---------------------------------------------------------------------------
// Flow Validator results modal
// ---------------------------------------------------------------------------

let validatorWindow = null;

function _openValidatorResults() {
  if (validatorWindow && !validatorWindow.isDestroyed()) {
    validatorWindow.close();
  }

  validatorWindow = new BrowserWindow({
    width: 800,
    height: 600,
    title: 'Flow Validation Results',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
    backgroundColor: '#0f172a',
    show: false,
  });

  validatorWindow.loadFile(path.join(__dirname, '..', '..', 'flow-validator-results.html'));
  validatorWindow.once('ready-to-show', () => validatorWindow.show());
  validatorWindow.on('closed', () => { validatorWindow = null; });

  validatorWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      const lvl = level >= 3 ? 'error' : 'warn';
      log[lvl]('flow-validator', message, { line, source: sourceId });
    }
  });

  log.info('dev-tools', 'Opened Flow Validator results window');
}

// ---------------------------------------------------------------------------
// Flow Logs Results window
// ---------------------------------------------------------------------------

let flowLogsWindow = null;

function _openFlowLogsResults() {
  if (flowLogsWindow && !flowLogsWindow.isDestroyed()) {
    flowLogsWindow.close();
  }

  flowLogsWindow = new BrowserWindow({
    width: 860,
    height: 640,
    title: 'Flow Log Analysis',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
    backgroundColor: '#0f172a',
    show: false,
  });

  flowLogsWindow.loadFile(path.join(__dirname, '..', '..', 'flow-logs-results.html'));
  flowLogsWindow.once('ready-to-show', () => flowLogsWindow.show());
  flowLogsWindow.on('closed', () => { flowLogsWindow = null; });

  flowLogsWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      const lvl = level >= 3 ? 'error' : 'warn';
      log[lvl]('flow-logs', message, { line, source: sourceId });
    }
  });

  log.info('dev-tools', 'Opened Flow Logs results window');
}

// ---------------------------------------------------------------------------
// Configure Step window
// ---------------------------------------------------------------------------

let configureStepWindow = null;

function _openConfigureStep() {
  if (configureStepWindow && !configureStepWindow.isDestroyed()) {
    configureStepWindow.close();
  }

  configureStepWindow = new BrowserWindow({
    width: 720,
    height: 520,
    title: 'Configure Step',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
    backgroundColor: '#0f172a',
    show: false,
  });

  configureStepWindow.loadFile(path.join(__dirname, '..', '..', 'configure-step.html'));
  configureStepWindow.once('ready-to-show', () => configureStepWindow.show());
  configureStepWindow.on('closed', () => { configureStepWindow = null; });

  configureStepWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      const lvl = level >= 3 ? 'error' : 'warn';
      log[lvl]('configure-step', message, { line, source: sourceId });
    }
  });

  log.info('dev-tools', 'Opened Configure Step window');
}

let buildStepWindow = null;

function _openBuildStepTemplate() {
  if (buildStepWindow && !buildStepWindow.isDestroyed()) {
    buildStepWindow.focus();
    return;
  }

  buildStepWindow = new BrowserWindow({
    width: 960,
    height: 720,
    title: 'Build a Step Template',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
    backgroundColor: '#0f172a',
    show: false,
  });

  buildStepWindow.loadFile(path.join(__dirname, '..', '..', 'build-step-template.html'));
  buildStepWindow.once('ready-to-show', () => buildStepWindow.show());
  buildStepWindow.on('closed', () => { buildStepWindow = null; });

  buildStepWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      const lvl = level >= 3 ? 'error' : 'warn';
      log[lvl]('build-step-template', message, { line, source: sourceId });
    }
  });

  log.info('dev-tools', 'Opened Build Step Template window');
}

module.exports = {
  buildDevToolsMenu,
  openLibraryBrowser: _openLibraryBrowser,
  openValidatorResults: _openValidatorResults,
  openFlowLogsResults: _openFlowLogsResults,
  openConfigureStep: _openConfigureStep,
  openBuildStepTemplate: _openBuildStepTemplate,
};
