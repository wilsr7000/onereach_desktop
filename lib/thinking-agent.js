/**
 * Thinking Agent Base Module
 * 
 * Shared utilities for all "thinking" agents that:
 * - Check preferences before acting
 * - Ask clarifying questions when needed
 * - Review their work with AI
 * - Learn from interactions
 * 
 * @module ThinkingAgent
 */

const { getAgentMemory } = require('./agent-memory-store');

// Circuit breaker for AI calls
let thinkingCircuit = null;
try {
  const { getCircuit } = require('../packages/agents/circuit-breaker');
  thinkingCircuit = getCircuit('thinking-agent', {
    failureThreshold: 3,
    resetTimeout: 30000,
    windowMs: 60000
  });
} catch (e) {
  // Circuit breaker not available, will use direct calls
}

/**
 * Get OpenAI API key from settings
 */
function getOpenAIApiKey() {
  if (global.settingsManager) {
    const openaiKey = global.settingsManager.get('openaiApiKey');
    if (openaiKey) return openaiKey;
    const provider = global.settingsManager.get('llmProvider');
    const llmKey = global.settingsManager.get('llmApiKey');
    if (provider === 'openai' && llmKey) return llmKey;
  }
  return process.env.OPENAI_API_KEY;
}

/**
 * Call OpenAI with circuit breaker protection
 */
async function callOpenAI(messages, options = {}) {
  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    return null;
  }
  
  const doCall = async () => {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: options.model || 'gpt-4o-mini',
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens || 500,
        response_format: options.jsonResponse ? { type: 'json_object' } : undefined
      })
    });
    
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.choices?.[0]?.message?.content;
  };
  
  if (thinkingCircuit) {
    return thinkingCircuit.execute(doCall);
  }
  return doCall();
}

/**
 * Check if clarification is needed based on task and preferences
 * 
 * @param {string} agentId - The agent's ID
 * @param {Object} task - The task object with content
 * @param {Object} memory - The agent's memory instance
 * @param {Object} config - Agent-specific configuration
 * @returns {Promise<Object>} { needsClarification, question, context }
 */
async function checkPreferencesAndClarify(agentId, task, memory, config = {}) {
  const result = {
    needsClarification: false,
    question: null,
    context: {},
    preferences: {}
  };
  
  if (!task?.content) {
    return result;
  }
  
  // Load preferences from memory
  if (memory && memory.isLoaded()) {
    const prefsSection = memory.getSection('Learned Preferences');
    if (prefsSection) {
      result.preferences = memory.parseSectionAsKeyValue('Learned Preferences');
    }
  }
  
  // Get clarification rules from config
  const clarificationRules = config.clarificationRules || [];
  const taskContent = task.content.toLowerCase();
  
  // Check each rule
  for (const rule of clarificationRules) {
    // Check if rule applies to this task
    const matches = rule.keywords?.some(k => taskContent.includes(k.toLowerCase()));
    if (!matches) continue;
    
    // Check if we already have the info in preferences
    if (rule.preferenceKey && result.preferences[rule.preferenceKey]) {
      result.context[rule.preferenceKey] = result.preferences[rule.preferenceKey];
      continue;
    }
    
    // Check if task provides the info
    if (rule.extractPattern) {
      const match = task.content.match(rule.extractPattern);
      if (match) {
        result.context[rule.preferenceKey] = match[1];
        continue;
      }
    }
    
    // Need to ask
    result.needsClarification = true;
    result.question = rule.question;
    result.context.clarifyingField = rule.preferenceKey;
    result.context.options = rule.options;
    break; // Only ask one question at a time
  }
  
  // If no rules triggered but config says to use AI for complex requests
  if (!result.needsClarification && config.useAIClarification) {
    const aiResult = await checkClarificationWithAI(agentId, task, result.preferences, config);
    if (aiResult?.needsClarification) {
      result.needsClarification = true;
      result.question = aiResult.question;
      result.context = { ...result.context, ...aiResult.context };
    }
  }
  
  return result;
}

/**
 * Use AI to determine if clarification is needed
 */
async function checkClarificationWithAI(agentId, task, preferences, config) {
  const systemPrompt = `You are helping the ${config.agentName || agentId} agent decide if it needs clarification from the user.

User preferences:
${JSON.stringify(preferences, null, 2)}

Agent capabilities:
${config.capabilities?.join(', ') || 'General assistance'}

Respond with JSON:
{
  "needsClarification": boolean,
  "question": "question to ask user if needed",
  "context": { "fieldName": "value" }
}

Only ask for clarification if the request is genuinely ambiguous and you don't have enough context from preferences.`;

  const userPrompt = `User request: "${task.content}"

Does this request need clarification, or can the agent proceed with available information?`;

  try {
    const response = await callOpenAI([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], { jsonResponse: true, maxTokens: 200 });
    
    if (response) {
      return JSON.parse(response);
    }
  } catch (e) {
    console.warn('[ThinkingAgent] AI clarification check failed:', e.message);
  }
  
  return { needsClarification: false };
}

/**
 * Review execution results with AI
 * 
 * @param {Object} task - The original task
 * @param {Object} result - The execution result
 * @param {string} intent - The extracted intent
 * @param {Object} config - Agent-specific configuration
 * @returns {Promise<Object>} { success, shouldRetry, adjustment, message }
 */
async function reviewExecution(task, result, intent, config = {}) {
  // Quick check - if result is clearly successful, skip AI review
  if (result.success && !config.alwaysReview) {
    return {
      success: true,
      shouldRetry: false,
      adjustment: null,
      message: result.message
    };
  }
  
  // If result failed, try AI review for retry suggestions
  if (!result.success || config.alwaysReview) {
    const aiReview = await reviewWithAI(task, result, intent, config);
    if (aiReview) {
      return aiReview;
    }
  }
  
  // Fallback - return as-is
  return {
    success: result.success !== false,
    shouldRetry: !result.success,
    adjustment: null,
    message: result.message || (result.success ? 'Done!' : 'Something went wrong.')
  };
}

/**
 * Use AI to review execution and suggest improvements
 */
async function reviewWithAI(task, result, intent, config) {
  const systemPrompt = `You are reviewing the result of an AI agent's action.

Agent: ${config.agentName || 'Assistant'}
Capabilities: ${config.capabilities?.join(', ') || 'General assistance'}

Analyze if the result matches the user's intent. Respond with JSON:
{
  "success": boolean (did the action fulfill the intent?),
  "shouldRetry": boolean (should the agent try again with adjustments?),
  "adjustment": "suggestion for improvement if retry needed",
  "message": "what to tell the user (be concise and friendly)"
}`;

  const userPrompt = `User's request: "${task.content}"
Extracted intent: "${intent}"

Agent's result:
- Success: ${result.success}
- Message: ${result.message || 'No message'}
- Error: ${result.error || 'None'}

Did this fulfill the user's intent?`;

  try {
    const response = await callOpenAI([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], { jsonResponse: true, maxTokens: 200 });
    
    if (response) {
      return JSON.parse(response);
    }
  } catch (e) {
    console.warn('[ThinkingAgent] AI review failed:', e.message);
  }
  
  return null;
}

/**
 * Learn from an interaction and update memory
 * 
 * @param {Object} memory - The agent's memory instance
 * @param {Object} task - The task that was executed
 * @param {Object} result - The execution result
 * @param {Object} context - Additional context (user input, preferences used)
 * @returns {Promise<void>}
 */
async function learnFromInteraction(memory, task, result, context = {}) {
  if (!memory || !memory.isLoaded()) {
    return;
  }
  
  const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  
  // Add to history
  const historyEntry = `- ${timestamp}: "${task.content?.slice(0, 50)}..." -> ${result.success ? 'Success' : 'Failed'}`;
  memory.appendToSection('Recent History', historyEntry, 20);
  
  // Update preferences if context includes new info
  if (context.learnedPreferences) {
    const currentPrefs = memory.parseSectionAsKeyValue('Learned Preferences') || {};
    const updatedPrefs = { ...currentPrefs, ...context.learnedPreferences };
    memory.updateSectionAsKeyValue('Learned Preferences', updatedPrefs);
  }
  
  // Extract learnings with AI if configured
  if (context.useAILearning && result.success) {
    const aiLearnings = await extractLearningsWithAI(task, result, context);
    if (aiLearnings) {
      const currentPrefs = memory.parseSectionAsKeyValue('Learned Preferences') || {};
      const updatedPrefs = { ...currentPrefs, ...aiLearnings };
      memory.updateSectionAsKeyValue('Learned Preferences', updatedPrefs);
    }
  }
  
  // Save memory
  await memory.save();
}

/**
 * Use AI to extract learnings from a successful interaction
 */
async function extractLearningsWithAI(task, result, context) {
  const systemPrompt = `You are analyzing a successful interaction to learn user preferences.

Extract any preferences that should be remembered. Respond with JSON:
{
  "prefKey1": "value1",
  "prefKey2": "value2"
}

Only include preferences that are clearly indicated. Be conservative.
Return {} if nothing to learn.`;

  const userPrompt = `User request: "${task.content}"
Result: ${result.message || 'Success'}
Context: ${JSON.stringify(context.additionalContext || {})}

What preferences should be remembered?`;

  try {
    const response = await callOpenAI([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], { jsonResponse: true, maxTokens: 150 });
    
    if (response) {
      return JSON.parse(response);
    }
  } catch (e) {
    console.warn('[ThinkingAgent] AI learning extraction failed:', e.message);
  }
  
  return null;
}

/**
 * Create a standard thinking agent execute wrapper
 * 
 * @param {Object} agent - The agent object
 * @param {Object} config - Configuration for thinking behavior
 * @returns {Function} Wrapped execute function
 */
function createThinkingExecute(agent, config = {}) {
  return async function thinkingExecute(task) {
    try {
      // 1. Initialize memory
      let memory = null;
      if (config.useMemory !== false) {
        memory = getAgentMemory(agent.id, { displayName: agent.name });
        await memory.load();
      }
      
      // 2. Check for pending conversation state
      if (task.context?.pendingState) {
        // Continue conversation - call agent's state handler
        if (agent._handlePendingState) {
          return agent._handlePendingState(task, memory, task.context.pendingState);
        }
      }
      
      // 3. Check if clarification needed
      const clarification = await checkPreferencesAndClarify(
        agent.id, 
        task, 
        memory, 
        config
      );
      
      if (clarification.needsClarification) {
        return {
          success: true,
          needsInput: {
            prompt: clarification.question,
            agentId: agent.id,
            context: {
              pendingState: 'awaiting_clarification',
              clarifyingField: clarification.context.clarifyingField,
              options: clarification.context.options,
              originalTask: task.content
            }
          }
        };
      }
      
      // 4. Execute the actual task
      const context = {
        preferences: clarification.preferences,
        ...clarification.context,
        memory
      };
      
      let result;
      if (agent._doTask) {
        result = await agent._doTask(task, context);
      } else if (agent._execute) {
        result = await agent._execute(task, context);
      } else {
        throw new Error('Agent must implement _doTask or _execute method');
      }
      
      // 5. Review execution
      const intent = config.extractIntent ? config.extractIntent(task) : task.content;
      const review = await reviewExecution(task, result, intent, config);
      
      // 6. Retry if needed
      if (review.shouldRetry && config.maxRetries > 0) {
        const retryTask = { ...task, adjustment: review.adjustment };
        const retryResult = agent._doTask 
          ? await agent._doTask(retryTask, context)
          : await agent._execute(retryTask, context);
        result = retryResult;
      }
      
      // 7. Learn from interaction
      if (config.useMemory !== false) {
        await learnFromInteraction(memory, task, result, {
          useAILearning: config.useAILearning,
          learnedPreferences: result.learnedPreferences,
          additionalContext: context
        });
      }
      
      // 8. Return final result
      return {
        success: result.success !== false,
        message: review.message || result.message,
        data: result.data
      };
      
    } catch (error) {
      console.error(`[${agent.id}] Thinking execute error:`, error);
      return {
        success: false,
        message: config.errorMessage || "I had trouble with that request. Let me try again."
      };
    }
  };
}

/**
 * Get context about current time (useful for many agents)
 */
function getTimeContext() {
  const now = new Date();
  const hour = now.getHours();
  
  let partOfDay;
  if (hour >= 6 && hour < 12) partOfDay = 'morning';
  else if (hour >= 12 && hour < 18) partOfDay = 'afternoon';
  else if (hour >= 18 && hour < 22) partOfDay = 'evening';
  else partOfDay = 'night';
  
  return {
    hour,
    partOfDay,
    dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long' }),
    isWeekend: ['Saturday', 'Sunday'].includes(now.toLocaleDateString('en-US', { weekday: 'long' })),
    timestamp: now.toISOString()
  };
}

module.exports = {
  checkPreferencesAndClarify,
  reviewExecution,
  learnFromInteraction,
  createThinkingExecute,
  getTimeContext,
  getOpenAIApiKey,
  callOpenAI
};
