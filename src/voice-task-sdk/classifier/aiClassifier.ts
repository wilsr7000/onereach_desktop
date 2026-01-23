/**
 * AI Classifier - OpenAI-based intent classification with debounce and rate limiting
 * 
 * Classifies voice transcripts into actions using OpenAI's API.
 * Features:
 * - Debouncing to prevent rapid-fire API calls
 * - Rate limiting to respect API quotas
 * - Response parsing and validation
 * - Confidence thresholds
 */

import type { Action, AppContext, ClassifiedTask, TaskPriority, ClarificationOption } from '../core/types'
import type { PromptBuilder } from './promptBuilder'

export interface AIClassifierConfig {
  apiKey: string
  model?: string
  debounceMs?: number
  maxRequestsPerMinute?: number
  confidenceThreshold?: number
  temperature?: number
  maxTokens?: number
}

export interface AIClassifierResponse {
  action: string
  params: Record<string, unknown>
  confidence: number
  priority: TaskPriority
  // Disambiguation support
  clarificationNeeded?: boolean
  clarificationQuestion?: string
  clarificationOptions?: ClarificationOption[]
}

export interface AIClassifier {
  classify: (transcript: string, actions: Action[], ctx: AppContext) => Promise<ClassifiedTask | null>
  setConfig: (config: Partial<AIClassifierConfig>) => void
  getConfig: () => AIClassifierConfig
  getStats: () => AIClassifierStats
  resetStats: () => void
  /** Cancels any pending debounced request - useful for cleanup */
  cancelPending: () => void
}

export interface AIClassifierStats {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  rateLimitedRequests: number
  averageLatencyMs: number
}

interface PendingRequest {
  transcript: string
  resolve: (result: ClassifiedTask | null) => void
  reject: (error: Error) => void
}

// OpenAI API interface (minimal)
export interface OpenAIClient {
  chat: {
    completions: {
      create: (params: {
        model: string
        messages: Array<{ role: 'system' | 'user'; content: string }>
        temperature?: number
        max_tokens?: number
        response_format?: { type: 'json_object' }
      }) => Promise<{
        choices: Array<{
          message: {
            content: string | null
          }
        }>
      }>
    }
  }
}

export function createAIClassifier(
  promptBuilder: PromptBuilder,
  openaiClient: OpenAIClient,
  initialConfig: AIClassifierConfig
): AIClassifier {
  let config: AIClassifierConfig = {
    model: 'gpt-4o-mini',
    debounceMs: 300,
    maxRequestsPerMinute: 60,
    confidenceThreshold: 0.3,
    temperature: 0.1,
    maxTokens: 256,
    ...initialConfig,
  }

  // Rate limiting state
  const requestTimestamps: number[] = []
  
  // Debounce state
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let pendingRequest: PendingRequest | null = null

  // Stats
  let stats: AIClassifierStats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    rateLimitedRequests: 0,
    averageLatencyMs: 0,
  }
  let totalLatency = 0

  function isRateLimited(): boolean {
    const now = Date.now()
    const oneMinuteAgo = now - 60000
    
    // Remove old timestamps
    while (requestTimestamps.length > 0 && requestTimestamps[0] < oneMinuteAgo) {
      requestTimestamps.shift()
    }

    return requestTimestamps.length >= (config.maxRequestsPerMinute ?? 60)
  }

  function recordRequest(): void {
    requestTimestamps.push(Date.now())
  }

  function parseResponse(content: string, validActions: string[]): AIClassifierResponse | null {
    try {
      const parsed = JSON.parse(content)

      // Validate required fields
      if (typeof parsed.action !== 'string') {
        return null
      }

      const response: AIClassifierResponse = {
        action: parsed.action,
        params: typeof parsed.params === 'object' && parsed.params !== null ? parsed.params : {},
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        priority: [1, 2, 3].includes(parsed.priority) ? parsed.priority : 2,
      }

      // Parse disambiguation fields if present
      if (parsed.clarificationNeeded === true) {
        response.clarificationNeeded = true
        response.clarificationQuestion = typeof parsed.clarificationQuestion === 'string' 
          ? parsed.clarificationQuestion 
          : 'Could you clarify what you meant?'
        
        // Parse clarification options
        if (Array.isArray(parsed.clarificationOptions)) {
          response.clarificationOptions = parsed.clarificationOptions
            .filter((opt: unknown) => 
              typeof opt === 'object' && opt !== null && 
              typeof (opt as Record<string, unknown>).label === 'string' &&
              typeof (opt as Record<string, unknown>).action === 'string'
            )
            .map((opt: Record<string, unknown>) => ({
              label: opt.label as string,
              action: opt.action as string,
              params: typeof opt.params === 'object' && opt.params !== null 
                ? opt.params as Record<string, unknown> 
                : {},
              confidence: typeof opt.confidence === 'number' ? opt.confidence : undefined,
            }))
            .slice(0, 5) // Max 5 options
        }
      }

      // Check if action is valid (or "unknown")
      if (response.action !== 'unknown' && !validActions.includes(response.action)) {
        // Try to find closest match
        const lowerAction = response.action.toLowerCase()
        const match = validActions.find(a => a.toLowerCase() === lowerAction)
        if (match) {
          response.action = match
        } else {
          response.action = 'unknown'
          response.confidence = 0
        }
      }

      // Validate clarification option actions too
      if (response.clarificationOptions) {
        response.clarificationOptions = response.clarificationOptions.filter(opt => {
          if (validActions.includes(opt.action)) return true
          const match = validActions.find(a => a.toLowerCase() === opt.action.toLowerCase())
          if (match) {
            opt.action = match
            return true
          }
          return false
        })
      }

      return response
    } catch {
      return null
    }
  }

  async function executeClassification(
    transcript: string,
    actions: Action[],
    ctx: AppContext
  ): Promise<ClassifiedTask | null> {
    const startTime = Date.now()
    stats.totalRequests++

    // Check rate limit
    if (isRateLimited()) {
      stats.rateLimitedRequests++
      throw new Error('Rate limit exceeded')
    }

    recordRequest()

    try {
      const { systemPrompt, userPrompt, actionNames } = promptBuilder.build(
        transcript,
        actions,
        ctx
      )

      const response = await openaiClient.chat.completions.create({
        model: config.model ?? 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: config.temperature ?? 0.1,
        max_tokens: config.maxTokens ?? 256,
        response_format: { type: 'json_object' },
      })

      const content = response.choices[0]?.message?.content
      if (!content) {
        stats.failedRequests++
        return null
      }

      const parsed = parseResponse(content, actionNames)
      if (!parsed) {
        stats.failedRequests++
        return null
      }

      stats.successfulRequests++
      
      // Update latency stats
      const latency = Date.now() - startTime
      totalLatency += latency
      stats.averageLatencyMs = totalLatency / stats.successfulRequests

      // If clarification is needed, return with disambiguation info
      if (parsed.clarificationNeeded && parsed.clarificationOptions?.length) {
        return {
          action: parsed.action,
          content: transcript,
          params: parsed.params,
          priority: parsed.priority,
          confidence: parsed.confidence,
          clarificationNeeded: true,
          clarificationQuestion: parsed.clarificationQuestion,
          clarificationOptions: parsed.clarificationOptions,
        }
      }

      // Check confidence threshold - return null only if truly unknown
      if (parsed.action === 'unknown' || parsed.confidence < (config.confidenceThreshold ?? 0.3)) {
        return null
      }

      return {
        action: parsed.action,
        content: transcript,
        params: parsed.params,
        priority: parsed.priority,
        confidence: parsed.confidence,
      }
    } catch (error) {
      stats.failedRequests++
      throw error
    }
  }

  function classify(
    transcript: string,
    actions: Action[],
    ctx: AppContext
  ): Promise<ClassifiedTask | null> {
    return new Promise((resolve, reject) => {
      // Cancel previous pending request if exists
      if (pendingRequest) {
        pendingRequest.resolve(null)
        pendingRequest = null
      }

      // Clear existing debounce timer
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }

      const request: PendingRequest = { transcript, resolve, reject }
      pendingRequest = request

      // Set new debounce timer
      debounceTimer = setTimeout(async () => {
        // Verify this request is still the current one
        if (pendingRequest !== request) {
          // This request was superseded, already resolved with null
          return
        }

        pendingRequest = null
        debounceTimer = null

        try {
          const result = await executeClassification(transcript, actions, ctx)
          request.resolve(result)
        } catch (error) {
          request.reject(error instanceof Error ? error : new Error(String(error)))
        }
      }, config.debounceMs ?? 300)
    })
  }

  function setConfig(newConfig: Partial<AIClassifierConfig>): void {
    config = { ...config, ...newConfig }
  }

  function getConfig(): AIClassifierConfig {
    return { ...config }
  }

  function getStats(): AIClassifierStats {
    return { ...stats }
  }

  function resetStats(): void {
    stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      rateLimitedRequests: 0,
      averageLatencyMs: 0,
    }
    totalLatency = 0
  }

  function cancelPending(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    if (pendingRequest) {
      pendingRequest.resolve(null)
      pendingRequest = null
    }
    // Clear rate limit timestamps to prevent memory buildup
    requestTimestamps.length = 0
  }

  return {
    classify,
    setConfig,
    getConfig,
    getStats,
    resetStats,
    cancelPending,
  }
}
