/**
 * Voice Orb Task SDK Factory
 * 
 * Creates and configures the SDK instance with all subsystems wired together.
 */

import type {
  VoiceTaskSDKConfig,
  Action,
  ActionInput,
  Agent,
  AgentInput,
  Queue,
  QueueInput,
  QueueStats,
  RoutingRule,
  RoutingRuleInput,
  Task,
  ClassifiedTask,
  AppContext,
  SDKEventType,
  UndoEntry,
  Logger,
} from './core/types'

import { createActionStore } from './core/actionStore'
import { createAgentRegistry } from './core/agentRegistry'
import { createQueueManager } from './core/queueManager'
import { createTaskStore } from './core/taskStore'
import { createRouter } from './core/router'
import { createHookManager } from './core/hooks'
import { createDispatcher } from './core/dispatcher'
import { createClassifier, type Classifier } from './classifier'
import { createLogger as createCoreLogger } from './core/logger'

// ============================================================================
// SDK INTERFACE
// ============================================================================

export interface VoiceTaskSDK {
  // Action CRUD
  actions: {
    create: (input: ActionInput) => Action
    read: (name: string) => Action | undefined
    update: (name: string, updates: Partial<ActionInput>) => Action | undefined
    delete: (name: string) => boolean
    list: () => Action[]
    enable: (name: string) => void
    disable: (name: string) => void
  }

  // Queue management
  queues: {
    create: (input: QueueInput) => Queue
    read: (name: string) => Queue | undefined
    delete: (name: string) => boolean
    list: () => Queue[]
    pause: (name: string) => void
    resume: (name: string) => void
    clear: (name: string) => void
    getStats: (name: string) => QueueStats | undefined
  }

  // Routing rules
  router: {
    addRule: (rule: RoutingRuleInput) => RoutingRule
    removeRule: (id: string) => boolean
    listRules: () => RoutingRule[]
    route: (task: ClassifiedTask) => string | null
  }

  // Agent CRUD
  agents: {
    create: (input: AgentInput) => Agent
    read: (id: string) => Agent | undefined
    update: (id: string, updates: Partial<AgentInput>) => Agent | undefined
    delete: (id: string) => boolean
    list: () => Agent[]
    enable: (id: string) => void
    disable: (id: string) => void
  }

  // Task operations
  tasks: {
    list: (queue?: string) => Task[]
    get: (id: string) => Task | undefined
    cancel: (id: string) => boolean
    retry: (id: string) => boolean
  }

  // Context management
  setContext: (ctx: Partial<AppContext>) => void
  updateContext: (ctx: Partial<AppContext>) => void
  getContext: () => AppContext

  // Undo support
  undo: {
    canUndo: () => boolean
    undo: () => Promise<boolean>
    undoById: (id: string) => Promise<boolean>
    getHistory: (limit?: number) => UndoEntry[]
  }

  // Logger
  logger: Logger

  // Event handling
  on: (event: SDKEventType, handler: (data: unknown) => void) => () => void
  off: (event: SDKEventType, handler: (data: unknown) => void) => void

  // Voice control
  startListening: () => Promise<void>
  stopListening: () => void
  isListening: () => boolean

  // Manual task submission (bypass voice)
  submit: (transcript: string) => Promise<Task | null>

  // Cancel a running task
  cancelTask: (id: string) => boolean
}

// ============================================================================
// SDK FACTORY
// ============================================================================

export function createVoiceTaskSDK(config: VoiceTaskSDKConfig): VoiceTaskSDK {
  // Validate config
  if (!config.apiKey) {
    throw new Error('API key is required')
  }

  // Initialize all stores
  const actionStore = createActionStore()
  const agentRegistry = createAgentRegistry()
  const queueManager = createQueueManager()
  const taskStore = createTaskStore()
  const router = createRouter()
  const hookManager = createHookManager()
  const logger = createCoreLogger(config.logger)

  // Set default queue if configured
  if (config.defaultQueue) {
    router.setDefaultQueue(config.defaultQueue)
  }

  // Set hooks if provided
  if (config.hooks) {
    hookManager.setHooks(config.hooks)
  }

  // Initialize context
  let appContext: AppContext = {
    metadata: {},
  }

  // Initialize classifier
  const classifierConfig = config.classifier ?? {}
  let classifier: Classifier | null = null

  if (classifierConfig.mode === 'custom') {
    if (!classifierConfig.customClassify) {
      throw new Error('Custom classifier function required for custom mode')
    }
    classifier = createClassifier({
      mode: 'custom',
      customClassify: async (transcript, _actions, ctx) => {
        return classifierConfig.customClassify!(transcript, ctx)
      },
    })
  } else if (classifierConfig.mode === 'hybrid') {
    if (!classifierConfig.customClassify) {
      throw new Error('Custom classifier function required for hybrid mode')
    }
    classifier = createClassifier({
      mode: 'hybrid',
      apiKey: config.apiKey,
      aiModel: classifierConfig.aiModel,
      debounceMs: classifierConfig.debounceMs,
      maxRequestsPerMinute: classifierConfig.maxRequestsPerMinute,
      customClassify: async (transcript, _actions, ctx) => {
        return classifierConfig.customClassify!(transcript, ctx)
      },
    })
  } else {
    // Default to AI mode
    classifier = createClassifier({
      mode: 'ai',
      apiKey: config.apiKey,
      aiModel: classifierConfig.aiModel,
      debounceMs: classifierConfig.debounceMs,
      maxRequestsPerMinute: classifierConfig.maxRequestsPerMinute,
    })
  }

  // Initialize dispatcher
  const dispatcher = createDispatcher({
    queueManager,
    agentRegistry,
    taskStore,
    router,
    hookManager,
    actionStore,
    getContext: () => appContext,
  })

  // Undo history
  const undoHistory: UndoEntry[] = []
  const maxUndoHistory = 100

  // Event handling
  const eventHandlers = new Map<SDKEventType, Set<(data: unknown) => void>>()

  function emit(event: SDKEventType, data: unknown): void {
    const handlers = eventHandlers.get(event)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data)
        } catch (error) {
          logger.error('sdk', `Event handler error for ${event}`, { error: String(error) })
        }
      }
    }
  }

  // Wire up dispatcher events to SDK events
  dispatcher.on('task:queued', (task) => emit('queued', task))
  dispatcher.on('task:started', (task) => emit('started', task))
  dispatcher.on('task:completed', (task, result) => {
    emit('completed', { task, result })
    // Add to undo history if undo function is provided
    if (task.result?.undo) {
      const entry: UndoEntry = {
        id: crypto.randomUUID(),
        taskId: task.id,
        action: task.action,
        description: task.content,
        undo: task.result.undo,
        timestamp: Date.now(),
      }
      undoHistory.unshift(entry)
      if (undoHistory.length > maxUndoHistory) {
        undoHistory.pop()
      }
    }
    // Update context with last task
    appContext = { ...appContext, lastTask: task }
  })
  dispatcher.on('task:failed', (task, error) => emit('failed', { task, error }))
  dispatcher.on('task:retry', (task, data) => emit('retry', { task, ...data as object }))
  dispatcher.on('task:deadletter', (task, reason) => emit('deadletter', { task, reason }))
  dispatcher.on('task:cancelled', (task) => emit('cancelled', task))

  // Voice state
  let listening = false

  // Build SDK object
  const sdk: VoiceTaskSDK = {
    actions: {
      create: (input) => {
        const action = actionStore.create(input)
        logger.info('sdk', 'Action created', { name: action.name })
        return action
      },
      read: (name) => actionStore.read(name),
      update: (name, updates) => {
        const action = actionStore.update(name, updates)
        if (action) logger.info('sdk', 'Action updated', { name })
        return action
      },
      delete: (name) => {
        const result = actionStore.delete(name)
        if (result) logger.info('sdk', 'Action deleted', { name })
        return result
      },
      list: () => actionStore.list(),
      enable: (name) => {
        actionStore.enable(name)
        logger.info('sdk', 'Action enabled', { name })
      },
      disable: (name) => {
        actionStore.disable(name)
        logger.info('sdk', 'Action disabled', { name })
      },
    },

    queues: {
      create: (input) => {
        const queue = queueManager.create(input)
        logger.info('sdk', 'Queue created', { name: queue.name })
        emit('queue:created', queue)
        return queue
      },
      read: (name) => queueManager.read(name),
      delete: (name) => {
        const result = queueManager.delete(name)
        if (result) logger.info('sdk', 'Queue deleted', { name })
        return result
      },
      list: () => queueManager.list(),
      pause: (name) => {
        queueManager.pause(name)
        logger.info('sdk', 'Queue paused', { name })
        emit('queue:paused', { name })
      },
      resume: (name) => {
        queueManager.resume(name)
        logger.info('sdk', 'Queue resumed', { name })
        emit('queue:resumed', { name })
      },
      clear: (name) => {
        queueManager.clear(name)
        logger.info('sdk', 'Queue cleared', { name })
      },
      getStats: (name) => queueManager.getStats(name),
    },

    router: {
      addRule: (rule) => router.addRule(rule),
      removeRule: (id) => router.removeRule(id),
      listRules: () => router.listRules(),
      route: (task) => router.route(task),
    },

    agents: {
      create: (input) => {
        const agent = agentRegistry.create(input)
        logger.info('sdk', 'Agent created', { id: agent.id, name: agent.name })
        emit('agent:registered', agent)
        return agent
      },
      read: (id) => agentRegistry.read(id),
      update: (id, updates) => {
        const agent = agentRegistry.update(id, updates)
        if (agent) logger.info('sdk', 'Agent updated', { id })
        return agent
      },
      delete: (id) => {
        const result = agentRegistry.delete(id)
        if (result) {
          logger.info('sdk', 'Agent deleted', { id })
          emit('agent:removed', { id })
        }
        return result
      },
      list: () => agentRegistry.list(),
      enable: (id) => {
        agentRegistry.enable(id)
        logger.info('sdk', 'Agent enabled', { id })
      },
      disable: (id) => {
        agentRegistry.disable(id)
        logger.info('sdk', 'Agent disabled', { id })
      },
    },

    tasks: {
      list: (queue?) => {
        if (queue) {
          return taskStore.list({ queue })
        }
        return taskStore.list()
      },
      get: (id) => taskStore.read(id),
      cancel: (id) => dispatcher.cancelTask(id),
      retry: (id) => {
        const task = taskStore.prepareRetry(id)
        if (task) {
          queueManager.enqueue(task.queue, task)
          return true
        }
        return false
      },
    },

    setContext: (ctx) => {
      appContext = { ...ctx }
    },

    updateContext: (ctx) => {
      appContext = { ...appContext, ...ctx }
    },

    getContext: () => ({ ...appContext }),

    undo: {
      canUndo: () => undoHistory.length > 0,
      undo: async () => {
        const entry = undoHistory.shift()
        if (!entry) return false
        try {
          await entry.undo()
          logger.info('sdk', 'Undo executed', { taskId: entry.taskId, action: entry.action })
          emit('undo', entry)
          return true
        } catch (error) {
          logger.error('sdk', 'Undo failed', { taskId: entry.taskId, error: String(error) })
          return false
        }
      },
      undoById: async (id) => {
        const index = undoHistory.findIndex(e => e.id === id)
        if (index === -1) return false
        const [entry] = undoHistory.splice(index, 1)
        try {
          await entry.undo()
          logger.info('sdk', 'Undo executed', { taskId: entry.taskId, action: entry.action })
          emit('undo', entry)
          return true
        } catch (error) {
          logger.error('sdk', 'Undo failed', { taskId: entry.taskId, error: String(error) })
          return false
        }
      },
      getHistory: (limit?) => {
        if (limit) return undoHistory.slice(0, limit)
        return [...undoHistory]
      },
    },

    logger,

    on: (event, handler) => {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, new Set())
      }
      eventHandlers.get(event)!.add(handler)
      return () => sdk.off(event, handler)
    },

    off: (event, handler) => {
      eventHandlers.get(event)?.delete(handler)
    },

    startListening: async () => {
      if (listening) return
      listening = true
      dispatcher.start()
      logger.info('sdk', 'Started listening')
      // TODO: Initialize voice recognition service
    },

    stopListening: () => {
      if (!listening) return
      listening = false
      dispatcher.stop()
      logger.info('sdk', 'Stopped listening')
      // TODO: Stop voice recognition service
    },

    isListening: () => listening,

    submit: async (transcript: string) => {
      logger.info('sdk', 'Transcript received', { transcript })
      emit('transcript', { transcript, timestamp: Date.now() })

      // Run beforeClassify hook
      const modifiedTranscript = await hookManager.runBeforeClassify(transcript, appContext)
      if (modifiedTranscript === null) {
        logger.debug('sdk', 'Classification skipped by beforeClassify hook')
        return null
      }

      try {
        // Classify the transcript
        const enabledActions = actionStore.list(true)
        const classified = await classifier!.classify(modifiedTranscript, enabledActions, appContext)

        if (!classified) {
          logger.debug('sdk', 'No action classified from transcript')
          return null
        }

        logger.info('classifier', 'Classified task', { 
          action: classified.action, 
          confidence: classified.params 
        })
        emit('classified', classified)

        // Dispatch to queue
        const task = await dispatcher.dispatch(classified, appContext)
        return task
      } catch (error) {
        logger.error('classifier', 'Classification failed', { error: String(error) })
        if (config.errors?.onClassifyError === 'ignore') {
          return null
        }
        throw error
      }
    },

    cancelTask: (id: string) => dispatcher.cancelTask(id),
  }

  // Set SDK reference in dispatcher for ExecutionContext
  const dispatcherWithRef = dispatcher as typeof dispatcher & { _setSDKRef?: (sdk: unknown) => void }
  if (dispatcherWithRef._setSDKRef) {
    dispatcherWithRef._setSDKRef(sdk)
  }

  return sdk
}
