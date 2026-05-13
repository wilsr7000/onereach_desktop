/**
 * MCP Bridge Agent
 *
 * Bidder agent that routes voice requests to user-configured MCP servers.
 * Sits alongside time-agent / weather-agent / etc.; competes through the
 * normal unified-bidder so that a voice request matching an MCP tool wins
 * here and goes through MCP rather than the model's own knowledge.
 *
 * Why an agent instead of session.tools on the realtime model:
 *   - Bidder + budget tracking + agent memory + learning loop come for free.
 *   - The realtime session stays simple and predictable.
 *   - MCP servers can change at runtime without re-creating the session.
 *
 * Settings shape (in app-settings.json):
 *   "mcp.servers": [
 *     { id, label, url, headers, enabled }
 *   ]
 *
 * Lifecycle:
 *   - initialize() loads enabled servers, connects clients, primes tool list.
 *   - On settings change (caller's responsibility), call reload() to refresh.
 *   - execute(task) picks the best tool via LLM classification, calls it.
 *
 * @module packages/agents/mcp-bridge-agent
 */

const { getAIService } = require('../../lib/ai-service');
const { getAgentMemory } = require('../../lib/agent-memory-store');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// Default deps -- override via mcpBridgeAgent.__setDeps({...}) in tests so we
// don't fight vitest's path-based mock resolution for lazy/inline requires.
const _defaultDeps = {
  loadServers: () => {
    try {
      const settingsModule = require('../../settings-manager');
      const sm = settingsModule.getSettingsManager
        ? settingsModule.getSettingsManager()
        : settingsModule;
      return sm.get('mcp.servers') || [];
    } catch (_err) {
      return [];
    }
  },
  createClient: (config) => {
    const { createClient } = require('../../lib/mcp-client');
    return createClient(config);
  },
  aiJson: (...args) => getAIService().json(...args),
};

// Minimum confidence for the LLM tool picker before we commit to a tool call.
// Below this we abstain (success: false) so the bidder routes elsewhere.
const MIN_TOOL_CONFIDENCE = 0.6;

// Skeleton prompt used when no servers are reachable. The bidder still sees
// this and learns to lose; it never wins on a generic "MCP" mention.
const EMPTY_PROMPT = `MCP Bridge Agent is loaded but no MCP servers are reachable or configured.
Do not win on any request -- other agents should handle the task.`;

const mcpBridgeAgent = {
  id: 'mcp-bridge-agent',
  name: 'MCP Bridge Agent',
  description: 'Routes voice requests to user-configured MCP (Model Context Protocol) servers',
  voice: 'sage',
  acks: ['Routing that.', 'One moment.'],
  categories: ['system', 'mcp', 'integration'],
  keywords: [],
  executionType: 'action',
  estimatedExecutionMs: 3000,

  // Built dynamically in initialize() from the registered MCP servers'
  // tool lists. Read by unified-bidder.js at every bid evaluation, so a
  // mutation on this property after reload() is picked up on the next turn.
  prompt: EMPTY_PROMPT,

  memory: null,
  _clients: [],
  _toolIndex: [],
  _deps: _defaultDeps,

  /**
   * Test seam: swap in stub deps for settings-loading + client construction.
   * Production callers never use this.
   */
  __setDeps(deps) {
    this._deps = { ..._defaultDeps, ...(deps || {}) };
  },

  __resetDeps() {
    this._deps = _defaultDeps;
  },

  /**
   * Load configured MCP servers and connect a client to each enabled one.
   * Failures are logged but not fatal -- the agent stays loaded with an
   * empty prompt and loses all bids until the user fixes the server.
   */
  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('mcp-bridge-agent', { displayName: 'MCP Bridge Agent' });
      await this.memory.load();
    }
    await this._connectAllServers();
    return this.memory;
  },

  /**
   * Re-read the settings, drop existing clients, reconnect. Public so the
   * settings change handler can wire it up. Calls close() on each prior
   * client so stdio subprocesses get terminated before the new ones spawn.
   */
  async reload() {
    for (const c of this._clients) {
      try { if (typeof c.close === 'function') c.close(); } catch (_e) { /* ignore */ }
    }
    this._clients = [];
    this._toolIndex = [];
    await this._connectAllServers();
  },

  async _connectAllServers() {
    let servers = [];
    try {
      servers = this._deps.loadServers() || [];
    } catch (err) {
      log.warn('mcp', 'Failed to read mcp.servers from settings', { error: err.message });
      servers = [];
    }

    const enabled = (Array.isArray(servers) ? servers : []).filter((s) => s && s.enabled !== false);
    if (enabled.length === 0) {
      this.prompt = EMPTY_PROMPT;
      this._clients = [];
      this._toolIndex = [];
      return;
    }

    const clients = [];
    const toolIndex = [];

    for (const server of enabled) {
      try {
        const transport = server.transport === 'stdio' ? 'stdio' : 'http';
        const clientConfig = {
          transport,
          label: server.label || server.url || server.command,
        };
        if (transport === 'stdio') {
          clientConfig.command = server.command;
          clientConfig.args = Array.isArray(server.args) ? server.args : [];
          clientConfig.env = server.env || {};
          if (server.cwd) clientConfig.cwd = server.cwd;
        } else {
          clientConfig.url = server.url;
          clientConfig.headers = server.headers || {};
        }
        const client = this._deps.createClient(clientConfig);
        const tools = await client.listTools().catch((err) => {
          log.warn('mcp', `[${server.label}] listTools failed`, { error: err.message });
          return [];
        });
        clients.push(client);
        for (const t of tools) {
          toolIndex.push({ server: client.label, name: t.name, description: t.description, schema: t.inputSchema });
        }
      } catch (err) {
        log.warn('mcp', `Failed to connect MCP server ${server.label || server.url}`, {
          error: err.message,
        });
      }
    }

    this._clients = clients;
    this._toolIndex = toolIndex;
    this.prompt = this._buildPrompt(toolIndex);
    log.info('mcp', `Loaded ${toolIndex.length} tools from ${clients.length} servers`);
  },

  /**
   * Render the dynamic bidder prompt from the live tool list.
   * Cheap; called only on reload(), not per bid.
   */
  _buildPrompt(toolIndex) {
    if (!toolIndex || toolIndex.length === 0) return EMPTY_PROMPT;
    const lines = toolIndex
      .map((t) => `- ${t.server}.${t.name}: ${t.description || '(no description)'}`)
      .join('\n');
    return `MCP Bridge Agent routes voice requests to user-configured MCP servers.

Available tools (server.tool_name : description):
${lines}

WIN when the user's request clearly matches one of these tools.
LOSE when no tool matches, or when a built-in agent (time, weather, calendar,
spaces, email, search, etc.) is a better fit.

Examples of when to win:
- A tool named "github_search_issues" exists and the user asks "find GitHub issues about login"
- A tool named "jira_create_ticket" exists and the user asks "create a Jira ticket for the bug we discussed"

Examples of when to lose:
- "What time is it?" -- time-agent
- "Weather in Boston" -- weather-agent
- "Open my calendar" -- calendar-mutate-agent
- "Find an item in my Spaces" -- spaces-agent`;
  },

  async execute(task) {
    try {
      if (!this.memory) await this.initialize();

      if (this._toolIndex.length === 0) {
        return {
          success: false,
          message: 'No MCP servers configured. Add one in Settings > MCP Servers.',
        };
      }

      // Ask the fast model to pick a tool from the registered set.
      const choicePrompt = `Pick the best MCP tool to handle the user's request, or abstain.

User said: "${task.content}"

Available tools (server.name : description):
${this._toolIndex.map((t) => `- ${t.server}.${t.name}: ${t.description || ''}`).join('\n')}

Respond with strict JSON only. Either:
{"server": "<server label>", "tool": "<tool name>", "args": { ... }, "confidence": 0..1}
or
{"abstain": true, "reason": "<short reason>"}`;

      const choice = await this._deps.aiJson(choicePrompt, {
        profile: 'fast',
        feature: 'mcp-bridge-agent.pick-tool',
        maxTokens: 500,
      });

      if (choice.abstain || !choice.server || !choice.tool) {
        return {
          success: false,
          message: choice.reason || 'No matching MCP tool for that request.',
        };
      }
      if (typeof choice.confidence === 'number' && choice.confidence < MIN_TOOL_CONFIDENCE) {
        return {
          success: false,
          message: 'Not confident enough in the MCP tool match.',
        };
      }

      const client = this._clients.find((c) => c.label === choice.server);
      if (!client) {
        return { success: false, message: `Unknown MCP server: ${choice.server}` };
      }

      const result = await client.callTool(choice.tool, choice.args || {});
      const message = typeof result === 'string' ? result : JSON.stringify(result);
      return { success: true, message };
    } catch (err) {
      log.error('mcp', 'execute error', { error: err.message });
      return { success: false, message: err.message || 'MCP tool call failed.' };
    }
  },

  cleanup() {
    for (const c of this._clients) {
      try { if (typeof c.close === 'function') c.close(); } catch (_e) { /* ignore */ }
    }
    this._clients = [];
    this._toolIndex = [];
  },
};

module.exports = mcpBridgeAgent;
