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
const { getBidsFromAgents, selectWinner } = require('./unified-bidder');

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

// Built-in agents in unified format for LLM bidding
const BUILTIN_AGENTS = [
  {
    id: 'time-agent',
    name: 'Time Agent',
    keywords: ['time', 'date', 'clock', 'day', 'today', 'hour', 'minute'],
    capabilities: ['Get current time', 'Get current date', 'Get day of week'],
    prompt: 'Answers questions about the current time and date',
    executionType: 'builtin'
  },
  {
    id: 'media-agent',
    name: 'Media Agent',
    keywords: ['play', 'pause', 'stop', 'skip', 'next', 'previous', 'volume', 'music', 'song', 'mute'],
    capabilities: ['Play music', 'Pause playback', 'Skip track', 'Volume control'],
    prompt: 'Controls music playback on the system - play, pause, skip, volume up/down',
    executionType: 'builtin'
  },
  {
    id: 'help-agent',
    name: 'Help Agent',
    keywords: ['help', 'capabilities', 'commands', 'what can you do'],
    capabilities: ['List available commands', 'Explain capabilities'],
    prompt: 'Explains what the assistant can do and how to use it',
    executionType: 'builtin'
  },
  {
    id: 'search-agent',
    name: 'Search Agent',
    keywords: ['weather', 'search', 'find', 'look up', 'what is', 'who is', 'where is', 'how', 'why', 'define'],
    capabilities: ['Search the web', 'Get weather', 'Answer factual questions', 'Look up definitions'],
    prompt: 'Searches the web for information, gets weather forecasts, answers factual questions',
    executionType: 'builtin'
  },
  {
    id: 'smalltalk-agent',
    name: 'Small Talk Agent',
    keywords: ['hi', 'hello', 'hey', 'bye', 'goodbye', 'thanks', 'thank you', 'how are you'],
    capabilities: ['Respond to greetings', 'Handle goodbyes', 'Accept thanks'],
    prompt: 'Handles social pleasantries like greetings, goodbyes, thanks, and casual conversation',
    executionType: 'builtin'
  }
];

/**
 * Get enabled built-in agents
 */
function getEnabledBuiltinAgents() {
  let states = {};
  if (global.settingsManager) {
    states = global.settingsManager.get('builtinAgentStates') || {};
  }
  return BUILTIN_AGENTS.filter(agent => states[agent.id] !== false);
}

/**
 * Get custom agents from agent-store
 */
function getCustomAgents() {
  try {
    const { getAgentStore } = require('../../src/voice-task-sdk/agent-store');
    const agentStore = getAgentStore();
    if (agentStore && agentStore.initialized) {
      const customAgents = agentStore.getEnabledLocalAgents();
      console.log(`[TaskQueueManager] Found ${customAgents.length} custom agents for bidding`);
      return customAgents;
    }
  } catch (e) {
    // Agent store may not be initialized yet
    console.log('[TaskQueueManager] Agent store not available:', e.message);
  }
  return [];
}

/**
 * Get bids from ALL agents (built-in + custom) using unified LLM bidder
 */
async function getBidsForTask(task) {
  // Combine built-in and custom agents
  const builtinAgents = getEnabledBuiltinAgents();
  const customAgents = getCustomAgents();
  const allAgents = [...builtinAgents, ...customAgents];
  
  console.log(`[TaskQueueManager] Evaluating ${allAgents.length} agents (${builtinAgents.length} built-in, ${customAgents.length} custom)`);
  
  const bids = await getBidsFromAgents(allAgents, task);
  
  // Convert to legacy format expected by rest of code
  return bids.map(bid => ({
    agentId: bid.agentId,
    confidence: bid.confidence,
    plan: bid.plan,
    missingData: []
  }));
}

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
  
  // Try built-in agent first
  const builtinAgent = AGENT_IMPLEMENTATIONS[winner.agentId];
  if (builtinAgent) {
    return builtinAgent.execute(task, { onProgress });
  }
  
  // Try custom agent from agent-store
  const customAgent = getCustomAgentById(winner.agentId);
  if (customAgent) {
    return executeCustomAgent(customAgent, task, onProgress);
  }
  
  throw new Error(`Unknown agent: ${winner.agentId}`);
}

/**
 * Get a custom agent by ID
 */
function getCustomAgentById(agentId) {
  try {
    const { getAgentStore } = require('../../src/voice-task-sdk/agent-store');
    const agentStore = getAgentStore();
    if (agentStore && agentStore.initialized) {
      return agentStore.getAgent(agentId);
    }
  } catch (e) {
    // Agent store may not be available
  }
  return null;
}

/**
 * Execute a custom agent based on its execution type
 */
async function executeCustomAgent(agent, task, onProgress = () => {}) {
  const executionType = agent.executionType || 'llm';
  const content = task.content || '';
  
  console.log(`[TaskQueueManager] Executing custom agent ${agent.name} (${executionType})`);
  onProgress(`${agent.name} processing...`);
  
  try {
    if (executionType === 'applescript') {
      return await executeAppleScriptAgent(agent, content, onProgress);
    } else if (executionType === 'nodejs') {
      return await executeNodeJSAgent(agent, content, onProgress);
    } else {
      // Default to LLM execution
      return await executeLLMAgent(agent, content, onProgress);
    }
  } catch (error) {
    console.error(`[TaskQueueManager] Custom agent ${agent.name} failed:`, error.message);
    return {
      success: false,
      message: `${agent.name} encountered an error: ${error.message}`
    };
  }
}

/**
 * Execute an AppleScript-type agent
 */
async function executeAppleScriptAgent(agent, content, onProgress) {
  const claudeCode = require('../../lib/claude-code-runner');
  
  onProgress('Generating AppleScript...');
  
  const prompt = `${agent.prompt}\n\nUser command: "${content}"\n\nGenerate and return ONLY the AppleScript code to execute. No explanation, just the code.`;
  
  const response = await claudeCode.complete(prompt);
  
  // Extract AppleScript from response
  let script = response;
  const codeMatch = response.match(/```(?:applescript)?\n?([\s\S]*?)```/);
  if (codeMatch) {
    script = codeMatch[1].trim();
  }
  
  onProgress('Running AppleScript...');
  
  // Execute the AppleScript
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  
  const escapedScript = script.replace(/'/g, "'\"'\"'");
  const { stdout, stderr } = await execAsync(`osascript -e '${escapedScript}'`, { timeout: 30000 });
  
  if (stderr && !stdout) {
    return { success: false, message: stderr };
  }
  
  return {
    success: true,
    message: stdout.trim() || 'Done'
  };
}

/**
 * Execute a Node.js-type agent  
 */
async function executeNodeJSAgent(agent, content, onProgress) {
  const claudeCode = require('../../lib/claude-code-runner');
  
  onProgress('Generating code...');
  
  const prompt = `${agent.prompt}\n\nUser command: "${content}"\n\nGenerate Node.js code to accomplish this. Return ONLY executable code.`;
  
  const result = await claudeCode.executeWithTools(prompt, {
    allowedTools: ['Bash'],
    cwd: process.cwd()
  });
  
  return {
    success: result.success,
    message: result.output || result.error || 'Completed'
  };
}

/**
 * Execute an LLM-type agent (conversational)
 */
async function executeLLMAgent(agent, content, onProgress) {
  const claudeCode = require('../../lib/claude-code-runner');
  
  onProgress('Thinking...');
  
  const prompt = `${agent.prompt}\n\nUser: ${content}`;
  const response = await claudeCode.complete(prompt);
  
  return {
    success: true,
    message: response.trim()
  };
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
