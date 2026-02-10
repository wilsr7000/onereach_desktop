/**
 * Documentation Agent - RAG-Grounded App Documentation Assistant
 * 
 * Answers questions about app features, setup, and usage by searching official
 * documentation. Uses Retrieval-Augmented Generation (RAG) to stay grounded
 * on actual docs and prevent hallucination.
 * 
 * Architecture:
 * 1. On initialize(), reads all key documentation markdown files
 * 2. Chunks each file by section headers (h1/h2/h3 boundaries)
 * 3. Generates embeddings for every chunk via ai.embed()
 * 4. On execute(), embeds the user query, finds top-k chunks by cosine
 *    similarity, and generates a grounded answer with source citations
 * 
 * Anti-hallucination:
 * - System prompt explicitly forbids fabricating answers
 * - If no relevant chunks are found (low similarity), the agent refuses
 *   gracefully instead of guessing
 * - Confidence score is returned with every answer
 */

const fs = require('fs');
const path = require('path');
const { getAgentMemory } = require('../../lib/agent-memory-store');
const { learnFromInteraction } = require('../../lib/thinking-agent');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// ==================== CONFIGURATION ====================

/** Documentation files to ingest (relative to project root) */
const DOC_FILES = [
  'README.md',
  'APP-FEATURES.md',
  'TOOL-APP-SPACES-API-GUIDE.md',
  'LOGGING-API.md',
  'CONVERSION-API.md',
  'packages/agents/APP-AGENT-GUIDE.md',
  'packages/agents/VOICE-GUIDE.md',
  'VIDEO_EDITOR_QUICK_START.md',
  'ADR_QUICK_START.md',
  'SPACES-UPLOAD-QUICK-START.md',
  'SETUP_ELEVENLABS.md',
];

/** Maximum characters per chunk (prevents oversized embedding inputs) */
const MAX_CHUNK_SIZE = 2000;

/** Minimum chunk length to bother embedding */
const MIN_CHUNK_SIZE = 50;

/** Number of top chunks to retrieve for answer generation */
const TOP_K = 5;

/** Minimum cosine similarity to consider a chunk relevant */
const MIN_SIMILARITY = 0.25;

/** System prompt that prevents hallucination */
const ANSWER_SYSTEM_PROMPT = `You are a documentation assistant for the GSX Power User desktop app. Answer ONLY from the provided context excerpts.

Rules:
1. If the context contains the answer, provide it clearly and cite the source document in parentheses, e.g. (from README.md).
2. If the context does NOT contain the answer, respond exactly: "I don't have documentation about that. You might find the answer in the app's Help menu or by asking the Search Agent."
3. NEVER make up features, commands, keyboard shortcuts, or capabilities not mentioned in the context.
4. Quote specific steps, commands, or shortcuts directly from the documentation when available.
5. Keep answers concise -- 2-4 sentences for simple questions, more for how-to guides.
6. If multiple documents mention the topic, synthesize them but cite each source.`;

// ==================== VECTOR MATH ====================

/**
 * Compute cosine similarity between two vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} Similarity in range [-1, 1]
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ==================== CHUNKING ====================

/**
 * Split markdown text into chunks by section headers (h1/h2/h3).
 * Each chunk keeps its header for context.
 * @param {string} text - Raw markdown content
 * @param {string} sourceFile - Filename for attribution
 * @returns {Array<{id: string, content: string, source: string, header: string}>}
 */
function chunkBySection(text, sourceFile) {
  // Split on markdown headers (lines starting with #, ##, or ###)
  const sections = text.split(/^(?=#{1,3}\s)/m);

  return sections
    .filter(s => s.trim().length >= MIN_CHUNK_SIZE)
    .map((content, i) => {
      const trimmed = content.trim();
      return {
        id: `${sourceFile}-${i}`,
        content: trimmed.slice(0, MAX_CHUNK_SIZE),
        source: sourceFile,
        header: trimmed.match(/^#{1,3}\s+(.+)/m)?.[1] || 'Introduction',
      };
    });
}

// ==================== AGENT DEFINITION ====================

const docsAgent = {
  id: 'docs-agent',
  name: 'Documentation Agent',
  description: 'Answers questions about app features, setup, and usage from official documentation. Uses RAG to retrieve relevant doc sections and generate grounded answers.',
  voice: 'alloy', // Neutral, helpful
  categories: ['system', 'help', 'documentation'],
  keywords: [
    'docs', 'documentation', 'how to', 'guide', 'setup', 'tutorial',
    'help', 'manual', 'reference', 'features', 'getting started',
    'keyboard shortcut', 'where is', 'how do i', 'what is',
  ],
  executionType: 'informational', // No side effects -- can fast-path in bid

  prompt: `Documentation Agent answers questions about the GSX Power User app using official documentation.

HIGH CONFIDENCE (0.85+) - BID when the user:
- Asks HOW TO do something in the app: "How do I export a video?", "How do I create a space?"
- Asks about a FEATURE: "What is Smart Export?", "Tell me about the Video Editor"
- Asks for SETUP HELP: "How do I set up ElevenLabs?", "Getting started guide"
- Asks about KEYBOARD SHORTCUTS: "What shortcut opens settings?"
- Asks about APP CAPABILITIES: "What can this app do?", "What formats can I export to?"
- Needs a GUIDE or WALKTHROUGH: "Walk me through recording a video"
- Asks about API DOCUMENTATION: "How does the Spaces API work?", "What endpoints are available?"

This agent ONLY answers from official app documentation. It does NOT search the web, access external information, or make up answers.

MEDIUM CONFIDENCE (0.50-0.70) -- defer to more specific agents:
- Generic "What can you do?" or "What features does this app have?" → Help Agent handles general capability listings
- Only bid 0.85+ on docs when the user asks about a SPECIFIC feature by name

LOW CONFIDENCE (0.00-0.20) - DO NOT BID:
- Current time/weather: "What time is it?" (time agent)
- General help: "Help me" / "What can you do?" (help agent)  
- Web search: "Tell me about quantum computing" (search agent)
- Greetings: "Hello" (smalltalk agent)
- Media control: "Play music" (DJ agent)
- Calendar queries: "What do I have today?" (calendar agent)`,

  // ==================== STATE ====================
  memory: null,
  /** @type {Array<{id: string, content: string, source: string, header: string, embedding: number[]}>} */
  _chunks: [],
  _initialized: false,
  _initializing: null, // Promise guard to prevent double init

  // ==================== INITIALIZATION ====================

  /**
   * Initialize: read docs, chunk, embed, and store in memory.
   * Uses a promise guard so concurrent calls wait for the first init.
   */
  async initialize() {
    if (this._initialized) return;
    if (this._initializing) return this._initializing;

    this._initializing = this._doInitialize();
    await this._initializing;
    this._initializing = null;
  },

  async _doInitialize() {
    const startTime = Date.now();
    log.info('agent', '[DocsAgent] Initializing -- reading documentation files');

    // Resolve project root (two levels up from packages/agents/)
    const projectRoot = path.resolve(__dirname, '../../');

    // 1. Read all documentation files
    const allChunks = [];
    for (const docFile of DOC_FILES) {
      const filePath = path.join(projectRoot, docFile);
      try {
        if (!fs.existsSync(filePath)) {
          log.info('agent', `[DocsAgent] Skipping missing file: ${docFile}`);
          continue;
        }
        const text = fs.readFileSync(filePath, 'utf-8');
        const chunks = chunkBySection(text, docFile);
        allChunks.push(...chunks);
        log.info('agent', `[DocsAgent] Chunked ${docFile}: ${chunks.length} sections`);
      } catch (err) {
        log.error('agent', `[DocsAgent] Error reading ${docFile}`, { error: err.message });
      }
    }

    if (allChunks.length === 0) {
      log.error('agent', '[DocsAgent] No documentation chunks created -- agent will be limited');
      this._chunks = [];
      this._initialized = true;
      return;
    }

    // 2. Generate embeddings in batches
    log.info('agent', `[DocsAgent] Embedding ${allChunks.length} chunks...`);
    const BATCH_SIZE = 50;
    const embeddedChunks = [];

    for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
      const batch = allChunks.slice(i, i + BATCH_SIZE);
      const texts = batch.map(c => c.content);

      try {
        const result = await ai.embed(texts, {
          feature: 'docs-agent-ingest',
        });

        // ai.embed returns { embeddings: number[][] } or number[][]
        const embeddings = result.embeddings || result;

        for (let j = 0; j < batch.length; j++) {
          embeddedChunks.push({
            ...batch[j],
            embedding: embeddings[j],
          });
        }
      } catch (err) {
        log.error('agent', `[DocsAgent] Embedding batch failed (offset ${i})`, { error: err.message });
        // Still add chunks without embeddings -- they won't match but won't crash
        for (const chunk of batch) {
          embeddedChunks.push({ ...chunk, embedding: null });
        }
      }
    }

    this._chunks = embeddedChunks;
    this._initialized = true;

    const elapsed = Date.now() - startTime;
    const withEmbeddings = embeddedChunks.filter(c => c.embedding).length;
    log.info('agent', `[DocsAgent] Ready: ${withEmbeddings}/${embeddedChunks.length} chunks embedded in ${elapsed}ms`);

    // Initialize memory for tracking
    if (!this.memory) {
      this.memory = getAgentMemory('docs-agent', { displayName: 'Documentation Agent' });
      await this.memory.load();
      this._ensureMemorySections();
    }
  },

  /**
   * Ensure required memory sections exist
   */
  _ensureMemorySections() {
    const sections = this.memory.getSectionNames();

    if (!sections.includes('Stats')) {
      this.memory.updateSection('Stats', `- Chunks Loaded: ${this._chunks.length}
- Documents: ${DOC_FILES.length}
- Last Initialized: ${new Date().toISOString()}`);
    }

    if (!sections.includes('Recent Questions')) {
      this.memory.updateSection('Recent Questions', '*Questions you have asked will appear here*');
    }

    if (this.memory.isDirty()) {
      this.memory.save();
    }
  },

  // No bid() method. Routing is 100% LLM-based via unified-bidder.js.
  // NEVER add keyword/regex bidding here. See .cursorrules.

  // ==================== EXECUTION ====================

  /**
   * Execute the task: embed query, retrieve top-k chunks, generate answer.
   * @param {Object} task - { content, context, ... }
   * @param {Object} context - { onProgress, ... }
   * @returns {Object} - { success, message, metadata }
   */
  async execute(task, context = {}) {
    // Ensure initialized (lazy init on first call)
    if (!this._initialized) {
      await this.initialize();
    }

    const query = task.content;
    const { onProgress = () => {} } = context;

    log.info('agent', `[DocsAgent] Query: "${query.slice(0, 80)}"`);

    // Track in memory
    try {
      const timestamp = new Date().toISOString().split('T')[0];
      this.memory.appendToSection('Recent Questions', `- ${timestamp}: "${query.slice(0, 60)}"`, 20);
      await this.memory.save();
    } catch (e) {
      // Non-fatal
    }

    try {
      // Step 1: Embed the query
      onProgress('Searching documentation...');
      const queryResult = await ai.embed(query, { feature: 'docs-agent-query' });
      const queryEmbedding = queryResult.embeddings ? queryResult.embeddings[0] : queryResult[0] || queryResult;

      if (!queryEmbedding || !Array.isArray(queryEmbedding)) {
        log.error('agent', '[DocsAgent] Failed to embed query');
        return {
          success: false,
          message: "I'm having trouble searching the documentation right now. Please try again.",
        };
      }

      // Step 2: Find top-k similar chunks
      const scored = this._chunks
        .filter(c => c.embedding) // Only chunks with embeddings
        .map(c => ({
          ...c,
          score: cosineSimilarity(queryEmbedding, c.embedding),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, TOP_K);

      // Step 3: Check if any chunks are relevant enough
      const relevant = scored.filter(c => c.score >= MIN_SIMILARITY);

      if (relevant.length === 0) {
        log.info('agent', '[DocsAgent] No relevant chunks found -- refusing to answer');
        return {
          success: true,
          message: "I don't have documentation about that. You might find the answer in the app's Help menu or by asking the Search Agent.",
          metadata: {
            sources: [],
            confidence: 0,
            topScore: scored.length > 0 ? scored[0].score : 0,
          },
        };
      }

      // Step 4: Build context and generate answer
      onProgress('Generating answer from documentation...');
      const contextExcerpts = relevant.map((c, i) =>
        `[Source ${i + 1}: ${c.source} -- "${c.header}"] (relevance: ${(c.score * 100).toFixed(0)}%)\n${c.content}`
      ).join('\n\n---\n\n');

      const userPrompt = `Question: ${query}

Context excerpts from documentation:
${contextExcerpts}

Answer the question using ONLY the context excerpts above.`;

      const result = await ai.chat({
        profile: 'fast',
        system: ANSWER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: 512,
        temperature: 0.2, // Low temperature for factual answers
        feature: 'docs-agent-answer',
      });

      const answer = result.content || result.text || '';

      // Calculate confidence as weighted average of top chunk scores
      const totalWeight = relevant.reduce((sum, _, i) => sum + (TOP_K - i), 0);
      const weightedScore = relevant.reduce((sum, c, i) => sum + c.score * (TOP_K - i), 0);
      const confidence = totalWeight > 0 ? weightedScore / totalWeight : 0;

      const sources = relevant.map(c => ({
        file: c.source,
        section: c.header,
        relevance: parseFloat(c.score.toFixed(3)),
      }));

      log.info('agent', `[DocsAgent] Answered with confidence ${confidence.toFixed(2)} from ${sources.length} sources`);

      // Learn from interaction
      try {
        await learnFromInteraction(this.memory, task, { success: true, message: answer }, {});
      } catch (e) {
        // Non-fatal
      }

      return {
        success: true,
        message: answer,
        metadata: {
          sources,
          confidence: parseFloat(confidence.toFixed(3)),
        },
      };

    } catch (error) {
      log.error('agent', '[DocsAgent] Error during execute', { error: error.message });
      return {
        success: false,
        message: "I had trouble searching the documentation. Please try again.",
      };
    }
  },

  // ==================== UTILITY METHODS ====================

  /**
   * Get stats about the loaded documentation.
   * Useful for debugging and testing.
   * @returns {{ totalChunks: number, withEmbeddings: number, documents: string[] }}
   */
  getStats() {
    return {
      totalChunks: this._chunks.length,
      withEmbeddings: this._chunks.filter(c => c.embedding).length,
      documents: [...new Set(this._chunks.map(c => c.source))],
      initialized: this._initialized,
    };
  },

  /**
   * Search chunks by similarity without generating an answer.
   * Useful for testing retrieval quality.
   * @param {string} query
   * @param {number} [topK=5]
   * @returns {Promise<Array<{source: string, header: string, score: number, content: string}>>}
   */
  async searchChunks(query, topK = TOP_K) {
    if (!this._initialized) await this.initialize();

    const queryResult = await ai.embed(query, { feature: 'docs-agent-search' });
    const queryEmbedding = queryResult.embeddings ? queryResult.embeddings[0] : queryResult[0] || queryResult;

    if (!queryEmbedding || !Array.isArray(queryEmbedding)) return [];

    return this._chunks
      .filter(c => c.embedding)
      .map(c => ({
        source: c.source,
        header: c.header,
        score: cosineSimilarity(queryEmbedding, c.embedding),
        content: c.content.slice(0, 300),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  },
};

module.exports = docsAgent;
