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
    const slowHandler = (data) => this._onSlowSuccess(data);
    const negFeedbackHandler = (data) => this._onNegativeFeedback(data);
    const reflectionHandler = (data) => this._onReflection(data);

    exchangeBus.on('learning:interaction', interactionHandler);
    exchangeBus.on('learning:capability-gap', gapHandler);
    exchangeBus.on('learning:slow-success', slowHandler);
    exchangeBus.on('learning:negative-feedback', negFeedbackHandler);
    exchangeBus.on('learning:reflection', reflectionHandler);

    this._unsubscribers.push(
      () => exchangeBus.removeListener('learning:interaction', interactionHandler),
      () => exchangeBus.removeListener('learning:capability-gap', gapHandler),
      () => exchangeBus.removeListener('learning:slow-success', slowHandler),
      () => exchangeBus.removeListener('learning:negative-feedback', negFeedbackHandler),
      () => exchangeBus.removeListener('learning:reflection', reflectionHandler)
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

  /**
   * User explicitly told us the last answer was wrong. This is the
   * strongest quality signal we get. Counts heavily against the agent
   * that produced the bad answer -- we mark the last interaction as
   * a failure (success=false) so the failureRate signal picks it up.
   */
  _onNegativeFeedback(data) {
    const agentId = data?.targetedAgentId;
    if (!agentId) return;
    const win = this._getOrCreateWindow(agentId);
    if (win.interactions.length === 0) return;
    const last = win.interactions[win.interactions.length - 1];
    last.success = false;
    last.followUpAction = 'negative-feedback';
    last.error = 'user_negative_feedback';
    this._recomputeSignals(win);
    log.info('agent-learning', 'Negative feedback applied to last interaction', {
      agent: agentId,
    });
  }

  /**
   * Reflection judgment (LLM-as-judge). Low-quality answers flip the
   * corresponding interaction's success flag to false so the learning
   * loop treats silent quality failures the same as explicit failures.
   */
  _onReflection(data) {
    if (!data || !data.agentId || !data.taskId) return;
    const win = this._windows.get(data.agentId);
    if (!win) return;
    const entry = win.interactions.find((i) => i.taskId === data.taskId);
    if (!entry) return;
    entry.reflectionOverall = data.overall;
    entry.reflectionScores = data.scores;
    entry.reflectionIssues = data.issues;
    if (data.lowQuality) {
      entry.success = false;
      entry.error = entry.error || 'low_quality_answer';
      this._recomputeSignals(win);
      log.info('agent-learning', 'Reflection marked interaction as low-quality', {
        agent: data.agentId,
        overall: data.overall,
      });
    }
  }

  /**
   * A task succeeded, but only after one or more agents busted first.
   * Treat this as a partial capability gap: the user got an answer, but
   * the system routed poorly. We track these separately so the opportunity
   * evaluator can propose either (a) a better bid scoring for the winning
   * agent or (b) a new purpose-built agent for this task class.
   */
  _onSlowSuccess(data) {
    const entry = {
      userInput: data.userInput || '',
      timestamp: data.timestamp || Date.now(),
      gapSummary: `Slow success: ${data.bustCount} bust(s) before ${data.winningAgentId} succeeded`,
      slowSuccess: true,
      winningAgentId: data.winningAgentId,
      bustCount: data.bustCount || 0,
      bustedAgents: data.bustedAgents || [],
      totalDurationMs: data.totalDurationMs || 0,
    };

    this._unmetRequests.push(entry);
    if (this._unmetRequests.length > this._maxUnmetRequests) {
      this._unmetRequests.shift();
    }

    log.info('agent-learning', 'Slow success recorded', {
      winningAgent: data.winningAgentId,
      bustCount: data.bustCount,
      totalMs: data.totalDurationMs,
    });
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
