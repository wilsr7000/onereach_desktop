/**
 * LocalStorage Persistence Adapter
 * 
 * Simple synchronous persistence using localStorage.
 * Best for small amounts of data that need quick access.
 */

import type { PersistenceAdapter, Action, Agent, Queue, Task, UndoEntry } from '../core/types'

export interface LocalStorageAdapterConfig {
  /** Prefix for all localStorage keys */
  prefix?: string
  /** Enable compression (uses JSON minification) */
  compress?: boolean
}

const DEFAULT_PREFIX = 'voice-orb-sdk'

export function createLocalStorageAdapter(config: LocalStorageAdapterConfig = {}): PersistenceAdapter {
  const { prefix = DEFAULT_PREFIX, compress = false } = config

  function getKey(name: string): string {
    return `${prefix}:${name}`
  }

  function serialize<T>(data: T): string {
    const json = JSON.stringify(data)
    if (compress) {
      // Simple minification - remove whitespace
      return json.replace(/\s+/g, '')
    }
    return json
  }

  function deserialize<T>(data: string | null): T | null {
    if (!data) return null
    try {
      return JSON.parse(data) as T
    } catch {
      console.error('[localStorage] Failed to parse data')
      return null
    }
  }

  async function saveActions(actions: Action[]): Promise<void> {
    try {
      localStorage.setItem(getKey('actions'), serialize(actions))
    } catch (error) {
      console.error('[localStorage] Failed to save actions:', error)
      throw error
    }
  }

  async function loadActions(): Promise<Action[]> {
    const data = localStorage.getItem(getKey('actions'))
    return deserialize<Action[]>(data) || []
  }

  async function saveAgents(agents: Agent[]): Promise<void> {
    try {
      // Remove resolve function (can't serialize)
      const serializableAgents = agents.map(agent => ({
        ...agent,
        resolve: undefined,
        canHandle: undefined,
      }))
      localStorage.setItem(getKey('agents'), serialize(serializableAgents))
    } catch (error) {
      console.error('[localStorage] Failed to save agents:', error)
      throw error
    }
  }

  async function loadAgents(): Promise<Agent[]> {
    const data = localStorage.getItem(getKey('agents'))
    const agents = deserialize<Partial<Agent>[]>(data) || []
    // Agents need their resolve functions re-attached by the application
    return agents.map(agent => ({
      ...agent,
      resolve: async () => ({ success: false, error: 'Agent not initialized' }),
    })) as Agent[]
  }

  async function saveQueues(queues: Queue[]): Promise<void> {
    try {
      localStorage.setItem(getKey('queues'), serialize(queues))
    } catch (error) {
      console.error('[localStorage] Failed to save queues:', error)
      throw error
    }
  }

  async function loadQueues(): Promise<Queue[]> {
    const data = localStorage.getItem(getKey('queues'))
    return deserialize<Queue[]>(data) || []
  }

  async function savePendingTasks(tasks: Task[]): Promise<void> {
    try {
      localStorage.setItem(getKey('pending-tasks'), serialize(tasks))
    } catch (error) {
      console.error('[localStorage] Failed to save pending tasks:', error)
      throw error
    }
  }

  async function loadPendingTasks(): Promise<Task[]> {
    const data = localStorage.getItem(getKey('pending-tasks'))
    return deserialize<Task[]>(data) || []
  }

  async function saveUndoHistory(history: UndoEntry[]): Promise<void> {
    try {
      // Remove undo function (can't serialize)
      const serializableHistory = history.map(entry => ({
        ...entry,
        undo: undefined,
      }))
      localStorage.setItem(getKey('undo-history'), serialize(serializableHistory))
    } catch (error) {
      console.error('[localStorage] Failed to save undo history:', error)
      throw error
    }
  }

  async function loadUndoHistory(): Promise<UndoEntry[]> {
    const data = localStorage.getItem(getKey('undo-history'))
    const history = deserialize<Partial<UndoEntry>[]>(data) || []
    // Undo functions need to be re-attached by the application
    return history.map(entry => ({
      ...entry,
      undo: async () => { throw new Error('Undo function not restored') },
    })) as UndoEntry[]
  }

  return {
    saveActions,
    loadActions,
    saveAgents,
    loadAgents,
    saveQueues,
    loadQueues,
    savePendingTasks,
    loadPendingTasks,
    saveUndoHistory,
    loadUndoHistory,
  }
}

/**
 * Clear all persisted data
 */
export function clearLocalStorage(prefix = DEFAULT_PREFIX): void {
  const keys = [
    'actions',
    'agents',
    'queues',
    'pending-tasks',
    'undo-history',
  ]

  keys.forEach(key => {
    localStorage.removeItem(`${prefix}:${key}`)
  })
}
