/**
 * Exchange Bridge - Connects Voice Task SDK to the Auction Exchange
 * 
 * This module bridges the existing voice SDK IPC interface to the new
 * auction-based task exchange system.
 * 
 * Phase 1: Integrated with Concierge Router for:
 * - Critical command handling (cancel, repeat, undo)
 * - Conversation state management
 * - Pronoun resolution for followups
 * - Late-cancel suppression
 */

const path = require('path');
const { ipcMain, BrowserWindow } = require('electron');
const WebSocket = require('ws');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Phase 1: Import Router and state management
const { Router, createRouter } = require('./routing/Router');
const conversationState = require('./state/conversationState');
const responseMemory = require('./memory/responseMemory');
const { getLogger } = require('./logging/Logger');

// Phase 2: Notification manager for proactive notifications
const notificationManager = require('./notifications/notificationManager');

// Agent Message Queue for proactive agent messages
const { getAgentMessageQueue } = require('../../lib/agent-message-queue');

// Spaces API for writing conversation history to file
const { getSpacesAPI } = require('../../spaces-api');

// User Profile for cross-agent persistent memory
const { getUserProfile } = require('../../lib/user-profile-store');

// Centralized HUD API for space-scoped task routing
const hudApi = require('../../lib/hud-api');

// Centralized AI service
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// ==================== BUILT-IN AGENT REGISTRY ====================
// Centralized agent loading - see packages/agents/agent-registry.js
// TO ADD A NEW AGENT: Just add the agent ID to BUILT_IN_AGENT_IDS in agent-registry.js
const { 
  getAllAgents: getRegistryAgents, 
  getAgentMap: getRegistryAgentMap,
  buildCategoryConfig 
} = require('../../packages/agents/agent-registry');

// NOTE: Task Queue Manager removed - now using distributed Exchange-based routing
// Tasks are submitted to Exchange, agents bid independently, Exchange picks winner

// Unified LLM Bidder - ALL agents use this, no keyword fallback
const { evaluateAgentBid, checkBidderReady } = require('../../packages/agents/unified-bidder');

// Router instance (initialized after exchange is ready)
let routerInstance = null;

// ==================== AGENT VOICE PERSONALITIES ====================
// Each agent gets a unique voice that matches their personality
// OpenAI Realtime API voices: alloy, ash, ballad, coral, echo, sage, shimmer, verse
// See packages/agents/VOICE-GUIDE.md for voice descriptions and selection guide

// Default voice assignments (used if agent doesn't specify voice property)
const DEFAULT_AGENT_VOICES = {
  'dj-agent': 'ash',           // Warm, friendly - like a radio DJ
  'smalltalk-agent': 'coral',  // Clear, welcoming
  'time-agent': 'sage',        // Calm, informative
  'weather-agent': 'verse',    // Natural, conversational
  'calendar-agent': 'coral',   // Professional, clear
  'help-agent': 'alloy',       // Neutral, helpful
  'search-agent': 'echo',      // Authoritative, knowledgeable
  'spelling-agent': 'sage',    // Calm, precise
  'media-agent': 'ash',        // Warm, entertainment-focused
  'fallback-agent': 'alloy',   // Neutral default
};

// Voice descriptions for reference (searchable)
const VOICE_DESCRIPTIONS = {
  alloy: { personality: 'Neutral, balanced, versatile', bestFor: 'General purpose, help systems', keywords: ['neutral', 'balanced', 'default', 'professional'] },
  ash: { personality: 'Warm, friendly, personable', bestFor: 'Music, entertainment, social', keywords: ['warm', 'friendly', 'DJ', 'music', 'entertainment'] },
  ballad: { personality: 'Expressive, storytelling, dramatic', bestFor: 'Creative, narrative content', keywords: ['expressive', 'storytelling', 'dramatic', 'creative'] },
  coral: { personality: 'Clear, professional, articulate', bestFor: 'Business, scheduling', keywords: ['clear', 'professional', 'business', 'scheduling'] },
  echo: { personality: 'Deep, authoritative, knowledgeable', bestFor: 'Search, education, experts', keywords: ['authoritative', 'knowledgeable', 'expert', 'search'] },
  sage: { personality: 'Calm, wise, measured', bestFor: 'Time, spelling, precision', keywords: ['calm', 'wise', 'precise', 'time', 'spelling'] },
  shimmer: { personality: 'Energetic, bright, enthusiastic', bestFor: 'Motivation, fitness', keywords: ['energetic', 'bright', 'enthusiastic', 'upbeat'] },
  verse: { personality: 'Natural, conversational, relatable', bestFor: 'Weather, casual chat', keywords: ['natural', 'conversational', 'casual', 'weather'] },
};

/**
 * Get voice for an agent
 * Priority: 1. Agent's voice property, 2. Default mapping, 3. 'alloy'
 * @param {string} agentId - Agent ID
 * @param {Object} agent - Optional agent object with voice property
 * @returns {string} Voice name
 */
function getAgentVoice(agentId, agent = null) {
  // Check if agent has voice property defined
  if (agent?.voice && VOICE_DESCRIPTIONS[agent.voice]) {
    return agent.voice;
  }
  
  // Try to get agent from registry to check its voice property
  try {
    const { getAgent } = require('../../packages/agents/agent-registry');
    const registryAgent = getAgent(agentId);
    if (registryAgent?.voice && VOICE_DESCRIPTIONS[registryAgent.voice]) {
      return registryAgent.voice;
    }
  } catch (e) {
    // Registry not available, use defaults
  }
  
  // Fall back to default mapping or alloy
  return DEFAULT_AGENT_VOICES[agentId] || 'alloy';
}

/**
 * Find best voice for a description/keywords
 * @param {string} query - Description or keywords to match
 * @returns {{ voice: string, score: number, description: Object }[]} Ranked matches
 */
function searchVoices(query) {
  const queryLower = query.toLowerCase();
  const results = [];
  
  for (const [voice, desc] of Object.entries(VOICE_DESCRIPTIONS)) {
    let score = 0;
    
    // Check personality match
    if (desc.personality.toLowerCase().includes(queryLower)) score += 3;
    
    // Check bestFor match
    if (desc.bestFor.toLowerCase().includes(queryLower)) score += 2;
    
    // Check keywords match
    for (const keyword of desc.keywords) {
      if (keyword.includes(queryLower) || queryLower.includes(keyword)) {
        score += 1;
      }
    }
    
    if (score > 0) {
      results.push({ voice, score, description: desc });
    }
  }
  
  return results.sort((a, b) => b.score - a.score);
}

// ==================== VOICE SYSTEM CONFIGURATION ====================
// All configurable timeouts and settings in one place
const VOICE_CONFIG = {
  // LLM Bidding
  // GPT-4o-mini P50 ~1s, P95 ~3s, but with 15+ concurrent calls
  // server-side queuing can push some past 3s.  Give enough headroom
  // so normal variance doesn't trip the circuit breaker.
  bidTimeoutMs: 6000,          // Max time for single LLM bid evaluation
  bidCircuitThreshold: 15,     // Open circuit after N failures (>= agent count)
  bidCircuitResetMs: 15000,    // Reset circuit after 15s (not 60s)
  
  // Auction timing (must exceed bidTimeoutMs × 2 to accommodate one retry)
  auctionDefaultWindowMs: 8000, // Default auction window (allows LLM bids + retry)
  auctionMinWindowMs: 5000,     // Minimum auction window
  auctionMaxWindowMs: 12000,    // Maximum auction window (complex queries)
  instantWinThreshold: 0.85,    // Confidence threshold for instant win (lowered for faster auctions)
  
  // TTS Cooldown (prevents echo/feedback)
  ttsCooldownMs: 4000,          // Ignore transcripts after TTS ends
  
  // Speech detection  
  silenceAfterSpeechMs: 5000,   // Wait for silence after user speaks
  noSpeechTimeoutMs: 60000,     // Disconnect if no speech detected
  
  // Deduplication
  dedupWindowMs: 2000,          // Ignore duplicate transcripts
  functionCallDedupMs: 5000,    // Skip regular transcript if function call handled it
};

// ==================== CIRCUIT BREAKER FOR LLM BIDDING ====================
// Protects against LLM API failures - falls back to keyword matching
const BID_CIRCUIT = {
  failures: 0,
  lastFailure: 0,
  threshold: VOICE_CONFIG.bidCircuitThreshold,
  resetMs: VOICE_CONFIG.bidCircuitResetMs,
  isOpen() {
    if (this.failures >= this.threshold) {
      if (Date.now() - this.lastFailure > this.resetMs) {
        log.info('voice', '[BidCircuit] Resetting circuit after cool-down');
        this.failures = 0;
        return false;
      }
      return true;
    }
    return false;
  },
  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    log.warn('voice', '[BidCircuit] LLM failure /', { v0: this.failures, v1: this.threshold });
  },
  recordSuccess() {
    if (this.failures > 0) {
      this.failures = Math.max(0, this.failures - 1);
    }
  }
};

const BID_TIMEOUT_MS = VOICE_CONFIG.bidTimeoutMs;

// ==================== ROUTING INTELLIGENCE ====================
// LLM-driven routing cache that learns from successful auctions.
//
// Flow:
//   1. User query arrives
//   2. Check: do we have a cached route for a similar query?
//   3. If yes: ask one fast LLM call "Given the FULL conversation history,
//      does it still make sense to route to this agent?"
//   4. If LLM says yes → skip 15-agent auction, execute directly (93% cost savings)
//   5. If LLM says no → invalidate cache, run full auction
//   6. After any successful auction → cache the winning route
//
// The cache considers full context (conversation, user profile), and the
// LLM validation ensures the cache adapts to changes in agent behavior or
// conversation flow.  Cache entries also expire after 5 minutes.
// ==================================================================

const routingCache = new Map();   // querySignature → { agentId, agentName, confidence, cachedAt }
const ROUTING_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes hard TTL

// Win tracking: rolling stats per agent for tiered bidding insights
const agentWinStats = new Map();  // agentId → { wins, total, recentQueries[] }
const WIN_STATS_WINDOW_MS = 30 * 60 * 1000; // 30-minute rolling window

/**
 * Normalize a query to a routing signature.
 * Strips specific times/dates/names (they change, intent pattern doesn't).
 */
function routingSignature(text) {
  return text.toLowerCase()
    .replace(/[.,!?;:'"]/g, '')
    .replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/gi, '_TIME_')
    .replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, '_DAY_')
    .replace(/\b(tomorrow|today|yesterday|next week|this week|this morning|this afternoon|this evening)\b/gi, '_TIMEREF_')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Validate a cached route with a single LLM call.
 * Considers FULL conversation history (not just the current command).
 *
 * Returns the cached agent info if valid, null if cache should be busted.
 */
async function validateRoutingCache(text, conversationText, userProfileContext) {
  const sig = routingSignature(text);
  const cached = routingCache.get(sig);

  if (!cached) return null;
  if (Date.now() - cached.cachedAt > ROUTING_CACHE_TTL_MS) {
    routingCache.delete(sig);
    return null;
  }

  // LLM validation: 1 fast call instead of 15 per-agent calls
  try {
    const ai = require('../../lib/ai-service');
    const result = await ai.json(
`You are a task router. Previously, when a user made a similar request, it was routed to "${cached.agentName}" (${cached.agentId}) with ${(cached.confidence * 100).toFixed(0)}% confidence.

FULL CONVERSATION HISTORY (important -- consider continuity, topic shifts, follow-ups):
${conversationText || '(no prior conversation)'}

${userProfileContext ? `USER PROFILE:\n${userProfileContext}\n` : ''}
CURRENT USER REQUEST: "${text}"

PREVIOUS SUCCESSFUL ROUTE: "${cached.agentName}" handled a similar query ("${cached.originalQuery}") successfully.

Should this new request go to the same agent? Consider:
1. Is the user's INTENT the same type of request?
2. Does the conversation history suggest a TOPIC SHIFT that would change the routing?
3. Is this a follow-up to something a DIFFERENT agent handled? (If so, route differently.)
4. Has anything in the conversation changed that would make a different agent more appropriate?

Respond with JSON only: { "routeSame": true/false, "reason": "brief explanation" }`,
      { profile: 'fast', temperature: 0, maxTokens: 80, feature: 'routing-cache' }
    );

    if (result && result.routeSame === true) {
      log.info('voice', `[RoutingCache] HIT: "${text.slice(0, 40)}" → ${cached.agentId} (validated by LLM: ${result.reason || 'match'})`);
      return cached;
    } else {
      log.info('voice', `[RoutingCache] BUST: "${text.slice(0, 40)}" → LLM says no (${result?.reason || 'mismatch'})`);
      routingCache.delete(sig);
      return null;
    }
  } catch (e) {
    // LLM validation failed -- fall back to full auction (safe)
    log.warn('voice', '[RoutingCache] Validation LLM failed, falling back to auction', { error: e.message });
    return null;
  }
}

/**
 * Record a successful route for future cache hits.
 */
function recordSuccessfulRoute(text, agentId, agentName, confidence) {
  const sig = routingSignature(text);
  routingCache.set(sig, {
    agentId,
    agentName,
    confidence,
    originalQuery: text.slice(0, 80),
    cachedAt: Date.now(),
  });

  // Update win stats
  const stats = agentWinStats.get(agentId) || { wins: 0, total: 0, recentQueries: [] };
  stats.wins++;
  stats.total++;
  stats.recentQueries.push({ text: text.slice(0, 60), time: Date.now() });
  // Trim to window
  stats.recentQueries = stats.recentQueries.filter(q => Date.now() - q.time < WIN_STATS_WINDOW_MS);
  agentWinStats.set(agentId, stats);

  log.info('voice', `[RoutingCache] Cached: "${text.slice(0, 40)}" → ${agentId} (conf=${confidence.toFixed(2)})`);
}

/**
 * Get the most likely agent based on recent win history (for conversation continuity).
 * If the last exchange was with agent X and the new query is plausibly a follow-up,
 * agent X gets priority.
 */
function getConversationContinuityAgent() {
  // Find the most recent winning agent from history
  let lastAgent = null;
  let lastTime = 0;
  for (const [agentId, stats] of agentWinStats) {
    const latest = stats.recentQueries[stats.recentQueries.length - 1];
    if (latest && latest.time > lastTime) {
      lastTime = latest.time;
      lastAgent = agentId;
    }
  }
  // Only return if the last interaction was within 2 minutes (conversation window)
  if (lastAgent && Date.now() - lastTime < 120000) {
    return lastAgent;
  }
  return null;
}

// Clean up expired cache entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of routingCache) {
    if (now - entry.cachedAt > ROUTING_CACHE_TTL_MS) routingCache.delete(key);
  }
  // Clean up old win stats
  for (const [agentId, stats] of agentWinStats) {
    stats.recentQueries = stats.recentQueries.filter(q => now - q.time < WIN_STATS_WINDOW_MS);
    if (stats.recentQueries.length === 0) agentWinStats.delete(agentId);
  }
}, 120000);

// ==================== PRE-SCREEN (1 LLM call to narrow 10+ agents to ~3) =====
// When there are many agents, running per-agent LLM evaluations is expensive.
// Instead, a single "triage" LLM call selects the top 3-4 candidates.
// Only those candidates get full bid evaluation.  If pre-screen fails,
// we fall back to full auction (safe degradation).
// ==================================================================
const PRE_SCREEN_AGENT_THRESHOLD = 6; // Only pre-screen if > 6 agents registered
const PRE_SCREEN_MAX_CANDIDATES = 4;  // Narrow to this many

/**
 * One fast LLM call to narrow the agent field.
 * Returns an array of agent IDs most likely to handle the query,
 * or null to fall back to full auction.
 */
async function preScreenAgents(text, conversationText, allAgents) {
  if (!allAgents || allAgents.length <= PRE_SCREEN_AGENT_THRESHOLD) {
    return null; // Not worth pre-screening with few agents
  }
  
  try {
    const agentSummaries = allAgents
      .filter(a => !a.bidExcluded)
      .map(a => `- ${a.id}: ${a.description || a.name}`)
      .join('\n');
    
    const result = await ai.json(
      `You are a task router. Given a user query and a list of AI agents, select the ${PRE_SCREEN_MAX_CANDIDATES} most likely agents to handle this query.

USER QUERY: "${text}"
${conversationText ? `RECENT CONVERSATION:\n${conversationText.slice(-500)}\n` : ''}
AVAILABLE AGENTS:
${agentSummaries}

Return a JSON object: { "agents": ["agent-id-1", "agent-id-2", ...] }
Include ${PRE_SCREEN_MAX_CANDIDATES} agent IDs, ordered by likelihood. Only include agents that have a reasonable chance of handling this query.`,
      { profile: 'fast', temperature: 0, maxTokens: 150, feature: 'agent-prescreen' }
    );
    
    if (result && Array.isArray(result.agents) && result.agents.length > 0) {
      // Validate that returned IDs are real
      const validIds = new Set(allAgents.map(a => a.id));
      const filtered = result.agents.filter(id => validIds.has(id)).slice(0, PRE_SCREEN_MAX_CANDIDATES);
      if (filtered.length > 0) {
        log.info('voice', `[PreScreen] Narrowed ${allAgents.length} agents to ${filtered.length}: ${filtered.join(', ')}`, {
          query: text.slice(0, 50),
        });
        return filtered;
      }
    }
  } catch (e) {
    log.info('voice', '[PreScreen] Failed, falling back to full auction', { error: e.message });
  }
  return null; // Fall back to full auction
}

// ==================== INTENT NORMALIZER ====================
// Interprets raw voice transcription into clean intent, correcting speech
// errors and resolving ambiguity. Uses conversation history for context.
// For simple, clear commands it fast-skips to save an LLM call.
// ==============================================================

const NORMALIZE_SKIP_PATTERNS = [
  /^(hi|hey|hello|bye|goodbye|thanks|thank you|yes|no|okay|ok|stop|cancel|repeat|undo)[\s!.,?]*$/i,
  /^what('?s| is) the (time|date|weather)/i,
  /^play\s/i,
  /^(good )(morning|afternoon|evening|night)/i,
  /^give me (my |the )?(daily|morning) (brief|briefing|rundown)/i,
  // Memory management -- unambiguous profile commands, always pass through
  /^my name is\s/i,
  /^call me\s/i,
  /^(what do you (know|remember)|tell me what you know) about me/i,
  /^(show|display) (my |me )?(profile|preferences|memory|facts)/i,
  /^(forget|remove|delete|clear) (my|all)\s/i,
  /^(change|update|set|correct) my\s/i,
  /^remember (that |my )/i,
  /^who am i/i,
];

/**
 * Normalize a voice transcript into a clean intent using LLM + conversation context.
 * Returns { intent, rawTranscript, needsClarification, clarificationQuestion, confidence }.
 *
 * Fast-skips for simple/clear commands to avoid unnecessary LLM calls.
 */
async function normalizeIntent(rawTranscript, conversationText, userProfileContext) {
  const trimmed = (rawTranscript || '').trim();
  if (!trimmed) return { intent: trimmed, rawTranscript: trimmed, needsClarification: false, confidence: 0 };

  // Fast skip: if the transcript is short and matches a clear pattern, pass through
  if (trimmed.split(/\s+/).length <= 8) {
    for (const pat of NORMALIZE_SKIP_PATTERNS) {
      if (pat.test(trimmed)) {
        return { intent: trimmed, rawTranscript: trimmed, needsClarification: false, confidence: 1.0 };
      }
    }
  }

  try {
    const result = await ai.json(
      `You are a voice-command interpreter. The user spoke into a microphone and the speech recognizer produced the transcript below. Your job:
1. Fix obvious speech-to-text errors (homophones, missing words, run-on phrases).
2. Resolve pronouns ("it", "that", "this") using the conversation history.
3. Determine if the request is clear enough to act on. If the intent is ambiguous or seems out-of-context, set needsClarification=true and provide a short, natural clarifying question.
4. Output a clean, actionable version of what the user meant.

${conversationText ? `RECENT CONVERSATION:\n${conversationText.slice(-800)}\n` : ''}
${userProfileContext ? `USER PROFILE:\n${userProfileContext}\n` : ''}
RAW TRANSCRIPT: "${trimmed}"

Return JSON:
{
  "intent": "clean version of what the user wants (corrected, resolved pronouns)",
  "needsClarification": false,
  "clarificationQuestion": null,
  "confidence": 0.0-1.0
}

If the transcript is perfectly clear, just return it cleaned up with confidence 0.9+.
If it's slightly ambiguous but you can infer the intent, return your best interpretation with confidence 0.6-0.8.
If it's truly unclear, set needsClarification=true and ask ONE concise question.`,
      { profile: 'fast', temperature: 0, maxTokens: 200, feature: 'intent-normalize' }
    );

    if (result && typeof result.intent === 'string') {
      return {
        intent: result.intent || trimmed,
        rawTranscript: trimmed,
        needsClarification: !!result.needsClarification,
        clarificationQuestion: result.clarificationQuestion || null,
        confidence: parseFloat(result.confidence) || 0.5,
      };
    }
  } catch (e) {
    log.info('voice', '[NormalizeIntent] LLM failed, using raw transcript', { error: e.message });
  }

  // Fail-open: use raw transcript as-is
  return { intent: trimmed, rawTranscript: trimmed, needsClarification: false, confidence: 0.5 };
}

// ==================== RESPONSE SANITY GUARD ====================
// Cheap JavaScript checks on agent responses BEFORE TTS.
// Catches date/time hallucinations, impossible numbers, etc.
// Returns a string describing the issue, or null if response looks sane.
// ==============================================================

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function checkResponseSanity(message) {
  if (!message || typeof message !== 'string') return null;
  const lower = message.toLowerCase();
  const now = new Date();
  const todayDayName = DAY_NAMES[now.getDay()];

  // Check 1: Day-of-week mentions that don't match "today"
  // Only trigger if the message says "today is [day]" or "it's [day]" or "this [day]"
  // and the day name is wrong.
  const todayDayPattern = /(?:today is|it(?:'|')s|this)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i;
  const todayDayMatch = lower.match(todayDayPattern);
  if (todayDayMatch) {
    const claimedDay = todayDayMatch[1].toLowerCase();
    if (claimedDay !== todayDayName) {
      return `Wrong day: response says "${todayDayMatch[1]}" but today is ${todayDayName.charAt(0).toUpperCase() + todayDayName.slice(1)}`;
    }
  }

  // Check 2: Date mentions like "February 8" when today is February 9
  // Only catches "today is [month] [day]" or "today, [month] [day]" patterns
  const todayDatePattern = /today(?:\s+is|,)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})/i;
  const todayDateMatch = lower.match(todayDatePattern);
  if (todayDateMatch) {
    const claimedMonth = MONTH_NAMES.indexOf(todayDateMatch[1].toLowerCase());
    const claimedDay = parseInt(todayDateMatch[2], 10);
    if (claimedMonth !== now.getMonth() || claimedDay !== now.getDate()) {
      return `Wrong date: response says "${todayDateMatch[1]} ${todayDateMatch[2]}" but today is ${MONTH_NAMES[now.getMonth()]} ${now.getDate()}`;
    }
  }

  // Check 3: Temperature sanity (Fahrenheit) -- catches "it's 300 degrees" etc.
  const tempMatch = lower.match(/(-?\d{1,3})\s*(?:degrees|°)\s*(?:fahrenheit|f\b)/i);
  if (tempMatch) {
    const temp = parseInt(tempMatch[1], 10);
    if (temp < -80 || temp > 140) {
      return `Impossible temperature: ${temp}°F is outside Earth range`;
    }
  }

  // Check 4: Temperature sanity (Celsius)
  const tempCMatch = lower.match(/(-?\d{1,3})\s*(?:degrees|°)\s*(?:celsius|c\b)/i);
  if (tempCMatch) {
    const temp = parseInt(tempCMatch[1], 10);
    if (temp < -60 || temp > 60) {
      return `Impossible temperature: ${temp}°C is outside Earth range`;
    }
  }

  return null; // Response looks sane
}

// ==================== NO KEYWORD FALLBACK ====================
// POLICY: All agent routing MUST be LLM-based. No keyword/regex matching.
// If the LLM bidder is unavailable, agents get zero confidence (no bid).
// This is intentional -- deterministic keyword matching is fragile and
// misroutes queries. See .cursorrules "Classification Approach" section.
// ==============================================================

/**
 * Evaluate bid with timeout and circuit breaker protection.
 * If LLM is unavailable, returns zero confidence (no keyword fallback).
 */
async function evaluateBidWithFallback(agent, task) {
  // Check circuit breaker
  if (BID_CIRCUIT.isOpen()) {
    log.info('voice', '[BidEval] Circuit open, cannot bid (no keyword fallback)', { v0: agent.name });
    return { confidence: 0, plan: null, reasoning: 'Bidding system temporarily unavailable' };
  }
  
  try {
    // Race LLM evaluation against timeout
    const result = await Promise.race([
      evaluateAgentBid(agent, task),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Bid evaluation timeout')), BID_TIMEOUT_MS)
      )
    ]);
    
    BID_CIRCUIT.recordSuccess();
    return result;
  } catch (error) {
    BID_CIRCUIT.recordFailure();
    log.warn('voice', '[BidEval] LLM failed for : (no keyword fallback)', { v0: agent.name, v1: error.message });
    return { confidence: 0, plan: null, reasoning: `LLM evaluation failed: ${error.message}` };
  }
}
// ==================== END CIRCUIT BREAKER ====================

// ==================== BUILT-IN AGENTS (from registry) ====================
// Agents are auto-loaded from packages/agents/agent-registry.js
// To add a new agent, just add its ID to BUILT_IN_AGENT_IDS in agent-registry.js
const allBuiltInAgents = getRegistryAgents();
const allBuiltInAgentMap = getRegistryAgentMap();

/**
 * Get enabled builtin agents based on user settings
 * @returns {Array} Array of enabled agents
 */
function getEnabledBuiltInAgents() {
  let states = {};
  if (global.settingsManager) {
    states = global.settingsManager.get('builtinAgentStates') || {};
  }
  
  // Filter agents based on enabled state (default to enabled)
  return allBuiltInAgents.filter(agent => {
    const isEnabled = states[agent.id] !== false;
    return isEnabled;
  });
}

/**
 * Get enabled builtin agent map
 * @returns {Object} Map of agentId -> agent for enabled agents only
 */
function getEnabledBuiltInAgentMap() {
  let states = {};
  if (global.settingsManager) {
    states = global.settingsManager.get('builtinAgentStates') || {};
  }
  
  const enabledMap = {};
  for (const [id, agent] of Object.entries(allBuiltInAgentMap)) {
    if (states[id] !== false) {
      enabledMap[id] = agent;
    }
  }
  return enabledMap;
}

// Exchange and agent imports (compiled from TypeScript)
let Exchange = null;
let WebSocketTransport = null;
let MemoryStorage = null;
let exchangeInstance = null;
let transportInstance = null;
let isExchangeRunning = false;
let isShuttingDown = false; // Prevent reconnection during shutdown
let currentExchangePort = 3456; // Track port for reconnection
let localAgentConnections = new Map(); // agentId -> { ws, agent, heartbeatInterval, reconnectAttempts }
const intentionalCloses = new Set(); // Track agent IDs being intentionally disconnected (don't reconnect)
let pendingInputContexts = new Map(); // agentId -> { context, field, options } for multi-turn conversations
let taskExecutionStartTimes = new Map(); // taskId -> startTime (for tracking execution duration)
let pendingAckTimers = new Map(); // taskId -> setTimeout handle (deferred ack, kept OUT of task.metadata to avoid JSON.stringify crash)

// ==================== SUBTASK SYSTEM ====================
// Track subtasks spawned by agents during execution
// Enables agents to break complex work into discrete HUD tasks
let subtaskRegistry = new Map(); // subtaskId -> { parentTaskId, routingMode, lockedAgentId, context }
let parentTaskSubtasks = new Map(); // parentTaskId -> [subtaskIds]

// ==================== TASK DEDUPLICATION ====================
// Moved to module scope so fullSubmitPipeline can access it
const recentSubmissions = new Map(); // normalizedTranscript -> timestamp
const SUBMIT_DEDUP_WINDOW_MS = 3000; // Ignore duplicate within 3 seconds (covers function-call + transcript gap)

// ==================== PROCESSING LOCK ====================
// Prevents overlapping task submissions when the Realtime API fires
// multiple events for the same utterance (partial, function call, transcript).
// Only one task can be in-flight at a time. Auto-releases after timeout.
let activeTaskLock = null; // { taskId, transcript, startedAt }
const TASK_LOCK_TIMEOUT_MS = 15000; // Safety valve: auto-release after 15s

// ==================== CONVERSATION HISTORY ====================
// Track conversation turns so agents have full context
// Format: [{ role: 'user'|'assistant', content: string, timestamp: number, agentId?: string }]
let conversationHistory = [];
const CONVERSATION_CONFIG = {
  maxHistoryChars: 4000,        // Max characters to include in agent context
  maxTurns: 20,                 // Max turns to keep in memory
  historyTimeoutMs: 5 * 60000,  // Clear history after 5 minutes of inactivity
  persistenceMaxAgeMs: 60 * 60000, // Discard saved state after 1 hour
};
let historyTimeoutId = null;

/**
 * Add a turn to conversation history
 * @param {string} role - 'user' or 'assistant'
 * @param {string} content - The message content
 * @param {string} [agentId] - Agent ID for assistant messages
 */
function addToHistory(role, content, agentId = null) {
  if (!content || content.trim() === '') return;
  
  conversationHistory.push({
    role,
    content: content.trim(),
    timestamp: Date.now(),
    agentId
  });
  
  // Trim if too many turns
  while (conversationHistory.length > CONVERSATION_CONFIG.maxTurns) {
    conversationHistory.shift();
  }
  
  // Reset timeout
  resetHistoryTimeout();
  
  // Write to file so all agents can read it during bidding
  writeHistoryToFile();
  
  log.info('voice', '[ConversationHistory] Added turn, total:', { v0: role, v1: conversationHistory.length });
}

/**
 * Get recent conversation history trimmed to max length
 * @returns {Array} Recent conversation turns
 */
function getRecentHistory() {
  let totalChars = 0;
  const recent = [];
  
  // Work backwards from most recent
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const turn = conversationHistory[i];
    const turnLength = turn.content.length + 20; // Account for role prefix
    
    if (totalChars + turnLength > CONVERSATION_CONFIG.maxHistoryChars) {
      break;
    }
    
    recent.unshift(turn);
    totalChars += turnLength;
  }
  
  return recent;
}

/**
 * Format history for agent context
 * @returns {string} Formatted conversation history
 */
function formatHistoryForAgent() {
  const recent = getRecentHistory();
  if (recent.length === 0) return '';
  
  return recent.map(turn => {
    const prefix = turn.role === 'user' ? 'User' : 'Assistant';
    return `${prefix}: ${turn.content}`;
  }).join('\n');
}

/**
 * Write conversation history to file in GSX Agent space
 * This allows all agents to read the same conversation context during bidding
 */
async function writeHistoryToFile() {
  try {
    const api = getSpacesAPI();
    const formattedHistory = formatHistoryForAgent();
    
    if (formattedHistory) {
      const content = `# Conversation History

${formattedHistory}

_Last updated: ${new Date().toISOString()}_`;
      
      await api.files.write('gsx-agent', 'conversation-history.md', content);
      log.info('voice', '[ConversationHistory] Written to gsx-agent/conversation-history.md');
    }
  } catch (err) {
    log.warn('voice', '[ConversationHistory] Failed to write history file', { data: err.message });
  }
}

/**
 * Clear the conversation history file
 */
async function clearHistoryFile() {
  try {
    const api = getSpacesAPI();
    await api.files.delete('gsx-agent', 'conversation-history.md');
    log.info('voice', '[ConversationHistory] Deleted conversation-history.md');
  } catch (err) {
    // File may not exist, that's okay
    log.info('voice', '[ConversationHistory] No history file to delete');
  }
}

/**
 * Clear conversation history
 */
function clearHistory() {
  conversationHistory = [];
  clearHistoryFile(); // Also clear the file
  log.info('voice', '[ConversationHistory] Cleared');
}

/**
 * Reset the history timeout
 */
function resetHistoryTimeout() {
  if (historyTimeoutId) {
    clearTimeout(historyTimeoutId);
  }
  historyTimeoutId = setTimeout(async () => {
    if (pendingInputContexts.size === 0) {
      // Summarize the session before clearing (non-blocking)
      await summarizeAndArchiveSession().catch(e =>
        log.warn('voice', '[SessionSummary] Error during archive', { data: e.message })
      );
      clearHistory();
    }
  }, CONVERSATION_CONFIG.historyTimeoutMs);
}

// ==================== CONVERSATION STATE PERSISTENCE ====================
// Save/restore conversation history across app restarts

/**
 * Save conversation state to Spaces for persistence across restarts
 * Called from main.js on before-quit
 */
async function saveConversationState() {
  if (conversationHistory.length === 0) {
    log.info('voice', '[ConversationState] Nothing to save');
    return;
  }
  try {
    const api = getSpacesAPI();
    const state = {
      savedAt: Date.now(),
      history: conversationHistory,
    };
    await api.files.write('gsx-agent', 'conversation-state.json', JSON.stringify(state));
    log.info('voice', '[ConversationState] Saved turns', { v0: conversationHistory.length });
  } catch (err) {
    log.warn('voice', '[ConversationState] Failed to save', { data: err.message });
  }
}

/**
 * Restore conversation state from Spaces on startup
 * Discards if older than persistenceMaxAgeMs
 */
async function restoreConversationState() {
  try {
    const api = getSpacesAPI();
    const raw = await api.files.read('gsx-agent', 'conversation-state.json');
    if (!raw) return;

    const state = JSON.parse(raw);
    const age = Date.now() - (state.savedAt || 0);

    if (age > CONVERSATION_CONFIG.persistenceMaxAgeMs) {
      log.info('voice', '[ConversationState] Saved state too old (min) - discarding', { v0: Math.round(age / 60000) });
      // Clean up stale file
      try { await api.files.delete('gsx-agent', 'conversation-state.json'); } catch (_) {}
      return;
    }

    if (Array.isArray(state.history) && state.history.length > 0) {
      conversationHistory = state.history;
      // Rebuild the history file so agents can read it
      await writeHistoryToFile();
      resetHistoryTimeout();
      log.info('voice', '[ConversationState] Restored turns (s old)', { v0: conversationHistory.length, v1: Math.round(age / 1000) });
    }

    // Delete the saved file - it's been consumed
    try { await api.files.delete('gsx-agent', 'conversation-state.json'); } catch (_) {}
  } catch (err) {
    log.warn('voice', '[ConversationState] Failed to restore', { data: err.message });
  }
}

// ==================== SESSION SUMMARIES ====================
// Summarize conversations before clearing for multi-session continuity

/**
 * Summarize the current conversation and archive it before clearing
 * Called when the 5-minute inactivity timeout fires
 */
async function summarizeAndArchiveSession() {
  if (conversationHistory.length < 2) return; // Nothing meaningful to summarize

  const formatted = formatHistoryForAgent();
  if (!formatted) return;

  try {
    // Use LLM to generate a one-line summary
    const apiKey = global.settingsManager?.get('openaiApiKey') ||
                   global.settingsManager?.get('llmApiKey') ||
                   process.env.OPENAI_API_KEY;

    let summary = '';

    if (apiKey) {
      try {
        const result = await ai.chat({
          profile: 'fast',
          system: 'Summarize this conversation in one short sentence (max 15 words). Focus on what the user asked about. No quotes.',
          messages: [{ role: 'user', content: formatted }],
          temperature: 0.3,
          maxTokens: 50,
          feature: 'exchange-bridge'
        });
        summary = result.content.trim();
      } catch (err) {
        log.warn('voice', '[SessionSummary] AI call failed', { data: err.message });
      }
    }

    // Fallback: create a simple summary from the first user message
    if (!summary) {
      const firstUserTurn = conversationHistory.find(t => t.role === 'user');
      summary = firstUserTurn
        ? `Asked: "${firstUserTurn.content.slice(0, 60)}"`
        : 'Brief conversation';
    }

    // Append to session-summaries.md
    const api = getSpacesAPI();
    const timestamp = new Date().toISOString().split('T')[0] + ' ' +
                      new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const entry = `- ${timestamp}: ${summary}`;

    let existing = '';
    try {
      existing = api.files.read('gsx-agent', 'session-summaries.md') || '';
    } catch (_) {}

    // Parse existing entries, prepend new one, keep last 10
    const lines = existing.split('\n').filter(l => l.startsWith('- '));
    lines.unshift(entry);
    const kept = lines.slice(0, 10);

    const content = `# Session Summaries\n\n${kept.join('\n')}\n\n_Auto-generated for multi-session continuity_\n`;
    await api.files.write('gsx-agent', 'session-summaries.md', content);
    log.info('voice', '[SessionSummary] Archived: ""', { v0: summary });
  } catch (err) {
    log.warn('voice', '[SessionSummary] Failed to summarize', { data: err.message });
  }
}

// ==================== ACTIVE LEARNING PIPELINE ====================
// Extract user facts from successful interactions and save to global profile
// Rate-limited to avoid excessive API calls

let _lastFactExtractionTime = 0;
const FACT_EXTRACTION_COOLDOWN_MS = 30000; // 30 seconds between extractions

/**
 * Extract user facts from a completed interaction and save to user profile
 * @param {Object} task - The completed task
 * @param {Object} result - The task result
 * @param {string} agentId - The agent that handled the task
 */
async function extractAndSaveUserFacts(task, result, agentId) {
  // Rate-limit
  const now = Date.now();
  if (now - _lastFactExtractionTime < FACT_EXTRACTION_COOLDOWN_MS) return;

  // Skip trivial interactions
  const content = task?.content || '';
  if (content.length < 5 || !result?.success) return;

  // Skip if no API key
  const apiKey = global.settingsManager?.get('openaiApiKey') ||
                 global.settingsManager?.get('llmApiKey') ||
                 process.env.OPENAI_API_KEY;
  if (!apiKey) return;

  _lastFactExtractionTime = now;

  try {
    const profile = getUserProfile();
    if (!profile.isLoaded()) await profile.load();
    const existingFacts = profile.getFacts();

    const existingFactsStr = Object.entries(existingFacts)
      .filter(([_, v]) => v && !v.includes('not yet learned') && !v.startsWith('*'))
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');

    const message = result.output || result.message || '';

    try {
      const result = await ai.json(
        `Extract NEW user facts from this interaction. Only include facts clearly stated or strongly implied.
Already known facts: ${existingFactsStr || 'none'}
Do NOT repeat known facts. Return JSON object with key-value pairs, or {} if nothing new.
Keys should be descriptive: "Name", "Home", "Work", "Timezone", "Temperature Units", etc.

User said: "${content}"
Agent (${agentId}) responded: "${message.slice(0, 200)}"`,
        {
          profile: 'fast',
          system: 'You extract user facts from conversations. Return JSON only.',
          temperature: 0.1,
          maxTokens: 150,
          feature: 'exchange-bridge'
        }
      );

      const facts = result || {};
      const newKeys = Object.keys(facts).filter(k => facts[k] && facts[k].trim());

      if (newKeys.length > 0) {
        profile.updateFacts(facts);
        await profile.save();
        log.info('voice', '[LearningPipeline] Extracted facts:', { v0: newKeys.length, v1: newKeys.join(', ') });
      }
    } catch (err) {
      // Silently fail - fact extraction is non-critical
    }
  } catch (err) {
    // Learning is non-critical, log and move on
    log.warn('voice', '[LearningPipeline] Fact extraction error', { data: err.message });
  }
}

// ==================== SUBTASK API ====================
// Allows agents to spawn discrete subtasks during execution
// Each subtask appears independently on the HUD

/**
 * Submit a subtask from within an agent's execute() method
 * 
 * @param {Object} options
 * @param {string} options.parentTaskId - ID of the parent task
 * @param {string} options.content - Subtask content/prompt to show on HUD
 * @param {string} options.routingMode - 'locked' (same agent) | 'open' (auction)
 * @param {string} options.lockedAgentId - Required if routingMode is 'locked'
 * @param {Object} options.context - Context to pass to subtask handler
 * @param {number} options.priority - 1=high, 2=normal, 3=low (default: 2)
 * @returns {Promise<{ subtaskId: string, queued: boolean }>}
 */
async function submitSubtask({ parentTaskId, content, routingMode = 'open', lockedAgentId, context = {}, priority = 2 }) {
  if (!exchangeInstance) {
    log.error('voice', '[SubtaskAPI] Exchange not initialized');
    return { subtaskId: null, queued: false, error: 'Exchange not initialized' };
  }
  
  if (!parentTaskId || !content) {
    log.error('voice', '[SubtaskAPI] Missing required params: parentTaskId, content');
    return { subtaskId: null, queued: false, error: 'Missing required params' };
  }
  
  if (routingMode === 'locked' && !lockedAgentId) {
    log.error('voice', '[SubtaskAPI] Locked routing requires lockedAgentId');
    return { subtaskId: null, queued: false, error: 'Locked routing requires lockedAgentId' };
  }
  
  try {
    log.info('voice', '[SubtaskAPI] Submitting subtask for parent : "..."', { v0: parentTaskId, v1: content.slice(0, 50) });
    
    // Submit to exchange with subtask metadata
    const { taskId: subtaskId, task } = await exchangeInstance.submit({
      content,
      priority,
      metadata: {
        source: 'subtask',
        parentTaskId,
        routingMode,
        lockedAgentId: routingMode === 'locked' ? lockedAgentId : null,
        subtaskContext: context,
        timestamp: Date.now(),
      },
    });
    
    // Track in registry
    subtaskRegistry.set(subtaskId, {
      parentTaskId,
      routingMode,
      lockedAgentId,
      context,
      createdAt: Date.now(),
    });
    
    // Track parent -> subtask relationship
    if (!parentTaskSubtasks.has(parentTaskId)) {
      parentTaskSubtasks.set(parentTaskId, []);
    }
    parentTaskSubtasks.get(parentTaskId).push(subtaskId);
    
    log.info('voice', '[SubtaskAPI] Subtask queued (parent: , routing: )', { v0: subtaskId, v1: parentTaskId, v2: routingMode });
    
    // Emit event for HUD to display subtask grouping
    broadcastToWindows('subtask:created', {
      subtaskId,
      parentTaskId,
      content,
      routingMode,
      lockedAgentId,
      subtaskIndex: parentTaskSubtasks.get(parentTaskId).length,
    });
    
    return { subtaskId, queued: true, task };
    
  } catch (error) {
    log.error('voice', '[SubtaskAPI] Failed to submit subtask', { error: error.message });
    return { subtaskId: null, queued: false, error: error.message };
  }
}

/**
 * Check if a task is a subtask (has parent)
 * @param {Object} task - Task object with metadata
 * @returns {boolean}
 */
function isSubtask(task) {
  return task?.metadata?.source === 'subtask' && task?.metadata?.parentTaskId;
}

/**
 * Check if a subtask should be locked to a specific agent (skip auction)
 * @param {Object} task - Task object with metadata
 * @returns {{ locked: boolean, agentId: string | null }}
 */
function getSubtaskRouting(task) {
  if (!isSubtask(task)) {
    return { locked: false, agentId: null };
  }
  
  const { routingMode, lockedAgentId } = task.metadata;
  if (routingMode === 'locked' && lockedAgentId) {
    return { locked: true, agentId: lockedAgentId };
  }
  
  return { locked: false, agentId: null };
}

/**
 * Get subtask context passed from parent agent
 * @param {Object} task - Task object with metadata
 * @returns {Object} Subtask context or empty object
 */
function getSubtaskContext(task) {
  if (!isSubtask(task)) return {};
  return task.metadata?.subtaskContext || {};
}

/**
 * Get all subtasks for a parent task
 * @param {string} parentTaskId - Parent task ID
 * @returns {string[]} Array of subtask IDs
 */
function getSubtasksForParent(parentTaskId) {
  return parentTaskSubtasks.get(parentTaskId) || [];
}

/**
 * Clean up subtask tracking when parent completes
 * @param {string} parentTaskId - Parent task ID
 */
function cleanupSubtasks(parentTaskId) {
  const subtaskIds = parentTaskSubtasks.get(parentTaskId) || [];
  for (const id of subtaskIds) {
    subtaskRegistry.delete(id);
  }
  parentTaskSubtasks.delete(parentTaskId);
  log.info('voice', '[SubtaskAPI] Cleaned up subtasks for parent', { v0: subtaskIds.length, v1: parentTaskId });
}

/**
 * Create a bound submitSubtask function for an agent execution context
 * @param {string} taskId - Current task ID
 * @param {string} agentId - Executing agent ID
 * @returns {Function} Bound submitSubtask function
 */
function createSubtaskSubmitter(taskId, agentId) {
  const submit = (options) => submitSubtask({
    ...options,
    parentTaskId: taskId,
    // Default to open auction so subtasks get fair bidding from all agents.
    // Use routingMode: 'locked' explicitly if agent wants to handle its own subtask.
    routingMode: options.routingMode || 'open',
    lockedAgentId: options.routingMode === 'locked' ? (options.lockedAgentId || agentId) : undefined,
  });

  /**
   * Submit a subtask and wait for its result.
   * Returns a Promise that resolves with the subtask result once it settles,
   * or rejects on timeout/dead-letter.
   * 
   * @param {Object} options - Same as submitSubtask options
   * @param {number} [options.timeoutMs=60000] - Max time to wait for result
   * @returns {Promise<{success: boolean, data?: any, error?: string}>}
   */
  submit.andWait = (options) => {
    const timeoutMs = options.timeoutMs || 60000;

    return new Promise(async (resolve, reject) => {
      const { subtaskId, queued, error } = await submit(options);
      
      if (!queued || !subtaskId) {
        return reject(new Error(error || 'Failed to submit subtask'));
      }

      let settled = false;
      
      const onSettled = ({ task, result }) => {
        if (task.id !== subtaskId) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const onDeadLetter = ({ task }) => {
        if (task.id !== subtaskId) return;
        settled = true;
        cleanup();
        reject(new Error(`Subtask ${subtaskId} dead-lettered`));
      };

      const onBusted = ({ task, error: bustError, backupsRemaining }) => {
        // Only reject if no backups left (final failure before dead-letter)
        if (task.id !== subtaskId || backupsRemaining > 0) return;
        // Will get dead_letter event next, so don't reject here
      };

      const timeout = setTimeout(() => {
        if (!settled) {
          cleanup();
          reject(new Error(`Subtask ${subtaskId} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      function cleanup() {
        clearTimeout(timeout);
        if (exchangeInstance) {
          exchangeInstance.off('task:settled', onSettled);
          exchangeInstance.off('task:dead_letter', onDeadLetter);
          exchangeInstance.off('task:busted', onBusted);
        }
      }

      if (exchangeInstance) {
        exchangeInstance.on('task:settled', onSettled);
        exchangeInstance.on('task:dead_letter', onDeadLetter);
        exchangeInstance.on('task:busted', onBusted);
      } else {
        reject(new Error('Exchange not initialized'));
      }
    });
  };

  return submit;
}

// ==================== INPUT SCHEMA PROCESSOR ====================
// Allows agents to declare required inputs declaratively
// System automatically handles multi-turn conversation to gather inputs

/**
 * Check if an agent has an inputs schema
 * @param {Object} agent - The agent definition
 * @returns {boolean}
 */
function hasInputSchema(agent) {
  return agent.inputs && typeof agent.inputs === 'object' && Object.keys(agent.inputs).length > 0;
}

/**
 * Get the next missing required input from agent's schema
 * @param {Object} agent - The agent definition
 * @param {Object} gatheredInputs - Already gathered inputs
 * @param {Object} context - Task context for skip conditions
 * @param {Object} task - The original task (for askWhen conditions)
 * @returns {Object|null} - { field, schema } or null if all inputs gathered
 */
function getNextMissingInput(agent, gatheredInputs = {}, context = {}, task = null) {
  if (!hasInputSchema(agent)) return null;
  
  for (const [field, schema] of Object.entries(agent.inputs)) {
    // Skip if already gathered
    if (gatheredInputs[field] !== undefined) continue;
    
    // Check askWhen condition (dynamic requirement based on task)
    if (schema.askWhen && typeof schema.askWhen === 'function') {
      try {
        if (!schema.askWhen(task || context)) {
          log.info('voice', '[InputSchema] Skipping - askWhen returned false', { v0: field });
          continue;
        }
      } catch (e) {
        log.warn('voice', 'InputSchema askWhen function error', { field, error: e.message });
        continue;
      }
    } else if (!schema.required && !schema.askAlways) {
      // Skip if optional and no askWhen/askAlways
      continue;
    }
    
    // Check skip condition
    if (schema.skip && typeof schema.skip === 'function') {
      try {
        if (schema.skip({ inputs: gatheredInputs, ...context })) continue;
      } catch (e) {
        log.warn('voice', 'InputSchema skip function error', { field, error: e.message });
      }
    }
    
    return { field, schema };
  }
  
  return null;
}

/**
 * Build needsInput response for a missing input
 * @param {string} agentId - Agent ID
 * @param {string} field - Field name
 * @param {Object} schema - Input schema
 * @param {Object} gatheredInputs - Already gathered inputs
 * @param {Object} originalContext - Original task context
 * @returns {Object} - Result with needsInput
 */
function buildInputRequest(agentId, field, schema, gatheredInputs, originalContext = {}) {
  return {
    success: true,
    needsInput: {
      prompt: schema.prompt || `What ${field}?`,
      field,
      options: schema.options || [],
      agentId,
      context: {
        ...originalContext,
        _inputSchemaState: {
          gatheredInputs,
          currentField: field
        }
      }
    }
  };
}

/**
 * Process user response and update gathered inputs
 * @param {string} userInput - User's response
 * @param {string} field - Field being filled
 * @param {Object} schema - Input schema for the field
 * @param {Object} gatheredInputs - Already gathered inputs
 * @returns {Object} - Updated gathered inputs
 */
function processInputResponse(userInput, field, schema, gatheredInputs) {
  const updated = { ...gatheredInputs };
  
  // If options provided, try to match
  if (schema.options && schema.options.length > 0) {
    const lowerInput = userInput.toLowerCase().trim();
    
    // Try exact match first
    const exactMatch = schema.options.find(opt => 
      opt.toLowerCase() === lowerInput
    );
    
    if (exactMatch) {
      updated[field] = exactMatch;
    } else {
      // Try partial match
      const partialMatch = schema.options.find(opt =>
        opt.toLowerCase().includes(lowerInput) || 
        lowerInput.includes(opt.toLowerCase())
      );
      updated[field] = partialMatch || userInput;
    }
  } else {
    // No options, use raw input
    updated[field] = userInput;
  }
  
  log.info('voice', '[InputSchema] Gathered : ""', { v0: field, v1: updated[field] });
  return updated;
}

/**
 * Execute agent with input schema support
 * Automatically gathers required inputs before calling execute()
 * @param {Object} agent - The agent (with optional inputs schema)
 * @param {Object} task - The task to execute
 * @param {Object} executionContext - Additional execution context (e.g., submitSubtask)
 * @returns {Promise<Object>} - Execution result
 */
async function executeWithInputSchema(agent, task, executionContext = {}) {
  // Check if agent has input schema
  if (!hasInputSchema(agent)) {
    // No schema, execute directly with execution context
    return await agent.execute(task, executionContext);
  }
  
  // Get gathered inputs from context (if continuing multi-turn)
  let gatheredInputs = task.context?._inputSchemaState?.gatheredInputs || {};
  const currentField = task.context?._inputSchemaState?.currentField;
  
  // If we're continuing a multi-turn, process the user's response
  if (currentField && task.context?.userInput) {
    const fieldSchema = agent.inputs[currentField];
    if (fieldSchema) {
      gatheredInputs = processInputResponse(
        task.context.userInput,
        currentField,
        fieldSchema,
        gatheredInputs
      );
    }
  }
  
  // Check for next missing input (pass task for askWhen conditions)
  const missing = getNextMissingInput(agent, gatheredInputs, task.context, task);
  
  if (missing) {
    // Still need more inputs
    log.info('voice', '[InputSchema] Agent needs input:', { v0: agent.id, v1: missing.field });
    return buildInputRequest(
      agent.id,
      missing.field,
      missing.schema,
      gatheredInputs,
      task.context
    );
  }
  
  // All inputs gathered - execute with inputs attached to task
  log.info('voice', 'InputSchema all inputs gathered', { agentId: agent.id, fields: Object.keys(gatheredInputs) });
  const enrichedTask = {
    ...task,
    inputs: gatheredInputs,
    context: {
      ...task.context,
      inputs: gatheredInputs
    }
  };
  
  return await agent.execute(enrichedTask, executionContext);
}

// ==================== END INPUT SCHEMA PROCESSOR ====================

// Reconnection configuration
const RECONNECT_CONFIG = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

/**
 * Default exchange configuration
 */
// ==================== AUTO-GENERATED CATEGORIES ====================
// Categories are built from agent declarations - no manual maintenance needed!
// Each agent declares its categories and keywords, and they're merged here.
const agentCategories = buildCategoryConfig();
log.info('voice', 'Auto-generated categories from agent declarations', { v0: agentCategories.length });

const DEFAULT_EXCHANGE_CONFIG = {
  port: 3456, // Different from default 3000 to avoid conflicts
  transport: 'websocket',
  storage: 'memory',
  
  // Categories auto-generated from agent declarations (see packages/agents/agent-registry.js)
  // Each agent's keywords are added to its declared categories
  categories: agentCategories,
  
  auction: {
    defaultWindowMs: VOICE_CONFIG.auctionDefaultWindowMs,
    minWindowMs: VOICE_CONFIG.auctionMinWindowMs,
    maxWindowMs: VOICE_CONFIG.auctionMaxWindowMs,
    instantWinThreshold: VOICE_CONFIG.instantWinThreshold,
    dominanceMargin: 0.3,
    maxAuctionAttempts: 2,        // Quick retry
    executionTimeoutMs: 120000,   // Generous base (agents manage their own via ack/heartbeat)
    ackTimeoutMs: 10000,          // Agent must ack in 10s or it's dead
    heartbeatExtensionMs: 30000,  // Each heartbeat grants 30s more
  },
  
  marketMaker: {
    enabled: true,
    agentId: 'fallback-agent',
    confidence: 0.1,
  },
  
  heartbeatIntervalMs: 30000,
  heartbeatTimeoutMs: 60000,
};

/**
 * Wrap a built-in agent to match the local agent interface
 * Also adds helper methods like queueMessage
 */
function wrapBuiltInAgent(builtInAgent) {
  const agentId = builtInAgent.id;
  
  // Add queueMessage helper to the original agent
  if (!builtInAgent.queueMessage) {
    builtInAgent.queueMessage = (message, priority = 'normal', options = {}) => {
      const queue = getAgentMessageQueue();
      return queue.enqueue(agentId, message, priority, options);
    };
  }
  
  return {
    id: agentId,
    name: builtInAgent.name || agentId,
    version: builtInAgent.version || '1.0.0',
    enabled: true,
    keywords: builtInAgent.keywords || [],
    capabilities: builtInAgent.capabilities || [],
    categories: builtInAgent.categories || ['general'],
    executionType: 'builtin',
    // Store reference to original agent for execution
    _builtIn: builtInAgent,
  };
}

/**
 * Connect built-in agents to the exchange
 */
// Track if agents are already being connected to prevent duplicate connections
let isConnectingAgents = false;

async function connectBuiltInAgents(port) {
  // Guard against duplicate calls
  if (isConnectingAgents) {
    log.warn('voice', 'Already connecting agents, skipping duplicate call');
    return;
  }
  isConnectingAgents = true;
  
  try {
    const enabledAgents = getEnabledBuiltInAgents();
    log.info('voice', 'Connecting built-in agents to exchange', { v0: enabledAgents.length });
    
    // Initialize memory files for all built-in agents
    try {
      const { initializeBuiltInAgentMemories } = require('../../lib/agent-memory-store');
      const memoryResults = await initializeBuiltInAgentMemories(enabledAgents);
      if (memoryResults && memoryResults.created && memoryResults.created.length > 0) {
        log.info('voice', 'Created agent memory files', { v0: memoryResults.created.length });
      }
    } catch (error) {
      log.warn('voice', 'Could not initialize agent memories', { data: error.message });
      // Non-fatal - continue without memories
    }
    
    for (const agent of enabledAgents) {
      // Skip bidExcluded system agents (e.g., error-agent) -- they don't participate in auctions
      if (agent.bidExcluded) {
        log.info('voice', 'Agent is bidExcluded, not connecting to exchange', { v0: agent.id });
        continue;
      }

      // Skip if already connected
      if (localAgentConnections.has(agent.id)) {
        log.info('voice', 'Agent already connected, skipping', { v0: agent.id });
        continue;
      }
      
      try {
        const wrappedAgent = wrapBuiltInAgent(agent);
        await connectBuiltInAgentToExchange(wrappedAgent, port);
      } catch (error) {
        log.error('voice', 'Failed to connect built-in agent', { agentId: agent.id, error: error.message });
      }
    }
  } finally {
    isConnectingAgents = false;
  }
}

/**
 * Connect a single built-in agent to the exchange
 * Built-in agents use their own bid/execute methods
 */
async function connectBuiltInAgentToExchange(wrappedAgent, port) {
  // Skip if already connected (prevents duplicate connections during race conditions)
  if (localAgentConnections.has(wrappedAgent.id)) {
    const existing = localAgentConnections.get(wrappedAgent.id);
    if (existing?.ws?.readyState === WebSocket.OPEN) {
      log.info('voice', 'Agent already has active connection, skipping', { v0: wrappedAgent.id });
      return Promise.resolve();
    }
  }
  
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const originalAgent = wrappedAgent._builtIn;
    let heartbeatInterval = null;
    
    ws.on('open', () => {
      log.info('voice', 'Built-in agent connecting:', { v0: wrappedAgent.name });
      
      // Register with exchange
      ws.send(JSON.stringify({
        type: 'register',
        agentId: wrappedAgent.id,
        agentVersion: wrappedAgent.version,
        categories: wrappedAgent.categories,
        capabilities: {
          keywords: wrappedAgent.keywords,
          executionType: 'builtin',
        },
      }));
      
      // Start heartbeat to stay healthy (send pong every 25 seconds)
      heartbeatInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      }, 25000);
      
      localAgentConnections.set(wrappedAgent.id, { ws, agent: wrappedAgent, heartbeatInterval });
      log.info('voice', 'Built-in agent registered:', { v0: wrappedAgent.name });
      resolve();
    });
    
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // ==================== BUILT-IN AGENT BIDDING ====================
        // POLICY: 100% LLM-based routing. No keyword/regex matching.
        //
        // Each agent evaluates independently via evaluateAgentBid() (1 LLM call each).
        // This scales naturally: agents can live in separate processes/machines.
        // Root-cause fixes (6 s timeout, 15-failure circuit breaker) keep this reliable
        // even with 15+ concurrent calls.
        if (msg.type === 'bid_request') {
          let evaluation = { confidence: 0, plan: null };
          
          // Try evaluation with one retry on timeout.
          // With 15+ concurrent LLM calls, some naturally take longer on the
          // first attempt due to server-side queuing.  A single retry catches
          // the vast majority of transient timeouts.
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              const llmResult = await Promise.race([
                evaluateAgentBid(originalAgent, msg.task),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Bid eval timeout')), BID_TIMEOUT_MS))
              ]);
              
              evaluation = {
                confidence: llmResult.confidence || 0,
                plan: llmResult.plan || llmResult.reasoning || 'LLM evaluated match',
                result: llmResult.result || null,
              };
              log.info('voice', `[BuiltIn:${wrappedAgent.name}] Bid (attempt ${attempt}):`, { v0: evaluation.confidence.toFixed(2), v1: (llmResult.reasoning || '').substring(0, 60) });
              break; // success
            } catch (e) {
              if (attempt === 1) {
                log.info('voice', `[BuiltIn:${wrappedAgent.name}] Bid eval attempt 1 failed, retrying:`, { v0: e.message });
                continue; // retry once
              }
              log.warn('voice', `[BuiltIn:${wrappedAgent.name}] Bid eval failed after 2 attempts:`, { v0: e.message });
              // Still send bid_response so exchange can count this agent as responded
              try {
                ws.send(JSON.stringify({
                  type: 'bid_response',
                  auctionId: msg.auctionId,
                  agentId: wrappedAgent.id,
                  agentVersion: wrappedAgent.version,
                  bid: null
                }));
              } catch (_) {}
              return; // skip duplicate send below
            }
          }
          
          // Send bid_response
          if (evaluation.confidence > 0.1) {
            const bidPayload = {
              confidence: evaluation.confidence,
              reasoning: evaluation.plan,
              estimatedTimeMs: 2000,
              tier: 'builtin',
            };
            // Hallucination-aware fast-path: three checks must ALL pass.
            // 1. The bidder returned a result
            // 2. The bidder self-assessed hallucinationRisk as non-high
            // 3. The agent type is informational (action agents always need real data)
            if (evaluation.result) {
              const risk = evaluation.hallucinationRisk || 'high';
              if (risk === 'high') {
                log.info('voice', `[BuiltIn:${wrappedAgent.name}] Fast-path suppressed: hallucinationRisk=high`);
              } else if (originalAgent.executionType !== 'informational') {
                log.info('voice', `[BuiltIn:${wrappedAgent.name}] Fast-path suppressed: executionType=${originalAgent.executionType} requires full execution`);
              } else {
                bidPayload.result = evaluation.result;
                log.info('voice', `[BuiltIn:${wrappedAgent.name}] Fast-path result included (risk=${risk})`);
              }
            }
            ws.send(JSON.stringify({
              type: 'bid_response',
              auctionId: msg.auctionId,
              agentId: wrappedAgent.id,
              agentVersion: wrappedAgent.version,
              bid: bidPayload,
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'bid_response',
              auctionId: msg.auctionId,
              agentId: wrappedAgent.id,
              agentVersion: wrappedAgent.version,
              bid: null,
            }));
          }
        }
        // ==================== BUILT-IN AGENT EXECUTION ====================
        // Protocol: ack immediately → heartbeat if slow → result when done
        else if (msg.type === 'task_assignment') {
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'exchange-bridge.js:task_assignment',message:'task_assignment received',data:{agentId:wrappedAgent.id,agentName:wrappedAgent.name,taskId:msg.taskId,taskContent:msg.task?.content?.slice(0,80)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          log.info('voice', `[BuiltIn:${wrappedAgent.name}] Executing task: ...`, { v0: msg.task?.content?.slice(0, 50) });
          
          // ── ACK immediately: "I got it, I'm working on it" ──
          const estimatedMs = originalAgent.estimatedExecutionMs || 15000;
          try {
            ws.send(JSON.stringify({
              type: 'task_ack',
              taskId: msg.taskId,
              agentId: wrappedAgent.id,
              estimatedMs,
            }));
          } catch (_) { /* ack is best-effort */ }
          
          // ── HEARTBEAT: keep-alive every 10s during long execution ──
          const execStart = Date.now();
          const heartbeatTimer = setInterval(() => {
            const elapsed = Math.round((Date.now() - execStart) / 1000);
            try {
              ws.send(JSON.stringify({
                type: 'task_heartbeat',
                taskId: msg.taskId,
                agentId: wrappedAgent.id,
                progress: `Still working (${elapsed}s)...`,
              }));
            } catch (_) {
              clearInterval(heartbeatTimer);
            }
          }, 10000);
          
          try {
            let result;
            if (originalAgent.execute && typeof originalAgent.execute === 'function') {
              // Create execution context with subtask support
              const executionContext = {
                submitSubtask: createSubtaskSubmitter(msg.taskId, wrappedAgent.id),
                taskId: msg.taskId,
                agentId: wrappedAgent.id,
                // Include subtask context if this is a subtask
                ...(isSubtask(msg.task) ? { subtaskContext: getSubtaskContext(msg.task) } : {}),
                // Provide heartbeat function so agents can send context-aware progress
                heartbeat: (progress) => {
                  try {
                    ws.send(JSON.stringify({
                      type: 'task_heartbeat',
                      taskId: msg.taskId,
                      agentId: wrappedAgent.id,
                      progress,
                    }));
                  } catch (_) {}
                },
              };
              
              // Merge subtask context into task context for easy access
              if (isSubtask(msg.task)) {
                msg.task.context = {
                  ...msg.task.context,
                  ...getSubtaskContext(msg.task),
                };
              }
              
              // Use input schema processor for declarative input gathering
              result = await executeWithInputSchema(originalAgent, msg.task, executionContext);
            } else {
              result = { success: false, error: 'Agent has no execute method' };
            }
            
            clearInterval(heartbeatTimer);
            
            ws.send(JSON.stringify({
              type: 'task_result',
              taskId: msg.taskId,
              result: {
                success: result.success,
                output: result.message || result.result,
                data: result.data,
                html: result.html,
                error: result.success ? undefined : result.error,
                needsInput: result.needsInput, // Pass through for multi-turn conversations
              }
            }));
          } catch (execError) {
            clearInterval(heartbeatTimer);
            
            // Surface rate-limit errors explicitly rather than hiding them
            const isRateLimit = execError.statusCode === 429 ||
              execError.message?.toLowerCase().includes('rate limit') ||
              execError.message?.toLowerCase().includes('too many requests');
            
            ws.send(JSON.stringify({
              type: 'task_result',
              taskId: msg.taskId,
              result: {
                success: false,
                error: isRateLimit
                  ? `Rate limit reached: ${execError.message}. Please wait a moment and try again.`
                  : execError.message,
              }
            }));
            
            if (isRateLimit) {
              log.error('voice', 'RATE LIMIT hit during agent execution', {
                agent: wrappedAgent.name,
                error: execError.message,
              });
            }
          }
        }
        else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      } catch (error) {
        log.error('voice', 'Built-in agent message error', { agent: wrappedAgent.name, error: error.message });
      }
    });
    
    ws.on('error', (error) => {
      log.error('voice', 'Built-in agent WebSocket error', { agent: wrappedAgent.name, error: error.message });
      // Clean up heartbeat on error
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      reject(error);
    });
    
    ws.on('close', (code) => {
      log.info('voice', 'Built-in agent disconnected: (code: )', { v0: wrappedAgent.name, v1: code });
      // Clean up heartbeat interval
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      const conn = localAgentConnections.get(wrappedAgent.id);
      localAgentConnections.delete(wrappedAgent.id);
      
      // Skip reconnection if this was an intentional close (e.g. disconnectAgent())
      if (intentionalCloses.has(wrappedAgent.id)) {
        intentionalCloses.delete(wrappedAgent.id);
        log.info('voice', 'Skipping reconnect (intentional close)', { v0: wrappedAgent.name });
        return;
      }
      
      // Always reconnect unless shutting down.
      // Code 1000 from server-side (exchange restart) should also trigger reconnect.
      if (!isShuttingDown) {
        const attempts = (conn?.reconnectAttempts || 0) + 1;
        if (attempts <= RECONNECT_CONFIG.maxAttempts) {
          const delay = Math.min(
            RECONNECT_CONFIG.baseDelayMs * Math.pow(2, attempts - 1),
            RECONNECT_CONFIG.maxDelayMs
          );
          log.info('voice', 'Reconnecting in ms (attempt /)', { v0: wrappedAgent.name, v1: delay, v2: attempts, v3: RECONNECT_CONFIG.maxAttempts });
          setTimeout(async () => {
            try {
              await connectBuiltInAgentToExchange(wrappedAgent, currentExchangePort);
              // Store reconnect attempts for tracking
              const newConn = localAgentConnections.get(wrappedAgent.id);
              if (newConn) {
                newConn.reconnectAttempts = 0; // Reset on success
              }
            } catch (e) {
              log.error('voice', 'Agent reconnect failed', { agent: wrappedAgent.name, error: e.message });
              // Will try again on next disconnect
            }
          }, delay);
        } else {
          log.error('voice', 'Max reconnect attempts reached for', { wrappedAgent_name: wrappedAgent.name });
        }
      }
    });
    
    setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
        }
        reject(new Error('Connection timeout'));
      }
    }, 5000);
  });
}

/**
 * Connect custom agents from agent-store to the exchange
 */
async function connectCustomAgents(port) {
  try {
    // Load agents from agent-store
    const { getAgentStore } = require('./agent-store');
    const agentStore = getAgentStore();
    
    if (!agentStore || !agentStore.initialized) {
      log.info('voice', 'Agent store not ready, skipping custom agents');
      return;
    }
    
    const agents = await agentStore.getAllAgents();
    log.info('voice', 'Found custom agents to connect', { v0: agents.length });
    
    // Initialize memory files for all enabled custom agents
    const enabledAgents = agents.filter(a => a.enabled);
    if (enabledAgents.length > 0) {
      try {
        const { ensureAgentMemories } = require('../../lib/agent-memory-store');
        const memoryResults = await ensureAgentMemories(enabledAgents);
        if (memoryResults && memoryResults.created && memoryResults.created.length > 0) {
          log.info('voice', 'Created custom agent memory files', { v0: memoryResults.created.length });
        }
      } catch (error) {
        log.warn('voice', 'Could not initialize custom agent memories', { data: error.message });
      }
    }
    
    for (const agent of agents) {
      if (!agent.enabled) continue;
      
      try {
        await connectLocalAgent(agent, port);
      } catch (error) {
        log.error('voice', 'Failed to connect agent', { agent: agent.name, error: error.message });
      }
    }
  } catch (error) {
    log.error('voice', 'Failed to load custom agents', { error: error.message });
  }
}

/**
 * Connect a single local agent to the exchange
 */
async function connectLocalAgent(agent, port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    let heartbeatInterval = null;
    
    ws.on('open', () => {
      log.info('voice', 'Local agent connecting:', { v0: agent.name });
      
      // Register with exchange
      ws.send(JSON.stringify({
        type: 'register',
        agentId: agent.id,
        agentVersion: agent.version || '1.0.0',
        categories: agent.categories || ['general'],
        capabilities: {
          keywords: agent.keywords || [],
          executionType: agent.executionType || 'llm',
        },
      }));
      
      // Start heartbeat to stay healthy (send pong every 25 seconds)
      heartbeatInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      }, 25000);
      
      localAgentConnections.set(agent.id, { ws, agent, heartbeatInterval });
      log.info('voice', 'Local agent registered:', { v0: agent.name });
      resolve();
    });
    
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // ==================== DISTRIBUTED BIDDING ====================
        // Exchange sends 'bid_request' - each agent evaluates independently
        if (msg.type === 'bid_request') {
          const startTime = Date.now();
          log.info('voice', '[Agent:${agent.name}] Received bid_request for: "..."', { v0: msg.task?.content?.slice(0, 50) });
          
          // Use circuit-breaker protected LLM evaluation with keyword fallback
          const evaluation = await evaluateBidWithFallback(agent, msg.task);
          const evalTime = Date.now() - startTime;
          
          log.info('voice', '[Agent:${agent.name}] Bid evaluation: confidence=, time=ms, fallback=', { v0: evaluation.confidence.toFixed(2), v1: evalTime, v2: evaluation.fallback || false });
          
          // Only bid if confident enough (threshold 0.1)
          if (evaluation.confidence > 0.1) {
            const bidResponse = {
              type: 'bid_response',
              auctionId: msg.auctionId,
              agentId: agent.id,
              agentVersion: agent.version || '1.0.0',
              bid: {
                confidence: evaluation.confidence,
                reasoning: evaluation.plan || 'Agent can handle this task',
                estimatedTimeMs: 5000,
                tier: evaluation.fallback ? 'keyword' : 'llm',
              }
            };
            ws.send(JSON.stringify(bidResponse));
            log.info('voice', '[Agent:${agent.name}] Submitted bid:', { v0: evaluation.confidence.toFixed(2) });
          } else {
            // Send empty bid response (declined)
            ws.send(JSON.stringify({
              type: 'bid_response',
              auctionId: msg.auctionId,
              agentId: agent.id,
              agentVersion: agent.version || '1.0.0',
              bid: null  // No bid - not confident
            }));
            log.info('voice', '[Agent:${agent.name}] Declined to bid (confidence too low)');
          }
        }
        // ==================== TASK ASSIGNMENT ====================
        // Exchange picks winner and sends 'task_assignment'
        else if (msg.type === 'task_assignment') {
          log.info('voice', '[Agent:${agent.name}] Won auction! Executing: "..."', { v0: msg.task?.content?.slice(0, 50) });
          
          const startTime = Date.now();
          try {
            // Create execution context with subtask support
            const executionContext = {
              submitSubtask: createSubtaskSubmitter(msg.taskId, agent.id),
              taskId: msg.taskId,
              agentId: agent.id,
              // Include subtask context if this is a subtask
              ...(isSubtask(msg.task) ? { subtaskContext: getSubtaskContext(msg.task) } : {}),
            };
            
            // Merge subtask context into task context for easy access
            if (isSubtask(msg.task)) {
              msg.task.context = {
                ...msg.task.context,
                ...getSubtaskContext(msg.task),
              };
            }
            
            const result = await executeLocalAgent(agent, msg.task, executionContext);
            const execTime = Date.now() - startTime;
            
            log.info('voice', '[Agent:${agent.name}] Execution complete: success=, time=ms', { v0: result.success, v1: execTime });
            
            ws.send(JSON.stringify({
              type: 'task_result',
              taskId: msg.taskId,
              result: {
                success: result.success,
                output: result.result || result.error,
                html: result.html,
                error: result.success ? undefined : result.error,
                needsInput: result.needsInput,
              }
            }));
          } catch (execError) {
            log.error('voice', 'Agent execution failed', { agent: agent.name, error: execError.message });
            ws.send(JSON.stringify({
              type: 'task_result',
              taskId: msg.taskId,
              result: {
                success: false,
                error: execError.message,
              }
            }));
          }
        }
        // ==================== PING/PONG ====================
        else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      } catch (error) {
        log.error('voice', 'Agent message handling error', { agent: agent.name, error: error.message });
        // Don't crash - log and continue
      }
    });
    
    ws.on('error', (error) => {
      log.error('voice', 'Local agent WebSocket error', { agent: agent.name, error: error.message });
      // Clean up heartbeat on error
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      reject(error);
    });
    
    ws.on('close', (code) => {
      log.info('voice', 'Local agent disconnected: (code: )', { v0: agent.name, v1: code });
      // Clean up heartbeat interval
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      const conn = localAgentConnections.get(agent.id);
      localAgentConnections.delete(agent.id);
      
      // Skip reconnection if this was an intentional close (e.g. disconnectAgent())
      if (intentionalCloses.has(agent.id)) {
        intentionalCloses.delete(agent.id);
        log.info('voice', 'Skipping reconnect (intentional close)', { v0: agent.name });
        return;
      }
      
      // Always reconnect unless shutting down or agent disabled.
      // Code 1000 from server-side (exchange restart) should also trigger reconnect.
      if (!isShuttingDown && agent.enabled !== false) {
        const attempts = (conn?.reconnectAttempts || 0) + 1;
        if (attempts <= RECONNECT_CONFIG.maxAttempts) {
          const delay = Math.min(
            RECONNECT_CONFIG.baseDelayMs * Math.pow(2, attempts - 1),
            RECONNECT_CONFIG.maxDelayMs
          );
          log.info('voice', 'Reconnecting in ms (attempt /)', { v0: agent.name, v1: delay, v2: attempts, v3: RECONNECT_CONFIG.maxAttempts });
          setTimeout(async () => {
            try {
              await connectLocalAgent(agent, currentExchangePort);
              // Reset reconnect attempts on success
              const newConn = localAgentConnections.get(agent.id);
              if (newConn) {
                newConn.reconnectAttempts = 0;
              }
            } catch (e) {
              log.error('voice', 'Agent reconnect failed', { agent: agent.name, error: e.message });
            }
          }, delay);
        } else {
          log.error('voice', 'Max reconnect attempts reached for', { agent_name: agent.name });
        }
      }
    });
    
    // Timeout for connection
    setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
        }
        reject(new Error('Connection timeout'));
      }
    }, 5000);
  });
}

// NOTE: calculateConfidence() removed - all agents now use LLM-based evaluation
// via unified-bidder.js. No keyword fallbacks allowed.

/**
 * Execute a local agent's task
 */
async function executeLocalAgent(agent, task, executionContext = {}) {
  const executionType = agent.executionType || 'llm';
  const content = task.content || '';
  
  // Note: Custom agents (applescript/shell/llm) don't yet support subtasks
  // The executionContext is passed but not used for these execution types
  // Built-in agents with execute() methods receive executionContext directly
  
  try {
    if (executionType === 'applescript') {
      // Use Claude to generate AppleScript based on agent prompt and task
      const claudeCode = require('../../lib/claude-code-runner');
      const prompt = `${agent.prompt}\n\nUser command: "${content}"\n\nGenerate and return ONLY the AppleScript code to execute. No explanation.`;
      
      const response = await claudeCode.complete(prompt);
      
      // Extract AppleScript from response
      let script = response;
      const codeMatch = response.match(/```(?:applescript)?\n?([\s\S]*?)```/);
      if (codeMatch) {
        script = codeMatch[1].trim();
      }
      
      // Execute the AppleScript
      const escapedScript = script.replace(/'/g, "'\"'\"'");
      const { stdout } = await execAsync(`osascript -e '${escapedScript}'`, { timeout: 10000 });
      
      return {
        success: true,
        result: stdout || 'Command executed',
      };
    } else if (executionType === 'shell') {
      // Generate and execute shell command
      const claudeCode = require('../../lib/claude-code-runner');
      const prompt = `${agent.prompt}\n\nUser command: "${content}"\n\nGenerate and return ONLY the shell command to execute. No explanation.`;
      
      const response = await claudeCode.complete(prompt);
      let command = response;
      const codeMatch = response.match(/```(?:bash|sh)?\n?([\s\S]*?)```/);
      if (codeMatch) {
        command = codeMatch[1].trim();
      }
      
      const { stdout } = await execAsync(command, { timeout: 10000 });
      return {
        success: true,
        result: stdout || 'Command executed',
      };
    } else {
      // LLM/conversational - just use Claude to respond
      const claudeCode = require('../../lib/claude-code-runner');
      const prompt = `${agent.prompt}\n\nUser: ${content}`;
      const response = await claudeCode.complete(prompt);
      
      // Detect declarative UI JSON in response (for uiCapable agents)
      let html;
      if (agent.uiCapable && response) {
        try {
          const jsonMatch = response.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || [null, response];
          const parsed = JSON.parse(jsonMatch[1]);
          if (parsed && parsed.type) {
            const { renderAgentUI } = require('../../lib/agent-ui-renderer');
            html = renderAgentUI(parsed);
          }
        } catch (_) { /* Not JSON UI, fall through to plain text */ }
      }
      
      return {
        success: true,
        result: response,
        html,
      };
    }
  } catch (error) {
    log.error('voice', 'Agent execution error', { error: error.message });
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Check if a transcription looks garbled/misheard
 * Returns true if the transcription seems suspicious
 */
function isLikelyGarbledTranscription(content) {
  if (!content || typeof content !== 'string') return true;
  
  const text = content.trim().toLowerCase();
  
  // Too short (single word that's not a command)
  if (text.length < 3) return true;
  
  // Single word that's not a known command
  const knownSingleWords = ['play', 'pause', 'stop', 'skip', 'next', 'mute', 'unmute', 'help', 'cancel', 'yes', 'no'];
  if (!text.includes(' ') && !knownSingleWords.includes(text)) {
    // Single unknown word - might be garbled
    return true;
  }
  
  // Contains unusual character patterns (allow international characters)
  // Support common accented letters: àáâãäåæçèéêëìíîïñòóôõöøùúûüýÿ
  if (/[^a-z0-9\s\-'.,!?àáâãäåæçèéêëìíîïñòóôõöøùúûüýÿ]/.test(text)) return true;
  
  // Very high ratio of consonants (common in misheard speech)
  const consonants = text.replace(/[aeiou\s]/gi, '').length;
  const vowels = text.replace(/[^aeiou]/gi, '').length;
  if (vowels > 0 && consonants / vowels > 4) return true;
  
  // Looks like a made-up word (no common English patterns)
  const uncommonPatterns = /[^aeiou]{5,}|^[^aeiou]+$/i;
  const words = text.split(/\s+/);
  const garbledWords = words.filter(w => w.length > 3 && uncommonPatterns.test(w));
  if (garbledWords.length > words.length / 2) return true;
  
  return false;
}

/**
 * Get suggestions for what the user might have meant
 */
/**
 * Generate clarification options using LLM.
 * Called when no agent bids or all bids are too low.
 * Returns an array of { label, description } options for the user.
 */
async function generateClarificationOptions(content, agentDescriptions) {
  if (!content) return [];

  try {
    const prompt = `The user said: "${content}"

No agent was confident enough to handle this request. The available agents are:
${agentDescriptions.map(a => `- ${a.name}: ${a.description}`).join('\n')}

Generate 2-4 clarification options to help the user. Each option should be a rephrased version of what the user might have meant, matched to an available agent's capability.

Respond with JSON only:
{
  "question": "Brief question asking what they meant",
  "options": [
    { "label": "Short label", "description": "Brief clarification" }
  ]
}`;

    const parsed = await ai.json(prompt, {
      profile: 'fast',
      temperature: 0.3,
      maxTokens: 300,
      feature: 'exchange-bridge'
    });
    
    return {
      question: parsed.question || 'What did you mean?',
      options: (parsed.options || []).slice(0, 4),
    };
  } catch (err) {
    log.warn('voice', 'LLM disambiguation failed', { data: err.message });
    return {
      question: "I'm not sure what you meant. Could you rephrase that?",
      options: [],
    };
  }
}

/**
 * Decompose a request into subtasks if it appears to be a composite request.
 * 
 * Cost guard: Only invokes the LLM if the request is long enough (8+ words)
 * to plausibly contain multiple independent tasks. Short requests skip the LLM.
 * 
 * @param {string} content - The user's request
 * @returns {Promise<{isComposite: boolean, subtasks: string[]}>}
 */
async function decomposeIfNeeded(content) {
  if (!content || typeof content !== 'string') {
    return { isComposite: false, subtasks: [] };
  }

  // Cost guard: skip LLM for short requests (fewer than 8 words)
  const wordCount = content.trim().split(/\s+/).length;
  if (wordCount < 8) {
    return { isComposite: false, subtasks: [] };
  }

  try {
    const prompt = `Analyze whether this user request contains MULTIPLE INDEPENDENT tasks that should be handled separately by different agents.

User request: "${content}"

Rules:
- Only decompose if there are genuinely SEPARATE tasks (e.g. "play music and check my calendar")
- Do NOT decompose a single complex task (e.g. "schedule a meeting with John tomorrow at 3pm" is ONE task)
- Do NOT decompose if the parts depend on each other (e.g. "check if I'm free and then schedule" is sequential, not parallel)
- Most requests are NOT composite -- err on the side of returning isComposite: false

Respond with JSON only:
{
  "isComposite": true/false,
  "subtasks": ["subtask 1 text", "subtask 2 text"],
  "reasoning": "Brief explanation"
}`;

    const parsed = await ai.json(prompt, {
      profile: 'fast',
      temperature: 0.1,
      maxTokens: 200,
      feature: 'exchange-bridge'
    });
    
    if (parsed.isComposite && Array.isArray(parsed.subtasks) && parsed.subtasks.length > 1) {
      log.info('voice', 'Task decomposed into subtasks:', { v0: parsed.subtasks.length, v1: parsed.reasoning });
      return { isComposite: true, subtasks: parsed.subtasks };
    }
    
    return { isComposite: false, subtasks: [] };
  } catch (err) {
    log.warn('voice', 'Decomposition LLM failed, treating as single task', { data: err.message });
    return { isComposite: false, subtasks: [] };
  }
}

/**
 * Handle media playback commands via AppleScript
 */
async function handleMediaCommand(text, transcript) {
  // Determine the media app - default to Music (Apple Music)
  let app = 'Music';
  if (text.includes('spotify')) {
    app = 'Spotify';
  } else if (text.includes('youtube')) {
    // YouTube requires browser control, skip for now
    return null;
  }
  
  let script = null;
  let action = null;
  let message = null;
  
  // Play command
  if (text.includes('play')) {
    // Check if it's "play music" or similar general play command
    if (text.includes('music') || text.includes('song') || text.includes('something') || 
        text.match(/^play\s*$/) || text.match(/play\s+(now|please|it)/)) {
      script = `tell application "${app}" to play`;
      action = 'play';
      message = `Playing music in ${app}`;
    }
    // Specific song/artist/playlist
    else {
      const queryMatch = text.match(/play\s+(.+?)(?:\s+on\s+\w+)?$/i);
      const query = queryMatch ? queryMatch[1].trim() : null;
      
      if (query && !query.match(/^(music|song|something|now|please|it)$/i)) {
        // Search and play
        if (app === 'Spotify') {
          script = `
            tell application "Spotify"
              activate
              delay 0.5
            end tell
            tell application "System Events"
              keystroke "l" using command down
              delay 0.2
              keystroke "${query.replace(/"/g, '\\"')}"
              delay 1
              keystroke return
            end tell
          `;
        } else {
          // Apple Music search
          script = `
            tell application "Music"
              set searchResults to search playlist "Library" for "${query.replace(/"/g, '\\"')}"
              if length of searchResults > 0 then
                play item 1 of searchResults
              else
                play
              end if
            end tell
          `;
        }
        action = 'play-search';
        message = `Playing "${query}" in ${app}`;
      } else {
        script = `tell application "${app}" to play`;
        action = 'play';
        message = `Playing music in ${app}`;
      }
    }
  }
  // Pause command
  else if (text.includes('pause') || text.includes('stop')) {
    script = `tell application "${app}" to pause`;
    action = 'pause';
    message = 'Music paused';
  }
  // Skip/Next command
  else if (text.includes('skip') || text.includes('next')) {
    script = `tell application "${app}" to next track`;
    action = 'next';
    message = 'Skipping to next track';
  }
  // Previous command
  else if (text.includes('previous') || text.includes('back')) {
    script = `tell application "${app}" to previous track`;
    action = 'previous';
    message = 'Going back to previous track';
  }
  // Volume commands
  else if (text.includes('volume')) {
    if (text.includes('up') || text.includes('louder') || text.includes('increase')) {
      script = `set volume output volume ((output volume of (get volume settings)) + 10)`;
      action = 'volume-up';
      message = 'Volume increased';
    } else if (text.includes('down') || text.includes('quieter') || text.includes('decrease') || text.includes('lower')) {
      script = `set volume output volume ((output volume of (get volume settings)) - 10)`;
      action = 'volume-down';
      message = 'Volume decreased';
    } else if (text.includes('mute')) {
      script = `set volume with output muted`;
      action = 'mute';
      message = 'Volume muted';
    } else if (text.includes('unmute')) {
      script = `set volume without output muted`;
      action = 'unmute';
      message = 'Volume unmuted';
    } else {
      // Set specific volume
      const volumeMatch = text.match(/volume\s+(?:to\s+)?(\d+)/);
      if (volumeMatch) {
        const level = Math.min(100, Math.max(0, parseInt(volumeMatch[1])));
        script = `set volume output volume ${level}`;
        action = 'volume-set';
        message = `Volume set to ${level}%`;
      }
    }
  }
  
  if (!script) {
    return null; // Not a media command we can handle
  }
  
  // Execute the AppleScript
  try {
    const escapedScript = script.replace(/'/g, "'\"'\"'");
    await execAsync(`osascript -e '${escapedScript}'`, { timeout: 5000 });
    
    log.info('voice', 'Media command executed', { action: action });
    
    // NOTE: Don't call speakFeedback - message returned via respondToFunctionCall
    
    return {
      transcript,
      queued: false,
      handled: true,
      classified: true,
      action: `media-${action}`,
      message,
      suppressAIResponse: true,
    };
  } catch (error) {
    log.error('voice', 'Media command error', { error: error.message });
    
    // Try to open the app and then play
    if (action === 'play' && error.message.includes('not running')) {
      try {
        await execAsync(`open -a "${app}"`, { timeout: 3000 });
        await new Promise(r => setTimeout(r, 2000)); // Wait for app to launch
        await execAsync(`osascript -e 'tell application "${app}" to play'`, { timeout: 3000 });
        
        // NOTE: Don't call speakFeedback - message returned via respondToFunctionCall
        
        return {
          transcript,
          queued: false,
          handled: true,
          classified: true,
          action: 'media-play-launch',
          message: `Opened ${app} and started playback`,
          suppressAIResponse: true,
        };
      } catch (launchError) {
        log.error('voice', 'Failed to launch and play', { error: launchError.message });
      }
    }
    
    return null; // Let it fall through to the exchange
  }
}

/**
 * Broadcast message to all windows.
 * @deprecated Use hudApi.emitLifecycle / emitResult / emitDisambiguation instead.
 * Kept for backward compatibility with older renderer UIs that listen on voice-task:* channels.
 * Will be removed once all renderers migrate to the HUD API event listeners.
 */
function broadcastToWindows(channel, data) {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  });
}

/**
 * Setup notification manager listener to speak notifications
 */
function setupNotificationListener() {
  notificationManager.on('notify', (event) => {
    log.info('voice', 'Notification:', { v0: event.message });
    
    // Speak the notification
    if (global.speakFeedback) {
      global.speakFeedback(event.message);
    }
    
    // Also broadcast to windows
    broadcastToWindows('voice-task:notification', event);
  });
  
  log.info('voice', 'Notification listener setup');
}

/**
 * Setup the agent message queue for proactive agent messages
 * Connects the queue to the speech system
 */
function setupAgentMessageQueue() {
  const queue = getAgentMessageQueue();
  
  // Set up speak function using realtime speech
  queue.setSpeakFunction(async (message) => {
    try {
      const { getVoiceSpeaker } = require('../../voice-speaker');
      const speaker = getVoiceSpeaker();

      if (speaker) {
        await speaker.speak(message);
        return true;
      } else {
        log.warn('voice', '[AgentMessageQueue] Speech system not connected');
        return false;
      }
    } catch (e) {
      log.error('voice', '[AgentMessageQueue] Speak error', { error: e.message });
      return false;
    }
  });
  
  // Set up canSpeak function - check if system is idle
  queue.setCanSpeakFunction(() => {
    // Don't speak if there's a pending input context (agent waiting for response)
    if (pendingInputContexts.size > 0) {
      return false;
    }
    
    // Check if voice speaker is available and not busy
    try {
      const { getVoiceSpeaker } = require('../../voice-speaker');
      const speaker = getVoiceSpeaker();

      if (!speaker) {
        return false;
      }

      // Check if speaker has pending speech
      if (speaker.hasPendingSpeech()) {
        return false;
      }
      
      return true;
    } catch (e) {
      return false;
    }
  });
  
  // Make queue available globally for agents
  global.agentMessageQueue = queue;
  
  log.info('voice', 'Agent message queue setup');
}

/**
 * Initialize the exchange bridge
 */
async function initializeExchangeBridge(config = {}) {
  log.info('voice', 'Initializing...');
  
  // MANDATORY: Check for OpenAI API key - required for LLM-based agent bidding
  const { ready, error } = checkBidderReady();
  if (!ready) {
    log.warn('voice', 'WARNING', { data: error });
    log.warn('voice', 'Custom agents will not be able to bid on tasks without an API key.');
    // We continue initialization but agents won't work without the key
    // This allows the UI to load and prompt user to add key
  }
  
  // Try to load the compiled exchange package
  try {
    const exchangePkg = require('../../packages/task-exchange/dist/index.js');
    Exchange = exchangePkg.Exchange;
    WebSocketTransport = exchangePkg.WebSocketTransport;
    MemoryStorage = exchangePkg.MemoryStorage;
    log.info('voice', 'Loaded task-exchange package');
  } catch (error) {
    log.error('voice', 'Failed to load task-exchange', { error: error.message });
    log.info('voice', 'Make sure to run: cd packages/task-exchange && npm run build');
    return false;
  }
  
  const mergedConfig = { ...DEFAULT_EXCHANGE_CONFIG, ...config };
  
  // Reset shutdown flag and track port for reconnection
  isShuttingDown = false;
  currentExchangePort = mergedConfig.port;
  
  try {
    // Create storage
    const storage = new MemoryStorage();
    
    // Create exchange
    exchangeInstance = new Exchange(mergedConfig, storage);
    
    // ==================== MASTER ORCHESTRATOR ====================
    // Set up intelligent winner selection
    try {
      const masterOrchestrator = require('../../packages/agents/master-orchestrator');
      exchangeInstance.setMasterEvaluator(async (task, bids) => {
        return await masterOrchestrator.evaluate(task, bids);
      });
      log.info('voice', 'Master Orchestrator enabled');
    } catch (e) {
      log.warn('voice', 'Master Orchestrator not available', { data: e.message });
    }
    
    // Create transport
    transportInstance = new WebSocketTransport(exchangeInstance, {
      port: mergedConfig.port,
      heartbeatIntervalMs: mergedConfig.heartbeatIntervalMs,
      heartbeatTimeoutMs: mergedConfig.heartbeatTimeoutMs,
    });
    
    // Wire up exchange events to HUD
    setupExchangeEvents();
    
    // Start transport and exchange
    await transportInstance.start();
    await exchangeInstance.start();
    
    isExchangeRunning = true;
    log.info('voice', 'Exchange running on port', { v0: mergedConfig.port });
    
    // Setup notification manager
    setupNotificationListener();
    
    // Setup agent message queue for proactive messages
    setupAgentMessageQueue();
    
    // Register IPC handlers
    setupExchangeIPC();
    
    // Initialize centralized HUD API (space-scoped task routing)
    hudApi.initialize(module.exports);
    
    // ==================== CONNECT ALL AGENTS TO EXCHANGE ====================
    // 1. Connect built-in agents (time, weather, media, etc.)
    await connectBuiltInAgents(mergedConfig.port);
    
    // 2. Connect custom agents from agent-store
    await connectCustomAgents(mergedConfig.port);
    
    log.info('voice', 'All agents connected. Total:', { v0: localAgentConnections.size });
    
    // ==================== PERIODIC AGENT HEALTH CHECK ====================
    // Detect and reconnect agents that silently dropped off
    if (healthCheckInterval) clearInterval(healthCheckInterval);
    healthCheckInterval = setInterval(async () => {
      try {
        await reconnectDisconnectedAgents();
      } catch (e) {
        log.warn('voice', 'Agent health check error', { data: e.message });
      }
    }, HEALTH_CHECK_INTERVAL_MS);
    log.info('voice', 'Agent health check enabled (every ' + (HEALTH_CHECK_INTERVAL_MS / 1000) + 's)');
    
    // Restore conversation state from previous session (non-blocking)
    restoreConversationState().catch(e =>
      log.warn('voice', '[ExchangeBridge] Conversation restore error', { data: e.message })
    );

    // Pre-load user profile so it's ready for first request
    getUserProfile().load().then(async () => {
      const profile = getUserProfile();
      profile.updateSessionActivity();
      log.info('voice', 'User profile loaded');

      // ── Onboarding: if profile has no personal info, greet and ask the user to introduce themselves ──
      // We check Identity specifically -- default preferences (Fahrenheit, 12-hour) don't count as "known".
      const identityFacts = profile.getFacts('Identity') || {};
      const hasName = identityFacts.Name && !identityFacts.Name.includes('not yet learned');
      const sessionCtx = profile.getFacts('Session Context') || {};
      const sessionsToday = parseInt(sessionCtx['Sessions today'] || '0', 10);
      // Only onboard on the very first session (sessions today == 1 means this is the first)
      const isNewUser = !hasName && sessionsToday <= 1;
      if (isNewUser) {
        log.info('voice', '[Onboarding] Profile is blank -- starting onboarding');
        // Wait a few seconds for the voice orb and exchange to fully initialize
        setTimeout(async () => {
          try {
            const { getVoiceSpeaker } = require('../../voice-speaker');
            const speaker = getVoiceSpeaker();
            const greeting = "Welcome! I don't know anything about you yet. Tell me your name and a little about yourself -- like where you live or how you'd like me to help -- and I'll remember it for next time.";
            if (speaker) {
              await speaker.speak(greeting, { voice: 'ash' });
            }
            // Also show on the HUD
            if (global.sendCommandHUDResult) {
              global.sendCommandHUDResult({
                success: true,
                message: greeting,
                agentId: 'memory-agent',
              });
            }
            log.info('voice', '[Onboarding] Welcome message spoken');
          } catch (e) {
            log.warn('voice', '[Onboarding] Could not speak welcome', { data: e.message });
          }
        }, 5000);
      }
    }).catch(e =>
      log.warn('voice', '[ExchangeBridge] User profile load error', { data: e.message })
    );

    return true;
  } catch (error) {
    log.error('voice', 'Failed to start exchange', { error: error });
    return false;
  }
}

/**
 * Setup exchange event listeners
 */
function setupExchangeEvents() {
  if (!exchangeInstance) return;
  
  // Task queued - show HUD and acknowledge
  exchangeInstance.on('task:queued', ({ task }) => {
    log.info('voice', 'Task queued', { taskId: task.id });
    
    if (global.showCommandHUD) {
      global.showCommandHUD({
        id: task.id,
        transcript: task.content,
        action: 'Processing',
        status: 'queued',
        confidence: 0,
      });
    }
    
    // NOTE: With function calling, frontend handles all TTS via respondToFunctionCall()
    // Don't call speakFeedback directly here - it conflicts with function call responses
    
    broadcastToWindows('voice-task:queued', {
      taskId: task.id,
      content: task.content,
      status: 'queued',
    });

    // Auto-register tool mapping from task metadata so ALL events for this task
    // route to the correct tool's listeners (regardless of submission path)
    if (task.metadata?.source) {
      hudApi.setTaskTool(task.id, task.metadata.source);
    }
    if (task.metadata?.agentSpaceId) {
      hudApi.setTaskSpace(task.id, task.metadata.agentSpaceId);
    }

    // Emit to HUD API for space-scoped tool routing
    hudApi.emitLifecycle({ type: 'task:queued', taskId: task.id, content: task.content });
  });
  
  // Auction started
  exchangeInstance.on('auction:started', ({ task, auctionId }) => {
    log.info('voice', 'Auction started', { auctionId: auctionId });
    
    if (global.showCommandHUD) {
      global.showCommandHUD({
        id: task.id,
        transcript: task.content,
        action: 'Finding agent...',
        status: 'running',
      });
    }

    hudApi.emitLifecycle({ type: 'auction:started', taskId: task.id, auctionId });
  });
  
  // No bids received - task halted - try LLM-based disambiguation
  exchangeInstance.on('exchange:halt', async ({ task, reason }) => {
    log.warn('voice', 'Exchange halted', { data: reason });

    // Always emit halt lifecycle so tools know the auction failed
    hudApi.emitLifecycle({ type: 'exchange:halt', taskId: task.id, reason });
    
    // Safety net: ensure a result is ALWAYS emitted even if disambiguation crashes
    const safetyTimer = setTimeout(() => {
      log.warn('voice', 'Exchange:halt safety timer fired - emitting fallback result');
      hudApi.emitResult({
        taskId: task.id,
        success: false,
        message: "I couldn't find an agent to handle that. Could you rephrase?",
        agentId: 'system',
        needsClarification: true,
      });
    }, 12000); // 12s safety net
    
    try {
    
    const content = task?.content || '';
    
    // Use HUD API transcript filter (two-stage: heuristic + LLM) instead of old regex
    // Add timeout: LLM can hang when API is overloaded
    let isGarbled = false;
    try {
      const filterResult = await Promise.race([
        hudApi.filterTranscript(content),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Filter timeout')), 5000))
      ]);
      isGarbled = !filterResult.pass;
      if (isGarbled) {
        log.info('voice', 'Halt handler: transcript rejected by filter:', { v0: filterResult.reason });
      }
    } catch (e) {
      // Filter failed or timed out -- fall back to old heuristic
      isGarbled = isLikelyGarbledTranscription(content);
    }
    
    if (isGarbled) {
      // Ask for repeat - transcription seems wrong
      log.info('voice', 'Transcription appears garbled, asking for repeat');
      
      const clarificationMessage = "I didn't quite catch that. Could you say that again?";
      addToHistory('assistant', clarificationMessage, 'system');
      
      if (global.sendCommandHUDResult) {
        global.sendCommandHUDResult({
          success: false,
          needsClarification: true,
          message: clarificationMessage,
        });
      }

      // Emit result so tools know the task resolved (as garbled)
      hudApi.emitResult({
        taskId: task.id,
        success: false,
        message: clarificationMessage,
        agentId: 'system',
        needsClarification: true,
      });

      // Speak the clarification
      try {
        const { getVoiceSpeaker } = require('../../voice-speaker');
        const speaker = getVoiceSpeaker();
        if (speaker) await speaker.speak(clarificationMessage, { voice: 'sage' });
      } catch (e) { /* non-fatal */ }

    } else {
      // Task was clear but no agent can handle it -- use LLM disambiguation
      log.info('voice', 'No agents for task, generating LLM disambiguation');
      
      // Guard against infinite rephrase loops: max 1 auto-rephrase attempt
      const rephraseAttempts = task.metadata?.rephraseAttempts || 0;
      
      // Get agent descriptions for the LLM
      const { getAllAgents } = require('../../packages/agents/agent-registry');
      const agents = getAllAgents().filter(a => !a.bidExcluded);
      const agentDescriptions = agents.map(a => ({ name: a.name, description: a.description }));
      
      let disambiguation = { options: [] };
      try {
        disambiguation = await Promise.race([
          generateClarificationOptions(content, agentDescriptions),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Disambiguation timeout')), 6000))
        ]);
      } catch (disErr) {
        log.warn('voice', 'Disambiguation LLM failed, using generic response', { error: disErr.message });
      }
      
      let clarificationMessage;
      if (disambiguation.options.length > 0) {
        clarificationMessage = disambiguation.question;
      } else {
        clarificationMessage = `I'm not sure how to help with "${content}". Could you rephrase that, or ask "what can you do" to see my capabilities?`;
      }
      
      addToHistory('assistant', clarificationMessage, 'system');
      
      if (global.sendCommandHUDResult) {
        global.sendCommandHUDResult({
          success: false,
          needsClarification: true,
          suggestions: disambiguation.options.map(o => o.label),
          message: clarificationMessage,
        });
      }
      
      // If options exist, show disambiguation UI on HUD
      if (disambiguation.options.length > 0) {
        broadcastToWindows('voice-task:disambiguation', {
          taskId: task.id,
          question: disambiguation.question,
          options: disambiguation.options,
          rephraseAttempts,
        });
        
        // Also emit through centralized HUD API
        hudApi.emitDisambiguation({
          taskId: task.id,
          question: disambiguation.question,
          options: disambiguation.options,
        });
      }
      
      // ALWAYS emit result so onResult listeners get notified
      // (disambiguation alone doesn't trigger onResult)
      hudApi.emitResult({
        taskId: task.id,
        success: false,
        message: clarificationMessage,
        agentId: 'system',
        needsClarification: true,
      });

      // Speak the clarification
      try {
        const { getVoiceSpeaker } = require('../../voice-speaker');
        const speaker = getVoiceSpeaker();
        if (speaker) await speaker.speak(clarificationMessage, { voice: 'sage' });
      } catch (e) { /* non-fatal */ }
    }
    
    clearTimeout(safetyTimer); // Disambiguation succeeded, cancel safety net
    } catch (haltError) {
      clearTimeout(safetyTimer);
      log.error('voice', 'Exchange:halt handler crashed', { error: haltError.message });
      // Ensure user always gets a response
      hudApi.emitResult({
        taskId: task.id,
        success: false,
        message: "Something went wrong. Could you try again?",
        agentId: 'error-agent',
      });
    }
  });
  
  // Task assigned to winner
  exchangeInstance.on('task:assigned', async ({ task, winner, backups, masterEvaluation }) => {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'exchange-bridge.js:task:assigned',message:'task:assigned event fired',data:{taskId:task.id,winnerId:winner.agentId,taskContent:task.content?.slice(0,80)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'E'})}).catch(()=>{});
    // #endregion
    log.info('voice', 'Task assigned to', { agentId: winner.agentId });
    
    // Store master evaluation in task metadata for feedback phase
    if (masterEvaluation) {
      task.metadata = task.metadata || {};
      task.metadata.masterEvaluation = masterEvaluation;
      log.info('voice', 'Master evaluation stored', { reasoning: masterEvaluation.reasoning });
    }

    // Track execution start time for duration calculation
    taskExecutionStartTimes.set(task.id, Date.now());
    
    // DEFERRED ACK - only speak if the task doesn't complete quickly.
    // For fast tasks (pause, time, spelling), the result arrives in <2s
    // and speaking an ack + result feels like a double response.
    const ACK_DELAY_MS = 2500; // Wait this long before speaking ack
    try {
      const { getAgent } = require('../../packages/agents/agent-registry');
      const agent = getAgent(winner.agentId);
      let ackMessage = null;
      
      if (agent?.acks && Array.isArray(agent.acks) && agent.acks.length > 0) {
        ackMessage = agent.acks[Math.floor(Math.random() * agent.acks.length)];
      } else if (agent?.ack) {
        ackMessage = agent.ack;
      }
      
      if (ackMessage) {
        // Defer ack -- cancel if result arrives first
        const ackTimer = setTimeout(() => {
          // Only speak if task is still executing (no result yet)
          if (taskExecutionStartTimes.has(task.id)) {
            try {
              const { getVoiceSpeaker } = require('../../voice-speaker');
              const speaker = getVoiceSpeaker();
              if (speaker) {
                const agentVoice = getAgentVoice(winner.agentId, agent);
                log.info('voice', 'Speaking agent ack (deferred)', { ackMessage, agentVoice });
                speaker.speak(ackMessage, { voice: agentVoice });
              }
            } catch (_) {}
          } else {
            log.info('voice', 'Ack suppressed - task already completed');
          }
        }, ACK_DELAY_MS);
        
        // Store timer in separate map (NOT on task.metadata!)
        // Putting a Timeout object on task.metadata breaks JSON.stringify
        // when the exchange serializes the task for WebSocket transmission.
        pendingAckTimers.set(task.id, ackTimer);
      }
    } catch (e) {
      log.warn('voice', 'Could not set up ack', { data: e.message });
    }
    
    // Build all bids summary for HUD
    const allBids = [winner, ...backups];
    const bidsSummary = allBids.map(b => ({
      agentId: b.agentId,
      agentName: b.agentName || b.agentId,
      confidence: b.confidence,
      reasoning: b.reasoning,
    }));
    
    // Record stats
    try {
      const { getAgentStats } = require('./agent-stats');
      const stats = getAgentStats();
      stats.init().then(() => {
        stats.recordWin(winner.agentId);
        stats.recordExecution(winner.agentId);
        
        // Record bid event for debugging
        stats.recordBidEvent({
          taskId: task.id,
          taskContent: task.content,
          bids: bidsSummary,
          winner,
        });
      });
    } catch (e) {
      log.warn('voice', 'Stats tracking error', { data: e.message });
    }
    
    // Get pending context info for HUD
    const hasPendingContext = pendingInputContexts.size > 0;
    const pendingAgents = hasPendingContext ? Array.from(pendingInputContexts.keys()) : [];
    
    if (global.showCommandHUD) {
      global.showCommandHUD({
        id: task.id,
        transcript: task.content,
        action: `${winner.agentName || winner.agentId}`,
        agentId: winner.agentId,
        agentName: winner.agentName || winner.agentId,
        agentReasoning: winner.reasoning,
        status: 'running',
        confidence: winner.confidence,
        bidsSummary,
        totalBids: allBids.length,
        pendingContext: hasPendingContext ? { agents: pendingAgents } : null,
      });
    }
    
    // Note: Don't speak here - we already said "Got it" on task:queued
    // The next feedback will be the result or an error
    
    broadcastToWindows('voice-task:assigned', {
      taskId: task.id,
      agentId: winner.agentId,
      confidence: winner.confidence,
      backupCount: backups.length,
    });

    // Emit to HUD API
    hudApi.emitLifecycle({
      type: 'task:assigned', taskId: task.id, agentId: winner.agentId,
      confidence: winner.confidence,
    });
    
    // ==================== SUBTASK ACTIVE STATUS ====================
    // If this is a subtask, broadcast that it's now active
    if (isSubtask(task)) {
      log.info('voice', 'Subtask now active', { v0: task.id });
      broadcastToWindows('subtask:event', {
        type: 'status',
        subtaskId: task.id,
        parentTaskId: task.metadata.parentTaskId,
        status: 'active',
      });
      broadcastToWindows('voice-task:lifecycle', {
        type: 'subtask:active',
        subtaskId: task.id,
        parentTaskId: task.metadata.parentTaskId,
      });
    }
  });
  
  // Task completed successfully
  exchangeInstance.on('task:settled', async ({ task, result, agentId }) => {
    log.info('voice', 'Task settled by', { agentId: agentId });

    // ── RELEASE PROCESSING LOCK ──
    if (activeTaskLock && activeTaskLock.taskId === task.id) {
      log.info('voice', 'Releasing processing lock (task settled)', { taskId: task.id });
      activeTaskLock = null;
    }
    
    // ── ROUTING INTELLIGENCE: learn from this successful route ──
    if (agentId && task.content && result?.success !== false) {
      const agentName = allBuiltInAgentMap[agentId]?.name || agentId;
      // Use the bid confidence if available, otherwise default to 0.85
      const confidence = task.metadata?.winningConfidence || 0.85;
      recordSuccessfulRoute(task.content, agentId, agentName, confidence);
    }
    
    // Cancel deferred ack if it hasn't spoken yet
    if (pendingAckTimers.has(task.id)) {
      clearTimeout(pendingAckTimers.get(task.id));
      pendingAckTimers.delete(task.id);
    }
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'exchange-bridge.js:1725',message:'task:settled fired',data:{agentId,taskContent:task?.content?.slice(0,50),resultOutput:result?.output?.slice?.(0,100),resultMessage:result?.message?.slice?.(0,100),resultSuccess:result?.success,resultKeys:Object.keys(result||{})},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A-B'})}).catch(()=>{});
    // #endregion
    
    // Calculate execution duration
    const startTime = taskExecutionStartTimes.get(task.id);
    const executionDurationMs = startTime ? Date.now() - startTime : null;
    taskExecutionStartTimes.delete(task.id); // Clean up
    
    if (executionDurationMs !== null) {
      log.info('voice', 'Task execution time: ms', { v0: executionDurationMs });
    }
    
    // ==================== SUBTASK STATUS UPDATE ====================
    // If this is a subtask, broadcast its completion status to HUD
    if (isSubtask(task)) {
      const status = result?.success !== false ? 'completed' : 'failed';
      log.info('voice', 'Subtask', { v0: task.id, v1: status });
      broadcastToWindows('subtask:event', {
        type: 'status',
        subtaskId: task.id,
        parentTaskId: task.metadata.parentTaskId,
        status,
      });
      
      // Also emit to lifecycle for HUD
      broadcastToWindows('voice-task:lifecycle', {
        type: `subtask:${status}`,
        subtaskId: task.id,
        parentTaskId: task.metadata.parentTaskId,
      });
    }
    
    // Record success stats with execution time
    try {
      const { getAgentStats } = require('./agent-stats');
      const stats = getAgentStats();
      stats.init().then(() => {
        if (result?.success !== false) {
          stats.recordSuccess(agentId, executionDurationMs);
        } else {
          stats.recordFailure(agentId, result?.error || 'Execution failed', executionDurationMs);
        }
      });
    } catch (e) {
      log.warn('voice', 'Stats tracking error', { data: e.message });
    }
    
    // ==================== MASTER ORCHESTRATOR FEEDBACK ====================
    // Provide feedback to help agents learn
    try {
      const masterOrchestrator = require('../../packages/agents/master-orchestrator');
      const winner = { agentId, agentVersion: '1.0.0' };
      // Get the master evaluation from the task metadata if available
      const masterEvaluation = task.metadata?.masterEvaluation || null;
      await masterOrchestrator.provideFeedback(task, result, winner, masterEvaluation);
      
      // Process any rejected bids (apply reputation penalties)
      if (masterEvaluation?.rejectedBids?.length > 0) {
        await masterOrchestrator.processRejectedBids(masterEvaluation.rejectedBids);
      }
    } catch (e) {
      // Master orchestrator feedback is optional
      log.warn('voice', 'Master Orchestrator feedback error', { data: e.message });
    }
    
    // ==================== CROSS-AGENT LEARNING PIPELINE ====================
    // Memory agent observes all successful conversations and routes facts
    // to the right agent memories (replaces old profile-only extraction)
    if (result?.success !== false) {
      try {
        const memoryAgent = require('../../packages/agents/memory-agent');
        memoryAgent.observeConversation(task, result, agentId).catch(e =>
          log.warn('voice', '[MemoryObserver] Error', { data: e.message })
        );
      } catch (e) {
        // Fall back to legacy extraction if memory agent fails to load
        extractAndSaveUserFacts(task, result, agentId).catch(e2 =>
          log.warn('voice', '[LearningPipeline] Error', { data: e2.message })
        );
      }
    }
    
    // Phase 1: Check if this task was cancelled (late result suppression)
    if (routerInstance?.cancelledTaskIds?.has(task.id)) {
      log.info('voice', 'Suppressing late result for cancelled task', { taskId: task.id });
      routerInstance.cancelledTaskIds.delete(task.id);
      return;
    }
    
    // Check for multi-turn conversation (needsInput)
    if (result.needsInput) {
      log.info('voice', 'Agent needs input', { prompt: result.needsInput.prompt });
      
      // Add assistant prompt to conversation history
      addToHistory('assistant', result.needsInput.prompt, agentId);
      
      // Store context for the follow-up
      const pendingAgentId = result.needsInput.agentId || agentId;
      pendingInputContexts.set(pendingAgentId, {
        taskId: task.id,
        agentId: pendingAgentId,
        context: result.needsInput.context,
        field: result.needsInput.field,
        options: result.needsInput.options,
      });
      log.info('voice', 'Stored pending input context for agent: , pendingInputContexts.size:', { v0: pendingAgentId, v1: pendingInputContexts.size });
      
      // Emit through centralized HUD API
      hudApi.emitNeedsInput({
        taskId: task.id,
        prompt: result.needsInput.prompt,
        agentId: pendingAgentId,
      });
      
      // Send the prompt to be spoken + context info
      if (global.sendCommandHUDResult) {
        global.sendCommandHUDResult({
          success: true,
          message: result.needsInput.prompt,
          needsInput: true,
          html: result.html,
          data: result.data,
          agentId: result.needsInput.agentId || agentId,
          agentName: (result.needsInput.agentId || agentId).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          pendingContext: { agents: [result.needsInput.agentId || agentId] },
        });
      }
      
      // DIRECT TTS - Speak the prompt immediately via realtime speech
      // This ensures TTS works even if event-based approach has race conditions
      try {
        const { getVoiceSpeaker } = require('../../voice-speaker');
        const speaker = getVoiceSpeaker();
        log.info('voice', 'Got voice speaker instance', { speaker: !!speaker });
        
        if (speaker && result.needsInput.prompt) {
          // Get agent-specific voice personality
          const agentVoice = getAgentVoice(agentId);
          log.info('voice', 'Speaking needsInput prompt directly', { prompt: result.needsInput.prompt, agentVoice: agentVoice });
          // Await the speak call to ensure it's queued
          const speakResult = await speaker.speak(result.needsInput.prompt, { voice: agentVoice });
          log.info('voice', 'Speak result', { speakResult: speakResult });
        } else {
          log.warn('voice', 'Cannot speak: missing requirements', { hasSpeaker: !!speaker, hasPrompt: !!result.needsInput.prompt });
        }
      } catch (e) {
        log.error('voice', 'Direct TTS failed', { arg0: e.message, arg1: e.stack });
      }
      
      // Also broadcast event (for HUD and other listeners)
      broadcastToWindows('voice-task:needs-input', {
        taskId: task.id,
        agentId,
        prompt: result.needsInput.prompt,
        options: result.needsInput.options,
        context: result.needsInput.context,
      });
      
      return; // Don't mark as completed yet
    }
    
    // ==================== EXECUTE APP ACTIONS ====================
    // If agent returned an action, execute it via IPC
    if (result.data?.action) {
      try {
        log.info('voice', 'Agent requested action', { action: result.data.action });
        
        // Execute the action through the app-actions handler
        // Use the exported executeAppAction function or fall back to requiring main
        let actionResult;
        
        try {
          // Try to get the exported action handler
          const appActions = require('../../main.js');
          if (typeof appActions.executeAppAction === 'function') {
            actionResult = await appActions.executeAppAction(result.data.action);
          } else {
            // Fallback: Use BrowserWindow to find main window and send message
            const { BrowserWindow } = require('electron');
            const mainWindow = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
            
            const { ipcMain } = require('electron');
            const action = result.data.action;
            
            // Handle menu item opening (LLM already matched the item)
            if (action.type === 'open-menu-item') {
              // Use pre-matched item if available, otherwise search
              let menuItem = action.matchedItem;
              
              if (!menuItem && action.query) {
                // Fallback: search for item via MenuDataManager (shouldn't normally happen with LLM)
                if (global.menuDataManager) {
                  menuItem = await global.menuDataManager.findMenuItem(action.query);
                } else {
                  const { findMenuItem } = require('../../menu.js');
                  menuItem = await findMenuItem(action.query);
                }
              }
              
              if (menuItem) {
                log.info('voice', 'Opening menu item: ()', { v0: menuItem.name, v1: menuItem.type });
                
                // Handle different item types
                if (menuItem.type === 'app-feature') {
                  // App features use direct IPC actions
                  log.info('voice', 'Opening app feature: via', { v0: menuItem.name, v1: menuItem.action });
                  ipcMain.emit('menu-action', null, {
                    action: menuItem.action,
                    label: menuItem.name
                  });
                  actionResult = { success: true, opened: menuItem.name };
                } else if (menuItem.type === 'tool-module') {
                  // Tool modules use moduleManager
                  log.info('voice', 'Opening tool module:', { v0: menuItem.name });
                  const { executeAction } = require('../../action-executor');
                  actionResult = executeAction('open-module', { moduleId: menuItem.moduleId, name: menuItem.name });
                } else if (menuItem.type === 'web-tool') {
                  // Web tools open in browser
                  log.info('voice', 'Opening web tool:', { v0: menuItem.name });
                  const { executeAction } = require('../../action-executor');
                  actionResult = executeAction('open-web-tool', { url: menuItem.url, name: menuItem.name });
                } else if (menuItem.type === 'tool') {
                  // Built-in tools (Black Hole, etc.)
                  log.info('voice', 'Opening built-in tool: via', { v0: menuItem.name, v1: menuItem.action });
                  const { executeAction } = require('../../action-executor');
                  actionResult = executeAction(menuItem.action);
                } else {
                  // Determine the correct action based on item type
                  let menuAction = 'open-external-bot';
                  if (menuItem.type === 'image-creator') menuAction = 'open-image-creator';
                  else if (menuItem.type === 'video-creator') menuAction = 'open-video-creator';
                  else if (menuItem.type === 'audio-generator') menuAction = 'open-audio-generator';
                  else if (menuItem.type === 'idw-environment') menuAction = 'open-idw-url';
                  
                  ipcMain.emit('menu-action', null, {
                    action: menuAction,
                    url: menuItem.url,
                    label: menuItem.name,
                    isExternal: true
                  });
                  actionResult = { success: true, opened: menuItem.name };
                }
              } else {
                log.warn('voice', 'No menu item found for:', { v0: action.query });
                actionResult = { success: false, error: `Could not find "${action.query}" in menu` };
              }
            } else if (action.type && action.type.startsWith('open-')) {
              // Direct window action (open-spaces, open-gsx-create, etc.)
              // Use centralized action executor
              log.info('voice', 'Executing app action:', { v0: action.type });
              const { executeAction } = require('../../action-executor');
              actionResult = executeAction(action.type, action.params || {});
            } else {
              log.warn('voice', 'Unknown action format', { data: action });
              actionResult = { success: false, error: `Unknown action format` };
            }
          }
        } catch (requireError) {
          log.error('voice', 'Failed to load action handler', { error: requireError.message });
          actionResult = { success: false, error: requireError.message };
        }
        
        log.info('voice', 'Action result', { actionResult: actionResult });
        
        // If action failed, add error to message
        if (!actionResult.success) {
          log.warn('voice', 'Action failed', { data: actionResult.error });
        }
      } catch (actionError) {
        log.error('voice', 'Failed to execute action', { data: actionError });
      }
    }
    
    let message = result.output || result.data?.output || result.data?.message || (result.success ? 'All done' : null);
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'exchange-bridge.js:1823',message:'message extracted',data:{extractedMessage:message?.slice?.(0,100),resultOutput:result?.output?.slice?.(0,100),resultDataMessage:result?.data?.message?.slice?.(0,100),willSpeak:!!(message && message !== 'All done')},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'B'})}).catch(()=>{});
    // #endregion
    
    // ==================== RESPONSE GUARD ====================
    // Lightweight sanity checks BEFORE speaking. Catches common hallucinations
    // like wrong day-of-week, wrong date, impossible temperatures, etc.
    if (message && message !== 'All done') {
      const guardIssue = checkResponseSanity(message);
      if (guardIssue) {
        log.warn('voice', `[ResponseGuard] Caught issue: ${guardIssue}`, { agentId, messagePreview: message.slice(0, 80) });
        // Re-execute the agent with explicit grounding instruction
        try {
          const agent = allBuiltInAgentMap[agentId];
          if (agent && agent.execute) {
            const groundedResult = await agent.execute({
              content: task.content,
              context: { ...task.context, groundingNote: `Your previous response had an error: ${guardIssue}. Use ONLY real data from your data sources.` },
            });
            const corrected = groundedResult?.output || groundedResult?.data?.output || groundedResult?.data?.message || groundedResult?.message;
            if (corrected) {
              const recheck = checkResponseSanity(corrected);
              if (!recheck) {
                log.info('voice', '[ResponseGuard] Re-execution produced valid response');
                message = corrected;
              } else {
                log.warn('voice', `[ResponseGuard] Re-execution still failed: ${recheck}. Stripping bad content.`);
                // Last resort: strip the incorrect portion rather than speaking a lie
              }
            }
          }
        } catch (guardErr) {
          log.warn('voice', '[ResponseGuard] Re-execution failed', { error: guardErr.message });
        }
      }
    }
    
    // Add assistant response to conversation history
    if (message) {
      addToHistory('assistant', message, agentId);
    }
    
    // Phase 1: Store response for repeat
    if (message) {
      responseMemory.setLastResponse(message);
      
      // Store undo if available
      if (result.data?.undoFn && result.data?.undoDescription) {
        responseMemory.setUndoableAction(result.data.undoDescription, result.data.undoFn);
      }
    }
    
    if (global.sendCommandHUDResult) {
      global.sendCommandHUDResult({
        success: true,
        message: message || 'Task completed',
        html: result.html,
        data: result.data,
        agentId,
        agentName: agentId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      });
    }

    // Emit to HUD API
    hudApi.emitResult({
      taskId: task.id,
      success: true,
      message: message || 'Task completed',
      data: result.data,
      agentId,
    });
    
    // DIRECT TTS - Speak the result directly via realtime speech
    // For async tasks, respondToFunctionCall already completed with empty response
    // so we need to speak the actual result here
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'exchange-bridge.js:1853',message:'TTS check entry',data:{hasMessage:!!message,messageValue:message?.slice?.(0,100),isAllDone:message==='All done',willTrySpeaking:!!(message && message !== 'All done')},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    if (message && message !== 'All done') {
      try {
        const { getVoiceSpeaker } = require('../../voice-speaker');
        const speaker = getVoiceSpeaker();
        log.info('voice', 'Got voice speaker for result', { speaker: !!speaker });
        
        if (speaker) {
          // Get agent-specific voice personality
          const agentVoice = getAgentVoice(agentId);
          log.info('voice', 'Speaking task result directly', { messagePreview: message.slice(0, 50), voice: agentVoice });
          const speakResult = await speaker.speak(message, { voice: agentVoice });
          log.info('voice', 'Speak result for task completion', { speakResult: speakResult });
        }
      } catch (e) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'exchange-bridge.js:1878',message:'TTS error',data:{errorMessage:e.message,errorStack:e.stack?.slice?.(0,300)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
        log.error('voice', 'Direct TTS for result failed', { arg0: e.message, arg1: e.stack });
      }
    }
    
    broadcastToWindows('voice-task:completed', {
      taskId: task.id,
      agentId,
      result,
    });
  });
  
  // Task executing - agent started working
  exchangeInstance.on('task:executing', ({ task, agentId }) => {
    log.info('voice', 'Task executing by', { agentId: agentId });
    
    if (global.showCommandHUD) {
      global.showCommandHUD({
        id: task.id,
        transcript: task.content,
        action: 'Processing...',
        status: 'running',
      });
    }

    hudApi.emitLifecycle({ type: 'task:executing', taskId: task.id, agentId });
    
    // Don't speak here - too granular, would interrupt flow
  });
  
  // Task locked by agent (for HUD countdown timer)
  exchangeInstance.on('task:locked', ({ task, agentId, timeoutMs }) => {
    log.info('voice', 'Task locked by , timeout ms', { v0: task.id, v1: agentId, v2: timeoutMs });
    broadcastToWindows('voice-task:lifecycle', {
      type: 'task:locked',
      taskId: task.id,
      agentId,
      timeoutMs,
      lockedAt: Date.now(),
    });
    hudApi.emitLifecycle({ type: 'task:locked', taskId: task.id, agentId, timeoutMs });
  });

  // Task unlocked (completed, failed, or timed out)
  exchangeInstance.on('task:unlocked', ({ task, reason }) => {
    log.info('voice', 'Task unlocked:', { v0: task.id, v1: reason });
    broadcastToWindows('voice-task:lifecycle', {
      type: 'task:unlocked',
      taskId: task.id,
      reason,
    });
    hudApi.emitLifecycle({ type: 'task:unlocked', taskId: task.id, reason });
  });

  // Task routed to error agent for graceful failure handling
  exchangeInstance.on('task:route_to_error_agent', async ({ task, reason }) => {
    log.info('voice', 'Routing task to error agent:', { v0: task.id, v1: reason });
    // Cancel deferred ack if it hasn't spoken yet
    if (pendingAckTimers.has(task.id)) {
      clearTimeout(pendingAckTimers.get(task.id));
      pendingAckTimers.delete(task.id);
    }
    broadcastToWindows('voice-task:lifecycle', {
      type: 'task:error_routed',
      taskId: task.id,
      reason,
    });
    hudApi.emitLifecycle({ type: 'task:error_routed', taskId: task.id, reason });

    // Invoke error agent directly (it doesn't participate in auctions)
    try {
      const { getAgent } = require('../../packages/agents/agent-registry');
      const errorAgent = getAgent('error-agent');
      if (errorAgent) {
        // Attach the failure reason to task metadata for the error agent
        task.metadata = task.metadata || {};
        task.metadata.errorReason = reason;
        const result = await errorAgent.execute(task);
        const message = result?.output || 'Something went wrong. Please try again.';

        // Add to conversation history
        addToHistory('assistant', message, 'error-agent');

        // Send to HUD (legacy)
        if (global.sendCommandHUDResult) {
          global.sendCommandHUDResult({
            success: false,
            message,
            agentId: 'error-agent',
            agentName: 'Error Handler',
            data: result?.data,
          });
        }

        // Emit through centralized HUD API
        hudApi.emitResult({
          taskId: task.id,
          success: false,
          message,
          agentId: 'error-agent',
          data: result?.data,
        });

        // Speak the error message
        try {
          const { getVoiceSpeaker } = require('../../voice-speaker');
          const speaker = getVoiceSpeaker();
          if (speaker && message) {
            const agentVoice = getAgentVoice('error-agent');
            await speaker.speak(message, { voice: agentVoice });
          }
        } catch (speakErr) {
          log.warn('voice', 'Error agent TTS failed', { data: speakErr.message });
        }
      } else {
        log.warn('voice', 'Error agent not loaded, falling back to generic message');
        hudApi.emitResult({
          taskId: task.id,
          success: false,
          message: 'Something went wrong. Please try again.',
          agentId: null,
        });
      }
    } catch (err) {
      log.error('voice', 'Error agent execution failed', { error: err.message });
      hudApi.emitResult({
        taskId: task.id,
        success: false,
        message: 'Something went wrong. Please try again.',
        error: err.message,
        agentId: null,
      });
    }
  });

  // Task failed, trying backup
  exchangeInstance.on('task:busted', ({ task, agentId, error, backupsRemaining }) => {
    log.info('voice', 'Task busted, backups remaining', { backupsRemaining: backupsRemaining });
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'exchange-bridge.js:1903',message:'task busted',data:{taskContent:task?.content?.slice(0,50),agentId,error,backupsRemaining},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    
    if (global.showCommandHUD) {
      global.showCommandHUD({
        id: task.id,
        transcript: task.content,
        action: backupsRemaining > 0 ? 'Trying backup agent...' : 'All agents failed',
        status: 'running',
      });
    }
    
    // NOTE: Don't speak retry messages during function call processing
    // It would conflict with the response that's being built

    hudApi.emitLifecycle({
      type: 'task:busted', taskId: task.id, agentId,
      error: typeof error === 'string' ? error : error?.message || 'unknown',
      backupsRemaining,
    });
  });
  
  // Task dead-lettered (all retries exhausted)
  // NOTE: task:route_to_error_agent fires first and handles the user-facing
  // response (via error-agent or fallback).  This handler only logs and
  // broadcasts lifecycle -- it does NOT emit a second emitResult, which
  // previously caused duplicate failure messages.
  exchangeInstance.on('task:dead_letter', ({ task, reason }) => {
    log.error('voice', 'Task dead-lettered', { data: reason });

    // ── RELEASE PROCESSING LOCK ──
    if (activeTaskLock && activeTaskLock.taskId === task.id) {
      log.info('voice', 'Releasing processing lock (task dead-lettered)', { taskId: task.id });
      activeTaskLock = null;
    }

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'exchange-bridge.js:dead_letter',message:'task dead-lettered',data:{taskContent:task?.content?.slice(0,50),reason},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
    // #endregion
    
    broadcastToWindows('voice-task:failed', {
      taskId: task.id,
      reason,
    });

    hudApi.emitLifecycle({ type: 'task:dead_letter', taskId: task.id, reason });
  });
  
  // Task cancelled
  exchangeInstance.on('task:cancelled', ({ task, reason }) => {
    log.info('voice', 'Task cancelled', { taskId: task.id, reason: reason });

    // ── RELEASE PROCESSING LOCK ──
    if (activeTaskLock && activeTaskLock.taskId === task.id) {
      log.info('voice', 'Releasing processing lock (task cancelled)', { taskId: task.id });
      activeTaskLock = null;
    }
    
    if (global.sendCommandHUDResult) {
      global.sendCommandHUDResult({
        success: false,
        cancelled: true,
        message: 'Cancelled',
      });
    }
    
    // NOTE: Don't call speakFeedback - "Cancelled" is returned via respondToFunctionCall
    
    broadcastToWindows('voice-task:cancelled', {
      taskId: task.id,
      reason,
    });

    hudApi.emitLifecycle({ type: 'task:cancelled', taskId: task.id, reason });
  });
  
  // Agent connected
  exchangeInstance.on('agent:connected', ({ agent }) => {
    log.info('voice', 'Agent connected', { agentId: agent.id });
    broadcastToWindows('voice-task:agent-connected', { agent });
  });
  
  // Agent disconnected
  exchangeInstance.on('agent:disconnected', ({ agentId, reason }) => {
    log.info('voice', 'Agent disconnected', { agentId: agentId, reason: reason });
    broadcastToWindows('voice-task:agent-disconnected', { agentId, reason });
  });
  
  // Agent flagged for review
  exchangeInstance.on('agent:flagged', ({ agentId, reputation }) => {
    log.warn('voice', 'Agent flagged', { arg0: agentId, arg1: reputation.score });
  });
}

/**
 * Setup IPC handlers for the exchange
 */
function setupExchangeIPC() {
  // Remove existing handlers that we're going to override
  // NOTE: voice-task-sdk:submit is NOT overridden here -- integration.js owns it
  const handlersToOverride = [
    'voice-task-sdk:exchange-status',
    'voice-task-sdk:list-agents',
    'voice-task-sdk:reputation-summary',
    'voice-task-sdk:reconnect-agents',
  ];
  
  for (const handler of handlersToOverride) {
    try {
      ipcMain.removeHandler(handler);
    } catch (e) {
      // Handler may not exist, that's fine
    }
  }
  
  // NOTE: voice-task-sdk:submit is owned by integration.js -- not registered here.
  // All submission paths (HUD API, legacy IPC, direct calls) flow through processSubmit() at module scope.
  
  // Get exchange status
  ipcMain.handle('voice-task-sdk:exchange-status', () => {
    const status = {
      running: isExchangeRunning,
      port: DEFAULT_EXCHANGE_CONFIG.port,
      agentCount: exchangeInstance?.agents?.getCount() || 0,
      queueDepth: exchangeInstance?.getQueueStats()?.depth?.total || 0,
      agents: [],
    };
    
    // List connected agents
    if (exchangeInstance?.agents) {
      status.agents = exchangeInstance.agents.getAll().map(a => ({
        id: a.id,
        name: a.name,
        healthy: a.healthy,
      }));
    }
    
    log.info('voice', 'Status check', { status: status });
    return status;
  });
  
  // List connected agents
  ipcMain.handle('voice-task-sdk:list-agents', () => {
    if (!exchangeInstance) return [];
    return exchangeInstance.agents.getAll().map(a => ({
      id: a.id,
      name: a.name,
      version: a.version,
      categories: a.categories,
      healthy: a.healthy,
      currentTasks: a.currentTasks,
    }));
  });
  
  // Reconnect disconnected agents (manual trigger)
  ipcMain.handle('voice-task-sdk:reconnect-agents', async () => {
    log.info('voice', 'Manual agent reconnect triggered');
    const result = await reconnectDisconnectedAgents();
    return result;
  });
  
  // Get reputation summary
  ipcMain.handle('voice-task-sdk:reputation-summary', async () => {
    if (!exchangeInstance) return {};
    const summary = await exchangeInstance.reputation.getSummary();
    return Object.fromEntries(summary);
  });
  
  log.info('voice', 'IPC handlers registered');
}

/**
 * Get the exchange instance
 */
function getExchange() {
  return exchangeInstance;
}

/**
 * Check if exchange is running
 */
function isRunning() {
  return isExchangeRunning;
}

/**
 * Get exchange connection URL for agents
 */
function getExchangeUrl() {
  return `ws://localhost:${DEFAULT_EXCHANGE_CONFIG.port}`;
}

/**
 * Shutdown the exchange
 */
async function shutdown() {
  log.info('voice', 'Shutting down...');
  
  // Prevent reconnection during shutdown
  isShuttingDown = true;
  
  // Stop health check
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
  
  // Shutdown agent message queue
  try {
    const queue = getAgentMessageQueue();
    queue.shutdown();
    global.agentMessageQueue = null;
    log.info('voice', 'Agent message queue shutdown');
  } catch (e) {
    log.warn('voice', 'Error shutting down message queue', { data: e.message });
  }
  
  // Close all agent connections gracefully
  for (const [agentId, conn] of localAgentConnections) {
    try {
      if (conn.heartbeatInterval) {
        clearInterval(conn.heartbeatInterval);
      }
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close(1000, 'Exchange shutting down');
      }
    } catch (e) {
      log.warn('voice', 'Error closing agent', { agentId, error: e.message });
    }
  }
  localAgentConnections.clear();
  
  if (exchangeInstance) {
    await exchangeInstance.shutdown(5000);
    exchangeInstance = null;
  }
  
  if (transportInstance) {
    await transportInstance.stop();
    transportInstance = null;
  }
  
  isExchangeRunning = false;
  isShuttingDown = false; // Reset for potential restart
  
  // Remove IPC handlers (voice-task-sdk:submit is owned by integration.js)
  const handlers = [
    'voice-task-sdk:exchange-status',
    'voice-task-sdk:list-agents',
    'voice-task-sdk:reputation-summary',
  ];
  
  handlers.forEach(handler => {
    try {
      ipcMain.removeHandler(handler);
    } catch (e) {
      // Handler may not exist
    }
  });
  
  log.info('voice', 'Shutdown complete');
}

/**
 * Hot-connect a newly created agent to the running exchange
 * Called by agent-store when a new agent is created
 */
async function hotConnectAgent(agent) {
  if (!isExchangeRunning) {
    log.info('voice', 'Exchange not running, cannot hot-connect agent', { agentName: agent.name });
    return false;
  }
  
  if (!agent.enabled) {
    log.info('voice', 'Agent is disabled, skipping hot-connect', { agentName: agent.name });
    return false;
  }
  
  // Check if already connected
  if (localAgentConnections.has(agent.id)) {
    log.info('voice', 'Agent already connected', { agentName: agent.name });
    return true;
  }
  
  try {
    const port = DEFAULT_EXCHANGE_CONFIG.port;
    await connectLocalAgent(agent, port);
    log.info('voice', 'Hot-connected new agent', { agentName: agent.name });
    return true;
  } catch (error) {
    log.error('voice', 'Failed to hot-connect agent', { arg0: agent.name, arg1: error.message });
    return false;
  }
}

// ==================== AGENT HEALTH CHECK & RECONNECTION ====================
// Periodic check to detect and reconnect agents that dropped off

let healthCheckInterval = null;
const HEALTH_CHECK_INTERVAL_MS = 30000; // Check every 30 seconds

/**
 * Reconnect any built-in or custom agents that should be connected but aren't.
 * Safe to call at any time -- skips agents that are already connected.
 * @returns {{ reconnected: number, failed: number, alreadyConnected: number }}
 */
async function reconnectDisconnectedAgents() {
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'exchange-bridge.js:reconnectDisconnectedAgents',message:'reconnect check started',data:{connectedCount:localAgentConnections.size,isRunning:isExchangeRunning,isShuttingDown},timestamp:Date.now(),hypothesisId:'A'})}).catch(()=>{});
  // #endregion
  
  if (!isExchangeRunning || isShuttingDown) {
    return { reconnected: 0, failed: 0, alreadyConnected: 0 };
  }
  
  let reconnected = 0;
  let failed = 0;
  let alreadyConnected = 0;
  
  // 1. Check built-in agents
  const enabledAgents = getEnabledBuiltInAgents();
  for (const agent of enabledAgents) {
    if (agent.bidExcluded) continue;
    
    if (localAgentConnections.has(agent.id)) {
      // Check if WebSocket is actually open
      const conn = localAgentConnections.get(agent.id);
      if (conn?.ws?.readyState === WebSocket.OPEN) {
        alreadyConnected++;
        continue;
      }
      // WebSocket exists but not open -- clean up stale entry
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'exchange-bridge.js:reconnectDisconnectedAgents',message:'stale connection found',data:{agentId:agent.id,wsState:conn?.ws?.readyState},timestamp:Date.now(),hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      localAgentConnections.delete(agent.id);
    }
    
    // Agent is missing -- reconnect
    try {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'exchange-bridge.js:reconnectDisconnectedAgents',message:'reconnecting built-in agent',data:{agentId:agent.id,agentName:agent.name},timestamp:Date.now(),hypothesisId:'C'})}).catch(()=>{});
      // #endregion
      const wrappedAgent = wrapBuiltInAgent(agent);
      await connectBuiltInAgentToExchange(wrappedAgent, currentExchangePort);
      reconnected++;
      log.info('voice', 'Health check reconnected agent', { v0: agent.name });
    } catch (e) {
      failed++;
      log.error('voice', 'Health check failed to reconnect agent', { v0: agent.name, v1: e.message });
    }
  }
  
  // 2. Check custom agents
  try {
    const { getAgentStore } = require('./agent-store');
    const agentStore = getAgentStore();
    if (agentStore?.initialized) {
      const agents = await agentStore.getAllAgents();
      for (const agent of agents) {
        if (!agent.enabled) continue;
        
        if (localAgentConnections.has(agent.id)) {
          const conn = localAgentConnections.get(agent.id);
          if (conn?.ws?.readyState === WebSocket.OPEN) {
            alreadyConnected++;
            continue;
          }
          localAgentConnections.delete(agent.id);
        }
        
        try {
          await connectLocalAgent(agent, currentExchangePort);
          reconnected++;
          log.info('voice', 'Health check reconnected custom agent', { v0: agent.name });
        } catch (e) {
          failed++;
        }
      }
    }
  } catch (e) {
    // Custom agent store not available, that's fine
  }
  
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'exchange-bridge.js:reconnectDisconnectedAgents',message:'reconnect check complete',data:{reconnected,failed,alreadyConnected,totalConnected:localAgentConnections.size},timestamp:Date.now(),hypothesisId:'D'})}).catch(()=>{});
  // #endregion
  
  if (reconnected > 0 || failed > 0) {
    log.info('voice', 'Agent health check result', { reconnected, failed, alreadyConnected, total: localAgentConnections.size });
  }
  
  return { reconnected, failed, alreadyConnected };
}

/**
 * Disconnect an agent from the exchange (for deletion or disable)
 */
function disconnectAgent(agentId) {
  const connection = localAgentConnections.get(agentId);
  if (connection) {
    // Mark as intentional so the close handler doesn't try to reconnect
    intentionalCloses.add(agentId);
    // Clean up heartbeat interval
    if (connection.heartbeatInterval) {
      clearInterval(connection.heartbeatInterval);
    }
    // Close WebSocket
    if (connection.ws) {
      try {
        connection.ws.close();
        log.info('voice', 'Disconnected agent', { agentId: connection.agent?.name || agentId });
      } catch (e) {
        // Ignore close errors
      }
    }
    localAgentConnections.delete(agentId);
    return true;
  }
  return false;
}

/**
 * Canonical task submission pipeline.
 *
 * ALL submission paths converge here:
 *  - HUD API  (hud-api.js → submitTask → processSubmit)
 *  - Legacy IPC  (voice-task-sdk:submit → processSubmit)
 *  - Direct calls (any module can require() and call processSubmit)
 *
 * Full pipeline:
 *  1. Dedup check
 *  2. Record activity + conversation history
 *  3. Pending multi-turn input routing
 *  4. Router integration (cancel/stop/repeat)
 *  5. Transcript quality filter (skip if caller already filtered)
 *  6. Special commands (open windows, media control, create agent)
 *  7. Task decomposition
 *  8. Exchange auction submit
 *
 * @param {string} transcript - User's input text
 * @param {Object} options
 * @param {string[]} [options.agentFilter] - Agent IDs to restrict bidding
 * @param {string}   [options.spaceId]     - Agent space for scoping
 * @param {string}   [options.toolId]      - Source tool (orb, command-hud, legacy-ipc …)
 * @param {boolean}  [options.skipFilter]  - Skip transcript quality filter (caller already filtered)
 * @param {Object}   [options.metadata]    - Extra metadata for the task
 * @returns {Object} { queued, handled, taskId, message, needsInput, suppressAIResponse, … }
 */
async function processSubmit(transcript, options = {}) {
  const { agentFilter, spaceId, toolId = 'voice', metadata = {}, skipFilter = false } = options;
  log.info('voice', 'processSubmit', { transcript: (transcript || '').slice(0, 60), toolId, hasExchange: !!exchangeInstance, isRunning: isExchangeRunning });

  // ==================== EMPTY CHECK ====================
  if (!transcript || !transcript.trim()) {
    return { queued: false, handled: false, message: 'Empty transcript' };
  }

  let text = transcript.trim();

  // ==================== DUPLICATE SUBMISSION CHECK ====================
  const normalizedTranscript = text.toLowerCase().replace(/[.,!?;:'"]/g, '').trim();
  const now = Date.now();
  let isDuplicate = false;

  // Check exact match first, then prefix match against all recent submissions.
  // Partial transcripts like "Can you play it on?" are caught as prefixes of
  // the full "Can you play it on my speaker?" (and vice versa).
  for (const [recentText, recentTime] of recentSubmissions) {
    if (now - recentTime < SUBMIT_DEDUP_WINDOW_MS) {
      if (recentText === normalizedTranscript ||
          recentText.startsWith(normalizedTranscript) ||
          normalizedTranscript.startsWith(recentText)) {
        isDuplicate = true;
        break;
      }
    }
  }

  if (isDuplicate) {
    log.warn('voice', 'DUPLICATE detected (exact or prefix match)', { textPreview: text.slice(0, 50) });
    return {
      transcript: text,
      queued: false,
      handled: true,
      classified: true,
      message: 'Already processing this request.',
      suppressAIResponse: true,
    };
  }
  recentSubmissions.set(normalizedTranscript, now);

  // Clean up stale dedup entries
  for (const [key, ts] of recentSubmissions) {
    if (now - ts > SUBMIT_DEDUP_WINDOW_MS * 5) recentSubmissions.delete(key);
  }

  // ==================== PROCESSING LOCK ====================
  // Only one task can be in-flight at a time. If a task is already being
  // processed, reject new submissions (unless the lock has expired).
  if (activeTaskLock) {
    const lockAge = now - activeTaskLock.startedAt;
    if (lockAge < TASK_LOCK_TIMEOUT_MS) {
      log.warn('voice', 'PROCESSING LOCK active, rejecting overlapping submission', {
        lockedTaskId: activeTaskLock.taskId,
        lockedTranscript: activeTaskLock.transcript?.slice(0, 40),
        lockAgeMs: lockAge,
        newTextPreview: text.slice(0, 50),
      });
      return {
        transcript: text,
        queued: false,
        handled: true,
        classified: true,
        message: 'Still working on your last request.',
        suppressAIResponse: true,
      };
    }
    // Lock expired -- stale, clear it
    log.warn('voice', 'Processing lock expired, clearing stale lock', {
      lockedTaskId: activeTaskLock.taskId,
      lockAgeMs: lockAge,
    });
    activeTaskLock = null;
  }

  // ==================== ACTIVITY + CONVERSATION ====================
  try {
    const messageQueue = getAgentMessageQueue();
    messageQueue.recordActivity();
  } catch (_) { /* non-fatal */ }
  addToHistory('user', text);

  // ==================== PENDING AGENT INPUT (MULTI-TURN) ====================
  if (pendingInputContexts.size > 0) {
    // If caller specified a target agent (e.g. button click from HUD panel),
    // route to that agent. Otherwise (voice), route to the first pending agent.
    let agentId, pendingContext;
    const targetAgentId = metadata.targetAgentId;
    if (targetAgentId && pendingInputContexts.has(targetAgentId)) {
      agentId = targetAgentId;
      pendingContext = pendingInputContexts.get(targetAgentId);
    } else {
      [agentId, pendingContext] = pendingInputContexts.entries().next().value;
    }
    log.info('voice', 'Routing follow-up to pending agent', { agentId, targeted: !!targetAgentId });
    pendingInputContexts.delete(agentId);

    const agent = allBuiltInAgentMap[agentId];
    if (agent && agent.execute) {
      try {
        const followUpTask = {
          id: `task_${Date.now()}`,
          content: text,
          context: {
            ...(pendingContext.context || {}),
            userInput: text,
            conversationHistory: getRecentHistory(),
            conversationText: formatHistoryForAgent(),
          },
        };

        const result = await executeWithInputSchema(agent, followUpTask);

        // Agent needs MORE input
        if (result.needsInput) {
          addToHistory('assistant', result.needsInput.prompt, agentId);
          const pendingAgentId = result.needsInput.agentId || agentId;
          pendingInputContexts.set(pendingAgentId, {
            taskId: followUpTask.id,
            agentId: pendingAgentId,
            context: result.needsInput.context,
            field: result.needsInput.field,
            options: result.needsInput.options,
          });

          // Speak the follow-up question
          const prompt = result.needsInput.prompt;
          if (prompt) {
            try {
              const { getVoiceSpeaker } = require('../../voice-speaker');
              const speaker = getVoiceSpeaker();
              if (speaker) await speaker.speak(prompt);
            } catch (_) { /* non-fatal */ }
          }

          hudApi.emitNeedsInput({
            taskId: followUpTask.id,
            agentId: pendingAgentId,
            prompt,
            field: result.needsInput.field,
          });

          // Send to CommandHUD with html passthrough
          if (global.sendCommandHUDResult) {
            global.sendCommandHUDResult({
              success: true,
              message: prompt,
              needsInput: true,
              html: result.html,
              agentId: pendingAgentId,
              agentName: pendingAgentId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
              pendingContext: { agents: [pendingAgentId] },
            });
          }

          return {
            transcript: text,
            queued: false,
            handled: true,
            classified: true,
            action: 'agent-input-needed',
            message: prompt,
            needsInput: true,
            suppressAIResponse: true,
          };
        }

        // Follow-up completed
        const completedMessage = result.message || 'Done!';
        addToHistory('assistant', completedMessage, agentId);
        if (completedMessage && completedMessage !== 'Done!') {
          try {
            const { getVoiceSpeaker } = require('../../voice-speaker');
            const speaker = getVoiceSpeaker();
            if (speaker) await speaker.speak(completedMessage);
          } catch (_) { /* non-fatal */ }
        }

        // Send to CommandHUD with html passthrough
        if (global.sendCommandHUDResult) {
          global.sendCommandHUDResult({
            success: true,
            message: completedMessage,
            html: result.html,
            agentId,
            agentName: agentId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          });
        }

        hudApi.emitResult({
          taskId: followUpTask.id,
          success: true,
          message: completedMessage,
          data: result.data,
          html: result.html,
          agentId,
        });

        return {
          transcript: text,
          queued: false,
          handled: true,
          classified: true,
          action: 'agent-completed',
          message: completedMessage,
          suppressAIResponse: completedMessage !== 'Done!',
        };
      } catch (error) {
        log.error('voice', 'Follow-up execution error', { error: error.message });
        return { transcript: text, queued: false, handled: false, error: error.message };
      }
    }
  }

  // ==================== ROUTER (cancel/stop/repeat/undo) ====================
  if (!routerInstance && exchangeInstance) {
    routerInstance = createRouter(
      {
        submit: async (task) => {
          try {
            const { taskId } = await exchangeInstance.submit({
              content: task.content,
              priority: 2,
              metadata: { source: toolId, timestamp: Date.now() },
            });
            return { success: true, queued: true, taskId };
          } catch (error) {
            return { success: false, message: error.message };
          }
        },
        cancel: (taskId) => {
          if (exchangeInstance?.cancelTask) exchangeInstance.cancelTask(taskId);
        },
      },
      (message) => {
        log.info('voice', 'Router progress', { message });
      }
    );
    log.info('voice', 'Router initialized');
  }

  if (routerInstance) {
    const lowerText = text.toLowerCase().trim();

    // Critical commands -- only intercept TRUE system commands, not agent
    // intents like "cancel the meeting" or "stop the recording".
    // Match the Router's logic: bare word OR word + pronoun (it/that/this/everything/all/now)
    const exactCritical = ['cancel', 'stop', 'nevermind', 'never mind', 'repeat',
      'say that again', 'undo', 'undo that', 'take that back'];
    const pronounFollowers = ['it', 'that', 'this', 'everything', 'all', 'now'];
    const isTrueCritical = exactCritical.includes(lowerText) ||
      ['cancel', 'stop'].some(c => {
        if (!lowerText.startsWith(c + ' ')) return false;
        const rest = lowerText.slice(c.length + 1).trim();
        return pronounFollowers.includes(rest);
      });
    if (isTrueCritical) {
      log.info('voice', 'Routing critical command to Router');
      const result = await routerInstance.handle(text);
      if (result.handled) {
        return {
          transcript: text, queued: false, handled: true, classified: true,
          action: result.type || 'router-handled', message: result.speak,
          suppressAIResponse: false,
        };
      }
    }

    // Pending question / confirmation
    const routingContext = conversationState.getRoutingContext();
    if (routingContext.hasPendingQuestion || routingContext.hasPendingConfirmation) {
      log.info('voice', 'Routing to Router for pending state resolution');
      const result = await routerInstance.handle(text);
      if (result.handled) {
        return {
          transcript: text, queued: false, handled: true, classified: true,
          action: result.type || 'state-resolved', message: result.speak,
          suppressAIResponse: false,
        };
      }
    }
  }

  // ==================== TRANSCRIPT QUALITY FILTER ====================
  // Skip if the caller (e.g. HUD API submitTask) already filtered
  if (!skipFilter) {
    try {
      const filterResult = await hudApi.filterTranscript(text);
      if (!filterResult.pass) {
        log.info('voice', 'Transcript rejected by quality filter', { reason: filterResult.reason });
        return {
          transcript: text, queued: false, handled: true, classified: false,
          needsClarification: true,
          message: "Sorry, I didn't catch that. Could you repeat that?",
          filterReason: filterResult.reason,
          suppressAIResponse: false,
        };
      }
    } catch (_) {
      // Filter failed -- fail-open
    }
  }

  // ==================== EXCHANGE CHECK ====================
  if (!exchangeInstance || !isExchangeRunning) {
    log.warn('voice', 'Exchange not running, cannot process task');
    return {
      transcript: text, queued: false, handled: true, classified: false,
      message: "I'm not ready yet. Please try again in a moment.",
      error: 'Exchange not running',
      suppressAIResponse: false,
    };
  }

  // ==================== CONTEXT (used by both cache and auction) ====================
  const convHistory = getRecentHistory();
  const convText = formatHistoryForAgent();

  // ==================== INTENT NORMALIZATION ====================
  // Interpret raw transcript: fix speech errors, resolve pronouns, detect ambiguity.
  // Replaces `text` with the cleaned intent; keeps raw transcript in metadata.
  const rawTranscript = text;
  try {
    let userProfileCtxForNorm = '';
    try {
      const prof = getUserProfile();
      if (!prof.isLoaded()) await prof.load();
      userProfileCtxForNorm = prof.getContextString();
    } catch (_) { /* non-fatal */ }

    const normResult = await normalizeIntent(text, convText, userProfileCtxForNorm);

    if (normResult.needsClarification && normResult.clarificationQuestion) {
      log.info('voice', '[NormalizeIntent] Asking for clarification', { question: normResult.clarificationQuestion, raw: text });
      // Speak the question to the user and return early
      try {
        const { getVoiceSpeaker } = require('../../voice-speaker');
        const speaker = getVoiceSpeaker();
        if (speaker) await speaker.speak(normResult.clarificationQuestion);
      } catch (_) {}
      hudApi.emitResult({ taskId: `clarify_${Date.now()}`, success: true, message: normResult.clarificationQuestion, agentId: 'system' });
      return {
        transcript: text, queued: false, handled: true, classified: false,
        needsClarification: true,
        message: normResult.clarificationQuestion,
        suppressAIResponse: true,
      };
    }

    if (normResult.intent && normResult.intent !== text) {
      log.info('voice', `[NormalizeIntent] Interpreted: "${text}" -> "${normResult.intent}" (confidence=${normResult.confidence})`);
      text = normResult.intent;
    }
  } catch (normErr) {
    log.info('voice', '[NormalizeIntent] Error, using raw transcript', { error: normErr.message });
    // Fail-open: proceed with raw text
  }

  let userProfileContext = '';
  try {
    const profile = getUserProfile();
    if (!profile.isLoaded()) await profile.load();
    userProfileContext = profile.getContextString();
  } catch (_) { /* non-fatal */ }

  // ==================== ROUTING CACHE (1 LLM call vs 15) ====================
  // Before running a full 15-agent auction, check if we've successfully
  // routed a similar query before.  If so, validate with 1 fast LLM call
  // that considers the FULL conversation history and context.
  try {
    const cachedRoute = await validateRoutingCache(text, convText, userProfileContext);
    if (cachedRoute) {
      // Cache hit -- execute directly without auction
      const agent = allBuiltInAgentMap[cachedRoute.agentId];
      if (agent && agent.execute) {
        log.info('voice', `[FastPath] Executing via cache: ${cachedRoute.agentId} for "${text.slice(0, 50)}"`);

        // Visual feedback
        if (global.showCommandHUD) {
          global.showCommandHUD({
            id: `fast_${Date.now()}`,
            transcript: text,
            action: `${cachedRoute.agentName} (cached)`,
            status: 'running',
          });
        }

        // Execute the cached agent directly
        const taskObj = {
          id: `task_${Date.now()}`,
          content: text,
          context: { conversationHistory: convHistory, conversationText: convText },
          metadata: { source: toolId, conversationHistory: convHistory, conversationText: convText, userProfileContext },
        };

        try {
          const result = await executeWithInputSchema(agent, taskObj);

          // Record success back into history
          const message = result.message || result.result || '';
          if (message) addToHistory('assistant', message, cachedRoute.agentId);

          // Handle multi-turn (needsInput)
          if (result.needsInput) {
            const pendingAgentId = result.needsInput.agentId || cachedRoute.agentId;
            pendingInputContexts.set(pendingAgentId, {
              taskId: taskObj.id,
              agentId: pendingAgentId,
              context: result.needsInput.context,
              field: result.needsInput.field,
              options: result.needsInput.options,
            });
            const prompt = result.needsInput.prompt;
            if (prompt) {
              try {
                const { getVoiceSpeaker } = require('../../voice-speaker');
                const speaker = getVoiceSpeaker();
                if (speaker) await speaker.speak(prompt, { voice: getAgentVoice(cachedRoute.agentId) });
              } catch (_) {}
            }
            hudApi.emitNeedsInput({ taskId: taskObj.id, agentId: pendingAgentId, prompt });
            hudApi.emitResult({ taskId: taskObj.id, success: true, message: prompt || message, html: result.html, agentId: cachedRoute.agentId, needsInput: result.needsInput });
            if (global.sendCommandHUDResult) {
              global.sendCommandHUDResult({
                success: true, message: prompt || message, needsInput: true, html: result.html,
                agentId: pendingAgentId,
                agentName: pendingAgentId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
                pendingContext: { agents: [pendingAgentId] },
              });
            }
          } else {
            // Speak result
            if (message) {
              try {
                const { getVoiceSpeaker } = require('../../voice-speaker');
                const speaker = getVoiceSpeaker();
                if (speaker) await speaker.speak(message, { voice: getAgentVoice(cachedRoute.agentId) });
              } catch (_) {}
            }
            hudApi.emitResult({ taskId: taskObj.id, success: result.success !== false, message, html: result.html, agentId: cachedRoute.agentId, data: result.data });
            if (global.sendCommandHUDResult) {
              global.sendCommandHUDResult({
                success: true, message, html: result.html,
                agentId: cachedRoute.agentId,
                agentName: cachedRoute.agentName || cachedRoute.agentId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
              });
            }
          }

          // Update routing cache success
          recordSuccessfulRoute(text, cachedRoute.agentId, cachedRoute.agentName, cachedRoute.confidence);

          return {
            transcript: text, queued: false, handled: true, classified: true,
            action: 'routing-cache-hit', message,
            agentId: cachedRoute.agentId,
            suppressAIResponse: true,
          };
        } catch (execErr) {
          log.warn('voice', `[FastPath] Cached agent execution failed, falling through to auction`, { error: execErr.message });
          // Cache bust -- the agent failed, so remove the cached route
          routingCache.delete(routingSignature(text));
          // Fall through to normal auction below
        }
      }
    }
  } catch (cacheErr) {
    log.warn('voice', '[RoutingCache] Error, falling through to auction', { error: cacheErr.message });
    // Non-fatal -- fall through to normal auction
  }

  // ==================== PRE-SCREEN (narrow 10+ agents to ~3-4) ====================
  // If no routing cache hit and we have many agents, run a single fast LLM
  // call to identify the top candidates.  This replaces 10+ per-agent LLM
  // evaluation calls with 1 triage call + 3-4 evaluations.
  let effectiveAgentFilter = agentFilter || null;
  if (!effectiveAgentFilter) {
    try {
      const allAgentsList = Object.values(allBuiltInAgentMap);
      const candidates = await preScreenAgents(text, convText, allAgentsList);
      if (candidates) {
        effectiveAgentFilter = candidates;
      }
    } catch (preErr) {
      log.info('voice', '[PreScreen] Error, using full auction', { error: preErr.message });
    }
  }

  // ==================== EXCHANGE SUBMIT (with decomposition) ====================
  try {

    // HUD visual feedback
    const preSubmitTaskId = `task_${Date.now()}`;
    if (global.showCommandHUD) {
      global.showCommandHUD({
        id: preSubmitTaskId,
        transcript: text,
        action: 'Processing',
        status: 'queued',
      });
    }
    broadcastToWindows('voice-task:queued', {
      taskId: preSubmitTaskId,
      content: text,
      timestamp: now,
    });

    // Check for composite requests (decomposition)
    const decomposition = await decomposeIfNeeded(text);

    if (decomposition.isComposite && decomposition.subtasks.length > 1) {
      log.info('voice', 'Composite task decomposed', { subtaskCount: decomposition.subtasks.length });

      const subtaskIds = [];
      for (const subtaskContent of decomposition.subtasks) {
        try {
          const { taskId: stId } = await exchangeInstance.submit({
            content: subtaskContent,
            priority: 2,
            metadata: {
              source: toolId,
              agentSpaceId: spaceId,
              agentFilter: effectiveAgentFilter,
              parentTranscript: text,
              rawTranscript,
              conversationHistory: convHistory,
              conversationText: convText,
              userProfileContext,
              timestamp: Date.now(),
            },
          });
          subtaskIds.push(stId);
          log.info('voice', 'Subtask submitted', { subtaskId: stId, content: subtaskContent.slice(0, 50) });
        } catch (subErr) {
          log.error('voice', 'Subtask submit failed', { error: subErr.message });
        }
      }

      broadcastToWindows('voice-task:lifecycle', {
        type: 'task:decomposed',
        originalTranscript: text,
        subtaskIds,
        subtaskContents: decomposition.subtasks,
      });
      hudApi.emitLifecycle({
        type: 'task:decomposed',
        originalTranscript: text,
        subtaskIds,
        subtaskContents: decomposition.subtasks,
      });

      return {
        transcript: text, queued: true,
        taskId: subtaskIds[0], decomposed: true, subtaskIds,
        classified: true, action: 'exchange-auction',
        message: `Processing ${decomposition.subtasks.length} tasks...`,
        suppressAIResponse: true,
      };
    }

    // Single task submit
    const { taskId, task: submittedTask } = await exchangeInstance.submit({
      content: text,
      priority: metadata.priority || 2,
      metadata: {
        source: toolId,
        agentSpaceId: spaceId,
        agentFilter: effectiveAgentFilter,
        rawTranscript,
        conversationHistory: convHistory,
        conversationText: convText,
        userProfileContext,
        timestamp: Date.now(),
        ...metadata,
      },
    });

    log.info('voice', 'Task submitted', { taskId, toolId });

    // Set processing lock -- prevents overlapping submissions
    activeTaskLock = { taskId, transcript: text.slice(0, 80), startedAt: Date.now() };

    return {
      transcript: text,
      queued: true,
      taskId,
      task: submittedTask,
      classified: true,
      action: 'exchange-auction',
      message: 'Processing your request...',
      suppressAIResponse: true,
    };
  } catch (submitError) {
    log.error('voice', 'Exchange submit error', { error: submitError.message });
    return {
      transcript: text, queued: false, handled: true, classified: false,
      error: submitError.message,
      message: "Sorry, I couldn't process that request.",
      suppressAIResponse: false,
    };
  }
}

module.exports = {
  initializeExchangeBridge,
  getExchange,
  isRunning,
  getExchangeUrl,
  shutdown,
  hotConnectAgent,
  disconnectAgent,
  reconnectDisconnectedAgents,
  processSubmit,
  DEFAULT_EXCHANGE_CONFIG,
  // Voice system exports for agent creation
  VOICE_DESCRIPTIONS,
  searchVoices,
  getAgentVoice,
  // State persistence
  saveConversationState,
};
