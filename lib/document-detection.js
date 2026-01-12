/**
 * Document Detection
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Probabilistic document type detection with confidence scores
 */

/**
 * Document types and their associated patterns
 */
const DOCUMENT_TYPES = {
  code: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.rb'],
    keywords: ['function', 'class', 'const', 'let', 'var', 'import', 'export', 'return', 'async', 'await'],
    patterns: [/^(function|class|const|let|var)\s+\w+/m, /=>\s*{/, /import\s+.*from/]
  },
  technical: {
    extensions: ['.md', '.rst', '.txt'],
    keywords: ['api', 'endpoint', 'implementation', 'architecture', 'protocol', 'specification'],
    patterns: [/^#+\s+.*API/im, /^#+\s+.*Architecture/im, /^#+\s+.*Implementation/im]
  },
  recipe: {
    extensions: ['.md', '.txt'],
    keywords: ['ingredients', 'instructions', 'cook', 'bake', 'minutes', 'tablespoon', 'cup', 'teaspoon'],
    patterns: [/^#+\s+Ingredients/im, /^#+\s+Instructions/im, /\d+\s*(minutes|hours)/i]
  },
  creative: {
    extensions: ['.md', '.txt', '.doc'],
    keywords: ['chapter', 'scene', 'character', 'dialogue', 'narrative', 'story'],
    patterns: [/^#+\s+Chapter/im, /^#+\s+Scene/im, /"[^"]+"\s+said/i]
  },
  projectPlan: {
    extensions: ['.md', '.txt', '.doc'],
    keywords: ['milestone', 'sprint', 'deadline', 'deliverable', 'stakeholder', 'timeline'],
    patterns: [/^#+\s+Milestones?/im, /^#+\s+Timeline/im, /^#+\s+Sprint/im]
  },
  api: {
    extensions: ['.yaml', '.yml', '.json', '.md'],
    keywords: ['endpoint', 'request', 'response', 'status', 'header', 'body', 'get', 'post', 'put', 'delete'],
    patterns: [/^(GET|POST|PUT|DELETE|PATCH)\s+\//, /openapi:/, /swagger:/]
  },
  config: {
    extensions: ['.json', '.yaml', '.yml', '.toml', '.ini', '.env'],
    keywords: ['config', 'setting', 'environment', 'variable', 'option'],
    patterns: [/^[A-Z_]+=/, /"[^"]+"\s*:/, /^\[.*\]$/m]
  },
  test: {
    extensions: ['.test.js', '.spec.js', '.test.ts', '.spec.ts', '_test.py', '_test.go'],
    keywords: ['describe', 'it', 'expect', 'assert', 'mock', 'spy', 'beforeEach', 'afterEach'],
    patterns: [/describe\s*\(/, /it\s*\(/, /expect\s*\(/, /assert\./]
  }
};

/**
 * Document Type Detector
 * Returns probabilistic detection with confidence scores
 */
class DocumentTypeDetector {
  constructor(options = {}) {
    this.llmClient = options.llmClient;
    this.useAI = options.useAI !== false && !!this.llmClient;
    this.userOverrides = new Map(); // path -> type override
  }

  /**
   * Detect document type with confidence scores
   * @param {string} content - Document content
   * @param {Object} options - Detection options
   * @returns {Object} Detection result with top N types
   */
  async detect(content, options = {}) {
    const { filePath, topN = 3 } = options;

    // Check for user override first
    if (filePath && this.userOverrides.has(filePath)) {
      return {
        types: [{
          type: this.userOverrides.get(filePath),
          confidence: 1.0,
          source: 'user_override'
        }],
        userOverride: this.userOverrides.get(filePath),
        method: 'override'
      };
    }

    // Run heuristic detection
    const heuristicResults = this.detectWithHeuristics(content, filePath);

    // Optionally enhance with LLM
    if (this.useAI && heuristicResults[0]?.confidence < 0.8) {
      try {
        const aiResults = await this.detectWithAI(content);
        const merged = this.mergeResults(heuristicResults, aiResults);
        return {
          types: merged.slice(0, topN),
          userOverride: null,
          method: 'hybrid'
        };
      } catch (error) {
        console.error('AI detection failed:', error);
      }
    }

    return {
      types: heuristicResults.slice(0, topN),
      userOverride: null,
      method: 'heuristics'
    };
  }

  /**
   * Detect using heuristics
   * @param {string} content - Document content
   * @param {string} filePath - Optional file path
   * @returns {Object[]} Scored types
   */
  detectWithHeuristics(content, filePath) {
    const scores = {};

    for (const [type, config] of Object.entries(DOCUMENT_TYPES)) {
      let score = 0;
      let matches = 0;
      let totalChecks = 0;

      // Check file extension
      if (filePath) {
        totalChecks++;
        const ext = '.' + filePath.split('.').pop().toLowerCase();
        const fullExt = filePath.includes('.test.') || filePath.includes('.spec.') 
          ? filePath.match(/\.(test|spec)\.[^.]+$/)?.[0] || ext
          : ext;
        
        if (config.extensions.some(e => fullExt.endsWith(e) || ext === e)) {
          score += 0.3;
          matches++;
        }
      }

      // Check keywords
      const contentLower = content.toLowerCase();
      const keywordMatches = config.keywords.filter(kw => contentLower.includes(kw)).length;
      if (keywordMatches > 0) {
        totalChecks++;
        const keywordScore = Math.min(keywordMatches / config.keywords.length, 1) * 0.4;
        score += keywordScore;
        if (keywordMatches >= 3) matches++;
      }

      // Check patterns
      const patternMatches = config.patterns.filter(p => p.test(content)).length;
      if (patternMatches > 0) {
        totalChecks++;
        const patternScore = Math.min(patternMatches / config.patterns.length, 1) * 0.3;
        score += patternScore;
        if (patternMatches >= 2) matches++;
      }

      scores[type] = {
        type,
        confidence: Math.min(score, 0.95),
        matches,
        totalChecks,
        source: 'heuristics'
      };
    }

    // Sort by confidence
    return Object.values(scores)
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Detect using AI
   * @param {string} content - Document content
   * @returns {Object[]} AI-detected types
   */
  async detectWithAI(content) {
    const prompt = `Analyze this document and determine its type. Consider these categories:
- code: Programming source code
- technical: Technical documentation
- recipe: Cooking/food recipes
- creative: Creative writing, stories
- projectPlan: Project plans, roadmaps
- api: API documentation, OpenAPI specs
- config: Configuration files
- test: Test files, test cases

Document (first 2000 chars):
${content.slice(0, 2000)}

Respond with JSON array of top 3 types with confidence scores (0-1):
[{"type": "...", "confidence": 0.X, "reasoning": "..."}]`;

    const response = await this.llmClient.complete(prompt);
    const results = JSON.parse(response);
    
    return results.map(r => ({
      ...r,
      source: 'ai'
    }));
  }

  /**
   * Merge heuristic and AI results
   * @param {Object[]} heuristic - Heuristic results
   * @param {Object[]} ai - AI results
   * @returns {Object[]} Merged results
   */
  mergeResults(heuristic, ai) {
    const merged = new Map();

    // Add heuristic results
    for (const h of heuristic) {
      merged.set(h.type, {
        type: h.type,
        confidence: h.confidence * 0.5,
        sources: ['heuristics']
      });
    }

    // Merge AI results
    for (const a of ai) {
      if (merged.has(a.type)) {
        const existing = merged.get(a.type);
        existing.confidence = (existing.confidence + a.confidence * 0.5) / 1;
        existing.sources.push('ai');
        existing.aiReasoning = a.reasoning;
      } else {
        merged.set(a.type, {
          type: a.type,
          confidence: a.confidence * 0.5,
          sources: ['ai'],
          aiReasoning: a.reasoning
        });
      }
    }

    return [...merged.values()].sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Set user override for a file
   * @param {string} filePath - File path
   * @param {string} type - Document type
   */
  setOverride(filePath, type) {
    if (type === null) {
      this.userOverrides.delete(filePath);
    } else {
      this.userOverrides.set(filePath, type);
    }
  }

  /**
   * Get user override for a file
   * @param {string} filePath - File path
   * @returns {string|null}
   */
  getOverride(filePath) {
    return this.userOverrides.get(filePath) || null;
  }

  /**
   * Get all available document types
   * @returns {string[]}
   */
  getAvailableTypes() {
    return Object.keys(DOCUMENT_TYPES);
  }

  /**
   * Get type configuration
   * @param {string} type - Document type
   * @returns {Object|null}
   */
  getTypeConfig(type) {
    return DOCUMENT_TYPES[type] || null;
  }
}

module.exports = DocumentTypeDetector;
module.exports.DocumentTypeDetector = DocumentTypeDetector;
module.exports.DOCUMENT_TYPES = DOCUMENT_TYPES;

