/**
 * Council Runner
 *
 * Orchestrates an auction variant where ALL qualifying bidders
 * contribute to the final result, not just the single highest bid.
 * Feeds the existing `lib/evaluation/consolidator.js` (weighted scoring,
 * conflict detection, epistemic framing) with bids translated by
 * `lib/exchange/council-adapter.js`.
 *
 * This module is opt-in behind the `councilMode` feature flag in
 * `lib/agent-system-flags.js`. When a task's `variant` is 'council' and
 * the flag is on, the caller (hud-api or exchange-bridge) invokes
 * `runCouncil(task, agents)` instead of `exchange.submit(...)`.
 *
 *   Today's single-winner auction:  agents bid -> top bid executes -> result
 *   Council mode:                   agents bid -> all >= floor execute
 *                                   in parallel -> consolidator produces
 *                                   { aggregateScore, conflicts, suggestions,
 *                                     agentScores, epistemicFraming }
 *
 * Only built-in agents with `executionType === 'informational'` are
 * executed by default. Action agents (side effects, external writes)
 * only contribute their bid -- running them in parallel would create N
 * writes for a single task, which is rarely what council mode means.
 * Callers can override this via `options.allowActionAgents`.
 */

'use strict';

const { getBidsFromAgents } = require('../../packages/agents/unified-bidder');
const { EvaluationConsolidator } = require('../evaluation/consolidator');
const { AgentWeightingManager } = require('../evaluation/weighting');
const { bidsToEvaluations, buildConsolidateContext } = require('./council-adapter');
const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

// Execution concurrency for parallel agent runs. 5 is plenty for real
// workloads; most councils run 2-4 agents in practice.
const DEFAULT_MAX_PARALLEL = 5;
const DEFAULT_EXECUTION_TIMEOUT_MS = 20_000;
const DEFAULT_CONFIDENCE_FLOOR = 0.5;

/**
 * @typedef {Object} CouncilResult
 * @property {number} aggregateScore       0-100 weighted aggregate
 * @property {string} confidence           'low' | 'medium' | 'high' (from consolidator)
 * @property {Array}  agentScores          per-agent score breakdown
 * @property {Array}  consolidatedCriteria per-criterion weighted scores
 * @property {Array}  conflicts            detected score conflicts
 * @property {Array}  suggestions          merged agent suggestions
 * @property {Array}  bids                 raw bids that participated
 * @property {number} bidCount             count of qualifying bids
 * @property {string} weightingMode        'uniform' | 'contextual' | 'learned' | 'user_biased'
 * @property {Object} epistemicFraming     full consolidator framing block
 * @property {Object} [error]              present if the run failed early
 */

/**
 * Run a council-mode auction.
 *
 * @param {Object} task - Canonical task (from lib/task.js buildTask)
 * @param {Array}  agents - Eligible agent list (built-in + remote, already
 *                          filtered by space/role policy by the caller)
 * @param {Object} [options]
 * @param {number} [options.confidenceFloor=0.5]
 * @param {number} [options.maxParallel=5]
 * @param {number} [options.executionTimeoutMs=20000]
 * @param {boolean} [options.allowActionAgents=false]
 * @param {string} [options.weightingMode='uniform'] - 'uniform' | 'contextual' |
 *                                                     'learned' | 'user_biased'
 * @param {Function} [options.onLifecycle] - optional callback(event) for
 *                                            'bids-collected' | 'execution:started'
 *                                            | 'execution:done' | 'consolidation:done'
 * @param {Function} [options.executeAgent] - optional executor override so
 *                                             callers can inject safe-execute
 *                                             wrappers (exchange-bridge already
 *                                             has one). Default is the agent's
 *                                             own execute(task).
 * @param {Function} [options.getBids] - optional bid-collector override.
 *                                       Defaults to unified-bidder's
 *                                       getBidsFromAgents. Exposed so tests
 *                                       and alternative bidders (e.g. Phase 4
 *                                       per-criterion bidding) can plug in.
 * @param {Function} [options.askUser] - Phase 4 bid-time clarification hook.
 *                                        Signature:
 *                                          async ({ question, fromAgentId, taskId })
 *                                            -> string | null
 *                                        Return a user's answer (or null to
 *                                        skip). Only invoked when one or
 *                                        more bids return `needsClarification`
 *                                        AND the `bidTimeClarification` flag
 *                                        is on. If omitted, clarification
 *                                        requests are ignored (bids proceed
 *                                        as-is).
 * @param {number} [options.maxClarifyRounds=1] - Max number of bid-time
 *                                                 clarification rounds before
 *                                                 giving up. Default 1.
 * @returns {Promise<CouncilResult>}
 */
async function runCouncil(task, agents, options = {}) {
  const floor = typeof options.confidenceFloor === 'number' ? options.confidenceFloor : DEFAULT_CONFIDENCE_FLOOR;
  const maxParallel = Math.max(1, options.maxParallel || DEFAULT_MAX_PARALLEL);
  const timeoutMs = options.executionTimeoutMs || DEFAULT_EXECUTION_TIMEOUT_MS;
  const allowActionAgents = Boolean(options.allowActionAgents);
  const weightingMode = options.weightingMode || 'uniform';
  const emit = typeof options.onLifecycle === 'function' ? options.onLifecycle : null;
  const collectBids = typeof options.getBids === 'function' ? options.getBids : getBidsFromAgents;
  const askUser = typeof options.askUser === 'function' ? options.askUser : null;
  const maxClarifyRounds = typeof options.maxClarifyRounds === 'number' ? options.maxClarifyRounds : 1;

  if (!task || typeof task !== 'object') {
    throw new TypeError('runCouncil: task is required');
  }
  if (!Array.isArray(agents) || agents.length === 0) {
    return _emptyResult(task, 'No eligible agents');
  }

  log.info('agent', '[Council] Starting auction', {
    taskId: task.id,
    agentCount: agents.length,
    variant: task.variant || 'council',
  });

  // 1. Collect bids via the existing unified-bidder pipeline (or an
  //    injected collector for tests / alternative bidders). Phase 4
  //    loop: when any bid returns `needsClarification` and an askUser
  //    handler is available, pause, ask the user, and re-collect bids
  //    with the answer folded into the task context. Bounded by
  //    maxClarifyRounds to prevent runaway loops.
  let bids;
  let workingTask = task;
  let rounds = 0;
  try {
    bids = await collectBids(agents, workingTask);

    while (askUser && rounds < maxClarifyRounds) {
      const pending = (bids || []).find((b) => b && b.needsClarification && b.needsClarification.question);
      if (!pending) break;

      rounds += 1;
      if (emit) {
        try {
          emit({
            type: 'bid:needs-clarification',
            taskId: workingTask.id,
            fromAgentId: pending.agentId,
            question: pending.needsClarification.question,
            blocks: pending.needsClarification.blocks || null,
            round: rounds,
          });
        } catch (_err) { /* observer must never throw */ }
      }

      let answer = null;
      try {
        answer = await askUser({
          question: pending.needsClarification.question,
          fromAgentId: pending.agentId,
          taskId: workingTask.id,
        });
      } catch (err) {
        log.warn('agent', '[Council] askUser threw; proceeding without answer', {
          error: err.message,
        });
      }

      if (typeof answer !== 'string' || !answer.trim()) break;

      // Fold the clarification into the task metadata so the next
      // bid-prompt composition sees it. Keep the original content and
      // criteria intact -- we only enrich.
      const clarifications = Array.isArray(workingTask.metadata?.clarifications)
        ? [...workingTask.metadata.clarifications]
        : [];
      clarifications.push({
        question: pending.needsClarification.question,
        answer: answer.trim(),
        fromAgentId: pending.agentId,
      });
      workingTask = {
        ...workingTask,
        metadata: {
          ...(workingTask.metadata || {}),
          clarifications,
          conversationText: [
            workingTask.metadata?.conversationText || '',
            `Assistant: ${pending.needsClarification.question}`,
            `User: ${answer.trim()}`,
          ].filter(Boolean).join('\n'),
        },
      };

      bids = await collectBids(agents, workingTask);
    }
  } catch (err) {
    log.error('agent', '[Council] Bid collection failed', { error: err.message });
    return _emptyResult(task, `Bid collection failed: ${err.message}`);
  }

  const qualifying = (bids || []).filter((b) => Number(b.confidence) >= floor);
  if (emit) {
    try {
      emit({
        type: 'bids-collected',
        taskId: workingTask.id,
        bidCount: qualifying.length,
        allCount: (bids || []).length,
        clarifyRounds: rounds,
        bids: qualifying.map((b) => ({
          agentId: b.agentId,
          confidence: b.confidence,
          reasoning: (b.reasoning || '').slice(0, 160),
        })),
      });
    } catch (_err) { /* lifecycle emit must never throw */ }
  }

  if (qualifying.length === 0) {
    return _emptyResult(workingTask, 'No bids cleared the confidence floor');
  }

  // 2. Decide who actually executes. Informational-only by default.
  const executors = qualifying.filter((b) => {
    const agent = agents.find((a) => (a.id || a.name) === b.agentId);
    if (!agent) return false;
    if (allowActionAgents) return true;
    const t = agent.executionType || 'informational';
    return t === 'informational';
  });

  // 3. Run executors in parallel, respecting maxParallel and timeout.
  const executionResults = new Map();
  const exec = typeof options.executeAgent === 'function'
    ? options.executeAgent
    : _defaultExecuteAgent;

  if (emit) {
    try { emit({ type: 'execution:started', taskId: workingTask.id, count: executors.length }); }
    catch (_err) { /* noop */ }
  }

  const batches = _chunk(executors, maxParallel);
  for (const batch of batches) {
    const results = await Promise.all(batch.map(async (b) => {
      const agent = agents.find((a) => (a.id || a.name) === b.agentId);
      if (!agent) return { agentId: b.agentId, error: 'agent-not-found' };
      try {
        const result = await _withTimeout(exec(agent, workingTask), timeoutMs,
          `execution timed out after ${timeoutMs}ms`);
        return { agentId: b.agentId, result };
      } catch (err) {
        return { agentId: b.agentId, error: err.message || String(err) };
      }
    }));
    for (const r of results) {
      if (r.result) executionResults.set(r.agentId, r.result);
      else executionResults.set(r.agentId, { success: false, message: r.error });
    }
  }

  if (emit) {
    try {
      emit({
        type: 'execution:done',
        taskId: workingTask.id,
        count: executionResults.size,
      });
    } catch (_err) { /* noop */ }
  }

  // 4. Translate to evaluation entries and consolidate.
  const evaluations = bidsToEvaluations(qualifying, {
    criteria: workingTask.criteria,
    executionResults,
    confidenceFloor: floor,
  });

  const weightingManager = new AgentWeightingManager({ mode: weightingMode });
  const consolidator = new EvaluationConsolidator({ weightingManager });
  const context = buildConsolidateContext(workingTask, { weightingMode });

  let consolidated;
  try {
    consolidated = await consolidator.consolidate(evaluations, context);
  } catch (err) {
    log.error('agent', '[Council] Consolidation failed', { error: err.message });
    return _emptyResult(workingTask, `Consolidation failed: ${err.message}`);
  }

  if (emit) {
    try {
      emit({
        type: 'consolidation:done',
        taskId: workingTask.id,
        aggregateScore: consolidated.aggregateScore,
        conflictCount: (consolidated.conflicts || []).length,
      });
    } catch (_err) { /* noop */ }
  }

  if (emit && (consolidated.conflicts || []).length > 0) {
    try {
      emit({
        type: 'consolidation:conflicts',
        taskId: workingTask.id,
        conflicts: consolidated.conflicts.map((c) => ({
          criterion: c.criterion,
          spread: c.spread,
          high: c.highScorer?.agentType,
          low: c.lowScorer?.agentType,
        })),
      });
    } catch (_err) { /* noop */ }
  }

  return {
    taskId: workingTask.id,
    aggregateScore: consolidated.aggregateScore,
    confidence: consolidated.confidence,
    agentScores: consolidated.agentScores,
    consolidatedCriteria: consolidated.consolidatedCriteria,
    conflicts: consolidated.conflicts,
    suggestions: consolidated.suggestions,
    bids: qualifying.map((b) => ({
      agentId: b.agentId,
      agentName: b.agentName || b.agentId,
      confidence: b.confidence,
      reasoning: b.reasoning,
    })),
    bidCount: qualifying.length,
    clarifyRounds: rounds,
    weightingMode: consolidated.epistemicFraming?.weightingMode || weightingMode,
    epistemicFraming: consolidated.epistemicFraming,
    evaluations, // surfaced so HUD renderer can show per-agent detail
  };
}

// ==================== INTERNAL ====================

function _emptyResult(task, reason) {
  return {
    taskId: task?.id || null,
    aggregateScore: 0,
    confidence: 'low',
    agentScores: [],
    consolidatedCriteria: [],
    conflicts: [],
    suggestions: [],
    bids: [],
    bidCount: 0,
    weightingMode: 'uniform',
    epistemicFraming: null,
    evaluations: [],
    error: { reason },
  };
}

async function _defaultExecuteAgent(agent, task) {
  if (!agent || typeof agent.execute !== 'function') {
    return { success: false, message: 'agent has no execute()' };
  }
  return agent.execute(task);
}

function _withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

function _chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

module.exports = {
  runCouncil,
  DEFAULT_CONFIDENCE_FLOOR,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_EXECUTION_TIMEOUT_MS,
};
