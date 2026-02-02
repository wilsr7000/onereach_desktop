/**
 * Task Store - State management for tasks
 * 
 * Tracks all tasks through their lifecycle: pending -> running -> completed/failed/cancelled.
 * Maintains history for undo operations and retry tracking.
 */

import type { Task, TaskResult, TaskStatus, ClassifiedTask, TaskPriority } from './types'

export interface TaskStore {
  create: (classified: ClassifiedTask, queue: string) => Task
  read: (id: string) => Task | undefined
  update: (id: string, updates: Partial<Task>) => Task | undefined
  delete: (id: string) => boolean
  list: (filter?: TaskFilter) => Task[]
  
  // Status transitions
  start: (id: string, agentId: string) => Task | undefined
  complete: (id: string, result: TaskResult) => Task | undefined
  fail: (id: string, error: string) => Task | undefined
  cancel: (id: string) => Task | undefined
  markDeadletter: (id: string, reason: string) => Task | undefined
  
  // Retry support
  prepareRetry: (id: string) => Task | undefined
  
  // Undo support
  getUndoable: () => Task[]
  
  // Cleanup
  clear: () => void
  clearCompleted: () => number
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[]
  queue?: string
  action?: string
  assignedAgent?: string
  since?: number
  limit?: number
}

export function createTaskStore(): TaskStore {
  const tasks = new Map<string, Task>()

  function generateId(): string {
    return crypto.randomUUID()
  }

  function create(classified: ClassifiedTask, queue: string): Task {
    const task: Task = {
      id: generateId(),
      action: classified.action,
      content: classified.content,
      params: classified.params,
      priority: classified.priority,
      status: 'pending',
      queue,
      createdAt: Date.now(),
      attempt: 0,
      maxAttempts: 1, // Will be set by dispatcher based on action config
    }

    tasks.set(task.id, task)
    return task
  }

  function read(id: string): Task | undefined {
    return tasks.get(id)
  }

  function update(id: string, updates: Partial<Task>): Task | undefined {
    const existing = tasks.get(id)
    if (!existing) return undefined

    const updated: Task = {
      ...existing,
      ...updates,
      id: existing.id, // Prevent ID change
    }

    tasks.set(id, updated)
    return updated
  }

  function deleteTask(id: string): boolean {
    return tasks.delete(id)
  }

  function list(filter?: TaskFilter): Task[] {
    let result = Array.from(tasks.values())

    if (filter) {
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
        result = result.filter(t => statuses.includes(t.status))
      }

      if (filter.queue) {
        result = result.filter(t => t.queue === filter.queue)
      }

      if (filter.action) {
        result = result.filter(t => t.action === filter.action)
      }

      if (filter.assignedAgent) {
        result = result.filter(t => t.assignedAgent === filter.assignedAgent)
      }

      if (filter.since) {
        result = result.filter(t => t.createdAt >= filter.since!)
      }

      if (filter.limit) {
        result = result.slice(0, filter.limit)
      }
    }

    // Always sort by priority (higher first), then by createdAt (older first)
    result.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority
      }
      return a.createdAt - b.createdAt
    })

    return result
  }

  function start(id: string, agentId: string): Task | undefined {
    const task = tasks.get(id)
    if (!task) return undefined
    if (task.status !== 'pending') return undefined

    const updated: Task = {
      ...task,
      status: 'running',
      assignedAgent: agentId,
      startedAt: Date.now(),
      attempt: task.attempt + 1,
    }

    tasks.set(id, updated)
    return updated
  }

  function complete(id: string, result: TaskResult): Task | undefined {
    const task = tasks.get(id)
    if (!task) return undefined
    if (task.status !== 'running') return undefined

    const updated: Task = {
      ...task,
      status: 'completed',
      completedAt: Date.now(),
      result,
    }

    tasks.set(id, updated)
    return updated
  }

  function fail(id: string, error: string): Task | undefined {
    const task = tasks.get(id)
    if (!task) return undefined
    if (task.status !== 'running') return undefined

    const updated: Task = {
      ...task,
      status: 'failed',
      completedAt: Date.now(),
      lastError: error,
      error,
    }

    tasks.set(id, updated)
    return updated
  }

  function cancel(id: string): Task | undefined {
    const task = tasks.get(id)
    if (!task) return undefined
    
    // Can cancel pending or running tasks
    if (task.status !== 'pending' && task.status !== 'running') {
      return undefined
    }

    const updated: Task = {
      ...task,
      status: 'cancelled',
      completedAt: Date.now(),
    }

    tasks.set(id, updated)
    return updated
  }

  function markDeadletter(id: string, reason: string): Task | undefined {
    const task = tasks.get(id)
    if (!task) return undefined

    const updated: Task = {
      ...task,
      status: 'deadletter',
      completedAt: Date.now(),
      lastError: reason,
    }

    tasks.set(id, updated)
    return updated
  }

  function prepareRetry(id: string): Task | undefined {
    const task = tasks.get(id)
    if (!task) return undefined
    if (task.status !== 'failed') return undefined
    if (task.attempt >= task.maxAttempts) return undefined

    const updated: Task = {
      ...task,
      status: 'pending',
      assignedAgent: undefined,
      startedAt: undefined,
      completedAt: undefined,
      error: undefined,
      result: undefined,
    }

    tasks.set(id, updated)
    return updated
  }

  function getUndoable(): Task[] {
    return Array.from(tasks.values())
      .filter(t => t.status === 'completed' && t.result?.undo)
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
  }

  function clear(): void {
    tasks.clear()
  }

  function clearCompleted(): number {
    let count = 0
    for (const [id, task] of tasks) {
      if (task.status === 'completed' || task.status === 'cancelled') {
        tasks.delete(id)
        count++
      }
    }
    return count
  }

  return {
    create,
    read,
    update,
    delete: deleteTask,
    list,
    start,
    complete,
    fail,
    cancel,
    markDeadletter,
    prepareRetry,
    getUndoable,
    clear,
    clearCompleted,
  }
}
