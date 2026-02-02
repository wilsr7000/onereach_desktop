/**
 * Voice Orb Task SDK - Core Type Definitions
 */

// ============================================================================
// PARAM SCHEMA
// ============================================================================

export interface ParamSchema {
  name: string
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  required?: boolean
  description?: string
  default?: unknown
}

// ============================================================================
// ACTION TYPES
// ============================================================================

export type TaskPriority = 1 | 2 | 3

export interface Action {
  id: string
  name: string
  description: string
  params: ParamSchema[]
  defaultQueue?: string
  defaultPriority?: TaskPriority
  examples?: string[]
  timeout?: number
  retries?: number
  retryDelay?: number
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export type ActionInput = Omit<Action, 'id' | 'enabled' | 'createdAt' | 'updatedAt'>

// ============================================================================
// QUEUE TYPES
// ============================================================================

export type QueueOverflow = 'drop' | 'error' | 'deadletter'

export interface Queue {
  id: string
  name: string
  concurrency: number
  maxSize?: number
  overflow?: QueueOverflow
  paused: boolean
  runningCount: number
  createdAt: number
}

export interface QueueInput {
  name: string
  concurrency: number
  maxSize?: number
  overflow?: QueueOverflow
}

export interface QueueStats {
  pending: number
  running: number
  completed: number
  failed: number
}

// ============================================================================
// ROUTING TYPES
// ============================================================================

export interface RoutingRule {
  id: string
  match: {
    action?: string | string[]
    pattern?: RegExp
    condition?: (task: Task) => boolean
  }
  target: string
  priority?: number
}

export type RoutingRuleInput = Omit<RoutingRule, 'id'> & { id?: string }

// ============================================================================
// TASK TYPES
// ============================================================================

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'deadletter'

export interface Task {
  id: string
  action: string
  content: string
  params: Record<string, unknown>
  priority: TaskPriority
  status: TaskStatus
  queue: string
  assignedAgent?: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  attempt: number
  maxAttempts: number
  lastError?: string
  result?: TaskResult
  error?: string
}

export interface TaskResult {
  success: boolean
  data?: unknown
  error?: string
  undo?: () => Promise<void>
}

export interface ClassifiedTask {
  action: string
  content: string
  params: Record<string, unknown>
  priority: TaskPriority
  confidence?: number
  // Disambiguation support
  clarificationNeeded?: boolean
  clarificationQuestion?: string
  clarificationOptions?: ClarificationOption[]
}

export interface ClarificationOption {
  label: string
  action: string
  params?: Record<string, unknown>
  confidence?: number
}

// ============================================================================
// AGENT TYPES
// ============================================================================

export interface Agent {
  id: string
  name: string
  queues?: string[]
  actions?: string[]
  resolve: (task: Task, ctx: ExecutionContext) => Promise<TaskResult>
  canHandle?: (task: Task) => boolean
  priority?: number
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export type AgentInput = Omit<Agent, 'id' | 'enabled' | 'createdAt' | 'updatedAt'>

export interface ExecutionContext {
  signal: AbortSignal
  appContext: AppContext
  attempt: number
  sdk: VoiceTaskSDK
}

// ============================================================================
// CONTEXT TYPES
// ============================================================================

export interface ConversationEntry {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export interface AppContext {
  activeDocument?: string
  selectedText?: string
  currentUser?: { id: string; role: string }
  metadata?: Record<string, unknown>
  conversationHistory?: ConversationEntry[]
  lastTask?: Task
}

// ============================================================================
// CLASSIFIER TYPES
// ============================================================================

export interface ClassifierConfig {
  mode: 'ai' | 'custom' | 'hybrid'
  aiModel?: string
  debounceMs?: number
  maxRequestsPerMinute?: number
  customClassify?: (transcript: string, ctx: AppContext) => Promise<ClassifiedTask | null>
  conversationHistory?: boolean
  maxHistoryLength?: number
}

// ============================================================================
// LIFECYCLE HOOKS
// ============================================================================

export interface LifecycleHooks {
  beforeClassify?: (transcript: string, ctx: AppContext) => string | null | Promise<string | null>
  beforeRoute?: (task: ClassifiedTask, ctx: AppContext) => ClassifiedTask | null | Promise<ClassifiedTask | null>
  beforeExecute?: (task: Task, agent: Agent, ctx: AppContext) => boolean | Promise<boolean>
  onRetry?: (task: Task, error: Error, attempt: number) => { retry: boolean; delay?: number }
  afterExecute?: (task: Task, result: TaskResult) => void
  onError?: (task: Task, error: Error, stage: 'classify' | 'route' | 'execute') => void
}

// ============================================================================
// ERROR HANDLING
// ============================================================================

export interface ErrorConfig {
  onNoAgent?: 'deadletter' | 'error' | 'drop' | ((task: Task) => void)
  onClassifyError?: 'ignore' | 'deadletter' | ((transcript: string, error: Error) => void)
  onMaxRetries?: 'deadletter' | 'drop' | ((task: Task) => void)
  onQueuePaused?: 'buffer' | 'deadletter' | 'error'
}

// ============================================================================
// PERSISTENCE
// ============================================================================

export interface PersistenceAdapter {
  saveActions: (actions: Action[]) => Promise<void>
  saveAgents: (agents: Agent[]) => Promise<void>
  saveQueues: (queues: Queue[]) => Promise<void>
  savePendingTasks: (tasks: Task[]) => Promise<void>
  saveUndoHistory: (history: UndoEntry[]) => Promise<void>
  loadActions: () => Promise<Action[]>
  loadAgents: () => Promise<Agent[]>
  loadQueues: () => Promise<Queue[]>
  loadPendingTasks: () => Promise<Task[]>
  loadUndoHistory: () => Promise<UndoEntry[]>
}

// ============================================================================
// UNDO
// ============================================================================

export interface UndoEntry {
  id: string
  taskId: string
  action: string
  description: string
  undo: () => Promise<void>
  timestamp: number
}

// ============================================================================
// LOGGER TYPES
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogCategory = 
  | 'voice'
  | 'classifier'
  | 'router'
  | 'queue'
  | 'dispatcher'
  | 'agent'
  | 'retry'
  | 'undo'
  | 'persistence'
  | 'lifecycle'
  | 'sdk'

export interface LogEntry {
  timestamp: number
  level: LogLevel
  category: LogCategory
  message: string
  data?: Record<string, unknown>
  taskId?: string
  agentId?: string
  duration?: number
}

export interface LoggerConfig {
  level?: LogLevel
  categories?: { [K in LogCategory]?: boolean }
  handler?: (entry: LogEntry) => void
  redact?: {
    transcripts?: boolean
    params?: boolean
    patterns?: RegExp[]
  }
  maxBufferSize?: number
  flushInterval?: number
  persist?: boolean
  maxPersistedLogs?: number
}

export interface LogQuery {
  category?: LogCategory
  level?: LogLevel
  taskId?: string
  agentId?: string
  since?: number
  limit?: number
}

export interface Logger {
  debug: (category: LogCategory, message: string, data?: Record<string, unknown>) => void
  info: (category: LogCategory, message: string, data?: Record<string, unknown>) => void
  warn: (category: LogCategory, message: string, data?: Record<string, unknown>) => void
  error: (category: LogCategory, message: string, data?: Record<string, unknown>) => void
  setLevel: (level: LogLevel) => void
  getLevel: () => LogLevel
  enableCategory: (category: LogCategory) => void
  disableCategory: (category: LogCategory) => void
  getLogs: (query?: LogQuery) => LogEntry[]
  exportLogs: () => string
  clearLogs: () => void
}

// ============================================================================
// SDK CONFIG
// ============================================================================

export interface VoiceTaskSDKConfig {
  apiKey: string
  classifier?: Partial<ClassifierConfig>
  errors?: Partial<ErrorConfig>
  hooks?: Partial<LifecycleHooks>
  logger?: Partial<LoggerConfig>
  persistence?: PersistenceAdapter
  defaultQueue?: string
}

// ============================================================================
// SDK INTERFACE
// ============================================================================

export interface VoiceTaskSDK {
  actions: {
    create: (input: ActionInput) => Action
    read: (name: string) => Action | undefined
    update: (name: string, updates: Partial<ActionInput>) => Action | undefined
    delete: (name: string) => boolean
    list: () => Action[]
    enable: (name: string) => void
    disable: (name: string) => void
  }

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

  router: {
    addRule: (rule: RoutingRuleInput) => RoutingRule
    removeRule: (id: string) => boolean
    listRules: () => RoutingRule[]
    route: (task: ClassifiedTask) => string | null
  }

  agents: {
    create: (input: AgentInput) => Agent
    read: (id: string) => Agent | undefined
    update: (id: string, updates: Partial<AgentInput>) => Agent | undefined
    delete: (id: string) => boolean
    list: () => Agent[]
    enable: (id: string) => void
    disable: (id: string) => void
  }

  tasks: {
    list: (queue?: string) => Task[]
    get: (id: string) => Task | undefined
    cancel: (id: string) => boolean
    retry: (id: string) => boolean
  }

  setContext: (ctx: Partial<AppContext>) => void
  updateContext: (ctx: Partial<AppContext>) => void
  getContext: () => AppContext

  undo: {
    canUndo: () => boolean
    undo: () => Promise<boolean>
    undoById: (id: string) => Promise<boolean>
    getHistory: (limit?: number) => UndoEntry[]
  }

  logger: Logger

  on: (event: SDKEventType, handler: (data: unknown) => void) => () => void
  off: (event: SDKEventType, handler: (data: unknown) => void) => void

  startListening: () => Promise<void>
  stopListening: () => void
  isListening: () => boolean

  submit: (transcript: string) => Promise<Task | null>
  cancelTask: (id: string) => boolean
}

// ============================================================================
// EVENT TYPES
// ============================================================================

export type SDKEventType = 
  | 'transcript'
  | 'classified'
  | 'queued'
  | 'started'
  | 'completed'
  | 'failed'
  | 'retry'
  | 'deadletter'
  | 'cancelled'
  | 'agent:registered'
  | 'agent:removed'
  | 'queue:created'
  | 'queue:paused'
  | 'queue:resumed'
  | 'undo'
  | 'log'

export interface SDKEvent {
  type: SDKEventType
  timestamp: number
  data: unknown
}
