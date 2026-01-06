/**
 * UndoManager - Manages undo/redo history for audio editing operations
 * 
 * Features:
 * - Full history stack with configurable depth
 * - State snapshots with descriptions
 * - Undo/Redo navigation
 * - Memory-efficient state management
 */

export class UndoManager {
  constructor(options = {}) {
    this.maxHistory = options.maxHistory || 50;
    this.undoStack = [];
    this.redoStack = [];
    
    // Optional callback when state changes
    this.onStateChange = options.onStateChange || null;
    
    console.log('[UndoManager] Initialized with maxHistory:', this.maxHistory);
  }
  
  /**
   * Push a new state to the undo stack
   * @param {object} state - The state to save (will be deep-cloned)
   * @param {string} description - Human-readable description of the action
   */
  pushState(state, description = 'Edit') {
    // Deep clone the state to avoid reference issues
    const snapshot = {
      state: JSON.parse(JSON.stringify(state)),
      description,
      timestamp: Date.now()
    };
    
    this.undoStack.push(snapshot);
    
    // Clear redo stack when new action is performed
    this.redoStack = [];
    
    // Limit history size
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift(); // Remove oldest
    }
    
    console.log(`[UndoManager] Pushed state: "${description}" (stack: ${this.undoStack.length})`);
    
    this._notifyStateChange();
  }
  
  /**
   * Undo the last action
   * @returns {object|null} The previous state, or null if nothing to undo
   */
  undo() {
    if (this.undoStack.length === 0) {
      console.log('[UndoManager] Nothing to undo');
      return null;
    }
    
    // Pop current state and move to redo stack
    const current = this.undoStack.pop();
    this.redoStack.push(current);
    
    // Get the previous state (or null if we've undone everything)
    const previousState = this.undoStack[this.undoStack.length - 1]?.state || null;
    
    console.log(`[UndoManager] Undo: "${current.description}" (undo: ${this.undoStack.length}, redo: ${this.redoStack.length})`);
    
    this._notifyStateChange();
    
    return previousState;
  }
  
  /**
   * Redo the last undone action
   * @returns {object|null} The redone state, or null if nothing to redo
   */
  redo() {
    if (this.redoStack.length === 0) {
      console.log('[UndoManager] Nothing to redo');
      return null;
    }
    
    const state = this.redoStack.pop();
    this.undoStack.push(state);
    
    console.log(`[UndoManager] Redo: "${state.description}" (undo: ${this.undoStack.length}, redo: ${this.redoStack.length})`);
    
    this._notifyStateChange();
    
    return state.state;
  }
  
  /**
   * Check if undo is available
   */
  canUndo() {
    return this.undoStack.length > 0;
  }
  
  /**
   * Check if redo is available
   */
  canRedo() {
    return this.redoStack.length > 0;
  }
  
  /**
   * Get the description of the next undo action
   */
  getUndoDescription() {
    if (this.undoStack.length === 0) return null;
    return this.undoStack[this.undoStack.length - 1].description;
  }
  
  /**
   * Get the description of the next redo action
   */
  getRedoDescription() {
    if (this.redoStack.length === 0) return null;
    return this.redoStack[this.redoStack.length - 1].description;
  }
  
  /**
   * Get the current stack sizes
   */
  getStackInfo() {
    return {
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      nextUndo: this.getUndoDescription(),
      nextRedo: this.getRedoDescription()
    };
  }
  
  /**
   * Clear all history
   */
  clear() {
    this.undoStack = [];
    this.redoStack = [];
    console.log('[UndoManager] History cleared');
    this._notifyStateChange();
  }
  
  /**
   * Get the full undo history (for debugging/display)
   */
  getHistory() {
    return this.undoStack.map((s, i) => ({
      index: i,
      description: s.description,
      timestamp: s.timestamp
    }));
  }
  
  /**
   * Notify listeners of state change
   */
  _notifyStateChange() {
    if (this.onStateChange) {
      this.onStateChange(this.getStackInfo());
    }
  }
  
  /**
   * Dispose of resources
   */
  dispose() {
    this.undoStack = [];
    this.redoStack = [];
    this.onStateChange = null;
    console.log('[UndoManager] Disposed');
  }
}






