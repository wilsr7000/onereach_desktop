/**
 * Council Adapter
 *
 * Translates built-in agent bids from `packages/agents/unified-bidder.js`
 * into the evaluation shape expected by
 * `lib/evaluation/consolidator.js`.
 *
 * The consolidator was built for dynamically-generated EvalAgents (with
 * agentType keys like "expert", "reviewer") that return structured
 * per-criterion evaluations. Built-in agents return compact bids
 * (`{ confidence, reasoning, plan, hallucinationRisk, result }`) plus
 * whatever their `execute()` produced.
 *
 * This module is the bridge:
 *   - Bid -> evaluation entry  (confidence * 100 = overallScore)
 *   - Reasoning -> concerns / strengths (simple heuristic split)
 *   - Task criteria -> per-criterion scores (in Phase 1, each criterion
 *     gets the overall score; Phase 4's per-criterion bidding replaces
 *     this with real per-criterion LLM scores)
 *
 * No LLM calls here. Pure data transformation.
 */

'use strict';

/**
 * Convert a single bid + optional execution result into a consolidator
 * evaluation entry.
 *
 * @param {Object} bid
 * @param {string} bid.agentId
 * @param {string} [bid.agentName]
 * @param {number} bid.confidence   - 0.0 to 1.0
 * @param {string} [bid.reasoning]
 * @param {string} [bid.plan]
 * @param {string} [bid.hallucinationRisk]
 * @param {string} [bid.result]
 * @param {Object} [options]
 * @param {Array}  [options.criteria]      - Task criteria from Task.criteria
 * @param {Object} [options.executionResult] - Result from agent.execute()
 *                                              if the agent ran (council
 *                                              execution may invoke it)
 * @param {string} [options.agentType]     - Override for weighting key;
 *                                              defaults to agentId-derived
 * @returns {Object} Evaluation entry for consolidator.consolidate()
 */
function bidToEvaluation(bid, options = {}) {
  if (!bid || typeof bid !== 'object') {
    throw new TypeError('bidToEvaluation: bid must be an object');
  }

  const agentId = bid.agentId || 'unknown';
  const confidence = Math.max(0, Math.min(1, Number(bid.confidence) || 0));
  const overallScore = Math.round(confidence * 100);

  // agentType is what the weighting manager keys off. For built-in
  // agents we derive it from the id: 'calendar-query-agent' ->
  // 'calendar-query'. Callers can override when they need a specific
  // weighting bucket.
  const agentType = options.agentType || _deriveAgentType(agentId);

  // Per-criterion expansion:
  //   - Phase 4: if the bid itself carries per-criterion scores, use them.
  //   - Otherwise (Phase 1 fallback): fan the overall score to every
  //     criterion declared on the task.
  //
  // The consolidator keys criteria by `name`; per-bid scores are keyed by
  // `id`. Map the bid's rationale into the comment so conflict-resolution
  // messages stay rich.
  const taskCriteria = Array.isArray(options.criteria) ? options.criteria : [];
  const perCriterionFromBid = Array.isArray(bid.criteria)
    ? new Map(bid.criteria.filter((c) => c && c.id).map((c) => [c.id, c]))
    : null;
  const criteria = taskCriteria
    .filter((c) => c && c.id)
    .map((c) => {
      const fromBid = perCriterionFromBid ? perCriterionFromBid.get(c.id) : null;
      const score = fromBid
        ? Math.max(0, Math.min(100, Number(fromBid.score) || 0))
        : overallScore;
      const comment = fromBid && fromBid.rationale ? fromBid.rationale : (bid.reasoning || '');
      return {
        name: c.id,
        score,
        weight: typeof c.weight === 'number' && isFinite(c.weight) ? c.weight : 1,
        comment,
      };
    });

  // Heuristic strengths/concerns split:
  //   - confidence >= 0.7 -> reasoning goes to strengths
  //   - confidence <= 0.4 -> reasoning goes to concerns
  //   - middle band       -> neither (just the raw comment)
  const strengths = [];
  const concerns = [];
  if (bid.reasoning) {
    if (confidence >= 0.7) strengths.push(bid.reasoning);
    else if (confidence <= 0.4) concerns.push(bid.reasoning);
  }
  if (bid.hallucinationRisk === 'high') {
    concerns.push('Self-assessed hallucination risk is high.');
  }

  // If we have a plan from the bidder or an execution result, include
  // it as a suggestion with provenance so consumers can surface it.
  const suggestions = [];
  if (bid.plan) {
    suggestions.push({
      text: bid.plan,
      source: agentId,
      type: 'plan',
    });
  }
  if (options.executionResult && options.executionResult.message) {
    suggestions.push({
      text: String(options.executionResult.message).slice(0, 400),
      source: agentId,
      type: 'execution-result',
      data: options.executionResult.data,
    });
  }

  return {
    agentId,
    agentType,
    agentName: bid.agentName || agentId,
    agentIcon: bid.agentIcon, // may be undefined; consolidator handles that
    overallScore,
    criteria,
    strengths,
    concerns,
    suggestions,
    // Preserve original bid for downstream consumers (HUD, learning loop)
    _bid: {
      confidence,
      reasoning: bid.reasoning || '',
      plan: bid.plan || '',
      hallucinationRisk: bid.hallucinationRisk || 'none',
    },
  };
}

/**
 * Convert an array of bids (optionally with execution results) into the
 * list consolidator.consolidate() expects.
 *
 * @param {Array} bids - Array of bid objects from unified-bidder
 * @param {Object} [options]
 * @param {Array} [options.criteria]
 * @param {Map|Object} [options.executionResults] - keyed by agentId
 * @param {number} [options.confidenceFloor=0.5] - bids below this are dropped
 * @returns {Array} Evaluation entries
 */
function bidsToEvaluations(bids, options = {}) {
  if (!Array.isArray(bids)) return [];

  const floor = typeof options.confidenceFloor === 'number' ? options.confidenceFloor : 0.5;
  const exec = options.executionResults;

  return bids
    .filter((b) => b && Number(b.confidence) >= floor)
    .map((b) => {
      const executionResult = exec
        ? (exec instanceof Map ? exec.get(b.agentId) : exec[b.agentId])
        : undefined;
      return bidToEvaluation(b, { criteria: options.criteria, executionResult });
    });
}

/**
 * Build the evaluation-context object consumed by consolidate().
 * Derives `documentType` from a task when possible (used by contextual
 * weighting); defaults to 'code' so weighting still runs even on tasks
 * that have no notion of doc type.
 *
 * @param {Object} task  - Canonical task (from lib/task.js)
 * @param {Object} [options]
 * @param {string} [options.weightingMode='uniform']
 * @returns {Object}
 */
function buildConsolidateContext(task, options = {}) {
  const ctx = {
    weightingMode: options.weightingMode || 'uniform',
    documentType: _inferDocumentType(task),
  };
  if (task && task.id) ctx.taskId = task.id;
  if (task && task.spaceId) ctx.spaceId = task.spaceId;
  return ctx;
}

// ==================== INTERNAL ====================

function _deriveAgentType(agentId) {
  // Drop trailing '-agent' suffix so 'calendar-query-agent' becomes
  // 'calendar-query'. Makes the type match the lib/meta-learning
  // agent-memory bucketing convention. Normalized case-insensitively.
  if (typeof agentId !== 'string') return 'unknown';
  return agentId.toLowerCase().replace(/-agent$/, '');
}

function _inferDocumentType(task) {
  if (!task) return 'code';
  // Explicit rubric wins.
  if (task.rubric && typeof task.rubric === 'string') return task.rubric;
  // Heuristic on content for the few doc types the weighting tables know
  // about (code, technical, recipe, creative, api, test). Short-circuit
  // for a clear-cut keyword; everything else falls back to 'code' which
  // is treated as 'generic evaluation' by the uniform/learned paths.
  const content = (task.content || task.description || '').toLowerCase();
  if (/\brecipe\b|\bcook\b|\bingredient\b/.test(content)) return 'recipe';
  if (/\bapi\b|\bendpoint\b|\brest\b/.test(content)) return 'api';
  if (/\btests?\b|\bunit tests?\b|\bspecs?\b/.test(content)) return 'test';
  if (/\bstory\b|\bpoem\b|\bnovel\b/.test(content)) return 'creative';
  if (/\bdocs?\b|\bdocumentation\b|\breadme\b/.test(content)) return 'documentation';
  return 'code';
}

module.exports = {
  bidToEvaluation,
  bidsToEvaluations,
  buildConsolidateContext,
  _deriveAgentType,
  _inferDocumentType,
};
