/**
 * Queue Optimizer
 * Part of the Governed Self-Improving Agent Runtime
 *
 * LLM-based priority optimization and task reordering
 */

/**
 * Queue Optimizer
 * Optimizes task queue order using AI
 */

const { getLogQueue } = require('./../log-event-queue');
const log = getLogQueue();

class QueueOptimizer {
  constructor(options = {}) {
    this.llmClient = options.llmClient;
    this.useAI = options.useAI !== false && !!this.llmClient;
  }

  /**
   * Optimize task position in queue
   * @param {Object} newTask - Task to position
   * @param {Object[]} existingTasks - Current queue
   * @returns {Object} Optimization result with recommended index
   */
  async optimizePosition(newTask, existingTasks) {
    if (existingTasks.length === 0) {
      return { index: 0, reasoning: 'Queue is empty' };
    }

    // Use AI if available
    if (this.useAI) {
      try {
        return await this.optimizeWithAI(newTask, existingTasks);
      } catch (error) {
        log.error('app', 'AI optimization failed, using heuristics:', { error: error });
      }
    }

    // Fallback to heuristic optimization
    return this.optimizeWithHeuristics(newTask, existingTasks);
  }

  /**
   * Optimize using heuristics
   * @param {Object} newTask - Task to position
   * @param {Object[]} existingTasks - Current queue
   * @returns {Object} Optimization result
   */
  optimizeWithHeuristics(newTask, existingTasks) {
    const newPriority = this.calculateEffectivePriority(newTask);

    let insertIndex = existingTasks.length;
    let reasoning = 'Added to end of queue';

    for (let i = 0; i < existingTasks.length; i++) {
      const existingPriority = this.calculateEffectivePriority(existingTasks[i]);

      if (newPriority < existingPriority) {
        insertIndex = i;
        reasoning = `Inserted before task with lower priority (${existingPriority} vs ${newPriority})`;
        break;
      }
    }

    return {
      index: insertIndex,
      reasoning,
      method: 'heuristics',
      effectivePriority: newPriority,
    };
  }

  /**
   * Calculate effective priority considering multiple factors
   * @param {Object} task - Task to evaluate
   * @returns {number} Effective priority (lower = higher priority)
   */
  calculateEffectivePriority(task) {
    let priority = task.queueMetadata?.priority ?? task.classification?.priority ?? 5;

    // Adjust for urgency tags
    const tags = task.classification?.tags || [];
    if (tags.includes('urgent')) priority -= 2;
    if (tags.includes('critical')) priority -= 3;

    // Adjust for blocking status
    if (task.context?.blocking) priority -= 1;

    // Adjust for complexity (simpler tasks first for quick wins)
    const complexity = task.classification?.complexity;
    if (complexity === 'trivial') priority -= 0.5;
    if (complexity === 'simple') priority -= 0.25;

    // Adjust for dependencies
    if (task.context?.dependencies?.length > 0) priority += 1;

    // Age factor - older tasks get slight priority boost
    if (task.timestamp) {
      const ageHours = (Date.now() - new Date(task.timestamp)) / (1000 * 60 * 60);
      priority -= Math.min(ageHours * 0.1, 2); // Max 2 point boost
    }

    return Math.max(1, Math.min(10, priority)); // Clamp to 1-10
  }

  /**
   * Optimize using AI
   * @param {Object} newTask - Task to position
   * @param {Object[]} existingTasks - Current queue
   * @returns {Object} Optimization result
   */
  async optimizeWithAI(newTask, existingTasks) {
    const prompt = `You are optimizing a development task queue. Given the new task and existing queue, determine the optimal position.

NEW TASK:
${JSON.stringify(
  {
    description: newTask.description,
    type: newTask.type,
    priority: newTask.queueMetadata?.priority,
    complexity: newTask.classification?.complexity,
    tags: newTask.classification?.tags,
  },
  null,
  2
)}

CURRENT QUEUE (${existingTasks.length} tasks):
${existingTasks
  .slice(0, 10)
  .map((t, i) => `${i}: ${t.description} (priority: ${t.queueMetadata?.priority}, type: ${t.type})`)
  .join('\n')}
${existingTasks.length > 10 ? `... and ${existingTasks.length - 10} more tasks` : ''}

Consider:
1. Priority levels (lower = more urgent)
2. Task dependencies
3. Quick wins (simple tasks first)
4. Blocking issues
5. Age of tasks

Respond with JSON:
{
  "index": <number>,
  "reasoning": "<brief explanation>",
  "adjustedPriority": <optional new priority if should change>
}`;

    const response = await this.llmClient.complete(prompt);
    const result = JSON.parse(response);

    return {
      ...result,
      method: 'ai',
    };
  }

  /**
   * Reorder entire queue based on current state
   * @param {Object[]} tasks - All tasks in queue
   * @returns {Object[]} Reordered tasks
   */
  async reorderQueue(tasks) {
    if (tasks.length <= 1) return tasks;

    // Calculate effective priorities for all tasks
    const scoredTasks = tasks.map((task) => ({
      task,
      effectivePriority: this.calculateEffectivePriority(task),
    }));

    // Sort by effective priority
    scoredTasks.sort((a, b) => a.effectivePriority - b.effectivePriority);

    return scoredTasks.map((st) => st.task);
  }

  /**
   * Suggest priority adjustments based on queue state
   * @param {Object[]} tasks - All tasks
   * @returns {Object[]} Suggested adjustments
   */
  suggestAdjustments(tasks) {
    const suggestions = [];

    // Find stale tasks (old but not high priority)
    const now = Date.now();
    for (const task of tasks) {
      if (!task.timestamp) continue;

      const ageHours = (now - new Date(task.timestamp)) / (1000 * 60 * 60);
      const priority = task.queueMetadata?.priority ?? 5;

      if (ageHours > 24 && priority > 3) {
        suggestions.push({
          taskId: task.id,
          type: 'priority_boost',
          reason: `Task is ${Math.round(ageHours)} hours old`,
          suggestedPriority: Math.max(1, priority - 2),
        });
      }
    }

    // Find blocked tasks that should be deprioritized
    for (const task of tasks) {
      if (task.status === 'blocked' && task.queueMetadata?.priority < 5) {
        suggestions.push({
          taskId: task.id,
          type: 'priority_lower',
          reason: 'Task is blocked, lower priority until unblocked',
          suggestedPriority: 8,
        });
      }
    }

    return suggestions;
  }

  /**
   * Find optimal consumer for a task
   * @param {Object} task - Task to match
   * @param {Object[]} availableConsumers - Available consumers
   * @returns {Object|null} Best matching consumer
   */
  matchConsumer(task, availableConsumers) {
    if (availableConsumers.length === 0) return null;

    const taskType = task.classification?.taskType || task.type;
    const documentType = task.classification?.documentType;

    // Score each consumer
    const scored = availableConsumers.map((consumer) => {
      let score = 0;

      // Type match
      if (consumer.capabilities?.includes(taskType)) score += 10;

      // Document type match
      if (consumer.documentTypes?.includes(documentType)) score += 5;

      // Specialization bonus
      if (consumer.specialization === taskType) score += 3;

      // Load factor (prefer less busy consumers)
      const load = consumer.currentLoad || 0;
      score -= load * 2;

      return { consumer, score };
    });

    // Return highest scoring consumer
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.score > 0 ? scored[0].consumer : null;
  }
}

module.exports = QueueOptimizer;
module.exports.QueueOptimizer = QueueOptimizer;
