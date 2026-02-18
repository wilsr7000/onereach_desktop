/**
 * Base Consumer
 * Part of the Governed Self-Improving Agent Runtime
 *
 * Abstract base class for agents that pull and execute tasks from the queue
 */

const EventEmitter = require('events');

/**
 * Base Consumer
 * All consumers should extend this class
 */
class BaseConsumer extends EventEmitter {
  constructor(queue, options = {}) {
    super();
    this.queue = queue;
    this.id = options.id || `consumer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.name = options.name || 'base-consumer';
    this.capabilities = options.capabilities || [];
    this.documentTypes = options.documentTypes || [];
    this.specialization = options.specialization || null;

    this.isActive = false;
    this.isProcessing = false;
    this.currentTask = null;
    this.tasksCompleted = 0;
    this.tasksFailed = 0;

    this.pollInterval = options.pollInterval || 1000; // 1 second
    this.pollTimer = null;
    this.maxRetries = options.maxRetries || 3;
  }

  /**
   * Start the consumer
   */
  start() {
    if (this.isActive) return;

    this.isActive = true;
    this.startPolling();
    this.emit('started');
  }

  /**
   * Stop the consumer
   */
  stop() {
    this.isActive = false;
    this.stopPolling();
    this.emit('stopped');
  }

  /**
   * Start polling for tasks
   */
  startPolling() {
    this.pollTimer = setInterval(() => {
      if (!this.isProcessing) {
        this.checkForTask();
      }
    }, this.pollInterval);
  }

  /**
   * Stop polling
   */
  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Check for and process next available task
   */
  async checkForTask() {
    const task = this.queue.getNext({
      taskType: this.specialization || undefined,
    });

    if (!task) return;

    // Check if we can handle this task
    if (!this.canHandle(task)) return;

    // Lock the task
    const locked = this.queue.lock(task.id, this.id);
    if (!locked) return;

    // Process the task
    await this.processTask(task);
  }

  /**
   * Check if this consumer can handle a task
   * @param {Object} task - Task to check
   * @returns {boolean}
   */
  canHandle(task) {
    // Check capabilities
    const taskType = task.classification?.taskType || task.type;
    if (this.capabilities.length > 0 && !this.capabilities.includes(taskType)) {
      return false;
    }

    // Check document types
    const docType = task.classification?.documentType;
    if (this.documentTypes.length > 0 && docType && !this.documentTypes.includes(docType)) {
      return false;
    }

    return true;
  }

  /**
   * Process a task
   * @param {Object} task - Task to process
   */
  async processTask(task) {
    this.isProcessing = true;
    this.currentTask = task;
    this.emit('task:started', task);

    try {
      // Execute the task
      const result = await this.execute(task);

      // Complete the task
      this.queue.complete(task.id, result);
      this.tasksCompleted++;
      this.emit('task:completed', task, result);
    } catch (error) {
      // Fail the task
      this.queue.fail(task.id, error);
      this.tasksFailed++;
      this.emit('task:failed', task, error);
    } finally {
      this.isProcessing = false;
      this.currentTask = null;
    }
  }

  /**
   * Execute a task (override in subclass)
   * @param {Object} task - Task to execute
   * @returns {Object} Result
   */
  async execute(_task) {
    throw new Error('execute() must be implemented by subclass');
  }

  /**
   * Get consumer statistics
   * @returns {Object}
   */
  getStats() {
    return {
      id: this.id,
      name: this.name,
      isActive: this.isActive,
      isProcessing: this.isProcessing,
      currentTask: this.currentTask?.id || null,
      tasksCompleted: this.tasksCompleted,
      tasksFailed: this.tasksFailed,
      successRate: this.tasksCompleted / Math.max(1, this.tasksCompleted + this.tasksFailed),
      capabilities: this.capabilities,
      specialization: this.specialization,
    };
  }

  /**
   * Destroy the consumer
   */
  destroy() {
    this.stop();
    this.removeAllListeners();
  }
}

/**
 * Aider Consumer
 * Executes code generation and refactoring tasks via Aider
 */
class AiderConsumer extends BaseConsumer {
  constructor(queue, options = {}) {
    super(queue, {
      name: 'aider-consumer',
      capabilities: ['code_generation', 'code_refactor', 'bug_fix', 'test_generation'],
      documentTypes: ['code', 'test'],
      specialization: null,
      ...options,
    });

    this.aiderBridge = options.aiderBridge;
  }

  /**
   * Execute a code task
   * @param {Object} task - Task to execute
   * @returns {Object} Result
   */
  async execute(task) {
    if (!this.aiderBridge) {
      throw new Error('Aider bridge not configured');
    }

    const result = await this.aiderBridge.sendPrompt(task.description, {
      files: task.context?.files,
      ...task.context,
    });

    return {
      success: result.success,
      response: result.response,
      filesChanged: result.filesChanged,
      tokensUsed: result.tokensUsed,
    };
  }
}

/**
 * Evaluation Consumer
 * Executes evaluation tasks
 */
class EvaluationConsumer extends BaseConsumer {
  constructor(queue, options = {}) {
    super(queue, {
      name: 'evaluation-consumer',
      capabilities: ['evaluation'],
      documentTypes: [],
      specialization: 'evaluation',
      ...options,
    });

    this.evaluationService = options.evaluationService;
  }

  /**
   * Execute an evaluation task
   * @param {Object} task - Task to execute
   * @returns {Object} Result
   */
  async execute(task) {
    if (!this.evaluationService) {
      throw new Error('Evaluation service not configured');
    }

    const content = task.context?.content;
    if (!content) {
      throw new Error('No content to evaluate');
    }

    const result = await this.evaluationService.runFullEvaluation(content, {
      profile: task.context?.profile || 'standard',
      documentType: task.classification?.documentType,
    });

    return result;
  }
}

/**
 * Improvement Consumer
 * Executes improvement tasks from evaluations
 */
class ImprovementConsumer extends BaseConsumer {
  constructor(queue, options = {}) {
    super(queue, {
      name: 'improvement-consumer',
      capabilities: ['improvement'],
      documentTypes: ['code'],
      specialization: 'improvement',
      ...options,
    });

    this.aiderBridge = options.aiderBridge;
  }

  /**
   * Execute an improvement task
   * @param {Object} task - Task to execute
   * @returns {Object} Result
   */
  async execute(task) {
    if (!this.aiderBridge) {
      throw new Error('Aider bridge not configured');
    }

    // Build prompt from suggestion
    const applySuggestion = task.context?.applySuggestion;
    const prompt = applySuggestion ? `Apply this improvement: ${applySuggestion}` : task.description;

    const result = await this.aiderBridge.sendPrompt(prompt, {
      ...task.context,
    });

    return {
      success: result.success,
      response: result.response,
      filesChanged: result.filesChanged,
      appliedSuggestion: !!applySuggestion,
    };
  }
}

/**
 * Recovery Consumer
 * Executes recovery tasks for error handling
 */
class RecoveryConsumer extends BaseConsumer {
  constructor(queue, options = {}) {
    super(queue, {
      name: 'recovery-consumer',
      capabilities: ['recovery'],
      documentTypes: [],
      specialization: 'recovery',
      pollInterval: 500, // Check more frequently
      ...options,
    });

    this.appManagerAgent = options.appManagerAgent;
  }

  /**
   * Execute a recovery task
   * @param {Object} task - Task to execute
   * @returns {Object} Result
   */
  async execute(task) {
    if (!this.appManagerAgent) {
      throw new Error('App Manager Agent not configured');
    }

    const error = task.context?.error;
    if (!error) {
      throw new Error('No error to recover from');
    }

    // Diagnose and fix
    const diagnosis = await this.appManagerAgent.diagnose(error);
    const result = await this.appManagerAgent.applyFix(diagnosis);

    return {
      success: result.success,
      strategy: diagnosis.strategy,
      fixed: result.success,
      rollbackAvailable: result.rollbackAvailable,
    };
  }
}

/**
 * Undo Consumer
 * Executes undo tasks
 */
class UndoConsumer extends BaseConsumer {
  constructor(queue, options = {}) {
    super(queue, {
      name: 'undo-consumer',
      capabilities: ['undo'],
      documentTypes: [],
      specialization: 'undo',
      ...options,
    });

    this.fileSnapshots = options.fileSnapshots;
  }

  /**
   * Execute an undo task
   * @param {Object} task - Task to execute
   * @returns {Object} Result
   */
  async execute(task) {
    const originalTaskId = task.parentId || task.context?.originalTask?.id;

    if (!originalTaskId) {
      throw new Error('No original task to undo');
    }

    if (this.fileSnapshots) {
      const result = await this.fileSnapshots.restore(originalTaskId);
      return {
        success: result.failed.length === 0,
        restored: result.restored,
        deleted: result.deleted,
        failed: result.failed,
      };
    }

    // Fallback: apply inverse file changes from task
    const filesAffected = task.filesAffected || [];
    const fs = require('fs');
    const restored = [];
    const failed = [];

    for (const file of filesAffected) {
      try {
        if (file.after !== null) {
          // File existed before, restore it
          fs.writeFileSync(file.path, file.after);
          restored.push(file.path);
        } else if (file.before !== null) {
          // File was created, delete it
          fs.unlinkSync(file.path);
          restored.push(file.path);
        }
      } catch (error) {
        failed.push({ path: file.path, error: error.message });
      }
    }

    return {
      success: failed.length === 0,
      restored,
      failed,
    };
  }
}

module.exports = {
  BaseConsumer,
  AiderConsumer,
  EvaluationConsumer,
  ImprovementConsumer,
  RecoveryConsumer,
  UndoConsumer,
};
