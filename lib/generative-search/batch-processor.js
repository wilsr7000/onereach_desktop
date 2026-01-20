/**
 * Batch Processor for Generative Search
 * 
 * Handles parallel processing of items in batches for LLM evaluation.
 * Supports concurrency control, progress callbacks, and error recovery.
 */

class BatchProcessor {
  /**
   * @param {Object} options
   * @param {number} options.concurrency - Max parallel batches (default: 5)
   * @param {number} options.batchSize - Items per batch (default: 8)
   * @param {Function} options.onProgress - Progress callback (processed, total, results)
   * @param {number} options.retryAttempts - Retry failed batches (default: 2)
   * @param {number} options.retryDelay - Delay between retries in ms (default: 1000)
   */
  constructor(options = {}) {
    this.concurrency = options.concurrency || 5;
    this.batchSize = options.batchSize || 8;
    this.onProgress = options.onProgress || null;
    this.retryAttempts = options.retryAttempts || 2;
    this.retryDelay = options.retryDelay || 1000;
    
    // Stats tracking
    this.stats = {
      totalItems: 0,
      processedItems: 0,
      totalBatches: 0,
      completedBatches: 0,
      failedBatches: 0,
      startTime: null,
      endTime: null,
      estimatedCost: 0
    };
    
    // Abort controller for cancellation
    this.abortController = null;
  }

  /**
   * Process items in parallel batches
   * @param {Array} items - Items to process
   * @param {Function} processBatch - Async function to process a batch
   * @returns {Promise<Array>} All processed items
   */
  async process(items, processBatch) {
    if (!items || items.length === 0) {
      return [];
    }

    // Reset stats
    this.stats = {
      totalItems: items.length,
      processedItems: 0,
      totalBatches: Math.ceil(items.length / this.batchSize),
      completedBatches: 0,
      failedBatches: 0,
      startTime: Date.now(),
      endTime: null,
      estimatedCost: 0
    };

    // Create abort controller for cancellation
    this.abortController = new AbortController();

    // Split into batches
    const batches = this._createBatches(items);
    
    console.log(`[BatchProcessor] Processing ${items.length} items in ${batches.length} batches (concurrency: ${this.concurrency})`);

    // Process batches with concurrency control
    const results = [];
    const batchQueue = [...batches];
    const activeBatches = new Map();
    let batchIndex = 0;

    return new Promise((resolve, reject) => {
      const processNextBatch = async () => {
        // Check for abort
        if (this.abortController.signal.aborted) {
          reject(new Error('Processing cancelled'));
          return;
        }

        // Get next batch
        if (batchQueue.length === 0 && activeBatches.size === 0) {
          // All done
          this.stats.endTime = Date.now();
          console.log(`[BatchProcessor] Completed in ${this.stats.endTime - this.stats.startTime}ms`);
          resolve(results.flat());
          return;
        }

        // Start new batches up to concurrency limit
        while (batchQueue.length > 0 && activeBatches.size < this.concurrency) {
          const batch = batchQueue.shift();
          const idx = batchIndex++;
          
          const batchPromise = this._processBatchWithRetry(batch, idx, processBatch)
            .then(batchResults => {
              // Store results
              results[idx] = batchResults;
              
              // Update stats
              this.stats.completedBatches++;
              this.stats.processedItems += batch.length;
              
              // Progress callback
              if (this.onProgress) {
                this.onProgress({
                  processed: this.stats.processedItems,
                  total: this.stats.totalItems,
                  completedBatches: this.stats.completedBatches,
                  totalBatches: this.stats.totalBatches,
                  percentComplete: Math.round((this.stats.processedItems / this.stats.totalItems) * 100),
                  results: batchResults
                });
              }
            })
            .catch(error => {
              console.error(`[BatchProcessor] Batch ${idx} failed:`, error);
              this.stats.failedBatches++;
              results[idx] = batch.map(item => ({
                ...item,
                _generativeScores: {},
                _error: error.message
              }));
            })
            .finally(() => {
              activeBatches.delete(idx);
              processNextBatch();
            });
          
          activeBatches.set(idx, batchPromise);
        }
      };

      // Start initial batches
      processNextBatch();
    });
  }

  /**
   * Process a single batch with retry logic
   */
  async _processBatchWithRetry(batch, batchIndex, processBatch) {
    let lastError;
    
    for (let attempt = 0; attempt <= this.retryAttempts; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[BatchProcessor] Retrying batch ${batchIndex} (attempt ${attempt + 1})`);
          await this._delay(this.retryDelay * attempt);
        }
        
        const result = await processBatch(batch);
        return result;
      } catch (error) {
        lastError = error;
        
        // Don't retry on certain errors
        if (error.message?.includes('API key') || 
            error.message?.includes('rate limit') ||
            error.message?.includes('quota')) {
          throw error;
        }
      }
    }
    
    throw lastError;
  }

  /**
   * Split items into batches
   */
  _createBatches(items) {
    const batches = [];
    for (let i = 0; i < items.length; i += this.batchSize) {
      batches.push(items.slice(i, i + this.batchSize));
    }
    return batches;
  }

  /**
   * Cancel ongoing processing
   */
  cancel() {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Get processing statistics
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Get estimated cost (set by the caller after processing)
   */
  getLastRunCost() {
    return this.stats.estimatedCost;
  }

  /**
   * Set estimated cost
   */
  setEstimatedCost(cost) {
    this.stats.estimatedCost = cost;
  }

  /**
   * Delay helper
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Streaming batch processor - yields results as they complete
 */
class StreamingBatchProcessor extends BatchProcessor {
  /**
   * Process items and yield results as batches complete
   * @param {Array} items - Items to process
   * @param {Function} processBatch - Async function to process a batch
   * @yields {Object} Batch result with metadata
   */
  async *processStreaming(items, processBatch) {
    if (!items || items.length === 0) {
      return;
    }

    // Reset stats
    this.stats = {
      totalItems: items.length,
      processedItems: 0,
      totalBatches: Math.ceil(items.length / this.batchSize),
      completedBatches: 0,
      failedBatches: 0,
      startTime: Date.now(),
      endTime: null,
      estimatedCost: 0
    };

    // Create batches
    const batches = this._createBatches(items);
    
    // Process each batch and yield results
    for (let i = 0; i < batches.length; i += this.concurrency) {
      const batchGroup = batches.slice(i, i + this.concurrency);
      
      const promises = batchGroup.map((batch, idx) => 
        this._processBatchWithRetry(batch, i + idx, processBatch)
          .then(results => ({ success: true, results, batchIndex: i + idx }))
          .catch(error => ({ success: false, error, batch, batchIndex: i + idx }))
      );
      
      // Wait for all in this group to complete
      const groupResults = await Promise.all(promises);
      
      for (const result of groupResults) {
        this.stats.completedBatches++;
        
        if (result.success) {
          this.stats.processedItems += result.results.length;
          yield {
            type: 'batch_complete',
            batchIndex: result.batchIndex,
            items: result.results,
            progress: {
              processed: this.stats.processedItems,
              total: this.stats.totalItems,
              percentComplete: Math.round((this.stats.processedItems / this.stats.totalItems) * 100)
            }
          };
        } else {
          this.stats.failedBatches++;
          yield {
            type: 'batch_error',
            batchIndex: result.batchIndex,
            error: result.error.message,
            items: result.batch.map(item => ({ ...item, _error: result.error.message }))
          };
        }
      }
    }

    this.stats.endTime = Date.now();
    
    yield {
      type: 'complete',
      stats: this.getStats()
    };
  }
}

module.exports = {
  BatchProcessor,
  StreamingBatchProcessor
};
