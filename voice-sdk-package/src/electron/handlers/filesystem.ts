/**
 * Filesystem Handler
 * 
 * File read/write/search operations with proper error handling.
 */

import { ipcMain } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import type { FileSystemResult } from '../types'

/**
 * Read a file's contents
 */
export async function readFile(filePath: string): Promise<FileSystemResult> {
  try {
    const absolutePath = path.resolve(filePath)
    const content = await fs.readFile(absolutePath, 'utf-8')
    
    return {
      success: true,
      data: content,
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
 * Write content to a file
 */
export async function writeFile(filePath: string, content: string): Promise<FileSystemResult> {
  try {
    const absolutePath = path.resolve(filePath)
    
    // Ensure directory exists
    const dir = path.dirname(absolutePath)
    await fs.mkdir(dir, { recursive: true })
    
    await fs.writeFile(absolutePath, content, 'utf-8')
    
    return {
      success: true,
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
 * List directory contents
 */
export async function listDirectory(dirPath: string): Promise<FileSystemResult> {
  try {
    const absolutePath = path.resolve(dirPath)
    const entries = await fs.readdir(absolutePath, { withFileTypes: true })
    
    const files = entries.map(entry => ({
      name: entry.name,
      path: path.join(absolutePath, entry.name),
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }))
    
    return {
      success: true,
      data: files.map(f => `${f.isDirectory ? '[D]' : '[F]'} ${f.name}`),
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
 * Search for files matching a pattern
 */
export async function searchFiles(
  query: string, 
  directory?: string
): Promise<FileSystemResult> {
  try {
    const searchDir = directory ? path.resolve(directory) : process.cwd()
    const results: string[] = []
    
    async function search(dir: string, depth = 0): Promise<void> {
      if (depth > 5) return // Limit recursion depth
      
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        
        for (const entry of entries) {
          // Skip hidden files and node_modules
          if (entry.name.startsWith('.') || entry.name === 'node_modules') {
            continue
          }
          
          const fullPath = path.join(dir, entry.name)
          
          if (entry.name.toLowerCase().includes(query.toLowerCase())) {
            results.push(fullPath)
          }
          
          if (entry.isDirectory()) {
            await search(fullPath, depth + 1)
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }
    
    await search(searchDir)
    
    return {
      success: true,
      data: results.slice(0, 100), // Limit results
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
 * Check if a path exists
 */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(path.resolve(filePath))
    return true
  } catch {
    return false
  }
}

/**
 * Get file stats
 */
export async function getFileStats(filePath: string): Promise<{
  size: number
  created: Date
  modified: Date
  isDirectory: boolean
} | null> {
  try {
    const stats = await fs.stat(path.resolve(filePath))
    return {
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      isDirectory: stats.isDirectory(),
    }
  } catch {
    return null
  }
}

/**
 * Register IPC handlers for filesystem
 */
export function registerFilesystemHandlers(): void {
  ipcMain.handle('fs:read', async (_event, filePath: string) => {
    return readFile(filePath)
  })

  ipcMain.handle('fs:write', async (_event, filePath: string, content: string) => {
    return writeFile(filePath, content)
  })

  ipcMain.handle('fs:list', async (_event, dirPath: string) => {
    return listDirectory(dirPath)
  })

  ipcMain.handle('fs:search', async (_event, query: string, directory?: string) => {
    return searchFiles(query, directory)
  })

  ipcMain.handle('fs:exists', async (_event, filePath: string) => {
    return pathExists(filePath)
  })

  ipcMain.handle('fs:stats', async (_event, filePath: string) => {
    return getFileStats(filePath)
  })
}
