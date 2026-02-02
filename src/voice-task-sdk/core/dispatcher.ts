/**
 * Dispatcher - Queue processing, agent selection, and task execution
 * 
 * The dispatcher:
 * - Polls queues for pending tasks
 * - Selects appropriate agents based on subscriptions
 * - Executes tasks with timeout and cancellation support
 * - Handles retries and dead-letter routing
 */

import type {
  Task,
  TaskResult,
  AppContext,
  ExecutionContext,
  ClassifiedTask,
} from './types'
import type { QueueManager } from './queueManager'
import type { AgentRegistry } from './agentRegistry'
import type { TaskStore } from './taskStore'
import type { Router } from './router'
import type { HookManager } from './hooks'
import type { ActionStore } from './actionStore'

export interface DispatcherConfig {
  pollIntervalMs?: number
  defaultTimeoutMs?: number
}

export interface Dispatcher {
  // Lifecycle
  start: () => void
  stop: () => void
  isRunning: () => boolean
  
  // Manual dispatch
  dispatch: (task: ClassifiedTask, ctx: AppContext) => Promise<Task | null>
  
  // Task control
  cancelTask: (taskId: string) => boolean
  
  // Event subscriptions
  on: (event: DispatcherEvent, handler: DispatcherEventHandler) => () => void
  off: (event: DispatcherEvent, handler: DispatcherEventHandler) => void
}

export type DispatcherEvent = 
  | 'task:queued'
  | 'task:started'
  | 'task:completed'
  | 'task:failed'
  | 'task:retry'
  | 'task:deadletter'
  | 'task:cancelled'
  | 'task:timeout'
  | 'task:no-agent'

export type DispatcherEventHandler = (task: Task, data?: unknown) => void

interface RunningTask {
  task: Task
  abortController: AbortController
  timeoutId?: ReturnType<typeof setTimeout>
}

export interface DispatcherDeps {
  queueManager: QueueManager
  agentRegistry: AgentRegistry
  taskStore: TaskStore
  router: Router
  hookManager: HookManager
  actionStore: ActionStore
  getContext: () => AppContext
}

export function createDispatcher(
  deps: DispatcherDeps,
  config: DispatcherConfig = {}
): Dispatcher {
  const {
    queueManager,
    agentRegistry,
    taskStore,
    router,
    hookManager,
    actionStore,
    getContext,
  } = deps

  const {
    pollIntervalMs = 100,
    defaultTimeoutMs = 30000,
  } = config

  let running = false
  let pollTimer: ReturnType<typeof setInterval> | null = null
  const runningTasks = new Map<string, RunningTask>()
  const eventHandlers = new Map<DispatcherEvent, Set<DispatcherEventHandler>>()

  // SDK reference for ExecutionContext (set later via closure)
  let sdkRef: unknown = null
  function setSDKRef(sdk: unknown): void {
    sdkRef = sdk
  }

  function emit(event: DispatcherEvent, task: Task, data?: unknown): void {
    const handlers = eventHandlers.get(event)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(task, data)
        } catch (error) {
          console.error(`[dispatcher] Event handler error for ${event}:`, error)
        }
      }
    }
  }

  function on(event: DispatcherEvent, handler: DispatcherEventHandler): () => void {
    if (!eventHandlers.has(event)) {
      eventHandlers.set(event, new Set())
    }
    eventHandlers.get(event)!.add(handler)
    
    return () => off(event, handler)
  }

  function off(event: DispatcherEvent, handler: DispatcherEventHandler): void {
    eventHandlers.get(event)?.delete(handler)
  }

  async function dispatch(classified: ClassifiedTask, ctx: AppContext): Promise<Task | null> {
    // Run beforeRoute hook
    const modifiedTask = await hookManager.runBeforeRoute(classified, ctx)
    if (!modifiedTask) {
      return null // Hook says skip
    }

    // Route to queue
    const queueName = router.route(modifiedTask)
    if (!queueName) {
      console.warn('[dispatcher] No route found for task:', modifiedTask.action)
      return null
    }

    // Get action config for timeout/retries
    const action = actionStore.read(modifiedTask.action)
    const maxAttempts = (action?.retries ?? 0) + 1
    const timeout = action?.timeout ?? defaultTimeoutMs

    // Create task
    const task = taskStore.create(modifiedTask, queueName)
    taskStore.update(task.id, { maxAttempts })

    // Enqueue
    const enqueueResult = queueManager.enqueue(queueName, task)
    if (!enqueueResult.success) {
      if (enqueueResult.reason === 'deadletter') {
        taskStore.markDeadletter(task.id, 'Queue overflow')
        emit('task:deadletter', taskStore.read(task.id)!, 'Queue overflow')
      } else if (enqueueResult.reason === 'dropped') {
        taskStore.delete(task.id)
      } else {
        taskStore.markDeadletter(task.id, enqueueResult.reason ?? 'Enqueue failed')
        emit('task:deadletter', taskStore.read(task.id)!, enqueueResult.reason)
      }
      return taskStore.read(task.id) ?? null
    }

    emit('task:queued', task)

    // If running, trigger immediate processing
    if (running) {
      // Don't await - let it process asynchronously
      processQueues().catch(err => {
        console.error('[dispatcher] Error processing queues:', err)
      })
    }

    return taskStore.read(task.id) ?? null
  }

  async function processQueues(): Promise<void> {
    const queues = queueManager.list()

    for (const queue of queues) {
      if (queue.paused) continue

      // Try to dequeue and process tasks up to concurrency
      while (true) {
        const task = queueManager.dequeue(queue.name)
        if (!task) break

        // Increment running count immediately to respect concurrency
        queueManager.incrementRunning(queue.name)

        // Process task asynchronously
        processTask(task).catch(error => {
          console.error('[dispatcher] Unexpected error processing task:', error)
        })
      }
    }
  }

  async function processTask(task: Task): Promise<void> {
    const ctx = getContext()

    // Find agent for this task
    const agents = agentRegistry.findForTask(task)
    if (agents.length === 0) {
      emit('task:no-agent', task)
      taskStore.markDeadletter(task.id, 'No agent available')
      emit('task:deadletter', taskStore.read(task.id)!, 'No agent available')
      queueManager.decrementRunning(task.queue)
      return
    }

    const agent = agents[0] // Use highest priority agent

    // Run beforeExecute hook
    const shouldExecute = await hookManager.runBeforeExecute(task, agent, ctx)
    if (!shouldExecute) {
      // Re-queue the task
      queueManager.decrementRunning(task.queue)
      queueManager.enqueue(task.queue, task)
      return
    }

    // Get timeout from action config
    const action = actionStore.read(task.action)
    const timeout = action?.timeout ?? defaultTimeoutMs
    const retryDelay = action?.retryDelay ?? 1000

    // Start execution
    const startedTask = taskStore.start(task.id, agent.id)
    if (!startedTask) {
      console.error('[dispatcher] Failed to start task:', task.id)
      queueManager.decrementRunning(task.queue)
      return
    }

    emit('task:started', startedTask)

    // Setup abort controller and timeout
    const abortController = new AbortController()
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        abortController.abort(new Error('Task timeout'))
      }, timeout)
    }

    runningTasks.set(task.id, { task: startedTask, abortController, timeoutId })

    try {
      // Execute
      const execCtx: ExecutionContext = {
        signal: abortController.signal,
        appContext: ctx,
        attempt: startedTask.attempt,
        sdk: sdkRef as any,
      }

      const result = await agent.resolve(startedTask, execCtx)

      // Clear timeout
      if (timeoutId) clearTimeout(timeoutId)
      runningTasks.delete(task.id)

      // Complete task
      const completedTask = taskStore.complete(task.id, result)
      if (completedTask) {
        emit('task:completed', completedTask, result)
        hookManager.runAfterExecute(completedTask, result)
      }

    } catch (error) {
      // Clear timeout
      if (timeoutId) clearTimeout(timeoutId)
      runningTasks.delete(task.id)

      const errorMessage = error instanceof Error ? error.message : String(error)
      const errorObj = error instanceof Error ? error : new Error(errorMessage)
      const isTimeout = errorMessage === 'Task timeout' || abortController.signal.aborted

      if (isTimeout) {
        emit('task:timeout', taskStore.read(task.id)!)
      }

      // Fail task
      const failedTask = taskStore.fail(task.id, errorMessage)
      if (!failedTask) return

      // Call onError hook for execute stage errors
      hookManager.runOnError(failedTask, errorObj, 'execute')

      emit('task:failed', failedTask, error)

      // Check for retry
      const retryDecision = hookManager.runOnRetry(
        failedTask,
        errorObj,
        failedTask.attempt
      )

      if (retryDecision.retry && failedTask.attempt < failedTask.maxAttempts) {
        const delay = retryDecision.delay ?? retryDelay

        setTimeout(() => {
          const retriedTask = taskStore.prepareRetry(task.id)
          if (retriedTask) {
            emit('task:retry', retriedTask, { attempt: retriedTask.attempt + 1, delay })
            queueManager.enqueue(task.queue, retriedTask)
          }
        }, delay)
      } else {
        taskStore.markDeadletter(task.id, `Max retries exceeded: ${errorMessage}`)
        emit('task:deadletter', taskStore.read(task.id)!, errorMessage)
      }
    } finally {
      queueManager.decrementRunning(task.queue)
    }
  }

  function cancelTask(taskId: string): boolean {
    const running = runningTasks.get(taskId)
    if (running) {
      if (running.timeoutId) clearTimeout(running.timeoutId)
      running.abortController.abort(new Error('Task cancelled'))
      runningTasks.delete(taskId)
    }

    const task = taskStore.cancel(taskId)
    if (task) {
      emit('task:cancelled', task)
      return true
    }

    return false
  }

  function start(): void {
    if (running) return
    running = true

    // Initial process
    processQueues()

    // Start poll loop
    pollTimer = setInterval(() => {
      processQueues()
    }, pollIntervalMs)
  }

  function stop(): void {
    if (!running) return
    running = false

    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }

    // Cancel all running tasks
    for (const [taskId, { abortController, timeoutId }] of runningTasks) {
      if (timeoutId) clearTimeout(timeoutId)
      abortController.abort(new Error('Dispatcher stopped'))
      taskStore.cancel(taskId)
    }
    runningTasks.clear()
  }

  function isRunning(): boolean {
    return running
  }

  // Expose setSDKRef for SDK factory to use
  const dispatcher = {
    start,
    stop,
    isRunning,
    dispatch,
    cancelTask,
    on,
    off,
  }

  // Attach setSDKRef as a hidden property
  Object.defineProperty(dispatcher, '_setSDKRef', {
    value: setSDKRef,
    enumerable: false,
  })

  return dispatcher
}
