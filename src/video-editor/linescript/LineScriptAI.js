/**
 * LineScriptAI.js - Progressive AI Metadata Generation
 * 
 * Features:
 * - Smart chunking based on speaker changes, pauses, topics
 * - Optimal snapshot selection avoiding motion blur
 * - GPT Vision integration for visual analysis
 * - Progressive processing with user approval
 * - Template-aware prompts
 */

import { getAIPrompts, getTemplate } from './ContentTemplates.js';

/**
 * Chunking configuration
 */
const CHUNK_CONFIG = {
  minDuration: 10,      // Minimum chunk duration in seconds
  maxDuration: 60,      // Maximum chunk duration in seconds
  minWords: 20,         // Minimum words per chunk
  maxWords: 200,        // Maximum words per chunk
  pauseThreshold: 1.5,  // Pause duration to consider for chunk break
  speakerChangeWeight: 0.8, // Weight for speaker change as chunk break
  sentenceEndWeight: 0.5,   // Weight for sentence end as chunk break
};

/**
 * Snapshot selection configuration
 */
const SNAPSHOT_CONFIG = {
  analysisWindow: 2,     // Seconds around target time to analyze
  motionThreshold: 0.1,  // Motion threshold for blur detection
  preferredOffset: 0.5,  // Preferred offset from start of chunk
  fallbackIntervals: [0.25, 0.5, 0.75, 1.0], // Fallback positions within chunk
};

/**
 * LineScriptAI - Progressive AI Metadata Generation
 */
export class LineScriptAI {
  constructor(appContext, lineScriptPanel) {
    this.app = appContext;
    this.panel = lineScriptPanel;
    
    // Processing state
    this.isProcessing = false;
    this.isPaused = false;
    this.isCancelled = false;
    
    // Chunk queue
    this.chunks = [];
    this.currentChunkIndex = 0;
    this.processedChunks = [];
    
    // Results
    this.results = [];
    
    // Event listeners
    this.eventListeners = {};
    
    // Template reference
    this.templateId = 'podcast';
  }

  /**
   * Set the template for AI prompts
   * @param {string} templateId - Template ID
   */
  setTemplate(templateId) {
    this.templateId = templateId;
  }

  /**
   * Analyze transcript and break into logical chunks
   * @param {Array} transcriptSegments - Transcript segments with timing
   * @param {Array} words - Individual words with timing
   * @returns {Array} Chunks for processing
   */
  async analyzeAndChunk(transcriptSegments, words) {
    this.chunks = [];
    
    if (!words || words.length === 0) {
      return this.chunks;
    }
    
    let currentChunk = {
      startTime: words[0].start,
      endTime: words[0].end,
      words: [],
      text: '',
      speaker: null,
      sentenceCount: 0
    };
    
    let chunkId = 1;
    
    words.forEach((word, idx) => {
      const prevWord = words[idx - 1];
      const nextWord = words[idx + 1];
      
      // Calculate break score
      let breakScore = 0;
      
      // Check for speaker change
      if (prevWord && word.speaker && word.speaker !== prevWord.speaker) {
        breakScore += CHUNK_CONFIG.speakerChangeWeight;
      }
      
      // Check for pause
      if (prevWord) {
        const pause = word.start - prevWord.end;
        if (pause > CHUNK_CONFIG.pauseThreshold) {
          breakScore += 0.6;
        }
      }
      
      // Check for sentence end
      if (prevWord && /[.!?]$/.test(prevWord.text)) {
        breakScore += CHUNK_CONFIG.sentenceEndWeight;
        currentChunk.sentenceCount++;
      }
      
      // Check if we should break here
      const chunkDuration = word.end - currentChunk.startTime;
      const shouldBreak = (
        (breakScore >= 0.5 && currentChunk.words.length >= CHUNK_CONFIG.minWords) ||
        (chunkDuration >= CHUNK_CONFIG.maxDuration) ||
        (currentChunk.words.length >= CHUNK_CONFIG.maxWords)
      );
      
      if (shouldBreak && currentChunk.words.length > 0) {
        // Finalize current chunk
        currentChunk.endTime = prevWord?.end || word.start;
        currentChunk.text = currentChunk.words.map(w => w.text).join(' ');
        currentChunk.id = `chunk-${chunkId++}`;
        currentChunk.duration = currentChunk.endTime - currentChunk.startTime;
        
        this.chunks.push(currentChunk);
        
        // Start new chunk
        currentChunk = {
          startTime: word.start,
          endTime: word.end,
          words: [],
          text: '',
          speaker: word.speaker,
          sentenceCount: 0
        };
      }
      
      // Add word to current chunk
      currentChunk.words.push(word);
      currentChunk.endTime = word.end;
      
      // Track speaker
      if (word.speaker) {
        currentChunk.speaker = word.speaker;
      }
    });
    
    // Add final chunk
    if (currentChunk.words.length > 0) {
      currentChunk.text = currentChunk.words.map(w => w.text).join(' ');
      currentChunk.id = `chunk-${chunkId}`;
      currentChunk.duration = currentChunk.endTime - currentChunk.startTime;
      this.chunks.push(currentChunk);
    }
    
    console.log(`[LineScriptAI] Created ${this.chunks.length} chunks from ${words.length} words`);
    
    return this.chunks;
  }

  /**
   * Select optimal snapshot time for a chunk
   * @param {Object} chunk - Chunk object
   * @returns {number} Optimal time for snapshot
   */
  async selectSnapshotTime(chunk) {
    const targetTime = chunk.startTime + (chunk.duration * SNAPSHOT_CONFIG.preferredOffset);
    
    // Try to find a frame with minimal motion
    // In a full implementation, this would analyze frame differences
    // For now, we use a simple heuristic
    
    const intervals = SNAPSHOT_CONFIG.fallbackIntervals;
    let bestTime = targetTime;
    let bestScore = 0;
    
    for (const interval of intervals) {
      const testTime = chunk.startTime + (chunk.duration * interval);
      
      // Simple heuristic: prefer times not during speaker transitions
      // and not at the very start or end
      let score = 1;
      
      // Penalize very start/end
      if (interval < 0.1 || interval > 0.9) {
        score *= 0.5;
      }
      
      // Prefer middle of sentences (not right after punctuation)
      const wordsBeforeTime = chunk.words.filter(w => w.end < testTime);
      if (wordsBeforeTime.length > 0) {
        const lastWord = wordsBeforeTime[wordsBeforeTime.length - 1];
        if (/[.!?]$/.test(lastWord.text)) {
          score *= 0.7;
        }
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestTime = testTime;
      }
    }
    
    return bestTime;
  }

  /**
   * Start progressive processing
   * @returns {Promise} Processing promise
   */
  async startProcessing() {
    if (this.isProcessing) {
      console.warn('[LineScriptAI] Already processing');
      return;
    }
    
    this.isProcessing = true;
    this.isPaused = false;
    this.isCancelled = false;
    this.currentChunkIndex = 0;
    this.results = [];
    
    this.emit('processingStarted', { totalChunks: this.chunks.length });
    
    try {
      while (this.currentChunkIndex < this.chunks.length && !this.isCancelled) {
        // Wait if paused
        if (this.isPaused) {
          await this.waitForResume();
        }
        
        if (this.isCancelled) break;
        
        // Process current chunk
        const chunk = this.chunks[this.currentChunkIndex];
        const result = await this.processChunk(chunk);
        
        // Wait for user approval
        const approved = await this.waitForApproval(result);
        
        if (approved.approved) {
          // Apply any edits from user
          const finalResult = { ...result, ...approved.edits };
          this.results.push(finalResult);
          this.processedChunks.push(chunk.id);
          
          this.emit('chunkApproved', { 
            chunkIndex: this.currentChunkIndex, 
            result: finalResult 
          });
        } else if (approved.regenerate) {
          // Don't advance, will regenerate on next iteration
          continue;
        } else {
          // Skip this chunk
          this.emit('chunkSkipped', { chunkIndex: this.currentChunkIndex });
        }
        
        this.currentChunkIndex++;
        
        this.emit('progress', {
          current: this.currentChunkIndex,
          total: this.chunks.length,
          percentage: (this.currentChunkIndex / this.chunks.length) * 100
        });
      }
      
      this.isProcessing = false;
      this.emit('processingComplete', { results: this.results });
      
      return this.results;
      
    } catch (error) {
      this.isProcessing = false;
      this.emit('processingError', { error });
      throw error;
    }
  }

  /**
   * Process a single chunk
   * @param {Object} chunk - Chunk to process
   * @returns {Object} Processing result
   */
  async processChunk(chunk) {
    this.emit('chunkProcessing', { 
      chunkIndex: this.currentChunkIndex, 
      chunk 
    });
    
    try {
      // Select optimal snapshot time
      const snapshotTime = await this.selectSnapshotTime(chunk);
      
      // Capture frame
      let frameBase64 = null;
      if (window.videoEditor?.captureFrameAtTime) {
        try {
          frameBase64 = await window.videoEditor.captureFrameAtTime(snapshotTime);
        } catch (e) {
          console.warn('[LineScriptAI] Failed to capture frame:', e);
        }
      }
      
      // Get template-specific prompts
      const prompts = getAIPrompts(this.templateId);
      const template = getTemplate(this.templateId);
      
      // Build analysis prompt
      const analysisPrompt = this.buildAnalysisPrompt(chunk, prompts, template);
      
      // Call AI for analysis
      let aiResult = null;
      if (window.videoEditor?.analyzeSceneWithVision) {
        aiResult = await window.videoEditor.analyzeSceneWithVision({
          transcript: chunk.text,
          speaker: chunk.speaker,
          startTime: chunk.startTime,
          endTime: chunk.endTime,
          frameBase64: frameBase64,
          prompt: analysisPrompt,
          templateId: this.templateId
        });
      } else {
        // Fallback to text-only analysis
        aiResult = await this.textOnlyAnalysis(chunk, analysisPrompt);
      }
      
      // Build result
      const result = {
        chunkId: chunk.id,
        startTime: chunk.startTime,
        endTime: chunk.endTime,
        duration: chunk.duration,
        speaker: chunk.speaker,
        transcript: chunk.text,
        wordCount: chunk.words.length,
        snapshotTime: snapshotTime,
        snapshotBase64: frameBase64,
        
        // AI-generated metadata
        sceneHeading: aiResult?.sceneHeading || this.generateSceneHeading(chunk),
        visualDescription: aiResult?.visualDescription || '',
        mood: aiResult?.mood || 'neutral',
        topics: aiResult?.topics || [],
        keyMoments: aiResult?.keyMoments || [],
        suggestedMarkers: aiResult?.suggestedMarkers || [],
        
        // Processing metadata
        aiGenerated: true,
        processedAt: new Date().toISOString(),
        templateId: this.templateId
      };
      
      this.emit('chunkProcessed', { 
        chunkIndex: this.currentChunkIndex, 
        result 
      });
      
      return result;
      
    } catch (error) {
      console.error('[LineScriptAI] Chunk processing error:', error);
      
      // Return basic result without AI analysis
      return {
        chunkId: chunk.id,
        startTime: chunk.startTime,
        endTime: chunk.endTime,
        duration: chunk.duration,
        speaker: chunk.speaker,
        transcript: chunk.text,
        wordCount: chunk.words.length,
        sceneHeading: this.generateSceneHeading(chunk),
        visualDescription: '',
        aiGenerated: false,
        error: error.message,
        processedAt: new Date().toISOString()
      };
    }
  }

  /**
   * Build analysis prompt based on template
   * @param {Object} chunk - Chunk data
   * @param {Object} prompts - Template prompts
   * @param {Object} template - Template config
   * @returns {string} Analysis prompt
   */
  buildAnalysisPrompt(chunk, prompts, template) {
    const basePrompt = prompts.chunkAnalysis || '';
    
    return `${basePrompt}

Context:
- Template: ${template?.name || 'General'}
- Speaker: ${chunk.speaker || 'Unknown'}
- Duration: ${chunk.duration.toFixed(1)}s
- Word count: ${chunk.words.length}

Transcript:
"${chunk.text}"

Provide analysis in JSON format with these fields:
{
  "sceneHeading": "Brief scene/segment heading",
  "visualDescription": "Description of what's visually happening",
  "mood": "emotional tone (e.g., conversational, energetic, serious)",
  "topics": ["topic1", "topic2"],
  "keyMoments": [{"time": 0.0, "type": "quote|highlight|transition", "description": "..."}],
  "suggestedMarkers": [{"time": 0.0, "type": "marker_type", "name": "..."}]
}`;
  }

  /**
   * Text-only analysis fallback
   * @param {Object} chunk - Chunk data
   * @param {string} prompt - Analysis prompt
   * @returns {Object} Analysis result
   */
  async textOnlyAnalysis(chunk, prompt) {
    // Try to use OpenAI API directly if available
    if (window.videoEditor?.generateSceneDescription) {
      try {
        const description = await window.videoEditor.generateSceneDescription({
          transcript: chunk.text,
          speaker: chunk.speaker,
          templateId: this.templateId
        });
        
        return {
          sceneHeading: this.generateSceneHeading(chunk),
          visualDescription: description,
          mood: this.detectMood(chunk.text),
          topics: this.extractTopics(chunk.text),
          keyMoments: [],
          suggestedMarkers: []
        };
      } catch (e) {
        console.warn('[LineScriptAI] Text analysis fallback error:', e);
      }
    }
    
    // Simple heuristic-based analysis
    return {
      sceneHeading: this.generateSceneHeading(chunk),
      visualDescription: '',
      mood: this.detectMood(chunk.text),
      topics: this.extractTopics(chunk.text),
      keyMoments: [],
      suggestedMarkers: []
    };
  }

  /**
   * Generate scene heading from chunk
   * @param {Object} chunk - Chunk data
   * @returns {string} Scene heading
   */
  generateSceneHeading(chunk) {
    if (chunk.speaker) {
      return `${chunk.speaker.toUpperCase()} SPEAKS`;
    }
    
    // Extract first few words for heading
    const firstWords = chunk.text.split(/\s+/).slice(0, 5).join(' ');
    return firstWords.length > 30 ? firstWords.substring(0, 30) + '...' : firstWords;
  }

  /**
   * Detect mood from text
   * @param {string} text - Text to analyze
   * @returns {string} Detected mood
   */
  detectMood(text) {
    const lowerText = text.toLowerCase();
    
    // Simple keyword-based mood detection
    if (lowerText.includes('exciting') || lowerText.includes('amazing') || lowerText.includes('!')) {
      return 'energetic';
    }
    if (lowerText.includes('problem') || lowerText.includes('issue') || lowerText.includes('difficult')) {
      return 'serious';
    }
    if (lowerText.includes('funny') || lowerText.includes('haha') || lowerText.includes('joke')) {
      return 'humorous';
    }
    if (lowerText.includes('learn') || lowerText.includes('understand') || lowerText.includes('explain')) {
      return 'educational';
    }
    
    return 'conversational';
  }

  /**
   * Extract topics from text
   * @param {string} text - Text to analyze
   * @returns {Array} Extracted topics
   */
  extractTopics(text) {
    const topics = [];
    const lowerText = text.toLowerCase();
    
    // Simple keyword extraction
    const keywords = [
      'product', 'feature', 'demo', 'tutorial', 'interview',
      'question', 'answer', 'story', 'example', 'tip',
      'strategy', 'technique', 'tool', 'software', 'service'
    ];
    
    keywords.forEach(keyword => {
      if (lowerText.includes(keyword)) {
        topics.push(keyword);
      }
    });
    
    return topics.slice(0, 3); // Return top 3 topics
  }

  /**
   * Wait for user approval of chunk result
   * @param {Object} result - Chunk processing result
   * @returns {Promise<Object>} Approval result
   */
  waitForApproval(result) {
    return new Promise((resolve) => {
      // Emit event for UI to show approval dialog
      this.emit('awaitingApproval', { result });
      
      // Store resolver for external approval
      this.pendingApproval = {
        resolve,
        result
      };
    });
  }

  /**
   * Approve current chunk (called from UI)
   * @param {Object} edits - Any edits to apply
   */
  approveChunk(edits = {}) {
    if (this.pendingApproval) {
      this.pendingApproval.resolve({ approved: true, edits });
      this.pendingApproval = null;
    }
  }

  /**
   * Skip current chunk (called from UI)
   */
  skipChunk() {
    if (this.pendingApproval) {
      this.pendingApproval.resolve({ approved: false, skip: true });
      this.pendingApproval = null;
    }
  }

  /**
   * Request regeneration of current chunk (called from UI)
   */
  regenerateChunk() {
    if (this.pendingApproval) {
      this.pendingApproval.resolve({ approved: false, regenerate: true });
      this.pendingApproval = null;
    }
  }

  /**
   * Pause processing
   */
  pause() {
    this.isPaused = true;
    this.emit('processingPaused');
  }

  /**
   * Resume processing
   */
  resume() {
    this.isPaused = false;
    this.emit('processingResumed');
  }

  /**
   * Wait for resume when paused
   * @returns {Promise} Resume promise
   */
  waitForResume() {
    return new Promise(resolve => {
      const checkResume = () => {
        if (!this.isPaused || this.isCancelled) {
          resolve();
        } else {
          setTimeout(checkResume, 100);
        }
      };
      checkResume();
    });
  }

  /**
   * Cancel processing
   */
  cancel() {
    this.isCancelled = true;
    this.isPaused = false;
    
    if (this.pendingApproval) {
      this.pendingApproval.resolve({ approved: false, cancelled: true });
      this.pendingApproval = null;
    }
    
    this.emit('processingCancelled');
  }

  /**
   * Get processing status
   * @returns {Object} Status object
   */
  getStatus() {
    return {
      isProcessing: this.isProcessing,
      isPaused: this.isPaused,
      currentChunk: this.currentChunkIndex,
      totalChunks: this.chunks.length,
      processedChunks: this.processedChunks.length,
      progress: this.chunks.length > 0 ? (this.currentChunkIndex / this.chunks.length) * 100 : 0
    };
  }

  /**
   * Get processed results
   * @returns {Array} Results array
   */
  getResults() {
    return [...this.results];
  }

  /**
   * Apply results to markers
   * @param {Object} markerManager - Marker manager instance
   */
  applyResultsToMarkers(markerManager) {
    if (!markerManager) return;
    
    this.results.forEach(result => {
      // Create or update range marker for each chunk
      const existingMarker = markerManager.getMarkersInRange(
        result.startTime - 0.5, 
        result.startTime + 0.5
      )[0];
      
      if (existingMarker) {
        // Update existing marker
        markerManager.updateMarker(existingMarker.id, {
          name: result.sceneHeading,
          description: result.visualDescription,
          lineScript: {
            sceneHeading: result.sceneHeading,
            visualDescription: result.visualDescription,
            mood: result.mood,
            topics: result.topics,
            snapshotBase64: result.snapshotBase64,
            aiGenerated: result.aiGenerated,
            processedAt: result.processedAt
          }
        });
      } else {
        // Create new marker
        markerManager.addRangeMarker(
          result.startTime,
          result.endTime,
          result.sceneHeading,
          null, // Use default color
          {
            description: result.visualDescription,
            lineScript: {
              sceneHeading: result.sceneHeading,
              visualDescription: result.visualDescription,
              mood: result.mood,
              topics: result.topics,
              snapshotBase64: result.snapshotBase64,
              aiGenerated: result.aiGenerated,
              processedAt: result.processedAt
            }
          }
        );
      }
    });
    
    console.log(`[LineScriptAI] Applied ${this.results.length} results to markers`);
  }

  // Event emitter methods
  
  on(event, callback) {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(callback);
  }

  emit(event, data = {}) {
    if (this.eventListeners[event]) {
      this.eventListeners[event].forEach(callback => callback(data));
    }
  }

  off(event, callback) {
    if (this.eventListeners[event]) {
      this.eventListeners[event] = this.eventListeners[event].filter(cb => cb !== callback);
    }
  }

  /**
   * Reset state
   */
  reset() {
    this.chunks = [];
    this.currentChunkIndex = 0;
    this.processedChunks = [];
    this.results = [];
    this.isProcessing = false;
    this.isPaused = false;
    this.isCancelled = false;
    this.pendingApproval = null;
  }
}

export default LineScriptAI;











