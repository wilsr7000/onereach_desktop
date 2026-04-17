/**
 * GSX Create Engine
 *
 * Drop-in replacement for the retired AiderBridgeClient.
 * Uses bundled Claude Code (via lib/claude-code-runner) as the underlying
 * coding agent instead of a Python Aider sidecar.
 *
 * Public surface matches AiderBridgeClient one-for-one so existing main.js
 * IPC handlers and the window.aider preload bridge keep working with zero
 * renderer changes:
 *
 *   start()
 *   initialize(repoPath, modelName)
 *   runPrompt(message)
 *   runPromptStreaming(message, onToken)
 *   addFiles(filePaths)
 *   removeFiles(filePaths)
 *   getRepoMap()
 *   setTestCmd(cmd)
 *   setLintCmd(cmd)
 *   shutdown()
 *   isRunning()
 *   sendRequest(method, params)   -- legacy JSON-RPC shim for BranchAiderManager
 *
 * Key differences under the hood:
 *  - No Python. Spawns the bundled `claude` binary per request.
 *  - Context files are tracked internally and injected via --append-system-prompt
 *    (Claude Code reads files on-demand with its built-in Read/Glob/Grep tools).
 *  - Session continuity is achieved via `sessionId` (Claude Code --resume),
 *    so follow-up prompts stay in the same conversation.
 *  - Streaming decodes stream-json events and extracts plain text deltas so
 *    existing renderer code receiving string tokens still works.
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const path = require('path');
const { execSync } = require('child_process');
const { getLogQueue } = require('./log-event-queue');

const log = getLogQueue();

// Lazy-load the Claude Code runner so the module can be unit-tested
// without an Electron app context (the runner imports `electron`).
let _runnerFactory = null;
function _getRunner() {
  if (_runnerFactory) return _runnerFactory();
  return require('./claude-code-runner');
}

/**
 * Test-only: swap the Claude Code runner for a mock. Pass null to reset.
 * @param {Function|null} factory - () => { runClaudeCode, cancelSession, isClaudeCodeAvailable }
 */
function _setTestRunner(factory) {
  _runnerFactory = factory;
}

/**
 * Default Claude Code tools enabled for GSX Create sessions.
 * Covers read/write/edit, shell, and search. Matches Aider's full-repo
 * edit-and-test capability.
 */
const DEFAULT_ALLOWED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

/**
 * Extract incremental text from a Claude Code stream-json event.
 * Returns a string or null if the event has no text delta.
 */
function extractStreamText(event) {
  if (!event || typeof event !== 'object') return null;

  // Standard Claude stream event: { type: 'content_block_delta', delta: { type: 'text_delta', text } }
  if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
    return typeof event.delta.text === 'string' ? event.delta.text : null;
  }

  // Some CLI versions emit plain text chunks
  if (event.type === 'text' && typeof event.text === 'string') return event.text;

  // Final result envelopes may carry full text; skip to avoid duplicating stream.
  return null;
}

class GSXCreateEngine extends EventEmitter {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.sessionKey]  Stable id used as Claude Code --session-id
   *                                    (defaults to a UUID on first prompt).
   * @param {string} [opts.feature]     Budget/telemetry tag (default 'gsx-create').
   */
  constructor(opts = {}) {
    super();

    this.feature = opts.feature || 'gsx-create';
    this.preferredSessionKey = opts.sessionKey || null;

    /** @type {string|null} */
    this.cwd = null;
    /** @type {string} */
    this.model = 'claude-opus-4-7';

    /** Claude Code session id returned from CLI; used for --resume on next prompt */
    this.sessionId = null;

    /** Active request id for an in-flight prompt, used for cancellation */
    this.activeRequestId = null;

    /**
     * Promise chain used to serialize _execute calls so overlapping
     * runPrompt / runPromptStreaming invocations don't interleave
     * session state or stream events.
     */
    this._queueTail = Promise.resolve();

    this.contextFiles = new Set();
    this.readOnlyFiles = new Set();
    this.testCmd = null;
    this.lintCmd = null;

    this._started = false;
  }

  /**
   * Confirm Claude Code is available. Matches AiderBridgeClient.start() shape.
   */
  async start() {
    const avail = await _getRunner().isClaudeCodeAvailable();
    if (!avail.available) {
      const err = new Error(
        `Claude Code is not available: ${avail.error || 'binary not found'}`
      );
      this.emit('error', err);
      throw err;
    }
    this._started = true;
    log.info('gsx-create', 'Engine started', {
      version: avail.version,
      type: avail.type,
      path: avail.path,
    });
    return { success: true, version: avail.version, type: avail.type };
  }

  /**
   * Bind to a repository / branch directory.
   * Resets the conversation (fresh Claude Code session).
   */
  async initialize(repoPath, modelName) {
    if (!repoPath) {
      throw new Error('initialize(repoPath, modelName): repoPath is required');
    }
    this.cwd = path.resolve(repoPath);
    if (modelName) this.model = modelName;
    this.sessionId = null;
    this.contextFiles.clear();
    this.readOnlyFiles.clear();
    this.testCmd = null;
    this.lintCmd = null;
    log.info('gsx-create', 'Initialized', { cwd: this.cwd, model: this.model });
    return {
      success: true,
      repo_path: this.cwd,
      model_name: this.model,
    };
  }

  /**
   * Register files the user explicitly wants in context.
   * Claude Code reads files on demand so this is metadata only --
   * we surface the list via the system prompt so the model knows what
   * the user considers relevant.
   */
  async addFiles(filePaths) {
    if (!Array.isArray(filePaths)) {
      throw new Error('addFiles(filePaths): filePaths must be an array');
    }
    filePaths.forEach((p) => this.contextFiles.add(p));
    return { success: true, files: Array.from(this.contextFiles) };
  }

  async removeFiles(filePaths) {
    if (!Array.isArray(filePaths)) {
      throw new Error('removeFiles(filePaths): filePaths must be an array');
    }
    filePaths.forEach((p) => this.contextFiles.delete(p));
    return { success: true, files: Array.from(this.contextFiles) };
  }

  /**
   * Build a lightweight repo map from `git ls-files` if available,
   * falling back to an empty list. Aider produced a richer map; Claude
   * Code does its own on-demand discovery with Glob/Grep, so a flat
   * file list is sufficient for UI display.
   */
  async getRepoMap() {
    if (!this.cwd) {
      return { success: false, error: 'Engine not initialized (no cwd)' };
    }
    try {
      const out = execSync('git ls-files', {
        cwd: this.cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const files = out.split('\n').map((s) => s.trim()).filter(Boolean);
      return { success: true, files, count: files.length, root: this.cwd };
    } catch (err) {
      // Not a git repo, or git missing -- return empty map
      return { success: true, files: [], count: 0, root: this.cwd, note: err.message };
    }
  }

  setTestCmd(command) {
    this.testCmd = command || null;
    return { success: true, test_cmd: this.testCmd };
  }

  setLintCmd(command) {
    this.lintCmd = command || null;
    return { success: true, lint_cmd: this.lintCmd };
  }

  /**
   * Execute a prompt and return the final assistant text.
   * Maintains conversation via Claude Code session resume.
   */
  async runPrompt(message) {
    return this._execute(message, null);
  }

  /**
   * Execute a prompt with incremental token streaming.
   * @param {string} message
   * @param {(token: string) => void} onToken
   */
  async runPromptStreaming(message, onToken) {
    const streamFn = typeof onToken === 'function' ? onToken : null;
    return this._execute(message, streamFn);
  }

  /**
   * Core runner used by both runPrompt and runPromptStreaming.
   *
   * Invocations are serialized per-engine via `_queueTail`: overlapping
   * callers wait for the preceding prompt to finish before starting their
   * own. This protects `sessionId`, `activeRequestId`, and stream state
   * from interleaving when two renderer calls race.
   * @private
   */
  async _execute(message, onToken) {
    if (!this._started) {
      throw new Error('GSXCreateEngine: call start() before running prompts');
    }
    if (!this.cwd) {
      throw new Error('GSXCreateEngine: call initialize(repoPath) before running prompts');
    }
    if (typeof message !== 'string' || !message.trim()) {
      throw new Error('runPrompt(message): message must be a non-empty string');
    }

    // Queue this call behind any in-flight prompt for the same engine.
    const run = () => this._runOne(message, onToken);
    const task = this._queueTail.then(run, run);
    // Never let a rejected predecessor poison subsequent calls; swallow
    // errors on the tail chain itself but still await them for ordering.
    this._queueTail = task.catch(() => {});
    return task;
  }

  /** @private */
  async _runOne(message, onToken) {
    // Generate a stable request id up front so shutdown() can cancel the
    // underlying Claude Code process mid-flight. Claude Code's runner
    // uses this id as the key in its _sessions Map.
    const requestId = crypto.randomUUID();
    this.activeRequestId = requestId;

    const runOpts = {
      cwd: this.cwd,
      model: this.model,
      systemPrompt: this._buildSystemPrompt(),
      enableTools: true,
      allowedTools: DEFAULT_ALLOWED_TOOLS,
      feature: this.feature,
      requestId,
    };

    // Resume existing Claude Code session, or start a named one.
    if (this.sessionId) {
      runOpts.sessionId = this.sessionId;
    } else if (this.preferredSessionKey) {
      runOpts.newSessionId = this.preferredSessionKey;
    }

    if (onToken) {
      runOpts.onStream = (event) => {
        try {
          const text = extractStreamText(event);
          if (text) onToken(text);
          this.emit('stream', event);
        } catch (e) {
          log.warn('gsx-create', 'stream handler error', { error: e.message });
        }
      };
    }

    let result;
    try {
      result = await _getRunner().runClaudeCode(message, runOpts);
    } catch (err) {
      this.emit('error', err);
      throw err;
    } finally {
      // Clear regardless of success/failure so the next queued prompt
      // doesn't see a stale activeRequestId.
      if (this.activeRequestId === requestId) this.activeRequestId = null;
    }

    // Capture session id so the next prompt resumes the same conversation
    if (result && result.sessionId) {
      this.sessionId = result.sessionId;
    }

    return {
      success: result.success !== false,
      response: result.result || result.output || '',
      output: result.output || '',
      usage: result.usage || null,
      sessionId: result.sessionId || this.sessionId,
      requestId: result.requestId || requestId,
      error: result.error,
    };
  }

  /**
   * Stop the current prompt (if any) and mark the engine inactive.
   */
  async shutdown() {
    if (this.activeRequestId) {
      try {
        _getRunner().cancelSession(this.activeRequestId);
      } catch (e) {
        log.warn('gsx-create', 'cancel on shutdown failed', { error: e.message });
      }
      this.activeRequestId = null;
    }
    this._started = false;
    this.sessionId = null;
    return { success: true };
  }

  isRunning() {
    return this._started;
  }

  /**
   * Compatibility shim for code (e.g. BranchAiderManager) that spoke the
   * original Python JSON-RPC protocol directly. Only the methods actually
   * used in the codebase are supported.
   */
  async sendRequest(method, params = {}) {
    switch (method) {
      case 'initialize':
        return this.initialize(params.repo_path, params.model_name);
      case 'run_prompt':
        return this.runPrompt(params.message);
      case 'add_files':
        return this.addFiles(params.file_paths || []);
      case 'remove_files':
        return this.removeFiles(params.file_paths || []);
      case 'get_repo_map':
        return this.getRepoMap();
      case 'set_test_cmd':
        return this.setTestCmd(params.command);
      case 'set_lint_cmd':
        return this.setLintCmd(params.command);
      case 'set_sandbox':
        // Legacy Aider sandbox RPC: record read-only files for system prompt use.
        if (Array.isArray(params.read_only_files)) {
          this.readOnlyFiles = new Set(params.read_only_files);
        }
        return {
          success: true,
          sandbox_root: params.sandbox_root || this.cwd,
          read_only_files: Array.from(this.readOnlyFiles),
          branch_id: params.branch_id,
        };
      case 'shutdown':
        return this.shutdown();
      default:
        throw new Error(`GSXCreateEngine.sendRequest: unsupported method "${method}"`);
    }
  }

  /**
   * Build the system prompt that accompanies every Claude Code invocation.
   * @private
   */
  _buildSystemPrompt() {
    const parts = [
      'You are GSX Create, a Claude Code-powered coding assistant operating inside the Onereach.ai desktop app.',
      `Working directory: ${this.cwd}`,
    ];

    if (this.contextFiles.size > 0) {
      parts.push(
        '\n## Files the user has explicitly added to context:\n' +
          Array.from(this.contextFiles)
            .map((f) => `- ${f}`)
            .join('\n')
      );
    }

    if (this.readOnlyFiles.size > 0) {
      parts.push(
        '\n## Read-only files (DO NOT modify):\n' +
          Array.from(this.readOnlyFiles)
            .map((f) => `- ${f}`)
            .join('\n')
      );
    }

    if (this.testCmd) {
      parts.push(`\n## Test command\nRun \`${this.testCmd}\` to verify changes.`);
    }
    if (this.lintCmd) {
      parts.push(`\n## Lint command\nRun \`${this.lintCmd}\` to check style.`);
    }

    parts.push(
      '\n## Guidelines',
      '- Use your built-in Read/Write/Edit/Glob/Grep/Bash tools to inspect and modify files.',
      '- Prefer small, focused edits. Show the user the diff when useful.',
      '- If a change is ambiguous, ask a concise clarifying question before editing.'
    );

    return parts.join('\n');
  }
}

module.exports = {
  GSXCreateEngine,
  DEFAULT_ALLOWED_TOOLS,
  extractStreamText, // exported for unit tests
  _setTestRunner, // test-only: inject a mock runner factory
};
