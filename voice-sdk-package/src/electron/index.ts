/**
 * Electron Module Exports
 * 
 * Public API for the Electron desktop integration.
 */

// Types
export type {
  OrbWindowConfig,
  PanelWindowConfig,
  WindowPosition,
  AppleScriptResult,
  TerminalResult,
  FileSystemResult,
  SpotlightResult,
  ActiveAppInfo,
  ScreenshotResult,
  MousePosition,
  KeyboardModifiers,
  IPCChannel,
  ElectronAPI,
  ElectronConfig,
} from './types'

export { DEFAULT_CONFIG } from './types'

// Main process
export {
  initialize,
  getOrbWindow,
  getPanelWindow,
  showOrb,
  hideOrb,
  showPanel,
  hidePanel,
  sendToOrb,
  sendToPanel,
} from './main'

// Shortcuts
export {
  registerShortcuts,
  unregisterShortcuts,
  isShortcutRegistered,
  getRegisteredShortcut,
} from './shortcuts'

// Tray
export {
  createTray,
  destroyTray,
  updateTrayIcon,
  updateTrayTooltip,
  getTray,
  type TrayCallbacks,
} from './tray'

// Handlers
export { registerHandlers } from './handlers'
export {
  runAppleScript,
  runAppleScriptFile,
  getFrontmostApp,
  getBrowserURL,
  showNotification,
  openURL,
  openApplication,
} from './handlers/applescript'
export {
  execCommand,
  execStreaming,
  cancelProcess,
  commandExists,
  getCurrentDirectory,
  getEnvVar,
} from './handlers/terminal'
export {
  readFile,
  writeFile,
  listDirectory,
  searchFiles,
  pathExists,
  getFileStats,
} from './handlers/filesystem'
export {
  spotlightSearch,
  spotlightSearchByName,
  spotlightSearchByContent,
  spotlightSearchByKind,
  spotlightSearchRecent,
  getFileMetadata,
} from './handlers/spotlight'
export {
  getActiveApp,
} from './handlers/activeApp'
export {
  captureScreen,
  captureWindow,
  getAvailableWindows,
  captureRegion,
} from './handlers/screenshot'
export {
  moveMouse,
  clickMouse,
  getMousePosition,
  scrollMouse,
  dragMouse,
} from './handlers/mouse'
export {
  typeText,
  pressKey,
  keyDown,
  keyUp,
  pressShortcut,
  copy,
  paste,
  cut,
  selectAll,
  undo,
  redo,
  save,
  newTab,
  closeTab,
  switchTab,
} from './handlers/keyboard'
