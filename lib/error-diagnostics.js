/**
 * Error Diagnostics -- translates raw errors into plain-English, copiable recommendations.
 *
 * Flow:
 *   1. Try the built-in hint table first. Matches common patterns (GSX
 *      cross-account, LiveKit metadata, ECONNREFUSED, 401/403/429, module-not-found,
 *      TCC permission, etc.). Zero cost, instant.
 *   2. If no hint matches, try Claude Code (claude-code-runner.complete) with a
 *      diagnosis system prompt and JSON output. Gated by budget-manager.
 *   3. If Claude Code is unavailable or over-budget, fall back to the central
 *      AI service (ai-service.json) with the 'powerful' profile.
 *   4. Last resort: return a structured recommendation built from the raw error +
 *      log-queue context so the user still gets something useful and copiable.
 *
 * Result shape (stable):
 *   {
 *     summary:      string,           // plain-English one-line headline
 *     rootCause:    string,           // why it happened
 *     steps:        string[],         // what to try, in order
 *     copyable:     string,           // Markdown bundle for the "Copy" button
 *     source:       'hint' | 'claude-code' | 'ai-service' | 'fallback',
 *     cached:       boolean,
 *     degraded?:    string,           // present when we fell back
 *   }
 */

'use strict';

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// ────────────────────────────────────────────────────────────────────────────
// Built-in hint table
// Ordered from most specific to most generic. First match wins.
// ────────────────────────────────────────────────────────────────────────────

const HINTS = [
  {
    id: 'gsx-cross-account',
    test: (msg) => /Cross account requests allowed to SUPER_ADMIN only/i.test(msg),
    build: () => ({
      summary: 'Your GSX account does not match the target account.',
      rootCause:
        "The app tried to write to a GSX Files account that your token does not own. The Edison API only allows cross-account writes for SUPER_ADMIN users.",
      steps: [
        'Open Settings and confirm you are signed in to the correct GSX account.',
        'If the signed-in account looks right, sign out and sign back in to refresh your token.',
        'If the problem is during a WISER Meeting publish, restart the app so the publish handler re-reads your account ID.',
      ],
    }),
  },
  {
    id: 'livekit-metadata-permission',
    test: (msg) => /does not have permission to update own metadata/i.test(msg),
    build: () => ({
      summary: 'The meeting token is missing a LiveKit permission.',
      rootCause:
        'LiveKit refused a setMetadata call because the access token was minted without the canUpdateOwnMetadata grant.',
      steps: [
        'Restart the app so new meeting tokens pick up the updated grant.',
        'Start a fresh WISER Meeting session; the old session token is still cached.',
        'If the error persists after a fresh session, check lib/livekit-service.js for the canUpdateOwnMetadata grant.',
      ],
    }),
  },
  {
    id: 'module-not-found-preload',
    test: (msg) => /module not found:\s*\.\/preload-/i.test(msg),
    build: (msg) => ({
      summary: 'A preload script could not load a local module.',
      rootCause:
        'Electron preloads run in a sandbox by default and cannot require() relative paths. The preload was loaded with sandbox:true.',
      steps: [
        'Add sandbox: false to the webPreferences for this window (contextIsolation: true can stay).',
        'Restart the app so the window rebinds with the new preload settings.',
        `Raw error: ${msg}`,
      ],
    }),
  },
  {
    id: 'json-parse-truncation',
    test: (msg) => /Unterminated string in JSON at position/i.test(msg),
    build: () => ({
      summary: 'An LLM response was cut off mid-JSON.',
      rootCause:
        'The model hit its maxTokens cap while still writing JSON output, so the response ended inside a string and could not be parsed.',
      steps: [
        'Raise maxTokens for the call site that failed (look for the feature: tag in the error log).',
        'If the output is open-ended, consider streaming the response and parsing incrementally.',
        'For evaluator/orchestrator calls with many bidders, bump maxTokens to 1500 or higher.',
      ],
    }),
  },
  {
    id: 'econn-refused',
    test: (msg) => /ECONNREFUSED|connect ECONN/i.test(msg),
    build: (msg) => {
      const portMatch = msg.match(/:(\d{2,5})\b/);
      const port = portMatch ? portMatch[1] : 'the expected port';
      return {
        summary: `Could not reach a local service on ${port}.`,
        rootCause:
          'A service the app depends on is not listening. Usually the log server, Spaces API, or agent exchange failed to start (or crashed).',
        steps: [
          'Check if the app is fully booted -- some services take a few seconds after launch.',
          `Try: curl http://127.0.0.1:${port}/health`,
          'Restart the app if the service does not come back within 30 seconds.',
        ],
      };
    },
  },
  {
    id: 'http-401',
    test: (msg) => /\b401\b|Unauthorized/i.test(msg),
    build: () => ({
      summary: 'An authentication token was rejected.',
      rootCause:
        'The server returned 401 Unauthorized. The token is either missing, malformed, or expired.',
      steps: [
        'Open Settings and confirm your token (GSX, OpenAI, Anthropic, etc.) is set for this feature.',
        'If the token is set, it may have expired. Sign out and sign back in, or paste a fresh token.',
        'Restart the app after updating the token so every long-lived client picks it up.',
      ],
    }),
  },
  {
    id: 'http-403',
    test: (msg) => /\b403\b|Forbidden/i.test(msg),
    build: () => ({
      summary: 'The server accepted your token but refused the action.',
      rootCause:
        'The 403 Forbidden response means the token is valid but lacks permission for this resource (wrong account, wrong scope, or insufficient role).',
      steps: [
        'Confirm you are signed in to the account that owns the resource you are trying to access.',
        'If the call is writing to a shared resource, you may need an admin to grant access or change the target.',
        'Check the app log for the request URL -- the accountId in the path should be yours.',
      ],
    }),
  },
  {
    id: 'http-429',
    test: (msg) => /\b429\b|rate limit|Too Many Requests/i.test(msg),
    build: () => ({
      summary: 'A rate limit was hit.',
      rootCause:
        'The upstream API (OpenAI, Anthropic, or another service) rejected the call because too many requests arrived in a short window.',
      steps: [
        'Wait 30-60 seconds and try again.',
        'If it happens often, switch to a lower-tier profile (fast instead of powerful) for non-critical calls.',
        'If you are on a free/trial tier, check the provider dashboard for your current quota.',
      ],
    }),
  },
  {
    id: 'tcc-permission',
    test: (msg) => /not authorized|TCC|Operation not permitted/i.test(msg),
    build: () => ({
      summary: 'macOS denied a system permission.',
      rootCause:
        'The app tried to access a protected resource (microphone, camera, screen recording, files, contacts) without the user having granted permission.',
      steps: [
        'Open System Settings > Privacy & Security.',
        'Find the relevant section (Microphone, Camera, Screen & System Audio Recording, Files and Folders).',
        'Toggle GSX Power User on. If it is already on, toggle it off and back on.',
        'Restart the app.',
      ],
    }),
  },
  {
    id: 'gsx-not-configured',
    test: (msg) => /GSX account not configured|gsxRefreshUrl|gsxAccountId/i.test(msg),
    build: () => ({
      summary: 'GSX is not signed in.',
      rootCause:
        'This feature needs a GSX account (to store files, tokens, or KV data), but the app could not find a valid refresh URL or account ID in Settings.',
      steps: [
        'Open Settings.',
        'In the GSX section, sign in or paste a fresh token.',
        'Confirm the account ID shown matches the account you want to use.',
      ],
    }),
  },
  {
    id: 'empty-llm-response',
    test: (msg) => /Empty LLM response|empty.*completion/i.test(msg),
    build: () => ({
      summary: 'The language model returned no text.',
      rootCause:
        'The upstream LLM (OpenAI or Anthropic) finished without producing any content. Common causes: extended-thinking models that spent all their budget on hidden thinking, safety filters, or a malformed prompt.',
      steps: [
        'Retry the action -- empty responses are often transient.',
        'If it happens repeatedly on the same prompt, try a different profile (standard instead of powerful).',
        'For extended-thinking calls, disable thinking or bump maxTokens significantly.',
      ],
    }),
  },
  {
    id: 'cross-account-requests',
    test: (msg) => /cross.account|cross-account/i.test(msg),
    build: () => ({
      summary: 'An API rejected a cross-account write.',
      rootCause:
        'The feature tried to write to a resource owned by a different account than your signed-in one.',
      steps: [
        'Sign into the account that owns the resource, or change the target to one you own.',
        'Check Settings for the current account ID.',
      ],
    }),
  },
];

// ────────────────────────────────────────────────────────────────────────────
// LLM system prompt -- kept here, not in a .md, so it stays versioned with code.
// ────────────────────────────────────────────────────────────────────────────

const DIAGNOSIS_SYSTEM_PROMPT = `You are a diagnostic assistant inside a desktop app called GSX Power User (Onereach.ai).
When an error happens, your job is to give the END USER a short, plain-English explanation and a concrete
list of next steps they can try. You are NOT writing for developers -- avoid jargon, avoid stack-trace
references, avoid file paths unless they matter to the user.

Return STRICT JSON with this exact shape, no prose before or after:

{
  "summary":   "One short sentence the user sees first. Plain language. 10-20 words.",
  "rootCause": "Why this happened, phrased for a non-engineer. 20-50 words.",
  "steps":     ["Action 1", "Action 2", "Action 3"]
}

Guidelines for steps:
- 2 to 4 steps, ordered from most likely to work to least.
- Each step is one imperative sentence ("Restart the app.", "Open Settings and check X.").
- Prefer user-facing actions (clicks, menu items, restarts) over code changes.
- Only mention code or log files if the user genuinely needs to look at them.
- If you truly don't know, say "This looks like an app bug -- please report it." as one of the steps.`;

// ────────────────────────────────────────────────────────────────────────────
// Cache -- keyed by a normalized signature of the error
// ────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;
const _cache = new Map(); // key -> { result, expires }

function _cacheKey({ message, category, source }) {
  // Collapse noise (uuids, long numeric ids, timestamps) so repeat instances
  // of the same fundamental error hit the same cache entry. Order matters:
  // UUIDs must be replaced BEFORE the long-digit rule, or the 12-hex-digit
  // tail of a UUID gets eaten first and the UUID regex stops matching.
  const normalized = String(message || '')
    .slice(0, 200)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'UUID')
    .replace(/\b\d{10,}\b/g, 'N')
    .toLowerCase();
  return `${category || '-'}::${source || '-'}::${normalized}`;
}

function _cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    _cache.delete(key);
    return null;
  }
  return entry.result;
}

function _cacheSet(key, result) {
  if (_cache.size >= CACHE_MAX_ENTRIES) {
    // Drop oldest entry (Map preserves insertion order)
    const first = _cache.keys().next().value;
    if (first !== undefined) _cache.delete(first);
  }
  _cache.set(key, { result, expires: Date.now() + CACHE_TTL_MS });
}

// Exposed for tests
function _clearCache() {
  _cache.clear();
}

// ────────────────────────────────────────────────────────────────────────────
// Copyable bundle -- Markdown the user can paste into Slack, an issue, or an email
// ────────────────────────────────────────────────────────────────────────────

function _buildCopyable({ summary, rootCause, steps, errorContext, appVersion }) {
  const ctx = errorContext || {};
  const lines = [];
  lines.push('**GSX Power User -- Diagnostic report**');
  lines.push('');
  lines.push(`- When: ${new Date().toISOString()}`);
  if (appVersion) lines.push(`- App version: ${appVersion}`);
  if (ctx.category) lines.push(`- Category: ${ctx.category}`);
  if (ctx.source) lines.push(`- Source: ${ctx.source}`);
  if (ctx.agentId) lines.push(`- Agent: ${ctx.agentId}`);
  lines.push('');
  lines.push('**What happened**');
  lines.push(summary);
  lines.push('');
  lines.push('**Why**');
  lines.push(rootCause);
  lines.push('');
  lines.push('**Try this**');
  for (const step of steps) lines.push(`1. ${step}`);
  lines.push('');
  lines.push('**Raw error**');
  lines.push('```');
  lines.push(String(ctx.message || '').slice(0, 800));
  lines.push('```');
  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// LLM paths
// ────────────────────────────────────────────────────────────────────────────

function _buildUserPrompt(errorContext, recentLogs) {
  const { message, category, source, agentId, data } = errorContext || {};
  const lines = [];
  lines.push('A user just hit this error in the app. Diagnose it and return JSON per the system prompt.');
  lines.push('');
  lines.push('ERROR MESSAGE:');
  lines.push(String(message || '(no message)').slice(0, 2000));
  lines.push('');
  if (category) lines.push(`Category: ${category}`);
  if (source) lines.push(`Source: ${source}`);
  if (agentId) lines.push(`Agent: ${agentId}`);
  if (data && typeof data === 'object') {
    try {
      lines.push('Data: ' + JSON.stringify(data).slice(0, 500));
    } catch {
      /* non-serializable */
    }
  }
  if (Array.isArray(recentLogs) && recentLogs.length > 0) {
    lines.push('');
    lines.push('Recent related log lines (newest last):');
    for (const entry of recentLogs.slice(-10)) {
      const ts = (entry.timestamp || '').slice(11, 19);
      const msg = String(entry.message || '').slice(0, 200);
      lines.push(`  ${ts} [${entry.level || 'info'}] ${msg}`);
    }
  }
  return lines.join('\n');
}

function _parseLLMJson(raw) {
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (obj && typeof obj === 'object' && obj.summary && Array.isArray(obj.steps)) {
      return {
        summary: String(obj.summary),
        rootCause: String(obj.rootCause || ''),
        steps: obj.steps.map((s) => String(s)).filter(Boolean).slice(0, 6),
      };
    }
  } catch (_) {
    /* fall through */
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Dependency injection hooks (test-only overrides)
// Production paths lazy-require the real modules; tests override via the
// _set* helpers exported at the bottom of this file. This mirrors the
// pattern used by packages/agents/agent-builder-agent.js (_setClaudeCodeBuilder).
// ────────────────────────────────────────────────────────────────────────────

let _injectedClaudeRunner = null;
let _injectedAiService = null;
let _injectedBudgetManager = null;

function _resolveClaudeRunner() {
  if (_injectedClaudeRunner) return _injectedClaudeRunner;
  try {
    return require('./claude-code-runner');
  } catch (_) {
    return null;
  }
}

function _resolveAiService() {
  if (_injectedAiService) return _injectedAiService;
  try {
    return require('./ai-service');
  } catch (_) {
    return null;
  }
}

function _resolveBudgetManager() {
  if (_injectedBudgetManager) return _injectedBudgetManager;
  try {
    return require('../budget-manager');
  } catch (_) {
    return null;
  }
}

async function _tryClaudeCode(errorContext, recentLogs) {
  const runner = _resolveClaudeRunner();
  if (!runner || typeof runner.isClaudeCodeAvailable !== 'function') return null;

  try {
    const availability = await runner.isClaudeCodeAvailable();
    if (!availability?.available) return null;
  } catch (_) {
    return null;
  }

  try {
    const prompt = _buildUserPrompt(errorContext, recentLogs);
    const result = await runner.runClaudeCode(prompt, {
      systemPrompt: DIAGNOSIS_SYSTEM_PROMPT,
      enableTools: false,
      maxBudget: 0.05, // cap one diagnosis at 5 cents
      maxTurns: 1,
      feature: 'error-diagnostics',
    });
    if (!result?.success) return null;
    const body = result.result || result.output || '';
    const parsed = _parseLLMJson(_extractJson(body));
    if (!parsed) return null;
    return { ...parsed, _source: 'claude-code' };
  } catch (err) {
    log.warn('app', 'error-diagnostics: claude-code path failed', { error: err.message });
    return null;
  }
}

async function _tryAiService(errorContext, recentLogs) {
  const ai = _resolveAiService();
  if (!ai || typeof ai.json !== 'function') return null;

  try {
    const prompt = _buildUserPrompt(errorContext, recentLogs);
    const parsed = await ai.json(prompt, {
      profile: 'powerful',
      system: DIAGNOSIS_SYSTEM_PROMPT,
      maxTokens: 600,
      temperature: 0.2,
      feature: 'error-diagnostics',
    });
    const norm = _parseLLMJson(parsed);
    if (!norm) return null;
    return { ...norm, _source: 'ai-service' };
  } catch (err) {
    log.warn('app', 'error-diagnostics: ai-service path failed', { error: err.message });
    return null;
  }
}

function _extractJson(text) {
  if (!text) return null;
  const s = String(text).trim();
  if (s.startsWith('{')) return s;
  // Claude Code sometimes wraps JSON in ```json ... ```
  const fence = s.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fence) return fence[1];
  // Fall back to first { ... last }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) return s.slice(first, last + 1);
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Budget guard -- small per-diagnosis cap so errors in a tight loop can't
// drain the day's AI budget
// ────────────────────────────────────────────────────────────────────────────

function _overBudget() {
  const budget = _resolveBudgetManager();
  if (!budget) return false;
  try {
    const mgr = typeof budget.getBudgetManager === 'function' ? budget.getBudgetManager() : null;
    if (!mgr || typeof mgr.checkBudget !== 'function') return false;
    const check = mgr.checkBudget(0.05);
    return !!check?.blocked;
  } catch (_) {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Diagnose an error and return a user-friendly recommendation.
 *
 * @param {Object} errorContext
 * @param {string} errorContext.message     Required. The raw error text.
 * @param {string} [errorContext.category]  E.g. 'recorder', 'agent', 'voice'.
 * @param {string} [errorContext.source]    Subsystem or file.
 * @param {string} [errorContext.agentId]   Which agent, if any, hit the error.
 * @param {Object} [errorContext.data]      Any additional structured context.
 * @param {Object} [options]
 * @param {boolean} [options.skipCache=false]   Bypass the cache.
 * @param {boolean} [options.skipLLM=false]     Only use the hint table.
 * @param {string}  [options.appVersion]        Embedded in the copyable bundle.
 * @param {Array}   [options.recentLogs]        Optional array of recent log entries.
 * @returns {Promise<{ summary, rootCause, steps, copyable, source, cached, degraded? }>}
 */
async function diagnoseError(errorContext, options = {}) {
  const ctx = errorContext || {};
  const message = String(ctx.message || '').trim();
  if (!message) {
    return _finalize(
      {
        summary: 'No error message was provided.',
        rootCause: 'The diagnostic call arrived without an error message, so there is nothing to analyze.',
        steps: ['Retry the original action and try again.'],
        _source: 'fallback',
      },
      ctx,
      options,
      false
    );
  }

  const key = _cacheKey({ message, category: ctx.category, source: ctx.source });

  if (!options.skipCache) {
    const cached = _cacheGet(key);
    if (cached) return { ...cached, cached: true };
  }

  // 1. Built-in hint table
  for (const hint of HINTS) {
    if (hint.test(message)) {
      const built = hint.build(message);
      const result = _finalize({ ...built, _source: 'hint', _hintId: hint.id }, ctx, options, false);
      _cacheSet(key, result);
      return result;
    }
  }

  // Optional early-exit (used by tests and by any caller that explicitly wants
  // a zero-cost diagnosis).
  if (options.skipLLM) {
    const fallback = _buildFallbackRecommendation(ctx);
    const result = _finalize(fallback, ctx, options, true, 'llm-skipped');
    _cacheSet(key, result);
    return result;
  }

  // 2. Budget check before spending anything
  if (_overBudget()) {
    const fallback = _buildFallbackRecommendation(ctx);
    const result = _finalize(fallback, ctx, options, true, 'budget-exceeded');
    _cacheSet(key, result);
    return result;
  }

  // 3. Claude Code
  const recentLogs = Array.isArray(options.recentLogs) ? options.recentLogs : [];
  const claude = await _tryClaudeCode(ctx, recentLogs);
  if (claude) {
    const result = _finalize(claude, ctx, options, false);
    _cacheSet(key, result);
    return result;
  }

  // 4. AI service fallback
  const aiSvc = await _tryAiService(ctx, recentLogs);
  if (aiSvc) {
    const result = _finalize(aiSvc, ctx, options, false);
    _cacheSet(key, result);
    return result;
  }

  // 5. Last-resort structured fallback
  const fallback = _buildFallbackRecommendation(ctx);
  const result = _finalize(fallback, ctx, options, true, 'llm-unavailable');
  _cacheSet(key, result);
  return result;
}

function _buildFallbackRecommendation(ctx) {
  return {
    summary: 'Something went wrong and automatic diagnosis is unavailable.',
    rootCause:
      'The app could not reach its diagnosis model right now. The raw error has been preserved so you can retry or share it.',
    steps: [
      'Retry the action -- many errors are transient.',
      'If it happens again, restart the app.',
      'Copy this report and share it with support or file an issue.',
    ],
    _source: 'fallback',
  };
}

function _finalize(built, errorContext, options, degraded, degradedReason) {
  const summary = String(built.summary || '').trim();
  const rootCause = String(built.rootCause || '').trim();
  const steps = Array.isArray(built.steps) ? built.steps : [];
  const copyable = _buildCopyable({
    summary,
    rootCause,
    steps,
    errorContext: { ...errorContext, message: errorContext?.message },
    appVersion: options?.appVersion,
  });
  const out = {
    summary,
    rootCause,
    steps,
    copyable,
    source: built._source || 'fallback',
    cached: false,
  };
  if (degraded) out.degraded = degradedReason || 'degraded';
  if (built._hintId) out.hintId = built._hintId;
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Test-only injection hooks. Underscored names signal "internal". Production
// code never calls these; they let unit tests swap the Claude Code runner,
// AI service, and budget manager without wrestling with vi.mock + CJS require.
// ────────────────────────────────────────────────────────────────────────────

function _setClaudeRunner(runner) {
  _injectedClaudeRunner = runner;
}

function _setAiService(svc) {
  _injectedAiService = svc;
}

function _setBudgetManager(mgr) {
  _injectedBudgetManager = mgr;
}

function _resetInjections() {
  _injectedClaudeRunner = null;
  _injectedAiService = null;
  _injectedBudgetManager = null;
}

module.exports = {
  diagnoseError,
  HINTS, // exposed for tests and UI (shows the list of built-in patterns)
  _clearCache, // test-only helper; underscored to signal internal
  _setClaudeRunner,
  _setAiService,
  _setBudgetManager,
  _resetInjections,
};
