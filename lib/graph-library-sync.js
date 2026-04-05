'use strict';

/**
 * Graph Library Sync Engine
 *
 * Triggered when OmniGraph becomes available. Runs three phases:
 * 1. bootstrapOrg -- ensures Organization, Team, Library, and Person membership
 * 2. pushLocalToGraph -- upserts local IDWs, tools, and agents into the graph
 * 3. pullGraphToMenu -- reads enabled items from graph and refreshes the app menu
 *
 * All operations are idempotent (MERGE-based) and non-fatal.
 */

const { getOmniGraphClient } = require('../omnigraph-client');

let _syncCompleted = false;
let _syncInProgress = false;

function _log(level, msg, meta) {
  try {
    const { getLogQueue } = require('./log-event-queue');
    getLogQueue()[level]('graph-sync', msg, meta);
  } catch (_) {
    console[level === 'error' ? 'error' : 'log'](`[GraphSync] ${msg}`, meta || '');
  }
}

/**
 * Phase 3: Bootstrap the user's Organization, Team, Library, and membership.
 * If an org already exists for this user, skips creation.
 */
async function bootstrapOrg(client, email) {
  const existing = await client.getOrganizationForUser(email);
  if (existing) {
    _log('info', 'Org already exists for user', { orgId: existing.id, orgName: existing.name });
    return existing;
  }

  const domain = email.includes('@') ? email.split('@')[1] : 'personal';
  const orgId = `org-${domain.replace(/\./g, '-')}`;
  const teamId = `${orgId}-default`;
  const libraryId = `${orgId}-library`;

  _log('info', 'Bootstrapping org for user', { email, orgId });

  await client.ensurePerson(email);
  await client.ensureOrganization({ id: orgId, name: domain, domain });
  await client.ensureTeam({ id: teamId, name: 'Default', orgId, description: 'Default team' });
  await client.ensureLibrary({ id: libraryId, orgId, name: `${domain} Library` });
  await client.addTeamMember(teamId, email, 'admin');

  await client.ensureLibrarySchema();

  _log('info', 'Org bootstrapped', { orgId, teamId, libraryId });
  return { id: orgId, name: domain, libraryId };
}

/**
 * Phase 2: Push local IDWs, tools, and agents to the graph.
 * Creates nodes and links them to the Library + creates ENABLED edges.
 */
async function pushLocalToGraph(client, email, libraryId) {
  let pushed = { idws: 0, tools: 0, agents: 0 };

  // IDWs from MenuDataManager
  try {
    const mdm = global.menuDataManager;
    if (mdm && typeof mdm.getIDWEnvironments === 'function') {
      const idws = mdm.getIDWEnvironments() || [];
      for (const env of idws) {
        if (!env.id || !env.label) continue;
        const idwId = env.storeData?.idwId || env.id;
        try {
          await client.addToLibrary(libraryId, idwId, 'IDW');
          await client.enableItem(email, idwId, 'IDW', 'sync');
          pushed.idws++;
        } catch (_) {}
      }
    }
  } catch (err) {
    _log('warn', 'IDW push skipped', { error: err.message });
  }

  // Web tools from ModuleManager
  try {
    const mm = global.moduleManager;
    if (mm && typeof mm.getWebTools === 'function') {
      const tools = mm.getWebTools() || [];
      for (const tool of tools) {
        if (!tool.id) continue;
        try {
          await client.upsertTool(tool);
          await client.addToLibrary(libraryId, tool.id, 'Tool');
          await client.enableItem(email, tool.id, 'Tool', 'sync');
          pushed.tools++;
        } catch (_) {}
      }
    }
  } catch (err) {
    _log('warn', 'Tool push skipped', { error: err.message });
  }

  // Built-in agents
  try {
    const { getAllAgents } = require('../packages/agents/agent-registry');
    const builtins = getAllAgents() || [];
    const enabledStates = {};
    try {
      const settings = global.settingsManager;
      if (settings) {
        const states = settings.get('builtinAgentStates') || {};
        Object.assign(enabledStates, states);
      }
    } catch (_) {}

    for (const agent of builtins) {
      if (!agent.id) continue;
      try {
        await client.upsertAgent({
          id: agent.id,
          name: agent.name,
          description: agent.description,
          categories: agent.categories,
          keywords: agent.keywords,
          capabilities: agent.capabilities,
          executionType: agent.executionType,
          builtin: true,
        });
        await client.addToLibrary(libraryId, agent.id, 'Agent');
        if (enabledStates[agent.id] !== false) {
          await client.enableItem(email, agent.id, 'Agent', 'sync');
        }
        pushed.agents++;
      } catch (_) {}
    }
  } catch (err) {
    _log('warn', 'Agent push skipped', { error: err.message });
  }

  // Custom agents
  try {
    const { getAgentStore } = require('../src/voice-task-sdk/agent-store');
    const store = getAgentStore();
    if (store && store.initialized) {
      const customs = store.getLocalAgents() || [];
      for (const agent of customs) {
        if (!agent.id) continue;
        try {
          await client.upsertAgent({
            id: agent.id,
            name: agent.name,
            description: agent.description || '',
            categories: agent.categories || [],
            keywords: agent.keywords || [],
            executionType: agent.executionType || 'llm',
            builtin: false,
            prompt: agent.prompt || '',
          });
          await client.addToLibrary(libraryId, agent.id, 'Agent');
          if (agent.enabled !== false) {
            await client.enableItem(email, agent.id, 'Agent', 'sync');
          }
          pushed.agents++;
        } catch (_) {}
      }
    }
  } catch (err) {
    _log('warn', 'Custom agent push skipped', { error: err.message });
  }

  _log('info', 'Local data pushed to graph', pushed);
  return pushed;
}

/**
 * Phase 4: Pull enabled items from graph and refresh the app menu.
 * Graph becomes authoritative for IDWs in the menu.
 */
async function pullGraphToMenu(client, email) {
  const enabled = await client.getEnabledItems(email);

  // Convert graph IDW nodes to MenuDataManager format
  const menuIdws = (enabled.idws || []).map(node => ({
    id: `store-${node.id}`,
    label: node.name || node.label || node.id,
    chatUrl: node.url || node.chatUrl || '',
    type: 'idw',
    environment: 'store',
    description: node.description || '',
    category: node.category || '',
    storeData: {
      idwId: node.id,
      developer: node.developer || '',
      syncedAt: new Date().toISOString(),
    },
  }));

  const mdm = global.menuDataManager;
  if (mdm && typeof mdm.setIDWEnvironments === 'function' && menuIdws.length > 0) {
    // Merge: keep locally-added IDWs that aren't from the graph
    const current = mdm.getIDWEnvironments() || [];
    const graphIds = new Set(menuIdws.map(i => i.id));
    const localOnly = current.filter(e => !graphIds.has(e.id) && !e.storeData?.syncedAt);
    const merged = [...menuIdws, ...localOnly];

    await mdm.setIDWEnvironments(merged, { source: 'graph-sync' });
    _log('info', 'Menu updated from graph', { graphIdws: menuIdws.length, localOnly: localOnly.length });
  } else {
    _log('info', 'No graph IDWs to sync to menu', { count: menuIdws.length });
  }

  return enabled;
}

/**
 * Orchestrator: run all three phases in sequence.
 * Non-fatal -- failures are logged but the app keeps working from local data.
 * Runs at most once per session.
 */
async function triggerGraphSync(email) {
  if (_syncCompleted || _syncInProgress) {
    _log('info', 'Graph sync already completed or in progress, skipping');
    return;
  }

  if (!email || !email.includes('@')) {
    _log('warn', 'No valid email for graph sync', { email });
    return;
  }

  const client = getOmniGraphClient();
  if (!client.isReady()) {
    _log('warn', 'OmniGraph not ready, skipping sync');
    return;
  }

  _syncInProgress = true;
  _log('info', 'Starting graph sync', { email });

  try {
    const org = await bootstrapOrg(client, email);
    const libraryId = org.libraryId || `${org.id}-library`;

    await pushLocalToGraph(client, email, libraryId);
    await pullGraphToMenu(client, email);

    _syncCompleted = true;
    _log('info', 'Graph sync completed successfully');
  } catch (error) {
    _log('error', 'Graph sync failed (non-fatal)', { error: error.message });
  } finally {
    _syncInProgress = false;
  }
}

module.exports = {
  triggerGraphSync,
  bootstrapOrg,
  pushLocalToGraph,
  pullGraphToMenu,
};
