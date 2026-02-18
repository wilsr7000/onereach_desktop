/**
 * Agent Store
 *
 * Manages user-defined agents stored in Spaces.
 * Supports both local LLM-powered agents and GSX/MCS connections.
 */

const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const { app } = require('electron');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();
const exchangeBus = require('../../lib/exchange/event-bus');

// Agent type constants
const AGENT_TYPE = {
  LOCAL: 'local',
  GSX: 'gsx',
};

// Schema version - bump when adding new fields
const AGENT_SCHEMA_VERSION = 2;

// Default agent schema (v2 - first-class agent support)
const DEFAULT_LOCAL_AGENT = {
  type: AGENT_TYPE.LOCAL,
  schemaVersion: AGENT_SCHEMA_VERSION,
  name: '',
  version: '1.0.0',
  enabled: true,
  keywords: [],
  categories: [],
  prompt: '',
  executionType: 'llm',
  // Voice personality (see VOICE-GUIDE.md: 'verse', 'ember', 'alloy', etc.)
  voice: null,
  // Acknowledgment phrases spoken while agent is working
  acks: [],
  // Estimated execution time in ms (hint for exchange timeout)
  estimatedExecutionMs: 5000,
  // Data sources this agent can access
  dataSources: [],
  // Memory configuration (thinking-agent pattern)
  memory: {
    enabled: false,
    sections: ['Learned Preferences'],
  },
  // Daily briefing contribution
  briefing: {
    enabled: false,
    priority: 5,
    section: '',
    prompt: '',
  },
  // Whether agent supports multi-turn clarification via needsInput
  multiTurn: false,
  settings: {
    confidenceThreshold: 0.7,
    maxConcurrent: 5,
  },
};

const DEFAULT_GSX_CONNECTION = {
  type: AGENT_TYPE.GSX,
  name: '',
  url: '',
  configUrl: '',
  apiKey: '',
  enabled: true,
  agents: [], // Populated from MCS server
};

// Version history settings
const MAX_VERSIONS_PER_AGENT = 20;
const VERSION_REASONS = {
  CREATE: 'created',
  UPDATE: 'updated',
  AUTO_FIX: 'auto-fix',
  MANUAL_EDIT: 'manual-edit',
  IMPORT: 'imported',
};

// Singleton instance
let instance = null;

class AgentStore {
  constructor() {
    this.agents = new Map();
    this.gsxConnections = new Map();
    this.agentVersions = new Map(); // agentId -> [versions]
    this.storePath = null;
    this.versionsPath = null;
    this.initialized = false;
  }

  /**
   * Initialize the store
   */
  async init() {
    if (this.initialized) return;

    // Get storage path
    const userDataPath = app.getPath('userData');
    this.storePath = path.join(userDataPath, 'agents');
    this.versionsPath = path.join(this.storePath, 'versions');

    // Ensure directories exist
    try {
      await fs.mkdir(this.storePath, { recursive: true });
      await fs.mkdir(this.versionsPath, { recursive: true });
    } catch (_e) {
      // Directories may already exist
    }

    // Load existing agents and versions
    await this.loadAgents();
    await this.loadGSXConnections();
    await this.loadVersions();

    this.initialized = true;
    log.info('voice', '[AgentStore] Initialized with', {
      arg0: this.agents.size,
      arg1: 'local agents, arg2: ',
      arg3: this.gsxConnections.size,
      arg4: 'GSX connections, arg5: and version history',
    });
  }

  /**
   * Load local agents from storage, migrating old schemas to current version.
   */
  async loadAgents() {
    try {
      const agentsFile = path.join(this.storePath, 'local-agents.json');
      const data = await fs.readFile(agentsFile, 'utf-8');
      const agents = JSON.parse(data);

      let needsSave = false;
      for (const agent of agents) {
        // Migrate agents missing v2 fields
        const migrated = this._migrateAgent(agent);
        if (migrated !== agent) needsSave = true;
        this.agents.set(migrated.id, migrated);
      }

      // Persist migration changes
      if (needsSave) {
        await this.saveAgents();
        log.info('voice', '[AgentStore] Migrated agents to schema v2');
      }
    } catch (_e) {
      // File may not exist yet
      log.info('voice', '[AgentStore] No existing local agents found');
    }
  }

  /**
   * Migrate an agent to the current schema version.
   * Returns the original object if already current, or a new object with defaults filled in.
   */
  _migrateAgent(agent) {
    if (agent.schemaVersion === AGENT_SCHEMA_VERSION) return agent;

    // Fill in any missing v2 fields from defaults
    const migrated = {
      ...DEFAULT_LOCAL_AGENT,
      ...agent,
      schemaVersion: AGENT_SCHEMA_VERSION,
      // Deep-merge nested objects so existing sub-keys aren't lost
      memory: { ...DEFAULT_LOCAL_AGENT.memory, ...(agent.memory || {}) },
      briefing: { ...DEFAULT_LOCAL_AGENT.briefing, ...(agent.briefing || {}) },
      settings: { ...DEFAULT_LOCAL_AGENT.settings, ...(agent.settings || {}) },
    };

    return migrated;
  }

  /**
   * Load GSX connections from storage
   */
  async loadGSXConnections() {
    try {
      const connectionsFile = path.join(this.storePath, 'gsx-connections.json');
      const data = await fs.readFile(connectionsFile, 'utf-8');
      const connections = JSON.parse(data);

      for (const conn of connections) {
        this.gsxConnections.set(conn.id, conn);
      }
    } catch (_e) {
      // File may not exist yet
      log.info('voice', '[AgentStore] No existing GSX connections found');
    }
  }

  /**
   * Save local agents to storage
   */
  async saveAgents() {
    const agentsFile = path.join(this.storePath, 'local-agents.json');
    const agents = Array.from(this.agents.values());
    await fs.writeFile(agentsFile, JSON.stringify(agents, null, 2));
  }

  /**
   * Save GSX connections to storage
   */
  async saveGSXConnections() {
    const connectionsFile = path.join(this.storePath, 'gsx-connections.json');
    const connections = Array.from(this.gsxConnections.values());
    await fs.writeFile(connectionsFile, JSON.stringify(connections, null, 2));
  }

  /**
   * Load version history for all agents
   */
  async loadVersions() {
    try {
      const files = await fs.readdir(this.versionsPath);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const agentId = file.replace('.json', '');
          const versionFile = path.join(this.versionsPath, file);
          const data = await fs.readFile(versionFile, 'utf-8');
          this.agentVersions.set(agentId, JSON.parse(data));
        }
      }
    } catch (_e) {
      // Versions directory may be empty
    }
  }

  /**
   * Save version history for a specific agent
   */
  async saveVersions(agentId) {
    const versions = this.agentVersions.get(agentId) || [];
    const versionFile = path.join(this.versionsPath, `${agentId}.json`);
    await fs.writeFile(versionFile, JSON.stringify(versions, null, 2));
  }

  /**
   * Add a version to an agent's history
   */
  async addVersion(agentId, agentSnapshot, reason = VERSION_REASONS.UPDATE, description = '') {
    const versions = this.agentVersions.get(agentId) || [];

    const version = {
      versionNumber: versions.length + 1,
      timestamp: new Date().toISOString(),
      reason,
      description,
      snapshot: { ...agentSnapshot },
    };

    versions.push(version);

    // Trim to max versions
    if (versions.length > MAX_VERSIONS_PER_AGENT) {
      versions.shift();
    }

    this.agentVersions.set(agentId, versions);
    await this.saveVersions(agentId);

    log.info('voice', '[AgentStore] Version saved for agent :', { v0: version.versionNumber, v1: agentId, v2: reason });
    return version;
  }

  // ==================== LOCAL AGENTS ====================

  /**
   * Create a new local agent
   */
  async createAgent(agentData) {
    const agent = {
      ...DEFAULT_LOCAL_AGENT,
      ...agentData,
      id: uuidv4(),
      type: AGENT_TYPE.LOCAL,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    // Validate required fields
    if (!agent.name) throw new Error('Agent name is required');
    if (!agent.keywords || agent.keywords.length === 0) {
      throw new Error('At least one keyword is required');
    }
    if (!agent.prompt) throw new Error('Agent prompt is required');

    this.agents.set(agent.id, agent);
    await this.saveAgents();

    // Save initial version
    await this.addVersion(agent.id, agent, VERSION_REASONS.CREATE, 'Initial creation');

    log.info('voice', '[AgentStore] Created local agent', { data: agent.name });

    // Signal the exchange to connect this new agent (decoupled via event bus)
    if (agent.enabled) {
      exchangeBus.emit('agent:hot-connect', agent);
    }

    return agent;
  }

  /**
   * Update an existing local agent
   * @param {string} id - Agent ID
   * @param {Object} updates - Fields to update
   * @param {string} reason - Reason for update (for version history)
   * @param {string} description - Optional description of changes
   */
  async updateAgent(id, updates, reason = VERSION_REASONS.UPDATE, description = '') {
    const agent = this.agents.get(id);
    if (!agent) throw new Error('Agent not found');

    // Track if enabled state changed
    const wasEnabled = agent.enabled;
    const willBeEnabled = updates.enabled !== undefined ? updates.enabled : wasEnabled;

    // Save current state to version history before updating
    await this.addVersion(id, agent, reason, description || `Updated: ${Object.keys(updates).join(', ')}`);

    const updated = {
      ...agent,
      ...updates,
      id, // Prevent ID change
      type: AGENT_TYPE.LOCAL, // Prevent type change
      updatedAt: new Date().toISOString(),
      version: (agent.version || 1) + 1,
    };

    this.agents.set(id, updated);
    await this.saveAgents();

    // Signal the exchange about enabled-state changes (decoupled via event bus)
    if (wasEnabled && !willBeEnabled) {
      exchangeBus.emit('agent:disconnect', id);
      log.info('voice', '[AgentStore] Disconnected disabled agent', { data: updated.name });
    } else if (!wasEnabled && willBeEnabled) {
      exchangeBus.emit('agent:hot-connect', updated);
      log.info('voice', '[AgentStore] Reconnected enabled agent', { data: updated.name });
    } else if (willBeEnabled) {
      exchangeBus.emit('agent:disconnect', id);
      exchangeBus.emit('agent:hot-connect', updated);
      log.info('voice', '[AgentStore] Reconnected updated agent', { data: updated.name });
    }

    log.info('voice', '[AgentStore] Updated local agent', {
      arg0: updated.name,
      arg1: '-> version',
      arg2: updated.version,
    });
    return updated;
  }

  /**
   * Delete a local agent
   */
  async deleteAgent(id) {
    const agent = this.agents.get(id);
    if (!agent) throw new Error('Agent not found');

    // Signal the exchange to disconnect this agent (decoupled via event bus)
    exchangeBus.emit('agent:disconnect', id);

    this.agents.delete(id);
    await this.saveAgents();

    log.info('voice', '[AgentStore] Deleted local agent', { data: agent.name });
    return true;
  }

  /**
   * Get a local agent by ID
   */
  getAgent(id) {
    return this.agents.get(id);
  }

  /**
   * Get all local agents
   */
  getLocalAgents() {
    return Array.from(this.agents.values());
  }

  /**
   * Get enabled local agents
   */
  getEnabledLocalAgents() {
    return this.getLocalAgents().filter((a) => a.enabled);
  }

  // ==================== GSX CONNECTIONS ====================

  /**
   * Add a GSX/MCS connection
   */
  async addGSXConnection(connectionData) {
    const connection = {
      ...DEFAULT_GSX_CONNECTION,
      ...connectionData,
      id: uuidv4(),
      type: AGENT_TYPE.GSX,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Validate required fields
    if (!connection.name) throw new Error('Connection name is required');
    if (!connection.url) throw new Error('WebSocket URL is required');

    this.gsxConnections.set(connection.id, connection);
    await this.saveGSXConnections();

    log.info('voice', '[AgentStore] Added GSX connection', { data: connection.name });
    return connection;
  }

  /**
   * Update a GSX connection
   */
  async updateGSXConnection(id, updates) {
    const connection = this.gsxConnections.get(id);
    if (!connection) throw new Error('GSX connection not found');

    const updated = {
      ...connection,
      ...updates,
      id, // Prevent ID change
      type: AGENT_TYPE.GSX, // Prevent type change
      updatedAt: new Date().toISOString(),
    };

    this.gsxConnections.set(id, updated);
    await this.saveGSXConnections();

    log.info('voice', '[AgentStore] Updated GSX connection', { data: updated.name });
    return updated;
  }

  /**
   * Delete a GSX connection
   */
  async deleteGSXConnection(id) {
    const connection = this.gsxConnections.get(id);
    if (!connection) throw new Error('GSX connection not found');

    this.gsxConnections.delete(id);
    await this.saveGSXConnections();

    log.info('voice', '[AgentStore] Deleted GSX connection', { data: connection.name });
    return true;
  }

  /**
   * Get a GSX connection by ID
   */
  getGSXConnection(id) {
    return this.gsxConnections.get(id);
  }

  /**
   * Get all GSX connections
   */
  getGSXConnections() {
    return Array.from(this.gsxConnections.values());
  }

  /**
   * Get enabled GSX connections
   */
  getEnabledGSXConnections() {
    return this.getGSXConnections().filter((c) => c.enabled);
  }

  /**
   * Update agents list for a GSX connection (from MCS server)
   */
  async updateGSXAgents(connectionId, agents) {
    const connection = this.gsxConnections.get(connectionId);
    if (!connection) throw new Error('GSX connection not found');

    connection.agents = agents;
    connection.updatedAt = new Date().toISOString();

    this.gsxConnections.set(connectionId, connection);
    await this.saveGSXConnections();

    log.info('voice', '[AgentStore] Updated GSX agents for', {
      arg0: connection.name,
      arg1: ':',
      arg2: agents.length,
      arg3: 'agents',
    });
    return connection;
  }

  // ==================== COMBINED ====================

  /**
   * Get all agents (local + GSX)
   */
  async getAllAgents() {
    const localAgents = this.getEnabledLocalAgents();

    // Flatten GSX connection agents
    const gsxAgents = [];
    for (const conn of this.getEnabledGSXConnections()) {
      for (const agent of conn.agents || []) {
        gsxAgents.push({
          ...agent,
          type: AGENT_TYPE.GSX,
          connectionId: conn.id,
          connectionName: conn.name,
        });
      }
    }

    return [...localAgents, ...gsxAgents];
  }

  /**
   * Find agents by keyword match
   */
  findAgentsByKeyword(text) {
    const lowerText = text.toLowerCase();
    const matches = [];

    for (const agent of this.getEnabledLocalAgents()) {
      const matchedKeywords = agent.keywords.filter((kw) => lowerText.includes(kw.toLowerCase()));

      if (matchedKeywords.length > 0) {
        matches.push({
          agent,
          matchedKeywords,
          confidence: Math.min(1, matchedKeywords.length / agent.keywords.length + 0.5),
        });
      }
    }

    // Sort by confidence
    matches.sort((a, b) => b.confidence - a.confidence);
    return matches;
  }

  // ==================== VERSION HISTORY ====================

  /**
   * Get version history for an agent
   */
  getVersionHistory(agentId) {
    const versions = this.agentVersions.get(agentId) || [];
    return versions.map((v, index) => ({
      ...v,
      isCurrent: index === versions.length - 1,
      canUndo: index < versions.length - 1,
    }));
  }

  /**
   * Get a specific version of an agent
   */
  getVersion(agentId, versionNumber) {
    const versions = this.agentVersions.get(agentId) || [];
    return versions.find((v) => v.versionNumber === versionNumber);
  }

  /**
   * Undo last change - revert to previous version
   */
  async undoAgent(agentId) {
    const versions = this.agentVersions.get(agentId) || [];

    if (versions.length < 2) {
      throw new Error('No previous version to undo to');
    }

    // Get the second-to-last version (the one before current)
    const previousVersion = versions[versions.length - 2];

    // Restore agent to that state
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');

    const restored = {
      ...previousVersion.snapshot,
      id: agentId, // Keep current ID
      type: AGENT_TYPE.LOCAL,
      updatedAt: new Date().toISOString(),
      version: (agent.version || 1) + 1,
    };

    this.agents.set(agentId, restored);
    await this.saveAgents();

    // Add an "undo" entry to version history
    await this.addVersion(agentId, restored, 'undo', `Reverted to version ${previousVersion.versionNumber}`);

    log.info('voice', '[AgentStore] Undid agent', {
      arg0: restored.name,
      arg1: '-> restored from version',
      arg2: previousVersion.versionNumber,
    });
    return restored;
  }

  /**
   * Revert to a specific version
   */
  async revertToVersion(agentId, versionNumber) {
    const version = this.getVersion(agentId, versionNumber);
    if (!version) throw new Error(`Version ${versionNumber} not found`);

    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');

    const restored = {
      ...version.snapshot,
      id: agentId,
      type: AGENT_TYPE.LOCAL,
      updatedAt: new Date().toISOString(),
      version: (agent.version || 1) + 1,
    };

    this.agents.set(agentId, restored);
    await this.saveAgents();

    // Add a "revert" entry to version history
    await this.addVersion(agentId, restored, 'revert', `Reverted to version ${versionNumber}`);

    log.info('voice', '[AgentStore] Reverted agent', { arg0: restored.name, arg1: 'to version', arg2: versionNumber });
    return restored;
  }

  /**
   * Compare two versions of an agent
   */
  compareVersions(agentId, versionA, versionB) {
    const a = this.getVersion(agentId, versionA);
    const b = this.getVersion(agentId, versionB);

    if (!a || !b) throw new Error('One or both versions not found');

    const changes = {};
    const allKeys = new Set([...Object.keys(a.snapshot), ...Object.keys(b.snapshot)]);

    for (const key of allKeys) {
      const valA = JSON.stringify(a.snapshot[key]);
      const valB = JSON.stringify(b.snapshot[key]);
      if (valA !== valB) {
        changes[key] = {
          from: a.snapshot[key],
          to: b.snapshot[key],
        };
      }
    }

    return {
      versionA: a,
      versionB: b,
      changes,
      hasChanges: Object.keys(changes).length > 0,
    };
  }

  /**
   * Clear version history for an agent
   */
  async clearVersionHistory(agentId) {
    this.agentVersions.delete(agentId);
    const versionFile = path.join(this.versionsPath, `${agentId}.json`);
    try {
      await fs.unlink(versionFile);
    } catch (_e) {
      // File may not exist
    }
    log.info('voice', '[AgentStore] Cleared version history for agent', { data: agentId });
  }
}

/**
 * Get the singleton agent store instance
 */
function getAgentStore() {
  if (!instance) {
    instance = new AgentStore();
  }
  return instance;
}

/**
 * Initialize the agent store
 */
async function initAgentStore() {
  const store = getAgentStore();
  await store.init();
  return store;
}

module.exports = {
  AgentStore,
  getAgentStore,
  initAgentStore,
  AGENT_TYPE,
  AGENT_SCHEMA_VERSION,
  VERSION_REASONS,
  DEFAULT_LOCAL_AGENT,
  DEFAULT_GSX_CONNECTION,
};
