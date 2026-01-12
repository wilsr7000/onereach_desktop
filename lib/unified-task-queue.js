/**
 * Unified Task Queue
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Single queue filterable by time, agent, and file
 * Supports producers, consumers, locking, timeout, and undo
 */

const EventEmitter = require('events');
const { createTaskEvent, TASK_STATUS } = require('./event-schema');

/**
 * Unified Task Queue
 * Central queue for all tasks in the system
 */
class UnifiedTaskQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this.tasks = new Map();         // id -> task
    this.queue = [];                // Ordered task IDs
    this.undoQueue = [];            // Tasks available for undo
    this.lockedTasks = new Map();   // id -> { lockedBy, lockedAt, timeout }
    
    // Configuration
    this.defaultTimeout = options.defaultTimeout || 300000; // 5 minutes
    this.maxUndoHistory = options.maxUndoHistory || 50;
    this.cleanupInterval = options.cleanupInterval || 60000; // 1 minute
    
    // Start cleanup timer
    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupInterval);
  }

  /**
   * Add a task to the queue
   * @param {Object} taskData - Task data
   * @returns {Object} Created task
   */
  add(taskData) {
    const task = createTaskEvent({
      ...taskData,
      status: TASK_STATUS.QUEUED
    });

    this.tasks.set(task.id, task);
    
    // Insert at correct position based on priority
    const insertIndex = this.findInsertIndex(task);
    this.queue.splice(insertIndex, 0, task.id);
    
    this.emit('task:added', task);
    return task;
  }

  /**
   * Find the correct insert index based on priority
   * @param {Object} task - Task to insert
   * @returns {number} Insert index
   */
  findInsertIndex(task) {
    const priority = task.queueMetadata?.priority ?? 5;
    
    for (let i = 0; i < this.queue.length; i++) {
      const existingTask = this.tasks.get(this.queue[i]);
      const existingPriority = existingTask?.queueMetadata?.priority ?? 5;
      
      if (priority < existingPriority) {
        return i;
      }
    }
    
    return this.queue.length;
  }

  /**
   * Get the next available task
   * @param {Object} filter - Optional filter criteria
   * @returns {Object|null} Next task or null
   */
  getNext(filter = {}) {
    for (const taskId of this.queue) {
      const task = this.tasks.get(taskId);
      
      if (!task) continue;
      if (task.status !== TASK_STATUS.QUEUED) continue;
      if (this.lockedTasks.has(taskId)) continue;
      
      // Apply filters
      if (filter.agent && task.agent !== filter.agent) continue;
      if (filter.taskType && task.classification?.taskType !== filter.taskType) continue;
      if (filter.documentType && task.classification?.documentType !== filter.documentType) continue;
      
      return task;
    }
    
    return null;
  }

  /**
   * Lock a task for processing
   * @param {string} taskId - Task ID
   * @param {string} consumerId - Consumer identifier
   * @returns {boolean} Success
   */
  lock(taskId, consumerId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (this.lockedTasks.has(taskId)) return false;
    
    const lockData = {
      lockedBy: consumerId,
      lockedAt: new Date().toISOString(),
      timeout: task.queueMetadata?.timeout || this.defaultTimeout
    };
    
    this.lockedTasks.set(taskId, lockData);
    
    task.status = TASK_STATUS.IN_PROGRESS;
    task.queueMetadata.locked = true;
    task.queueMetadata.lockedBy = consumerId;
    task.queueMetadata.lockedAt = lockData.lockedAt;
    
    this.emit('task:locked', task, consumerId);
    return true;
  }

  /**
   * Unlock a task
   * @param {string} taskId - Task ID
   * @param {string} consumerId - Consumer identifier (must match lock)
   * @returns {boolean} Success
   */
  unlock(taskId, consumerId) {
    const lockData = this.lockedTasks.get(taskId);
    if (!lockData) return false;
    if (lockData.lockedBy !== consumerId) return false;
    
    const task = this.tasks.get(taskId);
    if (task) {
      task.queueMetadata.locked = false;
      task.queueMetadata.lockedBy = null;
      task.queueMetadata.lockedAt = null;
      task.status = TASK_STATUS.QUEUED;
    }
    
    this.lockedTasks.delete(taskId);
    this.emit('task:unlocked', task, consumerId);
    return true;
  }

  /**
   * Complete a task
   * @param {string} taskId - Task ID
   * @param {Object} result - Task result
   * @returns {boolean} Success
   */
  complete(taskId, result = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    
    task.status = TASK_STATUS.COMPLETED;
    task.queueMetadata.completedAt = new Date().toISOString();
    task.queueMetadata.duration = 
      new Date(task.queueMetadata.completedAt) - new Date(task.queueMetadata.addedAt);
    task.result = result;
    
    // Remove from active queue
    const index = this.queue.indexOf(taskId);
    if (index > -1) {
      this.queue.splice(index, 1);
    }
    
    // Remove lock
    this.lockedTasks.delete(taskId);
    
    // Add to undo queue if undoable
    if (task.undoable) {
      this.undoQueue.unshift(taskId);
      if (this.undoQueue.length > this.maxUndoHistory) {
        const removed = this.undoQueue.pop();
        this.tasks.delete(removed);
      }
    }
    
    this.emit('task:completed', task, result);
    return true;
  }

  /**
   * Fail a task
   * @param {string} taskId - Task ID
   * @param {Error|string} error - Error details
   * @returns {boolean} Success
   */
  fail(taskId, error) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    
    task.queueMetadata.attempts++;
    
    if (task.queueMetadata.attempts < task.queueMetadata.maxAttempts) {
      // Retry - put back in queue
      task.status = TASK_STATUS.QUEUED;
      task.queueMetadata.locked = false;
      this.lockedTasks.delete(taskId);
      this.emit('task:retry', task, task.queueMetadata.attempts);
    } else {
      // Max attempts reached - mark as failed
      task.status = TASK_STATUS.FAILED;
      task.error = error instanceof Error ? error.message : String(error);
      
      const index = this.queue.indexOf(taskId);
      if (index > -1) {
        this.queue.splice(index, 1);
      }
      this.lockedTasks.delete(taskId);
      this.emit('task:failed', task, error);
    }
    
    return true;
  }

  /**
   * Get a task by ID
   * @param {string} taskId - Task ID
   * @returns {Object|null}
   */
  get(taskId) {
    return this.tasks.get(taskId) || null;
  }

  /**
   * Query tasks with filters
   * @param {Object} filters - Filter criteria
   * @returns {Object[]} Matching tasks
   */
  query(filters = {}) {
    let results = [...this.tasks.values()];
    
    if (filters.status) {
      results = results.filter(t => t.status === filters.status);
    }
    if (filters.agent) {
      results = results.filter(t => t.agent === filters.agent);
    }
    if (filters.taskType) {
      results = results.filter(t => t.classification?.taskType === filters.taskType);
    }
    if (filters.file) {
      results = results.filter(t => 
        t.filesAffected?.some(f => f.path === filters.file || f.path.includes(filters.file))
      );
    }
    if (filters.since) {
      const sinceDate = new Date(filters.since);
      results = results.filter(t => new Date(t.timestamp) >= sinceDate);
    }
    if (filters.until) {
      const untilDate = new Date(filters.until);
      results = results.filter(t => new Date(t.timestamp) <= untilDate);
    }
    
    // Sort by timestamp (newest first) or priority
    if (filters.sortBy === 'priority') {
      results.sort((a, b) => 
        (a.queueMetadata?.priority ?? 5) - (b.queueMetadata?.priority ?? 5)
      );
    } else {
      results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }
    
    // Apply limit
    if (filters.limit) {
      results = results.slice(0, filters.limit);
    }
    
    return results;
  }

  /**
   * Get tasks that can be undone
   * @returns {Object[]}
   */
  getUndoable() {
    return this.undoQueue
      .map(id => this.tasks.get(id))
      .filter(Boolean);
  }

  /**
   * Request undo for a task
   * @param {string} taskId - Task ID to undo
   * @returns {Object} Undo task
   */
  requestUndo(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || !task.undoable) {
      throw new Error('Task cannot be undone');
    }
    
    const undoTask = createTaskEvent({
      type: 'undo',
      description: `Undo: ${task.description}`,
      agent: 'undo-agent',
      parentId: taskId,
      priority: 1, // High priority
      context: {
        originalTask: task,
        undoReason: 'user_requested'
      },
      filesAffected: task.filesAffected?.map(f => ({
        path: f.path,
        before: f.after,
        after: f.before
      })) || []
    });
    
    return this.add(undoTask);
  }

  /**
   * Update task priority
   * @param {string} taskId - Task ID
   * @param {number} newPriority - New priority (1-10)
   * @returns {boolean} Success
   */
  updatePriority(taskId, newPriority) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    
    task.queueMetadata.priority = newPriority;
    task.classification.priority = newPriority;
    
    // Reorder queue
    const index = this.queue.indexOf(taskId);
    if (index > -1) {
      this.queue.splice(index, 1);
      const newIndex = this.findInsertIndex(task);
      this.queue.splice(newIndex, 0, taskId);
    }
    
    this.emit('task:priority-changed', task, newPriority);
    return true;
  }

  /**
   * Get queue statistics
   * @returns {Object}
   */
  getStats() {
    const tasks = [...this.tasks.values()];
    
    return {
      total: tasks.length,
      queued: tasks.filter(t => t.status === TASK_STATUS.QUEUED).length,
      inProgress: tasks.filter(t => t.status === TASK_STATUS.IN_PROGRESS).length,
      completed: tasks.filter(t => t.status === TASK_STATUS.COMPLETED).length,
      failed: tasks.filter(t => t.status === TASK_STATUS.FAILED).length,
      locked: this.lockedTasks.size,
      undoable: this.undoQueue.length,
      queueLength: this.queue.length
    };
  }

  /**
   * Cleanup expired locks and old tasks
   */
  cleanup() {
    const now = Date.now();
    
    // Unlock expired tasks
    for (const [taskId, lockData] of this.lockedTasks.entries()) {
      const lockTime = new Date(lockData.lockedAt).getTime();
      if (now - lockTime > lockData.timeout) {
        this.unlock(taskId, lockData.lockedBy);
        this.emit('task:timeout', this.tasks.get(taskId));
      }
    }
  }

  /**
   * Clear the queue
   */
  clear() {
    this.tasks.clear();
    this.queue = [];
    this.undoQueue = [];
    this.lockedTasks.clear();
    this.emit('queue:cleared');
  }

  /**
   * Destroy the queue
   */
  destroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.clear();
    this.removeAllListeners();
  }
}

module.exports = UnifiedTaskQueue;
module.exports.UnifiedTaskQueue = UnifiedTaskQueue;

