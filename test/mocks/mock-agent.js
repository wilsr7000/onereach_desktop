/**
 * MockAgent - Factory for creating deterministic test agents
 *
 * Creates agents with configurable bidding and execution behavior
 * for testing the distributed bidding system without LLM calls.
 */

/**
 * Create a mock agent with configurable behavior
 * @param {string} id - Unique agent identifier
 * @param {Object} options - Configuration options
 * @param {string} options.name - Display name
 * @param {string[]} options.keywords - Keywords for fallback matching
 * @param {string[]} options.capabilities - Capability descriptions
 * @param {number} options.bidConfidence - Fixed confidence to bid (0-1)
 * @param {boolean} options.shouldBid - Whether agent should bid at all
 * @param {boolean} options.shouldFail - Whether execution should fail
 * @param {string} options.successMessage - Message on success
 * @param {string} options.errorMessage - Error message on failure
 * @param {number} options.executionDelayMs - Simulated execution time
 * @param {Function} options.customBidFn - Custom bid function(task) -> {confidence, plan}
 * @param {Function} options.customExecuteFn - Custom execute function(task) -> {success, message}
 */
function createMockAgent(id, options = {}) {
  const agent = {
    id,
    name: options.name || `Mock ${id}`,
    version: options.version || '1.0.0',
    keywords: options.keywords || [],
    capabilities: options.capabilities || [],
    categories: options.categories || ['general'],
    enabled: options.enabled !== false,
    executionType: options.executionType || 'mock',

    /**
     * Bid on a task - deterministic behavior
     */
    bid(task) {
      // Custom bid function takes precedence
      if (options.customBidFn) {
        return options.customBidFn(task);
      }

      // Explicitly disabled bidding
      if (options.shouldBid === false) {
        return null;
      }

      // Fixed confidence
      if (options.bidConfidence !== undefined) {
        return {
          confidence: options.bidConfidence,
          plan: options.bidPlan || 'Mock agent plan',
          tier: 'mock',
        };
      }

      // Keyword-based bidding (default)
      const content = (task.content || '').toLowerCase();
      const keywordMatches = agent.keywords.filter((k) => content.includes(k.toLowerCase()));

      if (keywordMatches.length === 0) {
        return null;
      }

      // Base confidence 0.5, +0.1 per match, max 0.9
      const confidence = Math.min(0.9, 0.5 + keywordMatches.length * 0.1);
      return {
        confidence,
        plan: `Keyword match: ${keywordMatches.join(', ')}`,
        tier: 'keyword',
      };
    },

    /**
     * Execute a task - deterministic behavior
     */
    async execute(task) {
      // Custom execute function takes precedence
      if (options.customExecuteFn) {
        return options.customExecuteFn(task);
      }

      // Simulate execution delay
      if (options.executionDelayMs) {
        await new Promise((r) => {
          setTimeout(r, options.executionDelayMs);
        });
      }

      // Configured to fail - throw error to trigger dead letter
      if (options.shouldFail) {
        if (options.throwError !== false) {
          throw new Error(options.errorMessage || 'Mock execution failure');
        }
        return {
          success: false,
          error: options.errorMessage || 'Mock execution failure',
        };
      }

      // Success
      return {
        success: true,
        message: options.successMessage || `${agent.name} handled: ${task.content}`,
        data: options.resultData,
      };
    },
  };

  return agent;
}

/**
 * Create a mock agent that always bids with high confidence
 */
function createHighConfidenceAgent(id, options = {}) {
  return createMockAgent(id, {
    bidConfidence: 0.9,
    ...options,
  });
}

/**
 * Create a mock agent that always bids with low confidence
 */
function createLowConfidenceAgent(id, options = {}) {
  return createMockAgent(id, {
    bidConfidence: 0.3,
    ...options,
  });
}

/**
 * Create a mock agent that never bids
 */
function createNonBiddingAgent(id, options = {}) {
  return createMockAgent(id, {
    shouldBid: false,
    ...options,
  });
}

/**
 * Create a mock agent that fails on execution
 */
function createFailingAgent(id, options = {}) {
  return createMockAgent(id, {
    bidConfidence: 0.8,
    shouldFail: true,
    errorMessage: options.errorMessage || 'Simulated failure',
    ...options,
  });
}

/**
 * Create a mock agent with keyword-based bidding
 */
function createKeywordAgent(id, keywords, options = {}) {
  return createMockAgent(id, {
    keywords,
    ...options,
  });
}

/**
 * Create a mock built-in agent (like time-agent, weather-agent)
 */
function createMockBuiltInAgent(id, config = {}) {
  const agent = createMockAgent(id, {
    keywords: config.keywords || [],
    capabilities: config.capabilities || [],
    ...config,
  });

  // Built-in agents have bid() and execute() methods directly on the object
  // (not via the wrapper pattern)
  return {
    id: agent.id,
    name: agent.name,
    version: agent.version,
    keywords: agent.keywords,
    capabilities: agent.capabilities,

    bid(task) {
      return agent.bid(task);
    },

    async execute(task) {
      return agent.execute(task);
    },
  };
}

module.exports = {
  createMockAgent,
  createHighConfidenceAgent,
  createLowConfidenceAgent,
  createNonBiddingAgent,
  createFailingAgent,
  createKeywordAgent,
  createMockBuiltInAgent,
};
