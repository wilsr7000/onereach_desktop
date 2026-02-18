/**
 * Generative Search Module
 *
 * LLM-powered semantic search with customizable filters.
 * Uses GPT-5.2 for fast parallel evaluation of items.
 */

const { GenerativeFilterEngine, FILTER_TYPES, FILTER_CATEGORIES } = require('./GenerativeFilterEngine');
const { FILTER_PROMPTS, buildEvaluationPrompt, getAvailableFilters } = require('./filter-prompts');
const { BatchProcessor, StreamingBatchProcessor } = require('./batch-processor');

// Singleton instance
let engineInstance = null;

/**
 * Get or create the generative filter engine instance
 * @param {Object} spacesAPI - SpacesAPI instance
 * @param {Object} options - Engine options
 * @returns {GenerativeFilterEngine}
 */
function getGenerativeFilterEngine(spacesAPI, options = {}) {
  if (!engineInstance && spacesAPI) {
    engineInstance = new GenerativeFilterEngine(spacesAPI, options);
  }
  return engineInstance;
}

/**
 * Create a new engine instance (for testing or isolated use)
 */
function createGenerativeFilterEngine(spacesAPI, options = {}) {
  return new GenerativeFilterEngine(spacesAPI, options);
}

/**
 * Reset the singleton instance
 */
function resetEngine() {
  engineInstance = null;
}

module.exports = {
  // Main engine
  GenerativeFilterEngine,
  getGenerativeFilterEngine,
  createGenerativeFilterEngine,
  resetEngine,

  // Filter definitions
  FILTER_TYPES,
  FILTER_CATEGORIES,
  FILTER_PROMPTS,
  getAvailableFilters,
  buildEvaluationPrompt,

  // Batch processing
  BatchProcessor,
  StreamingBatchProcessor,
};
