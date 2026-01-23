/**
 * Keyboard Handler
 * 
 * Keyboard input for automation.
 * Note: Requires robotjs for actual keyboard control.
 * This is a mock implementation for type safety.
 */

import { ipcMain } from 'electron'
import type { KeyboardModifiers } from '../types'

// Type for robotjs (optional dependency)
interface RobotJS {
  typeString: (text: string) => void
  keyTap: (key: string, modifiers?: string | string[]) => void
  keyToggle: (key: string, down: 'down' | 'up', modifiers?: string[]) => void
}

let robot: RobotJS | null = null

// Try to load robotjs (optional dependency)
try {
  robot = require('robotjs') as RobotJS
} catch {
  console.warn('robotjs not available - keyboard control will use fallback')
}

/**
 * Type text naturally
 */
export function typeText(text: string): void {
  if (robot) {
    robot.typeString(text)
  } else {
    console.log(`[Mock] Typed: "${text}"`)
  }
}

/**
 * Press a key with optional modifiers
 */
export function pressKey(key: string, modifiers?: KeyboardModifiers): void {
  if (robot) {
    const mods: string[] = []
    if (modifiers?.shift) mods.push('shift')
    if (modifiers?.control) mods.push('control')
    if (modifiers?.alt) mods.push('alt')
    if (modifiers?.meta) mods.push('command')
    
    robot.keyTap(key, mods.length > 0 ? mods : undefined)
  } else {
    const modStr = modifiers 
      ? Object.entries(modifiers).filter(([, v]) => v).map(([k]) => k).join('+')
      : ''
    console.log(`[Mock] Key pressed: ${modStr ? modStr + '+' : ''}${key}`)
  }
}

/**
 * Hold down a key
 */
export function keyDown(key: string): void {
  if (robot) {
    robot.keyToggle(key, 'down')
  } else {
    console.log(`[Mock] Key down: ${key}`)
  }
}

/**
 * Release a key
 */
export function keyUp(key: string): void {
  if (robot) {
    robot.keyToggle(key, 'up')
  } else {
    console.log(`[Mock] Key up: ${key}`)
  }
}

/**
 * Press a keyboard shortcut
 */
export function pressShortcut(keys: string[]): void {
  if (keys.length === 0) return

  if (robot) {
    const mainKey = keys[keys.length - 1]
    const modifiers = keys.slice(0, -1).map(k => {
      switch (k.toLowerCase()) {
        case 'cmd':
        case 'command':
        case 'meta':
          return 'command'
        case 'ctrl':
        case 'control':
          return 'control'
        case 'alt':
        case 'option':
          return 'alt'
        case 'shift':
          return 'shift'
        default:
          return k
      }
    })
    
    robot.keyTap(mainKey, modifiers)
  } else {
    console.log(`[Mock] Shortcut: ${keys.join('+')}`)
  }
}

// ============================================================================
// COMMON SHORTCUTS
// ============================================================================

export function copy(): void {
  pressShortcut(['command', 'c'])
}

export function paste(): void {
  pressShortcut(['command', 'v'])
}

export function cut(): void {
  pressShortcut(['command', 'x'])
}

export function selectAll(): void {
  pressShortcut(['command', 'a'])
}

export function undo(): void {
  pressShortcut(['command', 'z'])
}

export function redo(): void {
  pressShortcut(['command', 'shift', 'z'])
}

export function save(): void {
  pressShortcut(['command', 's'])
}

export function newTab(): void {
  pressShortcut(['command', 't'])
}

export function closeTab(): void {
  pressShortcut(['command', 'w'])
}

export function switchTab(): void {
  pressShortcut(['command', 'tab'])
}

/**
 * Register IPC handlers for keyboard
 */
export function registerKeyboardHandlers(): void {
  ipcMain.handle('keyboard:type', async (_event, text: string) => {
    typeText(text)
  })

  ipcMain.handle('keyboard:press', async (_event, key: string, modifiers?: KeyboardModifiers) => {
    pressKey(key, modifiers)
  })

  ipcMain.handle('keyboard:down', async (_event, key: string) => {
    keyDown(key)
  })

  ipcMain.handle('keyboard:up', async (_event, key: string) => {
    keyUp(key)
  })

  ipcMain.handle('keyboard:shortcut', async (_event, keys: string[]) => {
    pressShortcut(keys)
  })

  // Common shortcuts
  ipcMain.handle('keyboard:copy', async () => copy())
  ipcMain.handle('keyboard:paste', async () => paste())
  ipcMain.handle('keyboard:cut', async () => cut())
  ipcMain.handle('keyboard:selectAll', async () => selectAll())
  ipcMain.handle('keyboard:undo', async () => undo())
  ipcMain.handle('keyboard:redo', async () => redo())
}
