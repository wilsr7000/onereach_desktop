/**
 * Playbook Executor Service
 *
 * Executes playbooks within Spaces using Claude Code CLI.
 * Exposes a job-based async API with pause/resume for human-in-the-loop.
 *
 * Flow:
 * 1. Load space context (playbook, data sources, assets)
 * 2. Prepare temp working directory with assets + manifests
 * 3. Build system prompt with playbook, data source configs, asset list
 * 4. Execute via modernized claude-code-runner (spawn, stream-json)
 * 5. Detect _pause.json for human-in-the-loop questions
 * 6. Collect outputs (_results.json), store back into space
 * 7. Commit + sync to graph via spaces-sync
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getLogQueue } = require('./log-event-queue');
const { renderAgentUI } = require('./agent-ui-renderer');
const log = getLogQueue();

// ---------------------------------------------------------------------------
// Dependency getters (overridable for testing)
// ---------------------------------------------------------------------------

/** @type {Function|null} */
let _spacesAPIFactory = null;
/** @type {Function|null} */
let _claudeCodeFactory = null;
/** @type {Function|null} */
let _syncFactory = null;

function _getSpacesAPI() {
  if (_spacesAPIFactory) return _spacesAPIFactory();
  const { getSpacesAPI } = require('../spaces-api');
  return getSpacesAPI();
}

function _getClaudeCode() {
  if (_claudeCodeFactory) return _claudeCodeFactory();
  return require('./claude-code-runner');
}

function _getSync() {
  if (_syncFactory) return _syncFactory();
  return require('./spaces-sync');
}

/**
 * Override dependencies for testing.
 * @param {{ spacesAPI?: Function, claudeCode?: Function, sync?: Function }} deps
 */
function _setTestDeps(deps) {
  if (deps.spacesAPI) _spacesAPIFactory = deps.spacesAPI;
  if (deps.claudeCode) _claudeCodeFactory = deps.claudeCode;
  if (deps.sync) _syncFactory = deps.sync;
}

function _clearTestDeps() {
  _spacesAPIFactory = null;
  _claudeCodeFactory = null;
  _syncFactory = null;
}

function _clearJobs() {
  _jobs.clear();
}

// ---------------------------------------------------------------------------
// Job store (in-memory with disk persistence)
// ---------------------------------------------------------------------------

/** @type {Map<string, Object>} */
const _jobs = new Map();

/** @type {string} */
const PERSIST_PATH = path.join(os.tmpdir(), 'playbook-executor-jobs.json');

/** Persist jobs to disk periodically */
function _persistJobs() {
  try {
    const serializable = {};
    for (const [id, job] of _jobs) {
      serializable[id] = { ...job, _process: undefined };
    }
    fs.writeFileSync(PERSIST_PATH, JSON.stringify(serializable, null, 2));
  } catch (_) {
    /* best effort */
  }
}

/** Load persisted jobs on startup */
function _loadPersistedJobs() {
  try {
    if (fs.existsSync(PERSIST_PATH)) {
      const data = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf8'));
      for (const [id, job] of Object.entries(data)) {
        // Only restore terminal states (completed/failed/cancelled) for history
        if (['completed', 'failed', 'cancelled'].includes(job.status)) {
          _jobs.set(id, job);
        }
      }
    }
  } catch (_) {
    /* best effort */
  }
}

// Load persisted jobs at require-time
_loadPersistedJobs();

// Persist every 30s
const _persistInterval = setInterval(_persistJobs, 30000);
if (_persistInterval.unref) _persistInterval.unref();

// ---------------------------------------------------------------------------
// Playbook detection helpers
// ---------------------------------------------------------------------------

/**
 * Heuristically detect if a space item is a playbook.
 */
function _isPlaybook(item) {
  const content = (item.content || '').toLowerCase();
  const title = (item.metadata?.title || item.fileName || '').toLowerCase();
  const tags = item.tags || item.metadata?.tags || [];

  // Tagged as playbook
  if (tags.some((t) => typeof t === 'string' && t.toLowerCase().includes('playbook'))) return true;

  // Title contains playbook
  if (title.includes('playbook')) return true;

  // Content markers
  if (item.metadata?._playbookNoteId || item.metadata?.playbookNoteId) return true;
  if (content.includes('[playbook:')) return true;

  // Has structured framework
  try {
    const parsed = JSON.parse(item.content);
    if (parsed.framework && parsed.framework.phases) return true;
  } catch (_ignored) {
    /* not valid JSON */
  }

  // Has step-like structure (## Steps, numbered list with ** bold)
  if (content.includes('## steps') && (content.includes('1.') || content.includes('- **'))) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Output type mapping
// ---------------------------------------------------------------------------

function _mapOutputTypeToSpaceType(outputType, fileName) {
  const ext = path.extname(fileName).toLowerCase();

  if (outputType === 'ui' || outputType === 'dashboard') return 'html';
  if (outputType === 'document') return ext === '.html' ? 'html' : 'text';
  if (outputType === 'data') return 'code';
  if (outputType === 'code') return 'code';
  if (outputType === 'image') return 'image';

  const extMap = {
    '.html': 'html',
    '.htm': 'html',
    '.md': 'text',
    '.txt': 'text',
    '.json': 'code',
    '.csv': 'code',
    '.js': 'code',
    '.py': 'code',
    '.sh': 'code',
    '.ts': 'code',
    '.png': 'image',
    '.jpg': 'image',
    '.svg': 'image',
    '.pdf': 'pdf',
  };
  return extMap[ext] || 'file';
}

function _isLikelyBinary(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.tar', '.gz'].includes(ext);
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function _buildSystemPrompt(playbook, assetManifest, apiSources, mcpSources) {
  const apiSection =
    apiSources.length > 0
      ? `### API Data Sources
These are external APIs you can query using curl. Read _data-sources.json for full configs.
${apiSources
  .map(
    (ds) => `
**${ds.name}**
- Base URL: ${ds.baseUrl}
- Protocol: ${ds.protocol || 'rest'}
- Auth: ${ds.auth?.type || 'none'}${ds.auth?.type === 'api-key' ? ` (header: ${ds.auth.headerName})` : ''}
- Operations: ${
      Object.entries(ds.operations || {})
        .filter(([, v]) => v.enabled)
        .map(([k, v]) => `${k} -> ${v.method} ${v.endpoint}`)
        .join(', ') || 'see docs'
    }
${ds.docs ? `- Docs: ${ds.docs.slice(0, 200)}...` : ''}
`
  )
  .join('\n')}

To query an API source, use curl. Credentials are NOT stored -- if auth is required, note it in the results.
For GraphQL sources, use POST with a JSON body containing { "query": "..." }.`
      : 'No API data sources configured.';

  const mcpSection =
    mcpSources.length > 0
      ? `### MCP Data Sources (connected via --mcp-config)
MCP tools are available directly. Use them to query the graph for tickets.
${mcpSources.map((m) => `- ${m.serverName} (${m.transport || 'stdio'})`).join('\n')}`
      : '';

  const playbookContent =
    typeof playbook.content === 'string' ? playbook.content : JSON.stringify(playbook.content, null, 2);

  return `You are a playbook executor. A Space has been loaded with a playbook, data sources, and assets. Your job is to execute the playbook.

## Playbook
${playbook.title ? `### ${playbook.title}` : ''}
${playbookContent}

## Data Sources (how to get tickets and external data)
${apiSection}
${mcpSection}

## Available Assets (in working directory)
${assetManifest.map((a) => `- ${a.name} (${a.type}${a.preview ? ': ' + a.preview : ''})`).join('\n') || 'No assets.'}

## Execution Instructions
1. Read and understand the playbook.
2. Connect to data sources to pull tickets/data as the playbook requires.
3. For each ticket: execute the task defined by the playbook, using assets as needed.
4. Produce whatever outputs the playbook calls for.

## Output Capabilities
You can produce ANY of these output types -- the playbook determines what you create:

- **UI / Dashboard**: Self-contained HTML (.html) with inline CSS/JS. No external CDN. Responsive, dark/light aware.
- **Documents**: Markdown (.md), HTML (.html), plain text (.txt).
- **Data**: JSON (.json), CSV (.csv) for structured results, API responses, transformed data.
- **Code**: Source files (.js, .py, .sh, etc.) for generated scripts or automations.
- **Multiple outputs**: Create as many files as needed. Each becomes a separate item in the space.
- **Mixed**: A single execution can produce dashboards AND documents AND data.

Write ALL outputs to the working directory with descriptive filenames.
For HTML outputs: make them self-contained, responsive, and visually polished.

## Pausing for User Input
If you encounter an ambiguity that requires human judgment, write a _pause.json file and stop:

{
  "questions": [
    {
      "id": "q1",
      "question": "Your question here",
      "options": ["Option A", "Option B"],
      "context": "Why you are asking"
    }
  ]
}

Then exit gracefully. The executor will resume you with the answer.

## Final Report
After completing all work, write _results.json:

{
  "tickets": [
    {
      "id": "ticket-id-from-graph",
      "title": "Ticket title",
      "status": "done|skipped|failed",
      "output": "What was done for this ticket"
    }
  ],
  "outputs": [
    {
      "file": "dashboard.html",
      "type": "dashboard",
      "title": "Revenue Dashboard",
      "description": "Interactive dashboard showing Q1 metrics",
      "render": true,
      "ticketId": "ticket-id"
    },
    {
      "file": "report.md",
      "type": "document",
      "title": "Q1 Analysis Report"
    }
  ],
  "summary": "One-paragraph summary of what was accomplished."
}

Output type values: ui, dashboard, document, data, code, image, other.
Set "render": true on any HTML output that should be opened/displayed immediately.
Link outputs to tickets via "ticketId" when applicable.

## Constraints
- Stay within the working directory.
- Do not install packages without explicit playbook instruction.
- If a step fails, note the error and continue with the next step.
- If you need information not in the assets, say so in the results.
- For API calls: use curl or built-in fetch. Store responses as data files.`;
}

// ---------------------------------------------------------------------------
// Core executor
// ---------------------------------------------------------------------------

/**
 * Start a playbook execution job.
 *
 * @param {Object} opts
 * @param {string}   opts.spaceId        - Space containing the playbook and assets
 * @param {string}   [opts.playbookId]   - Specific playbook item ID (auto-detects if omitted)
 * @param {string}   [opts.context]      - Additional context to pass to Claude
 * @param {string[]} [opts.allowedTools] - Claude Code tools to allow
 * @param {number}   [opts.maxTurns]     - Max agentic turns (default: 20)
 * @param {number}   [opts.maxBudget]    - Max cost in USD (default: 2.00)
 * @param {string}   [opts.model]        - Model alias (default: sonnet)
 * @param {string}   [opts.feature]      - Cost tracking label
 * @param {Function} [opts.onProgress]   - Progress callback
 * @returns {Promise<Object>} Job state with jobId, status
 */
async function startJob(opts) {
  const {
    spaceId,
    playbookId,
    context,
    allowedTools = ['Bash', 'Read', 'Write', 'Edit'],
    maxTurns = 20,
    maxBudget = 2.0,
    model = 'sonnet',
    feature = 'playbook-executor',
    onProgress,
  } = opts;

  if (!spaceId) throw new Error('spaceId is required');

  const jobId = crypto.randomUUID();

  // Create job state
  const job = {
    jobId,
    spaceId,
    playbookId: playbookId || null,
    status: 'running',
    sessionId: null,
    workDir: null,
    requestId: null,
    progress: {
      currentStep: 'Loading space context',
      stepsCompleted: 0,
      ticketsProcessed: 0,
      ticketsTotal: 0,
      lastEvent: '',
    },
    pendingQuestions: [],
    tickets: [],
    outputs: [],
    usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  _jobs.set(jobId, job);

  // Run execution asynchronously
  _executeJob(job, { context, allowedTools, maxTurns, maxBudget, model, feature, onProgress }).catch((err) => {
    job.status = 'failed';
    job.error = err.message;
    job.updatedAt = new Date().toISOString();
    log.error('playbook', 'Job failed', { jobId, error: err.message });
  });

  return { jobId, status: job.status };
}

/**
 * Internal: run the full execution pipeline for a job.
 */
async function _executeJob(job, opts) {
  const { context, allowedTools, maxTurns, maxBudget, model, feature, onProgress } = opts;
  const { spaceId, playbookId } = job;

  const _emit = (data) => {
    job.updatedAt = new Date().toISOString();
    if (onProgress) {
      try {
        onProgress({ jobId: job.jobId, ...data });
      } catch (_ignored) {
        /* onProgress callback threw */
      }
    }
  };

  try {
    // ---- Step 1: Load space context ----
    const spacesAPI = _getSpacesAPI();

    const allItems = await spacesAPI.items.list(spaceId, { includeContent: false });
    if (!allItems || allItems.length === 0) {
      throw new Error(`Space ${spaceId} has no items`);
    }

    // Find playbook
    let playbookItem;
    if (playbookId) {
      playbookItem = await spacesAPI.items.get(spaceId, playbookId);
      if (!playbookItem) throw new Error(`Playbook item ${playbookId} not found`);
    } else {
      const playbooks = allItems.filter(_isPlaybook);
      if (playbooks.length === 0)
        throw new Error(
          'No playbook found in space. Tag an item with "playbook" or include "## Steps" in the content.'
        );
      playbookItem = await spacesAPI.items.get(spaceId, playbooks[0].id);
    }
    job.playbookId = playbookItem.id;

    _emit({
      type: 'progress',
      step: 'Space context loaded',
      detail: `Found ${allItems.length} items, playbook: ${playbookItem.metadata?.title || playbookItem.id}`,
    });
    job.progress.currentStep = 'Preparing execution environment';

    // Categorize items
    const dataSources = allItems.filter((i) => i.type === 'data-source');
    const assets = allItems.filter((i) => i.type !== 'data-source' && i.id !== playbookItem.id);

    // ---- Step 2: Prepare data source configs ----
    const mcpSources = [];
    const apiSources = [];

    for (const ds of dataSources) {
      try {
        const loaded = await spacesAPI.items.get(spaceId, ds.id);
        const config = typeof loaded.content === 'string' ? JSON.parse(loaded.content) : loaded.content;

        if (config.sourceType === 'mcp' && config.mcp) {
          mcpSources.push({
            serverName: config.mcp.serverName || ds.id,
            transport: config.mcp.transport || 'stdio',
            command: config.mcp.command,
            args: config.mcp.args,
            env: config.mcp.env,
          });
        } else if (config.sourceType === 'api') {
          apiSources.push({
            name: loaded.metadata?.title || ds.fileName || ds.id,
            baseUrl: config.connection?.url,
            protocol: config.connection?.protocol || 'rest',
            method: config.connection?.method || 'GET',
            headers: config.connection?.headers || {},
            auth: config.auth || { type: 'none' },
            operations: config.operations || {},
            docs: config.document?.content || '',
          });
        }
      } catch (err) {
        log.warn('playbook', 'Failed to load data source', { id: ds.id, error: err.message });
      }
    }

    // ---- Step 3: Prepare working directory ----
    const workDir = path.join(os.tmpdir(), `playbook-exec-${job.jobId}`);
    fs.mkdirSync(workDir, { recursive: true });
    job.workDir = workDir;

    const originalAssetNames = new Set();
    const assetManifest = [];

    for (const item of assets) {
      try {
        const loaded = await spacesAPI.items.get(spaceId, item.id);
        const name = item.fileName || loaded.metadata?.title?.replace(/[^a-zA-Z0-9._-]/g, '_') || `${item.id}.txt`;
        const safeName = name.length > 100 ? name.substring(0, 100) : name;

        if (loaded.content && typeof loaded.content === 'string' && !loaded.content.startsWith('/')) {
          fs.writeFileSync(path.join(workDir, safeName), loaded.content);
          originalAssetNames.add(safeName);
        }

        assetManifest.push({
          name: safeName,
          type: item.type,
          fileType: item.fileType || null,
          tags: item.tags || item.metadata?.tags || [],
          preview: (loaded.content || '').substring(0, 80),
        });
      } catch (err) {
        log.warn('playbook', 'Failed to copy asset', { id: item.id, error: err.message });
      }
    }

    // Write manifests
    fs.writeFileSync(path.join(workDir, '_assets.json'), JSON.stringify(assetManifest, null, 2));
    if (apiSources.length > 0) {
      fs.writeFileSync(path.join(workDir, '_data-sources.json'), JSON.stringify(apiSources, null, 2));
    }

    // Build MCP config
    let mcpConfig = null;
    if (mcpSources.length > 0) {
      mcpConfig = { mcpServers: {} };
      for (const mcp of mcpSources) {
        mcpConfig.mcpServers[mcp.serverName] = {
          command: mcp.command,
          args: mcp.args,
          env: mcp.env || {},
        };
      }
    }

    // ---- Step 4: Build system prompt ----
    const playbookData = {
      title: playbookItem.metadata?.title || 'Untitled Playbook',
      content: playbookItem.content,
    };
    const systemPrompt = _buildSystemPrompt(playbookData, assetManifest, apiSources, mcpSources);

    // ---- Step 5: Execute via Claude Code ----
    _emit({ type: 'progress', step: 'Executing playbook', detail: 'Claude Code started' });
    job.progress.currentStep = 'Executing playbook';

    const claudeCode = _getClaudeCode();

    const userPrompt = context
      ? `Execute the playbook as described in the system prompt.\n\nAdditional context: ${context}`
      : 'Execute the playbook as described in the system prompt.';

    const execResult = await claudeCode.runClaudeCode(userPrompt, {
      cwd: workDir,
      systemPrompt,
      enableTools: true,
      allowedTools,
      maxTurns,
      maxBudget,
      model,
      feature,
      mcpConfig,
      onStream: (event) => {
        // Forward stream events
        if (event.type === 'tool_use') {
          job.progress.lastEvent = `Tool: ${event.tool || 'unknown'}`;
        } else if (event.type === 'content_block_delta' || event.type === 'text') {
          job.progress.lastEvent = 'Generating...';
        }
        _emit({ type: 'stream', event });
      },
    });

    job.requestId = execResult.requestId;
    job.sessionId = execResult.sessionId || null;

    // Update usage
    if (execResult.usage) {
      job.usage = {
        inputTokens: execResult.usage.input_tokens || execResult.usage.inputTokens || 0,
        outputTokens: execResult.usage.output_tokens || execResult.usage.outputTokens || 0,
        cost: execResult.usage.cost || 0,
      };
    }

    // ---- Step 6: Check for pause ----
    const pausePath = path.join(workDir, '_pause.json');
    if (fs.existsSync(pausePath)) {
      try {
        const pauseData = JSON.parse(fs.readFileSync(pausePath, 'utf8'));
        job.pendingQuestions = (pauseData.questions || []).map((q) => ({
          id: q.id || crypto.randomUUID(),
          question: q.question,
          options: q.options || null,
          context: q.context || null,
        }));
        job.status = 'paused';
        job.progress.currentStep = 'Waiting for user input';
        _emit({ type: 'paused', questions: job.pendingQuestions });
        _persistJobs();
        return;
      } catch (err) {
        log.warn('playbook', 'Failed to parse _pause.json', { error: err.message });
      }
    }

    // ---- Step 7: Collect results ----
    if (!execResult.success) {
      job.status = 'failed';
      job.error = execResult.error || 'Claude Code execution failed';
      _emit({ type: 'failed', error: job.error });
      _persistJobs();
      return;
    }

    _emit({ type: 'progress', step: 'Collecting outputs', detail: 'Reading results' });
    job.progress.currentStep = 'Collecting outputs';

    let results = {};
    const resultsPath = path.join(workDir, '_results.json');
    try {
      if (fs.existsSync(resultsPath)) {
        results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
      }
    } catch (_) {
      results = { summary: execResult.output, tickets: [], outputs: [] };
    }

    job.tickets = results.tickets || [];
    job.progress.ticketsProcessed = job.tickets.filter((t) => t.status === 'done').length;
    job.progress.ticketsTotal = job.tickets.length;

    // ---- Step 8: Store outputs into space ----
    const declaredOutputs = results.outputs || [];
    const outputFiles = fs.readdirSync(workDir).filter((f) => !f.startsWith('_') && !originalAssetNames.has(f));

    const outputItems = [];

    for (const file of outputFiles) {
      try {
        const filePath = path.join(workDir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) continue;

        const declared = declaredOutputs.find((o) => o.file === file) || {};
        const isBinary = _isLikelyBinary(file);
        const content = isBinary ? filePath : fs.readFileSync(filePath, 'utf8');
        const spaceType = _mapOutputTypeToSpaceType(declared.type, file);

        const newItem = await spacesAPI.items.add(spaceId, {
          type: spaceType,
          content,
          fileName: file,
          tags: [
            'playbook-output',
            `execution:${job.jobId}`,
            declared.type ? `output-type:${declared.type}` : null,
          ].filter(Boolean),
          metadata: {
            source: 'playbook-executor',
            playbookId: job.playbookId,
            executionId: job.jobId,
            outputType: declared.type || 'other',
            title: declared.title || file,
            description: declared.description || '',
          },
        });

        const outputEntry = {
          id: newItem?.id || file,
          type: spaceType,
          fileName: file,
          outputType: declared.type || 'other',
          title: declared.title || file,
          render: declared.render || false,
          description: declared.description || '',
        };
        outputItems.push(outputEntry);

        // Emit render event for items marked render: true.
        // Content is wrapped through the declarative renderer for safe HTML output.
        if (declared.render && (declared.type === 'ui' || declared.type === 'dashboard')) {
          _emit({
            type: 'render',
            itemId: outputEntry.id,
            title: outputEntry.title,
            outputType: outputEntry.outputType,
            html: typeof content === 'string' ? renderAgentUI({ type: 'info', message: content }) : null,
          });
        }
      } catch (err) {
        log.warn('playbook', 'Failed to store output', { file, error: err.message });
      }
    }

    job.outputs = outputItems;

    // ---- Step 9: Commit + sync ----
    try {
      const spacesSync = _getSync();
      await spacesSync.push(spaceId, {
        message: `Playbook: ${playbookData.title} -- ${job.tickets.length} tickets, ${outputItems.length} outputs`,
        author: 'playbook-executor',
        assets: outputItems.map((item) => ({
          id: item.id,
          title: item.title,
          type: item.outputType,
        })),
        ticketUpdates: job.tickets.map((t) => ({
          id: t.id,
          status: t.status,
          output: t.output,
        })),
      });
    } catch (syncErr) {
      log.warn('playbook', 'Sync failed (non-fatal)', { error: syncErr.message });
    }

    // ---- Cleanup and complete ----
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (_ignored) {
      /* cleanup workDir (may already be gone) */
    }

    job.status = 'completed';
    job.progress.currentStep = 'Complete';
    job.updatedAt = new Date().toISOString();
    _emit({
      type: 'completed',
      summary: results.summary || execResult.output,
      outputs: outputItems,
      tickets: job.tickets,
    });
    _persistJobs();
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    job.updatedAt = new Date().toISOString();
    _emit({ type: 'failed', error: err.message });
    _persistJobs();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Respond (resume paused job)
// ---------------------------------------------------------------------------

/**
 * Respond to a paused job's question, resuming execution.
 */
async function respond(jobId, questionId, answer) {
  const job = _jobs.get(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.status !== 'paused') throw new Error(`Job ${jobId} is not paused (status: ${job.status})`);

  const question = job.pendingQuestions.find((q) => q.id === questionId);
  if (!question) throw new Error(`Question ${questionId} not found in job ${jobId}`);

  // Clean up pause file
  if (job.workDir) {
    try {
      fs.unlinkSync(path.join(job.workDir, '_pause.json'));
    } catch (_ignored) {
      /* unlink pause file (may already be gone) */
    }
  }

  // Resume execution
  job.status = 'running';
  job.pendingQuestions = [];
  job.progress.currentStep = 'Resuming with user answer';
  job.updatedAt = new Date().toISOString();

  const resumePrompt = `The user answered your question:
Q: "${question.question}"
A: "${answer}"

Continue executing the playbook from where you left off.`;

  const claudeCode = _getClaudeCode();

  // Re-run with --resume to continue the session
  _executeResumedJob(job, resumePrompt, claudeCode).catch((err) => {
    job.status = 'failed';
    job.error = err.message;
    job.updatedAt = new Date().toISOString();
    log.error('playbook', 'Resume failed', { jobId, error: err.message });
  });

  return { jobId, status: 'running' };
}

/**
 * Internal: resume a paused job.
 */
async function _executeResumedJob(job, resumePrompt, claudeCode) {
  const execResult = await claudeCode.runClaudeCode(resumePrompt, {
    cwd: job.workDir,
    sessionId: job.sessionId,
    enableTools: true,
    allowedTools: ['Bash', 'Read', 'Write', 'Edit'],
    maxTurns: 20,
    maxBudget: 2.0,
    feature: 'playbook-executor',
    onStream: (event) => {
      if (event.type === 'tool_use') {
        job.progress.lastEvent = `Tool: ${event.tool || 'unknown'}`;
      }
    },
  });

  job.sessionId = execResult.sessionId || job.sessionId;

  // Check for another pause
  const pausePath = path.join(job.workDir, '_pause.json');
  if (fs.existsSync(pausePath)) {
    try {
      const pauseData = JSON.parse(fs.readFileSync(pausePath, 'utf8'));
      job.pendingQuestions = (pauseData.questions || []).map((q) => ({
        id: q.id || crypto.randomUUID(),
        question: q.question,
        options: q.options || null,
        context: q.context || null,
      }));
      job.status = 'paused';
      job.progress.currentStep = 'Waiting for user input';
      _persistJobs();
      return;
    } catch (err) {
      console.warn('[playbook-executor] Parse pause file:', err.message);
    }
  }

  // Collect final results
  let results = {};
  const resultsPath = path.join(job.workDir, '_results.json');
  try {
    if (fs.existsSync(resultsPath)) {
      results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    }
  } catch (_) {
    results = { summary: execResult.output, tickets: [], outputs: [] };
  }

  job.tickets = results.tickets || job.tickets;
  job.status = execResult.success ? 'completed' : 'failed';
  if (!execResult.success) job.error = execResult.error;
  job.progress.currentStep = execResult.success ? 'Complete' : 'Failed';
  job.updatedAt = new Date().toISOString();

  // Store outputs (same as initial run)
  if (execResult.success && job.workDir && fs.existsSync(job.workDir)) {
    try {
      const spacesAPI = _getSpacesAPI();
      const declaredOutputs = results.outputs || [];
      const outputFiles = fs.readdirSync(job.workDir).filter((f) => !f.startsWith('_'));

      for (const file of outputFiles) {
        const filePath = path.join(job.workDir, file);
        if (fs.statSync(filePath).isDirectory()) continue;
        const declared = declaredOutputs.find((o) => o.file === file) || {};
        const content = _isLikelyBinary(file) ? filePath : fs.readFileSync(filePath, 'utf8');
        const spaceType = _mapOutputTypeToSpaceType(declared.type, file);

        const newItem = await spacesAPI.items.add(job.spaceId, {
          type: spaceType,
          content,
          fileName: file,
          tags: ['playbook-output', `execution:${job.jobId}`].filter(Boolean),
          metadata: {
            source: 'playbook-executor',
            playbookId: job.playbookId,
            executionId: job.jobId,
            outputType: declared.type || 'other',
            title: declared.title || file,
          },
        });

        job.outputs.push({
          id: newItem?.id || file,
          type: spaceType,
          fileName: file,
          outputType: declared.type || 'other',
          title: declared.title || file,
          render: declared.render || false,
        });
      }
    } catch (err) {
      log.warn('playbook', 'Failed to store resumed outputs', { error: err.message });
    }
  }

  // Cleanup
  if (job.workDir) {
    try {
      fs.rmSync(job.workDir, { recursive: true, force: true });
    } catch (_ignored) {
      /* cleanup workDir (may already be gone) */
    }
  }

  _persistJobs();
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/**
 * Cancel a running or paused job.
 */
function cancel(jobId) {
  const job = _jobs.get(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed') {
    return { jobId, status: job.status };
  }

  // Kill the Claude Code process if running
  if (job.requestId) {
    const claudeCode = _getClaudeCode();
    claudeCode.cancelSession(job.requestId);
  }

  // Cleanup working directory
  if (job.workDir) {
    try {
      fs.rmSync(job.workDir, { recursive: true, force: true });
    } catch (_ignored) {
      /* cleanup workDir (may already be gone) */
    }
  }

  job.status = 'cancelled';
  job.updatedAt = new Date().toISOString();
  _persistJobs();

  return { jobId, status: 'cancelled' };
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Get a job by ID.
 */
function getJob(jobId) {
  const job = _jobs.get(jobId);
  if (!job) return null;
  // Return a clean copy without internal fields
  return {
    jobId: job.jobId,
    spaceId: job.spaceId,
    playbookId: job.playbookId,
    status: job.status,
    progress: job.progress,
    pendingQuestions: job.pendingQuestions,
    tickets: job.tickets,
    outputs: job.outputs,
    usage: job.usage,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/**
 * List jobs with optional filters.
 */
function listJobs(filters = {}) {
  let jobs = Array.from(_jobs.values());

  if (filters.spaceId) {
    jobs = jobs.filter((j) => j.spaceId === filters.spaceId);
  }
  if (filters.status) {
    jobs = jobs.filter((j) => j.status === filters.status);
  }

  // Sort by creation time descending
  jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const offset = filters.offset || 0;
  const limit = filters.limit || 50;

  return {
    jobs: jobs.slice(offset, offset + limit).map((j) => ({
      jobId: j.jobId,
      spaceId: j.spaceId,
      playbookId: j.playbookId,
      status: j.status,
      progress: j.progress,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    })),
    total: jobs.length,
  };
}

/**
 * Find playbook items in a space.
 */
async function findPlaybooks(spaceId) {
  const spacesAPI = _getSpacesAPI();

  const allItems = await spacesAPI.items.list(spaceId, { includeContent: false });
  const playbooks = [];

  for (const item of allItems) {
    if (_isPlaybook(item)) {
      // Load content for preview
      let preview = '';
      try {
        const loaded = await spacesAPI.items.get(spaceId, item.id);
        preview = (loaded.content || '').substring(0, 200);
      } catch (err) {
        console.warn('[playbook-executor] Load item for preview:', err.message);
      }

      playbooks.push({
        id: item.id,
        title: item.metadata?.title || item.fileName || 'Untitled',
        type: item.type,
        preview,
      });
    }
  }

  return playbooks;
}

/**
 * Register a progress listener for a specific job.
 * Used by IPC handlers to forward events to renderers.
 */
function onJobProgress(jobId, callback) {
  // Store callback on the job itself
  const job = _jobs.get(jobId);
  if (job) {
    job._progressCallback = callback;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  startJob,
  getJob,
  respond,
  cancel,
  listJobs,
  findPlaybooks,
  onJobProgress,
  // Test helpers (prefixed with _ to signal internal use)
  _setTestDeps,
  _clearTestDeps,
  _clearJobs,
};
