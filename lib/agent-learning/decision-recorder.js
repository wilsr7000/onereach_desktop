/**
 * Decision Recorder (Phase 1 of self-learning arbitration)
 *
 * Records every settled task as an item in the `arbitration-decisions`
 * Space, with the full bid roster and decision metadata. Joins later
 * quality signals (reflector score, user negative feedback, Phase 2's
 * counterfactual judgment) onto the same item by taskId.
 *
 * Why a Space and not a streaming buffer:
 *   - Auditability. The user can browse what the system observed.
 *   - Decoupled compute. The Phase 4 tuner and Phase 5 calibrator read
 *     this Space offline; they don't need to live in the auction's hot
 *     path or even on the same process.
 *   - Retention is a pruning sweep, not a buffer eviction policy.
 *   - Privacy controls (redaction, opt-out, retention cap) are first-
 *     class because Spaces already support per-item metadata + tags.
 *
 * Event flow:
 *   learning:interaction              -> create item with bids + outcome.success
 *   learning:reflection               -> set outcome.reflectorScore/Issues
 *   learning:negative-feedback        -> set outcome.userFeedback
 *   learning:counterfactual-judgment  -> set outcome.counterfactualJudgment
 *
 * Out-of-order events are tolerated. The reflector and counterfactual
 * judge can lag by seconds; user negative feedback can lag by minutes.
 * Late events arriving for an item that no longer exists (e.g. the
 * recorder was disabled, or retention pruned the item) are dropped
 * with a single warn log line.
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();
const { redactDecision } = require('./decision-redactor');

const ARBITRATION_SPACE_ID = 'arbitration-decisions';
const ARBITRATION_SPACE_NAME = 'Arbitration Decisions';
const ITEM_TYPE = 'arbitration-decision';
const TAG = 'arbitration-decision';

// Buffer events for items that haven't been created yet (e.g. reflector
// fires before learning:interaction). Bounded so a runaway event stream
// can't blow memory.
const PENDING_BUFFER_TTL_MS = 30_000;
const PENDING_BUFFER_MAX = 500;

let _spacesAPI = null;
let _spacesAPIInitialized = false;
function _getSpacesAPI() {
  if (!_spacesAPIInitialized) {
    try {
      const { getSpacesAPI } = require('../../spaces-api');
      _spacesAPI = getSpacesAPI();
    } catch (err) {
      log.warn('agent-learning', '[DecisionRecorder] Spaces API unavailable', { error: err.message });
      _spacesAPI = null;
    }
    _spacesAPIInitialized = true;
  }
  return _spacesAPI;
}

let _settingsManager = null;
function _getSettings() {
  if (_settingsManager === null) {
    try {
      _settingsManager = global.settingsManager || null;
    } catch (_) {
      _settingsManager = null;
    }
  }
  return _settingsManager;
}

function _isEnabled() {
  const s = _getSettings();
  if (!s) return true; // default ON when settings not available (tests, headless)
  const v = s.get('arbitrationDecisions.enabled');
  return v !== false; // any non-false (undefined/true) = enabled
}

function _isRedacted() {
  const s = _getSettings();
  if (!s) return false; // default OFF in headless / dev so test data is readable
  return s.get('arbitrationDecisions.redactedRecording') === true;
}

/**
 * Ensure the arbitration-decisions Space exists. Idempotent.
 * Mirrors lib/agent-learning/playbook-writer.js ensurePMSpace.
 */
async function ensureArbitrationSpace() {
  try {
    const api = _getSpacesAPI();
    if (!api) return false;
    const storage = api.storage || api._storage;
    if (!storage) return false;

    const spaces = storage.index?.spaces || [];
    const exists = spaces.find((s) => s.id === ARBITRATION_SPACE_ID);
    if (exists) return true;

    storage.createSpace({
      id: ARBITRATION_SPACE_ID,
      name: ARBITRATION_SPACE_NAME,
      icon: '○',
      color: '#10b981',
      isSystem: true,
    });
    log.info('agent-learning', '[DecisionRecorder] Created arbitration-decisions space');
    return true;
  } catch (err) {
    log.warn('agent-learning', '[DecisionRecorder] Could not ensure arbitration space', {
      error: err.message,
    });
    return false;
  }
}

/**
 * In-memory map: taskId -> itemId. Lets us update an existing item
 * without scanning the Space on every signal join.
 */
const _taskToItem = new Map();

/**
 * Buffer for signals that arrive before the item is created.
 * Map<taskId, Array<{ kind, payload, ts }>>. Pruned on sweep.
 */
const _pendingSignals = new Map();

function _bufferSignal(taskId, kind, payload) {
  if (!taskId) return;
  if (_pendingSignals.size >= PENDING_BUFFER_MAX) {
    // Drop the oldest entry to bound memory.
    const oldestKey = _pendingSignals.keys().next().value;
    if (oldestKey !== undefined) _pendingSignals.delete(oldestKey);
  }
  const entry = _pendingSignals.get(taskId) || [];
  entry.push({ kind, payload, ts: Date.now() });
  _pendingSignals.set(taskId, entry);
}

function _flushPending(taskId, itemId) {
  const entries = _pendingSignals.get(taskId);
  if (!entries) return;
  _pendingSignals.delete(taskId);
  for (const { kind, payload } of entries) {
    _applySignalToItem(itemId, kind, payload);
  }
}

function _prunePending() {
  const now = Date.now();
  for (const [taskId, entries] of Array.from(_pendingSignals.entries())) {
    const fresh = entries.filter((e) => now - e.ts < PENDING_BUFFER_TTL_MS);
    if (fresh.length === 0) {
      _pendingSignals.delete(taskId);
    } else if (fresh.length !== entries.length) {
      _pendingSignals.set(taskId, fresh);
    }
  }
}

/**
 * Build the canonical decision item shape from a learning:interaction
 * event. Outcome fields that get filled by later joins start as null
 * so a downstream consumer can distinguish "not graded yet" from
 * "graded zero".
 */
function _buildDecisionPayload(data) {
  const payload = {
    type: ITEM_TYPE,
    taskId: data.taskId,
    content: data.userInput || '',
    situationContext: data.situationContext || null,
    bids: Array.isArray(data.bids) ? data.bids.map((b) => ({
      agentId: b.agentId,
      agentName: b.agentName,
      confidence: typeof b.confidence === 'number' ? b.confidence : 0,
      score: typeof b.score === 'number' ? b.score : (typeof b.confidence === 'number' ? b.confidence : 0),
      reasoning: typeof b.reasoning === 'string' ? b.reasoning : '',
      won: !!b.won,
      busted: !!b.busted,
    })) : [],
    chosenWinner: data.agentId || null,
    executionMode: data.executionMode || 'single',
    decisionPath: data.decisionPath || 'unknown',
    outcome: {
      success: data.success !== false,
      durationMs: data.durationMs || 0,
      bustCount: data.bustCount || 0,
      error: data.error || null,
      reflectorScore: null,
      reflectorIssues: null,
      userFeedback: null,
      counterfactualJudgment: null,
      counterfactualConfidence: null,
    },
    createdAt: data.timestamp || Date.now(),
    updatedAt: data.timestamp || Date.now(),
  };
  return _isRedacted() ? redactDecision(payload).redacted : payload;
}

/**
 * Apply a join signal to an existing item by reading current content,
 * merging the field, writing back. Best-effort.
 */
function _applySignalToItem(itemId, kind, payload) {
  try {
    const api = _getSpacesAPI();
    if (!api) return;
    const storage = api.storage || api._storage;
    if (!storage || typeof storage.updateItemIndex !== 'function') return;

    const item = (storage.index?.items || []).find((i) => i.id === itemId);
    if (!item) return;

    let decision;
    try {
      decision = JSON.parse(item.content);
    } catch (_e) {
      // Content not parseable; refuse to mutate.
      return;
    }
    if (!decision.outcome || typeof decision.outcome !== 'object') {
      decision.outcome = {};
    }

    switch (kind) {
      case 'reflection':
        if (typeof payload.overall === 'number') {
          decision.outcome.reflectorScore = payload.overall;
        }
        if (Array.isArray(payload.issues)) {
          decision.outcome.reflectorIssues = payload.issues.slice(0, 8);
        }
        break;
      case 'negative-feedback':
        decision.outcome.userFeedback = 'wrong';
        if (typeof payload.source === 'string') {
          decision.outcome.userFeedbackSource = payload.source;
        }
        break;
      case 'counterfactual-judgment':
        if (typeof payload.judgment === 'string') {
          decision.outcome.counterfactualJudgment = payload.judgment;
        }
        if (typeof payload.confidence === 'number') {
          decision.outcome.counterfactualConfidence = payload.confidence;
        }
        break;
      default:
        return;
    }

    decision.updatedAt = Date.now();
    storage.updateItemIndex(itemId, {
      content: JSON.stringify(decision),
    });
  } catch (err) {
    log.warn('agent-learning', '[DecisionRecorder] Apply signal failed', {
      kind,
      error: err.message,
    });
  }
}

/**
 * Handle learning:interaction by creating a new item.
 */
async function _onInteraction(data) {
  if (!_isEnabled()) return;
  if (!data || !data.taskId) return;

  const ok = await ensureArbitrationSpace();
  if (!ok) return;

  const decision = _buildDecisionPayload(data);

  try {
    const api = _getSpacesAPI();
    const storage = api?.storage || api?._storage;
    if (!storage) return;

    const item = storage.addItem({
      type: 'text',
      content: JSON.stringify(decision),
      spaceId: ARBITRATION_SPACE_ID,
      timestamp: decision.createdAt,
      metadata: {
        title: `Decision ${decision.taskId} -> ${decision.chosenWinner || 'unknown'}`,
        itemType: ITEM_TYPE,
        taskId: decision.taskId,
        chosenWinner: decision.chosenWinner,
        decisionPath: decision.decisionPath,
        executionMode: decision.executionMode,
        bidCount: decision.bids.length,
        success: decision.outcome.success,
      },
      tags: [TAG, decision.decisionPath].filter(Boolean),
    });

    if (item && item.id) {
      _taskToItem.set(decision.taskId, item.id);
      _flushPending(decision.taskId, item.id);
    }
  } catch (err) {
    log.warn('agent-learning', '[DecisionRecorder] Failed to record interaction', {
      taskId: data.taskId,
      error: err.message,
    });
  }

  // Bounded map: drop the oldest entries when the map gets too large.
  // 5000 is generous; entries get pruned naturally by the curator.
  if (_taskToItem.size > 5000) {
    const drop = _taskToItem.size - 5000;
    let i = 0;
    for (const k of Array.from(_taskToItem.keys())) {
      if (i++ >= drop) break;
      _taskToItem.delete(k);
    }
  }

  _prunePending();
}

function _onReflection(data) {
  if (!_isEnabled()) return;
  if (!data || !data.taskId) return;
  const itemId = _taskToItem.get(data.taskId);
  if (!itemId) {
    _bufferSignal(data.taskId, 'reflection', data);
    return;
  }
  _applySignalToItem(itemId, 'reflection', data);
}

function _onNegativeFeedback(data) {
  if (!_isEnabled()) return;
  // Negative feedback can target a specific message-by-agent rather than
  // a taskId. Try taskId first; if absent, no-op (this signal already
  // flows into agent memory via the existing handler in index.js).
  const taskId = data?.taskId || null;
  if (!taskId) return;
  const itemId = _taskToItem.get(taskId);
  if (!itemId) {
    _bufferSignal(taskId, 'negative-feedback', data);
    return;
  }
  _applySignalToItem(itemId, 'negative-feedback', data);
}

function _onCounterfactual(data) {
  if (!_isEnabled()) return;
  if (!data || !data.taskId) return;
  const itemId = _taskToItem.get(data.taskId);
  if (!itemId) {
    _bufferSignal(data.taskId, 'counterfactual-judgment', data);
    return;
  }
  _applySignalToItem(itemId, 'counterfactual-judgment', data);
}

let _started = false;
let _unsubs = [];

/**
 * Start the recorder. Subscribes to all relevant learning events.
 *
 * @param {EventEmitter} exchangeBus
 */
function startDecisionRecorder(exchangeBus) {
  if (_started) return;
  if (!exchangeBus || typeof exchangeBus.on !== 'function') {
    log.warn('agent-learning', '[DecisionRecorder] No exchangeBus provided; not starting');
    return;
  }

  const interactionHandler = (d) => { _onInteraction(d).catch(() => {}); };
  const reflectionHandler = (d) => _onReflection(d);
  const negFbHandler = (d) => _onNegativeFeedback(d);
  const counterfactualHandler = (d) => _onCounterfactual(d);

  exchangeBus.on('learning:interaction', interactionHandler);
  exchangeBus.on('learning:reflection', reflectionHandler);
  exchangeBus.on('learning:negative-feedback', negFbHandler);
  exchangeBus.on('learning:counterfactual-judgment', counterfactualHandler);

  _unsubs = [
    () => exchangeBus.removeListener('learning:interaction', interactionHandler),
    () => exchangeBus.removeListener('learning:reflection', reflectionHandler),
    () => exchangeBus.removeListener('learning:negative-feedback', negFbHandler),
    () => exchangeBus.removeListener('learning:counterfactual-judgment', counterfactualHandler),
  ];

  _started = true;
  log.info('agent-learning', '[DecisionRecorder] Started');
}

function stopDecisionRecorder() {
  for (const u of _unsubs) {
    try { u(); } catch (_) { /* unsub best-effort */ }
  }
  _unsubs = [];
  _taskToItem.clear();
  _pendingSignals.clear();
  _started = false;
}

/**
 * Retention sweep: delete arbitration-decision items older than the
 * configured retention window. Called from the existing 6-hour curator
 * interval in lib/agent-learning/index.js.
 *
 * @param {object} [opts]
 * @param {number} [opts.retentionDays] - override the setting
 * @returns {Promise<{ checked: number, pruned: number }>}
 */
async function pruneStaleDecisions(opts = {}) {
  let retentionDays = opts.retentionDays;
  if (typeof retentionDays !== 'number') {
    const s = _getSettings();
    retentionDays = (s && s.get('arbitrationDecisions.retentionDays')) || 90;
  }
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) retentionDays = 90;

  try {
    const api = _getSpacesAPI();
    const storage = api?.storage || api?._storage;
    if (!storage || typeof storage.deleteItem !== 'function') {
      return { checked: 0, pruned: 0 };
    }

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const items = (storage.index?.items || []).filter(
      (i) => i.spaceId === ARBITRATION_SPACE_ID
    );

    let pruned = 0;
    for (const item of items) {
      const ts = typeof item.timestamp === 'number' ? item.timestamp : null;
      if (ts === null) continue;
      if (ts >= cutoff) continue;
      try {
        storage.deleteItem(item.id);
        // Drop the in-memory join map entry too.
        for (const [taskId, mappedId] of _taskToItem.entries()) {
          if (mappedId === item.id) { _taskToItem.delete(taskId); break; }
        }
        pruned += 1;
      } catch (err) {
        log.warn('agent-learning', '[DecisionRecorder] Failed to delete stale item', {
          itemId: item.id,
          error: err.message,
        });
      }
    }

    log.info('agent-learning', '[DecisionRecorder] Retention sweep complete', {
      checked: items.length,
      pruned,
      retentionDays,
    });
    return { checked: items.length, pruned };
  } catch (err) {
    log.warn('agent-learning', '[DecisionRecorder] Retention sweep failed', {
      error: err.message,
    });
    return { checked: 0, pruned: 0 };
  }
}

/** For testing */
function _getState() {
  return {
    started: _started,
    taskToItemSize: _taskToItem.size,
    pendingSize: _pendingSignals.size,
  };
}

function _setTestDeps(deps) {
  if (deps.spacesAPI !== undefined) {
    _spacesAPI = deps.spacesAPI;
    _spacesAPIInitialized = true;
  }
  if (deps.settingsManager !== undefined) _settingsManager = deps.settingsManager;
}

function _resetForTests() {
  _spacesAPI = null;
  _spacesAPIInitialized = false;
  _settingsManager = null;
  _taskToItem.clear();
  _pendingSignals.clear();
  _unsubs = [];
  _started = false;
}

module.exports = {
  ARBITRATION_SPACE_ID,
  ARBITRATION_SPACE_NAME,
  ITEM_TYPE,
  TAG,
  ensureArbitrationSpace,
  startDecisionRecorder,
  stopDecisionRecorder,
  pruneStaleDecisions,
  _onInteraction,
  _onReflection,
  _onNegativeFeedback,
  _onCounterfactual,
  _getState,
  _setTestDeps,
  _resetForTests,
};
