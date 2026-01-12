/**
 * Enhanced Event Schema
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Defines the structure for events in the unified task queue
 */

const crypto = require('crypto');

/**
 * Task types supported by the system
 */
const TASK_TYPES = {
  CODE_GENERATION: 'code_generation',
  CODE_REFACTOR: 'code_refactor',
  BUG_FIX: 'bug_fix',
  TEST_GENERATION: 'test_generation',
  DOCUMENTATION: 'documentation',
  EVALUATION: 'evaluation',
  IMPROVEMENT: 'improvement',
  RESEARCH: 'research',
  PLANNING: 'planning'
};

/**
 * Task complexity levels
 */
const COMPLEXITY = {
  TRIVIAL: 'trivial',     // < 5 min
  SIMPLE: 'simple',       // 5-15 min
  MODERATE: 'moderate',   // 15-60 min
  COMPLEX: 'complex',     // 1-4 hours
  MAJOR: 'major'          // > 4 hours
};

/**
 * Task status values
 */
const TASK_STATUS = {
  PENDING: 'pending',
  QUEUED: 'queued',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  BLOCKED: 'blocked'
};

/**
 * Create a new task event
 * @param {Object} options - Task options
 * @returns {Object} Task event object
 */
function createTaskEvent(options = {}) {
  const id = options.id || `task-${crypto.randomUUID()}`;
  const timestamp = options.timestamp || new Date().toISOString();

  return {
    // Core identification
    id,
    timestamp,
    type: options.type || TASK_TYPES.CODE_GENERATION,
    
    // Source tracking
    agent: options.agent || 'user',
    source: options.source || 'manual',
    
    // Classification for intelligent routing
    classification: {
      taskType: options.taskType || TASK_TYPES.CODE_GENERATION,
      complexity: options.complexity || COMPLEXITY.MODERATE,
      documentType: options.documentType || 'code',
      tags: options.tags || [],
      priority: options.priority ?? 5  // 1-10, lower is higher priority
    },
    
    // File tracking for undo/history
    filesAffected: options.filesAffected || [],
    // Each file entry: { path, before, after, diff }
    
    // Evaluation results (populated after evaluation)
    evaluation: options.evaluation || null,
    // Structure: { rubric, scores, passed, agentScores, consolidatedScore }
    
    // Queue metadata
    queueMetadata: {
      addedBy: options.addedBy || options.agent || 'user',
      addedAt: timestamp,
      priority: options.priority ?? 5,
      locked: false,
      lockedBy: null,
      lockedAt: null,
      timeout: options.timeout || 300000, // 5 minutes default
      attempts: 0,
      maxAttempts: options.maxAttempts || 3,
      completedAt: null,
      duration: null
    },
    
    // Task content
    description: options.description || '',
    context: options.context || {},
    
    // Status tracking
    status: options.status || TASK_STATUS.PENDING,
    
    // Error tracking
    error: null,
    
    // Parent/child relationships for composite tasks
    parentId: options.parentId || null,
    childIds: options.childIds || [],
    
    // Undo support
    undoable: options.undoable !== false,
    undoData: null
  };
}

/**
 * Create a file affected entry
 * @param {string} path - File path
 * @param {string} before - Content before change
 * @param {string} after - Content after change
 * @returns {Object} File affected entry
 */
function createFileAffected(path, before = null, after = null) {
  let diff = null;
  
  if (before !== null && after !== null) {
    // Simple diff calculation (in production, use a proper diff library)
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    diff = {
      linesAdded: afterLines.length - beforeLines.length,
      changeType: before === '' ? 'created' : after === '' ? 'deleted' : 'modified'
    };
  }

  return {
    path,
    before,
    after,
    diff,
    timestamp: new Date().toISOString()
  };
}

/**
 * Create an evaluation result
 * @param {Object} options - Evaluation options
 * @returns {Object} Evaluation result
 */
function createEvaluationResult(options = {}) {
  return {
    rubric: options.rubric || 'default',
    scores: options.scores || {},
    passed: options.passed ?? true,
    
    // Multi-agent evaluation data
    agentScores: options.agentScores || [],
    // Each: { agentType, agentId, overallScore, criteria, confidence }
    
    consolidatedScore: options.consolidatedScore || null,
    // Structure from consolidator with epistemic framing
    
    conflicts: options.conflicts || [],
    suggestions: options.suggestions || [],
    
    evaluatedAt: options.evaluatedAt || new Date().toISOString(),
    evaluationDuration: options.evaluationDuration || null
  };
}

/**
 * Validate a task event
 * @param {Object} task - Task to validate
 * @returns {Object} Validation result { valid, errors }
 */
function validateTaskEvent(task) {
  const errors = [];

  if (!task.id) errors.push('Missing task id');
  if (!task.timestamp) errors.push('Missing timestamp');
  if (!task.type) errors.push('Missing task type');
  if (!Object.values(TASK_TYPES).includes(task.type)) {
    errors.push(`Invalid task type: ${task.type}`);
  }
  if (!task.description) errors.push('Missing description');
  if (typeof task.queueMetadata?.priority !== 'number') {
    errors.push('Priority must be a number');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Clone a task for undo
 * @param {Object} task - Task to clone
 * @returns {Object} Cloned task with undo metadata
 */
function createUndoTask(task) {
  return createTaskEvent({
    ...task,
    id: `undo-${task.id}`,
    type: 'undo',
    description: `Undo: ${task.description}`,
    parentId: task.id,
    context: {
      ...task.context,
      originalTask: task,
      undoReason: 'user_requested'
    },
    // Reverse the file changes
    filesAffected: task.filesAffected.map(f => ({
      path: f.path,
      before: f.after,
      after: f.before,
      diff: f.diff ? { ...f.diff, changeType: 'reverted' } : null
    }))
  });
}

module.exports = {
  TASK_TYPES,
  COMPLEXITY,
  TASK_STATUS,
  createTaskEvent,
  createFileAffected,
  createEvaluationResult,
  validateTaskEvent,
  createUndoTask
};

