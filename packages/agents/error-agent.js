/**
 * Error Agent - System Agent for Graceful Failure Handling
 * 
 * This agent does NOT participate in auctions. It is invoked directly by the
 * exchange when tasks fail all execution attempts, time out, or hit dead-letter.
 * 
 * Its job is to produce a clear, helpful, user-facing message explaining what
 * happened and suggesting alternatives.
 * 
 * bidExcluded: true -- this agent is never shown to the unified bidder.
 * See .cursorrules "Classification Approach" -- no keyword/regex classification.
 */

const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

const errorAgent = {
  id: 'error-agent',
  name: 'Error Handler',
  description: 'System agent that provides graceful error messages when tasks fail, time out, or exhaust all retries. Not user-facing in normal operation.',
  voice: 'sage',  // Calm, reassuring -- see VOICE-GUIDE.md
  categories: ['system', 'error'],
  keywords: [],
  executionType: 'system',
  bidExcluded: true,  // Never participates in auctions

  // No bid() method. Routing is 100% LLM-based via unified-bidder.js. NEVER add keyword/regex bidding here. See .cursorrules.

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

    log.info('agent', `Handling failed task: "${originalContent.slice(0, 60)}" reason: ${reason}`);

    // Build a user-friendly message based on the failure reason
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
      success: true,  // The error agent itself succeeded
      output: message,
      data: {
        errorAgent: true,
        originalTask: originalContent.slice(0, 200),
        failureReason: reason,
      },
    };
  },
};

module.exports = errorAgent;
