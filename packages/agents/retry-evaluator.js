/**
 * Retry Evaluator
 * 
 * Uses LLM to analyze failures and decide the best next action.
 * Not deterministic - reasons about each failure dynamically.
 */

const { getCircuit } = require('./circuit-breaker');

// Circuit breaker for OpenAI API calls
const openaiCircuit = getCircuit('openai-retry-eval', {
  failureThreshold: 3,
  resetTimeout: 30000,
  windowMs: 60000
});

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
 * Evaluate a failure and decide what to do next
 * @param {Object} context - What we tried and what happened
 * @returns {Promise<{action: string, params: Object, reasoning: string, shouldStop: boolean}>}
 */
async function evaluateFailure(context) {
  const { 
    originalIntent,    // What the user wanted: "play some jazz"
    attemptsMade,      // Array of {action, result, error}
    availableActions,  // What actions are possible
    maxAttempts        // How many total attempts allowed
  } = context;

  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    // No API key - can't reason, just stop
    return {
      action: 'stop',
      params: {},
      reasoning: 'No API key available for reasoning',
      shouldStop: true
    };
  }

  const systemPrompt = `You are a retry strategist. Analyze what failed and decide the best next action.

Available actions and when to use them:
- "refine_query": Try a different/simpler search term. Use when search found nothing.
- "try_genre": Search by genre instead of specific term. Use when exact match failed.
- "try_alternate_app": Switch from Music to Spotify or vice versa. Use when app seems broken.
- "shuffle_library": Just play random music. Use when nothing specific is found.
- "ask_user": Ask user to clarify. Use when intent is genuinely unclear.
- "stop": Give up. Use when we've truly exhausted options.

Respond with JSON:
{
  "action": "action_name",
  "params": { "query": "new search term", "app": "Music or Spotify", etc },
  "reasoning": "Brief explanation of why this is the best next step",
  "shouldStop": false
}

Rules:
1. Don't repeat the same action with the same params
2. If search failed, try simpler/different terms before giving up
3. After 3+ attempts, prefer "shuffle_library" or "ask_user" over more searches
4. Be creative but practical`;

  const userPrompt = `
User's intent: "${originalIntent}"

Attempts so far:
${attemptsMade.map((a, i) => `${i + 1}. ${a.action}: ${a.error || a.result}`).join('\n')}

Remaining attempts: ${maxAttempts - attemptsMade.length}

What should I try next?`;

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
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.3, // Some creativity but not random
          max_tokens: 300,
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      return response.json();
    });

    const result = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    
    console.log(`[RetryEvaluator] Decision: ${result.action} - ${result.reasoning}`);
    
    return result;

  } catch (error) {
    console.error('[RetryEvaluator] Error:', error.message);
    return {
      action: 'stop',
      params: {},
      reasoning: `Evaluation failed: ${error.message}`,
      shouldStop: true
    };
  }
}

/**
 * Extract the core intent from a user request
 * @param {string} request - Raw user request like "play some jazz music please"
 * @returns {Promise<{intent: string, searchTerm: string|null, genre: string|null, artist: string|null}>}
 */
async function extractIntent(request) {
  const apiKey = getOpenAIApiKey();
  
  if (!apiKey) {
    // Fallback: simple extraction
    const words = request.toLowerCase().replace(/play\s+/i, '').split(/\s+/);
    const fillers = ['some', 'a', 'the', 'any', 'my', 'music', 'songs', 'please'];
    const meaningful = words.filter(w => !fillers.includes(w) && w.length > 2);
    return {
      intent: request,
      searchTerm: meaningful.join(' ') || null,
      genre: null,
      artist: null
    };
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
          messages: [{
            role: 'system',
            content: `Extract music search intent from the user's request. Return JSON:
{
  "intent": "what the user wants (play music, search for X, switch output, etc)",
  "searchTerm": "the best search term to use, or null",
  "genre": "detected genre like 'jazz', 'rock', etc, or null",
  "artist": "detected artist name, or null",
  "mood": "detected mood like 'upbeat', 'relaxing', or null",
  "durationSeconds": "number of seconds if a duration was specified, or null",
  "outputDevice": "target speaker/device name if specified (e.g. 'Living Room', 'HomePod', 'Kitchen'), or null"
}

Examples:
- "play some jazz" → {"intent": "play genre", "searchTerm": "jazz", "genre": "jazz", "artist": null, "durationSeconds": null, "outputDevice": null}
- "play Beatles" → {"intent": "play artist", "searchTerm": "Beatles", "genre": null, "artist": "Beatles", "durationSeconds": null, "outputDevice": null}
- "play something relaxing" → {"intent": "play mood", "searchTerm": "relaxing", "genre": null, "artist": null, "mood": "relaxing", "durationSeconds": null, "outputDevice": null}
- "play jazz for 30 minutes" → {"intent": "play genre", "searchTerm": "jazz", "genre": "jazz", "artist": null, "durationSeconds": 1800, "outputDevice": null}
- "play rock for an hour" → {"intent": "play genre", "searchTerm": "rock", "genre": "rock", "artist": null, "durationSeconds": 3600, "outputDevice": null}
- "play music for 5 minutes" → {"intent": "play music", "searchTerm": null, "genre": null, "artist": null, "durationSeconds": 300, "outputDevice": null}
- "play jazz on living room" → {"intent": "play on device", "searchTerm": "jazz", "genre": "jazz", "artist": null, "durationSeconds": null, "outputDevice": "Living Room"}
- "switch to kitchen speaker" → {"intent": "switch output", "searchTerm": null, "genre": null, "artist": null, "durationSeconds": null, "outputDevice": "Kitchen"}
- "play on HomePod" → {"intent": "switch output", "searchTerm": null, "genre": null, "artist": null, "durationSeconds": null, "outputDevice": "HomePod"}`
          }, {
            role: 'user',
            content: request
          }],
          temperature: 0,
          max_tokens: 200,
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      return response.json();
    });

    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    
    return parsed;

  } catch (error) {
    console.error('[RetryEvaluator] Extract intent error:', error.message);
    return {
      intent: request,
      searchTerm: null,
      genre: null,
      artist: null
    };
  }
}

module.exports = {
  evaluateFailure,
  extractIntent
};
