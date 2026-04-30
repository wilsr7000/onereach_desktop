/**
 * Logging HTTP + WebSocket Server
 *
 * Exposes the central log event queue over REST and WebSocket so external
 * tools (Cursor, browsers, CLI scripts) can query logs and receive real-time
 * event streams.
 *
 * Port: 47292 (one above Spaces API at 47291)
 * Binding: 127.0.0.1 (localhost only)
 *
 * REST Endpoints:
 *   GET  /logs          -- Query logs (params: level, category, since, until, search, limit, offset)
 *   GET  /logs/stats    -- Aggregated statistics
 *   GET  /logs/stream   -- SSE stream for simple clients
 *   GET  /logs/export   -- Export logs as JSON or text
 *   POST /logs          -- Push a log event from external source
 *   GET  /health        -- Server health + queue stats
 *   GET  /logging/level -- Read current and persisted logging level
 *   POST /logging/level -- Change logging level at runtime (persists across reboots)
 *
 * WebSocket (ws://127.0.0.1:47292/ws):
 *   Client -> Server:
 *     { type: 'subscribe', filter: { level, category, source, minLevel } }
 *     { type: 'unsubscribe' }
 *     { type: 'query', id: 'q1', params: { level, category, limit, ... } }
 *     { type: 'stats' }
 *   Server -> Client:
 *     { type: 'event', data: { id, timestamp, level, category, message, source, data } }
 *     { type: 'query-result', id: 'q1', data: [...] }
 *     { type: 'stats', data: { total, byLevel, byCategory, ... } }
 */

const http = require('http');
const crypto = require('crypto');

const PORT = 47292;
const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1 MB max request body
const MAX_WS_PAYLOAD = 256 * 1024; // 256 KB max WebSocket frame

class LogServer {
  constructor(logQueue) {
    this.queue = logQueue;
    this.server = null;
    this.wsConnections = new Set();
    this.sseConnections = new Set();
    this._started = false;
  }

  /**
   * Start the HTTP + WebSocket server
   */
  async start() {
    if (this._started) return;

    this.server = http.createServer((req, res) => this._handleHTTP(req, res));
    this.server.on('upgrade', (req, socket, head) => this._handleWSUpgrade(req, socket, head));

    return new Promise((resolve, reject) => {
      this.server.listen(PORT, '127.0.0.1', () => {
        this._started = true;
        this.queue.info('app', 'Log server started', { port: PORT, url: `http://127.0.0.1:${PORT}` });
        resolve();
      });

      this.server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          this.queue.warn('app', `Log server port ${PORT} already in use, retrying...`);
          // Try next port
          this.server.listen(PORT + 1, '127.0.0.1', () => {
            this._started = true;
            this.queue.info('app', 'Log server started on fallback port', { port: PORT + 1 });
            resolve();
          });
        } else {
          reject(error);
        }
      });
    });
  }

  /**
   * Stop the server
   */
  stop() {
    if (!this.server) return;

    // Close all WebSocket connections
    for (const ws of this.wsConnections) {
      ws.close();
    }
    this.wsConnections.clear();

    // Close all SSE connections
    for (const res of this.sseConnections) {
      try {
        res.end();
      } catch (_e) {
        /* ignore */
      }
    }
    this.sseConnections.clear();

    this.server.close();
    this.server = null;
    this._started = false;
  }

  // ==========================================================================
  // HTTP REQUEST HANDLING
  // ==========================================================================

  _handleHTTP(req, res) {
    // CORS headers for browser access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    try {
      // Route requests
      if (req.method === 'GET' && pathname === '/health') {
        return this._handleHealth(req, res);
      }
      if (req.method === 'GET' && pathname === '/logs') {
        return this._handleQueryLogs(req, res, url);
      }
      if (req.method === 'GET' && pathname === '/logs/stats') {
        return this._handleStats(req, res);
      }
      if (req.method === 'GET' && pathname === '/logs/stream') {
        return this._handleSSE(req, res, url);
      }
      if (req.method === 'GET' && pathname === '/logs/export') {
        return this._handleExport(req, res, url);
      }
      if (req.method === 'POST' && pathname === '/logs') {
        return this._handlePostLog(req, res);
      }
      if (req.method === 'GET' && pathname === '/logging/level') {
        return this._handleGetLevel(req, res);
      }
      if (req.method === 'POST' && pathname === '/logging/level') {
        return this._handleSetLevel(req, res);
      }
      if (req.method === 'POST' && pathname === '/app/restart') {
        return this._handleAppRestart(req, res);
      }
      if (req.method === 'GET' && pathname === '/ai/status') {
        return this._handleAiPauseStatus(req, res);
      }
      if (req.method === 'POST' && pathname === '/ai/pause') {
        return this._handleAiPause(req, res);
      }
      if (req.method === 'POST' && pathname === '/ai/resume') {
        return this._handleAiResume(req, res);
      }
      if (req.method === 'GET' && pathname === '/budget/agents') {
        return this._handleBudgetAgents(req, res, url);
      }
      if (req.method === 'GET' && pathname.startsWith('/budget/agents/')) {
        return this._handleBudgetAgent(req, res, url, pathname);
      }
      if (req.method === 'GET' && pathname === '/app/pid') {
        return this._jsonResponse(res, 200, { pid: process.pid });
      }

      // Unified status endpoint
      if (req.method === 'GET' && pathname === '/app/status') {
        return this._handleAppStatus(req, res);
      }

      // Action API endpoints
      if (pathname === '/app/actions' && req.method === 'GET') {
        return this._handleListActions(req, res);
      }
      if (pathname.startsWith('/app/actions/') && req.method === 'GET') {
        return this._handleGetAction(req, res, pathname);
      }
      if (pathname.startsWith('/app/actions/') && req.method === 'POST') {
        return this._handleExecuteAction(req, res, pathname);
      }

      // Desktop Autopilot API endpoints
      if (req.method === 'GET' && pathname === '/app/desktop/status') {
        return this._handleDesktopStatus(req, res);
      }
      if (req.method === 'POST' && pathname.startsWith('/app/desktop/')) {
        return this._handleDesktopCommand(req, res, pathname);
      }

      // Sync v5 (Phase 1 scaffold) -- diagnostics endpoints
      // These are read-only and safe to add early. They report the schema-
      // version handshake, deviceId, heartbeat reporter state, and graph-
      // side health queries. Local queue/DLQ surfaces become live in Phase 2.
      if (req.method === 'GET' && pathname === '/sync/queue') {
        return this._handleSyncV5(req, res, async () => (await require('./sync-v5/diagnostics-endpoints').handleSyncQueue()));
      }
      if (req.method === 'GET' && pathname === '/sync/dlq') {
        return this._handleSyncV5(req, res, async () => (await require('./sync-v5/diagnostics-endpoints').handleSyncDlq()));
      }
      if (req.method === 'GET' && pathname.startsWith('/sync/trace/')) {
        const traceId = decodeURIComponent(pathname.slice('/sync/trace/'.length));
        return this._handleSyncV5(req, res, async () => (await require('./sync-v5/diagnostics-endpoints').handleSyncTrace(traceId)));
      }
      if (req.method === 'GET' && pathname === '/sync/health') {
        return this._handleSyncV5(req, res, async () => (await require('./sync-v5/diagnostics-endpoints').handleSyncHealth(url)));
      }
      if (req.method === 'GET' && pathname.startsWith('/sync/health/')) {
        const queryName = decodeURIComponent(pathname.slice('/sync/health/'.length));
        return this._handleSyncV5(req, res, async () => (await require('./sync-v5/diagnostics-endpoints').handleSyncHealthOne(queryName, url)));
      }
      if (req.method === 'GET' && pathname === '/sync/replica/validation') {
        return this._handleSyncV5(req, res, async () => (await require('./sync-v5/diagnostics-endpoints').handleSyncReplicaValidation()));
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Not found',
          endpoints: [
            '/health',
            '/logs',
            '/logs/stats',
            '/logs/stream',
            '/logs/export',
            '/logging/level',
            '/app/restart',
            '/ai/status',
            '/ai/pause',
            '/ai/resume',
            '/budget/agents',
            '/budget/agents/:agentId',
            '/app/status',
            '/app/actions',
            '/app/actions/:id',
            '/app/desktop/status',
            '/app/desktop/browser/task',
            '/app/desktop/browser/:cmd',
            '/app/desktop/system/:cmd',
          ],
        })
      );
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error', message: error.message }));
    }
  }

  /**
   * GET /health -- Server status
   */
  _handleHealth(req, res) {
    const stats = this.queue.getStats();
    this._jsonResponse(res, 200, {
      status: 'ok',
      appVersion: this.queue._appVersion || 'unknown',
      port: PORT,
      uptime: process.uptime(),
      queue: stats,
      connections: {
        websocket: this.wsConnections.size,
        sse: this.sseConnections.size,
      },
    });
  }

  /**
   * Generic wrapper for sync-v5 diagnostics endpoints. Each handler returns
   * { status, body }; this method awaits the promise and renders. Keeps the
   * route table free of inline async boilerplate and centralises error
   * handling for the new endpoints.
   */
  async _handleSyncV5(req, res, handlerFn) {
    try {
      const r = await handlerFn();
      this._jsonResponse(res, r?.status || 200, r?.body || {});
    } catch (err) {
      this.queue.warn('app', 'sync-v5 diagnostics handler failed', { error: err.message });
      this._jsonResponse(res, 500, { error: err.message });
    }
  }

  /**
   * GET /logging/level -- Read current logging level and persisted setting
   */
  _handleGetLevel(req, res) {
    const persisted = global.settingsManager ? global.settingsManager.get('diagnosticLogging') || 'info' : 'info';
    this._jsonResponse(res, 200, {
      level: this.queue._minLevel,
      persisted,
      validLevels: ['off', 'error', 'warn', 'info', 'debug'],
    });
  }

  /**
   * POST /logging/level -- Change logging level at runtime.
   * Body: { "level": "info" }
   * Also persists via settingsManager so the change survives reboots.
   */
  _handleSetLevel(req, res) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const { level } = JSON.parse(body);
        const validLevels = ['off', 'error', 'warn', 'info', 'debug'];
        if (!validLevels.includes(level)) {
          return this._jsonResponse(res, 400, { error: `Invalid level "${level}". Valid: ${validLevels.join(', ')}` });
        }
        // Persist
        if (global.settingsManager) {
          global.settingsManager.set('diagnosticLogging', level);
        }
        // Apply
        if (level === 'off') {
          this.queue.setMinLevel('error');
        } else {
          this.queue.setMinLevel(level);
        }
        this.queue.info('settings', `Logging level changed to "${level}" via REST API`, { level, source: 'rest' });
        this._jsonResponse(res, 200, { success: true, level, persisted: true });
      } catch (err) {
        this._jsonResponse(res, 400, { error: 'Invalid JSON body', message: err.message });
      }
    });
  }

  /**
   * POST /app/restart -- Gracefully restart the Electron app
   * Used by the test audit system to relaunch after code fixes.
   */
  _handleAppRestart(req, res) {
    this.queue.info('app', 'App restart requested via REST API', { source: 'test-audit' });
    this._jsonResponse(res, 200, { success: true, message: 'App will restart in 1 second' });

    setTimeout(() => {
      try {
        const { app } = require('electron');
        app.relaunch();
        app.exit(0);
      } catch (err) {
        // If electron not available (shouldn't happen), try process exit
        this.queue.error('app', 'Failed to relaunch via electron', { error: err.message });
        process.exit(1);
      }
    }, 1000);
  }

  /**
   * GET /ai/status -- Current AI pause state.
   */
  _handleAiPauseStatus(req, res) {
    try {
      const aiPause = require('./ai-pause');
      this._jsonResponse(res, 200, aiPause.getStatus());
    } catch (err) {
      this._jsonResponse(res, 500, { error: err.message });
    }
  }

  /**
   * POST /ai/pause -- Block all LLM traffic and stop subsystem timers.
   * Body: { "reason": "..." } (optional)
   */
  _handleAiPause(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let reason = 'http';
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        if (body) {
          const parsed = JSON.parse(body);
          if (parsed && parsed.reason) reason = String(parsed.reason);
        }
      } catch (_err) {
        // ignore body parse errors, use default reason
      }
      try {
        const aiPause = require('./ai-pause');
        const status = await aiPause.pause(reason);
        this.queue.warn('app', 'AI traffic paused via HTTP', status);
        this._jsonResponse(res, 200, status);
      } catch (err) {
        this._jsonResponse(res, 500, { error: err.message });
      }
    });
  }

  /**
   * POST /ai/resume -- Re-enable LLM traffic.
   */
  _handleAiResume(req, res) {
    (async () => {
      try {
        const aiPause = require('./ai-pause');
        const status = await aiPause.resume();
        this.queue.info('app', 'AI traffic resumed via HTTP', status);
        this._jsonResponse(res, 200, status);
      } catch (err) {
        this._jsonResponse(res, 500, { error: err.message });
      }
    })();
  }

  /**
   * GET /budget/agents?period=&limit= -- Cost breakdown by agent.
   * period: 'all' (default), 'daily', 'weekly', 'monthly', 'yearly'.
   */
  _handleBudgetAgents(req, res, url) {
    try {
      const { getBudgetManager } = require('../budget-manager');
      const period = url.searchParams.get('period') || 'all';
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const leaderboard = getBudgetManager().getAgentLeaderboard({ period, limit: isNaN(limit) ? 50 : limit });
      this._jsonResponse(res, 200, {
        period,
        count: leaderboard.length,
        totalCost: leaderboard.reduce((sum, a) => sum + (a.cost || 0), 0),
        agents: leaderboard,
      });
    } catch (err) {
      this._jsonResponse(res, 500, { error: err.message });
    }
  }

  /**
   * GET /budget/agents/:agentId?period= -- One agent's cost detail.
   */
  _handleBudgetAgent(req, res, url, pathname) {
    try {
      const agentId = decodeURIComponent(pathname.slice('/budget/agents/'.length));
      if (!agentId) {
        return this._jsonResponse(res, 400, { error: 'agentId required' });
      }
      const { getBudgetManager } = require('../budget-manager');
      const period = url.searchParams.get('period') || 'all';
      const detail = getBudgetManager().getAgentCosts(agentId, period);
      if (!detail) {
        return this._jsonResponse(res, 404, { error: 'Agent has no recorded usage', agentId, period });
      }
      this._jsonResponse(res, 200, detail);
    } catch (err) {
      this._jsonResponse(res, 500, { error: err.message });
    }
  }

  /**
   * GET /logs -- Query log entries
   * Params: level, category, source, search, since, until, limit, offset
   */
  _handleQueryLogs(req, res, url) {
    const opts = {
      level: url.searchParams.get('level') || undefined,
      category: url.searchParams.get('category') || undefined,
      source: url.searchParams.get('source') || undefined,
      search: url.searchParams.get('search') || undefined,
      since: url.searchParams.get('since') || undefined,
      until: url.searchParams.get('until') || undefined,
      limit: parseInt(url.searchParams.get('limit') || '100', 10),
      offset: parseInt(url.searchParams.get('offset') || '0', 10),
    };

    // Clamp limits
    if (isNaN(opts.limit) || opts.limit < 0) opts.limit = 100;
    if (opts.limit > 1000) opts.limit = 1000;
    if (isNaN(opts.offset) || opts.offset < 0) opts.offset = 0;

    const results = this.queue.query(opts);
    this._jsonResponse(res, 200, {
      count: results.length,
      query: opts,
      data: results,
    });
  }

  /**
   * GET /logs/stats -- Aggregated statistics
   */
  _handleStats(req, res) {
    this._jsonResponse(res, 200, this.queue.getStats());
  }

  /**
   * GET /logs/stream -- Server-Sent Events stream
   * Params: level, category, source, minLevel
   */
  _handleSSE(req, res, url) {
    const filter = {
      level: url.searchParams.get('level') || undefined,
      category: url.searchParams.get('category') || undefined,
      source: url.searchParams.get('source') || undefined,
      minLevel: url.searchParams.get('minLevel') || undefined,
    };

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: 'connected', filter })}\n\n`);

    this.sseConnections.add(res);

    // Subscribe to queue events
    const unsubscribe = this.queue.subscribe(filter, (entry) => {
      try {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      } catch (_err) {
        unsubscribe();
        this.sseConnections.delete(res);
      }
    });

    // Clean up on close
    req.on('close', () => {
      unsubscribe();
      this.sseConnections.delete(res);
    });
  }

  /**
   * GET /logs/export -- Export logs
   * Params: since, until, format (json|text), level, category
   */
  async _handleExport(req, res, url) {
    const opts = {
      since: url.searchParams.get('since') || undefined,
      until: url.searchParams.get('until') || undefined,
      format: url.searchParams.get('format') || 'json',
      level: url.searchParams.get('level') || undefined,
      category: url.searchParams.get('category') || undefined,
      limit: parseInt(url.searchParams.get('limit') || '5000', 10),
    };

    try {
      const exported = await this.queue.export(opts);

      if (opts.format === 'text') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(typeof exported === 'string' ? exported : JSON.stringify(exported, null, 2));
      } else {
        this._jsonResponse(res, 200, { count: Array.isArray(exported) ? exported.length : 0, data: exported });
      }
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Export failed', message: error.message }));
    }
  }

  /**
   * POST /logs -- Push a log event from external source
   * Body: { level, category, message, data }
   */
  _handlePostLog(req, res) {
    let body = '';
    let aborted = false;

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (aborted) return;
      try {
        const event = JSON.parse(body);
        const entry = this.queue.enqueue({
          level: event.level || 'info',
          category: event.category || 'external',
          message: event.message || '',
          data: event.data || {},
          source: 'external',
        });
        this._jsonResponse(res, 201, { success: true, entry });
      } catch (error) {
        this._jsonResponse(res, 400, { error: 'Invalid JSON', message: error.message });
      }
    });
  }

  // ==========================================================================
  // ACTION API HANDLERS
  // ==========================================================================

  /**
   * GET /app/status -- Unified situational awareness + logs in one call
   */
  async _handleAppStatus(req, res) {
    try {
      const { executeAction } = require('../action-executor');
      const situationResult = await executeAction('app-situation');
      const stats = this.queue.getStats();
      const recentLogs = this.queue.query({ limit: 25 });
      const recentErrors = this.queue.query({ level: 'error', limit: 10 });

      this._jsonResponse(res, 200, {
        situation: situationResult.success ? situationResult.data : null,
        logStats: stats,
        recentLogs,
        recentErrors,
      });
    } catch (error) {
      this._jsonResponse(res, 500, { error: 'Status unavailable', message: error.message });
    }
  }

  /**
   * GET /app/actions -- List all available actions grouped by category
   */
  _handleListActions(req, res) {
    try {
      const { listActions } = require('../action-executor');
      this._jsonResponse(res, 200, { actions: listActions() });
    } catch (error) {
      this._jsonResponse(res, 500, { error: 'Action executor not available', message: error.message });
    }
  }

  /**
   * GET /app/actions/:id -- Get action info and parameter schema
   */
  _handleGetAction(req, res, pathname) {
    const actionId = decodeURIComponent(pathname.replace('/app/actions/', ''));
    try {
      const { getActionInfo } = require('../action-executor');
      const info = getActionInfo(actionId);
      if (!info) {
        return this._jsonResponse(res, 404, { error: `Unknown action: ${actionId}` });
      }
      this._jsonResponse(res, 200, info);
    } catch (error) {
      this._jsonResponse(res, 500, { error: 'Action executor not available', message: error.message });
    }
  }

  /**
   * POST /app/actions/:id -- Execute an action with optional JSON body params
   */
  _handleExecuteAction(req, res, pathname) {
    const actionId = decodeURIComponent(pathname.replace('/app/actions/', ''));
    let body = '';
    let aborted = false;

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', async () => {
      if (aborted) return;
      let params = {};
      if (body.trim()) {
        try {
          params = JSON.parse(body);
        } catch (parseErr) {
          return this._jsonResponse(res, 400, { error: 'Invalid JSON body', message: parseErr.message });
        }
      }

      try {
        const { executeAction } = require('../action-executor');
        const result = await executeAction(actionId, params);
        const statusCode = result.success ? 200 : (result.error && result.error.startsWith('Unknown action') ? 404 : 400);
        this._jsonResponse(res, statusCode, result);
      } catch (error) {
        this._jsonResponse(res, 500, { success: false, error: error.message });
      }
    });
  }

  // ==========================================================================
  // DESKTOP AUTOPILOT HANDLERS
  // ==========================================================================

  _handleDesktopStatus(_req, res) {
    try {
      const autopilot = require('./desktop-autopilot');
      this._jsonResponse(res, 200, autopilot.status());
    } catch (error) {
      this._jsonResponse(res, 500, { error: 'Desktop Autopilot not available', message: error.message });
    }
  }

  _handleDesktopCommand(req, res, pathname) {
    const path = pathname.replace('/app/desktop/', '');
    const segments = path.split('/');
    const domain = segments[0]; // browser, system, app
    const cmd = segments.slice(1).join('/');

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', async () => {
      let params = {};
      if (body.trim()) {
        try {
          params = JSON.parse(body);
        } catch (parseErr) {
          return this._jsonResponse(res, 400, { error: 'Invalid JSON body', message: parseErr.message });
        }
      }

      try {
        const autopilot = require('./desktop-autopilot');
        let result;

        if (domain === 'browser') {
          result = await this._dispatchBrowserCommand(autopilot, cmd, params);
        } else if (domain === 'system') {
          result = await this._dispatchSystemCommand(autopilot, cmd, params);
        } else if (domain === 'app') {
          result = await autopilot.app.execute(cmd, params);
        } else {
          return this._jsonResponse(res, 404, { error: `Unknown desktop domain: ${domain}` });
        }

        const statusCode = result.success === false ? 400 : 200;
        this._jsonResponse(res, statusCode, result);
      } catch (error) {
        this._jsonResponse(res, 500, { success: false, error: error.message });
      }
    });
  }

  async _dispatchBrowserCommand(autopilot, cmd, params) {
    switch (cmd) {
      case 'task':
        if (!params.task) return { success: false, error: 'Missing required parameter: task' };
        return autopilot.browser.runTask(params.task, params);
      case 'navigate':
        if (!params.url) return { success: false, error: 'Missing required parameter: url' };
        return autopilot.browser.navigate(params.url, { headless: params.headless });
      case 'screenshot':
        return autopilot.browser.screenshot(params);
      case 'state':
        return autopilot.browser.getState();
      case 'extract':
        return autopilot.browser.extractContent(params);
      case 'evaluate':
        if (!params.script) return { success: false, error: 'Missing required parameter: script' };
        return autopilot.browser.evaluate(params.script);
      case 'close':
        return autopilot.browser.close();
      case 'status':
        return { success: true, ...autopilot.browser.status() };
      case 'cache-list': {
        const cache = require('./autopilot-script-cache');
        return { success: true, scripts: cache.list() };
      }
      case 'cache-clear': {
        const cache = require('./autopilot-script-cache');
        const count = cache.clearAll();
        return { success: true, cleared: count };
      }
      case 'cache-view': {
        if (!params.task) return { success: false, error: 'Missing required parameter: task' };
        const cache = require('./autopilot-script-cache');
        const script = cache.getScript(params.task);
        if (!script) return { success: false, error: 'No cached script for this task' };
        return { success: true, script };
      }
      case 'cache-invalidate': {
        if (!params.task) return { success: false, error: 'Missing required parameter: task' };
        const cache = require('./autopilot-script-cache');
        cache.invalidate(params.task);
        return { success: true, message: 'Script invalidated' };
      }
      default:
        return { success: false, error: `Unknown browser command: ${cmd}` };
    }
  }

  async _dispatchSystemCommand(autopilot, cmd, params) {
    switch (cmd) {
      case 'applescript':
        if (!params.script) return { success: false, error: 'Missing required parameter: script' };
        return autopilot.system.applescript(params.script);
      case 'mouse-move':
        if (params.x == null || params.y == null) return { success: false, error: 'Missing x and y' };
        return autopilot.system.mouseMove(params.x, params.y);
      case 'mouse-click':
        return autopilot.system.mouseClick(params.button || 'left', params.double || false);
      case 'mouse-scroll':
        return autopilot.system.mouseScroll(params.x || 0, params.y || 0);
      case 'mouse-position':
        return autopilot.system.getMousePosition();
      case 'key-type':
        if (!params.text) return { success: false, error: 'Missing required parameter: text' };
        return autopilot.system.keyType(params.text);
      case 'key-press':
        if (!params.key) return { success: false, error: 'Missing required parameter: key' };
        return autopilot.system.keyPress(params.key, params.modifiers || {});
      default:
        return { success: false, error: `Unknown system command: ${cmd}` };
    }
  }

  // ==========================================================================
  // WEBSOCKET HANDLING
  // ==========================================================================

  _handleWSUpgrade(req, socket, _head) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    // Compute accept key per RFC 6455
    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-5AB0DC85B11B')
      .digest('base64');

    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      '',
    ].join('\r\n');

    socket.write(responseHeaders);

    const ws = new WebSocketConnection(socket);
    this.wsConnections.add(ws);

    this.queue.debug('app', 'WebSocket client connected to log server', {
      connections: this.wsConnections.size,
    });

    ws.on('message', (data) => this._handleWSMessage(ws, data));
    ws.on('close', () => this._handleWSClose(ws));
    ws.on('error', () => this._handleWSClose(ws));
  }

  _handleWSMessage(ws, raw) {
    try {
      const msg = JSON.parse(raw);

      switch (msg.type) {
        case 'subscribe': {
          // Subscribe with optional filter
          const filter = msg.filter || {};
          if (ws._unsubscribe) ws._unsubscribe(); // remove previous subscription
          ws._unsubscribe = this.queue.subscribe(filter, (entry) => {
            try {
              ws.send(JSON.stringify({ type: 'event', data: entry }));
            } catch (_err) {
              // Connection may be dead
            }
          });
          ws.send(JSON.stringify({ type: 'subscribed', filter }));
          break;
        }

        case 'unsubscribe': {
          if (ws._unsubscribe) {
            ws._unsubscribe();
            ws._unsubscribe = null;
          }
          ws.send(JSON.stringify({ type: 'unsubscribed' }));
          break;
        }

        case 'query': {
          const results = this.queue.query(msg.params || {});
          ws.send(JSON.stringify({ type: 'query-result', id: msg.id, data: results }));
          break;
        }

        case 'stats': {
          ws.send(JSON.stringify({ type: 'stats', data: this.queue.getStats() }));
          break;
        }

        case 'log': {
          // Allow pushing log events via WebSocket too
          this.queue.enqueue({
            level: msg.level || 'info',
            category: msg.category || 'external',
            message: msg.message || '',
            data: msg.data || {},
            source: 'websocket',
          });
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
      }
    } catch (_error) {
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      } catch (_e) {
        /* ignore */
      }
    }
  }

  _handleWSClose(ws) {
    if (ws._unsubscribe) {
      ws._unsubscribe();
      ws._unsubscribe = null;
    }
    this.wsConnections.delete(ws);
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  _jsonResponse(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

// =============================================================================
// WebSocket Connection Wrapper (zero dependencies, same pattern as spaces-api)
// =============================================================================

class WebSocketConnection {
  constructor(socket) {
    this.socket = socket;
    this.handlers = {};
    this.buffer = Buffer.alloc(0);
    this._unsubscribe = null;

    socket.on('data', (data) => this._handleData(data));
    socket.on('close', () => this._emit('close'));
    socket.on('error', (error) => this._emit('error', error));
  }

  on(event, handler) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
  }

  _emit(event, data) {
    if (this.handlers[event]) {
      for (const handler of this.handlers[event]) {
        handler(data);
      }
    }
  }

  _handleData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < 4) return;
        payloadLength = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) return;
        payloadLength = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (payloadLength > MAX_WS_PAYLOAD) {
        this.buffer = Buffer.alloc(0);
        this.close();
        return;
      }

      const maskLength = isMasked ? 4 : 0;
      const totalLength = offset + maskLength + payloadLength;
      if (this.buffer.length < totalLength) return;

      let mask = null;
      if (isMasked) {
        mask = this.buffer.slice(offset, offset + 4);
        offset += 4;
      }

      let payload = this.buffer.slice(offset, offset + payloadLength);
      if (mask) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i % 4];
        }
      }

      this.buffer = this.buffer.slice(totalLength);

      if (opcode === 0x01) {
        // Text frame
        this._emit('message', payload.toString('utf8'));
      } else if (opcode === 0x08) {
        // Close
        this.close();
        this._emit('close');
      } else if (opcode === 0x09) {
        // Ping
        this._sendPong(payload);
      }
    }
  }

  send(data) {
    if (this.socket.destroyed) return;
    const payload = Buffer.from(data, 'utf8');
    this.socket.write(this._createFrame(payload, 0x01));
  }

  _sendPong(payload) {
    if (this.socket.destroyed) return;
    this.socket.write(this._createFrame(payload, 0x0a));
  }

  _createFrame(payload, opcode) {
    const length = payload.length;
    let header;

    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    return Buffer.concat([header, payload]);
  }

  close() {
    if (!this.socket.destroyed) {
      try {
        this.socket.write(this._createFrame(Buffer.alloc(0), 0x08));
        this.socket.end();
      } catch (_e) {
        /* ignore */
      }
    }
  }
}

// =============================================================================
// SINGLETON + FACTORY
// =============================================================================

let serverInstance = null;

/**
 * Get the singleton LogServer instance
 * @param {LogEventQueue} [queue] - The log queue (auto-detected if not provided)
 * @returns {LogServer}
 */
function getLogServer(queue) {
  if (!serverInstance) {
    if (!queue) {
      const { getLogQueue } = require('./log-event-queue');
      queue = getLogQueue();
    }
    serverInstance = new LogServer(queue);
  }
  return serverInstance;
}

module.exports = { LogServer, getLogServer, PORT };
