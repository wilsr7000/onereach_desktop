/**
 * Response Memory
 * 
 * Tracks the last response for repeat functionality and
 * undoable actions with 60-second expiry window.
 */

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
      console.log('[ResponseMemory] Stored response:', text.substring(0, 50) + (text.length > 50 ? '...' : ''));
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
      console.warn('[ResponseMemory] setUndoableAction called without valid undoFn');
      return;
    }
    
    if (!description || typeof description !== 'string') {
      console.warn('[ResponseMemory] setUndoableAction called without description');
      return;
    }
    
    this.lastAction = {
      description,
      undoFn,
      expiresAt: Date.now() + expiryMs,
      createdAt: Date.now()
    };
    
    console.log('[ResponseMemory] Stored undoable action:', description, `(expires in ${expiryMs/1000}s)`);
  },
  
  /**
   * Check if undo is available
   * @returns {boolean}
   */
  canUndo() {
    if (!this.lastAction) return false;
    if (Date.now() >= this.lastAction.expiresAt) {
      console.log('[ResponseMemory] Undo expired');
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
        message: "Nothing to undo" 
      };
    }
    
    const { description, undoFn } = this.lastAction;
    
    try {
      console.log('[ResponseMemory] Executing undo:', description);
      await undoFn();
      
      // Clear after successful undo
      this.lastAction = null;
      
      return {
        success: true,
        message: `Undone: ${description}`,
        description
      };
    } catch (error) {
      console.error('[ResponseMemory] Undo failed:', error);
      return {
        success: false,
        message: "Couldn't undo that",
        error: error.message
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
      timeRemaining: this.getUndoTimeRemaining()
    };
  },
  
  /**
   * Clear all memory
   */
  clear() {
    this.lastResponse = null;
    this.lastAction = null;
    console.log('[ResponseMemory] Cleared');
  },
  
  /**
   * Clear just the undo action
   */
  clearUndo() {
    this.lastAction = null;
  }
};

module.exports = responseMemory;
