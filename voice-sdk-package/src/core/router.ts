/**
 * Router - Action-to-queue routing rules engine
 * 
 * Routes classified tasks to the appropriate queue based on:
 * - Exact action name match
 * - Pattern matching (regex)
 * - Custom condition functions
 * - Default queue fallback
 */

import type { RoutingRule, RoutingRuleInput, ClassifiedTask, Task } from './types'

export interface Router {
  addRule: (rule: RoutingRuleInput) => RoutingRule
  removeRule: (id: string) => boolean
  updateRule: (id: string, updates: Partial<RoutingRuleInput>) => RoutingRule | undefined
  getRule: (id: string) => RoutingRule | undefined
  listRules: () => RoutingRule[]
  clear: () => void
  
  // Routing
  route: (task: ClassifiedTask) => string | null
  setDefaultQueue: (queueName: string | null) => void
  getDefaultQueue: () => string | null
}

export function createRouter(): Router {
  const rules = new Map<string, RoutingRule>()
  let defaultQueue: string | null = null

  function generateId(): string {
    return crypto.randomUUID()
  }

  function addRule(input: RoutingRuleInput): RoutingRule {
    // Validate input
    if (!input.target || typeof input.target !== 'string') {
      throw new Error('Routing rule target queue is required and must be a string')
    }
    if (input.target.trim().length === 0) {
      throw new Error('Routing rule target queue cannot be empty')
    }
    if (!input.match || typeof input.match !== 'object') {
      throw new Error('Routing rule match criteria is required')
    }

    // Ensure at least one match criteria is specified
    const hasAction = input.match.action !== undefined
    const hasPattern = input.match.pattern !== undefined
    const hasCondition = input.match.condition !== undefined
    if (!hasAction && !hasPattern && !hasCondition) {
      throw new Error('Routing rule must have at least one match criteria (action, pattern, or condition)')
    }

    const id = input.id ?? generateId()
    
    if (rules.has(id)) {
      throw new Error(`Rule with id "${id}" already exists`)
    }

    const rule: RoutingRule = {
      id,
      match: input.match,
      target: input.target.trim(),
      priority: input.priority ?? 0,
    }

    rules.set(id, rule)
    return rule
  }

  function removeRule(id: string): boolean {
    return rules.delete(id)
  }

  function updateRule(id: string, updates: Partial<RoutingRuleInput>): RoutingRule | undefined {
    const existing = rules.get(id)
    if (!existing) return undefined

    const updated: RoutingRule = {
      ...existing,
      ...updates,
      id: existing.id, // Prevent ID change
    }

    rules.set(id, updated)
    return updated
  }

  function getRule(id: string): RoutingRule | undefined {
    return rules.get(id)
  }

  function listRules(): RoutingRule[] {
    return Array.from(rules.values())
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  }

  function clear(): void {
    rules.clear()
  }

  function matchesRule(task: ClassifiedTask, rule: RoutingRule): boolean {
    const { match } = rule

    // Check exact action match
    if (match.action) {
      const actions = Array.isArray(match.action) ? match.action : [match.action]
      if (actions.includes(task.action)) {
        return true
      }
    }

    // Check pattern match
    if (match.pattern) {
      if (match.pattern.test(task.action)) {
        return true
      }
    }

    // Check custom condition
    if (match.condition) {
      // Create a minimal Task-like object for the condition
      const taskLike = {
        id: '',
        action: task.action,
        content: task.content,
        params: task.params,
        priority: task.priority,
        status: 'pending' as const,
        queue: '',
        createdAt: Date.now(),
        attempt: 0,
        maxAttempts: 1,
      }
      if (match.condition(taskLike)) {
        return true
      }
    }

    return false
  }

  function route(task: ClassifiedTask): string | null {
    // Get rules sorted by priority (higher first)
    const sortedRules = listRules()

    for (const rule of sortedRules) {
      if (matchesRule(task, rule)) {
        return rule.target
      }
    }

    // Return default queue if no rule matched
    return defaultQueue
  }

  function setDefaultQueue(queueName: string | null): void {
    defaultQueue = queueName
  }

  function getDefaultQueue(): string | null {
    return defaultQueue
  }

  return {
    addRule,
    removeRule,
    updateRule,
    getRule,
    listRules,
    clear,
    route,
    setDefaultQueue,
    getDefaultQueue,
  }
}
