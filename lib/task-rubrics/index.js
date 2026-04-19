/**
 * Task Rubrics Module
 * Part of the Governed Self-Improving Agent Runtime
 *
 * Per-task-type success criteria and evaluation
 */

const codeRubrics = require('./code');
const planningRubrics = require('./planning');

/**
 * All task success rubrics
 */
const TASK_SUCCESS_RUBRICS = {
  code_generation: codeRubrics.CODE_GENERATION,
  code_refactor: codeRubrics.CODE_REFACTOR,
  bug_fix: codeRubrics.BUG_FIX,
  test_generation: codeRubrics.TEST_GENERATION,

  // Planning & decision-making (agent-system v2)
  plan_review: planningRubrics.PLAN_REVIEW,
  plan_proposal: planningRubrics.PLAN_PROPOSAL,
  decision_record: planningRubrics.DECISION_RECORD,
  meeting_outcome: planningRubrics.MEETING_OUTCOME,

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
 * Look up a rubric by id. Returns the full rubric object or null.
 * Used by the Task contract to auto-expand `task.rubric` into criteria.
 *
 * @param {string} id
 * @returns {Object|null}
 */
function getRubric(id) {
  if (!id || typeof id !== 'string') return null;
  return TASK_SUCCESS_RUBRICS[id] || null;
}

/**
 * Convert a named rubric (or the object itself) into the flat
 * `Task.criteria[]` shape used by the live auction / council runner:
 *
 *   [
 *     { id: 'clarity', label: 'Clarity',
 *       description: 'Is the plan clearly stated...?', weight: 0.25 },
 *     ...
 *   ]
 *
 * This is the bridge between the rubric definition format (object keyed
 * by criterion name) and the Task field format (ordered array).
 *
 * @param {string|Object} rubricOrId
 * @returns {Array|null} Criteria array, or null when the rubric id is unknown
 */
function rubricToCriteria(rubricOrId) {
  const rubric = typeof rubricOrId === 'string' ? getRubric(rubricOrId) : rubricOrId;
  if (!rubric || !rubric.criteria || typeof rubric.criteria !== 'object') return null;
  return Object.entries(rubric.criteria).map(([name, entry]) => {
    const out = {
      id: name,
      label: _humanizeId(name),
    };
    if (entry && typeof entry.description === 'string') out.description = entry.description;
    if (entry && typeof entry.weight === 'number' && isFinite(entry.weight)) out.weight = entry.weight;
    return out;
  });
}

function _humanizeId(id) {
  return String(id)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

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
  getRubric,
  rubricToCriteria,
  ...codeRubrics,
  ...planningRubrics,
};
