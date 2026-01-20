/**
 * Embedder - OpenAI embedding generation
 * 
 * Generates vector embeddings from text using OpenAI's embedding API.
 */

import type { Embedding, Embedder, EmbedderConfig } from './types'

const DEFAULT_MODEL = 'text-embedding-3-small'
const DEFAULT_DIMENSIONS = 1536
const DEFAULT_BATCH_SIZE = 100

export function createEmbedder(config: EmbedderConfig): Embedder {
  const model = config.model ?? DEFAULT_MODEL
  const dimensions = config.dimensions ?? DEFAULT_DIMENSIONS
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE

  async function callOpenAI(texts: string[]): Promise<number[][]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: texts,
        dimensions,
      }),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(`OpenAI API error: ${response.status} ${error.error?.message || response.statusText}`)
    }

    const data = await response.json()
    
    // Sort by index to maintain order
    const sorted = data.data.sort((a: { index: number }, b: { index: number }) => a.index - b.index)
    return sorted.map((item: { embedding: number[] }) => item.embedding)
  }

  async function embed(text: string): Promise<Embedding> {
    const [vector] = await callOpenAI([text])
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
      const vectors = await callOpenAI(batch)
      
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
