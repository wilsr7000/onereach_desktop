/**
 * Error Agent - System Agent for Graceful Failure Handling
 *
 * This agent does NOT participate in auctions. It is invoked directly by the
 * exchange when tasks fail all execution attempts, time out, or hit dead-letter.
 *
 * Its job is to produce a clear, helpful, user-facing message explaining what
 * happened and suggesting alternatives.
 *
 * For non-system (user-created) agents, it additionally runs AI-powered
 * diagnosis via ai-service.diagnoseAgentFailure() and offers to fix the agent
 * through the Agent Composer.
 *
 * bidExcluded: true -- this agent is never shown to the unified bidder.
 * See .cursorrules "Classification Approach" -- no keyword/regex classification.
 */

const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

/**
 * Check whether a given agent ID belongs to a built-in (system) agent.
 * User-created agents are loaded from spaces, not the registry.
 */
function _isBuiltInAgent(agentId) {
  if (!agentId) return false;
  try {
    const { isRegistered } = require('./agent-registry');
    return isRegistered(agentId);
  } catch {
    return false;
  }
}

/**
 * Run AI-powered diagnosis on a failed non-system agent.
 * Returns { diagnosis, fix } or null if diagnosis is unavailable.
 */
async function _diagnoseNonSystemAgent(task) {
  try {
    const ai = require('../../lib/ai-service');
    const agentId = task.assignedAgent || task.metadata?.lastAgentId;
    const reason = task.metadata?.errorReason || task.error || 'Unknown error';

    const agentStub = {
      id: agentId,
      name: task.metadata?.agentName || agentId,
      executionType: task.metadata?.agentExecutionType || 'action',
      prompt: task.metadata?.agentPrompt || '',
    };

    const failureResult = {
      method: 'exchange-execution',
      details: reason,
      error: true,
    };

    log.info('agent', `Running AI diagnosis for non-system agent: ${agentId}`);

    const diagnosis = await ai.diagnoseAgentFailure(
      agentStub,
      task.content || '',
      failureResult,
      { feature: 'error-agent-diagnosis' }
    );

    if (!diagnosis || !diagnosis.rootCause) {
      log.warn('agent', 'AI diagnosis returned empty result');
      return null;
    }

    let fix = null;
    if (diagnosis.confidence >= 0.4) {
      try {
        fix = await ai.generateAgentFix(
          agentStub,
          task.content || '',
          diagnosis,
          { feature: 'error-agent-fix' }
        );
      } catch (fixErr) {
        log.warn('agent', 'AI fix generation failed', { data: fixErr.message });
      }
    }

    return { diagnosis, fix };
  } catch (err) {
    log.warn('agent', 'AI diagnosis failed', { data: err.message });
    return null;
  }
}

const errorAgent = {
  id: 'error-agent',
  name: 'Error Handler',
  description:
    'System agent that provides graceful error messages when tasks fail, time out, or exhaust all retries. Not user-facing in normal operation.',
  voice: 'sage',
  categories: ['system', 'error'],
  keywords: [],
  executionType: 'system',
  bidExcluded: true,

  /**
   * Execute error handling for a failed task.
   * Called directly by exchange-bridge when task:route_to_error_agent fires.
   *
   * @param {Object} task - The failed task
   * @returns {Object} Result with user-facing error message
   */
  async execute(task) {
    const reason = task.metadata?.errorReason || task.error || 'Unknown error';
    const originalContent = task.content || 'your request';
    const failedAgentId = task.assignedAgent || task.metadata?.lastAgentId || null;

    log.info('agent', `Handling failed task: "${originalContent.slice(0, 60)}" reason: ${reason}`);

    // For non-system agents, attempt AI diagnosis
    if (failedAgentId && !_isBuiltInAgent(failedAgentId)) {
      const diagnosticResult = await _diagnoseNonSystemAgent(task);

      if (diagnosticResult) {
        const { diagnosis, fix } = diagnosticResult;
        const canFix = fix?.canFix === true;

        const summary = diagnosis.summary || diagnosis.rootCause || reason;
        const fixHint = canFix
          ? `I have a suggested fix: ${fix.description || 'an adjustment to the agent'}.`
          : '';

        const message = `The agent "${task.metadata?.agentName || failedAgentId}" ran into a problem: ${summary}. ${fixHint}`.trim();

        return {
          success: true,
          output: message,
          data: {
            errorAgent: true,
            originalTask: originalContent.slice(0, 200),
            failureReason: reason,
            diagnosticAvailable: true,
            failedAgentId,
            diagnosis: {
              summary: diagnosis.summary,
              rootCause: diagnosis.rootCause,
              category: diagnosis.category,
              confidence: diagnosis.confidence,
              suggestedFix: diagnosis.suggestedFix,
            },
            fix: canFix ? {
              canFix: true,
              description: fix.description,
              fixType: fix.fixType,
              reason: fix.reason,
            } : null,
          },
        };
      }
    }

    // Fallback: built-in agents or when diagnosis is unavailable
    let message;

    if (reason.includes('timeout') || reason.includes('timed out')) {
      message = `I wasn't able to complete that in time. You could try asking again, or break it into a simpler request.`;
    } else if (reason.includes('No bids') || reason.includes('no viable bids')) {
      message = `I'm not sure how to handle that one. Could you rephrase it, or ask me "what can you do" to see what I'm good at?`;
    } else if (reason.includes('All agents') || reason.includes('exhausted')) {
      message = `I tried a few different approaches but couldn't get that done. Try rephrasing or breaking it into smaller steps.`;
    } else if (reason.includes('not available') || reason.includes('disconnected')) {
      message = `The service I needed isn't available right now. Give it a moment and try again.`;
    } else {
      message = `Something went wrong with that request. You could try again or rephrase it differently.`;
    }

    return {
      success: true,
      output: message,
      data: {
        errorAgent: true,
        originalTask: originalContent.slice(0, 200),
        failureReason: reason,
        diagnosticAvailable: false,
      },
    };
  },
};

module.exports = errorAgent;
