/**
 * Queue Manager - Named execution queues with concurrency control
 * 
 * Queues hold pending tasks and control how many can execute in parallel.
 * Supports overflow handling (drop, error, deadletter) when queue is full.
 */

import type { Queue, QueueInput, QueueStats, Task } from './types'

export interface QueueManager {
  create: (input: QueueInput) => Queue
  read: (name: string) => Queue | undefined
  delete: (name: string) => boolean
  list: () => Queue[]
  pause: (name: string) => boolean
  resume: (name: string) => boolean
  clear: (name: string) => boolean
  getStats: (name: string) => QueueStats | undefined
  
  // Task operations (internal use)
  enqueue: (queueName: string, task: Task) => { success: boolean; reason?: string }
  dequeue: (queueName: string) => Task | undefined
  peek: (queueName: string) => Task | undefined
  getTasks: (queueName: string) => Task[]
  incrementRunning: (queueName: string) => void
  decrementRunning: (queueName: string) => void
  getRunningCount: (queueName: string) => number
  canAcceptTask: (queueName: string) => boolean
}

interface QueueState {
  queue: Queue
  tasks: Task[]
  completedCount: number
  failedCount: number
}

export function createQueueManager(): QueueManager {
  const queues = new Map<string, QueueState>()
  const nameToId = new Map<string, string>()

  function generateId(): string {
    return crypto.randomUUID()
  }

  function create(input: QueueInput): Queue {
    // Validate input
    if (!input.name || typeof input.name !== 'string') {
      throw new Error('Queue name is required and must be a string')
    }
    if (input.name.trim().length === 0) {
      throw new Error('Queue name cannot be empty')
    }
    if (typeof input.concurrency !== 'number' || input.concurrency < 1) {
      throw new Error('Queue concurrency must be a positive integer')
    }
    if (input.maxSize !== undefined && (typeof input.maxSize !== 'number' || input.maxSize < 1)) {
      throw new Error('Queue maxSize must be a positive integer')
    }
    if (input.overflow !== undefined && !['drop', 'error', 'deadletter'].includes(input.overflow)) {
      throw new Error('Queue overflow must be "drop", "error", or "deadletter"')
    }

    if (nameToId.has(input.name)) {
      throw new Error(`Queue with name "${input.name}" already exists`)
    }

    const queue: Queue = {
      id: generateId(),
      name: input.name.trim(),
      concurrency: Math.floor(input.concurrency),
      maxSize: input.maxSize ? Math.floor(input.maxSize) : undefined,
      overflow: input.overflow ?? 'error',
      paused: false,
      runningCount: 0,
      createdAt: Date.now(),
    }

    queues.set(queue.id, {
      queue,
      tasks: [],
      completedCount: 0,
      failedCount: 0,
    })
    nameToId.set(input.name, queue.id)

    return queue
  }

  function read(name: string): Queue | undefined {
    const id = nameToId.get(name)
    if (!id) return undefined
    return queues.get(id)?.queue
  }

  function deleteQueue(name: string): boolean {
    const id = nameToId.get(name)
    if (!id) return false

    const state = queues.get(id)
    if (state && state.queue.runningCount > 0) {
      throw new Error(`Cannot delete queue "${name}" with running tasks`)
    }

    nameToId.delete(name)
    return queues.delete(id)
  }

  function list(): Queue[] {
    return Array.from(queues.values()).map(s => s.queue)
  }

  function pause(name: string): boolean {
    const id = nameToId.get(name)
    if (!id) return false

    const state = queues.get(id)
    if (!state) return false

    state.queue = { ...state.queue, paused: true }
    return true
  }

  function resume(name: string): boolean {
    const id = nameToId.get(name)
    if (!id) return false

    const state = queues.get(id)
    if (!state) return false

    state.queue = { ...state.queue, paused: false }
    return true
  }

  function clear(name: string): boolean {
    const id = nameToId.get(name)
    if (!id) return false

    const state = queues.get(id)
    if (!state) return false

    state.tasks = []
    return true
  }

  function getStats(name: string): QueueStats | undefined {
    const id = nameToId.get(name)
    if (!id) return undefined

    const state = queues.get(id)
    if (!state) return undefined

    return {
      pending: state.tasks.length,
      running: state.queue.runningCount,
      completed: state.completedCount,
      failed: state.failedCount,
    }
  }

  function enqueue(queueName: string, task: Task): { success: boolean; reason?: string } {
    const id = nameToId.get(queueName)
    if (!id) {
      return { success: false, reason: `Queue "${queueName}" does not exist` }
    }

    const state = queues.get(id)
    if (!state) {
      return { success: false, reason: `Queue "${queueName}" not found` }
    }

    // Check if queue is at max capacity
    if (state.queue.maxSize !== undefined && state.tasks.length >= state.queue.maxSize) {
      switch (state.queue.overflow) {
        case 'drop':
          return { success: false, reason: 'dropped' }
        case 'deadletter':
          return { success: false, reason: 'deadletter' }
        case 'error':
        default:
          return { success: false, reason: `Queue "${queueName}" is full` }
      }
    }

    // Insert by priority (higher priority = earlier in queue)
    const insertIndex = state.tasks.findIndex(t => t.priority < task.priority)
    if (insertIndex === -1) {
      state.tasks.push(task)
    } else {
      state.tasks.splice(insertIndex, 0, task)
    }

    return { success: true }
  }

  function dequeue(queueName: string): Task | undefined {
    const id = nameToId.get(queueName)
    if (!id) return undefined

    const state = queues.get(id)
    if (!state) return undefined

    // Don't dequeue if paused
    if (state.queue.paused) return undefined

    // Don't dequeue if at concurrency limit
    if (state.queue.runningCount >= state.queue.concurrency) return undefined

    return state.tasks.shift()
  }

  function peek(queueName: string): Task | undefined {
    const id = nameToId.get(queueName)
    if (!id) return undefined

    const state = queues.get(id)
    if (!state) return undefined

    return state.tasks[0]
  }

  function getTasks(queueName: string): Task[] {
    const id = nameToId.get(queueName)
    if (!id) return []

    const state = queues.get(id)
    if (!state) return []

    // Return a copy to prevent external mutation
    return [...state.tasks]
  }

  function incrementRunning(queueName: string): void {
    const id = nameToId.get(queueName)
    if (!id) return

    const state = queues.get(id)
    if (!state) return

    state.queue = { ...state.queue, runningCount: state.queue.runningCount + 1 }
  }

  function decrementRunning(queueName: string): void {
    const id = nameToId.get(queueName)
    if (!id) return

    const state = queues.get(id)
    if (!state) return

    state.queue = { ...state.queue, runningCount: Math.max(0, state.queue.runningCount - 1) }
  }

  function getRunningCount(queueName: string): number {
    const id = nameToId.get(queueName)
    if (!id) return 0

    const state = queues.get(id)
    return state?.queue.runningCount ?? 0
  }

  function canAcceptTask(queueName: string): boolean {
    const id = nameToId.get(queueName)
    if (!id) return false

    const state = queues.get(id)
    if (!state) return false

    if (state.queue.paused) return false
    if (state.queue.maxSize !== undefined && state.tasks.length >= state.queue.maxSize) {
      return false
    }

    return true
  }

  return {
    create,
    read,
    delete: deleteQueue,
    list,
    pause,
    resume,
    clear,
    getStats,
    enqueue,
    dequeue,
    peek,
    getTasks,
    incrementRunning,
    decrementRunning,
    getRunningCount,
    canAcceptTask,
  }
}
