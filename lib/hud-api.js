/**
 * Centralized HUD API
 *
 * Main-process module that provides a unified interface for any tool
 * (orb, command HUD, recorder, future tools) to submit tasks,
 * receive lifecycle events, and manage agent spaces.
 *
 * Each tool creates its own UI but shares the same submission pipeline,
 * agent pool, and event system through this API.
 *
 * Key responsibilities:
 * - Space-scoped task submission (filters agents by space before auction)
 * - Per-tool event routing (each tool gets only its own events)
 * - HUD state management (items per tool)
 * - Agent space management (delegates to AgentSpaceRegistry)
 * - Remote agent management (delegates to RemoteAgentClient)
 *
 * @module HUDAPI
 */

let ipcMain, BrowserWindow;
try {
  const electron = require('electron');
  ipcMain = electron.ipcMain;
  BrowserWindow = electron.BrowserWindow;
} catch (_e) {
  // Outside Electron (e.g., tests) - IPC not available
}
const { getAgentSpaceRegistry } = require('./agent-space-registry');
const { v4: uuidv4 } = require('uuid');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// Shared event bus (decouples from exchange-bridge circular dependency)
const exchangeBus = require('./exchange/event-bus');

// Agent System v2: consolidated task-store + durable task lifecycle
// log + role-based voter pool. All live in-process, no flag gating.
const { getTaskStore } = require('./exchange/task-store');
const { buildTask } = require('./task');
const { buildAgentFilter, filterEligibleAgents } = require('./exchange/voter-pool');

// Lazy accessor for agent-stats (lives in src/voice-task-sdk and pulls
// in Electron; use a try/catch so this module stays importable from
// Node-only test contexts).
let _cachedStats = null;
function _getStats() {
  if (_cachedStats !== null) return _cachedStats;
  try {
    const { getAgentStats } = require('../src/voice-task-sdk/agent-stats');
    _cachedStats = getAgentStats();
  } catch (_err) {
    _cachedStats = null;
  }
  return _cachedStats;
}

/**
 * Record a task lifecycle event to the durable timeline.
 * Best-effort -- swallows all errors so recording can never break the
 * caller.
 */
function _recordLifecycle(taskId, type, data) {
  if (!taskId) return;
  const stats = _getStats();
  if (!stats || typeof stats.recordTaskLifecycle !== 'function') return;
  try {
    stats.recordTaskLifecycle({ taskId, type, at: Date.now(), data });
  } catch (_err) {
    // best-effort
  }
}

/**
 * Phase 1: run a task through the council-mode pipeline instead of the
 * normal single-winner auction. Invoked from submitTask when the caller
 * supplies `variant: 'council'` and the `councilMode` flag is enabled.
 *
 * Loads eligible agents from the built-in registry, constructs a
 * canonical Task via buildTask(), and calls lib/exchange/council-runner.
 * Converts the consolidated result into a HUD-renderable spec and emits
 * it via the normal emitResult channel so every tool (orb, recorder,
 * command-HUD) gets it for free.
 *
 * @param {string} text
 * @param {Object} opts - subset of submitTask options
 * @returns {Promise<Object>} submitTask-compatible result
 */
async function _runCouncilSubmission(text, opts) {
  const { runCouncil } = require('./exchange/council-runner');
  const { getAllAgents } = require('../packages/agents/agent-registry');

  const task = buildTask({
    content: text,
    toolId: opts.toolId,
    spaceId: opts.spaceId,
    targetAgentId: opts.targetAgentId,
    variant: 'council',
    criteria: opts.criteria,
    rubric: opts.rubric,
    metadata: opts.metadata || {},
  });

  // Register routing + lifecycle up front so subsequent events find the
  // task. Writes to both the legacy Maps and the consolidated task-store
  // so any remaining code path that reads the Maps still works. The
  // task-store is the authoritative surface going forward.
  _taskToolMap.set(task.id, opts.toolId);
  _taskSpaceMap.set(task.id, opts.spaceId || null);
  _taskTimestamps.set(task.id, Date.now());
  try {
    getTaskStore().createTask(task.id, { toolId: opts.toolId, spaceId: opts.spaceId || null });
  } catch (_err) { /* best-effort mirror */ }
  _recordLifecycle(task.id, 'council:submitted', {
    toolId: opts.toolId,
    spaceId: opts.spaceId || null,
    criteriaCount: Array.isArray(task.criteria) ? task.criteria.length : 0,
  });

  // Eligible agents: built-in registry minus bidExcluded, with
  // space-scoped filtering so specialists in a different space don't
  // bid. Generalists (no declared defaultSpaces) always vote.
  const fullAgentList = (getAllAgents() || []).filter((a) => !a.bidExcluded);
  const agents = filterEligibleAgents(fullAgentList, task);

  // Forward lifecycle events from the runner to the timeline + HUD
  // lifecycle bus so downstream consumers (tests, flow-gateway, HUD
  // observers) can subscribe.
  const onLifecycle = (evt) => {
    try {
      _recordLifecycle(task.id, `council:${evt.type}`, evt);
      emitLifecycle({ ...evt, taskId: task.id, toolId: opts.toolId });
    } catch (_err) { /* observer must never throw */ }
  };

  const result = await runCouncil(task, agents, {
    weightingMode: opts.weightingMode || 'uniform',
    onLifecycle,
  });

  // Synthesize a human-readable summary message. The consolidator's
  // rationale string is the natural source; fall back to a terse
  // fallback if the consolidator didn't produce one (e.g. error path).
  const summary = result.epistemicFraming?.rationale
    || (result.error
      ? `Council did not produce a result: ${result.error.reason}`
      : `Council scored ${result.aggregateScore}/100 (${result.confidence} confidence) across ${result.bidCount} agent${result.bidCount === 1 ? '' : 's'}.`);

  // Build the HUD UI spec that the agent-ui-renderer understands.
  const ui = {
    type: 'consolidatedEvaluation',
    message: summary,
    aggregateScore: result.aggregateScore,
    confidence: result.confidence,
    weightingMode: result.weightingMode,
    agentScores: result.agentScores,
    conflicts: result.conflicts,
    suggestions: result.suggestions,
    primaryDrivers: result.epistemicFraming?.primaryDrivers || [],
    recommendsHumanReview: !!result.epistemicFraming?.recommendsHumanReview,
  };

  emitResult({
    taskId: task.id,
    success: !result.error,
    message: summary,
    ui,
    agentId: 'council',
    data: {
      aggregateScore: result.aggregateScore,
      confidence: result.confidence,
      bidCount: result.bidCount,
      conflictCount: (result.conflicts || []).length,
      weightingMode: result.weightingMode,
      agentScores: result.agentScores,
    },
  });

  return {
    taskId: task.id,
    queued: false,
    handled: true,
    classified: true,
    variant: 'council',
    message: summary,
    ui,
    data: {
      aggregateScore: result.aggregateScore,
      confidence: result.confidence,
      bidCount: result.bidCount,
      conflictCount: (result.conflicts || []).length,
      weightingMode: result.weightingMode,
    },
    suppressAIResponse: false,
  };
}

// ==================== STATE ====================

// Per-tool HUD items: toolId -> Map<itemId, item>
const _hudItems = new Map();

// Per-tool event subscribers: toolId -> { lifecycle, result, disambiguation, needsInput }
const _subscribers = new Map();

// Task-to-tool mapping: taskId -> toolId (so we route results back to the right tool)
const _taskToolMap = new Map();

// Task-to-space mapping: taskId -> spaceId (for space-scoped routing)
const _taskSpaceMap = new Map();

// Active disambiguation states: stateId -> { taskId, toolId, question, options, createdAt }
const _disambiguationStates = new Map();

// Active needs-input requests: taskId -> { toolId, prompt, agentId, createdAt }
const _needsInputRequests = new Map();

// Task tracking timestamps for TTL cleanup: taskId -> createdAt
const _taskTimestamps = new Map();

let _ipcRegistered = false;
let _cleanupIntervalId = null;

// TTL for stale entries (10 minutes) - tasks older than this without
// a result/cancel are considered orphaned and cleaned up
const STALE_TASK_TTL_MS = 10 * 60 * 1000;
// TTL for disambiguation/needsInput states (5 minutes)
const STALE_STATE_TTL_MS = 5 * 60 * 1000;

// ==================== SPEECH STATE (mic gating) ====================
// Tracks whether TTS is currently playing so the voice listener can
// clear its input audio buffer and avoid self-listening feedback loops.

let _isSpeaking = false;
let _speakingTimeout = null;

/**
 * Mark that TTS playback has started.
 * The voice listener should mute/clear its input buffer while this is true.
 */
function speechStarted() {
  _isSpeaking = true;
  // Safety timeout -- auto-clear after 30s in case speechEnded() is never called
  clearTimeout(_speakingTimeout);
  _speakingTimeout = setTimeout(() => {
    if (_isSpeaking) {
      log.warn('ipc', 'Speech state auto-cleared after 30s safety timeout');
      _isSpeaking = false;
      _broadcastIPC('hud-api:speech-state', { isSpeaking: false });
    }
  }, 30000);
  _broadcastIPC('hud-api:speech-state', { isSpeaking: true });
}

/**
 * Mark that TTS playback has ended.
 * Small trailing buffer (300ms) to avoid catching the tail of TTS audio.
 */
function speechEnded() {
  clearTimeout(_speakingTimeout);
  // Short trailing buffer so mic doesn't catch the end of playback
  _speakingTimeout = setTimeout(() => {
    _isSpeaking = false;
    _broadcastIPC('hud-api:speech-state', { isSpeaking: false });
  }, 300);
}

/**
 * Check if TTS is currently playing.
 * @returns {boolean}
 */
function isSpeaking() {
  return _isSpeaking;
}

// ==================== TRANSCRIPT QUALITY FILTER ====================
// Fast LLM-based filter that catches garbled, hallucinated, or
// multi-script transcriptions before they trigger a full agent auction.

/**
 * Evaluate whether a transcript is genuine user speech or a
 * garbled/hallucinated artifact from the Realtime API.
 *
 * Uses a two-stage approach:
 *   1. Fast heuristic check (free, instant) -- catches obvious garbage
 *   2. LLM micro-check (cheap, ~200ms) -- catches subtle hallucinations
 *
 * @param {string} transcript - Raw transcript text
 * @returns {{ pass: boolean, reason: string }}
 */
function _buildClarificationMessage(reason) {
  const prompts = [
    "I'm here. What can I help you with?",
    "I'm listening. What would you like to do?",
    "Go ahead, I'm ready. What do you need?",
  ];
  if (reason === 'filler or fragment' || reason === 'too short') {
    return prompts[Math.floor(Math.random() * prompts.length)];
  }
  return "Sorry, I didn't catch that. Could you say that again?";
}

async function filterTranscript(transcript) {
  if (!transcript || typeof transcript !== 'string') {
    return { pass: false, reason: 'empty' };
  }

  const text = transcript.trim();
  if (text.length === 0) {
    return { pass: false, reason: 'empty' };
  }

  // ---- Stage 1: Fast heuristic checks (no LLM cost) ----

  // Mixed-script detection: flag text that contains characters from 3+ scripts
  const scripts = {
    latin: /[a-zA-ZÀ-ÿ]/.test(text),
    cjk: /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text),
    hangul: /[\uac00-\ud7af\u1100-\u11ff]/.test(text),
    thai: /[\u0e00-\u0e7f]/.test(text),
    japanese: /[\u3040-\u309f\u30a0-\u30ff]/.test(text),
    arabic: /[\u0600-\u06ff]/.test(text),
    cyrillic: /[\u0400-\u04ff]/.test(text),
    devanagari: /[\u0900-\u097f]/.test(text),
  };
  const scriptCount = Object.values(scripts).filter(Boolean).length;
  if (scriptCount >= 3) {
    log.info('ipc', 'Rejected multi-script ( scripts): ""', { scriptCount: scriptCount, text: text.slice(0, 40) });
    return { pass: false, reason: `multi-script garbage (${scriptCount} scripts detected)` };
  }

  // Pure non-Latin single-script with very short length is suspicious
  // (the Realtime API sometimes hallucinates a few CJK/Thai chars from noise)
  if (!scripts.latin && text.length < 15 && scriptCount === 1) {
    log.info('ipc', 'Rejected short non-Latin: ""', { text: text.slice(0, 40) });
    return { pass: false, reason: 'short non-Latin hallucination' };
  }

  // Too short to be meaningful (and not a known command)
  if (text.length < 2) {
    return { pass: false, reason: 'too short' };
  }

  // ---- Stage 2: Filler / non-actionable phrase detection (no LLM cost) ----
  const lowerText = text.toLowerCase().replace(/[.,!?;:'"]/g, '').trim();
  const words = lowerText.split(/\s+/);

  const FILLER_PHRASES = new Set([
    'um', 'uh', 'ah', 'eh', 'er', 'mm', 'hm', 'hmm', 'umm',
    'like', 'so', 'well', 'right', 'ok', 'okay', 'yeah', 'yep',
    'no', 'nah', 'nope', 'huh', 'what', 'the', 'i', 'a',
    'i mean', 'you know', 'i think', 'let me', 'wait',
    'oh', 'ooh', 'wow', 'haha', 'ha',
  ]);

  if (FILLER_PHRASES.has(lowerText) || (words.length === 1 && lowerText.length < 4)) {
    return { pass: false, reason: 'filler or fragment' };
  }

  // ---- Stage 3: LLM micro-check (for ambiguous transcripts) ----
  // Call the LLM when heuristics can't decide:
  //   - Non-Latin text mixed with Latin
  //   - Short phrases that could be noise or an incomplete thought
  //   - Very short non-alpha sequences

  const needsLLMCheck =
    scriptCount === 2 ||
    (!scripts.latin && text.length < 40) ||
    (text.length < 8 && !/^[a-z]+$/i.test(text)) ||
    (words.length <= 3 && text.length < 15);

  if (needsLLMCheck) {
    try {
      const ai = require('./ai-service');
      const result = await ai.json(
        `You are a voice transcription quality filter for a voice assistant. Determine if this text is a genuine, actionable user request OR if it's garbled noise, a filler phrase, an incomplete thought, or a hallucinated artifact.

Text: "${text}"

Respond with JSON:
{
  "genuine": true or false,
  "reason": "brief explanation"
}

Reject (genuine: false) if:
- Random words from multiple languages mashed together
- Subtitle artifacts ("Thanks for watching", "Subscribe", "Like and share")
- Gibberish or phonetic noise
- Filler phrases that aren't a request ("I mean", "you know", "like", "so um")
- Incomplete fragments that aren't actionable ("the thing", "wait no", "I was")
- Text unrelated to a voice assistant context

Accept (genuine: true) if:
- A clear question ("what time is it", "what's the weather")
- A clear command ("open settings", "play music", "search for X")
- A coherent request even if short ("help", "stop", "next")`,
        { profile: 'fast', feature: 'transcript-filter', maxTokens: 80 }
      );

      if (result && result.genuine === false) {
        log.info('ipc', 'LLM rejected transcript', { text: text.slice(0, 40), reason: result.reason });
        return { pass: false, reason: result.reason || 'LLM classified as not actionable' };
      }
    } catch (e) {
      log.warn('ipc', 'LLM filter failed, passing through', { error: e.message });
    }
  }

  return { pass: true, reason: 'ok' };
}

// ==================== INITIALIZATION ====================

/**
 * Initialize the HUD API.
 * Uses the shared event bus (lib/exchange/event-bus.js) for exchange access,
 * eliminating the circular dependency with exchange-bridge.
 */
function initialize() {
  // Initialize agent space registry (async, non-blocking)
  const registry = getAgentSpaceRegistry();
  registry.initialize().catch((e) => log.warn('ipc', 'Agent space registry init error', { error: e.message }));

  if (!_ipcRegistered) {
    _registerIPC();
    _ipcRegistered = true;
  }

  // Start periodic cleanup to prevent memory leaks from orphaned tasks
  _startCleanupInterval();

  log.info('ipc', 'Initialized');
}

// ==================== TASK SUBMISSION ====================

/**
 * Submit a task through the full exchange bridge pipeline.
 *
 * This is the single entry point for ALL task submission from any tool.
 * Runs the complete pipeline: transcript filter -> dedup -> Router ->
 * critical commands -> disambiguation -> exchange auction -> agent execution.
 *
 * Also handles space-scoped agent filtering and task-tool mapping so
 * lifecycle events route back to the originating tool.
 *
 * @param {string} text - The user's input / command
 * @param {Object} options
 * @param {string} options.spaceId - Agent space to scope (e.g. 'meeting-agents')
 * @param {string} options.toolId - Tool submitting the task (e.g. 'recorder', 'orb')
 * @param {string} options.targetAgentId - Skip bidding and route directly to this agent
 * @param {Object} options.metadata - Additional metadata for the task
 * @param {boolean} options.skipFilter - Skip transcript quality filter (e.g. for text input)
 * @param {string} [options.variant] - Auction variant ('winner' | 'council' |
 *                                     'lead_plus_probers'). When 'council' and
 *                                     the councilMode flag is enabled, dispatches
 *                                     to lib/exchange/council-runner instead of
 *                                     the normal single-winner auction.
 * @param {Array} [options.criteria] - Optional per-criterion rubric. Passed
 *                                     through to the task for council scoring.
 * @param {string} [options.rubric] - Named rubric id (see lib/task-rubrics).
 * @param {string} [options.weightingMode] - 'uniform' | 'contextual' |
 *                                           'user_biased' | 'learned'
 * @returns {Object} Full pipeline result: { taskId, queued, handled, message, suppressAIResponse, needsInput, ... }
 */
async function submitTask(text, options = {}) {
  const {
    spaceId,
    toolId = 'unknown',
    targetAgentId,
    metadata = {},
    skipFilter = false,
    variant,
    criteria,
    rubric,
    weightingMode,
  } = options;
  log.info('ipc', 'submitTask: text="" tool= skipFilter= bus', {
    data: (text || '').slice(0, 60),
    toolId: toolId,
    skipFilter: skipFilter,
    busReady: !!exchangeBus._processSubmit,
  });

  if (!text || !text.trim()) {
    return { taskId: null, queued: false, handled: false, error: 'Empty task text' };
  }

  // ---- Auto variant selection ------------------------------------------
  // If the caller didn't specify a variant, ask the cheap LLM micro-
  // classifier whether this request is winner / council / lead+probers.
  // Output is cached per normalized task text so repeats don't re-pay.
  let resolvedVariant = variant;
  if (!resolvedVariant) {
    try {
      const { selectVariant } = require('./exchange/variant-selector');
      resolvedVariant = await selectVariant({ content: text });
      if (resolvedVariant && resolvedVariant !== 'winner') {
        log.info('ipc', 'Auto-selected variant', { variant: resolvedVariant });
      }
    } catch (err) {
      log.warn('ipc', 'Variant selection failed, defaulting to winner', { error: err.message });
      resolvedVariant = undefined;
    }
  }

  // ---- Council-mode dispatch -------------------------------------------
  // When variant is 'council' (caller-supplied or auto-selected), run
  // the task through lib/exchange/council-runner.js. Skips transcript
  // filtering and intent normalization -- requests routed here are
  // structured evaluation tasks, not ambient voice input. Any runtime
  // failure falls through to the normal auction so the user is never
  // stranded.
  if (resolvedVariant === 'council') {
    try {
      return await _runCouncilSubmission(text, {
        toolId, spaceId, targetAgentId, metadata, criteria, rubric, weightingMode,
      });
    } catch (err) {
      log.error('ipc', 'Council submission failed', { error: err.message });
    }
  }

  // ---- Role-based voter-pool filter -------------------------------------
  // When the task has a spaceId, populate metadata.agentFilter so the
  // exchange only solicits bids from eligible agents. Generalist agents
  // (no declared defaultSpaces) still bid on everything; specialists
  // bid only in their space. Caller-supplied metadata.agentFilter wins.
  if (
    spaceId
    && !targetAgentId
    && (!metadata || !Array.isArray(metadata.agentFilter))
  ) {
    try {
      const { getAllAgents } = require('../packages/agents/agent-registry');
      const allAgents = getAllAgents() || [];
      const filter = buildAgentFilter(allAgents, { spaceId }, {});
      if (Array.isArray(filter) && filter.length > 0) {
        options.metadata = { ...(metadata || {}), agentFilter: filter };
        log.info('ipc', 'Role-based voter pool', { spaceId, count: filter.length });
      }
    } catch (err) {
      log.warn('ipc', 'Voter-pool filter failed; using full auction', { error: err.message });
    }
  }

  // ---- Transcript quality filter (unless skipped for text input) ----
  if (!skipFilter) {
    try {
      const filterResult = await filterTranscript(text);
      if (!filterResult.pass) {
        log.info('ipc', 'Transcript rejected by filter', { filterResult: filterResult.reason });
        const clarifyMessage = _buildClarificationMessage(filterResult.reason);
        return {
          taskId: null,
          queued: false,
          handled: true,
          classified: false,
          needsClarification: true,
          message: clarifyMessage,
          filterReason: filterResult.reason,
          suppressAIResponse: false,
        };
      }
    } catch (e) {
      // Filter failed -- fail-open
      log.warn('ipc', 'Filter error (proceeding)', { error: e.message });
    }
  }

  // ---- Resolve space (for context only -- no agent pre-filtering) ----
  // All agents bid on every task via LLM evaluation. Space info is passed
  // as metadata for context, but does NOT restrict which agents can bid.
  let resolvedSpaceId = spaceId || null;
  let _agentFilter = null; // Always null -- all agents bid
  try {
    const registry = getAgentSpaceRegistry();
    if (!resolvedSpaceId && registry?.getDefaultSpaceForTool) {
      resolvedSpaceId = await registry.getDefaultSpaceForTool(toolId);
    }
    // Space resolved for context/logging only
    if (resolvedSpaceId) {
      log.info('ipc', 'Space context resolved', { resolvedSpaceId });
    }
  } catch (_spaceErr) {
    // Non-fatal
    resolvedSpaceId = null;
  }

  // ---- Submit via exchange bridge's full pipeline ----
  if (!exchangeBus._processSubmit) {
    // Fallback: try direct exchange submit if processSubmit not registered yet
    const exchange = exchangeBus.getExchange();
    if (!exchange) {
      return { taskId: null, queued: false, handled: false, error: 'Exchange bridge not initialized' };
    }

    try {
      const { taskId } = await exchange.submit({
        content: text.trim(),
        priority: metadata.priority || 2,
        metadata: {
          source: toolId,
          agentSpaceId: resolvedSpaceId,
          agentFilter: targetAgentId ? [targetAgentId] : null,
          targetAgentId: targetAgentId || null,
          timestamp: Date.now(),
          ...metadata,
        },
      });

      _taskToolMap.set(taskId, toolId);
      _taskSpaceMap.set(taskId, resolvedSpaceId);
      _taskTimestamps.set(taskId, Date.now());

      try {
        getTaskStore().createTask(taskId, { toolId, spaceId: resolvedSpaceId });
      } catch (_err) { /* best-effort mirror */ }
      _recordLifecycle(taskId, 'submitted', { toolId, spaceId: resolvedSpaceId, path: 'fallback' });

      log.info('ipc', 'Task submitted (fallback)', { taskId, toolId });
      return { taskId, queued: true, handled: false, suppressAIResponse: true };
    } catch (error) {
      log.error('ipc', 'Fallback submit error', { error: error.message });
      return { taskId: null, queued: false, handled: false, error: error.message };
    }
  }

  // Full pipeline: dedup, Router, critical commands, disambiguation,
  // exchange auction, agent execution, voice cues
  try {
    const result = await exchangeBus.processSubmit(text.trim(), {
      agentFilter: targetAgentId ? [targetAgentId] : null,
      spaceId: resolvedSpaceId,
      toolId,
      metadata,
      skipFilter: true, // submitTask already ran the quality filter above
    });

    // Validate result -- processSubmit should always return an object
    if (!result || typeof result !== 'object') {
      log.warn('ipc', 'processSubmit returned invalid result', { result });
      return { taskId: null, queued: false, handled: false, error: 'Invalid response from exchange bridge' };
    }

    // Track task -> tool mapping for event routing
    if (result.taskId) {
      _taskToolMap.set(result.taskId, toolId);
      _taskSpaceMap.set(result.taskId, resolvedSpaceId);
      _taskTimestamps.set(result.taskId, Date.now());

      try {
        getTaskStore().createTask(result.taskId, { toolId, spaceId: resolvedSpaceId });
      } catch (_err) { /* best-effort mirror */ }
      _recordLifecycle(result.taskId, 'submitted', { toolId, spaceId: resolvedSpaceId, path: 'pipeline' });
    }

    log.info('ipc', 'Task submitted via pipeline', {
      taskId: result.taskId || 'handled',
      queued: result.queued,
      toolId,
    });
    return result;
  } catch (error) {
    log.error('ipc', 'Pipeline submit error', {
      error: error.message,
      stack: error.stack?.split('\n').slice(0, 3).join(' | '),
    });
    return { taskId: null, queued: false, handled: false, error: error.message };
  }
}

/**
 * Cancel a task.
 * @param {string} taskId
 */
function cancelTask(taskId) {
  const exchange = exchangeBus.getExchange();
  if (exchange?.cancelTask) {
    exchange.cancelTask(taskId);
  }
  _taskToolMap.delete(taskId);
  _taskSpaceMap.delete(taskId);
  _taskTimestamps.delete(taskId);

  try { getTaskStore().deleteTask(taskId); } catch (_err) { /* best-effort mirror */ }
  _recordLifecycle(taskId, 'cancelled');
}

// ==================== EVENT SYSTEM ====================

/**
 * Subscribe to lifecycle events for a tool.
 * @param {string} toolId
 * @param {Function} callback - (event) => void
 */
function onLifecycle(toolId, callback) {
  if (!_subscribers.has(toolId)) {
    _subscribers.set(toolId, { lifecycle: new Set(), result: new Set() });
  }
  _subscribers.get(toolId).lifecycle.add(callback);
}

/**
 * Subscribe to result events for a tool.
 * @param {string} toolId
 * @param {Function} callback - (result) => void
 */
function onResult(toolId, callback) {
  if (!_subscribers.has(toolId)) {
    _subscribers.set(toolId, { lifecycle: new Set(), result: new Set() });
  }
  _subscribers.get(toolId).result.add(callback);
}

/**
 * Unsubscribe all listeners for a tool.
 * @param {string} toolId
 */
function offAll(toolId) {
  _subscribers.delete(toolId);
}

/**
 * Emit a lifecycle event. Routes to the correct tool based on taskId.
 * Also broadcasts to all tools if no taskId mapping exists (global events).
 * @param {Object} event - { type, taskId, ... }
 */
function emitLifecycle(event) {
  const toolId = _taskToolMap.get(event.taskId);
  log.info('ipc', `Lifecycle ${event.type}`, {
    taskId: event.taskId || '-',
    tool: toolId || 'broadcast',
    agentId: event.agentId || '-',
  });

  if (toolId) {
    // Route to specific tool
    const subs = _subscribers.get(toolId);
    if (subs) {
      for (const cb of subs.lifecycle) {
        try {
          cb(event);
        } catch (e) {
          log.error('ipc', 'Lifecycle callback error', { e: e });
        }
      }
    }
  } else {
    // Broadcast to all tools (e.g. global events)
    for (const [, subs] of _subscribers) {
      for (const cb of subs.lifecycle) {
        try {
          cb(event);
        } catch (e) {
          log.error('ipc', 'Lifecycle callback error', { e: e });
        }
      }
    }
  }

  // Also broadcast via IPC to all windows
  _broadcastIPC('hud-api:lifecycle', event);
}

/**
 * Emit a result event.
 * @param {Object} result - { taskId, success, message, data, agentId, ... }
 */
function emitResult(result) {
  const toolId = _taskToolMap.get(result.taskId);
  log.info('ipc', 'Task result', {
    taskId: result.taskId || '-',
    tool: toolId || 'broadcast',
    success: result.success,
    agentId: result.agentId || '-',
    message: (result.message || '').slice(0, 80),
  });

  if (toolId) {
    const subs = _subscribers.get(toolId);
    if (subs) {
      for (const cb of subs.result) {
        try {
          cb(result);
        } catch (e) {
          log.error('ipc', 'Result callback error', { e: e });
        }
      }
    }
  }

  // Also broadcast via IPC
  _broadcastIPC('hud-api:result', result);

  // Record terminal lifecycle event (before clearing the mapping so the
  // recorder still has routing context if it needs it in the future).
  _recordLifecycle(result.taskId, result.success ? 'completed' : 'failed', {
    agentId: result.agentId || null,
  });

  try { getTaskStore().deleteTask(result.taskId); } catch (_err) { /* best-effort mirror */ }

  // Clean up task mappings
  _taskToolMap.delete(result.taskId);
  _taskSpaceMap.delete(result.taskId);
  _taskTimestamps.delete(result.taskId);
}

// ==================== HUD ITEMS ====================

/**
 * Add an item to a tool's HUD.
 * @param {string} toolId
 * @param {Object} item - { type, text, tags, deadline, addedBy, agentId, ... }
 * @returns {Object} The item with generated id and timestamp
 */
function addHUDItem(toolId, item) {
  if (!_hudItems.has(toolId)) {
    _hudItems.set(toolId, new Map());
  }

  const fullItem = {
    id: item.id || uuidv4(),
    type: item.type || 'note',
    text: item.text || '',
    tags: item.tags || [],
    deadline: item.deadline || null,
    addedBy: item.addedBy || toolId,
    timestamp: item.timestamp || Date.now(),
    agentId: item.agentId || null,
  };

  _hudItems.get(toolId).set(fullItem.id, fullItem);

  // Notify subscribers
  _broadcastIPC('hud-api:item-added', { toolId, item: fullItem });

  return fullItem;
}

/**
 * Remove an item from a tool's HUD.
 * @param {string} toolId
 * @param {string} itemId
 */
function removeHUDItem(toolId, itemId) {
  const items = _hudItems.get(toolId);
  if (items) {
    items.delete(itemId);
    _broadcastIPC('hud-api:item-removed', { toolId, itemId });
  }
}

/**
 * Get all HUD items for a tool.
 * @param {string} toolId
 * @returns {Array<Object>}
 */
function getHUDItems(toolId) {
  const items = _hudItems.get(toolId);
  return items ? Array.from(items.values()) : [];
}

/**
 * Clear all HUD items for a tool.
 * @param {string} toolId
 */
function clearHUDItems(toolId) {
  _hudItems.delete(toolId);
  _broadcastIPC('hud-api:items-cleared', { toolId });
}

// ==================== AGENT SPACE MANAGEMENT ====================
// These delegate to AgentSpaceRegistry

async function getAgentSpaces() {
  return getAgentSpaceRegistry().getAgentSpaces();
}

async function getAgentsInSpace(spaceId) {
  return getAgentSpaceRegistry().getAgentsInSpace(spaceId);
}

async function getAgentIdsInSpace(spaceId) {
  return getAgentSpaceRegistry().getAgentIdsInSpace(spaceId);
}

async function setAgentEnabled(spaceId, agentId, enabled) {
  return getAgentSpaceRegistry().setAgentEnabled(spaceId, agentId, enabled);
}

async function getDefaultSpace(toolId) {
  return getAgentSpaceRegistry().getDefaultSpaceForTool(toolId);
}

async function setDefaultSpace(toolId, spaceId) {
  return getAgentSpaceRegistry().setDefaultSpaceForTool(toolId, spaceId);
}

async function createAgentSpace(name, config) {
  return getAgentSpaceRegistry().createAgentSpace(name, config);
}

async function assignAgentToSpace(agentId, spaceId, config) {
  return getAgentSpaceRegistry().assignAgent(agentId, spaceId, config);
}

async function removeAgentFromSpace(agentId, spaceId) {
  return getAgentSpaceRegistry().removeAgent(agentId, spaceId);
}

// ==================== REMOTE AGENT MANAGEMENT ====================

/**
 * Register a remote agent and assign it to a space.
 * @param {Object} definition - { id, name, endpoint, authType, authToken, metadata, spaceId }
 * @returns {Object} The created agent entry
 */
async function registerRemoteAgent(definition) {
  const { spaceId, ...agentDef } = definition;
  const targetSpace = spaceId || 'general-agents';

  const entry = {
    id: agentDef.id || `remote-${Date.now()}`,
    type: 'remote',
    enabled: true,
    name: agentDef.name,
    endpoint: agentDef.endpoint,
    authType: agentDef.authType || 'none',
    authToken: agentDef.authToken,
    capabilities: agentDef.capabilities || { bid: true, execute: true, stream: false },
    metadata: agentDef.metadata || {},
  };

  await getAgentSpaceRegistry().assignAgent(entry.id, targetSpace, entry);
  log.info('ipc', 'Registered remote agent: in space', { entry: entry.id, targetSpace: targetSpace });
  return entry;
}

/**
 * Test a remote agent's health.
 * @param {string} agentId
 * @returns {Object} { status, latency }
 */
async function testRemoteAgent(agentId) {
  try {
    const { checkRemoteHealth } = require('./remote-agent-client');
    // Find the agent entry across all spaces
    const spaces = await getAgentSpaceRegistry().getAgentSpaces();
    for (const space of spaces) {
      const agent = space.agents.find((a) => a.id === agentId && a.type === 'remote');
      if (agent) {
        return await checkRemoteHealth(agent);
      }
    }
    return { status: 'not-found', latency: -1 };
  } catch (error) {
    return { status: 'error', latency: -1, error: error.message };
  }
}

// ==================== DISAMBIGUATION ====================

/**
 * Emit a disambiguation event for a tool.
 * Called by exchange-bridge when no agent is confident enough.
 * @param {Object} state - { taskId, question, options }
 */
function emitDisambiguation(state) {
  const toolId = _taskToolMap.get(state.taskId) || null;
  const stateId = state.stateId || uuidv4();

  const fullState = {
    stateId,
    taskId: state.taskId,
    toolId,
    question: state.question,
    options: state.options || [],
    createdAt: Date.now(),
  };

  log.info('ipc', 'Disambiguation emitted', {
    taskId: state.taskId || '-',
    toolId: toolId || 'broadcast',
    optionCount: fullState.options.length,
    question: (fullState.question || '').slice(0, 60),
  });

  _disambiguationStates.set(stateId, fullState);

  // Notify specific tool or broadcast
  if (toolId) {
    const subs = _subscribers.get(toolId);
    if (subs?.disambiguation) {
      for (const cb of subs.disambiguation) {
        try {
          cb(fullState);
        } catch (e) {
          log.error('ipc', 'Disambiguation callback error', { e: e });
        }
      }
    }
  }

  _broadcastIPC('hud-api:disambiguation', fullState);
  return fullState;
}

/**
 * Subscribe to disambiguation events for a tool.
 * @param {string} toolId
 * @param {Function} callback - (state) => void
 */
function onDisambiguation(toolId, callback) {
  if (!_subscribers.has(toolId)) {
    _subscribers.set(toolId, {
      lifecycle: new Set(),
      result: new Set(),
      disambiguation: new Set(),
      needsInput: new Set(),
    });
  }
  const subs = _subscribers.get(toolId);
  if (!subs.disambiguation) subs.disambiguation = new Set();
  subs.disambiguation.add(callback);
}

/**
 * User selects a disambiguation option.
 * @param {string} stateId
 * @param {number} index - Option index
 * @returns {Object} { taskId, queued }
 */
async function selectDisambiguationOption(stateId, index) {
  const state = _disambiguationStates.get(stateId);
  if (!state) return { error: 'Disambiguation state not found' };

  const option = state.options[index];
  if (!option) return { error: 'Invalid option index' };

  _disambiguationStates.delete(stateId);

  // Handle special actions for capability gap responses
  if (option.action === 'create-agent' && option.gapDescription) {
    try {
      const main = require('../main');
      if (main.createClaudeCodeWindow) {
        main.createClaudeCodeWindow({ initialDescription: option.gapDescription });
        return { handled: true, action: 'create-agent', message: `Opening Agent Composer to build: ${option.gapDescription}` };
      }
    } catch (e) {
      log.warn('voice', 'Could not open Agent Composer from disambiguation', { error: e.message });
    }
  }

  if (option.action === 'create-playbook') {
    try {
      const result = await _generateAndSavePlaybook(option.gapDescription, option.buildProposal);
      return { handled: true, action: 'create-playbook', message: result.message };
    } catch (e) {
      log.warn('voice', 'Could not generate playbook from disambiguation', { error: e.message });
      return { handled: true, action: 'create-playbook', message: 'I ran into an issue generating the playbook. The request has been noted on the wishlist.' };
    }
  }

  if (option.action === 'wishlist-ack') {
    return { handled: true, action: 'wishlist-ack', message: 'Noted. I\'ve added it to the Capability Wishlist.' };
  }

  // Handle diagnostic actions for non-system agent failures
  if (option.action === 'diagnose-fix' && option.failedAgentId) {
    try {
      const main = require('../main');
      if (main.createClaudeCodeWindow) {
        const diagSummary = option.diagnosis
          ? `Diagnosis: ${option.diagnosis.rootCause || option.diagnosis.summary}. Fix: ${option.fix?.description || 'see diagnosis'}.`
          : '';
        const description = `Fix agent "${option.failedAgentId}": ${diagSummary}\n\nOriginal request that failed: ${option.originalTask || '(unknown)'}`;
        main.createClaudeCodeWindow({ initialDescription: description });
        return { handled: true, action: 'diagnose-fix', message: `Opening Agent Composer to fix "${option.failedAgentId}"` };
      }
    } catch (e) {
      log.warn('voice', 'Could not open Agent Composer for diagnosis fix', { error: e.message });
    }
    return { handled: true, action: 'diagnose-fix', message: 'Could not open Agent Composer. Try opening it manually from the Tools menu.' };
  }

  if (option.action === 'diagnose-open-composer' && option.failedAgentId) {
    try {
      const main = require('../main');
      if (main.createClaudeCodeWindow) {
        const diagContext = option.diagnosis
          ? `Agent "${option.failedAgentId}" failed. Root cause: ${option.diagnosis.rootCause || option.diagnosis.summary}. Category: ${option.diagnosis.category || 'unknown'}.`
          : `Agent "${option.failedAgentId}" encountered an error.`;
        const description = `${diagContext}\n\nOriginal request: ${option.originalTask || '(unknown)'}`;
        main.createClaudeCodeWindow({ initialDescription: description });
        return { handled: true, action: 'diagnose-open-composer', message: `Opening Agent Composer for "${option.failedAgentId}"` };
      }
    } catch (e) {
      log.warn('voice', 'Could not open Agent Composer for diagnosis', { error: e.message });
    }
    return { handled: true, action: 'diagnose-open-composer', message: 'Could not open Agent Composer. Try opening it manually from the Tools menu.' };
  }

  if (option.action === 'diagnose-retry' && option.originalTask) {
    return submitTask(option.originalTask, {
      toolId: state.toolId,
      spaceId: _taskSpaceMap.get(state.taskId),
      metadata: { retriedFrom: state.taskId },
    });
  }

  if (option.action === 'diagnose-skip') {
    return { handled: true, action: 'diagnose-skip', message: 'Noted. Skipping this error.' };
  }

  // Resubmit the selected option as a new task
  const text = option.description || option.label;
  return submitTask(text, {
    toolId: state.toolId,
    spaceId: _taskSpaceMap.get(state.taskId),
    metadata: { disambiguatedFrom: state.taskId },
  });
}

/**
 * Generate a build playbook for a capability gap and save it to Spaces.
 */
async function _generateAndSavePlaybook(gapDescription, buildProposal) {
  const ai = require('./ai-service');

  const proposalContext = buildProposal
    ? `
Build proposal:
- Effort: ${buildProposal.effort} -- ${buildProposal.effortDescription || ''}
- Est. cost per use: ${buildProposal.estimatedCostPerUse || '~$0.01'}
- Integration: ${buildProposal.integration || 'None'} -- ${buildProposal.integrationDetail || ''}
- Tools: ${(buildProposal.tools || []).join(', ') || 'None specified'}
- LLM calls: ${JSON.stringify(buildProposal.estimatedCalls || {})}`
    : '';

  const playbook = await ai.complete(
    `Generate a concise build playbook for creating an AI agent in an Electron desktop app.

CAPABILITY TO BUILD: "${gapDescription}"
${proposalContext}

SYSTEM CONTEXT:
- Agents are JS modules using BaseAgent.create({ id, name, description, categories, keywords, onExecute })
- AI calls go through centralized ai-service.js with profiles: fast (Haiku), standard (Sonnet), powerful (Opus)
- Available tools: shell_exec, file_read, file_write, web_search, spaces_search, spaces_add_item, get_current_time
- Agents register in packages/agents/agent-registry.js
- Results return { success, message, soundCue?, needsInput?, html? }
- Agents can use IPC for main-process integrations
- Agent Composer (claude-code-ui.html) can auto-build agents from descriptions

FORMAT the playbook as Markdown with these sections:
# Build Playbook: [Agent Name]

## Goal
One sentence.

## Architecture
- Agent ID, name, categories
- Which AI profile(s) and why
- Which tools needed
- Key integration points

## Implementation Steps
Numbered steps, each 1-2 sentences. Be specific about files to create/modify.

## LLM Prompt Design
Draft the system prompt for the agent's primary LLM call.

## Cost Estimate
Per-invocation cost breakdown.

## Testing
How to verify the agent works.

Keep it under 400 words. Be specific and actionable.`,
    { profile: 'standard', temperature: 0.4, maxTokens: 1000, feature: 'build-playbook' }
  );

  // Save playbook to the Capability Wishlist space
  try {
    const { getSpacesAPI } = require('../spaces-api');
    const spacesApi = getSpacesAPI();
    const storage = spacesApi.storage || spacesApi._storage;
    if (storage) {
      const spaces = storage.index?.spaces || [];
      let space = spaces.find((s) => s.id === 'capability-wishlist');
      if (!space) {
        space = storage.createSpace({
          id: 'capability-wishlist',
          name: 'Capability Wishlist',
          icon: '●',
          color: '#f59e0b',
          isSystem: true,
        });
      }

      storage.addItem({
        type: 'text',
        content: playbook,
        spaceId: 'capability-wishlist',
        timestamp: Date.now(),
        metadata: {
          title: `Playbook: ${gapDescription}`,
          gapDescription,
          itemType: 'playbook',
          buildProposal: buildProposal || null,
        },
      });

      log.info('voice', 'Saved build playbook to wishlist', { gap: gapDescription });
    }
  } catch (saveErr) {
    log.warn('voice', 'Could not save playbook to Spaces', { error: saveErr.message });
  }

  return {
    message: `I've created a build playbook for "${gapDescription}" and saved it to the Capability Wishlist. You can find it in Spaces.`,
    playbook,
  };
}

/**
 * Cancel a disambiguation.
 * @param {string} stateId
 */
function cancelDisambiguation(stateId) {
  const state = _disambiguationStates.get(stateId);
  if (state) {
    _disambiguationStates.delete(stateId);
    cancelTask(state.taskId);
  }
}

// ==================== MULTI-TURN CONVERSATION ====================

/**
 * Emit a needs-input event when an agent requires follow-up.
 * @param {Object} request - { taskId, prompt, agentId }
 */
function emitNeedsInput(request) {
  const toolId = _taskToolMap.get(request.taskId) || null;

  const fullRequest = {
    taskId: request.taskId,
    toolId,
    prompt: request.prompt || 'Please provide more information.',
    agentId: request.agentId || null,
    createdAt: Date.now(),
  };

  log.info('ipc', 'NeedsInput emitted', {
    taskId: request.taskId || '-',
    toolId: toolId || 'broadcast',
    agentId: request.agentId || '-',
    prompt: (fullRequest.prompt || '').slice(0, 60),
  });

  _needsInputRequests.set(request.taskId, fullRequest);

  // Notify specific tool
  if (toolId) {
    const subs = _subscribers.get(toolId);
    if (subs?.needsInput) {
      for (const cb of subs.needsInput) {
        try {
          cb(fullRequest);
        } catch (e) {
          log.error('ipc', 'NeedsInput callback error', { e: e });
        }
      }
    }
  }

  _broadcastIPC('hud-api:needs-input', fullRequest);
  return fullRequest;
}

/**
 * Subscribe to needs-input events for a tool.
 * @param {string} toolId
 * @param {Function} callback - (request) => void
 */
function onNeedsInput(toolId, callback) {
  if (!_subscribers.has(toolId)) {
    _subscribers.set(toolId, {
      lifecycle: new Set(),
      result: new Set(),
      disambiguation: new Set(),
      needsInput: new Set(),
    });
  }
  const subs = _subscribers.get(toolId);
  if (!subs.needsInput) subs.needsInput = new Set();
  subs.needsInput.add(callback);
}

/**
 * Respond to a needs-input request.
 * @param {string} taskId
 * @param {string} response - User's follow-up input
 * @returns {Object} { success }
 */
async function respondToInput(taskId, response) {
  const request = _needsInputRequests.get(taskId);
  _needsInputRequests.delete(taskId);

  // Submit the response through the exchange bridge
  try {
    // Emit the response as a task event
    const exchange = exchangeBus.getExchange();
    if (exchange && exchange.respondToInput) {
      await exchange.respondToInput(taskId, response);
    } else {
      // Fallback: resubmit as a new task with context
      const toolId = request?.toolId || _taskToolMap.get(taskId);
      return submitTask(response, {
        toolId,
        spaceId: _taskSpaceMap.get(taskId),
        metadata: { followUpTo: taskId },
      });
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== QUEUE STATISTICS ====================

/**
 * Get queue statistics from the exchange.
 * @returns {Object} { pending, active, completed, failed }
 */
function getQueueStats() {
  try {
    const exchange = exchangeBus.getExchange();
    if (exchange?.getStats) {
      return exchange.getStats();
    }
    // Fallback: return basic stats from our task tracking
    return {
      pending: 0,
      active: _taskToolMap.size,
      completed: 0,
      failed: 0,
    };
  } catch (_e) {
    return { pending: 0, active: 0, completed: 0, failed: 0 };
  }
}

// ==================== TRANSCRIPTION ====================

/**
 * Transcribe audio using the centralized ai-service.
 * Called from renderer processes that can't access ai-service directly.
 * @param {ArrayBuffer|Buffer} audioData - Audio data
 * @param {Object} opts - { language, filename }
 * @returns {Object} { text }
 */
async function transcribeAudio(audioData, opts = {}) {
  try {
    const ai = require('./ai-service');
    const buffer = Buffer.isBuffer(audioData) ? audioData : Buffer.from(audioData);
    const result = await ai.transcribe(buffer, {
      filename: opts.filename || 'audio.webm',
      language: opts.language,
      feature: 'hud-transcription',
    });
    return { text: result.text };
  } catch (error) {
    log.error('ipc', 'Transcription error', { error: error.message });
    return { text: '', error: error.message };
  }
}

// ==================== IPC REGISTRATION ====================

function _registerIPC() {
  if (!ipcMain) {
    log.info('ipc', 'IPC not available (outside Electron), skipping registration');
    return;
  }

  // Task submission
  ipcMain.handle('hud-api:submit-task', async (_event, text, options) => {
    try {
      log.info('ipc', 'submit-task called: "" toolId', {
        data: (text || '').slice(0, 60),
        options: options?.toolId || '?',
      });
      const result = await submitTask(text, options);
      log.info('ipc', 'submit-task result', {
        queued: result?.queued,
        taskId: result?.taskId || '-',
        error: result?.error || '-',
      });
      return result;
    } catch (ipcErr) {
      log.error('ipc', 'submit-task THREW', {
        error: ipcErr.message,
        stack: ipcErr.stack?.split('\n').slice(0, 3).join(' | '),
      });
      return { taskId: null, queued: false, handled: false, error: ipcErr.message };
    }
  });

  ipcMain.handle('hud-api:cancel-task', async (_event, taskId) => {
    cancelTask(taskId);
    return { success: true };
  });

  // HUD items
  ipcMain.handle('hud-api:add-item', async (_event, toolId, item) => {
    return addHUDItem(toolId, item);
  });

  ipcMain.handle('hud-api:remove-item', async (_event, toolId, itemId) => {
    removeHUDItem(toolId, itemId);
    return { success: true };
  });

  ipcMain.handle('hud-api:get-items', async (_event, toolId) => {
    return getHUDItems(toolId);
  });

  ipcMain.handle('hud-api:clear-items', async (_event, toolId) => {
    clearHUDItems(toolId);
    return { success: true };
  });

  // Agent spaces
  ipcMain.handle('hud-api:get-agent-spaces', async () => {
    return getAgentSpaces();
  });

  ipcMain.handle('hud-api:get-agents-in-space', async (_event, spaceId) => {
    return getAgentsInSpace(spaceId);
  });

  ipcMain.handle('hud-api:set-agent-enabled', async (_event, spaceId, agentId, enabled) => {
    await setAgentEnabled(spaceId, agentId, enabled);
    return { success: true };
  });

  ipcMain.handle('hud-api:get-default-space', async (_event, toolId) => {
    return getDefaultSpace(toolId);
  });

  ipcMain.handle('hud-api:set-default-space', async (_event, toolId, spaceId) => {
    await setDefaultSpace(toolId, spaceId);
    return { success: true };
  });

  ipcMain.handle('hud-api:create-agent-space', async (_event, name, config) => {
    return createAgentSpace(name, config);
  });

  ipcMain.handle('hud-api:assign-agent', async (_event, agentId, spaceId, config) => {
    await assignAgentToSpace(agentId, spaceId, config);
    return { success: true };
  });

  ipcMain.handle('hud-api:remove-agent', async (_event, agentId, spaceId) => {
    await removeAgentFromSpace(agentId, spaceId);
    return { success: true };
  });

  // Remote agents
  ipcMain.handle('hud-api:register-remote-agent', async (_event, definition) => {
    return registerRemoteAgent(definition);
  });

  ipcMain.handle('hud-api:test-remote-agent', async (_event, agentId) => {
    return testRemoteAgent(agentId);
  });

  // Disambiguation
  ipcMain.handle('hud-api:select-disambiguation', async (_event, stateId, index) => {
    return selectDisambiguationOption(stateId, index);
  });

  ipcMain.handle('hud-api:cancel-disambiguation', async (_event, stateId) => {
    cancelDisambiguation(stateId);
    return { success: true };
  });

  // Multi-turn conversation
  ipcMain.handle('hud-api:respond-to-input', async (_event, taskId, response) => {
    return respondToInput(taskId, response);
  });

  // Queue statistics
  ipcMain.handle('hud-api:get-queue-stats', async () => {
    return getQueueStats();
  });

  // Transcription
  ipcMain.handle('hud-api:transcribe-audio', async (_event, audioData, opts) => {
    return transcribeAudio(audioData, opts);
  });

  // Speech state (mic gating)
  ipcMain.handle('hud-api:speech-started', async () => {
    speechStarted();
    return { success: true };
  });
  ipcMain.handle('hud-api:speech-ended', async () => {
    speechEnded();
    return { success: true };
  });
  ipcMain.handle('hud-api:is-speaking', async () => {
    return { isSpeaking: isSpeaking() };
  });

  // Transcript quality filter
  ipcMain.handle('hud-api:filter-transcript', async (_event, transcript) => {
    return filterTranscript(transcript);
  });

  log.info('ipc', 'IPC handlers registered');
}

function _broadcastIPC(channel, data) {
  try {
    const windows = BrowserWindow.getAllWindows();
    let sentCount = 0;
    const windowTitles = [];
    windows.forEach((win) => {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send(channel, data);
          sentCount++;
          windowTitles.push(win.getTitle?.()?.slice(0, 20) || `id:${win.id}`);
        } catch (_e) {
          // Window may have been destroyed between check and send
        }
      }
    });
    if (sentCount === 0 && windows.length > 0) {
      log.warn('ipc', 'broadcast failed - 0/ windows received', { channel: channel, windows: windows.length });
    }
  } catch (e) {
    log.warn('ipc', '_broadcastIPC error on', { channel: channel, error: e.message });
  }
}

// ==================== UTILITY ====================

/**
 * Get the space a task was submitted to.
 * @param {string} taskId
 * @returns {string|null}
 */
function getTaskSpace(taskId) {
  return _taskSpaceMap.get(taskId) || null;
}

/**
 * Get the tool that submitted a task.
 * @param {string} taskId
 * @returns {string|null}
 */
function getTaskTool(taskId) {
  return _taskToolMap.get(taskId) || null;
}

/**
 * Register a task-to-tool mapping.
 * Called by the exchange bridge when a task is queued so events
 * can be routed to the correct tool's listeners.
 * @param {string} taskId
 * @param {string} toolId
 */
function setTaskTool(taskId, toolId) {
  if (taskId && toolId) {
    _taskToolMap.set(taskId, toolId);
    _taskTimestamps.set(taskId, Date.now());
  }
}

/**
 * Register a task-to-space mapping.
 * @param {string} taskId
 * @param {string} spaceId
 */
function setTaskSpace(taskId, spaceId) {
  if (taskId && spaceId) {
    _taskSpaceMap.set(taskId, spaceId);
  }
}

// ==================== STALE ENTRY CLEANUP ====================

/**
 * Periodically clean up stale entries from task/state maps.
 * Prevents unbounded memory growth when tasks are orphaned
 * (no result or cancel ever received).
 */
function _cleanupStaleMaps() {
  const now = Date.now();
  let cleanedTasks = 0;
  let cleanedStates = 0;

  // Clean stale task mappings
  for (const [taskId, createdAt] of _taskTimestamps) {
    if (now - createdAt > STALE_TASK_TTL_MS) {
      _taskToolMap.delete(taskId);
      _taskSpaceMap.delete(taskId);
      _taskTimestamps.delete(taskId);
      cleanedTasks++;
    }
  }

  // Clean stale disambiguation states
  for (const [stateId, state] of _disambiguationStates) {
    if (now - state.createdAt > STALE_STATE_TTL_MS) {
      _disambiguationStates.delete(stateId);
      cleanedStates++;
    }
  }

  // Clean stale needs-input requests
  for (const [taskId, request] of _needsInputRequests) {
    if (now - request.createdAt > STALE_STATE_TTL_MS) {
      _needsInputRequests.delete(taskId);
      cleanedStates++;
    }
  }

  if (cleanedTasks > 0 || cleanedStates > 0) {
    log.info('ipc', 'Cleaned up stale entries', { tasks: cleanedTasks, states: cleanedStates });
  }

  // Mirror the sweep in the consolidated task-store so dual-written
  // state doesn't outlive the raw Maps.
  try { getTaskStore().sweep(now); } catch (_err) { /* best-effort mirror */ }
}

/**
 * Start the periodic cleanup interval.
 * Called during initialize().
 */
function _startCleanupInterval() {
  if (_cleanupIntervalId) return;
  // Run every 2 minutes
  _cleanupIntervalId = setInterval(_cleanupStaleMaps, 2 * 60 * 1000);
  // Don't prevent process exit
  if (_cleanupIntervalId.unref) _cleanupIntervalId.unref();
}

// ==================== MODULE EXPORTS ====================

module.exports = {
  // Lifecycle
  initialize,

  // Task submission
  submitTask,
  cancelTask,

  // Events
  onLifecycle,
  onResult,
  offAll,
  emitLifecycle,
  emitResult,

  // Disambiguation
  emitDisambiguation,
  onDisambiguation,
  selectDisambiguationOption,
  cancelDisambiguation,

  // Multi-turn conversation
  emitNeedsInput,
  onNeedsInput,
  respondToInput,

  // HUD items
  addHUDItem,
  removeHUDItem,
  getHUDItems,
  clearHUDItems,

  // Agent space management
  getAgentSpaces,
  getAgentsInSpace,
  getAgentIdsInSpace,
  setAgentEnabled,
  getDefaultSpace,
  setDefaultSpace,
  createAgentSpace,
  assignAgentToSpace,
  removeAgentFromSpace,

  // Remote agents
  registerRemoteAgent,
  testRemoteAgent,

  // Queue statistics
  getQueueStats,

  // Transcription
  transcribeAudio,

  // Speech state (mic gating)
  speechStarted,
  speechEnded,
  isSpeaking,

  // Transcript quality filter
  filterTranscript,

  // Utility
  getTaskSpace,
  getTaskTool,
  setTaskTool,
  setTaskSpace,

  // Testing / internal (exported for test access)
  _cleanupStaleMaps,
  _generateAndSavePlaybook,
};
