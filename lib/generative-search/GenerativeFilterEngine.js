/**
 * Generative Filter Engine
 *
 * Uses LLM (GPT-5.2) to evaluate items against semantic filters.
 * Supports parallel batch processing for speed.
 *
 * Features:
 * - Context-aware filters (related to project, similar to item)
 * - Quality/novelty scoring
 * - Purpose-based search (good visual for X, reference material)
 * - Content analysis (actionable insights, explains concept)
 * - Organizational filters (needs attention, duplicates)
 */

const ai = require('../ai-service');
const { _FILTER_PROMPTS, buildEvaluationPrompt } = require('./filter-prompts');
const { BatchProcessor } = require('./batch-processor');
const { getLogQueue } = require('./../log-event-queue');
const log = getLogQueue();

// Filter type definitions
const FILTER_TYPES = {
  // Context-Aware Filters
  RELATED_TO_PROJECT: {
    id: 'related_to_project',
    name: 'Related to Project',
    description: 'How relevant to the current space/project',
    requiresContext: true,
    category: 'context',
  },
  SIMILAR_TO_ITEM: {
    id: 'similar_to_item',
    name: 'Similar to Selected',
    description: 'Semantic similarity to a reference item',
    requiresReference: true,
    category: 'context',
  },
  USEFUL_FOR: {
    id: 'useful_for',
    name: 'Useful For',
    description: 'How useful for a specific goal/task',
    requiresInput: true,
    inputPlaceholder: 'Describe what you need...',
    category: 'context',
  },

  // Quality/Time Filters
  QUALITY_SCORE: {
    id: 'quality_score',
    name: 'Quality Score',
    description: 'Polish, completeness, craftsmanship',
    category: 'quality',
  },
  INTERESTING_NOVEL: {
    id: 'interesting_novel',
    name: 'Interesting/Novel',
    description: 'How unique or creative',
    category: 'quality',
  },
  RECENT_FAVORITES: {
    id: 'recent_favorites',
    name: 'Recent Favorites',
    description: 'Combines recency with quality signals',
    category: 'quality',
  },

  // Purpose-Based Filters
  GOOD_VISUAL_FOR: {
    id: 'good_visual_for',
    name: 'Good Visual For',
    description: 'Find images/videos for a specific use',
    requiresInput: true,
    inputPlaceholder: 'What do you need a visual for?',
    category: 'purpose',
  },
  REFERENCE_MATERIAL: {
    id: 'reference_material',
    name: 'Reference Material',
    description: 'Items that teach or explain concepts',
    category: 'purpose',
  },
  WORKING_EXAMPLE: {
    id: 'working_example',
    name: 'Working Example Of',
    description: 'Code/patterns that demonstrate something',
    requiresInput: true,
    inputPlaceholder: 'What pattern or technique?',
    category: 'purpose',
  },
  INSPIRATION_FOR: {
    id: 'inspiration_for',
    name: 'Inspiration For',
    description: 'Creative starting points',
    requiresInput: true,
    inputPlaceholder: 'What are you creating?',
    category: 'purpose',
  },

  // Content Analysis Filters
  ACTIONABLE_INSIGHTS: {
    id: 'actionable_insights',
    name: 'Has Actionable Insights',
    description: 'Contains things you can act on',
    category: 'content',
  },
  CONTAINS_DATA_ABOUT: {
    id: 'contains_data_about',
    name: 'Contains Data About',
    description: 'Items with relevant data/statistics',
    requiresInput: true,
    inputPlaceholder: 'What topic?',
    category: 'content',
  },
  EXPLAINS_CONCEPT: {
    id: 'explains_concept',
    name: 'Explains Concept',
    description: 'Educational content about a topic',
    requiresInput: true,
    inputPlaceholder: 'What concept?',
    category: 'content',
  },

  // Organizational Filters
  NEEDS_ATTENTION: {
    id: 'needs_attention',
    name: 'Needs Attention',
    description: 'Incomplete, outdated, or needs metadata',
    category: 'organizational',
  },
  COULD_BE_GROUPED: {
    id: 'could_be_grouped',
    name: 'Could Be Grouped With',
    description: 'Find items that belong together',
    requiresReference: true,
    category: 'organizational',
  },
  DUPLICATES_VARIATIONS: {
    id: 'duplicates_variations',
    name: 'Duplicates/Variations',
    description: 'Similar items that could be consolidated',
    category: 'organizational',
  },
};

// Category groupings for UI
const FILTER_CATEGORIES = {
  context: { name: 'Context-Aware', icon: '🎯' },
  quality: { name: 'Quality & Time', icon: '⭐' },
  purpose: { name: 'Purpose-Based', icon: '🎨' },
  content: { name: 'Content Analysis', icon: '📊' },
  organizational: { name: 'Organizational', icon: '📁' },
};

class GenerativeFilterEngine {
  constructor(spacesAPI, options = {}) {
    this.spacesAPI = spacesAPI;
    this.batchProcessor = new BatchProcessor({
      concurrency: options.concurrency || 5,
      batchSize: options.batchSize || 8,
      onProgress: options.onProgress,
    });

    // Cache for results
    this.cache = new Map();
    this.cacheTTL = options.cacheTTL || 5 * 60 * 1000; // 5 minutes default

    // Cost tracking
    this.lastSearchCost = 0;
  }

  /**
   * Get available filter types
   */
  static getFilterTypes() {
    return FILTER_TYPES;
  }

  /**
   * Get filter categories for UI grouping
   */
  static getFilterCategories() {
    return FILTER_CATEGORIES;
  }

  /**
   * Estimate cost before running search
   * @param {number} itemCount - Number of items to evaluate
   * @param {Array} filters - Active filters
   * @param {string} mode - 'quick' or 'deep'
   * @returns {Object} Cost estimate
   */
  estimateCost(itemCount, filters, mode = 'quick') {
    // Approximate tokens per item
    const tokensPerItem = mode === 'deep' ? 500 : 150;
    const tokensPerFilter = 50;
    const outputTokensPerItem = 30 * filters.length;

    const totalInputTokens = itemCount * (tokensPerItem + tokensPerFilter * filters.length);
    const totalOutputTokens = itemCount * outputTokensPerItem;

    // GPT-5.2 pricing (approximate)
    const inputCostPer1k = 0.005;
    const outputCostPer1k = 0.015;

    const estimatedCost = (totalInputTokens / 1000) * inputCostPer1k + (totalOutputTokens / 1000) * outputCostPer1k;

    return {
      itemCount,
      filterCount: filters.length,
      mode,
      estimatedTokens: totalInputTokens + totalOutputTokens,
      estimatedCost: Math.round(estimatedCost * 1000) / 1000,
      formatted: `~$${estimatedCost.toFixed(3)} for ${itemCount} items`,
    };
  }

  /**
   * Main search method
   * @param {Object} options - Search options
   * @param {Array} options.filters - Active filters with thresholds and weights
   * @param {string} options.spaceId - Space to search in (null for all)
   * @param {string} options.mode - 'quick' (metadata only) or 'deep' (full content)
   * @param {Object} options.context - Additional context (space info, reference item)
   * @param {string} options.userQuery - Optional free-form query
   * @returns {Promise<Array>} Scored and ranked items
   */
  async search(options) {
    const { filters = [], spaceId = null, mode = 'quick', context = {}, userQuery = '' } = options;

    if (filters.length === 0 && !userQuery) {
      throw new Error('At least one filter or query is required');
    }

    // Get items to evaluate
    let items = this.spacesAPI.storage.getAllItems();

    if (spaceId) {
      items = items.filter((item) => item.spaceId === spaceId);
    }

    if (items.length === 0) {
      return [];
    }

    // Check cache
    const cacheKey = this._buildCacheKey(filters, spaceId, mode, userQuery);
    const cached = this._getFromCache(cacheKey);
    if (cached) {
      log.info('app', 'Returning cached results');
      return cached;
    }

    // Get space context if searching within a space
    let spaceContext = null;
    if (spaceId) {
      spaceContext = await this._getSpaceContext(spaceId);
    }

    // Prepare items for evaluation
    const preparedItems = await this._prepareItems(items, mode);

    // Build evaluation prompt
    const prompt = buildEvaluationPrompt(filters, {
      spaceContext,
      userQuery,
      referenceItem: context.referenceItem,
    });

    // Process items in batches
    log.info('app', 'Evaluating items with filters', { items: items.length, filters: filters.length });

    const scoredItems = await this.batchProcessor.process(preparedItems, async (batch) => {
      return this._evaluateBatch(batch, prompt, filters);
    });

    // Apply thresholds and calculate composite scores
    const rankedItems = this._rankAndFilter(scoredItems, filters);

    // Cache results
    this._setCache(cacheKey, rankedItems);

    // Track cost
    this.lastSearchCost = this.batchProcessor.getLastRunCost();

    return rankedItems;
  }

  /**
   * Prepare items for LLM evaluation
   */
  async _prepareItems(items, mode) {
    const prepared = [];

    for (const item of items) {
      const preparedItem = {
        id: item.id,
        type: item.type,
        preview: item.preview || '',
        fileName: item.fileName || '',
        tags: [],
        timestamp: item.timestamp,
        spaceId: item.spaceId,
      };

      // Get metadata
      try {
        const metadata = this.spacesAPI._getItemMetadataForSearch(item.id);
        preparedItem.title = metadata.title || '';
        preparedItem.description = metadata.description || '';
        preparedItem.tags = metadata.tags || [];
        preparedItem.notes = metadata.notes || '';
        preparedItem.author = metadata.author || '';
        preparedItem.source = metadata.source || '';
      } catch (_e) {
        // Ignore metadata errors
      }

      // For deep mode, include more content
      if (mode === 'deep' && (item.type === 'text' || item.type === 'code' || item.type === 'html')) {
        try {
          const fullItem = this.spacesAPI.storage.loadItem(item.id);
          if (fullItem && fullItem.content) {
            // Truncate to reasonable length
            preparedItem.content = fullItem.content.substring(0, 2000);
          }
        } catch (_e) {
          // Ignore content load errors
        }
      }

      prepared.push(preparedItem);
    }

    return prepared;
  }

  /**
   * Evaluate a batch of items
   */
  async _evaluateBatch(batch, prompt, filters) {
    // Format items for the prompt
    const itemsText = batch
      .map((item, idx) => {
        let text = `[${idx + 1}] Type: ${item.type}`;
        if (item.title) text += `, Title: "${item.title}"`;
        if (item.fileName) text += `, File: "${item.fileName}"`;
        if (item.preview) text += `, Preview: "${item.preview.substring(0, 200)}"`;
        if (item.tags.length > 0) text += `, Tags: [${item.tags.join(', ')}]`;
        if (item.description) text += `, Description: "${item.description.substring(0, 150)}"`;
        if (item.content) text += `\nContent snippet: "${item.content.substring(0, 500)}"`;
        return text;
      })
      .join('\n\n');

    const fullPrompt = `${prompt}\n\nITEMS TO EVALUATE:\n${itemsText}\n\nRespond with JSON only:`;

    try {
      const result = await ai.chat({
        profile: 'large', // GPT-5.2 for large context
        messages: [{ role: 'user', content: fullPrompt }],
        maxTokens: 1000,
        jsonMode: true,
        feature: 'generative-search',
      });

      // Parse scores from response (ai.chat returns { content, ... })
      // content is a JSON string that needs parsing
      const response = result.content;
      const scores = this._parseScores(response, batch, filters);

      // Merge scores back into items
      return batch.map((item, idx) => ({
        ...item,
        _generativeScores: scores[idx] || {},
      }));
    } catch (error) {
      log.error('app', 'Batch evaluation error', { error: error });
      // Return items with zero scores on error
      return batch.map((item) => ({
        ...item,
        _generativeScores: filters.reduce((acc, f) => ({ ...acc, [f.id]: 0 }), {}),
      }));
    }
  }

  /**
   * Parse LLM response into scores
   */
  _parseScores(response, batch, filters) {
    try {
      let parsed;

      // Handle both string and object responses (API may return pre-parsed JSON)
      if (typeof response === 'object' && response !== null) {
        // Response is already parsed - use directly
        parsed = response;
      } else {
        // Response is a string - need to parse it
        let jsonStr = response;
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonStr = jsonMatch[0];
        }
        parsed = JSON.parse(jsonStr);
      }

      // Handle different response formats
      if (parsed.scores && Array.isArray(parsed.scores)) {
        return parsed.scores;
      }

      if (Array.isArray(parsed)) {
        return parsed;
      }

      // Try to extract scores from object
      const scores = [];
      for (let i = 0; i < batch.length; i++) {
        const itemScores = {};
        for (const filter of filters) {
          const key = filter.id;
          if (parsed[i] && typeof parsed[i][key] === 'number') {
            itemScores[key] = parsed[i][key];
          } else if (parsed[key] && typeof parsed[key][i] === 'number') {
            itemScores[key] = parsed[key][i];
          } else {
            itemScores[key] = 50; // Default middle score
          }
        }
        scores.push(itemScores);
      }
      return scores;
    } catch (error) {
      log.error('app', 'Score parsing error', { error: error });
      // Return default scores
      return batch.map(() => filters.reduce((acc, f) => ({ ...acc, [f.id]: 50 }), {}));
    }
  }

  /**
   * Rank items by composite score and apply thresholds
   */
  _rankAndFilter(scoredItems, filters) {
    // Calculate composite score for each item
    const itemsWithComposite = scoredItems.map((item) => {
      const scores = item._generativeScores || {};
      let totalWeight = 0;
      let weightedSum = 0;
      let passesAllThresholds = true;

      // Extract reason if present (LLM provides explanation)
      const reason = scores.reason || null;

      // Handle case where no specific filters are used (free-form query)
      // LLM returns generic "score" key in this case
      if (filters.length === 0 && typeof scores.score === 'number') {
        return {
          ...item,
          _search: {
            compositeScore: scores.score,
            scores,
            reason,
            passesThresholds: true,
          },
        };
      }

      for (const filter of filters) {
        const score = scores[filter.id] || 0;
        const weight = filter.weight || 1.0;
        const threshold = filter.threshold || 0;

        // Check threshold
        if (score < threshold) {
          passesAllThresholds = false;
        }

        weightedSum += score * weight;
        totalWeight += weight;
      }

      const compositeScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

      return {
        ...item,
        _search: {
          compositeScore,
          scores,
          reason, // Include the LLM's explanation
          passesThresholds: passesAllThresholds,
        },
      };
    });

    // Filter by thresholds and sort by composite score
    return itemsWithComposite
      .filter((item) => item._search.passesThresholds)
      .sort((a, b) => b._search.compositeScore - a._search.compositeScore);
  }

  /**
   * Get space context for evaluation
   */
  async _getSpaceContext(spaceId) {
    try {
      const space = await this.spacesAPI.get(spaceId);
      if (!space) return null;

      const metadata = await this.spacesAPI.metadata.getSpace(spaceId);

      return {
        name: space.name,
        description: metadata?.description || '',
        purpose: metadata?.purpose || '',
        tags: metadata?.tags || [],
        category: metadata?.category || '',
      };
    } catch (_error) {
      return null;
    }
  }

  /**
   * Cache management
   */
  _buildCacheKey(filters, spaceId, mode, userQuery) {
    const filterKey = filters
      .map((f) => `${f.id}:${f.threshold}:${f.weight}:${f.input || ''}`)
      .sort()
      .join('|');
    return `${spaceId || 'all'}:${mode}:${filterKey}:${userQuery}`;
  }

  _getFromCache(key) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data;
    }
    this.cache.delete(key);
    return null;
  }

  _setCache(key, data) {
    this.cache.set(key, { data, timestamp: Date.now() });

    // Limit cache size
    if (this.cache.size > 50) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get cost of last search
   */
  getLastSearchCost() {
    return this.lastSearchCost;
  }
}

module.exports = {
  GenerativeFilterEngine,
  FILTER_TYPES,
  FILTER_CATEGORIES,
};
