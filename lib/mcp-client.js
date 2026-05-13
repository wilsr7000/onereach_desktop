/**
 * MCP Client - Model Context Protocol
 *
 * Minimal JSON-RPC client for talking to user-configured MCP servers.
 * Used by mcp-bridge-agent so that voice requests matching a registered
 * MCP tool can be routed there via the unified-bidder, instead of grafting
 * MCP servers into the realtime session.tools directly (which would
 * bypass our bidder + budget tracking).
 *
 * Supported transports (per the MCP spec):
 *   - HTTP -- POST JSON-RPC to a URL. Single-response JSON bodies only;
 *     SSE streaming is not consumed in v1.
 *   - stdio -- spawn a subprocess and exchange newline-delimited JSON-RPC
 *     messages on its stdin/stdout. Stderr is logged at debug. Most
 *     community MCP servers (filesystem, git, sqlite, ...) ship as stdio
 *     subprocesses.
 *
 * Public API:
 *   const { createClient } = require('./mcp-client');
 *   // HTTP
 *   const client = createClient({ transport: 'http', url, label, headers });
 *   // stdio
 *   const client = createClient({ transport: 'stdio', command, args, env, label });
 *   await client.initialize();   // optional; many servers don't require it
 *   const tools = await client.listTools();
 *   const result = await client.callTool(name, args);
 *   const health = await client.health();
 *   client.close();              // shuts down the subprocess (stdio only)
 *
 * Not implemented (deliberate v1 scope):
 *   - SSE streaming responses (HTTP)
 *   - resources/, prompts/ MCP capabilities (we only use tools/)
 *   - authentication handshake beyond static headers / env vars
 *
 * @module mcp-client
 */

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

const PROTOCOL_VERSION = '2025-06-18';
const TOOL_LIST_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_TIMEOUT_MS = 10_000;
const STDIO_SPAWN_TIMEOUT_MS = 5000;

class McpClient {
  /**
   * @param {Object} config
   * @param {'http' | 'stdio'} [config.transport='http']
   * @param {string} [config.url] - HTTP endpoint (transport='http')
   * @param {Object} [config.headers] - Extra HTTP headers (transport='http')
   * @param {string} [config.command] - Executable to spawn (transport='stdio')
   * @param {string[]} [config.args] - Command args (transport='stdio')
   * @param {Object} [config.env] - Extra env vars merged with process.env (transport='stdio')
   * @param {string} [config.cwd] - Working dir for spawn (transport='stdio')
   * @param {string} config.label - Human-readable name (used in bidder prompt)
   * @param {number} [config.timeoutMs] - Per-request timeout
   * @param {Function} [config.spawnFn] - Test seam (defaults to child_process.spawn)
   */
  constructor(config) {
    if (!config) throw new Error('McpClient requires a config object');
    this.transport = config.transport === 'stdio' ? 'stdio' : 'http';
    this.label = config.label || config.url || config.command || 'mcp';
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    this._nextId = 1;
    this._toolsCache = null;
    this._toolsCachedAt = 0;
    this._initialized = false;

    if (this.transport === 'http') {
      if (typeof config.url !== 'string' || !config.url) {
        throw new Error('McpClient http transport requires a non-empty `url`');
      }
      this.url = config.url;
      this.headers = config.headers || {};
    } else {
      // stdio
      if (typeof config.command !== 'string' || !config.command) {
        throw new Error('McpClient stdio transport requires a `command`');
      }
      this.command = config.command;
      this.args = Array.isArray(config.args) ? config.args : [];
      this.env = config.env || {};
      this.cwd = config.cwd;
      this._spawnFn = config.spawnFn || null;
      this._proc = null;
      this._stdoutBuffer = '';
      this._pending = new Map(); // id -> { resolve, reject, timer }
      this._spawnPromise = null;
      this._closed = false;
    }
  }

  _allocateId() {
    return this._nextId++;
  }

  /**
   * Send a JSON-RPC request and parse the single-response body. Throws on
   * transport error or JSON-RPC error object. Transport-dispatched.
   */
  async _request(method, params = undefined) {
    if (this.transport === 'http') return this._requestHttp(method, params);
    return this._requestStdio(method, params);
  }

  async _requestHttp(method, params) {
    const id = this._allocateId();
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Many servers reject requests without this Accept header.
          Accept: 'application/json, text/event-stream',
          ...this.headers,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new Error(`MCP request timed out after ${this.timeoutMs}ms`);
      }
      throw new Error(`MCP transport error: ${err.message}`);
    }
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`MCP server returned HTTP ${res.status}`);
    }

    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch (_err) {
      throw new Error(`MCP server returned non-JSON body: ${text.slice(0, 120)}`);
    }

    if (body.error) {
      const code = body.error.code || 'unknown';
      const msg = body.error.message || JSON.stringify(body.error);
      throw new Error(`MCP server error (${code}): ${msg}`);
    }

    return body.result;
  }

  /**
   * stdio request: write a newline-delimited JSON-RPC message to the
   * subprocess and resolve when a matching id comes back on stdout.
   */
  async _requestStdio(method, params) {
    if (this._closed) throw new Error('MCP client is closed');
    await this._ensureProcess();

    const id = this._allocateId();
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this._pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });

      try {
        this._proc.stdin.write(JSON.stringify(payload) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new Error(`MCP stdio write error: ${err.message}`));
      }
    });
  }

  /**
   * Spawn the subprocess lazily and wire stdout/stderr. Multi-call safe;
   * waits on the same spawn promise if called concurrently.
   */
  _ensureProcess() {
    if (this._proc && !this._proc.killed) return Promise.resolve();
    if (this._spawnPromise) return this._spawnPromise;

    this._spawnPromise = new Promise((resolve, reject) => {
      let spawn;
      try {
        spawn = this._spawnFn || require('child_process').spawn;
      } catch (err) {
        return reject(new Error(`child_process unavailable: ${err.message}`));
      }

      let proc;
      try {
        proc = spawn(this.command, this.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...this.env },
          cwd: this.cwd,
        });
      } catch (err) {
        return reject(new Error(`Failed to spawn MCP server: ${err.message}`));
      }

      const startTimer = setTimeout(() => {
        if (!this._proc) {
          try { proc.kill(); } catch (_e) { /* ignore */ }
          reject(new Error(`MCP server failed to start within ${STDIO_SPAWN_TIMEOUT_MS}ms`));
        }
      }, STDIO_SPAWN_TIMEOUT_MS);

      proc.on('error', (err) => {
        clearTimeout(startTimer);
        this._failPending(`MCP subprocess error: ${err.message}`);
        if (!this._proc) reject(err);
      });

      proc.on('exit', (code, signal) => {
        clearTimeout(startTimer);
        log.info('mcp', `[${this.label}] subprocess exited`, { code, signal });
        const reason = `MCP subprocess exited (code=${code}, signal=${signal})`;
        this._failPending(reason);
        this._proc = null;
      });

      if (proc.stdout) {
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', (chunk) => this._onStdout(chunk));
      }
      if (proc.stderr) {
        proc.stderr.setEncoding('utf8');
        proc.stderr.on('data', (chunk) => {
          log.debug('mcp', `[${this.label}] stderr`, { chunk: chunk.trim().slice(0, 200) });
        });
      }

      // The subprocess is ready as soon as spawn returns without throwing;
      // MCP servers don't emit a "ready" signal. The initialize handshake
      // is the first real probe of liveness.
      clearTimeout(startTimer);
      this._proc = proc;
      resolve();
    }).finally(() => {
      this._spawnPromise = null;
    });

    return this._spawnPromise;
  }

  /**
   * Parse newline-delimited JSON-RPC messages off the stdout stream and
   * dispatch responses by id to pending requests.
   */
  _onStdout(chunk) {
    this._stdoutBuffer += chunk;
    let newlineIdx = this._stdoutBuffer.indexOf('\n');
    while (newlineIdx >= 0) {
      const line = this._stdoutBuffer.slice(0, newlineIdx).trim();
      this._stdoutBuffer = this._stdoutBuffer.slice(newlineIdx + 1);
      if (line.length > 0) this._handleStdioLine(line);
      newlineIdx = this._stdoutBuffer.indexOf('\n');
    }
  }

  _handleStdioLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_err) {
      log.warn('mcp', `[${this.label}] non-JSON stdout`, { line: line.slice(0, 200) });
      return;
    }
    // We only consume responses; server-initiated requests/notifications
    // aren't handled in v1 (e.g. sampling, roots). They're logged for
    // future support.
    if (msg.id == null) {
      log.debug('mcp', `[${this.label}] notification`, { method: msg.method });
      return;
    }
    const pending = this._pending.get(msg.id);
    if (!pending) {
      log.warn('mcp', `[${this.label}] unmatched response`, { id: msg.id });
      return;
    }
    this._pending.delete(msg.id);
    if (msg.error) {
      const code = msg.error.code || 'unknown';
      const message = msg.error.message || JSON.stringify(msg.error);
      pending.reject(new Error(`MCP server error (${code}): ${message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  _failPending(reason) {
    for (const [, p] of this._pending) {
      try { p.reject(new Error(reason)); } catch (_e) { /* ignore */ }
    }
    this._pending.clear();
  }

  /**
   * Shut down the subprocess (stdio only). Idempotent and safe to call on
   * an http client (no-op).
   */
  close() {
    if (this.transport !== 'stdio') return;
    this._closed = true;
    this._failPending('MCP client closed');
    if (this._proc) {
      try { this._proc.stdin.end(); } catch (_e) { /* ignore */ }
      try { this._proc.kill(); } catch (_e) { /* ignore */ }
      this._proc = null;
    }
  }

  /**
   * Send the MCP initialize handshake. Optional for many servers but
   * required by spec-compliant ones. Cheap and idempotent.
   */
  async initialize() {
    if (this._initialized) return true;
    try {
      await this._request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'onereach-mcp-bridge', version: '1.0.0' },
      });
      this._initialized = true;
      return true;
    } catch (err) {
      // Some servers skip initialize; don't make it fatal.
      log.warn('mcp', `[${this.label}] initialize failed (continuing)`, { error: err.message });
      this._initialized = true;
      return false;
    }
  }

  /**
   * List tools advertised by the server. Cached for TTL_MS so the bidder
   * prompt build doesn't hammer the server on every voice turn.
   */
  async listTools({ refresh = false } = {}) {
    const fresh = Date.now() - this._toolsCachedAt < TOOL_LIST_TTL_MS;
    if (!refresh && this._toolsCache && fresh) return this._toolsCache;

    await this.initialize();
    const result = await this._request('tools/list');
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    this._toolsCache = tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));
    this._toolsCachedAt = Date.now();
    return this._toolsCache;
  }

  /**
   * Invoke a tool. Returns the text content of the first text block in the
   * MCP result, or the full result string if none. The caller is the
   * mcp-bridge-agent, which speaks the returned string back to the user.
   */
  async callTool(name, args = {}) {
    if (typeof name !== 'string' || !name) {
      throw new Error('callTool requires a tool name');
    }
    await this.initialize();
    const result = await this._request('tools/call', { name, arguments: args });
    // MCP convention: result.content is an array of content blocks, each
    // typed as 'text' / 'image' / 'resource'. We surface text only for v1.
    if (Array.isArray(result?.content)) {
      const texts = result.content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text);
      if (texts.length > 0) return texts.join('\n').trim();
    }
    if (typeof result === 'string') return result;
    return JSON.stringify(result);
  }

  /**
   * Lightweight health probe -- attempts listTools(refresh:true) and
   * reports latency. Used by the settings UI connection-test button.
   */
  async health() {
    const start = Date.now();
    try {
      await this.listTools({ refresh: true });
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, error: err.message };
    }
  }

  /**
   * Force the next listTools() to re-fetch.
   */
  invalidateToolsCache() {
    this._toolsCache = null;
    this._toolsCachedAt = 0;
  }
}

/**
 * Factory. Encapsulates config validation so callers don't have to
 * import the class.
 */
function createClient(config) {
  return new McpClient(config);
}

module.exports = {
  McpClient,
  createClient,
  PROTOCOL_VERSION,
  TOOL_LIST_TTL_MS,
};
