/**
 * Electron Main Process
 * 
 * Entry point for the Electron desktop app with overlay windows.
 * Creates the floating orb window and expandable chat panel.
 */

import { app, BrowserWindow, screen, ipcMain } from 'electron'
import * as path from 'path'
import { DEFAULT_CONFIG, type ElectronConfig, type OrbWindowConfig, type PanelWindowConfig } from './types'
import { registerShortcuts, unregisterShortcuts } from './shortcuts'
import { createTray, destroyTray } from './tray'
import { registerHandlers } from './handlers'

let orbWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null
let config: ElectronConfig = DEFAULT_CONFIG

// ============================================================================
// ORB WINDOW
// ============================================================================

function createOrbWindow(orbConfig: OrbWindowConfig = {}): BrowserWindow {
  const display = screen.getPrimaryDisplay()
  const { width: screenWidth, height: screenHeight } = display.workAreaSize

  const width = orbConfig.width ?? 80
  const height = orbConfig.height ?? 80
  const x = orbConfig.x ?? screenWidth - width - 20
  const y = orbConfig.y ?? screenHeight - height - 20

  const window = new BrowserWindow({
    width,
    height,
    x,
    y,
    alwaysOnTop: orbConfig.alwaysOnTop ?? true,
    transparent: orbConfig.transparent ?? true,
    frame: orbConfig.frame ?? false,
    skipTaskbar: orbConfig.skipTaskbar ?? true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Set window level to float above everything (like Spotlight)
  window.setAlwaysOnTop(true, 'floating')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Load the orb UI
  if (process.env.ELECTRON_DEV_URL) {
    window.loadURL(`${process.env.ELECTRON_DEV_URL}/orb.html`)
  } else {
    window.loadFile(path.join(__dirname, '../renderer/orb.html'))
  }

  return window
}

// ============================================================================
// PANEL WINDOW
// ============================================================================

function createPanelWindow(panelConfig: PanelWindowConfig = {}): BrowserWindow {
  const display = screen.getPrimaryDisplay()
  const { width: screenWidth, height: screenHeight } = display.workAreaSize

  const width = panelConfig.width ?? 400
  const height = panelConfig.height ?? 600

  const window = new BrowserWindow({
    width,
    height,
    x: screenWidth - width - 20,
    y: screenHeight - height - 100,
    minWidth: panelConfig.minWidth ?? 320,
    minHeight: panelConfig.minHeight ?? 400,
    show: panelConfig.show ?? false,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  window.setAlwaysOnTop(true, 'floating')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Load the panel UI
  if (process.env.ELECTRON_DEV_URL) {
    window.loadURL(`${process.env.ELECTRON_DEV_URL}/panel.html`)
  } else {
    window.loadFile(path.join(__dirname, '../renderer/panel.html'))
  }

  return window
}

// ============================================================================
// WINDOW MANAGEMENT IPC
// ============================================================================

function setupWindowIPC() {
  // Orb window controls
  ipcMain.handle('orb:show', () => {
    orbWindow?.show()
  })

  ipcMain.handle('orb:hide', () => {
    orbWindow?.hide()
  })

  ipcMain.handle('orb:toggle', () => {
    if (orbWindow?.isVisible()) {
      orbWindow.hide()
    } else {
      orbWindow?.show()
    }
  })

  ipcMain.handle('orb:position', (_event, x: number, y: number) => {
    orbWindow?.setPosition(x, y)
  })

  // Panel window controls
  ipcMain.handle('panel:show', () => {
    panelWindow?.show()
  })

  ipcMain.handle('panel:hide', () => {
    panelWindow?.hide()
  })

  ipcMain.handle('panel:toggle', () => {
    if (panelWindow?.isVisible()) {
      panelWindow.hide()
    } else {
      panelWindow?.show()
    }
  })
}

// ============================================================================
// APP LIFECYCLE
// ============================================================================

export function initialize(userConfig: Partial<ElectronConfig> = {}) {
  config = { ...DEFAULT_CONFIG, ...userConfig }
}

async function createWindows() {
  orbWindow = createOrbWindow(config.orb)
  panelWindow = createPanelWindow(config.panel)

  setupWindowIPC()
  registerHandlers()

  if (config.toggleShortcut) {
    registerShortcuts(config.toggleShortcut, () => {
      if (orbWindow?.isVisible()) {
        orbWindow.hide()
        panelWindow?.hide()
      } else {
        orbWindow?.show()
      }
    })
  }

  if (config.showInTray) {
    createTray({
      onShowOrb: () => orbWindow?.show(),
      onShowPanel: () => panelWindow?.show(),
      onQuit: () => app.quit(),
    })
  }

  // Handle orb click to show panel
  ipcMain.on('orb:clicked', () => {
    panelWindow?.show()
  })
}

app.whenReady().then(createWindows)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindows()
  }
})

app.on('will-quit', () => {
  unregisterShortcuts()
  destroyTray()
})

// macOS: Hide dock icon if configured
if (process.platform === 'darwin' && !config.showInDock) {
  app.dock.hide()
}

// ============================================================================
// EXPORTS FOR PROGRAMMATIC USE
// ============================================================================

export function getOrbWindow(): BrowserWindow | null {
  return orbWindow
}

export function getPanelWindow(): BrowserWindow | null {
  return panelWindow
}

export function showOrb() {
  orbWindow?.show()
}

export function hideOrb() {
  orbWindow?.hide()
}

export function showPanel() {
  panelWindow?.show()
}

export function hidePanel() {
  panelWindow?.hide()
}

export function sendToOrb(channel: string, data: unknown) {
  orbWindow?.webContents.send(channel, data)
}

export function sendToPanel(channel: string, data: unknown) {
  panelWindow?.webContents.send(channel, data)
}
