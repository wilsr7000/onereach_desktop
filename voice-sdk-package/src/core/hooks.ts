/**
 * Lifecycle Hooks - Intercept and modify at every stage
 * 
 * Hooks allow developers to:
 * - Transform transcripts before classification
 * - Modify classified tasks before routing
 * - Block or allow task execution
 * - Control retry behavior
 * - React to completion/errors
 */

import type {
  LifecycleHooks,
  AppContext,
  ClassifiedTask,
  Task,
  Agent,
  TaskResult,
} from './types'

export interface HookManager {
  // Register hooks
  setHooks: (hooks: Partial<LifecycleHooks>) => void
  getHooks: () => LifecycleHooks
  
  // Execute hooks
  runBeforeClassify: (transcript: string, ctx: AppContext) => Promise<string | null>
  runBeforeRoute: (task: ClassifiedTask, ctx: AppContext) => Promise<ClassifiedTask | null>
  runBeforeExecute: (task: Task, agent: Agent, ctx: AppContext) => Promise<boolean>
  runOnRetry: (task: Task, error: Error, attempt: number) => { retry: boolean; delay?: number }
  runAfterExecute: (task: Task, result: TaskResult) => void
  runOnError: (task: Task, error: Error, stage: 'classify' | 'route' | 'execute') => void
  
  // Clear hooks
  clear: () => void
}

export function createHookManager(): HookManager {
  let hooks: LifecycleHooks = {}

  function setHooks(newHooks: Partial<LifecycleHooks>): void {
    hooks = { ...hooks, ...newHooks }
  }

  function getHooks(): LifecycleHooks {
    return { ...hooks }
  }

  async function runBeforeClassify(transcript: string, ctx: AppContext): Promise<string | null> {
    if (!hooks.beforeClassify) {
      return transcript
    }

    try {
      const result = await hooks.beforeClassify(transcript, ctx)
      // null means skip classification entirely
      return result
    } catch (error) {
      console.error('[hooks] beforeClassify error:', error)
      // On error, return original transcript (don't block)
      return transcript
    }
  }

  async function runBeforeRoute(task: ClassifiedTask, ctx: AppContext): Promise<ClassifiedTask | null> {
    if (!hooks.beforeRoute) {
      return task
    }

    try {
      const result = await hooks.beforeRoute(task, ctx)
      // null means skip routing entirely
      return result
    } catch (error) {
      console.error('[hooks] beforeRoute error:', error)
      // On error, return original task (don't block)
      return task
    }
  }

  async function runBeforeExecute(task: Task, agent: Agent, ctx: AppContext): Promise<boolean> {
    if (!hooks.beforeExecute) {
      return true
    }

    try {
      const result = await hooks.beforeExecute(task, agent, ctx)
      return result
    } catch (error) {
      console.error('[hooks] beforeExecute error:', error)
      // On error, allow execution by default
      return true
    }
  }

  function runOnRetry(task: Task, error: Error, attempt: number): { retry: boolean; delay?: number } {
    if (!hooks.onRetry) {
      // Default: retry if under max attempts
      return { retry: attempt < task.maxAttempts }
    }

    try {
      return hooks.onRetry(task, error, attempt)
    } catch (hookError) {
      console.error('[hooks] onRetry error:', hookError)
      // On error, use default retry behavior
      return { retry: attempt < task.maxAttempts }
    }
  }

  function runAfterExecute(task: Task, result: TaskResult): void {
    if (!hooks.afterExecute) {
      return
    }

    try {
      hooks.afterExecute(task, result)
    } catch (error) {
      console.error('[hooks] afterExecute error:', error)
      // Don't throw, just log
    }
  }

  function runOnError(task: Task, error: Error, stage: 'classify' | 'route' | 'execute'): void {
    if (!hooks.onError) {
      return
    }

    try {
      hooks.onError(task, error, stage)
    } catch (hookError) {
      console.error('[hooks] onError error:', hookError)
      // Don't throw, just log
    }
  }

  function clear(): void {
    hooks = {}
  }

  return {
    setHooks,
    getHooks,
    runBeforeClassify,
    runBeforeRoute,
    runBeforeExecute,
    runOnRetry,
    runAfterExecute,
    runOnError,
    clear,
  }
}
