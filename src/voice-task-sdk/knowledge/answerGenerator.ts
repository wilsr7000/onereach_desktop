/**
 * Answer Generator - LLM-based answer synthesis via unified ai-service
 * 
 * Generates natural language answers from search results using the
 * centralized AI service. Supports provider fallback, retry, and cost tracking.
 * 
 * Note: config.apiKey is accepted for backward compatibility but no longer
 * used directly -- ai-service manages API keys via settingsManager.
 */

import type { 
  AnswerConfig, 
  AnswerContext, 
  AnswerGenerator, 
  GeneratedAnswer 
} from './types'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ai = require('../../../lib/ai-service')

const DEFAULT_MAX_TOKENS = 1024
const DEFAULT_TEMPERATURE = 0.3

const DEFAULT_SYSTEM_PROMPT = `You are a helpful assistant that answers questions based on provided context.

Guidelines:
- Answer based ONLY on the provided context chunks
- If the context doesn't contain enough information, say so
- Be concise but thorough
- Cite your sources by referring to which chunks you used
- If multiple chunks provide different information, synthesize them
- Maintain a helpful and professional tone`

export function createAnswerGenerator(config: AnswerConfig): AnswerGenerator {
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  const temperature = config.temperature ?? DEFAULT_TEMPERATURE
  const systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT

  function buildContextPrompt(context: AnswerContext): string {
    let prompt = `User Question: ${context.query}\n\n`

    if (context.results.length === 0) {
      prompt += 'No relevant context found.\n'
    } else {
      prompt += 'Relevant Context:\n\n'
      
      context.results.forEach((result, index) => {
        prompt += `--- Chunk ${index + 1} (Source: ${result.source.name}, Relevance: ${(result.score * 100).toFixed(1)}%) ---\n`
        prompt += result.chunk.content
        prompt += '\n\n'
      })
    }

    if (context.conversationHistory && context.conversationHistory.length > 0) {
      prompt += 'Previous Conversation:\n'
      for (const msg of context.conversationHistory.slice(-5)) {
        prompt += `${msg.role}: ${msg.content}\n`
      }
      prompt += '\n'
    }

    prompt += 'Please provide a comprehensive answer based on the context above.'

    return prompt
  }

  function extractSourceReferences(
    answer: string, 
    context: AnswerContext
  ): GeneratedAnswer['sources'] {
    return context.results.map((result, _index) => ({
      sourceId: result.source.id,
      sourceName: result.source.name,
      chunkId: result.chunk.id,
      relevance: result.score,
    }))
  }

  function calculateConfidence(context: AnswerContext): number {
    if (context.results.length === 0) return 0.1

    // Average of top scores, weighted by position
    let weightedSum = 0
    let weightTotal = 0

    context.results.slice(0, 5).forEach((result, index) => {
      const weight = 1 / (index + 1) // 1, 0.5, 0.33, 0.25, 0.2
      weightedSum += result.score * weight
      weightTotal += weight
    })

    return weightTotal > 0 ? weightedSum / weightTotal : 0.1
  }

  async function generate(context: AnswerContext): Promise<GeneratedAnswer> {
    const userPrompt = buildContextPrompt(context)

    const messages = [
      { role: 'user' as const, content: userPrompt },
    ]

    const result = await ai.chat({
      profile: 'fast',
      system: systemPrompt,
      messages,
      maxTokens,
      temperature,
      feature: 'knowledge-answer-generator',
    })

    const answer = result.content ?? ''
    const tokensUsed = (result.usage?.promptTokens || 0) + (result.usage?.completionTokens || 0)

    return {
      answer,
      sources: extractSourceReferences(answer, context),
      confidence: calculateConfidence(context),
      model: result.model || 'ai-service',
      tokensUsed,
    }
  }

  return {
    generate,
    getConfig: () => ({
      apiKey: config.apiKey,
      model: 'ai-service/fast',
      maxTokens,
      temperature,
      systemPrompt,
    }),
  }
}
