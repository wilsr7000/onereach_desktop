/**
 * Dynamic Agent
 *
 * A single agent that handles all user-defined agents.
 * Loads definitions from the agent store and executes tasks via LLM.
 */

const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

/**
 * Execute a task using the app's LLM client
 */
async function executeWithAppLLM(prompt, systemPrompt, _task) {
  try {
    const response = await ai.chat({
      profile: 'standard',
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 1024,
      temperature: 0.7,
      feature: 'dynamic-agent',
    });

    return {
      success: true,
      result: response.content,
      action: 'llm_response',
    };
  } catch (error) {
    log.error('agent', 'LLM execution error', { error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Create a dynamic agent that handles user-defined agent definitions
 */
function createDynamicAgent(exchangeUrl, agentDefinitions, _llmClient) {
  // Load the agent SDK from the compiled dist folder
  let createAgent;

  try {
    const agentPkg = require('../task-agent/dist/index.js');
    createAgent = agentPkg.createAgent;
  } catch (error) {
    log.error('agent', 'Failed to load task-agent package', { error: error.message });
    log.info('agent', 'Make sure to run: cd packages/task-agent && npm run build');
    throw error;
  }

  // Collect all unique categories from all agent definitions
  const allCategories = new Set();
  for (const def of agentDefinitions) {
    (def.categories || []).forEach((cat) => allCategories.add(cat));
    // Also use keywords as categories for better matching
    (def.keywords || []).forEach((kw) => allCategories.add(kw.toLowerCase()));
  }

  // Add a generic category for user-defined agents
  allCategories.add('user-defined');
  allCategories.add('custom');

  log.info('agent', 'Creating dynamic agent', { definitionCount: agentDefinitions.length });
  log.info('agent', 'Categories', { categories: Array.from(allCategories).join(', ') });

  return createAgent({
    name: 'dynamic-user-agent',
    version: '1.0.0',
    categories: Array.from(allCategories),

    exchange: {
      url: exchangeUrl,
      reconnect: true,
      reconnectIntervalMs: 3000,
    },

    // Bidding is handled entirely by the unified LLM bidder (unified-bidder.js).
    // No quickMatch -- per project policy, no keyword/regex classification.

    // Execute using the matching agent's prompt
    execute: async (task, context) => {
      try {
      const content = (task.content || '').toLowerCase();

      // Check for cancellation
      if (context.signal.aborted) {
        return { success: false, message: 'Task cancelled' };
      }

      // Find the best matching agent definition
      let bestMatch = null;
      let bestMatchCount = 0;

      for (const def of agentDefinitions) {
        if (!def.enabled) continue;

        const matchedKeywords = (def.keywords || []).filter((kw) => content.includes(kw.toLowerCase()));

        if (matchedKeywords.length > bestMatchCount) {
          bestMatchCount = matchedKeywords.length;
          bestMatch = def;
        }
      }

      if (!bestMatch) {
        return {
          success: false,
          error: 'No matching agent found for this request',
        };
      }

      log.info('agent', 'Executing with agent', { name: bestMatch.name, type: bestMatch.executionType });

      // Build the prompt based on agent definition
      const systemPrompt = bestMatch.systemPrompt || `You are ${bestMatch.name}. ${bestMatch.description || ''}`;
      const userPrompt = task.content || '';

      // Execute based on execution type
      switch (bestMatch.executionType) {
        case 'llm':
        case 'chat':
          return executeWithAppLLM(userPrompt, systemPrompt, task);

        case 'script':
          log.info('agent', 'Script execution not yet implemented');
          return { success: false, message: 'Script execution not yet implemented' };

        case 'api':
          log.info('agent', 'API execution not yet implemented');
          return { success: false, message: 'API execution not yet implemented' };

        default:
          return executeWithAppLLM(userPrompt, systemPrompt, task);
      }
      } catch (err) {
        return { success: false, message: `Agent error: ${err.message}` };
      }
    },
  });
}

/**
 * Start the dynamic agent with user-defined definitions
 */
async function startDynamicAgent(exchangeUrl) {
  try {
    // Load agent definitions from the agent store
    const { getAgentStore } = require('../../src/voice-task-sdk/agent-store');
    const agentStore = getAgentStore();

    // Get all enabled local agent definitions
    const definitions = agentStore.getLocalAgents().filter((agent) => agent.enabled !== false);

    if (definitions.length === 0) {
      log.info('agent', 'No user-defined agents to start');
      return null;
    }

    log.info('agent', 'Starting with', { length: definitions.length, detail: 'agent definitions' });

    const agent = createDynamicAgent(exchangeUrl, definitions);

    agent.on('connected', () => {
      log.info('agent', 'Connected to exchange');
    });

    agent.on('disconnected', ({ reason }) => {
      log.info('agent', 'Disconnected', { reason });
    });

    agent.on('bid:requested', ({ task }) => {
      log.info('agent', 'Bid requested', { content: task.content.substring(0, 50) });
    });

    agent.on('task:assigned', ({ task }) => {
      log.info('agent', 'Task assigned', { id: task.id });
    });

    agent.on('task:completed', ({ taskId, success }) => {
      log.info('agent', 'Task completed', { taskId, success: success ? 'SUCCESS' : 'FAILED' });
    });

    await agent.start();
    log.info('agent', 'Started successfully');

    return agent;
  } catch (error) {
    log.error('agent', 'Failed to start', { error });
    return null;
  }
}

module.exports = {
  createDynamicAgent,
  startDynamicAgent,
  executeWithAppLLM,
};
