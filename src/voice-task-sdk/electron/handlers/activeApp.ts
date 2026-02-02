/**
 * Active App Handler
 * 
 * Detects the frontmost application and browser URL.
 */

import { ipcMain } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'
import type { ActiveAppInfo } from '../types'

const execAsync = promisify(exec)

/**
 * Get information about the active (frontmost) application
 */
export async function getActiveApp(): Promise<ActiveAppInfo> {
  if (process.platform === 'darwin') {
    return getActiveAppMacOS()
  } else if (process.platform === 'win32') {
    return getActiveAppWindows()
  } else {
    return getActiveAppLinux()
  }
}

/**
 * macOS: Get active app using AppleScript
 */
async function getActiveAppMacOS(): Promise<ActiveAppInfo> {
  try {
    // Get basic app info
    const { stdout: appInfo } = await execAsync(`osascript -e '
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        set appPath to POSIX path of (application file of frontApp as text)
        set appPid to unix id of frontApp
        return appName & "|" & appPath & "|" & appPid
      end tell
    '`)

    const [name, path, pidStr] = appInfo.trim().split('|')
    const pid = parseInt(pidStr, 10)

    const result: ActiveAppInfo = { name, path, pid }

    // Try to get browser URL if it's a browser
    const browserBundleIds = ['com.apple.Safari', 'com.google.Chrome', 'org.mozilla.firefox', 'com.microsoft.edgemac']
    
    if (name === 'Safari') {
      try {
        const { stdout } = await execAsync(`osascript -e '
          tell application "Safari"
            if (count of windows) > 0 then
              return URL of current tab of front window
            end if
          end tell
        '`)
        result.url = stdout.trim()
        result.bundleId = 'com.apple.Safari'
      } catch { /* Safari not available */ }
    } else if (name === 'Google Chrome') {
      try {
        const { stdout } = await execAsync(`osascript -e '
          tell application "Google Chrome"
            if (count of windows) > 0 then
              return URL of active tab of front window
            end if
          end tell
        '`)
        result.url = stdout.trim()
        result.bundleId = 'com.google.Chrome'
      } catch { /* Chrome not available */ }
    } else if (name === 'Firefox') {
      // Firefox doesn't support AppleScript well, but we can try
      result.bundleId = 'org.mozilla.firefox'
    } else if (name === 'Microsoft Edge') {
      try {
        const { stdout } = await execAsync(`osascript -e '
          tell application "Microsoft Edge"
            if (count of windows) > 0 then
              return URL of active tab of front window
            end if
          end tell
        '`)
        result.url = stdout.trim()
        result.bundleId = 'com.microsoft.edgemac'
      } catch { /* Edge not available */ }
    }

    return result
  } catch (error) {
    return { name: 'Unknown' }
  }
}

/**
 * Windows: Get active app using PowerShell
 */
async function getActiveAppWindows(): Promise<ActiveAppInfo> {
  try {
    const { stdout } = await execAsync(`powershell -command "
      Add-Type @'
        using System;
        using System.Runtime.InteropServices;
        public class Win32 {
          [DllImport(\\"user32.dll\\")]
          public static extern IntPtr GetForegroundWindow();
          [DllImport(\\"user32.dll\\")]
          public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);
        }
'@
      $hwnd = [Win32]::GetForegroundWindow()
      $pid = 0
      [Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid)
      $process = Get-Process -Id $pid
      Write-Output $process.ProcessName
      Write-Output $process.Path
      Write-Output $pid
    "`)

    const lines = stdout.trim().split('\n')
    return {
      name: lines[0] || 'Unknown',
      path: lines[1],
      pid: parseInt(lines[2], 10),
    }
  } catch {
    return { name: 'Unknown' }
  }
}

/**
 * Linux: Get active app using xdotool
 */
async function getActiveAppLinux(): Promise<ActiveAppInfo> {
  try {
    const { stdout: windowId } = await execAsync('xdotool getactivewindow')
    const { stdout: name } = await execAsync(`xdotool getwindowname ${windowId.trim()}`)
    const { stdout: pid } = await execAsync(`xdotool getwindowpid ${windowId.trim()}`)

    return {
      name: name.trim(),
      pid: parseInt(pid.trim(), 10),
    }
  } catch {
    return { name: 'Unknown' }
  }
}

/**
 * Register IPC handlers for active app
 */
export function registerActiveAppHandlers(): void {
  ipcMain.handle('activeApp:get', async () => {
    return getActiveApp()
  })
}
