/**
 * Knowledge System Exports
 */

// Types
export type {
  Embedding,
  EmbedderConfig,
  Embedder,
  ChunkingStrategy,
  Chunk,
  ChunkMetadata,
  ChunkerConfig,
  Chunker,
  KnowledgeSourceType,
  KnowledgeSource,
  KnowledgeSourceInput,
  SearchOptions,
  SearchResult,
  SearchResponse,
  AnswerConfig,
  AnswerContext,
  GeneratedAnswer,
  AnswerGenerator,
  IngestOptions,
  IngestResult,
  VectorStore,
  VectorStoreConfig,
  KnowledgeStoreState,
  KnowledgeManagerConfig,
  KnowledgeManager,
} from './types'

// Core components
export { createKnowledgeStore } from './knowledgeStore'
export { createEmbedder } from './embedder'
export { createChunker } from './chunker'
export { createAnswerGenerator } from './answerGenerator'
export { createMemoryVectorStore, vectorMath } from './memorySource'
export { createKnowledgeManager } from './knowledgeManager'
