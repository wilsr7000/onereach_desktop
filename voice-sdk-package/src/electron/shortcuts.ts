/**
 * Global Keyboard Shortcuts
 * 
 * Registers global shortcuts that work even when the app is not focused.
 * Default: Cmd+Shift+Space (like Spotlight)
 */

import { globalShortcut } from 'electron'

let registeredShortcut: string | null = null

/**
 * Register a global shortcut
 */
export function registerShortcuts(shortcut: string, callback: () => void): boolean {
  if (registeredShortcut) {
    unregisterShortcuts()
  }

  const success = globalShortcut.register(shortcut, callback)
  
  if (success) {
    registeredShortcut = shortcut
    console.log(`Global shortcut registered: ${shortcut}`)
  } else {
    console.error(`Failed to register global shortcut: ${shortcut}`)
  }

  return success
}

/**
 * Unregister all global shortcuts
 */
export function unregisterShortcuts(): void {
  if (registeredShortcut) {
    globalShortcut.unregister(registeredShortcut)
    console.log(`Global shortcut unregistered: ${registeredShortcut}`)
    registeredShortcut = null
  }
}

/**
 * Check if a shortcut is registered
 */
export function isShortcutRegistered(shortcut: string): boolean {
  return globalShortcut.isRegistered(shortcut)
}

/**
 * Get the currently registered shortcut
 */
export function getRegisteredShortcut(): string | null {
  return registeredShortcut
}
