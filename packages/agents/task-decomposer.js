/**
 * Task Decomposer
 * 
 * Uses LLM to analyze user phrase with conversation history,
 * decompose into discrete tasks, and place them on the queue.
 */

const { getCircuit } = require('./circuit-breaker');

// Circuit breaker for OpenAI API calls
const openaiCircuit = getCircuit('openai-decomposer', {
  failureThreshold: 3,
  resetTimeout: 30000,
  windowMs: 60000
});

/**
 * Get OpenAI API key from app settings (same as realtime-speech.js)
 */
function getOpenAIApiKey() {
  if (global.settingsManager) {
    // First try the dedicated OpenAI key
    const openaiKey = global.settingsManager.get('openaiApiKey');
    if (openaiKey) return openaiKey;
    
    // Fall back to LLM API key if provider is OpenAI
    const provider = global.settingsManager.get('llmProvider');
    const llmKey = global.settingsManager.get('llmApiKey');
    if (provider === 'openai' && llmKey) return llmKey;
  }
  // Final fallback to env var
  return process.env.OPENAI_API_KEY;
}

/**
 * Decompose user phrase into discrete tasks
 * @param {string} phrase - User's spoken text
 * @param {Array} history - Recent conversation history [{role, content}]
 * @returns {Promise<{tasks: Array, acknowledgment: string}>}
 */
async function decomposeTasks(phrase, history = []) {
  const OPENAI_API_KEY = getOpenAIApiKey();
  
  if (!phrase || typeof phrase !== 'string') {
    return { tasks: [], acknowledgment: null };
  }

  // Check for system commands first (these bypass decomposition)
  const systemCommands = ['cancel', 'stop', 'nevermind', 'undo', 'repeat'];
  const lowerPhrase = phrase.toLowerCase().trim();
  if (systemCommands.some(cmd => lowerPhrase === cmd || lowerPhrase.startsWith(cmd + ' '))) {
    return {
      tasks: [{ 
        id: `task_${Date.now()}`,
        type: 'system',
        command: lowerPhrase.split(' ')[0],
        content: phrase,
        priority: 'immediate'
      }],
      acknowledgment: null // System commands don't need acknowledgment
    };
  }

  if (!OPENAI_API_KEY) {
    return {
      tasks: [{
        id: `task_${Date.now()}`,
        type: 'error',
        content: phrase,
        error: 'OpenAI API key required. Please set OPENAI_API_KEY environment variable.'
      }],
      acknowledgment: null,
      error: 'API key required'
    };
  }

  try {
    // Use circuit breaker to protect against cascading failures
    const data = await openaiCircuit.execute(async () => {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: buildDecomposerPrompt() },
            ...formatHistory(history),
            { role: 'user', content: phrase }
          ],
          temperature: 0,
          max_tokens: 500,
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API error: ${errText}`);
      }

      return response.json();
    });

    const content = data.choices?.[0]?.message?.content;
    
    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    const result = JSON.parse(content);
    
    // Add IDs to tasks
    const tasks = (result.tasks || []).map((task, i) => ({
      id: `task_${Date.now()}_${i}`,
      ...task
    }));

    return {
      tasks,
      acknowledgment: result.acknowledgment || null
    };

  } catch (error) {
    console.error('[TaskDecomposer] Error:', error.message);
    return {
      tasks: [{
        id: `task_${Date.now()}`,
        type: 'error',
        content: phrase,
        error: error.message
      }],
      acknowledgment: null,
      error: error.message
    };
  }
}

/**
 * Build system prompt for task decomposition
 */
function buildDecomposerPrompt() {
  return `You are a task decomposer for a voice assistant. Analyze the user's request and break it into discrete, actionable tasks.

Available task types and their capabilities:
- time: Get current time, date, day of week
- search: Search the web for information, answer questions, get weather, facts, definitions, current events. Also handles personal questions about the user (who am I, my name, my location, etc.) by looking up stored context.
- media: Play/pause music, skip track, volume control
- help: Explain capabilities
- smalltalk: Greetings (hi, hello, hey), goodbyes (bye, goodbye), thanks, how are you, casual conversation

Rules:
1. Break complex requests into separate tasks
2. Order tasks by dependency (independent tasks can run parallel)
3. Extract entities (locations, song names, etc) into task data
4. Use "search" for any informational question (weather, facts, definitions, "who is", "what is", etc.)
5. Use "search" for personal questions like "who am I", "what's my name", "where am I", "what apps do I have"
6. Only use "clarify" if the request is truly ambiguous or nonsensical
7. Generate a brief acknowledgment phrase for the user
8. For simple greetings like "hi" or "hello", use the smalltalk type

Respond with JSON:
{
  "tasks": [
    {
      "type": "time|search|media|help|smalltalk|clarify",
      "action": "specific action like 'get_time' or 'web_search' or 'greeting' or 'user_info'",
      "content": "original relevant phrase part",
      "data": {"location": "...", "query": "...", etc},
      "priority": "immediate|normal|background",
      "depends_on": [] // task indices this depends on
    }
  ],
  "acknowledgment": "Brief phrase to say while working, e.g. 'Let me check that for you'"
}

Examples:
- "What time is it" → 1 task (time)
- "What's the weather" → 1 task (search with query="current weather")
- "What's the weather in Denver" → 1 task (search with query="weather in Denver")
- "Who invented the telephone" → 1 task (search with query="who invented the telephone")
- "Who am I" → 1 task (search with action="user_info", query="user identity")
- "What's my name" → 1 task (search with action="user_info", query="user name")
- "What apps do I have" → 1 task (search with action="user_info", query="installed apps")
- "Play some jazz" → 1 task (media with query="jazz")
- "Turn up the volume and skip this song" → 2 tasks (media volume, media skip)
- "Hi" or "Hello" → 1 task (smalltalk with action="greeting")
- "Thanks" or "Thank you" → 1 task (smalltalk with action="thanks")`;
}

/**
 * Format conversation history for the API
 */
function formatHistory(history) {
  if (!history || history.length === 0) return [];
  
  // Keep last 5 exchanges
  return history.slice(-10).map(h => ({
    role: h.role === 'assistant' ? 'assistant' : 'user',
    content: h.content
  }));
}


module.exports = {
  decomposeTasks
};
