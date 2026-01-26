/**
 * Agentic Retry Template
 * 
 * Wraps any agent with LLM-based reasoning for retries.
 * Not deterministic - the LLM decides what to try next based on failures.
 * 
 * Usage:
 *   const smartAgent = withAgenticRetry(myAgent, {
 *     actions: { ... },
 *     maxAttempts: 4
 *   });
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
 * Extract intent from user request using LLM
 * @param {string} request - User's raw request
 * @param {string} domain - Context domain (e.g., 'music', 'files', 'calendar')
 * @returns {Promise<Object>} - Extracted intent details
 */
async function extractIntent(request, domain = 'general') {
  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    return { raw: request, parsed: null };
  }

  const domainPrompts = {
    music: `Extract music intent. Return JSON: { "action": "play/pause/skip", "searchTerm": "term or null", "genre": "genre or null", "artist": "artist or null", "mood": "mood or null" }`,
    files: `Extract file operation intent. Return JSON: { "action": "open/save/find/delete", "filename": "name or null", "path": "path or null", "type": "type or null" }`,
    calendar: `Extract calendar intent. Return JSON: { "action": "create/find/delete", "title": "title or null", "date": "date or null", "time": "time or null" }`,
    general: `Extract the user's intent. Return JSON: { "action": "primary action", "target": "what they want to act on", "params": {} }`
  };

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'system',
          content: domainPrompts[domain] || domainPrompts.general
        }, {
          role: 'user',
          content: request
        }],
        temperature: 0,
        max_tokens: 200,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const data = await response.json();
    return {
      raw: request,
      parsed: JSON.parse(data.choices?.[0]?.message?.content || '{}')
    };
  } catch (error) {
    console.error('[AgenticRetry] Extract intent error:', error.message);
    return { raw: request, parsed: null };
  }
}

/**
 * Ask LLM what to do next after a failure
 * @param {Object} context - Current state
 * @returns {Promise<Object>} - Next action decision
 */
async function decideNextAction(context) {
  const { originalIntent, attempts, availableActions, maxAttempts, domain } = context;

  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    return { action: 'stop', reasoning: 'No API key', shouldStop: true };
  }

  const systemPrompt = `You are a retry strategist for a ${domain || 'general'} assistant.
Analyze what failed and decide the best next action.

Available actions:
${availableActions.map(a => `- "${a.name}": ${a.description}`).join('\n')}
- "ask_user": Ask user for clarification
- "stop": Give up (use sparingly)

Respond with JSON:
{
  "action": "action_name",
  "params": { ... action-specific parameters ... },
  "reasoning": "Brief explanation",
  "shouldStop": false
}

Rules:
1. Don't repeat the exact same action with same params
2. Be creative - try different approaches
3. After ${Math.floor(maxAttempts * 0.75)}+ failures, consider "ask_user" or "stop"
4. Learn from each failure to inform next attempt`;

  const userPrompt = `User wanted: "${originalIntent}"

Attempts so far:
${attempts.map((a, i) => `${i + 1}. ${a.action}: ${a.error || a.result || 'no response'}`).join('\n')}

Remaining attempts: ${maxAttempts - attempts.length}

What should I try next?`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 300,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const data = await response.json();
    const decision = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    
    console.log(`[AgenticRetry] Decision: ${decision.action} - ${decision.reasoning}`);
    return decision;

  } catch (error) {
    console.error('[AgenticRetry] Decision error:', error.message);
    return { action: 'stop', reasoning: error.message, shouldStop: true };
  }
}

/**
 * Execute with agentic retry loop
 * @param {Object} config - Configuration
 * @returns {Promise<Object>} - Final result
 */
async function executeWithRetry(config) {
  const {
    intent,           // User's request
    domain,           // Domain for intent extraction (music, files, etc.)
    actions,          // Available actions: [{ name, description, handler }]
    initialAction,    // First action to try: async (parsedIntent) => result
    maxAttempts = 4,
    onAttempt         // Optional callback: (attemptNumber, action, result) => void
  } = config;

  // Extract intent first
  const extracted = await extractIntent(intent, domain);
  console.log(`[AgenticRetry] Extracted intent:`, extracted.parsed || extracted.raw);

  const attempts = [];
  
  // First attempt
  let result = await initialAction(extracted);
  attempts.push({
    action: 'initial',
    result: result.success ? result.message : null,
    error: result.success ? null : result.message
  });
  
  if (onAttempt) onAttempt(1, 'initial', result);

  // Build available actions list for LLM
  const availableActions = actions.map(a => ({
    name: a.name,
    description: a.description
  }));

  // Retry loop - LLM decides each step
  while (!result.success && result.canRetry !== false && attempts.length < maxAttempts) {
    const decision = await decideNextAction({
      originalIntent: intent,
      attempts,
      availableActions,
      maxAttempts,
      domain
    });

    if (decision.shouldStop || decision.action === 'stop') {
      break;
    }

    if (decision.action === 'ask_user') {
      return {
        success: false,
        needsClarification: true,
        message: decision.params?.question || `Could you clarify what you meant by "${intent}"?`,
        attempts
      };
    }

    // Find and execute the action
    const actionDef = actions.find(a => a.name === decision.action);
    if (!actionDef) {
      console.warn(`[AgenticRetry] Unknown action: ${decision.action}`);
      break;
    }

    try {
      result = await actionDef.handler(decision.params, extracted);
      attempts.push({
        action: `${decision.action}(${JSON.stringify(decision.params || {})})`,
        result: result.success ? result.message : null,
        error: result.success ? null : result.message
      });
      
      if (onAttempt) onAttempt(attempts.length, decision.action, result);
      
    } catch (error) {
      attempts.push({
        action: decision.action,
        error: error.message
      });
    }
  }

  // Return final result
  if (result.success) {
    return {
      success: true,
      message: result.message,
      attempts: attempts.length,
      reasoning: attempts.map(a => a.action).join(' → ')
    };
  }

  return {
    success: false,
    message: `Tried ${attempts.length} approaches but couldn't complete: "${intent}"`,
    attempts,
    lastError: result.message
  };
}

/**
 * Wrap an agent with agentic retry capability
 * @param {Object} agent - Base agent with execute() method
 * @param {Object} retryConfig - Retry configuration
 * @returns {Object} - Enhanced agent
 */
function withAgenticRetry(agent, retryConfig) {
  const {
    domain,
    actions,
    maxAttempts = 4,
    shouldRetry = (task) => true  // Function to decide if retry applies
  } = retryConfig;

  return {
    ...agent,
    
    async execute(task) {
      // Check if retry should be used for this task
      if (!shouldRetry(task)) {
        return agent.execute(task);
      }

      return executeWithRetry({
        intent: task.content,
        domain,
        actions,
        maxAttempts,
        initialAction: async (extracted) => {
          // Inject extracted intent into task
          const enrichedTask = { ...task, extractedIntent: extracted };
          return agent.execute(enrichedTask);
        }
      });
    }
  };
}

module.exports = {
  extractIntent,
  decideNextAction,
  executeWithRetry,
  withAgenticRetry
};
