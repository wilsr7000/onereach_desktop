/**
 * Action Store - CRUD management for classifiable actions
 * 
 * Actions are intents that can be classified from voice input.
 * Each action has a name, description (used in AI prompt), parameters, and execution config.
 */

import type { Action, ActionInput } from './types'

export interface ActionStore {
  create: (input: ActionInput) => Action
  read: (name: string) => Action | undefined
  update: (name: string, updates: Partial<ActionInput>) => Action | undefined
  delete: (name: string) => boolean
  list: (enabledOnly?: boolean) => Action[]
  enable: (name: string) => boolean
  disable: (name: string) => boolean
  clear: () => void
  getById: (id: string) => Action | undefined
}

export function createActionStore(): ActionStore {
  const actions = new Map<string, Action>()
  const nameToId = new Map<string, string>()

  function generateId(): string {
    return crypto.randomUUID()
  }

  function create(input: ActionInput): Action {
    // Validate input
    if (!input.name || typeof input.name !== 'string') {
      throw new Error('Action name is required and must be a string')
    }
    if (input.name.trim().length === 0) {
      throw new Error('Action name cannot be empty')
    }
    if (!input.description || typeof input.description !== 'string') {
      throw new Error('Action description is required and must be a string')
    }

    // Check for duplicate name
    if (nameToId.has(input.name)) {
      throw new Error(`Action with name "${input.name}" already exists`)
    }

    // Validate timeout and retries if provided
    if (input.timeout !== undefined && (typeof input.timeout !== 'number' || input.timeout <= 0)) {
      throw new Error('Action timeout must be a positive number')
    }
    if (input.retries !== undefined && (typeof input.retries !== 'number' || input.retries < 0)) {
      throw new Error('Action retries must be a non-negative number')
    }

    const now = Date.now()
    const action: Action = {
      id: generateId(),
      name: input.name.trim(),
      description: input.description,
      params: input.params ?? [],
      defaultQueue: input.defaultQueue,
      defaultPriority: input.defaultPriority ?? 2,
      examples: input.examples ?? [],
      timeout: input.timeout ?? 30000,
      retries: input.retries ?? 0,
      retryDelay: input.retryDelay ?? 1000,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }

    actions.set(action.id, action)
    nameToId.set(action.name, action.id)

    return action
  }

  function read(name: string): Action | undefined {
    const id = nameToId.get(name)
    if (!id) return undefined
    return actions.get(id)
  }

  function getById(id: string): Action | undefined {
    return actions.get(id)
  }

  function update(name: string, updates: Partial<ActionInput>): Action | undefined {
    const id = nameToId.get(name)
    if (!id) return undefined

    const existing = actions.get(id)
    if (!existing) return undefined

    // Handle name change
    if (updates.name && updates.name !== name) {
      if (nameToId.has(updates.name)) {
        throw new Error(`Action with name "${updates.name}" already exists`)
      }
      nameToId.delete(name)
      nameToId.set(updates.name, id)
    }

    const updated: Action = {
      ...existing,
      ...updates,
      id: existing.id,
      enabled: existing.enabled,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    }

    actions.set(id, updated)
    return updated
  }

  function deleteAction(name: string): boolean {
    const id = nameToId.get(name)
    if (!id) return false

    nameToId.delete(name)
    return actions.delete(id)
  }

  function list(enabledOnly = false): Action[] {
    const all = Array.from(actions.values())
    if (enabledOnly) {
      return all.filter(a => a.enabled)
    }
    return all
  }

  function enable(name: string): boolean {
    const id = nameToId.get(name)
    if (!id) return false

    const action = actions.get(id)
    if (!action) return false

    actions.set(id, { ...action, enabled: true, updatedAt: Date.now() })
    return true
  }

  function disable(name: string): boolean {
    const id = nameToId.get(name)
    if (!id) return false

    const action = actions.get(id)
    if (!action) return false

    actions.set(id, { ...action, enabled: false, updatedAt: Date.now() })
    return true
  }

  function clear(): void {
    actions.clear()
    nameToId.clear()
  }

  return {
    create,
    read,
    update,
    delete: deleteAction,
    list,
    enable,
    disable,
    clear,
    getById,
  }
}
