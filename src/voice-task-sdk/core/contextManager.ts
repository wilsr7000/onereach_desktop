/**
 * Context Manager - App context management for classifier and agents
 * 
 * Manages application state that's passed to:
 * - Classifier (for informed classification decisions)
 * - Agents (for context-aware execution)
 * 
 * Includes conversation history tracking for multi-turn interactions.
 */

import type { AppContext, ConversationEntry, Task } from './types'

export interface ContextManager {
  get: () => AppContext
  set: (ctx: AppContext) => void
  update: (partial: Partial<AppContext>) => void
  
  // Conversation history
  addUserMessage: (content: string) => void
  addAssistantMessage: (content: string) => void
  clearHistory: () => void
  getHistory: () => ConversationEntry[]
  
  // Task tracking
  setLastTask: (task: Task) => void
  getLastTask: () => Task | undefined
  
  // Metadata helpers
  setMetadata: (key: string, value: unknown) => void
  getMetadata: (key: string) => unknown
  clearMetadata: () => void
  
  // Reset
  reset: () => void
}

export interface ContextManagerConfig {
  maxHistoryLength?: number
  initialContext?: Partial<AppContext>
}

export function createContextManager(config: ContextManagerConfig = {}): ContextManager {
  const { maxHistoryLength = 50, initialContext = {} } = config

  let context: AppContext = {
    metadata: {},
    conversationHistory: [],
    ...initialContext,
  }

  function get(): AppContext {
    return { ...context }
  }

  function set(ctx: AppContext): void {
    context = {
      ...ctx,
      conversationHistory: ctx.conversationHistory ?? [],
      metadata: ctx.metadata ?? {},
    }
  }

  function update(partial: Partial<AppContext>): void {
    context = {
      ...context,
      ...partial,
      // Preserve existing metadata if not explicitly overwritten
      metadata: partial.metadata !== undefined 
        ? partial.metadata 
        : context.metadata,
      // Preserve conversation history if not explicitly overwritten
      conversationHistory: partial.conversationHistory !== undefined
        ? partial.conversationHistory
        : context.conversationHistory,
    }
  }

  function addUserMessage(content: string): void {
    const entry: ConversationEntry = {
      role: 'user',
      content,
      timestamp: Date.now(),
    }

    context.conversationHistory = [
      ...(context.conversationHistory ?? []),
      entry,
    ].slice(-maxHistoryLength)
  }

  function addAssistantMessage(content: string): void {
    const entry: ConversationEntry = {
      role: 'assistant',
      content,
      timestamp: Date.now(),
    }

    context.conversationHistory = [
      ...(context.conversationHistory ?? []),
      entry,
    ].slice(-maxHistoryLength)
  }

  function clearHistory(): void {
    context.conversationHistory = []
  }

  function getHistory(): ConversationEntry[] {
    return [...(context.conversationHistory ?? [])]
  }

  function setLastTask(task: Task): void {
    context.lastTask = task
  }

  function getLastTask(): Task | undefined {
    return context.lastTask
  }

  function setMetadata(key: string, value: unknown): void {
    context.metadata = {
      ...(context.metadata ?? {}),
      [key]: value,
    }
  }

  function getMetadata(key: string): unknown {
    return context.metadata?.[key]
  }

  function clearMetadata(): void {
    context.metadata = {}
  }

  function reset(): void {
    context = {
      metadata: {},
      conversationHistory: [],
    }
  }

  return {
    get,
    set,
    update,
    addUserMessage,
    addAssistantMessage,
    clearHistory,
    getHistory,
    setLastTask,
    getLastTask,
    setMetadata,
    getMetadata,
    clearMetadata,
    reset,
  }
}
