/**
 * Screenshot Handler
 * 
 * Screen and window capture for Vision AI.
 */

import { ipcMain, desktopCapturer, screen } from 'electron'
import type { ScreenshotResult } from '../types'

/**
 * Capture the entire screen
 */
export async function captureScreen(): Promise<ScreenshotResult> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: screen.getPrimaryDisplay().workAreaSize,
    })

    if (sources.length === 0) {
      return {
        success: false,
        error: 'No screen sources available',
      }
    }

    const primarySource = sources[0]
    const dataUrl = primarySource.thumbnail.toDataURL()

    return {
      success: true,
      dataUrl,
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
 * Capture a specific window
 */
export async function captureWindow(windowId?: number): Promise<ScreenshotResult> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1920, height: 1080 },
    })

    if (sources.length === 0) {
      return {
        success: false,
        error: 'No window sources available',
      }
    }

    // If windowId provided, try to find matching window
    let source = sources[0]
    if (windowId) {
      const found = sources.find(s => s.id.includes(String(windowId)))
      if (found) source = found
    }

    const dataUrl = source.thumbnail.toDataURL()

    return {
      success: true,
      dataUrl,
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
 * Get list of available windows
 */
export async function getAvailableWindows(): Promise<Array<{ id: string; name: string }>> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 150, height: 150 },
    })

    return sources.map(source => ({
      id: source.id,
      name: source.name,
    }))
  } catch {
    return []
  }
}

/**
 * Capture a region of the screen
 */
export async function captureRegion(
  x: number, 
  y: number, 
  width: number, 
  height: number
): Promise<ScreenshotResult> {
  try {
    const result = await captureScreen()
    
    if (!result.success || !result.dataUrl) {
      return result
    }

    // Note: For actual region capture, you'd need to crop the image
    // This is a simplified implementation that returns the full screen
    // A production implementation would use canvas or sharp to crop
    
    return {
      success: true,
      dataUrl: result.dataUrl,
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
 * Register IPC handlers for screenshot
 */
export function registerScreenshotHandlers(): void {
  ipcMain.handle('screenshot:capture', async () => {
    return captureScreen()
  })

  ipcMain.handle('screenshot:captureWindow', async (_event, windowId?: number) => {
    return captureWindow(windowId)
  })

  ipcMain.handle('screenshot:getWindows', async () => {
    return getAvailableWindows()
  })

  ipcMain.handle('screenshot:captureRegion', async (_event, x: number, y: number, width: number, height: number) => {
    return captureRegion(x, y, width, height)
  })
}
