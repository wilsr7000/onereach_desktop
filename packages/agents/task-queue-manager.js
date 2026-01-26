/**
 * Task Queue Manager
 * 
 * Orchestrates the full flow:
 * 1. Decompose user phrase into tasks
 * 2. Get bids from agents for each task
 * 3. Report to user what's happening OR ask for clarification
 * 4. Execute tasks and collect results
 */

const { decomposeTasks } = require('./task-decomposer');
const { getBidsForTask, selectWinner } = require('./agent-bidder');

// Import actual agent implementations
const timeAgent = require('./time-agent');
const weatherAgent = require('./weather-agent');
const mediaAgent = require('./media-agent');
const helpAgent = require('./help-agent');
const smalltalkAgent = require('./smalltalk-agent');
const searchAgent = require('./search-agent');

const AGENT_IMPLEMENTATIONS = {
  'time-agent': timeAgent,
  'weather-agent': weatherAgent,
  'media-agent': mediaAgent,
  'help-agent': helpAgent,
  'smalltalk-agent': smalltalkAgent,
  'search-agent': searchAgent
};

/**
 * Process a user phrase through the full pipeline
 * @param {string} phrase - User's spoken text
 * @param {Array} history - Conversation history
 * @param {Object} callbacks - {onTaskQueued, onTaskAssigned, onTaskCompleted, onNeedsClarification, onProgress}
 * @returns {Promise<{success: boolean, message: string, results: Array}>}
 */
async function processPhrase(phrase, history = [], callbacks = {}) {
  const {
    onTaskQueued = () => {},
    onTaskAssigned = () => {},
    onTaskCompleted = () => {},
    onNeedsClarification = () => {},
    onProgress = () => {}  // New: progress updates during agent execution
  } = callbacks;

  console.log('[TaskQueueManager] Processing phrase:', phrase);

  // Step 1: Decompose into tasks
  const decomposed = await decomposeTasks(phrase, history);
  const { tasks, acknowledgment, error } = decomposed;
  
  console.log('[TaskQueueManager] Decomposed into', tasks.length, 'tasks');
  
  // Check for API key error
  if (error === 'API key required') {
    return {
      success: false,
      message: "OpenAI API key is required. Please configure OPENAI_API_KEY.",
      results: [],
      error: 'api_key_required'
    };
  }
  
  // Check for error tasks
  if (tasks.length === 1 && tasks[0].type === 'error') {
    return {
      success: false,
      message: tasks[0].error || "Something went wrong",
      results: [],
      error: tasks[0].error
    };
  }
  
  if (tasks.length === 0) {
    return {
      success: false,
      message: "I didn't understand that. Could you rephrase?",
      results: []
    };
  }

  // Notify: tasks queued
  for (const task of tasks) {
    onTaskQueued(task);
  }

  // Step 2: Get bids for each task
  const taskBids = [];
  const unbiddableTasks = [];
  
  for (const task of tasks) {
    // System commands bypass bidding
    if (task.type === 'system') {
      taskBids.push({
        task,
        winner: { agentId: 'system', confidence: 1.0, plan: 'Execute system command' },
        backups: []
      });
      continue;
    }
    
    // Clarify tasks also bypass bidding
    if (task.type === 'clarify') {
      unbiddableTasks.push(task);
      continue;
    }
    
    const bids = await getBidsForTask(task);
    const { winner, backups } = selectWinner(bids);
    
    if (winner && winner.confidence >= 0.5) {
      taskBids.push({ task, winner, backups });
      onTaskAssigned(task, winner);
    } else {
      unbiddableTasks.push(task);
    }
  }

  console.log('[TaskQueueManager] Biddable:', taskBids.length, 'Unbiddable:', unbiddableTasks.length);

  // Step 3: Handle unbiddable tasks
  if (unbiddableTasks.length > 0 && taskBids.length === 0) {
    // Nothing can be done - ask for clarification
    const clarifyMessage = buildClarificationMessage(unbiddableTasks);
    onNeedsClarification(unbiddableTasks, clarifyMessage);
    
    return {
      success: false,
      needsClarification: true,
      message: clarifyMessage,
      results: []
    };
  }

  if (unbiddableTasks.length > 0 && taskBids.length > 0) {
    // Partial understanding - do what we can, ask about rest
    const partialMessage = buildPartialMessage(taskBids, unbiddableTasks);
    // Continue with what we can do
  }

  // Step 4: Execute tasks
  const results = [];
  const messages = [];
  
  // Acknowledge if multiple tasks
  if (acknowledgment && taskBids.length > 1) {
    messages.push(acknowledgment);
  }
  
  for (const { task, winner, backups } of taskBids) {
    // Create a progress callback bound to this task
    const taskProgress = (status) => onProgress(task, winner, status);
    
    try {
      const result = await executeTask(task, winner, taskProgress);
      results.push({ task, winner, result });
      onTaskCompleted(task, winner, result);
      
      if (result.message) {
        messages.push(result.message);
      }
    } catch (error) {
      console.error('[TaskQueueManager] Task execution error:', error);
      
      // Try backup agents
      let handled = false;
      for (const backup of backups) {
        const backupProgress = (status) => onProgress(task, backup, status);
        try {
          const result = await executeTask(task, backup, backupProgress);
          results.push({ task, winner: backup, result });
          onTaskCompleted(task, backup, result);
          if (result.message) messages.push(result.message);
          handled = true;
          break;
        } catch (e) {
          continue;
        }
      }
      
      if (!handled) {
        messages.push(`I couldn't complete "${task.content}"`);
      }
    }
  }

  // Add clarification for unbiddable tasks
  if (unbiddableTasks.length > 0) {
    const clarifyPart = unbiddableTasks.length === 1 
      ? `I'm not sure what you meant by "${unbiddableTasks[0].content}"`
      : `I couldn't understand parts of your request`;
    messages.push(clarifyPart);
  }

  return {
    success: results.length > 0,
    message: messages.join('. '),
    results,
    needsClarification: unbiddableTasks.length > 0
  };
}

/**
 * Execute a single task with the winning agent
 * @param {Object} task - The task to execute
 * @param {Object} winner - The winning agent bid
 * @param {Function} onProgress - Optional callback for progress updates (status: string) => void
 */
async function executeTask(task, winner, onProgress = () => {}) {
  // System commands
  if (winner.agentId === 'system') {
    return handleSystemCommand(task);
  }
  
  // Get agent implementation
  const agent = AGENT_IMPLEMENTATIONS[winner.agentId];
  if (!agent) {
    throw new Error(`Unknown agent: ${winner.agentId}`);
  }
  
  // Check for missing data
  if (winner.missingData && winner.missingData.length > 0) {
    return {
      success: false,
      needsInput: {
        field: winner.missingData[0],
        prompt: `What ${winner.missingData[0]} would you like?`
      }
    };
  }
  
  // Execute with progress callback in context
  return agent.execute(task, { onProgress });
}

/**
 * Handle system commands (cancel, undo, repeat)
 */
function handleSystemCommand(task) {
  const command = task.command || task.content.toLowerCase();
  
  if (command.includes('cancel') || command.includes('nevermind') || command.includes('stop')) {
    return { success: true, message: 'Cancelled', isCancel: true };
  }
  
  if (command.includes('undo')) {
    // Would need access to responseMemory for actual undo
    return { success: true, message: 'Undone', isUndo: true };
  }
  
  if (command.includes('repeat')) {
    // Would need access to responseMemory for actual repeat
    return { success: true, message: '', isRepeat: true };
  }
  
  return { success: false, message: 'Unknown command' };
}

/**
 * Build clarification message when no agents can handle request
 */
function buildClarificationMessage(unbiddableTasks) {
  if (unbiddableTasks.length === 1) {
    const task = unbiddableTasks[0];
    if (task.type === 'clarify') {
      return `I'm not sure what you meant by "${task.content}". I can help with: time, weather, playing music, or explaining what I can do.`;
    }
    return `I don't have a way to handle "${task.content}" right now.`;
  }
  
  return `I understood multiple requests but couldn't find agents to handle them. Could you try asking one thing at a time?`;
}

/**
 * Build message when we can partially handle request
 */
function buildPartialMessage(taskBids, unbiddableTasks) {
  const canDo = taskBids.map(tb => tb.task.type).join(', ');
  const cantDo = unbiddableTasks.map(t => t.content).join(', ');
  
  return `I can help with ${canDo}, but I'm not sure about "${cantDo}"`;
}

module.exports = {
  processPhrase,
  executeTask
};
