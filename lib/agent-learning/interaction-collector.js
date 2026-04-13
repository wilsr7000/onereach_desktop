/**
 * Interaction Collector
 *
 * Subscribes to exchange events and maintains a rolling window of
 * interactions per agent. Computes aggregate signals (failure rate,
 * rephrase rate, UI spec usage) that the opportunity evaluator consumes.
 *
 * Event sources (validated against codebase):
 *   - learning:interaction on exchangeBus  (primary -- emitted from task:settled)
 *   - learning:capability-gap on exchangeBus  (unmet requests)
 *   - logQueue category 'agent'  (errors, warnings)
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const DEFAULT_WINDOW_SIZE = 30;
const REPHRASE_WINDOW_MS = 60000;

class InteractionCollector {
  constructor(opts = {}) {
    this._windowSize = opts.windowSize || DEFAULT_WINDOW_SIZE;
    this._windows = new Map();
    this._unmetRequests = [];
    this._maxUnmetRequests = opts.maxUnmetRequests || 100;
    this._unsubscribers = [];
    this._onEvaluate = opts.onEvaluate || null;
    this._minInteractionsForEval = opts.minInteractionsForEval || 5;
  }

  /**
   * Start listening to events.
   * @param {EventEmitter} exchangeBus - lib/exchange/event-bus
   */
  start(exchangeBus) {
    if (!exchangeBus) {
      log.warn('agent-learning', 'InteractionCollector: no exchangeBus provided');
      return;
    }

    const interactionHandler = (data) => this._onInteraction(data);
    const gapHandler = (data) => this._onCapabilityGap(data);

    exchangeBus.on('learning:interaction', interactionHandler);
    exchangeBus.on('learning:capability-gap', gapHandler);

    this._unsubscribers.push(
      () => exchangeBus.removeListener('learning:interaction', interactionHandler),
      () => exchangeBus.removeListener('learning:capability-gap', gapHandler)
    );

    const logUnsub = log.subscribe({ category: 'agent' }, (entry) => {
      if (entry.level === 'error' || entry.level === 'warn') {
        this._onAgentLogEntry(entry);
      }
    });
    this._unsubscribers.push(logUnsub);

    log.info('agent-learning', 'InteractionCollector started');
  }

  stop() {
    for (const unsub of this._unsubscribers) {
      try { unsub(); } catch (_) { /* ignore */ }
    }
    this._unsubscribers.length = 0;
    log.info('agent-learning', 'InteractionCollector stopped');
  }

  _onInteraction(data) {
    const { agentId } = data;
    if (!agentId) return;

    const win = this._getOrCreateWindow(agentId);
    const interaction = {
      taskId: data.taskId,
      timestamp: data.timestamp || Date.now(),
      userInput: data.userInput || '',
      success: data.success !== false,
      message: data.message || '',
      error: data.error || null,
      responseTimeMs: data.durationMs || 0,
      hadUISpec: !!data.hasUI,
      followUpAction: null,
    };

    this._detectRephrase(win, interaction);

    win.interactions.push(interaction);
    if (win.interactions.length > this._windowSize) {
      win.interactions.shift();
    }

    this._recomputeSignals(win);

    if (
      this._onEvaluate &&
      win.interactions.length >= this._minInteractionsForEval
    ) {
      this._onEvaluate(agentId, this.getWindow(agentId));
    }
  }

  _onCapabilityGap(data) {
    const entry = {
      userInput: data.userInput || '',
      timestamp: data.timestamp || Date.now(),
      gapSummary: data.gapSummary || data.userInput || '',
    };

    this._unmetRequests.push(entry);
    if (this._unmetRequests.length > this._maxUnmetRequests) {
      this._unmetRequests.shift();
    }
  }

  _onAgentLogEntry(_entry) {
    // Agent-category log entries enrich the window with error context
    // but don't create new interactions (those come from learning:interaction)
  }

  _detectRephrase(win, interaction) {
    if (win.interactions.length === 0) return;

    const prev = win.interactions[win.interactions.length - 1];
    const timeDelta = interaction.timestamp - prev.timestamp;

    if (timeDelta < REPHRASE_WINDOW_MS && !prev.success) {
      interaction.followUpAction = 'rephrase';
    }
  }

  _recomputeSignals(win) {
    const items = win.interactions;
    if (items.length === 0) {
      win.failureRate = 0;
      win.avgResponseTimeMs = 0;
      win.uiSpecRate = 0;
      win.rephraseRate = 0;
      return;
    }

    const failures = items.filter((i) => !i.success).length;
    win.failureRate = failures / items.length;

    const totalTime = items.reduce((s, i) => s + (i.responseTimeMs || 0), 0);
    win.avgResponseTimeMs = Math.round(totalTime / items.length);

    const withUI = items.filter((i) => i.hadUISpec).length;
    win.uiSpecRate = withUI / items.length;

    const rephrases = items.filter((i) => i.followUpAction === 'rephrase').length;
    win.rephraseRate = rephrases / items.length;
  }

  _getOrCreateWindow(agentId) {
    if (!this._windows.has(agentId)) {
      this._windows.set(agentId, {
        agentId,
        interactions: [],
        failureRate: 0,
        avgResponseTimeMs: 0,
        uiSpecRate: 0,
        rephraseRate: 0,
        routingAccuracy: 1.0,
      });
    }
    return this._windows.get(agentId);
  }

  getWindow(agentId) {
    return this._windows.get(agentId) || null;
  }

  getAllWindows() {
    return Array.from(this._windows.values());
  }

  getUnmetRequests() {
    return this._unmetRequests.slice();
  }

  getAgentsNeedingEvaluation(minInteractions) {
    const min = minInteractions || this._minInteractionsForEval;
    return this.getAllWindows().filter((w) => w.interactions.length >= min);
  }

  clear() {
    this._windows.clear();
    this._unmetRequests.length = 0;
  }
}

module.exports = { InteractionCollector };
