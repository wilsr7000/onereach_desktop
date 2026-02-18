/**
 * Response Memory
 *
 * Tracks the last response for repeat functionality and
 * undoable actions with 60-second expiry window.
 */

const { getLogQueue } = require('../../../lib/log-event-queue');
const log = getLogQueue();
const responseMemory = {
  // Last response message spoken to user (for repeat)
  lastResponse: null,

  // Last undoable action
  // { description, undoFn, expiresAt }
  lastAction: null,

  /**
   * Store the last response for repeat functionality
   * @param {string} text - The response text
   */
  setLastResponse(text) {
    if (text && typeof text === 'string' && text.trim()) {
      this.lastResponse = text;
      log.info('voice', '[ResponseMemory] Stored response', { textPreview: text.substring(0, 50) });
    }
  },

  /**
   * Get the last response
   * @returns {string|null}
   */
  getLastResponse() {
    return this.lastResponse;
  },

  /**
   * Store an undoable action
   * @param {string} description - Human-readable description of what undo does
   * @param {Function} undoFn - Async function to reverse the action
   * @param {number} expiryMs - How long undo is valid (default 60s)
   */
  setUndoableAction(description, undoFn, expiryMs = 60000) {
    if (!undoFn || typeof undoFn !== 'function') {
      log.warn('voice', '[ResponseMemory] setUndoableAction called without valid undoFn');
      return;
    }

    if (!description || typeof description !== 'string') {
      log.warn('voice', '[ResponseMemory] setUndoableAction called without description');
      return;
    }

    this.lastAction = {
      description,
      undoFn,
      expiresAt: Date.now() + expiryMs,
      createdAt: Date.now(),
    };

    log.info('voice', '[ResponseMemory] Stored undoable action', { description, expirySeconds: expiryMs / 1000 });
  },

  /**
   * Check if undo is available
   * @returns {boolean}
   */
  canUndo() {
    if (!this.lastAction) return false;
    if (Date.now() >= this.lastAction.expiresAt) {
      log.info('voice', '[ResponseMemory] Undo expired');
      this.lastAction = null;
      return false;
    }
    return true;
  },

  /**
   * Get time remaining for undo (in seconds)
   * @returns {number} - Seconds remaining, or 0 if no undo available
   */
  getUndoTimeRemaining() {
    if (!this.canUndo()) return 0;
    return Math.max(0, Math.round((this.lastAction.expiresAt - Date.now()) / 1000));
  },

  /**
   * Execute undo if available
   * @returns {Object} - { success, message, description }
   */
  async undo() {
    if (!this.canUndo()) {
      return {
        success: false,
        message: 'Nothing to undo',
      };
    }

    const { description, undoFn } = this.lastAction;

    try {
      log.info('voice', '[ResponseMemory] Executing undo', { data: description });
      await undoFn();

      // Clear after successful undo
      this.lastAction = null;

      return {
        success: true,
        message: `Undone: ${description}`,
        description,
      };
    } catch (error) {
      log.error('voice', '[ResponseMemory] Undo failed', { error: error });
      return {
        success: false,
        message: "Couldn't undo that",
        error: error.message,
      };
    }
  },

  /**
   * Get undo info without executing
   * @returns {Object|null} - { description, timeRemaining } or null
   */
  getUndoInfo() {
    if (!this.canUndo()) return null;
    return {
      description: this.lastAction.description,
      timeRemaining: this.getUndoTimeRemaining(),
    };
  },

  /**
   * Clear all memory
   */
  clear() {
    this.lastResponse = null;
    this.lastAction = null;
    log.info('voice', '[ResponseMemory] Cleared');
  },

  /**
   * Clear just the undo action
   */
  clearUndo() {
    this.lastAction = null;
  },
};

module.exports = responseMemory;
