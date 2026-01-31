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

// Unified LLM Bidder - ALL agents use this, keyword fallback only on LLM failure
const { evaluateAgentBid, checkBidderReady } = require('../../packages/agents/unified-bidder');

// Router instance (initialized after exchange is ready)
let routerInstance = null;

// ==================== VOICE SYSTEM CONFIGURATION ====================
// All configurable timeouts and settings in one place
const VOICE_CONFIG = {
  // LLM Bidding
  bidTimeoutMs: 3000,          // Max time for single LLM bid evaluation
  bidCircuitThreshold: 3,      // Open circuit after N failures
  bidCircuitResetMs: 60000,    // Reset circuit after this many ms
  
  // Auction timing
  auctionDefaultWindowMs: 3500, // Default auction window (allows LLM bids)
  auctionMinWindowMs: 3000,     // Minimum auction window
  auctionMaxWindowMs: 5000,     // Maximum auction window
  instantWinThreshold: 0.9,     // Confidence threshold for instant win
  
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
        console.log('[BidCircuit] Resetting circuit after cool-down');
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
    console.warn(`[BidCircuit] LLM failure ${this.failures}/${this.threshold}`);
  },
  recordSuccess() {
    if (this.failures > 0) {
      this.failures = Math.max(0, this.failures - 1);
    }
  }
};

const BID_TIMEOUT_MS = VOICE_CONFIG.bidTimeoutMs;

/**
 * Keyword-based fallback bidding (used when LLM is unavailable)
 */
function keywordFallbackBid(agent, task) {
  const content = (task.content || '').toLowerCase();
  const keywords = agent.keywords || [];
  const capabilities = agent.capabilities || [];
  
  // Match keywords
  const keywordMatches = keywords.filter(k => content.includes(k.toLowerCase()));
  
  // Match capability phrases
  const capMatches = capabilities.filter(cap => {
    const capWords = cap.toLowerCase().split(/\s+/);
    return capWords.some(w => w.length > 3 && content.includes(w));
  });
  
  const totalMatches = keywordMatches.length + capMatches.length;
  
  if (totalMatches === 0) {
    return { confidence: 0, plan: null, fallback: true };
  }
  
  // Base confidence 0.3, +0.1 per match, max 0.7 (never as good as LLM)
  const confidence = Math.min(0.7, 0.3 + (totalMatches * 0.1));
  return {
    confidence,
    plan: `Keyword match: ${keywordMatches.join(', ') || capMatches.join(', ')}`,
    fallback: true
  };
}

/**
 * Evaluate bid with timeout and circuit breaker protection
 */
async function evaluateBidWithFallback(agent, task) {
  // Check circuit breaker
  if (BID_CIRCUIT.isOpen()) {
    console.log(`[BidEval] Circuit open, using keyword fallback for ${agent.name}`);
    return keywordFallbackBid(agent, task);
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
    console.warn(`[BidEval] LLM failed for ${agent.name}: ${error.message}, using fallback`);
    return keywordFallbackBid(agent, task);
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
let pendingInputContexts = new Map(); // agentId -> { context, field, options } for multi-turn conversations
let taskExecutionStartTimes = new Map(); // taskId -> startTime (for tracking execution duration)

// ==================== CONVERSATION HISTORY ====================
// Track conversation turns so agents have full context
// Format: [{ role: 'user'|'assistant', content: string, timestamp: number, agentId?: string }]
let conversationHistory = [];
const CONVERSATION_CONFIG = {
  maxHistoryChars: 4000,        // Max characters to include in agent context
  maxTurns: 20,                 // Max turns to keep in memory
  historyTimeoutMs: 5 * 60000,  // Clear history after 5 minutes of inactivity
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
  
  console.log(`[ConversationHistory] Added ${role} turn, total: ${conversationHistory.length}`);
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
 * Clear conversation history
 */
function clearHistory() {
  conversationHistory = [];
  console.log('[ConversationHistory] Cleared');
}

/**
 * Reset the history timeout
 */
function resetHistoryTimeout() {
  if (historyTimeoutId) {
    clearTimeout(historyTimeoutId);
  }
  historyTimeoutId = setTimeout(() => {
    if (pendingInputContexts.size === 0) {
      clearHistory();
    }
  }, CONVERSATION_CONFIG.historyTimeoutMs);
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
          console.log(`[InputSchema] Skipping ${field} - askWhen returned false`);
          continue;
        }
      } catch (e) {
        console.warn(`[InputSchema] askWhen function error for ${field}:`, e.message);
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
        console.warn(`[InputSchema] Skip function error for ${field}:`, e.message);
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
  
  console.log(`[InputSchema] Gathered ${field}: "${updated[field]}"`);
  return updated;
}

/**
 * Execute agent with input schema support
 * Automatically gathers required inputs before calling execute()
 * @param {Object} agent - The agent (with optional inputs schema)
 * @param {Object} task - The task to execute
 * @returns {Promise<Object>} - Execution result
 */
async function executeWithInputSchema(agent, task) {
  // Check if agent has input schema
  if (!hasInputSchema(agent)) {
    // No schema, execute directly
    return await agent.execute(task);
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
    console.log(`[InputSchema] Agent ${agent.id} needs input: ${missing.field}`);
    return buildInputRequest(
      agent.id,
      missing.field,
      missing.schema,
      gatheredInputs,
      task.context
    );
  }
  
  // All inputs gathered - execute with inputs attached to task
  console.log(`[InputSchema] All inputs gathered for ${agent.id}:`, Object.keys(gatheredInputs));
  const enrichedTask = {
    ...task,
    inputs: gatheredInputs,
    context: {
      ...task.context,
      inputs: gatheredInputs
    }
  };
  
  return await agent.execute(enrichedTask);
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
console.log(`[ExchangeBridge] Auto-generated ${agentCategories.length} categories from agent declarations`);

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
    maxAuctionAttempts: 2,   // Quick retry
    executionTimeoutMs: 10000, // 10s for voice tasks
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
    console.warn('[ExchangeBridge] Already connecting agents, skipping duplicate call');
    return;
  }
  isConnectingAgents = true;
  
  try {
    const enabledAgents = getEnabledBuiltInAgents();
    console.log(`[ExchangeBridge] Connecting ${enabledAgents.length} built-in agents to exchange`);
    
    // Initialize memory files for all built-in agents
    try {
      const { initializeBuiltInAgentMemories } = require('../../lib/agent-memory-store');
      const memoryResults = initializeBuiltInAgentMemories(enabledAgents);
      if (memoryResults.created.length > 0) {
        console.log(`[ExchangeBridge] Created ${memoryResults.created.length} agent memory files`);
      }
    } catch (error) {
      console.warn('[ExchangeBridge] Could not initialize agent memories:', error.message);
      // Non-fatal - continue without memories
    }
    
    for (const agent of enabledAgents) {
      // Skip if already connected
      if (localAgentConnections.has(agent.id)) {
        console.log(`[ExchangeBridge] Agent ${agent.id} already connected, skipping`);
        continue;
      }
      
      try {
        const wrappedAgent = wrapBuiltInAgent(agent);
        await connectBuiltInAgentToExchange(wrappedAgent, port);
      } catch (error) {
        console.error(`[ExchangeBridge] Failed to connect built-in agent ${agent.id}:`, error.message);
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
      console.log(`[ExchangeBridge] Agent ${wrappedAgent.id} already has active connection, skipping`);
      return Promise.resolve();
    }
  }
  
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const originalAgent = wrappedAgent._builtIn;
    let heartbeatInterval = null;
    
    ws.on('open', () => {
      console.log(`[ExchangeBridge] Built-in agent connecting: ${wrappedAgent.name}`);
      
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
      console.log(`[ExchangeBridge] Built-in agent registered: ${wrappedAgent.name}`);
      resolve();
    });
    
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // ==================== BUILT-IN AGENT BIDDING ====================
        if (msg.type === 'bid_request') {
          console.log(`[BuiltIn:${wrappedAgent.name}] Evaluating bid request`);
          
          // Built-in agents use their own bid() method if available
          // Use LLM-based bidding for all agents (not keyword matching)
          let evaluation = { confidence: 0, plan: null };
          
          try {
            // Import unified bidder for LLM evaluation
            const { evaluateAgentBid } = require('../../packages/agents/unified-bidder');
            
            // Build agent definition for LLM evaluation
            const agentDef = {
              id: wrappedAgent.id,
              name: wrappedAgent.name,
              keywords: wrappedAgent.keywords || originalAgent.keywords || [],
              capabilities: wrappedAgent.capabilities || originalAgent.capabilities || [],
              prompt: originalAgent.prompt || originalAgent.description || wrappedAgent.name,
              executionType: originalAgent.executionType || 'builtin'
            };
            
            // Use LLM to evaluate with 3-second timeout
            const llmResult = await Promise.race([
              evaluateAgentBid(agentDef, msg.task),
              new Promise((_, reject) => setTimeout(() => reject(new Error('LLM timeout')), 3000))
            ]);
            
            evaluation = {
              confidence: llmResult.confidence || 0,
              plan: llmResult.plan || llmResult.reasoning || 'LLM evaluated match',
            };
            console.log(`[BuiltIn:${wrappedAgent.name}] LLM bid: ${evaluation.confidence.toFixed(2)} - ${llmResult.reasoning || ''}`);
          } catch (e) {
            console.warn(`[BuiltIn:${wrappedAgent.name}] LLM bid failed, using keyword fallback:`, e.message);
            // Fallback to keyword matching if LLM fails
            evaluation = keywordFallbackBid(wrappedAgent, msg.task);
          }
          
          console.log(`[BuiltIn:${wrappedAgent.name}] Bid evaluation: ${evaluation.confidence.toFixed(2)}`);
          
          if (evaluation.confidence > 0.1) {
            ws.send(JSON.stringify({
              type: 'bid_response',
              auctionId: msg.auctionId,
              agentId: wrappedAgent.id,
              agentVersion: wrappedAgent.version,
              bid: {
                confidence: evaluation.confidence,
                reasoning: evaluation.plan,
                estimatedTimeMs: 2000,
                tier: 'builtin',
              }
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'bid_response',
              auctionId: msg.auctionId,
              agentId: wrappedAgent.id,
              agentVersion: wrappedAgent.version,
              bid: null
            }));
          }
        }
        // ==================== BUILT-IN AGENT EXECUTION ====================
        else if (msg.type === 'task_assignment') {
          console.log(`[BuiltIn:${wrappedAgent.name}] Executing task: ${msg.task?.content?.slice(0, 50)}...`);
          
          try {
            let result;
            if (originalAgent.execute && typeof originalAgent.execute === 'function') {
              // Use input schema processor for declarative input gathering
              result = await executeWithInputSchema(originalAgent, msg.task);
            } else {
              result = { success: false, error: 'Agent has no execute method' };
            }
            
            ws.send(JSON.stringify({
              type: 'task_result',
              taskId: msg.taskId,
              result: {
                success: result.success,
                output: result.message || result.result,
                data: result.data,
                error: result.success ? undefined : result.error,
                needsInput: result.needsInput, // Pass through for multi-turn conversations
              }
            }));
          } catch (execError) {
            ws.send(JSON.stringify({
              type: 'task_result',
              taskId: msg.taskId,
              result: { success: false, error: execError.message }
            }));
          }
        }
        else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      } catch (error) {
        console.error(`[BuiltIn:${wrappedAgent.name}] Message error:`, error.message);
      }
    });
    
    ws.on('error', (error) => {
      console.error(`[ExchangeBridge] Built-in agent WebSocket error (${wrappedAgent.name}):`, error.message);
      // Clean up heartbeat on error
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      reject(error);
    });
    
    ws.on('close', (code) => {
      console.log(`[ExchangeBridge] Built-in agent disconnected: ${wrappedAgent.name} (code: ${code})`);
      // Clean up heartbeat interval
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      const conn = localAgentConnections.get(wrappedAgent.id);
      localAgentConnections.delete(wrappedAgent.id);
      
      // Attempt reconnection if not shutting down and not a clean close
      if (!isShuttingDown && code !== 1000) {
        const attempts = (conn?.reconnectAttempts || 0) + 1;
        if (attempts <= RECONNECT_CONFIG.maxAttempts) {
          const delay = Math.min(
            RECONNECT_CONFIG.baseDelayMs * Math.pow(2, attempts - 1),
            RECONNECT_CONFIG.maxDelayMs
          );
          console.log(`[ExchangeBridge] Reconnecting ${wrappedAgent.name} in ${delay}ms (attempt ${attempts}/${RECONNECT_CONFIG.maxAttempts})`);
          setTimeout(async () => {
            try {
              await connectBuiltInAgentToExchange(wrappedAgent, currentExchangePort);
              // Store reconnect attempts for tracking
              const newConn = localAgentConnections.get(wrappedAgent.id);
              if (newConn) {
                newConn.reconnectAttempts = 0; // Reset on success
              }
            } catch (e) {
              console.error(`[ExchangeBridge] Reconnect failed for ${wrappedAgent.name}:`, e.message);
              // Will try again on next disconnect
            }
          }, delay);
        } else {
          console.error(`[ExchangeBridge] Max reconnect attempts reached for ${wrappedAgent.name}`);
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
      console.log('[ExchangeBridge] Agent store not ready, skipping custom agents');
      return;
    }
    
    const agents = await agentStore.getAllAgents();
    console.log(`[ExchangeBridge] Found ${agents.length} custom agents to connect`);
    
    // Initialize memory files for all enabled custom agents
    const enabledAgents = agents.filter(a => a.enabled);
    if (enabledAgents.length > 0) {
      try {
        const { ensureAgentMemories } = require('../../lib/agent-memory-store');
        const memoryResults = ensureAgentMemories(enabledAgents);
        if (memoryResults.created.length > 0) {
          console.log(`[ExchangeBridge] Created ${memoryResults.created.length} custom agent memory files`);
        }
      } catch (error) {
        console.warn('[ExchangeBridge] Could not initialize custom agent memories:', error.message);
      }
    }
    
    for (const agent of agents) {
      if (!agent.enabled) continue;
      
      try {
        await connectLocalAgent(agent, port);
      } catch (error) {
        console.error(`[ExchangeBridge] Failed to connect agent ${agent.name}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[ExchangeBridge] Failed to load custom agents:', error.message);
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
      console.log(`[ExchangeBridge] Local agent connecting: ${agent.name}`);
      
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
      console.log(`[ExchangeBridge] Local agent registered: ${agent.name}`);
      resolve();
    });
    
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // ==================== DISTRIBUTED BIDDING ====================
        // Exchange sends 'bid_request' - each agent evaluates independently
        if (msg.type === 'bid_request') {
          const startTime = Date.now();
          console.log(`[Agent:${agent.name}] Received bid_request for: "${msg.task?.content?.slice(0, 50)}..."`);
          
          // Use circuit-breaker protected LLM evaluation with keyword fallback
          const evaluation = await evaluateBidWithFallback(agent, msg.task);
          const evalTime = Date.now() - startTime;
          
          console.log(`[Agent:${agent.name}] Bid evaluation: confidence=${evaluation.confidence.toFixed(2)}, time=${evalTime}ms, fallback=${evaluation.fallback || false}`);
          
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
            console.log(`[Agent:${agent.name}] Submitted bid: ${evaluation.confidence.toFixed(2)}`);
          } else {
            // Send empty bid response (declined)
            ws.send(JSON.stringify({
              type: 'bid_response',
              auctionId: msg.auctionId,
              agentId: agent.id,
              agentVersion: agent.version || '1.0.0',
              bid: null  // No bid - not confident
            }));
            console.log(`[Agent:${agent.name}] Declined to bid (confidence too low)`);
          }
        }
        // ==================== TASK ASSIGNMENT ====================
        // Exchange picks winner and sends 'task_assignment'
        else if (msg.type === 'task_assignment') {
          console.log(`[Agent:${agent.name}] Won auction! Executing: "${msg.task?.content?.slice(0, 50)}..."`);
          
          const startTime = Date.now();
          try {
            const result = await executeLocalAgent(agent, msg.task);
            const execTime = Date.now() - startTime;
            
            console.log(`[Agent:${agent.name}] Execution complete: success=${result.success}, time=${execTime}ms`);
            
            ws.send(JSON.stringify({
              type: 'task_result',
              taskId: msg.taskId,
              result: {
                success: result.success,
                output: result.result || result.error,
                error: result.success ? undefined : result.error,
              }
            }));
          } catch (execError) {
            console.error(`[Agent:${agent.name}] Execution failed:`, execError.message);
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
        console.error(`[Agent:${agent.name}] Message handling error:`, error.message);
        // Don't crash - log and continue
      }
    });
    
    ws.on('error', (error) => {
      console.error(`[ExchangeBridge] Local agent WebSocket error (${agent.name}):`, error.message);
      // Clean up heartbeat on error
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      reject(error);
    });
    
    ws.on('close', (code) => {
      console.log(`[ExchangeBridge] Local agent disconnected: ${agent.name} (code: ${code})`);
      // Clean up heartbeat interval
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      const conn = localAgentConnections.get(agent.id);
      localAgentConnections.delete(agent.id);
      
      // Attempt reconnection if not shutting down and not a clean close
      if (!isShuttingDown && code !== 1000 && agent.enabled !== false) {
        const attempts = (conn?.reconnectAttempts || 0) + 1;
        if (attempts <= RECONNECT_CONFIG.maxAttempts) {
          const delay = Math.min(
            RECONNECT_CONFIG.baseDelayMs * Math.pow(2, attempts - 1),
            RECONNECT_CONFIG.maxDelayMs
          );
          console.log(`[ExchangeBridge] Reconnecting ${agent.name} in ${delay}ms (attempt ${attempts}/${RECONNECT_CONFIG.maxAttempts})`);
          setTimeout(async () => {
            try {
              await connectLocalAgent(agent, currentExchangePort);
              // Reset reconnect attempts on success
              const newConn = localAgentConnections.get(agent.id);
              if (newConn) {
                newConn.reconnectAttempts = 0;
              }
            } catch (e) {
              console.error(`[ExchangeBridge] Reconnect failed for ${agent.name}:`, e.message);
            }
          }, delay);
        } else {
          console.error(`[ExchangeBridge] Max reconnect attempts reached for ${agent.name}`);
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
async function executeLocalAgent(agent, task) {
  const executionType = agent.executionType || 'llm';
  const content = task.content || '';
  
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
      
      return {
        success: true,
        result: response,
      };
    }
  } catch (error) {
    console.error(`[ExchangeBridge] Agent execution error:`, error.message);
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
function getSuggestionsForTask(content) {
  if (!content) return [];
  
  const text = content.toLowerCase();
  const suggestions = [];
  
  // Check for partial matches with known commands
  const knownCommands = [
    { keywords: ['play', 'music', 'song'], suggestion: 'play music' },
    { keywords: ['spell', 'letter', 'word'], suggestion: 'spell a word' },
    { keywords: ['open', 'launch', 'start'], suggestion: 'open an app' },
    { keywords: ['search', 'find', 'look'], suggestion: 'search for something' },
    { keywords: ['volume', 'loud', 'quiet'], suggestion: 'adjust volume' },
    { keywords: ['create', 'make', 'new', 'agent'], suggestion: 'create an agent' },
    { keywords: ['time', 'date', 'day'], suggestion: 'what time is it' },
    { keywords: ['weather', 'temperature'], suggestion: 'check the weather' },
  ];
  
  for (const cmd of knownCommands) {
    // Check if any keyword partially matches the content
    const hasPartialMatch = cmd.keywords.some(kw => {
      // Fuzzy match - at least 60% of characters match
      if (text.includes(kw) || kw.includes(text)) return true;
      
      // Levenshtein-like check for short words
      for (const word of text.split(/\s+/)) {
        if (word.length >= 3 && kw.length >= 3) {
          const common = [...word].filter(c => kw.includes(c)).length;
          if (common >= Math.min(word.length, kw.length) * 0.6) return true;
        }
      }
      return false;
    });
    
    if (hasPartialMatch) {
      suggestions.push(cmd.suggestion);
    }
  }
  
  // Limit to top 3 suggestions
  return suggestions.slice(0, 3);
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
    
    console.log('[ExchangeBridge] Media command executed:', action);
    
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
    console.error('[ExchangeBridge] Media command error:', error.message);
    
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
        console.error('[ExchangeBridge] Failed to launch and play:', launchError.message);
      }
    }
    
    return null; // Let it fall through to the exchange
  }
}

/**
 * Broadcast message to all windows
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
    console.log(`[ExchangeBridge] Notification: ${event.message}`);
    
    // Speak the notification
    if (global.speakFeedback) {
      global.speakFeedback(event.message);
    }
    
    // Also broadcast to windows
    broadcastToWindows('voice-task:notification', event);
  });
  
  console.log('[ExchangeBridge] Notification listener setup');
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
      const { getRealtimeSpeech } = require('../../realtime-speech');
      const realtimeSpeech = getRealtimeSpeech();
      
      if (realtimeSpeech && realtimeSpeech.isConnected) {
        await realtimeSpeech.speak(message);
        return true;
      } else {
        console.warn('[AgentMessageQueue] Speech system not connected');
        return false;
      }
    } catch (e) {
      console.error('[AgentMessageQueue] Speak error:', e.message);
      return false;
    }
  });
  
  // Set up canSpeak function - check if system is idle
  queue.setCanSpeakFunction(() => {
    // Don't speak if there's a pending input context (agent waiting for response)
    if (pendingInputContexts.size > 0) {
      return false;
    }
    
    // Check if realtime speech is available and not busy
    try {
      const { getRealtimeSpeech } = require('../../realtime-speech');
      const realtimeSpeech = getRealtimeSpeech();
      
      if (!realtimeSpeech || !realtimeSpeech.isConnected) {
        return false;
      }
      
      // Check if speech queue is empty
      if (realtimeSpeech.speechQueue && realtimeSpeech.speechQueue.hasPendingOrActiveSpeech()) {
        return false;
      }
      
      // Check if there's an active response
      if (realtimeSpeech.hasActiveResponse) {
        return false;
      }
      
      return true;
    } catch (e) {
      return false;
    }
  });
  
  // Make queue available globally for agents
  global.agentMessageQueue = queue;
  
  console.log('[ExchangeBridge] Agent message queue setup');
}

/**
 * Initialize the exchange bridge
 */
async function initializeExchangeBridge(config = {}) {
  console.log('[ExchangeBridge] Initializing...');
  
  // MANDATORY: Check for OpenAI API key - required for LLM-based agent bidding
  const { ready, error } = checkBidderReady();
  if (!ready) {
    console.warn('[ExchangeBridge] WARNING:', error);
    console.warn('[ExchangeBridge] Custom agents will not be able to bid on tasks without an API key.');
    // We continue initialization but agents won't work without the key
    // This allows the UI to load and prompt user to add key
  }
  
  // Try to load the compiled exchange package
  try {
    const exchangePkg = require('../../packages/task-exchange/dist/index.js');
    Exchange = exchangePkg.Exchange;
    WebSocketTransport = exchangePkg.WebSocketTransport;
    MemoryStorage = exchangePkg.MemoryStorage;
    console.log('[ExchangeBridge] Loaded task-exchange package');
  } catch (error) {
    console.error('[ExchangeBridge] Failed to load task-exchange:', error.message);
    console.log('[ExchangeBridge] Make sure to run: cd packages/task-exchange && npm run build');
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
    console.log(`[ExchangeBridge] Exchange running on port ${mergedConfig.port}`);
    
    // Setup notification manager
    setupNotificationListener();
    
    // Setup agent message queue for proactive messages
    setupAgentMessageQueue();
    
    // Register IPC handlers
    setupExchangeIPC();
    
    // ==================== CONNECT ALL AGENTS TO EXCHANGE ====================
    // 1. Connect built-in agents (time, weather, media, etc.)
    await connectBuiltInAgents(mergedConfig.port);
    
    // 2. Connect custom agents from agent-store
    await connectCustomAgents(mergedConfig.port);
    
    console.log(`[ExchangeBridge] All agents connected. Total: ${localAgentConnections.size}`);
    
    return true;
  } catch (error) {
    console.error('[ExchangeBridge] Failed to start exchange:', error);
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
    console.log('[ExchangeBridge] Task queued:', task.id);
    
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
  });
  
  // Auction started
  exchangeInstance.on('auction:started', ({ task, auctionId }) => {
    console.log('[ExchangeBridge] Auction started:', auctionId);
    
    if (global.showCommandHUD) {
      global.showCommandHUD({
        id: task.id,
        transcript: task.content,
        action: 'Finding agent...',
        status: 'running',
      });
    }
  });
  
  // No bids received - task halted - try disambiguation
  exchangeInstance.on('exchange:halt', ({ task, reason }) => {
    console.warn('[ExchangeBridge] Exchange halted:', reason);
    
    const content = task?.content || '';
    
    // Check if this looks like a garbled transcription
    const isGarbled = isLikelyGarbledTranscription(content);
    
    if (isGarbled) {
      // Ask for clarification - transcription seems wrong
      console.log('[ExchangeBridge] Transcription appears garbled, asking for clarification');
      
      const clarificationMessage = "I didn't quite catch that. Could you say that again?";
      
      // NOTE: With function calling, frontend handles TTS - don't call speakFeedback
      
      if (global.sendCommandHUDResult) {
        global.sendCommandHUDResult({
          success: false,
          needsClarification: true,
          message: clarificationMessage,
        });
      }
    } else {
      // Task was clear but no agent can handle it - offer suggestions
      console.log('[ExchangeBridge] No agents for task, offering disambiguation');
      
      const suggestions = getSuggestionsForTask(content);
      
      let clarificationMessage;
      if (suggestions.length > 0) {
        clarificationMessage = `I'm not sure what you meant by "${content}". Did you mean: ${suggestions.join(', or ')}?`;
      } else {
        clarificationMessage = `I don't have an agent that can handle "${content}". Try saying something like: play music, spell a word, or create an agent.`;
      }
      
      // NOTE: With function calling, frontend handles TTS - don't call speakFeedback
      
      if (global.sendCommandHUDResult) {
        global.sendCommandHUDResult({
          success: false,
          needsClarification: true,
          suggestions,
          message: clarificationMessage,
        });
      }
    }
  });
  
  // Task assigned to winner
  exchangeInstance.on('task:assigned', ({ task, winner, backups }) => {
    console.log('[ExchangeBridge] Task assigned to:', winner.agentId);
    
    // Track execution start time for duration calculation
    taskExecutionStartTimes.set(task.id, Date.now());
    
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
      console.warn('[ExchangeBridge] Stats tracking error:', e.message);
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
  });
  
  // Task completed successfully
  exchangeInstance.on('task:settled', async ({ task, result, agentId }) => {
    console.log('[ExchangeBridge] Task settled by:', agentId);
    
    // Calculate execution duration
    const startTime = taskExecutionStartTimes.get(task.id);
    const executionDurationMs = startTime ? Date.now() - startTime : null;
    taskExecutionStartTimes.delete(task.id); // Clean up
    
    if (executionDurationMs !== null) {
      console.log(`[ExchangeBridge] Task execution time: ${executionDurationMs}ms`);
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
      console.warn('[ExchangeBridge] Stats tracking error:', e.message);
    }
    
    // Phase 1: Check if this task was cancelled (late result suppression)
    if (routerInstance?.cancelledTaskIds?.has(task.id)) {
      console.log('[ExchangeBridge] Suppressing late result for cancelled task:', task.id);
      routerInstance.cancelledTaskIds.delete(task.id);
      return;
    }
    
    // Check for multi-turn conversation (needsInput)
    if (result.needsInput) {
      console.log('[ExchangeBridge] Agent needs input:', result.needsInput.prompt);
      
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
      console.log(`[ExchangeBridge] Stored pending input context for agent: ${pendingAgentId}, pendingInputContexts.size: ${pendingInputContexts.size}`);
      
      // Send the prompt to be spoken + context info
      if (global.sendCommandHUDResult) {
        global.sendCommandHUDResult({
          success: true,
          message: result.needsInput.prompt,
          needsInput: true,
          data: result.data,
          agentId: result.needsInput.agentId || agentId,
          agentName: (result.needsInput.agentId || agentId).replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          pendingContext: { agents: [result.needsInput.agentId || agentId] },
        });
      }
      
      // DIRECT TTS - Speak the prompt immediately via realtime speech
      // This ensures TTS works even if event-based approach has race conditions
      try {
        const { getRealtimeSpeech } = require('../../realtime-speech');
        const realtimeSpeech = getRealtimeSpeech();
        console.log('[ExchangeBridge] Got realtimeSpeech instance:', !!realtimeSpeech, 'isConnected:', realtimeSpeech?.isConnected);
        
        if (realtimeSpeech && result.needsInput.prompt) {
          console.log('[ExchangeBridge] Speaking needsInput prompt directly:', result.needsInput.prompt);
          // Await the speak call to ensure it's queued
          const speakResult = await realtimeSpeech.speak(result.needsInput.prompt);
          console.log('[ExchangeBridge] Speak result:', speakResult);
        } else {
          console.warn('[ExchangeBridge] Cannot speak: realtimeSpeech=', !!realtimeSpeech, 'prompt=', !!result.needsInput.prompt);
        }
      } catch (e) {
        console.error('[ExchangeBridge] Direct TTS failed:', e.message, e.stack);
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
    
    const message = result.output || result.data?.message || (result.success ? 'All done' : null);
    
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
        data: result.data,
        agentId,
        agentName: agentId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      });
    }
    
    // DIRECT TTS - Speak the result directly via realtime speech
    // For async tasks, respondToFunctionCall already completed with empty response
    // so we need to speak the actual result here
    if (message && message !== 'All done') {
      try {
        const { getRealtimeSpeech } = require('../../realtime-speech');
        const realtimeSpeech = getRealtimeSpeech();
        console.log('[ExchangeBridge] Got realtimeSpeech for result:', !!realtimeSpeech, 'isConnected:', realtimeSpeech?.isConnected);
        
        if (realtimeSpeech) {
          console.log('[ExchangeBridge] Speaking task result directly:', message.slice(0, 50));
          const speakResult = await realtimeSpeech.speak(message);
          console.log('[ExchangeBridge] Speak result for task completion:', speakResult);
        }
      } catch (e) {
        console.error('[ExchangeBridge] Direct TTS for result failed:', e.message, e.stack);
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
    console.log('[ExchangeBridge] Task executing by:', agentId);
    
    if (global.showCommandHUD) {
      global.showCommandHUD({
        id: task.id,
        transcript: task.content,
        action: 'Processing...',
        status: 'running',
      });
    }
    
    // Don't speak here - too granular, would interrupt flow
  });
  
  // Task failed, trying backup
  exchangeInstance.on('task:busted', ({ task, agentId, error, backupsRemaining }) => {
    console.log('[ExchangeBridge] Task busted, backups remaining:', backupsRemaining);
    
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
  });
  
  // Task dead-lettered (all retries exhausted)
  exchangeInstance.on('task:dead_letter', ({ task, reason }) => {
    console.error('[ExchangeBridge] Task dead-lettered:', reason);
    
    if (global.sendCommandHUDResult) {
      global.sendCommandHUDResult({
        success: false,
        error: reason,
        message: 'Could not complete request',
      });
    }
    
    // NOTE: Don't call speakFeedback - error message returned via respondToFunctionCall
    
    broadcastToWindows('voice-task:failed', {
      taskId: task.id,
      reason,
    });
  });
  
  // Task cancelled
  exchangeInstance.on('task:cancelled', ({ task, reason }) => {
    console.log('[ExchangeBridge] Task cancelled:', task.id, reason);
    
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
  });
  
  // Agent connected
  exchangeInstance.on('agent:connected', ({ agent }) => {
    console.log('[ExchangeBridge] Agent connected:', agent.id);
    broadcastToWindows('voice-task:agent-connected', { agent });
  });
  
  // Agent disconnected
  exchangeInstance.on('agent:disconnected', ({ agentId, reason }) => {
    console.log('[ExchangeBridge] Agent disconnected:', agentId, reason);
    broadcastToWindows('voice-task:agent-disconnected', { agentId, reason });
  });
  
  // Agent flagged for review
  exchangeInstance.on('agent:flagged', ({ agentId, reputation }) => {
    console.warn('[ExchangeBridge] Agent flagged:', agentId, reputation.score);
  });
}

/**
 * Setup IPC handlers for the exchange
 */
function setupExchangeIPC() {
  // Remove existing handlers that we're going to override
  const handlersToOverride = [
    'voice-task-sdk:submit',
    'voice-task-sdk:exchange-status',
    'voice-task-sdk:list-agents',
    'voice-task-sdk:reputation-summary',
  ];
  
  for (const handler of handlersToOverride) {
    try {
      ipcMain.removeHandler(handler);
    } catch (e) {
      // Handler may not exist, that's fine
    }
  }
  
  ipcMain.handle('voice-task-sdk:submit', async (_event, transcript, options = {}) => {
    console.log('[ExchangeBridge] Submit transcript:', transcript);
    console.log(`[ExchangeBridge] pendingInputContexts.size: ${pendingInputContexts.size}`);
    const log = getLogger();
    
    // Record activity for message queue (resets idle timer)
    const messageQueue = getAgentMessageQueue();
    messageQueue.recordActivity();
    
    // Add user message to conversation history
    addToHistory('user', transcript);
    
    // ==================== CHECK FOR PENDING AGENT INPUT ====================
    // If an agent asked for input (needsInput), route the response back to that agent
    if (pendingInputContexts.size > 0) {
      // Get the first pending context (usually only one agent asks at a time)
      const [agentId, pendingContext] = pendingInputContexts.entries().next().value;
      console.log(`[ExchangeBridge] Found pending input for agent: ${agentId}`);
      
      // Clear the pending context
      pendingInputContexts.delete(agentId);
      
      // Find the agent and re-execute with the user's response
      const agent = allBuiltInAgentMap[agentId];
      if (agent && agent.execute) {
        try {
          console.log(`[ExchangeBridge] Routing follow-up to ${agentId}:`, transcript);
          
          // Build task with user's input, saved context, and conversation history
          const followUpTask = {
            id: `task_${Date.now()}`,
            content: transcript,
            context: {
              ...pendingContext.context,
              userInput: transcript,
              conversationHistory: getRecentHistory(),
              conversationText: formatHistoryForAgent(),
            }
          };
          
          // Execute the agent with the follow-up (using input schema processor)
          const result = await executeWithInputSchema(agent, followUpTask);
          
          // Check if agent needs more input
          if (result.needsInput) {
            console.log('[ExchangeBridge] Agent needs more input:', result.needsInput.prompt);
            // Add assistant prompt to history
            addToHistory('assistant', result.needsInput.prompt, agentId);
            const pendingAgentId = result.needsInput.agentId || agentId;
            pendingInputContexts.set(pendingAgentId, {
              taskId: followUpTask.id,
              agentId: pendingAgentId,
              context: result.needsInput.context,
              field: result.needsInput.field,
              options: result.needsInput.options,
            });
            console.log(`[ExchangeBridge] Stored pending input context for agent: ${pendingAgentId}, pendingInputContexts.size: ${pendingInputContexts.size}`);
            
            // SPEAK the follow-up question directly via speech queue
            const prompt = result.needsInput.prompt;
            if (prompt) {
              try {
                const { getRealtimeSpeech } = require('../../realtime-speech');
                const realtimeSpeech = getRealtimeSpeech();
                if (realtimeSpeech) {
                  console.log('[ExchangeBridge] Speaking follow-up prompt via realtime speech');
                  await realtimeSpeech.speak(prompt);
                }
              } catch (speakErr) {
                console.error('[ExchangeBridge] Failed to speak follow-up prompt:', speakErr.message);
              }
            }
            
            // Update HUD with context
            if (global.sendCommandHUDResult) {
              global.sendCommandHUDResult({
                success: true,
                message: prompt,
                needsInput: true,
                agentId: pendingAgentId,
                agentName: pendingAgentId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
                pendingContext: { agents: [pendingAgentId] },
              });
            }
            
            return {
              transcript,
              queued: false,
              handled: true,
              classified: true,
              action: 'agent-input-needed',
              message: prompt,
              needsInput: true,
              suppressAIResponse: true, // We already spoke it
            };
          }
          
          // Task completed - speak the result via speech queue
          const completedMessage = result.message || 'Done!';
          // Add assistant response to history
          addToHistory('assistant', completedMessage, agentId);
          if (completedMessage && completedMessage !== 'Done!') {
            try {
              const { getRealtimeSpeech } = require('../../realtime-speech');
              const realtimeSpeech = getRealtimeSpeech();
              if (realtimeSpeech) {
                console.log('[ExchangeBridge] Speaking follow-up completion via realtime speech');
                await realtimeSpeech.speak(completedMessage);
              }
            } catch (speakErr) {
              console.error('[ExchangeBridge] Failed to speak completion:', speakErr.message);
            }
          }
          
          return {
            transcript,
            queued: false,
            handled: true,
            classified: true,
            action: 'agent-completed',
            message: completedMessage,
            suppressAIResponse: completedMessage !== 'Done!', // Suppress if we already spoke
          };
          
        } catch (error) {
          console.error('[ExchangeBridge] Follow-up execution error:', error);
          return {
            transcript,
            queued: false,
            handled: false,
            error: error.message,
          };
        }
      }
    }
    // ==================== END PENDING AGENT INPUT ====================
    
    // ==================== PHASE 1: ROUTER INTEGRATION ====================
    // Initialize router if needed
    if (!routerInstance && exchangeInstance) {
      routerInstance = createRouter(
        {
          submit: async (task) => {
            // Wrap exchange submit to return normalized results
            try {
              const { taskId } = await exchangeInstance.submit({
                content: task.content,
                priority: 2,
                metadata: { source: 'voice', timestamp: Date.now() }
              });
              // Wait for result via events (handled elsewhere)
              // For now, return that we're processing
              return { success: true, queued: true, taskId };
            } catch (error) {
              return { success: false, message: error.message };
            }
          },
          cancel: (taskId) => {
            // Exchange cancel if available
            if (exchangeInstance?.cancelTask) {
              exchangeInstance.cancelTask(taskId);
            }
          }
        },
        (message) => {
          // NOTE: Progress messages during function call processing would conflict
          // with respondToFunctionCall. Just log them for now.
          // Future: Could aggregate progress messages into final response
          console.log('[Router] Progress:', message);
        }
      );
      log.info('ExchangeBridge', 'Router initialized');
    }
    
    // Use Router for critical commands (cancel, repeat, undo)
    if (routerInstance) {
      const text = transcript?.toLowerCase()?.trim() || '';
      
      // Check for critical commands that Router handles directly
      if (['cancel', 'stop', 'nevermind', 'never mind', 'repeat', 'say that again', 
           'undo', 'undo that', 'take that back'].some(cmd => text === cmd || text.startsWith(cmd + ' '))) {
        log.info('ExchangeBridge', 'Routing to Router for critical command');
        const result = await routerInstance.handle(transcript);
        
        if (result.handled) {
          // NOTE: Don't call speakFeedback here!
          // The message is returned to the frontend which calls respondToFunctionCall()
          // Calling speakFeedback would create a SECOND response, causing:
          // "conversation_already_has_active_response" error
          return {
            transcript,
            queued: false,
            handled: true,
            classified: true,
            action: result.type || 'router-handled',
            message: result.speak,
            suppressAIResponse: false,  // Let respondToFunctionCall speak this
          };
        }
      }
      
      // Check for pending state (question or confirmation)
      const routingContext = conversationState.getRoutingContext();
      if (routingContext.hasPendingQuestion || routingContext.hasPendingConfirmation) {
        log.info('ExchangeBridge', 'Routing to Router for pending state resolution');
        const result = await routerInstance.handle(transcript);
        
        if (result.handled) {
          // NOTE: Don't call speakFeedback - let respondToFunctionCall handle it
          return {
            transcript,
            queued: false,
            handled: true,
            classified: true,
            action: result.type || 'state-resolved',
            message: result.speak,
            suppressAIResponse: false,  // Let respondToFunctionCall speak this
          };
        }
      }
    }
    // ==================== END PHASE 1: ROUTER INTEGRATION ====================
    
    // ==================== PHASE 1: BUILT-IN AGENT HANDLING ====================
    // Try built-in agents before sending to exchange
    const task = { id: `task_${Date.now()}`, content: transcript };
    console.log('[ExchangeBridge] Phase 1: Checking built-in agents for:', transcript);
    
    // STEP 1: Add task to HUD (visual feedback)
    if (global.showCommandHUD) {
      global.showCommandHUD({
        id: task.id,
        transcript: task.content,
        action: 'Processing',
        status: 'queued',
      });
    }
    broadcastToWindows('voice-task:queued', {
      taskId: task.id,
      content: task.content,
      timestamp: Date.now(),
    });
    
    // ==================== DISTRIBUTED EXCHANGE-BASED ROUTING ====================
    // Submit task to Exchange - agents bid independently, Exchange picks winner
    // Events (setupExchangeEvents) handle HUD updates and results
    
    if (!exchangeInstance || !isExchangeRunning) {
      console.warn('[ExchangeBridge] Exchange not running, cannot process task');
      return {
        transcript,
        queued: false,
        handled: true,
        classified: false,
        message: "I'm not ready yet. Please try again in a moment.",
        suppressAIResponse: false,
      };
    }
    
    try {
      console.log(`[ExchangeBridge] Submitting to exchange: "${transcript.slice(0, 50)}..."`);
      console.log(`[ExchangeBridge] Connected agents: ${localAgentConnections.size}`);
      
      const { taskId, task: submittedTask } = await exchangeInstance.submit({
        content: transcript,
        priority: 2, // NORMAL priority
        metadata: {
          source: 'voice',
          timestamp: Date.now(),
          // Include conversation history for agent context
          conversationHistory: getRecentHistory(),
          conversationText: formatHistoryForAgent(),
        },
      });
      
      console.log(`[ExchangeBridge] Task submitted: ${taskId}`);
      
      // Return immediately - Exchange events will handle the rest:
      // - auction:started → HUD shows "Finding agent..."
      // - task:assigned → HUD shows winner executing
      // - task:settled → HUD shows result, speaks response
      // - exchange:halt → No bids, asks for clarification
      // - task:dead_letter → All agents failed
      return {
        transcript,
        queued: true,
        taskId,
        task: submittedTask,
        classified: true,
        action: 'exchange-auction',
        message: 'Processing your request...',
        suppressAIResponse: true, // Exchange events handle response
      };
    } catch (submitError) {
      console.error('[ExchangeBridge] Exchange submit error:', submitError.message);
      return {
        transcript,
        queued: false,
        handled: true,
        classified: false,
        error: submitError.message,
        message: "Sorry, I couldn't process that request.",
        suppressAIResponse: false,
      };
    }
    // ==================== END DISTRIBUTED EXCHANGE-BASED ROUTING ====================
    
    // ==================== EARLY GARBLED DETECTION ====================
    // Check if transcription looks garbled before processing
    if (isLikelyGarbledTranscription(transcript)) {
      console.log('[ExchangeBridge] Transcript appears garbled, asking for clarification');
      
      const clarificationMessage = "Sorry, I didn't catch that. Could you repeat that?";
      
      // NOTE: With function calling, frontend handles TTS via respondToFunctionCall()
      // Don't call speakFeedback directly - return the message for frontend to handle
      
      return {
        transcript,
        queued: false,
        handled: true,
        classified: false,
        needsClarification: true,
        message: clarificationMessage,
        suppressAIResponse: false, // Let function call response speak the clarification
      };
    }
    // ==================== END EARLY GARBLED DETECTION ====================
    
    // ==================== SPECIAL COMMAND HANDLING ====================
    // Handle commands that open windows directly (don't need the exchange)
    const text = transcript?.toLowerCase() || '';
    
    // Check for "open/launch agent composer" commands
    if (text.includes('open') || text.includes('launch') || text.includes('start')) {
      const match = text.match(/(?:open|launch|start)\s+(?:the\s+)?(.+)/i);
      const target = match ? match[1].trim().toLowerCase() : '';
      
      if (target.includes('agent composer') || target.includes('composer') || target.includes('gsx create')) {
        console.log('[ExchangeBridge] Opening Agent Composer window');
        
        // Cancel any AI response
        try {
          const { getRealtimeSpeech } = require('../../realtime-speech');
          getRealtimeSpeech().cancelResponse();
        } catch (e) {}
        
        try {
          const main = require('../../main');
          if (main.createClaudeCodeWindow) {
            main.createClaudeCodeWindow();
          }
        } catch (e) {
          console.error('[ExchangeBridge] Could not open Agent Composer:', e);
        }
        
        return {
          transcript,
          queued: false,
          handled: true,
          classified: true,
          action: 'open-agent-composer',
          message: 'Opening Agent Composer window',
          suppressAIResponse: true,
        };
      }
      
      if (target.includes('agent manager') || target === 'agents') {
        console.log('[ExchangeBridge] Opening Agent Manager window');
        try {
          const main = require('../../main');
          if (main.createAgentManagerWindow) {
            main.createAgentManagerWindow();
          }
        } catch (e) {
          console.error('[ExchangeBridge] Could not open Agent Manager:', e);
        }
        
        return {
          transcript,
          queued: false,
          handled: true,
          classified: true,
          action: 'open-agent-manager',
          message: 'Opening Agent Manager window',
        };
      }
    }
    
    // ==================== MEDIA PLAYBACK COMMANDS ====================
    // Handle media control commands directly (play music, pause, stop, volume)
    if (text.includes('play') || text.includes('pause') || text.includes('stop') || 
        text.includes('volume') || text.includes('skip') || text.includes('next') || text.includes('previous')) {
      
      const mediaResult = await handleMediaCommand(text, transcript);
      if (mediaResult) {
        console.log('[ExchangeBridge] Media command handled:', mediaResult.action);
        return mediaResult;
      }
    }
    // ==================== END MEDIA COMMANDS ====================
    
    // Check for "create agent" commands  
    if ((text.includes('create') || text.includes('make') || text.includes('new')) &&
        (text.includes('agent') || text.includes('assistant') || text.includes('bot'))) {
      
      // Extract the description - what comes after "agent/assistant/bot" or "to/that/for"
      const descMatch = transcript.match(/(?:agent|assistant|bot)\s*(?:that\s+|to\s+|for\s+|which\s+)?(.+)/i);
      const description = descMatch ? descMatch[1].trim() : '';
      
      console.log('[ExchangeBridge] Opening Agent Composer for new agent, description:', description);
      
      // Cancel any AI response since we're handling this locally
      const { getRealtimeSpeech } = require('../../realtime-speech');
      const realtimeSpeech = getRealtimeSpeech();
      
      try {
        realtimeSpeech.cancelResponse();
      } catch (e) {
        console.warn('[ExchangeBridge] Could not cancel AI response:', e);
      }
      
      // IMMEDIATE ACKNOWLEDGMENT - speak before opening window
      try {
        const ack = description 
          ? `Got it, I'll help you build an agent for ${description}. Let me think about the best approach.`
          : `Got it, let me help you create a new agent.`;
        realtimeSpeech.speak(ack);
        console.log('[ExchangeBridge] Spoke acknowledgment:', ack);
      } catch (e) {
        console.warn('[ExchangeBridge] Could not speak acknowledgment:', e);
      }
      
      try {
        const main = require('../../main');
        if (main.createClaudeCodeWindow) {
          // Pass the description so Composer can auto-plan
          main.createClaudeCodeWindow({ initialDescription: description || transcript });
        }
      } catch (e) {
        console.error('[ExchangeBridge] Could not open Agent Composer:', e);
      }
      
      // Set global flag for voice relay
      global.agentCreationMode = true;
      
      return {
        transcript,
        queued: false,
        handled: true,
        classified: true,
        action: 'create-agent',
        params: { description },
        message: description 
          ? `Opening Agent Composer to create: ${description}` 
          : 'Opening Agent Composer window',
        // Signal to not let AI respond
        suppressAIResponse: true,
      };
    }
    // ==================== END SPECIAL COMMAND HANDLING ====================
    
    if (!exchangeInstance || !isExchangeRunning) {
      return {
        transcript,
        queued: false,
        error: 'Exchange not running',
      };
    }
    
    try {
      const { taskId, task } = await exchangeInstance.submit({
        content: transcript,
        priority: options.priority || 2,
        metadata: {
          source: 'voice',
          timestamp: Date.now(),
          ...options.metadata,
        },
      });
      
      return {
        transcript,
        queued: true,
        taskId,
        task,
        classified: true,
        action: 'auction',
        message: 'Task submitted to exchange',
      };
    } catch (error) {
      console.error('[ExchangeBridge] Submit error:', error);
      return {
        transcript,
        queued: false,
        error: error.message,
      };
    }
  });
  
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
    
    console.log('[ExchangeBridge] Status check:', status);
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
  
  // Get reputation summary
  ipcMain.handle('voice-task-sdk:reputation-summary', async () => {
    if (!exchangeInstance) return {};
    const summary = await exchangeInstance.reputation.getSummary();
    return Object.fromEntries(summary);
  });
  
  console.log('[ExchangeBridge] IPC handlers registered');
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
  console.log('[ExchangeBridge] Shutting down...');
  
  // Prevent reconnection during shutdown
  isShuttingDown = true;
  
  // Shutdown agent message queue
  try {
    const queue = getAgentMessageQueue();
    queue.shutdown();
    global.agentMessageQueue = null;
    console.log('[ExchangeBridge] Agent message queue shutdown');
  } catch (e) {
    console.warn('[ExchangeBridge] Error shutting down message queue:', e.message);
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
      console.warn(`[ExchangeBridge] Error closing agent ${agentId}:`, e.message);
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
  
  // Remove IPC handlers
  const handlers = [
    'voice-task-sdk:submit',
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
  
  console.log('[ExchangeBridge] Shutdown complete');
}

/**
 * Hot-connect a newly created agent to the running exchange
 * Called by agent-store when a new agent is created
 */
async function hotConnectAgent(agent) {
  if (!isExchangeRunning) {
    console.log('[ExchangeBridge] Exchange not running, cannot hot-connect agent:', agent.name);
    return false;
  }
  
  if (!agent.enabled) {
    console.log('[ExchangeBridge] Agent is disabled, skipping hot-connect:', agent.name);
    return false;
  }
  
  // Check if already connected
  if (localAgentConnections.has(agent.id)) {
    console.log('[ExchangeBridge] Agent already connected:', agent.name);
    return true;
  }
  
  try {
    const port = DEFAULT_EXCHANGE_CONFIG.port;
    await connectLocalAgent(agent, port);
    console.log('[ExchangeBridge] Hot-connected new agent:', agent.name);
    return true;
  } catch (error) {
    console.error('[ExchangeBridge] Failed to hot-connect agent:', agent.name, error.message);
    return false;
  }
}

/**
 * Disconnect an agent from the exchange (for deletion or disable)
 */
function disconnectAgent(agentId) {
  const connection = localAgentConnections.get(agentId);
  if (connection) {
    // Clean up heartbeat interval
    if (connection.heartbeatInterval) {
      clearInterval(connection.heartbeatInterval);
    }
    // Close WebSocket
    if (connection.ws) {
      try {
        connection.ws.close();
        console.log('[ExchangeBridge] Disconnected agent:', connection.agent?.name || agentId);
      } catch (e) {
        // Ignore close errors
      }
    }
    localAgentConnections.delete(agentId);
    return true;
  }
  return false;
}

module.exports = {
  initializeExchangeBridge,
  getExchange,
  isRunning,
  getExchangeUrl,
  shutdown,
  hotConnectAgent,
  disconnectAgent,
  DEFAULT_EXCHANGE_CONFIG,
};
