/**
 * Conversation State Manager
 *
 * Manages conversational context for the voice assistant:
 * - Pending questions (agent needs more info)
 * - Pending confirmations (dangerous actions)
 * - Recent context (for pronoun resolution)
 */

const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();
const conversationState = {
  // Pending question from agent needing user input
  // { prompt, field, agentId, taskId, resolve, timeoutId }
  pendingQuestion: null,

  // Pending confirmation for dangerous action
  // { action, dangerous, resolve, timeoutId }
  pendingConfirmation: null,

  // Recent conversation items for context (last 3)
  // [{ subject, response, timestamp }]
  recentContext: [],

  /**
   * Set a pending question that needs user input
   * @param {Object} options - { prompt, field, agentId, taskId }
   * @param {Function} resolve - Called with { answer, agentId, taskId, field } or { timedOut: true }
   * @param {number} timeoutMs - Timeout in milliseconds (default 15s)
   */
  setPendingQuestion(options, resolve, timeoutMs = 15000) {
    this.clearPendingQuestion();

    const timeoutId = setTimeout(() => {
      log.info('voice', '[ConversationState] Pending question timed out');
      this.pendingQuestion = null;
      resolve({ timedOut: true });
    }, timeoutMs);

    this.pendingQuestion = {
      ...options,
      resolve,
      timeoutId,
      createdAt: Date.now(),
    };

    log.info('voice', '[ConversationState] Set pending question', { data: options.prompt });
  },

  /**
   * Resolve a pending question with the user's answer
   * @param {string} answer - The user's response
   * @returns {Object|null} - Routing info { agentId, taskId, field } or null
   */
  resolvePendingQuestion(answer) {
    if (!this.pendingQuestion) return null;

    const { resolve, timeoutId, agentId, taskId, field } = this.pendingQuestion;
    clearTimeout(timeoutId);
    this.pendingQuestion = null;

    log.info('voice', '[ConversationState] Resolved pending question with answer');

    // Return routing info so answer goes back to correct agent
    resolve({ answer, agentId, taskId, field });
    return { agentId, taskId, field };
  },

  /**
   * Clear any pending question
   */
  clearPendingQuestion() {
    if (this.pendingQuestion?.timeoutId) {
      clearTimeout(this.pendingQuestion.timeoutId);
    }
    this.pendingQuestion = null;
  },

  /**
   * Set a pending confirmation request
   * @param {string} action - Description of action needing confirmation
   * @param {Function} resolve - Called with { confirmed: boolean, timedOut?: boolean }
   * @param {boolean} dangerous - Whether this is a dangerous action
   * @param {number} timeoutMs - Timeout in milliseconds (default 10s)
   */
  setPendingConfirmation(action, resolve, dangerous = false, timeoutMs = 10000) {
    this.clearPendingConfirmation();

    const timeoutId = setTimeout(() => {
      log.info('voice', '[ConversationState] Pending confirmation timed out');
      this.pendingConfirmation = null;
      resolve({ confirmed: false, timedOut: true });
    }, timeoutMs);

    this.pendingConfirmation = {
      action,
      dangerous,
      resolve,
      timeoutId,
      createdAt: Date.now(),
    };

    log.info('voice', '[ConversationState] Set pending confirmation', { action, dangerous });
  },

  /**
   * Resolve a pending confirmation
   * @param {boolean} confirmed - Whether user confirmed
   * @returns {Object|null} - The action info or null
   */
  resolvePendingConfirmation(confirmed) {
    if (!this.pendingConfirmation) return null;

    const { resolve, timeoutId, action, dangerous } = this.pendingConfirmation;
    clearTimeout(timeoutId);
    this.pendingConfirmation = null;

    log.info('voice', '[ConversationState] Resolved confirmation', { data: confirmed ? 'YES' : 'NO' });

    resolve({ confirmed });
    return { action, dangerous, confirmed };
  },

  /**
   * Clear any pending confirmation
   */
  clearPendingConfirmation() {
    if (this.pendingConfirmation?.timeoutId) {
      clearTimeout(this.pendingConfirmation.timeoutId);
    }
    this.pendingConfirmation = null;
  },

  /**
   * Add an item to recent context for pronoun resolution
   * @param {Object} item - { subject, response, timestamp }
   */
  addContext(item) {
    this.recentContext.unshift({
      ...item,
      timestamp: item.timestamp || Date.now(),
    });

    // Keep only last 3 items
    if (this.recentContext.length > 3) {
      this.recentContext.pop();
    }

    log.info('voice', '[ConversationState] Added context, now have', {
      arg0: this.recentContext.length,
      arg1: 'items',
    });
  },

  /**
   * Get the most recent context item
   * @returns {Object|null}
   */
  getRecentSubject() {
    return this.recentContext[0] || null;
  },

  /**
   * Clear all pending state (on cancel)
   */
  clear() {
    this.clearPendingQuestion();
    this.clearPendingConfirmation();
    // Keep recentContext for potential follow-ups after cancel
    log.info('voice', '[ConversationState] Cleared pending state');
  },

  /**
   * Clear everything including context
   */
  clearAll() {
    this.clear();
    this.recentContext = [];
    log.info('voice', '[ConversationState] Cleared all state');
  },

  /**
   * Get routing context for the Router
   * @returns {Object}
   */
  getRoutingContext() {
    return {
      hasPendingQuestion: !!this.pendingQuestion,
      hasPendingConfirmation: !!this.pendingConfirmation,
      pendingAgentId: this.pendingQuestion?.agentId,
      pendingField: this.pendingQuestion?.field,
      lastSubject: this.recentContext[0]?.subject,
      contextCount: this.recentContext.length,
    };
  },

  /**
   * Check if we're in any pending state
   * @returns {boolean}
   */
  hasPendingState() {
    return !!(this.pendingQuestion || this.pendingConfirmation);
  },
};

module.exports = conversationState;
