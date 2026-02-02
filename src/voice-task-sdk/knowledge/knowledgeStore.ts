/**
 * Knowledge Store - CRUD for knowledge sources
 * 
 * Manages the registry of knowledge sources (vector DBs, APIs, documents, etc.)
 */

import { createStore } from 'zustand/vanilla'
import type { 
  KnowledgeSource, 
  KnowledgeSourceInput, 
  KnowledgeSourceType,
  KnowledgeStoreState 
} from './types'

function generateId(): string {
  return crypto.randomUUID()
}

export function createKnowledgeStore() {
  return createStore<KnowledgeStoreState>((set, get) => ({
    sources: new Map(),

    addSource: (input: KnowledgeSourceInput): KnowledgeSource => {
      const source: KnowledgeSource = {
        id: generateId(),
        name: input.name,
        type: input.type,
        description: input.description,
        enabled: true,
        config: input.config,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      set(state => {
        const sources = new Map(state.sources)
        sources.set(source.id, source)
        return { sources }
      })

      return source
    },

    getSource: (id: string): KnowledgeSource | undefined => {
      return get().sources.get(id)
    },

    updateSource: (id: string, updates: Partial<KnowledgeSourceInput>): KnowledgeSource | undefined => {
      const existing = get().sources.get(id)
      if (!existing) return undefined

      const updated: KnowledgeSource = {
        ...existing,
        ...updates,
        updatedAt: Date.now(),
      }

      set(state => {
        const sources = new Map(state.sources)
        sources.set(id, updated)
        return { sources }
      })

      return updated
    },

    deleteSource: (id: string): boolean => {
      const exists = get().sources.has(id)
      if (!exists) return false

      set(state => {
        const sources = new Map(state.sources)
        sources.delete(id)
        return { sources }
      })

      return true
    },

    listSources: (type?: KnowledgeSourceType): KnowledgeSource[] => {
      const sources = Array.from(get().sources.values())
      
      if (type) {
        return sources.filter(s => s.type === type)
      }
      
      return sources
    },

    enableSource: (id: string): void => {
      const existing = get().sources.get(id)
      if (!existing) return

      set(state => {
        const sources = new Map(state.sources)
        sources.set(id, { ...existing, enabled: true, updatedAt: Date.now() })
        return { sources }
      })
    },

    disableSource: (id: string): void => {
      const existing = get().sources.get(id)
      if (!existing) return

      set(state => {
        const sources = new Map(state.sources)
        sources.set(id, { ...existing, enabled: false, updatedAt: Date.now() })
        return { sources }
      })
    },
  }))
}

export type KnowledgeStore = ReturnType<typeof createKnowledgeStore>
