/**
 * Agent Bidder
 * 
 * Each agent uses LLM to evaluate if they can handle a task
 * and submit a bid with confidence and execution plan.
 */

const { getCircuit } = require('./circuit-breaker');

// Circuit breaker for OpenAI API calls
const openaiCircuit = getCircuit('openai-bidder', {
  failureThreshold: 3,
  resetTimeout: 30000,
  windowMs: 60000
});

/**
 * Get OpenAI API key from app settings (same as realtime-speech.js)
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

// Agent capability definitions
const AGENT_CAPABILITIES = {
  'time-agent': {
    name: 'Time Agent',
    capabilities: ['Get current time', 'Get current date', 'Get day of week', 'Get month', 'Get year'],
    canHandle: ['time', 'date', 'clock', 'day', 'today', 'hour', 'minute'],
    examples: ['what time is it', 'what day is today', 'what is the date']
  },
  // Note: weather-agent removed from LLM bidder - search-agent handles weather via web search
  // The weather-agent still exists for direct API integration if needed
  'media-agent': {
    name: 'Media Agent',
    capabilities: ['Play music', 'Pause playback', 'Skip track', 'Previous track', 'Volume control', 'Mute/unmute'],
    canHandle: ['play', 'pause', 'stop', 'skip', 'next', 'previous', 'volume', 'music', 'song', 'mute'],
    examples: ['play jazz', 'pause the music', 'turn up volume', 'next song']
  },
  'help-agent': {
    name: 'Help Agent',
    capabilities: ['List available commands', 'Explain capabilities', 'Provide usage guidance'],
    canHandle: ['help', 'capabilities', 'commands', 'what can you do', 'how do I'],
    examples: ['what can you do', 'help me', 'list commands']
  },
  'search-agent': {
    name: 'Search Agent',
    capabilities: ['Search the web', 'Get weather information', 'Answer factual questions', 'Look up people/places/things', 'Find definitions', 'Current events and news', 'Answer personal questions from stored context'],
    canHandle: ['weather', 'temperature', 'forecast', 'rain', 'snow', 'search', 'find', 'look up', 'what is', 'who is', 'who was', 'who invented', 'where is', 'when did', 'how does', 'how many', 'news', 'define', 'meaning', 'who am i', 'my name', 'about me', 'my location', 'my apps', 'my computer', 'my timezone'],
    examples: ['what is the weather', 'who is the president', 'who invented the telephone', 'define quantum computing', 'is it going to rain', 'how tall is mount everest', 'who am i', 'what is my name']
  },
  'smalltalk-agent': {
    name: 'Small Talk Agent',
    capabilities: ['Respond to greetings', 'Handle goodbyes', 'Accept thanks', 'Casual conversation', 'Social pleasantries'],
    canHandle: ['hi', 'hello', 'hey', 'bye', 'goodbye', 'thanks', 'thank you', 'how are you', 'good morning', 'good afternoon', 'good evening', 'good night', 'yes', 'no', 'okay', 'sorry'],
    examples: ['hi', 'hello', 'hey there', 'goodbye', 'thanks', 'thank you', 'how are you', 'good morning']
  }
};

/**
 * Check if an agent is enabled (for builtin agents)
 * @param {string} agentId 
 * @returns {boolean}
 */
function isAgentEnabled(agentId) {
  if (global.settingsManager) {
    const states = global.settingsManager.get('builtinAgentStates') || {};
    // Default to enabled if not explicitly disabled
    return states[agentId] !== false;
  }
  return true; // Default enabled if no settings manager
}

/**
 * Get bids from all agents for a task
 * @param {Object} task - Task to bid on
 * @returns {Promise<Array<{agentId, confidence, plan, missingData}>>}
 */
async function getBidsForTask(task) {
  const bids = [];
  
  for (const [agentId, capabilities] of Object.entries(AGENT_CAPABILITIES)) {
    // Skip disabled agents
    if (!isAgentEnabled(agentId)) {
      continue;
    }
    
    const bid = await getAgentBid(agentId, capabilities, task);
    if (bid && bid.confidence > 0) {
      bids.push({
        agentId,
        ...bid
      });
    }
  }
  
  // Sort by confidence descending
  bids.sort((a, b) => b.confidence - a.confidence);
  
  return bids;
}

/**
 * Get a single agent's bid for a task
 * @param {string} agentId 
 * @param {Object} capabilities 
 * @param {Object} task 
 * @returns {Promise<{confidence, plan, missingData}|null>}
 */
async function getAgentBid(agentId, capabilities, task) {
  // Quick keyword check first (fast path)
  const taskLower = (task.content || '').toLowerCase();
  const hasKeyword = capabilities.canHandle.some(k => taskLower.includes(k));
  
  if (!hasKeyword && task.type !== agentId.replace('-agent', '')) {
    return null; // Quick reject - no relevant keywords
  }
  
  // Get API key from app settings
  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    console.error('[AgentBidder] OpenAI API key required - check Settings → LLM Settings');
    return null;
  }
  
  try {
    // Use circuit breaker to protect against cascading failures
    const data = await openaiCircuit.execute(async () => {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: buildBidderPrompt(agentId, capabilities) },
            { role: 'user', content: JSON.stringify(task) }
          ],
          temperature: 0,
          max_tokens: 200,
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        throw new Error(`API error for ${agentId}`);
      }

      return response.json();
    });

    const content = data.choices?.[0]?.message?.content;
    
    if (!content) {
      return null;
    }

    return JSON.parse(content);

  } catch (error) {
    console.error(`[AgentBidder] ${agentId} error:`, error.message);
    return null;
  }
}

/**
 * Build prompt for agent bidding
 */
function buildBidderPrompt(agentId, capabilities) {
  return `You are the ${capabilities.name} evaluating if you can handle a task.

Your capabilities:
${capabilities.capabilities.map(c => `- ${c}`).join('\n')}

You can handle requests about: ${capabilities.canHandle.join(', ')}
${capabilities.requiresData ? `Required data: ${capabilities.requiresData.join(', ')}` : ''}

Evaluate the task and respond with JSON:
{
  "confidence": 0.0-1.0,  // How confident you can handle this
  "plan": "Brief description of what you would do",
  "missingData": ["field1", "field2"]  // Data you need but don't have
}

Rules:
- confidence >= 0.8 if you can fully handle it
- confidence 0.5-0.7 if you can partially handle it
- confidence < 0.3 if this isn't for you
- List any missing required data`;
}


/**
 * Select winning bid for a task
 * @param {Array} bids - Sorted bids array
 * @returns {{winner: Object|null, backups: Array}}
 */
function selectWinner(bids) {
  if (!bids || bids.length === 0) {
    return { winner: null, backups: [] };
  }
  
  // Winner is highest confidence bid
  const winner = bids[0];
  
  // Backups are other viable bids (confidence > 0.5)
  const backups = bids.slice(1).filter(b => b.confidence > 0.5);
  
  return { winner, backups };
}

module.exports = {
  getBidsForTask,
  getAgentBid,
  selectWinner,
  AGENT_CAPABILITIES
};
