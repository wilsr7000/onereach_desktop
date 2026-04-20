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

const { ipcMain, BrowserWindow } = require('electron');
const WebSocket = require('ws');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Phase 1: Import Router and state management
const { createRouter } = require('./routing/Router');
const conversationState = require('./state/conversationState');
const responseMemory = require('./memory/responseMemory');

// Phase 2: Notification manager for proactive notifications
const notificationManager = require('./notifications/notificationManager');

// Agent Message Queue for proactive agent messages
const { getAgentMessageQueue } = require('../../lib/agent-message-queue');

// Spaces API for writing conversation history to file

// User Profile for cross-agent persistent memory
const { getUserProfile } = require('../../lib/user-profile-store');

// Centralized HUD API for space-scoped task routing
const hudApi = require('../../lib/hud-api');

// Centralized AI service
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// ==================== EXTRACTED MODULES ====================
const {
  VOICE_DESCRIPTIONS,
  VOICE_CONFIG,
  getAgentVoice,
  searchVoices,
} = require('../../lib/exchange/voice-coordinator');

const {
  addToHistory,
  getRecentHistory,
  formatHistoryForAgent,
  clearHistory,
  saveConversationState,
  restoreConversationState,
  summarizeAndArchiveSession,
  extractAndSaveUserFacts,
  setOnTimeoutClear,
} = require('../../lib/exchange/conversation-history');

const {
  setExchangeInstance: setSubtaskExchange,
  setBroadcast: setSubtaskBroadcast,
  isSubtask,
  getSubtaskContext,
  createSubtaskSubmitter,
  executeWithInputSchema,
} = require('../../lib/exchange/subtask-registry');

const exchangeBus = require('../../lib/exchange/event-bus');

const { safeExecuteAgent, validateAgentContract } = require('../../packages/agents/agent-middleware');

const { getTranscriptService } = require('../../lib/transcript-service');

// ==================== BUILT-IN AGENT REGISTRY ====================
// Centralized agent loading - see packages/agents/agent-registry.js
// TO ADD A NEW AGENT: Just add the agent ID to BUILT_IN_AGENT_IDS in agent-registry.js
const {
  getAllAgents: getRegistryAgents,
  getAgentMap: getRegistryAgentMap,
  buildCategoryConfig,
} = require('../../packages/agents/agent-registry');

// NOTE: Task Queue Manager removed - now using distributed Exchange-based routing
// Tasks are submitted to Exchange, agents bid independently, Exchange picks winner

// Unified LLM Bidder - ALL agents use this, no keyword fallback
const { evaluateAgentBid, checkBidderReady } = require('../../packages/agents/unified-bidder');

// Router instance (initialized after exchange is ready)
let routerInstance = null;

// Voice config, conversation history, and subtask API are imported from extracted modules above.

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
  },
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

const routingCache = new Map(); // querySignature → { agentId, agentName, confidence, cachedAt }
const ROUTING_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes hard TTL

// Win tracking: rolling stats per agent for tiered bidding insights
const agentWinStats = new Map(); // agentId → { wins, total, recentQueries[] }
const WIN_STATS_WINDOW_MS = 30 * 60 * 1000; // 30-minute rolling window

/**
 * Normalize a query to a routing signature.
 * Strips specific times/dates/names (they change, intent pattern doesn't).
 */
function routingSignature(text) {
  return text
    .toLowerCase()
    .replace(/[.,!?;:'"]/g, '')
    .replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/gi, '_TIME_')
    .replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, '_DAY_')
    .replace(
      /\b(tomorrow|today|yesterday|next week|this week|this morning|this afternoon|this evening)\b/gi,
      '_TIMEREF_'
    )
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
      log.info(
        'voice',
        `[RoutingCache] HIT: "${text.slice(0, 40)}" → ${cached.agentId} (validated by LLM: ${result.reason || 'match'})`
      );
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
  stats.recentQueries = stats.recentQueries.filter((q) => Date.now() - q.time < WIN_STATS_WINDOW_MS);
  agentWinStats.set(agentId, stats);

  log.info('voice', `[RoutingCache] Cached: "${text.slice(0, 40)}" → ${agentId} (conf=${confidence.toFixed(2)})`);
}

/**
 * Get the most likely agent based on recent win history (for conversation continuity).
 * If the last exchange was with agent X and the new query is plausibly a follow-up,
 * agent X gets priority.
 */
/**
 * Lowercase + punctuation-strip + collapse whitespace for similarity
 * checks (e.g., detecting a user repeating themselves).
 * @param {string} s
 * @returns {string}
 */
function _normalizeAffectInput(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .replace(/[.,!?;:'"()\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _getConversationContinuityAgent() {
  // Storage still lives here (the `agentWinStats` Map is tightly
  // wound with the routing cache update path). The DECISION is
  // extracted to `lib/hud-core/conversation-continuity.js` so the
  // same rule runs in GSX / WISER / CLI consumers. We flatten the
  // Map into the portable `wins` shape and delegate.
  const { pickContinuityAgent } = require('../../lib/hud-core');
  const wins = [];
  for (const [agentId, stats] of agentWinStats) {
    const latest = stats.recentQueries[stats.recentQueries.length - 1];
    if (latest) wins.push({ agentId, timestamp: latest.time });
  }
  const result = pickContinuityAgent({ wins, windowMs: 120_000 });
  return result ? result.agentId : null;
}

// Clean up expired cache entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of routingCache) {
    if (now - entry.cachedAt > ROUTING_CACHE_TTL_MS) routingCache.delete(key);
  }
  // Clean up old win stats
  for (const [agentId, stats] of agentWinStats) {
    stats.recentQueries = stats.recentQueries.filter((q) => now - q.time < WIN_STATS_WINDOW_MS);
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
const PRE_SCREEN_MAX_CANDIDATES = 6; // Narrow to this many

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
      .filter((a) => !a.bidExcluded)
      .map((a) => `- ${a.id}: ${a.description || a.name}`)
      .join('\n');

    const result = await ai.json(
      `You are a task router. Given a user query and a list of AI agents, select the ${PRE_SCREEN_MAX_CANDIDATES} most likely agents to handle this query.

USER QUERY: "${text}"
${conversationText ? `RECENT CONVERSATION:\n${conversationText.slice(-500)}\n` : ''}
AVAILABLE AGENTS:
${agentSummaries}

IMPORTANT: Consider ALL domains -- music, sound effects, ambient audio, weather, calendar, browsing, files, etc. Don't bias toward generic/orchestrator agents when a specialist clearly matches.

Return a JSON object: { "agents": ["agent-id-1", "agent-id-2", ...] }
Include up to ${PRE_SCREEN_MAX_CANDIDATES} agent IDs, ordered by likelihood. Only include agents that have a reasonable chance of handling this query.`,
      { profile: 'fast', temperature: 0, maxTokens: 200, feature: 'agent-prescreen' }
    );

    if (result && Array.isArray(result.agents) && result.agents.length > 0) {
      const validIds = new Set(allAgents.map((a) => a.id));
      const filtered = result.agents.filter((id) => validIds.has(id)).slice(0, PRE_SCREEN_MAX_CANDIDATES);
      if (filtered.length > 0) {
        log.info(
          'voice',
          `[PreScreen] Narrowed ${allAgents.length} agents to ${filtered.length}: ${filtered.join(', ')}`,
          {
            query: text.slice(0, 50),
          }
        );
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
  // Action commands -- always pass through to let agents bid
  /^(start|stop|begin|end|join|leave|record|pause|resume)\s/i,
  /^(create|make|add|schedule|book|set up)\s/i,
  /^(open|close|show|hide|launch|run|find|search|check)\s/i,
  /^(send|email|message|text|call|dial|ring)\s/i,
  /^(save|export|download|upload|share|copy|move|rename)\s/i,
  /^(turn (on|off)|enable|disable|toggle|switch)\s/i,
  /^(remind|alert|notify|wake) me\s/i,
  /^(tell|show|read|list|describe|explain|summarize)\s/i,
  // Question patterns -- always pass through
  /^(what|when|where|who|how|why|which|can you|could you|will you|do you|is there|are there)\s/i,
  /^(do i|am i|have i|should i|did i|was i)\s/i,
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

  // Fast skip: if the transcript matches a clear pattern, pass through without LLM
  if (trimmed.split(/\s+/).length <= 15) {
    for (const pat of NORMALIZE_SKIP_PATTERNS) {
      if (pat.test(trimmed)) {
        return { intent: trimmed, rawTranscript: trimmed, needsClarification: false, confidence: 1.0 };
      }
    }
  }

  try {
    // DESIGN NOTE: We deliberately do NOT pass userProfileContext to this
    // prompt. Previous versions did, and the LLM would "helpfully" inject
    // profile facts (Home City, preferences) into the user's query --
    // rewriting "coffee shops in the area" to "coffee shops in the
    // Las Vegas area" based on a Home City field the user never mentioned.
    //
    // Location enrichment is the SEARCH AGENT's job (via the live
    // location service + hasLocation check), not NormalizeIntent's. The
    // normalizer should only fix speech-to-text errors and resolve
    // pronouns -- nothing more. Keeping its scope narrow prevents a
    // whole class of "system thinks I live somewhere I don't" bugs.
    const result = await ai.json(
      `You are a voice-command interpreter cleaning up speech-to-text output. Your ONLY jobs:
1. Fix obvious speech-to-text errors (homophones, missing words, run-on phrases).
2. Resolve pronouns ("it", "that", "this", "they") using the conversation history.
3. Output a clean, actionable version of what the user meant.

STRICT RULES:
- DO NOT add any information the user did not say. Do not insert city names, times, dates, preferences, or any context not present in the raw transcript.
- DO NOT expand "here", "nearby", "around here", "my area" into a specific place. Leave those words unchanged. Downstream agents have live location data and will handle geo-resolution themselves.
- Almost NEVER set needsClarification=true. The system has specialized agents that handle ambiguity through competitive bidding. Commands like "start a meeting", "check my calendar", "play some music" are perfectly clear -- pass them through.
- Only set needsClarification=true if the transcript is genuinely unintelligible gibberish (e.g., "the uh thing with the um").

${conversationText ? `RECENT CONVERSATION (for pronoun resolution only):\n${conversationText.slice(-800)}\n` : ''}
RAW TRANSCRIPT: "${trimmed}"

Return JSON:
{
  "intent": "clean version of what the user said, with NOTHING added",
  "needsClarification": false,
  "clarificationQuestion": null,
  "confidence": 0.0-1.0
}`,
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

// ==================== MULTI-TURN HELPERS (TranscriptService) ====================
// Extracted from 3 duplicate inline blocks. All pending-input state now lives
// in TranscriptService instead of the old bare `pendingInputContexts` Map.
// ==============================================================================

/**
 * Handle an agent result that contains `needsInput`. Stores pending state,
 * speaks the prompt, and emits HUD / broadcast events.
 *
 * @param {Object}  result  - The agent execution result (must have .needsInput)
 * @param {string}  agentId - The agent that produced the result
 * @param {string}  taskId  - The task ID that was being executed
 * @param {Object}  [opts]  - Extra fields to forward to HUD (html, data)
 */
async function handleNeedsInput(result, agentId, taskId, opts = {}) {
  const ts = getTranscriptService();
  const ni = result.needsInput;
  const pendingAgentId = ni.agentId || agentId;
  const prompt = ni.prompt;

  log.info('voice', 'Agent needs input', { prompt, agentId: pendingAgentId });

  addToHistory('assistant', prompt, agentId);

  ts.setPending(pendingAgentId, {
    taskId,
    agentId: pendingAgentId,
    context: ni.context,
    field: ni.field,
    options: ni.options,
  });

  hudApi.emitNeedsInput({ taskId, prompt, agentId: pendingAgentId, field: ni.field });

  if (global.sendCommandHUDResult) {
    global.sendCommandHUDResult({
      success: true,
      message: prompt,
      needsInput: true,
      html: opts.html || result.html,
      data: opts.data || result.data,
      agentId: pendingAgentId,
      agentName: pendingAgentId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      pendingContext: { agents: [pendingAgentId] },
    });
  }

  // Speak the prompt (best-effort)
  try {
    const { getVoiceSpeaker } = require('../../voice-speaker');
    const speaker = getVoiceSpeaker();
    if (speaker && prompt) {
      const agentVoice = getAgentVoice(agentId);
      await speaker.speak(prompt, { voice: agentVoice });
    }
  } catch (e) {
    log.error('voice', 'handleNeedsInput TTS failed', { error: e.message });
  }

  broadcastToWindows('voice-task:needs-input', {
    taskId,
    agentId,
    prompt,
    options: ni.options,
    context: ni.context,
  });
}

/**
 * Route a user utterance to a pending agent that is waiting for input.
 * Returns a processSubmit-compatible result object, or null if no pending agent.
 *
 * @param {string} text         - The user's transcript
 * @param {Object} metadata     - Submission metadata (may include targetAgentId)
 * @returns {Object|null}
 */
async function routePendingInput(text, metadata) {
  const ts = getTranscriptService();
  if (!ts.hasPending()) return null;

  const pick = ts.pickPending(metadata.targetAgentId);
  if (!pick) return null;

  const { agentId, context: pendingContext } = pick;
  log.info('voice', 'Routing follow-up to pending agent', {
    agentId,
    targeted: !!metadata.targetAgentId,
  });

  const agent = allBuiltInAgentMap[agentId];
  if (!agent || !agent.execute) {
    log.warn('voice', 'Pending agent not found or has no execute()', { agentId });
    return null;
  }

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

    const result = await safeExecuteAgent(agent, followUpTask, {
      executeFn: (a, t, ctx) => executeWithInputSchema(a, t, ctx),
    });

    // Agent needs MORE input (chained multi-turn)
    if (result.needsInput) {
      // Adequacy loop: when the agent declared an adequacy block, the
      // tracker counts the user's latest answer and decides whether to
      // keep looping. If maxTurns is reached we stop even if the agent
      // keeps asking -- the tracker's fallback message surfaces so the
      // user sees why the loop ended. Wrapped in try/catch so tracker
      // failures never break the existing needs-input path.
      try {
        if (result.needsInput.adequacy) {
          const { getAdequacyTracker } = require('../../lib/exchange/adequacy-tracker');
          const tracker = getAdequacyTracker();
          tracker.increment(followUpTask.id, result.needsInput.prompt, text);
          const decision = tracker.shouldContinue(followUpTask.id, result.needsInput.adequacy.maxTurns);
          if (!decision.ok) {
            tracker.exhausted(followUpTask.id);
            const fallback = tracker.buildExhaustedResult(followUpTask.id);
            hudApi.emitResult({
              taskId: followUpTask.id,
              success: false,
              message: fallback.message,
              agentId,
              data: { adequacyExhausted: true, turns: fallback.turns, maxTurns: fallback.maxTurns },
            });
            tracker.clear(followUpTask.id);
            return {
              transcript: text,
              queued: false,
              handled: true,
              classified: true,
              action: 'adequacy-exhausted',
              message: fallback.message,
              suppressAIResponse: false,
            };
          }
        }
      } catch (_err) {
        // Adequacy tracking must never break the existing needs-input path
      }

      await handleNeedsInput(result, agentId, followUpTask.id, { html: result.html });
      return {
        transcript: text,
        queued: false,
        handled: true,
        classified: true,
        action: 'agent-input-needed',
        message: result.needsInput.prompt,
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
      } catch (_) {
        /* non-fatal */
      }
    }

    if (global.sendCommandHUDResult) {
      global.sendCommandHUDResult({
        success: true,
        message: completedMessage,
        html: result.html,
        agentId,
        agentName: agentId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
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

// ==================== RESPONSE SANITY GUARD ====================
// Cheap JavaScript checks on agent responses BEFORE TTS.
// Catches date/time hallucinations, impossible numbers, etc.
// Returns a string describing the issue, or null if response looks sane.
// ==============================================================

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

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
  const todayDatePattern =
    /today(?:\s+is|,)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})/i;
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
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Bid evaluation timeout')), BID_TIMEOUT_MS);
      }),
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
  return allBuiltInAgents.filter((agent) => {
    const isEnabled = states[agent.id] !== false;
    return isEnabled;
  });
}

/**
 * Get enabled builtin agent map
 * @returns {Object} Map of agentId -> agent for enabled agents only
 */
function _getEnabledBuiltInAgentMap() {
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
const webmcpProxyAgents = new Map(); // agentId -> { tabId, toolName, origin, registeredAt }
// pendingInputContexts removed -- state now lives in TranscriptService (lib/transcript-service.js)
let taskExecutionStartTimes = new Map(); // taskId -> startTime (for tracking execution duration)
let pendingAckTimers = new Map(); // taskId -> setTimeout handle (deferred ack, kept OUT of task.metadata to avoid JSON.stringify crash)

// Subtask system: see lib/exchange/subtask-registry.js (extracted)

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

// Conversation history, session summaries, active learning, subtask API, and
// input schema processor have been extracted to:
//   lib/exchange/conversation-history.js
//   lib/exchange/subtask-registry.js
// All functions are imported at the top of this file.

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
    maxAuctionAttempts: 2, // Quick retry
    executionTimeoutMs: 120000, // Generous base (agents manage their own via ack/heartbeat)
    ackTimeoutMs: 10000, // Agent must ack in 10s or it's dead
    heartbeatExtensionMs: 30000, // Each heartbeat grants 30s more
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

    // Inject dependencies for agents that support it
    for (const agent of enabledAgents) {
      if (agent.id === 'help-agent' && typeof agent._setDeps === 'function') {
        agent._setDeps({ getAgentList: () => getRegistryAgents() });
      }
    }

    for (const agent of enabledAgents) {
      // Validate agent contract at registration time (warn only, don't block)
      validateAgentContract(agent);

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
      ws.send(
        JSON.stringify({
          type: 'register',
          agentId: wrappedAgent.id,
          agentVersion: wrappedAgent.version,
          protocolVersion: '1.0',
          categories: wrappedAgent.categories,
          capabilities: {
            keywords: wrappedAgent.keywords,
            executionType: 'builtin',
          },
        })
      );

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
                new Promise((_, reject) => {
                  setTimeout(() => reject(new Error('Bid eval timeout')), BID_TIMEOUT_MS);
                }),
              ]);

              evaluation = {
                confidence: llmResult.confidence || 0,
                plan: llmResult.plan || llmResult.reasoning || 'LLM evaluated match',
                result: llmResult.result || null,
              };
              log.info('voice', `[BuiltIn:${wrappedAgent.name}] Bid (attempt ${attempt}):`, {
                v0: evaluation.confidence.toFixed(2),
                v1: (llmResult.reasoning || '').substring(0, 60),
              });
              break; // success
            } catch (e) {
              if (attempt === 1) {
                log.info('voice', `[BuiltIn:${wrappedAgent.name}] Bid eval attempt 1 failed, retrying:`, {
                  v0: e.message,
                });
                continue; // retry once
              }
              log.warn('voice', `[BuiltIn:${wrappedAgent.name}] Bid eval failed after 2 attempts:`, { v0: e.message });
              // Still send bid_response so exchange can count this agent as responded
              try {
                ws.send(
                  JSON.stringify({
                    type: 'bid_response',
                    auctionId: msg.auctionId,
                    agentId: wrappedAgent.id,
                    agentVersion: wrappedAgent.version,
                    bid: null,
                  })
                );
              } catch (err) {
                log.warn('exchange-bridge', 'Failed to send bid_response after eval failure', { error: err.message });
              }
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
                log.info(
                  'voice',
                  `[BuiltIn:${wrappedAgent.name}] Fast-path suppressed: executionType=${originalAgent.executionType} requires full execution`
                );
              } else {
                bidPayload.result = evaluation.result;
                log.info('voice', `[BuiltIn:${wrappedAgent.name}] Fast-path result included (risk=${risk})`);
              }
            }
            ws.send(
              JSON.stringify({
                type: 'bid_response',
                auctionId: msg.auctionId,
                agentId: wrappedAgent.id,
                agentVersion: wrappedAgent.version,
                bid: bidPayload,
              })
            );
          } else {
            ws.send(
              JSON.stringify({
                type: 'bid_response',
                auctionId: msg.auctionId,
                agentId: wrappedAgent.id,
                agentVersion: wrappedAgent.version,
                bid: null,
              })
            );
          }
        }
        // ==================== BUILT-IN AGENT EXECUTION ====================
        // Protocol: ack immediately → heartbeat if slow → result when done
        else if (msg.type === 'task_assignment') {
          log.info('voice', `[BuiltIn:${wrappedAgent.name}] Executing task: ...`, {
            v0: msg.task?.content?.slice(0, 50),
          });

          // ── ACK immediately: "I got it, I'm working on it" ──
          const estimatedMs = originalAgent.estimatedExecutionMs || 15000;
          try {
            ws.send(
              JSON.stringify({
                type: 'task_ack',
                taskId: msg.taskId,
                agentId: wrappedAgent.id,
                estimatedMs,
              })
            );
          } catch (_) {
            /* ack is best-effort */
          }

          // ── HEARTBEAT: keep-alive every 10s during long execution ──
          const execStart = Date.now();
          const heartbeatTimer = setInterval(() => {
            const elapsed = Math.round((Date.now() - execStart) / 1000);
            try {
              ws.send(
                JSON.stringify({
                  type: 'task_heartbeat',
                  taskId: msg.taskId,
                  agentId: wrappedAgent.id,
                  progress: `Still working (${elapsed}s)...`,
                })
              );
            } catch (_) {
              clearInterval(heartbeatTimer);
            }
          }, 10000);

          try {
            // Build execution context with subtask support + heartbeat
            const executionContext = {
              submitSubtask: createSubtaskSubmitter(msg.taskId, wrappedAgent.id),
              taskId: msg.taskId,
              agentId: wrappedAgent.id,
              ...(isSubtask(msg.task) ? { subtaskContext: getSubtaskContext(msg.task) } : {}),
              heartbeat: (progress) => {
                try {
                  ws.send(
                    JSON.stringify({
                      type: 'task_heartbeat',
                      taskId: msg.taskId,
                      agentId: wrappedAgent.id,
                      progress,
                    })
                  );
                } catch (_ignored) {
                  /* heartbeat best-effort */
                }
              },
            };

            if (isSubtask(msg.task)) {
              msg.task.context = {
                ...msg.task.context,
                ...getSubtaskContext(msg.task),
              };
            }

            // Execute through middleware: input normalization + error boundary + output normalization.
            // Default dropped from 60s -> 30s: when an agent hangs, the exchange cascades to the
            // backup bid, so a long timeout forces the user to wait for the first agent AND the
            // backup. 30s is plenty for API/fast-path agents; slow agents (browser automation,
            // Claude Code, etc.) set executionTimeoutMs explicitly.
            const result = await safeExecuteAgent(originalAgent, msg.task, {
              timeoutMs: originalAgent.executionTimeoutMs || 30000,
              executeFn: (agent, safeTask, ctx) => executeWithInputSchema(agent, safeTask, ctx),
              executionContext,
            });

            clearInterval(heartbeatTimer);

            // Invariant: when an agent returns `needsInput`, whatever text
            // the user HEARS (TTS via `needsInput.prompt`) must match
            // what the user SEES (`output` in the HUD text panel, chat
            // bubble, etc.). Agents occasionally return a short
            // `message` and a longer `needsInput.prompt`, causing the
            // audio and text to diverge. Force them equal here so the
            // guarantee holds system-wide, regardless of whether an
            // individual agent remembered to unify them.
            const finalOutput =
              result && result.needsInput && result.needsInput.prompt
                ? result.needsInput.prompt
                : result.message || result.result;
            ws.send(
              JSON.stringify({
                type: 'task_result',
                taskId: msg.taskId,
                result: {
                  success: result.success,
                  output: finalOutput,
                  data: result.data,
                  html: result.html,
                  error: result.success ? undefined : result.error,
                  needsInput: result.needsInput,
                },
              })
            );
          } catch (execError) {
            clearInterval(heartbeatTimer);

            // Surface rate-limit errors explicitly rather than hiding them
            const isRateLimit =
              execError.statusCode === 429 ||
              execError.message?.toLowerCase().includes('rate limit') ||
              execError.message?.toLowerCase().includes('too many requests');

            ws.send(
              JSON.stringify({
                type: 'task_result',
                taskId: msg.taskId,
                result: {
                  success: false,
                  error: isRateLimit
                    ? `Rate limit reached: ${execError.message}. Please wait a moment and try again.`
                    : execError.message,
                },
              })
            );

            if (isRateLimit) {
              log.error('voice', 'RATE LIMIT hit during agent execution', {
                agent: wrappedAgent.name,
                error: execError.message,
              });
            }
          }
        } else if (msg.type === 'ping') {
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

    ws.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : '';
      log.info('voice', 'Built-in agent disconnected: (code: )', { v0: wrappedAgent.name, v1: code });
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      const conn = localAgentConnections.get(wrappedAgent.id);

      // If a newer connection already replaced this one, don't touch the map or reconnect
      if (conn && conn.ws !== ws) {
        log.info('voice', 'Skipping reconnect (replaced by newer connection)', { v0: wrappedAgent.name });
        return;
      }
      localAgentConnections.delete(wrappedAgent.id);

      if (intentionalCloses.has(wrappedAgent.id)) {
        intentionalCloses.delete(wrappedAgent.id);
        log.info('voice', 'Skipping reconnect (intentional close)', { v0: wrappedAgent.name });
        return;
      }

      // Server closed us because a newer connection from same agent replaced us
      if (code === 1000 && reasonStr.includes('Reconnection from same agent')) {
        log.info('voice', 'Skipping reconnect (server replaced connection)', { v0: wrappedAgent.name });
        return;
      }
      // Server throttled us for reconnecting too fast
      if (code === 4008) {
        log.warn('voice', 'Skipping reconnect (throttled by server)', { v0: wrappedAgent.name });
        return;
      }

      if (!isShuttingDown) {
        const attempts = (conn?.reconnectAttempts || 0) + 1;
        if (attempts <= RECONNECT_CONFIG.maxAttempts) {
          const delay = Math.min(RECONNECT_CONFIG.baseDelayMs * Math.pow(2, attempts - 1), RECONNECT_CONFIG.maxDelayMs);
          log.info('voice', 'Reconnecting in ms (attempt /)', {
            v0: wrappedAgent.name,
            v1: delay,
            v2: attempts,
            v3: RECONNECT_CONFIG.maxAttempts,
          });
          setTimeout(async () => {
            // Guard: if another connection appeared while we waited, skip
            const current = localAgentConnections.get(wrappedAgent.id);
            if (current?.ws?.readyState === WebSocket.OPEN) return;

            try {
              await connectBuiltInAgentToExchange(wrappedAgent, currentExchangePort);
              const newConn = localAgentConnections.get(wrappedAgent.id);
              if (newConn) {
                newConn.reconnectAttempts = 0;
              }
            } catch (e) {
              log.error('voice', 'Agent reconnect failed', { agent: wrappedAgent.name, error: e.message });
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
    const enabledAgents = agents.filter((a) => a.enabled);
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
  // Validate agent contract at registration time
  validateAgentContract(agent);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    let heartbeatInterval = null;

    ws.on('open', () => {
      log.info('voice', 'Local agent connecting:', { v0: agent.name });

      // Register with exchange
      ws.send(
        JSON.stringify({
          type: 'register',
          agentId: agent.id,
          agentVersion: agent.version || '1.0.0',
          protocolVersion: '1.0',
          categories: agent.categories || ['general'],
          capabilities: {
            keywords: agent.keywords || [],
            executionType: agent.executionType || 'llm',
          },
        })
      );

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
          log.info('voice', '[Agent:${agent.name}] Received bid_request for: "..."', {
            v0: msg.task?.content?.slice(0, 50),
          });

          // Use circuit-breaker protected LLM evaluation with keyword fallback
          const evaluation = await evaluateBidWithFallback(agent, msg.task);
          const evalTime = Date.now() - startTime;

          log.info('voice', '[Agent:${agent.name}] Bid evaluation: confidence=, time=ms, fallback=', {
            v0: evaluation.confidence.toFixed(2),
            v1: evalTime,
            v2: evaluation.fallback || false,
          });

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
              },
            };
            ws.send(JSON.stringify(bidResponse));
            log.info('voice', '[Agent:${agent.name}] Submitted bid:', { v0: evaluation.confidence.toFixed(2) });
          } else {
            // Send empty bid response (declined)
            ws.send(
              JSON.stringify({
                type: 'bid_response',
                auctionId: msg.auctionId,
                agentId: agent.id,
                agentVersion: agent.version || '1.0.0',
                bid: null, // No bid - not confident
              })
            );
            log.info('voice', '[Agent:${agent.name}] Declined to bid (confidence too low)');
          }
        }
        // ==================== TASK ASSIGNMENT ====================
        // Exchange picks winner and sends 'task_assignment'
        else if (msg.type === 'task_assignment') {
          log.info('voice', '[Agent:${agent.name}] Won auction! Executing: "..."', {
            v0: msg.task?.content?.slice(0, 50),
          });

          const startTime = Date.now();
          const executionContext = {
            submitSubtask: createSubtaskSubmitter(msg.taskId, agent.id),
            taskId: msg.taskId,
            agentId: agent.id,
            ...(isSubtask(msg.task) ? { subtaskContext: getSubtaskContext(msg.task) } : {}),
          };

          if (isSubtask(msg.task)) {
            msg.task.context = {
              ...msg.task.context,
              ...getSubtaskContext(msg.task),
            };
          }

          // Execute through middleware: input normalization + error boundary + output normalization
          const result = await safeExecuteAgent(agent, msg.task, {
            executeFn: (a, t, ctx) => executeLocalAgent(a, t, ctx),
            executionContext,
          });
          const execTime = Date.now() - startTime;

          log.info('voice', '[Agent:${agent.name}] Execution complete: success=, time=ms', {
            v0: result.success,
            v1: execTime,
          });

          // Same invariant as the built-in path above: displayed text
          // must match spoken text when needsInput is set.
          const localOutput =
            result && result.needsInput && result.needsInput.prompt
              ? result.needsInput.prompt
              : result.message || result.result || result.error;
          ws.send(
            JSON.stringify({
              type: 'task_result',
              taskId: msg.taskId,
              result: {
                success: result.success,
                output: localOutput,
                html: result.html,
                error: result.success ? undefined : result.error,
                needsInput: result.needsInput,
              },
            })
          );
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

    ws.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : '';
      log.info('voice', 'Local agent disconnected: (code: )', { v0: agent.name, v1: code });
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      const conn = localAgentConnections.get(agent.id);

      // If a newer connection already replaced this one, don't touch the map or reconnect
      if (conn && conn.ws !== ws) {
        log.info('voice', 'Skipping reconnect (replaced by newer connection)', { v0: agent.name });
        return;
      }
      localAgentConnections.delete(agent.id);

      if (intentionalCloses.has(agent.id)) {
        intentionalCloses.delete(agent.id);
        log.info('voice', 'Skipping reconnect (intentional close)', { v0: agent.name });
        return;
      }

      // Server closed us because a newer connection from same agent replaced us
      if (code === 1000 && reasonStr.includes('Reconnection from same agent')) {
        log.info('voice', 'Skipping reconnect (server replaced connection)', { v0: agent.name });
        return;
      }
      // Server throttled us for reconnecting too fast
      if (code === 4008) {
        log.warn('voice', 'Skipping reconnect (throttled by server)', { v0: agent.name });
        return;
      }

      if (!isShuttingDown && agent.enabled !== false) {
        const attempts = (conn?.reconnectAttempts || 0) + 1;
        if (attempts <= RECONNECT_CONFIG.maxAttempts) {
          const delay = Math.min(RECONNECT_CONFIG.baseDelayMs * Math.pow(2, attempts - 1), RECONNECT_CONFIG.maxDelayMs);
          log.info('voice', 'Reconnecting in ms (attempt /)', {
            v0: agent.name,
            v1: delay,
            v2: attempts,
            v3: RECONNECT_CONFIG.maxAttempts,
          });
          setTimeout(async () => {
            // Guard: if another connection appeared while we waited, skip
            const current = localAgentConnections.get(agent.id);
            if (current?.ws?.readyState === WebSocket.OPEN) return;

            try {
              await connectLocalAgent(agent, currentExchangePort);
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

// ==================== LOCAL AGENT MEMORY CACHE ====================
// Keeps loaded AgentMemoryStore instances so we don't re-init on every task.
const _localAgentMemories = new Map();

/**
 * Execute a local (custom) agent's task.
 *
 * First-class features (matching built-in agents):
 *  - Centralized AI service (ai.chat) instead of CLI spawns
 *  - Conversation history for multi-turn context
 *  - Thinking-agent memory (learned preferences, history)
 *  - Subtask support via executionContext
 *  - Multi-turn clarification via needsInput
 *  - Declarative UI rendering for uiCapable agents
 */
async function executeLocalAgent(agent, task, _executionContext = {}) {
  const executionType = agent.executionType || 'llm';
  const content = task.content || '';
  const memoryEnabled = agent.memory?.enabled === true;
  const featureTag = `agent:${agent.id || agent.name}`;

  try {
    // ── 1. Initialize memory (if enabled) ───────────────────────────
    let memory = null;
    let preferences = {};

    if (memoryEnabled) {
      const { getAgentMemory } = require('../../lib/agent-memory-store');
      if (!_localAgentMemories.has(agent.id)) {
        const mem = getAgentMemory(agent.id, { displayName: agent.name });
        await mem.load();

        // Ensure configured sections exist
        const desiredSections = agent.memory?.sections || ['Learned Preferences'];
        for (const section of desiredSections) {
          if (!mem.getSectionNames().includes(section)) {
            mem.updateSection(section, '');
          }
        }
        if (mem.isDirty()) await mem.save();

        _localAgentMemories.set(agent.id, mem);
      }
      memory = _localAgentMemories.get(agent.id);
      preferences = memory.parseSectionAsKeyValue('Learned Preferences') || {};
    }

    // ── 2. Handle pending conversation state (multi-turn) ───────────
    if (task.context?.pendingState === 'awaiting_clarification' && agent.multiTurn) {
      // The user answered a clarification question – fold it into preferences
      if (task.context?.clarifyingField && memory) {
        const value = task.context?.userInput || content;
        preferences[task.context.clarifyingField] = value;
        memory.updateSectionAsKeyValue('Learned Preferences', preferences);
        await memory.save();
      }
      // Fall through to execute with the updated preferences
    }

    // ── 3. Build system prompt with preferences context ─────────────
    let systemPrompt = agent.prompt || '';

    // Voice orb requests get compressed-speech instructions
    if (task.metadata?.source === 'orb') {
      systemPrompt += '\n\nResponse style: compressed speech. No greetings, no filler, no hedging. Data first. '
        + 'Never start with "Sure", "Of course", "I\'d be happy to". '
        + 'Never end with "Let me know if you need anything else". '
        + 'Example good response: "3 emails, 1 urgent from Sarah re: deadline. Calendar clear until 2."';
    }

    if (memoryEnabled && Object.keys(preferences).length > 0) {
      const prefLines = Object.entries(preferences)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join('\n');
      systemPrompt += `\n\nUser preferences (remembered from past interactions):\n${prefLines}`;
    }

    // ── 4. Build conversation messages ──────────────────────────────
    const history = getRecentHistory();
    const historyMessages = history.map((turn) => ({
      role: turn.role === 'user' ? 'user' : 'assistant',
      content: turn.content,
    }));

    // ── 5. Execute by type ──────────────────────────────────────────
    let execResult;

    if (executionType === 'applescript') {
      const sysPrompt = `${systemPrompt}\n\nYou generate AppleScript code. Return ONLY the AppleScript code to execute. No explanation, no markdown fences.`;
      const messages = [...historyMessages, { role: 'user', content: `User command: "${content}"` }];

      const result = await ai.chat({
        profile: 'fast',
        system: sysPrompt,
        messages,
        maxTokens: 1024,
        temperature: 0.3,
        feature: featureTag,
      });

      let script = (result.content || '').trim();
      const codeMatch = script.match(/```(?:applescript)?\n?([\s\S]*?)```/);
      if (codeMatch) script = codeMatch[1].trim();

      const escapedScript = script.replace(/'/g, "'\"'\"'");
      const { stdout } = await execAsync(`osascript -e '${escapedScript}'`, { timeout: 10000 });

      execResult = { success: true, result: stdout || 'Command executed' };
    } else if (executionType === 'shell') {
      const sysPrompt = `${systemPrompt}\n\nYou generate shell commands. Return ONLY the shell command to execute. No explanation, no markdown fences.`;
      const messages = [...historyMessages, { role: 'user', content: `User command: "${content}"` }];

      const result = await ai.chat({
        profile: 'fast',
        system: sysPrompt,
        messages,
        maxTokens: 512,
        temperature: 0.2,
        feature: featureTag,
      });

      let command = (result.content || '').trim();
      const codeMatch = command.match(/```(?:bash|sh)?\n?([\s\S]*?)```/);
      if (codeMatch) command = codeMatch[1].trim();

      const { stdout } = await execAsync(command, { timeout: 10000 });
      execResult = { success: true, result: stdout || 'Command executed' };
    } else if (agent.tools && agent.tools.length > 0) {
      // LLM with tool calling -- agent declared tool dependencies
      const { resolveTools, createToolDispatcher } = require('../../lib/agent-tools');
      const resolved = resolveTools(agent.tools);

      if (resolved.length > 0) {
        const dispatcher = createToolDispatcher(resolved);
        const messages = [...historyMessages, { role: 'user', content }];

        const result = await ai.chatWithTools({
          profile: 'standard',
          system: systemPrompt,
          messages,
          tools: resolved,
          onToolCall: dispatcher,
          maxTokens: 2048,
          temperature: 0.7,
          feature: featureTag,
          maxToolRounds: 10,
          onProgress: ({ toolName }) => {
            log.info('voice', `[${agent.name}] Tool call: ${toolName}`);
          },
        });

        const response = (result.content || '').trim();
        execResult = { success: true, result: response, toolCallLog: result.toolCallLog };
      } else {
        // Tools declared but none resolved -- fall through to plain LLM
        const messages = [...historyMessages, { role: 'user', content }];
        const result = await ai.chat({
          profile: 'standard', system: systemPrompt, messages,
          maxTokens: 2048, temperature: 0.7, feature: featureTag,
        });
        execResult = { success: true, result: (result.content || '').trim() };
      }
    } else {
      // LLM / conversational (no tools)
      const messages = [...historyMessages, { role: 'user', content }];

      const result = await ai.chat({
        profile: 'standard',
        system: systemPrompt,
        messages,
        maxTokens: 2048,
        temperature: 0.7,
        feature: featureTag,
      });

      const response = (result.content || '').trim();

      // Detect declarative UI JSON (uiCapable agents)
      let html;
      if (agent.uiCapable && response) {
        try {
          const jsonMatch = response.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || [null, response];
          const parsed = JSON.parse(jsonMatch[1]);
          if (parsed && parsed.type) {
            const { renderAgentUI } = require('../../lib/agent-ui-renderer');
            html = renderAgentUI(parsed);
          }
        } catch (_) {
          /* Not JSON UI -- fall through to plain text */
        }
      }

      execResult = { success: true, result: response, html };
    }

    // ── 6. Learn from interaction (memory) ──────────────────────────
    if (memoryEnabled && memory) {
      try {
        const { learnFromInteraction } = require('../../lib/thinking-agent');
        await learnFromInteraction(
          memory,
          task,
          {
            success: execResult.success,
            message: execResult.result,
          },
          {}
        );
      } catch (learnErr) {
        log.warn('voice', 'Agent learning failed', { agent: agent.name, error: learnErr.message });
      }
    }

    return execResult;
  } catch (error) {
    log.error('voice', 'Agent execution error', { agent: agent.name, error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * Get custom agents that can contribute to daily briefings.
 * Called by the daily-brief-agent alongside getBriefingAgents() from the registry.
 *
 * Returns objects with a `getBriefing()` method that uses the agent's
 * `briefing.prompt` config to generate a section for the morning brief.
 */
function getCustomBriefingAgents() {
  try {
    const { getAgentStore } = require('./agent-store');
    const store = getAgentStore();
    if (!store || !store.initialized) return [];

    return store
      .getEnabledLocalAgents()
      .filter((a) => a.briefing?.enabled && a.briefing?.section && a.briefing?.prompt)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        estimatedExecutionMs: agent.estimatedExecutionMs || 5000,
        async getBriefing() {
          try {
            const result = await ai.chat({
              profile: 'fast',
              system: agent.prompt,
              messages: [{ role: 'user', content: agent.briefing.prompt }],
              maxTokens: 512,
              temperature: 0.5,
              feature: `briefing:${agent.id}`,
            });
            return {
              section: agent.briefing.section,
              priority: agent.briefing.priority || 5,
              content: (result.content || '').trim(),
            };
          } catch (err) {
            log.warn('voice', 'Custom agent briefing failed', { agent: agent.name, error: err.message });
            return null;
          }
        },
      }));
  } catch (err) {
    log.warn('voice', 'Could not load custom briefing agents', { error: err.message });
    return [];
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
  const garbledWords = words.filter((w) => w.length > 3 && uncommonPatterns.test(w));
  if (garbledWords.length > words.length / 2) return true;

  return false;
}

/**
 * Get suggestions for what the user might have meant
 */
/**
 * Generate clarification options using LLM.
 * Called when no agent bids or all bids are too low.
 * Phase 1: Classify as rephrase or capability_gap.
 * Phase 2 (gap only): Generate a build proposal with effort, cost, and integrations.
 */
async function generateClarificationOptions(content, agentDescriptions) {
  if (!content) return [];

  try {
    const agentList = agentDescriptions.map((a) => `- ${a.name}: ${a.description}`).join('\n');
    const prompt = `The user said: "${content}"

No agent was confident enough to handle this request. Every agent either declined or bid with very low confidence. The available agents are:
${agentList}

Classify this situation:
- "rephrase": The request is genuinely ambiguous and rephrasing would help an existing agent handle it.
- "capability_gap": No existing agent covers this domain, OR an agent SHOULD handle it but consistently fails to. If the right agent exists but still could not handle this simple request, classify as capability_gap.

Respond with JSON:
{
  "classification": "rephrase" | "capability_gap",
  "gapSummary": "If capability_gap: one-sentence description of what capability is missing or broken"
}

Be honest. If the request is clear and straightforward but no agent picked it up, that is a capability_gap, not a rephrase.`;

    const parsed = await ai.json(prompt, {
      profile: 'fast',
      temperature: 0,
      maxTokens: 150,
      feature: 'exchange-bridge',
    });

    const classification = parsed.classification || 'rephrase';
    const gapSummary = parsed.gapSummary || null;

    if (classification === 'capability_gap' && gapSummary) {
      return _buildCapabilityGapResponse(content, gapSummary, agentList);
    }

    // Rephrase path -- generate rephrased options
    return _buildRephraseResponse(content, agentList);
  } catch (err) {
    log.warn('voice', 'LLM disambiguation failed', { data: err.message });
    return {
      classification: 'rephrase',
      question: "I'm not sure what you meant. Could you rephrase that?",
      options: [],
      gapSummary: null,
      buildProposal: null,
    };
  }
}

/**
 * Rephrase path: suggest how to reword the request to match existing agents.
 */
async function _buildRephraseResponse(content, agentList) {
  try {
    const result = await ai.json(
      `The user said: "${content}"
This request might be handleable by an existing agent but was ambiguous.

Available agents:
${agentList}

Generate 2-4 rephrased options that map to existing agent capabilities.
Respond with JSON:
{
  "question": "Brief question asking what they meant",
  "options": [{ "label": "Short label", "description": "Brief clarification" }]
}`,
      { profile: 'fast', temperature: 0.3, maxTokens: 250, feature: 'exchange-bridge' }
    );
    return {
      classification: 'rephrase',
      question: result.question || 'What did you mean?',
      options: [
        ...(result.options || []).slice(0, 3),
        { label: 'Build an agent for this', description: `Create a new agent to handle "${content.slice(0, 60)}"`, action: 'create-agent', gapDescription: content },
      ],
      gapSummary: null,
      buildProposal: null,
    };
  } catch {
    return {
      classification: 'rephrase',
      question: "I'm not sure what you meant. Could you rephrase that?",
      options: [
        { label: 'Build an agent for this', description: `Create a new agent to handle this request`, action: 'create-agent', gapDescription: content },
      ],
      gapSummary: null,
      buildProposal: null,
    };
  }
}

/**
 * Capability gap path: generate a build proposal with effort, cost, integration, and playbook offer.
 */
async function _buildCapabilityGapResponse(content, gapSummary, agentList) {
  const TOOL_LIST = [
    'shell_exec -- run system commands',
    'file_read / file_write -- local file access',
    'web_search -- real-time web search',
    'spaces_search / spaces_add_item -- content storage (Spaces API)',
    'get_current_time -- system clock',
  ].join('\n    ');

  const AI_PROFILES = [
    'fast (Haiku ~$0.0002/call) -- quick classification, routing',
    'standard (Sonnet ~$0.003/call) -- general reasoning, composition',
    'powerful (Opus ~$0.02/call) -- deep multi-step reasoning',
    'vision (Sonnet) -- image analysis',
    'embedding (text-embedding-3-small ~$0.00002/call) -- semantic search',
    'transcription (whisper-1 ~$0.006/min) -- audio-to-text',
  ].join('\n    ');

  const INTEGRATIONS = [
    'Calendar (Google Calendar API via calendar-data.js)',
    'Email (mailto: via shell open)',
    'Browser automation (Playwright via browser-agent)',
    'Web browsing (native Electron BrowserWindow via browsing-agent)',
    'ElevenLabs (TTS + sound generation)',
    'Spaces storage (clipboard-storage-v2)',
    'Voice pipeline (speech recognition, TTS, voice orb)',
    'File conversion (lib/convert-service.js)',
    'Screen capture (lib/screen-service.js)',
  ].join('\n    ');

  try {
    const result = await ai.json(
      `A user asked: "${content}"
No existing agent can handle this. The missing capability is: "${gapSummary}"

Here is the system this agent would be built in:

EXISTING AGENTS:
${agentList}

AVAILABLE TOOLS:
    ${TOOL_LIST}

AI PROFILES (with approximate per-call cost):
    ${AI_PROFILES}

AVAILABLE INTEGRATIONS:
    ${INTEGRATIONS}

Generate a build proposal. Respond with JSON:
{
  "effort": "small" | "medium" | "large",
  "effortDescription": "1-sentence justification of effort level",
  "estimatedCalls": {
    "fast": 0,
    "standard": 0,
    "powerful": 0
  },
  "estimatedCostPerUse": "$X.XX",
  "integration": "Name of the primary existing integration or system this agent would connect to",
  "integrationDetail": "1-sentence on how it would integrate",
  "tools": ["tool names from the list above that the agent would need"],
  "spokenSummary": "2-3 sentence spoken response to the user. Acknowledge the gap, state the effort and cost, name the integration, and offer to create a build playbook. Be conversational, not robotic."
}

Effort guide:
- small: Single LLM call, no external API, <50 lines. Example: a formatting agent.
- medium: 1-3 LLM calls, one external API or tool, 50-200 lines. Example: a weather agent.
- large: Multiple LLM calls, orchestration, external APIs, >200 lines. Example: a browser automation agent.

Cost guide: estimate calls PER INVOCATION (not build cost). fast=$0.0002, standard=$0.003, powerful=$0.02.`,
      { profile: 'fast', temperature: 0.3, maxTokens: 500, feature: 'exchange-bridge-proposal' }
    );

    const proposal = {
      effort: result.effort || 'medium',
      effortDescription: result.effortDescription || '',
      estimatedCalls: result.estimatedCalls || { fast: 1, standard: 1, powerful: 0 },
      estimatedCostPerUse: result.estimatedCostPerUse || '~$0.01',
      integration: result.integration || 'None',
      integrationDetail: result.integrationDetail || '',
      tools: result.tools || [],
      spokenSummary: result.spokenSummary || '',
    };

    const question =
      proposal.spokenSummary ||
      `I don't have that ability yet. Building it would be a ${proposal.effort} effort at about ${proposal.estimatedCostPerUse} per use, integrating with ${proposal.integration}. Want me to create a build playbook?`;

    return {
      classification: 'capability_gap',
      question,
      options: [
        { label: 'Create a build playbook', description: `Generate a step-by-step playbook to build an agent for: ${gapSummary}` },
        { label: 'Build it now', description: `Open Agent Composer to build: ${gapSummary}` },
        { label: 'Add to wishlist', description: 'Note this for later and move on' },
      ],
      gapSummary,
      buildProposal: proposal,
    };
  } catch (proposalErr) {
    log.warn('voice', 'Build proposal generation failed, using minimal gap response', { error: proposalErr.message });
    return {
      classification: 'capability_gap',
      question: `I don't have that ability yet, but I could build it. Want me to create a playbook or build the agent now?`,
      options: [
        { label: 'Create a build playbook', description: `Generate a playbook for: ${gapSummary}` },
        { label: 'Build it now', description: `Open Agent Composer to build: ${gapSummary}` },
        { label: 'Add to wishlist', description: 'Note this for later' },
      ],
      gapSummary,
      buildProposal: null,
    };
  }
}

// ==================== CAPABILITY GAP PERSISTENCE ====================
const WISHLIST_SPACE_ID = 'capability-wishlist';
const WISHLIST_SPACE_NAME = 'Capability Wishlist';

/**
 * Log a capability gap to the Capability Wishlist space.
 * Creates the space if it doesn't exist.
 */
async function _logCapabilityGap(spacesApi, userRequest, gapSummary, buildProposal) {
  if (!spacesApi) return;

  const storage = spacesApi.storage || spacesApi._storage;
  if (!storage) return;

  // Find or create the wishlist space
  const spaces = storage.index?.spaces || [];
  let space = spaces.find((s) => s.id === WISHLIST_SPACE_ID);
  if (!space) {
    space = storage.createSpace({
      id: WISHLIST_SPACE_ID,
      name: WISHLIST_SPACE_NAME,
      icon: '●',
      color: '#f59e0b',
      isSystem: true,
    });
    log.info('voice', 'Created Capability Wishlist space');
  }

  // Check for duplicate requests (same gap summary in last 50 items)
  const existingItems = (storage.index?.items || [])
    .filter((i) => i.spaceId === WISHLIST_SPACE_ID)
    .slice(-50);
  const isDuplicate = existingItems.some(
    (i) => i.content && i.content.includes(gapSummary)
  );
  if (isDuplicate) {
    log.info('voice', 'Capability gap already on wishlist, skipping duplicate');
    return;
  }

  const lines = [
    `**Request:** "${userRequest}"`,
    `**Gap:** ${gapSummary}`,
    `**Date:** ${new Date().toLocaleDateString()}`,
    `**Status:** New`,
  ];

  if (buildProposal) {
    lines.push('');
    lines.push(`**Effort:** ${buildProposal.effort} -- ${buildProposal.effortDescription || ''}`);
    lines.push(`**Est. cost/use:** ${buildProposal.estimatedCostPerUse || '~$0.01'}`);
    lines.push(`**Integration:** ${buildProposal.integration || 'None'} -- ${buildProposal.integrationDetail || ''}`);
    if (buildProposal.tools?.length) {
      lines.push(`**Tools:** ${buildProposal.tools.join(', ')}`);
    }
    if (buildProposal.estimatedCalls) {
      const calls = buildProposal.estimatedCalls;
      const parts = [];
      if (calls.fast) parts.push(`${calls.fast} fast`);
      if (calls.standard) parts.push(`${calls.standard} standard`);
      if (calls.powerful) parts.push(`${calls.powerful} powerful`);
      if (parts.length) lines.push(`**LLM calls/use:** ${parts.join(', ')}`);
    }
  }

  const entry = lines.join('\n');

  storage.addItem({
    type: 'text',
    content: entry,
    spaceId: WISHLIST_SPACE_ID,
    timestamp: Date.now(),
    metadata: {
      title: gapSummary,
      userRequest,
      gapSummary,
      status: 'new',
      buildProposal: buildProposal || null,
    },
  });

  log.info('voice', 'Logged capability gap to wishlist', { gap: gapSummary });
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

  // Fast-path: requests that have dedicated orchestrator agents should NEVER be decomposed.
  // The daily-brief-agent already calls weather, calendar, email, etc. internally.
  const lower = content.toLowerCase();
  if (
    lower.includes('brief') ||
    lower.includes('briefing') ||
    lower.includes('morning report') ||
    lower.includes('daily update') ||
    lower.includes('daily rundown') ||
    lower.includes('catch me up') ||
    lower.includes("what's happening today") ||
    lower.includes('start my day')
  ) {
    return { isComposite: false, subtasks: [] };
  }

  try {
    const prompt = `Analyze whether this user request contains MULTIPLE INDEPENDENT tasks that should be handled separately by different agents.

User request: "${content}"

Rules:
- Only decompose if there are genuinely SEPARATE tasks (e.g. "play music and check my calendar")
- Do NOT decompose a single complex task (e.g. "schedule a meeting with John tomorrow at 3pm" is ONE task)
- Do NOT decompose if the parts depend on each other (e.g. "check if I'm free and then schedule" is sequential, not parallel)
- Do NOT decompose daily briefs, morning updates, or "catch me up" requests -- these are handled by a dedicated orchestrator that internally gathers weather, calendar, email, etc.
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
      feature: 'exchange-bridge',
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
async function _handleMediaCommand(text, transcript) {
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
    if (
      text.includes('music') ||
      text.includes('song') ||
      text.includes('something') ||
      text.match(/^play\s*$/) ||
      text.match(/play\s+(now|please|it)/)
    ) {
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
    } else if (
      text.includes('down') ||
      text.includes('quieter') ||
      text.includes('decrease') ||
      text.includes('lower')
    ) {
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
        await new Promise((r) => {
          setTimeout(r, 2000);
        }); // Wait for app to launch
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
  BrowserWindow.getAllWindows().forEach((win) => {
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
    if (getTranscriptService().hasPending()) {
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
    } catch (_e) {
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
        try {
          return await masterOrchestrator.evaluate(task, bids);
        } catch (_e) {
          log.error('voice', 'Master Orchestrator evaluation failed, falling back to rank order', { error: _e.message });
          return null;
        }
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

    // Inject exchange instance into extracted modules
    setSubtaskExchange(exchangeInstance);
    setSubtaskBroadcast(broadcastToWindows);
    setOnTimeoutClear(() => {
      if (!getTranscriptService().hasPending()) {
        summarizeAndArchiveSession().catch((e) =>
          log.warn('voice', '[SessionSummary] Error during archive', { data: e.message })
        );
        clearHistory();
      }
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

    // Register bridge functions on the shared event bus (decouples from hud-api)
    exchangeBus.registerBridge({
      processSubmit,
      getExchange,
      cancelTask: (taskId) => exchangeInstance?.cancelTask?.(taskId),
      getQueueStats: () => exchangeInstance?.getStats?.() || {},
    });

    // Listen for agent lifecycle events from agent-store (decoupled via event bus)
    exchangeBus.on('agent:hot-connect', async (agent) => {
      try {
        await hotConnectAgent(agent);
      } catch (e) {
        log.warn('voice', 'Hot-connect via event bus failed', { agent: agent?.name, error: e.message });
      }
    });
    exchangeBus.on('agent:disconnect', (agentId) => {
      try {
        disconnectAgent(agentId);
      } catch (e) {
        log.warn('voice', 'Disconnect via event bus failed', { agentId, error: e.message });
      }
    });

    // ---------------------------------------------------------------------
    // Agent-builder progress: surface "Designing the agent..." / "Writing..."
    // status while Claude Code is building a new agent in the background.
    // The current command HUD entry is updated in-place so the user sees
    // real progress instead of a silent ~40-second gap.
    // ---------------------------------------------------------------------
    exchangeBus.on('agent-builder:progress', (evt) => {
      try {
        const stageToMessage = {
          start: 'Building agent...',
          plan: 'Designing the agent...',
          generate: 'Writing the agent...',
          save: 'Saving and registering...',
          done: 'Agent ready.',
          failed: 'Agent build failed',
        };
        const message = stageToMessage[evt && evt.stage] || (evt && evt.message) || null;
        if (!message) return;
        if (global.showCommandHUD) {
          global.showCommandHUD({
            id: `agent-builder:${Date.now()}`,
            transcript: evt && evt.originalRequest ? evt.originalRequest : message,
            status: 'processing',
            message,
          });
        }
        // Also publish as a lifecycle event so any tool listening can react.
        hudApi.emitLifecycle({
          type: 'agent-builder:progress',
          stage: evt && evt.stage,
          message,
          originalRequest: evt && evt.originalRequest,
        });
      } catch (err) {
        log.warn('voice', 'agent-builder:progress forwarding failed', { error: err.message });
      }
    });

    // Initialize centralized HUD API (uses event bus, no direct bridge reference needed)
    hudApi.initialize();

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
    log.info('voice', 'Agent health check enabled (every ' + HEALTH_CHECK_INTERVAL_MS / 1000 + 's)');

    // Restore conversation state from previous session (non-blocking)
    restoreConversationState().catch((e) =>
      log.warn('voice', '[ExchangeBridge] Conversation restore error', { data: e.message })
    );

    // Pre-load user profile so it's ready for first request
    getUserProfile()
      .load()
      .then(async () => {
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
              const greeting =
                "Welcome! I don't know anything about you yet. Tell me your name and a little about yourself -- like where you live or how you'd like me to help -- and I'll remember it for next time.";
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
      })
      .catch((e) => log.warn('voice', '[ExchangeBridge] User profile load error', { data: e.message }));

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
        message: "I don't have an agent for that yet. You can say \"build an agent\" to create one, or I've added it to the wishlist.",
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
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Filter timeout')), 5000);
          }),
        ]);
        isGarbled = !filterResult.pass;
        if (isGarbled) {
          log.info('voice', 'Halt handler: transcript rejected by filter:', { v0: filterResult.reason });
        }
      } catch (_e) {
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
        } catch (_e) {
          /* non-fatal */
        }
      } else {
        // Task was clear but no agent can handle it -- route to agent-builder-agent
        // for a conversational feasibility assessment instead of generic disambiguation
        log.info('voice', 'No agents for task, routing to agent-builder-agent');

        const rephraseAttempts = task.metadata?.rephraseAttempts || 0;

        // Loop guard: if this task was auto-retried after a just-built agent
        // and STILL no one can handle it, don't offer to build yet another
        // agent. Tell the user honestly that the build didn't produce a
        // working match and let them try a different phrasing instead.
        if (task.metadata?.retriedAfterBuild) {
          const loopMsg =
            "I built a new agent but it still couldn't match your request. " +
            "Try rephrasing what you want, or open the Agent Manager to review the new agent.";
          addToHistory('assistant', loopMsg, 'system');
          hudApi.emitResult({
            taskId: task.id,
            success: false,
            message: loopMsg,
            agentId: 'system',
            needsClarification: true,
          });
          try {
            const { getVoiceSpeaker } = require('../../voice-speaker');
            const speaker = getVoiceSpeaker();
            if (speaker) await speaker.speak(loopMsg, { voice: 'sage' });
          } catch (_e) { /* non-fatal */ }
          clearTimeout(safetyTimer);
          return;
        }

        // Quick classification: is this a rephrase or a genuine capability gap?
        const { getAllAgents } = require('../../packages/agents/agent-registry');
        const agents = getAllAgents().filter((a) => !a.bidExcluded);
        const agentDescriptions = agents.map((a) => ({ name: a.name, description: a.description }));

        let classification = 'capability_gap';
        let gapSummary = content;
        try {
          const classResult = await Promise.race([
            ai.json(
              `The user said: "${content}"
No agent was confident enough to handle this. Available agents:
${agentDescriptions.map((a) => `- ${a.name}: ${a.description}`).join('\n')}

Classify: "rephrase" (ambiguous, rephrasing would help) or "capability_gap" (no agent covers this).
Return JSON: { "classification": "rephrase" | "capability_gap", "gapSummary": "one-sentence description of what's missing" }`,
              { profile: 'fast', temperature: 0, maxTokens: 100, feature: 'exchange-bridge' },
            ),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
          ]);
          classification = classResult.classification || 'capability_gap';
          gapSummary = classResult.gapSummary || content;
        } catch (_e) {
          // Default to capability_gap -- agent-builder-agent handles both well
        }

        if (classification === 'rephrase' && rephraseAttempts < 2) {
          // Rephrase path -- use the existing rephrase flow
          let rephraseResponse;
          try {
            rephraseResponse = await _buildRephraseResponse(content, agentDescriptions.map((a) => `- ${a.name}: ${a.description}`).join('\n'));
          } catch (_e) {
            rephraseResponse = {
              classification: 'rephrase',
              question: "I'm not sure what you meant. Could you rephrase that?",
              options: [],
            };
          }

          const clarificationMessage = rephraseResponse.question || "Could you rephrase that?";
          addToHistory('assistant', clarificationMessage, 'system');

          hudApi.emitResult({
            taskId: task.id,
            success: false,
            message: clarificationMessage,
            agentId: 'system',
            needsClarification: true,
          });

          if (rephraseResponse.options?.length > 0) {
            broadcastToWindows('voice-task:disambiguation', {
              taskId: task.id,
              question: clarificationMessage,
              options: rephraseResponse.options,
              rephraseAttempts,
            });
            hudApi.emitDisambiguation({
              taskId: task.id,
              question: clarificationMessage,
              options: rephraseResponse.options,
            });
          }

          try {
            const { getVoiceSpeaker } = require('../../voice-speaker');
            const speaker = getVoiceSpeaker();
            if (speaker) await speaker.speak(clarificationMessage, { voice: 'sage' });
          } catch (_e) { /* non-fatal */ }
        } else {
          // Capability gap -- route directly to agent-builder-agent for a
          // conversational feasibility assessment instead of generic buttons
          log.info('voice', 'Capability gap detected, handing off to agent-builder-agent', {
            request: content.slice(0, 80),
            gap: gapSummary,
          });

          // Persist the gap to wishlist (non-blocking)
          try {
            const { getSpacesAPI } = require('../../spaces-api');
            const spacesApi = getSpacesAPI();
            _logCapabilityGap(spacesApi, content, gapSummary, null).catch(() => {});
          } catch (_e) { /* non-fatal */ }

          // Emit for agent learning system
          try {
            exchangeBus.emit('learning:capability-gap', {
              userInput: content,
              gapSummary,
              timestamp: Date.now(),
            });
          } catch (_e) { /* non-critical */ }

          // Execute agent-builder-agent directly with gap context
          try {
            const builderAgent = agents.find((a) => a.id === 'agent-builder-agent');
            if (builderAgent) {
              if (builderAgent.initialize) await builderAgent.initialize();
              const result = await Promise.race([
                builderAgent.execute({
                  content,
                  metadata: {
                    capabilityGap: gapSummary,
                    originalRequest: content,
                    source: 'exchange-halt',
                  },
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Builder agent timeout')), 10000)),
              ]);

              const message = result.message || "I can look into building an agent for that. Want me to open WISER Playbooks and draft a plan?";
              addToHistory('assistant', message, 'agent-builder-agent');

              hudApi.emitResult({
                taskId: task.id,
                success: true,
                message,
                agentId: 'agent-builder-agent',
                needsClarification: !!result.needsInput,
                needsInput: result.needsInput || null,
              });

              // Speak the response
              try {
                const { getVoiceSpeaker } = require('../../voice-speaker');
                const speaker = getVoiceSpeaker();
                if (speaker) await speaker.speak(message, { voice: 'sage' });
              } catch (_e) { /* non-fatal */ }
            } else {
              // agent-builder-agent not loaded -- fall back to generic message
              const fallbackMsg = `I don't have an agent for that yet, but I could build one. Say "build an agent" to get started.`;
              addToHistory('assistant', fallbackMsg, 'system');
              hudApi.emitResult({
                taskId: task.id,
                success: false,
                message: fallbackMsg,
                agentId: 'system',
                needsClarification: true,
              });
              try {
                const { getVoiceSpeaker } = require('../../voice-speaker');
                const speaker = getVoiceSpeaker();
                if (speaker) await speaker.speak(fallbackMsg, { voice: 'sage' });
              } catch (_e) { /* non-fatal */ }
            }
          } catch (builderErr) {
            log.warn('voice', 'Agent-builder-agent failed, using fallback', { error: builderErr.message });
            const fallbackMsg = `I can't handle that yet, but it might be buildable. Say "build an agent" and I'll assess what's needed.`;
            addToHistory('assistant', fallbackMsg, 'system');
            hudApi.emitResult({
              taskId: task.id,
              success: false,
              message: fallbackMsg,
              agentId: 'system',
              needsClarification: true,
            });
            try {
              const { getVoiceSpeaker } = require('../../voice-speaker');
              const speaker = getVoiceSpeaker();
              if (speaker) await speaker.speak(fallbackMsg, { voice: 'sage' });
            } catch (_e) { /* non-fatal */ }
          }
        }
      }

      clearTimeout(safetyTimer); // Disambiguation succeeded, cancel safety net
    } catch (haltError) {
      clearTimeout(safetyTimer);
      log.error('voice', 'Exchange:halt handler crashed', { error: haltError.message });
      // Ensure user always gets a response
      hudApi.emitResult({
        taskId: task.id,
        success: false,
        message: 'Something went wrong. Could you try again?',
        agentId: 'error-agent',
      });
    }
  });

  // Task assigned to winner
  exchangeInstance.on('task:assigned', async ({ task, winner, backups, masterEvaluation }) => {
    log.info('voice', 'Task assigned to', { agentId: winner.agentId });

    // Store master evaluation in task metadata for feedback phase
    if (masterEvaluation) {
      task.metadata = task.metadata || {};
      task.metadata.masterEvaluation = masterEvaluation;
      log.info('voice', 'Master evaluation stored', { reasoning: masterEvaluation.reasoning });
    }

    // Store assigned agent details for diagnostic use if the task later fails
    try {
      const { getAgent } = require('../../packages/agents/agent-registry');
      const assignedAgent = getAgent(winner.agentId);
      task.metadata = task.metadata || {};
      task.metadata.agentName = assignedAgent?.name || winner.agentName || winner.agentId;
      task.metadata.agentExecutionType = assignedAgent?.executionType || 'action';
      if (assignedAgent?.prompt) {
        task.metadata.agentPrompt = assignedAgent.prompt.substring(0, 500);
      }
    } catch (_ignored) { /* best-effort */ }

    // Track execution start time for duration calculation
    taskExecutionStartTimes.set(task.id, Date.now());

    // ==================== HANDOFF BRIDGE ====================
    // Built for multi-voice mode (bridge phrase in outgoing agent's
    // voice before the incoming agent speaks). With single Cap Chew
    // voice now the default, buildHandoffPhrase() always returns null
    // (same voice throughout -> no bridge needed). The tracker record
    // call below still runs so the handoff-phrase module keeps a
    // usable context if multi-voice is ever reintroduced.
    try {
      const {
        getSharedTracker,
      } = require('../../lib/naturalness/agent-transition-tracker');
      const { buildHandoffPhrase } = require('../../lib/naturalness/handoff-phrases');
      const { getAgent: _getAgentForBridge } = require('../../packages/agents/agent-registry');

      const bridgeToolId = (task.metadata && task.metadata.source) || 'voice';
      const tracker = getSharedTracker();
      const fromAgentId = tracker.getLastAgent(bridgeToolId);
      const toAgentForBridge = _getAgentForBridge(winner.agentId);
      const fromAgentForBridge = fromAgentId ? _getAgentForBridge(fromAgentId) : null;

      const bridgePhrase = buildHandoffPhrase({
        fromAgentId,
        toAgentId: winner.agentId,
        fromAgent: fromAgentForBridge,
        toAgent: toAgentForBridge,
      });

      if (bridgePhrase) {
        const { getVoiceSpeaker } = require('../../voice-speaker');
        const speaker = getVoiceSpeaker();
        if (speaker) {
          const outgoingVoice = getAgentVoice(fromAgentId, fromAgentForBridge);
          log.info('voice', '[HandoffBridge]', {
            fromAgentId,
            toAgentId: winner.agentId,
            phrase: bridgePhrase,
            outgoingVoice,
          });
          await speaker.speak(bridgePhrase, { voice: outgoingVoice });
          task.metadata = task.metadata || {};
          task.metadata._handoffBridgeSpoke = true;
        }
      }

      tracker.recordAgent(bridgeToolId, winner.agentId);
    } catch (err) {
      log.warn('voice', '[HandoffBridge] error', { error: err.message });
    }

    // ==================== CONFIRMATION GATE ====================
    // Always on. Runs before agent execution and decides to:
    //   - dispatch silently            (informational / confident low-risk)
    //   - speak a short pre-action ack ("got it")   (confident actions)
    //   - speak a confirmation question              (high-stakes / low-conf)
    //
    // The confirm-first decision narrates the warning and proceeds;
    // real yes/no suspension is a future enhancement.
    //
    // If a handoff bridge spoke in the same turn AND the gate's
    // decision is a lightweight ACK, the ACK is skipped so the user
    // doesn't hear "passing you to X" + "got it" back-to-back. A
    // CONFIRM decision always fires (safety).
    try {
      const {
        evaluateConfirmationGate,
        applyGateEffects,
        DECISIONS: GATE_DECISIONS,
      } = require('../../lib/naturalness/confirmation-gate');
      const { getAgent } = require('../../packages/agents/agent-registry');
      const gateAgent = getAgent(winner.agentId);

      const gate = evaluateConfirmationGate({
        task,
        agent: gateAgent,
        winnerConfidence: winner.confidence ?? 1.0,
        intentConfidence: (task.metadata && task.metadata.intentConfidence) ?? 1.0,
        hasPriorContext: typeof getRecentHistory === 'function' && getRecentHistory().length > 0,
        planSummary: winner.plan || winner.reasoning || '',
      });

      const skipAckAfterHandoff =
        task.metadata &&
        task.metadata._handoffBridgeSpoke &&
        gate.decision === GATE_DECISIONS.ACK;

      log.info('voice', '[ConfirmationGate] decision', {
        taskId: task.id,
        agentId: winner.agentId,
        decision: gate.decision,
        stakes: gate.stakes,
        reason: gate.reason,
        willSpeak: Boolean(gate.phrase) && !skipAckAfterHandoff,
        skippedForHandoff: Boolean(skipAckAfterHandoff),
      });

      if (gate.phrase && !skipAckAfterHandoff) {
        const { getVoiceSpeaker } = require('../../voice-speaker');
        const speaker = getVoiceSpeaker();
        if (speaker) {
          const gateVoice = getAgentVoice(winner.agentId, gateAgent);
          await applyGateEffects(gate, {
            speak: (text, opts) => speaker.speak(text, { ...opts, voice: gateVoice }),
            logWarn: (msg, meta) =>
              log.warn('voice', `[ConfirmationGate] ${msg}`, meta),
          });
          task.metadata = task.metadata || {};
          task.metadata._confirmationGateSpoke = true;
        }
      }
    } catch (err) {
      log.warn('voice', '[ConfirmationGate] error', { error: err.message });
    }

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

      // Suppress the deferred ack if the confirmation gate OR the
      // handoff bridge already spoke a pre-action phrase. Hearing
      // "got it" then "let me check..." (or "passing you to X" then
      // "let me check...") reads as a double response.
      if (
        task.metadata &&
        (task.metadata._confirmationGateSpoke || task.metadata._handoffBridgeSpoke)
      ) {
        ackMessage = null;
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
            } catch (_ignored) {
              /* ack TTS best-effort */
            }
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
    const bidsSummary = allBids.map((b) => ({
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

        stats.recordBidEvent({
          taskId: task.id,
          taskContent: task.content,
          bids: bidsSummary,
          winner,
        });
      }).catch((_e) => { log.warn('voice', 'Stats init/record failed', { error: _e.message }); });
    } catch (e) {
      log.warn('voice', 'Stats tracking error', { data: e.message });
    }

    // Get pending context info for HUD
    const hasPendingContext = getTranscriptService().hasPending();
    const pendingAgents = hasPendingContext ? getTranscriptService().getPendingAgentIds() : [];

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
      type: 'task:assigned',
      taskId: task.id,
      agentId: winner.agentId,
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
   try {
    const safeResult = result || {};
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

    // ── AGENT LEARNING: emit interaction data for self-improvement system ──
    try {
      const bustCount = task.metadata?.bustCount || 0;
      const bustedAgents = task.metadata?.bustedAgents || [];
      exchangeBus.emit('learning:interaction', {
        taskId: task.id,
        agentId,
        userInput: task.content || '',
        success: result?.success !== false,
        message: (safeResult.output || safeResult.message || '').slice(0, 500),
        error: safeResult.error || null,
        hasUI: !!safeResult.html,
        durationMs: executionDurationMs || 0,
        bustCount,
        bustedAgents: bustedAgents.map((b) => b.agentId),
        timestamp: Date.now(),
      });

      // Temporal model: record every successful interaction so agents
      // can later say "you usually ask about X at this time" and
      // "yesterday you were working on Y". Failed tasks are excluded
      // because we don't want a timeout on Tuesday at 3pm to look like
      // a habit.
      if (result?.success !== false) {
        try {
          const { getTemporalContext } = require('../../lib/temporal-context');
          getTemporalContext().recordInteraction({
            userInput: task.content || '',
            agentId,
            timestamp: Date.now(),
          });
        } catch (_) { /* temporal context is non-critical */ }
      }

      // If a task succeeded only after one or more busts, emit a stronger
      // signal so the opportunity evaluator / agent-builder can consider
      // proposing a better-suited agent for this class of request. This is
      // the difference between "worked eventually" and "resilient". Without
      // this, repeated slow tasks look identical to fast tasks to the
      // learning loop.
      if (bustCount > 0 && result?.success !== false) {
        const slowEvent = {
          taskId: task.id,
          userInput: task.content || '',
          winningAgentId: agentId,
          bustCount,
          bustedAgents: bustedAgents.map((b) => ({
            agentId: b.agentId,
            error: b.error,
          })),
          totalDurationMs: bustedAgents.length > 0
            ? Date.now() - (bustedAgents[0].ts || Date.now())
            : executionDurationMs || 0,
          timestamp: Date.now(),
        };
        exchangeBus.emit('learning:slow-success', slowEvent);

        // Ask the slow-success tracker whether this is the Nth time a
        // similar query has been slow. If so, tack a one-time "I could
        // build an agent for this" follow-up onto the orb's response so
        // the user actually hears the offer instead of it disappearing
        // into the learning pipeline. Respects cooldowns to avoid nagging.
        try {
          const { getSlowSuccessTracker } = require('../../lib/agent-learning/slow-success-tracker');
          const suggestion = getSlowSuccessTracker().shouldSuggestBuild(slowEvent);
          if (suggestion) {
            log.info('voice', '[SlowSuccess] Emitting proactive build suggestion', {
              classKey: suggestion.queryClass,
              agentIdea: suggestion.agentIdea,
            });
            const suggestionPayload = {
              taskId: task.id,
              prompt: suggestion.suggestedPrompt,
              reason: suggestion.reason,
              agentIdea: suggestion.agentIdea,
              queryClass: suggestion.queryClass,
              detail: suggestion.detail,
            };
            // Internal bus (for learning-loop / metrics consumers)
            exchangeBus.emit('orb:proactive-suggestion', suggestionPayload);
            // Broadcast to all renderer windows so the orb can surface
            // the suggestion visually (tooltip / transcript) and so
            // "build that agent" shortcut phrases can be recognised.
            broadcastToWindows('orb:proactive-suggestion', suggestionPayload);
            // Speak the suggestion after a short delay so it lands AFTER
            // the main response finishes. Non-blocking; best-effort.
            setTimeout(() => {
              try {
                const { getVoiceSpeaker } = require('../../voice-speaker');
                const speaker = getVoiceSpeaker();
                if (speaker && speaker.speak) {
                  speaker.speak(suggestion.suggestedPrompt, { voice: 'echo' });
                }
              } catch (err) {
                log.warn('voice', '[SlowSuccess] TTS failed', { error: err.message });
              }
            }, 2500);
          }
        } catch (err) {
          log.warn('voice', '[SlowSuccess] Tracker failed', { error: err.message });
        }
      }
    } catch (_) { /* learning event is non-critical */ }

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
        memoryAgent
          .observeConversation(task, result, agentId)
          .catch((e) => log.warn('voice', '[MemoryObserver] Error', { data: e.message }));
      } catch (_e) {
        // Fall back to legacy extraction if memory agent fails to load
        extractAndSaveUserFacts(task, result, agentId).catch((e2) =>
          log.warn('voice', '[LearningPipeline] Error', { data: e2.message })
        );
      }
    }

    // ==================== ANSWER REFLECTION (LLM-as-judge) ====================
    // After the user has already heard the answer, quietly run a judge
    // over it to catch cases the agent marked success=true but the
    // answer is actually ungrounded, irrelevant, or non-actionable.
    // Fire-and-forget: reflection never blocks the UI. Low scores emit
    // `learning:low-quality-answer` so the learning loop + slow-success
    // tracker can act on persistent quality issues.
    try {
      const { getAnswerReflector } = require('../../lib/agent-learning/answer-reflector');
      const reflector = getAnswerReflector();
      const originalAgent = allBuiltInAgentMap?.[agentId] || { id: agentId };
      if (reflector.shouldReflect({ agent: originalAgent, result, userInput: task.content })) {
        // Evidence heuristics: if the agent returned `sources` or `data.searchResults`,
        // hand those to the judge so groundedness can be checked properly.
        const evidence =
          result?.data?.searchResults ||
          result?.data?.sources ||
          result?.sources ||
          null;
        reflector
          .reflect({ agent: originalAgent, task, result, evidence })
          .then((record) => {
            if (!record || record.skipped) return;
            // Stamp the reflection onto task metadata so downstream
            // consumers (Master Orchestrator feedback, learning loop)
            // can factor quality into their decisions instead of just
            // success/failure booleans.
            if (task && task.metadata) {
              task.metadata.reflectionOverall = record.overall;
              task.metadata.reflectionScores = record.scores;
              task.metadata.reflectionIssues = record.issues;
            }
            // Emit generic reflection event for any listener
            exchangeBus.emit('learning:reflection', {
              taskId: task.id,
              agentId,
              userInput: task.content || '',
              ...record,
            });
            if (record.lowQuality) {
              log.warn('voice', '[Reflector] Low-quality answer detected', {
                agent: agentId,
                overall: Number(record.overall?.toFixed(2)),
                issues: record.issues,
              });
              const lowEvent = {
                taskId: task.id,
                agentId,
                userInput: task.content || '',
                overall: record.overall,
                scores: record.scores,
                issues: record.issues,
                timestamp: Date.now(),
              };
              exchangeBus.emit('learning:low-quality-answer', lowEvent);
              // A persistently low-quality bucket is itself a slow-success
              // signal -- feed the tracker so the "build a better agent"
              // suggestion can fire on pure-quality failures, not just
              // latency failures.
              try {
                const { getSlowSuccessTracker } = require('../../lib/agent-learning/slow-success-tracker');
                const suggestion = getSlowSuccessTracker().shouldSuggestBuild({
                  userInput: task.content || '',
                  winningAgentId: agentId,
                  bustCount: 1, // treat low-quality as a soft bust
                  bustedAgents: [{ agentId, error: 'low-quality' }],
                  totalDurationMs: 0,
                });
                if (suggestion) {
                  broadcastToWindows('orb:proactive-suggestion', {
                    taskId: task.id,
                    prompt: suggestion.suggestedPrompt,
                    reason: 'low-quality-threshold',
                    agentIdea: suggestion.agentIdea,
                    queryClass: suggestion.queryClass,
                    detail: suggestion.detail,
                  });
                }
              } catch (_e) { /* tracker optional */ }
            }
          })
          .catch(() => { /* reflection is non-critical */ });
      }
    } catch (err) {
      log.warn('voice', '[Reflector] Setup error', { error: err.message });
    }

    // Phase 1: Check if this task was cancelled (late result suppression)
    if (routerInstance?.cancelledTaskIds?.has(task.id)) {
      log.info('voice', 'Suppressing late result for cancelled task', { taskId: task.id });
      routerInstance.cancelledTaskIds.delete(task.id);
      return;
    }

    // Check for multi-turn conversation (needsInput)
    if (result.needsInput) {
      await handleNeedsInput(result, agentId, task.id, { html: result.html, data: result.data });
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
            const _mainWindow = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());

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
                    label: menuItem.name,
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
                    isExternal: true,
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

    // ==================== MEETING LINK AUTO-OPEN ====================
    // If agent returned a meeting link and the meeting is imminent, open it
    if (result.data?.type === 'meeting_link' && result.data?.url && result.data?.openNow) {
      try {
        log.info('voice', 'Auto-opening meeting link', { url: result.data.url, provider: result.data.provider });
        const { shell } = require('electron');
        await shell.openExternal(result.data.url);
      } catch (linkErr) {
        log.warn('voice', 'Failed to open meeting link', { error: linkErr.message });
      }
    }

    let message = result.output || result.data?.output || result.data?.message || (result.success ? 'All done' : null);

    // ==================== RESPONSE GUARD ====================
    // Lightweight sanity checks BEFORE speaking. Catches common hallucinations
    // like wrong day-of-week, wrong date, impossible temperatures, etc.
    if (message && message !== 'All done') {
      const guardIssue = checkResponseSanity(message);
      if (guardIssue) {
        log.warn('voice', `[ResponseGuard] Caught issue: ${guardIssue}`, {
          agentId,
          messagePreview: message.slice(0, 80),
        });
        // Re-execute the agent with explicit grounding instruction
        try {
          const agent = allBuiltInAgentMap[agentId];
          if (agent && agent.execute) {
            const groundedResult = await agent.execute({
              content: task.content,
              context: {
                ...task.context,
                groundingNote: `Your previous response had an error: ${guardIssue}. Use ONLY real data from your data sources.`,
              },
            });
            const corrected =
              groundedResult?.output ||
              groundedResult?.data?.output ||
              groundedResult?.data?.message ||
              groundedResult?.message;
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
        agentName: agentId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      });
    }

    // Emit to HUD API (include html so all listeners can render rich UI)
    hudApi.emitResult({
      taskId: task.id,
      success: true,
      message: message || 'Task completed',
      data: result.data,
      html: result.html,
      agentId,
    });

    // DIRECT TTS - Speak the result directly via realtime speech
    // For async tasks, respondToFunctionCall already completed with empty response
    // so we need to speak the actual result here.
    // When a graphical panel (HTML) is present, the panel IS the primary result.
    // Speak only the short spoken summary -- the visual does the heavy lifting.
    const hasPanel = !!result.html;
    if (message && message !== 'All done') {
      try {
        const { getVoiceSpeaker } = require('../../voice-speaker');
        const speaker = getVoiceSpeaker();

        if (speaker) {
          const agentVoice = getAgentVoice(agentId);
          log.info('voice', 'Speaking task result directly', {
            messagePreview: message.slice(0, 50),
            voice: agentVoice,
            hasPanel,
          });
          const speakResult = await speaker.speak(message, {
            voice: agentVoice,
            // Flag so downstream listeners know this is panel-backed speech
            hasPanel,
          });
          log.info('voice', 'Speak result for task completion', { speakResult: speakResult });
        }
      } catch (e) {
        log.error('voice', 'Direct TTS for result failed', { arg0: e.message, arg1: e.stack });
      }
    }

    broadcastToWindows('voice-task:completed', {
      taskId: task.id,
      agentId,
      result: safeResult,
      hasPanel: !!safeResult.html,
    });
   } catch (settledErr) {
    log.error('voice', 'Error in task:settled handler', { error: settledErr.message, agentId, taskId: task?.id });
   }
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

        // If diagnosis is available for a non-system agent, offer fix options
        if (result?.data?.diagnosticAvailable && result.data.failedAgentId) {
          const diagData = result.data;
          const options = [];

          if (diagData.fix?.canFix) {
            options.push({
              label: 'Fix it now',
              description: `Open Agent Composer with the diagnosis to fix "${diagData.failedAgentId}"`,
              action: 'diagnose-fix',
              failedAgentId: diagData.failedAgentId,
              diagnosis: diagData.diagnosis,
              fix: diagData.fix,
              originalTask: diagData.originalTask,
            });
          }

          options.push({
            label: 'Open in Agent Composer',
            description: `Inspect and edit "${diagData.failedAgentId}" in the Agent Composer`,
            action: 'diagnose-open-composer',
            failedAgentId: diagData.failedAgentId,
            diagnosis: diagData.diagnosis,
            originalTask: diagData.originalTask,
          });

          options.push({
            label: 'Try again',
            description: 'Resubmit the original request',
            action: 'diagnose-retry',
            originalTask: diagData.originalTask,
          });

          options.push({
            label: 'Skip',
            description: 'Dismiss this error',
            action: 'diagnose-skip',
          });

          hudApi.emitDisambiguation({
            taskId: task.id,
            question: message,
            options,
          });

          broadcastToWindows('voice-task:disambiguation', {
            taskId: task.id,
            question: message,
            options: options.map((o, i) => ({ index: i, label: o.label, description: o.description })),
          });
        }

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

    // Track the last agent that attempted execution (assignedAgent is cleared on re-auction)
    task.metadata = task.metadata || {};
    task.metadata.lastAgentId = agentId;

    // Track cumulative bust count on the task so downstream consumers
    // (learning loop, agent-builder) know this task required retries and
    // can propose improvements.
    task.metadata.bustCount = (task.metadata.bustCount || 0) + 1;
    task.metadata.bustedAgents = task.metadata.bustedAgents || [];
    task.metadata.bustedAgents.push({
      agentId,
      error: typeof error === 'string' ? error : error?.message || 'unknown',
      ts: Date.now(),
    });

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
      type: 'task:busted',
      taskId: task.id,
      agentId,
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
    } catch (_e) {
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
      status.agents = exchangeInstance.agents.getAll().map((a) => ({
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
    return exchangeInstance.agents.getAll().map((a) => ({
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

  handlers.forEach((handler) => {
    try {
      ipcMain.removeHandler(handler);
    } catch (_e) {
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
      localAgentConnections.delete(agent.id);
    }

    // Agent is missing -- reconnect
    try {
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
        } catch (_e) {
          failed++;
        }
      }
    }
  } catch (_e) {
    // Custom agent store not available, that's fine
  }

  if (reconnected > 0 || failed > 0) {
    log.info('voice', 'Agent health check result', {
      reconnected,
      failed,
      alreadyConnected,
      total: localAgentConnections.size,
    });
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
      } catch (_e) {
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
  log.info('voice', 'processSubmit', {
    transcript: (transcript || '').slice(0, 60),
    toolId,
    hasExchange: !!exchangeInstance,
    isRunning: isExchangeRunning,
  });

  // ==================== EMPTY CHECK ====================
  if (!transcript || !transcript.trim()) {
    return { queued: false, handled: false, message: 'Empty transcript' };
  }

  let text = transcript.trim();

  // ==================== REPAIR MEMORY (Phase 5) ====================
  // Two shortcuts, both running before identity correction:
  //
  //   1. Undo intent ("forget that fix", "never mind that correction"):
  //      rolls back the most recent learn, speaks a short ack, and
  //      SHORT-CIRCUITS the pipeline (the utterance is not a task).
  //
  //   2. Correction learn ("I meant jazz", "I said alice not ellis"):
  //      extracts heard/meant and stores a fix. The utterance still
  //      flows through to normal routing so any implied task ("play
  //      jazz" in the corrected form) can still execute.
  try {
    const {
      detectCorrection,
      detectUndoCorrection,
    } = require('../../lib/naturalness/correction-detector');
    const {
      getSharedRepairMemory,
    } = require('../../lib/naturalness/repair-memory-singleton');

    // Shortcut 1: undo the most recent learn.
    const undo = detectUndoCorrection(text);
    if (undo) {
      const repair = getSharedRepairMemory();
      const result = repair.unlearnLast();
      let ack;
      if (result.removed) {
        ack = `OK, I'll forget that "${result.entry.heard}" meant "${result.entry.meant}".`;
      } else {
        ack = "I don't have a recent fix to forget.";
      }
      log.info('voice', '[RepairMemory] undo', { pattern: undo.pattern, result });
      try {
        const { getVoiceSpeaker } = require('../../voice-speaker');
        const speaker = getVoiceSpeaker();
        if (speaker) await speaker.speak(ack, { skipAffectMatching: true });
      } catch (_err) { /* speech optional */ }
      return { queued: false, handled: true, message: 'Repair memory undo applied' };
    }

    // Shortcut 2: learn a phonetic fix (does not short-circuit).
    const priorUserTurns = (typeof getRecentHistory === 'function'
      ? getRecentHistory()
      : []
    ).filter((t) => t && t.role === 'user');
    const priorUser = priorUserTurns.length
      ? priorUserTurns[priorUserTurns.length - 1].content || ''
      : '';
    const correction = detectCorrection(text, priorUser);
    if (correction) {
      const repair = getSharedRepairMemory();
      const outcome = repair.learnFix(correction.heard, correction.meant);
      log.info('voice', '[RepairMemory] correction detected', {
        pattern: correction.pattern,
        heard: correction.heard,
        meant: correction.meant,
        outcome,
      });
    }
  } catch (err) {
    log.warn('voice', '[RepairMemory] error', { error: err.message });
  }

  // ==================== AFFECT DETECTION (Phase 6) ====================
  // Classify the current user utterance and record non-neutral
  // affect in the shared tracker so outgoing TTS can tone-match.
  // Does not short-circuit; this is purely observational from here.
  try {
    const { isFlagEnabled } = require('../../lib/naturalness-flags');
    if (isFlagEnabled('affectMatching')) {
      const {
        classifyAffect,
      } = require('../../lib/naturalness/affect-classifier');
      const {
        getSharedAffectTracker,
      } = require('../../lib/naturalness/affect-tracker');

      const history = typeof getRecentHistory === 'function' ? getRecentHistory() : [];
      const priorUserTurns = history.filter((t) => t && t.role === 'user');
      const lastUser = priorUserTurns.length
        ? priorUserTurns[priorUserTurns.length - 1].content || ''
        : '';
      const recentRepeat =
        lastUser && _normalizeAffectInput(lastUser) === _normalizeAffectInput(text);
      const recentErrors = history.filter(
        (t) =>
          t &&
          t.role !== 'user' &&
          typeof t.content === 'string' &&
          /\b(error|failed|couldn't|can't complete|problem)\b/i.test(t.content)
      ).length;

      const affect = classifyAffect({ text, recentErrors, recentRepeat });
      if (affect.label !== 'neutral') {
        getSharedAffectTracker().record(affect);
        log.info('voice', '[Affect] detected', {
          label: affect.label,
          confidence: affect.confidence,
          signals: affect.signals,
        });
      }
    }
  } catch (err) {
    log.warn('voice', '[Affect] classify error', { error: err.message });
  }

  // ==================== IDENTITY CORRECTION SHORTCUT ====================
  // Handle "I don't live in X", "I'm not in Y right now", "Not X I'm
  // actually in Y" before normal routing. Clears the stored profile
  // value, consults the live location service (precise > IP > stored),
  // and speaks back an acknowledgement. Without this, a stale profile
  // value (e.g. Home City = Las Vegas) would continue to bias agents
  // even after the user explicitly told us it's wrong.
  try {
    const { detectIdentityCorrection, applyIdentityCorrection } = require('../../lib/identity-correction');
    const detection = detectIdentityCorrection(text);
    if (detection) {
      log.info('voice', '[IdentityCorrection] Detected', {
        type: detection.type,
        retracted: detection.retractedValue,
        asserted: detection.assertedValue,
      });
      const { getUserProfile } = require('../../lib/user-profile-store');
      const profile = getUserProfile();
      let locationService = null;
      try {
        const mod = require('../../lib/location-service');
        locationService = mod.getLocationService();
      } catch (_e) { /* location service optional */ }

      const applied = await applyIdentityCorrection(detection, {
        userProfile: profile,
        locationService,
      });

      // Speak the acknowledgement via the same channel other shortcuts
      // use so the user actually hears it.
      try {
        const { getVoiceSpeaker } = require('../../voice-speaker');
        const speaker = getVoiceSpeaker();
        if (speaker && speaker.speak && applied.spokenResponse) {
          speaker.speak(applied.spokenResponse, { voice: 'echo' });
        }
      } catch (_e) { /* speaker optional */ }

      // Broadcast to windows so a HUD/toast can echo the correction.
      broadcastToWindows('voice-task:identity-correction', {
        retractedValue: detection.retractedValue,
        assertedValue: applied.finalValue,
        source: applied.liveCityUsed ? 'live-location' : (detection.assertedValue ? 'user' : 'cleared'),
        spokenResponse: applied.spokenResponse,
      });

      return {
        transcript: text,
        queued: false,
        handled: true,
        classified: true,
        action: 'identity-correction',
        message: applied.spokenResponse,
        suppressAIResponse: false,
      };
    }
  } catch (err) {
    log.warn('voice', '[IdentityCorrection] Handler error', { error: err.message });
  }

  // ==================== NEGATIVE FEEDBACK SHORTCUT ====================
  // Catch the user telling us the last answer was wrong. Early intercept
  // so it doesn't get routed to some agent as a regular task. Emits a
  // `learning:negative-feedback` event the learning loop consumes. We
  // still hand control back to the normal flow so the orb can also
  // respond (e.g. "Got it, I'll try a different approach.").
  const lowered = text.toLowerCase().replace(/[.?!,]/g, '').trim();
  const NEGATIVE_FEEDBACK_PATTERNS = [
    /^(that|this)\s+(was|is)\s+(wrong|not right|incorrect|bad)$/i,
    /^(that|this)\s+didn[''']?t\s+(answer|help|work)/i,
    /^(thats|that[''']?s)\s+(wrong|not it|not what i|not helpful)/i,
    /^(no|nope)\s+(thats|that[''']?s)\s+(wrong|not it)/i,
    /^(wrong answer|bad answer|not what i asked|missed the point)$/i,
    /^(thumbs\s*down|not helpful|didn[''']?t help)$/i,
  ];
  if (NEGATIVE_FEEDBACK_PATTERNS.some((p) => p.test(lowered))) {
    try {
      const lastTurn = getRecentHistory()
        .filter((h) => h.role === 'assistant')
        .slice(-1)[0];
      exchangeBus.emit('learning:negative-feedback', {
        source: 'voice-shortcut',
        userInput: text,
        targetedAgentId: lastTurn?.agentId || null,
        targetedMessage: lastTurn?.content || null,
        timestamp: Date.now(),
      });
      broadcastToWindows('learning:negative-feedback', {
        targetedAgentId: lastTurn?.agentId || null,
      });
      log.info('voice', '[NegFeedback] Received user negative signal', {
        agent: lastTurn?.agentId,
      });
    } catch (err) {
      log.warn('voice', '[NegFeedback] Emit failed', { error: err.message });
    }
    return {
      transcript: text,
      queued: false,
      handled: true,
      classified: true,
      action: 'negative-feedback',
      message: "Got it -- I'll try a different approach next time.",
      suppressAIResponse: false,
    };
  }

  // ==================== DUPLICATE SUBMISSION CHECK ====================
  const normalizedTranscript = text
    .toLowerCase()
    .replace(/[.,!?;:'"]/g, '')
    .trim();
  const now = Date.now();
  let isDuplicate = false;

  // Check exact match first, then prefix match against all recent submissions.
  // Partial transcripts like "Can you play it on?" are caught as prefixes of
  // the full "Can you play it on my speaker?" (and vice versa).
  for (const [recentText, recentTime] of recentSubmissions) {
    if (now - recentTime < SUBMIT_DEDUP_WINDOW_MS) {
      if (
        recentText === normalizedTranscript ||
        recentText.startsWith(normalizedTranscript) ||
        normalizedTranscript.startsWith(recentText)
      ) {
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
  } catch (_) {
    /* non-fatal */
  }
  addToHistory('user', text);

  // ==================== PENDING AGENT INPUT (MULTI-TURN) ====================
  // Routing + execution is handled by the extracted routePendingInput() helper.
  // Pending state lives in TranscriptService (lib/transcript-service.js).
  {
    const pendingResult = await routePendingInput(text, metadata);
    if (pendingResult) return pendingResult;
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
    // Critical commands -- only intercept TRUE system commands, not agent
    // intents like "cancel the meeting" or "stop the recording".
    //
    // Extracted to the portable `lib/hud-core` layer so the same
    // classifier runs in the desktop app, GSX flows, and WISER
    // Playbooks without divergence. See docs/hud-core/ for the
    // portability contract.
    const { isCriticalCommand } = require('../../lib/hud-core');
    if (isCriticalCommand(text)) {
      log.info('voice', 'Routing critical command to Router');
      const result = await routerInstance.handle(text);
      if (result.handled) {
        return {
          transcript: text,
          queued: false,
          handled: true,
          classified: true,
          action: result.type || 'router-handled',
          message: result.speak,
          suppressAIResponse: false,
        };
      }
    }

    // Pending question / confirmation.
    // Decision extracted to `lib/hud-core/pending-state.js` so the
    // same classifier runs in any consumer; the local
    // conversationState singleton still owns the STATE.
    const routingContext = conversationState.getRoutingContext();
    const { shouldRouteToPendingStateHandler } = require('../../lib/hud-core');
    if (shouldRouteToPendingStateHandler(routingContext)) {
      log.info('voice', 'Routing to Router for pending state resolution');
      const result = await routerInstance.handle(text);
      if (result.handled) {
        return {
          transcript: text,
          queued: false,
          handled: true,
          classified: true,
          action: result.type || 'state-resolved',
          message: result.speak,
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
          transcript: text,
          queued: false,
          handled: true,
          classified: false,
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
      transcript: text,
      queued: false,
      handled: true,
      classified: false,
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
    } catch (_) {
      /* non-fatal */
    }

    const normResult = await normalizeIntent(text, convText, userProfileCtxForNorm);

    if (normResult.needsClarification && normResult.clarificationQuestion) {
      log.info('voice', '[NormalizeIntent] Asking for clarification', {
        question: normResult.clarificationQuestion,
        raw: text,
      });
      // Return clarification as a needsInput result so the orb speaks it once
      // (via respondToFunctionCall) and transitions to awaitingInput -> listening.
      // Previously this called speaker.speak() directly, causing double speech.
      hudApi.emitResult({
        taskId: `clarify_${Date.now()}`,
        success: true,
        message: normResult.clarificationQuestion,
        agentId: 'system',
      });
      return {
        transcript: text,
        queued: false,
        handled: true,
        classified: false,
        needsClarification: true,
        needsInput: true,
        message: normResult.clarificationQuestion,
        suppressAIResponse: true,
      };
    }

    if (normResult.intent && normResult.intent !== text) {
      log.info(
        'voice',
        `[NormalizeIntent] Interpreted: "${text}" -> "${normResult.intent}" (confidence=${normResult.confidence})`
      );
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
  } catch (_) {
    /* non-fatal */
  }

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
          metadata: {
            source: toolId,
            conversationHistory: convHistory,
            conversationText: convText,
            userProfileContext,
          },
        };

        try {
          const result = await safeExecuteAgent(agent, taskObj, {
            executeFn: (a, t, ctx) => executeWithInputSchema(a, t, ctx),
          });

          // Record success back into history
          const message = result.message || result.result || '';
          if (message) addToHistory('assistant', message, cachedRoute.agentId);

          // Handle multi-turn (needsInput)
          if (result.needsInput) {
            await handleNeedsInput(result, cachedRoute.agentId, taskObj.id, { html: result.html });
            hudApi.emitResult({
              taskId: taskObj.id,
              success: true,
              message: result.needsInput.prompt || message,
              html: result.html,
              agentId: cachedRoute.agentId,
              needsInput: result.needsInput,
            });
          } else {
            // Speak result
            if (message) {
              try {
                const { getVoiceSpeaker } = require('../../voice-speaker');
                const speaker = getVoiceSpeaker();
                if (speaker) await speaker.speak(message, { voice: getAgentVoice(cachedRoute.agentId) });
              } catch (_ignored) {
                /* result TTS best-effort */
              }
            }
            hudApi.emitResult({
              taskId: taskObj.id,
              success: result.success !== false,
              message,
              html: result.html,
              agentId: cachedRoute.agentId,
              data: result.data,
            });
            if (global.sendCommandHUDResult) {
              global.sendCommandHUDResult({
                success: true,
                message,
                html: result.html,
                agentId: cachedRoute.agentId,
                agentName:
                  cachedRoute.agentName ||
                  cachedRoute.agentId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
              });
            }
          }

          // Update routing cache success
          recordSuccessfulRoute(text, cachedRoute.agentId, cachedRoute.agentName, cachedRoute.confidence);

          return {
            transcript: text,
            queued: false,
            handled: true,
            classified: true,
            action: 'routing-cache-hit',
            message,
            agentId: cachedRoute.agentId,
            suppressAIResponse: true,
          };
        } catch (execErr) {
          log.warn('voice', `[FastPath] Cached agent execution failed, falling through to auction`, {
            error: execErr.message,
          });
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
        transcript: text,
        queued: true,
        taskId: subtaskIds[0],
        decomposed: true,
        subtaskIds,
        classified: true,
        action: 'exchange-auction',
        message: `Processing ${decomposition.subtasks.length} tasks...`,
        suppressAIResponse: true,
      };
    }

    // Build screen context for agent spatial awareness (non-blocking, safe to fail)
    let screenContext = null;
    try {
      const screenService = require('../../lib/screen-service');
      const orbWin = global.orbWindow || null;
      const orbSide = global.settingsManager?.get('voiceOrbSide') || 'right';
      screenContext = screenService.getScreenContext(orbWin, orbSide);
    } catch (_e) {
      // Screen context is optional -- don't block task submission
    }

    // Build situational context so agents know what the user is doing right now
    let situationContext = null;
    try {
      const { executeAction } = require('../../action-executor');
      const result = await executeAction('app-situation');
      if (result && result.success) {
        const s = result.data;
        situationContext = {
          focusedWindow: s.windows?.focusedName || null,
          openWindows: (s.windows?.open || []).filter(w => w.visible).map(w => w.name || w.title),
          flowContext: s.flowContext || null,
          orbVisible: s.voice?.orbVisible || false,
          connectedAgents: s.agents?.connectedCount || 0,
        };
      }
    } catch (_e) {
      // Situation context is optional -- don't block task submission
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
        screenContext,
        situationContext,
        timestamp: Date.now(),
        ...metadata,
      },
    });

    log.info('voice', 'Task submitted', { taskId, toolId });

    // Record queued lifecycle event to the durable timeline. Best-effort
    // -- never block the submit on recording failures.
    try {
      const { getAgentStats } = require('./agent-stats');
      const stats = getAgentStats();
      if (stats && typeof stats.recordTaskLifecycle === 'function') {
        stats.recordTaskLifecycle({
          taskId,
          type: 'queued',
          at: Date.now(),
          data: { toolId, spaceId: spaceId || null, rawLen: (rawTranscript || '').length },
        });
      }
    } catch (_err) { /* lifecycle recording is best-effort */ }

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
      transcript: text,
      queued: false,
      handled: true,
      classified: false,
      error: submitError.message,
      message: "Sorry, I couldn't process that request.",
      suppressAIResponse: false,
    };
  }
}

// ── WebMCP Proxy Agent Tracking ────────────────────────────

function getExchangePort() {
  return currentExchangePort;
}

function trackWebMCPAgent(agentId, { tabId, toolName, origin }) {
  webmcpProxyAgents.set(agentId, {
    tabId,
    toolName,
    origin,
    registeredAt: Date.now(),
  });
}

function untrackWebMCPAgent(agentId) {
  webmcpProxyAgents.delete(agentId);
}

function getWebMCPAgents() {
  return Object.fromEntries(webmcpProxyAgents);
}

module.exports = {
  initializeExchangeBridge,
  getExchange,
  isRunning,
  getExchangeUrl,
  getExchangePort,
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
  // Custom agent briefing contributors (for daily-brief-agent)
  getCustomBriefingAgents,
  // WebMCP proxy agent tracking
  trackWebMCPAgent,
  untrackWebMCPAgent,
  getWebMCPAgents,
};
