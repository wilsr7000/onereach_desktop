/**
 * WebMCP Consumer -- main-process orchestrator for WebMCP tool discovery.
 *
 * Receives tool definitions discovered by the bridge script in webviews,
 * creates lightweight proxy agents, and registers them with the exchange
 * so they participate in the normal auction-based routing.
 *
 * Lifecycle:
 *   Page loads → bridge detects tools → IPC here → proxy agent created
 *   Page navigates / tab closes   → proxy agents unregistered
 */

const { ipcMain, BrowserWindow } = require('electron');
const WebSocket = require('ws');
const { getLogQueue } = require('./log-event-queue');
const ai = require('./ai-service');

let exchangeTracking = null;
try {
  exchangeTracking = require('../src/voice-task-sdk/exchange-bridge');
} catch {
  // Exchange bridge may not be available yet
}

const log = getLogQueue();
const PROTOCOL_VERSION = '1.0.0';

// tabId -> { tools: Map<name, toolDef>, agents: Map<name, { ws, heartbeat }>, origin: string }
const tabToolSets = new Map();

let exchangePort = 3456;
let enabled = false;

// ── Public API ─────────────────────────────────────────────

function init(port = 3456) {
  if (enabled) return;
  exchangePort = port;
  enabled = true;

  ipcMain.handle('webmcp:tools-discovered', handleToolsDiscovered);
  ipcMain.handle('webmcp:tool-registered', handleSingleToolRegistered);
  ipcMain.handle('webmcp:tool-unregistered', handleToolUnregistered);
  ipcMain.handle('webmcp:context-cleared', handleContextCleared);
  ipcMain.handle('webmcp:tab-closed', handleTabClosed);
  ipcMain.handle('webmcp:tab-navigated', handleTabNavigated);
  ipcMain.handle('webmcp:call-tool-result', handleCallToolResult);

  log.info('webmcp', 'WebMCP consumer initialized', { port: exchangePort });
}

function shutdown() {
  if (!enabled) return;
  for (const tabId of tabToolSets.keys()) {
    cleanupTab(tabId);
  }
  tabToolSets.clear();
  enabled = false;
  log.info('webmcp', 'WebMCP consumer shut down');
}

function getDiscoveredTools() {
  const result = {};
  for (const [tabId, tabSet] of tabToolSets) {
    result[tabId] = {
      origin: tabSet.origin,
      tools: Array.from(tabSet.tools.values()),
    };
  }
  return result;
}

// ── IPC Handlers ───────────────────────────────────────────

async function handleToolsDiscovered(_event, { tabId, tools, origin }) {
  if (!enabled || !Array.isArray(tools) || tools.length === 0) return { ok: true };

  ensureTabSet(tabId, origin);
  const tabSet = tabToolSets.get(tabId);

  for (const tool of tools) {
    if (!tool.name) continue;
    tabSet.tools.set(tool.name, tool);
    await registerProxyAgent(tabId, tool);
  }

  log.info('webmcp', `Discovered ${tools.length} tool(s) on tab ${tabId}`, {
    origin,
    names: tools.map((t) => t.name).join(', '),
  });
  return { ok: true, count: tools.length };
}

async function handleSingleToolRegistered(_event, { tabId, tool, origin }) {
  if (!enabled || !tool?.name) return { ok: false };

  ensureTabSet(tabId, origin);
  const tabSet = tabToolSets.get(tabId);
  tabSet.tools.set(tool.name, tool);
  await registerProxyAgent(tabId, tool);

  log.info('webmcp', `Tool registered: ${tool.name} on tab ${tabId}`);
  return { ok: true };
}

async function handleToolUnregistered(_event, { tabId, name }) {
  if (!enabled) return;
  const tabSet = tabToolSets.get(tabId);
  if (!tabSet) return;

  tabSet.tools.delete(name);
  disconnectProxyAgent(tabId, name);
  log.info('webmcp', `Tool unregistered: ${name} on tab ${tabId}`);
}

async function handleContextCleared(_event, { tabId }) {
  if (!enabled) return;
  cleanupTab(tabId);
  log.info('webmcp', `Context cleared on tab ${tabId}`);
}

async function handleTabClosed(_event, { tabId }) {
  if (!enabled) return;
  cleanupTab(tabId);
  tabToolSets.delete(tabId);
  log.info('webmcp', `Tab closed: ${tabId}`);
}

async function handleTabNavigated(_event, { tabId, origin }) {
  if (!enabled) return;
  cleanupTab(tabId);
  ensureTabSet(tabId, origin);
  log.info('webmcp', `Tab navigated: ${tabId} → ${origin}`);
}

// Placeholder -- used when the renderer sends back tool execution results
const pendingCalls = new Map(); // callId -> { resolve, reject }

async function handleCallToolResult(_event, { callId, result, error }) {
  const pending = pendingCalls.get(callId);
  if (!pending) return;
  pendingCalls.delete(callId);
  if (error) {
    pending.reject(new Error(error));
  } else {
    pending.resolve(result);
  }
}

// ── Proxy Agent Management ─────────────────────────────────

function proxyAgentId(tabId, toolName) {
  return `webmcp-${tabId}-${toolName}`;
}

async function registerProxyAgent(tabId, tool) {
  const tabSet = tabToolSets.get(tabId);
  if (!tabSet) return;

  const agentId = proxyAgentId(tabId, tool.name);

  // Already registered
  if (tabSet.agents.has(tool.name)) {
    const existing = tabSet.agents.get(tool.name);
    if (existing.ws?.readyState === WebSocket.OPEN) return;
    disconnectProxyAgent(tabId, tool.name);
  }

  const categories = deriveCategories(tool);

  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${exchangePort}`);

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'register',
          protocolVersion: PROTOCOL_VERSION,
          agentId,
          agentVersion: '1.0.0',
          categories,
          capabilities: {
            executionType: 'webmcp-proxy',
            toolName: tool.name,
            toolDescription: tool.description,
            inputSchema: tool.inputSchema,
            tabId,
            origin: tabSet.origin,
          },
        })
      );

      const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      }, 25000);

      tabSet.agents.set(tool.name, { ws, heartbeat });
      if (exchangeTracking?.trackWebMCPAgent) {
        exchangeTracking.trackWebMCPAgent(agentId, {
          tabId,
          toolName: tool.name,
          origin: tabSet.origin,
        });
      }
      log.info('webmcp', `Proxy agent registered: ${agentId}`);
      resolve();
    });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'bid_request') {
          await handleProxyBid(ws, agentId, tool, msg);
        } else if (msg.type === 'task_assignment') {
          await handleProxyExecution(ws, agentId, tabId, tool, msg);
        }
      } catch (err) {
        log.error('webmcp', `Proxy agent message error: ${err.message}`, { agentId });
      }
    });

    ws.on('error', (err) => {
      log.warn('webmcp', `Proxy agent WS error: ${err.message}`, { agentId });
    });

    ws.on('close', () => {
      const conn = tabSet.agents.get(tool.name);
      if (conn?.heartbeat) clearInterval(conn.heartbeat);
    });

    setTimeout(() => resolve(), 5000); // Don't block forever
  });
}

function disconnectProxyAgent(tabId, toolName) {
  const tabSet = tabToolSets.get(tabId);
  if (!tabSet) return;

  const agentId = proxyAgentId(tabId, toolName);
  const conn = tabSet.agents.get(toolName);
  if (conn) {
    if (conn.heartbeat) clearInterval(conn.heartbeat);
    if (conn.ws?.readyState === WebSocket.OPEN) {
      conn.ws.close(1000, 'Tool unregistered');
    }
    tabSet.agents.delete(toolName);
  }
  if (exchangeTracking?.untrackWebMCPAgent) {
    exchangeTracking.untrackWebMCPAgent(agentId);
  }
}

// ── Bidding ────────────────────────────────────────────────

async function handleProxyBid(ws, agentId, tool, msg) {
  const taskContent = msg.task?.content || '';
  let confidence = 0;
  let reasoning = '';

  try {
    const evaluation = await ai.json(
      `You are evaluating whether a WebMCP tool matches a user task.

Tool name: ${tool.name}
Tool description: ${tool.description}
Tool input schema: ${JSON.stringify(tool.inputSchema || {})}

User task: "${taskContent}"

Respond with JSON: { "confidence": <0.0-1.0>, "reasoning": "<why>" }
A confidence of 0.9+ means the tool is an exact match for the task.
A confidence below 0.2 means the tool is irrelevant.`,
      { profile: 'fast', feature: 'webmcp-bid' }
    );
    confidence = evaluation.confidence || 0;
    reasoning = evaluation.reasoning || '';
  } catch (err) {
    log.warn('webmcp', `Proxy bid evaluation failed: ${err.message}`, { agentId });
  }

  ws.send(
    JSON.stringify({
      type: 'bid_response',
      auctionId: msg.auctionId,
      agentId,
      agentVersion: '1.0.0',
      bid:
        confidence > 0.1
          ? { confidence, reasoning, estimatedTimeMs: 5000, tier: 'webmcp' }
          : null,
    })
  );
}

// ── Execution ──────────────────────────────────────────────

async function handleProxyExecution(ws, agentId, tabId, tool, msg) {
  // ACK
  try {
    ws.send(
      JSON.stringify({
        type: 'task_ack',
        taskId: msg.taskId,
        agentId,
        estimatedMs: 10000,
      })
    );
  } catch (_) {
    /* best-effort */
  }

  const heartbeatTimer = setInterval(() => {
    try {
      ws.send(
        JSON.stringify({
          type: 'task_heartbeat',
          taskId: msg.taskId,
          agentId,
          progress: 'Executing WebMCP tool...',
        })
      );
    } catch (_) {
      clearInterval(heartbeatTimer);
    }
  }, 10000);

  try {
    const taskContent = msg.task?.content || '';

    // Use LLM to extract tool arguments from the task description
    let toolInput = {};
    if (tool.inputSchema && Object.keys(tool.inputSchema.properties || {}).length > 0) {
      try {
        toolInput = await ai.json(
          `Extract the input arguments for a tool call from the user's request.

Tool name: ${tool.name}
Tool description: ${tool.description}
Tool input schema: ${JSON.stringify(tool.inputSchema)}

User request: "${taskContent}"

Respond with ONLY the JSON object matching the input schema.`,
          { profile: 'fast', feature: 'webmcp-args' }
        );
      } catch (err) {
        log.warn('webmcp', `Arg extraction failed: ${err.message}`, { agentId });
      }
    }

    // Route execution to the webview via IPC
    const result = await callToolInWebview(tabId, tool.name, toolInput);

    clearInterval(heartbeatTimer);

    ws.send(
      JSON.stringify({
        type: 'task_result',
        taskId: msg.taskId,
        result: {
          success: !result.error,
          output: result.error
            ? `WebMCP tool "${tool.name}" failed: ${result.error}`
            : formatToolResult(tool.name, result.result),
          error: result.error || undefined,
        },
      })
    );
  } catch (err) {
    clearInterval(heartbeatTimer);
    ws.send(
      JSON.stringify({
        type: 'task_result',
        taskId: msg.taskId,
        result: {
          success: false,
          output: `WebMCP tool execution failed: ${err.message}`,
          error: err.message,
        },
      })
    );
  }
}

// ── Webview Communication ──────────────────────────────────

let callIdCounter = 0;

async function callToolInWebview(tabId, toolName, input) {
  const callId = `wmcp-${++callIdCounter}-${Date.now()}`;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCalls.delete(callId);
      reject(new Error('WebMCP tool call timed out after 30s'));
    }, 30000);

    pendingCalls.set(callId, {
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    // Send to the renderer hosting the tabbed browser
    const browserWindows = BrowserWindow.getAllWindows();
    const browserWin = browserWindows.find(
      (w) => !w.isDestroyed() && w.webContents.getURL().includes('tabbed-browser.html')
    );

    if (!browserWin) {
      pendingCalls.delete(callId);
      clearTimeout(timeout);
      reject(new Error('Browser window not found'));
      return;
    }

    browserWin.webContents.send('webmcp:call-tool', {
      callId,
      tabId,
      toolName,
      input,
    });
  });
}

// ── Helpers ────────────────────────────────────────────────

function ensureTabSet(tabId, origin) {
  if (!tabToolSets.has(tabId)) {
    tabToolSets.set(tabId, {
      tools: new Map(),
      agents: new Map(),
      origin: origin || 'unknown',
    });
  } else if (origin) {
    tabToolSets.get(tabId).origin = origin;
  }
}

function cleanupTab(tabId) {
  const tabSet = tabToolSets.get(tabId);
  if (!tabSet) return;

  for (const toolName of tabSet.agents.keys()) {
    disconnectProxyAgent(tabId, toolName);
  }
  tabSet.tools.clear();
  tabSet.agents.clear();
}

function deriveCategories(tool) {
  const desc = (tool.description || '').toLowerCase();
  const name = (tool.name || '').toLowerCase();
  const text = `${name} ${desc}`;
  const categories = ['webmcp', 'web-tools'];

  const categoryHints = {
    search: ['search', 'find', 'query', 'lookup'],
    navigation: ['navigate', 'open', 'url', 'browse', 'page'],
    'data-retrieval': ['get', 'fetch', 'list', 'read', 'retrieve'],
    'data-modification': ['create', 'update', 'delete', 'add', 'remove', 'set', 'write'],
    commerce: ['cart', 'buy', 'purchase', 'order', 'checkout', 'product'],
    communication: ['send', 'email', 'message', 'notify', 'share'],
    authentication: ['login', 'auth', 'sign', 'token', 'session'],
    media: ['image', 'video', 'audio', 'file', 'upload', 'download'],
  };

  for (const [category, keywords] of Object.entries(categoryHints)) {
    if (keywords.some((kw) => text.includes(kw))) {
      categories.push(category);
    }
  }

  return categories;
}

function formatToolResult(toolName, result) {
  if (result === null || result === undefined) {
    return `Tool "${toolName}" executed successfully (no return value).`;
  }
  if (typeof result === 'string') return result;
  try {
    const json = JSON.stringify(result, null, 2);
    if (json.length > 2000) {
      return `Tool "${toolName}" returned:\n${json.substring(0, 2000)}...(truncated)`;
    }
    return `Tool "${toolName}" returned:\n${json}`;
  } catch {
    return `Tool "${toolName}" returned: ${String(result)}`;
  }
}

module.exports = {
  init,
  shutdown,
  getDiscoveredTools,
};
