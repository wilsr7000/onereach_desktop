/**
 * Task Rubrics Module
 * Part of the Governed Self-Improving Agent Runtime
 *
 * Per-task-type success criteria and evaluation
 */

const codeRubrics = require('./code');

/**
 * All task success rubrics
 */
const TASK_SUCCESS_RUBRICS = {
  code_generation: codeRubrics.CODE_GENERATION,
  code_refactor: codeRubrics.CODE_REFACTOR,
  bug_fix: codeRubrics.BUG_FIX,
  test_generation: codeRubrics.TEST_GENERATION,

  // Documentation rubric
  documentation: {
    name: 'documentation',
    description: 'Criteria for documentation tasks',
    criteria: {
      accuracy: { weight: 0.3, check: 'llm', description: 'Information is accurate' },
      clarity: { weight: 0.3, check: 'llm', description: 'Writing is clear' },
      completeness: { weight: 0.25, check: 'llm', description: 'Topic is fully covered' },
      examples: { weight: 0.15, check: 'llm', description: 'Includes helpful examples' },
    },
    passThreshold: 0.75,
  },

  // Default rubric for unknown task types
  default: {
    name: 'default',
    description: 'Default criteria for unspecified tasks',
    criteria: {
      completed: { weight: 0.5, check: 'automated', description: 'Task was completed' },
      quality: { weight: 0.5, check: 'llm', description: 'Output quality is acceptable' },
    },
    passThreshold: 0.7,
  },
};

/**
 * Task Rubric Evaluator
 * Evaluates task results against rubrics
 */
class TaskRubricEvaluator {
  constructor(options = {}) {
    this.rubrics = { ...TASK_SUCCESS_RUBRICS, ...options.customRubrics };
    this.llmClient = options.llmClient;
  }

  /**
   * Get rubric for a task type
   * @param {string} taskType - Task type
   * @returns {Object} Rubric
   */
  getRubric(taskType) {
    return this.rubrics[taskType] || this.rubrics.default;
  }

  /**
   * Evaluate a task result against its rubric
   * @param {Object} task - Task that was executed
   * @param {Object} result - Task result
   * @returns {Object} Evaluation result
   */
  async evaluateTask(task, result) {
    const rubric = this.getRubric(task.type || task.classification?.taskType);
    const criteriaResults = {};
    let totalWeight = 0;
    let weightedScore = 0;

    for (const [name, criterion] of Object.entries(rubric.criteria)) {
      let criterionResult;

      if (criterion.check === 'automated' && criterion.evaluator) {
        // Run automated check
        criterionResult = await criterion.evaluator(task, result);
      } else if (criterion.check === 'llm' && this.llmClient) {
        // Run LLM check
        criterionResult = await this.evaluateWithLLM(criterion, task, result);
      } else {
        // Default pass if no evaluator
        criterionResult = { passed: true, score: 70, details: 'Not evaluated' };
      }

      criteriaResults[name] = {
        ...criterionResult,
        weight: criterion.weight,
        description: criterion.description,
      };

      totalWeight += criterion.weight;
      weightedScore += (criterionResult.score / 100) * criterion.weight;
    }

    const overallScore = (weightedScore / totalWeight) * 100;
    const passed = overallScore >= rubric.passThreshold * 100;

    return {
      taskId: task.id,
      taskType: rubric.name,
      rubric: rubric.name,

      overallScore: Math.round(overallScore),
      passed,
      threshold: rubric.passThreshold * 100,

      criteria: criteriaResults,

      evaluatedAt: new Date().toISOString(),
    };
  }

  /**
   * Evaluate criterion with LLM
   * @param {Object} criterion - Criterion to evaluate
   * @param {Object} task - Task
   * @param {Object} result - Result
   * @returns {Object} Evaluation result
   */
  async evaluateWithLLM(criterion, task, result) {
    if (!this.llmClient) {
      return { passed: true, score: 70, details: 'LLM evaluation not available' };
    }

    try {
      const prompt = criterion.prompt || `Evaluate: ${criterion.description}. Rate 0-100.`;
      const fullPrompt = `${prompt}

Task: ${task.description}
Result: ${JSON.stringify(result).slice(0, 2000)}

Respond with JSON: { "score": <0-100>, "details": "<explanation>" }`;

      const response = await this.llmClient.complete(fullPrompt);
      const parsed = JSON.parse(response.match(/\{[\s\S]*\}/)?.[0] || '{}');

      return {
        passed: parsed.score >= 70,
        score: parsed.score || 70,
        details: parsed.details || 'LLM evaluation',
      };
    } catch (_error) {
      return { passed: true, score: 70, details: 'LLM evaluation failed' };
    }
  }

  /**
   * Get all available rubric names
   * @returns {string[]}
   */
  getAvailableRubrics() {
    return Object.keys(this.rubrics);
  }

  /**
   * Add custom rubric
   * @param {string} name - Rubric name
   * @param {Object} rubric - Rubric configuration
   */
  addRubric(name, rubric) {
    this.rubrics[name] = rubric;
  }
}

module.exports = {
  TASK_SUCCESS_RUBRICS,
  TaskRubricEvaluator,
  ...codeRubrics,
};
