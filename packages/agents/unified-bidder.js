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
  windowMs: 60000,
});

/**
 * Attempt to salvage truncated JSON from LLM output that hit maxTokens.
 * Extracts confidence/reasoning via regex as a last resort.
 */
function repairTruncatedJSON(raw) {
  try {
    // Try closing open strings and braces
    let patched = raw;
    const openQuotes = (patched.match(/"/g) || []).length;
    if (openQuotes % 2 !== 0) patched += '"';
    const opens = (patched.match(/\{/g) || []).length;
    const closes = (patched.match(/\}/g) || []).length;
    for (let i = 0; i < opens - closes; i++) patched += '}';
    const result = JSON.parse(patched);
    if (typeof result.confidence !== 'undefined') return result;
  } catch (_) { /* repair failed */ }

  // Regex fallback: extract confidence number
  const confMatch = raw.match(/"confidence"\s*:\s*([\d.]+)/);
  if (confMatch) {
    const reasonMatch = raw.match(/"reasoning"\s*:\s*"([^"]*)/);
    return {
      confidence: parseFloat(confMatch[1]) || 0,
      reasoning: reasonMatch ? reasonMatch[1] : 'Truncated response',
      plan: '',
    };
  }
  return null;
}

// Cache for recent evaluations (avoid duplicate API calls for identical requests)
const evaluationCache = new Map();
const CACHE_TTL_MS = 60000; // 60 seconds

/**
 * Generate cache key: exact agent ID + exact task content.
 * No fuzzy matching, no truncation, no tier system.
 */
function getCacheKey(agent, task) {
  const agentId = agent.id || agent.name;
  const taskContent = (task.content || task.phrase || String(task)).toLowerCase().trim();
  return `${agentId}:${taskContent}`;
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
CAPABILITIES: ${(agent.capabilities || []).join(', ')}

WHAT THIS AGENT DOES:
${agent.prompt || agent.description || 'No description provided'}
`.trim();

  const userRequest = task.content || task.phrase || task;

  let conversationText = '';
  if (typeof task === 'object' && task.metadata?.conversationText) {
    conversationText = task.metadata.conversationText;
  } else if (
    typeof task === 'object' &&
    Array.isArray(task.metadata?.conversationHistory) &&
    task.metadata.conversationHistory.length > 0
  ) {
    conversationText = task.metadata.conversationHistory
      .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n');
  }

  if (!conversationText) {
    try {
      const api = getSpacesAPI();
      const historyContent = api.files.read('gsx-agent', 'conversation-history.md');
      if (historyContent) {
        const lines = historyContent.split('\n');
        const conversationLines = lines.filter((line) => line.startsWith('User:') || line.startsWith('Assistant:'));
        conversationText = conversationLines.join('\n');
      }
    } catch (_err) {
      // No history file yet
    }
  }

  let userProfileText = '';
  try {
    const { getUserProfile } = require('../../lib/user-profile-store');
    const profile = getUserProfile();
    if (profile.isLoaded()) {
      userProfileText = profile.getContextString();
    }
  } catch (_err) {
    // User profile not available yet
  }

  let sessionSummaryText = '';
  try {
    const api = getSpacesAPI();
    const summariesContent = api.files.read('gsx-agent', 'session-summaries.md');
    if (summariesContent) {
      const lines = summariesContent.split('\n').filter((l) => l.startsWith('- '));
      sessionSummaryText = lines.slice(0, 5).join('\n');
    }
  } catch (_err) {
    // No summaries yet
  }

  let situationText = '';
  if (typeof task === 'object' && task.metadata?.situationContext) {
    const sc = task.metadata.situationContext;
    const parts = [];
    if (sc.focusedWindow) parts.push(`Active window: ${sc.focusedWindow}`);
    if (sc.openWindows?.length) parts.push(`Open windows: ${sc.openWindows.join(', ')}`);
    if (sc.flowContext?.label) parts.push(`Edison flow: ${sc.flowContext.label}`);
    if (sc.flowContext?.stepLabel) parts.push(`Current step: ${sc.flowContext.stepLabel}`);
    if (parts.length > 0) situationText = parts.join('\n');
  }

  const conversationSection = conversationText
    ? `\nRECENT CONVERSATION:\n${conversationText}\n`
    : '';

  const userProfileSection = userProfileText
    ? `\nUSER PROFILE:\n${userProfileText}\n`
    : '';

  const sessionSummarySection = sessionSummaryText
    ? `\nPREVIOUS SESSIONS:\n${sessionSummaryText}\n`
    : '';

  const situationSection = situationText
    ? `\nCURRENT SITUATION (what the user is doing right now):\n${situationText}\n`
    : '';

  return `You are evaluating whether a specific agent can handle a user's request.

Read the agent's description and capabilities below. Then read the user's request.
Can this agent fulfill what the user is asking for? Rate your confidence based on
how well the request falls within the agent's capabilities.
Use the current situation to understand context -- for example, if the user says
"this" or "here", consider what window or tool they are currently using.

${agentInfo}
${userProfileSection}${sessionSummarySection}${situationSection}${conversationSection}
USER REQUEST: "${userRequest}"

Use conversation history to resolve pronouns ("it", "that", "this", etc.).

Rate confidence 0.0-1.0 based on whether this agent can complete the request:
- 0.85-1.0: The request clearly falls within this agent's capabilities
- 0.50-0.84: The request likely falls within this agent's capabilities
- 0.00-0.49: The request is outside this agent's capabilities

You MAY include a "result" field with a direct answer ONLY if:
- The answer comes entirely from information already in this prompt (conversation, profile, agent description)
- The agent type is NOT "action" or "system"
- The request does NOT require any side effect (playing music, sending email, etc.)
- The request does NOT need live data (time, weather, calendar, search results)
If any of those conditions fail, set result to null.

Respond with JSON:
{
  "confidence": 0.0-1.0,
  "plan": "Brief execution plan if confidence > 0.3",
  "reasoning": "Why does/doesn't this agent match?",
  "hallucinationRisk": "none | low | high",
  "result": "Direct answer from prompt context only, or null"
}`;
}

/**
 * Generate cache key for an evaluation
 * Includes conversation context hash to handle pronouns correctly
 */
/**
 * Check if the bidding system is ready (has API key)
 * @returns {{ ready: boolean, error?: string }}
 */
function checkBidderReady() {
  return { ready: true };
}

/**
 * Get cached evaluation if available
 */
function getCachedEvaluation(cacheKey) {
  const cached = evaluationCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
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
    timestamp: Date.now(),
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
        maxTokens: 300,
        jsonMode: true,
        feature: 'unified-bidder',
      });
    });

    const content = result.content;

    if (!content) {
      log.error('agent', 'Empty response for agent', { name: agent.name });
      return { confidence: 0, plan: '', reasoning: 'Empty LLM response' };
    }

    // Strip markdown code fences if present (safety net for models that wrap JSON)
    let raw = content;
    raw = raw
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();

    let evaluation;
    try {
      evaluation = JSON.parse(raw);
    } catch (parseErr) {
      // LLM may exceed maxTokens and produce truncated JSON -- attempt repair
      evaluation = repairTruncatedJSON(raw);
      if (!evaluation) throw parseErr;
    }

    // Validate and normalize
    let confidence = Math.max(0, Math.min(1, parseFloat(evaluation.confidence) || 0));
    const reasoning = evaluation.reasoning || '';

    // Hallucination guard: strip fast-path result if risk is high
    const hallucinationRisk = evaluation.hallucinationRisk || 'high'; // Default to high if not specified
    let fastPathResult = evaluation.result || null;
    if (fastPathResult && hallucinationRisk === 'high') {
      log.info(
        'agent',
        `${agent.name} fast-path result STRIPPED (hallucinationRisk=high): "${(fastPathResult || '').substring(0, 50)}..."`
      );
      fastPathResult = null;
    }

    const normalized = {
      confidence,
      plan: evaluation.plan || '',
      reasoning,
      hallucinationRisk,
      result: fastPathResult, // Fast-path: only if hallucination risk is acceptable
    };

    if (normalized.result) {
      log.info(
        'agent',
        `${agent.name} fast-path result on "${(task.content || task.phrase || '').substring(0, 30)}..."`
      );
    }
    log.info(
      'agent',
      `${agent.name} bid ${normalized.confidence.toFixed(2)} on "${(task.content || task.phrase || '').substring(0, 30)}..."`
    );

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
        reasoning: 'Bidding system temporarily unavailable',
      };
    }

    return {
      confidence: 0,
      plan: '',
      reasoning: `Evaluation error: ${error.message}`,
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
      ...evaluation,
    };
  });

  const bids = await Promise.all(bidPromises);

  // Filter out zero-confidence bids and sort by confidence
  return bids.filter((bid) => bid.confidence > 0.1).sort((a, b) => b.confidence - a.confidence);
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
  const backups = bids.slice(1).filter((b) => b.confidence >= 0.5);

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
  } else if (
    typeof task === 'object' &&
    Array.isArray(task.metadata?.conversationHistory) &&
    task.metadata.conversationHistory.length > 0
  ) {
    conversationText = task.metadata.conversationHistory
      .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n');
  }
  if (!conversationText) {
    try {
      const api = getSpacesAPI();
      const historyContent = api.files.read('gsx-agent', 'conversation-history.md');
      if (historyContent) {
        conversationText = historyContent
          .split('\n')
          .filter((l) => l.startsWith('User:') || l.startsWith('Assistant:'))
          .join('\n');
      }
    } catch (_ignored) {
      /* conversation history optional */
    }
  }

  // User profile
  let userProfileText = '';
  try {
    const { getUserProfile } = require('../../lib/user-profile-store');
    const profile = getUserProfile();
    if (profile.isLoaded()) userProfileText = profile.getContextString();
  } catch (_ignored) {
    /* user profile optional context */
  }

  // Agent summaries (compact to keep prompt small)
  const agentLines = agents
    .map((a, i) => {
      const caps = (a.capabilities || []).slice(0, 8).join('; ');
      const kw = (a.keywords || []).slice(0, 10).join(', ');
      const desc = (a.prompt || a.description || '').substring(0, 500);
      return `### Agent ${i + 1}: ${a.name} (id: ${a.id || a.name})
TYPE: ${a.executionType || a.type || 'general'}
KEYWORDS: ${kw}
CAPABILITIES: ${caps}
DESCRIPTION: ${desc}`;
    })
    .join('\n\n');

  const conversationSection = conversationText ? `\nRECENT CONVERSATION:\n${conversationText}\n` : '';
  const profileSection = userProfileText ? `\nUSER PROFILE:\n${userProfileText}\n` : '';

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
        feature: 'unified-bidder-batch',
      });
    });

    let parsed;
    try {
      let batchRaw = result.content || '';
      batchRaw = batchRaw
        .replace(/^```(?:json)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();
      parsed = JSON.parse(batchRaw);
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
      matches: Array.from(results.entries())
        .map(([id, r]) => `${id}:${r.confidence.toFixed(2)}`)
        .join(', '),
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
