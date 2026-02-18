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

/**
 * Build the evaluation prompt for the Master Orchestrator
 */
function buildEvaluationPrompt(task, bids) {
  const bidsText = bids
    .map((bid, i) => {
      return `${i + 1}. ${bid.agentName || bid.agentId} (confidence: ${bid.confidence.toFixed(2)})
   Reasoning: ${bid.reasoning || 'No reasoning provided'}
   Score: ${bid.score?.toFixed(3) || 'N/A'}`;
    })
    .join('\n\n');

  return `You are the Master Orchestrator - the supervisor that evaluates all agent bids and makes intelligent routing decisions.

USER REQUEST: "${task.content || task}"

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

IMPORTANT RULES:
- If an agent's reasoning says "this doesn't match my capabilities" but they bid high, REJECT them
- Calendar queries (day names + "what do I have") should go to Calendar Agent, not Time Agent
- Time queries ("what time is it", "what day is it", "what's the date") should go to Time Agent
- DEFAULT to "single" mode with ONE winner. Most requests need only one agent.
- ONLY select multiple winners when the task EXPLICITLY combines different domains (e.g., "check my calendar AND play some music"). Simple questions like "what day is it" or "what's the weather" MUST use "single" mode with one winner.
- When in doubt, pick the single best agent.

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
    log.info('agent', `Evaluating ${bids.length} bids for: "${(task.content || task).substring(0, 50)}..."`);

    // If no bids or only one bid, skip LLM evaluation
    if (!bids || bids.length === 0) {
      log.info('agent', 'No bids to evaluate');
      return {
        winners: [],
        executionMode: 'single',
        reasoning: 'No bids received',
        rejectedBids: [],
        agentFeedback: [],
      };
    }

    if (bids.length === 1) {
      log.info('agent', 'Single bid, selecting as winner');
      return {
        winners: [bids[0].agentId],
        executionMode: 'single',
        reasoning: 'Only one agent bid',
        rejectedBids: [],
        agentFeedback: [],
      };
    }

    // Cost guard: if the top bid is dominant (gap > 0.3 from second),
    // skip the LLM call and just select the winner directly.
    const sortedBids = [...bids].sort((a, b) => (b.score || b.confidence) - (a.score || a.confidence));
    const topScore = sortedBids[0]?.score || sortedBids[0]?.confidence || 0;
    const secondScore = sortedBids[1]?.score || sortedBids[1]?.confidence || 0;
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: 'master-orchestrator.js:winner',
        message: 'Orchestrator evaluating bids',
        data: {
          taskContent: (task.content || task.phrase || '').substring(0, 80),
          topAgent: sortedBids[0]?.agentId,
          topScore,
          secondAgent: sortedBids[1]?.agentId,
          secondScore,
          gap: (topScore - secondScore).toFixed(2),
          totalBids: bids.length,
          allBids: sortedBids.map((b) => ({ id: b.agentId, score: b.score || b.confidence })),
        },
        timestamp: Date.now(),
        hypothesisId: 'WINNER',
      }),
    }).catch((err) => console.warn('[master-orchestrator] ingest fetch:', err.message));
    if (topScore - secondScore > 0.3) {
      log.info('agent', `Dominant top bid (gap ${(topScore - secondScore).toFixed(2)}), skipping LLM`);
      return {
        winners: [sortedBids[0].agentId],
        executionMode: 'single',
        reasoning: `Clear winner by ${(topScore - secondScore).toFixed(2)} confidence gap`,
        rejectedBids: [],
        agentFeedback: [],
      };
    }

    // Build and send LLM request
    const prompt = buildEvaluationPrompt(task, bids);

    try {
      const result = await ai.chat({
        profile: 'fast',
        system: prompt,
        messages: [],
        temperature: 0,
        maxTokens: 500,
        jsonMode: true,
        feature: 'master-orchestrator',
      });

      const content = result.content;

      if (!content) {
        throw new Error('Empty LLM response');
      }

      const evaluation = JSON.parse(content);

      // Validate winners exist in bids
      const validWinners = (evaluation.winners || []).filter((winnerId) => bids.some((b) => b.agentId === winnerId));

      if (validWinners.length === 0) {
        log.warn('agent', 'LLM selected no valid winners, falling back');
        return this._fallbackSelection(bids);
      }

      log.info('agent', `Selected ${validWinners.length} winner(s)`, { validWinners });
      log.info('agent', `Reasoning: ${evaluation.reasoning}`);

      if (evaluation.rejectedBids?.length > 0) {
        log.info('agent', `Rejected ${evaluation.rejectedBids.length} bad bids`);
      }

      // Safeguard: force single mode if LLM chose parallel/series
      // but only selected 1 winner, or if the task is simple (no "and"/"then" combining domains).
      let executionMode = evaluation.executionMode || 'single';
      let finalWinners = validWinners;

      if (finalWinners.length > 1) {
        // Only allow multi-winner if the task clearly requires it
        const taskText = (task.content || String(task)).toLowerCase();
        const hasMultiIntent = /\band\b|\bthen\b|\balso\b|\bplus\b/.test(taskText);
        if (!hasMultiIntent) {
          log.info('agent', `Overriding multi-winner to single (task has no multi-intent signals)`);
          finalWinners = [finalWinners[0]];
          executionMode = 'single';
        }
      }
      if (finalWinners.length === 1) {
        executionMode = 'single';
      }

      return {
        winners: finalWinners,
        executionMode,
        reasoning: evaluation.reasoning || '',
        rejectedBids: evaluation.rejectedBids || [],
        agentFeedback: evaluation.agentFeedback || [],
      };
    } catch (error) {
      log.error('agent', 'Evaluation failed', { error: error.message });
      return this._fallbackSelection(bids);
    }
  },

  /**
   * Fallback selection when LLM is unavailable
   * Uses the pre-ranked scores
   */
  _fallbackSelection(bids) {
    const winner = bids[0];
    return {
      winners: [winner.agentId],
      executionMode: 'single',
      reasoning: 'Fallback: selected highest scoring bid',
      rejectedBids: [],
      agentFeedback: [],
    };
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

    // Update reputation based on success/failure
    try {
      const { getReputationStore } = require('../../packages/task-exchange/src/reputation/store');
      const repStore = getReputationStore();

      if (result.success) {
        await repStore.recordSuccess(winner.agentId, winner.agentVersion || '1.0.0');
      } else {
        await repStore.recordFailure(winner.agentId, winner.agentVersion || '1.0.0');
      }
    } catch (e) {
      log.warn('agent', 'Could not update reputation', { error: e.message });
    }

    // Apply agent feedback from evaluation
    if (evaluation?.agentFeedback?.length > 0) {
      for (const feedback of evaluation.agentFeedback) {
        await this.updateAgentMemory(feedback.agentId, feedback.feedback);
      }
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

      // Apply reputation penalty
      try {
        const { getReputationStore } = require('../../packages/task-exchange/src/reputation/store');
        const repStore = getReputationStore();
        await repStore.recordFailure(rejected.agentId, '1.0.0');
      } catch (e) {
        log.warn('agent', 'Could not apply reputation penalty', { error: e.message });
      }
    }
  },
};

module.exports = masterOrchestrator;
