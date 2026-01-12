/**
 * Task Classifier
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * LLM-based task classification for intelligent routing
 */

const { TASK_TYPES, COMPLEXITY } = require('../event-schema');

/**
 * Task Classifier
 * Classifies tasks by type, complexity, and document type
 */
class TaskClassifier {
  constructor(options = {}) {
    this.llmClient = options.llmClient; // Optional LLM client for advanced classification
    this.useHeuristics = options.useHeuristics !== false;
  }

  /**
   * Classify a task based on its description and context
   * @param {Object} task - Task to classify
   * @returns {Object} Classification result
   */
  async classify(task) {
    const description = task.description || '';
    const context = task.context || {};

    // Use heuristics first (fast)
    let classification = this.classifyWithHeuristics(description, context);

    // Optionally enhance with LLM (slower but more accurate)
    if (this.llmClient && !classification.highConfidence) {
      const llmClassification = await this.classifyWithLLM(description, context);
      classification = this.mergeClassifications(classification, llmClassification);
    }

    return classification;
  }

  /**
   * Classify using keyword heuristics
   * @param {string} description - Task description
   * @param {Object} context - Task context
   * @returns {Object} Classification
   */
  classifyWithHeuristics(description, context) {
    const lower = description.toLowerCase();
    
    // Detect task type
    let taskType = TASK_TYPES.CODE_GENERATION;
    let confidence = 0.5;

    const typePatterns = {
      [TASK_TYPES.BUG_FIX]: ['fix', 'bug', 'error', 'issue', 'broken', 'crash', 'fail'],
      [TASK_TYPES.CODE_REFACTOR]: ['refactor', 'clean', 'reorganize', 'restructure', 'optimize'],
      [TASK_TYPES.TEST_GENERATION]: ['test', 'spec', 'coverage', 'assert', 'mock'],
      [TASK_TYPES.DOCUMENTATION]: ['doc', 'readme', 'comment', 'explain', 'describe'],
      [TASK_TYPES.EVALUATION]: ['eval', 'review', 'assess', 'check', 'validate'],
      [TASK_TYPES.RESEARCH]: ['research', 'investigate', 'explore', 'find', 'look'],
      [TASK_TYPES.PLANNING]: ['plan', 'design', 'architect', 'outline', 'strategy']
    };

    for (const [type, keywords] of Object.entries(typePatterns)) {
      const matches = keywords.filter(kw => lower.includes(kw)).length;
      if (matches > 0) {
        const newConfidence = 0.5 + (matches * 0.15);
        if (newConfidence > confidence) {
          taskType = type;
          confidence = Math.min(newConfidence, 0.95);
        }
      }
    }

    // Detect complexity
    const complexity = this.detectComplexity(description, context);

    // Detect document type
    const documentType = this.detectDocumentType(description, context);

    // Extract tags
    const tags = this.extractTags(description);

    return {
      taskType,
      complexity,
      documentType,
      tags,
      confidence,
      highConfidence: confidence > 0.8,
      method: 'heuristics'
    };
  }

  /**
   * Detect task complexity
   * @param {string} description - Task description
   * @param {Object} context - Task context
   * @returns {string} Complexity level
   */
  detectComplexity(description, context) {
    const lower = description.toLowerCase();
    const wordCount = description.split(/\s+/).length;
    const filesCount = context.files?.length || 0;

    // Simple heuristics
    if (wordCount < 10 && filesCount <= 1) {
      if (lower.includes('typo') || lower.includes('rename') || lower.includes('simple')) {
        return COMPLEXITY.TRIVIAL;
      }
      return COMPLEXITY.SIMPLE;
    }

    if (wordCount > 50 || filesCount > 5) {
      if (lower.includes('major') || lower.includes('complete') || lower.includes('overhaul')) {
        return COMPLEXITY.MAJOR;
      }
      return COMPLEXITY.COMPLEX;
    }

    if (lower.includes('refactor') || lower.includes('redesign')) {
      return COMPLEXITY.COMPLEX;
    }

    return COMPLEXITY.MODERATE;
  }

  /**
   * Detect document/content type
   * @param {string} description - Task description
   * @param {Object} context - Task context
   * @returns {string} Document type
   */
  detectDocumentType(description, context) {
    const lower = description.toLowerCase();
    const files = context.files || [];

    // Check file extensions
    const extensions = files.map(f => {
      const parts = f.split('.');
      return parts.length > 1 ? parts.pop().toLowerCase() : '';
    });

    if (extensions.some(e => ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'go', 'rs'].includes(e))) {
      return 'code';
    }
    if (extensions.some(e => ['md', 'txt', 'rst'].includes(e))) {
      return 'documentation';
    }
    if (extensions.some(e => ['css', 'scss', 'less'].includes(e))) {
      return 'styles';
    }
    if (extensions.some(e => ['json', 'yaml', 'yml', 'toml'].includes(e))) {
      return 'config';
    }
    if (extensions.some(e => ['html', 'htm', 'vue', 'svelte'].includes(e))) {
      return 'template';
    }

    // Check description keywords
    if (lower.includes('api') || lower.includes('endpoint')) return 'api';
    if (lower.includes('test') || lower.includes('spec')) return 'test';
    if (lower.includes('style') || lower.includes('css')) return 'styles';
    if (lower.includes('config') || lower.includes('setting')) return 'config';

    return 'code'; // Default
  }

  /**
   * Extract relevant tags from description
   * @param {string} description - Task description
   * @returns {string[]} Extracted tags
   */
  extractTags(description) {
    const tags = [];
    const lower = description.toLowerCase();

    const tagPatterns = {
      'frontend': ['ui', 'frontend', 'component', 'react', 'vue', 'angular'],
      'backend': ['api', 'server', 'backend', 'database', 'endpoint'],
      'testing': ['test', 'spec', 'mock', 'coverage'],
      'security': ['security', 'auth', 'permission', 'token', 'encrypt'],
      'performance': ['performance', 'optimize', 'speed', 'cache', 'memory'],
      'urgent': ['urgent', 'critical', 'asap', 'immediately']
    };

    for (const [tag, keywords] of Object.entries(tagPatterns)) {
      if (keywords.some(kw => lower.includes(kw))) {
        tags.push(tag);
      }
    }

    return tags;
  }

  /**
   * Classify using LLM (more accurate but slower)
   * @param {string} description - Task description
   * @param {Object} context - Task context
   * @returns {Object} Classification
   */
  async classifyWithLLM(description, context) {
    if (!this.llmClient) {
      return null;
    }

    try {
      const prompt = `Classify this development task:

Description: ${description}
Context: ${JSON.stringify(context, null, 2)}

Respond with JSON containing:
- taskType: one of [code_generation, code_refactor, bug_fix, test_generation, documentation, evaluation, research, planning]
- complexity: one of [trivial, simple, moderate, complex, major]
- documentType: one of [code, documentation, styles, config, template, api, test]
- tags: array of relevant tags
- confidence: number 0-1

JSON response:`;

      const response = await this.llmClient.complete(prompt);
      return JSON.parse(response);
    } catch (error) {
      console.error('LLM classification failed:', error);
      return null;
    }
  }

  /**
   * Merge heuristic and LLM classifications
   * @param {Object} heuristic - Heuristic classification
   * @param {Object} llm - LLM classification
   * @returns {Object} Merged classification
   */
  mergeClassifications(heuristic, llm) {
    if (!llm) return heuristic;

    // Use LLM result if it has higher confidence
    if (llm.confidence > heuristic.confidence) {
      return {
        ...llm,
        method: 'llm',
        heuristicFallback: heuristic
      };
    }

    // Otherwise merge tags and keep heuristic
    return {
      ...heuristic,
      tags: [...new Set([...heuristic.tags, ...(llm.tags || [])])],
      llmEnhanced: true
    };
  }
}

module.exports = TaskClassifier;
module.exports.TaskClassifier = TaskClassifier;

