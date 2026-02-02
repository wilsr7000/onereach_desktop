/**
 * Spotlight Handler (macOS)
 * 
 * Uses mdfind for fast file search on macOS.
 */

import { ipcMain } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'
import type { SpotlightResult } from '../types'

const execAsync = promisify(exec)

/**
 * Search using Spotlight (mdfind)
 */
export async function spotlightSearch(
  query: string, 
  directory?: string
): Promise<SpotlightResult> {
  if (process.platform !== 'darwin') {
    return {
      success: false,
      error: 'Spotlight search is only available on macOS',
    }
  }

  try {
    let command = `mdfind "${query.replace(/"/g, '\\"')}"`
    
    if (directory) {
      command += ` -onlyin "${directory.replace(/"/g, '\\"')}"`
    }
    
    // Limit results
    command += ' | head -100'

    const { stdout } = await execAsync(command, { timeout: 10000 })
    
    const files = stdout
      .trim()
      .split('\n')
      .filter(line => line.length > 0)

    return {
      success: true,
      files,
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
 * Search for files by name
 */
export async function spotlightSearchByName(
  name: string, 
  directory?: string
): Promise<SpotlightResult> {
  return spotlightSearch(`kMDItemDisplayName == "*${name}*"wc`, directory)
}

/**
 * Search for files by content
 */
export async function spotlightSearchByContent(
  content: string, 
  directory?: string
): Promise<SpotlightResult> {
  return spotlightSearch(`kMDItemTextContent == "*${content}*"cd`, directory)
}

/**
 * Search for files by kind (e.g., 'document', 'image', 'pdf')
 */
export async function spotlightSearchByKind(
  kind: string, 
  directory?: string
): Promise<SpotlightResult> {
  return spotlightSearch(`kind:${kind}`, directory)
}

/**
 * Search for recently modified files
 */
export async function spotlightSearchRecent(
  days: number = 7, 
  directory?: string
): Promise<SpotlightResult> {
  const date = new Date()
  date.setDate(date.getDate() - days)
  const dateStr = date.toISOString().split('T')[0]
  
  return spotlightSearch(`kMDItemContentModificationDate >= $time.iso(${dateStr})`, directory)
}

/**
 * Get file metadata using mdls
 */
export async function getFileMetadata(filePath: string): Promise<Record<string, string> | null> {
  if (process.platform !== 'darwin') {
    return null
  }

  try {
    const { stdout } = await execAsync(`mdls "${filePath.replace(/"/g, '\\"')}"`)
    
    const metadata: Record<string, string> = {}
    const lines = stdout.trim().split('\n')
    
    for (const line of lines) {
      const match = line.match(/^(\w+)\s*=\s*(.*)$/)
      if (match) {
        metadata[match[1]] = match[2].trim()
      }
    }
    
    return metadata
  } catch {
    return null
  }
}

/**
 * Register IPC handlers for Spotlight
 */
export function registerSpotlightHandlers(): void {
  ipcMain.handle('spotlight:search', async (_event, query: string, directory?: string) => {
    return spotlightSearch(query, directory)
  })

  ipcMain.handle('spotlight:searchByName', async (_event, name: string, directory?: string) => {
    return spotlightSearchByName(name, directory)
  })

  ipcMain.handle('spotlight:searchByContent', async (_event, content: string, directory?: string) => {
    return spotlightSearchByContent(content, directory)
  })

  ipcMain.handle('spotlight:searchByKind', async (_event, kind: string, directory?: string) => {
    return spotlightSearchByKind(kind, directory)
  })

  ipcMain.handle('spotlight:metadata', async (_event, filePath: string) => {
    return getFileMetadata(filePath)
  })
}
