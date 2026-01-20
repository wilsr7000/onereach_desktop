/**
 * System Tray
 * 
 * Creates a system tray icon with menu for quick access.
 */

import { Tray, Menu, nativeImage, app } from 'electron'
import * as path from 'path'

let tray: Tray | null = null

export interface TrayCallbacks {
  onShowOrb?: () => void
  onShowPanel?: () => void
  onSettings?: () => void
  onQuit?: () => void
}

/**
 * Create system tray icon and menu
 */
export function createTray(callbacks: TrayCallbacks = {}): Tray {
  // Create tray icon - use a template image for macOS dark/light mode support
  const iconPath = path.join(__dirname, '../assets/tray-icon.png')
  
  // Create a small icon (16x16 for tray)
  let icon: Electron.NativeImage
  try {
    icon = nativeImage.createFromPath(iconPath)
    icon = icon.resize({ width: 16, height: 16 })
  } catch {
    // Fallback: create a simple colored circle if icon not found
    icon = nativeImage.createEmpty()
  }

  tray = new Tray(icon)
  tray.setToolTip('Voice Orb')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Voice Orb',
      click: () => callbacks.onShowOrb?.(),
    },
    {
      label: 'Open Panel',
      click: () => callbacks.onShowPanel?.(),
    },
    { type: 'separator' },
    {
      label: 'Settings...',
      click: () => callbacks.onSettings?.(),
    },
    { type: 'separator' },
    {
      label: `About Voice Orb v${app.getVersion()}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => callbacks.onQuit?.(),
    },
  ])

  tray.setContextMenu(contextMenu)

  // On macOS, click shows the menu; on Windows/Linux, we can toggle the orb
  tray.on('click', () => {
    if (process.platform !== 'darwin') {
      callbacks.onShowOrb?.()
    }
  })

  return tray
}

/**
 * Destroy the system tray
 */
export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

/**
 * Update tray icon
 */
export function updateTrayIcon(iconPath: string): void {
  if (tray) {
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    tray.setImage(icon)
  }
}

/**
 * Update tray tooltip
 */
export function updateTrayTooltip(tooltip: string): void {
  if (tray) {
    tray.setToolTip(tooltip)
  }
}

/**
 * Get the current tray instance
 */
export function getTray(): Tray | null {
  return tray
}
