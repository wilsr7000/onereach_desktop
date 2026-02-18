/**
 * Agent Generator
 * Part of the Governed Self-Improving Agent Runtime
 *
 * Spawns evaluation agents based on document type
 */

const DocumentTypeDetector = require('../../lib/document-detection');

/**
 * Agent configurations by document type
 */
const AGENT_CONFIGS = {
  code: [
    { type: 'expert', icon: '👨‍💻', perspective: 'Best practices and design patterns', weight: 1.2 },
    { type: 'reviewer', icon: '🔍', perspective: 'Code quality and maintainability', weight: 1.1 },
    { type: 'security', icon: '🛡️', perspective: 'Security vulnerabilities and data protection', weight: 1.0 },
    { type: 'performance', icon: '⚡', perspective: 'Performance and optimization', weight: 0.9 },
    { type: 'beginner', icon: '🎓', perspective: 'Readability for newcomers', weight: 0.8 },
  ],
  technical: [
    { type: 'expert', icon: '🧑‍🔬', perspective: 'Technical accuracy and completeness', weight: 1.1 },
    { type: 'implementer', icon: '🛠️', perspective: 'Practical implementation guidance', weight: 1.0 },
    { type: 'beginner', icon: '🎓', perspective: 'Clarity for newcomers', weight: 1.2 },
    { type: 'writer', icon: '✍️', perspective: 'Writing quality and structure', weight: 1.0 },
  ],
  recipe: [
    { type: 'chef', icon: '👨‍🍳', perspective: 'Culinary accuracy and technique', weight: 1.2 },
    { type: 'teacher', icon: '👩‍🏫', perspective: 'Clarity for beginners', weight: 1.1 },
    { type: 'homecook', icon: '🏠', perspective: 'Practicality and accessibility', weight: 1.0 },
    { type: 'safety', icon: '🛡️', perspective: 'Food safety and allergens', weight: 1.1 },
    { type: 'nutritionist', icon: '🥗', perspective: 'Nutritional information', weight: 0.9 },
  ],
  creative: [
    { type: 'reader', icon: '📖', perspective: 'Reader engagement and enjoyment', weight: 1.1 },
    { type: 'editor', icon: '✏️', perspective: 'Grammar, style, and structure', weight: 1.0 },
    { type: 'critic', icon: '🎭', perspective: 'Literary merit and originality', weight: 0.9 },
    { type: 'author', icon: '🖋️', perspective: 'Author intent and voice', weight: 1.0 },
  ],
  api: [
    { type: 'consumer', icon: '📱', perspective: 'Developer experience and usability', weight: 1.2 },
    { type: 'implementer', icon: '🛠️', perspective: 'Implementation feasibility', weight: 1.0 },
    { type: 'security', icon: '🛡️', perspective: 'API security and authentication', weight: 1.1 },
    { type: 'documentation', icon: '📚', perspective: 'Documentation completeness', weight: 1.0 },
  ],
  test: [
    { type: 'tester', icon: '🧪', perspective: 'Test coverage and thoroughness', weight: 1.2 },
    { type: 'developer', icon: '👨‍💻', perspective: 'Code being tested', weight: 1.0 },
    { type: 'coverage', icon: '📊', perspective: 'Edge cases and coverage gaps', weight: 1.1 },
    { type: 'maintainer', icon: '🔧', perspective: 'Test maintainability', weight: 0.9 },
  ],
  config: [
    { type: 'devops', icon: '🔧', perspective: 'Configuration best practices', weight: 1.1 },
    { type: 'security', icon: '🛡️', perspective: 'Security of configuration', weight: 1.2 },
    { type: 'developer', icon: '👨‍💻', perspective: 'Developer experience', weight: 1.0 },
  ],
};

/**
 * Default criteria for evaluation
 */
const DEFAULT_CRITERIA = {
  code: [
    { name: 'correctness', weight: 0.25 },
    { name: 'readability', weight: 0.2 },
    { name: 'maintainability', weight: 0.2 },
    { name: 'security', weight: 0.15 },
    { name: 'performance', weight: 0.1 },
    { name: 'testing', weight: 0.1 },
  ],
  technical: [
    { name: 'accuracy', weight: 0.25 },
    { name: 'clarity', weight: 0.25 },
    { name: 'completeness', weight: 0.2 },
    { name: 'structure', weight: 0.15 },
    { name: 'examples', weight: 0.15 },
  ],
  recipe: [
    { name: 'accuracy', weight: 0.25 },
    { name: 'clarity', weight: 0.25 },
    { name: 'practicality', weight: 0.2 },
    { name: 'safety', weight: 0.15 },
    { name: 'presentation', weight: 0.15 },
  ],
};

/**
 * Agent Generator
 * Creates evaluation agents based on document type
 */
class AgentGenerator {
  constructor(options = {}) {
    this.documentDetector = options.documentDetector || new DocumentTypeDetector(options);
    this.agentConfigs = { ...AGENT_CONFIGS, ...options.customConfigs };
    this.defaultCriteria = { ...DEFAULT_CRITERIA, ...options.customCriteria };
    this.profileManager = options.profileManager;
    this.agentMemory = options.agentMemory; // For adaptive selection
  }

  /**
   * Generate agents for content evaluation
   * @param {string} content - Content to evaluate
   * @param {Object} options - Generation options
   * @returns {Object} Generated agents and context
   */
  async generateAgents(content, options = {}) {
    const { filePath, profile = 'standard', forceDocumentType = null } = options;

    // Detect document type
    let documentType = forceDocumentType;
    let detectionResult = null;

    if (!documentType) {
      detectionResult = await this.documentDetector.detect(content, { filePath });
      documentType = detectionResult.types[0]?.type || 'code';
    }

    // Get profile constraints
    const evalProfile = this.profileManager?.getProfile(profile);
    const maxAgents = evalProfile?.maxAgents || 4;

    // Get agent configs for this document type
    const configs = this.agentConfigs[documentType] || this.agentConfigs.code;

    // Select agents based on profile and memory
    const selectedConfigs = await this.selectAgents(configs, {
      maxAgents,
      documentType,
      profile,
    });

    // Create agent instances
    const agents = selectedConfigs.map((config, index) =>
      this.createAgent(config, {
        documentType,
        content,
        index,
      })
    );

    // Get criteria for this document type
    const criteria = this.defaultCriteria[documentType] || this.defaultCriteria.code;

    return {
      agents,
      documentType,
      detectionResult,
      criteria,
      profile,
      metadata: {
        totalAvailable: configs.length,
        selected: agents.length,
        selectionMethod: this.agentMemory ? 'adaptive' : 'profile',
      },
    };
  }

  /**
   * Select agents based on constraints and memory
   * @param {Object[]} configs - Available agent configs
   * @param {Object} options - Selection options
   * @returns {Object[]} Selected configs
   */
  async selectAgents(configs, options) {
    const { maxAgents, documentType } = options;

    if (configs.length <= maxAgents) {
      return configs;
    }

    // If we have agent memory, use adaptive selection
    if (this.agentMemory) {
      const scored = configs.map((config) => {
        const memory = this.agentMemory.getMemory(config.type);
        const contextPerf = memory?.contextPerformance?.[documentType];

        return {
          config,
          score: (contextPerf?.accuracy || memory?.overallAccuracy || 0.5) + config.weight,
        };
      });

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, maxAgents).map((s) => s.config);
    }

    // Otherwise, select by weight
    const sorted = [...configs].sort((a, b) => b.weight - a.weight);
    return sorted.slice(0, maxAgents);
  }

  /**
   * Create an agent instance
   * @param {Object} config - Agent configuration
   * @param {Object} context - Evaluation context
   * @returns {Object} Agent instance
   */
  createAgent(config, context) {
    const id = `agent-${config.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return {
      id,
      type: config.type,
      icon: config.icon,
      perspective: config.perspective,
      weight: config.weight,

      // Evaluation configuration
      criteria: this.defaultCriteria[context.documentType] || [],

      // Prompt template
      systemPrompt: this.generateSystemPrompt(config, context),

      // Status
      status: 'ready',

      // Results (populated after evaluation)
      evaluation: null,
    };
  }

  /**
   * Generate system prompt for an agent
   * @param {Object} config - Agent config
   * @param {Object} context - Evaluation context
   * @returns {string} System prompt
   */
  generateSystemPrompt(config, context) {
    return `You are an expert ${config.type} evaluator.

Your perspective: ${config.perspective}

Document type: ${context.documentType}

Evaluate the provided content based on your expertise. For each criterion, provide:
1. A score from 0-100
2. A brief explanation
3. Specific evidence from the content
4. Suggestions for improvement

Be constructive but thorough. Focus on your specific perspective and expertise.

Respond in JSON format:
{
  "overallScore": <number>,
  "criteria": [
    {
      "name": "<criterion>",
      "score": <number>,
      "weight": <number>,
      "comment": "<explanation>",
      "evidence": ["<quote or reference>"]
    }
  ],
  "strengths": ["<strength>"],
  "concerns": ["<concern>"],
  "suggestions": [
    {
      "priority": "high|medium|low",
      "text": "<suggestion>",
      "applySuggestion": "<specific fix if applicable>"
    }
  ]
}`;
  }

  /**
   * Get available document types
   * @returns {string[]}
   */
  getAvailableDocumentTypes() {
    return Object.keys(this.agentConfigs);
  }

  /**
   * Get agent configs for a document type
   * @param {string} documentType - Document type
   * @returns {Object[]}
   */
  getAgentConfigs(documentType) {
    return this.agentConfigs[documentType] || this.agentConfigs.code;
  }

  /**
   * Add custom agent config
   * @param {string} documentType - Document type
   * @param {Object} config - Agent configuration
   */
  addAgentConfig(documentType, config) {
    if (!this.agentConfigs[documentType]) {
      this.agentConfigs[documentType] = [];
    }
    this.agentConfigs[documentType].push(config);
  }

  /**
   * Add custom criteria
   * @param {string} documentType - Document type
   * @param {Object[]} criteria - Criteria array
   */
  addCriteria(documentType, criteria) {
    this.defaultCriteria[documentType] = criteria;
  }
}

module.exports = AgentGenerator;
module.exports.AgentGenerator = AgentGenerator;
module.exports.AGENT_CONFIGS = AGENT_CONFIGS;
module.exports.DEFAULT_CRITERIA = DEFAULT_CRITERIA;
