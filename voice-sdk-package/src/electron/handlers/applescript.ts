/**
 * AppleScript Handler (macOS)
 * 
 * Executes AppleScript for system automation on macOS.
 */

import { ipcMain } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'
import type { AppleScriptResult } from '../types'

const execAsync = promisify(exec)

/**
 * Execute an AppleScript
 */
export async function runAppleScript(script: string): Promise<AppleScriptResult> {
  if (process.platform !== 'darwin') {
    return {
      success: false,
      error: 'AppleScript is only available on macOS',
    }
  }

  try {
    // Escape the script for shell execution
    const escapedScript = script.replace(/'/g, "'\\''")
    const { stdout, stderr } = await execAsync(`osascript -e '${escapedScript}'`)

    return {
      success: true,
      output: stdout.trim(),
      error: stderr.trim() || undefined,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return {
      success: false,
      error: message,
    }
  }
}

/**
 * Execute AppleScript from file
 */
export async function runAppleScriptFile(filePath: string): Promise<AppleScriptResult> {
  if (process.platform !== 'darwin') {
    return {
      success: false,
      error: 'AppleScript is only available on macOS',
    }
  }

  try {
    const { stdout, stderr } = await execAsync(`osascript "${filePath}"`)

    return {
      success: true,
      output: stdout.trim(),
      error: stderr.trim() || undefined,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return {
      success: false,
      error: message,
    }
  }
}

/**
 * Register IPC handlers for AppleScript
 */
export function registerAppleScriptHandlers(): void {
  ipcMain.handle('applescript:run', async (_event, script: string) => {
    return runAppleScript(script)
  })

  ipcMain.handle('applescript:runFile', async (_event, filePath: string) => {
    return runAppleScriptFile(filePath)
  })
}

// ============================================================================
// COMMON APPLESCRIPT HELPERS
// ============================================================================

/**
 * Get the frontmost application name
 */
export async function getFrontmostApp(): Promise<string | null> {
  const result = await runAppleScript(`
    tell application "System Events"
      set frontApp to name of first application process whose frontmost is true
    end tell
    return frontApp
  `)
  return result.success ? result.output ?? null : null
}

/**
 * Get the current Safari or Chrome URL
 */
export async function getBrowserURL(): Promise<string | null> {
  // Try Safari first
  let result = await runAppleScript(`
    tell application "Safari"
      if (count of windows) > 0 then
        return URL of current tab of front window
      end if
    end tell
    return ""
  `)

  if (result.success && result.output) {
    return result.output
  }

  // Try Chrome
  result = await runAppleScript(`
    tell application "Google Chrome"
      if (count of windows) > 0 then
        return URL of active tab of front window
      end if
    end tell
    return ""
  `)

  return result.success ? result.output || null : null
}

/**
 * Show a system notification
 */
export async function showNotification(title: string, message: string): Promise<boolean> {
  const result = await runAppleScript(`
    display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"
  `)
  return result.success
}

/**
 * Open a URL in the default browser
 */
export async function openURL(url: string): Promise<boolean> {
  const result = await runAppleScript(`
    open location "${url}"
  `)
  return result.success
}

/**
 * Open an application by name
 */
export async function openApplication(appName: string): Promise<boolean> {
  const result = await runAppleScript(`
    tell application "${appName}" to activate
  `)
  return result.success
}
