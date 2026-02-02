/**
 * Evaluation Agent
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Individual agent evaluation logic with LLM integration
 */

/**
 * Evaluation Agent
 * Executes evaluation from a specific perspective
 */
class EvalAgent {
  constructor(config, options = {}) {
    this.id = config.id;
    this.type = config.type;
    this.icon = config.icon;
    this.perspective = config.perspective;
    this.weight = config.weight;
    this.criteria = config.criteria || [];
    this.systemPrompt = config.systemPrompt;
    
    // LLM client for evaluation
    this.llmClient = options.llmClient;
    
    // Status tracking
    this.status = 'ready';
    this.startedAt = null;
    this.completedAt = null;
  }

  /**
   * Run evaluation on content
   * @param {string} content - Content to evaluate
   * @param {Object} context - Evaluation context
   * @returns {Object} Evaluation result
   */
  async evaluate(content, context = {}) {
    this.status = 'evaluating';
    this.startedAt = new Date().toISOString();

    try {
      // If we have an LLM client, use it
      if (this.llmClient) {
        return await this.evaluateWithLLM(content, context);
      }

      // Otherwise, use heuristic evaluation
      return this.evaluateWithHeuristics(content, context);
    } catch (error) {
      this.status = 'failed';
      throw error;
    } finally {
      this.completedAt = new Date().toISOString();
    }
  }

  /**
   * Evaluate using LLM
   * @param {string} content - Content to evaluate
   * @param {Object} context - Evaluation context
   * @returns {Object} Evaluation result
   */
  async evaluateWithLLM(content, context) {
    const prompt = `${this.systemPrompt}

CONTENT TO EVALUATE:
${content.slice(0, 10000)}${content.length > 10000 ? '\n...[truncated]...' : ''}

${context.additionalContext ? `ADDITIONAL CONTEXT:\n${context.additionalContext}` : ''}

Provide your evaluation:`;

    const response = await this.llmClient.complete(prompt, {
      temperature: 0.3, // Lower temperature for more consistent evaluations
      maxTokens: 2000
    });

    // Parse the JSON response
    let evaluation;
    try {
      // Try to extract JSON from the response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        evaluation = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      // If parsing fails, create a basic evaluation
      evaluation = {
        overallScore: 70,
        criteria: [],
        strengths: ['Evaluation completed'],
        concerns: ['Unable to parse detailed evaluation'],
        suggestions: [],
        parseError: true
      };
    }

    this.status = 'completed';

    return {
      agentId: this.id,
      agentType: this.type,
      agentIcon: this.icon,
      perspective: this.perspective,
      weight: this.weight,
      
      overallScore: evaluation.overallScore || 70,
      criteria: evaluation.criteria || [],
      strengths: evaluation.strengths || [],
      concerns: evaluation.concerns || [],
      suggestions: evaluation.suggestions || [],
      
      evaluatedAt: this.completedAt,
      duration: new Date(this.completedAt) - new Date(this.startedAt),
      method: 'llm'
    };
  }

  /**
   * Evaluate using heuristics (fallback)
   * @param {string} content - Content to evaluate
   * @param {Object} context - Evaluation context
   * @returns {Object} Evaluation result
   */
  evaluateWithHeuristics(content, context) {
    const criteria = this.evaluateCriteria(content, context);
    const overallScore = this.calculateOverallScore(criteria);

    this.status = 'completed';

    return {
      agentId: this.id,
      agentType: this.type,
      agentIcon: this.icon,
      perspective: this.perspective,
      weight: this.weight,
      
      overallScore,
      criteria,
      strengths: this.identifyStrengths(criteria),
      concerns: this.identifyConcerns(criteria),
      suggestions: this.generateSuggestions(criteria, content),
      
      evaluatedAt: this.completedAt,
      duration: new Date(this.completedAt) - new Date(this.startedAt),
      method: 'heuristics'
    };
  }

  /**
   * Evaluate individual criteria using heuristics
   * @param {string} content - Content to evaluate
   * @param {Object} context - Evaluation context
   * @returns {Object[]} Criteria evaluations
   */
  evaluateCriteria(content, context) {
    const documentType = context.documentType || 'code';
    
    // Heuristic checks based on content characteristics
    const results = [];

    // Check readability/clarity
    const avgLineLength = content.split('\n').reduce((sum, line) => sum + line.length, 0) / 
                          Math.max(content.split('\n').length, 1);
    results.push({
      name: 'clarity',
      score: Math.max(0, Math.min(100, 100 - (avgLineLength - 80) * 0.5)),
      weight: 0.2,
      comment: avgLineLength > 100 ? 'Some lines are too long' : 'Good line length',
      evidence: []
    });

    // Check for comments/documentation (for code)
    if (documentType === 'code') {
      const commentRatio = (content.match(/\/\/|\/\*|\*\/|#|"""/g) || []).length / 
                           Math.max(content.split('\n').length, 1);
      results.push({
        name: 'documentation',
        score: Math.min(100, commentRatio * 500),
        weight: 0.15,
        comment: commentRatio > 0.1 ? 'Well documented' : 'Could use more comments',
        evidence: []
      });

      // Check for error handling
      const hasErrorHandling = /try|catch|throw|error|exception/i.test(content);
      results.push({
        name: 'error_handling',
        score: hasErrorHandling ? 80 : 50,
        weight: 0.15,
        comment: hasErrorHandling ? 'Has error handling' : 'Consider adding error handling',
        evidence: []
      });
    }

    // Check structure
    const hasHeadings = /^#{1,6}\s|^[A-Z][^.!?]*$/m.test(content);
    results.push({
      name: 'structure',
      score: hasHeadings ? 75 : 60,
      weight: 0.15,
      comment: 'Structure evaluation',
      evidence: []
    });

    // Default completeness score
    results.push({
      name: 'completeness',
      score: content.length > 100 ? 70 : 50,
      weight: 0.2,
      comment: 'Completeness evaluation',
      evidence: []
    });

    return results;
  }

  /**
   * Calculate overall score from criteria
   * @param {Object[]} criteria - Evaluated criteria
   * @returns {number}
   */
  calculateOverallScore(criteria) {
    if (criteria.length === 0) return 70;
    
    const totalWeight = criteria.reduce((sum, c) => sum + (c.weight || 1), 0);
    const weightedSum = criteria.reduce((sum, c) => sum + c.score * (c.weight || 1), 0);
    
    return Math.round(weightedSum / totalWeight);
  }

  /**
   * Identify strengths from criteria
   * @param {Object[]} criteria - Evaluated criteria
   * @returns {string[]}
   */
  identifyStrengths(criteria) {
    return criteria
      .filter(c => c.score >= 75)
      .map(c => `Good ${c.name}: ${c.comment}`);
  }

  /**
   * Identify concerns from criteria
   * @param {Object[]} criteria - Evaluated criteria
   * @returns {string[]}
   */
  identifyConcerns(criteria) {
    return criteria
      .filter(c => c.score < 60)
      .map(c => `${c.name} needs improvement: ${c.comment}`);
  }

  /**
   * Generate suggestions based on criteria
   * @param {Object[]} criteria - Evaluated criteria
   * @param {string} content - Original content
   * @returns {Object[]}
   */
  generateSuggestions(criteria, content) {
    const suggestions = [];

    for (const criterion of criteria) {
      if (criterion.score < 60) {
        suggestions.push({
          priority: criterion.score < 40 ? 'high' : 'medium',
          text: `Improve ${criterion.name}: ${criterion.comment}`,
          applySuggestion: null // Would need LLM to generate specific fix
        });
      }
    }

    return suggestions;
  }

  /**
   * Get agent status
   * @returns {Object}
   */
  getStatus() {
    return {
      id: this.id,
      type: this.type,
      status: this.status,
      startedAt: this.startedAt,
      completedAt: this.completedAt
    };
  }

  /**
   * Reset agent for reuse
   */
  reset() {
    this.status = 'ready';
    this.startedAt = null;
    this.completedAt = null;
  }
}

module.exports = EvalAgent;
module.exports.EvalAgent = EvalAgent;


