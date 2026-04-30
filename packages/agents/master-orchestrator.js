/**
 * Master Orchestrator Agent
 *
 * Supervises all agent bidding and makes intelligent decisions:
 * - Evaluates ALL bids together (not just highest score)
 * - Selects one or multiple winners
 * - Decides parallel vs series execution
 * - Provides reputation feedback to agents
 * - Edits agent memory files to help them learn
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// Pure decisions (fast-path, multi-intent override, fallback) live
// in the portable hud-core. This file keeps the LLM orchestration +
// agent memory feedback loops that are desktop-specific.
const {
  pickWinnerFastPath,
  applyMultiIntentOverride,
  fallbackSelection,
  validateWinners: _validateWinners,
  applyOverlapPenalty,
  wouldChangeWinner,
} = require('../../lib/hud-core');

/**
 * Read the bid-overlap mode setting. Returns one of 'off' | 'shadow' | 'on'.
 * Env override (ARBITRATION_OVERLAP_MODE) wins over settings-manager.
 */
function _readOverlapMode() {
  const env = (process.env.ARBITRATION_OVERLAP_MODE || '').toLowerCase();
  if (env === 'off' || env === 'shadow' || env === 'on') return env;
  try {
    const m = global.settingsManager?.get('arbitrationOverlap.mode');
    if (m === 'shadow' || m === 'on') return m;
  } catch (_e) { /* settings optional */ }
  return 'off';
}

/** Read tuned constants from settings; fall back to module defaults. */
function _readOverlapConfig() {
  try {
    const tuned = global.settingsManager?.get('arbitrationOverlap.tuned');
    if (tuned && typeof tuned === 'object') {
      return {
        threshold: typeof tuned.threshold === 'number' ? tuned.threshold : undefined,
        maxPenalty: typeof tuned.maxPenalty === 'number' ? tuned.maxPenalty : undefined,
      };
    }
  } catch (_e) { /* settings optional */ }
  return {};
}

/**
 * Pull historical performance for an agent, if the stats tracker is loaded.
 * Returns null if stats aren't available (so we can omit the section cleanly).
 */
function _getAgentStatsSnapshot(agentId) {
  try {
    // Lazy require -- agent-stats lives in the renderer-side voice SDK path,
    // and is only available when running inside the Electron main process
    // that hosts the orb.  In unit tests or other environments we simply
    // omit the stats section.
    const { getAgentStats } = require('../../src/voice-task-sdk/agent-stats');
    const stats = getAgentStats && getAgentStats();
    if (!stats || !stats.stats) return null;
    const s = stats.stats[agentId];
    if (!s) return null;
    const execs = s.executions || 0;
    const successes = s.successes || 0;
    const failures = s.failures || 0;
    const totalTerminal = successes + failures;
    const successRate = totalTerminal > 0 ? successes / totalTerminal : null;
    const avgMs =
      execs > 0 && s.totalExecutionTimeMs
        ? Math.round(s.totalExecutionTimeMs / execs)
        : null;
    return { execs, successes, failures, successRate, avgMs };
  } catch (_e) {
    return null;
  }
}

/**
 * Build the evaluation prompt for the Master Orchestrator
 */
function buildEvaluationPrompt(task, bids) {
  const bidsText = bids
    .map((bid, i) => {
      const s = _getAgentStatsSnapshot(bid.agentId);
      let historyLine = '';
      if (s && s.execs > 0) {
        const parts = [`executions=${s.execs}`];
        if (s.successRate !== null) {
          parts.push(`success_rate=${(s.successRate * 100).toFixed(0)}%`);
        }
        if (s.avgMs !== null) {
          parts.push(`avg_latency=${(s.avgMs / 1000).toFixed(1)}s`);
        }
        if (s.failures > 0) parts.push(`failures=${s.failures}`);
        historyLine = `\n   History: ${parts.join(', ')}`;
      }
      // Phase 4 overlap penalty: when the auction has flagged this
      // bid as overlapping a higher-ranked one's reasoning, surface
      // that to the evaluator so the LLM doesn't reintroduce a
      // multi-winner that the deterministic layer just suppressed.
      let overlapLine = '';
      if (bid._overlapAdjustment) {
        const adj = bid._overlapAdjustment;
        overlapLine = `\n   Overlap-adjusted: confidence ${adj.before.toFixed(2)} -> ${adj.after.toFixed(2)} (Jaccard ${adj.jaccard.toFixed(2)} vs ${adj.against})`;
      }
      return `${i + 1}. ${bid.agentName || bid.agentId} (confidence: ${bid.confidence.toFixed(2)})
   Reasoning: ${bid.reasoning || 'No reasoning provided'}
   Score: ${bid.score?.toFixed(3) || 'N/A'}${historyLine}${overlapLine}`;
    })
    .join('\n\n');

  let situationText = '';
  if (task.metadata?.situationContext) {
    const sc = task.metadata.situationContext;
    const parts = [];
    if (sc.focusedWindow) parts.push(`Active window: ${sc.focusedWindow}`);
    if (sc.openWindows?.length) parts.push(`Open: ${sc.openWindows.join(', ')}`);
    if (sc.flowContext?.label) parts.push(`Edison flow: ${sc.flowContext.label}`);
    if (sc.flowContext?.stepLabel) parts.push(`Step: ${sc.flowContext.stepLabel}`);
    if (parts.length > 0) situationText = `\nCURRENT SITUATION:\n${parts.join('\n')}\n`;
  }

  return `You are the Master Orchestrator - the supervisor that evaluates all agent bids and makes intelligent routing decisions.

USER REQUEST: "${task.content || task}"
${situationText}
SUBMITTED BIDS (${bids.length} agents):
${bidsText}

YOUR RESPONSIBILITIES:
1. **Select Winner(s)**: Pick the agent(s) best suited for this task
2. **Detect Bad Bids**: Flag agents who bid high but clearly shouldn't handle this
3. **Execution Mode**: If multiple winners, should they run in parallel or series?
4. **Agent Feedback**: Note any improvements agents should learn

EVALUATION CRITERIA:
- Does the agent's reasoning match the user's actual intent?
- Does the agent have the right capabilities for this task?
- Is the confidence justified by the reasoning?
- Are there any contradictions (high confidence but wrong domain)?
- When confidence scores are similar (within ~0.05), USE THE History line to pick:
  - Prefer the agent with higher historical success rate.
  - Prefer the agent with lower avg_latency (user experience matters).
  - An agent that is 10x faster but has the same capability should win the tie.
  - If an agent has significant recent failures, discount its bid even if confidence is high.

IMPORTANT RULES:
- If an agent's reasoning says "this doesn't match my capabilities" but they bid high, REJECT them
- Calendar queries (day names + "what do I have") should go to Calendar Agent, not Time Agent
- Time queries ("what time is it", "what day is it", "what's the date") should go to Time Agent
- DEFAULT to "single" mode with ONE winner. Most requests need only one agent.
- ONLY select multiple winners when the task EXPLICITLY combines different domains (e.g., "check my calendar AND play some music"). Simple questions like "what day is it" or "what's the weather" MUST use "single" mode with one winner.
- When in doubt, pick the single best agent.
- NEVER say bids are "functionally equivalent, pick the first one". If they look equivalent, break the tie using History (latency + success rate). If History is missing for all of them, pick the agent with the simplest / most direct reasoning (e.g. an API-based search beats browser automation for the same result).

Respond with JSON only:
{
  "winners": ["agent-id"],
  "executionMode": "single" | "parallel" | "series",
  "reasoning": "Brief explanation of why you chose this agent(s)",
  "rejectedBids": [
    { "agentId": "agent-id", "reason": "Why this bid was wrong" }
  ],
  "agentFeedback": [
    { "agentId": "agent-id", "feedback": "What this agent should learn" }
  ]
}`;
}

/**
 * Master Orchestrator Agent
 */
const masterOrchestrator = {
  id: 'master-orchestrator-internal',
  name: 'Master Orchestrator',

  /**
   * Evaluate all bids and select winner(s)
   * This is called by the Exchange after collecting all bids
   *
   * @param {Object} task - The user's task
   * @param {Array} bids - All submitted bids with reasoning (already ranked by score)
   * @returns {Promise<Object>} - { winners, executionMode, rejectedBids, agentFeedback, reasoning }
   */
  async evaluate(task, bids) {
    log.info('agent', `Evaluating ${(bids || []).length} bids for: "${(task.content || task).substring(0, 50)}..."`);

    // Phase 3 self-learning arbitration: apply user-accepted routing
    // rules from lib/agent-learning/learned-arbitration-rules to bids
    // before the fast path runs. Rules can shrink/boost a bid's
    // confidence, suppress one of a redundant pair, or force-route a
    // task class to a single agent. Pure transform; no I/O in this
    // call (the rule store is read once and cached in memory). Falls
    // open if the rules module isn't available (tests, partial init).
    let workingBids = bids;
    try {
      const { getLearnedArbitrationRules, applyRules } = require('../../lib/agent-learning/learned-arbitration-rules');
      const store = getLearnedArbitrationRules();
      const rules = store.getApplicableRules(task, bids);
      if (rules.length > 0) {
        const { bids: adjusted, applied } = applyRules(bids, rules);
        workingBids = adjusted;
        for (const a of applied) {
          log.info('agent', `[Rule] ${a.type} applied`, {
            ruleId: a.ruleId,
            target: a.target,
            dropped: a.dropped,
            taskId: task?.id,
          });
        }
      }
    } catch (err) {
      log.warn('agent', '[Rule] application failed, continuing with raw bids', {
        error: err.message,
      });
    }

    // Phase 5 self-learning arbitration: per-agent bid calibration.
    // Each bid is shrunk by a per-(agent, taskClass) factor learned
    // from historical outcomes. Calibration runs BEFORE overlap so
    // overlap operates on honest confidences (not inflated ones that
    // could suppress a more-accurate competitor). Pure transform; no
    // I/O on the hot path -- the agent memory is cached at the store
    // layer. Falls open if the calibrator module is unavailable.
    try {
      const { calibrate } = require('../../lib/agent-learning/bid-calibrator');
      const calibrated = workingBids.map((b) => calibrate(b, task));
      // Log per-application for the audit trail; cheap, only fires
      // when an agent actually has a Calibration entry that applies.
      for (const b of calibrated) {
        if (b && b._calibrationAdjustment) {
          log.info('agent', `[Calibration] applied`, {
            agentId: b.agentId,
            shrinkage: b._calibrationAdjustment.shrinkage,
            before: b._calibrationAdjustment.before,
            after: b._calibrationAdjustment.after,
            taskId: task?.id,
          });
        }
      }
      workingBids = calibrated;
    } catch (err) {
      log.warn('agent', '[Calibration] application failed, continuing with raw bids', {
        error: err.message,
      });
    }

    // Phase 4 self-learning arbitration: bid overlap penalty. Pure
    // pre-selection adjustment that shrinks redundant lower-ranked
    // bids' confidences when their reasoning text overlaps a higher-
    // ranked bid's. Three-state flag:
    //   off    -- no adjustments
    //   shadow -- compute + log "would change winner", but don't apply
    //   on     -- apply
    // Tuned constants (threshold, maxPenalty) come from settings,
    // populated by the weekly overlap-tuner cron. Defaults seed
    // conservatively until the tuner has data.
    //
    // ORDER MATTERS: calibration (above) runs BEFORE overlap because
    // calibration corrects per-agent over-confidence at the source.
    // If overlap ran first against inflated confidences, it could
    // suppress an honestly-confident competitor. Don't reorder.
    let overlapAdjustments = [];
    try {
      const overlapMode = _readOverlapMode();
      if (overlapMode === 'shadow' || overlapMode === 'on') {
        const cfg = _readOverlapConfig();
        const adjusted = applyOverlapPenalty(workingBids, cfg);
        overlapAdjustments = adjusted
          .filter((b) => b && b._overlapAdjustment)
          .map((b) => ({
            agentId: b.agentId,
            ...b._overlapAdjustment,
          }));
        if (overlapAdjustments.length > 0) {
          log.info('agent', `[Overlap] ${overlapMode} mode`, {
            taskId: task?.id,
            mode: overlapMode,
            wouldChangeWinner: wouldChangeWinner(workingBids, adjusted),
            adjustments: overlapAdjustments,
          });
        }
        if (overlapMode === 'on') workingBids = adjusted;
      }
    } catch (err) {
      log.warn('agent', '[Overlap] application failed, continuing with raw bids', {
        error: err.message,
      });
    }

    // Fast paths (empty bids / single bid / dominant top) are
    // extracted to lib/hud-core/winner-selection. Null means "LLM
    // evaluation is needed."
    const fastPath = pickWinnerFastPath(workingBids);
    if (fastPath) {
      // Emit the legacy log lines so downstream observability stays
      // the same.
      if (fastPath.reasoning === 'No bids received') {
        log.info('agent', 'No bids to evaluate');
      } else if (fastPath.reasoning === 'Only one agent bid') {
        log.info('agent', 'Single bid, selecting as winner');
      } else if (fastPath.reasoning.startsWith('Clear winner by')) {
        log.info('agent', `Dominant top bid (${fastPath.reasoning.toLowerCase()}), skipping LLM`);
      }
      return fastPath;
    }

    // Build and send LLM request. The prompt and validation operate
    // on workingBids (post-rule) so a route-class or suppress-pair
    // rule actually constrains the LLM's choice rather than just
    // tilting the fast path.
    const prompt = buildEvaluationPrompt(task, workingBids);

    try {
      // 1500 tokens: evaluator must emit winners + reasoning +
      // rejectedBids + agentFeedback for up to ~8 bidders. 500 tokens
      // truncated JSON mid-string on complex tasks like daily briefs.
      const result = await ai.chat({
        profile: 'fast',
        system: prompt,
        messages: [],
        temperature: 0,
        maxTokens: 1500,
        jsonMode: true,
        feature: 'master-orchestrator',
      });

      const content = result.content;

      if (!content) {
        throw new Error('Empty LLM response');
      }

      const evaluation = JSON.parse(content);

      // Validate winners exist in the (post-rule) bid set. Extracted to hud-core.
      const validWinners = _validateWinners(evaluation.winners, workingBids);

      if (validWinners.length === 0) {
        log.warn('agent', 'LLM selected no valid winners, falling back');
        return this._fallbackSelection(workingBids);
      }

      log.info('agent', `Selected ${validWinners.length} winner(s)`, { validWinners });
      log.info('agent', `Reasoning: ${evaluation.reasoning}`);

      if (evaluation.rejectedBids?.length > 0) {
        log.info('agent', `Rejected ${evaluation.rejectedBids.length} bad bids`);
      }

      // Multi-intent override: force single-winner when an LLM
      // picked multiple on a simple task (no "and" / "then" / "also"
      // / "plus"). Extracted to hud-core.
      const taskText = (task.content || String(task)).toLowerCase();
      const beforeCount = validWinners.length;
      const corrected = applyMultiIntentOverride(
        { winners: validWinners, executionMode: evaluation.executionMode || 'single' },
        taskText
      );
      if (beforeCount > 1 && corrected.winners.length === 1) {
        log.info('agent', `Overriding multi-winner to single (task has no multi-intent signals)`);
      }

      return {
        winners: corrected.winners,
        executionMode: corrected.executionMode,
        reasoning: evaluation.reasoning || '',
        rejectedBids: evaluation.rejectedBids || [],
        agentFeedback: evaluation.agentFeedback || [],
      };
    } catch (error) {
      log.error('agent', 'Evaluation failed', { error: error.message });
      return this._fallbackSelection(workingBids);
    }
  },

  /**
   * Fallback selection when LLM is unavailable. Pure decision lives
   * in hud-core; this wrapper keeps the legacy method name for
   * callers that reach for `masterOrchestrator._fallbackSelection`.
   */
  _fallbackSelection(bids) {
    return fallbackSelection(bids);
  },

  /**
   * Provide feedback after task execution
   * Updates reputation and optionally edits agent memory
   *
   * @param {Object} task - The completed task
   * @param {Object} result - Execution result { success, message }
   * @param {Object} winner - The agent that executed
   * @param {Object} evaluation - The original evaluation from evaluate()
   */
  async provideFeedback(task, result, winner, evaluation) {
    log.info('agent', `Providing feedback for ${winner.agentId}`);

    log.info('agent', `Feedback for ${winner.agentId}: ${result.success ? 'success' : 'failure'}`);

    // Apply agent feedback from evaluation
    if (evaluation?.agentFeedback?.length > 0) {
      for (const feedback of evaluation.agentFeedback) {
        await this.updateAgentMemory(feedback.agentId, feedback.feedback);
      }
    }

    // ── OUTCOME-BASED BID AUDIT ──
    // Pre-task we picked `winner.agentId` over the other bidders. Now we
    // can see how it turned out. If the winner was busted (timed out and
    // a backup finished the job), that's a pick we should reconsider in
    // the future. Update both the winner's and the rejected bidders'
    // memory with the outcome so next time's evaluation has history.
    try {
      const bustCount = task?.metadata?.bustCount || 0;
      const bustedAgents = task?.metadata?.bustedAgents || [];
      const lastAgentId = task?.metadata?.lastAgentId || winner.agentId;

      if (bustCount > 0) {
        // The agent we picked timed out or failed; a backup actually
        // answered. Note this on the picked agent's memory AND credit
        // the agent that actually succeeded.
        for (const busted of bustedAgents) {
          await this.updateAgentMemory(
            busted.agentId,
            `Busted on "${(task.content || '').substring(0, 50)}..." after being picked by Master Orchestrator (${busted.error || 'timeout'}); a backup finished the task.`
          );
        }
        if (lastAgentId && lastAgentId !== winner.agentId && result.success !== false) {
          await this.updateAgentMemory(
            lastAgentId,
            `Rescued "${(task.content || '').substring(0, 50)}..." after Master Orchestrator's primary pick was busted. Consider bidding higher on this class next time.`
          );
        }
      }

      // Reflection-based feedback: if the reflector judged the answer
      // low-quality even though the agent returned success, that's
      // equivalent to a silent failure. Propagate to memory so the next
      // bid evaluation sees the historical quality issue, not just the
      // boolean success count.
      if (task?.metadata?.reflectionOverall !== undefined
          && task.metadata.reflectionOverall < 0.55
          && winner.agentId) {
        await this.updateAgentMemory(
          winner.agentId,
          `Low-quality answer (reflector score ${task.metadata.reflectionOverall.toFixed(2)}) on "${(task.content || '').substring(0, 50)}...". ${(task.metadata.reflectionIssues || []).slice(0, 2).join('; ') || 'No specific issues noted.'}`
        );
      }
    } catch (err) {
      log.warn('agent', 'Outcome-based audit failed', { error: err.message });
    }

    // If task failed, add learning note to the agent
    if (!result.success && winner.agentId) {
      const failureNote = `Task failed: "${(task.content || '').substring(0, 50)}..." - ${result.message || 'Unknown error'}`;
      await this.updateAgentMemory(winner.agentId, failureNote);
    }
  },

  /**
   * Update an agent's memory file with feedback/learning notes
   *
   * @param {string} agentId - Agent to update
   * @param {string} feedback - What to add to their memory
   */
  async updateAgentMemory(agentId, feedback) {
    if (!agentId || !feedback) return;

    try {
      const memory = getAgentMemory(agentId);
      await memory.load();

      // Ensure "Learning Notes" section exists
      const sections = memory.getSectionNames();
      if (!sections.includes('Learning Notes')) {
        memory.updateSection('Learning Notes', '*Notes from Master Orchestrator to help improve*');
      }

      // Add timestamped feedback
      const timestamp = new Date().toISOString().split('T')[0];
      const entry = `- ${timestamp}: ${feedback}`;
      memory.appendToSection('Learning Notes', entry, 20); // Keep last 20 entries

      await memory.save();
      log.info('agent', `Updated memory for ${agentId}: ${feedback.substring(0, 50)}...`);
    } catch (error) {
      log.warn('agent', `Could not update memory for ${agentId}`, { error: error.message });
    }
  },

  /**
   * Process rejected bids - apply reputation penalty
   *
   * @param {Array} rejectedBids - Bids that were flagged as bad
   */
  async processRejectedBids(rejectedBids) {
    if (!rejectedBids || rejectedBids.length === 0) return;

    for (const rejected of rejectedBids) {
      log.info('agent', `Processing rejected bid: ${rejected.agentId} - ${rejected.reason}`);

      // Add to agent's learning notes
      await this.updateAgentMemory(rejected.agentId, `Bid rejected by Master Orchestrator: ${rejected.reason}`);

      log.info('agent', `Reputation note: ${rejected.agentId} bid rejected`);
    }
  },
};

module.exports = masterOrchestrator;
