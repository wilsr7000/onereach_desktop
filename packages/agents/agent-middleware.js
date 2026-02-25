/**
 * Agent Execution Middleware
 *
 * Sits between the exchange/bridge and every agent. Guarantees:
 *  1. task.content is always a non-null string
 *  2. agent.execute() never throws (error boundary)
 *  3. Result is always { success: boolean, message: string, ... }
 *  4. Execution respects a configurable timeout
 *
 * This eliminates the class of bugs where agents crash from wrong
 * field names, missing null checks, or unhandled exceptions.
 */

const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();
const { resolveTools, createToolDispatcher } = require('../../lib/agent-tools');

const DEFAULT_TIMEOUT_MS = 30000;

// ─── Input Normalization ─────────────────────────────────────────────────────

/**
 * Ensure task.content is always a string. Copies from alternate field names
 * that agents historically relied on (text, query, input).
 */
function normalizeTaskInput(task) {
  if (!task || typeof task !== 'object') {
    return { content: '', metadata: {} };
  }

  const normalized = { ...task };

  if (typeof normalized.content !== 'string') {
    if (normalized.content != null && normalized.content !== '') {
      normalized.content = String(normalized.content);
    } else {
      normalized.content =
        normalized.text ||
        normalized.query ||
        normalized.input ||
        '';
      if (typeof normalized.content !== 'string') {
        normalized.content = String(normalized.content || '');
      }
    }
  } else if (!normalized.content) {
    normalized.content =
      normalized.text ||
      normalized.query ||
      normalized.input ||
      '';
    if (typeof normalized.content !== 'string') {
      normalized.content = String(normalized.content || '');
    }
  }

  // Backfill aliases so agents reading legacy fields still work
  if (!normalized.text) normalized.text = normalized.content;
  if (!normalized.query) normalized.query = normalized.content;

  if (!normalized.metadata || typeof normalized.metadata !== 'object') {
    normalized.metadata = {};
  }

  return normalized;
}

// ─── Output Normalization ────────────────────────────────────────────────────

/**
 * Guarantee the result is always { success: boolean, message: string }.
 * Handles bare strings, undefined, missing message, aliased fields.
 */
function normalizeResult(raw) {
  if (raw === undefined || raw === null) {
    return { success: false, message: 'Agent returned no result' };
  }

  if (typeof raw === 'string') {
    return { success: true, message: raw };
  }

  if (typeof raw !== 'object') {
    return { success: true, message: String(raw) };
  }

  const result = { ...raw };

  // Infer success if not explicitly set
  if (typeof result.success !== 'boolean') {
    result.success = !result.error;
  }

  // Normalize message from various aliases agents use
  if (!result.message) {
    result.message =
      result.output ||
      result.result ||
      result.error ||
      (result.success ? 'Done' : 'Something went wrong');
  }

  if (typeof result.message !== 'string') {
    result.message = String(result.message);
  }

  return result;
}

// ─── Core Middleware ─────────────────────────────────────────────────────────

/**
 * Execute an agent with full defensive wrapping.
 *
 * @param {object} agent       - Agent object with execute()
 * @param {object} task        - Raw task from the exchange
 * @param {object} [options]
 * @param {number} [options.timeoutMs]        - Per-execution timeout (default 30s)
 * @param {Function} [options.executeFn]      - Override how execute is called (for input-schema, etc.)
 * @param {object} [options.executionContext]  - Passed as second arg to agent.execute()
 * @returns {Promise<{success: boolean, message: string, [key: string]: any}>}
 */
async function safeExecuteAgent(agent, task, options = {}) {
  const agentName = agent?.name || agent?.id || 'unknown';
  const timeoutMs = options.timeoutMs || agent?.executionTimeoutMs || DEFAULT_TIMEOUT_MS;
  const startTime = Date.now();

  // 1. Normalize input
  const safeTask = normalizeTaskInput(task);

  // 2. Verify agent has an execute method
  if (!agent || typeof agent.execute !== 'function') {
    log.error('agent', `[Middleware] Agent "${agentName}" has no execute method`);
    return { success: false, message: `Agent "${agentName}" is not properly configured.` };
  }

  // 3. Inject tool capabilities if agent declares tools
  const ctx = options.executionContext || {};
  if (agent.tools && !ctx.chatWithTools) {
    try {
      const resolved = resolveTools(agent.tools);
      if (resolved.length > 0) {
        const ai = require('../../lib/ai-service');
        const dispatcher = createToolDispatcher(resolved);
        const toolDefs = resolved.map((t) => ({
          name: t.name, description: t.description, inputSchema: t.inputSchema,
        }));
        ctx.tools = resolved;
        ctx.toolDefinitions = toolDefs;
        ctx.chatWithTools = (chatOpts) => ai.chatWithTools({
          ...chatOpts,
          tools: resolved,
          onToolCall: chatOpts.onToolCall || dispatcher,
        });
      }
    } catch (toolErr) {
      log.warn('agent', `[Middleware] Failed to resolve tools for "${agentName}"`, { error: toolErr.message });
    }
  }

  // 4. Execute with error boundary + timeout
  try {
    const executeFn = options.executeFn
      ? () => options.executeFn(agent, safeTask, ctx)
      : () => agent.execute(safeTask, ctx);

    const raw = await Promise.race([
      executeFn(),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error(`Agent "${agentName}" timed out after ${Math.round(timeoutMs / 1000)}s`)),
          timeoutMs
        );
      }),
    ]);

    // 4. Normalize output
    const result = normalizeResult(raw);

    const elapsed = Date.now() - startTime;
    if (elapsed > 5000) {
      log.info('agent', `[Middleware] ${agentName} slow execution: ${elapsed}ms`);
    }

    return result;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const isTimeout = err.message?.includes('timed out after');
    const isRateLimit =
      err.statusCode === 429 ||
      err.message?.toLowerCase().includes('rate limit') ||
      err.message?.toLowerCase().includes('too many requests');

    log.error('agent', `[Middleware] ${agentName} execution failed (${elapsed}ms)`, {
      error: err.message,
      isTimeout,
      isRateLimit,
    });

    if (isRateLimit) {
      return {
        success: false,
        message: "I'm getting rate-limited right now. Please try again in a moment.",
        error: err.message,
      };
    }

    if (isTimeout) {
      return {
        success: false,
        message: "That's taking longer than expected. Please try again.",
        error: err.message,
      };
    }

    return {
      success: false,
      message: `I ran into a problem: ${err.message}`,
      error: err.message,
    };
  }
}

// ─── Registration Validation ─────────────────────────────────────────────────

const REQUIRED_FIELDS = ['id', 'name'];
const REQUIRED_METHODS = ['execute'];
const RECOMMENDED_FIELDS = ['categories', 'description', 'keywords'];

/**
 * Validate an agent object at registration time.
 * Logs warnings for missing fields but does not block registration.
 *
 * @returns {{ valid: boolean, warnings: string[] }}
 */
function validateAgentContract(agent) {
  const warnings = [];
  const agentLabel = agent?.name || agent?.id || 'unknown';

  for (const field of REQUIRED_FIELDS) {
    if (!agent[field]) {
      warnings.push(`Missing required field: ${field}`);
    }
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof agent[method] !== 'function') {
      warnings.push(`Missing required method: ${method}()`);
    }
  }

  for (const field of RECOMMENDED_FIELDS) {
    if (!agent[field]) {
      warnings.push(`Missing recommended field: ${field}`);
    }
  }

  if (agent.categories && !Array.isArray(agent.categories)) {
    warnings.push('categories should be an array');
  }

  if (warnings.length > 0) {
    log.warn('agent', `[Middleware] Agent "${agentLabel}" contract warnings`, {
      warnings: warnings.join('; '),
    });
  }

  return {
    valid: warnings.filter((w) => w.startsWith('Missing required')).length === 0,
    warnings,
  };
}

module.exports = {
  safeExecuteAgent,
  normalizeTaskInput,
  normalizeResult,
  validateAgentContract,
  DEFAULT_TIMEOUT_MS,
};
