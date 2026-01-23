/**
 * Electron Type Definitions
 * 
 * Types for the Electron desktop integration layer.
 */

// ============================================================================
// WINDOW TYPES
// ============================================================================

export interface OrbWindowConfig {
  width?: number
  height?: number
  x?: number
  y?: number
  alwaysOnTop?: boolean
  transparent?: boolean
  frame?: boolean
  skipTaskbar?: boolean
}

export interface PanelWindowConfig {
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  show?: boolean
}

export interface WindowPosition {
  x: number
  y: number
  width: number
  height: number
}

// ============================================================================
// HANDLER TYPES
// ============================================================================

export interface AppleScriptResult {
  success: boolean
  output?: string
  error?: string
}

export interface TerminalResult {
  success: boolean
  stdout?: string
  stderr?: string
  exitCode?: number
  error?: string
}

export interface FileSystemResult {
  success: boolean
  data?: string | string[]
  error?: string
}

export interface SpotlightResult {
  success: boolean
  files?: string[]
  error?: string
}

export interface ActiveAppInfo {
  name: string
  bundleId?: string
  path?: string
  pid?: number
  url?: string // Browser URL if applicable
}

export interface ScreenshotResult {
  success: boolean
  dataUrl?: string
  path?: string
  error?: string
}

export interface MousePosition {
  x: number
  y: number
}

export interface KeyboardModifiers {
  shift?: boolean
  control?: boolean
  alt?: boolean
  meta?: boolean
}

// ============================================================================
// IPC CHANNEL TYPES
// ============================================================================

export type IPCChannel =
  // Window management
  | 'orb:show'
  | 'orb:hide'
  | 'orb:toggle'
  | 'orb:position'
  | 'panel:show'
  | 'panel:hide'
  | 'panel:toggle'
  // AppleScript
  | 'applescript:run'
  | 'applescript:result'
  // Terminal
  | 'terminal:exec'
  | 'terminal:result'
  // Filesystem
  | 'fs:read'
  | 'fs:write'
  | 'fs:list'
  | 'fs:search'
  | 'fs:result'
  // Spotlight
  | 'spotlight:search'
  | 'spotlight:result'
  // Active app
  | 'activeApp:get'
  | 'activeApp:result'
  // Screenshot
  | 'screenshot:capture'
  | 'screenshot:result'
  // Mouse
  | 'mouse:move'
  | 'mouse:click'
  | 'mouse:position'
  // Keyboard
  | 'keyboard:type'
  | 'keyboard:press'
  // SDK events
  | 'sdk:transcript'
  | 'sdk:status'
  | 'sdk:task'
  | 'sdk:error'

// ============================================================================
// ELECTRON API INTERFACE (exposed to renderer)
// ============================================================================

export interface ElectronAPI {
  // Window management
  showOrb: () => Promise<void>
  hideOrb: () => Promise<void>
  toggleOrb: () => Promise<void>
  setOrbPosition: (x: number, y: number) => Promise<void>
  showPanel: () => Promise<void>
  hidePanel: () => Promise<void>
  togglePanel: () => Promise<void>

  // AppleScript
  runAppleScript: (script: string) => Promise<AppleScriptResult>

  // Terminal
  execTerminal: (command: string, cwd?: string) => Promise<TerminalResult>

  // Filesystem
  readFile: (path: string) => Promise<FileSystemResult>
  writeFile: (path: string, content: string) => Promise<FileSystemResult>
  listDirectory: (path: string) => Promise<FileSystemResult>
  searchFiles: (query: string, directory?: string) => Promise<FileSystemResult>

  // Spotlight (macOS)
  spotlightSearch: (query: string, directory?: string) => Promise<SpotlightResult>

  // Active app
  getActiveApp: () => Promise<ActiveAppInfo>

  // Screenshot
  captureScreen: () => Promise<ScreenshotResult>
  captureWindow: (windowId?: number) => Promise<ScreenshotResult>

  // Mouse
  moveMouse: (x: number, y: number) => Promise<void>
  clickMouse: (button?: 'left' | 'right', double?: boolean) => Promise<void>
  getMousePosition: () => Promise<MousePosition>

  // Keyboard
  typeText: (text: string) => Promise<void>
  pressKey: (key: string, modifiers?: KeyboardModifiers) => Promise<void>

  // Event listeners
  onTranscript: (callback: (transcript: string) => void) => () => void
  onStatus: (callback: (status: string) => void) => () => void
  onTask: (callback: (task: unknown) => void) => () => void
  onError: (callback: (error: string) => void) => () => void
}

// ============================================================================
// MAIN PROCESS CONFIG
// ============================================================================

export interface ElectronConfig {
  // Window settings
  orb: OrbWindowConfig
  panel: PanelWindowConfig

  // Shortcuts
  toggleShortcut?: string // e.g., 'CommandOrControl+Shift+Space'
  
  // Behavior
  startMinimized?: boolean
  showInDock?: boolean
  showInTray?: boolean
  launchAtLogin?: boolean

  // SDK integration
  apiKey?: string
  sdkConfig?: Record<string, unknown>
}

export const DEFAULT_CONFIG: ElectronConfig = {
  orb: {
    width: 80,
    height: 80,
    alwaysOnTop: true,
    transparent: true,
    frame: false,
    skipTaskbar: true,
  },
  panel: {
    width: 400,
    height: 600,
    minWidth: 320,
    minHeight: 400,
    show: false,
  },
  toggleShortcut: 'CommandOrControl+Shift+Space',
  startMinimized: false,
  showInDock: true,
  showInTray: true,
  launchAtLogin: false,
}
