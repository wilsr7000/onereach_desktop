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
 * - description: string
 * - categories: string[] (e.g., ['system', 'calendar'])
 * - keywords: string[] (for category routing and LLM context)
 * - execute: async function(task) => { success, message, needsInput? }
 * 
 * OPTIONAL PROPERTIES:
 * - prompt: string (LLM prompt for intelligent bidding)
 * - capabilities: string[] (human-readable capability list)
 * - bid: function(task) => { confidence, reasoning } | null (fallback bidding)
 * - initialize: async function() (called once before first execute)
 * - cleanup: function() (called on shutdown)
 * 
 * CATEGORY AUTO-REGISTRATION:
 * Categories declared by agents are automatically registered with the exchange.
 * Agent keywords are used for category routing.
 */

const path = require('path');

// ==================== AGENT IDS ====================
// Add new agent IDs here - the registry handles the rest
const BUILT_IN_AGENT_IDS = [
  'orchestrator-agent',  // Meta-agent - coordinates multiple agents for composite requests
  'app-agent',           // App guide - knows all features, gives tours
  'spaces-agent',        // Spaces assistant - manages saved content with smart summaries
  'time-agent',
  'weather-agent',
  'calendar-agent',
  'help-agent',
  'search-agent',
  'smalltalk-agent',
  'dj-agent',
  'email-agent',         // Email assistant - data-aware bidding for email communications
  // Add new agents here:
  // 'your-new-agent',
];

// ==================== VALIDATION ====================

const REQUIRED_PROPERTIES = ['id', 'name', 'description', 'categories', 'keywords', 'execute'];
const OPTIONAL_PROPERTIES = ['prompt', 'capabilities', 'bid', 'initialize', 'cleanup', 'memory', 'version', 'voice', 'ack', 'acks'];

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
  
  return {
    valid: errors.length === 0,
    errors
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
        console.error(`[AgentRegistry] Invalid agent ${agentId}:`, validation.errors);
        continue;
      }
      
      // Verify ID matches filename
      if (agent.id !== agentId) {
        console.warn(`[AgentRegistry] Agent ID mismatch: file=${agentId}, agent.id=${agent.id}`);
      }
      
      loadedAgents.push(agent);
      agentMap[agent.id] = agent;
      
      console.log(`[AgentRegistry] Loaded: ${agent.name} (${agent.id})`);
      
    } catch (error) {
      console.error(`[AgentRegistry] Failed to load ${agentId}:`, error.message);
    }
  }
  
  console.log(`[AgentRegistry] Loaded ${loadedAgents.length}/${BUILT_IN_AGENT_IDS.length} built-in agents`);
  
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
      keywords: Array.from(keywordSet)
    });
  }
  
  console.log(`[AgentRegistry] Built ${categoryConfig.length} categories from agent declarations`);
  
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
  
  console.log('[AgentRegistry] Cache cleared');
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
  
  // Utilities
  validateAgent,
  clearCache,
  
  // Constants
  BUILT_IN_AGENT_IDS,
  REQUIRED_PROPERTIES,
  OPTIONAL_PROPERTIES,
};
