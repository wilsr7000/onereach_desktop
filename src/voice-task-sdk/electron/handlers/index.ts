/**
 * IPC Handlers Index
 * 
 * Registers all IPC handlers for system integration.
 */

import { registerAppleScriptHandlers } from './applescript'
import { registerTerminalHandlers } from './terminal'
import { registerFilesystemHandlers } from './filesystem'
import { registerSpotlightHandlers } from './spotlight'
import { registerActiveAppHandlers } from './activeApp'
import { registerScreenshotHandlers } from './screenshot'
import { registerMouseHandlers } from './mouse'
import { registerKeyboardHandlers } from './keyboard'

/**
 * Register all IPC handlers
 */
export function registerHandlers(): void {
  registerAppleScriptHandlers()
  registerTerminalHandlers()
  registerFilesystemHandlers()
  registerSpotlightHandlers()
  registerActiveAppHandlers()
  registerScreenshotHandlers()
  registerMouseHandlers()
  registerKeyboardHandlers()
  
  console.log('All IPC handlers registered')
}

// Re-export individual handler registrations
export { registerAppleScriptHandlers } from './applescript'
export { registerTerminalHandlers } from './terminal'
export { registerFilesystemHandlers } from './filesystem'
export { registerSpotlightHandlers } from './spotlight'
export { registerActiveAppHandlers } from './activeApp'
export { registerScreenshotHandlers } from './screenshot'
export { registerMouseHandlers } from './mouse'
export { registerKeyboardHandlers } from './keyboard'
