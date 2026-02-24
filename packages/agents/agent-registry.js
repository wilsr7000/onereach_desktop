/**
 * Built-in Agent Registry
 *
 * Central registry for all built-in agents. Auto-discovers and validates agents.
 *
 * TO ADD A NEW AGENT:
 * 1. Create your agent file in /packages/agents/[name]-agent.js
 * 2. Add the agent ID to BUILT_IN_AGENT_IDS below
 * 3. That's it! The registry handles everything else.
 *
 * REQUIRED AGENT PROPERTIES:
 * - id: string (e.g., 'calendar-agent')
 * - name: string (e.g., 'Calendar Agent')
 * - description: string (used by LLM bidder for semantic routing)
 * - categories: string[] (e.g., ['system', 'calendar'])
 * - keywords: string[] (passed to LLM bidder as context, NOT for keyword matching)
 * - execute: async function(task) => { success, message, needsInput? }
 *
 * OPTIONAL PROPERTIES:
 * - prompt: string (LLM prompt for intelligent bidding)
 * - capabilities: string[] (human-readable capability list, passed to LLM bidder)
 * - initialize: async function() (called once before first execute)
 * - cleanup: function() (called on shutdown)
 *
 * FORBIDDEN PROPERTIES:
 * - bid: NEVER add a bid() method. All routing is LLM-based via unified-bidder.js.
 *   Agents with bid() methods will be REJECTED at load time.
 *   See .cursorrules "Classification Approach" -- no keyword/regex classification.
 *
 * CATEGORY AUTO-REGISTRATION:
 * Categories declared by agents are automatically registered with the exchange.
 * Agent keywords are passed to the LLM bidder as semantic context.
 */

const path = require('path');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// ==================== AGENT IDS ====================
// Add new agent IDs here - the registry handles the rest
const BUILT_IN_AGENT_IDS = [
  'orchestrator-agent', // Meta-agent - coordinates multiple agents for composite requests
  'app-agent', // App guide - knows all features, gives tours
  'spaces-agent', // Spaces assistant - manages saved content with smart summaries
  'time-agent',
  'weather-agent',
  'calendar-query-agent',
  'calendar-create-agent',
  'calendar-edit-agent',
  'calendar-delete-agent',
  'help-agent',
  'search-agent',
  'smalltalk-agent',
  'spelling-agent',
  'dj-agent',
  'email-agent', // Email assistant - data-aware bidding for email communications
  'recorder-agent', // Video recorder - launches WISER Meeting to record video to Spaces
  'meeting-monitor-agent', // Meeting monitor - watches live transcript + health, alerts on issues (bidExcluded)
  'error-agent', // System agent - handles failed/timed-out tasks (bidExcluded)
  // Meeting agents (default space: meeting-agents)
  'action-item-agent', // Captures action items with owner/deadline from meeting context
  'decision-agent', // Logs decisions with context/rationale
  'meeting-notes-agent', // Captures notes, key points, bookmarks
  // Documentation
  'docs-agent', // RAG-grounded documentation assistant -- answers from official app docs
  'daily-brief-agent', // Meta-agent - orchestrates morning briefing from time, weather, calendar, email, etc.
  'memory-agent', // Memory manager - lets users view, correct, update, or delete personal facts/preferences
  'playbook-agent', // Playbook executor - runs playbooks in spaces, relays questions, reports results
  'browser-agent', // Browser automation - autonomous web navigation, form filling, data extraction via Playwright
  'browsing-agent', // Browsing API - resilient web research, page reading, form filling via native Electron BrowserWindow
];

// ==================== VALIDATION ====================

const REQUIRED_PROPERTIES = ['id', 'name', 'description', 'categories', 'keywords', 'execute'];

/**
 * Optional agent properties. Each one enables a specific protocol.
 *
 * @property {string} prompt
 *   LLM prompt passed to the unified-bidder to help it evaluate whether this agent
 *   should handle a given request. Include HIGH/LOW confidence examples.
 *
 * @property {string[]} capabilities
 *   Human-readable list of what this agent can do. Passed to the LLM bidder as
 *   additional context alongside `prompt` and `description`.
 *
 * @property {Function} initialize
 *   `async initialize() => void` -- Called once before the first `execute()`.
 *   Use for loading memory, caching config, opening connections, etc.
 *
 * @property {Function} cleanup
 *   `cleanup() => void` -- Called on app shutdown. Close connections, flush caches.
 *
 * @property {object|null} memory
 *   If non-null, the agent uses the thinking-agent memory system.
 *   Typically set to `null` initially and populated during `initialize()` via
 *   `getAgentMemory(id, { displayName })`. Enables `learnFromInteraction` /
 *   `reviewExecution` patterns.
 *
 * @property {string} version
 *   Semver string for the agent (e.g., '1.0.0'). Informational only.
 *
 * @property {string} voice
 *   OpenAI voice ID for TTS when this agent speaks (e.g., 'coral', 'verse', 'ember').
 *   See VOICE-GUIDE.md for the full list and personality descriptions.
 *
 * @property {string} ack
 *   Single acknowledgment phrase spoken while the agent is working.
 *   Prefer `acks` (array) for variety.
 *
 * @property {string[]} acks
 *   Array of acknowledgment phrases. One is randomly selected and spoken to the
 *   user while the agent processes. Keeps the interaction feeling responsive.
 *   Example: ['Let me check...', 'One moment...', 'Looking into that...']
 *
 * @property {string} executionType
 *   'informational' | 'action' | 'system'
 *   - 'informational': Read-only, no side effects. Can be fast-pathed by the bidder.
 *   - 'action': Has side effects (creates events, sends emails, etc.).
 *   - 'system': Internal infrastructure agent (error handling, orchestration).
 *
 * @property {boolean} bidExcluded
 *   If true, this agent never participates in LLM bidding auctions. It is only
 *   invoked programmatically (e.g., error-agent, meeting-monitor-agent).
 *
 * @property {string[]} defaultSpaces
 *   Space names this agent auto-creates on first run for storing its output
 *   (e.g., meeting-agents create 'Action Items', 'Decisions' spaces).
 *
 * @property {Function} getBriefing
 *   `async getBriefing() => { section: string, priority: number, content: string }`
 *   Agents with this method are auto-discovered by daily-brief-agent during
 *   morning brief orchestration. The priority controls ordering:
 *     1 = time/date, 2 = weather, 3 = calendar, 4 = email, 5 = tasks, 6 = other
 *
 * @property {number} estimatedExecutionMs
 *   Agent's own estimate of typical execution time in milliseconds.
 *   Used by the ack protocol to decide how long to wait before playing an
 *   acknowledgment phrase. Agents that finish quickly (< 1s) may skip acks.
 *
 * @property {string[]} dataSources
 *   Declares what external data the agent accesses (e.g., ['system-clock',
 *   'weather-api', 'calendar-store']). Action agents without dataSources get a
 *   warning during registration -- they should declare what they access for
 *   grounding enforcement and auditing.
 */
const OPTIONAL_PROPERTIES = [
  'prompt',
  'capabilities',
  'initialize',
  'cleanup',
  'memory',
  'version',
  'voice',
  'ack',
  'acks',
  'executionType',
  'bidExcluded',
  'defaultSpaces',
  'getBriefing',
  'estimatedExecutionMs',
  'dataSources',
];
// NOTE: 'bid' is intentionally NOT in OPTIONAL_PROPERTIES. Agents must not have bid() methods.
// All routing is LLM-based via unified-bidder.js. See .cursorrules "Classification Approach".

/**
 * Validate an agent has required properties
 * @param {Object} agent - Agent module
 * @param {string} filename - Source filename for error messages
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateAgent(agent, filename) {
  const errors = [];

  for (const prop of REQUIRED_PROPERTIES) {
    if (agent[prop] === undefined) {
      errors.push(`Missing required property: ${prop}`);
    }
  }

  // Type checks
  if (agent.id && typeof agent.id !== 'string') {
    errors.push('id must be a string');
  }
  if (agent.name && typeof agent.name !== 'string') {
    errors.push('name must be a string');
  }
  if (agent.categories && !Array.isArray(agent.categories)) {
    errors.push('categories must be an array');
  }
  if (agent.keywords && !Array.isArray(agent.keywords)) {
    errors.push('keywords must be an array');
  }
  if (agent.execute && typeof agent.execute !== 'function') {
    errors.push('execute must be a function');
  }

  // Validate categories are strings
  if (Array.isArray(agent.categories)) {
    for (const cat of agent.categories) {
      if (typeof cat !== 'string') {
        errors.push(`category "${cat}" must be a string`);
      }
    }
  }

  // Validate keywords are strings
  if (Array.isArray(agent.keywords)) {
    for (const kw of agent.keywords) {
      if (typeof kw !== 'string') {
        errors.push(`keyword "${kw}" must be a string`);
      }
    }
  }

  // ENFORCE: No bid() methods allowed on agents.
  // All routing is 100% LLM-based via unified-bidder.js.
  // Keyword/regex-based classification is forbidden. See .cursorrules.
  if (typeof agent.bid === 'function') {
    errors.push(
      `FORBIDDEN: Agent "${agent.name || filename}" has a bid() method. ` +
        'All routing must be LLM-based via unified-bidder.js. ' +
        'Remove the bid() method. See .cursorrules "Classification Approach".'
    );
  }

  // WARN: Action agents should declare their data sources for grounding enforcement.
  // This is a soft warning, not a blocking error.
  if (agent.executionType === 'action' && !agent.dataSources) {
    console.warn(
      `[agent-registry] Warning: Action agent "${agent.name || filename}" has no dataSources declared. Consider adding dataSources: ['system-clock', 'weather-api', etc.] for grounding enforcement.`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ==================== REGISTRY ====================

let loadedAgents = null;
let agentMap = null;
let categoryConfig = null;

/**
 * Load all built-in agents
 * @returns {Object[]} Array of loaded agent modules
 */
function loadBuiltInAgents() {
  if (loadedAgents) {
    return loadedAgents;
  }

  loadedAgents = [];
  agentMap = {};

  for (const agentId of BUILT_IN_AGENT_IDS) {
    const filename = `${agentId}.js`;
    const filepath = path.join(__dirname, filename);

    try {
      const agent = require(filepath);

      // Validate
      const validation = validateAgent(agent, filename);
      if (!validation.valid) {
        log.error('agent', `REJECTED agent ${agentId}`, { errors: validation.errors });
        continue;
      }

      // Verify ID matches filename
      if (agent.id !== agentId) {
        log.warn('agent', `Agent ID mismatch: file=${agentId}, agent.id=${agent.id}`);
      }

      // Wrap execute() to normalize response format centrally.
      // Ensures every agent returns { success, message } -- never bare `error`.
      const originalExecute = agent.execute;
      agent.execute = async function wrappedExecute(task) {
        try {
          const result = await originalExecute.call(agent, task);
          if (result && typeof result === 'object') {
            if (!result.message && result.error) {
              result.message = result.error;
              delete result.error;
            }
          }
          return result;
        } catch (err) {
          log.error('agent', `${agent.name} execute threw`, { error: err.message });
          return { success: false, message: err.message || 'Agent execution failed' };
        }
      };

      loadedAgents.push(agent);
      agentMap[agent.id] = agent;

      log.info('agent', `Loaded: ${agent.name} (${agent.id})`);
    } catch (error) {
      log.error('agent', `Failed to load ${agentId}`, { error: error.message });
    }
  }

  log.info('agent', `Loaded ${loadedAgents.length}/${BUILT_IN_AGENT_IDS.length} built-in agents`);

  return loadedAgents;
}

/**
 * Get all loaded agents
 * @returns {Object[]}
 */
function getAllAgents() {
  if (!loadedAgents) {
    loadBuiltInAgents();
  }
  return loadedAgents;
}

/**
 * Get agent by ID
 * @param {string} agentId
 * @returns {Object|null}
 */
function getAgent(agentId) {
  if (!agentMap) {
    loadBuiltInAgents();
  }
  return agentMap[agentId] || null;
}

/**
 * Get agent map (id -> agent)
 * @returns {Object}
 */
function getAgentMap() {
  if (!agentMap) {
    loadBuiltInAgents();
  }
  return agentMap;
}

/**
 * Build category configuration from agent declarations
 * Categories are auto-generated from agent categories + keywords
 * @returns {Object[]} Category config for exchange
 */
function buildCategoryConfig() {
  if (categoryConfig) {
    return categoryConfig;
  }

  if (!loadedAgents) {
    loadBuiltInAgents();
  }

  // Collect all categories and their keywords from agents
  const categoryKeywords = new Map();

  for (const agent of loadedAgents) {
    for (const category of agent.categories) {
      if (!categoryKeywords.has(category)) {
        categoryKeywords.set(category, new Set());
      }

      // Add agent's keywords to this category
      for (const keyword of agent.keywords) {
        categoryKeywords.get(category).add(keyword.toLowerCase());
      }
    }
  }

  // Convert to config format
  categoryConfig = [];
  for (const [name, keywordSet] of categoryKeywords) {
    categoryConfig.push({
      name,
      keywords: Array.from(keywordSet),
    });
  }

  log.info('agent', `Built ${categoryConfig.length} categories from agent declarations`);

  return categoryConfig;
}

/**
 * Get list of agent IDs
 * @returns {string[]}
 */
function getAgentIds() {
  return [...BUILT_IN_AGENT_IDS];
}

/**
 * Check if an agent ID is registered
 * @param {string} agentId
 * @returns {boolean}
 */
function isRegistered(agentId) {
  return BUILT_IN_AGENT_IDS.includes(agentId);
}

/**
 * Clear cached agents (for testing/hot-reload)
 */
function clearCache() {
  loadedAgents = null;
  agentMap = null;
  categoryConfig = null;

  // Clear require cache for agent files
  for (const agentId of BUILT_IN_AGENT_IDS) {
    const filepath = path.join(__dirname, `${agentId}.js`);
    delete require.cache[require.resolve(filepath)];
  }

  log.info('agent', 'Cache cleared');
}

/**
 * Get agents that declare a specific default space
 * @param {string} spaceId - e.g. 'meeting-agents'
 * @returns {Object[]} Agents with that space in their defaultSpaces
 */
function getAgentsByDefaultSpace(spaceId) {
  if (!loadedAgents) loadBuiltInAgents();
  return loadedAgents.filter((agent) => Array.isArray(agent.defaultSpaces) && agent.defaultSpaces.includes(spaceId));
}

/**
 * Get all agents that implement getBriefing().
 * Used by the morning brief orchestrator to discover contributors.
 */
function getBriefingAgents() {
  if (!agentMap) loadBuiltInAgents();
  return Object.values(agentMap).filter((a) => typeof a.getBriefing === 'function');
}

module.exports = {
  // Core
  loadBuiltInAgents,
  getAllAgents,
  getAgent,
  getAgentMap,
  getAgentIds,
  isRegistered,

  // Categories
  buildCategoryConfig,

  // Briefing
  getBriefingAgents,

  // Spaces
  getAgentsByDefaultSpace,

  // Utilities
  validateAgent,
  clearCache,

  // Constants
  BUILT_IN_AGENT_IDS,
  REQUIRED_PROPERTIES,
  OPTIONAL_PROPERTIES,
};
