/**
 * Retry Evaluator
 * 
 * Uses LLM to analyze failures and decide the best next action.
 * Not deterministic - reasons about each failure dynamically.
 */

const { getCircuit } = require('./circuit-breaker');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// Circuit breaker for OpenAI API calls
const openaiCircuit = getCircuit('openai-retry-eval', {
  failureThreshold: 3,
  resetTimeout: 30000,
  windowMs: 60000
});

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
    const result = await openaiCircuit.execute(async () => {
      const data = await ai.chat({
        profile: 'fast',
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        maxTokens: 300,
        jsonMode: true,
        feature: 'retry-evaluator',
      });
      return JSON.parse(data.content || '{}');
    });
    
    log.info('agent', `Decision: ${result.action} - ${result.reasoning}`);
    
    return result;

  } catch (error) {
    log.error('agent', 'Error', { error: error.message });
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
  try {
    // Use circuit breaker to protect against cascading failures
    const parsed = await openaiCircuit.execute(async () => {
      const data = await ai.chat({
        profile: 'fast',
        system: `Extract music search intent from the user's request. Return JSON:
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
- "play on HomePod" → {"intent": "switch output", "searchTerm": null, "genre": null, "artist": null, "durationSeconds": null, "outputDevice": "HomePod"}`,
        messages: [
          { role: 'user', content: request }
        ],
        temperature: 0,
        maxTokens: 200,
        jsonMode: true,
        feature: 'retry-evaluator',
      });
      return JSON.parse(data.content || '{}');
    });
    
    return parsed;

  } catch (error) {
    log.error('agent', 'Extract intent error', { error: error.message });
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
}

module.exports = {
  evaluateFailure,
  extractIntent
};
