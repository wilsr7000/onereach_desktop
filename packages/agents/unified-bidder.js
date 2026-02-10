/**
 * Unified Agent Bidder
 * 
 * ALL agents (built-in and custom) must use this module for task evaluation.
 * This is the ONLY bidding mechanism in the system.
 * 
 * POLICY (enforced by .cursorrules and agent-registry.js):
 * - All task routing is 100% LLM-based (GPT-4o-mini semantic evaluation).
 * - Agents MUST NOT have bid() methods. The registry rejects them at load time.
 * - No keyword matching, no regex, no deterministic classification of any kind.
 * - If the LLM is unavailable, agents get zero confidence (they simply cannot bid).
 * - This is intentional: deterministic routing is fragile and misroutes queries.
 */

const { getCircuit } = require('./circuit-breaker');
const { getSpacesAPI } = require('../../spaces-api');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// Circuit breaker for OpenAI API calls
// Higher threshold: with 15+ agents per query evaluated in parallel,
// rate limits or transient failures can easily trigger the breaker.
const bidderCircuit = getCircuit('unified-bidder', {
  failureThreshold: 10,
  resetTimeout: 15000,
  windowMs: 60000
});

// Cache for recent evaluations (avoid duplicate API calls)
// Two-tier: simple queries (no pronouns/context-dependent words) use content-only keys
// for higher hit rates. Context-dependent queries include conversation hash.
const evaluationCache = new Map();
const CACHE_TTL_MS = 60000; // 60 seconds (extended from 30s for better hit rate)

/**
 * Check if the bidding system is ready (has API key)
 * @returns {{ ready: boolean, error?: string }}
 */
function checkBidderReady() {
  // ai-service handles API key resolution internally
  // We can't check without making a call, so assume ready
  // Errors will surface when ai.chat() is called
  return { ready: true };
}

/**
 * Build the evaluation prompt for an agent
 * @param {Object} agent - Agent definition
 * @param {Object} task - Task to evaluate
 * @returns {string}
 */
function buildEvaluationPrompt(agent, task) {
  const agentInfo = `
AGENT: ${agent.name}
TYPE: ${agent.executionType || agent.type || 'general'}
KEYWORDS: ${(agent.keywords || []).join(', ')}
CAPABILITIES: ${(agent.capabilities || []).join(', ')}

AGENT DESCRIPTION/PROMPT:
${agent.prompt || agent.description || 'No description provided'}
`.trim();

  const userRequest = task.content || task.phrase || task;
  
  // Conversation history: prefer metadata passed through exchange (fixes the
  // TODO in exchange.ts where history was previously hardcoded to []).
  // Fall back to file read for backward compatibility.
  let conversationText = '';
  
  // 1. Try task metadata (primary path -- set by exchange-bridge, forwarded by exchange)
  if (typeof task === 'object' && task.metadata?.conversationText) {
    conversationText = task.metadata.conversationText;
  } else if (typeof task === 'object' && Array.isArray(task.metadata?.conversationHistory) && task.metadata.conversationHistory.length > 0) {
    conversationText = task.metadata.conversationHistory
      .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n');
  }
  
  // 2. Fallback: read from file in GSX Agent space
  if (!conversationText) {
    try {
      const api = getSpacesAPI();
      const historyContent = api.files.read('gsx-agent', 'conversation-history.md');
      if (historyContent) {
        const lines = historyContent.split('\n');
        const conversationLines = lines.filter(line => 
          line.startsWith('User:') || line.startsWith('Assistant:')
        );
        conversationText = conversationLines.join('\n');
      }
    } catch (err) {
      // No history file yet, that's okay
    }
  }
  
  // Read user profile for personalized routing
  // Profile is pre-loaded by exchange-bridge on startup; access synchronously here
  let userProfileText = '';
  try {
    const { getUserProfile } = require('../../lib/user-profile-store');
    const profile = getUserProfile();
    if (profile.isLoaded()) {
      userProfileText = profile.getContextString();
    }
  } catch (err) {
    // User profile not available yet, that's okay
  }

  // Read session summaries for multi-session continuity
  let sessionSummaryText = '';
  try {
    const api = getSpacesAPI();
    const summariesContent = api.files.read('gsx-agent', 'session-summaries.md');
    if (summariesContent) {
      const lines = summariesContent.split('\n').filter(l => l.startsWith('- '));
      sessionSummaryText = lines.slice(0, 5).join('\n'); // Last 5 summaries
    }
  } catch (err) {
    // No summaries yet
  }

  const conversationSection = conversationText 
    ? `\n\nRECENT CONVERSATION (for context - helps resolve pronouns like "it", "that", "this"):\n${conversationText}\n`
    : '';

  const userProfileSection = userProfileText
    ? `\n\nUSER PROFILE (known facts about this user):\n${userProfileText}\n`
    : '';

  const sessionSummarySection = sessionSummaryText
    ? `\n\nPREVIOUS SESSIONS (for continuity):\n${sessionSummaryText}\n`
    : '';

  return `You are an intelligent task router evaluating if an agent can handle a voice command.

${agentInfo}
${userProfileSection}${sessionSummarySection}${conversationSection}
USER'S CURRENT REQUEST: "${userRequest}"

## Evaluation Strategy

Think step-by-step about USER INTENT, not just keywords:

1. **What is the user actually trying to accomplish?**
   - Strip away filler words and focus on the core intent
   - "What's happening Monday" = user wants to know their schedule for Monday
   - "Play something" = user wants music to play
   
2. **Use CONVERSATION CONTEXT to resolve pronouns and references:**
   - If user says "Play it" after asking about a podcast → they want to play THAT podcast
   - If user says "Tell me more" after a search result → they want more info on THAT topic
   - "it", "that", "this", "the same" often refer to something in recent conversation
   - ALWAYS check the conversation history when the request contains pronouns
   
3. **Does this agent's domain cover that intent?**
   - Calendar agent handles: schedules, meetings, events, availability, what's happening when
   - Music/DJ agent handles: playing, controlling, discovering music AND podcasts
   - Search agent handles: information lookup, research, learning about things
   - Weather agent handles: conditions, forecasts, temperature
   
4. **Semantic matching - go beyond keywords:**
   - "What's happening Monday?" → Calendar (asking about schedule on a specific day)
   - "What's going on tomorrow?" → Calendar (schedule inquiry)
   - "Am I free at 3?" → Calendar (availability check)
   - "Put on some tunes" → Music (even though "tunes" might not be a keyword)
   - "What's the deal outside?" → Weather (asking about conditions)

5. **Look for IMPLICIT signals:**
   - Day names (Monday-Sunday) + "what's happening/what do I have" = calendar (schedule on that day)
   - "What's today's date?" or "What day is it?" = TIME query (asking the actual date/day of week)
   - "What do I have today/tomorrow?" = CALENDAR query (asking about events)
   - The difference: asking for the DATE ITSELF = time agent; asking for EVENTS on a date = calendar agent
   - Mood words (relaxing, energetic) often signal music requests
   - Location words might signal weather queries

## Confidence Guidelines

- **0.85-1.0**: Clear match - user explicitly mentions this agent's domain OR the intent obviously maps to it
- **0.70-0.84**: Strong match - intent aligns well even if keywords don't match exactly
- **0.50-0.69**: Possible match - could handle it but another agent might be better
- **0.20-0.49**: Weak match - tangentially related at best
- **0.00-0.19**: No match - completely different domain

## CRITICAL: Match Confidence to Your Analysis

**THIS IS EXTREMELY IMPORTANT:**
- If you determine the request is for a DIFFERENT agent's domain, you MUST return LOW confidence (0.00-0.20)
- Do NOT say "this is a calendar query" and then return 0.85 - that's contradictory
- Your confidence score MUST align with whether THIS agent can handle the request

**Example of WRONG output:**
"reasoning": "This is a calendar inquiry, not music related"
"confidence": 0.95  <- WRONG! Should be 0.00

**Example of CORRECT output:**
"reasoning": "This is a calendar inquiry, not music related"  
"confidence": 0.00  <- CORRECT! Matches the reasoning

## Critical Rules

1. **Day names + "what's happening/what do I have" = calendar** (e.g., "What's happening Monday?" = 0.85+ for calendar, 0.00 for music/weather/etc.)
2. **"What's the date?" / "What day is it?" = TIME** (asking the actual date/day of week from the system clock, NOT calendar)
3. **Don't be too literal** - "What's going on" about a day = schedule query, not small talk
4. **Context matters** - asking about EVENTS on a day = calendar; asking the actual DATE = time
5. **When in doubt, consider what data the agent has access to**
6. **If the request doesn't match this agent's domain, return confidence 0.00-0.15**

## Fast-Path Response (Context-Grounded Only)

You MAY include a "result" field with a direct answer to SKIP full agent execution.
But ONLY if the answer comes ENTIRELY from information ALREADY IN THIS PROMPT.

BEFORE generating a result, ask yourself:
"Am I writing this answer from text I can see in this prompt (conversation history,
user profile, agent description), or am I pulling it from my training data?"
If the answer is training data, you MUST set result to null.

SAFE to answer (information is visible in this prompt):
- Greetings, farewells, thanks, casual chat (no facts needed)
- Questions about the agent's own capabilities (described in the agent prompt above)
- References to what the user just said (conversation history above)
- The user's name or preferences (from user profile above)

NEVER answer -- you WILL hallucinate (set result to null):
- Current time, date, or day of week (you do NOT have a clock)
- Weather, temperature, or conditions (you do NOT have a weather API)
- Calendar events, meetings, schedules (you do NOT have calendar access)
- Email contents or counts (you do NOT have email access)
- Search results or factual knowledge (you do NOT have web access)
- Any "daily brief", "morning brief", "rundown" (requires multiple live data sources)
- Anything that could be different right now than when you were trained

ALSO set result to null if:
- The agent type is "action" or "system" (these MUST execute to fetch real data)
- The request requires any side effect (playing music, sending email, recording, etc.)

If in doubt, set result to null. A wrong fast-path answer destroys user trust.

Respond with JSON only:
{
  "confidence": 0.0-1.0,
  "plan": "Brief execution plan if confidence > 0.3",
  "reasoning": "1-2 sentences: What is the user's intent? Why does/doesn't this agent match?",
  "hallucinationRisk": "none | low | high",
  "result": "Direct answer ONLY if hallucinationRisk is 'none' or 'low' AND answer is from this prompt's context. Otherwise null."
}

hallucinationRisk guide:
- "none": Pure conversation (greeting, thanks, joke) -- no facts involved
- "low": Answer references only data visible in this prompt (history, profile, capabilities)
- "high": Answer would require external/live data (time, weather, calendar, email, search) -- MUST set result to null`;
}

/**
 * Generate cache key for an evaluation
 * Includes conversation context hash to handle pronouns correctly
 */
/**
 * Two-tier cache key strategy:
 * - Tier 1 (content-only): For queries that don't depend on conversation context
 *   (e.g., "what time is it", "give me my morning brief", "tell me a joke").
 *   These get much higher cache hit rates because the context hash doesn't change.
 * - Tier 2 (context-aware): For queries with pronouns or references that depend
 *   on conversation history (e.g., "play it", "tell me more", "do that again").
 */
const CONTEXT_DEPENDENT_WORDS = /\b(it|that|this|them|those|these|the same|more|again|too|also|instead)\b/i;

function getCacheKey(agent, task) {
  const agentId = agent.id || agent.name;
  const taskContent = (task.content || task.phrase || String(task)).toLowerCase().trim();

  // Tier 1: simple queries with no pronoun/reference dependencies → content-only key
  if (!CONTEXT_DEPENDENT_WORDS.test(taskContent)) {
    return `${agentId}:${taskContent}`;
  }

  // Tier 2: context-dependent queries → include conversation hash
  let contextHash = '';
  try {
    // Prefer metadata (set by exchange-bridge) over file read
    if (typeof task === 'object' && task.metadata?.conversationText) {
      contextHash = task.metadata.conversationText.slice(-100).replace(/\s+/g, ' ').trim();
    } else {
      const api = getSpacesAPI();
      const historyContent = api.files.read('gsx-agent', 'conversation-history.md');
      if (historyContent) {
        contextHash = historyContent.slice(-100).replace(/\s+/g, ' ').trim();
      }
    }
  } catch (err) {
    // No history file
  }
  return `${agentId}:${taskContent}:${contextHash}`;
}

/**
 * Get cached evaluation if available
 */
function getCachedEvaluation(cacheKey) {
  const cached = evaluationCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    log.info('agent', 'Cache hit', { key: cacheKey.substring(0, 50) });
    return cached.result;
  }
  return null;
}

/**
 * Cache an evaluation result
 */
function cacheEvaluation(cacheKey, result) {
  evaluationCache.set(cacheKey, {
    result,
    timestamp: Date.now()
  });
  
  // Clean old entries periodically
  if (evaluationCache.size > 100) {
    const now = Date.now();
    for (const [key, value] of evaluationCache.entries()) {
      if (now - value.timestamp > CACHE_TTL_MS) {
        evaluationCache.delete(key);
      }
    }
  }
}

/**
 * Evaluate if an agent can handle a task using LLM
 * This is the ONLY way agents can bid - no keyword fallback
 * 
 * @param {Object} agent - Agent definition (name, keywords, prompt, capabilities, executionType)
 * @param {Object} task - Task to evaluate (content/phrase)
 * @returns {Promise<{ confidence: number, plan: string, reasoning: string }>}
 */
async function evaluateAgentBid(agent, task) {
  // Check cache first
  const cacheKey = getCacheKey(agent, task);
  const cached = getCachedEvaluation(cacheKey);
  if (cached) {
    return cached;
  }
  
  const prompt = buildEvaluationPrompt(agent, task);
  
  try {
    const result = await bidderCircuit.execute(async () => {
      return await ai.chat({
        profile: 'fast',
        system: prompt,
        messages: [],
        temperature: 0,
        maxTokens: 200,
        jsonMode: true,
        feature: 'unified-bidder'
      });
    });

    const content = result.content;
    
    if (!content) {
      log.error('agent', 'Empty response for agent', { name: agent.name });
      return { confidence: 0, plan: '', reasoning: 'Empty LLM response' };
    }

    const evaluation = JSON.parse(content);
    
    // Validate and normalize
    let confidence = Math.max(0, Math.min(1, parseFloat(evaluation.confidence) || 0));
    const reasoning = evaluation.reasoning || '';
    
    // SANITY CHECK: Detect contradictory responses where reasoning says "doesn't match"
    // but confidence is high. This is a common LLM failure mode.
    // Only trigger on CLEAR negative signals -- never on phrases that could be affirmative
    // for the agent being evaluated (e.g. "this is a time query" is CORRECT for time-agent).
    const reasoningLower = reasoning.toLowerCase();
    const indicatesNoMatch = 
      reasoningLower.includes('does not align') ||
      reasoningLower.includes('doesn\'t align') ||
      reasoningLower.includes('not related') ||
      reasoningLower.includes('not match') ||
      reasoningLower.includes('doesn\'t match') ||
      reasoningLower.includes('different domain') ||
      reasoningLower.includes('outside the') ||
      reasoningLower.includes('unsuitable') ||
      reasoningLower.includes('falls under the domain of');
    
    // If reasoning indicates no match but confidence is high, fix it
    if (indicatesNoMatch && confidence > 0.3) {
      log.info('agent', `Correcting contradictory response for ${agent.name}: "${reasoning.substring(0, 50)}..." had confidence ${confidence}, setting to 0.05`);
      confidence = 0.05;
    }
    
    // Hallucination guard: strip fast-path result if risk is high
    const hallucinationRisk = evaluation.hallucinationRisk || 'high'; // Default to high if not specified
    let fastPathResult = evaluation.result || null;
    if (fastPathResult && hallucinationRisk === 'high') {
      log.info('agent', `${agent.name} fast-path result STRIPPED (hallucinationRisk=high): "${(fastPathResult || '').substring(0, 50)}..."`);
      fastPathResult = null;
    }
    
    const normalized = {
      confidence,
      plan: evaluation.plan || '',
      reasoning,
      hallucinationRisk,
      result: fastPathResult,  // Fast-path: only if hallucination risk is acceptable
    };
    
    if (normalized.result) {
      log.info('agent', `${agent.name} fast-path result on "${(task.content || task.phrase || '').substring(0, 30)}..."`);
    }
    log.info('agent', `${agent.name} bid ${normalized.confidence.toFixed(2)} on "${(task.content || task.phrase || '').substring(0, 30)}..."`);
    
    // Cache the result
    cacheEvaluation(cacheKey, normalized);
    
    return normalized;

  } catch (error) {
    log.error('agent', `Evaluation failed for ${agent.name}`, { error: error.message });
    
    // Circuit breaker may be open
    if (error.message.includes('Circuit breaker')) {
      return {
        confidence: 0,
        plan: '',
        reasoning: 'Bidding system temporarily unavailable'
      };
    }
    
    return {
      confidence: 0,
      plan: '',
      reasoning: `Evaluation error: ${error.message}`
    };
  }
}

/**
 * Get bids from multiple agents for a task
 * @param {Array} agents - Array of agent definitions
 * @param {Object} task - Task to bid on
 * @returns {Promise<Array<{ agent, confidence, plan, reasoning }>>}
 */
async function getBidsFromAgents(agents, task) {
  const { ready, error } = checkBidderReady();
  if (!ready) {
    log.error('agent', 'Bidder not ready', { error });
    return [];
  }
  
  // Evaluate all agents in parallel
  const bidPromises = agents.map(async (agent) => {
    const evaluation = await evaluateAgentBid(agent, task);
    return {
      agent,
      agentId: agent.id || agent.name,
      ...evaluation
    };
  });
  
  const bids = await Promise.all(bidPromises);
  
  // Filter out zero-confidence bids and sort by confidence
  return bids
    .filter(bid => bid.confidence > 0.1)
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * Select the winning bid
 * @param {Array} bids - Sorted array of bids
 * @returns {{ winner: Object|null, backups: Array }}
 */
function selectWinner(bids) {
  if (!bids || bids.length === 0) {
    return { winner: null, backups: [] };
  }
  
  // Winner must have confidence >= 0.5
  const winner = bids[0].confidence >= 0.5 ? bids[0] : null;
  
  // Backups are other viable bids
  const backups = bids.slice(1).filter(b => b.confidence >= 0.5);
  
  return { winner, backups };
}

/**
 * Batch-evaluate ALL agents in a SINGLE LLM call.
 *
 * Instead of 15+ concurrent GPT calls per query (which triggers rate limits),
 * send one prompt listing every agent and ask for a ranked result.
 *
 * @param {Array} agents - Array of agent definitions
 * @param {Object} task  - Task to evaluate  { content/phrase, metadata? }
 * @returns {Promise<Map<string, { confidence: number, plan: string, reasoning: string, result?: string }>>}
 *          keyed by agent.id
 */
async function batchEvaluateAgents(agents, task) {
  const results = new Map();
  if (!agents || agents.length === 0) return results;

  const userRequest = task.content || task.phrase || String(task);

  // Build conversation context (same logic as buildEvaluationPrompt)
  let conversationText = '';
  if (typeof task === 'object' && task.metadata?.conversationText) {
    conversationText = task.metadata.conversationText;
  } else if (typeof task === 'object' && Array.isArray(task.metadata?.conversationHistory) && task.metadata.conversationHistory.length > 0) {
    conversationText = task.metadata.conversationHistory
      .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n');
  }
  if (!conversationText) {
    try {
      const api = getSpacesAPI();
      const historyContent = api.files.read('gsx-agent', 'conversation-history.md');
      if (historyContent) {
        conversationText = historyContent.split('\n')
          .filter(l => l.startsWith('User:') || l.startsWith('Assistant:'))
          .join('\n');
      }
    } catch (_) {}
  }

  // User profile
  let userProfileText = '';
  try {
    const { getUserProfile } = require('../../lib/user-profile-store');
    const profile = getUserProfile();
    if (profile.isLoaded()) userProfileText = profile.getContextString();
  } catch (_) {}

  // Agent summaries (compact to keep prompt small)
  const agentLines = agents.map((a, i) => {
    const caps = (a.capabilities || []).slice(0, 8).join('; ');
    const kw   = (a.keywords || []).slice(0, 10).join(', ');
    const desc = (a.prompt || a.description || '').substring(0, 500);
    return `### Agent ${i + 1}: ${a.name} (id: ${a.id || a.name})
TYPE: ${a.executionType || a.type || 'general'}
KEYWORDS: ${kw}
CAPABILITIES: ${caps}
DESCRIPTION: ${desc}`;
  }).join('\n\n');

  const conversationSection = conversationText
    ? `\nRECENT CONVERSATION:\n${conversationText}\n`
    : '';
  const profileSection = userProfileText
    ? `\nUSER PROFILE:\n${userProfileText}\n`
    : '';

  const systemPrompt = `You are an intelligent task router. Given a user's voice command and a list of agents, determine which agent(s) can handle it.
${profileSection}${conversationSection}
## Available Agents

${agentLines}

## USER REQUEST: "${userRequest}"

## Instructions

For EACH agent, decide confidence 0.0-1.0:
- 0.85-1.0: Clear match - domain obviously covers the request
- 0.70-0.84: Strong match
- 0.50-0.69: Possible match
- 0.20-0.49: Weak match
- 0.00-0.19: No match

Think about USER INTENT, not just keywords. "What does my day look like" = calendar. "morning brief" = calendar. "am I free" = calendar. Day names = calendar.

CRITICAL: Only ONE agent should get high confidence for a given request. Return the TOP agents that match.

Respond with a JSON array of objects (ONLY agents with confidence > 0.1):
[
  { "id": "<agent id>", "confidence": 0.0-1.0, "plan": "brief plan", "reasoning": "why" }
]

If NO agent matches, return an empty array [].
Return ONLY valid JSON, no markdown fences.`;

  try {
    const result = await bidderCircuit.execute(async () => {
      return await ai.chat({
        profile: 'fast',
        system: systemPrompt,
        messages: [],
        temperature: 0,
        maxTokens: 600,
        jsonMode: true,
        feature: 'unified-bidder-batch'
      });
    });

    let parsed;
    try {
      parsed = JSON.parse(result.content);
    } catch (_) {
      log.error('agent', 'Batch evaluation JSON parse failed', { raw: (result.content || '').substring(0, 200) });
      return results;
    }

    if (!Array.isArray(parsed)) {
      log.warn('agent', 'Batch evaluation returned non-array, wrapping');
      parsed = [parsed];
    }

    for (const entry of parsed) {
      if (!entry || !entry.id) continue;
      const confidence = Math.max(0, Math.min(1, parseFloat(entry.confidence) || 0));
      results.set(entry.id, {
        confidence,
        plan: entry.plan || '',
        reasoning: entry.reasoning || '',
        result: entry.result || null,
      });
    }

    log.info('agent', `Batch evaluation: ${results.size} agents matched for "${userRequest.substring(0, 40)}"`, {
      matches: Array.from(results.entries()).map(([id, r]) => `${id}:${r.confidence.toFixed(2)}`).join(', ')
    });
  } catch (error) {
    log.error('agent', 'Batch evaluation failed', { error: error.message });
  }

  return results;
}

// ==================== BATCH COORDINATOR ====================
// Deduplicates concurrent batch calls for the same auction.
// The first caller triggers the LLM call; all others await the same promise.
const _pendingBatches = new Map(); // auctionId -> Promise<Map>

/**
 * Coordinate batch evaluation across agents for one auction.
 * All callers with the same auctionId share a single LLM call.
 *
 * @param {string}  auctionId
 * @param {Array}   allAgents  - full agent list to evaluate
 * @param {Object}  task
 * @returns {Promise<Map>}  per-agent results
 */
async function coordinatedBatchEval(auctionId, allAgents, task) {
  if (_pendingBatches.has(auctionId)) {
    return _pendingBatches.get(auctionId);
  }
  const promise = batchEvaluateAgents(allAgents, task).finally(() => {
    _pendingBatches.delete(auctionId);
  });
  _pendingBatches.set(auctionId, promise);
  return promise;
}

/**
 * Clear the evaluation cache (for testing or refresh)
 */
function clearCache() {
  evaluationCache.clear();
  log.info('agent', 'Cache cleared');
}

module.exports = {
  evaluateAgentBid,
  getBidsFromAgents,
  selectWinner,
  checkBidderReady,
  clearCache,
  batchEvaluateAgents,
  coordinatedBatchEval,
};
