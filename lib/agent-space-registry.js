/**
 * Agent Space Registry
 * 
 * Manages agent-to-space groupings backed by Git-versioned Spaces v3.0.
 * Each "agent space" is a real Space (type: 'agent-group') that defines
 * which agents are available in a given context.
 * 
 * Tools (orb, command HUD, recorder, etc.) select an agent space to
 * scope which agents can bid on tasks submitted from that tool.
 * 
 * Supports three agent types:
 * - builtin: Local Electron agents from packages/agents/
 * - remote: GSX-hosted agents with HTTP endpoints
 * - custom: User-defined agents via agent-store
 * 
 * @module AgentSpaceRegistry
 */

const { getSpacesAPI } = require('../spaces-api');
const path = require('path');
const fs = require('fs');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// Lazy-loaded -- spaces-git may not be initialized yet
let _spacesGit = null;
function _getSpacesGit() {
  if (!_spacesGit) {
    try {
      const { getSpacesGit } = require('./spaces-git');
      _spacesGit = getSpacesGit();
    } catch (e) {
      // spaces-git not available
    }
  }
  return _spacesGit;
}

// ==================== CONSTANTS ====================

const AGENT_SPACE_CATEGORY = 'agent-group';
const REGISTRY_VERSION = '1.0';

/**
 * Default agent spaces created on first run.
 * Maps space ID -> { name, description, agentIds, defaultForTools }
 */
const DEFAULT_SPACES = {
  'general-agents': {
    name: 'General Agents',
    description: 'Default agents for general voice commands and productivity',
    icon: '~',
    color: '#64c8ff',
    agentIds: [
      'orchestrator-agent', 'app-agent', 'spaces-agent', 'time-agent',
      'weather-agent', 'calendar-agent', 'help-agent', 'search-agent',
      'smalltalk-agent', 'dj-agent', 'email-agent', 'recorder-agent',
    ],
    defaultForTools: ['orb', 'command-hud'],
    allowAllAgents: false,
  },
  'meeting-agents': {
    name: 'Meeting Agents',
    description: 'Agents for meeting context: action items, decisions, notes',
    icon: '~',
    color: '#a78bfa',
    agentIds: [
      'action-item-agent', 'decision-agent', 'meeting-notes-agent',
      'time-agent', 'calendar-agent',
    ],
    defaultForTools: ['recorder'],
    allowAllAgents: false,
  },
};

// ==================== IN-MEMORY CACHE ====================

let _spaceCache = null;      // spaceId -> space config
let _initialized = false;
let _initPromise = null;

// ==================== CORE REGISTRY ====================

/**
 * Initialize the registry -- load existing agent spaces or bootstrap defaults.
 * Safe to call multiple times (idempotent).
 */
async function initialize() {
  if (_initialized) return;
  if (_initPromise) return _initPromise;

  _initPromise = _doInitialize();
  await _initPromise;
  _initPromise = null;
}

async function _doInitialize() {
  log.info('agent', 'Initializing...');
  _spaceCache = new Map();

  try {
    const api = getSpacesAPI();
    const allSpaces = await api.list();

    // Find existing agent-group spaces by checking metadata
    let foundAgentSpaces = 0;
    for (const space of allSpaces) {
      try {
        const full = await api.get(space.id);
        const meta = full?.metadata || {};
        if (meta.attributes?.category === AGENT_SPACE_CATEGORY ||
            meta.agentSpace) {
          _spaceCache.set(space.id, _extractAgentSpaceConfig(space.id, full));
          foundAgentSpaces++;
        }
      } catch (e) {
        // Skip spaces we cannot read
      }
    }

    if (foundAgentSpaces === 0) {
      log.info('agent', 'No agent spaces found, bootstrapping defaults');
      await _bootstrapDefaults(api);
    } else {
      log.info('agent', 'Loaded agent spaces', { foundAgentSpaces: foundAgentSpaces });
    }

    _initialized = true;
    log.info('agent', 'Ready');
  } catch (error) {
    log.error('agent', 'Init error', { error: error.message });
    // Fall back to in-memory defaults so the app still works
    _bootstrapInMemoryDefaults();
    _initialized = true;
  }
}

/**
 * Extract agent space config from a full Space object.
 */
function _extractAgentSpaceConfig(spaceId, fullSpace) {
  const meta = fullSpace?.metadata || {};
  const agentSpace = meta.agentSpace || {};
  return {
    id: spaceId,
    name: fullSpace.name || spaceId,
    description: meta.attributes?.description || '',
    agents: agentSpace.agents || [],
    defaultForTools: agentSpace.defaultForTools || [],
    allowAllAgents: agentSpace.allowAllAgents || false,
  };
}

/**
 * Bootstrap default agent spaces by creating real Spaces.
 */
async function _bootstrapDefaults(api) {
  for (const [spaceId, def] of Object.entries(DEFAULT_SPACES)) {
    try {
      // Check if space already exists (by ID)
      const existing = await api.get(spaceId);
      if (existing) {
        // Update its metadata to include agent space config
        await _writeAgentSpaceMetadata(api, spaceId, def);
        _spaceCache.set(spaceId, {
          id: spaceId,
          name: def.name,
          description: def.description,
          agents: def.agentIds.map(id => ({ id, type: 'builtin', enabled: true })),
          defaultForTools: def.defaultForTools,
          allowAllAgents: def.allowAllAgents,
        });
        continue;
      }

      // Create the space
      const space = await api.create(def.name, {
        icon: def.icon,
        color: def.color,
      });
      const actualId = space.id;

      // Write agent space metadata
      await _writeAgentSpaceMetadata(api, actualId, def);

      _spaceCache.set(actualId, {
        id: actualId,
        name: def.name,
        description: def.description,
        agents: def.agentIds.map(id => ({ id, type: 'builtin', enabled: true })),
        defaultForTools: def.defaultForTools,
        allowAllAgents: def.allowAllAgents,
      });

      // Also cache under the requested ID if different
      if (actualId !== spaceId) {
        _spaceCache.set(spaceId, _spaceCache.get(actualId));
      }

      log.info('agent', 'Created space: ()', { def: def.name, actualId: actualId });
    } catch (error) {
      log.error('agent', 'Failed to create', { spaceId: spaceId, error: error.message });
      // Fall back to in-memory for this space
      _spaceCache.set(spaceId, {
        id: spaceId,
        name: def.name,
        description: def.description,
        agents: def.agentIds.map(id => ({ id, type: 'builtin', enabled: true })),
        defaultForTools: def.defaultForTools,
        allowAllAgents: def.allowAllAgents,
      });
    }
  }
}

/**
 * Write agent space metadata to a Space's metadata file.
 */
async function _writeAgentSpaceMetadata(api, spaceId, def) {
  try {
    const metadataUpdate = {
      attributes: {
        category: AGENT_SPACE_CATEGORY,
        description: def.description,
        tags: ['agents', 'agent-group'],
      },
      agentSpace: {
        version: REGISTRY_VERSION,
        agents: def.agentIds.map(id => ({ id, type: 'builtin', enabled: true })),
        defaultForTools: def.defaultForTools,
        allowAllAgents: def.allowAllAgents || false,
      },
    };
    await api.metadata.updateSpace(spaceId, metadataUpdate);
  } catch (error) {
    log.warn('agent', 'Could not write metadata for', { spaceId: spaceId, error: error.message });
  }
}

/**
 * In-memory-only defaults when Spaces API is unavailable.
 */
function _bootstrapInMemoryDefaults() {
  for (const [spaceId, def] of Object.entries(DEFAULT_SPACES)) {
    _spaceCache.set(spaceId, {
      id: spaceId,
      name: def.name,
      description: def.description,
      agents: def.agentIds.map(id => ({ id, type: 'builtin', enabled: true })),
      defaultForTools: def.defaultForTools,
      allowAllAgents: def.allowAllAgents,
    });
  }
  log.info('agent', 'Using in-memory defaults');
}

// ==================== PUBLIC API ====================

/**
 * Get all agent spaces.
 * @returns {Array<Object>} Array of { id, name, description, agents, defaultForTools, allowAllAgents }
 */
async function getAgentSpaces() {
  await initialize();
  return Array.from(_spaceCache.values());
}

/**
 * Get a single agent space by ID.
 * @param {string} spaceId
 * @returns {Object|null}
 */
async function getAgentSpace(spaceId) {
  await initialize();
  return _spaceCache.get(spaceId) || null;
}

/**
 * Get agent IDs assigned to a space.
 * Returns only enabled agents.
 * @param {string} spaceId
 * @returns {string[]} Array of agent IDs
 */
async function getAgentIdsInSpace(spaceId) {
  await initialize();
  const space = _spaceCache.get(spaceId);
  if (!space) {
    log.warn('agent', 'Unknown space', { spaceId: spaceId });
    return [];
  }
  return space.agents
    .filter(a => a.enabled !== false)
    .map(a => a.id);
}

/**
 * Get full agent entries (with type, enabled, endpoint info) for a space.
 * @param {string} spaceId
 * @returns {Array<Object>} Agent entries
 */
async function getAgentsInSpace(spaceId) {
  await initialize();
  const space = _spaceCache.get(spaceId);
  if (!space) return [];
  return space.agents.filter(a => a.enabled !== false);
}

/**
 * Get remote agent entries for a space (type === 'remote').
 * @param {string} spaceId
 * @returns {Array<Object>} Remote agent entries with endpoint info
 */
async function getRemoteAgentsInSpace(spaceId) {
  await initialize();
  const space = _spaceCache.get(spaceId);
  if (!space) return [];
  return space.agents.filter(a => a.type === 'remote' && a.enabled !== false);
}

/**
 * Get the default agent space for a tool.
 * @param {string} toolId - e.g. 'orb', 'command-hud', 'recorder'
 * @returns {string|null} Space ID
 */
async function getDefaultSpaceForTool(toolId) {
  await initialize();
  for (const [spaceId, space] of _spaceCache) {
    if (space.defaultForTools?.includes(toolId)) {
      return spaceId;
    }
  }
  // Fallback to general-agents
  return _spaceCache.has('general-agents') ? 'general-agents' : null;
}

/**
 * Get all spaces that an agent belongs to.
 * @param {string} agentId
 * @returns {string[]} Array of space IDs
 */
async function getSpacesForAgent(agentId) {
  await initialize();
  const result = [];
  for (const [spaceId, space] of _spaceCache) {
    if (space.agents.some(a => a.id === agentId)) {
      result.push(spaceId);
    }
  }
  return result;
}

/**
 * Create a new agent space.
 * @param {string} name - Display name
 * @param {Object} config
 * @param {string} config.description
 * @param {string[]} config.agentIds - Initial agent IDs
 * @param {string[]} config.defaultForTools
 * @param {boolean} config.allowAllAgents
 * @returns {Object} Created space config
 */
async function createAgentSpace(name, config = {}) {
  await initialize();

  const def = {
    name,
    description: config.description || '',
    agentIds: config.agentIds || [],
    defaultForTools: config.defaultForTools || [],
    allowAllAgents: config.allowAllAgents || false,
    icon: config.icon || '~',
    color: config.color || '#64c8ff',
  };

  try {
    const api = getSpacesAPI();
    const space = await api.create(name, {
      icon: def.icon,
      color: def.color,
    });

    await _writeAgentSpaceMetadata(api, space.id, def);
    
    // Git commit for space creation
    await _commitAgentSpaceChange(space.id, 'create-space', { name });

    const spaceConfig = {
      id: space.id,
      name: def.name,
      description: def.description,
      agents: def.agentIds.map(id => ({ id, type: 'builtin', enabled: true })),
      defaultForTools: def.defaultForTools,
      allowAllAgents: def.allowAllAgents,
    };

    _spaceCache.set(space.id, spaceConfig);
    log.info('agent', 'Created agent space: ()', { name: name, space: space.id });
    return spaceConfig;
  } catch (error) {
    log.error('agent', 'Failed to create space', { error: error.message });
    throw error;
  }
}

/**
 * Assign an agent to a space.
 * @param {string} agentId
 * @param {string} spaceId
 * @param {Object} config - Optional: { type, endpoint, authToken, healthCheck }
 */
async function assignAgent(agentId, spaceId, config = {}) {
  await initialize();
  const space = _spaceCache.get(spaceId);
  if (!space) throw new Error(`Unknown agent space: ${spaceId}`);

  // Check if already assigned
  if (space.agents.some(a => a.id === agentId)) {
    log.info('agent', 'Agent already in space', { agentId: agentId, spaceId: spaceId });
    return;
  }

  const entry = {
    id: agentId,
    type: config.type || 'builtin',
    enabled: true,
    ...config,
  };

  space.agents.push(entry);
  await _persistSpace(spaceId, space, 'assign-agent', { agentId });
  log.info('agent', 'Assigned to', { agentId: agentId, spaceId: spaceId });
}

/**
 * Remove an agent from a space.
 * @param {string} agentId
 * @param {string} spaceId
 */
async function removeAgent(agentId, spaceId) {
  await initialize();
  const space = _spaceCache.get(spaceId);
  if (!space) return;

  space.agents = space.agents.filter(a => a.id !== agentId);
  await _persistSpace(spaceId, space, 'remove-agent', { agentId });
  log.info('agent', 'Removed from', { agentId: agentId, spaceId: spaceId });
}

/**
 * Enable or disable an agent within a space.
 * @param {string} spaceId
 * @param {string} agentId
 * @param {boolean} enabled
 */
async function setAgentEnabled(spaceId, agentId, enabled) {
  await initialize();
  const space = _spaceCache.get(spaceId);
  if (!space) return;

  const entry = space.agents.find(a => a.id === agentId);
  if (entry) {
    entry.enabled = enabled;
    await _persistSpace(spaceId, space, 'toggle-agent', { agentId, enabled });
  }
}

/**
 * Update the default space for a tool.
 * @param {string} toolId
 * @param {string} spaceId
 */
async function setDefaultSpaceForTool(toolId, spaceId) {
  await initialize();

  // Remove toolId from all spaces
  for (const [, space] of _spaceCache) {
    space.defaultForTools = (space.defaultForTools || []).filter(t => t !== toolId);
  }

  // Add to target space
  const space = _spaceCache.get(spaceId);
  if (space) {
    space.defaultForTools = space.defaultForTools || [];
    space.defaultForTools.push(toolId);
    await _persistSpace(spaceId, space, 'set-tool-default', { toolId });
  }
}

/**
 * Commit an agent space change to Git (non-blocking, non-fatal).
 * 
 * Creates a targeted commit of the space-metadata.json for the given space,
 * with a descriptive message. If Git is not initialized or the commit fails,
 * the operation is logged but does NOT block the caller.
 * 
 * @param {string} spaceId - Space ID
 * @param {string} operation - Operation type (e.g. 'create-space', 'assign-agent')
 * @param {Object} context - Additional context for commit message
 * @returns {Promise<{sha: string}|null>}
 */
async function _commitAgentSpaceChange(spaceId, operation, context = {}) {
  try {
    const spacesGit = _getSpacesGit();
    if (!spacesGit || !spacesGit.isInitialized()) {
      return null;
    }

    const messages = {
      'create-space': `Create agent space: ${context.name || spaceId}`,
      'assign-agent': `Assign agent ${context.agentId || '?'} to space ${spaceId}`,
      'remove-agent': `Remove agent ${context.agentId || '?'} from space ${spaceId}`,
      'toggle-agent': `${context.enabled ? 'Enable' : 'Disable'} agent ${context.agentId || '?'} in ${spaceId}`,
      'set-tool-default': `Set tool ${context.toolId || '?'} default to space ${spaceId}`,
      'delete-space': `Delete agent space: ${spaceId}`,
      'bootstrap': `Bootstrap default agent space: ${spaceId}`,
      'update-metadata': `Update agent space metadata: ${spaceId}`,
    };

    const message = messages[operation] || `Update agent space: ${spaceId}`;
    const authorName = context.author || 'system';

    const result = await spacesGit.commit({
      filepaths: [`spaces/${spaceId}/space-metadata.json`],
      message,
      authorName,
      authorEmail: `${authorName}@onereach.ai`,
    });

    log.info('agent', 'Git commit: ()', { message: message, result: result?.sha?.substring(0, 7) || 'no-sha' });
    return result;
  } catch (error) {
    // Non-fatal: log and continue
    log.warn('agent', 'Git commit failed for', { operation: operation, error: error.message });
    return null;
  }
}

/**
 * Persist a space's agent config to Spaces API metadata.
 */
async function _persistSpace(spaceId, space, operation = 'update-metadata', commitContext = {}) {
  try {
    const api = getSpacesAPI();
    await api.metadata.updateSpace(spaceId, {
      attributes: {
        category: AGENT_SPACE_CATEGORY,
        description: space.description,
        tags: ['agents', 'agent-group'],
      },
      agentSpace: {
        version: REGISTRY_VERSION,
        agents: space.agents,
        defaultForTools: space.defaultForTools,
        allowAllAgents: space.allowAllAgents,
      },
    });

    // Auto-commit to Git (non-blocking)
    await _commitAgentSpaceChange(spaceId, operation, commitContext);
  } catch (error) {
    log.warn('agent', 'Persist failed for', { spaceId: spaceId, error: error.message });
    // In-memory state is still updated
  }
}

/**
 * Delete an agent space.
 * @param {string} spaceId
 */
async function deleteAgentSpace(spaceId) {
  await initialize();
  
  // Git commit BEFORE deletion (so the deletion is recorded)
  await _commitAgentSpaceChange(spaceId, 'delete-space', {});
  
  _spaceCache.delete(spaceId);
  try {
    const api = getSpacesAPI();
    await api.delete(spaceId);
    log.info('agent', 'Deleted agent space', { spaceId: spaceId });
  } catch (error) {
    log.warn('agent', 'Delete failed for', { spaceId: spaceId, error: error.message });
  }
}

/**
 * Clear cache and re-initialize (for testing/hot-reload).
 */
function clearCache() {
  _spaceCache = null;
  _initialized = false;
  _initPromise = null;
  log.info('agent', 'Cache cleared');
}

// ==================== SINGLETON ====================

let _instance = null;

function getAgentSpaceRegistry() {
  if (!_instance) {
    _instance = {
      initialize,
      getAgentSpaces,
      getAgentSpace,
      getAgentIdsInSpace,
      getAgentsInSpace,
      getRemoteAgentsInSpace,
      getDefaultSpaceForTool,
      getSpacesForAgent,
      createAgentSpace,
      assignAgent,
      removeAgent,
      setAgentEnabled,
      setDefaultSpaceForTool,
      deleteAgentSpace,
      clearCache,
      // Constants
      DEFAULT_SPACES,
      AGENT_SPACE_CATEGORY,
    };
  }
  return _instance;
}

module.exports = {
  getAgentSpaceRegistry,
  // Direct exports for convenience
  initialize,
  getAgentSpaces,
  getAgentSpace,
  getAgentIdsInSpace,
  getAgentsInSpace,
  getRemoteAgentsInSpace,
  getDefaultSpaceForTool,
  getSpacesForAgent,
  createAgentSpace,
  assignAgent,
  removeAgent,
  setAgentEnabled,
  setDefaultSpaceForTool,
  deleteAgentSpace,
  clearCache,
  DEFAULT_SPACES,
  AGENT_SPACE_CATEGORY,
};
