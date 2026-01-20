/**
 * Undo Manager - Manages undo stack for reversible actions
 * 
 * When agents complete tasks, they can optionally provide an undo function.
 * This manager tracks those and allows users to undo recent actions.
 */

import type { UndoEntry, Task, TaskResult } from './types'

export interface UndoManager {
  // Register undo
  register: (task: Task, result: TaskResult) => UndoEntry | null
  
  // Execute undo
  canUndo: () => boolean
  undo: () => Promise<UndoEntry | null>
  undoById: (id: string) => Promise<UndoEntry | null>
  
  // Query
  getHistory: (limit?: number) => UndoEntry[]
  getEntry: (id: string) => UndoEntry | undefined
  
  // Management
  clear: () => void
  remove: (id: string) => boolean
  
  // Events
  onUndo: (handler: (entry: UndoEntry) => void) => () => void
}

export interface UndoManagerConfig {
  maxHistorySize?: number
  autoExpireMs?: number // Auto-remove entries older than this
}

export function createUndoManager(config: UndoManagerConfig = {}): UndoManager {
  const { maxHistorySize = 100, autoExpireMs } = config

  const entries: UndoEntry[] = []
  const undoHandlers = new Set<(entry: UndoEntry) => void>()

  function generateId(): string {
    return crypto.randomUUID()
  }

  function cleanExpired(): void {
    if (!autoExpireMs) return

    const cutoff = Date.now() - autoExpireMs
    while (entries.length > 0 && entries[entries.length - 1].timestamp < cutoff) {
      entries.pop()
    }
  }

  function register(task: Task, result: TaskResult): UndoEntry | null {
    // Only register if result has an undo function
    if (!result.undo) {
      return null
    }

    cleanExpired()

    const entry: UndoEntry = {
      id: generateId(),
      taskId: task.id,
      action: task.action,
      description: `Undo: ${task.action} - ${task.content.slice(0, 50)}`,
      undo: result.undo,
      timestamp: Date.now(),
    }

    // Add to front (most recent first)
    entries.unshift(entry)

    // Trim if over max size
    while (entries.length > maxHistorySize) {
      entries.pop()
    }

    return entry
  }

  function canUndo(): boolean {
    cleanExpired()
    return entries.length > 0
  }

  async function undo(): Promise<UndoEntry | null> {
    cleanExpired()

    if (entries.length === 0) {
      return null
    }

    const entry = entries.shift()!
    
    try {
      await entry.undo()
      
      // Notify handlers
      for (const handler of undoHandlers) {
        try {
          handler(entry)
        } catch (error) {
          console.error('[undoManager] Handler error:', error)
        }
      }
      
      return entry
    } catch (error) {
      // Put it back on failure? Or discard? Let's discard to avoid infinite retry loops
      console.error('[undoManager] Undo failed:', error)
      throw error
    }
  }

  async function undoById(id: string): Promise<UndoEntry | null> {
    cleanExpired()

    const index = entries.findIndex(e => e.id === id)
    if (index === -1) {
      return null
    }

    const entry = entries[index]
    entries.splice(index, 1)

    try {
      await entry.undo()
      
      // Notify handlers
      for (const handler of undoHandlers) {
        try {
          handler(entry)
        } catch (error) {
          console.error('[undoManager] Handler error:', error)
        }
      }
      
      return entry
    } catch (error) {
      console.error('[undoManager] Undo failed:', error)
      throw error
    }
  }

  function getHistory(limit?: number): UndoEntry[] {
    cleanExpired()
    
    const result = limit ? entries.slice(0, limit) : [...entries]
    
    // Return copies without the actual undo functions (for serialization safety)
    return result.map(entry => ({
      ...entry,
      undo: entry.undo, // Keep reference for internal use
    }))
  }

  function getEntry(id: string): UndoEntry | undefined {
    cleanExpired()
    return entries.find(e => e.id === id)
  }

  function clear(): void {
    entries.length = 0
  }

  function remove(id: string): boolean {
    const index = entries.findIndex(e => e.id === id)
    if (index === -1) {
      return false
    }
    entries.splice(index, 1)
    return true
  }

  function onUndo(handler: (entry: UndoEntry) => void): () => void {
    undoHandlers.add(handler)
    return () => undoHandlers.delete(handler)
  }

  return {
    register,
    canUndo,
    undo,
    undoById,
    getHistory,
    getEntry,
    clear,
    remove,
    onUndo,
  }
}
