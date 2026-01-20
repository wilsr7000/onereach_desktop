/**
 * Voice Orb Task SDK
 * 
 * A drop-in SDK that voice-enables any application.
 */

// Core types
export type {
  Action,
  ActionInput,
  Agent,
  AgentInput,
  AppContext,
  ClassifiedTask,
  ClassifierConfig,
  ConversationEntry,
  ErrorConfig,
  ExecutionContext,
  LifecycleHooks,
  Logger,
  LoggerConfig,
  LogEntry,
  LogLevel,
  LogCategory,
  LogQuery,
  ParamSchema,
  PersistenceAdapter,
  Queue,
  QueueInput,
  QueueOverflow,
  QueueStats,
  RoutingRule,
  RoutingRuleInput,
  SDKEvent,
  SDKEventType,
  Task,
  TaskPriority,
  TaskResult,
  TaskStatus,
  UndoEntry,
  VoiceTaskSDKConfig,
} from './core/types'

// SDK factory
export { createVoiceTaskSDK, type VoiceTaskSDK } from './createSDK'

// Core stores for advanced usage
export { createActionStore, type ActionStore } from './core/actionStore'
export { createAgentRegistry, type AgentRegistry } from './core/agentRegistry'
export { createQueueManager, type QueueManager } from './core/queueManager'
export { createTaskStore, type TaskStore } from './core/taskStore'
export { createRouter, type Router } from './core/router'
export { createHookManager, type HookManager } from './core/hooks'
export { createDispatcher, type Dispatcher, type DispatcherEvent } from './core/dispatcher'
export { createLogger } from './core/logger'

// Classifier
export { 
  createClassifier, 
  createPromptBuilder,
  createAIClassifier,
  type Classifier,
  type ClassifierStats,
  type PromptBuilder,
  type AIClassifier,
} from './classifier'

// Voice services
export {
  createSpeechManager,
  createRealtimeSpeechService,
  createWhisperSpeechService,
  createVoiceStore,
  type SpeechManager,
  type RealtimeSpeechService,
  type VoiceStore,
  type VoiceState,
  type VoiceStatus,
  type SpeechBackend,
} from './voice'

// Persistence adapters
export {
  createLocalStorageAdapter,
  createIndexedDBAdapter,
  clearLocalStorage,
  deleteDatabase,
  type LocalStorageAdapterConfig,
  type IndexedDBAdapterConfig,
} from './persistence'
