/**
 * Claude Code Runner
 *
 * Spawns and manages Claude Code CLI processes.
 * Handles both bundled binary and global npm install.
 *
 * Modernized:
 * - Async spawn (non-blocking) instead of execSync
 * - --output-format json / stream-json for structured output
 * - Concurrent sessions via Map (no single-process lock)
 * - Session management (--resume, --session-id)
 * - Safety controls (--max-turns, --max-budget-usd)
 * - --append-system-prompt by default
 * - MCP config injection (--mcp-config)
 * - Real token tracking from JSON response
 * - Streaming callback for stream-json events
 */

const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');
const { getBudgetManager } = require('../budget-manager');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// ---------------------------------------------------------------------------
// Token estimation (fallback when JSON response lacks usage)
// ---------------------------------------------------------------------------

/**
 * Estimate token count from text (rough: ~4 chars per token)
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Concurrent session tracking
// ---------------------------------------------------------------------------

/** @type {Map<string, { process: import('child_process').ChildProcess, startedAt: number, cwd: string }>} */
const _sessions = new Map();

/** Progress listener callbacks keyed by requestId */
const _progressListeners = new Map();

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Get the path to Claude Code binary/script.
 * Checks: 1) Bundled binary in app resources  2) Global npm install
 */
function getClaudeCodePath() {
  if (app.isPackaged) {
    const platform = `${process.platform}-${process.arch}`;
    const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const bundledPath = path.join(process.resourcesPath, 'claude-code', platform, binaryName);

    if (fs.existsSync(bundledPath)) {
      log.info('app', 'Using bundled binary', { bundledPath });
      return bundledPath;
    }

    const fallbackPath = path.join(process.resourcesPath, 'claude-code', binaryName);
    if (fs.existsSync(fallbackPath)) {
      log.info('app', 'Using fallback bundled path', { fallbackPath });
      return fallbackPath;
    }
  }

  log.info('app', 'Using global claude command');
  return 'claude';
}

/**
 * Build environment with proper PATH for node/homebrew and inject API key.
 */
function _buildEnv() {
  const env = { ...process.env };
  const additionalPaths = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/homebrew/opt/node/bin',
    '/usr/local/opt/node/bin',
    process.env.HOME + '/.nvm/versions/node/v20.19.0/bin',
    process.env.HOME + '/.nvm/versions/node/v22.12.0/bin',
    process.env.HOME + '/.nodenv/shims',
    process.env.HOME + '/.volta/bin',
  ].filter(Boolean);

  const currentPath = env.PATH || '';
  env.PATH = [...new Set([...additionalPaths, ...currentPath.split(':')])].join(':');

  // Inject API key from settings
  try {
    const { getSettingsManager } = require('../settings-manager');
    const settings = getSettingsManager();
    const apiKey =
      settings.get('anthropicApiKey') || settings.get('llmApiKey') || settings.get('llmConfig.anthropic.apiKey');
    if (apiKey) {
      env.ANTHROPIC_API_KEY = apiKey.replace(/^Anthr:\s*/i, '').trim();
    }
  } catch (_) {
    /* settings not available yet */
  }

  return env;
}

/**
 * Resolve the actual executable path (handles global command resolution).
 */
function _resolveClaudePath(claudePath) {
  if (claudePath !== 'claude') return claudePath;
  const globalPaths = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    process.env.HOME + '/.npm-global/bin/claude',
  ];
  for (const gp of globalPaths) {
    if (fs.existsSync(gp)) return gp;
  }
  return claudePath;
}

// ---------------------------------------------------------------------------
// Availability & authentication
// ---------------------------------------------------------------------------

/**
 * Check if Claude Code CLI is available
 * @returns {Promise<{ available: boolean, version?: string, path?: string, error?: string }>}
 */
async function isClaudeCodeAvailable() {
  const claudePath = getClaudeCodePath();
  const env = _buildEnv();

  const isBundledBinary = claudePath.includes('Resources') || claudePath.includes('.app');
  if (isBundledBinary && fs.existsSync(claudePath)) {
    try {
      const result = execSync(`"${claudePath}" --version`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
      return { available: true, version: result.trim(), path: claudePath, type: 'bundled' };
    } catch (error) {
      log.info('app', 'Bundled binary exists but failed', { error: error.message });
      return { available: false, path: claudePath, error: error.message };
    }
  }

  try {
    const actualPath = _resolveClaudePath(claudePath);
    const result = execSync(`"${actualPath}" --version`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    return { available: true, version: result.trim(), path: actualPath, type: 'global' };
  } catch (error) {
    log.info('app', 'Claude Code not available', { error: error.message });
    return { available: false, error: error.message };
  }
}

/**
 * Check if Claude Code is authenticated (has valid API key)
 */
async function isAuthenticated() {
  try {
    let apiKey = null;
    try {
      const { getSettingsManager } = require('../settings-manager');
      const settings = getSettingsManager();
      apiKey =
        settings.get('anthropicApiKey') || settings.get('llmApiKey') || settings.get('llmConfig.anthropic.apiKey');
      if (apiKey) apiKey = apiKey.replace(/^Anthr:\s*/i, '').trim();
    } catch (err) {
      console.warn('[claude-code-runner] loading settings for auth check:', err.message);
    }

    if (!apiKey || !apiKey.startsWith('sk-ant-')) {
      return { authenticated: false, error: 'No Anthropic API key found. Please add your API key in Settings.' };
    }
    return { authenticated: true };
  } catch (error) {
    log.info('app', 'Auth check error', { error: error.message });
    return { authenticated: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Core: runClaudeCode  (async spawn, streaming, concurrent)
// ---------------------------------------------------------------------------

/**
 * Run Claude Code CLI with a prompt.
 *
 * @param {string} prompt - The prompt to send
 * @param {Object} [options]
 * @param {string}   [options.cwd]                 - Working directory
 * @param {string}   [options.systemPrompt]         - System prompt (appended by default)
 * @param {boolean}  [options.replaceSystemPrompt]  - If true, use --system-prompt instead of --append-system-prompt
 * @param {boolean}  [options.enableTools]           - Enable agentic tools
 * @param {string[]} [options.allowedTools]          - Specific tools to allow
 * @param {string}   [options.requestId]             - Unique ID for this request (auto-generated if omitted)
 * @param {string}   [options.sessionId]             - Resume a previous session (--resume)
 * @param {string}   [options.newSessionId]          - Start a new named session (--session-id)
 * @param {number}   [options.maxTurns]              - Max agentic turns (--max-turns)
 * @param {number}   [options.maxBudget]             - Max cost in USD (--max-budget-usd)
 * @param {string}   [options.model]                 - Model alias (--model)
 * @param {string}   [options.fallbackModel]         - Fallback model (--fallback-model)
 * @param {string}   [options.feature]               - Cost-tracking feature label
 * @param {Object}   [options.mcpConfig]             - MCP server config object (written to temp file -> --mcp-config)
 * @param {Object}   [options.jsonSchema]            - JSON schema for output validation (--json-schema)
 * @param {Function} [options.onStream]              - Streaming callback (enables --output-format stream-json)
 * @param {Function} [options.onOutput]              - Legacy stdout callback
 * @param {Function} [options.onError]               - Legacy stderr callback
 * @param {Function} [options.onProgress]            - Legacy progress callback
 * @returns {Promise<{ success: boolean, output?: string, result?: Object, error?: string, requestId: string, sessionId?: string, usage?: Object }>}
 */
async function runClaudeCode(prompt, options = {}) {
  const {
    cwd,
    systemPrompt,
    replaceSystemPrompt = false,
    enableTools,
    allowedTools,
    sessionId, // --resume
    newSessionId, // --session-id
    maxTurns,
    maxBudget,
    model,
    fallbackModel,
    feature,
    mcpConfig,
    jsonSchema,
    onStream,
    onOutput,
    onError,
  } = options;

  const requestId = options.requestId || crypto.randomUUID();
  const streaming = typeof onStream === 'function';

  // ---- Resolve executable path ----
  const claudePath = _resolveClaudePath(getClaudeCodePath());

  // ---- Build args ----
  const args = ['-p', prompt];

  // Output format
  if (streaming) {
    args.push('--output-format', 'stream-json');
  } else {
    args.push('--output-format', 'json');
  }

  // Tools
  if (enableTools) {
    if (allowedTools && allowedTools.length > 0) {
      args.push('--allowedTools', allowedTools.join(','));
    }
  } else {
    args.push('--tools', '');
  }

  // Skip permission checks
  args.push('--dangerously-skip-permissions');

  // System prompt
  if (systemPrompt) {
    if (replaceSystemPrompt) {
      args.push('--system-prompt', systemPrompt);
    } else {
      args.push('--append-system-prompt', systemPrompt);
    }
  }

  // Session management
  if (sessionId) args.push('--resume', sessionId);
  if (newSessionId) args.push('--session-id', newSessionId);

  // Safety controls
  if (maxTurns) args.push('--max-turns', String(maxTurns));
  if (maxBudget) args.push('--max-budget-usd', String(maxBudget));

  // Model selection
  if (model) args.push('--model', model);
  if (fallbackModel) args.push('--fallback-model', fallbackModel);

  // JSON schema enforcement
  if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema));

  // MCP config injection (write to temp file)
  let mcpConfigPath = null;
  if (mcpConfig) {
    mcpConfigPath = path.join(os.tmpdir(), `mcp-config-${requestId}.json`);
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    args.push('--mcp-config', mcpConfigPath);
  }

  // ---- Environment ----
  const env = _buildEnv();

  // Ensure node is on PATH for global installs
  const isBundledBinary = claudePath.includes('Resources') || claudePath.includes('.app');
  if (!isBundledBinary) {
    const nodePaths = [
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/usr/bin/node',
      process.env.HOME + '/.nvm/versions/node/v20.19.0/bin/node',
      process.env.HOME + '/.nvm/versions/node/v22.12.0/bin/node',
    ];
    for (const np of nodePaths) {
      if (fs.existsSync(np)) {
        env.PATH = `${path.dirname(np)}:${env.PATH}`;
        break;
      }
    }
  }

  // ---- Logging ----
  log.info('app', 'Starting Claude Code', {
    requestId,
    claudePath,
    cwd: cwd || process.cwd(),
    prompt: prompt.substring(0, 100) + (prompt.length > 100 ? '...' : ''),
    streaming,
    sessionResume: sessionId || null,
    maxTurns: maxTurns || null,
    maxBudget: maxBudget || null,
  });

  // ---- Spawn ----
  return new Promise((resolve) => {
    const child = spawn(claudePath, args, {
      cwd: cwd || process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Track in sessions map
    _sessions.set(requestId, { process: child, startedAt: Date.now(), cwd: cwd || process.cwd() });

    let stdoutChunks = [];
    let stderrChunks = [];

    // ---- stdout handling ----
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutChunks.push(text);

      if (onOutput) {
        try {
          onOutput({ type: 'stdout', text });
        } catch (err) {
          console.warn('[claude-code-runner] onOutput callback:', err.message);
        }
      }

      // Stream-json: emit each line as a parsed event
      if (streaming) {
        for (const line of text.split('\n').filter(Boolean)) {
          try {
            const event = JSON.parse(line);
            onStream(event);
            // Also notify any progress listeners registered for this requestId
            const listener = _progressListeners.get(requestId);
            if (listener) {
              try {
                listener(event);
              } catch (err) {
                console.warn('[claude-code-runner] progress listener callback:', err.message);
              }
            }
          } catch (_ignored) {
            /* stream line not valid JSON, skip */
          }
        }
      }
    });

    // ---- stderr handling ----
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrChunks.push(text);
      if (onError) {
        try {
          onError({ type: 'stderr', text });
        } catch (err) {
          console.warn('[claude-code-runner] onError callback:', err.message);
        }
      }
    });

    // ---- Process exit ----
    child.on('close', (code) => {
      _sessions.delete(requestId);

      // Cleanup MCP temp file
      if (mcpConfigPath) {
        try {
          fs.unlinkSync(mcpConfigPath);
        } catch (_ignored) {
          /* cleanup: temp file may already be removed */
        }
      }

      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');

      // ---- Check common error patterns ----
      const combined = stdout + stderr;
      if (combined.includes('env: node: No such file or directory')) {
        resolve({
          success: false,
          error: 'Node.js not found. Claude CLI requires Node.js.',
          output: combined,
          requestId,
        });
        return;
      }
      if (combined.includes('command not found') || combined.includes('No such file or directory')) {
        resolve({
          success: false,
          error: 'Claude CLI not found. Please ensure Claude Code is installed.',
          output: combined,
          requestId,
        });
        return;
      }
      if (combined.includes('Invalid API key') || combined.includes('authentication')) {
        resolve({ success: false, error: 'Invalid or missing Anthropic API key.', output: combined, requestId });
        return;
      }

      // ---- Parse output ----
      let parsed = null;
      let outputText = stdout;
      let responseSessionId = null;
      let usage = null;

      if (streaming) {
        // For stream-json, the last "result" event has the final answer
        const lines = stdout.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event.type === 'result') {
              parsed = event;
              outputText = event.result || event.content || '';
              responseSessionId = event.session_id || null;
              usage = event.usage || null;
            }
          } catch (_ignored) {
            /* stdout line not valid JSON, skip */
          }
        }
      } else {
        // JSON mode: parse the full stdout as a single JSON object
        try {
          parsed = JSON.parse(stdout);
          outputText = parsed.result || parsed.content || stdout;
          responseSessionId = parsed.session_id || null;
          usage = parsed.usage || null;
        } catch (_) {
          // Fallback: try to extract JSON from output
          try {
            const jsonMatch = stdout.match(/\{[\s\S]*\}(?=[^}]*$)/);
            if (jsonMatch) {
              parsed = JSON.parse(jsonMatch[0]);
              outputText = parsed.result || parsed.content || stdout;
            }
          } catch (_2) {
            parsed = { raw: stdout };
          }
        }
      }

      // ---- Cost tracking ----
      try {
        const budgetManager = getBudgetManager();
        const hasRealUsage = usage && (usage.input_tokens || usage.inputTokens);

        budgetManager.trackUsage({
          provider: 'anthropic',
          model: (parsed && parsed.model) || 'claude-sonnet-4-5-20250929',
          inputTokens: hasRealUsage
            ? usage.input_tokens || usage.inputTokens
            : estimateTokens(prompt + (systemPrompt || '')),
          outputTokens: hasRealUsage ? usage.output_tokens || usage.outputTokens : estimateTokens(stdout),
          feature: feature || 'claude-code-cli',
          operation: 'cli-run',
          projectId: null,
          metadata: {
            estimated: !hasRealUsage,
            requestId,
            sessionId: responseSessionId,
            enableTools: enableTools || false,
          },
        });
      } catch (trackError) {
        log.warn('app', 'Failed to track usage', { error: trackError.message });
      }

      // ---- Resolve ----
      if (stdout && stdout.trim().length > 0) {
        resolve({
          success: true,
          output: typeof outputText === 'string' ? outputText : stdout,
          result: parsed,
          requestId,
          sessionId: responseSessionId,
          usage: usage || null,
        });
      } else {
        resolve({
          success: false,
          error:
            code !== 0
              ? `Claude CLI exited with code ${code}${stderr ? ': ' + stderr.substring(0, 200) : ''}`
              : 'No output received from Claude CLI',
          output: stderr || '',
          requestId,
        });
      }
    });

    // ---- Handle spawn errors ----
    child.on('error', (err) => {
      _sessions.delete(requestId);
      if (mcpConfigPath) {
        try {
          fs.unlinkSync(mcpConfigPath);
        } catch (_ignored) {
          /* cleanup: temp file may already be removed */
        }
      }
      log.error('app', 'Claude Code spawn error', { error: err.message, requestId });
      resolve({
        success: false,
        error: `Failed to start Claude CLI: ${err.message}`,
        requestId,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/**
 * Cancel a specific session by requestId.
 * @param {string} requestId
 * @returns {boolean}
 */
function cancelSession(requestId) {
  const session = _sessions.get(requestId);
  if (!session) {
    log.info('app', 'No session to cancel', { requestId });
    return false;
  }
  log.info('app', 'Cancelling session', { requestId });
  try {
    session.process.kill('SIGTERM');
    _sessions.delete(requestId);
    _progressListeners.delete(requestId);
    return true;
  } catch (error) {
    log.error('app', 'Cancel error', { error: error.message, requestId });
    return false;
  }
}

/**
 * Cancel ALL active sessions.
 * @returns {number} Number of sessions cancelled
 */
function cancelAll() {
  let count = 0;
  for (const [_requestId, session] of _sessions) {
    try {
      session.process.kill('SIGTERM');
      count++;
    } catch (_ignored) {
      /* process may already be terminated */
    }
  }
  _sessions.clear();
  _progressListeners.clear();
  log.info('app', 'Cancelled all sessions', { count });
  return count;
}

/**
 * Get active sessions info.
 * @returns {Array<{ requestId: string, startedAt: number, cwd: string }>}
 */
function getActiveSessions() {
  return Array.from(_sessions.entries()).map(([requestId, s]) => ({
    requestId,
    startedAt: s.startedAt,
    cwd: s.cwd,
  }));
}

/**
 * Register a progress listener for a specific requestId.
 * Used by IPC handlers to forward streaming events.
 * @param {string} requestId
 * @param {Function} callback
 * @returns {Function} unsubscribe
 */
function onProgress(requestId, callback) {
  _progressListeners.set(requestId, callback);
  return () => _progressListeners.delete(requestId);
}

// ---------------------------------------------------------------------------
// Backward-compatible cancel (legacy single-process interface)
// ---------------------------------------------------------------------------

/**
 * Cancel the running Claude Code process (legacy).
 * Cancels the most recently started session.
 */
function cancelClaudeCode() {
  if (_sessions.size === 0) {
    log.info('app', 'No process to cancel');
    return false;
  }
  // Cancel the most recent session
  const entries = Array.from(_sessions.entries());
  const [requestId] = entries[entries.length - 1];
  return cancelSession(requestId);
}

/**
 * Check if any process is currently running.
 */
function isRunning() {
  return _sessions.size > 0;
}

// ---------------------------------------------------------------------------
// High-level interfaces (backward compatible)
// ---------------------------------------------------------------------------

/**
 * Run a template-based command.
 */
async function runTemplate(template, userPrompt, options = {}) {
  if (template.systemPrompt) {
    options.systemPrompt = template.systemPrompt;
  }
  return runClaudeCode(userPrompt, options);
}

/**
 * Chat-style interface (mimics ClaudeAPI.chat).
 */
async function chat(messages, options = {}) {
  const systemPrompt = options.system || options.systemPrompt || '';

  let conversationContext = '';
  for (const msg of messages) {
    if (msg.role === 'user') {
      conversationContext += `User: ${msg.content}\n\n`;
    } else if (msg.role === 'assistant') {
      conversationContext += `Assistant: ${msg.content}\n\n`;
    }
  }

  const lastUserMessage = messages.filter((m) => m.role === 'user').pop();
  const prompt = lastUserMessage?.content || '';

  const fullPrompt =
    messages.length > 1 ? `Previous conversation:\n${conversationContext}\nRespond to the last user message.` : prompt;

  const result = await runClaudeCode(fullPrompt, { systemPrompt, ...options });

  if (result.success) {
    let content = result.output || '';
    // Try to extract text from structured response
    try {
      const lines = content.split('\n').filter((l) => l.trim());
      for (const line of lines) {
        if (line.startsWith('{')) {
          const parsed = JSON.parse(line);
          if (parsed.type === 'result' && parsed.result) {
            content = parsed.result;
            break;
          }
          if (parsed.content) {
            content = parsed.content;
            break;
          }
        }
      }
    } catch (err) {
      console.warn('[claude-code-runner] extracting structured content from response:', err.message);
    }
    return { success: true, content: content.trim() };
  }
  return { success: false, error: result.error };
}

/**
 * Simple completion interface.
 */
async function complete(prompt, options = {}) {
  const result = await runClaudeCode(prompt, {
    systemPrompt: options.systemPrompt,
    ...options,
  });

  if (result.success) {
    let content = result.output || '';
    try {
      const lines = content.split('\n').filter((l) => l.trim());
      for (const line of lines) {
        if (line.startsWith('{')) {
          const parsed = JSON.parse(line);
          if (parsed.type === 'result' && parsed.result) {
            content = parsed.result;
            break;
          }
          if (parsed.content) {
            content = parsed.content;
            break;
          }
        }
      }
    } catch (err) {
      console.warn('[claude-code-runner] extracting structured content from response:', err.message);
    }
    return content.trim();
  }
  throw new Error(result.error || 'Claude Code failed');
}

/**
 * Execute a task with agentic tools enabled.
 */
async function executeWithTools(prompt, options = {}) {
  return runClaudeCode(prompt, {
    systemPrompt: options.systemPrompt,
    enableTools: true,
    allowedTools: options.allowedTools || ['Bash'],
    cwd: options.cwd,
    ...options,
  });
}

/**
 * Plan an agent based on user description.
 */
async function planAgent(description, availableTemplates = {}) {
  const templateInfo = Object.entries(availableTemplates)
    .map(([id, t]) => `- ${id}: ${t.name} - ${t.description} (capabilities: ${t.capabilities?.join(', ')})`)
    .join('\n');

  const prompt = `Analyze this user request and plan the best approach for building a voice-activated agent:

USER REQUEST: "${description}"

AVAILABLE EXECUTION TYPES:
${
  templateInfo ||
  `
- shell: Terminal commands, file operations, system tasks
- applescript: macOS app control, UI automation, system features
- nodejs: JavaScript code, API calls, data processing
- llm: Conversational AI, Q&A, text generation (no system access)
- browser: Web automation, scraping, form filling
`
}

Analyze the request and identify ALL possible features this agent could have. For each feature, determine if it's feasible.

Respond in JSON format:
{
  "understanding": "What the user is trying to accomplish in one sentence",
  "executionType": "The best execution type for this task",
  "reasoning": "Why this execution type is best (2-3 sentences)",
  "features": [
    {
      "id": "feature_id",
      "name": "Feature Name",
      "description": "What this feature does",
      "enabled": true,
      "feasible": true,
      "feasibilityReason": "Why it can or can't be done",
      "priority": "core|recommended|optional",
      "requiresPermission": false
    }
  ],
  "approach": {
    "steps": ["Step 1", "Step 2", ...],
    "requirements": ["What's needed - apps, permissions, etc"],
    "challenges": ["Potential issues to handle"]
  },
  "suggestedName": "Short agent name (2-4 words)",
  "suggestedKeywords": ["keyword1", "keyword2", ...],
  "verification": {
    "canAutoVerify": true/false,
    "verificationMethod": "How to check if it worked",
    "expectedOutcome": "What success looks like"
  },
  "testPlan": {
    "tests": [
      {
        "id": "test_id",
        "name": "Test Name",
        "description": "What this test verifies",
        "testPrompt": "The voice command to test with",
        "expectedBehavior": "What should happen",
        "verificationMethod": "auto-app-state | auto-file-check | auto-process-check | manual",
        "verificationDetails": {
          "appName": "App name if checking app state",
          "checkType": "running | frontmost | player-state | file-exists",
          "expectedValue": "The expected result"
        },
        "priority": "critical | important | nice-to-have"
      }
    ],
    "setupSteps": ["Any setup needed before testing"],
    "cleanupSteps": ["Cleanup after testing"]
  },
  "confidence": 0.0-1.0
}

TEST PLAN GUIDELINES:
- Include 2-5 tests covering core functionality
- "critical" tests must pass for agent to be considered working
- "important" tests should pass but aren't blockers
- "nice-to-have" tests are optional
- Use "auto-*" verification methods when possible
- Use "manual" only when automatic verification isn't possible

FEATURE GUIDELINES:
- "core" features are essential to the agent's purpose (always enabled by default)
- "recommended" features enhance the agent (enabled by default)
- "optional" features are nice-to-have (disabled by default)
- Set feasible=false for features that cannot be implemented
- Include 4-8 features total`;

  try {
    const response = await complete(prompt, {});
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const plan = JSON.parse(jsonMatch[0]);
        return { success: true, plan, raw: response };
      } catch (parseError) {
        log.error('app', 'Plan JSON parse error', { error: parseError.message });
        return {
          success: false,
          error: `JSON parse error: ${parseError.message}. The response may have been truncated.`,
          raw: response,
          partialJson: jsonMatch[0].substring(0, 1000),
        };
      }
    }
    return { success: false, error: 'No JSON found in response', raw: response };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Path & availability
  getClaudeCodePath,
  isClaudeCodeAvailable,
  isAuthenticated,

  // Core
  runClaudeCode,

  // Session management (new)
  cancelSession,
  cancelAll,
  getActiveSessions,
  onProgress,

  // Legacy compat
  cancelClaudeCode,
  isRunning,

  // High-level interfaces
  runTemplate,
  chat,
  complete,
  executeWithTools,
  planAgent,
};
