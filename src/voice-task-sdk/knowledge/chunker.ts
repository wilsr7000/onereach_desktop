/**
 * Chunker - Document chunking algorithms
 * 
 * Splits text into chunks for embedding and retrieval.
 * Supports multiple strategies: fixed, paragraph, sentence, semantic.
 */

import type { Chunk, ChunkMetadata, Chunker, ChunkerConfig } from './types'

const DEFAULT_CHUNK_SIZE = 1000
const DEFAULT_CHUNK_OVERLAP = 200
const DEFAULT_MIN_CHUNK_SIZE = 100

function generateId(): string {
  return crypto.randomUUID()
}

// ============================================================================
// CHUNKING STRATEGIES
// ============================================================================

function chunkFixed(
  text: string, 
  chunkSize: number, 
  overlap: number,
  minSize: number
): string[] {
  const chunks: string[] = []
  let start = 0

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length)
    let chunk = text.slice(start, end)

    // Try to break at word boundary
    if (end < text.length) {
      const lastSpace = chunk.lastIndexOf(' ')
      if (lastSpace > chunkSize * 0.5) {
        chunk = chunk.slice(0, lastSpace)
      }
    }

    chunk = chunk.trim()
    if (chunk.length >= minSize) {
      chunks.push(chunk)
    }

    // If we've reached the end of text, stop
    if (end >= text.length) break

    // Move forward by (chunkSize - overlap) but ensure we always make progress
    const stepSize = Math.max(chunkSize - overlap, Math.floor(chunkSize * 0.25), 1)
    start = start + stepSize
  }

  return chunks
}

function chunkParagraph(text: string, minSize: number): string[] {
  const paragraphs = text.split(/\n\n+/)
  const chunks: string[] = []
  let currentChunk = ''

  for (const para of paragraphs) {
    const trimmed = para.trim()
    if (!trimmed) continue

    if (currentChunk && (currentChunk.length + trimmed.length) > DEFAULT_CHUNK_SIZE * 1.5) {
      // Current chunk is large enough, save it
      if (currentChunk.length >= minSize) {
        chunks.push(currentChunk)
      }
      currentChunk = trimmed
    } else {
      // Add paragraph to current chunk
      currentChunk = currentChunk ? `${currentChunk}\n\n${trimmed}` : trimmed
    }
  }

  // Don't forget the last chunk
  if (currentChunk.length >= minSize) {
    chunks.push(currentChunk)
  }

  return chunks
}

function chunkSentence(text: string, chunkSize: number, minSize: number): string[] {
  // Split by sentence boundaries
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text]
  const chunks: string[] = []
  let currentChunk = ''

  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    if (!trimmed) continue

    if (currentChunk && (currentChunk.length + trimmed.length) > chunkSize) {
      if (currentChunk.length >= minSize) {
        chunks.push(currentChunk)
      }
      currentChunk = trimmed
    } else {
      currentChunk = currentChunk ? `${currentChunk} ${trimmed}` : trimmed
    }
  }

  if (currentChunk.length >= minSize) {
    chunks.push(currentChunk)
  }

  return chunks
}

function chunkSemantic(text: string, chunkSize: number, minSize: number): string[] {
  // Semantic chunking: split by headers, sections, and natural breaks
  const sections = text.split(/(?=^#{1,6}\s|\n---+\n|\n===+\n)/m)
  const chunks: string[] = []

  for (const section of sections) {
    const trimmed = section.trim()
    if (!trimmed) continue

    if (trimmed.length <= chunkSize) {
      if (trimmed.length >= minSize) {
        chunks.push(trimmed)
      }
    } else {
      // Section too large, fall back to paragraph chunking
      const subChunks = chunkParagraph(trimmed, minSize)
      chunks.push(...subChunks)
    }
  }

  return chunks
}

// ============================================================================
// CREATE CHUNKER
// ============================================================================

export function createChunker(config: ChunkerConfig): Chunker {
  const chunkSize = config.chunkSize ?? DEFAULT_CHUNK_SIZE
  const chunkOverlap = config.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP
  const minChunkSize = config.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE

  function chunk(text: string, metadata: Partial<ChunkMetadata>): Chunk[] {
    let textChunks: string[]

    switch (config.strategy) {
      case 'fixed':
        textChunks = chunkFixed(text, chunkSize, chunkOverlap, minChunkSize)
        break
      case 'paragraph':
        textChunks = chunkParagraph(text, minChunkSize)
        break
      case 'sentence':
        textChunks = chunkSentence(text, chunkSize, minChunkSize)
        break
      case 'semantic':
        textChunks = chunkSemantic(text, chunkSize, minChunkSize)
        break
      default:
        textChunks = chunkFixed(text, chunkSize, chunkOverlap, minChunkSize)
    }

    const totalChunks = textChunks.length
    let charPosition = 0

    return textChunks.map((content, index) => {
      const startChar = text.indexOf(content, charPosition)
      const endChar = startChar + content.length
      charPosition = startChar + 1 // Move forward to find next occurrence

      return {
        id: generateId(),
        content,
        metadata: {
          sourceId: metadata.sourceId ?? '',
          sourceName: metadata.sourceName ?? '',
          sourceType: metadata.sourceType ?? '',
          position: index,
          totalChunks,
          startChar: startChar >= 0 ? startChar : undefined,
          endChar: startChar >= 0 ? endChar : undefined,
          ...metadata,
        },
      }
    })
  }

  return {
    chunk,
    getConfig: () => ({
      strategy: config.strategy,
      chunkSize,
      chunkOverlap,
      minChunkSize,
    }),
  }
}
