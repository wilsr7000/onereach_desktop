/**
 * Unified Agent Bidder
 * 
 * ALL agents (built-in and custom) must use this module for task evaluation.
 * No keyword fallbacks - LLM evaluation is mandatory.
 */

const { getCircuit } = require('./circuit-breaker');
const { getBudgetManager } = require('../../budget-manager');

// Circuit breaker for OpenAI API calls
const bidderCircuit = getCircuit('unified-bidder', {
  failureThreshold: 3,
  resetTimeout: 30000,
  windowMs: 60000
});

// Cache for recent evaluations (avoid duplicate API calls)
const evaluationCache = new Map();
const CACHE_TTL_MS = 30000; // 30 seconds

/**
 * Get OpenAI API key from app settings
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
 * Check if the bidding system is ready (has API key)
 * @returns {{ ready: boolean, error?: string }}
 */
function checkBidderReady() {
  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    return {
      ready: false,
      error: 'OpenAI API key required for agent bidding. Please add it in Settings.'
    };
  }
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

  return `You are an intelligent task router evaluating if an agent can handle a voice command.

${agentInfo}

USER'S REQUEST: "${userRequest}"

## Evaluation Strategy

Think step-by-step about USER INTENT, not just keywords:

1. **What is the user actually trying to accomplish?**
   - Strip away filler words and focus on the core intent
   - "What's happening Monday" = user wants to know their schedule for Monday
   - "Play something" = user wants music to play
   
2. **Does this agent's domain cover that intent?**
   - Calendar agent handles: schedules, meetings, events, availability, what's happening when
   - Music agent handles: playing, controlling, discovering music
   - Weather agent handles: conditions, forecasts, temperature
   
3. **Semantic matching - go beyond keywords:**
   - "What's happening Monday?" → Calendar (asking about schedule on a specific day)
   - "What's going on tomorrow?" → Calendar (schedule inquiry)
   - "Am I free at 3?" → Calendar (availability check)
   - "Put on some tunes" → Music (even though "tunes" might not be a keyword)
   - "What's the deal outside?" → Weather (asking about conditions)

4. **Look for IMPLICIT signals:**
   - Day names (Monday-Sunday) often signal calendar queries
   - Time references (today, tomorrow, this week) often signal calendar/scheduling
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

1. **Day names + question = likely calendar** (e.g., "What's happening Monday?" = 0.85+ for calendar, 0.00 for music/weather/etc.)
2. **Don't be too literal** - "What's going on" about a day = schedule query, not small talk
3. **Context matters** - a time reference in a question usually means schedule/calendar
4. **When in doubt, consider what data the agent has access to**
5. **If the request doesn't match this agent's domain, return confidence 0.00-0.15**

Respond with JSON only:
{
  "confidence": 0.0-1.0,
  "plan": "Brief execution plan if confidence > 0.3",
  "reasoning": "1-2 sentences: What is the user's intent? Why does/doesn't this agent match?"
}`;
}

/**
 * Generate cache key for an evaluation
 */
function getCacheKey(agent, task) {
  const agentId = agent.id || agent.name;
  const taskContent = task.content || task.phrase || String(task);
  return `${agentId}:${taskContent.toLowerCase().trim()}`;
}

/**
 * Get cached evaluation if available
 */
function getCachedEvaluation(cacheKey) {
  const cached = evaluationCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log('[UnifiedBidder] Cache hit for:', cacheKey.substring(0, 50));
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
  
  // Check API key
  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    console.error('[UnifiedBidder] No API key - agent cannot bid:', agent.name);
    return {
      confidence: 0,
      plan: '',
      reasoning: 'API key not configured'
    };
  }
  
  const prompt = buildEvaluationPrompt(agent, task);
  
  try {
    const result = await bidderCircuit.execute(async () => {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: prompt }
          ],
          temperature: 0,
          max_tokens: 200,
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error ${response.status}: ${errorText.substring(0, 100)}`);
      }

      return response.json();
    });

    const content = result.choices?.[0]?.message?.content;
    
    // Track API usage for cost monitoring
    if (result.usage) {
      try {
        const budgetManager = getBudgetManager();
        budgetManager.trackUsage({
          provider: 'openai',
          model: 'gpt-4o-mini',
          inputTokens: result.usage.prompt_tokens || 0,
          outputTokens: result.usage.completion_tokens || 0,
          feature: 'agent-bidding',
          operation: 'evaluate-agent',
          projectId: null
        });
      } catch (trackError) {
        console.warn('[UnifiedBidder] Failed to track usage:', trackError.message);
      }
    }
    
    if (!content) {
      console.error('[UnifiedBidder] Empty response for agent:', agent.name);
      return { confidence: 0, plan: '', reasoning: 'Empty LLM response' };
    }

    const evaluation = JSON.parse(content);
    
    // Validate and normalize
    let confidence = Math.max(0, Math.min(1, parseFloat(evaluation.confidence) || 0));
    const reasoning = evaluation.reasoning || '';
    
    // SANITY CHECK: Detect contradictory responses where reasoning says "doesn't match"
    // but confidence is high. This is a common LLM failure mode.
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
      reasoningLower.includes('falls under the domain of') ||
      reasoningLower.includes('this is a calendar') ||
      reasoningLower.includes('this is a weather') ||
      reasoningLower.includes('this is a time') ||
      reasoningLower.includes('this is a music');
    
    // If reasoning indicates no match but confidence is high, fix it
    if (indicatesNoMatch && confidence > 0.3) {
      console.log(`[UnifiedBidder] Correcting contradictory response for ${agent.name}: "${reasoning.substring(0, 50)}..." had confidence ${confidence}, setting to 0.05`);
      confidence = 0.05;
    }
    
    const normalized = {
      confidence,
      plan: evaluation.plan || '',
      reasoning
    };
    
    console.log(`[UnifiedBidder] ${agent.name} bid ${normalized.confidence.toFixed(2)} on "${(task.content || task.phrase || '').substring(0, 30)}..."`);
    
    // Cache the result
    cacheEvaluation(cacheKey, normalized);
    
    return normalized;

  } catch (error) {
    console.error(`[UnifiedBidder] Evaluation failed for ${agent.name}:`, error.message);
    
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
    console.error('[UnifiedBidder]', error);
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
 * Clear the evaluation cache (for testing or refresh)
 */
function clearCache() {
  evaluationCache.clear();
  console.log('[UnifiedBidder] Cache cleared');
}

module.exports = {
  evaluateAgentBid,
  getBidsFromAgents,
  selectWinner,
  checkBidderReady,
  clearCache
};
