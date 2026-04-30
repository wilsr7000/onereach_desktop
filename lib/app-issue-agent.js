/**
 * App Issue Agent -- app-wide "diagnose + propose fix" pipeline.
 *
 * Two stages, cleanly separated so callers can stop after stage 1:
 *
 *   Stage A -- diagnose
 *     Inputs:  { userMessage, errorContext, recentLogs, sourceOverview }
 *     Uses:    Claude Code with read-only tools (Read, Grep, Glob)
 *     Budget:  $0.15 per call (capped), cached 5 min
 *     Output:  structured diagnosis { summary, rootCause, severity,
 *              affectedFiles[], reproSteps[], instructionsForFixAgent }
 *
 *   Stage B -- propose fix (opt-in, dev-mode only)
 *     Inputs:  the diagnosis from stage A, plus options for branch name / PR
 *     Uses:    Claude Code with Read + Grep + Glob (NOT Edit)
 *     Budget:  $1.00 per call (capped)
 *     Output:  { patch (unified diff string), changes: [{file, reasoning}],
 *              branchSuggestion, commitMessage, prDescription }
 *
 * Safety rails:
 *   - The fix stage NEVER modifies the working tree directly. Claude Code
 *     returns unified-diff hunks in its JSON response; we assemble them into
 *     a .patch file the user reviews before applying.
 *   - File allow-list: .js, .html, .css, .md, .json (non-lock) inside the
 *     repo. Never package-lock.json, never .env*, never node_modules.
 *   - Branch suggestion is always `fix/<slug>-<short-id>`; never 'main' or
 *     'master'.
 *   - Fix stage is gated: requires !app.isPackaged OR ONEREACH_AUTOFIX=1.
 *
 * Any function in the app can call `reportIssue()` -- it's the one entry
 * point agents and IPC handlers should use.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// ────────────────────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────────────────────

const DIAGNOSE_BUDGET_USD = 0.15;
const PROPOSE_FIX_BUDGET_USD = 1.0;
const DIAGNOSE_TIMEOUT_MS = 60_000;
const PROPOSE_FIX_TIMEOUT_MS = 180_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 30;

// File types the fix stage is allowed to propose edits to.
const ALLOWED_FIX_EXTENSIONS = new Set(['.js', '.ts', '.html', '.css', '.md', '.json']);
// Explicit deny list that overrides the extension check.
const DENIED_FIX_PATHS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)\.env/,
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
  /(^|\/)resources\/claude-code\//,
  /\.asar(\.|$)/,
];

// Branches we must never overwrite.
const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'production']);

// ────────────────────────────────────────────────────────────────────────────
// Dependency injection hooks (test-only overrides)
// ────────────────────────────────────────────────────────────────────────────

let _injectedClaudeRunner = null;
let _injectedBudgetManager = null;
let _injectedElectronApp = null;

function _resolveClaudeRunner() {
  if (_injectedClaudeRunner) return _injectedClaudeRunner;
  try {
    return require('./claude-code-runner');
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

function _resolveElectronApp() {
  if (_injectedElectronApp) return _injectedElectronApp;
  try {
    // Electron's app may not be available in test env; treat absence as dev mode.
    const { app } = require('electron');
    return app;
  } catch (_) {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Dev-mode detection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fix stage is enabled when EITHER:
 *   - app.isPackaged === false  (running from source)
 *   - ONEREACH_AUTOFIX=1         (explicit opt-in from a packaged build)
 */
function isFixStageEnabled() {
  if (process.env.ONEREACH_AUTOFIX === '1') return true;
  const app = _resolveElectronApp();
  if (!app) return true; // no Electron context = test env, treat as dev
  return app.isPackaged !== true;
}

/**
 * Claude Code must be installed for either stage. The diagnose stage falls
 * back to ai-service.powerful, but we prefer the CLI so it can use Read tools.
 */
async function isClaudeCodeAvailable() {
  const runner = _resolveClaudeRunner();
  if (!runner || typeof runner.isClaudeCodeAvailable !== 'function') return false;
  try {
    const r = await runner.isClaudeCodeAvailable();
    return !!r?.available;
  } catch (_) {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Source overview
// Provides a lightweight "map of the codebase" the diagnostic agent can read
// instead of wandering through the entire tree. Cached in memory; regenerated
// each process run.
// ────────────────────────────────────────────────────────────────────────────

let _cachedSourceOverview = null;

function _getRepoRoot() {
  // The module is at <repo>/lib/app-issue-agent.js -- root is one up.
  return path.resolve(__dirname, '..');
}

function getCachedSourceOverview() {
  if (_cachedSourceOverview) return _cachedSourceOverview;

  const root = _getRepoRoot();
  const overview = {
    repoRoot: root,
    topLevel: [],
    keyFiles: [],
    agents: [],
  };

  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
      overview.topLevel.push({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' });
    }
  } catch (_) {
    /* fall through */
  }

  // Hand-picked key files so the diagnostic agent can orient itself without
  // `ls`-walking the tree.
  const keyFileCandidates = [
    ['main.js', 'Electron main process. IPC handlers, window creation, app lifecycle.'],
    ['preload.js', 'Main window preload. Exposes window.api, window.ai, window.diagnostics, etc.'],
    ['lib/ai-service.js', 'Central AI service. All LLM calls should go through here.'],
    ['lib/claude-code-runner.js', 'Bundled Claude Code CLI runner.'],
    ['lib/error-diagnostics.js', 'Built-in hint table + LLM fallback for user-friendly error explanations.'],
    ['lib/log-event-queue.js', 'Structured log queue powering the log server on port 47292.'],
    ['lib/log-server.js', 'HTTP/WS log server. REST endpoints documented in its header comment.'],
    ['lib/hud-api.js', 'Central task submission + result + lifecycle fan-out.'],
    ['lib/livekit-service.js', 'WISER Meeting token minting.'],
    ['packages/agents/agent-registry.js', 'Built-in agent loader and registry.'],
    ['recorder.js', 'Recorder window + WISER Meeting IPC handlers.'],
    ['command-hud.html', 'Command HUD renderer.'],
    ['PUNCH-LIST.md', 'Running log of recent fixes, known issues, and architecture decisions.'],
    ['ROADMAP.md', 'Strategic roadmap.'],
  ];
  for (const [rel, desc] of keyFileCandidates) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) {
      overview.keyFiles.push({ path: rel, description: desc });
    }
  }

  // Enumerate built-in agents from the agent-registry if present.
  try {
    const registryPath = path.join(root, 'packages/agents/agent-registry.js');
    if (fs.existsSync(registryPath)) {
      const src = fs.readFileSync(registryPath, 'utf8');
      const ids = src.match(/'[a-z-]+-agent'/g) || [];
      overview.agents = Array.from(new Set(ids.map((s) => s.slice(1, -1))));
    }
  } catch (_) {
    /* non-fatal */
  }

  _cachedSourceOverview = overview;
  return overview;
}

// ────────────────────────────────────────────────────────────────────────────
// Cache for diagnose results
// ────────────────────────────────────────────────────────────────────────────

const _diagCache = new Map();

function _diagCacheKey({ userMessage, errorContext }) {
  const m = String(userMessage || '').slice(0, 240);
  const e = errorContext?.message ? String(errorContext.message).slice(0, 240) : '';
  const norm = `${m}::${e}`
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'UUID')
    .replace(/\b\d{10,}\b/g, 'N')
    .toLowerCase();
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

function _diagCacheGet(key) {
  const entry = _diagCache.get(key);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    _diagCache.delete(key);
    return null;
  }
  return entry.value;
}

function _diagCacheSet(key, value) {
  if (_diagCache.size >= MAX_CACHE_ENTRIES) {
    const first = _diagCache.keys().next().value;
    if (first !== undefined) _diagCache.delete(first);
  }
  _diagCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

// ────────────────────────────────────────────────────────────────────────────
// Budget guard
// ────────────────────────────────────────────────────────────────────────────

function _overBudget(amountUsd) {
  const budget = _resolveBudgetManager();
  if (!budget) return false;
  try {
    const mgr = typeof budget.getBudgetManager === 'function' ? budget.getBudgetManager() : null;
    if (!mgr || typeof mgr.checkBudget !== 'function') return false;
    return !!mgr.checkBudget(amountUsd)?.blocked;
  } catch (_) {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Recent logs -- pulls a 10-minute error-heavy window from the log queue.
// Injected by the IPC caller when possible; otherwise queried here.
// ────────────────────────────────────────────────────────────────────────────

function _recentLogs({ category, minutes = 10, limit = 40 } = {}) {
  try {
    const queue = getLogQueue();
    if (!queue || typeof queue.query !== 'function') return [];
    const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const entries = queue.query({
      category: category || undefined,
      since,
      limit: Math.min(limit, 200),
    });
    return Array.isArray(entries) ? entries : [];
  } catch (_) {
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Prompts
// ────────────────────────────────────────────────────────────────────────────

const DIAGNOSE_SYSTEM_PROMPT = `You are the diagnostic half of a two-agent issue-triage pipeline
inside GSX Power User (Onereach.ai desktop app, Electron/Node.js, JavaScript).

Your job:
  1. Read the user's issue description and any error context + recent logs we give you.
  2. Use the Read, Grep, and Glob tools to inspect ONLY the files that are likely relevant.
  3. Form a hypothesis about what's wrong and where.
  4. Return a STRICT JSON object -- no prose before or after -- with this shape:

{
  "summary":        "One plain-English sentence the user sees first. 10-25 words.",
  "rootCause":      "Why this is happening. 20-80 words. Reference specific files/lines when confident.",
  "severity":       "low" | "medium" | "high",
  "affectedFiles":  [
    { "path": "lib/foo.js", "lines": "123-145", "why": "The event handler here swallows errors without logging." }
  ],
  "reproSteps":     ["Step 1.", "Step 2."],
  "userFacingSteps":["One short action the user can take right now.", "Another fallback action."],
  "instructionsForFixAgent": {
    "goal":          "One sentence description of what the fix should achieve.",
    "filesToEdit":   ["lib/foo.js"],
    "approach":      "A concise plan. What to change, in what order, and why.",
    "verification":  ["How to verify the fix: a unit test name, a manual step, a log line to watch."],
    "risks":         ["Things that could go wrong with this fix."]
  },
  "canAutoFix": true | false,
  "confidence": 0.0 - 1.0
}

Rules:
  - Be concise. Favor short strings over long ones.
  - Only list files you actually inspected or have strong reason to suspect.
  - \`canAutoFix\` should be \`true\` ONLY when the fix is small, localized, mechanical,
    and won't break unrelated code (e.g. add a missing grant, change a constant, fix
    a typo, add a null guard). Set to \`false\` for anything needing design judgement.
  - If the root cause is outside the codebase (user config, credentials, network),
    set \`canAutoFix: false\` and make \`userFacingSteps\` do the real work.
  - Never invent file paths. Only reference paths you've confirmed exist.`;

const PROPOSE_FIX_SYSTEM_PROMPT = `You are the FIX half of a two-agent pipeline inside GSX Power User.
A diagnostic agent has already analyzed the issue. You are given its diagnosis and you must
propose a concrete code change.

You have Read, Grep, and Glob tools. You DO NOT have Edit or Write. Instead, you return your
proposed changes as unified-diff hunks inside a JSON response.

Return STRICT JSON with this shape -- no prose before or after:

{
  "summary":         "One-sentence description of the fix.",
  "changes": [
    {
      "path":     "lib/foo.js",
      "reasoning":"Why this file needs to change. 1-2 sentences.",
      "unifiedDiff": "--- a/lib/foo.js\\n+++ b/lib/foo.js\\n@@ -120,5 +120,6 @@\\n context line\\n context line\\n-removed line\\n+added line\\n context line\\n"
    }
  ],
  "branchSuggestion":  "fix/short-slug",
  "commitMessage":     "fix(area): 50-char imperative summary\\n\\nOptional body.",
  "prDescription":     "Markdown PR body explaining what and why.",
  "verificationPlan":  ["npm test", "Manual step 1", "Manual step 2"]
}

Rules:
  - Every \`unifiedDiff\` MUST be a valid unified diff that \`git apply\` can consume.
    Include 3 lines of context before and after each hunk when possible.
  - File paths are relative to the repo root, with POSIX separators.
  - Never touch these: package-lock.json, yarn.lock, pnpm-lock.yaml, .env*, node_modules/, .git/, *.asar.
  - Allowed extensions to edit: .js, .ts, .html, .css, .md, .json (but NOT package-lock.json).
  - Only edit files listed in \`instructionsForFixAgent.filesToEdit\` unless you find a clear
    additional dependency. If you add a file, include it in the \`changes\` array with a
    "new file" unified diff header (\`--- /dev/null\` / \`+++ b/path\`).
  - Keep the change minimal. Do not reformat or refactor unrelated code.
  - \`branchSuggestion\` must NOT be 'main', 'master', 'develop', or 'production'. Use
    'fix/<slug>' where slug is kebab-case, 2-5 words, derived from the issue.
  - Prefer fixing the smallest unit: one file if possible, two or three if needed.
  - If you discover the fix is not localized, RETURN an empty \`changes\` array and set
    \`summary\` to explain why the fix is out of scope for this pass.`;

// ────────────────────────────────────────────────────────────────────────────
// User prompt builders
// ────────────────────────────────────────────────────────────────────────────

function _buildDiagnosePrompt({ userMessage, errorContext, recentLogs, sourceOverview }) {
  const lines = [];
  lines.push("ISSUE (user's words):");
  lines.push(String(userMessage || '').slice(0, 2000) || '(no user message)');
  lines.push('');

  if (errorContext && (errorContext.message || errorContext.category)) {
    lines.push('ERROR CONTEXT:');
    if (errorContext.message) lines.push(`  Message: ${String(errorContext.message).slice(0, 1500)}`);
    if (errorContext.category) lines.push(`  Category: ${errorContext.category}`);
    if (errorContext.source) lines.push(`  Source: ${errorContext.source}`);
    if (errorContext.agentId) lines.push(`  Agent: ${errorContext.agentId}`);
    if (errorContext.data && typeof errorContext.data === 'object') {
      try {
        lines.push('  Data: ' + JSON.stringify(errorContext.data).slice(0, 400));
      } catch {
        /* non-serializable */
      }
    }
    lines.push('');
  }

  if (Array.isArray(recentLogs) && recentLogs.length) {
    lines.push('RECENT LOG ENTRIES (newest last):');
    for (const entry of recentLogs.slice(-30)) {
      const ts = (entry.timestamp || '').slice(11, 19);
      const lvl = (entry.level || 'info').slice(0, 5);
      const msg = String(entry.message || '').slice(0, 220);
      lines.push(`  ${ts} [${lvl}] [${entry.category || '-'}] ${msg}`);
    }
    lines.push('');
  }

  if (sourceOverview) {
    lines.push('SOURCE-OVERVIEW (use these file paths and the Read/Grep tools to investigate):');
    lines.push(`  repoRoot: ${sourceOverview.repoRoot}`);
    if (Array.isArray(sourceOverview.keyFiles)) {
      lines.push('  keyFiles:');
      for (const kf of sourceOverview.keyFiles) {
        lines.push(`    - ${kf.path}: ${kf.description}`);
      }
    }
    if (Array.isArray(sourceOverview.agents) && sourceOverview.agents.length) {
      lines.push(`  builtInAgents (${sourceOverview.agents.length}): ${sourceOverview.agents.join(', ')}`);
    }
    lines.push('');
  }

  lines.push(
    'Investigate the most likely areas using Read/Grep/Glob and then return the JSON object per the system prompt.'
  );
  return lines.join('\n');
}

function _buildFixPrompt(diagnosis) {
  const lines = [];
  lines.push('Diagnosis from the triage agent:');
  lines.push(JSON.stringify(diagnosis, null, 2).slice(0, 6000));
  lines.push('');
  lines.push(
    'Read the files referenced in instructionsForFixAgent.filesToEdit, inspect them with Grep/Glob if you need more context, and then return your proposed changes as unified diffs per the system prompt. Keep the change minimal and focused on the root cause.'
  );
  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// JSON extraction
// ────────────────────────────────────────────────────────────────────────────

function _extractJson(text) {
  if (!text) return null;
  const s = String(text).trim();
  if (s.startsWith('{')) return s;
  const fence = s.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fence) return fence[1];
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) return s.slice(first, last + 1);
  return null;
}

function _safeParse(text) {
  try {
    const raw = _extractJson(text);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Diff validation / patch assembly
// ────────────────────────────────────────────────────────────────────────────

/**
 * Reject changes that touch disallowed paths or have malformed diff headers.
 * Returns an array of validation errors; empty means the change set is safe
 * to write to a patch file.
 */
function validateChanges(changes) {
  const errors = [];
  if (!Array.isArray(changes) || changes.length === 0) {
    errors.push('No changes to validate.');
    return errors;
  }

  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const p = String(c?.path || '').trim();
    if (!p) {
      errors.push(`Change #${i + 1}: missing path.`);
      continue;
    }
    if (p.startsWith('/') || p.includes('..')) {
      errors.push(`Change #${i + 1}: path "${p}" must be relative and must not contain '..'.`);
      continue;
    }
    for (const re of DENIED_FIX_PATHS) {
      if (re.test(p)) {
        errors.push(`Change #${i + 1}: path "${p}" is on the deny list.`);
        break;
      }
    }
    const ext = path.extname(p).toLowerCase();
    if (ext && !ALLOWED_FIX_EXTENSIONS.has(ext)) {
      errors.push(`Change #${i + 1}: extension "${ext}" is not allowed for automated edits.`);
    }
    const diff = String(c?.unifiedDiff || '');
    if (!diff) {
      errors.push(`Change #${i + 1}: missing unifiedDiff.`);
      continue;
    }
    // Require the standard `--- a/... +++ b/...` header (or `/dev/null` for new files).
    if (!/^(---|diff --git )/m.test(diff) || !/^\+\+\+ /m.test(diff)) {
      errors.push(`Change #${i + 1}: diff is missing unified-diff headers.`);
    }
  }
  return errors;
}

/**
 * Assemble a single combined .patch file from an array of changes. The output
 * is what `git apply patch.diff` expects.
 */
function assemblePatch(changes) {
  const parts = [];
  for (const c of changes) {
    let diff = String(c.unifiedDiff || '');
    // Ensure each file section ends with a newline so `git apply` is happy.
    if (!diff.endsWith('\n')) diff += '\n';
    parts.push(diff);
  }
  return parts.join('');
}

function sanitizeBranchSuggestion(suggestion, fallback) {
  const raw = String(suggestion || '').trim();
  const slug =
    raw
      .toLowerCase()
      .replace(/^refs\/heads\//, '')
      .replace(/[^a-z0-9/_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || fallback;
  const [first] = slug.split('/');
  if (PROTECTED_BRANCHES.has(first) || PROTECTED_BRANCHES.has(slug)) {
    return fallback;
  }
  if (!slug.startsWith('fix/') && !slug.startsWith('feat/') && !slug.startsWith('chore/')) {
    return `fix/${slug}`;
  }
  return slug;
}

// ────────────────────────────────────────────────────────────────────────────
// Claude Code calls
// ────────────────────────────────────────────────────────────────────────────

async function _callClaudeCode({ prompt, systemPrompt, budget, timeoutMs, feature, allowedTools }) {
  const runner = _resolveClaudeRunner();
  if (!runner || typeof runner.runClaudeCode !== 'function') {
    throw new Error('Claude Code runner is not available');
  }
  const avail = typeof runner.isClaudeCodeAvailable === 'function' ? await runner.isClaudeCodeAvailable() : null;
  if (avail && avail.available === false) {
    throw new Error('Claude Code is not installed on this machine');
  }

  const result = await runner.runClaudeCode(prompt, {
    systemPrompt,
    enableTools: true,
    allowedTools: allowedTools || ['Read', 'Grep', 'Glob'],
    maxBudget: budget,
    maxTurns: 6,
    feature: feature || 'app-issue-agent',
    timeout: timeoutMs,
    cwd: _getRepoRoot(),
  });

  if (!result?.success) {
    throw new Error(result?.error || 'Claude Code returned a failure result');
  }
  const body = result.result || result.output || '';
  const parsed = _safeParse(body);
  if (!parsed) {
    throw new Error('Claude Code did not return valid JSON');
  }
  return { parsed, usage: result.usage };
}

// ────────────────────────────────────────────────────────────────────────────
// Stage A: diagnose
// ────────────────────────────────────────────────────────────────────────────

/**
 * Run the diagnostic agent.
 *
 * @param {Object} issue   { userMessage, errorContext? }
 * @param {Object} options
 * @param {boolean} [options.skipCache=false]
 * @param {Array}   [options.recentLogs]        Optional pre-fetched log entries.
 * @returns {Promise<{ diagnosis, cached, source }>}
 */
async function diagnose(issue = {}, options = {}) {
  const key = _diagCacheKey(issue);
  if (!options.skipCache) {
    const cached = _diagCacheGet(key);
    if (cached) return { ...cached, cached: true };
  }

  if (_overBudget(DIAGNOSE_BUDGET_USD)) {
    return {
      diagnosis: null,
      cached: false,
      source: 'fallback',
      error: 'Daily AI budget is exhausted; diagnosis skipped.',
      degraded: 'budget-exceeded',
    };
  }

  const recentLogs =
    Array.isArray(options.recentLogs) && options.recentLogs.length
      ? options.recentLogs
      : _recentLogs({ category: issue.errorContext?.category });
  const sourceOverview = getCachedSourceOverview();

  const prompt = _buildDiagnosePrompt({
    userMessage: issue.userMessage,
    errorContext: issue.errorContext,
    recentLogs,
    sourceOverview,
  });

  try {
    const { parsed, usage } = await _callClaudeCode({
      prompt,
      systemPrompt: DIAGNOSE_SYSTEM_PROMPT,
      budget: DIAGNOSE_BUDGET_USD,
      timeoutMs: DIAGNOSE_TIMEOUT_MS,
      feature: 'app-issue-agent:diagnose',
      allowedTools: ['Read', 'Grep', 'Glob'],
    });
    const diagnosis = _normalizeDiagnosis(parsed);
    const out = { diagnosis, cached: false, source: 'claude-code', usage };
    _diagCacheSet(key, out);
    return out;
  } catch (err) {
    log.warn('app', 'app-issue-agent: diagnose failed', { error: err.message });
    return {
      diagnosis: null,
      cached: false,
      source: 'error',
      error: err.message || String(err),
    };
  }
}

function _normalizeDiagnosis(raw) {
  return {
    summary: String(raw?.summary || '').trim(),
    rootCause: String(raw?.rootCause || '').trim(),
    severity: ['low', 'medium', 'high'].includes(raw?.severity) ? raw.severity : 'medium',
    affectedFiles: Array.isArray(raw?.affectedFiles)
      ? raw.affectedFiles.slice(0, 20).map((f) => ({
          path: String(f?.path || ''),
          lines: String(f?.lines || ''),
          why: String(f?.why || ''),
        }))
      : [],
    reproSteps: Array.isArray(raw?.reproSteps) ? raw.reproSteps.slice(0, 10).map(String) : [],
    userFacingSteps: Array.isArray(raw?.userFacingSteps) ? raw.userFacingSteps.slice(0, 6).map(String) : [],
    instructionsForFixAgent: raw?.instructionsForFixAgent && typeof raw.instructionsForFixAgent === 'object'
      ? {
          goal: String(raw.instructionsForFixAgent.goal || ''),
          filesToEdit: Array.isArray(raw.instructionsForFixAgent.filesToEdit)
            ? raw.instructionsForFixAgent.filesToEdit.slice(0, 10).map(String)
            : [],
          approach: String(raw.instructionsForFixAgent.approach || ''),
          verification: Array.isArray(raw.instructionsForFixAgent.verification)
            ? raw.instructionsForFixAgent.verification.slice(0, 8).map(String)
            : [],
          risks: Array.isArray(raw.instructionsForFixAgent.risks)
            ? raw.instructionsForFixAgent.risks.slice(0, 8).map(String)
            : [],
        }
      : null,
    canAutoFix: raw?.canAutoFix === true,
    confidence:
      typeof raw?.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : 0.5,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Stage B: propose fix
// ────────────────────────────────────────────────────────────────────────────

/**
 * Ask Claude Code to propose a concrete patch for the given diagnosis.
 *
 * Returns a fix proposal that the caller can then save as a .patch file or
 * apply to a fresh branch. The proposal is NEVER applied to the working tree
 * here; callers do that explicitly via applyFix() or via the HUD UI.
 *
 * @returns {Promise<{ fix, error?, degraded? }>}
 */
async function proposeFix(diagnosis, options = {}) {
  if (!isFixStageEnabled()) {
    return {
      fix: null,
      error: 'Automatic fix generation is disabled in this build. Set ONEREACH_AUTOFIX=1 to enable.',
      degraded: 'feature-gated',
    };
  }
  if (!diagnosis || typeof diagnosis !== 'object') {
    return { fix: null, error: 'A valid diagnosis is required to propose a fix.' };
  }
  if (diagnosis.canAutoFix === false && !options.force) {
    return {
      fix: null,
      error: 'The diagnosis flagged this issue as NOT safely auto-fixable. Pass { force: true } to override.',
      degraded: 'not-auto-fixable',
    };
  }

  if (_overBudget(PROPOSE_FIX_BUDGET_USD)) {
    return {
      fix: null,
      error: 'Daily AI budget is exhausted; fix proposal skipped.',
      degraded: 'budget-exceeded',
    };
  }

  try {
    const { parsed, usage } = await _callClaudeCode({
      prompt: _buildFixPrompt(diagnosis),
      systemPrompt: PROPOSE_FIX_SYSTEM_PROMPT,
      budget: PROPOSE_FIX_BUDGET_USD,
      timeoutMs: PROPOSE_FIX_TIMEOUT_MS,
      feature: 'app-issue-agent:propose-fix',
      allowedTools: ['Read', 'Grep', 'Glob'],
    });

    const changes = Array.isArray(parsed?.changes) ? parsed.changes : [];
    const validationErrors = changes.length ? validateChanges(changes) : ['No changes proposed.'];

    const fallbackSlug = `issue-${Date.now().toString(36)}`;
    const branch = sanitizeBranchSuggestion(parsed?.branchSuggestion, `fix/${fallbackSlug}`);

    const fix = {
      summary: String(parsed?.summary || ''),
      changes: changes.map((c) => ({
        path: String(c?.path || ''),
        reasoning: String(c?.reasoning || ''),
        unifiedDiff: String(c?.unifiedDiff || ''),
      })),
      patch: changes.length ? assemblePatch(changes) : '',
      branchSuggestion: branch,
      commitMessage: String(parsed?.commitMessage || '').slice(0, 4000),
      prDescription: String(parsed?.prDescription || '').slice(0, 8000),
      verificationPlan: Array.isArray(parsed?.verificationPlan)
        ? parsed.verificationPlan.slice(0, 10).map(String)
        : [],
      validationErrors,
      usage,
    };
    return { fix };
  } catch (err) {
    log.warn('app', 'app-issue-agent: proposeFix failed', { error: err.message });
    return { fix: null, error: err.message || String(err) };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Saving the patch
// ────────────────────────────────────────────────────────────────────────────

/**
 * Write the fix proposal's patch to disk (for the user to review and apply).
 * Does NOT touch git or the working tree.
 *
 * @param {Object} fix            From proposeFix()
 * @param {Object} [options]
 * @param {string} [options.destination]  Defaults to <repo>/.cursor/patches/fix-<id>.patch
 * @returns {Promise<{ path, bytes, branch }>}
 */
async function savePatch(fix, options = {}) {
  if (!fix || !fix.patch) {
    throw new Error('Fix proposal has no patch content to save.');
  }
  if (Array.isArray(fix.validationErrors) && fix.validationErrors.length) {
    throw new Error(`Patch has validation errors: ${fix.validationErrors.join('; ')}`);
  }

  const root = _getRepoRoot();
  const destDir = options.destinationDir || path.join(root, '.cursor', 'patches');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeBranch = (fix.branchSuggestion || 'fix').replace(/[^a-z0-9_-]+/gi, '_');
  const file = options.destination || path.join(destDir, `${stamp}-${safeBranch}.patch`);

  await fs.promises.mkdir(path.dirname(file), { recursive: true });

  const header = [
    `# Proposed fix: ${fix.summary}`,
    `# Branch:         ${fix.branchSuggestion}`,
    '# Generated by:   app-issue-agent',
    `# Generated at:   ${new Date().toISOString()}`,
    '#',
    '# To apply:',
    `#   git checkout -b ${fix.branchSuggestion}`,
    `#   git apply "${file}"`,
    `#   git add -A && git commit -m ${JSON.stringify((fix.commitMessage || fix.summary).split('\n')[0])}`,
    '',
  ].join('\n');

  const contents = header + '\n' + fix.patch;
  await fs.promises.writeFile(file, contents, 'utf8');
  const stat = await fs.promises.stat(file);

  return { path: file, bytes: stat.size, branch: fix.branchSuggestion };
}

// ────────────────────────────────────────────────────────────────────────────
// Orchestrator: reportIssue()
// The entry point any function in the app can call.
// ────────────────────────────────────────────────────────────────────────────

/**
 * High-level entry point. Runs diagnose(); if the caller requests and the
 * environment allows, also runs proposeFix() and optionally saves the patch.
 *
 * @param {Object} input
 * @param {string} input.userMessage       Required. The user's plain description.
 * @param {Object} [input.errorContext]    Optional error object (same shape as diagnostics:diagnose).
 * @param {Object} [options]
 * @param {boolean} [options.proposeFix=false]
 * @param {boolean} [options.savePatch=false]
 * @param {boolean} [options.forceFix=false]   Override canAutoFix=false.
 * @returns {Promise<{ diagnosis, fix?, patchPath?, status, error? }>}
 */
async function reportIssue(input = {}, options = {}) {
  if (!input.userMessage && !input.errorContext?.message) {
    return { status: 'error', error: 'A userMessage or errorContext.message is required.' };
  }

  const diagResult = await diagnose(input, options);
  if (!diagResult.diagnosis) {
    return {
      status: 'diagnose-failed',
      error: diagResult.error || 'Diagnosis returned no output.',
      degraded: diagResult.degraded,
    };
  }

  const out = {
    status: 'diagnosed',
    diagnosis: diagResult.diagnosis,
    cached: diagResult.cached,
  };

  if (!options.proposeFix) return out;

  const fixResult = await proposeFix(diagResult.diagnosis, { force: options.forceFix });
  if (!fixResult.fix) {
    out.status = 'fix-unavailable';
    out.error = fixResult.error;
    out.degraded = fixResult.degraded;
    return out;
  }

  out.fix = fixResult.fix;
  out.status = 'fix-proposed';

  if (options.savePatch) {
    try {
      const saved = await savePatch(fixResult.fix);
      out.patchPath = saved.path;
      out.patchBytes = saved.bytes;
      out.status = 'patch-saved';
    } catch (err) {
      out.error = err.message || String(err);
      out.status = 'fix-proposed'; // diagnosis + fix are still good
    }
  }

  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Status helper -- renderer uses this to decide whether to show UI.
// ────────────────────────────────────────────────────────────────────────────

async function getStatus() {
  const claudeReady = await isClaudeCodeAvailable();
  return {
    available: claudeReady, // diagnose stage works when claude-code is installed
    fixStageEnabled: isFixStageEnabled() && claudeReady,
    claudeCodeInstalled: claudeReady,
    devMode: isFixStageEnabled(),
    repoRoot: _getRepoRoot(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Test-only injection hooks
// ────────────────────────────────────────────────────────────────────────────

function _setClaudeRunner(runner) {
  _injectedClaudeRunner = runner;
}
function _setBudgetManager(mgr) {
  _injectedBudgetManager = mgr;
}
function _setElectronApp(app) {
  _injectedElectronApp = app;
}
function _resetInjections() {
  _injectedClaudeRunner = null;
  _injectedBudgetManager = null;
  _injectedElectronApp = null;
}
function _clearCache() {
  _diagCache.clear();
  _cachedSourceOverview = null;
}

module.exports = {
  // Public API
  reportIssue,
  diagnose,
  proposeFix,
  savePatch,
  getStatus,
  isFixStageEnabled,
  isClaudeCodeAvailable,

  // Helpers (used by tests and UI)
  validateChanges,
  assemblePatch,
  sanitizeBranchSuggestion,
  getCachedSourceOverview,

  // Test-only hooks
  _setClaudeRunner,
  _setBudgetManager,
  _setElectronApp,
  _resetInjections,
  _clearCache,

  // Constants exposed for the UI
  DIAGNOSE_BUDGET_USD,
  PROPOSE_FIX_BUDGET_USD,
  ALLOWED_FIX_EXTENSIONS,
  DENIED_FIX_PATHS,
  PROTECTED_BRANCHES,
};
