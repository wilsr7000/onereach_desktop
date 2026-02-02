/**
 * Memory Source - In-memory vector store
 * 
 * A simple in-memory vector store for development and testing.
 * Uses cosine similarity for vector search.
 */

import type { 
  Chunk, 
  Embedding, 
  KnowledgeSource, 
  SearchOptions, 
  SearchResult, 
  VectorStore, 
  VectorStoreConfig 
} from './types'

// ============================================================================
// VECTOR MATH UTILITIES
// ============================================================================

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`)
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB)
  if (magnitude === 0) return 0

  return dotProduct / magnitude
}

function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`)
  }

  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i]
    sum += diff * diff
  }

  // Return similarity (1 / (1 + distance)) so higher is better
  return 1 / (1 + Math.sqrt(sum))
}

function dotProduct(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`)
  }

  let sum = 0
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i]
  }

  return sum
}

// ============================================================================
// STORED CHUNK TYPE
// ============================================================================

interface StoredChunk {
  chunk: Chunk
  source: KnowledgeSource
}

// ============================================================================
// CREATE MEMORY VECTOR STORE
// ============================================================================

export function createMemoryVectorStore(config: VectorStoreConfig): VectorStore {
  const chunks = new Map<string, StoredChunk>()
  const metric = config.metric ?? 'cosine'

  function getSimilarity(a: number[], b: number[]): number {
    switch (metric) {
      case 'cosine':
        return cosineSimilarity(a, b)
      case 'euclidean':
        return euclideanDistance(a, b)
      case 'dotProduct':
        return dotProduct(a, b)
      default:
        return cosineSimilarity(a, b)
    }
  }

  async function add(newChunks: Chunk[], source?: KnowledgeSource): Promise<void> {
    for (const chunk of newChunks) {
      if (!chunk.embedding) {
        throw new Error(`Chunk ${chunk.id} has no embedding`)
      }

      if (chunk.embedding.dimensions !== config.dimensions) {
        throw new Error(
          `Embedding dimension mismatch: expected ${config.dimensions}, got ${chunk.embedding.dimensions}`
        )
      }

      const knowledgeSource: KnowledgeSource = source ?? {
        id: chunk.metadata.sourceId,
        name: chunk.metadata.sourceName,
        type: chunk.metadata.sourceType as 'memory',
        enabled: true,
        config: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      chunks.set(chunk.id, { chunk, source: knowledgeSource })
    }
  }

  async function search(embedding: Embedding, options?: SearchOptions): Promise<SearchResult[]> {
    const limit = options?.limit ?? 10
    const minScore = options?.minScore ?? 0.0
    const sourceFilter = options?.sources

    const results: SearchResult[] = []

    for (const stored of chunks.values()) {
      // Filter by source if specified
      if (sourceFilter && !sourceFilter.includes(stored.source.id)) {
        continue
      }

      // Skip disabled sources
      if (!stored.source.enabled) {
        continue
      }

      // Must have embedding
      if (!stored.chunk.embedding) continue

      const score = getSimilarity(embedding.vector, stored.chunk.embedding.vector)

      if (score >= minScore) {
        results.push({
          chunk: stored.chunk,
          score,
          source: stored.source,
        })
      }
    }

    // Sort by score descending and limit
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  async function deleteChunks(chunkIds: string[]): Promise<void> {
    for (const id of chunkIds) {
      chunks.delete(id)
    }
  }

  async function deleteBySource(sourceId: string): Promise<void> {
    for (const [id, stored] of chunks.entries()) {
      if (stored.chunk.metadata.sourceId === sourceId) {
        chunks.delete(id)
      }
    }
  }

  async function count(): Promise<number> {
    return chunks.size
  }

  async function clear(): Promise<void> {
    chunks.clear()
  }

  return {
    add: (newChunks: Chunk[]) => add(newChunks),
    search,
    delete: deleteChunks,
    deleteBySource,
    count,
    clear,
  }
}

// Export utility functions for testing
export const vectorMath = {
  cosineSimilarity,
  euclideanDistance,
  dotProduct,
}
