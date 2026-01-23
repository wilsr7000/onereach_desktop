/**
 * Persistence Adapters for Voice Orb Task SDK
 */

export { 
  createLocalStorageAdapter, 
  clearLocalStorage,
  type LocalStorageAdapterConfig,
} from './localStorageAdapter'

export { 
  createIndexedDBAdapter, 
  deleteDatabase,
  type IndexedDBAdapterConfig,
} from './indexedDBAdapter'

// Re-export type for convenience
export type { PersistenceAdapter } from '../core/types'
