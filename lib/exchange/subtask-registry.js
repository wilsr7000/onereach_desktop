/**
 * Subtask Registry - Allows agents to spawn discrete subtasks during execution.
 *
 * Extracted from exchange-bridge.js. Manages subtask creation, routing,
 * context passing, input schema processing, and cleanup.
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

// ==================== SUBTASK STATE ====================
const subtaskRegistry = new Map(); // subtaskId -> { parentTaskId, routingMode, lockedAgentId, context }
const parentTaskSubtasks = new Map(); // parentTaskId -> [subtaskIds]

// Injected references (set via setExchangeInstance / setBroadcast)
let _exchangeInstance = null;
let _broadcastToWindows = null;

function setExchangeInstance(exchange) {
  _exchangeInstance = exchange;
}
function setBroadcast(fn) {
  _broadcastToWindows = fn;
}

// ==================== SUBTASK API ====================

/**
 * Submit a subtask from within an agent's execute() method
 */
async function submitSubtask({
  parentTaskId,
  content,
  routingMode = 'open',
  lockedAgentId,
  context = {},
  priority = 2,
}) {
  if (!_exchangeInstance) {
    log.error('voice', '[SubtaskAPI] Exchange not initialized');
    return { subtaskId: null, queued: false, error: 'Exchange not initialized' };
  }

  if (!parentTaskId || !content) {
    log.error('voice', '[SubtaskAPI] Missing required params: parentTaskId, content');
    return { subtaskId: null, queued: false, error: 'Missing required params' };
  }

  if (routingMode === 'locked' && !lockedAgentId) {
    log.error('voice', '[SubtaskAPI] Locked routing requires lockedAgentId');
    return { subtaskId: null, queued: false, error: 'Locked routing requires lockedAgentId' };
  }

  try {
    log.info('voice', '[SubtaskAPI] Submitting subtask for parent : "..."', {
      v0: parentTaskId,
      v1: content.slice(0, 50),
    });

    const { taskId: subtaskId, task } = await _exchangeInstance.submit({
      content,
      priority,
      metadata: {
        source: 'subtask',
        parentTaskId,
        routingMode,
        lockedAgentId: routingMode === 'locked' ? lockedAgentId : null,
        subtaskContext: context,
        timestamp: Date.now(),
      },
    });

    subtaskRegistry.set(subtaskId, {
      parentTaskId,
      routingMode,
      lockedAgentId,
      context,
      createdAt: Date.now(),
    });

    if (!parentTaskSubtasks.has(parentTaskId)) {
      parentTaskSubtasks.set(parentTaskId, []);
    }
    parentTaskSubtasks.get(parentTaskId).push(subtaskId);

    log.info('voice', '[SubtaskAPI] Subtask queued (parent: , routing: )', {
      v0: subtaskId,
      v1: parentTaskId,
      v2: routingMode,
    });

    if (_broadcastToWindows) {
      _broadcastToWindows('subtask:created', {
        subtaskId,
        parentTaskId,
        content,
        routingMode,
        lockedAgentId,
        subtaskIndex: parentTaskSubtasks.get(parentTaskId).length,
      });
    }

    return { subtaskId, queued: true, task };
  } catch (error) {
    log.error('voice', '[SubtaskAPI] Failed to submit subtask', { error: error.message });
    return { subtaskId: null, queued: false, error: error.message };
  }
}

function isSubtask(task) {
  return task?.metadata?.source === 'subtask' && task?.metadata?.parentTaskId;
}

function getSubtaskRouting(task) {
  if (!isSubtask(task)) {
    return { locked: false, agentId: null };
  }
  const { routingMode, lockedAgentId } = task.metadata;
  if (routingMode === 'locked' && lockedAgentId) {
    return { locked: true, agentId: lockedAgentId };
  }
  return { locked: false, agentId: null };
}

function getSubtaskContext(task) {
  if (!isSubtask(task)) return {};
  return task.metadata?.subtaskContext || {};
}

function getSubtasksForParent(parentTaskId) {
  return parentTaskSubtasks.get(parentTaskId) || [];
}

function cleanupSubtasks(parentTaskId) {
  const subtaskIds = parentTaskSubtasks.get(parentTaskId) || [];
  for (const id of subtaskIds) {
    subtaskRegistry.delete(id);
  }
  parentTaskSubtasks.delete(parentTaskId);
  log.info('voice', '[SubtaskAPI] Cleaned up subtasks for parent', { v0: subtaskIds.length, v1: parentTaskId });
}

function createSubtaskSubmitter(taskId, agentId) {
  const submit = (options) =>
    submitSubtask({
      ...options,
      parentTaskId: taskId,
      routingMode: options.routingMode || 'open',
      lockedAgentId: options.routingMode === 'locked' ? options.lockedAgentId || agentId : undefined,
    });

  submit.andWait = (options) => {
    const timeoutMs = options.timeoutMs || 60000;

    return new Promise(async (resolve, reject) => {
      const { subtaskId, queued, error } = await submit(options);

      if (!queued || !subtaskId) {
        reject(new Error(error || 'Failed to submit subtask'));
        return;
      }

      let settled = false;

      const onSettled = ({ task, result }) => {
        if (task.id !== subtaskId) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const onDeadLetter = ({ task }) => {
        if (task.id !== subtaskId) return;
        settled = true;
        cleanup();
        reject(new Error(`Subtask ${subtaskId} dead-lettered`));
      };

      const onBusted = ({ task, error: _bustError, backupsRemaining }) => {
        if (task.id !== subtaskId || backupsRemaining > 0) return;
      };

      const timeout = setTimeout(() => {
        if (!settled) {
          cleanup();
          reject(new Error(`Subtask ${subtaskId} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      function cleanup() {
        clearTimeout(timeout);
        if (_exchangeInstance) {
          _exchangeInstance.off('task:settled', onSettled);
          _exchangeInstance.off('task:dead_letter', onDeadLetter);
          _exchangeInstance.off('task:busted', onBusted);
        }
      }

      if (_exchangeInstance) {
        _exchangeInstance.on('task:settled', onSettled);
        _exchangeInstance.on('task:dead_letter', onDeadLetter);
        _exchangeInstance.on('task:busted', onBusted);
      } else {
        reject(new Error('Exchange not initialized'));
      }
    });
  };

  return submit;
}

// ==================== INPUT SCHEMA PROCESSOR ====================

function hasInputSchema(agent) {
  return agent.inputs && typeof agent.inputs === 'object' && Object.keys(agent.inputs).length > 0;
}

function getNextMissingInput(agent, gatheredInputs = {}, context = {}, task = null) {
  if (!hasInputSchema(agent)) return null;

  for (const [field, schema] of Object.entries(agent.inputs)) {
    if (gatheredInputs[field] !== undefined) continue;

    if (schema.askWhen && typeof schema.askWhen === 'function') {
      try {
        if (!schema.askWhen(task || context)) {
          log.info('voice', '[InputSchema] Skipping - askWhen returned false', { v0: field });
          continue;
        }
      } catch (e) {
        log.warn('voice', 'InputSchema askWhen function error', { field, error: e.message });
        continue;
      }
    } else if (!schema.required && !schema.askAlways) {
      continue;
    }

    if (schema.skip && typeof schema.skip === 'function') {
      try {
        if (schema.skip({ inputs: gatheredInputs, ...context })) continue;
      } catch (e) {
        log.warn('voice', 'InputSchema skip function error', { field, error: e.message });
      }
    }

    return { field, schema };
  }

  return null;
}

function buildInputRequest(agentId, field, schema, gatheredInputs, originalContext = {}) {
  return {
    success: true,
    needsInput: {
      prompt: schema.prompt || `What ${field}?`,
      field,
      options: schema.options || [],
      agentId,
      context: {
        ...originalContext,
        _inputSchemaState: {
          gatheredInputs,
          currentField: field,
        },
      },
    },
  };
}

function processInputResponse(userInput, field, schema, gatheredInputs) {
  const updated = { ...gatheredInputs };

  if (schema.options && schema.options.length > 0) {
    const lowerInput = userInput.toLowerCase().trim();

    const exactMatch = schema.options.find((opt) => opt.toLowerCase() === lowerInput);

    if (exactMatch) {
      updated[field] = exactMatch;
    } else {
      const partialMatch = schema.options.find(
        (opt) => opt.toLowerCase().includes(lowerInput) || lowerInput.includes(opt.toLowerCase())
      );
      updated[field] = partialMatch || userInput;
    }
  } else {
    updated[field] = userInput;
  }

  log.info('voice', '[InputSchema] Gathered : ""', { v0: field, v1: updated[field] });
  return updated;
}

async function executeWithInputSchema(agent, task, executionContext = {}) {
  if (!hasInputSchema(agent)) {
    return await agent.execute(task, executionContext);
  }

  let gatheredInputs = task.context?._inputSchemaState?.gatheredInputs || {};
  const currentField = task.context?._inputSchemaState?.currentField;

  if (currentField && task.context?.userInput) {
    const fieldSchema = agent.inputs[currentField];
    if (fieldSchema) {
      gatheredInputs = processInputResponse(task.context.userInput, currentField, fieldSchema, gatheredInputs);
    }
  }

  const missing = getNextMissingInput(agent, gatheredInputs, task.context, task);

  if (missing) {
    log.info('voice', '[InputSchema] Agent needs input:', { v0: agent.id, v1: missing.field });
    return buildInputRequest(agent.id, missing.field, missing.schema, gatheredInputs, task.context);
  }

  log.info('voice', 'InputSchema all inputs gathered', { agentId: agent.id, fields: Object.keys(gatheredInputs) });
  const enrichedTask = {
    ...task,
    inputs: gatheredInputs,
    context: {
      ...task.context,
      inputs: gatheredInputs,
    },
  };

  return await agent.execute(enrichedTask, executionContext);
}

module.exports = {
  // Injection
  setExchangeInstance,
  setBroadcast,
  // Subtask API
  submitSubtask,
  isSubtask,
  getSubtaskRouting,
  getSubtaskContext,
  getSubtasksForParent,
  cleanupSubtasks,
  createSubtaskSubmitter,
  // Input Schema
  hasInputSchema,
  getNextMissingInput,
  buildInputRequest,
  processInputResponse,
  executeWithInputSchema,
};
