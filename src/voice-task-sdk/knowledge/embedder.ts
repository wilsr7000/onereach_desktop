/**
 * Embedder - Vector embedding generation via unified ai-service
 * 
 * Generates vector embeddings from text using the centralized AI service.
 * Supports automatic provider fallback, retry, and cost tracking.
 * 
 * Note: config.apiKey is accepted for backward compatibility but no longer
 * used directly -- ai-service manages API keys via settingsManager.
 */

import type { Embedding, Embedder, EmbedderConfig } from './types'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ai = require('../../../lib/ai-service')

const DEFAULT_MODEL = 'text-embedding-3-small'
const DEFAULT_DIMENSIONS = 1536
const DEFAULT_BATCH_SIZE = 100

export function createEmbedder(config: EmbedderConfig): Embedder {
  const model = config.model ?? DEFAULT_MODEL
  const dimensions = config.dimensions ?? DEFAULT_DIMENSIONS
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE

  async function callEmbedService(texts: string[]): Promise<number[][]> {
    const result = await ai.embed(texts, {
      feature: 'knowledge-embedder',
    })
    return result.embeddings
  }

  async function embed(text: string): Promise<Embedding> {
    const [vector] = await callEmbedService([text])
    return {
      vector,
      model,
      dimensions,
    }
  }

  async function embedBatch(texts: string[]): Promise<Embedding[]> {
    if (texts.length === 0) return []

    const results: Embedding[] = []

    // Process in batches
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize)
      const vectors = await callEmbedService(batch)
      
      for (const vector of vectors) {
        results.push({
          vector,
          model,
          dimensions,
        })
      }
    }

    return results
  }

  return {
    embed,
    embedBatch,
    getModel: () => model,
    getDimensions: () => dimensions,
  }
}
