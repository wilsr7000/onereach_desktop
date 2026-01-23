/**
 * Knowledge Manager - Main orchestrator for the knowledge system
 * 
 * Combines knowledge sources, embeddings, chunking, and answer generation
 * into a unified RAG (Retrieval-Augmented Generation) interface.
 */

import type {
  Chunk,
  GeneratedAnswer,
  IngestOptions,
  IngestResult,
  KnowledgeManager,
  KnowledgeManagerConfig,
  KnowledgeSource,
  KnowledgeSourceInput,
  SearchOptions,
  SearchResponse,
  VectorStore,
} from './types'

import { createKnowledgeStore } from './knowledgeStore'
import { createEmbedder } from './embedder'
import { createChunker } from './chunker'
import { createAnswerGenerator } from './answerGenerator'
import { createMemoryVectorStore } from './memorySource'

export function createKnowledgeManager(config: KnowledgeManagerConfig): KnowledgeManager {
  // Initialize components
  const store = createKnowledgeStore()
  
  const embedder = createEmbedder({
    apiKey: config.apiKey,
    ...config.embedder,
  })

  const chunker = createChunker({
    strategy: config.chunker?.strategy ?? 'paragraph',
    ...config.chunker,
  })

  const answerGen = createAnswerGenerator({
    apiKey: config.apiKey,
    ...config.answer,
  })

  // Use provided vector store or create in-memory one
  const vectorStore: VectorStore = config.vectorStore ?? createMemoryVectorStore({
    dimensions: embedder.getDimensions(),
    metric: 'cosine',
  })

  // ========================================================================
  // SOURCE MANAGEMENT
  // ========================================================================

  function addSource(input: KnowledgeSourceInput): KnowledgeSource {
    return store.getState().addSource(input)
  }

  function getSource(id: string): KnowledgeSource | undefined {
    return store.getState().getSource(id)
  }

  function removeSource(id: string): boolean {
    return store.getState().deleteSource(id)
  }

  function listSources(): KnowledgeSource[] {
    return store.getState().listSources()
  }

  // ========================================================================
  // INGESTION
  // ========================================================================

  async function ingest(text: string, options: IngestOptions): Promise<IngestResult> {
    const startTime = Date.now()
    const errors: IngestResult['errors'] = []

    const source = getSource(options.sourceId)
    if (!source) {
      throw new Error(`Source not found: ${options.sourceId}`)
    }

    // Chunk the text
    const chunks = chunker.chunk(text, {
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      ...options.metadata,
    })

    // Generate embeddings
    const embeddedChunks: Chunk[] = []
    
    try {
      const embeddings = await embedder.embedBatch(chunks.map(c => c.content))
      
      for (let i = 0; i < chunks.length; i++) {
        embeddedChunks.push({
          ...chunks[i],
          embedding: embeddings[i],
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown embedding error'
      errors.push({ message })
      return {
        sourceId: options.sourceId,
        chunksCreated: 0,
        embeddingsGenerated: 0,
        errors,
        durationMs: Date.now() - startTime,
      }
    }

    // Store in vector database
    await vectorStore.add(embeddedChunks)

    return {
      sourceId: options.sourceId,
      chunksCreated: chunks.length,
      embeddingsGenerated: embeddedChunks.length,
      errors,
      durationMs: Date.now() - startTime,
    }
  }

  async function ingestDocument(url: string, options: IngestOptions): Promise<IngestResult> {
    const startTime = Date.now()

    try {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Failed to fetch document: ${response.status} ${response.statusText}`)
      }

      const text = await response.text()
      return ingest(text, options)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown fetch error'
      return {
        sourceId: options.sourceId,
        chunksCreated: 0,
        embeddingsGenerated: 0,
        errors: [{ message }],
        durationMs: Date.now() - startTime,
      }
    }
  }

  // ========================================================================
  // SEARCH & ANSWER
  // ========================================================================

  async function search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    const startTime = Date.now()

    // Get enabled sources if not filtered
    let sourceIds = options?.sources
    if (!sourceIds) {
      const enabledSources = listSources().filter(s => s.enabled)
      sourceIds = enabledSources.map(s => s.id)
    }

    // Generate query embedding
    const queryEmbedding = await embedder.embed(query)

    // Search vector store
    const results = await vectorStore.search(queryEmbedding, {
      ...options,
      sources: sourceIds,
    })

    return {
      results,
      query,
      totalResults: results.length,
      searchTimeMs: Date.now() - startTime,
    }
  }

  async function answer(query: string, options?: SearchOptions): Promise<GeneratedAnswer> {
    // First search for relevant chunks
    const searchResponse = await search(query, options)

    // Generate answer from results
    return answerGen.generate({
      query,
      results: searchResponse.results,
    })
  }

  // ========================================================================
  // MANAGEMENT
  // ========================================================================

  async function deleteChunks(sourceId: string): Promise<void> {
    await vectorStore.deleteBySource(sourceId)
  }

  async function getStats(): Promise<{
    totalSources: number
    totalChunks: number
    enabledSources: number
  }> {
    const sources = listSources()
    const totalChunks = await vectorStore.count()

    return {
      totalSources: sources.length,
      totalChunks,
      enabledSources: sources.filter(s => s.enabled).length,
    }
  }

  return {
    // Sources
    addSource,
    getSource,
    removeSource,
    listSources,

    // Ingestion
    ingest,
    ingestDocument,

    // Search & Answer
    search,
    answer,

    // Management
    deleteChunks,
    getStats,
  }
}
