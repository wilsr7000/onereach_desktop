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
const { getBudgetManager } = require('../../budget-manager');

/**
 * Get OpenAI API key
 */
function getOpenAIApiKey() {
  if (global.settingsManager) {
    const openaiKey = global.settingsManager.get('openaiApiKey');
    if (openaiKey) return openaiKey;
    const provider = global.settingsManager.get('llmProvider');
    const llmKey = global.settingsManager.get('llmApiKey');
    if (provider === 'openai' && llmKey) return llmKey;
  }
  return process.env.OPENAI_API_KEY;
}

/**
 * Build the evaluation prompt for the Master Orchestrator
 */
function buildEvaluationPrompt(task, bids) {
  const bidsText = bids.map((bid, i) => {
    return `${i + 1}. ${bid.agentName || bid.agentId} (confidence: ${bid.confidence.toFixed(2)})
   Reasoning: ${bid.reasoning || 'No reasoning provided'}
   Score: ${bid.score?.toFixed(3) || 'N/A'}`;
  }).join('\n\n');

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
- Time queries ("what time is it") should go to Time Agent
- If task needs multiple agents (e.g., "check calendar and play music"), select multiple winners

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
    console.log(`[MasterOrchestrator] Evaluating ${bids.length} bids for: "${(task.content || task).substring(0, 50)}..."`);
    
    // If no bids or only one bid, skip LLM evaluation
    if (!bids || bids.length === 0) {
      console.log('[MasterOrchestrator] No bids to evaluate');
      return {
        winners: [],
        executionMode: 'single',
        reasoning: 'No bids received',
        rejectedBids: [],
        agentFeedback: []
      };
    }
    
    if (bids.length === 1) {
      console.log('[MasterOrchestrator] Single bid, selecting as winner');
      return {
        winners: [bids[0].agentId],
        executionMode: 'single',
        reasoning: 'Only one agent bid',
        rejectedBids: [],
        agentFeedback: []
      };
    }
    
    // Get API key
    const apiKey = getOpenAIApiKey();
    if (!apiKey) {
      console.warn('[MasterOrchestrator] No API key, falling back to top scorer');
      return this._fallbackSelection(bids);
    }
    
    // Build and send LLM request
    const prompt = buildEvaluationPrompt(task, bids);
    
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: prompt }
          ],
          temperature: 0,
          max_tokens: 500,
          response_format: { type: 'json_object' }
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error ${response.status}: ${errorText.substring(0, 100)}`);
      }
      
      const result = await response.json();
      const content = result.choices?.[0]?.message?.content;
      
      // Track usage
      if (result.usage) {
        try {
          const budgetManager = getBudgetManager();
          budgetManager.trackUsage({
            provider: 'openai',
            model: 'gpt-4o-mini',
            inputTokens: result.usage.prompt_tokens || 0,
            outputTokens: result.usage.completion_tokens || 0,
            feature: 'master-orchestrator',
            operation: 'evaluate-bids'
          });
        } catch (e) {
          console.warn('[MasterOrchestrator] Failed to track usage:', e.message);
        }
      }
      
      if (!content) {
        throw new Error('Empty LLM response');
      }
      
      const evaluation = JSON.parse(content);
      
      // Validate winners exist in bids
      const validWinners = (evaluation.winners || []).filter(winnerId => 
        bids.some(b => b.agentId === winnerId)
      );
      
      if (validWinners.length === 0) {
        console.warn('[MasterOrchestrator] LLM selected no valid winners, falling back');
        return this._fallbackSelection(bids);
      }
      
      console.log(`[MasterOrchestrator] Selected ${validWinners.length} winner(s):`, validWinners);
      console.log(`[MasterOrchestrator] Reasoning: ${evaluation.reasoning}`);
      
      if (evaluation.rejectedBids?.length > 0) {
        console.log(`[MasterOrchestrator] Rejected ${evaluation.rejectedBids.length} bad bids`);
      }
      
      return {
        winners: validWinners,
        executionMode: evaluation.executionMode || 'single',
        reasoning: evaluation.reasoning || '',
        rejectedBids: evaluation.rejectedBids || [],
        agentFeedback: evaluation.agentFeedback || []
      };
      
    } catch (error) {
      console.error('[MasterOrchestrator] Evaluation failed:', error.message);
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
      agentFeedback: []
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
    console.log(`[MasterOrchestrator] Providing feedback for ${winner.agentId}`);
    
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
      console.warn('[MasterOrchestrator] Could not update reputation:', e.message);
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
      console.log(`[MasterOrchestrator] Updated memory for ${agentId}: ${feedback.substring(0, 50)}...`);
      
    } catch (error) {
      console.warn(`[MasterOrchestrator] Could not update memory for ${agentId}:`, error.message);
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
      console.log(`[MasterOrchestrator] Processing rejected bid: ${rejected.agentId} - ${rejected.reason}`);
      
      // Add to agent's learning notes
      await this.updateAgentMemory(
        rejected.agentId, 
        `Bid rejected by Master Orchestrator: ${rejected.reason}`
      );
      
      // Apply reputation penalty
      try {
        const { getReputationStore } = require('../../packages/task-exchange/src/reputation/store');
        const repStore = getReputationStore();
        await repStore.recordFailure(rejected.agentId, '1.0.0');
      } catch (e) {
        console.warn('[MasterOrchestrator] Could not apply reputation penalty:', e.message);
      }
    }
  }
};

module.exports = masterOrchestrator;
