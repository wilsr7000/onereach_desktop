/**
 * Classifier Factory - Creates classifiers in AI, custom, or hybrid modes
 * 
 * Modes:
 * - AI: Uses OpenAI for classification (requires API key)
 * - Custom: Uses developer-provided classification function
 * - Hybrid: Tries custom first, falls back to AI
 */

import type { Action, AppContext, ClassifiedTask, ClassifierConfig } from '../core/types'
import { createPromptBuilder, type PromptBuilder, type PromptBuilderConfig } from './promptBuilder'
import { createAIClassifier, type AIClassifier, type OpenAIClient } from './aiClassifier'

export interface Classifier {
  classify: (transcript: string, actions: Action[], ctx: AppContext) => Promise<ClassifiedTask | null>
  getMode: () => 'ai' | 'custom' | 'hybrid'
  getStats: () => ClassifierStats
  resetStats: () => void
  /** Cancels any pending debounced request - useful for cleanup */
  cancelPending: () => void
}

export interface ClassifierStats {
  totalClassifications: number
  aiClassifications: number
  customClassifications: number
  nullResults: number
  errors: number
}

export interface ClassifierFactoryConfig {
  mode: 'ai' | 'custom' | 'hybrid'
  apiKey?: string
  aiModel?: string
  debounceMs?: number
  maxRequestsPerMinute?: number
  confidenceThreshold?: number
  customClassify?: (transcript: string, actions: Action[], ctx: AppContext) => Promise<ClassifiedTask | null>
  promptConfig?: PromptBuilderConfig
  openaiClient?: OpenAIClient // For testing/custom clients
}

export function createClassifier(config: ClassifierFactoryConfig): Classifier {
  const {
    mode,
    apiKey,
    aiModel,
    debounceMs,
    maxRequestsPerMinute,
    confidenceThreshold,
    customClassify,
    promptConfig,
    openaiClient,
  } = config

  // Validate config
  if (mode === 'ai' || mode === 'hybrid') {
    if (!apiKey && !openaiClient) {
      throw new Error('API key or OpenAI client required for AI/hybrid mode')
    }
  }

  if (mode === 'custom' || mode === 'hybrid') {
    if (!customClassify) {
      throw new Error('Custom classify function required for custom/hybrid mode')
    }
  }

  // Initialize components
  let promptBuilder: PromptBuilder | null = null
  let aiClassifier: AIClassifier | null = null

  if (mode === 'ai' || mode === 'hybrid') {
    promptBuilder = createPromptBuilder(promptConfig)
    
    // Use provided client or create a placeholder
    // In production, the SDK factory will inject the real OpenAI client
    const client = openaiClient ?? createPlaceholderClient()
    
    aiClassifier = createAIClassifier(promptBuilder, client, {
      apiKey: apiKey ?? '',
      model: aiModel,
      debounceMs,
      maxRequestsPerMinute,
      confidenceThreshold,
    })
  }

  // Stats
  let stats: ClassifierStats = {
    totalClassifications: 0,
    aiClassifications: 0,
    customClassifications: 0,
    nullResults: 0,
    errors: 0,
  }

  async function classifyWithAI(
    transcript: string,
    actions: Action[],
    ctx: AppContext
  ): Promise<ClassifiedTask | null> {
    if (!aiClassifier) {
      throw new Error('AI classifier not initialized')
    }

    const result = await aiClassifier.classify(transcript, actions, ctx)
    if (result) {
      stats.aiClassifications++
    }
    return result
  }

  async function classifyWithCustom(
    transcript: string,
    actions: Action[],
    ctx: AppContext
  ): Promise<ClassifiedTask | null> {
    if (!customClassify) {
      throw new Error('Custom classifier not provided')
    }

    const result = await customClassify(transcript, actions, ctx)
    if (result) {
      stats.customClassifications++
    }
    return result
  }

  async function classify(
    transcript: string,
    actions: Action[],
    ctx: AppContext
  ): Promise<ClassifiedTask | null> {
    stats.totalClassifications++

    try {
      let result: ClassifiedTask | null = null

      switch (mode) {
        case 'ai':
          result = await classifyWithAI(transcript, actions, ctx)
          break

        case 'custom':
          result = await classifyWithCustom(transcript, actions, ctx)
          break

        case 'hybrid':
          // Try custom first
          result = await classifyWithCustom(transcript, actions, ctx)
          
          // Fall back to AI if custom returns null
          if (!result) {
            result = await classifyWithAI(transcript, actions, ctx)
          }
          break
      }

      if (!result) {
        stats.nullResults++
      }

      return result
    } catch (error) {
      stats.errors++
      throw error
    }
  }

  function getMode(): 'ai' | 'custom' | 'hybrid' {
    return mode
  }

  function getStats(): ClassifierStats {
    return { ...stats }
  }

  function resetStats(): void {
    stats = {
      totalClassifications: 0,
      aiClassifications: 0,
      customClassifications: 0,
      nullResults: 0,
      errors: 0,
    }

    if (aiClassifier) {
      aiClassifier.resetStats()
    }
  }

  function cancelPending(): void {
    if (aiClassifier) {
      aiClassifier.cancelPending()
    }
  }

  return {
    classify,
    getMode,
    getStats,
    resetStats,
    cancelPending,
  }
}

// Placeholder client that throws helpful error
function createPlaceholderClient(): OpenAIClient {
  return {
    chat: {
      completions: {
        create: async () => {
          throw new Error(
            'OpenAI client not configured. Either provide an API key or inject a custom OpenAI client.'
          )
        },
      },
    },
  }
}

// Re-export types
export type { PromptBuilder, PromptBuilderConfig, BuiltPrompt } from './promptBuilder'
export type { AIClassifier, AIClassifierConfig, OpenAIClient } from './aiClassifier'
export { createPromptBuilder } from './promptBuilder'
export { createAIClassifier } from './aiClassifier'
