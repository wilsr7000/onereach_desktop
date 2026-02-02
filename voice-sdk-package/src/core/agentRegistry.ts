/**
 * Agent Registry - CRUD management for agent resolvers
 * 
 * Agents are resolvers that subscribe to queues AND/OR actions.
 * When a task is ready for execution, the dispatcher finds matching agents.
 */

import type { Agent, AgentInput, Task } from './types'

export interface AgentRegistry {
  create: (input: AgentInput) => Agent
  read: (id: string) => Agent | undefined
  readByName: (name: string) => Agent | undefined
  update: (id: string, updates: Partial<AgentInput>) => Agent | undefined
  delete: (id: string) => boolean
  list: (enabledOnly?: boolean) => Agent[]
  enable: (id: string) => boolean
  disable: (id: string) => boolean
  clear: () => void
  
  // Selection helpers
  findForTask: (task: Task) => Agent[]
  findForQueue: (queueName: string) => Agent[]
  findForAction: (actionName: string) => Agent[]
}

export function createAgentRegistry(): AgentRegistry {
  const agents = new Map<string, Agent>()
  const nameToId = new Map<string, string>()

  function generateId(): string {
    return crypto.randomUUID()
  }

  function create(input: AgentInput): Agent {
    // Validate input
    if (!input.name || typeof input.name !== 'string') {
      throw new Error('Agent name is required and must be a string')
    }
    if (input.name.trim().length === 0) {
      throw new Error('Agent name cannot be empty')
    }
    if (typeof input.resolve !== 'function') {
      throw new Error('Agent resolve function is required')
    }

    // Validate subscriptions
    if (!input.queues?.length && !input.actions?.length) {
      throw new Error('Agent must subscribe to at least one queue or action')
    }

    // Check for duplicate name
    if (nameToId.has(input.name)) {
      throw new Error(`Agent with name "${input.name}" already exists`)
    }

    const now = Date.now()
    const agent: Agent = {
      id: generateId(),
      name: input.name.trim(),
      queues: input.queues ?? [],
      actions: input.actions ?? [],
      resolve: input.resolve,
      canHandle: input.canHandle,
      priority: input.priority ?? 0,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }

    agents.set(agent.id, agent)
    nameToId.set(agent.name, agent.id)

    return agent
  }

  function read(id: string): Agent | undefined {
    return agents.get(id)
  }

  function readByName(name: string): Agent | undefined {
    const id = nameToId.get(name)
    if (!id) return undefined
    return agents.get(id)
  }

  function update(id: string, updates: Partial<AgentInput>): Agent | undefined {
    const existing = agents.get(id)
    if (!existing) return undefined

    // Handle name change
    if (updates.name && updates.name !== existing.name) {
      if (nameToId.has(updates.name)) {
        throw new Error(`Agent with name "${updates.name}" already exists`)
      }
      nameToId.delete(existing.name)
      nameToId.set(updates.name, id)
    }

    // Validate subscriptions after update
    const newQueues = updates.queues ?? existing.queues
    const newActions = updates.actions ?? existing.actions
    if (!newQueues?.length && !newActions?.length) {
      throw new Error('Agent must subscribe to at least one queue or action')
    }

    const updated: Agent = {
      ...existing,
      ...updates,
      id: existing.id,
      enabled: existing.enabled,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    }

    agents.set(id, updated)
    return updated
  }

  function deleteAgent(id: string): boolean {
    const agent = agents.get(id)
    if (!agent) return false

    nameToId.delete(agent.name)
    return agents.delete(id)
  }

  function list(enabledOnly = false): Agent[] {
    const all = Array.from(agents.values())
    if (enabledOnly) {
      return all.filter(a => a.enabled)
    }
    return all
  }

  function enable(id: string): boolean {
    const agent = agents.get(id)
    if (!agent) return false

    agents.set(id, { ...agent, enabled: true, updatedAt: Date.now() })
    return true
  }

  function disable(id: string): boolean {
    const agent = agents.get(id)
    if (!agent) return false

    agents.set(id, { ...agent, enabled: false, updatedAt: Date.now() })
    return true
  }

  function clear(): void {
    agents.clear()
    nameToId.clear()
  }

  function findForTask(task: Task): Agent[] {
    const matching = Array.from(agents.values())
      .filter(agent => {
        if (!agent.enabled) return false

        // Check queue subscription
        const matchesQueue = agent.queues?.includes(task.queue)
        
        // Check action subscription
        const matchesAction = agent.actions?.includes(task.action)

        // Agent matches if it subscribes to the queue OR the action
        if (!matchesQueue && !matchesAction) return false

        // Check custom canHandle if provided
        if (agent.canHandle && !agent.canHandle(task)) return false

        return true
      })
      // Sort by priority (higher = first)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

    return matching
  }

  function findForQueue(queueName: string): Agent[] {
    return Array.from(agents.values())
      .filter(agent => agent.enabled && agent.queues?.includes(queueName))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  }

  function findForAction(actionName: string): Agent[] {
    return Array.from(agents.values())
      .filter(agent => agent.enabled && agent.actions?.includes(actionName))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  }

  return {
    create,
    read,
    readByName,
    update,
    delete: deleteAgent,
    list,
    enable,
    disable,
    clear,
    findForTask,
    findForQueue,
    findForAction,
  }
}
