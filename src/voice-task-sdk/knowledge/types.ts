/**
 * Knowledge System Type Definitions
 * 
 * Types for the RAG (Retrieval-Augmented Generation) knowledge system
 * that powers query answering from various sources.
 */

// ============================================================================
// EMBEDDING TYPES
// ============================================================================

export interface Embedding {
  vector: number[]
  model: string
  dimensions: number
}

export interface EmbedderConfig {
  apiKey: string
  model?: string
  dimensions?: number
  batchSize?: number
}

export interface Embedder {
  embed: (text: string) => Promise<Embedding>
  embedBatch: (texts: string[]) => Promise<Embedding[]>
  getModel: () => string
  getDimensions: () => number
}

// ============================================================================
// CHUNK TYPES
// ============================================================================

export type ChunkingStrategy = 'fixed' | 'paragraph' | 'sentence' | 'semantic'

export interface Chunk {
  id: string
  content: string
  metadata: ChunkMetadata
  embedding?: Embedding
}

export interface ChunkMetadata {
  sourceId: string
  sourceName: string
  sourceType: string
  position: number
  totalChunks: number
  startChar?: number
  endChar?: number
  [key: string]: unknown
}

export interface ChunkerConfig {
  strategy: ChunkingStrategy
  chunkSize?: number
  chunkOverlap?: number
  minChunkSize?: number
}

export interface Chunker {
  chunk: (text: string, metadata: Partial<ChunkMetadata>) => Chunk[]
  getConfig: () => ChunkerConfig
}

// ============================================================================
// KNOWLEDGE SOURCE TYPES
// ============================================================================

export type KnowledgeSourceType = 'vector' | 'api' | 'document' | 'memory'

export interface KnowledgeSource {
  id: string
  name: string
  type: KnowledgeSourceType
  description?: string
  enabled: boolean
  config: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface KnowledgeSourceInput {
  name: string
  type: KnowledgeSourceType
  description?: string
  config: Record<string, unknown>
}

// ============================================================================
// SEARCH TYPES
// ============================================================================

export interface SearchOptions {
  limit?: number
  minScore?: number
  filter?: Record<string, unknown>
  includeMetadata?: boolean
  sources?: string[]
}

export interface SearchResult {
  chunk: Chunk
  score: number
  source: KnowledgeSource
}

export interface SearchResponse {
  results: SearchResult[]
  query: string
  totalResults: number
  searchTimeMs: number
}

// ============================================================================
// ANSWER GENERATION TYPES
// ============================================================================

export interface AnswerConfig {
  apiKey: string
  model?: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
}

export interface AnswerContext {
  query: string
  results: SearchResult[]
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
  metadata?: Record<string, unknown>
}

export interface GeneratedAnswer {
  answer: string
  sources: Array<{
    sourceId: string
    sourceName: string
    chunkId: string
    relevance: number
  }>
  confidence: number
  model: string
  tokensUsed: number
}

export interface AnswerGenerator {
  generate: (context: AnswerContext) => Promise<GeneratedAnswer>
  getConfig: () => AnswerConfig
}

// ============================================================================
// INGESTION TYPES
// ============================================================================

export interface IngestOptions {
  sourceId: string
  chunkerConfig?: Partial<ChunkerConfig>
  metadata?: Record<string, unknown>
}

export interface IngestResult {
  sourceId: string
  chunksCreated: number
  embeddingsGenerated: number
  errors: Array<{ message: string; chunk?: string }>
  durationMs: number
}

// ============================================================================
// VECTOR STORE TYPES
// ============================================================================

export interface VectorStore {
  add: (chunks: Chunk[]) => Promise<void>
  search: (embedding: Embedding, options?: SearchOptions) => Promise<SearchResult[]>
  delete: (chunkIds: string[]) => Promise<void>
  deleteBySource: (sourceId: string) => Promise<void>
  count: () => Promise<number>
  clear: () => Promise<void>
}

export interface VectorStoreConfig {
  dimensions: number
  metric?: 'cosine' | 'euclidean' | 'dotProduct'
}

// ============================================================================
// KNOWLEDGE STORE TYPES
// ============================================================================

export interface KnowledgeStoreState {
  sources: Map<string, KnowledgeSource>
  
  // CRUD
  addSource: (input: KnowledgeSourceInput) => KnowledgeSource
  getSource: (id: string) => KnowledgeSource | undefined
  updateSource: (id: string, updates: Partial<KnowledgeSourceInput>) => KnowledgeSource | undefined
  deleteSource: (id: string) => boolean
  listSources: (type?: KnowledgeSourceType) => KnowledgeSource[]
  
  // Enable/disable
  enableSource: (id: string) => void
  disableSource: (id: string) => void
}

// ============================================================================
// KNOWLEDGE MANAGER TYPES
// ============================================================================

export interface KnowledgeManagerConfig {
  apiKey: string
  embedder?: Partial<EmbedderConfig>
  chunker?: Partial<ChunkerConfig>
  answer?: Partial<AnswerConfig>
  vectorStore?: VectorStore
}

export interface KnowledgeManager {
  // Sources
  addSource: (input: KnowledgeSourceInput) => KnowledgeSource
  getSource: (id: string) => KnowledgeSource | undefined
  removeSource: (id: string) => boolean
  listSources: () => KnowledgeSource[]
  
  // Ingestion
  ingest: (text: string, options: IngestOptions) => Promise<IngestResult>
  ingestDocument: (url: string, options: IngestOptions) => Promise<IngestResult>
  
  // Search & Answer
  search: (query: string, options?: SearchOptions) => Promise<SearchResponse>
  answer: (query: string, options?: SearchOptions) => Promise<GeneratedAnswer>
  
  // Management
  deleteChunks: (sourceId: string) => Promise<void>
  getStats: () => Promise<{
    totalSources: number
    totalChunks: number
    enabledSources: number
  }>
}
