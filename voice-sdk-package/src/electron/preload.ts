/**
 * Electron Preload Script
 * 
 * Context bridge exposing safe IPC methods to the renderer process.
 * All Node.js APIs are accessed through this secure bridge.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { 
  ElectronAPI, 
  AppleScriptResult, 
  TerminalResult, 
  FileSystemResult,
  SpotlightResult,
  ActiveAppInfo,
  ScreenshotResult,
  MousePosition,
  KeyboardModifiers,
} from './types'

const electronAPI: ElectronAPI = {
  // ========================================================================
  // WINDOW MANAGEMENT
  // ========================================================================

  showOrb: () => ipcRenderer.invoke('orb:show'),
  hideOrb: () => ipcRenderer.invoke('orb:hide'),
  toggleOrb: () => ipcRenderer.invoke('orb:toggle'),
  setOrbPosition: (x: number, y: number) => ipcRenderer.invoke('orb:position', x, y),
  
  showPanel: () => ipcRenderer.invoke('panel:show'),
  hidePanel: () => ipcRenderer.invoke('panel:hide'),
  togglePanel: () => ipcRenderer.invoke('panel:toggle'),

  // ========================================================================
  // APPLESCRIPT (macOS)
  // ========================================================================

  runAppleScript: (script: string): Promise<AppleScriptResult> => 
    ipcRenderer.invoke('applescript:run', script),

  // ========================================================================
  // TERMINAL
  // ========================================================================

  execTerminal: (command: string, cwd?: string): Promise<TerminalResult> =>
    ipcRenderer.invoke('terminal:exec', command, cwd),

  // ========================================================================
  // FILESYSTEM
  // ========================================================================

  readFile: (path: string): Promise<FileSystemResult> =>
    ipcRenderer.invoke('fs:read', path),

  writeFile: (path: string, content: string): Promise<FileSystemResult> =>
    ipcRenderer.invoke('fs:write', path, content),

  listDirectory: (path: string): Promise<FileSystemResult> =>
    ipcRenderer.invoke('fs:list', path),

  searchFiles: (query: string, directory?: string): Promise<FileSystemResult> =>
    ipcRenderer.invoke('fs:search', query, directory),

  // ========================================================================
  // SPOTLIGHT (macOS)
  // ========================================================================

  spotlightSearch: (query: string, directory?: string): Promise<SpotlightResult> =>
    ipcRenderer.invoke('spotlight:search', query, directory),

  // ========================================================================
  // ACTIVE APP
  // ========================================================================

  getActiveApp: (): Promise<ActiveAppInfo> =>
    ipcRenderer.invoke('activeApp:get'),

  // ========================================================================
  // SCREENSHOT
  // ========================================================================

  captureScreen: (): Promise<ScreenshotResult> =>
    ipcRenderer.invoke('screenshot:capture'),

  captureWindow: (windowId?: number): Promise<ScreenshotResult> =>
    ipcRenderer.invoke('screenshot:captureWindow', windowId),

  // ========================================================================
  // MOUSE
  // ========================================================================

  moveMouse: (x: number, y: number): Promise<void> =>
    ipcRenderer.invoke('mouse:move', x, y),

  clickMouse: (button: 'left' | 'right' = 'left', double = false): Promise<void> =>
    ipcRenderer.invoke('mouse:click', button, double),

  getMousePosition: (): Promise<MousePosition> =>
    ipcRenderer.invoke('mouse:position'),

  // ========================================================================
  // KEYBOARD
  // ========================================================================

  typeText: (text: string): Promise<void> =>
    ipcRenderer.invoke('keyboard:type', text),

  pressKey: (key: string, modifiers?: KeyboardModifiers): Promise<void> =>
    ipcRenderer.invoke('keyboard:press', key, modifiers),

  // ========================================================================
  // EVENT LISTENERS
  // ========================================================================

  onTranscript: (callback: (transcript: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, transcript: string) => callback(transcript)
    ipcRenderer.on('sdk:transcript', handler)
    return () => ipcRenderer.removeListener('sdk:transcript', handler)
  },

  onStatus: (callback: (status: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: string) => callback(status)
    ipcRenderer.on('sdk:status', handler)
    return () => ipcRenderer.removeListener('sdk:status', handler)
  },

  onTask: (callback: (task: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, task: unknown) => callback(task)
    ipcRenderer.on('sdk:task', handler)
    return () => ipcRenderer.removeListener('sdk:task', handler)
  },

  onError: (callback: (error: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string) => callback(error)
    ipcRenderer.on('sdk:error', handler)
    return () => ipcRenderer.removeListener('sdk:error', handler)
  },
}

// Expose to renderer
contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// Also expose a way to send messages to main process
contextBridge.exposeInMainWorld('ipc', {
  send: (channel: string, data?: unknown) => {
    // Whitelist of allowed channels
    const validChannels = [
      'orb:clicked',
      'orb:drag',
      'panel:close',
      'sdk:start',
      'sdk:stop',
      'sdk:submit',
    ]
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data)
    }
  },
  invoke: (channel: string, ...args: unknown[]) => {
    // All invoke channels are handled through electronAPI
    return ipcRenderer.invoke(channel, ...args)
  },
})
