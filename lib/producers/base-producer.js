/**
 * Base Producer
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Abstract base class for agents that add tasks to the queue
 */

const EventEmitter = require('events');

/**
 * Base Producer
 * All producers should extend this class
 */
class BaseProducer extends EventEmitter {
  constructor(queue, options = {}) {
    super();
    this.queue = queue;
    this.name = options.name || 'base-producer';
    this.type = options.type || 'generic';
    this.isActive = false;
    this.tasksProduced = 0;
    this.defaultPriority = options.defaultPriority ?? 5;
    this.defaultTimeout = options.defaultTimeout || 300000; // 5 min
  }

  /**
   * Start the producer
   */
  start() {
    this.isActive = true;
    this.emit('started');
  }

  /**
   * Stop the producer
   */
  stop() {
    this.isActive = false;
    this.emit('stopped');
  }

  /**
   * Add a task to the queue
   * @param {Object} taskData - Task data
   * @returns {Object} Created task
   */
  produce(taskData) {
    if (!this.isActive) {
      throw new Error(`Producer ${this.name} is not active`);
    }

    const task = this.queue.add({
      ...taskData,
      agent: taskData.agent || this.name,
      addedBy: this.name,
      priority: taskData.priority ?? this.defaultPriority,
      timeout: taskData.timeout || this.defaultTimeout
    });

    this.tasksProduced++;
    this.emit('task:produced', task);
    
    return task;
  }

  /**
   * Produce multiple tasks
   * @param {Object[]} taskDataArray - Array of task data
   * @returns {Object[]} Created tasks
   */
  produceMany(taskDataArray) {
    return taskDataArray.map(data => this.produce(data));
  }

  /**
   * Get producer statistics
   * @returns {Object}
   */
  getStats() {
    return {
      name: this.name,
      type: this.type,
      isActive: this.isActive,
      tasksProduced: this.tasksProduced
    };
  }
}

/**
 * Aider Producer
 * Produces code generation and refactoring tasks
 */
class AiderProducer extends BaseProducer {
  constructor(queue, options = {}) {
    super(queue, {
      name: 'aider',
      type: 'code',
      defaultPriority: 5,
      ...options
    });
  }

  /**
   * Create a code generation task
   * @param {string} description - Task description
   * @param {Object} options - Additional options
   * @returns {Object} Created task
   */
  generateCode(description, options = {}) {
    return this.produce({
      type: 'code_generation',
      description,
      classification: {
        taskType: 'code_generation',
        documentType: 'code',
        ...options.classification
      },
      context: options.context || {},
      filesAffected: options.files || [],
      ...options
    });
  }

  /**
   * Create a refactoring task
   * @param {string} description - Task description
   * @param {string[]} files - Files to refactor
   * @param {Object} options - Additional options
   * @returns {Object} Created task
   */
  refactor(description, files, options = {}) {
    return this.produce({
      type: 'code_refactor',
      description,
      classification: {
        taskType: 'code_refactor',
        documentType: 'code',
        ...options.classification
      },
      context: { files, ...options.context },
      filesAffected: files.map(f => ({ path: f })),
      ...options
    });
  }

  /**
   * Create a bug fix task
   * @param {string} description - Bug description
   * @param {Object} options - Additional options
   * @returns {Object} Created task
   */
  fixBug(description, options = {}) {
    return this.produce({
      type: 'bug_fix',
      description,
      priority: options.priority ?? 3, // Higher priority for bugs
      classification: {
        taskType: 'bug_fix',
        documentType: 'code',
        ...options.classification
      },
      context: options.context || {},
      ...options
    });
  }

  /**
   * Create a test generation task
   * @param {string} description - What to test
   * @param {string[]} files - Files to generate tests for
   * @param {Object} options - Additional options
   * @returns {Object} Created task
   */
  generateTests(description, files, options = {}) {
    return this.produce({
      type: 'test_generation',
      description,
      classification: {
        taskType: 'test_generation',
        documentType: 'test',
        ...options.classification
      },
      context: { files, ...options.context },
      ...options
    });
  }
}

/**
 * Evaluation Producer
 * Produces evaluation tasks from multi-agent assessments
 */
class EvaluationProducer extends BaseProducer {
  constructor(queue, options = {}) {
    super(queue, {
      name: 'evaluator',
      type: 'evaluation',
      defaultPriority: 6, // Slightly lower than code tasks
      ...options
    });
  }

  /**
   * Create task from evaluation suggestion
   * @param {Object} suggestion - Suggestion from evaluation
   * @param {Object} context - Evaluation context
   * @returns {Object} Created task
   */
  fromSuggestion(suggestion, context = {}) {
    const priority = suggestion.priority === 'high' ? 2 : 
                     suggestion.priority === 'medium' ? 5 : 8;

    return this.produce({
      type: 'improvement',
      description: suggestion.text,
      priority,
      classification: {
        taskType: 'improvement',
        documentType: context.documentType || 'code',
        tags: ['from-evaluation']
      },
      context: {
        ...context,
        suggestionId: suggestion.id,
        originatingAgents: suggestion.originatingAgents,
        confidence: suggestion.confidence,
        applySuggestion: suggestion.applySuggestion
      }
    });
  }

  /**
   * Create tasks from all high-priority suggestions
   * @param {Object[]} suggestions - Evaluation suggestions
   * @param {Object} context - Evaluation context
   * @returns {Object[]} Created tasks
   */
  fromHighPrioritySuggestions(suggestions, context = {}) {
    const highPriority = suggestions.filter(s => s.priority === 'high');
    return highPriority.map(s => this.fromSuggestion(s, context));
  }

  /**
   * Create evaluation request task
   * @param {string} content - Content to evaluate
   * @param {Object} options - Evaluation options
   * @returns {Object} Created task
   */
  requestEvaluation(content, options = {}) {
    return this.produce({
      type: 'evaluation',
      description: 'Evaluate content quality',
      priority: options.priority ?? 4,
      classification: {
        taskType: 'evaluation',
        documentType: options.documentType || 'code'
      },
      context: {
        content: content.slice(0, 10000), // Limit content size
        profile: options.profile || 'standard',
        ...options.context
      }
    });
  }
}

/**
 * User Producer
 * Produces tasks from user interactions
 */
class UserProducer extends BaseProducer {
  constructor(queue, options = {}) {
    super(queue, {
      name: 'user',
      type: 'user',
      defaultPriority: 4, // User tasks have higher priority
      ...options
    });
    this.isActive = true; // Always active
  }

  /**
   * Create task from user request
   * @param {string} request - User's request
   * @param {Object} options - Additional options
   * @returns {Object} Created task
   */
  request(request, options = {}) {
    return this.produce({
      type: options.type || 'code_generation',
      description: request,
      source: 'user',
      classification: {
        taskType: options.type || 'code_generation',
        ...options.classification
      },
      context: options.context || {},
      ...options
    });
  }

  /**
   * Create undo task
   * @param {string} taskId - Task ID to undo
   * @param {Object} options - Additional options
   * @returns {Object} Created task
   */
  requestUndo(taskId, options = {}) {
    return this.queue.requestUndo(taskId);
  }

  /**
   * Create prioritized task
   * @param {string} request - User's request
   * @param {number} priority - Priority level (1-10)
   * @param {Object} options - Additional options
   * @returns {Object} Created task
   */
  priorityRequest(request, priority, options = {}) {
    return this.request(request, { ...options, priority });
  }
}

/**
 * System Producer
 * Produces tasks from system events and automation
 */
class SystemProducer extends BaseProducer {
  constructor(queue, options = {}) {
    super(queue, {
      name: 'system',
      type: 'system',
      defaultPriority: 7, // Lower priority for system tasks
      ...options
    });
    this.isActive = true;
  }

  /**
   * Create maintenance task
   * @param {string} description - Maintenance description
   * @param {Object} options - Additional options
   * @returns {Object} Created task
   */
  maintenance(description, options = {}) {
    return this.produce({
      type: 'maintenance',
      description,
      classification: {
        taskType: 'maintenance',
        tags: ['system', 'automated']
      },
      ...options
    });
  }

  /**
   * Create scheduled task
   * @param {string} description - Task description
   * @param {Date} scheduledFor - When to execute
   * @param {Object} options - Additional options
   * @returns {Object} Created task
   */
  schedule(description, scheduledFor, options = {}) {
    return this.produce({
      type: options.type || 'scheduled',
      description,
      classification: {
        taskType: 'scheduled',
        tags: ['system', 'scheduled']
      },
      context: {
        scheduledFor: scheduledFor.toISOString(),
        ...options.context
      },
      ...options
    });
  }

  /**
   * Create recovery task from error
   * @param {Object} error - Error details
   * @param {Object} options - Additional options
   * @returns {Object} Created task
   */
  recovery(error, options = {}) {
    return this.produce({
      type: 'recovery',
      description: `Recover from: ${error.message || error.type}`,
      priority: options.priority ?? 2, // High priority for recovery
      classification: {
        taskType: 'recovery',
        tags: ['system', 'recovery', 'automated']
      },
      context: {
        error: {
          type: error.type,
          message: error.message,
          details: error.details
        },
        ...options.context
      },
      ...options
    });
  }
}

module.exports = {
  BaseProducer,
  AiderProducer,
  EvaluationProducer,
  UserProducer,
  SystemProducer
};


