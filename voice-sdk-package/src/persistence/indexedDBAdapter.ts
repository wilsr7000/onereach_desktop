/**
 * IndexedDB Persistence Adapter
 * 
 * Asynchronous persistence using IndexedDB for larger datasets.
 * Supports transactions and better performance for complex data.
 */

import type { PersistenceAdapter, Action, Agent, Queue, Task, UndoEntry } from '../core/types'

export interface IndexedDBAdapterConfig {
  /** Database name */
  dbName?: string
  /** Database version */
  version?: number
}

const DEFAULT_DB_NAME = 'voice-orb-sdk'
const DEFAULT_VERSION = 1

const STORES = {
  ACTIONS: 'actions',
  AGENTS: 'agents',
  QUEUES: 'queues',
  PENDING_TASKS: 'pending-tasks',
  UNDO_HISTORY: 'undo-history',
} as const

export function createIndexedDBAdapter(config: IndexedDBAdapterConfig = {}): PersistenceAdapter {
  const { dbName = DEFAULT_DB_NAME, version = DEFAULT_VERSION } = config

  let db: IDBDatabase | null = null
  let dbPromise: Promise<IDBDatabase> | null = null

  function openDB(): Promise<IDBDatabase> {
    if (db) return Promise.resolve(db)
    if (dbPromise) return dbPromise

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, version)

      request.onerror = () => {
        reject(new Error(`Failed to open IndexedDB: ${request.error?.message}`))
      }

      request.onsuccess = () => {
        db = request.result
        resolve(db)
      }

      request.onupgradeneeded = (event) => {
        const database = (event.target as IDBOpenDBRequest).result

        // Create object stores
        if (!database.objectStoreNames.contains(STORES.ACTIONS)) {
          database.createObjectStore(STORES.ACTIONS, { keyPath: 'id' })
        }
        if (!database.objectStoreNames.contains(STORES.AGENTS)) {
          database.createObjectStore(STORES.AGENTS, { keyPath: 'id' })
        }
        if (!database.objectStoreNames.contains(STORES.QUEUES)) {
          database.createObjectStore(STORES.QUEUES, { keyPath: 'id' })
        }
        if (!database.objectStoreNames.contains(STORES.PENDING_TASKS)) {
          database.createObjectStore(STORES.PENDING_TASKS, { keyPath: 'id' })
        }
        if (!database.objectStoreNames.contains(STORES.UNDO_HISTORY)) {
          database.createObjectStore(STORES.UNDO_HISTORY, { keyPath: 'id' })
        }
      }
    })

    return dbPromise
  }

  async function clearStore(storeName: string): Promise<void> {
    const database = await openDB()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const request = store.clear()

      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  async function putAll<T extends { id: string }>(storeName: string, items: T[]): Promise<void> {
    const database = await openDB()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)

      // Clear existing data first
      store.clear()

      // Add all items
      items.forEach(item => store.put(item))

      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  }

  async function getAll<T>(storeName: string): Promise<T[]> {
    const database = await openDB()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly')
      const store = transaction.objectStore(storeName)
      const request = store.getAll()

      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error)
    })
  }

  async function saveActions(actions: Action[]): Promise<void> {
    try {
      await putAll(STORES.ACTIONS, actions)
    } catch (error) {
      console.error('[indexedDB] Failed to save actions:', error)
      throw error
    }
  }

  async function loadActions(): Promise<Action[]> {
    try {
      return await getAll<Action>(STORES.ACTIONS)
    } catch (error) {
      console.error('[indexedDB] Failed to load actions:', error)
      return []
    }
  }

  async function saveAgents(agents: Agent[]): Promise<void> {
    try {
      // Remove functions that can't be serialized
      const serializableAgents = agents.map(agent => ({
        ...agent,
        resolve: undefined,
        canHandle: undefined,
      }))
      await putAll(STORES.AGENTS, serializableAgents as unknown as Agent[])
    } catch (error) {
      console.error('[indexedDB] Failed to save agents:', error)
      throw error
    }
  }

  async function loadAgents(): Promise<Agent[]> {
    try {
      const agents = await getAll<Partial<Agent>>(STORES.AGENTS)
      // Agents need their resolve functions re-attached by the application
      return agents.map(agent => ({
        ...agent,
        resolve: async () => ({ success: false, error: 'Agent not initialized' }),
      })) as Agent[]
    } catch (error) {
      console.error('[indexedDB] Failed to load agents:', error)
      return []
    }
  }

  async function saveQueues(queues: Queue[]): Promise<void> {
    try {
      await putAll(STORES.QUEUES, queues)
    } catch (error) {
      console.error('[indexedDB] Failed to save queues:', error)
      throw error
    }
  }

  async function loadQueues(): Promise<Queue[]> {
    try {
      return await getAll<Queue>(STORES.QUEUES)
    } catch (error) {
      console.error('[indexedDB] Failed to load queues:', error)
      return []
    }
  }

  async function savePendingTasks(tasks: Task[]): Promise<void> {
    try {
      await putAll(STORES.PENDING_TASKS, tasks)
    } catch (error) {
      console.error('[indexedDB] Failed to save pending tasks:', error)
      throw error
    }
  }

  async function loadPendingTasks(): Promise<Task[]> {
    try {
      return await getAll<Task>(STORES.PENDING_TASKS)
    } catch (error) {
      console.error('[indexedDB] Failed to load pending tasks:', error)
      return []
    }
  }

  async function saveUndoHistory(history: UndoEntry[]): Promise<void> {
    try {
      // Remove functions that can't be serialized
      const serializableHistory = history.map(entry => ({
        ...entry,
        undo: undefined,
      }))
      await putAll(STORES.UNDO_HISTORY, serializableHistory as unknown as UndoEntry[])
    } catch (error) {
      console.error('[indexedDB] Failed to save undo history:', error)
      throw error
    }
  }

  async function loadUndoHistory(): Promise<UndoEntry[]> {
    try {
      const history = await getAll<Partial<UndoEntry>>(STORES.UNDO_HISTORY)
      // Undo functions need to be re-attached by the application
      return history.map(entry => ({
        ...entry,
        undo: async () => { throw new Error('Undo function not restored') },
      })) as UndoEntry[]
    } catch (error) {
      console.error('[indexedDB] Failed to load undo history:', error)
      return []
    }
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
 * Delete the entire database
 */
export function deleteDatabase(dbName = DEFAULT_DB_NAME): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}
